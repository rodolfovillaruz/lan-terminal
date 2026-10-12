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
- turn presenter mode on or off
- quit

Closing every window does **not** quit the app. Use **Quit** from the tray. Typing `exit` in a shell closes that window. Launching the app a second time opens a new window in the instance that is already running.

## Run as a service

`lan-terminal.service` is a systemd user unit that starts the app when you log in to the desktop and stops it when you log out. It restarts the app if it crashes, but not after **Quit** from the tray.

```sh
systemctl --user link /opt/lan-terminal/lan-terminal.service
systemctl --user enable --now lan-terminal
```

The unit assumes the repo lives at `/opt/lan-terminal`; edit the paths if it doesn't. Useful commands:

```sh
systemctl --user status lan-terminal
systemctl --user restart lan-terminal   # after editing config.json
systemctl --user disable --now lan-terminal
journalctl --user -u lan-terminal -f
```

## Config

On first run the app writes a config file to `~/.config/lan-terminal/config.json`:

| key | default | meaning |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8765` | API listen address |
| `token` | random | Required on every API request |
| `shell` | `null` | `null` means `$SHELL`, otherwise the shell you set |
| `shellArgs` | `["-l"]` | Shell arguments (default starts a login shell) |
| `ptmux` / `tmux` / `screen` | `null` | Paths to the multiplexers for session panes; `null` looks on `$PATH`, then in `~/.cargo/bin` |
| `docker` | `null` | Path to docker, for linuxserver app panes; `null` looks on `$PATH` |
| `adb` / `scrcpy` | `null` | Paths to adb and scrcpy, for Android device panes; `null` looks on `$PATH` (and for adb also in `$ANDROID_HOME` and `~/Android/Sdk`) |
| `scrcpyDisplays` | `[]` | More new-display sizes for the pane menu, in `--new-display` form (`"1920x1080"`, `"1920x1080/240"`, `"/240"`), or `"fit/<dpi>"` for one that fits its pane at that density |
| `scrcpyKeepApps` | `false` | Closing a new display moves its apps to the phone's screen instead of closing them (`--no-vd-destroy-content`) |
| `scrcpyAudio` | `true` | Play a device's sound in its pane (Android 11 or later); `false` leaves the sound on the device |
| `scrcpyAudioDup` | `false` | Keep the sound playing on the device too (Android 13 or later; `--audio-source=playback --audio-dup`, so apps that opt out of capture are not heard) |
| `scrcpyImePolicy` | `null` | Where a new display's keyboard shows: `"local"`, `"fallback"` (the phone's screen) or `"hide"` (`--display-ime-policy`) |
| `fontSize` | `16` | Font size |
| `width` / `height` | `null` | Window size; `null` means the primary display's size |
| `background` / `foreground` | `#000000` / `#e6e6e6` | Terminal colours |
| `presenterMode` | `true` | Move mode shows only the move cursor (see below); also set from the tray |

Restart the app after you edit this file.

## API

Each window has a UUID `id`. Windows are labelled by `process`, the command running in the foreground (`bash`, `vim`, `claude`, …), so two windows can share a label. `title` is the title the shell sets, or the shell's name. Every OS window is titled `LAN Terminal`, so OBS captures don't break when the process changes.

Send `Authorization: Bearer <token>` on every request. You can also put `?token=<token>` in the URL.

| Method & path | Body | Action |
|---|---|---|
| `GET /windows` | | List windows: `id, title, process, mux, session, app, instance, x, y, width, height, moveMode, alwaysOnTop, focused, minimized, pid, panes`; `mux` (`ptmux`, `tmux` or `screen`) and `session` name the active pane's session, or are `null` for a shell; `app` and `instance` name the active pane's linuxserver app (`chromium`, `0`), or are `null`; `device` is the adb serial of the active pane's Android device, or `null`, and `display` its new display (`"fit"`, `"1920x1080/240"`, …), or `null` for the device's screen |
| `POST /windows` | | Open a new terminal window; returns `{id}` (a UUID) |
| `POST /windows/:id/move-mode` | `{"enabled": true\|false}` | Turn move mode on or off |
| `POST /windows/:id/always-on-top` | `{"enabled": true\|false}` | Keep the window above everything (covering the panel) and hide it from the taskbar and Alt+Tab |
| `POST /windows/:id/position` | `{"x": 0, "y": -200}` | Move the window; negative values and positions past the screen edge are allowed |
| `POST /windows/:id/reset-position` | | Move the window to x=0, y=0 |
| `POST /windows/:id/focus` | | Bring the window to the front and focus it |
| `DELETE /windows/:id` (or `POST /windows/:id/close`) | | Close the window and end its shell |
| `WS /events?token=…` | | Push channel: sends `{"type":"windows","windows":[…]}` whenever the window list changes |

