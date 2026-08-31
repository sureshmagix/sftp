import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import {
  SshConnection,
  SftpClientService,
  SshTerminalService,
  TransferManager,
  LocalFsService,
  SshConnectConfig,
} from '../index';

dotenv.config();

async function runDemo() {
  console.log('=====================================================');
  console.log('🚀 Raspberry Pi / Remote SSH & SFTP Engine Initialized');
  console.log('=====================================================\n');

  const localFs = new LocalFsService();
  const homeDir = localFs.getHomeDir();
  console.log(`📁 Local Home Directory: ${homeDir}`);

  const localItems = await localFs.listDir(process.cwd());
  console.log(`📂 Current Workspace Files (${localItems.length} items):`);
  localItems.slice(0, 5).forEach((item) => {
    console.log(`   - [${item.type.toUpperCase()}] ${item.name} (${item.size} bytes)`);
  });

  const host = process.env.SSH_HOST;
  const username = process.env.SSH_USER || process.env.SSH_USERNAME;
  const password = process.env.SSH_PASSWORD;
  const privateKeyPath = process.env.SSH_KEY_PATH;
  const port = process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22;

  if (!host || !username) {
    console.log('\n-----------------------------------------------------');
    console.log('💡 NOTE: Remote SSH connection parameters not detected in .env.');
    console.log('   To connect to your Raspberry Pi, create a .env file with:');
    console.log('   SSH_HOST=192.168.1.xxx (or raspberrypi.local)');
    console.log('   SSH_USER=pi');
    console.log('   SSH_PASSWORD=your_password (or SSH_KEY_PATH=/path/to/id_rsa)');
    console.log('-----------------------------------------------------\n');
    console.log('✅ Core Engine & Local FS test passed cleanly!');
    return;
  }

  console.log(`\n📡 Connecting to Raspberry Pi at ${username}@${host}:${port}...`);

  const connection = new SshConnection();
  const sftpService = new SftpClientService(connection);
  const terminalService = new SshTerminalService(connection);
  const transferManager = new TransferManager(sftpService, 2);

  // Monitor transfer progress
  transferManager.on('progress', (task) => {
    console.log(
      `   [${task.direction.toUpperCase()}] ${task.fileName} | ` +
      `${task.percentage}% (${task.transferredBytes}/${task.totalBytes} bytes) | ` +
      `Speed: ${task.speedFormatted} | ETA: ${task.etaFormatted} | Status: ${task.status}`
    );
  });

  try {
    let privateKey: Buffer | undefined = undefined;
    if (privateKeyPath && fs.existsSync(privateKeyPath)) {
      privateKey = fs.readFileSync(privateKeyPath);
    }

    const config: SshConnectConfig = {
      host,
      port,
      username,
      password,
      privateKey,
    };

    await connection.connect(config);
    console.log('✅ SSH Connection Established Successfully!\n');

    // 1. Remote Directory Listing
    console.log('📂 Remote Root/Home Directory Listing:');
    const remoteItems = await sftpService.listDir('.');
    remoteItems.slice(0, 10).forEach((item) => {
      console.log(`   ${item.permissions} ${item.name.padEnd(25)} ${item.size.toString().padStart(10)} bytes (${item.type})`);
    });

    // 2. Command Execution Test
    console.log('\n💻 Executing remote test command (uname -a && uptime)...');
    const execResult = await terminalService.exec('uname -a && uptime');
    console.log('   Stdout:', execResult.stdout.trim());

    // 3. File Transfer Test
    console.log('\n📤 Testing SFTP File Upload...');
    const testLocalFile = path.join(process.cwd(), 'package.json');
    const testRemoteFile = 'package_pi_test.json';

    const task = transferManager.enqueue({
      localPath: testLocalFile,
      remotePath: testRemoteFile,
      direction: 'upload',
    });

    await new Promise<void>((resolve) => {
      transferManager.on('task-completed', (t) => {
        if (t.id === task.id) {
          console.log(`✅ Upload Completed: ${t.fileName}`);
          resolve();
        }
      });
      transferManager.on('task-failed', (t) => {
        if (t.id === task.id) {
          console.log(`❌ Upload Failed: ${t.error}`);
          resolve();
        }
      });
    });

    // Clean up uploaded test file
    console.log(`\n🧹 Cleaning up remote test file (${testRemoteFile})...`);
    await sftpService.deleteFile(testRemoteFile);
    console.log('✅ Remote test file cleaned up!');

    await connection.disconnect();
    console.log('\n👋 Disconnected cleanly from SSH.');
  } catch (err: any) {
    console.error('❌ Connection / Execution Error:', err.message || err);
    await connection.disconnect().catch(() => {});
  }
}

runDemo();
