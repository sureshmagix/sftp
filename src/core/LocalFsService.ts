import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileItem, FileType } from '../types';

export class LocalFsService {
  public getHomeDir(): string {
    const home = os.homedir().replace(/\\/g, '/');
    return home;
  }

  private normalizePath(p: string): string {
    if (!p) return this.getHomeDir();
    let norm = p.replace(/\\/g, '/');
    if (/^[a-zA-Z]:$/.test(norm)) {
      norm += '/';
    }
    return norm;
  }

  public async exists(targetPath: string): Promise<boolean> {
    const cleanPath = this.normalizePath(targetPath);
    try {
      await fs.promises.access(cleanPath);
      return true;
    } catch {
      return false;
    }
  }

  public async stat(targetPath: string): Promise<FileItem> {
    const cleanPath = this.normalizePath(targetPath);
    const stats = await fs.promises.stat(cleanPath);
    const name = path.basename(cleanPath) || cleanPath;
    let type: FileType = 'file';
    if (stats.isDirectory()) type = 'directory';
    else if (stats.isSymbolicLink()) type = 'symlink';

    return {
      name,
      path: cleanPath,
      size: stats.size,
      type,
      modifyTime: stats.mtime,
      accessTime: stats.atime,
      mode: stats.mode,
    };
  }

  public async listDir(targetPath: string): Promise<FileItem[]> {
    const cleanPath = this.normalizePath(targetPath);
    const entries = await fs.promises.readdir(cleanPath, { withFileTypes: true });

    const items: FileItem[] = [];

    for (const entry of entries) {
      const fullPath = cleanPath.endsWith('/')
        ? `${cleanPath}${entry.name}`
        : `${cleanPath}/${entry.name}`;
      let type: FileType = 'file';
      let size = 0;
      let mtime = new Date();

      try {
        const stats = await fs.promises.stat(fullPath);
        size = stats.size;
        mtime = stats.mtime;
        if (entry.isDirectory()) type = 'directory';
        else if (entry.isSymbolicLink()) type = 'symlink';
      } catch (_) {}

      items.push({
        name: entry.name,
        path: fullPath,
        size,
        type,
        modifyTime: mtime,
      });
    }

    items.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;
      const timeA = new Date(a.modifyTime || 0).getTime();
      const timeB = new Date(b.modifyTime || 0).getTime();
      if (timeB !== timeA) return timeB - timeA;
      return a.name.localeCompare(b.name);
    });

    return items;
  }

  public async mkdir(targetPath: string): Promise<void> {
    const cleanPath = this.normalizePath(targetPath);
    await fs.promises.mkdir(cleanPath, { recursive: true });
  }

  public async deleteFile(targetPath: string): Promise<void> {
    const cleanPath = this.normalizePath(targetPath);
    await fs.promises.unlink(cleanPath);
  }

  public async rmdir(targetPath: string, recursive: boolean = true): Promise<void> {
    const cleanPath = this.normalizePath(targetPath);
    await fs.promises.rm(cleanPath, { recursive, force: true });
  }
}
