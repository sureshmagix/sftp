const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const WebSocket = require('ws');
const { SftpWebServer } = require('../dist/ui/server');

async function reserveFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test('server requires a secure session and keeps the old listener when a port switch fails', async () => {
  const initialPort = await reserveFreePort();
  const server = new SftpWebServer(initialPort);
  await server.start(false);
  const baseUrl = `http://127.0.0.1:${server.getPort()}`;

  let authenticatedSocket;
  let occupiedServer;
  try {
    assert.equal((await fetch(`${baseUrl}/`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);

    const bootstrap = await fetch(server.getLaunchUrl(), { redirect: 'manual' });
    assert.equal(bootstrap.status, 302);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];

    const index = await fetch(`${baseUrl}/`, { headers: { cookie } });
    assert.equal(index.status, 200);
    assert.match(await index.text(), /SB SFTP Studio/);

    const infoResponse = await fetch(`${baseUrl}/api/server-info`, { headers: { cookie } });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json();
    assert.equal(info.bindHost, '127.0.0.1');
    assert.equal(info.lanAccessEnabled, false);

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.getPort()}/ws`);
      socket.once('unexpected-response', (_request, response) => {
        assert.equal(response.statusCode, 401);
        resolve();
      });
      socket.once('open', () => reject(new Error('Unauthenticated WebSocket unexpectedly opened')));
      socket.once('error', () => {});
    });

    authenticatedSocket = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.getPort()}/ws`, { headers: { cookie } });
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });

    occupiedServer = http.createServer((_req, res) => res.end('occupied'));
    await new Promise((resolve, reject) => occupiedServer.listen(0, '127.0.0.1', resolve).once('error', reject));
    const occupiedPort = occupiedServer.address().port;

    const switchResponse = await fetch(`${baseUrl}/api/server-port`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ newPort: occupiedPort }),
    });
    assert.equal(switchResponse.status, 409);

    const stillHealthy = await fetch(`${baseUrl}/api/status`, { headers: { cookie } });
    assert.equal(stillHealthy.status, 200);
  } finally {
    authenticatedSocket?.close();
    if (occupiedServer) await new Promise((resolve) => occupiedServer.close(resolve));
    await server.stop();
  }
});
