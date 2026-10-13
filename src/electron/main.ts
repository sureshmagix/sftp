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

async function startServer(): Promise<string> {
  serverInstance = new SftpWebServer(DEFAULT_PORT);
  await serverInstance.start(false);
  return serverInstance.getLaunchUrl();
}

async function createWindow(launchUrl: string) {
  const appOrigin = new URL(launchUrl).origin;
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'SB SFTP Studio v1.3.0',
    icon: getAppIconPath(),
    backgroundColor: '#0a0d14',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
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

  mainWindow.webContents.on('will-navigate', (event: any, navigationUrl: string) => {
    if (new URL(navigationUrl).origin !== appOrigin) {
      event.preventDefault();
      if (navigationUrl.startsWith('https://')) shell.openExternal(navigationUrl);
    }
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents: any, _permission: string, callback: (allowed: boolean) => void) => {
    callback(false);
  });

  try {
    await mainWindow.loadURL(launchUrl);
  } catch (err: any) {
    console.error(`Failed to load SB SFTP Studio:`, err.message);
  }

  mainWindow.show();
  mainWindow.focus();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    const launchUrl = await startServer();
    await createWindow(launchUrl);

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow(launchUrl);
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
