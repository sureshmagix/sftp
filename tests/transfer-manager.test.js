const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { TransferManager } = require('../dist/core/TransferManager');

const sourceFile = path.join(__dirname, '..', 'package.json');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('active cancellation aborts I/O, preserves concurrency, cleans partial data, and records once', async () => {
  let activeOperations = 0;
  let maxActiveOperations = 0;
  const deletedRemotePaths = [];

  const mockSftp = {
    mkdir: async () => {},
    stat: async () => ({ size: 100 }),
    listDir: async () => [],
    exists: async () => false,
    rename: async () => {},
    deleteFile: async (remotePath) => deletedRemotePaths.push(remotePath),
    downloadFile: async () => {},
    uploadFile: async (_localPath, _remotePath, onProgress, signal) => {
      activeOperations++;
      maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
      onProgress?.(10, 100);

      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 180);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        onProgress?.(100, 100);
      } finally {
        activeOperations--;
      }
    },
  };

  const manager = new TransferManager(mockSftp, 1);
  const first = manager.enqueue({ localPath: sourceFile, remotePath: '/first.json', direction: 'upload' });
  const second = manager.enqueue({ localPath: sourceFile, remotePath: '/second.json', direction: 'upload' });

  await delay(30);
  assert.equal(manager.cancelTask(first.id), 'cancellation-requested');
  await manager.waitForIdle(3000);

  const tasks = manager.getTasks();
  assert.equal(maxActiveOperations, 1);
  assert.equal(tasks.filter((task) => task.id === first.id).length, 1);
  assert.equal(tasks.find((task) => task.id === first.id).status, 'cancelled');
  assert.equal(tasks.find((task) => task.id === second.id).status, 'completed');
  assert.ok(deletedRemotePaths.includes(`/first.json.sbpart-${first.id}`));
});

test('queued cancellation completes immediately and is not duplicated', async () => {
  const mockSftp = {
    mkdir: async () => {},
    stat: async () => ({ size: 1 }),
    listDir: async () => [],
    exists: async () => false,
    rename: async () => {},
    deleteFile: async () => {},
    downloadFile: async () => {},
    uploadFile: async (_localPath, _remotePath, _onProgress, signal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  };

  const manager = new TransferManager(mockSftp, 1);
  const active = manager.enqueue({ localPath: sourceFile, remotePath: '/active.json', direction: 'upload' });
  const queued = manager.enqueue({ localPath: sourceFile, remotePath: '/queued.json', direction: 'upload' });

  assert.equal(manager.cancelTask(queued.id), 'queued-cancelled');
  assert.equal(manager.cancelTask(queued.id), 'already-finished');
  manager.cancelTask(active.id);
  await manager.waitForIdle(3000);

  const tasks = manager.getTasks();
  assert.equal(tasks.filter((task) => task.id === queued.id).length, 1);
  assert.equal(tasks.find((task) => task.id === queued.id).status, 'cancelled');
});
