import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { SftpClientService } from './SftpClientService';
import { TransferDirection, TransferProgress, TaskStatus } from '../types';

export interface EnqueueOptions {
  localPath: string;
  remotePath: string;
  direction: TransferDirection;
  totalBytes?: number;
}

export type CancelResult = 'queued-cancelled' | 'cancellation-requested' | 'already-finished' | 'not-found';

export class TransferTaskState implements TransferProgress {
  public id: string;
  public fileName: string;
  public localPath: string;
  public remotePath: string;
  public direction: TransferDirection;
  public transferredBytes: number = 0;
  public totalBytes: number = 0;
  public percentage: number = 0;
  public speedBytesPerSec: number = 0;
  public speedFormatted: string = '0 B/s';
  public etaSeconds: number = 0;
  public etaFormatted: string = '--:--';
  public status: TaskStatus = 'queued';
  public error?: string;
  public transferredFormatted: string = '0 B';
  public totalFormatted: string = '0 B';
  public startTime: number = 0;
  public endTime?: number;

  private lastTime: number = 0;
  private lastTransferred: number = 0;

  constructor(id: string, opts: EnqueueOptions) {
    this.id = id;
    this.localPath = opts.localPath;
    this.remotePath = opts.remotePath;
    this.direction = opts.direction;
    this.fileName = path.basename(opts.direction === 'upload' ? opts.localPath : opts.remotePath);
    this.totalBytes = opts.totalBytes || 0;
    this.totalFormatted = TransferTaskState.formatBytes(this.totalBytes);
  }

  public markStarted(totalBytes?: number): void {
    if (totalBytes !== undefined) {
      this.totalBytes = totalBytes;
      this.totalFormatted = TransferTaskState.formatBytes(this.totalBytes);
    }
    this.status = 'transferring';
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastTransferred = 0;
    this.transferredBytes = 0;
    this.transferredFormatted = '0 B';
  }

  public updateProgress(transferred: number, total?: number): void {
    if (total !== undefined && total > 0) {
      this.totalBytes = total;
      this.totalFormatted = TransferTaskState.formatBytes(this.totalBytes);
    }
    this.transferredBytes = transferred;
    this.transferredFormatted = TransferTaskState.formatBytes(this.transferredBytes);

    if (this.totalBytes > 0) {
      this.percentage = Math.min(100, Math.round((this.transferredBytes / this.totalBytes) * 1000) / 10);
    } else {
      this.percentage = 100;
    }

    const now = Date.now();
    const timeDelta = (now - this.lastTime) / 1000;

    // Calculate rolling speed every 0.3s or on completion
    if (timeDelta >= 0.3 || transferred === this.totalBytes) {
      const bytesDelta = transferred - this.lastTransferred;
      const currentSpeed = timeDelta > 0 ? bytesDelta / timeDelta : 0;

      // Smoothed speed calculation
      this.speedBytesPerSec = Math.round(
        this.speedBytesPerSec === 0 ? currentSpeed : this.speedBytesPerSec * 0.6 + currentSpeed * 0.4
      );

      this.speedFormatted = TransferTaskState.formatBytes(this.speedBytesPerSec) + '/s';

      if (this.speedBytesPerSec > 0 && this.totalBytes > transferred) {
        const remainingBytes = this.totalBytes - transferred;
        this.etaSeconds = Math.ceil(remainingBytes / this.speedBytesPerSec);
        this.etaFormatted = TransferTaskState.formatDuration(this.etaSeconds);
      } else {
        this.etaSeconds = 0;
        this.etaFormatted = '00:00';
      }

      this.lastTime = now;
      this.lastTransferred = transferred;
    }
  }

  public markCompleted(): void {
    this.status = 'completed';
    this.percentage = 100;
    this.transferredBytes = this.totalBytes;
    this.transferredFormatted = TransferTaskState.formatBytes(this.transferredBytes);
    this.speedBytesPerSec = 0;
    this.speedFormatted = '0 B/s';
    this.etaFormatted = '00:00';
    this.endTime = Date.now();
  }

  public markFailed(error: string): void {
    this.status = 'failed';
    this.error = error;
    this.speedBytesPerSec = 0;
    this.speedFormatted = '0 B/s';
    this.etaFormatted = '--:--';
    this.endTime = Date.now();
  }

