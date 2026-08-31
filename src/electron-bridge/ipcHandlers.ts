import { SshConnection } from '../core/SshConnection';
import { SftpClientService } from '../core/SftpClientService';
import { SshTerminalService, SshShellSession } from '../core/SshTerminalService';
import { TransferManager } from '../core/TransferManager';
import { LocalFsService } from '../core/LocalFsService';
import { SshConnectConfig, TransferDirection } from '../types';

/**
 * Controller class managing the lifecycle of SSH, SFTP, Transfers, and Shell sessions for Electron
 */
export class SftpAppController {
  public sshConnection: SshConnection;
  public sftpService: SftpClientService;
  public terminalService: SshTerminalService;
  public transferManager: TransferManager;
  public localFsService: LocalFsService;
  private activeShellSessions: Map<string, SshShellSession> = new Map();

  constructor() {
    this.sshConnection = new SshConnection();
    this.sftpService = new SftpClientService(this.sshConnection);
    this.terminalService = new SshTerminalService(this.sshConnection);
    this.transferManager = new TransferManager(this.sftpService, 3);
    this.localFsService = new LocalFsService();
  }

  /**
   * Registers IPC handlers with Electron's `ipcMain` module.
   * Pass Electron's `ipcMain` object to this method when building your Electron app.
   */
  public registerIpcHandlers(ipcMain: any): void {
    // Forward transfer manager progress events to renderer windows via IPC
    this.transferManager.on('progress', (taskProgress) => {
      if (ipcMain && ipcMain.emitToRenderers) {
        ipcMain.emitToRenderers('sftp:progress-event', taskProgress);
      }
    });

    // Connection APIs
    ipcMain.handle('sftp:connect', async (_event: any, config: SshConnectConfig) => {
      await this.sshConnection.connect(config);
      return { success: true, status: this.sshConnection.getStatus() };
    });

    ipcMain.handle('sftp:disconnect', async () => {
      await this.sshConnection.disconnect();
      return { success: true };
    });

    ipcMain.handle('sftp:get-status', () => {
      return this.sshConnection.getStatus();
    });

    // Remote File APIs
    ipcMain.handle('sftp:list-remote', async (_event: any, remotePath: string) => {
      return await this.sftpService.listDir(remotePath);
    });

    ipcMain.handle('sftp:mkdir-remote', async (_event: any, remotePath: string) => {
      await this.sftpService.mkdir(remotePath, true);
      return { success: true };
    });

    ipcMain.handle('sftp:delete-remote', async (_event: any, remotePath: string, isDirectory: boolean) => {
      if (isDirectory) {
        await this.sftpService.rmdir(remotePath, true);
      } else {
        await this.sftpService.deleteFile(remotePath);
      }
      return { success: true };
    });

    ipcMain.handle('sftp:rename-remote', async (_event: any, oldPath: string, newPath: string) => {
      await this.sftpService.rename(oldPath, newPath);
      return { success: true };
    });

    ipcMain.handle('sftp:chmod-remote', async (_event: any, remotePath: string, mode: number | string) => {
      await this.sftpService.chmod(remotePath, mode);
      return { success: true };
    });

    // Local File APIs
    ipcMain.handle('sftp:list-local', async (_event: any, localPath: string) => {
      return await this.localFsService.listDir(localPath);
    });

    ipcMain.handle('sftp:get-local-home', () => {
      return this.localFsService.getHomeDir();
    });

    ipcMain.handle('sftp:mkdir-local', async (_event: any, localPath: string) => {
      await this.localFsService.mkdir(localPath);
      return { success: true };
    });

    ipcMain.handle('sftp:delete-local', async (_event: any, localPath: string, isDirectory: boolean) => {
      if (isDirectory) {
        await this.localFsService.rmdir(localPath, true);
      } else {
        await this.localFsService.deleteFile(localPath);
      }
      return { success: true };
    });

    // Transfer Queue APIs
    ipcMain.handle('sftp:enqueue-file', (_event: any, opts: { localPath: string; remotePath: string; direction: TransferDirection }) => {
      const task = this.transferManager.enqueue(opts);
      return task;
    });

    ipcMain.handle('sftp:enqueue-dir-upload', async (_event: any, localDir: string, remoteDir: string) => {
      const tasks = await this.transferManager.enqueueDirectoryUpload(localDir, remoteDir);
      return tasks;
    });

    ipcMain.handle('sftp:enqueue-dir-download', async (_event: any, remoteDir: string, localDir: string) => {
      const tasks = await this.transferManager.enqueueDirectoryDownload(remoteDir, localDir);
      return tasks;
    });

    ipcMain.handle('sftp:cancel-transfer', (_event: any, taskId: string) => {
      this.transferManager.cancelTask(taskId);
      return { success: true };
    });

    ipcMain.handle('sftp:get-transfers', () => {
      return this.transferManager.getTasks();
    });

    // SSH Command & Terminal APIs
    ipcMain.handle('ssh:exec', async (_event: any, command: string) => {
      return await this.terminalService.exec(command);
    });

    ipcMain.handle('ssh:spawn-shell', async (event: any, sessionId: string, cols: number = 80, rows: number = 24) => {
      const session = await this.terminalService.spawnShell('xterm-256color', rows, cols);
      this.activeShellSessions.set(sessionId, session);

      session.on('data', (data) => {
        event.sender.send(`ssh:shell-data:${sessionId}`, data);
      });

      session.on('close', () => {
        event.sender.send(`ssh:shell-close:${sessionId}`);
        this.activeShellSessions.delete(sessionId);
      });

      return { success: true, sessionId };
    });

    ipcMain.handle('ssh:shell-write', (_event: any, sessionId: string, data: string) => {
      const session = this.activeShellSessions.get(sessionId);
      if (session) {
        session.write(data);
      }
    });

    ipcMain.handle('ssh:shell-resize', (_event: any, sessionId: string, cols: number, rows: number) => {
      const session = this.activeShellSessions.get(sessionId);
      if (session) {
        session.resize(rows, cols);
      }
    });
  }
}
