import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExercismCli, isTrackNotJoinedError } from '../cli/exercismCli';
import { EventEmitter } from 'events';

// Mock https
vi.mock('https', () => ({
  get: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import * as https from 'https';
import { execFile } from 'child_process';

const mockHttpsGet = vi.mocked(https.get);
const mockExecFile = vi.mocked(execFile);

function mockHttpsResponse(statusCode: number, data: string) {
  mockHttpsGet.mockImplementation((url: any, optionsOrCb: any, maybeCb?: any) => {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    const req = new EventEmitter() as any;
    req.on = vi.fn().mockReturnValue(req);

    const res = new EventEmitter() as any;
    res.statusCode = statusCode;
    res.resume = vi.fn();

    // Call callback synchronously, then emit data and end on next tick
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        res.emit('data', data);
        res.emit('end');
      });
    });

    return req;
  });
}

function mockStalledRequest(): Promise<AbortSignal> {
  return new Promise(resolve => {
    mockHttpsGet.mockImplementation((_url: any, options: any) => {
      const req = new EventEmitter() as any;
      options.signal.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true });
      resolve(options.signal);
      return req;
    });
  });
}

describe('ExercismCli', () => {
  let cli: ExercismCli;

  beforeEach(() => {
    vi.clearAllMocks();
    cli = new ExercismCli();
  });

  afterEach(() => { vi.useRealTimers(); });

  describe('fetchTracks()', () => {
    it('fetches tracks from api.exercism.org', async () => {
      mockHttpsResponse(200, JSON.stringify({
        tracks: [
          { slug: 'go', title: 'Go', num_exercises: 165 },
          { slug: 'rust', title: 'Rust', num_exercises: 120, is_joined: true },
        ],
      }));

      const tracks = await cli.fetchTracks();
      expect(tracks).toEqual([
        { slug: 'go', title: 'Go', numExercises: 165, isJoined: false },
        { slug: 'rust', title: 'Rust', numExercises: 120, isJoined: true },
      ]);

      expect(mockHttpsGet).toHaveBeenCalledWith(
        'https://api.exercism.org/v2/tracks',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': 'vscode-exercism-helper' }),
        }),
        expect.any(Function)
      );
    });

    it('includes authorization header when token is provided', async () => {
      mockHttpsResponse(200, JSON.stringify({
        tracks: [
          { slug: 'javascript', title: 'JavaScript', num_exercises: 159, is_joined: true },
        ],
      }));

      const tracks = await cli.fetchTracks('test-token');
      expect(tracks).toEqual([
        { slug: 'javascript', title: 'JavaScript', numExercises: 159, isJoined: true },
      ]);

      expect(mockHttpsGet).toHaveBeenCalledWith(
        'https://api.exercism.org/v2/tracks',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': 'vscode-exercism-helper',
            'Authorization': 'Bearer test-token',
          }),
        }),
        expect.any(Function)
      );
    });

    it.each([undefined, 500])('aborts a stalled request at its deadline (%s)', async (timeoutMs) => {
      vi.useFakeTimers();
      const signalReady = mockStalledRequest();
      const result = cli.fetchTracks('token', true, { timeoutMs });
      const rejected = expect(result).rejects.toThrow('aborted');
      const signal = await signalReady;
      await vi.advanceTimersByTimeAsync(timeoutMs ?? 10000);
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts an in-flight request on cancellation and disposes the listener', async () => {
      const signalReady = mockStalledRequest();
      let cancel!: () => void;
      const dispose = vi.fn();
      const cancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn((listener: () => void) => {
          cancel = listener;
          return { dispose };
        }),
      };
      const result = cli.fetchTracks('token', true, { cancellationToken });
      const rejected = expect(result).rejects.toThrow('aborted');
      const signal = await signalReady;
      cancellationToken.isCancellationRequested = true;
      cancel();
      await rejected;
      expect(signal.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('does not start a request when already cancelled', async () => {
      const cancellationToken = { isCancellationRequested: true, onCancellationRequested: vi.fn() };
      await expect(cli.fetchTracks('token', true, { cancellationToken })).rejects.toThrow('Operation cancelled');
      expect(mockHttpsGet).not.toHaveBeenCalled();
    });

    it('cleans up its deadline and listener after a successful response', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      mockHttpsResponse(200, JSON.stringify({ tracks: [] }));
      const dispose = vi.fn();
      const cancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn(() => ({ dispose })),
      };
      await cli.fetchTracks('token', true, { cancellationToken });
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects on HTTP error status', async () => {
      mockHttpsResponse(403, 'Forbidden');
      await expect(cli.fetchTracks()).rejects.toThrow('API returned HTTP 403');
    });
  });

  describe('isTrackJoined()', () => {
    it('returns true when track has is_joined true', async () => {
      mockHttpsResponse(200, JSON.stringify({
        tracks: [
          { slug: 'javascript', title: 'JavaScript', num_exercises: 159, is_joined: true },
        ],
      }));

      const joined = await cli.isTrackJoined('javascript', 'my-token');
      expect(joined).toBe(true);
    });

    it('returns false when track is not joined', async () => {
      mockHttpsResponse(200, JSON.stringify({
        tracks: [
          { slug: 'javascript', title: 'JavaScript', num_exercises: 159 },
        ],
      }));

      const joined = await cli.isTrackJoined('javascript', 'my-token');
      expect(joined).toBe(false);
    });
  });

  describe('fetchExercises()', () => {
    it('fetches exercises for track from api.exercism.org', async () => {
      mockHttpsResponse(200, JSON.stringify({
        exercises: [
          { slug: 'hello-world', title: 'Hello World', difficulty: 'easy', is_unlocked: true, is_recommended: true, type: 'tutorial', blurb: 'Classic hello world' },
        ],
      }));

      const exercises = await cli.fetchExercises('go');
      expect(exercises).toEqual([
        { slug: 'hello-world', title: 'Hello World', difficulty: 'easy', isUnlocked: true, isRecommended: true, type: 'tutorial', blurb: 'Classic hello world' },
      ]);

      expect(mockHttpsGet).toHaveBeenCalledWith(
        'https://api.exercism.org/v2/tracks/go/exercises',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': 'vscode-exercism-helper' }),
        }),
        expect.any(Function)
      );
    });
  });

  describe('download()', () => {
    it('parses download path from stdout', async () => {
      mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb(null, 'Downloaded to\n/home/user/exercism/go/hello-world\n', '');
        return {} as any;
      });

      const result = await cli.download('go', 'hello-world');
      expect(result).toBe('/home/user/exercism/go/hello-world');
    });
  });

  describe('isTrackNotJoinedError()', () => {
    it('detects "You have not joined this track" error', () => {
      const err = new Error('Command failed: exercism download --track=javascript --exercise=hello-world Error: You have not joined this track');
      expect(isTrackNotJoinedError(err)).toBe(true);
    });

    it('detects error from stderr property', () => {
      const err = Object.assign(new Error('Command failed'), { stderr: 'Error: You have not joined this track' });
      expect(isTrackNotJoinedError(err)).toBe(true);
    });

    it('returns false for other errors', () => {
      const err = new Error('Network timeout');
      expect(isTrackNotJoinedError(err)).toBe(false);
      expect(isTrackNotJoinedError(null)).toBe(false);
    });
  });
});