  public markCancelled(): void {
    this.status = 'cancelled';
    this.speedBytesPerSec = 0;
    this.speedFormatted = '0 B/s';
    this.etaSeconds = 0;
    this.etaFormatted = '--:--';
    this.endTime = Date.now();
  }

  public static formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  public static formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0 || !isFinite(seconds)) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const pad = (n: number) => n.toString().padStart(2, '0');

    if (hrs > 0) {
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }
}

export class TransferManager extends EventEmitter {
  private queue: TransferTaskState[] = [];
  private activeTasks: Map<string, TransferTaskState> = new Map();
  private completedTasks: TransferTaskState[] = [];
  private abortControllers: Map<string, AbortController> = new Map();
  private maxConcurrency: number = 3;
  private taskCounter: number = 0;

  constructor(private sftpService: SftpClientService, concurrency: number = 3) {
    super();
    this.maxConcurrency = concurrency;
  }

  public setConcurrency(concurrency: number): void {
    this.maxConcurrency = Math.max(1, concurrency);
    this.processQueue();
  }

  public enqueue(opts: EnqueueOptions): TransferTaskState {
    this.taskCounter++;
    const id = `task_${Date.now()}_${this.taskCounter}`;
    const task = new TransferTaskState(id, opts);
    this.queue.push(task);

    this.emit('task-added', task);
    this.processQueue();
    return task;
  }

  /**
   * Recursively enqueue a directory for upload
   */
  public async enqueueDirectoryUpload(localDir: string, remoteDir: string): Promise<TransferTaskState[]> {
    const tasks: TransferTaskState[] = [];
    const folderName = path.basename(localDir);
    const targetRemoteDir = remoteDir === '.' ? folderName : path.posix.join(remoteDir, folderName);

    await this.sftpService.mkdir(targetRemoteDir, true);

    const walk = async (currentLocal: string, currentRemote: string) => {
      const entries = await fs.promises.readdir(currentLocal, { withFileTypes: true });

      for (const entry of entries) {
        const lPath = path.join(currentLocal, entry.name);
        const rPath = path.posix.join(currentRemote, entry.name);

        if (entry.isDirectory()) {
          await this.sftpService.mkdir(rPath, true);
          await walk(lPath, rPath);
        } else if (entry.isFile()) {
          const stats = await fs.promises.stat(lPath);
          const task = this.enqueue({
            localPath: lPath,
            remotePath: rPath,
            direction: 'upload',
            totalBytes: stats.size,
          });
          tasks.push(task);
        }
      }
    };

    await walk(localDir, targetRemoteDir);
    return tasks;
  }

  /**
   * Recursively enqueue a directory for download
   */
  public async enqueueDirectoryDownload(remoteDir: string, localDir: string): Promise<TransferTaskState[]> {
    const tasks: TransferTaskState[] = [];
    const folderName = path.posix.basename(remoteDir);
    const targetLocalDir = path.join(localDir, folderName);

    await fs.promises.mkdir(targetLocalDir, { recursive: true });

    const walk = async (currentRemote: string, currentLocal: string) => {
      const items = await this.sftpService.listDir(currentRemote);

      for (const item of items) {
        const lPath = path.join(currentLocal, item.name);

        if (item.type === 'directory') {
          await fs.promises.mkdir(lPath, { recursive: true });
          await walk(item.path, lPath);
        } else if (item.type === 'file') {
          const task = this.enqueue({
            localPath: lPath,
            remotePath: item.path,
            direction: 'download',
            totalBytes: item.size,
          });
          tasks.push(task);
        }
      }
    };

    await walk(remoteDir, targetLocalDir);
    return tasks;
  }

  public getTasks(): TransferTaskState[] {
    return [
      ...Array.from(this.activeTasks.values()),
      ...this.queue,
      ...this.completedTasks,
    ];
  }

  public clearCompleted(): void {
    this.completedTasks = [];
    this.emit('progress');
  }

  public cancelTask(id: string): CancelResult {
    const queueIdx = this.queue.findIndex((t) => t.id === id);
    if (queueIdx !== -1) {
      const task = this.queue.splice(queueIdx, 1)[0];
      task.markCancelled();
      this.completedTasks.unshift(task);
      this.emit('task-cancelled', task);
      this.emit('progress', task);
      this.processQueue();
      return 'queued-cancelled';
    }

    const activeTask = this.activeTasks.get(id);
    const controller = this.abortControllers.get(id);
    if (activeTask && controller) {
      if (activeTask.status === 'cancelling') return 'cancellation-requested';
      activeTask.status = 'cancelling';
      this.emit('progress', activeTask);
      controller.abort();
      return 'cancellation-requested';
    }

    if (this.completedTasks.some((task) => task.id === id)) return 'already-finished';
    return 'not-found';
  }

