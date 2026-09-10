const test = require('node:test');
const assert = require('node:assert/strict');
const { SshConnection } = require('../dist/core/SshConnection');

test('SshConnection: status begins at disconnected, connects and handles disconnect cleanly', async () => {
  const conn = new SshConnection();
  assert.equal(conn.getStatus(), 'disconnected');
  assert.equal(conn.isConnected(), false);

  await conn.disconnect();
  assert.equal(conn.getStatus(), 'disconnected');
});

test('SshConnection: handles connection errors gracefully and emits error event', async () => {
  const conn = new SshConnection();
  let errorEmitted = false;
  conn.on('error', () => {
    errorEmitted = true;
  });

  await assert.rejects(
    async () => {
      // Connect to non-existent host/port with quick timeout
      await conn.connect({
        host: '127.0.0.1',
        port: 1,
        username: 'nobody',
        readyTimeout: 500,
      });
    }
  );

  assert.equal(conn.getStatus(), 'error');
  assert.equal(conn.isConnected(), false);
  assert.equal(errorEmitted, true);
  await conn.disconnect();
});
