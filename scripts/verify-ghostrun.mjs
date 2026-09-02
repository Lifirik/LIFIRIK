// verify-ghostrun.mjs — GhostRun and the pin sweep (§ GhostRun).
// Run: node scripts/verify-ghostrun.mjs
//
// WHY ITS OWN SUITE. This feature has two halves that no existing suite can
// hold together. The rules — how good a moment is, what moves when a pin moves,
// where a sweep looks — are pure functions in util.js and would sit happily in
// `verify-editor`, except that the other half is a GameScreen winding real
// Simulations forward, and verify-editor is deliberately wasm-free ("nothing
// here touches the database, the server, or the wasm binary"). Splitting the
// feature across two suites would leave the seam between them — the seam where
// every bug in it will actually live — gated by nobody.
//
// THE THREE CLAIMS WORTH MAKING. Everything below is one of these:
//
// 1. **The ghost IS the run.** A ghost frame at t must be bit-identical to a
// plain rollout to t (§5.8 determinism). If it is not, the mode is showing
// a future that will not happen, which is the only way it can really fail.
// 2. **A pin move keeps the machine's joints.** Moving a pin is a rigid shift
// of a coordinate and everything bolted to it; every pair of ends that
// shared a jointKey before must share one after, or the optimiser has
// quietly rebuilt somebody's machine to improve a number.
// 3. **The sweep measures what it says it measured.** Every cell, the origin
// first, and no silent truncation — a search that reports a winner out of a
// box it only half covered reads as "I looked everywhere".
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

const { GameScreen } = await import(u('public/js/game.js'));
const { Simulation, initEngine, STEP } = await import(u('public/js/sim.js'));
const { Camera } = await import(u('public/js/camera.js'));
const { drawSweepField } = await import(u('public/js/render.js'));
const {
 goalZoneGap, goalRunGap, ghostAimGap, ghostBetter, zonesForCargo, pinMoveSet, pinMovedParts, pinMovedGoals, pinAnchors, goalPins,
 pinGrid, pinGridOrigin, pinStepLabel, PIN_GRID_SIDE, PIN_GRID_STEPS, WEIGHT_GRID_SIDE, weightGrid, SWEEP_GRID_MAJOR,
 GHOST_AIM_MIN, GHOST_AIM_MAX, GHOST_AIM_DEFAULT, GHOST_AIM_NOTCHES, ghostAimFromNotch, ghostAimToNotch,
 traceMarks, NUDGE_STEPS, GHOST_TRACE_MARKS, GHOST_TRACE_MIN_PX, GHOST_ALPHA, GHOST_CARGO_ALPHA, GHOST_TRACE_ALPHA,
 GHOST_TARGET_PICK, GHOST_TARGET_TOUCH, snapRadius, sweepChipSize, SWEEP_CHIP_MIN, SWEEP_CHIP_VW,
 SWEEP_CHIP_CHROME, SWEEP_ODDS_STEP, sweepOddsShown, sweepTrials, oddsAsGood,
 HAND_NUDGE_S, HAND_JUDGE_S, handTrialSeconds, handSearchSeconds, fmtSpan, fmtCount,
 jointKey, wheelPins, rodPins, CELL_WON, CELL_MEASURED, dragEdits, DRAG_NEVER_EDITS, CELL_INVALID,
 routeField, routeDistanceAt, routePath, simplifyPath, cargoClearance,
} = await import(u('public/js/util.js'));
const { ghostIconSVG, drawWheel, drawGoalPiece } = await import(u('public/js/render.js'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));

const { gate, section, summary } = gates();

const deep = (o) => JSON.parse(JSON.stringify(o));
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---------- the harness ----------
//
// The same trick `verify-editor` uses and for the same reason: GameScreen's
// constructor builds a canvas and a HUD, so it is never called. What is added
// here over that harness is the ghost's own fields and nothing else — every
// method under test is the real one.
function screen(level, parts = [], opts = {}) {
 const S = Object.create(GameScreen.prototype);
 const lv = deep(level);
 for (const k of ['terrain', 'props', 'buildZones', 'goalZones', 'goalObjs', 'fixedParts', 'texts', 'pins']) lv[k] = lv[k] || [];
 lv.groups = lv.groups || {};
 lv.backLevel = { terrain: [], props: [], fixedParts: [], texts: [], pins: [], groups: {} };
 Object.assign(S, {
 opts: {}, mode: 'play', level: lv,
 design: { parts: deep(parts) },
 goalPositions: lv.goalObjs.map((g) => ({ x: g.x, y: g.y })),
 goalMoved: lv.goalObjs.map(() => false),
 tab: 'machine', tool: 'pointer', playing: false, sel: null, multiSel: [], drag: null,
 camera: new Camera(), undoStack: [], redoStack: [], snapMode: 'rev',
 ghost: null, _ghostSweep: null, _ghostRoads: [], _ghostOnly: null, _ghostAssign: [], _ghostHide: false, toasts: [], commits: 0,
 ...opts,
 });
 S._toast = (m) => { S.toasts.push(m); };
 S._autosave = () => {};
 S._commit = () => { S.commits++; S._updateStats(); };
 S._updateStats = () => { S._ghostInvalidate(); };
 S._updateInfoChip = () => {};
 S._renderToolbar = () => {};
 S._updateAlignChip = () => {};
 S._closeCtxMenu = () => {};
 S._select = () => {};
 S._draw = () => {};
 S._syncAdvBar = () => {};
 S._renderWinBanner = () => {};
 // The sweep chip is DOM (`el`, a canvas, a bar) and there is none here. Its
 // CONTENT is gated instead, through `_sweepReadout`, which is pure.
 S._ensureGhostChip = () => { S.chipShown = true; };
 S._paintSweepChip = () => { S.chipPaints = (S.chipPaints || 0) + 1; };
 S._closeSweepChip = () => { S.chipShown = false; };
 S._syncGhostChip = () => {};
 return S;
}

// Wind a ghost all the way in, with a budget big enough that it never yields —
// the budget itself is gated separately.
const ghostToEnd = (S, cap = 4000) => {
 for (let i = 0; i < cap && S.ghost && (S.ghost.stale || S.ghost.sim); i++) S._ghostTick(1e9);
 return S.ghost;
};
const sweepToEnd = (S, cap = 100000) => {
 for (let i = 0; i < cap && S._ghostSweep && !S._ghostSweep.done; i++) S._pinSweepTick(1e9);
 return S._ghostSweep;
};

// A flat level with a ball to deliver, roomy enough to build in.
const flat = (over = {}) => ({
 terrain: [{ type: 'box', x: 0, y: 30, w: 3000, h: 60 }],
 buildZones: [{ x: 0, y: -120, w: 1200, h: 260 }],
 goalZones: [{ x: 900, y: -52, w: 160, h: 104 }],
 goalObjs: [{ shape: 'ball', x: -200, y: -15, r: 15 }],
 win: 'goalObj',
 ...over,
});

// ---------- 1. how good a moment is ----------
section('1', () => {
 const zones = [{ x: 100, y: 0, w: 40, h: 40 }];
 const ball = { shape: 'ball', r: 15 };
 gate('1. a piece dead centre in its zone is 0 px from being in it',
 goalZoneGap({ shape: 'ball', r: 5 }, { x: 100, y: 0, angle: 0 }, zones) === 0);
 gate('1. …and a piece too BIG for the zone can never be 0, wherever it stands',
 goalZoneGap({ shape: 'ball', r: 40 }, { x: 100, y: 0, angle: 0 }, zones) > 0,
 `${goalZoneGap({ shape: 'ball', r: 40 }, { x: 100, y: 0, angle: 0 }, zones).toFixed(1)} px`);
 // 95 = the zone's left edge (80) plus the ball's radius (15): the distance
 // the CENTRE must travel for the whole ball to be inside.
 gate('1. the gap is measured on the piece, not its centre', near(goalZoneGap(ball, { x: 0, y: 0, angle: 0 }, zones), 95),
 `${goalZoneGap(ball, { x: 0, y: 0, angle: 0 }, zones)}`);
 // A 60x20 plank fits a 40x100 doorway stood on END and never lying flat —
 // which is exactly the case an upright measurement would call hopeless
 // whatever the machine did, because the number that changed is the one it
 // never looked at.
 {
 const tall = [{ x: 100, y: 0, w: 40, h: 100 }];
 const plank = { shape: 'box', w: 60, h: 20 };
 const flatGap = goalZoneGap(plank, { x: 100, y: 0, angle: 0, c: 1, s: 0 }, tall);
 const upGap = goalZoneGap(plank, { x: 100, y: 0, angle: Math.PI / 2, c: 0, s: 1 }, tall);
 gate('1. the box is measured ROTATED — a plank that topples changes its gap',
 flatGap > 0 && upGap === 0, `flat ${flatGap.toFixed(1)}, on end ${upGap.toFixed(1)}`);
 gate('1. …and a pose with no c/s is read from its angle rather than assumed upright',
 near(goalZoneGap(plank, { x: 100, y: 0, angle: Math.PI / 2 }, tall), 0));
 }
 gate('1. the NEAREST zone wins when there are several',
 near(goalZoneGap(ball, { x: 0, y: 0, angle: 0 }, [{ x: 400, y: 0, w: 40, h: 40 }, ...zones]), 95));
 gate('1. no zones at all is Infinity, not 0 — there is nothing to be near',
 goalZoneGap(ball, { x: 0, y: 0, angle: 0 }, []) === Infinity);
 gate('1. every goal piece has to arrive, so the run gap is the WORST of them',
 near(goalRunGap([ball, ball], [{ x: 0, y: 0, angle: 0 }, { x: 100, y: 0, angle: 0 }], zones), 95));
 // The solver has scored candidates by this since it was revived, and now
 // imports it — one rule, two callers, and this is the gate that says so.
 gate('1. GhostRun measures cargo-to-zone with goalZoneGap',
 typeof goalZoneGap === 'function');
});

// ---------- 2. the ordering ----------
section('2', () => {
 const at = (gap) => ({ gap });
 gate('2. nearer beats further', ghostBetter(at(10), at(50)) && !ghostBetter(at(50), at(10)));
 gate('2. a delivery beats any distance', ghostBetter({ won: true, winTime: 9, gap: 0 }, at(0.0001)));
 gate('2. …and a SOONER delivery beats a later one',
 ghostBetter({ won: true, winTime: 2 }, { won: true, winTime: 9 })
 && !ghostBetter({ won: true, winTime: 9 }, { won: true, winTime: 2 }));
 gate('2. keeping the cargo beats losing it, at the same distance',
 ghostBetter({ gap: 10 }, { gap: 10, lost: true }));
 gate('2. …but a delivery outranks even that', ghostBetter({ won: true, winTime: 5, lost: false }, { gap: 0 }));
 gate('2. an editor-legal machine beats one the editor refuses',
 ghostBetter(at(900), { invalid: true, gap: 0 }));
 gate('2. nothing measured yet loses to the first candidate',
 ghostBetter(at(9999), null) && !ghostBetter(null, at(9999)));
 gate('2. …and a verdict is never better than itself', !ghostBetter(at(10), at(10)));
});

// ---------- 3. what moves when a pin moves ----------
section('3', () => {
 const rod = (id, x1, y1, x2, y2) => ({ t: 'rod', kind: 'wood', id, x1, y1, x2, y2 });
 const wheel = (id, x, y, r = 20) => ({ t: 'wheel', kind: 'cw', id, x, y, r });

 {
 const parts = [rod('a', 0, 0, 100, 0)];
 const s = pinMoveSet(parts, 0, 0);
 gate('3. one stick end at the pin moves, and only that end',
 s.ends.length === 1 && s.ends[0].end === 1 && !s.wheels.length && !s.blocked);
 const out = pinMovedParts(parts, s, 10, 5);
 gate('3. …so the stick stretches rather than sliding',
 out[0].x1 === 10 && out[0].y1 === 5 && out[0].x2 === 100 && out[0].y2 === 0);
 }
 {
 const parts = [rod('a', 0, 0, 100, 0), rod('b', 0, 0, 0, 100)];
 const s = pinMoveSet(parts, 0, 0);
 gate('3. two sticks sharing the pin both follow it', s.ends.length === 2);
 const out = pinMovedParts(parts, s, 7, -3);
 gate('3. …and they still share a coordinate afterwards',
 jointKey(out[0].x1, out[0].y1) === jointKey(out[1].x1, out[1].y1));
 }
 {
 // A wheel is rigid and round: a stick on its RIM can only move by moving
 // the whole wheel, which drags every other pin on that wheel with it.
 const w = wheel('w', 0, 0, 20);
 const rimPin = wheelPins(w).find((p) => !p.isCenter);
 const parts = [w, rod('a', rimPin.x, rimPin.y, 200, 0)];
 const s = pinMoveSet(parts, rimPin.x, rimPin.y);
 gate('3. a stick on a wheel\'s RIM takes the whole wheel with it',
 s.wheels.length === 1 && s.ends.length === 1 && !s.blocked);
 const out = pinMovedParts(parts, s, 30, 0);
 gate('3. …the wheel translates and keeps its radius', out[0].x === 30 && out[0].r === 20);
 gate('3. …and the stick end is still exactly on the rim pin',
 jointKey(out[1].x1, out[1].y1) === jointKey(wheelPins(out[0]).find((p) => !p.isCenter).x, wheelPins(out[0]).find((p) => !p.isCenter).y));
 }
 {
 // The closure, one hop further: the pin is a wheel's HUB, a stick is on its
 // rim, and a second wheel hangs off the far end of that stick. The second
 // wheel is NOT in the set — its own hub is a coordinate the move never
 // reached, and the stick swinging is what a linkage does.
 const w1 = wheel('w1', 0, 0, 20);
 const rimPin = wheelPins(w1).find((p) => !p.isCenter);
 const parts = [w1, rod('a', rimPin.x, rimPin.y, 200, 0), wheel('w2', 200, 0, 20)];
 const s = pinMoveSet(parts, 0, 0);
 gate('3. a hub move carries its rim, and the linkage swings from there',
 s.wheels.length === 1 && s.wheels[0] === 0 && s.ends.length === 1 && s.ends[0].i === 1);
 }
 {
 const parts = [rod('a', 0, 0, 100, 0)];
 gate('3. a pin with nothing of yours on it is refused, and says which',
 pinMoveSet(parts, 500, 500).blocked === 'nothing');
 }
 {
 // Bolted to the world: the level's own loose pin is at the stick's end.
 const parts = [rod('a', 0, 0, 100, 0)];
 const anchors = pinAnchors({ pins: [{ x: 0, y: 0 }] });
 gate('3. a pin bolted to the LEVEL is refused rather than torn off it',
 pinMoveSet(parts, 0, 0, anchors).blocked === 'anchored');
 gate('3. …and the far end of the same stick is still free to move',
 !pinMoveSet(parts, 100, 0, anchors).blocked);
 }
 {
 // …and through the closure: the pin is free, but the wheel it drags is
 // itself bolted to a prop's pin, so the whole move has to be refused.
 const w = wheel('w', 0, 0, 20);
 const rimPin = wheelPins(w).find((p) => !p.isCenter);
 const anchors = pinAnchors({ props: [{ pins: [{ x: 0, y: 0 }] }] });
 gate('3. the refusal follows the CLOSURE, not just the pin you clicked',
 pinMoveSet([w, rod('a', rimPin.x, rimPin.y, 200, 0)], rimPin.x, rimPin.y, anchors).blocked === 'anchored');
 }
 {
 const parts = [rod('a', 0, 0, 100, 0), rod('b', 400, 0, 500, 0)];
 const s = pinMoveSet(parts, 0, 0);
 const out = pinMovedParts(parts, s, 3, 3);
 gate('3. a part the move does not touch is the SAME object, not a copy',
 out[1] === parts[1] && out[0] !== parts[0]);
 gate('3. …and the original array is left alone', parts[0].x1 === 0);
 }
});

// ---------- 3b. the CARGO is a pin you can sweep ----------
//
// *"Would be good to be able to right click any pin. eg. Goal piece pins as
// well."* (2026-08-21). Where the cargo starts is a real degree of freedom the
// player has — it may be dragged anywhere the build zone will hold it before
// Play, at the cost of the untampered badge — so it is a position worth
// sweeping, and it behaves in the closure exactly as a wheel does: rigid, moves
// whole, drags everything bolted to it.
section('3b', () => {
 const crate = { shape: 'box', x: 0, y: 0, w: 40, h: 40 };
 const goalsOf = (pos) => [{ def: crate, pos }];
 const corner = goalPins(crate, { x: 0, y: 0 })[0];

 {
 const parts = [{ t: 'rod', kind: 'wood', id: 'a', x1: corner.x, y1: corner.y, x2: 200, y2: 0 }];
 // without the cargo in the set its pins are anchors, and the move is refused
 const anchored = pinMoveSet(parts, corner.x, corner.y, pinAnchors({ goalObjs: [crate] }, [{ x: 0, y: 0 }]));
 gate('3b. a stick bolted to the cargo cannot move while the cargo may not',
 anchored.blocked === 'anchored');
 // …and with it, the crate comes too
 const free = pinMoveSet(parts, corner.x, corner.y,
 pinAnchors({ goalObjs: [crate] }, [{ x: 0, y: 0 }], { cargoMoves: true }), goalsOf({ x: 0, y: 0 }));
 gate('3b. …and with the cargo movable, the crate comes with the stick',
 !free.blocked && free.cargo.length === 1 && free.ends.length === 1);
 const moved = pinMovedGoals([{ x: 0, y: 0 }], free, 12, -5);
 gate('3b. …by the same delta, so the stick stays bolted to the corner it was on',
 near(moved[0].x, 12) && near(moved[0].y, -5)
 && jointKey(...Object.values(goalPins(crate, moved[0])[0]).slice(0, 2))
 === jointKey(corner.x + 12, corner.y - 5));
 }
 {
 // seeded on the crate's own corner: the crate moves and every stick on ANY
 // of its pins follows, which is the wheel-hub rule one piece along
 const pins = goalPins(crate, { x: 0, y: 0 });
 const parts = [
 { t: 'rod', kind: 'wood', id: 'a', x1: pins[0].x, y1: pins[0].y, x2: 200, y2: 0 },
 { t: 'rod', kind: 'wood', id: 'b', x1: pins[2].x, y1: pins[2].y, x2: -200, y2: 0 },
 ];
 const set = pinMoveSet(parts, pins[0].x, pins[0].y,
 pinAnchors({}, null, { cargoMoves: true }), goalsOf({ x: 0, y: 0 }));
 gate('3b. a crate carries every stick bolted to it, not just the one clicked',
 set.cargo.length === 1 && set.ends.length === 2, `${set.ends.length} stick ends follow`);
 }
 {
 // a cargo the sweep may not move is `null` in the list and never joins
 const parts = [{ t: 'rod', kind: 'wood', id: 'a', x1: corner.x, y1: corner.y, x2: 200, y2: 0 }];
 const set = pinMoveSet(parts, corner.x, corner.y, null, [null]);
 gate('3b. a cargo the sweep may not move is skipped, not moved',
 set.cargo.length === 0 && set.ends.length === 1);
 gate('3b. …and moving the set leaves its position alone',
 pinMovedGoals([{ x: 0, y: 0 }], set, 9, 9)[0].x === 0);
 }
 {
 // the pin list itself: a sweepable cargo's pins are offered, an unreachable
 // one's are not
 const level = { terrain: [], buildZones: [{ x: 0, y: 0, w: 400, h: 400 }], goalZones: [{ x: 900, y: 0, w: 60, h: 60 }],
 goalObjs: [{ shape: 'ball', x: 0, y: 0, r: 15 }, { shape: 'ball', x: 2000, y: 0, r: 15 }] };
 const S = screen(level, []);
 const pins = S._designPins();
 gate('3b. the pin list offers the cargo the build zone holds',
 pins.some((p) => Math.hypot(p.x, p.y) < 20));
 gate('3b. …and not the one the level parked outside it, which is not yours to move',
 !pins.some((p) => p.x > 1900), `${pins.length} pins offered`);
 }
});

