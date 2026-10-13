const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalFsService } = require('../dist/core/LocalFsService');
const { SftpClientService } = require('../dist/core/SftpClientService');

test('LocalFsService: deletes files and nested directories properly even if type is unknown', async () => {
  const localFs = new LocalFsService();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-delete-test-'));

  try {
    // 1. Test single file deletion
    const testFile = path.join(tempDir, 'sample.txt');
    await fs.promises.writeFile(testFile, 'hello');
    assert.equal(fs.existsSync(testFile), true);
    await localFs.deleteFile(testFile);
    assert.equal(fs.existsSync(testFile), false);

    // 2. Test directory deletion using deleteFile (fallback handling)
    const testSubDir = path.join(tempDir, 'subfolder');
    await fs.promises.mkdir(testSubDir, { recursive: true });
    await fs.promises.writeFile(path.join(testSubDir, 'nested.txt'), 'nested content');
    assert.equal(fs.existsSync(testSubDir), true);
    await localFs.deleteFile(testSubDir);
    assert.equal(fs.existsSync(testSubDir), false);

    // 3. Test deleteItem on file and directory
    const testItemFile = path.join(tempDir, 'item.txt');
    await fs.promises.writeFile(testItemFile, 'item content');
    await localFs.deleteItem(testItemFile);
    assert.equal(fs.existsSync(testItemFile), false);

    const testItemDir = path.join(tempDir, 'itemDir');
    await fs.promises.mkdir(testItemDir, { recursive: true });
    await fs.promises.writeFile(path.join(testItemDir, 'child.txt'), 'child');
    await localFs.deleteItem(testItemDir);
    assert.equal(fs.existsSync(testItemDir), false);

    // 4. Test batch of mixed files and directories
    const batchDir1 = path.join(tempDir, 'batchDir1');
    const batchFile1 = path.join(tempDir, 'batchFile1.txt');
    const batchDir2 = path.join(tempDir, 'batchDir2');
    await fs.promises.mkdir(batchDir1, { recursive: true });
    await fs.promises.writeFile(path.join(batchDir1, 'a.txt'), 'a');
    await fs.promises.writeFile(batchFile1, 'b');
    await fs.promises.mkdir(batchDir2, { recursive: true });

    const batchItems = [
      { localPath: batchDir1, isDirectory: true },
      { localPath: batchFile1, isDirectory: false },
      { localPath: batchDir2, isDirectory: undefined }, // unknown type
    ];

    for (const item of batchItems) {
      if (item.isDirectory === true) {
        await localFs.rmdir(item.localPath, true);
      } else {
        await localFs.deleteItem(item.localPath);
      }
    }

    assert.equal(fs.existsSync(batchDir1), false);
    assert.equal(fs.existsSync(batchFile1), false);
    assert.equal(fs.existsSync(batchDir2), false);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('UI and Package: version 1.3.0 and transfer telemetry elements are visible in HTML and scripts', async () => {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.3.0');

  const html = await fs.promises.readFile(path.join(__dirname, '..', 'src', 'ui', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('v1.3.0'));
  assert.ok(html.includes('transferPopoutModal'));
  assert.ok(html.includes('btnPopoutCancel'));
  assert.ok(html.includes('btnHudCancel'));
  assert.ok(html.includes('app-version-badge'));

  // Dual progress bars: current file and total percentage
  assert.ok(html.includes('popoutProgressFill'), 'Current file progress bar track');
  assert.ok(html.includes('popoutTotalProgressFill'), 'Total percentage progress bar track');
  assert.ok(html.includes('popoutTotalPctLarge'), 'Total percentage label');
  assert.ok(html.includes('popoutTotalTimeRemaining'), 'Overall time remaining display');

  // File and folder transfer size telemetry
  assert.ok(html.includes('popoutTotalSizeStat'), 'Total size display');
  assert.ok(html.includes('popoutRemainingSizeStat'), 'Remaining size display');
  assert.ok(html.includes('popoutTransferredStat'), 'Transferred size display');

  // Network disconnection alert and continuation option
  assert.ok(html.includes('popoutNetworkAlert'), 'Network alert container');
  assert.ok(html.includes('btnPopoutResume'), 'Continue / resume transfer button');

  // Check app.js includes handler implementations
  const appJs = await fs.promises.readFile(path.join(__dirname, '..', 'src', 'ui', 'public', 'app.js'), 'utf8');
  assert.ok(appJs.includes('continueTransfers'), 'continueTransfers function implemented');
  assert.ok(appJs.includes('handleNetworkStatusChange'), 'handleNetworkStatusChange function implemented');
  assert.ok(appJs.includes('formatDuration'), 'formatDuration function implemented');
  assert.ok(appJs.includes('retry-failed-transfers'), 'API retry call referenced');
});

test('TransferManager: retryTask and retryFailed re-enqueues interrupted/failed transfers', async () => {
  const { TransferManager } = require('../dist/core/TransferManager');
  const dummySftp = {
    exists: async () => false,
    stat: async () => ({ size: 100 }),
    deleteFile: async () => {},
    rename: async () => {},
    uploadFile: async () => { throw new Error('Network socket disconnected'); },
    downloadFile: async () => {},
  };

  const manager = new TransferManager(dummySftp, 1);
  const task = manager.enqueue({
    localPath: '/dummy/file.txt',
    remotePath: '/remote/file.txt',
    direction: 'upload',
    totalBytes: 500,
    maxRetries: 0, // Fail immediately
  });

  // Wait for task to fail and transition to completedTasks
  await new Promise((resolve) => {
    manager.once('task-failed', () => resolve());
  });

  assert.equal(task.status, 'failed');
  assert.equal(manager.getTasks().find(t => t.id === task.id)?.status, 'failed');

  // Test retryTask
  const retried = manager.retryTask(task.id);
  assert.equal(retried, true);
  assert.ok(['queued', 'transferring'].includes(task.status));

  // Cancel it to put it back into completedTasks as cancelled
  manager.cancelTask(task.id);
  await new Promise((resolve) => manager.once('task-cancelled', resolve));
  assert.equal(task.status, 'cancelled');

  // Test retryFailed
  const count = manager.retryFailed();
  assert.equal(count, 1);
  assert.ok(['queued', 'transferring'].includes(task.status));
  manager.cancelAll();
});