  public cancelAll(): void {
    for (const task of [...this.queue]) {
      this.cancelTask(task.id);
    }
    for (const task of this.activeTasks.values()) {
      this.cancelTask(task.id);
    }
  }

  public async waitForIdle(timeoutMs: number = 5000): Promise<void> {
    if (this.activeTasks.size === 0 && this.queue.length === 0) return;

    await new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout;
      const done = () => {
        clearTimeout(timeout);
        this.off('queue-empty', onEmpty);
        resolve();
      };
      const onEmpty = () => done();
      timeout = setTimeout(done, timeoutMs);

      this.once('queue-empty', onEmpty);
    });
  }

  private async processQueue(): Promise<void> {
    while (this.activeTasks.size < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeTasks.set(task.id, task);

      // Run task asynchronously
      this.runTask(task);
    }

    if (this.activeTasks.size === 0 && this.queue.length === 0) {
      this.emit('queue-empty');
    }
  }

  private async runTask(task: TransferTaskState): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    const localTempPath = `${task.localPath}.sbpart-${task.id}`;
    const remoteTempPath = `${task.remotePath}.sbpart-${task.id}`;

    try {
      if (task.direction === 'upload') {
        const stats = await fs.promises.stat(task.localPath);
        if (controller.signal.aborted) throw this.createAbortError();
        task.markStarted(stats.size);
        this.emit('progress', task);

        let lastEmitTime = 0;
        await this.sftpService.uploadFile(task.localPath, remoteTempPath, (transferred, total) => {
          if (task.status === 'cancelling' || task.status === 'cancelled') return;
          task.updateProgress(transferred, total);
          const now = Date.now();
          if (now - lastEmitTime >= 120 || transferred === total) {
            lastEmitTime = now;
            this.emit('progress', task);
          }
        }, controller.signal);

        if (controller.signal.aborted) throw this.createAbortError();
        if (await this.sftpService.exists(task.remotePath)) {
          await this.sftpService.deleteFile(task.remotePath);
        }
        await this.sftpService.rename(remoteTempPath, task.remotePath);
      } else {
        const remoteStat = await this.sftpService.stat(task.remotePath);
        if (controller.signal.aborted) throw this.createAbortError();
        task.markStarted(remoteStat.size);
        this.emit('progress', task);

        let lastEmitTime = 0;
        await this.sftpService.downloadFile(task.remotePath, localTempPath, (transferred, total) => {
          if (task.status === 'cancelling' || task.status === 'cancelled') return;
          task.updateProgress(transferred, total);
          const now = Date.now();
          if (now - lastEmitTime >= 120 || transferred === total) {
            lastEmitTime = now;
            this.emit('progress', task);
          }
        }, controller.signal);

        if (controller.signal.aborted) throw this.createAbortError();
        await fs.promises.rm(task.localPath, { force: true });
        await fs.promises.rename(localTempPath, task.localPath);
      }

      task.markCompleted();
      this.emit('progress', task);
      this.emit('task-completed', task);
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        task.markCancelled();
        this.emit('task-cancelled', task);
      } else {
        task.markFailed(err.message || String(err));
        this.emit('task-failed', task);
      }
      this.emit('progress', task);
    } finally {
      if (task.status !== 'completed') {
        if (task.direction === 'upload') {
          await this.sftpService.deleteFile(remoteTempPath).catch(() => {});
        } else {
          await fs.promises.rm(localTempPath, { force: true }).catch(() => {});
        }
      }

      this.abortControllers.delete(task.id);
      this.activeTasks.delete(task.id);
      if (!this.completedTasks.some((item) => item.id === task.id)) {
        this.completedTasks.unshift(task);
      }
      if (this.completedTasks.length > 100) {
        this.completedTasks = this.completedTasks.slice(0, 100);
      }
      this.processQueue();
    }
  }

  private createAbortError(): Error {
    const error = new Error('Transfer cancelled');
    error.name = 'AbortError';
    return error;
  }
}
