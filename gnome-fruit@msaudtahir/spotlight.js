// A Spotlight: a floating search bar (Super+Space, or the
// magnifier in the top bar) backed by GNOME's own search, so it finds apps,
// files, settings, calculations and everything else GNOME's search
// providers offer, without opening the overview.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {Backdrop} from './backdrop.js';

const WIDTH = 680;
const RESULTS_HEIGHT = 440;
const TOP_FRACTION = 0.2;
const CORNER_RADIUS = 14;
const OPEN_DURATION = 150;
const CLOSE_DURATION = 120;

const WEB_SEARCH_URL = 'https://duckduckgo.com/?q=';

const WM_KEYBINDINGS_SCHEMA = 'org.gnome.desktop.wm.keybindings';

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function normalizeAccel(accel) {
    return accel.toLowerCase().replace(/\s/g, '');
}

// GNOME's results view never disconnects some of its signals, so it can't
// be destroyed safely. One instance is made on first use and reused, also
// across disable/enable.
let sharedResults = null;

function getResultsView() {
    sharedResults ??= new Search.SearchResultsView();
    return sharedResults;
}

// Lets the results grow with their content, up to a maximum height.
const MaxHeightLayout = GObject.registerClass(
class MaxHeightLayout extends Clutter.BinLayout {
    _init() {
        super._init();
        this.maxHeight = -1;
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [min, nat] = super.vfunc_get_preferred_height(container, forWidth);
        if (this.maxHeight < 0)
            return [min, nat];
        return [Math.min(min, this.maxHeight), Math.min(nat, this.maxHeight)];
    }
});

