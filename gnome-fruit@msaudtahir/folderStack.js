// A Dock stack: the newest files of a folder in a grid above its Dock icon,
// like the Downloads stack.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Backdrop} from './backdrop.js';

const MAX_FILES = 15;
const COLUMNS = 5;
const CELL_WIDTH = 96;
const ICON_SIZE = 56;
const CORNER_RADIUS = 18;
const OPEN_DURATION = 150;
const ATTRIBUTES = [
    'standard::name', 'standard::display-name', 'standard::icon',
    'standard::is-hidden', 'standard::is-backup', 'time::modified',
    'thumbnail::path',
].join(',');

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export const StackPopup = GObject.registerClass(
class StackPopup extends St.Widget {
    /**
     * @param {Gio.File} folder
     * @param {Function} onClosed
     */
    _init(folder, onClosed) {
        super._init({reactive: true, visible: false});
        this._folder = folder;
        this._onClosed = onClosed;
        this._grab = null;
        this.isOpen = false;
        this._cancellable = null;

        this._panel = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.add_child(this._panel);
        this._backdrop = new Backdrop({
            radius: 60,
            brightness: 0.8,
            cornerRadius: CORNER_RADIUS * scaleFactor(),
        });
        this._panel.add_child(this._backdrop);

        this._box = new St.BoxLayout({
            style_class: 'fruit-stack',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._panel.add_child(this._box);

        this._grid = new St.Widget({layout_manager: new Clutter.GridLayout()});
        this._box.add_child(this._grid);

        const open = new St.Button({
            style_class: 'fruit-stack-open',
            label: _('Open in Files'),
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        open.connect('clicked', () => {
            this.close();
            this._launch(this._folder);
        });
        this._box.add_child(open);

        this.connect('key-press-event', (a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.connect('button-release-event', (a, event) => {
            const target = global.stage.get_event_actor(event);
            if (target && this._panel.contains(target))
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => {
            this._cancellable?.cancel();
            if (this._grab)
                Main.popModal(this._grab);
            this._grab = null;
        });

        Main.layoutManager.addTopChrome(this);
    }

    _launch(file) {
        try {
            Gio.AppInfo.launch_default_for_uri(file.get_uri(),
                global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`Stack: can't open ${file.get_uri()}: ${e.message}`);
        }
    }

    _cell(info) {
        const file = this._folder.get_child(info.get_name());
        const button = new St.Button({
            style_class: 'fruit-stack-cell',
            can_focus: true,
            width: CELL_WIDTH * scaleFactor(),
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const thumbnail = info.get_attribute_byte_string('thumbnail::path');
        const gicon = thumbnail
            ? new Gio.FileIcon({file: Gio.File.new_for_path(thumbnail)})
            : info.get_icon();
        box.add_child(new St.Icon({
            gicon,
            icon_size: ICON_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            text: info.get_display_name(),
            style_class: 'fruit-stack-name',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set({
            line_wrap: true,
            ellipsize: 3, // END
            line_wrap_mode: 2, // WORD_CHAR
        });
        label.clutter_text.set_line_alignment?.(1);
        box.add_child(label);

        button.set_child(box);
        button.connect('clicked', () => {
            this.close();
            this._launch(file);
        });
        return button;
    }

    _fill(infos) {
        this._grid.destroy_all_children();
        const layout = this._grid.layout_manager;
        infos.forEach((info, i) => {
            layout.attach(this._cell(info), i % COLUMNS, Math.floor(i / COLUMNS), 1, 1);
        });
        if (!infos.length) {
            this._grid.add_child(new St.Label({
                text: _('This folder is empty'),
                style_class: 'fruit-stack-name',
            }));
        }
        this._place();
    }

    _load() {
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        this._folder.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
            0, cancellable, (folder, result) => {
                let enumerator;
                try {
                    enumerator = folder.enumerate_children_finish(result);
                } catch (e) {
                    return;
                }
                enumerator.next_files_async(1000, 0, cancellable, (en, res) => {
                    try {
                        const infos = en.next_files_finish(res)
                            .filter(i => !i.get_is_hidden() && !i.get_is_backup())
                            .sort((a, b) => b.get_modification_date_time().to_unix() -
                                a.get_modification_date_time().to_unix())
                            .slice(0, MAX_FILES);
                        this._fill(infos);
                        enumerator.close_async(0, null, null);
                    } catch (e) {
                        // Cancelled, or the folder went away.
                    }
                });
            });
    }

    // Sits above the Dock icon, kept on screen. Runs again once the files
    // have filled the grid and the panel has its final size.
    _place() {
        if (!this._anchor)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const sf = scaleFactor();
        // A size set earlier would be the preferred size now.
        this._panel.set_size(-1, -1);
        const [, natWidth] = this._panel.get_preferred_width(-1);
        const [, natHeight] = this._panel.get_preferred_height(natWidth);
        const [x, y] = this._anchor.get_transformed_position();
        this._panel.set_size(natWidth, natHeight);
        this._panel.set_position(
            Math.round(Math.clamp(x + this._anchor.width / 2 - monitor.x - natWidth / 2,
                8 * sf, monitor.width - natWidth - 8 * sf)),
            Math.round(y - monitor.y - natHeight - 12 * sf));
        // The backdrop's copy of the screen has to follow the panel.
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._backdrop.syncPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {Clutter.Actor} anchor - the Dock icon the stack rises from
     */
    open(anchor) {
        if (this.isOpen || global.display.is_grabbed())
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this.isOpen = true;
        this._anchor = anchor;
        this._load();

        const monitor = Main.layoutManager.primaryMonitor;
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, monitor.height);
        this._place();

        this.remove_all_transitions();
        this.show();
        this.opacity = 0;
        this.ease({opacity: 255, duration: OPEN_DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.ease({
            opacity: 0,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this.isOpen)
                    this.hide();
            },
        });
        this._onClosed?.();
    }
});
