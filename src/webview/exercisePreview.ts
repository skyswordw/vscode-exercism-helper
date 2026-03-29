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
// Static imports so esbuild can bundle them (dynamic require breaks in VSIX)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const langs: Record<string, any> = {
  bash: require('highlight.js/lib/languages/bash'),
  c: require('highlight.js/lib/languages/c'),
  clojure: require('highlight.js/lib/languages/clojure'),
  coffeescript: require('highlight.js/lib/languages/coffeescript'),
  coq: require('highlight.js/lib/languages/coq'),
  cpp: require('highlight.js/lib/languages/cpp'),
  crystal: require('highlight.js/lib/languages/crystal'),
  csharp: require('highlight.js/lib/languages/csharp'),
  d: require('highlight.js/lib/languages/d'),
  dart: require('highlight.js/lib/languages/dart'),
  delphi: require('highlight.js/lib/languages/delphi'),
  diff: require('highlight.js/lib/languages/diff'),
  elixir: require('highlight.js/lib/languages/elixir'),
  elm: require('highlight.js/lib/languages/elm'),
  erlang: require('highlight.js/lib/languages/erlang'),
  fortran: require('highlight.js/lib/languages/fortran'),
  fsharp: require('highlight.js/lib/languages/fsharp'),
  go: require('highlight.js/lib/languages/go'),
  groovy: require('highlight.js/lib/languages/groovy'),
  haskell: require('highlight.js/lib/languages/haskell'),
  java: require('highlight.js/lib/languages/java'),
  javascript: require('highlight.js/lib/languages/javascript'),
  json: require('highlight.js/lib/languages/json'),
  julia: require('highlight.js/lib/languages/julia'),
  kotlin: require('highlight.js/lib/languages/kotlin'),
  lisp: require('highlight.js/lib/languages/lisp'),
  lua: require('highlight.js/lib/languages/lua'),
  makefile: require('highlight.js/lib/languages/makefile'),
  mipsasm: require('highlight.js/lib/languages/mipsasm'),
  nim: require('highlight.js/lib/languages/nim'),
  objectivec: require('highlight.js/lib/languages/objectivec'),
  ocaml: require('highlight.js/lib/languages/ocaml'),
  perl: require('highlight.js/lib/languages/perl'),
  php: require('highlight.js/lib/languages/php'),
  plaintext: require('highlight.js/lib/languages/plaintext'),
  powershell: require('highlight.js/lib/languages/powershell'),
  prolog: require('highlight.js/lib/languages/prolog'),
  python: require('highlight.js/lib/languages/python'),
  r: require('highlight.js/lib/languages/r'),
  reasonml: require('highlight.js/lib/languages/reasonml'),
  ruby: require('highlight.js/lib/languages/ruby'),
  rust: require('highlight.js/lib/languages/rust'),
  scala: require('highlight.js/lib/languages/scala'),
  scheme: require('highlight.js/lib/languages/scheme'),
  shell: require('highlight.js/lib/languages/shell'),
  smalltalk: require('highlight.js/lib/languages/smalltalk'),
  sml: require('highlight.js/lib/languages/sml'),
  sql: require('highlight.js/lib/languages/sql'),
  swift: require('highlight.js/lib/languages/swift'),
  tcl: require('highlight.js/lib/languages/tcl'),
  typescript: require('highlight.js/lib/languages/typescript'),
  vbnet: require('highlight.js/lib/languages/vbnet'),
  vim: require('highlight.js/lib/languages/vim'),
  wasm: require('highlight.js/lib/languages/wasm'),
  wren: require('highlight.js/lib/languages/wren'),
  xml: require('highlight.js/lib/languages/xml'),
  x86asm: require('highlight.js/lib/languages/x86asm'),
  yaml: require('highlight.js/lib/languages/yaml'),
};
for (const [name, langDef] of Object.entries(langs)) {
  hljs.registerLanguage(name, langDef);
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