const SpotlightButton = GObject.registerClass(
class SpotlightButton extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.0, _('Spotlight'), true);
        this._onActivate = onActivate;
        this.add_child(new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'system-status-icon',
        }));
    }

    vfunc_event(event) {
        const type = event.type();
        // On release: Spotlight's own grab would otherwise see the release
        // of the click that opened it as a click outside, and close.
        if (type === Clutter.EventType.BUTTON_RELEASE ||
            type === Clutter.EventType.TOUCH_END) {
            this._onActivate();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

export const Spotlight = GObject.registerClass(
class Spotlight extends St.Widget {
    _init(settings, launchpad) {
        super._init({
            name: 'fruitSpotlight',
            reactive: true,
            visible: false,
        });

        this._settings = settings;
        this._launchpad = launchpad;
        this.isOpen = false;
        this._grab = null;

        this._panel = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this.add_child(this._panel);

        this._backdrop = new Backdrop({
            radius: 60,
            brightness: 0.8,
            cornerRadius: CORNER_RADIUS * scaleFactor(),
        });
        this._panel.add_child(this._backdrop);

        this._box = new St.BoxLayout({
            style_class: 'fruit-spotlight',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._panel.add_child(this._box);

        this._entry = new St.Entry({
            style_class: 'fruit-spotlight-entry',
            hint_text: _('Spotlight Search'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'fruit-spotlight-entry-icon',
            }),
        });
        this._entry.clutter_text.connectObject(
            'text-changed', () => this._onTextChanged(),
            'key-press-event', (a, event) => this._onEntryKeyPress(event),
            this);
        this._box.add_child(this._entry);

        this._separator = new St.Widget({
            style_class: 'fruit-spotlight-separator',
            visible: false,
        });
        this._box.add_child(this._separator);

        this._resultsLayout = new MaxHeightLayout();
        this._resultsBin = new St.Widget({
            layout_manager: this._resultsLayout,
            style_class: 'fruit-spotlight-results',
            visible: false,
        });
        this._box.add_child(this._resultsBin);

        this._webRow = this._makeRow('fruit-spotlight-web',
            'web-browser-symbolic', () => this._searchWeb());
        this._box.add_child(this._webRow);

        this._results = getResultsView();
        this._results.get_parent()?.remove_child(this._results);
        this._results.highlightDefault(true);
        this._resultsBin.add_child(this._results);

        this.connect('key-press-event', (a, event) => this._onKeyPress(event));
        this.connect('button-release-event', (a, event) => this._onRelease(event));
        this.connect('destroy', () => this._onDestroy());

        Main.layoutManager.addTopChrome(this);

        this._button = new SpotlightButton(() => this.toggle());
        const right = Main.panel._rightBox;
        const quickSettings = Main.panel.statusArea.quickSettings?.container;
        const index = right.get_children().indexOf(quickSettings);
        Main.panel.addToStatusArea('fruit-spotlight', this._button,
            Math.max(index, 0), 'right');

        this._bindShortcut();
        this._settings.connectObject('changed::spotlight-shortcut', () => {
            this._unbindShortcut();
            this._bindShortcut();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            if (this.isOpen)
                this._relayout();
        }, this);
    }

    // Super+Space belongs to GNOME's input source switcher by default. With
    // the same shortcut, take it over while Spotlight is on and hand it back
    // afterwards.
    _bindShortcut() {
        const ours = this._settings.get_strv('spotlight-shortcut').map(normalizeAccel);
        const wm = new Gio.Settings({schema_id: WM_KEYBINDINGS_SCHEMA});
        this._tookInputSwitch = wm.get_strv('switch-input-source')
            .some(accel => ours.includes(normalizeAccel(accel)));
        if (this._tookInputSwitch)
            Main.wm.removeKeybinding('switch-input-source');

        Main.wm.addKeybinding('spotlight-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.toggle());
    }

    _unbindShortcut() {
        Main.wm.removeKeybinding('spotlight-shortcut');
        if (!this._tookInputSwitch)
            return;
        this._tookInputSwitch = false;

        const manager = Keyboard.getInputSourceManager();
        manager._keybindingAction = Main.wm.addKeybinding('switch-input-source',
            new Gio.Settings({schema_id: WM_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            manager._switchInputSource.bind(manager));
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
        this._launchpad?.close();

        if (global.display.is_grabbed())
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this.isOpen = true;

        // GNOME's results toggle the overview once activated (it's where
        // they normally live). Make that close Spotlight instead.
        const close = () => this.close();
        Main.overview.toggle = close;
        Main.overview.hide = close;

        this._entry.text = '';
        this._relayout();
        this.remove_all_transitions();
        this.show();
        this.opacity = 0;
        this.ease({
            opacity: 255,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._entry.grab_key_focus();
    }

    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;

        delete Main.overview.toggle;
        delete Main.overview.hide;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this.ease({
            opacity: 0,
            duration: CLOSE_DURATION,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (this.isOpen)
                    return;
                this.hide();
                this._entry.text = '';
            },
        });
    }

    _relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        const sf = scaleFactor();
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, monitor.height);

        const width = Math.min(WIDTH * sf, monitor.width - 32 * sf);
        this._panel.set_width(width);
        this._panel.set_position(
            Math.round((monitor.width - width) / 2),
            Math.round(monitor.height * TOP_FRACTION));
        this._resultsLayout.maxHeight = RESULTS_HEIGHT * sf;
        this._resultsLayout.layout_changed();
    }

    _makeRow(styleClass, iconName, onActivate) {
        const row = new St.Button({
            style_class: `fruit-spotlight-row ${styleClass}`,
            can_focus: true,
            x_expand: true,
            visible: false,
        });
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'fruit-spotlight-row-icon',
        }));
        row._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(row._label);
        row.set_child(box);
        row.connect('clicked', onActivate);
        return row;
    }

    _onTextChanged() {
        const text = this._entry.text.trim();
        const terms = text ? text.split(/\s+/) : [];
        this._results.setTerms(terms);
        const searching = terms.length > 0;
        this._resultsBin.visible = searching;
        this._separator.visible = searching;

        this._webRow.visible = searching;
        if (searching)
            this._webRow._label.text = _('Search the web for “%s”').format(text);
    }

    _searchWeb() {
        const text = this._entry.text.trim();
        this.close();
        if (!text)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(
                WEB_SEARCH_URL + encodeURIComponent(text), global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`Spotlight: can't open the browser: ${e.message}`);
        }
    }

    _onEntryKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            // Without a result of GNOME's own, search the web.
            if (this._results._defaultResult || !this._entry.text.trim())
                this._results.activateDefault();
            else
                this._searchWeb();
            return Clutter.EVENT_STOP;
        }
        if (!this._entry.text)
            return Clutter.EVENT_PROPAGATE;
        if (key === Clutter.KEY_Tab || key === Clutter.KEY_Down) {
            this._results.navigateFocus(St.DirectionType.TAB_FORWARD);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyPress(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        if (this._entry.text && global.stage.key_focus === this._entry.clutter_text)
            this._entry.text = '';
        else
            this.close();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        // Clicking outside the search panel closes it.
        const target = global.stage.get_event_actor(event);
        if (target && this._panel.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this.close();
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        if (this.isOpen) {
            delete Main.overview.toggle;
            delete Main.overview.hide;
        }
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;

        this._unbindShortcut();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._button.destroy();

        // Keep the shared results view alive for next time.
        this._results.setTerms([]);
        this._resultsBin.remove_child(this._results);
    }
});
