import express, { Request, Response } from 'express';
import http from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';
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

async function findAvailablePort(startPort: number = 3000, maxTries: number = 200): Promise<number> {
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
        .listen(p, '127.0.0.1');
    });
    if (isAvailable) return p;
  }
  return startPort;
}

export class SftpWebServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;
  private controller = new SftpAppController();
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.controller.sshConnection.on('error', (err) => {
      console.warn(`[SftpWebServer] SSH connection notice: ${err?.message || err}`);
    });
    this.configureMiddleware();
    this.configureRoutes();
    this.configureWebSocket();
  }

  private configureMiddleware() {
    this.app.use(express.json());
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

      const primaryIp = ipList.find((i) => !i.internal)?.address || '127.0.0.1';

      res.json({
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        currentPort: this.port,
        primaryIp,
        ipAddresses: ipList,
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
      // Send successful response first so the client receives it before server port switches
      res.json({
        success: true,
        oldPort,
        newPort: portNum,
        redirectUrl: `http://localhost:${portNum}`,
      });

      // Switch port on next tick
      setTimeout(() => {
        this.changePort(portNum).catch((err) => {
          console.error(`Failed to change server port to ${portNum}:`, err.message);
        });
      }, 150);
    });

    // SSH Connection Status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      res.json({ status: this.controller.sshConnection.getStatus() });
    });

    // SSH Connect
    this.app.post('/api/connect', async (req: Request, res: Response) => {
      const { host, port, username, password, privateKeyPath, passphrase } = req.body;
      try {
        let privateKey: Buffer | undefined = undefined;
        if (privateKeyPath && fs.existsSync(privateKeyPath)) {
          privateKey = fs.readFileSync(privateKeyPath);
        }

        const config: SshConnectConfig = {
          host,
          port: port ? parseInt(port, 10) : 22,
          username,
          password: password || undefined,
          privateKey,
          passphrase: passphrase || undefined,
        };

        await this.controller.sshConnection.connect(config);
        res.json({ success: true, status: this.controller.sshConnection.getStatus() });
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

        res.status(400).json({ success: false, error: formattedError, isAuthError, rawError });
      }
    });

    // SSH Disconnect
    this.app.post('/api/disconnect', async (_req: Request, res: Response) => {
      try {
        await this.controller.sshConnection.disconnect();
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Local FS: Home directory
    this.app.get('/api/local-home', (_req: Request, res: Response) => {
      res.json({ path: this.controller.localFsService.getHomeDir() });
    });

    // Local FS: List directory
    this.app.get('/api/list-local', async (req: Request, res: Response) => {
      const targetPath = (req.query.path as string) || this.controller.localFsService.getHomeDir();
      try {
        const files = await this.controller.localFsService.listDir(targetPath);
        res.json(files);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Local FS: Read/Preview File Content
    this.app.get('/api/read-file-local', async (req: Request, res: Response) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        return res.status(400).json({ error: 'Path parameter is required' });
      }
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
      const { localPath } = req.body;
      try {
        await this.controller.localFsService.mkdir(localPath);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Local FS: Delete file or directory
    this.app.post('/api/delete-local', async (req: Request, res: Response) => {
      const { localPath, isDirectory } = req.body;
      try {
        if (isDirectory) {
          await this.controller.localFsService.rmdir(localPath, true);
        } else {
          await this.controller.localFsService.deleteFile(localPath);
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Remote SFTP: List directory
    this.app.get('/api/list-remote', async (req: Request, res: Response) => {
      const targetPath = (req.query.path as string) || '.';
      try {
        const files = await this.controller.sftpService.listDir(targetPath);
        res.json({ files });
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

        const buffer = await this.controller.sftpService.readFile(remotePath, 5 * 1024 * 1024);
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

    // Remote SFTP: Delete
    this.app.post('/api/delete-remote', async (req: Request, res: Response) => {
      const { remotePath, isDirectory } = req.body;
      try {
        if (isDirectory) {
          await this.controller.sftpService.rmdir(remotePath, true);
        } else {
          await this.controller.sftpService.deleteFile(remotePath);
        }
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
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
      try {
        const tasks = await this.controller.transferManager.enqueueDirectoryUpload(localDir, remoteDir);
        const totalBytes = tasks.reduce((sum, t) => sum + (t.totalBytes || 0), 0);
        res.json({
          success: true,
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
      try {
        const tasks = await this.controller.transferManager.enqueueDirectoryDownload(remoteDir, localDir);
        const totalBytes = tasks.reduce((sum, t) => sum + (t.totalBytes || 0), 0);
        res.json({
          success: true,
          count: tasks.length,
          totalBytes,
          tasks,
        });
      } catch (err: any) {
        res.status(400).json({ success: false, error: err.message });
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
      this.controller.transferManager.cancelTask(taskId);
      res.json({ success: true });
    });

    // Direct Browser File/Folder Stream Upload
    this.app.post('/api/upload-stream', async (req: Request, res: Response) => {
      const remotePath = req.query.remotePath as string;
      const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : undefined;

      if (!remotePath) {
        return res.status(400).json({ success: false, error: 'remotePath query parameter is required' });
      }

      try {
        await this.controller.sftpService.uploadStream(req, remotePath, contentLength);
        res.json({ success: true, remotePath });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // SSH Command Exec
    this.app.post('/api/exec', async (req: Request, res: Response) => {
      const { command } = req.body;
      try {
        const result = await this.controller.terminalService.exec(command);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  private configureWebSocket() {
    const broadcast = (msgObj: any) => {
      const message = JSON.stringify(msgObj);
      this.wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    };

    this.controller.transferManager.on('progress', () => {
      const tasks = this.controller.transferManager.getTasks();
      broadcast({ type: 'transfer-progress', transfers: tasks });
    });

    this.controller.transferManager.on('task-completed', (task) => {
      broadcast({ type: 'task-completed', task });
    });

    this.controller.transferManager.on('task-failed', (task) => {
      broadcast({ type: 'task-failed', task });
    });

    this.controller.transferManager.on('queue-empty', () => {
      broadcast({ type: 'queue-empty' });
    });
  }

  public async changePort(newPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Terminate existing WS clients and close WS server
      try {
        this.wss.clients.forEach((client) => {
          client.terminate();
        });
        this.wss.close();
      } catch (e) {}

      // Close HTTP server and re-bind to new port
      this.server.close((closeErr) => {
        if (closeErr) {
          console.warn('Notice when closing server:', closeErr.message);
        }

        this.port = newPort;
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
        this.configureWebSocket();

        this.server.listen(this.port, () => {
          console.log(`🚀 SFTP Web GUI Server port changed to ${this.port} (http://localhost:${this.port})`);
          resolve();
        }).on('error', (err) => {
          reject(err);
        });
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      try {
        this.wss.clients.forEach((client) => client.terminate());
        this.wss.close();
      } catch (_) {}
      this.server.close(() => {
        resolve();
      });
    });
  }

  public async start(autoOpenBrowser: boolean = true): Promise<void> {
    const availablePort = await findAvailablePort(this.port);
    this.port = availablePort;
    return new Promise((resolve, reject) => {
      const tryListen = () => {
        this.server.removeAllListeners('error');
        this.server.on('error', async (err: any) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`Port ${this.port} is in use. Checking next available port (e.g. ${this.port} + 1)...`);
            const nextFreePort = await findAvailablePort(this.port + 1);
            this.port = nextFreePort;
            try {
              this.wss.close();
            } catch (_) {}
            try {
              this.server.close();
            } catch (_) {}
            this.server = http.createServer(this.app);
            this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
            this.configureWebSocket();
            tryListen();
          } else {
            reject(err);
          }
        });

        this.server.listen(this.port, () => {
          const url = `http://localhost:${this.port}`;
          console.log('=====================================================');
          console.log(`🚀 SB SFTP Studio Server Running at ${url}`);
          console.log('=====================================================');

          if (autoOpenBrowser) {
            openBrowser(url);
          }
          resolve();
        });
      };

      tryListen();
    });
  }
}

// Process-level safety guards to prevent server crashes from unexpected network dropouts
process.on('unhandledRejection', (reason: any) => {
  console.warn('[Process] Handled unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err: Error) => {
  console.warn('[Process] Handled uncaught exception:', err.message);
});

// Auto start if invoked directly
if (require.main === module) {
  const defaultPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const server = new SftpWebServer(defaultPort);
  server.start();
}
