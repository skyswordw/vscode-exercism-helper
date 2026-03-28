# Exercism Helper — VS Code Extension

## Project Overview
A VS Code extension that wraps the Exercism CLI to provide a seamless local learning experience: browse tracks/exercises in a sidebar Tree View, preview exercise instructions in a Webview, and run tests/submit solutions with one click.

## Tech Stack
- TypeScript, VS Code Extension API
- esbuild for bundling
- markdown-it + highlight.js for Webview rendering

## Architecture
- `src/cli/` — Exercism CLI wrapper (execFile-based, async)
- `src/workspace/` — Local workspace scanner (detects tracks/exercises)
- `src/models/` — Data models (Track, Exercise)
- `src/views/` — Tree View provider and tree items
- `src/webview/` — Webview panel for exercise instructions
- `src/extension.ts` — Entry point, command registration, wiring

## Conventions
- Use `vscode.workspace.getConfiguration('exercism')` for all settings
- CLI calls go through `ExercismCli` class only — never call child_process directly elsewhere
- Use `execFile` (not `exec`) to avoid shell injection
- All async operations support CancellationToken where applicable
- Tree View context values: `track` for track nodes, `exercise` for exercise nodes
- Webview uses singleton pattern — one panel reused for all exercises

## Commands
- Build: `npm run compile`
- Watch: `npm run watch`
- Lint: `npm run lint`
- Test: `npm test`
- Package: `npm run package`

## Design Spec
See `docs/superpowers/specs/2026-03-28-exercism-vscode-extension-design.md`
