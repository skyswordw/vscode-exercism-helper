# Changelog

## [0.1.4] - 2026-10-21

### Fixed
- Restore exercise browsing and progress requests by using the dedicated Exercism API host.
- Bound track enrollment requests with timeouts and stop polling or downloading promptly when cancelled.
- Avoid retry prompts and stale error messages after cancelling a download.

### Added
- Show joined tracks first with a joined badge in the download picker.
- Guide users to join a track in their browser, then automatically resume the download, with a manual retry option.
- Add regression tests for API request deadlines and cancellation throughout the join-and-download flow.

Thanks to @mmtxrc for the API endpoint fix and join-track workflow in PR #1.

## [0.1.1] - 2026-03-28

### Changed
- Optimize bundle size from 2MB to 361KB by importing only Exercism-relevant highlight.js languages instead of all 197

## [0.1.0] - 2026-03-28

### Added
- Sidebar Tree View for browsing tracks and exercises
- Exercise instruction preview with Markdown rendering
- One-click test running via `exercism test`
- Solution submission from within VS Code
- Download exercises without leaving the editor
- Theme-aware Webview (light/dark/high-contrast)
- Configurable CLI path and workspace location
