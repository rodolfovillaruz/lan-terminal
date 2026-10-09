# LAN Terminal

A borderless, non-resizable terminal for Linux, built on Electron and xterm.js.

- Each window runs your login shell (`$SHELL -l`, usually bash).
- No tabs, title bar or close button, so OBS captures a clean image.
- Uses the bundled **JetBrains Mono NL Nerd Font** (no ligatures, with Nerd Font icons).
- Can be controlled from another device on the LAN, such as an Android app, through a small HTTP API.

## Run

```sh
npm install   # downloads Electron and builds node-pty for it
npm start
```

The first window opens at (0,0), sized to the primary display (2560×1440 on a 2560×1440 screen). KDE shrinks new windows so they stop at the top of the panel, so the app sets the full size again right after the window appears, and the window covers the panel. A tray icon appears in the system tray. Right-click it to:

- focus one of the open windows
- open a new window
- see the API addresses
- copy the API token
- quit

Closing every window does **not** quit the app. Use **Quit** from the tray. Typing `exit` in a shell closes that window. Launching the app a second time opens a new window in the instance that is already running.

## Config

On first run the app writes a config file to `~/.config/lan-terminal/config.json`:

| key | default | meaning |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8765` | API listen address |
| `token` | random | Required on every API request |
| `shell` | `null` | `null` means `$SHELL`, otherwise the shell you set |
| `shellArgs` | `["-l"]` | Shell arguments (default starts a login shell) |
| `fontSize` | `16` | Font size |
| `width` / `height` | `null` | Window size; `null` means the primary display's size |
| `background` / `foreground` | `#000000` / `#e6e6e6` | Terminal colours |

Restart the app after you edit this file.

## API

Send `Authorization: Bearer <token>` on every request. You can also put `?token=<token>` in the URL.

| Method & path | Body | Action |
|---|---|---|
| `GET /windows` | | List windows: `id, title, x, y, width, height, moveMode, focused, minimized, pid` |
| `POST /windows` | | Open a new terminal window; returns `{id}` |
| `POST /windows/:id/move-mode` | `{"enabled": true\|false}` | Turn move mode on or off |
| `POST /windows/:id/position` | `{"x": 0, "y": -200}` | Move the window; negative values and positions past the screen edge are allowed |
| `POST /windows/:id/reset-position` | | Move the window to x=0, y=0 |
| `POST /windows/:id/focus` | | Bring the window to the front and focus it |
| `DELETE /windows/:id` (or `POST /windows/:id/close`) | | Close the window and end its shell |
| `WS /events?token=…` | | Push channel: sends `{"type":"windows","windows":[…]}` whenever the window list changes |

```sh
TOKEN=$(jq -r .token ~/.config/lan-terminal/config.json)
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows
curl -X POST -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"enabled":true}' http://192.168.1.10:8765/windows/1/move-mode
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"x":0,"y":-200}' http://192.168.1.10:8765/windows/1/position
curl -X POST -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows/1/reset-position
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows/1
```

**Move mode** puts a blue overlay over the window. Drag anywhere on it to move the window, including above the top of the screen. While the overlay is up, typing does not reach the shell. Press Esc or call `move-mode` with `{"enabled": false}` to turn it off.

The API is plain HTTP. Anyone on the LAN who has the token can open or close your terminals, so keep the token private. If you need a new token, delete the `token` line from the config file and restart.

## Wayland notes

- The app runs through **XWayland** (`--ozone-platform=x11`). Electron chooses its display backend before any app code runs, so the flag has to be on the command line: `npm start` passes it, and `src/main/main.js` relaunches itself with it if it was started without it. Without it the window opens blank. Native Wayland doesn't let an app place its own window or take focus, so "reset to 0,0" and tray focus would not work there. XWayland windows still show up in OBS's PipeWire window capture.
- **Minimizing does not free memory.** Chromium only slows rendering for a minimized window, which saves CPU. The window's memory, about 100–200 MB, stays in use. The only way to free it is to close the window, either from the API or with `exit`.
- Wayland lets an app minimize itself but not unminimize itself. Under XWayland, choosing the window from the tray menu, or calling `POST /windows/:id/focus`, brings it back.
- OBS can't capture a minimized window on Wayland; it shows a frozen or black frame. Keep windows you're streaming unminimized.
- The GPU process runs with `--disable-gpu-sandbox` (set in `src/main/main.js`). Chromium's GPU sandbox blocks Mesa 26's `/usr/lib/gbm/dri_gbm.so`, which logged `MESA-LOADER: failed to open dri ... Permission denied` at every start. Rendering worked either way. This app only loads its own local files, so running without that sandbox carries little risk.