```sh
TOKEN=$(jq -r .token ~/.config/lan-terminal/config.json)
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows | jq -r .id)
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"enabled":true}' http://192.168.1.10:8765/windows/$ID/move-mode
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"x":0,"y":-200}' http://192.168.1.10:8765/windows/$ID/position
curl -X POST -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows/$ID/reset-position
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://192.168.1.10:8765/windows/$ID
```

## Panes and sessions

**Plan layout…** in the tray opens the planner, which shows every window and its panes. Split, close and resize panes there, or drag a pane onto another pane of the **same** window to swap them or put it on that side. Panes do not move between windows.

In a shell or session pane, select text with the mouse and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> to copy it to the clipboard. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> pastes the clipboard into the pane.

Each pane has a menu that picks what it shows: a **Shell**, or a session of [ptmux](../pseudo-terminal), tmux or GNU screen, either one that is running or a new one (named with the next free number). A session pane runs the multiplexer's client (`ptmux attach`, `tmux new-session -A`, `screen -x`), so closing the pane, switching it to something else, or detaching inside it only detaches: the session keeps running, and any pane in any window can pick it up again. Sessions are saved with the layout. On the next start their panes reattach, and a session that no longer exists (after a reboot, say) starts again under the same name. The menu lists only the multiplexers the app can find.

