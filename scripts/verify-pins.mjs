// verify-pins.mjs — the wheel pin lattice and the style switch (§6.1, util.js).
// Run: node scripts/verify-pins.mjs
//
// WHAT THIS IS FOR. `pinStyle` decides how many attachment points a wheel
// offers, and three parties have to agree on the answer or a machine comes
// apart: the renderer draws them, the editor snaps to them, and the sim buckets
// them into joints. They agree by all calling `wheelPinOffsets`, so what is
// worth gating is not the plumbing but the two claims the switch is safe on:
//
//   - the counts are 4 / 8 / 8 + 16, and they come out of the pitch rule rather
//     than out of three numbers somebody typed (gates 2 and 5);
//   - `groove` CONTAINS `dots`, ring for ring, so flipping the switch — in
//     either direction, at any time, with a machine already built — cannot
//     leave a rod pinned to a coordinate that is no longer a pin (gate 3).
//
// The drawing is gated too, against a recording context in the `recCtx`
// tradition of verify-editor (gate 7) — the draw calls ARE the drawing, so the
// two styles can be told apart without a canvas. Only the finished pixels need
// a browser, and the clearances they would show are arithmetic here.
//
// Gate 8 builds a real Simulation against the shipped wasm, because a slot that
// draws and does not JOINT is the failure this switch could actually cause.
// Everything else runs on util.js alone. Nothing here touches the database.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;

// **There is one pin style and it is the groove** (2026-08-12, "Grooves win!").
// These two stand in for the switch this file was written around, so the
// drawing gates below keep their shape without pretending there is still a
// choice: the loops run once, over the only style there is, and the no-op
// setter documents at each call site that nothing is being switched.
const PIN_STYLES = ['groove'];
const setPinStyle = () => {};

const {
  ringSlots, SLOT_PITCH_MIN, wheelRings, wheelPinOffsets, goalPinOffsets, goalRings, jointKey,
  GOAL_PIN_INSET, GOAL_RING_BASE, GOAL_RING_STEP,
  WHEEL_SIZES, PIN_INSET, STD_WHEEL_R, INNER_RING_R, occupiedPins, pinOwnerCounts,
} = await import(u('public/js/util.js'));
const { drawWheel, drawRod, drawGoalPiece, drawProp, PIN_DOT_R, PIN_DOT_LIVE_R, LIGHT,
  goalStackR, wheelCargoBackToFront,
  GROOVE_W, DETENT_W, DETENT_OVER, grooveWidth, rimWidthOf, pinIsLive, GROOVE_INK, DETENT_INK,
  PIECE_OUTLINE, PROP_OUTLINE, shade, hexFits,
  LETTER_SCALE, LETTER_LIP_OFF, LETTER_CLIP, LETTER_LIP_A, LETTER_GROOVE_A,
  letterScale, letterOffset, letterPathD, wordmarkSVG, faviconSVG } =
  await import(u('public/js/render.js'));

const { gate, section, summary } = gates();

const [SMALL, STD, LARGE] = WHEEL_SIZES;                  // 7.5 · 15 · 30
const keys = (offs) => new Set(offs.map(([x, y]) => jointKey(x, y)));

// ---------- 1. THE LEGACY LATTICE, restated ----------
//
// The `dots` style is gone (2026-08-12, "Grooves win!") and with it the switch
// this file was written around. What is NOT gone is the obligation it created:
// every design saved before that date was built on the dots lattice, and every
// rod in one is pinned to a dots coordinate. The groove was always a strict
// superset, which is exactly why deleting the loser was a no-op — but "was"
// is not a thing a gate can check once the loser is deleted.
//
// So the old lattice is RESTATED here and the surviving one measured against
// it. This is the one place in the codebase that still remembers what a saved
// machine is pinned to.
//
// **It was restated as LITERALS until 2026-08-15, and Path B ended that.**
// Adopting FC's absolute scale moved the wheel sizes themselves — 7.5/15/30
// became 10/20/40 — so a design saved before it is pinned to radii no wheel in
// the game has any more, and no arrangement of this file can make those
// coordinates come back. Freezing the numbers would only have asserted that a
// promise already broken elsewhere was still kept here.
//
// What survives, and is worth more, is the SHAPE of the promise: the groove
// lattice is a strict superset of the dots one, ring for ring, so a machine
// pinned to any dots slot is still pinned. That is checked below at whatever
// scale the game is currently built at, which is the form that keeps its
// meaning through the next scale change too.
// **THE LATTICE MOVED TO THE RIM on 2026-08-17, and this gate moved with
// it** — deliberately, on request, breaking every design pinned to the old
// inset rings the same way Path B broke the ones before it. FC's wheels
// carry four attachable spokes at radius r exactly (fcsim graph.c
// `add_wheel`), and the standard pins must LAND on them or an imported
// machine bolted to a rim misses its joints. The promise this section keeps
// now is FC's: the cardinals sit ON the rim, bit-exact.
for (const r of WHEEL_SIZES) {
  const now = keys(wheelPinOffsets(r));
  gate(`1. FC's four spokes are pins on the r ${r} wheel — cardinals at the rim, exact`,
    [[r, 0], [0, r], [-r, 0], [0, -r]].every(([x, y]) => now.has(jointKey(x, y))),
    `${now.size} pins`);
}
// …and the RADII are stated: the rim itself on every wheel, plus the big
// wheel's inner groove (LIFIRIK's own, unchanged at INNER_RING_R).
gate('1. the rings are the rim (and the big wheel\'s inner groove)',
  WHEEL_SIZES.every((r) => {
    const big = r > INNER_RING_R + PIN_INSET;
    const want = big ? [INNER_RING_R, r] : [Math.max(r, 1)];
    const have = wheelRings(r).map((g) => g.rad);
    return have.length === want.length && have.every((v, i) => v === want[i]);
  }),
  WHEEL_SIZES.map((r) => wheelRings(r).map((g) => g.rad).join('+')).join(' · '));

// ---------- 2. the counts ----------
// Asked for on 2026-08-11: 4 small, 8 standard, two rings of 8 and 16 large.
const counts = (r) => wheelRings(r).map((g) => g.n);
gate('2. the lattice is 4 small · 8 standard · 8+16 large',
  String(counts(SMALL)) === '4' && String(counts(STD)) === '8'
  && String(counts(LARGE)) === '8,16',
  WHEEL_SIZES.map((r) => `r${r}: ${counts(r).join('+')}`).join(' · '));
gate('2. the offsets add up — 4 · 8 · 24 pins on a wheel',
  wheelPinOffsets(SMALL).length === 4
  && wheelPinOffsets(STD).length === 8
  && wheelPinOffsets(LARGE).length === 24);
// The hub is added by the sim and the renderer separately (isCenter — motor
// eligibility), so a (0,0) in here would double-joint every wheel.
gate('2. the hub is not in the ring offsets',
  WHEEL_SIZES.every((r) => !wheelPinOffsets(r).some(([x, y]) => x === 0 && y === 0)));

// ---------- 3. one lattice, no argument to get wrong ----------
// The switch is gone from the SIGNATURE too, not just from the settings page —
// a leftover parameter is a second answer waiting to be passed by accident.
gate('3. wheelPinOffsets and wheelRings take a radius and nothing else',
  wheelPinOffsets.length === 1 && wheelRings.length === 1,
  `arity ${wheelPinOffsets.length} / ${wheelRings.length}`);
gate('3. …and a stray second argument cannot change the answer',
  wheelPinOffsets(STD, 'dots').length === wheelPinOffsets(STD).length
  && wheelPinOffsets(STD, 'anything').length === 8, 'still 8');

// ---------- 4. the coordinates stay exact ----------
// §6.1: cardinals are clean numbers, diagonals are Math.SQRT1_2, so both
// parties compute bit-identical floats. Trig dust at a cardinal would put a pin
// at 7.3e-16 instead of 0 — which jointKey would still round together, and
// which would still be a lie about the lattice.
{
  const offs = wheelPinOffsets(STD);
  gate('4. the four cardinals are exact',
    [[STD, 0], [0, STD], [-STD, 0], [0, -STD]].every(([x, y]) =>
      offs.some(([ox, oy]) => Object.is(ox, x) && Object.is(oy, y))));
}
gate('4. the standard wheel\'s eight are the four cardinals plus the four SQRT1_2 diagonals',
  (() => {
    const d = STD * Math.SQRT1_2;
    return wheelPinOffsets(STD).filter(([x, y]) =>
      Math.abs(Math.abs(x) - d) < 1e-15 && Math.abs(Math.abs(y) - d) < 1e-15).length === 4;
  })());
// Every pin sits on its own ring — the renderer draws the groove AS the ring,
// so a coordinate off it would be a slot with no channel.
gate('4. every offset lies on the ring it came from',
  WHEEL_SIZES.every((r) => {
    const rads = wheelRings(r).map((g) => g.rad);
    return wheelPinOffsets(r).every(([x, y]) =>
      rads.some((rad) => Math.abs(Math.hypot(x, y) - rad) < 1e-9));
  }));

