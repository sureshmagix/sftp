import * as fs from 'fs';
import * as path from 'path';
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
    const cleanPath = remotePath || '.';

    return new Promise((resolve, reject) => {
      sftp.readdir(cleanPath, (err, list) => {
        if (err) {
          return reject(new Error(`Failed to list directory '${cleanPath}': ${err.message}`));
        }

        const items: FileItem[] = list.map((entry) => {
          const itemPath = path.posix.join(cleanPath, entry.filename);
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
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp();
    const stats = await fs.promises.stat(localPath);
    const totalSize = stats.size;

    return new Promise((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (totalTransferred, chunk, total) => {
            if (onProgress) {
              onProgress(totalTransferred, totalSize || total);
            }
          },
        },
        (err) => {
          if (err) {
            return reject(new Error(`Upload failed for '${localPath}' -> '${remotePath}': ${err.message}`));
          }
          if (onProgress && totalSize === 0) {
            onProgress(0, 0);
          }
          resolve();
        }
      );
    });
  }

  /**
   * Upload from a readable stream directly to remote path (used for browser folder/file uploads)
   */
  public async uploadStream(
    stream: NodeJS.ReadableStream,
    remotePath: string,
    totalSize?: number,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp();
    const dir = path.posix.dirname(remotePath);
    await this.mkdir(dir, true);

    return new Promise((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath);
      let transferred = 0;

      stream.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        if (onProgress) {
          onProgress(transferred, totalSize || transferred);
        }
      });

      stream.on('error', (err: any) => {
        reject(new Error(`Stream error during upload to '${remotePath}': ${err.message}`));
      });

      writeStream.on('error', (err: any) => {
        reject(new Error(`Write error for '${remotePath}': ${err.message}`));
      });

      writeStream.on('close', () => {
        if (onProgress && totalSize !== undefined) {
          onProgress(transferred, totalSize);
        }
        resolve();
      });

      stream.pipe(writeStream);
    });
  }

  /**
   * Read remote file content (up to maxBytes, default 2MB for text/preview)
   */
  public async readFile(remotePath: string, maxBytes: number = 2 * 1024 * 1024): Promise<Buffer> {
    const sftp = await this.getSftp();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const readStream = sftp.createReadStream(remotePath, { start: 0, end: maxBytes });

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
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp();
    const remoteStat = await this.stat(remotePath);
    const totalSize = remoteStat.size;

    // Ensure directory exists
    const dir = path.dirname(localPath);
    await fs.promises.mkdir(dir, { recursive: true });

    return new Promise((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (totalTransferred, chunk, total) => {
            if (onProgress) {
              onProgress(totalTransferred, totalSize || total);
            }
          },
        },
        (err) => {
          if (err) {
            return reject(new Error(`Download failed for '${remotePath}' -> '${localPath}': ${err.message}`));
          }
          if (onProgress && totalSize === 0) {
            onProgress(0, 0);
          }
          resolve();
        }
      );
    });
  }

  /**
   * Create remote directory
   */
  public async mkdir(remotePath: string, recursive: boolean = true): Promise<void> {
    const sftp = await this.getSftp();

    if (!recursive) {
      return new Promise((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err && (err as any).code !== 4) { // Ignore SSH_FX_FAILURE if already exists
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
            if (err && (err as any).code !== 4) {
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
