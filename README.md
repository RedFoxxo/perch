# perch

A small MCP server for desktop control. It lets an AI agent see and use the
apps on your desktop with five compact tools, and keeps what it adds to the
agent's context small.

perch does no desktop work itself. On Linux it runs
[computer-use-linux](https://github.com/agent-sh/computer-use-linux), which
handles accessibility trees, screenshots, Wayland and X11 input, and window
targeting on GNOME, KDE, Hyprland, Sway and others. perch shows the agent a
shorter interface over it. Windows and macOS are planned.

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
- **Your screen stays yours.** Clicking an element whose primary action is
  click, press or toggle runs that action, and keys go to the window
  without focusing it (Hyprland), so a test app on a hidden workspace never
  comes to the front. Other elements (a table cell that expands or edits)
  are refused with their action names, to use as an `action` step. Mouse
  steps need an explicit `focus` step, and keys for the focused window are
  refused if you moved the focus.
- **Reused window ids.** If a window closed and another app got its id,
  `act_window` refuses instead of acting in the wrong app.
- **Typed text is never echoed** in results.

Size, measured against computer-use-linux 0.7.53 on Thunar:

| | computer-use-linux | perch |
|---|---|---|
| Tool list | 19 tools, 67.8 KB | 5 tools, 6.2 KB |
| Server instructions | 7.6 KB | none |
| One window's tree | 31.5 KB | 1.1 KB |

## Use

```json
{
  "mcpServers": {
    "perch": { "command": "npx", "args": ["-y", "@redfoxxo/perch@0"] }
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

## Develop

```sh
npm ci
npm test
npm run typecheck
npm run build   # build/index.js is the server
```

## License

MIT
