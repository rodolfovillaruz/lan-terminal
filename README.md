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
| `kubectl` | `null` | Path to kubectl, for Kubernetes pod panes; `null` looks on `$PATH` |
| `podNamespace` | `null` | The namespace the last new pod went to, where the next new pane's form starts; set by the app |
| `adb` / `scrcpy` | `null` | Paths to adb and scrcpy, for Android device panes; `null` looks on `$PATH` (and for adb also in `$ANDROID_HOME` and `~/Android/Sdk`) |
| `scrcpyDisplays` | `[]` | More new-display sizes for the pane menu, in `--new-display` form (`"1920x1080"`, `"1920x1080/240"`, `"/240"`), or `"fit/<dpi>"` for one that fits its pane at that density |
| `scrcpyKeepApps` | `false` | Closing a new display moves its apps to the phone's screen instead of closing them (`--no-vd-destroy-content`) |
| `scrcpyAudio` | `true` | Play a device's sound in its pane (Android 11 or later); `false` leaves the sound on the device |
| `scrcpyAudioDup` | `false` | Keep the sound playing on the device too (Android 13 or later; `--audio-source=playback --audio-dup`, so apps that opt out of capture are not heard) |
| `scrcpyApps` | `{}` | Per adb serial, the apps (package names) the **Open app…** menu of that phone's panes offers; a phone not listed is offered all its apps. Set from the planner's **Choose apps…** |
| `scrcpyImePolicy` | `null` | Where a new display's keyboard shows: `"local"`, `"fallback"` (the phone's screen) or `"hide"` (`--display-ime-policy`) |
| `recentPages` | `[]` | The web pages opened last (up to 10, newest first), listed in the pane menu; kept by the app |
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
| `GET /windows` | | List windows: `id, title, process, mux, session, app, instance, x, y, width, height, maximized, moveMode, alwaysOnTop, focused, minimized, pid, panes`; `mux` (`ptmux`, `tmux` or `screen`) and `session` name the active pane's session, or are `null` for a shell; `app` and `instance` name the active pane's linuxserver app (`chromium`, `0`), or are `null`; `container` is the label name of the labelled container it shows, or `null`; `maximized` is the id of the pane filling the window, or `null`; `page` is the URL a web page pane is on, or `null`; `device` is the adb serial of the active pane's Android device, or `null`, `display` its new display (`"fit"`, `"1920x1080/240"`, …), or `null` for the device's screen, and `deviceApp` the package of the app on top of it, or `null` |
| `POST /windows` | | Open a new terminal window; returns `{id}` (a UUID) |
| `POST /windows/:id/move-mode` | `{"enabled": true\|false}` | Turn move mode on or off |
| `POST /windows/:id/always-on-top` | `{"enabled": true\|false}` | Keep the window above everything (covering the panel) and hide it from the taskbar and Alt+Tab |
| `POST /windows/:id/position` | `{"x": 0, "y": -200}` | Move the window; negative values and positions past the screen edge are allowed |
| `POST /windows/:id/reset-position` | | Move the window to x=0, y=0 |
| `POST /windows/:id/maximize` | `{"pane": "<pane id>"\|null}` | Fill the window with that pane (ids from `panes`) for now; `null` puts the panes back |
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

To show one pane on its own for a while, **maximize** it: the card's **⛶** button, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>Z</kbd> in the pane, which works in every kind of pane. It fills the window, and the other panes keep running at their size behind it (their cards are dimmed in the planner). The same button (now **⊡**) or key puts the panes back, and so do splitting or moving a pane and selecting another pane in the planner. Maximizing is not saved with the layout, so the window starts with all its panes.

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd>, in any pane, keeps the window **always on top** (above everything, covering the panel, and out of the taskbar and Alt+Tab) or stops it, like `POST /windows/:id/always-on-top`.