The menu also offers **linuxserver apps**: [linuxserver.io](https://docs.linuxserver.io/) images that run a desktop or a single GUI app behind a browser UI, such as [webtop](https://docs.linuxserver.io/images/docker-webtop) (a full Linux desktop) or [chromium](https://docs.linuxserver.io/images/docker-chromium). Each instance runs in its own Docker container and shows in the pane through that UI. The menu lists the app's containers (`webtop 0`, `chromium 1 (stopped)`, …) and a **New** entry for each `lscr.io/linuxserver/*` image you have pulled that serves the UI on port 3000, so a newly pulled image shows up the next time the menu opens (`docker pull lscr.io/linuxserver/firefox` adds **New firefox**; the app never pulls). A new instance is the container `lan-terminal-<app>-<number>`, published only on a `127.0.0.1` port that Docker picks, with its home directory (`/config`) in the volume of the same name. Like a session, an app keeps running when its pane closes or switches and when the app quits, and any pane can pick it up again. The pane's **■** button stops the container; its files stay, and picking it again starts it. The app never removes containers or volumes. To delete one:

```sh
docker rm -f lan-terminal-chromium-0 && docker volume rm lan-terminal-chromium-0
```

Each running app holds from several hundred MB (one app) to a few GB (a desktop) of memory, so stop the ones you aren't using.

The menu also lists each connected **Android device** (`adb devices`) by its model name. Its pane shows the phone's screen through [scrcpy](https://github.com/Genymobile/scrcpy): the app starts the server that ships with the installed scrcpy (`<prefix>/share/scrcpy/scrcpy-server`, or `$SCRCPY_SERVER_PATH`), reads the H.264 stream and draws it inside the pane, so no scrcpy window opens and the screen shows up in a window capture. Dragging with the left button is a finger on the touchscreen, the wheel scrolls, the right button is Back, the middle button Home, and the back and forward mouse buttons are Back and the app switcher. Typing goes to the device: text as text, and Enter, arrows, Backspace and Ctrl/Alt shortcuts as Android keys. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>X</kbd> in a device pane to **capture** the mouse and keyboard, as scrcpy's `--mouse=uhid --keyboard=uhid` do: the device gets a USB mouse and keyboard, the pointer is locked to the pane and the device shows its own cursor, and every key goes to the device as a physical key press, Ctrl and Alt shortcuts included (with the device's keyboard layout, US unless set in Android's physical keyboard settings). Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>X</kbd> again to release them; leaving the pane (Alt+Tab, say) releases them too. Before Android 15 a USB mouse can only point at the phone's own screen, so on a new display only the keyboard is captured there and the mouse keeps working as a finger. The pane also plays the device's **sound** (Android 11 or later), as scrcpy does: the phone's whole audio output comes through the app (and so into an OBS capture of it) and the phone itself goes quiet while it is mirrored, unless `scrcpyAudioDup` keeps it playing there too. A device has one sound, so with several panes on the same device only the first plays it. Unlike a session, the mirror ends with its pane.

Each device's menu group offers its **Screen** and **new displays** ([`--new-display`](https://github.com/Genymobile/scrcpy/blob/master/doc/virtual_display.md), Android 10 or later): a virtual display that runs its own apps while the phone's screen stays as it is. **New display** has the phone screen's size and density, **New display fitting the pane** keeps resizing to fill its pane (`--flex-display`, 160 dpi), and `scrcpyDisplays` in the config adds fixed sizes. Each pane gets its own display, which closes with the pane, together with the apps on it unless `scrcpyKeepApps` is set.

A device pane's card in the planner has an **Open app…** menu listing the phone's apps (as `scrcpy --list-apps` does), with the ones you installed first and the system apps after. Picking one opens it on what the pane shows: the phone's screen, or the pane's new display. A new display remembers the app it last opened and opens it again when it comes back, for example on the next start. Listing the apps takes the phone a few seconds, so each phone's last list is kept in `~/.config/lan-terminal/device-apps.json`, also across restarts, and the menu opens with it at once. A list older than a minute is fetched again in the background when a device pane connects or the menu opens, and the menu shows the new list the next time. Only a phone that has never been listed makes the menu wait. A pane whose device is not connected, or whose stream stops, says so and tries again every few seconds, so a saved layout picks the phone up once it is plugged in or paired.

**Move mode** puts a blue overlay over the window. Drag anywhere on it to move the window, including above the top of the screen. While the overlay is up, typing does not reach the shell. Press Esc or call `move-mode` with `{"enabled": false}` to turn it off.

**Presenter mode** is on by default. It hides the blue overlay, outline and label, so nothing shows up in an OBS capture, and only the mouse cursor changes to the move cursor. Untick **Presenter mode** in the tray menu to get the visible overlay back. The setting is saved in the config file.

The API is plain HTTP. Anyone on the LAN who has the token can open or close your terminals, so keep the token private. If you need a new token, delete the `token` line from the config file and restart.

## Wayland notes

- The app runs through **XWayland** (`--ozone-platform=x11`). Electron chooses its display backend before any app code runs, so the flag has to be on the command line: `npm start` passes it, and `src/main/main.js` relaunches itself with it if it was started without it. Without it the window opens blank. Native Wayland doesn't let an app place its own window or take focus, so "reset to 0,0" and tray focus would not work there. XWayland windows still show up in OBS's PipeWire window capture.
- **Minimizing does not free memory.** Chromium only slows rendering for a minimized window, which saves CPU. The window's memory, about 100–200 MB, stays in use. The only way to free it is to close the window, either from the API or with `exit`.
- Wayland lets an app minimize itself but not unminimize itself. Under XWayland, choosing the window from the tray menu, or calling `POST /windows/:id/focus`, brings it back.
- OBS can't capture a minimized window on Wayland; it shows a frozen or black frame. Keep windows you're streaming unminimized.
- The GPU process runs with `--disable-gpu-sandbox` (set in `src/main/main.js`). Chromium's GPU sandbox blocks Mesa 26's `/usr/lib/gbm/dri_gbm.so`, which logged `MESA-LOADER: failed to open dri ... Permission denied` at every start. Rendering worked either way. This app only loads its own local files, so running without that sandbox carries little risk.
