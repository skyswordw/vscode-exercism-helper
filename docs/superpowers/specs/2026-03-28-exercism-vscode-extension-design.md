# Exercism VS Code Extension — Design Spec

## Context

The original Exercism VS Code extension (masonliu/exercism, v1.17.0) has not been updated since April 2020, and its GitHub source is now 404. Users learning Exercism locally with VS Code face four pain points:

1. **Constant browser/editor switching** — reading exercise instructions on exercism.io, coding in VS Code
2. **Inconvenient test running** — manually typing test commands each time
3. **Disorganized exercise management** — no clear view of which exercises are completed, in-progress, or not started
4. **No instruction preview** — must open browser or raw Markdown to read exercise descriptions

This spec defines a full-featured replacement extension that solves all four pain points.

## Goals

- Provide a seamless local Exercism learning experience entirely within VS Code
- Wrap the official Exercism CLI (no direct API dependency) for stability and reliability
- Support all language tracks without hard-coding track-specific logic
- Publish to both VS Code Marketplace and Open VSX

## Non-Goals

- Replacing the Exercism website for community features (mentoring, discussions)
- Auto-syncing progress with exercism.io (the platform lacks a public API for this)
- Implementing a custom test runner per language (we delegate to `exercism test`)

---

## Architecture

### Project Structure

```
exercism-vs-ext/
├── src/
│   ├── extension.ts              # Entry point: register commands, views, providers
│   ├── cli/
│   │   └── exercismCli.ts        # CLI wrapper (download/submit/test/configure)
│   ├── views/
│   │   ├── trackTreeProvider.ts   # TreeDataProvider for sidebar
│   │   ├── trackTreeItem.ts       # Track node (e.g., "python")
│   │   └── exerciseTreeItem.ts    # Exercise node with status icon
│   ├── webview/
│   │   └── exercisePreview.ts     # Webview panel for rendering instructions
│   ├── workspace/
│   │   └── workspaceScanner.ts    # Scan local exercism directory
│   └── models/
│       ├── track.ts               # Track data model
│       └── exercise.ts            # Exercise data model
├── media/                         # Icons (track logos, status icons)
├── webview-ui/                    # Webview HTML/CSS templates
│   ├── exercise.html              # Exercise instruction template
│   └── styles.css                 # Theme-aware styles
├── package.json                   # Extension manifest
├── tsconfig.json
├── esbuild.config.js              # Bundle configuration
└── .vscodeignore
```

### Data Flow

```
User action (click/command)
       │
       ▼
  extension.ts (command handler)
       │
       ├──► cli/exercismCli.ts ──► child_process.execFile("exercism", [...args])
       │         │
       │         ▼
       │    Parse CLI output (stdout/stderr)
       │
       ├──► workspace/workspaceScanner.ts ──► fs.readdir(workspacePath)
       │         │
       │         ▼
       │    Build Track[] and Exercise[] models
       │
       ├──► views/trackTreeProvider.ts ──► vscode.TreeDataProvider
       │         │
       │         ▼
       │    Sidebar Tree View (refresh on changes)
       │
       └──► webview/exercisePreview.ts ──► vscode.WebviewPanel
                  │
                  ▼
             Render Markdown (README.md, HINTS.md, HELP.md)
```

---

## Component Details

### 1. CLI Wrapper (`cli/exercismCli.ts`)

Wraps the Exercism CLI binary. All calls are async via `child_process.execFile`.

```typescript
interface ExercismConfig {
  workspace: string;    // Absolute path to exercism workspace
  token: string;        // API token
  apiBaseUrl: string;   // API base URL
}

interface TestResult {
  passed: boolean;      // Overall pass/fail
  output: string;       // Raw CLI stdout
  exitCode: number;     // Process exit code
}

interface SubmitResult {
  success: boolean;
  url?: string;         // URL to the submitted solution on exercism.io
  output: string;       // Raw CLI stdout
}

class ExercismCli {
  // CLI binary path read from `exercism.cliPath` setting (default: "exercism")

  async checkInstalled(): Promise<{installed: boolean; version?: string}>
  async getConfig(): Promise<ExercismConfig>
  async download(track: string, exercise: string): Promise<string>
  async test(exercisePath: string): Promise<TestResult>  // calls `exercism test` (v3.3.0+)
  async submit(files: string[]): Promise<SubmitResult>
}
```

