import { ConnectConfig as Ssh2ConnectConfig } from 'ssh2';

export interface SshConnectConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  keepaliveInterval?: number;
  readyTimeout?: number;
  algorithms?: Ssh2ConnectConfig['algorithms'];
}

export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileItem {
  name: string;
  path: string;
  size: number;
  type: FileType;
  modifyTime: Date;
  accessTime?: Date;
  permissions?: string;
  mode?: number;
  uid?: number;
  gid?: number;
}

export type TransferDirection = 'upload' | 'download';

export type TaskStatus = 'queued' | 'transferring' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TransferProgress {
  id: string;
  fileName: string;
  localPath: string;
  remotePath: string;
  direction: TransferDirection;
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  speedBytesPerSec: number;
  speedFormatted: string;
  etaSeconds: number;
  etaFormatted: string;
  status: TaskStatus;
  error?: string;
  transferredFormatted?: string;
  totalFormatted?: string;
  startTime?: number;
  endTime?: number;
}

export interface TransferOptions {
  concurrency?: number;
  preserveTimestamps?: boolean;
  overwrite?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
