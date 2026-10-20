import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ExercismCli } from '../cli/exercismCli';
import { promptJoinAndDownload } from '../commands/joinTrack';

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    withProgress: vi.fn(),
  },
  env: { openExternal: vi.fn() },
  Uri: { parse: (url: string) => url },
  ProgressLocation: { Notification: 1 },
}));

function cancellationSource() {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    token,
    cancel() {
      token.isCancellationRequested = true;
      for (const listener of listeners) { listener(); }
    },
  };
}

describe('join-track download workflow', () => {
  let source: ReturnType<typeof cancellationSource>;
  let cli: { getConfig: ReturnType<typeof vi.fn>; isTrackJoined: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> };
  let refresh: ReturnType<typeof vi.fn>;
  let onSuccess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    source = cancellationSource();
    cli = {
      getConfig: vi.fn().mockResolvedValue({ token: 'token' }),
      isTrackJoined: vi.fn().mockResolvedValue(true),
      download: vi.fn().mockResolvedValue('/workspace/go/hello-world'),
      clearCache: vi.fn(),
    };
    refresh = vi.fn();
    onSuccess = vi.fn();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Join Track on Exercism' as any);
    vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) => task({ report: vi.fn() }, source.token));
  });

  afterEach(() => { vi.useRealTimers(); });

  function run() {
    return promptJoinAndDownload(cli as unknown as ExercismCli, refresh, 'go', 'hello-world', onSuccess);
  }

  it('resumes the download and refreshes after joining', async () => {
    const result = run();
    await vi.advanceTimersByTimeAsync(2500);
    await result;
    expect(cli.download).toHaveBeenCalledWith('go', 'hello-world', source.token);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith('/workspace/go/hello-world');
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends immediately when cancelled during the poll delay', async () => {
    const result = run();
    await vi.advanceTimersByTimeAsync(1);
    source.cancel();
    await result;
    expect(cli.isTrackJoined).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates cancellation to an in-flight enrollment request', async () => {
    cli.isTrackJoined.mockImplementation((_track, _token, options) => new Promise(resolve => {
      options.cancellationToken.onCancellationRequested(() => resolve(false));
    }));
    const result = run();
    await vi.advanceTimersByTimeAsync(2500);
    source.cancel();
    await result;
    expect(cli.download).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('offers manual retry by 60 seconds even when enrollment requests stall', async () => {
    cli.isTrackJoined.mockImplementation((_track, _token, options) => new Promise(resolve => {
      setTimeout(() => resolve(false), Math.min(10000, options.timeoutMs));
    }));
    const result = run();
    await vi.advanceTimersByTimeAsync(60000);
    await result;
    expect(vscode.window.showInformationMessage).toHaveBeenCalledOnce();
    expect(cli.download).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not offer retry after cancelling the automatic download', async () => {
    cli.download.mockImplementation(async () => {
      source.cancel();
      throw new Error('Operation cancelled');
    });
    const result = run();
    await vi.advanceTimersByTimeAsync(2500);
    await result;
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not show an earlier download error after cancelling a manual retry', async () => {
    cli.download.mockRejectedValueOnce(new Error('Temporary network failure'));
    cli.download.mockImplementationOnce(async () => {
      source.cancel();
      throw new Error('Operation cancelled');
    });
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue('Download Now' as any);
    const result = run();
    await vi.advanceTimersByTimeAsync(2500);
    await result;
    expect(cli.download).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
