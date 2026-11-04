#!/usr/bin/env bash
# Starts an isolated headless GNOME Shell (own HOME, dconf and session bus)
# with the extension enabled, so it can be exercised without touching the
# running desktop.
#
#   tools/headless-test.sh            start, wait for 'q' / Ctrl-C
#   tools/headless-test.sh start DIR  start in background, write DIR/env
#   tools/headless-test.sh stop DIR
#
# With DIR/env sourced, `tools/shell-eval.sh 'js'` runs JS in that shell.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=gnome-fruit@msaudtahir
cmd=${1:-run}
WORK=${2:-$(mktemp -d)}

if [[ $cmd == stop ]]; then
    source "$WORK/env"
    kill "$SHELL_PID" "$DBUS_PID" 2>/dev/null || true
    # Also stop helpers the test session spawned (dconf, portals, ...).
    for p in $(pgrep -u "$(id -u)"); do
        { tr '\0' '\n' < "/proc/$p/environ"; } 2>/dev/null |
            grep -qx "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" && kill "$p" 2>/dev/null
    done
    [[ $XDG_RUNTIME_DIR == /tmp/gm-run.* ]] && rm -rf "$XDG_RUNTIME_DIR"
    exit 0
fi

export HOME=$WORK/home XDG_CONFIG_HOME=$WORK/config XDG_DATA_HOME=$WORK/data
# Wayland socket paths must fit in 108 bytes, so the runtime dir is short.
export XDG_CACHE_HOME=$WORK/cache XDG_STATE_HOME=$WORK/state
export XDG_RUNTIME_DIR=$(mktemp -d /tmp/gm-run.XXXXXX)
export GIO_USE_VFS=local GVFS_DISABLE_FUSE=1 NO_AT_BRIDGE=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
EXT=$XDG_DATA_HOME/gnome-shell/extensions
mkdir -p "$EXT"
glib-compile-schemas "$ROOT/$UUID/schemas"
cp -r "$ROOT/$UUID" "$EXT/"

# Tiny helper extension that enables org.gnome.Shell.Eval for testing.
mkdir -p "$EXT/unsafe@test"
cat > "$EXT/unsafe@test/metadata.json" <<'J'
{"uuid": "unsafe@test", "name": "unsafe", "description": "test", "shell-version": ["50", "51"]}
J
cat > "$EXT/unsafe@test/extension.js" <<'J'
export default class { enable() { global.context.unsafe_mode = true; } disable() {} }
J

eval "$(dbus-launch --sh-syntax)"
gsettings set org.gnome.shell enabled-extensions "['unsafe@test', '$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.shell disable-extension-version-validation true

gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x900 \
    >"$WORK/shell.log" 2>&1 &
SHELL_PID=$!

cat > "$WORK/env" <<E
export HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_DATA_HOME=$XDG_DATA_HOME
export XDG_CACHE_HOME=$XDG_CACHE_HOME XDG_STATE_HOME=$XDG_STATE_HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR
export DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY=wayland-0
unset DISPLAY
SHELL_PID=$SHELL_PID
DBUS_PID=$DBUS_SESSION_BUS_PID
E

for _ in $(seq 60); do
    if gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell \
        -m org.gnome.Shell.Eval '1' 2>/dev/null | grep -q true; then
        echo "shell ready: $WORK (log: $WORK/shell.log)"
        break
    fi
    sleep 0.5
done

if [[ $cmd == start ]]; then
    exit 0
fi
trap 'kill $SHELL_PID $DBUS_SESSION_BUS_PID 2>/dev/null; rm -rf $XDG_RUNTIME_DIR' EXIT
tail -f "$WORK/shell.log"
