// Stage Manager.
//
// Windows are organised into groups (by default one per app). The group
// holding the focused window is "on stage"; every other group on the
// workspace is minimized and shown as a tilted live thumbnail in a strip
// along the left edge. Clicking a thumbnail swaps it onto the stage,
// shift/middle-click or dragging it onto the stage adds it to the current
// set, and dragging a window into the strip splits it into its own group.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

const SWITCH_DURATION = 460;
const STRIP_MARGIN = 14;
const ITEM_SPACING = 26;
const ICON_SIZE = 30;
const MAX_CLONES = 3;
const CLONE_CASCADE = 7;
const REVEAL_EDGE = 2;
const REVEAL_RELEASE = 48;
const HOVER_TILT = 0.3;
const HOVER_SCALE = 1.05;
const RESTORE_TIMEOUT = 1500;

const MANAGED_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

const MOVE_OPS = [
    Meta.GrabOp.MOVING,
    Meta.GrabOp.MOVING_UNCONSTRAINED,
    Meta.GrabOp.KEYBOARD_MOVING,
];

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

class Group {
    constructor(workspace) {
        this.workspace = workspace;
        // Ordered back to front: the last window is the most recent.
        this.windows = [];
        this.lastUsed = 0;
    }

    raise(window) {
        const i = this.windows.indexOf(window);
        if (i >= 0)
            this.windows.splice(i, 1);
        this.windows.push(window);
    }

    remove(window) {
        this.windows = this.windows.filter(w => w !== window);
    }

    get app() {
        const top = this.windows[this.windows.length - 1];
        return top ? Shell.WindowTracker.get_default().get_window_app(top) : null;
    }
}

/**
 * Geometry of the strip. Everything is computed rather than read back
 * from actors, so window flights can target slots before they exist.
 */
class StripLayout {
    update() {
        const monitor = Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const sf = scaleFactor();

        this.monitor = monitor;
        this.workArea = workArea;
        this.thumbWidth = Math.clamp(monitor.width * 0.1, 120 * sf, 220 * sf);
        this.thumbHeight = Math.round(this.thumbWidth * 0.72);
        this.margin = STRIP_MARGIN * sf;
        this.spacing = ITEM_SPACING * sf;
        this.right = monitor.x + this.margin * 2 + this.thumbWidth;
    }

    get rect() {
        return {
            x: this.monitor.x,
            y: this.workArea.y,
            width: this.right - this.monitor.x,
            height: this.workArea.height,
        };
    }

    slot(index, count) {
        const total = count * this.thumbHeight + Math.max(count - 1, 0) * this.spacing;
        const y0 = this.workArea.y + (this.workArea.height - total) / 2;
        return {
            x: this.monitor.x + this.margin,
            y: Math.round(y0 + index * (this.thumbHeight + this.spacing)),
            width: this.thumbWidth,
            height: this.thumbHeight,
        };
    }

    offscreenSlot() {
        return {
            x: this.monitor.x - this.thumbWidth,
            y: this.workArea.y + (this.workArea.height - this.thumbHeight) / 2,
            width: this.thumbWidth,
            height: this.thumbHeight,
        };
    }

    /**
     * Rectangles for the window thumbnails inside a slot, front window
     * last, cascading the ones behind it up and to the right.
     *
     * @param {object} slot
     * @param {Meta.Window[]} windows
     */
    clones(slot, windows) {
        const shown = windows.slice(-MAX_CLONES);
        const sf = scaleFactor();
        const result = new Map();
        shown.forEach((window, i) => {
            const actor = window.get_compositor_private();
            if (!actor)
                return;
            const depth = shown.length - 1 - i;
            const fit = Math.min(
                slot.width * 0.92 / actor.width,
                slot.height * 0.92 / actor.height);
            const scale = fit * (1 - 0.07 * depth);
            const width = actor.width * scale;
            const height = actor.height * scale;
            const offset = depth * CLONE_CASCADE * sf;
            result.set(window, {
                x: slot.x + (slot.width - width) / 2 + offset,
                y: slot.y + (slot.height - height) / 2 - offset,
                width,
                height,
            });
        });
        return result;
    }
}

