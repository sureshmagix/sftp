import { EventEmitter } from 'events';
import { ClientChannel } from 'ssh2';
import { SshConnection } from './SshConnection';
import { ExecResult } from '../types';

export class SshShellSession extends EventEmitter {
  constructor(private channel: ClientChannel) {
    super();

    this.channel.on('data', (data: Buffer) => {
      this.emit('data', data.toString('utf-8'));
    });

    this.channel.stderr.on('data', (data: Buffer) => {
      this.emit('data', data.toString('utf-8'));
    });

    this.channel.on('close', () => {
      this.emit('close');
    });

    this.channel.on('exit', (code: number, signal: string) => {
      this.emit('exit', code, signal);
    });
  }

  public write(data: string): void {
    this.channel.write(data);
  }

  public resize(rows: number, cols: number): void {
    this.channel.setWindow(rows, cols, 0, 0);
  }

  public close(): void {
    this.channel.end();
  }
}

export class SshTerminalService {
  constructor(private connection: SshConnection) {}

  /**
   * Execute a single SSH command non-interactively
   */
  public async exec(command: string, env?: Record<string, string>): Promise<ExecResult> {
    const rawClient = this.connection.getRawClient();

    return new Promise((resolve, reject) => {
      rawClient.exec(command, { env }, (err, stream) => {
        if (err) {
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString('utf-8');
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8');
        });

        stream.on('close', (code: number, signal: string) => {
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            signal,
          });
        });
      });
    });
  }

  /**
   * Spawn an interactive PTY shell (e.g. for terminal emulation in Electron xterm.js)
   */
  public async spawnShell(termType: string = 'xterm-256color', rows: number = 24, cols: number = 80): Promise<SshShellSession> {
    const rawClient = this.connection.getRawClient();

    return new Promise((resolve, reject) => {
      rawClient.shell(
        {
          term: termType,
          rows,
          cols,
        },
        (err, stream) => {
          if (err) {
            return reject(err);
          }
          const session = new SshShellSession(stream);
          resolve(session);
        }
      );
    });
  }
}
