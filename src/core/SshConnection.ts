import { EventEmitter } from 'events';
import { Client as Ssh2Client, SFTPWrapper } from 'ssh2';
import { createHash, timingSafeEqual } from 'crypto';
import { ConnectionStatus, SshConnectConfig } from '../types';

export class SshConnection extends EventEmitter {
  private client: Ssh2Client | null = null;
  private sftpWrapper: SFTPWrapper | null = null;
  private status: ConnectionStatus = 'disconnected';
  private config: SshConnectConfig | null = null;
  private isManualDisconnect: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 3;

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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (this.status !== 'connected' || !this.client) return;
      try {
        if (this.sftpWrapper) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Heartbeat timeout')), 7000);
            this.sftpWrapper!.realpath('.', (err) => {
              clearTimeout(timeout);
              if (err) reject(err);
              else resolve();
            });
          });
        }
      } catch (err: any) {
        console.warn(`[SshConnection] Idle heartbeat ping failed: ${err?.message || err}`);
        if (this.client && !this.isManualDisconnect && this.status === 'connected') {
          try {
            this.client.end();
          } catch (_) {}
        }
      }
    }, 20000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private triggerAutoReconnect(): void {
    if (this.isManualDisconnect || !this.config || this.status === 'reconnecting') return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus('disconnected');
      return;
    }

    this.reconnectAttempts++;
    this.setStatus('reconnecting');
    const delay = Math.min(10000, 2000 * Math.pow(2, this.reconnectAttempts - 1));
    console.log(`[SshConnection] Connection lost while idle. Attempting auto-reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isManualDisconnect || !this.config) return;
      try {
        await this.connect(this.config);
        console.log('[SshConnection] Auto-reconnect succeeded.');
      } catch (err: any) {
        console.warn(`[SshConnection] Auto-reconnect attempt ${this.reconnectAttempts} failed: ${err.message}`);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.triggerAutoReconnect();
        } else {
          this.setStatus('disconnected', err);
        }
      }
    }, delay);
  }

  public async connect(config: SshConnectConfig): Promise<void> {
    if (this.client) {
      await this.disconnect();
    }

    this.isManualDisconnect = false;
    this.config = config;
    if (this.status !== 'reconnecting') {
      this.setStatus('connecting');
    }

    return new Promise((resolve, reject) => {
      const client = new Ssh2Client();
      this.client = client;
      let isSettled = false;
      let observedFingerprint = '';
      let fingerprintMatched = false;

      client.on('ready', () => {
        if (!isSettled) {
          isSettled = true;
          this.reconnectAttempts = 0;
          this.setStatus('connected');
          this.startHeartbeat();
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

        this.stopHeartbeat();
        this.setStatus('error', connectionError);
        this.emit('error', connectionError);
        if (!isSettled) {
          isSettled = true;
          reject(connectionError);
        }
      });

      client.on('close', () => {
        const wasConnected = this.status === 'connected';
        this.stopHeartbeat();
        if (this.client === client) {
          this.client = null;
          this.sftpWrapper = null;
        }
        this.emit('close');
        if (!isSettled) {
          isSettled = true;
          this.setStatus('disconnected');
          reject(new Error('SSH connection closed before handshake completed.'));
        } else if (wasConnected && !this.isManualDisconnect) {
          this.triggerAutoReconnect();
        } else {
          this.setStatus('disconnected');
        }
      });

      client.on('end', () => {
        this.stopHeartbeat();
        if (!this.isManualDisconnect && this.status === 'connected') {
          this.triggerAutoReconnect();
        } else {
          this.setStatus('disconnected');
        }
        this.emit('end');
      });

      const fullConfig: Record<string, any> = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.readyTimeout || 20000,
        keepaliveInterval: config.keepaliveInterval || 10000,
        keepaliveCountMax: 5,
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
        this.stopHeartbeat();
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
    this.isManualDisconnect = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
