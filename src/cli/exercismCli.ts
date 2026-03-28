import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ExercismConfig {
  workspace: string;    // Absolute path to exercism workspace
  token: string;        // API token
  apiBaseUrl: string;   // API base URL
}

export interface TestResult {
  passed: boolean;      // Overall pass/fail
  output: string;       // Raw CLI stdout
  exitCode: number;     // Process exit code
}

export interface SubmitResult {
  success: boolean;
  url?: string;         // URL to the submitted solution on exercism.io
  output: string;       // Raw CLI stdout
}

export class ExercismCli {
  private get cliPath(): string {
    return vscode.workspace.getConfiguration('exercism').get<string>('cliPath', 'exercism');
  }

  private get timeout(): number {
    return vscode.workspace.getConfiguration('exercism').get<number>('cliTimeout', 60000);
  }

  private run(
    args: string[],
    options: { cwd?: string; token?: vscode.CancellationToken } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.cliPath,
        args,
        { cwd: options.cwd, timeout: this.timeout },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        }
      );

      if (options.token) {
        options.token.onCancellationRequested(() => {
          child.kill();
          reject(new Error('Operation cancelled'));
        });
      }
    });
  }

  async checkInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const { stdout } = await this.run(['version']);
      const version = stdout.trim();
      return { installed: true, version };
    } catch {
      return { installed: false };
    }
  }

  async getConfig(): Promise<ExercismConfig> {
    const { stdout } = await this.run(['configure']);

    const workspace = this.parseConfigField(stdout, 'Workspace');
    const token = this.parseConfigField(stdout, 'Token');
    const apiBaseUrl = this.parseConfigField(stdout, 'API Base URL');

    return { workspace, token, apiBaseUrl };
  }

  private parseConfigField(output: string, field: string): string {
    const match = output.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  }

  async download(
    track: string,
    exercise: string,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const { stdout } = await this.run(
      ['download', `--track=${track}`, `--exercise=${exercise}`],
      { token }
    );

    // The CLI prints something like: Downloaded to /path/to/exercism/python/hello-world
    const match = stdout.match(/Downloaded to\s+(.+)/);
    if (match) {
      return match[1].trim();
    }

    // Fallback: return the last non-empty line
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    return lines[lines.length - 1]?.trim() ?? '';
  }

  async test(
    exercisePath: string,
    token?: vscode.CancellationToken
  ): Promise<TestResult> {
    try {
      const { stdout } = await this.run(['test'], { cwd: exercisePath, token });
      return { passed: true, output: stdout, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & { stdout?: string; code?: number };
      const output = error.stdout ?? error.message ?? '';
      const exitCode = typeof error.code === 'number' ? error.code : 1;
      return { passed: false, output, exitCode };
    }
  }

  async submit(
    files: string[],
    token?: vscode.CancellationToken
  ): Promise<SubmitResult> {
    try {
      const { stdout } = await this.run(['submit', ...files], { token });

      // Parse the solution URL from output, e.g.:
      // Your solution has been submitted successfully.
      // https://exercism.org/tracks/python/exercises/hello-world/solutions/...
      const urlMatch = stdout.match(/https?:\/\/exercism\.\w+\/[^\s]+/);

      return {
        success: true,
        url: urlMatch ? urlMatch[0] : undefined,
        output: stdout,
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & { stdout?: string };
      const output = error.stdout ?? error.message ?? '';
      return { success: false, output };
    }
  }
}
