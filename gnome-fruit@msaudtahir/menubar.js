// Turns the top bar into a menu bar: a GNOME system menu
// at the far left, the focused app's name with its own menu next to it, and
// the clock in a compact format on the right.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {openForceQuit} from './forceQuit.js';
import {hideApp, hideOthers} from './windowActions.js';

function sessionCall(method, parameters = null) {
    Gio.DBus.session.call(
        'org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', method, parameters, null,
        Gio.DBusCallFlags.NONE, -1, null, null);
}

function suspend() {
    Gio.DBus.system.call(
        'org.freedesktop.login1', '/org/freedesktop/login1',
        'org.freedesktop.login1.Manager', 'Suspend',
        new GLib.Variant('(b)', [true]), null,
        Gio.DBusCallFlags.NONE, -1, null, null);
}

const SystemMenu = GObject.registerClass(
class SystemMenu extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, _('System menu'), false);
        // Bundled, so it's the GNOME logo whatever the icon theme does with
        // start-here.
        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extensionPath}/icons/gnome-symbolic.svg`),
            style_class: 'system-status-icon',
        }));

        const add = (label, callback) => this.menu.addAction(label, callback);
        const separator = () => this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        add(_('About This Computer'), () =>
            Util.spawn(['gnome-control-center', 'system', 'about']));
        separator();
        add(_('System Settings…'), () => Util.spawn(['gnome-control-center']));
        const software = Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop');
        if (software)
            add(_('Software…'), () => software.activate());
        separator();
        add(_('Force Quit…'), () => openForceQuit());
        separator();
        add(_('Sleep'), () => suspend());
        add(_('Restart…'), () => sessionCall('Reboot'));
        add(_('Shut Down…'), () => sessionCall('Shutdown'));
        separator();
        add(_('Lock Screen'), () => Main.screenShield.lock(true));
        add(_('Log Out…'), () => sessionCall('Logout', new GLib.Variant('(u)', [0])));
    }
});

const AppMenu = GObject.registerClass(
class AppMenu extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Application menu'), false);
        this._app = null;

        this._label = new St.Label({
            style_class: 'fruit-app-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._hide = this.menu.addAction('', () => this._hideApp());
        this._hideOthers = this.menu.addAction(_('Hide Others'), () => this._hideOtherApps());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._newWindow = this.menu.addAction(_('New Window'), () =>
            this._app?.open_new_window(-1));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._quit = this.menu.addAction('', () => this._app?.request_quit());

        this.hide();
    }

    setApp(app) {
        this._app = app;
        if (!app) {
            this.hide();
            return;
        }
        const name = app.get_name();
        this._label.text = name;
        this._hide.label.text = _('Hide %s').format(name);
        this._quit.label.text = _('Quit %s').format(name);
        this._newWindow.visible = app.can_open_new_window();
        this.show();
    }

    _hideApp() {
        hideApp(this._app);
    }

    _hideOtherApps() {
        hideOthers(this._app);
    }
});

export class MenuBar {
    constructor(extensionPath, settings) {
        const panel = Main.panel;
        this._macLayout = settings.get_boolean('menubar-fruit-layout');

        this._systemMenu = new SystemMenu(extensionPath);
        panel.addToStatusArea('fruit-system-menu', this._systemMenu, 0, 'left');
        this._appMenu = new AppMenu();
        panel.addToStatusArea('fruit-app-menu', this._appMenu, 1, 'left');

        // No Activities button; Mission Control has hot corners
        // and gestures instead.
        this._activities = this._macLayout
            ? panel.statusArea.activities?.container ?? null : null;
        this._activities?.hide();

        this._tracker = Shell.WindowTracker.get_default();
        this._app = null;
        this._tracker.connectObject('notify::focus-app', () => this._syncApp(), this);
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', () => this._syncApp(), this);
        this._syncApp();

        if (this._macLayout)
            this._moveClock();
    }

    destroy() {
        this._tracker.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        if (this._macLayout)
            this._restoreClock();
        this._activities?.show();
        this._systemMenu.destroy();
        this._appMenu.destroy();
    }

    _syncApp() {
        const focus = this._tracker.focus_app;
        if (focus)
            this._app = focus;
        else if (this._app && this._app.state !== Shell.AppState.RUNNING)
            this._app = null;
        this._appMenu.setApp(this._app);
    }

    // The clock moves to the right and uses a compact format.

    _moveClock() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;
        this._dateMenu = dateMenu;
        const container = dateMenu.container;
        container.get_parent().remove_child(container);
        Main.panel._rightBox.add_child(container);

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // The shell's own binding updates the label first; ours overwrites it.
        dateMenu._clock.connectObject('notify::clock', () => this._updateClock(), this);
        this._interface.connectObject('changed::clock-format', () => this._updateClock(), this);
        this._updateClock();
    }

    _updateClock() {
        const format24 = this._interface.get_string('clock-format') === '24h';
        const time = format24 ? '%H:%M' : '%-I:%M %p';
        const now = GLib.DateTime.new_now_local();
        this._dateMenu._clockDisplay.text = now.format(`%a %-d %b  ${time}`);
    }

    _restoreClock() {
        const dateMenu = this._dateMenu;
        if (!dateMenu)
            return;
        dateMenu._clock.disconnectObject(this);
        this._interface.disconnectObject(this);
        dateMenu._clockDisplay.text = dateMenu._clock.clock;

        const container = dateMenu.container;
        container.get_parent().remove_child(container);
        Main.panel._centerBox.insert_child_at_index(container, 0);
    }
}