**Key decisions:**
- Uses `execFile` (not `exec`) to avoid shell injection
- CLI binary path read from `exercism.cliPath` setting (default: `"exercism"`)
- Default timeout: 60 seconds, configurable via `exercism.cliTimeout` setting
- Supports `CancellationToken` — long-running commands (download/test) can be cancelled via VS Code progress UI
- If CLI is not found, show an error notification with an "Install" button linking to https://exercism.org/docs/using/solving-exercises/working-locally
- Test output captured from stdout and displayed in a dedicated Output Channel named "Exercism"
- `exercism test` is available since CLI v3.3.0; it delegates to the track-specific test runner (e.g., pytest, go test, npm test) automatically

### 2. Workspace Scanner (`workspace/workspaceScanner.ts`)

Scans the local exercism directory to build the track/exercise tree.

**Workspace path resolution (priority order):**
1. `exercism.workspacePath` setting in VS Code (user-configured)
2. Output of `exercism configure` CLI command (reads CLI's saved config)
3. Fallback to `~/exercism/`

**Scanning logic:**
- Top-level directories = tracks (e.g., `python/`, `javascript/`)
- Subdirectories = exercises (e.g., `python/hello-world/`)
- Exercise status detection (two states only — no "completed" status since we cannot reliably detect submission without API):
  - Directory exists with `.exercism/metadata.json` → **downloaded** (shown as in-progress)
  - Directory does not exist → **not downloaded**
  - Future: if Exercism adds a local submission marker, we can add a "completed" state

**Path validation:**
- If configured path does not exist → show warning with "Open Settings" button
- If path exists but contains no track directories → show info message suggesting to download exercises
- If path changes at runtime (settings change event) → re-scan and refresh Tree View

**File watching:**
- Uses `vscode.FileSystemWatcher` scoped to the exercism workspace path (NOT the VS Code workspace root)
- Watches for directory create/delete to detect new downloads
- Triggers Tree View refresh on changes

### 3. Sidebar Tree View (`views/`)

Registers a `TreeView` in the Activity Bar with an Exercism icon.

**Tree structure:**
```
Exercism
├── python (3 exercises)
│   ├── ✅ hello-world
│   ├── 🔧 leap
│   └── 🔧 isogram
├── javascript (1 exercise)
│   └── ✅ hello-world
└── go (2 exercises)
    ├── 🔧 hello-world
    └── 🔧 two-fer
```

**Node types:**
- **Track node:** Collapsible, shows track name and exercise count, uses track icon if available
- **Exercise node:** Leaf, shows exercise name with status icon, click opens instructions

**Status icons (ThemeIcon):**
- `$(tools)` — downloaded / in-progress (local files exist)
- `$(cloud-download)` — not downloaded (shown only if we add browse-catalog feature later)

**Context menu (right-click):**
- Run Tests (`when: exerciseExists`)
- Submit Solution (`when: exerciseExists`)
- Download Exercise (`when: !exerciseExists`)
- Open Instructions
- Open in Browser

**Inline buttons (on hover):**
- ▶ Run Tests (on exercise nodes)
- 📖 Open Instructions (on exercise nodes)

### 4. Webview Preview (`webview/exercisePreview.ts`)

Opens a Webview panel in the editor area to render exercise documentation.

**Content:**
- Title bar: exercise name + track name
- Main content: rendered `README.md`
- Collapsible sections for `HINTS.md` and `HELP.md` (if they exist)
- Action buttons at the bottom: Run Tests / Submit / Open in Browser

**Technical implementation:**
- Markdown rendering: `markdown-it` library
- Code syntax highlighting: `highlight.js`
- Theme-aware: reads VS Code's current theme (light/dark/high-contrast) and adapts CSS
- Security: `localResourceRoots` restricted to webview-ui directory

**Webview persistence:**
- Uses `getState`/`setState` Webview API to save and restore scroll position (avoids the memory cost of `retainContextWhenHidden`)
- Panel is reused (singleton) — opening a new exercise replaces the current panel content

### 5. Commands

| Command ID | Title | Keybinding | Context |
|---|---|---|---|
| `exercism.configure` | Exercism: Configure | — | Always |
| `exercism.download` | Exercism: Download Exercise | — | Always |
| `exercism.test` | Exercism: Run Tests | — | When in exercism workspace |
| `exercism.submit` | Exercism: Submit Solution | — | When in exercism workspace |
| `exercism.openInstructions` | Exercism: View Instructions | — | When in exercism workspace |
| `exercism.openInBrowser` | Exercism: Open in Browser | — | When in exercism workspace |
| `exercism.refreshTree` | Exercism: Refresh | — | Always |

### 6. Command UX Flows

**`exercism.download`:**
1. Show QuickPick with track list (scanned from workspace or user-typed)
2. User selects/types a track slug (e.g., "python")
3. Show InputBox for exercise slug (e.g., "hello-world")
4. Run `exercism download --track=<track> --exercise=<exercise>` with progress indicator
5. On success: refresh Tree View, open the exercise instructions in Webview

**`exercism.configure`:**
1. Show InputBox prompting for API token (with "Get Token" button linking to exercism.io settings)
2. Run `exercism configure --token=<token>`
3. If workspace path differs from default, prompt to also set `exercism.workspacePath` in settings
4. Show success notification

**`exercism.test` / `exercism.submit`:**
1. Detect current exercise from: active editor file path → find parent `.exercism/metadata.json`
2. If no exercise detected, show QuickPick of downloaded exercises
3. Run command with VS Code progress notification (cancellable)
4. Display result in Output Channel; show success/failure notification

### 7. Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `exercism.workspacePath` | string | `""` | Custom exercism workspace path. Empty = auto-detect from CLI config. |
| `exercism.cliPath` | string | `"exercism"` | Path to exercism CLI binary. |
| `exercism.cliTimeout` | number | `60000` | CLI command timeout in milliseconds. |

### 8. Activation Events

```json
{
  "activationEvents": [
    "onView:exercismExplorer",
    "workspaceContains:**/.exercism/metadata.json"
  ]
}
```

The extension activates when:
- User opens the Exercism sidebar view
- A workspace folder contains an exercism exercise (detected by `.exercism/metadata.json`)

---

## Error Handling

| Scenario | Behavior |
|---|---|
| CLI not installed | Error notification with "Install Exercism CLI" button → opens install docs |
| CLI not configured (no token) | Prompt to run `exercism.configure` |
| Workspace path not found | Warning + prompt to configure path in settings |
| Test command fails | Show error in Output Channel, notification with "Show Output" button |
| Network error on download | Error notification with retry option |
| Exercise directory missing | Remove from tree, show notification |

---

## Technology Choices

| Choice | Rationale |
|---|---|
| TypeScript | Standard for VS Code extensions, type safety |
| esbuild | Fast bundling, simpler than webpack for extensions |
| markdown-it | Lightweight, extensible Markdown parser |
| highlight.js | Broad language support for code blocks in instructions |
| child_process.execFile | Secure CLI invocation without shell |

---

## Publishing

- **Package name:** `exercism-helper` (avoid namespace conflict with official exercism publisher)
- **Publisher:** To be created on VS Code Marketplace and Open VSX
- **Targets:** VS Code Marketplace + Open VSX Registry
- **Minimum VS Code version:** 1.85.0 (for recent API features)
- **License:** MIT
- **Telemetry:** None. The extension does not collect or send any telemetry data.
- **CI:** GitHub Actions for build, test, and publish

---

## Verification Plan

1. **Unit tests:** Test CLI wrapper parsing, workspace scanner logic, model construction
2. **Integration tests:** Test commands execute correctly with mock CLI
3. **Manual testing:**
   - Install extension in VS Code
   - Configure workspace path to custom location
   - Verify Tree View shows tracks and exercises correctly
   - Download a new exercise → verify it appears in tree
   - Open instructions → verify Webview renders correctly (light + dark theme)
   - Run tests → verify output appears in Output Channel
   - Submit solution → verify CLI is invoked correctly
4. **Cross-platform:** Test on macOS, Linux, and Windows (path handling)
5. **Packaging:** Run `vsce package` and verify VSIX installs cleanly
