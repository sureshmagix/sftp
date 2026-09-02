const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { SftpWebServer } = require('../dist/ui/server');

async function reserveFreePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('authenticated application API smoke test', async () => {
  const server = new SftpWebServer(await reserveFreePort());
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-sftp-test-'));
  await server.start(false);
  const baseUrl = `http://127.0.0.1:${server.getPort()}`;

  try {
    const bootstrap = await fetch(server.getLaunchUrl(), { redirect: 'manual' });
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const headers = { cookie };
    const jsonHeaders = { cookie, 'content-type': 'application/json' };

    assert.equal((await fetch(`${baseUrl}/`, { headers })).status, 200);
    assert.equal((await fetch(`${baseUrl}/app.js`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/style.css`)).status, 200);

    const status = await (await fetch(`${baseUrl}/api/status`, { headers })).json();
    assert.equal(status.status, 'disconnected');

    const home = await (await fetch(`${baseUrl}/api/local-home`, { headers })).json();
    assert.equal(typeof home.path, 'string');
    const places = await (await fetch(`${baseUrl}/api/local-places`, { headers })).json();
    assert.ok(Array.isArray(places.places));

    const repositoryListing = await (
      await fetch(`${baseUrl}/api/list-local?path=${encodeURIComponent(path.join(__dirname, '..'))}`, { headers })
    ).json();
    assert.ok(repositoryListing.files.some((item) => item.name === 'package.json'));

    const preview = await (
      await fetch(`${baseUrl}/api/read-file-local?path=${encodeURIComponent(path.join(__dirname, '..', 'README.md'))}`, { headers })
    ).json();
    assert.equal(preview.isText, true);
    assert.match(preview.content, /SB SFTP Studio/);

    const createdDir = path.join(testRoot, 'created-by-api');
    let response = await fetch(`${baseUrl}/api/mkdir-local`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ localPath: createdDir }),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(createdDir), true);

    const createdFile = path.join(createdDir, 'delete-me.txt');
    await fs.promises.writeFile(createdFile, 'temporary test data');
    response = await fetch(`${baseUrl}/api/delete-local`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ localPath: createdFile, isDirectory: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(createdFile), false);

    response = await fetch(`${baseUrl}/api/delete-local`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ localPath: createdDir, isDirectory: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(createdDir), false);

    response = await fetch(`${baseUrl}/api/server-port`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ newPort: 80 }),
    });
    assert.equal(response.status, 400);

    response = await fetch(`${baseUrl}/api/list-remote?path=/`, { headers });
    assert.equal(response.status, 500);
    response = await fetch(`${baseUrl}/api/exec`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ command: 'pwd' }),
    });
    assert.equal(response.status, 500);

    response = await fetch(`${baseUrl}/api/cancel-transfer`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ taskId: 'missing-task' }),
    });
    assert.equal(response.status, 404);

    response = await fetch(`${baseUrl}/api/connect`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ host: '127.0.0.1', port: 1, username: 'invalid', password: 'invalid' }),
    });
    assert.equal(response.status, 400);
    await fetch(`${baseUrl}/api/disconnect`, { method: 'POST', headers });

    const transfers = await (await fetch(`${baseUrl}/api/transfers`, { headers })).json();
    assert.ok(Array.isArray(transfers));
  } finally {
    await server.stop();
    await fs.promises.rm(testRoot, { recursive: true, force: true });
  }
});
