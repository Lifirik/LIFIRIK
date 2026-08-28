// camera.js — world↔screen transform, pan/zoom, fitBounds (§10.3).

import { clamp } from './util.js';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

// ---------- how far a PLAYER may look (§10.7) ----------
//
// **This number is the game's one boundary, and it is exported because three
// things need to BE it rather than agree with it** (§10.7): how far a player's
// view reaches, how far an author may build (`WORLD_LIMIT` in game.js is this,
// imported), and where the Maker's red "you will never see this" tint starts.
// A player who could pan past what is buildable would find the edge of the
// world, and an author building past what is visible would be working for
// nobody.
//
// **4020 rather than a round 4000 so the boundary lands ON the positional grid**
// (§8.1): GRID_STEP is 30 and 4020 is 134 of them exactly, so a piece snapped to
// the last node before the fence sits flush against it rather than 20 px short.
// It is 268 GRID_FINE nodes too. (The scenery's 5025 is a whole number of fine
// nodes but not of coarse ones — that layer is composed by eye, not tiled.)
//
// Two limits below, because either alone leaks. A zoom floor alone still lets
// you PAN to the edge; a pan clamp alone stops working the moment the viewport
// is wider than the box, since then no camera position keeps it inside. So the
// floor is whichever is tighter — the taste one, or the one the viewport forces.
export const PLAY_BOUND = 4020;
export const PLAY_MIN_ZOOM = 0.4;

export class Camera {
  constructor() {
    this.x = 0;          // world point at the viewport centre
    this.y = 0;
    this.zoom = 1;
    this.vw = 800;       // viewport CSS px
    this.vh = 600;
  }

  setViewport(w, h) { this.vw = w; this.vh = h; }

  toScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.vw / 2,
      y: (wy - this.y) * this.zoom + this.vh / 2,
    };
  }

  toWorld(sx, sy) {
    return {
      x: (sx - this.vw / 2) / this.zoom + this.x,
      y: (sy - this.vh / 2) / this.zoom + this.y,
    };
  }

  panPx(dx, dy) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  // zoom keeping the cursor's world point fixed
  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  // Fit bounds {minX, minY, maxX, maxY}; pad in world px scaled by nothing
  // (pad ≈ 28 = legacy 60·k); bottomSafe reserves the play-dock in screen px
  // and anchors the level's bottom just above it.
  fitBounds(b, pad = 28, bottomSafe = 132) {
    const w = Math.max(b.maxX - b.minX + pad * 2, 60);
    const h = Math.max(b.maxY - b.minY + pad * 2, 60);
    const availH = Math.max(this.vh - bottomSafe, 120);
    this.zoom = clamp(Math.min(this.vw / w, availH / h), MIN_ZOOM, MAX_ZOOM);
    this.x = (b.minX + b.maxX) / 2;
    // anchor the bounds' bottom just above the dock
    const cy = (b.minY + b.maxY) / 2;
    const bottomScreen = (b.maxY + pad - cy) * this.zoom + this.vh / 2;
    const want = this.vh - bottomSafe;
    this.y = cy + Math.max(0, (bottomScreen - want)) / this.zoom;
    // if the whole thing floats high, centre it in the safe area instead
    const topScreen = this.toScreen(0, b.minY - pad).y;
    if (topScreen < 0) {
      this.y = cy;
    }
  }

  // Hold the visible rectangle inside ±half. Applied AFTER whatever moved the
  // camera — pan, wheel-zoom, fitBounds — rather than inside each of them, so
  // there is one place the rule lives and no way to reach the camera that
  // bypasses it.
  //
  // Zoom first, then position: the floor is what makes a position exist at all.
  // When the viewport is wider than the box the clamp below has nothing to pick
  // (min > max on that axis), and centring is the honest answer — it is the
  // only position that shows the box and nothing else. The Math.min/max order
  // does that on its own, so it needs no branch, but it is the reason the
  // arithmetic is written this way round.
  clampToBounds(half = PLAY_BOUND, minZoom = PLAY_MIN_ZOOM) {
    this.zoom = clamp(this.zoom, Math.max(minZoom, this.vw / (2 * half), this.vh / (2 * half)), MAX_ZOOM);
    const hw = this.vw / (2 * this.zoom), hh = this.vh / (2 * this.zoom);
    this.x = Math.min(Math.max(this.x, -half + hw), half - hw);
    this.y = Math.min(Math.max(this.y, -half + hh), half - hh);
  }

  // The visible world rectangle, padded — the draw loops' culling clip
  // (render.js). Lives here rather than inline in _draw for the usual reason:
  // a rule in a DOM-bound method is a rule no gate can reach, and "what can
  // the camera see" is a pure function of five numbers. The pad absorbs
  // everything a piece draws OUTSIDE its own geometry (glows, caps, pin dots)
  // — generous, because a wrongly culled piece pops at the screen edge and a
  // generously kept one merely costs its old draw time.
  viewRect(pad = 0) {
    const hw = this.vw / (2 * this.zoom), hh = this.vh / (2 * this.zoom);
    return {
      minX: this.x - hw - pad, maxX: this.x + hw + pad,
      minY: this.y - hh - pad, maxY: this.y + hh + pad,
    };
  }

  // set canvas transform for world-space drawing
  apply(ctx, dpr = 1) {
    ctx.setTransform(
      dpr * this.zoom, 0, 0, dpr * this.zoom,
      dpr * (this.vw / 2 - this.x * this.zoom),
      dpr * (this.vh / 2 - this.y * this.zoom),
    );
  }
}

// Bounds helpers used by game.js — kept here so both screens share them.

export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

export function rectBounds(r) {
  // generous: use half-diagonal so rotated rects fit
  const hd = Math.hypot(r.w, r.h) / 2;
  return { minX: r.x - hd, minY: r.y - hd, maxX: r.x + hd, maxY: r.y + hd };
}

// `r` rides along with the box so consumers that care can measure the CIRCLE
// rather than the square drawn round it — which sticks out past the circle by
// 41% of the radius at its corners, and against a tilted zone held a big wheel
// visibly further from the edge than a small one (util.js's footprintOf).
// Invisible to everything else here, which only ever reads min/max.
export function circleBounds(x, y, r) {
  return { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r, r };
}