<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd>, in any pane, turns **resize mode** on or off. It puts a handle on each line between the window's panes; drag one to resize the panes on either side, as in the planner. The panes take their new size when you let go. Elsewhere on a pane, the half nearest the pointer lights up with a **+**: click to split the pane there and open a **New pane** form on that side (see Kubernetes pods below); resize mode then turns off and the new pane has the keyboard. The pane under the pointer also shows its tools in its top left corner: **✕** closes it, **📌** pins it, **⛶** maximizes it (**⊡** puts the panes back), and **⟳** reloads it: the pane closes and what it showed opens again in the same place, so a shell starts afresh, a session, app or pod is attached to again and a page loads again. A pinned pane stays in sight, in its place, over whichever pane is maximized, so you can keep, say, a camera or a shell showing over a full-window desktop; pinning is not saved with the layout. Within an eighth of a pane's size from its centre the cursor becomes a hand: drag the pane onto another one to trade places (drop on its middle) or to put it beside it (drop near an edge), as in the planner. While it is on, the panes get no mouse or keyboard input; press the same keys or Esc to turn it off. Presenter mode hides its tint, label and handles, leaving only the resize cursor over each line.

In a shell or session pane, select text with the mouse and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> to copy it to the clipboard. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> pastes the clipboard into the pane.

Each pane has a menu that picks what it shows: a **Shell**, or a session of [ptmux](../pseudo-terminal), tmux or GNU screen, either one that is running or a new one (named with the next free number). A session pane runs the multiplexer's client (`ptmux attach`, `tmux new-session -A`, `screen -x`), so closing the pane, switching it to something else, or detaching inside it only detaches: the session keeps running, and any pane in any window can pick it up again. Sessions are saved with the layout. On the next start their panes reattach, and a session that no longer exists (after a reboot, say) starts again under the same name. The menu lists only the multiplexers the app can find.

