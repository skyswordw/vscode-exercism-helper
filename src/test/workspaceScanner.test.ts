import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fs and fs/promises before importing the module under test
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    Dirent: actual.Dirent,
  };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { WorkspaceScanner } from '../workspace/workspaceScanner';
import { ExerciseStatus } from '../models/exercise';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddir = vi.mocked(fsp.readdir);

function makeDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '',
    parentPath: '',
  } as unknown as fs.Dirent;
}

describe('WorkspaceScanner', () => {
  const WORKSPACE = '/home/user/exercism';
  let scanner: WorkspaceScanner;

  beforeEach(() => {
    vi.clearAllMocks();
    scanner = new WorkspaceScanner(async () => ({ workspace: WORKSPACE }));
  });

  describe('getWorkspacePath()', () => {
    it('returns undefined when no path can be resolved', async () => {
      // VS Code config returns undefined (default), CLI getter throws, ~/exercism does not exist
      mockExistsSync.mockReturnValue(false);
      const noCliScanner = new WorkspaceScanner(async () => { throw new Error('no cli'); });
      const result = await noCliScanner.getWorkspacePath();
      expect(result).toBeUndefined();
    });

    it('falls back to CLI config workspace when VS Code setting is empty', async () => {
      // existsSync returns true for the CLI workspace path
      mockExistsSync.mockImplementation((p: fs.PathLike) => p === WORKSPACE);
      const result = await scanner.getWorkspacePath();
      expect(result).toBe(WORKSPACE);
    });

    it('falls back to ~/exercism when CLI config throws', async () => {
      const homeExercism = path.join(require('os').homedir(), 'exercism');
      mockExistsSync.mockImplementation((p: fs.PathLike) => p === homeExercism);
      const noCliScanner = new WorkspaceScanner(async () => { throw new Error('no cli'); });
      const result = await noCliScanner.getWorkspacePath();
      expect(result).toBe(homeExercism);
    });
  });

  describe('scan()', () => {
    it('returns empty array when workspace path cannot be resolved', async () => {
      mockExistsSync.mockReturnValue(false);
      const noCliScanner = new WorkspaceScanner(async () => { throw new Error('no cli'); });
      const tracks = await noCliScanner.scan();
      expect(tracks).toEqual([]);
    });

    it('identifies tracks and exercises correctly', async () => {
      // Workspace path resolves via CLI config
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s === WORKSPACE) return true;
        if (s === `${WORKSPACE}/python/hello-world/.exercism/metadata.json`) return true;
        if (s === `${WORKSPACE}/python/hello-world/README.md`) return true;
        if (s === `${WORKSPACE}/python/hello-world/HINTS.md`) return false;
        return false;
      });

      mockReaddir
        .mockResolvedValueOnce([makeDirent('python', true)] as any)          // tracks
        .mockResolvedValueOnce([makeDirent('hello-world', true)] as any);    // exercises

      const tracks = await scanner.scan();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].slug).toBe('python');
      expect(tracks[0].exercises).toHaveLength(1);
      const ex = tracks[0].exercises[0];
      expect(ex.slug).toBe('hello-world');
      expect(ex.track).toBe('python');
      expect(ex.status).toBe(ExerciseStatus.Downloaded);
      expect(ex.hasReadme).toBe(true);
      expect(ex.hasHints).toBe(false);
    });

    it('skips directories without .exercism/metadata.json', async () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === WORKSPACE;
        // metadata.json never exists
      });

      mockReaddir
        .mockResolvedValueOnce([makeDirent('python', true)] as any)
        .mockResolvedValueOnce([makeDirent('not-an-exercise', true)] as any);

      const tracks = await scanner.scan();
      // Empty tracks are filtered out
      expect(tracks).toHaveLength(0);
    });

    it('skips non-directory entries at track level', async () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        if (s === WORKSPACE) return true;
        if (s === `${WORKSPACE}/python/hello-world/.exercism/metadata.json`) return true;
        if (s === `${WORKSPACE}/python/hello-world/README.md`) return true;
        return false;
      });

      mockReaddir.mockResolvedValueOnce([
        makeDirent('some-file.txt', false),
        makeDirent('python', true),
      ] as any).mockResolvedValueOnce([makeDirent('hello-world', true)] as any);

      const tracks = await scanner.scan();
      expect(tracks).toHaveLength(1);
      expect(tracks[0].slug).toBe('python');
    });

    it('returns empty array when readdir throws', async () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === WORKSPACE);
      mockReaddir.mockRejectedValueOnce(new Error('EACCES'));

      const tracks = await scanner.scan();
      expect(tracks).toEqual([]);
    });
  });
});
