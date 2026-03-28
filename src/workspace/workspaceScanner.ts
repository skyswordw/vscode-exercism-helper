import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ExerciseStatus } from '../models/exercise';

export interface ScannedExercise {
  slug: string;
  path: string;       // absolute path to exercise directory
  track: string;      // parent track slug
  status: ExerciseStatus;
  hasReadme: boolean;
  hasHints: boolean;
}

export interface ScannedTrack {
  slug: string;
  path: string;       // absolute path to track directory
  exercises: ScannedExercise[];
}

export class WorkspaceScanner {
  constructor(private cliConfigGetter: () => Promise<{ workspace: string }>) {}

  async getWorkspacePath(): Promise<string | undefined> {
    // 1. Check VS Code setting
    const config = vscode.workspace.getConfiguration('exercism');
    const configured = config.get<string>('workspacePath');
    if (configured && configured.trim() !== '') {
      const resolved = configured.trim();
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }

    // 2. Fall back to CLI config
    try {
      const cliConfig = await this.cliConfigGetter();
      if (cliConfig.workspace && cliConfig.workspace.trim() !== '') {
        const cliPath = cliConfig.workspace.trim();
        if (fs.existsSync(cliPath)) {
          return cliPath;
        }
      }
    } catch {
      // CLI not available — continue to fallback
    }

    // 3. Fallback to ~/exercism
    const fallback = path.join(os.homedir(), 'exercism');
    if (fs.existsSync(fallback)) {
      return fallback;
    }

    return undefined;
  }

  async scan(): Promise<ScannedTrack[]> {
    const workspacePath = await this.getWorkspacePath();
    if (!workspacePath) {
      return [];
    }

    let trackEntries: fs.Dirent[];
    try {
      trackEntries = await fsp.readdir(workspacePath, { withFileTypes: true });
    } catch {
      return [];
    }

    const tracks: ScannedTrack[] = [];

    for (const entry of trackEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const trackSlug = entry.name;
      const trackPath = path.join(workspacePath, trackSlug);

      let exerciseEntries: fs.Dirent[];
      try {
        exerciseEntries = await fsp.readdir(trackPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const exercises: ScannedExercise[] = [];

      for (const exEntry of exerciseEntries) {
        if (!exEntry.isDirectory()) {
          continue;
        }

        const exerciseSlug = exEntry.name;
        const exercisePath = path.join(trackPath, exerciseSlug);

        // Confirm it is an exercism exercise via metadata.json
        const metadataPath = path.join(exercisePath, '.exercism', 'metadata.json');
        if (!fs.existsSync(metadataPath)) {
          continue;
        }

        const hasReadme = fs.existsSync(path.join(exercisePath, 'README.md'));
        const hasHints = fs.existsSync(path.join(exercisePath, 'HINTS.md'));

        exercises.push({
          slug: exerciseSlug,
          path: exercisePath,
          track: trackSlug,
          status: ExerciseStatus.Downloaded,
          hasReadme,
          hasHints,
        });
      }

      if (exercises.length > 0) {
        tracks.push({
          slug: trackSlug,
          path: trackPath,
          exercises,
        });
      }
    }

    return tracks;
  }

  createWatcher(onChange: () => void): vscode.Disposable | undefined {
    // getWorkspacePath is async so we resolve it synchronously from settings
    // or fall back to ~/exercism for the watcher pattern.
    const config = vscode.workspace.getConfiguration('exercism');
    const configured = config.get<string>('workspacePath');
    const base =
      configured && configured.trim() !== ''
        ? configured.trim()
        : path.join(os.homedir(), 'exercism');

    // Watch for directory-level changes two levels deep (track/exercise)
    const pattern = new vscode.RelativePattern(base, '**/.exercism/metadata.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);

    return watcher;
  }
}
