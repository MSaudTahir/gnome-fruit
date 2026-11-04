# TODO

Effort: S = hours, M = a day or two, L = several days.

## Batch 1: desktop feel
- [x] Menu bar: GNOME system menu at the far left (About, System Settings, Software, Force Quit, Sleep, Restart, Shut Down, Lock, Log Out) (S-M)
- [x] Menu bar: focused app name with Hide, Hide Others, New Window, Quit (M)
- [x] Menu bar: Compact clock format, on the right (S)
- [x] Window buttons on the left, as a setting (S)
- [x] Notification banners top right (S)
- [x] Trash in the Dock: empty/full icon, open, Empty Trash (drop-to-delete dropped: file drags from other apps never reach the Shell) (M)
- [x] Hot corners with configurable actions (S-M)
- [x] Force Quit dialog, Alt+Super+Esc (S)

## Batch 2
- [x] Dock badges and progress bars (unity LauncherEntry) (M)
- [x] Mission Control labels ("Desktop 1", full-screen app names) and bigger thumbnails (M; no add-desktop button: GNOME always keeps a spare empty desktop at the end)
- [x] Hide app (Super+H) and Hide Others (M)
- [x] App Exposé (M)
- [x] Dock right-click menu: Show All Windows added to GNOME's own menu, which already has Open Windows, New Window, Pin and Quit (S)
- [ ] ~~Drop a file onto a Dock app icon to open it~~ not feasible: file drags from other apps never reach the Shell
- [x] Recent apps in the Dock, after the running apps (S)
- [x] Show Desktop: Super+D and hot corner (M; the four-finger gesture is left out, and so is "click the wallpaper")

## Batch 3
- [x] Window tiling: halves, quarters, fill and centre by keyboard (M; no drag-to-corner and no green-button popover, since client-side buttons can't be hooked)
- [x] Downloads stack in the Dock: newest 15 files in a grid above the icon, with thumbnails (M; Downloads only, not arbitrary folders, and no fan view)
- [x] New windows zoom out of their Dock icon (S-M)
- [x] Spotlight: "Search the web" row, also on Enter when nothing matches (S). Unit and currency conversion already works through GNOME Calculator's search provider, so nothing was added.

## Not feasible in an extension
- Global menu bar for app menus (no Wayland protocol; GTK4 dropped it)
- Quick Look (install `sushi`)