// ---------- 4. a move keeps the machine's joints ----------
section('4', () => {
 // THE invariant (claim 2 in the banner), asked of a machine with every kind
 // of junction in it and a hundred different deltas.
 const w = { t: 'wheel', kind: 'cw', id: 'w', x: 0, y: 0, r: 20 };
 const rim = wheelPins(w).filter((p) => !p.isCenter);
 const parts = [
 w,
 { t: 'rod', kind: 'wood', id: 'a', x1: 0, y1: 0, x2: 120, y2: 0 }, // on the hub
 { t: 'rod', kind: 'wood', id: 'b', x1: rim[0].x, y1: rim[0].y, x2: 120, y2: 0 }, // rim to the far end
 { t: 'rod', kind: 'water', id: 'c', x1: 120, y2: 60, y1: 0, x2: 200 }, // and onward
 { t: 'wheel', kind: 'ccw', id: 'w2', x: 200, y: 60, r: 15 },
 ];
 const keysOf = (list) => {
 const m = new Map();
 list.forEach((p, i) => {
 const pins = p.t === 'wheel' ? wheelPins(p) : rodPins(p);
 pins.forEach((q, j) => m.set(`${i}:${j}`, jointKey(q.x, q.y)));
 });
 return m;
 };
 const before = keysOf(parts);
 const pairs = [...before.keys()];
 let held = true, cases = 0;
 for (const seed of [[0, 0], [rim[0].x, rim[0].y], [120, 0], [200, 60]]) {
 for (let n = 0; n < 25; n++) {
 const s = pinMoveSet(parts, seed[0], seed[1]);
 if (s.blocked) continue;
 const dx = ((n * 37) % 61) - 30, dy = ((n * 53) % 61) - 30;
 const after = keysOf(pinMovedParts(parts, s, dx, dy));
 cases++;
 for (let i = 0; i < pairs.length; i++) {
 for (let j = i + 1; j < pairs.length; j++) {
 const wasShared = before.get(pairs[i]) === before.get(pairs[j]);
 const isShared = after.get(pairs[i]) === after.get(pairs[j]);
 if (wasShared !== isShared) held = false;
 }
 }
 }
 }
 gate('4. a pin move preserves EVERY joint in the machine, and creates none',
 held && cases > 50, `${cases} moves across 4 pins`);
});

// ---------- 5. where a sweep looks — the zoom ladder ----------
section('5', () => {
 gate('5. three rungs, and each is a tenth of the one above',
 PIN_GRID_STEPS.length === 3
 && PIN_GRID_STEPS.every((s, i) => i === 0 || near(s * 10, PIN_GRID_STEPS[i - 1], 1e-9)),
 PIN_GRID_STEPS.map(pinStepLabel).join(' / ') + ' px');
 gate('5. …all of them 32×32, so the cost of a rung never depends on the rung',
 PIN_GRID_STEPS.every((s) => pinGrid(s).length === PIN_GRID_SIDE ** 2),
 `${PIN_GRID_SIDE ** 2} rollouts each`);
 for (const step of PIN_GRID_STEPS) {
 const g = pinGrid(step);
 const k = pinGridOrigin();
 gate(`5. at ${pinStepLabel(step)} px the machine you already have is a cell, exactly once`,
 g.filter((c) => !c.ix && !c.iy).length === 1);
 gate(`5. …and it is where the field says it is (index ${k * PIN_GRID_SIDE + k})`,
 g.findIndex((c) => !c.ix && !c.iy) === k * PIN_GRID_SIDE + k);
 gate(`5. …the box is ${(step * PIN_GRID_SIDE).toFixed(2)} px across`,
 near(Math.max(...g.map((c) => c.dx)) - Math.min(...g.map((c) => c.dx)), step * (PIN_GRID_SIDE - 1), 1e-9));
 }
 {
 const g = pinGrid(1);
 const half = (PIN_GRID_SIDE - 1) / 2;
 gate('5. it is row-major, so watching the count reads as a sweep across the box',
 g[0].iy === -half && g[1].iy === -half && g[PIN_GRID_SIDE].iy === -half + 1);
 // 21 is ODD, so the pin's own position is the true centre of the box —
 // which the 32 it replaced could not be.
 gate('5. the side is odd, so the pin sits dead centre of the box it sweeps',
 PIN_GRID_SIDE % 2 === 1
 && Math.min(...g.map((c) => c.ix)) === -half && Math.max(...g.map((c) => c.ix)) === half,
 `${PIN_GRID_SIDE}×${PIN_GRID_SIDE} = ${PIN_GRID_SIDE ** 2} rollouts`);
 }
 // **The rungs ARE the editor's nudge ladder** — the three steps the arrow
 // keys already move a selection by. So every cell of every rung is somewhere
 // the player could have put the pin by hand, which is the difference between
 // searching their space and searching a finer one nobody can build in.
 gate('5. the rungs ARE the arrow keys\' ladder — one list, not two that agree',
 PIN_GRID_STEPS === NUDGE_STEPS && NUDGE_STEPS.join() === '1,0.1,0.01',
 `${NUDGE_STEPS.join(' / ')} px`);
 // …and the finest is below every resolution the editor otherwise works at,
 // which is the detail the devil is in. (It is NOT below `jointKey`'s bucket
 // in the sense of never changing one — a 0.32 px box straddles boundaries.
 // What keeps the joints joined is that every end at the pin moves by the SAME
 // delta, which section 4 gates directly.)
 {
 const fine = PIN_GRID_STEPS.at(-1);
 gate('5. the finest rung explores below the grid, the snap and the key bucket alike',
 fine < 0.1 && fine * PIN_GRID_SIDE < 1,
 `${(fine * PIN_GRID_SIDE).toFixed(2)} px across, against a 0.1 px key bucket`);
 // the honest version of "topology is safe": two ends on ONE coordinate,
 // moved by ONE delta, still share a key — at every rung, every cell. That
 // is the property, and it has nothing to do with how fine the rung is.
 const shared = PIN_GRID_STEPS.every((s) => pinGrid(s).every((c) =>
 jointKey(100 + c.dx, 50 + c.dy) === jointKey(100 + c.dx, 50 + c.dy)
 && jointKey(100 + c.dx, 50 + c.dy) !== jointKey(100 + c.dx + 0.4, 50 + c.dy)));
 gate('5. …and what keeps a joint joined is the shared delta, not the rung', shared);
 }
 gate('5. a step prints as its rung is named, not as 0.010000',
 pinStepLabel(0.01) === '0.01' && pinStepLabel(1) === '1');
});

// ---------- 6. the cargo's road ----------
//
// **Ten marks, evenly through the run's TIME** (2026-08-21, on request). Even
// time rather than even distance, because the LINE already says where the cargo
// went and what the marks have to add is the part the line cannot carry: at even
// time the gaps ARE the speed. A fixed COUNT rather than a fixed interval,
// because it is the run you are reading and ten divides any run.
section('6', () => {
 const DT = 1 / 30;
 // A piece that doubles its speed halfway: the second half must leave its marks
 // twice as far apart. At even distance both halves would look identical, which
 // is exactly the information that was being thrown away.
 const ramp = [];
 for (let i = 0; i < 60; i++) ramp.push({ x: i * 2, y: 0 }); // 60 px/s
 for (let i = 1; i <= 60; i++) ramp.push({ x: 118 + i * 4, y: 0 }); // 120 px/s
 const marks = traceMarks(ramp, DT);
 const gaps = marks.slice(1).map((m, i) => Math.abs(ramp[m].x - ramp[marks[i]].x));
 gate('6. no more than ten marks in a run, however long it is',
 marks.length <= GHOST_TRACE_MARKS && traceMarks(Array.from({ length: 4000 }, (_, i) => ({ x: i, y: 0 })), DT).length <= GHOST_TRACE_MARKS,
 `${marks.length} for a ${ramp.length}-step run, ${traceMarks(Array.from({ length: 4000 }, (_, i) => ({ x: i, y: 0 })), DT).length} for a 4000-step one`);
 gate('6. …spread evenly through TIME, so the gaps between them are the SPEED',
 gaps[gaps.length - 1] > gaps[0] * 1.6,
 `${gaps[0].toFixed(0)} px while slow, ${gaps[gaps.length - 1].toFixed(0)} px while fast`);
 gate('6. …which at even DISTANCE would have been the same number twice',
 Math.abs(gaps[gaps.length - 1] / gaps[0] - 2) < 0.35);
 gate('6. the first and the last are always marked',
 marks[0] === 0 && marks.at(-1) === ramp.length - 1);
 // …and the floor, which is only a de-duplicator: ten copies of a piece that
 // never moved is an opaque piece sitting where nothing happened.
 const still = Array.from({ length: 200 }, () => ({ x: 5, y: 5 }));
 gate('6. a piece that does not move leaves one mark, not ten on one spot',
 traceMarks(still, DT).length === 2, `${traceMarks(still, DT).length} (first and last)`);
 const creep = Array.from({ length: 200 }, (_, i) => ({ x: i * 2, y: 0 }));
 gate('6. …but a slow CRAWL still leaves a full trail, so the floor is not a speed limit',
 traceMarks(creep, DT).length === GHOST_TRACE_MARKS, `${traceMarks(creep, DT).length} marks`);
 gate('6. a run shorter than ten steps is marked step by step, not padded',
 traceMarks(Array.from({ length: 4 }, (_, i) => ({ x: i * 40, y: 0 })), DT).length === 4);
 gate('6. a path too short to draw asks for nothing',
 traceMarks([], DT).length === 0 && traceMarks([{ x: 0, y: 0 }], DT).length === 1);
 gate('6. the count and the floor both have names rather than numbers at the call site',
 GHOST_TRACE_MARKS === 10 && GHOST_TRACE_MIN_PX > 0);
});

// ---------- 7. the ghost IS the run ----------
section('7', () => {
 const level = flat();
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -100, y: -40, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -100, y1: -40, x2: -20, y2: -40 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 2, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 const G = S.ghost;
 gate('7. the ghost arrives at its aim and frees its world', !G.sim && !G.failed && near(G.time, 2, STEP));

 // The reference: a plain rollout to the same time, built the same way.
 const ref = new Simulation(level, { parts }, { goalPositions: S.goalPositions, headless: true });
 while (ref.time < 2 - 1e-9) ref._fixedStep();
 const buf = new Float32Array(G.stride);
 ref.writeTape(buf, 0);
 let same = buf.length === G.buf.length && buf.length > 0;
 for (let i = 0; i < buf.length && same; i++) if (buf[i] !== G.buf[i]) same = false;
 gate('7. …and the frame it shows is BIT-IDENTICAL to a plain rollout there',
 same, `${G.stride / 3} bodies`);

 // The trace: one sample per step, plus the one taken at t = 0.
 const steps = Math.round(2 / STEP);
 gate('7. the road has one point per fixed step, and a point at t = 0',
 G.trace.length === 1 && G.trace[0].length === steps + 1,
 `${G.trace[0].length} points for ${steps} steps`);
 gate('7. …starting where the cargo was authored',
 near(G.trace[0][0].x, level.goalObjs[0].x, 0.001));
 ref.destroy();

 // The budget is honoured: a zero budget takes one step and yields.
 const S2 = screen(level, parts);
 S2.ghost = { t: 30, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 S2._ghostTick(0);
 const first = S2.ghost.time;
 S2._ghostTick(0);
 gate('7. a tick spends its budget and yields — the page keeps its frame',
 S2.ghost.sim && first < 30 && S2.ghost.time > first && S2.ghost.time < 30,
 `${first.toFixed(2)}s then ${S2.ghost.time.toFixed(2)}s of a 30s aim`);
 S2.ghost.sim.destroy();
});

// ---------- 8. what the mode does to the rest of the screen ----------
section('8', () => {
 const S = screen(flat(), [{ t: 'wheel', kind: 'cw', id: 'w', x: -100, y: -40, r: 20 }]);
 S._tape = null;
 // **It arms with no run at all** (2026-08-21). The mode never needed the tape
 // — the ghost builds its own world from t = 0 — and the tape was only ever the
 // dial. The chip carries one of its own now, so the precondition that made the
 // button feel broken on its first day is simply gone.
 gate('8. with no run recorded there is still no moment on a TAPE to aim at',
 S._ghostAimTime() === null && !S._ghostCanAim());
 S._toggleGhostRun();
 gate('8. …and the mode arms anyway, at its own default aim',
 !!S.ghost && near(S.ghost.t, GHOST_AIM_DEFAULT), `${S.ghost?.t}s`);
 gate('8. …with the chip up to carry the dial', S.chipShown === true);
 S._ghostOff();

 // A tape, hand-built: three frames at known times. When there IS a run, the
 // moment you paused on is the better opening aim — you have just watched it.
 S._tape = { n: 3, head: 3, frames: 3, t: new Float32Array([0, 0.5, 1.25]), stride: 0 };
 S._scrub = 2;
 gate('8. the aim is read off the tape\'s own CLOCK, not frame arithmetic', near(S._ghostAimTime(), 1.25));
 S._toggleGhostRun();
 gate('8. the mode opens at the moment the scrubber is parked on', !!S.ghost && near(S.ghost.t, 1.25));
 gate('8. …and hands the canvas back to the editor, so there is something to edit',
 S._viewForDraw() === null && S._backViewForDraw() === null);
 // …but never while a run is on screen: then the run IS the machine, and a
 // guard that blanked it would leave ▶ drawing a machine that never moves.
 S.playing = true;
 S.sim = { view: () => 'live' };
 const parked = S._scrub;
 S._scrub = null; // tracking the live end, as a run does
 gate('8. …except while PLAYING, where the live run keeps the canvas',
 S._viewForDraw() === 'live');
 S.playing = false; S.sim = null; S._scrub = parked;

 // Re-aiming: the slider is the mode's dial.
 S.ghost.stale = false;
 S._scrub = 1;
 S._ghostAim(S._ghostAimTime());
 gate('8. dragging the scrub line re-aims the ghost', near(S.ghost.t, 0.5) && S.ghost.stale);
 S.ghost.stale = false;
 S._ghostAim(0.5);
 gate('8. …and re-aiming at the same moment costs nothing', !S.ghost.stale);

 // An edit invalidates it.
 S.ghost.stale = false;
 S._updateStats();
 gate('8. every edit funnels through _updateStats, so every edit invalidates the ghost', S.ghost.stale);

 // …and the chip's OWN dial, which is what replaced the borrowed one.
 S.ghost.stale = false;
 S._ghostSetAim(7.5);
 gate('8. the chip\'s dial re-aims the ghost, tape or no tape',
 near(S.ghost.t, 7.5) && S.ghost.stale);
 S._ghostSetAim(999);
 gate('8. …clamped to what the mode will actually simulate', near(S.ghost.t, GHOST_AIM_MAX));
 S._ghostSetAim(-4);
 gate('8. …at both ends', near(S.ghost.t, GHOST_AIM_MIN));
 // **Cubed, and cubed BECAUSE the range grew.** A sweep costs 225 rollouts to
 // wherever this points and nearly every aim is a second or two, so the bulk of
 // the travel belongs down there. Squaring gave 7.6 s at the halfway mark while
 // the ceiling was 30; keeping the square at 60 would have moved it to 15 —
 // growing the range by taking precision out of the part of it anybody uses.
 //
 // The ceiling is 100 s since 2026-08-22 and the cube held, so the halfway mark
 // is 12.59 s now. That number is NOT the precision test — grain at a given aim
 // goes as the cube root of the range, so the whole 60 → 100 move costs 1.19×
 // there. What the dial has to keep is the short end, which is measured by the
 // two gates under this one rather than by where half the travel lands.
 gate('8. the dial reaches 100 s',
 GHOST_AIM_MAX === 100 && ghostAimFromNotch(GHOST_AIM_NOTCHES) === 100);
 gate('8. …with a fifth of the travel still under a second, where a sweep is watchable',
 Array.from({ length: GHOST_AIM_NOTCHES + 1 }, (_, n) => ghostAimFromNotch(n)).filter((t) => t < 1).length >= 120,
 `${Array.from({ length: GHOST_AIM_NOTCHES + 1 }, (_, n) => ghostAimFromNotch(n)).filter((t) => t < 1).length} notches under 1 s`);
 gate('8. …and a grain at a 2 s aim the taller ceiling barely moved',
 ghostAimFromNotch(ghostAimToNotch(2) + 1) - ghostAimFromNotch(ghostAimToNotch(2)) < 0.05,
 `${(ghostAimFromNotch(ghostAimToNotch(2) + 1) - ghostAimFromNotch(ghostAimToNotch(2))).toFixed(3)}s per notch at 2 s`);
 // Drift is the sync at `_syncAdvBar` writing a notch back under the hand that
 // is dragging: every value the dial can PRODUCE has to name its own notch
 // again. A second arriving from anywhere else (the tape, a remembered aim)
 // only has to land on the nearest notch, and at a 45 s aim one notch is 0.3 s.
 gate('8. …and every value it can produce round-trips exactly, so the sync cannot fight your hand',
 Array.from({ length: GHOST_AIM_NOTCHES + 1 }, (_, n) => ghostAimFromNotch(n))
 .every((t) => ghostAimFromNotch(ghostAimToNotch(t)) === t));
 gate('8. …and a second from anywhere else lands within half a notch of itself',
 [0.1, 0.5, 2, 4, 7.5, 18, 30, 45, 60, 80, 100].every((t) => Math.abs(ghostAimFromNotch(ghostAimToNotch(t)) - t) < 0.2));
 gate('8. …ends included',
 ghostAimFromNotch(0) === GHOST_AIM_MIN && ghostAimFromNotch(GHOST_AIM_NOTCHES) === GHOST_AIM_MAX);

 S._ghostSetAim(6.25);
 S._ghostOff();
 gate('8. switching off leaves no ghost and no sweep', !S.ghost && !S._ghostSweep);
 S._tape = null;
 S._toggleGhostRun();
 gate('8. …but the AIM is remembered, the way the roads are',
 near(S.ghost.t, 6.25), `${S.ghost?.t}s`);
});

// ---------- 9. the sweep ----------
section('9', () => {
 // A machine whose stick end plainly wants to be somewhere else: a cw wheel
 // driving a stick that shoves the ball. Where the free end of that stick
 // sits decides whether the ball is nudged or missed.
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 1.5, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 const before = JSON.parse(JSON.stringify(S.design.parts));

 S._startPinSweep({ x: -140, y: -60 }, 1);
 const S0 = S._ghostSweep;
 gate('9. a sweep opens on the ORIGIN cell, so the baseline is measured first',
 S0 && !S0.order[0].ix && !S0.order[0].iy);
 gate('9. …and it opens the chip, because the chip is where the answer goes',
 S.chipShown === true);
 const total = S0.order.length;
 sweepToEnd(S);
 const done = S._ghostSweep;
 gate('9. it finishes, and what is left is the field rather than the job',
 done?.done === true && !!done.field);
 const measured = [...done.field.cells].filter((v) => !Number.isNaN(v)).length;
 gate('9. EVERY cell of the grid is measured — no silent truncation',
 measured === total, `${measured} of ${total} at ${done.step} px`);
 gate('9. the baseline is one of the measured cells, not an assumption',
 Number.isFinite(done.field.base));

 // **Nothing is applied.** The run ends at the picture; the click is the act.
 gate('9. a finished sweep has NOT moved the machine — the chip is the control',
 JSON.stringify(S.design.parts) === JSON.stringify(before));
 gate('9. …but it names a winner for the click to aim at',
 done.field.bestIdx != null && done.cells[done.field.bestIdx] <= done.field.base);

 // A refusal, all the way through the public entry point.
 const S2 = screen(flat({ pins: [{ x: -140, y: -60 }] }), parts);
 S2.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 S2._startPinSweep({ x: -140, y: -60 }, 1);
 gate('9. a pin bolted to the level is refused, and the refusal explains itself',
 !S2._ghostSweep && /bolted to the level/i.test(S2.toasts.at(-1) || ''));

 // Esc mid-sweep: the job stops, the measurement so far stays, and what was
 // NOT covered is said rather than left looking like a full sweep.
 const S3 = screen(level, parts);
 S3.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S3);
 S3._startPinSweep({ x: -140, y: -60 }, 1);
 // a real budget, so the sweep is genuinely part-way through rather than
 // finished — 1e9 ms would run the whole grid inside one tick
 for (let i = 0; i < 400 && S3._ghostSweep && !S3._ghostSweep.done && S3._ghostSweep.i < 5; i++) S3._pinSweepTick(0.05);
 const part = S3._ghostSweep.i;
 S3._cancelPinSweep();
 gate('9. Esc stops a sweep, keeps the field so far, and reports what it covered',
 S3._ghostSweep?.done && part > 0 && new RegExp(`${part} of ${total}`).test(S3.toasts.at(-1) || ''),
 S3.toasts.at(-1));
 gate('9. …and the cells it DID reach are still clickable, because they are real',
 [...S3._ghostSweep.cells].filter((v) => !Number.isNaN(v)).length === part);
 gate('9. …while an ordinary edit throws the whole field away — it measured another machine',
 (S3._updateStats(), S3._ghostSweep === null));
});

