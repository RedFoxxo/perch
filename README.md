# perch

A small MCP server for desktop control. It lets an AI agent see and use the
apps on your desktop with five compact tools, and keeps what it adds to the
agent's context small.

perch does no desktop work itself. On Linux it runs
[computer-use-linux](https://github.com/agent-sh/computer-use-linux), which
handles accessibility trees, screenshots, Wayland and X11 input, and window
targeting on GNOME, KDE, Hyprland, Sway and others. On Windows it runs the
Windows runtime of
[open-computer-use](https://github.com/opensymph/open-computer-use) (UI
Automation, window messages, window capture). perch shows the agent the same
short interface over both. macOS is planned.

## Tools

| Tool | Does |
|---|---|
| `read_windows` | Open windows: id, app, title, focus, workspace |
| `read_window` | A window's buttons, fields and text as compact lines: `[e34 button "Save" disabled]` |
| `read_screenshot` | A picture of one window (or the screen), or a PNG file |
| `read_status` | Whether accessibility, input and the window list work, and what blocks them |
| `act_window` | Steps in one window: click, type, key, set, action, scroll, drag, focus, wait |

What it does for the agent:

- **e-refs.** `read_window` lists elements as `e34`; `act_window` turns them
  into the server's element index and snapshot.
- **Screenshot pixels.** `[x, y]` in `act_window` are pixels of the window's
  last `read_screenshot`; perch converts them.
- **Your screen stays yours where it can.** Clicking an element whose
  primary action is click, press or toggle (Windows: invoke, select or
  toggle) runs that action without focusing the window, on every Linux
  desktop. On Windows, classic controls come forward when UI Automation
  acts on them: in CI, a WinForms button and check box (click, `action`)
  and Notepad's text field (`set`) all brought their window to the front.
  The step then says "the app came to the front". On Hyprland and Windows,
  keys and window screenshots stay in the background, so a test app on a
  hidden workspace or behind other windows doesn't come to the front;
  elsewhere both bring the window forward. Other elements (a table cell
  that expands or edits)
  are refused with their action names, to use as an `action` step. Mouse
  steps need an explicit `focus` step, and keys for the focused window are
  refused if you moved the focus.
- **Reused window ids.** If a window closed and another app got its id,
  `act_window` refuses instead of acting in the wrong app.
- **Typed text is never echoed** in results.

Size, measured against computer-use-linux 0.7.53 on Thunar:

| | computer-use-linux | perch |
|---|---|---|
| Tool list | 19 tools, 67.8 KB | 5 tools, 6.1 KB |
| Server instructions | 7.6 KB | none |
| One window's tree | 31.5 KB | 1.1 KB |

## Use

```json
{
  "mcpServers": {
    "perch": { "command": "npx", "args": ["-y", "@redfoxxo/perch@1"] }
  }
}
```

Node.js 22.12 or newer. On Linux, computer-use-linux comes with perch (its
binary downloads on first use) and needs the setup its
[README](https://github.com/agent-sh/computer-use-linux#quick-start)
describes: accessibility on, and an input backend.

| Variable | Default | Effect |
|---|---|---|
| `COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND` | `1` | Hyprland: keys and window screenshots without focusing the window. `0` turns it off |

Other `COMPUTER_USE_LINUX_*` variables pass through unchanged.

On GNOME Wayland, computer-use-linux lists and focuses windows through a
small Shell extension. Install it with the version perch runs, then log out
and back in:

```sh
npx -y @redfoxxo/perch@1 setup-window-targeting
```

On Windows, open-computer-use comes with perch; nothing else to install.
Run perch in the signed-in desktop session, not over SSH or as a service.
What differs from Linux:

- **Background keys and typing** are posted to the window as messages.
  Classic Win32 fields take them; some newer apps (Chromium, Electron,
  WinUI) ignore them, so the step says to check the result. `focused: true`
  after a `focus` step sends real keystrokes instead.
- **Drags** take pixels of the window's screenshot, like clicks.
- **Trees** show no disabled or checked state: the runtime doesn't report
  them.
- **Refused apps:** open-computer-use won't touch terminals, PowerShell,
  password managers or Windows Security. Apps running as administrator can
  be read but not clicked or typed into unless perch runs as administrator
  too.
- **Slower steps:** the runtime runs every operation in a new process, so a
  crashing capture can't take perch down. On GitHub's Windows runner, reads
  took 0.1 s and `act_window` calls 0.5–1.2 s.
- **Scaled displays:** perch starts the runtime as system DPI aware
  (`__COMPAT_LAYER=HighDpiAware`, unless you set that variable), so window
  positions and UI Automation coordinates are both in pixels.

## Develop

```sh
npm ci
npm test
npm run typecheck
npm run build   # build/index.js is the server
node scripts/e2e-windows.mjs   # Windows only, after the build: drives Notepad for real
```

## License

MIT
