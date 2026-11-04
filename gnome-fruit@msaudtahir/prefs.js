import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, {lower, upper, step, digits = 0}) {
    const row = new Adw.SpinRow({
        title,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(settings, key, title, options) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    const sync = () => {
        const index = options.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(index, 0);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () =>
        settings.set_string(key, options[row.selected][0]));
    return row;
}

export default class GnomeFruitPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const stage = new Adw.PreferencesGroup({
            title: _('Stage Manager'),
            description: _('Toggle with Ctrl+Super+S or from Quick Settings.'),
        });
        page.add(stage);
        stage.add(switchRow(settings, 'stage-manager-enabled', _('Enable Stage Manager')));
        stage.add(switchRow(settings, 'stage-manager-group-by-app',
            _('Group windows by app'),
            _('Show all windows of an app together')));
        stage.add(switchRow(settings, 'stage-manager-avoid-strip',
            _('Keep new windows clear of the strip')));
        stage.add(spinRow(settings, 'stage-manager-max-groups',
            _('Recent apps in strip'), {lower: 1, upper: 10, step: 1}));
        stage.add(spinRow(settings, 'stage-manager-tilt',
            _('Thumbnail tilt (degrees)'), {lower: 0, upper: 45, step: 1}));

        const spaces = new Adw.PreferencesGroup({title: _('Spaces')});
        page.add(spaces);
        spaces.add(switchRow(settings, 'fullscreen-spaces',
            _('Full-screen apps get their own space'),
            _('A window that goes full screen moves to a new workspace next to its desktop')));

        spaces.add(switchRow(settings, 'maximize-fullscreen',
            _('Maximize goes full screen'),
            _('The maximize button, a title bar double click and Super+Up make the window full screen. Ctrl+Super+F toggles it too.')));

        const desktop = new Adw.PreferencesGroup({
            title: _('Menu bar and windows'),
            description: _('Force Quit: Alt+Super+Esc. Hide app: Super+H. Hide others: Alt+Super+H. Show Desktop: Super+D.'),
        });
        page.add(desktop);
        desktop.add(switchRow(settings, 'menubar-enabled', _('menu bar'),
            _('System menu and app menu on the left, the clock on the right, no Activities button')));
        desktop.add(switchRow(settings, 'menubar-fruit-layout', _('Compact menu bar layout'),
            _('Hides Activities and puts the clock on the right')));
        desktop.add(switchRow(settings, 'window-buttons-left',
            _('Window buttons on the left'),
            _('Changes the GNOME-wide setting, and puts yours back when turned off')));
        desktop.add(switchRow(settings, 'notifications-right',
            _('Notifications at the top right')));

        const corners = new Adw.PreferencesGroup({title: _('Hot corners')});
        page.add(corners);
        const actions = [
            ['none', _('Nothing')],
            ['mission-control', _('Mission Control')],
            ['launchpad', _('Launchpad')],
            ['notification-center', _('Notification Center')],
            ['lock-screen', _('Lock Screen')],
            ['show-desktop', _('Show Desktop')],
            ['app-expose', _('App Exposé')],
        ];
        corners.add(comboRow(settings, 'hot-corner-top-left', _('Top left'), actions));
        corners.add(comboRow(settings, 'hot-corner-top-right', _('Top right'), actions));
        corners.add(comboRow(settings, 'hot-corner-bottom-left', _('Bottom left'), actions));
        corners.add(comboRow(settings, 'hot-corner-bottom-right', _('Bottom right'), actions));

        const launchpad = new Adw.PreferencesGroup({
            title: _('Launchpad and Spotlight'),
            description: _('Open the Launchpad with Super+A, Spotlight with Super+Space.'),
        });
        page.add(launchpad);
        launchpad.add(switchRow(settings, 'launchpad-gestures',
            _('Pinch to open the Launchpad'),
            _('Pinch with three or more fingers on the touchpad; spread them to close')));
        launchpad.add(switchRow(settings, 'spotlight-enabled', _('Enable Spotlight'),
            _('Search apps, files and settings from anywhere. Takes over Super+Space from switching keyboard layouts.')));

        const dock = new Adw.PreferencesGroup({title: _('Dock')});
        page.add(dock);
        dock.add(switchRow(settings, 'dock-enabled', _('Enable Dock')));
        dock.add(spinRow(settings, 'dock-icon-size',
            _('Icon size'), {lower: 24, upper: 128, step: 2}));
        dock.add(switchRow(settings, 'dock-magnification', _('Magnification')));
        dock.add(spinRow(settings, 'dock-magnification-scale',
            _('Magnification amount'), {lower: 1, upper: 3, step: 0.1, digits: 1}));
        dock.add(comboRow(settings, 'dock-autohide', _('Automatically hide'), [
            ['never', _('Never')],
            ['intellihide', _('When windows overlap')],
            ['always', _('Always')],
        ]));
        dock.add(comboRow(settings, 'dock-minimize-effect', _('Minimize effect'), [
            ['genie', _('Genie')],
            ['scale', _('Scale')],
            ['default', _('GNOME default')],
        ]));
        dock.add(switchRow(settings, 'dock-bounce',
            _('Animate opening applications')));
        dock.add(switchRow(settings, 'dock-show-apps-button',
            _('Show Launchpad button')));
        dock.add(switchRow(settings, 'dock-show-trash', _('Show Trash')));
        dock.add(switchRow(settings, 'dock-show-downloads', _('Show Downloads stack')));
        dock.add(switchRow(settings, 'dock-show-recent', _('Show recent apps')));
        dock.add(switchRow(settings, 'dock-zoom-new-windows', _('Zoom new windows out of the Dock')));
    }
}