// ---------- 9b. the chip is the control ----------
//
// **A click on a cell is what moves the machine** (2026-08-21, on request:
// *"When the chip it clicked the machine moves to that pin position"*), and it
// moves it from the build the sweep OPENED on, never from wherever the last
// click left it — otherwise a second click compounds onto the first and the
// field stops describing the thing it is drawn over.
section('9b', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -140, y: -60 }, 1);
 sweepToEnd(S);
 const Sw = S._ghostSweep;
 const home = Sw.field.originIdx;
 const endOf = () => ({ x: S.design.parts[1].x2, y: S.design.parts[1].y2 });
 const start = endOf();

 // pick two DIFFERENT legal cells and click each in turn
 const legal = [...Sw.cells].map((v, i) => [v, i]).filter(([v, i]) => Number.isFinite(v) && i !== home).map(([, i]) => i);
 const [a, b] = [legal[0], legal[legal.length - 1]];
 S._applySweepCell(a);
 const afterA = endOf();
 const offA = S._cellOffset(Sw, a);
 gate('9b. clicking a cell puts the pin exactly where that cell says',
 near(afterA.x, start.x + offA.ix * Sw.step, 1e-9) && near(afterA.y, start.y + offA.iy * Sw.step, 1e-9),
 `${offA.ix}, ${offA.iy} at ${Sw.step} px`);
 S._applySweepCell(b);
 const afterB = endOf();
 const offB = S._cellOffset(Sw, b);
 gate('9b. …and a SECOND click measures from the same place, never from the first',
 near(afterB.x, start.x + offB.ix * Sw.step, 1e-9) && near(afterB.y, start.y + offB.iy * Sw.step, 1e-9));
 S._applySweepCell(home);
 gate('9b. …so clicking the origin cross puts the machine back exactly',
 near(endOf().x, start.x, 1e-12) && near(endOf().y, start.y, 1e-12));

 // The field survives its own clicks and nothing else.
 gate('9b. the chip outlives an apply — otherwise it is one click, not a field',
 S._ghostSweep === Sw && Sw.done);
 gate('9b. …and each click re-runs the future, which is what you clicked to see',
 S.ghost.stale === true);
 S._updateStats();
 gate('9b. …but any OTHER edit clears it', S._ghostSweep === null);

 // The two refusals a click can meet, each said rather than silently ignored.
 const S2 = screen(level, parts);
 S2.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S2);
 S2._startPinSweep({ x: -140, y: -60 }, 1);
 for (let i = 0; i < 400 && S2._ghostSweep && !S2._ghostSweep.done && S2._ghostSweep.i < 4; i++) S2._pinSweepTick(0.05);
 S2._cancelPinSweep();
 const unmeasured = [...S2._ghostSweep.cells].findIndex((v) => Number.isNaN(v));
 const held = JSON.stringify(S2.design.parts);
 S2._applySweepCell(unmeasured);
 gate('9b. a cell the sweep never reached says so and moves nothing',
 JSON.stringify(S2.design.parts) === held && /never measured/i.test(S2.toasts.at(-1) || ''));
 const refused = [...S2._ghostSweep.cells].findIndex((v) => v === Infinity);
 if (refused >= 0) {
 S2._applySweepCell(refused);
 gate('9b. …and a cell the EDITOR refuses says which, and moves nothing',
 JSON.stringify(S2.design.parts) === held && /will not accept/i.test(S2.toasts.at(-1) || ''));
 }

 // The readout is the pure half of the chip, so it IS gateable: offset first,
 // because at 0.01 px the offset is the whole point and a colour cannot say it.
 const S3 = screen(level, parts);
 S3.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S3);
 S3._startPinSweep({ x: -140, y: -60 }, 0.01);
 gate('9b. while it runs the chip counts, so a long sweep is never a blank wait',
 /^\d+ of \d+…$/.test(S3._sweepReadout(S3._ghostSweep)), S3._sweepReadout(S3._ghostSweep));
 sweepToEnd(S3);
 const R = S3._ghostSweep;
 R.field.hoverIdx = R.field.originIdx;
 gate('9b. …and hovering a cell prints its OFFSET and its score at the rung\'s own precision',
 /^0\.00, 0\.00 → /.test(S3._sweepReadout(R)), S3._sweepReadout(R));
});

// ---------- 9g. a field re-runs when the aim moves ----------
//
// *"If I have a matrix up and I move the scrubber. Recalc."* (2026-08-21).
//
// A field cannot be RESCORED for a new aim the way it can for a new road: every
// cell's samples are a run to the old second, and no arithmetic turns them into
// runs to a different one. But the pin, the machine and the rung are all
// unchanged, so the sweep does not need throwing away — it needs doing again.
//
// Which is the distinction worth gating: a re-aim re-runs, an EDIT cancels. After
// an edit the field is about a machine that no longer exists and there is
// nothing to re-run it on.
section('9g', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const armed = () => {
 const S = screen(level, parts);
 S.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -140, y: -60 }, 1);
 sweepToEnd(S);
 return S;
 };

 const S = armed();
 gate('9g. a finished sweep remembers how to ask for itself again',
 S._ghostSweep.spec?.kind === 'pin' && near(S._ghostSweep.spec.step, 1)
 && near(S._ghostSweep.spec.pin.x, -140));

 S._ghostSetAim(2.5);
 gate('9g. moving the aim arms a re-run rather than binning the field',
 !!S._resweep && S._resweep.kind === 'pin' && S._ghostSweep === null);
 // …debounced, so dragging the dial across the range starts ONE sweep
 S._resweepTick();
 gate('9g. …and it waits for the hand to stop', !S._ghostSweep && !!S._resweep);
 S._ghostSetAim(4);
 S._ghostSetAim(6);
 gate('9g. …every nudge re-arms the same one rather than queueing more',
 !!S._resweep && !S._ghostSweep);

 // …and once it settles, and the ghost has its own footing, it runs
 S._resweepAt = 0;
 S._resweepTick();
 gate('9g. …not before the ghost has a rollout to estimate the cost from',
 !S._ghostSweep, 'ghost still stale');
 ghostToEnd(S);
 S._resweepAt = 0;
 S._resweepTick();
 gate('9g. …and then it re-runs, at the pin it was on and the new aim',
 !!S._ghostSweep && near(S._ghostSweep.t, 6) && near(S._ghostSweep.x, -140),
 `${S._ghostSweep?.t}s`);
 gate('9g. …with nothing left armed', !S._resweep);
 sweepToEnd(S);
 gate('9g. …and it measures a full field at the new second',
 [...S._ghostSweep.cells].filter((v) => !Number.isNaN(v)).length === S._ghostSweep.order.length);

 // An EDIT is the other case, and stays the other case.
 const E = armed();
 E.design.parts.push({ t: 'rod', kind: 'wood', id: 'x', x1: 0, y1: -60, x2: 40, y2: -60 });
 E._commit();
 gate('9g. an EDIT still cancels outright — there is no machine left to re-run it on',
 E._ghostSweep === null && !E._resweep);

 // …and a weight sweep re-arms as a weight sweep
 const W = screen(level, parts);
 W.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(W);
 W._startWeightSweep(W.design.parts[1]);
 sweepToEnd(W);
 W._ghostSetAim(3);
 gate('9g. a density sweep re-arms as a density sweep, not as a pin one',
 W._resweep?.kind === 'weight' && W._resweep.rod === W.design.parts[1]);
});

// ---------- 10. the road, drawn by the player ----------
//
// **Distance to the goal is an opinion about the route.** That is why this
// exists (util.js), and the answer settled where it settled: *"Maybe the
// path should be provided by the player! ... And sometimes there are many paths
// you can go by..."* — so the score is remaining distance along a road the
// player drew, best of that cargo's roads, worst of the cargo being judged.
section('10', () => {
 const zones = [{ x: 600, y: 0, w: 60, h: 60 }];
 const ball = { shape: 'ball', r: 10 };
 const at = (x, y) => ({ x, y, angle: 0 });
 const road = (pts, goal = null) => ({ goal, pts });
 const g = (run, paths, only = null) => ghostAimGap([ball], [run], zones, paths, only);

 gate('10. with no road the score is the plain WIN condition',
 g([at(0, 0)], null) === goalRunGap([ball], [at(0, 0)], zones));
 gate('10. …so a piece anywhere inside the zone scores 0',
 g([at(615, 15)], null) === 0);

 // **BOTH branches read the closest the cargo ever came, not where it stopped**
 // (2026-08-21). The road branch always did; the no-road branch read only the
 // last sample, so drawing a road changed not just the ruler but WHEN it was
 // read. A machine that carries the cargo into the goal and lets it roll back
 // out has still got it there, and a search needs to be told so — "where did it
 // stop" is flat over every machine that overshot, which is nothing to climb.
 {
 const arrivedThenLeft = [at(0, 0), at(300, 0), at(600, 0), at(900, 0)]; // through the zone and out
 gate('10. the score is the CLOSEST the cargo came, not where it stopped',
 g(arrivedThenLeft, null) === 0,
 `${g(arrivedThenLeft, null).toFixed(0)} px, against ${goalZoneGap(ball, at(900, 0), zones).toFixed(0)} where it ended`);
 gate('10. …which is what a road has always done, so the two branches now agree',
 g(arrivedThenLeft, [road([{ x: 300, y: 0 }])]) < 1
 && g(arrivedThenLeft, null) < 1);
 // …and it must not turn a machine that never arrived into one that did
 gate('10. …without flattering a run that only ever got near',
 g([at(0, 0), at(200, 0), at(400, 0)], null) > 0,
 `${g([at(0, 0), at(200, 0), at(400, 0)], null).toFixed(0)} px at its closest`);
 }

 // The case the whole thing exists for, and the shape of the level it was
 // asked on: the cargo has to go the WRONG way first.
 {
 const away = road([{ x: 0, y: -400 }, { x: 600, y: -400 }]);
 gate('10. a cargo ON the road beats one the same distance from the goal but off it',
 g([at(0, -400)], [away]) < g([at(0, 0)], [away]),
 `${g([at(0, -400)], [away]).toFixed(0)} on the road vs ${g([at(0, 0)], [away]).toFixed(0)} off it`);
 gate('10. …and the further along it, the better',
 g([at(300, -400)], [away]) < g([at(0, -400)], [away]));
 }

 // …and a road that doubles back over itself, which is the level in front of
 // him: all the way LEFT, then right and down. A pose cannot tell the outbound
 // leg from the return one; the RUN can.
 {
 const there = road([{ x: 0, y: -100 }, { x: -500, y: -100 }, { x: 500, y: -100 }]);
 const walk = (from, to, n = 12) => Array.from({ length: n + 1 }, (_, i) =>
 at(from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n));
 const S0 = at(0, -100), L = at(-480, -100), R = at(480, -100);
 const still = [S0];
 const wentLeft = walk(S0, L);
 const cheated = walk(S0, R);
 const wholeRoad = [...walk(S0, L), ...walk(L, R)];
 gate('10. going the WRONG way first is rewarded, which is the entire point',
 g(wentLeft, [there]) < g(still, [there]),
 `${g(wentLeft, [there]).toFixed(0)} after going left vs ${g(still, [there]).toFixed(0)} sitting still`);
 gate('10. …and a machine that shoves it straight to the goal gets NO credit for the trip',
 g(cheated, [there]) >= g(still, [there]) - 1,
 `${g(cheated, [there]).toFixed(0)} for the shortcut`);
 gate('10. …because the road position may only advance as fast as the cargo moved',
 g(cheated, [there]) > g(wentLeft, [there]));
 gate('10. …and doing the whole road beats every part of it',
 g(wholeRoad, [there]) < g(wentLeft, [there]));
 }

 // "Many paths you can go by": best of them, and a road the cargo is nowhere
 // near may not claim it.
 {
 const high = road([{ x: 0, y: -400 }, { x: 600, y: -400 }]);
 const low = road([{ x: 0, y: 400 }, { x: 600, y: 400 }]);
 const onLow = [at(0, 400)];
 gate('10. a cargo on ONE of two roads is scored by the one it is on',
 near(g(onLow, [high, low]), g(onLow, [low]), 1e-9),
 `${g(onLow, [high, low]).toFixed(0)} either way`);
 gate('10. …and having a second road can never make a machine score worse',
 g(onLow, [high, low]) <= g(onLow, [low]) + 1e-9);
 }

 // A road belongs to a cargo, and one cargo at a time can be judged alone.
 {
 const two = [ball, ball];
 const runs = [[at(0, -400)], [at(0, 400)]];
 const mine = [road([{ x: 0, y: -400 }, { x: 600, y: -400 }], 0), road([{ x: 0, y: 400 }, { x: 600, y: 400 }], 1)];
 const both = ghostAimGap(two, runs, zones, mine, null);
 const first = ghostAimGap(two, runs, zones, mine, 0);
 gate('10. every cargo has to arrive, so judging all takes the WORST of them',
 both >= first - 1e-9 && both === Math.max(first, ghostAimGap(two, runs, zones, mine, 1)));
 gate('10. …and `only` narrows it to one, which is how the work is actually done',
 first === ghostAimGap([ball], [runs[0]], zones, [mine[0]], null));
 gate('10. a road is only used by the cargo it was drawn for',
 ghostAimGap([ball], [runs[0]], zones, [road([{ x: 0, y: 400 }, { x: 600, y: 400 }], 1)], null)
 === goalZoneGap(ball, at(0, -400), zones));
 }

 // …and the plumbing round it.
 const S = screen(flat(), [{ t: 'wheel', kind: 'cw', id: 'w', x: -100, y: -40, r: 20 }]);
 S._tape = { n: 2, head: 2, frames: 2, t: new Float32Array([0, 1]), stride: 0 };
 S._scrub = 1;
 S._toggleGhostRun();
 gate('10. a fresh screen has no road, so it judges by the goal',
 Array.isArray(S._ghostRoads) && S._ghostRoads.length === 0 && S._ghostOnly === null);
 S._ghostAddWaypoint({ x: -400, y: -80 });
 gate('10. a corner starts a road, and it belongs to the nearest cargo',
 S._ghostRoads.length === 1 && S._ghostRoads[0].pts.length === 1 && S._ghostRoads[0].goal === 0);
 S._ghostAddWaypoint({ x: -200, y: -300 });
 gate('10. …and the next corner joins the same road, in the order it was drawn',
 S._ghostRoads.length === 1 && S._ghostRoads[0].pts.length === 2
 && S._ghostRoads[0].pts[1].x === -200);
 S._ghostAddWaypoint({ x: 0, y: -300 }, { fresh: true });
 gate('10. …unless another road was asked for, because there are many paths',
 S._ghostRoads.length === 2);
 gate('10. a corner is picked in SCREEN px, so zooming out cannot lose it',
 !!S._ghostWaypointAt({ x: -400, y: -80 }) && !S._ghostWaypointAt({ x: -400, y: -20 }));
 {
 S.camera.zoom = 0.25;
 gate('10. …at every zoom, which a world-space radius would not manage',
 !!S._ghostWaypointAt({ x: -400, y: -60 }));
 S.camera.zoom = 1;
 }
 gate('10. …and a FINGER gets the same multiple over a cursor that a pin gets',
 near(GHOST_TARGET_TOUCH, snapRadius(1, true) / snapRadius(1, false)),
 `${GHOST_TARGET_PICK} px becomes ${(GHOST_TARGET_PICK * GHOST_TARGET_TOUCH).toFixed(0)}`);
 S.ghost.stale = false;
 S._ghostAimMove({ x: -420, y: -90 }, { shiftKey: false, altKey: false }, { pi: 0, k: 0 });
 gate('10. dragging a corner moves it and does NOT re-run the future',
 S._ghostRoads[0].pts[0].x === -420 && !S.ghost.stale);
 S._ghostDropWaypoint({ pi: 0, k: 0 });
 gate('10. a corner can be taken out again', S._ghostRoads[0].pts.length === 1);
 // **The roads outlive the mode**, because they are work rather than view
 // state: switching a view off is not a reason to throw a plan away.
 const drawn = JSON.stringify(S._ghostRoads);
 S._ghostOff();
 gate('10. switching GhostRun off keeps the roads — they are work, not view state',
 JSON.stringify(S._ghostRoads) === drawn && !S.ghost);
 S._toggleGhostRun();
 gate('10. …and arming it again picks the same plan back up',
 JSON.stringify(S._ghostRoads) === drawn && !!S.ghost);
 S._ghostClearPaths();
 gate('10. only asking clears them, and that is the way back to the goal alone',
 S._ghostRoads.length === 0 && S._ghostOnly === null);
});

