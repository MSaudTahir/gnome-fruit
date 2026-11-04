// Keeps the lock screen on top. The extension stays enabled while the
// session is locked (so Stage Manager keeps its state), but the Dock, the
// strip and the rest are chrome added after GNOME's screen shield, so they
// would be drawn over it. While locked, the shield, the top bar and the
// message tray are lifted above everything else.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Our top bar buttons would otherwise show on the lock screen's panel.
const PANEL_BUTTONS = ['fruit-system-menu', 'fruit-app-menu', 'fruit-spotlight'];

export class LockGuard {
    constructor() {
        this._lifted = false;
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        Main.sessionMode.disconnectObject(this);
        this._restore();
    }

    _sync() {
        if (Main.sessionMode.isLocked)
            this._lift();
        else
            this._restore();
    }

    _lift() {
        const lm = Main.layoutManager;
        this._lifted = true;
        this._setPanelButtons(false);
        for (const actor of [lm.screenShieldGroup, lm.panelBox, Main.messageTray])
            lm.uiGroup.set_child_below_sibling(actor, lm.modalDialogGroup);
    }

    // Back where GNOME puts them: shield, panel and tray right after the
    // overview, below any chrome.
    _restore() {
        if (!this._lifted)
            return;
        this._lifted = false;
        this._setPanelButtons(true);
        const lm = Main.layoutManager;
        let below = lm.overviewGroup;
        for (const actor of [lm.screenShieldGroup, lm.panelBox, Main.messageTray]) {
            lm.uiGroup.set_child_above_sibling(actor, below);
            below = actor;
        }
    }

    _setPanelButtons(shown) {
        for (const name of PANEL_BUTTONS) {
            const button = Main.panel.statusArea[name];
            if (!button)
                continue;
            button.opacity = shown ? 255 : 0;
            button.reactive = shown;
        }
    }
}
