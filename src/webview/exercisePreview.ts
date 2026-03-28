import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { HLJSApi } from 'highlight.js';
import { Exercise } from '../models/exercise';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MarkdownIt = require('markdown-it') as typeof import('markdown-it');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hljs: HLJSApi = require('highlight.js').default ?? require('highlight.js');

type MdInstance = InstanceType<typeof MarkdownIt>;

export class ExercisePreviewPanel {
  private static currentPanel: ExercisePreviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _exercise: Exercise;
  private readonly _md: MdInstance;

  private constructor(
    panel: vscode.WebviewPanel,
    exercise: Exercise,
    extensionUri: vscode.Uri,
    md: MdInstance
  ) {
    this._panel = panel;
    this._exercise = exercise;
    this._extensionUri = extensionUri;
    this._md = md;

    this._panel.webview.html = this._getHtmlContent(this._panel.webview, exercise);

    this._panel.webview.onDidReceiveMessage((message: { command: string }) => {
      switch (message.command) {
        case 'runTests':
          vscode.commands.executeCommand('exercism.test', this._exercise);
          break;
        case 'submit':
          vscode.commands.executeCommand('exercism.submit', this._exercise);
          break;
        case 'openInBrowser':
          vscode.commands.executeCommand('exercism.openInBrowser', this._exercise);
          break;
      }
    });

    this._panel.onDidDispose(() => {
      ExercisePreviewPanel.currentPanel = undefined;
    });
  }

  static show(exercise: Exercise, extensionUri: vscode.Uri): ExercisePreviewPanel {
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      highlight: (str: string, lang: string): string => {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return (
              '<pre class="hljs"><code>' +
              hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
              '</code></pre>'
            );
          } catch {
            // fall through
          }
        }
        return (
          '<pre class="hljs"><code>' +
          md.utils.escapeHtml(str) +
          '</code></pre>'
        );
      }
    });

    if (ExercisePreviewPanel.currentPanel) {
      ExercisePreviewPanel.currentPanel._exercise = exercise;
      ExercisePreviewPanel.currentPanel._panel.title = `${exercise.name} - ${exercise.track}`;
      ExercisePreviewPanel.currentPanel._panel.webview.html =
        ExercisePreviewPanel.currentPanel._getHtmlContent(
          ExercisePreviewPanel.currentPanel._panel.webview,
          exercise
        );
      ExercisePreviewPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
      return ExercisePreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'exercismInstructions',
      `${exercise.name} - ${exercise.track}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui')],
        retainContextWhenHidden: false
      }
    );

    ExercisePreviewPanel.currentPanel = new ExercisePreviewPanel(panel, exercise, extensionUri, md);
    return ExercisePreviewPanel.currentPanel;
  }

  update(exercise: Exercise): void {
    this._exercise = exercise;
    this._panel.title = `${exercise.name} - ${exercise.track}`;
    this._panel.webview.html = this._getHtmlContent(this._panel.webview, exercise);
  }

  dispose(): void {
    this._panel.dispose();
  }

  private _readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private _getHtmlContent(webview: vscode.Webview, exercise: Exercise): string {
    const nonce = this._getNonce();

    const readmeContent = this._readFile(path.join(exercise.path, 'README.md'));
    const hintsContent = exercise.hasHints
      ? this._readFile(path.join(exercise.path, 'HINTS.md'))
      : undefined;
    const helpContent = exercise.hasHelp
      ? this._readFile(path.join(exercise.path, 'HELP.md'))
      : undefined;

    const readmeHtml = readmeContent
      ? this._md.render(readmeContent)
      : '<p><em>No README found for this exercise.</em></p>';

    const hintsHtml = hintsContent
      ? `<details class="collapsible-section">
          <summary>Hints</summary>
          <div class="collapsible-content">${this._md.render(hintsContent)}</div>
        </details>`
      : '';

    const helpHtml = helpContent
      ? `<details class="collapsible-section">
          <summary>Help</summary>
          <div class="collapsible-content">${this._md.render(helpContent)}</div>
        </details>`
      : '';

    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview-ui', 'styles.css')
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${stylesUri}">
  <title>${exercise.name} - ${exercise.track}</title>
</head>
<body>
  <div class="exercise-header">
    <h1 class="exercise-title">${exercise.name}</h1>
    <span class="exercise-track">${exercise.track}</span>
  </div>

  <div class="content">
    <div class="readme-content">
      ${readmeHtml}
    </div>
    ${hintsHtml}
    ${helpHtml}
  </div>

  <div class="action-bar">
    <button class="action-button primary" id="btn-run-tests">Run Tests</button>
    <button class="action-button" id="btn-submit">Submit</button>
    <button class="action-button secondary" id="btn-open-browser">Open in Browser</button>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();

      // Restore scroll position
      const state = vscode.getState() || {};
      if (state.scrollY) {
        window.scrollTo(0, state.scrollY);
      }

      // Save scroll position on scroll
      window.addEventListener('scroll', function() {
        vscode.setState({ scrollY: window.scrollY });
      });

      document.getElementById('btn-run-tests').addEventListener('click', function() {
        vscode.postMessage({ command: 'runTests' });
      });

      document.getElementById('btn-submit').addEventListener('click', function() {
        vscode.postMessage({ command: 'submit' });
      });

      document.getElementById('btn-open-browser').addEventListener('click', function() {
        vscode.postMessage({ command: 'openInBrowser' });
      });
    })();
  </script>
</body>
</html>`;
  }
}
