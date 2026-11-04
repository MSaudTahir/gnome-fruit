// Force Quit: a list of running apps with a button to kill the selected one,
// like Alt+Super+Esc.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const ICON_SIZE = 32;

const ForceQuitDialog = GObject.registerClass(
class ForceQuitDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({styleClass: 'fruit-force-quit', destroyOnClose: true});

        this._selected = null;
        this._rows = new Map();

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fruit-force-quit-content',
        });
        content.add_child(new St.Label({
            text: _('Force Quit Applications'),
            style_class: 'fruit-force-quit-title',
        }));
        content.add_child(new St.Label({
            text: _('If an app doesn’t respond, select it and choose Force Quit.'),
            style_class: 'fruit-force-quit-description',
        }));

        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'fruit-force-quit-list',
        });
        const scroll = new St.ScrollView({
            child: this._list,
            style_class: 'fruit-force-quit-scroll',
            overlay_scrollbars: true,
        });
        content.add_child(scroll);
        this.contentLayout.add_child(content);

        this._apps = Shell.AppSystem.get_default().get_running();
        for (const app of this._apps)
            this._addRow(app);
        this._select(this._apps.find(a => a.get_state() === Shell.AppState.RUNNING &&
            a.get_windows().some(w => w.has_focus())) ?? this._apps[0] ?? null);

        this._quitButton = this.addButton({
            label: _('Force Quit'),
            action: () => this._forceQuit(),
            default: true,
        });
        this.addButton({
            label: _('Cancel'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
        });
        this._syncButton();
    }

    _addRow(app) {
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({
            gicon: app.get_icon(),
            icon_size: ICON_SIZE,
            style_class: 'fruit-force-quit-icon',
        }));
        box.add_child(new St.Label({
            text: app.get_name(),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const row = new St.Button({
            style_class: 'fruit-force-quit-row',
            can_focus: true,
            x_expand: true,
            child: box,
        });
        row.connect('clicked', () => this._select(app));
        this._rows.set(app, row);
        this._list.add_child(row);
    }

    _select(app) {
        this._selected = app;
        for (const [a, row] of this._rows) {
            if (a === app)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        }
        this._syncButton();
    }

    _syncButton() {
        this._quitButton?.set_reactive(!!this._selected);
        this._quitButton?.set_can_focus(!!this._selected);
    }

    _forceQuit() {
        const app = this._selected;
        this.close();
        if (!app)
            return;
        for (const window of app.get_windows())
            window.kill();
    }
});

export function openForceQuit() {
    new ForceQuitDialog().open();
}
