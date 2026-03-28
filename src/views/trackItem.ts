import * as vscode from 'vscode';
import { Track, ExerciseStatus } from '../models';

export class TrackItem extends vscode.TreeItem {
  constructor(public readonly track: Track, collapsed = false) {
    // Count exercises that are started/completed/published (i.e., have progress)
    const doneCount = track.exercises.filter(e =>
      e.status === ExerciseStatus.Published ||
      e.status === ExerciseStatus.Completed ||
      e.status === ExerciseStatus.Started ||
      e.status === ExerciseStatus.Downloaded
    ).length;

    const total = track.totalExercises ?? track.exercises.length;
    const label = total > 0
      ? `${track.name} (${doneCount}/${total})`
      : `${track.name} (${track.exercises.length})`;

    super(
      label,
      collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = 'track';
    this.iconPath = new vscode.ThemeIcon('symbol-folder');
  }
}