// ---------- 5. the pitch rule ----------
// The counts are derived, not chosen: `ringSlots` takes the largest of 4/8/16
// whose neighbours still clear SLOT_PITCH_MIN of chord. These three are the
// rings the game actually has.
gate('5. ringSlots derives the asked-for counts',
  ringSlots(4.5) === 4 && ringSlots(12) === 8 && ringSlots(27) === 16,
  `4.5→${ringSlots(4.5)} 12→${ringSlots(12)} 27→${ringSlots(27)}`);
gate('5. no two neighbouring slots crowd closer than the pitch floor',
  WHEEL_SIZES.every((r) =>
    wheelRings(r).every(({ rad, n }) => 2 * rad * Math.sin(Math.PI / n) >= SLOT_PITCH_MIN)),
  `floor ${SLOT_PITCH_MIN} px`);
// A goal ball can be authored down to r 2 (sizes.js), where the ring is 1 px
// and nothing fits. It must still answer — the floor is four, never zero.
gate('5. a ring too small for any count still answers four',
  ringSlots(1) === 4 && ringSlots(0.01) === 4);

// ---------- 6. a goal piece's lattice is its own ----------
// It used to be FROZEN on dots so the wheel experiment could not quietly hand
// goal balls extra points, and it never followed the switch even while the
// switch existed. Since 2026-08-12 goal pieces have a lattice of their own —
// concentric, filling the face — so what is left to gate is that it is stable
// and centred, which is what every saved joint on a crate depends on.
for (const g of [{ shape: 'ball', r: STD }, { shape: 'ball', r: LARGE },
  { shape: 'box', w: 60, h: 30 }, { shape: 'box', w: 200, h: 200 }]) {
  const label = g.shape === 'ball' ? `ball r${g.r}` : `crate ${g.w}x${g.h}`;
  const a = goalPinOffsets(g), b = goalPinOffsets(g);
  gate(`6. a ${label} pins the same way every time it is asked`,
    a.length === b.length && a.every(([x, y], i) => x === b[i][0] && y === b[i][1]),
    `${a.length} pins`);
  gate(`6. …and its first pin is the CENTRE, which the sim treats as the hub`,
    a[0][0] === 0 && a[0][1] === 0, `(${a[0][0]}, ${a[0][1]})`);
}

