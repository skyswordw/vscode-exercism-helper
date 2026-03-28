import * as vscode from 'vscode';
import { Exercise, ExerciseStatus } from '../models';

export class ExerciseItem extends vscode.TreeItem {
  constructor(public readonly exercise: Exercise) {
    super(exercise.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'exercise';
    this.description = exercise.slug;

    if (exercise.status === ExerciseStatus.Downloaded) {
      this.iconPath = new vscode.ThemeIcon('tools');
    }

    this.command = {
      command: 'exercism.openInstructions',
      title: 'Open Instructions',
      arguments: [exercise],
    };
  }
}
