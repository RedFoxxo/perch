# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal).

## 1.0.0 — 2026-11-13

- First version: five tools (`read_windows`, `read_window`, `read_screenshot`,
  `read_status`, `act_window`) over computer-use-linux 0.7.53 on Linux.
- Compact trees with e-refs, screenshot pixels converted for clicks, element
  clicks without focusing the window (only for click, press and toggle
  actions), mouse steps only after an explicit `focus` step, refusal when a
  window id was reused by another app, and the server's whole failure
  message with its recovery hint.
