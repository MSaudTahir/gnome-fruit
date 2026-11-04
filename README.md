# GNOME Fruit

A GNOME Shell 50/51 extension that adds a **Stage Manager**, **Dock**, **Launchpad**, **Spotlight** and **full-screen spaces** to GNOME, and turns the Activities overview into a windows-only Mission Control. It follows GNOME and libadwaita styling, and every layout choice is a switch in Preferences.

## Stage Manager

- The focused app's windows sit centre stage. Other recent apps are tucked into a strip on the left as live, tilted thumbnails with an app badge.
- **Click** a thumbnail to swap it onto the stage. The current windows fly into the strip and the chosen ones fly out.
- **Shift-click**, **middle-click**, or **drag** a thumbnail onto the stage to add its windows to the current set.
- **Drag a window** into the strip to split it into its own set.
- Alt-Tab, dock clicks and new windows all bring their set on stage. Closing the last window on stage brings the most recent set forward.
- The strip slides away when a stage window overlaps it. Push the pointer against the left edge to bring it back.
- New windows are placed clear of the strip.
- Optional: toggle it with **Ctrl+Super+S**, the **Stage Manager** tile in Quick Settings, or in Preferences.

## Dock

- A frosted, floating dock built on GNOME's own Dash, so favourites, drag-to-reorder, right-click menus and running indicators all keep working.
- **Files** and the **Launchpad** button always come first. Your favourites list itself isn't changed.
- **Minimized windows** appear after a separator on the right as live thumbnails with an app badge. Windows genie into their thumbnail and back out when clicked. Windows Stage Manager tucks away stay in the strip, not the Dock.
- **Bounces** while an app launches, and when a window needs attention.
- **Genie** minimize (or a scale effect, or GNOME's default).
- Auto-hide (Preferences → *Automatically hide*): never (reserves screen space), when windows overlap, or always.
- **Badges and progress bars**: apps that report an unread count or progress (Firefox downloads, Thunderbird, Telegram, file copies) show a red badge or a bar on their icon, and an urgent flag makes it bounce.
- **App Exposé**: right-click an app, then Show All Windows, to see all its windows side by side over a blurred desktop. Click one to bring it forward. Also available as a hot corner action.
- **Trash** at the right end: empty and full icons, opens on click, and Empty Trash on right-click. You can't drop files on it, because file drags between apps don't pass through the Shell.
- **Downloads stack** before the Trash: click it for a grid of the newest 15 files (with thumbnails), click one to open it, or "Open in Files".
- **New windows zoom** out of their app's Dock icon (turn it off in Preferences).
- **Recent apps**: the last three apps you opened stay in the Dock after they quit (a preference turns it off).
- Optional fish-eye magnification (off by default).
- The Dock replaces GNOME's overview dash: the overview has no dock, and the grid button opens the Launchpad.

## Launchpad

- A full-screen app grid over a blurred desktop, separate from the overview. Opens from the Dock's grid button, **Super+A**, or anything that calls `Main.overview.showApps()`.
- **Pinch** with three or more fingers on a touchpad to open it, and spread them to close it. It follows your fingers, so a half pinch springs back. You can turn this off in Preferences.
- Fits more apps per row (up to 10, depending on screen width), alphabetical, in pages. **Swipe** with two fingers, scroll, use the arrow keys or click the page dots to change pages.
- Type to search; **Enter** opens the first result. **Esc** clears the search, then closes. Clicking empty space closes it.
- The Dock stays on top, so apps can be dragged from the grid into the Dock.

## Menu bar and windows

- The top bar gets a **GNOME system menu** at the far left (About, System Settings, Software, **Force Quit…**, Sleep, Restart, Shut Down, Lock Screen, Log Out), then the focused app's name in bold with its own menu (Hide, Hide Others, New Window, Quit). The Activities button is hidden, and the clock moves to the right in a compact format ("Mon 26 Oct  11:40 AM") when the compact menu bar layout is on.
- App menus (File, Edit, …) can't be shown in the bar: Wayland has no protocol for it, and GTK4 apps don't export their menus.
- **Hide** (Super+H) hides every window of the focused app, and **Hide Others** (Alt+Super+H) hides every other app. Super+H replaces GNOME's "minimize this window".
- **Show Desktop** (Super+D, or a hot corner) slides every window to the screen edge, leaving a sliver, and back again. Windows aren't minimized.
- **Mission Control labels**: the overview's desktop thumbnails are larger and named "Desktop N", or after the app for a full-screen space.
- **Force Quit** (Alt+Super+Esc, or from the system menu) lists running apps and kills the selected one.
- **Window buttons on the left**, and **notification banners at the top right**. The first changes GNOME's `button-layout` setting; the extension puts yours back when you turn it off or disable the extension (not if you log out with it on).
- **Hot corners**: pick an action for each corner in Preferences (Mission Control, Launchpad, Notification Center, Lock Screen). GNOME's own top-left corner is replaced while the extension is on.

## Look

The look follows GNOME and libadwaita: flat dark surfaces with soft shadows, rounded corners, pill-shaped labels and the system accent colour. Window buttons stay on the right, notification banners stay at the top centre, and the clock stays in the middle. The alternative arrangements are still there as switches in Preferences ("Window buttons on the left", "Show notification banners at the top right", "Compact menu bar layout"), and Stage Manager's tilt is 0 by default. The frosted-glass blur can come back by setting `FROSTED = true` in `backdrop.js`.

## Spotlight

- A floating search bar. Open it with **Super+Space** or the magnifier in the top bar.
- It uses GNOME's own search, so it finds everything the overview search does: apps, files, settings, calculations, characters and any other installed search providers.
- **Enter** opens the top result, **Tab** or **Down** moves into the results. **Esc** clears the search, then closes. Clicking outside closes it.
- Super+Space normally switches keyboard layouts. While Spotlight is on, it takes that shortcut over (Shift+Super+Space still switches backwards) and hands it back when turned off. You can turn Spotlight off in Preferences.
- A "Search the web for …" row sits under the results (DuckDuckGo); Enter uses it when nothing else matches. Unit and currency conversions ("12 km in miles") come from GNOME Calculator's search provider.

## Window tiling

Shortcuts put the focused window in part of the screen. With Stage Manager on, the strip is left clear.

| Shortcut | Action |
| --- | --- |
| Ctrl+Super+Left / Right / Up / Down | left, right, top or bottom half |
| Ctrl+Super+U / I / J / K | top left, top right, bottom left, bottom right quarter |
| Ctrl+Super+Return | fill the screen |
| Ctrl+Super+C | centre |

The keys are `tile-*` settings (gsettings or dconf), not in Preferences. Dragging a window to a corner doesn't tile it.

## Overview and spaces

- **Activities** shows only windows and workspaces, like Mission Control.
- Workspaces stay. A window that goes **full screen** moves to a new workspace of its own, right after the desktop it came from, so desktops and full-screen apps sit side by side. Leaving full screen or closing the window returns to that desktop and removes the space. You can turn this off in Preferences.
- **Maximize goes full screen**: the maximize button, a title bar double click and Super+Up make the window full screen (and so give it a space). **Ctrl+Super+F** toggles full screen for the focused window. A Preferences switch turns this off, for plain maximize.

## Install

```sh
make install
```

Log out and back in (Wayland can't reload the shell), then run:

```sh
gnome-extensions enable gnome-fruit@msaudtahir
gnome-extensions prefs gnome-fruit@msaudtahir   # settings
```

To remove it, run `make uninstall`.

## Testing without touching your session

```sh
make test                                   # headless shell, tails its log
tools/headless-test.sh start /some/dir      # or run it in the background
source /some/dir/env && tools/shell-eval.sh 'global.display.focus_window?.title'
tools/headless-test.sh stop /some/dir
```

This starts a throwaway headless GNOME Shell (1600×900 virtual monitor) with its own HOME, dconf and session bus, and enables this extension. Run apps against it with the `env` file sourced. Screenshots come from `org.gnome.Shell.Screenshot`.

## Files

| File | Purpose |
| --- | --- |
| `extension.js` | Entry point, Quick Settings toggle, shortcuts, app grid redirect |
| `stageManager.js` | Window groups, strip UI, switching and flight animations |
| `dock.js` | Dock (a subclass of GNOME's `Dash`), minimized windows, bounce, auto-hide |
| `launchpad.js` | Launchpad app grid and its touchpad gestures |
| `spotlight.js` | Spotlight search bar and top bar button |
| `menubar.js` | System menu, app menu and clock in the top bar |
| `forceQuit.js` | Force Quit dialog |
| `appExpose.js` | App Exposé |
| `showDesktop.js` | Show Desktop |
| `missionControl.js` | Mission Control labels |
| `tiling.js` | Window tiling shortcuts |
| `lockGuard.js` | Keeps the lock screen above the Dock and strip |
| `folderStack.js` | Downloads stack popup |
| `windowActions.js` | Hide and Hide Others |
| `launcherEntries.js` | Unity LauncherEntry badges and progress |
| `hotCorners.js` | Configurable hot corners |
| `spaces.js` | Full-screen windows in their own workspaces |
| `backdrop.js` | Blurred, optionally rounded backdrop for the Dock, Launchpad and Spotlight |
| `windowEffects.js` | Takes over minimize/unminimize animations; GLSL genie effect |
| `prefs.js` | Preferences window |

## Notes and limitations

- **Minimize animations.** GNOME connects its minimize/unminimize animation handlers with bound closures. While the extension is enabled it *blocks* those handlers and routes the events itself. If they can't be found, it leaves them alone and falls back to stock animations.
- **Blur.** The Dock and Launchpad blur a live copy of the desktop and windows rather than the screen behind them. GNOME's screen-behind blur smears and flickers whenever only part of the actor is redrawn (hovering an icon, say). The copy doesn't include other Shell chrome, such as the top bar or the Stage Manager strip.
- **Genie effect.** The genie is a fragment shader. `Clutter.DeformEffect` renders nothing on Mutter 18, including GNOME's own `PageTurnEffect`.
- **Primary monitor only.** Stage Manager only manages normal windows on the primary monitor. Windows that can't be minimized (some modal dialogs) are left on stage.
- **Screen lock.** The extension stays enabled on the lock screen (`unlock-dialog` session mode). Otherwise every lock would restore all hidden windows.
