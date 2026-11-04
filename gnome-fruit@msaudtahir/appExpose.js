// App Exposé: all windows of one app laid out side by side over a blurred
// desktop. Click one to bring it forward; Esc or a click elsewhere closes.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Backdrop} from './backdrop.js';

const DURATION = 300;
const MARGIN_SIDE = 60;
const MARGIN_TOP = 70;
const MARGIN_BOTTOM = 120;
const GAP = 28;
const LABEL_HEIGHT = 34;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export const AppExpose = GObject.registerClass(
class AppExpose extends St.Widget {
    _init() {
        super._init({name: 'fruitAppExpose', reactive: true, visible: false});

        this.isOpen = false;
        this._grab = null;
        this._tiles = [];

        this._backdrop = new Backdrop({radius: 50, brightness: 0.6});
        this.add_child(this._backdrop);
        this.add_child(new St.Widget({
            style_class: 'fruit-expose-background',
            x_expand: true,
            y_expand: true,
            constraints: new Clutter.BindConstraint({
                source: this._backdrop,
                coordinate: Clutter.BindCoordinate.SIZE,
            }),
        }));

        this.connect('key-press-event', (a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.connect('button-release-event', (a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addChrome(this);
        Main.overview.connectObject('showing', () => this.close(), this);
    }

    /**
     * @param {Shell.App} app
     */
    open(app) {
        if (this.isOpen || !app)
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = app.get_windows().filter(w =>
            w.located_on_workspace(workspace) && !w.minimized &&
            w.get_compositor_private());
        if (!windows.length || global.display.is_grabbed())
            return;

        if (Main.overview.visible)
            Main.overview.hide();
        this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW});
        this.isOpen = true;

        const monitor = Main.layoutManager.primaryMonitor;
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, monitor.height);
        this._backdrop.set_size(monitor.width, monitor.height);
        this.get_parent().set_child_below_sibling(this, global.top_window_group);

        this._buildTiles(windows, monitor);

        this.remove_all_transitions();
        this.show();
        this.opacity = 0;
        this.ease({opacity: 255, duration: DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.grab_key_focus();
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._animateOut(() => this._clear());
    }

    // Picks the number of columns that lets windows stay biggest.
    _layout(windows, monitor) {
        const sf = scaleFactor();
        const areaW = monitor.width - 2 * MARGIN_SIDE * sf;
        const areaH = monitor.height - (MARGIN_TOP + MARGIN_BOTTOM) * sf;
        const gap = GAP * sf;
        const label = LABEL_HEIGHT * sf;
        const frames = windows.map(w => w.get_frame_rect());

        let best = null;
        for (let cols = 1; cols <= windows.length; cols++) {
            const rows = Math.ceil(windows.length / cols);
            const cellW = (areaW - gap * (cols - 1)) / cols;
            const cellH = (areaH - gap * (rows - 1)) / rows - label;
            if (cellH <= 0)
                continue;
            const scales = frames.map(f => Math.min(cellW / f.width, cellH / f.height, 1));
            const total = scales.reduce((a, b) => a + b, 0);
            if (!best || total > best.total)
                best = {cols, rows, cellW, cellH, scales, total};
        }
        best ??= {cols: 1, rows: windows.length, cellW: areaW, cellH: areaH / windows.length,
            scales: frames.map(() => 0.2), total: 0};

        const result = [];
        const {cols, rows, cellW, cellH, scales} = best;
        windows.forEach((window, i) => {
            const row = Math.floor(i / cols);
            const inRow = row === rows - 1 ? windows.length - row * cols : cols;
            const rowOffset = (cols - inRow) * (cellW + gap) / 2;
            const col = i % cols;
            const f = frames[i];
            const w = f.width * scales[i];
            const h = f.height * scales[i];
            result.push({
                window,
                scale: scales[i],
                x: monitor.x + MARGIN_SIDE * sf + rowOffset + col * (cellW + gap) + (cellW - w) / 2,
                y: monitor.y + MARGIN_TOP * sf + row * (cellH + label + gap) + (cellH - h) / 2,
                width: w,
                height: h,
                label,
            });
        });
        return result;
    }

    _buildTiles(windows, monitor) {
        this._clear();
        for (const slot of this._layout(windows, monitor)) {
            const {window} = slot;
            const actor = window.get_compositor_private();
            const frame = window.get_frame_rect();
            const buffer = window.get_buffer_rect();

            const clone = new Clutter.Clone({
                source: actor,
                reactive: true,
                width: actor.width,
                height: actor.height,
            });
            // Local coordinates: the container sits at the monitor origin.
            const from = {x: buffer.x - monitor.x, y: buffer.y - monitor.y};
            clone.set_position(from.x, from.y);
            this.add_child(clone);

            const label = new St.Label({
                text: window.get_title() ?? '',
                style_class: 'fruit-expose-label',
                opacity: 0,
            });
            this.add_child(label);

            const highlight = new St.Widget({
                style_class: 'fruit-expose-highlight',
                opacity: 0,
                x: slot.x - monitor.x - 6,
                y: slot.y - monitor.y - 6,
                width: slot.width + 12,
                height: slot.height + 12,
            });
            this.insert_child_below(highlight, clone);

            clone.connect('enter-event', () => highlight.ease({
                opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
            clone.connect('leave-event', () => highlight.ease({
                opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
            clone.connect('button-release-event', (a, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                this.close();
                Main.activateWindow(window);
                return Clutter.EVENT_STOP;
            });

            const toX = slot.x - monitor.x - (frame.x - buffer.x) * slot.scale;
            const toY = slot.y - monitor.y - (frame.y - buffer.y) * slot.scale;
            clone.ease({
                x: toX,
                y: toY,
                scale_x: slot.scale,
                scale_y: slot.scale,
                duration: DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });

            // Centred under the window, kept inside the tile's width.
            label.set_style(`max-width: ${Math.max(slot.width, 120)}px;`);
            const [, labelW] = label.get_preferred_width(-1);
            label.set_position(
                Math.round(slot.x - monitor.x + (slot.width - labelW) / 2),
                Math.round(slot.y - monitor.y + slot.height + 8));
            label.ease({opacity: 255, duration: DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

            this._tiles.push({clone, label, highlight, from, scale: 1,
                frame, buffer, monitor});
        }
    }

    _animateOut(onDone) {
        for (const tile of this._tiles) {
            tile.label.ease({opacity: 0, duration: DURATION / 2});
            tile.highlight.ease({opacity: 0, duration: DURATION / 2});
            tile.clone.ease({
                x: tile.from.x,
                y: tile.from.y,
                scale_x: 1,
                scale_y: 1,
                duration: DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
        this.ease({
            opacity: 0,
            duration: DURATION,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this.isOpen) {
                    this.hide();
                    onDone();
                }
            },
        });
    }

    _clear() {
        for (const {clone, label, highlight} of this._tiles) {
            clone.destroy();
            label.destroy();
            highlight.destroy();
        }
        this._tiles = [];
    }

    _onDestroy() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        Main.overview.disconnectObject(this);
    }
});
