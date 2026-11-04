// Routes window minimize/unminimize animations through this extension.
//
// GNOME Shell connects its own minimize/unminimize handlers on the
// ShellWM object at startup with bound closures, so they can't be
// monkey-patched. Instead we block those handlers while enabled and run
// our own, which offer the event to registered providers (Stage Manager,
// Dock) before falling back to the stock animation.
//
// Providers animate a Clutter.Clone (above the windows or among them), so
// the real window can complete its state change immediately.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Genie (magic lamp) as an inverse mapping in a fragment shader: for each
// output pixel we work out which window pixel lands there. Clutter's
// DeformEffect would be the natural tool, but it renders nothing on
// Mutter 18, so the deformation is done per-pixel instead.
//
// All coordinates are in pixels of the effect's actor, which is a box
// covering both the window and the icon. The window is assumed to funnel
// "down" towards the icon; when the icon is above, the maths is mirrored.
const GENIE_DECLARATIONS = `
uniform vec2 size;
uniform vec4 win;
uniform vec4 icon;
uniform float progress;

float sstep(float t) { return t * t * (3.0 - 2.0 * t); }
`;

const GENIE_CODE = `
vec2 pos = cogl_tex_coord_in[0].xy * size - win.xy;
float w = win.z;
float h = win.w;
vec4 t = vec4(icon.xy - win.xy, icon.zw);

bool below = t.y + t.w * 0.5 >= h * 0.5;
float y = below ? pos.y : h - pos.y;
float ty = below ? t.y : h - (t.y + t.w);

float squeeze = sstep(clamp(progress / 0.55, 0.0, 1.0));
float slide = sstep(clamp((progress - 0.2) / 0.8, 0.0, 1.0));

// Rows slide linearly from their place in the window into the icon.
float vv = (y - ty * slide) / (h + (t.w - h) * slide);

// The closer a row is to the icon, the more it narrows to the icon width.
float k = squeeze * sstep(clamp(y / max(ty, 1.0), 0.0, 1.0));
float left = t.x * k;
float right = w + (t.x + t.z - w) * k;
float u = (pos.x - left) / (right - left);

if (vv < 0.0 || vv > 1.0 || u < 0.0 || u > 1.0) {
    cogl_color_out = vec4(0.0);
} else {
    vec2 src = win.xy + vec2(u * w, (below ? vv : 1.0 - vv) * h);
    cogl_color_out = texture2D(cogl_sampler0, src / size) * cogl_color_in.a;
}
`;

export const GenieEffect = GObject.registerClass(
class GenieEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._progress = 0;
        this._locations = {};
        for (const name of ['size', 'win', 'icon', 'progress'])
            this._locations[name] = this.get_uniform_location(name);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            GENIE_DECLARATIONS, GENIE_CODE, true);
    }

    /**
     * @param {number[]} size - [width, height] of the effect's actor
     * @param {object} win - window rectangle in the actor's coordinates
     * @param {object} icon - icon rectangle in the actor's coordinates
     */
    setGeometry(size, win, icon) {
        this.set_uniform_float(this._locations.size, 2, size);
        this.set_uniform_float(this._locations.win, 4,
            [win.x, win.y, win.width, win.height]);
        this.set_uniform_float(this._locations.icon, 4,
            [icon.x, icon.y, icon.width, icon.height]);
    }

    set progress(p) {
        this._progress = p;
        this.set_uniform_float(this._locations.progress, 1, [p]);
        this.queue_repaint();
    }

    get progress() {
        return this._progress;
    }
});

/**
 * Puts `clone` inside a box covering both it and `icon` (stage coords) and
 * applies a GenieEffect to the box, so the deformed window is never drawn
 * outside its actor. WindowEffects destroys the box along with the clone.
 *
 * @param {Clutter.Clone} clone
 * @param {object} icon
 * @returns {GenieEffect}
 */
export function addGenie(clone, icon) {
    const x1 = Math.floor(Math.min(clone.x, icon.x));
    const y1 = Math.floor(Math.min(clone.y, icon.y));
    const x2 = Math.ceil(Math.max(clone.x + clone.width, icon.x + icon.width));
    const y2 = Math.ceil(Math.max(clone.y + clone.height, icon.y + icon.height));

    const box = new St.Widget({x: x1, y: y1, width: x2 - x1, height: y2 - y1});
    const parent = clone.get_parent();
    parent.insert_child_above(box, clone);
    parent.remove_child(clone);
    box.add_child(clone);
    clone.set_position(clone.x - x1, clone.y - y1);

    const effect = new GenieEffect();
    effect.setGeometry([box.width, box.height], {
        x: clone.x,
        y: clone.y,
        width: clone.width,
        height: clone.height,
    }, {
        x: icon.x - x1,
        y: icon.y - y1,
        width: icon.width,
        height: icon.height,
    });
    box.add_effect(effect);
    return effect;
}

export class WindowEffects {
    constructor() {
        this._providers = [];
        this._running = new Map();
        this._shellwm = Main.wm._shellwm;
        this._blockedIds = [];

        const ids = ['minimize', 'unminimize', 'map'].map(signalId =>
            GObject.signal_handler_find(this._shellwm, {signalId}));

        // If GNOME's handlers can't be found we must not install ours,
        // otherwise windows would be completed twice.
        this.available = ids.every(id => id > 0);
        if (!this.available) {
            console.warn('[gnome-fruit] could not find stock minimize handlers; custom window effects disabled');
            return;
        }

        for (const id of ids) {
            GObject.signal_handler_block(this._shellwm, id);
            this._blockedIds.push(id);
        }

        this._shellwm.connectObject(
            'minimize', (wm, actor) => this._onMinimize(actor),
            'unminimize', (wm, actor) => this._onUnminimize(actor),
            'map', (wm, actor) => this._onMap(actor),
            'kill-window-effects', (wm, actor) => this.finish(actor),
            this);

        this.layer = new Clutter.Actor({name: 'gnome-fruit-effects'});
        Main.layoutManager.uiGroup.insert_child_above(this.layer, global.window_group);
    }

