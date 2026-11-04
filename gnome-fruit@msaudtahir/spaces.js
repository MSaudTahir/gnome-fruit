// full-screen spaces: a window that goes full screen moves to
// a workspace of its own, inserted right after the desktop it came from,
// so desktops and full-screen apps sit side by side. Leaving full screen
// or closing the window returns to that desktop and drops the space.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SPACE_TYPES = [Meta.WindowType.NORMAL];
// Let the workspace switch animation finish before removing a space.
const REMOVE_DELAY = 700;

export class FullscreenSpaces {
    constructor(settings) {
        this._settings = settings;
        // window -> {origin, space}
        this._spaces = new Map();
        this._idles = new Set();

        global.display.connectObject('window-created',
            (d, window) => this._track(window), this);
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
    }

    destroy() {
        global.display.disconnectObject(this);
        for (const actor of global.get_window_actors())
            actor.meta_window.disconnectObject(this);
        for (const id of this._idles)
            GLib.source_remove(id);
        this._idles.clear();
        // Leave windows where they are; the spaces become plain workspaces.
        for (const {origin} of this._spaces.values())
            this._release(origin);
        this._spaces.clear();
    }

    _track(window) {
        if (!SPACE_TYPES.includes(window.get_window_type()))
            return;
        window.connectObject(
            // Fullscreen is toggled mid-configure; act once it has settled.
            'notify::fullscreen', () => this._idle(() => this._sync(window)),
            'notify::maximized-horizontally', () => this._idle(() => this._maximized(window)),
            'notify::maximized-vertically', () => this._idle(() => this._maximized(window)),
            'unmanaging', () => this._onClosed(window),
            this);
    }

    _idle(callback, delay = 0) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._idles.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._idles.add(id);
    }

    // The maximize button goes full screen, so a maximize becomes
    // one (the title bar button, a double click on it, Super+Up).
    _maximized(window) {
        if (!this._settings.get_boolean('maximize-fullscreen'))
            return;
        if (!window.get_compositor_private() || !window.is_maximized() ||
            window.is_fullscreen() || !window.can_maximize())
            return;
        window.unmaximize();
        window.make_fullscreen();
    }

    _sync(window) {
        if (!window.get_compositor_private())
            return;
        const entry = this._spaces.get(window);
        if (window.is_fullscreen() && !entry)
            this._enter(window);
        else if (!window.is_fullscreen() && entry)
            this._leave(window, entry);
    }

    _enter(window) {
        const origin = window.get_workspace();
        if (!origin || window.is_on_all_workspaces())
            return;

        const manager = global.workspace_manager;
        const time = global.get_current_time();
        const space = manager.append_new_workspace(false, time);
        manager.reorder_workspace(space, origin.index() + 1);
        this._spaces.set(window, {origin, space});
        this._hold(origin);

        window.change_workspace(space);
        space.activate_with_focus(window, time);
    }

    // GNOME's dynamic workspaces drop empty ones, and an origin whose only
    // window went full screen is empty. A truthy keep-alive id stops that.
    _hold(workspace) {
        workspace._fruitHolds = (workspace._fruitHolds ?? 0) + 1;
        workspace._keepAliveId ||= -1;
    }

    _release(workspace) {
        if (!workspace._fruitHolds || --workspace._fruitHolds > 0)
            return;
        if (workspace._keepAliveId === -1)
            workspace._keepAliveId = 0;
        Main.wm._workspaceTracker._queueCheckWorkspaces();
    }

    _leave(window, {origin, space}) {
        this._spaces.delete(window);
        this._release(origin);
        const time = global.get_current_time();

        if (this._exists(origin)) {
            // Show the desktop first, so the window arrives on an active
            // workspace (Stage Manager then keeps it on stage).
            if (space.active)
                origin.activate(time);
            window.change_workspace(origin);
            window.activate(time);
        }
        this._idle(() => this._removeIfEmpty(space), REMOVE_DELAY);
    }

    _onClosed(window) {
        window.disconnectObject(this);
        const entry = this._spaces.get(window);
        if (!entry)
            return;
        this._spaces.delete(window);

        const {origin, space} = entry;
        this._release(origin);
        if (space.active && this._exists(origin))
            origin.activate(global.get_current_time());
        // The window is still on the space while it unmanages.
        this._idle(() => this._removeIfEmpty(space), REMOVE_DELAY);
    }

    _exists(workspace) {
        const manager = global.workspace_manager;
        const index = workspace.index();
        return index >= 0 && manager.get_workspace_by_index(index) === workspace;
    }

    _removeIfEmpty(space) {
        const manager = global.workspace_manager;
        if (!this._exists(space) || manager.n_workspaces <= 1)
            return;
        const occupied = space.list_windows().some(w =>
            !w.is_on_all_workspaces() && w.get_window_type() !== Meta.WindowType.DESKTOP);
        if (!occupied && !space.active)
            manager.remove_workspace(space, global.get_current_time());
    }
}
