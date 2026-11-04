import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {SHELL_KEYBINDINGS_SCHEMA} from 'resource:///org/gnome/shell/ui/windowManager.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {AppExpose} from './appExpose.js';
import {Dock} from './dock.js';
import {openForceQuit} from './forceQuit.js';
import {HotCorners} from './hotCorners.js';
import {LockGuard} from './lockGuard.js';
import {Launchpad} from './launchpad.js';
import {MenuBar} from './menubar.js';
import {FullscreenSpaces} from './spaces.js';
import {Spotlight} from './spotlight.js';
import {ShowDesktop} from './showDesktop.js';
import {MissionControlLabels} from './missionControl.js';
import {StageManager} from './stageManager.js';
import {Tiling} from './tiling.js';
import {hideApp, hideOthers} from './windowActions.js';
import {WindowEffects} from './windowEffects.js';

const StageManagerToggle = GObject.registerClass(
class StageManagerToggle extends QuickToggle {
    _init(extension, settings) {
        super._init({
            title: _('Stage Manager'),
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/stage-manager-symbolic.svg`),
            toggleMode: true,
        });
        settings.bind('stage-manager-enabled',
            this, 'checked', Gio.SettingsBindFlags.DEFAULT);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension, settings) {
        super._init();
        this.quickSettingsItems.push(new StageManagerToggle(extension, settings));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class GnomeFruitExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._effects = new WindowEffects();
        if (!this._effects.available) {
            this._effects.destroy();
            this._effects = null;
        }

        this._indicator = new Indicator(this, this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        Main.wm.addKeybinding('stage-manager-toggle', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => {
                const key = 'stage-manager-enabled';
                this._settings.set_boolean(key, !this._settings.get_boolean(key));
            });

        // The app grid moves out of the overview into the Launchpad. It
        // must exist before the Dock, which sits above it.
        this._launchpad = new Launchpad(this._settings);
        this._redirectAppGrid(() => this._launchpad.toggle());

        this._settings.connectObject(
            'changed::stage-manager-enabled', () => this._syncStageManager(),
            'changed::dock-enabled', () => this._syncDock(),
            'changed::fullscreen-spaces', () => this._syncSpaces(),
            'changed::spotlight-enabled', () => this._syncSpotlight(),
            'changed::menubar-enabled', () => this._syncMenuBar(),
            'changed::menubar-fruit-layout', () => {
                if (!this._menuBar)
                    return;
                this._menuBar.destroy();
                this._menuBar = null;
                this._syncMenuBar();
            },
            'changed::window-buttons-left', () => this._syncWindowButtons(),
            'changed::notifications-right', () => this._syncNotifications(),
            this);

        Main.wm.addKeybinding('force-quit-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => openForceQuit());
        this._lockGuard = new LockGuard();
        this._appExpose = new AppExpose();
        this._missionControl = new MissionControlLabels();
        this._showDesktop = new ShowDesktop();
        this._tiling = new Tiling(this._settings, () => this._stageManager);
        const focusApp = () => Shell.WindowTracker.get_default().focus_app;
        const normal = Shell.ActionMode.NORMAL;
        Main.wm.addKeybinding('show-desktop-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, normal, () => this._showDesktop.toggle());
        Main.wm.addKeybinding('hide-others-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, normal, () => hideOthers(focusApp()));
        Main.wm.addKeybinding('toggle-fullscreen-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE, normal, () => {
                const window = global.display.focus_window;
                if (!window)
                    return;
                if (window.is_fullscreen())
                    window.unmake_fullscreen();
                else if (window.get_window_type() === Meta.WindowType.NORMAL)
                    window.make_fullscreen();
            });
        // Super+H hides the whole app, not just the focused window.
        Meta.keybindings_set_custom_handler('minimize', () => hideApp(focusApp()));
        this._hotCorners = new HotCorners(this._settings, {
            launchpad: this._launchpad,
            showDesktop: this._showDesktop,
            appExpose: this._appExpose,
        });

        this._syncDock();
        this._syncStageManager();
        this._syncSpaces();
        this._syncSpotlight();
        this._syncMenuBar();
        this._syncWindowButtons();
        this._syncNotifications();
    }

    _redirectAppGrid(handler) {
        // Super+A and Main.overview.showApps() open the given handler
        // instead of the overview's app grid; null restores GNOME's.
        const controls = Main.overview._overview._controls;
        Main.wm.removeKeybinding('toggle-application-view');
        Main.wm.addKeybinding('toggle-application-view',
            new Gio.Settings({schema_id: SHELL_KEYBINDINGS_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            handler ?? controls._toggleAppsPage.bind(controls));
        if (handler)
            Main.overview.showApps = () => this._launchpad.open();
        else
            delete Main.overview.showApps;
    }

    disable() {
        Main.wm.removeKeybinding('stage-manager-toggle');
        Main.wm.removeKeybinding('force-quit-shortcut');
        this._settings.disconnectObject(this);

        this._hotCorners?.destroy();
        this._hotCorners = null;
        Main.wm.removeKeybinding('show-desktop-shortcut');
        Main.wm.removeKeybinding('hide-others-shortcut');
        Main.wm.removeKeybinding('toggle-fullscreen-shortcut');
        Meta.keybindings_set_custom_handler('minimize', null);
        this._missionControl?.destroy();
        this._missionControl = null;
        this._lockGuard?.destroy();
        this._lockGuard = null;
        this._tiling?.destroy();
        this._tiling = null;
        this._showDesktop?.destroy();
        this._showDesktop = null;
        this._appExpose?.destroy();
        this._appExpose = null;

        this._menuBar?.destroy();
        this._menuBar = null;
        this._restoreWindowButtons();
        Main.messageTray.bannerAlignment = this._bannerAlignment ?? Main.messageTray.bannerAlignment;
        this._bannerAlignment = null;

        this._spaces?.destroy();
        this._spaces = null;

        this._spotlight?.destroy();
        this._spotlight = null;

        this._stageManager?.destroy();
        this._stageManager = null;

        if (this._dock) {
            this._effects?.removeProvider(this._dock);
            this._dock.destroy();
            this._dock = null;
        }

        this._redirectAppGrid(null);
        this._launchpad.destroy();
        this._launchpad = null;

        this._indicator.destroy();
        this._indicator = null;

        this._effects?.destroy();
        this._effects = null;
        this._settings = null;
    }

    _syncStageManager() {
        const enabled = this._settings.get_boolean('stage-manager-enabled');
        if (enabled && !this._stageManager) {
            this._stageManager = new StageManager(this._settings, this._effects);
        } else if (!enabled && this._stageManager) {
            this._stageManager.destroy();
            this._stageManager = null;
        }
        this._dock?.syncMinimized();
    }

    _syncSpaces() {
        const enabled = this._settings.get_boolean('fullscreen-spaces');
        if (enabled && !this._spaces) {
            this._spaces = new FullscreenSpaces(this._settings);
        } else if (!enabled && this._spaces) {
            this._spaces.destroy();
            this._spaces = null;
        }
    }

    _syncMenuBar() {
        const enabled = this._settings.get_boolean('menubar-enabled');
        if (enabled && !this._menuBar) {
            this._menuBar = new MenuBar(this.path, this._settings);
        } else if (!enabled && this._menuBar) {
            this._menuBar.destroy();
            this._menuBar = null;
        }
    }

    _syncWindowButtons() {
        // Close, minimize and maximize on the left. The user's
        // own layout is put back when this is turned off or the extension
        // is disabled (a logout skips that, so it stays until then).
        const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        const left = this._settings.get_boolean('window-buttons-left');
        if (left) {
            if (this._buttonLayout === undefined || this._buttonLayout === null) {
                this._buttonLayout = wm.get_string('button-layout');
                this._buttonLayoutSettings = wm;
            }
            wm.set_string('button-layout', 'close,minimize,maximize:');
        } else {
            this._restoreWindowButtons();
        }
    }

    _restoreWindowButtons() {
        if (this._buttonLayout === undefined || this._buttonLayout === null)
            return;
        this._buttonLayoutSettings.set_string('button-layout', this._buttonLayout);
        this._buttonLayout = null;
    }

    _syncNotifications() {
        const tray = Main.messageTray;
        if (this._settings.get_boolean('notifications-right')) {
            this._bannerAlignment ??= tray.bannerAlignment;
            tray.bannerAlignment = Clutter.ActorAlign.END;
        } else if (this._bannerAlignment) {
            tray.bannerAlignment = this._bannerAlignment;
            this._bannerAlignment = null;
        }
    }

    _syncSpotlight() {
        const enabled = this._settings.get_boolean('spotlight-enabled');
        if (enabled && !this._spotlight) {
            this._spotlight = new Spotlight(this._settings, this._launchpad);
        } else if (!enabled && this._spotlight) {
            this._spotlight.destroy();
            this._spotlight = null;
        }
    }

    _syncDock() {
        const enabled = this._settings.get_boolean('dock-enabled');
        if (enabled && !this._dock) {
            // Windows Stage Manager tucked into its strip are minimized too,
            // but don't belong in the Dock.
            this._dock = new Dock(this._settings, this._effects, this._launchpad,
                w => this._stageManager?.ownsWindow(w) ?? false, this._appExpose);
            this._effects?.addProvider(this._dock);
        } else if (!enabled && this._dock) {
            this._effects?.removeProvider(this._dock);
            this._dock.destroy();
            this._dock = null;
        }
    }
}