// ---------- 10z. which cargo goes to which goal ----------
//
// "I need a way to select which goal piece goes to which goal for Ghost mode."
// The win condition is still any piece in any zone; GhostRun can be told to
// score cargo i against zone j, so a two-pad level is not silently "nearest".
section('10z', () => {
 const left = { x: -400, y: 0, w: 80, h: 80 };
 const right = { x: 400, y: 0, w: 80, h: 80 };
 const zones = [left, right];
 const ball = { shape: 'ball', r: 10 };
 const at = (x, y) => ({ x, y, angle: 0 });
 const sittingLeft = [at(-400, 0)];
 const sittingRight = [at(400, 0)];

 gate('10z. zonesForCargo with no pairing is every zone',
 zonesForCargo(zones, null, 0).length === 2 && zonesForCargo(zones, [], 0).length === 2);
 gate('10z. …and a pairing narrows it to that one pad',
 zonesForCargo(zones, [1], 0).length === 1 && zonesForCargo(zones, [1], 0)[0] === right);

 gate('10z. unassigned, a cargo sitting in EITHER zone scores 0',
 ghostAimGap([ball], [sittingLeft], zones) === 0
 && ghostAimGap([ball], [sittingRight], zones) === 0);
 gate('10z. sent to the RIGHT pad, sitting in the left one is not a delivery',
 ghostAimGap([ball], [sittingLeft], zones, null, null, [1]) > 0);
 gate('10z. …and sitting in the right one is',
 ghostAimGap([ball], [sittingRight], zones, null, null, [1]) === 0);
 gate('10z. two cargo, two pads: each scored against its own',
 ghostAimGap([ball, ball], [sittingLeft, sittingRight], zones, null, null, [0, 1]) === 0
 && ghostAimGap([ball, ball], [sittingLeft, sittingRight], zones, null, null, [1, 0]) > 0);

 const twoPad = flat({
 goalZones: [left, right],
 goalObjs: [
 { shape: 'ball', x: -400, y: 0, r: 10 },
 { shape: 'ball', x: 400, y: 0, r: 10 },
 ],
 });
 const S = screen(twoPad);
 S._toggleGhostRun();
 gate('10z. a fresh pairing is none — any zone will do',
 !S._hasGhostAssign() && S._ghostZoneFor(0) == null);
 S._ghostSetAssign(0, 1);
 gate('10z. sending cargo 1 to goal 2 is remembered',
 S._ghostAssign[0] === 1 && S._ghostZoneFor(0) === 1);
 gate('10z. …and that cargo’s road now ends on that pad',
 S._ghostGoalPt(0).x === right.x && S._ghostGoalPt(0).y === right.y);
 gate('10z. the other cargo is still free to use any pad',
 S._ghostZoneFor(1) == null);
 const drawn = JSON.stringify(S._ghostAssign);
 S._ghostOff();
 gate('10z. pairings outlive the mode, like roads',
 JSON.stringify(S._ghostAssign) === drawn && !S.ghost);
 S._toggleGhostRun();
 gate('10z. …and arming it again picks the same pairing up',
 JSON.stringify(S._ghostAssign) === drawn && !!S.ghost);
 S._ghostClearPaths();
 gate('10z. clearing the roads leaves the pairing',
 S._ghostAssign[0] === 1);
 S._ghostClearAssign();
 gate('10z. only asking clears the pairing',
 !S._hasGhostAssign() && S._ghostZoneFor(0) == null);

 // A draft sent to the far pad has to cross the room; any-zone is already home.
 const cargo = twoPad.goalObjs[0];
 const any = routeField(twoPad, cargo, null);
 const far = routeField(twoPad, cargo, null, [right]);
 gate('10z. a draft to ANY zone is short from cargo sitting in the left pad',
 routeDistanceAt(any, -400, 0) < 50, `${routeDistanceAt(any, -400, 0).toFixed(0)} px`);
 gate('10z. …and a draft SENT to the right pad is a trip across the room',
 routeDistanceAt(far, -400, 0) > 700, `${routeDistanceAt(far, -400, 0).toFixed(0)} px`);

 // undo, same wiring as the roads (10d)
 const U = screen(twoPad);
 U._commit = GameScreen.prototype._commit;
 U._pushUndo = GameScreen.prototype._pushUndo;
 U._snapshotUndo = GameScreen.prototype._snapshotUndo;
 U._restore = GameScreen.prototype._restore;
 U.undoStack = []; U.redoStack = [];
 U._pushUndo();
 U._toggleGhostRun();
 U._ghostSetAssign(0, 1);
 U._ghostSetAssign(1, 0);
 gate('10z. two pairings drawn', U._ghostAssign[0] === 1 && U._ghostAssign[1] === 0);
 U.undo();
 gate('10z. undo takes the last pairing back',
 U._ghostAssign[0] === 1 && U._ghostZoneFor(1) == null,
 JSON.stringify(U._ghostAssign));
 U.undo();
 gate('10z. …and again restores any-zone', !U._hasGhostAssign());
 U.redo();
 gate('10z. redo puts it back', U._ghostAssign[0] === 1);
});

// ---------- 10r. the draft continues the road you started ----------
//
// Requested: "'Draft a road around the terrain' should draft from the highest
// numbered 'corner' so far." It used to throw the hand-laid corners away and
// start again from the cargo — which punished exactly the player who had done
// the hard part themselves.
section('10r', () => {
 // A wall between the cargo and the goal, so a draft has corners to find.
 const walled = () => flat({
 terrain: [
 { type: 'box', x: 0, y: 30, w: 3000, h: 60 },
 { type: 'box', x: 300, y: -150, w: 40, h: 300 }, // the wall to go over
 ],
 });
 const arm = () => {
 const S = screen(walled(), [{ t: 'wheel', kind: 'cw', id: 'w', x: -100, y: -40, r: 20 }]);
 S._tape = { n: 2, head: 2, frames: 2, t: new Float32Array([0, 1]), stride: 0 };
 S._scrub = 1;
 S._toggleGhostRun();
 S._pushUndo = () => { S.pushes = (S.pushes || 0) + 1; };
 S._ghostRescore = () => {};
 S._rescoreField = () => {};
 return S;
 };

 // Fresh: no road yet — drafts from the cargo, as it always did.
 {
 const S = arm();
 S._ghostSuggestRoute(0);
 gate('10r. with no road laid, the draft starts one from the cargo',
 S._ghostRoads.length === 1 && S._ghostRoads[0].pts.length >= 2,
 (S._ghostRoads[0]?.pts.length ?? 0) + ' corners');
 }

 // Continued: two corners laid by hand, then the draft — the hand-laid pair
 // must SURVIVE at the head of the same road, with the drafted rest appended.
 {
 const S = arm();
 S._ghostAddWaypoint({ x: -150, y: -60 });
 S._ghostAddWaypoint({ x: 60, y: -220 });
 const before = S._ghostRoads[0].pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
 S._ghostSuggestRoute(0);
 const after = S._ghostRoads[0].pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
 gate('10r. the hand-laid corners survive at the head of the road',
 S._ghostRoads.length === 1 && after.length > 2
 && after[0] === before[0] && after[1] === before[1],
 `[${before.join(' ')}] -> [${after.join(' ')}]`);
 gate('10r. …and the drafted corners are appended, not a second road',
 S._ghostRoads.filter((p) => p.goal === 0).length === 1,
 S._ghostRoads.length + ' roads');
 // the join is clean: the draft's first sample is the cell nearest the
 // corner it grew from, and that duplicate is dropped
 const min = Math.min(...S._ghostRoads[0].pts.slice(1).map((p, i) =>
 Math.hypot(p.x - S._ghostRoads[0].pts[i].x, p.y - S._ghostRoads[0].pts[i].y)));
 gate('10r. …with no zero-length joint where the draft took over',
 min > 1, 'closest adjacent pair ' + min.toFixed(1) + ' px apart');
 }

 // A corner already in sight of the goal: nothing to draft, and the road is
 // left exactly as it was — saying so beats silently doing nothing.
 {
 const S = arm();
 S._ghostAddWaypoint({ x: 860, y: -60 }); // beside the goal zone
 const before = JSON.stringify(S._ghostRoads);
 const toasts0 = S.toasts.length;
 S._ghostSuggestRoute(0);
 gate('10r. a corner already in sight of the goal drafts nothing, and says so',
 JSON.stringify(S._ghostRoads) === before && S.toasts.length > toasts0
 && /already straight/.test(S.toasts[S.toasts.length - 1]),
 S.toasts[S.toasts.length - 1]);
 }
});

// ---------- 10b. moving the road costs nothing ----------
//
// *"When the goal piece target is moved, do you really need to recalculate
// everything?"* (2026-08-21) — no. A cell's score is a QUESTION asked of the
// samples its rollout produced, so keeping the samples means a new question —
// a road dragged, a corner added — is answered by arithmetic rather than by a
// grid of fresh worlds.
//
// **The claim that has to be gated is EQUIVALENCE**: rescoring must land on the
// same numbers a fresh sweep against the new target would. A shortcut that is
// merely fast is not worth having if it is also a different answer.
section('10b', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const ROAD = { goal: null, pts: [{ x: -300, y: -200 }, { x: -60, y: -140 }] };
 const armed = (t = 1) => {
 const S = screen(level, parts);
 S.ghost = { t, target: null, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 return S;
 };

 // A: swept against the goal, then the crosshair moved and the field rescored.
 const A = armed();
 A._startPinSweep({ x: -140, y: -60 }, 1);
 sweepToEnd(A);
 const beforeMove = [...A._ghostSweep.cells];
 A._ghostRoads = [ROAD];
 A._rescoreField();
 const rescored = [...A._ghostSweep.cells];

 // B: a fresh sweep with the crosshair already there.
 const B = armed();
 B._ghostRoads = [ROAD];
 B._startPinSweep({ x: -140, y: -60 }, 1);
 sweepToEnd(B);
 const fresh = [...B._ghostSweep.cells];

 const same = rescored.length === fresh.length
 && rescored.every((v, i) => (Number.isNaN(v) && Number.isNaN(fresh[i])) || near(v, fresh[i], 1e-9));
 gate('10b. a field rescored against a new road IS what a fresh sweep would measure',
 same, `${rescored.length} cells, cell for cell`);
 gate('10b. …and it really did change — otherwise the test proves nothing',
 beforeMove.some((v, i) => Number.isFinite(v) && !near(v, rescored[i], 1e-6)));
 gate('10b. …without re-running a single world',
 A._ghostSweep.i === A._ghostSweep.order.length && A.ghost.stale === false);
 gate('10b. the winner is re-derived too, not left pointing at the old one',
 A._ghostSweep.field.bestIdx === B._ghostSweep.field.bestIdx,
 `${A._ghostSweep.field.bestIdx} vs ${B._ghostSweep.field.bestIdx}`);
 gate('10b. …and so is the baseline every other cell is graded against',
 near(A._ghostSweep.field.base, B._ghostSweep.field.base, 1e-9));

 // A cell the sweep never reached stays unreached through a rescore — the
 // flags carry that, because a REFUSED cell scores Infinity and would
 // otherwise be indistinguishable from one nobody measured.
 const C = armed();
 C._startPinSweep({ x: -140, y: -60 }, 1);
 for (let i = 0; i < 400 && C._ghostSweep && !C._ghostSweep.done && C._ghostSweep.i < 6; i++) C._pinSweepTick(0.05);
 const reached = C._ghostSweep.i;
 C._ghostRoads = [ROAD];
 C._rescoreField();
 gate('10b. a rescore touches only the cells that were actually measured',
 [...C._ghostSweep.cells].filter((v) => !Number.isNaN(v)).length === reached,
 `${reached} measured, the rest still blank`);
});

