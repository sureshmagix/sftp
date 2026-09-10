const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { TransferManager } = require('../dist/core/TransferManager');

test('large folder consistency: recursive traversal creates remote dirs, preserves batchId and empty dirs', async () => {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-transfer-test-'));
  const subA = path.join(testDir, 'subA');
  const subB = path.join(subA, 'subB');
  const emptyDir = path.join(testDir, 'emptyFolder');

  await fs.promises.mkdir(subB, { recursive: true });
  await fs.promises.mkdir(emptyDir, { recursive: true });

  await fs.promises.writeFile(path.join(testDir, 'root-file.txt'), 'root file content');
  await fs.promises.writeFile(path.join(subA, 'a-file.txt'), 'a file content');
  await fs.promises.writeFile(path.join(subB, 'b-file.txt'), 'b file content');

  const createdRemoteDirs = [];
  const uploadedFiles = [];

  const mockSftp = {
    mkdir: async (dirPath) => {
      createdRemoteDirs.push(dirPath);
    },
    stat: async () => ({ size: 50 }),
    listDir: async () => [],
    exists: async (p) => createdRemoteDirs.includes(p),
    rename: async () => {},
    deleteFile: async () => {},
    downloadFile: async () => {},
    uploadFile: async (localPath, remotePath) => {
      uploadedFiles.push({ localPath, remotePath });
    },
  };

  const manager = new TransferManager(mockSftp, 2);
  const tasks = await manager.enqueueDirectoryUpload(testDir, '/remote/target', 'test_batch_123');

  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((t) => t.batchId === 'test_batch_123'));
  assert.ok(createdRemoteDirs.some((d) => d.includes('emptyFolder')));
  assert.ok(createdRemoteDirs.some((d) => d.includes('subB')));

  await manager.waitForIdle(3000);
  assert.equal(uploadedFiles.length, 3);
  assert.ok(uploadedFiles.some((f) => f.remotePath.includes('root-file.txt')));
  assert.ok(uploadedFiles.some((f) => f.remotePath.includes('b-file.txt')));

  await fs.promises.rm(testDir, { recursive: true, force: true });
});

test('transfer consistency: size mismatch verification triggers failure and cleans up partial files', async () => {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-size-test-'));
  const testFile = path.join(testDir, 'data.bin');
  await fs.promises.writeFile(testFile, '1234567890'); // 10 bytes

  const deletedRemote = [];
  const mockSftp = {
    mkdir: async () => {},
    stat: async () => ({ size: 5 }),
    listDir: async () => [],
    exists: async () => false,
    rename: async () => {},
    deleteFile: async (p) => deletedRemote.push(p),
    downloadFile: async () => {},
    uploadFile: async () => {
      throw new Error('Upload verification failed: expected 10 bytes, got 5 bytes');
    },
  };

  const manager = new TransferManager(mockSftp, 1);
  const task = manager.enqueue({
    localPath: testFile,
    remotePath: '/remote/corrupt.bin',
    direction: 'upload',
    maxRetries: 0,
  });

  await manager.waitForIdle(3000);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Upload verification failed/);
  assert.ok(deletedRemote.some((p) => p.includes('.sbpart-')));

  await fs.promises.rm(testDir, { recursive: true, force: true });
});

test('transient error retry: retries failed transfer before succeeding', async () => {
  const testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-retry-test-'));
  const testFile = path.join(testDir, 'retry.txt');
  await fs.promises.writeFile(testFile, 'retry test content');

  let attempts = 0;
  const mockSftp = {
    mkdir: async () => {},
    stat: async () => ({ size: 18 }),
    listDir: async () => [],
    exists: async () => false,
    rename: async () => {},
    deleteFile: async () => {},
    downloadFile: async () => {},
    uploadFile: async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('ECONNRESET: connection reset by peer');
      }
    },
  };

  const manager = new TransferManager(mockSftp, 1);
  const task = manager.enqueue({
    localPath: testFile,
    remotePath: '/remote/retry.txt',
    direction: 'upload',
    maxRetries: 2,
  });

  await manager.waitForIdle(4000);
  assert.equal(attempts, 2);
  assert.equal(task.retries, 1);
  assert.equal(task.status, 'completed');

  await fs.promises.rm(testDir, { recursive: true, force: true });
});
