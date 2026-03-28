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

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class ExercismCli {
  private _cache = new Map<string, CacheEntry<any>>();
  private _configCache: CacheEntry<ExercismConfig> | undefined;

  private getCached<T>(key: string): T | undefined {
    const entry = this._cache.get(key);
    if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
      return entry.data as T;
    }
    this._cache.delete(key);
    return undefined;
  }

  private setCache<T>(key: string, data: T): void {
    this._cache.set(key, { data, timestamp: Date.now() });
  }

  clearCache(): void {
    this._cache.clear();
    this._configCache = undefined;
  }
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
    if (this._configCache && Date.now() - this._configCache.timestamp < CACHE_TTL) {
      return this._configCache.data;
    }
    const { stdout, stderr } = await this.run(['configure']);
    // exercism configure outputs to stderr, not stdout
    const output = stdout || stderr;

    const workspace = this.parseConfigField(output, 'Workspace');
    const token = this.parseConfigField(output, 'Token');
    const apiBaseUrl = this.parseConfigField(output, 'API Base URL');

    const config = { workspace, token, apiBaseUrl };
    this._configCache = { data: config, timestamp: Date.now() };
    return config;
  }

  private parseConfigField(output: string, field: string): string {
    const match = output.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    if (!match) { return ''; }
    let value = match[1].trim();
    // CLI output may include flag hints like "(-w, --workspace)  /actual/path"
    // Strip the parenthesized flag description if present
    const parenMatch = value.match(/\(.*?\)\s+(.*)/);
    if (parenMatch) {
      value = parenMatch[1].trim();
    }
    return value;
  }

  async fetchTracks(): Promise<Array<{ slug: string; title: string; numExercises: number }>> {
    const cached = this.getCached<Array<{ slug: string; title: string; numExercises: number }>>('tracks');
    if (cached) { return cached; }
    const https = await import('https');
    return new Promise((resolve, reject) => {
      https.get('https://exercism.org/api/v2/tracks', (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const tracks = (json.tracks || []).map((t: any) => ({
              slug: t.slug,
              title: t.title,
              numExercises: t.num_exercises || 0,
            }));
            this.setCache('tracks', tracks);
            resolve(tracks);
          } catch { resolve([]); }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async fetchExercises(track: string, token?: string): Promise<Array<{ slug: string; title: string; difficulty: string; isUnlocked: boolean; isRecommended: boolean; type: string; blurb: string }>> {
    const cacheKey = `exercises:${track}:${token ? 'auth' : 'anon'}`;
    const cached = this.getCached<Array<{ slug: string; title: string; difficulty: string; isUnlocked: boolean; isRecommended: boolean; type: string; blurb: string }>>(cacheKey);
    if (cached) { return cached; }
    const https = await import('https');
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (token) { headers['Authorization'] = `Bearer ${token}`; }
      https.get(`https://exercism.org/api/v2/tracks/${track}/exercises`, { headers }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const exercises = (json.exercises || []).map((e: any) => ({
              slug: e.slug,
              title: e.title || e.slug,
              difficulty: e.difficulty || '',
              isUnlocked: e.is_unlocked ?? false,
              isRecommended: e.is_recommended ?? false,
              type: e.type || 'practice',
              blurb: e.blurb || '',
            }));
            this.setCache(cacheKey, exercises);
            resolve(exercises);
          } catch { resolve([]); }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async fetchUserSolutions(track: string, token: string): Promise<Map<string, string>> {
    const cacheKey = `solutions:${track}`;
    const cached = this.getCached<Map<string, string>>(cacheKey);
    if (cached) { return cached; }
    // GET https://exercism.org/api/v2/solutions?track_slug={track}&per_page=200
    // Header: Authorization: Bearer {token}
    // Returns a Map of exercise slug -> status (published/completed/started/iterated)
    const https = await import('https');
    return new Promise((resolve) => {
      const url = `https://exercism.org/api/v2/solutions?track_slug=${encodeURIComponent(track)}&per_page=200`;
      const options = {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      };
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const solutionMap = new Map<string, string>();
            for (const solution of (json.results || [])) {
              // Extract exercise slug from private_url like:
              // https://exercism.org/tracks/python/exercises/hello-world/solutions/...
              // or use solution.exercise?.slug if available
              let slug: string | undefined;
              if (solution.exercise?.slug) {
                slug = solution.exercise.slug;
              } else if (solution.private_url) {
                const match = (solution.private_url as string).match(/\/exercises\/([^/]+)/);
                if (match) { slug = match[1]; }
              }
              if (slug && solution.status) {
                solutionMap.set(slug, solution.status);
              }
            }
            this.setCache(cacheKey, solutionMap);
            resolve(solutionMap);
          } catch { resolve(new Map()); }
        });
        res.on('error', () => resolve(new Map()));
      }).on('error', () => resolve(new Map()));
    });
  }

  async configure(token: string): Promise<void> {
    await this.run(['configure', '--token', token]);
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
      const { stdout, stderr } = await this.run(['test'], { cwd: exercisePath, token });
      // exercism test outputs to both stdout and stderr
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return { passed: true, output, exitCode: 0 };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
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
