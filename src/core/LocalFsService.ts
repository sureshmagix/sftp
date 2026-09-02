import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileItem, FileType } from '../types';

export class LocalFsService {
  public getUserHomeDir(): string {
    return os.homedir().replace(/\\/g, '/');
  }

  public getDownloadsDir(): string {
    const home = os.homedir();
    const downloads = path.join(home, 'Downloads').replace(/\\/g, '/');
    try {
      if (fs.existsSync(downloads)) {
        return downloads;
      }
    } catch (_) {}
    return home.replace(/\\/g, '/');
  }

  public getHomeDir(): string {
    return this.getDownloadsDir();
  }

  public getCommonDirectories(): { name: string; path: string; icon: string }[] {
    const home = os.homedir();
    const candidateDirs = [
      { name: 'Downloads', path: path.join(home, 'Downloads'), icon: 'fa-download' },
      { name: 'Desktop', path: path.join(home, 'Desktop'), icon: 'fa-desktop' },
      { name: 'Documents', path: path.join(home, 'Documents'), icon: 'fa-folder-open' },
      { name: 'Pictures', path: path.join(home, 'Pictures'), icon: 'fa-image' },
      { name: 'Home', path: home, icon: 'fa-house' },
    ];
    return candidateDirs
      .filter(d => {
        try {
          return fs.existsSync(d.path);
        } catch (_) {
          return false;
        }
      })
      .map(d => ({ ...d, path: d.path.replace(/\\/g, '/') }));
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
      if (!entry || entry.name === '.' || entry.name === '..') continue;
      const fullPath = cleanPath === '/'
        ? `/${entry.name}`
        : cleanPath.endsWith('/')
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
      } catch (_) {
        if (entry.isDirectory()) type = 'directory';
        else if (entry.isSymbolicLink()) type = 'symlink';
      }

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
