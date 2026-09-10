import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Stats, SFTPWrapper } from 'ssh2';
import { SshConnection } from './SshConnection';
import { FileItem, FileType } from '../types';

export class SftpClientService {
  constructor(private connection: SshConnection) {}

  private async getSftp(): Promise<SFTPWrapper> {
    return this.connection.getSftp();
  }

  /**
   * Helper to convert numeric file mode to human-readable permission string (e.g. 'drwxr-xr-x')
   */
  public modeToPermissions(mode: number): string {
    const isDir = (mode & 0o40000) === 0o40000;
    const isLink = (mode & 0o120000) === 0o120000;
    
    let typeChar = '-';
    if (isDir) typeChar = 'd';
    else if (isLink) typeChar = 'l';

    const owner = [
      mode & 0o400 ? 'r' : '-',
      mode & 0o200 ? 'w' : '-',
      mode & 0o100 ? 'x' : '-',
    ].join('');

    const group = [
      mode & 0o040 ? 'r' : '-',
      mode & 0o020 ? 'w' : '-',
      mode & 0o010 ? 'x' : '-',
    ].join('');

    const others = [
      mode & 0o004 ? 'r' : '-',
      mode & 0o002 ? 'w' : '-',
      mode & 0o001 ? 'x' : '-',
    ].join('');

    return `${typeChar}${owner}${group}${others}`;
  }

  /**
   * Determine file type from stats mode
   */
  private getFileType(mode: number): FileType {
    if ((mode & 0o40000) === 0o40000) return 'directory';
    if ((mode & 0o120000) === 0o120000) return 'symlink';
    if ((mode & 0o100000) === 0o100000) return 'file';
    return 'other';
  }