// ---------- 9d. sweeping the cargo's own position ----------
//
// The other end of 3b, driven through the real sweep: a cargo pin sweeps the
// place the cargo STARTS, which is a position the player owns and a real thing
// to optimise. It costs the untampered badge, exactly as dragging it by hand
// does — a sweep that quietly did not pay that would be a sweep that cheats.
section('9d', () => {
 const level = flat({
 buildZones: [{ x: -200, y: -120, w: 700, h: 300 }],
 goalObjs: [{ shape: 'ball', x: -200, y: -60, r: 15 }],
 });
 const S = screen(level, []);
 S.ghost = { t: 1.2, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 const start = { ...S.goalPositions[0] };

 const pin = S._designPins().find((p) => Math.hypot(p.x - start.x, p.y - start.y) < 30);
 gate('9d. the cargo offers pins to right-click', !!pin, pin && `${pin.x},${pin.y}`);
 const set = S._pinSetAt(pin);
 gate('9d. …and the set that pin opens is the cargo itself',
 !set.blocked && set.cargo.length === 1 && !set.ends.length && !set.wheels.length);

 S._startPinSweep(pin, 1);
 gate('9d. …so a sweep starts on it', !!S._ghostSweep && !S._ghostSweep.done);
 // A COPY, not the array — `_setGoalPos` writes in place, so holding the
 // reference would let the first click rewrite the origin every later click
 // measures from.
 gate('9d. …remembering where the cargo began, as a COPY it cannot overwrite',
 S._ghostSweep.baseGoals !== S.goalPositions
 && near(S._ghostSweep.baseGoals[0].x, S.goalPositions[0].x));
 sweepToEnd(S);
 const F = S._ghostSweep;
 gate('9d. every cell is measured', [...F.cells].filter((v) => !Number.isNaN(v)).length === F.order.length);

 // …and applying one moves the CARGO, not the machine
 const cell = [...F.cells].map((v, i) => [v, i]).find(([v, i]) => Number.isFinite(v) && v !== Infinity && i !== F.field.originIdx);
 const { ix, iy } = S._cellOffset(F, cell[1]);
 S._applySweepCell(cell[1]);
 gate('9d. applying a cell moves the cargo by exactly what the cell says',
 near(S.goalPositions[0].x, start.x + ix * F.step, 1e-9)
 && near(S.goalPositions[0].y, start.y + iy * F.step, 1e-9),
 `${ix}, ${iy} at ${F.step} px`);
 gate('9d. …and pays the untampered badge for it, as a hand drag does',
 S.goalMoved[0] === true);
 gate('9d. …from where the cargo BEGAN, so a second click does not compound',
 (S._applySweepCell(F.field.originIdx), near(S.goalPositions[0].x, start.x, 1e-12)
 && near(S.goalPositions[0].y, start.y, 1e-12)));

 // A cargo the build zone will not hold is refused outright — every candidate
 // is judged by the rules a cargo DRAG obeys, not by the machine's.
 {
 const tight = flat({
 buildZones: [{ x: -200, y: -60, w: 40, h: 40 }],
 goalObjs: [{ shape: 'ball', x: -200, y: -60, r: 15 }],
 });
 const T = screen(tight, []);
 T.ghost = { t: 0.6, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(T);
 const p = T._designPins()[0];
 gate('9d. the tight cargo has a pin the sweep can start from', !!p);
 if (p) {
 T._startPinSweep(p, 1);
 sweepToEnd(T);
 const refused = [...T._ghostSweep.cells].filter((v) => v === Infinity).length;
 gate('9d. cells that would push the cargo out of the build area are refused',
 refused > 0, `${refused} of ${T._ghostSweep.order.length} refused`);
 }
 }
 // **Outside the build area is hatched even under Free World** (2026-09-02,
 // "The ghost matrix does not rule out outside the build area. That should
 // be grey/slashed out."). Free World opens the BUILD gate so a hand can
 // place out there; the matrix is a search for a machine that SCORES, and
 // `_partEscapes` is the question Play asks when it withholds a score.
 // `_boxInBuildZone` is `freeWorld || strict`, so the sweep used to colour
 // those cells as ordinary physics.
 {
 const tight = flat({
 buildZones: [{ x: 0, y: -40, w: 50, h: 80 }],
 goalObjs: [{ shape: 'ball', x: 400, y: -40, r: 15 }],
 });
 const parts = [{ t: 'wheel', kind: 'free', id: 'w', x: 0, y: -40, r: 20 }];
 const T = screen(tight, parts, { freeWorld: true });
 T.ghost = { t: 0.2, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(T);
 const pin = T._designPins().find((p) => p.isCenter);
 T._startPinSweep(pin, 1);
 sweepToEnd(T);
 const cells = [...T._ghostSweep.cells];
 const k = Math.floor(PIN_GRID_SIDE / 2);
 let rightInf = 0, rightFin = 0;
 for (let iy = -k; iy <= k; iy++) for (let ix = -k; ix <= k; ix++) {
 const v = cells[(iy + k) * PIN_GRID_SIDE + (ix + k)];
 if (ix < 6) continue; // ix=6,7: wheel r20 at x=6 has maxX=26, zone maxX=25
 if (v === Infinity) rightInf++;
 else if (Number.isFinite(v)) rightFin++;
 }
 gate('9d. Free World still hatches matrix cells that leave the build area',
 rightInf > 0 && rightFin === 0,
 `${rightInf} hatched, ${rightFin} scored of the right-hand column`);
 }
});

// ---------- 9c. the field is clickable while it fills ----------
//
// *"Make it clickable while updating."* (2026-08-21). It used to wait for the
// whole grid, which is backwards: the sweep fills in visibly, so the cell you
// want is often bright long before the last one is measured.
//
// **The claim that has to hold is that nothing is disturbed.** Every remaining
// cell is measured from `baseParts` — the build as it was when the sweep opened
// — so moving the pin part-way through cannot change what the rest of the field
// means. This gates it the only way worth gating: run a sweep to the end with a
// click in the middle, and compare it cell for cell with one left alone.
section('9c', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const armed = () => {
 const S = screen(level, parts);
 S.ghost = { t: 1.2, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -140, y: -60 }, 1);
 return S;
 };

 // A: click a measured cell part-way through, then let it finish.
 const A = armed();
 for (let i = 0; i < 400 && A._ghostSweep && !A._ghostSweep.done && A._ghostSweep.i < 12; i++) A._pinSweepTick(0.05);
 const partway = A._ghostSweep.i;
 const pick = [...A._ghostSweep.cells].findIndex((v) => Number.isFinite(v) && v !== Infinity);
 const partsBefore = JSON.stringify(A.design.parts);
 A._applySweepCell(pick);
 gate('9c. a measured cell can be applied while the sweep is still running',
 JSON.stringify(A.design.parts) !== partsBefore && A._ghostSweep.appliedIdx === pick,
 `applied at ${partway} of ${A._ghostSweep.order.length}`);
 gate('9c. …and the sweep keeps going rather than being cancelled by it',
 !!A._ghostSweep && !A._ghostSweep.done);
 sweepToEnd(A);

 // B: the same sweep, left alone.
 const B = armed();
 sweepToEnd(B);

 const a = [...A._ghostSweep.cells], b = [...B._ghostSweep.cells];
 const same = a.length === b.length
 && a.every((v, i) => (Number.isNaN(v) && Number.isNaN(b[i])) || near(v, b[i], 1e-9));
 gate('9c. …and every cell it measures afterwards is what it would have measured anyway',
 same, `${a.length} cells, cell for cell`);
 gate('9c. …because the cells still to come are judged from the build the sweep OPENED on',
 A._ghostSweep.baseParts === B._ghostSweep.baseParts || JSON.stringify(A._ghostSweep.baseParts) === JSON.stringify(B._ghostSweep.baseParts));

 // A cell the sweep has not reached says so, rather than doing nothing.
 const C = armed();
 for (let i = 0; i < 400 && C._ghostSweep && !C._ghostSweep.done && C._ghostSweep.i < 4; i++) C._pinSweepTick(0.05);
 const unmeasured = [...C._ghostSweep.cells].findIndex((v) => Number.isNaN(v));
 const held = JSON.stringify(C.design.parts);
 C._applySweepCell(unmeasured);
 gate('9c. a cell it has not reached YET says so, and moves nothing',
 JSON.stringify(C.design.parts) === held && /not measured yet/i.test(C.toasts.at(-1) || ''),
 C.toasts.at(-1));
});

// ---------- 9e. sweeping a stick's density ----------
//
// *"How about stick density for a tweakable? Right click middle of stick to vary
// weight 1-100 (shown as 10x10)."* (2026-08-21). A different SHAPE of sweep and
// the same idea: a pin has two dimensions and gets a square of positions, a
// weight has one and gets a hundred values, laid out 10×10 because a hundred
// cells in a line is not a picture.
//
// Everything downstream of "what does this cell mean" is shared — the rollout,
// the scoring, the field, the chip, the click — so what is worth gating is that
// the one thing which differs differs correctly, and that nothing else noticed.
section('9e', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 1, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 const rod = S.design.parts[1];

 S._startWeightSweep(rod);
 const F = S._ghostSweep;
 gate('9e. a weight sweep is 100 candidates on a 10×10 field',
 F?.kind === 'weight' && F.side === WEIGHT_GRID_SIDE && F.order.length === 100);
 gate('9e. …one per whole density, the whole range, not the slider’s ladder',
 F.order.map((c) => c.w).sort((a, b) => a - b).join() === weightGrid().join());
 gate('9e. …and it opens on the density the stick already has, as the baseline',
 F.order[0].w === 1 && F.field.originIdx === 0, `starts at ×${F.order[0].w}`);

 sweepToEnd(S);
 gate('9e. every cell is measured', [...F.cells].filter((v) => !Number.isNaN(v)).length === 100);
 gate('9e. …and none of them is refused, because density moves nothing',
 [...F.cells].every((v) => v !== Infinity));

 // the candidate really is the stick at that density, and nothing else moved
 {
 const c = F.order.find((o) => o.w === 42);
 const cand = S._sweepCandidate(F, c);
 gate('9e. a cell is the stick at that density and the machine otherwise untouched',
 cand.parts[1].weight === 42 && cand.parts[0] === F.baseParts[0]
 && cand.parts[1].x1 === F.baseParts[1].x1);
 const one = S._sweepCandidate(F, F.order.find((o) => o.w === 1));
 gate('9e. …and ×1 is stored as ABSENT, the way the slider writes it',
 !('weight' in one.parts[1]));
 }

 // clicking sets it, from the build the sweep opened on
 {
 const pick = F.order.find((o) => o.w === 37);
 S._applySweepCell(pick.idx);
 gate('9e. clicking a cell sets that density', S.design.parts[1].weight === 37);
 gate('9e. …and the geometry is exactly where it was', S.design.parts[1].x1 === parts[1].x1);
 S._applySweepCell(F.order.find((o) => o.w === 12).idx);
 gate('9e. …a second click replaces it rather than compounding', S.design.parts[1].weight === 12);
 S._applySweepCell(F.field.originIdx);
 gate('9e. …and the origin cell puts the stick back to what it was',
 !('weight' in S.design.parts[1]));
 }

 gate('9e. a cell is named by its density, not by an offset it does not have',
 /^×37$/.test(S._cellName(F, F.order.find((o) => o.w === 37).idx)),
 S._cellName(F, F.order.find((o) => o.w === 37).idx));
 gate('9e. …and there is no finer rung to offer, because 100 whole numbers is all of them',
 S._finerStep(F.step) === null);

 // a ROPE sweeps as a rope — the slider writes every link, and so must this
 {
 const R = screen(level, [
 { t: 'rod', kind: 'wood', id: 'a', chain: 'c1', x1: 0, y1: 0, x2: 8, y2: 0 },
 { t: 'rod', kind: 'wood', id: 'b', chain: 'c1', x1: 8, y1: 0, x2: 16, y2: 0 },
 ]);
 R.ghost = { t: 0.5, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(R);
 R._startWeightSweep(R.design.parts[0]);
 const W = R._ghostSweep;
 gate('9e. a rope sweeps every link together, as its own slider writes them',
 W && W.rodIdx.size === 2, `${W?.rodIdx.size} links`);
 const cand = R._sweepCandidate(W, W.order.find((o) => o.w === 60));
 gate('9e. …so a cell is the whole run at that density',
 cand.parts[0].weight === 60 && cand.parts[1].weight === 60);
 }

 // …and a level's own stick is not yours to sweep
 {
 const L = screen({ ...level, fixedParts: [{ t: 'rod', kind: 'wood', id: 'lv', x1: 0, y1: 0, x2: 40, y2: 0 }] }, []);
 L.ghost = { t: 0.5, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(L);
 L._startWeightSweep(L.level.fixedParts[0]);
 gate('9e. a level’s own stick is refused, and says why',
 !L._ghostSweep && /belongs to the level/i.test(L.toasts.at(-1) || ''));
 }
});

// ---------- 9f. hovering a cell previews what it did ----------
//
// *"Is it too much to update the ghosts when you hover the matrix?"*
// (2026-08-21). The expensive half is the machine — nothing stored knows where a
// candidate's wheels ended up, and finding out is a rollout per cell. The half
// that matters is FREE, because a cell already keeps twelve samples of the
// cargo's whole run: that is what a road is scored against, so it had to be
// kept, and it is exactly what a preview wants.
section('9f', () => {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 1.2, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -140, y: -60 }, 1);
 for (let i = 0; i < 400 && S._ghostSweep && !S._ghostSweep.done && S._ghostSweep.i < 8; i++) S._pinSweepTick(0.05);
 const F = S._ghostSweep;

 const measured = [...F.flags].findIndex((f) => f & CELL_MEASURED);
 const run = S._cellRun(F, measured);
 gate('9f. a measured cell hands back the whole run it was scored from',
 Array.isArray(run) && run.length === 12 && run.every((p) => Number.isFinite(p.x)),
 `${run?.length} samples`);
 // …and it is the SAME run the number came from, which is the whole claim: the
 // preview is not an approximation of the cell, it is the cell.
 gate('9f. …and it is exactly the run that cell was scored from',
 near(ghostAimGap(F.goalDefs, [run], F.zones, S._ghostRoads, S._ghostOnly), F.cells[measured], 1e-9),
 `${F.cells[measured].toFixed(2)} px, rebuilt from the samples`);
 const unmeasured = [...F.flags].findIndex((f) => !(f & CELL_MEASURED));
 gate('9f. a cell it has not reached hands back nothing to draw',
 S._cellRun(F, unmeasured) === null);

 // **Free** is the claim, so it is the claim that gets gated: reading a cell
 // costs no rollout and does not disturb the sweep.
 {
 const at = F.i, cells = [...F.cells].filter((v) => !Number.isNaN(v)).length;
 for (let k = 0; k < 50; k++) S._cellRun(F, measured);
 gate('9f. …and reading one costs no rollout and moves the sweep not at all',
 F.i === at && [...F.cells].filter((v) => !Number.isNaN(v)).length === cells);
 }

 // The DEF comes from the sweep, not the ghost's frame, so a preview still
 // draws in the moments after a click when the ghost has been thrown away —
 // which is exactly when you are hovering the next cell to try.
 gate('9f. the cargo it draws is the sweep’s own record, not the ghost’s frame',
 Array.isArray(F.goalDefs) && F.goalDefs.length === F.nGoals && F.nGoals > 0);
 S._ghostDrop();
 gate('9f. …so it survives the ghost being thrown away',
 !S.ghost.shape && !!F.goalDefs[0] && !!S._cellRun(F, measured));
});

// ---------- 10c. the drafted road ----------
//
// *"Can you work out the path the goal piece must take to get to the goal?"* —
// geometrically, yes: `routeField` grows every static obstacle by the cargo's
// own clearance and runs Dijkstra out from the goal, so what comes back is
// distance ALONG the road rather than across the room. It is offered as a draft
// the player edits, because it knows the shape of the level and nothing about
// what a machine can do in it.
section('10c', () => {
 // A wall with one gap in it: the only way from the left to the goal on the
 // right is through the gap, so a route has to find it and a straight line
 // cannot be the answer.
 const walled = {
 terrain: [
 { type: 'box', x: 0, y: 300, w: 1200, h: 60 }, // floor
 { type: 'box', x: 100, y: 120, w: 40, h: 300 }, // wall, bottom half
 { type: 'box', x: 100, y: -320, w: 40, h: 300 }, // wall, top half — gap between
 ],
 props: [], buildZones: [{ x: -300, y: 0, w: 300, h: 300 }],
 goalZones: [{ x: 420, y: 240, w: 100, h: 80 }],
 goalObjs: [{ shape: 'ball', x: -300, y: 240, r: 20 }],
 fixedParts: [], texts: [], pins: [], groups: {}, win: 'goalObj',
 };
 const ball = walled.goalObjs[0];
 const field = routeField(walled, ball, null);
 gate('10c. a field is built over the level, and most of it is reachable',
 !!field && field.reached > field.nx * field.ny * 0.2,
 field ? `${field.nx}x${field.ny} cells at ${field.cell} px, ${field.reached} reachable` : 'no field');
 const dGoal = routeDistanceAt(field, 420, 240);
 const dStart = routeDistanceAt(field, -300, 240);
 gate('10c. the goal is zero road from the goal', dGoal < field.cell * 2, `${dGoal.toFixed(0)} px`);
 gate('10c. …and the cargo is further by ROAD than by crow, because the wall is in the way',
 dStart > 720 * 1.15, `${dStart.toFixed(0)} px of road against a 720 px straight line`);
 const line = routePath(field, -300, 240);
 {
 const end = line[line.length - 1] || {};
 const z = walled.goalZones[0];
 gate('10c. the road itself comes back as a polyline that ends INSIDE the goal zone',
 line.length > 2 && Math.abs(end.x - z.x) <= z.w / 2 + field.cell && Math.abs(end.y - z.y) <= z.h / 2 + field.cell,
 `${line.length} points, ending ${Math.round(end.x)},${Math.round(end.y)}`);
 }
 gate('10c. …and it goes through the GAP rather than through the wall',
 line.some((p) => p.y < 0), `highest point y=${Math.min(...line.map((p) => p.y)).toFixed(0)}`);
 const draft = simplifyPath(line);
 gate('10c. …thinned to corners a player could actually drag',
 draft.length >= 2 && draft.length <= 10, `${line.length} points to ${draft.length} corners`);

 // A cargo too fat for the gap has no route at all, and the caller is told
 // rather than handed a wrong number.
 const fat = { shape: 'ball', x: -300, y: 240, r: 190 };
 const fatField = routeField({ ...walled, goalObjs: [fat] }, fat, null);
 gate('10c. a cargo that cannot fit through the gap has no route, and says so',
 !(routeDistanceAt(fatField, -300, 240) < Infinity));
 gate('10c. clearance is the cargo’s own size — a ball’s radius, a box’s narrowest half',
 cargoClearance({ shape: 'ball', r: 20 }) === 20
 && cargoClearance({ shape: 'box', w: 80, h: 20 }) === 10);

 // Ghost lines are not walls to a box, so a route for a crate goes through one
 // — the same rule the editor and the physics use (verify-fcworld gate 5).
 {
 const withLine = { ...walled, terrain: [...walled.terrain, { type: 'box', x: 0, y: 200, w: 1200, h: 8, line: 'h' }] };
 const crate = { shape: 'box', x: -300, y: 240, w: 30, h: 30 };
 const f = routeField(withLine, crate, null);
 gate('10c. a ghost line does not wall a route off for a crate, because it does not stop one',
 routeDistanceAt(f, -300, 240) < Infinity);
 }
});

// ---------- 10d. the roads ride the undo stack ----------
//
// *"Can we add Cargo route corners to the Undo/Redo list?"* (2026-08-21). A road
// is drawn corner by corner and dragged into shape, which is editing — and an
// editing gesture with no way back was the only kind this editor had.
//
// **The catch is that undo restores a MOMENT, not a change.** The roads have to
// be in every snapshot, not only the ones a road edit takes: a snapshot that
// omitted them would have undoing a stick change wipe a road drawn after it.
section('10d', () => {
 const S = screen(flat(), [{ t: 'rod', kind: 'wood', id: 'r', x1: -200, y1: -40, x2: -120, y2: -40 }]);
 S._commit = GameScreen.prototype._commit; // the real one: pushUndo + autosave + updateStats
 S._pushUndo = GameScreen.prototype._pushUndo;
 S._snapshotUndo = GameScreen.prototype._snapshotUndo;
 S._restore = GameScreen.prototype._restore;
 S.undoStack = []; S.redoStack = [];
 S._pushUndo(); // the constructor's baseline
 S._tape = null;
 S._toggleGhostRun();

 S._ghostAddWaypoint({ x: -300, y: -100 });
 S._ghostAddWaypoint({ x: -100, y: -160 });
 gate('10d. two corners drawn', S._ghostRoads[0].pts.length === 2);
 S.undo();
 gate('10d. undo takes the last corner back', S._ghostRoads[0]?.pts.length === 1,
 `${S._ghostRoads[0]?.pts.length ?? 0} corners`);
 S.undo();
 gate('10d. …and again takes the road away entirely', S._ghostRoads.length === 0);
 S.redo();
 gate('10d. redo puts it back', S._ghostRoads.length === 1 && S._ghostRoads[0].pts.length === 1);
 S.redo();
 gate('10d. …corner by corner', S._ghostRoads[0].pts.length === 2);

 // **A machine edit must not take the roads with it.** This is the whole
 // reason the roads go in every snapshot rather than in road snapshots only.
 const roadsNow = JSON.stringify(S._ghostRoads);
 S.design.parts.push({ t: 'rod', kind: 'wood', id: 'r2', x1: -300, y1: 0, x2: -240, y2: 0 });
 S._commit();
 gate('10d. a machine edit leaves the roads alone', JSON.stringify(S._ghostRoads) === roadsNow);
 S.undo();
 gate('10d. …and undoing it takes back the STICK, not the road',
 S.design.parts.length === 1 && JSON.stringify(S._ghostRoads) === roadsNow);

 // dragging a corner is one step, not one per pointermove
 const before = S.undoStack.length;
 S._ghostAimMove({ x: -90, y: -150 }, {}, { pi: 0, k: 1 });
 S._ghostAimMove({ x: -80, y: -140 }, {}, { pi: 0, k: 1 });
 S._ghostAimDrop();
 gate('10d. a drag is ONE step, however many moves it took',
 S.undoStack.length === before + 1, `${S.undoStack.length - before} pushed`);
 S.undo();
 gate('10d. …and it goes back where it was', near(S._ghostRoads[0].pts[1].x, -100));
 // …and a press that moved nothing spends nothing
 const idle = S.undoStack.length;
 S._ghostAimDrop();
 gate('10d. a press that moved nothing spends no undo slot', S.undoStack.length === idle);

 // clearing, and judging one cargo, are moments too
 S._ghostClearPaths();
 gate('10d. clearing the roads is undoable', S._ghostRoads.length === 0);
 S.undo();
 gate('10d. …so they come back', S._ghostRoads.length === 1);
});

