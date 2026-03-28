<p align="center">
  <img src="media/exercism-icon.svg" alt="Exercism Helper Logo" width="128" height="48">
</p>

<h1 align="center">Exercism Helper</h1>

<p align="center">
  Browse, download, test, and submit Exercism exercises without leaving VS Code.
</p>

<p align="center">
  <a href="https://github.com/skyswordw/vscode-exercism-helper">GitHub</a> ·
  <a href="https://exercism.org">Exercism</a>
</p>

---

## Features

- **Sidebar Tree View** — Browse all downloaded tracks and exercises in the Activity Bar
- **Exercise Instructions** — Preview exercise READMEs with syntax-highlighted code in a Webview panel
- **One-click Test Runner** — Run `exercism test` directly from the sidebar or command palette
- **Solution Submission** — Submit solutions to Exercism from within VS Code
- **Download Exercises** — Download exercises via the Exercism CLI without opening a terminal
- **Theme-aware UI** — Webview adapts to VS Code light, dark, and high-contrast themes

## Screenshots

_Screenshots coming soon._

## Requirements

- [Exercism CLI](https://exercism.org/docs/using/solving-exercises/working-locally) v3.3.0 or later
- VS Code 1.85.0 or later
- An Exercism account with a configured API token

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `exercism.workspacePath` | `""` | Custom Exercism workspace directory. Leave empty to auto-detect from CLI config. |
| `exercism.cliPath` | `"exercism"` | Path to the Exercism CLI binary. |
| `exercism.cliTimeout` | `60000` | CLI command timeout in milliseconds (minimum 5000). |

## Available Commands

| Command | Description |
|---|---|
| `Exercism: Configure` | Set workspace path and CLI settings |
| `Exercism: Download Exercise` | Download an exercise by track and slug |
| `Exercism: Run Tests` | Run tests for the selected exercise |
| `Exercism: Submit Solution` | Submit the selected exercise solution |
| `Exercism: View Instructions` | Open exercise instructions in a Webview panel |
| `Exercism: Open in Browser` | Open the exercise page on exercism.org |
| `Exercism: Refresh` | Refresh the sidebar tree |

## Quick Start

1. **Install the Exercism CLI** — follow the [official guide](https://exercism.org/docs/using/solving-exercises/working-locally)
2. **Configure your API token** — run `exercism configure --token=<your-token>` in a terminal
3. **Open the sidebar** — click the Exercism icon in the Activity Bar
4. **Download an exercise** — click the download icon or run `Exercism: Download Exercise`
5. **Start coding** — open the exercise file and use the sidebar to run tests and submit

## License

MIT
