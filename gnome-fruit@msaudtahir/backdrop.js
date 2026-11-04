// A frosted backdrop: a blurred live copy of the wallpaper and windows behind
// an actor, optionally with rounded corners.
//
// Shell.BlurEffect's BACKGROUND mode blurs whatever is already in the
// framebuffer. When only part of the actor is redrawn (an icon changing on
// hover), the rest of the framebuffer still holds the previous frame, which
// includes the actor itself, so the blur smears and flickers. Here a clone
// of the window group is blurred offscreen instead (ACTOR mode), which
// doesn't depend on what was painted before.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME's own surfaces are flat, so by default the backdrop is too: just
// an empty widget for the stylesheet to paint. Set this to get the frosted
// frosted look back (a blurred live copy of the screen behind it).
const FROSTED = false;

// Smaller than this, the effects are switched off.
const MIN_SIZE = 2;

const CORNER_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
`;

const CORNER_CODE = `
vec2 pos = cogl_tex_coord_in[0].xy * size;
vec2 corner = clamp(pos, vec2(radius), size - vec2(radius));
float alpha = clamp(radius - distance(pos, corner) + 0.5, 0.0, 1.0);
cogl_color_out *= alpha;
`;

const CornerEffect = GObject.registerClass(
class CornerEffect extends Shell.GLSLEffect {
    _init(radius) {
        super._init();
        this._radius = radius;
        this._size = this.get_uniform_location('size');
        this.set_uniform_float(this.get_uniform_location('radius'), 1, [radius]);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            CORNER_DECLARATIONS, CORNER_CODE, false);
    }

    setSize(width, height) {
        this.set_uniform_float(this._size, 2, [width, height]);
        this.queue_repaint();
    }
});

export const Backdrop = GObject.registerClass(
class Backdrop extends St.Widget {
    /**
     * @param {object} params
     * @param {number} params.radius - blur radius
     * @param {number} params.brightness
     * @param {number} [params.cornerRadius] - in pixels; 0 for square
     */
    _init({radius, brightness, cornerRadius = 0}) {
        super._init({clip_to_allocation: true});
        this._frosted = FROSTED;
        if (!this._frosted)
            return;

        // The wallpaper and the windows. The wallpaper also keeps the copy
        // from being empty (and so unpainted) while no window is open.
        this._content = new Clutter.Actor();
        this._content.add_child(new Clutter.Clone({
            source: Main.layoutManager._backgroundGroup,
        }));
        this._content.add_child(new Clutter.Clone({source: global.window_group}));
        this.add_child(this._content);

        // The corner mask has to see the blurred result, so it goes first
        // (outermost) and the blur second.
        this._corners = null;
        if (cornerRadius > 0) {
            this._corners = new CornerEffect(cornerRadius);
            this.add_effect(this._corners);
        }
        this._blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius,
            brightness,
        });
        this.add_effect(this._blur);

        // An offscreen effect on an actor with no area makes Cogl fail
        // ("width >= 1") half way through a frame, which can leave the
        // screen showing stale frames afterwards. Keep the effects off
        // until there is something to paint.
        this._setEffectsEnabled(false);

        this.connect('notify::allocation', () => {
            const box = this.allocation;
            const usable = box.get_width() >= MIN_SIZE && box.get_height() >= MIN_SIZE;
            this._setEffectsEnabled(usable);
            if (usable)
                this._corners?.setSize(box.get_width(), box.get_height());
            this.syncPosition();
        });
    }

    // The copy of the screen must not decide how big the backdrop is; its
    // parent does.
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    _setEffectsEnabled(enabled) {
        this._blur.set_enabled(enabled);
        this._corners?.set_enabled(enabled);
    }

    /**
     * Keeps the copy lined up with the screen. Call it when an ancestor
     * moves without reallocating (a translation).
     */
    syncPosition() {
        if (!this._frosted)
            return;
        // A translation, not a position: this runs during allocation, and
        // moving the clone mustn't queue another relayout.
        const [x, y] = this.get_transformed_position();
        this._content.set_translation(-Math.round(x), -Math.round(y), 0);
    }
});
