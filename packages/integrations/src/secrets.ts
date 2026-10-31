import { execFile, spawn } from 'node:child_process';

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** macOS Keychain. Values go over stdin so they never appear in a process listing. */
export class KeychainStore implements SecretStore {
  private service(name: string) {
    return `sak-${name}`;
  }

  get(name: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('security', ['find-generic-password', '-a', 'sak', '-s', this.service(name), '-w'], (error, stdout) => {
        resolve(error ? null : stdout.replace(/\n$/, ''));
      });
    });
  }

  set(name: string, value: string): Promise<void> {
    if (/[\r\n]/.test(value)) return Promise.reject(new Error('Secrets cannot contain line breaks'));
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Could not save to Keychain: ${stderr.trim() || code}`))));
      child.stdin.end(`add-generic-password -U -a sak -s ${quote(this.service(name))} -w ${quote(value)}\n`);
    });
  }

  delete(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('security', ['delete-generic-password', '-a', 'sak', '-s', this.service(name)], (error) => {
        // Exit code 44 means there was nothing to delete.
        if (error && error.code !== 44) reject(new Error(`Could not remove from Keychain: ${error.message}`));
        else resolve();
      });
    });
  }
}

export class MemoryStore implements SecretStore {
  values = new Map<string, string>();
  async get(name: string) {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}