The menu also offers **linuxserver apps**: [linuxserver.io](https://docs.linuxserver.io/) images that run a desktop or a single GUI app behind a browser UI, such as [webtop](https://docs.linuxserver.io/images/docker-webtop) (a full Linux desktop) or [chromium](https://docs.linuxserver.io/images/docker-chromium). Each instance runs in its own Docker container and shows in the pane through that UI. The menu lists the app's containers (`webtop 0`, `chromium 1 (stopped)`, …) and a **New** entry for each `lscr.io/linuxserver/*` image you have pulled that serves the UI on port 3000, so a newly pulled image shows up the next time the menu opens (`docker pull lscr.io/linuxserver/firefox` adds **New firefox**; the app never pulls). A new instance is the container `lan-terminal-<app>-<number>`, published only on a `127.0.0.1` port that Docker picks, with its home directory (`/config`) in the volume of the same name. Like a session, an app keeps running when its pane closes or switches and when the app quits, and any pane can pick it up again. The pane's **■** button stops the container; its files stay, and picking it again starts it. The app never removes containers or volumes. To delete one:

```sh
docker rm -f lan-terminal-chromium-0 && docker volume rm lan-terminal-chromium-0
```

The linuxserver group also lists containers that something else runs, such as a docker compose service, by the name in their `lan-terminal.pane` label. To show one, give it the label and publish its port 3000 on localhost:

```yaml
    labels:
      - lan-terminal.pane=chromium-debug
    ports:
      - 127.0.0.1:3010:3000
```

Its pane shows the UI like an app's, and picking it starts the container if it is stopped. The app never stops, recreates or removes it, so its pane has no **■** button: compose (or whatever runs it) owns it. It is saved with the layout by its label, so it survives the container being recreated.

Each running app holds from several hundred MB (one app) to a few GB (a desktop) of memory, so stop the ones you aren't using.

The same images can run as **Kubernetes pods**, on the cluster that `kubectl` talks to. A pane added in resize mode starts as a **New pane** form (the menu's **New pod…** turns any pane into one):

- **Namespace** picks where the pods are. It starts on the namespace the last new pod went to (`podNamespace` in the config), or `default`. **New namespace…** creates one.
- **Open a pod** lists the pods the app made in that namespace; click one to show it.
- **New pod** makes one from any image in [linuxserver's catalog](https://www.linuxserver.io/our-images), with a tag (the catalog's, or any other) and the port its UI serves (3000 for the desktops and GUI apps; a server app's own port otherwise). Kubernetes pulls the image, so the first start of a desktop takes a few minutes.
- **Shell instead** makes the pane a shell.

A new pod is the bare Pod `<image>-<number>` in that namespace, labelled `app.kubernetes.io/managed-by=lan-terminal`, running as your user like the containers, with its home directory (`/config`) on an `emptyDir`: it lasts through restarts of the container and of the node, and goes when the pod is deleted. The pane reaches the UI through `kubectl port-forward` on a localhost port, and when the forward drops (the container restarting, say) it says so and connects again. Pods keep running when their pane closes, the menu's **Kubernetes pods** group lists them for any pane, and they are saved with the layout. The app never deletes a pod; to delete one:

```sh
kubectl delete pod -n <namespace> <name>
```

The menu also lists each connected **Android device** (`adb devices`) by its model name. Its pane shows the phone's screen through [scrcpy](https://github.com/Genymobile/scrcpy): the app starts the server that ships with the installed scrcpy (`<prefix>/share/scrcpy/scrcpy-server`, or `$SCRCPY_SERVER_PATH`), reads the H.264 stream and draws it inside the pane, so no scrcpy window opens and the screen shows up in a window capture. Dragging with the left button is a finger on the touchscreen, the wheel scrolls, the right button is Back, the middle button Home, and the back and forward mouse buttons are Back and the app switcher. Typing goes to the device: text as text, and Enter, arrows, Backspace and Ctrl/Alt shortcuts as Android keys. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>X</kbd> in a device pane to **capture** the mouse and keyboard, as scrcpy's `--mouse=uhid --keyboard=uhid` do: the device gets a USB mouse and keyboard, the pointer is locked to the pane and the device shows its own cursor, and every key goes to the device as a physical key press, Ctrl and Alt shortcuts included (with the device's keyboard layout, US unless set in Android's physical keyboard settings). Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>X</kbd> again to release them; leaving the pane (Alt+Tab, say) releases them too. Before Android 15 a USB mouse can only point at the phone's own screen, so on a new display only the keyboard is captured there and the mouse keeps working as a finger. The pane also plays the device's **sound** (Android 11 or later), as scrcpy does: the phone's whole audio output comes through the app (and so into an OBS capture of it) and the phone itself goes quiet while it is mirrored, unless `scrcpyAudioDup` keeps it playing there too. A device has one sound, so with several panes on the same device only the first plays it. Unlike a session, the mirror ends with its pane.

Each device's menu group offers its **Screen** and **new displays** ([`--new-display`](https://github.com/Genymobile/scrcpy/blob/master/doc/virtual_display.md), Android 10 or later): a virtual display that runs its own apps while the phone's screen stays as it is. **New display** has the phone screen's size and density, **New display fitting the pane** keeps resizing to fill its pane (`--flex-display`, 160 dpi), and `scrcpyDisplays` in the config adds fixed sizes. Each pane gets its own display, which closes with the pane, together with the apps on it unless `scrcpyKeepApps` is set.

A device pane's card in the planner has an **Open app…** menu listing the phone's apps (as `scrcpy --list-apps` does), with the ones you installed first and the system apps after. Picking one opens it on what the pane shows: the phone's screen, or the pane's new display. To keep the menu short, **Choose apps…** at the top of the planner, next to **New window**, opens a list of a phone's apps to tick, with a search box and a menu to pick the phone. Each phone has its own list: its panes' menus then offer only the apps ticked for it (`scrcpyApps` in the config), and with none ticked they offer them all. Apps are told apart by package name, which is unique on a phone, so two apps with the same name are two entries, each with its package beside it. A new display remembers the app it last opened and opens it again when it comes back, for example on the next start. Listing the apps takes the phone a few seconds, so each phone's last list is kept in `~/.config/lan-terminal/device-apps.json`, also across restarts, and the menu opens with it at once. A list older than a minute is fetched again in the background when a device pane connects or the menu opens, and the menu shows the new list the next time. Only a phone that has never been listed makes the menu wait. The app keeps track of which app is on top of each device pane, however it was opened, every few seconds: the pane's card shows it in its label and in **Open app…**, and a new display saves it as the app to open again on the next start. Each app that has been on a device pane gets an entry in every pane menu, under **<phone> apps**, for as long as it runs on the phone, and the pane showing it has that entry selected. Picking the entry in another pane, in any window, **moves** the app there: a pane already on that phone opens it on its own screen or display, and any other pane becomes a new display like the one the app was on (or one fitting the pane, when the app was on the phone's screen). Android moves the app's task, so it keeps its state, and the pane it left shows what is underneath, often the launcher. A pane whose device is not connected, or whose stream stops, says so and tries again every few seconds, so a saved layout picks the phone up once it is plugged in or paired.

The menu's **Web pages** group shows a **web page** in the pane, like a browser tab with no address bar: handy for a server-rendered app you are working on, a dashboard or docs. **Web page…** opens a box in the pane's card: type a URL (`localhost:3000` is taken as `http://localhost:3000`) and press Enter, or Esc to cancel. The pages you opened last are listed under it. The pane follows the page's links, and links that open a new window open in the pane. The layout saves the page the pane is on, so it comes back there on the next start. Logins and cookies are kept across restarts, shared by all page panes. A page that does not load, such as a dev server that is restarting, says so and is tried again every few seconds. The card's **↻** button reloads the page, and so do <kbd>F5</kbd> and <kbd>Ctrl</kbd>+<kbd>R</kbd> in the pane (with <kbd>Shift</kbd>, skipping the cache); <kbd>Alt</kbd>+<kbd>←</kbd> and <kbd>Alt</kbd>+<kbd>→</kbd> go back and forward. Pages load in a `<webview>`, not an iframe, so sites that refuse to be framed show too. Only http and https URLs open, and pages get no access to the app or to Node.

The menu's **Cameras** group offers **DroidCam** when DroidCam's kernel module (`v4l2loopback_dc`) is loaded. The pane shows the phone's camera from the V4L2 loopback device the DroidCam client feeds (the camera named `Droidcam`), so the phone's camera shows up in a window capture without OBS's own DroidCam source. The app only reads the device: connect the phone in the DroidCam app (or with `droidcam-cli`) as usual. The device opens even when nothing feeds it, so until video comes in, or when it stops, the pane says so; a device that is missing or cannot be opened is tried again every few seconds. The pane has no sound, and is saved with the layout like the others.

Beside other panes, the DroidCam pane's planner tools add two buttons. **⇔** spans the video across the pane's width, cropping its top and bottom to the pane's height instead of showing it whole with bars at the sides; it is saved with the layout. **↕** makes the pane as tall as the video is at the pane's current width, by resizing the split above it, so you set the width and let the height follow. It needs the pane stacked above or below another pane, and video coming in.

The menu's **Plan layout** shows the planner itself in the pane, so you can plan the layout without leaving the window (or from a captured screen). It works like the **Plan layout…** window and stays in step with it: it shows every window, its own included, and any change made in either shows in both. Its pane is saved with the layout like the others.

**Move mode** puts a blue overlay over the window. Drag anywhere on it to move the window, including above the top of the screen. While the overlay is up, typing does not reach the shell. Press Esc or call `move-mode` with `{"enabled": false}` to turn it off.

**Presenter mode** is on by default. It hides the blue overlay, outline and label, so nothing shows up in an OBS capture, and only the mouse cursor changes to the move cursor. Untick **Presenter mode** in the tray menu to get the visible overlay back. The setting is saved in the config file.

The API is plain HTTP. Anyone on the LAN who has the token can open or close your terminals, so keep the token private. If you need a new token, delete the `token` line from the config file and restart.

## Wayland notes

- The app runs through **XWayland** (`--ozone-platform=x11`). Electron chooses its display backend before any app code runs, so the flag has to be on the command line: `npm start` passes it, and `src/main/main.js` relaunches itself with it if it was started without it. Without it the window opens blank. Native Wayland doesn't let an app place its own window or take focus, so "reset to 0,0" and tray focus would not work there. XWayland windows still show up in OBS's PipeWire window capture.
- **Minimizing does not free memory.** Chromium only slows rendering for a minimized window, which saves CPU. The window's memory, about 100–200 MB, stays in use. The only way to free it is to close the window, either from the API or with `exit`.
- Wayland lets an app minimize itself but not unminimize itself. Under XWayland, choosing the window from the tray menu, or calling `POST /windows/:id/focus`, brings it back.
- OBS can't capture a minimized window on Wayland; it shows a frozen or black frame. Keep windows you're streaming unminimized.
- The GPU process runs with `--disable-gpu-sandbox` (set in `src/main/main.js`). Chromium's GPU sandbox blocks Mesa 26's `/usr/lib/gbm/dri_gbm.so`, which logged `MESA-LOADER: failed to open dri ... Permission denied` at every start. Rendering worked either way. The app's own pages are local files, but web page panes load whatever URL you give them, and their drawing goes through that unsandboxed GPU process, so open pages you trust.
