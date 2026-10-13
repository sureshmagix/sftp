import express, { Request, Response } from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { SftpAppController } from '../electron-bridge/ipcHandlers';
import { SshConnectConfig } from '../types';

function openBrowser(url: string): void {
  const startCmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(startCmd, () => {});
}

async function findAvailablePort(
  startPort: number = 3000,
  maxTries: number = 200,
  host: string = '127.0.0.1'
): Promise<number> {
  for (let p = startPort; p < startPort + maxTries; p++) {
    const isAvailable = await new Promise<boolean>((resolve) => {
      const tester = net
        .createServer()
        .once('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            resolve(false);
          } else {
            resolve(false);
          }
        })
        .once('listening', () => {
          tester.close(() => resolve(true));
        })
        .listen(p, host);
    });
    if (isAvailable) return p;
  }
  throw new Error(`No available port found between ${startPort} and ${startPort + maxTries - 1}`);
}

export class SftpWebServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;
  private controller = new SftpAppController();
  private port: number;
  private readonly sessionToken = randomBytes(32).toString('hex');
  private readonly allowLan = process.env.SFTP_ALLOW_LAN === 'true';
  private readonly bindHost: string;
  private started = false;

  constructor(port: number = 3000) {
    this.port = port;
    this.bindHost = this.allowLan ? process.env.SFTP_BIND_HOST || '0.0.0.0' : '127.0.0.1';
    this.server = http.createServer(this.app);
    this.wss = this.createWebSocketServer(this.server);
    this.controller.sshConnection.on('error', (err) => {
      console.warn(`[SftpWebServer] SSH connection notice: ${err?.message || err}`);
    });
    this.configureMiddleware();
    this.configureRoutes();
    this.configureWebSocket();
  }

  private createWebSocketServer(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: ({ req }, done) => {
        done(this.isRequestAuthenticated(req) && this.isTrustedOrigin(req));
      },
    });
    wss.on('error', (err) => {
      console.warn(`[SftpWebServer] WebSocket server notice: ${err.message}`);
    });
    return wss;
  }

  private configureMiddleware() {
    this.app.disable('x-powered-by');
    this.app.use((req, res, next) => {
      if (req.path === '/' || req.path === '/index.html' || req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; " +
          "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +
          "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self' ws: wss:"
      );
      next();
    });
    this.app.use(express.json({ limit: '1mb' }));

    this.app.use((req, res, next) => {
      const isIndexRequest = req.path === '/' || req.path === '/index.html';
      if (req.path === '/' && req.query.sessionToken === this.sessionToken) {
        res.setHeader(
          'Set-Cookie',
          `sb_sftp_session=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
        );
        return res.redirect(302, '/');
      }

      if (isIndexRequest && !this.isRequestAuthenticated(req)) {
        return res
          .status(401)
          .type('text/plain')
          .send('Unauthorized. Launch SB SFTP Studio from the desktop application or the secure URL printed by the server.');
      }

      if (req.path.startsWith('/api/')) {
        if (!this.isTrustedOrigin(req)) {
          return res.status(403).json({ success: false, error: 'Untrusted request origin' });
        }
        if (!this.isRequestAuthenticated(req)) {
          return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        const hasRequestBody = Number(req.headers['content-length'] || 0) > 0;
        if (
          req.method !== 'GET' &&
          req.path !== '/api/upload-stream' &&
          hasRequestBody &&
          !req.is('application/json')
        ) {
          return res.status(415).json({ success: false, error: 'JSON request body required' });
        }
      }

      next();
    });

    // Serve UI static files with fallback for packaged Electron apps
    let publicPath = path.join(__dirname, 'public');
    if (!fs.existsSync(publicPath)) {
      publicPath = path.join(__dirname, '..', '..', 'src', 'ui', 'public');
    }
    if (!fs.existsSync(publicPath)) {
      publicPath = path.join(process.cwd(), 'src', 'ui', 'public');
    }
    if (!fs.existsSync(publicPath) && (process as any).resourcesPath) {
      publicPath = path.join((process as any).resourcesPath, 'public');
    }
    this.app.use(express.static(publicPath));
  }

  private isRequestAuthenticated(req: Pick<Request, 'headers'> | http.IncomingMessage): boolean {
    const headerToken = req.headers['x-sb-sftp-token'];
    const tokenFromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    const cookies = this.parseCookies(req.headers.cookie || '');
    const suppliedToken = tokenFromHeader || cookies.sb_sftp_session;
    if (!suppliedToken) return false;

    const expected = Buffer.from(this.sessionToken);
    const supplied = Buffer.from(suppliedToken);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  private parseCookies(cookieHeader: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of cookieHeader.split(';')) {
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key) cookies[key] = value;
    }
    return cookies;
  }

  private isTrustedOrigin(req: Pick<Request, 'headers'> | http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private configureRoutes() {
    // Server & Network Information API (IPs, Hostname, Port)
    this.app.get('/api/server-info', (_req: Request, res: Response) => {
      const interfaces = os.networkInterfaces();
      const ipList: { name: string; address: string; family: string; internal: boolean }[] = [];

      for (const [name, netList] of Object.entries(interfaces)) {
        if (netList) {
          for (const net of netList) {
            if (net.family === 'IPv4' || (typeof net.family === 'number' && (net as any).family === 4)) {
              ipList.push({
                name,
                address: net.address,
                family: 'IPv4',
                internal: net.internal,
              });
            }
          }
        }
      }

      const visibleIps = this.allowLan ? ipList : ipList.filter((item) => item.internal);
      const primaryIp = this.allowLan
        ? ipList.find((i) => !i.internal)?.address || '127.0.0.1'
        : '127.0.0.1';

      res.json({
        version: '1.3.0',
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        currentPort: this.port,
        bindHost: this.bindHost,
        lanAccessEnabled: this.allowLan,
        primaryIp,
        ipAddresses: visibleIps,
      });
    });

    // Update Server Port from UI
    this.app.post('/api/server-port', async (req: Request, res: Response) => {
      const { newPort } = req.body;
      const portNum = parseInt(newPort, 10);

      if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
        return res.status(400).json({
          success: false,
          error: 'Port must be a valid number between 1024 and 65535',
        });
      }

      if (portNum === this.port) {
        return res.json({
          success: true,
          oldPort: this.port,
          newPort: this.port,
          message: `Server is already running on port ${this.port}`,
        });
      }

      const oldPort = this.port;
      try {
        await this.changePort(portNum);
        res.json({
          success: true,
          oldPort,
          newPort: portNum,
          redirectUrl: `http://127.0.0.1:${portNum}`,
        });
      } catch (err: any) {
        res.status(409).json({
          success: false,
          oldPort,
          newPort: portNum,
          error: `Unable to switch ports: ${err.message}`,
        });
      }
    });

    // SSH Connection Status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      res.json({ status: this.controller.sshConnection.getStatus() });
    });

    // SSH Connect
    this.app.post('/api/connect', async (req: Request, res: Response) => {
      const { host, port, username, password, privateKeyPath, passphrase, hostFingerprint } = req.body;
      const portNumber = port ? Number(port) : 22;
      if (typeof host !== 'string' || !host.trim() || host.length > 255) {
        return res.status(400).json({ success: false, error: 'A valid SSH host is required' });
      }
      if (typeof username !== 'string' || !username.trim() || username.length > 128) {
        return res.status(400).json({ success: false, error: 'A valid SSH username is required' });
      }
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        return res.status(400).json({ success: false, error: 'SSH port must be between 1 and 65535' });
      }
      if (hostFingerprint && !/^SHA256:[a-zA-Z0-9+/]{43}={0,2}$/.test(hostFingerprint.trim())) {
        return res.status(400).json({ success: false, error: 'Host fingerprint must use SHA256:base64 format' });
      }
      try {
        let privateKey: Buffer | undefined = undefined;
        if (privateKeyPath && fs.existsSync(privateKeyPath)) {
          privateKey = fs.readFileSync(privateKeyPath);
        }

        const config: SshConnectConfig = {
          host,
          port: portNumber,
          username,
          password: password || undefined,
          privateKey,
          passphrase: passphrase || undefined,
          hostFingerprint: hostFingerprint?.trim() || undefined,
        };

        await this.controller.sshConnection.connect(config);
        let remoteHome = '/';
        try {
          remoteHome = await this.controller.sftpService.realpath('.');
        } catch (_) {}
        res.json({ success: true, status: this.controller.sshConnection.getStatus(), remoteHome });
      } catch (err: any) {
        let rawError = (err.message || '').toString();
        let formattedError = rawError || 'Connection failed';
        let isAuthError = false;

        const lower = rawError.toLowerCase();
        if (
          lower.includes('all configured authentication methods failed') ||
          lower.includes('authentication failure') ||
          lower.includes('permission denied') ||
          lower.includes('auth fail')
        ) {
          isAuthError = true;
          formattedError = 'Authentication Failed: Incorrect username, password, or private key.';
        } else if (lower.includes('econnrefused')) {
          formattedError = `Connection Refused: Host ${host}:${port || 22} is unreachable or SSH service is not running.`;
        } else if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('ready timeout')) {
          formattedError = `Connection Timed Out: Unable to reach ${host}:${port || 22}. Please verify host IP and network connection.`;
        } else if (lower.includes('enotfound')) {
          formattedError = `Host Not Found: Could not resolve hostname "${host}".`;
        } else if (lower.includes('ehostunreach') || lower.includes('no route to host')) {
          formattedError = `Host Unreachable: Network route to ${host} not found.`;
        }

        res.status(400).json({ success: false, error: formattedError, isAuthError });
      }
    });

    // SSH Disconnect
    this.app.post('/api/disconnect', async (_req: Request, res: Response) => {
      try {
        this.controller.transferManager.cancelAll();
        await this.controller.transferManager.waitForIdle();
        await this.controller.sshConnection.disconnect();
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Local FS: Home directory
    this.app.get('/api/local-home', (_req: Request, res: Response) => {
      const home = this.controller.localFsService.getHomeDir();
      res.json({ path: home });
    });

    // Local FS: Quick Access / Common Places
    this.app.get('/api/local-places', (_req: Request, res: Response) => {
      const places = this.controller.localFsService.getCommonDirectories();
      res.json({ places });
    });

    // Local FS: List directory
    this.app.get('/api/list-local', async (req: Request, res: Response) => {
      let targetPath = (req.query.path as string) || this.controller.localFsService.getHomeDir();
      targetPath = targetPath.replace(/\\/g, '/');
      if (/^[a-zA-Z]:$/.test(targetPath)) {
        targetPath += '/';
      }
      try {
        const files = await this.controller.localFsService.listDir(targetPath);
        res.json({ files, currentPath: targetPath });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Local FS: Read/Preview File Content
    this.app.get('/api/read-file-local', async (req: Request, res: Response) => {
      let filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: 'Path parameter is required' });
      }
      filePath = filePath.replace(/\\/g, '/');
      try {
        const stat = await fs.promises.stat(filePath);
        const name = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];
        const isImage = imageExts.includes(ext);

        if (stat.size > 10 * 1024 * 1024) {
          return res.status(400).json({ error: 'File exceeds 10MB preview limit' });
        }

        const buffer = await fs.promises.readFile(filePath);
        if (isImage) {
          const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`;
          const base64 = `data:${mime};base64,${buffer.toString('base64')}`;
          return res.json({ name, size: stat.size, isImage: true, dataUrl: base64, mtime: stat.mtime });
        }

        const isBinary = buffer.slice(0, 512).includes(0);
        if (isBinary) {
          return res.json({ name, size: stat.size, isBinary: true, mtime: stat.mtime });
        }

        const text = buffer.toString('utf-8');
        return res.json({ name, size: stat.size, isText: true, content: text, mtime: stat.mtime });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Local FS: Create directory
    this.app.post('/api/mkdir-local', async (req: Request, res: Response) => {
      let { localPath } = req.body;
      if (localPath) localPath = localPath.replace(/\\/g, '/');
      try {
        await this.controller.localFsService.mkdir(localPath);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Local FS: Delete file or directory
    this.app.post('/api/delete-local', async (req: Request, res: Response) => {
      let { localPath, isDirectory } = req.body;
      if (localPath) localPath = localPath.replace(/\\/g, '/');
      try {
        if (isDirectory === true) {
          await this.controller.localFsService.rmdir(localPath, true);
        } else if (isDirectory === false) {
          await this.controller.localFsService.deleteFile(localPath);
        } else {
          await this.controller.localFsService.deleteItem(localPath);
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Remote SFTP: List directory
    this.app.get('/api/list-remote', async (req: Request, res: Response) => {
      let targetPath = (req.query.path as string) || '.';
      try {
        if (targetPath === '.' || !targetPath) {
          try {
            targetPath = await this.controller.sftpService.realpath('.');
          } catch (_) {
            targetPath = '/';
          }
        }
        const files = await this.controller.sftpService.listDir(targetPath);
        res.json({ files, currentPath: targetPath });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Remote SFTP: Read/Preview File Content
    this.app.get('/api/read-file-remote', async (req: Request, res: Response) => {
      const remotePath = req.query.path as string;
      if (!remotePath) {
        return res.status(400).json({ error: 'Path parameter is required' });
      }
      try {
        const stat = await this.controller.sftpService.stat(remotePath);
        const name = path.posix.basename(remotePath);
        const ext = path.posix.extname(remotePath).toLowerCase();
        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];
        const isImage = imageExts.includes(ext);

        if (stat.size > 10 * 1024 * 1024) {
          return res.status(400).json({ error: 'File exceeds 10MB preview limit' });
        }

        const buffer = await this.controller.sftpService.readFile(remotePath, 10 * 1024 * 1024);
        if (isImage) {
          const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`;
          const base64 = `data:${mime};base64,${buffer.toString('base64')}`;
          return res.json({ name, size: stat.size, isImage: true, dataUrl: base64, mtime: stat.modifyTime });
        }

        const isBinary = buffer.slice(0, 512).includes(0);
        if (isBinary) {
          return res.json({ name, size: stat.size, isBinary: true, mtime: stat.modifyTime });
        }

        const text = buffer.toString('utf-8');
        return res.json({ name, size: stat.size, isText: true, content: text, mtime: stat.modifyTime });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Remote SFTP: Mkdir
    this.app.post('/api/mkdir-remote', async (req: Request, res: Response) => {
      const { remotePath } = req.body;
      try {
        await this.controller.sftpService.mkdir(remotePath, true);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Remote SFTP: Get user home directory
    this.app.get('/api/remote-home', async (_req: Request, res: Response) => {
      try {
        let remoteHome = '/';
        try {
          remoteHome = await this.controller.sftpService.realpath('.');
        } catch (_) {}
        res.json({ path: remoteHome || '/' });
      } catch (err: any) {
        res.json({ path: '/' });
      }
    });

    // Remote SFTP: Delete
    this.app.post('/api/delete-remote', async (req: Request, res: Response) => {
      const { remotePath, isDirectory } = req.body;
      try {
        if (isDirectory === true) {
          await this.controller.sftpService.rmdir(remotePath, true);
        } else {
          await this.controller.sftpService.deleteItem(remotePath);
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Remote SFTP: Batch Delete
    this.app.post('/api/delete-batch-remote', async (req: Request, res: Response) => {
      const { items } = req.body; // Array of { remotePath: string, isDirectory: boolean }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'No items provided' });
      }
      let deletedCount = 0;
      const errors: string[] = [];
      for (const item of items) {
        try {
          if (item.isDirectory === true) {
            await this.controller.sftpService.rmdir(item.remotePath, true);
          } else {
            await this.controller.sftpService.deleteItem(item.remotePath);
          }
          deletedCount++;
        } catch (err: any) {
          errors.push(`${path.posix.basename(item.remotePath)}: ${err.message}`);
        }
      }
      res.json({ success: true, count: deletedCount, errors: errors.length > 0 ? errors : undefined });
    });

    // Local FS: Batch Delete
    this.app.post('/api/delete-batch-local', async (req: Request, res: Response) => {
      const { items } = req.body; // Array of { localPath: string, isDirectory: boolean }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'No items provided' });
      }
      let deletedCount = 0;
      const errors: string[] = [];
      for (const item of items) {
        try {
          const p = (item.localPath || '').replace(/\\/g, '/');
          if (item.isDirectory === true) {
            await this.controller.localFsService.rmdir(p, true);
          } else {
            await this.controller.localFsService.deleteItem(p);
          }
          deletedCount++;
        } catch (err: any) {
          errors.push(`${path.basename(item.localPath)}: ${err.message}`);
        }
      }
      res.json({ success: true, count: deletedCount, errors: errors.length > 0 ? errors : undefined });
    });

    // Remote SFTP: Rename
    this.app.post('/api/rename-remote', async (req: Request, res: Response) => {
      const { oldPath, newPath } = req.body;
      try {
        await this.controller.sftpService.rename(oldPath, newPath);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Transfer Queue: Enqueue file
    this.app.post('/api/enqueue-file', (req: Request, res: Response) => {
      const { localPath, remotePath, direction } = req.body;
      try {
        const task = this.controller.transferManager.enqueue({ localPath, remotePath, direction });
        res.json(task);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Transfer Queue: Enqueue Directory Upload
    this.app.post('/api/enqueue-dir-upload', async (req: Request, res: Response) => {
      const { localDir, remoteDir } = req.body;
      const batchId = `batch_up_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      try {
        const tasks = await this.controller.transferManager.enqueueDirectoryUpload(localDir, remoteDir, batchId);
        const totalBytes = tasks.reduce((sum, t) => sum + (t.totalBytes || 0), 0);
        res.json({
          success: true,
          batchId,
          count: tasks.length,
          totalBytes,
          tasks,
        });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Transfer Queue: Enqueue Directory Download
    this.app.post('/api/enqueue-dir-download', async (req: Request, res: Response) => {
      const { remoteDir, localDir } = req.body;
      const batchId = `batch_dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      try {
        const tasks = await this.controller.transferManager.enqueueDirectoryDownload(remoteDir, localDir, batchId);
        const totalBytes = tasks.reduce((sum, t) => sum + (t.totalBytes || 0), 0);
        res.json({
          success: true,
          batchId,
          count: tasks.length,
          totalBytes,
          tasks,
        });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Transfer Queue: Batch Download Multiple Files / Folders
    this.app.post('/api/enqueue-batch-download', async (req: Request, res: Response) => {
      const { items, localDir } = req.body; // items: Array<{ remotePath: string, name: string, isDirectory: boolean }>
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'No items provided for download' });
      }
      try {
        const batchId = `batch_dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const targetLocalDir = (localDir || this.controller.localFsService.getHomeDir()).replace(/\\/g, '/');
        let totalTasks = 0;

        for (const item of items) {
          if (item.isDirectory) {
            const tasks = await this.controller.transferManager.enqueueDirectoryDownload(item.remotePath, targetLocalDir, batchId);
            totalTasks += tasks.length;
          } else {
            const fileName = path.posix.basename(item.remotePath);
            const targetLocalPath = targetLocalDir.endsWith('/')
              ? `${targetLocalDir}${fileName}`
              : `${targetLocalDir}/${fileName}`;
            this.controller.transferManager.enqueue({
              localPath: targetLocalPath,
              remotePath: item.remotePath,
              direction: 'download',
              batchId,
            });
            totalTasks++;
          }
        }

        res.json({ success: true, batchId, count: totalTasks });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Transfer Queue: Batch Upload Multiple Files / Folders
    this.app.post('/api/enqueue-batch-upload', async (req: Request, res: Response) => {
      const { items, remoteDir } = req.body; // items: Array<{ localPath: string, name: string, isDirectory: boolean }>
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'No items provided for upload' });
      }
      try {
        const batchId = `batch_up_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const targetRemoteDir = remoteDir || '.';
        let totalTasks = 0;

        for (const item of items) {
          const lPath = (item.localPath || '').replace(/\\/g, '/');
          if (item.isDirectory) {
            const tasks = await this.controller.transferManager.enqueueDirectoryUpload(lPath, targetRemoteDir, batchId);
            totalTasks += tasks.length;
          } else {
            const fileName = path.basename(lPath);
            const targetRemotePath = targetRemoteDir === '.'
              ? fileName
              : targetRemoteDir.endsWith('/')
              ? `${targetRemoteDir}${fileName}`
              : `${targetRemoteDir}/${fileName}`;
            this.controller.transferManager.enqueue({
              localPath: lPath,
              remotePath: targetRemotePath,
              direction: 'upload',
              batchId,
            });
            totalTasks++;
          }
        }

        res.json({ success: true, batchId, count: totalTasks });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Transfer Queue: Clear Completed / Failed Transfers
    this.app.post('/api/clear-completed-transfers', (_req: Request, res: Response) => {
      this.controller.transferManager.clearCompleted();
      res.json({ success: true });
    });

    // Transfer Queue: Get active tasks
    this.app.get('/api/transfers', (_req: Request, res: Response) => {
      res.json(this.controller.transferManager.getTasks());
    });

    // Transfer Queue: Cancel task
    this.app.post('/api/cancel-transfer', (req: Request, res: Response) => {
      const { taskId } = req.body;
      if (typeof taskId !== 'string' || !taskId) {
        return res.status(400).json({ success: false, error: 'taskId is required' });
      }

      const result = this.controller.transferManager.cancelTask(taskId);
      if (result === 'not-found') {
        return res.status(404).json({ success: false, result, error: 'Transfer task not found' });
      }
      if (result === 'already-finished') {
        return res.status(409).json({ success: false, result, error: 'Transfer has already finished' });
      }
      res.status(result === 'cancellation-requested' ? 202 : 200).json({ success: true, result });
    });

    // Transfer Queue: Cancel all tasks
    this.app.post('/api/cancel-all-transfers', (_req: Request, res: Response) => {
      this.controller.transferManager.cancelAll();
      res.json({ success: true, message: 'All transfers cancelled' });
    });

    // Transfer Queue: Retry single task
    this.app.post('/api/retry-transfer', (req: Request, res: Response) => {
      const { taskId } = req.body;
      if (typeof taskId !== 'string' || !taskId) {
        return res.status(400).json({ success: false, error: 'taskId is required' });
      }
      const retried = this.controller.transferManager.retryTask(taskId);
      if (!retried) {
        return res.status(404).json({ success: false, error: 'Transfer task not found or already active' });
      }
      res.json({ success: true, message: 'Task requeued for transfer' });
    });

    // Transfer Queue: Continue / Retry all failed or interrupted transfers
    this.app.post('/api/retry-failed-transfers', (_req: Request, res: Response) => {
      const count = this.controller.transferManager.retryFailed();
      res.json({ success: true, retriedCount: count, message: `${count} transfer task(s) resumed` });
    });

    // Direct Browser File/Folder Stream Upload
    this.app.post('/api/upload-stream', async (req: Request, res: Response) => {
      const remotePath = req.query.remotePath as string;
      const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : undefined;

      if (!remotePath) {
        return res.status(400).json({ success: false, error: 'remotePath query parameter is required' });
      }

      const controller = new AbortController();
      req.once('aborted', () => controller.abort());

      try {
        await this.controller.sftpService.uploadStream(req, remotePath, contentLength, undefined, controller.signal);
        res.json({ success: true, remotePath });
      } catch (err: any) {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // SSH Command Exec
    this.app.post('/api/exec', async (req: Request, res: Response) => {
      const { command } = req.body;
      if (typeof command !== 'string' || !command.trim() || command.length > 32_768) {
        return res.status(400).json({ error: 'A command between 1 and 32768 characters is required' });
      }
      try {
        const result = await this.controller.terminalService.exec(command);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  private configureWebSocket() {
    let progressTimer: NodeJS.Timeout | null = null;
    let pendingProgress = false;

    const broadcast = (msgObj: any) => {
      try {
        const message = JSON.stringify(msgObj);
        this.wss.clients.forEach((client: WebSocket) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message);
          }
        });
      } catch (err) {
        console.error('Error broadcasting WS message:', err);
      }
    };

    const broadcastProgressThrottled = () => {
      if (progressTimer) {
        pendingProgress = true;
        return;
      }
      const tasks = this.controller.transferManager.getTasks();
      broadcast({ type: 'transfer-progress', transfers: tasks });

      progressTimer = setTimeout(() => {
        progressTimer = null;
        if (pendingProgress) {
          pendingProgress = false;
          broadcastProgressThrottled();
        }
      }, 150);
    };

    this.controller.transferManager.on('progress', () => {
      broadcastProgressThrottled();
    });

    this.controller.transferManager.on('task-completed', (task) => {
      broadcast({ type: 'task-completed', task });
      broadcastProgressThrottled();
    });

    this.controller.transferManager.on('task-failed', (task) => {
      broadcast({ type: 'task-failed', task });
      broadcastProgressThrottled();
    });

    this.controller.transferManager.on('task-retry', (task, retryCount, reason) => {
      broadcast({ type: 'task-retry', task, retryCount, reason });
      broadcastProgressThrottled();
    });

    this.controller.transferManager.on('queue-empty', () => {
      broadcast({ type: 'queue-empty' });
      broadcastProgressThrottled();
    });

    // Forward SSH connection status to all connected UI clients
    this.controller.sshConnection.on('status-change', (status, err) => {
      broadcast({ type: 'connection-status', status, error: err?.message });
    });

    // Periodic WebSocket Heartbeat (every 20s) to keep idle sockets active
    const wsHeartbeatInterval = setInterval(() => {
      broadcast({ type: 'heartbeat', timestamp: Date.now() });
    }, 20000);
    if (wsHeartbeatInterval.unref) wsHeartbeatInterval.unref();
  }

  public async changePort(newPort: number): Promise<void> {
    if (newPort === this.port) return;

    const nextServer = http.createServer(this.app);
    const nextWss = this.createWebSocketServer(nextServer);

    try {
      await this.listen(nextServer, newPort);
    } catch (err) {
      nextWss.close();
      if (nextServer.listening) nextServer.close();
      throw err;
    }

    const previousServer = this.server;
    const previousWss = this.wss;
    this.server = nextServer;
    this.wss = nextWss;
    this.port = newPort;
    this.started = true;

    previousWss.clients.forEach((client) => client.terminate());
    previousWss.close();
    previousServer.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        console.warn('Notice when closing previous server:', err.message);
      }
    });

    console.log(`🚀 SFTP Web GUI Server port changed to ${this.port} (http://127.0.0.1:${this.port})`);
  }

  public getPort(): number {
    return this.port;
  }

  public getLaunchUrl(): string {
    return `http://127.0.0.1:${this.port}/?sessionToken=${encodeURIComponent(this.sessionToken)}`;
  }

  public async stop(): Promise<void> {
    this.controller.transferManager.cancelAll();
    await this.controller.transferManager.waitForIdle();
    await this.controller.sshConnection.disconnect().catch(() => {});
    this.wss.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.server.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    this.started = false;
  }

  public async start(autoOpenBrowser: boolean = true): Promise<void> {
    if (this.started) return;
    const availablePort = await findAvailablePort(this.port, 200, this.bindHost);
    this.port = availablePort;
    await this.listen(this.server, this.port);
    this.started = true;

    const url = `http://127.0.0.1:${this.port}`;
    console.log('=====================================================');
    console.log(`🚀 SB SFTP Studio Server Running securely at ${url}`);
    console.log(`🔒 Bound to ${this.bindHost}; LAN access ${this.allowLan ? 'enabled' : 'disabled'}`);
    console.log('=====================================================');

    if (autoOpenBrowser) {
      openBrowser(this.getLaunchUrl());
    }
  }

  private async listen(server: http.Server, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.bindHost);
    });
  }
}

// Auto start if invoked directly
if (require.main === module) {
  const defaultPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const server = new SftpWebServer(defaultPort);
  server.start();
}
