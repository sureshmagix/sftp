import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { SftpWebServer } from '../ui/server';

let mainWindow: any = null;
let serverInstance: SftpWebServer | null = null;
const DEFAULT_PORT = 3000;

function getAppIconPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'src', 'ui', 'public', 'assets', 'logo.png'),
    path.join(__dirname, '..', 'ui', 'public', 'assets', 'logo.png'),
    path.join(process.resourcesPath || '', 'public', 'assets', 'logo.png'),
    path.join(process.cwd(), 'src', 'ui', 'public', 'assets', 'logo.png'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return path.join(__dirname, 'logo.png');
}

async function startServer(): Promise<number> {
  serverInstance = new SftpWebServer(DEFAULT_PORT);
  await serverInstance.start(false);
  return serverInstance.getPort();
}

async function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'SB SFTP Studio',
    icon: getAppIconPath(),
    backgroundColor: '#0a0d14',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler((details: { url: string }) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:')) {
      shell.openExternal(details.url);
    }
    return { action: 'deny' };
  });

  try {
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  } catch (err: any) {
    console.error(`Failed to load URL http://127.0.0.1:${port}:`, err.message);
  }

  mainWindow.show();
  mainWindow.focus();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    await createWindow(port);

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow(port);
      }
    });
  } catch (err) {
    console.error('Failed to initialize SB SFTP Studio Electron App:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (serverInstance) {
    await serverInstance.stop();
  }
});