    destroy() {
        for (const actor of [...this._running.keys()])
            this.finish(actor);

        this._shellwm.disconnectObject(this);
        for (const id of this._blockedIds)
            GObject.signal_handler_unblock(this._shellwm, id);
        this._blockedIds = [];

        this.layer?.destroy();
        this.layer = null;
        this._providers = [];
    }

    /**
     * Providers are objects with optional `minimize(actor, effects)` and
     * `unminimize(actor, effects)` and `map(actor, effects)` methods. A provider that wants to
     * handle the event calls `effects.runOnClone()` and returns true;
     * otherwise it returns false and the next provider is asked.
     *
     * @param {object} provider
     * @param {object} params
     * @param {boolean} params.first - ask this provider before the others
     */
    addProvider(provider, {first = false} = {}) {
        if (first)
            this._providers.unshift(provider);
        else
            this._providers.push(provider);
    }

    removeProvider(provider) {
        this._providers = this._providers.filter(p => p !== provider);
    }

    _shouldAnimate(actor) {
        // Honour skipNextEffect() and the overview / gesture checks.
        if (Main.wm._skippedActors.has(actor))
            return false;
        if (!Main.wm._shouldAnimate())
            return false;
        const type = actor.meta_window?.get_window_type();
        return [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ].includes(type);
    }

    _onMinimize(actor) {
        if (this._shouldAnimate(actor)) {
            for (const p of this._providers) {
                if (p.minimize?.(actor, this))
                    return;
            }
        }
        Main.wm._minimizeWindow(this._shellwm, actor);
    }

    _onUnminimize(actor) {
        if (this._shouldAnimate(actor)) {
            for (const p of this._providers) {
                if (p.unminimize?.(actor, this))
                    return;
            }
        }
        Main.wm._unminimizeWindow(this._shellwm, actor);
    }

    _onMap(actor) {
        // Only ordinary windows zoom open; dialogs and menus keep GNOME's.
        if (this._shouldAnimate(actor) &&
            actor.meta_window.get_window_type() === Meta.WindowType.NORMAL) {
            for (const p of this._providers) {
                if (p.map?.(actor, this))
                    return;
            }
        }
        Main.wm._mapWindow(this._shellwm, actor);
    }

    /**
     * Completes the window state change right away and plays `animate`
     * on a clone of the window instead. `animate(clone, done)` must call
     * `done()` when finished.
     *
     * By default the clone flies in a layer above every window. With
     * `inStack` it stays among the windows instead: an appearing window
     * keeps its place in the stacking order, and a disappearing one moves
     * beneath all the others.
     *
     * @param {Meta.WindowActor} actor
     * @param {boolean} minimizing
     * @param {Function} animate
     * @param {object} params
     * @param {boolean} params.inStack
     * @param {boolean} params.mapping - a window opening, not unminimizing
     */
    runOnClone(actor, minimizing, animate, {inStack = false, mapping = false} = {}) {
        this.finish(actor);

        const clone = new Clutter.Clone({
            source: actor,
            x: actor.x,
            y: actor.y,
            width: actor.width,
            height: actor.height,
        });
        const container = inStack ? global.window_group : this.layer;
        // Providers may wrap the clone; this finds the outermost wrapper.
        const root = () => {
            let a = clone;
            while (a.get_parent() && a.get_parent() !== container)
                a = a.get_parent();
            return a;
        };

        if (!inStack)
            container.add_child(clone);
        else if (minimizing)
            container.insert_child_below(clone, global.get_window_actors()[0] ?? null);
        else
            container.insert_child_above(clone, actor);

        if (minimizing) {
            this._shellwm.completed_minimize(actor);
        } else {
            // The real window becomes visible now; keep it transparent
            // until the clone has landed on top of it.
            actor.opacity = 0;
            if (mapping)
                this._shellwm.completed_map(actor);
            else
                this._shellwm.completed_unminimize(actor);
            if (inStack) {
                // Follow the window if it is raised while the clone flies.
                global.display.connectObject('restacked', () => {
                    if (actor.get_parent() === container)
                        container.set_child_above_sibling(root(), actor);
                }, clone);
            }
        }

        let finished = false;
        let actorDestroyed = false;
        const done = () => {
            if (finished)
                return;
            finished = true;
            this._running.delete(actor);
            global.display.disconnectObject(clone);
            root().destroy();
            if (!minimizing && !actorDestroyed)
                actor.opacity = 255;
        };
        this._running.set(actor, done);
        actor.connectObject('destroy', () => {
            actorDestroyed = true;
            done();
        }, clone);

        animate(clone, done);
    }

    finish(actor) {
        this._running.get(actor)?.();
    }

    /**
     * Drives `onFrame(progress)` for `duration` ms.
     *
     * @param {Clutter.Actor} actor
     * @param {number} duration
     * @param {Clutter.AnimationMode} mode
     * @param {Function} onFrame
     * @param {Function} onDone
     */
    static timeline(actor, duration, mode, onFrame, onDone) {
        const timeline = new Clutter.Timeline({actor, duration, progress_mode: mode});
        timeline.connect('new-frame', () => {
            onFrame(timeline.get_progress());
        });
        timeline.connect('stopped', () => onDone());
        timeline.start();
        return timeline;
    }
}
