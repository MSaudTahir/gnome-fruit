// Mission Control labels: each workspace thumbnail in the overview is named
// "Desktop N", or after the app when it is a full-screen space.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const THUMBNAIL_SCALE = 0.15;

export class MissionControlLabels {
    constructor() {
        this._box = Main.overview._overview._controls._thumbnailsBox;
        this._labels = new Map();

        // Bigger thumbnails, with room for the labels.
        this._oldScale = this._box._maxThumbnailScale;
        this._box._maxThumbnailScale = THUMBNAIL_SCALE;
        this._box.queue_relayout();

        // Thumbnails come and go as workspaces do.
        for (const name of ['addThumbnails', 'removeThumbnails']) {
            const original = this._box[name];
            this._box[name] = (...args) => {
                original.apply(this._box, args);
                this._sync();
            };
        }

        Main.overview.connectObject('showing', () => this._sync(), this);
        global.workspace_manager.connectObject(
            'workspaces-reordered', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        Main.overview.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._box._maxThumbnailScale = this._oldScale;
        this._box.queue_relayout();
        delete this._box.addThumbnails;
        delete this._box.removeThumbnails;
        for (const [thumbnail, label] of [...this._labels]) {
            thumbnail.disconnectObject(this);
            label.destroy();
        }
        this._labels.clear();
    }

    // Workspaces holding a full-screen window are named after its app; the
    // rest count up as desktops.
    _names() {
        const tracker = Shell.WindowTracker.get_default();
        const manager = global.workspace_manager;
        const names = new Map();
        let desktop = 0;
        for (let i = 0; i < manager.n_workspaces; i++) {
            const workspace = manager.get_workspace_by_index(i);
            const full = workspace.list_windows().find(w => w.is_fullscreen());
            if (full) {
                names.set(workspace, tracker.get_window_app(full)?.get_name() ??
                    full.get_title());
            } else {
                names.set(workspace, _('Desktop %d').format(++desktop));
            }
        }
        return names;
    }

    _sync() {
        const names = this._names();
        const live = new Set(this._box._thumbnails);
        for (const [thumbnail, label] of this._labels) {
            if (live.has(thumbnail))
                continue;
            label.destroy();
        }

        for (const thumbnail of this._box._thumbnails) {
            const name = names.get(thumbnail.metaWorkspace);
            if (name === undefined)
                continue;

            let label = this._labels.get(thumbnail);
            if (!label) {
                label = new St.Label({
                    style_class: 'fruit-mission-label',
                    reactive: false,
                });
                thumbnail.add_child(label);
                thumbnail.connectObject('notify::allocation',
                    () => this._place(thumbnail, label), this);
                this._labels.set(thumbnail, label);
                // Thumbnails take their labels with them when they go.
                label.connect('destroy', () => this._labels.delete(thumbnail));
            }
            label.text = name;
            this._place(thumbnail, label);
        }
    }

    _place(thumbnail, label) {
        // Translations: this runs during allocation, where moving the
        // label would queue another layout.
        const [, width] = label.get_preferred_width(-1);
        const [, height] = label.get_preferred_height(width);
        label.set_translation(
            Math.round((thumbnail.width - width) / 2),
            Math.round(thumbnail.height - height - 4), 0);
    }
}
