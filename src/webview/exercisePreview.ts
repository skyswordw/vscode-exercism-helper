import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { HLJSApi } from 'highlight.js';
import { Exercise } from '../models/exercise';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MarkdownIt = require('markdown-it') as typeof import('markdown-it');

// Use highlight.js core + only Exercism track languages to keep bundle small
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hljs: HLJSApi = require('highlight.js/lib/core').default ?? require('highlight.js/lib/core');

// Register only languages used by Exercism tracks
const exercismLanguages: Record<string, string> = {
  bash: 'bash', c: 'c', clojure: 'clojure', coffeescript: 'coffeescript',
  coq: 'coq', cpp: 'cpp', crystal: 'crystal', csharp: 'csharp',
  d: 'd', dart: 'dart', delphi: 'delphi', elixir: 'elixir', elm: 'elm',
  erlang: 'erlang', fortran: 'fortran', fsharp: 'fsharp', go: 'go',
  groovy: 'groovy', haskell: 'haskell', java: 'java',
  javascript: 'javascript', julia: 'julia', kotlin: 'kotlin',
  lisp: 'lisp', lua: 'lua', mipsasm: 'mipsasm', nim: 'nim',
  objectivec: 'objectivec', ocaml: 'ocaml', perl: 'perl', php: 'php',
  powershell: 'powershell', prolog: 'prolog', python: 'python', r: 'r',
  reasonml: 'reasonml', ruby: 'ruby', rust: 'rust', scala: 'scala',
  scheme: 'scheme', smalltalk: 'smalltalk', sml: 'sml', swift: 'swift',
  tcl: 'tcl', typescript: 'typescript', vbnet: 'vbnet', vim: 'vim',
  wasm: 'wasm', wren: 'wren', x86asm: 'x86asm',
  // Common extras for code blocks in exercise READMEs
  json: 'json', xml: 'xml', yaml: 'yaml', sql: 'sql', shell: 'shell',
  makefile: 'makefile', plaintext: 'plaintext', diff: 'diff',
};
for (const [name, mod] of Object.entries(exercismLanguages)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  hljs.registerLanguage(name, require(`highlight.js/lib/languages/${mod}`));
}

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
        case 'copyInstructions': {
          // Copy README markdown content to clipboard for pasting into AI chat
          const readmePath = path.join(this._exercise.path, 'README.md');
          try {
            const content = fs.readFileSync(readmePath, 'utf8');
            vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Instructions copied to clipboard');
          } catch {
            vscode.window.showWarningMessage('Could not read README.md');
          }
          break;
        }
        case 'openReadmeFile': {
          // Open README.md as a regular editor file (can be dragged to Copilot/@-referenced)
          const readmePath = path.join(this._exercise.path, 'README.md');
          vscode.workspace.openTextDocument(readmePath).then(doc => {
            vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
          });
          break;
        }
      }
    });

    this._panel.onDidDispose(() => {
      ExercisePreviewPanel.currentPanel = undefined;
    });
  }

  static show(exercise: Exercise, extensionUri: vscode.Uri): ExercisePreviewPanel {
    const readerPosition = vscode.workspace.getConfiguration('exercism').get<string>('readerPosition', 'left');
    const webviewColumn = readerPosition === 'left' ? vscode.ViewColumn.One : vscode.ViewColumn.Beside;

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
      ExercisePreviewPanel.currentPanel._panel.reveal(webviewColumn);
      return ExercisePreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'exercismInstructions',
      `${exercise.name} - ${exercise.track}`,
      webviewColumn,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui')],
        retainContextWhenHidden: false
      }
    );

    ExercisePreviewPanel.currentPanel = new ExercisePreviewPanel(panel, exercise, extensionUri, md);
    return ExercisePreviewPanel.currentPanel;
  }

  static getCurrentExercise(): Exercise | undefined {
    return ExercisePreviewPanel.currentPanel?._exercise;
  }

  static dispose(): void {
    if (ExercisePreviewPanel.currentPanel) {
      ExercisePreviewPanel.currentPanel._panel.dispose();
    }
  }

  update(exercise: Exercise): void {
    this._exercise = exercise;
    this._panel.title = `${exercise.name} - ${exercise.track}`;
    this._panel.webview.html = this._getHtmlContent(this._panel.webview, exercise);
  }

  private _readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
  <title>${this._escapeHtml(exercise.name)} - ${this._escapeHtml(exercise.track)}</title>
</head>
<body>
  <div class="exercise-header">
    <h1 class="exercise-title">${this._escapeHtml(exercise.name)}</h1>
    <span class="exercise-track">${this._escapeHtml(exercise.track)}</span>
  </div>

  <div class="content">
    <div class="readme-content">
      ${readmeHtml}
    </div>
    ${hintsHtml}
    ${helpHtml}
  </div>

  <div class="action-bar">
    <button class="action-button primary" id="btn-run-tests">▶ Run Tests</button>
    <button class="action-button" id="btn-submit">⬆ Submit</button>
    <button class="action-button secondary" id="btn-copy">📋 Copy Instructions</button>
    <button class="action-button secondary" id="btn-open-file">📄 Open as File</button>
    <button class="action-button secondary" id="btn-open-browser">🌐 Browser</button>
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

      document.getElementById('btn-copy').addEventListener('click', function() {
        vscode.postMessage({ command: 'copyInstructions' });
      });

      document.getElementById('btn-open-file').addEventListener('click', function() {
        vscode.postMessage({ command: 'openReadmeFile' });
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
