// A Launchpad: a full-screen app grid over a blurred desktop,
// separate from the Activities overview. Apps are laid out alphabetically
// in pages that scroll sideways; typing filters them. The Dock stays on
// top of it, so apps can be dragged straight from the grid into the Dock.
//
// On a touchpad, pinching with three or more fingers opens it and spreading
// them closes it, following the fingers; two-finger swipes turn pages.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Backdrop} from './backdrop.js';

const OPEN_DURATION = 260;
const PAGE_DURATION = 380;
const ZOOM = 1.08;

const ICON_SIZE = 80;
const CELL_WIDTH = 132;
const CELL_HEIGHT = 136;
const MIN_COLUMNS = 5;
const MAX_COLUMNS = 10;
const MAX_ROWS = 5;
const TOP_SPACE = 96;
const BOTTOM_SPACE = 150;
const SIDE_MARGIN = 0.07;

// Pinching: how much the finger spread changes (as a scale) for a full
// open or close, and how far along a gesture must get to take effect.
const PINCH_MIN_FINGERS = 3;
const PINCH_DISTANCE = 0.35;
const PINCH_COMMIT = 0.3;

// Touchpad paging: pixels per scroll unit, how far a page must be dragged
// to turn, and how long without scroll events counts as the fingers lifting.
const SCROLL_MULTIPLIER = 10;
const PAGE_TURN_FRACTION = 0.15;
const SCROLL_END_TIMEOUT = 150;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

