// Hiding apps, like Super+H and Alt+Super+H.

import Shell from 'gi://Shell';

function hide(app) {
    for (const window of app.get_windows()) {
        if (!window.minimized && window.can_minimize())
            window.minimize();
    }
}

export function hideApp(app) {
    if (app)
        hide(app);
}

export function hideOthers(app) {
    for (const other of Shell.AppSystem.get_default().get_running()) {
        if (other !== app)
            hide(other);
    }
}
