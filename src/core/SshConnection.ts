import { EventEmitter } from 'events';
import { Client as Ssh2Client, SFTPWrapper } from 'ssh2';
import { createHash, timingSafeEqual } from 'crypto';
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
    if (this.client) {
      await this.disconnect();
    }

    this.config = config;
    this.setStatus('connecting');

    return new Promise((resolve, reject) => {
      const client = new Ssh2Client();
      this.client = client;
      let isSettled = false;
      let observedFingerprint = '';
      let fingerprintMatched = false;

      client.on('ready', () => {
        if (!isSettled) {
          isSettled = true;
          this.setStatus('connected');
          this.emit('ready');
          resolve();
        }
      });

      client.on('banner', (message) => {
        this.emit('banner', message);
      });

      client.on('error', (err) => {
        let connectionError = err;
        if (observedFingerprint && !config.hostFingerprint) {
          connectionError = new Error(
            `Host key verification required. Confirm the server fingerprint out-of-band, then enter: ${observedFingerprint}`
          ) as any;
        } else if (observedFingerprint && config.hostFingerprint && !fingerprintMatched) {
          connectionError = new Error(
            `Host key verification failed. Expected ${config.hostFingerprint}, received ${observedFingerprint}`
          ) as any;
        }

        this.setStatus('error', connectionError);
        this.emit('error', connectionError);
        if (!isSettled) {
          isSettled = true;
          reject(connectionError);
        }
      });

      client.on('close', () => {
        if (this.client === client) {
          this.client = null;
          this.sftpWrapper = null;
          this.setStatus('disconnected');
        }
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
        hostVerifier: (key: Buffer) => {
          observedFingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          if (!config.hostFingerprint) return false;
          fingerprintMatched = this.fingerprintsMatch(config.hostFingerprint, observedFingerprint);
          return fingerprintMatched;
        },
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
        isSettled = true;
        if (this.client === client) this.client = null;
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

  private fingerprintsMatch(expected: string, observed: string): boolean {
    const normalize = (value: string) => value.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
    const expectedBuffer = Buffer.from(normalize(expected));
    const observedBuffer = Buffer.from(normalize(observed));
    return expectedBuffer.length === observedBuffer.length && timingSafeEqual(expectedBuffer, observedBuffer);
  }
}
