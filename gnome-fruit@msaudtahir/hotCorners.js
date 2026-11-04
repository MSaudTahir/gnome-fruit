// Configurable hot corners: each screen corner runs an action when the
// pointer reaches it. GNOME's own (top left only, always Activities) is
// replaced while this is active.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SIZE = 2;
const CORNERS = [
    {key: 'hot-corner-top-left', right: false, bottom: false},
    {key: 'hot-corner-top-right', right: true, bottom: false},
    {key: 'hot-corner-bottom-left', right: false, bottom: true},
    {key: 'hot-corner-bottom-right', right: true, bottom: true},
];

export class HotCorners {
    /**
     * @param {Gio.Settings} settings
     * @param {object} actions - the parts the corners can run: launchpad,
     *   showDesktop and appExpose
     */
    constructor(settings, actions) {
        this._settings = settings;
        this._actions = actions;
        this._actors = [];

        const manager = Main.layoutManager;
        manager._destroyHotCorners();
        manager._updateHotCorners = () => {};
        manager.emit('hot-corners-changed');

        this._build();
        manager.connectObject('monitors-changed', () => this._build(), this);
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        this._clear();

        delete Main.layoutManager._updateHotCorners;
        Main.layoutManager._updateHotCorners();
    }

    _clear() {
        for (const actor of this._actors)
            actor.destroy();
        this._actors = [];
    }

    _build() {
        this._clear();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        for (const {key, right, bottom} of CORNERS) {
            const actor = new St.Widget({reactive: true, width: SIZE, height: SIZE});
            actor._armed = true;
            actor.set_position(
                right ? monitor.x + monitor.width - SIZE : monitor.x,
                bottom ? monitor.y + monitor.height - SIZE : monitor.y);
            actor.connect('enter-event', () => {
                if (actor._armed)
                    this._run(this._settings.get_string(key));
                actor._armed = false;
                return Clutter.EVENT_PROPAGATE;
            });
            // Re-arm once the pointer has really left, not on the
            // enter/leave flicker of the edge pixel.
            actor.connect('leave-event', () => {
                actor._armed = true;
                return Clutter.EVENT_PROPAGATE;
            });
            Main.layoutManager.addChrome(actor);
            this._actors.push(actor);
        }
    }

    _run(action) {
        switch (action) {
        case 'mission-control':
            Main.overview.toggle();
            break;
        case 'launchpad':
            this._actions.launchpad.toggle();
            break;
        case 'show-desktop':
            this._actions.showDesktop.toggle();
            break;
        case 'app-expose':
            this._actions.appExpose.open(Shell.WindowTracker.get_default().focus_app);
            break;
        case 'notification-center':
            Main.panel.statusArea.dateMenu?.menu.toggle();
            break;
        case 'lock-screen':
            Main.screenShield.lock(true);
            break;
        }
    }
}