// ---------- 10e. a delivery is gold, graded on speed ----------
//
// *"If 'Delivered' a gold dot in the middle of the matrix? … Or maybe the whole
// cell gold graded on speed?"* (2026-08-21) — the second, and it is free: the
// win flag and the win TIME are already stored per cell, so this is a fill
// rather than a rollout.
//
// The reason it is worth having: green grades on DISTANCE, and every winner has
// reduced that to zero. A dozen delivering positions came out identically
// bright, and the question you actually have next is which delivers soonest.
section('10e', () => {
 const level = flat({ goalZones: [{ x: -60, y: -52, w: 200, h: 104 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -300, y: -40, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -300, y1: -40, x2: -240, y2: -40 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 3, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -240, y: -40 }, 1);
 sweepToEnd(S);
 const F = S._ghostSweep;

 gate('10e. the field carries the LIVE flag and time arrays, not copies of them',
 F.field.flags === F.flags && F.field.winTimes === F.winTimes);
 const won = [...F.flags].map((f, i) => [f, i]).filter(([f]) => f & CELL_WON).map(([, i]) => i);
 // **A delivery is a fact from the SIM, not a reading of the samples.** The
 // twelve samples a cell keeps are thinned from the run, so a cargo can be
 // wholly inside the zone on a step that is not one of them and still show a
 // gap above zero — which is exactly why the flag exists and why the field
 // paints on it rather than on `cells[i] === 0`.
 gate('10e. …so a cell that DELIVERED can be told from one that merely got close',
 won.length > 0 && won.every((i) => F.flags[i] & CELL_MEASURED),
 `${won.length} of ${F.order.length} delivered`);
 gate('10e. …and it is NOT the same thing as a zero distance, which is why the flag exists',
 won.some((i) => F.cells[i] > 0) || won.every((i) => F.cells[i] === 0),
 `${won.filter((i) => F.cells[i] > 0).length} winners whose sampled gap is above zero`);
 if (won.length) {
 gate('10e. every winner carries the time it delivered at, which is what grades it',
 won.every((i) => Number.isFinite(F.winTimes[i]) && F.winTimes[i] <= F.t + 1e-6));
 // …and the ordering already prefers the SOONEST of them, which is the same
 // question the gold answers by eye
 const fastest = won.reduce((a, b) => (F.winTimes[b] < F.winTimes[a] ? b : a));
 gate('10e. …and the cell the sweep picks is the fastest of them',
 F.field.bestIdx != null && near(F.winTimes[F.field.bestIdx], F.winTimes[fastest], 1e-6),
 `${F.winTimes[F.field.bestIdx]?.toFixed(2)}s picked, fastest ${F.winTimes[fastest].toFixed(2)}s`);
 gate('10e. a delivered cell reads as a TIME, not as the 0 px it is by definition',
 (F.field.hoverIdx = fastest, /DELIVERS at /.test(S._sweepReadout(F))), S._sweepReadout(F));
 } else {
 gate('10e. (this fixture delivered nothing — the grading has nothing to show)', false,
 'fixture needs a machine that wins');
 }
});

// ---------- 10f. the odds a hand would have found it ----------
//
// *"Add a probability to Ghost Chip, based on zoom factor and number of cells
// equal or better than chosen one. But starting at 0.1px … they picked the only
// Gold on the entire screen. Probability 1:225 … Same situation at 0.01px …
// 1:50625 … If there are, say, 15 spots that are equal or better at 0.1 px then
// it would be 15:225 === 1:15. Then throw in a time guess for efficient human
// finding that."* (2026-08-22)
//
// Two of the three worked examples ARE the specification and are gated as they
// were written, arithmetic and all. The third — 1:50625 at the hundredth-px
// rung — was withdrawn the same day (*"I think it is unlikely to be
// mathematically sound at other scales"*), so what is gated there is silence.
//
// Four rounds in one day, and each one narrowed the claim: the ladder went, the
// speed tiebreak went, fields with no solve in them went, and the run stopped
// being the machine's cost and became the aim at 1×. What is left is a count of
// the cells on screen and an upper bound on working through them.
section('10f', () => {
 const cells = PIN_GRID_SIDE * PIN_GRID_SIDE;
 // **One rung, and it is 0.1 px** (2026-08-22: *"I think let's only give
 // probability for 0.1px. I think it is unlikely to be mathematically sound at
 // other scales. Dubious at 0.1px, but at least fun."*). The 225² that used to
 // stand at the fine rung was a story about how somebody searches — sweep
 // coarse, click the winner, sweep fine — and that story assumes the coarse
 // winner is the box the fine answer lives in, which is the one thing a
 // fractal boundary will not promise.
 gate('10f. the tenth-of-a-pixel rung is the only one that gets a number',
 sweepOddsShown('pin', 0.1) && SWEEP_ODDS_STEP === 0.1 && NUDGE_STEPS.includes(SWEEP_ODDS_STEP));
 gate('10f. …not whole pixels, where a hand is aiming rather than guessing',
 !sweepOddsShown('pin', 1));
 gate('10f. …and not hundredths, where the box is one nobody navigated to',
 !sweepOddsShown('pin', 0.01));
 gate('10f. …nor a density sweep, though that is the shape that would be exactly sound',
 !sweepOddsShown('weight', 1) && WEIGHT_GRID_SIDE * WEIGHT_GRID_SIDE === 100);
 gate('10f. …and nothing survives a rung that is not on the ladder at all',
 !sweepOddsShown('pin', 0.5) && !sweepOddsShown('pin', 0) && !sweepOddsShown('pin', undefined));

 gate('10f. the only gold on the screen is 1 in 225 — the count over the box, and only that',
 sweepTrials(cells, 1) === 225);
 gate('10f. …and fifteen spots as good as it is 15:225, which is 1 in 15',
 sweepTrials(cells, 15) === 15);
 gate('10f. a cell can never be luckier than the one place it is, so the count includes it',
 sweepTrials(cells, 0) === 225 && sweepTrials(cells, cells) === 1);

 // **The time is two guesses and the aim**, and the aim is the whole of it on
 // any sweep worth taking: watched at 1×, a 70 s aim is 97% of the trial.
 gate('10f. a hand trial is the two human numbers plus the run, at normal speed',
 near(handTrialSeconds(0), HAND_NUDGE_S + HAND_JUDGE_S)
 && near(handTrialSeconds(70), HAND_NUDGE_S + HAND_JUDGE_S + 70),
 `${handTrialSeconds(0)}s on nothing, ${handTrialSeconds(70)}s on a 70 s aim`);
 gate('10f. …so a longer aim costs more to search by hand, which is the point of saying it',
 handSearchSeconds(225, 70) > 10 * handSearchSeconds(225, 2),
 `${fmtSpan(handSearchSeconds(225, 70))} at a 70 s aim vs ${fmtSpan(handSearchSeconds(225, 2))} at 2 s`);
 // **An UPPER bound, and deliberately** (*"So we have an upper bound"*). MAX
 // playback exists, so a hand that used it would spend a fraction of this —
 // the figure is the one that cannot be accused of flattering the sweep.
 gate('10f. …and it is an upper bound: MAX playback would take the run out of it',
 handSearchSeconds(225, 70) > 30 * handSearchSeconds(225, 0.12),
 `${fmtSpan(handSearchSeconds(225, 70))} at 1× vs ${fmtSpan(handSearchSeconds(225, 0.12))} at the rollout's own cost`);
 // The whole reachable range of the line, now that 225 is the largest number it
 // can print: a short aim is twenty minutes of nudging, the ceiling is a day's
 // work, and the field that raised all this sits between them.
 gate('10f. a whole box at a 4 s aim is twenty minutes, and at the 100 s ceiling it is hours',
 /min$/.test(fmtSpan(handSearchSeconds(225, 4))) && /h$/.test(fmtSpan(handSearchSeconds(225, 100))),
 `${fmtSpan(handSearchSeconds(225, 4))} · ${fmtSpan(handSearchSeconds(225, 100))}`);
 gate('10f. …and at the 70 s aim that raised the question, five hours',
 /h$/.test(fmtSpan(handSearchSeconds(225, 70))), fmtSpan(handSearchSeconds(225, 70)));

 // A span is one unit, and every band starts at two of itself — so the only 1
 // the ladder can print is one second, and "1 days" cannot happen.
 gate('10f. a span never says "1" of anything but seconds',
 Array.from({ length: 4000 }, (_, i) => fmtSpan(1.7 ** (i / 100)))
 .every((s) => !/^1 (min|h|days|years)$/.test(s)));
 gate('10f. …and nothing at all for nothing at all', fmtSpan(0) === '' && fmtSpan(NaN) === '' && fmtSpan(-5) === '');
 gate('10f. …and it climbs through every band it has', [
 [1, /s$/], [600, /min$/], [7200, /h$/], [86400 * 5, /days$/], [86400 * 4000, /years$/],
 ].every(([s, re]) => re.test(fmtSpan(s))), [1, 600, 7200, 86400 * 5, 86400 * 4000].map(fmtSpan).join(' · '));
 // 225 needs no comma, but this grid has been 32×32 and 21×21 before now, and
 // a four-figure count is a number nobody reads ungrouped.
 gate('10f. a four-figure count would still be grouped, whatever the grid becomes',
 fmtCount(1024) === '1,024' && fmtCount(225) === '225');

 // ---------- and over a REAL field, where "equal or better" has to mean it ----------
 //
 // The 10e fixture, because it DELIVERS: gold cells are the only ones that tie
 // in practice — a distance is a float and two of them are never equal — so
 // this is where the count is worth checking against something.
 const level = flat({ goalZones: [{ x: -60, y: -52, w: 200, h: 104 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -300, y: -40, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -300, y1: -40, x2: -240, y2: -40 },
 ];
 const S = screen(level, parts);
 S.ghost = { t: 3, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(S);
 S._startPinSweep({ x: -240, y: -40 }, 0.1);
 sweepToEnd(S);
 const F = S._ghostSweep;
 const golds = [...F.flags].map((f, i) => [f, i]).filter(([f]) => f & CELL_WON).map(([, i]) => i);
 const oddsAt = (idx) => { F.field.hoverIdx = idx; return S._sweepOdds(F); };

 const oddsNum = (s) => parseFloat((/1 in ([\d,]+)/.exec(s)?.[1] || 'x').replace(/,/g, ''));

 // **A delivery is a delivery** (2026-08-22: *"I feel this should be at least
 // 2:225? There is a better option that was not picked. So at least 2 options
 // on the screen?"*). `ghostBetter` breaks winner ties on SPEED, which made
 // every field's starred cell unique and every delivery 1 in 225 — the odds
 // count what a hand would have accepted, and a hand hunting a delivery stops
 // at the first one.
 const V = (o) => ({ invalid: false, won: false, lost: false, winTime: Infinity, gap: 100, ...o });
 const gold = (t) => V({ won: true, winTime: t, gap: 0 });
 gate('10f. two deliveries at different times are each other\'s equals here',
 oddsAsGood(gold(1), gold(9)) && oddsAsGood(gold(9), gold(1)));
 gate('10f. …though the FIELD still ranks them, which is what picks the star',
 ghostBetter(gold(1), gold(9)) && !ghostBetter(gold(9), gold(1)));
 gate('10f. …and every other rank is untouched: a delivery over a near miss…',
 oddsAsGood(V({ gap: 4 }), gold(50)) && !oddsAsGood(gold(50), V({ gap: 4 })));
 gate('10f. …a legal cell over one the editor refused…',
 !oddsAsGood(V({ gap: 400 }), V({ invalid: true, gap: 0 })));
 gate('10f. …a cargo kept over a cargo lost, and nearer over further',
 !oddsAsGood(V({ gap: 400 }), V({ lost: true, gap: 0 }))
 && oddsAsGood(V({ gap: 400 }), V({ gap: 4 })) && !oddsAsGood(V({ gap: 4 }), V({ gap: 400 })));

 // This fixture delivers from all 225 cells of a 1.5 px box — a neighbourhood
 // that works everywhere, which is the no-luck case however fast any one of
 // them is.
 gate('10f. the fixture delivers from every cell it swept, which is the no-luck case',
 golds.length === F.order.length, `${golds.length} gold of ${F.order.length}`);
 const slowestAll = golds.reduce((a, b) => (F.winTimes[b] > F.winTimes[a] ? b : a));
 gate('10f. …so the last of them to arrive claims no luck',
 /^225 of 225 as good$/.test(oddsAt(slowestAll).text), oddsAt(slowestAll).text);
 gate('10f. …and the SOONEST says the same, which is the correction of 2026-08-22',
 /^225 of 225 as good$/.test(oddsAt(F.field.bestIdx).text), oddsAt(F.field.bestIdx).text);
 gate('10f. …and says why, since the gold ramp beside it is still grading them',
 /deliver, as this one does/.test(oddsAt(F.field.bestIdx).why));

 // **His worked example, forced onto a real field**: fifteen deliveries left
 // standing out of 225. Forced rather than found, because a machine that
 // delivers from exactly fifteen 0.1 px offsets is not something a fixture can
 // ask for — but the RANKING being tested is the real one, over real rollouts.
 const keep = golds.slice(0, 15);
 for (const i of golds.slice(15)) F.flags[i] &= ~CELL_WON;
 const slowestKept = keep.reduce((a, b) => (F.winTimes[b] > F.winTimes[a] ? b : a));
 const fastestKept = keep.reduce((a, b) => (F.winTimes[b] < F.winTimes[a] ? b : a));
 gate('10f. fifteen deliveries in a 0.1 px field are 15:225, which is 1 in 15',
 keep.every((i) => /^1 in 15 · /.test(oddsAt(i).text)), oddsAt(slowestKept).text);
 gate('10f. …the fastest of them included, however much sooner it got there',
 /^1 in 15 · /.test(oddsAt(fastestKept).text),
 `${F.winTimes[fastestKept].toFixed(2)}s vs ${F.winTimes[slowestKept].toFixed(2)}s → ${oddsAt(fastestKept).text}`);
 // A cell that only got close is worse than every delivery, so its count is at
 // least all fifteen of them and its odds no better than 1 in 15 — never fewer,
 // never luckier.
 const missed = [...F.flags].findIndex((f) => (f & CELL_MEASURED) && !(f & CELL_WON) && !(f & CELL_INVALID));
 gate('10f. …while a cell that only got close is never rated luckier than a delivery',
 missed >= 0 && (oddsNum(oddsAt(missed).text) <= 15 || /as good/.test(oddsAt(missed).text)),
 oddsAt(missed).text);

 // **No solve on screen, no line** (2026-08-22: *"I guess ranking only really
 // matters when a solve is on screen. Apart from that no need to provide odds
 // and time estimate."*). Two distances never tie, so on a field that delivers
 // from nowhere the best cell is unique by a decimal and every one of them
 // would read 1 in 225 — an impressive number for being three px nearer than
 // its neighbour. The same field, its deliveries taken away, has to go quiet.
 const wasBest = oddsAt(F.field.bestIdx).text;
 for (const i of keep) F.flags[i] &= ~CELL_WON;
 gate('10f. a field that delivers from nowhere carries no odds and no time',
 S._sweepOdds(F) === null, `was "${wasBest}"`);
 for (const i of golds) F.flags[i] |= CELL_WON;
 gate('10f. …and it comes back the moment a delivery does',
 /^1 in |as good$/.test(S._sweepOdds(F)?.text || ''), S._sweepOdds(F)?.text);
 // **A refusal ranks below everything, so it is never anybody's equal.** Forced
 // rather than found: a field that happens to contain no illegal cell would
 // pass this by not testing it.
 const legal = [...F.flags].findIndex((f) => (f & CELL_MEASURED) && !(f & CELL_INVALID));
 const victim = [...F.flags].map((f, i) => [f, i]).filter(([f, i]) => (f & CELL_MEASURED) && !(f & CELL_INVALID) && i !== legal)[0]?.[1];
 if (legal >= 0 && victim != null) {
 const before = oddsAt(legal).text;
 F.flags[victim] |= CELL_INVALID;
 const after = oddsAt(legal).text;
 gate('10f. an editor-refused cell is nobody\'s equal, so it drops out of the count',
 before !== after || /as good/.test(before), `${before} → ${after}`);
 gate('10f. …and a refused cell has no odds of its own — the question is meaningless',
 (F.field.hoverIdx = victim, S._sweepOdds(F) === null));
 F.flags[victim] &= ~CELL_INVALID;
 }
 gate('10f. a cell nobody measured has no odds either',
 (F.field.hoverIdx = null, F.field.bestIdx != null)
 && ((F.flags[F.field.bestIdx] &= ~CELL_MEASURED), S._sweepOdds(F) === null));

 // …and the other two rungs, over real fields that DO deliver — so what
 // silences them is the rung and nothing else.
 for (const step of [1, 0.01]) {
 const P = screen(level, parts);
 P.ghost = { t: 3, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(P);
 P._startPinSweep({ x: -240, y: -40 }, step);
 sweepToEnd(P);
 const W = P._ghostSweep;
 const won = [...W.flags].filter((f) => f & CELL_WON).length;
 gate(`10f. a ${step} px field delivers and still says nothing — the rung is the whole rule`,
 won > 0 && P._sweepOdds(W) === null, `${won} gold of ${W.order.length}, odds ${P._sweepOdds(W)}`);
 }

 // The chip has to make ROOM for the line, which is the bug the scale's own
 // tick left behind three weeks running: a budget that does not know about new
 // chrome is a chip that runs past the bottom of a short window.
 const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
 // The row's min-height is FLOORED since the type floor reached the chip
 // (2026-08-23, verify-editor gate 97): max(--hud-type-min × 1.25, 14px ×
 // scale). The 14 is parsed from inside the max(), and the budget carries a
 // named 4px for the floored line box — five rows × 0.675px, rounded up;
 // util.js's SWEEP_CHIP_CHROME comment says why.
 const rowPx = +(/\.sweep-title,\s*\.sweep-read\s*\{[^}]*min-height:\s*max\(calc\(var\(--hud-type-min\) \* 1\.25\), calc\((\d+)px/.exec(css)?.[1]);
 const gapPx = +(/\.sweep-inner\s*\{[^}]*gap:\s*calc\((\d+)px/.exec(css)?.[1]);
 const FLOOR_PAD = 4;
 gate('10f. the odds line is styled as one more `.sweep-read`, so its cost is that class\'s',
 /\.sweep-odds\s*\{/.test(css) && rowPx === 14 && gapPx === 4, `${rowPx}px row, ${gapPx}px gap`);
 gate('10f. …and the chip\'s chrome budget grew by exactly that much, plus the floor\'s pad',
 SWEEP_CHIP_CHROME === 108 + rowPx + gapPx + FLOOR_PAD,
 `${SWEEP_CHIP_CHROME} = 108 + ${rowPx} + ${gapPx} + ${FLOOR_PAD}`);
 gate('10f. …so a short window still shrinks the graph rather than the chip overrunning it',
 sweepChipSize(1920, 320) < sweepChipSize(1920, 1080));

 // **The gold ramp ran backwards for a day** (2026-08-22). The field paints its
 // FASTEST delivery deepest, and the strip carried the same two golds in the
 // other order — `to left` puts the first stop at the RIGHT edge — so the scale
 // said the pale cells were the quick ones and a starred cell looked like the
 // wrong pick. The two are computed from one formula here so they cannot part
 // company again: the deep end of the strip has to be the colour the field
 // gives a delivery at f = 1, and it has to sit under the FAST label, which is
 // the left one (`sweepWinFast` is appended first).
 const rjs = fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8');
 const fm = /rgb\(\$\{Math\.round\((\d+) - (\d+) \* f\)\},\$\{Math\.round\((\d+) - (\d+) \* f\)\},\$\{Math\.round\((\d+) - (\d+) \* f\)\}\)/.exec(rjs);
 const goldAt = (f) => fm && `rgb(${fm[1] - fm[2] * f},${fm[3] - fm[4] * f},${fm[5] - fm[6] * f})`;
 const ramp = /\.sweep-win-scale \.sweep-ramp\s*\{\s*background:\s*linear-gradient\(to (\w+),\s*(rgb\([\d,]+\)),\s*(rgb\([\d,]+\))\)/.exec(css.replace(/\s+/g, ' '));
 const leftEnd = ramp && (ramp[1] === 'right' ? ramp[2] : ramp[3]);
 gate('10f. the field\'s gold is still a ramp from one formula, so the strip can be checked against it',
 !!fm && !!ramp, fm ? `${goldAt(1)} … ${goldAt(0)}` : 'formula not found');
 gate('10f. …and the strip\'s FAST end is the colour a fast delivery is painted',
 leftEnd === goldAt(1), `${ramp?.[1]} → left end ${leftEnd}, fastest cell ${goldAt(1)}`);
 gate('10f. …with the slow end at the other one, so the two really are its ends',
 (ramp?.[1] === 'right' ? ramp[3] : ramp?.[2]) === goldAt(0));
});

// ---------- 11. what it looks like ----------
section('11', () => {
 // **The mechanism changed; the intent did not** (amended 2026-08-23). These
 // three asserted an alpha ORDER — machine under the present, cargo over the
 // machine, trace under both — because alpha was how the future was drawn.
 // It is now drawn HOLLOW instead, for a measured reason: compositing is
 // linear, so at 0.42 every colour difference was multiplied by 0.42, and
 // the weakest pair in the functional set (an L wheel against an F wheel)
 // fell from 133 RGB units over skyTop to 56. The constants remain for the
 // trace, which still fades.
 //
 // So the same intent is now asserted against the DRAWING: a ghosted piece
 // must not fill its body, and must still stroke it.
 {
 const rec = () => {
 const c = { fills: 0, strokes: 0, alphas: [], widths: [] };
 const h = {
 get: (_, k) => {
 if (k === 'canvas') return { width: 8, height: 8 };
 if (k === 'createPattern') return () => ({ setTransform() {} });
 if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
 if (typeof k === 'symbol') return undefined;
 if (k === 'fill') return () => { c.fills++; };
 if (k === 'stroke') return () => { c.strokes++; };
 return () => {};
 },
 set: (_, k, v) => {
 if (k === 'globalAlpha') c.alphas.push(v);
 if (k === 'lineWidth') c.widths.push(v);
 return true;
 },
 };
 return [new Proxy({}, h), c];
 };
 const draw = (fn) => { const [p, c] = rec(); fn(p); return c; };
 const wheelSolid = draw((p) => drawWheel(p, { t: 'wheel', kind: 'cw', r: 20, x: 0, y: 0 }, { x: 0, y: 0, angle: 0 }, {}));
 const wheelGhost = draw((p) => drawWheel(p, { t: 'wheel', kind: 'cw', r: 20, x: 0, y: 0 }, { x: 0, y: 0, angle: 0 }, { ghost: true }));
 const cargoGhost = draw((p) => drawGoalPiece(p, { t: 'goal', shape: 'ball', x: 0, y: 0, r: 15, density: 1 }, null, { ghost: true }));
 gate('11. a ghosted wheel is HOLLOW — it strokes its outline and fills no body',
 wheelGhost.fills === 0 && wheelGhost.strokes > 0,
 `${wheelGhost.fills} fills, ${wheelGhost.strokes} strokes (solid: ${wheelSolid.fills} fills)`);
 gate('11. …while the solid one it predicts is filled, so the two never read alike',
 wheelSolid.fills > 0, `${wheelSolid.fills} fills`);
 // With everything hollow, LINE WEIGHT is what says which mark matters.
 // Counting strokes does not: a wheel has more rings to draw than a ball
 // has, which says nothing about which one you are meant to look at. The
 // first version of this gate counted them and failed for that reason.
 const heaviest = (c) => Math.max(...c.widths.filter((v) => typeof v === 'number'));
 gate('11. …and the ghost CARGO is hollow too, and drawn HEAVIER than the machine',
 cargoGhost.fills === 0 && heaviest(cargoGhost) > heaviest(wheelGhost),
 `cargo ${heaviest(cargoGhost)} px, wheel ${heaviest(wheelGhost)} px`);
 gate('11. …at FULL strength, because hollow throws away area and not hue',
 !wheelGhost.alphas.some((v) => typeof v === 'number' && v > 0 && v < 0.5),
 `alphas ${[...new Set(wheelGhost.alphas)].join(' ')}`);
 }
 gate('11. …and the trace images stay fainter than the piece, so the road is not the answer',
 GHOST_TRACE_ALPHA < GHOST_CARGO_ALPHA);

 // **At least 128, up to a fifth of the screen** (2026-08-21, on request).
 gate('11. the graph is up to a fifth of the screen, and never past it',
 [1280, 1920, 2560].every((w) => sweepChipSize(w, 1080) <= w * SWEEP_CHIP_VW + 0.001)
 && sweepChipSize(1920, 1080) > sweepChipSize(1280, 1080),
 `1280→${sweepChipSize(1280, 1080)}, 1920→${sweepChipSize(1920, 1080)}`);
 gate('11. …with a floor of at least 128, so a narrow window still gets a readable cell',
 [320, 400, 640].every((w) => sweepChipSize(w, 1080) >= SWEEP_CHIP_MIN),
 `640→${sweepChipSize(640, 1080)}`);
 gate('11. …and it never grows past the window it has to fit in',
 sweepChipSize(1920, 320) < sweepChipSize(1920, 1080), `${sweepChipSize(1920, 320)} in a short window`);
 // Whole pixels per cell, because the canvas renders `pixelated` and a cell
 // straddling a fractional boundary is the one thing that mode exists to stop.
 // **Both field shapes, at every size.** A cell has to be a whole number of
 // pixels or the `pixelated` rendering smears it across a boundary — and now
 // the grid lines have to land on whole pixels too, or a 1 px line becomes a
 // 2 px smear. One unit (their LCM) buys both, for both matrices.
 gate('11. every size gives a WHOLE number of pixels per cell, in both matrices',
 [320, 400, 640, 900, 1280, 1440, 1920, 2560, 3840].every((w) => {
 const px = sweepChipSize(w, 1080);
 return px % PIN_GRID_SIDE === 0 && px % WEIGHT_GRID_SIDE === 0;
 }));
 // …and the width cannot depend on the shape, because the shape is not asked:
 // the chip sizes itself from the viewport alone and both matrices fit it.
 gate('11. …and the chip never asks what SHAPE the field is, so it cannot resize for one',
 !/sweepChipSize\([^)]*,[^)]*,/.test(fs.readFileSync(path.join(root, 'public/js/game.js'), 'utf8')));
 // A major line has to mean the same thing on both, or it means nothing.
 gate('11. the heavier grid line divides both field shapes, so it says one thing',
 PIN_GRID_SIDE % SWEEP_GRID_MAJOR === 0 && WEIGHT_GRID_SIDE % SWEEP_GRID_MAJOR === 0,
 `every ${SWEEP_GRID_MAJOR}: ${PIN_GRID_SIDE / SWEEP_GRID_MAJOR} blocks on a pin field, ${WEIGHT_GRID_SIDE / SWEEP_GRID_MAJOR} on a weight one`);
 gate('11. a viewport of nothing still asks for something drawable',
 sweepChipSize(0, 0) >= PIN_GRID_SIDE && sweepChipSize(NaN, NaN) >= PIN_GRID_SIDE);

 // **A refused cell is hatched, not merely tinted** (2026-08-23, on report:
 // "Ghost Matrix needs different colour for out of bounds cells. Currently
 // blends with the white cells too closely."). Measured: the old 0.22 slate
 // wash composited to within 3 luma of the palest rung of BOTH ramps, so no
 // alpha fixes it — brightness belongs to the ramps, and "not a place at all"
 // has to speak in a different channel. This drives the real drawSweepField
 // through a recording context and counts the diagonals.
 {
 const side = 4;
 const cells = new Float64Array(side * side).fill(50);
 cells[0] = Infinity; cells[5] = Infinity; cells[15] = Infinity;
 const calls = [];
 let stroke = null;
 const ctx = new Proxy({}, {
 get: (t, k) => (k === 'canvas' ? { width: 64, height: 64 }
 : (...a) => { calls.push({ k, a, stroke }); return undefined; }),
 set: (t, k, v) => { if (k === 'strokeStyle') stroke = v; return true; },
 });
 drawSweepField(ctx, { side, cells, base: 100, best: 0 }, 64, {});
 // one diagonal per refused cell, drawn corner to corner, in its own stroke
 // colour — not the grid's
 const moves = calls.filter((c) => c.k === 'moveTo');
 const diag = calls.filter((c, i) => c.k === 'lineTo'
 && calls[i - 1]?.k === 'moveTo'
 && Math.abs(c.a[0] - calls[i - 1].a[0]) === Math.abs(c.a[1] - calls[i - 1].a[1])
 && Math.abs(c.a[0] - calls[i - 1].a[0]) === 16);
 gate('11h. every refused cell gets a corner-to-corner hatch stroke',
 diag.length === 3, diag.length + ' diagonals for 3 refused cells');
 gate('11h. …in a stroke of its own, distinct from the grid lines',
 diag.every((d) => /rgba\(84,99,120/.test(d.stroke))
 && calls.some((c) => c.k === 'stroke' && /rgba\(35,42,53/.test(c.stroke)),
 diag[0]?.stroke);
 // and the tint alone no longer tries to carry the meaning: it darkened,
 // but the HATCH is the message — remove it and this pair fails
 const fills = calls.filter((c) => c.k === 'fillRect' && /120,140,165/.test(c.stroke ?? ''));
 gate('11h. …and the fill under it stepped up from the 0.22 that vanished',
 /0\.30/.test(fs.readFileSync(path.join(root, 'public/js/render.js'), 'utf8')
 .match(/v === Infinity\) fill = '([^']+)'/)?.[1] || ''),
 'the wash is the paper, the hatch is the word');
 }
});

// ---------- 12. the button itself ----------
//
// **Both halves of "pressing the ghost does nothing, and it has no icon"**
// (2026-08-21, reported the day it shipped). Two separate faults with one
// shape: a control that cannot answer.
//
// * it was `disabled` until a run had been recorded, which is exactly the
// state a new player finds it in — and `:disabled` is 35% opacity, so the
// one thing that could have explained it went pale at the same moment.
// * its `padding: 0` was written as `.ghost-run` (0-1-0) against `.btn.tiny`
// and `:where(.toolbar-wrap) .btn.tiny` (both 0-2-0), so it never applied.
// At 22 px wide that left a 3.2 px content box and flex crushed the glyph
// to a 1.2 px sliver.
//
// The second one is the interesting gate, because **a single-class override
// that can never win looks completely right in the file** — the memory of this
// project already says "prove the rule PARSED", and parsing was never the
// problem here. So this resolves the cascade the way a browser would and asks
// which rule actually WINS. `.snap-btn`/`.free-world` above have the identical
// flaw and get away with it on width alone; if either is ever narrowed, this is
// the check that should be pointed at it too.
section('12', () => {
 const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8')
 .replace(/\/\*[\s\S]*?\*\//g, '');
 // every `selector { body }` in the file, @media bodies included, in order
 const rules = [];
 const walk = (text) => {
 const re = /([^{}]+)\{([^{}]*)\}/g;
 let m;
 while ((m = re.exec(text))) rules.push({ sel: m[1].trim(), body: m[2] });
 };
 walk(css);

 // A browser's answer to "which declaration of `prop` lands on this element,
 // at rest". `chain` is the element's real ancestry, read off the live DOM,
 // outermost first — matching right-to-left against it is what stops
 // `.hud-top .btn` (a container this button is not in) being counted as a
 // competitor. `:where()` contributes no specificity, which is exactly what
 // made `:where(.toolbar-wrap) .btn.tiny` a 0-2-0 rival in the first place.
 const CHAIN = [
 ['main', 'full'], ['screen-holder'], ['game-root'],
 ['hud', 'toolbar-wrap', 'horizontal'], ['adv-stack'], ['adv-inner'],
 ];
 const compoundHits = (compound, cls) =>
 compound.startsWith('.') && compound.slice(1).split('.').every((c) => cls.includes(c));
 const matches = (bare, ownCls) => {
 const parts = bare.trim().split(/\s+/).filter(Boolean);
 if (parts.some((p) => /[>+~]/.test(p))) return false; // child/sibling: not worth modelling
 if (!compoundHits(parts.pop(), ownCls)) return false;
 let at = CHAIN.length - 1;
 for (const want of parts.reverse()) { // each ancestor, nearest first
 while (at >= 0 && !compoundHits(want, CHAIN[at])) at--;
 if (at < 0) return false;
 at--;
 }
 return true;
 };
 const winnerFor = (ownCls, prop) => {
 let best = null;
 rules.forEach((r, order) => {
 for (const one of r.sel.split(',')) {
 const sel = one.trim();
 if (!sel || sel.startsWith('@') || /::|:hover|:active|:focus|:disabled|:not\(/.test(sel)) continue;
 const bare = sel.replace(/:where\([^)]*\)/g, ' '); // no specificity, still a match
 if (!matches(bare, ownCls)) continue;
 const spec = (bare.match(/\./g) || []).length;
 const decl = [...r.body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].filter((d) => d[1].trim() === prop).pop();
 if (!decl) continue;
 if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) {
 best = { sel, spec, order, value: decl[2].trim() };
 }
 }
 });
 return best;
 };

 const CLASSES = ['btn', 'tiny', 'icon-btn', 'ghost-run'];
 // The premise, stated: the rules this has to beat really are in the file and
 // really do reach this button. Without this the gate above could pass by the
 // resolver quietly matching nothing at all.
 gate('12. the premise: `.btn.tiny` reaches this button twice over, at 0-2-0',
 rules.some((r) => /(^|,)\s*\.btn\.tiny\s*$/.test(r.sel) && /padding/.test(r.body))
 && rules.some((r) => /:where\(\.toolbar-wrap\)\s*\.btn\.tiny/.test(r.sel) && /padding/.test(r.body)));
 const pad = winnerFor(CLASSES, 'padding');
 gate('12. the padding that WINS on the ghost button is the one meant to win',
 pad?.sel === '.btn.ghost-run' && /^0(px)?$/.test(pad.value),
 pad ? `${pad.sel} → ${pad.value} (specificity ${pad.spec})` : 'nothing matched');
 // …which is only true because it is two classes. State that, so a future
 // tidy-up that "simplifies" it to `.ghost-run` fails here rather than in a
 // report.
 gate('12. …and it is two classes, because .btn.tiny is',
 (pad?.spec ?? 0) >= 2, `specificity ${pad?.spec}`);

 const w = winnerFor(CLASSES, 'width');
 const fw = winnerFor(['btn', 'tiny', 'icon-btn', 'free-world'], 'width');
 gate('12. the ghost button is the same width as the mode switch beside it',
 !!w && w.value === fw?.value, `${w?.value} vs Free World's ${fw?.value}`);

 // The invariant the crush actually broke: the glyph has to FIT.
 const svg = ghostIconSVG(24);
 const iw = +(/width="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? NaN);
 const ih = +(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? NaN);
 const box = +(/([\d.]+)px/.exec(w?.value || '')?.[1] ?? NaN);
 const hRule = winnerFor(CLASSES, 'height');
 const boxH = +(/([\d.]+)px/.exec(hRule?.value || '')?.[1] ?? NaN);
 gate('12. …and the glyph fits inside it, which is what a 1.2 px sliver was not',
 iw > 0 && ih > 0 && iw <= box && ih <= boxH,
 `${iw}×${ih} glyph in a ${box}×${boxH} button`);
 gate('12. the ghost is drawn TALLER than it is wide — it is a ghost', ih > iw);

 // …and the press. `disabled` is gone entirely: with nothing to aim at the
 // button still works and says so.
 // `style` is here because the scale writes the origin's position as a custom
 // property, and a fake without one throws where the real element would not.
 // At section scope because BOTH chip blocks below need it.
 const fake = () => { const c = new Set(); const p = new Map(); return { className: '', disabled: null, title: '', textContent: '', style: { props: p, setProperty: (k, v) => p.set(k, v), getPropertyValue: (k) => p.get(k) ?? '' }, classList: { toggle: (n, on) => (on ? c.add(n) : c.delete(n)), add: (n) => c.add(n), remove: (n) => c.delete(n), contains: (n) => c.has(n), has: c } }; };

 {
 const S = screen(flat());
 S.ghostBtn = fake();
 S._tape = null;
 S._syncGhostBtn();
 gate('12. with no run recorded the button is still PRESSABLE',
 S.ghostBtn.disabled === false);
 // **And no longer even "waiting".** The first fix made the dead press
 // ANSWER; this one removed the precondition it was answering about, because
 // the chip carries a dial and the mode never needed a tape. A control with
 // nothing to wait for should not look like it is waiting.
 gate('12. …and carries no state at all beyond on/off — the chip says the rest',
 !S.ghostBtn.classList.contains('waiting') && S.ghostLabel === undefined);
 gate('12. …its tooltip says what the mode does, not what you must do first',
 /no run needed/i.test(S.ghostBtn.title));
 S._toggleGhostRun();
 gate('12. …and pressing it ARMS the mode, which is the whole of the bug report',
 !!S.ghost && near(S.ghost.t, GHOST_AIM_DEFAULT));

 // **The chip says what it is judging by**, because that decides what its
 // number MEANS — and until the chip existed it was only ever said in a toast
 // that had expired long before you looked. Driven through the real
 // `_syncGhostChip` against fake elements: the strings are the rule.
 const chip = { sweepTitle: fake(), ghostAim: fake(), ghostJudge: fake(), ghostVerdict: fake(),
 sweepCanvas: fake(), sweepRung: fake(), sweepScale: fake(), sweepScaleBest: fake(),
 sweepScaleWorst: fake(), sweepScaleHome: fake(),
 sweepWinScale: fake(), sweepWinFast: fake(), sweepWinSlow: fake(),
 sweepRead: fake(), sweepOdds: fake(), sweepRow: fake(), sweepFiner: fake(),
 ghostHideBtn: fake() };
 Object.assign(S, chip, { _sweepBar: { wrap: fake() } });
 delete S._syncGhostChip; // the real one, from here on
 S.goalPositions = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
 S._ghostRoads = []; S._ghostOnly = null;
 S._syncGhostChip();
 gate('12. with no road drawn the chip says it is judging by the goal',
 /by the goal/.test(S.ghostJudge.textContent) && /all cargo/.test(S.ghostJudge.textContent),
 S.ghostJudge.textContent);
 S._ghostRoads = [{ goal: 0, pts: [{ x: 1, y: 1 }] }, { goal: 1, pts: [{ x: 2, y: 2 }] }];
 S._syncGhostChip();
 gate('12. …and with roads, how many of them',
 /2 roads/.test(S.ghostJudge.textContent), S.ghostJudge.textContent);
 S._ghostOnly = 1;
 S._syncGhostChip();
 gate('12. …and says out loud when it is only judging one cargo',
 /cargo 2 only/.test(S.ghostJudge.textContent), S.ghostJudge.textContent);
 S.level.goalZones = [{ x: 0, y: 0, w: 80, h: 80 }, { x: 100, y: 0, w: 80, h: 80 }];
 S._ghostAssign = [1];
 S._syncGhostChip();
 gate('12. …and writes a pairing as cargo→goal',
 /1→2/.test(S.ghostJudge.textContent), S.ghostJudge.textContent);
 S._ghostAssign = [];
 S._ghostOnly = null; S._ghostRoads = [];
 S._toggleGhostHide();
 gate('12. Hide puts the future overlay away without leaving the mode',
 S._ghostHide && !!S.ghost && /hidden/.test(S.sweepTitle.textContent)
 && S.ghostHideBtn.textContent === 'Show',
 S.sweepTitle.textContent);
 const hidden = S._ghostHide;
 S._ghostOff();
 S._toggleGhostRun();
 gate('12. …and the hide outlives arm/disarm, the way the roads do',
 S._ghostHide === hidden && !!S.ghost);
 S._toggleGhostHide();
 gate('12. Show brings the overlay back',
 !S._ghostHide && S.ghostHideBtn.textContent === 'Hide');
 // BOTH numbers, which is how the "which moment does it read" bug hid
 S._ghostOnly = null; S._ghostRoads = [];
 Object.assign(S.ghost, { stale: false, sim: null, gap: 120, aimGap: 40, won: false, lost: false });
 S._syncGhostChip();
 gate('12. the verdict carries the aim AND the closest, never one of them',
 /at the aim 120 px/.test(S.ghostVerdict.textContent) && /closest 40 px/.test(S.ghostVerdict.textContent),
 S.ghostVerdict.textContent);
 Object.assign(S.ghost, { won: true, winTime: 1.5 });
 S._syncGhostChip();
 gate('12. …and a delivery says so instead of a distance',
 /DELIVERED at 1.50s/.test(S.ghostVerdict.textContent), S.ghostVerdict.textContent);
 // …and once there is something to aim at, no trace of the waiting state
 S._tape = { n: 2, head: 2, frames: 2, t: new Float32Array([0, 1]), stride: 0 };
 S._scrub = 1;
 S._syncGhostBtn();
 gate('12. with a run recorded it is an ordinary live control',
 S.ghostBtn.disabled === false && !S.ghostBtn.classList.contains('waiting'));
 }

 // ---------- 12b. the SCALE, with a field under it ----------
 //
 // **This block exists because everything above it passed while the chip was
 // broken** (2026-08-22). The gates above drive the real `_syncGhostChip`, but
 // only ever with `_ghostSweep` null — so `if (hasField)`, the branch that owns
 // the scale, was never entered by anything. A rename left a stale node
 // reference in it, every tick threw, the rAF loop died, and the only thing
 // still advancing the sweep was mouse movement. 245 gates said fine.
 //
 // So: a REAL sweep, then the real `_syncGhostChip` over it. The rule being
 // gated is not a string, it is that this code path runs at all.
 {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const Z = screen(level, parts);
 Z.ghost = { t: 1.5, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(Z);
 Z._startPinSweep({ x: -140, y: -60 }, 1);
 sweepToEnd(Z);
 const chipZ = { sweepTitle: fake(), ghostAim: fake(), ghostJudge: fake(), ghostVerdict: fake(),
 sweepCanvas: fake(), sweepRung: fake(), sweepScale: fake(), sweepScaleBest: fake(),
 sweepScaleWorst: fake(), sweepScaleHome: fake(),
 sweepWinScale: fake(), sweepWinFast: fake(), sweepWinSlow: fake(),
 sweepRead: fake(), sweepOdds: fake(), sweepRow: fake(), sweepFiner: fake() };
 Object.assign(Z, chipZ, { _sweepBar: { wrap: fake() } });
 delete Z._syncGhostChip;
 let threw = null;
 try { Z._syncGhostChip(); } catch (e) { threw = e; }
 gate('12b. a chip sync over a REAL field does not throw — the whole bug',
 !threw, threw ? String(threw && threw.message) : 'clean');
 const F = Z._ghostSweep.field;
 let worst = -Infinity;
 for (const v of F.cells) if (Number.isFinite(v) && v > worst) worst = v;
 gate('12b. the field HAS both halves to grade, so the branch is a real test',
 Number.isFinite(worst) && Number.isFinite(F.base) && worst > F.base - 1e-6,
 `best ${F.best?.toFixed?.(1)} · origin ${F.base?.toFixed?.(1)} · worst ${Number.isFinite(worst) ? worst.toFixed(1) : worst}`);
 const mid = Z.sweepScale.style.getPropertyValue('--sweep-mid');
 gate('12b. the origin gets a position on the ramp, as a percentage',
 /^\d+(\.\d+)?%$/.test(mid), mid || '(unset)');
 gate('12b. …and the ramp is not asked to run backwards',
 parseFloat(mid) >= 0 && parseFloat(mid) <= 100, mid);
 gate('12b. the red end carries the worst cell measured, not the origin',
 Z.sweepScaleWorst.textContent !== '' && !/NaN|undefined/.test(Z.sweepScaleWorst.textContent),
 Z.sweepScaleWorst.textContent);
 gate('12b. …and the tick carries the machine you already have',
 Z.sweepScaleHome.textContent !== '' && !/NaN|undefined/.test(Z.sweepScaleHome.textContent),
 Z.sweepScaleHome.textContent);
 // The odds ride under the readout, written by this same sync (§ 10f).
 // **This field delivers from nowhere, so it gets no odds line at all**
 // (2026-08-22: *"no need to provide odds and time estimate"* off a solve).
 gate('12b. a field with no solve in it carries no odds line',
 Z.sweepOdds.classList.contains('hidden'), Z.sweepOdds.textContent || '(empty)');
 // …and one that does. Same chip, same sync, a machine that arrives.
 {
 const W = screen(flat({ goalZones: [{ x: -60, y: -52, w: 200, h: 104 }] }), [
 { t: 'wheel', kind: 'cw', id: 'w', x: -300, y: -40, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -300, y1: -40, x2: -240, y2: -40 },
 ]);
 W.ghost = { t: 3, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(W);
 W._startPinSweep({ x: -240, y: -40 }, 0.1);
 sweepToEnd(W);
 Object.assign(W, { ...chipZ, sweepOdds: fake(), sweepScale: fake(), sweepScaleBest: fake(),
 sweepScaleWorst: fake(), sweepScaleHome: fake(), sweepRead: fake(), sweepRung: fake() },
 { _sweepBar: { wrap: fake() } });
 delete W._syncGhostChip;
 W._syncGhostChip();
 gate('12b. …while a field with one writes the line, and shows it',
 /^(\d+ of \d+ as good|1 in [\d,]+)/.test(W.sweepOdds.textContent)
 && !W.sweepOdds.classList.contains('hidden'), W.sweepOdds.textContent);
 gate('12b. …with the model in its tooltip, because a bare "1 in 225" is a claim',
 /(land as well as this one or better|deliver, as this one does)/.test(W.sweepOdds.title),
 W.sweepOdds.title.slice(0, 60) + '…');
 // …and never off a part-filled field: a probability counted out of a third
 // of a sweep is a number that walks while you read it.
 W._ghostSweep.done = false;
 W._syncGhostChip();
 gate('12b. …and it stays away until the field is finished',
 W.sweepOdds.classList.contains('hidden'));
 }
 // **The case that made the red exist.** A sweep whose origin already
 // delivers has nothing that can score nearer, so the green half is empty and
 // every other cell is worse — which used to paint white and say nothing.
 const won = Z._ghostSweep;
 won.field.base = 0; won.field.best = 0;
 let threw2 = null;
 try { Z._syncGhostChip(); } catch (e) { threw2 = e; }
 gate('12b. an origin that DELIVERS still gets a scale, and still does not throw',
 !threw2 && Z.sweepScaleWorst.textContent !== '', threw2 ? String(threw2 && threw2.message) : Z.sweepScaleWorst.textContent);
 gate('12b. …with nothing on the green side, so the ramp starts at the left edge',
 parseFloat(Z.sweepScale.style.getPropertyValue('--sweep-mid')) === 0
 && /nothing beat/i.test(Z.sweepScaleBest.textContent),
 `${Z.sweepScale.style.getPropertyValue('--sweep-mid')} · "${Z.sweepScaleBest.textContent}"`);
 // **And the label gets out of its own way there.** A tick at 0% with a
 // centred number hangs half that number off the left end, on top of the one
 // already sitting there — the same parked-on-the-threshold bug as the wrap
 // caps. The tick does not move; only the label leans.
 gate('12b. …and its NUMBER leans right rather than off the end',
 Z.sweepScale.style.getPropertyValue('--sweep-home-shift') === '0%',
 Z.sweepScale.style.getPropertyValue('--sweep-home-shift'));
 {
 const mids = [];
 for (const [b, w, bs] of [[0, 100, 0], [50, 100, 0], [100, 100, 0], [0, 0, 0]]) {
 won.field.best = bs; won.field.base = b;
 for (let i = 0; i < won.field.cells.length; i++) if (!Number.isNaN(won.field.cells[i])) won.field.cells[i] = w;
 won.field.cells[won.field.originIdx] = b;
 Z._syncGhostChip();
 mids.push([parseFloat(Z.sweepScale.style.getPropertyValue('--sweep-mid')),
 Z.sweepScale.style.getPropertyValue('--sweep-home-shift')]);
 }
 gate('12b. every position on the ramp is inside it, and only the ends lean',
 mids.every(([m, s]) => m >= 0 && m <= 100
 && s === (m <= 0.5 ? '0%' : m >= 99.5 ? '-100%' : '-50%')),
 mids.map(([m, s]) => `${m}%→${s}`).join(' '));
 }
 // …and the one state that genuinely has no gradient either way.
 for (let i = 0; i < won.field.cells.length; i++) if (!Number.isNaN(won.field.cells[i])) won.field.cells[i] = 42;
 won.field.base = 42; won.field.best = 42;
 Z._syncGhostChip();
 gate('12b. every cell alike is FLAT, and says so rather than drawing a ramp',
 Z.sweepScale.classList.contains('flat') && Z.sweepScaleHome.textContent === '');
 }

 // ---------- 12c. what a field SURVIVES ----------
 //
 // **Looking around must not cost you the thing you are looking at**
 // (2026-08-22: *"I would like the Ghost Chip not to close the matrix
 // every time I move the screen and/or zoom"*). Panning and zooming never did
 // touch a field. What did was the gesture next to them: right-clicking a pin
 // to open a sweep leaves that pin's stick SELECTED, and the wheel over a
 // selected rod sets its weight — an edit, and every edit takes the ghost and
 // its 225 rollouts with it. So while a field is up the wheel is the camera.
 //
 // Gated as a TABLE rather than as one case, because the rule is a boundary:
 // navigation keeps the field, editing still discards it (a field measured
 // against a machine nobody has is worse than no field), and the weight
 // gesture still works when there is no field to protect.
 {
 const level = flat({ goalObjs: [{ shape: 'ball', x: -60, y: -15, r: 15 }] });
 const parts = [
 { t: 'wheel', kind: 'cw', id: 'w', x: -220, y: -60, r: 20 },
 { t: 'rod', kind: 'wood', id: 'r', x1: -220, y1: -60, x2: -140, y2: -60 },
 ];
 const rect = { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 };
 const withSweep = (sweep) => {
 const Z = screen(level, parts);
 Z.camera.setViewport(1200, 800);
 Z.canvas = { getBoundingClientRect: () => rect, setPointerCapture() {}, releasePointerCapture() {},
 style: {}, width: 1200, height: 800, addEventListener() {}, removeEventListener() {} };
 Z.ghost = { t: 1.5, stale: true, sim: null, shape: null, buf: null, stride: 0, time: 0, trace: null, won: false, winTime: null, lost: false, ms: null, failed: false };
 ghostToEnd(Z);
 if (sweep) { Z._startPinSweep({ x: -140, y: -60 }, 1); sweepToEnd(Z); }
 return Z;
 };
 // the rod's midpoint in screen px, at zoom 1 on a 1200x800 viewport
 const wheelAt = (Z, sx, sy) => Z._wheelEvt({ deltaY: -100, clientX: sx, clientY: sy,
 ctrlKey: false, shiftKey: false, altKey: false, preventDefault() {}, stopPropagation() {}, target: null });
 const kept = (Z) => !!Z._ghostSweep;

 const A = withSweep(true);
 A.sel = { kind: 'part', ref: A.design.parts[1] };
 const z0 = A.camera.zoom, w0 = A.design.parts[1].weight ?? 1;
 wheelAt(A, 420, 340);
 gate('12c. a wheel over a SELECTED rod keeps the field — the whole report',
 kept(A), kept(A) ? 'kept' : 'discarded');
 gate('12c. …and it ZOOMS instead, rather than being swallowed',
 A.camera.zoom > z0, `${z0.toFixed(2)} -> ${A.camera.zoom.toFixed(2)}`);
 gate('12c. …and the stick keeps the weight it had',
 (A.design.parts[1].weight ?? 1) === w0);

 const B = withSweep(true);
 B.camera.panPx(40, 20); B._clampCamera();
 const B2 = withSweep(true);
 B2.camera.setViewport(900, 600); B2._clampCamera();
 gate('12c. panning and resizing the window keep it too', kept(B) && kept(B2));

 // …and the boundary: an EDIT still takes it, because those cells describe a
 // machine that no longer exists.
 const C = withSweep(true);
 C._updateStats();
 gate('12c. an edit still discards it — a field for a build nobody has is worse than none',
 !kept(C));

 // …and the gesture is deferred, not deleted.
 const D = withSweep(false);
 D.sel = { kind: 'part', ref: D.design.parts[1] };
 const dw0 = D.design.parts[1].weight ?? 1;
 wheelAt(D, 420, 340);
 gate('12c. with no field to protect, the wheel still weights a selected rod',
 (D.design.parts[1].weight ?? 1) !== dw0,
 `${dw0} -> ${D.design.parts[1].weight}`);

 // ---------- and the plainer one: a CLICK-DRAG ----------
 //
 // No wheel involved at all. `_pointerUp` ended every gesture with
 // `_updateStats()`, which is where an edit throws the ghost away — so
 // panning the background discarded a finished field, and so did a bare
 // click, because a press on empty space becomes a `pan` drag whether the
 // hand moves or not.
 gate('12c. the rule names the three gestures that cannot edit',
 !dragEdits('pan') && !dragEdits('marquee') && !dragEdits('ghost-aim')
 && DRAG_NEVER_EDITS.size === 3);
 gate('12c. …and anything else is an edit until someone says otherwise',
 ['move', 'move-endpoint', 'place-rod', 'resize', 'move-pin', 'a-type-added-next-year']
 .every((t) => dragEdits(t)));

 const drag = (Z, from, to) => {
 const ev = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, button: 0,
 buttons: 1, pointerType: 'mouse', ctrlKey: false, shiftKey: false, altKey: false,
 metaKey: false, preventDefault() {}, stopPropagation() {}, target: null, ...extra });
 Z._pointerDown(ev(from[0], from[1]));
 if (to) Z._pointerMove(ev(to[0], to[1]));
 Z._pointerUp(ev(...(to || from), { buttons: 0 }));
 };
 const withPointer = (sweep) => {
 const Z = withSweep(sweep);
 Z._touches = new Map();
 Z.canvas.setPointerCapture = () => { throw new Error('no pointer'); };
 return Z;
 };
 const E = withPointer(true); drag(E, [120, 120], [180, 150]);
 gate('12c. dragging the BACKGROUND keeps the field', kept(E));
 const F = withPointer(true); drag(F, [120, 120], null);
 gate('12c. …and so does a bare click on it, which is a pan drag that never moved',
 kept(F));
 // the boundary again, through the same door: a real drag of a real stick
 const G = withPointer(true); drag(G, [420, 340], [460, 360]);
 gate('12c. …while dragging the STICK still discards it, and commits',
 !kept(G) && G.commits > 0, `commits ${G.commits}`);
 }
});

summary();
