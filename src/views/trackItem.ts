import * as vscode from 'vscode';
import { Track } from '../models';

export class TrackItem extends vscode.TreeItem {
  constructor(public readonly track: Track) {
    super(
      `${track.name} (${track.exercises.length})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = 'track';
    this.iconPath = new vscode.ThemeIcon('symbol-folder');
  }
}