// ---------- 7. what the wheel actually draws ----------
// A recording context, in the `recCtx` tradition of verify-editor: the draw
// calls ARE the drawing, so counting them gates the style without a canvas.
// What matters is that the two styles are exclusive — a groove that still laid
// beads on top of itself would be both designs at once, and a dots wheel that
// grew a channel would be the switch leaking.
// The width a path is drawn at is the one set when STROKE is called, not the
// one in force while it was built — `drawGroove` lays all its detents first and
// sets the pen once. A stub that read lineWidth at lineTo would have reported
// the lip's 0.7 for every detent, which is how this one was written the first
// time and what the counts below caught.
// The transform is tracked, not ignored, because gate 9 is entirely about WHERE
// two identical drawings land: the letters are one helper called twice, the
// second inside a rotation, so a stub that dropped the rotation would report a
// perfect pair no matter what the renderer did.
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const recCtx = () => {
  const c = {
    fills: [], circles: [], segs: [], letterStrokes: 0, order: [],
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', strokeStyle: '', fillStyle: '', globalAlpha: 1,
    _arcs: [], _path: [], _from: null, _m: [1, 0, 0, 1, 0, 0], _stack: [],
    _at(x, y) { const m = c._m; return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; },
    save() { c._stack.push(c._m.slice()); },
    restore() { c._m = c._stack.pop() || [1, 0, 0, 1, 0, 0]; },
    beginPath() { c._arcs = []; c._path = []; },
    closePath() {},
    moveTo(x, y) { c._from = c._at(x, y); },
    lineTo(x, y) { const p = c._at(x, y); c._path.push({ from: c._from, to: p }); c._from = p; },
    quadraticCurveTo(_a, _b, x, y) { const p = c._at(x, y); c._path.push({ from: c._from, to: p }); c._from = p; },
    // A path may hold SEVERAL arcs and still be one fill, so they are collected
    // rather than overwritten — a stub that kept only the last would report one
    // circle however many were drawn.
    arc(x, y, r, a0 = 0, a1 = Math.PI * 2) {
      const [px, py] = c._at(x, y);
      c._arcs.push({ x: px, y: py, r, full: Math.abs(a1 - a0) > 6.2 });
    },
    // **Only `beginPath` clears the path.** `fill`, `stroke` and `clip` all
    // consume the CURRENT path and leave it standing, which is how a shape gets
    // filled and then outlined in one go — every goal piece and every prop is
    // drawn that way, and so is the wheel's own rim. This stub used to clear on
    // fill, so it recorded those outlines as not existing at all: the gates
    // that leaned on it were reading a wheel with no rim and a crate with no
    // border, and passed because none of them had thought to ask.
    fill() { c.fills.push({ arcs: c._arcs.slice(), poly: c._path.map((s) => s.to) }); },
    stroke() {
      c.order.push(+c.lineWidth.toFixed(2));            // draw ORDER, for layering gates
      for (const a of c._arcs) c.circles.push({ r: a.r, w: c.lineWidth, full: a.full });
      if (c._path.length && c.lineWidth === 2.6) c.letterStrokes++;
      for (const s of c._path) c.segs.push({ w: c.lineWidth, style: c.strokeStyle, ...s });
    },
    clip() {},
    rect(x, y, w, h) {
      const a = c._at(x, y), b = c._at(x + w, y + h);
      c._path.push({ from: a, to: b });
    },
    // **A rounded rect is drawn out of `arcTo` and nothing else** — one
    // `moveTo` and four `arcTo`, no `lineTo` anywhere — so a stub that only
    // moved the pen here recorded a crate as having no outline at all. The
    // corner's curve is approximated by its endpoint, which is enough for the
    // width and the bounds; nothing gates the shape of a corner.
    arcTo(_x1, _y1, x, y) { const p = c._at(x, y); c._path.push({ from: c._from, to: p }); c._from = p; },
    translate(x, y) { c._m = mul(c._m, [1, 0, 0, 1, x, y]); },
    rotate(a) { c._m = mul(c._m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },
    scale(sx, sy) { c._m = mul(c._m, [sx, 0, 0, sy, 0, 0]); },
    getTransform: () => ({ a: 1 }),
  };
  return c;
};
const drawn = (r, style, opts = {}, w = {}) => {
  setPinStyle(style);
  const c = recCtx();
  drawWheel(c, { t: 'wheel', kind: 'cw', r, x: 0, y: 0, ...w }, { x: 0, y: 0, angle: 0 }, opts);
  return c;
};
// A bead is a lone filled circle of pin size: an EMPTY one is PIN_DOT_R, a live
// one PIN_DOT_LIVE_R. Lone, because anything drawn n-to-a-path is a ring's worth
// of marks rather than a pin.
const beads = (c, rad) => c.fills.filter((f) =>
  f.arcs.length === 1 && !f.poly.length && Math.abs(f.arcs[0].r - rad) < 1e-9);
for (const r of WHEEL_SIZES) {
  const rings = wheelRings(r);
  const slots = rings.reduce((n, g) => n + g.n, 0);
  const g = drawn(r, 'groove');
  // **An idle wheel wears ONE bead: the hub.** That is the whole economy of the
  // groove — the race says where the slots are and only an occupied one gets a
  // mark, which is also why a 24-slot wheel is no dearer to draw than a 4-slot
  // one (probe-pincost.mjs).
  gate(`7. r ${r}: the hub bead and nothing else on an empty face`,
    beads(g, PIN_DOT_R).length === 1, `${beads(g, PIN_DOT_R).length} beads`);
  gate(`7. r ${r}: a channel and a lit wall on every ring`,
    rings.every(({ rad }) => {
      const w = grooveWidth(rad, r);
      // an EDGE ring's race is cut just inside the slot (drawGroove): arc at
      // rad − w/2, lit wall at rad; an inner ring's arc sits on the ring
      const race = rad > r - w ? rad - w / 2 : rad;
      return g.circles.some((cc) => Math.abs(cc.r - race) < 1e-9 && Math.abs(cc.w - w) < 1e-9)
        && g.circles.some((cc) => Math.abs(cc.r - (race + w / 2)) < 1e-9);
    }),
    rings.map(({ rad }) => `${rad}@${grooveWidth(rad, r).toFixed(1)}`).join(' · '));
  gate(`7. r ${r}: a detent per slot`,
    g.segs.filter((s) => s.w === DETENT_W).length === slots, `${slots} detents`);
}
// **The rim ring's channel is cut INSIDE the rim, by construction**
// (2026-08-17): the slot sits ON the rim — FC's spokes — and the race draws
// inward from it (drawGroove's edge rule), so no channel can cross the rim
// however the sizes move.
gate('7. an edge ring\'s channel stays inside the piece',
  WHEEL_SIZES.every((r) => wheelRings(r, 'groove').every(({ rad }) => {
    const w = grooveWidth(rad, r);
    const race = rad > r - w ? rad - w / 2 : rad;
    return race + w / 2 <= r + 1e-9;
  })),
  `${GROOVE_W} wide on every ring`);
// **The same width on every wheel** (2026-08-12, on request): the big wheel used
// to wear the thinnest groove, because its outer ring is the one with least
// clear face and the clamp bit only there.
{
  const widths = WHEEL_SIZES.flatMap((r) => wheelRings(r, 'groove').map(({ rad }) => grooveWidth(rad, r)));
  gate('7. every groove in the game is the same thickness',
    widths.every((w) => Math.abs(w - widths[0]) < 1e-9),
    `${[...new Set(widths.map((w) => w.toFixed(2)))].join(', ')} px`);
  // …and grooveWidth answers the same number for every ring — the clamp died
  // with the inset rings (edge rings draw inward, so there is no rim face to
  // run out of), and this is what holds the door against it coming back
  // uneven.
  gate('7. …and grooveWidth is that one number on every ring',
    WHEEL_SIZES.every((r) => wheelRings(r, 'groove').every(({ rad }) =>
      grooveWidth(rad, r) === GROOVE_W)),
    `GROOVE_W ${GROOVE_W}`);
}
gate('7. no channel closes over the hub bead',
  WHEEL_SIZES.every((r) => wheelRings(r, 'groove').every(({ rad }) =>
    rad - grooveWidth(rad, r) / 2 >= PIN_DOT_R + 0.8)),
  `smallest gap ${Math.min(...WHEEL_SIZES.map((r) => Math.min(...wheelRings(r, 'groove').map(({ rad }) => rad - grooveWidth(rad, r) / 2)))).toFixed(2)} px`);
// The detent CROSSES its channel rather than sitting in it (2026-08-12), so
// what has to hold is no longer "the channel is at least as wide as the detent"
// — it is that the mark is wider than the wall it breaks, and narrower than the
// gap to the next one. A detent as wide as the slot pitch is a solid ring.
gate('7. the detent crosses its channel rather than sitting inside it',
  WHEEL_SIZES.every((r) => wheelRings(r, 'groove').every(({ rad }) =>
    grooveWidth(rad, r) + 2 * DETENT_OVER > grooveWidth(rad, r))),
  `${DETENT_OVER} px past each wall, ${DETENT_W} wide`);
gate('7. …and stays well clear of the next detent along',
  WHEEL_SIZES.every((r) => wheelRings(r, 'groove').every(({ rad, n }) =>
    2 * rad * Math.sin(Math.PI / n) > DETENT_W * 2)),
  `tightest gap ${Math.min(...WHEEL_SIZES.flatMap((r) => wheelRings(r, 'groove')
    .map(({ rad, n }) => 2 * rad * Math.sin(Math.PI / n) - DETENT_W))).toFixed(1)} px of channel between`);
// The two inks, 30% darker on 2026-08-12. Gated as an ORDER rather than as a
// pair of hex values: `shade` multiplies the fill, so these factors are
// luminances, and what has to hold is that each mark reads against the one
// under it — detent on channel, channel on the rim it is cut beside, rim on the
// face. Freezing the numbers would gate the request; this gates the drawing.
gate('7. the channel took one 30% step down, the detent two',
  Math.abs(GROOVE_INK - 0.5 * 0.7) < 1e-9 && Math.abs(DETENT_INK - 0.34 * 0.49) < 1e-9,
  `${GROOVE_INK.toFixed(3)} from 0.5, ${DETENT_INK.toFixed(4)} from 0.34`);
gate('7. detent darker than channel darker than rim darker than face',
  DETENT_INK < GROOVE_INK && GROOVE_INK < 0.62 && 0.62 < 1);
// …and each step is still a step you can SEE. Marks less than 15% apart in
// luminance have merged into one at the sizes these are drawn at.
gate('7. no two of them collapse into one tone',
  (GROOVE_INK - DETENT_INK) / GROOVE_INK > 0.15 && (0.62 - GROOVE_INK) / 0.62 > 0.15,
  `detent→channel ${(100 * (GROOVE_INK - DETENT_INK) / GROOVE_INK).toFixed(0)}%, channel→rim ${(100 * (0.62 - GROOVE_INK) / 0.62).toFixed(0)}%`);
// The floor on the other side. **The detent is now darker than pin ink** (39.6)
// on every wheel — asked for, twice, and the wheel it is darkest on is the L at
// 24.7 — so "no darker than a pin" is NOT the rule. What is: it must still be
// paint rather than a hole, i.e. dark enough to be the darkest thing on the
// face and light enough to keep the wheel's own hue. Below about 15 every fill
// arrives at the same black and the tick stops belonging to its wheel.
{
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
  const fills = { 'L/ccw': '#54a0ff', 'R/cw': '#ffa62b', 'F/free': '#cbd3e1' };
  const at = (f) => lum(fills[f]) * DETENT_INK;
  gate('7. the detent stays paint rather than black — it keeps its wheel\'s hue',
    Object.keys(fills).every((k) => at(k) >= 15),
    Object.keys(fills).map((k) => `${k} ${at(k).toFixed(1)}`).join(' · ') + ' (pin ink 39.6)');
}
setPinStyle('dots');

// ---------- 9. the kind letter, as a pair ----------
// Upright on the left, upside down on the right, half a turn apart (2026-08-12).
// The letters are the only thing on a wheel stroked at 2.6, which is what makes
// them findable in the recording; the detents are 1.2 and the arrows ride the
// rim's own width.
const LETTER_PEN = 2.6;
// The cut is Mk II's two passes now (2026-08-24, "like the attached image"):
// a warm KEY lip riding up-light of the stroke, the world's OCC ink laid over
// it. The ink is what the letter IS — mirror, position and size are asked of
// the OCC pass alone, because the lip is light, not letter: it rides one side
// only, so counted into a box it would shift every centre it touched.
const grooveSegs = (c) => c.segs.filter((s) => s.w === LETTER_PEN && s.style === LIGHT.occ);
const lipSegs = (c) => c.segs.filter((s) => s.w === LETTER_PEN && s.style === LIGHT.key);
const letterPts = (c) => grooveSegs(c).flatMap((s) => [s.from, s.to]);
const lipPts = (c) => lipSegs(c).flatMap((s) => [s.from, s.to]);
const box = (pts) => ({
  cx: (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2,
  cy: (Math.min(...pts.map((p) => p[1])) + Math.max(...pts.map((p) => p[1]))) / 2,
  h: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
});
gate('9. the small wheel carries no letters at all',
  letterOffset(SMALL, wheelRings(SMALL, 'dots')) === 0
  && letterPts(drawn(SMALL, 'dots')).length === 0,
  `r ${SMALL}`);
for (const r of [STD, LARGE]) {
  for (const kind of ['ccw', 'free', 'cw']) {
    setPinStyle('dots');
    const c = recCtx();
    drawWheel(c, { t: 'wheel', kind, r }, { x: 0, y: 0, angle: 0 }, {});
    const pts = letterPts(c);
    // The ghosting fix, pinned — through the engraving (2026-08-24, first
    // "the embossed L,F,R I like", then "like the attached image"): the cut
    // is TWO passes (lit lip, groove ink), and within each pass a copy is
    // still ONE stroke however many subpaths the letter is made of. The F was
    // once two strokes, and at these alphas its crossbar composited twice
    // where it crossed the stem; the passes overlay ON PURPOSE — the overlay
    // is the cut — so what is pinned is 2 passes × 2 copies, never a junction
    // doubling inside any one pass.
    gate(`9. r ${r} ${kind}: one stroke per copy per pass, so no junction composites twice`,
      c.letterStrokes === 4, `${c.letterStrokes} letter strokes`);
    // The lip is the groove displaced exactly one lip-offset up-light — same
    // subpaths, same pen, drawn first, so the two lists walk the same order.
    {
      const off = LETTER_LIP_OFF * letterScale(r);
      const lp = lipPts(c);
      gate(`9. r ${r} ${kind}: the lit lip rides one lip-offset up-light of the ink`,
        lp.length === pts.length && lp.length > 0 && lp.every((p, i) =>
          Math.abs(p[0] - (pts[i][0] - LIGHT.x * off)) < 1e-9
          && Math.abs(p[1] - (pts[i][1] - LIGHT.y * off)) < 1e-9),
        `${lp.length} lip points against ${pts.length}`);
    }
    const left = pts.filter((p) => p[0] < 0), right = pts.filter((p) => p[0] > 0);
    // Matched with a tolerance rather than by a rounded key: cos(π) is exactly
    // −1 but sin(π) is 1.22e-16, so a mirrored point misses its twin by a
    // fraction of a nanometre — which a `toFixed(2)` key turns into a miss
    // whenever the pair straddles a rounding boundary (it did, on 4 of 6).
    const twin = (p) => left.some(([x, y]) => Math.abs(-x - p[0]) < 1e-9 && Math.abs(-y - p[1]) < 1e-9);
    gate(`9. r ${r} ${kind}: the right letter is the left one turned half round`,
      pts.length > 0 && left.length === right.length && right.every(twin),
      `${left.length} points each side`);
    const d = letterOffset(r, wheelRings(r, 'dots'));
    const lb = box(left);
    gate(`9. r ${r} ${kind}: the pair sits at ±${d.toFixed(2)} (${(d / r).toFixed(2)} r), level with the hub`,
      Math.abs(-lb.cx - d) < 0.05 && Math.abs(lb.cy) < 0.05,
      `left centre (${lb.cx.toFixed(2)}, ${lb.cy.toFixed(2)})`);
    // The box is pure ink again — the lip lives in its own gate above, so
    // nothing widens what is measured here.
    gate(`9. r ${r} ${kind}: smaller than the single letter it replaced`,
      lb.h < 11 * (r * 2 / 24) * 0.85 * 0.6,
      `${lb.h.toFixed(1)} px tall, was ${(11 * (r * 2 / 24) * 0.85).toFixed(1)}`);
  }
  // One width for the set: all three letters draw the same box, which is what
  // lets one ink box place all of them and what makes the pair spacing the same
  // sentence on an L, an F and an R.
  const boxes = ['ccw', 'free', 'cw'].map((kind) => {
    const c = recCtx();
    drawWheel(c, { t: 'wheel', kind, r }, { x: 0, y: 0, angle: 0 }, {});
    const pts = letterPts(c).filter((p) => p[0] < 0);
    return [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])),
      Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  });
  gate(`9. r ${r}: L, F and R are drawn to one width and one baseline`,
    boxes.every((b) => b.every((v, i) => Math.abs(v - boxes[0][i]) < 1e-9)),
    boxes.map((b) => `${(b[1] - b[0]).toFixed(2)}×${(b[3] - b[2]).toFixed(2)}`).join(' · '));
}
// Where the pair goes on each wheel: between the hub and the ring on a standard
// one, and out between the TWO rings on a large one (2026-08-12, on request).
{
  const dStd = letterOffset(STD, wheelRings(STD, 'dots'));
  const dLarge = letterOffset(LARGE, wheelRings(LARGE, 'dots'));
  const [inner, outer] = wheelRings(LARGE, 'dots').map((g) => g.rad);
  const halfW = 4.95 * letterScale(LARGE);
  gate('9. the standard wheel keeps its pair inside its own ring',
    dStd + halfW * (STD / LARGE) < STD - PIN_INSET, `±${dStd.toFixed(2)} (${(dStd / STD).toFixed(2)} r)`);
  gate('9. the large wheel puts its pair BETWEEN the two rings',
    dLarge - halfW > inner && dLarge + halfW < outer,
    `±${dLarge.toFixed(2)} (${(dLarge / LARGE).toFixed(2)} r) spans ${(dLarge - halfW).toFixed(1)}–${(dLarge + halfW).toFixed(1)}, rings at ${inner} and ${outer}`);
}
// Nothing the letter draws can reach the engraving clip (2026-08-24, "still
// being clipped on the outer edge of large wheels"): the ink box's far corner
// plus the lip's swing — the lip turns through every local direction over a
// revolution — stays inside LETTER_CLIP r. The painter clips at the same
// exported constant the fit maths caps against, so this cannot regress by the
// two drifting apart.
gate('9. ink and lip stay inside the engraving clip at every spin',
  [STD, LARGE].every((r) => {
    const d = letterOffset(r, wheelRings(r, 'dots'));
    if (d === 0) return true;
    const ls = letterScale(r);
    const corner = Math.hypot(d + 4.95 * ls, 6.8 * ls);
    return corner + LETTER_LIP_OFF * ls <= LETTER_CLIP * r;
  }),
  [STD, LARGE].map((r) => {
    const d = letterOffset(r, wheelRings(r, 'dots'));
    const ls = letterScale(r);
    return `r ${r}: ${(Math.hypot(d + 4.95 * ls, 6.8 * ls) + LETTER_LIP_OFF * ls).toFixed(1)} of ${(LETTER_CLIP * r).toFixed(1)}`;
  }).join(' · '));