export const Launchpad = GObject.registerClass({
    Signals: {
        'showing': {},
        'opened': {},
        'closed': {},
    },
}, class Launchpad extends St.Widget {
    _init(settings) {
        super._init({
            name: 'fruitLaunchpad',
            reactive: true,
            visible: false,
        });

        this._settings = settings;
        this.isOpen = false;
        this._grab = null;
        this._pinch = null;
        this._scroll = null;
        this._scrollTimeoutId = 0;
        this._page = 0;
        this._nPages = 1;
        this._icons = new Map();
        this._appSystem = Shell.AppSystem.get_default();

        this._backdrop = new Backdrop({radius: 80, brightness: 0.6});
        this.add_child(this._backdrop);
        this._bg = new St.Widget({style_class: 'fruit-launchpad-background'});
        this.add_child(this._bg);

        this._content = new St.Widget({
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.add_child(this._content);

        this._search = new St.Entry({
            style_class: 'fruit-launchpad-search',
            hint_text: _('Search'),
            can_focus: true,
            track_hover: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'fruit-launchpad-search-icon',
            }),
        });
        this._search.clutter_text.connectObject(
            'text-changed', () => this._layoutApps(),
            'activate', () => this._activateFirst(),
            this);
        this._content.add_child(this._search);

        this._clip = new St.Widget({clip_to_allocation: true});
        this._pages = new St.Widget();
        this._clip.add_child(this._pages);
        this._content.add_child(this._clip);

        this._dots = new St.BoxLayout({style_class: 'fruit-launchpad-dots'});
        this._content.add_child(this._dots);

        this.connect('key-press-event', (a, event) => this._onKeyPress(event));
        this.connect('scroll-event', (a, event) => this._onScroll(event));
        this.connect('button-release-event', (a, event) => this._onRelease(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addChrome(this);

        this._appSystem.connectObject('installed-changed', () => {
            for (const icon of this._icons.values())
                icon.destroy();
            this._icons.clear();
            if (this.isOpen)
                this._layoutApps();
        }, this);
        Main.overview.connectObject('showing', () => this.close(), this);
        global.stage.connectObject('captured-event',
            (stage, event) => this._onStageEvent(event), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this.isOpen)
                this._relayout();
        }, this);
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;
        if (Main.overview.visible)
            Main.overview.hide();

        // Something else (a window drag, a popup) holds the input.
        if (global.display.is_grabbed()) {
            if (this.visible)
                this._fadeOut();
            return;
        }
        this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.OVERVIEW});

        this.isOpen = true;
        this._prepare();
        this._animateTo(1);
        this._search.grab_key_focus();
        this.emit('opened');
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._fadeOut();
        this.emit('closed');
    }

    // Shows the Launchpad, fully transparent, unless it's already showing
    // (half-way through a gesture or closing).
    _prepare() {
        if (this.visible)
            return;
        // Cover all other chrome (panel, Stage Manager strip); the Dock
        // raises itself above us when it sees 'showing'.
        this.get_parent().set_child_below_sibling(this, global.top_window_group);
        this._search.text = '';
        this._relayout();
        this._setPage(0, false);
        this._setProgress(0);
        this.show();
        this.emit('showing');
    }

    // 0 is closed (transparent and zoomed in), 1 is open.
    _setProgress(progress) {
        this.remove_all_transitions();
        this._content.remove_all_transitions();
        this.opacity = Math.round(255 * progress);
        const scale = ZOOM + (1 - ZOOM) * progress;
        this._content.set_scale(scale, scale);
    }

    _animateTo(progress, onStopped) {
        const duration = OPEN_DURATION * Math.abs(progress - this.opacity / 255);
        const mode = progress > 0
            ? Clutter.AnimationMode.EASE_OUT_QUAD
            : Clutter.AnimationMode.EASE_IN_QUAD;
        const scale = ZOOM + (1 - ZOOM) * progress;
        this.ease({
            opacity: Math.round(255 * progress),
            duration,
            mode,
            onStopped,
        });
        this._content.ease({scale_x: scale, scale_y: scale, duration, mode});
    }

    _fadeOut() {
        this._animateTo(0, () => {
            if (!this.isOpen && !this._pinch)
                this.hide();
        });
    }

    // Pinch gestures

    _onStageEvent(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_PINCH)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            if (!this._settings.get_boolean('launchpad-gestures') ||
                event.get_touchpad_gesture_finger_count() < PINCH_MIN_FINGERS ||
                Main.overview.visible ||
                (!this.isOpen && global.display.is_grabbed()))
                return Clutter.EVENT_PROPAGATE;
            this._pinch = {opening: !this.isOpen, progress: this.isOpen ? 1 : 0};
            if (this._pinch.opening)
                this._prepare();
            return Clutter.EVENT_STOP;
        }

        const pinch = this._pinch;
        if (!pinch)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            // Pinching in opens, spreading out closes.
            const scale = event.get_gesture_pinch_scale();
            pinch.progress = pinch.opening
                ? Math.clamp((1 - scale) / PINCH_DISTANCE, 0, 1)
                : Math.clamp(1 - (scale - 1) / PINCH_DISTANCE, 0, 1);
            this._setProgress(pinch.progress);
            return Clutter.EVENT_STOP;
        }

        // Ended or cancelled.
        this._pinch = null;
        const ended = phase === Clutter.TouchpadGesturePhase.END;
        if (pinch.opening) {
            if (ended && pinch.progress > PINCH_COMMIT)
                this.open();
            else
                this._fadeOut();
        } else if (ended && pinch.progress < 1 - PINCH_COMMIT) {
            this.close();
        } else {
            this._animateTo(1);
        }
        return Clutter.EVENT_STOP;
    }

    // Layout

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        const sf = scaleFactor();
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, monitor.height);
        this._backdrop.set_size(monitor.width, monitor.height);
        this._bg.set_size(monitor.width, monitor.height);
        this._content.set_size(monitor.width, monitor.height);

        const [, searchH] = this._search.get_preferred_height(-1);
        const searchW = Math.round(260 * sf);
        this._search.set_size(searchW, searchH);
        this._search.set_position(
            Math.round((monitor.width - searchW) / 2),
            Math.round((TOP_SPACE * sf - searchH) / 2 + 12 * sf));

        const margin = Math.round(monitor.width * SIDE_MARGIN);
        const gridW = monitor.width - 2 * margin;
        const gridH = monitor.height - (TOP_SPACE + BOTTOM_SPACE) * sf;
        this._grid = {
            margin,
            top: TOP_SPACE * sf,
            columns: Math.clamp(Math.floor(gridW / (CELL_WIDTH * sf)), MIN_COLUMNS, MAX_COLUMNS),
            rows: Math.clamp(Math.floor(gridH / (CELL_HEIGHT * sf)), 1, MAX_ROWS),
        };
        this._grid.pitchX = gridW / this._grid.columns;
        this._grid.pitchY = gridH / this._grid.rows;

        this._clip.set_position(0, 0);
        this._clip.set_size(monitor.width, monitor.height);
        this._dotsY = monitor.height - (BOTTOM_SPACE - 24) * sf;

        this._layoutApps();
    }

    _apps() {
        const query = this._search.text.trim();
        let apps;
        if (query) {
            apps = Shell.AppSystem.search(query).flat()
                .map(id => this._appSystem.lookup_app(id));
        } else {
            apps = this._appSystem.get_installed()
                .map(info => this._appSystem.lookup_app(info.get_id()));
        }
        apps = apps.filter(app => app?.app_info?.should_show());
        if (!query)
            apps.sort((a, b) => a.get_name().localeCompare(b.get_name()));
        return apps;
    }

    _iconFor(app) {
        let icon = this._icons.get(app.get_id());
        if (icon)
            return icon;

        icon = new AppDisplay.AppIcon(app, {expandTitleOnHover: false});
        icon.icon.setIconSize(ICON_SIZE);
        icon.add_style_class_name('fruit-launchpad-icon');
        const activate = icon.activate.bind(icon);
        icon.activate = button => {
            activate(button);
            this.close();
        };
        this._icons.set(app.get_id(), icon);
        return icon;
    }

    _layoutApps() {
        if (!this._grid)
            return;
        const sf = scaleFactor();
        const {margin, top, columns, rows, pitchX, pitchY} = this._grid;
        const perPage = columns * rows;
        const width = this.width;

        const apps = this._apps();
        const icons = apps.map(app => this._iconFor(app));

        // Only add and remove what changed, so typing doesn't rebuild the
        // whole grid.
        const wanted = new Set(icons);
        for (const child of this._pages.get_children()) {
            if (!wanted.has(child))
                this._pages.remove_child(child);
        }

        const cellW = Math.round(Math.min(pitchX, CELL_WIDTH * sf));
        const cellH = Math.round(Math.min(pitchY, CELL_HEIGHT * sf));
        icons.forEach((icon, i) => {
            const page = Math.floor(i / perPage);
            const slot = i % perPage;
            icon.set_size(cellW, cellH);
            icon.set_position(
                Math.round(page * width + margin + (slot % columns + 0.5) * pitchX - cellW / 2),
                Math.round(top + (Math.floor(slot / columns) + 0.5) * pitchY - cellH / 2));
            if (icon.get_parent() !== this._pages)
                this._pages.add_child(icon);
            this._pages.set_child_at_index(icon, i);
        });

        this._nPages = Math.max(1, Math.ceil(apps.length / perPage));
        this._syncDots();
        this._setPage(Math.min(this._page, this._nPages - 1), false);
    }

    _syncDots() {
        this._dots.destroy_all_children();
        if (this._nPages > 1) {
            for (let i = 0; i < this._nPages; i++) {
                const dot = new St.Button({
                    style_class: 'fruit-launchpad-dot',
                    can_focus: false,
                });
                dot.connect('clicked', () => this._setPage(i, true));
                this._dots.add_child(dot);
            }
        }
        const [, w] = this._dots.get_preferred_width(-1);
        this._dots.set_position(Math.round((this.width - w) / 2), Math.round(this._dotsY ?? 0));
    }

    _setPage(page, animate) {
        page = Math.clamp(page, 0, this._nPages - 1);
        this._page = page;
        this._pages.remove_transition('translation-x');
        this._pages.ease({
            translation_x: -page * this.width,
            duration: animate ? PAGE_DURATION : 0,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._dots.get_children().forEach((dot, i) => {
            if (i === page)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
        });
    }

    _activateFirst() {
        const apps = this._apps();
        const app = apps[this._page * this._grid.columns * this._grid.rows];
        const icon = app ? this._iconFor(app) : null;
        icon?.activate(Clutter.BUTTON_PRIMARY);
    }

    // Input

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            if (this._search.text)
                this._search.text = '';
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        const searching = this._search.text !== '';
        if (key === Clutter.KEY_Page_Down || (!searching && key === Clutter.KEY_Right)) {
            this._setPage(this._page + 1, true);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Page_Up || (!searching && key === Clutter.KEY_Left)) {
            this._setPage(this._page - 1, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            // Touchpads page by following the fingers. Wheels also send
            // discrete events, which are handled below instead.
            if (event.get_scroll_source() === Clutter.ScrollSource.FINGER)
                this._onTouchpadScroll(event);
            return Clutter.EVENT_STOP;
        }

        // Clutter turns touchpad scrolling into discrete steps too; those
        // would turn several pages per swipe.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        if (this._pages.get_transition('translation-x'))
            return Clutter.EVENT_STOP;
        if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT)
            this._setPage(this._page + 1, true);
        else if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT)
            this._setPage(this._page - 1, true);
        return Clutter.EVENT_STOP;
    }

    _onTouchpadScroll(event) {
        if (!this._scroll) {
            this._pages.remove_transition('translation-x');
            this._scroll = {offset: 0, axis: null};
        }
        const scroll = this._scroll;

        const [dx, dy] = event.get_scroll_delta();
        // Follow whichever direction the swipe started in.
        if (!scroll.axis && (dx || dy))
            scroll.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        scroll.offset += (scroll.axis === 'y' ? dy : dx) * SCROLL_MULTIPLIER * scaleFactor();

        // Resist past the first and last page.
        let offset = scroll.offset;
        if ((this._page === 0 && offset < 0) ||
            (this._page === this._nPages - 1 && offset > 0))
            offset /= 3;
        this._pages.translation_x = -this._page * this.width - offset;

        if (this._scrollTimeoutId)
            GLib.source_remove(this._scrollTimeoutId);
        this._scrollTimeoutId = 0;
        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE) {
            this._endTouchpadScroll();
        } else {
            this._scrollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                SCROLL_END_TIMEOUT, () => {
                    this._scrollTimeoutId = 0;
                    this._endTouchpadScroll();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _endTouchpadScroll() {
        const scroll = this._scroll;
        this._scroll = null;
        if (!scroll)
            return;
        let page = this._page;
        if (Math.abs(scroll.offset) > this.width * PAGE_TURN_FRACTION)
            page += Math.sign(scroll.offset);
        this._setPage(page, true);
    }

    _onRelease(event) {
        // Clicking empty space closes.
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        for (let a = global.stage.get_event_actor(event); a && a !== this; a = a.get_parent()) {
            if (a === this._search || a === this._dots || a instanceof AppDisplay.AppIcon)
                return Clutter.EVENT_PROPAGATE;
        }
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        if (this._scrollTimeoutId)
            GLib.source_remove(this._scrollTimeoutId);
        global.stage.disconnectObject(this);
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._appSystem.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const icon of this._icons.values())
            icon.destroy();
        this._icons.clear();
    }
});
