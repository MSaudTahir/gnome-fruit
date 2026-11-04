// A Dock built on top of GNOME Shell's own Dash, so favorites,
// drag-to-reorder, running-app tracking and the app context menus all keep
// working. On top of that it adds magnification, launch/attention bouncing,
// minimized-window thumbnails with a genie effect, a frosted background and
// auto-hide. It replaces the overview's dash: the overview has no dock at
// all, and the app grid button opens the Launchpad instead.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Backdrop} from './backdrop.js';
import {StackPopup} from './folderStack.js';
import {LauncherEntries} from './launcherEntries.js';
import {addGenie, WindowEffects} from './windowEffects.js';

const EDGE_MARGIN = 4;
const BG_PADDING_X = 4;
const BG_PADDING_Y = 6;
const BG_RADIUS = 20;
const SHOW_DURATION = 220;
const HIDE_DURATION = 280;
const HIDE_DELAY = 350;
const TRIGGER_HEIGHT = 2;

// Magnification: how many icon widths either side of the pointer are
// affected, and how quickly icons chase their target scale per frame.
const MAG_RANGE = 2.8;
const MAG_SMOOTHING = 0.32;

const BOUNCE_HEIGHT = 0.55;
const BOUNCE_UP_TIME = 260;
const BOUNCE_DOWN_TIME = 300;
const LAUNCH_BOUNCE_LIMIT = 12;
const ATTENTION_BOUNCES = 3;

const MINIMIZE_DURATION = 540;

const BADGE_RATIO = 0.42;
// Always first in the Dock, like Finder.
const MAX_RECENT_APPS = 3;
const PINNED_APP_ID = 'org.gnome.Nautilus.desktop';
const DOCK_WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