// Both styles draw the same letters in the same places — the lattice moved, the
// rings did not, and the letters are placed off the rings.
gate('9. the pin style does not move the letters',
  [STD, LARGE].every((r) => {
    const a = letterPts(drawn(r, 'dots')), b = letterPts(drawn(r, 'groove'));
    return a.length === b.length
      && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);
  }));
// LETTER_SCALE is a FRACTION OF THE WHEEL — so that is what the gate asks. It
// used to assert the number that fraction happened to produce at r 15 (0.525),
// which said the same thing right up until Path B changed the wheel underneath
// it, and then said nothing true. The 24 in `letterScale` is the glyph's own
// design box and is not a world length, so it does not move with the scale.
// The fraction is the swept 0.42 shrunk the asked-for 10% (2026-08-24,
// "slightly clipped by the rim — only for play wheels"), held as the product
// so both provenances stay visible.
gate('9. the scale is the swept one, shrunk the asked-for tenth',
  LETTER_SCALE === 0.42 * 0.9 && Math.abs(letterScale(STD) * 24 - LETTER_SCALE * 2 * STD) < 1e-9,
  `letter ${(letterScale(STD) * 24).toFixed(2)} across an r ${STD} wheel = ${(letterScale(STD) * 24 / (2 * STD)).toFixed(2)} of its diameter`);
// The groove ink, darkened twice on 2026-08-25. Written as the product of
// the plate's first cut so both steps stay visible the same way GROOVE_INK
// does. The lip is unchanged: a darker groove against the same key is more
// of a cut, not a reprint.
gate('9. the letter groove is the plate\'s cut, doubled from the first ink',
  LETTER_GROOVE_A === 0.30 * 2 && LETTER_LIP_A === 0.34,
  `groove ${LETTER_GROOVE_A} from 0.30, lip ${LETTER_LIP_A}`);
// The toolbar button, the wordmark and the No Wheels badge draw the letter this
// file strokes rather than a hand-kept copy of it.
gate('9. the SVG letters come off the same paths as the canvas ones',
  letterPathD('cw').includes('Q 15.8') && letterPathD('cw').endsWith('L 15.8 17.5')
  && letterPathD('free').split('M').length === 3
  && letterPathD('ccw', 100).startsWith('M 108.5'),
  letterPathD('ccw'));
// ---------- 9s. the sprite bake stays out of headless reach ----------
// The wheel blits from a sprite cache in the browser now (2026-08-24,
// overruled). These gates are why that is allowed: the router must keep every
// recording context on the vector painter — the painter the bake itself
// calls — so the 150 gates above still measure the real drawing.
{
  const c = recCtx();
  let blitted = 0;
  c.drawImage = () => { blitted++; };   // offer the blit; node has no document, so it must be refused
  drawWheel(c, { t: 'wheel', kind: 'cw', r: STD }, { x: 0, y: 0, angle: 0 }, {});
  gate('9s. headless, the router draws in vector even when the ctx could blit',
    blitted === 0 && letterPts(c).length > 0 && c.circles.length > 0,
    `${c.circles.length} circles, ${letterPts(c).length} letter points, ${blitted} blits`);
}
// The split pins its order: every static mark — the races' detents last of
// them — lands before the first letter stroke. Both paths share this by
// construction (sprite = static, then the same overlay the vector path runs);
// the recorder can only see the vector one, so that is where it is pinned.
{
  const c = drawn(STD, 'dots');
  const firstLetter = c.order.indexOf(2.6);
  const lastDetent = c.order.lastIndexOf(+DETENT_W.toFixed(2));
  gate('9s. the races draw before the letters — the overlay rides on top',
    firstLetter > -1 && lastDetent > -1 && lastDetent < firstLetter,
    `detents end at ${lastDetent}, letters start at ${firstLetter}`);
}