  /**
   * List files in a remote directory
   */
  public async listDir(remotePath: string): Promise<FileItem[]> {
    const sftp = await this.getSftp();
    let cleanPath = remotePath || '.';
    if (cleanPath !== '.') {
      cleanPath = path.posix.normalize(cleanPath);
    }

    return new Promise((resolve, reject) => {
      sftp.readdir(cleanPath, (err, list) => {
        if (err) {
          return reject(new Error(`Failed to list directory '${cleanPath}': ${err.message}`));
        }

        const validEntries = (list || []).filter(
          (entry) => entry && entry.filename !== '.' && entry.filename !== '..'
        );

        const items: FileItem[] = validEntries.map((entry) => {
          const itemPath = cleanPath === '/' 
            ? `/${entry.filename}` 
            : path.posix.join(cleanPath, entry.filename);
          const type = this.getFileType(entry.attrs.mode);
          return {
            name: entry.filename,
            path: itemPath,
            size: entry.attrs.size,
            type,
            modifyTime: new Date(entry.attrs.mtime * 1000),
            accessTime: new Date(entry.attrs.atime * 1000),
            permissions: this.modeToPermissions(entry.attrs.mode),
            mode: entry.attrs.mode,
            uid: entry.attrs.uid,
            gid: entry.attrs.gid,
          };
        });

        // Sort directories first, then newest files by modifyTime
        items.sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          const timeA = new Date(a.modifyTime || 0).getTime();
          const timeB = new Date(b.modifyTime || 0).getTime();
          if (timeB !== timeA) return timeB - timeA;
          return a.name.localeCompare(b.name);
        });

        resolve(items);
      });
    });
  }

  /**
   * Resolve real canonical absolute path for a remote directory
   */
  public async realpath(remotePath: string = '.'): Promise<string> {
    const sftp = await this.getSftp();
    return new Promise((resolve) => {
      sftp.realpath(remotePath, (err, absPath) => {
        if (err || !absPath) {
          return resolve(remotePath === '.' ? '/' : remotePath);
        }
        resolve(absPath);
      });
    });
  }

  /**
   * Get stats for a remote path
   */
  public async stat(remotePath: string): Promise<FileItem> {
    const sftp = await this.getSftp();

    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          return reject(new Error(`Failed to stat '${remotePath}': ${err.message}`));
        }

        const name = path.posix.basename(remotePath);
        const type = this.getFileType(stats.mode);

        resolve({
          name,
          path: remotePath,
          size: stats.size,
          type,
          modifyTime: new Date(stats.mtime * 1000),
          accessTime: new Date(stats.atime * 1000),
          permissions: this.modeToPermissions(stats.mode),
          mode: stats.mode,
          uid: stats.uid,
          gid: stats.gid,
        });
      });
    });
  }

  /**
   * Check if a remote file or directory exists
   */
  public async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Upload a single file from local to remote with progress callback
   */
  public async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const sftp = await this.getSftp();
    const stats = await fs.promises.stat(localPath);
    const totalSize = stats.size;

    // Ensure remote parent directory exists before writing
    const dir = path.posix.dirname(remotePath);
    if (dir && dir !== '.' && dir !== '/') {
      await this.mkdir(dir, true);
    }

    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);
    let transferred = 0;

    readStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress?.(transferred, totalSize);
    });

    try {
      await pipeline(readStream, writeStream, { signal });
      onProgress?.(totalSize, totalSize);
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError') {
        const abortError = new Error('Upload cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw new Error(`Upload failed for '${localPath}' -> '${remotePath}': ${err.message}`);
    }

    // Verify consistency: verify uploaded file matches size if totalSize > 0
    if (totalSize > 0) {
      try {
        const remoteStat = await this.stat(remotePath);
        if (remoteStat.size !== totalSize) {
          throw new Error(`Upload verification failed: expected ${totalSize} bytes, got ${remoteStat.size} bytes`);
        }
      } catch (verr: any) {
        if (verr.message?.includes('Upload verification failed')) {
          throw verr;
        }
      }
    }
  }

  /**
   * Upload from a readable stream directly to remote path (used for browser folder/file uploads)
   */
  public async uploadStream(
    stream: NodeJS.ReadableStream,
    remotePath: string,
    totalSize?: number,
    onProgress?: (transferred: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const sftp = await this.getSftp();
    const dir = path.posix.dirname(remotePath);
    await this.mkdir(dir, true);

    const writeStream = sftp.createWriteStream(remotePath);
    let transferred = 0;

    stream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress?.(transferred, totalSize || transferred);
    });

    try {
      await pipeline(stream, writeStream, { signal });
      onProgress?.(transferred, totalSize ?? transferred);
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError') {
        const abortError = new Error('Upload cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw new Error(`Stream upload failed for '${remotePath}': ${err.message}`);
    }
  }

  /**
   * Read remote file content (up to maxBytes, default 2MB for text/preview)
   */
  public async readFile(remotePath: string, maxBytes: number = 2 * 1024 * 1024): Promise<Buffer> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const readStream = sftp.createReadStream(remotePath, { start: 0, end: Math.max(0, maxBytes - 1) });

      readStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
      });

      readStream.on('error', (err: any) => {
        reject(new Error(`Failed to read remote file '${remotePath}': ${err.message}`));
      });

      readStream.on('close', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Download a single file from remote to local with progress callback
   */
  public async downloadFile(
    remotePath: string,
    localPath: string,
    onProgress?: (transferred: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const sftp = await this.getSftp();
    const remoteStat = await this.stat(remotePath);
    const totalSize = remoteStat.size;

    // Ensure directory exists
    const dir = path.dirname(localPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const readStream = sftp.createReadStream(remotePath);
    const writeStream = fs.createWriteStream(localPath);
    let transferred = 0;

    readStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress?.(transferred, totalSize);
    });

    try {
      await pipeline(readStream, writeStream, { signal });
      onProgress?.(totalSize, totalSize);
    } catch (err: any) {
      if (signal?.aborted || err?.name === 'AbortError') {
        const abortError = new Error('Download cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw new Error(`Download failed for '${remotePath}' -> '${localPath}': ${err.message}`);
    }

    // Verify consistency: verify downloaded file matches size if totalSize > 0
    if (totalSize > 0) {
      const localStat = await fs.promises.stat(localPath);
      if (localStat.size !== totalSize) {
        throw new Error(`Download verification failed: expected ${totalSize} bytes, got ${localStat.size} bytes`);
      }
    }
  }

  /**
   * Create remote directory
   */
  public async mkdir(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getSftp();

    if (!recursive) {
      return new Promise((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) {
            const code = (err as any).code;
            const msg = (err.message || '').toLowerCase();
            if (code === 4 || msg.includes('exist') || msg.includes('failure')) {
              return resolve();
            }
            return reject(new Error(`Failed to create directory '${remotePath}': ${err.message}`));
          }
          resolve();
        });
      });
    }

    // Recursive directory creation
    const parts = remotePath.split('/').filter(Boolean);
    let current = remotePath.startsWith('/') ? '/' : '';

    for (const part of parts) {
      current = path.posix.join(current, part);
      const isExist = await this.exists(current);
      if (!isExist) {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(current, (err) => {
            if (err) {
              const code = (err as any).code;
              const msg = (err.message || '').toLowerCase();
              if (code === 4 || msg.includes('exist') || msg.includes('failure')) {
                return resolve();
              }
              return reject(new Error(`Failed to create directory '${current}': ${err.message}`));
            }
            resolve();
          });
        });
      }
    }
  }

  /**
   * Delete a remote file
   */
  public async deleteFile(remotePath: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => {
        if (err) {
          return reject(new Error(`Failed to delete file '${remotePath}': ${err.message}`));
        }
        resolve();
      });
    });
  }

  /**
   * Delete a remote directory (optionally recursive)
   */
  public async rmdir(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getSftp();

    if (!recursive) {
      return new Promise((resolve, reject) => {
        sftp.rmdir(remotePath, (err) => {
          if (err) {
            return reject(new Error(`Failed to remove directory '${remotePath}': ${err.message}`));
          }
          resolve();
        });
      });
    }

    // Recursive directory removal
    const items = await this.listDir(remotePath);
    for (const item of items) {
      if (item.type === 'directory') {
        await this.rmdir(item.path, true);
      } else {
        await this.deleteFile(item.path);
      }
    }

    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => {
        if (err) {
          return reject(new Error(`Failed to remove root directory '${remotePath}': ${err.message}`));
        }
        resolve();
      });
    });
  }

  /**
   * Rename or move a remote file/directory
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          return reject(new Error(`Failed to rename '${oldPath}' to '${newPath}': ${err.message}`));
        }
        resolve();
      });
    });
  }

  /**
   * Change permissions of a remote path
   */
  public async chmod(remotePath: string, mode: number | string): Promise<void> {
    const sftp = await this.getSftp();
    const numericMode = typeof mode === 'string' ? parseInt(mode, 8) : mode;

    return new Promise((resolve, reject) => {
      sftp.chmod(remotePath, numericMode, (err) => {
        if (err) {
          return reject(new Error(`Failed to chmod '${remotePath}': ${err.message}`));
        }
        resolve();
      });
    });
  }
}
