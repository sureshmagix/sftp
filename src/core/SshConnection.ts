import { EventEmitter } from 'events';
import { Client as Ssh2Client, SFTPWrapper } from 'ssh2';
import { ConnectionStatus, SshConnectConfig } from '../types';

export class SshConnection extends EventEmitter {
  private client: Ssh2Client | null = null;
  private sftpWrapper: SFTPWrapper | null = null;
  private status: ConnectionStatus = 'disconnected';
  private config: SshConnectConfig | null = null;

  constructor() {
    super();
    // Default error listener to prevent uncaught 'error' event exceptions in Node.js
    this.on('error', (err) => {
      console.warn(`[SshConnection] Handled connection event error: ${err?.message || err}`);
    });
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public isConnected(): boolean {
    return this.status === 'connected' && this.client !== null;
  }

  private setStatus(newStatus: ConnectionStatus, error?: Error): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.emit('status-change', this.status, error);
    }
  }

  public async connect(config: SshConnectConfig): Promise<void> {
    if (this.isConnected()) {
      await this.disconnect();
    }

    this.config = config;
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const client = new Ssh2Client();
      let isSettled = false;

      client.on('ready', () => {
        if (!isSettled) {
          isSettled = true;
          this.client = client;
          this.setStatus('connected');
          this.emit('ready');
          resolve();
        }
      });

      client.on('banner', (message) => {
        this.emit('banner', message);
      });

      client.on('error', (err) => {
        this.setStatus('error', err);
        this.emit('error', err);
        if (!isSettled) {
          isSettled = true;
          reject(err);
        }
      });

      client.on('close', () => {
        this.client = null;
        this.sftpWrapper = null;
        this.setStatus('disconnected');
        this.emit('close');
        if (!isSettled) {
          isSettled = true;
          reject(new Error('SSH connection closed before handshake completed.'));
        }
      });

      client.on('end', () => {
        this.setStatus('disconnected');
        this.emit('end');
      });

      const fullConfig: Record<string, any> = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.readyTimeout || 20000,
        keepaliveInterval: config.keepaliveInterval || 10000,
      };

      if (config.password) {
        fullConfig.password = config.password;
      }

      if (config.privateKey) {
        fullConfig.privateKey = config.privateKey;
      }

      if (config.passphrase) {
        fullConfig.passphrase = config.passphrase;
      }

      if (config.algorithms) {
        fullConfig.algorithms = config.algorithms;
      }

      try {
        client.connect(fullConfig);
      } catch (err) {
        this.setStatus('error', err as Error);
        reject(err);
      }
    });
  }

  public async getSftp(): Promise<SFTPWrapper> {
    if (!this.client || !this.isConnected()) {
      throw new Error('SSH client is not connected');
    }

    if (this.sftpWrapper) {
      return this.sftpWrapper;
    }

    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        this.sftpWrapper = sftp;

        sftp.on('close', () => {
          this.sftpWrapper = null;
        });

        resolve(sftp);
      });
    });
  }

  public getRawClient(): Ssh2Client {
    if (!this.client || !this.isConnected()) {
      throw new Error('SSH client is not connected');
    }
    return this.client;
  }

  public async disconnect(): Promise<void> {
    if (this.sftpWrapper) {
      try {
        this.sftpWrapper.end();
      } catch (_) {}
      this.sftpWrapper = null;
    }

    if (this.client) {
      try {
        this.client.end();
      } catch (_) {}
      this.client = null;
    }

    this.setStatus('disconnected');
  }
}