// ---------- 9a. the wordmark ----------
// L F R K, with the I's implied (2026-08-12). Gated because the mark is built
// from pieces and a piece change is what keeps reaching it: the wheels here had
// four beads in a cross, two pin styles after the game stopped drawing those.
{
  const wm = wordmarkSVG(26);
  gate('9a. the wordmark still says LIFIRIK to a screen reader',
    wm.includes('aria-label="LIFIRIK"'));
  // the water rods are gone, and their colour is the tell — nothing else in the
  // mark is that cyan
  gate('9a. no water-rod I is drawn — the I\'s are implied',
    !wm.includes('#48c6ef'), 'no capsule stroke in the markup');
  // three wheels and one K: the wheel count is the L, the F and the R
  const wheels = (wm.match(/<mask id="wm-/g) || []).length;
  gate('9a. three wheels carry L, F and R', wheels === 3, `${wheels} wheel cells`);
  gate('9a. one of each kind, so the three colours are the three wheels',
    ['wm-ccw-', 'wm-free-', 'wm-cw-'].every((k) => wm.includes(k)));
  // a repeated mask id would make one glyph's knockout leak into another's
  const ids = [...wm.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
  gate('9a. every knockout mask id is unique within the one SVG',
    new Set(ids).size === ids.length, ids.join(' '));
  // the letter is knocked OUT of the machining rather than laid over it, which
  // is what makes it readable at 26 px — the mask must actually carry a letter
  gate('9a. the mask cuts the letter, not an empty hole',
    /<mask id="wm-cw-[^"]*"[^>]*>\s*<rect[^>]*\/>\s*<path d="M/.test(wm));
  // and the favicon is the same cell, so it cannot drift from the mark
  gate('9a. the favicon is one of the wordmark\'s own wheels',
    faviconSVG().includes('<mask id="wm-ccw-'));

  // **Detents come off below 20 px**, where their stroke drops under 1.2 device
  // px and eight of them ring the letter in grey fuzz instead of marking the
  // slots. Counted off the markup, since a detent is the only <line> in a cell.
  // `butt` caps are the tell: a detent is a squared-off tick across the race,
  // and every other <line> in the mark is a round-capped wood rod in the K.
  const detentsIn = (svg) => (svg.match(/stroke-linecap="butt"/g) || []).length;
  const detents = (px) => detentsIn(faviconSVG(px));
  gate('9a. a small favicon drops its detents', detents(16) === 0 && detents(12) === 0,
    `16px→${detents(16)}, 12px→${detents(12)}`);
  gate('9a. …and keeps them once they can be seen',
    detents(20) === 8 && detents(24) === 8 && detents(32) === 8,
    `20px→${detents(20)}, 24px→${detents(24)}, 32px→${detents(32)}`);
  // the arrows go at the same size, on their own stroke: a shaft is
  // rimWidthOf × 0.8 = 2.0, the same 1.47 px in the cell as a detent
  const arrows = (px) => (faviconSVG(px).match(/ A \d/g) || []).length;
  gate('9a. a small favicon drops its drive arrows too',
    arrows(16) === 0 && arrows(12) === 0, `16px→${arrows(16)}, 12px→${arrows(12)}`);
  gate('9a. …and keeps them at 20 px and up',
    arrows(20) === 2 && arrows(24) === 2 && arrows(48) === 2,
    `20px→${arrows(20)}, 24px→${arrows(24)}, 48px→${arrows(48)}`);
  // the race itself always survives — it is what makes the disc read as a
  // wheel. 10.34 is the rim ring (20) cut inward by half a groove and scaled
  // into the cell (the edge rule, 2026-08-17).
  gate('9a. the race is never dropped, at any size',
    [12, 16, 24, 48].every((p) => /r="10\.34"/.test(faviconSVG(p))));
  // nor is the letter — a mark that drops it stops being the mark
  gate('9a. the letter is never dropped either',
    [12, 16, 24, 48].every((p) => faviconSVG(p).includes('stroke-width="2.4"')));
  // the default favicon is the 16 px one, because that is the size a tab shows
  gate('9a. the favicon defaults to the size a tab actually draws',
    faviconSVG() === faviconSVG(16) && faviconSVG().includes('width="16"'));
  // and a small WORDMARK drops them too — it is the same cell, scaled
  const wmDetents = (h) => detentsIn(wordmarkSVG(h));
  gate('9a. a small wordmark drops detents on the same rule',
    wmDetents(18) === 0 && wmDetents(26) === 24,
    `18px→${wmDetents(18)}, 26px→${wmDetents(26)} (3 wheels × 8)`);
}
setPinStyle('dots');

// ---------- 9b. one outline for every piece ----------
// 2.2 flat, every prop and every goal piece, every shape and every size
// (2026-08-12). An outline is a drawing convention, not a property of the
// object — which is why this is gated across the SIZE RANGE rather than at the
// default: the rule it replaced on the goal ball, `max(2, r · 0.13)`, agreed
// with a flat 2.2-ish everywhere below r 15.4 and diverged only above it, which
// is exactly why nobody saw it. A gate that asked at the default size would
// have passed on the broken code.
{
  const strokeOf = (draw) => {
    const c = recCtx();
    draw(c);
    // the piece's own outline is the widest stroke it lays down
    return Math.max(...c.circles.map((x) => x.w), ...c.segs.map((x) => x.w));
  };
  // The claim is that the two NAMES are one constant — the literal beside it
  // only ever pinned the value of the day, and Path B moved it (2.2 → 2.93).
  gate('9b. the two names are one constant',
    PROP_OUTLINE === PIECE_OUTLINE, PIECE_OUTLINE.toFixed(2));
  const balls = [2, 5, 15, 30, 60, 100];
  gate('9b. a goal BALL outlines at 2.2 at every radius, not just the default',
    balls.every((r) => Math.abs(strokeOf((c) => drawGoalPiece(c, { shape: 'ball', x: 0, y: 0, r }, null, {})) - PIECE_OUTLINE) < 1e-9),
    balls.map((r) => `r${r}: ${strokeOf((c) => drawGoalPiece(c, { shape: 'ball', x: 0, y: 0, r }, null, {})).toFixed(1)}`).join(' · '));
  gate('9b. a goal CRATE outlines at the same 2.2 the ball does',
    Math.abs(strokeOf((c) => drawGoalPiece(c, { shape: 'box', x: 0, y: 0, w: 60, h: 30 }, null, {})) - PIECE_OUTLINE) < 1e-9);
  gate('9b. props do too, both shapes, big and small',
    [{ shape: 'ball', r: 4 }, { shape: 'ball', r: 90 }, { shape: 'box', w: 20, h: 20 }, { shape: 'box', w: 400, h: 40 }]
      .every((p) => Math.abs(strokeOf((c) => drawProp(c, { x: 0, y: 0, ...p }, null, {})) - PIECE_OUTLINE) < 1e-9));
  // The pieces' outlines are now one number, so nothing about a piece's SIZE
  // may reach it. A stroke that varied would show up as two different answers
  // for one shape.
  gate('9b. no piece outline varies with the piece',
    new Set(balls.map((r) => strokeOf((c) => drawGoalPiece(c, { shape: 'ball', x: 0, y: 0, r }, null, {})))).size === 1);
}

// ---------- 9c. the goal piece's own lattice ----------
// Concentric rings on a ball and rounded-rect frames on a crate, filling the
// face (2026-08-12). Gated across the SIZE RANGE for the reason 9b is: packed
// at a fixed pitch this rule was right at the default and absurd above it —
// 389 pins on an r 100 ball — and the default size would never have shown it.
{
  const ballSizes = [2, 5, 8, 15, 30, 60, 100];
  const crateSizes = [[10, 1], [20, 20], [60, 30], [120, 60], [400, 40], [200, 200]];
  const pins = (g) => goalPinOffsets(g).length;
  // Not a cap on the COUNT — a big piece earns more rings, and after
  // 2026-08-12 the rings are the big wheel's own so the count is whatever the
  // piece has room for. What must hold is the SPACING: no two slots on a ring
  // closer than `SLOT_PITCH_MIN`, which is what stops a lattice being a
  // pincushion however many pins are in it.
  const RING_MIN = SLOT_PITCH_MIN * Math.SQRT1_2;           // 4.243, restated
  gate('9c. every ring big enough for slots spaces them by the pitch floor',
    ballSizes.every((r) => goalRings({ shape: 'ball', r })
      .filter(({ rad }) => rad >= RING_MIN)
      .every(({ rad, n }) => 2 * rad * Math.sin(Math.PI / n) >= SLOT_PITCH_MIN - 1e-9)),
    `up to ${Math.max(...ballSizes.map((r) => pins({ shape: 'ball', r })))} pins on a ball, `
    + `${Math.max(...crateSizes.map(([w, h]) => pins({ shape: 'box', w, h })))} on a crate`);
  // The exceptions are the deliberate floor and nothing else: a ball too small
  // for any ring gets four crammed pins rather than one lonely middle, and that
  // is the only place the pitch is knowingly broken.
  gate('9c. …and the only rings that break it are the small-piece floor',
    ballSizes.every((r) => goalRings({ shape: 'ball', r })
      .every(({ rad, n }) => 2 * rad * Math.sin(Math.PI / n) >= SLOT_PITCH_MIN - 1e-9
        || (rad < RING_MIN && n === 4))),
    `only r ${ballSizes.filter((r) => goalRings({ shape: 'ball', r }).some(({ rad }) => rad < RING_MIN)).join(' and ')}`);
  gate('9c. …and never fewer than a middle and four corners',
    ballSizes.every((r) => pins({ shape: 'ball', r }) >= 5)
    && crateSizes.every(([w, h]) => pins({ shape: 'box', w, h }) >= 5),
    'a goal piece you cannot attach to is not a goal piece');
  // **The rings are the big wheel's own** (2026-08-12): 15 apart, outermost 3
  // in from the edge — so an r 30 goal ball wears exactly the grooves an r 30
  // wheel does, and the step is derived from the wheel rather than typed here.
  gate('9c. the ring step IS the big wheel\'s own ring spacing',
    (() => {
      const w = wheelRings(LARGE, 'dots').map((r) => r.rad);
      return Math.abs(GOAL_RING_STEP - (w[1] - w[0])) < 1e-9;
    })(), `${GOAL_RING_STEP} px, from the wheel's ${wheelRings(LARGE, 'dots').map((r) => r.rad).join(' and ')}`);
  gate('9c. an r 30 goal ball has the r 30 wheel\'s grooves, exactly',
    (() => {
      const ball = goalRings({ shape: 'ball', r: LARGE }).map((x) => x.rad).sort((a, b) => a - b);
      const wheel = wheelRings(LARGE, 'dots').map((x) => x.rad).sort((a, b) => a - b);
      return ball.length === wheel.length && ball.every((v, i) => Math.abs(v - wheel[i]) < 1e-9);
    })(), goalRings({ shape: 'ball', r: LARGE }).map((x) => x.rad).join(', '));
  // **INNER rings step from the centre; the OUTERMOST is the EDGE, exactly**
  // (2026-08-17, with the FC lattice): FC's goal pieces carry their nodes at
  // the centre and the exact corners/rim, so the last ring is the piece's own
  // boundary — no inset — and the concentric ones inside it keep the base +
  // k·step lattice they have had since 2026-08-12.
  gate('9c. inner rings are base + a whole number of steps; the last is the edge',
    ballSizes.every((r) => {
      const rings = goalRings({ shape: 'ball', r }).map((x) => x.rad);
      const last = rings[rings.length - 1];
      return Math.abs(last - Math.max(r, 1)) < 1e-9
        && rings.slice(0, -1).every((rad, i) => Math.abs(GOAL_RING_BASE + i * GOAL_RING_STEP - rad) < 1e-9);
    }),
    `r 40 → ${goalRings({ shape: 'ball', r: 40 }).map((x) => x.rad).join(', ')}`);
  // …and the edge ring never crowds the stepped one just inside it: the
  // stepping stops half a step clear, so two channels cannot overlap.
  gate('9c. the edge ring keeps half a step of clearance from the stepped ones',
    [20, 40, 100].every((r) => {
      const rings = goalRings({ shape: 'ball', r }).map((x) => x.rad);
      return rings.length < 2 || rings[rings.length - 1] - rings[rings.length - 2] >= GOAL_RING_STEP / 2 - 1e-9;
    }));
  // The default crate's frame IS its corners now — FC's own nodes — which is
  // what keeps "a machine bolts to the crate it was bolted to at home" true.
  gate('9c. the outermost frame is the exact edge on the default pieces',
    Math.abs(goalRings({ shape: 'ball', r: STD }).slice(-1)[0].rad - STD) < 1e-9
    && Math.abs(goalRings({ shape: 'box', w: 60, h: 30 }).slice(-1)[0].a - 30) < 1e-9
    && Math.abs(goalRings({ shape: 'box', w: 60, h: 30 }).slice(-1)[0].b - 15) < 1e-9);
  // Rings and pins are two expansions of one function, so a detent can never
  // land where a pin is not.
  gate('9c. every ring\'s slots are pins, and every pin bar the middle is on a ring',
    [{ shape: 'ball', r: 30 }, { shape: 'box', w: 60, h: 30 }].every((g) => {
      const pinKeys = keys(goalPinOffsets(g));
      const fromRings = goalRings(g).flatMap((ring) => ring.pts || []);
      return pinKeys.size === goalPinOffsets(g).length
        && fromRings.every(([x, y]) => pinKeys.has(jointKey(x, y)));
    }));
  // A ball has no orientation, so turning one must not move a pin under a rod
  // already on it. A crate's corners must ride the angle.
  gate('9c. a ball\'s lattice ignores its angle; a crate\'s rides it',
    JSON.stringify(goalPinOffsets({ shape: 'ball', r: 20, angle: 1 }))
      === JSON.stringify(goalPinOffsets({ shape: 'ball', r: 20 }))
    && JSON.stringify(goalPinOffsets({ shape: 'box', w: 60, h: 30, angle: 1 }))
      !== JSON.stringify(goalPinOffsets({ shape: 'box', w: 60, h: 30 })));
  // The pitch has to leave as much face between two grooves as the groove takes,
  // and render.js owns the groove's width — so the relationship is checked here
  // rather than either file importing the other's numbers.
  gate('9c. the ring step leaves clear face between two grooves',
    GOAL_RING_STEP >= GROOVE_W * 2 + 2 * DETENT_OVER,
    `step ${GOAL_RING_STEP} against ${GROOVE_W} of groove and ${DETENT_OVER} of overhang either side`);
  // …and the outermost groove must not run out under the piece's own outline.
  gate('9c. no goal groove runs under the outline',
    [2, 15, 100].every((r) => (r - GOAL_PIN_INSET) + GROOVE_W / 2 <= r - PIECE_OUTLINE / 2 + 1e-9),
    `${GOAL_PIN_INSET} in, ${GROOVE_W / 2} of channel, ${PIECE_OUTLINE / 2} of outline`);
}

// ---------- 9d. what a goal piece draws ----------
{
  const drawGoal = (g, style) => {
    setPinStyle(style);
    const c = recCtx();
    drawGoalPiece(c, { x: 0, y: 0, ...g }, null, {});
    return c;
  };
  for (const g of [{ shape: 'ball', r: 15 }, { shape: 'box', w: 60, h: 30 }]) {
    const label = g.shape === 'ball' ? 'ball' : 'crate';
    const rings = goalRings({ x: 0, y: 0, ...g });
    const slots = rings.reduce((n, r) => n + (r.pts ? r.pts.length : r.n), 0);
    const gr = drawGoal(g, 'groove');
    gate(`9d. ${label}: no beads on an empty face — only connections light up`,
      beads(gr, PIN_DOT_R).length === 0 && beads(gr, PIN_DOT_LIVE_R).length === 0,
      `${beads(gr, PIN_DOT_R).length + beads(gr, PIN_DOT_LIVE_R).length} beads`);
    const ticks = gr.segs.filter((s) => Math.abs(s.w - DETENT_W) < 1e-9);
    const near0 = (v) => Math.abs(v) < 1e-6;
    const hubH = ticks.filter((s) => near0(s.from[1]) && near0(s.to[1]) && s.from[0] * s.to[0] < 0);
    const hubV = ticks.filter((s) => near0(s.from[0]) && near0(s.to[0]) && s.from[1] * s.to[1] < 0);
    gate(`9d. ${label}: the centre wears a detent cross — it is a pin`,
      hubH.length === 1 && hubV.length === 1,
      `H ${hubH.length} V ${hubV.length} of ${ticks.length} ticks`);
    gate(`9d. ${label}: a channel per ring at the groove's width`,
      gr.circles.filter((c) => Math.abs(c.w - GROOVE_W) < 1e-9).length
      + gr.segs.filter((s) => Math.abs(s.w - GROOVE_W) < 1e-9).length > 0
      && ticks.length === slots + 2,
      `${slots} ring detents + 2 hub = ${ticks.length} over ${rings.length} rings`);
  }
}

// ---------- 9e. the honeycomb ----------
// The goal piece's surface (2026-08-12, chosen from five). Under node there is
// no Path2D, so `buildComb` lays its walls straight onto the context and this
// sees every segment — which is the whole reason the fallback exists.
{
  const COMB_W = 0.55;
  const combOf = (g) => {
    setPinStyle('groove');
    const c = recCtx();
    drawGoalPiece(c, { x: 0, y: 0, ...g }, null, {});
    return { c, segs: c.segs.filter((s) => Math.abs(s.w - COMB_W) < 1e-9) };
  };
  for (const g of [{ shape: 'ball', r: 15 }, { shape: 'box', w: 60, h: 30 }]) {
    const label = g.shape === 'ball' ? `ball r${g.r}` : `crate ${g.w}x${g.h}`;
    const { c, segs } = combOf(g);
    gate(`9e. ${label} wears a honeycomb`, segs.length > 0, `${segs.length} walls`);
    // **Three walls per cell, not six.** Every interior wall belongs to two
    // cells; drawing whole hexagons lays each one twice, which measured 214 µs
    // against 60 on a default crate before the Path2D cache took it to 13.
    gate(`9e. ${label}: three walls per cell, so no wall is laid twice`,
      segs.length % 3 === 0, `${segs.length} walls = ${segs.length / 3} cells`);
    // …and the whole comb is ONE stroke, so a shared wall cannot composite
    // twice even where two cells meet.
    gate(`9e. ${label}: the comb is a single stroke`,
      c.order.filter((w) => Math.abs(w - COMB_W) < 1e-9).length === 1,
      `${c.order.filter((w) => Math.abs(w - COMB_W) < 1e-9).length} strokes at ${COMB_W}`);
    // It is the surface the races are cut INTO, so it goes down first.
    gate(`9e. ${label}: the comb is under the races`,
      c.order.findIndex((w) => Math.abs(w - COMB_W) < 1e-9)
      < c.order.findIndex((w) => Math.abs(w - GROOVE_W) < 1e-9),
      c.order.join(' → '));
  }
  // A cell bigger than the piece is a scratch, not a material.
  for (const g of [{ shape: 'ball', r: 2 }, { shape: 'ball', r: 8 }, { shape: 'box', w: 10, h: 1 }]) {
    const label = g.shape === 'ball' ? `ball r${g.r}` : `crate ${g.w}x${g.h}`;
    gate(`9e. ${label} is too small for a comb and gets none`, combOf(g).segs.length === 0);
  }
  gate('9e. hexFits is the rule, and it wants room for two cells',
    !hexFits(9) && hexFits(9.2) && hexFits(15));
  setPinStyle('dots');
}

// ---------- 10. an occupied pin is a different mark ----------
// "All occupied pins should be noticeably different" (2026-08-12). Occupancy is
// the sim's own rule — a second pin on the coordinate — asked of the authored
// design, and the mark is the same in every style so it reads the same wherever
// you meet it.
{
  const wheel = { t: 'wheel', kind: 'cw', r: STD, x: 0, y: 0, id: 'w' };
  const inner = STD;   // the ring is the RIM now (2026-08-17) — FC's spokes
  const arm = { t: 'rod', kind: 'wood', x1: inner, y1: 0, x2: inner + 60, y2: -40, id: 'arm' };
  const occ = occupiedPins({ parts: [wheel, arm] }, {});
  gate('10. the shared coordinate is the only one that reads occupied',
    occ.has(jointKey(inner, 0)) && occ.size === 1, `${occ.size} occupied`);
  gate('10. a lone wheel occupies nothing',
    occupiedPins({ parts: [wheel] }, {}).size === 0);
  gate('10. a loose level pin occupies its coordinate on its own',
    occupiedPins({ parts: [] }, { pins: [{ x: 5, y: 5 }] }).has(jointKey(5, 5)));
  gate('10. a rod on the HUB occupies it — an axle is a joint',
    occupiedPins({ parts: [wheel, { t: 'rod', kind: 'wood', x1: 0, y1: 0, x2: 60, y2: 0 }] }, {})
      .has(jointKey(0, 0)));
  {
    // A standard wheel on a large one shares the small hub (the joint) AND
    // extra rim slots of the lattice. Those extra coincidences are not joints
    // and must not light up as occupied — "sometimes random pins are highlighted."
    const big = { t: 'wheel', kind: 'cw', r: 40, x: 0, y: 0, id: 'big' };
    const std = { t: 'wheel', kind: 'cw', r: 20, x: 20, y: 0, id: 'std' };
    const face = occupiedPins({ parts: [big, std] }, {});
    gate('10. a small wheel on a large one occupies the SMALL hub — the axle',
      face.has(jointKey(20, 0)), [...face].join(' '));
    gate('10. …and does not light rim-on-rim lattice coincidences',
      !face.has(jointKey(40, 0)), [...face].join(' '));
  }
  {
    // A crate centred on a large wheel shares the hub (the axle) AND the
    // crate's four mid-edge pins with the wheel's inner ring. sim.js keeps
    // only the hub joint; occupancy must not gold-plate the other four.
    const big = { t: 'wheel', kind: 'cw', r: 40, x: 0, y: 0, id: 'big' };
    const crate = { shape: 'box', x: 0, y: 0, w: 40, h: 40 };
    const face = occupiedPins({ parts: [big] }, { goalObjs: [crate] });
    gate('10. a crate on a large wheel occupies the HUB — the axle',
      face.has(jointKey(0, 0)), [...face].join(' '));
    gate('10. …and does not light the crate\'s mid-edges on the inner ring',
      !face.has(jointKey(20, 0)) && !face.has(jointKey(0, 20))
      && !face.has(jointKey(-20, 0)) && !face.has(jointKey(0, -20)),
      [...face].join(' '));
    const c = recCtx();
    drawGoalPiece(c, crate, { x: 0, y: 0 }, { occupied: face });
    const live = beads(c, PIN_DOT_LIVE_R);
    gate('10. …and the crate itself draws only the hub bead',
      live.length === 1
      && Math.abs(live[0].arcs[0].x) < 1e-9 && Math.abs(live[0].arcs[0].y) < 1e-9,
      `${live.length} live at (${live[0]?.arcs[0].x}, ${live[0]?.arcs[0].y})`);
  }
  {
    // A rod on the cargo's AUTHORED pin is not a joint once the cargo has
    // been dragged (AlgoMech Easy Goal: stick on the spawn, piece moved).
    const ball = { shape: 'ball', x: 0, y: 0, r: 20 };
    const rod = { t: 'rod', kind: 'wood', x1: -20, y1: 0, x2: -80, y2: 0 };
    const atSpawn = occupiedPins({ parts: [rod] }, { goalObjs: [ball] });
    const dragged = occupiedPins({ parts: [rod] }, { goalObjs: [ball] },
      pinOwnerCounts({ parts: [rod] }, { goalObjs: [ball] }, [{ x: 40, y: 80 }]));
    gate('10. a rod on the authored cargo pin is occupied before a drag',
      atSpawn.has(jointKey(-20, 0)));
    gate('10. …and is not occupied after the cargo is dragged off it',
      !dragged.has(jointKey(-20, 0)) && !dragged.has(jointKey(20, 80)),
      [...dragged].join(' ') || 'empty');
  }
  for (const style of PIN_STYLES) {
    const c = drawn(STD, style, { occupied: occ });
    const live = beads(c, PIN_DOT_LIVE_R);
    gate(`10. ${style}: the occupied slot wears the live bead, and only it`,
      live.length === 1
      && Math.abs(live[0].arcs[0].x - inner) < 1e-9 && Math.abs(live[0].arcs[0].y) < 1e-9,
      `${live.length} live of ${wheelPinOffsets(STD, style).length} slots`);
    // …and the live bead is bigger than the empty one, which is what makes it
    // noticeable at 1× on a 30 px wheel.
    gate(`10. ${style}: live reads bigger than empty`,
      PIN_DOT_LIVE_R > PIN_DOT_R * 1.2, `${PIN_DOT_LIVE_R} against ${PIN_DOT_R}`);
  }
  // With nobody asking, nothing is live — a toolbar icon and a piece figure
  // draw a wheel with nothing on it, and that is the truth about them.
  gate('10. no occupancy passed means no live marks',
    PIN_STYLES.every((s) => beads(drawn(STD, s), PIN_DOT_LIVE_R).length === 0));
  // A rod end answers the same question as the slot it sits on.
  {
    const c = recCtx();
    drawRod(c, arm, { occupied: occ });
    gate('10. a stick\'s bolted end is live and its free end is not',
      beads(c, PIN_DOT_LIVE_R).length === 1 && beads(c, PIN_DOT_R).length === 1);
  }
  // A TILTED crate asks about its rotated corner while drawing the unrotated
  // one — the two lists are different, and conflating them lights the wrong
  // corner (which is why this gate names a 45° crate).
  {
    const g = { shape: 'box', x: 0, y: 0, w: 60, h: 30, angle: Math.PI / 4 };
    const corner = goalPinOffsets(g)[1];
    const occG = new Set([jointKey(g.x + corner[0], g.y + corner[1])]);
    const c = recCtx();
    drawGoalPiece(c, g, null, { occupied: occG });
    const live = beads(c, PIN_DOT_LIVE_R);
    // Checked in WORLD coordinates — the stub carries the canvas rotation, so
    // this asserts the whole round trip: the renderer asks about the rotated
    // corner, draws at the unrotated one, and the rotation it is already under
    // puts the mark back where the pin really is. Getting either half wrong
    // lights a different corner, which is the §6.2 bug in the other direction.
    gate('10. a tilted crate lights the corner that is really pinned',
      live.length === 1
      && Math.abs(live[0].arcs[0].x - (g.x + corner[0])) < 1e-9
      && Math.abs(live[0].arcs[0].y - (g.y + corner[1])) < 1e-9,
      `${live.length} live at (${live[0]?.arcs[0].x.toFixed(1)}, ${live[0]?.arcs[0].y.toFixed(1)}), pin at (${corner[0].toFixed(1)}, ${corner[1].toFixed(1)})`);
  }
}
setPinStyle('dots');

// ---------- 8. the slots are real, in the sim ----------
// The one failure this switch could actually cause: a wheel that DRAWS eight
// places to join and joints at four. So the diagonal is asked of the solver
// rather than of the lattice — it must make a joint under groove, and must not
// under dots, which is the same sentence as gate 3 from the other end.
const { initEngine, Simulation } = await import(u('public/js/sim.js'));
await initEngine(u('public/vendor/fcsim/fcsim.wasm'));
const flatLevel = () => ({
  terrain: [{ type: 'box', x: 0, y: 30, w: 3000, h: 60 }],
  props: [], buildZones: [{ x: 0, y: -75, w: 2400, h: 150 }],
  goalZones: [{ x: 400, y: -52, w: 120, h: 104 }],
  goalObjs: [{ shape: 'ball', x: -400, y: -15, r: 15 }],
  win: 'goalObj',
});
// Destroyed rather than dropped: a leaked b2World takes the process down with
// a libuv assertion on the way out, which reads as a failing gate file when
// every gate in it passed.
const jointsAt = (style, [ox, oy]) => {
  setPinStyle(style);
  const cy = -60;
  const s = new Simulation(flatLevel(), { parts: [
    { t: 'wheel', kind: 'free', r: STD, x: 0, y: cy, id: 'w' },
    { t: 'rod', kind: 'wood', x1: ox, y1: cy + oy, x2: ox + 60, y2: cy + oy - 40, id: 'arm' },
  ] });
  const n = s.jointRecs.length;
  s.destroy();
  return n;
};
const inner = STD;   // the ring is the RIM now (2026-08-17) — FC's spokes
const diagonal = [inner * Math.SQRT1_2, inner * Math.SQRT1_2];
// A slot that DRAWS and does not JOINT is the failure this whole lattice could
// actually cause, so both families are asked of the solver itself: the four
// cardinals every saved design is pinned to, and the four diagonals the groove
// added on top of them.
gate('8. a stick on a DIAGONAL slot joints', jointsAt('groove', diagonal) === 1,
  `${jointsAt('groove', diagonal)} joints`);
gate('8. …and so does one on a CARDINAL — the coordinate saved designs use',
  jointsAt('groove', [inner, 0]) === 1, `${jointsAt('groove', [inner, 0])} joints`);
// …and a coordinate that is on NO slot must still joint nothing, or the lattice
// is decorative and anything anywhere would stick.
gate('8. …while a coordinate between slots joints nothing',
  jointsAt('groove', [inner * 0.5, inner * 0.5]) === 0,
  `${jointsAt('groove', [inner * 0.5, inner * 0.5])} joints`);

// `summary()` sets `exitCode` and lets node exit naturally rather than calling
// `process.exit()`. This file found out why the hard way: one that imports
// render.js AND runs a Simulation aborts on the way out under Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, libuv
// src\win\async.c) — process.exit() tears the loop down while the wasm module
// still has an async handle open, and 40 passing gates then report as exit 127.
// The rule now lives in gatekit.mjs, so the whole family is safe from it and
// not just the file that got bitten.
// ---------- the light law: huge things do not get huge bevels ----------
//
// Reported: "Huge things don't need huge bevels and huge lighted edges. Grow
// in relation to ln of size?" — and ln is exactly right: the derivative of
// REF·(1 + ln(e/REF)) is REF/e, which is exactly 1 at e = REF, so the linear
// and log branches join with matching slope and there is no piece size where
// the rule visibly switches on.
{
  const { litExtent, LIGHT_REF, drawProp } = await import(u('public/js/render.js'));
  gate('L. on the ladder the light law is the identity',
    [1, 10, 20, 40, LIGHT_REF].every((e) => litExtent(e) === e),
    'every editor-placeable piece keeps the look the fractions were tuned on');
  gate('L. past it the growth is logarithmic, not linear',
    Math.abs(litExtent(400) - LIGHT_REF * (1 + Math.log(400 / LIGHT_REF))) < 1e-9
    && litExtent(400) < 400 / 2.5,
    `400 -> ${litExtent(400).toFixed(1)}`);
  gate('L. …and still monotonic — a bigger piece never gets a smaller light',
    [...Array(100)].every((_, i) => litExtent((i + 1) * 10) > litExtent(i * 10 + 1) - 1e-9));
  {
    // C1 at the joint: the numeric slope just below and just above REF agree,
    // which is the whole reason the log (and not sqrt, or a cap) was right.
    const h = 1e-6;
    const below = (litExtent(LIGHT_REF) - litExtent(LIGHT_REF - h)) / h;
    const above = (litExtent(LIGHT_REF + h) - litExtent(LIGHT_REF)) / h;
    gate('L. the two branches join with matching slope — no kink at the boundary',
      Math.abs(below - 1) < 1e-4 && Math.abs(above - 1) < 1e-4,
      `slope ${below.toFixed(6)} | ${above.toFixed(6)}`);
  }
  {
    // …and the painter really obeys it: the seat shadow of a half-400 crate is
    // shifted by litExtent(400)·0.10 in the light's direction, not by 40 px.
    // Recorded off the real drawProp, so a second copy of the law cannot
    // drift from this one.
    const seatShift = (half) => {
      const calls = [];
      const stub = { addColorStop() {} };
      const ctx = new Proxy({ canvas: { width: 64, height: 64 } }, {
        get: (t, k) => (k in t ? t[k]
          : (...a) => { calls.push({ k, a }); return /Gradient|Pattern/.test(k) ? stub : undefined; }),
        set: () => true,
      });
      drawProp(ctx, { shape: 'box', x: 0, y: 0, w: half * 2, h: half * 2 },
        { x: 0, y: 0, angle: 0 }, {});
      // the first translate after the piece's own (x, y) placement is the seat's
      const tr = calls.filter((c) => c.k === 'translate');
      const seat = tr[1];
      return seat ? Math.hypot(seat.a[0], seat.a[1]) : NaN;
    };
    const small = seatShift(40), huge = seatShift(400);
    gate('L. the painter obeys it — a half-400 crate\'s seat shifts by the tamed extent',
      Math.abs(small - 40 * 0.10) < 0.01
      && Math.abs(huge - litExtent(400) * 0.10) < 0.01 && huge < 40,
      `half-40 shifts ${small.toFixed(1)}, half-400 shifts ${huge.toFixed(1)} (linear would be 40.0)`);
  }
}

// ---------- boss pins: a flange with nine slots (2026-08-24) ----------
//
// "Boss pin. Ie bigger/shaped pin for multiple connections." — a loose pin
// with `r` offers its centre and eight rim slots, and the three parties that
// have to agree (snap, sim, drawing) all read util.loosePinOffsets. Gate B8
// builds the real Simulation: a stick hung on a rim slot hangs, one a hair
// off the slot falls — a slot that draws and does not joint is the failure
// worth money here, the same claim gate 8 makes for wheels.
{
  const { loosePinOffsets, BOSS_PIN_R } = await import(u('public/js/util.js'));
  const point = loosePinOffsets({ x: 5, y: 5 });
  const boss = loosePinOffsets({ x: 0, y: 0, r: BOSS_PIN_R });
  gate('B1. a plain pin is one point, a boss is nine', point.length === 1 && boss.length === 9);
  gate('B2. cardinals at exact r, no trig', [[BOSS_PIN_R, 0], [0, BOSS_PIN_R], [-BOSS_PIN_R, 0], [0, -BOSS_PIN_R]]
    .every(([x, y]) => boss.some(([ox, oy]) => ox === x && oy === y)));
  gate('B3. diagonals on the same circle', boss.filter(([x, y]) => x && y)
    .every(([x, y]) => Math.abs(Math.hypot(x, y) - BOSS_PIN_R) < 1e-9));

  const { initEngine, Simulation } = await import(u('public/js/sim.js'));
  await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));
  const level = {
    terrain: [{ type: 'box', x: 0, y: 130, w: 1200, h: 60 }],
    props: [], buildZones: [{ x: 0, y: -100, w: 900, h: 400 }],
    goalZones: [{ x: 400, y: 60, w: 100, h: 80 }],
    goalObjs: [{ shape: 'ball', x: -400, y: 80, r: 15 }],
    fixedParts: [], texts: [], groups: {},
    pins: [{ x: 0, y: -60, r: BOSS_PIN_R }],
  };
  const hangs = (x1, y1) => {
    const sim = new Simulation(level, { parts: [{ t: 'rod', kind: 'wood', x1, y1, x2: x1 + 70, y2: y1 + 40, id: 'r1' }] }, { headless: true });
    for (let i = 0; i < 60; i++) sim._fixedStep();
    const pose = sim._pose(sim.rods[0].body);
    sim.destroy();
    // held = the BOLTED END is still at the pin. The rod swings — its centre
    // travels a pendulum's arc — so the question is asked of end 1, which in
    // the BODY's frame is half the rod's length down its own −x axis.
    const half = Math.hypot(70, 40) / 2;
    const c = pose.c ?? 1, s = pose.s ?? 0;
    const ex = pose.x - c * half, ey = pose.y - s * half;
    return Math.hypot(ex - x1, ey - y1) < 4;
  };
  gate('B8. a stick on a rim slot HANGS from it', hangs(0 + BOSS_PIN_R, -60),
    'the cardinal slot at +r is a world bolt');
  gate('B8. …and one a hair off the slot falls', !hangs(0 + BOSS_PIN_R + 6, -60),
    'six px off the slot is nothing at all');
  gate('B8. the centre still bolts like the point pin it always was', hangs(0, -60));
}

section('wheels and cargo stack by size', () => {
  const bigW = { t: 'wheel', r: 40 };
  const smallW = { t: 'wheel', r: 10 };
  const tinyBall = { shape: 'ball', r: 8 };
  const crate = { shape: 'box', w: 60, h: 40 };
  gate('stack. a ball is its r, a crate is the larger half-side',
    goalStackR(tinyBall) === 8 && goalStackR(crate) === 30);
  const order = wheelCargoBackToFront([bigW, smallW], [tinyBall, crate]).map((it) =>
    it.kind === 'wheel' ? `w${it.ref.r}` : (it.ref.shape === 'ball' ? `b${it.ref.r}` : 'crate'));
  gate('stack. largest draws first: big wheel, crate, small wheel, tiny ball',
    order.join(' ') === 'w40 crate w10 b8', order.join(' '));
  gate('stack. a tiny goal sits in front of a big wheel',
    order.indexOf('b8') > order.indexOf('w40'));
});

summary();
