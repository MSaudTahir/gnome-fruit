// Show Desktop: slides every window off the screen edges to reveal the
// desktop, and back again. Windows aren't minimized, so nothing
// else (Stage Manager, the Dock) notices.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DURATION = 400;
// How much of each window stays on screen to click on.
const SLIVER = 60;
const TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];

export class ShowDesktop {
    constructor() {
        this.active = false;
        this._moved = new Set();
    }

    destroy() {
        this._restore(false);
    }

    toggle() {
        if (this.active)
            this._restore(true);
        else
            this._reveal();
    }

    _reveal() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(w =>
            TYPES.includes(w.get_window_type()) && !w.minimized &&
            !w.is_skip_taskbar() && w.get_compositor_private());
        if (!windows.length)
            return;

        this.active = true;
        for (const window of windows) {
            const actor = window.get_compositor_private();
            const monitor = Main.layoutManager.monitors[window.get_monitor()];
            const frame = window.get_frame_rect();
            const toLeft = frame.x + frame.width / 2 < monitor.x + monitor.width / 2;
            const dx = toLeft
                ? monitor.x - frame.x - frame.width + SLIVER
                : monitor.x + monitor.width - frame.x - SLIVER;
            actor.ease({
                translation_x: dx,
                duration: DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            this._moved.add(actor);
            actor.connectObject('destroy', () => this._moved.delete(actor), this);
        }

        // Anything that brings a window back ends it.
        global.display.connectObject(
            'notify::focus-window', () => this._restore(true),
            'window-created', () => this._restore(true),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._restore(false), this);
        Main.overview.connectObject('showing', () => this._restore(false), this);
    }

    _restore(animate) {
        if (!this.active)
            return;
        this.active = false;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);

        for (const actor of this._moved) {
            actor.disconnectObject(this);
            actor.ease({
                translation_x: 0,
                duration: animate ? DURATION : 0,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
        this._moved.clear();
    }
}