const MacDash = GObject.registerClass(
class MacDash extends Dash.Dash {
    _init(dock) {
        this._dock = dock;
        this._dockReady = false;
        this._forceIconRebuild = false;
        this._badgedIcons = new Set();
        this._pinnedApp = Shell.AppSystem.get_default().lookup_app(PINNED_APP_ID);
        this._pinnedItem = null;

        super._init();

        this.name = 'fruitDockDash';
        this.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;
        this._box.clip_to_allocation = false;
        this._background.hide();

        const showApps = this._showAppsIcon;
        const createShowAppsIcon = showApps._createIcon.bind(showApps);
        showApps.icon.createIcon = size => this._dock.makeCrispIcon(createShowAppsIcon, size);
        showApps.icon.set_pivot_point(0.5, 1);
        showApps.label.add_style_class_name('fruit-dock-label');
        showApps.setLabelText(_('Launchpad'));
        showApps.show(false);

        // Files and the Launchpad button lead the Dock, like Finder and
        // Launchpad. Files is kept out of the regular list.
        this._pinnedBox = new St.BoxLayout();
        this._dashContainer.insert_child_at_index(this._pinnedBox, 0);
        this._dashContainer.set_child_above_sibling(showApps, this._pinnedBox);
        if (this._pinnedApp) {
            this._pinnedItem = this._createAppItem(this._pinnedApp);
            this._pinnedBox.add_child(this._pinnedItem);
            this._pinnedItem.show(false);
        }
        // A divider sets Files and Launchpad apart from the other apps.
        this._pinnedSeparator = new St.Widget({
            style_class: 'dash-separator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dashContainer.insert_child_above(this._pinnedSeparator, showApps);

        // Minimized windows live after the apps.
        this._minSeparator = new St.Widget({
            style_class: 'dash-separator',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._minBox = new St.BoxLayout({y_expand: true});
        this._dashContainer.add_child(this._minSeparator);
        this._dashContainer.add_child(this._minBox);
        this._minItems = new Map();

        // The Trash closes the Dock on the right, after minimized windows.
        // The Downloads stack sits just before the Trash.
        this._stackBox = new St.BoxLayout({y_expand: true});
        this._dashContainer.add_child(this._stackBox);
        this._stackItem = null;
        this._stackPopup = null;

        this._trashBox = new St.BoxLayout({y_expand: true});
        this._dashContainer.add_child(this._trashBox);
        this._trashItem = null;
        this._trashFull = false;
        this._trashMonitor = null;

        Shell.AppSystem.get_default().connectObject('app-state-changed',
            (system, app) => this._rememberApp(app), this);
    }

    get trashItem() {
        return this._trashItem;
    }

    get stackItem() {
        return this._stackItem;
    }

    // Width the stack and the Trash take at the end of the Dock.
    get tailWidth() {
        return (this._stackItem?.width ?? 0) + (this._trashItem?.width ?? 0);
    }

    _syncSeparator() {
        this._minSeparator.visible = this._minItems.size > 0 ||
            !!this._trashItem || !!this._stackItem;
    }

    syncStack() {
        const wanted = this._dock.settings.get_boolean('dock-show-downloads');
        if (wanted && !this._stackItem)
            this._createStack();
        else if (!wanted)
            this._destroyStack();
        this._syncSeparator();
    }

    _destroyStack() {
        this._stackPopup?.destroy();
        this._stackPopup = null;
        this._stackItem?.destroy();
        this._stackItem = null;
    }

    _createStack() {
        const folder = Gio.File.new_for_path(
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']));

        const size = this.iconSize * scaleFactor();
        const holder = new St.Widget({
            width: size,
            height: size,
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });
        holder.add_child(new St.Icon({icon_name: 'folder-download', icon_size: this.iconSize}));

        const button = new St.Button({
            style_class: 'fruit-dock-window',
            track_hover: true,
            can_focus: true,
            child: holder,
        });
        const item = new Dash.DashItemContainer();
        item.setChild(button);
        item.dockIcon = holder;
        item.label.add_style_class_name('fruit-dock-label');
        item.setLabelText(_('Downloads'));
        this._hookUpLabel(item);

        this._stackPopup = new StackPopup(folder, () => this._dock.setMenuOpen(false));
        button.connect('clicked', () => {
            this._dock.launchpad.close();
            if (this._stackPopup.isOpen) {
                this._stackPopup.close();
                return;
            }
            item.hideLabel();
            this._dock.setMenuOpen(true);
            this._stackPopup.open(holder);
        });

        this._stackItem = item;
        this._stackBox.add_child(item);
        item.show(false);
    }

    syncTrash() {
        const wanted = this._dock.settings.get_boolean('dock-show-trash');
        if (wanted && !this._trashItem)
            this._createTrash();
        else if (!wanted)
            this._destroyTrash();
        this._syncSeparator();
        this.syncStack();
    }

    _destroyTrash() {
        this._trashMonitor?.cancel();
        this._trashMonitor = null;
        this._trashItem?.destroy();
        this._trashItem = null;
    }

    _createTrash() {
        const sf = scaleFactor();
        const size = this.iconSize * sf;
        const holder = new St.Widget({
            width: size,
            height: size,
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });
        this._trashIcon = new St.Icon({icon_name: 'user-trash', icon_size: this.iconSize});
        holder.add_child(this._trashIcon);

        const button = new St.Button({
            style_class: 'fruit-dock-window',
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            child: holder,
        });

        const item = new Dash.DashItemContainer();
        item.setChild(button);
        item.dockIcon = holder;
        item.label.add_style_class_name('fruit-dock-label');
        item.setLabelText(_('Trash'));
        this._hookUpLabel(item);

        const menu = new PopupMenu.PopupMenu(item, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('app-menu');
        this._emptyItem = menu.addAction(_('Empty Trash'), () => this._emptyTrash());
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        const manager = new PopupMenu.PopupMenuManager(item);
        manager.addMenu(menu);
        menu.connect('open-state-changed', (m, open) => {
            this._dock.setMenuOpen(open);
            if (open)
                item.hideLabel();
        });
        item.connect('destroy', () => menu.destroy());

        button.connect('clicked', (b, mouseButton) => {
            if (mouseButton === 1) {
                this._dock.launchpad.close();
                Gio.AppInfo.launch_default_for_uri('trash:///', null);
            } else {
                menu.toggle();
            }
        });

        this._trashItem = item;
        this._trashBox.add_child(item);
        item.show(false);

        this._monitorTrash();
        this._queryTrash();
    }

    _localTrash() {
        const dir = Gio.File.new_for_path(`${GLib.get_user_data_dir()}/Trash/files`);
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            // Already there.
        }
        return dir;
    }

    // trash:/// covers every mounted volume but needs gvfs; without it,
    // watch the home Trash directly.
    _monitorTrash() {
        for (const file of [Gio.File.new_for_uri('trash:///'), this._localTrash()]) {
            try {
                this._trashMonitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
                this._trashMonitor.connect('changed', () => this._queryTrash());
                return;
            } catch (e) {
                // Try the next one.
            }
        }
    }

    _queryTrash() {
        const trash = Gio.File.new_for_uri('trash:///');
        trash.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (file, result) => {
                try {
                    const info = file.query_info_finish(result);
                    this._setTrashFull(info.get_attribute_uint32('trash::item-count') > 0);
                } catch (e) {
                    this._queryLocalTrash();
                }
            });
    }

    _queryLocalTrash() {
        try {
            const enumerator = this._localTrash().enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            this._setTrashFull(!!enumerator.next_file(null));
            enumerator.close(null);
        } catch (e) {
            // Leave it as it is.
        }
    }

    _setTrashFull(full) {
        this._trashFull = full;
        if (!this._trashItem)
            return;
        this._trashIcon.icon_name = full ? 'user-trash-full' : 'user-trash';
        this._emptyItem.setSensitive(full);
    }

    _emptyTrash() {
        const trash = Gio.File.new_for_uri('trash:///');
        try {
            const enumerator = trash.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null))) {
                try {
                    trash.get_child(info.get_name()).delete(null);
                } catch (e) {
                    console.error(`Couldn't delete ${info.get_name()}: ${e.message}`);
                }
            }
            enumerator.close(null);
        } catch (e) {
            console.error(`Couldn't empty the Trash: ${e.message}`);
        }
    }

    get minimizedItems() {
        return [...this._minBox.get_children()].filter(a => !a.animatingOut);
    }

    minimizedItem(window) {
        return this._minItems.get(window) ?? null;
    }

    syncMinimized(animate = true) {
        const wanted = this._dock.minimizedWindows();
        for (const [window, item] of this._minItems) {
            if (wanted.includes(window))
                continue;
            this._minItems.delete(window);
            window.disconnectObject(item);
            this._dock.rememberWindowRect(window, item);
            if (animate)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }
        for (const window of wanted) {
            if (this._minItems.has(window))
                continue;
            const item = this._createWindowItem(window);
            if (!item)
                continue;
            this._minItems.set(window, item);
            this._minBox.add_child(item);
            item.show(animate);
        }
        this._syncSeparator();
    }

    _createWindowItem(window) {
        const actor = window.get_compositor_private();
        if (!actor)
            return null;

        const sf = scaleFactor();
        const size = this.iconSize * sf;
        const holder = new St.Widget({
            width: size,
            height: size,
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });

        // Fit the window frame (not its shadow) into the icon square.
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        const scale = Math.min(size * 0.92 / frame.width, size * 0.92 / frame.height);
        holder.add_child(new Clutter.Clone({
            source: actor,
            width: actor.width * scale,
            height: actor.height * scale,
            x: Math.round((size - frame.width * scale) / 2 - (frame.x - buffer.x) * scale),
            y: Math.round((size - frame.height * scale) / 2 - (frame.y - buffer.y) * scale),
        }));

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        if (app) {
            const badgeSize = Math.round(this.iconSize * BADGE_RATIO);
            const badge = this._dock.makeCrispIcon(s => app.create_icon_texture(s), badgeSize);
            badge.set_position(size - badgeSize * sf * 0.9, size - badgeSize * sf * 0.9);
            holder.add_child(badge);
        }

        const button = new St.Button({
            style_class: 'fruit-dock-window',
            track_hover: true,
            can_focus: true,
            child: holder,
        });
        button.connect('clicked', () => {
            this._dock.launchpad.close();
            Main.activateWindow(window);
        });

        const item = new Dash.DashItemContainer();
        item.setChild(button);
        item.dockIcon = holder;
        item.label.add_style_class_name('fruit-dock-label');
        const syncTitle = () => item.setLabelText(window.get_title() ?? app?.get_name() ?? '');
        syncTitle();
        window.connectObject('notify::title', syncTitle, item);
        this._hookUpLabel(item);
        return item;
    }

    rebuildIcons() {
        this._forceIconRebuild = true;
        this._adjustIconSize();
    }

    _addExposeItem(appIcon, app) {
        const menu = appIcon._menu;
        if (!menu || menu._fruitExpose)
            return;
        const item = new PopupMenu.PopupMenuItem(_('Show All Windows'));
        item.connect('activate', () => this._dock.appExpose?.open(app));
        const position = menu.box.get_children().indexOf(menu._newWindowItem.actor);
        menu.addMenuItem(item, Math.max(position, 0));
        menu._fruitExpose = item;

        const sync = () => {
            item.visible = app.get_windows().length > 0;
        };
        menu.connect('open-state-changed', sync);
        sync();
    }

    // The app's icon with room for a count badge and a progress bar.
    _createAppIcon(app, size) {
        const sf = scaleFactor();
        const icon = this._dock.makeCrispIcon(s => app.create_icon_texture(s), size);

        const box = new St.Widget({layout_manager: new Clutter.BinLayout()});
        box.add_child(icon);

        box._fruitApp = app;
        const trackWidth = Math.round(size * sf * 0.8);
        box._track = new St.Widget({
            style_class: 'fruit-dock-progress',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            width: trackWidth,
            height: Math.round(5 * sf),
            visible: false,
        });
        box._fill = new St.Widget({style_class: 'fruit-dock-progress-fill'});
        box._track.add_child(box._fill);
        box._trackWidth = trackWidth;
        box.add_child(box._track);

        box._badge = new St.Label({
            style_class: 'fruit-dock-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            translation_x: 5 * sf,
            translation_y: -5 * sf,
            visible: false,
        });
        box.add_child(box._badge);

        this._badgedIcons.add(box);
        box.connect('destroy', () => this._badgedIcons.delete(box));
        this._applyEntry(box);
        return box;
    }

    _applyEntry(box) {
        const entry = this._dock.launcherEntries.get(box._fruitApp);
        const count = entry?.count ?? 0;
        box._badge.visible = count > 0;
        box._badge.text = count > 99 ? '99+' : `${count}`;

        const progress = entry?.progress ?? -1;
        box._track.visible = progress >= 0;
        box._fill.set_size(Math.round(box._trackWidth * Math.max(progress, 0)),
            box._track.height);
    }

    refreshEntries(id) {
        for (const box of this._badgedIcons) {
            if (!id || box._fruitApp.get_id() === id)
                this._applyEntry(box);
        }
    }

    _createAppItem(app) {
        const item = super._createAppItem(app);
        const appIcon = item.child;

        appIcon.icon.createIcon = size => this._createAppIcon(app, size);
        appIcon.icon._createIconTexture(this.iconSize);
        appIcon.icon.set_pivot_point(0.5, 1);
        appIcon.animateLaunch = () => this._dock.bounceLaunch(item, app);
        const popupMenu = appIcon.popupMenu.bind(appIcon);
        appIcon.popupMenu = (...args) => {
            popupMenu(...args);
            this._addExposeItem(appIcon, app);
        };
        const activate = appIcon.activate.bind(appIcon);
        appIcon.activate = button => {
            activate(button);
            this._dock.launchpad.close();
        };
        item.label.add_style_class_name('fruit-dock-label');

        // Stock Dash only animates icons in and out inside the overview.
        const show = item.show.bind(item);
        item.show = animate => show(animate || this._dockReady);

        return item;
    }

    get pinnedItem() {
        return this._pinnedItem;
    }

    /**
     * Runs `callback` while favorites and running apps leave out the
     * pinned app, so GNOME's Dash code doesn't add it to the list too.
     *
     * @param {Function} callback
     */
    _withoutPinnedApp(callback) {
        const pinned = this._pinnedApp;
        const favorites = AppFavorites.getAppFavorites();
        const proto = Object.getPrototypeOf(favorites);
        const appSystem = this._appSystem;
        if (pinned) {
            favorites.getFavoriteMap = () => {
                const map = {...proto.getFavoriteMap.call(favorites)};
                delete map[pinned.get_id()];
                return map;
            };
            favorites.getFavorites = () =>
                proto.getFavorites.call(favorites).filter(app => app !== pinned);
        }
        // Recent apps are listed like running ones, after the favorites.
        this._appSystem = {
            get_running: () => [
                ...appSystem.get_running().filter(app => app !== pinned),
                ...this._recentApps(appSystem),
            ],
        };
        try {
            return callback();
        } finally {
            delete favorites.getFavoriteMap;
            delete favorites.getFavorites;
            this._appSystem = appSystem;
        }
    }

    // Recently opened apps that are neither running nor pinned.
    _recentApps(appSystem) {
        if (!this._dock.settings.get_boolean('dock-show-recent'))
            return [];
        const favorites = AppFavorites.getAppFavorites().getFavoriteMap();
        const running = new Set(appSystem.get_running());
        return this._dock.settings.get_strv('dock-recent-apps')
            .map(id => appSystem.lookup_app(id))
            .filter(app => app && app !== this._pinnedApp &&
                !running.has(app) && !(app.get_id() in favorites));
    }

    _rememberApp(app) {
        if (app.state !== Shell.AppState.RUNNING || app === this._pinnedApp ||
            app.is_window_backed())
            return;
        const settings = this._dock.settings;
        const id = app.get_id();
        const recent = [id, ...settings.get_strv('dock-recent-apps').filter(r => r !== id)];
        settings.set_strv('dock-recent-apps', recent.slice(0, MAX_RECENT_APPS));
    }

    _redisplay() {
        this._withoutPinnedApp(() => super._redisplay());
        this._dockReady = true;
    }

    handleDragOver(...args) {
        return this._withoutPinnedApp(() => super.handleDragOver(...args));
    }

    acceptDrop(source, actor, x, y, time) {
        const app = Dash.Dash.getAppFromSource(source);
        if (!this._pinnedApp || !this._dragPlaceholder || !app ||
            app.is_window_backed() || !global.settings.is_writable('favorite-apps'))
            return super.acceptDrop(source, actor, x, y, time);

        // GNOME counts favorites by their place in the Dock, which is off
        // by one when the pinned app sits earlier in the real list. Insert
        // after the last favorite shown before the drop point instead.
        const id = app.get_id();
        const appFavorites = AppFavorites.getAppFavorites();
        const favorites = appFavorites.getFavorites().map(a => a.get_id());
        const others = favorites.filter(f => f !== id);
        const before = this._box.get_children()
            .slice(0, this._dragPlaceholderPos)
            .map(a => a.child?._delegate?.app?.get_id())
            .filter(f => f && others.includes(f));
        const pos = before.length ? others.indexOf(before.at(-1)) + 1 : 0;

        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (favorites.includes(id))
                appFavorites.moveFavoriteToPos(id, pos);
            else
                appFavorites.addFavoriteAtPos(id, pos);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _adjustIconSize() {
        const size = this._dock.iconSize;
        const icons = [this._pinnedItem, ...this._box.get_children()]
            .filter(a => a?.child?._delegate?.icon && !a.animatingOut)
            .map(a => a.child._delegate.icon);
        icons.push(this._showAppsIcon.icon);

        const force = this._forceIconRebuild;
        this._forceIconRebuild = false;
        for (const icon of icons) {
            if (force || icon.iconSize !== size || !icon.icon)
                icon._createIconTexture(size);
        }

        this._separator?.set_height(size * scaleFactor());
        this._minSeparator?.set_height(size * scaleFactor());
        this._pinnedSeparator?.set_height(size * scaleFactor());

        const changed = this.iconSize !== size;
        if ((changed || force) && (this._trashItem || this._stackItem)) {
            this._destroyTrash();
            this._destroyStack();
            this.iconSize = size;
            this.syncTrash();
        }
        if (changed) {
            this.iconSize = size;
            this.emit('icon-size-changed');
        }

        // Window thumbnails are sized when created; rebuild them.
        if ((changed || force) && this._minItems) {
            for (const [window, item] of this._minItems) {
                window.disconnectObject(item);
                item.destroy();
            }
            this._minItems.clear();
            this.syncMinimized(false);
        }
    }

    _itemMenuStateChanged(item, opened) {
        super._itemMenuStateChanged(item, opened);
        this._dock.setMenuOpen(opened);
    }
});

export const Dock = GObject.registerClass(
class Dock extends St.Widget {
    _init(settings, effects, launchpad, isStageManagerWindow, appExpose) {
        super._init({
            name: 'fruitDock',
            style_class: 'fruit-dock',
            reactive: true,
        });

        this._settings = settings;
        this.settings = settings;
        this._effects = effects;
        this._isStageManagerWindow = isStageManagerWindow;
        this.launchpad = launchpad;
        this.appExpose = appExpose;
        this.launcherEntries = new LauncherEntries();
        this.launcherEntries.connectObject('changed', (entries, id) => this._onEntryChanged(id), this);
        this._windowRects = new Map();
        this._menuOpen = false;
        this._dragging = false;
        this._inOverview = Main.overview.visible;
        this._hidden = false;
        this._hideTimeoutId = 0;
        this._intellihideLater = 0;
        this._pointerTimeline = null;
        this._pointerInside = false;
        this._lastPointerX = 0;
        this._magnified = false;
        this._baseBg = {x: 0, width: 0};

        this._readSettings();

        this._backdrop = new Backdrop({
            radius: 40,
            brightness: 0.85,
            cornerRadius: BG_RADIUS * scaleFactor(),
        });
        this.add_child(this._backdrop);
        this._bg = new St.Widget({style_class: 'fruit-dock-background'});
        this.add_child(this._bg);
        // The backdrop shows what's behind the dock, so it has to follow
        // the dock when it moves or slides away.
        this.connect('notify::allocation', () => this._backdrop.syncPosition());
        this.connect('notify::translation-y', () => this._backdrop.syncPosition());

        this.dash = new MacDash(this);
        this.add_child(this.dash);
        this._relayoutLater = 0;
        this.dash.connect('notify::width', () => this._queueRelayout());
        this.dash.connect('notify::height', () => this._queueRelayout());

        this._hideOverviewDash();
        this._syncingShowApps = false;
        this.dash.showAppsButton.connect('notify::checked', button => {
            if (this._syncingShowApps)
                return;
            if (button.checked)
                this.launchpad.open();
            else
                this.launchpad.close();
        });
        // Mirror the Launchpad state, whoever opened or closed it.
        const syncShowApps = () => {
            this._syncingShowApps = true;
            this.dash.showAppsButton.checked = this.launchpad.isOpen;
            this._syncingShowApps = false;
            // Over the Launchpad, the windows behind would show through as
            // a bright patch; its own blur is backdrop enough.
            this._backdrop.ease({
                opacity: this.launchpad.isOpen ? 0 : 255,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._syncVisibility();
        };
        this.launchpad.connectObject(
            'showing', () =>
                this.get_parent().set_child_above_sibling(this, this.launchpad),
            'opened', syncShowApps,
            'closed', syncShowApps,
            this);

        // Invisible strip at the screen edge that reveals a hidden dock.
        this._trigger = new St.Widget({reactive: true, track_hover: true});
        this._trigger.connect('notify::hover', () => this._syncVisibility());

        Main.layoutManager.addChrome(this._trigger);
        Main.layoutManager.addChrome(this, this._chromeParams());

        // Child buttons swallow crossing events, so `hover` on the dock is
        // unreliable; watch events on their way down instead.
        this.connect('captured-event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.ENTER)
                this._startPointerTracking();
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', this._onDestroy.bind(this));

        this._settings.connectObject(
            'changed::dock-icon-size', () => {
                this._readSettings();
                this.dash.rebuildIcons();
            },
            'changed::dock-magnification', () => {
                this._readSettings();
                this.dash.rebuildIcons();
            },
            'changed::dock-magnification-scale', () => {
                this._readSettings();
                this.dash.rebuildIcons();
            },
            'changed::dock-autohide', () => {
                this._readSettings();
                Main.layoutManager.untrackChrome(this);
                Main.layoutManager.trackChrome(this, this._chromeParams());
                this._syncVisibility();
            },
            'changed::dock-show-apps-button', () => this._syncShowApps(),
            'changed::dock-show-trash', () => this.dash.syncTrash(),
            'changed::dock-show-downloads', () => this.dash.syncStack(),
            'changed::dock-show-recent', () => this.dash._queueRedisplay(),
            this);

        Main.layoutManager.connectObject('monitors-changed', () => this._queueRelayout(), this);

        Main.overview.connectObject(
            'showing', () => {
                this._inOverview = true;
                this._syncVisibility();
            },
            'hiding', () => {
                this._inOverview = false;
                this._syncVisibility();
            },
            'item-drag-begin', () => {
                this._dragging = true;
                this._syncVisibility();
            },
            'item-drag-end', () => this._endDrag(),
            'item-drag-cancelled', () => this._endDrag(),
            this);

        global.display.connectObject(
            'window-demands-attention', (d, w) => this._onAttention(w),
            'window-marked-urgent', (d, w) => this._onAttention(w),
            'restacked', () => this._queueIntellihide(),
            'window-created', (d, w) => {
                this._trackWindow(w);
                this.dash.syncMinimized();
            },
            'grab-op-end', () => this._queueIntellihide(),
            this);
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this.dash.syncMinimized(false);
            this._queueIntellihide();
        }, this);
        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
        this.dash.syncMinimized(false);

        this._syncShowApps();
        this.dash.syncTrash();
        this._relayout();
        this._syncVisibility();
    }

    // The overview's own dash is hidden and takes no room, so the overview
    // is all windows, like Mission Control.
    _hideOverviewDash() {
        const dash = Main.overview.dash;
        dash.hide();
        dash.set_height(0);
        dash.connectObject('notify::visible', () => {
            if (dash.visible)
                dash.hide();
        }, this);
    }

    _restoreOverviewDash() {
        const dash = Main.overview.dash;
        dash.disconnectObject(this);
        dash.set_height(-1);
        dash.show();
    }

    _readSettings() {
        this.iconSize = this._settings.get_int('dock-icon-size');
        this._magnify = this._settings.get_boolean('dock-magnification');
        this._maxScale = this._magnify
            ? this._settings.get_double('dock-magnification-scale') : 1;
        this._autohide = this._settings.get_string('dock-autohide');
    }

    _chromeParams() {
        return {
            affectsStruts: this._autohide === 'never',
            trackFullscreen: true,
        };
    }

    _syncShowApps() {
        const visible = this._settings.get_boolean('dock-show-apps-button');
        this.dash._showAppsIcon.visible = visible;
    }

    /**
     * Icons are rendered at their maximum magnified size and scaled down,
     * so they stay sharp when the pointer magnifies them.
     *
     * @param {Function} create - creates an icon actor for a given size
     * @param {number} size - logical icon size
     */
    makeCrispIcon(create, size) {
        const mag = Math.max(1, this._maxScale);
        const inner = create(Math.ceil(size * mag));
        if (mag === 1)
            return inner;

        const px = size * scaleFactor();
        const box = new St.Widget({width: px, height: px});
        inner.set_scale(1 / mag, 1 / mag);
        box.add_child(inner);
        return box;
    }

    // Layout

    _queueRelayout() {
        // Size changes are notified mid-allocation; resizing ourselves
        // right there would queue a relayout during layout.
        if (this._relayoutLater)
            return;
        this._relayoutLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._relayoutLater = 0;
                this._relayout();
                return GLib.SOURCE_REMOVE;
            });
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const sf = scaleFactor();
        const [, dashW] = this.dash.get_preferred_width(-1);
        const [, dashH] = this.dash.get_preferred_height(dashW);
        const padX = BG_PADDING_X * sf;
        const padY = BG_PADDING_Y * sf;
        const margin = EDGE_MARGIN * sf;

        const bgW = dashW + 2 * padX;
        const bgH = dashH + 2 * padY;

        this.set_size(bgW, bgH + margin);
        this.set_position(
            Math.round(monitor.x + (monitor.width - bgW) / 2),
            monitor.y + monitor.height - bgH - margin);

        this.dash.set_position(padX, padY);
        this._baseBg = {x: 0, width: bgW, height: bgH};
        this._setBgGeometry(0, bgW);

        this._trigger.set_position(this.x, monitor.y + monitor.height - TRIGGER_HEIGHT);
        this._trigger.set_size(bgW, TRIGGER_HEIGHT);

        if (this._hidden)
            this.translation_y = this.height;

        this._queueIntellihide();
    }

    _setBgGeometry(x, width) {
        for (const actor of [this._backdrop, this._bg]) {
            actor.set_position(x, 0);
            actor.set_size(width, this._baseBg.height);
        }
    }

    _slots() {
        const slots = [];
        const pinned = this.dash.pinnedItem;
        if (pinned)
            slots.push({actor: pinned, icon: pinned.child.icon});
        const showApps = this.dash._showAppsIcon;
        if (showApps.visible)
            slots.push({actor: showApps, icon: showApps.icon});
        slots.push({actor: this.dash._pinnedSeparator, icon: null});
        for (const actor of this.dash._box.get_children()) {
            if (actor.animatingOut)
                continue;
            slots.push({actor, icon: actor.child?._delegate?.icon ?? null});
        }
        if (this.dash._minSeparator.visible)
            slots.push({actor: this.dash._minSeparator, icon: null});
        for (const actor of this.dash.minimizedItems)
            slots.push({actor, icon: actor.dockIcon});
        if (this.dash.stackItem)
            slots.push({actor: this.dash.stackItem, icon: this.dash.stackItem.dockIcon});
        if (this.dash.trashItem)
            slots.push({actor: this.dash.trashItem, icon: this.dash.trashItem.dockIcon});
        return slots;
    }

    // Pointer tracking and magnification. While the pointer is near the
    // dock a per-frame timeline follows it; it stops once the pointer has
    // left and the icons have settled back to their normal size.

    _startPointerTracking() {
        if (this._pointerTimeline)
            return;

        this._pointerTimeline = new Clutter.Timeline({
            actor: this,
            duration: 1000,
            repeat_count: -1,
        });
        this._pointerTimeline.connect('new-frame', () => this._onPointerFrame());
        this._pointerTimeline.start();
        this._onPointerFrame();
    }

    _stopPointerTracking() {
        this._pointerTimeline?.stop();
        this._pointerTimeline = null;
    }

    _pointerInZone(px, py) {
        const [bx, by] = this._bg.get_transformed_position();
        const magnified = (this._maxScale - 1) * this.iconSize * scaleFactor();
        const monitor = Main.layoutManager.primaryMonitor;
        return px >= bx && px <= bx + this._bg.width &&
            py >= by - magnified && py < monitor.y + monitor.height;
    }

    _onPointerFrame() {
        const [px, py] = global.get_pointer();
        const inside = this._pointerInZone(px, py);
        if (inside !== this._pointerInside) {
            this._pointerInside = inside;
            this._syncVisibility();
        }

        const settled = this._updateMagnification(px, inside);
        if (!inside && settled)
            this._stopPointerTracking();
    }

    _updateMagnification(px, inside) {
        const iconPx = this.iconSize * scaleFactor();
        const maxScale = this._maxScale;
        // Nothing to do (and nothing to disturb) without magnification.
        if (maxScale <= 1 && !this._magnified)
            return true;
        inside = inside && maxScale > 1 &&
            !this._dragging && !this._menuOpen && !this._hidden;
        if (inside)
            this._lastPointerX = px;
        const x = this._lastPointerX;

        const slots = this._slots();
        let settled = true;
        let total = 0;
        let leftOfPointer = 0;

        for (const slot of slots) {
            const [sx] = slot.actor.get_transformed_position();
            const left = sx - slot.actor.translation_x;
            const width = slot.actor.width;

            let target = 1;
            if (inside && slot.icon) {
                const d = Math.abs(x - (left + width / 2)) / iconPx;
                const t = Math.min(d / MAG_RANGE, 1);
                target = 1 + (maxScale - 1) * (Math.cos(t * Math.PI) + 1) / 2;
            }

            const current = slot.icon?.scale_x ?? 1;
            let scale = current + (target - current) * MAG_SMOOTHING;
            if (Math.abs(scale - target) < 0.002)
                scale = target;
            else
                settled = false;
            slot.icon?.set_scale(scale, scale);

            slot.extra = slot.icon ? (scale - 1) * slot.icon.width : 0;
            total += slot.extra;
            leftOfPointer += slot.extra * Math.clamp((x - left) / width, 0, 1);
        }

        // Spread neighbours apart so the icon under the pointer stays put
        // while the dock grows around it.
        let before = 0;
        for (const slot of slots) {
            slot.actor.translation_x = before + slot.extra / 2 - leftOfPointer;
            before += slot.extra;
        }

        this._setBgGeometry(this._baseBg.x - leftOfPointer, this._baseBg.width + total);

        for (const slot of slots)
            this._syncLabel(slot);

        this._magnified = !settled || total !== 0;
        return !this._magnified;
    }

    _syncLabel(slot) {
        const label = slot.actor.label;
        if (!label?.visible || !slot.icon)
            return;
        const ext = slot.icon.get_transformed_extents();
        const yOffset = 8 * scaleFactor();
        label.set_position(
            Math.round(ext.origin.x + (ext.size.width - label.width) / 2),
            Math.round(ext.origin.y - label.height - yOffset));
    }

    // Bouncing

    _findItem(app) {
        if (app === this.dash.pinnedItem?.child.app)
            return this.dash.pinnedItem;
        return this.dash._box.get_children().find(
            a => a.child?._delegate?.app === app && !a.animatingOut) ?? null;
    }

    bounceLaunch(item, app) {
        if (!this._settings.get_boolean('dock-bounce')) {
            item.child.icon.animateZoomOut();
            return;
        }
        const startWindows = app.get_n_windows();
        this._bounce(item, n =>
            n >= LAUNCH_BOUNCE_LIMIT || app.get_n_windows() > startWindows);
    }

    _onEntryChanged(id) {
        this.dash.refreshEntries(id);

        const app = Shell.AppSystem.get_default().lookup_app(id);
        const entry = app ? this.launcherEntries.get(app) : null;
        if (!entry?.urgent || !this._settings.get_boolean('dock-bounce'))
            return;
        const item = this._findItem(app);
        if (item)
            this._bounce(item, n => n >= ATTENTION_BOUNCES || !this.launcherEntries.get(app)?.urgent);
    }

    _onAttention(window) {
        if (!this._settings.get_boolean('dock-bounce') || window.has_focus())
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const item = app ? this._findItem(app) : null;
        if (item)
            this._bounce(item, n => n >= ATTENTION_BOUNCES || window.has_focus());
    }

    _bounce(item, shouldStop) {
        const icon = item.child?.icon;
        if (!icon || item._fruitBouncing)
            return;
        item._fruitBouncing = true;

        const height = this.iconSize * scaleFactor() * BOUNCE_HEIGHT;
        let count = 0;
        const step = () => {
            if (shouldStop(count)) {
                item._fruitBouncing = false;
                return;
            }
            count++;
            icon.ease({
                translation_y: -height,
                duration: BOUNCE_UP_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => icon.ease({
                    translation_y: 0,
                    duration: BOUNCE_DOWN_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: step,
                    onStopped: finished => {
                        if (!finished)
                            item._fruitBouncing = false;
                    },
                }),
                onStopped: finished => {
                    if (!finished)
                        item._fruitBouncing = false;
                },
            });
        };
        step();
    }

    // Minimize into the dock

    syncMinimized() {
        this.dash.syncMinimized();
    }

    minimizedWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.list_all_windows().filter(w =>
            w.minimized &&
            DOCK_WINDOW_TYPES.includes(w.get_window_type()) &&
            !w.is_skip_taskbar() &&
            !w.get_transient_for() &&
            w.located_on_workspace(workspace) &&
            !this._isStageManagerWindow(w));
    }

    rememberWindowRect(window, item) {
        if (item.dockIcon?.mapped)
            this._windowRects.set(window, this._extents(item.dockIcon));
    }

    _extents(actor) {
        const ext = actor.get_transformed_extents();
        return {
            x: ext.origin.x,
            y: ext.origin.y,
            width: ext.size.width,
            height: ext.size.height,
        };
    }

    /**
     * Where a newly minimized window's thumbnail will sit once it has
     * finished growing in at the end of the dock.
     *
     * @param {Dash.DashItemContainer} item
     */
    _predictWindowRect(item) {
        const monitor = Main.layoutManager.primaryMonitor;
        const sf = scaleFactor();
        const iconPx = this.iconSize * sf;
        const slotW = this.dash._showAppsIcon.width || iconPx + 10 * sf;
        const [, dashW] = this.dash.get_preferred_width(-1);
        const bgW = dashW + (1 - item.scale_x) * slotW + 2 * BG_PADDING_X * sf;
        // The Trash sits after minimized windows.
        const trashW = this.dash.tailWidth;
        const right = Math.round(monitor.x + (monitor.width - bgW) / 2) + bgW -
            BG_PADDING_X * sf - trashW;
        return {
            x: right - slotW + (slotW - iconPx) / 2,
            y: this.y + this.translation_y + (BG_PADDING_Y + 2) * sf,
            width: iconPx,
            height: iconPx,
        };
    }

    getIconRect(window, minimizing = true) {
        if (this._inOverview || !this.visible)
            return null;

        const remembered = this._windowRects.get(window);
        this._windowRects.delete(window);
        const thumb = this.dash.minimizedItem(window);
        if (minimizing && thumb)
            return thumb.scale_x < 1 ? this._predictWindowRect(thumb) : this._extents(thumb.dockIcon);
        if (!minimizing && remembered)
            return remembered;

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const item = app ? this._findItem(app) : null;
        if (!item?.child?.icon)
            return null;
        return this._extents(item.child.icon);
    }

    minimize(actor, effects) {
        // Make sure the window's thumbnail exists so the genie can aim at it.
        this.dash.syncMinimized();
        return this._runWindowEffect(actor, effects, true);
    }

    unminimize(actor, effects) {
        return this._runWindowEffect(actor, effects, false);
    }

    // A new window zooms out of its app's Dock icon.
    map(actor, effects) {
        if (!this._settings.get_boolean('dock-zoom-new-windows'))
            return false;
        const rect = this.getIconRect(actor.meta_window, false);
        if (!rect)
            return false;
        effects.runOnClone(actor, false,
            (clone, done) => this._scale(clone, rect, false, done), {mapping: true});
        return true;
    }

    _runWindowEffect(actor, effects, minimizing) {
        const mode = this._settings.get_string('dock-minimize-effect');
        if (mode === 'default')
            return false;
        const rect = this.getIconRect(actor.meta_window, minimizing);
        if (!rect)
            return false;

        effects.runOnClone(actor, minimizing, (clone, done) => {
            if (mode === 'genie')
                this._genie(clone, rect, minimizing, done);
            else
                this._scale(clone, rect, minimizing, done);
        });
        return true;
    }

    _genie(clone, rect, minimizing, done) {
        const effect = addGenie(clone, rect);
        const apply = p => {
            effect.progress = p;
            clone.opacity = 255 * (1 - Math.clamp((p - 0.85) / 0.15, 0, 1));
        };
        apply(minimizing ? 0 : 1);
        WindowEffects.timeline(clone, MINIMIZE_DURATION,
            minimizing
                ? Clutter.AnimationMode.EASE_IN_OUT_SINE
                : Clutter.AnimationMode.EASE_OUT_SINE,
            p => apply(minimizing ? p : 1 - p),
            done);
    }

    _scale(clone, rect, minimizing, done) {
        const icon = {
            x: rect.x,
            y: rect.y,
            scale_x: rect.width / clone.width,
            scale_y: rect.height / clone.height,
            opacity: 0,
        };
        const window = {
            x: clone.x,
            y: clone.y,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
        };
        clone.set(minimizing ? window : icon);
        clone.ease({
            ...(minimizing ? icon : window),
            duration: MINIMIZE_DURATION * 0.7,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: done,
        });
    }

    // Auto-hide

    setMenuOpen(open) {
        this._menuOpen = open;
        this._syncVisibility();
    }

    _endDrag() {
        this._dragging = false;
        this._syncVisibility();
    }

    _trackWindow(window) {
        window.connectObject(
            'position-changed', () => this._queueIntellihide(),
            'size-changed', () => this._queueIntellihide(),
            'notify::minimized', () => {
                this.dash.syncMinimized();
                this._queueIntellihide();
            },
            'workspace-changed', () => this.dash.syncMinimized(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windowRects.delete(window);
                this.dash.syncMinimized();
                this._queueIntellihide();
            },
            this);
    }

    _queueIntellihide() {
        if (this._intellihideLater || this._autohide !== 'intellihide')
            return;
        this._intellihideLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._intellihideLater = 0;
                this._syncVisibility();
                return GLib.SOURCE_REMOVE;
            });
    }

    _windowsOverlap() {
        const monitor = Main.layoutManager.primaryMonitor;
        const dockRect = {
            x: this.x,
            y: this.y,
            width: this.width,
            height: this.height,
        };
        const workspace = global.workspace_manager.get_active_workspace();
        return workspace.list_windows().some(w =>
            w.get_monitor() === monitor.index &&
            w.showing_on_its_workspace() &&
            w.get_window_type() !== Meta.WindowType.DESKTOP &&
            rectsOverlap(w.get_frame_rect(), dockRect));
    }

    _wantsVisible() {
        if (this._autohide === 'never')
            return true;
        if (this.launchpad.isOpen || this._pointerInside || this._trigger.hover ||
            this._menuOpen || this._dragging)
            return true;
        if (this._autohide === 'always')
            return false;
        return !this._windowsOverlap();
    }

    _syncVisibility() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        if (this._inOverview) {
            this.remove_transition('translation-y');
            this.ease({
                opacity: 0,
                duration: SHOW_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.hide(),
            });
            return;
        }

        if (!this.visible || this.opacity < 255) {
            this.show();
            this.ease({
                opacity: 255,
                duration: SHOW_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._wantsVisible()) {
            this._setHidden(false);
        } else {
            this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY, () => {
                this._hideTimeoutId = 0;
                if (!this._wantsVisible())
                    this._setHidden(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setHidden(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        this.ease({
            translation_y: hidden ? this.height : 0,
            duration: hidden ? HIDE_DURATION : SHOW_DURATION,
            mode: hidden
                ? Clutter.AnimationMode.EASE_IN_QUAD
                : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onDestroy() {
        this.launcherEntries.disconnectObject(this);
        this.launcherEntries.destroy();
        this._stopPointerTracking();
        if (this._hideTimeoutId)
            GLib.source_remove(this._hideTimeoutId);
        if (this._intellihideLater)
            global.compositor.get_laters().remove(this._intellihideLater);
        if (this._relayoutLater)
            global.compositor.get_laters().remove(this._relayoutLater);
        for (const actor of global.get_window_actors())
            actor.meta_window.disconnectObject(this);
        for (const window of this.dash._minItems.keys())
            window.disconnectObject(this.dash._minItems.get(window));
        this._restoreOverviewDash();
        this.launchpad.disconnectObject(this);
        this._trigger.destroy();
    }
});
