# perch

A small MCP server for desktop control. It lets an AI agent see and use the
apps on your desktop with five compact tools, and keeps what it adds to the
agent's context small.

perch does no desktop work itself. On Linux it runs
[computer-use-linux](https://github.com/agent-sh/computer-use-linux)
(accessibility trees, screenshots, Wayland and X11 input, window targeting on
GNOME, KDE, Hyprland, Sway and others). On Windows it runs the Windows runtime
of [open-computer-use](https://github.com/opensymph/open-computer-use) (UI
Automation, window messages, window capture). Both come with perch, behind the
same short interface. macOS is not supported yet.

## Requirements

- Node.js 22.12 or newer.
- **Linux:** x64 or arm64 with glibc (the builds computer-use-linux ships),
  in a desktop session. Accessibility on, and an input backend, as
  computer-use-linux's
  [quick start](https://github.com/agent-sh/computer-use-linux#quick-start)
  describes. Its binary downloads on first use if npm skipped its install
  script.
- **GNOME Wayland:** computer-use-linux lists and focuses windows through a
  small Shell extension. Install it with the version perch runs, then log out
  and back in:

  ```sh
  npx -y @redfoxxo/perch@1 setup-window-targeting
  ```

- **Windows:** nothing else to install. Run perch in the signed-in desktop
  session, not over SSH or as a service.

`read_status` tells what is missing on a desktop, and how to fix it.

## Setup

perch runs over stdio; `npx -y @redfoxxo/perch@1` starts it.

**Claude Code:**

```sh
claude mcp add perch -- npx -y @redfoxxo/perch@1
```

On native Windows, start npx through `cmd /c`:
`claude mcp add perch -- cmd /c npx -y @redfoxxo/perch@1`.

**opencode** (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "perch": { "type": "local", "command": ["npx", "-y", "@redfoxxo/perch@1"] }
  }
}
```

**Other clients** (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "perch": { "command": "npx", "args": ["-y", "@redfoxxo/perch@1"] }
  }
}
```

Environment variables (Linux):

| Variable | Default | Effect |
|---|---|---|
| `COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND` | `1` | Hyprland: keys and window screenshots without focusing the window. `0` turns it off |
| `COMPUTER_USE_LINUX_AGENT_NAME` | the client's name | Name computer-use-linux shows on screen while it acts |

Other `COMPUTER_USE_LINUX_*` variables pass through to computer-use-linux
unchanged. On Windows, perch starts the runtime with
`__COMPAT_LAYER=HighDpiAware` unless you set that variable, so window
positions and UI Automation coordinates are both in pixels on scaled
displays.

## Tools

| Tool | Does |
|---|---|
| `read_windows` | Open windows: id, app, title, focus, workspace |
| `read_window` | A window's buttons, fields and text as compact lines: `[e34 button "Save" disabled]` |
| `read_screenshot` | A picture of one window (or the screen), or a new PNG file |
| `read_status` | Whether accessibility, input and the window list work, and what blocks them |
| `act_window` | Steps in one window: click, type, key, set, action, scroll, drag, focus, wait |

What perch does for the agent:

- **e-refs.** `read_window` lists elements as `e34`; `act_window` turns them
  into the server's element index and snapshot. A new `read_window` replaces
  them.
- **Screenshot pixels.** `[x, y]` in `act_window` are pixels of the window's
  last `read_screenshot`; perch converts them, and refuses points outside
  that image.
- **Your screen stays yours where it can.** Clicking an element whose
  primary action is click, press or toggle (Windows: invoke, select or
  toggle) runs that action without focusing the window. Other elements (a
  table cell that expands or edits) are refused with their action names, to
  use as an `action` step. On Hyprland and Windows, keys, typing and window
  screenshots stay in the background too; elsewhere they bring the window
  forward. Mouse steps need an explicit `focus` step, and keys for the
  focused window are refused if the focus moved.
- **Reused window ids.** If a window closed and another app got its id,
  `act_window` refuses instead of acting in the wrong app.
- **Typed text is never echoed** in results. Long text and field values in
  trees are cut at 1,000 characters.

Size, measured against computer-use-linux 0.7.53 on Thunar:

| | computer-use-linux | perch |
|---|---|---|
| Tool list | 19 tools, 67.8 KB | 5 tools, 4.8 KB |
| Server instructions | 7.6 KB | none |
| One window's tree | 31.5 KB | 1.1 KB |

## Limitations

- **Apps without accessibility** (old toolkits, Wine, games, canvases)
  show no tree; use `read_screenshot` and `[x, y]` clicks there.
- **Drags** on Linux take pixels of a whole-screen screenshot; on Windows,
  pixels of the window's screenshot, like clicks.
- **Windows, background input:** keys and typing are posted to the window
  as messages. Classic Win32 fields take them; some newer apps (Chromium,
  Electron, WinUI) ignore them, so the step says to check the result.
  `focused: true` after a `focus` step sends real keystrokes instead.
- **Windows, classic controls** come forward when UI Automation acts on
  them: in CI, a WinForms button and check box (click, `action`) and
  Notepad's text field (`set`) all brought their window to the front. The
  step then says "the app came to the front".
- **Windows, trees** show no disabled or checked state: the runtime doesn't
  report them.
- **Windows, refused apps:** open-computer-use won't touch terminals,
  PowerShell, password managers or Windows Security. Apps running as
  administrator can be read but not clicked or typed into unless perch runs
  as administrator too.
- **Windows, speed:** the runtime runs every operation in a new process, so
  a crashing capture can't take perch down. On GitHub's Windows runner,
  reads took 0.1 s and `act_window` calls 0.5–1.2 s.
- **Install size:** npm installs both runtimes (about 40 MB) on every
  platform, since open-computer-use's package doesn't declare its platforms.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT
