// Cross-browser wheel/pinch zoom for the timeline. vis-timeline's own handler
// branches on `event.wheelDelta` first (see `_onMouseWheel` in the bundle), and
// WebKit reports a far smaller `wheelDelta` for a Mac trackpad pinch than Blink
// does for the same gesture — so the exact same pinch crawled in Safari while it
// glided in Chrome and Vivaldi. Driving the zoom off `deltaY` (normalised for
// `deltaMode`) removes that split: one gesture, one rate, every browser.
//
// We take the gesture over completely rather than tuning vis's friction per
// browser, because vis binds *two* zoom paths (a modern `wheel` listener and a
// legacy `mousewheel`/`DOMMouseScroll` one) and a browser that fires both would
// otherwise zoom twice. Capturing on the container swallows both for a zoom
// gesture while leaving a plain scroll untouched.

import type { Timeline } from 'vis-timeline/standalone';

// The same interval bounds vis enforces through `zoomMin`/`zoomMax` in render.ts;
// kept here because this handler now owns the clamp.
const ZOOM_MIN_MS = 1000 * 60 * 60 * 6;
const ZOOM_MAX_MS = 1000 * 60 * 60 * 24 * 365 * 30;

// deltaMode line/page → pixels, so a mouse that reports lines and a trackpad that
// reports pixels drive the same zoom.
const LINE_PX = 16;
const PAGE_PX = 400;

// Wheel pixels per zoom "step". Lower feels faster. This is the pinch dial: a
// Mac trackpad pinch fires many wheel events with a small deltaY (a handful of
// pixels), so the step per event comes almost entirely from this divisor.
const STEP_PX = 12;

// Higher = gentler zoom per step.
const FRICTION = 8;

// Cap a single event's zoom to one notch. A mouse-wheel tick and a vigorous pinch
// carry a far larger deltaY than a gentle pinch (~100px vs ~6px), so without a
// cap the wheel jumps across the range while a gentle pinch crawls — the same
// product STEP_PX × FRICTION drives both, so tuning the constants alone moves
// them in lockstep. Capping breaks the coupling: discrete inputs saturate to a
// fixed step, a gentle pinch stays on the linear path below the cap. This is the
// dial for the mouse wheel, since STEP_PX only bites below the cap.
const MAX_DELTA = 0.6;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type VisInternals = {
  body: {
    util: { toTime(x: number): Date };
    dom: { center: HTMLElement };
    range: {
      setRange(
        start: number,
        end: number,
        options: { animation: boolean; byUser: boolean },
      ): void;
    };
  };
};

export function attachWheelZoom(timeline: Timeline, container: HTMLElement): void {
  const internals = timeline as unknown as VisInternals;

  const onWheel = (e: WheelEvent) => {
    // `zoomKey` is ctrlKey; a Mac trackpad pinch arrives as ctrl+wheel too.
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();

    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= LINE_PX;
    else if (e.deltaMode === 2) dy *= PAGE_PX;
    // Capped so a wheel tick zooms one notch rather than across the range; a
    // gentle pinch stays under the cap and scales with STEP_PX.
    const delta = clamp(-dy / STEP_PX, -MAX_DELTA, MAX_DELTA);
    if (!delta) return;

    // vis's own scale curve, so zooming in by a step and back out by one returns
    // to the same window.
    const scale = delta < 0 ? 1 - delta / FRICTION : 1 / (1 + delta / FRICTION);

    // The date under the pointer stays put, the way vis zooms (no hidden dates in
    // this app, so the window maths is the plain pointer-centred form).
    const rect = internals.body.dom.center.getBoundingClientRect();
    const center = internals.body.util.toTime(e.clientX - rect.left).valueOf();

    const win = timeline.getWindow();
    let newStart = center + (win.start.getTime() - center) * scale;
    let newEnd = center + (win.end.getTime() - center) * scale;

    // Clamp the interval to vis's bounds around the pointer, so hitting the limit
    // does not slide the window sideways.
    const width = newEnd - newStart;
    const clamped = width < ZOOM_MIN_MS ? ZOOM_MIN_MS : width > ZOOM_MAX_MS ? ZOOM_MAX_MS : null;
    if (clamped !== null) {
      const fraction = (center - newStart) / width;
      newStart = center - clamped * fraction;
      newEnd = newStart + clamped;
    }

    // byUser: true so the existing `rangechanged` handler stores the window and
    // syncs the URL — this stays the one code path for a user-driven window.
    internals.body.range.setRange(newStart, newEnd, { animation: false, byUser: true });
  };

  // Swallow vis's own legacy zoom listeners on the descendants for a zoom
  // gesture; the modern `wheel` above already did the work.
  const swallowLegacy = (e: Event) => {
    if ((e as WheelEvent).ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  container.addEventListener('mousewheel', swallowLegacy, { capture: true, passive: false });
  container.addEventListener('DOMMouseScroll', swallowLegacy, { capture: true, passive: false });
}
