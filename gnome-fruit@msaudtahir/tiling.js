// Window tiling, like the classic desktop: keyboard shortcuts that put the focused
// window in a half or quarter of the screen, fill it, or centre it.
// With Stage Manager on, the strip is left clear.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Each action: the fraction of the area as [x, y, width, height].
const ACTIONS = {
    'tile-left': [0, 0, 0.5, 1],
    'tile-right': [0.5, 0, 0.5, 1],
    'tile-top': [0, 0, 1, 0.5],
    'tile-bottom': [0, 0.5, 1, 0.5],
    'tile-top-left': [0, 0, 0.5, 0.5],
    'tile-top-right': [0.5, 0, 0.5, 0.5],
    'tile-bottom-left': [0, 0.5, 0.5, 0.5],
    'tile-bottom-right': [0.5, 0.5, 0.5, 0.5],
    'tile-fill': [0, 0, 1, 1],
};
const CENTER = 'tile-center';

export class Tiling {
    /**
     * @param {Gio.Settings} settings
     * @param {Function} getStageManager - the current StageManager, or null
     */
    constructor(settings, getStageManager) {
        this._settings = settings;
        this._getStageManager = getStageManager;

        for (const name of [...Object.keys(ACTIONS), CENTER]) {
            Main.wm.addKeybinding(name, settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this._run(name));
        }
    }

    destroy() {
        for (const name of [...Object.keys(ACTIONS), CENTER])
            Main.wm.removeKeybinding(name);
    }

    // The room windows have, less Stage Manager's strip.
    _area(window) {
        const {x, y, width, height} = window.get_work_area_current_monitor();
        const area = {x, y, width, height};
        const layout = this._getStageManager()?.strip?.layout;
        if (layout) {
            layout.update();
            if (window.get_monitor() === layout.monitor.index && layout.right > area.x) {
                area.width -= layout.right - area.x;
                area.x = layout.right;
            }
        }
        return area;
    }

    _run(name) {
        const window = global.display.focus_window;
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL ||
            !window.allows_move() || !window.allows_resize() && name !== CENTER)
            return;

        if (window.is_fullscreen())
            window.unmake_fullscreen();
        if (window.is_maximized())
            window.unmaximize();

        const area = this._area(window);
        if (name === CENTER) {
            const frame = window.get_frame_rect();
            window.move_frame(true,
                Math.round(area.x + (area.width - frame.width) / 2),
                Math.round(area.y + (area.height - frame.height) / 2));
            return;
        }

        const [fx, fy, fw, fh] = ACTIONS[name];
        // Rounded edges, so neighbouring tiles meet without a gap.
        const left = Math.round(area.x + area.width * fx);
        const top = Math.round(area.y + area.height * fy);
        const right = Math.round(area.x + area.width * (fx + fw));
        const bottom = Math.round(area.y + area.height * (fy + fh));
        window.move_resize_frame(true, left, top, right - left, bottom - top);
    }
}
