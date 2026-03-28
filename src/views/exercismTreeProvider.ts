import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceScanner, ScannedTrack, ScannedExercise } from '../workspace/workspaceScanner';
import { Track, Exercise, ExerciseStatus, slugToName } from '../models';
import { TrackItem } from './trackItem';
import { ExerciseItem } from './exerciseItem';

type TreeNode = TrackItem | ExerciseItem;

export class ExercismTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tracks: Track[] = [];

  constructor(private readonly scanner: WorkspaceScanner) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      this.tracks = await this.loadTracks();
      return this.tracks.map(t => new TrackItem(t));
    }

    if (element instanceof TrackItem) {
      return element.track.exercises.map(e => new ExerciseItem(e));
    }

    return [];
  }

  private async loadTracks(): Promise<Track[]> {
    const scannedTracks = await this.scanner.scan();
    return scannedTracks.map(st => this.toTrack(st));
  }

  private toTrack(scanned: ScannedTrack): Track {
    const exercises = scanned.exercises.map(se => this.toExercise(se));
    return {
      slug: scanned.slug,
      name: slugToName(scanned.slug),
      path: scanned.path,
      exercises,
    };
  }

  private toExercise(scanned: ScannedExercise): Exercise {
    const hasHelp = fs.existsSync(path.join(scanned.path, 'HELP.md'));
    return {
      slug: scanned.slug,
      name: slugToName(scanned.slug),
      track: scanned.track,
      path: scanned.path,
      status: scanned.status,
      hasReadme: scanned.hasReadme,
      hasHints: scanned.hasHints,
      hasHelp,
    };
  }
}
