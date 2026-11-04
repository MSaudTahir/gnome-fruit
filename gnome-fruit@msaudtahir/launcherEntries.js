// Listens for the Unity LauncherEntry D-Bus signal, which apps use to put
// an unread count or a progress bar on their launcher (Firefox downloads,
// Thunderbird, Telegram, file copies, ...). GNOME doesn't show these; the
// Dock does.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const INTERFACE = 'com.canonical.Unity.LauncherEntry';
const URI_PREFIX = 'application://';

export const LauncherEntries = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_STRING]}},
}, class LauncherEntries extends GObject.Object {
    _init() {
        super._init();
        // desktop id -> {count, progress, urgent}; only what is visible.
        this._entries = new Map();

        this._subscription = Gio.DBus.session.signal_subscribe(
            null, INTERFACE, 'Update', null, null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, parameters) =>
                this._onUpdate(parameters));

        Shell.AppSystem.get_default().connectObject('app-state-changed',
            (system, app) => {
                // A closed app can't be downloading anything any more.
                if (app.state === Shell.AppState.STOPPED)
                    this._set(app.get_id(), null);
            }, this);
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._subscription);
        Shell.AppSystem.get_default().disconnectObject(this);
        this._entries.clear();
    }

    /**
     * @param {Shell.App} app
     * @returns {?{count: number, progress: number, urgent: boolean}}
     */
    get(app) {
        return this._entries.get(app.get_id()) ?? null;
    }

    _onUpdate(parameters) {
        let uri, props;
        try {
            [uri, props] = parameters.recursiveUnpack();
        } catch (e) {
            return;
        }
        if (!uri?.startsWith(URI_PREFIX))
            return;
        const id = uri.slice(URI_PREFIX.length);

        // Updates only carry what changed.
        const old = this._raw?.get(id) ?? {};
        const state = {...old, ...props};
        this._raw ??= new Map();
        this._raw.set(id, state);

        const entry = {
            count: state['count-visible'] ? Number(state.count ?? 0) : 0,
            progress: state['progress-visible']
                ? Math.min(Math.max(Number(state.progress ?? 0), 0), 1) : -1,
            urgent: !!state.urgent,
        };
        const empty = entry.count <= 0 && entry.progress < 0 && !entry.urgent;
        this._set(id, empty ? null : entry);
    }

    _set(id, entry) {
        if (!entry) {
            this._raw?.delete(id);
            if (!this._entries.delete(id))
                return;
        } else {
            this._entries.set(id, entry);
        }
        this.emit('changed', id);
    }
});
