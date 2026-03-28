import * as vscode from 'vscode';
import { Exercise, ExerciseStatus } from '../models';

export class ExerciseItem extends vscode.TreeItem {
  constructor(public readonly exercise: Exercise) {
    super(exercise.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = exercise.isDownloaded ? 'exercise' : 'exerciseRemote';

    // Description: #order slug [difficulty] ⭐next
    const parts: string[] = [];
    if (exercise.order !== undefined) { parts.push(`#${exercise.order + 1}`); }
    parts.push(exercise.slug);
    if (exercise.difficulty) { parts.push(`[${exercise.difficulty}]`); }
    if (exercise.isRecommended) { parts.push('⭐ next'); }
    this.description = parts.join(' ');

    // Recommended exercises get star icon regardless of status
    if (exercise.isRecommended) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
    } else {
      switch (exercise.status) {
        case ExerciseStatus.Published:
        case ExerciseStatus.Completed:
          this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
          break;
        case ExerciseStatus.Started:
        case ExerciseStatus.Downloaded:
          this.iconPath = new vscode.ThemeIcon('tools');
          break;
        case ExerciseStatus.Available:
          this.iconPath = new vscode.ThemeIcon('circle-outline');
          break;
        case ExerciseStatus.Locked:
          this.iconPath = new vscode.ThemeIcon('lock');
          break;
        default:
          this.iconPath = new vscode.ThemeIcon('circle-outline');
          break;
      }
    }

    if (exercise.isDownloaded) {
      // Downloaded: click opens instructions + solution file
      this.command = {
        command: 'exercism.openInstructions',
        title: 'Open Instructions',
        arguments: [exercise],
      };
    } else {
      // Not downloaded: click triggers download
      this.command = {
        command: 'exercism.downloadExercise',
        title: 'Download Exercise',
        arguments: [exercise],
      };
    }
  }
}