const StripItem = GObject.registerClass(
class StripItem extends St.Button {
    _init(manager, group) {
        super._init({
            style_class: 'stage-manager-item',
            reactive: true,
            track_hover: true,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._manager = manager;
        this.group = group;

        // Only the window thumbnails are tilted; tilting the app icon
        // too would squash it.
        this._content = new Clutter.Actor();
        this._tilted = new Clutter.Actor({
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
        });
        this._content.add_child(this._tilted);
        this.set_child(this._content);

        this.connect('notify::hover', () => this._syncTilt(true));
        this.connect('clicked', (button, mouseButton) =>
            manager.onItemClicked(group, mouseButton));

        this._revealId = 0;
        this.connect('destroy', () => this._onDestroy());

        this._delegate = this;
        this._draggable = DND.makeDraggable(this, {restoreOnSuccess: false});
        this._draggable.connect('drag-begin', () => manager.onItemDragBegin(this));
        this._draggable.connect('drag-end', () => manager.onItemDragEnd());
        this._draggable.connect('drag-cancelled', () => manager.onItemDragEnd());
    }

    get tilt() {
        return this._manager.tilt;
    }

    // A new or moved item may not have had its hover state updated yet,
    // so also check the pointer against the slot it sits in.
    _hovered() {
        if (this.hover)
            return true;
        if (!this._slot)
            return false;
        const [x, y] = global.get_pointer();
        const {x: sx, y: sy, width, height} = this._slot;
        return x >= sx && x < sx + width && y >= sy && y < sy + height;
    }

    _syncTilt(animate) {
        const hover = this._hovered();
        const tilt = {rotation_angle_y: hover ? this.tilt * HOVER_TILT : this.tilt};
        const scale = {
            scale_x: hover ? HOVER_SCALE : 1,
            scale_y: hover ? HOVER_SCALE : 1,
        };
        if (animate) {
            const params = {duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
            this._tilted.ease({...tilt, ...params});
            this.ease({...scale, ...params});
        } else {
            this._tilted.set(tilt);
            this.set(scale);
        }
    }

    rebuild(layout, slot) {
        this._tilted.destroy_all_children();
        this._icon?.destroy();
        this._icon = null;
        const first = !this._slot;
        this._slot = {x: slot.x, y: slot.y, width: slot.width, height: slot.height};
        this.set_size(slot.width, slot.height);
        this._content.set_size(slot.width, slot.height);
        this._tilted.set_size(slot.width, slot.height);

        let front = slot;
        for (const [window, rect] of layout.clones(slot, this.group.windows)) {
            front = rect;
            const clone = new Clutter.Clone({
                source: window.get_compositor_private(),
                x: rect.x - slot.x,
                y: rect.y - slot.y,
                width: rect.width,
                height: rect.height,
            });
            this._tilted.add_child(clone);
        }

        const app = this.group.app;
        if (app) {
            const sf = scaleFactor();
            const icon = app.create_icon_texture(ICON_SIZE);
            icon.add_style_class_name('stage-manager-item-icon');
            icon.set_position(
                front.x - slot.x - 8 * sf,
                front.y + front.height - slot.y - (ICON_SIZE - 8) * sf);
            this._content.add_child(icon);
            this._icon = icon;
            this.accessible_name = app.get_name();
        }

        // Rebuilds happen while hovered too; ease so the angle never jumps.
        this._syncTilt(!first);
    }

    revealAfter(delay) {
        if (this._revealId)
            GLib.source_remove(this._revealId);
        this._revealId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._revealId = 0;
            this.opacity = 255;
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDestroy() {
        if (this._revealId)
            GLib.source_remove(this._revealId);
        this._revealId = 0;
    }

    getDragActor() {
        return new Clutter.Clone({
            source: this._content,
            width: this.width,
            height: this.height,
        });
    }

    getDragActorSource() {
        return this;
    }
});

const Strip = GObject.registerClass(
class Strip extends St.Widget {
    _init(manager) {
        super._init({name: 'stageManagerStrip', reactive: false});
        this._manager = manager;
        this._items = new Map();
        this.layout = new StripLayout();
        this.layout.update();
        this._hidden = false;
        // A soft darkening along the left edge, behind the thumbnails.
        this._shade = new St.Widget({style_class: 'stage-manager-shade', reactive: false});
        this.add_child(this._shade);
        Main.layoutManager.addChrome(this, {trackFullscreen: true});
    }

    sync({animate = true, removeInstantly = null, revealLater = null} = {}) {
        this.layout.update();
        const groups = this._manager.stripGroups();
        const duration = animate ? SWITCH_DURATION : 0;

        const sf = scaleFactor();
        this._shade.set_position(this.layout.monitor.x, this.layout.workArea.y);
        this._shade.set_size(this.layout.right - this.layout.monitor.x + 48 * sf,
            this.layout.workArea.height);
        this.set_child_below_sibling(this._shade, null);
        this._shade.ease({
            opacity: groups.length ? 255 : 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        for (const [group, item] of this._items) {
            if (groups.includes(group))
                continue;
            this._items.delete(group);
            if (!animate || group === removeInstantly) {
                item.destroy();
                continue;
            }
            item.reactive = false;
            item.ease({
                opacity: 0,
                translation_x: -this.layout.thumbWidth / 2,
                duration: duration / 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => item.destroy(),
            });
        }

        groups.forEach((group, index) => {
            const slot = this.layout.slot(index, groups.length);
            let item = this._items.get(group);
            const isNew = !item;
            if (isNew) {
                item = new StripItem(this._manager, group);
                this._items.set(group, item);
                this.add_child(item);
                item.set_position(slot.x, slot.y);
            }

            item.rebuild(this.layout, slot);

            if (group === revealLater) {
                // A window is flying into this slot; show the item when it lands.
                item.opacity = 0;
                item.set_position(slot.x, slot.y);
                item.revealAfter(SWITCH_DURATION);
            } else if (isNew) {
                item.opacity = 0;
                item.translation_x = -slot.width / 2;
                item.ease({
                    opacity: 255,
                    translation_x: 0,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                item.ease({
                    x: slot.x,
                    y: slot.y,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            }
        });

        this._manager.syncStripVisibility();
    }

    /**
     * Stage rectangle of a window's thumbnail, if it is in the strip.
     *
     * @param {Meta.Window} window
     */
    thumbnailRect(window) {
        for (const [group, item] of this._items) {
            if (!group.windows.includes(window))
                continue;
            const [x, y] = item.get_transformed_position();
            const slot = {x, y, width: item.width, height: item.height};
            const rects = this.layout.clones(slot, group.windows);
            return rects.get(window) ?? rects.values().next().value ?? slot;
        }
        return null;
    }

    /**
     * Where a window should fly to once its group is in the strip.
     *
     * @param {Group} group
     * @param {Meta.Window} window
     */
    targetRect(group, window) {
        const groups = this._manager.stripGroups();
        const index = groups.indexOf(group);
        const slot = index >= 0
            ? this.layout.slot(index, groups.length)
            : this.layout.offscreenSlot();
        const rects = this.layout.clones(slot, group.windows);
        return rects.get(window) ?? slot;
    }

    get hasItems() {
        return this._items.size > 0;
    }

    setHidden(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        this.ease({
            translation_x: hidden ? -(this.layout.right - this.layout.monitor.x) : 0,
            opacity: hidden ? 0 : 255,
            duration: 260,
            mode: hidden
                ? Clutter.AnimationMode.EASE_IN_QUAD
                : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        for (const item of this._items.values())
            item.reactive = !hidden;
    }
});

export class StageManager {
    constructor(settings, effects) {
        this._settings = settings;
        this._effects = effects;
        this._groups = [];
        this._active = new Map();
        this._initialized = new Set();
        this._owned = new Set();
        this._restoring = new Map();
        this._restoreSources = new Map();
        this._clock = 0;
        this._revealed = false;
        this._grabbing = false;
        this._dropTarget = null;
        this._overlapLater = 0;
        this._pendingActors = new Set();
        this._switching = false;

        this.strip = new Strip(this);

        global.display.connectObject(
            'window-created', (d, w) => this._onWindowCreated(w),
            'notify::focus-window', () => this._onFocusChanged(),
            'grab-op-begin', (d, w, op) => this._onGrabBegin(w, op),
            'grab-op-end', (d, w, op) => this._onGrabEnd(w, op),
            'workareas-changed', () => this.strip.sync({animate: false}),
            this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._onWorkspaceChanged(), this);
        Main.overview.connectObject(
            'showing', () => this.syncStripVisibility(),
            'hidden', () => this.strip.sync({animate: false}),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this.strip.sync({animate: false}), this);
        this._settings.connectObject(
            'changed::stage-manager-max-groups', () => this.strip.sync(),
            'changed::stage-manager-tilt', () => this.strip.sync({animate: false}),
            this);

        this._pointerWatch = getPointerWatcher().addWatch(100,
            (x, y) => this._onPointerMoved(x, y));

        this._effects?.addProvider(this, {first: true});
        this._initWorkspace(global.workspace_manager.get_active_workspace());
    }

    destroy() {
        this._effects?.removeProvider(this);
        this._pointerWatch?.remove();
        this._pointerWatch = null;
        if (this._overlapLater)
            global.compositor.get_laters().remove(this._overlapLater);

        for (const actor of this._pendingActors)
            actor.disconnectObject(this);
        this._pendingActors.clear();

        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);

        for (const group of this._groups) {
            for (const window of group.windows)
                window.disconnectObject(this);
        }

        // Give back every window we tucked away.
        for (const window of this._owned) {
            const actor = window.get_compositor_private();
            if (actor)
                Main.wm.skipNextEffect(actor);
            window.unminimize();
        }
        this._owned.clear();

        this._dropTarget?.destroy();
        this.strip.destroy();
        this._groups = [];
    }

    get tilt() {
        // Negative so the inner edge recedes, like a page turned towards
        // the centre of the screen.
        return -this._settings.get_double('stage-manager-tilt');
    }

    /**
     * Whether `window` is minimized because Stage Manager tucked it away.
     *
     * @param {Meta.Window} window
     */
    ownsWindow(window) {
        return this._owned.has(window);
    }

    // Model

    _isManageable(window) {
        // Parentless dialogs (e.g. zenity) behave like app windows.
        return MANAGED_TYPES.includes(window.get_window_type()) &&
            !window.is_skip_taskbar() &&
            !window.get_transient_for() &&
            !window.is_on_all_workspaces() &&
            window.get_workspace() !== null &&
            window.get_monitor() === Main.layoutManager.primaryIndex &&
            window.can_minimize();
    }

    _groupOf(window) {
        return this._groups.find(g => g.windows.includes(window)) ?? null;
    }

    _appGroup(window, workspace) {
        if (!this._settings.get_boolean('stage-manager-group-by-app'))
            return null;
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        if (!app)
            return null;
        return this._groups.find(g => g.workspace === workspace &&
            g.windows.some(w => tracker.get_window_app(w) === app)) ?? null;
    }

    _touch(group) {
        group.lastUsed = ++this._clock;
    }

    stripGroups() {
        const workspace = global.workspace_manager.get_active_workspace();
        const active = this._active.get(workspace);
        const max = this._settings.get_int('stage-manager-max-groups');
        return this._groups
            .filter(g => g.workspace === workspace && g !== active && g.windows.length > 0)
            .sort((a, b) => b.lastUsed - a.lastUsed)
            .slice(0, max);
    }

    _initWorkspace(workspace) {
        if (this._initialized.has(workspace))
            return;
        this._initialized.add(workspace);

        const windows = global.display.sort_windows_by_stacking(
            workspace.list_windows().filter(w => this._isManageable(w) && !w.minimized));

        for (const window of windows) {
            let group = this._appGroup(window, workspace);
            if (!group) {
                group = new Group(workspace);
                this._groups.push(group);
            }
            group.raise(window);
            this._touch(group);
            this._connectWindow(window);
        }

        const focus = global.display.focus_window;
        const top = windows[windows.length - 1];
        const active = this._groupOf(focus) ?? this._groupOf(top);
        if (active)
            this._active.set(workspace, active);

        for (const group of this._groups) {
            if (group.workspace !== workspace || group === active)
                continue;
            for (const window of group.windows)
                this._hide(window, false);
        }

        if (workspace.active)
            this.strip.sync({animate: false});
    }

    _connectWindow(window) {
        window.connectObject(
            'unmanaged', () => this._removeWindow(window, true),
            'notify::minimized', () => this._onMinimizedChanged(window),
            'workspace-changed', () => this._onWindowWorkspaceChanged(window),
            'position-changed', () => this._queueOverlapCheck(),
            'size-changed', () => this._queueOverlapCheck(),
            this);
    }

    _addWindow(window, isNew) {
        if (!this._isManageable(window) || window.minimized || this._groupOf(window))
            return;
        const workspace = window.get_workspace();
        if (!this._initialized.has(workspace))
            return;

        let group = this._appGroup(window, workspace);
        if (!group) {
            group = new Group(workspace);
            this._groups.push(group);
        }
        group.raise(window);
        this._connectWindow(window);

        if (isNew)
            this._placeClearOfStrip(window);

        const active = this._active.get(workspace);
        if (active === group) {
            this._touch(group);
            this.strip.sync();
        } else if (workspace.active) {
            this.switchTo(group, {focus: false});
        } else {
            this._hide(window, false);
        }
    }

    _removeWindow(window, unmanaged) {
        const group = this._groupOf(window);
        window.disconnectObject(this);
        this._owned.delete(window);
        this._restoring.delete(window);
        if (!group)
            return;

        group.remove(window);
        const workspace = group.workspace;
        const wasActive = this._active.get(workspace) === group;

        if (group.windows.length === 0) {
            this._groups = this._groups.filter(g => g !== group);
            if (wasActive)
                this._active.delete(workspace);
        }

        if (!workspace.active)
            return;

        // Closing the last window on stage brings the most
        // recent set forward.
        if (unmanaged && wasActive && group.windows.length === 0) {
            const next = this.stripGroups()[0];
            if (next) {
                this.switchTo(next);
                return;
            }
        }
        this.strip.sync();
    }

    // Switching

    /**
     * Put `group` on stage. With `merge`, its windows join the current
     * stage instead of replacing it.
     *
     * @param {Group} group
     * @param {object} params
     */
    switchTo(group, {merge = false, focus = true} = {}) {
        const workspace = group.workspace;
        const current = this._active.get(workspace);
        if (current === group)
            return;

        // Remember where each window currently sits in the strip so it
        // can fly out from there.
        for (const window of group.windows) {
            const rect = this.strip.thumbnailRect(window);
            if (rect)
                this._restoreSources.set(window, rect);
        }

        let incoming = group.windows;
        let target = group;
        if (merge && current) {
            current.windows.push(...group.windows);
            this._groups = this._groups.filter(g => g !== group);
            target = current;
        } else {
            if (current)
                this._touch(current);
            this._active.set(workspace, group);
        }
        this._touch(target);
        incoming = [...incoming];

        const outgoing = !merge && current ? [...current.windows] : [];
        this.strip.sync({
            removeInstantly: group,
            revealLater: outgoing.length ? current : null,
        });

        // Bring the new set in and focus it before hiding the old one.
        // Otherwise minimizing the focused window hands focus to another
        // window of the outgoing set, which would switch straight back.
        this._switching = true;
        try {
            for (const window of incoming) {
                if (window.minimized && this._owned.has(window))
                    window.unminimize();
            }

            const top = incoming[incoming.length - 1];
            if (focus && top && !top.has_focus())
                top.activate(global.get_current_time());

            for (const window of outgoing)
                this._hide(window, true);
        } finally {
            this._switching = false;
        }

        this._restoreSources.clear();
    }

    _hide(window, animate) {
        if (window.minimized)
            return;
        this._owned.add(window);
        const actor = window.get_compositor_private();
        if (!animate && actor)
            Main.wm.skipNextEffect(actor);
        window.minimize();
    }

    onItemClicked(group, button) {
        const event = Clutter.get_current_event();
        const shift = event &&
            (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        this.switchTo(group, {merge: shift || button === Clutter.BUTTON_MIDDLE});
    }

    // Window events

    _onWindowCreated(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            this._addWindow(window, true);
            return;
        }
        // A new window of an app that is already in the strip brings its
        // set on stage before it is first drawn, rather than popping up
        // over the current stage first.
        if (this._isManageable(window) && this._appGroup(window, window.get_workspace()))
            this._addWindow(window, false);

        this._pendingActors.add(actor);
        actor.connectObject('first-frame', () => {
            actor.disconnectObject(this);
            this._pendingActors.delete(actor);
            // Focus may have already added it before the first frame.
            if (this._groupOf(window))
                this._placeClearOfStrip(window);
            else
                this._addWindow(window, true);
        }, this);
    }

    _onFocusChanged() {
        const window = global.display.focus_window;
        if (this._switching || !window || !window.get_workspace()?.active)
            return;

        const group = this._groupOf(window);
        if (!group) {
            this._addWindow(window, false);
            return;
        }
        group.raise(window);
        if (this._active.get(group.workspace) !== group)
            this.switchTo(group);
    }

    _onMinimizedChanged(window) {
        if (window.minimized) {
            // Minimized by the user rather than by us: drop it from Stage
            // Manager until it comes back.
            if (!this._owned.has(window))
                this._removeWindow(window, false);
            return;
        }

        if (!this._owned.delete(window))
            return;

        // One of our windows was restored (by us, the dock, alt-tab, ...).
        const source = this._restoreSources.get(window) ??
            this.strip.thumbnailRect(window);
        this._restoring.set(window, source);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_TIMEOUT, () => {
            this._restoring.delete(window);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onWindowWorkspaceChanged(window) {
        if (!this._groupOf(window))
            return;
        const wasOwned = this._owned.has(window);
        this._removeWindow(window, false);
        if (wasOwned) {
            const actor = window.get_compositor_private();
            if (actor)
                Main.wm.skipNextEffect(actor);
            window.unminimize();
        }
        this._addWindow(window, false);
    }

    _onWorkspaceChanged() {
        const workspace = global.workspace_manager.get_active_workspace();
        if (this._initialized.has(workspace))
            this.strip.sync({animate: false});
        else
            this._initWorkspace(workspace);
    }

    _placeClearOfStrip(window) {
        if (!this._settings.get_boolean('stage-manager-avoid-strip'))
            return;
        if (window.is_maximized() || window.is_fullscreen())
            return;

        const layout = this.strip.layout;
        layout.update();
        const frame = window.get_frame_rect();
        if (frame.x >= layout.right)
            return;

        const workArea = window.get_work_area_for_monitor(layout.monitor.index);
        const available = workArea.x + workArea.width - layout.right;
        const x = frame.width <= available
            ? layout.right + (available - frame.width) / 2
            : Math.max(workArea.x, workArea.x + workArea.width - frame.width);
        window.move_frame(true, Math.round(x), frame.y);
    }

    // Dragging windows into the strip

    _onGrabBegin(window, op) {
        if (!MOVE_OPS.includes(op) || !this._groupOf(window))
            return;
        this._grabbing = true;
        this.syncStripVisibility();
    }

    _onGrabEnd(window, op) {
        if (!this._grabbing)
            return;
        this._grabbing = false;

        const group = this._groupOf(window);
        const [x] = global.get_pointer();
        if (MOVE_OPS.includes(op) && group &&
            this._active.get(group.workspace) === group && x < this.strip.layout.right) {
            // Split the window off into its own set at the top of the strip.
            group.remove(window);
            if (group.windows.length === 0) {
                this._groups = this._groups.filter(g => g !== group);
                this._active.delete(group.workspace);
            }
            const solo = new Group(group.workspace);
            solo.windows.push(window);
            this._groups.push(solo);
            this._touch(solo);
            this.strip.sync({revealLater: solo});
            this._hide(window, true);
        }
        this.syncStripVisibility();
    }

    // Dragging thumbnails onto the stage

    onItemDragBegin(item) {
        const {monitor, right} = this.strip.layout;
        this._dropTarget = new St.Widget({
            reactive: true,
            x: right,
            y: monitor.y,
            width: monitor.x + monitor.width - right,
            height: monitor.height,
        });
        this._dropTarget._delegate = {
            handleDragOver: () => DND.DragMotionResult.MOVE_DROP,
            acceptDrop: () => {
                // Let the drag finish before windows start moving.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._groups.includes(item.group))
                        this.switchTo(item.group, {merge: true});
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            },
        };
        Main.layoutManager.uiGroup.insert_child_below(this._dropTarget, this.strip);
    }

    onItemDragEnd() {
        this._dropTarget?.destroy();
        this._dropTarget = null;
    }

    // Strip visibility

    _queueOverlapCheck() {
        if (this._overlapLater)
            return;
        this._overlapLater = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._overlapLater = 0;
                this.syncStripVisibility();
                return GLib.SOURCE_REMOVE;
            });
    }

    _stageOverlapsStrip() {
        const workspace = global.workspace_manager.get_active_workspace();
        const active = this._active.get(workspace);
        if (!active)
            return false;
        const strip = this.strip.layout.rect;
        return active.windows.some(w =>
            w.showing_on_its_workspace() && rectsOverlap(w.get_frame_rect(), strip));
    }

    _onPointerMoved(x, y) {
        const {monitor, workArea, right} = this.strip.layout;
        const inMonitorRows = y >= workArea.y && y < workArea.y + workArea.height;
        let revealed = this._revealed;
        if (x <= monitor.x + REVEAL_EDGE * scaleFactor() && inMonitorRows)
            revealed = true;
        else if (x > right + REVEAL_RELEASE * scaleFactor() || !inMonitorRows)
            revealed = false;

        if (revealed !== this._revealed) {
            this._revealed = revealed;
            this.syncStripVisibility();
        }
    }

    syncStripVisibility() {
        const hidden = Main.overview.visible || !this.strip.hasItems ||
            (!this._revealed && !this._grabbing && this._stageOverlapsStrip());
        this.strip.setHidden(hidden);
    }

    // Window effects provider

    _fly(clone, rect, toStrip, done) {
        const tilt = this.tilt;
        clone.set_pivot_point(0, 0.5);
        const strip = {...rect, rotation_angle_y: tilt, opacity: 255};
        const stage = {
            x: clone.x,
            y: clone.y,
            width: clone.width,
            height: clone.height,
            rotation_angle_y: 0,
            opacity: 255,
        };
        clone.set(toStrip ? stage : strip);
        clone.ease({
            ...(toStrip ? strip : stage),
            duration: SWITCH_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: done,
        });
    }

    minimize(actor, effects) {
        const window = actor.meta_window;
        if (!this._owned.has(window))
            return false;
        const group = this._groupOf(window);
        if (!group)
            return false;

        const rect = this.strip.targetRect(group, window);
        // Flying among the windows keeps the stacking right: windows going
        // to the strip pass beneath the ones coming on stage, and those
        // land in their place in the stack.
        effects.runOnClone(actor, true, (clone, done) =>
            this._fly(clone, rect, true, done), {inStack: true});
        return true;
    }

    unminimize(actor, effects) {
        const window = actor.meta_window;
        if (!this._restoring.has(window))
            return false;
        const rect = this._restoring.get(window) ?? this.strip.layout.offscreenSlot();
        this._restoring.delete(window);

        effects.runOnClone(actor, false, (clone, done) =>
            this._fly(clone, rect, false, done), {inStack: true});
        return true;
    }
}
