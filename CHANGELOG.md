# Changelog

Versions follow [Semantic Versioning](https://semver.org/). The version lives in
`package.json` and `src/version.ts` (a test keeps them equal).

## 1.1.0 — unreleased

- Windows: the same five tools over open-computer-use 1.3.0's Windows runtime
  (UI Automation, window messages, WGC/PrintWindow capture), started per
  operation with every input gate set by perch: element clicks, `set` and
  `action` through UI Automation, background keys and typing as window
  messages (marked "check the result"), real input only after a `focus`
  step. Window screenshots are shrunk to `max_edge` by perch; drags take
  window screenshot pixels.
- `read_status` shows a backend's own notes and setup advice.
- CI on Linux and Windows; on Windows it drives Notepad through perch
  (`scripts/e2e-windows.mjs`).

## 1.0.0 — 2026-11-13

- First version: five tools (`read_windows`, `read_window`, `read_screenshot`,
  `read_status`, `act_window`) over computer-use-linux 0.7.53 on Linux.
- Compact trees with e-refs, screenshot pixels converted for clicks, element
  clicks without focusing the window (only for click, press and toggle
  actions), mouse steps only after an explicit `focus` step, refusal when a
  window id was reused by another app, and the server's whole failure
  reason (`message`, or `error` and its hint) with its recovery advice.
- Drags take pixels of a whole-screen screenshot, the capture pixels
  computer-use-linux's `drag` expects, instead of adding window pixels to
  logical window positions. A failing window list, an unreadable window
  and a cut-short tree are reported instead of looking empty. Steps already
  sent are reported when the desktop server fails midway.
- `perch setup-window-targeting` installs GNOME's Shell extension with the
  computer-use-linux perch runs, so setup tools need no second pin.
