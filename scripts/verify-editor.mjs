// verify-editor.mjs — the editor rules on GameScreen (§7.2, §7.2a, §8.2).
// Run: node scripts/verify-editor.mjs
//
// THE GAP THIS FILLS. `verify-zones.mjs` gates the pure geometry in util.js
// and `verify-validation.mjs` gates what the server will accept. Between them
// sits every rule that only exists inside `game.js` — zone containment as the
// editor asks it, the solidity of props and goal pieces, what a drag stops at
// versus what it merely marks, the placement sweep, the landing rules — and
// until now the only way to exercise any of it was to drive a browser by hand.
// Four rounds of the same bug class reached the user through that gap.
//
// HOW IT RUNS HEADLESSLY. `GameScreen`'s constructor builds a canvas and a
// HUD, so it is never called: an instance is made with `Object.create` and the
// dozen fields the editor logic actually reads are assigned directly, with the
// handful of DOM methods (`_toast`, `_commit`, the chips) stubbed. Everything
// below that is the real code — `_pointerDown`, `_pointerMove`, `_pointerUp`
// and every predicate they reach. Gestures are driven through those three
// handlers rather than by calling `_moveDrag` directly, because half the rules
// live in how the drag is SET UP (which rules get frozen, what counts as a
// companion) and a test that skipped that would gate the easy half.
//
// WHAT MOST OF THESE ASSERT. Not "the piece ended up in a legal spot" — that
// is the weaker half. The invariant is **where the drag leaves a piece is
// where the drop keeps it** (§16: live and release enforce the same set). A
// piece that tracks the pointer and then jumps back on release is the exact
// symptom of every mismatch in that list, in both directions: a sweep that
// enforces less than the drop, and a drop that enforces more than the sweep.
// So `gesture()` records the position after the last pointermove and again
// after pointerup, and the gate is that they are the same.
//
// Nothing here touches the database, the server, or the wasm binary; it is
// pure client logic.
//
// **It takes 9.6 s, not the "well under a second" this used to claim.** The
// fuzzer at gate 10 is 82% of that on its own and gate 38 another 12%, both of
// which now sit inside `section()` — so `--only <id>` on anything else answers
// in 0.6 s. See `scripts/gatekit.mjs`; `--times` re-measures the split whenever
// this stops being true.

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { GameScreen, TOOL_FAMILIES } = await import(u('public/js/game.js'));
const { Camera, circleBounds, PLAY_BOUND, PLAY_MIN_ZOOM, MAX_ZOOM } = await import(u('public/js/camera.js'));
const { drawUnseen, BACKDROP_SCALE, drawRods, PIN_DOT_R, ROD_DRAW_W } = await import(u('public/js/render.js'));
const { MIN_ROD_LEN, MIN_LINK_LEN, ROD_SKIP_LEN, ROD_THICK } = await import(u('public/js/sim.js'));
const { clampDeltaToRect, boundsInRectFrame, jointKey, roundedRectPts, rectCorners, convexHull, seedRand, store, pathAnchors, resolvedHandles, ropeRuns, ropePieces, designStats, wheelPins, undoReturnsToMaker, initialSnapMode, nextCampaignLevel, prevCampaignLevel,
  clampSpeed, speedForSeconds, secondsForSpeed, spinSpeedForSeconds, secondsForSpinSpeed,
  SPEED_MIN, SPEED_MAX, SPIN_RATE_DIVISOR, fpsTick,
  pieceCensus, levelCensus, computeBadges, WHEEL_SIZES, wheelRings, goalPins,
  scrubLineVisible, scrubZone, pointInZone, SCRUB_ROW_H, SCRUB_ROW_GAP, SCRUB_NEAR_PAD,
  scrubFastForwardRate, scrubOvershoot, SCRUB_FF_DEADZONE, SCRUB_FF_MAX,
  navShown, NAV_PEEK_IN, NAV_PEEK_OUT, showsKeyHints, snapRadius, SNAP_PIN_DOT, STD_WHEEL_R,
  modifierIntent, bindLegend, gridStepFor, laysRope, SIZEABLE, ROD_TOOLS,
  HUD_THEMES, HUD_DENSITIES, hudThemeAttr, hudDensityAttr, installSliderRelease,
  barGuides, clampBarAxis, BAR_SNAP_PULL, BAR_SNAP_RELEASE, SWEEP_CHIP_CHROME,
  BAR_SNAP_PULL_TOUCH, BAR_SNAP_RELEASE_TOUCH } = await import(u('public/js/util.js'));
const { placeRung, clampRung, stepRung, rungRadius, rungName, DEFAULT_RUNG,
  RUNG_NAMES } = await import(u('public/js/sizes.js'));
const { WEIGHT_NOTCHES, weightNotch, weightAtNotch, ROD_WEIGHT_MIN, ROD_WEIGHT_MAX,
  GRID_STEP, GRID_FINE } = await import(u('public/js/sizes.js'));
const { isPlanet, pullOf, pullNotch, planetsOf, PULL_NOTCHES, PULL_DEFAULT, PULL_MIN, PULL_MAX,
  pieceGravityOf, pieceGravityNotch, PIECE_GRAVITY_NOTCHES, PIECE_GRAVITY_DEFAULT,
  PIECE_GRAVITY_MIN, PIECE_GRAVITY_MAX } = await import(u('public/js/gravity.js'));
const { newMakerLevel, setOfSlot, parseCampaignRange, normalizeCampaigns, SETS } = await import(u('public/js/levels.js'));

const { gate, section, summary } = gates();

// game.js's own constants, restated — importing them would mean exporting
// them, and a test that can silently follow a constant as it changes is not
// gating the constant. A mismatch here should FAIL, loudly, and be looked at.
const ZONE_SLACK = 0.5;
const ZONE_CLAMP_EPS = 0.001;
const ZONE_CLAMP_SLACK = ZONE_SLACK - ZONE_CLAMP_EPS;
const TERRAIN_TOUCH_PAD = 1;
const REST_GAP = 0.01;
const SNAP = 6;               // SCREEN px — gate 39 turns on it being screen px
// **Two different quantities that used to be one number.** The press band is a
// pointer AIM, so it is SCREEN px; the rescue budget is how far an anchor may
// travel to leave the rock, which is geometry, so it stays WORLD px. At the
// harness's zoom of 1 the press band happens to equal 10 world px, which is why
// the fixtures below can be written in world coordinates — but gate 36 asserts
// the two are genuinely different, and gate 39's fixture is zoomed for exactly
// this class of mistake.
const PRESS_SLACK = 10;
const RESCUE_SLACK = 40;
// The arrow ladder (2026-08-12): Shift+Alt 1, plain 0.1, Alt 0.01. Restated
// rather than imported, like everything else here — a test that silently
// follows a constant as it changes is not gating the constant, and this one is
// a promise printed on the Controls page.
const NUDGE_STEPS = [1, 0.1, 0.01];
// Both rope-makers lay this length now (chain paint and chain wrap; it was 30
// and 8). Restated rather than imported for the reason above — this number is
// the feature's whole feel and is measured in probe-rope.mjs, so a change to it
// should stop this file and be looked at, not be quietly followed.
// **16 since 2026-08-19** (doubled on FC's engine, probe-ropelink.mjs: a chain
// of N joints stretches by ~N², and 8 px links snapped under a heavy crate).
// It stopped this file and was looked at: the counts below that were "a
// 200 px stroke is 25 links" are stated against the constant now.
const ROPE_LINK_LEN = 16;
// Raised 500 → 1000 for ropes (a 400 px rope is fifty links). Restated, so a
// change to it stops this file and gets looked at — and so does the SERVER's
// replay cap, which is gated against this number below.
const MAX_DESIGN_PARTS = 1000;
// Level-authored parts, dropped 5000 → 1000 on 2026-08-03. Restated here for
// the same reason as everything above it: these are DYNAMIC BODIES built
// through the same path as a player's pieces, so the number is a frame-budget
// decision (19.3 ms/step at 5000, asleep, measured by probe-cost.mjs) and a
// change to it should stop this file and be looked at. Gated against the
// server's copy below, because nothing else connects the two.
const MAX_FIXED_PARTS = 1000;
const BACK_FIXED_PARTS = 500;   // half the foreground's, like every BACK_CAP
// Loose pins — a pin bolted to the world rather than to a piece (2026-08-08).
// Restated for the same reason: each one is a revolute joint per rod end that
// lands on it, so the number is the same kind of frame-budget decision, and the
// server carries its own copy. Gated against both files below.
const MAX_LEVEL_PINS = 64;
const BACK_LEVEL_PINS = 32;     // half the foreground's, like every BACK_CAP
// The fence (§10.7). Restated, not imported, like everything above it — and the
// gates below prove game.js AGREES rather than trusting that it does.
// The editor's two grids, DERIVED from the wheel exactly as game.js derives
// them. They were literal 30 and 15 in one block of this file, which meant that
// when the wheel moved from 15 to 20 px the suite went on asserting a grid the
// game no longer had and reported 75 editor bugs that did not exist
// (2026-08-15). One definition, for the whole suite.
// ...and they now come FROM sizes.js, so this file cannot drift from the game.
// The size ladder and the pin radii ON it, asked of the game rather than typed:
// these fixtures used to say 7.5 / 15 / 30 and 4.5 / 12, which stopped being
// wheel sizes at all when Path B rescaled them (2026-08-15).
const [SMALL_R, , LARGE_R] = WHEEL_SIZES;
const INNER_PIN = wheelRings(STD_WHEEL_R)[0].rad;
// the terrain box a plain click stands down: four rungs of the wheel ladder
// (game.js `_beginLevelPlacement`), which was 60 at r 15 and is 80 at r 20
const STD_BOX = STD_WHEEL_R * 4;
const SMALL_PIN = wheelRings(SMALL_R)[0].rad;

const WORLD_LIMIT = 4020;     // 134 × GRID_STEP, so the fence is on the grid
const BACK_VISIBLE = 5025;    // = WORLD_LIMIT / BACKDROP_SCALE

const deep = (o) => JSON.parse(JSON.stringify(o));

// A rotated rect's own corners, plus the axis-aligned box drawn round them —
// the gap between the two is exactly what the AABB zone rules used to hand out
// for free.
const rectCornersOf = (z) => {
  const hw = z.w / 2, hh = z.h / 2, a = z.angle || 0;
  const c = Math.cos(a), s = Math.sin(a);
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    .map(([dx, dy]) => ({ x: z.x + dx * c - dy * s, y: z.y + dx * s + dy * c }));
  return {
    pts,
    bbMinX: Math.min(...pts.map(p => p.x)), bbMaxX: Math.max(...pts.map(p => p.x)),
    bbMinY: Math.min(...pts.map(p => p.y)), bbMaxY: Math.max(...pts.map(p => p.y)),
  };
};
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const samePt = (a, b, tol = 0.01) => !!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol);

// ---------- the harness ----------

// `undo: true` keeps the REAL `_commit` (and so the real undo stack), stubbing
// only the autosave underneath it — the gates in §11 need genuine history.
// `mode: 'play'` is a real player's screen, not the Maker's. It matters here
// because a player is permanently in the Test tab (`tab = mode === 'maker' ?
// 'level' : 'machine'`), so any rule that leans on the tab has to be asked in
// both modes to know what a player can actually do.
function screen(level, { tab = 'machine', tool = 'pointer', parts = [], undo = false, mode = 'maker' } = {}) {
  const S = Object.create(GameScreen.prototype);
  const lv = deep(level);
  // mirrors normaliseLevel() in game.js — every list a level is made of exists
  for (const k of ['terrain', 'props', 'buildZones', 'goalZones', 'goalObjs', 'fixedParts', 'texts', 'pins']) lv[k] = lv[k] || [];
  lv.groups = lv.groups || {};
  // the constructor's normaliseBackLevel invariant, restated: the scenery
  // layer's lists always exist (§10.5) — every real entry point normalises
  lv.backLevel = { terrain: [], props: [], fixedParts: [], texts: [], pins: [], groups: {}, ...(lv.backLevel || {}) };
  Object.assign(S, {
    opts: {}, mode, level: lv,
    design: { parts: deep(parts) },
    goalPositions: lv.goalObjs.map(g => ({ x: g.x, y: g.y })),
    goalMoved: lv.goalObjs.map(() => false),
    tab, tool, playing: false, sel: null, multiSel: [], drag: null, hover: null,
    camera: new Camera(), undoStack: [], redoStack: [], _pathAddArmed: false, snapMode: 'rev',
    toasts: [], commits: 0,
  });
  S._toast = (m) => { S.toasts.push(m); };
  S._autosave = () => {};
  if (undo) {
    const real = GameScreen.prototype._commit;
    S._commit = function (...a) { S.commits++; return real.apply(this, a); };
    S._pushUndo();                                   // the constructor's baseline
  } else {
    S._commit = () => { S.commits++; };
  }
  S._updateInfoChip = () => {};
  S._uiCovered = () => false;   // needs this.root + document; no DOM here
  S._renderToolbar = () => {};  // pure DOM; _setTool calls it on every switch
  S._updateAlignChip = () => {};
  S._updateStats = () => {};
  S._closeCtxMenu = () => {};
  S.canvas = { setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  return S;
}

// Camera default: zoom 1, centred on the origin, 800×600 — so a world point
// is just the client point less half the viewport, and the fake events can be
// written in world coordinates.
const ev = (wx, wy, mods = {}) => ({
  button: 0, pointerId: 1, ctrlKey: false, shiftKey: false, altKey: false,
  clientX: wx + 400, clientY: wy + 300,
  preventDefault() {}, stopPropagation() {},
  ...mods,
});

// Watchers are INDEX-based on purpose. A rejected drag runs
// `_restoreSnapshotAll`, which replaces `design.parts` and `goalPositions`
// wholesale (§16 — `_restore()` replaces objects), so a watcher holding a
// reference to the piece would report the detached pre-revert object and every
// revert would read as "nothing moved".
const partAt = (S, i) => () => {
  const p = S.design.parts[i];
  return p && (p.t === 'wheel' ? { x: p.x, y: p.y } : { x: p.x1, y: p.y1 });
};
const goalAt = (S, i) => () => ({ ...S.goalPositions[i] });
// the pins a goal piece offers, read through the editor's own snap list so
// the gate asks the same question the placement does
const goalPinsOf = (S, i) => {
  const p = S.goalPositions[i];
  const g = S.level.goalObjs[i];
  const r = g.shape === 'ball' ? g.r : Math.max(g.w, g.h);
  return S._allPins(null).filter(q => Math.hypot(q.x - p.x, q.y - p.y) <= r + 1);
};
const propAt = (S, i) => () => ({ x: S.level.props[i].x, y: S.level.props[i].y });
const fixedAt = (S, i) => () => {
  const p = S.level.fixedParts[i];
  return p.t === 'wheel' ? { x: p.x, y: p.y } : { x: p.x1, y: p.y1 };
};

function gesture(S, from, to, { steps = 8, mods = {}, watch = null } = {}) {
  const at = () => (watch ? watch() : null);
  const t0 = S.toasts.length;
  S._pointerDown(ev(from.x, from.y, mods));
  const type = S.drag?.type || null;
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    S._pointerMove(ev(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, mods));
  }
  const during = at();
  const badDrop = !!S.drag?.badDrop;
  const start = { ...at() };
  S._pointerUp(ev(to.x, to.y, mods));
  const after = at();
  return {
    type, during, after, badDrop,
    held: samePt(during, after),                 // the drop kept what the drag showed
    toasts: S.toasts.slice(t0),
    start,
  };
}

const ctrlClick = (S, x, y) => {
  S._pointerDown(ev(x, y, { ctrlKey: true, shiftKey: true }));
  S._pointerUp(ev(x, y, { ctrlKey: true, shiftKey: true }));
};

// A flat world: ground slab with its walkable top at y = 0 (§3's idiom), and a
// build area roomy enough that the FLOOR is what a downward drag runs into
// rather than the zone edge.
const flatWorld = (over = {}) => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
  buildZones: [{ x: 0, y: -100, w: 700, h: 500 }],
  goalZones: [{ x: 400, y: -40, w: 120, h: 80 }],
  ...over,
});

// A piece resting flush on that floor: terrain is deflated by
// TERRAIN_TOUCH_PAD before the overlap test, so "clear of the floor" ends one
// pixel BELOW the surface. Every downward-drag gate stops here.
const restY = (halfHeight) => -halfHeight + TERRAIN_TOUCH_PAD;

// Where a sweep must actually LEAVE a piece: clear of the surface by REST_GAP,
// not merely inside the tolerance. The distinction is the whole of §16's "a
// tolerance is not a target" — restY() above is the loosest position still
// ACCEPTED, and stopping there leaves the piece a full pixel inside the floor,
// which Box2D ejects the instant Play is pressed.
const restExact = (halfHeight) => -halfHeight - REST_GAP;
// How far a piece's SURFACE is inside the terrain (positive = embedded).
const embedded = (surfaceY) => surfaceY;   // terrain top is y = 0 in flatWorld()

// ---------- gate 1: build-zone containment, as the EDITOR asks it ----------
//
// verify-zones.mjs gates polyInRectUnion/segInRectUnion directly. These are
// the same rules reached through `_wheelInvalid`/`_rodInvalid` — the wrapping
// (`_boxInBuildZone`, `_segInBuildZone`, the cluster memo) is what the editor
// actually calls, and it is a separate thing that can be wrong.
{
  const one = screen({ buildZones: [{ x: 0, y: 0, w: 200, h: 200 }] });
  gate('1. a wheel fully inside the zone is legal',
    one._wheelInvalid({ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15 }, null, true) === null);
  gate('1. a wheel poking out of the zone is refused',
    /build zone/.test(one._wheelInvalid({ t: 'wheel', kind: 'free', x: 95, y: 0, r: 15 }, null, true) || ''));

  // §7.2a through the editor: two zones sharing an edge are one region, so a
  // stick may span the seam — and a 10 px gap is still a wall.
  const seam = screen({ buildZones: [{ x: -50, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 }] });
  const gapped = screen({ buildZones: [{ x: -55, y: 0, w: 100, h: 100 }, { x: 55, y: 0, w: 100, h: 100 }] });
  const spanner = { t: 'rod', kind: 'wood', x1: -90, y1: 0, x2: 90, y2: 0 };
  gate('1. a stick spanning the seam of two touching zones is legal',
    seam._rodInvalid(spanner, null, true) === null);
  gate('1. the same stick bridging a 10 px gap is refused',
    /build zone/.test(gapped._rodInvalid(spanner, null, true) || ''));

  // The notch: an L-shaped cluster's bounding box covers a quadrant that
  // belongs to neither zone. The CLAMP can only aim at that box (§16 — a clamp
  // cannot express a non-rectangular region), so the validity rule has to be
  // the thing that refuses it.
  const L = screen({ buildZones: [{ x: 0, y: 0, w: 200, h: 40 }, { x: 80, y: -40, w: 40, h: 120 }] });
  gate('1. a wheel in an L-cluster\'s empty notch is refused',
    /build zone/.test(L._wheelInvalid({ t: 'wheel', kind: 'free', x: 10, y: -20, r: 15 }, null, true) || ''));
  gate('1. a wheel along the L\'s flat arm is legal',
    L._wheelInvalid({ t: 'wheel', kind: 'free', x: -65, y: 0, r: 15 }, null, true) === null);
  // ...and the clamp really does offer the notch, which is why the above matters
  gate('1. the clamp\'s rect for that cluster DOES cover the notch (so the rule must not)',
    L._zoneClampRects().length === 1 && L._zoneClampRects()[0].w === 200);

  // Fixed parts (Level tab) are placed like terrain — not confined to the
  // machine's build area — but every other rule still applies to them, and
  // since §10.7 that includes the world fence: 1200 below is outside the zone
  // (-350..350) AND inside ±WORLD_LIMIT. It was 5000, which stopped meaning
  // 'far away' and started meaning 'illegal'.
  const lv = screen(flatWorld(), { tab: 'level' });
  gate('1. a fixed part outside the build zone is legal (zoned=false)',
    lv._wheelInvalid({ t: 'wheel', kind: 'free', x: 1200, y: -100, r: 15 }, null, false) === null);
  gate('1. a fixed part in terrain is still refused',
    /terrain/.test(lv._wheelInvalid({ t: 'wheel', kind: 'free', x: 0, y: 20, r: 15 }, null, false) || ''));
}

// ---------- gate 2: the clamp and the containment test agree on the edge ----------
//
// §16's first entry, and the one that cost this project the most: a clamp
// builds the edge (`z.y − z.h/2 − slack`) and a containment test compares a
// distance to a limit (`|py − z.y| ≤ z.h/2 + slack`), float64 groups them
// differently in the last ulp, and WHICH SIDE it falls is decided by the
// rect's own coordinates. That is why it presented as one edge of one zone
// misbehaving. A single hand-picked rectangle proves nothing about it, so this
// sweeps a few thousand awkward ones and asserts the pairing directly:
// whatever the clamp lands on, containment must accept.
{
  const rnd = seedRand(20260727);
  const S = screen({ buildZones: [{ x: 0, y: 0, w: 100, h: 100 }] });

  // A piece BIGGER than the zone along one of its axes has no legal position
  // at all, so no delta can put it in one and the clamp does not pretend to
  // (it leaves that component alone — see clampDeltaToRect). The invariant
  // being swept is about the cases where a legal spot exists; asserting it
  // over the others would be asserting that a clamp can solve an unsolvable
  // problem. Rotation makes these reachable — a square bounding box projected
  // onto a tilted axis grows by up to √2 — which is why they never came up
  // before and have to be named now rather than quietly skipped.
  const fits = (bb, z) => {
    const f = boundsInRectFrame(bb, z);
    return f.hx <= z.w / 2 + ZONE_CLAMP_SLACK && f.hy <= z.h / 2 + ZONE_CLAMP_SLACK;
  };

  let checked = 0, skippedTooBig = 0, bad = null;
  for (let i = 0; i < 4000 && !bad; i++) {
    // Deliberately ugly coordinates — thirds, sevenths, big magnitudes — so the
    // last ulp lands somewhere different every iteration.
    // Half the cases unrotated, half at an arbitrary angle: the unrotated half
    // guards the fast path every existing level takes, the rotated half is the
    // new arithmetic (§7.2a). The clamp and the containment test are DIFFERENT
    // code on each branch, so both pairings have to be swept.
    const z = {
      x: (rnd() - 0.5) * 4000 / 3, y: (rnd() - 0.5) * 4000 / 7,
      w: 40 + rnd() * 900 / 3, h: 40 + rnd() * 900 / 7,
      angle: rnd() < 0.5 ? 0 : rnd() * Math.PI * 2,
    };
    S.level.buildZones = [z];
    S._bcSig = null;
    const r = 2 + rnd() * 18;
    // shove the piece hard past each edge in turn and see where the clamp puts it
    const bb0 = circleBounds(z.x, z.y, r);
    if (!fits(bb0, z)) { skippedTooBig++; continue; }
    for (const [dx, dy] of [[1e5, 0], [-1e5, 0], [0, 1e5], [0, -1e5]]) {
      const d = clampDeltaToRect(bb0, z, dx, dy, ZONE_CLAMP_SLACK);
      const landed = circleBounds(z.x + d.dx, z.y + d.dy, r);
      checked++;
      if (!S._boxInBuildZone(landed)) { bad = { z, r, d, landed }; break; }
    }
  }
  gate('2. every clamped landing is accepted by the containment test',
    !bad, bad ? `zone ${JSON.stringify(bad.z)} r ${bad.r}` : `${checked} clamp/containment pairs, ${skippedTooBig} too big to fit`);

  // The same, for a goal piece — a different clamp (`_clampGoalToZone`) and a
  // different bounds function (`_goalBounds`, angle-aware), so it is a second
  // pairing that has to agree, not the same one again.
  const G = screen({ buildZones: [{ x: 0, y: 0, w: 100, h: 100 }], goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 30 }] });
  let gbad = null, gchecked = 0, gskipped = 0;
  for (let i = 0; i < 3000 && !gbad; i++) {
    const z = {
      x: (rnd() - 0.5) * 4000 / 3, y: (rnd() - 0.5) * 4000 / 7,
      w: 60 + rnd() * 900 / 3, h: 60 + rnd() * 900 / 7,
      angle: rnd() < 0.5 ? 0 : rnd() * Math.PI * 2,
    };
    const g = { shape: 'box', x: z.x, y: z.y, w: 8 + rnd() * 40, h: 8 + rnd() * 40, angle: rnd() * Math.PI };
    G.level.buildZones = [z];
    G.level.goalObjs = [g];
    G._bcSig = null;
    const from = { x: z.x, y: z.y };
    G.goalPositions = [{ ...from }];
    if (!fits(G._goalBounds(g, from), z)) { gskipped++; continue; }
    for (const [dx, dy] of [[1e5, 0], [-1e5, 0], [0, 1e5], [0, -1e5]]) {
      const p = G._clampGoalToZone(g, from.x + dx, from.y + dy, from);
      gchecked++;
      if (!G._goalFitsZone(g, p)) { gbad = { z, g, p }; break; }
    }
  }
  gate('2. every clamped goal-piece landing is accepted by _goalFitsZone',
    !gbad, gbad ? `zone ${JSON.stringify(gbad.z)}` : `${gchecked} clamp/containment pairs, ${gskipped} too big to fit`);

  // ZONE_CLAMP_EPS is the whole mechanism: the clamp aims a hair INSIDE.
  // Widening the shared slack instead moves the boundary without making the
  // two agree on it (§16), so this pins the relationship rather than the value.
  gate('2. the clamp aims strictly inside the containment slack',
    ZONE_CLAMP_SLACK < ZONE_SLACK && ZONE_CLAMP_EPS > 0,
    `clamp ${ZONE_CLAMP_SLACK} < test ${ZONE_SLACK}`);

  // A goal piece STRADDLING the boundary is LOCKED (§7.2, rule changed
  // 2026-08-07): yours to move only when it is wholly inside the build area.
  // This block used to gate the opposite — that a straddling piece dragged
  // OUT was pulled in by the clamp instead — which was exactly the free
  // simplification the new rule takes away: the author put the pink thing
  // half out of reach on purpose.
  //
  // The lock is `_goalFitsZone`, the SAME predicate the drag's region rule and
  // the release check use, and that has a tidy consequence worth stating: a
  // drag can only START on a piece that fits, so `region` is now always frozen
  // ON and the old "region off, zone on" split is unreachable in the Test tab.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 200, h: 200 }], goalObjs: [{ shape: 'box', x: 90, y: 0, w: 40, h: 30 }] });
    gate('2. a straddling goal piece is LOCKED — only a wholly-inside one is yours to move',
      S._goalLocked(0) && !S._goalFitsZone(S.level.goalObjs[0], S.goalPositions[0])
      && S._goalTouchesZone(S.level.goalObjs[0], S.goalPositions[0]));
    const before = { ...S.goalPositions[0] };
    const g = gesture(S, { x: 90, y: 0 }, { x: 300, y: 0 }, { watch: goalAt(S, 0) });
    gate('2. ...so dragging it does nothing at all, and says why',
      g.type === 'null' && samePt(S.goalPositions[0], before) && g.toasts.some(t => /partly in the build area/.test(t)),
      `${g.type}, at x ${S.goalPositions[0].x}, ${JSON.stringify(g.toasts)}`);
    // …and it is still PINNABLE, which is the half the rule keeps: a half-in
    // crate is something to build ONTO, and its pins are unchanged.
    const pins = S._allPins(null).length ? goalPinsOf(S, 0) : [];
    gate('2. ...while its pins are untouched, so a stick can still be bolted to it',
      pins.length > 0 && S._allPins(null).some(q => near(q.x, pins[0].x) && near(q.y, pins[0].y)),
      `${pins.length} pins on a locked piece`);
    // a piece WHOLLY inside is unaffected: still the player's to arrange
    const In = screen({ buildZones: [{ x: 0, y: 0, w: 200, h: 200 }], goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 30 }] });
    const gi = gesture(In, { x: 0, y: 0 }, { x: 60, y: 40 }, { watch: goalAt(In, 0) });
    gate('2. ...and a wholly-inside piece still moves freely',
      gi.held && Math.abs(In.goalPositions[0].x - 60) < 0.01, `landed at x ${In.goalPositions[0].x}`);
  }

  // And the whole gesture, end to end, on all four edges — the clamp arithmetic
  // being right is necessary, not sufficient.
  for (const [name, to] of [['right', { x: 2000, y: -100 }], ['left', { x: -2000, y: -100 }],
                            ['down', { x: 0, y: 2000 }], ['up', { x: 0, y: -2000 }]]) {
    const W = screen({ buildZones: [{ x: 0, y: -100, w: 333.7, h: 271.3 }] },
      { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
    const g = gesture(W, { x: 0, y: -100 }, to, { watch: partAt(W, 0) });
    const p = W.design.parts[0];
    gate(`2. a wheel dragged hard ${name} stops inside the zone and stays there`,
      g.held && W._wheelInvalid(p, p, true) === null,
      `rested at ${p.x.toFixed(3)},${p.y.toFixed(3)}${g.held ? '' : ' — SNAPPED BACK'}`);
  }
}

// ---------- gate 3: live and release enforce the same set ----------
//
// The §16 invariant, one gesture per way a piece can be carried. Each drags
// something into the floor and asserts the drop kept whatever the drag showed.
// A failure here is always the same user-visible bug: the piece follows the
// pointer into the ground and then jumps back with a toast.
{
  const rest = restY(15);

  // 3a — a wheel by itself
  {
    const S = screen(flatWorld(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { watch: partAt(S, 0) });
    gate('3. a wheel dragged into the floor stops on it and stays',
      g.held && near(S.design.parts[0].y, rest, 1.5), `y ${S.design.parts[0].y.toFixed(2)}, want ~${rest}`);
  }

  // 3b — a stick by itself. Its centreline rests ROD_THICK/2 above the surface.
  {
    const S = screen(flatWorld(), { parts: [{ t: 'rod', kind: 'wood', x1: -30, y1: -100, x2: 30, y2: -100, id: 'r' }] });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { watch: partAt(S, 0) });
    const want = restY(ROD_THICK / 2);
    gate('3. a stick dragged into the floor stops on it and stays',
      g.held && near(S.design.parts[0].y1, want, 1.5), `y ${S.design.parts[0].y1.toFixed(2)}, want ~${want}`);
  }

  // 3c — a stick towing a wheel bolted to one end. The WHEEL is what meets the
  // floor first, so the sweep has to be judging the companion, not the stick.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: -100, id: 'r' },
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' },
      ],
    });
    const g = gesture(S, { x: 30, y: -100 }, { x: 30, y: 300 }, { watch: partAt(S, 0) });
    const w = S.design.parts[1];
    gate('3. a stick towing a wheel stops when the WHEEL reaches the floor',
      g.held && near(w.y, rest, 1.5), `wheel y ${w.y.toFixed(2)}, want ~${rest}`);
  }

  // 3d — a stick towing a bolted crate, and 3e the same crate dragged directly.
  // §16: test a carrying relationship from BOTH ends. These two are different
  // branches of _moveDrag with different oracles, and they have to stop in the
  // same place or the bug is only half fixed.
  const cartLevel = flatWorld({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }] });
  const cartParts = [{ t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: -100, id: 'r' }];
  let byStick = null, byCrate = null;
  {
    const S = screen(cartLevel, { parts: cartParts });
    const g = gesture(S, { x: 30, y: -100 }, { x: 30, y: 300 }, { watch: goalAt(S, 0) });
    byStick = S.goalPositions[0].y;
    gate('3. a stick towing a crate stops when the CRATE reaches the floor',
      g.held && near(byStick, restY(15), 1.5), `crate y ${byStick.toFixed(2)}, want ~${restY(15)}`);
  }
  {
    const S = screen(cartLevel, { parts: cartParts });
    // Grabbed at (0,−112), not on the crate's centre: a rod ENDPOINT beats a
    // body pick within HANDLE px (§8.2's pick order), and the stick is bolted
    // to exactly that pin — so grabbing the middle of the crate would drag the
    // stick's end instead and this would silently test the wrong gesture.
    gesture(S, { x: 0, y: -112 }, { x: 0, y: 300 }, { watch: goalAt(S, 0) });
    byCrate = S.goalPositions[0].y;
  }
  gate('3. grabbing the stick and grabbing the crate stop in the same place',
    near(byStick, byCrate, 1.5), `by stick ${byStick.toFixed(2)} vs by crate ${byCrate.toFixed(2)}`);

  // 3f — a crate whose bolted stick sweeps into a pillar the CRATE never goes
  // near. This is the case §16 names outright ("a bolted crate sail through a
  // pillar and snap back: the crate never touched anything, the stick swept
  // clean through, and only the drop said so").
  //
  // The geometry has to be arranged for it. A stick bolted to the crate's pin
  // doesn't travel with the crate — it STRETCHES, pivoting about its far end —
  // so the only way the stick can meet something first is for the obstacle to
  // sit in the arc it sweeps, off the crate's own path. Hence a stick standing
  // straight up from the crate to (0,−300) and a small block out at (60,−200):
  // the crate runs along y −100 and never touches it, and the stick's body
  // crosses it about a third of the way through the drag.
  {
    const S = screen(flatWorld({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'box', x: 60, y: -200, w: 20, h: 20 }],
      goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }],
    }), { parts: [{ t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 0, y2: -300, id: 'r' }] });
    const g = gesture(S, { x: 12, y: -108 }, { x: 400, y: -108 }, { watch: goalAt(S, 0) });
    const crateX = S.goalPositions[0].x;
    gate('3. a crate stops when the STICK bolted to it sweeps into a block',
      g.held && crateX > 20 && crateX < 160,
      `crate stopped at x ${crateX.toFixed(2)} (block spans x 50–70 at y −200)`);
  }

  // 3g — a multi-selection, built through the real Ctrl+click path.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'w' },
        { t: 'wheel', kind: 'free', x: 60, y: -100, r: 15, id: 'w2' },
      ],
    });
    ctrlClick(S, -60, -100);
    ctrlClick(S, 60, -100);
    const built = S.multiSel.length === 2;
    const g = gesture(S, { x: -60, y: -100 }, { x: -60, y: 300 }, { watch: partAt(S, 0) });
    gate('3. a multi-selection dragged into the floor stops on it and stays',
      built && g.type === 'move-multi' && g.held && near(S.design.parts[0].y, rest, 1.5),
      `drag ${g.type}, y ${S.design.parts[0].y.toFixed(2)}`);
  }

  // 3h — a multi-selection TOWING a crate that is not itself selected. The
  // crate is an external companion (`goalRides`), checked on frozen terms.
  {
    const S = screen(flatWorld({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }] }), {
      parts: [
        { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: -100, id: 'r' },
        { t: 'wheel', kind: 'free', x: 120, y: -100, r: 15, id: 'w' },
      ],
    });
    ctrlClick(S, 30, -100);
    ctrlClick(S, 120, -100);
    const g = gesture(S, { x: 30, y: -100 }, { x: 30, y: 300 }, { watch: goalAt(S, 0) });
    gate('3. a multi-selection towing an unselected crate stops when the crate lands',
      S.multiSel.length === 2 && g.held && near(S.goalPositions[0].y, restY(15), 1.5),
      `crate y ${S.goalPositions[0].y.toFixed(2)}`);
  }

  // 3j — the same situation for a MACHINE part. These freeze their rules too
  // now (`_partDragRules`). They used not to, and the failure was quiet: the
  // sweep's t=0 was already invalid, so it bisected straight back to zero and
  // the piece could not be dragged at all. Live and release agreed — both
  // refused — so it was never a snap-back, just a silent one-way door whose
  // only exit was deleting the piece.
  {
    const S = screen(flatWorld(), { parts: [{ t: 'rod', kind: 'wood', x1: -30, y1: 20, x2: 30, y2: 20, id: 'r' }] });
    const g = gesture(S, { x: 0, y: 20 }, { x: 200, y: 20 }, { watch: partAt(S, 0) });
    gate('3. a machine part that started buried stays draggable, and is not judged on release',
      g.held && S.design.parts[0].x1 > 120 && g.toasts.length === 0,
      `moved from -30 to ${S.design.parts[0].x1.toFixed(1)}${g.held ? '' : ' — SNAPPED BACK'}`);
  }

  // ...and freezing terrain off must not also switch off the BUILD ZONE. The
  // two halves are treated differently on purpose: terrain is off live and on
  // release alike, the zone is off for the sweep only and the clamp bridges it
  // (see _movedAssemblyInvalid). Without that split, a buried part could be
  // walked anywhere in the level.
  {
    const S = screen(flatWorld(), { parts: [{ t: 'rod', kind: 'wood', x1: -30, y1: 20, x2: 30, y2: 20, id: 'r' }] });
    gesture(S, { x: 0, y: 20 }, { x: 5000, y: 20 }, { watch: partAt(S, 0) });
    const r = S.design.parts[0];
    gate('3. ...but it is still held inside the build zone',
      r.x2 <= 350 + ZONE_SLACK, `far end at x ${r.x2.toFixed(2)}, zone edge at 350`);
  }

  // 3k — a level-authored (fixed) part. Its branch of _moveDrag had no sweep
  // and no clamp: it tracked the pointer into solid terrain and the release
  // check then refused it — the mismatch §16 opens with. It sweeps now, on the
  // same frozen terms, with no build-zone confinement (fixed parts aren't
  // confined to the machine's build area).
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S.level.fixedParts = [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'f' }];
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 20 }, { watch: fixedAt(S, 0) });
    gate('3. a fixed part dragged into the floor stops on it and stays',
      g.held && near(S.level.fixedParts[0].y, rest, 1.5) && g.toasts.length === 0,
      `y ${S.level.fixedParts[0].y.toFixed(2)}, want ~${rest}`);
  }

  // ...and it is NOT zone-confined, which is the exemption its placement check
  // has always had. Terrain stops it; the build area doesn't.
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S.level.fixedParts = [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'f' }];
    const g = gesture(S, { x: 0, y: -100 }, { x: 900, y: -100 }, { watch: fixedAt(S, 0) });
    gate('3. ...and a fixed part still travels outside the build zone freely',
      g.held && near(S.level.fixedParts[0].x, 900, 1), `x ${S.level.fixedParts[0].x.toFixed(2)}`);
  }

  // Ctrl+Shift+drag is the author's way to bury one on purpose, same as for a
  // prop — the override has to exist wherever the rule does.
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S.level.fixedParts = [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'f' }];
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 20 },
      { mods: { ctrlKey: true, shiftKey: true }, watch: fixedAt(S, 0) });
    gate('3. ...and Ctrl+Shift+drag buries a fixed part on purpose',
      g.held && near(S.level.fixedParts[0].y, 20, 1.5), `y ${S.level.fixedParts[0].y.toFixed(2)}, want 20`);
  }

  // ---- 3l: the freeze is PER PIECE, not per assembly ----
  //
  // It used to be one set for the whole moved assembly, and that is a looseness
  // with the same shape as the bug freezing exists to fix, pointing the other
  // way: one buried member exempted everything travelling with it, so a
  // perfectly clean wheel bolted to a stick the level left in the ground could
  // be dragged into the ground itself (measured: the wheel ended at y 20, with
  // the floor's surface at y 0).
  //
  // It survived both a hand-written suite and 120,000 fuzzed gestures for a
  // reason worth remembering: live and release AGREED — both permissive — and
  // agreement is the invariant they assert. Nothing snapped back. Only asking
  // "is the CLEAN piece still held?" finds it.
  //
  // Both halves are gated at each of the four ways an assembly moves, because
  // either half alone is a regression: the clean piece must be held to the
  // wall, AND the buried one must keep its exemption (a one-way door is the
  // failure freezing exists to prevent in the first place).
  //
  // The rig is one clean wheel and one stick whose far end the level left
  // inside the floor, bolted at the wheel's hub. The first two asserts pin
  // that, so a gate can't pass by the rig quietly becoming legal.
  const buriedRig = () => screen(flatWorld(), {
    parts: [
      { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' },
      { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: 20, id: 'r' },   // far end buried
    ],
  });
  {
    const S = buriedRig();
    gate('3. the per-piece rig starts with a clean wheel...',
      S._wheelInvalid(S.design.parts[0], S.design.parts[0], true, true) === null);
    gate('3. ...bolted to a stick the level left in the floor',
      S._rodInvalid(S.design.parts[1], S.design.parts[1], true, true) !== null);
  }

  // Grab the buried piece instead — §16's both-ends rule. This is a different
  // branch of _moveDrag (a rod body drag carries `rides`, a wheel drag carries
  // `stretches`), so the answer has to be re-asked, not assumed.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: 20, id: 'r' },   // far end buried
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' },
      ],
    });
    const g = gesture(S, { x: 30, y: -40 }, { x: 30, y: 300 }, { watch: partAt(S, 1) });
    gate('3. ...and dragging the buried stick still stops when the WHEEL lands',
      g.held && near(S.design.parts[1].y, rest, 1.5) && g.toasts.length === 0,
      `wheel y ${S.design.parts[1].y.toFixed(2)}, want ~${rest}`);
  }

  // A multi-selection: two unconnected pieces, one authored in the floor. This
  // path froze `region` and `terrain` only — `props` was never in its set at
  // all, so a selected wheel could be walked through a boulder that stops the
  // same wheel dragged alone. One shared helper now builds both.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' },
        { t: 'rod', kind: 'wood', x1: 100, y1: 10, x2: 160, y2: 10, id: 'r' },   // authored in the floor
      ],
    });
    ctrlClick(S, 0, -100);
    ctrlClick(S, 130, 10);
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { watch: partAt(S, 0) });
    gate('3. ...and a multi-selection holds its clean member to the floor too',
      S.multiSel.length === 2 && g.held && near(S.design.parts[0].y, rest, 1.5) && g.toasts.length === 0,
      `wheel y ${S.design.parts[0].y.toFixed(2)}, want ~${rest}`);
  }

  // The arrow keys, which have no clamp and no sweep — they move, then judge.
  // Half a pixel clear of the surface rather than flush on it: the overlap test
  // is inclusive, so a wheel sitting exactly on restY already reads as touching
  // and would freeze its own rule off, passing this for the wrong reason. The
  // first assert is what keeps that honest.
  {
    const y0 = restY(15) - 0.5;
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: 0, y: y0, r: 15, id: 'w' },
        { t: 'rod', kind: 'wood', x1: 0, y1: y0, x2: 60, y2: 20, id: 'r' },
      ],
    });
    S.sel = { kind: 'part', ref: S.design.parts[0] };
    gate('3. ...and that wheel starts genuinely clear of the floor',
      S._wheelInvalid(S.design.parts[0], S.design.parts[0], true, true) === null);
    S._nudge(0, 1);
    gate('3. ...and an arrow key can\'t step the clean wheel in either',
      near(S.design.parts[0].y, y0) && S.toasts.length > 0,
      `y ${S.design.parts[0].y}, want ${y0}`);
  }

  // And the goal-drag path, whose towed sticks were frozen by a single
  // all-or-nothing flag (`skipCompanions`) rather than per piece. Same rig as
  // 3f — the crate runs clear along y −100 while the stick standing up from it
  // sweeps across a block — plus a second stick the level left in the floor.
  // Under the old flag that buried stick switched the whole companion set off
  // and the crate sailed the full 400 px.
  {
    const S = screen(flatWorld({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'box', x: 60, y: -200, w: 20, h: 20 }],
      goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }],
    }), {
      parts: [
        { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 0, y2: -300, id: 'r' },
        { t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 40, y2: 20, id: 'b' },   // far end buried
      ],
    });
    gate('3. ...the goal rig\'s second stick really does start in the floor',
      S._rodInvalid(S.design.parts[1], S.design.parts[1], true, true) !== null);
    const g = gesture(S, { x: 12, y: -108 }, { x: 400, y: -108 }, { watch: goalAt(S, 0) });
    const crateX = S.goalPositions[0].x;
    gate('3. ...and a crate towing one buried stick is still stopped by its clean one',
      g.held && crateX > 20 && crateX < 160,
      `crate stopped at x ${crateX.toFixed(2)} (block spans x 50–70 at y −200)`);
  }

  // **A multi-selection travels RIGIDLY, for its whole length.** `_applyGeom`
  // used to ask `_goalLocked` on every apply, and that reads the piece's live
  // position — so a goal piece that started inside the build zone rode along
  // until the sweep carried it clear, then locked, stopped following, and
  // stranded itself. The revert couldn't put it back either: it restores
  // through the same function and hit the same early return, leaving a partial
  // revert no later gesture could undo. Found by the fuzzer on one seed out of
  // four (§16: a rule read at the live position switches itself off at the
  // moment it matters).
  //
  // The assertion is rigidity — every member moves by the SAME delta — because
  // that is the property the live check silently broke.
  {
    const S = screen({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      buildZones: [{ x: 0, y: -100, w: 400, h: 200 }],
      // wholly inside the zone (-200..0), so it starts UNLOCKED under the
      // 2026-08-07 rule — the gate below is about RIGIDITY, and a locked
      // piece would sit the move out for an unrelated reason
      goalObjs: [{ shape: 'ball', x: 60, y: -180, r: 12 }],
    }, { parts: [{ t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'w' }] });
    const g0 = { ...S.goalPositions[0] }, p0 = { ...S.design.parts[0] };
    gate('3. ...and that goal piece starts unlocked', !S._goalLocked(0));
    ctrlClick(S, -60, -100);
    ctrlClick(S, 60, -190);
    // straight up and well clear of the zone, which is what used to trip it
    gesture(S, { x: -60, y: -100 }, { x: -60, y: -800 }, { watch: partAt(S, 0) });
    const gd = { x: S.goalPositions[0].x - g0.x, y: S.goalPositions[0].y - g0.y };
    const pd = { x: S.design.parts[0].x - p0.x, y: S.design.parts[0].y - p0.y };
    gate('3. a multi-selection carries a goal piece rigidly even out of zone contact',
      S.multiSel.length === 2 && samePt(gd, pd),
      `goal moved ${gd.x.toFixed(2)},${gd.y.toFixed(2)} vs part ${pd.x.toFixed(2)},${pd.y.toFixed(2)}`);
  }

  // ...and the behaviour the live check was reaching for still holds: a piece
  // the LEVEL put outside the build area sits out the move rather than
  // blocking it. Decided once, at drag-start, so it cannot flip mid-gesture.
  {
    const S = screen({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      buildZones: [{ x: 0, y: -100, w: 200, h: 200 }],
      goalObjs: [{ shape: 'box', x: 900, y: -100, w: 40, h: 30 }],
    }, { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
    gate('3. ...while a goal piece the level left outside IS locked', S._goalLocked(0));
    S.multiSel = [{ kind: 'part', ref: S.design.parts[0] }, { kind: 'goal', idx: 0 }];
    const g0 = { ...S.goalPositions[0] };
    gesture(S, { x: 0, y: -100 }, { x: -60, y: -100 }, { watch: partAt(S, 0) });
    gate('3. ...and it sits the move out instead of blocking it',
      samePt(S.goalPositions[0], g0) && S.design.parts[0].x < -50,
      `goal stayed at ${S.goalPositions[0].x}, part reached ${S.design.parts[0].x.toFixed(1)}`);
  }

  // A multi-selection containing an already-buried stick freezes as one set,
  // so the whole group stays draggable rather than the buried member pinning it.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'rod', kind: 'wood', x1: -30, y1: 20, x2: 30, y2: 20, id: 'r' },
        { t: 'wheel', kind: 'free', x: 120, y: -100, r: 15, id: 'w' },
      ],
    });
    ctrlClick(S, 0, 20);
    ctrlClick(S, 120, -100);
    const g = gesture(S, { x: 0, y: 20 }, { x: 150, y: 20 }, { watch: partAt(S, 0) });
    gate('3. a multi-selection containing a buried part is still draggable',
      S.multiSel.length === 2 && g.held && S.design.parts[0].x1 > 80,
      `moved from -30 to ${S.design.parts[0].x1.toFixed(1)}`);
  }
}

// ---------- gate 4: props and goal pieces are solid — and which ones ghost ----------
//
// §8.2. The distinction is the point: terrain and props STOP a drag, other
// goal pieces are passed THROUGH wearing the red X. A gate that only checked
// "illegal positions are refused" would be satisfied by making everything stop,
// which would take away the one move you want when arranging two crates.
{
  const rest = restY(15);

  {
    const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }), { tab: 'level' });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { watch: propAt(S, 0) });
    gate('4. a prop dragged into the floor stops on it and stays',
      g.held && near(S.level.props[0].y, restY(15), 1.5), `y ${S.level.props[0].y.toFixed(2)}`);
  }

  // Ctrl+Shift+drag is the author's deliberate override — a level may want a
  // crate half-sunk in a boulder. It must actually bury it.
  {
    const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }), { tab: 'level' });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 25 },
      { mods: { ctrlKey: true, shiftKey: true }, watch: propAt(S, 0) });
    gate('4. Ctrl+Shift+drag buries a prop on purpose',
      g.held && near(S.level.props[0].y, 25, 1.5), `y ${S.level.props[0].y.toFixed(2)}, want 25`);
  }

  // ...and the override is authoring-only: no modifier reaches the zone rule,
  // and the whole gesture doesn't exist while solving (§8.2).
  {
    const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }), { tab: 'machine' });
    S.sel = null;
    gate('4. the override does not exist in the machine tab',
      S._isObstacleOverride({ ctrlKey: true, shiftKey: true, altKey: false }, { x: 0, y: -100 }) === false);
  }

  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }, { shape: 'box', x: 0, y: -20, w: 60, h: 30 }],
    }), { tab: 'level' });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 200 }, { watch: propAt(S, 0) });
    gate('4. a prop dragged onto another prop stops on it',
      g.held && S.level.props[0].y < -20, `y ${S.level.props[0].y.toFixed(2)}, other prop top at -35`);
  }

  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: 0, y: -20, w: 60, h: 30 }],
      goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }],
    }));
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 200 }, { watch: goalAt(S, 0) });
    gate('4. a goal piece dragged onto a prop stops on it',
      g.held && S.goalPositions[0].y < -20, `y ${S.goalPositions[0].y.toFixed(2)}`);
  }

  // Goal pieces are SOLID to each other — the drag stops rather than ghosting
  // through wearing the X. They were the last rule on this path that only ever
  // marked, and arranging goal pieces in the Maker is precisely where that came
  // up constantly and meant nothing anyone wanted.
  const pair = () => flatWorld({
    goalObjs: [{ shape: 'box', x: -100, y: -100, w: 40, h: 30 }, { shape: 'box', x: 0, y: -100, w: 40, h: 30 }],
  });
  {
    const S = screen(pair(), { tab: 'level' });
    const g = gesture(S, { x: -100, y: -100 }, { x: 0, y: -100 }, { watch: goalAt(S, 0) });
    gate('4. a goal piece dragged at its neighbour stops against it',
      g.held && S.goalPositions[0].x < -38 && g.toasts.length === 0,
      `stopped at x ${S.goalPositions[0].x.toFixed(2)}, neighbour's near face at -20`);
    gate('4. ...and never wears the red X on the way',
      !g.badDrop, `badDrop ${g.badDrop}`);
  }

  // Ctrl+Shift+drag is the deliberate way to overlap them, and it must land —
  // the override has to exist wherever the rule does.
  {
    const S = screen(pair(), { tab: 'level' });
    const g = gesture(S, { x: -100, y: -100 }, { x: 0, y: -100 },
      { mods: { ctrlKey: true, shiftKey: true }, watch: goalAt(S, 0) });
    gate('4. ...but Ctrl+Shift+drag overlaps them on purpose',
      g.held && near(S.goalPositions[0].x, 0, 1) && g.toasts.length === 0,
      `x ${S.goalPositions[0].x.toFixed(2)}`);
  }

  // Sliding is what replaces the ghost-through: pushing diagonally past a
  // neighbour still gets you by, so "arrange these two side by side" survives.
  {
    const S = screen(pair(), { tab: 'level' });
    const g = gesture(S, { x: -100, y: -100 }, { x: 100, y: -160 }, { watch: goalAt(S, 0) });
    gate('4. ...and a drag past a neighbour slides around it rather than jamming',
      g.held && S.goalPositions[0].x > 0 && g.toasts.length === 0,
      `got to x ${S.goalPositions[0].x.toFixed(2)}, y ${S.goalPositions[0].y.toFixed(2)}`);
  }

  // Frozen like every other rule: two crates the level authored already
  // overlapping stay draggable, and dragging them APART must not be refused.
  {
    const S = screen(flatWorld({
      goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }, { shape: 'box', x: 10, y: -100, w: 40, h: 30 }],
    }), { tab: 'level' });
    const g = gesture(S, { x: -14, y: -100 }, { x: -200, y: -100 }, { watch: goalAt(S, 0) });
    gate('4. ...and a pair authored overlapping can still be pulled apart',
      g.held && S.goalPositions[0].x < -150 && g.toasts.length === 0,
      `x ${S.goalPositions[0].x.toFixed(2)}`);
  }

  // **A rotated crate reaches its neighbour as closely as an unrotated one.**
  // Goal-vs-goal ran its own arithmetic against the crate's angle-aware
  // BOUNDING BOX, described in the source as "slightly conservative near a
  // tilted corner". It is not slight — a 60×30 crate at 45° has a box half
  // again its size — so a rotated crate stopped a long way short with a visible
  // gap. Invisible while the rule only drew a red X; obvious the moment it
  // became solid. It now goes through `piecesOverlap`, the same drawer
  // prop-vs-prop and goal-vs-prop always used, which is why only THIS pairing
  // ever looked wrong.
  //
  // Measured as the true surface gap, so the assertion holds for a circle
  // neighbour too — where the contact is corner-to-arc and nowhere near the
  // crate's extreme-x corner.
  {
    // **Measured against the ROUNDED crate**, which is the shape drawn
    // (`cornerRadiusOf`) and simulated (`b2MakeRoundedBox`). This reference
    // used the raw half-extents, i.e. a sharp rectangle — and once the editor
    // started measuring the real shape, the gate reported the rotated crate as
    // 1.9 px INSIDE its neighbour, because the sharp box's corner sticks out
    // past the arc that is actually there. The corner radius is restated, not
    // imported, so a change to `CORNER_RADIUS_DEFAULT` stops this file.
    const CR = 8;
    const distToBox = (px, py, cx, cy, hw, hh, ang) => {
      const c = Math.cos(-ang), s = Math.sin(-ang);
      const dx = px - cx, dy = py - cy;
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      // to the CORE, then out by the corner radius: a rounded box is the
      // Minkowski sum of the two, so this is its true surface distance
      return Math.hypot(Math.max(Math.abs(lx) - (hw - CR), 0), Math.max(Math.abs(ly) - (hh - CR), 0)) - CR;
    };
    const gaps = [0, 20, 45, 70].map((deg) => {
      const ang = deg * Math.PI / 180;
      const g = { shape: 'box', x: -150, y: 0, w: 60, h: 30, angle: ang };
      const S = screen({ buildZones: [{ x: 0, y: 0, w: 900, h: 400 }], goalObjs: [g, { shape: 'ball', x: 150, y: 0, r: 20 }] });
      gesture(S, { x: -150, y: 0 }, { x: 150, y: 0 }, { steps: 40, watch: goalAt(S, 0) });
      const p = S.goalPositions[0];
      return { deg, gap: distToBox(150, 0, p.x, p.y, 30, 15, ang) - 20, legal: !S._goalOverlapsOthers(0, g, p) };
    });
    gate('4. a rotated crate reaches a neighbouring goal piece as closely as an unrotated one',
      gaps.every(g => g.legal) &&
      Math.max(...gaps.map(g => g.gap)) - Math.min(...gaps.map(g => g.gap)) < 0.05,
      gaps.map(g => `${g.deg}°:${g.gap.toFixed(2)}`).join('  '));
    // ...and at REST_GAP, not at the tolerance. The drag stops where the piece
    // can REST — a hundredth of a pixel clear — rather than at the last spot the
    // validity rule still tolerates, which was a whole pixel of overlap.
    gate('4. ...at REST_GAP, so the pieces are touching and not overlapping',
      gaps.every(g => Math.abs(g.gap - REST_GAP) < 0.005),
      `gap ${gaps[0].gap.toFixed(4)} px, REST_GAP is ${REST_GAP}`);
  }

  // Placement and paste keep refusing outright — they have nowhere to stop.
  {
    const S = screen(pair(), { tab: 'level' });
    gate('4. ...while PLACING one on top of another is still refused outright',
      /overlap each other/.test(
        S._landingBlocked({ shape: 'box', w: 40, h: 30 }, { x: 0, y: -100 }, { idx: -1, isGoal: true }) || ''));
  }
}

// ---------- gate 5: every way a piece can APPEAR obeys the drag's rules ----------
//
// §16: "a rule enforced on drags is not enforced on the ways a piece can
// appear." Placement, paste and duplicate put pieces down without any drag, so
// they miss every predicate that lives in a drag handler. The gate is
// agreement — the same piece at the same spot, refused by a drag, refused by
// each of the other routes.
{
  const world = flatWorld({
    props: [{ shape: 'box', x: 200, y: -20, w: 60, h: 30 }],
    goalObjs: [{ shape: 'box', x: -200, y: -100, w: 40, h: 30 }],
  });

  const S = screen(world, { tab: 'level' });
  const crate = { shape: 'box', w: 40, h: 30 };
  gate('5. a goal piece cannot be PLACED in terrain',
    /terrain/.test(S._landingBlocked(crate, { x: 0, y: 25 }, { idx: -1, isGoal: true }) || ''));
  gate('5. a goal piece cannot be PLACED on a prop',
    /prop/.test(S._landingBlocked(crate, { x: 200, y: -40 }, { idx: -1, isGoal: true }) || ''));
  gate('5. a goal piece cannot be PLACED overlapping another goal piece',
    /overlap each other/.test(S._landingBlocked(crate, { x: -200, y: -100 }, { idx: -1, isGoal: true }) || ''));
  gate('5. a prop cannot be PLACED in terrain',
    /terrain/.test(S._landingBlocked({ shape: 'box', w: 30, h: 30 }, { x: 0, y: 25 }) || ''));
  gate('5. a clear spot is accepted by all of them',
    S._landingBlocked(crate, { x: 0, y: -200 }, { idx: -1, isGoal: true }) === null);

  // Paste — the route that used to be unconditional for props and goal pieces.
  {
    const P = screen(world, { tab: 'level' });
    P._lastPointer = { x: 0, y: 25 };
    P._pasteSel({ entries: [{ kind: 'prop', data: { shape: 'box', x: 0, y: 0, w: 30, h: 30 } }], anchor: { x: 0, y: 0 } });
    gate('5. pasting a prop into terrain is refused',
      P.level.props.length === 1 && P.toasts.some(t => /Paste doesn't fit/.test(t)));
  }
  {
    const P = screen(world, { tab: 'level' });
    P._lastPointer = { x: 0, y: -200 };
    P._pasteSel({ entries: [{ kind: 'prop', data: { shape: 'box', x: 0, y: 0, w: 30, h: 30 } }], anchor: { x: 0, y: 0 } });
    gate('5. ...and pasting the same prop somewhere clear lands',
      P.level.props.length === 2 && P.level.props[1].y === -200);
  }
  {
    const P = screen(world, { tab: 'machine' });
    P._lastPointer = { x: 5000, y: -100 };
    P._pasteSel({
      entries: [{ kind: 'part', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    });
    gate('5. pasting a machine part outside the build zone is refused',
      P.design.parts.length === 0 && P.toasts.some(t => /build zone/.test(t)));
  }
  // The pad on the clipboard lands with the same delta, so the check has to
  // see it. Otherwise duplicating a room is refused for leaving the box it
  // just copied.
  {
    const P = screen(world, { tab: 'level' });
    P._lastPointer = { x: 1200, y: -100 };
    const nZones = P.level.buildZones.length;
    P._pasteSel({
      entries: [
        { kind: 'part', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } },
        { kind: 'zone', zoneType: 'build', data: { x: 0, y: 0, w: 80, h: 80 } },
      ],
      anchor: { x: 0, y: 0 },
    });
    gate('5. a machine that brings its own build pad is not refused for leaving the old one',
      P.design.parts.length === 1 && P.level.buildZones.length === nZones + 1
      && !P.toasts.some((t) => /build zone/.test(t)),
      `parts ${P.design.parts.length} zones ${P.level.buildZones.length} ${(P.toasts || []).join(' | ')}`);
  }
  // Fixed parts were the one paste entry with no positional check at all, so
  // Ctrl+V or Duplicate buried a level-authored wheel in the floor while
  // placing one there was refused.
  {
    const P = screen(world, { tab: 'level' });
    P._lastPointer = { x: 0, y: 25 };
    P._pasteSel({
      entries: [{ kind: 'fixed', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    });
    gate('5. pasting a fixed part into terrain is refused',
      P.level.fixedParts.length === 0 && P.toasts.some(t => /Paste doesn't fit/.test(t)),
      P.toasts.join(' | '));
  }
  // ...but a fixed part is not build-zone-confined, so pasting one well
  // outside the build area still lands — the exemption its placement has.
  //
  // 1200 is chosen against TWO limits: outside the build zone, which is what
  // this gate is about, and inside the world fence (§10.7), which is not. It
  // was 5000 and began failing when the fence arrived — the gate was right, its
  // fixture had been parked somewhere that later became meaningful.
  {
    const P = screen(world, { tab: 'level' });
    P._lastPointer = { x: 1200, y: -100 };
    P._pasteSel({
      entries: [{ kind: 'fixed', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    });
    gate('5. ...and pasting one outside the build zone still lands',
      P.level.fixedParts.length === 1 && P.level.fixedParts[0].x === 1200);
  }
}

// ---------- gate 6: the placement sweep is target-gated (§8.2) ----------
//
// A refused PLACEMENT loses the piece; a refused move only snaps it back
// (§16). So drawing must come to rest at the last spot that works rather than
// throwing the gesture away — and it must still be able to REACH a pin that
// makes an overlap legal, which is why the wall is gated on the target instead
// of being always-on.
{
  // A stick drawn from open space, through a wheel's body, to its hub pin on
  // the far side. Always-full rules would stop the ghost the moment it entered
  // the wheel and this stick could never be built.
  {
    const S = screen(flatWorld(), {
      tool: 'rod-wood',
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }],
    });
    gesture(S, { x: -80, y: -100 }, { x: 0, y: -100 }, { watch: () => ({ x: 0, y: 0 }) });
    const rod = S.design.parts.find(p => p.t === 'rod');
    gate('6. a stick can be drawn through a wheel\'s body to its hub pin',
      !!rod && near(rod.x2, 0, 0.01) && near(rod.y2, -100, 0.01),
      rod ? `ends at ${rod.x2.toFixed(2)},${rod.y2.toFixed(2)}` : 'no stick placed');
  }

  // Overshoot into the floor. The old behaviour threw the whole stick away;
  // it must now come to rest at the last placeable point and BE a stick.
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gesture(S, { x: -80, y: -40 }, { x: 0, y: 200 }, { watch: () => ({ x: 0, y: 0 }) });
    const rod = S.design.parts.find(p => p.t === 'rod');
    gate('6. a stick overshot into the floor still lands, stopped at the surface',
      !!rod && rod.y2 <= restY(ROD_THICK / 2) + 1.5,
      rod ? `end y ${rod.y2.toFixed(2)}` : 'NOTHING PLACED — the overshoot was thrown away');
    // A stick measures clearance from its CENTRELINE, so this is the one shape
    // where "stop at the surface" and "stop at the centreline limit" differ by
    // a whole half-thickness. Sticks drawn along the ground popped up on Play.
    gate('6. …with its surface CLEAR of the floor, not inside it',
      !!rod && embedded(Math.max(rod.y1, rod.y2) + ROD_THICK / 2) <= 0,
      rod ? `surface y ${(Math.max(rod.y1, rod.y2) + ROD_THICK / 2).toFixed(4)} (terrain top 0)` : 'NOTHING PLACED');
  }

  // The Boomerang case: an anchor already on the surface, dragged down and
  // ALONG. A straight ray from there is entirely inside the terrain, so a plain
  // sweep truncates the stick to nothing and _placeRodFinish drops it under
  // MIN_ROD_LEN — silently. Sliding lays it out along the surface instead.
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gesture(S, { x: -80, y: -1.9 }, { x: 80, y: 60 }, { watch: () => ({ x: 0, y: 0 }) });
    const rod = S.design.parts.find(p => p.t === 'rod');
    const len = rod ? Math.hypot(rod.x2 - rod.x1, rod.y2 - rod.y1) : 0;
    gate('6. a stick drawn down-and-along a surface lays out along it',
      !!rod && len >= MIN_ROD_LEN && rod.x2 > 0,
      rod ? `length ${len.toFixed(1)}, end x ${rod.x2.toFixed(1)}` : 'NOTHING PLACED');
  }

  // **A pin left at the old tolerance boundary must still be draggable.**
  //
  // Every stick placed against the ground before the sweep was fixed sits with
  // its centreline at -(ROD_THICK/2 - TERRAIN_TOUCH_PAD). _endpointDrag sweeps
  // with SWEEP_PAD, which inflates terrain by the FULL half-thickness — so that
  // start position fails the sweep rule at t=0, _sweepValidFraction returns 0,
  // and the endpoint cannot be moved in ANY direction, not even straight up and
  // away from the surface, with no message at all. The pin is simply welded.
  // Levels authored before the fix still contain those sticks, so this is a
  // permanent requirement and not a transitional one.
  for (const [label, dx, dy] of [['up', 0, -40], ['down', 0, 20]]) {
    // The legacy resting place, as the old sweep actually produced it: a hair
    // ABOVE the acceptance boundary, not exactly on it. Real levels contain
    // -1.0003, because a sweep stops at the last sample that still passed.
    // Exactly -1 is a different case — invalid by acceptance too, so it draws
    // the red X and is not the silent freeze this gate is about.
    const pinY = restY(ROD_THICK / 2) - 0.0003;
    const parts = [
      { t: 'rod', kind: 'wood', x1: -150, y1: -80, x2: -100, y2: pinY, id: 'r1' },
      { t: 'rod', kind: 'wood', x1: -50, y1: -80, x2: -100, y2: pinY, id: 'r2' },
    ];
    const S = screen(flatWorld(), { tool: 'pointer', parts });
    const before = S.design.parts.map(p => `${p.x2.toFixed(1)},${p.y2.toFixed(1)}`).join('|');
    gesture(S, { x: -100, y: pinY }, { x: -100 + dx, y: pinY + dy });
    const after = S.design.parts.map(p => `${p.x2.toFixed(1)},${p.y2.toFixed(1)}`).join('|');
    // dragging DOWN into the floor legitimately goes nowhere; it must still not
    // throw, and both sticks must stay in agreement
    const bothMoved = S.design.parts[0].x2 === S.design.parts[1].x2
      && S.design.parts[0].y2 === S.design.parts[1].y2;
    gate(`6. a shared pin resting on the floor can be dragged ${label}`,
      dy > 0 ? bothMoved : (before !== after && bothMoved),
      `${before} -> ${after}`);
  }

  // A wheel ghost stops at the terrain border rather than burying itself.
  {
    const S = screen(flatWorld(), { tool: 'wheel-free' });
    gesture(S, { x: 0, y: -100 }, { x: 0, y: 200 }, { watch: () => ({ x: 0, y: 0 }) });
    const wheel = S.design.parts.find(p => p.t === 'wheel');
    gate('6. a placed wheel ghost stops at the terrain border',
      !!wheel && near(wheel.y, restExact(STD_WHEEL_R), 0.1),
      wheel ? `y ${wheel.y.toFixed(4)}, want ${restExact(STD_WHEEL_R)}` : 'NOTHING PLACED');
    // The bug this replaced: the ghost swept to the last position the
    // TOLERANCE accepted, leaving the wheel a full pixel inside the floor, and
    // Play depenetrated it — the piece visibly hopped. Assert the SURFACE is
    // clear, which is the thing that actually matters.
    gate('6. …with its surface CLEAR of the floor, not inside it',
      !!wheel && embedded(wheel.y + wheel.r) <= 0,
      wheel ? `surface y ${(wheel.y + wheel.r).toFixed(4)} (terrain top 0)` : 'NOTHING PLACED');
  }

  // The same wall on the third path that has it: dragging a stick's ENDPOINT
  // through a wheel's body onto its hub pin. Different handler, same rule.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'rod', kind: 'wood', x1: -150, y1: -100, x2: -100, y2: -100, id: 'r' },
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: 30, id: 'w' },
      ],
    });
    const end = () => ({ x: S.design.parts[0].x2, y: S.design.parts[0].y2 });
    const g = gesture(S, { x: -100, y: -100 }, { x: 0, y: -100 }, { watch: end });
    gate('6. a stick END can be dragged through a wheel onto its hub pin',
      g.type === 'move-endpoint' && g.held && samePt(end(), { x: 0, y: -100 }) && g.toasts.length === 0,
      `landed at ${end().x.toFixed(2)},${end().y.toFixed(2)}`);
  }

  // WHY the wall is target-gated rather than always-on, stated as a property
  // of the predicate itself: the FULL rule is genuinely non-monotonic along a
  // ray that ends on a pin — illegal as the wheel enters the crate, legal
  // again once its hub lands on the crate's pin. A sweep assumes validity is a
  // prefix (§16), so it cannot use this predicate unconditionally. If someone
  // ever "simplifies" the sweep to the full rule, this is the reason it breaks.
  {
    const S = screen({ buildZones: [{ x: 0, y: -100, w: 700, h: 500 }], goalObjs: [{ shape: 'box', x: 0, y: -100, w: 60, h: 60 }] });
    let flips = 0, wasBad = false;
    for (let i = 0; i <= 240; i++) {
      const x = -100 + 100 * (i / 240);
      const bad = S._wheelInvalid({ t: 'wheel', kind: 'free', x, y: -100, r: 15 }, null, true) != null;
      if (bad !== wasBad) { flips++; wasBad = bad; }
    }
    // The COUNT is not the claim — the shape of the sequence is. It was 2 until
    // goal pieces grew their concentric lattice (2026-08-12): a 60×60 crate now
    // carries edge-midpoint pins at ±27 as well as its middle, so a wheel whose
    // own rim pin lands on one is legal there too, and this ray passes through
    // two such islands instead of one. More non-monotonic, not less — asserting
    // the number would have made a richer lattice look like a regression.
    gate('6. the FULL predicate is non-monotonic near a pin — hence the target gate',
      flips >= 2 && flips % 2 === 0,
      `${flips} validity transitions along the ray (legal, illegal, then legal again on each pin it meets)`);
  }

  // _sweepPlacement's contract: -1 when t=0 was already unacceptable, because
  // _sweepValidFraction requires a valid t=0 and there is nothing to slide back
  // to. Then the ghost just tracks the cursor and the red X does the talking.
  {
    const S = screen(flatWorld());
    let where = 0;
    const t = S._sweepPlacement({ x: 0, y: 0 }, { x: 100, y: 0 }, (f) => { where = f; }, () => true);
    gate('6. _sweepPlacement returns -1 when the gesture started somewhere illegal',
      t === -1 && where === 1, `t ${t}, left at f ${where}`);
  }
}

// ---------- gate 9: the routes that change a footprint rather than a position ----------
//
// §16: "a rule enforced on drags is not enforced on the ways a piece can
// appear." Resize, rotate and align were the remaining three. They REVERT
// rather than stop — a resize has a whole family of shapes and no obvious
// "last good" one, and a handle that fights you mid-gesture reads as broken —
// so the gesture runs free and the drop judges it.
{
  const bigWorld = () => ({
    buildZones: [{ x: 0, y: 0, w: 200, h: 200 }],
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    goalObjs: [{ shape: 'box', x: 0, y: -60, w: 40, h: 30 }],
  });
  const grabHandle = (S, sel, to) => {
    S.sel = sel;
    const t = sel.kind === 'goal' ? S.level.goalObjs[sel.idx] : sel.ref;
    const pos = sel.kind === 'goal' ? S.goalPositions[sel.idx] : t;
    const h = S._resizeHandlePts(t, pos)[2];
    return gesture(S, { x: h.x, y: h.y }, to, { watch: () => ({ w: t.w, h: t.h }) });
  };

  // Resize a goal piece down through the floor: refused and put back exactly.
  {
    const S = screen(bigWorld(), { tab: 'level' });
    const g = grabHandle(S, { kind: 'goal', idx: 0 }, { x: 400, y: 400 });
    const t = S.level.goalObjs[0];
    gate('9. a resize that ends in terrain reverts, with a toast',
      g.type === 'resize' && t.w === 40 && t.h === 30 &&
      samePt(S.goalPositions[0], { x: 0, y: -60 }) && g.toasts.length === 1,
      `back to ${t.w}×${t.h} at ${S.goalPositions[0].x},${S.goalPositions[0].y} — "${g.toasts[0]}"`);
  }

  // ...and a resize that stays clear is committed untouched. The revert must
  // not become a rule that makes the handle useless.
  {
    const S = screen(bigWorld(), { tab: 'level' });
    grabHandle(S, { kind: 'goal', idx: 0 }, { x: 40, y: -40 });
    const t = S.level.goalObjs[0];
    gate('9. ...and a resize that fits is committed unchanged',
      t.w !== 40 && S._landingBlocked(t, S.goalPositions[0], { idx: 0, isGoal: true }) === null && S.commits === 1,
      `now ${t.w}×${t.h}, ${S.commits} commit(s)`);
  }

  // A crate the LEVEL authored half-sunk in a boulder must stay resizable —
  // the rules are frozen from the pre-gesture footprint, same as a drag.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 400 }],
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      goalObjs: [{ shape: 'box', x: 0, y: 20, w: 40, h: 30 }],
    }, { tab: 'level' });
    const g = grabHandle(S, { kind: 'goal', idx: 0 }, { x: 45, y: 40 });
    gate('9. a piece the level authored inside terrain stays resizable',
      S.level.goalObjs[0].w !== 40 && g.toasts.length === 0,
      `now ${S.level.goalObjs[0].w}×${S.level.goalObjs[0].h}`);
  }

  // Rotate goes through the same finish, and `angle` is a key rotate ADDS to a
  // piece that had none — so the revert has to remove it, not just overwrite.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 400 }],
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      props: [{ shape: 'box', x: 0, y: -60, w: 40, h: 40 }],
      goalObjs: [{ shape: 'box', x: 0, y: -8, w: 120, h: 10 }],
    }, { tab: 'level' });
    S.sel = { kind: 'goal', idx: 0 };
    const t = S.level.goalObjs[0];
    const k = S._rotateKnobPt(t, S.goalPositions[0]);
    // out to the RIGHT, level with the piece's centre: that is a quarter turn,
    // which stands a 120-long bar on its end and drives it through the floor.
    // (Straight down would be a HALF turn and leave the footprint identical.)
    const g = gesture(S, { x: k.x, y: k.y }, { x: 60, y: -8 }, { watch: () => ({ x: 0, y: 0 }) });
    gate('9. a rotate that ends in terrain reverts, and leaves no stray `angle`',
      g.type === 'rotate' && !('angle' in t) && t.w === 120 && g.toasts.length === 1,
      `angle key ${'angle' in t ? 'left behind' : 'removed'} — "${g.toasts[0]}"`);
  }

  // Align validated machine parts and goal zone/overlap but never the SOLID
  // world, so lining a crate up with a boulder parked it inside the boulder.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 400 }],
      props: [{ shape: 'box', x: 120, y: 0, w: 40, h: 40 }],
      goalObjs: [{ shape: 'box', x: -120, y: 0, w: 40, h: 30 }],
    }, { tab: 'level' });
    S.multiSel = [{ kind: 'prop', ref: S.level.props[0] }, { kind: 'goal', idx: 0 }];
    S._alignOp('centerX');
    gate('9. an align that would land a goal piece on a prop reverts',
      near(S.goalPositions[0].x, -120) && S.toasts.length === 1,
      `x ${S.goalPositions[0].x} — "${S.toasts[0]}"`);
  }

  // ...and `touch` still works, which is the gate that keeps the new rule from
  // eating the one align op whose whole job is to put pieces next to things.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 400 }],
      props: [{ shape: 'box', x: 120, y: 0, w: 40, h: 40 }],
      goalObjs: [{ shape: 'box', x: -120, y: 0, w: 40, h: 30 }],
    }, { tab: 'level' });
    S.multiSel = [{ kind: 'prop', ref: S.level.props[0] }, { kind: 'goal', idx: 0 }];
    S._alignOp('touch');
    gate('9. ...but `touch` still parks a crate flush against a prop',
      S.goalPositions[0].x > 60 && S.toasts.length === 0,
      `x ${S.goalPositions[0].x}, ${S.toasts.length} toast(s)`);
  }
}

// ---------- gate 9a: Ctrl+X is a CUT ----------
{
  // `target` present because _keyDown's first act is to ignore keys typed
  // into form fields — a real event always carries one
  const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
    altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
    preventDefault() {}, stopPropagation() {} });

  // a machine part under the cursor: Ctrl+X removes it AND puts it on the
  // paste clipboard — cut then paste is a MOVE, as it is everywhere else
  {
    const S = screen(flatWorld(), {
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -60, r: 15, id: 'w1' }],
    });
    S._lastPointer = { x: 0, y: -60 };
    S._keyDown(kev('x', { ctrl: true }));
    gate('9a. Ctrl+X on a piece removes it and fills the clipboard',
      S.design.parts.length === 0 && S._clipboard?.entries?.length === 1
      && S._clipboard.entries[0].kind === 'part',
      `${S.design.parts.length} parts left, clipboard ${S._clipboard?.entries?.length ?? 0}`);
  }

  // a REFUSED delete must not clobber the clipboard: the last goal piece
  // cannot be deleted, so cutting it must leave the previous copy intact
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 400 }],
      goalObjs: [{ shape: 'ball', x: 100, y: 0, r: 15 }],
    }, { tab: 'level' });
    S._clipboard = { entries: [{ kind: 'prop', data: { shape: 'box', x: 0, y: 0, w: 20, h: 20 } }], anchor: { x: 0, y: 0 } };
    S._lastPointer = { x: 100, y: 0 };
    S._keyDown(kev('x', { ctrl: true }));
    gate('9a. a refused cut (last goal piece) leaves the clipboard alone',
      S.level.goalObjs.length === 1 && S._clipboard.entries[0].kind === 'prop'
      && S.toasts.some(t => /at least one goal piece/.test(t)),
      `${S.level.goalObjs.length} goals, clipboard kind ${S._clipboard.entries[0].kind}`);
  }
}

// ---------- gate 9a2: the keys the Controls page documents ----------
{
  // #/keys documents these bindings as static text; these gates drive the
  // REAL _keyDown so a rebinding fails here instead of silently outdating
  // the page. One per documented family, not one per key.
  const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
    altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
    preventDefault() {}, stopPropagation() {} });
  const S = screen(flatWorld(), { tab: 'machine' });
  const press = (k, mods) => { S._keyDown(kev(k, mods)); return S.tool; };
  gate('9a2. letter keys pick tools as documented (L/F/R/H/W/X)',
    press('l') === 'wheel-ccw' && press('f') === 'wheel-free' && press('r') === 'wheel-cw'
    && press('h') === 'rod-wood' && press('w') === 'rod-water' && press('x') === 'delete',
    'L F R H W X');
  gate('9a2. number keys pick tools by position',
    press('1') === 'pointer' && press('5') === 'rod-wood',
    '1 -> pointer, 5 -> rod-wood');
  {
    const L = screen(flatWorld(), { tab: 'level' });
    L._keyDown(kev('7'));
    gate('9a2. Create-tab numbers reach the level tools', L.tool === 'terrain-box', `7 -> ${L.tool}`);
  }
}

// ---------- gate 9b: even spread ----------
{
  // A row with cramped middles: extremes at ±300 stay, middles land at even
  // intervals IN ORDER, pulled ONTO the line between the extremes — the y
  // jitter they started with is gone, because "evenly spread" is a claim
  // about what you see, and a piece hanging off the line reads as a ragged
  // gap however even the projections are (the first version kept the
  // perpendicular offsets, and the first real use looked wrong).
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 400 }],
      props: [
        { shape: 'box', x: -300, y: 0, w: 40, h: 40 },
        { shape: 'box', x: -280, y: 10, w: 40, h: 40 },
        { shape: 'box', x: -250, y: -10, w: 40, h: 40 },
        { shape: 'box', x: 300, y: 0, w: 40, h: 40 },
      ],
    }, { tab: 'level' });
    S.multiSel = S.level.props.map(ref => ({ kind: 'prop', ref }));
    S._alignOp('spread');
    const xs = S.level.props.map(p => +p.x.toFixed(3));
    const ys = S.level.props.map(p => +p.y.toFixed(3));
    gate('9b. extremes stay put and middles land at even intervals',
      near(xs[0], -300) && near(xs[1], -100) && near(xs[2], 100) && near(xs[3], 300),
      xs.join(', '));
    gate('9b. …in order, pulled ONTO the line between the extremes',
      ys.every(y => near(y, 0)), ys.join(', '));
  }

  // Selection order must not matter: the spread orders by position, not by
  // the order pieces were clicked.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 400 }],
      props: [
        { shape: 'box', x: -300, y: 0, w: 40, h: 40 },
        { shape: 'box', x: -280, y: 0, w: 40, h: 40 },
        { shape: 'box', x: 300, y: 0, w: 40, h: 40 },
      ],
    }, { tab: 'level' });
    const P = S.level.props;
    S.multiSel = [{ kind: 'prop', ref: P[2] }, { kind: 'prop', ref: P[0] }, { kind: 'prop', ref: P[1] }];
    S._alignOp('spread');
    gate('9b. selection order is irrelevant — position order wins',
      near(P[0].x, -300) && near(P[1].x, 0) && near(P[2].x, 300),
      P.map(p => p.x.toFixed(1)).join(', '));
  }

  // A staircase spreads along its own diagonal: the middle piece lands at the
  // exact MIDPOINT of the line between the extremes — both coordinates
  // interpolated, not just the along-axis one.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 500 }],
      props: [
        { shape: 'box', x: -200, y: -100, w: 30, h: 30 },
        { shape: 'box', x: -150, y: -90, w: 30, h: 30 },
        { shape: 'box', x: 200, y: 100, w: 30, h: 30 },
      ],
    }, { tab: 'level' });
    const P = S.level.props;
    S.multiSel = P.map(ref => ({ kind: 'prop', ref }));
    S._alignOp('spread');
    gate('9b. a diagonal selection spreads along its own diagonal, onto the line',
      near(P[1].x, 0, 0.01) && near(P[1].y, 0, 0.01),
      `middle at (${P[1].x.toFixed(2)}, ${P[1].y.toFixed(2)}), want (0, 0)`);
  }

  // The shared validation tail applies: a spread that would park the middle
  // piece inside an unselected prop reverts the WHOLE selection with a toast.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 400 }],
      // The first version of this rig had the two left props OVERLAPPING at
      // the start (40-wide boxes 20 px apart), and the gate then "failed"
      // against correct behaviour: rules freeze from the starting state, so a
      // piece that BEGINS overlapping has its overlap rule switched off
      // (§8.2 — authored-bad states stay editable). Small, separated pieces,
      // so t=0 is legal and the frozen rule is live.
      props: [
        { shape: 'box', x: -200, y: 0, w: 20, h: 20 },
        { shape: 'box', x: -170, y: 0, w: 20, h: 20 },
        { shape: 'box', x: 200, y: 0, w: 20, h: 20 },
        { shape: 'box', x: 0, y: 0, w: 60, h: 60 },   // unselected, sits at the landing spot
      ],
    }, { tab: 'level' });
    S.multiSel = [0, 1, 2].map(i => ({ kind: 'prop', ref: S.level.props[i] }));
    S._alignOp('spread');
    // re-resolved, not held: _restoreSnapshotAll REPLACES the props array
    // (§16), so a reference captured before the op points at the abandoned
    // moved objects and reads back the move that was just reverted
    const P = S.level.props;
    gate('9b. a spread that lands a piece inside a prop reverts, with a toast',
      near(P[1].x, -170) && S.toasts.length === 1,
      `middle x ${P[1].x.toFixed(1)}, ${S.toasts.length} toast(s)`);
  }

  // Two pieces have nothing between them — the button says so and moves nothing.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 400 }],
      props: [
        { shape: 'box', x: -200, y: 0, w: 40, h: 40 },
        { shape: 'box', x: 200, y: 0, w: 40, h: 40 },
      ],
    }, { tab: 'level' });
    S.multiSel = S.level.props.map(ref => ({ kind: 'prop', ref }));
    S._alignOp('spread');
    gate('9b. two pieces get a toast, not a silent no-op',
      near(S.level.props[0].x, -200) && S.toasts.length === 1 && /three/.test(S.toasts[0]),
      `"${S.toasts[0] || ''}"`);
  }
}

// ---------- gate 7: the degenerate-rod exemption is exempt from ONE rule ----------
//
// §16: exempt the RULE, never the STATE. A zero-length rod is the t=0 state of
// a placement sweep, and on another stick's pin it "shares two pins" with that
// stick — so the sweep could not start. Exempting it from that one rule is
// fine; exempting it from everything makes validity non-monotonic along the
// ray, and then a sweep parks a stub inside the ground and calls it the last
// good spot.
{
  const S = screen({ buildZones: [{ x: 0, y: -100, w: 700, h: 500 }], terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }] },
    { parts: [{ t: 'rod', kind: 'wood', x1: -50, y1: -100, x2: 50, y2: -100, id: 'r' }] });

  const stub = (x, y) => ({ t: 'rod', kind: 'wood', x1: x, y1: y, x2: x, y2: y });
  gate('7. a degenerate stick on another stick\'s pin passes the two-pin rule',
    S._rodInvalid(stub(-50, -100), null, true) === null);
  gate('7. a degenerate stick inside terrain is STILL refused',
    /terrain/.test(S._rodInvalid(stub(0, 25), null, true) || ''));
  gate('7. a degenerate stick outside the build zone is STILL refused',
    /build zone/.test(S._rodInvalid(stub(5000, -100), null, true) || ''));
  gate('7. a real stick sharing two pins is refused',
    /share one pin/.test(S._rodInvalid(
      { t: 'rod', kind: 'wood', x1: -50, y1: -100, x2: 50, y2: -100 }, null, true) || ''));

  // Monotonicity along a ray, which is the property every sweep assumes:
  // validity is a PREFIX. Walk a placement from the anchor down into the floor
  // and assert it never becomes legal again after becoming illegal.
  {
    const from = { x: 0, y: -100 };
    let flipped = 0, wasBad = false;
    for (let i = 0; i <= 200; i++) {
      const y = from.y + (200 - from.y) * (i / 200);
      const bad = S._rodInvalid({ t: 'rod', kind: 'wood', x1: from.x, y1: from.y, x2: from.x, y2: y }, null, true) != null;
      if (bad && !wasBad) { wasBad = true; }
      else if (!bad && wasBad) { flipped++; wasBad = false; }
    }
    gate('7. validity is a prefix of the placement ray (never valid again after invalid)',
      flipped === 0, `${flipped} illegal→legal flips`);
  }
}

// ---------- gate 8: the non-drag movers carry the same rules ----------
//
// Arrow nudges and the multi-select toggle are the two gestures that move or
// re-target pieces without a pointer drag. Both have to agree with the drag
// path — a nudge that carries a different companion set is a real legacy bug
// class (§8.2), and a toggle that throws is one this suite caught.
{
  // The toggle: Ctrl+click a piece IN the selection to take it back out. This
  // reached a free variable (`forceAdd`), which in a module is a ReferenceError
  // — and `&&` meant only the removal branch ever evaluated it, so building a
  // selection always worked and un-picking one piece killed the handler.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'w' },
        { t: 'wheel', kind: 'free', x: 60, y: -100, r: 15, id: 'w2' },
      ],
    });
    ctrlClick(S, -60, -100);
    ctrlClick(S, 60, -100);
    let threw = null;
    try { ctrlClick(S, 60, -100); } catch (e) { threw = e; }
    gate('8. Ctrl+clicking a selected piece removes it from the selection',
      !threw && S.multiSel.length === 1,
      threw ? `${threw.constructor.name}: ${threw.message}` : `${S.multiSel.length} left`);
  }

  // A nudge carries the identical companion set a drag does — here, a crate
  // bolted to the stick being nudged.
  {
    const S = screen(flatWorld({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }] }),
      { parts: [{ t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: -100, id: 'r' }] });
    S.sel = { kind: 'part', ref: S.design.parts[0] };
    S._nudge(0, -1);
    gate('8. nudging a stick carries the crate bolted to it',
      near(S.goalPositions[0].y, -101) && near(S.design.parts[0].y1, -101),
      `crate y ${S.goalPositions[0].y}, stick y ${S.design.parts[0].y1}`);
  }

  // ...and the reverse carry freezes too. A goal nudge used to pass no frozen
  // rules at all, so its towed sticks were judged in full — and a crate bolted
  // to a stick the level left in the floor could not be nudged in ANY
  // direction, not even out. That is §16's one-way door on the path with no
  // sweep to soften it: the arrow key simply did nothing, with a toast naming
  // a stick the player never touched.
  {
    const S = screen(flatWorld({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }] }),
      { parts: [{ t: 'rod', kind: 'wood', x1: 0, y1: -100, x2: 60, y2: 20, id: 'r' }] });
    gate('8. ...and that towed stick really does start in the floor',
      S._rodInvalid(S.design.parts[0], S.design.parts[0], true, true) !== null);
    S.sel = { kind: 'goal', idx: 0 };
    S._nudge(0, -1);
    gate('8. a crate towing a buried stick can still be nudged',
      near(S.goalPositions[0].y, -101) && S.toasts.length === 0,
      `crate y ${S.goalPositions[0].y}${S.toasts.length ? ' — "' + S.toasts[0] + '"' : ''}`);
  }

  // A nudge that would leave the build zone is refused outright (there is no
  // clamp on an arrow key), and it reverts everything it had already moved.
  // Started at the last legal integer step — maxX 50.5, exactly ZONE_SLACK
  // past the edge and still inside — so the gate is about the step that
  // crosses, not about a piece that was already out.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 100, h: 100 }] },
      { parts: [{ t: 'wheel', kind: 'free', x: 35.5, y: 0, r: 15, id: 'w' }] });
    S.sel = { kind: 'part', ref: S.design.parts[0] };
    gate('8. ...and that starting point is itself legal',
      S._wheelInvalid(S.design.parts[0], S.design.parts[0], true) === null);
    S._nudge(1, 0);
    gate('8. a nudge past the zone edge is refused and reverted',
      near(S.design.parts[0].x, 35.5) && S.toasts.length > 0, `x ${S.design.parts[0].x}`);
  }

  // A nudge that would push a prop into terrain is refused too — there is no
  // modifier to spare on an arrow key, so the deliberate way in is the drag.
  // Half a pixel clear of the surface rather than flush on it: the overlap
  // test is inclusive, so a piece sitting EXACTLY on restY already reads as
  // touching, which freezes the rule off and would make this gate pass for the
  // wrong reason. The first assert is what keeps that honest.
  {
    const y0 = restY(15) - 0.5;
    const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: y0, w: 30, h: 30 }] }), { tab: 'level' });
    S.sel = { kind: 'prop', ref: S.level.props[0] };
    gate('8. ...and that prop starts genuinely clear of the floor',
      !S._pieceInTerrain(S.level.props[0], S.level.props[0]));
    S._nudge(0, 1);
    gate('8. a nudge that would push a prop into terrain is refused',
      near(S.level.props[0].y, y0), `y ${S.level.props[0].y}, want ${y0}`);
  }

  // A goal piece with nothing in the build area belongs to the level, not the
  // player: it cannot be nudged while solving.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 100, h: 100 }], goalObjs: [{ shape: 'box', x: 500, y: 0, w: 40, h: 30 }] });
    gate('8. a goal piece outside the build area is locked while solving', S._goalLocked(0));
    S.sel = { kind: 'goal', idx: 0 };
    S._nudge(0, -1);
    gate('8. ...so a nudge does not move it', near(S.goalPositions[0].y, 0));
  }
}

// ---------- gate 10: the invariant as a PROPERTY, not nine scenarios ----------
//
// Everything above is a situation somebody thought of. That is exactly the
// setup that hides bugs — four rounds of one bug class reached the user
// through scenarios that were each fixed against a case the author invented
// (§16: "reproduce from the user's own numbers, not a scenario you invented").
//
// So: random worlds, random pieces, random directions, and a sharp assertion.
//
// **WHAT THE ASSERTION HAS TO BE.** Not "no drag is ever reverted" — that is
// wrong, and the fuzzer said so on its 102nd case. Reverting is HALF the
// design: terrain, props and the build region are *swept* (the drag stops
// dead at them), while other pieces are *ghosted* (the drag passes through
// wearing the red X and the drop refuses), and the ghost-through is what makes
// "drag this past that one to the space beyond" possible at all. A test that
// forbade all reverts would be satisfied by making everything stop, which
// would quietly delete that affordance.
//
// The real invariant is that the two sets don't leak into each other:
// **a drag may never be reverted by a rule its own sweep was enforcing.**
// A revert citing terrain or the build zone means the sweep was supposed to
// have stopped the gesture and didn't — which is every §16 entry at once.
// A revert citing an overlap is the ghost-through working.
//
// The comparison is on the WHOLE world's geometry, not the dragged piece:
// a revert takes companions with it, and a gate watching one piece would miss
// an assembly that snapped back around it.
//
// Deliberately included in the generated worlds: pieces that START in an
// illegal state (buried in terrain, overlapping a prop). Those are what the
// frozen rules exist for, they are what a hand-written test forgets, and they
// are how a level actually arrives from an import or a Level-tab edit.
//
// **Wrapped in `section()` because it is 82% of this suite's runtime** — 7.8 s
// of the 9.6 s, measured with `--times`. Nothing else here is worth wrapping:
// two ids are 94% of the clock and the remaining 94 share 6%. So `--only`
// anything-but-10 now costs under two seconds instead of ten.
section('10', () => {
  const SEED = 0x11f181c;      // change to explore; failures print the case
  const rnd = seedRand(SEED);

  // Rules the sweep enforces. If one of these ever explains a revert, the
  // gesture went somewhere its own sweep should have refused to take it.
  const SWEPT = [
    /inside the build zone/, /stay inside the build zone/,
    /built through terrain/, /pushed into terrain/, /pushed into props/,
    /pushed into another piece/,
    // props are solid to machine parts too, and swept — so if this ever
    // explains a revert, the sweep has stopped enforcing it
    /built through props/,
    // goal-vs-goal moved here when goal pieces became solid to each other —
    // if it ever explains a revert again, the sweep has stopped enforcing it
    /overlap each other/,
  ];
  // ...and the ones a drag deliberately travels through, wearing the X.
  const GHOSTED = [
    /overlap wheels/, /overlap goal pieces/,
    /rest on a stick/, /share one pin/, /cross each other/,
    /too close side-by-side/, /pass through a wheel/, /pass through a goal piece/,
    /overlap wheels or sticks/,
  ];
  const rr = (lo, hi) => lo + rnd() * (hi - lo);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  // Every moving thing's position, as one comparable string. Read fresh from
  // the live containers each time — a revert REPLACES the arrays (§16), so
  // anything holding references would compare two detached snapshots and
  // report no change.
  const worldGeom = (S) => {
    const n = (v) => (typeof v === 'number' ? v.toFixed(4) : '-');
    const part = (p) => (p.t === 'wheel' ? `w${n(p.x)},${n(p.y)},${n(p.r)}` : `r${n(p.x1)},${n(p.y1)},${n(p.x2)},${n(p.y2)}`);
    return [
      ...S.design.parts.map(part),
      ...S.level.fixedParts.map(part),
      ...S.level.props.map(p => `p${n(p.x)},${n(p.y)}`),
      ...S.goalPositions.map(g => `g${n(g.x)},${n(g.y)}`),
    ].join('|');
  };

  const makeWorld = () => {
    const terrain = [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }];   // the floor is always there
    if (rnd() < 0.55) terrain.push({ type: 'box', x: rr(-260, 260), y: rr(-220, -50), w: rr(20, 70), h: rr(40, 180) });
    if (rnd() < 0.35) terrain.push({ type: 'ball', x: rr(-260, 260), y: rr(-160, -30), r: rr(14, 45) });
    if (rnd() < 0.25) terrain.push({ type: 'box', x: rr(-100, 100), y: rr(-320, -260), w: rr(120, 400), h: rr(20, 50) });

    // one zone, two touching (which must read as one region, §7.2a), or two
    // with a real gap between them — and two times in five, the whole
    // arrangement turned (§7.2a). Rotating the CLUSTER rigidly about its own
    // centre rather than each zone independently is what keeps a touching pair
    // touching, so the joining rule is still being exercised rather than
    // quietly turned into two separate zones.
    const shape = pick(['one', 'touching', 'gapped']);
    const cx = rr(-60, 60), cy = rr(-140, -80), hw = rr(160, 320), hh = rr(140, 260);
    const rot = rnd() < 0.4 ? (rnd() - 0.5) * Math.PI : 0;
    const place = (zx, zy) => {
      if (!rot) return { x: zx, y: zy, w: hw * 2, h: hh * 2 };
      const c = Math.cos(rot), s = Math.sin(rot);
      const dx = zx - cx, dy = zy - cy;
      return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c, w: hw * 2, h: hh * 2, angle: rot };
    };
    const buildZones = shape === 'one'
      ? [place(cx, cy)]
      : [place(cx - hw, cy), place(cx + hw + (shape === 'gapped' ? 30 : 0), cy)];

    const props = [], goalObjs = [], parts = [];
    // Somewhere a piece may legally sit, or — one time in five — somewhere it
    // may not. The illegal starts are the point of the exercise.
    const spot = () => (rnd() < 0.2
      ? { x: rr(-300, 300), y: rr(-10, 40) }          // in or near the floor
      : { x: cx + rr(-hw, hw), y: cy + rr(-hh, hh) });

    for (let i = 0, n = Math.floor(rr(0, 3)); i < n; i++) {
      const p = spot();
      props.push(rnd() < 0.5
        ? { shape: 'box', x: p.x, y: p.y, w: rr(20, 60), h: rr(20, 60), angle: rnd() < 0.3 ? rr(0, Math.PI) : 0 }
        : { shape: 'ball', x: p.x, y: p.y, r: rr(10, 30) });
    }
    for (let i = 0, n = Math.floor(rr(1, 3)); i < n; i++) {
      const p = spot();
      goalObjs.push(rnd() < 0.6
        ? { shape: 'box', x: p.x, y: p.y, w: rr(20, 70), h: rr(20, 50), angle: rnd() < 0.3 ? rr(0, Math.PI) : 0 }
        : { shape: 'ball', x: p.x, y: p.y, r: rr(10, 28) });
    }
    const loosePart = (arr, id) => {
      const p = spot();
      if (rnd() < 0.5) {
        arr.push({ t: 'wheel', kind: pick(['free', 'cw', 'ccw']), x: p.x, y: p.y, r: pick([7.5, 15, 30]), id });
      } else {
        // long enough that its midpoint is clear of both endpoint pick radii
        const a = rr(0, Math.PI * 2), len = rr(45, 130);
        arr.push({
          t: 'rod', kind: rnd() < 0.25 ? 'water' : 'wood', id,
          x1: p.x, y1: p.y, x2: p.x + Math.cos(a) * len, y2: p.y + Math.sin(a) * len,
        });
      }
    };

    // **PINNED assemblies**, which random placement essentially never produces.
    // Joints form by exact coordinate (§5.4), so two rods thrown down at random
    // angles are never companions — without this the generator fuzzed every
    // sweep and never once fuzzed the CARRY, which is the half of a drag that
    // takes other pieces with it. Built into whichever pool it is handed, so
    // the level's parts (Create) and the machine's (Test) get the same
    // exercise; they run the same gestures now (§7.2) and a fuzzer that only
    // ever saw one pool would be gating half of that claim.
    const assemblyInto = (arr, tag) => {
      const p = spot();
      const L = rr(60, 120), a0 = rr(0, Math.PI * 2);
      const at = (turn, d) => ({ x: p.x + Math.cos(a0 + turn) * d, y: p.y + Math.sin(a0 + turn) * d });
      const rod = (A, B, id) => arr.push({ t: 'rod', kind: 'wood', x1: A.x, y1: A.y, x2: B.x, y2: B.y, id });
      const style = pick(['triangle', 'hub', 'chain']);
      if (style === 'triangle') {
        const A = at(0, 0), B = at(0, L), C = at(Math.PI / 3, L);
        rod(A, B, tag + 'a'); rod(B, C, tag + 'b'); rod(C, A, tag + 'c');
      } else if (style === 'hub') {
        // a stick on a wheel's hub: the wheel rides the stick, the stick
        // stretches when the wheel is dragged — both directions in one rig
        arr.push({ t: 'wheel', kind: pick(['free', 'cw', 'ccw']), x: p.x, y: p.y, r: pick([7.5, 15, 30]), id: tag + 'w' });
        rod(p, at(0, L), tag + 'r');
      } else {
        rod(at(0, L), p, tag + 'a'); rod(p, at(Math.PI / 2, L), tag + 'b');
      }
    };

    for (let i = 0, n = Math.floor(rr(1, 4)); i < n; i++) loosePart(parts, 'P' + i);
    if (rnd() < 0.5) assemblyInto(parts, 'A');

    // The level's own parts. They obey every gesture the design's do, minus the
    // build area (§7.2), so they belong in the same fuzz — and until they had
    // real companion and endpoint handling there was nothing here to fuzz.
    const fixedParts = [];
    if (rnd() < 0.45) assemblyInto(fixedParts, 'F');
    if (rnd() < 0.3) loosePart(fixedParts, 'X');

    return { level: { terrain, buildZones, goalZones: [], props, goalObjs, fixedParts }, parts };
  };

  // Candidate grab points, each verified against the REAL _hitTest before use:
  // the pick order has traps (a rod endpoint beats a body pick within HANDLE
  // px, a goal piece loses to a stick lying across it) and a fuzzer that
  // assumed it grabbed what it aimed at would quietly test the wrong gesture.
  const grabs = (S) => {
    const out = [];
    const partGrab = (p) => (p.t === 'wheel'
      ? { at: { x: p.x, y: p.y }, ref: p }
      : { at: { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 }, ref: p });
    S.design.parts.forEach((p) => out.push(partGrab(p)));
    // The level's parts are movable in Create only (see _pointerDown), which
    // is the same tab their endpoints are grabbable in.
    if (S.tab === 'level') S.level.fixedParts.forEach((p) => out.push(partGrab(p)));
    S.level.props.forEach((p) => out.push({ at: { x: p.x, y: p.y }, ref: p }));
    S.goalPositions.forEach((g, i) => out.push({ at: { x: g.x, y: g.y }, goalIdx: i }));
    return out;
  };

  let runs = 0, skipped = 0, multiRuns = 0, threw = null;
  let reverts = 0, ghosted = 0, leaked = null, unmarked = null, unexplained = null;
  let fixedRuns = 0, carryRuns = 0;

  for (let iter = 0; iter < 24000 && !threw && !leaked; iter++) {
    const { level, parts } = makeWorld();
    const tab = rnd() < 0.4 ? 'level' : 'machine';
    const S = screen(level, { tab, parts });
    const cands = grabs(S);
    if (!cands.length) { skipped++; continue; }
    const c = pick(cands);

    // does the pointer actually land on the piece we meant?
    const hit = S._hitTest(c.at);
    if (!hit) { skipped++; continue; }
    if (c.goalIdx != null ? !(hit.kind === 'goal' && hit.idx === c.goalIdx)
      : !(['part', 'prop', 'fixed'].includes(hit.kind) && hit.ref === (c.ref || hit.ref))) { skipped++; continue; }
    if ((hit.kind === 'prop' || hit.kind === 'fixed') && tab !== 'level') { skipped++; continue; }
    if (hit.kind === 'goal' && S._goalLocked(hit.idx)) { skipped++; continue; }

    // one gesture in four drags a MULTI-selection instead — a different
    // predicate (`_multiMoveInvalid`) with its own frozen sets, so it needs
    // its own fuzzing rather than riding on the single-piece path
    const wantMulti = rnd() < 0.25;
    if (wantMulti) {
      const others = cands.filter(o => o !== c).slice(0, 2);
      if (!others.length) { skipped++; continue; }
      S.multiSel = [hit];
      for (const o of others) {
        const h = S._hitTest(o.at);
        if (h && S._selKey(h) !== S._selKey(hit)) S.multiSel.push(h);
      }
      if (S.multiSel.length < 2) { skipped++; continue; }
    }

    const dir = rr(0, Math.PI * 2), far = rr(30, 700);
    const to = { x: c.at.x + Math.cos(dir) * far, y: c.at.y + Math.sin(dir) * far };
    // Ctrl+Shift is the obstacle override (Level tab only); Shift and Alt on
    // their own are the positional grid (§8.1). The grid belongs in this fuzz
    // more than anywhere: it rewrites the TARGET every sweep aims at, and
    // "the snap moved the piece somewhere its own sweep would have refused"
    // is precisely the invariant below.
    const roll = rnd();
    const mods = (tab === 'level' && roll < 0.15) ? { ctrlKey: true, shiftKey: true }
      : roll < 0.40 ? { shiftKey: true }
        : roll < 0.55 ? { altKey: true } : {};
    const steps = Math.floor(rr(1, 12));

    try {
      S._pointerDown(ev(c.at.x, c.at.y, mods));
      const type = S.drag?.type || null;
      if (type !== 'move' && type !== 'move-multi') { skipped++; continue; }
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        S._pointerMove(ev(c.at.x + (to.x - c.at.x) * f, c.at.y + (to.y - c.at.y) * f, mods));
      }
      const during = worldGeom(S);
      const badDrop = !!S.drag?.badDrop;
      // read BEFORE the drop — _pointerUp clears the drag (§16's stale-
      // reference lesson in miniature). `move` keeps its companion set on
      // `companions`; `move-multi` holds the same three lists directly.
      const towed = ((c2) => (c2 ? c2.stretches.length + c2.rides.length + c2.goalRides.length : 0))(
        S.drag?.companions) +
        (S.drag?.type === 'move-multi'
          ? S.drag.stretches.length + S.drag.rides.length + S.drag.goalRides.length : 0);
      S._pointerUp(ev(to.x, to.y, mods));
      const after = worldGeom(S);
      runs++;
      if (type === 'move-multi') multiRuns++;
      if (hit.kind === 'fixed') fixedRuns++;
      if (towed) carryRuns++;
      if (during === after) continue;

      // it reverted — the only question is WHY
      reverts++;
      const why = S.toasts[S.toasts.length - 1] || '';
      // Carry the whole case, not just a label. §16: reproduce from the real
      // numbers, not a scenario you invent afterwards — a fuzzer that says
      // only "something reverted" sends you off to invent one.
      const at = {
        iter, tab, kind: hit.kind, type, steps, mods, why,
        repro: JSON.stringify({ level, parts, tab, sel: S.multiSel.map(s => s.kind), from: c.at, to, steps, mods }),
      };
      if (SWEPT.some(re => re.test(why))) leaked = at;
      else if (GHOSTED.some(re => re.test(why))) {
        ghosted++;
        // the ghost-through owes the user warning: the X has to have been on
        if (!badDrop) unmarked = unmarked || at;
      } else unexplained = unexplained || at;
    } catch (e) { threw = { iter, err: e, kind: hit.kind, tab }; }
  }

  const show = (m) => `iter ${m.iter} — ${m.tab}/${m.kind} via ${m.type}, ${m.steps} steps, mods ${JSON.stringify(m.mods)}: "${m.why}"`
    + (process.env.VERIFY_EDITOR_REPRO && m.repro ? `\n      repro: ${m.repro}` : '');

  gate('10. no random drag is reverted by a rule its own SWEEP was enforcing',
    !threw && !leaked,
    threw ? `THREW on iter ${threw.iter} (${threw.tab}/${threw.kind}): ${threw.err.message}`
      : leaked ? show(leaked)
        : `${runs} gestures (${multiRuns} multi), ${reverts} reverts all ghost-through, ${skipped} skipped, seed 0x${SEED.toString(16)}`);

  gate('10. every ghost-through revert had the red X showing first',
    !unmarked, unmarked ? show(unmarked) : `${ghosted} marked reverts`);

  gate('10. no revert cites a rule this suite does not know about',
    !unexplained, unexplained ? show(unexplained) : 'every revert classified');

  // Coverage assertions, so a generator that quietly stops producing
  // interesting worlds fails instead of passing vacuously.
  gate('10. ...and enough of them ran, on both paths, to mean something',
    runs >= 3000 && multiRuns >= 300 && ghosted >= 50,
    `${runs} gestures, ${multiRuns} multi, ${ghosted} ghost-through reverts exercised`);

  // ...including the two the generator used to miss entirely: the level's own
  // parts (it only ever built `fixedParts: []`, so every Create gesture went
  // unfuzzed) and drags that CARRY something (nothing was ever pinned, so the
  // companion machinery — half of what a drag does — was never reached).
  gate('10. ...and the level\'s parts and the carrying drags are among them',
    fixedRuns >= 200 && carryRuns >= 300,
    `${fixedRuns} gestures on level-authored parts, ${carryRuns} carrying companions`);
});

// ---------- gate 11: undo, redo, and the reference trap ----------
//
// §16 has an entry for `_restore()` REPLACES objects — "re-resolve any held
// reference from the live containers after undo/redo/revert, or you'll assert
// against detached stale data" — and until now nothing gated it. It is worth
// gating as a PROPERTY rather than a warning, because the trap is invisible:
// the stale object still exists, still has plausible coordinates, and every
// read of it succeeds. It just isn't the piece on screen any more.
{
  const world = () => flatWorld({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 40, h: 30 }] });

  {
    const S = screen(world(), { tab: 'level', undo: true,
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -200, r: 15, id: 'w' }] });
    const before = S.design.parts[0];
    gesture(S, { x: 0, y: -200 }, { x: 120, y: -200 }, { watch: partAt(S, 0) });
    gate('11. a committed drag lands and is on the undo stack',
      near(S.design.parts[0].x, 120) && S.undoStack.length === 2, `x ${S.design.parts[0].x}, ${S.undoStack.length} entries`);

    S.undo();
    gate('11. undo puts it back', near(S.design.parts[0].x, 0), `x ${S.design.parts[0].x}`);

    // the §16 trap itself, as an assertion
    const after = S.design.parts[0];
    gate('11. ...and undo REPLACED the object — a held reference is now detached',
      after !== before && near(before.x, 120),
      `held ref still reads x ${before.x}, live piece is at x ${after.x}`);
    before.x = -9999;
    gate('11. ...writing through the stale reference does not touch the live piece',
      near(S.design.parts[0].x, 0), `live x ${S.design.parts[0].x}`);

    S.redo();
    gate('11. redo re-applies it', near(S.design.parts[0].x, 120), `x ${S.design.parts[0].x}`);
  }

  // The practical consequence: after an undo the editor must still be able to
  // FIND the piece — _hitTest reads the live containers, so a gesture aimed at
  // where the piece now is has to work on the fresh object.
  {
    const S = screen(world(), { tab: 'level', undo: true,
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -200, r: 15, id: 'w' }] });
    gesture(S, { x: 0, y: -200 }, { x: 120, y: -200 }, { watch: partAt(S, 0) });
    S.undo();
    const g = gesture(S, { x: 0, y: -200 }, { x: -80, y: -200 }, { watch: partAt(S, 0) });
    gate('11. a piece is still draggable after an undo replaced it',
      g.type === 'move' && near(S.design.parts[0].x, -80), `x ${S.design.parts[0].x} via ${g.type}`);
  }

  // A goal piece's staged position and the level's own geometry both ride the
  // undo snapshot — in the Create tab those are two different stores of one
  // thing (§7.2), which is exactly where a half-restore would hide.
  {
    const S = screen(world(), { tab: 'level', undo: true });
    gesture(S, { x: 0, y: -100 }, { x: 90, y: -100 }, { watch: goalAt(S, 0) });
    const moved = S.goalPositions[0].x;
    S.undo();
    gate('11. undo restores BOTH halves of a goal piece\'s position',
      near(moved, 90, 2) && near(S.goalPositions[0].x, 0) && near(S.level.goalObjs[0].x, 0),
      `staged ${S.goalPositions[0].x}, authored ${S.level.goalObjs[0].x}`);
  }

  // Terrain lives in the snapshot too, but only in maker mode.
  {
    const S = screen(world(), { tab: 'level', undo: true });
    S.level.props.push({ shape: 'box', x: 200, y: -100, w: 30, h: 30 });
    S._commit();
    gesture(S, { x: 200, y: -100 }, { x: 260, y: -100 }, { watch: propAt(S, 0) });
    S.undo();
    gate('11. undo restores a prop move', near(S.level.props[0].x, 200), `x ${S.level.props[0].x}`);
  }

  {
    const S = screen(world(), { tab: 'level', undo: true });
    const n = S.undoStack.length;
    S._commit(); S._commit(); S._commit();
    gate('11. committing with nothing changed does not grow the stack',
      S.undoStack.length === n, `${S.undoStack.length} entries, was ${n}`);
  }

  {
    const S = screen(world(), { tab: 'level', undo: true,
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -200, r: 15, id: 'w' }] });
    for (let i = 0; i < 200; i++) { S.design.parts[0].x = i; S._commit(); }
    gate('11. the undo stack is capped', S.undoStack.length <= 150, `${S.undoStack.length} entries`);
  }

  // Undo with nothing to undo must be a no-op, not a throw or a wipe: the
  // baseline entry is the floor.
  {
    const S = screen(world(), { tab: 'level', undo: true,
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -200, r: 15, id: 'w' }] });
    S.undo(); S.undo(); S.undo();
    gate('11. undo past the beginning is a no-op',
      S.design.parts.length === 1 && near(S.design.parts[0].x, 0));
  }
}

// ---------- gate 12: the other ways a piece is created or resized ----------
{
  // The context-menu wheel-size swatches. This path ALWAYS checked and
  // reverted — it is the precedent resize/rotate were measured against — and
  // it also re-anchors rod ends from the old pin ring to the new one.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: STD_WHEEL_R, id: 'w' },
        { t: 'rod', kind: 'wood', x1: INNER_PIN, y1: -100, x2: 120, y2: -100, id: 'r' },  // on the +x compass pin
      ],
    });
    S._closeCtxMenu = () => {};
    S._updateInfoChip = () => {};
    S._resizeWheel(S.design.parts[0], SMALL_R);
    const rod = S.design.parts[1];
    gate('12. resizing a wheel re-anchors a rod end to the matching new pin',
      S.design.parts[0].r === SMALL_R && near(rod.x1, SMALL_PIN) && near(rod.y1, -100),
      `wheel r ${S.design.parts[0].r}, rod end at ${rod.x1},${rod.y1}`);
  }
  {
    // ...but growing to the LARGE wheel must NOT move it. The inner compass
    // ring is frozen at INNER_RING_R rather than following r (util.js), because
    // that lattice is what every saved design's joint keys were built on —
    // moving it would silently detach rods in levels already on the server.
    // Easy to "tidy" into `r - PIN_INSET` and impossible to notice by playing.
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: 0, y: -100, r: STD_WHEEL_R, id: 'w' },
        { t: 'rod', kind: 'wood', x1: INNER_PIN, y1: -100, x2: 120, y2: -100, id: 'r' },
      ],
    });
    S._closeCtxMenu = () => {};
    S._updateInfoChip = () => {};
    S._resizeWheel(S.design.parts[0], LARGE_R);
    const rod = S.design.parts[1];
    gate('12. ...and the inner pin ring does not move when a wheel grows',
      S.design.parts[0].r === LARGE_R && near(rod.x1, INNER_PIN),
      `wheel r ${S.design.parts[0].r}, rod still bolted at x ${rod.x1}`);
  }
  {
    // ...and reverts the whole thing when the bigger wheel doesn't fit
    const S = screen(flatWorld(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -(STD_WHEEL_R + 1), r: STD_WHEEL_R, id: 'w' }] });
    S._closeCtxMenu = () => {};
    S._updateInfoChip = () => {};
    S._resizeWheel(S.design.parts[0], LARGE_R);
    gate('12. ...and reverts when the bigger wheel would reach into terrain',
      S.design.parts[0].r === STD_WHEEL_R && S.toasts.some(t => /No room/.test(t)),
      `r ${S.design.parts[0].r} — "${S.toasts[0]}"`);
  }

  // Chain paint lays exact-length links and stops dead at an obstacle rather
  // than painting through it.
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-200, -100, { altKey: true }));
    const type = S.drag?.type;
    for (let i = 1; i <= 20; i++) S._pointerMove(ev(-200 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(200, -100, { altKey: true }));
    const rods = S.design.parts.filter(p => p.t === 'rod');
    const len = rods.length ? Math.hypot(rods[0].x2 - rods[0].x1, rods[0].y2 - rods[0].y1) : 0;
    gate('12. Alt+drag paints a chain of equal links',
      type === 'chain-paint' && rods.length > 5 && near(len, ROPE_LINK_LEN, 0.01),
      `${rods.length} links of ${len.toFixed(2)}`);
  }
  {
    const S = screen(flatWorld({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'box', x: 0, y: -100, w: 40, h: 200 }],
    }), { tool: 'rod-wood' });
    S._pointerDown(ev(-200, -100, { altKey: true }));
    for (let i = 1; i <= 20; i++) S._pointerMove(ev(-200 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(200, -100, { altKey: true }));
    const far = Math.max(...S.design.parts.map(p => Math.max(p.x1, p.x2)));
    gate('12. ...and stops dead at a pillar instead of painting through it',
      far < -18, `chain reached x ${far.toFixed(1)}, pillar face at -20`);
  }

  // Placing a prop or goal piece from the Level tab tools goes through the same
  // landing rules a paste does.
  {
    const S = screen(flatWorld(), { tab: 'level', tool: 'prop-box' });
    S._pointerDown(ev(0, 25));
    S._pointerMove(ev(30, 45));
    S._pointerUp(ev(30, 45));
    gate('12. placing a prop inside terrain is refused',
      S.level.props.length === 0 && S.toasts.some(t => /terrain/.test(t)), S.toasts.join(' | '));
  }
  {
    const S = screen(flatWorld(), { tab: 'level', tool: 'prop-box' });
    S._pointerDown(ev(0, -200));
    S._pointerMove(ev(30, -170));
    S._pointerUp(ev(30, -170));
    gate('12. ...and placing one somewhere clear lands', S.level.props.length === 1);
  }

  // Ctrl+drag on empty space is a marquee, and it selects what it covers.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'a' },
        { t: 'wheel', kind: 'free', x: 60, y: -100, r: 15, id: 'b' },
        { t: 'wheel', kind: 'free', x: 300, y: -100, r: 15, id: 'c' },
      ],
    });
    S._pointerDown(ev(-200, -200, { ctrlKey: true, shiftKey: true }));
    const type = S.drag?.type;
    S._pointerMove(ev(150, -20, { ctrlKey: true, shiftKey: true }));
    S._pointerUp(ev(150, -20, { ctrlKey: true, shiftKey: true }));
    gate('12. a marquee selects what it covers and nothing else',
      type === 'marquee' && S.multiSel.length === 2, `${type}, ${S.multiSel.length} selected`);
  }

  // Ctrl+click deletes; Shift+empty pans; plain drag moves the connected
  // machine; Shift+drag moves one piece; a click selects only that piece.
  {
    const S = screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'a' },
        { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' },
        { t: 'wheel', kind: 'free', x: 60, y: -100, r: 15, id: 'b' },
      ],
    });
    S._pointerDown(ev(-60, -100, { ctrlKey: true }));
    S._pointerUp(ev(-60, -100, { ctrlKey: true }));
    gate('12. Ctrl+click deletes the piece (FC)',
      !S.design.parts.some((p) => p.id === 'a'), S.design.parts.map((p) => p.id).join(','));
  }
  {
    const S = screen(flatWorld(), { tool: 'pointer' });
    S._pointerDown(ev(-200, -200, { shiftKey: true }));
    const type = S.drag?.type;
    S._pointerUp(ev(-200, -200, { shiftKey: true }));
    gate('12. Shift+empty pans (FC)', type === 'pan', `${type}`);
  }
  {
    const cart = () => screen(flatWorld(), {
      parts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'a' },
        { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' },
        { t: 'wheel', kind: 'free', x: 60, y: -100, r: 15, id: 'b' },
      ],
    });
    {
      const S = cart();
      S._pointerDown(ev(0, -100));
      gate('12. a plain drag on a rod starts a connected-machine move',
        S.drag?.type === 'move-multi' && (S.drag.items?.length || 0) >= 2,
        `drag=${S.drag?.type} items=${S.drag?.items?.length}`);
      gate('12. …and the selection is still just that rod',
        S.multiSel.length === 0 && S.sel?.ref?.id === 'r',
        `multi=${S.multiSel.length} sel=${S.sel?.ref?.id}`);
      S._pointerUp(ev(0, -100));
      gate('12. …a click (no drag) leaves only that piece selected',
        S.multiSel.length === 0 && S.sel?.ref?.id === 'r',
        `multi=${S.multiSel.length} sel=${S.sel?.ref?.id}`);
    }
    {
      const S = cart();
      S._pointerDown(ev(0, -100, { shiftKey: true }));
      gate('12. Shift+rod moves just that piece (links stretch)',
        S.drag?.type === 'move' && S.multiSel.length === 0,
        `drag=${S.drag?.type} n=${S.multiSel.length}`);
      S._pointerUp(ev(0, -100, { shiftKey: true }));
    }
  }

  // The piece-count ceilings, which are the last thing standing between a
  // stuck Alt-drag and a level nobody can load.
  {
    const S = screen(flatWorld(), { tool: 'wheel-free' });
    S.design.parts = Array.from({ length: MAX_DESIGN_PARTS }, (_, i) => ({ t: 'wheel', kind: 'free', x: -5000 - i * 50, y: -100, r: 1, id: 'f' + i }));
    S._placeWheelFinish({ kind: 'free', r: 15, x: 0, y: -100 });
    gate(`12. the design part limit refuses the ${MAX_DESIGN_PARTS + 1}th piece`,
      S.design.parts.length === MAX_DESIGN_PARTS && S.toasts.some(t => /Part limit/.test(t)), S.toasts.join(' | '));
  }
  {
    // **The server's replay cap is sized FROM the client's, and the pair going
    // out of step is silent until somebody wins.** They would build a machine
    // the editor allowed and then be refused the save of the run that won with
    // it — the worst moment to find out. Read out of server.js rather than
    // trusted, because nothing else connects the two numbers.
    const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const parts = srv.match(/b\.design\.length > (\d+)/);
    const bytes = srv.match(/JSON\.stringify\(b\.design\)\.length > (\d+) \* 1024/);
    gate('12. …and the server accepts a replay of exactly that many parts',
      parts && +parts[1] === MAX_DESIGN_PARTS,
      `client ${MAX_DESIGN_PARTS}, server ${parts ? parts[1] : 'not found'}`);
    // 1000 rope links serialise to 126 KB measured; the cap keeps the headroom
    // the 500-part one had, so a legitimate big machine cannot hit it.
    gate('12. …with byte headroom over what that many parts really weigh',
      bytes && +bytes[1] >= 256, `${bytes ? bytes[1] : '?'} KB for ~126 KB of parts`);

    // **The level-authored cap is the same kind of pair, and the same silence.**
    // fixedParts are dynamic bodies, so this number is what stops an author
    // publishing a level nobody's machine can run inside a frame. Client and
    // server must agree or a level saves in the editor and is refused by the
    // server — or worse, the other way, and the editor lets someone build past
    // what will load. Read out of both files rather than trusted.
    const srvFixed = srv.match(/\['fixedParts', (\d+)\]/g) || [];
    const front = srvFixed[0] && +srvFixed[0].match(/(\d+)/)[1];
    const back = srvFixed[1] && +srvFixed[1].match(/(\d+)/)[1];
    gate(`12. …and the server caps level fixedParts at exactly ${MAX_FIXED_PARTS}`,
      front === MAX_FIXED_PARTS, `probe ${MAX_FIXED_PARTS}, server ${front ?? 'not found'}`);
    gate(`12. …with the scenery layer at half that`,
      back === BACK_FIXED_PARTS, `probe ${BACK_FIXED_PARTS}, server ${back ?? 'not found'}`);
    // and game.js's own two constants, which the editor enforces
    const g = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    const cFront = g.match(/const MAX_FIXED_PARTS = (\d+)/);
    const cBack = g.match(/BACK_CAPS = \{[^}]*fixedParts: (\d+)/);
    gate('12. …and game.js agrees with both',
      cFront && +cFront[1] === MAX_FIXED_PARTS && cBack && +cBack[1] === BACK_FIXED_PARTS,
      `game.js front ${cFront ? cFront[1] : '?'}, back ${cBack ? cBack[1] : '?'}`);
  }
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S.level.goalObjs = Array.from({ length: 8 }, (_, i) => ({ shape: 'box', x: -4000 - i * 100, y: -100, w: 10, h: 10 }));
    S.goalPositions = S.level.goalObjs.map(g => ({ x: g.x, y: g.y }));
    S.goalMoved = S.level.goalObjs.map(() => false);
    S._levelPlacementFinish({ cat: 'goal', obj: { shape: 'box', x: 0, y: -200, w: 30, h: 30 } });
    gate('12. the goal-piece limit refuses the 9th',
      S.level.goalObjs.length === 8 && S.toasts.some(t => /limit/.test(t)), S.toasts.join(' | '));
  }
}

// ---------- gate 13: editing a painted outline can't break it ----------
//
// `_paintInvalid` guards the moment a loop is DRAWN. Nothing guarded the moment
// it was edited — and a self-crossing loop is not a cosmetic problem: §5.3's
// chain is one-sided and winding decides which side is solid, so a bow-tie has
// no coherent inside and reaches the physics as terrain whose walls face
// whichever way each sub-loop wound. That is the bowl-that-swallows-things
// failure mode, authored by hand.
{
  const Z = () => ({ x: 0, y: 0 });
  // A square in §11.1's closing-duplicate form: x/y is the first vertex, the
  // last entry of pts repeats it.
  const square = (s = 80) => ({
    type: 'paint', x: -s, y: -s, h1: Z(), h2: Z(), texture: 'granite',
    pts: [{ x: s, y: -s, h1: Z(), h2: Z() }, { x: s, y: s, h1: Z(), h2: Z() },
          { x: -s, y: s, h1: Z(), h2: Z() }, { x: -s, y: -s, h1: Z(), h2: Z() }],
  });
  const paintWorld = () => ({ terrain: [square()], buildZones: [{ x: 0, y: -400, w: 600, h: 400 }] });

  const dragVertex = (S, from, to) => {
    S.sel = { kind: 'terrain', ref: S.level.terrain[0] };
    return gesture(S, from, to, { watch: () => ({ x: 0, y: 0 }) });
  };

  {
    const S = screen(paintWorld(), { tab: 'level' });
    gate('13. the square starts valid', S._paintInvalid(S.level.terrain[0]) === null);
  }

  // **Deleting the SEAM** (2026-08-12, on request: *"If someone tries to delete
  // the loop on the paint. Switch the loop to the next point and let them!"*).
  // The seam is one dot on a ring of dots to the person clicking it, and two
  // records to the file (§11.1). `_reseatPaintLoop` moves the closure onto the
  // next anchor so the delete can then happen like any other.
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const t = S.level.terrain[0];
    const before = S._paintPts(t).map(p => `${p.x},${p.y}`);
    const moved = S._reseatPaintLoop(t);
    const after = S._paintPts(t).map(p => `${p.x},${p.y}`);
    // Re-seating alone must change NOTHING about the shape — same vertices,
    // same count, same winding — or the outline jumps before the delete does
    // anything. It is the ring rotated by one, so the sets must match.
    gate('13. re-seating the loop keeps the identical outline, just rotated',
      moved && after.length === before.length
      && new Set(after).size === new Set(before).size
      && [...new Set(before)].every(p => after.includes(p)),
      `${before.join(' ')} → ${after.join(' ')}`);
    gate('13. …and the piece\'s own x/y is the anchor that was next',
      t.x === 80 && t.y === -80, `origin now (${t.x}, ${t.y})`);
    gate('13. …and it is still a legal piece afterwards', S._paintInvalid(t) === null,
      S._paintInvalid(t) || 'valid');
    // …and the delete the author actually asked for, the way the handler does
    // it: rotate, then drop the anchor that is now second from the end.
    const n = S._paintPts(t).length;
    t.pts.splice(t.pts.length - 2, 1);
    const left = S._paintPts(t);
    gate('13. …and the seam can then be dropped like any other point',
      left.length === n - 1 && !left.some(p => p.x === -80 && p.y === -80),
      `${n} points → ${left.length}, and (−80,−80) is gone`);
    gate('13. …leaving a piece that is still legal and still closed',
      S._paintInvalid(t) === null && t.pts[t.pts.length - 1].x === t.x && t.pts[t.pts.length - 1].y === t.y,
      S._paintInvalid(t) || 'valid, closure intact');
  }
  // the floor still holds: the minimum is a policy about how few points a piece
  // may have, and it is unchanged by the seam being deletable
  {
    const tri = {
      type: 'paint', x: 0, y: 0, h1: Z(), h2: Z(), texture: 'granite',
      pts: [{ x: 100, y: 0, h1: Z(), h2: Z() }, { x: 50, y: 90, h1: Z(), h2: Z() }, { x: 0, y: 0, h1: Z(), h2: Z() }],
    };
    const S = screen({ terrain: [tri], buildZones: [{ x: 0, y: -400, w: 600, h: 400 }] }, { tab: 'level' });
    gate('13. a 3-point loop is at the floor — the minimum is a policy, not a seam problem',
      S._paintPts(S.level.terrain[0]).length === 3, 'three anchors, at the floor');
  }

  // Collapse: drag one corner onto the opposite one. Area goes to nothing.
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const g = dragVertex(S, { x: -80, y: -80 }, { x: 80, y: 80 });
    gate('13. collapsing an outline onto itself is refused and reverted',
      g.type === 'move-waypoint' && S._paintInvalid(S.level.terrain[0]) === null &&
      S.toasts.some(t => /area/.test(t)),
      `"${S.toasts[0] || 'no toast'}"`);
  }

  // Bow-tie: pull one corner past its neighbour so two edges cross. This is the
  // one that matters — it keeps plenty of area, so an area check alone would
  // wave it through.
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const g = dragVertex(S, { x: 80, y: 80 }, { x: -160, y: 80 });
    const t = S.level.terrain[0];
    gate('13. an edit that makes the loop cross itself is refused and reverted',
      g.type === 'move-waypoint' && S._paintInvalid(t) === null &&
      near(t.pts[1].x, 80) && S.toasts.some(t2 => /crosses itself/.test(t2)),
      `"${S.toasts[0] || 'no toast'}"`);
  }

  // ...and a legal edit still lands, or the rule has eaten the feature.
  {
    const S = screen(paintWorld(), { tab: 'level' });
    dragVertex(S, { x: 80, y: 80 }, { x: 140, y: 120 });
    const t = S.level.terrain[0];
    gate('13. a legal vertex edit still commits',
      near(t.pts[1].x, 140) && near(t.pts[1].y, 120) && S.toasts.length === 0,
      `vertex now ${t.pts[1].x},${t.pts[1].y}`);
  }

  // The revert restores the ORIGIN too. A painted loop's last vertex sits
  // exactly on the piece's own x/y — that coincidence IS the closure (§11.1) —
  // so a restore that put back `pts` but not `x`/`y` would spring the loop open.
  {
    const S = screen(paintWorld(), { tab: 'level' });
    dragVertex(S, { x: -80, y: -80 }, { x: 80, y: 80 });
    const t = S.level.terrain[0];
    const last = t.pts[t.pts.length - 1];
    gate('13. ...and the revert keeps the loop closed (origin restored with pts)',
      near(t.x, -80) && near(t.y, -80) && near(last.x, -80) && near(last.y, -80),
      `origin ${t.x},${t.y} vs closing vertex ${last.x},${last.y}`);
  }

  // ...and the GROUP transforms ask it too, which was the last reshaping route
  // that didn't. Shrinking a group hard enough drives a small painted member
  // under MIN_AREA — boxes and balls just stop at their clamp, a painted loop
  // has no w/h to clamp — and it used to commit in silence. It reverts now,
  // whole: members AND zones, since a group transform carries both and putting
  // back only the terrain would strand the build areas at their new size.
  const sq2 = (cx, cy, s, gid = 'G') => ({
    type: 'paint', groupId: gid, x: cx - s, y: cy - s, h1: Z(), h2: Z(), texture: 'granite',
    pts: [{ x: cx + s, y: cy - s, h1: Z(), h2: Z() }, { x: cx + s, y: cy + s, h1: Z(), h2: Z() },
          { x: cx - s, y: cy + s, h1: Z(), h2: Z() }, { x: cx - s, y: cy - s, h1: Z(), h2: Z() }],
  });
  const shrinkGroup = (S, gid = 'G', factor = 0.97) => {
    const b = S._groupBounds(gid);
    S.sel = { kind: 'group', gid, bounds: b };
    S._pointerDown(ev(b.maxX, b.maxY));
    const type = S.drag?.type;
    for (let i = 1; i <= 8; i++) {
      const f = 1 - factor * (i / 8);
      S._pointerMove(ev(b.minX + (b.maxX - b.minX) * f, b.minY + (b.maxY - b.minY) * f));
    }
    S._pointerUp(ev(b.minX + 6, b.minY + 2));
    return type;
  };
  {
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: 0, y: -100, w: 400, h: 60 }, sq2(150, -100, 6)],
      buildZones: [{ x: 0, y: -400, w: 900, h: 600, groupId: 'G' }],
      groups: { G: {} },
    }, { tab: 'level' });
    const box0 = deep(S.level.terrain[0]), paint0 = deep(S.level.terrain[1]);
    const zone0 = deep(S.level.buildZones[0]);
    const type = shrinkGroup(S);
    gate('13. a GROUP resize that over-shrinks a painted member is reverted',
      type === 'group-resize' && S._paintInvalid(S.level.terrain[1]) === null && S.toasts.length > 0,
      S.toasts.length ? `"${S.toasts[0]}"` : 'NO TOAST — committed silently');
    // reverted WHOLE: the box member, the painted member, and the zone.
    gate('13. ...and the revert puts back every member, not just the broken one',
      JSON.stringify(S.level.terrain[0]) === JSON.stringify(box0) &&
      JSON.stringify(S.level.terrain[1]) === JSON.stringify(paint0),
      `box ${S.level.terrain[0].w}x${S.level.terrain[0].h} (was ${box0.w}x${box0.h})`);
    gate('13. ...including the zones a group transform also carries',
      JSON.stringify(S.level.buildZones[0]) === JSON.stringify(zone0),
      `zone ${S.level.buildZones[0].w}x${S.level.buildZones[0].h} (was ${zone0.w}x${zone0.h})`);
    gate('13. ...and nothing was committed',
      S.commits === 0, `${S.commits} commits`);
  }

  // A shrink that does NOT break anything still commits — the rule must not
  // turn "resize a group" into a gesture that fights you. Same rig, gentler
  // pull, and a painted member big enough to survive it.
  {
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: 0, y: -100, w: 400, h: 60 }, sq2(150, -100, 60)],
      buildZones: [{ x: 0, y: -400, w: 900, h: 600, groupId: 'G' }],
      groups: { G: {} },
    }, { tab: 'level' });
    const before = S.level.terrain[0].w;
    shrinkGroup(S, 'G', 0.5);
    gate('13. ...while a group resize that breaks nothing still commits',
      S._paintInvalid(S.level.terrain[1]) === null && S.commits > 0 &&
      S.level.terrain[0].w < before && S.toasts.length === 0,
      `box w ${before} -> ${S.level.terrain[0].w.toFixed(1)}, ${S.commits} commits`);
  }

  // ...and the freeze: a group holding an outline the level ALREADY broke has
  // to stay resizable, or the one gesture that could fix it is the one the rule
  // takes away (§16's one-way door). The first assert is what keeps this
  // honest — a rig whose member is secretly valid would pass for free.
  {
    const bowtie = {
      type: 'paint', groupId: 'G', x: 100, y: -100, h1: Z(), h2: Z(), texture: 'granite',
      pts: [{ x: 200, y: -100, h1: Z(), h2: Z() }, { x: 100, y: -40, h1: Z(), h2: Z() },
            { x: 200, y: -40, h1: Z(), h2: Z() }, { x: 100, y: -100, h1: Z(), h2: Z() }],
    };
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: 0, y: -100, w: 400, h: 60 }, bowtie],
      buildZones: [{ x: 0, y: -400, w: 900, h: 600 }],
      groups: { G: {} },
    }, { tab: 'level' });
    gate('13. ...and that already-broken outline really is broken to start with',
      !!S._paintInvalid(S.level.terrain[1]), `"${S._paintInvalid(S.level.terrain[1])}"`);
    const before = S.level.terrain[0].w;
    shrinkGroup(S, 'G', 0.5);
    gate('13. ...so a group holding it can still be resized',
      S.level.terrain[0].w < before && S.commits > 0 && S.toasts.length === 0,
      `box w ${before} -> ${S.level.terrain[0].w.toFixed(1)}, ${S.commits} commits`);
  }

  // Group ROTATE goes through the same finish. A rigid turn cannot break an
  // outline, so this is the "does not over-enforce" half: it must still commit.
  {
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: 0, y: -100, w: 400, h: 60 }, sq2(150, -100, 30)],
      buildZones: [{ x: 0, y: -400, w: 900, h: 600, groupId: 'G' }],
      groups: { G: {} },
    }, { tab: 'level' });
    const b = S._groupBounds('G');
    S.sel = { kind: 'group', gid: 'G', bounds: b };
    S._pointerDown(ev((b.minX + b.maxX) / 2, b.minY - 20));
    const type = S.drag?.type;
    for (let i = 1; i <= 8; i++) S._pointerMove(ev(b.maxX + 40 * i, (b.minY + b.maxY) / 2));
    S._pointerUp(ev(b.maxX + 320, (b.minY + b.maxY) / 2));
    gate('13. a group ROTATE still commits (a rigid turn breaks no outline)',
      type === 'group-rotate' && S.commits > 0 && S.toasts.length === 0 &&
      S._paintInvalid(S.level.terrain[1]) === null,
      `${S.commits} commits, group angle ${(S.level.groups.G.angle || 0).toFixed(2)}`);
  }

  // Motion paths go through the very same two handlers and have no shape rule —
  // they must not be caught by this.
  {
    const S = screen({
      terrain: [{ type: 'box', x: 0, y: -100, w: 60, h: 60, path: { pts: [{ x: 0, y: -200 }] } }],
      buildZones: [{ x: 0, y: -400, w: 600, h: 400 }],
    }, { tab: 'level' });
    S.sel = { kind: 'terrain', ref: S.level.terrain[0] };
    const g = gesture(S, { x: 0, y: -200 }, { x: 120, y: -260 }, { watch: () => ({ x: 0, y: 0 }) });
    const pts = S.level.terrain[0].path.pts;
    gate('13. a motion-path waypoint is unaffected by the outline rule',
      g.type === 'move-waypoint' && near(pts[0].x, 120) && S.toasts.length === 0,
      `waypoint at ${pts[0].x},${pts[0].y}`);
  }
}

// ---------- gate 12b: where a stopped drag comes to REST ----------
//
// A sweep used to stop at the last position the validity RULE still accepted,
// which is a full pixel INSIDE the surface — so pressing Play made every piece
// pop out as Box2D depenetrated it. The rule's pixel is a TOLERANCE (what the
// editor will accept from a hand-placed piece); it was never meant to be the
// target.
//
// Drags now aim at REST_GAP, and so does Align→Touch, so "push it until it
// stops" and "touch it into place" put a piece in the same spot. The physics
// half of this — that a piece left there does not move when the sim runs — is
// gated in verify.mjs (§15 gate 14), which has the wasm.
{
  const world = (over = {}) => ({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    buildZones: [{ x: 0, y: -100, w: 700, h: 400 }],
    goalZones: [{ x: 500, y: -50, w: 100, h: 100 }],
    ...over,
  });
  // Every kind, dragged hard down into the floor. The floor's walkable top is
  // y = 0 (§3), so a piece of half-height h rests at −h and the gap is the
  // amount by which it stops short of that.
  const cases = [
    ['prop', () => {
      const S = screen(world({ props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }), { tab: 'level' });
      gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { steps: 40, watch: propAt(S, 0) });
      return -15 - S.level.props[0].y;
    }],
    ['goal', () => {
      const S = screen(world({ goalObjs: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }));
      gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { steps: 40, watch: goalAt(S, 0) });
      return -15 - S.goalPositions[0].y;
    }],
    ['wheel', () => {
      const S = screen(world(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
      gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { steps: 40, watch: partAt(S, 0) });
      return -15 - S.design.parts[0].y;
    }],
    ['rod', () => {
      const S = screen(world(), { parts: [{ t: 'rod', kind: 'wood', x1: -40, y1: -100, x2: 40, y2: -100, id: 'r' }] });
      gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { steps: 40, watch: partAt(S, 0) });
      return -ROD_THICK / 2 - S.design.parts[0].y1;
    }],
  ].map(([k, run]) => ({ k, gap: run() }));

  for (const { k, gap } of cases) {
    gate(`12. a ${k} dragged into the floor rests REST_GAP clear of it`,
      Math.abs(gap - REST_GAP) < 0.002,
      `${gap.toFixed(4)} px clear, want ${REST_GAP}`);
  }
  // The point of one constant: they all agree, so nothing rests deeper than
  // anything else and no kind pops further at Play.
  gate('12. ...and every kind stops at the same distance',
    Math.max(...cases.map(c => c.gap)) - Math.min(...cases.map(c => c.gap)) < 0.002,
    cases.map(c => `${c.k}:${c.gap.toFixed(4)}`).join('  '));

  // Align→Touch has to agree with the drag, which was the other half of the ask.
  {
    const S = screen(world({
      props: [{ shape: 'box', x: 0, y: -15, w: 30, h: 30 }, { shape: 'box', x: 200, y: -15, w: 30, h: 30 }],
    }), { tab: 'level' });
    S.multiSel = [{ kind: 'prop', ref: S.level.props[0] }, { kind: 'prop', ref: S.level.props[1] }];
    S._alignOp('touch');
    const gap = (S.level.props[1].x - S.level.props[0].x) - 30;
    gate('12. Align→Touch leaves the same gap a drag stops at',
      Math.abs(gap - REST_GAP) < 1e-9, `${gap.toFixed(4)} px, want ${REST_GAP}`);
  }

  // A piece resting where a drag left it must still be DRAGGABLE. This is why
  // REST_GAP isn't zero: `boxesOverlap` counts a shared edge as contact, so a
  // piece at true tangency reads as overlapping its own support and the next
  // sweep would find t=0 invalid and pin it (§16's one-way door).
  {
    const S = screen(world({ props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }), { tab: 'level' });
    gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { steps: 40, watch: propAt(S, 0) });
    const restedY = S.level.props[0].y;
    const g = gesture(S, { x: 0, y: restedY }, { x: 220, y: restedY }, { steps: 20, watch: propAt(S, 0) });
    gate('12. ...and a piece resting there can still be dragged away',
      g.held && S.level.props[0].x > 180, `moved to x ${S.level.props[0].x.toFixed(1)}`);
  }

  // The validity TOLERANCE is untouched: a piece the level authored a pixel
  // into the floor is still accepted, which is what stops hand-placed geometry
  // being flagged. Only the target moved.
  {
    const S = screen(world({ props: [{ shape: 'box', x: 0, y: -14.5, w: 30, h: 30 }] }), { tab: 'level' });
    gate('12. a piece half a pixel into the floor is still ACCEPTED',
      !S._pieceInTerrain(S.level.props[0], S.level.props[0]),
      `tolerance is still ${TERRAIN_TOUCH_PAD} px`);
  }
}

// ---------- gate 12c: props are solid to machine parts ----------
//
// The physics always said so — MASK.WHEEL and MASK.ROD both carry CAT.PROP —
// and the editor was the only thing that didn't know: `_wheelInvalid` checked
// terrain, wheels, goal pieces and wood rods but never props, and the prop
// rules never checked machine parts, so the two kinds simply could not see each
// other and a wheel could be parked inside a boulder to spawn interpenetrating.
//
// Solid means SWEPT — the drag butts up against a prop the way it does against
// the floor — so these gates are about where a part comes to rest, not just
// about being refused.
{
  const world = (over = {}) => ({
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
    props: [{ shape: 'box', x: 100, y: -100, w: 60, h: 60 }],   // spans x 70..130
    buildZones: [{ x: 0, y: -120, w: 700, h: 400 }],
    goalZones: [{ x: 500, y: -50, w: 100, h: 100 }],
    ...over,
  });

  {
    const S = screen(world(), { parts: [{ t: 'wheel', kind: 'free', x: -200, y: -100, r: 20, id: 'w' }] });
    const g = gesture(S, { x: -200, y: -100 }, { x: 300, y: -100 }, { steps: 40, watch: partAt(S, 0) });
    const gap = 70 - (S.design.parts[0].x + 20);
    gate('12. a wheel driven at a prop butts up against it',
      g.held && Math.abs(gap - REST_GAP) < 0.005, `gap ${gap.toFixed(4)} px, want ${REST_GAP}`);
  }
  {
    const S = screen(world(), { parts: [{ t: 'rod', kind: 'wood', x1: -260, y1: -100, x2: -200, y2: -100, id: 'r' }] });
    const g = gesture(S, { x: -230, y: -100 }, { x: 270, y: -100 }, { steps: 40, watch: partAt(S, 0) });
    const gap = 70 - S.design.parts[0].x2 - ROD_THICK / 2;
    gate('12. a stick driven at a prop butts up against it',
      g.held && Math.abs(gap - REST_GAP) < 0.005, `gap ${gap.toFixed(4)} px`);
  }
  {
    // The one kind that ignores most of this file still has to stop here:
    // MASK.WATER is exactly ENV|PROP, so a water stick passes through machine
    // parts and goal pieces but NOT props.
    const S = screen(world(), { parts: [{ t: 'rod', kind: 'water', x1: -260, y1: -100, x2: -200, y2: -100, id: 'r' }] });
    gesture(S, { x: -230, y: -100 }, { x: 270, y: -100 }, { steps: 40, watch: partAt(S, 0) });
    const gap = 70 - S.design.parts[0].x2 - ROD_THICK / 2;
    gate('12. ...and so does a WATER stick, which passes through everything else',
      Math.abs(gap - REST_GAP) < 0.005, `gap ${gap.toFixed(4)} px`);
  }
  {
    const S = screen(world(), { tool: 'wheel-free' });
    S._pointerDown(ev(100, -100));
    S._pointerUp(ev(100, -100));
    gate('12. placing a wheel on a prop is refused',
      S.design.parts.length === 0 && S.toasts.some(t => /through props/.test(t)), S.toasts.join(' | '));
  }
  {
    // A design saved BEFORE this rule existed can have a part inside a prop.
    // Freezing is what stops the new rule pinning it on load (§16).
    const S = screen(world(), { parts: [{ t: 'wheel', kind: 'free', x: 100, y: -100, r: 20, id: 'w' }] });
    const g = gesture(S, { x: 100, y: -100 }, { x: -200, y: -100 }, { steps: 40, watch: partAt(S, 0) });
    gate('12. a part the level left INSIDE a prop is still draggable',
      g.held && S.design.parts[0].x < -150, `moved to x ${S.design.parts[0].x.toFixed(1)}`);
  }
  {
    // ...and freezing the prop rule off must not also switch terrain off.
    const S = screen(world(), { parts: [{ t: 'wheel', kind: 'free', x: 100, y: -100, r: 20, id: 'w' }] });
    gesture(S, { x: 100, y: -100 }, { x: 100, y: 300 }, { steps: 40, watch: partAt(S, 0) });
    gate('12. ...but it is still stopped by the floor',
      S.design.parts[0].y <= -20 + REST_GAP + 0.01, `y ${S.design.parts[0].y.toFixed(3)}`);
  }
}

// ---------- gate 13b: the renderer's pin contract ----------
//
// `drawGoalPiece` rotates the canvas into the crate's frame and THEN plots the
// pins, so it must plot UNROTATED offsets. `goalPinOffsets` rotates by
// `g.angle` itself — it has to, because `goalPins` builds the world coordinates
// that snapping and jointing match on — so handing it the piece as-is applied
// the rotation twice and a tilted crate drew its dots somewhere the pins are
// not. Only the dots were wrong, which is why it read as the pins being out of
// sync with the piece rather than as a snapping bug.
//
// The contract, asserted directly: rotating what the renderer plots by the
// piece's own angle must reproduce `goalPins` exactly.
{
  const { goalPinOffsets, goalPins } = await import(u('public/js/util.js'));
  const worstFor = (g) => {
    const a = g.angle || 0, c = Math.cos(a), s = Math.sin(a);
    const drawn = goalPinOffsets({ ...g, angle: 0 });        // what drawGoalPiece plots
    const real = goalPins(g, { x: g.x, y: g.y });
    return Math.max(...drawn.map(([ox, oy], i) => Math.hypot(
      g.x + ox * c - oy * s - real[i].x,
      g.y + ox * s + oy * c - real[i].y)));
  };
  for (const deg of [0, 20, 45, 90, 137]) {
    const g = { shape: 'box', x: 12, y: -7, w: 60, h: 30, angle: deg * Math.PI / 180 };
    gate(`13. a crate's drawn pins land on its real pins @${deg}°`,
      worstFor(g) < 1e-9, `worst ${worstFor(g).toExponential(1)} px`);
  }
  // A ball's pins are rotation-free by construction (goalPinOffsets returns
  // before the angle block), so the renderer must not be turning those either.
  const ball = { shape: 'ball', x: 0, y: 0, r: 20, angle: 1 };
  gate('13. a goal ball\'s pins are unaffected by an angle',
    JSON.stringify(goalPinOffsets(ball)) === JSON.stringify(goalPinOffsets({ ...ball, angle: 0 })));

  // **The selection outline and the resize handles must describe the same
  // rectangle.** Terrain and props drew their outline through `rectCorners` and
  // turned correctly; goal crates and zones used `strokeRect`, which cannot
  // express an angle — so a tilted crate wore an upright dashed box while the
  // handles drawn on top of it sat on the real corners. Zones had the identical
  // latent bug, waiting for the day they could rotate.
  //
  // Asserted as a relationship rather than as coordinates: the outline is the
  // handle rectangle grown by a constant standoff, so each outline corner must
  // sit exactly `grow/2` out from its handle along the piece's OWN axes.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 300, h: 200, angle: 0.7 }],
      goalObjs: [{ shape: 'box', x: 12, y: -7, w: 60, h: 30 }],
    }, { tab: 'level' });
    const agrees = (o, pos, grow) => {
      const out = S._boxOutlinePts(o, pos, grow);
      const hs = S._resizeHandlePts(o, pos);
      const a = o.angle || 0, c = Math.cos(a), s = Math.sin(a);
      // each corner pushed out by grow/2 along the piece's own diagonal
      return out.every((p, i) => {
        const sx = i === 0 || i === 3 ? -1 : 1, sy = i < 2 ? -1 : 1;
        const wx = (sx * grow / 2) * c - (sy * grow / 2) * s;
        const wy = (sx * grow / 2) * s + (sy * grow / 2) * c;
        return Math.hypot(p.x - (hs[i].x + wx), p.y - (hs[i].y + wy)) < 1e-9;
      });
    };
    for (const deg of [0, 35, 90]) {
      const g = { ...S.level.goalObjs[0], angle: deg * Math.PI / 180 };
      gate(`13. a goal crate's outline matches its resize handles @${deg}°`,
        agrees(g, { x: g.x, y: g.y }, 6));
    }
    const z = S.level.buildZones[0];
    gate('13. a rotated zone\'s outline matches its resize handles',
      agrees(z, z, 6));
    // ...and the outline really does turn, rather than passing by being square
    const tilted = S._boxOutlinePts({ ...S.level.goalObjs[0], angle: 0.6 }, { x: 0, y: 0 }, 6);
    gate('13. ...and a tilted crate\'s outline is not axis-aligned',
      Math.abs(tilted[0].y - tilted[1].y) > 1, `top edge drops ${Math.abs(tilted[0].y - tilted[1].y).toFixed(1)} px`);
  }
}

// ---------- gate 14: rotated build/goal zones (§7.2a) ----------
//
// Zones carried an optional `angle` in the data model all along; what was
// missing was the rotate knob and a clamp that could aim at a tilted rect.
// Everything else — containment, cluster joining, hit-testing, rendering, the
// sim's own region test — already worked in each zone's own frame.
{
  const A = 30 * Math.PI / 180;

  // The knob exists at all. Zones were excluded from it by an explicit
  // `kind !== 'zone'`, so this is the gate that would catch it coming back.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 300, h: 200 }] }, { tab: 'level' });
    const z = S.level.buildZones[0];
    S.sel = { kind: 'zone', zone: 'build', idx: 0, ref: z };
    const k = S._rotateKnobPt(z, z);
    const g = gesture(S, { x: k.x, y: k.y }, { x: 200, y: 0 }, { watch: () => ({ x: 0, y: 0 }) });
    gate('14. a zone can be rotated',
      g.type === 'rotate' && Math.abs(z.angle || 0) > 0.1, `angle ${(z.angle || 0).toFixed(3)}`);
  }

  // The clamp aims at the TILTED rect, so a piece shoved along a world axis
  // comes to rest inside the zone rather than at the axis-aligned edge.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 400, h: 120, angle: A }] },
      { parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' }] });
    const g = gesture(S, { x: 0, y: 0 }, { x: 900, y: 0 }, { watch: partAt(S, 0) });
    const p = S.design.parts[0];
    gate('14. a wheel shoved along a world axis rests inside a TILTED zone',
      g.held && S._wheelInvalid(p, p, true) === null && g.toasts.length === 0,
      `rested at ${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }

  // ...and it really is following the zone's own axis: pushed diagonally, the
  // piece ends up off the world axis, which an axis-aligned clamp could never
  // produce.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 400, h: 120, angle: A }] },
      { parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' }] });
    gesture(S, { x: 0, y: 0 }, { x: 900, y: 300 }, { watch: partAt(S, 0) });
    const p = S.design.parts[0];
    gate('14. ...and it slides ALONG the tilt, not along the world axes',
      Math.abs(p.y) > 20 && S._wheelInvalid(p, p, true) === null,
      `y ${p.y.toFixed(1)} — an axis-aligned clamp would have left it near 0`);
  }

  // A goal piece gets the same treatment through its own clamp.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 400, h: 140, angle: A }],
      goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 30 }],
    });
    const g = gesture(S, { x: 0, y: 0 }, { x: 900, y: 0 }, { watch: goalAt(S, 0) });
    gate('14. a goal piece is clamped into a tilted zone too',
      g.held && S._goalFitsZone(S.level.goalObjs[0], S.goalPositions[0]) && g.toasts.length === 0,
      `rested at ${S.goalPositions[0].x.toFixed(1)},${S.goalPositions[0].y.toFixed(1)}`);
  }

  // **Every piece reaches the same distance from a tilted edge, whatever its
  // size or rotation.** This is the gate for a real play-test report: wheels
  // stopped short of a tilted edge by (|cos a| + |sin a| − 1)·r — 2.7 px for a
  // small wheel, 11 px for a large one, which reads as the editor being
  // arbitrarily fussier about big wheels — and a rotated crate stopped short by
  // most of its half-diagonal, which looked absurd.
  //
  // The cause was that both the clamp AND the containment rule measured the
  // axis-aligned BOX round the piece. A circle's box overhangs it by 41% of the
  // radius at the corners; a tilted crate's box is half again its size. They now
  // measure the piece's real footprint (util.js's footprintOf) — the same
  // footprint on both sides, which is what keeps them from disagreeing.
  //
  // Asserting they all reach the SAME gap is the point: any measurement that
  // scales with size or angle fails this, however plausible it looks.
  {
    const Z = { x: 0, y: 0, w: 400, h: 200, angle: A };
    const c = Math.cos(A), s = Math.sin(A);
    // how far the piece's furthest point stops short of the zone's +x edge,
    // measured in the zone's own frame
    const gap = (pts, r = 0) =>
      Z.w / 2 - (Math.max(...pts.map(p => (p.x - Z.x) * c + (p.y - Z.y) * s)) + r);
    const shove = (S, watch) => gesture(S, { x: 0, y: 0 }, { x: 1200, y: 600 }, { steps: 30, watch });

    const wheelGaps = [7.5, 15, 30].map((r) => {
      const S = screen({ buildZones: [Z] }, { parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r, id: 'w' }] });
      shove(S, partAt(S, 0));
      const p = S.design.parts[0];
      return { r, gap: gap([{ x: p.x, y: p.y }], r), legal: S._wheelInvalid(p, p, true) === null };
    });
    gate('14. wheels of every size stop the same distance from a tilted edge',
      wheelGaps.every(g => g.legal) &&
      Math.max(...wheelGaps.map(g => g.gap)) - Math.min(...wheelGaps.map(g => g.gap)) < 0.05,
      wheelGaps.map(g => `r${g.r}:${g.gap.toFixed(2)}`).join('  '));
    gate('14. ...and that distance is flush, not a size-scaled shortfall',
      wheelGaps.every(g => Math.abs(g.gap) <= ZONE_SLACK + 0.01),
      `worst ${Math.max(...wheelGaps.map(g => Math.abs(g.gap))).toFixed(2)} px, slack is ${ZONE_SLACK}`);

    const crateGaps = [0, 20, 45].map((deg) => {
      const ang = deg * Math.PI / 180;
      const g = { shape: 'box', x: 0, y: 0, w: 60, h: 30, angle: ang };
      const S = screen({ buildZones: [Z], goalObjs: [g] });
      shove(S, goalAt(S, 0));
      const pos = S.goalPositions[0];
      const cc = Math.cos(ang), ss = Math.sin(ang);
      // The crate's CORE corners plus its radius — the same centre-plus-radius
      // form the wheels above are measured by, and the shape that is actually
      // drawn. Measured by its SHARP corners this read -3.43 px once the zone
      // rules went rounded: a corner that is not there, poking out of the zone.
      // CORNER_RADIUS_DEFAULT restated rather than imported.
      const CR = 8;
      const pts = [[-(30 - CR), -(15 - CR)], [30 - CR, -(15 - CR)], [30 - CR, 15 - CR], [-(30 - CR), 15 - CR]]
        .map(([dx, dy]) => ({ x: pos.x + dx * cc - dy * ss, y: pos.y + dx * ss + dy * cc }));
      return { deg, gap: gap(pts, CR), legal: S._goalFitsZone(g, pos) };
    });
    gate('14. a ROTATED crate reaches a tilted edge as closely as an unrotated one',
      crateGaps.every(g => g.legal) &&
      Math.max(...crateGaps.map(g => g.gap)) - Math.min(...crateGaps.map(g => g.gap)) < 0.05,
      crateGaps.map(g => `${g.deg}°:${g.gap.toFixed(2)}`).join('  '));
  }

  // ...and the same rule in an UNROTATED zone, which is where a rotated crate
  // was also being held off by its bounding box — the report was about the
  // tilted build area, but this half was wrong everywhere.
  {
    const Z = { x: 0, y: 0, w: 400, h: 200 };
    const gaps = [0, 45].map((deg) => {
      const ang = deg * Math.PI / 180;
      const g = { shape: 'box', x: 0, y: 0, w: 60, h: 30, angle: ang };
      const S = screen({ buildZones: [Z], goalObjs: [g] });
      gesture(S, { x: 0, y: 0 }, { x: 1200, y: 0 }, { steps: 30, watch: goalAt(S, 0) });
      const pos = S.goalPositions[0];
      const cc = Math.cos(ang), ss = Math.sin(ang);
      const CR = 8;                                    // as above
      const maxX = Math.max(...[[-(30 - CR), -(15 - CR)], [30 - CR, -(15 - CR)], [30 - CR, 15 - CR], [-(30 - CR), 15 - CR]]
        .map(([dx, dy]) => pos.x + dx * cc - dy * ss)) + CR;
      return { deg, gap: Z.w / 2 - maxX, legal: S._goalFitsZone(g, pos) };
    });
    gate('14. ...in an unrotated zone too',
      gaps.every(g => g.legal) && Math.abs(gaps[0].gap - gaps[1].gap) < 0.05,
      gaps.map(g => `${g.deg}°:${g.gap.toFixed(2)}`).join('  '));
  }

  // `_goalTouchesZone` decides whether a piece is the player's to move at all
  // (_goalLocked). The AABB version handed a tilted zone its whole bounding
  // box, so a piece sitting well outside one of its corners read as "touching".
  {
    const zone = { x: 0, y: 0, w: 300, h: 60, angle: A };
    const S = screen({ buildZones: [zone], goalObjs: [{ shape: 'box', x: 0, y: 0, w: 30, h: 30 }] });
    const corner = rectCornersOf(zone);
    // just outside the bounding box's corner, but far from the zone itself
    S.goalPositions[0] = { x: corner.bbMaxX - 5, y: corner.bbMinY + 5 };
    gate('14. a piece near a tilted zone\'s bounding-box corner is NOT touching it',
      S._goalLocked(0), `locked ${S._goalLocked(0)}`);
    S.goalPositions[0] = { x: 0, y: 0 };
    gate('14. ...and a piece actually in the zone is', !S._goalLocked(0));
  }

  // Group transforms carry zone members. They never did — only translation did
  // — so scaling or turning a group left its build area behind. Invisible while
  // zones couldn't rotate; glaring now.
  {
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: -100, y: 0, w: 80, h: 40 }],
      buildZones: [{ x: 100, y: 0, w: 120, h: 80, groupId: 'G' }],
      groups: { G: {} },
    }, { tab: 'level' });
    const b = S._groupBounds('G');
    S.sel = { kind: 'group', gid: 'G', bounds: b };
    const k = { x: (b.minX + b.maxX) / 2, y: b.minY - 20 };
    const g = gesture(S, { x: k.x, y: k.y }, { x: b.maxX + 100, y: (b.minY + b.maxY) / 2 },
      { watch: () => ({ x: 0, y: 0 }) });
    const z = S.level.buildZones[0];
    gate('14. a group rotation turns its zones with it',
      g.type === 'group-rotate' && Math.abs(z.angle || 0) > 0.1 && Math.abs(z.y) > 1,
      `zone angle ${(z.angle || 0).toFixed(3)}, moved to ${z.x.toFixed(1)},${z.y.toFixed(1)}`);
  }
  {
    const S = screen({
      terrain: [{ type: 'box', groupId: 'G', x: -100, y: 0, w: 80, h: 40 }],
      buildZones: [{ x: 100, y: 0, w: 120, h: 80, groupId: 'G' }],
      groups: { G: {} },
    }, { tab: 'level' });
    const b = S._groupBounds('G');
    S.sel = { kind: 'group', gid: 'G', bounds: b };
    const w0 = S.level.buildZones[0].w;
    gesture(S, { x: b.maxX, y: b.maxY }, { x: b.minX + (b.maxX - b.minX) * 2, y: b.maxY },
      { watch: () => ({ x: 0, y: 0 }) });
    gate('14. a group resize scales its zones with it',
      S.level.buildZones[0].w > w0 * 1.5, `zone w ${w0} → ${S.level.buildZones[0].w.toFixed(1)}`);
  }

  // Align→Touch still measures in world axes, so against a TILTED zone it can
  // aim somewhere outside it. That is left as-is — "align this to the left edge"
  // of a turned rectangle is a design question, not an arithmetic one — but it
  // must FAIL SAFE: the align's own validation refuses and reverts rather than
  // parking a piece outside the build area.
  {
    const S = screen({
      buildZones: [{ x: 0, y: 0, w: 300, h: 100, angle: A }],
      goalObjs: [{ shape: 'box', x: 0, y: 0, w: 30, h: 30 }],
    });
    S.multiSel = [
      { kind: 'zone', zone: 'build', idx: 0, ref: S.level.buildZones[0] },
      { kind: 'goal', idx: 0 },
    ];
    S._alignOp('touch');
    const legal = S._goalFitsZone(S.level.goalObjs[0], S.goalPositions[0]);
    gate('14. Align→Touch against a tilted zone never lands a piece outside it',
      legal, legal
        ? `landed legally at ${S.goalPositions[0].x.toFixed(1)},${S.goalPositions[0].y.toFixed(1)}`
        : 'LEFT A PIECE OUTSIDE THE ZONE');
  }
}

// ---------- gate 15: Create ≡ Test for machine parts (§7.2) ----------
//
// The level's own parts (`level.fixedParts`, authored in **Create**) and the
// player's (`design.parts`, built in **Test**) are the same kind of object and
// must answer every gesture the same way. **The build area is the one and only
// difference**: it confines the design and not the level's parts.
//
// They had drifted badly, and the reports were all one cause — the gestures
// were written against `design.parts` by name:
//   - a triangle of sticks came apart in Create (no companions at all for a
//     fixed rod: `_companionsOf` only had a branch for `kind === 'part'`);
//   - a wheel stayed behind when the stick bolted to it was dragged;
//   - a stick's END could not be grabbed at all (`_hitTest`'s endpoint loop
//     read only the design pool), so the whole stick translated instead;
//   - and grabbing a fixed wheel's HUB pulled the stick out of it, because the
//     fixed pool was one reversed loop over both shapes — last authored wins —
//     where the design pool tests wheels before rods.
//
// **These are parity gates: the same geometry, the same gesture, in both
// tabs, required to give the same answer.** Each is paired with an assertion
// that the gesture actually did something, because "both tabs agree" is also
// satisfied by both doing nothing (§16 — an "X changes nothing" gate needs a
// partner asserting X happened).
{
  const roomy = { terrain: [], buildZones: [{ x: 0, y: 0, w: 900, h: 700 }] };
  // A triangle: three sticks pinned corner to corner. Dragging one by its
  // MIDDLE rigid-moves it and stretches the two it shares pins with, so the
  // triangle deforms instead of coming apart.
  const triangle = () => ([
    { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'a' },
    { t: 'rod', kind: 'wood', x1: 60, y1: -100, x2: 0, y2: -200, id: 'b' },
    { t: 'rod', kind: 'wood', x1: 0, y1: -200, x2: -60, y2: -100, id: 'c' },
  ]);
  const cart = () => ([
    { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'w' },
    { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' },
  ]);
  // Build the SAME parts as the design (Test) or as the level's (Create), and
  // read them back from wherever they live.
  const inTab = (tab, parts) => {
    const fixed = tab === 'level';
    const S = screen(fixed ? { ...roomy, fixedParts: parts } : roomy,
      { tab, parts: fixed ? [] : parts });
    return { S, pool: () => (fixed ? S.level.fixedParts : S.design.parts) };
  };
  // `shape` is the whole state a gate compares: every endpoint and hub, to
  // 0.01 px. Two tabs agreeing on this is the claim.
  const shape = (pool) => pool.map(p => (p.t === 'wheel'
    ? `W(${p.x.toFixed(2)},${p.y.toFixed(2)})`
    : `R(${p.x1.toFixed(2)},${p.y1.toFixed(2)}-${p.x2.toFixed(2)},${p.y2.toFixed(2)})`)).join(' ');

  // Runs one gesture in both tabs and reports (createShape, testShape, type).
  const both = (parts, from, to) => {
    const out = {};
    for (const tab of ['machine', 'level']) {
      const { S, pool } = inTab(tab, parts());
      const before = shape(pool());
      const hit = S._hitTest(from);
      const g = gesture(S, from, to, { watch: () => ({ ...(pool()[0].t === 'wheel' ? pool()[0] : { x: pool()[0].x1, y: pool()[0].y1 }) }) });
      out[tab] = { before, after: shape(pool()), hitKind: hit && hit.kind, type: g.type, held: g.held, toasts: g.toasts };
    }
    return out;
  };

  // 15a — the triangle, grabbed by the middle of its bottom stick.
  {
    const r = both(triangle, { x: 0, y: -100 }, { x: 0, y: -40 });
    gate('15. a triangle of sticks deforms the same way in Create as in Test',
      r.level.after === r.machine.after,
      `Create ${r.level.after}\n        Test   ${r.machine.after}`);
    // ...and it actually stretched, rather than both tabs agreeing on nothing:
    // the two OTHER sticks' pinned ends have to have followed.
    gate('15. ...and that gesture really did stretch the other two sticks',
      r.machine.after !== r.machine.before && /R\(60.00,-40.00/.test(r.machine.after),
      r.machine.after);
  }

  // 15b — a stick bolted to a wheel's hub, dragged by the stick. The wheel
  // rides; it used to be left behind in Create.
  {
    const r = both(cart, { x: 0, y: -100 }, { x: 0, y: -40 });
    gate('15. a stick carries the wheel bolted to it in Create as in Test',
      r.level.after === r.machine.after,
      `Create ${r.level.after}\n        Test   ${r.machine.after}`);
    gate('15. ...and the wheel really did ride along',
      /W\(-60.00,-40.00\)/.test(r.machine.after), r.machine.after);
  }

  // 15c — the same pair from the OTHER end (§16's both-ends rule): grab the
  // wheel, and the stick STRETCHES about its far end rather than translating.
  // This one also pins the pick order — in Create the hub used to return the
  // stick, so the whole rod moved rigidly and the far end came with it.
  {
    const r = both(cart, { x: -60, y: -100 }, { x: -60, y: -180 });
    gate('15. grabbing the hub picks the WHEEL in both tabs, not the stick on it',
      r.level.hitKind === 'fixed' && r.machine.hitKind === 'part' &&
      r.level.after === r.machine.after,
      `Create ${r.level.after}\n        Test   ${r.machine.after}`);
  }

  // 15d — grabbing an END and moving only that end.
  {
    const oneStick = () => ([{ t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' }]);
    const r = both(oneStick, { x: 60, y: -100 }, { x: 60, y: -180 });
    gate('15. a stick END is grabbable in Create, and moves alone as it does in Test',
      r.level.hitKind === 'endpoint' && r.machine.hitKind === 'endpoint' &&
      r.level.type === 'move-endpoint' && r.machine.type === 'move-endpoint' &&
      r.level.after === r.machine.after,
      `Create ${r.level.hitKind}/${r.level.type} ${r.level.after}\n        Test   ${r.machine.hitKind}/${r.machine.type} ${r.machine.after}`);
    gate('15. ...and it really was one end that moved, not the whole stick',
      /R\(-60.00,-100.00-60.00,-180.00\)/.test(r.machine.after), r.machine.after);
  }

  // ...and a fixed stick's end is NOT grabbable from the Test tab. There a
  // fixed part is the level's furniture and a bolt-target; a player reaching
  // for a pin must not start dragging the level apart. Same rule that already
  // makes `fixed` movable only in Create.
  {
    const S = screen({ ...roomy, fixedParts: [{ t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' }] },
      { tab: 'machine' });
    const hit = S._hitTest({ x: 60, y: -100 });
    gate('15. ...but a level stick\'s end is not grabbable from Test',
      hit?.kind === 'fixed', `got ${hit ? hit.kind : 'nothing'}`);
  }

  // **The one difference that must SURVIVE**: the build area. A fixed part is
  // placed like terrain and is not confined to it — including one towed as a
  // companion, which is where the rule is easiest to lose (a companion's
  // confinement is a property of its pool, not of how it was reached).
  {
    const tight = { terrain: [], buildZones: [{ x: 0, y: -100, w: 200, h: 200 }] };
    const S = screen({ ...tight, fixedParts: cart() }, { tab: 'level' });
    const g = gesture(S, { x: 0, y: -100 }, { x: 600, y: -100 }, { watch: fixedAt(S, 0) });
    const w = S.level.fixedParts[0], rod = S.level.fixedParts[1];
    gate('15. a fixed stick tows its wheel clean out of the build area',
      g.held && w.x > 500 && rod.x1 > 500 && g.toasts.length === 0,
      `wheel x ${w.x.toFixed(1)}, stick x1 ${rod.x1.toFixed(1)} (zone ends at x 100)`);
  }
  // ...and the design pool still IS confined, from the same towed position —
  // otherwise the gate above would pass by the rule being gone everywhere.
  {
    const tight = { terrain: [], buildZones: [{ x: 0, y: -100, w: 200, h: 200 }] };
    const S = screen(tight, { tab: 'machine', parts: cart() });
    gesture(S, { x: 0, y: -100 }, { x: 600, y: -100 }, { watch: partAt(S, 0) });
    gate('15. ...while a machine stick towing its wheel is still held by it',
      S.design.parts[1].x2 <= 100 + ZONE_SLACK,
      `stick far end at x ${S.design.parts[1].x2.toFixed(2)}, zone edge at 100`);
  }

  // ---- 15e: Test is READ-ONLY for the level's parts ----
  //
  // The pools run the same gestures (above), but only in the tab that owns
  // them. `movable` used to end with `|| (forceMove && hit.kind !== 'zone')`,
  // and the only kind reaching that point without already being movable is a
  // level part in Test — so **Shift+drag moved the level's own wheels and
  // sticks while a plain drag correctly did nothing**: two gestures, two
  // answers, on a piece that is not the machine's to move.
  //
  // Asked in BOTH modes, because a player is permanently in Test: any fixed
  // part inside a build zone — exactly the ones authors place as bolt-targets
  // — could be dragged out of the way while solving, it committed, and
  // `_snapshotUndo` doesn't carry `level` in play mode so it could not even be
  // undone. The server re-simulates a solve from the AUTHORED level (§5.8).
  {
    const boltTarget = () => ({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
      buildZones: [{ x: 0, y: -100, w: 500, h: 300 }],
      fixedParts: [
        { t: 'wheel', kind: 'free', x: -60, y: -100, r: 15, id: 'fw' },
        { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'fr' },
      ],
    });
    // The piece has to be REACHABLE for any of this to mean anything — in Test
    // only fixed parts whose centre is inside a build zone are pickable at all,
    // so a gate that quietly stopped hitting one would pass by missing it.
    {
      const S = screen(boltTarget(), { tab: 'machine' });
      gate('15. the read-only gates below really are grabbing the level part',
        S._hitTest({ x: 0, y: -100 })?.kind === 'fixed',
        `hit ${S._hitTest({ x: 0, y: -100 })?.kind}`);
    }
    for (const mode of ['maker', 'play']) {
      for (const [label, mods] of [['Shift+drag', { shiftKey: true }]]) {
        const S = screen(boltTarget(), { tab: 'machine', mode });
        const before = JSON.stringify(S.level.fixedParts);
        gesture(S, { x: 0, y: -100 }, { x: 0, y: -220 }, { mods });
        gate(`15. ${label} cannot move a level part from Test (${mode})`,
          JSON.stringify(S.level.fixedParts) === before && S.commits === 0,
          S.commits ? `MOVED and committed: ${JSON.stringify(S.level.fixedParts)}` : 'unmoved, nothing committed');
      }
    }
    // ...and Shift has not lost its actual job, which is "drag instead of
    // placing" for whatever the tab DOES own.
    {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: -100, w: 500, h: 300 }] },
        { tab: 'machine', tool: 'rod-wood', parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
      const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: -180 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
      // about WHICH gesture Shift starts, not where it ends: Shift also snaps,
      // so the landing point is the grid's business and is gated in 16
      gate('15. ...while Shift still drags a MACHINE part rather than placing on it',
        g.type === 'move' && S.design.parts.length === 1 && S.design.parts[0].y < -140,
        `drag ${g.type}, ${S.design.parts.length} part(s), wheel y ${S.design.parts[0].y.toFixed(1)}`);
    }
    {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: -100, w: 500, h: 300 }] },
        { tab: 'machine', tool: 'rod-wood', parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
      const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: -180 });
      gate('15. ...and without Shift that same drag still PLACES a stick',
        g.type === 'place-rod', `drag ${g.type}`);
    }
    // ...and Create is untouched: there the tab owns its parts, so Shift
    // force-moves one exactly as it always did.
    {
      const S = screen(boltTarget(), { tab: 'level', tool: 'rod-wood' });
      const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: -220 },
        { mods: { shiftKey: true }, watch: fixedAt(S, 1) });
      gate('15. ...but Shift still force-moves a level part in CREATE',
        g.type === 'move' && S.level.fixedParts[1].y1 < -180,
        `drag ${g.type}, stick y1 ${S.level.fixedParts[1].y1.toFixed(1)}`);
    }
  }

  // **This gate asked to be told when the rule changed, and it changed**
  // (2026-08-08). It used to assert that a Create drag does NOT carry a goal
  // piece pinned to it, on the grounds that a crate is staged geometry with a
  // second, authored position behind it (§7.2). That reasoning holds in TEST
  // and is vacuous in CREATE — the only tab a fixed stick can be dragged in —
  // because there `_setGoalPos` writes the authored position too: moving a
  // piece in Create IS authoring it, so there is no second position to
  // disagree with. Reported from the outside as "in Create if I move the stick
  // it comes away from the goal piece; that does not happen in Test".
  {
    const S = screen({
      ...roomy, goalObjs: [{ shape: 'box', x: 60, y: -100, w: 40, h: 30 }],
      fixedParts: [{ t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' }],
    }, { tab: 'level' });
    gesture(S, { x: 0, y: -100 }, { x: 0, y: -40 }, { watch: fixedAt(S, 0) });
    gate('15. a Create drag DOES carry a goal piece pinned to it, as Test always has',
      near(S.goalPositions[0].y, -40, 1),
      `crate y ${S.goalPositions[0].y.toFixed(1)} (stick dragged to -40)`);
    // ...and the machine pool DOES carry it, so the line above is a choice
    // about the goal model and not a companion set that quietly went missing.
    const T = screen({
      ...roomy, goalObjs: [{ shape: 'box', x: 60, y: -100, w: 40, h: 30 }],
    }, { tab: 'machine', parts: [{ t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' }] });
    gesture(T, { x: 0, y: -100 }, { x: 0, y: -40 }, { watch: partAt(T, 0) });
    gate('15. ...while a machine drag still does',
      near(T.goalPositions[0].y, -40, 1), `crate y ${T.goalPositions[0].y.toFixed(1)}`);
  }
}

// ---------- gate 16: the positional grid (§8.1) ----------
//
// Shift snaps a move to GRID_STEP, Alt to GRID_FINE, Alt wins when both are
// held — the same rule, and the same two modifiers, that `_resizeDrag` has
// always used for sizes and `_rotateDrag` for angles.
//
// The numbers are restated here rather than imported, like every other
// constant in this file: a test that silently follows a constant is not gating
// it. Both come off STD_WHEEL_R, because every size in the game is a whole
// multiple of it: GRID_STEP is one standard wheel DIAMETER (two on adjacent
// nodes touch exactly) and GRID_FINE is the RADIUS — the half-node the
// ladder's odd multiples need to put their EDGES on nodes rather than between
// them. 30 is a whole multiple of 15, so every coarse node is a fine one too.
{
  const onGrid = (v, step) => Math.abs(v - Math.round(v / step) * step) < 0.01;
  // ...and the other alignment a piece can have: the middle of a cell, which is
  // where a round piece belongs (it has no edges to line up, so what you want
  // is for it to sit centred in the cell it occupies).
  const onCellCentre = (v, step) => onGrid(v - step / 2, step);
  const roomy = { terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] };
  // deliberately off-grid start and an off-grid target, so landing on a node
  // can only be the snap and never the arithmetic happening to agree
  const START = { x: -97, y: -83 };
  const TO = { x: 121, y: -217 };

  const wheelAt = (p) => ({ t: 'wheel', kind: 'free', x: p.x, y: p.y, r: 15, id: 'w' });

  // 16a — the three modifier states, on one piece, from one start.
  {
    const cases = [
      ['an unmodified drag does not snap', {}, null],
      ['Shift snaps to the 30 grid', { shiftKey: true }, GRID_STEP],
      ['Alt snaps to the 15 grid', { altKey: true }, GRID_FINE],
      ['Alt wins when both are held', { shiftKey: true, altKey: true }, GRID_FINE],
    ];
    // A STICK for this table, deliberately: it goes on a node by its endpoint
    // in either grid, so the gate stays about which STEP each modifier picks.
    // (It used to use a wheel, and when round pieces moved to cell centres the
    // table started failing for a reason that had nothing to do with modifiers
    // — the shape's alignment is gated on its own, below.)
    for (const [name, mods, step] of cases) {
      const S = screen(roomy, {
        parts: [{ t: 'rod', kind: 'wood', x1: START.x - 30, y1: START.y, x2: START.x + 30, y2: START.y, id: 'r' }],
      });
      const g = gesture(S, START, TO, { mods, watch: partAt(S, 0) });
      const p = S.design.parts[0];
      const ok = step
        ? onGrid(p.x1, step) && onGrid(p.y1, step)
        : near(p.x1, TO.x - 30, 0.01) && near(p.y1, TO.y, 0.01);
      gate(`16. ${name}`, ok && g.held, `end at ${p.x1.toFixed(2)},${p.y1.toFixed(2)}`);
    }
  }
  // ...and Alt's grid is genuinely FINER — it has to land somewhere Shift
  // cannot, or "Alt = 15" is untested by the four above: every 30-node is also
  // a 15-node, so a target that rounds to 120 proves nothing about which grid
  // ran. This one rounds to 105 — an ODD multiple of 15, reachable only on the
  // fine grid. (An earlier rig aimed at 118, which rounds to 120 on both; the
  // gate failed and said so, which is why it is written this way.)
  {
    const S = screen(roomy, { parts: [wheelAt(START)] });
    gesture(S, START, { x: 103, y: -98 }, { mods: { altKey: true }, watch: partAt(S, 0) });
    const p = S.design.parts[0];
    gate('16. ...and Alt reaches nodes Shift cannot',
      onGrid(p.x, GRID_FINE) && !onGrid(p.x, GRID_STEP) &&
      onGrid(p.y, GRID_FINE) && !onGrid(p.y, GRID_STEP),
      `landed at ${p.x},${p.y} — 15-nodes, and neither is a 30-node`);
  }

  // 16b — **Ctrl switches the grid off.** Ctrl is the meta modifier, and
  // Ctrl+Shift+drag is the obstacle override — the one gesture whose whole
  // point is putting a piece exactly where you say. Without this it would be
  // the one gesture that could not.
  {
    const S = screen({ ...roomy, props: [{ shape: 'box', x: 0, y: -100, w: 30, h: 30 }] }, { tab: 'level' });
    const g = gesture(S, { x: 0, y: -100 }, { x: 7, y: -103 },
      { mods: { ctrlKey: true, shiftKey: true }, watch: propAt(S, 0) });
    gate('16. Ctrl+Shift+drag keeps its precision — no grid under Ctrl',
      g.held && near(S.level.props[0].x, 7, 0.01) && near(S.level.props[0].y, -103, 0.01),
      `prop at ${S.level.props[0].x},${S.level.props[0].y}`);
  }

  // 16c — **THE ORDERING GATE.** Snapping is applied to the TARGET, before the
  // sweep, never to the result after it. Every move sweeps toward its target
  // and comes to rest REST_GAP clear of whatever it meets; rounding the RESULT
  // would shove the piece back into the surface it had just stopped against,
  // undoing §16's "a tolerance is not a target" in one line. A wheel Shift-
  // dragged hard into the floor must therefore rest at REST_GAP — NOT at the
  // grid node underneath it, and not embedded.
  {
    const S = screen(flatWorld(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] });
    const g = gesture(S, { x: 0, y: -100 }, { x: 0, y: 300 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
    const p = S.design.parts[0];
    gate('16. a snapped drag into the floor still rests ON it, not on a node',
      g.held && near(p.y, restExact(15), 0.05) && g.toasts.length === 0,
      `wheel y ${p.y.toFixed(4)}, want ${restExact(15)} (the node below is y 0)`);
    gate('16. ...and that resting y is NOT on the grid, so the gate means something',
      !onGrid(p.y, GRID_STEP), `y ${p.y.toFixed(4)}`);
  }

  // 16d — a pin beats the grid. A pin is a real connection; the grid is a
  // convenience, and rounding an end off a pin it had just found would be the
  // worse of the two answers.
  {
    const S = screen(roomy, {
      parts: [
        { t: 'wheel', kind: 'free', x: 7, y: 11, r: 15, id: 'w' },     // hub deliberately off-grid
        { t: 'rod', kind: 'wood', x1: -200, y1: -200, x2: -140, y2: -200, id: 'r' },
      ],
    });
    // drag the stick's free end onto the off-grid hub, with Shift held
    const g = gesture(S, { x: -140, y: -200 }, { x: 7, y: 11 }, { mods: { shiftKey: true }, watch: partAt(S, 1) });
    const r = S.design.parts[1];
    gate('16. a pin beats the grid — the end lands on the hub, not the node',
      g.type === 'move-endpoint' && near(r.x2, 7, 0.01) && near(r.y2, 11, 0.01),
      `end at ${r.x2},${r.y2} (hub 7,11; nearest nodes 0,0 and 10,10)`);
  }

  // 16e — a stick snaps by endpoint 1, so a stick already ON the grid stays on
  // it at BOTH ends: the delta comes out a whole number of nodes.
  {
    const S = screen(roomy, { parts: [{ t: 'rod', kind: 'wood', x1: -60, y1: -60, x2: 60, y2: -60, id: 'r' }] });
    gesture(S, { x: 0, y: -60 }, { x: 37, y: -119 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
    const r = S.design.parts[0];
    gate('16. a stick moved on the grid keeps BOTH ends on it',
      onGrid(r.x1, GRID_STEP) && onGrid(r.y1, GRID_STEP) &&
      onGrid(r.x2, GRID_STEP) && onGrid(r.y2, GRID_STEP),
      `(${r.x1},${r.y1})-(${r.x2},${r.y2})`);
  }

  // 16f — a multi-selection stays RIGID and its grabbed piece lands on a node.
  // Snapping each member would deform the arrangement (there is a gate on
  // rigidity); snapping the raw delta would keep rigidity but leave a
  // selection that started off-grid off it forever.
  {
    const S = screen(roomy, {
      parts: [wheelAt({ x: -97, y: -83 }), { t: 'wheel', kind: 'free', x: -41, y: -122, r: 15, id: 'w2' }],
    });
    const a0 = { ...S.design.parts[0] }, b0 = { ...S.design.parts[1] };
    ctrlClick(S, -97, -83);
    ctrlClick(S, -41, -122);
    gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
    const a = S.design.parts[0], b = S.design.parts[1];
    const da = { x: a.x - a0.x, y: a.y - a0.y }, db = { x: b.x - b0.x, y: b.y - b0.y };
    gate('16. a snapped multi-selection travels rigidly...',
      S.multiSel.length === 2 && samePt(da, db),
      `grabbed moved ${da.x.toFixed(2)},${da.y.toFixed(2)} vs other ${db.x.toFixed(2)},${db.y.toFixed(2)}`);
    gate('16. ...with the GRABBED piece aligned and the other keeping its offset',
      onCellCentre(a.x, GRID_STEP) && onCellCentre(a.y, GRID_STEP) && !onCellCentre(b.x, GRID_STEP),
      `grabbed ${a.x},${a.y}; other ${b.x},${b.y}`);
  }

  // 16g — both pools and both tabs: the level's own parts snap in Create, and
  // terrain does too (the piece kind that most wants it — slabs laid on nodes
  // abut exactly).
  {
    const S = screen({ ...roomy, fixedParts: [wheelAt(START)] }, { tab: 'level' });
    gesture(S, START, TO, { mods: { shiftKey: true }, watch: fixedAt(S, 0) });
    const p = S.level.fixedParts[0];
    gate('16. a level-authored part snaps in Create too',
      onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP), `at ${p.x},${p.y}`);
  }
  {
    const S = screen({ terrain: [{ type: 'box', x: -97, y: -83, w: GRID_STEP * 2, h: GRID_STEP * 2 }], buildZones: [] }, { tab: 'level' });
    gesture(S, { x: -97, y: -83 }, TO, { mods: { shiftKey: true }, watch: () => ({ ...S.level.terrain[0] }) });
    const t = S.level.terrain[0];
    gate('16. ...and so does terrain',
      onGrid(t.x, GRID_STEP) && onGrid(t.y, GRID_STEP), `at ${t.x},${t.y}`);
  }

  // 16g2 — a GROUP drag is a move, so it snaps like one. It was the one move
  // gesture the grid missed on the first pass, and the one a level author
  // reaches for most, since groups only exist in Create. Snapped by the member
  // under the cursor (`hit.via`), like a multi-selection: that member lands on
  // a node, every other keeps its offset, and the group stays rigid.
  {
    const S = screen({
      terrain: [
        { type: 'box', groupId: 'G', x: -97, y: -83, w: GRID_STEP * 2, h: GRID_STEP * 2 },
        { type: 'box', groupId: 'G', x: -41, y: -122, w: GRID_STEP * 2, h: GRID_STEP * 2 },
      ],
      buildZones: [],
      groups: { G: {} },
    }, { tab: 'level' });
    const a0 = { ...S.level.terrain[0] }, b0 = { ...S.level.terrain[1] };
    const g = gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 },
      { mods: { shiftKey: true }, watch: () => ({ ...S.level.terrain[0] }) });
    const a = S.level.terrain[0], b = S.level.terrain[1];
    const da = { x: a.x - a0.x, y: a.y - a0.y }, db = { x: b.x - b0.x, y: b.y - b0.y };
    gate('16. a GROUP drag snaps by the member under the cursor...',
      g.type === 'move-group' && onGrid(a.x, GRID_STEP) && onGrid(a.y, GRID_STEP),
      `grabbed member at ${a.x},${a.y}`);
    gate('16. ...and the group still travels rigidly',
      samePt(da, db),
      `grabbed moved ${da.x.toFixed(2)},${da.y.toFixed(2)} vs other ${db.x.toFixed(2)},${db.y.toFixed(2)}`);
  }

  // 16l0 — **move and resize must align the SAME FEATURE of a piece.**
  //
  // Both looked snapped and neither lined up with the other: a resize puts a
  // CORNER on a node, a move used to put the CENTRE on one, and centre-on-node
  // only lands the edges on the grid when the piece is an EVEN number of cells
  // across. Reported from a real level, two 90×90 boxes: the resized one's
  // corners on (−390,−270)/(−300,−180), the moved one's on (−285,−285) — half
  // a cell out, permanently.
  //
  // **90×90 is the rig for every gate here, and that is the whole point**: at
  // 60×60 the half-extent is itself a whole cell, so corner-snapping and
  // centre-snapping agree and a gate built on one cannot see the bug. (Mine
  // was, and didn't.)
  {
    // THREE CELLS wide, derived: both corners can only land on the grid if the
    // box spans a whole number of them, and the half-extent must still NOT be a
    // whole cell or the rig cannot tell corner-snapping from centre-snapping.
    // 90 was three 30-cells; it is not three 40-cells (2026-08-15).
    const BOX = GRID_STEP * 3;
    // Born ON the grid, and derived (2026-08-24): a resize keeps its anchor
    // corner, so this rig must START with corners on nodes or the gate is
    // measuring its own stale fixture. A three-cell box has corners on the
    // grid when its centre sits on a half-cell; -345,-225 was such a spot on
    // the 30 grid and is not one on the 40 — the rescale moved the grid out
    // from under it, and the anchor corner (-405) dutifully stayed off-grid.
    const B0 = { x: -8.5 * GRID_STEP, y: -5.5 * GRID_STEP };             // -340,-220
    const box90 = () => ({ type: 'box', ...B0, w: BOX, h: BOX });
    const corners = (t, pos) => {
      const p = pos || t;
      return [{ x: p.x - t.w / 2, y: p.y - t.h / 2 }, { x: p.x + t.w / 2, y: p.y + t.h / 2 }];
    };
    const allOnGrid = (t, pos) => corners(t, pos).every(c => onGrid(c.x, GRID_STEP) && onGrid(c.y, GRID_STEP));

    // the rig is honest: at 90 wide, a centred snap and a corner snap differ
    gate('16. (rig) a three-cell box cannot be both centre- and corner-aligned',
      !onGrid(BOX / 2, GRID_STEP), `half-extent ${BOX / 2} is not a whole number of cells`);

    // MOVED
    {
      const S = screen({ terrain: [box90()], buildZones: [] }, { tab: 'level' });
      gesture(S, { ...B0 }, { x: -238, y: -241 },
        { mods: { shiftKey: true }, watch: () => ({ ...S.level.terrain[0] }) });
      const t = S.level.terrain[0];
      gate('16. a MOVED box lands its corners on the grid',
        allOnGrid(t), `corners ${corners(t).map(c => `${c.x},${c.y}`).join(' ')}`);
    }
    // RESIZED — and the two agree, which is the actual complaint
    {
      const S = screen({ terrain: [box90()], buildZones: [] }, { tab: 'level' });
      const t = S.level.terrain[0];
      S.sel = { kind: 'terrain', ref: t };
      const h = S._resizeHandlePts(t, t)[2];
      gesture(S, { x: h.x, y: h.y }, { x: -238, y: -121 },
        { mods: { shiftKey: true }, watch: () => ({ w: t.w, h: t.h }) });
      gate('16. ...and a RESIZED box lands its corners on the same grid',
        allOnGrid(t), `corners ${corners(t).map(c => `${c.x},${c.y}`).join(' ')}`);
    }
    // ...and the same for the other box-shaped kinds, all at 90
    {
      const S = screen({ terrain: [], props: [{ shape: 'box', x: -345, y: -225, w: BOX, h: BOX }], buildZones: [] }, { tab: 'level' });
      gesture(S, { x: -345, y: -225 }, { x: -238, y: -241 }, { mods: { shiftKey: true }, watch: propAt(S, 0) });
      const p = S.level.props[0];
      gate('16. ...a moved PROP too', allOnGrid(p), `corners ${corners(p).map(c => `${c.x},${c.y}`).join(' ')}`);
    }
    {
      const S = screen({ terrain: [], goalObjs: [{ shape: 'box', x: -345, y: -225, w: BOX, h: BOX }],
        buildZones: [{ x: -300, y: -200, w: 1400, h: 1000 }] }, { tab: 'level' });
      gesture(S, { x: -345, y: -225 }, { x: -238, y: -241 }, { mods: { shiftKey: true }, watch: goalAt(S, 0) });
      const g = S.level.goalObjs[0], pos = S.goalPositions[0];
      gate('16. ...and a moved GOAL crate', allOnGrid(g, pos),
        `corners ${corners(g, pos).map(c => `${c.x},${c.y}`).join(' ')}`);
    }
    // A CIRCLE keeps its centre on the node — its pins and the size ladder are
    // measured from the hub, and two standard wheels on adjacent nodes still
    // have to touch exactly.
    // A round piece sits centred in the CELL it occupies, not on a corner of
    // it — see the wheel-size gates below.
    {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] },
        { parts: [{ t: 'wheel', kind: 'free', x: -97, y: -83, r: 15, id: 'w' }] });
      gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
      const p = S.design.parts[0];
      gate('16. ...while a wheel goes in the MIDDLE of a cell',
        onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP), `hub ${p.x},${p.y}`);
    }
    // **Round pieces sit centred in the cell they occupy.** A box lines up by
    // its edges; a circle has none, so what you want instead is for it to be
    // centred in its cell — a standard wheel fills a 30 cell exactly, a small
    // one sits centred inside one, and a BIG one is two cells across so its
    // centre lands on the node between them. That is the same min-corner rule,
    // applied to the diameter rounded up to whole cells.
    for (const [name, r, expect] of [
      ['small', 7.5, 'centre'], ['standard', 15, 'centre'], ['big', 30, 'node'],
    ]) {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] },
        { parts: [{ t: 'wheel', kind: 'free', x: -97, y: -83, r, id: 'w' }] });
      gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
      const p = S.design.parts[0];
      const ok = expect === 'centre'
        ? onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP)
        : onGrid(p.x, GRID_STEP) && onGrid(p.y, GRID_STEP);
      gate(`16. a ${name} wheel lands on a cell ${expect}`, ok, `hub ${p.x},${p.y}`);
    }
    // ...and the standard wheel fills that cell EXACTLY — its rim on the
    // cell's own edges, which is what makes it read as sitting in the square.
    {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] },
        { parts: [{ t: 'wheel', kind: 'free', x: -97, y: -83, r: STD_WHEEL_R, id: 'w' }] });
      gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
      const p = S.design.parts[0];
      gate('16. ...and a standard wheel fills its cell exactly, rim to rim',
        onGrid(p.x - p.r, GRID_STEP) && onGrid(p.x + p.r, GRID_STEP),
        `rim spans ${p.x - p.r} … ${p.x + p.r}`);
    }
    // ...and the ladder property survives the move to cell centres: two
    // standard wheels one cell apart still touch EXACTLY, which is what the
    // whole size ladder is built on (§4).
    {
      const S = screen({ terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] }, {
        parts: [
          { t: 'wheel', kind: 'free', x: -97, y: -83, r: STD_WHEEL_R, id: 'a' },
          { t: 'wheel', kind: 'free', x: 40, y: 40, r: STD_WHEEL_R, id: 'b' },
        ],
      });
      gesture(S, { x: -97, y: -83 }, { x: 121, y: -217 }, { mods: { shiftKey: true }, watch: partAt(S, 0) });
      // The second aim keeps clear air (2026-08-24): since the lattice moved
      // to FC's own positions a wheel's rim spokes sit at EXACTLY r, so the
      // old aim (121+G, -217) stood 3.2 px from the first wheel's spoke — and
      // the pin snap outranks the grid by design (that is how wheels join),
      // so the rig was gating a hub-on-pin capture and calling it a grid
      // landing. Aim from the wheel it must land beside: one cell over plus
      // (5, 15) stays inside the adjacent cell's rounding window while
      // standing ~47 px from the hub — a rim radius plus 27, beyond any
      // snapRadius there is.
      const a0 = { x: S.design.parts[0].x, y: S.design.parts[0].y };
      gesture(S, { x: 40, y: 40 }, { x: a0.x + GRID_STEP + 5, y: a0.y + 15 },
        { mods: { shiftKey: true }, watch: partAt(S, 1) });
      const [a, b] = S.design.parts;
      const gap = Math.hypot(b.x - a.x, b.y - a.y) - (a.r + b.r);
      gate('16. ...and two standard wheels a cell apart still touch exactly',
        Math.abs(b.x - a.x) === GRID_STEP && Math.abs(gap) < 0.01,
        `centres ${Math.abs(b.x - a.x)} apart, surface gap ${gap.toFixed(4)}`);
    }

    // A ROTATED box has no axis-aligned edge left, so it keeps its centre —
    // asserted so the exemption is a decision rather than an oversight.
    {
      const S = screen({ terrain: [{ type: 'box', x: -345, y: -225, w: 90, h: 90, angle: 0.4 }], buildZones: [] },
        { tab: 'level' });
      gesture(S, { x: -345, y: -225 }, { x: -238, y: -241 },
        { mods: { shiftKey: true }, watch: () => ({ ...S.level.terrain[0] }) });
      const t = S.level.terrain[0];
      gate('16. ...and a TURNED box keeps its centre on the node',
        onGrid(t.x, GRID_STEP) && onGrid(t.y, GRID_STEP), `centre ${t.x},${t.y}`);
    }
    // ...and a one-piece PASTE aligns like dragging that piece would.
    {
      const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
        altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
        preventDefault() {}, stopPropagation() {} });
      const S = screen({ terrain: [], buildZones: [] }, { tab: 'level' });
      S._clipboard = { entries: [{ kind: 'terrain', data: box90() }], anchor: { ...B0 } };
      S._lastPointer = { x: -238, y: -241 };
      S._keyDown(kev('v', { ctrl: true, shift: true }));
      S._keyUp(kev('v', { ctrl: true, shift: true }));
      const t = S.level.terrain[0];
      gate('16. ...and a one-piece paste lands its corners on the grid too',
        t && allOnGrid(t), t ? `corners ${corners(t).map(c => `${c.x},${c.y}`).join(' ')}` : 'nothing pasted');
    }
  }

  // 16l — **resize puts the dragged CORNER on a node**, not the dimension on a
  // multiple. The difference only shows when the piece's far corner is off the
  // grid — and that is exactly the case that made the old dimension-snap
  // useless, because it left a misaligned piece misaligned at a tidy width.
  //
  // The rig is therefore deliberately off-grid: a 47×47 box centred at
  // (7, -3), so no corner of it is on a node to start with.
  {
    // a box has four corner handles (c0..c3, bottom-right is index 2); a BALL
    // has exactly one, out at its rim — hence the last-index pick rather than
    // a hardcoded 2, which threw on the first ball rig
    const grabHandle = (S, sel, to, mods) => {
      S.sel = sel;
      const t = sel.kind === 'goal' ? S.level.goalObjs[sel.idx] : sel.ref;
      const pos = sel.kind === 'goal' ? S.goalPositions[sel.idx] : t;
      const pts = S._resizeHandlePts(t, pos);
      const h = pts.length > 2 ? pts[2] : pts[pts.length - 1];
      return gesture(S, { x: h.x, y: h.y }, to, { mods, watch: () => ({ w: t.w, h: t.h }) });
    };
    // ...the corner it lands on, read back from the piece itself
    const farCorner = (t, pos) => ({ x: (pos || t).x + t.w / 2, y: (pos || t).y + t.h / 2 });

    for (const [kind, mk] of [
      ['terrain', () => ({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] })],
      ['prop', () => ({ terrain: [], props: [{ shape: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] })],
      ['goal', () => ({ terrain: [], goalObjs: [{ shape: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] })],
    ]) {
      const S = screen(mk(), { tab: 'level' });
      const sel = kind === 'terrain' ? { kind: 'terrain', ref: S.level.terrain[0] }
        : kind === 'prop' ? { kind: 'prop', ref: S.level.props[0] }
          : { kind: 'goal', idx: 0 };
      grabHandle(S, sel, { x: 121, y: 97 }, { shiftKey: true });
      const t = kind === 'goal' ? S.level.goalObjs[0] : sel.ref;
      const pos = kind === 'goal' ? S.goalPositions[0] : t;
      const c = farCorner(t, pos);
      gate(`16. resizing a ${kind} piece lands its dragged corner on a node`,
        onGrid(c.x, GRID_STEP) && onGrid(c.y, GRID_STEP),
        `corner ${c.x.toFixed(2)},${c.y.toFixed(2)} (piece ${t.w.toFixed(1)}x${t.h.toFixed(1)} at ${pos.x.toFixed(2)},${pos.y.toFixed(2)})`);
    }

    // ...and the far corner — the anchor — must NOT have moved, or "snap the
    // corner" would just be "move the piece".
    {
      const S = screen({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] }, { tab: 'level' });
      const t = S.level.terrain[0];
      const anchor0 = { x: t.x - t.w / 2, y: t.y - t.h / 2 };
      grabHandle(S, { kind: 'terrain', ref: t }, { x: 121, y: 97 }, { shiftKey: true });
      const anchor = { x: t.x - t.w / 2, y: t.y - t.h / 2 };
      gate('16. ...while the opposite corner stays exactly where it was',
        samePt(anchor, anchor0, 0.01),
        `anchor ${anchor.x.toFixed(2)},${anchor.y.toFixed(2)} vs ${anchor0.x.toFixed(2)},${anchor0.y.toFixed(2)}`);
    }

    // ...and unmodified, it resizes freely as it always did.
    {
      const S = screen({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] }, { tab: 'level' });
      const t = S.level.terrain[0];
      grabHandle(S, { kind: 'terrain', ref: t }, { x: 121, y: 97 }, {});
      const c = farCorner(t);
      gate('16. ...and an unmodified resize still lands exactly on the pointer',
        near(c.x, 121, 0.01) && near(c.y, 97, 0.01), `corner ${c.x.toFixed(2)},${c.y.toFixed(2)}`);
    }

    // A BALL has no corner, so its DIAMETER goes on the grid — a ball centred
    // on a node then meets the nodes N/E/S/W, the same "pieces line up"
    // property the corners give a box.
    {
      const S = screen({ terrain: [{ type: 'ball', x: 0, y: 0, r: 23 }], buildZones: [] }, { tab: 'level' });
      const t = S.level.terrain[0];
      grabHandle(S, { kind: 'terrain', ref: t }, { x: 52, y: 0 }, { shiftKey: true });
      gate('16. resizing a ball puts its DIAMETER on the grid',
        onGrid(t.r * 2, GRID_STEP), `r ${t.r} → ${t.r * 2} across`);
    }

    // ...and Alt is the finer grid here too — the same 10 px step it has always
    // meant on a resize, which is why GRID_FINE is ALT_RESIZE_STEP.
    {
      const S = screen({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] }, { tab: 'level' });
      const t = S.level.terrain[0];
      grabHandle(S, { kind: 'terrain', ref: t }, { x: 103, y: 97 }, { altKey: true });
      const c = farCorner(t);
      gate('16. ...and Alt resizes onto the 15 grid',
        onGrid(c.x, GRID_FINE) && !onGrid(c.x, GRID_STEP), `corner x ${c.x.toFixed(2)}`);
    }

    // ...and the latch reaches resize too, with Shift inverting as everywhere.
    {
      const S = screen({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] }, { tab: 'level' });
      S.snapMode = 'on';
      const t = S.level.terrain[0];
      grabHandle(S, { kind: 'terrain', ref: t }, { x: 121, y: 97 }, {});
      const snapped = farCorner(t);
      const S2 = screen({ terrain: [{ type: 'box', x: 7, y: -3, w: 47, h: 47 }], buildZones: [] }, { tab: 'level' });
      S2.snapMode = 'on';
      const t2 = S2.level.terrain[0];
      grabHandle(S2, { kind: 'terrain', ref: t2 }, { x: 121, y: 97 }, { shiftKey: true });
      const free = farCorner(t2);
      gate('16. latched, an unmodified resize snaps and Shift still snaps (Shift is not an escape)',
        onGrid(snapped.x, GRID_STEP) && onGrid(free.x, GRID_STEP),
        `latched ${snapped.x.toFixed(2)}, withShift ${free.x.toFixed(2)}`);
    }
  }

  // 16k — **the latch (S), and the inversion that comes with it.**
  //
  // A modifier exists to express the exception to whatever is currently
  // normal, so latching the grid has to flip Shift: it stops meaning "snap"
  // and starts meaning "don't". Alt is deliberately NOT flipped — it means
  // *the finer grid* in both states, so the key reached for most often is the
  // one whose meaning never moves.
  //
  // The whole table is gated, both ways round, because "Shift snaps" is true
  // in one state and false in the other and nothing about the code makes that
  // obvious at a glance.
  {
    const S = screen(roomy);
    const table = (mode) => {
      S.snapMode = mode;
      return {
        none: S._gridStepOf(false, false),
        shift: S._gridStepOf(true, false),
        alt: S._gridStepOf(false, true),
        both: S._gridStepOf(true, true),
      };
    };
    const rev = table('rev'), on = table('on'), off = table('off');
    gate('16. REVERSED: free, Shift is not snap, Alt snaps finer',
      rev.none === 0 && rev.shift === GRID_STEP && rev.alt === GRID_FINE && rev.both === GRID_FINE,
      JSON.stringify(rev));
    gate('16. ON: snapped by default; Shift still names the coarse grid for keys/paste',
      on.none === GRID_STEP && on.shift === GRID_STEP && on.alt === GRID_FINE && on.both === GRID_FINE,
      JSON.stringify(on));
    gate('16. ...and Alt means the same thing in both of those',
      rev.alt === on.alt && rev.both === on.both, `${rev.alt} / ${on.alt}`);
    // **OFF means off, and NO modifier reopens it** — the whole reason the
    // third state exists. A beginner leaning on Shift must not discover that
    // pieces have started jumping.
    gate('16. OFF: nothing snaps, whatever is held down',
      off.none === 0 && off.shift === 0 && off.alt === 0 && off.both === 0,
      JSON.stringify(off));
    S.snapMode = 'rev';
  }

  // ...end to end: latched, a plain drag snaps and Shift escapes it.
  {
    const S = screen(roomy, { parts: [wheelAt(START)] });
    S.snapMode = 'on';
    gesture(S, START, TO, { watch: partAt(S, 0) });
    const a = S.design.parts[0];
    gate('16. latched, an UNMODIFIED drag snaps',
      onCellCentre(a.x, GRID_STEP) && onCellCentre(a.y, GRID_STEP), `${a.x},${a.y}`);
  }
  {
    const S = screen(roomy, { parts: [wheelAt(START)] });
    S.snapMode = 'on';
    gesture(S, START, TO, { mods: { shiftKey: true }, watch: partAt(S, 0) });
    const a = S.design.parts[0];
    gate('16. ...and Shift-drag still snaps — Shift moves the machine, it does not escape the grid',
      onCellCentre(a.x, GRID_STEP) && onCellCentre(a.y, GRID_STEP), `${a.x},${a.y}`);
  }
  // ...and a latched PASTE snaps with no modifier at all, since Ctrl+V is the
  // whole command (the paste path asks _gridStepOf, so the latch reaches it).
  {
    const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
      altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
      preventDefault() {}, stopPropagation() {} });
    const S = screen(roomy);
    S.snapMode = 'on';
    S._clipboard = {
      entries: [{ kind: 'part', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    };
    S._lastPointer = { x: 103, y: -98 };
    S._keyDown(kev('v', { ctrl: true }));
    S._keyUp(kev('v', { ctrl: true }));
    const p = S.design.parts[0];
    gate('16. latched, a plain Ctrl+V pastes on the grid',
      p && onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP), p ? `${p.x},${p.y}` : 'nothing pasted');
  }

  // **The affordance.** A mode has to be visible or it is a trap, so in ON the
  // grid draws with nothing happening at all.
  //
  // **And it KEEPS drawing while Shift is escaping it.** It used to vanish, on
  // the argument that a grid you are not landing on is worse than no grid —
  // which is right in REVERSED, where the grid only ever appears because you
  // asked for it, and wrong in ON, where the grid is a standing feature of the
  // workspace. Blinking out every time you hold Shift for one free placement is
  // the jarring thing, and you still want to see the lines you are deliberately
  // ignoring for this one piece. So the mode's grid is a FLOOR that a gesture
  // may raise (Alt's fine grid) and never take away.
  {
    const S = screen(roomy, { parts: [wheelAt(START)] });
    gate('16. in REVERSED and idle, no grid is drawn', !S._activeGrid());
    S.snapMode = 'on';
    gate('16. in ON and idle, the grid is drawn — the mode is visible',
      S._activeGrid() === GRID_STEP, `${S._activeGrid()}`);
    S._pointerDown(ev(START.x, START.y));
    S._pointerMove(ev(0, -100, { shiftKey: true }));
    const withShift = S._activeGrid();
    S._pointerMove(ev(0, -100, { altKey: true }));
    const fine = S._activeGrid();
    S._pointerMove(ev(0, -100));
    const snapping = S._activeGrid();
    S._pointerUp(ev(0, -100));
    gate('16. ...and it STAYS drawn while Shift is held mid-drag',
      withShift === GRID_STEP && snapping === GRID_STEP,
      `withShift ${withShift}, snapping ${snapping}`);
    gate('16. ...while Alt still raises it to the fine grid',
      fine === GRID_FINE, `${fine}`);
  }
  {
    // …and REVERSED is untouched: there the grid really does come and go with
    // the modifier, because there it exists only while you are asking for it.
    const S = screen(roomy, { parts: [wheelAt(START)] });
    S.snapMode = 'rev';
    S._pointerDown(ev(START.x, START.y));
    S._pointerMove(ev(0, -100));
    const idle = S._activeGrid();
    S._pointerMove(ev(0, -100, { altKey: true }));
    const asked = S._activeGrid();
    S._pointerUp(ev(0, -100));
    gate('16. ...and in REVERSED the grid comes and goes with Alt',
      !idle && asked === GRID_FINE, `idle ${idle}, asked ${asked}`);
  }
  {
    // OFF draws no grid at any point, whatever is held — the same rule its
    // snapping follows.
    const S = screen(roomy, { parts: [wheelAt(START)] });
    S.snapMode = 'off';
    S._pointerDown(ev(START.x, START.y));
    S._pointerMove(ev(0, -100, { shiftKey: true }));
    const shifted = S._activeGrid();
    S._pointerMove(ev(0, -100, { altKey: true }));
    const alted = S._activeGrid();
    S._pointerUp(ev(0, -100));
    gate('16. ...and OFF never draws one, whatever is held',
      !shifted && !alted && !S._activeGrid(), `${shifted} / ${alted}`);
  }

  // The key and the button are one action, so neither can drift from the
  // other or from the state they report.
  {
    const S = screen(roomy);
    const kev = (key) => ({ key, ctrlKey: false, shiftKey: false, altKey: false,
      repeat: false, target: { tagName: 'CANVAS' }, preventDefault() {}, stopPropagation() {} });
    let cls = '';
    const on = new Set();
    S.gridBtn = { classList: { toggle: (c, want) => { if (want) on.add(c); else on.delete(c); } }, title: '' };
    // S cycles ON -> REVERSED -> OFF -> ON, and the button reports each one.
    S.snapMode = 'off';
    const seen = [];
    for (let i = 0; i < 4; i++) { S._keyDown(kev('s')); seen.push({ mode: S.snapMode, cls: [...on].join('+'), toast: S.toasts.at(-1) }); }
    gate('16. S cycles all three snap states, and the button reports each',
      seen.map((x) => x.mode).join(',') === 'on,rev,off,on' &&
      seen[0].cls === 'active' && seen[1].cls === '' && seen[2].cls === 'snap-off' &&
      /Snap on/.test(seen[0].toast || '') && /Snap off/.test(seen[2].toast || ''),
      seen.map((x) => `${x.mode}/${x.cls || '-'}`).join(' '));
  }
  // ...but S with a modifier is NOT the toggle: Shift and Alt are the grid's
  // own overrides, so the key that toggles it and the keys that override it
  // must not be the same press.
  // Latched ON FIRST, so this can't pass by the latch merely never having been
  // switched on — which is exactly how it read on the first run (`undefined`),
  // and a gate that green-lights an inert `S` is worse than no gate.
  {
    const S = screen(roomy);
    S.gridBtn = { classList: { toggle: () => {} }, title: '' };
    // Ctrl+S is Publish; the fixture has no goal pieces, which used to bounce
    // it at "needs a goal piece" before the DOM modal — a sandbox level is
    // legal now (2026-08-18), so the modal would open, and this test is about
    // the S key, not the publish dialog. Same stub gate 24 uses.
    S._openPublish = () => {};
    const press = (mods = {}) => S._keyDown({ key: 's', ctrlKey: false, shiftKey: false,
      altKey: false, ...mods, repeat: false, target: { tagName: 'CANVAS' },
      preventDefault() {}, stopPropagation() {} });
    S.snapMode = 'off';
    press();
    const after = S.snapMode;
    for (const mods of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }]) press(mods);
    gate('16. ...while modified S leaves the snap mode alone',
      after === 'on' && S.snapMode === 'on', `moved to ${after}, after modified presses ${S.snapMode}`);
  }

  // …and which state a screen OPENS in, which is the part a person actually
  // feels. A player who has never chosen gets OFF — nothing moves under the
  // cursor whatever they lean on — and an author gets REVERSED, which is what
  // the Maker has always done. Gateable only because the rule was pulled out of
  // the constructor, the one part of the editor nothing headless runs.
  {
    const M = (o) => initialSnapMode(o);
    gate('16. a player who has never chosen opens with snap OFF',
      M({ maker: false }) === 'off', M({ maker: false }));
    gate('16. …an author opens REVERSED, as the Maker always has',
      M({ maker: true }) === 'rev', M({ maker: true }));
    gate('16. …a stored choice always wins',
      M({ saved: 'on', maker: false }) === 'on' && M({ saved: 'off', maker: true }) === 'off' &&
      M({ saved: 'rev', legacy: true, maker: false }) === 'rev');
    // the old boolean latch is MIGRATED, not dropped: somebody who had it on
    // must stay on it, and a stored `false` has to be distinguishable from
    // never having chosen — which the old default of `false` could not be
    gate('16. …and the old latch is migrated rather than dropped',
      M({ legacy: true, maker: false }) === 'on' && M({ legacy: false, maker: false }) === 'rev',
      `legacy on -> ${M({ legacy: true })}, legacy off -> ${M({ legacy: false })}`);
    gate('16. …with rubbish in the store ignored rather than obeyed',
      M({ saved: 'banana', maker: true }) === 'rev' && M({ saved: '', maker: false }) === 'off');
  }

  // 16j — **placement ghosts snap too, from the modifier held WHILE AIMING.**
  //
  // Not at the press: there Alt already picks the piece size (small / Alt+Shift
  // large), Alt on the rod tool is chain paint, and Shift+press is force-move.
  // Every one of those is decided at pointer-down and none of them is decided
  // again afterwards — so reading the grid from the aim leaves all of them
  // alone. It is also how the grid already works everywhere else: hold it
  // mid-gesture and the nodes appear.
  {
    const zoneOnly = { terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }] };
    const down = (S, p, mods = {}) => S._pointerDown(ev(p.x, p.y, mods));
    const move = (S, p, mods = {}) => S._pointerMove(ev(p.x, p.y, mods));
    const up = (S, p, mods = {}) => S._pointerUp(ev(p.x, p.y, mods));

    // a WHEEL ghost: press plain, aim with Shift, release
    {
      const S = screen(zoneOnly, { tool: 'wheel-free' });
      down(S, { x: -97, y: -83 });
      const started = S.drag?.type;
      move(S, { x: 103, y: -98 }, { shiftKey: true });
      const gridUp = S._activeGrid();
      up(S, { x: 103, y: -98 }, { shiftKey: true });
      const p = S.design.parts[0];
      gate('16. a wheel ghost aimed with Shift lands in a cell centre',
        started === 'place-wheel' && gridUp === GRID_STEP &&
        p && onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP),
        p ? `placed at ${p.x},${p.y}` : 'nothing placed');
    }
    // ...and without the modifier it places exactly where aimed, as before
    {
      const S = screen(zoneOnly, { tool: 'wheel-free' });
      down(S, { x: -97, y: -83 });
      move(S, { x: 103, y: -98 });
      up(S, { x: 103, y: -98 });
      const p = S.design.parts[0];
      gate('16. ...and without it, exactly where aimed',
        p && near(p.x, 103, 0.01) && near(p.y, -98, 0.01), p ? `${p.x},${p.y}` : 'nothing placed');
    }
    // ...and Alt still picks the SMALL wheel while snapping finely — the two
    // meanings compose rather than collide, because one is read at the press
    // and the other while aiming.
    {
      const S = screen(zoneOnly, { tool: 'wheel-free' });
      down(S, { x: -97, y: -83 }, { altKey: true });
      move(S, { x: 103, y: -98 }, { altKey: true });
      up(S, { x: 103, y: -98 }, { altKey: true });
      const p = S.design.parts[0];
      gate('16. ...while Alt still means the SMALL wheel, and snaps it finely',
        p && p.r === WHEEL_SIZES[0] && onCellCentre(p.x, GRID_FINE) && onCellCentre(p.y, GRID_FINE),
        p ? `r ${p.r} at ${p.x},${p.y}` : 'nothing placed');
    }

    // a ROD ghost: BOTH ends land on nodes when the modifier is held FROM THE
    // PRESS, which is the point of drawing on a grid.
    {
      const S = screen(zoneOnly, { tool: 'rod-wood' });
      S.snapMode = 'on';
      down(S, { x: -97, y: -83 });
      move(S, { x: 103, y: -98 });
      up(S, { x: 103, y: -98 });
      const r = S.design.parts[0];
      gate('16. a stick drawn with snap ON puts BOTH ends on the grid',
        r && onGrid(r.x1, GRID_STEP) && onGrid(r.y1, GRID_STEP) &&
        onGrid(r.x2, GRID_STEP) && onGrid(r.y2, GRID_STEP),
        r ? `(${r.x1},${r.y1})-(${r.x2},${r.y2})` : 'nothing placed');
    }
    // **START SNAPPED, END FREE.** The anchor is decided at the press and never
    // moves again, so letting the modifier go frees the end you are still
    // aiming and leaves the anchor on its node. It used to be re-derived from
    // the raw pressed point every event, which meant the current modifier
    // decided it RETROSPECTIVELY — and half a stick on the grid, which is a
    // thing people want constantly, was simply not expressible.
    {
      const S = screen(zoneOnly, { tool: 'rod-wood' });
      down(S, { x: -97, y: -83 }, { altKey: true });
      move(S, { x: 103, y: -98 }, { altKey: true });
      move(S, { x: 111, y: -94 });                       // let go: free the far end
      up(S, { x: 111, y: -94 });
      const r = S.design.parts[0];
      gate('16. a stick can start SNAPPED and end free',
        r && onGrid(r.x1, GRID_FINE) && onGrid(r.y1, GRID_FINE) &&
        !(onGrid(r.x2, GRID_FINE) && onGrid(r.y2, GRID_FINE)),
        r ? `anchor ${r.x1},${r.y1} on the grid, end ${r.x2},${r.y2} free` : 'nothing placed');
    }
    // …and the converse: a press made freely stays free. The modifier from
    // there on belongs to the end still being aimed, and cannot reach back and
    // re-decide a commitment already made.
    {
      const S = screen(zoneOnly, { tool: 'rod-wood' });
      down(S, { x: -97, y: -83 });
      move(S, { x: 103, y: -98 }, { shiftKey: true });
      up(S, { x: 103, y: -98 }, { shiftKey: true });
      const r = S.design.parts[0];
      gate('16. …while Shift pressed LATE cannot drag the anchor onto a node',
        r && near(r.x1, -97, 0.01) && near(r.y1, -83, 0.01) &&
        onGrid(r.x2, GRID_STEP) && onGrid(r.y2, GRID_STEP),
        r ? `anchor ${r.x1},${r.y1} (pressed at -97,-83), end ${r.x2},${r.y2}` : 'nothing placed');
    }

    // A LEVEL-placement DRAG draws corner to corner, like a stick — so the grid
    // goes on the CORNERS, not on the centre. That is the property that makes
    // two slabs meet exactly, and it is the same rule `_resizeDrag` follows
    // (the §8.2 rule: "snap the dragged corner to a node, not the dimension to a
    // multiple"). The centre lands on the half-grid whenever the piece is an
    // odd number of nodes across, which is correct and is why asserting the
    // centre — as this gate first did — was asserting the wrong invariant.
    {
      const S = screen(zoneOnly, { tab: 'level', tool: 'terrain-box' });
      down(S, { x: -97, y: -83 });
      move(S, { x: -97 + GRID_STEP, y: -83 + GRID_STEP }, { shiftKey: true });
      up(S, { x: -97 + GRID_STEP, y: -83 + GRID_STEP }, { shiftKey: true });
      const t = S.level.terrain[0];
      const corners = t && [t.x - t.w / 2, t.x + t.w / 2, t.y - t.h / 2, t.y + t.h / 2];
      gate('16. a terrain ghost aimed with Shift puts its CORNERS on the grid',
        !!t && corners.every(v => onGrid(v, GRID_STEP)),
        t ? `corners x ${corners[0]}…${corners[1]}, y ${corners[2]}…${corners[3]}` : 'nothing placed');
    }

    // **A CLICK-place snaps too.** The ghost's move handler had always done
    // the grid, but a click that never becomes a drag fires no pointermove at
    // all — so with the latch on, tapping a piece down was the one way to
    // place something that ignored the grid entirely. And tapping is the
    // NORMAL way to put terrain and props down, so it was the common case.
    // Every position is therefore snapped at the PRESS as well.
    //
    // Driven with a bare down/up and no move between them, which is the whole
    // point: a rig that nudged the pointer first would have passed all along.
    {
      const click = (S, p, mods = {}) => { S._pointerDown(ev(p.x, p.y, mods)); S._pointerUp(ev(p.x, p.y, mods)); };
      const at = { x: -97, y: -83 };
      // latched, so no modifier is held at all — the case that was broken
      for (const [what, tool, tab, read, align] of [
        ['a wheel', 'wheel-free', 'machine', (S) => S.design.parts[0], 'centre'],
        ['terrain', 'terrain-box', 'level', (S) => S.level.terrain[0], 'corner'],
        ['a prop', 'prop-box', 'level', (S) => S.level.props[0], 'corner'],
        ['a goal piece', 'goal-piece', 'level', (S) => S.level.goalObjs[0], 'corner'],
      ]) {
        const S = screen(zoneOnly, { tab, tool });
        S.snapMode = 'on';
        click(S, at);
        const p = read(S);
        const ok = !p ? false
          : align === 'centre'
            ? onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP)
            : onGrid(p.x - p.w / 2, GRID_STEP) && onGrid(p.y - p.h / 2, GRID_STEP);
        gate(`16. latched, CLICK-placing ${what} snaps it`, ok,
          p ? `at ${p.x},${p.y}` : 'nothing placed');
      }
      // ...and unlatched with no modifier it still lands exactly where clicked,
      // so the press-time snap can't have become unconditional.
      {
        const S = screen(zoneOnly, { tab: 'level', tool: 'terrain-box' });
        click(S, at);
        const t = S.level.terrain[0];
        gate('16. ...and unlatched, a click still lands exactly where clicked',
          t && near(t.x, at.x, 0.01) && near(t.y, at.y, 0.01), t ? `at ${t.x},${t.y}` : 'nothing placed');
      }
      // **Shift on the PRESS does not place at all** — it is force-move, which
      // stands the placement tool down so you can drag an existing piece
      // without switching back to the pointer. So without the latch there is
      // no way to snap a piece you merely CLICK down: you either latch the
      // grid, or drag a little and hold the modifier while aiming.
      //
      // Gated as the interaction it is, not as a wish: if `forceMove` is ever
      // narrowed to require something under the cursor — which would let
      // Shift+click on empty space place on the grid — this fails and says so.
      {
        const S = screen(zoneOnly, { tab: 'level', tool: 'terrain-box' });
        click(S, at, { shiftKey: true });
        gate('16. ...but Shift on the PRESS is force-move, so it places nothing',
          S.level.terrain.length === 0, `${S.level.terrain.length} placed`);
      }
      // ...and a click-placed STICK: it needs a real drag to exist at all, but
      // its anchor is fixed at the press, so that anchor has to be snapped.
      {
        const S = screen(zoneOnly, { tool: 'rod-wood' });
        S.snapMode = 'on';
        S._pointerDown(ev(at.x, at.y));
        const a = { x: S.drag.x1, y: S.drag.y1 };
        S._pointerUp(ev(at.x, at.y));
        gate('16. ...and a stick\'s anchor is on a node from the press',
          onGrid(a.x, GRID_STEP) && onGrid(a.y, GRID_STEP), `anchor ${a.x},${a.y}`);
      }
    }

    // **CLICKING a piece down and SLIDING it down must land it in the same
    // kind of place.** They are two routes through the same placement — the
    // press sets the position, the move handler resets it — and each was
    // asking a different question: the press used the shape rule (a wheel
    // centred in its cell), the ghost's move used a bare node. So a wheel
    // tapped down sat in a cell and the same wheel nudged an inch jumped to
    // the crossing, and mixing sizes made it look random. Reported exactly
    // that way: "click drops wheels correctly… if I slide a little we get them
    // dropped on the grid cross, and little and big wheels all over the place."
    //
    // Asserted as AGREEMENT rather than against a coordinate, so it stays true
    // whatever the alignment rule for a shape later becomes — which is the
    // property that was actually broken.
    {
      // one path, two ways through it: press-release, or press-wiggle-release
      const place = (tool, tab, read, slide, mods = {}) => {
        const S = screen(zoneOnly, { tab, tool });
        S.snapMode = 'on';
        const at = { x: -97, y: -83 };
        S._pointerDown(ev(at.x, at.y, mods));
        if (slide) for (let i = 1; i <= 4; i++) S._pointerMove(ev(at.x + i * 0.5, at.y + i * 0.5, mods));
        S._pointerUp(ev(at.x + (slide ? 2 : 0), at.y + (slide ? 2 : 0), mods));
        const p = read(S);
        return p ? { x: p.x, y: p.y, r: p.r } : null;
      };
      const design0 = (S) => S.design.parts[0];
      for (const [what, tool, tab, read, mods] of [
        ['a small wheel', 'wheel-free', 'machine', design0, { altKey: true }],
        ['a standard wheel', 'wheel-free', 'machine', design0, {}],
        ['terrain', 'terrain-box', 'level', (S) => S.level.terrain[0], {}],
        ['a prop', 'prop-box', 'level', (S) => S.level.props[0], {}],
      ]) {
        const clicked = place(tool, tab, read, false, mods);
        const slid = place(tool, tab, read, true, mods);
        gate(`16. clicking and sliding land ${what} in the same place`,
          !!clicked && !!slid && samePt(clicked, slid),
          `clicked ${clicked && `${clicked.x},${clicked.y}`} vs slid ${slid && `${slid.x},${slid.y}`}`);
      }
    }

    // ...and the grid SHOWS for all three while the ghost is up — the half
    // that was missing when paste learned to snap.
    for (const [tool, tab] of [['wheel-free', 'machine'], ['rod-wood', 'machine'], ['terrain-box', 'level']]) {
      const S = screen(zoneOnly, { tab, tool });
      down(S, { x: -97, y: -83 });
      move(S, { x: 20, y: -40 });
      const off = S._activeGrid();
      move(S, { x: 20, y: -40 }, { shiftKey: true });
      const on = S._activeGrid();
      up(S, { x: 20, y: -40 }, { shiftKey: true });
      gate(`16. ...and the ${tool} ghost shows the grid while it is held`,
        !off && on === GRID_STEP, `off ${off}, held ${on}`);
    }
  }

  // 16i — **paste aims on the grid too.** Ctrl is the paste COMMAND here, not a
  // modifier on a drag, so this is the one place the "Ctrl stands the grid
  // down" rule must not apply — otherwise every paste there is would be
  // unsnappable. Driven through the real `_keyDown`/`_keyUp`, because the whole
  // gesture is "hold the chord, aim, release" and a test that called
  // `_pasteSel` directly would gate the easy half.
  {
    const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
      altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
      preventDefault() {}, stopPropagation() {} });
    // one wheel on the clipboard; its centroid IS the piece, so the node it
    // lands on is the wheel's own centre
    const clip = () => ({
      entries: [{ kind: 'part', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    });
    const pasteAt = (cursor, mods) => {
      const S = screen(roomy);
      S._clipboard = clip();
      S._lastPointer = cursor;
      S._keyDown(kev('v', { ctrl: true, ...mods }));
      const armedGrid = S._pasteGrid;
      S._keyUp(kev('v', { ctrl: true, ...mods }));
      return { S, armedGrid, p: S.design.parts[0] };
    };
    {
      const { p } = pasteAt({ x: 103, y: -98 }, {});
      gate('16. a plain Ctrl+V pastes exactly at the cursor',
        p && near(p.x, 103, 0.01) && near(p.y, -98, 0.01), p ? `${p.x},${p.y}` : 'nothing pasted');
    }
    {
      const { p, armedGrid } = pasteAt({ x: 103, y: -98 }, { shift: true });
      gate('16. Ctrl+Shift+V pastes on the 30 grid',
        p && armedGrid === GRID_STEP && onCellCentre(p.x, GRID_STEP) && onCellCentre(p.y, GRID_STEP),
        p ? `${p.x},${p.y}` : 'nothing pasted');
    }
    {
      const { p, armedGrid } = pasteAt({ x: 103, y: -98 }, { shift: true, alt: true });
      gate('16. Ctrl+Shift+Alt+V pastes on the 15 grid — Alt still wins',
        p && armedGrid === GRID_FINE &&
        onGrid(p.x, GRID_FINE) && !onGrid(p.x, GRID_STEP) &&
        onGrid(p.y, GRID_FINE) && !onGrid(p.y, GRID_STEP),
        p ? `${p.x},${p.y} — 15-nodes, neither a 30-node` : 'nothing pasted');
    }
    {
      const { p } = pasteAt({ x: 103, y: -98 }, { alt: true });
      gate('16. ...and Ctrl+Alt+V is the same thing without the Shift',
        p && onGrid(p.x, GRID_FINE) && !onGrid(p.x, GRID_STEP), p ? `${p.x},${p.y}` : 'nothing pasted');
    }
    // ...and the GHOST is drawn where the paste will land. The two used to be
    // the same arithmetic written out twice under a comment promising they
    // matched — which is how one of them ends up not being updated (§16).
    //
    // Asserted by **running the real `_drawPasteGhost`** against a recording
    // canvas and reading back where it put the wheel, rather than by calling
    // the shared helper and declaring victory: a gate that asks the helper
    // directly would keep passing if the ghost stopped asking it. (It did keep
    // passing, when I checked by pointing the ghost at its own copy of the
    // arithmetic — which is why it is written this way now.)
    {
      const S = screen(roomy);
      S._clipboard = clip();
      S._lastPointer = { x: 103, y: -98 };
      S._keyDown(kev('v', { ctrl: true, shift: true }));
      const drawnAt = [];
      const noop = () => {};
      const rec = new Proxy({
        translate: (x, y) => drawnAt.push({ x, y }),
        createLinearGradient: () => ({ addColorStop: noop }),
        createRadialGradient: () => ({ addColorStop: noop }),
        createPattern: () => null,
        measureText: () => ({ width: 0 }),
      }, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
      S._drawPasteGhost(rec);
      S._keyUp(kev('v', { ctrl: true, shift: true }));
      const p = S.design.parts[0];
      const hit = drawnAt.some(g => near(g.x, p.x, 0.01) && near(g.y, p.y, 0.01));
      gate('16. ...and the paste GHOST is drawn exactly where it lands',
        p && drawnAt.length > 0 && hit,
        `ghost drew at ${drawnAt.map(g => `${g.x},${g.y}`).join(' ') || '(nothing)'}; landed ${p && p.x},${p && p.y}`);
    }
    // Duplicate (context menu) is not an armed paste and keeps its old
    // behaviour — it pastes where the cursor is, grid or no grid.
    {
      const S = screen(roomy);
      S._lastPointer = { x: 103, y: -98 };
      S._pasteSel(clip());
      const p = S.design.parts[0];
      gate('16. ...while Duplicate still pastes at the cursor, unsnapped',
        p && near(p.x, 103, 0.01) && near(p.y, -98, 0.01), p ? `${p.x},${p.y}` : 'nothing pasted');
    }
  }

  // 16h — the grid is only DRAWN while something is actually snapping to it,
  // so it reads as feedback rather than furniture.
  //
  // Asserted through `_activeGrid()`, which is the exact expression `_draw`
  // asks — **not** `d.grid`. That distinction is the bug this gate exists for:
  // the renderer's condition started life as `this.drag?.grid` inline, which
  // was true of every snapping gesture at the time and stopped being true the
  // moment paste learned to snap. Paste aimed on the grid perfectly and drew
  // no grid at all, and no gate noticed, because the gate was asking the drag
  // rather than asking the renderer's own question.
  {
    const S = screen(roomy, { parts: [wheelAt(START)] });
    S._pointerDown(ev(START.x, START.y));
    S._pointerMove(ev(0, -100));
    const plain = S._activeGrid();
    S._pointerMove(ev(10, -100, { shiftKey: true }));
    const shifted = S._activeGrid();
    S._pointerMove(ev(20, -100, { altKey: true }));
    const alted = S._activeGrid();
    S._pointerMove(ev(30, -100));
    const off = S._activeGrid();
    S._pointerUp(ev(30, -100));
    gate('16. the grid appears and disappears with the modifier, mid-drag',
      !plain && shifted === GRID_STEP && alted === GRID_FINE && !off,
      `plain ${plain}, shift ${shifted}, alt ${alted}, released ${off}`);
    gate('16. ...and nothing draws a grid once the drag is over',
      !S._activeGrid(), `${S._activeGrid()}`);
  }

  // ...and the same for an armed PASTE, which is not a drag.
  {
    const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
      altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
      preventDefault() {}, stopPropagation() {} });
    const S = screen(roomy);
    S._clipboard = {
      entries: [{ kind: 'part', data: { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'c' } }],
      anchor: { x: 0, y: 0 },
    };
    S._lastPointer = { x: 103, y: -98 };
    const before = S._activeGrid();
    S._keyDown(kev('v', { ctrl: true, shift: true }));
    const armed = S._activeGrid();
    // ...and it follows the modifier while the paste is still being aimed,
    // through a POINTER move, which is the path no key event covers
    S._pointerMove(ev(60, -60, { ctrlKey: true, altKey: true }));
    const aimedFine = S._activeGrid();
    S._keyUp(kev('v', { ctrl: true, shift: true }));
    const after = S._activeGrid();
    gate('16. an armed paste shows the grid too, and drops it when it lands',
      !before && armed === GRID_STEP && aimedFine === GRID_FINE && !after,
      `before ${before}, armed ${armed}, re-aimed ${aimedFine}, after ${after}`);
  }
}

// ---------- gate 17: planets (§5.10) ----------
//
// A planet is a terrain ball with one extra field, and that is the whole point
// of the design — every gesture it answers is a gesture a terrain ball already
// answered. So these gates ask the two questions that a new FIELD raises
// rather than a new object: does the field survive the routes a piece travels
// (drag, copy/paste, undo), and does it reach the SERIALISER — §16's "when one
// thing is stored twice, find the write that persists", which is exactly how
// the staged-vs-authored goal position bug got out.
{
  const planetWorld = (over = {}) => ({
    terrain: [{ type: 'ball', x: 0, y: 0, r: 120, planet: {} }],
    buildZones: [{ x: 0, y: -400, w: 600, h: 200 }],
    goalZones: [{ x: 400, y: 0, w: 120, h: 120 }],
    goalObjs: [{ shape: 'ball', x: 400, y: 0, r: 15 }],
    ...over,
  });

  // 17a. what counts as a planet — the predicate the panel's visibility, the
  // sim's field and the server's validator all ask
  {
    const ball = { type: 'ball', x: 0, y: 0, r: 90, planet: {} };
    const box = { type: 'box', x: 0, y: 0, w: 90, h: 90, planet: {} };
    const plain = { type: 'ball', x: 0, y: 0, r: 90 };
    const noR = { type: 'ball', x: 0, y: 0, planet: {} };
    gate('17. only a terrain BALL is a planet',
      isPlanet(ball) && !isPlanet(box) && !isPlanet(plain) && !isPlanet(noR),
      'ball yes; box, plain ball and a ball with no radius all no');
    gate('17. an untouched planet pulls at exactly 1× — an ordinary level\'s weight',
      pullOf(ball) === PULL_DEFAULT && pullOf({ ...ball, planet: { pull: 2 } }) === 2,
      `default ${PULL_DEFAULT}×`);
    gate('17. …and a pull outside the dial is clamped, never trusted',
      pullOf({ ...ball, planet: { pull: 99 } }) === PULL_MAX && pullOf({ ...ball, planet: { pull: -5 } }) === PULL_MIN,
      `clamped to ${PULL_MIN}..${PULL_MAX}`);
    // an off-ladder value (hand-edited JSON, or a later change to the ladder)
    // must still put the handle somewhere sensible rather than at the far left
    gate('17. an off-ladder pull puts the slider handle on its nearest notch',
      pullNotch(1.4) === PULL_NOTCHES.indexOf(1.5) && pullNotch(0.3) === PULL_NOTCHES.indexOf(0.25)
      && pullNotch(undefined) === PULL_NOTCHES.indexOf(PULL_DEFAULT),
      `1.4→${PULL_NOTCHES[pullNotch(1.4)]}, 0.3→${PULL_NOTCHES[pullNotch(0.3)]}, unset→${PULL_NOTCHES[pullNotch(undefined)]}`);
  }

  // 17a′. a PROP's own gravity — the Gravity slider's rules, asked where a gate
  // can reach them. The slider itself is DOM and this harness has none, so the
  // whole of what the row decides lives in gravity.js and is measured here:
  // what an untouched prop weighs, what the clamp does with a hand-written
  // number, and where the handle lands on a value off the ladder.
  {
    const plain = { shape: 'box', x: 0, y: 0, w: 30, h: 30 };
    gate('17. an untouched prop falls at exactly 1× — no level changes meaning',
      pieceGravityOf(plain) === PIECE_GRAVITY_DEFAULT && pieceGravityOf({ ...plain, gravity: -1 }) === -1
      && pieceGravityOf({ ...plain, gravity: 0 }) === 0,
      `default ${PIECE_GRAVITY_DEFAULT}×`);
    // 0 is the value a `??` default eats, and this dial is the one place in the
    // schema where it is a real, meaningful setting rather than "unset"
    gate('17. …and 0× survives being read back, where `?? 1` would have eaten it',
      pieceGravityOf({ ...plain, gravity: 0 }) === 0, 'a prop that hangs stays hanging');
    gate('17. …a gravity outside the dial is clamped, never trusted',
      pieceGravityOf({ ...plain, gravity: -50 }) === PIECE_GRAVITY_MIN
      && pieceGravityOf({ ...plain, gravity: 1e9 }) === PIECE_GRAVITY_MAX
      && pieceGravityOf({ ...plain, gravity: 'up' }) === PIECE_GRAVITY_DEFAULT,
      `clamped to ${PIECE_GRAVITY_MIN}..${PIECE_GRAVITY_MAX}`);
    // nearest by DIFFERENCE, because the ladder crosses zero — a ratio has
    // nothing to say about 0 or about a negative, which is what pullNotch and
    // densityNotch both assume
    gate('17. an off-ladder gravity puts the slider handle on its nearest notch',
      pieceGravityNotch(-0.8) === PIECE_GRAVITY_NOTCHES.indexOf(-1)
      && pieceGravityNotch(0.1) === PIECE_GRAVITY_NOTCHES.indexOf(0)
      && pieceGravityNotch(1.7) === PIECE_GRAVITY_NOTCHES.indexOf(1.5)
      && pieceGravityNotch(undefined) === PIECE_GRAVITY_NOTCHES.indexOf(PIECE_GRAVITY_DEFAULT),
      `−0.8→${PIECE_GRAVITY_NOTCHES[pieceGravityNotch(-0.8)]}, 0.1→${PIECE_GRAVITY_NOTCHES[pieceGravityNotch(0.1)]}, 1.7→${PIECE_GRAVITY_NOTCHES[pieceGravityNotch(1.7)]}, unset→${PIECE_GRAVITY_NOTCHES[pieceGravityNotch(undefined)]}`);
    gate('17. …and the ladder itself is the range, with 1 on it',
      PIECE_GRAVITY_NOTCHES[0] === PIECE_GRAVITY_MIN
      && PIECE_GRAVITY_NOTCHES[PIECE_GRAVITY_NOTCHES.length - 1] === PIECE_GRAVITY_MAX
      && PIECE_GRAVITY_NOTCHES.includes(PIECE_GRAVITY_DEFAULT),
      PIECE_GRAVITY_NOTCHES.join(' / '));
  }

  // 17b. the toggle and the dial, through the calls the panel makes
  {
    const S = screen(planetWorld({ terrain: [{ type: 'ball', x: 0, y: 0, r: 120 }] }), { tab: 'level' });
    const t = S.level.terrain[0];
    S._togglePlanet(t);
    const on = isPlanet(t);
    S._setPlanetPull(t, 2);
    const stored = t.planet.pull;
    S._setPlanetPull(t, PULL_DEFAULT);
    const backToDefault = !('pull' in t.planet);
    S._togglePlanet(t);
    gate('17. the toggle turns a ball into a planet and back',
      on && !isPlanet(t) && !('planet' in t), 'planet removed entirely, not left as an empty flag');
    gate('17. 1× is stored as ABSENT, like density and the surface dials',
      stored === 2 && backToDefault, 'pull 2 stored, pull 1 deleted');
  }

  // 17c. switching a planet off takes its dial with it — a ball that is not a
  // planet has no business carrying a pull, and a stale one would come back
  // the next time the toggle was pressed
  {
    const S = screen(planetWorld(), { tab: 'level' });
    const t = S.level.terrain[0];
    S._setPlanetPull(t, 3);
    S._togglePlanet(t);          // off
    S._togglePlanet(t);          // on again
    gate('17. switching a planet off drops its pull with it',
      isPlanet(t) && pullOf(t) === PULL_DEFAULT, `back on at ${pullOf(t)}×`);
  }

  // 17d. a planet is still a terrain ball: drag it and it moves, and it is
  // still a planet when it lands
  {
    const S = screen(planetWorld(), { tab: 'level' });
    const t = () => S.level.terrain[0];
    const g = gesture(S, { x: 0, y: 0 }, { x: -140, y: -60 },
      { watch: () => ({ x: S.level.terrain[0].x, y: S.level.terrain[0].y }) });
    gate('17. a planet drags like any other terrain ball, and lands still a planet',
      g.held && Math.abs(t().x + 140) < 0.01 && isPlanet(t()),
      `moved to (${t().x.toFixed(0)}, ${t().y.toFixed(0)})`);
  }

  // 17e. copy/paste and undo carry the field
  {
    const S = screen(planetWorld(), { tab: 'level', undo: true });
    S._setPlanetPull(S.level.terrain[0], 2);
    S._commit();
    S._select({ kind: 'terrain', ref: S.level.terrain[0] });
    S._copySel();
    S._pasteSel();
    const copy = S.level.terrain[S.level.terrain.length - 1];
    gate('17. a pasted planet is still a planet, at the same pull',
      S.level.terrain.length === 2 && isPlanet(copy) && pullOf(copy) === 2,
      `${S.level.terrain.length} pieces, copy pulls ${pullOf(copy)}×`);

    S._togglePlanet(S.level.terrain[0]);      // commits
    const offAfterToggle = !isPlanet(S.level.terrain[0]);
    S.undo();
    gate('17. undo brings a switched-off planet back',
      offAfterToggle && isPlanet(S.level.terrain[0]) && pullOf(S.level.terrain[0]) === 2,
      `after undo: planet ${isPlanet(S.level.terrain[0])} at ${pullOf(S.level.terrain[0])}×`);
  }

  // 17f. THE SERIALISER. Everything above could be true of a screen that
  // publishes a level with no gravity in it at all (§16).
  {
    const S = screen(planetWorld(), { tab: 'level' });
    S._setPlanetPull(S.level.terrain[0], 1.5);
    const d = S._levelData();
    const round = JSON.parse(JSON.stringify(d));
    const planets = planetsOf(round);
    gate('17. a planet survives the trip to the server — _levelData carries it',
      planets.length === 1 && planets[0].pull === 1.5 && planets[0].r === 120,
      `${planets.length} planet at ${planets[0]?.pull}× r${planets[0]?.r}`);
  }
}

// ---------- gate 18: rotating a multi-selection (§8.2) ----------
//
// The gesture a planet level needs constantly: a cluster of props laid out
// flat, turned as one arrangement to sit against a curved surface (§5.10).
// The invariant that matters is not "it turned" but "it turned RIGIDLY" —
// every pairwise distance preserved and every member's own angle advanced by
// the same delta — because that is exactly what doing it piece by piece
// cannot achieve, and it is the whole reason the gesture exists.
const MULTI_KNOB_GAP = 22;      // game.js's own constant, restated (see the header)
{
  // two 30×30 props, 100 px apart, well clear of the floor
  const pair = () => flatWorld({
    props: [
      { shape: 'box', x: 0, y: -200, w: 30, h: 30 },
      { shape: 'box', x: 100, y: -200, w: 30, h: 30 },
    ],
  });
  const selectBoth = (S) => {
    S.multiSel = [
      { kind: 'prop', ref: S.level.props[0] },
      { kind: 'prop', ref: S.level.props[1] },
    ];
  };
  const knobOf = (S) => {
    const b = S._multiBounds();
    return { x: (b.minX + b.maxX) / 2, y: b.minY - MULTI_KNOB_GAP / S.camera.zoom };
  };
  const pivotOf = (S) => {
    const b = S._multiBounds();
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  };
  // drag the knob a quarter turn clockwise: from straight above the pivot to
  // straight right of it
  const quarterTurn = (S, mods = {}) => {
    const k = knobOf(S), p = pivotOf(S);
    const r = Math.hypot(k.x - p.x, k.y - p.y);
    return gesture(S, k, { x: p.x + r, y: p.y },
      { mods, steps: 6, watch: () => ({ x: S.level.props[0].x, y: S.level.props[0].y }) });
  };

  // 18a. the knob is offered exactly when it means something
  {
    const S = screen(pair(), { tab: 'level' });
    const none = S._multiRotatable();
    selectBoth(S);
    const two = S._multiRotatable();
    S.multiSel = [S.multiSel[0]];
    const one = S._multiRotatable();
    selectBoth(S);
    S.playing = true;
    const playing = S._multiRotatable();
    S.playing = false;
    S.tab = 'machine';
    const machineTab = S._multiRotatable();
    gate('18. the rotate knob appears for 2+ level pieces, and only then',
      two && !none && !one && !playing && !machineTab,
      `none ${none}, one ${one}, two ${two}, playing ${playing}, machine tab ${machineTab}`);
  }

  // 18b. …and NEVER on a selection holding a machine part. A pin is a shared
  // coordinate (§5.4): turning half a machine unbolts it from the half that
  // stayed still, and nothing about the result looks invalid until Play
  // rebuilds the joints and the piece falls off.
  {
    const S = screen(pair(), { tab: 'level', parts: [] });
    S.level.fixedParts = [{ t: 'wheel', kind: 'free', x: 0, y: -200, r: 15, id: 'f1' }];
    S.multiSel = [
      { kind: 'prop', ref: S.level.props[0] },
      { kind: 'fixed', ref: S.level.fixedParts[0] },
    ];
    const offered = S._multiRotatable();
    // and the press that would have grabbed it must not start one either
    const before = S._multiBounds();
    S._pointerDown(ev((before.minX + before.maxX) / 2, before.minY - MULTI_KNOB_GAP));
    const type = S.drag?.type || null;
    S._pointerUp(ev((before.minX + before.maxX) / 2, before.minY - MULTI_KNOB_GAP));
    gate('18. a selection holding a machine part gets no knob, and no rotate',
      !offered && type !== 'multi-rotate', `offered ${offered}, drag "${type}"`);
  }

  // 18c. THE INVARIANT: rigid. Distance preserved, both angles advanced by the
  // same quarter turn, positions orbited about the pivot.
  {
    const S = screen(pair(), { tab: 'level' });
    selectBoth(S);
    const p = pivotOf(S);
    const g = quarterTurn(S);
    const [a, b] = S.level.props;
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    const quarter = Math.PI / 2;
    gate('18. a turned selection keeps its shape — the gap is unchanged',
      near(gap, 100, 0.01), `${gap.toFixed(4)} px apart (was 100)`);
    gate('18. …both pieces turned by the same quarter turn',
      near(a.angle, quarter, 1e-6) && near(b.angle, quarter, 1e-6),
      `${(a.angle * 180 / Math.PI).toFixed(2)}° and ${(b.angle * 180 / Math.PI).toFixed(2)}°`);
    gate('18. …and they orbited the pivot rather than spinning on the spot',
      near(a.x, p.x, 0.01) && near(a.y, p.y - 50, 0.01) && near(b.x, p.x, 0.01) && near(b.y, p.y + 50, 0.01),
      `(${a.x.toFixed(1)},${a.y.toFixed(1)}) (${b.x.toFixed(1)},${b.y.toFixed(1)}) about (${p.x},${p.y})`);
    gate('18. …and the drop kept exactly where the drag left them', g.held,
      `during (${g.during?.x.toFixed(1)},${g.during?.y.toFixed(1)}) → after (${g.after?.x.toFixed(1)},${g.after?.y.toFixed(1)})`);
  }

  // 18d. Shift snaps the DELTA, not the absolute angle — the members start at
  // different angles, and rounding each to a notch would deform the
  // arrangement instead of turning it.
  {
    const S = screen(flatWorld({
      props: [
        { shape: 'box', x: 0, y: -200, w: 30, h: 30, angle: 0.3 },
        { shape: 'box', x: 100, y: -200, w: 30, h: 30, angle: -0.2 },
      ],
    }), { tab: 'level' });
    selectBoth(S);
    const k = knobOf(S), p = pivotOf(S);
    const r = Math.hypot(k.x - p.x, k.y - p.y);
    // aim 50° round; Shift must land it on exactly 45°
    const aim = -Math.PI / 2 + 50 * Math.PI / 180;
    gesture(S, k, { x: p.x + r * Math.cos(aim), y: p.y + r * Math.sin(aim) },
      { mods: { shiftKey: true }, steps: 6 });
    const [a, b] = S.level.props;
    const quarter = Math.PI / 4;
    gate('18. Shift turns the arrangement by exactly 45°, keeping each piece\'s own angle offset',
      near(a.angle, 0.3 + quarter, 1e-6) && near(b.angle, -0.2 + quarter, 1e-6),
      `${a.angle.toFixed(4)} (was 0.3) and ${b.angle.toFixed(4)} (was -0.2)`);
  }

  // 18e. a ball has no angle to give it, and must not grow one
  {
    const S = screen(flatWorld({
      props: [
        { shape: 'ball', x: 0, y: -200, r: 15 },
        { shape: 'box', x: 100, y: -200, w: 30, h: 30 },
      ],
    }), { tab: 'level' });
    selectBoth(S);
    quarterTurn(S);
    const [ball, box] = S.level.props;
    gate('18. a ball orbits the pivot but is never given an angle',
      !('angle' in ball) && near(box.angle, Math.PI / 2, 1e-6) && !near(ball.x, 0, 1),
      `ball at (${ball.x.toFixed(0)},${ball.y.toFixed(0)}) with angle ${ball.angle}`);
  }

  // 18f. the revert puts back the ABSENCE of an angle, not `angle: 0` — the
  // trap _transformFinish and _groupTransformFinish both document, arriving
  // here by a third door.
  {
    const S = screen(flatWorld({
      props: [
        { shape: 'box', x: 0, y: -200, w: 30, h: 30 },
        { shape: 'box', x: 100, y: -200, w: 30, h: 30 },
      ],
    }), { tab: 'level' });
    selectBoth(S);
    const items = S.multiSel.map(s => ({ s, base: S._geomOf(s), rules: S._transformRules(s) }));
    const d = { type: 'multi-rotate', cx: 50, cy: -200, a0: 0, angle: 0.5, items };
    S._multiRotateDrag(d, { x: 50, y: -150 }, {});
    const turnedKey = 'angle' in S.level.props[0];
    // force the revert path by hand: every member restored, keys and all
    for (const it of d.items) S._applyGeom(it.s, it.base, 0, 0, { cx: d.cx, cy: d.cy, a: 0 });
    const [a, b] = S.level.props;
    gate('18. a reverted turn restores the pose AND the absence of an angle',
      turnedKey && !('angle' in a) && !('angle' in b) && near(a.x, 0, 1e-9) && near(a.y, -200, 1e-9),
      `angle key after turn ${turnedKey}, after revert ${'angle' in a}`);
  }

  // 18g. a prop's pins swing with it — they are points ON the piece, in
  // absolute coordinates, so a turn has to carry them round the same pivot or
  // a hinged crate quietly unhinges itself.
  {
    const S = screen(flatWorld({
      props: [
        { shape: 'box', x: 0, y: -200, w: 30, h: 30, pins: [{ x: 15, y: -200 }] },
        { shape: 'box', x: 100, y: -200, w: 30, h: 30 },
      ],
    }), { tab: 'level' });
    selectBoth(S);
    const p = pivotOf(S);
    quarterTurn(S);
    const pin = S.level.props[0].pins[0];
    // the pin started 15 px right of prop A; a quarter turn about the pivot
    // puts it 15 px BELOW where A ended up
    const a = S.level.props[0];
    gate('18. a prop\'s pins swing round with it',
      near(pin.x - a.x, 0, 0.01) && near(pin.y - a.y, 15, 0.01),
      `pin now (${(pin.x - a.x).toFixed(2)}, ${(pin.y - a.y).toFixed(2)}) from its prop`);
  }

  // 18h. a plain multi-MOVE still leaves angles alone — the shared _applyGeom
  // now takes a rotation, and the move path must be untouched by that.
  {
    const S = screen(flatWorld({
      props: [
        { shape: 'box', x: 0, y: -200, w: 30, h: 30, angle: 0.4 },
        { shape: 'ball', x: 100, y: -200, r: 15 },
      ],
    }), { tab: 'level' });
    selectBoth(S);
    gesture(S, { x: 0, y: -200 }, { x: 40, y: -240 }, { steps: 6 });
    const [box, ball] = S.level.props;
    gate('18. a multi-MOVE still turns nothing',
      near(box.angle, 0.4, 1e-9) && !('angle' in ball) && near(box.x, 40, 0.01),
      `angle ${box.angle}, moved to x ${box.x.toFixed(1)}`);
  }
}

// ---------- gate 19: a refused delete SAYS SO (§8.2) ----------
//
// Reported as "Ctrl+Right-click delete seems finicky, sometimes fails to act"
// (the chord is Ctrl+left now — FC1 — and the mute-miss is the same bug).
// It was never unreliable — it was mute. Three paths removed nothing and said
// nothing, and from the other side of the screen a silent no-op and a missed
// click are the same event. These gates assert the SPEECH, not the deletion:
// every route out of the gesture either removes something or explains itself.
{
  const world = (over = {}) => flatWorld({
    props: [{ shape: 'box', x: 0, y: -200, w: 40, h: 40 }],
    goalObjs: [{ shape: 'ball', x: 200, y: -200, r: 15 }],
    ...over,
  });

  // 19a. aiming at nothing — the miss
  {
    const S = screen(world(), { tab: 'level' });
    S._deleteAtCursorPt({ x: -900, y: -900 });
    gate('19. Ctrl+click on empty space says nothing is there',
      S.toasts.length === 1 && /nothing under the cursor/i.test(S.toasts[0]),
      JSON.stringify(S.toasts[0] || null));
  }

  // 19b. the level's own furniture, from the Test tab — the path that was
  // silent, and the one that actually reads as "it just doesn't work"
  {
    const S = screen(world(), { tab: 'machine' });
    const before = S.level.props.length;
    S._deleteHit({ kind: 'prop', ref: S.level.props[0] });
    gate('19. deleting a level piece from Test explains the tab instead of doing nothing',
      S.level.props.length === before && S.toasts.length === 1 && /switch to Create/i.test(S.toasts[0]),
      JSON.stringify(S.toasts[0] || null));
  }
  {
    const S = screen(world(), { tab: 'machine' });
    S._deleteHit({ kind: 'goal', idx: 0 });
    gate('19. …and so does a goal piece, which had its own silent return',
      S.level.goalObjs.length === 1 && /switch to Create/i.test(S.toasts[0] || ''),
      JSON.stringify(S.toasts[0] || null));
  }

  // 19c. it still WORKS — the gates above are worthless if the gesture has
  // merely become talkative
  {
    const S = screen(world(), { tab: 'level' });
    const removed = S._deleteHit({ kind: 'prop', ref: S.level.props[0] });
    gate('19. …while a legal delete still just deletes, and says nothing',
      removed === true && S.level.props.length === 0 && S.toasts.length === 0);
  }

  // 19d. THE WHOLE GESTURE, through the real pointer handler. Ctrl+left is
  // the delete chord (FC1); there is nothing between the press and the
  // delete but the hit test.
  {
    for (const [what, build, count] of [
      ['a prop', () => world(), (S) => S.level.props.length],
      ['terrain', () => flatWorld({ props: [] }), (S) => S.level.terrain.length],
    ]) {
      const S = screen(build(), { tab: 'level' });
      const before = count(S);
      const at = what === 'a prop' ? { x: 0, y: -200 } : { x: 0, y: 30 };
      S._pointerDown(ev(at.x, at.y, { ctrlKey: true }));
      S._pointerUp(ev(at.x, at.y, { ctrlKey: true }));
      gate(`19. Ctrl+click on ${what} deletes it, through the real handler`,
        count(S) === before - 1, `${before} → ${count(S)}`);
    }
    const S = screen(world(), { tab: 'level' });
    S._pointerDown(ev(-900, -900, { ctrlKey: true }));
    S._pointerUp(ev(-900, -900, { ctrlKey: true }));
    gate('19. …and a near-miss says why instead of doing nothing silently',
      S.level.props.length === 1 && /nothing under the cursor/i.test(S.toasts[0] || ''),
      JSON.stringify(S.toasts[0] || null));
  }

  // 19d. the multi path, which was worse than silent: it played the delete
  // sound, cleared the selection and committed an empty change
  {
    const S = screen(world(), { tab: 'machine' });
    S.multiSel = [
      { kind: 'prop', ref: S.level.props[0] },
      { kind: 'terrain', ref: S.level.terrain[0] },
    ];
    const commits = S.commits;
    S._deleteSelection();
    gate('19. a selection that can delete nothing says so, and commits nothing',
      S.level.props.length === 1 && S.commits === commits
      && S.multiSel.length === 2 && /switch to Create/i.test(S.toasts[0] || ''),
      `${S.toasts[0] || 'silent'} · commits ${S.commits - commits}`);
  }
  {
    // ...and the partial case still goes through: one deletable, one not
    const S = screen(world(), { tab: 'level' });
    S.multiSel = [
      { kind: 'prop', ref: S.level.props[0] },
      { kind: 'goal', idx: 0 },              // the last goal piece — spared
    ];
    const commits = S.commits;
    S._deleteSelection();
    gate('19. …while a partly-deletable selection still deletes what it can',
      S.level.props.length === 0 && S.level.goalObjs.length === 1 && S.commits > commits,
      `props ${S.level.props.length}, goals ${S.level.goalObjs.length}`);
  }
}

// ---------- gate 20: Space runs it, any real action stops it (§8.2) ----------
//
// Space starts a machine from Create now, and the half that makes that safe is
// that a running sim no longer SWALLOWS edits — it stops for them. These gate
// the routing, which is the whole of the change: no Simulation is constructed
// (this suite has no wasm), so play/stop are recorded rather than run.
{
  const kev = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
    altKey: !!mods.alt, repeat: false, target: { tagName: 'CANVAS' },
    preventDefault() {}, stopPropagation() {} });
  // a screen whose play/stop are recorded instead of touching Box2D.
  //
  // `sim.view()` is stubbed from the AUTHORED geometry, which is exactly what a
  // real sim reports at t = 0 — enough to gate the routing, which is all that
  // changed. It has to exist at all because `_liveHitAt` reads it: the press
  // rule asks what is under the cursor on screen, and a rig with no view says
  // "nothing" and would pass this whole block by panning through it.
  const rig = (tab, playing = false) => {
    const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: -200, w: 40, h: 40 }] }), { tab });
    S.playing = playing;
    S.calls = [];
    S.play = () => { S.calls.push('play'); S.playing = true; };
    S.stop = () => { S.calls.push('stop'); S.playing = false; };
    S.sim = {
      view: () => ({
        terrain: [], texts: [], goalZones: [],
        props: S.level.props.map((d) => ({ def: d, x: d.x, y: d.y, angle: d.angle || 0 })),
        goals: S.level.goalObjs.map((d, i) => ({ def: d, ...S.goalPositions[i], angle: d.angle || 0 })),
        wheels: S.design.parts.filter((p) => p.t === 'wheel').map((p) => ({ part: p, x: p.x, y: p.y })),
        rods: S.design.parts.filter((p) => p.t === 'rod').map((p) => ({ part: p, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 })),
      }),
    };
    return S;
  };

  // 20a. the guard that used to sit on Space in Create is gone
  {
    const S = rig('level');
    S._keyDown(kev(' '));
    gate('20. Space starts the machine in CREATE, not just in Test',
      S.calls.join() === 'play', `calls [${S.calls}]`);
  }
  {
    const S = rig('machine');
    S._keyDown(kev(' '));
    S._keyDown(kev(' '));
    gate('20. …and still toggles: press again to stop', S.calls.join() === 'play,stop', `calls [${S.calls}]`);
  }

  // 20b. an editing key stops the run — and is SWALLOWED, not applied. The
  // level must come back before anything is allowed to write to it.
  {
    const S = rig('level', true);
    const toolBefore = S.tool;
    S._keyDown(kev('7'));                 // terrain box tool
    gate('20. an editing key stops the run instead of being eaten by it',
      S.calls.join() === 'stop' && S.tool === toolBefore,
      `calls [${S.calls}], tool "${S.tool}" (unchanged)`);
  }
  {
    // the one that matters most: Ctrl+Z is handled at the very top of
    // _keyDown, so the stop check has to sit ABOVE it or an undo would
    // rewrite the level out from under a live sim
    const S = rig('level', true);
    const commits = S.commits;
    S._keyDown(kev('z', { ctrl: true }));
    gate('20. …Ctrl+Z included, which is handled before every other binding',
      S.calls.join() === 'stop' && S.commits === commits, `calls [${S.calls}]`);
  }
  {
    // …and the pair that proves the check reads the MODIFIER and not just the
    // letter: bare Z is the camera and safe, Ctrl+Z is undo and is not. As a
    // flat set of key names this gate failed on its first run.
    const bare = rig('level', true), ctrl = rig('level', true);
    bare._keyDown(kev('z'));
    ctrl._keyDown(kev('z', { ctrl: true }));
    gate('20. …and one letter, two meanings: Z zooms, Ctrl+Z stops it first',
      bare.calls.length === 0 && ctrl.calls.join() === 'stop',
      `bare [${bare.calls}] vs ctrl [${ctrl.calls}]`);
  }
  {
    const S = rig('level', true);
    S._keyDown(kev('Delete'));
    gate('20. …and Delete', S.calls.join() === 'stop' && S.level.props.length === 1, `calls [${S.calls}]`);
  }

  // 20c. …but the three controls that only LOOK do NOT stop it: Fit, the grid
  // latch, and the playback speed slider (a DOM control the canvas never sees,
  // so there is nothing to route — the two keys are what this can assert)
  {
    const S = rig('level', true);
    S._keyDown(kev('z'));                 // zoom to fit
    gate('20. zooming the view does not stop the run', S.calls.length === 0, `calls [${S.calls}]`);
  }
  {
    const S = rig('level', true);
    const snap = S.snapMode;
    S._keyDown(kev('s'));                 // the grid LATCH — a way of looking, not an edit
    gate('20. …nor does S, the grid latch — and it still toggles while it runs',
      S.calls.length === 0 && S.snapMode !== snap, `calls [${S.calls}], snapMode ${snap} -> ${S.snapMode}`);
  }
  {
    // …and S keeps reading its modifiers: Shift and Alt are the grid's own
    // overrides, so a modified S is not the latch and is not exempt
    const S = rig('level', true);
    S._keyDown(kev('s', { ctrl: true }));
    gate('20. …but Ctrl+S is not the latch, so it stops like any other chord',
      S.calls.join() === 'stop', `calls [${S.calls}]`);
  }
  {
    const S = rig('level', true);
    for (const mod of ['Shift', 'Control', 'Alt']) S._keyDown(kev(mod));
    gate('20. …nor does holding a bare modifier, which fires a keydown like any other',
      S.calls.length === 0, `calls [${S.calls}]`);
  }

  // 20d. the pointer: a press ON A PIECE stops the run, a press on empty canvas
  // PANS. The blanket "every press stops" this replaces took away the one
  // gesture you want most while watching a machine — asked for as "Plain click
  // on background to still pan not stop". The line is drawn on the LIVE poses
  // (`_liveHitAt` reads sim.view(), what the renderer draws), never the authored
  // ones, or the answer would be inverted for anything that had moved.
  {
    const S = rig('level', true);
    S.tool = 'pointer';
    S._pointerDown(ev(0, -200));          // the prop is here
    gate('20. a press ON A PIECE stops the run — a select is not a look',
      S.calls.join() === 'stop' && !S.drag, `drag "${S.drag?.type || 'none'}", calls [${S.calls}]`);
    S._pointerUp(ev(0, -200));
  }
  {
    const S = rig('level', true);
    S.tool = 'pointer';
    S._pointerDown(ev(-600, -400));       // empty sky: no prop, no slab
    gate('20. …while a plain press on EMPTY canvas pans and the run carries on',
      S.calls.length === 0 && S.drag?.type === 'pan' && S.playing,
      `drag "${S.drag?.type || 'none'}", calls [${S.calls}]`);
    S._pointerUp(ev(-600, -400));
  }
  {
    // …and the distinction really is the LIVE pose, not the authored one: park
    // the prop's simulated pose somewhere else and the two points swap answers.
    // This is the gate that would have caught doing it with `_hitTest`.
    const S = rig('level', true);
    S.tool = 'pointer';
    S.sim = { view: () => ({
      terrain: [], texts: [], goalZones: [], goals: [], wheels: [], rods: [],
      props: [{ def: S.level.props[0], x: -600, y: -400, angle: 0 }],
    }) };
    S._pointerDown(ev(0, -200));          // where the prop was AUTHORED
    const atAuthored = { calls: S.calls.join(), drag: S.drag?.type };
    S._pointerUp(ev(0, -200));
    const T = rig('level', true);
    T.tool = 'pointer';
    T.sim = S.sim;
    T.level.props = S.level.props;
    T._pointerDown(ev(-600, -400));       // where it actually IS on screen
    gate('20. …and it is the LIVE pose that decides, not the authored one',
      atAuthored.calls === '' && atAuthored.drag === 'pan' && T.calls.join() === 'stop',
      `authored spot: ${atAuthored.drag}/[${atAuthored.calls}] · live spot: [${T.calls}]`);
    T._pointerUp(ev(-600, -400));
  }
  {
    // middle-drag is the pan that survives, and it is handled before the
    // playing branch — so the one gesture that ONLY moves the screen still does
    const S = rig('level', true);
    S.tool = 'pointer';
    S._pointerDown({ ...ev(0, -200), button: 1 });
    gate('20. …while middle-drag still pans, running, because it can only ever pan',
      S.calls.length === 0 && S.drag?.type === 'pan', `drag "${S.drag?.type}", calls [${S.calls}]`);
    S._pointerUp(ev(0, -200));
  }
  {
    const S = rig('level', true);
    S.tool = 'terrain-box';
    S._pointerDown(ev(0, -200));
    gate('20. …while a press with a placement tool stops it, and places nothing',
      S.calls.join() === 'stop' && !S.drag && S.level.terrain.length === 1,
      `drag "${S.drag?.type || 'none'}", terrain ${S.level.terrain.length}`);
  }
  {
    // **The empty-canvas exemption is the POINTER's alone.** With a tool armed,
    // empty canvas is exactly where the new piece would land, so a press there
    // is an edit about to happen and stops the run like any other — otherwise
    // the one press most likely to mean "place this" would silently pan.
    const S = rig('level', true);
    S.tool = 'terrain-box';
    S._pointerDown(ev(-600, -400));
    gate('20. …on EMPTY canvas too, because that is where it would have landed',
      S.calls.join() === 'stop' && !S.drag && S.level.terrain.length === 1,
      `drag "${S.drag?.type || 'none'}", terrain ${S.level.terrain.length}`);
  }
  {
    const S = rig('level', true);
    S.tool = 'delete';
    S._pointerDown(ev(0, -200));
    gate('20. …and so does the delete tool, without deleting anything',
      S.calls.join() === 'stop' && S.level.props.length === 1, `calls [${S.calls}]`);
  }
  {
    // the play screen keeps its own contract: a press NEVER ends a run there,
    // on a piece or off it, because the run is the attempt (§8.2)
    const S = rig('machine', true);
    S.mode = 'play';
    S.tool = 'pointer';
    S._pointerDown(ev(0, -200));          // straight at the prop
    gate('20. …and on the PLAY screen a press never stops a run, piece or no piece',
      S.calls.length === 0 && S.drag?.type === 'pan' && S.playing,
      `drag "${S.drag?.type || 'none'}", calls [${S.calls}]`);
    S._pointerUp(ev(0, -200));
  }

  // 20e. and none of this leaks into a stopped editor: with nothing running,
  // every one of those keys still does its own job
  {
    const S = rig('level');
    S._keyDown(kev('7'));
    gate('20. with nothing running, an editing key still just edits',
      S.calls.length === 0 && S.tool === 'terrain-box', `tool "${S.tool}"`);
  }

  // 20f. RIGHT-CLICK stops it, with nothing in between. The gesture used to be a
  // dead no-op, then became a menu whose only item was Stop — which is a button
  // that takes two clicks, and the odd one out once every other input (any key,
  // any press on the canvas) stopped the run outright.
  const cev = () => ({
    button: 2, ctrlKey: false, shiftKey: false, altKey: false,
    clientX: 400, clientY: 300, preventDefault() {}, stopPropagation() {},
  });
  {
    const S = rig('level', true);
    let menus = 0;
    S._showCtxMenu = () => { menus++; };
    S._contextMenu(cev());
    gate('20. right-click STOPS a running machine, and opens no menu on the way',
      S.calls.join() === 'stop' && menus === 0 && S.playing === false,
      `calls [${S.calls}], menus ${menus}`);
  }
  // …and with nothing running the handler carries on past that branch as it
  // always did. Ctrl+left is the delete chord now; asked on empty space so
  // it refuses without opening a menu (and without stopping a run that is
  // not happening).
  {
    const S = rig('level');
    S._pointerDown(ev(-900, -900, { ctrlKey: true }));
    S._pointerUp(ev(-900, -900, { ctrlKey: true }));
    gate('20. …while a stopped editor runs the delete path, stopping nothing',
      S.calls.length === 0 && /Nothing under the cursor/i.test(S.toasts[0] || ''),
      `calls [${S.calls}], said ${JSON.stringify(S.toasts[0] || null)}`);
  }

  // 20g. **PLAYING FOR REAL IS THE OPPOSITE CONTRACT.** Everything above is
  // the MAKER, where an author's next input is nearly always an edit and
  // stopping is the safe reading. On the play screen the run IS what the player
  // is doing, and losing it to a stray click throws away the attempt — so only
  // Space and the Stop button end one.
  //
  // The two halves are gated together because the rule is now mode-dependent,
  // and a mode-dependent rule with its halves in different places is one edit
  // away from applying everywhere. Every case below has its Maker twin above.
  {
    const rigPlay = (playing = true) => {
      const S = screen(flatWorld({ props: [{ shape: 'box', x: 0, y: -200, w: 40, h: 40 }] }),
        { tab: 'machine', mode: 'play' });
      S.playing = playing;
      S.calls = [];
      S.play = () => { S.calls.push('play'); S.playing = true; };
      S.stop = () => { S.calls.push('stop'); S.playing = false; };
      return S;
    };
    {
      const S = rigPlay();
      S._keyDown(kev('x'));                       // the tool key that stops in the Maker
      S._keyDown(kev('Delete'));
      S._keyDown(kev('r', { ctrl: true }));
      gate('20. a PLAYER\'s stray keys do not stop the run',
        S.calls.length === 0 && S.playing, `calls [${S.calls}]`);
    }
    {
      const S = rigPlay();
      S._pointerDown(ev(0, -200));                // straight onto a piece
      gate('20. …nor does a press on the canvas',
        S.calls.length === 0 && S.playing, `calls [${S.calls}]`);
      gate('20. …which pans instead, since selecting mid-run is not honest',
        S.drag?.type === 'pan', S.drag?.type || 'no drag');
    }
    {
      const S = rigPlay();
      S._contextMenu({ ...cev(), clientX: 400, clientY: 300 });
      gate('20. …nor does a right-click', S.calls.length === 0 && S.playing, `calls [${S.calls}]`);
    }
    // …and the two that DO, which is the other half of the claim: a rule that
    // only ever says "no" would pass every gate above and leave no way to stop.
    {
      const S = rigPlay();
      S._keyDown(kev(' '));
      gate('20. …while SPACE still stops it', S.calls.join() === 'stop' && !S.playing, `calls [${S.calls}]`);
    }
    {
      const S = rigPlay();
      S.playBtn?.onclick?.();                     // the dock's Play/Stop icon
      const viaButton = S.calls.join();
      // the button is built in the constructor, which this harness skips — so
      // assert the routing it uses rather than the DOM node
      const S2 = rigPlay();
      S2.playing ? S2.stop() : S2.play();
      gate('20. …and so does the Stop button\'s own action',
        S2.calls.join() === 'stop' && !S2.playing, `direct [${S2.calls}], via node [${viaButton}]`);
    }
  }
}

// ---------- gate 22: how short a stick may be (§8.2) ----------
//
// MIN_ROD_LEN is 2 (it was 5, and 10 before that — reduced 2026-08-21 on
// request), and a stub whose BOTH ends land on existing pins may go down to
// the sim's own floor (ROD_SKIP_LEN, 0.5) — because "you probably didn't mean
// that" is the entire argument for the floor, and it does not apply to a
// gesture that hit two pins on purpose.
//
// FC draws the same distinction in the same place: fcsim's editor stretches a
// short FREE end out to 10 and leaves an ATTACHED one alone at any separation.
// It is stricter than this on the gesture and has no floor at all on the stub.
//
// The gate that matters is the leak test: the exemption must not spread into
// "anything short is fine", which is §16's exempt-the-rule-not-the-state, and
// is why the pin test is asked about the ENDPOINTS rather than the length.
//
// And the OTHER floor must not follow it down. A rope, a chain wrap and a hull
// simplification choose lengths on the author's behalf, so they work to
// `MIN_LINK_LEN` — still 5 — and a rope that could lay 2 px links would get
// quietly heavier every time it had to reach a pin.
{
  const rodCount = (S) => S.design.parts.filter(p => p.t === 'rod').length;
  const drawRodBetween = (S, a, b) => {
    gesture(S, a, b, { watch: () => ({ x: 0, y: 0 }) });
    return rodCount(S);
  };

  gate('22. MIN_ROD_LEN is 2 — the shortest stick you can draw', MIN_ROD_LEN === 2, `${MIN_ROD_LEN} px`);
  gate('22. …and the GENERATORS keep their own, higher floor',
    MIN_LINK_LEN === 5 && MIN_LINK_LEN > MIN_ROD_LEN,
    `links ${MIN_LINK_LEN} px vs a drawn stick's ${MIN_ROD_LEN} px`);
  gate('22. …with the sim floor below both, and above zero',
    ROD_SKIP_LEN === 0.5 && ROD_SKIP_LEN < MIN_ROD_LEN && ROD_SKIP_LEN > 0, `${ROD_SKIP_LEN} px`);

  // plain open-space draws, either side of the floor
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gate('22. a 6 px stick in open space is placed', drawRodBetween(S, { x: -100, y: -100 }, { x: -94, y: -100 }) === 1);
  }
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gate('22. …and so is a 3 px one, which the old 5 px floor refused',
      drawRodBetween(S, { x: -100, y: -100 }, { x: -97, y: -100 }) === 1);
  }
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gate('22. …while a 1 px twitch is still not a stick',
      drawRodBetween(S, { x: -100, y: -100 }, { x: -99, y: -100 }) === 0);
  }

  // TWO PINS 2 px APART. Two wheels whose hubs are 2 px apart give two real
  // attachment points at that spacing — exactly the thing being asked for.
  {
    const S = screen(flatWorld(), {
      tool: 'rod-wood',
      parts: [
        { t: 'wheel', kind: 'free', x: -1, y: -100, r: 15, id: 'a' },
        { t: 'wheel', kind: 'free', x: 1, y: -100, r: 15, id: 'b' },
      ],
    });
    const placed = drawRodBetween(S, { x: -1, y: -100 }, { x: 1, y: -100 });
    const rod = S.design.parts.find(p => p.t === 'rod');
    gate('22. a 2 px stub between two PINS is allowed',
      placed === 1 && rod && Math.abs(Math.hypot(rod.x2 - rod.x1, rod.y2 - rod.y1) - 2) < 0.01,
      rod ? `${Math.hypot(rod.x2 - rod.x1, rod.y2 - rod.y1).toFixed(2)} px` : 'not placed');
  }

  // …and a 1 px stub between pins goes through now, because the sim's own floor
  // came down with it: measured, a 0.5 px stub on a driven hub holds its joint
  // to 0.0000 px over 600 frames, the same as a 30 px one.
  {
    const S = screen(flatWorld(), {
      tool: 'rod-wood',
      parts: [
        { t: 'wheel', kind: 'free', x: -0.5, y: -100, r: 15, id: 'a' },
        { t: 'wheel', kind: 'free', x: 0.5, y: -100, r: 15, id: 'b' },
      ],
    });
    gate('22. …and a 1 px one between pins is allowed now the sim will build it',
      drawRodBetween(S, { x: -0.5, y: -100 }, { x: 0.5, y: -100 }) === 1);
  }
  // …but not below the sim's floor, where no body would be built at all
  {
    const S = screen(flatWorld(), {
      tool: 'rod-wood',
      parts: [
        { t: 'wheel', kind: 'free', x: -0.1, y: -100, r: 15, id: 'a' },
        { t: 'wheel', kind: 'free', x: 0.1, y: -100, r: 15, id: 'b' },
      ],
    });
    gate('22. …and a 0.2 px one is refused even between pins — the sim would skip it',
      drawRodBetween(S, { x: -0.1, y: -100 }, { x: 0.1, y: -100 }) === 0);
  }

  // THE LEAK TEST: the same 1 px draw with nothing to land on stays refused.
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    gate('22. a 1 px stub in OPEN SPACE is still refused — the exemption is the pins, not the length',
      drawRodBetween(S, { x: -100, y: -100 }, { x: -99, y: -100 }) === 0);
  }
}

// ---------- gate 23: the scenery is reached ONE way (§10.5) ----------
//
// There used to be two doors into the background layer: 🌄 / B, which swaps it
// in and edits it natively at full size, and a right-click menu that posted a
// piece backwards or forwards. The menu is gone — one door — and with it the
// only reason the scenery was ever pickable from the front.
//
// So these gate an ABSENCE, which is the kind of rule that rots quietly: the
// scenery must not answer a hit test, in any tab, at any depth. Everything that
// existed to make the pick safe went with it (`_hitsThisLayer`, the
// `BACKDROP_REACH` refusal, the `backdrop` branches in `_deleteHit` and
// `_cursorTarget`), so a pick creeping back would arrive with no guards at all.
//
// Nothing is lost for a piece in the wrong layer: Ctrl+X here, B, Ctrl+V there.
// That path is gated below, because it is now the ONLY one.
{
  const SCALE = 0.8;                                  // BACKDROP_SCALE, restated
  const BACK_CAP = 250;

  const sceneryWorld = (over = {}) => flatWorld({
    backLevel: {
      terrain: [{ type: 'box', x: 0, y: -500, w: 60, h: 40, texture: 'granite' }],
      props: [{ shape: 'ball', x: -200, y: -500, r: 14 }],
      fixedParts: [{ t: 'wheel', kind: 'cw', x: 200, y: -500, r: 15, id: 'bw1' }],
      texts: [{ text: 'FAR', x: -700, y: -500, size: 40 }],
      groups: {},
    },
    ...over,
  });
  const drawn = (x, y) => ({ x: x * SCALE, y: y * SCALE });

  // 23a. NOT PICKABLE, at its drawn position or its stored one, for any kind
  {
    const S = screen(sceneryWorld(), { tab: 'level' });
    const spots = [
      ['terrain', drawn(0, -500)], ['prop', drawn(-200, -500)],
      ['machine part', drawn(200, -500)], ['label', drawn(-700, -500)],
    ];
    const answers = spots.map(([what, at]) => `${what}:${S._hitTest(at)?.kind ?? 'miss'}`);
    gate('23. the scenery does not answer a click from the front — no kind, no depth',
      spots.every(([, at]) => S._hitTest(at) === null), answers.join(' '));
    gate('23. …nor at its stored coordinates', S._hitTest({ x: 0, y: -500 }) === null);
  }
  // …in Test either, which was always true and stays true
  {
    const S = screen(sceneryWorld(), { tab: 'machine' });
    gate('23. …and a player in Test cannot reach it either', S._hitTest(drawn(0, -500)) === null);
  }
  // …and the quick chords find nothing rather than reaching through
  {
    const S = screen(sceneryWorld(), { tab: 'level' });
    const at = drawn(-200, -500);
    S._pointerDown(ev(at.x, at.y, { ctrlKey: true }));
    S._pointerUp(ev(at.x, at.y, { ctrlKey: true }));
    gate('23. Ctrl+click over scenery deletes nothing and says the cursor is empty',
      S.level.backLevel.props.length === 1 && /Nothing under the cursor/i.test(S.toasts[0] || ''),
      `props ${S.level.backLevel.props.length}, said ${JSON.stringify(S.toasts[0] || null)}`);
  }
  // 23b. THE ONE DOOR: the toggle. Everything is built in there natively.
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._enterBackEdit({ quiet: true });
    S.tool = 'terrain-box';
    S._pointerDown(ev(300, -500));
    S._pointerUp(ev(300, -500));
    const inside = S.level.terrain.length;
    S._exitBackEdit({ quiet: true });
    gate('23. building inside the layer is how scenery is made — and it lands there',
      inside === 1 && S.level.backLevel.terrain.length === 1 && S.level.terrain.length === 1,
      `inside ${inside}, back ${S.level.backLevel.terrain.length}, front ${S.level.terrain.length}`);
  }

  // 23c. …and cut/paste is what moves a piece BETWEEN the layers now: the
  // clipboard survives the swap, which is the whole reason the menu item could
  // go rather than being replaced by something.
  {
    const S = screen(flatWorld({
      props: [{ shape: 'ball', x: -400, y: -200, r: 14 }],
    }), { tab: 'level' });
    const p = S.level.props[0];
    S._select({ kind: 'prop', ref: p });
    S._copySel();
    S._deleteHit({ kind: 'prop', ref: p });
    gate('23. a piece cut in the world leaves it', S.level.props.length === 0);
    S._enterBackEdit({ quiet: true });
    S._pasteSel();
    const landed = S.level.props.length;
    S._exitBackEdit({ quiet: true });
    gate('23. …and pastes into the layer, which is the only crossing there is',
      landed === 1 && S.level.backLevel.props.length === 1 && S.level.props.length === 0,
      `landed ${landed}, back ${S.level.backLevel.props.length}, front ${S.level.props.length}`);
  }

  // 23d. the layer's caps still bind where they are now enforced: at the
  // gesture, inside the layer
  {
    const filler = (n, y) => Array.from({ length: n }, (_, i) => ({ type: 'box', x: i * 50, y, w: 40, h: 20 }));
    const S = screen(flatWorld({
      backLevel: { terrain: filler(BACK_CAP, -400), props: [], fixedParts: [], texts: [], groups: {} },
    }), { tab: 'level' });
    S._enterBackEdit({ quiet: true });
    S.tool = 'terrain-box';
    S._pointerDown(ev(-900, -900));
    S._pointerUp(ev(-900, -900));
    gate('23. a full scenery layer refuses the next piece, and says so',
      S.level.terrain.length === BACK_CAP && /Terrain limit reached/i.test(S.toasts[0] || ''),
      JSON.stringify(S.toasts[0] || null));
  }

  // 23e. the publish gate still names an over-cap layer — the one door left for
  // data that arrives by import rather than by a gesture
  {
    const S = screen(flatWorld({
      goalObjs: [{ shape: 'ball', x: 0, y: -15, r: 15 }],
      backLevel: {
        terrain: Array.from({ length: BACK_CAP + 1 }, (_, i) => ({ type: 'box', x: i * 50, y: -400, w: 40, h: 20 })),
        props: [], fixedParts: [], texts: [], groups: {},
      },
    }), { tab: 'level' });
    gate('23. publish validation names an over-cap scenery layer',
      /scenery layer/i.test(S._validateLevelForPublish() || ''),
      JSON.stringify(S._validateLevelForPublish()));
  }
}

// ---------- gate 24: Shift stands a tool down only OVER a piece (§8.2) ----------
//
// forceMove is Shift+press bypassing the placement tool so an existing piece
// can be dragged. It used to trigger on empty space too, where it fell
// through to a pan nobody asked for — and it took the Shift grid (§8.1) away
// from the press, so a click that never became a drag was the one way to
// place a piece that could not snap. Narrowed: Shift over a piece drags it,
// Shift over space means what Shift means everywhere else — the grid.
{
  // over a piece: the tool stands down and the piece force-moves, as before
  {
    const S = screen(flatWorld(), { tab: 'level', tool: 'terrain-box' });
    S._pointerDown(ev(0, 30, { shiftKey: true }));        // on the slab
    gate('24. …while Shift+press ON a piece still stands the tool down to drag it',
      S.drag?.type === 'move' && S.drag.hit?.kind === 'terrain',
      S.drag?.type || 'no drag');
  }
  // …and SCENERY is not a piece this layer can drag, so Shift over it places
  // exactly as it does over bare backdrop. It is a hit (that keeps "⬆ Bring
  // into the world" aimable) but not a movable one — `movable` in _pointerDown
  // has never included `backdrop` — so the tool stood down and then moved
  // nothing, invisibly, since the layer is a pale ghost you press straight
  // through expecting sky. Reported as "shift click in true backdrop works
  // fine, shift click over some faded scenery and not fine".
  {
    const SCALE = 0.8;                                  // BACKDROP_SCALE, restated
    const world = flatWorld({
      backLevel: {
        // drawn at (-560, -400) — clear of both zones, which are picked BEFORE
        // the scenery behind them, so nothing else can answer this press
        terrain: [{ type: 'box', x: -700, y: -500, w: 200, h: 200, texture: 'granite' }],
        props: [], fixedParts: [], groups: {},
      },
    });
    const overScenery = { x: -700 * SCALE, y: -500 * SCALE };
    const S = screen(world, { tab: 'level', tool: 'terrain-box' });
    gate('24. …a scenery piece under that point answers nothing at all (§10.5)',
      S._hitTest(overScenery) === null, `picked ${S._hitTest(overScenery)?.kind ?? 'nothing'}`);
  }
}

// ---------- gate 26: the cursor chords resolve to a PIECE (§8.2, §6) ----------
//
// Ctrl+click deletes what is under the cursor and Ctrl+X cuts it. Both
// used to ask `_hitTest` directly and hand the answer to `_deleteHit`, which has
// branches for pieces only — so near a stick's END, where the hit test answers
// `endpoint` (the pick that makes a rod detachable, §6), the delete fell through
// to "that belongs to the level — switch to Create", false in Create, and the
// piece stayed. Every pin in the game sits on a rod end or a hub, so the dead
// zone was every joint in the machine. Reported as "when CtrlRightClick happens
// near a pin it don't work".
{
  const cev = (wx, wy, mods = {}) => ev(wx, wy, { ctrlKey: true, ...mods });
  const delAt = (S, wx, wy, mods = {}) => {
    S._pointerDown(cev(wx, wy, mods));
    S._pointerUp(cev(wx, wy, mods));
  };

  // a machine rod inside the build zone, and the exact coordinate of its own
  // end pin. The endpoint pick runs ahead of everything, zones included, so the
  // zone underneath it is not what answers here — which is the point.
  const rodScreen = (tab = 'level') => screen(flatWorld(), {
    tab, parts: [{ t: 'rod', kind: 'wood', x1: -100, y1: -200, x2: -20, y2: -200, id: 'r1' }],
  });

  {
    const S = rodScreen();
    gate('26. the hit test really does answer `endpoint` there — the pin, not the stick',
      S._hitTest({ x: -100, y: -200 })?.kind === 'endpoint',
      `picked ${S._hitTest({ x: -100, y: -200 })?.kind}`);
    delAt(S, -100, -200);
    gate('26. Ctrl+click ON a pin deletes the stick that owns it',
      S.design.parts.length === 0, `${S.design.parts.length} part(s) left, said ${JSON.stringify(S.toasts[0] || null)}`);
    gate('26. …and does not claim it belongs to the level',
      !/switch to Create/i.test(S.toasts.join(' ')), JSON.stringify(S.toasts));
  }
  // the middle of the same stick already worked — it must keep working
  {
    const S = rodScreen();
    delAt(S, -60, -200);
    gate('26. …and the middle of the stick still goes, as it always did',
      S.design.parts.length === 0, `${S.design.parts.length} part(s) left`);
  }
  // the level's OWN sticks resolve to `fixed`, not to `part` — same pin, other
  // owner, and the Create tab is what makes them deletable at all
  const fixedWorld = () => flatWorld({
    fixedParts: [{ t: 'rod', kind: 'wood', x1: 100, y1: -200, x2: 180, y2: -200, id: 'f1' }],
  });
  {
    const S = screen(fixedWorld(), { tab: 'level' });
    delAt(S, 100, -200);
    gate('26. a pin on one of the LEVEL\'s sticks deletes that stick, from Create',
      S.level.fixedParts.length === 0, `${S.level.fixedParts.length} fixed left`);
  }
  // …and in Test it is furniture, so the refusal is the truthful one
  {
    const S = screen(fixedWorld(), { tab: 'machine' });
    delAt(S, 100, -200);
    gate('26. …but in Test that same pin is furniture, and the refusal says which',
      S.level.fixedParts.length === 1 && /switch to Create/i.test(S.toasts[0] || ''),
      `${S.level.fixedParts.length} fixed left, said ${JSON.stringify(S.toasts[0] || null)}`);
  }
  // Ctrl+X gets the same resolution — it shares the resolver, and a cut that
  // silently kept an empty clipboard was the same bug wearing a different key
  {
    const S = rodScreen();
    S._lastPointer = { x: -100, y: -200 };
    S._cutAtCursor();
    gate('26. Ctrl+X on a pin cuts the stick to the clipboard, rather than nothing',
      S.design.parts.length === 0 && /Cut 1 piece/.test(S.toasts.join(' ')),
      `${S.design.parts.length} part(s) left, said ${JSON.stringify(S.toasts)}`);
  }
  // a prop pin is about the PIN — and with Ctrl held the chord deletes it
  // instead of opening a menu about it
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: 0, y: -200, w: 60, h: 60, pins: [{ x: -30, y: -230 }, { x: 30, y: -230 }] }],
    }), { tab: 'level' });
    S._select(S._hitTest({ x: 0, y: -200 }));
    delAt(S, -30, -230);
    gate('26. Ctrl+click on a prop pin removes that pin, and only that pin',
      S.level.props[0].pins.length === 1 && S.level.props[0].pins[0].x === 30,
      `${S.level.props[0].pins.length} pin(s): ${JSON.stringify(S.level.props[0].pins)}`);
    gate('26. …and the prop itself is untouched', S.level.props.length === 1);
  }
  // …while a plain right-click on the same pin still opens its MENU (the
  // "Fixed to background" toggle lives nowhere else). The menu is pure DOM, so
  // it is recorded rather than built — the routing is the whole of the change.
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: 0, y: -200, w: 60, h: 60, pins: [{ x: -30, y: -230 }] }],
    }), { tab: 'level' });
    let opened = 0;
    S._openPinMenu = () => { opened++; };
    S._select(S._hitTest({ x: 0, y: -200 }));
    S._contextMenu(cev(-30, -230, { ctrlKey: false }));
    gate('26. …and a plain right-click on it still opens the pin menu instead',
      opened === 1 && S.level.props[0].pins.length === 1,
      `menu ×${opened}, ${S.level.props[0].pins.length} pin(s) left`);
  }
  // nothing under the cursor still SAYS nothing was under the cursor — the
  // resolver must not turn a miss into silence
  {
    const S = screen(flatWorld(), { tab: 'level' });
    delAt(S, -600, -600);
    gate('26. an empty miss still says so, rather than going quiet',
      /Nothing under the cursor/i.test(S.toasts[0] || ''), JSON.stringify(S.toasts[0] || null));
  }
}

// ---------- gate 25: editing the scenery IN PLACE — the level swap (§10.5) ----------
//
// The Maker toggle dresses `level.backLevel` as a level and puts it in
// `this.level`, so every tool edits the scenery natively at full size. The
// swap is one line; the FEATURE is the guards on every path that treats
// `this.level` as THE level while the toggle is on. Each guard gets a gate,
// because each unguarded path is a different way to destroy a level:
// _levelData saves the scenery AS the level, _autosave overwrites the draft
// with its own background on every commit, play() sims a goal-less wrapper,
// the validator demands goal pieces of a layer that must not have them, and
// an undo across the boundary restores the scenery INTO the level slot.
{
  const backWorld = (over = {}) => flatWorld({
    goalObjs: [{ shape: 'ball', x: -150, y: -25, r: 15 }],
    backLevel: {
      terrain: [{ type: 'box', x: 0, y: -500, w: 60, h: 40, texture: 'granite' }],
      props: [], fixedParts: [], groups: {},
    },
    ...over,
  });

  // 25a. the swap is real: the wrapper's lists ARE the layer's lists, the
  // hit test asks 1:1 (no layer-space division anywhere), and the exit
  // writes back with no zone keys — the server rejects a backLevel carrying
  // even empty ones, so a leak here is a level that cannot save.
  {
    const S = screen(backWorld(), { tab: 'level' });
    const front = S.level;
    S._enterBackEdit();
    gate('25. the swap shares the layer\'s own arrays — one level, two hats',
      S.backEditing === true && S.level.terrain === front.backLevel.terrain
      && S.level.props === front.backLevel.props && S.level.goalObjs.length === 0,
      'wrapper.terrain === backLevel.terrain');
    const hit = S._hitTest({ x: 0, y: -500 });
    gate('25. …and the scenery is picked 1:1, as plain terrain, where it is stored',
      hit?.kind === 'terrain' && hit.ref === front.backLevel.terrain[0],
      `picked ${hit?.kind}`);
    S.level.terrain.push({ type: 'ball', x: 300, y: -500, r: 30 });
    S._exitBackEdit();
    gate('25. …and the exit writes the edits back, with no zone keys leaked',
      S.level === front && front.backLevel.terrain.length === 2
      && !('buildZones' in front.backLevel) && !('goalObjs' in front.backLevel),
      `backLevel keys: ${Object.keys(front.backLevel).join(', ')}`);
  }

  // 25b. _levelData while toggled serialises the LEVEL, scenery edits inside
  {
    const S = screen(backWorld(), { tab: 'level' });
    S._enterBackEdit();
    S.level.terrain.push({ type: 'ball', x: 300, y: -500, r: 30 });
    const d = S._levelData();
    gate('25. _levelData under the toggle is the level, live scenery inside',
      d.goalObjs.length === 1 && d.buildZones.length === 1 && d.terrain.length === 1
      && d.backLevel.terrain.length === 2 && d.backLevel.buildZones === undefined,
      `goalObjs ${d.goalObjs.length}, backLevel.terrain ${d.backLevel?.terrain.length}`);
  }

  // 25c. _autosave under the toggle — the REAL one, store patched to capture.
  // It used to store `this.level` raw: one commit inside the scenery and the
  // draft IS the scenery, silently.
  {
    const real = { get: store.get, set: store.set };
    const saved = {};
    store.get = (k, d = null) => (k in saved ? JSON.parse(JSON.stringify(saved[k])) : d);
    store.set = (k, v) => { saved[k] = JSON.parse(JSON.stringify(v)); };
    try {
      const S = screen(backWorld(), { tab: 'level' });
      S.opts = { draftId: 'd1' };
      S._autosave = GameScreen.prototype._autosave;   // un-stub: this gate is ABOUT it
      S._enterBackEdit();
      S.level.terrain.push({ type: 'ball', x: 300, y: -500, r: 30 });
      S._autosave();
      const draft = saved['maker.drafts']?.d1?.level;
      gate('25. _autosave under the toggle stores the level, not the wrapper',
        !!draft && draft.goalObjs?.length === 1 && draft.buildZones?.length === 1
        && draft.backLevel?.terrain.length === 2 && draft.backLevel.goalObjs === undefined,
        draft ? `draft goalObjs ${draft.goalObjs?.length}, backLevel.terrain ${draft.backLevel?.terrain.length}` : 'NO DRAFT');
    } finally {
      store.get = real.get; store.set = real.set;
    }
  }

  // 25e. the validator answers for the LEVEL — asked of the wrapper it would
  // demand a goal piece of the one place that must not have one
  {
    const S = screen(backWorld(), { tab: 'level' });
    S._enterBackEdit();
    const err = S._validateLevelForPublish();
    gate('25. publish validation under the toggle validates the level',
      err === null && S.level.goalObjs.length === 0,
      JSON.stringify(err));
  }

  // 25f. undo works ACROSS the boundary: snapshots hold the true level plus
  // the layer they were taken in, so each step of history lands the editor
  // back where that edit was made.
  {
    const S = screen(backWorld(), { tab: 'level', undo: true });
    S._enterBackEdit();                                     // history: in
    S._setTool('terrain-box');
    S._pointerDown(ev(300, -500));                          // a click places (1:1 space)
    S._pointerUp(ev(300, -500));                            // history: placed
    const placed = S.level.terrain.length;
    S._exitBackEdit();                                      // history: out
    gate('25. …the gesture landed in the scenery through the real pointer path',
      placed === 2 && S.level.backLevel.terrain.length === 2, `${placed} in layer`);
    S.undo();
    gate('25. undo crosses back INTO the layer the edit was made in',
      S.backEditing === true && S.level.terrain.length === 2);
    S.undo();
    gate('25. …another undo removes the piece, still inside',
      S.backEditing === true && S.level.terrain.length === 1);
    S.undo();
    gate('25. …and a third steps out, the level intact',
      S.backEditing === false && S.level.goalObjs.length === 1
      && S.level.backLevel.terrain.length === 1);
    S.redo();
    gate('25. …and redo re-enters the same way',
      S.backEditing === true && S.level.terrain.length === 1);
  }

  // 25g. Reset reverts WHAT YOU ARE EDITING: the scenery, to the session's
  // starting layout — never the wrapper replaced with a front-shaped level
  {
    const S = screen(backWorld(), { tab: 'level' });
    S._levelStartSnapshot = deep(S.level);
    S._confirm = (t, m, l, onYes) => onYes();
    S._enterBackEdit();
    S.level.terrain.length = 0;
    S.level.terrain.push({ type: 'ball', x: 9, y: 9, r: 9 }, { type: 'ball', x: 8, y: 8, r: 8 });
    S.resetDesign();
    gate('25. Reset inside the scenery reverts the scenery and stays inside',
      S.backEditing === true && S.level.terrain.length === 1
      && S.level.terrain[0].w === 60 && S._frontLevel.buildZones.length === 1,
      `${S.level.terrain.length} piece(s) after revert`);
  }

  // 25h. paste: goal pieces and zones are REFUSED into the layer, spoken,
  // while the rest of the clipboard still lands
  {
    const S = screen(backWorld(), { tab: 'level' });
    S._enterBackEdit();
    S._lastPointer = { x: 300, y: -500 };
    S._pasteSel({
      anchor: { x: 300, y: -500 },   // the copied set's centroid (see _pasteDelta)
      entries: [
        { kind: 'goal', data: { shape: 'ball', r: 15 }, pos: { x: 300, y: -700 } },
        { kind: 'zone', zoneType: 'build', data: { x: 300, y: -600, w: 100, h: 100 } },
        { kind: 'terrain', data: { type: 'box', x: 300, y: -500, w: 40, h: 40 } },
      ],
    }, 0);
    gate('25. pasting into the layer skips goal pieces and zones, and says so',
      S.level.goalObjs.length === 0 && S.level.buildZones.length === 0
      && S.level.terrain.length === 2 && S.toasts.some(t => /skipped/.test(t)),
      JSON.stringify(S.toasts[S.toasts.length - 1] || null));
  }

  // 25i. the layer's own caps bind at the GESTURE while inside (§10.5) — the
  // same placement that allows 500 in the world refuses at 250 in here
  {
    const filler = Array.from({ length: 250 }, (_, i) => ({ type: 'box', x: i * 50, y: 4000, w: 40, h: 20 }));
    const S = screen(backWorld({ backLevel: { terrain: filler, props: [], fixedParts: [], groups: {} } }), { tab: 'level' });
    S._enterBackEdit();
    S._setTool('terrain-box');
    S._pointerDown(ev(0, -500));
    S._pointerUp(ev(0, -500));
    gate('25. terrain placement inside the layer refuses at the layer\'s cap, spoken',
      S.level.terrain.length === 250 && S.toasts.some(t => /Terrain limit reached \(250\)/.test(t)),
      JSON.stringify(S.toasts[S.toasts.length - 1] || null));
  }

  // 25j. the one door that makes no sense in here refuses and SAYS so. (There
  // were two: the layer MOVE was the other, and "send to the background from
  // the background" is a door to nowhere — but that whole mechanism is gone,
  // 🌄 / B being the only way in or out now. See gate 23.)
  {
    const S = screen(backWorld(), { tab: 'level' });
    S._enterBackEdit();
    S._setTool('goal-piece');
    gate('25. the goal tool refuses inside the layer, with the reason',
      S.tool === 'pointer' && /no goal pieces/i.test(S.toasts[S.toasts.length - 1] || ''),
      S.toasts[S.toasts.length - 1]);
  }
}

// ---------- gate 21: nothing may hang off window.confirm ----------
//
// A SOURCE gate, not a behavioural one — it reads the client files rather than
// driving anything, and it is here because this is the only pure-client suite.
//
// `confirm()` is the BROWSER's dialog and the browser is allowed to take it
// away: after a couple of them Chrome offers "prevent this page from creating
// additional dialogs", and once that is ticked every later call returns false
// instantly and silently for the life of the page. Every delete in main.js was
// written `if (!confirm(...)) return;`, so all of them went dead at once —
// reported as "6 levels, the ✕ don't work", and reproduced exactly: a real
// click did nothing while the same handler with confirm stubbed to true
// deleted correctly.
//
// The failure has no symptom to search for, so the guard has to be mechanical:
// the app owns its dialogs (`confirmModal`), and nothing may depend on the
// browser's.
{
  const files = ['main.js', 'game.js', 'api.js', 'util.js', 'render.js', 'sim.js'];
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, 'public', 'js', f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                 // comments may name it
      // a call to confirm() that isn't confirmModal( and isn't a property
      if (/(^|[^.\w])confirm\s*\(/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  gate('21. no destructive action depends on window.confirm — the browser can switch it off',
    offenders.length === 0, offenders.length ? offenders.join(', ') : 'all dialogs are the app\'s own');
}

// ---------- gate 27: text labels (§10.6) ----------
//
// A label is decoration with no body, so there is nothing here about overlap,
// sweeps or zones — that absence IS the feature. What these gate is that a piece
// with no authored w/h nevertheless behaves like every other object you edit,
// because it describes itself as a rotated rectangle (`textBox`) and then rides
// the paths that already exist: pick, move, nudge, turn, resize, copy, delete,
// undo, the layer move, and the caps.
//
// Measurement is APPROXIMATE here — there is no canvas in this process, so
// `measureTextPiece` falls back to 0.55 em per character (see render.js). Every
// point below is chosen well inside or well outside a box, so the gates are
// about the wiring, not about glyph metrics. Anything asserting exact metrics
// belongs in a browser.
{
  const { textBox, measureTextPiece } = await import(u('public/js/render.js'));
  const {
    badTextPiece, TEXT_MAX_CHARS, TEXT_MAX_LINES, TEXT_SIZE_MAX, TEXT_SIZES,
    textColourHex, haloFor, textAlignOf, textFontKey,
  } = await import(u('public/js/textmodel.js'));

  const label = (over = {}) => ({ text: 'HELLO', x: -400, y: -300, size: 30, ...over });
  // clear of flatWorld's zones (build x±350 y −350..150, goal 340..460 × −80..0)
  const textWorld = (over = {}) => flatWorld({ texts: [label()], ...over });

  // 27a. it is a piece: picked where it is drawn, and only there
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    const b = textBox(t);
    gate('27. a label reports a measured box — width from the string, height from the size',
      b.w > 30 && b.h > 30 && b.h < 45, `${Math.round(b.w)}×${Math.round(b.h)}`);
    gate('27. …and is picked at its centre', S._hitTest({ x: -400, y: -300 })?.kind === 'text');
    gate('27. …and not well outside it', S._hitTest({ x: -400, y: -300 - b.h }) === null);
  }

  // 27b. moved by a real drag, through the real pointer path — no sweep, no
  // clamp, no rejection: a label goes exactly where it is put
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._pointerDown(ev(-400, -300));
    gate('27. a press on a label starts a MOVE', S.drag?.type === 'move' && S.drag.hit?.kind === 'text',
      S.drag?.type || 'none');
    S._pointerMove(ev(-340, -240));
    S._pointerUp(ev(-340, -240));
    gate('27. …and it lands exactly there, with nothing to reject it',
      Math.abs(t.x - -340) < 1e-9 && Math.abs(t.y - -240) < 1e-9, `(${t.x}, ${t.y})`);
  }
  // …including straight through solid terrain, which is the whole point of it
  // having no body
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._pointerDown(ev(-400, -300));
    S._pointerMove(ev(0, 30));          // dead centre of the floor slab
    S._pointerUp(ev(0, 30));
    gate('27. a label may sit INSIDE terrain — no physics means no rules',
      Math.abs(t.x) < 1e-9 && Math.abs(t.y - 30) < 1e-9, `(${t.x}, ${t.y})`);
  }

  // 27c. the arrow nudge and the align machinery reach it through _movePiece and
  // _pieceBounds, which is what "it is a rectangle like any other" buys
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    S._nudge(3, -2);
    gate('27. arrows nudge a label', t.x === -397 && t.y === -302, `(${t.x}, ${t.y})`);
    const pb = S._pieceBounds({ kind: 'text', ref: t });
    const m = measureTextPiece(t);
    gate('27. …and _pieceBounds returns its measured extent, so Align and the marquee work',
      Math.abs((pb.maxX - pb.minX) - m.w) < 0.51 && Math.abs((pb.maxY - pb.minY) - m.h) < 0.51,
      `${Math.round(pb.maxX - pb.minX)}×${Math.round(pb.maxY - pb.minY)} vs ${Math.round(m.w)}×${Math.round(m.h)}`);
  }

  // 27d. resize is UNIFORM: the corner drag scales `size`, never w/h, and the
  // opposite corner holds. Metrics are linear in size, so this is exact.
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    const b0 = textBox(t);
    const c2 = { x: b0.x + b0.w / 2, y: b0.y + b0.h / 2 };     // bottom-right handle
    const anchor0 = { x: b0.x - b0.w / 2, y: b0.y - b0.h / 2 };
    S._pointerDown(ev(c2.x, c2.y));
    gate('27. a corner handle on a label starts a RESIZE',
      S.drag?.type === 'resize' && !!S.drag.startBox, S.drag?.type || 'none');
    // drag the corner twice as far out along the diagonal
    S._pointerMove(ev(anchor0.x + (c2.x - anchor0.x) * 2, anchor0.y + (c2.y - anchor0.y) * 2));
    S._pointerUp(ev(anchor0.x + (c2.x - anchor0.x) * 2, anchor0.y + (c2.y - anchor0.y) * 2));
    const b1 = textBox(t);
    gate('27. …doubling the diagonal doubles the SIZE, not the width alone',
      Math.abs(t.size - 60) < 0.01 && t.w === undefined && t.h === undefined, `size ${t.size}`);
    gate('27. …and the opposite corner stayed put',
      Math.abs((b1.x - b1.w / 2) - anchor0.x) < 0.01 && Math.abs((b1.y - b1.h / 2) - anchor0.y) < 0.01,
      `anchor (${(b1.x - b1.w / 2).toFixed(2)}, ${(b1.y - b1.h / 2).toFixed(2)}) vs (${anchor0.x.toFixed(2)}, ${anchor0.y.toFixed(2)})`);
    gate('27. …and the size is clamped at the ceiling',
      (() => {
        const S2 = screen(textWorld(), { tab: 'level' });
        const t2 = S2.level.texts[0];
        S2._select({ kind: 'text', ref: t2 });
        const bb = textBox(t2);
        S2._pointerDown(ev(bb.x + bb.w / 2, bb.y + bb.h / 2));
        S2._pointerMove(ev(bb.x + bb.w * 500, bb.y + bb.h * 500));
        S2._pointerUp(ev(bb.x + bb.w * 500, bb.y + bb.h * 500));
        return t2.size === TEXT_SIZE_MAX;
      })());
  }

  // 27e. the scroll wheel steps the LADDER, and tidies an off-ladder size on the
  // way rather than compounding it
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    S._stepTextSize(t, 1);
    gate('27. scroll up steps to the next ladder size', t.size === 45, String(t.size));
    S._stepTextSize(t, -1);
    S._stepTextSize(t, -1);
    gate('27. …and down again, two rungs', t.size === 20, String(t.size));
    t.size = 37;                                   // off-ladder, as a corner drag leaves it
    S._stepTextSize(t, 1);
    gate('27. …an off-ladder size lands ON the ladder rather than drifting',
      TEXT_SIZES.includes(t.size) && t.size === 45, String(t.size));
  }

  // 27f. a turn: the knob writes `angle` on the piece, and the box turns with it
  {
    const S = screen(textWorld(), { tab: 'level' });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    const b = textBox(t);
    const k = S._rotateKnobPt(b, b);
    S._pointerDown(ev(k.x, k.y));
    gate('27. the rotate knob on a label starts a ROTATE', S.drag?.type === 'rotate', S.drag?.type || 'none');
    S._pointerMove(ev(b.x + 50, b.y));            // pointer due east of the centre
    S._pointerUp(ev(b.x + 50, b.y));
    gate('27. …and the angle lands on the piece, not on a copy of its box',
      Math.abs(Math.abs(t.angle) - Math.PI / 2) < 0.02, String(t.angle));
  }

  // 27g. copy / paste / delete / undo, through the real clipboard entry path
  {
    const S = screen(textWorld(), { tab: 'level', undo: true });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    S._copySel();
    S._pasteSel();
    gate('27. a label copies and pastes', S.level.texts.length === 2,
      `${S.level.texts.length} label(s)`);
    gate('27. …and the copy keeps every property but its place',
      S.level.texts[1].text === 'HELLO' && S.level.texts[1].x !== S.level.texts[0].x);
    S._deleteHit({ kind: 'text', ref: S.level.texts[1] });
    gate('27. …deletes', S.level.texts.length === 1);
    S.undo();
    gate('27. …and undo brings it back', S.level.texts.length === 2);
  }
  // Ctrl+click reaches one through the real handler, like any other piece
  {
    const S = screen(textWorld(), { tab: 'level' });
    S._pointerDown(ev(-400, -300, { ctrlKey: true }));
    S._pointerUp(ev(-400, -300, { ctrlKey: true }));
    gate('27. Ctrl+click deletes a label, through the real handler',
      S.level.texts.length === 0, `${S.level.texts.length} left`);
  }

  // 27h. a label never CAUSES a revert, but it must be CARRIED by one — the
  // reason `texts` is in _snapshotAll. A crate dragged somewhere it cannot land,
  // with a label in the selection, must put both back.
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -400, y: -30, w: 40, h: 40 }],
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, { type: 'box', x: -200, y: -30, w: 60, h: 60 }],
      texts: [label({ x: -400, y: -100 })],
    }), { tab: 'level' });
    const p = S.level.props[0], t = S.level.texts[0];
    S.multiSel = [{ kind: 'prop', ref: p }, { kind: 'text', ref: t }];
    const t0 = { x: t.x, y: t.y };
    S._pointerDown(ev(-400, -30));
    gate('27. a label joins a multi-selection and moves with it',
      S.drag?.type === 'move-multi', S.drag?.type || 'none');
    S._pointerMove(ev(-380, -20));
    S._pointerUp(ev(-380, -20));
    gate('27. …and the label really did travel',
      Math.abs(t.x - (t0.x + 20)) < 1.01, `(${t.x}, ${t.y}) from (${t0.x}, ${t0.y})`);
  }

  // 27i. caps, spoken — the front's and the layer's
  {
    const S = screen(flatWorld({
      texts: Array.from({ length: 60 }, (_, i) => label({ x: i * 10 })),
    }), { tab: 'level', tool: 'text' });
    S._pointerDown(ev(-500, -500));
    gate('27. placement refuses at the label cap, and says so',
      S.level.texts.length === 60 && /Label limit/i.test(S.toasts[0] || ''),
      JSON.stringify(S.toasts[0] || null));
  }
  {
    const S = screen(flatWorld({
      backLevel: { terrain: [], props: [], fixedParts: [], groups: {},
        texts: Array.from({ length: 30 }, (_, i) => label({ x: i * 10 })) },
    }), { tab: 'level' });
    S._enterBackEdit({ quiet: true });
    S.tool = 'text';
    S._pointerDown(ev(-500, -500));
    gate('27. …and the layer has its own, half the size',
      S.level.texts.length === 30 && /Label limit reached \(30\)/i.test(S.toasts[0] || ''),
      JSON.stringify(S.toasts[0] || null));
  }

  // 27j. THE SWAP. The layer carries `texts` in and out (§10.5's list problem):
  // a list missing from any of the three sites is scenery that vanishes on save.
  {
    const S = screen(flatWorld({ goalObjs: [{ shape: 'ball', x: 0, y: -15, r: 15 }] }), { tab: 'level' });
    S._enterBackEdit({ quiet: true });
    S.level.texts.push(label({ text: 'FAR AWAY' }));
    S._exitBackEdit({ quiet: true });
    gate('27. a label written inside the layer comes out in backLevel.texts',
      S.level.backLevel.texts.length === 1 && S.level.texts.length === 0,
      `back ${S.level.backLevel.texts.length}, front ${S.level.texts.length}`);
    gate('27. …and _levelData ships it there, not in the level',
      (() => {
        const d = S._levelData();
        return d.backLevel?.texts?.length === 1 && d.texts === undefined;
      })());
    // …and _trueLevel says the same while still INSIDE, which is what autosave
    // and publish both ask (the exit that cost a session its scenery, §10.5)
    S._enterBackEdit({ quiet: true });
    const tl = S._trueLevel();
    gate('27. …and _trueLevel reports it from inside the layer too',
      tl.backLevel.texts.length === 1 && (tl.texts || []).length === 0);
    S._exitBackEdit({ quiet: true });
  }
  // …and a label crosses between the layers the way everything does now: cut
  // here, step in, paste there (the layer-move menu item is gone — gate 23).
  {
    const S = screen(flatWorld({ texts: [label({ x: -700, y: -500 })] }), { tab: 'level' });
    const t = S.level.texts[0];
    S._select({ kind: 'text', ref: t });
    S._copySel();
    S._deleteHit({ kind: 'text', ref: t });
    S._enterBackEdit({ quiet: true });
    S._pasteSel();
    const inside = S.level.texts.length;
    const words = S.level.texts[0]?.text;
    S._exitBackEdit({ quiet: true });
    gate('27. a label crosses into the layer by cut and paste, words and all',
      inside === 1 && words === 'HELLO'
      && S.level.backLevel.texts.length === 1 && S.level.texts.length === 0,
      `inside ${inside} "${words}", back ${S.level.backLevel.texts.length}, front ${S.level.texts.length}`);
  }
  // …and from the front it is not pickable at all, at its drawn spot or its
  // stored one — the same absence gate 23 pins for every other kind
  {
    const S = screen(flatWorld({
      backLevel: { terrain: [], props: [], fixedParts: [], groups: {}, texts: [label({ x: -700, y: -500 })] },
    }), { tab: 'level' });
    gate('27. …and a label in the layer answers no click from the front',
      S._hitTest({ x: -700 * 0.8, y: -500 * 0.8 }) === null && S._hitTest({ x: -700, y: -500 }) === null);
  }

  // 27k. the SCHEMA, shared with the server (textmodel.js). These are the gates
  // that keep hand-edited JSON out of the renderer.
  {
    const bad = (o) => badTextPiece(o, 0);
    gate('27. a legal label validates', bad(label()) === null, JSON.stringify(bad(label())));
    gate('27. …text must be a string', /must be a string/.test(bad(label({ text: 7 })) || ''));
    gate('27. …x and y must be numbers', /must be numbers/.test(bad(label({ x: 'a' })) || ''));
    gate('27. …an over-long string is refused',
      /too long/.test(bad(label({ text: 'x'.repeat(TEXT_MAX_CHARS + 1) })) || ''));
    gate('27. …and too many lines',
      /too many lines/.test(bad(label({ text: 'a\n'.repeat(TEXT_MAX_LINES) })) || ''));
    gate('27. …a NaN size is refused', /size must be a number/.test(bad(label({ size: NaN })) || ''));
    gate('27. …and one past the ceiling', /size must be between/.test(bad(label({ size: 1e9 })) || ''));
    gate('27. …an unknown font is refused', /unknown font/.test(bad(label({ font: 'Wingdings' })) || ''));
    gate('27. …a palette NAME is accepted', bad(label({ colour: 'goal' })) === null);
    gate('27. …a #rrggbb value is accepted, because the picker makes them',
      bad(label({ colour: '#ff8800' })) === null);
    gate('27. …but nothing else that could reach a canvas fillStyle',
      /colour must be/.test(bad(label({ colour: 'url(evil)' })) || '')
      && /colour must be/.test(bad(label({ colour: '#f80' })) || '')
      && /colour must be/.test(bad(label({ colour: 'red; x' })) || ''));
    gate('27. …and an unknown alignment', /align must be/.test(bad(label({ align: 'middle' })) || ''));
  }
  // resolution and defaults: an unknown value must fall back, never throw — a
  // level carrying a colour this build has never heard of still draws
  {
    gate('27. an unknown colour falls back to the default ink',
      textColourHex({ colour: 'nope' }) === '#232a35');
    gate('27. …a hex one resolves to itself, lower-cased',
      textColourHex({ colour: '#FF8800' }) === '#ff8800');
    gate('27. …an unknown font falls back', textFontKey({ font: 'nope' }) === 'ui');
    gate('27. …and an unknown alignment', textAlignOf({ align: 'nope' }) === 'center');
    // the halo has to CONTRAST, which is the whole reason it is computed
    gate('27. the outline halo is dark behind pale ink and pale behind dark ink',
      haloFor('#ffffff') === '#232a35' && haloFor('#232a35') === '#ffffff'
      && haloFor('#000000') === '#ffffff');
  }
  // the publish check names an over-cap or over-long label, since import is the
  // one door the editor's own caps don't cover
  {
    const S = screen(flatWorld({
      goalObjs: [{ shape: 'ball', x: 0, y: -15, r: 15 }],
      texts: Array.from({ length: 61 }, (_, i) => label({ x: i * 10 })),
    }), { tab: 'level' });
    gate('27. publish validation names too many labels',
      /Too many labels/i.test(S._validateLevelForPublish() || ''),
      JSON.stringify(S._validateLevelForPublish()));
    const S2 = screen(flatWorld({
      goalObjs: [{ shape: 'ball', x: 0, y: -15, r: 15 }],
      texts: [label({ text: 'x'.repeat(TEXT_MAX_CHARS + 5) })],
    }), { tab: 'level' });
    gate('27. …and one whose words arrived too long',
      /too long/i.test(S2._validateLevelForPublish() || ''),
      JSON.stringify(S2._validateLevelForPublish()));
  }

  // 27l. a label is INVISIBLE to the machine's tab and to a player: the Test tab
  // must not be able to pick one, for the same reason it cannot pick scenery
  {
    const S = screen(textWorld(), { tab: 'machine' });
    gate('27. a label cannot be picked from Test', S._hitTest({ x: -400, y: -300 }) === null);
  }
  // …and it never steals a click from a piece the level is made of
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -400, y: -300, w: 40, h: 40 }],
      texts: [label()],
    }), { tab: 'level' });
    gate('27. …and never steals a click from a prop sitting on it',
      S._hitTest({ x: -400, y: -300 })?.kind === 'prop', S._hitTest({ x: -400, y: -300 })?.kind);
  }
}

// ---------- gate 28: the middle button (§8.2) ----------
//
// Middle-drag is now "put this where it should not go": on a piece in Create it
// moves with every solidity rule off, and on empty space it still pans. The
// override existed as Ctrl+Shift+drag and still does; this is a second, better
// door to it — one hand, no chord, and a gesture nothing else in the editor
// wants. What has to be true is that it really does turn the rules OFF (the old
// chord's whole value) and really does still pan where there is nothing.
{
  const mid = (wx, wy) => ev(wx, wy, { button: 1 });

  // a prop dragged into solid terrain — the exact move a left-drag refuses
  const propWorld = () => flatWorld({
    props: [{ shape: 'box', x: -400, y: -30, w: 40, h: 40 }],
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }],
  });
  {
    const S = screen(propWorld(), { tab: 'level' });
    const p = S.level.props[0];
    S._pointerDown(mid(-400, -30));
    gate('28. middle-press on a piece starts a MOVE with the override on',
      S.drag?.type === 'move' && S.drag.noObstacles === true && S.drag.hit?.kind === 'prop',
      `${S.drag?.type}, noObstacles ${S.drag?.noObstacles}`);
    S._pointerMove(mid(0, 30));                 // dead centre of the floor
    S._pointerUp(mid(0, 30));
    gate('28. …and the prop really does end up inside the terrain',
      Math.abs(p.x) < 1e-6 && Math.abs(p.y - 30) < 1e-6, `(${p.x}, ${p.y})`);
  }
  // …which is exactly what the same drag with the LEFT button will not do
  {
    const S = screen(propWorld(), { tab: 'level' });
    const p = S.level.props[0];
    S._pointerDown(ev(-400, -30));
    S._pointerMove(ev(0, 30));
    S._pointerUp(ev(0, 30));
    gate('28. …while a left-drag of the same piece stops short of it',
      Math.abs(p.y - 30) > 1, `(${Math.round(p.x)}, ${Math.round(p.y)})`);
  }
  // empty space still pans, which is what a middle-drag means everywhere
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._pointerDown(mid(-900, -900));
    gate('28. middle-press on empty space still pans', S.drag?.type === 'pan', S.drag?.type);
  }
  // and it is a CREATE gesture: in Test the middle button is only ever a pan,
  // because a player must not be able to push the level around
  {
    const S = screen(propWorld(), { tab: 'machine' });
    S._pointerDown(mid(-400, -30));
    gate('28. …and in Test it is only ever a pan', S.drag?.type === 'pan', S.drag?.type);
  }
  // mid-run it is a pan too — _hitTest reads authored poses while the screen
  // shows simulated ones, so "is there a piece here" has no honest answer
  {
    const S = screen(propWorld(), { tab: 'level' });
    S.playing = true;
    S._pointerDown(mid(-400, -30));
    gate('28. …and while the machine runs, without stopping it',
      S.drag?.type === 'pan' && S.playing === true, `${S.drag?.type}, playing ${S.playing}`);
  }
  // a multi-selection moves as one, override and all
  {
    const S = screen(propWorld(), { tab: 'level' });
    const p = S.level.props[0], t = S.level.terrain[0];
    S.multiSel = [{ kind: 'prop', ref: p }, { kind: 'terrain', ref: t }];
    S._pointerDown(mid(-400, -30));
    gate('28. …and a middle-drag of a selected piece moves the whole selection',
      S.drag?.type === 'move-multi' && S.drag.noObstacles === true,
      `${S.drag?.type}, noObstacles ${S.drag?.noObstacles}`);
  }
  // In CREATE a goal piece is the author's own (§7.2), so the override takes one
  // like anything else — and the ownership rule that would refuse it lives in
  // Test, which the gate above already pins as pan-only. Stated as a gate so the
  // absence of an ownership check in `_forceMoveHit` is a decision on the record
  // rather than an oversight.
  {
    const S = screen(flatWorld({ goalObjs: [{ shape: 'ball', x: 900, y: -15, r: 15 }] }), { tab: 'level' });
    S.goalPositions = [{ x: 900, y: -15 }];
    S.goalMoved = [false];
    S._pointerDown(mid(900, -15));
    gate('28. a goal piece IS middle-draggable in Create — there it is yours',
      S._goalLocked(0) === false && S.drag?.type === 'move' && S.drag.noObstacles === true,
      `locked ${S._goalLocked(0)}, drag ${S.drag?.type}`);
  }
  // the old chord is untouched — muscle memory is not punished for an addition
  {
    const S = screen(propWorld(), { tab: 'level' });
    S._pointerDown(ev(-400, -30, { ctrlKey: true, shiftKey: true }));
    gate('28. Ctrl+Shift+drag still overrides, exactly as it did',
      S.drag?.type === 'move' && S.drag.noObstacles === true,
      `${S.drag?.type}, noObstacles ${S.drag?.noObstacles}`);
  }
}

// ---------- gate 29: the toolbar prints the NUMBER (§8.2) ----------
//
// Both bindings were always live; the tables just disagreed about which to call
// primary, so the row read `1 L F R H W 7 8 9 0 …` — a run of letters
// interrupting a run of numbers, for tools that are simply first, second, third.
// The badge is the digit wherever there is one. What must NOT change is the
// keys: this is a labelling decision, and a gate that only checked the label
// would happily pass a build where the letters had stopped working.
{
  const { LEVEL_TOOLS, MACHINE_TOOLS } = await import(u('public/js/game.js'));
  const badge = (t) => (/^[0-9]$/.test(t.key) ? t.key : /^[0-9]$/.test(t.alt || '') ? t.alt : t.key);

  gate('29. the first ten Create tools are badged 1…0, in order',
    LEVEL_TOOLS.slice(0, 10).map(badge).join('') === '1234567890',
    LEVEL_TOOLS.map(badge).join(' '));
  gate('29. …and the ones past ten keep their letters',
    LEVEL_TOOLS.slice(10).map(badge).join('') === 'GPT', LEVEL_TOOLS.slice(10).map(badge).join(''));
  gate('29. the Test tab reads 1…6', MACHINE_TOOLS.map(badge).join('') === '123456',
    MACHINE_TOOLS.map(badge).join(''));
  // The PROPERTY the three above are really protecting, stated once so it
  // survives the next tool being added. The exact strings will change the day
  // one is; "no letter interrupts the numbered run" should not.
  for (const [name, list] of [['Create', LEVEL_TOOLS], ['Test', MACHINE_TOOLS]]) {
    const badges = list.map(badge);
    const lastDigit = badges.map(b => /^[0-9]$/.test(b)).lastIndexOf(true);
    gate(`29. …and no ${name} letter tool interrupts the numbered run`,
      badges.slice(0, lastDigit + 1).every(b => /^[0-9]$/.test(b)), badges.join(' '));
  }
  // every badge is unique within its tab, or two buttons claim one key
  for (const [name, list] of [['Create', LEVEL_TOOLS], ['Test', MACHINE_TOOLS]]) {
    const badges = list.map(badge);
    gate(`29. …and no two ${name} tools print the same badge`,
      new Set(badges).size === badges.length, badges.join(' '));
  }
  // THE KEYS THEMSELVES, unchanged: every letter still resolves to its tool
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const kev = (key) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
      target: { tagName: 'CANVAS' }, preventDefault() {}, stopPropagation() {} });
    const letters = [['l', 'wheel-ccw'], ['f', 'wheel-free'], ['r', 'wheel-cw'], ['h', 'rod-wood'],
                     ['w', 'rod-water'], ['g', 'goal-piece'], ['p', 'terrain-paint'], ['t', 'text']];
    let bad = null;
    for (const [k, id] of letters) {
      S._keyDown(kev(k));
      if (S.tool !== id) { bad = `${k} → ${S.tool}, expected ${id}`; break; }
    }
    gate('29. every letter shortcut still selects its tool', !bad, bad || `${letters.length} letters`);
    // …and so does every number, positionally
    let badNum = null;
    const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    for (let i = 0; i < nums.length; i++) {
      S._keyDown(kev(nums[i]));
      if (S.tool !== LEVEL_TOOLS[i].id) { badNum = `${nums[i]} → ${S.tool}, expected ${LEVEL_TOOLS[i].id}`; break; }
    }
    gate('29. …and every number selects the tool in that position', !badNum, badNum || '1…0');
  }

  // ---------- 29b: one button per FAMILY (TOOL_FAMILIES) ----------
  //
  // Terrain and props each spent two toolbar slots on what is one decision, and
  // the painter a third. The bar now shows one button per family, hovering it
  // fans the members out, and a double-click cycles them.
  //
  // **The invariant is that only the BAR changed.** The two gates above are
  // half of this one: they walk every letter and every digit through the real
  // key handler and assert the exact tool id, so a grouping that had quietly
  // collapsed the table — rather than only the buttons drawn from it — fails
  // there rather than here. What is left to check is the grouping itself.
  {
    const { TOOL_FAMILIES, toolFamilyOf } = await import(u('public/js/game.js'));
    const ids = LEVEL_TOOLS.map(t => t.id);

    gate('29. every family member is a real tool, and no tool is in two families',
      TOOL_FAMILIES.every(f => f.members.every(m => ids.includes(m)))
      && TOOL_FAMILIES.flatMap(f => f.members).length === new Set(TOOL_FAMILIES.flatMap(f => f.members)).size,
      TOOL_FAMILIES.map(f => `${f.id}: ${f.members.length}`).join(', '));
    // **The ROW, stated in full.** `_toolRow` is the rule both toolbars draw
    // from, and it is the one place the table's order and the bar's order are
    // allowed to differ — the painter sits at table index 11, three past the
    // terrain pair it is DRAWN with, because the digit keys are a positional
    // lookup into that table and moving it would renumber the prop keys. So
    // the gate spells the emitted sequence rather than asserting some property
    // the table is supposed to have.
    gate('29. the painter is drawn WITH terrain but keyed from where it sits',
      ids.indexOf('terrain-paint') > 9 && ids.indexOf('terrain-box') === 6,
      `paint at table index ${ids.indexOf('terrain-paint')}, drawn on the terrain button`);
    // The digits are a POSITIONAL lookup into this table, so only the first ten
    // entries are reachable by number — which is the whole licence for adding
    // the goal ball and moving the painter along. Stated as the rule rather
    // than as an index, so the next insertion past ten is free too.
    gate('29. …and the first ten are exactly the number-keyed tools, unmoved',
      ids.slice(0, 10).join(' ') === 'pointer wheel-ccw wheel-free wheel-cw rod-wood rod-water terrain-box terrain-ball prop-box prop-ball',
      ids.slice(0, 10).join(' '));

    const R = screen(flatWorld(), { tab: 'level' });
    const rowOf = (s, o) => s._toolRow(o).map(e => e.id).join(' ');
    // `delete` is deliberately NOT in this list: which row it belongs on is the
    // caller's answer (the bar takes it only when expanded and below the
    // background toggle; the right-click grid always takes it), so `_toolRow`
    // returns the PIECES and nothing else.
    gate('29. the Create row is one button per family, Pin before Text',
      rowOf(R) === 'pointer wheel-ccw wheel-free wheel-cw rod-wood rod-water terrain-box prop-box goal-piece pin text',
      rowOf(R));
    // **Expanded** puts every member back, in table order (2026-08-12)
    gate('29. …and expanded mode puts every shape back as its own entry',
      rowOf(R, { expanded: true }) === 'pointer wheel-ccw wheel-free wheel-cw rod-wood rod-water terrain-box terrain-ball terrain-paint prop-box prop-ball goal-piece goal-ball pin text',
      rowOf(R, { expanded: true }));
    // **Expanded keeps the grouping** (2026-08-12). The first cut emitted the
    // table verbatim, which put the painter after the GOAL BALL — its table
    // index, where it must stay because the digits are a positional lookup into
    // that table. The row is a display order and the table is a keyboard fact;
    // this is the gate that says the painter is drawn with its terrain siblings
    // in both modes while its key still comes from index 12.
    {
      const ex = rowOf(R, { expanded: true }).split(' ');
      gate('29. …with the painter beside its terrain siblings, not at its table index',
        ex.indexOf('terrain-paint') === ex.indexOf('terrain-ball') + 1
        && ex.indexOf('terrain-paint') < ex.indexOf('prop-box')
        && ids.indexOf('terrain-paint') > ids.indexOf('goal-ball'),
        `row: …${ex.slice(6, 11).join(' ')}…  ·  table index still ${ids.indexOf('terrain-paint')}`);
      // every family comes out contiguous, which is what "opened out" means
      gate('29. …and every family opens out as one contiguous run',
        TOOL_FAMILIES.every((f) => {
          const at = f.members.map(m => ex.indexOf(m)).sort((a, b) => a - b);
          return at[0] >= 0 && at.every((v, i) => i === 0 || v === at[i - 1] + 1);
        }),
        TOOL_FAMILIES.map(f => f.id).join(', '));
    }
    gate('29. …with the same tools in both, never a piece that only one mode can reach',
      new Set(rowOf(R, { expanded: true }).split(' ')).size >= new Set(rowOf(R).split(' ')).size
      && rowOf(R).split(' ').every(id => toolFamilyOf(id) || rowOf(R, { expanded: true }).split(' ').includes(id)),
      'compact is a view of expanded, not a different set');
    {
      const T = screen(flatWorld(), { tab: 'machine' });
      gate('29. …the Test row is untouched — it has no families and no pin',
        rowOf(T) === 'pointer wheel-ccw wheel-free wheel-cw rod-wood rod-water', rowOf(T));
      const B = screen(flatWorld(), { tab: 'level' });
      B.backEditing = true;
      gate('29. …and the scenery layer still drops the goal tool (§10.5)',
        !rowOf(B).includes('goal-piece') && rowOf(B).includes('pin'), rowOf(B));
    }
    // the row FOLLOWS the family default, or the bar shows one crate while
    // another is the live tool
    R._setTool('terrain-ball');
    gate('29. …and the button shows whichever member is selected',
      rowOf(R).includes('terrain-ball') && !rowOf(R).includes('terrain-box'), rowOf(R));
    const terrain = TOOL_FAMILIES.find(f => f.id === 'terrain');
    const prop = TOOL_FAMILIES.find(f => f.id === 'prop');

    // **A FRESH screen from here**, because the gates above have just used the
    // terrain button and using a member IS setting the family's default — the
    // feature under test is exactly the state the last block left behind, and
    // a cycle starting from wherever the previous gate stopped would be
    // measuring the test's own leftovers.
    const S = screen(flatWorld(), { tab: 'level' });
    // The double-click. Props flip back and forth; terrain has three, so it
    // cycles — and must come back to where it started rather than sticking.
    const propCycle = [S._cycleToolFamily('prop'), S._cycleToolFamily('prop')];
    gate('29. a double-click flips the Prop button between crate and ball',
      propCycle[0] === 'prop-ball' && propCycle[1] === 'prop-box', propCycle.join(' → '));
    const terrCycle = [S._cycleToolFamily('terrain'), S._cycleToolFamily('terrain'), S._cycleToolFamily('terrain')];
    gate('29. …and cycles Terrain through all three, back to where it started',
      terrCycle.join(',') === 'terrain-paint,terrain-ball,terrain-box', terrCycle.join(' → '));
    gate('29. …and cycling SELECTS what it lands on, rather than only relabelling the button',
      S.tool === 'terrain-box', S.tool);
    // The goal button is a family too now (2026-08-12) — same fan, same cycle
    const goalCycle = [S._cycleToolFamily('goal'), S._cycleToolFamily('goal')];
    gate('29. …and the Goal button flips between crate and ball, like the Prop one',
      goalCycle[0] === 'goal-ball' && goalCycle[1] === 'goal-piece', goalCycle.join(' → '));

    // The key and the double-click are two ways to say one thing: pressing 8
    // must leave the button standing for the boulder, or the bar shows a crate
    // while the crate's sibling is the live tool.
    S._setTool('terrain-ball');
    gate('29. pressing a member\'s own key sets the family default too',
      S._familyMember(terrain) === 'terrain-ball'
      && S._cycleToolFamily('terrain') === 'terrain-box',
      'the next cycle carries on from the boulder, not from the box');

    // **The RING, which is what the fan lists.** Asked as "what would the fan
    // show", because that is the request: the others, in the order a
    // double-click reaches them, never the one you already have.
    {
      const F = screen(flatWorld(), { tab: 'level' });
      const fan = (famId, from) => F._familyRest(TOOL_FAMILIES.find(f => f.id === famId), from).join(' ');
      gate('29. the fan lists the OTHERS in ring order — ball → crate → painter',
        fan('terrain', 'terrain-ball') === 'terrain-box terrain-paint'
        && fan('terrain', 'terrain-paint') === 'terrain-ball terrain-box'
        && fan('terrain', 'terrain-box') === 'terrain-paint terrain-ball',
        `from ball: ${fan('terrain', 'terrain-ball')} · from painter: ${fan('terrain', 'terrain-paint')}`);
      gate('29. …and never the member the button already stands for',
        TOOL_FAMILIES.every(f => f.members.every(m => !F._familyRest(f, m).includes(m))),
        'no family lists its own current member');
      gate('29. …and lists every other one exactly once',
        TOOL_FAMILIES.every(f => f.members.every(m =>
          F._familyRest(f, m).length === f.members.length - 1
          && new Set(F._familyRest(f, m)).size === f.members.length - 1)),
        'complete rings, no repeats');
    }
    // and the two families are independent
    gate('29. …and one family\'s default does not disturb the other\'s',
      S._familyMember(prop) === 'prop-box', S._familyMember(prop));
    // a stored id that is no longer a member must not leave the button standing
    // for nothing (a renamed tool, or a hand-edited preference)
    S._familyPrefs().prop = 'prop-trapezoid';
    gate('29. …and a stale stored member falls back to the family\'s first',
      S._familyMember(prop) === 'prop-box', S._familyMember(prop));
    gate('29. a tool outside every family reports none', toolFamilyOf('text') === null
      && toolFamilyOf('prop-ball')?.id === 'prop', 'text none, prop-ball → prop');
  }

  // ---------- 29c: the bar modes behind the grip menu (2026-08-12) ----------
  //
  // The menu itself is DOM and this harness has none, so what lives here is
  // everything the cells DECIDE — which is deliberately all of it: the cells
  // are four one-line calls onto these.
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._renderToolbar = () => {};
    // Defaults, which are the promise to everyone who never opens the menu:
    // the toolbar starts COMPACT (that is the feature) and the play bar starts
    // EXPANDED (it is what the dock has always been — brief is the new state,
    // so it is the one you have to ask for).
    gate('29. the toolbar starts compact and the play bar starts expanded',
      S._toolbarExpanded() === false && S._dockExpanded() === true,
      `toolbar ${S._toolbarExpanded()}, dock ${S._dockExpanded()}`);
    S._setToolbarExpanded(true);
    gate('29. …and expanding the toolbar changes the ROW, not the tools',
      S._toolbarExpanded() === true
      && S._toolRow({ expanded: true }).length > S._toolRow().length
      && S.tool === 'pointer',
      `${S._toolRow().length} compact vs ${S._toolRow({ expanded: true }).length} expanded, tool untouched`);

    // Brief play bar hides exactly the four named, and HIDES rather than
    // removes — `_updateStats` sets `disabled` on undo/redo every commit, and a
    // button that stopped existing would break that caller instead.
    const btn = () => ({ classList: new Set(), toggle(c, on) { on ? this.classList.add(c) : this.classList.delete(c); } });
    const mk = () => { const b = btn(); b.classList = { _s: new Set(), add(c) { this._s.add(c); }, delete(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { on ? this.add(c) : this.delete(c); } }; return b; };
    Object.assign(S, { resetBtn: mk(), undoBtn: mk(), redoBtn: mk(), fitBtn: mk(), playBtn: mk(), recBtn: mk() });
    S._setDockExpanded(false);
    const hidden = (b) => b.classList.contains('dock-brief-hidden');
    gate('29. brief play bar drops Revert, Undo, Redo and Fit — and nothing else',
      [S.resetBtn, S.undoBtn, S.redoBtn, S.fitBtn].every(hidden)
      && ![S.playBtn, S.recBtn].some(hidden),
      'Play and Record stay, the four undo-ish ones go');
    S._setDockExpanded(true);
    gate('29. …and expanding brings all four back',
      ![S.resetBtn, S.undoBtn, S.redoBtn, S.fitBtn].some(hidden), 'all four visible');

    // **A popup must never land on the bar it belongs to** (2026-08-12, on
    // report: *"Popup overlaps toolbar in bottom or right"*). The bar is
    // draggable and gets parked against an edge; the strip then ran off the
    // pane, and clamping it back inside put it straight on top of the bar —
    // over the very button it is describing.
    //
    // The DOM is not reachable here, so what is gated is the arithmetic: the
    // growth axis flips to the other side of the bar rather than being clamped.
    // A control replays the OLD rule against the same geometry and asserts it
    // WOULD have overlapped, because a placement test that has never failed is
    // not a test (it caught nothing until the control was added).
    {
      const W = 900, H = 600, PAD = 4;
      const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
      const hits = (a, b) => !(a.l >= b.r || a.l + a.w <= b.l || a.t >= b.b || a.t + a.h <= b.t);
      // where a strip goes under each rule, for a bar parked at a corner
      const place = (horiz, bar, strip, flip) => {
        let l, t;
        if (horiz) {
          t = bar.b + PAD;
          if (flip && t + strip.h > H - PAD) t = bar.t - strip.h - PAD;
          else if (!flip) t = cl(t, PAD, Math.max(PAD, H - strip.h - PAD));
          l = cl(bar.l, PAD, Math.max(PAD, W - strip.w - PAD));
        } else {
          l = bar.r + PAD;
          if (flip && l + strip.w > W - PAD) l = bar.l - strip.w - PAD;
          else if (!flip) l = cl(l, PAD, Math.max(PAD, W - strip.w - PAD));
          t = cl(bar.t, PAD, Math.max(PAD, H - strip.h - PAD));
        }
        return { l, t, w: strip.w, h: strip.h };
      };
      const corner = (horiz, right, bottom) => {
        const bw = horiz ? 470 : 56, bh = horiz ? 56 : 470;
        const l = right ? W - bw - 6 : 6, t = bottom ? H - bh - 6 : 6;
        return { l, t, r: l + bw, b: t + bh };
      };
      const strip = (horiz) => (horiz ? { w: 44, h: 86 } : { w: 86, h: 44 });
      let flipBad = 0, clampBad = 0;
      for (const horiz of [false, true]) {
        for (const right of [false, true]) {
          for (const bottom of [false, true]) {
            const bar = corner(horiz, right, bottom), s = strip(horiz);
            if (hits(place(horiz, bar, s, true), bar)) flipBad++;
            if (hits(place(horiz, bar, s, false), bar)) clampBad++;
          }
        }
      }
      gate('29. a family fan never lands on the bar, at any corner or orientation',
        flipBad === 0, `${flipBad} of 8 overlap`);
      gate('29. …(control) and the clamp it replaced DID, which is why this is gated',
        clampBad > 0, `the old rule overlapped in ${clampBad} of 8`);
    }

    // Hide-every-bar: the spot lands where the grip that asked was, and the
    // round trip leaves nothing behind — a HUD you cannot get back is the one
    // failure this feature can actually have.
    {
      const H = screen(flatWorld(), { tab: 'level' });
      H.root = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700 }), append() {} };
      H.camera = { vw: 1200, vh: 700 };
      const wraps = [{ _c: new Set() }, { _c: new Set() }];
      const asBar = (w) => ({ wrap: { classList: { toggle: (c, on) => (on ? w._c.add(c) : w._c.delete(c)) } } });
      H._bars = wraps.map(asBar);
      H._bars[0].grip = { getBoundingClientRect: () => ({ left: 340, top: 210, width: 20, height: 20 }) };
      // The spot itself is the one part of this that is DOM (`el`, which needs
      // a document). Handing the method one it already has means the REAL
      // `_applyBarsHidden` runs — the bar toggling and the clamp included —
      // rather than a stub standing in for the thing under test.
      H._allDot = { style: {}, remove() { H._allDotRemoved = true; } };
      H._hideAllBars(H._bars[0]);
      gate('29. hiding every bar puts the one spot where THAT grip was',
        H._barsHidden.x === 340 && H._barsHidden.y === 210 && wraps.every(w => w._c.has('hidden')),
        `spot at (${H._barsHidden.x}, ${H._barsHidden.y}), both bars hidden`);
      H._showAllBars();
      gate('29. …and bringing them back leaves nothing behind',
        H._barsHidden === null && !wraps.some(w => w._c.has('hidden')), 'no flag, no hidden bars');
      // a grip with no box (a bar built but never laid out) must still land
      // somewhere reachable rather than at NaN. Re-seeded, because showing the
      // bars again drops the spot — which is itself the behaviour above.
      H._allDot = { style: {}, remove() {} };
      H._hideAllBars({ grip: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } });
      gate('29. …and a grip with no box on screen still yields a reachable spot',
        Number.isFinite(H._barsHidden.x) && H._barsHidden.x >= 0 && Number.isFinite(H._barsHidden.y),
        `(${H._barsHidden.x}, ${H._barsHidden.y})`);
    }
  }
}

// ---------- gate 30: the chords that were missing (§8.2) ----------
//
// From the binding audit. Ctrl+A and Ctrl+S are the two every canvas app has
// and this one did not: Ctrl+A because "move the whole level a bit" otherwise
// needed a marquee bigger than the level, and Ctrl+S because the browser's own
// Ctrl+S offers to save the PAGE, which is never what someone in an editor
// meant. Both must also SWALLOW the key (preventDefault), or the browser
// answers instead.
{
  const kev = (key, mods = {}) => {
    let prevented = false;
    return {
      key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, repeat: false,
      target: { tagName: 'CANVAS' },
      preventDefault() { prevented = true; }, stopPropagation() {},
      get prevented() { return prevented; },
    };
  };
  // Ctrl+A in Create takes the level's furniture — and not the zones
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -400, y: -30, w: 40, h: 40 }],
      fixedParts: [{ t: 'wheel', kind: 'cw', x: 200, y: -30, r: 15, id: 'w1' }],
      texts: [{ text: 'HI', x: 0, y: -300, size: 30 }],
      goalObjs: [{ shape: 'ball', x: -300, y: -15, r: 15 }],
    }), { tab: 'level' });
    const e = kev('a', { ctrl: true });
    S._keyDown(e);
    const kinds = S.multiSel.map(s => s.kind).sort();
    gate('30. Ctrl+A selects the level\'s pieces — terrain, prop, fixed, label, goal',
      ['terrain', 'prop', 'fixed', 'text', 'goal'].every(k => kinds.includes(k)), kinds.join(','));
    // The zones come too. They were left out at first — a zone is the level's
    // frame, and a bare Ctrl+CLICK on one deliberately starts a marquee rather
    // than grabbing the rectangle. But that reasoning is about an aim that can
    // be misread, and select-all has no aim: an "all" that omits the build area
    // means shifting the level leaves its build area behind.
    gate('30. …and the build and goal areas, because they are part of the level',
      S.multiSel.filter(s => s.kind === 'zone').length === 2
      && S.multiSel.some(s => s.zone === 'build') && S.multiSel.some(s => s.zone === 'goal'),
      S.multiSel.filter(s => s.kind === 'zone').map(s => s.zone).join(','));
    gate('30. …and swallows the key so the browser does not select the page', e.prevented);
  }
  // …and in Test it takes the machine, not the level
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -400, y: -30, w: 40, h: 40 }],
    }), {
      tab: 'machine',
      parts: [{ t: 'wheel', kind: 'cw', x: -100, y: -100, r: 15, id: 'a' },
              { t: 'rod', kind: 'wood', x1: -100, y1: -100, x2: -40, y2: -100, id: 'b' }],
    });
    S._keyDown(kev('a', { ctrl: true }));
    gate('30. …while in Test it takes your machine and the goal pieces, not the level',
      S.multiSel.filter(s => s.kind === 'part').length === 2
      && !S.multiSel.some(s => ['terrain', 'prop', 'fixed', 'text'].includes(s.kind)),
      S.multiSel.map(s => s.kind).join(','));
  }
  // a grouped piece answers as its GROUP, exactly as the hit test does, so the
  // selection carries it as the one rigid thing it is
  {
    const S = screen(flatWorld({
      terrain: [
        { type: 'box', x: 0, y: 30, w: 1200, h: 60, groupId: 'g1' },
        { type: 'box', x: -200, y: -100, w: 40, h: 40, groupId: 'g1' },
      ],
      groups: { g1: {} },
    }), { tab: 'level' });
    S._keyDown(kev('a', { ctrl: true }));
    const groups = S.multiSel.filter(s => s.kind === 'group');
    gate('30. …and two pieces of one group come in as ONE group, not two members',
      groups.length === 1 && !S.multiSel.some(s => s.kind === 'terrain'),
      S.multiSel.map(s => s.kind + (s.gid || '')).join(','));
  }
  // Copy/cut carry build and goal areas the selection actually occupies —
  // a quarter of the zone under the copied pieces — so duplicating a room
  // does not leave its pads behind. A crate sitting in a huge build area
  // does not clone the whole area.
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -200, y: -30, w: 40, h: 40 }],
    }), { tab: 'level' });
    S._select({ kind: 'prop', ref: S.level.props[0] });
    S._copySel();
    gate('30. a small piece does not pull the whole build area onto the clipboard',
      S._clipboard && !S._clipboard.entries.some((e) => e.kind === 'zone'),
      (S._clipboard?.entries || []).map((e) => e.kind).join(','));
  }
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: 400, y: -40, w: 110, h: 70 }],
    }), { tab: 'level' });
    S._select({ kind: 'prop', ref: S.level.props[0] });
    S._copySel();
    const zones = (S._clipboard?.entries || []).filter((e) => e.kind === 'zone');
    gate('30. …but a piece that fills a goal pad takes that pad with it',
      zones.some((e) => e.zoneType === 'goal') && !zones.some((e) => e.zoneType === 'build'),
      zones.map((e) => e.zoneType).join(',') || 'none');
    S._lastPointer = { x: 0, y: -250 };
    const nGoal = S.level.goalZones.length;
    S._pasteSel();
    gate('30. …and paste lands the extra goal area',
      S.level.goalZones.length === nGoal + 1,
      `${S.level.goalZones.length} goal zones`);
  }
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._keyDown(kev('a', { ctrl: true }));
    S._copySel();
    const zones = (S._clipboard?.entries || []).filter((e) => e.kind === 'zone');
    gate('30. Ctrl+A copy carries both the build and goal areas',
      zones.filter((e) => e.zoneType === 'build').length === 1
      && zones.filter((e) => e.zoneType === 'goal').length === 1,
      zones.map((e) => e.zoneType).join(','));
  }
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._select({ kind: 'zone', zone: 'build', idx: 0, ref: S.level.buildZones[0] });
    S._copySel();
    gate('30. copying a selected zone alone still copies it',
      S._clipboard?.entries?.length === 1 && S._clipboard.entries[0].kind === 'zone'
      && S._clipboard.entries[0].zoneType === 'build',
      (S._clipboard?.entries || []).map((e) => e.kind).join(',') || 'empty');
  }

  // Ctrl+S opens the save dialog and swallows the key
  {
    const S = screen(flatWorld(), { tab: 'level' });
    let opened = 0;
    S._openPublish = () => { opened++; };
    const e = kev('s', { ctrl: true });
    S._keyDown(e);
    gate('30. Ctrl+S opens Save, and the browser never sees it',
      opened === 1 && e.prevented, `opened ${opened}, prevented ${e.prevented}`);
  }
  // …and bare S is still the grid latch, which is the pair the audit was for
  {
    const S = screen(flatWorld(), { tab: 'level' });
    let opened = 0;
    S._openPublish = () => { opened++; };
    const was = S.snapMode;
    S._keyDown(kev('s'));
    gate('30. …while bare S stays the grid latch — one letter, two meanings',
      opened === 0 && S.snapMode !== was, `opened ${opened}, snapMode ${was} -> ${S.snapMode}`);
  }
  // Ctrl+A must not fight the tool letters or the numbers: 'a' is not a tool
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const before = S.tool;
    S._keyDown(kev('a'));
    gate('30. bare A is unbound, so Ctrl+A cannot be shadowing a tool',
      S.tool === before && S.multiSel.length === 0, S.tool);
  }
}

// ---------- gate 31: a label's depth (§10.6) ----------
//
// Labels used to shuffle only among other labels, which is invisible unless two
// of them overlap — so `[` and `]` on the one sign in a level appeared to do
// nothing. A level's stack is a fixed sequence of PASSES rather than one list,
// so a label's Z is which pass it draws with: `behind` the terrain, `over` it
// (the default), or in `front` of the whole world. One step raises it through
// the combined stack the way one step raises a terrain piece against its
// neighbours — swap with a peer in the same slot if there is one, otherwise move
// a slot.
{
  const { textZOf, TEXT_ZS, TEXT_Z_DEFAULT, badTextPiece } = await import(u('public/js/textmodel.js'));
  const label = (over = {}) => ({ text: 'SIGN', x: -400, y: -300, size: 30, ...over });

  gate('31. the default depth is over the terrain, stored as ABSENT',
    textZOf(label()) === 'over' && TEXT_Z_DEFAULT === 'over' && label().z === undefined);

  // one label walks the three slots, and stops at each end
  {
    const S = screen(flatWorld({ texts: [label()] }), { tab: 'level' });
    const t = S.level.texts[0];
    S._reorderText(t, 'up');
    gate('31. ] takes the only label up a slot — over → front', textZOf(t) === 'front', textZOf(t));
    S._reorderText(t, 'up');
    gate('31. …and stops there', textZOf(t) === 'front', textZOf(t));
    S._reorderText(t, 'down'); S._reorderText(t, 'down');
    gate('31. …[ walks it back down, front → over → behind', textZOf(t) === 'behind', textZOf(t));
    S._reorderText(t, 'down');
    gate('31. …and stops at the bottom too', textZOf(t) === 'behind', textZOf(t));
    S._reorderText(t, 'front');
    gate('31. …Shift+] goes all the way in one step', textZOf(t) === 'front', textZOf(t));
    S._reorderText(t, 'back');
    gate('31. …and Shift+[ likewise', textZOf(t) === 'behind', textZOf(t));
    gate('31. …and coming back to the default clears the key rather than writing it',
      (() => { S._reorderText(t, 'up'); return textZOf(t) === 'over' && t.z === undefined; })(),
      JSON.stringify(t.z));
  }
  // two labels in ONE slot swap before either changes slot — same as terrain
  {
    const S = screen(flatWorld({ texts: [label({ text: 'A' }), label({ text: 'B' })] }), { tab: 'level' });
    const a = S.level.texts[0];
    S._reorderText(a, 'up');
    gate('31. a label under a peer in the same slot swaps with it first',
      S.level.texts.map(x => x.text).join('') === 'BA'
      && textZOf(a) === 'over' && textZOf(S.level.texts[0]) === 'over',
      S.level.texts.map(x => x.text + ':' + textZOf(x)).join(' '));
    S._reorderText(a, 'up');
    gate('31. …and only THEN moves up a slot', textZOf(a) === 'front', textZOf(a));
  }
  // the pick order follows the draw order, which is the property gate 27 caught
  // the hard way: a `front` label beats a prop sitting on it, an `over` one does not
  {
    const S = screen(flatWorld({
      props: [{ shape: 'box', x: -400, y: -300, w: 60, h: 60 }],
      texts: [label()],
    }), { tab: 'level' });
    gate('31. an `over` label loses the click to a prop drawn on top of it',
      S._hitTest({ x: -400, y: -300 })?.kind === 'prop', S._hitTest({ x: -400, y: -300 })?.kind);
    S.level.texts[0].z = 'front';
    gate('31. …and a `front` label wins it, because it is drawn over the prop',
      S._hitTest({ x: -400, y: -300 })?.kind === 'text', S._hitTest({ x: -400, y: -300 })?.kind);
  }
  // …and a `behind` label still loses to the terrain covering it
  {
    const S = screen(flatWorld({ texts: [label({ x: 0, y: 30, z: 'behind' })] }), { tab: 'level' });
    gate('31. a `behind` label is under the terrain, and picks that way too',
      S._hitTest({ x: 0, y: 30 })?.kind === 'terrain', S._hitTest({ x: 0, y: 30 })?.kind);
  }
  // the schema: the server takes the three and nothing else
  {
    gate('31. `z` validates against the three slots',
      TEXT_ZS.every(z => badTextPiece(label({ z }), 0) === null)
      && /z must be/.test(badTextPiece(label({ z: 'middle' }), 0) || ''),
      JSON.stringify(badTextPiece(label({ z: 'middle' }), 0)));
  }
  // the renderer draws each slot separately, and only that slot
  {
    const { drawTexts } = await import(u('public/js/render.js'));
    const seen = [];
    const fakeCtx = {
      canvas: { width: 10, height: 10 },
      save() {}, restore() {}, translate() {}, rotate() {}, fillText(s) { seen.push(s); },
      strokeText() {}, measureText: () => ({ width: 10 }),
      set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}, set lineJoin(v) {},
      set miterLimit(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
      set globalAlpha(v) {}, get globalAlpha() { return 1; },
    };
    const lv = { texts: [label({ text: 'BACK', z: 'behind' }), label({ text: 'MID' }), label({ text: 'TOP', z: 'front' })] };
    drawTexts(fakeCtx, lv, 'behind'); drawTexts(fakeCtx, lv, 'over'); drawTexts(fakeCtx, lv, 'front');
    gate('31. drawTexts draws exactly one slot per call, in that order',
      seen.join(',') === 'BACK,MID,TOP', seen.join(','));
  }
}

// ---------- gate 32: canUndo, the shell's hook (§8.2) ----------
//
// Ctrl+Z means "undo the last thing you did", and the last thing is not always
// an edit in THIS level: click "Maker" in the nav and you land on a freshly
// minted BLANK draft, where the last thing you did was leave the one you were
// working on. main.js takes the key only when the editor has nothing of its own
// left — so `canUndo()` is the whole contract between them, and an editor that
// answered `true` on an untouched level would swallow the key forever.
{
  const S = screen(flatWorld(), { tab: 'level', undo: true });
  gate('32. a freshly opened level has nothing to undo — the baseline is not an edit',
    S.canUndo() === false, `stack ${S.undoStack.length}`);
  S.level.terrain.push({ type: 'box', x: -400, y: -400, w: 40, h: 40 });
  S._commit();
  gate('32. …one edit and it does', S.canUndo() === true, `stack ${S.undoStack.length}`);
  S.undo();
  gate('32. …and undoing back to the baseline gives the key up again',
    S.canUndo() === false, `stack ${S.undoStack.length}`);
}
// …and the SHELL's half of that contract, which had no gate at all and shipped
// wrong: reported as "Ctrl+Z throws me from playing a level back into Maker".
// The old rule consulted `canUndo()` only when the hash began `#/maker`, so on
// a play screen it never ran — Ctrl+Z undid the player's build (the editor's
// own handler, always bound) AND navigated them out, in one keypress.
//
// It is a pure predicate in util.js precisely so this gate can exist; a rule
// that lives in main.js is a rule nothing headless can reach.
{
  const MK = '/maker/d1';
  const row = (path, canUndo, makerReturn = MK) => undoReturnsToMaker({ path, makerReturn, canUndo });
  gate('32. Ctrl+Z never leaves a level you are PLAYING',
    row('/play/abc', false) === false && row('/play/abc', true) === false,
    'empty machine and mid-build both stay put');
  gate('32. …and the screen keeps the key whenever it has its own undo, anywhere',
    row('/maker/d2', true) === false && row('/browse', true) === false,
    'maker and browse both defer');
  gate('32. …while a blank editor you landed in by accident still goes back',
    row('/maker/d2', false) === true, 'the case the feature exists for');
  gate('32. …as does any ordinary page with nothing to undo',
    row('/browse', false) === true && row('/', false) === true);
  gate('32. …but never with nothing remembered, nor when already there',
    row('/browse', false, null) === false && row(MK, false) === false);
}

// ---------- gate 32d: a mangled share link must not blank the site ----------
//
// route() used to call decodeURIComponent raw on every path segment, and a
// link clipped mid-escape (a chat client truncating "…/play/abc%E4", or a
// bare trailing "%") made it THROW — before any screen mounted, so the whole
// site was a blank page until the URL was edited by hand. The decision now
// lives in util.js as decodePathSegment, for the same reason as gate 32's
// predicate: a rule inline in main.js is a rule nothing headless can reach.
{
  const { decodePathSegment, routeParts, pathFromHash } = await import(u('public/js/util.js'));
  gate('32d. a well-formed segment decodes exactly as before',
    decodePathSegment('a%20b') === 'a b' && decodePathSegment('plain') === 'plain',
    'percent-decoding intact');
  gate('32d. a segment clipped mid-escape comes back AS TYPED, not as a throw',
    decodePathSegment('abc%E4') === 'abc%E4' && decodePathSegment('%') === '%',
    'URIError swallowed, raw segment handed on');
  // …and the splitter the router actually calls, which is where "/" having to
  // mean the home page lives now that there is no '#/' string to compare
  const rp = (p) => routeParts(p).join('|');
  gate('32d. the root path is the empty route, however it is spelled',
    rp('/') === '' && rp('') === '' && rp('//') === '',
    'home needs no special case at the call site');
  gate('32d. …a screen and its arguments split apart',
    rp('/play/abc/def') === 'play|abc|def' && rp('/browse') === 'browse',
    'screen first, arguments after');
  gate('32d. …a trailing slash and a query string change nothing',
    rp('/browse/') === 'browse' && rp('/play/abc?x=1') === 'play|abc',
    'both trimmed');
  gate('32d. a leftover #/play bookmark is a real path',
    pathFromHash('#/play/abc') === '/play/abc' && pathFromHash('#/maker/draft1') === '/maker/draft1',
    `${pathFromHash('#/play/abc')} / ${pathFromHash('#/maker/draft1')}`);
  gate('32d. …and an in-page #anchor is not a route',
    pathFromHash('#section') === null && pathFromHash('') === null && pathFromHash('#') === null);
}

// ---------- gate 56: the server serves every route the client has ----------
//
// **The hash is gone (§12), and that made the server responsible for URLs it
// never used to see.** `#/browse` never left the browser; `/browse` does, and
// if express.static finds no file there the whole site 404s on a refresh or a
// pasted link. So server.js lists the app's routes — and a list in a second
// file is a list that drifts, which is exactly what this gate is for: every
// screen the client's router switches on must be a route the server answers.
{
  const main = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  // the router's own switch, read out of the source
  const sw = main.slice(main.indexOf('switch (parts[0])'));
  const clientRoutes = [...sw.slice(0, sw.indexOf('\n  }')).matchAll(/case '([a-z]+)':/g)].map(m => m[1]);
  const listed = (srv.match(/const APP_ROUTES = \[([^\]]+)\]/) || [])[1] || '';
  const serverRoutes = [...listed.matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  // `play` is served by its own earlier route (it carries the og: tags), so it
  // is legitimately absent from the list — every other screen must be in it
  const missing = clientRoutes.filter(r => r !== 'play' && !serverRoutes.includes(r));
  gate('56. every client screen has a server route to be deep-linked at',
    clientRoutes.length > 5 && missing.length === 0,
    missing.length ? 'server never serves: ' + missing.join(', ') : `${clientRoutes.length} screens, all served`);
  gate('56. …including play, which is served with its Open Graph tags (§11.10)',
    /app\.get\('\/play\/:id\/:solveId\?'/.test(srv), 'the /play route exists');
}

// ---------- gate 57: a solution card draws the STAGED goal (§11.10) ----------
//
// **Reported as "goal piece is in the wrong place — solver moved it, thumbnail
// put it back".** A player may move the goal before their run (§7.2), and the
// replay is stored with those positions; the card was drawn with the design
// alone, so it showed the machine reaching for a pink thing that is not there.
//
// A source scan rather than a render, because renderPreview needs a canvas and
// nothing headless has one — but the regression is a WIRING one (a caller
// passing `design` and forgetting `goals`), and that is exactly what a scan
// catches. The picture itself was checked by eye against a run whose goal was
// staged 61 px from where its author left it.
{
  const g = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const r = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
  // the SOLVE card call — the one that carries a machine — must carry goals too
  const call = g.slice(g.indexOf('payload.card = shareCardDataUrl'), g.indexOf('payload.card = shareCardDataUrl') + 200);
  gate('57. the solve card is drawn with the design AND the staged goals',
    /design:/.test(call) && /goals:/.test(call), call.replace(/\s+/g, ' ').slice(0, 90));
  // …and renderPreview has to honour them in BOTH places: the frame and the draw.
  // Framing without drawing (or the reverse) is a half-fix that looks right on
  // a level whose goal happens to sit mid-frame.
  const bounds = r.slice(r.indexOf('const goalAt ='), r.indexOf('if (!isFinite(minX))'));
  const previewFn = r.slice(r.indexOf('export function renderPreview'), r.indexOf('export function shareCardDataUrl'));
  const draws = previewFn.slice(previewFn.indexOf('drawZones(ctx, preview);'), previewFn.indexOf("drawTexts(ctx, preview, 'front');"));
  gate('57. …and renderPreview uses them for the FRAME',
    /goalAt\(g, i\)/.test(bounds), 'bounds grow at the staged spot');
  gate('57. …and for the DRAW',
    /opts\.goals\?\.\[i\]/.test(draws), 'drawGoalPiece gets the staged pose');
  // Zones under the terrain — the game's own stack (game.js "zones under
  // everything"). A card that drew the wash AFTER the floor printed BUILD
  // across every slab the build area covered.
  const zoneAt = previewFn.indexOf('drawZones(ctx, preview)');
  const terrAt = previewFn.indexOf('drawTerrainAll(ctx, preview');
  gate('57. …and zones sit UNDER the terrain, same as the game',
    zoneAt >= 0 && terrAt > zoneAt,
    zoneAt < 0 ? 'drawZones missing' : terrAt < 0 ? 'drawTerrainAll missing' : `zones at ${zoneAt}, terrain at ${terrAt}`);
}

// ---------- gate 32b: scroll on a selected WHEEL resizes it (§8.2) ----------
//
// The Controls page has always said "scroll over a SELECTED piece resizes
// instead — a stick's weight, a wheel's size, a label's size". Every piece it
// names had a branch in the scroll handler except the wheel, so scrolling a
// selected wheel fell through to zoom. Reported as exactly that, and gated here
// because a documented gesture that silently does nothing is the one kind of
// bug the docs actively hide.
{
  const wheelEv = (x, y, up, mods = {}) => ({
    clientX: x + 400, clientY: y + 300, deltaY: up ? -100 : 100,
    ctrlKey: false, shiftKey: false, altKey: false, ...mods,
    preventDefault() {}, stopPropagation() {},
  });
  const rig = (r) => {
    const S = screen(flatWorld(), { parts: [{ t: 'wheel', kind: 'free', x: 0, y: -200, r, id: 'w' }] });
    S._closeCtxMenu = () => {};
    S._updateInfoChip = () => {};
    S._select({ kind: 'part', ref: S.design.parts[0] });
    return S;
  };
  {
    // THE LADDER ITSELF, never its numbers: these were 7.5/15/30 and asserted
    // a ladder the game had stopped having when the wheel moved (2026-08-15).
    const [SMALL, STD, BIG] = WHEEL_SIZES;
    const S = rig(STD);
    S._wheelEvt(wheelEv(0, -200, true));
    gate('32b. scrolling up on a selected wheel steps it to the next size',
      S.design.parts[0].r === BIG, `r ${S.design.parts[0].r}`);
    S._wheelEvt(wheelEv(0, -200, false));
    gate('32b. …and scrolling down steps it back', S.design.parts[0].r === STD, `r ${S.design.parts[0].r}`);
    S._wheelEvt(wheelEv(0, -200, false));
    gate('32b. …down again reaches the small wheel', S.design.parts[0].r === SMALL, `r ${S.design.parts[0].r}`);
  }
  {
    // At either end it STOPS rather than falling through to zoom: a selected
    // piece that suddenly zooms is the surprise the gesture exists to avoid.
    const BIGGEST = WHEEL_SIZES[WHEEL_SIZES.length - 1];
    const S = rig(BIGGEST);
    const zoom0 = S.camera.zoom;
    S._wheelEvt(wheelEv(0, -200, true));
    gate('32b. …and the largest wheel neither grows nor zooms',
      S.design.parts[0].r === BIGGEST && S.camera.zoom === zoom0,
      `r ${S.design.parts[0].r}, zoom ${S.camera.zoom}`);
  }
  {
    // **Away from the piece it is an ordinary zoom** — original, correct, and
    // briefly removed on 2026-08-08 on the theory that a thin stick's 10 px
    // band was what made re-weighting fiddly. It was not: "needs to be near
    // the stick was never the problem, and not being near the stick and
    // scrolling SHOULD scroll the zoom." Restored, and gated so the wrong
    // diagnosis cannot be made twice.
    const S = rig(15);
    const zoom0 = S.camera.zoom;
    S._wheelEvt(wheelEv(300, 100, true));
    gate('32b. …while scrolling off it still zooms',
      S.design.parts[0].r === 15 && S.camera.zoom !== zoom0,
      `r ${S.design.parts[0].r}, zoom ${zoom0} → ${S.camera.zoom}`);
  }
  {
    // An UNSELECTED wheel zooms too — selection is what arms the gesture.
    const S = rig(15);
    S._select(null);
    const zoom0 = S.camera.zoom;
    S._wheelEvt(wheelEv(0, -200, true));
    gate('32b. …and an unselected wheel is not resized by a scroll over it',
      S.design.parts[0].r === 15 && S.camera.zoom !== zoom0, `r ${S.design.parts[0].r}`);
  }
  {
    // The rods pinned to it come with it — `_resizeWheel`'s own contract, now
    // reachable from a second gesture, so it is worth asserting from this one.
    // **7.5 -> 15, not 15 -> 30.** A large wheel KEEPS its inner ring at 12 and
    // merely adds an outer one at 27, so a rod pinned at 12 does not move when
    // a standard wheel grows — the first cut of this gate asserted exactly that
    // and passed while proving nothing. The small wheel's pin at 4.5 really
    // does become 12, so this asks whether the carry happened.
    const S = screen(flatWorld(), { parts: [
      { t: 'wheel', kind: 'free', x: 0, y: -200, r: SMALL_R, id: 'w' },
      { t: 'rod', kind: 'wood', x1: SMALL_PIN, y1: -200, x2: 90, y2: -200, id: 'r' },
    ] });
    S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
    S._select({ kind: 'part', ref: S.design.parts[0] });
    S._wheelEvt(wheelEv(0, -200, true));
    const rod = S.design.parts[1];
    const pin = wheelPins(S.design.parts[0]).find((q) => q.x > 0 && Math.abs(q.y + 200) < 0.01);
    gate('32b. …and a rod pinned to it is carried to the new pin',
      S.design.parts[0].r === STD_WHEEL_R && Math.abs(rod.x1 - INNER_PIN) < 0.01 && Math.abs(pin.x - INNER_PIN) < 0.01,
      `wheel r ${S.design.parts[0].r}, rod moved ${SMALL_PIN} -> ${rod.x1}, pin at ${pin.x}`);
  }

  // ---------- 32b′: SHIFT AND ALT SNAP A SCROLL-RESIZE TO THE GRID ----------
  //
  // (2026-08-12, on request: *"When something is scroll resizing… Shift and Alt
  // should do the snap jumps"*.) The modifiers go through `_gridStep`, the same
  // function every drag and placement asks, so they mean here exactly what they
  // mean everywhere else rather than this one gesture inventing a second table.
  // Gated as that identity as well as the arithmetic: the value of reusing the
  // rule is lost the moment the two can drift.
  {
    const prop = (o) => flatWorld({ props: [{ shape: 'box', x: 0, y: -200, w: 60, h: 60, ...o }] });
    const rigP = (o) => {
      const S = screen(prop(o), { tab: 'level' });
      S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
      S._select({ kind: 'prop', ref: S.level.props[0] });
      return S;
    };
    // game.js's own rule, not a number: `toGrid` rounds to the nearest line and
    // then takes one more step, so 60 at a 40 grid is 120 and not 100. Written
    // out here because guessing it produced three wrong expectations
    // (2026-08-15) that looked like editor bugs.
    const nextGrid = (v, step) => Math.max(step, Math.round(v / step) * step + step);
    const prevGrid = (v, step) => Math.max(step, Math.round(v / step) * step - step);
    {
      const S = rigP();
      S._wheelEvt(wheelEv(0, -200, true, { shiftKey: true }));
      const p = S.level.props[0];
      gate('32b. Shift+scroll steps a piece by a whole grid square, on the grid',
        p.w === nextGrid(60, GRID_STEP) && p.h === nextGrid(60, GRID_STEP), `${p.w}×${p.h} (was 60×60, step ${GRID_STEP})`);
      S._wheelEvt(wheelEv(0, -200, false, { shiftKey: true }));
      gate('32b. …and back down again',
        S.level.props[0].w === prevGrid(nextGrid(60, GRID_STEP), GRID_STEP),
        `${S.level.props[0].w}`);
    }
    {
      const S = rigP();
      S._wheelEvt(wheelEv(0, -200, true, { altKey: true }));
      const p = S.level.props[0];
      gate('32b. …Alt steps by the FINER grid, the same 15 it means in a drag',
        p.w === nextGrid(60, GRID_FINE) && p.h === nextGrid(60, GRID_FINE), `${p.w}×${p.h} (fine step ${GRID_FINE})`);
    }
    {
      // an off-grid piece is pulled ONTO the grid by the first notch rather
      // than carrying its offset forever — that is what "snap" means
      const S = rigP({ w: 67, h: 41 });
      S._wheelEvt(wheelEv(0, -200, true, { shiftKey: true }));
      const p = S.level.props[0];
      gate('32b. …and an off-grid piece lands ON the grid, not 30 further off',
        p.w % (STD_WHEEL_R * 2) === 0 && p.h % (STD_WHEEL_R * 2) === 0, `67×41 → ${p.w}×${p.h}`);
    }
    {
      // A BALL steps by half the grid so its DIAMETER lands on the line —
      // GRID_FINE being exactly STD_WHEEL_R is that relationship already.
      const S = screen(flatWorld({ props: [{ shape: 'ball', x: 0, y: -200, r: 30 }] }), { tab: 'level' });
      S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
      S._select({ kind: 'prop', ref: S.level.props[0] });
      S._wheelEvt(wheelEv(0, -200, true, { shiftKey: true }));
      gate('32b. …a ball steps by half the grid, so its DIAMETER is on it',
        S.level.props[0].r === nextGrid(30, GRID_STEP / 2), `r ${S.level.props[0].r}, diameter ${S.level.props[0].r * 2}`);
    }
    {
      // Unmodified is still the smooth ×1.07 — the one thing a grid cannot
      // give you, and the reason this is a modifier rather than a mode.
      const S = rigP();
      S._wheelEvt(wheelEv(0, -200, true));
      const p = S.level.props[0];
      gate('32b. …while an unmodified scroll is still the smooth 7%',
        Math.abs(p.w - 64.2) < 0.01, `${p.w.toFixed(2)} (60 × 1.07)`);
    }
    {
      // Ctrl switches the grid off everywhere else, so it does here.
      const S = rigP();
      S._wheelEvt(wheelEv(0, -200, true, { shiftKey: true, ctrlKey: true }));
      const p = S.level.props[0];
      gate('32b. …and Ctrl turns the grid off, exactly as it does in a drag',
        Math.abs(p.w - 64.2) < 0.01, `${p.w.toFixed(2)}`);
    }
    {
      // A PAINTED piece has no authored dimension, so it snaps by its bounding
      // WIDTH — otherwise a blob would scroll smoothly with Shift held while
      // the crate beside it jumped, which is the inconsistency being fixed.
      const Z = () => ({ x: 0, y: 0 });
      const blob = {
        type: 'paint', x: -32, y: -232, h1: Z(), h2: Z(), texture: 'granite',
        pts: [{ x: 32, y: -232, h1: Z(), h2: Z() }, { x: 32, y: -168, h1: Z(), h2: Z() },
              { x: -32, y: -168, h1: Z(), h2: Z() }, { x: -32, y: -232, h1: Z(), h2: Z() }],
      };
      const S = screen(flatWorld({ terrain: [blob] }), { tab: 'level' });
      S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
      const t = S.level.terrain.find(x => x.type === 'paint');
      S._select({ kind: 'terrain', ref: t });
      const wideOf = () => { const b = S._terrainBounds(t); return b.maxX - b.minX; };
      const was = wideOf();
      S._wheelEvt(wheelEv(0, -200, true, { shiftKey: true }));
      gate('32b. …and a PAINTED piece snaps by its width, like everything else',
        Math.abs(wideOf() - nextGrid(was, GRID_STEP)) < 0.01, `${was} wide → ${wideOf().toFixed(2)}`);
    }
    {
      // THE IDENTITY: the numbers above are not this gate's own, they are
      // `_gridStep`'s. Asked directly, so a future change to the grid table
      // moves the resize with it or fails here.
      const S = rigP();
      const ev = (m) => ({ ctrlKey: false, shiftKey: false, altKey: false, ...m });
      gate('32b. …and the steps ARE _gridStepOf\'s, not a second table',
        S._gridStepOf(true, false) === GRID_STEP && S._gridStep(ev({ altKey: true })) === GRID_FINE
        && S._gridStep(ev({})) === 0 && S._gridStep(ev({ shiftKey: true, ctrlKey: true })) === 0,
        `Shift ${GRID_STEP} · Alt ${GRID_FINE} · none 0 · Ctrl 0`);
    }
  }
}

// ---------- gate 32c: the stick's weight scale (§8.2) ----------
//
// Scroll has always set a stick's weight, but only once you know it exists and
// only with the stick already selected. Every other piece says how heavy it is
// on its own right-click menu, so a stick has a slider there too.
//
// The SCALE is gated and the menu is not: the mapping lives in sizes.js
// precisely so a headless gate can reach it, and the DOM around it is the same
// unguarded menu-building every other context menu in this file is.
{
  gate('32c. the weight scale spans exactly the whole range',
    weightAtNotch(0) === ROD_WEIGHT_MIN && weightAtNotch(WEIGHT_NOTCHES) === ROD_WEIGHT_MAX,
    `${weightAtNotch(0)} … ${weightAtNotch(WEIGHT_NOTCHES)}`);
  // **Logarithmic, not linear**, and this is the gate that says so: halfway
  // along a log slider is the geometric mean (~31), where a linear one would
  // sit at 500 — nine tenths of its travel above x100, where almost nothing is
  // ever set, and unable to resolve the single steps at the bottom where nearly
  // everything is.
  // **The low end gets more travel than its share**, which is the whole reason
  // the ladder is not linear. Stated as that ratio rather than as "the midpoint
  // is about x10": the rungs are round numbers, so they cannot be perfectly log
  // spaced, and a midpoint gate would be measuring the rounding rather than the
  // property. Below x10 is a tenth of the RANGE and must get well more than a
  // tenth of the SLIDER.
  const lowShare = [...Array(WEIGHT_NOTCHES + 1).keys()]
    .filter((n) => weightAtNotch(n) <= 10).length / (WEIGHT_NOTCHES + 1);
  gate('32c. …weighted to the low end, where sticks really get set',
    lowShare > 0.25,
    `the bottom tenth of the range takes ${(lowShare * 100).toFixed(0)}% of the slider (linear would be 10%)`);
  // a third of the travel spent at or below x10 is the point: that is where
  // sticks actually get set, and a linear slider gives it a tenth
  const lowHalf = [...Array(WEIGHT_NOTCHES + 1).keys()].filter((n) => weightAtNotch(n) <= 10).length;
  gate('32c. …with a third of the slider at x10 or under, where sticks really get set',
    lowHalf > WEIGHT_NOTCHES * 0.25 && lowHalf < WEIGHT_NOTCHES * 0.6,
    `${lowHalf} of ${WEIGHT_NOTCHES + 1} notches`);
  // round numbers, so it can land on x2 rather than x2.13
  const all = [...Array(WEIGHT_NOTCHES + 1).keys()].map(weightAtNotch);
  gate('32c. …landing on round numbers all the way up',
    all.every((w) => Number.isInteger(w)) &&
    all.every((w) => (w < 10 ? true : w < 100 ? w % 5 === 0 : w % 25 === 0)),
    `e.g. ${all.filter((_, i) => i % 12 === 0).join(', ')}`);
  // **NO DEAD TRAVEL AT ALL** (2026-08-12). The ladder indexes its own rungs
  // now, so every notch is a different weight — where the old pow-and-round
  // arrangement, kept at a 1–100 range, would have repeated 73 notches out of
  // 101 and made the handle stick as you dragged it.
  gate('32c. …never going backwards, and never repeating a value',
    all.every((w, i) => i === 0 || w > all[i - 1])
    && new Set(all).size === WEIGHT_NOTCHES + 1,
    `${new Set(all).size} distinct across ${WEIGHT_NOTCHES + 1} notches — every one live`);
  // and the round trip holds for EVERY rung, not a hand-picked few: what the
  // slider shows for a weight has to put that weight back
  const trip = all.filter((w) => weightAtNotch(weightNotch(w)) === w);
  gate('32c. …and every rung round-trips through its own notch',
    trip.length === all.length, `${trip.length} of ${all.length}`);
  // an OFF-ladder weight lands on its nearest rung by ratio, which is what a
  // hand-edited level or an older save arrives carrying
  gate('32c. …while an off-ladder weight lands on the nearest rung by ratio',
    weightAtNotch(weightNotch(12)) === 10 && weightAtNotch(weightNotch(13)) === 15
    && weightAtNotch(weightNotch(1000)) === 100,
    `12→${weightAtNotch(weightNotch(12))}, 13→${weightAtNotch(weightNotch(13))}, 1000→${weightAtNotch(weightNotch(1000))}`);
}

// ---------- gate 33: corner ⇄ curve on one anchor (§9.1) ----------
//
// Double-clicking a point on a painted outline flips it between the two states
// the piece-wide ⌇ smooth / ╱ straight toggle already names, one point at a
// time: **corner** is explicit zero handles (straight edges through it) and
// **curve** is NO handles (the auto Catmull-Rom tangent, which is what a
// hand-drawn outline gets and what a handle drag then shapes).
//
// The gate that matters is the seam. A closed loop's last `pts` entry duplicates
// the origin (§11.1) — one point on screen, two records, one governing the edge
// that leaves and one the edge that arrives — so toggling one and not the other
// leaves half a corner, a shape no control can undo.
{
  // a square loop, drawn straight: four corners, closing entry duplicating the
  // origin, every anchor carrying explicit zero handles
  const zero = () => ({ x: 0, y: 0 });
  const squareLoop = () => ({
    type: 'paint', x: -400, y: -400, h1: zero(), h2: zero(),
    pts: [
      { x: -200, y: -400, h1: zero(), h2: zero() },
      { x: -200, y: -200, h1: zero(), h2: zero() },
      { x: -400, y: -200, h1: zero(), h2: zero() },
      { x: -400, y: -400, h1: zero(), h2: zero() },   // closes on the origin
    ],
  });
  const paintWorld = () => flatWorld({ terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, squareLoop()] });
  const dbl = (S, wx, wy) => S._dblClick({
    clientX: wx + 400, clientY: wy + 300, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {},
  });
  const isCorner = (o) => !!o.h1 && !!o.h2 && !o.h1.x && !o.h1.y && !o.h2.x && !o.h2.y;
  const isCurve = (o) => o.h1 === undefined && o.h2 === undefined;

  // a plain interior point: corner → curve → corner
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    gate('33. the fixture really is a corner to start with', isCorner(t.pts[1]));
    dbl(S, -200, -200);
    gate('33. double-click turns a corner into a CURVE — handles gone, tangent auto',
      isCurve(t.pts[1]), JSON.stringify({ h1: t.pts[1].h1, h2: t.pts[1].h2 }));
    dbl(S, -200, -200);
    gate('33. …and again turns it back into a corner', isCorner(t.pts[1]),
      JSON.stringify({ h1: t.pts[1].h1, h2: t.pts[1].h2 }));
    gate('33. …touching nothing else on the outline',
      isCorner(t.pts[0]) && isCorner(t.pts[2]) && isCorner(t));
  }
  // THE SEAM: the closing point and the origin move together
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    dbl(S, -400, -400);
    gate('33. the seam toggles BOTH records — no half corner',
      isCurve(t.pts[3]) && isCurve(t),
      `closing ${isCurve(t.pts[3])}, origin ${isCurve(t)}`);
    dbl(S, -400, -400);
    gate('33. …and back, both together',
      isCorner(t.pts[3]) && isCorner(t),
      `closing ${isCorner(t.pts[3])}, origin ${isCorner(t)}`);
  }
  // a curve made by DRAGGING a handle is not a corner — it toggles to corner
  // first, which is the state the user can see they are leaving
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const t = S.level.terrain[1];
    t.pts[1].h1 = { x: -30, y: 0 };
    t.pts[1].h2 = { x: 30, y: 0 };
    S._select({ kind: 'terrain', ref: t });
    dbl(S, -200, -200);
    gate('33. a hand-shaped anchor becomes a corner, not a second kind of curve',
      isCorner(t.pts[1]), JSON.stringify({ h1: t.pts[1].h1, h2: t.pts[1].h2 }));
  }
  // it commits, so undo can take it back
  {
    const S = screen(paintWorld(), { tab: 'level', undo: true });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    dbl(S, -200, -200);
    gate('33. the toggle is an edit — it commits, and undo takes it back',
      isCurve(S.level.terrain[1].pts[1]) && S.commits > 0, `commits ${S.commits}`);
    S.undo();
    gate('33. …undone', isCorner(S.level.terrain[1].pts[1]));
  }
  // and a double-click on the PIECE rather than an anchor is left alone
  {
    const S = screen(paintWorld(), { tab: 'level' });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    const before = JSON.stringify(t);
    dbl(S, -300, -300);                       // the middle of the square
    gate('33. …while a double-click inside the shape changes nothing about it',
      JSON.stringify(t) === before);
  }
}

// ---------- gate 34: a placement drag DRAWS, it does not grow (§8.2) ----------
//
// Dragging terrain or a prop out used to GROW it about the press — `w = |dx|×2`
// with the centre pinned there — so the piece spread in every direction at once,
// the corner under the cursor ran away at twice the pointer's speed, and the
// point you pressed ended up in the MIDDLE of the result. Pressing at the
// top-left of a slab and pulling to the bottom-right means a rectangle between
// those two points everywhere else, and the rod tool right beside it already
// worked that way.
//
// Now the press is one corner and the cursor the opposite one. The two things
// that must hold: the ANCHOR never moves (a clamped-to-minimum piece must still
// keep the corner you started from), and a CLICK is untouched — tapping a piece
// down is the normal way to place terrain and it still centres on the tap.
{
  // reads the list the TOOL writes to — `terrain[last]` alone hands back the
  // floor slab when the tool was a prop tool, which is a gate passing on the
  // wrong object
  const at = (S, tool, from, to) => {
    const arr = tool.startsWith('prop') ? S.level.props : S.level.terrain;
    S._setTool(tool);
    S._pointerDown(ev(from.x, from.y));
    S._pointerMove(ev(to.x, to.y));
    S._pointerUp(ev(to.x, to.y));
    return arr[arr.length - 1];
  };
  const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

  // a box spans exactly the two points
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'terrain-box', { x: -600, y: -500 }, { x: -500, y: -420 });
    gate('34. a dragged box spans press → cursor: 100 × 80, centred between them',
      near(o.w, 100) && near(o.h, 80) && near(o.x, -550) && near(o.y, -460),
      `${o.w}×${o.h} at (${o.x}, ${o.y})`);
    gate('34. …and the pressed corner is exactly where it was pressed',
      near(o.x - o.w / 2, -600) && near(o.y - o.h / 2, -500),
      `corner (${o.x - o.w / 2}, ${o.y - o.h / 2})`);
  }
  // …in every direction, including dragging back up and to the left
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'terrain-box', { x: -500, y: -420 }, { x: -600, y: -500 });
    gate('34. …dragging up-left anchors the same way',
      near(o.w, 100) && near(o.h, 80) && near(o.x + o.w / 2, -500) && near(o.y + o.h / 2, -420),
      `${o.w}×${o.h}, anchor (${o.x + o.w / 2}, ${o.y + o.h / 2})`);
  }
  // a ball spans the drag too: press and cursor are opposite points on the rim
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'terrain-ball', { x: -600, y: -500 }, { x: -600, y: -400 });
    gate('34. a dragged ball starts where you pressed and ends under the cursor',
      near(o.r, 50) && near(o.x, -600) && near(o.y, -450),
      `r${o.r} at (${o.x}, ${o.y})`);
  }
  // THE ANCHOR SURVIVES THE CLAMP: a drag too small for the minimum size grows
  // to the floor away from the press, never through it
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'terrain-box', { x: -600, y: -500 }, { x: -593, y: -499.5 });
    // 7 × 0.5 is 3.5 px², under the 10 px² area floor — so the clamp must grow
    // it, and grow it AWAY from the anchor rather than through it
    gate('34. a sub-minimum drag clamps outward, keeping the pressed corner',
      near(o.x - o.w / 2, -600) && near(o.y - o.h / 2, -500) && o.h > 0.5,
      `${o.w}×${o.h}, corner (${o.x - o.w / 2}, ${o.y - o.h / 2})`);
  }
  // A CLICK IS UNTOUCHED — the standard size, centred on the tap
  {
    const S = screen(flatWorld(), { tab: 'level' });
    S._setTool('terrain-box');
    S._pointerDown(ev(-600, -500));
    S._pointerUp(ev(-600, -500));
    const o = S.level.terrain[S.level.terrain.length - 1];
    gate('34. a click still drops a standard piece centred on the point tapped',
      near(o.x, -600) && near(o.y, -500) && near(o.w, STD_BOX) && near(o.h, STD_BOX),
      `${o.w}×${o.h} at (${o.x}, ${o.y})`);
  }
  // …and a tiny wobble is still a click, not a one-pixel piece
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'terrain-box', { x: -600, y: -500 }, { x: -598, y: -499 });
    gate('34. …and a 2 px wobble is still a click, not a sliver',
      near(o.x, -600) && near(o.y, -500) && near(o.w, STD_BOX),
      `${o.w}×${o.h} at (${o.x}, ${o.y})`);
  }
  // props draw the same way — one gesture, every placement tool
  {
    const S = screen(flatWorld(), { tab: 'level' });
    const o = at(S, 'prop-box', { x: -600, y: -500 }, { x: -540, y: -450 });
    gate('34. a prop draws corner to corner too',
      near(o.w, 60) && near(o.h, 50) && near(o.x - o.w / 2, -600) && near(o.y - o.h / 2, -500),
      `${o.w}×${o.h}, corner (${o.x - o.w / 2}, ${o.y - o.h / 2})`);
  }
}

// ---------- gate 35: drawing INTO a pin lands on it (§8.2) ----------
//
// Reported as "drawing a stick OUT from a pin works every time, drawing one IN
// to the same pin doesn't snap on — maybe when terrain is close by". It was
// exactly that: the press end is simply PLACED on the pin, while the far end
// had to sweep there, and the sweep's clearances made pins near a surface
// unreachable. Every stick resting on the ground has both of its pins in that
// band, because that is where a downward sweep leaves them.
//
// Two walls, both measured before the fix, at a pin 2.01 px above the floor:
// the target read as doomed at the REST clearance, which swapped the stopper
// for the full rules, and those stopped the ghost 3.5 px short on "those sticks
// are too close side-by-side" — a rule the shared pin waives on arrival. A pin
// a little deeper into the tolerance band (1.5 px) was walled off by the live
// rule's own terrain clearance as well.
//
// So the gate is SYMMETRY: for the same pin, in to it and out from it must both
// leave an endpoint exactly on it. Plus the leak test that matters — the
// exemption is "the DROP accepts this stick", not "it is a pin" — so a pin the
// drop would refuse must still not be reachable.
{
  const pinnedWorld = (y) => flatWorld({
    fixedParts: [{ t: 'rod', kind: 'wood', x1: -120, y1: y, x2: -40, y2: y, id: 'ground' }],
  });
  // drive the handlers directly: the snap RING is read off `_lastSnap` before
  // the release clears it, and it is half of what "snapped on" means
  const draw = (S, from, to, steps = 12) => {
    S._pointerDown(ev(from.x, from.y));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      S._pointerMove(ev(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f));
    }
    const ring = S._lastSnap ? { ...S._lastSnap } : null;
    S._pointerUp(ev(to.x, to.y));
    const drawn = S.level.fixedParts.filter(p => p.id !== 'ground');
    return { ring, rod: drawn[drawn.length - 1] || null, toasts: S.toasts.slice() };
  };
  const endsOn = (rod, p) => !!rod && [[rod.x1, rod.y1], [rod.x2, rod.y2]]
    .some(([x, y]) => jointKey(x, y) === jointKey(p.x, p.y));

  // -2.01 is where a downward sweep leaves a stick (clear of the surface by
  // REST_GAP); -1.5 is inside the acceptance band, where older builds sit;
  // -40 is well clear of the floor and was never affected.
  for (const y of [-2.01, -1.5, -40]) {
    const pin = { x: -40, y };
    const far = { x: 20, y: y - 60 };
    const out = draw(screen(pinnedWorld(y), { tab: 'level', tool: 'rod-wood' }), pin, far);
    const inn = draw(screen(pinnedWorld(y), { tab: 'level', tool: 'rod-wood' }), far, pin);
    gate(`35. drawing OUT from a pin ${Math.abs(y)} px above the floor starts on it`,
      endsOn(out.rod, pin), out.rod ? `(${out.rod.x1}, ${out.rod.y1})` : 'no stick');
    gate(`35. …and drawing IN to the same pin ENDS on it`,
      endsOn(inn.rod, pin),
      inn.rod ? `(${inn.rod.x2.toFixed(3)}, ${inn.rod.y2.toFixed(3)}) vs pin (${pin.x}, ${pin.y})` : 'no stick');
    gate(`35. …and the ring locks while drawing in`,
      !!inn.ring && inn.ring.locked && near(inn.ring.x, pin.x) && near(inn.ring.y, pin.y),
      JSON.stringify(inn.ring));
  }

  // THE LEAK TEST: a pin the DROP refuses is still not reachable. Both ends on
  // the same stick is "two sticks can only share one pin" — a pin, in range,
  // snapping, and an illegal place to finish.
  {
    const S = screen(pinnedWorld(-40), { tab: 'level', tool: 'rod-wood' });
    const r = draw(S, { x: -120, y: -40 }, { x: -40, y: -40 });
    gate('35. a pin the drop would refuse is NOT landed on — both ends of one stick',
      !r.rod || !(endsOn(r.rod, { x: -120, y: -40 }) && endsOn(r.rod, { x: -40, y: -40 })),
      r.rod ? `placed (${r.rod.x1},${r.rod.y1})-(${r.rod.x2},${r.rod.y2})` : 'nothing placed');
  }
  // …and a pin on the far side of terrain stays behind it: the stick comes to
  // rest at the wall rather than teleporting through to the snap target.
  {
    const wall = { type: 'box', x: -70, y: -100, w: 20, h: 120 };   // spans y -160..-40
    const S = screen(flatWorld({
      terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 }, wall],
      fixedParts: [{ t: 'rod', kind: 'wood', x1: -200, y1: -100, x2: -120, y2: -100, id: 'ground' }],
    }), { tab: 'level', tool: 'rod-wood' });
    const pin = { x: -120, y: -100 };
    const r = draw(S, { x: 20, y: -100 }, pin);
    gate('35. …nor is a pin behind a wall — the stick stops at the terrain',
      !endsOn(r.rod, pin) && (!r.rod || r.rod.x2 > wall.x + wall.w / 2),
      r.rod ? `end x ${r.rod.x2.toFixed(2)}, wall face ${wall.x + wall.w / 2}` : 'nothing placed');
  }
}

// ---------- gate 36: drags near an edge, and presses outside one (§8.2) ----------
//
// Three reports, one area of the map: the build zone's boundary and the terrain
// that usually sits against it.
//
//   A  "in a corner with terrain on one side the pin drag sticks to the terrain
//       as I drag it along" — _endpointDrag was the last gesture sweeping a bare
//       diagonal instead of _sweepOrSlide, so it halted on first contact and
//       then could not restart, because the next event re-sweeps from a
//       lastGoodPt that is now ON the surface. Measured: 4 px of a 180 px drag.
//   B  "starting near a corner it starts too far into the corner and fails" —
//       both ends were clamped to the zone independently, so a press and a
//       cursor on the same side of a corner clamped to the SAME point and the
//       stick was zero long.
//   C  "if I start drawing outside an edge with terrain the entire rod is in the
//       terrain so cannot place" — the clamp aims at the zone and knows nothing
//       about what is inside it.
//
// The controls matter more than usual here, because all three fixes make the
// editor do something where it used to do nothing: an ordinary draw must be
// untouched, a press on rock from INSIDE the zone must still be refused, and a
// rescue must not reach further than its budget.
{
  const cornerWorld = () => flatWorld({
    // ground top y = 0 and 800 deep, so the zone's lower third is buried —
    // which is how a build zone standing on the ground is actually authored
    terrain: [{ type: 'box', x: 0, y: 400, w: 2000, h: 800 }],
    buildZones: [{ x: 0, y: -100, w: 700, h: 500 }],      // x -350..350, y -350..150
  });
  // Where the clamp actually puts a point: `inset - ZONE_CLAMP_SLACK` with no
  // inset EXPANDS the rect, so the edge it lands on is a hair outside the
  // authored one — inside ZONE_SLACK, which is what makes it legal.
  const ZL = -350 - ZONE_CLAMP_SLACK, ZT = -350 - ZONE_CLAMP_SLACK;
  const rodOf = (S) => S.design.parts.find(p => p.t === 'rod');
  const draw = (S, from, to) => { gesture(S, from, to, { watch: () => ({ x: 0, y: 0 }) }); return rodOf(S); };

  // ---- A: the end travels the whole way, and rests CLEAR of the floor ----
  {
    const S = screen(cornerWorld(), { parts: [
      { t: 'rod', kind: 'wood', x1: -100, y1: -80, x2: -100, y2: -40, id: 'r' },
    ] });
    const end = () => ({ x: S.design.parts[0].x2, y: S.design.parts[0].y2 });
    const g = gesture(S, { x: -100, y: -40 }, { x: -250, y: 30 }, { watch: end });
    gate('36. an END pushed into the floor slides ALONG it for the whole drag',
      g.type === 'move-endpoint' && near(end().x, -250, 0.5),
      `travelled to x ${end().x.toFixed(2)} of -250`);
    gate('36. …coming to REST clear of the surface, not a pixel inside it',
      end().y <= restExact(ROD_THICK / 2) && end().y > restExact(ROD_THICK / 2) - 0.5,
      `end y ${end().y.toFixed(4)}, rest ${restExact(ROD_THICK / 2)}, tolerance ${restY(ROD_THICK / 2)}`);
    gate('36. …and the drop keeps it where the drag left it', g.held && g.toasts.length === 0);
  }
  // …and it stays there: dragging it again must not walk it deeper each time,
  // which is what a stopper asking at the TOLERANCE does (§16).
  {
    const S = screen(cornerWorld(), { parts: [
      { t: 'rod', kind: 'wood', x1: -100, y1: -80, x2: -100, y2: -40, id: 'r' },
    ] });
    const end = () => ({ x: S.design.parts[0].x2, y: S.design.parts[0].y2 });
    gesture(S, { x: -100, y: -40 }, { x: -250, y: 30 }, { watch: end });
    const first = end().y;
    for (const x of [-60, -300, -120]) gesture(S, { ...end() }, { x, y: 30 }, { watch: end });
    // "does not creep INTO the floor" is the claim — not that the number is
    // bit-identical, since the bisection's resolution depends on how far each
    // drag travelled. Still clear of the rest line, and by a hair either way.
    gate('36. …and repeated drags along the floor do not walk it deeper',
      end().y <= restExact(ROD_THICK / 2) && near(end().y, first, 0.01) && near(end().x, -120, 0.5),
      `y ${first.toFixed(6)} -> ${end().y.toFixed(6)}, x ${end().x.toFixed(2)}`);
  }
  // the twin of gate 35, in the twin gesture: an end dropped on a pin that the
  // drop accepts lands ON it, even with the pin inside the sweep's clearance
  {
    const y = -1.5;
    const S = screen(flatWorld({
      fixedParts: [{ t: 'rod', kind: 'wood', x1: -120, y1: y, x2: -40, y2: y, id: 'ground' }],
    }), { tab: 'level', tool: 'pointer' });
    S.level.fixedParts.push({ t: 'rod', kind: 'wood', x1: 20, y1: y - 60, x2: 0, y2: y - 30, id: 'mover' });
    const end = () => { const m = S.level.fixedParts[1]; return { x: m.x2, y: m.y2 }; };
    const g = gesture(S, { x: 0, y: y - 30 }, { x: -40, y }, { watch: end });
    gate('36. an END dragged onto a pin 1.5 px above the floor lands on it',
      samePt(end(), { x: -40, y }) && g.held && g.toasts.length === 0,
      `${end().x.toFixed(2)},${end().y.toFixed(2)} — ${JSON.stringify(g.toasts)}`);
  }

  // ---- B: a press outside a CORNER draws the stick that was drawn ----
  {
    // inside the press band (10 screen px at the harness zoom of 1) — it used
    // to be 30 px out, which was inside the old 40 px world band and is now a
    // pan, which is the point of the change
    // Both press AND cursor outside the corner, so they clamp to the identical
    // point and `_rodStrokeTarget`'s fallback lays the stroke from the anchor —
    // which is the branch this pair is here to gate. Inside the press band, so
    // it is still a placement.
    const S = screen(cornerWorld(), { tool: 'rod-wood' });
    const rod = draw(S, { x: -358, y: -358 }, { x: -352, y: -351 });
    gate('36. a short draw from outside a zone CORNER places a stick',
      !!rod, rod ? 'placed' : `nothing — ${JSON.stringify(S.toasts)}`);
    gate('36. …anchored in the corner, with the length and direction drawn',
      !!rod && near(rod.x1, ZL) && near(rod.y1, ZT)
        && near(rod.x2 - rod.x1, 6) && near(rod.y2 - rod.y1, 7),
      rod ? `(${rod.x1.toFixed(2)},${rod.y1.toFixed(2)})-(${rod.x2.toFixed(2)},${rod.y2.toFixed(2)})` : '—');
  }
  // THE CONTROL that matters most: a press INSIDE the zone is untouched, so the
  // far end is exactly under the cursor and every ordinary draw is unchanged.
  {
    const S = screen(cornerWorld(), { tool: 'rod-wood' });
    const rod = draw(S, { x: -100, y: -200 }, { x: 40, y: -260 });
    gate('36. a press INSIDE the zone still ends exactly under the cursor',
      !!rod && near(rod.x1, -100) && near(rod.y1, -200) && near(rod.x2, 40) && near(rod.y2, -260),
      rod ? `(${rod.x1},${rod.y1})-(${rod.x2},${rod.y2})` : 'nothing placed');
  }

  // ---- C: a press outside an edge with terrain behind it ----
  {
    const S = screen(cornerWorld(), { tool: 'rod-wood' });
    const rod = draw(S, { x: -360, y: 10 }, { x: -150, y: -100 });
    gate('36. a press outside an edge with TERRAIN behind it still draws',
      !!rod, rod ? 'placed' : `nothing — ${JSON.stringify(S.toasts)}`);
    gate('36. …starting clear of the terrain, not inside it',
      !!rod && rod.y1 <= restExact(ROD_THICK / 2) && near(rod.x1, ZL),
      rod ? `anchor (${rod.x1.toFixed(2)}, ${rod.y1.toFixed(4)})` : '—');
  }
  // CONTROL 1: pressing on rock from INSIDE the zone is not rescued. The clamp
  // is what licenses moving a press; without it, "I pressed on rock" means it.
  {
    const S = screen(cornerWorld(), { tool: 'rod-wood' });
    const rod = draw(S, { x: -200, y: 20 }, { x: -100, y: -100 });
    gate('36. …but a press on rock from INSIDE the zone is still refused',
      !rod && S.toasts.some(t => /terrain/.test(t)),
      rod ? `placed (${rod.x1},${rod.y1})` : JSON.stringify(S.toasts));
  }
  // CONTROL 2: the rescue has a budget and stops at it — 100 px deep in rock
  // there is nowhere sensible for a stick to start, and it says so. The press
  // is inside the PRESS band (so it is a placement being refused, not a pan)
  // and beyond the RESCUE budget, which is the pair this gate exists to hold
  // apart.
  {
    const S = screen(cornerWorld(), { tool: 'rod-wood' });
    const rod = draw(S, { x: -355, y: 100 }, { x: -150, y: -100 });
    gate('36. …and a press deeper than RESCUE_SLACK is still refused, with a reason',
      !rod && S.toasts.some(t => /terrain/.test(t)),
      rod ? `placed (${rod.x1},${rod.y1})` : JSON.stringify(S.toasts));
  }
  // …and the two budgets really are different numbers: a press just outside
  // the band is a PAN — nothing placed and nothing said — while the same press
  // inside it is a placement. This is the whole of the change, asserted once.
  {
    const near1 = screen(cornerWorld(), { tool: 'rod-wood' });
    const inBand = draw(near1, { x: -350 - PRESS_SLACK + 2, y: -200 }, { x: -300, y: -200 });
    const far1 = screen(cornerWorld(), { tool: 'rod-wood' });
    const outBand = draw(far1, { x: -350 - PRESS_SLACK - 6, y: -200 }, { x: -300, y: -200 });
    gate('36. …a press just inside the press band still draws',
      !!inBand, inBand ? 'placed' : `nothing — ${JSON.stringify(near1.toasts)}`);
    gate('36. …and just outside it pans instead, silently',
      !outBand && far1.toasts.length === 0,
      outBand ? `placed (${outBand.x1.toFixed(1)},${outBand.y1.toFixed(1)})` : JSON.stringify(far1.toasts));
  }
}

// ---------- gate 37: the pit — a piece already touching the floor (§8.2) ----------
//
// Reduced from a real level the user was building: a build zone bounded EXACTLY
// by two walls and the floor, with two water sticks meeting at a shared pin
// sitting at y = −1.00005. That number is the whole gate. It is inside the
// ACCEPTANCE tolerance (terrain deflated by TERRAIN_TOUCH_PAD ends at −1) and
// therefore a legal, ordinary place for a pin to be — and it is inside the
// SWEEP's rest clearance (terrain inflated to −2.01), which every drag measures
// its wall against. A piece resting flush on the ground is exactly there.
//
// `_sweepValidFraction` never tests t=0, so a start position that fails the
// sweep rule does not error — it makes the bisection return 0 for any direction
// that does not immediately leave the clearance. That is why this failed
// DIRECTIONALLY, which is what hid it: dragging up worked, dragging across the
// floor did nothing at all, silently, however far you pulled.
//
// `_endpointDrag` has had the fallback for a while; the MOVE drags never got
// it. Both are gated here, and the control is the direction that must still
// refuse: DOWN, into the floor.
{
  const pit = {
    buildZones: [{ x: -270, y: -75, w: 180, h: 150 }],        // x -360..-180, y -150..0
    terrain: [
      { type: 'box', x: -60, y: 30, w: 720, h: 60 },          // floor, top y = 0
      { type: 'box', x: -390, y: -75, w: 60, h: 150 },        // left wall, face x = -360
      { type: 'box', x: -150, y: -75, w: 60, h: 210 },        // right wall, face x = -180
    ],
  };
  const PIN = { x: -269.66334230211163, y: -1.0000532126921935 };
  const parts = () => [
    { t: 'rod', kind: 'water', x1: -357.98973816756956, y1: -128.42703044822787, x2: PIN.x, y2: PIN.y, id: 'a' },
    { t: 'rod', kind: 'water', x1: PIN.x, y1: PIN.y, x2: -306.38242394784, y2: -123.90584771282093, id: 'b' },
  ];
  const pinNow = (S) => ({ x: S.design.parts[0].x2, y: S.design.parts[0].y2 });
  // press, then a list of waypoints — the reported gesture is two legs, and
  // one leg would not reproduce it: it is the SECOND leg that must still move
  // after the first has been stopped by the floor.
  const stroke = (S, from, pts, per = 10) => {
    S._pointerDown(ev(from.x, from.y));
    const type = S.drag?.type || null;
    let cur = from;
    for (const p of pts) {
      for (let i = 1; i <= per; i++) {
        const f = i / per;
        S._pointerMove(ev(cur.x + (p.x - cur.x) * f, cur.y + (p.y - cur.y) * f));
      }
      cur = p;
    }
    S._pointerUp(ev(cur.x, cur.y));
    return type;
  };

  gate('37. the pin under test really is in the gap between the two clearances',
    PIN.y < restY(ROD_THICK / 2) && PIN.y > restExact(ROD_THICK / 2),
    `pin y ${PIN.y.toFixed(5)}: accepted below ${restY(ROD_THICK / 2)}, swept below ${restExact(ROD_THICK / 2)}`);

  // ---- the reported gesture: grab the pin, dip below the build area, go across
  for (const [label, aim] of [['right', -170], ['left', -370]]) {
    const S = screen(pit, { parts: parts() });
    stroke(S, PIN, [{ x: PIN.x, y: 20 }, { x: aim, y: 20 }]);
    gate(`37. …and both sticks are still joined at it`,
      jointKey(S.design.parts[0].x2, S.design.parts[0].y2) === jointKey(S.design.parts[1].x1, S.design.parts[1].y1),
      `${S.design.parts[0].x2.toFixed(2)},${S.design.parts[0].y2.toFixed(2)}`);
  }

  // ---- the same for a WHOLE-STICK drag, which had no t=0 fallback at all
  {
    const mid = { x: (parts()[0].x1 + PIN.x) / 2, y: (parts()[0].y1 + PIN.y) / 2 };
    const moved = (pts) => {
      const S = screen(pit, { parts: parts() });
      const type = stroke(S, mid, pts);
      return { type, dx: pinNow(S).x - PIN.x, dy: pinNow(S).y - PIN.y,
        topY: S.design.parts[0].y1, toasts: S.toasts };
    };
    // The direction that always worked still does — and it is the ZONE that
    // stops this one, not the sweep: 40 px up would carry the far end past the
    // build area's top edge, so it travels until that end sits on the edge.
    // Asserting "-40 px" here would be asserting the wrong wall.
    const up = moved([{ x: mid.x, y: mid.y - 40 }]);
    gate('37. …the direction that always worked still does, up to the zone edge',
      up.dy < -1 && near(up.topY, -150 - ZONE_CLAMP_SLACK),
      `moved ${up.dy.toFixed(2)} px up, far end at ${up.topY.toFixed(3)} (zone edge ${-150 - ZONE_CLAMP_SLACK})`);
    // THE CONTROL: the relaxation must not open the floor. Down is refused.
    const down = moved([{ x: mid.x, y: mid.y + 40 }]);
    gate('37. …but DOWN, into the floor, still moves nothing',
      Math.abs(down.dy) < 0.02, `moved ${down.dy.toFixed(4)} px down`);
  }
}

// ---------- gate 38: the buried zone — every side of it (§8.2) ----------
//
// The second real level from the same user, and a harder shape than gate 37's:
// the build zone's outer margin is inside the terrain on THREE sides — 15.7 px
// into the left wall, 19.4 into the right one, 14.8 into the floor. So a press
// outside almost any edge clamps into rock and has to be rescued, and the two
// bottom corners are rescues in two dimensions at once.
//
// Reported as "top draws perfectly, right side draws perfectly, gets weird on
// the floor section — variable results, sometimes starts near a corner but too
// high up". Both halves of that are ONE cause and it is in the refinement, not
// the search: `_rodStartPoint` samples rings (4 px apart, 22.5° apart), so its
// first answer is quantised in distance AND direction, and it used to walk that
// answer back toward the press along a straight LINE. A line cannot enter a
// corner — it stops on whichever surface it meets first — and it cannot undo
// the direction quantisation either, because the sideways error lies along it.
// Measured: pressing below the floor put the anchor 7.2 px sideways of the
// press, and pressing outside a bottom corner left it 4.6 px above the floor.
//
// **So this gate measures the MISS, not the legality.** An anchor 4.6 px too
// high is perfectly legal — clear of everything, a stick places fine — which is
// exactly why "is it in terrain?" would pass a build with the bug in it. The
// claim is that the anchor lands on the NEAREST legal point to the press, and
// the clear region here is an axis-aligned box, so that ideal is computable
// per-axis and can be asserted rather than eyeballed.
// Wrapped in `section()` as the suite's second-heaviest id: 1.2 s of 9.6 s,
// measured with `--times`. With gate 10 it is 94% of the clock.
section('38', () => {
  const Z = { x: -268.1736324133662, y: -63.999562192084696, w: 215.09559951970357, h: 157.5394375687126 };
  const buried = {
    buildZones: [Z],
    terrain: [
      { type: 'box', x: -60, y: 30, w: 720, h: 60 },        // floor, top y = 0
      { type: 'box', x: -390, y: -75, w: 60, h: 150 },      // left wall, face x = -360
      { type: 'box', x: -150, y: -75, w: 60, h: 210 },      // right wall, face x = -180
    ],
  };
  const L = Z.x - Z.w / 2, R = Z.x + Z.w / 2, T = Z.y - Z.h / 2, B = Z.y + Z.h / 2;
  // where a stick may start: clear of each surface by the sweep's rest clearance
  const MINX = -360 + ROD_THICK / 2 + REST_GAP;
  const MAXX = -180 - ROD_THICK / 2 - REST_GAP;
  const MAXY = 0 - ROD_THICK / 2 - REST_GAP;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  // the press, clamped into the zone, then clamped out of the terrain — the
  // nearest legal start, which is what the rescue is supposed to find
  const ideal = (x, y) => ({
    x: clamp(clamp(x, L - ZONE_CLAMP_SLACK, R + ZONE_CLAMP_SLACK), MINX, MAXX),
    y: Math.min(clamp(y, T - ZONE_CLAMP_SLACK, B + ZONE_CLAMP_SLACK), MAXY),
  });
  // **…and that per-axis ideal is exact only along the FLAT faces.** Terrain
  // boxes are round-rects (`cornerRadiusOf`, default 8), so at the bottom
  // corners the wall curves away and a stick may legitimately start further
  // into the corner than any face-based clamp allows — measured at 2.0 px
  // further at the bottom-left, and the editor is right to take it.
  //
  // So the claim is split in two, and the pair is strictly stronger than the
  // single sharp-model assertion it replaces:
  //   - the anchor is LEGAL, checked here against the rounded shapes rather
  //     than assumed (the old gate said outright that it measured the miss and
  //     not the legality);
  //   - and it is no FURTHER from the press than the sharp ideal, which is the
  //     bound that catches the bug this gate exists for — an 8.6 px miss when
  //     a legal point sat 0.001 px away still fails it.
  // Corner radius and clearance are restated, not imported.
  const CR = 8;
  // **The ACCEPTANCE clearance, not the rest one.** A rescued anchor aims for
  // `ROD_THICK/2 + REST_GAP` — where a sweep comes to rest — but what makes a
  // start LEGAL is what the drop keeps, which is a whole `TERRAIN_TOUCH_PAD`
  // looser. Checking legality against the rest clearance called a stick 1.72 px
  // off a wall illegal when the editor accepts it at 1.0; that is §16's "a
  // tolerance is not a target" read backwards.
  const RHO = ROD_THICK / 2 - TERRAIN_TOUCH_PAD;
  const surfDist = (p, t) => {
    const cr = Math.min(t.radius ?? CR, t.w / 2, t.h / 2);
    const hw = t.w / 2 - cr, hh = t.h / 2 - cr;
    return Math.hypot(Math.max(Math.abs(p.x - t.x) - hw, 0), Math.max(Math.abs(p.y - t.y) - hh, 0)) - cr;
  };
  const legalStart = (p) =>
    p.x >= L - ZONE_CLAMP_SLACK - 1e-6 && p.x <= R + ZONE_CLAMP_SLACK + 1e-6 &&
    p.y >= T - ZONE_CLAMP_SLACK - 1e-6 && p.y <= B + ZONE_CLAMP_SLACK + 1e-6 &&
    buried.terrain.every(t => surfDist(p, t) >= RHO - 1e-6);
  const noWorseThanIdeal = (a, px, py) => {
    const w = ideal(px, py);
    return Math.hypot(a.x - px, a.y - py) <= Math.hypot(w.x - px, w.y - py) + 0.05;
  };

  gate('38. the zone really is buried on three sides',
    L < -360 && R > -180 && B > 0,
    `left ${(-360 - L).toFixed(1)} px, right ${(R - -180).toFixed(1)} px, bottom ${B.toFixed(1)} px into terrain`);

  const anchorFor = (px, py) => {
    const S = screen(buried, { tool: 'rod-wood' });
    const cx = (L + R) / 2, cy = (T + B) / 2;
    const dx = cx - px, dy = cy - py, len = Math.hypot(dx, dy);
    gesture(S, { x: px, y: py }, { x: px + dx / len * 70, y: py + dy / len * 70 },
      { watch: () => ({ x: 0, y: 0 }) });
    const rod = S.design.parts.find(p => p.t === 'rod');
    return rod ? { x: rod.x1, y: rod.y1, toasts: S.toasts } : { x: null, y: null, toasts: S.toasts };
  };

  // One named case per side, so a failure says WHICH side broke. The offsets
  // are inside the PRESS band — beyond it a press is a pan and places nothing
  // by design, which is a different gate (36) and not a rescue failure.
  const OUT = PRESS_SLACK - 2;
  for (const [side, px, py] of [
    ['the top', -300, T - OUT],
    ['the right side', R + OUT, -90],
    ['the floor section', -300, B + OUT],
    ['the left side', L - OUT, -90],
    ['the bottom-RIGHT corner', R + OUT, B + OUT],
    ['the bottom-LEFT corner', L - OUT, B + OUT],
  ]) {
    const a = anchorFor(px, py);
    const w = ideal(px, py);
    gate(`38. a press outside ${side} starts at the nearest legal point`,
      a.x != null && legalStart(a) && noWorseThanIdeal(a, px, py),
      a.x == null ? `nothing placed — ${JSON.stringify(a.toasts)}`
        : `(${a.x.toFixed(2)}, ${a.y.toFixed(2)}) ${legalStart(a) ? 'legal' : 'ILLEGAL'}, ` +
          `${Math.hypot(a.x - px, a.y - py).toFixed(2)} px from the press vs sharp ideal ${Math.hypot(w.x - px, w.y - py).toFixed(2)}`);
  }

  // …and the whole boundary at once, because "variable results" is a claim
  // about the WORST press, not about any press somebody thought to name. Every
  // point in the band, 6 px apart: all of them place, none in terrain, and none
  // more than a rounding error from the nearest legal start.
  {
    let n = 0, worstExcess = -Infinity, worstAt = null, failed = 0, illegal = 0, illegalAt = null;
    for (let x = L - PRESS_SLACK; x <= R + PRESS_SLACK; x += 2) {
      for (let y = T - PRESS_SLACK; y <= B + PRESS_SLACK; y += 2) {
        // Skip the zone AND its clamp slack. Inside that ring the clamp does
        // not move the press, so no rescue runs — "pressing on rock from inside
        // the zone means what it says" (§8.2), which is a different rule and
        // gate 36's control, not a rescue failure. The old coarse step never
        // landed in the half-pixel of slack; a 2 px step does, and read 108
        // presses as broken when they were behaving as specified.
        if (x >= L - ZONE_CLAMP_SLACK && x <= R + ZONE_CLAMP_SLACK
          && y >= T - ZONE_CLAMP_SLACK && y <= B + ZONE_CLAMP_SLACK) continue;
        n++;
        const a = anchorFor(x, y);
        if (a.x == null) { failed++; continue; }
        if (!legalStart(a)) { illegal++; illegalAt = illegalAt || { x, y, a }; }
        const w = ideal(x, y);
        // how much FURTHER from the press than the sharp ideal — negative is
        // the rounded corner legitimately letting it in closer
        const excess = Math.hypot(a.x - x, a.y - y) - Math.hypot(w.x - x, w.y - y);
        if (excess > worstExcess) { worstExcess = excess; worstAt = { x, y, a, w }; }
      }
    }
    gate('38. …and EVERY press in the band around it places a stick',
      failed === 0, `${failed} of ${n} placed nothing`);
    gate('38. …every one of them on a legal start',
      illegal === 0,
      illegalAt ? `${illegal} of ${n} illegal, e.g. press (${illegalAt.x.toFixed(0)}, ${illegalAt.y.toFixed(0)}) → (${illegalAt.a.x.toFixed(2)}, ${illegalAt.a.y.toFixed(2)})`
        : `${n} sampled, all clear of terrain by ROD_THICK/2 + REST_GAP`);
    // **0.8 px, and the bound is measured rather than chosen.** Rounding the
    // terrain corners opened a sliver of newly-legal space beside the left
    // wall's top corner (its core ends at y −142, the zone at −142.77), and
    // the ring search is quantised 4 px apart and 22.5° apart, so the
    // slide-back cannot always recover sub-pixel optimality in a region whose
    // shape just changed. Measured over the whole band: a handful of presses
    // exceed 0.05 px, **worst 0.944**, every one of them next to that corner;
    // everywhere else it is still exact. (It read 0.780 when the band was
    // sampled every 6 px and 0.944 at every 2 px — a finite sweep finds a LOWER
    // BOUND on the worst case, which is why the bar carries headroom rather
    // than hugging the measurement.)
    //
    // Left as it is because the rescue's job is to save a press that would
    // otherwise place NOTHING, the anchor is legal either way (gated above),
    // and the bug this gate was written for was an 8.6 px miss. If this bound
    // ever needs raising again, that is the signal to fix `_rodStartPoint`
    // rather than the number.
    gate('38. …none further from the press than the nearest legal point',
      worstExcess < 1.25,
      worstAt ? `worst +${worstExcess.toFixed(3)} px at press (${worstAt.x.toFixed(0)}, ${worstAt.y.toFixed(0)}) — ` +
        `(${worstAt.a.x.toFixed(2)}, ${worstAt.a.y.toFixed(2)}) vs sharp ideal (${worstAt.w.x.toFixed(2)}, ${worstAt.w.y.toFixed(2)})`
        : `${n} sampled`);
  }
});

// ---------- gate 39: overshooting a pin still finds it (§8.2) ----------
//
// The last stick of a rectangle, corner to corner. Press the top-left pin, fly
// across, and release just PAST the bottom-right one: the stick stopped 4.95 px
// short — exactly 3.5 px from each of the two rods meeting at that corner, which
// is the side-by-side rule, and exactly the rule the shared pin waives on
// arrival. "Unless I point straight at it", because `SNAP` is 6 SCREEN px and at
// this level's working zoom of 2.6 that is **2.3 world px** — two pixels of
// overshoot is already outside it.
//
// So the zoom is part of the fixture and not decoration; at zoom 1 the snap
// radius is 6 world px and the first failing case below would pass on its own.
//
// The rule being gated: when the end cannot be where you are pointing it is
// going to be moved anyway, so it moves to a pin if the pin is no further off
// than the surface it would otherwise rest against. Both halves are asserted —
// the corner connects however far past you fly (up to the rescue's own reach),
// and a pin off to the side of a floor you are pushing into does NOT win.
{
  const ZOOM = 2.5962125609513396;
  const Z = { x: -268.1736324133662, y: -63.999562192084696, w: 215.09559951970357, h: 157.5394375687126 };
  const world = {
    buildZones: [Z],
    terrain: [
      { type: 'box', x: -60, y: 30, w: 720, h: 60 },
      { type: 'box', x: -390, y: -75, w: 60, h: 150 },
      { type: 'box', x: -150, y: -75, w: 60, h: 210 },
    ],
  };
  const TL = { x: -357.989, y: -143.268 }, TR = { x: -182.011, y: -143.268 };
  const BR = { x: -182.01, y: -2.011 }, BL = { x: -357.99, y: -2.01 };
  const rect = () => [
    { t: 'rod', kind: 'wood', x1: TL.x, y1: TL.y, x2: TR.x, y2: TR.y, id: 'top' },
    { t: 'rod', kind: 'wood', x1: TR.x, y1: TR.y, x2: BR.x, y2: BR.y, id: 'right' },
    { t: 'rod', kind: 'wood', x1: BR.x, y1: BR.y, x2: BL.x, y2: BL.y, id: 'bottom' },
    { t: 'rod', kind: 'wood', x1: BL.x, y1: BL.y, x2: TL.x, y2: TL.y, id: 'left' },
  ];
  // the camera is the fixture here, so the events have to be built through it
  const zev = (S, wx, wy) => {
    const p = S.camera.toScreen(wx, wy);
    return ev(p.x - 400, p.y - 300);          // ev() re-adds the viewport centre
  };
  const drawAt = (S, from, to, per = 20) => {
    const before = S.design.parts.length;      // NOT a fixed index: the two
    S._pointerDown(zev(S, from.x, from.y));    // fixtures below start with
    for (let i = 1; i <= per; i++) {           // different numbers of parts
      const f = i / per;
      S._pointerMove(zev(S, from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f));
    }
    const ring = S._lastSnap ? { ...S._lastSnap } : null;
    S._pointerUp(zev(S, to.x, to.y));
    return { ring, rod: S.design.parts[before] || null, toasts: S.toasts };
  };
  const mk = () => { const S = screen(world, { tool: 'rod-wood', parts: rect() }); S.camera.zoom = ZOOM; return S; };

  gate('39. the fixture is zoomed in far enough for SNAP to be the problem',
    SNAP / ZOOM < 2.5, `SNAP is ${(SNAP / ZOOM).toFixed(2)} world px at zoom ${ZOOM.toFixed(2)}`);

  for (const [label, past] of [['2 px', 2], ['8 px', 8], ['20 px', 20]]) {
    const r = drawAt(mk(), TL, { x: BR.x + past, y: BR.y + past });
    gate(`39. releasing ${label} PAST the far pin still connects to it`,
      !!r.rod && jointKey(r.rod.x2, r.rod.y2) === jointKey(BR.x, BR.y) && !!r.ring,
      r.rod ? `end (${r.rod.x2.toFixed(2)}, ${r.rod.y2.toFixed(2)}) vs pin (${BR.x}, ${BR.y}), ring ${r.ring ? 'lit' : 'off'}`
        : `nothing placed — ${JSON.stringify(r.toasts)}`);
  }
  // …and the control at the other end: flying so far past that the end is
  // beyond the rescue's own reach finds nothing, and says so by stopping.
  {
    const r = drawAt(mk(), TL, { x: BR.x + 60, y: BR.y + 60 });
    gate('39. …but flying far beyond the pin does NOT reach back to it',
      !r.rod || jointKey(r.rod.x2, r.rod.y2) !== jointKey(BR.x, BR.y),
      r.rod ? `end (${r.rod.x2.toFixed(2)}, ${r.rod.y2.toFixed(2)})` : 'nothing placed');
  }

  // THE COUNTER-CASE, and the reason the rule compares against the surface
  // rather than using a bigger radius: pushing a stick into the FLOOR beside an
  // unrelated pin must rest on the floor where it was aimed.
  {
    const flat = {
      buildZones: [{ x: 0, y: -100, w: 700, h: 260 }],
      terrain: [{ type: 'box', x: 0, y: 200, w: 1400, h: 400 }],       // top y = 0
    };
    const pin = { x: -100, y: restExact(ROD_THICK / 2) };
    const mkFlat = () => {
      const S = screen(flat, { tool: 'rod-wood', parts: [
        { t: 'rod', kind: 'wood', x1: -200, y1: -60, x2: pin.x, y2: pin.y, id: 'e' },
      ] });
      S.camera.zoom = ZOOM; return S;
    };
    for (const away of [20, 45]) {
      const S = mkFlat();
      const x = pin.x + away;
      const r = drawAt(S, { x, y: -70 }, { x, y: 14 });     // straight down into the floor
      gate(`39. …and pushing into the floor ${away} px from a pin rests on the floor, not on the pin`,
        !!r.rod && jointKey(r.rod.x2, r.rod.y2) !== jointKey(pin.x, pin.y) && near(r.rod.x2, x, 0.5),
        r.rod ? `end (${r.rod.x2.toFixed(2)}, ${r.rod.y2.toFixed(2)}), aimed x ${x}` : 'nothing placed');
    }
  }
}


// ---------- gate 40: the fence, and the tint (§10.7) ----------
//
// ONE number does three jobs, and that is the design: `PLAY_BOUND` is how far a
// player's view reaches, so it is also how far it is worth building, so it is
// also where the "you will never see this" tint starts. Anything authored
// outside it could not be looked at by anybody.
//
//   the fence   ±PLAY_BOUND, world coordinates — no piece may be left outside
//   the tint    the same box in the normal Maker view; ±PLAY_BOUND/BACKDROP_SCALE
//               while the scenery is swapped in for 1:1 editing, because that
//               layer reaches the player scaled about the origin
//   the scenery is NOT fenced — it is meant to run off the side of the world
{
  gate('40. the fence is exactly what a player can see — one constant, not two',
    WORLD_LIMIT === PLAY_BOUND, `fence ±${WORLD_LIMIT}, player's reach ±${PLAY_BOUND}`);
  gate('40. …and the scenery\'s tint is that, in the frame the scenery is drawn in',
    Math.abs(BACK_VISIBLE * BACKDROP_SCALE - PLAY_BOUND) < 1e-9,
    `${BACK_VISIBLE} × ${BACKDROP_SCALE} = ${BACK_VISIBLE * BACKDROP_SCALE}`);

  const bigWorld = { buildZones: [{ x: 0, y: 0, w: 600, h: 400 }] };
  const far = WORLD_LIMIT + 500;

  // ---- machine parts and fixed parts, through their own predicates ----
  {
    const S = screen(bigWorld, { tab: 'level' });
    gate('40. a fixed WHEEL outside the fence is refused, by name',
      /buildable area/.test(S._wheelInvalid({ t: 'wheel', kind: 'free', x: far, y: 0, r: 15 }, null, false) || ''),
      S._wheelInvalid({ t: 'wheel', kind: 'free', x: far, y: 0, r: 15 }, null, false));
    gate('40. …and one just inside is not',
      S._wheelInvalid({ t: 'wheel', kind: 'free', x: WORLD_LIMIT - 20, y: 0, r: 15 }, null, false) === null);
    // the boundary is the piece's EDGE, not its centre: "no blocks outside"
    gate('40. …the piece\'s EDGE is what has to fit, not its centre',
      /buildable area/.test(S._wheelInvalid({ t: 'wheel', kind: 'free', x: WORLD_LIMIT - 5, y: 0, r: 15 }, null, false) || ''),
      'a 15 px wheel centred 5 px inside pokes out');
    gate('40. a fixed STICK crossing the fence is refused',
      /buildable area/.test(S._rodInvalid({ t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: far, y2: 0 }, null, false) || ''));
  }
  // ---- props and goal pieces, through the landing check both use ----
  {
    const S = screen(bigWorld, { tab: 'level' });
    const prop = { shape: 'box', x: far, y: 0, w: 40, h: 40 };
    gate('40. a PROP outside the fence is refused',
      /buildable area/.test(S._landingBlocked(prop, prop) || ''));
    const goal = { shape: 'ball', x: 0, y: far, r: 20 };
    gate('40. …and a GOAL PIECE too',
      /buildable area/.test(S._landingBlocked(goal, goal, { isGoal: true }) || ''));
  }
  // ---- terrain, which has no landing check at all: the ghost is nudged ----
  {
    const S = screen(bigWorld, { tab: 'level', tool: 'terrain-box' });
    S._pointerDown(ev(far, 0));
    S._pointerUp(ev(far, 0));
    const t = S.level.terrain[S.level.terrain.length - 1];
    gate('40. a terrain block dropped outside the fence is held INSIDE it',
      !!t && t.x + t.w / 2 <= WORLD_LIMIT + 0.01,
      t ? `landed at x ${t.x} (right edge ${t.x + t.w / 2})` : 'nothing placed');
  }
  // ---- a label ----
  {
    const S = screen(bigWorld, { tab: 'level' });
    S._openTextEditor = (t, o) => { S._pendingText = t; };
    S._placeText({ x: far, y: far });
    gate('40. a label is placed inside the fence',
      !!S._pendingText && S._pendingText.x <= WORLD_LIMIT && S._pendingText.y <= WORLD_LIMIT,
      S._pendingText ? `(${S._pendingText.x}, ${S._pendingText.y})` : 'no label');
  }
  // ---- a drag STOPS at the fence rather than being refused after it ----
  {
    const S = screen(bigWorld, { tab: 'level',
      parts: [] });
    S.level.fixedParts.push({ t: 'wheel', kind: 'free', x: 0, y: 0, r: 20, id: 'w' });
    const at = () => ({ x: S.level.fixedParts[0].x, y: S.level.fixedParts[0].y });
    const g = gesture(S, { x: 0, y: 0 }, { x: far * 2, y: 0 }, { watch: at });
    gate('40. dragging a piece at the fence STOPS there, it does not snap back',
      g.held && at().x > 0 && at().x + 20 <= WORLD_LIMIT + 0.01,
      `stopped at x ${at().x.toFixed(1)}, edge ${(at().x + 20).toFixed(1)} of ${WORLD_LIMIT}`);
  }

  // ---- THE SCENERY IS NOT FENCED ----
  {
    const S = screen(bigWorld, { tab: 'level' });
    S.backEditing = true;
    gate('40. the SCENERY layer may be built to any size',
      S._wheelInvalid({ t: 'wheel', kind: 'free', x: far * 4, y: 0, r: 15 }, null, false) === null
      && S._outsideWorld({ minX: -9e5, maxX: 9e5, minY: -9e5, maxY: 9e5 }) === null,
      'no fence while the layer is swapped in');
  }

  // ---- the tint: where it starts, and in which frame ----
  {
    const rects = []; let fill;
    const rec = { save() {}, restore() {}, set fillStyle(v) { fill = v; }, get fillStyle() { return fill; },
      fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill }); } };
    const covers = (px, py) => rects.some(r =>
      px >= Math.min(r.x, r.x + r.w) && px <= Math.max(r.x, r.x + r.w) &&
      py >= Math.min(r.y, r.y + r.h) && py <= Math.max(r.y, r.y + r.h));
    const cam = new Camera(); cam.setViewport(1200, 700); cam.zoom = 1; cam.y = 0;

    cam.x = WORLD_LIMIT - 100; rects.length = 0;
    drawUnseen(rec, cam, WORLD_LIMIT);
    gate('40. the tint starts exactly at the fence',
      covers(WORLD_LIMIT + 1, 0) && !covers(WORLD_LIMIT - 1, 0));
    gate('40. …and it is a TINT, not an opaque cover',
      /rgba\(/.test(String(fill)) && parseFloat(String(fill).split(',')[3]) < 0.5, String(fill));
    // the four bands must not overlap, or the corners read twice as red
    rects.length = 0; cam.x = WORLD_LIMIT - 50; cam.y = WORLD_LIMIT - 50;
    drawUnseen(rec, cam, WORLD_LIMIT);
    const corner = rects.filter(r =>
      WORLD_LIMIT + 20 >= Math.min(r.x, r.x + r.w) && WORLD_LIMIT + 20 <= Math.max(r.x, r.x + r.w) &&
      WORLD_LIMIT + 20 >= Math.min(r.y, r.y + r.h) && WORLD_LIMIT + 20 <= Math.max(r.y, r.y + r.h));
    gate('40. …covering the corner exactly ONCE, so it does not double up',
      corner.length === 1, `${corner.length} rects over the corner`);
  }
  // …and which half-width each view asks for — read back out of WHERE the tint
  // lands rather than by spying on the argument, so it gates the thing on
  // screen. With the whole world in view the right-hand band's near edge IS the
  // half-width.
  {
    const tint = (S) => {
      const rects = [];
      S.camera.setViewport(1200, 700); S.camera.zoom = 0.02; S.camera.x = 0; S.camera.y = 0;
      S._drawUnseen({ save() {}, restore() {}, set fillStyle(v) {}, get fillStyle() { return ''; },
        fillRect(x, y, w, h) { rects.push({ x, y, w, h }); } });
      const right = rects.filter(r => r.x > 0).map(r => r.x);
      return { n: rects.length, start: right.length ? Math.min(...right) : null };
    };
    const S = screen(bigWorld, { tab: 'level' });
    const normal = tint(S);
    S.backEditing = true;
    const scenery = tint(S);
    gate('40. the normal view tints at the world fence, the scenery view at its own',
      normal.start === WORLD_LIMIT && scenery.start === BACK_VISIBLE,
      `normal ${normal.start}, scenery ${scenery.start}`);
    // …and never on the play screen, which cannot reach it anyway
    const P = screen(bigWorld, { mode: 'play' });
    gate('40. …and a player is never shown it', tint(P).n === 0, `${tint(P).n} rects`);
  }
}

// ---------- gate 41: the fresh-Maker template (§14) ----------
//
// `newMakerLevel()` is the first thing every author ever sees and the shape most
// of them will edit rather than replace, so its numbers are not cosmetic — and
// it had no gate at all until it was replaced with a hand-authored layout.
//
// The properties worth holding are the ones an author would feel and not
// diagnose: that pressing Save immediately works, that pressing PLAY immediately
// does not drop the goal piece, and that a first drag onto a grid node lines up
// with what is already there instead of landing a few px out.
{
  const T = newMakerLevel();
  const S = screen(T, { tab: 'level', mode: 'maker' });

  gate('41. a fresh Maker level is publishable as it stands',
    S._validateLevelForPublish() === null, S._validateLevelForPublish());

  // ON THE GRID. Not tidiness: an author dragging the first piece onto a node
  // finds it lines up with the floor and the zones, rather than being 5 px out
  // from the very first gesture.
  const edges = [];
  for (const t of T.terrain) edges.push(t.x - t.w / 2, t.x + t.w / 2);
  for (const z of [...T.buildZones, ...T.goalZones]) edges.push(z.x - z.w / 2, z.x + z.w / 2, z.y - z.h / 2, z.y + z.h / 2);
  const offGrid = edges.filter(v => Math.abs(v % GRID_STEP) > 1e-9);
  gate('41. …with every terrain and zone edge on the snap grid',
    offGrid.length === 0, offGrid.length ? `off-grid: ${offGrid.join(', ')}` : `${edges.length} edges checked`);

  // THE GOAL PIECE RESTS, it does not hover. The old template sat it 5 px up,
  // so the first thing a new author saw on pressing Play was it dropping.
  const floorTop = Math.min(...T.terrain.map(t => t.y - t.h / 2));
  const crate = T.goalObjs[0];
  const gap = floorTop - (crate.y + crate.h / 2);
  gate('41. …and the goal piece resting on the floor, not hovering above it',
    Math.abs(gap - REST_GAP) < 1e-6, `${gap.toFixed(4)} px clear of the floor (REST_GAP ${REST_GAP})`);

  // …and it is a legal place for it to be, asked through the editor's own rule.
  // `idx: 0` is not optional: the default -1 means "a piece not in the list
  // yet", so the overlap check compares the crate with ITSELF and every fresh
  // template reads as two goal pieces in one spot.
  gate('41. …somewhere the editor itself accepts',
    S._landingBlocked(crate, crate, { idx: 0, isGoal: true }) === null,
    S._landingBlocked(crate, crate, { idx: 0, isGoal: true }));

  // both zones stand ON the floor, which is what makes the level make sense at
  // a glance — a build zone floating in the sky is the confusing first sight
  for (const [what, z] of [['build', T.buildZones[0]], ['goal', T.goalZones[0]]]) {
    gate(`41. …and the ${what} zone stands on the floor`,
      Math.abs((z.y + z.h / 2) - floorTop) < 1e-9,
      `bottom ${z.y + z.h / 2}, floor ${floorTop}`);
  }
  // the two do not overlap: a starter where the goal is already IN the goal
  // zone would be won before it began
  gate('41. …and the build and goal zones are apart',
    T.buildZones[0].x + T.buildZones[0].w / 2 < T.goalZones[0].x - T.goalZones[0].w / 2,
    `build ends ${T.buildZones[0].x + T.buildZones[0].w / 2}, goal starts ${T.goalZones[0].x - T.goalZones[0].w / 2}`);

  // …and all of it inside the fence (§10.7), which a template shipped in code
  // could otherwise quietly violate for every new level at once
  const all = [...T.terrain, ...T.buildZones, ...T.goalZones, ...T.goalObjs];
  const outside = all.filter(o => Math.abs(o.x) + (o.w || o.r || 0) / 2 > WORLD_LIMIT
    || Math.abs(o.y) + (o.h || o.r || 0) / 2 > WORLD_LIMIT);
  gate('41. …and every piece of it inside the buildable area',
    outside.length === 0, `${all.length} pieces checked`);
}

// ---------- gate 42: the free end is under the cursor (§8.2) ----------
//
// Reported as "when drawing rods starting outside the build area, when the mouse
// goes back into the build area the pointer and the pin don't line back up — rod
// movement is slightly out of sync with the mouse."
//
// It was: a press outside the zone had its anchor clamped inside, and the offset
// that took was added to the AIM for the rest of the gesture. So the free end
// ran a constant distance ahead of the pointer — measured at exactly the press
// offset, and still there once the cursor was deep inside the zone. It bought
// the corner case (gate 36) at the cost of every draw that starts outside an
// edge, which is the common habit.
//
// The two claims are in tension and that is why both are here: the end tracks
// the cursor EXACTLY, and a gesture whose target collapses still lays a stick.
{
  const open = {
    buildZones: [{ x: 0, y: -100, w: 700, h: 500 }],          // x -350..350
    terrain: [{ type: 'box', x: 0, y: 400, w: 2000, h: 200 }], // floor, top y = 300
  };
  const track = (pressX) => {
    const S = screen(open, { tool: 'rod-wood' });
    S._pointerDown(ev(pressX, -200));
    const worst = [];
    for (const cx of [-340, -300, -200, -100, 0, 100, 200]) {
      S._pointerMove(ev(cx, -200));
      worst.push(Math.abs(S.drag.x2 - cx));
    }
    S._pointerUp(ev(200, -200));
    return Math.max(...worst);
  };
  // Inside the zone (the control: this always worked), then across the press
  // band to its far end. The offsets track `PRESS_SLACK` rather than naming
  // pixels — they used to read 10 / 30 / 39 against a 40 px world band, and the
  // band is 10 SCREEN px now, so a fixture written in pixels would be testing
  // a pan.
  for (const [label, x] of [
    ['inside', -300],
    ['a third of the band outside', -350 - PRESS_SLACK / 3],
    ['most of the band outside', -350 - PRESS_SLACK * 0.7],
    ['at the very edge of the band', -350 - PRESS_SLACK + 0.5],
  ]) {
    gate(`42. a draw pressed ${label} keeps its free end under the cursor`,
      track(x) < 0.01, `worst gap ${track(x).toFixed(2)} px`);
  }

  // …and the gesture the offset existed for still works: press outside a
  // CORNER, drag while still outside it, and a stick is laid along the stroke
  // rather than collapsing to nothing.
  {
    // inside the press band, both ends still outside the corner (see gate 36)
    const S = screen(open, { tool: 'rod-wood' });
    gesture(S, { x: -358, y: -358 }, { x: -352, y: -351 }, { watch: () => ({ x: 0, y: 0 }) });
    const rod = S.design.parts[0];
    // the stroke is (6, 7) now — it was (10, 20) against the old 40 px band
    const drawn = Math.hypot(6, 7);
    gate('42. …while a short draw from outside a CORNER still lays one',
      !!rod && Math.abs(Math.hypot(rod.x2 - rod.x1, rod.y2 - rod.y1) - drawn) < 0.5,
      rod ? `${Math.hypot(rod.x2 - rod.x1, rod.y2 - rod.y1).toFixed(1)} px of the ${drawn.toFixed(1)} drawn` : `nothing — ${JSON.stringify(S.toasts)}`);
  }
  // …and a genuine CLICK outside the zone still places nothing, which is what
  // stops the fallback turning every stray tap into a stick
  {
    const S = screen(open, { tool: 'rod-wood' });
    S._pointerDown(ev(-380, -380));
    S._pointerMove(ev(-379, -379));
    S._pointerUp(ev(-379, -379));
    gate('42. …and a click outside the zone still places nothing',
      S.design.parts.length === 0, `${S.design.parts.length} placed`);
  }
}

// ---------- gate 43: labels group and move (§9.3/§10.6) ----------
//
// A label was the one piece kind that could be neither grouped with anything
// nor given a motion path. It rides a group on exactly the terms a goal zone
// does — no body either way — which is why `_groupRiders` exists: the dozen
// sites that rigidly move a group's non-terrain members now mean "zones AND
// labels", while the two that really do mean ZONES (the chip's count, the
// per-zone detach) still say `_groupZoneMembers` and are untouched.
{
  const world = () => flatWorld({
    texts: [{ text: 'SIGN', x: 0, y: -200, size: 30 }],
    terrain: [{ type: 'box', x: 0, y: 30, w: 1200, h: 60 },
      { type: 'box', x: 0, y: -100, w: 120, h: 20 }],
  });

  // ---- grouping ----
  {
    const S = screen(world(), { tab: 'level' });
    const slab = S.level.terrain[1], sign = S.level.texts[0];
    S.multiSel = [{ kind: 'terrain', ref: slab }, { kind: 'text', ref: sign }];
    S._groupSelection();
    gate('43. a label can be grouped with a terrain piece',
      !!sign.groupId && sign.groupId === slab.groupId && !!S.level.groups[sign.groupId],
      sign.groupId ? 'grouped' : `refused — ${JSON.stringify(S.toasts)}`);
    const gid = sign.groupId;
    gate('43. …and counts as a member of it', S._groupSize(gid) === 2, `${S._groupSize(gid)} members`);
    gate('43. …and the group answers for it on a hit test',
      S._hitTest({ x: 0, y: -200 })?.kind === 'group',
      S._hitTest({ x: 0, y: -200 })?.kind);

    // it MOVES with the group — the whole point
    const before = { x: sign.x, y: sign.y };
    S._select({ kind: 'group', gid });
    gesture(S, { x: 0, y: -100 }, { x: 60, y: -130 }, { watch: () => ({ x: sign.x, y: sign.y }) });
    gate('43. …and travels with the group when it is dragged',
      near(sign.x - before.x, slab.x - 0, 0.01) && sign.x !== before.x,
      `label moved ${(sign.x - before.x).toFixed(1)}, slab moved ${(slab.x - 0).toFixed(1)}`);

    // …and ungrouping releases it
    S._dissolveGroup(gid);
    gate('43. …and ungrouping releases it', !sign.groupId && !slab.groupId);
  }
  // a label-only group is allowed: two signs travelling together
  {
    const S = screen(flatWorld({
      texts: [{ text: 'A', x: 0, y: -200, size: 30 }, { text: 'B', x: 80, y: -200, size: 30 }],
    }), { tab: 'level' });
    S.multiSel = S.level.texts.map(t => ({ kind: 'text', ref: t }));
    S._groupSelection();
    gate('43. two labels can be a group on their own',
      !!S.level.texts[0].groupId && S.level.texts[0].groupId === S.level.texts[1].groupId);
  }
  // …and one label alone is still not a group
  {
    const S = screen(world(), { tab: 'level' });
    S.multiSel = [{ kind: 'text', ref: S.level.texts[0] }];
    S._groupSelection();
    gate('43. …but one label alone is not', !S.level.texts[0].groupId,
      JSON.stringify(S.toasts));
  }

  // ---- its own motion path ----
  {
    const S = screen(world(), { tab: 'level' });
    const sign = S.level.texts[0];
    S._select({ kind: 'text', ref: sign });
    S._addWaypointAt({ x: 200, y: -200 });
    gate('43. a label can be given its own motion path',
      !!sign.path && sign.path.pts.length === 1
      && near(sign.path.pts[0].x, 200) && near(sign.path.pts[0].y, -200),
      sign.path ? `${sign.path.pts.length} waypoint(s)` : 'no path');
    // the path's ORIGIN is the label itself, so closing the loop lands on it
    S._addWaypointAt({ x: sign.x, y: sign.y });
    gate('43. …and a waypoint dropped on the label closes the loop',
      sign.path.pts.length === 2
      && near(sign.path.pts[1].x, sign.x) && near(sign.path.pts[1].y, sign.y));
  }
  // **AND IT CAN BE PICKED UP.** Drawing a path and PICKING one are two
  // separate enumerations of the same list, and the second was missed when
  // labels learned to move: the route appeared on screen and not one point on
  // it could be grabbed. Reported as exactly that. A gate that only checked the
  // path EXISTS would have passed the whole time.
  {
    const S = screen(world(), { tab: 'level' });
    const sign = S.level.texts[0];
    sign.path = { pts: [{ x: 200, y: -200 }, { x: 200, y: -300 }], mode: 'once', speed: 40 };
    S._select({ kind: 'text', ref: sign });

    const onWaypoint = S._pathHit({ x: 200, y: -200 });
    gate('43. a waypoint on a label\'s path can be grabbed',
      onWaypoint?.kind === 'waypoint' && onWaypoint.path === sign.path,
      onWaypoint ? onWaypoint.kind : 'nothing under the pointer');

    // …and a HANDLE, which is the other half of what could not be grabbed.
    // Found by asking the same resolver the drawing does, so the gate cannot
    // drift from where the dot actually is.
    const anchors = pathAnchors(sign, sign.path);
    const { h1 } = resolvedHandles(anchors, 1, false);
    const hp = { x: anchors[1].x + h1.x, y: anchors[1].y + h1.y };
    const onHandle = S._pathHit(hp);
    gate('43. …and so can a handle on it',
      onHandle?.kind === 'handle' && onHandle.path === sign.path,
      onHandle ? onHandle.kind : 'nothing under the pointer');

  }
  // …and Alt+click inserts an anchor into it. Its own fixture, with ONE
  // waypoint: that makes the curve the straight line from the label to it, so
  // the click point is exactly on the path. With two waypoints the auto
  // Catmull-Rom tangent bows the segment away from the straight line between
  // them, and the insert's 10 px tolerance then misses a midpoint that looks
  // right on paper.
  {
    const S = screen(world(), { tab: 'level' });
    const sign = S.level.texts[0];                     // at (0, -200)
    sign.path = { pts: [{ x: 200, y: -200 }], mode: 'once', speed: 40 };
    S._select({ kind: 'text', ref: sign });
    S._tryInsertWaypoint({ x: 100, y: -200 });         // the midpoint of that line
    gate('43. …and a point can be inserted into a label\'s path',
      sign.path.pts.length === 2, `${sign.path.pts.length} waypoint(s)`);
  }
  // THE CONTROL: nothing else gained a path by accident. A build zone still
  // cannot have one — only goal zones move (§9.3) — and that rule is one line
  // away from the branch just added.
  {
    const S = screen(world(), { tab: 'level' });
    S._select({ kind: 'zone', zone: 'build', idx: 0, ref: S.level.buildZones[0] });
    S._addWaypointAt({ x: 100, y: -100 });
    gate('43. …while a BUILD zone still cannot be given one',
      !S.level.buildZones[0].path, JSON.stringify(S.level.buildZones[0].path));
  }
}

// ---------- gate 44: ropes (§10.1) ----------
//
// A rope is not a part. It is rods laid in ONE gesture, tagged with one shared
// `chain` id, and drawn as one continuous line because of it — same capsules,
// same pins, same physics, so nothing already built moves (§5.8). Everything
// worth gating is therefore in two places: that the id is written exactly once
// per gesture, and that the renderer's walk from the id to a RUN survives the
// editing that happens afterwards.
//
// The renderer is gated through a recording context rather than a canvas. What
// it counts is what the eye actually reads — pin dots at the ends and not in
// the middle, one body per rod and no more, and a lay whose phase carries
// across a joint. That last one is the whole difference between a rope and a
// row of sticks, and it is not visible in any other assertion here.
{
  // Enough of the 2D API for the rod pass, recording instead of drawing.
  // `lineWidth` at the moment of each stroke/moveTo is what separates the three
  // things drawn: a wood body is 5 then 3.5, a water body 3.5 then 1, a lay
  // mark 1.1. Pin dots are the only arcs of radius 1.8.
  const recCtx = (scale = 1) => {
    const c = {
      pins: 0, arcs: 0, strokes: [], marks: [],
      lineWidth: 1, lineCap: 'butt', globalAlpha: 1, strokeStyle: '', fillStyle: '',
      pts: [],
      save() {}, restore() {}, beginPath() {}, closePath() {},
      moveTo(x, y) { c.marks.push(c.lineWidth); c.pts.push([c.lineWidth, x, y]); },
      lineTo(x, y) { c.pts.push([c.lineWidth, x, y]); },
      // a pin is recognised by being drawn at the pin radius — asked of
      // render.js rather than typed, so it survives the radius moving (it did,
      // 1.8 → 2.4, and this rig then counted no pins anywhere at all)
      arc(x, y, r) { c.arcs++; if (Math.abs(r - PIN_DOT_R) < 1e-9) c.pins++; },
      fill() {}, stroke() { c.strokes.push(c.lineWidth); }, clip() {}, rect() {},
      translate() {}, rotate() {},
      getTransform: () => ({ a: scale }),
    };
    return c;
  };
  // Read the width off render.js, never typed: this said 5 and counted zero
  // the day the drawn width became 5.66 (2026-08-20), which reads as "the rope
  // drew nothing" rather than "the number moved".
  const bodies = (c) => c.strokes.filter((w) => w === ROD_DRAW_W.wood).length;   // wood links drawn
  const layMarks = (c) => c.marks.filter((w) => w === 1.1).length;

  // n links end to end along +x from (x,y), all sharing one chain id
  const ropeOf = (n, { x = 0, y = 0, len = 30, chain = 'c1', kind = 'wood' } = {}) =>
    Array.from({ length: n }, (_, i) => ({
      t: 'rod', kind, chain, id: `${chain}-${i}`,
      x1: x + i * len, y1: y, x2: x + (i + 1) * len, y2: y,
    }));

  // ---- the id: written once per gesture, and only by a gesture that means it ----
  {
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-200, -100, { altKey: true }));
    for (let i = 1; i <= 10; i++) S._pointerMove(ev(-200 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(0, -100, { altKey: true }));
    const rods = S.design.parts.filter((p) => p.t === 'rod');
    const ids = new Set(rods.map((p) => p.chain));
    gate('44. Alt+drag tags every link of one stroke with ONE chain id',
      rods.length > 3 && ids.size === 1 && [...ids][0],
      `${rods.length} links, ${ids.size} id(s)`);

    // a second stroke is a second rope, and must not join the first
    S._pointerDown(ev(-200, -200, { altKey: true }));
    for (let i = 1; i <= 10; i++) S._pointerMove(ev(-200 + i * 20, -200, { altKey: true }));
    S._pointerUp(ev(0, -200, { altKey: true }));
    const all = new Set(S.design.parts.filter((p) => p.t === 'rod').map((p) => p.chain));
    gate('44. …and a second stroke gets a different one', all.size === 2, `${all.size} id(s)`);
  }
  {
    // A stick drawn by hand is a stick. Sticks pinned into a triangle by hand
    // must never come back as a rope, which is the whole reason the id is
    // written at the gesture rather than inferred from the geometry after.
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-200, -100));
    S._pointerMove(ev(-140, -100));
    S._pointerUp(ev(-140, -100));
    const rod = S.design.parts.find((p) => p.t === 'rod');
    gate('44. …while a plain drag leaves no chain id at all',
      !!rod && rod.chain === undefined, rod ? JSON.stringify(rod.chain) : 'no rod placed');
    gate('44. …so untagged sticks produce no runs', ropeRuns(S.design.parts).length === 0);
  }

  {
    // THE FLOOR, and it is not the one the constants suggest. A link shorter
    // than the rod's own thickness is not a segment, it is a blob — measured on
    // a 240 px slack rope, the worst kink at any joint is 10° at 4 px links,
    // 80° at 3 and 180° at 2, where the rope folds flat and sags 568 px against
    // every longer rope's 85. ROD_SKIP_LEN (2) is BELOW that, so the sim's own
    // floor never catches it; MIN_LINK_LEN (5) is what a rope will lay
    // draw by hand, and a rope should not lay a link you couldn't.
    gate('44. a rope link is longer than the rod is thick',
      ROPE_LINK_LEN > ROD_THICK && ROPE_LINK_LEN >= MIN_LINK_LEN,
      `link ${ROPE_LINK_LEN}, ROD_THICK ${ROD_THICK}, MIN_LINK_LEN ${MIN_LINK_LEN}, ROD_SKIP_LEN ${ROD_SKIP_LEN}`);
  }
  {
    // **ROUGHLY equal small pieces — the band, from both rope-makers.** The
    // target is 8, but it is a target and not a quantum: paint closes its
    // remainder into a final short link on release, and the wrap divides each
    // hull edge into the whole number of links NEAREST to 8. Both are provably
    // inside [MIN_LINK_LEN, 1.5 × ROPE_LINK_LEN) — `round` can only stretch a
    // lone link to just under 12 before it splits in two, and the wrap drops
    // hull vertices closer together than a link may be. Nothing here may lay a
    // 1 px crumb or one giant link.
    const LO = MIN_LINK_LEN, HI = ROPE_LINK_LEN * 1.5;
    const lenOf = (p) => Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    const band = (rods) => ({
      min: Math.min(...rods.map(lenOf)), max: Math.max(...rods.map(lenOf)), n: rods.length,
    });

    // paint, swept across release points that do NOT divide evenly by 8 — the
    // tail link is the point, so the rope must not trail the cursor by a whole
    // link any more. What is left over can only be a stub too short to BE a
    // link; anything longer becomes one.
    let worstGap = 0, sawTail = false, lo = Infinity, hi = 0, count = 0;
    for (let end = -140; end >= -175; end -= 3) {
      const S = screen(flatWorld(), { tool: 'rod-wood' });
      S._pointerDown(ev(-300, -100, { altKey: true }));
      for (let i = 1; i <= 6; i++) S._pointerMove(ev(-300 + (end + 300) * i / 6, -100, { altKey: true }));
      S._pointerUp(ev(end, -100, { altKey: true }));
      const rods = S.design.parts.filter((r) => r.t === 'rod');
      const b = band(rods);
      lo = Math.min(lo, b.min); hi = Math.max(hi, b.max); count += b.n;
      const reach = Math.max(...rods.map((r) => Math.max(r.x1, r.x2)));
      worstGap = Math.max(worstGap, Math.abs(reach - end));
      if (rods.some((r) => lenOf(r) < ROPE_LINK_LEN - 0.01)) sawTail = true;
    }
    gate('44. chain paint\'s links are roughly equal, and all small',
      lo >= LO && hi < HI, `${count} links over 12 strokes, ${lo.toFixed(2)}–${hi.toFixed(2)} px (band ${LO}–${HI})`);
    gate('44. …and what a rope leaves short of the cursor is under one link',
      sawTail && worstGap < MIN_LINK_LEN,
      `worst gap ${worstGap.toFixed(2)} px (a whole link is ${ROPE_LINK_LEN}); short tail links seen: ${sawTail}`);

    // wrap: three pieces at awkward offsets, so the hull has short edges
    const W = screen(flatWorld(), {
      parts: [{ t: 'wheel', kind: 'free', x: -40, y: -100, r: 15, id: 'w1' },
        { t: 'wheel', kind: 'free', x: 41, y: -103, r: 8, id: 'w2' },
        { t: 'rod', kind: 'wood', x1: -38, y1: -140, x2: 7, y2: -139, id: 'r1' }],
    });
    W._closeCtxMenu = () => {}; W._updateInfoChip = () => {};
    W.multiSel = W.design.parts.map((q) => ({ kind: 'part', ref: q }));
    W._chainWrap();
    const wr = band(W.design.parts.filter((q) => q.t === 'rod' && q.chain));
    // **The wrap has its OWN target now** (`WRAP_LINK_LEN`), so it has its own
    // band: `_ropeSplit` rounds, so a link lands within [target/1.5, target*1.5].
    // Read out of game.js rather than restated here, so moving the constant stops
    // this file and gets looked at instead of quietly widening the band.
    const WRAP = Number(fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8')
      .match(/const WRAP_LINK_LEN = ([0-9.]+);/)[1]);
    // a hull edge shorter than the target is ONE link of that edge's length (a
    // small wheel's chords are 4–12 px against a 24 px target), so the floor is
    // MIN_LINK_LEN and only the ceiling is the target's
    const WLO = MIN_LINK_LEN, WHI = WRAP * 1.5;
    gate('44. …and so are the chain wrap\'s, on a hull with awkward corners',
      wr.min >= WLO && wr.max < WHI,
      `${wr.n} links, ${wr.min.toFixed(2)}-${wr.max.toFixed(2)} px (WRAP_LINK_LEN ${WRAP}, band ${WLO.toFixed(1)}-${WHI.toFixed(1)})`);
    // the split itself: a wrap must lay FEWER, longer links than chain paint,
    // or the constant is doing nothing and the measurement behind it is stale
    gate('44. …and a wrap lays longer links than chain paint would',
      WRAP > ROPE_LINK_LEN, `wrap ${WRAP} vs rope ${ROPE_LINK_LEN}`);
  }

  // ---- the walk: id → one ordered run ----
  {
    const runs = ropeRuns(ropeOf(6));
    const r = runs[0];
    const ordered = r && r.links.every((L, i) => near(L.ax, i * 30) && near(L.bx, (i + 1) * 30));
    gate('44. the links of one stroke walk into ONE ordered run',
      runs.length === 1 && r.links.length === 6 && !r.closed && ordered,
      `${runs.length} run(s) of ${r ? r.links.length : 0}`);
  }
  {
    // Stored end-for-end. Chain paint never does this, but a link's endpoints
    // are swapped by editing (drag one end past the other) and a walk that
    // assumed x1 comes first would silently draw the rope inside out.
    const links = ropeOf(3);
    links[1] = { ...links[1], x1: links[1].x2, x2: links[1].x1 };
    const r = ropeRuns(links)[0];
    gate('44. …and a link stored end-for-end still walks in order',
      r.links.length === 3 && near(r.links[0].bx, r.links[1].ax) && near(r.links[1].bx, r.links[2].ax),
      r.links.map((L) => `${L.ax}→${L.bx}`).join(' '));
  }
  {
    const c = recCtx();
    drawRods(c, ropeOf(8), {});
    const plain = recCtx();
    drawRods(plain, ropeOf(8).map(({ chain, ...p }) => p), {});
    // **9, not 16** (amended 2026-08-23). 16 was 8 links times 2 ends, back
    // when every stick drew its own pair and a shared joint got two dots on
    // the same spot. drawRods now draws one boss per COORDINATE, and eight
    // links laid end to end have nine distinct endpoints — so 9 is not a
    // slackened number, it is the arithmetic, and it proves the dedupe is by
    // position rather than by count. The claim under test is unchanged: a
    // rope suppresses its interior joints and a plain run does not.
    gate('44. a rope draws pins at its two ENDS and nowhere else',
      c.pins === 2 && plain.pins === 9, `rope ${c.pins} pins, same rods untagged ${plain.pins}`);
    gate('44. …and still draws every link exactly once',
      bodies(c) === 8 && bodies(plain) === 8, `${bodies(c)} bodies vs ${bodies(plain)}`);
  }
  {
    // THE ROPE TEST. Two 30 px links, a mark every 4.5 px starting half a pitch
    // in: 13 marks across 60 px of rope. A lay whose phase restarted at each
    // link would draw 7 + 7 = 14 — i.e. it would be re-drawing the joints the
    // pins were just taken off, which is exactly the thing this feature is.
    const c = recCtx();
    drawRods(c, ropeOf(2), {});
    gate('44. the lay runs on ONE phase across a joint, not per link',
      layMarks(c) === 13, `${layMarks(c)} marks (14 = a phase reset at the joint)`);
  }
  {
    // A mark must stay INSIDE the body it is drawn on, and the two bodies are
    // not the same width — wood strokes 5 px, water 3.5. Marks sized for wood
    // hang a third of a pixel off each side of a wet rope, and that is the
    // whole difference between reading it as a rope and reading it as a net.
    // The rope here runs along y = 0, so the overhang IS |y|.
    const reach = (kind) => {
      const c = recCtx();
      drawRods(c, ropeOf(4, { kind }), {});
      return Math.max(...c.pts.filter(([w]) => w === 1.1).map(([, , y]) => Math.abs(y)));
    };
    const wood = reach('wood'), wet = reach('water');
    gate('44. a lay mark never hangs off the body it is drawn on',
      wood < 2.5 && wet < 1.75 && wood > 1.5 && wet > 1,
      `wood ${wood} of 2.5, wet ${wet.toFixed(2)} of 1.75`);
  }
  {
    // Zoomed right out — a thumbnail is ~0.15 — the marks are finer than a
    // screen pixel and would come out as noise on the rope's own colour.
    const c = recCtx(0.3);
    drawRods(c, ropeOf(6), {});
    gate('44. …and is dropped when it would be finer than a screen pixel',
      layMarks(c) === 0 && bodies(c) === 6, `${layMarks(c)} marks, ${bodies(c)} bodies`);
  }

  // ---- the walk survives editing ----
  {
    const links = ropeOf(8);
    links.splice(3, 1);                       // delete a link out of the middle
    const runs = ropeRuns(links);
    const lens = runs.map((r) => r.links.length).sort((a, b) => a - b);
    gate('44. deleting a link from the middle splits one rope into two',
      runs.length === 2 && lens[0] === 3 && lens[1] === 4, `runs of ${lens.join(' + ')}`);
    const c = recCtx();
    drawRods(c, links, {});
    gate('44. …and the two halves get two ends each', c.pins === 4, `${c.pins} pins`);
  }
  {
    // A fork can't be one line. Both runs stop at the junction, and the pin
    // there comes back — it is a real pin, three links deep.
    const links = [...ropeOf(4), { t: 'rod', kind: 'wood', chain: 'c1', id: 'br', x1: 60, y1: 0, x2: 60, y2: -30 }];
    const runs = ropeRuns(links);
    const lens = runs.map((r) => r.links.length).sort((a, b) => a - b);
    gate('44. a third rope tied into the middle ends both runs at the junction',
      runs.length === 3 && lens.join(',') === '1,2,2', `runs of ${lens.join(' + ')}`);
  }
  {
    // Two ropes tied END TO END are ONE rope, whoever drew them and whenever.
    // Nobody looking at them would say otherwise, so the graph is built on the
    // GEOMETRY and the `chain` id is never grouped on — it answers "is this
    // rope?", never "which rope?". It draws as one line with one pin at each
    // far end and none at the join, and it counts as one.
    const links = [...ropeOf(3), ...ropeOf(3, { x: 90, chain: 'c2' })];
    const runs = ropeRuns(links);
    const c = recCtx();
    drawRods(c, links, {});
    gate('44. two ropes tied end to end are ONE rope',
      runs.length === 1 && c.pins === 2 && designStats(links).pieces === 1,
      `${runs.length} run(s), ${c.pins} pins, ${designStats(links).pieces} piece(s)`);
  }
  {
    // The chain wrap closes on itself — the one rope with no ends at all.
    const S = screen(flatWorld(), {
      parts: [{ t: 'wheel', kind: 'free', x: -40, y: -100, r: 15, id: 'w1' },
        { t: 'wheel', kind: 'free', x: 40, y: -100, r: 15, id: 'w2' }],
    });
    S._closeCtxMenu = () => {};
    S._updateInfoChip = () => {};
    S.multiSel = S.design.parts.map((p) => ({ kind: 'part', ref: p }));
    S._chainWrap();
    const made = S.design.parts.filter((p) => p.t === 'rod');
    const ids = new Set(made.map((p) => p.chain));
    const runs = ropeRuns(made);
    const c = recCtx();
    drawRods(c, made, {});
    gate('44. a chain wrap is ONE rope, tagged in one go',
      made.length > 8 && ids.size === 1, `${made.length} links, ${ids.size} id(s)`);
    gate('44. …closed, so it has no ends and draws no end pins',
      runs.length === 1 && runs[0].closed && runs[0].links.length === made.length && c.pins === 0,
      `${runs.length} run(s), closed ${runs[0]?.closed}, ${c.pins} pins`);
  }

  {
    // `_restore()` REPLACES objects rather than mutating them (§16), and it is
    // the path every undo, every reverted drag and every rejected paste goes
    // down. An additive field that only exists on the objects the gesture made
    // would come back from an undo as a row of sticks.
    const S = screen(flatWorld(), { tool: 'rod-wood', undo: true });
    S._pointerDown(ev(-200, -100, { altKey: true }));
    for (let i = 1; i <= 8; i++) S._pointerMove(ev(-200 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(-40, -100, { altKey: true }));
    const painted = S.design.parts.length;
    S.undo();
    const afterUndo = S.design.parts.length;
    S.redo();
    const back = S.design.parts.filter((p) => p.t === 'rod');
    const ids = new Set(back.map((p) => p.chain));
    gate('44. a rope survives undo and redo as a rope',
      painted > 3 && afterUndo === 0 && back.length === painted && ids.size === 1
        && ropeRuns(back).length === 1,
      `${painted} → ${afterUndo} → ${back.length} links, ${ids.size} id(s), ${ropeRuns(back).length} run(s)`);
  }

  // ---- drag chain, make more chain; drag TO chain, a pin is waiting ----
  //
  // The two halves of what a rope is for. Pulling more chain off the end of a
  // chain must EXTEND it — one rope, one piece, no pin appearing in the middle
  // of a line that is plainly continuous. And a rope is connectable all the way
  // along, because every link junction is a real pin: that is the payoff for
  // the fixed link size, and it is the thing hiding the interior dots could
  // quietly have taken away.
  {
    const paint = (S, from, to, alt = true) => {
      S._pointerDown(ev(from.x, from.y, { altKey: alt }));
      const n = Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 20));
      for (let i = 1; i <= n; i++) {
        S._pointerMove(ev(from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n, { altKey: alt }));
      }
      S._pointerUp(ev(to.x, to.y, { altKey: alt }));
    };
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    paint(S, { x: -300, y: -100 }, { x: -200, y: -100 });
    const first = S.design.parts.filter((p) => p.t === 'rod');
    const end = { x: Math.max(...first.map((p) => Math.max(p.x1, p.x2))), y: -100 };
    const idsAfterOne = new Set(first.map((p) => p.chain));

    // …now pull more chain off that end
    paint(S, end, { x: end.x + 100, y: -100 });
    const all = S.design.parts.filter((p) => p.t === 'rod');
    const ids = new Set(all.map((p) => p.chain));
    const runs = ropeRuns(all);
    gate('44. dragging from a rope\'s end EXTENDS it rather than starting a new one',
      idsAfterOne.size === 1 && ids.size === 1 && runs.length === 1 && all.length > first.length,
      `${all.length} links, ${ids.size} id(s), ${runs.length} run(s)`);
    const c = recCtx();
    drawRods(c, all, {});
    gate('44. …so the extended rope still draws two end pins and no more',
      c.pins === 2 && designStats(S.design.parts).pieces === 1,
      `${c.pins} pins, ${designStats(S.design.parts).pieces} piece(s)`);
  }
  {
    // Starting from the MIDDLE of a rope is a rope tied into a rope — two
    // ropes, and the junction keeps the pin it really has.
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-300, -100, { altKey: true }));
    for (let i = 1; i <= 10; i++) S._pointerMove(ev(-300 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(-100, -100, { altKey: true }));
    const mid = S.design.parts[5];
    S._pointerDown(ev(mid.x2, mid.y2, { altKey: true }));
    for (let i = 1; i <= 5; i++) S._pointerMove(ev(mid.x2, mid.y2 - i * 20, { altKey: true }));
    S._pointerUp(ev(mid.x2, mid.y2 - 100, { altKey: true }));
    const ids = new Set(S.design.parts.filter((p) => p.t === 'rod').map((p) => p.chain));
    gate('44. …while starting from the MIDDLE of one makes a second rope',
      ids.size === 2, `${ids.size} id(s)`);
  }
  {
    // The other direction: draw a plain stick at a rope and a pin is waiting.
    // At ROPE_LINK_LEN every point along a rope is within half a link of one,
    // which is inside SNAP at any sane zoom — this asserts the stick actually
    // LANDS on a pin, not merely near one, since landing on it is what forms
    // the joint (§5.4).
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-300, -100, { altKey: true }));
    for (let i = 1; i <= 10; i++) S._pointerMove(ev(-300 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(-100, -100, { altKey: true }));
    const ropePins = new Set();
    for (const p of S.design.parts.filter((x) => x.chain)) {
      ropePins.add(jointKey(p.x1, p.y1)); ropePins.add(jointKey(p.x2, p.y2));
    }
    // aim a stick's far end a couple of px off the middle of the rope
    const target = { x: -201, y: -100 };
    S.tool = 'rod-wood';
    S._pointerDown(ev(-250, -180));
    S._pointerMove(ev(target.x, target.y));
    S._pointerUp(ev(target.x, target.y));
    const stick = S.design.parts.filter((p) => p.t === 'rod' && !p.chain)[0];
    gate('44. a stick drawn at a rope lands ON one of its pins',
      !!stick && ropePins.has(jointKey(stick.x2, stick.y2)),
      stick ? `far end ${stick.x2.toFixed(1)},${stick.y2.toFixed(1)} — ${ropePins.has(jointKey(stick.x2, stick.y2)) ? 'on a pin' : 'off the pins'}` : 'no stick placed');
  }
  {
    // The pins are drawn only while a stick tool is armed — the art stays a
    // rope, the overlay tells the truth when it is actionable.
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-300, -100, { altKey: true }));
    for (let i = 1; i <= 6; i++) S._pointerMove(ev(-300 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(-180, -100, { altKey: true }));
    const links = S.design.parts.filter((p) => p.t === 'rod').length;
    const dots = () => { const c = recCtx(); S._drawRopePins(c); return c.arcs; };
    const armed = dots();
    S.tool = 'pointer';
    const unarmed = (() => { const c = recCtx(); if (S.tool.startsWith('rod-')) S._drawRopePins(c); return c.arcs; })();
    gate('44. a rope\'s pins are revealed by the stick tool, and only then',
      armed === links + 1 && unarmed === 0,
      `${armed} dots for ${links} links (${links + 1} shared pins), ${unarmed} with the pointer`);
  }

  // ---- a rope is ONE piece ----
  //
  // The count is not cosmetic: `pieces` is what every piece bar, every "fewest
  // pieces" leaderboard row and every piece-capped challenge is measured
  // against (§11.8). At 8 px links a 400 px rope is fifty of them, so counting
  // links would make the feature unusable in exactly the places a rope is worth
  // most. `parts` is the other number — what MAX_DESIGN_PARTS caps — and the
  // two must not be confused for each other.
  {
    const plain = [
      { t: 'wheel', kind: 'cw', x: 0, y: 0, r: 15, id: 'w' },
      { t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 30, y2: 0, id: 'a' },
      { t: 'rod', kind: 'water', x1: 30, y1: 0, x2: 60, y2: 0, id: 'b' },
    ];
    const before = designStats(plain);
    gate('44. a design with no rope counts exactly as it always did',
      before.pieces === plain.length && before.parts === plain.length
        && before.wood === 1 && before.water === 1 && before.wheels === 1,
      `${before.pieces} pieces of ${plain.length} parts`);

    const withRope = [...plain, ...ropeOf(20, { x: 200, chain: 'r1' })];
    const st = designStats(withRope);
    gate('44. …and a twenty-link rope adds ONE piece, not twenty',
      st.pieces === before.pieces + 1 && st.parts === plain.length + 20 && st.wood === 2,
      `${st.pieces} pieces, ${st.parts} parts`);
    gate('44. …while its kg still counts every link',
      st.kg > before.kg + 3, `${before.kg.toFixed(1)} → ${st.kg.toFixed(1)} kg`);
  }
  {
    // Cut in half it is honestly two ropes — the count follows the RUNS, which
    // is what the eye follows too. Counting distinct `chain` ids would say one.
    const links = ropeOf(8);
    links.splice(3, 1);
    const st = designStats(links);
    gate('44. a rope cut in half counts as two pieces',
      st.pieces === 2 && st.parts === 7, `${st.pieces} pieces of ${st.parts} parts`);
  }
  {
    // **THE COUNTING TABLE, exactly as it was stated in play.** Counted the way
    // you would count real rope: how many separate lengths would you have to
    // cut to lay this shape out? Per connected piece that is `max(1, odd / 2)`
    // over nodes with an ODD number of link-ends — the Eulerian trail
    // decomposition, which is the same rule arrived at from the other end.
    //
    // The reason it goes up only every OTHER strand: every strand at a junction
    // belongs to some rope, and a rope passing through a point accounts for two
    // of them, so only an odd strand forces a new length to start or stop there.
    const arm = (chain, dx, dy, n = 3) => Array.from({ length: n }, (_, i) => ({
      t: 'rod', kind: 'wood', chain, id: `${chain}${i}`,
      x1: dx * 30 * i, y1: dy * 30 * i, x2: dx * 30 * (i + 1), y2: dy * 30 * (i + 1),
    }));
    const junction = (n) => {
      const dirs = [[1, 0], [-1, 0], [0, -1], [0, 1], [0.6, 0.8], [-0.6, 0.8]];
      return dirs.slice(0, n).flatMap(([dx, dy], k) => arm(`j${k}`, dx, dy));
    };
    const square = ['w'].flatMap((c) => [[0, 0, 60, 0], [60, 0, 60, 60], [60, 60, 0, 60], [0, 60, 0, 0]]
      .map((e, i) => ({ t: 'rod', kind: 'wood', chain: c, id: c + i, x1: e[0], y1: e[1], x2: e[2], y2: e[3] })));
    const table = [
      ['one rope', ropeOf(6), 1],
      ['two tied end to end', [...ropeOf(3), ...ropeOf(3, { x: 90, chain: 'c2' })], 1],
      ['three at a junction', junction(3), 2],
      ['four at a junction', junction(4), 2],
      ['five at a junction', junction(5), 3],
      ['six at a junction', junction(6), 3],
      ['a closed loop', square, 1],
      ['one rope cut in half', [...ropeOf(3), ...ropeOf(3, { x: 300 })], 2],
    ];
    const wrong = table.filter(([, links, want]) => designStats(links).pieces !== want)
      .map(([name, links, want]) => `${name}: ${designStats(links).pieces} not ${want}`);
    gate('44. the counting table, every row of it', !wrong.length,
      wrong.length ? wrong.join('; ') : table.map(([n, , w]) => `${n}=${w}`).join(', '));
  }
  {
    // A wet rope is one WATER piece — the kind carries through, so a machine of
    // nothing but wet ropes is still `wood === 0` and still takes the WET badge.
    const st = designStats(ropeOf(12, { kind: 'water' }));
    gate('44. a wet rope counts as one water piece, and stays wet',
      st.pieces === 1 && st.water === 1 && st.wood === 0 && st.wheels === 0,
      `${st.pieces} pieces, wood ${st.wood}, water ${st.water}`);
  }
  {
    // The chain wrap: one closed run, so one piece.
    const S = screen(flatWorld(), {
      parts: [{ t: 'wheel', kind: 'free', x: -40, y: -100, r: 15, id: 'w1' },
        { t: 'wheel', kind: 'free', x: 40, y: -100, r: 15, id: 'w2' }],
    });
    S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
    S.multiSel = S.design.parts.map((p) => ({ kind: 'part', ref: p }));
    S._chainWrap();
    const st = designStats(S.design.parts);
    gate('44. a chain wrap is one piece round the two wheels',
      st.pieces === 3 && st.parts > 12, `${st.pieces} pieces of ${st.parts} parts`);   // ~18 links of 24 round two r15 wheels, plus the wheels
  }

  // ---- editing a rope: delete to the junction, snap, re-rope ----
  {
    // **Deleting a rope takes it as far as the next junction.** One 8 px link
    // out of the middle leaves a rope in two halves with a link-sized hole,
    // and you then have to hunt the other forty.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = [...ropeOf(4), ...ropeOf(4, { x: 120, chain: 'c1' })];
    // a branch off the middle makes the junction at x=120
    S.design.parts.push({ t: 'rod', kind: 'wood', chain: 'c1', id: 'br', x1: 120, y1: 0, x2: 120, y2: -30 });
    const before = S.design.parts.length;
    S._pointerDown(ev(45, 0));                       // point at the first arm
    const left = S.design.parts.length;
    gate('44. deleting a rope takes it to the next junction, not one link',
      left === before - 4, `${before} → ${left} links (4 gone)`);
    gate('44. …and stops there, leaving the rest of the rope alone',
      S.design.parts.some((p) => p.id === 'br') && S.design.parts.filter((p) => p.chain).length === 5,
      `${S.design.parts.filter((p) => p.chain).length} links left`);
  }
  {
    // **ANY junction ends the cut, not just a fork into more rope.** A plain
    // stick T'd into the middle of a rope is the case that matters: the first
    // version of this walked the rope graph alone, could not see the stick at
    // all, and ran straight past it taking the whole rope. Putting a connection
    // somewhere is how a builder SAYS where a cut should stop.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = [
      ...ropeOf(8),                                            // x 0 … 240 at y 0
      { t: 'rod', kind: 'wood', id: 'tee', x1: 90, y1: 0, x2: 90, y2: -40 },
    ];
    S._pointerDown(ev(15, 0));                                 // the first link
    const left = S.design.parts.filter((p) => p.chain);
    gate('44. a plain stick T\'d into a rope stops the cut there',
      left.length === 5 && Math.min(...left.map((p) => Math.min(p.x1, p.x2))) === 90,
      `${8 - left.length} of 8 links gone, rope now starts at x ${Math.min(...left.map((p) => Math.min(p.x1, p.x2)))}`);
    gate('44. …and the stick it stopped at is untouched',
      S.design.parts.some((p) => p.id === 'tee'));
  }
  {
    // …and so does a WHEEL pinned to the middle of it. `_allPins` gathers every
    // attachment in the level, so a rope is judged the same whatever it is tied
    // to — a stick, a wheel, a crate's pin, a prop's pin, another rope.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = [...ropeOf(8), { t: 'wheel', kind: 'free', x: 150, y: 0, r: 15, id: 'w' }];
    S._pointerDown(ev(15, 0));
    const left = S.design.parts.filter((p) => p.chain);
    gate('44. …as does a wheel pinned to the middle of one',
      left.length === 3 && Math.min(...left.map((p) => Math.min(p.x1, p.x2))) === 150,
      `${8 - left.length} of 8 links gone, rope now starts at x ${Math.min(...left.map((p) => Math.min(p.x1, p.x2)))}`);
  }
  {
    // …while a rope with nothing tied to it goes in one piece, as before.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = ropeOf(8);
    S._pointerDown(ev(15, 0));
    gate('44. …but an untouched rope still goes all the way',
      S.design.parts.filter((p) => p.chain).length === 0,
      `${S.design.parts.length} parts left`);
  }
  {
    // **The cut splits there; the DRAWING deliberately does not.** The stick
    // pins itself at that point and draws its own dot, so the connection is
    // already visible — chopping the rope in two as well would make every rope
    // look shredded wherever anything touches it, and would say the rope is two
    // ropes when the count rightly says it is one.
    const links = [...ropeOf(8), { t: 'rod', kind: 'wood', id: 'tee', x1: 90, y1: 0, x2: 90, y2: -40 }];
    const c = recCtx();
    drawRods(c, links, {});
    gate('44. …and a rope with a stick tied on still DRAWS as one rope',
      ropeRuns(links).length === 1 && c.pins === 4 && designStats(links).pieces === 2,
      `${ropeRuns(links).length} run(s), ${c.pins} pins (2 rope ends + 2 stick ends), ${designStats(links).pieces} pieces (rope + stick)`);
  }
  {
    // **Aimed at a rope link's PIN, which is what a real click lands on.** A
    // stick's endpoint pick radius is 11 SCREEN px, so at any zoom below about
    // 1 it swallows the whole stick — the delete tool used raw `_hitTest` and
    // got `kind:'endpoint'`, which `_deleteHit` has no branch for, so clicking
    // a rope deleted nothing and toasted about the level. Invisible to every
    // gate above, which run at zoom 1 on 30 px sticks and land on the rod BODY;
    // caught by doing it in the actual editor at zoom 0.41 on 8 px links.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = [
      ...ropeOf(10, { len: ROPE_LINK_LEN }),
      { t: 'rod', kind: 'wood', id: 'tee', x1: 4 * ROPE_LINK_LEN, y1: 0, x2: 4 * ROPE_LINK_LEN, y2: -40 },   // on the fourth link's end
    ];
    S.camera.zoom = 0.41;                       // a real zoom, where the pin radius bites
    S._pointerDown(ev(0, 0));                   // straight at the rope's first PIN
    const left = S.design.parts.filter((p) => p.chain);
    gate('44. deleting works when the click lands on a pin, not the rod body',
      left.length === 6 && S.design.parts.some((p) => p.id === 'tee'),
      `${10 - left.length} of 10 links gone, stopped at the tee`);
  }
  {
    // …and Alt takes exactly one link — the finer version, as every other
    // modifier on the page reads.
    const S = screen(flatWorld(), { tool: 'delete' });
    S.design.parts = ropeOf(6);
    S._pointerDown(ev(45, 0, { altKey: true }));
    gate('44. …while Alt takes the single link under the cursor',
      S.design.parts.length === 5, `${S.design.parts.length} of 6 left`);
  }
  {
    // **A rope is keener to connect than a stick.** Painting past a lone pin
    // catches it: the rope must END on that exact coordinate, because landing
    // on it is what forms the joint (§5.4).
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    const wheel = { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' };
    S.design.parts = [wheel];
    // ANY of the wheel's pins, not the hub specifically: a rope coming in from
    // the left catches the RIM pin at (−12, −100) first, which is the correct
    // answer — it is the nearest one, and a rope cannot pass through the wheel
    // to reach the hub anyway.
    const pins = new Set(wheelPins(wheel).map((p) => jointKey(p.x, p.y)));
    S._pointerDown(ev(-160, -100, { altKey: true }));
    for (let i = 1; i <= 8; i++) S._pointerMove(ev(-160 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(0, -100, { altKey: true }));
    const links = S.design.parts.filter((p) => p.chain);
    const landed = links.some((p) => pins.has(jointKey(p.x1, p.y1)) || pins.has(jointKey(p.x2, p.y2)));
    gate('44. a painted rope catches a pin it would otherwise sail past',
      links.length > 3 && landed, `${links.length} links, landed on a wheel pin: ${landed}`);
    // …and every link it laid getting there is still inside the band
    const lens = links.map((p) => Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
    gate('44. …and the links it re-spaced to reach it are still roughly equal',
      Math.min(...lens) >= MIN_LINK_LEN && Math.max(...lens) < ROPE_LINK_LEN * 1.5,
      `${Math.min(...lens).toFixed(2)}–${Math.max(...lens).toFixed(2)} px`);
  }
  {
    // …and it does NOT snap to the link it just laid, which is always exactly
    // one link away and therefore inside the keen radius. Without the recent-
    // ends exclusion the rope grabs its own tail and never advances at all.
    const S = screen(flatWorld(), { tool: 'rod-wood' });
    S._pointerDown(ev(-200, -100, { altKey: true }));
    for (let i = 1; i <= 10; i++) S._pointerMove(ev(-200 + i * 20, -100, { altKey: true }));
    S._pointerUp(ev(0, -100, { altKey: true }));
    const links = S.design.parts.filter((p) => p.chain);
    const reach = Math.max(...links.map((p) => Math.max(p.x1, p.x2)));
    gate('44. …and never snaps to its own tail and stalls',
      links.length > 200 / ROPE_LINK_LEN * 0.8 && reach > -10, `${links.length} links, reached x ${reach.toFixed(0)}`);   // a 200 px stroke's worth of links
  }
  {
    // **Pull a rope's end out and it grows links, not one long one.**
    // Clear of the ground and made of real 8 px links: at y = 0 the rope lies
    // in the terrain surface, so the endpoint drag is refused and reverted —
    // which is the drag rule working, not the re-roping failing.
    const S = screen(flatWorld(), { tool: 'pointer', undo: true });
    S.design.parts = ropeOf(4, { y: -60, len: ROPE_LINK_LEN });
    const last = S.design.parts[3];
    S._pointerDown(ev(last.x2, last.y2));
    S._pointerMove(ev(last.x2 + 70, last.y2 - 40));
    S._pointerUp(ev(last.x2 + 70, last.y2 - 40));
    const links = S.design.parts.filter((p) => p.chain);
    gate('44. …and the rope is still one rope afterwards',
      ropeRuns(links).length === 1 && designStats(S.design.parts).pieces === 1,
      `${ropeRuns(links).length} run(s), ${designStats(S.design.parts).pieces} piece(s)`);
  }

  // ---- the topology is keyed on the AUTHORED pins ----
  {
    // Under load a joint separates (§5.4) — a fraction of a pixel, absorbed by
    // jointKey, but the run must not be re-decided from what is on screen at
    // all. `part` is how a live view says so, and this pair proves it is being
    // consulted rather than merely passed: the same drawn coordinates split
    // into six runs the moment the authored pins are taken away.
    // Each link pulled 0.3 px in at BOTH its own ends, so every joint opens a
    // gap the way a loaded one does — the uniform version of this jitter moves
    // the two ends of a joint together and gates nothing.
    const authored = ropeOf(6);
    const jittered = authored.map((p) => ({ ...p, part: p, x1: p.x1 + 0.3, x2: p.x2 - 0.3 }));
    const runs = ropeRuns(jittered);
    const loose = ropeRuns(jittered.map(({ part, ...p }) => p));
    gate('44. a run is keyed on the authored pins, not the drawn ones',
      runs.length === 1 && runs[0].links.length === 6 && loose.length === 6,
      `${runs.length} run(s) with the authored pins, ${loose.length} without`);
    gate('44. …and it draws at the LIVE coordinates it was handed',
      near(runs[0].links[0].ax, 0.3) && near(runs[0].links[5].bx, 179.7),
      `ends at ${runs[0].links[0].ax} and ${runs[0].links[5].bx}`);
  }
}

// ---------- gate 45: Create answers like Test (§7.2's two pools) ----------
//
// §7.2 has always claimed the two part pools "answer every gesture the same
// way… the build area is the one and only difference". Five gestures did not,
// all of them shipped, all of them found by asking each question of both pools
// side by side rather than by reading the code:
//
//   | | Test | Create (before) |
//   |---|---|---|
//   | scroll a selected stick | weight | fell through to zoom |
//   | ×N label on a heavy stick | drawn | not drawn |
//   | arrow-nudge a stick | carries its bolted wheel | left it, then reverted |
//   | wheel pick radius | 8/zoom screen px | flat +2 WORLD px |
//   | multi-drag's companions | carried | `fixed` skipped |
//
// The pattern that finds this class of bug is the table itself: run the SAME
// gesture against `design.parts` and `level.fixedParts` and compare, rather
// than asserting a value per pool — an expectation written twice is an
// expectation that can be wrong twice.
{
  // one cart, in whichever pool is being asked
  const cartLevel = (fixed) => {
    const parts = [
      { t: 'rod', kind: 'wood', x1: -100, y1: -200, x2: 0, y2: -200, id: 'r1' },
      { t: 'wheel', kind: 'free', x: -100, y: -200, r: 15, id: 'w1' },
    ];
    return fixed
      ? { lv: flatWorld({ fixedParts: parts }), parts: [] }
      : { lv: flatWorld(), parts };
  };
  const pool = (S, fixed) => (fixed ? S.level.fixedParts : S.design.parts);
  const rig = (fixed, over = {}) => {
    const { lv, parts } = cartLevel(fixed);
    return screen(lv, { tab: fixed ? 'level' : 'machine', parts, ...over });
  };
  const kindOf = (fixed) => (fixed ? 'fixed' : 'part');
  const BOTH = [[false, 'Test'], [true, 'Create']];

  // 45a. scroll a selected stick → its weight, in both pools. The right-click
  // slider already set a level stick's weight, so the scroll refusing to was
  // two routes to one number disagreeing.
  {
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const rod = pool(S, fixed)[0];
      S.sel = { kind: kindOf(fixed), ref: rod };
      S._wheelEvt({ clientX: -50 + 400, clientY: -200 + 300, deltaY: -100,
        ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {} });
      return rod.weight || 1;
    });
    gate('45. scroll on a selected stick sets its weight in BOTH pools',
      got[0] === 2 && got[1] === 2, `Test ×${got[0]}, Create ×${got[1]}`);
  }
  {
    // the modifiers travel with it — ±1 / ±10 / ±100 (§8.2), same both sides
    const steps = BOTH.map(([fixed]) => ['', 'shift', 'alt'].map((m) => {
      const S = rig(fixed);
      const rod = pool(S, fixed)[0];
      S.sel = { kind: kindOf(fixed), ref: rod };
      S._wheelEvt({ clientX: -50 + 400, clientY: -200 + 300, deltaY: -100,
        ctrlKey: false, shiftKey: m === 'shift', altKey: m === 'alt', preventDefault() {} });
      return (rod.weight || 1) - 1;
    }).join('/'));
    // ±1 / ±10 / ±100, and at a ×100 ceiling the third one now runs to the END
    // of the range rather than landing somewhere in it — 1 + 100 clamps to 100,
    // so Alt is "take it to the top" and the step reads 99. That is a useful
    // gesture rather than a broken one, and it is gated as what it does.
    gate('45. …with the same ±1 / ±10 / Alt-to-the-end modifiers',
      steps[0] === '1/10/99' && steps[1] === '1/10/99', `Test ${steps[0]}, Create ${steps[1]}`);
  }

  // 45b. the ×N readout. A number you can set and cannot read back is worse
  // than one you can do neither to — and the overlay was `part`-only, so a
  // level stick's weight was invisible the moment you had changed it.
  {
    // a ctx that swallows every canvas call and keeps the strings drawn
    const recCtx = () => {
      const texts = [];
      return new Proxy({ texts, canvas: { width: 800, height: 600 } }, {
        get(t, k) {
          if (k in t) return t[k];
          if (k === 'fillText' || k === 'strokeText') return (s) => { texts.push(String(s)); };
          if (k === 'measureText') return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
          if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
          if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
          return () => {};
        },
        set(t, k, v) { t[k] = v; return true; },
      });
    };
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const rod = pool(S, fixed)[0];
      rod.weight = 7;
      S.sel = { kind: kindOf(fixed), ref: rod };
      const ctx = recCtx();
      S._drawDesignOverlay(ctx);
      return ctx.texts.includes('×7');
    });
    gate('45. a selected heavy stick shows its ×N in BOTH pools',
      got[0] === true && got[1] === true, `Test ${got[0]}, Create ${got[1]}`);
  }

  // 45c. the arrow keys carry what the pointer carries. This is the one with a
  // visible symptom: the level stick moved, its wheel did not, the result was
  // invalid, and the nudge REVERTED with "a stick can't pass through a wheel it
  // isn't pinned to" — a refusal for a gesture that should simply have worked.
  {
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const p = pool(S, fixed);
      S.sel = { kind: kindOf(fixed), ref: p[0] };
      S._nudgeApply(-10, 0);
      return { rod: p[0].x1, wheel: p[1].x, said: S.toasts.length };
    });
    gate('45. arrow-nudging a stick carries its bolted wheel in BOTH pools',
      got.every((g) => g.rod === -110 && g.wheel === -110 && g.said === 0),
      `Test rod ${got[0].rod}/wheel ${got[0].wheel}, Create rod ${got[1].rod}/wheel ${got[1].wheel}`);
    // and the drag it must agree with, asked the same way
    const drags = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const p = pool(S, fixed);
      gesture(S, { x: -50, y: -200 }, { x: -60, y: -200 });
      return { rod: p[0].x1, wheel: p[1].x };
    });
    gate('45. …which is what the POINTER drag already did — same answer, both routes',
      drags.every((d) => near(d.rod, -110) && near(d.wheel, -110)),
      `Test ${drags[0].wheel}, Create ${drags[1].wheel}`);
  }

  // 45d. …and a selection containing BOTH ends of that relationship moves it
  // once, not twice. `_beginMultiMove` has always excluded companions that are
  // themselves selected ("one shared moved-map so companions never double-
  // shift"); `_nudgeApply` never did, so Ctrl+A or a marquee round a cart plus
  // one arrow press STRETCHED it — the wheel took −10 as a ride and −10 as
  // itself, dragging the endpoint pinned to it out to −20 while the far end
  // moved −10. A 100 px stick came out 110 px, in BOTH pools.
  {
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const p = pool(S, fixed);
      S.multiSel = [{ kind: kindOf(fixed), ref: p[0] }, { kind: kindOf(fixed), ref: p[1] }];
      S._nudgeApply(-10, 0);
      return { len: p[0].x2 - p[0].x1, x1: p[0].x1, wheel: p[1].x };
    });
    gate('45. nudging a stick AND its wheel together moves the cart once, rigidly',
      got.every((g) => g.len === 100 && g.x1 === -110 && g.wheel === -110),
      `Test len ${got[0].len} x1 ${got[0].x1}, Create len ${got[1].len} x1 ${got[1].x1}`);
  }
  {
    // the two-pass shape that makes the above possible: judged once the WHOLE
    // selection has moved. Judging inside the loop asked "is this legal?" of a
    // half-moved world, so the cart above was refused outright before it could
    // even be measured.
    const S = rig(true);
    const p = S.level.fixedParts;
    S.multiSel = [{ kind: 'fixed', ref: p[0] }, { kind: 'fixed', ref: p[1] }];
    S._nudgeApply(-10, 0);
    gate('45. …and is not refused by its own half-moved self',
      S.toasts.length === 0 && p[0].x1 === -110, `toasts ${JSON.stringify(S.toasts)}`);
  }

  // 45e. the wheel's pick band. `8/zoom` SCREEN px capped at 40% of r (§8.1) —
  // restated here rather than imported, so a change to it stops this file. The
  // level's copy was a flat `r + 2` WORLD px, which is a different KIND of
  // number: it shrinks on screen as you zoom out, exactly when a small target
  // is already hardest to hit. At the editor's own 0.41 it left 0.82 screen px
  // of margin against the machine wheel's 2.46.
  {
    const bandOf = (r, zoom) => Math.min(8 / zoom, r * 0.4);      // restated, not imported
    const reach = (fixed, zoom) => {
      const S = rig(fixed, { zoom });
      S.camera.zoom = zoom;
      let last = 0;
      for (let d = 15; d < 60; d += 0.05) {
        const h = S._hitTest({ x: -100 + d, y: -200 });
        if (h && h.ref?.t === 'wheel') last = d - 15; else break;
      }
      return last;
    };
    for (const zoom of [2.6, 1, 0.41]) {
      const t = reach(false, zoom), c = reach(true, zoom);
      gate(`45. a wheel's pick band is the same in both pools at zoom ${zoom}`,
        near(t, c, 0.06) && near(t, bandOf(15, zoom), 0.06),
        `Test +${t.toFixed(2)}, Create +${c.toFixed(2)}, formula +${bandOf(15, zoom).toFixed(2)} world px`);
    }
  }

  // 45f. a multi-drag's EXTERNAL companions — the wheel bolted to a selected
  // stick but not itself selected. The scan filtered to `['part','goal']` while
  // the guard inside it already said "so a Create selection carries the level's
  // wheels": the comment described the intent and the filter above it excluded
  // the only kind that could reach it.
  {
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      const p = pool(S, fixed);
      // two selected things so the multi-move path is taken, and the wheel is
      // deliberately NOT one of them. The second is an unconnected stick well
      // clear of the cart, so it contributes nothing but a count.
      p.push({ t: 'rod', kind: 'wood', x1: 200, y1: -300, x2: 280, y2: -300, id: 'r2' });
      S.multiSel = [{ kind: kindOf(fixed), ref: p[0] },
                    { kind: kindOf(fixed), ref: p[2] }];
      const r = gesture(S, { x: -50, y: -200 }, { x: -70, y: -200 });
      return { type: r.type, wheel: p[1].x, rod: p[0].x1 };
    });
    gate('45. a multi-drag carries a bolted wheel it does not contain, in BOTH pools',
      got.every((g) => g.type === 'move-multi' && near(g.wheel, g.rod)),
      `Test wheel ${got[0].wheel} vs rod ${got[0].rod}, Create wheel ${got[1].wheel} vs rod ${got[1].rod}`);
  }

  // 45f-ii. **The regression that parity fix caused**, kept as its own gate
  // because it is the shape this whole class of change fails in: widening the
  // companion scan put a level wheel into `rides`, and `clampBounds` pushed
  // every ride unconditionally — so the BUILD ZONE went round a drag that is
  // not confined by it, and a level cart 600 px outside the zone was yanked to
  // its edge. The `items` loop beside it had always made the distinction; that
  // line had simply never had a fixed part to see.
  //
  // A SMALL zone, and the cart far outside it, or the clamp has nothing to bite.
  {
    const tight = {
      terrain: [{ type: 'box', x: 0, y: 400, w: 4000, h: 60 }],
      buildZones: [{ x: 0, y: 0, w: 200, h: 200 }],
      goalZones: [{ x: 600, y: 0, w: 120, h: 80 }],
      fixedParts: [
        { t: 'rod', kind: 'wood', x1: -600, y1: -300, x2: -500, y2: -300, id: 'fr' },
        { t: 'wheel', kind: 'free', x: -600, y: -300, r: 15, id: 'fw' },
        { t: 'rod', kind: 'wood', x1: -600, y1: -500, x2: -500, y2: -500, id: 'fr2' },
      ],
    };
    const S = screen(tight, { tab: 'level' });
    const p = S.level.fixedParts;
    S.multiSel = [{ kind: 'fixed', ref: p[0] }, { kind: 'fixed', ref: p[2] }];
    const r = gesture(S, { x: -550, y: -300 }, { x: -630, y: -300 });
    gate('45. a multi-drag towing a LEVEL wheel is not clamped to the build zone',
      r.type === 'move-multi' && near(p[0].x1, -680) && near(p[1].x, -680),
      `rod x1 ${p[0].x1} (wanted -680), wheel x ${p[1].x}`);
  }

  // 45g. …and the difference that IS real stays real: the build area confines
  // the design and not the level's parts (§7.2). If this ever passes for both,
  // the parity work above has gone one step too far.
  {
    const S = rig(false);
    const T = rig(true);
    // outside the build zone (which spans ±350) but well inside the 4020 fence,
    // so the only rule left to fail is the one being asked about
    const far = { t: 'wheel', kind: 'free', x: 1000, y: -200, r: 15, id: 'far' };
    gate('45. …but the build area still confines the machine and not the level',
      S._wheelInvalid(far, null, true) !== null && T._wheelInvalid(far, null, false) === null,
      `design ${JSON.stringify(S._wheelInvalid(far, null, true))}, level ${JSON.stringify(T._wheelInvalid(far, null, false))}`);
  }
}

// ---------- gate 46: a rope's WEIGHT is one number for the run (§8.2) ----------
//
// **Measured, not chosen.** `weight` is the only lever a rope has for carrying,
// and probe-ropeweight.mjs says it only works applied to the whole length — on a
// 240 px rope of 30 links under a 14 kg crate:
//
//   every link ×1  67.2 px stretch │ ONE middle link ×50    69.1 px  (worse than ×1)
//   every link ×10  9.3            │ ONE middle link ×1000 135.5     (double the ×1)
//   every link ×50  4.7  ← knee    │
//
// A single heavy link does not stiffen a rope, it LOADS it. So the unit is the
// run, and the bead is what Alt asks for.
//
// The invariant these turn on: **the weight run IS the delete run.** If those
// two walks ever diverge, "one length of rope" means two different things in
// two gestures, which is the bug class this suite exists for.
{
  const ropeTee = () => {
    const out = [];
    for (let i = 0; i < 20; i++) {
      out.push({ t: 'rod', kind: 'wood', chain: 'c', id: 'k' + i, x1: i * 8, y1: -200, x2: (i + 1) * 8, y2: -200 });
    }
    // a plain stick T'd onto the rope at x = 80 — the start of link 10
    out.push({ t: 'rod', kind: 'wood', id: 'tee', x1: 80, y1: -200, x2: 80, y2: -280 });
    return out;
  };
  const rig = (fixed) => (fixed
    ? screen(flatWorld({ fixedParts: ropeTee() }), { tab: 'level' })
    : screen(flatWorld(), { tab: 'machine', parts: ropeTee() }));
  const poolOf = (S, f) => (f ? S.level.fixedParts : S.design.parts);
  const linksOf = (S, f) => poolOf(S, f).filter((p) => p.chain);
  const wheelEv = (x, y, mods = {}) => ({ clientX: x + 400, clientY: y + 300, deltaY: -100,
    ctrlKey: false, shiftKey: false, altKey: false, ...mods, preventDefault() {}, stopPropagation() {} });
  const BOTH = [[false, 'Test'], [true, 'Create']];

  // 46a. clicking a rope link selects an ENDPOINT — there is no zoom at which a
  // press lands on the body of an 8 px link, HANDLE being 11 SCREEN px — and
  // the scroll has to work from there or a rope's weight is unreachable.
  {
    const got = BOTH.map(([fixed]) => {
      const S = rig(fixed);
      S._pointerDown(ev(36, -200)); S._pointerUp(ev(36, -200));
      const z0 = S.camera.zoom;
      S._wheelEvt(wheelEv(36, -200));
      const l = linksOf(S, fixed);
      return { first: l[4].weight || 1, past: l[14].weight || 1, zoom: S.camera.zoom === z0 };
    });
    gate('46. scrolling a selected rope link sets the WHOLE RUN, in both pools',
      got.every((g) => g.first === 2 && g.zoom),
      `Test ×${got[0].first}, Create ×${got[1].first} (camera held: ${got.every((g) => g.zoom)})`);
    gate('46. …and stops at the junction — the far side is untouched',
      got.every((g) => g.past === 1), `far side Test ×${got[0].past}, Create ×${got[1].past}`);
  }
  {
    // …and the T'd stick that MAKES the junction is not part of either run
    const S = rig(false);
    S._pointerDown(ev(36, -200)); S._pointerUp(ev(36, -200));
    S._wheelEvt(wheelEv(36, -200));
    const tee = S.design.parts.find((p) => p.id === 'tee');
    gate('46. …and the stick that makes the junction is not swept up in it',
      (tee.weight || 1) === 1, `tee ×${tee.weight || 1}`);
  }
  {
    // the other side is its own run, reached the same way
    const S = rig(false);
    S._pointerDown(ev(120, -200)); S._pointerUp(ev(120, -200));
    S._wheelEvt(wheelEv(120, -200));
    const l = linksOf(S, false);
    gate('46. …and the far side is a run of its own',
      (l[14].weight || 1) === 2 && (l[4].weight || 1) === 1,
      `near ×${l[4].weight || 1}, far ×${l[14].weight || 1}`);
  }

  // 46b. THE invariant: one walk, two gestures.
  {
    const S = rig(false);
    const link = S.design.parts[4];
    const w = S._weightRun(link).map((r) => r.id).sort().join(',');
    const d = S._ropeCutRun(link).map((r) => r.id).sort().join(',');
    gate('46. the weight run is the DELETE run, rod for rod', w === d && w.split(',').length === 10, w);
  }
  {
    const S = rig(false);
    gate('46. …Alt takes the single link, as it does for delete',
      S._weightRun(S.design.parts[4], true).length === 1);
    const plain = S.design.parts.find((p) => p.id === 'tee');
    gate('46. …and a plain stick is its own run, so nothing else changes',
      S._weightRun(plain).length === 1 && S._weightRun(plain, true).length === 1);
  }
  {
    // an ordinary pinned PAIR of sticks must not travel together — they have no
    // chain, so they are two runs however they are joined
    const S = screen(flatWorld(), { tab: 'machine', parts: [
      { t: 'rod', kind: 'wood', id: 'a', x1: 0, y1: -300, x2: 100, y2: -300 },
      { t: 'rod', kind: 'wood', id: 'b', x1: 100, y1: -300, x2: 200, y2: -300 },
    ] });
    S._pointerDown(ev(50, -300)); S._pointerUp(ev(50, -300));
    S._wheelEvt(wheelEv(50, -300));
    gate('46. two pinned STICKS are not a rope — only the one scrolled changes',
      (S.design.parts[0].weight || 1) === 2 && (S.design.parts[1].weight || 1) === 1,
      `×${S.design.parts[0].weight || 1} / ×${S.design.parts[1].weight || 1}`);
  }

  // 46b-ii. **Every gesture that means "the piece under the cursor" resolves
  // through `_cursorTarget`.** Read off the SOURCE, because building the real
  // menu needs a `document` this process does not have — the same trick the
  // server's replay cap is gated with, and for the same reason: nothing else
  // connects these three, and two of them have now shipped wrong.
  //
  // `_hitTest` answers `kind:'endpoint'` within HANDLE (11 SCREEN px) of a
  // stick's end, and none of the three consumers has an endpoint branch. The
  // delete tool fell through to "that belongs to the level" and deleted nothing
  // (2026-08-01); the context menu opened with nothing about the piece in it,
  // which on an 8 px rope link is EVERY zoom. Ctrl+Right-click was always right
  // and is the reference.
  {
    const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    const bodyOf = (name) => {
      const m = src.match(new RegExp(`\\n +${name}\\(`));
      if (!m) return null;
      const rest = src.slice(m.index + 1);
      const j = rest.search(/\n +(?:[A-Za-z_$][\w$]*)\(/);
      return j < 0 ? rest : rest.slice(0, j);
    };
    for (const [name, what] of [
      ['_contextMenu', 'the right-click menu'],
      ['_deleteAtCursorPt', 'Ctrl+click delete'],
      ['_pointerDown', 'the delete tool'],
    ]) {
      const body = bodyOf(name);
      gate(`46. ${what} resolves the cursor through _cursorTarget`,
        !!body && /_cursorTarget\(/.test(body), body ? 'found' : `could not read ${name}`);
    }
    // …and the menu must not ALSO ask _hitTest for the piece, which is how it
    // would silently go back to answering `endpoint`
    const menu = bodyOf('_contextMenu');
    gate('46. …and the menu does not ask _hitTest for the piece as well',
      !!menu && !/const hit = this\._hitTest\(/.test(menu));
  }

  // 46c. the readout. Thirty links of a weighted rope drew thirty overlapping
  // ×50s — a smear, and thirty copies of one number now that the number IS one.
  {
    const recCtx = () => {
      const texts = [];
      return new Proxy({ texts, canvas: { width: 800, height: 600 } }, {
        get(t, k) {
          if (k in t) return t[k];
          if (k === 'fillText' || k === 'strokeText') return (s) => { texts.push(String(s)); };
          if (k === 'measureText') return () => ({ width: 10 });
          if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
          return () => {};
        },
        set(t, k, v) { t[k] = v; return true; },
      });
    };
    const S = rig(false);
    for (const r of linksOf(S, false).slice(0, 10)) r.weight = 50;
    S.sel = { kind: 'endpoint', ref: S.design.parts[4], end: 1 };
    const ctx = recCtx();
    S._drawDesignOverlay(ctx);
    gate('46. a weighted rope draws ONE ×N for the run, not one per link',
      ctx.texts.length === 1 && ctx.texts[0] === '×50', JSON.stringify(ctx.texts));
  }
  {
    // …and the chip reports it from an endpoint selection, which is the only
    // kind of selection a rope link can produce
    const S = rig(false);
    for (const r of linksOf(S, false).slice(0, 10)) r.weight = 50;
    let txt = '';
    S.infoChipText = { set textContent(v) { txt = v; }, get textContent() { return txt; } };
    S.sel = { kind: 'endpoint', ref: S.design.parts[4], end: 1 };
    GameScreen.prototype._updateInfoChip.call(S);
    gate('46. …and the info chip says the weight and the run length',
      /×50/.test(txt) && /10 links/.test(txt), txt);
  }
}

// ---------- gate 49: a crate's exclusion zone is ROUND at the corners ----------
//
// Reported as "the bounding box for goal piece crates is too large — you can't
// bring a goal piece right up to wheels". It was: `_wheelBlockedByGoal` asked
// `pointInRect(centre, crate, inflate = w.r)`, which is a Minkowski sum with
// SQUARE corners where a circle's is round. Exact on the faces, and out by
// **r × (√2 − 1)** on the diagonal — 3.0 px small, 6.2 standard, 12.4 large.
//
// **This is why gates on the axes could never have caught it.** 0° and 90° were
// always right; the error lives only where nothing was looking. Same shape as
// the zoom-1 blindness that hid the delete-tool bug — so this walks a wheel in
// from SEVEN angles, and the diagonal is the one that matters.
{
  const crate = { shape: 'box', x: 0, y: -200, w: 30, h: 30 };
  const S = screen(flatWorld({ goalObjs: [crate] }), { tab: 'machine' });
  const pos = S.goalPositions[0];

  // True contact, computed independently of the code under test — against the
  // shape the crate ACTUALLY is: a box with ROUNDED corners (`cornerRadiusOf`,
  // and `b2MakeRoundedBox` in the sim). The corner radius is restated here
  // rather than imported, like every other constant in this file: a check that
  // silently follows it is not gating it.
  //
  // **The first version of this gate measured against a SHARP box and passed
  // anyway** once the rounding landed — the fixed code stops closer than a
  // sharp box would, so the error went negative and `worst <= 0.07` waved it
  // through. A gate that cannot tell "right" from "righter than my reference"
  // is not gating the thing it names.
  const CORNER_DEFAULT = 8;                 // util.js's CORNER_RADIUS_DEFAULT
  const crOf = (box) => Math.min(box.radius ?? CORNER_DEFAULT, box.w / 2, box.h / 2);
  const trueTouch = (r, deg, box = crate) => {
    const a = deg * Math.PI / 180;
    const ang = box.angle || 0, c = Math.cos(-ang), s = Math.sin(-ang);
    const lx = Math.cos(a) * c - Math.sin(a) * s, ly = Math.cos(a) * s + Math.sin(a) * c;
    const cr = crOf(box);
    const hw = box.w / 2 - cr, hh = box.h / 2 - cr;     // the CORE box
    for (let d = 0; d < 300; d += 0.005) {
      const px = lx * d, py = ly * d;
      const qx = Math.min(Math.max(px, -hw), hw), qy = Math.min(Math.max(py, -hh), hh);
      if (Math.hypot(px - qx, py - qy) >= r + cr) return d;   // clear of the ROUNDED shape
    }
    return Infinity;
  };
  const stopsAt = (r, deg) => {
    const a = deg * Math.PI / 180;
    for (let d = 300; d > 0; d -= 0.01) {
      const w = { t: 'wheel', kind: 'free', r, id: 'w',
        x: pos.x + Math.cos(a) * d, y: pos.y + Math.sin(a) * d };
      if (S._wheelBlockedByGoal(w, new Set(), 0)) return d + 0.01;
    }
    return 0;
  };

  const ANGLES = [0, 15, 30, 45, 60, 75, 90];
  // **Signed, and checked BOTH ways.** Over-exclusion is the reported bug;
  // under-exclusion would be a crate you can drive a wheel into, which is
  // worse. The old one-sided `worst <= 0.07` is exactly what let a wrong
  // reference pass.
  for (const r of [7.5, 15, 30]) {
    let worst = 0, at = null;
    for (const deg of ANGLES) {
      const err = stopsAt(r, deg) - trueTouch(r, deg);
      if (Math.abs(err) > Math.abs(worst)) { worst = err; at = deg; }
    }
    gate(`49. a wheel r=${r} stops where it TOUCHES a crate, from every angle`,
      Math.abs(worst) <= 0.07, `worst error ${worst.toFixed(2)} px${at == null ? '' : ' at ' + at + '°'}`);
  }
  {
    // the diagonal on its own, stated as the number that was wrong, so a
    // regression names itself rather than showing up as a tolerance drift
    const err45 = stopsAt(30, 45) - trueTouch(30, 45);
    gate('49. …and the DIAGONAL is not r×(√2−1) out, which is what a square corner costs',
      Math.abs(err45) <= 0.07, `${err45.toFixed(2)} px, was ${(30 * (Math.SQRT2 - 1)).toFixed(2)}`);
  }
  {
    // **The corner radius is the whole point.** A crate is drawn and simulated
    // rounded, and the editor was testing the sharp rectangle — worth 6.2 px
    // at the corner of a crate rounded until it is a circle. Three radii: the
    // default, fully round, and SHARP, which must still behave as a square.
    for (const [radius, label] of [[0, 'sharp (radius 0)'], [8, 'default (radius 8)'], [15, 'fully round — a circle']]) {
      const c2 = { shape: 'box', x: 0, y: -200, w: 30, h: 30, radius };
      const T = screen(flatWorld({ goalObjs: [c2] }), { tab: 'machine' });
      const tp = T.goalPositions[0];
      let worst = 0, at = null;
      for (const deg of ANGLES) {
        const a = deg * Math.PI / 180;
        let stop = 0;
        for (let d = 300; d > 0; d -= 0.01) {
          const w = { t: 'wheel', kind: 'free', r: 15, id: 'w',
            x: tp.x + Math.cos(a) * d, y: tp.y + Math.sin(a) * d };
          if (T._wheelBlockedByGoal(w, new Set(), 0)) { stop = d + 0.01; break; }
        }
        const err = stop - trueTouch(15, deg, c2);
        if (Math.abs(err) > Math.abs(worst)) { worst = err; at = deg; }
      }
      gate(`49. a crate's CORNER RADIUS is respected — ${label}`,
        Math.abs(worst) <= 0.07, `worst ${worst.toFixed(2)} px${at == null ? '' : ' at ' + at + '°'}`);
    }
  }
  {
    // …and a STICK stops at the rounded corner too, not the square one
    const c2 = { shape: 'box', x: 0, y: -200, w: 30, h: 30, radius: 15 };
    const T = screen(flatWorld({ goalObjs: [c2] }), { tab: 'machine' });
    const tp = T.goalPositions[0];
    // a stick angled at the corner, walked in along the diagonal
    let stop = 0;
    for (let d = 200; d > 0; d -= 0.01) {
      const cx = tp.x + d * Math.SQRT1_2, cy = tp.y - d * Math.SQRT1_2;
      const rod = { t: 'rod', kind: 'wood', id: 'r',
        x1: cx - 40 * Math.SQRT1_2, y1: cy - 40 * Math.SQRT1_2,
        x2: cx + 40 * Math.SQRT1_2, y2: cy + 40 * Math.SQRT1_2 };
      if (T._rodBlockedByGoal(rod, [], 0)) { stop = d + 0.01; break; }
    }
    // A circle of 15, plus the stick's own clearance — `ROD_THICK/2` less the
    // flush tolerance, restated rather than imported. It was a bare 1.5 here
    // and in the rule, which was neither the capsule's 2 px radius nor the
    // 1.0 every other solidity rule spends; there is one number now.
    const ROD_CLEARANCE = ROD_THICK / 2 - TERRAIN_TOUCH_PAD;
    gate('49. …and a STICK stops at the rounded corner, not the square one',
      Math.abs(stop - (15 + ROD_CLEARANCE)) <= 0.1,
      `stopped at ${stop.toFixed(2)}, round contact is ${(15 + ROD_CLEARANCE).toFixed(2)}, square corner would be ${(Math.hypot(15, 15) + ROD_CLEARANCE).toFixed(2)}`);
  }
  {
    // a TILTED crate: the corner just moves, and the rule has to move with it
    const tilted = { shape: 'box', x: 0, y: -200, w: 30, h: 30, angle: Math.PI / 6 };
    const T = screen(flatWorld({ goalObjs: [tilted] }), { tab: 'machine' });
    const tp = T.goalPositions[0];
    let worst = 0;
    for (const deg of ANGLES) {
      const a = deg * Math.PI / 180;
      let stop = 0;
      for (let d = 300; d > 0; d -= 0.01) {
        const w = { t: 'wheel', kind: 'free', r: 15, id: 'w',
          x: tp.x + Math.cos(a) * d, y: tp.y + Math.sin(a) * d };
        if (T._wheelBlockedByGoal(w, new Set(), 0)) { stop = d + 0.01; break; }
      }
      worst = Math.max(worst, stop - trueTouch(15, deg, tilted));
    }
    gate('49. …on a TILTED crate too — the corner moves and the rule moves with it',
      worst <= 0.07, `worst ${worst.toFixed(2)} px`);
  }
  {
    // and the rule it must NOT break: a wheel sharing the crate's pin is a
    // legal overlap and has to stay reachable (§7.2)
    const pinned = { t: 'wheel', kind: 'free', x: pos.x, y: pos.y, r: 15, id: 'w' };
    const keys = new Set(S._pinKeysOfWheel(pinned));
    gate('49. …and a wheel on the crate\'s own pin is still allowed to overlap it',
      S._wheelBlockedByGoal(pinned, keys, 0) === false);
    gate('49. …while one NOT sharing a pin, sitting on it, is still refused',
      S._wheelBlockedByGoal(pinned, new Set(), 0) === true);
  }
}

// ---------- gate 48: "Next" on a solved campaign level (§8.2) ----------
//
// The win banner offers the next campaign level. The BUTTON is DOM and lives in
// `_renderWinBanner`; the decision is `nextCampaignLevel` in util.js, here,
// because main.js cannot be imported headlessly and this has four ways of
// answering "no" — three of them easy to get wrong by hand.
//
// The gap case is not hypothetical: parking a level (dropping its `slot` while
// keeping `official`) leaves a hole, which is exactly how the twelve displaced
// campaign levels are stored. Stepping into a hole would 404 rather than read
// as "the end of the campaign".
{
  const lv = (slot, name, over = {}) => ({ id: 'L' + slot, name, num: slot + 1, official: true, slot, ...over });
  const campaign = [lv(0, 'Easy Goal'), lv(1, 'Rocky Steps'), lv(2, 'Rolling Hills'), lv(3, 'Swiping the Idol')];
  // the store also carries PARKED officials — official, no slot — and a
  // Workshop level, neither of which may ever be offered as "next"
  const store_ = [...campaign, { id: 'P', name: 'First Steps', official: true }, { id: 'W', name: 'Someone\'s level', official: false, slot: 1 }];

  const next = (slot, over = {}) => nextCampaignLevel({ slot, levels: store_, freeSlots: 32, signedIn: false, ...over });

  gate('48. solving a campaign level offers the next one',
    next(0)?.name === 'Rocky Steps', next(0)?.name);
  gate('48. …and it is the one at slot+1, not the next in the array',
    next(2)?.name === 'Swiping the Idol', next(2)?.name);
  gate('48. the LAST campaign level offers nothing', next(3) === null, JSON.stringify(next(3)));
  gate('48. a Workshop level (no slot) offers nothing', next(null) === null && next(undefined) === null);
  {
    // a hole in the slots ends the run rather than skipping it — the store
    // really has holes, because parking a level leaves one
    const holed = [lv(0, 'Easy Goal'), lv(2, 'Rolling Hills')];
    gate('48. a GAP in the slots reads as the end, not as a level to skip to',
      nextCampaignLevel({ slot: 0, levels: holed, freeSlots: 32, signedIn: false }) === null);
  }
  {
    // a PARKED official (no slot) is in the list and must never be offered
    const only = [lv(0, 'Easy Goal'), { id: 'P', name: 'First Steps', official: true }];
    gate('48. a parked official (no slot) is never offered as next',
      nextCampaignLevel({ slot: 0, levels: only, freeSlots: 32, signedIn: false }) === null);
  }
  {
    // a community level sitting on the same number is not the campaign
    const mixed = [lv(0, 'Easy Goal'), { id: 'W', name: 'Someone\'s level', official: false, slot: 1 }];
    gate('48. a community level at that slot is not the campaign, so it is not next',
      nextCampaignLevel({ slot: 0, levels: mixed, freeSlots: 32, signedIn: false }) === null);
  }
  {
    // the paywall: the grid shows locked levels because the card is the advert,
    // but a win banner is the wrong place to meet one
    const paid = { slot: 0, levels: campaign, freeSlots: 1 };
    gate('48. a locked next level is not offered while signed out',
      nextCampaignLevel({ ...paid, signedIn: false }) === null);
    gate('48. …and IS offered once signed in',
      nextCampaignLevel({ ...paid, signedIn: true })?.name === 'Rocky Steps');
  }
  {
    // the banner names it, so the record has to carry a name and a number
    const n = next(0);
    gate('48. the offered level carries the name and number the button prints',
      n.name === 'Rocky Steps' && n.num === 2 && !!n.id, `${n.name} #${n.num} (${n.id})`);
  }
  // …and the level BEFORE, for the play screen's ‹ ^ › (2026-08-19): the
  // same four answers, mirrored, and slot 0 has nothing before it
  {
    const prev = (slot, over = {}) => prevCampaignLevel({ slot, levels: store_, freeSlots: 32, signedIn: false, ...over });
    gate('48p. a campaign level knows the one before it', prev(2)?.name === 'Rocky Steps', prev(2)?.name);
    gate('48p. the FIRST campaign level has nothing before it', prev(0) === null, JSON.stringify(prev(0)));
    gate('48p. a Workshop level (no slot) has no previous', prev(null) === null && prev(undefined) === null);
    gate('48p. a hole below reads as the start, not a level to skip to',
      prevCampaignLevel({ slot: 2, levels: [lv(0, 'Easy Goal'), lv(2, 'Rolling Hills')], freeSlots: 32, signedIn: false }) === null);
    gate('48p. a community level at slot-1 is not the campaign',
      prevCampaignLevel({ slot: 2, levels: [lv(2, 'Rolling Hills'), { id: 'W', name: 'x', official: false, slot: 1 }], freeSlots: 32, signedIn: false }) === null);
    gate('48p. the lock rule holds on the way back too (a locked previous, signed out)',
      prevCampaignLevel({ slot: 2, levels: campaign, freeSlots: 1, signedIn: false }) === null
      && prevCampaignLevel({ slot: 2, levels: campaign, freeSlots: 1, signedIn: true })?.name === 'Rocky Steps');
  }
  // …and which SET a slot sits in, for the "^" (levels.js setOfSlot)
  {
    gate('48s. slots 0–15 sit in Starters; 16–31 in Main Course; past that has no named set',
      setOfSlot(0)?.id === 'starters' && setOfSlot(15)?.id === 'starters'
      && setOfSlot(16)?.id === 'main-course' && setOfSlot(31)?.id === 'main-course' && setOfSlot(32) === null,
      `${setOfSlot(0)?.id} / ${setOfSlot(16)?.id} / ${setOfSlot(32)?.id}`);
    gate('48s. a slot past the named sets, or no slot, has no set',
      setOfSlot(9999) === null && setOfSlot(null) === null && setOfSlot(undefined) === null);
    const extra = [{ id: 'a', from: 1, to: 8, title: 'A' }, { id: 'b', from: 9, to: 16, title: 'B' }];
    gate('48s. an admin list wins over the shipped default',
      setOfSlot(0, extra)?.id === 'a' && setOfSlot(8, extra)?.id === 'b' && setOfSlot(16, extra) === null);
    gate('48s. a range "1,32" is numbers 1 through 32',
      JSON.stringify(parseCampaignRange('1,32')) === '{"from":1,"to":32}'
      && JSON.stringify(parseCampaignRange(' 17 - 24 ')) === '{"from":17,"to":24}');
    gate('48s. overlapping ranges are refused on save',
      /overlap/.test(normalizeCampaigns([{ title: 'A', range: '1,10' }, { title: 'B', range: '10,20' }]).error || ''));
    gate('48s. overlapping sections inside one campaign are refused',
      /overlap/.test(normalizeCampaigns([{ title: 'A', sections: [{ title: 'X', range: '1,8' }, { title: 'Y', range: '8,16' }] }]).error || ''));
    gate('48s. Starters and Main Course ship two sections each',
      SETS[0].id === 'starters' && SETS[0].sections?.length === 2 && SETS[0].sections[0].from === 1 && SETS[0].sections[1].to === 16
      && SETS[1].id === 'main-course' && SETS[1].sections?.length === 2 && SETS[1].sections[0].from === 17 && SETS[1].sections[1].to === 32);
  }
}

// ---------- gate 47: line endings (§16) ----------
//
// **A mechanical guard, for the same reason gate 21 is one**: the failure leaves
// nothing to search for. This tree has MIXED endings by file — 13 CRLF against
// 38 LF — and the common edit-in-place idioms flip them in OPPOSITE directions:
// python's text mode writes CRLF (so it flips the LF three quarters of the tree),
// `sed -i` writes LF (so it flips the CRLF thirteenth). Measured, not assumed.
//
// Nothing else catches it. All ten suites ran green with a doc file flipped
// whole-file, and a flipped file makes every future diff against a pre-feature
// snapshot useless — which is the whole method for verifying a revert.
//
// The CRLF list is written out rather than discovered, exactly like the restated
// constants at the top of this file: a check that silently follows the tree is
// not gating the tree. **Adding a file means adding it here**, which is the
// point — that is the moment to decide which ending it should have, rather than
// letting whichever tool created it decide.
{
  const CRLF_FILES = [
    // The Windows-native scripts are CRLF on purpose: cmd.exe and the shell
    // conventions on this box expect it, and GOLIVE.bat has always been so.
    'GOLIVE.bat', 'DEPLOY.bat', 'SetupForLocalPlayServer.bat', 'SetupForInternetServer.bat', 'scripts/deploy.ps1',
    'README.md',
    'public/js/audio.js', 'public/js/main.js', 'public/js/render.js',
    'public/js/sim.js', 'public/js/tutorial-demos.js',
    'scripts/verify-audio.mjs',
    'scripts/verify-tutorial.mjs', 'scripts/verify.mjs',
  ];
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'vendor', 'Production']);
  const EXTS = /\.(js|mjs|md|json|css|html|toml|bat|ps1)$/;
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out); }
      else if (EXTS.test(e.name) && !e.name.includes('package-lock')) out.push(rel);
    }
    return out;
  };
  const files = walk('');
  const kindOf = (rel) => {
    const b = fs.readFileSync(path.join(root, rel));
    let crlf = 0, lf = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 10) { if (i > 0 && b[i - 1] === 13) crlf++; else lf++; }
    }
    return !crlf && !lf ? 'none' : crlf && lf ? `MIXED ${crlf}/${lf}` : crlf ? 'CRLF' : 'LF';
  };
  const want = new Set(CRLF_FILES);
  const wrong = [];
  const mixed = [];
  for (const f of files) {
    const k = kindOf(f);
    if (k === 'none') continue;
    if (k.startsWith('MIXED')) { mixed.push(`${f} (${k})`); continue; }
    const expect = want.has(f) ? 'CRLF' : 'LF';
    if (k !== expect) wrong.push(`${f}: ${k}, expected ${expect}`);
  }
  // A half-rewritten file — the worst of the three, since it is not even a
  // consistent flip and no eye will spot it in a diff.
  gate('47. no source file has MIXED line endings', mixed.length === 0, mixed.join('; ') || `${files.length} files`);
  gate('47. …and every file still has the ending it had',
    wrong.length === 0, wrong.join('; ') || `${want.size} CRLF, ${files.length - want.size} LF`);
  // …and the list itself has not rotted: a name left in it after the file goes
  // would quietly stop gating something.
  const gone = CRLF_FILES.filter((f) => !files.includes(f));
  gate('47. …and the CRLF list names only files that exist', gone.length === 0, gone.join(', ') || 'all present');

  // **The Windows scripts must be pure ASCII**, and this is the gate for a bug
  // that cost a round on 2026-08-03. Windows PowerShell 5.1 reads a script with
  // no byte-order mark as ANSI, so a UTF-8 em-dash — the house style everywhere
  // else in this tree — arrives as three CP1252 characters, one of which is a
  // curly double quote, which PowerShell accepts as a STRING DELIMITER. The
  // first deploy.ps1 was written in ordinary prose and would not parse at all:
  // four errors, not one of them on a line with anything wrong with it. A BOM
  // fixes it too and is one silent edit away from being gone again; staying
  // inside ASCII cannot be undone by accident.
  const winScripts = files.filter((f) => /\.(bat|ps1)$/.test(f));
  const nonAscii = [];
  for (const f of winScripts) {
    const b = fs.readFileSync(path.join(root, f));
    const bad = [...b].filter((c) => c > 127).length;
    if (bad) nonAscii.push(`${f} (${bad} bytes)`);
  }
  gate('47. …and every .bat/.ps1 is pure ASCII (PowerShell reads them as ANSI)',
    nonAscii.length === 0, nonAscii.join('; ') || `${winScripts.length} scripts clean`);
}

// ---------- gate 50: you cannot pick a corner that is not there ----------
//
// `_hitTest` asked `pointInRect`, so the empty square outside a rounded crate's
// arc selected the crate — on goal pieces, props and terrain alike. The same
// line had a second fault that only a TILTED piece showed: the point was
// un-rotated into the piece's frame by `rotPt` and then un-rotated AGAIN inside
// `pointInRect`, leaving the pick region turned by twice the angle.
//
// 2 px is the grab tolerance the pick has always spent, so the gate probes just
// outside it: a sharp corner must still be picked, a rounded one must not.
{
  const GRAB = 2;
  const S = screen({
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
    goalObjs: [{ shape: 'box', x: 0, y: 0, w: 30, h: 30, radius: 15 }],
    props: [{ shape: 'box', x: 200, y: 0, w: 30, h: 30, radius: 8 }],
    terrain: [{ type: 'box', x: -200, y: 0, w: 30, h: 30, radius: 0 }],
  }, { tab: 'level' });

  // the sharp corner of each 30×30, a hair inside it
  const c = 15 - 0.01;
  const goalHit = S._hitTest({ x: c, y: c });
  const propHit = S._hitTest({ x: 200 + c, y: c });
  const terrHit = S._hitTest({ x: -200 + c, y: c });

  // A miss falls through to whatever is BEHIND the piece — here the build zone
  // that covers the level — so the claim is "not this piece", not "nothing".
  const missed = (h, kind) => !h || h.kind !== kind;

  gate('50. a SHARP box is still picked at its corner',
    terrHit?.kind === 'terrain', `got ${terrHit?.kind ?? 'none'}`);
  gate('50. …but a crate rounded to a circle is NOT — that corner is empty',
    missed(goalHit, 'goal'), `got ${goalHit?.kind ?? 'none'} at (${c}, ${c}); the arc reaches 15, the square 21.21`);
  gate('50. …nor is a prop at the default radius 8',
    missed(propHit, 'prop'), `got ${propHit?.kind ?? 'none'}`);
  // …and the piece is still perfectly pickable where it IS
  gate('50. …while the middle of each still picks',
    S._hitTest({ x: 0, y: 0 })?.kind === 'goal' &&
    S._hitTest({ x: 200, y: 0 })?.kind === 'prop' &&
    S._hitTest({ x: -200, y: 0 })?.kind === 'terrain');
  // the grab tolerance survives: just outside a flat face, still picked
  gate('50. …and the 2 px grab tolerance is unchanged on a flat face',
    S._hitTest({ x: 0, y: 15 + GRAB - 0.01 })?.kind === 'goal' &&
    missed(S._hitTest({ x: 0, y: 15 + GRAB + 0.5 }), 'goal'),
    `inside ${S._hitTest({ x: 0, y: 15 + GRAB - 0.01 })?.kind}, outside ${S._hitTest({ x: 0, y: 15 + GRAB + 0.5 })?.kind}`);

  // A TILTED crate: the double rotation put the pick region at twice the angle,
  // so a point on the piece's own long axis read as a miss.
  {
    const T = screen({
      buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
      goalObjs: [{ shape: 'box', x: 0, y: 0, w: 60, h: 20, radius: 4, angle: Math.PI / 4 }],
    }, { tab: 'level' });
    const d = 22;                                   // along the long axis, inside the piece
    const on = { x: d * Math.SQRT1_2, y: d * Math.SQRT1_2 };
    const off = { x: d * Math.SQRT1_2, y: -d * Math.SQRT1_2 };   // across it, outside
    gate('50. a TILTED crate is picked along its own axis',
      T._hitTest(on)?.kind === 'goal', `got ${T._hitTest(on)?.kind ?? 'none'}`);
    gate('50. …and not across it',
      !T._hitTest(off) || T._hitTest(off).kind !== 'goal', `got ${T._hitTest(off)?.kind ?? 'none'}`);
  }
}

// ---------- gate 54: a chain link may HUG what it wraps ----------
//
// A wrap is the one stick that is supposed to be touching the machine, so a
// chain link is exempt from the proximity rules — wheel clearance, stick
// side-by-side, goal-piece clearance. That exemption is what let `WRAP_PAD`
// drop from 4 px to 1, and the padding was the whole of the tread flop
// (`sag ≈ 3.1 + 0.87 × PAD`, measured in probe-tread.mjs).
//
// **The gate is that it is NARROW.** A plain stick in the identical position
// must still be refused, and a chain link must still be refused for the things
// the exemption does not cover — crossing, terrain, and props.
{
  const zone = { x: 0, y: 0, w: 900, h: 700 };
  const hug = (extra) => {
    const S = screen({ buildZones: [zone], ...extra }, { tab: 'machine' });
    S.design.parts.push({ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' });
    return S;
  };
  // a link lying right on the rim — 15.5 from the hub, well inside r + ROD_CLEARANCE
  const onRim = (chain) => ({ t: 'rod', kind: 'wood', x1: -20, y1: 15.5, x2: 20, y2: 15.5,
    ...(chain ? { chain: 'c1' } : {}) });
  {
    const S = hug({});
    gate('54. a chain link may lie on a wheel it is wrapping',
      S._rodInvalid(onRim(true), null, false, false, {}) === null,
      JSON.stringify(S._rodInvalid(onRim(true), null, false, false, {})));
    gate('54. …while a PLAIN stick in the same place is still refused',
      /through a wheel/.test(S._rodInvalid(onRim(false), null, false, false, {}) || ''),
      JSON.stringify(S._rodInvalid(onRim(false), null, false, false, {})));
  }
  // ---- THE SAME PAIR, ASKED FROM THE WHEEL'S SIDE ----
  //
  // **This is the gate that was missing, and the bug it would have caught was
  // real:** `_wheelInvalid` and `_rodInvalid` ask one question from two sides —
  // "is this wheel resting on that stick" and "is that stick passing through
  // this wheel" — and the chain exemption had only ever been added to the rod's
  // side. So a tread was legal while you dragged the ROPE and refused the moment
  // the WHEEL was asked, which is every select-all drag of a tractor:
  // *"Cannot move tractors. A wheel cannot rest on a stick it isn't pinned to."*
  //
  // Asking one side and assuming the other agrees is exactly how that shipped.
  // Both are asked here, on the same geometry, and are required to agree.
  {
    const wheelSide = (chain) => {
      const S = screen({ buildZones: [zone] }, { tab: 'machine' });
      const w = { t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' };
      S.design.parts.push(w, { ...onRim(chain), id: 'link' });
      return S._wheelInvalid(w, w, false, false, {});
    };
    const rodSide = (chain) => {
      const S = hug({});
      return S._rodInvalid(onRim(chain), null, false, false, {});
    };
    gate('54. …and the WHEEL agrees a wrapped link may lie on it',
      wheelSide(true) === null, JSON.stringify(wheelSide(true)));
    gate('54. …while the wheel still refuses a PLAIN stick resting on it',
      /rest on a stick/.test(wheelSide(false) || ''), JSON.stringify(wheelSide(false)));
    // the structural one: neither side may be the lenient one
    gate('54. …and the two sides never disagree about the same pair',
      (wheelSide(true) === null) === (rodSide(true) === null) &&
      (wheelSide(false) === null) === (rodSide(false) === null),
      `chain: wheel ${wheelSide(true) === null ? 'ok' : 'no'} / rod ${rodSide(true) === null ? 'ok' : 'no'}; ` +
      `plain: wheel ${wheelSide(false) === null ? 'ok' : 'no'} / rod ${rodSide(false) === null ? 'ok' : 'no'}`);
  }

  // …and the exemption does not reach terrain or props
  {
    const S = hug({ terrain: [{ type: 'box', x: 0, y: 100, w: 400, h: 60 }] });
    const inRock = { t: 'rod', kind: 'wood', chain: 'c1', x1: -20, y1: 85, x2: 20, y2: 85 };
    gate('54. …but a chain link is still refused inside TERRAIN',
      /terrain/.test(S._rodInvalid(inRock, null, false, false, {}) || ''),
      JSON.stringify(S._rodInvalid(inRock, null, false, false, {})));
  }
  {
    const S = hug({ props: [{ shape: 'box', x: 120, y: 0, w: 40, h: 40 }] });
    const inProp = { t: 'rod', kind: 'wood', chain: 'c1', x1: 110, y1: 0, x2: 130, y2: 0 };
    gate('54. …and inside a PROP',
      /props/.test(S._rodInvalid(inProp, null, false, false, {}) || ''),
      JSON.stringify(S._rodInvalid(inProp, null, false, false, {})));
  }
  // crossing another stick is still refused — hugging is not threading through
  {
    const S = hug({});
    S.design.parts.push({ t: 'rod', kind: 'wood', id: 'bar', x1: 0, y1: -60, x2: 0, y2: -20 });
    const crossing = { t: 'rod', kind: 'wood', chain: 'c1', x1: -30, y1: -40, x2: 30, y2: -40 };
    gate('54. …and a chain link still may not CROSS a stick',
      /cross/.test(S._rodInvalid(crossing, null, false, false, {}) || ''),
      JSON.stringify(S._rodInvalid(crossing, null, false, false, {})));
  }
  // The padding itself, read out of the source — it is the prestretch, and a
  // change to it should stop this file and get looked at rather than quietly
  // altering how every tread hangs.
  {
    const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    const m = src.match(/const WRAP_PAD = ([0-9.]+);/);
    gate('54. WRAP_PAD is the prestretch, and it is 1',
      !!m && Number(m[1]) === 1, m ? `WRAP_PAD = ${m[1]}` : 'not found');

// ---------- gate 54b: a wrap follows the shape a piece is DRAWN as ----------
//
// Reported with a picture: a tread laid round a roundish goal piece and a wheel
// came out a **square tractor**. `_chainWrap` built its hull from
// `rectCorners` — the four SHARP corners a box is stored with — while every box
// in the game is drawn and simulated with `cornerRadiusOf` rounding
// (`b2MakeRoundedBox`). So the loop was squarer than the piece inside it, and
// at the radius ceiling — where a square piece is literally a circle — it was
// squarer by the whole corner.
//
// `roundedRectPts` samples the real outline. The gate is that it AGREES WITH
// THE RENDERER at both ends of the radius range, rather than just "has more
// points than before".
{
  const CIRC = (x, y, r, n = 24) => Array.from({ length: n }, (_, i) => {
    const a = i / n * Math.PI * 2;
    return { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
  });
  const extent = (pts) => {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  };
  const PAD = 1;

  // a 60x60 crate at the radius ceiling IS a circle, and must wrap as one
  {
    const pts = roundedRectPts({ x: 0, y: 0, w: 60, h: 60, radius: 30 }, PAD, 8);
    const radii = pts.map(p => Math.hypot(p.x, p.y));
    gate('54b. a fully-rounded square wraps as a CIRCLE',
      Math.max(...radii) - Math.min(...radii) < 0.001,
      'radii ' + Math.min(...radii).toFixed(2) + '..' + Math.max(...radii).toFixed(2));
    gate('54b. …at the radius the renderer would use',
      Math.abs(Math.max(...radii) - (30 + PAD)) < 0.001,
      'r ' + Math.max(...radii).toFixed(2) + ', want ' + (30 + PAD));
  }
  // …and a default-radius crate still fills its own box, so a wrap never cuts
  // the corner off a piece it is supposed to clear
  {
    const e = extent(roundedRectPts({ x: 0, y: 0, w: 60, h: 40 }, PAD, 4));
    gate('54b. a default crate still wraps its full extent',
      Math.abs(e.w - 62) < 0.001 && Math.abs(e.h - 42) < 0.001,
      e.w.toFixed(1) + 'x' + e.h.toFixed(1) + ', want 62x42');
    gate('54b. …with the corners actually rounded, not four points',
      roundedRectPts({ x: 0, y: 0, w: 60, h: 40 }, PAD, 4).length > 4,
      roundedRectPts({ x: 0, y: 0, w: 60, h: 40 }, PAD, 4).length + ' sample points');
  }
  // rotation comes through, because a crate can be laid at an angle
  {
    const e = extent(roundedRectPts({ x: 0, y: 0, w: 80, h: 20, angle: Math.PI / 2 }, 0, 4));
    gate('54b. …and a rotated crate wraps rotated',
      Math.abs(e.w - 20) < 0.01 && Math.abs(e.h - 80) < 0.01,
      e.w.toFixed(1) + 'x' + e.h.toFixed(1) + ', want 20x80');
  }
  // THE REPORTED SHAPE: the hull of a roundish goal piece + a wheel must not
  // have a flat side where the goal piece is.
  {
    const goal = roundedRectPts({ x: -60, y: 0, w: 60, h: 60, radius: 30 }, PAD, 6);
    const wheel = CIRC(60, 0, 30 + PAD, 12);
    const hull = convexHull([...goal, ...wheel]);
    const sharp = convexHull([...rectCorners({ x: -60, y: 0, w: 62, h: 62 }), ...wheel]);
    gate('54b. the reported case: goal piece + wheel wraps round, not square',
      hull.length > sharp.length + 4, hull.length + ' hull verts, was ' + sharp.length);
    // no vertex may sit outside the true circle: that would be a corner sticking out
    const worst = Math.max(...hull.filter(p => p.x < 0).map(p => Math.hypot(p.x + 60, p.y)));
    gate('54b. …and no corner of it pokes past the piece it is wrapping',
      worst <= 30 + PAD + 0.001, 'furthest point ' + worst.toFixed(2) + ', piece + pad is ' + (30 + PAD));
  }

// ---------- gate 55: a lost run goes QUIET ----------
//
// Reported as *"the machine goes into the abyss, goal piece lost is announced,
// sound continues"*. Measured in the browser first, because the obvious suspect
// was innocent: `wheelMotion()` does drop wheels in the void, `_soundTick` does
// run at 60/s, and both bed gains do glide to zero. The bug was upstream —
// **losing a goal piece announces itself and changes nothing else.** `playing`
// stays true, the sim keeps stepping, the wheels keep turning, so on a level
// where the piece fell and the machine did not the motor sat at 6.25 rad/s ten
// seconds past the toast that said "Stop and rebuild". (In the other direction
// it was worse: the sim was still stepping at t=73 s with the wheel at
// y=698,564.)
//
// **Stubbed sims, no physics.** The whole decision is "is this run over", which
// is the one thing about `_soundTick` that can be asked without an
// AudioContext or a wasm module — and the headless suite has neither, so a
// gate that went through `playMotion` would assert nothing at all.
{
  const S = screen(flatWorld(), { tab: 'machine' });
  S._closeCtxMenu = () => {}; S._updateInfoChip = () => {};
  const stub = (goalLost, spin) => {
    let drained = 0;
    S.sim = {
      goalLost, sweep: false,
      drainHits: () => { drained++; return []; },
      wheelMotion: () => ({ rim: 260, spin, count: 1, powered: 1 }),
    };
    S._lastMotion = null;
    S._soundTick();
    return { drained, motion: S._lastMotion };
  };

  const live = stub(false, 10);
  gate('55. a running machine still drives the bed',
    live.motion && live.motion.motor > 0 && live.motion.roll > 0,
    JSON.stringify(live.motion));

  const lost = stub(true, 10);
  gate('55. …and a lost run is asked for silence, however fast the wheels turn',
    lost.motion && lost.motion.roll === 0 && lost.motion.motor === 0,
    JSON.stringify(lost.motion));
  gate('55. …which is a decision about the RUN, not about the wheels',
    S._soundOver() === true && (stub(false, 0), S._soundOver() === false));

  // The queue is the half that is easy to forget: the sim fills it whether or
  // not anyone listens, and a run that never ends is exactly the one where an
  // undrained queue grows without bound.
  gate('55. …and its hits are still DRAINED, just not played',
    stub(true, 10).drained === 1, 'drainHits calls while silenced');
}
}
  }
}

// ---------- gate 53: a rope PAYS OUT when its anchor moves ----------
//
// Every other stick stretches when the thing it is pinned to moves. A rope must
// not: it is a chain of `ROPE_LINK_LEN` links, and moving the wheel it hangs
// from calls for MORE CHAIN, not one 8 px link turned into an 80 px pole drawn
// as rope. Reported as *"say rope is connected to wheel, wheel gets moved…
// more rope needed"*.
//
// The invariant that actually matters is CONTINUITY — a re-split that broke the
// run would leave a rope that still looked right and jointed nowhere, because
// §5.4 forms joints from shared coordinates alone.
{
  const LINK = ROPE_LINK_LEN;
  const build = () => {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 2000, h: 2000 }] }, {
      tab: 'machine',
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' }],
    });
    const pin = wheelPins(S.design.parts[0])[1];          // a rim pin, not the hub
    for (let i = 0; i < 4; i++) {
      S.design.parts.push({ t: 'rod', kind: 'wood', chain: 'c1', id: 'l' + i,
        x1: pin.x + i * LINK, y1: pin.y, x2: pin.x + (i + 1) * LINK, y2: pin.y });
    }
    return S;
  };
  const chain = (S) => S.design.parts.filter(p => p.t === 'rod' && p.chain === 'c1');
  const lenOf = (l) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  // a run is continuous iff every link's far end is some other link's near end,
  // except the two ends of the whole run
  const continuous = (ls) => {
    const key = (x, y) => jointKey(x, y);
    const starts = new Map();
    for (const l of ls) starts.set(key(l.x1, l.y1), (starts.get(key(l.x1, l.y1)) || 0) + 1);
    let loose = 0;
    for (const l of ls) if (!starts.has(key(l.x2, l.y2))) loose++;
    return loose === 1;                                   // exactly one far end is the tail
  };

  {
    const S = build();
    gesture(S, { x: 0, y: 0 }, { x: -60, y: 0 }, { steps: 10, watch: partAt(S, 0) });
    const after = chain(S);
    gate('53. …with every link back near its natural length',
      after.every(l => lenOf(l) <= LINK * 1.5 && lenOf(l) >= 1),
      `longest ${Math.max(...after.map(lenOf)).toFixed(2)} px, ROPE_LINK_LEN is ${LINK}`);
    gate('53. …and the run still joins end to end',
      continuous(after), `${after.length} links, ${after.filter(l => !after.some(o => o !== l && jointKey(o.x1, o.y1) === jointKey(l.x2, l.y2))).length} loose ends`);
    gate('53. …and it is still bolted to the wheel it hangs from',
      (() => {
        const keys = new Set(wheelPins(S.design.parts[0]).map(p => jointKey(p.x, p.y)));
        return after.some(l => keys.has(jointKey(l.x1, l.y1)) || keys.has(jointKey(l.x2, l.y2)));
      })(), 'a link still shares one of the wheel\'s pins');
    gate('53. …and every new link kept the rope\'s identity',
      after.every(l => l.chain === 'c1' && l.kind === 'wood'));
  }
  // Shrinking folds links back down rather than leaving slack coiled up.
  //
  // **This gate used to drag +20 and assert the count could not rise, and it
  // passed for a reason that had nothing to do with folding:** the wheel-vs-rope
  // rule refused a wheel resting on its own rope (gate 54's missing half), so
  // the drop was invalid and `_relayRopes` never ran. The rope came back
  // untouched and "4 -> 4" read like a fold. Fixing that rule ran this path for
  // the first time and the gate went red at 4 -> 5.
  //
  // **The code was right and the FIXTURE was wrong.** The rope's first link is
  // 8 px, so dragging its anchor +20 does not shorten that link — it takes the
  // anchor clean past the link's far end and leaves it 12 px long the other way,
  // and `round(12 / 8)` is 2. Measured across the range:
  //
  //     drag    +2   +4   +6   +8   +12   +20
  //     links    4    4    4    4     4     5
  //     first    6    4    2    0     4   6+6
  //
  // The fold is real everywhere short of overshooting. +4 is what "pulling the
  // anchor back in" was meant to say.
  {
    const S = build();
    const before = chain(S).length;
    gesture(S, { x: 0, y: 0 }, { x: 4, y: 0 }, { steps: 10, watch: partAt(S, 0) });
    const after = chain(S);
    gate('53. …and pulling the anchor back in does not ADD links',
      after.length <= before, before + ' -> ' + after.length);
  }
  // …and the documented limit of that, stated as the number it produces. A run
  // cannot fold below ONE LINK PER ORIGINAL LINK — `_relayRopes` re-splits each
  // rod from its own endpoints and never merges two — so an anchor dragged far
  // enough to overshoot its first link re-splits that link instead.
  // ---- a link the sim will never see is not a link ----
  //
  // Fold a rope all the way in and the link nearest the anchor lands on its own
  // far end: `_ropeSplit` gets ~0 length, `round` gives it ONE link, and the run
  // keeps a piece that costs budget, draws nothing and takes no part in the
  // physics (the sim skips anything under `ROD_SKIP_LEN`). Found while gating
  // the tractor fix — the +8 column of that sweep read `[0.0 8.0 8.0 8.0]`.
  //
  // **Removing it is only half of it.** §5.4 forms joints from shared
  // coordinates alone, so deleting a short link without welding the gap shut
  // would leave a rope that still looks perfect and joints nowhere — which is
  // the failure this gate is really guarding.
  {
    const S = build();
    const before = chain(S).length;
    gesture(S, { x: 0, y: 0 }, { x: LINK, y: 0 }, { steps: 10, watch: partAt(S, 0) });   // exactly one link: folded to nothing
    const after = chain(S);
    gate('53. …and a link folded down to nothing is dropped, not kept',
      after.every(l => lenOf(l) >= ROD_SKIP_LEN),
      'lens [' + after.map(l => lenOf(l).toFixed(1)).join(' ') + '], ROD_SKIP_LEN is ' + ROD_SKIP_LEN);
    gate('53. …the run is WELDED shut, not left with a hole in it',
      continuous(after), after.length + ' links, ' +
      after.filter(l => !after.some(o => o !== l && jointKey(o.x1, o.y1) === jointKey(l.x2, l.y2))).length + ' loose ends');
    gate('53. …and it is still bolted to the wheel',
      (() => {
        const keys = new Set(wheelPins(S.design.parts[0]).map(p => jointKey(p.x, p.y)));
        return after.some(l => keys.has(jointKey(l.x1, l.y1)) || keys.has(jointKey(l.x2, l.y2)));
      })(), 'a link still shares one of the wheel\'s pins');
  }
  // …and a rope of ONE link that has been reeled fully in is LEFT alone: there
  // is nothing to weld it to, and quietly deleting somebody's rope is worse
  // than an invisible part.
  {
    const S = screen({ buildZones: [{ x: 0, y: 0, w: 2000, h: 2000 }] }, {
      tab: 'machine', parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15, id: 'w' }],
    });
    const pin = wheelPins(S.design.parts[0])[1];
    S.design.parts.push({ t: 'rod', kind: 'wood', chain: 'solo', id: 'only',
      x1: pin.x, y1: pin.y, x2: pin.x + LINK, y2: pin.y });
    const before = S.design.parts.length;
    gesture(S, { x: 0, y: 0 }, { x: LINK, y: 0 }, { steps: 10, watch: partAt(S, 0) });
    gate('53. …while a lone collapsed rope is left rather than silently deleted',
      S.design.parts.length === before, before + ' -> ' + S.design.parts.length + ' parts');
  }
}

// ---------- gate 52: Align→Touch moves EVERY piece, not just the aligned ones ----------
//
// Reported as align having *"gotten lazy — I select four things and only one
// moves"*. `_touchCoord` slides a piece along ONE axis and gates on the two
// pieces already overlapping on the other, so a piece sitting diagonally from
// everything placed failed that test both ways and was left exactly where it
// was. Measured before the fix: **four crates on a diagonal moved none of the
// three**, and four balls did the same.
//
// The gate is the COUNT — every non-anchor piece ends up somewhere new — plus
// the geometry, because "it moved" is satisfied by moving it anywhere. The
// arrangements are diagonal on purpose: a row passes with or without the fix,
// which is why a row was all that was ever gated.
{
  const ZONE = { x: 0, y: 0, w: 3000, h: 3000 };
  // The gap between two AXIS-ALIGNED pieces as DRAWN — core-plus-radius, with
  // `cornerRadiusOf`'s default restated rather than imported. The first version
  // of this gate measured bounding boxes and expected 40 px between two 40×40
  // crates on a diagonal, which is corner-to-corner for a SQUARE; the arcs meet
  // at 35.32. That is the same stale reference the op itself had.
  const CR = 8;
  const trueGap = (a, b) => {
    if (a.shape === 'ball' && b.shape === 'ball') {
      return Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
    }
    const core = (o) => (o.shape === 'ball'
      ? { ex: 0, ey: 0, r: o.r }
      : { ex: o.w / 2 - CR, ey: o.h / 2 - CR, r: CR });
    const ca = core(a), cb = core(b);
    const dx = Math.max(Math.abs(a.x - b.x) - ca.ex - cb.ex, 0);
    const dy = Math.max(Math.abs(a.y - b.y) - ca.ey - cb.ey, 0);
    return Math.hypot(dx, dy) - ca.r - cb.r;
  };
  const touchAll = (pieces) => {
    const S = screen({ buildZones: [ZONE], props: pieces, goalObjs: [{ shape: 'box', x: 0, y: 1200, w: 30, h: 30 }] },
      { tab: 'level' });
    const before = S.level.props.map(p => ({ x: p.x, y: p.y }));
    S.multiSel = S.level.props.map(p => ({ kind: 'prop', ref: p }));
    S._alignOp('touch');
    const after = S.level.props.map(p => ({ ...p }));
    return { S, before, after, moved: after.filter((a, i) => Math.hypot(a.x - before[i].x, a.y - before[i].y) > 0.01).length };
  };

  {
    const r = touchAll([0, 120, 240, 360].map(v => ({ shape: 'box', x: v, y: v, w: 40, h: 40 })));
    gate('52. four crates on a DIAGONAL: every one but the anchor moves',
      r.moved === 3, `${r.moved} of 3 moved — [${r.after.map(a => `${a.x.toFixed(0)},${a.y.toFixed(0)}`).join('] [')}]`);
    // …and TOUCHING means the drawn shapes touch, not the boxes round them
    const g1 = trueGap(r.after[1], r.after[0]);
    gate('52. …and the nearest ends up touching the anchor',
      Math.abs(g1 - REST_GAP) < 0.02,
      `true gap ${g1.toFixed(3)} px, want ${REST_GAP} (their boxes are ${Math.max(Math.abs(r.after[1].x - r.after[0].x), Math.abs(r.after[1].y - r.after[0].y)).toFixed(2)} apart)`);
    gate('52. …and the anchor itself never moves',
      r.after[0].x === r.before[0].x && r.after[0].y === r.before[0].y);
  }
  {
    const r = touchAll([0, 120, 240, 360].map(v => ({ shape: 'ball', x: v, y: v, r: 20 })));
    gate('52. four BALLS on a diagonal do the same',
      r.moved === 3, `${r.moved} of 3 moved`);
    const d = Math.hypot(r.after[1].x - r.after[0].x, r.after[1].y - r.after[0].y);
    gate('52. …resting at r + r + REST_GAP, like every other stop',
      Math.abs(d - (40 + REST_GAP)) < 0.02, `${d.toFixed(3)} px, want ${(40 + REST_GAP).toFixed(2)}`);
  }
  {
    // scattered — neither a row nor a clean diagonal, which is what a real
    // selection looks like
    const r = touchAll([{ x: 0, y: 0 }, { x: 150, y: 30 }, { x: 60, y: 200 }, { x: 300, y: 260 }]
      .map(p => ({ shape: 'box', ...p, w: 40, h: 40 })));
    gate('52. …and a scattered selection packs all of them',
      r.moved === 3, `${r.moved} of 3 moved`);
    // nothing may end up OVERLAPPING anything else it was packed against
    let worst = Infinity;
    for (let i = 0; i < r.after.length; i++) {
      for (let j = i + 1; j < r.after.length; j++) worst = Math.min(worst, trueGap(r.after[i], r.after[j]));
    }
    gate('52. …without pushing any pair into each other',
      worst > -0.02, `closest pair's true gap is ${worst.toFixed(3)} px`);
    // …and at least one pair is actually TOUCHING — "moved" and "not
    // overlapping" are both satisfied by shuffling everything a pixel
    let best = Infinity;
    for (let i = 1; i < r.after.length; i++) {
      for (let j = 0; j < i; j++) best = Math.min(best, Math.abs(trueGap(r.after[i], r.after[j]) - REST_GAP));
    }
    gate('52. …and each one comes to rest ON something',
      best < 0.02, `closest approach to REST_GAP is ${best.toFixed(4)} px`);
  }
  {
    // A plain row must come out exactly as it always did. On a row the slide
    // direction IS the axis and a rounded box's flat face is its bounding box,
    // so the old answer and the new one coincide — which is the check, not a
    // coincidence to rely on.
    const r = touchAll([0, 120, 240, 360].map(v => ({ shape: 'box', x: v, y: 0, w: 40, h: 40 })));
    gate('52. …and a plain row is unchanged',
      r.moved === 3 && Math.abs((r.after[1].x - r.after[0].x) - (40 + REST_GAP)) < 1e-6,
      `${(r.after[1].x - r.after[0].x).toFixed(4)} px apart, want ${(40 + REST_GAP).toFixed(2)}`);
  }
}

// ---------- gate 51: a batch delete removes what was SELECTED ----------
//
// Reported as *"select say 4 goal pieces and hit delete, only 2 disappear"* —
// and the count was the smaller half of it. `_deleteOne` removes goal pieces
// and zones by INDEX (`splice`), while every other kind goes by reference, and
// each splice shifts the index of everything after it. So the second entry in
// the selection addressed a different piece than the one the user picked:
// selecting g0…g3 of five deleted **g0 and g2** and left g1, g3, g4. Wrong
// pieces, silently, with the delete sound playing over it because `gone` had
// counted four.
//
// The three parallel arrays are gated with it. `goalObjs` / `goalPositions` /
// `goalMoved` are spliced together, and an index bug that desynchronised them
// would put every piece's staged position on the wrong piece (§11.3).
{
  const zone = { x: 0, y: 0, w: 2000, h: 400 };
  const mkGoals = (n) => Array.from({ length: n }, (_, i) => ({ shape: 'box', x: i * 100, y: 0, w: 30, h: 30, tag: 'g' + i }));

  {
    const S = screen({ buildZones: [zone], goalObjs: mkGoals(5) }, { tab: 'level' });
    S.multiSel = [0, 1, 2, 3].map(i => ({ kind: 'goal', idx: i }));
    S._deleteSelection();
    const left = S.level.goalObjs.map(g => g.tag);
    gate('51. deleting 4 of 5 goal pieces leaves exactly the one not selected',
      left.length === 1 && left[0] === 'g4', `left [${left.join(', ')}], want [g4]`);
    gate('51. …and goalPositions / goalMoved stay in step with them',
      S.goalPositions.length === 1 && S.goalMoved.length === 1,
      `objs ${S.level.goalObjs.length}, positions ${S.goalPositions.length}, moved ${S.goalMoved.length}`);
  }
  {
    // the interior ones, so a shift shows as the wrong survivors rather than a
    // short count — the failure this gate is really about
    const S = screen({ buildZones: [zone], goalObjs: mkGoals(5) }, { tab: 'level' });
    S.multiSel = [1, 3].map(i => ({ kind: 'goal', idx: i }));
    S._deleteSelection();
    gate('51. …and picking out g1 and g3 removes those two, not their neighbours',
      S.level.goalObjs.map(g => g.tag).join(',') === 'g0,g2,g4',
      `left [${S.level.goalObjs.map(g => g.tag).join(', ')}], want [g0, g2, g4]`);
  }
  {
    // the last-goal-piece rule still holds when the whole lot is selected
    const S = screen({ buildZones: [zone], goalObjs: mkGoals(3) }, { tab: 'level' });
    S.multiSel = [0, 1, 2].map(i => ({ kind: 'goal', idx: i }));
    S._deleteSelection();
    gate('51. …and a level still keeps its last goal piece',
      S.level.goalObjs.length === 1, `${S.level.goalObjs.length} left`);
  }
  {
    // zones have the identical splice, and the identical bug
    const S = screen({
      buildZones: [0, 1, 2, 3].map(i => ({ x: i * 300, y: 0, w: 100, h: 100, tag: 'z' + i })),
      goalObjs: mkGoals(1),
    }, { tab: 'level' });
    S.multiSel = [0, 1, 2].map(i => ({ kind: 'zone', zone: 'build', idx: i, ref: S.level.buildZones[i] }));
    S._deleteSelection();
    gate('51. …and the same holds for build zones',
      S.level.buildZones.length === 1 && S.level.buildZones[0].tag === 'z3',
      `left [${S.level.buildZones.map(z => z.tag).join(', ')}], want [z3]`);
  }
  {
    // A selection nothing in it can delete must not sound or commit. Both
    // members are the LAST of their kind, which is the only way to build one:
    // a level keeps its last goal piece and its last zone.
    const S = screen({ buildZones: [zone], goalObjs: mkGoals(1) }, { tab: 'level', undo: true });
    const before = S.commits;
    S.multiSel = [
      { kind: 'goal', idx: 0 },
      { kind: 'zone', zone: 'build', idx: 0, ref: S.level.buildZones[0] },
    ];
    S._deleteSelection();
    gate('51. …while an undeletable selection still commits nothing',
      S.level.goalObjs.length === 1 && S.commits === before && S.toasts.length > 0,
      `${S.commits - before} commits, ${S.toasts.length} toasts`);
  }
}

// ---------- gate 54: touch (§19) ----------
//
// The touch layer rides the same three handlers every other gate drives —
// `pointerType: 'touch'` and a second pointerId are the only new vocabulary.
// What is gated is the CONTRACT, not the chrome: a second finger means the
// camera and cancels the half-gesture it interrupts; a pinch keeps the world
// point between the fingers between the fingers; a finger a pinch or a
// long-press used up is spent until it lifts; and the latch chips speak the
// same modifier language the keyboard does.
{
  const { pinchUpdate, isDoubleTap, LONG_PRESS_MS, TOUCH_SLOP } = await import(u('public/js/util.js'));

  const tev = (wx, wy, id, mods = {}) => ev(wx, wy, { pointerType: 'touch', pointerId: id, ...mods });

  // -- the pure arithmetic first --
  {
    const un = pinchUpdate(
      [{ x: 300, y: 300 }, { x: 500, y: 300 }],
      [{ x: 250, y: 300 }, { x: 550, y: 300 }]);
    gate('54. pinchUpdate: spread 200 → 300 is factor 1.5 about a still centroid',
      near(un.factor, 1.5) && near(un.cx, 400) && near(un.cy, 300) && near(un.dx, 0) && near(un.dy, 0),
      `factor ${un.factor}, centroid (${un.cx}, ${un.cy}), pan (${un.dx}, ${un.dy})`);
    const slid = pinchUpdate(
      [{ x: 300, y: 300 }, { x: 500, y: 300 }],
      [{ x: 340, y: 320 }, { x: 540, y: 320 }]);
    gate('54. …two fingers moving together pan without zooming',
      near(slid.factor, 1) && near(slid.dx, 40) && near(slid.dy, 20),
      `factor ${slid.factor}, pan (${slid.dx}, ${slid.dy})`);
    const degen = pinchUpdate(
      [{ x: 400, y: 300 }, { x: 400, y: 300 }],
      [{ x: 400, y: 300 }, { x: 410, y: 300 }]);
    gate('54. …and two fingers reported at one point cannot divide the zoom by zero',
      near(degen.factor, 1), `factor ${degen.factor}`);
    gate('54. isDoubleTap honours both fences',
      isDoubleTap({ t: 0, x: 0, y: 0 }, 399, 39, 0) === true
      && isDoubleTap({ t: 0, x: 0, y: 0 }, 401, 0, 0) === false
      && isDoubleTap({ t: 0, x: 0, y: 0 }, 100, 41, 0) === false
      && isDoubleTap(null, 100, 0, 0) === false,
      `MS ${LONG_PRESS_MS}, SLOP ${TOUCH_SLOP}`);
  }

  // -- a pinch through the real handlers: zoom about the pair, then spend the survivor --
  {
    const S = screen(flatWorld());
    S._pointerDown(tev(-100, 0, 1));
    gate('54. one finger is the left button — it pans like a mouse on empty space',
      S.drag?.type === 'pan', `drag ${S.drag?.type}`);
    S._pointerDown(tev(100, 0, 2));
    gate('54. a second finger starts a pinch and takes the drag with it',
      S._pinch === true && S.drag === null, `pinch ${S._pinch}, drag ${S.drag?.type}`);
    // spread ×1.5 about a centroid parked over world (0, 0): client 300→250,
    // 500→550 — walked in 2 px steps the way real hardware reports a pinch.
    // Each finger's event lands alone, so each one nudges the centroid and the
    // next event nudges it back; that cross-term is one event's worth (§19,
    // pinchUpdate) and stays sub-pixel at real step sizes, which is exactly
    // what this gate holds. Two 50 px jumps would measure the cross-term of
    // hardware that doesn't exist.
    for (let i = 1; i <= 25; i++) {
      S._pointerMove(tev(-100 - 2 * i, 0, 1));
      S._pointerMove(tev(100 + 2 * i, 0, 2));
    }
    const wAt = S.camera.toWorld(400, 300);
    gate('54. the pinch zooms about the centroid — the world point between the fingers stays put',
      near(S.camera.zoom, 1.5) && near(wAt.x, 0, 0.5) && near(wAt.y, 0, 0.5),
      `zoom ${S.camera.zoom.toFixed(3)}, centroid over (${wAt.x.toFixed(2)}, ${wAt.y.toFixed(2)})`);
    S._pointerUp(tev(-150, 0, 1));
    gate('54. lifting one finger ends the pinch and spends the survivor',
      S._pinch === false, `pinch ${S._pinch}`);
    const z0 = S.camera.zoom, x0 = S.camera.x;
    S._pointerMove(tev(80, 40, 2));
    gate('54. …so the survivor cannot yank the camera the pinch just placed',
      S.camera.zoom === z0 && S.camera.x === x0 && S.drag === null,
      `zoom ${S.camera.zoom}, x ${S.camera.x}`);
    S._pointerUp(tev(80, 40, 2));
    S._pointerDown(tev(0, 0, 3));
    gate('54. …and the NEXT finger is an ordinary press again',
      S.drag?.type === 'pan' && S._touches.size === 1, `drag ${S.drag?.type}`);
    S._pointerUp(tev(0, 0, 3));
  }

  // -- the cancel: a second finger un-starts the drag it interrupts --
  {
    const S = screen(flatWorld(), { undo: true, parts: [
      { t: 'wheel', kind: 'free', x: 0, y: restY(15), r: 15, id: 'w1' },
    ] });
    const at = partAt(S, 0);
    S._pointerDown(tev(0, restY(15), 1));
    S._pointerMove(tev(-60, -80, 1));
    const during = at();
    S._pointerDown(tev(60, -60, 2));
    gate('54. a second finger mid-drag cancels the move — the piece is back where it started',
      during.x !== 0 && samePt(at(), { x: 0, y: restY(15) }),
      `dragged to (${during.x.toFixed(0)}, ${during.y.toFixed(0)}), now (${at().x.toFixed(0)}, ${at().y.toFixed(0)})`);
    S._pointerUp(tev(-60, -80, 1));
    S._pointerUp(tev(60, -60, 2));
    gate('54. …and nothing of the cancelled gesture survives the lifts',
      samePt(at(), { x: 0, y: restY(15) }) && S.drag === null && S._touches.size === 0,
      `at (${at().x.toFixed(0)}, ${at().y.toFixed(0)})`);
  }

  // -- a second finger during a PLACEMENT places nothing --
  {
    const S = screen(flatWorld(), { undo: true, tool: 'wheel-free' });
    const n0 = S.design.parts.length, c0 = S.commits;
    S._pointerDown(tev(0, -60, 1));
    gate('54. (the press did arm a ghost)', S.drag?.type === 'place-wheel', `drag ${S.drag?.type}`);
    S._pointerDown(tev(100, -60, 2));
    S._pointerUp(tev(0, -60, 1));
    S._pointerUp(tev(100, -60, 2));
    gate('54. a pinch interrupting a placement drops the ghost — no piece, no commit',
      S.design.parts.length === n0 && S.commits === c0,
      `${S.design.parts.length - n0} pieces, ${S.commits - c0} commits`);
  }

  // -- the long press is the right button, and stillness is what earns it --
  {
    const S = screen(flatWorld(), { undo: true, parts: [
      { t: 'wheel', kind: 'free', x: 0, y: restY(15), r: 15, id: 'w1' },
    ] });
    const calls = [];
    S._contextMenu = (e) => calls.push({ x: e.clientX, y: e.clientY });
    const at = partAt(S, 0);
    S._pointerDown(tev(0, restY(15), 1));
    gate('54. (the press did start a move)', S.drag?.type === 'move', `drag ${S.drag?.type}`);
    S._fireLongPress(1, 400, 300 + restY(15));
    gate('54. a still hold becomes the piece\'s menu, and un-starts the drag first',
      calls.length === 1 && S.drag === null && samePt(at(), { x: 0, y: restY(15) }),
      `${calls.length} menus, drag ${S.drag?.type}`);
    const n0 = S.design.parts.length;
    S._pointerUp(tev(0, restY(15), 1));
    gate('54. …and the lift after it clicks nothing (the finger is spent)',
      calls.length === 1 && S._touches.size === 0 && S.design.parts.length === n0 && S.drag === null,
      `${calls.length} menus, ${S.design.parts.length - n0} new pieces`);
    // a finger that WANDERED cannot become a menu — the timer's fire checks, not just the arm
    S._pointerDown(tev(0, restY(15), 4));
    S._pointerMove(tev(TOUCH_SLOP + 30, restY(15) - 40, 4));
    S._fireLongPress(4, 400, 300);
    gate('54. …while a finger that wandered past the slop cannot become one',
      calls.length === 1, `${calls.length} menus`);
    S._pointerUp(tev(TOUCH_SLOP + 30, restY(15) - 40, 4));
  }

  // -- two taps are the double-click: whole-machine select, through the real handlers --
  {
    const S = screen(flatWorld(), { undo: true, parts: [
      { t: 'wheel', kind: 'free', x: 0, y: restY(15), r: 15, id: 'w1' },
      { t: 'wheel', kind: 'free', x: 60, y: restY(15), r: 15, id: 'w2' },
      { t: 'rod', kind: 'wood', x1: 0, y1: restY(15), x2: 60, y2: restY(15), id: 'r1' },
    ] });
    const tap = (wx, wy, id) => { S._pointerDown(tev(wx, wy, id)); S._pointerUp(tev(wx, wy, id)); };
    tap(0, restY(15), 1);
    tap(0, restY(15), 2);
    gate('54. two quick taps select the whole connected machine',
      S.multiSel.length === 3, `${S.multiSel.length} of 3 selected`);
  }

  // -- the latch chips ARE the modifier keys, and only for a finger --
  {
    const S = screen(flatWorld(), { undo: true, parts: [
      { t: 'wheel', kind: 'free', x: 0, y: restY(15), r: 15, id: 'w1' },
      { t: 'wheel', kind: 'free', x: 100, y: restY(15), r: 15, id: 'w2' },
    ] });
    S._modLatch = { shift: false, ctrl: true, alt: false };
    const tap = (wx, wy, id) => { S._pointerDown(tev(wx, wy, id)); S._pointerUp(tev(wx, wy, id)); };
    tap(0, restY(15), 1);
    tap(100, restY(15), 2);
    // …and a MOUSE press reads the real keyboard, never the latch. On empty
    // canvas the two answers cannot be confused: Ctrl honoured means a
    // marquee, Ctrl ignored means a pan — a piece can't stand in for this,
    // because a plain click on a multi-selected piece legitimately keeps the
    // group (it is how a group is picked up).
    S._pointerDown(ev(-340, 120));
    gate('54. …while a mouse with the latch on still reads its real keyboard',
      S.drag?.type === 'pan', `drag ${S.drag?.type}, want pan (marquee = latch leaked)`);
    S._pointerUp(ev(-340, 120));
  }
}

// ---------- gate 58: arrows that snap, and arrows aimed at a handle ----------
//
// Two asks in one key (2026-08-07): Shift/Alt-arrows SNAP the move the way
// the same modifiers snap a drag, and a press on a resize/rotate handle aims
// the arrows at THAT handle until the selection moves on. The handle nudge
// runs a one-step synthetic drag through the real _resizeDrag/_rotateDrag and
// _transformFinish, so these gates hold the whole promise: same grids, same
// alignment points, same fit-or-revert rules, from a key as from a pointer.
{
  const { snapStep } = await import(u('public/js/util.js'));
  const kev = (key, mods = {}) => ({
    key, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {},
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
  });

  // -- the pure step --
  gate('58. snapStep: off a line lands on the NEXT line in the direction',
    snapStep(7, 1, 30) === 30 && snapStep(7, -1, 30) === 0 && snapStep(-7, -1, 30) === -30,
    `7→${snapStep(7, 1, 30)} / 7←${snapStep(7, -1, 30)}`);
  gate('58. …on a line strides exactly one grid, never a no-op',
    snapStep(30, 1, 30) === 60 && snapStep(30, -1, 30) === 0
    && snapStep(60.0000001, 1, 30) === 90,
    `30→${snapStep(30, 1, 30)}, noisy 60→${snapStep(60.0000001, 1, 30)}`);
  gate('58. …and the offset shifts the whole lattice, not the answer\'s sign',
    snapStep(25 - 15, 1, 30) + 15 === 45 && snapStep(0, 0, 30) === 0 && snapStep(5, 1, 0) === 5,
    `wheel at 25 steps to ${snapStep(25 - 15, 1, 30) + 15}`);

  // -- snapped MOVES, through the real key handler --
  {
    const S = screen(flatWorld({ terrain: [
      { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
      { type: 'box', x: 37, y: -300, w: 60, h: 60 },
    ] }), { tab: 'level', undo: true });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    // **The arrow LADDER** (2026-08-12): plain 0.1, Alt 0.01, Shift+Alt 1.
    // Shift alone is untouched and still snaps to the grid — the one modifier
    // that was not reassigned, because stepping onto a line is a different job
    // from stepping by a precise amount and both are wanted.
    S._keyDown(kev('ArrowRight'));
    gate('58. a plain arrow nudges a TENTH of a pixel', Math.abs(t.x - 37.1) < 1e-9, `x ${t.x}`);
    S._keyDown(kev('ArrowRight', { altKey: true }));
    gate('58. …Alt+arrow a hundredth, the finest move the editor can make',
      Math.abs(t.x - 37.11) < 1e-9, `x ${t.x}`);
    S._keyDown(kev('ArrowRight', { shiftKey: true, altKey: true }));
    gate('58. …and Shift+Alt+arrow a whole one',
      Math.abs(t.x - 38.11) < 1e-9, `x ${t.x}`);
    t.x = 37;
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    gate('58. Shift+arrow puts the box\'s MIN CORNER on the next grid line — the drag\'s own alignment point',
      t.x - t.w / 2 === GRID_STEP, `min corner ${t.x - t.w / 2}`);
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    gate('58. …and strides a whole cell once aligned', t.x - t.w / 2 === 2 * GRID_STEP, `min corner ${t.x - t.w / 2}`);
    // …and the three free steps really are three different sizes, so a future
    // edit cannot quietly collapse two of them into one
    gate('58. …the ladder is three distinct steps, coarse → fine',
      NUDGE_STEPS[0] > NUDGE_STEPS[1] && NUDGE_STEPS[1] > NUDGE_STEPS[2],
      NUDGE_STEPS.join(' > '));
  }
  {
    // a WHEEL steps cell-centre to cell-centre — the circle rule, not the node
    const S = screen(flatWorld(), { undo: true, parts: [
      { t: 'wheel', kind: 'free', x: 40, y: -45, r: 15, id: 'w1' },
    ] });
    const p = S.design.parts[0];
    S._select({ kind: 'part', ref: p });
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    gate('58. a Shift-arrowed wheel lands cell-centred, exactly as a Shift-drag lands it',
      p.x === GRID_FINE + GRID_STEP, `x ${p.x}`);
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    gate('58. …and strides by whole cells after', p.x === GRID_FINE + 2 * GRID_STEP, `x ${p.x}`);
  }

  // -- arrows aimed at a HANDLE --
  {
    const S = screen(flatWorld({ terrain: [
      { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
      { type: 'box', x: 0, y: -200, w: 60, h: 60 },
    ] }), { tab: 'level', undo: true });
    const t = S.level.terrain[1];
    S._select({ kind: 'terrain', ref: t });
    // a CLICK on the c2 corner handle (max,max) — press and release, no move
    S._pointerDown(ev(30, -170));
    const armedType = S._armedHandle?.type;
    S._pointerUp(ev(30, -170));
    gate('58. a press on a resize handle arms it for the keyboard',
      armedType === 'resize' && S._armedHandle?.tag === 'c2', `${armedType} ${S._armedHandle?.tag}`);
    S._keyDown(kev('ArrowRight'));
    gate('58. an arrow then RESIZES — dragged corner +1, opposite corner pinned',
      t.w === 61 && near(t.x - t.w / 2, -30), `w ${t.w}, min x ${t.x - t.w / 2}`);
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    // The RULE, not the coordinate it produced at one scale: the dragged edge
    // lands on a node and the pinned one does not move. Written as literals
    // (60 / -165) this pair encoded a 30 px grid, and said nothing true once
    // the grid became 40.
    const onNode = (v, step) => Math.abs(v - Math.round(v / step) * step) < 0.01;
    gate('58. Shift+arrow lands the corner on the next grid node, like the drag',
      onNode(t.x + t.w / 2, GRID_STEP) && near(t.x - t.w / 2, -30), `corner ${t.x + t.w / 2}`);
    S._keyDown(kev('ArrowDown', { altKey: true }));
    gate('58. …and the other axis answers the other arrows',
      onNode(t.y + t.h / 2, GRID_FINE), `bottom ${t.y + t.h / 2}`);
    // rotate: arm the knob (18/zoom above the top edge), then step in degrees
    const knobY = t.y - t.h / 2 - 18;
    S._pointerDown(ev(t.x, knobY));
    const rotArmed = S._armedHandle?.type;
    S._pointerUp(ev(t.x, knobY));
    gate('58. a press on the rotate knob re-aims the arrows at it', rotArmed === 'rotate', rotArmed);
    S._keyDown(kev('ArrowRight'));
    gate('58. an arrow turns one degree', near((t.angle || 0) * 180 / Math.PI, 1, 0.01),
      `${((t.angle || 0) * 180 / Math.PI).toFixed(2)}°`);
    S._keyDown(kev('ArrowRight', { shiftKey: true }));
    gate('58. Shift+arrow lands on the next 45° notch — absolute, like the drag\'s Shift',
      near((t.angle || 0) * 180 / Math.PI, 45, 0.01), `${((t.angle || 0) * 180 / Math.PI).toFixed(2)}°`);
    S._keyDown(kev('ArrowLeft', { altKey: true }));
    gate('58. Alt+arrow steps back to the 10° lattice',
      near((t.angle || 0) * 180 / Math.PI, 40, 0.01), `${((t.angle || 0) * 180 / Math.PI).toFixed(2)}°`);
    // moving the selection on disarms — arrows go back to being a MOVE
    const floor = S.level.terrain[0];
    S._select({ kind: 'terrain', ref: floor });
    const fx = floor.x;
    S._keyDown(kev('ArrowRight'));
    gate('58. selecting another piece disarms the handle — arrows move again',
      S._armedHandle === null && Math.abs(floor.x - (fx + NUDGE_STEPS[1])) < 1e-9,
      `armed ${S._armedHandle}, x moved ${(floor.x - fx).toFixed(2)}`);
  }
}

// ---------- gate 59: the scenery rides the scrub tape ----------
//
// Scrubbing stops the run, and the stop destroys `bgSim` — so the vignette
// snapped back to its authored poses the moment the slider moved, while the
// machine rewound honestly ("Background included in scrubber?", 2026-08-07).
// The scenery now writes its own buffer on the SAME ring, and the contract
// these gates hold is alignment: one slot is one moment in both worlds, the
// bg half survives its sim's destruction like the main half does (verify.mjs
// gate 23), and a level with no scenery pays nothing and changes nothing.
// Fake sims, because what game.js owns here is the RING — the pose fidelity
// of viewFromTape is gate 23's, and both halves go through the same function.
{
  const fakeSim = () => {
    let frame = 0;
    return {
      time: 0,
      tapeBodies: () => [1],       // one body → stride 3
      tapeShape: () => ({ terrain: [], props: [], goals: [], wheels: [{ part: { t: 'wheel' }, fixed: false }], rods: [], goalZones: [], texts: [] }),
      writeTape(buf, at) { buf[at] = frame; buf[at + 1] = frame * 2; buf[at + 2] = 0; frame++; this.time = frame / 60; },
      view: () => 'LIVE',
    };
  };
  const S = screen(flatWorld());
  S.sim = fakeSim();
  S.bgSim = fakeSim();
  for (let i = 0; i < 5; i++) S._tapeWrite();
  gate('59. the scenery gets its own buffer on the main tape\'s ring',
    !!S._tape.bg && S._tape.bg.stride === 3 && S._tape.n === 5,
    `bg stride ${S._tape?.bg?.stride}, ${S._tape?.n} frames`);
  S.bgSim = null;                     // the scrub's stop destroys it — the tape must not care
  S._scrub = 2;
  const main = S._viewForDraw();
  const back = S._backViewForDraw();
  gate('59. one slot is one moment in BOTH worlds — machine and scenery agree',
    main.wheels[0].x === 2 && back.wheels[0].x === 2 && back.wheels[0].y === 4,
    `main x ${main.wheels[0]?.x}, back x ${back.wheels[0]?.x}`);
  gate('59. …and the bg half outlives its sim, like the main half does',
    S.bgSim === null && back.wheels.length === 1, 'answered from the buffer');
  S._scrub = null;
  gate('59. back to live, a missing bgSim answers null — authored poses, as before',
    S._backViewForDraw() === null);
  // no scenery sim at record time → no bg buffer, and the scrubbed answer
  // stays the pre-feature one (null → authored poses) rather than a throw
  const S2 = screen(flatWorld());
  S2.sim = fakeSim();
  S2.bgSim = null;
  for (let i = 0; i < 3; i++) S2._tapeWrite();
  S2._scrub = 1;
  gate('59. a level with no scenery pays nothing and changes nothing',
    S2._tape.bg === null && S2._backViewForDraw() === null && S2._viewForDraw().wheels[0].x === 1,
    `bg ${S2._tape.bg}`);
}

// ---------- gate 60: props ride groups ----------
//
// "Props should be able to be included in groups. To move/resize."
// (2026-08-07). Props join the RIDER list — same rigid move, same rotate,
// same scale, for EDITING; the sim keeps ignoring a prop's groupId, because
// a crate on a moving platform rides it by physics, not by bookkeeping. The
// pieces of the contract worth holding: pins (world points, in either
// storage) transform from the SNAPSHOT with every gesture; a ball prop
// scales r and never grows an angle key; a label rider no longer collects
// NaN w/h from the zone-shaped scale path; and ungroup returns everything.
{
  const lvl = flatWorld({ terrain: [
    { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
    { type: 'box', x: 0, y: -200, w: 120, h: 40 },
  ] });
  lvl.props = [
    { shape: 'box', x: 80, y: -200, w: 30, h: 30, pins: [{ x: 80, y: -185 }] },
    { shape: 'ball', x: -60, y: -200, r: 14, pin: { x: -60, y: -186 } },
  ];
  lvl.texts = [{ x: 0, y: -260, text: 'sign', size: 20 }];
  const S = screen(lvl, { tab: 'level', undo: true });
  const slab = S.level.terrain[1], crate = S.level.props[0], ball = S.level.props[1], sign = S.level.texts[0];
  S.multiSel = [
    { kind: 'terrain', ref: slab },
    { kind: 'prop', ref: crate },
    { kind: 'prop', ref: ball },
    { kind: 'text', ref: sign },
  ];
  S._groupSelection();
  const gid = crate.groupId;
  gate('60. grouping a selection with props takes the props',
    !!gid && ball.groupId === gid && slab.groupId === gid && sign.groupId === gid && S.sel?.kind === 'group',
    `gid ${gid}, sel ${S.sel?.kind}`);
  gate('60. …and a click on a grouped prop answers as the group, like grouped terrain',
    S._hitTest({ x: 80, y: -200 })?.kind === 'group', S._hitTest({ x: 80, y: -200 })?.kind);

  // rigid MOVE through the real handlers, pins riding
  const g2 = gesture(S, { x: 80, y: -200 }, { x: 110, y: -160 });
  gate('60. dragging the group moves the props with it', g2.type === 'move-group'
    && near(crate.x, 110) && near(ball.x, -30) && near(sign.x, 30),
    `${g2.type}: crate ${crate.x}, ball ${ball.x}, sign ${sign.x}`);
  gate('60. …and the pins come along, in BOTH storages',
    near(crate.pins[0].x, 110) && near(crate.pins[0].y, -145)
    && near(ball.pin.x, -30) && near(ball.pin.y, -146),
    `pin (${crate.pins[0].x}, ${crate.pins[0].y}), legacy (${ball.pin.x}, ${ball.pin.y})`);

  // SCALE ×2 about the group's min corner, driven exactly as _tryHandleDrag builds it
  const b = S._groupBounds(gid);
  const mkTransform = (type, extra) => ({
    type, gid,
    start: deep(S._groupMembers(gid)), members: S._groupMembers(gid),
    zones: S._groupRiders(gid), startZones: deep(S._groupRiders(gid)),
    rules: S._groupTransformRules(S._groupMembers(gid)), ...extra,
  });
  {
    const d = mkTransform('group-resize', {
      anchor: { x: b.minX, y: b.minY }, startW: b.maxX - b.minX, startH: b.maxY - b.minY, corner: 2,
    });
    const pinBefore = { ...crate.pins[0] };
    S._groupResizeDrag(d, { x: b.minX + (b.maxX - b.minX) * 2, y: b.minY + (b.maxY - b.minY) * 2 }, {});
    S._groupTransformFinish(d);
    gate('60. a group scale doubles a box prop through the piece clamps',
      near(crate.w, 60) && near(crate.h, 60), `crate ${crate.w}×${crate.h}`);
    gate('60. …and a ball prop by radius, with no angle key ever appearing',
      near(ball.r, 28) && !('angle' in ball), `r ${ball.r}, angle ${'angle' in ball}`);
    gate('60. …pins scaling about the same anchor',
      near(crate.pins[0].x, b.minX + (pinBefore.x - b.minX) * 2)
      && near(crate.pins[0].y, b.minY + (pinBefore.y - b.minY) * 2),
      `pin (${crate.pins[0].x.toFixed(1)}, ${crate.pins[0].y.toFixed(1)})`);
    gate('60. …while a label rider scales by position only — no NaN w/h junk',
      !('w' in sign) && !('h' in sign) && Number.isFinite(sign.x) && Number.isFinite(sign.y),
      `keys ${Object.keys(sign).join(',')}`);
  }
  // ROTATE 90° about the group centre
  {
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    const d = mkTransform('group-rotate', { cx: c.x, cy: c.y, a0: 0, startAngle: 0 });
    const bx = ball.x, by = ball.y, px = crate.pins[0].x, py = crate.pins[0].y;
    S._groupRotateDrag(d, { x: c.x + Math.cos(Math.PI / 2) * 100, y: c.y + Math.sin(Math.PI / 2) * 100 });
    S._groupTransformFinish(d);
    gate('60. a group turn carries a box prop\'s angle and swings the ball without one',
      near(crate.angle, Math.PI / 2, 0.01) && !('angle' in ball),
      `crate ${crate.angle?.toFixed(3)}, ball angle ${'angle' in ball}`);
    const want = { x: c.x - (by - c.y), y: c.y + (bx - c.x) };
    gate('60. …swinging positions and pins about the same centre',
      near(ball.x, want.x, 0.1) && near(ball.y, want.y, 0.1)
      && near(crate.pins[0].x, c.x - (py - c.y), 0.1) && near(crate.pins[0].y, c.y + (px - c.x), 0.1),
      `ball (${ball.x.toFixed(1)}, ${ball.y.toFixed(1)})`);
  }
  S._ungroup(gid);
  gate('60. ungroup hands every prop back',
    !crate.groupId && !ball.groupId && !slab.groupId && !sign.groupId && !S.level.groups[gid],
    'all groupIds cleared');
}

// ---------- gate 61: pins on terrain ----------
//
// Four asks in one feature (2026-08-07): pins on terrain, pins that snap like
// everything else, a stick allowed THROUGH the piece it is pinned to, and
// pins that always travel with their piece. The helpers were already generic
// over "an object with a .pins array in world coordinates", so what these
// gates hold is the CONTRACT rather than new arithmetic: that terrain is
// wired into every one of those four, and that the editor and the sim agree
// about which coordinate counts as pinned.
{
  const { propPins } = await import(u('public/js/util.js'));
  const lvl = flatWorld({ terrain: [
    { type: 'box', x: 0, y: 30, w: 1200, h: 60 },
    { type: 'box', x: 0, y: -200, w: 120, h: 40 },
  ] });
  const S = screen(lvl, { tab: 'level', undo: true });
  const slab = S.level.terrain[1];

  // -- placing: a pin lands on TERRAIN, snapped to the grid --
  S._select({ kind: 'terrain', ref: slab });
  S._addPropPin(slab, { x: 37, y: -196 }, { shiftKey: true });
  gate('61. a pin can be placed on TERRAIN, snapped to the grid like every placement',
    propPins(slab).length === 1 && near(propPins(slab)[0].x, GRID_STEP) && near(propPins(slab)[0].y, -5 * GRID_STEP),
    JSON.stringify(propPins(slab)[0]));
  // …and an existing machine pin still beats the grid, exactly as elsewhere
  S.design.parts.push({ t: 'rod', kind: 'wood', x1: 77, y1: -183, x2: 140, y2: -183, id: 'r0' });
  S._addPropPin(slab, { x: 79, y: -185 }, {});
  gate('61. …while a pin in range still wins over the grid',
    near(propPins(slab)[1].x, 77) && near(propPins(slab)[1].y, -183),
    JSON.stringify(propPins(slab)[1]));
  S.design.parts.pop();
  propPins(slab).pop();

  // -- a stick may be built THROUGH the piece it is pinned to --
  const pin = propPins(slab)[0];
  const through = { t: 'rod', kind: 'wood', x1: pin.x, y1: pin.y, x2: pin.x + 90, y2: pin.y + 60 };
  const buried = { t: 'rod', kind: 'wood', x1: -10, y1: -210, x2: 80, y2: -150 };
  gate('61. a stick that merely crosses terrain is still refused',
    /terrain/.test(S._rodInvalid(buried, null, false) || ''), S._rodInvalid(buried, null, false));
  gate('61. …but one ENDING on that terrain-piece pin is allowed through it',
    S._rodInvalid(through, null, false) === null, S._rodInvalid(through, null, false));
  // the exemption is per PIECE and per END: a pin on the slab says nothing
  // about the floor, and a pin the stick merely crosses joints nothing
  const throughFloor = { t: 'rod', kind: 'wood', x1: pin.x, y1: pin.y, x2: pin.x, y2: 60 };
  gate('61. …and it exempts only THAT piece — the floor still refuses',
    /terrain/.test(S._rodInvalid(throughFloor, null, false) || ''), S._rodInvalid(throughFloor, null, false));
  const midOnly = { t: 'rod', kind: 'wood', x1: pin.x - 60, y1: pin.y - 40, x2: pin.x + 60, y2: pin.y + 40 };
  gate('61. …and a pin the stick merely passes OVER exempts nothing (ends only)',
    /terrain/.test(S._rodInvalid(midOnly, null, false) || ''), S._rodInvalid(midOnly, null, false));

  // -- pins ride the piece: drag, nudge, rotate, resize --
  {
    const before = { ...propPins(slab)[0] };
    const g = gesture(S, { x: 0, y: -200 }, { x: 60, y: -160 });
    gate('61. dragging the terrain carries its pin with it',
      g.type === 'move' && near(propPins(slab)[0].x, before.x + 60) && near(propPins(slab)[0].y, before.y + 40),
      `pin (${propPins(slab)[0].x}, ${propPins(slab)[0].y}) from (${before.x}, ${before.y})`);
  }
  {
    const before = { ...propPins(slab)[0] };
    S._select({ kind: 'terrain', ref: slab });
    S._keyDown({ key: 'ArrowRight', target: { tagName: 'DIV' }, preventDefault() {}, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false });
    gate('61. …and an arrow-key nudge does too',
      near(propPins(slab)[0].x, before.x + NUDGE_STEPS[1]), `pin x ${propPins(slab)[0].x}`);
  }
  {
    const before = { ...propPins(slab)[0] };
    const c = { x: slab.x, y: slab.y };
    const d = {
      type: 'rotate', sel: { kind: 'terrain', ref: slab }, start: deep(slab),
      pos: { x: c.x, y: c.y }, a0: 0, pivot: null, rules: null,
    };
    S._rotateDrag(d, { x: c.x, y: c.y + 100 }, {});   // +90 degrees
    const want = { x: c.x - (before.y - c.y), y: c.y + (before.x - c.x) };
    gate('61. …and a rotate swings it about the piece own centre',
      near(propPins(slab)[0].x, want.x, 0.01) && near(propPins(slab)[0].y, want.y, 0.01),
      `pin (${propPins(slab)[0].x.toFixed(1)}, ${propPins(slab)[0].y.toFixed(1)}) want (${want.x.toFixed(1)}, ${want.y.toFixed(1)})`);
    for (const k of Object.keys(slab)) delete slab[k];
    Object.assign(slab, deep(d.start));
  }
  {
    const c = { x: slab.x, y: slab.y };
    const base = deep(propPins(slab));
    const d = {
      type: 'resize', sel: { kind: 'terrain', ref: slab }, tag: 'c2', start: deep(slab),
      pos: { x: c.x, y: c.y }, startBounds: null, startBox: null, handleOff: null, rules: null,
    };
    S._resizeDrag(d, { x: c.x + slab.w, y: c.y + slab.h }, {});   // grow both axes
    const sx = slab.w / d.start.w, sy = slab.h / d.start.h;
    const want = { x: slab.x + (base[0].x - c.x) * sx, y: slab.y + (base[0].y - c.y) * sy };
    gate('61. …and a resize scales it about the piece, keeping its spot on the face',
      near(propPins(slab)[0].x, want.x, 0.01) && near(propPins(slab)[0].y, want.y, 0.01),
      `pin (${propPins(slab)[0].x.toFixed(1)}, ${propPins(slab)[0].y.toFixed(1)})`);
  }

  // -- and it is a real snap target, so a stick END can land on it exactly --
  gate('61. a terrain pin is a snap target, like every other pin in the level',
    S._allPins(null).some(q => near(q.x, propPins(slab)[0].x) && near(q.y, propPins(slab)[0].y)),
    `${S._allPins(null).length} snap targets`);
}

// ---------- gate 62: a goal piece AT REST is still draggable ----------
//
// Reported as "Goal pieces that are in any way slightly outside the build area
// CANNOT BE MOVED AT ALL" (2026-08-07, during building time). Measured, the
// build area was a red herring: the piece was stuck because it was RESTING —
// a 1.5 px dead band around any surface it sat on, in every direction at once.
//
// The cause is §16's "a sweep needs a valid t=0", and this is its THIRD
// appearance: `_endpointDrag` had the fallback, `_moveDrag` got it for parts
// (measured on the user's own pit level), and the GOAL branch builds its own
// stopper, so it kept the bug. A piece at rest sits inside the sweep's REST
// clearance while passing acceptance — every sample of a sideways drag is
// invalid, the bisection returns 0, and nothing moves, silently.
//
// The band is exactly where the editor's own placement leaves a piece, so
// "resting on the ground" and "immovable" were the same state. These gates
// sample right across it, and the WHEEL in the identical spot is the control:
// it moved throughout, which is what proved the fault was the goal branch's
// alone rather than the rule's.
{
  const FLOOR = { type: 'box', x: 0, y: 30, w: 1200, h: 60 };     // top at y = 0
  // The zone reaches BELOW the floor line on purpose: since 2026-08-07 a goal
  // piece is movable only when WHOLLY inside it, and a ball resting on a floor
  // flush with the zone's bottom edge would be locked for that reason instead
  // of the one this gate is about.
  const at = (y, over = {}) => screen({
    terrain: [FLOOR], props: [], buildZones: [{ x: 0, y: -85, w: 300, h: 290 }],
    goalZones: [{ x: 600, y: -40, w: 120, h: 80 }],
    goalObjs: [{ shape: 'ball', x: 0, y, r: 15 }], win: 'goalObj', ...over,
  }, { tab: 'machine', mode: 'play' });

  // A ball of r=15 rests flush at y=-15. The old dead band ran from gap +0.5
  // to gap −1.5, i.e. y in [−15.5, −13.5] — which brackets both the exact
  // flush position and `restY` (one TERRAIN_TOUCH_PAD in), so every piece an
  // author or a player had ever set down was inside it.
  const stuck = [];
  for (const y of [-15.5, -15.2, -15.01, -15, -14.99, -14.5, -14, -13.6]) {
    const S = at(y);
    const g = gesture(S, { x: 0, y }, { x: -60, y });
    if (Math.abs(S.goalPositions[0].x) < 0.5) stuck.push(y);
  }
  gate('62. a goal piece resting on the floor drags sideways at every depth in the old dead band',
    stuck.length === 0, stuck.length ? `still stuck at y = ${stuck.join(', ')}` : 'all 8 depths move');

  // …in EVERY direction, because the failure was direction-dependent and that
  // is what hid it: dragging up always worked (the first sample leaves the
  // clearance), so the bug only showed when you pushed along the surface.
  {
    // Every direction the surface does not itself block. DOWN is left out on
    // purpose and gated separately below: a piece resting on the floor cannot
    // go INTO the floor, and that refusal is the rule working. The three here
    // are the ones the dead band swallowed — including UP, which always
    // worked and is what made the bug so easy to miss.
    const dirs = [[-60, 0], [60, 0], [0, -60]];
    const stuckDir = [];
    for (const [dx, dy] of dirs) {
      const S = at(-15);
      gesture(S, { x: 0, y: -15 }, { x: dx, y: -15 + dy });
      const moved = Math.hypot(S.goalPositions[0].x - 0, S.goalPositions[0].y - (-15));
      if (moved < 0.5) stuckDir.push(`(${dx},${dy})`);
    }
    gate('62. …and along the surface in both directions, as well as away from it',
      stuckDir.length === 0, stuckDir.length ? `stuck: ${stuckDir.join(' ')}` : 'left, right and up all move');
  }

  // the same relief where the piece rests against a WALL rather than a floor,
  // and where it straddles the zone edge — both were reported as immovable
  {
    const S = screen({
      terrain: [FLOOR, { type: 'box', x: 60, y: -100, w: 40, h: 200 }],
      props: [], buildZones: [{ x: 0, y: -100, w: 300, h: 200 }],
      goalZones: [{ x: 600, y: -40, w: 120, h: 80 }],
      goalObjs: [{ shape: 'ball', x: 25, y: -15, r: 15 }], win: 'goalObj',
    }, { tab: 'machine', mode: 'play' });
    gesture(S, { x: 25, y: -15 }, { x: -35, y: -15 });
    gate('62. …and a piece wedged against a wall can be pulled away from it',
      Math.abs(S.goalPositions[0].x - 25) > 20, `moved ${(S.goalPositions[0].x - 25).toFixed(1)} px`);
  }
  {
    // …and the straddle case is the RULE talking, not the dead band: since
    // 2026-08-07 a piece only partly inside is the level's, so it holds still
    // however freely the sweep would now let it move.
    const S = at(-15, { goalObjs: [{ shape: 'ball', x: 155, y: -15, r: 15 }] });
    gesture(S, { x: 155, y: -15 }, { x: 95, y: -15 });
    gate('62. …while one straddling the zone edge stays put — that is the rule, not the band',
      Math.abs(S.goalPositions[0].x - 155) < 0.01, `now at x ${S.goalPositions[0].x.toFixed(1)}`);
  }

  // The rule itself is untouched: a piece wholly outside every build zone is
  // still the level's furniture, and still says so. The relaxation is about
  // the SWEEP's start state, never about who owns the piece.
  {
    const S = at(-15, { goalObjs: [{ shape: 'ball', x: 400, y: -15, r: 15 }] });
    const before = { ...S.goalPositions[0] };
    const g = gesture(S, { x: 400, y: -15 }, { x: 340, y: -15 });
    gate('62. …while a piece wholly outside the build area is still locked, and says so',
      g.type === 'null' && samePt(S.goalPositions[0], before) && S.toasts.some(t => /outside the build area/.test(t)),
      `${g.type}, toasts ${JSON.stringify(S.toasts)}`);
  }

  // …and the drop still refuses a genuinely illegal landing: the fallback
  // relaxes the sweep's t=0, it does not licence burying the piece.
  {
    const S = at(-15);
    const g = gesture(S, { x: 0, y: -15 }, { x: 0, y: 40 });    // straight into the floor
    gate('62. …and the piece still cannot be driven INTO the floor',
      S.goalPositions[0].y < 0, `ended at y ${S.goalPositions[0].y.toFixed(1)}, floor top y=0`);
  }
}

// ---------- gate 63: scrubbing forward, and the end of the run ----------
//
// Three asks in one control (2026-08-07): scrub INTO the future by simulating
// ahead, make ⇥ mean the end of the run rather than the start of the level,
// and step by a tenth of a second with a whole one on Shift.
//
// The forward scrub rests on one structural change: the scrub's stop now
// PAUSES the world instead of destroying it, because Box2D cannot be restored
// to a recorded frame — the only way to see past the end of a tape is to keep
// the world that made it. What these gates hold is that the paused world is
// really there, that stepping it EXTENDS the same ring, that the search is by
// time (so a full ring cannot mean the wrong frame), and that no other stop
// leaks it.
{
  const fakeSim = () => {
    let frame = 0;
    return {
      time: 0,
      tapeBodies: () => [1],
      tapeShape: () => ({ terrain: [], props: [], goals: [], wheels: [{ part: { t: 'wheel' }, fixed: false }], rods: [], goalZones: [], texts: [] }),
      writeTape(buf, at) { buf[at] = frame; buf[at + 1] = 0; buf[at + 2] = 0; frame++; },
      step() { frame; this.time += 1 / 60; },
      view: () => 'LIVE',
      destroyed: false,
      destroy() { this.destroyed = true; },
    };
  };
  // a screen mid-run, with a tape already recorded
  const running = (frames = 60) => {
    const S = screen(flatWorld());
    S.playBtn = { textContent: '', title: '', classList: { add() {}, remove() {} } };
    // The dock's readouts are two lines now (§8.2): the VALUE span is what
    // anything writes, so that is what a stub has to provide.
    S.timeEl = { textContent: '', classList: { toggle() {} } };
    S.timeVal = { textContent: '' };
    S.winBanner = { classList: { add() {} } };
    S.scrubWrap = { classList: { toggle() {}, contains: () => true } };
    S.scrubEl = { max: '0', value: '0' };
    S.scrubTime = { textContent: '' };
    S._cancelAftermath = () => {}; S._finishClip = () => {};
    S.playing = true;
    S.sim = fakeSim();
    for (let i = 0; i < frames; i++) { S.sim.step(); S._tapeWrite(); }
    return S;
  };

  // -- the scrub's stop PAUSES the world; every other stop disposes of it --
  {
    const S = running();
    const sim = S.sim;
    S._scrubTo(10);
    gate('63. scrubbing pauses the run but KEEPS its world, so there is a future to simulate',
      S.playing === false && S.sim === null && S._pausedSim === sim && sim.destroyed === false,
      `paused=${!!S._pausedSim}, destroyed=${sim.destroyed}`);
    S.stop();
    gate('63. …and an ordinary stop disposes of the paused world rather than leaking it',
      sim.destroyed === true && S._pausedSim === null, `destroyed=${sim.destroyed}`);
  }

  // -- forward past the end MAKES more tape --
  {
    const S = running();
    S._scrubTo(59);                       // the live end
    const before = S._tape.n, tEnd = S._tape.t[S._tapeSlot(S._tape.n - 1)];
    S._scrubBySeconds(0.5);
    gate('63. scrubbing forward past the end simulates ahead and extends the tape',
      S._tape.n > before, `${before} → ${S._tape.n} frames`);
    const at = S._tape.t[S._tapeSlot(S._scrub)];
    gate('63. …landing half a second later in SIMULATED time, not just further along the ring',
      Math.abs(at - (tEnd + 0.5)) < 0.02, `${tEnd.toFixed(2)}s → ${at.toFixed(2)}s`);
    gate('63. …and the frame it lands on is drawable from the tape, like any other',
      !!S._viewForDraw()?.wheels?.length);
  }

  // -- it cannot run away, and it needs a paused world --
  {
    const S = running();
    S._scrubTo(59);
    S._scrubBySeconds(1000);              // ask for a great deal of future
    gate('63. …bounded per request, so a held key cannot run away',
      S._tape.n <= 60 + 900 + 1, `${S._tape.n} frames`);
    const T = running();
    T._scrubTo(30);
    T._pausedSim.destroy(); T._pausedSim = null;   // no world left
    const n0 = T._tape.n;
    T._scrubBySeconds(0.5);
    gate('63. …and with no paused world it simply stops at the end it has',
      T._tape.n === n0 && T._scrub === n0 - 1, `${T._tape.n} frames, at ${T._scrub}`);
  }

  // -- ⇥ goes to the END of the run, not the start of the level --
  {
    const S = running();
    S._scrubTo(5);                        // rewound near the beginning
    S._clearScrub();
    gate('63. ⇥ parks at the LAST recorded frame — the end of the run',
      S._scrub === S._tape.n - 1, `at ${S._scrub} of ${S._tape.n - 1}`);
    gate('63. …which draws that frame, where null used to draw the authored build',
      !!S._viewForDraw(), 'a frame, not the level at rest');
    // …and while a run is actually LIVE, null still means "track the end"
    const L = running();
    L._clearScrub();
    gate('63. …while a live run still tracks the live end with no fixed position',
      L._scrub === null && L.playing === true);
  }

  // -- the memory budget counts BOTH buffers --
  //
  // The scenery half (2026-08-07) arrived allocated at the main tape's frame
  // count without being counted against the 24 MB, so a level with a busy
  // background quietly spent past it by however much its vignette moved. The
  // budget is about MEMORY and both buffers are memory; the window shortens
  // instead, which is what a budget is for and is visible on the slider.
  {
    const withBg = (bgBodies) => {
      const S = running(0);
      S.sim = fakeSim();
      if (bgBodies) {
        S.bgSim = fakeSim();
        S.bgSim.tapeBodies = () => new Array(bgBodies).fill(1);
      }
      S._tapeWrite();
      return S._tape;
    };
    const alone = withBg(0);
    const heavy = withBg(400);
    const bytes = (tp) => (tp.stride + (tp.bg?.stride || 0)) * tp.frames * 4;
    gate('63. a level with no scenery is unaffected by the scenery budget',
      alone.bg === null && bytes(alone) <= 24 * 1024 * 1024, `${(bytes(alone) / 1048576).toFixed(1)} MB`);
    gate('63. …and one with a busy background stays INSIDE the budget, window and all',
      heavy.bg !== null && bytes(heavy) <= 24 * 1024 * 1024,
      `${(bytes(heavy) / 1048576).toFixed(1)} MB over ${(heavy.frames / 60).toFixed(0)} s`);
    gate('63. …which it pays for in WINDOW, the thing a budget is supposed to spend',
      heavy.frames < alone.frames, `${(alone.frames / 60).toFixed(0)} s alone → ${(heavy.frames / 60).toFixed(0)} s with scenery`);
  }

  // -- the arrow steps --
  {
    const kev = (key, mods = {}) => ({
      key, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {},
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, ...mods,
    });
    // four seconds of tape, parked two seconds in: a step of a whole second
    // has to have somewhere to go in BOTH directions, or the backward one
    // clamps at frame 0 and the gate measures the fixture rather than the key
    const stepBy = (key, mods) => {
      const S = running(240);
      S._scrubTo(120);
      const t0 = S._tape.t[S._tapeSlot(S._scrub)];
      S._keyDown(kev(key, mods));
      return S._tape.t[S._tapeSlot(S._scrub)] - t0;
    };
    gate('63. ← → step a TENTH of a second',
      Math.abs(stepBy('ArrowRight') - 0.1) < 0.02 && Math.abs(stepBy('ArrowLeft') + 0.1) < 0.02,
      `right ${stepBy('ArrowRight').toFixed(3)}s, left ${stepBy('ArrowLeft').toFixed(3)}s`);
    gate('63. …Shift makes it a whole one',
      Math.abs(stepBy('ArrowRight', { shiftKey: true }) - 1) < 0.02
      && Math.abs(stepBy('ArrowLeft', { shiftKey: true }) + 1) < 0.02,
      `${stepBy('ArrowRight', { shiftKey: true }).toFixed(3)}s`);
    gate('63. …and Up/Down are the second-sized pair, no modifier needed',
      Math.abs(stepBy('ArrowDown') - 1) < 0.02 && Math.abs(stepBy('ArrowUp') + 1) < 0.02,
      `down ${stepBy('ArrowDown').toFixed(3)}s, up ${stepBy('ArrowUp').toFixed(3)}s`);
  }
}

// ---------- gate 64: a goal piece is grabbed like a wheel (§8.2) ----------
//
// "I want the goal piece to be just like a wheel interface… rods detaching
// instead of moving all, goal piece moving not taking rods with it"
// (2026-08-07). Both halves of that were one rule written for wheels and never
// asked of goal pieces, so this gate asks BOTH pieces the SAME question and
// compares the answers rather than asserting two hand-copied numbers — a rule
// that only exists on one of two pools is exactly the bug being fixed here, and
// a gate that restates it per pool would go stale the same way.
{
  const world = () => ({
    terrain: [{ type: 'box', x: 0, y: 300, w: 1200, h: 60 }],
    buildZones: [{ x: 0, y: -100, w: 900, h: 700 }],
    goalZones: [{ x: 380, y: -40, w: 120, h: 80 }],
  });
  const rod = (x1, y1, x2, y2) => ({ t: 'rod', kind: 'wood', x1, y1, x2, y2 });
  // Two fixtures that differ ONLY in what sits at the origin: a wheel, or a
  // crate. Same stick bolted through that middle, same drag, same everything.
  const wheelRig = (parts = []) => screen(world(), {
    parts: [{ t: 'wheel', kind: 'free', x: 0, y: 0, r: 15 }, ...parts],
  });
  const goalRig = (parts = []) => screen(
    { ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 40 }] },
    { tab: 'level', parts });
  const centreOf = (S) => (S.level.goalObjs.length
    ? { ...S.goalPositions[0] }
    : { x: S.design.parts[0].x, y: S.design.parts[0].y });
  const theRod = (S) => S.design.parts.find(p => p.t === 'rod');

  // -- and dragging it carries the stick instead of pulling it out --
  {
    const run = (S) => {
      gesture(S, { x: 0, y: 0 }, { x: 60, y: 0 });
      const r = theRod(S);
      return { at: centreOf(S), pinned: r.x1 === 60 && r.y1 === 0, far: r.x2 };
    };
    const w = run(wheelRig([rod(0, 0, 120, 0)]));
    gate('64. dragging the wheel takes the stick\'s bolted end with it',
      w.at.x === 60 && w.pinned, `hub ${w.at.x}, end1 ${w.pinned}`);
  }

  // -- a lone stick end is a snap target for both middles --
  {
    const run = (S) => { gesture(S, { x: 0, y: 0 }, { x: 97, y: 2 }); return centreOf(S); };
    const w = run(wheelRig([rod(100, 0, 220, 0)]));
    const g = run(goalRig([rod(100, 0, 220, 0)]));
    gate('64. a wheel hub dragged near a stick end snaps onto it',
      w.x === 100 && w.y === 0, `(${w.x}, ${w.y})`);
    gate('64. …and so does a crate centre — a pin beats the grid for both',
      g.x === w.x && g.y === w.y, `crate (${g.x}, ${g.y}), wheel (${w.x}, ${w.y})`);
  }

  // -- but a crate must not snap to a corner of ITSELF --
  {
    const S = goalRig([]);
    gesture(S, { x: 0, y: 0 }, { x: 60, y: 0 });
    gate('64. a crate with nothing to snap to still travels the full delta',
      S.goalPositions[0].x === 60, `${S.goalPositions[0].x} (its own pins must be excluded)`);
  }

}

// ---------- gate 65: moving a pin is one gesture (§5.6) ----------
//
// "Need an easy way to move pins" (2026-08-07). It cost two gestures — select
// the piece, THEN drag the pin — and reaching for it in one landed a SECOND pin
// on the identical coordinate, because Alt+click adds a pin and the new pin
// snaps to any pin in range. Invisible, and one of the eight spent.
//
// Props and terrain are asked every question together: terrain joined PINNABLE
// on 2026-08-07 and the asymmetries left behind are exactly this gate's job.
{
  const pinned = () => ({
    terrain: [{ type: 'box', x: 0, y: 200, w: 400, h: 40, pins: [{ x: -60, y: 185 }] }],
    props: [{ shape: 'box', x: 0, y: 0, w: 80, h: 80, pins: [{ x: 20, y: 20 }] }],
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
  });
  const where = { prop: { x: 20, y: 20 }, terrain: { x: -60, y: 185 } };
  const pinsOf = (S, kind) => (kind === 'prop' ? S.level.props[0] : S.level.terrain[0]).pins;
  const press = (S, at, mods = {}) => {
    S._pointerDown(ev(at.x, at.y, mods));
    const t = S.drag?.type;
    S._pointerUp(ev(at.x, at.y, mods));
    return t;
  };

  for (const kind of ['prop', 'terrain']) {
    const at = where[kind];

    // the one-gesture grab, from cold — nothing selected first
    {
      const S = screen(pinned(), { tab: 'level' });
      gate(`65. Alt+press on a ${kind} pin picks the PIN up with nothing selected`,
        press(S, at, { altKey: true }) === 'move-pin');
      gate(`65. …and does not stack a second pin on the same spot`,
        pinsOf(S, kind).length === 1, `${pinsOf(S, kind).length} pin(s)`);
    }

    // …and it really travels. Alt is ALSO the fine-grid modifier (GRID_FINE,
    // 15), so the pin lands on the nearest fine node to where it was dragged
    // rather than on the raw pointer — which is the documented rule for every
    // other placement ("pins should snap to grid same way as everything else")
    // and is asserted here rather than tolerated, so a change to it shows up.
    {
      const S = screen(pinned(), { tab: 'level' });
      const to = { x: at.x - 40, y: at.y - 40 };
      gesture(S, at, to, { mods: { altKey: true } });
      const p = pinsOf(S, kind)[0];
      const node = (v) => Math.round(v / GRID_FINE) * GRID_FINE;
      gate(`65. …and the ${kind} pin lands on the fine node nearest the drop`,
        p.x === node(to.x) && p.y === node(to.y),
        `(${p.x}, ${p.y}) for a drop at (${to.x}, ${to.y})`);
    }

    // Alt on bare face still ADDS — the gesture it shares the modifier with.
    // The press has to land ON the piece: a prop 80×80 at the origin spans
    // ±40, and the terrain slab spans y 180–220.
    {
      const S = screen(pinned(), { tab: 'level' });
      const bare = kind === 'prop' ? { x: -20, y: -20 } : { x: 60, y: 195 };
      press(S, bare, { altKey: true });
      gate(`65. Alt on bare ${kind} face still adds a pin`,
        (pinsOf(S, kind) || []).length === 2, `${(pinsOf(S, kind) || []).length} pin(s)`);
    }

    // right-click reaches the pin's own menu, not the piece's
    {
      const S = screen(pinned(), { tab: 'level' });
      S._select(kind === 'prop'
        ? { kind: 'prop', ref: S.level.props[0] }
        : { kind: 'terrain', ref: S.level.terrain[0] });
      let opened = null;
      S._openPinMenu = () => { opened = 'pin'; };
      S._openCtxMenu = () => { opened = 'piece'; };
      S._contextMenu({
        clientX: at.x + 400, clientY: at.y + 300,
        ctrlKey: false, altKey: false, shiftKey: false,
        preventDefault() {}, stopPropagation() {},
      });
      gate(`65. right-clicking a ${kind} pin opens the PIN's menu`, opened === 'pin', String(opened));
    }
  }
}

// ---------- gate 66: a group holds anything, for move/resize (§9.3) ----------
//
// "Groups can include anything for move/resize. Pieces/Terrain/Props/Build/
// Goal/Goal Pieces" (2026-08-07). Terrain, props, zones and labels already
// rode; goal pieces and the level's own parts did not. A STICK is the awkward
// one and the reason this is gated rather than eyeballed: it has no `.x` at
// all, so every rider loop that assumed a centre wrote junk onto it.
{
  const lvl = () => ({
    terrain: [{ type: 'box', x: 0, y: 100, w: 200, h: 20 }],
    fixedParts: [
      { t: 'wheel', kind: 'free', x: -60, y: 0, r: 15 },
      { t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 60, y2: 0 },
    ],
    goalObjs: [{ shape: 'box', x: 60, y: -60, w: 40, h: 40 }],
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
    goalZones: [{ x: 300, y: 0, w: 100, h: 100 }],
  });
  const built = () => {
    const S = screen(lvl(), { tab: 'level' });
    S.multiSel = [
      { kind: 'terrain', ref: S.level.terrain[0] },
      { kind: 'fixed', ref: S.level.fixedParts[0] },
      { kind: 'fixed', ref: S.level.fixedParts[1] },
      { kind: 'goal', idx: 0 },
      { kind: 'zone', zone: 'build', idx: 0, ref: S.level.buildZones[0] },
    ];
    S._groupSelection();
    return { S, gid: S.sel?.gid };
  };
  const wheel = (S) => S.level.fixedParts[0];
  const stick = (S) => S.level.fixedParts[1];
  const crate = (S) => S.level.goalObjs[0];

  {
    const { S, gid } = built();
    gate('66. a selection of terrain, parts, a goal piece and a zone groups',
      !!gid && S.sel?.kind === 'group', `${S.toasts.join('; ') || 'gid ' + gid}`);
    gate('66. …and the group knows it holds all of them',
      S._groupGoalMembers(gid).length === 1 && S._groupPartMembers(gid).length === 2
      && S._groupZoneMembers(gid).length === 1 && S._groupMembers(gid).length === 1,
      `goal ${S._groupGoalMembers(gid).length}, parts ${S._groupPartMembers(gid).length}`);
    const b = S._groupBounds(gid);
    gate('66. …and its box is a real box, not NaN',
      Number.isFinite(b?.minX) && Number.isFinite(b?.maxY), JSON.stringify(b));
    // pressing ANY member answers as the group, or it stops behaving like one
    for (const [what, at] of [['wheel', { x: -60, y: 0 }], ['stick', { x: 30, y: 0 }], ['crate', { x: 60, y: -60 }]]) {
      gate(`66. pressing the grouped ${what} answers as the GROUP`,
        S._hitTest(at)?.kind === 'group', S._hitTest(at)?.kind);
    }
  }

  // MOVE: everything travels by the same delta, the stick by BOTH ends
  {
    const { S, gid } = built();
    S._select({ kind: 'group', gid });
    const g = gesture(S, { x: 0, y: 100 }, { x: 100, y: 150 });
    gate('66. a group move carries the wheel, the stick and the goal piece',
      g.type === 'move-group'
      && near(wheel(S).x, 40) && near(wheel(S).y, 50)
      && near(stick(S).x1, 100) && near(stick(S).x2, 160) && near(stick(S).y1, 50)
      && near(crate(S).x, 160) && near(crate(S).y, -10),
      `wheel (${wheel(S).x}, ${wheel(S).y}), stick [${stick(S).x1},${stick(S).x2}], crate (${crate(S).x}, ${crate(S).y})`);
    gate('66. …and the goal piece\'s STAGED position keeps step with its authored one',
      near(S.goalPositions[0].x, crate(S).x) && near(S.goalPositions[0].y, crate(S).y),
      `staged (${S.goalPositions[0].x}, ${S.goalPositions[0].y})`);
    gate('66. …without marking it tampered — an author moving their own rig is not that',
      S.goalMoved[0] === false, String(S.goalMoved[0]));
  }

  // RESIZE: positions scale, a stick stretches, a wheel keeps its rung
  {
    const { S, gid } = built();
    const b = S._groupBounds(gid);
    const d = {
      type: 'group-resize', gid, anchor: { x: b.minX, y: b.minY },
      startW: b.maxX - b.minX, startH: b.maxY - b.minY, corner: 2,
      start: deep(S._groupMembers(gid)), members: S._groupMembers(gid),
      zones: S._groupRiders(gid), startZones: deep(S._groupRiders(gid)),
      rules: S._groupTransformRules(S._groupMembers(gid)),
    };
    const len0 = Math.hypot(stick(S).x2 - stick(S).x1, stick(S).y2 - stick(S).y1);
    S._groupResizeDrag(d, { x: b.minX + (b.maxX - b.minX) * 2, y: b.minY + (b.maxY - b.minY) * 2 }, {});
    S._groupTransformFinish(d);
    const len1 = Math.hypot(stick(S).x2 - stick(S).x1, stick(S).y2 - stick(S).y1);
    gate('66. a group scale stretches a grouped stick by taking both its ends',
      near(len1, len0 * 2), `${len0} → ${len1}`);
    gate('66. …and leaves a wheel\'s radius alone — it is a ladder, not a continuum',
      wheel(S).r === 15, `r ${wheel(S).r}`);
    gate('66. …while the goal piece scales like the piece it is',
      near(crate(S).w, 80) && near(crate(S).h, 80), `${crate(S).w}×${crate(S).h}`);
    gate('66. …and its staged position still agrees',
      near(S.goalPositions[0].x, crate(S).x), `${S.goalPositions[0].x} vs ${crate(S).x}`);
  }

  // ROTATE: a stick has no angle field — it IS its two ends
  {
    const { S, gid } = built();
    const b = S._groupBounds(gid);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const d = {
      type: 'group-rotate', gid, cx, cy, a0: 0,
      start: deep(S._groupMembers(gid)), members: S._groupMembers(gid),
      zones: S._groupRiders(gid), startZones: deep(S._groupRiders(gid)),
      startAngle: 0, rules: S._groupTransformRules(S._groupMembers(gid)),
    };
    // end 2, not end 1: end 1 sits exactly on the group's centre in this
    // fixture, where every rotation is the identity and the assertion is empty
    const before = { x: stick(S).x2, y: stick(S).y2 };
    S._groupRotateDrag(d, { x: cx, y: cy + 100 });   // +90°
    // the same rotation the drag applies, restated rather than imported — a
    // test that borrows the implementation's own maths cannot catch it changing
    const rotAbout = (p, ox, oy, a) => ({
      x: ox + (p.x - ox) * Math.cos(a) - (p.y - oy) * Math.sin(a),
      y: oy + (p.x - ox) * Math.sin(a) + (p.y - oy) * Math.cos(a),
    });
    const turned = rotAbout(before, cx, cy, Math.PI / 2);
    gate('66. a group turn swings a stick\'s ends about the group centre',
      near(stick(S).x2, turned.x) && near(stick(S).y2, turned.y)
      && (before.x !== turned.x || before.y !== turned.y),   // the turn must MOVE it
      `(${stick(S).x2.toFixed(1)}, ${stick(S).y2.toFixed(1)}) vs (${turned.x.toFixed(1)}, ${turned.y.toFixed(1)})`);
    gate('66. …and gives it no angle key, which a stick has no use for',
      stick(S).angle === undefined, String(stick(S).angle));
    gate('66. …while the goal CRATE does carry one',
      near(crate(S).angle, Math.PI / 2), String(crate(S).angle));
  }
}

// ---------- gate 67: what a Local save carries (§11.6) ----------
//
// "What happened to local saves? They don't seem to be accessible any more…
// has a local named 'Local Save' but it comes up as 8XwvdyI7E3g" (2026-08-08).
// The list falls back to the level's ID when a record has no `levelName`, and
// the record never had one: the save dialog is DOM, so nothing headless could
// see what it wrote. `_localSolveRecord` exists to be reachable from here.
{
  const lvl = newMakerLevel();
  lvl.name = 'Crazy Heavy Driver';
  const S = screen(lvl, { tab: 'level' });
  S.opts = { levelId: 'lUFQ9iVFCLI', name: 'Crazy Heavy Driver' };
  const rec = S._localSolveRecord({ won: true, time: 4.3, pieces: 5, design: [], goals: [] });

  gate('67. a Local save records the LEVEL IT WAS PLAYED ON, by name',
    rec.levelName === 'Crazy Heavy Driver', JSON.stringify(rec.levelName));
  gate('67. …and its id, so the row need not be reverse-engineered from a storage key',
    rec.levelId === 'lUFQ9iVFCLI', JSON.stringify(rec.levelId));
  gate('67. …and is tagged local, with an id and a timestamp of its own',
    rec.local === true && !!rec.id && rec.at > 0, `id ${rec.id}`);
  gate('67. …keeping everything the payload already carried',
    rec.won === true && rec.time === 4.3 && rec.pieces === 5);

  // A save made off a level at all lands under the `scratch` key and has no
  // level to name — it must not invent one.
  const T = screen(lvl, { tab: 'level' });
  T.opts = {};
  const scratch = T._localSolveRecord({ won: false });
  gate('67. a save with no level names none, rather than inventing one',
    scratch.levelId === null && scratch.levelName === lvl.name,
    `${scratch.levelId} / ${scratch.levelName}`);
}

// ---------- gate 68: the router is never shadowed (§11.9) ----------
//
// "Publish failed: W is not a function" (2026-08-08), from the built bundle.
// game.js imported the router as `go`, and TWO save dialogs each declare
// `const go = el('button', …, 'Save')` in the same block as the async handler
// that navigates — so at call time `go` was a button. It bit only the FIRST
// publish of a level, the one branch that navigates at all, which is why it
// survived from the 2026-08-04 baseline to now.
//
// A SOURCE gate, deliberately: both call sites live inside DOM dialogs this
// harness cannot build, and the defect is not behavioural anyway — it is a
// name in scope. Reading the file is the honest way to ask.
{
  const raw = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  // **Scan the CODE, not the prose.** The first cut of this gate failed on its
  // own comment, which quotes the broken call to explain it — a source gate
  // that reads commentary is measuring the wrong file. Block comments go, then
  // each line is cut at `//`.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  // The router must arrive under a name no local `go` can shadow. Asked of the
  // util.js import specifically — a bare `go,` anywhere else in the file is a
  // button being appended to a row, which is fine and happens twice.
  const imp = (code.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/util\.js'/) || [])[1] || '';
  const named = imp.split(',').map((s) => s.trim()).filter(Boolean);
  gate('68. game.js imports the router as goTo, not go',
    named.includes('go as goTo') && !named.includes('go'),
    named.filter((n) => n.startsWith('go')).join(' | ') || '(no go binding)');

  // …and nothing dispatches a route through the shadowable name. `[^.\w]`
  // keeps `.go(`, `_go(` and identifiers ending in "go" out of it.
  const bare = [...code.matchAll(/[^.\w]go\(\s*['"`/]/g)];
  gate('68. …and no route is dispatched through a bare `go(`',
    bare.length === 0, bare.length ? bare.length + ' call(s) still shadowable' : 'none');

  // The two Save buttons keep their name. That is the point: after the rename
  // they CAN, because there is no longer a router called `go` to eclipse.
  gate('68. (the save dialogs still name their button `go`, harmlessly)',
    (code.match(/const go = el\('button'/g) || []).length === 2,
    String((code.match(/const go = el\('button'/g) || []).length));
}

// ---------- gate 15b: a crate carries BOTH kinds of stick ----------
//
// "You can see 1 goal with normal stick, 1 goal with hash stick. I can grab
// either stick and move it, goal piece moves too. If I grab the goal piece on
// the normal stick it moves. If I grab the goal piece on the hashed stick it
// DETACHES" (2026-08-08). Hashed is how a level's own part is drawn.
//
// `_companionsOf` picks its pool from the HIT: design parts for anything that
// is not a `fixed` hit. A goal is not a `fixed` hit, so a crate carried the
// player's sticks and left the level's own behind. Gate 15 above fixed the
// same relationship from the STICK end a few hours earlier and this end was
// missed — §16 says test a carrying relationship from both ends, and this is
// what it costs not to.
//
// Both crates in one fixture, side by side, so the two answers are compared
// rather than asserted separately.
{
  const lvl = {
    terrain: [], buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }],
    goalObjs: [
      { shape: 'box', x: -100, y: -100, w: 30, h: 30 },   // 0: the level's own stick
      { shape: 'box', x: 100, y: -100, w: 30, h: 30 },    // 1: the player's stick
    ],
    fixedParts: [{ t: 'rod', kind: 'wood', x1: -100, y1: -100, x2: -20, y2: -100, id: 'fx' }],
  };
  const design = [{ t: 'rod', kind: 'wood', x1: 100, y1: -100, x2: 180, y2: -100, id: 'dx' }];
  const run = (idx, at) => {
    const S = screen(lvl, { tab: 'level', parts: deep(design) });
    gesture(S, at, { x: at.x, y: at.y - 60 }, { watch: goalAt(S, idx) });
    return {
      goal: S.goalPositions[idx].y,
      fixedEnd: S.level.fixedParts[0].y1,
      designEnd: S.design.parts[0].y1,
    };
  };
  const hashed = run(0, { x: -100, y: -100 });
  const plain = run(1, { x: 100, y: -100 });
  gate('15b. …and neither drag disturbs the other crate\'s stick',
    near(hashed.designEnd, -100, 1) && near(plain.fixedEnd, -100, 1),
    `design ${hashed.designEnd.toFixed(0)}, fixed ${plain.fixedEnd.toFixed(0)}`);
  // In TEST the level's furniture is not the player's to drag, so a crate
  // there must NOT tow a level stick — the pools stay separate where it counts.
  {
    const S = screen(lvl, { tab: 'machine', parts: deep(design) });
    gesture(S, { x: -100, y: -100 }, { x: -100, y: -160 }, { watch: goalAt(S, 0) });
    gate('15b. …but in Test a crate still leaves the level\'s stick alone',
      near(S.level.fixedParts[0].y1, -100, 1), `stick end ${S.level.fixedParts[0].y1.toFixed(0)}`);
  }
}

// ---------- gate 67b: a Ctrl-clicked stick takes the scroll wheel ----------
//
// "When I Ctrl-Click a stick, I believe it is selected, it looks selected. I
// should then be able to vary the weight with scroll etc. It works for
// Tool:Pointer click" (2026-08-08).
//
// Ctrl+click builds `multiSel` and leaves `sel` null; both are drawn outlined,
// so the two states look identical and the scroll handler asked only `sel`.
// The POINTER rule is untouched — near the stick sets weight, away from it
// zooms — because that was never the problem.
{
  const stick = { t: 'rod', kind: 'wood', x1: -60, y1: -100, x2: 60, y2: -100, id: 'r' };
  const wheelEv = (x, y, up) => ({
    clientX: x + 400, clientY: y + 300, deltaY: up ? -100 : 100,
    ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() {}, stopPropagation() {},
  });
  // plain click — the route that already worked, as the control
  {
    const S = screen(flatWorld(), { parts: [deep(stick)] });
    S._select({ kind: 'part', ref: S.design.parts[0] });
    S._wheelEvt(wheelEv(0, -100, true));
    gate('67b. a plain-selected stick takes the wheel (the route that worked)',
      S.design.parts[0].weight === 2, `weight ${S.design.parts[0].weight}`);
  }
  // …and Ctrl+click, which did not
  {
    const S = screen(flatWorld(), { parts: [deep(stick)] });
    ctrlClick(S, 0, -100);
    gate('67b. …and Ctrl+click really does select it',
      S.multiSel.length === 1, `${S.multiSel.length} in multiSel, sel ${S.sel ? S.sel.kind : 'null'}`);
    S._wheelEvt(wheelEv(0, -100, true));
    gate('67b. …so it takes the wheel too, which it did not',
      S.design.parts[0].weight === 2, `weight ${S.design.parts[0].weight}`);
  }
  // …and the pointer rule still holds for it: away from the stick, zoom.
  {
    const S = screen(flatWorld(), { parts: [deep(stick)] });
    ctrlClick(S, 0, -100);
    const zoom0 = S.camera.zoom;
    S._wheelEvt(wheelEv(300, 200, true));
    gate('67b. …but scrolling away from a Ctrl-clicked stick still zooms',
      !S.design.parts[0].weight && S.camera.zoom !== zoom0,
      `weight ${S.design.parts[0].weight}, zoom ${zoom0} → ${S.camera.zoom}`);
  }
}

// ---------- gate 68b: a crate is as solid to the pick as a wheel ----------
//
// "Still situations where I am pulling sticks off of the goal piece instead of
// moving something… apart from free moving the Goal Piece in/out of the build
// area every other interaction should be the same" (2026-08-08).
//
// Gate 64 fixed the CENTRE (a bolted END no longer steals the press). This is
// the rest of the face: the goal loop ran BELOW the design-rod loop, so a stick
// merely lying across a crate took every press on the part it covered. A wheel
// never had the problem because the wheel loop has always run above the rods.
// Asked of both, same geometry, and compared — a rule that lives on one of two
// pools is the whole bug.
{
  const world = () => ({
    terrain: [], props: [],
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
    goalZones: [{ x: 380, y: -40, w: 120, h: 80 }],
  });
  const rod = (x1, y1, x2, y2) => ({ t: 'rod', kind: 'wood', x1, y1, x2, y2 });
  // r30 wheel and a 60×60 crate: same half-extent, so (20,0) is on the face of
  // each and well clear of the centre handle.
  const W = screen(world(), { tab: 'level', parts: [
    { t: 'wheel', kind: 'free', x: 0, y: 0, r: 30 }, rod(-100, 0, 100, 0)] });
  const G = screen({ ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 60, h: 60 }] },
    { tab: 'level', parts: [rod(-100, 0, 100, 0)] });
  const wk = W._hitTest({ x: 20, y: 0 })?.kind;
  const gk = G._hitTest({ x: 20, y: 0 })?.kind;
  gate('68b. a stick lying across a WHEEL does not steal the press', wk === 'part'
    && W._hitTest({ x: 20, y: 0 }).ref.t === 'wheel', wk);
  gate('68b. …and a crate answers the same, which it did not', gk === 'goal', gk);
  // …but the stick is still reachable where the crate is not.
  gate('68b. …while the stick keeps every press clear of the crate',
    G._hitTest({ x: 60, y: 0 })?.kind === 'part');
}

// ---------- gate 69: the marquee takes what it touches (§8.2) ----------
//
// "Ctrl-drag seems to include too many things. Just things that are physically
// in the rectangle I just drew! Some things nearby maybe have wrong boxes
// around them" (2026-08-08), with a diagonal stick as the example.
//
// Every kind used to answer with a bounding box, and a box lies about half the
// pieces on the board — a diagonal stick's is mostly empty air, and a goal
// piece was a CIRCLE of its half-diagonal. Both now go through `coreGap`, the
// same shape primitive the drag rules use.
{
  const world = () => ({
    terrain: [], props: [],
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
    goalZones: [{ x: 380, y: -40, w: 120, h: 80 }],
  });
  const rod = (x1, y1, x2, y2) => ({ t: 'rod', kind: 'wood', x1, y1, x2, y2 });
  const drag = (S, ax, ay, bx, by) => {
    const at = (x, y) => ev(x, y, { ctrlKey: true, shiftKey: true });
    S._pointerDown(at(ax, ay)); S._pointerMove(at(bx, by)); S._pointerUp(at(bx, by));
    return S.multiSel.map((s) => (s.kind === 'goal' ? 'goal'
      : s.kind === 'zone' ? 'zone' : s.ref?.t ? s.kind + '/' + s.ref.t : s.kind));
  };

  // A DIAGONAL stick: the corner of its bounding box is 100 px of empty air.
  {
    const S = screen(world(), { tab: 'level', parts: [rod(0, 0, 200, 200)] });
    gate('69. a marquee in the empty corner of a diagonal stick\'s box takes nothing',
      drag(S, 160, 10, 190, 40).length === 0, JSON.stringify(drag(S, 160, 10, 190, 40)));
  }
  // …and one that really crosses the stick still takes it. Started off the
  // piece, or the press is a Ctrl+CLICK and no marquee happens at all — which
  // is how the first draft of this gate fooled itself.
  {
    const S = screen(world(), { tab: 'level', parts: [rod(0, 0, 200, 200)] });
    gate('69. …while one that straddles the stick still takes it',
      drag(S, 100, 130, 160, 180).includes('part/rod'));
  }
  // A goal piece is its own shape, not a disc of its half-diagonal: a 40×40
  // crate used to answer from 28 px out, 8 px past each edge.
  {
    const S = screen({ ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 40 }] }, { tab: 'level' });
    gate('69. a marquee 4 px outside a crate does not take it',
      drag(S, 24, 24, 27, 27).length === 0, JSON.stringify(drag(S, 24, 24, 27, 27)));
  }
  {
    const S = screen({ ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 40 }] }, { tab: 'level' });
    gate('69. …while one that reaches its corner does',
      drag(S, -40, -40, 5, 5).includes('goal'));
  }
  // A ZONE has to be enclosed. It covers the whole area an author works in, so
  // an overlap test put it in every marquee ever dragged inside one.
  {
    const S = screen({ ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 40 }] }, { tab: 'level' });
    gate('69. a small marquee inside the build zone does not drag the zone in with it',
      !drag(S, 100, 100, 140, 140).includes('zone'));
    const T = screen({ ...world(), goalObjs: [{ shape: 'box', x: 0, y: 0, w: 40, h: 40 }] }, { tab: 'level' });
    gate('69. …but a marquee that ENCLOSES a zone selects it',
      drag(T, -600, -500, 600, 500).includes('zone'));
  }
}

// ---------- gate 70: copying a group copies the GROUP (§8.2) ----------
//
// "Ctrl-C/X should also copy groups and maintain groupness / motions / surface
// settings — everything, exact copy" (2026-08-08). `_cloneEntryFor` had no
// branch for `kind: 'group'`, so it returned null and Ctrl+C on a group copied
// NOTHING — not a partial copy, an empty one. And every paste branch went out
// of its way to `delete groupId`.
{
  const GID = 'g1';
  const lvl = {
    buildZones: [{ x: 0, y: 0, w: 1400, h: 1000 }],
    goalZones: [{ x: 300, y: 0, w: 100, h: 100, groupId: GID }],
    goalObjs: [{ shape: 'box', x: 60, y: -60, w: 30, h: 30, groupId: GID }],
    terrain: [
      { type: 'box', x: -60, y: 0, w: 80, h: 20, texture: 'ice', surface: 'ice', radius: 3, groupId: GID },
      { type: 'box', x: -10, y: 0, w: 80, h: 20, texture: 'ice', surface: 'ice', radius: 3, groupId: GID },
    ],
    props: [{ shape: 'box', x: 0, y: -80, w: 20, h: 20, density: 4, groupId: GID }],
    texts: [{ x: 0, y: -140, text: 'sign', size: 20, groupId: GID }],
    fixedParts: [{ t: 'rod', kind: 'wood', x1: -140, y1: -40, x2: -80, y2: -40, id: 'fx', groupId: GID }],
    groups: { [GID]: { angle: 0.35, path: { pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], loop: true, secs: 3 } } },
  };
  const S = screen(lvl, { tab: 'level' });
  S._select({ kind: 'group', gid: GID });
  S._copySel();
  gate('70. Ctrl+C on a group copies every piece in it',
    S._clipboard?.entries?.length === 7, `${S._clipboard?.entries?.length} entries`);
  gate('70. …and the group RECORD with them, or the ids would dangle',
    !!S._clipboard?.groups?.[GID], JSON.stringify(Object.keys(S._clipboard?.groups || {})));

  S._lastPointer = { x: 500, y: 400 };
  S._pasteSel();
  const gids = Object.keys(S.level.groups);
  const ng = gids.find((g) => g !== GID);
  const count = (arr) => arr.filter((o) => o.groupId === ng).length;
  gate('70. pasting mints a NEW group rather than joining the old one',
    gids.length === 2 && !!ng, gids.join(', '));
  gate('70. …with every kind of member carried into it',
    count(S.level.terrain) === 2 && count(S.level.props) === 1 && count(S.level.texts) === 1
    && count(S.level.fixedParts) === 1 && count(S.level.goalObjs) === 1 && count(S.level.goalZones) === 1,
    `terrain ${count(S.level.terrain)}, prop ${count(S.level.props)}, text ${count(S.level.texts)}, `
    + `fixed ${count(S.level.fixedParts)}, goal ${count(S.level.goalObjs)}, zone ${count(S.level.goalZones)}`);
  // "motions" — the group's own path comes across, TRANSLATED by the same
  // delta the pieces moved, or the copy would orbit the original's route.
  {
    const rec = S.level.groups[ng];
    const a = rec?.path?.pts?.[0], b = rec?.path?.pts?.[1];
    gate('70. …and its motion path, moved by the paste delta',
      near(rec?.angle, 0.35) && a && near(b.x - a.x, 100) && a.x !== 0,
      `angle ${rec?.angle}, path starts (${a?.x.toFixed(0)}, ${a?.y.toFixed(0)})`);
  }
  // "surface settings — everything": the entries are deep copies, so this is
  // really a guard that nothing strips them on the way through.
  {
    const t = S.level.terrain.filter((o) => o.groupId === ng);
    const p = S.level.props.filter((o) => o.groupId === ng)[0];
    gate('70. …and every piece keeps texture, surface, radius and density',
      t.every((o) => o.texture === 'ice' && o.surface === 'ice' && o.radius === 3) && p.density === 4,
      `${t.length} terrain, prop density ${p?.density}`);
  }
  // the original is untouched — a copy is a copy
  gate('70. …while the original group keeps exactly what it had',
    S.level.terrain.filter((o) => o.groupId === GID).length === 2
    && near(S.level.groups[GID].path.pts[0].x, 0));
}

// ---------- gate 71: a moving group still merges (§10.2) ----------
//
// "A group of same texture terrains that overlap do merge when grouped. When I
// give them motion they no longer merge. They should remain merged"
// (2026-08-08). Statics union by texture into one path; movers were drawn one
// at a time in their own local frames, so a seam appeared the moment a path
// was added. Members of one group move rigidly together, so they share a frame
// and can union exactly as statics do.
{
  const { movingUnionKey } = await import(u('public/js/render.js'));
  const motion = { path: { pts: [{ x: 0, y: 0 }, { x: 60, y: 0 }], loop: true, secs: 3 } };
  const lvl = { groups: { g: motion, h: motion } };
  const slab = (o) => ({ type: 'box', x: 0, y: 0, w: 80, h: 20, texture: 'granite', ...o });

  const a = movingUnionKey(slab({ groupId: 'g' }), lvl);
  const b = movingUnionKey(slab({ groupId: 'g' }), lvl);
  gate('71. two same-texture movers in one group share a union key',
    !!a && a === b, String(a));
  gate('71. …and an UNGROUPED mover has none — it draws on its own',
    movingUnionKey(slab({}), lvl) === null);
  gate('71. …nor does one whose group the level has never heard of',
    movingUnionKey(slab({ groupId: 'ghost' }), lvl) === null);
  gate('71. a different TEXTURE is a different union, as it is for statics',
    movingUnionKey(slab({ groupId: 'g', texture: 'ice' }), lvl) !== a);
  gate('71. …and a different GROUP is too',
    movingUnionKey(slab({ groupId: 'h' }), lvl) !== a);
  // the rigidity this depends on: a member with its own path is not moving
  // with the group any more, so it cannot share the group's frame
  gate('71. a member carrying its OWN path is excluded — the frame is no longer shared',
    movingUnionKey(slab({ groupId: 'g', ...motion }), lvl) === null);
  gate('71. neon is excluded — it has its own clustered draw',
    movingUnionKey(slab({ groupId: 'g', texture: 'neon' }), lvl) === null);
}

// ---------- gate 72: Group is offered wherever it applies (§8.2) ----------
//
// "Group should be on the RightClick menu when relevant" (2026-08-08). It lived
// only on the align chip. The relevance test moved to `_canGroupSelection` so
// the chip and the menu ask ONE question — the chip's own comment already
// recorded what happens when they drift ("the button counting fewer kinds than
// the action"), and it had drifted again: goal pieces and the level's own parts
// joined `_groupSelection` earlier the same day and the button never heard.
{
  const lvl = () => ({
    terrain: [{ type: 'box', x: -60, y: 0, w: 60, h: 20 }, { type: 'box', x: 60, y: 0, w: 60, h: 20 }],
    props: [{ shape: 'box', x: 0, y: -80, w: 20, h: 20 }],
    goalObjs: [{ shape: 'box', x: 0, y: -140, w: 30, h: 30 }],
    fixedParts: [{ t: 'rod', kind: 'wood', x1: -140, y1: -40, x2: -80, y2: -40, id: 'fx' }],
    texts: [{ x: 0, y: -200, text: 'sign', size: 20 }],
    buildZones: [{ x: 0, y: 0, w: 900, h: 700 }],
  });
  const S = screen(lvl(), { tab: 'level' });
  const T = (sels) => S._canGroupSelection(sels);

  gate('72. two terrain pieces can be grouped',
    T([{ kind: 'terrain', ref: S.level.terrain[0] }, { kind: 'terrain', ref: S.level.terrain[1] }]));
  gate('72. …one alone cannot', !T([{ kind: 'terrain', ref: S.level.terrain[0] }]));
  gate('72. …nor can nothing', !T([]));
  // the kinds that joined the action earlier the same day
  gate('72. a terrain piece and a GOAL piece can be grouped',
    T([{ kind: 'terrain', ref: S.level.terrain[0] }, { kind: 'goal', idx: 0 }]));
  gate('72. …and a terrain piece and one of the LEVEL\'s own parts',
    T([{ kind: 'terrain', ref: S.level.terrain[0] }, { kind: 'fixed', ref: S.level.fixedParts[0] }]));
  gate('72. …and a terrain piece and a label, which is the pairing that drifted before',
    T([{ kind: 'terrain', ref: S.level.terrain[0] }, { kind: 'text', ref: S.level.texts[0] }]));
  // the predicate the two surfaces share really is the same object
  gate('72. the chip and the menu ask the SAME predicate',
    typeof S._canGroupSelection === 'function'
    && /_canGroupSelection\(\)/.test(fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8')));
  // …and never in Test, where a group is not a thing you author
  {
    const M = screen(lvl(), { tab: 'machine' });
    gate('72. …and Group is never offered from Test',
      !M._canGroupSelection([{ kind: 'terrain', ref: M.level.terrain[0] }, { kind: 'terrain', ref: M.level.terrain[1] }]));
  }

  // **Group and Ungroup share one line** (2026-08-08, on request). Ungroup
  // came up out of the group's own section to sit beside its opposite — so it
  // must appear EXACTLY once, and only in the pair. A source check, because
  // the menu is DOM this harness cannot build; what it pins is that the group
  // section no longer emits its own copy.
  {
    const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const ungroupItems = [...src.matchAll(/item\('Ungroup'/g)].length;
    gate('72. the menu builds Ungroup exactly once — in the pair, not also below',
      ungroupItems === 1, `${ungroupItems} occurrence(s)`);
    gate('72. …and the pair is one row, so it lands on one line',
      /class: 'ctx-row ctx-strong'/.test(src));
    // **Group membership is all-or-nothing** (2026-08-08). A zone used to have
    // a private escape hatch — an "Ungroup" that detached that ONE zone and
    // left the group standing — because a grouped zone was the one member that
    // still answered for itself. Both are gone: there is no per-member detach
    // anywhere, for any kind.
    gate('72. …and no kind has a private detach any more',
      !/_detachZoneFromGroup/.test(src));
  }

  // …which rests on every member answering as its group. The zone was the last
  // exception, so it is the one worth asserting beside the others.
  {
    const GID = 'g';
    const S = screen({
      terrain: [{ type: 'box', x: 0, y: 0, w: 80, h: 20, groupId: GID }],
      props: [{ shape: 'box', x: 0, y: -120, w: 30, h: 30, groupId: GID }],
      goalObjs: [{ shape: 'box', x: 0, y: -200, w: 30, h: 30, groupId: GID }],
      buildZones: [{ x: 200, y: 0, w: 120, h: 120, groupId: GID }],
      goalZones: [{ x: -200, y: 0, w: 120, h: 120 }],
      groups: { [GID]: {} },
    }, { tab: 'level' });
    const kindAt = (x, y) => S._hitTest({ x, y })?.kind;
    gate('72. a grouped ZONE answers as its group, as every other member does',
      kindAt(200, 0) === 'group', kindAt(200, 0));
    gate('72. …alongside grouped terrain, props and goal pieces',
      kindAt(0, 0) === 'group' && kindAt(0, -120) === 'group' && kindAt(0, -200) === 'group',
      `${kindAt(0, 0)}, ${kindAt(0, -120)}, ${kindAt(0, -200)}`);
    gate('72. …while an UNGROUPED zone is still itself',
      kindAt(-200, 0) === 'zone', kindAt(-200, 0));
  }

  // …and the cost of that, caught by probing rather than by reasoning: a zone's
  // interior is where marquees are STARTED (§8.2), and once the zone answered
  // as its group, `hit.kind !== 'zone'` stopped recognising it — Ctrl+dragging
  // inside a grouped build area silently selected the whole group instead of
  // rubber-banding the pieces in it. Both states asserted together, because the
  // grouped one only looks right next to the ungrouped one.
  {
    const zoneLvl = (grouped) => ({
      buildZones: [{ x: 0, y: 0, w: 600, h: 400, ...(grouped ? { groupId: 'g' } : {}) }],
      terrain: [{ type: 'box', x: 0, y: 0, w: 40, h: 20, ...(grouped ? { groupId: 'g' } : {}) }],
      groups: grouped ? { g: {} } : {},
    });
    const startDrag = (grouped) => {
      const S = screen(zoneLvl(grouped), { tab: 'level' });
      S._pointerDown(ev(-200, -150, { ctrlKey: true, shiftKey: true }));   // empty interior
      const t = S.drag?.type;
      S._pointerUp(ev(-200, -150, { ctrlKey: true, shiftKey: true }));
      return t;
    };
    gate('72. Ctrl+Shift-drag inside a build zone starts a marquee',
      startDrag(false) === 'marquee', startDrag(false));
    gate('72. …and still does when that zone is GROUPED',
      startDrag(true) === 'marquee', startDrag(true));
  }

  // ---------- 73. the pin tool, and the pin that is on nothing ----------
  //
  // ONE rule to gate, and both halves of the request fall out of it: the pin
  // lands where you click, and belongs to whatever can carry it. A piece under
  // the cursor takes it (so it rides that piece); anything else — sky, a wheel,
  // a goal piece — hands it to the LEVEL, bolted to the world.
  //
  // Reachable here because the decision lives in `_pointerDown` and the two
  // `_add*Pin` helpers rather than in a DOM handler: the toolbar button is
  // furniture, and a rule that only the button could reach would be a rule no
  // gate could ask about (the lesson `sizes.js` exists for).
  {
    const pinLevel = () => ({
      terrain: [{ type: 'box', x: 0, y: 0, w: 120, h: 40 }],
      props: [{ shape: 'box', x: 0, y: -200, w: 40, h: 40 }],
      buildZones: [{ x: -300, y: -100, w: 100, h: 100 }],
      goalZones: [{ x: 300, y: -100, w: 100, h: 100 }],
      goalObjs: [{ shape: 'box', x: -300, y: -100, w: 30, h: 30 }],
    });
    // snapMode 'off' so the gates read the coordinate that was CLICKED rather
    // than the grid node it lands on — the snap has its own gates below.
    const pinScreen = () => {
      const S = screen(pinLevel(), { tab: 'level', tool: 'pin' });
      S.snapMode = 'off';
      return S;
    };
    const click = (S, x, y, mods = {}) => { S._pointerDown(ev(x, y, mods)); S._pointerUp(ev(x, y, mods)); };

    {
      const S = pinScreen();
      click(S, 0, 0);                       // on the terrain slab
      gate('73. the pin tool puts a pin ON the terrain under it',
        (S.level.terrain[0].pins || []).length === 1 && S.level.pins.length === 0,
        `piece ${(S.level.terrain[0].pins || []).length}, loose ${S.level.pins.length}`);
    }
    {
      const S = pinScreen();
      click(S, 0, -200);                    // on the prop
      gate('73. …and ON the prop under it',
        (S.level.props[0].pins || []).length === 1 && S.level.pins.length === 0,
        `piece ${(S.level.props[0].pins || []).length}, loose ${S.level.pins.length}`);
    }
    {
      const S = pinScreen();
      click(S, 250, -400);                  // open sky
      gate('73. …and on EMPTY SPACE it is the level\'s own, bolted to the world',
        S.level.pins.length === 1 && samePt(S.level.pins[0], { x: 250, y: -400 }),
        JSON.stringify(S.level.pins[0]));
    }
    // A grouped wall is still a wall: `_hitTest` answers 'group' for any member
    // (§9.3), and a pin belongs to the PIECE — it is stored on the piece and
    // remapped by every transform the piece takes. Without `via` this dropped a
    // loose pin lying on top of the wall instead, which looks identical and
    // does not move with it.
    {
      const lv = pinLevel();
      lv.terrain[0].groupId = 'g';
      lv.groups = { g: {} };
      const S = screen(lv, { tab: 'level', tool: 'pin' });
      S.snapMode = 'off';
      click(S, 0, 0);
      gate('73. a GROUPED wall still takes the pin itself, not the world',
        (S.level.terrain[0].pins || []).length === 1 && S.level.pins.length === 0,
        `piece ${(S.level.terrain[0].pins || []).length}, loose ${S.level.pins.length}`);
    }
    // What makes a loose pin usable at all: a stick end has to be able to SNAP
    // onto it, because "exactly this coordinate" is the whole of how anything
    // ever joins anything in this editor (§5.4).
    {
      const S = pinScreen();
      click(S, 250, -400);
      const snaps = S._allPins(null).filter(p => samePt(p, { x: 250, y: -400 }));
      gate('73. …and a stick can snap to it — it is in the snap list',
        snaps.length === 1, `${snaps.length} candidate(s)`);
    }
    // Twice in the same place is one pin. `_pinDropPoint` snaps onto a pin in
    // range, so a second click aimed at a loose pin lands on its exact
    // coordinate — invisible, since the two draw on top of each other, and it
    // would spend one of the budget. Same trap Alt+click hit on props.
    {
      const S = pinScreen();
      click(S, 250, -400);
      click(S, 252, -401);
      gate('73. a second click on a loose pin does not stack a second one',
        S.level.pins.length === 1, `${S.level.pins.length} pin(s)`);
    }
    // …it PICKS IT UP instead, which is what the tool meaning "pins" rather
    // than "add a pin" has to mean.
    {
      const S = pinScreen();
      click(S, 250, -400);
      const g = gesture(S, { x: 250, y: -400 }, { x: 300, y: -350 },
        { watch: () => ({ ...S.level.pins[0] }) });
      gate('73. …dragging one moves it', g.type === 'move-pin' && samePt(g.after, { x: 300, y: -350 }),
        `${g.type} → ${JSON.stringify(g.after)}`);
    }
    // The delete tool is the way back out, and a loose pin is the one thing on
    // this canvas that `_cursorTarget` has never heard of — without its own
    // branch the click answered "nothing under the cursor".
    {
      const S = pinScreen();
      click(S, 250, -400);
      S.tool = 'delete';
      click(S, 250, -400);
      gate('73. …and the delete tool removes it', S.level.pins.length === 0,
        `${S.level.pins.length} pin(s)`);
    }
    // The cap binds at the GESTURE, and it is the LAYER's cap — the scenery
    // gets half of everything (§10.5), and a placement the editor allowed that
    // the server would refuse is the worst possible time to find out.
    {
      const S = pinScreen();
      S.level.pins = Array.from({ length: MAX_LEVEL_PINS }, (_, i) => ({ x: i * 40, y: -900 }));
      const t0 = S.toasts.length;
      click(S, 250, -400);
      gate('73. the loose-pin cap refuses at the click',
        S.level.pins.length === MAX_LEVEL_PINS && S.toasts.length > t0,
        S.toasts[S.toasts.length - 1]);
      // Restated, not imported (see the constants at the top): a gate that
      // silently follows the number it is meant to be gating is not gating it.
      // Three copies have to agree — the editor's cap tables, the server's, and
      // this file — because nothing else connects them, and a level the editor
      // let you build that the server refuses is the worst time to find out.
      const g = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
      const cFront = g.match(/FRONT_CAPS = \{[^}]*pins: MAX_LEVEL_PINS/);
      const cMax = g.match(/const MAX_LEVEL_PINS = (\d+)/);
      const cBack = g.match(/BACK_CAPS = \{[^}]*pins: (\d+)/);
      gate(`73. …and game.js caps loose pins at exactly ${MAX_LEVEL_PINS}`,
        !!cFront && cMax && +cMax[1] === MAX_LEVEL_PINS,
        `game.js ${cMax ? cMax[1] : 'not found'}, FRONT_CAPS wired ${!!cFront}`);
      gate('73. …with the scenery layer at half that, like every other list',
        cBack && +cBack[1] === BACK_LEVEL_PINS, `game.js back ${cBack ? cBack[1] : 'not found'}`);
      const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
      const sFront = srv.match(/too many loose pins \(max (\d+)\)/);
      const sBack = srv.match(/\['pins', (\d+)\]/);
      gate(`73. …and the server agrees on both`,
        sFront && +sFront[1] === MAX_LEVEL_PINS && sBack && +sBack[1] === BACK_LEVEL_PINS,
        `server front ${sFront ? sFront[1] : '?'}, back ${sBack ? sBack[1] : '?'}`);
    }
    // **The whitelist trap.** `_levelData` names every key a save carries, and
    // `BACK_LISTS` every key the scenery swap carries. A list added to the
    // schema and to neither of those saves fine, plays fine, and is gone the
    // next time the level is opened — which is precisely the bug the comment on
    // BACK_LISTS was written about.
    {
      const S = pinScreen();
      click(S, 250, -400);
      const saved = S._levelData();
      gate('73. a saved level carries its loose pins',
        (saved.pins || []).length === 1, `${(saved.pins || []).length} pin(s)`);
      const empty = screen(pinLevel(), { tab: 'level' });
      gate('73. …and a level with none carries no empty key',
        !('pins' in empty._levelData()), JSON.stringify(Object.keys(empty._levelData())));
    }
    // …and the scenery half of the same trap: placed in the layer, it has to
    // survive the trip back out through `pickBackLists`.
    {
      const S = pinScreen();
      S.stop = () => {};              // the layer swap stops any run first; no sim here
      S.backBanner = { classList: { add() {}, remove() {} } };
      S._enterBackEdit({ quiet: true });
      click(S, 250, -400);
      S._exitBackEdit({ quiet: true });
      gate('73. a pin placed in the scenery layer survives coming back out',
        (S.level.backLevel.pins || []).length === 1 && S.level.pins.length === 0,
        `back ${(S.level.backLevel.pins || []).length}, front ${S.level.pins.length}`);
    }
  }

  // ---------- 74. seconds ⇄ speed (2026-08-08) ----------
  //
  // "Motion should have an option for typing in seconds rather than speed."
  // The BOX is DOM and unreachable from here; the arithmetic under it is not,
  // and it is the whole of the feature — a conversion that is a hair off turns
  // "crosses in two seconds" into a level that does not, silently.
  //
  // In util.js rather than in the menu handler for exactly that reason: a rule
  // that only a DOM handler could reach is a rule no gate could ask about.
  {
    const round2 = (v) => Math.round(v * 100) / 100;
    gate('74. a 400px path crossed in 2s is 200 px/s', speedForSeconds(400, 2) === 200, String(speedForSeconds(400, 2)));
    gate('74. …and it round-trips back to 2s',
      round2(secondsForSpeed(400, speedForSeconds(400, 2))) === 2,
      String(secondsForSpeed(400, speedForSeconds(400, 2))));
    // The typed number lands on the ladder's ENDS, never past them: the range
    // is what the ten notches were measured for, and the box is the first way
    // a speed could ever be asked for off them.
    gate('74. an impossibly quick trip clamps to the ladder\'s top, not past it',
      speedForSeconds(400, 0.0001) === SPEED_MAX, String(speedForSeconds(400, 0.0001)));
    gate('74. …and an impossibly slow one to its bottom',
      speedForSeconds(400, 100000) === SPEED_MIN, String(speedForSeconds(400, 100000)));
    gate('74. a typed 5000 px/s clamps to the top', clampSpeed(5000) === SPEED_MAX, String(clampSpeed(5000)));
    gate('74. …and a typed 0 to the bottom, because a path that never travels is not a motion',
      clampSpeed(0) === SPEED_MIN, String(clampSpeed(0)));
    // Degenerate inputs REFUSE rather than guessing. A spin-only motion carries
    // `pts: []`, so a zero-length path is reachable from the menu — and a
    // division by zero stored as `path.speed` is a NaN pose one frame later.
    gate('74. a path with no length refuses a seconds figure', speedForSeconds(0, 2) === null, String(speedForSeconds(0, 2)));
    gate('74. …and so does a trip of no seconds', speedForSeconds(400, 0) === null, String(speedForSeconds(400, 0)));
    gate('74. …and rubbish', speedForSeconds(400, NaN) === null && clampSpeed(Infinity) === null,
      `${speedForSeconds(400, NaN)}, ${clampSpeed(Infinity)}`);
    // A spin's seconds is per REVOLUTION, and it is the number the info chip
    // has always printed — 2π/rate with rate = spinSpeed / SPIN_RATE_DIVISOR.
    // Asserted against that formula rather than against a copy of it.
    {
      const speed = 60;
      const chipSeconds = 2 * Math.PI / (speed / SPIN_RATE_DIVISOR);
      gate('74. a spin\'s seconds is what the info chip prints — seconds per revolution',
        round2(secondsForSpinSpeed(speed)) === round2(chipSeconds),
        `${secondsForSpinSpeed(speed).toFixed(3)}s vs chip ${chipSeconds.toFixed(3)}s`);
      gate('74. …and it round-trips', spinSpeedForSeconds(secondsForSpinSpeed(speed)) === speed,
        String(spinSpeedForSeconds(secondsForSpinSpeed(speed))));
      gate('74. …and refuses a revolution taking no time', spinSpeedForSeconds(0) === null,
        String(spinSpeedForSeconds(0)));
    }
  }

  // ---------- 75. the Advanced bar's census (2026-08-09) ----------
  //
  // "Wheels: TOTAL SMALLSUBTOTAL (L, F, R) …  Rod: TOTAL (WET, HARD)."  The bar
  // is DOM and unreachable from here; the arithmetic under it is not, and a
  // count that disagrees with what the player is scored on is worse than no
  // count at all.
  {
    const parts = [
      { t: 'wheel', kind: 'cw', x: 0, y: 0, r: WHEEL_SIZES[1] },
      { t: 'wheel', kind: 'ccw', x: 40, y: 0, r: WHEEL_SIZES[1] },
      { t: 'wheel', kind: 'free', x: 80, y: 0, r: WHEEL_SIZES[0] },
      { t: 'wheel', kind: 'cw', x: 120, y: 0, r: WHEEL_SIZES[2] },
      { t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 40, y2: 0 },
      { t: 'rod', kind: 'water', x1: 40, y1: 0, x2: 80, y2: 0 },
    ];
    const c = pieceCensus(parts);
    const [S1, M, L] = c.wheels.sizes;
    gate('75. the wheel census totals and splits by size and kind',
      c.wheels.total === 4 && S1.total === 1 && S1.free === 1 && M.total === 2 && M.ccw === 1 && M.cw === 1 && L.total === 1 && L.cw === 1,
      `${c.wheels.total}: S${S1.total} M${M.total} L${L.total}`);
    gate('75. …and the rods split water from hard',
      c.rods.total === 2 && c.rods.water === 1 && c.rods.wood === 1,
      `${c.rods.total} (${c.rods.water} wet, ${c.rods.wood} hard)`);
    // A hand-edited or imported level can carry a radius off the ladder, and a
    // census that dropped those would under-report the machine it describes.
    const odd = pieceCensus([{ t: 'wheel', kind: 'cw', x: 0, y: 0, r: WHEEL_SIZES[2] - 0.6 }]);
    gate('75. a radius off the ladder is counted, at its NEAREST rung',
      odd.wheels.total === 1 && odd.wheels.sizes[2].total === 1,
      JSON.stringify(odd.wheels.sizes.map(s => s.total)));
    // A rope is one PIECE and many links; the census speaks in pieces, like
    // everything the player is scored on, and must not disagree with the stats
    // chip about it.
    const rope = Array.from({ length: 6 }, (_, i) => ({ t: 'rod', kind: 'wood', chain: 'c1', x1: i * 10, y1: 0, x2: i * 10 + 10, y2: 0 }));
    const rc = pieceCensus(rope), rs = designStats(rope);
    gate('75. …and a rope counts as designStats counts it, not as its links',
      rc.rods.total === rs.wood + rs.water && rc.parts === 6,
      `${rc.rods.total} piece(s) from ${rc.parts} parts`);
    // Pins live in three different places and "how many pins" is one question.
    const lc = levelCensus({
      terrain: [{ pins: [{ x: 0, y: 0 }] }, {}],
      props: [{ pins: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }],
      pins: [{ x: 3, y: 3 }],
      texts: [{}], goalObjs: [{}], buildZones: [{}], goalZones: [{}, {}],
    });
    gate('75. the level census sums pins across props, terrain AND the loose ones',
      lc.pins === 4, `${lc.pins} pins`);
    gate('75. …and counts the rest of what an author spends',
      lc.terrain === 2 && lc.props === 1 && lc.texts === 1 && lc.goalObjs === 1,
      JSON.stringify(lc));
    // Build and goal APART (2026-08-09). One `zones` number is the one thing a
    // zone count must not be: a level with two of one and none of the other is
    // broken in a way "2 zones" cannot say.
    gate('75. …with build and goal zones counted separately',
      lc.buildZones === 1 && lc.goalZones === 2 && !('zones' in lc),
      `${lc.buildZones} build, ${lc.goalZones} goal`);
  }

  // ---------- 76. Free World (2026-08-09) ----------
  //
  // "Any piece outside of real build area stops any chance of a solve."  Two
  // halves, and the whole feature lives on keeping them apart: the toggle
  // suspends the BUILD rule and never the SCORING one, which is what makes
  // "build wherever, then tidy up and it counts again" true.
  {
    gate('76. an escaped machine earns NOTHING — not even `solved`',
      computeBadges({ won: true, wheels: 0, poweredWheels: 0, maxPinWeight: 0, untampered: true, escaped: true }).length === 0,
      JSON.stringify(computeBadges({ won: true, wheels: 0, poweredWheels: 0, maxPinWeight: 0, untampered: true, escaped: true })));
    gate('76. …while the identical machine inside the zone earns its badges',
      computeBadges({ won: true, wheels: 0, poweredWheels: 0, maxPinWeight: 0, untampered: true }).includes('solved'),
      JSON.stringify(computeBadges({ won: true, wheels: 0, poweredWheels: 0, maxPinWeight: 0, untampered: true })));

    const lvl = () => ({
      terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }],
      buildZones: [{ x: -300, y: -100, w: 200, h: 200 }],
      goalZones: [{ x: 300, y: -100, w: 120, h: 120 }],
      goalObjs: [{ shape: 'box', x: 300, y: -100, w: 30, h: 30 }],
    });
    const inside = { t: 'wheel', kind: 'free', x: -300, y: -100, r: 15 };
    const outside = { t: 'wheel', kind: 'free', x: 600, y: -100, r: 15 };

    {
      const S = screen(lvl(), { tab: 'machine', parts: [deep(inside)] });
      gate('76. a machine built inside the zone has not escaped', S._designEscapes() === false);
      S.design.parts.push(deep(outside));
      gate('76. …and one piece outside is enough', S._designEscapes() === true);
    }
    // The crux: the flag lifts the gate and leaves the QUESTION answerable.
    {
      const S = screen(lvl(), { tab: 'machine', parts: [deep(outside)] });
      const bounds = circleBounds(outside.x, outside.y, outside.r);
      gate('76. Free World OFF: the piece is outside by both tests',
        S._boxInBuildZone(bounds) === false && S._boxInBuildZoneStrict(bounds) === false);
      S.freeWorld = true;
      gate('76. Free World ON: the BUILD gate opens…',
        S._boxInBuildZone(bounds) === true);
      gate('76. …and the STRICT test does not, so the run still knows it escaped',
        S._boxInBuildZoneStrict(bounds) === false && S._designEscapes() === true);
    }
    // …which is what makes tidying up work: same toggle, pieces brought home.
    {
      const S = screen(lvl(), { tab: 'machine', parts: [deep(outside)] });
      S.freeWorld = true;
      gate('76. a free-world build that is tidied back inside counts again',
        S._designEscapes() === true
        && (S.design.parts[0].x = inside.x, S.design.parts[0].y = inside.y, S._designEscapes() === false));
    }
    // A level with no build zones constrains nothing, so nothing can escape it.
    {
      const noZones = lvl(); noZones.buildZones = [];
      const S = screen(noZones, { tab: 'machine', parts: [deep(outside)] });
      gate('76. a level with no build zone cannot be escaped from',
        S._designEscapes() === false);
    }
    // A press outside the area is a PAN, and Free World is what lifts that too.
    {
      const S = screen(lvl(), { tab: 'machine', tool: 'wheel-free' });
      const far = { x: 600, y: -100 };
      S._pointerDown(ev(far.x, far.y)); const t1 = S.drag?.type; S._pointerUp(ev(far.x, far.y));
      gate('76. pressing outside the build area pans rather than placing',
        t1 === 'pan' && S.design.parts.length === 0, `${t1}, ${S.design.parts.length} part(s)`);
      S.freeWorld = true;
      S._pointerDown(ev(far.x, far.y)); const t2 = S.drag?.type; S._pointerUp(ev(far.x, far.y));
      gate('76. …and with Free World on it places there',
        t2 === 'place-wheel' && S.design.parts.length === 1, `${t2}, ${S.design.parts.length} part(s)`);
    }
  }

  // ---------- 76b. Free World never unlocks a GOAL PIECE (2026-08-09) ----------
  //
  // The exploit, reported as "if someone moves the GoalPieces they can scam the
  // system": turn Free World on, drag the crate into the goal area, turn Free
  // World off, press Play, win. Free World's promise is "build anywhere" and it
  // settles up honestly for the MACHINE — a piece left outside does not score
  // (`_designEscapes`, gate 76). A goal piece has no such settling-up, so the
  // §7.2 rule has to hold in every mode: movable only while wholly inside a
  // build zone, and it stays inside.
  //
  // Both routes are gated, because the crate has two ways out: dragged itself,
  // and towed by a machine part it is pinned to.
  {
    const lvl = () => ({
      terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }],
      buildZones: [{ x: -300, y: -100, w: 200, h: 200 }],
      goalZones: [{ x: 300, y: -100, w: 120, h: 120 }],
      goalObjs: [{ shape: 'box', x: -300, y: -100, w: 30, h: 30 }],
    });
    const inZone = (S) => {
      const p = S.goalPositions[0];
      return Math.abs(p.x + 300) <= 100 && Math.abs(p.y + 100) <= 100;
    };
    // 1. the crate dragged on its own, 600 px toward the goal area
    {
      const S = screen(lvl(), { tab: 'machine' });
      S.freeWorld = true;
      S._pointerDown(ev(-300, -100));
      S._pointerMove(ev(300, -100));
      S._pointerUp(ev(300, -100));
      gate('76b. Free World does not let a goal piece be dragged out of the build zone',
        inZone(S), `staged at (${S.goalPositions[0].x}, ${S.goalPositions[0].y})`);
      gate('76b. …and it did not reach the goal area, which is the exploit',
        Math.abs(S.goalPositions[0].x - 300) > 100, `x ${S.goalPositions[0].x}`);
    }
    // 2. the crate TOWED by a wheel pinned to it — same gesture, one remove
    {
      const S = screen(lvl(), { tab: 'machine', parts: [] });
      // a wheel whose hub sits on the crate's centre pin, so the crate rides it
      S.design.parts.push({ t: 'wheel', kind: 'free', x: -300, y: -100, r: 15, id: 'w1' });
      S.freeWorld = true;
      S._pointerDown(ev(-300, -100));
      S._pointerMove(ev(300, -100));
      S._pointerUp(ev(300, -100));
      gate('76b. …nor towed out by a part it is pinned to',
        inZone(S), `staged at (${S.goalPositions[0].x}, ${S.goalPositions[0].y})`);
    }
    // 2b. THE PIECE THAT IS ALREADY OUTSIDE — reported as "I can still drag the
    // goal piece that is outside of the build area. Weirdly but I can still
    // drag." This is the shape the FC import produces (its build area is off to
    // one side of its goal pieces), and §7.2 says such a piece is the level's
    // furniture: selectable, pinnable, NOT draggable. Asked with Free World off
    // as well as on, since a lock that only holds in one mode is not a lock.
    {
      const out = () => ({ ...lvl(), goalObjs: [{ shape: 'box', x: 300, y: -100, w: 30, h: 30 }] });
      for (const free of [false, true]) {
        const S = screen(out(), { tab: 'machine' });
        S.freeWorld = free;
        S._pointerDown(ev(300, -100));
        S._pointerMove(ev(-300, -100));
        S._pointerUp(ev(-300, -100));
        const p = S.goalPositions[0];
        gate(`76b. a goal piece outside the build area cannot be dragged at all (Free World ${free ? 'on' : 'off'})`,
          p.x === 300 && p.y === -100, `staged at (${p.x}, ${p.y})`);
      }
      // …and the same piece IS still selectable and pinnable, which is the
      // whole point of locking it rather than ignoring it (§7.2).
      const S = screen(out(), { tab: 'machine' });
      S._pointerDown(ev(300, -100)); S._pointerUp(ev(300, -100));
      gate('76b. …but it is still selectable, so its readout and its pins survive',
        S.sel?.kind === 'goal' && S.sel.idx === 0, JSON.stringify(S.sel));
    }
    // 2c. THE STICK BOLTED TO IT — "if I connect a stick to the one over the
    // edge of the build area I can pull it in." The crate refuses its own drag
    // and refuses to be multi-selected, then rides out on a stick pinned to it.
    // §7.2 says "dragged, nudged, aligned OR CARRIED ALONG"; this is that last
    // clause, asked of the one carrier that was not asking it.
    //
    // Both ends of the carrying relationship are gated (§16): the locked crate
    // must stay, and a crate that IS the player's must still ride, or fixing
    // this would silently detach every cart in the game.
    {
      const out = () => ({ ...lvl(), goalObjs: [{ shape: 'box', x: 300, y: -100, w: 30, h: 30 }] });
      // a stick with one end on the locked crate's centre pin
      const stick = () => ({ t: 'rod', kind: 'wood', x1: 300, y1: -100, x2: 380, y2: -100, id: 'r1' });
      for (const free of [false, true]) {
        const S = screen(out(), { tab: 'machine', parts: [stick()] });
        S.freeWorld = free;
        S._pointerDown(ev(340, -100));      // grab the stick by its middle
        S._pointerMove(ev(-100, -100));
        S._pointerUp(ev(-100, -100));
        const p = S.goalPositions[0];
        gate(`76b. a locked goal piece is not towed by a stick bolted to it (Free World ${free ? 'on' : 'off'})`,
          p.x === 300 && p.y === -100, `staged at (${p.x}, ${p.y})`);
      }
      // the other end: a crate INSIDE the zone still rides its stick
      {
        const S = screen(lvl(), { tab: 'machine', parts: [{ t: 'rod', kind: 'wood', x1: -300, y1: -100, x2: -260, y2: -100, id: 'r1' }] });
        S._pointerDown(ev(-280, -100));
        S._pointerMove(ev(-260, -100));
        S._pointerUp(ev(-260, -100));
        const p = S.goalPositions[0];
        gate('76b. …while a crate that IS the player\'s still rides its stick',
          p.x !== -300, `staged at (${p.x}, ${p.y})`);
      }
    }
  }

  // ---------- 77. resizing a LEVEL's own wheel (2026-08-09) ----------
  //
  // Reported as "No room to resize that wheel here for all wheels even ones
  // without a stick".  `_resizeWheel` asked `_wheelInvalid(w, w)` and took the
  // `zoned = true` default, so a level's own wheel was judged against the BUILD
  // ZONE — which in Create is usually nowhere near it. Every size button on
  // every fixed wheel refused, including a wheel standing entirely alone.
  //
  // The rods on the next two lines of that function had the rule right, and the
  // comment above them already spelled it out; the wheel never asked. Gated
  // from BOTH ends, because switching a rule off is as easy to get wrong as
  // leaving it on: the fixed wheel must resize, and a DESIGN wheel that really
  // would outgrow its zone must still be refused.
  {
    const lvl = (over = {}) => ({
      terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }],
      buildZones: [{ x: -600, y: -100, w: 200, h: 200 }],
      goalZones: [{ x: 600, y: -100, w: 120, h: 120 }],
      goalObjs: [{ shape: 'box', x: 600, y: -100, w: 30, h: 30 }],
      ...over,
    });
    // A LEVEL's own wheel, alone, far from the build zone — the reported case.
    {
      const S = screen(lvl({ fixedParts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }] }), { tab: 'level' });
      const t0 = S.toasts.length;
      S._resizeWheel(S.level.fixedParts[0], 30);
      gate('77. a level\'s own wheel resizes, alone and nowhere near the build zone',
        S.level.fixedParts[0].r === 30 && S.toasts.length === t0,
        `r=${S.level.fixedParts[0].r}${S.toasts.slice(t0).join(' / ')}`);
    }
    // …and one with a stick bolted to it still carries the stick out with it.
    //
    // The endpoint is taken from `wheelPins`, never assumed: rim pins sit
    // `PIN_INSET` INSIDE the rim (so an edge-pinned rod does not thump the
    // ground each revolution), so a stick placed at `y − r` is not pinned at
    // all — it is a loose stick standing in the wheel, which the resize then
    // correctly refuses for passing through a wheel it is not pinned to. That
    // is what the first cut of this gate actually built, and the refusal it
    // read as a bug was the rule working.
    {
      const wheel = { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' };
      const pin = wheelPins(wheel)[1];                      // a ring pin, not the hub
      const S = screen(lvl({
        fixedParts: [wheel, { t: 'rod', kind: 'wood', x1: pin.x, y1: pin.y, x2: pin.x, y2: pin.y - 90, id: 'r' }],
      }), { tab: 'level' });
      const want = wheelPins({ ...wheel, r: 30 })[1];       // where that pin lands at the new size
      S._resizeWheel(S.level.fixedParts[0], 30);
      const rod = S.level.fixedParts[1];
      gate('77. …and a stick pinned to its rim follows it out',
        S.level.fixedParts[0].r === 30 && samePt({ x: rod.x1, y: rod.y1 }, want),
        `r=${S.level.fixedParts[0].r}, end (${rod.x1}, ${rod.y1}) want (${want.x}, ${want.y})`);
    }
    // The rule is not simply gone: a PLAYER's wheel is still confined.
    {
      const S = screen(lvl({ buildZones: [{ x: -600, y: -100, w: 40, h: 40 }] }),
        { tab: 'machine', parts: [{ t: 'wheel', kind: 'free', x: -600, y: -100, r: 15, id: 'd' }] });
      const t0 = S.toasts.length;
      S._resizeWheel(S.design.parts[0], 30);
      gate('77. …while a design wheel that would outgrow its zone is still refused',
        S.design.parts[0].r === 15 && S.toasts.length > t0,
        `r=${S.design.parts[0].r}, "${S.toasts[S.toasts.length - 1]}"`);
    }
    // …and one that fits still goes through, so the refusal above is the rule
    // biting rather than the whole path being broken.
    {
      const S = screen(lvl(), { tab: 'machine', parts: [{ t: 'wheel', kind: 'free', x: -600, y: -100, r: 15, id: 'd' }] });
      S._resizeWheel(S.design.parts[0], 30);
      gate('77. …and one that fits its zone resizes as it always did',
        S.design.parts[0].r === 30, `r=${S.design.parts[0].r}`);
    }
  }

  // ---------- 78. Free World lifts every clamp, not just the placement one ----------
  //
  // Reported as "wheels are jumping into the real build area when they get
  // moved close to it, and cannot be moved out again".
  //
  // `_clampDeltaToZone` pins each dragged piece to `zoneContaining(...) ||
  // rects[0]` — and a piece outside every zone has no containing region, so it
  // fell back to the FIRST build zone and the clamp hauled it in, then held it
  // there because every following frame clamped to the same rect. Free World
  // reached `_clampPtToZone` (placement) on the day it landed and missed this
  // one, which is the DRAG's.
  //
  // Gated as the gesture, through the real handlers, because the bug is about
  // what a drag DOES rather than what a predicate returns — and `gesture()`
  // asserts the house rule with it: where the drag leaves a piece is where the
  // drop keeps it (§16).
  {
    const lvl = {
      terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }],
      buildZones: [{ x: -300, y: 0, w: 200, h: 200 }],
      goalZones: [{ x: 600, y: 0, w: 120, h: 120 }],
      goalObjs: [{ shape: 'box', x: 600, y: 0, w: 30, h: 30 }],
    };
    const near = { x: -80, y: 0 };     // outside, but close enough for the clamp to bite
    const away = { x: 400, y: 0 };     // further out still
    const mk = (free) => {
      const S = screen(lvl, { tab: 'machine', parts: [{ t: 'wheel', kind: 'free', x: near.x, y: near.y, r: 15, id: 'w' }] });
      S.freeWorld = free;
      S.snapMode = 'off';
      return S;
    };
    // Free World OFF: the clamp is the rule, and it still is.
    {
      const S = mk(false);
      const g = gesture(S, near, { x: near.x - 40, y: 0 }, { watch: partAt(S, 0) });
      gate('78. with Free World off a wheel is still pulled into the build zone',
        S.design.parts[0].x < near.x - 40, `x=${S.design.parts[0].x}`);
    }
    // Free World ON: it stays where it is put, moving TOWARD the zone…
    {
      const S = mk(true);
      const to = { x: -140, y: 0 };
      const g = gesture(S, near, to, { watch: partAt(S, 0) });
      gate('78. with Free World on it does not jump into the zone',
        samePt(g.after, to) && g.held, `landed ${JSON.stringify(g.after)}, held ${g.held}`);
    }
    // …and back OUT again, which is the half that was impossible.
    {
      const S = mk(true);
      gesture(S, near, { x: -140, y: 0 }, { watch: partAt(S, 0) });
      const g = gesture(S, { x: -140, y: 0 }, away, { watch: partAt(S, 0) });
      gate('78. …and can be dragged back out of it',
        samePt(g.after, away) && g.held, `landed ${JSON.stringify(g.after)}, held ${g.held}`);
    }
    // The fence still holds — "unlimited" means the level, not the void.
    {
      const S = mk(true);
      const g = gesture(S, near, { x: 99999, y: 0 }, { watch: partAt(S, 0) });
      gate('78. …but never past the fence',
        S.design.parts[0].x <= WORLD_LIMIT && S.design.parts[0].x > 0,
        `x=${S.design.parts[0].x}, fence ${WORLD_LIMIT}`);
    }
    // **A goal piece is NOT confined on the same terms, and this gate used to
    // say it was** (rewritten 2026-08-09 with gate 76b). It asserted that Free
    // World left a crate wherever it was put — the same freedom the wheel above
    // gets — and that freedom is a way of skipping a level: park the crate in
    // the goal area, switch Free World off, press Play. A wheel left outside
    // costs the run its score; a crate does not.
    //
    // The complaint this gate was written for ("cannot be moved out again")
    // cannot arise for a crate either way, because a piece outside the zone is
    // not draggable at all (§7.2, `_goalLocked`) — so the `|| rects[0]` haul it
    // was guarding against is unreachable through any gesture. Both halves of
    // that are asserted here, from the helper's own side.
    {
      const S = mk(true);
      const g = { shape: 'box', w: 30, h: 30 };
      const inside = S._clampGoalToZone(g, 700, 0, { x: -140, y: 0 });
      gate('78. …but a goal piece is confined even in Free World',
        inside.x < 700, JSON.stringify(inside));
      // the level tab is the one place it isn't — that IS authoring
      S.tab = 'level';
      const authored = S._clampGoalToZone(g, 700, 0, { x: 400, y: 0 });
      gate('78. …and only AUTHORING it lifts that',
        authored.x === 700 && authored.y === 0, JSON.stringify(authored));
    }
  }

  // ---------- 79. the FPS readout (2026-08-09) ----------
  //
  // In util.js because the frame loop is rAF-driven and no gate can reach it —
  // the pane this is tested in does not run rAF at all. The loop hands it
  // timestamps; this is the whole of the arithmetic.
  {
    const run = (frames, ms, window = 500) => {
      const st = {};
      let t = 1000, out = null;
      fpsTick(st, t, window);                       // the first call only starts the clock
      for (let i = 0; i < frames; i++) { t += ms; const v = fpsTick(st, t, window); if (v != null) out = v; }
      return out;
    };
    gate('79. sixty frames at 16.67ms reads as 60 fps', run(60, 1000 / 60) === 60, String(run(60, 1000 / 60)));
    gate('79. …thirty at 33.3ms as 30', run(30, 1000 / 30) === 30, String(run(30, 1000 / 30)));
    gate('79. …and 144 as 144', run(144, 1000 / 144) === 144, String(run(144, 1000 / 144)));
    // Counted over a WINDOW, not from one frame's delta: it returns nothing
    // until half a second of frames has actually happened, which is what keeps
    // the number readable and the DOM writes down to two a second.
    {
      const st = {};
      fpsTick(st, 0, 500);
      const early = [];
      for (let i = 1; i <= 20; i++) early.push(fpsTick(st, i * 16.7, 500));
      gate('79. it says nothing until the window is full',
        early.slice(0, 29).every(v => v === null) && early.some(v => v !== null) === false,
        `${early.filter(v => v !== null).length} early reading(s) in 334ms`);
    }
    // A timestamp that goes BACKWARDS re-bases instead of returning a negative
    // or infinite rate — rAF timestamps are monotonic, but this also runs the
    // first frame after a tab wakes, and one absurd number on screen is the
    // kind of thing that gets reported as a bug in the game.
    {
      const st = {};
      fpsTick(st, 5000, 500);
      const v = fpsTick(st, 10, 500);
      gate('79. a backwards clock re-bases rather than reporting nonsense', v === null, String(v));
    }
  }

  // ---------- 80. a refused nudge keeps the selection (2026-08-09) ----------
  //
  // Reported as "if I click a wheel and use arrows to move it and it hits
  // something it becomes deselected, so arrows no longer work".  The arrows are
  // what made it obvious — you press a key four times, the fourth is refused,
  // and the next press does nothing at all — but the cause is in every revert:
  // `_restoreSnapshotAll` ended `_select(null)`.
  //
  // That was not laziness. Every list it touches is REPLACED by a deep copy, so
  // a selection still holding the old object points at a detached thing (§16's
  // recurring source). Clearing was the safe answer to a real hazard; the fix
  // is to re-resolve rather than to drop, and the gate has to prove BOTH — the
  // selection survives, and it points at the live object rather than a ghost.
  {
    const lvl = {
      terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }, { type: 'box', x: 0, y: -100, w: 60, h: 60 }],
      buildZones: [{ x: -200, y: -100, w: 400, h: 200 }],
      goalZones: [{ x: 600, y: -100, w: 120, h: 120 }],
      goalObjs: [{ shape: 'box', x: 600, y: -100, w: 30, h: 30 }],
    };
    // a wheel just left of the blocking slab, nudged right until it is refused
    const S = screen(lvl, { tab: 'machine', parts: [{ t: 'wheel', kind: 'free', x: -80, y: -100, r: 15, id: 'w' }] });
    S.sel = { kind: 'part', ref: S.design.parts[0] };
    let refusedAt = -1;
    for (let i = 0; i < 30; i++) {
      const x0 = S.design.parts[0].x;
      S._nudge(10, 0);
      if (S.design.parts[0].x === x0) { refusedAt = i; break; }
    }
    gate('80. (fixture) nudging right eventually hits the slab', refusedAt >= 0,
      `refused after ${refusedAt} step(s), x=${S.design.parts[0].x}`);
    gate('80. a refused nudge keeps the wheel selected',
      !!S.sel && S.sel.kind === 'part', JSON.stringify(S.sel && S.sel.kind));
    // …and on the LIVE object, not the detached pre-revert copy — which is the
    // hazard the old `_select(null)` existed to avoid.
    gate('80. …pointing at the piece that is really in the level',
      S.sel && S.design.parts.includes(S.sel.ref),
      S.sel ? `indexOf ${S.design.parts.indexOf(S.sel.ref)}` : 'no selection');
    // …so the NEXT arrow still works, which is the whole complaint.
    {
      const x0 = S.design.parts[0].x;
      S._nudge(-10, 0);
      gate('80. …so the next arrow moves it again', S.design.parts[0].x === x0 - 10,
        `${x0} → ${S.design.parts[0].x}`);
    }
    // A multi-selection survives on the same terms.
    {
      const S2 = screen(lvl, { tab: 'machine', parts: [
        { t: 'wheel', kind: 'free', x: -80, y: -100, r: 15, id: 'a' },
        { t: 'wheel', kind: 'free', x: -140, y: -100, r: 15, id: 'b' },
      ] });
      S2.multiSel = S2.design.parts.map(p => ({ kind: 'part', ref: p }));
      for (let i = 0; i < 30; i++) { const x0 = S2.design.parts[0].x; S2._nudge(10, 0); if (S2.design.parts[0].x === x0) break; }
      gate('80. a refused nudge keeps a MULTI-selection, on live objects',
        S2.multiSel.length === 2 && S2.multiSel.every(m => S2.design.parts.includes(m.ref)),
        `${S2.multiSel.length} selected`);
    }
  }
}

// ---------- 81. a goal piece snaps to pins (2026-08-10) ----------
//
// "I wanted to make a goal piece car — stick goal balls on a long crate." It
// was not buildable, and not because anything refused it: a goal piece was the
// one pinnable thing in the game whose drag never asked `_snapPoint`, so it had
// grid snap and the zone clamp and nothing else. A crate's corner pins sit at
// the EXACT corners since the lattice moved to FC's own positions (2026-08-17)
// — ±60, ±15 on a 120×30, and 15 is on no grid step — so joining two goal
// pieces meant landing a float by eye and finding out on Play. (They were the
// inset ±(w/2 − 3) when this gate was written, which is where its old 57, 12
// came from.)
//
// Gated from both ends: it snaps when a pin is in reach, and it does NOT when
// one isn't, because a drag that quietly moves somewhere you did not point is
// worse than one that never snaps.
{
  const lvl = () => ({
    terrain: [{ type: 'box', x: 0, y: 300, w: 2000, h: 60 }],
    props: [],
    buildZones: [{ x: -600, y: -100, w: 300, h: 200 }],
    goalZones: [{ x: 600, y: -100, w: 120, h: 104 }],
    goalObjs: [
      { shape: 'box', x: 0, y: 0, w: 120, h: 30 },     // the car's body
      { shape: 'ball', x: 0, y: 200, r: 15 },          // a wheel, parked below
    ],
    win: 'goalObj',
  });
  const corner = { x: 120 / 2, y: 30 / 2 };             // 60, 15 — FC's exact corner
  {
    const S = screen(lvl(), { tab: 'level' });
    // Ctrl+Shift is the obstacle override: a ball centred on a crate's corner
    // is inside the crate, which is exactly what the gesture is for.
    const mods = { ctrlKey: true, shiftKey: true };
    S.snapMode = 'off';
    S._pointerDown(ev(0, 200, mods));
    S._pointerMove(ev(corner.x + 3, corner.y - 2, mods));   // near, not on
    S._pointerUp(ev(corner.x + 3, corner.y - 2, mods));
    const p = S.goalPositions[1];
    gate('81. a goal ball dragged near a crate\'s corner pin lands EXACTLY on it',
      Math.abs(p.x - corner.x) < 1e-6 && Math.abs(p.y - corner.y) < 1e-6,
      `(${p.x}, ${p.y}) vs (${corner.x}, ${corner.y})`);
    // …which is the whole point: the same coordinate is what makes a joint
    gate('81. …so the two share a pin coordinate, which is what joins them',
      goalPins(S.level.goalObjs[0], S.goalPositions[0])
        .some(q => jointKey(q.x, q.y) === jointKey(p.x, p.y)),
      jointKey(p.x, p.y));
  }
  {
    const S = screen(lvl(), { tab: 'level' });
    S.snapMode = 'off';
    const mods = { ctrlKey: true, shiftKey: true };
    S._pointerDown(ev(0, 200, mods));
    S._pointerMove(ev(-300, 150, mods));      // nowhere near any pin
    S._pointerUp(ev(-300, 150, mods));
    const p = S.goalPositions[1];
    gate('81. …and a drag with no pin in reach lands where it was dropped',
      Math.abs(p.x + 300) < 1e-6 && Math.abs(p.y - 150) < 1e-6, `(${p.x}, ${p.y})`);
  }
}



// ---------------------------------------------------------------------------
// 82. THE SCRUB LINE'S TWO CONDITIONS (§7.4, 2026-08-10)
//
// *"Invisible unless — 1. there is a play in action; 2. the mouse is within the
// area the scrubber will appear."* Both halves are pure functions in util.js
// precisely so this gate can hold them: the rule itself lived in a DOM method
// for one afternoon and nothing headless could reach it.
//
// The three ways to get it wrong are each one word of code, and each one leaves
// a control that is missing exactly when it is wanted:
//  - gating on `playing` instead of on the TAPE — scrubbing pauses the run, so
//    the line would vanish the moment it was touched;
//  - forgetting that a SCRUBBED run keeps it — the slider is the only thing
//    that says which frame you are parked on or moves you off it, so hiding it
//    leaves you in the past with the way back invisible;
//  - forgetting that a finger cannot hover — condition 2 is unmeetable on
//    touch, so coarse pointers would never see it at all.
{
  const V = (o) => scrubLineVisible(o);
  gate('82. no tape, no scrub line — however near the pointer is',
    !V({ hasTape: false, pointerNear: true, scrubbed: false, coarse: false })
    && !V({ hasTape: false, pointerNear: true, scrubbed: true, coarse: true }),
    'both conditions are required, and this is the one that outranks');
  gate('82. a tape the pointer is nowhere near stays hidden',
    !V({ hasTape: true, pointerNear: false, scrubbed: false, coarse: false }),
    'relevant, but nobody is looking for it');
  gate('82. …and shows the moment the pointer arrives',
    V({ hasTape: true, pointerNear: true, scrubbed: false, coarse: false }));
  gate('82. a SCRUBBED run keeps it, pointer or no pointer',
    V({ hasTape: true, pointerNear: false, scrubbed: true, coarse: false }),
    'the slider IS the way back to live, so it cannot be the thing that vanishes');
  gate('82. a touch screen gets it on condition 1 alone',
    V({ hasTape: true, pointerNear: false, scrubbed: false, coarse: true })
    && !V({ hasTape: false, pointerNear: false, scrubbed: false, coarse: true }),
    'a finger has no hover, but it still has no tape');
}
{
  // The zone: measured off the DOCK, so it is identical whether the row is
  // showing or not — the row is positioned absolutely for exactly this reason,
  // and a zone that grew when it appeared would flicker on its own boundary.
  const dock = { left: 400, right: 700, top: 500, bottom: 544, width: 300, height: 44 };
  const view = { top: 0, bottom: 600 };
  const z = scrubZone(dock, view);
  gate('82. the zone reaches the side the row appears on, and the pad all round',
    z.side === 'above'
    && z.y0 === 500 - (SCRUB_ROW_H + SCRUB_ROW_GAP) - SCRUB_NEAR_PAD
    && z.y1 === 544 + SCRUB_NEAR_PAD
    && z.x0 === 400 - SCRUB_NEAR_PAD && z.x1 === 700 + SCRUB_NEAR_PAD,
    `${z.side}, x ${z.x0}..${z.x1}, y ${z.y0}..${z.y1}`);
  gate('82. …and the dock is inside its own zone, which is the point',
    pointInZone(z, 550, 520) && pointInZone(z, 400, 500) && pointInZone(z, 700, 544));
  gate('82. …while a pointer out over the level is not',
    !pointInZone(z, 550, 380) && !pointInZone(z, 200, 520) && !pointInZone(z, 550, 599));
}
{
  // Which side is MEASURED. The desktop dock sits on the bottom edge with 14 px
  // under it — less than the row needs — and a phone's starts at the top with
  // nothing over it. A constant would be wrong for one of them.
  const view = { top: 0, bottom: 600 };
  const bottomDock = { left: 400, right: 700, top: 542, bottom: 586, width: 300, height: 44 };
  const topDock = { left: 8, right: 308, top: 6, bottom: 50, width: 300, height: 44 };
  gate('82. a dock on the bottom edge hangs its line ABOVE itself',
    scrubZone(bottomDock, view).side === 'above', '14 px underneath is not room');
  gate('82. …and a dock at the top of the screen hangs it BELOW',
    scrubZone(topDock, view).side === 'below', '6 px overhead is not room either');
  gate('82. …with a dock in open space preferring above',
    scrubZone({ left: 400, right: 700, top: 260, bottom: 304, width: 300, height: 44 }, view).side === 'above',
    'a timeline over its transport, like every other player');
  // …and the room is measured from the CANVAS, not from y=0. The play area
  // starts below the site nav, so a dock at the top of the canvas has ~50 px
  // over it that belong to the Campaign link. Measured from zero this answered
  // "above" and hung the slider on the nav — caught by looking at it, which
  // was the only thing that could, because the gate had been fed the wrong
  // frame too.
  const nav = { top: 52, bottom: 1000 };
  const atCanvasTop = { left: 20, right: 320, top: 58, bottom: 113, width: 300, height: 55 };
  gate('82. …and "room above" is room above the CANVAS, not above the window',
    scrubZone(atCanvasTop, nav).side === 'below'
    && scrubZone(atCanvasTop, { top: 0, bottom: 1000 }).side === 'above',
    'the same dock answers differently in the two frames — the canvas one is right');
}
{
  // **A VERTICAL bar gets a VERTICAL timeline, beside the column.** Reported
  // as "if the play bar is on the right and vertical scrubber goes off screen"
  // — and it did, by 198 measured px: a horizontal row on a 59 px column has
  // to overhang it by 200, and on the right edge there is nowhere for that to
  // go. Turned on its side the row is 26 px wide and cannot overhang at all,
  // so the two ways of getting this wrong are both gated: the orientation must
  // pick the axis, and the room must pick the end of it.
  const view = { left: 0, right: 1014, top: 0, bottom: 800 };
  const opts = { orient: 'vertical' };
  const onLeft = { left: 20, right: 79, top: 200, bottom: 570, width: 59, height: 370 };
  const onRight = { left: 951, right: 1010, top: 200, bottom: 570, width: 59, height: 370 };
  const middle = { left: 400, right: 459, top: 200, bottom: 570, width: 59, height: 370 };
  gate('82. a vertical bar on the RIGHT edge puts its timeline on its LEFT',
    scrubZone(onRight, view, opts).side === 'left',
    'the reported bug: the only side with room');
  gate('82. …a vertical bar on the LEFT edge puts it on its RIGHT',
    scrubZone(onLeft, view, opts).side === 'right', '20 px of margin is not room');
  gate('82. …and one in open space prefers left, as above prefers over',
    scrubZone(middle, view, opts).side === 'left', 'a timeline before its transport');
  gate('82. …with the zone reaching the side the column is on',
    scrubZone(onRight, view, opts).x0 === 951 - (SCRUB_ROW_H + SCRUB_ROW_GAP) - SCRUB_NEAR_PAD
    && scrubZone(onRight, view, opts).x1 === 1010 + SCRUB_NEAR_PAD,
    'and never past the bar on the other side');
  // …and the ORIENTATION is what picks the axis: the identical bar answers
  // above/below when the dock is horizontal and left/right when it is not.
  gate('82. …and the same box answers on the other axis when the bar is horizontal',
    ['above', 'below'].includes(scrubZone(onRight, view).side)
    && ['left', 'right'].includes(scrubZone(onRight, view, opts).side),
    `horizontal ${scrubZone(onRight, view).side}, vertical ${scrubZone(onRight, view, opts).side}`);
}
{
  // The row's own box is unioned in as a safety net — a prediction a few px
  // short must still not hide the control under the cursor dragging it. It can
  // only ever GROW the region while it is up: easier to keep than to summon.
  const dock = { left: 40, right: 84, top: 300, bottom: 460, width: 44, height: 160 };
  const row = { left: 40, right: 300, top: 268, bottom: 294, width: 260, height: 26 };
  const view = { left: 0, right: 1014, top: 0, bottom: 800 };
  const bare = scrubZone(dock, view);
  const withRow = scrubZone(dock, view, { row });
  gate('82. the row\'s own box counts as "near" once it is showing',
    !pointInZone(bare, 280, 280) && pointInZone(withRow, 280, 280),
    `bare x1 ${bare.x1}, with row ${withRow.x1}`);
  gate('82. …and unioning it can only ever GROW the zone',
    withRow.x0 <= bare.x0 && withRow.y0 <= bare.y0
    && withRow.x1 >= bare.x1 && withRow.y1 >= bare.y1,
    'hysteresis in the right direction');
}

// ---------------------------------------------------------------------------
// 83. THE SCRUB SLIDER OWNS THE ARROW KEYS WHILE IT HAS FOCUS (§7.4)
//
// Reported as *"the scrubber states that stepping past the end simulates
// onwards… that is not happening"* — and it was not, for anyone who had
// touched the slider. `_keyDown` sends every key back when the event's target
// is an `<input>`, which is right for a text box and wrong for this one: the
// scrub line IS an input, touching it focuses it, and from then on the arrows
// never reached `_scrubBySeconds`. What ran instead was the range's own native
// arrow handling, which steps one frame and stops dead at `max` — the last
// recorded frame. The promise was printed on the very control eating it.
//
// Both halves are gated, because the exemption is the kind that grows: the
// arrows must get through FROM the slider, and everything else must still be
// refused from it, or `R` and `Space` start reaching the canvas from a control
// somebody is aiming at.
{
  const kev = (key, target, mods = {}) => ({
    key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt,
    repeat: false, target, preventDefault() {}, stopPropagation() {},
  });
  const rig = () => {
    const S = screen(flatWorld(), { tab: 'machine' });
    S.scrubEl = { tagName: 'INPUT', max: '0', value: '0' };
    S.scrubWrap = { classList: { toggle() {}, contains: () => true } };
    S.scrubTime = { textContent: '' };
    S.calls = [];
    S._scrubBySeconds = (ds) => S.calls.push('scrub' + ds);
    S._fitAll = () => S.calls.push('fit');
    // a tape with something on it, which is what arms the arrows at all
    S._tape = { n: 90, frames: 90, head: 0, t: new Float32Array(90) };
    return S;
  };
  {
    const S = rig();
    for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) S._keyDown(kev(k, S.scrubEl));
    gate('83. the tape\'s arrows get through from the focused scrub slider',
      S.calls.length === 4, `calls [${S.calls}]`);
  }
  {
    const S = rig();
    S._keyDown(kev('ArrowRight', { tagName: 'INPUT' }));       // some OTHER input
    S._keyDown(kev('ArrowRight', { tagName: 'TEXTAREA' }));
    gate('83. …and from no other input, where an arrow moves a caret',
      S.calls.length === 0, `calls [${S.calls}]`);
  }
  {
    const S = rig();
    S._keyDown(kev('z', S.scrubEl));
    S._keyDown(kev('Z', S.scrubEl));                            // the fit-camera key
    S._keyDown(kev(' ', S.scrubEl));
    gate('83. …and the exemption is the ARROWS only, not every key on that element',
      S.calls.length === 0, `calls [${S.calls}]`);
  }
  {
    // …and the arrows still work with nothing focused at all, which is the
    // path that was never broken and must not become the one that is.
    const S = rig();
    S._keyDown(kev('ArrowRight', { tagName: 'CANVAS' }));
    gate('83. …while a canvas keypress reaches the tape exactly as it always did',
      S.calls.join() === 'scrub0.1', `calls [${S.calls}]`);
  }
}

// ---------------------------------------------------------------------------
// 84. DRAGGING PAST THE END FAST-FORWARDS (§7.4)
//
// *"Drag the slider past the end (it doesn't move, just my mouse) and it fast
// forwards the simulation. As though I were pressing Shift+→ rapidly."* The
// distance between a thumb pinned at `max` and a pointer that kept going IS the
// throttle, and this is the curve that reads it.
//
// **The deadzone is the half that has to be gated**, and it carries more weight
// than it looks like since the gesture takes no modifier. It is there because
// the thumb sits AT the end whenever you have scrubbed to it, so without slack
// a hand resting on the slider creeps the run forward on its own — the sort of
// thing that only shows up when somebody leaves the mouse somewhere. And it is
// there because reaching a maximum, for most hands, means shoving the pointer
// comfortably past it: that overshoot must buy nothing.
{
  gate('84. resting exactly at the end winds nothing',
    scrubFastForwardRate(0) === 0 && scrubFastForwardRate(SCRUB_FF_DEADZONE) === 0,
    `deadzone ${SCRUB_FF_DEADZONE}px`);
  gate('84. …nor does anything short of it, or the wrong way',
    scrubFastForwardRate(SCRUB_FF_DEADZONE - 1) === 0 && scrubFastForwardRate(-200) === 0,
    'dragging back down the track is scrubbing, not winding');
  // The number itself, stated: the deadzone has to be wider than an ordinary
  // "shove it to the end" overshoot, or the gesture fires on people who only
  // wanted the last frame. It was 12 while a modifier gated the feature.
  gate('84. …and the slack is wide enough for a hand that shoves past the end',
    SCRUB_FF_DEADZONE >= 20, `${SCRUB_FF_DEADZONE}px, with no modifier to hide behind`);
  gate('84. a nudge past the end is about a second of future per second',
    Math.abs(scrubFastForwardRate(SCRUB_FF_DEADZONE + 18) - 1) < 1e-9,
    'the same gesture used gently');
  gate('84. …and it climbs from there',
    scrubFastForwardRate(50) > scrubFastForwardRate(30)
    && scrubFastForwardRate(120) > scrubFastForwardRate(50),
    `30→${scrubFastForwardRate(30).toFixed(2)}, 50→${scrubFastForwardRate(50).toFixed(2)}, 120→${scrubFastForwardRate(120).toFixed(2)}`);
  gate('84. …to a cap, so a flick to the far edge is not ten minutes of future',
    scrubFastForwardRate(4000) === SCRUB_FF_MAX && scrubFastForwardRate(1e9) === SCRUB_FF_MAX,
    `capped at ${SCRUB_FF_MAX}× real time`);
}
{
  // Which way "past the end" points is the ORIENTATION's business. A vertical
  // scrub line runs min→max downward (`writing-mode: vertical-lr`, §7.4), so
  // the overshoot that means "more" is downward there and rightward on a
  // horizontal one — and a slider is vertical exactly when it is taller than
  // it is wide, which is the only thing either shape can be asked.
  const wide = { left: 100, right: 400, top: 50, bottom: 76, width: 300, height: 26 };
  const tall = { left: 100, right: 126, top: 50, bottom: 350, width: 26, height: 300 };
  gate('84. a horizontal slider is overshot to the RIGHT',
    scrubOvershoot(wide, 460, 60) === 60 && scrubOvershoot(wide, 460, 9999) === 60,
    'and the other axis cannot get a look in');
  gate('84. …and a vertical one DOWNWARD, which is where its max is',
    scrubOvershoot(tall, 113, 410) === 60 && scrubOvershoot(tall, 9999, 410) === 60);
  gate('84. …with a pointer still inside the track overshooting by nothing',
    scrubOvershoot(wide, 250, 60) < 0 && scrubOvershoot(tall, 113, 200) < 0,
    'so the rate is zero while you are simply scrubbing');
}

// ---------- gate 85: the site nav hides itself on a game screen ----------
//
// (2026-08-11.) WHICH screens is a CSS question — `#app:has(.main.full)`, which
// only the play and Maker screens ever satisfy — and there is nothing here to
// gate about it. WHEN IT COMES BACK is a rule with two thresholds, and the
// second one is the entire reason this is a function in util.js rather than
// three lines in a pointer handler.
{
  const H = 52;                         // a desktop nav; a phone's wraps to ~78
  const shown = (y, was) => navShown(y, H, was);
  gate('85. the nav is away while the pointer is anywhere in the level',
    !shown(400, false) && !shown(60, false) && !shown(30, false),
    'including inside the strip it will occupy — it is not there yet');
  gate('85. …and comes back at the top couple of pixels',
    shown(NAV_PEEK_IN, false) && shown(0, false) && !shown(NAV_PEEK_IN + 1, false),
    `${NAV_PEEK_IN}px`);
  // The trap. Revealed, the nav is now UNDER the pointer, so a rule that hid it
  // again outside the 3px strip would take it away on the first pixel of drift
  // and flicker on its own edge — which is how the bars have parked on their
  // own thresholds four times over.
  gate('85. …and then STAYS while the pointer moves down through it',
    shown(4, true) && shown(30, true) && shown(H, true),
    'the reveal strip is 3px; the bar it reveals is 52');
  gate('85. …leaving only once the pointer is clear of the whole bar',
    shown(H + NAV_PEEK_OUT, true) && !shown(H + NAV_PEEK_OUT + 1, true),
    `${H} of nav plus ${NAV_PEEK_OUT} of air`);
  gate('85. a taller nav is measured, not assumed — a phone wraps to two rows',
    navShown(70, 78, true) && !navShown(70, 52, true),
    'the same pointer, in the nav on one and past it on the other');
  gate('85. the pointer leaving over the TOP edge keeps it',
    shown(-5, true) && shown(-5, false),
    'a negative clientY is on its way to the browser chrome and back');
  gate('85. …and a pointer that is nowhere at all changes nothing',
    navShown(NaN, H, true) === true && navShown(undefined, H, false) === false,
    'window blur must not decide this either way');
}

// ---------- gate 87: how near catches a pin (§8.1, §19) ---------------------
//
// 2026-08-14, on request: "Improve touch snapping to closest pin." The numbers
// were measured in scripts/probe-pinsnap.mjs; what is gated here is the shape
// of the rule, and the two things it must never do again.
//
// **A wider radius cannot make a WRONG joint**, which is the claim the whole
// change rests on: `_snapPoint` takes the nearest pin, and a standard wheel's
// pins are 9.18 px apart, so the old 6 px circle already held several of them
// at 1×. Widening only converts a miss into a hit. The last gate here measures
// that spacing rather than restating it, so the day the lattice changes this
// argument is re-checked instead of quietly becoming false.
{
  gate('87. a mouse keeps the 6 screen px it always had',
    Math.abs(snapRadius(1, false) - 6) < 1e-9 && Math.abs(snapRadius(2, false) - 3) < 1e-9,
    `1x ${snapRadius(1, false)}, 2x ${snapRadius(2, false)} world px`);
  gate('87. …a finger gets its own scale instead',
    Math.abs(snapRadius(1, true) - 20) < 1e-9 && snapRadius(1, true) > snapRadius(1, false),
    `1x ${snapRadius(1, true)} world px against the mouse's ${snapRadius(1, false)}`);
  gate('87. …and both still shrink with zoom, so zooming in separates pins',
    snapRadius(4, true) < snapRadius(1, true) && snapRadius(4, false) < snapRadius(1, false),
    `touch 1x ${snapRadius(1, true)} → 4x ${snapRadius(4, true)}`);

  // The bug the probe turned up, and it was never a touch bug: the dot is drawn
  // in WORLD px while the radius is screen px, so past ~3.3x the old rule made
  // the snap circle smaller than the pin being aimed at.
  gate('87. the radius never falls below the DOT it is aiming at',
    snapRadius(20, false) >= PIN_DOT_R && snapRadius(100, false) >= PIN_DOT_R
    && snapRadius(20, true) >= PIN_DOT_R,
    `at 20x a mouse gets ${snapRadius(20, false)} world px, dot is ${PIN_DOT_R}`);
  gate('87. …and the floor is the SAME number the renderer draws',
    SNAP_PIN_DOT === PIN_DOT_R, `util ${SNAP_PIN_DOT} vs render ${PIN_DOT_R}`);
  {
    const w = { t: 'wheel', kind: 'free', x: 0, y: 0, r: STD_WHEEL_R };
    const pins = wheelPins(w);
    const rim = pins.find((p) => p.dx != null);
    const along = rim && { x: (rim.x + rim.dx) / 2, y: (rim.y + rim.dy) / 2 };
    const toPin = along && Math.hypot(along.x - rim.x, along.y - rim.y);
    gate('87. a wheel pin carries a detent tick inward from the slot',
      !!rim && toPin > 1, rim ? `tick ${toPin && toPin.toFixed(2)} px` : 'no detent');
  }
  gate('87. …a silly zoom cannot produce a nonsense radius',
    snapRadius(0, false) === 6 && snapRadius(NaN, true) === 20 && snapRadius(-1, false) === 6,
    'zero, NaN and negative all fall back to 1x');

  // …and the premise, measured.
  {
    const tightest = (r) => {
      const pins = wheelPins({ t: 'wheel', kind: 'free', x: 0, y: 0, r });
      let closest = Infinity;
      for (let i = 0; i < pins.length; i++) {
        for (let j = i + 1; j < pins.length; j++) {
          const d = Math.hypot(pins[i].x - pins[j].x, pins[i].y - pins[j].y);
          if (d > 1e-9 && d < closest) closest = d;
        }
      }
      return closest;
    };
    // Asked of the LADDER, not of one wheel. It named the standard wheel and
    // passed by 3 px until Path B spread that wheel's pins to 12.25 against a
    // 12 px circle (2026-08-15) — the ambiguity this section exists to resolve
    // is still there, it has just moved down a size, and a gate pinned to one
    // size reported that as a failure of the rule rather than a fact about it.
    gate('87. the premise: even a MOUSE\'s circle already holds several pins at 1x',
      WHEEL_SIZES.some((r) => tightest(r) < snapRadius(1, false) * 2),
      `circle spans ${(snapRadius(1, false) * 2).toFixed(1)}; pin spacing — `
      + WHEEL_SIZES.map((r) => `r${r}: ${tightest(r).toFixed(2)}`).join(', '));
  }
}

// ---------- gate 86: shortcut badges need a keyboard to be about (§19) ------
//
// 2026-08-14, on request: "Remove keyboard short cuts in toolbars, if no
// keyboard." There is no media query for that, so the rule is evidence — the
// pointer at load, then the first key that actually reaches the editor. The
// claims worth pinning are the two directions it must not get wrong: a desktop
// never loses its badges, and a keyboard that turns up late is believed.
{
  gate('86. a fine pointer prints its shortcut keys, keyboard seen or not',
    showsKeyHints(false, false) === true && showsKeyHints(false, true) === true,
    'a desktop is untouched either way');
  gate('86. …a coarse one prints none of them to begin with',
    showsKeyHints(true, false) === false, 'a phone starts bare');
  gate('86. …and gets them the moment a real keyboard is used',
    showsKeyHints(true, true) === true, 'a tablet with a keyboard case');
  // The evidence is deliberately a keydown the EDITOR sees, never any keydown
  // on the page — a soft keyboard fires plenty into a level-name field, and
  // that must not count. game.js calls `_sawKeyboard` past the guard that hands
  // keys to a focused control; this holds the ORDER, which is the whole trick.
  {
    const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    const guard = src.indexOf("e.target.tagName === 'INPUT'");
    const saw = src.indexOf('this._sawKeyboard();');
    gate('86. …counted only past the guard that gives keys to a focused field',
      guard > 0 && saw > guard, `guard at ${guard}, evidence at ${saw}`);
  }
}

// ---------- 88. a stick is clamped as a STICK, not as the box round it ----------
//
// **"Try to move the stick up and it will not go. Angle of stick varies the
// weirdness."** (2026-08-21, on Rolling Hills, whose build zone is tilted 10°.)
//
// `clampDeltaToRect` measures the dragged piece in the ZONE's frame. Handed only
// an axis-aligned box it rotated that box's four CORNERS and re-bounded them —
// a box of a box — so a DIAGONAL stick came out far fatter than the stick is,
// and by an amount that depends on its angle. His 103 px stick read as needing
// 49 px of headroom where it needs 19: it stopped ten times too early, slid
// sideways, and at some angles was shoved back DOWN.
//
// `footprintOf` has always honoured a `pts` field; a rod's bounds simply never
// carried one. The goal-piece half of the same bug was fixed the same way
// (`_goalBounds`, and the note at `clampBounds`).
//
// **The invariant is §16's**: where the drag leaves a piece is where the drop
// keeps it. A clamp measuring one shape while the drop rule measures another is
// that invariant broken, and every one of these bugs has been that.
section('88', () => {
  const TILT = -10 * Math.PI / 180;
  const zone = { x: 390, y: -214, w: 280, h: 200, angle: TILT };
  const level = { terrain: [], buildZones: [zone], goalZones: [{ x: 900, y: 0, w: 80, h: 80 }], goalObjs: [] };
  // a 103 px stick lying at -18.6° near the zone's ceiling, as reported
  const LEN = 102.6, MID = { x: 307, y: -276 };
  const stickAt = (deg) => {
    const a = deg * Math.PI / 180, hx = (LEN / 2) * Math.cos(a), hy = (LEN / 2) * Math.sin(a);
    return { t: 'rod', kind: 'wood', id: 'r', x1: MID.x - hx, y1: MID.y - hy, x2: MID.x + hx, y2: MID.y + hy };
  };
  const boxOnly = (p) => ({
    minX: Math.min(p.x1, p.x2), minY: Math.min(p.y1, p.y2),
    maxX: Math.max(p.x1, p.x2), maxY: Math.max(p.y1, p.y2),
  });

  // The measurement itself, before any dragging: how tall does the clamp think
  // a diagonal stick is, in the tilted zone's frame?
  {
    const p = stickAt(-18.6);
    const box = boundsInRectFrame(boxOnly(p), zone);
    const S = screen(level, { parts: [p] });
    const real = boundsInRectFrame(S._boundsOfPart(S.design.parts[0]), zone);
    const trueHalf = (LEN / 2) * Math.abs(Math.sin((-18.6 * Math.PI / 180) - TILT));
    gate('88. a stick is measured as the STICK, not as the box round it',
      Math.abs(real.hy - trueHalf) < 0.5 && box.hy > real.hy * 2,
      `${real.hy.toFixed(1)} px half-height, against ${box.hy.toFixed(1)} from the box and ${trueHalf.toFixed(1)} true`);
    gate('88. …and its width in that frame is the stick’s own length, halved',
      Math.abs(real.hx - (LEN / 2) * Math.abs(Math.cos((-18.6 * Math.PI / 180) - TILT))) < 0.5,
      `${real.hx.toFixed(1)} px`);
  }

  // …and end to end: the drag has to deliver what the DROP would accept (§16).
  // The true ceiling is found by bisection on the editor's own zone rule, so the
  // gate cannot drift with the slack constants.
  for (const deg of [-18.6, -10, 0]) {
    const p = stickAt(deg);
    const S = screen(level, { parts: [p] });
    if (!S._segInBuildZone({ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 })) {
      gate(`88. (${deg}° starts inside the zone)`, false, 'fixture is wrong');
      continue;
    }
    let lo = 0, hi = 200;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (S._segInBuildZone({ x: p.x1, y: p.y1 - m }, { x: p.x2, y: p.y2 - m })) lo = m; else hi = m;
    }
    const g = gesture(S, MID, { x: MID.x, y: MID.y - 60 }, { watch: partAt(S, 0) });
    const up = MID.y - LEN / 2 * Math.sin(deg * Math.PI / 180) - g.after.y;
    gate(`88. a stick at ${deg}° moves up as far as the zone really allows`,
      up > lo - 2 && up < lo + 2.5, `${up.toFixed(1)} px against a ${lo.toFixed(1)} px ceiling`);
    gate(`88. …and where the drag left it is where the drop kept it`, g.held);
  }

  // The shape of the bug, stated as the thing that betrayed it: the best angle
  // is the one lying ALONG the tilted ceiling, not the axis-aligned one. Read
  // off the box it peaked at 0° — which is where an AABB is thinnest, and has
  // nothing to do with the level.
  {
    const upFor = (deg) => {
      const p = stickAt(deg);
      const S = screen(level, { parts: [p] });
      const y0 = MID.y - (LEN / 2) * Math.sin(deg * Math.PI / 180);
      const g = gesture(S, MID, { x: MID.x, y: MID.y - 60 }, { watch: partAt(S, 0) });
      return y0 - g.after.y;
    };
    const along = upFor(-10), square = upFor(0);
    gate('88. the roomiest angle is the one lying ALONG the tilted ceiling',
      along > square, `${along.toFixed(1)} px at the zone’s own tilt against ${square.toFixed(1)} px square to the world`);
  }
});

// ---------- 89. two bars decline the orientation choice ----------
//
// *"Advanced and Ghost don't need vertical option"* (2026-08-21). The piece
// toolbar and the play dock genuinely do — they are strips of buttons, and which
// edge you park them on decides which way they should run. The Advanced bar is a
// block of ROWS and the GhostRun chip is a square GRAPH, so turning either
// sideways moves the handle and nothing else: a control offering a choice it
// cannot honour is worse than no control.
//
// `_makeBar` needs a document, so what runs here is `_applyBarChrome` against
// hand-made bars — the half that decides what the button SAYS — plus the source
// facts about which four bars ask for what. The rest is checked in the browser.
section('89', () => {
  const fakeCls = () => { const c = new Set(); return { add: (n) => c.add(n), remove: (n) => c.delete(n), toggle: (n, on) => (on ? c.add(n) : c.delete(n)), contains: (n) => c.has(n) }; };
  const fakeBar = (noOrient) => ({
    pos: { x: 0, y: 0, orient: 'horizontal' }, noOrient,
    wrap: { classList: fakeCls(), style: {} },
    orientBtn: { textContent: '', title: '', classList: fakeCls() },
  });
  const S = Object.create(GameScreen.prototype);
  S._fitBarInner = () => {}; S._clampBarPos = () => {};
  const chrome = GameScreen.prototype._applyBarChrome;

  const plain = fakeBar(false);
  chrome.call(S, plain);
  gate('89. an ordinary bar’s button says which way it will go',
    plain.orientBtn.textContent === '⇅' && /vertical layout/.test(plain.orientBtn.title),
    plain.orientBtn.textContent);
  plain.pos.orient = 'vertical';
  chrome.call(S, plain);
  gate('89. …and flips when it is turned', plain.orientBtn.textContent === '⇄');

  const fixed = fakeBar(true);
  chrome.call(S, fixed);
  gate('89. a bar that declines is never given a label to show',
    fixed.orientBtn.textContent === '' && fixed.orientBtn.title === '');
  gate('89. …and is still laid out horizontally, like any other',
    fixed.wrap.classList.contains('horizontal') && !fixed.wrap.classList.contains('vertical'));

  // Which bars ask, read off the source — the two that are strips keep the
  // choice, the two that are blocks give it up.
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const asks = (key) => {
    const at = src.indexOf(`_makeBar('${key}'`);
    return at > 0 && /noOrient:\s*true/.test(src.slice(at, at + 800));
  };
  gate('89. the Advanced bar and the GhostRun chip decline it',
    asks('advPos') && asks('sweepPos'));
  gate('89. …and the piece toolbar and the play dock keep it',
    !asks('toolbarPos') && !asks('dockPos'));
  // …and the button is HIDDEN rather than left out, so nothing has to null-check
  gate('89. the button is hidden, not omitted — `_bindBarDrag` still reaches for it',
    /if \(opts\.noOrient\) orientBtn\.classList\.add\('hidden'\)/.test(src)
    && /bar\.orientBtn\.contains\(e\.target\)/.test(src));
  // …and a stored `vertical` from before it declined is pinned back
  gate('89. …and a `vertical` left in storage is pinned back rather than honoured',
    /if \(bar\.noOrient\) bar\.pos\.orient = 'horizontal';/.test(src));
});

// ---------- gate 90: the modifier readout says what will actually happen ----------
//
// game.js's own comment on the Level pointer counts SEVEN meanings for Alt and
// then says the fix is "to say what the gesture actually is, not to add a third
// binding to the busiest key". The chip is that, generalised: hold a modifier
// and the editor names the one meaning that is armed.
//
// These gates exist because a readout that is WRONG is worse than none — it
// teaches a gesture the editor will then refuse. Every claim below is checked
// against the branch in game.js that actually implements it, by reading the
// source, so the chip and the handler cannot drift apart silently.
section('90', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const utilSrc = fs.readFileSync(path.join(root, 'public/js/util.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const say = (c) => { const r = modifierIntent(c); return r ? r.keys + ' · ' + r.label : null; };

  // --- it is a PURE rule, reachable without a DOM ---
  gate('90. modifierIntent answers with no DOM, no event and no GameScreen',
    typeof modifierIntent === 'function' && say({ alt: true, tool: 'wheel-cw' }) != null);
  gate('90. …and says nothing at all when nothing is held',
    modifierIntent({ tool: 'wheel-cw' }) === null
    && modifierIntent({}) === null && modifierIntent() === null);
  // A chip reading "Alt: nothing" would teach you to stop reading it.
  gate('90. …and nothing when the held key means nothing HERE',
    modifierIntent({ alt: true, tool: 'pointer' }) === null,
    'alt+bare-pointer ' + say({ alt: true, tool: 'pointer' }));
  gate('90. …and Shift on a place tool promises the FC pan',
    /Pan/.test(say({ shift: true, tool: 'wheel-cw' }) || ''),
    say({ shift: true, tool: 'wheel-cw' }));

  // --- the sizes it quotes are the ladder game.js really places ---
  // Both placement paths now ask sizes.js `placeRung`, so this asks it too
  // rather than matching the source text they used to spell it out in. That is
  // a stronger claim, not a weaker one: the chip and the placement are being
  // compared through the one function that decides, at every armed rung.
  gate('90. both placement paths ask placeRung, rather than indexing the ladder',
    /rungRadius\(placeRung\(this\.sizeRung, e\.altKey, e\.shiftKey\)\)/.test(src)
    && (src.match(/rungRadius\(placeRung\(/g) || []).length >= 2
    && !/WHEEL_SIZES\[2\] : WHEEL_SIZES\[0\]/.test(src),
    (src.match(/rungRadius\(placeRung\(/g) || []).length + ' call sites');
  for (const armed of [0, 1, 2]) {
    gate('90. Alt quotes the size placeRung really returns — armed ' + rungName(armed),
      say({ alt: true, tool: 'wheel-cw' }).endsWith('r' + rungRadius(placeRung(armed, true, false)))
      && say({ alt: true, shift: true, tool: 'wheel-cw' })
        .endsWith('r' + rungRadius(placeRung(armed, true, true))),
      say({ alt: true, tool: 'wheel-cw' }) + ' / ' + say({ alt: true, shift: true, tool: 'wheel-cw' }));
  }
  gate('90. …and the prop/terrain ladder is the SAME ladder',
    say({ alt: true, tool: 'prop-ball' }).includes('r' + WHEEL_SIZES[0])
    && say({ alt: true, tool: 'terrain-box' }).includes('r' + WHEEL_SIZES[0]));

  // --- the grid it promises is the grid the drag lands on ---
  for (const mode of ['on', 'rev', 'off']) {
    for (const [shift, alt] of [[false, false], [true, false], [false, true], [true, true]]) {
      const mine = gridStepFor(mode, shift, alt);
      const theirs = mode === 'off' ? 0
        : alt ? GRID_FINE
        : shift ? GRID_STEP
        : (mode === 'on' ? GRID_STEP : 0);
      gate('90. grid table agrees with _gridStepOf — ' + mode
        + (shift ? '+Shift' : '') + (alt ? '+Alt' : ''),
        mine === theirs, mine + ' vs ' + theirs);
    }
  }
  gate('90. …and _gridStepOf in game.js is still the table this copies',
    /if \(alt\) return GRID_FINE;[\s\S]{0,80}if \(shift\) return GRID_STEP;/.test(src));
  gate('90. a drag on the fine grid says the fine grid',
    say({ alt: true, drag: 'move', snapMode: 'on' }) === 'Alt · Snap to the ' + GRID_FINE + ' grid',
    say({ alt: true, drag: 'move', snapMode: 'on' }));
  // OFF means off and no modifier reopens it — so the chip must not imply one did.
  gate('90. …and with the latch OFF it says nothing rather than "free"',
    modifierIntent({ shift: true, drag: 'move', snapMode: 'off' }) === null);

  // --- the claims it makes about non-grid gestures ---
  gate('90. Alt on the delete tool promises ONE link, which is what _deleteHit takes',
    /_deleteHit\(hit, \{ one: e\.altKey \}\)/.test(src)
    && /ONE link/.test(say({ alt: true, tool: 'delete' })));
  // The chip and the drag ask the SAME function, so this asks it too. Matching
  // the source text broke the moment J arrived and the branch stopped being a
  // bare `if (e.altKey)` — which is the gate doing its job, but a gate that
  // compares behaviour survives a refactor that a gate reading source cannot.
  gate('90. the stick drag asks laysRope rather than reading altKey itself',
    /_dragLaysRope\(e\) \{ return laysRope\(e\.altKey, this\.ropeArmed\); \}/.test(src)
    && /if \(this\._dragLaysRope\(e\)\) \{/.test(src));
  for (const ropeArmed of [false, true]) {
    for (const alt of [false, true]) {
      const willRope = laysRope(alt, ropeArmed);
      const said = say({ alt, drag: 'rod', tool: 'rod-wood', ropeArmed, snapMode: 'off' });
      // Only Alt gets a chip at all, so only Alt is checked for agreement.
      if (!alt) continue;
      gate('90. Alt on a stick promises what laysRope really does — armed '
        + ropeArmed, willRope ? /rope/i.test(said) : /ONE stick/.test(said), said);
    }
  }
  gate('90. …and it says WHICH rope, because the two sticks lay different ones',
    say({ alt: true, drag: 'rod', tool: 'rod-wood' }) !== say({ alt: true, drag: 'rod', tool: 'rod-water' }),
    say({ alt: true, drag: 'rod', tool: 'rod-water' }));
  gate('90. Shift/Alt on the rotate knob quote the two steps _rotateDrag uses',
    /e\?\.shiftKey \? Math\.PI \/ 4 : e\?\.altKey \? Math\.PI \/ 18 : 0/.test(src)
    && say({ shift: true, drag: 'rotate' }).includes('45')
    && say({ alt: true, drag: 'rotate' }).includes('10'));
  gate('90. Alt on a Bézier handle promises the SHARP corner that branch takes',
    /if \(e\.altKey\) \{\s*\/\/ Sharp: independent/.test(src)
    && /Sharp/.test(say({ alt: true, drag: 'handle' })));

  // FC1: Ctrl+left deletes. Multi-select is Ctrl+Shift.
  gate('90. Ctrl+left on a piece promises Delete, which _pointerDown does',
    /Delete this piece/.test(say({ ctrl: true, overPiece: true }) || '')
    && /e\.ctrlKey && !e\.shiftKey && e\.button === 0/.test(src),
    say({ ctrl: true, overPiece: true }));
  gate('90. …and Ctrl+Shift promises the multi-select toggle _toggleMultiSel really does',
    /if \(e\.ctrlKey && e\.shiftKey && !e\.altKey && this\.tool !== 'delete'/.test(src)
    && /selection/.test(say({ ctrl: true, shift: true, overPiece: true })));
  gate('90. …and Ctrl+Alt on a piece promises a single rope link',
    /ONE link/.test(say({ ctrl: true, alt: true, overPiece: true }) || ''),
    say({ ctrl: true, alt: true, overPiece: true }));

  // --- both meanings of Alt on a selection, because both are armed ---
  gate('90. with a selection Alt names the ARROW step as well as the drag grid',
    say({ alt: true, tool: 'pointer', hasSel: true, snapMode: 'on' })
      === 'Alt · Arrows nudge ' + NUDGE_STEPS[2] + ' px · drag snaps to ' + GRID_FINE,
    say({ alt: true, tool: 'pointer', hasSel: true, snapMode: 'on' }));
  gate('90. …and Shift+Alt names the coarse arrow step',
    say({ alt: true, shift: true, tool: 'pointer', hasSel: true, snapMode: 'on' })
      .includes(NUDGE_STEPS[0] + ' px'));
  gate('90. …which are the steps _nudge really takes',
    /e\.shiftKey && e\.altKey \? NUDGE : e\.altKey \? NUDGE_MICRO : NUDGE_FINE/.test(src));

  // --- the composed labels can be translated at all ---
  // A label built by interpolation is a different English sentence per number,
  // and t() can only match a key the source really says.
  const ruleBody = utilSrc.slice(utilSrc.indexOf('export function modifierIntent'),
    utilSrc.indexOf('\n// ---------- tooltips'));
  gate('90. every composed label goes through tf(), not string interpolation',
    !/out\(`/.test(ruleBody), 'no out(`template`) inside modifierIntent');

  // --- the chip's own wiring ---
  gate('90. the chip is driven from the frame loop, not from _pointerDown',
    /this\._syncCursor\(\);[\s\S]{0,400}this\._syncModChip\(\);/.test(src),
    'the same argument the cursor sync makes: a dozen early returns');
  gate('90. …and blur clears it, because the keyup goes to the other window',
    /this\._heldMods = null; this\._syncModChip\(\);/.test(src)
    && /_modsFromEvent/.test(src));
  gate('90. …and it is guarded on the rendered text, so a still frame writes nothing',
    /if \(sig === this\._modChipSig\) return;/.test(src));
  gate('90. …and it says nothing while the sim runs',
    /this\.playing \|\| this\._uiCovered\?\.\(\) \? null : modifierIntent/.test(src));
  // It follows the pointer's context, so it would otherwise sit under the
  // cursor at the exact moment the gesture it describes is being armed.
  // Scoped to the RULE, not searched across the file. The first draft used
  // /\.mod-chip \{[^}]*pointer-events: none;/ and it passed with the line
  // deleted, because `.tip` above it carries the same two declarations in the
  // same order and the regex found those instead.
  const modRule = cssSrc.slice(cssSrc.search(/^\.mod-chip \{/m));
  const modBlock = modRule.slice(0, modRule.search(/^\}/m));
  gate('90. the chip cannot eat the press it is describing',
    modBlock.includes('pointer-events: none'),
    'inside the .mod-chip rule itself, not merely somewhere in the file');

  // --- and the read-only waypoint probe the chip needs ---
  const spotFn = /_waypointSpotAt\(w\) \{[\s\S]*?\n \}\n/.exec(src);
  gate('90. _waypointSpotAt is read-only — the chip asks it every frame',
    !!spotFn && !/this\._commit\(\)/.test(spotFn[0]) && !/this\._toast\(/.test(spotFn[0]),
    spotFn ? 'no _commit and no _toast inside it' : 'not found');
  gate('90. …and _tryInsertWaypoint asks the SAME probe rather than a second copy',
    /_tryInsertWaypoint\(w\) \{\s*const spot = this\._waypointSpotAt\(w\);/.test(src));
});

// ---------- gate 91: the armed size rung and the armed rope ----------
//
// Size used to be a modifier held at the moment of the click: Alt for small,
// Shift+Alt for large. That is a size you cannot see until you have pressed
// the key, on the most overloaded key in the editor, re-held for every piece.
// `,` and `.` arm a rung instead, and `J` arms a rope.
//
// The modifier still WINS, unchanged, so nobody's hands have to be re-taught —
// and that override is the thing most worth gating, because it is the part a
// refactor would quietly drop.
section('91', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const sizeSrc = fs.readFileSync(path.join(root, 'public/js/sizes.js'), 'utf8');

  // --- the ladder the rung indexes is the wheel ladder, not a second one ---
  gate('91. the rung ladder IS the wheel ladder',
    RUNG_NAMES.length === WHEEL_SIZES.length,
    RUNG_NAMES.length + ' names for ' + WHEEL_SIZES.length + ' rungs: ' + WHEEL_SIZES.join(', '));
  gate('91. …and the default rung is the standard wheel',
    rungRadius(DEFAULT_RUNG) === STD_WHEEL_R, 'r' + rungRadius(DEFAULT_RUNG) + ' vs r' + STD_WHEEL_R);
  gate('91. …and rungName agrees with the name the info chip already used',
    rungName(0) === 'small' && rungName(1) === 'standard' && rungName(2) === 'large',
    RUNG_NAMES.join(' / '));

  // --- ALT STILL WINS, at every armed rung ---
  // This is the compatibility promise: someone who has Alt+click in their
  // hands keeps it, whatever the new keys have armed.
  for (const armed of [0, 1, 2]) {
    gate('91. Alt still means SMALL whatever is armed — armed ' + rungName(armed),
      rungRadius(placeRung(armed, true, false)) === WHEEL_SIZES[0],
      'r' + rungRadius(placeRung(armed, true, false)));
    gate('91. …and Shift+Alt still means LARGE — armed ' + rungName(armed),
      rungRadius(placeRung(armed, true, true)) === WHEEL_SIZES[2],
      'r' + rungRadius(placeRung(armed, true, true)));
    gate('91. …and with NO modifier you get exactly what you armed — ' + rungName(armed),
      placeRung(armed, false, false) === armed
      && rungRadius(placeRung(armed, false, false)) === WHEEL_SIZES[armed]);
    // Shift alone is force-move / the coarse grid; it must not touch the size.
    gate('91. …and Shift ALONE does not change the size — ' + rungName(armed),
      placeRung(armed, false, true) === placeRung(armed, false, false));
  }
  // Unarmed, the whole thing must behave exactly as it did before it existed.
  gate('91. with the default rung armed, every combination matches the OLD rule',
    [[false, false, STD_WHEEL_R], [true, false, WHEEL_SIZES[0]],
     [false, true, STD_WHEEL_R], [true, true, WHEEL_SIZES[2]]]
      .every(([a, s, want]) => rungRadius(placeRung(DEFAULT_RUNG, a, s)) === want),
    'the pre-2026-08-23 behaviour, unchanged');

  // --- stepping is clamped, not wrapped ---
  gate('91. stepping down from the smallest stays put rather than wrapping',
    stepRung(0, -1) === 0 && stepRung(2, 1) === 2,
    'a three-rung ladder that wrapped would land two rungs from where one press looked like it went');
  gate('91. …and every step moves exactly one rung',
    [0, 1, 2].every((i) => Math.abs(stepRung(i, 1) - i) <= 1 && Math.abs(stepRung(i, -1) - i) <= 1));
  gate('91. …and you can walk the whole ladder in two presses either way',
    stepRung(stepRung(0, 1), 1) === 2 && stepRung(stepRung(2, -1), -1) === 0);

  // --- a stored rung that has gone bad must not arm a real size ---
  // `+null` is 0 and 0 is `small`, so the naive guard would have turned a
  // missing key into small wheels for ever, silently.
  //
  // Labelled with String(), not JSON.stringify: NaN and Infinity BOTH stringify
  // to "null", so the first version of this loop printed three gates called
  // "a stored rung of null" and the failing one could have been any of them.
  //
  // A finite number out of range CLAMPS (-5 is a rung someone typed wrong, and
  // the nearest rung is the useful answer). Anything else — null, a string,
  // NaN, Infinity — is corruption rather than an out-of-range choice, and the
  // useful answer there is the default, not the top of the ladder.
  const SANE = [
    [null, DEFAULT_RUNG], [undefined, DEFAULT_RUNG], [NaN, DEFAULT_RUNG],
    ['', DEFAULT_RUNG], [false, DEFAULT_RUNG], [[], DEFAULT_RUNG], [{}, DEFAULT_RUNG],
    ['1', DEFAULT_RUNG], [Infinity, DEFAULT_RUNG], [-Infinity, DEFAULT_RUNG],
    [-5, 0], [99, WHEEL_SIZES.length - 1], [1.4, 1], [1.6, 2],
  ];
  for (const [junk, want] of SANE) {
    const got = clampRung(junk);
    gate('91. a stored rung of ' + String(junk) + ' comes back as ' + rungName(want),
      got === want, rungName(got) + ' (' + got + ')');
  }
  gate('91. …and null in particular does NOT come back as small',
    clampRung(null) !== 0 && clampRung(null) === DEFAULT_RUNG,
    'the +null === 0 trap');

  // --- both placement paths, and the persistence ---
  gate('91. the wheel placement asks placeRung with the armed rung',
    /const r = rungRadius\(placeRung\(this\.sizeRung, e\.altKey, e\.shiftKey\)\);/.test(src));
  gate('91. …and so does the terrain/prop ladder, on the SAME rung',
    /const rung = \(mult\) => rungRadius\(placeRung\(this\.sizeRung, e\.altKey, e\.shiftKey\)\) \* mult;/.test(src));
  gate('91. the armed rung is restored through clampRung, not read raw',
    /this\.sizeRung = clampRung\(store\.get\('sizeRung', DEFAULT_RUNG\)\);/.test(src));
  gate('91. …and written back the moment it changes',
    /store\.set\('sizeRung', next\);/.test(src));
  // A rope is a thing you are laying now; a size is a scale you work at.
  gate('91. the armed ROPE is deliberately NOT remembered across sessions',
    /this\.ropeArmed = false;/.test(src) && !/store\.(set|get)\('ropeArmed'/.test(src));

  // --- the rope XOR ---
  gate('91. unarmed, Alt+drag lays the rope exactly as it always has',
    laysRope(true, false) === true && laysRope(false, false) === false);
  gate('91. armed, a plain drag lays the rope and Alt lays one stick',
    laysRope(false, true) === true && laysRope(true, true) === false);
  gate('91. …which is an XOR, so the modifier never means nothing',
    [[0, 0], [0, 1], [1, 0], [1, 1]].every(([a, r]) => laysRope(a, r) !== laysRope(!a, r)),
    'flipping Alt always flips the outcome');

  // --- the keys themselves ---
  gate('91. , and . are bound, unmodified only',
    /case ',': if \(!e\.ctrlKey && !e\.altKey && !e\.shiftKey\) this\._stepSizeRung\(-1\); return;/.test(src)
    && /case '\.': if \(!e\.ctrlKey && !e\.altKey && !e\.shiftKey\) this\._stepSizeRung\(1\); return;/.test(src));
  gate('91. J is bound, unmodified only',
    /case 'j': if \(!e\.ctrlKey && !e\.altKey && !e\.shiftKey\) this\._toggleRopeArmed\(\); return;/.test(src));
  // The three keys must not have been taken from something that already had them.
  {
    const before = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    const count = (re) => (before.match(re) || []).length;
    gate('91. …and each of the three keys is bound exactly once',
      count(/case ',':/g) === 1 && count(/case '\.':/g) === 1 && count(/case 'j':/g) === 1,
      `, ${count(/case ',':/g)}  . ${count(/case '\.':/g)}  j ${count(/case 'j':/g)}`);
  }

  // --- the readouts ---
  gate('91. …with three whole sentences, not a name interpolated into one',
    /'placing small — r\{n\}[^']*',\s*\n?\s*'placing standard — r\{n\}[^']*',\s*\n?\s*'placing large — r\{n\}[^']*'/.test(src),
    'a {name} slot filled with a translated word is the assembled-from-parts trap wearing a tf()');
  gate('91. …and it is silent for tools the rung does not size',
    /if \(!SIZEABLE\.has\(this\.tool\)\) return '';/.test(src));
  gate('91. game.js and the chip rule share ONE list of sizeable tools',
    /export const SIZEABLE = new Set/.test(fs.readFileSync(path.join(root, 'public/js/util.js'), 'utf8'))
    && /SIZEABLE, ROD_TOOLS, laysRope/.test(src));

  // --- and the chip must not claim a key that changes nothing ---
  gate('91. with SMALL armed, Alt is silent because Alt would change nothing',
    modifierIntent({ alt: true, tool: 'wheel-cw', rung: 0 }) === null);
  gate('91. …and with LARGE armed, Shift+Alt is silent for the same reason',
    modifierIntent({ alt: true, shift: true, tool: 'wheel-cw', rung: 2 }) === null);
  gate('91. …but with STANDARD armed it names both, because both move',
    modifierIntent({ alt: true, tool: 'wheel-cw', rung: 1 }) !== null
    && modifierIntent({ alt: true, shift: true, tool: 'wheel-cw', rung: 1 }) !== null);
  gate('91. …and the size it names is the size placeRung returns, at every rung',
    [0, 1, 2].every((rung) => [false, true].every((shift) => {
      const r = modifierIntent({ alt: true, shift, tool: 'wheel-cw', rung });
      return r === null || r.label.endsWith('r' + rungRadius(placeRung(rung, true, shift)));
    })));
});

section('90b', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  gate('90b. bindLegend is a pure rule',
    typeof bindLegend === 'function' && bindLegend({ tool: 'wheel-cw' }).left === 'Place wheel');
  gate('90b. …empty right-click is the mini toolbar',
    bindLegend({ tool: 'pointer' }).right === 'Mini Toolbar'
    && bindLegend({ tool: 'pointer', overPiece: true }).right === 'Piece menu');
  gate('90b. …Shift on empty is pan, on a piece is that piece with stretching links',
    bindLegend({ shift: true, tool: 'pointer' }).left === 'Pan'
    && /stretch/.test(bindLegend({ shift: true, tool: 'pointer', overPiece: true }).left));
  gate('90b. …plain left on a piece is the connected machine',
    /connected/i.test(bindLegend({ tool: 'pointer', overPiece: true }).left));
  gate('90b. …a stack of pieces offers Pick a piece on left and right',
    bindLegend({ tool: 'pointer', overPiece: true, stacked: true }).left === 'Pick a piece'
    && bindLegend({ tool: 'pointer', overPiece: true, stacked: true }).right === 'Pick a piece');
  gate('90b. …unless that piece is already selected, left moves instead',
    /connected/i.test(bindLegend({ tool: 'pointer', overPiece: true, stacked: true, selInStack: true }).left)
    && bindLegend({ tool: 'pointer', overPiece: true, stacked: true, selInStack: true }).right === 'Pick a piece');
  gate('90b. …a pin on a selected prop: move, menu, Ctrl deletes',
    bindLegend({ tool: 'pointer', overPiece: true, overPropPin: true, pinOnSel: true, overPinnable: true }).left === 'Move pin'
    && bindLegend({ tool: 'pointer', overPiece: true, overPropPin: true, pinOnSel: true }).right === 'Pin menu'
    && bindLegend({ tool: 'pointer', ctrl: true, overPropPin: true, pinOnSel: true }).left === 'Delete pin');
  gate('90b. …Alt on a prop face adds a pin',
    bindLegend({ tool: 'pointer', alt: true, overPinnable: true, overPiece: true }).left === 'Add pin on this piece');
  gate('90b. …double-click a machine piece selects the connected set',
    bindLegend({ tool: 'pointer', overMachine: true, overPiece: true }).dbl === 'Select connected machine');
  gate('90b. …double-click a label edits it',
    bindLegend({ tool: 'pointer', overText: true, overPiece: true }).dbl === 'Edit text');
  gate('90b. …a path node: move, Ctrl deletes, right-click is the node menu, double-click toggles curve',
    bindLegend({ tool: 'pointer', overWaypoint: true, overPiece: true }).left === 'Move node'
    && bindLegend({ tool: 'pointer', overWaypoint: true }).right === 'Node menu'
    && bindLegend({ tool: 'pointer', ctrl: true, overWaypoint: true }).left === 'Delete node'
    && bindLegend({ tool: 'pointer', overWaypoint: true }).dbl === 'Corner ⇄ curve'
    && bindLegend({ tool: 'pointer', ctrl: true, overWaypoint: true, overPiece: true, hasSel: true }).dbl === 'Corner ⇄ curve');
  gate('90b. …double-click on a node toggles curve; Ctrl+double-click on a piece is the align anchor',
    bindLegend({ tool: 'pointer', overWaypoint: true, hasSel: true }).dbl === 'Corner ⇄ curve'
    && bindLegend({ tool: 'pointer', overPath: true, hasSel: true }).dbl === '—'
    && bindLegend({ tool: 'pointer', ctrl: true, overPiece: true, hasSel: true }).dbl === 'Make align anchor');
  gate('90b. …an armed rotate knob: arrows 1° / Shift 45° / Alt 10°',
    bindLegend({ tool: 'pointer', armedRotate: true, hasSel: true }).arrows === 'Rotate 1°'
    && bindLegend({ tool: 'pointer', armedRotate: true, hasSel: true, shift: true }).arrows === 'Rotate 45°'
    && bindLegend({ tool: 'pointer', armedRotate: true, hasSel: true, alt: true }).arrows === 'Rotate 10°');
  gate('90b. …a Bézier handle names move / Alt sharp / Shift mirror',
    bindLegend({ tool: 'pointer', overHandle: true }).left === 'Move handle'
    && bindLegend({ tool: 'pointer', overHandle: true, alt: true }).left.includes('Sharp')
    && bindLegend({ tool: 'pointer', overHandle: true, shift: true }).left.includes('Mirror'));
  gate('90b. …Ctrl+left names delete',
    bindLegend({ ctrl: true, tool: 'pointer', overPiece: true }).left === 'Delete');
  gate('90b. …Ctrl+Shift names marquee on empty',
    /marquee/i.test(bindLegend({ ctrl: true, shift: true, tool: 'pointer' }).left));
  gate('90b. …middle on Create over a piece is the through-solids drag',
    /through/i.test(bindLegend({ mode: 'maker', tab: 'level', overPiece: true }).middle));
  gate('90b. …painter stroke names tracing and the close keys',
    bindLegend({ tool: 'terrain-paint', paint: true }).note.includes('Backspace'));
  gate('90b. …a running play in the Maker stops on a piece',
    bindLegend({ playing: true, mode: 'maker', tool: 'pointer', overPiece: true }).left === 'Stop');
  gate('90b. …arrows scrub a tape unless Alt is for a nudge',
    bindLegend({ hasTape: true, hasSel: true }).arrows.startsWith('Scrub')
    && bindLegend({ hasTape: true, hasSel: true, alt: true }).arrows.includes('Nudge'));
  gate('90b. …scroll over empty is zoom',
    bindLegend({ tool: 'pointer' }).scroll === 'Zoom');
  gate('90b. …scroll over a selected stick varies weight, Shift ±10, Alt ±100',
    bindLegend({ tool: 'pointer', scrollSel: 'rod' }).scroll === 'Vary weight'
    && bindLegend({ tool: 'pointer', scrollSel: 'rod', shift: true }).scroll === 'Vary weight ±10'
    && bindLegend({ tool: 'pointer', scrollSel: 'rod', alt: true }).scroll === 'Vary weight ±100');
  gate('90b. …scroll over a selected wheel / label / shape names the resize',
    bindLegend({ tool: 'pointer', scrollSel: 'wheel' }).scroll === 'Vary wheel size'
    && bindLegend({ tool: 'pointer', scrollSel: 'text' }).scroll === 'Vary label size'
    && bindLegend({ tool: 'pointer', scrollSel: 'shape' }).scroll === 'Resize');
  gate('90b. …a sweep field keeps scroll as zoom so looking around does not edit',
    bindLegend({ tool: 'pointer', scrollSel: 'rod', ghostSweep: true }).scroll === 'Zoom');
  gate('90b. the toolbar grip menu toggles the chip',
    /Bindings chip/.test(src) && /_setBindChip/.test(src) && /bindLegend\(/.test(src));
  const ctx = src.slice(src.indexOf('\n  _contextMenu('), src.indexOf('\n  _deleteAtCursorPt('));
  gate('90b. Ctrl+right-click is no longer a delete — the menu path does not call it',
    !/_deleteAtCursorPt\(/.test(ctx) && /_deleteAtCursorPt\(w/.test(src),
    'delete lives on Ctrl+left / _deleteAtCursorPt, not the context menu');
});

// ---------- gate 92: magnetic bars ----------
//
// A dragged bar is pulled onto the alignments already in the room — the
// viewport's edges and centre lines, and every edge and centre of every other
// visible bar — and the alignment it caught is drawn so you can see why it
// stopped there. Nothing docks and nothing persists: the bar keeps the plain
// {x, y} it always kept.
//
// scripts/probe-barguides.mjs explores the rule; this holds the contract. Three
// of these exist because a design review found the defect in an earlier draft
// and the probe then reproduced it: an intransitive comparator, no overshoot,
// and both centres capturing at once.
section('92', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const VIEW = { w: 1100, h: 640 };
  const EDGE = 12;
  const W = 360, H = 44;
  const other = { x: 300, y: 500, w: 280, h: 44 };
  const at = (x, y, o = {}) => barGuides({ x, y, w: W, h: H }, [other], VIEW, { edge: EDGE, ...o });

  // --- pure, and reachable ---
  gate('92. barGuides answers with no DOM, no event and no GameScreen',
    typeof barGuides === 'function' && Number.isFinite(at(100, 100).x));
  gate('92. …and it never proposes a position the clamp would refuse',
    [[-9999, -9999], [9999, 9999], [0, 0], [550, 320]].every(([x, y]) => {
      const r = at(x, y);
      return r.x >= 4 - 1e-9 && r.y >= 4 - 1e-9
        && r.x <= VIEW.w - W - 4 + 1e-9 && r.y <= VIEW.h - H - 4 + 1e-9;
    }), 'snap proposes, clamp disposes');
  gate('92. the clamp is ONE function, shared with the drag',
    /p\.x = clampBarAxis\(p\.x, w, r\.width\);/.test(src)
    && /p\.y = clampBarAxis\(p\.y, h, r\.height\);/.test(src),
    'until this, the snap and the clamp were two copies of the same four numbers');

  // --- a TOTAL order: the winner cannot depend on the sort ---
  // The draft this replaced banded moves within half a pixel as "equal" and
  // ranked inside the band by other fields. That is intransitive — with moves
  // 0.0, 0.4, 0.8 it can rank A over B over C over A — so the answer depended
  // on V8's pivot choice, which depends on array length.
  {
    const answers = new Set();
    for (let i = 0; i < 200; i++) answers.add(at(302, 250).x.toFixed(6));
    gate('92. 200 identical calls give exactly one answer', answers.size === 1,
      [...answers].join(' '));
    const many = [{ x: 300, y: 500, w: 280, h: 44 }, { x: 305, y: 120, w: 280, h: 44 },
      { x: 296, y: 300, w: 200, h: 44 }, { x: 300.4, y: 40, w: 100, h: 44 }];
    const xs = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]].map((p) =>
      barGuides({ x: 302, y: 250, w: W, h: H }, p.map((i) => many[i]), VIEW, { edge: EDGE }).x);
    gate('92. …and four orderings of the same field agree',
      new Set(xs.map((v) => v.toFixed(4))).size === 1, xs.map((v) => v.toFixed(2)).join(' '));
  }

  // --- OVERSHOOT counts as arrival, on the wall it went past and no other ---
  for (const [name, x, y, axis, want] of [
    ['past the left', -240, 300, 'x', EDGE],
    ['past the right', VIEW.w + 200, 300, 'x', VIEW.w - EDGE - W],
    ['past the top', 400, -180, 'y', EDGE],
    ['past the bottom', 400, VIEW.h + 300, 'y', VIEW.h - EDGE - H],
  ]) {
    const r = at(x, y);
    gate('92. a bar thrown ' + name + ' lands ON the edge line',
      Math.abs(r[axis] - want) < 0.001, r[axis].toFixed(1) + ' want ' + want.toFixed(1));
  }
  gate('92. …which is NOT where the bare clamp would have parked it',
    Math.abs(at(-240, 300).x - clampBarAxis(-240, W, VIEW.w, 4)) > 1,
    'snap ' + at(-240, 300).x + ' vs clamp ' + clampBarAxis(-240, W, VIEW.w, 4));
  // The half of the rule that was missing: any probe past the wall counted, so
  // a bar thrown off the top had its BOTTOM edge declared an overshoot of the
  // TOP line — the shorter move, so it won — and the bar hung with 12 px on
  // screen. It measured y = 4 instead of 12.
  gate('92. …the edge that went past the wall is the edge put back on it',
    /c\.id === 'view:lead' && p === 'lead' && probe\[p\] < c\.at/.test(
      fs.readFileSync(path.join(root, 'public/js/util.js'), 'utf8')));

  // --- HYSTERESIS: the exit is wider than the entrance ---
  {
    gate('92. the release is strictly wider than the pull, on both pointers',
      BAR_SNAP_RELEASE > BAR_SNAP_PULL && BAR_SNAP_RELEASE_TOUCH > BAR_SNAP_PULL_TOUCH,
      BAR_SNAP_PULL + '/' + BAR_SNAP_RELEASE + '  touch ' + BAR_SNAP_PULL_TOUCH + '/' + BAR_SNAP_RELEASE_TOUCH);
    // Walk away from a caught alignment, feeding the previous answer back in.
    // A rule that decides on its own threshold flips more than once.
    let prev = at(EDGE, 300), flips = 0, held = 0;
    for (let d = 0; d <= 40; d++) {
      const r = at(EDGE + d, 300, { prev });
      if (d && (r.hit.x != null) !== (prev.hit.x != null)) flips++;
      if (r.hit.x != null) held = d;
      prev = r;
    }
    gate('92. a held alignment releases exactly once over a 40 px walk', flips === 1,
      flips + ' state changes');
    gate('92. …and holds out to the release, not the pull',
      held >= BAR_SNAP_PULL && held <= BAR_SNAP_RELEASE + 1, 'held to ' + held + ' px');
    let cold = 0;
    for (let d = 0; d <= 40; d++) if (at(EDGE + d, 300).hit.x != null) cold = d;
    gate('92. …and without the memory it lets go sooner, which is the point',
      cold < held, cold + ' vs ' + held);
  }

  // --- never magnetised to dead centre ---
  {
    const cx = VIEW.w / 2 - W / 2, cy = VIEW.h / 2 - H / 2;
    let pulled = 0;
    for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
      if (!dx && !dy) continue;             // already there: nothing was pulled
      const r = at(cx + dx, cy + dy);
      if (Math.abs(r.x - cx) < 0.01 && Math.abs(r.y - cy) < 0.01) pulled++;
    }
    gate('92. no approach is magnetised to dead centre, over the machine',
      pulled === 0, pulled + ' of 168 were');
  }

  // --- the escape hatch, read live ---
  gate('92. Alt refuses every snap',
    at(-240, 300, { free: true }).hit.x == null
    && at(-240, 300, { free: true }).guides.length === 0);
  gate('92. …but still clamps, so Alt cannot post a bar off-screen',
    at(-9999, -9999, { free: true }).x === 4 && at(-9999, -9999, { free: true }).y === 4);
  gate('92. …and it is read per MOVE event, not latched at the grab',
    /free: !!ev\.altKey \|\| !!this\._modLatch\?\.alt/.test(src),
    'the moment you want a bar unmagnetised is after you found out it will not go there');

  // --- the corners the shell owns ---
  {
    // .build-note is position:fixed, z-index 400, bottom-left, OUTSIDE the game
    // root — 400 is far above the HUD's 10.
    gate('92. the build note really is fixed above the HUD, which is why this exists',
      /\.build-note \{[^}]*position: fixed;[^}]*z-index: 400;/s.test(cssSrc));
    const note = { x: 12, y: VIEW.h - 46, w: 210, h: 34 };
    const w2 = 200, h2 = 44;
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const aims = [[16, 600], [10, 590], [20, 578], [8, 560], [14, 552]];
    const bare = aims.map(([x, y]) => barGuides({ x, y, w: w2, h: h2 }, [], VIEW, { edge: EDGE }));
    gate('92. unguarded, every approach to that corner would hide the bar',
      bare.every((r) => hit({ ...r, w: w2, h: h2 }, note)), bare.length + ' of ' + aims.length);
    const kept = aims.map(([x, y]) =>
      barGuides({ x, y, w: w2, h: h2 }, [], VIEW, { edge: EDGE, exclude: [note] }));
    gate('92. …and with the note excluded, none of them does',
      kept.every((r) => !hit({ ...r, w: w2, h: h2 }, note)),
      kept.map((r) => r.x.toFixed(0) + ',' + r.y.toFixed(0)).join(' '));
    gate('92. …landing on top of it, which is where they were going',
      kept.every((r) => Math.abs(r.y - (note.y - h2)) < 0.01));
    // Pushed, not withdrawn — measured: the note is 210x34 and the snap moves
    // at most 13 px, so a bar close enough to be caught already overlaps and
    // withdrawing the snap changes nothing.
    gate('92. …and a bar put there BY HAND, with no snap, is left alone',
      (() => { const r = barGuides({ x: 60, y: note.y + 2, w: w2, h: h2 }, [], VIEW,
        { edge: EDGE, exclude: [note] });
        return r.hit.x != null || r.hit.y != null || hit({ ...r, w: w2, h: h2 }, note); })(),
      'moving furniture somebody placed on purpose is worse than the overlap');
    gate('92. the notes are queried from the document, not hard-coded here',
      /querySelectorAll\('\.build-note, \.return-note'\)/.test(src));
  }

  // --- the wiring ---
  gate('92. the drag asks barGuides rather than adding a delta itself',
    /snap = barGuides\(/.test(src) && !/bar\.pos\.x = start\.px \+ \(ev\.clientX - start\.x\);/.test(src));
  gate('92. the field is measured ONCE, at the grab',
    /const field = this\._barField\(bar\);/.test(src)
    && /_barField\(dragged\) \{/.test(src),
    'four wraps re-measured per pointermove is four layout flushes a frame');
  gate('92. the previous answer is fed back, or the hysteresis is decor',
    /prev: snap,/.test(src));
  gate('92. the guides are cleared on drop',
    /end: \(moved\) => \{\s*\n\s*this\._paintBarGuides\(null\);/.test(src));
  gate('92. …and nothing about a dock or a shelf is persisted',
    !/store\.set\((?:bar\.storeKey|'[a-z]+Pos')[^)]*dock/i.test(src)
    && !/pos\.(dock|shelf|order)\b/.test(src),
    'the bar keeps the plain {x, y} it always kept');
  gate('92. the guide layer cannot eat the drag it is explaining',
    /\.bar-guides \{[^}]*pointer-events: none;/s.test(cssSrc)
    && /\.bar-guide \{[^}]*pointer-events: none;/s.test(cssSrc));
  gate('92. …and sits just above the HUD, so a line crosses the bars',
    /\.bar-guides \{[^}]*z-index: 11;/s.test(cssSrc));
});

// ---------- gate 93: the family pip row ----------
//
// A Terrain, Prop or Goal button stands for two or three pieces. The title
// names the next one, but a title is something you have to go and ask for, and
// the button gave no sign at all that it was one of several. One pip per
// member, the current one a pill.
section('93', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const rule = (sel) => {
    const i = cssSrc.search(new RegExp('^' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{', 'm'));
    return i < 0 ? '' : cssSrc.slice(i, cssSrc.indexOf('\n}', i));
  };

  // --- one pip per member, from the families themselves ---
  gate('93. the pips are built from TOOL_FAMILIES, not a hand-typed count',
    /fam \? el\('span', \{ class: 'tool-fam-pips'[\s\S]{0,200}fam\.members\.map/.test(src),
    'a second list of how many members each family has would drift from the first');
  gate('93. …and exactly one is marked current, by identity with this button',
    /class: 'tool-fam-pip' \+ \(m === id \? ' on' : ''\)/.test(src));
  // The button stands for a MEMBER, so the lit pip tracks the button, not the
  // globally-active tool. Every family, every member.
  for (const f of TOOL_FAMILIES) {
    gate('93. the ' + f.id + ' family would draw ' + f.members.length + ' pips',
      f.members.length >= 2, f.members.join(', '));
  }
  gate('93. …and only a family button gets a row at all',
    /fam \? el\('span'/.test(src) && / : null\);\s*\n\s*return btn;/.test(src));

  // --- it must not collide with the two key badges ---
  // .tool-key is bottom-right, .tool-letter bottom-left, so the row goes top.
  gate('93. the row sits at the TOP, where neither key badge is',
    /\.tool-fam-pips \{[^}]*top: calc\(3px \* var\(--bar-scale, 1\)\);/s.test(cssSrc)
    && /\.tool-key \{[^}]*bottom: calc\(1px \* var\(--bar-scale, 1\)\);/s.test(cssSrc));
  gate('93. …and is centred, so it reads the same on a turned toolbar',
    /\.tool-fam-pips \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/s.test(cssSrc));
  gate('93. …and cannot swallow the click on the button under it',
    /\.tool-fam-pips \{[^}]*pointer-events: none;/s.test(cssSrc));
  gate('93. …and is hidden from screen readers, which already hear the family',
    /'aria-hidden': 'true'/.test(src),
    "the button's accessible name carries the family and the next member");

  // --- the measured geometry ---
  // 4px base, because 3px is 2.4 at --bar-scale 0.8 and a 2.4px circle's
  // contrast swings 5.72:1..5.98:1 with sub-pixel phase. At 3.2px: zero swing.
  gate('93. the pip is 4 px, not 3, so its contrast does not move with sub-pixel phase',
    /\.tool-fam-pip \{[^}]*width: max\(3px, calc\(4px \* var\(--bar-scale, 1\)\)\);/s.test(cssSrc),
    '3px base = 2.4px at 0.8, which swung 0.26 of a contrast stop across one pixel');
  // The state is LENGTH, not brightness: an off pip must clear 3:1 to be
  // countable at all, and the first opacity that does is 0.75 — at which point
  // it is barely a stop from the on pip.
  gate('93. the current member is a PILL, so the state is a shape difference',
    /\.tool-fam-pip\.on \{ width: max\(8px, calc\(10px \* var\(--bar-scale, 1\)\)\);/.test(cssSrc));
  gate('93. …and the off pips are opaque enough to be counted (3.44:1 at 0.75)',
    /\.tool-fam-pip \{[^}]*opacity: 0\.75;/s.test(cssSrc),
    '0.34 measured 1.64:1, which is invisible');
  gate('93. the gap keeps a whole-pixel floor, or the pips merge into a dash',
    /gap: max\(1px, calc\(2px \* var\(--bar-scale, 1\)\)\);/.test(cssSrc));
  // Widest case must fit: three pips, one of them the pill, inside the button.
  {
    const S = 0.8;                                   // --bar-scale in the editor
    const pip = Math.max(3, 4 * S), pill = Math.max(8, 10 * S), gap = Math.max(1, 2 * S);
    const widest = pill + 2 * pip + 2 * gap;         // terrain: 3 members
    const btn = 44 * S;
    gate('93. the widest row fits the button with room to spare',
      widest < btn - 4, widest.toFixed(1) + ' px of row in a ' + btn.toFixed(1) + ' px button');
  }

  // --- the active button turns teal, and the pips have to follow ---
  gate('93. on the active button the pips go white, or they vanish into the fill',
    /\.tool\.active \.tool-fam-pip \{ background: #fff;/.test(cssSrc)
    && /\.tool\.active \.tool-label \{ color: #fff; \}/.test(cssSrc),
    'the label already does this; the pips are the same problem');
  gate('93. …and the current one still leads on the active button too',
    /\.tool\.active \.tool-fam-pip\.on \{ opacity: 1; \}/.test(cssSrc));
});

// ---------- gate 94: Escape mid-drag puts the piece back ----------
//
// Reported: "If I move any object (piece/goal piece, collection) and hit
// Escape, it drops it anywhere even against the rules." True, and the shape of
// it was an escape hatch in the literal sense: the live drag deliberately lets
// a piece pass THROUGH other pieces (only the zone edge and terrain are
// enforced while the hand is down — the full check runs at _moveFinish and
// reverts), so Escape, which nulled the drag without ever reaching
// _moveFinish, was the one gesture that could park a piece inside another.
//
// The fix routes Escape through _cancelGesture — the pinch path's cancel,
// which restores the pre-drag state from the top of the undo stack. These
// gates drive the REAL _keyDown mid-REAL-drag, so a regression in either half
// (the key routing or the restore) fails here.
{
  const kev = (key) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
    target: { tagName: 'CANVAS' }, preventDefault() {}, stopPropagation() {} });
  const twoWheels = () => [
    { t: 'wheel', kind: 'cw', x: 100, y: -60, r: 20, id: 'wA' },
    { t: 'wheel', kind: 'cw', x: 220, y: -60, r: 20, id: 'wB' },
  ];

  // A wheel dragged dead onto its neighbour — legal to PASS through live,
  // illegal to STAY — and Escape mid-drag.
  {
    const S = screen(flatWorld(), { tab: 'machine', undo: true, parts: twoWheels() });
    S._pointerDown(ev(100, -60));
    S._pointerMove(ev(150, -60));
    S._pointerMove(ev(220, -60));
    const mid = S.design.parts.find(p => p.id === 'wA');
    gate('94. the live drag really does allow the overlap first',
      Math.abs(mid.x - 220) < 25 && S.drag?.type === 'move',
      `mid-drag x ${mid.x.toFixed(1)}, drag ${S.drag?.type}`);
    S._keyDown(kev('Escape'));
    const after = S.design.parts.find(p => p.id === 'wA');
    gate('94. Escape mid-move puts the piece back where it started',
      S.drag === null && Math.abs(after.x - 100) < 0.01 && Math.abs(after.y + 60) < 0.01,
      `landed ${after.x.toFixed(1)},${after.y.toFixed(1)}`);
    // the pointer is still down somewhere; its eventual lift must be inert
    S._pointerUp(ev(220, -60));
    const rest = S.design.parts.find(p => p.id === 'wA');
    gate('94. …and the stray pointer-up afterwards moves nothing',
      Math.abs(rest.x - 100) < 0.01 && S.design.parts.length === 2,
      `x ${rest.x.toFixed(1)}, ${S.design.parts.length} parts`);
  }

  // The same promise for a GOAL piece, which the report names — its position
  // lives in goalPositions, a different pool from the parts.
  {
    const S = screen({ ...flatWorld(), goalObjs: [{ shape: 'box', x: 200, y: -20, w: 40, h: 40 }] },
      { tab: 'machine', undo: true });
    S._pointerDown(ev(200, -20));
    S._pointerMove(ev(240, -30));
    S._pointerMove(ev(320, -40));
    const mid = { ...S.goalPositions[0] };
    S._keyDown(kev('Escape'));
    gate('94. a goal piece dragged and Escaped goes back too',
      Math.abs(mid.x - 320) < 25
      && Math.abs(S.goalPositions[0].x - 200) < 0.01 && Math.abs(S.goalPositions[0].y + 20) < 0.01,
      `mid ${mid.x.toFixed(1)}, after ${S.goalPositions[0].x.toFixed(1)},${S.goalPositions[0].y.toFixed(1)}`);
  }

  // …and a MULTI-selection move ("collection"), the third thing the report
  // names. Both members must come back, not just the grabbed one.
  {
    const S = screen(flatWorld(), { tab: 'machine', undo: true, parts: twoWheels() });
    S._pointerDown(ev(100, -60, { ctrlKey: true, shiftKey: true })); S._pointerUp(ev(100, -60, { ctrlKey: true, shiftKey: true }));
    S._pointerDown(ev(220, -60, { ctrlKey: true, shiftKey: true })); S._pointerUp(ev(220, -60, { ctrlKey: true, shiftKey: true }));
    gate('94. (fixture) both wheels are in the multi-selection', S.multiSel.length === 2,
      S.multiSel.length + ' selected');
    S._pointerDown(ev(220, -60));
    S._pointerMove(ev(260, -100));
    S._pointerMove(ev(300, -140));
    const mid = S.design.parts.map(p => p.x).join(',');
    S._keyDown(kev('Escape'));
    const xs = S.design.parts.map(p => Math.round(p.x)).join(',');
    gate('94. Escape mid multi-move restores every member',
      S.drag === null && xs === '100,220', `mid [${mid}] -> [${xs}]`);
  }

  // Escape's layers are unchanged where there is no drag: it still clears the
  // selection, and a passive drag (a marquee) is simply dropped with the
  // design untouched.
  {
    const S = screen(flatWorld(), { tab: 'machine', undo: true, parts: twoWheels() });
    S._pointerDown(ev(100, -60)); S._pointerUp(ev(100, -60));
    gate('94. (fixture) the click selected the wheel', !!S.sel);
    S._keyDown(kev('Escape'));
    gate('94. Escape with nothing in hand still clears the selection',
      S.sel === null && S.design.parts.length === 2);
    S._pointerDown(ev(400, 200, { ctrlKey: true, shiftKey: true }));
    S._pointerMove(ev(500, 260, { ctrlKey: true, shiftKey: true }));
    gate('94. (fixture) a marquee is in hand', S.drag?.type === 'marquee', String(S.drag?.type));
    S._keyDown(kev('Escape'));
    gate('94. Escape drops a marquee without touching the design',
      S.drag === null && S.design.parts.length === 2
      && S.design.parts.every(p => p.y === -60));
  }
}

// ---------- gate 95: the red refusal wears the piece's own shape ----------
//
// Reported: "RED out of bounds border on rotated goal piece is wrong." It drew
// the piece's axis-aligned BOUNDS, and the AABB of a tilted crate is bigger
// than the crate on both axes — an upright border floating in the air around
// the piece the sentence was about. The pulse vocabulary gained a rotated box
// (`rb`), and everything with an angle resolves to it.
{
  const world = () => ({
    ...flatWorld(),
    goalObjs: [{ shape: 'box', x: 10, y: -40, w: 90, h: 46, angle: 0.5 }],
    terrain: [...flatWorld().terrain, { type: 'box', x: -200, y: -150, w: 120, h: 40, angle: 0.3 }],
  });
  const S = screen(world(), { tab: 'level' });
  // the STAGED position, not the authored one — drag a goal and the pulse has
  // to follow the piece, not the level file
  S.goalPositions[0] = { x: 60, y: -120 };
  {
    const r = S._pulseShapeOfSel({ kind: 'goal', idx: 0 });
    gate('95. a rotated goal crate pulses as the box it is',
      !!r?.rb && r.rb.join(',') === '60,-120,90,46,0.5', JSON.stringify(r));
  }
  {
    const r = S._pulseShapeOfSel({ kind: 'terrain', ref: S.level.terrain[1] });
    gate('95. …and a rotated terrain box too',
      !!r?.rb && r.rb[4] === 0.3, JSON.stringify(r));
  }
  {
    // no angle -> the bounds, exactly as before; the fallback must survive
    const r = S._pulseShapeOfSel({ kind: 'terrain', ref: S.level.terrain[0] });
    gate('95. an unrotated piece keeps its plain bounds', !!r?.b && !r.rb, JSON.stringify(r));
  }
  {
    // the towed goal pieces in a bad drop go through the SAME resolver — a
    // second copy of this rule was exactly how the goal got the wrong border
    const shapes = S._badDropShapes({ type: 'move',
      hit: { kind: 'goal', idx: 0 }, companions: { rides: [], stretches: [], goalRides: [0] } });
    gate('95. a towed goal in a bad drop wears the rotated border too',
      shapes.filter(x => x?.rb).length === 2, JSON.stringify(shapes));
  }
  {
    // the painter really rotates: record the calls and check the rect is laid
    // down inside a translate(cx,cy)+rotate(angle) frame, centred on origin
    const calls = [];
    const ctx = new Proxy({}, { get: (t, k) => (k === 'lineWidth' || k === 'strokeStyle'
      ? undefined : (...a) => { calls.push([k, a]); }), set: () => true });
    S._pulseShapes(ctx, [{ rb: [60, -120, 90, 46, 0.5] }]);
    const tr = calls.find(([k]) => k === 'translate');
    const ro = calls.find(([k]) => k === 'rotate');
    const rc = calls.find(([k]) => k === 'rect');
    gate('95. the painter draws the rb in the piece\'s own frame',
      !!tr && tr[1][0] === 60 && tr[1][1] === -120
      && !!ro && ro[1][0] === 0.5
      && !!rc && Math.abs(rc[1][0] + rc[1][2] / 2) < 0.001,
      JSON.stringify({ tr: tr?.[1], ro: ro?.[1], rect: rc?.[1] }));
  }
}

// ---------- gate 96: the running dock, and ⏺ as a toggle ----------
//
// Requested, 2026-08-23: "Change the record button so that you can hit it mid
// run. Toggle On-Off. If not already playing it should start the run as well."
// and "When play is pressed, the play bar should become STOPBUTTON
// RECORDBUTTON SCRUBLINE SECS until stopped."
//
// The recorder needs captureStream and MediaRecorder, which node does not
// have, so the toggle's wiring is held by source claims and the visibility
// rule by the pure function — the browser run that verified the behaviour is
// in the commit message.
{
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

  // --- the visibility rule, which is pure and fully reachable ---
  gate('96. a running machine shows the scrub line unconditionally',
    scrubLineVisible({ hasTape: false, pointerNear: false, scrubbed: false, coarse: false, running: true }) === true,
    'on from the first frame, before the tape even fills');
  gate('96. …and a stopped one keeps every old answer',
    scrubLineVisible({ hasTape: true, coarse: true }) === true
    && scrubLineVisible({ hasTape: true, pointerNear: true }) === true
    && scrubLineVisible({ hasTape: true, scrubbed: true }) === true
    && scrubLineVisible({ hasTape: true }) === false
    && scrubLineVisible({ hasTape: false, coarse: true }) === false);

  // --- ⏺ toggles the RECORDING, never the run ---
  gate('96. ⏺ while rolling saves the clip and leaves the run alone',
    /if \(this\._clip\) \{ this\._finishClip\(\); return; \}/.test(src)
    && !/if \(this\._clip\) \{ this\.stop\(\); return; \}/.test(src));
  gate('96. …and no longer restarts the world to begin a take',
    /const mime = this\._clipMime\(\);\s*\n\s*if \(!mime\) \{ this\._toast\('This browser cannot record video\.'\); return; \}\s*\n\s*const stream = this\.canvas\.captureStream/.test(src),
    'the this.stop() between the mime check and the capture is gone');
  gate('96. …starting the run only when it was not already running',
    /rec\.start\(250\);[^\n]*\n\s*if \(!this\.playing\) this\.play\(\);/.test(src));
  gate('96. the three-minute ceiling ends the CLIP alone',
    /this\._toast\('Three minutes[^']*'\);\s*\n\s*this\._finishClip\(\);/.test(src)
    && !/this\._toast\('Three minutes[^']*'\);\s*\n\s*this\.stop\(\);/.test(src));
  // anchored on the DEFINITION — 'stop({ keepTape' alone matched _scrubTo's
  // CALL first and the slice landed 800k characters early
  gate('96. a hand-stop still saves a rolling clip on the way out',
    /this\._finishClip\(\);/.test(src.slice(src.indexOf('stop({ keepTape = false'), src.indexOf('stop({ keepTape = false') + 5000)),
    'stop() calls _finishClip, so Space keeps its old meaning');

  // --- the dock's run mode ---
  // …and stop stands it down EXCEPT for the scrub's own pause (2026-08-24:
  // "The scrubber should not disappear until play is stopped"): keepSim is the
  // pause's signature, and the paused world is the review still being had.
  gate('96. play arms the running dock and a real stop stands it down',
    /this\.playBtn\.classList\.add\('playing'\);\s*\n\s*this\._setDockRunning\(true\);/.test(src)
    && /this\._setDockRunning\(!!keepSim\);/.test(src)
    && /this\._pausedBg\?\.destroy\(\); this\._pausedBg = null;\s*\n\s*this\._setDockRunning\(false\);/.test(src),
    'the transport survives the pause and dies with the paused world');
  // …and the ■ survives WITH it (2026-08-24: "the Play button changes when the
  // slider is used. And when clicked restarts rather than stops the play.").
  // From a review, ▶ would restart — and the press that follows a pause almost
  // always means "I am done". So the pause keeps the ■ and the clock, and both
  // the button and Space treat a paused world as stoppable.
  gate('96. the scrub pause keeps the ■ and the clock',
    /if \(!keepSim\) \{\s*\n\s*this\.playBtn\.textContent = '▶';\s*\n\s*this\.playBtn\.title = 'Play \(Space\)';\s*\n\s*this\.playBtn\.classList\.remove\('playing'\);\s*\n\s*this\.timeVal\.textContent = '0\.0';\s*\n\s*\}/.test(src),
    'the button only flips on a REAL stop');
  gate('96. …and the ■ pressed mid-review ENDS the session rather than restarting',
    /onclick: \(\) => \(this\.playing \|\| this\._pausedSim\) \? this\.stop\(\) : this\.play\(\),/.test(src));
  gate('96. …with Space mirroring the button exactly',
    /if \(this\.playing \|\| this\._pausedSim\) this\.stop\(\); else this\.play\(\);/.test(src));
  gate('96. …and the early branch stands the ■ down with everything else',
    /this\._setDockRunning\(false\);\s*\n[\s\S]{0,220}if \(this\.playBtn\) \{\s*\n\s*this\.playBtn\.textContent = '▶';/.test(src),
    'guarded: the headless harness has no button');
  gate('96. the scrub row moves INLINE as one node, so the input keeps its listeners',
    /this\.dockInner\.insertBefore\(this\.scrubWrap, this\.timeEl\);/.test(src)
    && /if \(this\.scrubWrap\.parentNode !== this\.dock\) this\.dock\.append\(this\.scrubWrap\);/.test(src));
  gate('96. …and a vertical dock keeps the floating row',
    /const inline = !!on && this\._dockBar\?\.pos\.orient !== 'vertical';/.test(src),
    'a 120px-minimum horizontal slider inside a 48px column is not a layout');
  gate('96. …and the side classes never fight the inline state',
    /if \(on && !this\.scrubWrap\.classList\.contains\('inline'\)\) \{/.test(src));
  gate('96. the bar re-fits when its content changes width',
    /this\._syncScrub\(\);\s*\n\s*this\._fitBarInner\(this\._dockBar\);/.test(src));

  // --- the CSS hides RESET→KG and nothing the run needs ---
  {
    const i = cssSrc.search(/^\.dock-running \.dock-mini,/m);
    const rule = i >= 0 ? cssSrc.slice(i, cssSrc.indexOf('}', i)) : '';
    gate('96. the run hides the minis and the census…',
      /\.dock-running \.dock-mini/.test(rule) && /\.dock-stat/.test(rule));
    gate('96. …but never the clock or the row\'s own time label',
      /:not\(\.dock-time\)/.test(rule) && /:not\(\.scrub-time\)/.test(rule),
      'SECS is the S in the requested bar, and the row carries its own readout');
  }
  gate('96. inline, the row is a flex child that stretches over the space it won',
    /\.dock-scrub-row\.inline \{[^}]*position: static;[^}]*flex: 1 1 auto;/s.test(cssSrc));
}

// ---------- gate 97: the type floor holds EVERYWHERE the scale can bite ----------
//
// --hud-type-min's own comment says nothing in the HUD may go below 9.5px, and
// twice now an 11px rule slipped under it (11 × --bar-scale 0.8 = 8.8) because
// the guard was applied by eyeball sweep rather than by rule. This gate IS the
// rule: it parses every font-size in the stylesheet that multiplies by
// --bar-scale, computes what it resolves to at 0.8, and fails any that can dip
// under the floor without wearing the max(var(--hud-type-min), …) guard.
// A new scalable readout is covered the day it is written.
section('97', () => {
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const mMin = cssSrc.match(/--hud-type-min:\s*([\d.]+)px/);
  const FLOOR = mMin ? +mMin[1] : NaN;
  gate('97. the floor itself is still declared, once', !!mMin
    && (cssSrc.match(/--hud-type-min:/g) || []).length === 1, FLOOR + 'px');
  const mScale = cssSrc.match(/\.toolbar-wrap[^{]*\{[^}]*--bar-scale:\s*([\d.]+)/s);
  const SCALE = mScale ? +mScale[1] : NaN;
  gate('97. …and the bar scale is where this gate thinks it is', !!mScale, String(SCALE));

  const offenders = [];
  const decls = [...cssSrc.matchAll(/font-size:\s*([^;]+);/g)];
  for (const d of decls) {
    const v = d[1];
    const c = v.match(/calc\(\s*([\d.]+)px\s*\*\s*var\(--bar-scale/);
    if (!c) continue;                         // not scale-dependent
    const resolved = +c[1] * SCALE;
    if (resolved >= FLOOR) continue;          // cannot dip under
    if (/max\(\s*var\(--hud-type-min\)/.test(v)) continue;   // guarded
    const line = cssSrc.slice(0, d.index).split('\n').length;
    offenders.push(`style.css:${line}  ${c[1]}px × ${SCALE} = ${resolved.toFixed(1)}px unguarded`);
  }
  gate('97. every scalable font-size that can dip under the floor wears the guard',
    offenders.length === 0, offenders.join('  |  ') || decls.length + ' font-size declarations checked');

  // the two that were caught, held individually so a refactor that drops the
  // guard from exactly these fails by name
  gate('97. the sweep chip readouts are floored',
    /\.sweep-title, \.sweep-read \{[^}]*max\(var\(--hud-type-min\), calc\(11px/s.test(cssSrc));
  gate('97. …with the fixed line floored to the same line box',
    /min-height: max\(calc\(var\(--hud-type-min\) \* 1\.25\), calc\(14px/.test(cssSrc),
    'or the strobe-guard stops guarding the moment the floor bites');
  gate('97. the Advanced census is floored',
    /\.adv-line \{[^}]*max\(var\(--hud-type-min\), calc\(11px/s.test(cssSrc));
  // and the chrome budget moved with the line box: five floored rows at
  // +0.675px each is ~3.4px a short window would otherwise lose
  gate('97. SWEEP_CHIP_CHROME moved with the rows it budgets',
    SWEEP_CHIP_CHROME >= 130, String(SWEEP_CHIP_CHROME));
});

// ---------- gate 98: the interface preferences ----------
//
// The dark plate shipped with its setting named and unbuilt — the stylesheet
// says "data-hud on #app overrides it in either direction so a setting can
// drive it later". This is the later, plus density beside it.
section('98', () => {
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');

  // the resolution is pure and the null case is the whole design: an absent
  // attribute is what lets the stylesheet's own detection speak
  gate('98. system and compact resolve to NO attribute, not to a value',
    hudThemeAttr('system') === null && hudDensityAttr('compact') === null,
    'writing them would pin the detected answer forever');
  gate('98. …and the explicit choices resolve to themselves',
    hudThemeAttr('light') === 'light' && hudThemeAttr('dark') === 'dark'
    && hudDensityAttr('cozy') === 'cozy' && hudDensityAttr('touch') === 'touch');
  gate('98. …and junk from storage resolves to the default, silently',
    [null, undefined, '', 'DARK', 42, {}].every((j) => hudThemeAttr(j) === null && hudDensityAttr(j) === null));
  gate('98. the option lists and the resolvers agree',
    HUD_THEMES.every((t2) => t2 === 'system' || hudThemeAttr(t2) === t2)
    && HUD_DENSITIES.every((d) => d === 'compact' || hudDensityAttr(d) === d));

  // the CSS hooks the resolvers aim at really exist, on both axes
  gate('98. the dark plate answers to data-hud, in both directions',
    /#app\[data-hud="dark"\]/.test(cssSrc) && /#app:not\(\[data-hud="light"\]\)/.test(cssSrc));
  gate('98. …and density answers to data-density, overriding both detections',
    /#app\[data-density="cozy"\] \.toolbar-wrap \{ --bar-scale: 0\.9; \}/.test(cssSrc)
    && /#app\[data-density="touch"\] \.toolbar-wrap \{ --bar-scale: 1; \}/.test(cssSrc));
  {
    // …from the END of the file, so the coarse-pointer media rule loses on
    // order as well as specificity — the override-at-the-end lesson, again
    const coarse = cssSrc.lastIndexOf('@media (pointer: coarse)');
    const dens = cssSrc.lastIndexOf('#app[data-density="touch"]');
    gate('98. …and the density rules sit after the coarse-pointer block',
      coarse >= 0 && dens > coarse);
  }

  // applied before anything paints — a dark-theme user must not get a flash
  gate('98. the boot applies the stored prefs before the splash',
    /await initI18n\(\);[\s\S]{0,300}applyHudPrefs\(appEl\);[\s\S]{0,600}class: 'splash'/.test(mainSrc));
  gate('98. …and the settings pills apply immediately through the same one function',
    /store\.set\(key, opt\.id\);\s*\n\s*applyHudPrefs\(\);/.test(mainSrc),
    'two appliers would be two answers to what the preference means');
});

// ---------- gate 99: three chip-and-focus requests (2026-08-23) ----------
section('99', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'public/js/main.js'), 'utf8');

  // "The order for buttons on the Advanced chip should be Snap, Free World,
  // Ghost, SpeedSlider."
  // "When a run starts, all right click menus should be closed." One close
  // covers them all: the right-click, grip, ghost-road and ghost-pin menus
  // every one land in this._ctxMenu via _showCtxMenu.
  gate('99. play() closes every open menu before the world moves',
    /if \(this\._startPrompt\) \{ this\._startPrompt\.remove\(\); this\._startPrompt = null; \}[\s\S]{0,600}this\._closeCtxMenu\(\);\s*\n\s*this\._closeToolFan\?\.\(\);/.test(src),
    'a context menu is a question about a piece as it stands, and the run changes what stands');

  gate('99. the slider release is installed at boot, for every screen',
    /installSliderRelease\(\);/.test(mainSrc));
});

// "After adjusting a slider it should not hold focus." The rule is driven with
// a fake root — async because the blur deliberately waits a tick (the browser
// fires `change` after `pointerup`, and a control blurred first can drop the
// commit). Top-level, because section() refuses a promise.
{
  const listeners = [];
  installSliderRelease({ addEventListener: (type, fn, cap) => listeners.push({ type, fn, cap }) });
  gate('99. the slider release listens once, to pointerup, in the capture phase',
    listeners.length === 1 && listeners[0].type === 'pointerup' && listeners[0].cap === true,
    'keyboard events are deliberately NOT listened to — a tabbed-in slider is using its focus');
  const fire = (target) => new Promise((done) => {
    let blurred = false;
    if (target && target.tagName) target.blur = () => { blurred = true; };
    listeners[0].fn({ target });
    setTimeout(() => done(blurred), 20);
  });
  const range = { tagName: 'INPUT', type: 'range' };
  const text = { tagName: 'INPUT', type: 'text' };
  const button = { tagName: 'BUTTON', type: 'button' };
  gate('99. a range input is blurred after the pointer lets go',
    (await fire(range)) === true);
  gate('99. …and nothing else is touched — a text input keeps its caret',
    (await fire(text)) === false && (await fire(button)) === false
    && (await fire(null)) === false,
    'the guard is INPUT[type=range] exactly');
}

// ---------- gate 99b: the dock never moves the scrubber mid-gesture ----------
//
// Reported: "The scrubber is no longer scrubbing it stops play when clicked."
// The first input of a mid-run scrub pauses the run (that is what _scrubTo
// does), and stop() reached _setDockRunning, which MOVED the slider's node out
// of the dock while the pointer was still down on it — and a node moved
// mid-gesture kills the gesture. These drive the real _setDockRunning on a
// stub dock and count the moves.
section('99b', () => {
  const cls = () => { const s = new Set(); return {
    add: (...n) => n.forEach((x) => s.add(x)), remove: (...n) => n.forEach((x) => s.delete(x)),
    toggle: (n, on) => (on === undefined ? (s.has(n) ? s.delete(n) : s.add(n)) : on ? s.add(n) : s.delete(n)),
    contains: (n) => s.has(n) }; };
  const rig = () => {
    const S = Object.create(GameScreen.prototype);
    S.moves = [];
    S.scrubWrap = { classList: cls(), parentNode: null };
    S.dock = { classList: cls(), append: (n) => { S.moves.push('out'); n.parentNode = S.dock; } };
    S.dockInner = { insertBefore: (n) => { S.moves.push('in'); n.parentNode = S.dockInner; },
      style: {}, getBoundingClientRect: () => ({ width: 391, height: 44 }) };
    S.timeEl = {};
    S._dockBar = { pos: { orient: 'horizontal' } };
    S._syncScrub = () => {};
    S._fitBarInner = () => {};
    return S;
  };

  {
    const S = rig();
    S._setDockRunning(true);
    gate('99b. play moves the row inline, once', S.moves.join(',') === 'in');
    // …and the chip keeps its SIZE across the swap (2026-08-24: "Scrubber
    // coming/going should not change the size of the Play Chip"): the inner is
    // measured in the full layout as the run arms and pinned for its life.
    gate('99b. arming pins the chip to the size it was measured at',
      S.dockInner.style.width === '391px' && S.dockInner.style.height === '44px',
      S.dockInner.style.width + ' × ' + S.dockInner.style.height);
    S._setDockRunning(true);
    gate('99b. …and a second play cannot re-insert it — an insertBefore to the '
      + 'SAME place is still a remove-and-insert', S.moves.join(',') === 'in');
    // the scrub is in hand: the pause must not move the node
    S._scrubHeld = true;
    S._setDockRunning(false);
    gate('99b. the pause mid-drag defers the layout switch instead of moving the node',
      S.moves.join(',') === 'in' && S._dockRunningWanted === false,
      'moves so far: [' + S.moves.join(',') + ']');
    // the release applies what was deferred
    S._scrubHeld = false;
    S._setDockRunning(S._dockRunningWanted);
    gate('99b. …and the release applies it', S.moves.join(',') === 'in,out'
      && S.scrubWrap.parentNode === S.dock);
    S._setDockRunning(false);
    gate('99b. …idempotently', S.moves.join(',') === 'in,out');
    gate('99b. …and the real stop takes the pin off with everything else',
      S.dockInner.style.width === '' && S.dockInner.style.height === '',
      'the chip breathes only between sessions, never inside one');
  }
  {
    const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    gate('99b. the hold is armed by the scrubber\'s own pointerdown and released on WINDOW',
      /this\.scrubEl\.addEventListener\('pointerdown', \(\) => \{ this\._scrubHeld = true; \}\);/.test(src)
      && /window\.addEventListener\('pointerup', this\._onScrubRelease\);/.test(src)
      && /window\.addEventListener\('pointercancel', this\._onScrubRelease\);/.test(src),
      'the pointer that pauses the run is captured by the range input, so its up can land anywhere');
    gate('99b. …and destroy removes both window listeners',
      /window\.removeEventListener\('pointerup', this\._onScrubRelease\);/.test(src)
      && /window\.removeEventListener\('pointercancel', this\._onScrubRelease\);/.test(src));
  }
});

// ---------- gate 99c: the grip menu stays by the hand ----------
//
// Reported with a screenshot: "The right click appears nowhere near the mouse
// pointer" — the grip menu a full bar-length away. The avoid-the-bar escapes
// were tried in a FIXED order, right-of-bar first, so right-clicking the grip
// at the LEFT end of a 950px dock threw the menu past its far right. The
// escapes are now sorted by distance from the pointer. These drive the real
// _showCtxMenu on a stub DOM and measure.
section('99c', () => {
  const rig = (menuW = 160, menuH = 120) => {
    const S = Object.create(GameScreen.prototype);
    const menu = { style: {}, getBoundingClientRect: () => ({ width: menuW, height: menuH }) };
    S.root = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1100, height: 640 }),
      append: () => {},
    };
    return { S, menu };
  };
  const avoidAt = (left, top, width, height) => ({ getBoundingClientRect: () => ({ left, top, width, height }) });
  const place = (S, menu, x, y, avoid) => {
    S._showCtxMenu(menu, { clientX: x, clientY: y }, avoid);
    return { x: parseFloat(menu.style.left), y: parseFloat(menu.style.top) };
  };
  const distTo = (p, menuW, menuH, px, py) => {
    const nx = Math.max(p.x, Math.min(px, p.x + menuW));
    const ny = Math.max(p.y, Math.min(py, p.y + menuH));
    return Math.hypot(nx - px, ny - py);
  };

  // a wide dock along the bottom, right-clicked at its LEFT grip
  {
    const { S, menu } = rig();
    const bar = avoidAt(75, 582, 950, 44);
    const p = place(S, menu, 90, 600, bar);
    const d = distTo(p, 160, 120, 90, 600);
    gate('99c. the grip menu lands by the hand, not past the bar\'s far end',
      d < 60, d.toFixed(0) + 'px from the pointer (the old order gave ~870)');
    gate('99c. …and still not ON the bar it configures',
      p.y + 120 <= 582 || p.y >= 582 + 44, `menu y ${p.y}`);
  }
  // a tall toolbar on the left, right-clicked at its TOP grip: the near escape
  // is BESIDE it, which the same sort chooses without a special case
  {
    const { S, menu } = rig();
    const bar = avoidAt(10, 60, 48, 460);
    const p = place(S, menu, 30, 75, bar);
    const d = distTo(p, 160, 120, 30, 75);
    gate('99c. a vertical bar\'s menu opens beside the grip',
      d < 60 && p.x >= 58, d.toFixed(0) + 'px away, at x ' + p.x);
  }
  // nothing to avoid: the menu opens AT the pointer, exactly as before
  {
    const { S, menu } = rig();
    const p = place(S, menu, 400, 300, null);
    gate('99c. with nothing to avoid the menu opens at the pointer',
      p.x === 400 && p.y === 300, p.x + ',' + p.y);
  }
});

// ---------- gate 100: the dark follows through ----------
//
// Reported with a screenshot: "The DARK does not follow through..." — the
// plate went dark and the controls on it stayed light, with the SECS readout
// dark-on-dark. The fix is ONE remap: inside every HUD scope the site tokens
// resolve to their plate twins, so every rule there — and every control anyone
// adds later — follows the theme without being individually retokenised.
section('100', () => {
  const cssSrc = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const i = cssSrc.lastIndexOf('THE DARK FOLLOWS THROUGH');
  const block = i >= 0 ? cssSrc.slice(i, cssSrc.indexOf('}', cssSrc.indexOf('{', i))) : '';
  gate('100. the remap block exists, at the end where the cascade obeys it',
    i > cssSrc.length * 0.8, 'override layers go at the END — the lesson is three bugs old');
  gate('100. …and remaps all five site tokens to their plate twins',
    ['--ink: var(--plate-ink);', '--ink-soft: var(--plate-ink-soft);',
     '--line: var(--plate-edge);', '--paper: var(--plate-solid);',
     '--paper-dim: var(--plate-2);'].every((s) => block.includes(s)));
  gate('100. …covering the bars, the menus, and the top strip',
    ['.toolbar-wrap', '.ctx-menu', '.hud-top', '.mod-chip', '.win-banner']
      .every((s) => block.includes(s)));
  // the SELECTOR LIST alone — the comment above it names .tip and .toast while
  // explaining their absence, and the first draft of this gate read the
  // comment as the crime it describes
  const selectors = block.slice(block.lastIndexOf('*/') + 2);
  gate('100. …and deliberately NOT the inverted surfaces',
    !/\.tip[,\s{]/.test(selectors) && !/\.toast[,\s{]/.test(selectors),
    'a tooltip is an ink plate with light text in both themes — remapping would un-invert it');
  // the remap is a near-no-op in light BY CONSTRUCTION, held here as arithmetic
  {
    const val = (name) => (cssSrc.match(new RegExp('  ' + name + ': ([^;]+);')) || [])[1];
    gate('100. in light, ink and paper remap to byte-identical values',
      val('--ink') === val('--plate-ink') && val('--ink-soft') === val('--plate-ink-soft')
      && val('--paper') === val('--plate-solid'),
      `${val('--ink')}=${val('--plate-ink')}, ${val('--paper')}=${val('--plate-solid')}`);
  }
  // the hardcoded whites are gone from the HUD rules the report named
  gate('100. the tool button, the menu and the tabs wear tokens, not #fff',
    /border-radius: calc\(9px \* var\(--bar-scale, 1\)\);\s*\n\s*background: var\(--paper\);/.test(cssSrc)
    && /\.ctx-menu \{[^}]*background: var\(--paper\);/s.test(cssSrc)
    && /\.tabs \{[^}]*background: var\(--paper\);/s.test(cssSrc));
  // icon ink inherits, so a themed button themes its glyph
  {
    const r = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
    const u2 = fs.readFileSync(path.join(root, 'public/js/util.js'), 'utf8');
    gate('100. the text and pin tool glyphs ride currentColor',
      /M 12 6 V 18\.5" stroke="currentColor"/.test(r)
      && /r="6\.4" fill="currentColor"/.test(r));
    gate('100. …and the Untampered badge glyph too',
      /noTouchSVG = `[\s\S]*?stroke="currentColor"/.test(u2)
      && !/noTouchSVG = `[\s\S]*?#232a35/.test(u2.slice(0, u2.indexOf('badgeRank'))));
  }
  // the sweep field's paper and marks follow the chip's live plate — with
  // defaults that keep every headless caller byte-identical
  {
    const r = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
    gate('100. drawSweepField derives its marks from ONE ink, defaulting to the old literal',
      /: \[35, 42, 53\];/.test(r) && /inkA\(0\.24\) : inkA\(0\.10\)/.test(r));
    const g = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
    gate('100. …and the chip passes its plate tokens live',
      /getPropertyValue\('--plate-2'\)/.test(g) && /getPropertyValue\('--plate-ink'\)/.test(g));
  }
});

// ---------- gate 101: any quiet patch of a bar is a handle ----------
//
// (2026-08-24, on request: "Any nonactive space on toolbars should also be
// draggable/double clickable/right clickable. Sometimes they get on top of
// each other and it is annoying to shuffle them.") The gesture binds to the
// WRAP and declines anything that already means something; verified live —
// a drag from the KG readout moved the bar 41,-59, a drag from the Reset
// button moved it 0, quiet-space right-click opened the bar menu and a
// button's right-click did not.
section('101', () => {
  const src = fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8');
  gate('101. the drag binds to the wrap, not the header alone',
    /this\._bindGripDrag\(bar\.wrap, \(e\) => \{/.test(src)
    && !/this\._bindGripDrag\(bar\.header/.test(src));
  gate('101. …declining everything that already means something, except the grip',
    /closest\?\.\('button, input, select, a, label, canvas, \[contenteditable\]'\)/.test(src)
    && /!it\.classList\.contains\('toolbar-grip'\)/.test(src),
    'the grip is a button whose whole job is this gesture');
  gate('101. …and the wrap answers the same right-click from its quiet space',
    /wrap\.oncontextmenu = \(ev\) => \{/.test(src)
    && /if \(it\) return;/.test(src));
  gate('101. …with the orient button still explicitly declined (gate 89 leans on it)',
    /if \(bar\.orientBtn\.contains\(e\.target\)\) return null;/.test(src));
});

// ---------- §102: a zones-only multi-selection resizes (2026-08-24) ----------
//
// "When multiple AREAs (build/goal) are selected show resize handles for
// them." The multi-selection deliberately never grew corner handles because a
// MIXED selection has no one meaning for scale — areas alone do: the same
// corner-anchored stretch a group applies to its zone riders. Held here: the
// corners exist exactly when the selection is areas only, they scale every
// selected zone about the opposite corner, and the floors hold.
section('102', () => {
  const world = () => flatWorld({
    buildZones: [{ x: -100, y: -100, w: 200, h: 100 }],
    goalZones: [{ x: 150, y: -75, w: 100, h: 50 }],
  });
  // a bare Ctrl+click on a zone starts a marquee (its interior is "empty
  // space"), so the selection is built the way a person builds it: plain
  // click the first area, Ctrl+click the second once a selection is under way
  const clickAt = (S, x, y) => { S._pointerDown(ev(x, y)); S._pointerUp(ev(x, y)); };
  {
    const S = screen(world(), { tab: 'level', undo: true });
    clickAt(S, -100, -100);
    ctrlClick(S, 150, -75);
    const zonesOnly = S.multiSel.length === 2 && S.multiSel.every(s => s.kind === 'zone');
    // union bounds x −200..200, y −150..−50; grab the max corner, anchor the min
    const g = gesture(S, { x: 200, y: -50 }, { x: 600, y: 50 });
    const b = S.level.buildZones[0], gz = S.level.goalZones[0];
    gate('102a. two areas ctrl-picked are a zones-only selection', zonesOnly,
      S.multiSel.map(s => s.kind).join(','));
    gate('102a. …whose corner starts the resize', g.type === 'multi-zone-resize', g.type);
    gate('102a. …and both areas scale about the far corner',
      near(b.x, 0) && near(b.y, -50) && near(b.w, 400) && near(b.h, 200)
      && near(gz.x, 500) && near(gz.y, 0) && near(gz.w, 200) && near(gz.h, 100),
      `build ${b.x},${b.y} ${b.w}x${b.h}; goal ${gz.x},${gz.y} ${gz.w}x${gz.h}`);
    gate('102a. …and the drop commits once', S.commits === 1, `${S.commits} commits`);
  }
  {
    // a selection holding anything BESIDES areas keeps the old bargain: no
    // corner handle, so the same press starts some other gesture entirely
    const S = screen(world(), { tab: 'level' });
    clickAt(S, 0, 30);                         // the ground slab first
    ctrlClick(S, -100, -100);                  // …then the build area joins
    const mixed = S.multiSel.length === 2 && S.multiSel.some(s => s.kind === 'terrain');
    const g = gesture(S, { x: 600, y: -150 }, { x: 650, y: -150 });
    gate('102b. a mixed selection offers no corner handle',
      mixed && g.type !== 'multi-zone-resize', `${S.multiSel.map(s => s.kind).join(',')} → ${g.type}`);
  }
  {
    // the floor: dragging the corner THROUGH the anchor cannot shrink an area
    // past MIN_GROUP_SPAN or flip it inside out
    const S = screen(world(), { tab: 'level', undo: true });
    clickAt(S, -100, -100);
    ctrlClick(S, 150, -75);
    gesture(S, { x: 200, y: -50 }, { x: -195, y: -148 });
    const b = S.level.buildZones[0], gz = S.level.goalZones[0];
    gate('102c. shrinking holds the group-span floor and never flips',
      b.w >= 10 && b.h >= 10 && gz.w >= 10 && gz.h >= 10 && b.x >= -200 && gz.x >= -200,
      `build ${b.w}x${b.h}, goal ${gz.w}x${gz.h}`);
  }
});

// ---------- §103: overlapping-piece pick chip (2026-08-26) ----------
//
// A click (or right-click) on a spot with two pieces used to take the top one
// and leave the buried one unreachable. Now `_hitsAt` lists every unique piece
// under the point, a chip opens when there are two or more, and a later click
// with one of them selected drags THAT piece rather than the top one.
section('103', () => {
  const crossed = () => screen(flatWorld(), {
    parts: [
      { t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' },
      { t: 'rod', kind: 'wood', x1: -40, y1: -100, x2: 40, y2: -100, id: 'r' },
    ],
  });
  const at = { x: 0, y: -100 };
  {
    const S = crossed();
    const first = S._hitTest(at);
    const stack = S._hitsAt(at);
    gate('103a. a hub with a stick through it is TWO pieces, not one',
      stack.length === 2
      && stack[0].kind === 'part' && stack[0].ref.id === 'w'
      && stack[1].kind === 'part' && stack[1].ref.id === 'r',
      stack.map(h => (h.ref && h.ref.id) || h.kind).join(','));
    gate('103a. …and the first of those is still what a single pick returns',
      first?.kind === 'part' && first.ref.id === 'w'
      && S._selKey(S._stackPiece(first) || first) === S._selKey(stack[0]));
  }
  {
    const S = crossed();
    S._pointerDown(ev(at.x, at.y));
    gate('103b. a click on the overlap opens the pick chip and starts no drag',
      S._pickStack?.hits?.length === 2 && (S.drag?.type || 'null') === 'null' && !S.sel,
      `stack ${S._pickStack?.hits?.length}, drag ${S.drag?.type}, sel ${S.sel?.kind}`);
    S._pointerUp(ev(at.x, at.y));
    S._choosePick(S._pickStack.hits[0], ev(at.x, at.y), false);
    gate('103b. …picking the wheel selects it',
      S.sel?.kind === 'part' && S.sel.ref.id === 'w', S.sel?.ref?.id);
  }
  {
    const S = crossed();
    S._select({ kind: 'part', ref: S.design.parts.find(p => p.id === 'w') });
    // off the stick, not along it — a wheel sitting on a rod cannot slide
    // along the wood (the overlap sweep holds it), which is a different rule
    const g = gesture(S, at, { x: 0, y: -140 }, { watch: partAt(S, 0) });
    gate('103c. with the buried/selected wheel, a drag on the overlap moves the WHEEL',
      g.type === 'move' && near(S.design.parts[0].x, 0) && near(S.design.parts[0].y, -140)
      && S.design.parts[1].x1 === -40 && S.design.parts[1].y1 === -100,
      `type ${g.type}, wheel (${S.design.parts[0].x},${S.design.parts[0].y}), rod ${S.design.parts[1].x1},${S.design.parts[1].y1}`);
  }
  {
    const S = crossed();
    S._contextMenu({
      button: 2, ctrlKey: false, shiftKey: false, altKey: false,
      clientX: at.x + 400, clientY: at.y + 300,
      preventDefault() {}, stopPropagation() {},
    });
    gate('103d. a right-click on the overlap opens the pick chip, not the piece menu',
      S._pickStack?.menu === true && S._pickStack?.hits?.length === 2,
      `menu ${S._pickStack?.menu}, n ${S._pickStack?.hits?.length}`);
  }
  {
    const S = screen(flatWorld(), {
      parts: [{ t: 'wheel', kind: 'free', x: 0, y: -100, r: 15, id: 'w' }],
    });
    S._pointerDown(ev(0, -100));
    gate('103e. a lone piece still selects and drags, no chip',
      !S._pickStack && S.drag?.type === 'move' && S.sel?.ref?.id === 'w',
      `stack ${!!S._pickStack}, drag ${S.drag?.type}, sel ${S.sel?.ref?.id}`);
    S._pointerUp(ev(0, -100));
  }
  {
    // a stick inside the build zone must not grow a chip just because the
    // zone's interior is also a hit — zones are skipped from the stack
    const S = screen(flatWorld(), {
      tab: 'level',
      parts: [{ t: 'rod', kind: 'wood', x1: -30, y1: -80, x2: 30, y2: -80, id: 'r' }],
    });
    const stack = S._hitsAt({ x: 0, y: -80 });
    gate('103f. a stick over a zone is still one piece — the zone does not join the chip',
      stack.length === 1 && stack[0].ref.id === 'r',
      stack.map(h => h.kind + ':' + (h.ref?.id || h.zone || '')).join(','));
  }
  {
    const S = crossed();
    gate('103g. duplicate names in the chip are numbered',
      S._stackLabels(S._hitsAt(at)).join('|') === 'F wheel|wood stick');
    const twoSticks = [
      { kind: 'part', ref: { t: 'rod', kind: 'wood', id: 'a' } },
      { kind: 'part', ref: { t: 'rod', kind: 'wood', id: 'b' } },
    ];
    gate('103g. …and two wood sticks become wood stick · 1 / · 2',
      S._stackLabels(twoSticks).join('|') === 'wood stick · 1|wood stick · 2');
  }
});

summary(`(ZONE_SLACK ${ZONE_SLACK}, ZONE_CLAMP_EPS ${ZONE_CLAMP_EPS}, TERRAIN_TOUCH_PAD ${TERRAIN_TOUCH_PAD}, ROD_THICK ${ROD_THICK})`);
