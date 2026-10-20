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
const API_BASE_URL = 'https://api.exercism.org';
const API_TIMEOUT_MS = 10000;

interface TrackRequestOptions {
  cancellationToken?: vscode.CancellationToken;
  timeoutMs?: number;
}

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

  async fetchTracks(token?: string, bypassCache = false, requestOptions: TrackRequestOptions = {}): Promise<Array<{ slug: string; title: string; numExercises: number; isJoined?: boolean }>> {
    const cacheKey = `tracks:${token ? 'auth' : 'anon'}`;
    if (!bypassCache) {
      const cached = this.getCached<Array<{ slug: string; title: string; numExercises: number; isJoined?: boolean }>>(cacheKey);
      if (cached) { return cached; }
    }
    const https = await import('https');
    if (requestOptions.cancellationToken?.isCancellationRequested) {
      throw new Error('Operation cancelled');
    }
    const controller = new AbortController();
    const cancellation = requestOptions.cancellationToken?.onCancellationRequested(() => controller.abort());
    // Bound the entire request, including DNS, connection setup and response body.
    const timer = setTimeout(() => controller.abort(), Math.min(requestOptions.timeoutMs ?? API_TIMEOUT_MS, API_TIMEOUT_MS));
    return new Promise<Array<{ slug: string; title: string; numExercises: number; isJoined?: boolean }>>((resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'vscode-exercism-helper',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const options = { headers, signal: controller.signal };
      https.get(`${API_BASE_URL}/v2/tracks`, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`API returned HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const tracks = (json.tracks || []).map((t: any) => ({
              slug: t.slug,
              title: t.title,
              numExercises: t.num_exercises || 0,
              isJoined: Boolean(t.is_joined),
            }));
            this.setCache(cacheKey, tracks);
            resolve(tracks);
          } catch (err) { reject(err); }
        });
        res.on('error', reject);
      }).on('error', reject);
    }).finally(() => {
      clearTimeout(timer);
      cancellation?.dispose();
    });
  }

  async isTrackJoined(track: string, token: string, requestOptions: TrackRequestOptions = {}): Promise<boolean> {
    try {
      const tracks = await this.fetchTracks(token, true, requestOptions);
      const found = tracks.find(t => t.slug === track);
      return Boolean(found?.isJoined);
    } catch {
      return false;
    }
  }

  async fetchExercises(track: string, token?: string): Promise<Array<{ slug: string; title: string; difficulty: string; isUnlocked: boolean; isRecommended: boolean; type: string; blurb: string }>> {
    const cacheKey = `exercises:${track}:${token ? 'auth' : 'anon'}`;
    const cached = this.getCached<Array<{ slug: string; title: string; difficulty: string; isUnlocked: boolean; isRecommended: boolean; type: string; blurb: string }>>(cacheKey);
    if (cached) { return cached; }
    const https = await import('https');
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'vscode-exercism-helper',
      };
      if (token) { headers['Authorization'] = `Bearer ${token}`; }
      https.get(`${API_BASE_URL}/v2/tracks/${encodeURIComponent(track)}/exercises`, { headers }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`API returned HTTP ${res.statusCode}`));
          return;
        }
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
          } catch (err) { reject(err); }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  async fetchUserSolutions(track: string, token: string): Promise<Map<string, string>> {
    const cacheKey = `solutions:${track}`;
    const cached = this.getCached<Map<string, string>>(cacheKey);
    if (cached) { return cached; }
    // GET https://api.exercism.org/v2/solutions?track_slug={track}&per_page=200
    // Header: Authorization: Bearer {token}
    // Returns a Map of exercise slug -> status (published/completed/started/iterated)
    const https = await import('https');
    return new Promise((resolve) => {
      const url = `${API_BASE_URL}/v2/solutions?track_slug=${encodeURIComponent(track)}&per_page=200`;
      const options = {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'vscode-exercism-helper',
        },
      };
      https.get(url, options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          resolve(new Map());
          return;
        }
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

export function isTrackNotJoinedError(err: unknown): boolean {
  if (!err) { return false; }
  const message = err instanceof Error ? err.message : String(err);
  const stdout = typeof (err as any)?.stdout === 'string' ? (err as any).stdout : '';
  const stderr = typeof (err as any)?.stderr === 'string' ? (err as any).stderr : '';
  const combined = `${message} ${stdout} ${stderr}`;
  return /not joined this track|track_not_joined/i.test(combined);
}
