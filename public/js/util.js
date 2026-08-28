// util.js — DOM/storage/geometry/pins/Bézier/badges + the editor's pure rules.
// Editor, renderer and sim must all resolve pins and radii through these
// shared functions so joint keys can never disagree (§6).

// Two imports, both safe for the same reason: sizes.js and i18n.js are
// standalone (they import nothing), so there is no cycle. The NRW badge needs
// the same 250 the editor warns at, and two numbers that must agree are a
// number that will eventually disagree; el() below is the funnel every DOM
// string passes through, which is what lets t() translate the interface
// without a call site saying so.
import { PIN_WEIGHT_SAFE, STD_WHEEL_R, WHEEL_SIZES, DEFAULT_WHEEL_R, ROD_WEIGHT_MIN, ROD_WEIGHT_MAX,
 GRID_STEP, GRID_FINE, placeRung, rungRadius,
 rectCorners, boundsCorners, footprintOf, footprintInRect } from './sizes.js';
import { t, tf } from './i18n.js';
export { t, tf };

// The containment primitives moved to sizes.js so `fcimport.js` can reach them
// (see the note there). Re-exported under their own names, because every
// caller in this file and in game.js imports them FROM util.js and a move is
// not supposed to be a rename.
export { rectCorners, boundsCorners, footprintOf, footprintInRect };

// ---------- DOM ----------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
 const n = document.createElement(tag);
 for (const [k, v] of Object.entries(attrs)) {
 if (v == null) continue;
 // `false` means DON'T set it. For a boolean HTML attribute the presence of
 // the attribute is the whole signal, so setAttribute('disabled', false)
 // writes disabled="false" and disables the control — the exact opposite of
 // what the caller wrote. Every existing call site passes a literal `true`,
 // so this only ever mattered the first time someone computed one.
 if (v === false) continue;
 if (k === 'class') n.className = v;
 else if (k === 'html') n.innerHTML = v;
 else if (k === 'text') n.textContent = t(v);
 // Object.assign onto a CSSStyleDeclaration silently DROPS custom
 // properties: `style['--x'] = v` is a no-op, they only land through
 // setProperty. Splitting them out means a caller can pass one (--ctx-cols,
 // --tool-tint) without it quietly doing nothing.
 else if (k === 'style' && typeof v === 'object') {
 for (const [prop, val] of Object.entries(v)) {
 if (prop.startsWith('--')) n.style.setProperty(prop, val);
 else n.style[prop] = val;
 }
 }
 else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
 else if (k === 'dataset') Object.assign(n.dataset, v);
 // The four attributes a person reads. Everything else an attribute
 // carries — classes, hrefs, ids, data — is machinery, and translating
 // machinery is how a route stops routing.
 else if (k === 'title' || k === 'placeholder' || k === 'aria-label' || k === 'data-tip') n.setAttribute(k, t(v));
 else n.setAttribute(k, v);
 }
 for (const kid of kids.flat()) {
 if (kid == null || kid === false) continue;
 n.append(kid.nodeType ? kid : document.createTextNode(t(String(kid))));
 }
 return n;
}

// Native Element.append() stringifies non-Node arguments — a bare `null`
// from a `cond ? el(...) : null` pattern renders as the literal text "null"
// instead of being skipped. Use this instead of parent.append(...) whenever
// any argument might be conditionally null/false/undefined (el() itself
// already filters correctly for its OWN children; this is for call sites
// appending directly onto an existing element).
export function appendAll(parent, ...kids) {
 for (const kid of kids.flat()) {
 if (kid == null || kid === false) continue;
 parent.append(kid.nodeType ? kid : document.createTextNode(t(String(kid))));
 }
}

export function esc(s) {
 return String(s ?? '').replace(/[&<>"']/g, c => ({
 '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
 })[c]);
}

// ---------- storage (eng. prefix) ----------

export const store = {
 get(key, dflt = null) {
 try {
 const raw = localStorage.getItem('eng.' + key);
 return raw == null ? dflt : JSON.parse(raw);
 } catch { return dflt; }
 },
 set(key, val) {
 try { localStorage.setItem('eng.' + key, JSON.stringify(val)); } catch { /* full */ }
 },
 del(key) {
 try { localStorage.removeItem('eng.' + key); } catch { /* ignore */ }
 },
 // Our own keys, un-prefixed. Local solves are stored one key per level
 // (`localSolves.<levelId>`), which is right for a level screen and useless
 // for "what have I got saved" — the profile has to be able to sweep them up.
 keys(prefix = '') {
 try {
 const out = [];
 for (let i = 0; i < localStorage.length; i++) {
 const k = localStorage.key(i);
 if (k?.startsWith('eng.' + prefix)) out.push(k.slice(4));
 }
 return out;
 } catch { return []; }
 },
};

// ---------- ids, math ----------

let uidCounter = 0;
export function uid() {
 return Date.now().toString(36) + '-' + (uidCounter++).toString(36) + '-' +
 Math.floor(Math.random() * 1e9).toString(36);
}

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

export function wrapToPi(a) {
 while (a > Math.PI) a -= 2 * Math.PI;
 while (a < -Math.PI) a += 2 * Math.PI;
 return a;
}

// Seeded PRNG (mulberry32) — rendering noise only, never simulation (§5.8).
export function seedRand(seed) {
 let a = (seed | 0) || 1;
 return function () {
 a |= 0; a = (a + 0x6D2B79F5) | 0;
 let t = Math.imul(a ^ (a >>> 15), 1 | a);
 t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
 return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}

// ---------- pins (§6) ----------

// The ladder itself now lives in sizes.js, so the FC importer can snap a
// converted wheel onto it without dragging this file (and the DOM) into the
// server. Re-exported here because this is where the editor, the renderer and
// the sim have always read it from, and one canonical home beats two.
export { STD_WHEEL_R, WHEEL_SIZES, DEFAULT_WHEEL_R };
// **The wheel's face, in fractions of the wheel** (2026-08-15). These were 3
// and 15 flat, and the note here said to FREEZE them if the wheel sizes ever
// moved, because the ring radii are the joint-key lattice every saved design
// is built on. Path B moved them: a LIFIRIK pixel is an FC unit now and the
// standard wheel went 15 → 20, so the lattice a design was saved against no
// longer exists whatever these say, and freezing would have bought nothing
// except a standard wheel misread as a large one (`bigWheel` is r > 18, and 20
// is) — two rings on the middle wheel, its inner race adrift of its own rim,
// and eleven gates saying so.
//
// So: derived, at the ratios they have always had, and the freeze note's real
// intent survives in the better place — the RATIOS are frozen, and a future
// scale change carries the whole face with it instead of shearing it.
export const PIN_INSET = STD_WHEEL_R / 5; // 4 — pins sit inside the rim so
 // edge-pinned rods roll without thumping the
 // ground each rev
export const INNER_RING_R = STD_WHEEL_R; // 20 — the standard wheel's own race
 // (exported 2026-08-17: the pins
 // gate states the ring radii now)
// The one-letter names the Advanced bar's census and the wheel menu's Size row
// both print. Named here beside the sizes so the letter and the radius can
// never get out of step.
export const WHEEL_SIZE_LABELS = ['S', 'M', 'L'];

// ---------- which lattice a WHEEL offers ----------
//
// **There is one, and it is the GROOVE** (2026-08-12, on request: *"Get rid of
// Pin Wheels and the menu option. Grooves win!"*). The wheel carries a machined
// race per ring, divided into 4 / 8 / 8 + 16 slots (small / standard / large),
// and a slot only wears a bead when something is actually pinned in it.
//
// `dots` — four loose two-tone beads on one ring, plus eight at the rim on the
// large wheel — was the lattice every saved design was built on, and it was a
// play-testing switch beside `physicsMode` from 2026-08-11 until the trial
// ended here. (A third style, `swell`, was built and cut on 2026-08-12; it
// measured the dearest of the three, 173 µs against dots' 95 on a large wheel.)
//
// **Nothing came apart when it went, and this is why**: the groove's slots are
// a strict SUPERSET of the dots', ring for ring. The radii never moved, and 8
// is the four cardinals plus the four diagonals exactly as the large wheel's
// outer ring has always been — so every pin a saved machine is built on is
// still a slot, and every joint it had it still has. That property is what made
// the switch safe to flip in either direction while it existed, and it is what
// makes deleting the losing side a no-op for stored designs rather than a
// migration. Gated rather than asserted (verify-pins).
//
// `INNER_RING_R`'s freeze note below is the other half of the same promise, and
// it still stands: the RADII are the joint-key lattice, so they may not move
// whatever else does.

// How many slots a race of radius `rad` carries. MEASURED against the pin that
// lands in one rather than chosen: a pin is a 1.8 px disc (`PIN_DOT_R`) and two
// of them want about their own width of daylight between them, so the floor is
// 6 px of chord between neighbouring slots.
//
// ring 4.5 (small) 16 → 1.8 ✗ 8 → 3.4 ✗ 4 → 6.4 ✓
// ring 12 (std, and the large wheel's inner)
// 16 → 4.7 ✗ 8 → 9.2 ✓
// ring 27 (large rim) 16 → 10.5 ✓
//
// — which is exactly the 4 / 8 / 8 + 16 that was asked for, reached from the
// geometry so that a goal ball, or a wheel size that does not exist yet, gets
// an answer too instead of falling off the end of three hard-coded numbers.
//
// 4 / 8 / 16 and nothing between them, because each of those contains the one
// below it (the superset property above) and because they are the counts whose
// cardinals stay exact.
// …and the same treatment: 6 px of chord was 0.4 of the standard wheel's radius
// and still is. The worked example above is in the old numbers; multiply by 4/3.
export const SLOT_PITCH_MIN = STD_WHEEL_R * 0.4; // 8
const SLOT_COUNTS = [16, 8, 4];
export function ringSlots(rad) {
 for (const n of SLOT_COUNTS) if (2 * rad * Math.sin(Math.PI / n) >= SLOT_PITCH_MIN) return n;
 return 4; // a ring too small even for four still gets four — see the r 2 goal ball
}

// The rings as rings — radius and slot count. The renderer wants these (it
// draws a race per ring, not a dot per slot) and `wheelPinOffsets` expands them
// into the coordinates everything else joints on.
export function wheelRings(r) {
 // **The main ring sits ON THE RIM — exactly r, no inset** (2026-08-17, on
 // request, with the FC import work). FC's own wheels carry four attachable
 // spokes at radius r on the cardinals (fcsim graph.c `add_wheel`), and the
 // standard pins have to LAND on them or an imported machine bolted to a
 // wheel's rim misses its joints. The extras keep their angles (diagonals,
 // and the 16-slot odd family on big rims) at the same radius — 45° offset
 // from the standards, as specified. Graphically the groove moves out to
 // the rim and the detents point inward (render.js).
 const bigWheel = r > INNER_RING_R + PIN_INSET; // r > 24 → only the large wheel
 // Goal BALLS share this lattice and can be resized down to r 2 — without
 // the floor the ring inverts through the centre.
 //
 // **A sub-standard piece carries only its four standard detents**
 // (2026-08-17, on request: *"Any wheels/goal pieces smaller than standard
 // wheel have only 4 detents/pins."*). The extras — diagonals on rounds,
 // midpoints on crates — exist from standard size up. The chord floor
 // already said 4 for the small WHEEL's rim, but the rule is the PIECE's
 // size, not the ring's arithmetic: a goal ball between the rungs
 // (r 10.5–20) passed the floor and slipped through with 8, so it is
 // stated outright here and in `goalRings` rather than left to geometry
 // to imply.
 const rings = [];
 if (bigWheel) rings.push({ rad: INNER_RING_R, n: ringSlots(INNER_RING_R) }); // inner groove, LIFIRIK's own
 rings.push({ rad: Math.max(r, 1),
 n: r < STD_WHEEL_R ? 4 : ringSlots(Math.max(r, 1)) }); // the rim — FC's spokes live here
 return rings;
}

// One ring's offsets, in the order they have always come out. Cardinals are
// exact clean numbers (no trig) and the diagonals use `Math.SQRT1_2`, so both
// parties compute bit-identical floats; only the 16-slot ring's odd family
// needs cos/sin, and that is the same expression on both sides (§6.1).
function ringOffsets(rad, n) {
 if (n <= 4) return [[rad, 0], [0, rad], [-rad, 0], [0, -rad]];
 const d = rad * Math.SQRT1_2;
 const eight = [[rad, 0], [d, d], [0, rad], [-d, d], [-rad, 0], [-d, -d], [0, -rad], [d, -d]];
 if (n <= 8) return eight;
 const a = rad * Math.cos(Math.PI / 8), b = rad * Math.sin(Math.PI / 8);
 return [...eight, [a, b], [b, a], [-b, a], [-a, b], [-a, -b], [-b, -a], [b, -a], [a, -b]];
}

export function wheelPinOffsets(r) {
 const offs = [];
 for (const { rad, n } of wheelRings(r)) offs.push(...ringOffsets(rad, n));
 return offs;
}

export const GOAL_PIN_INSET = PIN_INSET; // the OUTERMOST ring/frame, where it
 // has always been — and the wheel's own inset,
 // which is what it was numerically all along

// **Concentric, filling the face** (2026-08-12, on request). A goal piece now
// wears the wheel's lattice repeated inward — rings on a ball, rounded-rect
// frames on a crate — so it reads as the same machined thing the machine
// attaching to it is, rather than as a coloured box with four dots on it. The
// crate gains the extra points the wheel gained when it grew its 8-slot ring.
//
// **The rings sit where the WHEEL's do, measured from the CENTRE** (2026-08-12,
// on request), and both numbers are DERIVED from the big wheel rather than
// typed: its grooves are at 12 and 27, so a base of 12 and a step of 15. A goal
// piece's two inner grooves are always those, whatever size the piece is, and
// then it keeps stepping outward by 15 until the next one would fall off the
// edge. An r 30 goal ball therefore wears exactly the grooves an r 30 wheel
// does, and an r 15 one wears the standard wheel's single 12.
//
// **Anchored at the centre, not at the edge.** The version before this stepped
// INWARD from the rim, which matched the wheel only at radii where the
// arithmetic happened to land — an r 40 ball came out with rings at 37/22/7,
// none of which is a wheel's. From the centre they cannot drift: 12 and 27 are
// 12 and 27 on every piece, and the edge just decides how many more there are.
// The price is that the outermost ring no longer always hugs the edge; a piece
// whose radius is not 12 + 15k carries bare face outside its last groove, which
// is the honest way round — a groove in the wrong place would be worse than a
// margin.
//
// Derived, so that a wheel size or an inset which moves takes the goal pieces
// with it instead of leaving two families quietly disagreeing about where a
// groove goes.
const BIG_WHEEL_RINGS = wheelRings(WHEEL_SIZES[WHEEL_SIZES.length - 1], 'dots').map((r) => r.rad);
export const GOAL_RING_BASE = BIG_WHEEL_RINGS[0]; // 12 — the wheel's inner ring
export const GOAL_RING_STEP = BIG_WHEEL_RINGS.length > 1
 ? BIG_WHEEL_RINGS[1] - BIG_WHEEL_RINGS[0] // 27 − 12 = 15
 : INNER_RING_R;
// The floor on both shapes: a ring or frame stops when its own slots would be
// closer together than `SLOT_PITCH_MIN`. On a circle that is four slots at
// 1.414·rad apart; on a rectangle it is the two corners along its shorter side.
const RING_MIN = SLOT_PITCH_MIN * Math.SQRT1_2; // 4.243
const FRAME_MIN = SLOT_PITCH_MIN / 2; // 3
const ringFits = (rad) => rad >= RING_MIN;

// **The rings and frames themselves**, which is what the renderer draws — the
// goal-piece twin of `wheelRings`. A ball's entry is `{rad, n}` like a wheel's;
// a crate's is `{a, b, pts}`, its half-extents plus the slots on it, because a
// rectangle's slots are not evenly spaced round it and cannot be regenerated
// from a count. `goalPinOffsets` expands these, so the drawing and the joints
// cannot disagree about where a slot is (§5.4).
export function goalRings(g) {
 // **The outermost ring/frame sits ON THE EDGE — exactly, no inset**
 // (2026-08-17, same request as the wheel rim). FC's goal rects carry their
 // attachable nodes at the CENTRE and the four EXACT corners (fcsim graph.c
 // `add_box`), so the standard pins must land there; the concentric inner
 // rings stay LIFIRIK's own. Same deal for balls: outer ring at r itself.
 if (g.shape === 'ball') {
 const out = [];
 for (let rad = GOAL_RING_BASE; rad < g.r - GOAL_RING_STEP / 2; rad += GOAL_RING_STEP) {
 out.push({ rad, n: ringSlots(rad) });
 }
 out.push({ rad: Math.max(g.r, 1), // the edge itself
 n: g.r < STD_WHEEL_R ? 4 : ringSlots(Math.max(g.r, 1)) }); // (see wheelRings: sub-standard = cardinals only)
 return out;
 }
 const hw = g.w / 2, hh = g.h / 2;
 const short = Math.min(hw, hh), diff = Math.abs(hw - hh);
 // The crate reading of the sub-standard rule (see wheelRings): a crate
 // that would FIT INSIDE the standard wheel's box keeps only its four
 // corners — the midpoints are the extras here. A plank is not "smaller
 // than the standard wheel" just because it is thin, so the test is the
 // LONG side, and a long-sided crate keeps its midpoints under the same
 // crowding rule as ever.
 const subStd = Math.max(g.w, g.h) < STD_WHEEL_R * 2;
 // One frame, built the same way wherever it comes from — the stepped ones and
 // the edge frame below both go through here, so a small crate is not quietly
 // poorer in pins than a big one at the same frame size.
 const frame = (a, b) => {
 const pts = [[a, b], [a, -b], [-a, b], [-a, -b]]; // the four corners
 // …and the midpoint of an edge long enough to carry one without crowding
 // the corners it sits between. A long thin crate gets them on its long
 // sides only, which is the honest answer rather than a symmetrical lie.
 if (!subStd && a >= SLOT_PITCH_MIN) pts.push([0, b], [0, -b]);
 if (!subStd && b >= SLOT_PITCH_MIN) pts.push([a, 0], [-a, 0]);
 return { a, b, pts };
 };
 const out = [];
 // Inner frames step outward on the SHORT axis as ever, stopping clear of
 // the edge frame so two frames never crowd within half a step.
 for (let s = GOAL_RING_BASE; s < short - GOAL_RING_STEP / 2; s += GOAL_RING_STEP) {
 out.push(frame(hw >= hh ? s + diff : s, hh >= hw ? s + diff : s));
 }
 // The EDGE frame — FC's own corners, exact — on every crate, whatever its
 // size. It is the frame a machine bolts to, so it exists even on a sliver.
 out.push(frame(Math.max(hw, 1), Math.max(hh, 1)));
 return out;
}

// **The same lattice in BOTH pin styles.** A wheel's dots and groove lattices
// are nested (§6.1), so switching cannot unjoint a machine; here there is
// nothing to nest — the concentric lattice IS the piece — so the styles share
// it outright and only the drawing differs. That is the stronger version of the
// same guarantee, and it is what replaced the note that used to sit here
// freezing goal balls on `dots`.
export function goalPinOffsets(g) {
 const offs = [[0, 0]]; // the middle, on both shapes
 for (const ring of goalRings(g)) {
 if (ring.pts) offs.push(...ring.pts);
 else offs.push(...ringOffsets(ring.rad, ring.n));
 }
 // **A BALL's lattice is rotation-free**, and stays so now that it has rings
 // rather than one: a circle has no orientation, so turning its authored angle
 // must not move a single pin under a rod already on one. Only a crate's
 // corners have to ride the angle (below).
 if (g.shape === 'ball') return offs;
 // Crates can be authored at an angle: the pins ride the corners. Rotating
 // HERE keeps every consumer agreeing on the same world coordinates — the
 // editor's drawn pins, the snap targets, and the sim's joint buckets — so a
 // rod snapped to a tilted crate's corner still joints exactly (§5.4).
 const a = g.angle || 0;
 if (!a) return offs;
 const c = Math.cos(a), s = Math.sin(a);
 return offs.map(([ox, oy]) => [ox * c - oy * s, ox * s + oy * c]);
}

// 0.1 px match tolerance — editor snapping guarantees exact shared floats,
// the key just absorbs representation noise (§5.4).
export function jointKey(x, y) {
 return x.toFixed(1) + ',' + y.toFixed(1);
}

// **A BOSS pin is a loose pin with a radius** (2026-08-24, on request:
// "Boss pin. Ie bigger/shaped pin for multiple connections."): a bolt
// flange fixed to the world, offering its CENTRE and eight rim slots — the
// cardinals at exact r (no trig, the wheels' own precedent) and the
// diagonals at r/√2 — so several sticks can fan off one anchor without
// piling onto a single coordinate. A pin without `r` is the point pin it
// always was, and returns just its centre.
export const BOSS_PIN_R = 20;
export function loosePinOffsets(pin) {
 const r = pin && pin.r;
 if (!r) return [[0, 0]];
 const d = r * Math.SQRT1_2;
 return [[0, 0], [r, 0], [0, r], [-r, 0], [0, -r], [d, d], [-d, d], [d, -d], [-d, -d]];
}

// **A powered wheel needs something on the hub to be a motor** (2026-08-24
// rod; 2026-08-26 any pin). The axle is a rod — any kind, rope links
// included — with an END on the wheel's hub, OR any other pin sitting on
// that same hub: a crate or ball goal-piece pin, a loose / boss pin, a
// prop pin, a terrain pin, or another wheel's pin (a standard wheel
// bolted to a large one by its axle). Same 0.1 px coordinate rule that
// makes any joint (jointKey). A rod on a spoke is bracing, not an axle;
// two wheels that only kiss at the rim are not an axle; a bare motor
// wheel dropped on the ground free-rolls like a free wheel until
// somebody gives it a shaft.
//
// The rule governs LIFIRIK's own build. An imported FC machine keeps FC's
// law (sim.js consults this only for unshelled wheels) — the bit-exact
// replay of FC designs is not up for renegotiation.
//
// `world` is the level (goalObjs / pins / props / terrain). Optional
// `goalPositions` is the sim's staged cargo, so a crate dragged onto a
// hub still counts as the shaft the joint plan will actually form.
export function wheelHasAxle(wheel, parts, world, goalPositions) {
 const hub = jointKey(wheel.x, wheel.y);
 const atHub = (x, y) => jointKey(x, y) === hub;
 for (const p of parts || []) {
 if (p === wheel) continue;
 if (p.t === 'rod') {
 if (atHub(p.x1, p.y1) || atHub(p.x2, p.y2)) return true;
 } else if (p.t === 'wheel') {
 for (const q of wheelPins(p)) {
 if (atHub(q.x, q.y)) return true;
 }
 }
 }
 if (!world) return false;
 const goals = world.goalObjs || [];
 for (let i = 0; i < goals.length; i++) {
 const g = goals[i];
 const pos = (goalPositions && goalPositions[i]) || g;
 for (const [ox, oy] of goalPinOffsets(g)) {
 if (atHub(pos.x + ox, pos.y + oy)) return true;
 }
 }
 for (const pin of (world.pins || [])) {
 for (const [ox, oy] of loosePinOffsets(pin)) {
 if (atHub(pin.x + ox, pin.y + oy)) return true;
 }
 }
 for (const p of (world.props || [])) {
 for (const q of propPins(p)) {
 if (atHub(q.x, q.y)) return true;
 }
 }
 for (const t of (world.terrain || [])) {
 for (const q of propPins(t)) {
 if (atHub(q.x, q.y)) return true;
 }
 }
 return false;
}

// The machine's drawn coordinates as one string — the FC importer writes it
// into fcWorld.print and the sim's _fcPristine recomputes it, so "is this
// still the machine the source shipped" is a comparison and not a guess
// (2026-08-17, the C loader). 4 dp, the resolution the editor stores at.
export function fcMachinePrint(fixedParts, designParts) {
 return [...(fixedParts || []), ...(designParts || [])]
 .filter(p => p.t === 'wheel' || p.t === 'rod')
 .map(p => (p.t === 'wheel'
 ? `w${p.x.toFixed(4)},${p.y.toFixed(4)},${p.r}`
 : `r${p.x1.toFixed(4)},${p.y1.toFixed(4)},${p.x2.toFixed(4)},${p.y2.toFixed(4)}`))
 .join(';');
}

// Rods laid in one gesture share a `chain` id, and that id is the whole of what
// makes a rod ROPE at all. It is additive and written once, at the moment of the
// gesture — so a triangle of sticks somebody pinned together by hand is never
// mistaken for one.
//
// **What joins to what is decided by GEOMETRY, not by the id.** Two ropes tied
// end to end are one rope, and nobody looking at them would say otherwise, so
// the graph below is built over every chain-tagged rod at once and the id is
// never grouped on. It answers only "is this rope?", never "which rope?".
//
// Keyed off the AUTHORED endpoints, never the drawn ones. Under load a pin
// separates by a fraction of a pixel (§5.4) — topology that moved with it would
// have the rope coming apart and rejoining frame to frame.
//
// `deg` counts link ENDS at a node, not links, so a node where two ropes meet
// end to end reads 2 (a through-point) exactly as the middle of one rope does.
function ropeNodes(rods) {
 const links = rods.filter((r) => r.chain);
 const ends = links.map((L) => {
 const p = L.part || L;
 return [jointKey(p.x1, p.y1), jointKey(p.x2, p.y2)];
 });
 const at = new Map();
 ends.forEach(([a, b], i) => {
 for (const k of [a, b]) {
 let n = at.get(k);
 if (!n) at.set(k, n = { deg: 0, links: [] });
 n.deg++;
 if (n.links[n.links.length - 1] !== i) n.links.push(i);
 }
 });
 return { links, ends, at };
}

// The rope graph walked into ordered runs, for DRAWING. A run is a stroke, and
// a stroke cannot fork — so a run stops at a loose end and at any junction,
// which is also where the pins that are really there come back. Delete a link
// out of the middle of a rope and the two halves come back as two runs rather
// than one run with a hole in it.
//
// **A run is not a piece.** Four strands meeting at a junction draw as four runs
// and count as two ropes; see `ropePieces`, which answers the other question.
export function ropeRuns(rods) {
 const { links, ends, at } = ropeNodes(rods);
 const runs = [];
 const used = links.map(() => false);
 const walk = (from) => {
 const seq = [];
 let key = from, closed = false;
 for (;;) {
 const node = at.get(key);
 const i = node ? node.links.find((j) => !used[j]) : null;
 if (i == null) break;
 used[i] = true;
 const L = links[i], fwd = ends[i][0] === key;
 seq.push({
 rod: L,
 ax: fwd ? L.x1 : L.x2, ay: fwd ? L.y1 : L.y2,
 bx: fwd ? L.x2 : L.x1, by: fwd ? L.y2 : L.y1,
 });
 key = fwd ? ends[i][1] : ends[i][0];
 if (key === from) { closed = true; break; } // back where it started
 if (at.get(key).deg !== 2) break; // a loose end, or a junction
 }
 return { links: seq, closed };
 };
 // Start at every END and every JUNCTION, so a run is only ever cut where the
 // rope really stops. Whatever is still unwalked after that is a closed loop —
 // which is exactly what a chain wrap makes — and can start anywhere.
 for (const [k, node] of at) {
 if (node.deg === 2) continue;
 while (node.links.some((i) => !used[i])) runs.push(walk(k));
 }
 for (let i = 0; i < links.length; i++) if (!used[i]) runs.push(walk(ends[i][0]));
 return runs;
}

// **How many pieces of rope is this?** — counted the way you would count real
// rope: how many separate lengths would you have to cut to lay this shape out?
//
// Per connected piece of the graph that is `max(1, odd / 2)`, where `odd` is how
// many nodes have an ODD number of link-ends at them. It is the Eulerian trail
// decomposition, and it is exactly the rule as stated in play:
//
// 1 rope → 1
// 2 ropes tied end to end → 1 (that is just a longer rope)
// 3 meeting at a junction → 2 (a rope, with one tied on)
// 4 meeting at a junction → 2
// 5 or 6 meeting at a junction → 3
// a closed loop (a chain wrap) → 1
// one rope cut in half → 2
//
// The reason it goes up only every OTHER strand: every strand at a junction has
// to belong to some rope, and a rope passing through a point accounts for two of
// them. Only an odd strand forces a new length of rope to start or stop there.
//
// Returns one entry per connected piece, because `designStats` needs the kind
// as well as the count.
export function ropePieces(rods) {
 const { links, ends, at } = ropeNodes(rods);
 const comp = new Array(links.length).fill(-1);
 const out = [];
 for (let s = 0; s < links.length; s++) {
 if (comp[s] !== -1) continue;
 const id = out.length;
 const stack = [s]; comp[s] = id;
 const nodes = new Set(); const mine = [];
 while (stack.length) {
 const i = stack.pop();
 mine.push(i);
 for (const k of ends[i]) {
 nodes.add(k);
 for (const j of at.get(k).links) if (comp[j] === -1) { comp[j] = id; stack.push(j); }
 }
 }
 let odd = 0;
 for (const k of nodes) if (at.get(k).deg % 2) odd++;
 out.push({
 pieces: Math.max(1, odd / 2),
 links: mine.length,
 // water only if EVERY link is: the WET badge asks whether there is any
 // wood at all (§11.4), so a rope of mixed kinds must not read as a wet one
 water: mine.every((i) => links[i].kind === 'water'),
 });
 }
 return out;
}

// Which of the three snap states a screen opens in (§8.1) — the DEFAULT, before
// the button or S has been touched.
//
// Pure, and here rather than inline in GameScreen's constructor, for the reason
// `undoReturnsToMaker` below is: the constructor is the one part of the editor
// no headless gate runs, so a rule living in it is a rule nothing can check.
//
// - a stored choice always wins;
// - failing that, the OLD boolean latch is migrated, so somebody who had it on
// stays on it. `saved`/`legacy` are read with a `null` default so a stored
// `false` is distinguishable from never having chosen — which the old
// default of `false` could not be;
// - a player who has never chosen gets OFF: nothing moves under the cursor,
// ever, whatever they are leaning on;
// - an author gets REVERSED, which is what the Maker has always done.
export function initialSnapMode({ saved = null, legacy = null, maker = false } = {}) {
 if (saved === 'on' || saved === 'rev' || saved === 'off') return saved;
 if (legacy === true) return 'on';
 if (legacy === false) return 'rev';
 return maker ? 'rev' : 'off';
}

// **Should Ctrl+Z leave this screen and go back to the last level of the
// session?** (§8.2. `makerReturn` in main.js is the remembered route.)
//
// A pure predicate, and in util.js rather than inline in the shell's keydown
// listener, for one reason: main.js cannot be imported headlessly, so a rule
// living there is a rule no gate can reach — and this one shipped wrong.
//
// It used to defer to the screen's own undo ONLY when the hash began `#/maker`.
// On a play screen that test never ran, so Ctrl+Z both undid the player's build
// (the editor's own handler, which is always bound) AND threw them out of the
// level, in one keypress.
//
// The four ways it must answer NO:
// - nothing remembered to go back to;
// - already at that level;
// - the screen has something of its own to undo — from ANYWHERE, because a
// player builds a machine on a play screen exactly as an author does;
// - it is a level you are PLAYING. The escape exists for the blank editor you
// land in by ACCIDENT (clicking "Maker" mints an empty draft); you opened a
// level to play it on purpose, and being thrown out of a run is not an undo.
export function undoReturnsToMaker({ path, makerReturn, canUndo }) {
 if (!makerReturn) return false;
 if (makerReturn === path) return false;
 if (canUndo) return false;
 if ((path || '').startsWith('/play')) return false;
 return true;
}

// One segment of a URL path, decoded — and never a throw. A truncated share
// link ("/play/abc%E4" clipped mid-escape by a chat client, or a bare trailing
// "%") makes decodeURIComponent throw URIError, and the router used to call it
// raw: the exception fired before any screen mounted, so the whole site was a
// blank page until the URL was edited by hand. A segment that doesn't decode
// is handed on AS TYPED instead — a garbage id then 404s into the normal "no
// such level" screen, which is the failure the player can actually act on.
// Here rather than inline in route() because main.js is unreachable headlessly
// and this has a truth table worth gating.
export function decodePathSegment(s) {
 try { return decodeURIComponent(s); } catch { return s; }
}

// A URL path split into the segments the router switches on. Pure, so the
// whole routing table is gateable without a browser — which is the point,
// since `route()` itself lives in main.js and nothing headless can reach it.
//
// Empty segments are dropped, so "/", "/browse/" and "//browse" all behave.
// The router reads `parts[0]` as the screen and the rest as its arguments, so
// an empty array IS the home page and needs no special case at the call site.
export function routeParts(path) {
 return String(path || '/').split('?')[0].split('/').filter(Boolean).map(decodePathSegment);
}

// Old `#/play/…` bookmarks and chat pastes. The app routes on the pathname
// now; a leftover fragment must become a real path or it silently opens Home.
// `#section` in-page anchors are not routes and stay null.
export function pathFromHash(hash) {
 const raw = String(hash || '');
 if (!raw.startsWith('#/')) return null;
 const path = raw.slice(1).split('&')[0];
 if (!/^\/[a-z][a-z0-9-]*(\/[^#]*)?$/i.test(path)) return null;
 return path;
}

// **Navigate.** The one place the app changes URL, and it lives here rather
// than in main.js so that game.js can call it too — the editor navigates
// (publish, open a draft) and importing main.js from game.js would be a cycle.
//
// The synthetic `popstate` is what closes that loop: `history.pushState` fires
// no event of its own, so the router would never hear a programmatic
// navigation. main.js listens for popstate and routes; dispatching one here
// means back/forward and in-app navigation arrive down the same pipe, and
// there is exactly one thing to subscribe to.
export function go(to, { replace = false } = {}) {
 const url = to.startsWith('/') ? to : '/' + to;
 // Setting the same URL used to be a no-op (assigning an unchanged
 // location.hash fires nothing), and staying a no-op keeps every caller that
 // quietly relied on it — "go back to the Maker" from inside that Maker, say
 // — behaving as it did.
 if (url === location.pathname + location.search) return;
 history[replace ? 'replaceState' : 'pushState'](null, '', url);
 window.dispatchEvent(new PopStateEvent('popstate'));
}

// **Does a press on the canvas STOP the running machine?** (§8.2.)
//
// Here rather than inline in `_pointerDown` for the reason that keeps coming
// up: a rule inside a DOM handler is a rule the headless suite reaches only by
// driving the whole handler, and this one has a truth table worth stating.
//
// The ask was *"any selection/key should stop it, apart from Fit, Grid toggle
// and playback speed"* — and the first cut over-applied it: EVERY press in the
// Maker stopped the run, empty canvas included. But a bare press on empty
// canvas is not a selection, it is a pan, which is the one thing you most want
// while watching a machine get somewhere. So:
//
// | Maker | on a piece | on empty canvas |
// |---|---|---|
// | **pointer tool** | stop — a select is not a look | **pan** |
// | **any other tool** | stop | stop |
//
// | play screen | anything |
// |---|---|
// | any tool | pan |
//
// **The tool is what separates a look from an edit.** With the pointer, a press
// on nothing is a pan and means nothing else. With a placement or delete tool
// armed, a press ANYWHERE is an edit about to happen — the empty canvas is
// precisely where a new piece would land — so it stops the run first, and the
// press is spent on the stop rather than also placing something (the same
// order `playSafeKey` keeps for keys, and for the same reason).
//
// The play screen never stops on a press at all: there the run IS the thing
// you are doing, and losing an attempt to a stray click throws it away. Space
// and the Stop button are its two ends.
//
// `onPiece` must be asked of the LIVE poses, not the authored ones — see
// `_liveHitAt` in game.js. Answering it from the authored geometry would stop
// the run when you clicked where a piece USED to be and pan when you clicked
// where it actually is, which is the wrong way round twice.
export function pressStopsRun({ mode, tool, onPiece }) {
 if (mode !== 'maker') return false;
 if (tool !== 'pointer') return true;
 return !!onPiece;
}

// ---------- when the scrub line is on screen (§7.4) ----------
//
// **Two conditions, both required** (2026-08-10, on request): *"invisible
// unless — 1. there is a play in action, ie scrubber relevant; 2. the mouse is
// within the area the scrubber will appear, ie someone looking for scrubber."*
// The line went back onto the play dock, where it can be found, and pays for
// the space it takes there by not taking it until both are true.
//
// Here rather than in `_syncScrub` because a rule that lives in a DOM method is
// a rule no gate can reach (§16), and this one has three edge cases that are
// each one line of code and one long afternoon of not noticing:
//
// **"A play in action" is a TAPE, not `playing`.** Scrubbing pauses the run
// (§7.4: the scrub's stop keeps the world on `_pausedSim` and `playing` goes
// false), so gating on `playing` would take the control away at the exact
// instant you used it. The tape is what "there is a run to look at" means, and
// it is the same thing `_syncScrub` already tests to fill the slider.
//
// **A scrubbed run keeps it, hover or not.** Once you have stepped off the live
// end there is a frame on screen that is not now, and the slider is the only
// thing that says which frame or moves you off it. Hiding it because the
// pointer wandered would leave somebody parked in the past with the way back
// invisible — and more so since the ⇥ button went (2026-08-10), because the
// way back is now the slider's own right-hand end rather than a second control.
//
// **A finger has no hover.** On a coarse pointer (§19) the second condition can
// never be met and would hide the line permanently, so touch gets the first
// condition alone — which is exactly what the control did before this change.
//
// **A RUNNING machine shows it unconditionally** (2026-08-23): while the run is
// live the row sits INLINE in the dock — the transport's own timeline — so
// there is no hover to wait for and no tape-fill race to lose: it is on from
// the first frame, before `hasTape` is even true, because the bar it replaced
// the buttons of is already showing.
export function scrubLineVisible({ hasTape, pointerNear, scrubbed, coarse, running }) {
 if (running) return true;
 if (!hasTape) return false;
 return !!(coarse || scrubbed || pointerNear);
}

// Where the row goes, and how close is close enough.
//
// **Above the dock when there is room, below it otherwise.** The desktop dock
// auto-places at the bottom of the canvas with 14 px under it, so "below" is
// off-screen; a phone's dock starts at the top beside the toolbar, where
// "above" is. The bar is draggable to either edge by hand, so neither side can
// be the constant, and this is a measurement rather than a guess.
//
// **The zone is computed from the DOCK, never from the row**, and that is what
// makes the reveal stable: the row is positioned absolutely and so the dock's
// own box is identical whether it is showing or not. A zone measured off the
// bar's box *with* the row in it would grow at the moment of showing and
// shrink at the moment of hiding — a control that flickers on its own boundary
// (§ bars park on their own threshold, four times over).
export const SCRUB_ROW_H = 26; // the row's own height, px — CSS holds the same number
export const SCRUB_ROW_GAP = 6; // the gap between it and the bar
export const SCRUB_ROW_MIN_W = 260; // …and its minimum width, likewise
export const SCRUB_NEAR_PAD = 52; // how far outside the bar still counts as "looking for it"

// **A VERTICAL bar gets a VERTICAL timeline** (2026-08-10, on request: *"I
// think the scrubber can also go vertical. Live/time sideways"*), and that is
// the fix for a real bug as much as it is a nicer shape: a horizontal row
// hanging off a one-button-wide column has to overhang it by 200 px, and with
// the bar parked on the RIGHT edge every one of those pixels was off the
// screen (reported as *"if the play bar is on the right and vertical scrubber
// goes off screen"* — 198 px of it, measured). Alongside the column it is 26 px
// wide and the overhang cannot happen at all.
//
// So the side is one of four, and it is the same measurement twice: the bar's
// orientation picks the axis, the room picks the end of it. `left`/`right` are
// the vertical pair, `above`/`below` the horizontal one, and the preferred one
// of each pair is the one that comes FIRST in reading order — a timeline
// before its transport.
//
// `row` is the row's OWN box once it is on screen, unioned in as a safety net:
// the zone is predicted from the dock and the side, and the union means a
// prediction that is a few pixels short still cannot hide the control under
// the cursor dragging it. It only ever makes the region BIGGER while it is
// showing, which is hysteresis in the right direction.
// **`view` is the room the row may actually OCCUPY**, in client coordinates —
// which is narrower than the window twice over, and both traps were found by
// looking at the thing rather than by reasoning about it:
// - the play area sits below the site nav, so a dock dragged to the top of the
// canvas still has ~50 px of screen above it and every pixel belongs to the
// nav. Measured from y=0 that said "above fits" and hung a slider over the
// Campaign link;
// - and the top of the canvas is spoken for by the level name and the
// Test/Create tabs, which are an OVERLAY rather than a layout box. On a
// phone the dock starts 60 px down, which looks like room and is the tab
// strip.
// `_scrubView` in game.js is the one caller and subtracts both.
export function scrubZone(dock, view, {
 orient = 'horizontal', row = null,
 rowH = SCRUB_ROW_H, gap = SCRUB_ROW_GAP, pad = SCRUB_NEAR_PAD, edge = 4,
} = {}) {
 // The row's thickness plus its gap — the same number on either axis, since
 // the vertical variant is the horizontal one turned on its side.
 const needs = rowH + gap;
 // The preferred side unless it would not fit, the other unless that does not
 // fit either — in which case the preferred one is still the lesser evil (it
 // overlaps chrome rather than falling off the edge of the world, where a
 // slider cannot be dragged at all). Decided from the DOCK alone: the row's
 // place is derived from this answer, so feeding its box back in is circular.
 const vertical = orient === 'vertical';
 const roomFirst = vertical ? dock.left - view.left - edge >= needs
 : dock.top - view.top - edge >= needs;
 const roomSecond = vertical ? view.right - dock.right - edge >= needs
 : view.bottom - dock.bottom - edge >= needs;
 const [first, second] = vertical ? ['left', 'right'] : ['above', 'below'];
 const side = roomFirst || !roomSecond ? first : second;
 let x0 = dock.left - (side === 'left' ? needs : 0);
 let x1 = dock.right + (side === 'right' ? needs : 0);
 let y0 = dock.top - (side === 'above' ? needs : 0);
 let y1 = dock.bottom + (side === 'below' ? needs : 0);
 if (row && row.width) {
 x0 = Math.min(x0, row.left); x1 = Math.max(x1, row.right);
 y0 = Math.min(y0, row.top); y1 = Math.max(y1, row.bottom);
 }
 return { side, x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
}

export function pointInZone(z, x, y) {
 return !!z && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
}

// ---------- the site nav hides itself on a game screen (§12.0) ----------
//
// (2026-08-11, on request: *"the top line (LIFIRIK and menu items) to auto hide
// during Test, Create and playing the game … should reappear if you go to the
// top couple of px of the screen"*.)
//
// WHICH SCREENS is a CSS question and is answered in CSS: `.main.full` is set by
// exactly two screens, play and the Maker, and `#app:has(.main.full)` is already
// how the stylesheet knows a game is up. Campaign, Workshop, `?`, ⚙ and ♥ are
// ordinary pages and keep their nav without anything being said about them.
//
// WHETHER IT IS SHOWING is this, because it is a rule with a threshold in it and
// thresholds are where these things go wrong.
//
// **Two of them, and the second is the whole point.** Reveal at 3 px is easy.
// Hiding again the moment the pointer leaves those 3 px is the trap: the nav
// appears UNDER the pointer, so the pointer is now inside a 53 px bar, one pixel
// of drift is already past the strip that summoned it, and the bar flickers on
// its own edge — the same failure the bars have hit four times over. So it
// leaves only once the pointer is clear of the whole bar it just revealed.
//
// `navH` is the nav's own measured height rather than a number here: it is one
// row on a desktop and two on a phone (the CSS wraps it at 560 px), and a
// constant would be wrong on one of them.
export const NAV_PEEK_IN = 3; // the strip at the very top of the screen that summons it
export const NAV_PEEK_OUT = 8; // …and the air past its bottom edge that sends it away

export function navShown(y, navH, showing) {
 if (!Number.isFinite(y)) return !!showing; // pointer gone (window blur) — leave it be
 if (y <= NAV_PEEK_IN) return true;
 if (!showing) return false;
 return y <= (navH || 0) + NAV_PEEK_OUT;
}

// ---------- how close is close enough to catch a pin? (§8.1, §19) ----------
//
// **"Improve touch snapping to closest pin… easier to use on a phone/tablet"**
// (2026-08-14, on request). Measured first, in scripts/probe-pinsnap.mjs, and
// the measurement changed the shape of the answer twice.
//
// The obvious worry is snapping to the WRONG pin, and it turns out not to
// exist: a standard wheel's pins are 9.18 px apart, so the old 6 px circle
// already held several of them at 1× and always has. Ambiguity is this
// design's normal state, and `_snapPoint` settles it the only stable way —
// nearest wins, and the winner glows before you let go. A wider radius
// therefore cannot invent a wrong joint that a narrow one would have got
// right. It can only turn a MISS into a hit, and on a phone the miss is the
// whole complaint: an endpoint left floating is a machine that comes apart on
// Play, where a neighbouring pin would still have held it together.
//
// So the radius wants a FLOOR, and there are two.
//
// * **The pin you can see.** The dot is drawn in WORLD px and the radius is
// screen px, so past about 3.3× zoom the old rule made the snap circle
// SMALLER THAN THE DOT — touch a pin squarely, get nothing. That was a
// plain bug on every pointer, mouse included, and `PIN_DOT` is the fix:
// whatever else, the radius covers the thing being aimed at.
// * **The fingertip.** 20 screen px, the low end of the 20–24 px radius
// every platform's touch guidance converges on. The swept cost table has
// no knee to appeal to — the captured area is near enough linear in the
// radius — so the number comes from the hand, and the table's job was to
// price it: at 20 px a finger must stay one wheel's width clear of a piece
// to place an endpoint that does NOT join, and 92% of the nearby canvas is
// still free. That is the whole cost.
//
// The mouse keeps its 6: a cursor is one pixel wide and was never the
// complaint. Both are SCREEN px — divided by zoom on the way out — which is
// what lets zooming in still separate pins a finger cannot.
export const SNAP_MOUSE = 6; // screen px
export const SNAP_TOUCH = 20; // screen px — a fingertip's own scale

// **The three steps an arrow key moves a selection by** (§8.2): a whole pixel
// with Shift+Alt, a tenth on its own, a hundredth with Alt. Arrows are the one
// gesture on this canvas where sub-pixel placement is possible at all, and
// these are how far it goes.
//
// Here rather than in game.js because a second user turned up: GhostRun's pin
// sweep offers exactly these three resolutions (`PIN_GRID_STEPS` below), and
// that has to be true BY CONSTRUCTION rather than by two lists agreeing. Every
// cell of every rung is then somewhere the player could have nudged the pin to
// by hand, which is the difference between searching the space they build in
// and searching a finer one nobody can reach.
export const NUDGE_STEPS = [1, 0.1, 0.01];
// World px, and it IS render.js's PIN_DOT_R — the whole point is that the
// radius covers the DRAWN dot, so the two being the same is the rule rather
// than a coincidence. It used to be a second literal here with a gate watching
// for drift, and on 2026-08-15 the drift happened: Path B scaled the drawn dot
// with the wheel and left this one at 1.8, so a pin's snap radius stopped
// covering the pin. render.js imports it from here now (it cannot go the other
// way — render.js already imports this file), which is the version that cannot
// drift at all.
export const SNAP_PIN_DOT = STD_WHEEL_R * 0.12; // 2.4 (was 1.8 at r 15)

// World px, ready to compare against a world-space distance.
export function snapRadius(zoom, coarse) {
 const screen = coarse ? SNAP_TOUCH : SNAP_MOUSE;
 const z = Number.isFinite(zoom) && zoom > 1e-6 ? zoom : 1;
 return Math.max(screen / z, SNAP_PIN_DOT);
}

// ---------- does this viewer want motion? (§19) ----------
//
// There was no answer to this anywhere in the JavaScript — one line of CSS and
// nothing else — while the canvas runs several loops of its own that no
// stylesheet can reach.
//
// Live rather than cached: the setting can be changed while the tab is open,
// and an alarm that keeps breathing because the page was loaded an hour ago is
// exactly the complaint. `matchMedia` is absent headlessly, so the gates and
// the probes get `false` and keep measuring the moving version.
//
// **It is not a licence to freeze everything.** Motion that carries
// information no other channel carries has to keep it or replace it — the
// belt loop is the case in point: its direction IS the sign of tangentSpeed
// and there is nothing else on the piece that says which way a conveyor
// pushes. What this is for is motion that is pure emphasis, where holding the
// brightest frame says the same thing without the flicker.
export function reducedMotion() {
 return typeof matchMedia === 'function'
 && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- does this device get shortcut hints? (§19) ----------
//
// **"Remove keyboard short cuts in toolbars, if no keyboard"** (2026-08-14, on
// request). Every tool button wears its key in the corner and names it again in
// the tooltip, and each bar's grip wears the letter that folds it — all of
// which teaches a phone player nothing at all, in the corners of the smallest
// buttons on the smallest screen.
//
// **There is no media query for "has a keyboard", so the rule is evidence.**
// `(pointer: coarse)` says the primary pointer is a finger, which is the best
// thing available at load, and it gets the common cases right in both
// directions: a desktop is untouched, and a phone loses badges it could never
// use. What it gets wrong is the tablet with a keyboard case — so a keydown
// that reaches the editor's own shortcuts is taken as proof, and the badges
// come back for the rest of the session.
//
// The proof has to be a keydown the EDITOR sees, not any keydown on the page:
// a soft keyboard fires plenty while somebody types a level name, and those
// never reach here (game.js returns early when a field owns the key). So the
// evidence is "a key was pressed AT the editor", which a soft keyboard cannot
// produce and a real one produces almost immediately.
//
// Here rather than in game.js because it is a rule, and rules in a constructor
// or a DOM handler are unreachable to a gate.
export function showsKeyHints(coarse, keySeen) {
 return !coarse || !!keySeen;
}

// ---------- drag past the end = fast forward (§7.4) ----------
//
// **How far past the slider's end you are, as a speed** (2026-08-10, on
// request: *"drag the slider past the end (it doesn't move, just my mouse) and
// it fast forwards the simulation. As though I were pressing Shift+→
// rapidly"*).
//
// Shift+→ is one second of future per press, so "rapidly" is the top of this
// ramp: hold the pointer a screen's width past the end and the machine winds on
// at roughly a dozen seconds of simulated time per real second. A nudge past
// the end is 1×, which is the same gesture used gently.
//
// **The DEADZONE is doing more work than it looks like.** The thumb sits AT the
// end whenever you have scrubbed to it, so without slack a hand resting on the
// slider would creep the run forward on its own. And since the gesture carries
// NO modifier — it is the ordinary drag, continued — the slack also has to
// absorb the way people actually reach a maximum, which is to shove the pointer
// comfortably past it and let go. 24 px is about the overshoot of "I want the
// end" and well inside the deliberate pull of "I want more"; at 6× it is also
// the point below which a flick-and-release cannot buy a whole second of
// future by accident.
//
// Pure, and here, because these are feel numbers: they are the whole character
// of the gesture and are meant to be turned by somebody watching it, not hunted
// for inside a pointer handler.
export const SCRUB_FF_DEADZONE = 24; // screen px past the end before anything happens
export const SCRUB_FF_PER_PX = 1 / 18; // …then a second of future per real second per px
export const SCRUB_FF_MAX = 12; // seconds of future per real second, at full stretch
// The wind's per-frame WALL budget (2026-08-24, "when scrubbing forward,
// animation should keep up as best it can"). The asked-for rate is a wish;
// what a heavy machine can simulate inside a frame is the fact — past this
// many milliseconds the frame ships with whatever future got made, and the
// next frame carries on. The animation stays at frame rate and the rate
// degrades, instead of the other way round.
export const SCRUB_FF_BUDGET_MS = 10;

export function scrubFastForwardRate(overshootPx) {
 const past = (overshootPx || 0) - SCRUB_FF_DEADZONE;
 if (!(past > 0)) return 0;
 return Math.min(SCRUB_FF_MAX, past * SCRUB_FF_PER_PX);
}

// How far past the end the pointer is, in the direction the slider RUNS.
// A vertical scrub line (a vertical dock, §7.4) puts its end at the bottom,
// because `writing-mode: vertical-lr` runs min→max downward — so the overshoot
// that means "more" is downward there and rightward on a horizontal one.
export function scrubOvershoot(rect, x, y) {
 return rect.height > rect.width ? y - rect.bottom : x - rect.right;
}

// ---------- arrow keys that SNAP (§8.1) ----------
//
// Where a Shift/Alt-arrow lands a coordinate: the next grid line strictly in
// the pressed direction — or exactly one grid stride when already ON one (the
// eps absorbs float noise, so "on a line" is not a knife edge that turns a
// stride into a no-op). `offset` is the piece's own alignment offset
// (game.js's _gridOffset), so a wheel steps cell-centre to cell-centre and a
// box its corner, exactly as the same modifiers place them in a drag. Also
// the arithmetic for angle snapping — degrees are just a coordinate whose
// grid is 45 or 10.
export function snapStep(c, dir, grid, offset = 0) {
 if (!grid || !dir) return c;
 const rel = (c - offset) / grid, eps = 1e-6;
 const k = dir > 0 ? Math.floor(rel + eps) + 1 : Math.ceil(rel - eps) - 1;
 return k * grid + offset;
}

// ---------- the "inspired by" link (§11.9) ----------
//
// What an author may paste into the credit box: a level LINK (any URL whose
// path contains /play/<id>) or a bare id. Returns the id, '' for an empty
// box (meaning "no credit"), and null for text that is neither — so the
// dialog can refuse junk instead of the server storing it. The charset is
// the union of both uid mints (server ids are 11 base64url chars, client
// ones carry hyphens), deliberately loose on length: the server resolves
// the id against real rows anyway, this only decides what LOOKS like one.
export function levelIdFrom(text) {
 const t = String(text || '').trim();
 if (!t) return '';
 const m = t.match(/\/play\/([A-Za-z0-9_-]{6,40})/);
 if (m) return m[1];
 if (/^[A-Za-z0-9_-]{6,40}$/.test(t) && !/^https?$/i.test(t)) return t;
 return null;
}

// ---------- touch gestures (§19) ----------
//
// The whole of what a finger can say, as numbers and one pure function —
// here rather than in game.js's pointer handlers for the reason everything
// in this neighbourhood is: the handlers can be DRIVEN headlessly, but the
// numbers a gesture turns on should be checkable without driving anything.
//
// One finger IS the mouse's left button and takes no translation: pointer
// events already deliver it to the same handlers. What needs deciding is
// everything a mouse has that a finger hasn't — a second button, a wheel,
// hover, and modifier keys — and the answers are:
//
// second finger pinch: zoom about the pair's centroid, pan with it.
// Whatever one finger had STARTED is cancelled, not
// committed — a second finger landing means "I wanted the
// camera", and half a gesture kept would be a surprise.
// hold still the piece's own menu (the right button's job). Hold for
// LONG_PRESS_MS without wandering past TOUCH_SLOP.
// double tap the double-click: whole-machine select, a label's words.
// modifiers latching chips on the toolbar (Grid / Multi / Fine) —
// a latch rather than a hold, because the second finger
// that would hold one down already means pinch.

// How long a finger holds still before the press becomes the piece's menu.
// 500 is the platform convention (both Android and iOS open context menus
// there); shorter fires while people line up a careful drag.
export const LONG_PRESS_MS = 500;

// How far (screen px) a press may wander and still be a TAP or a LONG-PRESS
// rather than a drag. Fingers are not mice: a mouse click moves 0–2 px, a
// finger rolling as it presses moves 5–10 on its own. 12 keeps a deliberate
// hold from being disqualified by its own pulse while staying well under the
// 30 px a real drag crosses immediately.
export const TOUCH_SLOP = 12;

// Two taps this close together, this near each other, are a double tap.
// Times are ms, distance screen px. 400/40 rather than the desktop's
// 500/4 because a second tap lands where a finger lands, not where a
// pixel-perfect cursor was parked.
export const DOUBLE_TAP_MS = 400;
export const DOUBLE_TAP_PX = 40;

// One pinch step: the camera change that takes the two fingers' PREVIOUS
// pair of positions to their CURRENT pair. Pure — screen px in, screen px
// out — so the arithmetic is checkable on its own:
//
// factor how much the spread grew (1 = none). Guarded: two fingers
// reported at the same point (it happens, briefly, on real
// hardware) must not divide by zero or teleport the zoom.
// cx, cy the CURRENT centroid — zoom about this, so the world point
// between the fingers stays between the fingers;
// dx, dy how far the centroid travelled — pan by this, so two fingers
// moving together drag the world with them.
//
// Zoom first, about the new centroid, then pan by the centroid's travel:
// each half is exact on its own axis and the cross-term they leave is one
// frame's worth, which the next event corrects. Every mainstream map app
// does it this way for the same reason.
export function pinchUpdate(prev, cur) {
 const spread = (p) => Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
 const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
 const d0 = spread(prev), d1 = spread(cur);
 const c0 = mid(prev), c1 = mid(cur);
 return {
 factor: d0 > 1e-6 && d1 > 1e-6 ? d1 / d0 : 1,
 cx: c1.x, cy: c1.y,
 dx: c1.x - c0.x, dy: c1.y - c0.y,
 };
}

// Does this tap complete a double tap? `last` is the previous tap's record
// {t, x, y} or null; `now`/`x`/`y` are the current one. Pure so the gate can
// hold the thresholds still.
export function isDoubleTap(last, now, x, y) {
 return !!last && (now - last.t) <= DOUBLE_TAP_MS
 && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_PX;
}

// **Which campaign level follows this one?** Returns the record, or null when
// there isn't one to offer.
//
// Here rather than in main.js for the usual reason — the shell cannot be
// imported headlessly, so a rule living there is a rule no gate can reach —
// and this one has four ways of answering "no", three of which are easy to
// get wrong by hand:
//
// - not a campaign level at all (a Workshop level has no slot);
// - the last one, so there is nothing after it;
// - a gap in the slots, which the store allows — parking a level leaves one,
// and stepping into a hole would 404 rather than reading as "the end";
// - the next one is past the free window and nobody is signed in. The campaign
// grid shows those as 🔒 because the card is the advert, but a win banner is
// the wrong place to meet a paywall: you have just finished something.
//
// `levels` is whatever the officials endpoint returned — it carries the parked
// ones too (official, no slot), so the slot test has to be explicit rather than
// an index into the array.
export function nextCampaignLevel({ slot, levels, freeSlots = 32, signedIn = false }) {
 if (slot == null || !Number.isInteger(slot)) return null;
 const next = (levels || []).find((l) => l && l.official && l.slot === slot + 1);
 if (!next) return null;
 if (!signedIn && next.slot >= freeSlots) return null;
 return next;
}

// …and the one BEFORE, on the same four terms, for the play screen's ‹ ^ ›
// (2026-08-19: "Instead of the '<Back' in the top left corner I
// would like '<^>' previous/back/next level in the campaign"). The lock rule
// is kept for symmetry — a previous level is a lower slot and is never the
// one behind the free window in practice, but the function should not know
// that; slot 0 has nothing before it, and a hole reads as "the start".
export function prevCampaignLevel({ slot, levels, freeSlots = 32, signedIn = false }) {
 if (slot == null || !Number.isInteger(slot) || slot <= 0) return null;
 const prev = (levels || []).find((l) => l && l.official && l.slot === slot - 1);
 if (!prev) return null;
 if (!signedIn && prev.slot >= freeSlots) return null;
 return prev;
}

// The inner end of a detent tick, in the pin's local offset space. A detent
// runs from the slot (the joint) toward the piece centre; pointing at the
// tick, not only the gold dot, should still catch the pin.
export function detentInner(ox, oy, pieceR) {
 const rad = Math.hypot(ox, oy);
 if (rad < 1e-6) return null;
 const w = STD_WHEEL_R * 0.12; // GROOVE_W — util cannot import render.js
 const over = STD_WHEEL_R * (0.8 / 15); // DETENT_OVER
 const onEdge = rad > (pieceR || rad) - w;
 const index = Math.abs(oy) < 1e-6 && ox > 0;
 const k = index ? 2.4 : 1;
 const inner = onEdge ? rad - (w + over) * k : rad - (w / 2 + over) * k;
 const s = Math.max(0, inner) / rad;
 return [ox * s, oy * s];
}

// Absolute pin lists for editor/renderer use.
export function wheelPins(w) {
 const pins = [{ x: w.x, y: w.y, isCenter: true }];
 for (const [ox, oy] of wheelPinOffsets(w.r)) {
 const p = { x: w.x + ox, y: w.y + oy };
 const inner = detentInner(ox, oy, w.r);
 if (inner) { p.dx = w.x + inner[0]; p.dy = w.y + inner[1]; }
 pins.push(p);
 }
 return pins;
}

export function goalPins(g, pos) {
 const cx = pos ? pos.x : g.x, cy = pos ? pos.y : g.y;
 const edge = g.shape === 'ball' ? (g.r || 0) : Math.hypot((g.w || 0) / 2, (g.h || 0) / 2);
 return goalPinOffsets(g).map(([ox, oy]) => {
 const p = { x: cx + ox, y: cy + oy };
 const inner = detentInner(ox, oy, edge);
 if (inner) { p.dx = cx + inner[0]; p.dy = cy + inner[1]; }
 return p;
 });
}

export function rodPins(r) {
 return [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }];
}

// A prop carries an ARRAY of pins, each optionally `fixed` (bolted to the
// static background as well as to whatever else shares the coordinate).
// Levels authored before props had more than one pin stored a single
// `prop.pin`, which was always background-bolted — so it reads as one fixed
// pin. Kept as a pure accessor rather than a migration pass so an old level
// loaded straight from the DB works without being rewritten first.
export function propPins(p) {
 if (Array.isArray(p.pins)) return p.pins;
 if (p.pin) return [{ x: p.pin.x, y: p.pin.y, fixed: true }];
 return [];
}

// **Pins on ANY piece.** Terrain carries them now too (2026-08-07), in the
// same shape and the same world coordinates — so the reader is the same
// function under a name that admits it. `propPins` keeps its own name where
// the legacy single `pin` field is the point; everything that just wants
// "the pins on this thing" asks this.
//
// What a pin MEANS depends on what it is on, and that falls out of the
// physics rather than needing a flag: on a prop it is an attachment point on
// a free body; on STATIC terrain it is a bolt to the world (a hinge that
// holds); on a MOVING platform it is a hinge that travels. One rule, three
// useful behaviours.
export const piecePins = propPins;

// **Which pin coordinates have something ON them** (2026-08-12) — so a wheel
// can draw an occupied slot differently from an empty one, in every pin style.
//
// The rule is the SIM'S OWN: a pin is occupied when a second pin shares its
// coordinate (§5.4, the same `jointKey` buckets `_buildJoints` pairs on). Two
// consequences worth stating, because both were the alternative:
//
// - **Asked of the AUTHORED design, never of live poses.** Under load a joint
// separates by a fraction of a pixel, so occupancy read off `_pose` would
// flicker a mark on and off while a machine strains — and it would go on
// lying after a body slept somewhere its pin never was.
// - **Counted, not attributed.** "Whose pin is this" needs bookkeeping that
// can disagree with the solver; "how many pins are at this coordinate"
// cannot. A wheel's own pin is one of the two, which is why the test is
// seen-twice rather than seen-at-all.
//
// One pass over every pin in the level, returning a Set of keys. The caller
// does this ONCE per frame and hands the Set to every piece it draws.
// **How many PARTIES meet at each pin coordinate** (2026-08-24, "it should
// be a pin count… pins on things count. eg. Wheels, goal pieces, prop pins,
// background pins."). One walk over everything that owns a pin — each rod
// END, each wheel pin, each goal-piece pin, each prop and terrain pin, each
// loose-pin slot (boss flanges included) — counting one per party. The bolt
// ladder's shape reads this number; `occupiedPins` derives from the same
// walk, so liveness and the ladder cannot disagree about who is present.
export function pinOwnerCounts(design, level, goalPositions = null) {
 const counts = new Map(), loose = new Set();
 const hubs = new Map(), rims = new Map();
 const at = new Map(); // jointKey → [{kind, id}]
 const hubByEnt = new Map(); // wheel id → its hub key
 const add = (x, y, kind = 'other', id = null) => {
 const k = jointKey(x, y);
 counts.set(k, (counts.get(k) || 0) + 1);
 if (kind === 'hub') hubs.set(k, (hubs.get(k) || 0) + 1);
 else if (kind === 'rim') rims.set(k, (rims.get(k) || 0) + 1);
 if (id != null) {
 let arr = at.get(k);
 if (!arr) at.set(k, arr = []);
 arr.push({ kind, id });
 }
 };
 const addPart = (p, tag) => {
 if (!p) return;
 if (p.t === 'wheel') {
 const id = 'w:' + (p.id || tag);
 add(p.x, p.y, 'hub', id);
 hubByEnt.set(id, jointKey(p.x, p.y));
 for (const q of wheelPins(p)) {
 if (q.isCenter) continue;
 add(q.x, q.y, 'rim', id);
 }
 } else if (p.t === 'rod') {
 const id = 'r:' + (p.id || tag);
 add(p.x1, p.y1, 'rod', id);
 add(p.x2, p.y2, 'rod', id);
 }
 };
 (design?.parts || []).forEach((p, i) => addPart(p, 'd' + i));
 (level?.fixedParts || []).forEach((p, i) => addPart(p, 'f' + i));
 // Staged cargo pose (a drag before Play) is where joints actually form —
 // the authored spawn is the wrong coordinate once the piece has been moved.
 for (let i = 0; i < (level?.goalObjs || []).length; i++) {
 const g = level.goalObjs[i];
 const id = 'g:' + i;
 for (const q of goalPins(g, goalPositions?.[i])) add(q.x, q.y, 'other', id);
 }
 (level?.props || []).forEach((p, i) => {
 const id = 'p:' + (p.id || i);
 for (const q of piecePins(p)) add(q.x, q.y, 'other', id);
 });
 (level?.terrain || []).forEach((t, i) => {
 const id = 't:' + i;
 for (const q of piecePins(t)) add(q.x, q.y, 'other', id);
 });
 // the world is one party, at EVERY slot a loose pin offers (a boss flange
 // is nine of them) — and the coordinate is occupied by the pin alone,
 // which is what `loose` records for occupiedPins below
 for (const q of (level?.pins || [])) {
 const id = 'pin:' + jointKey(q.x, q.y);
 for (const [ox, oy] of loosePinOffsets(q)) {
 add(q.x + ox, q.y + oy, 'other', id);
 loose.add(jointKey(q.x + ox, q.y + oy));
 }
 }
 return { counts, loose, hubs, rims, at, hubByEnt };
}

// A wheel keeps at most ONE joint with a non-rod body (sim.js `_buildJoints`).
// If they already share the hub, every extra rim coincidence is lattice noise
// — a crate sitting on a large wheel shares the hub AND its four inner-ring
// cardinals, and lighting those four is the "pins lighting up that should not".
function extraRimNoise({ at, hubByEnt }) {
 const drop = new Set();
 if (!at || !hubByEnt) return drop;
 for (const [wid, hubK] of hubByEnt) {
 const mates = new Set();
 for (const p of (at.get(hubK) || [])) {
 if (p.id !== wid && p.kind !== 'rod') mates.add(p.id);
 }
 if (!mates.size) continue;
 for (const [k, parties] of at) {
 if (k === hubK) continue;
 // an axle lives here — never drop a hub coincidence
 if (parties.some((p) => p.kind === 'hub')) continue;
 if (!parties.some((p) => p.id === wid && p.kind === 'rim')) continue;
 if (parties.some((p) => p.kind === 'rod')) continue;
 const rest = parties.filter((p) => p.id !== wid);
 if (rest.length && rest.every((p) => mates.has(p.id))) drop.add(k);
 }
 }
 return drop;
}

export function occupiedPins(design, level, owners = null) {
 const o = owners || pinOwnerCounts(design, level);
 const { counts, loose, hubs, rims } = o;
 const twice = new Set(loose);
 const drop = extraRimNoise(o);
 for (const [k, n] of counts) {
 if (n < 2) continue;
 if (drop.has(k)) continue;
 // Two wheels' rim slots coinciding is lattice noise, not a joint —
 // sim.js attaches them by an axle and skips the extra hinges. Lighting
 // those up is the "random pins highlighted" on a small wheel sitting
 // on a large one.
 const rim = rims.get(k) || 0;
 const hub = hubs.get(k) || 0;
 if (hub === 0 && (n - rim) === 0) continue;
 twice.add(k);
 }
 return twice;
}

// ---------- FC ghost lines: what they actually stop (2026-08-21) ----------
//
// An FC ghost line is FC's zero-width DynamicRectangle — an invisible static
// line at home, imported as terrain and DRAWN at stick thickness so there is
// something to see (render.js `drawGhostLine`, COLORS.ghostLine). Its BODY is
// the degenerate box FC gives it, and the consequence is the thing the colour
// was chosen to warn about: *"a slightly different orange to alert to the fact
// they allow rods through"*.
//
// **Measured, dropping one of each onto one** (and onto ordinary terrain as a
// control, where every row is HELD):
//
// wood stick PASSED THROUGH wheel r20 HELD
// water stick PASSED THROUGH goal ball r15 HELD
// goal crate PASSED THROUGH
//
// So: **a ghost line is solid to ROUND things and to nothing else.** Boxes —
// sticks, crates, box props — go straight through, because a degenerate box
// meets another box with no manifold to push on, while a circle meets it with
// one.
//
// The editor did not know any of this and treated a ghost line as ordinary
// terrain, which is what the report was: *"I should be able to put rods through
// ghost blocks. Not wheels. It is stopping me editing as 'no rods through
// terrain'."* Both halves are here so the editor and the physics cannot hold
// two opinions — the sim gets the same answer from `terrainCollider` below.
export const isGhostLine = (t) => !!(t && t.line);

// Does this terrain piece stop a thing of this shape? `'round'` is a wheel, a
// ball prop, a ball goal piece; `'box'` is a stick, a crate, a box prop.
// Everything that is not a ghost line stops everything.
export function terrainBlocks(t, shape) {
 return !isGhostLine(t) || shape === 'round';
}

// The BODY a terrain piece really is, as against the box it is DRAWN as. For a
// ghost line those are different things — 8 px on screen, zero in the world —
// and measuring the drawn one is why a wheel resting exactly ON a ghost line
// was refused by the editor for being 4 px "inside" it. The sim builds its body
// from this too, so there is one geometry and not two.
export function terrainCollider(t) {
 if (t?.line === 'w') return { ...t, w: 0 };
 if (t?.line === 'h') return { ...t, h: 0 };
 return t;
}

// Kinematic-mover test, shared by the sim, the renderer and the route field: a
// piece with a path of its own, or a member of a group that has one, is not
// static and must not be baked into the static slab (§10.2). It moved here from
// sim.js when the route field needed it — util.js is the file everything can
// reach, which is the whole reason a rule three layers ask lives in it.
export function terrainCanMove(t, level) {
 if (t.path && ((t.path.pts && t.path.pts.length) || t.path.spin)) return true;
 const g = t.groupId && level.groups && level.groups[t.groupId];
 return !!(g && g.path);
}

// ---------- the road the cargo HAS to take (§ GhostRun, 2026-08-21) ----------
//
// *"Can you work out the path the goal piece must take to get to the goal? And
// show/judge the wiggle ghost based on that?"*
//
// **Why it is worth the trouble.** Every score in this file so far has been a
// straight line to somewhere, and a straight line is an opinion about the route
// (`ghostAimGap` says so at length): on a level whose road goes the wrong way
// first, a crate carried correctly BACKWARD scores worse than a crate nobody
// touched. The crosshair fixed that by asking the player to draw the route. This
// works it out instead.
//
// **What it is.** A navigation distance field. Rasterise the static world into a
// grid, grow every obstacle by the cargo's own clearance so a free cell means
// "the cargo fits here", seed every cell inside a goal zone at zero, and run
// Dijkstra outward. What comes back is, for every point in the level, how far
// the cargo still has to TRAVEL — round the outside of a hill rather than
// through it. Distance along the road, not distance across the room.
//
// **What it deliberately is not.** It is geometry, not physics: it knows nothing
// about gravity, momentum or what a machine can lift, and a route that climbs
// straight up a shaft is a perfectly good answer — building the thing that
// climbs it is the game. It ignores props and moving platforms too, both on the
// same argument: they are things a run can shift or ride, and treating them as
// walls would rule out the routes that use them.
//
// So it is a LOWER BOUND on the journey, which is exactly what a score wants:
// it can never claim the cargo is nearer than it is, and it never rewards
// progress the level does not have room for.

export const ROUTE_CELL_MIN = 6; // px — finer than this buys nothing at a cargo's size
export const ROUTE_CELLS_MAX = 220; // per axis, so a huge level stays one cheap pass
export const ROUTE_SEEK_CELLS = 6; // how far to look for open ground around a buried point
// A painted piece is its OUTLINE (§5.3), and the outline is a fence of thin
// static boxes — so the wall a route has to go round is the polyline itself
// plus half of what that fence is built from.
export const ROUTE_PAINT_WALL = 3;

// How much room this cargo needs, as a radius. A ball is its radius. A box is
// half its SHORTEST side — the width of the narrowest gap it could be turned to
// fit through — rather than half its diagonal, which would rule out gaps a
// crate goes through every day by lying down.
export function cargoClearance(def) {
 if (!def) return 0;
 if ((def.shape ?? def.type) === 'ball') return def.r || 0;
 return Math.min(def.w || 0, def.h || 0) / 2;
}

// The box the field covers: everything the level is made of, plus a margin so a
// route may go round the outside of a wall that ends at the edge.
function routeBounds(level, goalPositions) {
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 const eat = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
 const eatBounds = (b) => { if (b) { eat(b.minX, b.minY); eat(b.maxX, b.maxY); } };
 for (const t of (level.terrain || [])) {
 if (isPaint(t)) { eatBounds(polyBounds(paintOutlineOf(t) || [])); continue; }
 const r = (t.type ?? t.shape) === 'ball' ? (t.r || 0) : 0;
 if (r) { eat(t.x - r, t.y - r); eat(t.x + r, t.y + r); continue; }
 for (const c of rectCorners(t)) eat(c.x, c.y);
 }
 for (const z of [...(level.goalZones || []), ...(level.buildZones || [])]) {
 eat(z.x - z.w / 2, z.y - z.h / 2); eat(z.x + z.w / 2, z.y + z.h / 2);
 }
 (level.goalObjs || []).forEach((g, i) => {
 const p = goalPositions?.[i] || g;
 const r = Math.max(g.r || 0, (g.w || 0) / 2, (g.h || 0) / 2);
 eat(p.x - r, p.y - r); eat(p.x + r, p.y + r);
 });
 if (!Number.isFinite(minX)) return null;
 const pad = 80;
 return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

// **The field.** One Dijkstra over an 8-connected grid, diagonals at √2 so the
// distances are travel and not step counts.
export function routeField(level, cargoDef, goalPositions = null, seedZones = null) {
 const b = routeBounds(level, goalPositions);
 if (!b) return null;
 const w = b.maxX - b.minX, h = b.maxY - b.minY;
 const cell = Math.max(ROUTE_CELL_MIN, Math.ceil(Math.max(w, h) / ROUTE_CELLS_MAX));
 const nx = Math.max(1, Math.ceil(w / cell)), ny = Math.max(1, Math.ceil(h / cell));
 const n = nx * ny;
 const blocked = new Uint8Array(n);
 const clear = cargoClearance(cargoDef);
 const round = (cargoDef?.shape ?? cargoDef?.type) === 'ball';
 const cx = (ix) => b.minX + (ix + 0.5) * cell;
 const cy = (iy) => b.minY + (iy + 0.5) * cell;

 // Obstacles, grown by the cargo's clearance. Rasterised piece by piece over
 // its own bounding box — asking every cell about every piece would be a
 // hundred thousand gap tests for a level with forty walls in it.
 const mark = (bx, by, test) => {
 const i0 = Math.max(0, Math.floor((bx.lo - b.minX) / cell) - 1), i1 = Math.min(nx - 1, Math.ceil((bx.hi - b.minX) / cell));
 const j0 = Math.max(0, Math.floor((by.lo - b.minY) / cell) - 1), j1 = Math.min(ny - 1, Math.ceil((by.hi - b.minY) / cell));
 for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!blocked[j * nx + i] && test(cx(i), cy(j))) blocked[j * nx + i] = 1;
 };
 for (const t of (level.terrain || [])) {
 // Static, solid-to-this-cargo terrain only — see the banner: movers and
 // props are things a run can ride or shove, and walling them off would rule
 // out the routes that do.
 if (!terrainBlocks(t, round ? 'round' : 'box')) continue;
 if (terrainCanMove(t, level)) continue;
 if (isPaint(t)) {
 const pts = paintOutlineOf(t) || [];
 if (pts.length < 2) continue;
 const pb = polyBounds(pts);
 // the OUTLINE is what is solid (§5.3), so the wall is the polyline itself
 mark({ lo: pb.minX - clear, hi: pb.maxX + clear }, { lo: pb.minY - clear, hi: pb.maxY + clear }, (x, y) => {
 for (let k = 0; k < pts.length - 1; k++) {
 if (pointSegDist(x, y, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) < clear + ROD_WALL) return true;
 }
 return false;
 });
 continue;
 }
 const solid = terrainCollider(t);
 const core = pieceCore(solid);
 const pb = polyBounds(core.pts);
 const reach = clear + core.r + cell;
 mark({ lo: pb.minX - reach, hi: pb.maxX + reach }, { lo: pb.minY - reach, hi: pb.maxY + reach },
 (x, y) => coreGap(corePoint(x, y, clear), core) < 0);
 }

 // Seeds: every free cell inside a goal zone. If the zones are so tight that
 // the cargo's clearance fills them, seed them anyway — an unreachable goal
 // makes the whole field useless, and a route that ends in a spot the cargo
 // has to squeeze into is still the right route.
 //
 // `seedZones` is the subset a cargo has been SENT to (GhostRun's pairing).
 // Null keeps the level's own list — any zone will do, which is the default.
 const dist = new Float32Array(n).fill(Infinity);
 const heap = []; // [d, idx] pairs, binary min-heap
 const push = (d, i) => {
 heap.push([d, i]);
 let k = heap.length - 1;
 while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
 };
 const pop = () => {
 const top = heap[0], last = heap.pop();
 if (heap.length) {
 heap[0] = last;
 for (let k = 0; ;) {
 const l = k * 2 + 1, r = l + 1; let s = k;
 if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
 if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
 if (s === k) break;
 [heap[s], heap[k]] = [heap[k], heap[s]]; k = s;
 }
 }
 return top;
 };
 const zones = (seedZones && seedZones.length) ? seedZones : (level.goalZones || []);
 const seed = (allowBlocked) => {
 let any = false;
 for (const z of zones) {
 const i0 = Math.max(0, Math.floor((z.x - z.w / 2 - b.minX) / cell)), i1 = Math.min(nx - 1, Math.ceil((z.x + z.w / 2 - b.minX) / cell));
 const j0 = Math.max(0, Math.floor((z.y - z.h / 2 - b.minY) / cell)), j1 = Math.min(ny - 1, Math.ceil((z.y + z.h / 2 - b.minY) / cell));
 for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
 const k = j * nx + i;
 if (!allowBlocked && blocked[k]) continue;
 if (dist[k] === 0) continue;
 dist[k] = 0; push(0, k); any = true;
 }
 }
 return any;
 };
 const tight = !seed(false) && seed(true);

 const D = cell, Q = cell * Math.SQRT2;
 while (heap.length) {
 const [d, k] = pop();
 if (d > dist[k]) continue;
 const i = k % nx, j = (k / nx) | 0;
 for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
 if (!di && !dj) continue;
 const ni = i + di, nj = j + dj;
 if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
 const nk = nj * nx + ni;
 if (blocked[nk]) continue;
 const nd = d + (di && dj ? Q : D);
 // **Push what was STORED, not what was computed.** `dist` is a Float32Array
 // and the heap holds float64s, so a distance that rounds DOWN on the way
 // into the array makes the staleness test below (`d > dist[k]`) true for a
 // node that was never visited — and the flood quietly stops. It filled a
 // fifth of the level and reported the rest unreachable.
 if (nd < dist[nk]) { dist[nk] = nd; push(dist[nk], nk); }
 }
 }
 let reached = 0;
 for (let i = 0; i < n; i++) if (dist[i] < Infinity) reached++;
 return { minX: b.minX, minY: b.minY, cell, nx, ny, dist, blocked, tight, reached, clear };
}

// How far the cargo still has to travel from (x, y), in px along the road.
//
// A cargo RESTING on the ground has its centre exactly at the clearance
// boundary, so the cell it lands in is very often a blocked one — the grid is
// coarse and the boundary is where everything sits. Rather than call that
// unreachable, look outward a few cells for open ground and add the detour.
export function routeDistanceAt(field, x, y) {
 if (!field) return Infinity;
 const { minX, minY, cell, nx, ny, dist } = field;
 const i0 = Math.floor((x - minX) / cell), j0 = Math.floor((y - minY) / cell);
 for (let r = 0; r <= ROUTE_SEEK_CELLS; r++) {
 let best = Infinity;
 for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
 if (r && Math.max(Math.abs(di), Math.abs(dj)) !== r) continue; // the ring, not the disc
 const i = i0 + di, j = j0 + dj;
 if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
 const d = dist[j * nx + i];
 if (d < best) best = d + Math.hypot(di, dj) * cell;
 }
 if (best < Infinity) return best;
 }
 return Infinity;
}

// The road itself, as a polyline from (x, y) to the goal — walked downhill
// through the field. For DRAWING: it is the route the score is counting, so a
// player can see what the number thinks and disagree with it (that is what the
// crosshair is for).
export function routePath(field, x, y, cap = 4000) {
 if (!field) return [];
 const { minX, minY, cell, nx, ny, dist } = field;
 let i = Math.floor((x - minX) / cell), j = Math.floor((y - minY) / cell);
 // start from open ground, the same way the distance does
 let si = null, sj = null;
 for (let r = 0; r <= ROUTE_SEEK_CELLS && si == null; r++) {
 let best = Infinity;
 for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
 if (r && Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
 const ii = i + di, jj = j + dj;
 if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
 const d = dist[jj * nx + ii];
 if (d < best) { best = d; si = ii; sj = jj; }
 }
 if (best === Infinity) { si = null; sj = null; }
 }
 if (si == null || !(dist[sj * nx + si] < Infinity)) return [];
 const pts = [{ x, y }];
 i = si; j = sj;
 for (let step = 0; step < cap; step++) {
 const here = dist[j * nx + i];
 if (here === 0) break;
 let bi = i, bj = j, bd = here;
 for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
 const ni = i + di, nj = j + dj;
 if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
 const d = dist[nj * nx + ni];
 if (d < bd) { bd = d; bi = ni; bj = nj; }
 }
 if (bi === i && bj === j) break; // a flat spot: nothing downhill
 i = bi; j = bj;
 pts.push({ x: minX + (i + 0.5) * cell, y: minY + (j + 0.5) * cell });
 }
 return pts;
}

// **The score, along the road.** How far the cargo still has to travel, plus
// what it would still owe once it got there — so at the goal the number becomes
// the exact containment gap and nothing else, and far away the journey
// dominates. Worst of the pieces, because every one has to arrive.
//
// `Infinity` from the field means the goal cannot be reached through free space
// at all (a sealed level, or a cargo too big for the gap). The caller falls back
// to the straight line then: a bad ruler beats no ruler.
export function routeRunGap(field, defs, poses, zones) {
 if (!field || !defs?.length) return Infinity;
 let worst = 0;
 for (let i = 0; i < defs.length; i++) {
 const d = routeDistanceAt(field, poses[i].x, poses[i].y);
 if (!(d < Infinity)) return Infinity;
 const v = d + goalZoneGap(defs[i], poses[i], zones);
 if (v > worst) worst = v;
 }
 return worst;
}

// ---------- GhostRun (§ GhostRun) ----------
//
// **What the machine you are editing would be doing at a chosen moment.** You
// play a run, pause it on the scrubber, and that instant becomes an aim: the
// editor goes back to the build you can touch, and the future is drawn over it
// as a ghost — the machine at that second, and the road the cargo took to get
// there. Every edit re-runs a private world from t=0 to the aim and redraws it.
//
// The rules live HERE rather than in game.js for the reason every rule does: a
// decision inside a DOM handler ships whatever it happens to do, and none of
// these can be asked a question headlessly from in there.
//
// Three of them, and they are independent:
// * how GOOD a moment is (`goalZoneGap`, `ghostBetter`) — one number and one
// ordering, so "best goal piece position" means one thing everywhere,
// * what MOVES when a pin moves (`pinMoveSet`, `pinMovedParts`),
// * and WHERE to look (`pinGrid`) — a sweep, not a descent; see below.

// How far a goal piece at `pose` is from being wholly inside its nearest zone:
// 0 once it is in, otherwise the distance its worst corner still has to travel.
//
// **Measured on the piece's BOX, and measured ROTATED**, because the win
// condition is containment of the whole piece (§7.1): the centre would call a
// crate hanging half out of the zone a win, and an upright measurement would
// tell a pillar that has to topple that nothing it does matters — the number
// that changed would be the one nobody looked at.
//
// The rotated AABB rather than the true polygon: |hw·c| + |hh·s| is a superset
// of the shape, exact at 0° and 90°, which is where cargo comes to rest. So a
// 0 here is very nearly a win and never quite the claim of one — `sim.won`
// remains the only thing that says a machine worked.
//
// The solver has judged candidates by this since it was revived
// (`scripts/solver/arena.mjs` re-exports it as `zoneGap`); GhostRun scores a
// pin sweep by it. Two copies would be two opinions about what "nearly there"
// means, and the one that drifted would be the one nobody was watching.
export function goalZoneGap(def, pose, zones) {
 const hw0 = def.shape === 'ball' ? def.r : (def.w || 0) / 2;
 const hh0 = def.shape === 'ball' ? def.r : (def.h || 0) / 2;
 const c = Math.abs(pose.c ?? Math.cos(pose.angle || 0));
 const s = Math.abs(pose.s ?? Math.sin(pose.angle || 0));
 const hw = def.shape === 'ball' ? hw0 : hw0 * c + hh0 * s;
 const hh = def.shape === 'ball' ? hh0 : hw0 * s + hh0 * c;
 let best = Infinity;
 for (const z of (zones || [])) {
 const zl = z.x - z.w / 2, zr = z.x + z.w / 2, zt = z.y - z.h / 2, zb = z.y + z.h / 2;
 // how far the piece must move on each axis for its whole span to fit
 const dx = Math.max(0, (zl + hw) - pose.x, pose.x - (zr - hw));
 const dy = Math.max(0, (zt + hh) - pose.y, pose.y - (zb - hh));
 const d = Math.hypot(dx, dy);
 if (d < best) best = d;
 }
 return best;
}

// …and the worst of them, because every goal piece has to arrive. `Infinity`
// for a level with no zones or no cargo, which `ghostBetter` then ranks below
// everything — there is nothing to be near.
export function goalRunGap(defs, poses, zones) {
 if (!defs?.length || !zones?.length) return Infinity;
 let worst = 0;
 for (let i = 0; i < defs.length; i++) {
 const d = goalZoneGap(defs[i], poses[i], zones);
 if (d > worst) worst = d;
 }
 return worst;
}

// ---------- the road, drawn by the PLAYER (2026-08-21) ----------
//
// The question was *"can you work out the path the goal piece must take"*, and
// the answer above (`routeField`) is yes — geometrically. Then: *"Maybe the path
// should be provided by the player! That would be easier I think. And sometimes
// there are many paths you can go by..."*
//
// Which settles it, and settles it the right way round. A computed route knows
// the shape of the room and nothing about what a machine can do in it; the
// person building the machine knows both. So **the path is the player's**, and
// `routeField` is demoted to what it is actually good for — drafting one for
// them to fix, on levels where the road is obvious and dragging it out by hand
// would be a chore.
//
// **And there is more than one road.** A cargo may legitimately go over the
// hill or round it, and a sweep that punished the machine for choosing the
// other one would be scoring the player's plan rather than the machine. So this
// takes a LIST of paths and every piece is scored by its best.
//
// **The score is how much ROAD is left**: find the point on the road the cargo
// is nearest, and add how far off the road it is to how much road remains from
// there. Measured from the piece's CENTRE — a score has to be monotone and
// cheap far more than it has to be exact.
//
// **Nearest by DISTANCE, not by cheapest finish**, and that is the whole
// difference. The first cut minimised `off + remaining`, which let a cargo at
// the start of a road that goes the wrong way first "project" onto the last
// segment and score as though it had already arrived — so the cargo obeying the
// plan scored WORSE than the one ignoring it, which is precisely the failure the
// road exists to fix. Choosing the nearest point instead is the ordinary
// progress-along-a-track measure and gets that case right.
//
// It can still be short-circuited where a road passes near itself, or where the
// cargo genuinely ends up beside a later stretch: then the cargo really IS
// further along, and saying so is not a bug. The road is an ORDER, not a wall.
//
// **No containment term here.** Adding `goalZoneGap` put the straight line back
// into the answer and swamped everything at the far end of a long road; whether
// a delivery actually happened is a question `ghostBetter` already asks first,
// through `won`.
//
// No paths at all is the plain win condition, which is where this started.
// Where a road ends: the goal zone nearest its last corner. With one zone this
// is just "the goal"; with several it is the one the player was heading for,
// which the road itself says better than any other rule could.
export function goalPointNear(zones, from) {
 if (!zones?.length) return null;
 let best = zones[0];
 if (from) {
 let bd = Infinity;
 for (const z of zones) {
 const d = Math.hypot(z.x - from.x, z.y - from.y);
 if (d < bd) { bd = d; best = z; }
 }
 }
 return { x: best.x, y: best.y };
}

// **Which zone(s) cargo `i` is being asked to reach** (2026-08-26, GhostRun:
// "I need a way to select which goal piece goes to which goal"). `assign[i]`
// is a zone index, or null/absent for "any of them" — the default, and what
// the win condition itself still is. A sweep that has been told "crate 1 goes
// to the left pad" must not score a delivery to the right pad as a win.
export function zonesForCargo(zones, assign, i) {
 if (!zones?.length) return zones || [];
 const zi = assign?.[i];
 if (zi == null || zi < 0 || zi >= zones.length) return zones;
 return [zones[zi]];
}

export function pathGap(path, zones, def, pose) {
 if (!path?.length) return goalZoneGap(def, pose, zones);
 const goalPt = goalPointNear(zones, path[path.length - 1]);
 if (!goalPt) return goalZoneGap(def, pose, zones);
 const nodes = [...path, goalPt];
 // road remaining after each node, walked backwards
 const rem = new Array(nodes.length).fill(0);
 for (let k = nodes.length - 2; k >= 0; k--) {
 rem[k] = rem[k + 1] + Math.hypot(nodes[k + 1].x - nodes[k].x, nodes[k + 1].y - nodes[k].y);
 }
 let bestOff = Infinity, bestLeft = Infinity;
 for (let k = 0; k < nodes.length - 1; k++) {
 const a = nodes[k], b = nodes[k + 1];
 const vx = b.x - a.x, vy = b.y - a.y;
 const len = Math.hypot(vx, vy);
 const t = len > 1e-9 ? clamp(((pose.x - a.x) * vx + (pose.y - a.y) * vy) / (len * len), 0, 1) : 0;
 const off = Math.hypot(pose.x - (a.x + vx * t), pose.y - (a.y + vy * t));
 // `<=` so a tie goes to the LATER stretch: a cargo sitting exactly on a
 // junction has reached it, not merely arrived at it
 if (off <= bestOff) { bestOff = off; bestLeft = rem[k + 1] + (1 - t) * len; }
 }
 return bestOff * PATH_OFF_PENALTY + bestLeft;
}

// **A pixel off the road costs more than a pixel along it.**
//
// Every road ends at the goal, so without this a road the cargo is nowhere near
// still offers the crow-flies distance as its score — and with several roads
// drawn, a cargo sitting squarely on one of them was scored by a DIFFERENT one
// it had never been near. Two was enough to settle that: a cargo on a road beats
// a cargo the same distance from the goal but off every road.
//
// It does not make shortcuts impossible and is not meant to. A memoryless score
// reads one pose and cannot know a straight line is unavailable — only that the
// player drew a road implying it. What it has to get right is the ORDERING
// between candidates in a sweep, and this is what buys that.
export const PATH_OFF_PENALTY = 2;

// **A road that doubles back needs the RUN, not the last frame** (2026-08-21,
// of the level in front of him: *"This level the goal has to go all the
// way left then go right and down"*).
//
// Draw that road honestly — start, far left, far right, down — and it crosses
// itself: the cargo's starting spot lies on the outbound leg AND on the return
// leg, at zero distance from both. A score that reads one pose cannot tell which,
// so `pathGap` credited a cargo that had not moved with having already gone left
// and come back. On the level that most needs a road, the road did nothing.
//
// The fix is the one thing a rollout has that a pose does not: ORDER. Walk the
// run's samples from first to last and let the road position only ever ADVANCE.
// The cargo then reaches the return leg by travelling the outbound one, which is
// what "must go left first" means, and standing still stays at the start.
//
// **Best over the run rather than at the end**, which is the solver's own choice
// for the same reason (`arena.mjs`: the closest the cargo ever came, not where it
// stopped) — a machine that delivers and bounces out has still delivered.
// **…and advancing along it has to COST what it costs.** Monotonicity alone was
// not enough: a cargo shoved straight to the right sits on the RETURN leg, and
// "the position may only go forward" let it teleport there and score as though
// it had made the whole trip. To travel 900 px of road you have to move 900 px,
// so the position may advance no faster than the cargo did — which is a fact
// about the world, not a tuning knob.
//
// Written in ARC LENGTH along the road, which is what makes both rules one line
// each: `s` may not decrease, and `s` may not grow by more than the cargo moved.
export const PATH_ADVANCE_SLACK = 1.5; // …plus a little, for a curved trip between samples
export const PATH_ADVANCE_FLOOR = 8; // px — so a cargo creeping still creeps along the road

export function pathRunGap(path, zones, def, samples) {
 const last = samples[samples.length - 1];
 if (!path?.length || !samples?.length) return goalZoneGap(def, last, zones);
 const goalPt = goalPointNear(zones, path[path.length - 1]);
 if (!goalPt) return goalZoneGap(def, last, zones);
 const nodes = [...path, goalPt];
 // arc position of each node, and the road's total length
 const arc = [0];
 for (let k = 1; k < nodes.length; k++) {
 arc.push(arc[k - 1] + Math.hypot(nodes[k].x - nodes[k - 1].x, nodes[k].y - nodes[k - 1].y));
 }
 const L = arc[arc.length - 1];
 let s = 0, best = Infinity, prev = null;
 for (const p of samples) {
 // **The FIRST sample places itself freely**; only advancing is bounded.
 // The bound is about travel — you cannot cross 900 px of road without
 // moving 900 px — and where the cargo BEGINS is not travel. Without this a
 // one-sample run (a bare pose, which is all some callers have) could never
 // leave arc 0 and every position on the road scored the same.
 const moved = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : Infinity;
 prev = p;
 const sMax = Math.min(L, moved === Infinity ? L : s + moved * PATH_ADVANCE_SLACK + PATH_ADVANCE_FLOOR);
 let bOff = Infinity, bS = s;
 for (let k = 0; k < nodes.length - 1; k++) {
 const len = arc[k + 1] - arc[k];
 if (len < 1e-9 || arc[k + 1] < s || arc[k] > sMax) continue; // outside the window
 const a = nodes[k], b = nodes[k + 1];
 const vx = b.x - a.x, vy = b.y - a.y;
 const raw = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / (len * len), 0, 1);
 // clamp the projection into the arc window as well as onto the segment
 const t = clamp(raw, (s - arc[k]) / len, (sMax - arc[k]) / len);
 const off = Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
 // ties go to the LEAST progress: the cargo has only gone as far as it can
 // be shown to have gone, which is what stops a self-crossing road
 // crediting a piece that has not moved with the whole outbound leg
 if (off < bOff) { bOff = off; bS = arc[k] + t * len; }
 }
 if (bOff === Infinity) continue;
 s = Math.max(s, bS);
 const v = bOff * PATH_OFF_PENALTY + (L - s);
 if (v < best) best = v;
 }
 return best;
}

// **…and what the sweep is aiming AT** (2026-08-21: *"I think we need
// the optimise to default to the goal… but have a crosshair/marker that can be
// moved to help interim steps. ie sometimes the goal piece has to be moved far
// away from the goal to eventually reach the goal."*).
//
// This is the same thing the solver learned the hard way and wrote down
// (`cargoBaseline`, and § the shattered fractal): on a level whose route goes
// the wrong way first, "how near did it get" says a crate shoved backward along
// the correct road is doing WORSE than a crate nobody touched. Distance to the
// goal is not a reward surface, it is an opinion about the route — and the
// person building the machine is the one who knows the route.
//
// So the target is a POINT the player can put anywhere, and the goal is only
// its default. `null` means the default, and the default is the real win
// condition (`goalRunGap`) rather than the goal zone's centre — a piece
// anywhere inside the zone scores 0, which is exactly what winning means and is
// not what "distance to the middle" would say.
//
// **The nearest goal piece, not the worst**, once a target is set: an interim
// waypoint is about steering ONE piece through a stage, and asking every piece
// on the level to arrive at a hand-placed crosshair would be asking for
// something nobody wants. The default keeps the worst-of-them rule, because
// THAT one is the win condition and every piece really does have to arrive.
// **Every piece has to arrive, and any road will do.**
//
// *"And there are sometimes many goal pieces. So multiple paths or just optimise
// on one goal piece at a time?"* (2026-08-21) — both, because they answer
// different halves of the same day's work.
//
// * A road BELONGS to a cargo (`p.goal`), so a level whose two crates go
// opposite ways can have a road each. `goal: null` is a road any of them may
// use, which is what you get if you never say otherwise.
// * A cargo may be SENT to a specific zone (`assign[i]`), so a level whose
// two crates go to two pads scores each against its own pad. Null is any
// zone, which is the win condition and the default.
// * WORST over the pieces that are being judged, because the win condition is
// all of them arriving and a score that averaged would happily abandon one.
// * BEST over that piece's roads — "there are many paths you can go by", and a
// machine that took the other one has not done anything wrong.
// * …and `only` narrows the judging to ONE piece, which is how you actually
// work: get the first crate's journey right, then the second. It is a
// deliberate blindfold, so the caller says so on screen.
//
// A piece with no road of its own falls back to the plain win condition, so a
// level where you have drawn one road out of three still scores the other two.
// `runs[i]` is goal piece i's samples over the whole rollout, oldest first —
// the last of them is where it ended. A bare pose works too (one sample), and
// then a self-crossing road is scored as `pathRunGap`'s banner warns.
export function ghostAimGap(defs, runs, zones, paths = null, only = null, assign = null) {
 if (!defs?.length) return Infinity;
 let worst = 0, judged = 0;
 for (let i = 0; i < defs.length; i++) {
 if (only != null && only !== i) continue;
 judged++;
 const samples = Array.isArray(runs[i]) ? runs[i] : [runs[i]];
 const mine = (paths || []).filter((p) => p?.pts?.length && (p.goal == null || p.goal === i));
 const dest = zonesForCargo(zones, assign, i);
 let best = Infinity;
 // **The CLOSEST the cargo ever came, on both branches** (2026-08-21). With a
 // road this always read the best moment of the run; without one it read only
 // the last, so drawing a road changed not just the ruler but WHEN it was
 // read — and a machine that carried the cargo into the goal and let it roll
 // back out scored as though it had never got there.
 //
 // Closest-approach is the solver's own choice for the same reason
 // (`arena.mjs`: what it keeps is the closest the goal piece ever came, not
 // where it stopped), and it is the better reward either way: it is a surface
 // a search can climb, where "where did it stop" is flat over every machine
 // that overshot. Whether a delivery actually happened is asked first and
 // separately, through `won`.
 if (!mine.length) for (const q of samples) best = Math.min(best, goalZoneGap(defs[i], q, dest));
 else for (const p of mine) best = Math.min(best, pathRunGap(p.pts, dest, defs[i], samples));
 if (best > worst) worst = best;
 }
 return judged ? worst : Infinity;
}

// A drawn road, thinned to the corners that matter — the field's own path comes
// out one cell at a time, which is a hundred waypoints nobody wants to drag.
// Ordinary Ramer–Douglas–Peucker over the polyline, then a cap, because a
// suggestion the player cannot edit is not a suggestion.
export function simplifyPath(pts, tol = 14, cap = 10) {
 const line = simplifyPolyline(pts, tol);
 if (line.length <= cap) return line;
 const out = [];
 for (let i = 0; i < cap; i++) out.push(line[Math.round((i * (line.length - 1)) / (cap - 1))]);
 return out;
}

// (`pointPieceGap` lived here — distance from a bare point to a piece — and it
// went with the single crosshair it was written for. A road is scored by arc
// length along a polyline, not by distance to one mark, so nothing asked it any
// more; an exported rule with no caller is one that drifts unwatched.)

// How near the pointer has to be to pick a road corner up, in SCREEN px — the
// mark is drawn at 11, so this is its own outline plus a little. A finger takes
// the same multiple over a cursor that `snapRadius` gives a pin (SNAP_TOUCH
// over SNAP_MOUSE), because it is the same fingertip.
export const GHOST_TARGET_PICK = 14;
export const GHOST_TARGET_TOUCH = SNAP_TOUCH / SNAP_MOUSE;

// Is verdict `a` better than verdict `b`? A verdict is
// `{ invalid, won, winTime, lost, gap }` — whatever a rollout to the aim came
// back with. Written as an ORDERING rather than as a single score because the
// four things are not commensurable and pretending they are is how a search
// learns to cheat: no weighting of "won" against "gap" can stop a big enough
// gap improvement outvoting a delivery.
//
// an editor-legal machine beats an illegal one
// a delivery beats no delivery, and a SOONER delivery beats a later one
// a machine that still has its cargo beats one that lost it over the edge
// and failing that, nearer is better.
//
// `null` is worse than anything, so the first candidate always takes the lead.
export function ghostBetter(a, b) {
 if (!a) return false;
 if (!b) return true;
 if (!!a.invalid !== !!b.invalid) return !a.invalid;
 if (!!a.won !== !!b.won) return !!a.won;
 if (a.won && b.won) return (a.winTime ?? Infinity) < (b.winTime ?? Infinity);
 if (!!a.lost !== !!b.lost) return !a.lost;
 return (a.gap ?? Infinity) < (b.gap ?? Infinity);
}

// ---------- moving a pin ----------
//
// **A pin is a COORDINATE, and moving it moves everything bolted there.** The
// joint solver pairs on `jointKey` (§5.4), so the machine's topology is exactly
// "which ends share a spot" — and a pin move has to preserve every one of them
// or it is not a move, it is a quiet rebuild of somebody's machine.
//
// That makes it a closure rather than a lookup, and a wheel is why:
//
// a ROD END at a moving coordinate moves, and the stick stretches or swings.
// Its other end is a separate coordinate and stays exactly where it is.
// a WHEEL is rigid and round, so its rim pins are welded to its hub: the only
// way to move any pin of a wheel is to move the whole wheel — which moves
// its OTHER pins too, and whatever is bolted to those has to come along.
//
// So the set grows until it stops growing. Everything in it shifts by ONE
// delta, which is what keeps a wheel a wheel and a shared coordinate shared.
//
// `anchors` is the set of `jointKey`s the machine cannot move: the level's own
// parts, props, terrain, loose pins and goal pieces. If the closure reaches one
// of those the move is REFUSED, because carrying it out would tear the machine
// off the world — and a tool that silently unbolts your machine to improve a
// number is worse than a tool that says no.
//
// Returns `{ keys, ends, wheels, blocked }`; `blocked` is null or a reason.
// `goals` is `[{ def, pos }]` — the cargo, when the CARGO may move too
// (2026-08-21, on request: *"Would be good to be able to right click any pin.
// eg. Goal piece pins as well."*). Where the player starts the cargo is a real
// degree of freedom they have: they can drag it inside the build zone before
// pressing Play, at the cost of the untampered badge. So a goal piece behaves
// exactly like a wheel in this closure — rigid, moves whole, and drags every
// coordinate its own pins sit on along with it.
//
// Passing `null` leaves the cargo where the level put it, and its pins stay in
// `anchors` — which is what every caller wanted before this existed.
export function pinMoveSet(parts, x, y, anchors = null, goals = null) {
 const seed = jointKey(x, y);
 const keys = new Set([seed]);
 const ends = []; // { i, end } — 1 is (x1,y1), 2 is (x2,y2)
 const wheels = []; // indices of wheels that move whole
 const cargo = []; // …and indices of goal pieces, on the same terms
 const seenEnd = new Set(), seenWheel = new Set(), seenGoal = new Set();
 for (let grew = true; grew;) {
 grew = false;
 for (let i = 0; i < parts.length; i++) {
 const p = parts[i];
 if (p.t === 'rod') {
 for (const end of [1, 2]) {
 const k = end === 1 ? jointKey(p.x1, p.y1) : jointKey(p.x2, p.y2);
 if (!keys.has(k)) continue;
 const tag = i + ':' + end;
 if (seenEnd.has(tag)) continue;
 seenEnd.add(tag); ends.push({ i, end }); grew = true;
 }
 } else if (p.t === 'wheel') {
 if (seenWheel.has(i)) continue;
 const pins = wheelPins(p);
 if (!pins.some((q) => keys.has(jointKey(q.x, q.y)))) continue;
 seenWheel.add(i); wheels.push(i); grew = true;
 // the hub carries the rim with it, so every pin on this wheel is now a
 // moving coordinate and anything sharing one is in the set too
 for (const q of pins) keys.add(jointKey(q.x, q.y));
 }
 }
 // …and the cargo, on the wheel's own terms: rigid, moves whole, and every
 // pin on it becomes a moving coordinate — which is what lets a stick bolted
 // to a crate follow the crate, and the crate follow the stick.
 for (let i = 0; goals && i < goals.length; i++) {
 // `null` is a cargo this sweep may not move — the level parked it outside
 // the build zone, so it is the level's and not the player's.
 if (!goals[i] || seenGoal.has(i)) continue;
 const pins = goalPins(goals[i].def, goals[i].pos);
 if (!pins.some((q) => keys.has(jointKey(q.x, q.y)))) continue;
 seenGoal.add(i); cargo.push(i); grew = true;
 for (const q of pins) keys.add(jointKey(q.x, q.y));
 }
 }
 let blocked = null;
 if (!ends.length && !wheels.length && !cargo.length) blocked = 'nothing';
 else if (anchors) { for (const k of keys) if (anchors.has(k)) { blocked = 'anchored'; break; } }
 return { keys, ends, wheels, cargo, blocked };
}

// The cargo's positions with that pin shifted — the same shape and the same
// `+= delta` argument as `pinMovedParts`, so a crate and the sticks bolted to it
// come away by exactly the same float and stay bolted.
export function pinMovedGoals(goalPositions, set, dx, dy) {
 if (!set.cargo?.length) return goalPositions;
 const out = goalPositions.slice();
 for (const i of set.cargo) out[i] = { x: goalPositions[i].x + dx, y: goalPositions[i].y + dy };
 return out;
}

// Every `jointKey` in the level that a machine part may NOT drag with it — the
// level's own machine, its props, its terrain, its loose pins and its cargo.
// The mirror of `occupiedPins`: that one asks which coordinates have something
// on them, this one asks which of them are nailed down.
// `cargoMoves` takes the goal pieces OUT of the anchor set, for a sweep that is
// allowed to move them (`pinMoveSet`'s `goals`). Everything else stays nailed
// down whatever happens: the level's own machine, its props, its terrain and its
// loose pins are not the player's to shift.
export function pinAnchors(level, goalPositions = null, { cargoMoves = false } = {}) {
 const out = new Set();
 const add = (x, y) => out.add(jointKey(x, y));
 for (const p of (level?.fixedParts || [])) {
 if (p.t === 'wheel') for (const q of wheelPins(p)) add(q.x, q.y);
 else if (p.t === 'rod') { add(p.x1, p.y1); add(p.x2, p.y2); }
 }
 if (!cargoMoves) (level?.goalObjs || []).forEach((g, i) => {
 for (const q of goalPins(g, goalPositions ? goalPositions[i] : null)) add(q.x, q.y);
 });
 for (const p of (level?.props || [])) for (const q of piecePins(p)) add(q.x, q.y);
 for (const t of (level?.terrain || [])) for (const q of piecePins(t)) add(q.x, q.y);
 for (const q of (level?.pins || [])) add(q.x, q.y);
 return out;
}

// The machine with that pin shifted by (dx, dy) — a NEW array, sharing every
// part the move does not touch, so a candidate costs one object per moved piece
// rather than a copy of the build.
//
// `+= dx` rather than "assign the target", and that is the whole of why two
// ends that shared a coordinate still share one afterwards: the same float plus
// the same float is the same float. It is also what keeps a wheel's rim pins
// exactly on its rim — they move with the hub because the hub is what is
// stored, and `wheelPins` recomputes them from it.
export function pinMovedParts(parts, set, dx, dy) {
 const out = parts.slice();
 const touched = new Map();
 const copy = (i) => {
 let c = touched.get(i);
 if (!c) { c = { ...parts[i] }; touched.set(i, c); out[i] = c; }
 return c;
 };
 for (const i of set.wheels) { const c = copy(i); c.x += dx; c.y += dy; }
 for (const { i, end } of set.ends) {
 const c = copy(i);
 if (end === 1) { c.x1 += dx; c.y1 += dy; } else { c.x2 += dx; c.y2 += dy; }
 }
 return out;
}

// ---------- where to look ----------
//
// **A SWEEP, not a descent** (2026-08-21: *"bearing in mind that you
// and I know it is probably needle haystack territory. So probably just a grid
// search."*). Everything measured about this search space says the same thing
// (§ the shattered fractal): the win boundary box-counts at D≈1.44, basin width
// tracks the horizon rather than the part count, and there is no gradient to
// walk — so a compass or pattern search would be climbing a surface that isn't
// there, and would stop at the first cell that happened to be flat around it.
//
// A grid has none of that opinion. It costs what it costs, it cannot be fooled
// by a local shelf, and — because every cell is measured rather than skipped —
// what it leaves behind is a FIELD: the caller can draw where the needles were,
// which on a fractal is worth more than the single winner.
//
// Row-major from the top-left, so watching the progress count reads as a sweep
// across the box, and the cell at offset (0, 0) is the machine you already have
// — the baseline is IN the grid rather than assumed, so "nothing beat it" is a
// measurement too.
//
// **THREE resolutions, each 32×32** (2026-08-21: *"We know the devil
// is in the detail… 1px 32x32 / 0.1px 32x32 / 0.01px 32x32"*). Not three sizes
// of the same idea — a ZOOM LADDER into the fractal. Each rung looks at a
// neighbourhood a tenth the width of the one above, so the coarse sweep finds
// the region and the fine ones find what is inside it, which on a boundary that
// box-counts at D≈1.44 is a different picture rather than a smoother one.
//
// **They are the editor's own nudge ladder** — `NUDGE` 1, `NUDGE_FINE` 0.1,
// `NUDGE_MICRO` 0.01, the three steps the arrow keys already move a selection
// by (§8.2). That is not a coincidence worth hiding: every cell of every rung
// is somewhere the player could have put the pin by hand with the keyboard, so
// the sweep is searching the space they can actually build in rather than a
// finer one it invented. The finest rung's whole box is 0.32 px — three times
// the resolution `jointKey` buckets at, and far below anything the positional
// grid can express — which is exactly the detail the devil is in.

// What a swept cell's rollout came back with, as bits. Here rather than in
// game.js because the RENDERER reads them too: a cell that actually delivered
// is drawn differently from one that merely got close, and the encoding has to
// be the same thing on both sides of that.
//
// MEASURED is its own bit rather than "the score is not NaN", because a cell can
// honestly score Infinity — the editor refused it — and a rescore has to tell
// that from a cell nobody ever reached.
export const CELL_MEASURED = 1, CELL_INVALID = 2, CELL_WON = 4, CELL_LOST = 8;

// **15, down from 21, down from 32** (2026-08-21). 225 rollouts against 441 and
// 1024 — a sweep at any rung has gone from about 1.9 s to 0.8 s to 0.4 s, which
// is the difference between waiting for one, trying three, and not thinking
// about the cost at all.
//
// Two things come free with a smaller grid, and both matter more than the
// coverage lost. A CELL is bigger — 9 px at the chip's floor rather than 6, 17
// on a wide screen rather than 12 — so it is something you can watch change and
// aim a click at. And the sweep finishes inside the time it takes to decide
// whether you wanted it, which is what makes clicking one while it is still
// filling in worth having at all.
//
// It stays ODD, which the 32 was not: the pin's own position is the true CENTRE
// cell. The even side needed a paragraph explaining the box was a cell wider on
// one side; this needs none.
export const PIN_GRID_SIDE = 15;

// **A stick's DENSITY is a tweakable too** (2026-08-21, on request: *"How about
// stick density for a tweakable? Right click middle of stick to vary weight
// 1-100 (shown as 10x10)."*).
//
// It is a different SHAPE of sweep from a pin's and the same idea: a pin has two
// dimensions and gets a square of positions, a weight has one and gets a
// hundred values — laid out 10×10 because a hundred cells in a line is not a
// picture, and because the row you are on then reads as the tens digit.
//
// The whole range, one per whole number, rather than the geometric ladder the
// slider offers (`WEIGHT_STEPS` stops at ×95 and ×100 with nothing between). A
// sweep should look at everything the value can be; the ladder exists so a HAND
// can land on ×2 rather than ×2.13, which is not a problem a sweep has.
export const WEIGHT_GRID_SIDE = 10;

// **Every how many cells the field draws a heavier line.** 5 divides both field
// shapes — 15 into three blocks, 10 into two — so a major line means the same
// thing whichever matrix you are reading, which is the only reason to have one
// number rather than two. On a pin field the blocks are the ±5 and ±10 offsets;
// on a weight field the middle line is ×50.
export const SWEEP_GRID_MAJOR = 5;
export const weightGrid = () =>
 Array.from({ length: ROD_WEIGHT_MAX - ROD_WEIGHT_MIN + 1 }, (_, i) => ROD_WEIGHT_MIN + i);
export const PIN_GRID_STEPS = NUDGE_STEPS;

// ---------- which gestures can have changed the machine ----------
//
// **A drag that cannot edit must not be told an edit happened** (2026-08-22,
// *"Click-Drag does not need a mouse wheel. That also clears the
// matrix"*). `_pointerUp` ended every gesture with `_updateStats()`, which is
// where GhostRun learns the build changed and throws its world — and its sweep
// — away. Panning the background is a gesture. So was a bare click: a press on
// empty space becomes a `pan` drag whether or not the hand ever moves, falls
// through the switch untouched, and still reported an edit on the way out.
// Dragging the level around cost you 225 rollouts every time.
//
// Named here rather than inlined at the call site because it is a RULE about
// which gestures are edits, and `_pointerUp` is a DOM handler no gate can
// reach. The default is deliberately "it edits": a drag type added later
// invalidates until someone says otherwise, which is the safe direction to be
// wrong in — a stale ghost is a lie, a re-run is only a cost.
export const DRAG_NEVER_EDITS = new Set([
 'pan', // the camera moved, the machine did not
 'marquee', // picks a selection, changes nothing in it
 'ghost-aim', // moves the crosshair, which is the QUESTION and not the build
]);
export const dragEdits = (type) => !DRAG_NEVER_EDITS.has(type);

// ---------- the odds a hand would have found it ----------
//
// **What a cell is worth as LUCK** (2026-08-22, on request: *"Add a probability
// to Ghost Chip, based on zoom factor and number of cells equal or better than
// chosen one. But starting at 0.1px … they picked the only Gold on the entire
// screen. Probability 1:225 … Same situation at 0.01px, assume this is still
// from the 1.5x1.5px range so, 1:50625 … If there are, say, 15 spots that are
// equal or better at 0.1 px then it would be 15:225 === 1:15."*)
//
// **ONE RUNG GETS A NUMBER, and it is 0.1 px** (2026-08-22: *"I think let's only
// give probability for 0.1px. I think it is unlikely to be mathematically sound
// at other scales. Dubious at 0.1px, but at least fun."*).
//
// It began as a ladder: 225 for the tenth-px rung and 225² for the hundredth,
// on the grounds that the only way to REACH the fine rung is to sweep the coarse
// one and click a cell. That compounding is a story about how somebody searches,
// not a probability — it assumes the coarse sweep's winner is the box the fine
// answer lives in, which is exactly what a fractal boundary will not promise.
// So the ladder is gone and what is left is a straight count over the cells on
// the screen: of the 225 positions in this 1.5 px box, how many are as good as
// the one you are reading.
//
// Which is sound as far as it goes and no further — it is conditional on being
// in the box at all, and nothing here claims to know the odds of that. A whole
// pixel gets no number because a builder aiming a pin at a pixel is using
// judgement rather than luck; a hundredth gets none because the field would be
// answering a question about a box nobody navigated to. Dubious, and fun, and
// the tooltip says which box it is talking about.
export const SWEEP_ODDS_STEP = 0.1;
// A pin field at exactly that rung, and nothing else. **Density sweeps are out
// too**, though they are the one shape that would be exactly sound: a hundred
// cells for a hundred whole densities is the entire range enumerated, no box and
// no conditional. Out because the rule as given is one rung of one kind — it is
// two words here if it should come back.
export const sweepOddsShown = (kind, step) => kind !== 'weight' && step === SWEEP_ODDS_STEP;
// One in how many, over the field on screen. `better` counts the cells that are
// as good as the one being read or better, and it includes that cell — so it is
// never 0, and fifteen of them is 225/15 = 1 in 15.
export function sweepTrials(cells, better) {
 return Math.max(1, cells) / Math.max(1, better);
}

// **A delivery is a delivery, for counting purposes** (2026-08-22, on the first
// field to show this: *"I feel this should be at least 2:225? There is a better
// option that was not picked. So at least 2 options on the screen?"* — six other
// cells on that screen delivered, and the odds called the find unique because
// the starred one delivered SOONEST).
//
// `ghostBetter` breaks ties between winners on speed, which is right for picking
// a cell out of a field and wrong for counting how many the field offered: a
// hand hunting a delivery would have taken any of them and stopped. Speed is
// what the gold ramp grades — asking it twice makes every winner unique and
// every field read 1 in 225.
//
// Nulling the times rather than a separate comparator, so this stays the SAME
// ordering in every other respect: legal over illegal, delivered over not,
// cargo kept over cargo lost, and nearer over further.
export const oddsAsGood = (pick, cell) => !ghostBetter({ ...pick, winTime: null }, { ...cell, winTime: null });

// **A guess with the aim inside it.** The run dominates and the run is not a
// guess at all: it is the AIM, in seconds, watched at 1× (2026-08-22: *"Time
// should include playback at normal speed."*). It first counted the rollout's
// measured cost instead — a tenth of a second for the same seventy — which is
// what the MACHINE pays to know the answer, not what a person pays to see it.
// Nobody hunting a delivery watches seventy seconds of physics at 600×.
//
// **Which makes the number an upper bound, on purpose** (*"So we have an upper
// bound"*). The dock does offer MAX, and somebody who used it on every try would
// spend a fraction of this — so quoting 1× says "no longer than that", and the
// figure cannot be accused of flattering the sweep.
//
// So the only invented numbers are the two human ones, named here so a gate can
// hold them and an argument can move them: the nudge is one arrow key and the
// eye going back to the machine, and the judgement is pressing play and deciding
// once it has run.
//
// It assumes the efficient thing, which here is also the dull thing: try them in
// order and remember which you have tried. There is no gradient to walk, so a
// hand cannot beat enumeration, and this is what enumeration costs.
export const HAND_NUDGE_S = 0.6;
export const HAND_JUDGE_S = 1.4;
export const handTrialSeconds = (aimS = 0) => HAND_NUDGE_S + HAND_JUDGE_S + Math.max(0, aimS || 0);
export const handSearchSeconds = (trials, aimS = 0) => Math.max(0, trials) * handTrialSeconds(aimS);

// ---------- how big the chip's graph is ----------
//
// **At least 128, and up to a fifth of the screen** (2026-08-21, on request).
// 128 over a 32×32 grid is 4 px a cell, which is the floor at which one cell is
// still a thing you can see change and aim a click at; a fifth of a wide screen
// is 384 and puts twelve px under each. The tile is a graph you read, so it
// should grow with the room there is to read it in.
//
// **Rounded to a whole number of pixels per cell.** The canvas is drawn with
// `image-rendering: pixelated` because the cells ARE the data, and a size that
// does not divide by 32 would smear each cell across a fractional boundary —
// which is the one thing that rendering mode exists to prevent.
//
// The height cap is not a preference, it is what keeps "up to 20%" landing
// somewhere visible: on a short window a fifth of the width can be taller than
// the window, and a chip you cannot see all of is not a chip.
// ---------- the aim, on a dial of its own (2026-08-21) ----------
//
// GhostRun used to take its aim from the PLAY DOCK's scrub line, which is a
// run's timeline — so the mode could not be armed until you had played and
// paused, and the button sat dead until then. It never needed the tape: the
// ghost builds its own world from t = 0 every time, and the tape was only ever
// the dial. So it gets a dial.
//
// **CUBED, not linear — and cubed because the range doubled** (2026-08-21:
// *"lets allow up to 60 secs"*). The useful end is the short one: most aims are
// a second or two, and a sweep costs 225 rollouts to whatever you point at, so
// the far end of this slider is where the seconds go.
//
// Squaring put half the travel under 7.6 s while the ceiling was 30. Doubling
// the ceiling and keeping the square would have pushed that to 15 — the range
// would have grown by taking precision away from the part of it anybody uses.
// Cubing gives the 7.6 s halfway point back at twice the reach, and puts the
// first quarter of the travel under 1 s, which is where a pin sweep is worth
// watching frame by frame.
//
// **100 s since 2026-08-22**, and the cube STAYS. The halfway mark moves 7.6 →
// 12.59 s, which reads like the precision loss the cubing was there to prevent
// and is not: seconds-per-notch at any given aim goes as the CUBE ROOT of the
// range, so a 1.67× ceiling costs 1.19× at every aim on the dial — one notch at
// a 2 s aim goes 0.03 → 0.04 s. What the halfway number is really reporting
// is that the far half now carries 40 s more. The short end holds: 125 of the
// 600 notches still land under a second, against 148 before.
export const GHOST_AIM_MIN = 0.1;
export const GHOST_AIM_MAX = 100;
export const GHOST_AIM_DEFAULT = 4;
export const GHOST_AIM_NOTCHES = 600;
export function ghostAimFromNotch(n) {
 const f = clamp((+n || 0) / GHOST_AIM_NOTCHES, 0, 1);
 return Math.round((GHOST_AIM_MIN + (GHOST_AIM_MAX - GHOST_AIM_MIN) * f * f * f) * 100) / 100;
}
export function ghostAimToNotch(t) {
 const f = Math.cbrt(clamp(((+t || 0) - GHOST_AIM_MIN) / (GHOST_AIM_MAX - GHOST_AIM_MIN), 0, 1));
 return Math.round(f * GHOST_AIM_NOTCHES);
}

export const SWEEP_CHIP_MIN = 128;
export const SWEEP_CHIP_VW = 0.20;
// px of header, readout and bar around the graph. **108, not 96, since the
// scale grew a tick** (2026-08-22): the origin's number rides above the ramp at
// `10px * --bar-scale` on a `line-height: 1`, plus the 2 px it clears the strip
// by — twelve px of new chrome, and a budget that does not know about it is a
// chip that runs 12 px past the bottom of a short window.
//
// **126 since the odds got a line of their own** (2026-08-22). It is a
// `.sweep-read`, so it costs exactly what that class costs: a 14 px min-height
// and the 4 px column gap above it. Same arithmetic, same trap.
//
// **130 since the type floor reached the chip** (2026-08-23): the five
// .sweep-title/.sweep-read rows are floored at 9.5px × 1.25 = 11.875px of line
// box against the old 11.2, so the chrome grew 5 × 0.675 ≈ 3.4px — rounded up,
// because this budget understating is a chip past the bottom of a short window.
export const SWEEP_CHIP_CHROME = 130;
// **One unit for every field shape.** The chip's width must not change when a
// field appears (it is a bar you have parked), and a cell must be a whole number
// of pixels (the canvas renders `pixelated`, and the cells ARE the data). Two
// field shapes — 15 for a pin, 10 for a weight — so the size has to divide by
// both, which is what 30 is: their least common multiple, and the smallest one
// that keeps the 128 px floor honest at 150.
export const SWEEP_CHIP_UNIT = 30;
export function sweepChipSize(vw, vh = Infinity, side = SWEEP_CHIP_UNIT) {
 const unit = Math.max(1, side);
 // DOWN for the budgets — "up to a fifth" means not past it — and UP for the
 // floor, because 128 is the smallest cell anybody can aim at and a whole
 // number of pixels per cell is not negotiable. With a 21 grid that makes the
 // floor 147 rather than 126: the nearest multiple below would have broken the
 // one rule that was given as a minimum.
 const down = (px) => (Number.isFinite(px) ? Math.max(unit, Math.floor(px / unit) * unit) : Infinity);
 const min = Math.ceil(SWEEP_CHIP_MIN / unit) * unit;
 const want = down((vw > 0 ? vw : 0) * SWEEP_CHIP_VW);
 const room = down(vh > 0 && Number.isFinite(vh) ? vh - SWEEP_CHIP_CHROME : Infinity);
 // The floor wins a fight with the height cap: a chip too small to read is
 // worse than one that runs past the bottom of a very short window, and the
 // bar it lives on can be dragged.
 return Math.max(min, Math.min(want, room));
}

// Offsets run from -floor(side/2) upward, so (0, 0) is always a real cell — the
// centre one on an odd side, one short of centre on an even one. Written to
// hold either, because it had to hold 32 before it held 21.
export function pinGrid(step, side = PIN_GRID_SIDE) {
 const lo = -Math.floor(side / 2), hi = lo + side - 1;
 const out = [];
 for (let iy = lo; iy <= hi; iy++) for (let ix = lo; ix <= hi; ix++) out.push({ ix, iy, dx: ix * step, dy: iy * step });
 return out;
}
// Where (0,0) sits in a row-major buffer of `side²` cells.
export const pinGridOrigin = (side = PIN_GRID_SIDE) => Math.floor(side / 2);
// A step, printed the way its rung is named — 1, 0.1, 0.01 rather than 0.010000.
export const pinStepLabel = (step) => String(+step.toFixed(4));

// ---------- the cargo's road ----------

// Which samples of a traced path get drawn as a picture of the piece.
//
// **Spaced by TIME, not by distance** (2026-08-21: *"Is px best goal
// piece ghost spacer? The ghost trail tells us where. Time spacing would tell
// us how fast."*). He is right, and it is strictly more information for the
// same ink: the LINE already says where the cargo went, so what the marks along
// it have to add is the part the line cannot carry. At even time the gaps ARE
// the speed — bunched where the cargo dawdles, strung out where it flies — and
// a glance tells you whether a delivery is a gentle roll or a launch. At even
// distance every gap is the same by construction and says nothing at all.
//
// **With a floor, which is why distance was chosen first.** A piece resting for
// three seconds gets a mark every 0.2 s and stacks fifteen of them on one spot —
// an ink blot that reads as an error. So a mark is skipped while it would land
// within `minPx` of the last one drawn: stillness collapses to a single mark
// again, and the moment the piece moves the timing takes over. The floor is
// small enough that only genuine stillness trips it.
//
// **Ten of them, evenly through the run** (2026-08-21, on request: *"I think max
// ten ghost goal pieces in a run. Evenly spread through time."*). A fixed count
// rather than a fixed interval, which is the better rule for the same reason
// even spacing was: it is the RUN you are reading, and ten marks divide any run
// — a third of a second or thirty — into ten legible parts. A fixed interval
// gave three marks on a short aim and forty on a long one.
//
// The first and last are always among them: the start of the road and the end
// of it are the two points that always mean something.
//
// The distance floor survives as a de-duplicator and nothing more. A cargo that
// never moves would otherwise stack ten copies on one spot, and ten translucent
// copies of a thing is an opaque thing — the trace would read as a solid piece
// sitting where nothing is happening.
export function traceMarks(pts, dt = 1 / 30, cap = GHOST_TRACE_MARKS, minPx = GHOST_TRACE_MIN_PX) {
 if (!pts || pts.length < 2) return pts?.length ? [0] : [];
 const last = pts.length - 1;
 const n = Math.max(2, Math.min(cap, pts.length));
 const out = [];
 let prev = null;
 for (let j = 0; j < n; j++) {
 const i = Math.round((j * last) / (n - 1));
 if (prev != null && i !== last && Math.hypot(pts[i].x - pts[prev].x, pts[i].y - pts[prev].y) < minPx) continue;
 out.push(i);
 prev = i;
 }
 if (out[out.length - 1] !== last) out.push(last);
 return out;
}

export const GHOST_ALPHA = 0.42; // the future, drawn over the present
// …and the cargo in it, stronger: the machine is the working, the green thing
// is the answer, and at one alpha the answer was lost among the trace images
// on the way to it.
export const GHOST_CARGO_ALPHA = 0.78;
// Ten marks a run, evenly through its TIME — a fixed count divides any run
// into legible parts, where a fixed interval gave three on a short aim and
// forty on a long one.
export const GHOST_TRACE_MARKS = 10;
export const GHOST_TRACE_MIN_PX = 7; // …but never two within this: ten copies of a still piece is a solid one
export const GHOST_TRACE_ALPHA = 0.3;

// ---------- corner rounding ----------

export const CORNER_RADIUS_DEFAULT = 8;
export const CORNER_RADIUS_LARGE = 16;

// Renderer, editor and physics must resolve the radius through this one shared
// function so collision never disagrees with the art (§5.3).
export function cornerRadiusOf(o) {
 const hw = (o.w ?? 0) / 2, hh = (o.h ?? 0) / 2;
 return clamp(o.radius ?? CORNER_RADIUS_DEFAULT, 0, Math.min(hw, hh));
}

// ---------- geometry ----------

export function rotPt(px, py, cx, cy, ang) {
 const c = Math.cos(ang), s = Math.sin(ang);
 const dx = px - cx, dy = py - cy;
 return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

// Corners of a (possibly rotated) center-based rect.
// The outline a box piece actually HAS, sampled — corners included as arcs.
//
// **`rectCorners` is the shape a box is stored as; this is the shape it is
// drawn and simulated as** (`cornerRadiusOf`, `b2MakeRoundedBox`). Anything
// laying something *against* a crate wants this one: a wrap built from the four
// sharp corners is squarer than the piece it is wrapping, which is exactly what
// a tread round a roundish goal piece looked like — a square tractor.
//
// `pad` pushes the outline out along the surface normal, which for the corner
// arcs means a bigger radius, not a bigger box. At the clamp ceiling
// (`radius = min(hw, hh)`) a square comes back as a circle, which is the whole
// point: a piece that is drawn round wraps round.
export function roundedRectPts(o, pad = 0, perCorner = 4) {
 const hw = (o.w ?? 0) / 2, hh = (o.h ?? 0) / 2;
 const r = cornerRadiusOf(o);
 const a = o.angle || 0, c = Math.cos(a), s = Math.sin(a);
 // the four arc centres, inset by the radius
 const inset = [[-(hw - r), -(hh - r)], [hw - r, -(hh - r)], [hw - r, hh - r], [-(hw - r), hh - r]];
 const start = [Math.PI, -Math.PI / 2, 0, Math.PI / 2]; // each corner's quarter, in order
 const out = [];
 for (let k = 0; k < 4; k++) {
 const [ix, iy] = inset[k];
 // `<=` so both ends of every quarter land on the outline: without it the
 // straight edges between corners are never sampled at their ends and the
 // hull cuts them short.
 for (let i = 0; i <= perCorner; i++) {
 const ang = start[k] + (i / perCorner) * (Math.PI / 2);
 const dx = ix + Math.cos(ang) * (r + pad);
 const dy = iy + Math.sin(ang) * (r + pad);
 out.push({ x: (o.x ?? 0) + dx * c - dy * s, y: (o.y ?? 0) + dx * s + dy * c });
 }
 }
 return out;
}

// Point inside center-based rect (angle-aware), with optional inflate.
export function pointInRect(px, py, r, inflate = 0) {
 const a = r.angle || 0;
 let dx = px - r.x, dy = py - r.y;
 if (a) {
 const c = Math.cos(-a), s = Math.sin(-a);
 const rx = dx * c - dy * s, ry = dx * s + dy * c;
 dx = rx; dy = ry;
 }
 return Math.abs(dx) <= r.w / 2 + inflate && Math.abs(dy) <= r.h / 2 + inflate;
}

// Circle vs (possibly rotated) center-based box: transform the circle's
// centre into the box's local frame, clamp to its half-extents, compare the
// clamped point's distance back to the centre against the radius.
export function circleBoxOverlap(cx, cy, r, box) {
 const a = box.angle || 0;
 const c = Math.cos(-a), s = Math.sin(-a);
 const dx = cx - box.x, dy = cy - box.y;
 const lx = dx * c - dy * s, ly = dx * s + dy * c;
 const hw = box.w / 2, hh = box.h / 2;
 const cxl = clamp(lx, -hw, hw), cyl = clamp(ly, -hh, hh);
 return Math.hypot(lx - cxl, ly - cyl) < r;
}

// ---------- ROUNDED boxes, which is what a crate actually is ----------
//
// **A box piece is drawn and SIMULATED with rounded corners** (`cornerRadiusOf`;
// sim.js builds it with `b2MakeRoundedBox`), and every editor rule was testing
// the sharp rectangle instead. The corner of a 30×30 square reaches 21.21 px
// from the middle; with the default radius 8 the real shape reaches 17.90, and
// at radius 15 — a crate rounded until it IS a circle — only 15. So a crate
// carried up to **6.2 px of collision nobody could see**, at every corner.
//
// The identity that fixes it: a rounded box is exactly the Minkowski sum of a
// smaller CORE box and a disc of the corner radius. So every "does X touch this
// rounded box" question becomes "is X within `cr` of the core box", which the
// primitives above and below already answer.
export function roundedCore(o) {
 const cr = cornerRadiusOf(o);
 return {
 r: cr,
 box: { x: o.x, y: o.y, angle: o.angle || 0,
 w: Math.max(0, (o.w ?? 0) - 2 * cr), h: Math.max(0, (o.h ?? 0) - 2 * cr) },
 };
}

// Shortest distance from a segment to a (possibly rotated) centre-based box —
// 0 when they touch or the segment is inside. `segIntersectsBox` answers a
// yes/no with an INFLATE, which re-squares the corners; a rounded box needs a
// real distance to compare against its radius.
export function segBoxDist(x1, y1, x2, y2, box) {
 const a = box.angle || 0;
 const c = Math.cos(-a), s = Math.sin(-a);
 const tx1 = (x1 - box.x) * c - (y1 - box.y) * s, ty1 = (x1 - box.x) * s + (y1 - box.y) * c;
 const tx2 = (x2 - box.x) * c - (y2 - box.y) * s, ty2 = (x2 - box.x) * s + (y2 - box.y) * c;
 const hw = box.w / 2, hh = box.h / 2;
 // an endpoint inside is distance 0, and so is any crossing
 if ((Math.abs(tx1) <= hw && Math.abs(ty1) <= hh) || (Math.abs(tx2) <= hw && Math.abs(ty2) <= hh)) return 0;
 const edges = [
 [-hw, -hh, hw, -hh], [hw, -hh, hw, hh], [hw, hh, -hw, hh], [-hw, hh, -hw, -hh],
 ];
 let best = Infinity;
 for (const [ex1, ey1, ex2, ey2] of edges) {
 best = Math.min(best, segSegDist(tx1, ty1, tx2, ty2, ex1, ey1, ex2, ey2));
 }
 return best;
}

// Two (possibly rotated) center-based boxes, via the separating axis
// theorem — each box only needs its own two edge-normal axes (parallel
// edges share an axis on a rectangle), 4 total.
export function boxesOverlap(a, b) {
 const ca = rectCorners(a), cb = rectCorners(b);
 const axesOf = (corners) => {
 const out = [];
 for (let i = 0; i < 2; i++) {
 const p1 = corners[i], p2 = corners[i + 1];
 const ex = p2.x - p1.x, ey = p2.y - p1.y;
 const len = Math.hypot(ex, ey) || 1;
 out.push({ x: -ey / len, y: ex / len });
 }
 return out;
 };
 const project = (corners, axis) => {
 let min = Infinity, max = -Infinity;
 for (const c of corners) {
 const p = c.x * axis.x + c.y * axis.y;
 if (p < min) min = p;
 if (p > max) max = p;
 }
 return [min, max];
 };
 for (const axis of [...axesOf(ca), ...axesOf(cb)]) {
 const [minA, maxA] = project(ca, axis), [minB, maxB] = project(cb, axis);
 if (maxA < minB || maxB < minA) return false; // separating axis found
 }
 return true;
}

// ---------- ONE distance, for every pairing (§7.2) ----------
//
// **Every piece in this game is a convex CORE inflated by a RADIUS:**
//
// wheel, any ball a POINT + r
// stick a SEGMENT + ROD_THICK/2
// crate, prop, terrain box a RECTANGLE + cornerRadiusOf (`roundedCore`)
// painted terrain a POLYGON + 0
//
// That is neither an approximation nor a coincidence: it is the same Minkowski
// form Box2D builds internally, where `b2MakeRoundedBox(hw - r, hh - r, r)` IS
// "rectangle plus radius". So the true surface gap between any two pieces is
//
// coreDist(A, B) - A.r - B.r
//
// exactly, for every pairing, with no special cases and no wasm. The editor
// therefore never has to ask the SIMULATION what a shape is — it only has to
// use the same model, which is what this is. (That was the user's question:
// whether the editor and the sim were "two swipes at the same thing". They
// were. This is the one swipe. Box2D's own `b2ShapeDistance` would have done
// it too, but it is not exposed by the pinned compat build, needs a live world
// the editor does not have while editing, and would put a wasm binary in the
// path of `verify-editor.mjs`, which runs 737 gates in a second without one.)
//
// **WHY IT EXISTS.** Eight call sites each answered the shape question their
// own way — `boxesOverlap` (sharp), `segIntersectsBox` with an inflate (which
// re-squares the corner), `circleBoxOverlap` against a raw box — and seven of
// them were wrong, by up to **13.25 px** between two 60×60 crates and 6.63 px
// between two standard ones. It is not an edge case: 226 of the 228 terrain
// boxes in the shipped levels carry a corner radius, because `cornerRadiusOf`
// defaults to 8. One function is one place to be right.
// `scripts/probe-shapes.mjs` measures every pairing against the round-rect the
// RENDERER strokes, and is the thing to re-run after touching any of this.
//
// **IT SATURATES INSIDE.** `coreDist` clamps to 0 once the cores interpenetrate,
// so the gap bottoms out at `-(A.r + B.r)` rather than continuing negative.
// Every rule here asks "is the gap below my tolerance", which stays correct at
// any depth — but do not read the number as a penetration depth. The probe's
// first reference did, and disagreed with a rasterised round-rect by 2.25 px
// until its own stage-0 check caught it.

// A core is `{ pts, r, closed }`: the point set, the radius it is grown by,
// and whether `pts` is a closed outline (a rectangle, a painted loop) rather
// than a bare point or segment.
export function corePoint(x, y, r = 0) { return { pts: [{ x, y }], r, closed: false }; }
export function coreSegment(x1, y1, x2, y2, r = 0) {
 return { pts: [{ x: x1, y: y1 }, { x: x2, y: y2 }], r, closed: false };
}
export function corePoly(pts, r = 0) { return { pts, r, closed: true }; }

// A box's core is its rectangle pulled in by the corner radius — that inset is
// exactly what makes the corner round instead of square. A box rounded until
// it IS a circle has a core of zero extent, and one rounded flat on one axis
// has a core that is a segment; both are collapsed here rather than left as
// degenerate 4-point "polygons", so `pointInPoly` is never asked about a
// rectangle with no area.
export function coreBox(o, pos = null) {
 const { r, box } = roundedCore(pos ? { ...o, x: pos.x, y: pos.y } : o);
 const flatW = box.w <= 0, flatH = box.h <= 0;
 if (flatW && flatH) return corePoint(box.x, box.y, r);
 const c = rectCorners(box);
 if (flatW) return coreSegment(c[0].x, c[0].y, c[2].x, c[2].y, r);
 if (flatH) return coreSegment(c[0].x, c[0].y, c[1].x, c[1].y, r);
 return { pts: c, r, closed: true };
}

// Whichever of the above a placeable piece is. Goal pieces, props and terrain
// all carry `{shape}` or `{type}` of 'ball' or 'box' (§4/§11.1); painted
// terrain has no w/h and reaches this through `corePoly` from the caller,
// which is the one that has to resolve the outline.
export function pieceCore(o, pos = null) {
 const p = pos || o;
 return (o.shape ?? o.type) === 'ball' ? corePoint(p.x, p.y, o.r) : coreBox(o, pos);
}

const coreEdges = (A) => {
 const n = A.pts.length;
 if (n < 2) return [];
 if (!A.closed) return [[A.pts[0], A.pts[1]]];
 const out = [];
 for (let i = 0; i < n; i++) out.push([A.pts[i], A.pts[(i + 1) % n]]);
 return out;
};

// Containment has to be asked separately from edge distance: a small shape
// wholly inside a big one touches none of its edges. Painted loops are the
// case that needs it and they may be CONCAVE, which is why this is
// `pointInPoly` per point rather than a convex test.
const coreContains = (A, B) =>
 A.closed && A.pts.length >= 3 && B.pts.some(p => pointInPoly(p.x, p.y, A.pts));

// Distance between two cores — 0 when they touch, cross, or one is inside the
// other. Every combination of point / segment / outline falls out of the three
// branches below.
export function coreDist(A, B) {
 if (coreContains(A, B) || coreContains(B, A)) return 0;
 const ea = coreEdges(A), eb = coreEdges(B);
 let best = Infinity;
 if (ea.length && eb.length) {
 for (const [a1, a2] of ea) {
 for (const [b1, b2] of eb) {
 best = Math.min(best, segSegDist(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y));
 }
 }
 } else if (ea.length) {
 for (const [a1, a2] of ea) for (const p of B.pts) best = Math.min(best, pointSegDist(p.x, p.y, a1.x, a1.y, a2.x, a2.y));
 } else if (eb.length) {
 for (const [b1, b2] of eb) for (const p of A.pts) best = Math.min(best, pointSegDist(p.x, p.y, b1.x, b1.y, b2.x, b2.y));
 } else {
 best = Math.hypot(A.pts[0].x - B.pts[0].x, A.pts[0].y - B.pts[0].y);
 }
 return best;
}

// The headline: the true surface gap between two shapes. Negative when they
// overlap — saturating, see above.
export function coreGap(A, B) { return coreDist(A, B) - A.r - B.r; }

// …and the same question asked of two placeable pieces at given positions,
// which is what most call sites want.
export function pieceGap(a, aPos, b, bPos) {
 return coreGap(pieceCore(a, aPos), pieceCore(b, bPos));
}

// Distance between two ROUNDED boxes — the primitive `boxesOverlap` never had.
// `boxesOverlap` answers a sharp yes/no by separating axis; this answers "how
// far apart, treating both corners as the arcs they are drawn as".
export function boxBoxDist(a, b) { return coreGap(coreBox(a), coreBox(b)); }

// Do two placeable pieces overlap? Props and goal pieces are the same kind of
// thing geometrically (§4) — `{shape:'box'|'ball', w/h|r, angle?}` either way —
// so one dispatch serves every pairing, and the editor can treat both as solid
// obstacles to a drag (§8.2). `pad` is the tolerance the border is pulled in
// by, so two crates resting flush against each other read as clear rather than
// as a collision — hand-dragging never lands pixel-perfect, and "touching"
// must not mean "jammed together".
//
// **Now one line, over `pieceGap`.** It used to dispatch to three different
// primitives — `circleBoxOverlap` against the RAW box and `boxesOverlap`,
// both of which measure a SHARP rectangle where the piece is drawn and
// simulated round. That cost up to 13.25 px of invisible collision between two
// 60×60 crates and 6.63 px between two standard ones, and it reached
// goal-vs-goal, goal-vs-prop, prop-vs-prop, wheel-vs-prop and every
// placement/paste check through this one function.
//
// `pad` also becomes honest in the corners. It used to deflate whichever
// operand the branch happened to hold — the ball's radius in one, the second
// box's half-extents in another — and shrinking a box by `pad` per side moves
// its CORNER in by `pad × √2`, so the tolerance was 1.41× larger diagonally
// than on the faces. Against a true distance there is one border and `pad`
// moves it by `pad` in every direction.
export function piecesOverlap(a, aPos, b, bPos, pad = 0) {
 return pieceGap(a, aPos, b, bPos) < -pad;
}

// ---------- multi-zone helpers (§7.2/§8.2 — build/goal zone arrays) ----------

// True iff some ONE zone fully contains every point in `pts` — not "each
// point is in some zone," which would let a shape straddle the gap between
// two disjoint zones and incorrectly validate. This is the FAST PATH of the
// containment rule and stays exactly as strict as it always was; zones that
// touch each other are then given a second chance as a cluster (§7.2a, below).
export function allPointsInSomeZone(zones, pts, inflate = 0) {
 return zones.some(z => pts.every(p => pointInRect(p.x, p.y, z, inflate)));
}

// ---------- zone clusters (§7.2a — zones that touch are one region) ----------
//
// Two zones drawn edge to edge read as one bigger area, so a piece is allowed
// to span them: "in" means inside the CLUSTER, not inside any one rectangle.
// Zones that don't touch stay separate regions, which is the whole point of
// the one-zone rule above — a piece may not bridge a gap.
//
// `slack` is the same tolerance the containment tests inflate by, so a
// hairline authoring gap can't be simultaneously papered over by containment
// and treated as a real gap by the join test. Joining at `slack` and testing
// containment at `slack` close exactly the same 2×slack of hairline.
export function zoneClusters(zones, slack = 0) {
 const grow = (z) => ({ ...z, w: z.w + slack * 2, h: z.h + slack * 2 });
 const parent = zones.map((_, i) => i);
 const find = (i) => { while (parent[i] !== i) { i = parent[i] = parent[parent[i]]; } return i; };
 for (let i = 0; i < zones.length; i++) {
 for (let j = i + 1; j < zones.length; j++) {
 if (find(i) === find(j)) continue;
 if (boxesOverlap(grow(zones[i]), grow(zones[j]))) parent[find(i)] = find(j);
 }
 }
 const byRoot = new Map();
 for (let i = 0; i < zones.length; i++) {
 const r = find(i);
 if (!byRoot.has(r)) byRoot.set(r, []);
 byRoot.get(r).push(zones[i]);
 }
 return [...byRoot.values()];
}

// Just the clusters worth a second look: a lone zone has already been decided
// by allPointsInSomeZone/_pieceFullyInGoal, so re-testing it as a "cluster"
// could only ever produce the same answer more slowly.
export function joinedZoneClusters(zones, slack = 0) {
 if (zones.length < 2) return [];
 return zoneClusters(zones, slack).filter(c => c.length > 1);
}

// The single rect a delta-clamp may use for a cluster: its bounding box, so a
// dragged piece can travel the whole region rather than being pinned to the
// rectangle it started in. A lone zone returns ITSELF, not its bounding box —
// single-zone levels (which is nearly all of them) must clamp exactly as they
// always did, and a rotated lone zone's bounding box is bigger than the zone.
export function clusterRect(cluster) {
 if (cluster.length === 1) return cluster[0];
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 for (const z of cluster) {
 for (const c of rectCorners(z)) {
 if (c.x < minX) minX = c.x;
 if (c.x > maxX) maxX = c.x;
 if (c.y < minY) minY = c.y;
 if (c.y > maxY) maxY = c.y;
 }
 }
 return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

// ---------- containment in a UNION of rects ----------

// Signed-area/2 of a polygon, unsigned. Zero for anything degenerate, which
// is what makes the sliver culling below work.
function polyArea(pts) {
 if (pts.length < 3) return 0;
 let a = 0;
 for (let i = 0; i < pts.length; i++) {
 const p = pts[i], q = pts[(i + 1) % pts.length];
 a += p.x * q.y - q.x * p.y;
 }
 return Math.abs(a) / 2;
}

// The four inward half-planes of a (possibly rotated) center-based rect,
// each `{nx, ny, d}` meaning "inside ⇔ nx·x + ny·y ≤ d". Same local frame as
// pointInRect, so the two can never disagree about where the edge is.
function rectHalfPlanes(r, pad = 0) {
 const a = r.angle || 0;
 const c = Math.cos(a), s = Math.sin(a);
 const hw = r.w / 2 + pad, hh = r.h / 2 + pad;
 const alongX = r.x * c + r.y * s; // the centre in local x
 const alongY = -r.x * s + r.y * c; // ...and local y
 return [
 { nx: c, ny: s, d: alongX + hw },
 { nx: -c, ny: -s, d: hw - alongX },
 { nx: -s, ny: c, d: alongY + hh },
 { nx: s, ny: -c, d: hh - alongY },
 ];
}

// Sutherland–Hodgman against ONE half-plane: keeps the part of a convex
// polygon where nx·x + ny·y ≤ d. Convex in, convex out.
function clipHalfPlane(poly, pl) {
 const out = [];
 for (let i = 0; i < poly.length; i++) {
 const a = poly[i], b = poly[(i + 1) % poly.length];
 const da = pl.nx * a.x + pl.ny * a.y - pl.d;
 const db = pl.nx * b.x + pl.ny * b.y - pl.d;
 if (da <= 0) out.push(a);
 if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
 const t = da / (da - db);
 out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
 }
 }
 return out;
}

// Is convex polygon `poly` fully covered by the union of `rects` (each
// inflated by `pad`)? Exact — and it has to be. Testing sample points against
// the union instead would pass a crate bridging the inside corner of an
// L-shaped pair with every sampled corner covered and its middle hanging out
// in the notch, which is precisely the shape "zones that touch are one
// region" invites people to draw.
//
// Method: keep a working set of the parts NOT yet covered, starting with the
// whole polygon, and subtract one rect at a time. Convex minus convex is a
// clean decomposition — for each of the rect's four half-planes in turn, the
// part of the polygon OUTSIDE that plane can never be covered by THIS rect,
// so it drops back into the working set; the part inside carries on to the
// next plane, and whatever survives all four is inside the rect and is
// discarded. An empty working set means covered.
//
// Slivers (a zero-width strip along a shared edge where two zones abut
// exactly) are culled by area, so exact abutment doesn't leave a phantom gap.
export function polyInRectUnion(poly, rects, pad = 0, epsArea = 1e-4) {
 let rest = [poly];
 for (const r of rects) {
 if (!rest.length) return true;
 const next = [];
 for (const p of rest) {
 let inside = p;
 for (const pl of rectHalfPlanes(r, pad)) {
 const outside = clipHalfPlane(inside, { nx: -pl.nx, ny: -pl.ny, d: -pl.d });
 if (polyArea(outside) > epsArea) next.push(outside);
 inside = clipHalfPlane(inside, pl);
 if (polyArea(inside) <= epsArea) break;
 }
 }
 rest = next;
 }
 return !rest.length;
}

// Liang–Barsky in the rect's own frame: the [t0, t1] slice of segment a→b
// that lies inside `r`, or null. Handles a zero-length segment (a point).
function segRectInterval(a, b, r, pad = 0) {
 const ang = r.angle || 0;
 const c = Math.cos(-ang), s = Math.sin(-ang);
 const local = (p) => {
 const dx = p.x - r.x, dy = p.y - r.y;
 return { x: dx * c - dy * s, y: dx * s + dy * c };
 };
 const p0 = local(a), p1 = local(b);
 const hw = r.w / 2 + pad, hh = r.h / 2 + pad;
 const dx = p1.x - p0.x, dy = p1.y - p0.y;
 let t0 = 0, t1 = 1;
 const slab = (p, q) => { // keeps p·t ≤ q
 if (Math.abs(p) < 1e-12) return q >= 0; // parallel: in or out wholesale
 const t = q / p;
 if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
 else { if (t < t0) return false; if (t < t1) t1 = t; }
 return true;
 };
 if (!slab(-dx, p0.x + hw) || !slab(dx, hw - p0.x)) return null;
 if (!slab(-dy, p0.y + hh) || !slab(dy, hh - p0.y)) return null;
 return t0 <= t1 ? [t0, t1] : null;
}

// Is the whole segment a→b covered by the union of `rects`? The polygon
// version can't answer this — a segment has no area, so every leftover would
// cull as a sliver. Exact instead by covering the parameter line: clip the
// segment against each rect, then walk the intervals in order and check they
// leave no uncovered stretch of [0, 1]. This is what lets a stick span the
// seam between two touching build zones without letting one cut the corner
// off an L.
export function segInRectUnion(a, b, rects, pad = 0, eps = 1e-9) {
 const ivs = [];
 for (const r of rects) {
 const iv = segRectInterval(a, b, r, pad);
 if (iv) ivs.push(iv);
 }
 ivs.sort((p, q) => p[0] - q[0]);
 let covered = 0;
 for (const [t0, t1] of ivs) {
 if (t0 > covered + eps) return false; // a hole before this piece starts
 if (t1 > covered) covered = t1;
 if (covered >= 1 - eps) return true;
 }
 return covered >= 1 - eps;
}

// The four corners of an axis-aligned bounds record, as a polygon for
// polyInRectUnion. Callers hold bounds, the union test wants a shape.
// Which single zone already fully contains `bounds`, if any — used to pin a
// drag gesture to the zone it started in, so the clamp target never flip-flops
// mid-drag. Rotation-aware via boundsInRectFrame (below), keeping the original
// arithmetic on the unrotated path for the reason given there.
export function zoneContaining(zones, bounds, slack = 0) {
 return zones.find((z) => footprintInRect(footprintOf(bounds), z, slack)) ?? null;
}

// ---------- rotated rects (§7.2a) ----------
//
// A world-axis-aligned `bounds` re-expressed in `rect`'s OWN frame: where its
// centre sits relative to the rect's centre, and how far it reaches along the
// rect's two axes. This is the one primitive every zone rule needs once zones
// can be rotated — clamping, "which zone am I in" and "does this touch the
// zone" are the same question asked in the rect's frame instead of the world's.
//
// **`footprintOf`, `footprintInRect`, `rectCorners` and `boundsCorners` live in
// sizes.js** as of 2026-08-11 and are re-exported below, so every caller here
// and in game.js is unchanged. They moved because `fcimport.js` needs the
// containment rule too — it decides which of a paste's pieces are somebody's
// SOLUTION by asking whether they are inside the build area — and fcimport is
// imported by the server, which does not import util.js. The comment above
// still describes what they do; sizes.js says why they are where they are.
//
// The clamp and the containment rule take their measurements from the SAME
// footprint, which is the point: a clamp that measures the circle and a rule
// that measures the square would disagree about where the edge is, and that is
// §16's first entry with a structural cause instead of a rounding one.

// A polygon standing in for the footprint, for the CLUSTER test — which
// subtracts rects from a polygon and has nowhere to put a radius. A circle
// becomes a CIRCUMSCRIBED n-gon, so it strictly contains the circle and the
// answer stays conservative: a piece spanning a seam is judged a hair strictly,
// never a hair loosely, which is the safe direction for a containment rule.
// **A ROUNDED BOX arrives here too**, as its four core corners plus the corner
// radius, so `r` no longer implies a single point. Ringing every vertex and
// taking the hull is the Minkowski sum of the polygon and the disc, to the same
// circumscribed-n-gon tolerance a circle already got — one point in, it reduces
// to exactly the circle this used to build.
export function footprintPoly(fp, sides = 16) {
 if (!fp.r) return fp.pts;
 const R = fp.r / Math.cos(Math.PI / sides);
 const out = [];
 for (const c of fp.pts) {
 for (let i = 0; i < sides; i++) {
 const t = (i + 0.5) * 2 * Math.PI / sides;
 out.push({ x: c.x + Math.cos(t) * R, y: c.y + Math.sin(t) * R });
 }
 }
 return fp.pts.length > 1 ? convexHull(out) : out;
}

// The footprint's extent in a rect's own frame — what a delta clamp needs.
// Exact whenever the bounds carries its shape; otherwise the OBB projection of
// the box, which is conservative.
export function boundsInRectFrame(bounds, rect) {
 const a = rect.angle || 0;
 const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
 if (!a) {
 return {
 x: cx - rect.x, y: cy - rect.y,
 hx: (bounds.maxX - bounds.minX) / 2, hy: (bounds.maxY - bounds.minY) / 2,
 };
 }
 const c = Math.cos(a), s = Math.sin(a);
 const toFrame = (px, py) => {
 const dx = px - rect.x, dy = py - rect.y;
 return { x: dx * c + dy * s, y: -dx * s + dy * c }; // rotate by −a
 };
 const fp = footprintOf(bounds);
 let lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
 for (const p of fp.pts) {
 const q = toFrame(p.x, p.y);
 if (q.x < lo.x) lo.x = q.x;
 if (q.x > hi.x) hi.x = q.x;
 if (q.y < lo.y) lo.y = q.y;
 if (q.y > hi.y) hi.y = q.y;
 }
 return {
 x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2,
 hx: (hi.x - lo.x) / 2 + fp.r, hy: (hi.y - lo.y) / 2 + fp.r,
 };
}

// Clamp a shared move delta so `bounds` stays inside one rect — pieces stop at
// the edge instead of bouncing back. On a rotated zone the piece slides along
// the zone's OWN edge, which is the whole point: clamping in world axes would
// make a diagonal edge feel like a staircase.
//
// Measured through `boundsInRectFrame`, i.e. from the piece's FOOTPRINT, so
// this and `footprintInRect` — the containment rule — are reading the same
// geometry. When the two disagree, a drag stops somewhere the drop refuses;
// that is §16's first entry and this file's oldest scar. There is a fuzz gate
// over ~28,000 clamp/containment pairs, half of them rotated, whose only job is
// to keep this sentence true.
export function clampDeltaToRect(bounds, rect, dx, dy, slack = 0) {
 const f = boundsInRectFrame(bounds, rect);
 // Room either side of centre along each axis. A NEGATIVE limit means the
 // piece is bigger than the rect on that axis, so no delta can contain it and
 // the component is left alone rather than pinning a too-big piece to the
 // middle of a zone it can never fit.
 const limX = rect.w / 2 + slack - f.hx;
 const limY = rect.h / 2 + slack - f.hy;
 const a = rect.angle || 0;
 if (!a) {
 if (limX >= 0) dx = clamp(dx, -limX - f.x, limX - f.x);
 if (limY >= 0) dy = clamp(dy, -limY - f.y, limY - f.y);
 return { dx, dy };
 }
 const c = Math.cos(a), s = Math.sin(a);
 let lx = dx * c + dy * s, ly = -dx * s + dy * c; // the proposed move, in the rect's frame
 if (limX >= 0) lx = clamp(lx, -limX - f.x, limX - f.x);
 if (limY >= 0) ly = clamp(ly, -limY - f.y, limY - f.y);
 return { dx: lx * c - ly * s, dy: lx * s + ly * c }; // ...and back to the world
}

// Clamp a stateless placement point into one rect.
export function clampPointToRect(x, y, rect, inset = 0) {
 const a = rect.angle || 0;
 if (!a) {
 return {
 x: clamp(x, rect.x - rect.w / 2 + inset, rect.x + rect.w / 2 - inset),
 y: clamp(y, rect.y - rect.h / 2 + inset, rect.y + rect.h / 2 - inset),
 };
 }
 const c = Math.cos(a), s = Math.sin(a);
 const dx = x - rect.x, dy = y - rect.y;
 const lx = clamp(dx * c + dy * s, -rect.w / 2 + inset, rect.w / 2 - inset);
 const ly = clamp(-dx * s + dy * c, -rect.h / 2 + inset, rect.h / 2 - inset);
 return { x: rect.x + lx * c - ly * s, y: rect.y + lx * s + ly * c };
}

export function pointSegDist(px, py, x1, y1, x2, y2) {
 const dx = x2 - x1, dy = y2 - y1;
 const L2 = dx * dx + dy * dy;
 if (L2 === 0) return Math.hypot(px - x1, py - y1);
 let t = ((px - x1) * dx + (py - y1) * dy) / L2;
 t = clamp(t, 0, 1);
 return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function segsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
 const d = (ax2 - ax1) * (by2 - by1) - (ay2 - ay1) * (bx2 - bx1);
 if (Math.abs(d) < 1e-12) return false;
 const t = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / d;
 const u = ((bx1 - ax1) * (ay2 - ay1) - (by1 - ay1) * (ax2 - ax1)) / d;
 return t > 0 && t < 1 && u > 0 && u < 1;
}

export function segSegDist(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
 if (segsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)) return 0;
 return Math.min(
 pointSegDist(ax1, ay1, bx1, by1, bx2, by2),
 pointSegDist(ax2, ay2, bx1, by1, bx2, by2),
 pointSegDist(bx1, by1, ax1, ay1, ax2, ay2),
 pointSegDist(bx2, by2, ax1, ay1, ax2, ay2),
 );
}

// Segment vs (possibly rotated) center-based box, box inflated by `inflate`.
export function segIntersectsBox(x1, y1, x2, y2, box, inflate = 0) {
 const a = box.angle || 0;
 // transform segment into box-local frame
 const c = Math.cos(-a), s = Math.sin(-a);
 const tx1 = (x1 - box.x) * c - (y1 - box.y) * s, ty1 = (x1 - box.x) * s + (y1 - box.y) * c;
 const tx2 = (x2 - box.x) * c - (y2 - box.y) * s, ty2 = (x2 - box.x) * s + (y2 - box.y) * c;
 const hw = box.w / 2 + inflate, hh = box.h / 2 + inflate;
 // trivially inside
 if (Math.abs(tx1) <= hw && Math.abs(ty1) <= hh) return true;
 if (Math.abs(tx2) <= hw && Math.abs(ty2) <= hh) return true;
 // segment vs 4 edges
 return (
 segsIntersect(tx1, ty1, tx2, ty2, -hw, -hh, hw, -hh) ||
 segsIntersect(tx1, ty1, tx2, ty2, hw, -hh, hw, hh) ||
 segsIntersect(tx1, ty1, tx2, ty2, hw, hh, -hw, hh) ||
 segsIntersect(tx1, ty1, tx2, ty2, -hw, hh, -hw, -hh)
 );
}

export function segIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
 return pointSegDist(cx, cy, x1, y1, x2, y2) <= r;
}

export function aabbOfPts(pts) {
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 for (const p of pts) {
 if (p.x < minX) minX = p.x;
 if (p.y < minY) minY = p.y;
 if (p.x > maxX) maxX = p.x;
 if (p.y > maxY) maxY = p.y;
 }
 return { minX, minY, maxX, maxY };
}

// Monotone-chain convex hull. pts: [{x,y}] → hull in CCW (screen: CW visual, y-down).
export function convexHull(pts) {
 const P = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
 if (P.length < 3) return P;
 const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
 const lower = [];
 for (const p of P) {
 while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
 lower.push(p);
 }
 const upper = [];
 for (let i = P.length - 1; i >= 0; i--) {
 const p = P[i];
 while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
 upper.push(p);
 }
 lower.pop(); upper.pop();
 return lower.concat(upper);
}

// ---------- motion paths (§9) ----------

export function pathIsClosed(origin, path) {
 const pts = path?.pts;
 if (!pts || !pts.length) return false;
 const last = pts[pts.length - 1];
 return Math.hypot(last.x - origin.x, last.y - origin.y) < 1;
}

function bezierAt(p0, c1, c2, p3, t) {
 const mt = 1 - t;
 const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
 return {
 x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
 y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
 };
}

// Anchors of a path: the object origin (handles on path.h1/.h2) then waypoints.
export function pathAnchors(origin, path) {
 const anchors = [{ x: origin.x, y: origin.y, h1: path?.h1, h2: path?.h2 }];
 for (const pt of (path?.pts || [])) anchors.push(pt);
 return anchors;
}

// Resolve the outgoing (h2) and incoming (h1) handle of anchor i as absolute
// control-point offsets. Unset handle → Catmull-Rom tangent (next − prev)/6 —
// exactly the CR↔Bézier identity, so handle-less paths behave like CR splines.
export function resolvedHandles(anchors, i, closed) {
 const n = anchors.length;
 const a = anchors[i];
 let h1 = a.h1, h2 = a.h2;
 if (!h1 || !h2) {
 // neighbours for the CR tangent; for closed paths the last anchor
 // coincides with the first, so wrap over the duplicate.
 let prev, next;
 if (closed) {
 prev = anchors[(i - 1 + n - 1) % (n - 1)];
 next = anchors[(i + 1) % (n - 1)];
 if (i === n - 1) { prev = anchors[n - 2]; next = anchors[1]; }
 } else {
 prev = anchors[Math.max(0, i - 1)];
 next = anchors[Math.min(n - 1, i + 1)];
 }
 const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
 if (!h2) h2 = { x: tx, y: ty };
 if (!h1) h1 = { x: -tx, y: -ty };
 }
 return { h1, h2 };
}

// Control points of segment i (anchors[i] → anchors[i+1]).
export function segControls(anchors, i, closed) {
 const A = anchors[i], B = anchors[i + 1];
 const ha = resolvedHandles(anchors, i, closed);
 const hb = resolvedHandles(anchors, i + 1, closed);
 return {
 p0: A,
 c1: { x: A.x + ha.h2.x, y: A.y + ha.h2.y },
 c2: { x: B.x + hb.h1.x, y: B.y + hb.h1.y },
 p3: B,
 };
}

// Sample a path into a polyline + cumulative arc lengths for constant-speed
// traversal. Returns null when the path has no waypoints.
export function samplePathPts(origin, path, perSeg = 18) {
 const anchors = pathAnchors(origin, path);
 if (anchors.length < 2) return null;
 const closed = pathIsClosed(origin, path);
 const pts = [];
 for (let i = 0; i < anchors.length - 1; i++) {
 const { p0, c1, c2, p3 } = segControls(anchors, i, closed);
 for (let j = (i === 0 ? 0 : 1); j <= perSeg; j++) {
 pts.push(bezierAt(p0, c1, c2, p3, j / perSeg));
 }
 }
 const cum = [0];
 for (let i = 1; i < pts.length; i++) {
 cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
 }
 return { pts, cum, total: cum[cum.length - 1], closed };
}

// Position (and tangent) at arc length s along a sampled path. Position is a
// continuous lerp between the two bracketing polyline samples; the tangent
// used to be the fixed direction of that one chord (constant across it,
// jumping at each of samplePathPts' perSeg=18 chord boundaries) — a mover in
// 'orient' mode would then hold one angle for many fixed steps and snap to
// the next, even though its position eased continuously the whole time.
// Instead blend the per-vertex tangent (central difference, wrapping the
// index for closed paths) by the same t used for position, so orientation
// changes exactly as continuously as position does.
export function pathPosAt(sampled, s) {
 const { pts, cum, total, closed } = sampled;
 if (total <= 0) return { x: pts[0].x, y: pts[0].y, tan: 0 };
 s = clamp(s, 0, total);
 // binary search for segment
 let lo = 0, hi = cum.length - 1;
 while (lo + 1 < hi) {
 const mid = (lo + hi) >> 1;
 if (cum[mid] <= s) lo = mid; else hi = mid;
 }
 const seg = cum[hi] - cum[lo];
 const t = seg > 0 ? (s - cum[lo]) / seg : 0;
 const x = lerp(pts[lo].x, pts[hi].x, t), y = lerp(pts[lo].y, pts[hi].y, t);
 const n = pts.length;
 const vtan = (i) => {
 const ai = closed ? (i - 1 + n) % n : Math.max(i - 1, 0);
 const bi = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
 return Math.atan2(pts[bi].y - pts[ai].y, pts[bi].x - pts[ai].x);
 };
 const tanLo = vtan(lo), tanHi = vtan(hi);
 const tan = tanLo + wrapToPi(tanHi - tanLo) * t;
 return { x, y, tan };
}

// ---------- painted terrain outlines (§5.3, §11.1) ----------
//
// A painted piece is stored in the SAME encoding as a closed motion path: the
// piece's own (x, y) is anchor 0 (handles on its h1/h2), `pts` carries the rest
// in absolute world coordinates, and the last entry duplicates (x, y) to close
// the loop. That is what lets pathAnchors/resolvedHandles/segControls/
// samplePathPts/_pathHit and the waypoint+handle drags all work on an outline
// with no geometry code of their own — the piece is its own path.

export const isPaint = (t) => !!t && t.type === 'paint';

// Anchors of a painted outline, closing duplicate included (so the Catmull-Rom
// tangents wrap, exactly as they do on a closed path).
export function paintAnchors(t) {
 return pathAnchors(t, t);
}

// Signed area of a polygon, y-DOWN: positive = clockwise on screen. Winding is
// not cosmetic here — Box2D chain segments are one-sided, and clockwise is the
// winding that makes the loop solid from outside (measured against the pinned
// binary; counter-clockwise turns the same loop into a bowl you fall into).
export function polyArea2(pts) {
 let a = 0;
 for (let i = 0, n = pts.length; i < n; i++) {
 const p = pts[i], q = pts[(i + 1) % n];
 a += p.x * q.y - q.x * p.y;
 }
 return a;
}

// Douglas–Peucker. The outline is sampled at a fixed rate per Bézier segment,
// which is right for a curve and wasteful for the straight runs most painted
// terrain is mostly made of — this drops the collinear samples so a straight
// edge costs 2 chain segments instead of 12. Pure float math, so every client
// simplifies identically (§5.8).
export function simplifyPolyline(pts, tol = 0.4) {
 if (pts.length < 3) return pts.slice();
 const keep = new Uint8Array(pts.length);
 keep[0] = keep[pts.length - 1] = 1;
 const stack = [[0, pts.length - 1]];
 while (stack.length) {
 const [lo, hi] = stack.pop();
 let worst = 0, at = -1;
 for (let i = lo + 1; i < hi; i++) {
 const d = pointSegDist(pts[i].x, pts[i].y, pts[lo].x, pts[lo].y, pts[hi].x, pts[hi].y);
 if (d > worst) { worst = d; at = i; }
 }
 if (at >= 0 && worst > tol) {
 keep[at] = 1;
 stack.push([lo, at], [at, hi]);
 }
 }
 return pts.filter((_, i) => keep[i]);
}

// The outline as a plain polygon: sampled curve → simplified → clockwise, with
// the closing duplicate dropped (a chain loop closes itself). This is the one
// function the renderer's hit tests, the editor's overlap checks and the chain
// builder all measure against, so they can never disagree about where the
// surface is.
export function paintOutline(t, perSeg = 12, tol = 0.4) {
 const sampled = samplePathPts(t, t, perSeg);
 if (!sampled || sampled.pts.length < 4) return null;
 let pts = sampled.pts.slice();
 // The loop's last sample is its first point again. Simplify with that
 // closing point still attached — Douglas–Peucker pins both ends, so cutting
 // it first would strand every sample along the final edge (a straight
 // 4-corner loop came out with a phantom fifth vertex a few px up the closing
 // side). Pinning the same vertex at both ends makes the ring simplify like
 // the ring it is; the duplicate comes off afterwards.
 pts = simplifyPolyline(pts, tol);
 const first = pts[0], last = pts[pts.length - 1];
 if (pts.length > 3 && Math.hypot(last.x - first.x, last.y - first.y) < 0.01) pts.pop();
 if (pts.length < 3) return null;
 if (polyArea2(pts) < 0) pts.reverse(); // normalise to clockwise = solid
 return pts;
}

// Sampling + simplifying an outline costs ~30 µs, and the editor asks for the
// same outline many times a frame (hit tests, bounds, every overlap check
// against every piece during a drag). Cached per piece against a key built
// from its own anchors, so a vertex drag invalidates it and nothing else does.
// WeakMap keyed by the piece object also means an undo — which REPLACES the
// objects (§8.2) — starts from a clean cache on its own.
const outlineCache = new WeakMap();
const paintKey = (t) => {
 let k = t.x + ',' + t.y;
 for (const a of (t.pts || [])) {
 k += '|' + a.x + ',' + a.y;
 if (a.h1) k += 'a' + a.h1.x + ',' + a.h1.y;
 if (a.h2) k += 'b' + a.h2.x + ',' + a.h2.y;
 }
 if (t.h1) k += 'A' + t.h1.x + ',' + t.h1.y;
 if (t.h2) k += 'B' + t.h2.x + ',' + t.h2.y;
 return k;
};
export function paintOutlineOf(t) {
 const key = paintKey(t);
 let hit = outlineCache.get(t);
 if (!hit || hit.key !== key) {
 hit = { key, pts: paintOutline(t) };
 outlineCache.set(t, hit);
 }
 return hit.pts;
}

// Crossing-number point-in-polygon. Used for picking a painted piece, for the
// editor's "you can't build in there" checks, and for the hollow-shell warning.
export function pointInPoly(x, y, pts) {
 let inside = false;
 for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
 const a = pts[i], b = pts[j];
 if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
 }
 return inside;
}

// Does a segment touch the outline (crossing it, or ending inside it)? The
// containment test is what makes a stick drawn wholly inside a painted blob
// illegal — crossing tests alone would call it clear.
export function segHitsPoly(x1, y1, x2, y2, pts, pad = 0) {
 if (pointInPoly(x1, y1, pts) || pointInPoly(x2, y2, pts)) return true;
 for (let i = 0, n = pts.length; i < n; i++) {
 const a = pts[i], b = pts[(i + 1) % n];
 if (segsIntersect(x1, y1, x2, y2, a.x, a.y, b.x, b.y)) return true;
 if (pad > 0 && segSegDist(x1, y1, x2, y2, a.x, a.y, b.x, b.y) < pad) return true;
 }
 return false;
}

// Circle vs outline: inside, or close enough to any edge to be overlapping it.
export function circlePolyOverlap(cx, cy, r, pts) {
 if (pointInPoly(cx, cy, pts)) return true;
 for (let i = 0, n = pts.length; i < n; i++) {
 const a = pts[i], b = pts[(i + 1) % n];
 if (pointSegDist(cx, cy, a.x, a.y, b.x, b.y) < r) return true;
 }
 return false;
}

// A self-crossing loop has no well-defined inside, and Box2D's one-sided chain
// segments behave arbitrarily along the crossing — so the editor refuses to
// solidify one rather than shipping a piece whose collision nobody can predict.
export function polySelfIntersects(pts) {
 const n = pts.length;
 for (let i = 0; i < n; i++) {
 const a1 = pts[i], a2 = pts[(i + 1) % n];
 for (let j = i + 1; j < n; j++) {
 if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // shared vertex
 const b1 = pts[j], b2 = pts[(j + 1) % n];
 if (segsIntersect(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y)) return true;
 }
 }
 return false;
}

export function polyBounds(pts) {
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 for (const p of pts) {
 if (p.x < minX) minX = p.x;
 if (p.y < minY) minY = p.y;
 if (p.x > maxX) maxX = p.x;
 if (p.y > maxY) maxY = p.y;
 }
 return { minX, minY, maxX, maxY };
}

export function polyCentroid(pts) {
 const b = polyBounds(pts);
 return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

// De Casteljau split of segment at t — returns the two halves' control data so
// an anchor can be inserted with shape preserved.
export function splitBezier(p0, c1, c2, p3, t) {
 const L = (a, b) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
 const q0 = L(p0, c1), q1 = L(c1, c2), q2 = L(c2, p3);
 const r0 = L(q0, q1), r1 = L(q1, q2);
 const s = L(r0, r1);
 return {
 point: s,
 // handles as offsets from their anchors
 left: { c1: { x: q0.x - p0.x, y: q0.y - p0.y }, c2: { x: r0.x - s.x, y: r0.y - s.y } },
 right: { c1: { x: r1.x - s.x, y: r1.y - s.y }, c2: { x: q2.x - p3.x, y: q2.y - p3.y } },
 };
}

// Travel/spin slider notches are exponential 1–10 ≈ 4…800 px/s (§9.2).
// Widened from the original 10…220: 4 for terrain that should creep, 800 for
// terrain that should hurl. Still ten notches, so the ladder is
// 4, 7, 13, 23, 42, 76, 137, 246, 444, 800 — and 40 (the default travel speed)
// and 60 (the default spin) sit on the same notches they always did, so no
// existing level's slider jumps when you open it.
// `speed` is stored as absolute px/s, never as a notch: widening the slider
// cannot change how an already-saved level moves.
export const SPEED_MIN = 4, SPEED_MAX = 800;
const SPEED_RATIO = SPEED_MAX / SPEED_MIN;

export function notchToSpeed(n) {
 return Math.round(SPEED_MIN * Math.pow(SPEED_RATIO, (n - 1) / 9));
}
export function speedToNotch(v) {
 const n = Math.round(1 + 9 * Math.log(Math.max(v, 0.5) / SPEED_MIN) / Math.log(SPEED_RATIO));
 return clamp(n, 1, 10);
}

// **Typed speeds land on the ladder's ENDS, not between its rungs**
// (2026-08-08). Double-clicking a slider now opens a box you type a number
// into, which is the first way a speed has ever been set off the ten notches —
// so it is also the first thing that could ask for 0, or for 5000. The range is
// the slider's own, because that is the range the ladder was measured for: 4 is
// terrain that creeps, 800 is terrain that hurls, and 0 is a piece with a path
// it never travels (a motion that does nothing, which the info chip then cannot
// report a time for at all).
export function clampSpeed(v) {
 if (!isFinite(v)) return null;
 return clamp(Math.round(v * 10) / 10, SPEED_MIN, SPEED_MAX);
}

// The same number, read as a duration — what the Seconds box types in.
//
// This is why a typed speed is worth having at all: nobody knows a platform
// wants 137 px/s, and everybody knows it should cross in two seconds. `len` is
// the path's true ARC length (samplePathPts, the same one the sim travels and
// the info chip prints), so the answer is the trip the level actually makes
// rather than the sum of the waypoint chords.
//
// Both directions refuse rather than guess on a degenerate input: a path with
// no length has no speed that takes any particular time, and a trip of zero
// seconds is not a fast trip, it is not a trip.
export function speedForSeconds(len, secs) {
 if (!(len > 0) || !(secs > 0) || !isFinite(secs)) return null;
 return clampSpeed(len / secs);
}
export function secondsForSpeed(len, speed) {
 if (!(len > 0) || !(speed > 0)) return null;
 return len / speed;
}

export const SPIN_RATE_DIVISOR = 37.5; // spinRate = spinSpeed / 37.5 rad/s (§9.2)

// A spin's natural unit is not px/s but SECONDS PER REVOLUTION — it is what you
// time a gate or a flinger against, and it is what the info chip has always
// printed. `spinSpeed` is the stored number and this is the round trip to it,
// so the Seconds box on the Spin row types the quantity an author actually has
// in mind. The 2π/rate is the same arithmetic `_motionStats` does.
export function spinSpeedForSeconds(secs) {
 if (!(secs > 0) || !isFinite(secs)) return null;
 return clampSpeed(2 * Math.PI * SPIN_RATE_DIVISOR / secs);
}
export function secondsForSpinSpeed(speed) {
 if (!(speed > 0)) return null;
 return 2 * Math.PI * SPIN_RATE_DIVISOR / speed;
}

// ---------- playback speed (§7.2) ----------
//
// The notch ladder lives HERE rather than in game.js so a gate can reach it:
// the frame loop that spends it is a DOM handler and unreachable headlessly,
// so what a gate can check is the ladder itself and the budget rule below.
//
// **×32 joined 2026-08-20, and above it MAX rather than another number.** The
// measured cost of a fixed step on this engine is 10 µs on an ordinary
// machine and 165 µs on the heaviest thing in the corpus (a 103-piece Sticks
// solve), and ×32 is 16 steps a frame — 0.2 ms and 2.6 ms respectively, both
// comfortably inside a 60 fps frame. ×64 would be 5.3 ms on that same worst
// machine, which is most of the frame on a level whose renderer already wants
// several, so the honest next rung is not a bigger number: it is a rung that
// ASKS the machine how much it can do.
export const PLAY_MAX = Infinity; // the MAX notch's sentinel (SPEED_MAX above is a mover's px/s)
export const SPEED_NOTCHES = [0.25, 0.5, 0.75, 1, 2, 4, 8, 16, 32, PLAY_MAX];
export const SPEED_DEFAULT_NOTCH = SPEED_NOTCHES.indexOf(1);
// A rate is only worth printing while there IS one: once the aftermath is
// over MAX runs at real time on purpose, and a label that then reads "MAX 0×"
// looks like a bug rather than like a job finished.
export const speedLabel = (speed, achieved = null) =>
 speed === PLAY_MAX ? (achieved >= 2 ? `MAX ${Math.round(achieved)}×` : 'MAX') : speed + '×';

// **What MAX may spend on physics: whatever the RENDERER is not using, out of
// the frame it is actually in.** The draw cost is already measured every frame
// for the fps chip's tooltip, so MAX is self-tuning on the one number that
// varies — but the frame it is carving up has to be the REAL one.
//
// **This shipped measuring an assumed 16.7 ms frame, and that was the bug**
// (2026-08-21, reported as "on MAX it goes really fast then slows down, and
// if I drop it to ×32 it goes FASTER"). A numbered notch scales with the
// frame: ×32 asks for 32 × dt of simulated time, so it is 32× at 60 fps and
// 32× at 10 fps. A budget carved out of 16.7 ms does not — at 30 fps it gets
// half as many chances per second, at 10 fps a sixth — so exactly where a
// heavy level drops the frame rate, MAX collapsed. Measured, on a 103-piece
// machine with a draw taking two thirds of the frame:
//
// fps 60 30 20 10
// ×32 32× 32× 32× 32×
// MAX was 62× 16× 11× 5× ← slower than the notch below it
// MAX now 62× 80× 85× 91×
//
// The floor keeps a pathological draw from starving the run to a standstill;
// the SHARE keeps MAX from spending a whole frame, because something has to
// be left for the browser and a frame that never yields is a page that looks
// hung.
export const SPEED_BUDGET_FLOOR_MS = 2;
export const SPEED_BUDGET_SHARE = 0.7; // of the frame, at most
export function speedBudgetMs(drawMs = 0, frameMs = 1000 / 60) {
 // A frame time of 0, NaN or a tab-switch's several seconds is not a frame to
 // budget against; 8–200 ms is 120 fps down to 5.
 const f = clamp(frameMs > 0 ? frameMs : 1000 / 60, 8, 200);
 return clamp(f - (drawMs > 0 ? drawMs : 0) - 2, SPEED_BUDGET_FLOOR_MS, f * SPEED_BUDGET_SHARE);
}

// **What a numbered notch asks for in this frame** — and therefore the floor
// under MAX, because a notch called MAX that runs slower than the one below it
// is a broken promise before it is a performance question. Pure, so the gate
// can hold it; `stepSeconds` is passed in because the fixed step lives in
// sim.js and sim.js imports THIS file.
export const stepsForNotch = (speed, dtSeconds, stepSeconds) =>
 Math.max(1, Math.ceil((speed * (dtSeconds > 0 ? dtSeconds : 0)) / stepSeconds));
// …and a hard stop on the count, for the case the budget cannot catch: a
// machine so cheap that the loop is bounded by nothing else. 300 steps is ten
// SECONDS of simulated time in one frame, which is faster than anything is
// worth watching and keeps one frame's worth of collisions inside the sound
// buffer's own cap.
export const PLAY_MAX_STEPS = 300;

// ---------- badges (§11.4) — derived, never stored ----------

// **The No Wheels badge draws the GAME'S free wheel, whatever the game's free
// wheel currently looks like.**
//
// It used to be a hand copy of `svgWheelCell` (render.js, the drawing the
// wordmark and the toolbar are built from) — restated here because render.js
// imports THIS file and the dependency only runs one way. The copy went stale
// the moment the wheel gained its machining: the game's wheel now carries a
// race, a detent at every slot and the drive arrows, and its pins moved to
// FC's own lattice, while the badge still showed the flat grey disc with four
// compass pins that the piece had in July.
//
// So the dependency is inverted instead of duplicated: render.js REGISTERS
// its own drawing here as it loads (`setBadgeArt`), and the badge asks for it
// through a getter. Every page that can draw a badge imports render.js — it
// is what draws the game — so the registered art is what ships, and the next
// change to the wheel arrives here by itself. `verify-gfx` gates the two
// against each other so this can never silently drift again.
//
// The fallback below is deliberately the CRUDEST honest wheel rather than a
// second copy of the good one: grey disc, rim, F, hub. If it ever appears on
// screen, something imported the badge without the renderer, and it should
// look like the placeholder it is rather than like a slightly-wrong wheel.
const freeWheelSVG = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
<circle cx="12" cy="12" r="11" fill="#cbd3e1"/>
<circle cx="12" cy="12" r="11" fill="none" stroke="#9aa5b5" stroke-width="1.8"/>
<path d="M 8.5 17.5 L 8.5 6.5 L 16.5 6.5 M 8.5 12 L 14.5 12" fill="none" stroke="#232a35" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="12" cy="12" r="1.05" fill="#232a35"/><circle cx="12" cy="12" r="0.45" fill="#fff"/>
</svg>`;

// Art a drawing module has published for the badges. One object, assigned into
// rather than replaced, so load order between registrations cannot matter.
const BADGE_ART = Object.create(null);
export function setBadgeArt(art) { Object.assign(BADGE_ART, art); }
export function badgeArt(name) { return BADGE_ART[name] || null; }

// **The flat hand of a DO NOT TOUCH sign, for Untampered.** The lock it replaces
// said "sealed", which is the wrong idea twice over: nothing here is locked, and
// what the badge is actually about is a thing you could have moved and didn't.
// A palm is the one symbol everybody already reads as "hands off".
//
// It carries no ring and no bar of its own — `neg: true` puts it inside the same
// red prohibition sign No Wheels and No Power wear (`.badge.neg`, style.css), so
// the sign is drawn once for the whole family instead of three times. That is
// also why this is a bare hand rather than the finished sign: baked in, it would
// be a sign inside a sign.
//
// Built from round-capped STROKES rather than an outline, which is what makes it
// survive being 12px across: the caps are the fingertips, so there is no small
// curve to lose, and the palm is a rounded rect the fingers simply run into.
// Everything is one colour, so the overlaps disappear.
//
// **Three things were wrong with the first attempt and all three were spacing.**
// It read as a mitten. The fingers were 2.8 apart at 2.7 wide — a tenth of a
// unit of daylight between them, which at this size is none, so they merged into
// one slab. The thumb was a 4-unit stub leaving the palm at the wrong height,
// which reads as a fifth finger that went wrong rather than as a thumb. And the
// whole hand only used 62% of the box, so every one of those faults was being
// judged at nine pixels. Now: 0.9 of a unit between fingers (a visible notch),
// a thumb half again as long leaving low on the palm at ~34°, and 18 of the 24
// units used — with the drawing itself a point larger at 16, since a hand needs
// more room to be read than a wheel does.
const noTouchSVG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
<g fill="none" stroke="currentColor" stroke-linecap="round">
<g stroke-width="3">
<path d="M8.6 13.8 V6"/><path d="M12.5 13.8 V4.6"/><path d="M16.4 13.8 V5.4"/><path d="M20 13.8 V8"/>
</g>
<path d="M9.2 17.2 L3.6 13.4" stroke-width="3.3"/>
</g>
<rect x="7.1" y="12.2" width="14.4" height="9" rx="3.4" fill="currentColor"/>
</svg>`;

// **A PUSH broom, for Sweep** — 🧹 is a besom, and at badge size every font
// draws it as a brush on a stick, which read as painting rather than clearing.
// What tells the two apart is the HEAD: a broom's is wide, flat and square to
// the handle, and a brush's is not. So the head spans nearly the whole box and
// the handle comes into the middle of it at an angle, which is the silhouette of
// pushing something along the floor.
//
// Drawn back-to-front — handle, bristles, then the stock over both — so the
// stock hides where the handle lands and where the bristles are seated, and no
// join has to be mitred. Wood off the game's own palette (COLORS.woodCore /
// woodEdge), because a broom in this world is made of the same stuff the sticks
// are.
const pushBroomSVG = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
<path d="M19.2 2.6 L12.8 13.2" fill="none" stroke="#a87b4f" stroke-width="2.4" stroke-linecap="round"/>
<path d="M4.3 17.3 H19.7 L20.9 21.6 H3.1 Z" fill="#e8c08a"/>
<g fill="none" stroke="#b98f57" stroke-width="0.9" stroke-linecap="round">
<path d="M8.2 17.6 L7.4 21.3"/><path d="M12 17.6 V21.3"/><path d="M15.8 17.6 L16.6 21.3"/>
</g>
<rect x="3.4" y="13.3" width="17.2" height="4.3" rx="1.5" fill="#7d5a38"/>
</svg>`;

// **A nail driven half into the bullseye, for Nailed It.** 🎯 alone is "on
// target", which is most of the badge but not the half that matters: this one is
// awarded for a delivery that STAYED — came to rest, or held the zone for twenty
// seconds. A dart says you hit it. A nail says it is not going anywhere, and
// that is the whole rule in one picture.
//
// The nail is deliberately oversized against the target and enters dead centre,
// so the head sits well outside the rings — half in, and unmistakably driven
// rather than resting on top. Two strokes down the same line make the shaft
// read as round metal (a wide dark one, a narrow bright one over it) and the
// head is a single bar square across the shaft.
const nailedItSVG = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
<circle cx="10.6" cy="13.4" r="9.4" fill="#e23434"/>
<circle cx="10.6" cy="13.4" r="6.2" fill="#fff"/>
<circle cx="10.6" cy="13.4" r="3" fill="#e23434"/>
<path d="M10.6 13.4 L19.8 4.2" stroke="#7c8697" stroke-width="3.2"/>
<path d="M10.6 13.4 L19.8 4.2" stroke="#cdd5e0" stroke-width="1.4"/>
<path d="M18.4 2.8 L21.2 5.6" stroke="#7c8697" stroke-width="2.8" stroke-linecap="round"/>
</svg>`;

export const BADGE_DEFS = [
 { id: 'solved', name: 'Solved', emoji: '✅', desc: 'The machine delivered every goal piece.',
 filterOff: 'Off. Click for solved.',
 filterYes: 'Only solved. Goal pieces delivered. Click for unsolved.',
 filterNone: 'Only unsolved. Not delivered. Click to turn off.' },
 { id: 'wet', name: 'Wet', emoji: '💧', desc: 'Nothing but water sticks — no wood, no wheels. An empty machine counts.',
 filterOff: 'Off. Click for wet.',
 filterYes: 'Only wet. Nothing but water sticks. Click for not wet.',
 filterNone: 'Only not wet. Has wood or wheels. Click to turn off.' },
 // **The "did without" badges are NEGATIVE badges**, and they say so in
 // the same shape: the thing you didn't use, inside a red prohibition ring
 // (`neg: true` → `.badge.neg` in style.css draws the circle and the bar).
 // Named for the constraint rather than the material — "No Wheels" is what
 // the player set out to do; "Rods Only" described the leftovers. It also
 // makes the ladder read as one sentence: Wet ⊂ No Wheels ⊂ No Power.
 // Untampered is the third of them (its lock became a do-not-touch hand), and
 // it is the one that shows the flag is worth having: a badge earned by NOT
 // doing something gets the sign for free, wherever it happens to sit in the
 // list — it is not a property of this pair.
 //
 // The wheel is the GAME'S OWN F wheel (`svg`, below), not 🛞 — the badge is
 // about the piece in the toolbar, and a generic tyre emoji is a different
 // object that happens to be round. `emoji` stays as the fallback for the
 // places that can only take text.
 { id: 'rods', name: 'No Wheels', emoji: '🛞', get svg() { return BADGE_ART.freeWheel || freeWheelSVG; }, neg: true, desc: 'No wheels at all.',
 filterOff: 'Off. Click for no wheels.',
 filterYes: 'Only no wheels. No wheels at all. Click for with wheels.',
 filterNone: 'Only with wheels. Has wheels. Click to turn off.' },
 // **The ring and the bar are CSS, not characters.** The obvious spelling is
 // the glyph plus U+20E0 (combining enclosing circle-backslash); measured in
 // the browser, that pair does not composite over an emoji base — ⚡⃠ renders
 // 18 px wide against the bolt's 55, i.e. a thin text-form bolt with a stray
 // mark rather than a crossed-out symbol. There is no single code point for
 // "lightning with a prohibition sign", so `.badge.neg` draws it.
 //
 // Keeping the character a bare ⚡ is also what makes the TEXT uses right:
 // `challengeTip` writes "⚡ No Power", where the word carries the meaning and
 // a struck-through glyph would only have been noise.
 //
 // The old 🪫 low-battery said "nearly out of charge", which is a different
 // idea from "no motors at all", and it left ⚡ meaning the opposite badge.
 { id: 'powerless', name: 'No Power', emoji: '⚡', neg: true, desc: 'No powered wheels.',
 filterOff: 'Off. Click for no power.',
 filterYes: 'Only no power. No powered wheels. Click for with power.',
 filterNone: 'Only with power. Has powered wheels. Click to turn off.' },
 // **There is no POWERED badge**, and that is deliberate (2026-08-04):
 // "at least one powered wheel" is what almost every machine does, so it
 // marked the ordinary case — while every other badge here marks a
 // constraint somebody chose to work under. No Power is a challenge;
 // powered is just Tuesday. Removing it also frees ⚡ for the badge above.
 // Badges are DERIVED and never stored (§11.4), so nothing has to migrate:
 // the badge simply stops being computed, for every solve ever recorded.
 // **The lock is gone.** 🔒 said "sealed" — a thing that CANNOT be opened —
 // when what this marks is a thing you were free to move and chose not to.
 // A do-not-touch hand says exactly that, and it joins the negative family
 // above rather than inventing a second visual language for the same idea:
 // "No Touch" is the same sentence as "No Wheels" and "No Power".
 // The emoji falls back to a bare ✋ for the text-only places, on the same
 // terms as ⚡ — the word beside it is what carries the "no".
 { id: 'untampered', name: 'Untampered', emoji: '✋', svg: noTouchSVG, neg: true, desc: 'No goal piece moved before Play.',
 filterOff: 'Off. Click for untampered.',
 filterYes: 'Only untampered. Goal piece not moved. Click for tampered.',
 filterNone: 'Only tampered. Goal piece moved. Click to turn off.' },
 // **`late: true` — the AFTERMATH's to award** (§7.1a). These three cannot be
 // known at the moment of winning: the delivery has to hold, the machine has
 // to come home, the pieces have to fall out of the world, and all of that
 // takes up to one more simulated minute. The flag is what `AFTERMATH_BADGES`
 // and `aftermathVerdict` are built from, so the set exists once instead of
 // being retyped at every site that handles a verdict — which is exactly how
 // Sweep went missing from one of them (see aftermathVerdict).
 { id: 'nailedIt', name: 'Nailed It', emoji: '🎯', svg: nailedItSVG, late: true, desc: 'The delivery held — every goal piece came to rest in the zone, or stayed in it for 10 seconds straight.',
 filterOff: 'Off. Click for nailed it.',
 filterYes: 'Only nailed it. Delivery held. Click for not nailed.',
 filterNone: 'Only not nailed. Delivery did not hold. Click to turn off.' },
 { id: 'boomerang', name: 'Boomerang', emoji: '🪃', late: true, desc: 'After delivering, the machine brought every goal piece back to the build zone.',
 filterOff: 'Off. Click for boomerang.',
 filterYes: 'Only boomerang. Goals came home. Click for no boomerang.',
 filterNone: 'Only no boomerang. Goals stayed out. Click to turn off.' },
 { id: 'sweep', name: 'Sweep', emoji: '🧹', svg: pushBroomSVG, late: true, desc: 'Every piece you built ended up in the void — the machine cleared itself away. A no-piece solve counts.',
 filterOff: 'Off. Click for sweep.',
 filterYes: 'Only sweep. Machine cleared itself. Click for no sweep.',
 filterNone: 'Only no sweep. Machine did not clear. Click to turn off.' },
 { id: 'nrw', name: 'No Ridiculous Weights', emoji: '🪶', desc: 'No pin carries more than ×200 of stick weight — counted per PIN, so two heavy sticks bolted together do not slip through separately.',
 filterOff: 'Off. Click for no ridiculous weights.',
 filterYes: 'Only NRW. No pin over ×200. Click for heavy.',
 filterNone: 'Only heavy. A pin is over ×200. Click to turn off.' },
];

// WET is "nothing but water" — no wood, no wheels. It used to be
// `water > 0 && wood === 0`, which said nothing about wheels, so a machine with
// three powered wheels and one water stick wore the badge.
//
// There is no `water > 0` term, and that is deliberate: a solve that uses NO
// PIECES AT ALL is the purest case of not using wood and not using wheels, so
// it takes wet, rods and powerless together. The empty machine is the limit of
// every sparseness badge, not an exception to them.
//
// The rule also makes the ladder nest — wet ⇒ rods ⇒ powerless — so a wheel-
// free water machine is strictly the hardest of the three (no wheels means no
// motors at all). Badges are derived and never stored (§11.4), so the whole
// rule applies to every solve ever recorded, retroactively.
// …and a GHOST stick is not a water one, so it does not earn Wet either — the
// badge's own words are "nothing but water sticks", and a machine that touches
// nothing at all is a different claim from one that only touches the floor.
const isWet = (s) => (s.wood | 0) === 0 && (s.wheels | 0) === 0 && (s.ghost | 0) === 0;

// ---------- the aftermath verdict (§7.1a) ----------
//
// The three badges the aftermath decides, and the one place their names are
// listed. Derived from the `late` flag so a fourth one is a word on its
// definition and nothing else.
export const AFTERMATH_BADGES = BADGE_DEFS.filter((b) => b.late).map((b) => b.id);

// A verdict read off a finished simulation — every late badge, always present,
// always boolean.
//
// **It exists because this shape was typed out by hand at four sites and one
// of them was wrong.** `_startAftermath`'s offscreen check built
// `{nailedIt, boomerang}` with no `sweep` key; `_awarded()` returns a settled
// verdict verbatim, so the moment the check finished, Sweep went from earned
// to absent — and because Save runs the check before writing, every saved
// swept run recorded `sweep: false` in the database. The badge was correct on
// screen right up until the player asked to keep it.
//
// A missing KEY is the failure mode, not a wrong value, which is why the gate
// on this asserts the key set against `AFTERMATH_BADGES` rather than checking
// three booleans it would have to remember to list.
export function aftermathVerdict(sim) {
 const out = {};
 for (const id of AFTERMATH_BADGES) out[id] = !!(sim && sim[id]);
 return out;
}

export function computeBadges(s) {
 // **A machine that was built outside the build area earns NOTHING** (§Free
 // World, 2026-08-09). Not even `solved`: the run happened, and it is still
 // worth watching and worth saving, but the build area is the constraint the
 // whole puzzle IS — a delivery made from anywhere at all has not answered
 // the question the level asked.
 //
 // First, and returning outright rather than filtering afterwards, because
 // every badge below is a claim about a machine that obeyed the rules. WET
 // and SWEEP in particular are awarded to the empty machine as limits, and an
 // empty machine that never had to fit anywhere is not the same achievement.
 //
 // `escaped` is set by the editor from the STRICT zone test — the one Free
 // World suspends — so it is true exactly when a piece really is outside,
 // never merely because the toggle was on.
 if (s.escaped) return [];
 const out = [];
 if (s.won) out.push('solved');
 if (isWet(s)) out.push('wet');
 if ((s.wheels | 0) === 0) out.push('rods');
 if ((s.poweredWheels | 0) === 0) out.push('powerless');
 if (s.untampered) out.push('untampered');
 if (s.won && s.nailedIt) out.push('nailedIt');
 if (s.won && s.boomerang) out.push('boomerang');
 // SWEEP takes the empty machine for free, for the same reason WET does: no
 // pieces is the limit of "every piece ended in the void", not an exception
 // to it. `won` is required because a machine that threw itself away without
 // delivering anything hasn't swept up, it has just fallen over.
 if (s.won && s.sweep) out.push('sweep');
 // **NRW — No Ridiculous Weights.** A separate badge, not a rung on
 // `BADGE_RANKS`: that ladder is ordered by which PART TYPES you did without
 // (powerless ⊂ rods ⊂ wet) and this is about how heavy they are, which is
 // orthogonal to it. A machine can be wet and ridiculous, or powered and
 // featherweight.
 //
 // `maxPinWeight` is the summed stick weight at the heaviest PIN — see
 // `designStats`. 0 for a machine with no sticks at all, so the empty machine
 // takes it, the same way it takes WET and SWEEP.
 //
 // **A solve recorded before the stat existed does not get it.** `null` means
 // "nobody measured", which is not the same as "nothing heavy", and awarding a
 // badge nobody checked is worse than a gap. Badges are derived and never
 // stored (§11.4), so any solve that DOES carry the stat is judged the moment
 // the rule ships.
 if (s.maxPinWeight != null && s.maxPinWeight <= PIN_WEIGHT_SAFE) out.push('nrw');
 return out;
}

// Where a solve sits on the challenge ladder (§11.8): the three badges that
// describe how sparse a machine is, ordered hardest first. Nested by
// construction — every wet solve is also rods, every rods solve is also
// powerless — so "at least rank N" is a real comparison, not a house rule.
export const BADGE_RANKS = ['any', 'powerless', 'rods', 'wet'];
export function badgeRank(s) {
 if (isWet(s)) return 3;
 if ((s.wheels | 0) === 0) return 2;
 if ((s.poweredWheels | 0) === 0) return 1;
 return 0;
}

// ---------- challenges (§11.8) ----------

// Mirrors the server's `qualifies` exactly (server.js), so the play screen can
// tell you where you stand before the save round-trip — and so the two can be
// diffed by eye when either changes. The epsilon is the same one and for the
// same reason: "equal or less" has to include a bit-exact repeat of the
// challenger's own number, which determinism (§5.8) makes reachable.
const BAR_EPS = 1e-9;
const underBar = (v, bar) => bar == null || (Number.isFinite(v) && v <= bar + BAR_EPS);

export function qualifies(s, ch) {
 if (!s || !s.won) return false;
 const bars = ch.bars || {};
 if (!underBar(s.time, bars.time)) return false;
 if (!underBar(s.pieces, bars.pieces)) return false;
 if (!underBar(s.kg, bars.kg)) return false;
 if (badgeRank(s) < (ch.badge | 0)) return false;
 if (ch.nailedIt && !s.nailedIt) return false;
 if (ch.boomerang && !s.boomerang) return false;
 // Sweep joins the demandable badges rather than the LADDER (badgeRank): the
 // ladder ranks how little you built and nests, and sweeping is about what
 // became of the machine — orthogonal, so it's a flag like the other two.
 if (ch.sweep && !s.sweep) return false;
 return true;
}

// Which individual bars a run cleared, for telling someone what they still
// have to fix rather than a bare "no".
export function barBreakdown(s, ch) {
 const out = [];
 const bars = ch.bars || {};
 if (bars.time != null) out.push({ what: 'time', need: fmtTime(bars.time), got: fmtTime(s.time), ok: underBar(s.time, bars.time) });
 if (bars.pieces != null) out.push({ what: 'pieces', need: bars.pieces, got: s.pieces, ok: underBar(s.pieces, bars.pieces) });
 if (bars.kg != null) out.push({ what: 'weight', need: fmtKg(bars.kg), got: fmtKg(s.kg), ok: underBar(s.kg, bars.kg) });
 if (ch.badge) {
 out.push({ what: BADGE_RANKS[ch.badge], need: BADGE_RANKS[ch.badge], got: BADGE_RANKS[badgeRank(s)], ok: badgeRank(s) >= ch.badge });
 }
 if (ch.nailedIt) out.push({ what: 'Nailed It', need: 'yes', got: s.nailedIt ? 'yes' : 'no', ok: !!s.nailedIt });
 if (ch.boomerang) out.push({ what: 'Boomerang', need: 'yes', got: s.boomerang ? 'yes' : 'no', ok: !!s.boomerang });
 if (ch.sweep) out.push({ what: 'Sweep', need: 'yes', got: s.sweep ? 'yes' : 'no', ok: !!s.sweep });
 return out;
}

// "3d 4h" / "2h 07m" / "48s" — coarse at the top end, precise at the bottom,
// because a countdown only becomes interesting as it runs out.
export function fmtCountdown(ms) {
 if (!(ms > 0)) return t('now');
 const s = Math.floor(ms / 1000);
 const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
 const m = Math.floor((s % 3600) / 60), sec = s % 60;
 if (d) return tf('{d}d {h}h', { d, h });
 if (h) return tf('{h}h {m}m', { h, m: String(m).padStart(2, '0') });
 if (m) return tf('{m}m {s}s', { m, s: String(sec).padStart(2, '0') });
 return tf('{s}s', { s: sec });
}

// One line describing what a challenge demands, for a card or a chip.
export function challengeTerms(ch) {
 const bits = [];
 const bars = ch.bars || {};
 if (bars.time != null) bits.push(`≤ ${fmtTime(bars.time)}`);
 if (bars.pieces != null) bits.push('≤ ' + tf('{n} pcs', { n: bars.pieces }));
 if (bars.kg != null) bits.push(`≤ ${fmtKg(bars.kg)}`);
 if (ch.badge) bits.push(t(badgeDef(BADGE_RANKS[ch.badge])?.name || BADGE_RANKS[ch.badge]));
 if (ch.nailedIt) bits.push(t('Nailed It'));
 if (ch.boomerang) bits.push(t('Boomerang'));
 if (ch.sweep) bits.push(t('Sweep'));
 return bits.join(' · ');
}

// ---------- the challenge message (§11.8) ----------
//
// The one part of a challenge that isn't a number: the challenger's own words,
// riding with the countdown everywhere the countdown goes. A bar says what you
// have to beat; this says who is asking, and it is as often an invitation
// ("who's going to be first?") as a taunt.
//
// **The field is `message` and not `challenge`**, which would have been the
// obvious name for the wording it wears: §11.8's opening line is that the word
// "challenge" means one thing only in this codebase, and a challenge carrying a
// `challenge` would undo the rename that was fought for.
//
// **It is flattened to ONE line here, on the way in, rather than by CSS in each
// place that draws it.** It renders in a chip on a card, in the chip on the
// level itself, under the clock on a sealed race's page, in a hover popup that
// also has to fit the terms, and on the card of a challenge somebody just won —
// five places where a message carrying thirty newlines would push everything
// else off the screen. Four of the five are DOM, where a rule is a rule no gate
// can reach (§16);
// this one is a pure function the suite calls directly, and the server applies
// the same cap to the same field on the way into the database.
export const MESSAGE_MAX = 140;

export function cleanMessage(s) {
 if (typeof s !== 'string') return '';
 // Newlines and control characters become spaces first, then runs of
 // whitespace collapse — so "line one\n\n\nline two" is one line, not one
 // line with a hole in it. The class is the Unicode CONTROL CATEGORY rather
 // than a hand-written range of numeric escapes, so the server can carry a
 // character-for-character copy of this line with no escape in it to get
 // wrong — and so the one thing a source file must never contain (a raw NUL)
 // cannot arrive here by way of an editor that helpfully interpreted one.
 const flat = s.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
 // **Cut by CHARACTER, not by code unit.** This is exactly the kind of string
 // that ends in an emoji, and `slice` on a surrogate pair leaves half of one
 // behind — which renders as � and is stored that way forever. The spread
 // iterates code points, so the cap counts what a reader would count.
 const chars = [...flat];
 return (chars.length > MESSAGE_MAX ? chars.slice(0, MESSAGE_MAX).join('') : flat).trim();
}

// The whole of a challenge in one hover: who set it, what they said, what it
// demands, what is staked and when it ends (§11.8). The chip beside the
// countdown has room for none of that.
//
// **Times here are ABSOLUTE, and that is not a style choice.** A `data-tip` is
// built once when the card is drawn and read from the attribute on hover, while
// the countdown beside it repaints every second — so a relative "ends in 4d 2h"
// baked into the tooltip is a number that stops being true the moment the card
// stops being new. The chip already gives the relative figure; the popup gives
// the one that keeps.
export function challengeTip(ch, kind = 'beatme') {
 if (!ch) return '';
 const at = (ms) => fmtDateTime(ms); // ISO, local — see fmtDate
 const said = cleanMessage(ch.message);
 const prize = ch.prize | 0;
 const lines = [];

 if (kind === 'race') {
 lines.push(tf('🏁 A timed challenge set by {who}', { who: ch.by || t('somebody') }));
 if (said) lines.push(`“${said}”`);
 lines.push(ch.winner
 ? tf('Won by {who}', { who: ch.winner.name })
 : ch.sealed
 ? t('Sealed — nobody can open it until the clock runs out, then everyone gets it at once.')
 : t('Open — the first solved run saved publicly takes it.'));
 if (prize) lines.push(tf(prize > 1 ? '🏅 {n} points to the winner' : '🏅 {n} point to the winner', { n: prize }));
 if (!ch.winner && ch.revealAt) lines.push(tf(ch.sealed ? 'Opens {when}' : 'Opened {when}', { when: at(ch.revealAt) }));
 return lines.join('\n');
 }

 lines.push(tf('⚔ {who} — match me, beat me', { who: ch.by || t('somebody') }));
 if (said) lines.push(`“${said}”`);
 const bars = ch.bars || {};
 const nums = [];
 if (bars.time != null) nums.push(`≤ ${fmtTime(bars.time)}`);
 if (bars.pieces != null) nums.push('≤ ' + tf('{n} pcs', { n: bars.pieces }));
 if (bars.kg != null) nums.push(`≤ ${fmtKg(bars.kg)}`);
 if (nums.length) lines.push(t('Match or beat: ') + nums.join(' · '));
 // The badge requirement spelled OUT rather than named — the name and the
 // description together, because a name alone means nothing to somebody who
 // has not gone looking for the badge list, and the hover is the one place
 // with room to say what it asks for.
 if (ch.badge) {
 const d = badgeDef(BADGE_RANKS[ch.badge]);
 lines.push(tf('Machine: {what}', { what: d ? `${d.emoji} ${t(d.name)} — ${t(d.desc)}` : BADGE_RANKS[ch.badge] }));
 }
 const extra = ['nailedIt', 'boomerang', 'sweep']
 .filter(k => ch[k])
 .map(k => { const d = badgeDef(k); return d ? `${d.emoji} ${t(d.name)}` : k; });
 if (extra.length) lines.push(t('Must also earn: ') + extra.join(' · '));
 if (!nums.length && !ch.badge && !extra.length) lines.push(t('Anything goes — just solve it.'));
 if (prize) lines.push(tf(prize > 1 ? '🏅 {n} points to the first to clear it' : '🏅 {n} point to the first to clear it', { n: prize }));
 if (ch.closedAt) lines.push(ch.winner ? tf('Won by {who}', { who: ch.winner.name }) : t('Over — nobody cleared it'));
 else if (ch.endsAt) lines.push(tf('Ends {when}', { when: at(ch.endsAt) }));
 return lines.join('\n');
}

// The clock on a chip, and the only part of one that has to be repainted every
// second. Two verbs rather than one because the two kinds count down to
// opposite events: a race OPENS at its moment, a bar CLOSES at its, and "2m
// left" over a sealed race reads as though it is about to be taken away.
export function countdownText(kind, at) {
 const left = at - Date.now();
 if (left <= 0) return t(kind === 'race' ? 'opening…' : 'closing…');
 return tf(kind === 'race' ? 'opens in {t}' : 'ends in {t}', { t: fmtCountdown(left) });
}

// ---------- what a level has running on it, right now (§11.8) ----------
//
// ONE answer to "what is this level carrying", normalised so that every surface
// which shows a challenge shows the same set, in the same order, from the same
// rule: the Workshop card, the Challenges tab's own filter, and the chip that
// now rides the level itself.
//
// It replaces three copies of the word "live" — `isLiveChallenge` answering
// yes/no for the tab, and two separate loops inside the card chip and the
// details panel each deciding for themselves what counted. Three copies is
// three chances to disagree about whether a level has anything on it, and a tab
// that lists a level whose card then shows nothing is a bug nobody reports
// because it looks like they misread it.
//
// **Pure, and in util.js rather than beside the DOM that draws it**, because
// what a player is shown is exactly the kind of rule that has to be reachable by
// a gate (§16) — main.js is not.
//
// The race leads: there is at most one, and it is the only kind that can be a
// countdown to a level nobody may open yet. Bars follow in the order the server
// sent them, which is the order they were posted.
export function liveChallenges(rec) {
 const out = [];
 if (!rec) return out;
 // A race with a winner is finished — the level carries on as an ordinary
 // level with that name at the front of its description, and a chip still
 // counting down on it would be claiming a competition that is over.
 if (rec.race && !rec.race.winner) {
 const r = rec.race;
 out.push({
 kind: 'race',
 // The race has no id of its own on the wire (a level has at most one), so
 // it takes a stable literal — callers key DOM and stored state off this.
 id: 'race',
 // A SEALED race counts down to its reveal. An OPENED one has no clock at
 // all: it ends when somebody wins it, which is not a time anyone can put
 // on a chip, so `at` is null and the caller says what it is instead.
 at: r.sealed ? (r.revealAt || null) : null,
 terms: '',
 prize: r.prize | 0,
 by: r.by || 'somebody',
 message: cleanMessage(r.message),
 tip: challengeTip(r, 'race'),
 ch: r,
 });
 }
 // The list route sends live bars only; the detail route sends the lot, decided
 // ones included, so the filter has to be here rather than assumed of either.
 for (const c of rec.challenges || []) {
 if (c.closedAt) continue;
 out.push({
 kind: 'beatme',
 id: c.id,
 at: c.endsAt || null,
 // "anything goes" is a real term — a bar with no numbers on it is still a
 // challenge, and an empty line under the chip would read as a bug.
 terms: challengeTerms(c) || 'anything goes',
 prize: c.prize | 0,
 by: c.by || 'somebody',
 message: cleanMessage(c.message),
 tip: challengeTip(c, 'beatme'),
 ch: c,
 });
 }
 return out;
}

// The pill a live challenge wears wherever it is listed: what kind it is, how
// long is left, and what is staked. Shared by the Workshop card and the chip
// that now rides the level itself, because those ARE the same chip — two
// hand-built copies is how one of them ends up a month behind the other.
//
// Takes an entry from `liveChallenges`, not a raw challenge record: the decision
// about which clock a race is counting to (its reveal, or nothing at all) is
// made once, up there, where a gate can reach it.
//
// The clock is a `[data-deadline]` node rather than baked-in text. Every screen
// that shows one of these repaints those nodes once a second, and a chip built
// at "2m 14s" and left alone is a lie ten seconds later.
export function challengeChipEl(c) {
 return el('span', { class: 'chal-chip ' + c.kind },
 c.kind === 'race' ? '🏁 ' : '⚔ ',
 c.at
 ? el('b', { 'data-deadline': String(c.at), 'data-kind': c.kind }, countdownText(c.kind, c.at))
 : 'open — first solve wins',
 c.prize ? ` · 🏅${c.prize}` : '');
}

// ---------- campaign progress: slot keys → level ids (§13) ----------
//
// **Local campaign progress used to be keyed by SLOT**, which was fine for
// exactly as long as a level's slot could never change. Now an admin can move a
// level to another number, and a store keyed by position would quietly re-point
// every star: solve campaign 7, move that level to 3, and the grid claims you
// solved whatever landed on 7.
//
// So progress is keyed by level id, and this carries the old entries across.
// **It is only correct while the slots it is reading are still the ones the
// entries were written under**, which is why it runs from the campaign screen on
// the way in rather than lazily somewhere later — the first load after this
// ships is the last moment the old mapping is still true.
//
// Returns the migrated object, or null when there was nothing to migrate, so the
// caller writes to storage only when something actually changed.
//
// A legacy key is 1–3 digits (slots are small integers); a level id is an
// 11-character base64url string and cannot match that, so the two are told apart
// by shape rather than by a flag that would have to have been written in advance.
export function migrateProgressToIds(progress, officials) {
 const bySlot = new Map();
 for (const l of officials || []) if (l && l.id != null && l.slot != null) bySlot.set(l.slot, l.id);
 let changed = false;
 const out = {};
 for (const [k, v] of Object.entries(progress || {})) {
 if (!/^\d{1,3}$/.test(k)) { out[k] = v; continue; }
 changed = true;
 const id = bySlot.get(+k);
 // that slot belongs to nobody now — the level left the campaign, and a
 // record of beating a position is not a record of beating anything
 if (!id) continue;
 // if both an id entry and a legacy one exist, the better run wins
 if (out[id] == null || (v && v.time != null && !(out[id].time <= v.time))) out[id] = v;
 }
 return changed ? out : null;
}

// ---------- the spin centre (§9.1) ----------
//
// **Where a spin motion turns about.** Default is where it has always been —
// the piece's own position (which for a group is the members' average, the
// group pivot) — and an author can move it: `path.pivot = {x, y}`, absolute
// level coordinates, present only while it differs from the default. One
// resolver, because the sim, the ghost preview, the end-pose readout and the
// editor's handle all have to answer "about which point?" identically — four
// hand-written copies of this fallback is how a ghost ends up orbiting a
// different centre than the piece it predicts.
//
// A pivot on a SPINLESS path is ignored by every caller (they gate on
// `path.spin`), so a path that once span and no longer does carries no live
// rule — only a remembered preference, restored if spin comes back.
export function spinPivotOf(path, ox, oy) {
 const p = path?.pivot;
 if (p && typeof p.x === 'number' && isFinite(p.x) && typeof p.y === 'number' && isFinite(p.y)) {
 return { x: p.x, y: p.y, custom: true };
 }
 return { x: ox, y: oy, custom: false };
}

// ---------- goal tampering, derived from positions (§11.3/§11.4) ----------
//
// Whether each goal piece counts as MOVED, given where it sits against where
// the level puts it. This is the fact Untampered hangs off, and it was written
// twice inside GameScreen — once in `_loadAutosave`, once in `loadSolve` — which
// is exactly the arrangement §16 warns about: a rule two DOM methods carry is a
// rule no gate can reach, and the audit that added the second copy is the audit
// that nearly got it wrong (a loaded machine must not inherit Untampered from
// somebody else's tampering, so its flags are derived, never zeroed).
//
// The 0.01 tolerance is shared with the drag handler's own "did that click
// actually move it" test: a hair over a hundredth of a pixel is storage noise,
// anything more is a hand.
export const GOAL_MOVED_TOLERANCE = 0.01;

export function deriveGoalMoved(positions, goalObjs) {
 return (positions || []).map((p, i) => {
 const g = goalObjs?.[i];
 // a position with no authored goal under it has nothing to be compared
 // against — never "moved", because there is no "from"
 return !!g && !!p && Math.abs(p.x - g.x) + Math.abs(p.y - g.y) > GOAL_MOVED_TOLERANCE;
 });
}

// ---------- the replay preroll (§11.3) ----------
//
// **A replay is somebody's work, and it used to start like a glitch** — a
// machine you did not build appearing mid-motion, with the only clue to whose it
// was in a strip along the bottom edge that you had to think to look at. This is
// the title card: who made it, what it did, what it earned, and anything they
// said about it, held long enough to read before the thing moves.
//
// Pure and here rather than beside the DOM that draws it, because what a player
// is told is a rule a gate has to be able to reach (§16). The card is four short
// lines; deciding WHICH four is the part worth testing.
//
// An ATTEMPT (a run that never won) keeps its card — you can watch those too —
// but it does not claim a time, because it has none. Showing `0.0s` there, or
// the moment it gave up as though it were a finish, would be the card lying
// about the one number people read first.
export function replayPreroll(solve) {
 if (!solve) return null;
 const bits = [];
 if (solve.won) {
 if (solve.time != null) bits.push(fmtTime(solve.time));
 if (solve.pieces != null) bits.push(tf('{n} pcs', { n: solve.pieces }));
 if (solve.kg != null) bits.push(fmtKg(solve.kg));
 }
 return {
 // A LOCAL save has no `by` — it never reached the server, so there is no
 // account on it — and the fallback credited your own run on your own
 // machine to "anonymous". It is the one card where the author is never in
 // doubt, so it says so instead. Translated here because the preroll is
 // painted on canvas, past every DOM funnel.
 who: solve.local ? t('your local save') : (solve.by || t('anonymous')),
 // remix credit — this run was itself built on somebody's loaded solve, and
 // the title card is exactly the place a "after <name>" byline belongs
 after: solve.basedOn?.by || '',
 won: !!solve.won,
 // The run's own name, when it was given one. Flattened and capped like every
 // other line a person typed (`cleanMessage`) — this one lands in a card over
 // the level, which is no place for the thirty-line version.
 title: cleanMessage(solve.name),
 stats: bits.join(' · '),
 said: cleanMessage(solve.comment),
 badges: computeBadges(solve),
 at: solve.at || null,
 };
}

export function badgeDef(id) {
 return BADGE_DEFS.find(b => b.id === id);
}

// Badges are taken as known: the icon alone, never the label — the names would
// triple the width of every solve row and regulars read the icons on sight.
// Beginners get the name and the rule from the hover tooltip instead.
//
// Rows always render the FULL set. A badge that wasn't earned stays in its slot
// as a ghost, so the gap reads as "not yet" rather than "doesn't exist" — and
// the columns line up across rows, which makes two solves comparable at a
// glance. `earned` false is the ghost; there is no third state.
// `ghostNote` says what the empty slot means in THIS context — on a solve the
// player didn't earn it, on a level card nobody has yet — so the tooltip stays
// true wherever the row is dropped.
// `tip: false` omits the hover and the aria-label — for when this badge is
// being put INSIDE something that already carries both (the filter bar's
// buttons say "Only ones with: …"). Without it the badge's own tip wins,
// because installTooltips takes the nearest [data-tip] ancestor, and the
// container's framing is lost.
export function badgeEl(id, earned = true, { tiny = false, ghostNote = 'not earned', tip = true } = {}) {
 const d = badgeDef(id);
 if (!d) return null;
 return el('span', {
 // `neg` — a badge for something you did WITHOUT, drawn as the thing
 // itself inside a red prohibition ring (style.css). A flag on the
 // definition rather than a list of ids in the stylesheet, so adding
 // another "no X" badge is one word here and nothing anywhere else.
 class: 'badge' + (earned ? '' : ' ghost') + (tiny ? ' tiny' : '') + (d.neg ? ' neg' : ''),
 dataset: { badge: id },
 'data-tip': tip ? t(d.name) + ' — ' + t(d.desc) + (earned ? '' : ' (' + t(ghostNote) + ')') : null,
 'aria-label': tip ? t(d.name) + (earned ? '' : ': ' + t(ghostNote)) : null,
 role: 'img',
 }, badgeGlyph(d));
}

// What a badge LOOKS like: its drawing when it has one, its emoji otherwise.
// One function, because the badge, the filter bar above the table and the
// tutorial's badge cards all show the same set and must not show three
// different pictures of it. Returns a node or a plain string, both of which
// `el` takes as a child — note it is passed as a CHILD rather than through
// `el`'s `html:`, which is applied before children and would have rendered the
// drawing and then the emoji after it.
export function badgeGlyph(d) {
 return d?.svg ? el('span', { class: 'badge-glyph', html: d.svg }) : (d?.emoji ?? '');
}

// `ghostNotes` overrides the note for individual badges — a row can hold both
// "you didn't earn this" and "this one isn't decided yet", which is the
// difference between a verdict and a spoiler the player hasn't asked for.
export function badgeRow(earnedIds, cls = 'badge-row', opts = {}) {
 const won = new Set(earnedIds || []);
 const { ghostNotes, ...rest } = opts;
 return el('span', { class: cls },
 ...BADGE_DEFS.map(b => badgeEl(b.id, won.has(b.id),
 ghostNotes?.[b.id] ? { ...rest, ghostNote: ghostNotes[b.id] } : rest)));
}

// ---------- ratings: quality (1–5 stars) and difficulty (1–10) ----------

// Both widgets carry BOTH facts, because they answer different questions and a
// single fill can only answer one:
//
// filled = the global average, the level's score
// ringed = the one YOU picked
//
// So a 4.5-rated level you gave a 3 reads as five gold stars with a circle
// round the third — "everyone likes it, I didn't as much" — at a glance and
// without a second widget. Earlier this showed your rating in gold and the
// average only as a number, which made your own score look like the level's.
//
// Nothing is printed AFTER the row: the exact numbers live in the tooltip. A
// title with "★★★★☆ 3.3 avg (3) · yours 5" trailing it is a wall of digits in
// the one place that should read as a name.
//
// `state` is updated in place; `onRate(i)` does the API call and returns the
// fresh averages. The caller supplies it so this file stays free of api.js
// (which imports this one).
// The same level can carry these widgets twice at once — the play screen's
// title bar and the details panel. They must never disagree, so they share the
// state object AND every live widget on it repaints when any one of them
// changes it. Doing that here rather than in both callers is what makes it
// impossible to forget: rating from the HUD and then opening the panel used to
// show the old average, because each had built its own copy of the numbers.
function repaintAll(state) {
 state.__ratingPaints = (state.__ratingPaints || []).filter(p => p.row.isConnected);
 for (const p of state.__ratingPaints) p.fn();
}

// The spine both scales share. `readonly` renders spans instead of buttons —
// level cards are one big <a>, and a nested <button> is invalid there and eats
// the click that should open the level.
function scaleRow(spec) {
 const { state, max, rowClass, cellClass, cell, avg, mine, count, tip, apply, onRate, readonly } = spec;
 const row = el('span', { class: rowClass + (readonly ? ' readonly' : '') });
 const cells = [];
 const paint = () => {
 const a = avg() || 0, m = mine() || 0;
 const lit = Math.round(a);
 cells.forEach((c, j) => {
 c.classList.toggle('on', j < lit);
 c.classList.toggle('mine', j + 1 === m);
 });
 // an unvoted scale is a row of empty cells, which on a card reads as a
 // broken progress bar rather than "nobody has said" — so it recedes
 row.classList.toggle('empty', !count());
 row.setAttribute('data-tip-1line', '');
 row.setAttribute('data-tip', tip(a, m));
 };
 for (let i = 1; i <= max; i++) {
 const c = cell(i, readonly);
 if (!readonly) {
 c.addEventListener('click', async (e) => {
 e.preventDefault(); e.stopPropagation();
 try {
 const r = await onRate(i);
 apply(i, r);
 repaintAll(state); // this widget and any twin of it
 } catch (err) { alert(t(err.message || 'Could not save that rating.')); }
 });
 }
 cells.push(c);
 row.append(c);
 }
 (state.__ratingPaints ||= []).push({ row, fn: paint });
 paint();
 return row;
}

// `state` needs { rating, ratingCount, yourRating }.
export function starRating(state, onRate, { readonly = false } = {}) {
 return scaleRow({
 state, max: 5, readonly, onRate,
 rowClass: 'rating-row', cellClass: 'star',
 avg: () => state.rating,
 mine: () => state.yourRating,
 count: () => state.ratingCount,
 cell: (i, ro) => el(ro ? 'span' : 'button', {
 class: 'star', 'aria-label': ro ? null : tf('Rate {i} out of 5', { i }),
 }, '★'),
 apply: (i, r) => {
 state.yourRating = i;
 if (r) { state.rating = r.rating; state.ratingCount = r.ratingCount; }
 },
 tip: (a, m) => (state.ratingCount
 ? tf(state.ratingCount === 1 ? 'Quality: {a} out of 5 from 1 rating' : 'Quality: {a} out of 5 from {n} ratings', { a: a.toFixed(1), n: state.ratingCount })
 + (m ? tf(' · you gave it {m}', { m }) : readonly ? '' : t(' · click a star to rate it'))
 : readonly ? t('Quality: not rated yet') : t('Nobody has rated the quality yet — click a star')),
 });
}

// The second axis: how HARD, 1–10, which quality can't express — a brilliant
// level can be easy and a tedious one brutal. Ten stars would be unreadable and
// would imply the same meaning, so difficulty is a bar of ten pips ramped
// green→red by position: length says how hard, colour says it again, and the
// shape is unmistakably not the quality stars at a glance.
// `state` needs { difficulty, difficultyCount, yourDifficulty }.
export function difficultyRating(state, onRate, { readonly = false } = {}) {
 return scaleRow({
 state, max: 10, readonly, onRate,
 rowClass: 'diff-row', cellClass: 'pip',
 avg: () => state.difficulty,
 mine: () => state.yourDifficulty,
 count: () => state.difficultyCount,
 cell: (i, ro) => el(ro ? 'span' : 'button', {
 class: 'pip',
 // hue 130 (green) at 1 down to 0 (red) at 10, set per pip so the scale
 // itself reads as a ramp even before anyone has voted. A style STRING,
 // not an object: el() assigns objects with Object.assign, which cannot
 // set a custom property.
 style: `--pip:hsl(${Math.round(130 - ((i - 1) / 9) * 130)} 68% 45%)`,
 'aria-label': ro ? null : tf('Rate difficulty {i} out of 10', { i }),
 }),
 apply: (i, r) => {
 state.yourDifficulty = i;
 if (r) { state.difficulty = r.difficulty; state.difficultyCount = r.difficultyCount; }
 },
 tip: (a, m) => (state.difficultyCount
 ? tf(state.difficultyCount === 1 ? 'Difficulty: {a} out of 10 from 1 rating' : 'Difficulty: {a} out of 10 from {n} ratings', { a: a.toFixed(1), n: state.difficultyCount })
 + (m ? tf(' · you gave it {m}', { m }) : readonly ? '' : t(' · click to rate how hard it was'))
 : readonly ? t('Difficulty: not rated yet') : t('Nobody has rated the difficulty yet — click how hard it was')),
 });
}

// Difficulty as a word, for the places that want prose rather than a bar.
// Translated HERE rather than at the funnel, because every caller composes it
// into a bigger sentence that the dictionary will never have met whole.
export function difficultyWord(v) {
 if (v == null) return t('unrated');
 return t(v < 2.5 ? 'gentle' : v < 4.5 ? 'easy' : v < 6.5 ? 'moderate' : v < 8.5 ? 'hard' : 'brutal');
}

// ---------- magnetic bars: where a dragged bar wants to settle (§19) ----------
//
// The four relocatable bars are dragged by hand to arbitrary pixels, and two
// bars a builder MEANT to line up end up three pixels out. This is the rule
// that lines them up: while a bar is being dragged it is pulled onto the
// alignments already in the room — the viewport's own edges and centre lines,
// and every edge and centre of every other visible bar — and the alignment it
// caught is drawn as a line so you can see WHY it stopped there.
//
// **Nothing docks and nothing persists.** The bar keeps the plain `{x, y}` it
// has always kept; there is no stored link to an edge or to another bar. That
// is deliberate, and it is the difference between this and the docking version
// it replaced: a stored dock is an invisible constraint that moves a bar you
// did not touch, weeks later, because something else moved. A snap that only
// happens while your hand is on the bar cannot do that.
//
// Everything is boxes. No orientation argument, no fold flag, no `this` — which
// is what makes a folded bar and a vertical bar free rather than special cases,
// and what lets a gate drive the whole rule with four numbers.

// HOW CLOSE AN ALIGNMENT HAS TO BE, and these are measured rather than chosen.
//
// A drag is SAMPLED. Chrome delivers ONE pointermove per animation frame and
// hides the rest behind getCoalescedEvents, which `_bindGripDrag` never calls
// — so the snap is tested once a frame, and between two tests the bar has
// already jumped S pixels. A pull narrower than S/2 is one a fast drag steps
// straight over: it catches when you move slowly and misses when you move
// quickly, which reads as the feature being broken rather than as your hand
// being fast.
//
// scripts/probe-barsnap.mjs does the arithmetic and prints these four. At 60 Hz
// a normal drag — across the 1100 px editor in 0.75 s — steps 24 px, so 13.
// Sized for the flick it would be 27, and a pull that wide starts grabbing bars
// you were steering past, which is the complaint that kills this kind of
// feature. The flick's real target is the wall, and the overshoot rule below
// catches that without widening anything.
export const BAR_SNAP_PULL = 13;
export const BAR_SNAP_PULL_TOUCH = 15; // a finger rolls as it presses: TOUCH_SLOP 12, +2
// THE EXIT IS WIDER THAN THE ENTRANCE, which is the whole of why this does not
// flicker. A control that decides on its own threshold sits on it and buzzes —
// the bars have done exactly that four separate times, and `navShown` above
// carries the same two-threshold shape for the same reason. Held, an alignment
// keeps the bar until the pointer is half again as far away as it took to
// catch it. The gap it has to beat is JITTER — a hand resting on a held bar
// wanders a pixel or two a frame — not a deliberate move, which should and does
// leave on the first sample.
export const BAR_SNAP_RELEASE = 20;
export const BAR_SNAP_RELEASE_TOUCH = 23;
// How equal two moves must be before BOTH lines are drawn. Only ever used for
// DRAWING — never for choosing — because "within half a pixel" is not an
// equivalence relation and a sort that pretends it is can rank A over B over C
// over A. The winner is picked on a total order first (see `axisSnap`), and
// this only asks which other candidates landed on the same spot.
export const BAR_GUIDE_TIE = 0.5;

// The three places on an axis a bar can be measured from, and the three the
// viewport offers back. `lead` is left/top, `trail` is right/bottom.
const PROBES = ['lead', 'centre', 'trail'];

// `_clampBarPos`'s arithmetic, extracted so the snap and the clamp cannot
// drift apart — the snap proposes and the clamp disposes, and until this was
// one function they were two copies of the same four numbers.
export function clampBarAxis(v, size, viewSize, margin = 4) {
 return clamp(v, margin, Math.max(margin, viewSize - size - margin));
}

// One axis, solved on its own. Both axes run this identically, which is why a
// bar can be flush to the left AND centred vertically without either decision
// knowing about the other.
function axisSnap(pos, size, viewSize, others, opts, prevHit) {
 const { pull, release, edge } = opts;
 const probe = { lead: pos, centre: pos + size / 2, trail: pos + size };
 // The candidates, in a FIXED order, because that order is the tiebreak and a
 // tiebreak that depends on object iteration is a tiebreak that changes.
 const cand = [];
 // The viewport's lines sit at `edge`, not at the clamp's margin: a bar
 // snapped flush at 4 makes the very next `_fitBarInner` cap its inner at
 // natural-minus-8 and wrap a row, so 12 is where the eye actually sees a bar
 // settle and 4 is only where it is forbidden to go past.
 cand.push({ id: 'view:lead', at: edge, kind: 'view' });
 cand.push({ id: 'view:trail', at: viewSize - edge, kind: 'view' });
 cand.push({ id: 'view:centre', at: viewSize / 2, kind: 'centre' });
 others.forEach((o, i) => {
 cand.push({ id: 'bar' + i + ':lead', at: o.pos, kind: 'edge', from: o.from, to: o.to });
 cand.push({ id: 'bar' + i + ':trail', at: o.pos + o.size, kind: 'edge', from: o.from, to: o.to });
 cand.push({ id: 'bar' + i + ':centre', at: o.pos + o.size / 2, kind: 'centre', from: o.from, to: o.to });
 });

 const inPlay = [];
 for (let ci = 0; ci < cand.length; ci++) {
 const c = cand[ci];
 for (let pi = 0; pi < PROBES.length; pi++) {
 const p = PROBES[pi];
 // A trailing probe may only meet a trailing line, and a leading probe a
 // leading one — otherwise a bar's left edge snaps to another bar's right
 // edge and the two overlap completely, which is an alignment nobody
 // asked for. Centres meet centres.
 if ((p === 'centre') !== (c.kind === 'centre')) continue;
 const move = c.at - probe[p];
 const id = c.id + '/' + p;
 // OVERSHOOT COUNTS AS ARRIVAL. Slamming a bar at the left wall is how
 // people aim at a wall, and the raw position then goes NEGATIVE — past
 // every candidate, inside none of them — so without this the bar falls
 // through the snap entirely and the clamp parks it at 4 with no line and
 // no alignment. Only the viewport's own edges get this: a bar dragged
 // clean past another bar meant to pass it.
 //
 // `p === 'lead'` / `p === 'trail'` is load-bearing and was missing. Any
 // probe past the wall counted, so a bar thrown off the top had its BOTTOM
 // edge declared an overshoot of the TOP line — the shorter move of the
 // two, so it won — and the bar was hung with only its last 12 px on
 // screen. Measured: y landed at 4 instead of 12, and a bar thrown off the
 // right landed at 736 instead of 728. Overshooting a wall puts the edge
 // that went past it back ON it, and nothing else.
 const over = c.kind === 'view'
 && ((c.id === 'view:lead' && p === 'lead' && probe[p] < c.at)
 || (c.id === 'view:trail' && p === 'trail' && probe[p] > c.at));
 const reach = (prevHit === id) ? release : pull;
 if (!over && Math.abs(move) > reach) continue;
 inPlay.push({ id, move, ci, pi, cand: c, over });
 }
 }
 if (!inPlay.length) return { pos, hit: null, guides: [] };

 // A TOTAL ORDER, on integers. The comparator this replaced banded moves
 // within half a pixel as "equal" and then ranked the band members by other
 // fields — which is intransitive, so with moves 0.0, 0.4 and 0.8 it could
 // rank A over B over C over A and the winner depended on the sort's pivot.
 // Rounding to hundredths first makes the primary key an integer, and the two
 // fallbacks are indices, so the whole key is a lexicographic tuple.
 const key = (a) => [a.over ? 0 : 1, Math.round(Math.abs(a.move) * 100), a.ci, a.pi];
 inPlay.sort((a, b) => { const A = key(a), B = key(b);
 for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] - B[i];
 return 0; });
 const win = inPlay[0];

 // …and only NOW, with a winner chosen, ask which other candidates landed on
 // the same place. Drawing two lines is not an ordering question, so the
 // epsilon is safe here in a way it never was in the comparator.
 const guides = inPlay
 .filter((a) => Math.abs(Math.abs(a.move) - Math.abs(win.move)) <= BAR_GUIDE_TIE)
 .map((a) => ({ at: a.cand.at, kind: a.cand.kind, from: a.cand.from, to: a.cand.to }));
 return { pos: pos + win.move, hit: win.id, guides, kind: win.cand.kind };
}

// Two boxes overlap? Used only to keep a bar out of the corners the SHELL
// covers, below.
const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export function barGuides(moving, others = [], view = { w: 0, h: 0 }, opts = {}) {
 const {
 touch = false, free = false, prev = null, edge = 12, margin = 4, exclude = [],
 pull = touch ? BAR_SNAP_PULL_TOUCH : BAR_SNAP_PULL,
 release = touch ? BAR_SNAP_RELEASE_TOUCH : BAR_SNAP_RELEASE,
 } = opts;
 const w = moving.w || 60, h = moving.h || 60;
 const bare = {
 x: clampBarAxis(moving.x, w, view.w, margin),
 y: clampBarAxis(moving.y, h, view.h, margin),
 hit: { x: null, y: null }, guides: [],
 };
 // Alt is the escape hatch and it is read LIVE, per move event, not latched at
 // the grab: the moment you want a bar somewhere unmagnetised is usually the
 // moment after you found out it will not go there.
 if (free) return bare;

 const o = { pull, release, edge };
 const ax = axisSnap(moving.x, w, view.w,
 others.map((b) => ({ pos: b.x, size: b.w, from: b.y, to: b.y + b.h })), o, prev?.hit?.x);
 const ay = axisSnap(moving.y, h, view.h,
 others.map((b) => ({ pos: b.y, size: b.h, from: b.x, to: b.x + b.w })), o, prev?.hit?.y);

 // BOTH CENTRES AT ONCE PARKS THE BAR DEAD CENTRE over the level, on top of
 // the machine, which is the one place in the room a bar must never
 // volunteer to go. They are each reasonable alone — centred horizontally
 // along the bottom is the dock's own home — so the weaker of the two is
 // dropped rather than both.
 let sx = ax, sy = ay;
 if (sx.kind === 'centre' && sy.kind === 'centre') {
 if (Math.abs(sx.pos - moving.x) <= Math.abs(sy.pos - moving.y)) sy = { pos: moving.y, hit: null, guides: [] };
 else sx = { pos: moving.x, hit: null, guides: [] };
 }

 // Clamp AFTER snapping, always, so a snap can never propose a position the
 // drag would not otherwise have been allowed to reach.
 const put = (X, Y) => ({
 x: clampBarAxis(X.pos, w, view.w, margin),
 y: clampBarAxis(Y.pos, h, view.h, margin),
 hit: { x: X.hit, y: Y.hit },
 guides: [...X.guides.map((g) => ({ ...g, axis: 'x' })), ...Y.guides.map((g) => ({ ...g, axis: 'y' }))],
 });

 const r = put(sx, sy);
 // THE CORNERS THE SHELL OWNS. `.build-note` and `.return-note` are
 // position:fixed at z-index 400 in the bottom-left and bottom-right — outside
 // the game root, and 400 is far above the HUD's 10 — so a bar magnetised into
 // either corner is a bar that has silently gone under something.
 //
 // It is PUSHED clear rather than left unsnapped, and that took a measurement
 // to settle. Withdrawing the snap does nothing here: the note is 210 x 34 and
 // the snap moves at most 13 px, so by the time a bar is close enough to be
 // caught it is already overlapping, and the unsnapped position is under the
 // note too. Feeding the notes in as ordinary alignment candidates only fixed
 // the approaches from above (measured: 2 of 5). Pushing fixes all five, and
 // it lands the bar exactly on top of the note, which is where it was going.
 //
 // Only a bar the snap MOVED is pushed. A bar dragged under a note by hand is
 // left alone: the note is 55% transparent until you point at it, and moving a
 // piece of furniture somebody put somewhere on purpose is worse than the
 // overlap.
 if (!exclude.length || (r.hit.x == null && r.hit.y == null)) return r;
 const box = { x: r.x, y: r.y, w, h };
 const clash = exclude.find((e) => hits(box, e));
 if (!clash) return r;
 // Four ways out, the shortest that the clamp will actually allow.
 const outs = [
 { x: clash.x - w, y: r.y }, { x: clash.x + clash.w, y: r.y },
 { x: r.x, y: clash.y - h }, { x: r.x, y: clash.y + clash.h },
 ].map((p) => ({
 x: clampBarAxis(p.x, w, view.w, margin), y: clampBarAxis(p.y, h, view.h, margin),
 })).filter((p) => !exclude.some((e) => hits({ x: p.x, y: p.y, w, h }, e)))
 .sort((a, b) => (Math.abs(a.x - r.x) + Math.abs(a.y - r.y))
 - (Math.abs(b.x - r.x) + Math.abs(b.y - r.y)));
 // Nowhere clear — a viewport too small to hold both. The snap is better than
 // nothing, and the note is the thing that can be dismissed.
 if (!outs.length) return r;
 return { ...outs[0], hit: r.hit, guides: r.guides };
}

// ---------- what the held modifier means, right now (§8.2) ----------

// game.js says it about itself, in a comment on the Level pointer's tooltip:
// *"Alt is the most overloaded key in the editor (rope paint, small wheel, fine
// grid, waypoint insert, prop pin, one-link delete, 10 degree rotate)"*. That
// list is a year old and already short by four — group-span snap, sharp Bezier
// corner, micro-nudge and no-grid nudge are Alt too, which makes eleven
// meanings for one key. Every one of them is reasonable in its own context and
// no tooltip can hold them all, because a tooltip belongs to a button and this
// belongs to a MOMENT.
//
// So the editor says it out loud instead: hold a modifier and a chip names the
// one meaning that is armed. It answers the question people actually have,
// which is never "what does Alt do" but "what will Alt do if I press now".
//
// PURE, and here rather than in the handler, for the reason the rest of this
// file exists: a rule that lives in a DOM handler ships wrong because no gate
// can reach it. Everything the decision needs arrives in `c`; nothing is read
// off `this`.
//
// Returns null when nothing is armed. A chip reading "Alt: nothing" is worse
// than no chip, because it teaches you to stop looking at it.

// The tools that place something whose SIZE Alt chooses. Both ladders are the
// wheel ladder — the wheel takes WHEEL_SIZES directly, the boxes and balls take
// whole multiples of the same rung (game.js `_beginLevelPlacement`).
// EXPORTED, because game.js's info chip has to ask the same question the chip
// rule does — "is this a tool whose size the rung decides" — and two lists that
// must agree are a list that will eventually disagree.
export const SIZEABLE = new Set(['wheel-ccw', 'wheel-free', 'wheel-cw',
 'terrain-box', 'terrain-ball', 'prop-box', 'prop-ball']);
export const ROD_TOOLS = new Set(['rod-wood', 'rod-water']);

// DOES THIS STICK DRAG LAY A ROPE? An XOR, and pure, so the chip that promises
// it and the drag that does it are the same sentence read twice. Alt is the
// exception to whatever is currently NORMAL — the rule the snap latch already
// follows, where Shift stops meaning "snap" once snapping is what happens
// anyway. Unarmed, Alt+drag lays the rope as it always has; armed, Alt+drag
// lays the single stick, because a modifier that changed nothing would be a
// modifier you learn to stop trusting.
export const laysRope = (alt, ropeArmed) => !!alt !== !!ropeArmed;

// The grid a drag will land on, given the two modifiers and the latch. This is
// game.js `_gridStepOf` as a free function — the same table, so the chip cannot
// promise a grid the drag does not use.
//
// `snapMode` is one of game.js's SNAP_MODES: 'on', 'rev', 'off'. The middle one
// is spelled REV, not 'reversed' — anything unrecognised behaves as 'rev' does,
// which is the safe way round, but a caller that guesses 'reversed' would get
// the right answer by accident and the wrong one the day a fourth mode lands.
export function gridStepFor(snapMode, shift, alt) {
 if (snapMode === 'off') return 0;
 if (alt) return GRID_FINE;
 if (shift) return GRID_STEP;
 if (snapMode === 'on') return GRID_STEP;
 return 0;
}

export function modifierIntent(c = {}) {
 const { alt = false, shift = false, ctrl = false } = c;
 if (!alt && !shift && !ctrl) return null;
 const keys = [ctrl && 'Ctrl', shift && 'Shift', alt && 'Alt'].filter(Boolean).join('+');
 const out = (label) => (label ? { keys, label, alt, shift, ctrl } : null);
 const { tool = 'pointer', tab = 'machine', drag = null, snapMode = 'on' } = c;

 // ---- mid-gesture: the drag in hand decides, and nothing else can ----
 if (drag === 'handle') { // a Bezier control point
 if (alt) return out('Sharp corner — this handle moves alone');
 if (shift) return out('Mirror the other handle, keep its length');
 return null;
 }
 if (drag === 'rotate') {
 if (shift) return out('45° steps');
 if (alt) return out('10° steps');
 return null;
 }
 if (drag === 'groupResize') {
 return alt ? out(tf("Snap the group's span to {n}", { n: GRID_FINE })) : null;
 }
 if (drag === 'rod') {
 // Alt is the exception to whatever is currently NORMAL — the rule the snap
 // latch already follows, where Shift stops meaning "snap" once snapping is
 // what happens anyway. With J armed the plain drag lays the rope, so Alt
 // has to say the other thing or it would be claiming to do nothing.
 if (alt && !laysRope(alt, c.ropeArmed)) return out('Lay ONE stick, not a rope');
 if (alt) return out(tool === 'rod-water' ? 'Paint a wet rope' : 'Paint a wood rope');
 return gridLabel(out, snapMode, shift, alt);
 }
 if (drag === 'move' || drag === 'resize' || drag === 'paste') {
 return gridLabel(out, snapMode, shift, alt);
 }

 // ---- armed, waiting for the click ----
 // FC1: Ctrl+left deletes. Ctrl+Shift+left is the selection/marquee chord.
 if (ctrl && shift && !alt && tool !== 'delete') {
 if (c.overPiece) return out('Add to / take from the selection');
 return out('Drag a marquee');
 }
 if (ctrl && !shift && alt && tool !== 'delete' && c.overPiece) {
 return out('Delete ONE link of the rope');
 }
 if (ctrl && !shift && !alt && tool !== 'delete') {
 if (c.overPiece) return out('Delete this piece');
 return null;
 }
 if (shift && !alt && !ctrl) {
 if (c.overJoint) return out('Move this pin — links stretch');
 if (c.overPiece) return out('Move this piece — links stretch to stay connected');
 return out('Pan the view');
 }
 if (tool === 'delete' && alt) return out('Delete ONE link of the rope');
 if (SIZEABLE.has(tool) && alt) {
 // FOUR whole sentences rather than one built from parts. A translator needs
 // the sentence, not "Large" and "wheel" and a number to assemble in an
 // order English happens to use — and t() can only match a key that the
 // source really says.
 //
 // The NUMBER comes from `placeRung`, the same call `_pointerDown` and
 // `_beginLevelPlacement` make. Held here as a literal it would be right
 // twice and wrong for ever after: `,` and `.` arm a rung, and Alt is now
 // an override of that rung rather than the only way to choose one.
 const n = rungRadius(placeRung(c.rung, true, shift));
 // …and if that is the rung already armed, Alt is about to do NOTHING, so
 // the chip says nothing. Arm the small wheel and hold Alt and the old code
 // announced "Small wheel — r10" for a key that changed no outcome, which
 // is the exact habit this readout exists to break.
 if (n === rungRadius(placeRung(c.rung, false, false))) return null;
 if (tool.startsWith('wheel-')) {
 return out(shift ? tf('Large wheel — r{n}', { n }) : tf('Small wheel — r{n}', { n }));
 }
 return out(shift ? tf('Large — the r{n} rung', { n }) : tf('Small — the r{n} rung', { n }));
 }
 if (ROD_TOOLS.has(tool) && alt) {
 if (!laysRope(alt, c.ropeArmed)) return out('Drag to lay ONE stick, not a rope');
 return out(tool === 'rod-water' ? 'Drag to paint a wet rope' : 'Drag to paint a wood rope');
 }
 if (tool === 'pointer') {
 if (alt && c.overPath) return out('Insert a waypoint here');
 if (alt && !shift && tab === 'level' && c.overPinnable) return out('Pin it where it is');
 if (shift && !alt && c.overJoint) return out('Move this pin — links stretch');
 if (shift && !alt && c.overPiece) return out('Move this piece — links stretch to stay connected');
 }
 // With something selected and nothing yet grabbed, Alt is armed for TWO
 // gestures at once and both are true: the drag lands on the fine grid, and
 // the arrow keys step by the micro rung instead of the fine one. Reporting
 // only the drag was simply wrong the moment the hand went to the arrows.
 if (c.hasSel && !drag) {
 const n = alt && shift ? NUDGE_STEPS[0] : alt ? NUDGE_STEPS[2] : null;
 if (n != null) {
 const g = gridStepFor(snapMode, shift, alt);
 return out(g ? tf('Arrows nudge {n} px · drag snaps to {g}', { n, g })
 : tf('Arrows nudge {n} px', { n }));
 }
 }
 return null;
}

// Live bindings card: what L / M / R mouse and the arrows do RIGHT NOW.
// Pure, like modifierIntent — the chip is only a face. Empty strings are
// shown as an em dash so a blank row never looks like a missing update.
export function bindLegend(c = {}) {
 const alt = !!c.alt, shift = !!c.shift, ctrl = !!c.ctrl;
 const tool = c.tool || 'pointer';
 const tab = c.tab || 'machine';
 const playing = !!c.playing;
 const paint = !!c.paint;
 const drag = c.drag || null;
 const buttons = c.buttons || 0;
 const leftHeld = !!(buttons & 1);
 const midHeld = !!(buttons & 4);
 const over = !!c.overPiece;
 const joint = !!c.overJoint;
 const hasSel = !!c.hasSel;
 const makerLevel = c.mode === 'maker' && tab === 'level';
 const mods = [ctrl && 'Ctrl', shift && 'Shift', alt && 'Alt'].filter(Boolean).join('+');
 const toolLabel = ({
 pointer: 'Select', 'wheel-ccw': 'L wheel', 'wheel-free': 'F wheel', 'wheel-cw': 'R wheel',
 'rod-wood': 'Wood stick', 'rod-water': 'Water stick', delete: 'Delete',
 'terrain-box': 'Terrain box', 'terrain-ball': 'Terrain boulder', 'terrain-paint': 'Painter',
 'prop-box': 'Prop crate', 'prop-ball': 'Prop ball',
 'goal-piece': 'Goal crate', 'goal-ball': 'Goal ball', text: 'Text', pin: 'Pin',
 })[tool] || tool;

 const row = (left, middle, right, arrows, extra = {}) =>
 ({ tool: toolLabel, mods, left, middle, right, arrows, dbl: extra.dbl ?? dblLine(), ...extra });

 const panL = leftHeld && (drag === 'pan' || drag == null) ? 'Panning' : 'Pan';
 const panM = midHeld ? 'Panning' : 'Pan';
 const through = midHeld ? 'Moving through' : 'Drag through solids';
 const middle = (makerLevel && over && !playing) ? through : panM;
 // Empty ground still opens the mini toolbar; a piece adds its own rows on top.
 let right = playing ? '—' : (over ? 'Piece menu' : 'Mini Toolbar');

 if (playing) {
 const stop = c.mode === 'maker' && (tool !== 'pointer' || over);
 let left = stop ? 'Stop' : panL;
 if (c.mode !== 'maker') left = panL;
 return row(left, panM, '—', c.hasTape ? (shift ? 'Scrub 1 s' : 'Scrub 0.1 s') : '—');
 }

 if (paint) {
 return row(leftHeld ? 'Tracing' : 'Click a point · drag to trace', panM, 'Mini Toolbar', '—',
 { note: 'Enter / double-click closes · Backspace undoes · Esc cancels' });
 }
 if (c.pasteArmed) return row('Drop the copy', panM, right, '—');

 if (drag === 'pan') return row('Panning', panM, right, arrowLine());
 if (drag === 'move-pin') return row('Moving pin', middle, 'Pin menu', arrowLine());
 if (drag === 'handle') {
 const h = alt ? 'Sharp — this handle alone' : shift ? 'Mirror the other handle' : 'Moving handle';
 return row(h, middle, right, arrowLine());
 }
 if (drag === 'waypoint') return row('Moving node', middle, 'Node menu', arrowLine());
 if (drag === 'rotate') {
 const spin = shift ? 'Rotating 45°' : alt ? 'Rotating 10°' : 'Rotating';
 return row(spin, middle, right, arrowLine());
 }
 if (drag === 'move' || drag === 'resize' || drag === 'paste') {
 const doing = drag === 'resize' ? 'Sizing' : 'Moving';
 return row(doing, middle, right, arrowLine());
 }
 if (drag === 'rod' || drag === 'place-wheel') {
 return row(ROD_TOOLS.has(tool) ? 'Extending rope' : 'Placing', middle, right, arrowLine());
 }

 let left;
 if (ctrl && shift && !alt) left = over ? 'Add to / take from selection' : 'Drag a marquee';
 else if (ctrl && !shift && alt) left = over ? 'Delete one rope link' : '—';
 else if (ctrl && !shift) left = over ? 'Delete' : '—';
 else if (shift && !alt && !ctrl) {
 if (joint) left = 'Move this pin';
 else if (over) left = 'Move this piece (links stretch)';
 else left = panL;
 } else if (SIZEABLE.has(tool) && alt) {
 const n = rungRadius(placeRung(c.rung, true, shift));
 left = shift ? tf('Place large — r{n}', { n }) : tf('Place small — r{n}', { n });
 } else if (ROD_TOOLS.has(tool) && alt) {
 if (!laysRope(true, c.ropeArmed)) left = 'Drag one stick, not a rope';
 else left = tool === 'rod-water' ? 'Paint a wet rope' : 'Paint a wood rope';
 } else if (tool === 'terrain-paint') left = 'Click a point · drag to trace';
 else if (tool.startsWith('wheel-')) left = 'Place wheel';
 else if (ROD_TOOLS.has(tool)) left = 'Drag to place stick';
 else if (['terrain-box', 'terrain-ball', 'prop-box', 'prop-ball', 'goal-piece', 'goal-ball'].includes(tool)) {
 left = 'Click or drag to place';
 } else if (tool === 'text') left = 'Place a sign';
 else if (tool === 'pin') {
 if (c.overPropPin || c.overLoosePin) left = 'Move pin';
 else if (c.overPinnable) left = 'Add pin on this piece';
 else left = 'Place a loose pin';
 }
 else if (tool === 'delete') left = over ? 'Delete' : 'Click a piece to delete';
 else if (over) left = 'Move connected machine';
 else left = panL;

 // Pins on a prop/terrain, or a loose world pin (Create tab).
 if (c.overLoosePin || c.overPropPin) {
 if (ctrl && !shift) left = 'Delete pin';
 else if (tool === 'pointer' && alt && !shift && !ctrl) left = 'Move pin';
 else if (tool === 'pointer' && c.pinOnSel && !ctrl && !alt && !shift) left = 'Move pin';
 if (c.overLoosePin || c.pinOnSel) right = 'Pin menu';
 } else if (c.overPinnable && tool === 'pointer' && alt && !shift && !ctrl) {
 left = 'Add pin on this piece';
 }

 if (c.overHandle) {
 left = alt ? 'Sharp — this handle alone' : shift ? 'Mirror the other handle' : 'Move handle';
 } else if (c.overWaypoint) {
 left = (ctrl && !shift) ? 'Delete node' : 'Move node';
 right = 'Node menu';
 } else if (c.overResize) {
 left = 'Resize';
 } else if (c.overKnob) {
 left = shift ? 'Rotate 45°' : alt ? 'Rotate 10°' : 'Drag to rotate';
 } else if (tool === 'pointer' && alt && !shift && !ctrl && c.overPath && !c.overWaypoint) {
 left = 'Insert a waypoint';
 }

 // Several pieces under the cursor: a click opens the pick list instead of
 // grabbing the top one — unless this piece is already selected, or a
 // modifier already named a different job.
 if (c.stacked && tool === 'pointer') {
 const pinOrNode = c.overPropPin || c.overLoosePin || c.overWaypoint || c.overHandle || c.overKnob || c.overResize;
 if (!ctrl && !alt && !shift && !drag && !c.selInStack && !pinOrNode) left = 'Pick a piece';
 if (!ctrl && !pinOrNode) right = 'Pick a piece';
 }

 return row(left, middle, right, arrowLine());

 function arrowLine() {
 if (c.armedRotate || (c.overKnob && !c.hasTape)) {
 if (shift) return 'Rotate 45°';
 if (alt) return 'Rotate 10°';
 return 'Rotate 1°';
 }
 if (c.armedResize || c.overResize) {
 if (c.hasTape && !ctrl && !alt) return shift ? 'Scrub 1 s' : 'Scrub 0.1 s';
 const g = gridStepFor(c.snapMode || 'on', shift, alt);
 return g ? tf('Snap corner {n} px', { n: g }) : (alt ? 'Nudge corner 0.01 px' : 'Nudge corner');
 }
 if (c.hasTape && !ctrl && !alt) return shift ? 'Scrub 1 s' : 'Scrub 0.1 s';
 if (!hasSel) return '—';
 if (alt && shift) return 'Nudge 1 px';
 if (alt) return 'Nudge 0.01 px';
 const g = gridStepFor(c.snapMode || 'on', shift, false);
 return g ? tf('Snap {n} px', { n: g }) : 'Nudge 0.1 px';
 }

 function dblLine() {
 if (playing) return '—';
 if (paint) return 'Close the shape';
 // A node keeps corner ⇄ curve even with Ctrl held — that chord deletes
 // on a single click. Align-anchor is the path (or the piece), not the dot.
 if (c.overWaypoint) return 'Corner ⇄ curve';
 if (c.overKnob) return 'Reset rotation to 0°';
 if (c.overHandle) return '—';
 if (ctrl && hasSel && over) return 'Make align anchor';
 if (c.overText) return 'Edit text';
 if (c.overMachine) return 'Select connected machine';
 return '—';
 }
}

function gridLabel(out, snapMode, shift, alt) {
 const g = gridStepFor(snapMode, shift, alt);
 if (g) return out(tf('Snap to the {n} grid', { n: g }));
 // "off" is the latch, and no modifier reopens it — saying "free" there would
 // read as though the modifier had done something.
 if (snapMode === 'off') return null;
 return out('Free — no grid');
}

// ---------- tooltips ----------

// One floating node for the whole app, positioned fixed. A CSS ::after tooltip
// would be simpler but gets clipped by `.card { overflow: hidden }` on exactly
// the badges beginners meet first, so the tip lives outside the flow instead.
// Delegated from document, so anything gaining a `data-tip` later just works.
let tipEl = null;
let tipFor = null;

function showTip(target) {
 const text = target.getAttribute('data-tip');
 if (!text) return;
 if (!tipEl) {
 tipEl = el('div', { class: 'tip', role: 'tooltip' });
 document.body.append(tipEl);
 }
 tipFor = target;
 // **A line that is wholly inside quotation marks is SPEECH, and gets a bubble
 // of its own** — reversed again, so it is ink on white inside a tooltip that
 // is already white on ink. The challenge popup (§11.8) is the case: five lines
 // of terms the game is stating, and one line a person wrote, and reading them
 // in the same voice is what made the message invisible in there.
 //
 // A convention rather than a second attribute, because it needs no caller to
 // know about it: `challengeTip` already wraps the message in curly quotes for
 // the plain-text rendering, and anything else that quotes a whole line means
 // the same thing by it.
 //
 // Built as one node per line with `textContent`, never innerHTML — every
 // interesting tip on this site interpolates a name, a level title or the
 // message itself, all of which are typed by users.
 tipEl.textContent = '';
 for (const line of text.split('\n')) {
 const said = line.length > 1 && line.startsWith('“') && line.endsWith('”');
 tipEl.append(el('div', { class: said ? 'tip-said' : 'tip-line' }, line));
 }
 // `data-tip-1line`: a short tip that reads as one sentence and looks broken
 // wrapped — the rating row's "…· you gave it 1" was orphaning the number on a
 // line of its own. Opt-in, because the default 230px wrap is what keeps a
 // long badge description from becoming a ribbon across the screen.
 //
 // **…and only honoured when the text can actually BE one line.** The class
 // is `white-space: nowrap` under a 520px cap (96vw on a phone), so a long
 // sentence wearing the flag paints straight out of its own bubble — which
 // is exactly what the visibility column's ~110-char "Local — saved in this
 // browser only…" did on a phone ("does not render within its bubble",
 // 2026-08-07). Sixty characters sits comfortably inside the cap at this
 // font; anything past it wraps like a normal tip, flag or no flag.
 tipEl.classList.toggle('one-line', target.hasAttribute('data-tip-1line') && text.length <= 60);
 // `data-tip-wide`: the other direction. A challenge popup (§11.8) is a small
 // CARD — six short lines, one of them the challenger's own — and at 230px
 // every one of them wraps, which turns six lines into fourteen and buries the
 // terms.
 tipEl.classList.toggle('wide', target.hasAttribute('data-tip-wide'));
 tipEl.classList.add('on');
 // **`data-tip-under`: anchor to a BOX, and always below it** (2026-08-12, for
 // the toolbar popups — "The standard usual tool tip for whichever one they
 // are pointing at should be low enough not cover the icons"). A tip normally
 // measures against the thing hovered and prefers ABOVE it where there is
 // room, which is right for a button in a row and wrong for a grid of icons:
 // above the second icon is on top of the first. An ancestor carrying the
 // attribute becomes the rect the tip is placed against, and the preference
 // for above is dropped, so one strip of icons gets one tip position under all
 // of them however small each icon is.
 const anchor = target.closest?.('[data-tip-under]') || target;
 const under = anchor !== target;
 // measure after the text is in, then clamp inside the viewport
 const r = anchor.getBoundingClientRect();
 const t = tipEl.getBoundingClientRect();
 const x = clamp(r.left + r.width / 2 - t.width / 2, 6, window.innerWidth - t.width - 6);
 const above = !under && r.top > t.height + 10;
 tipEl.style.left = x + 'px';
 tipEl.style.top = (above ? r.top - t.height - 8 : r.bottom + 8) + 'px';
}

// Exported so the router can call it: a navigation leaves a showing tip
// pointing at an element that no longer exists (see route()).
export function hideTip() {
 tipFor = null;
 if (tipEl) tipEl.classList.remove('on');
}

// A click that changes `data-tip` on the hovered control would otherwise keep
// showing the old sentence until the pointer left and came back — pointerover
// skips when the target is still `tipFor`.
export function refreshTip() {
 if (tipFor) showTip(tipFor);
}

export function installTooltips() {
 const at = (e) => e.target?.closest?.('[data-tip]');
 document.addEventListener('pointerover', (e) => {
 const t = at(e);
 if (t === tipFor) return;
 if (t) showTip(t); else hideTip();
 });
 document.addEventListener('focusin', (e) => { const t = at(e); if (t) showTip(t); });
 document.addEventListener('focusout', hideTip);
 // any scroll/resize/route change strands the tip next to nothing
 window.addEventListener('scroll', hideTip, true);
 window.addEventListener('resize', hideTip);
 // popstate covers back/forward AND in-app navigation, because `go()`
 // dispatches one — the hashchange this used to listen for no longer happens
 window.addEventListener('popstate', hideTip);
}

// ---------- piece stats (§7.2) ----------

// Display-only estimate, never feeds physics.
export function estimateWeightKg(parts) {
 let kg = 0;
 for (const p of parts) {
 if (p.t === 'wheel') {
 const circumferenceM = 2 * Math.PI * p.r / 30;
 kg += circumferenceM * 3.0 * (p.kind !== 'free' ? 1.5 : 1);
 } else if (p.t === 'rod') {
 const lengthM = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) / 30;
 // `?? 1` — a water stick may be weightless (sizes.js), and `||` would
 // have billed a 0 as a ×1 in the machine's own kg readout
 kg += lengthM * (p.kind === 'wood' ? 2.0 : 0.5) * (p.weight ?? 1);
 }
 }
 return kg;
}

// **A ROPE IS ONE PIECE.** It is one thing you drew, it draws as one line, and
// it has to count as one: at ROPE_LINK_LEN a 400 px rope is fifty links, so
// counting the links would put every piece bar in the game (§11.8), every
// "fewest pieces" leaderboard and every piece-capped challenge out of reach the
// moment you used one — the feature would be a trap rather than a tool.
//
// Counted by RUN, not by `chain` id: cut a rope in half and it is honestly two
// ropes, which is exactly what you see (§10.1). `kg` is untouched and still
// sums every link, because mass is mass — a rope you can carry a crate with is
// a heavy rope, and that is the trade the weight dial is for.
//
// `parts` is the raw body count, and it is a DIFFERENT number: it is what
// MAX_DESIGN_PARTS caps, because that cap is a measured performance guard on
// what the solver is handed, not a statement about how much you built. Nothing
// but the editor's own chip reads it.
export function designStats(parts) {
 let wheels = 0, poweredWheels = 0, wood = 0, water = 0, ghost = 0;
 for (const p of parts) {
 if (p.t === 'wheel') { wheels++; if (p.kind !== 'free') poweredWheels++; }
 // **GHOST is counted apart from water, not folded into it** (2026-08-10).
 // The old `else water++` swept every non-wood rod into the water bucket,
 // which was exactly right while there were two kinds and silently wrong the
 // moment there were three: a machine of ghost sticks would have reported
 // itself as all-water and worn the Wet badge, whose own words are "nothing
 // but WATER sticks". No recorded solve can contain one — the kind is new
 // and nothing places it — so this re-counts nothing that already exists.
 else if (p.t === 'rod' && !p.chain) {
 if (p.kind === 'wood') wood++;
 else if (p.kind === 'ghost') ghost++;
 else water++;
 }
 }
 // Counted by `ropePieces`, NOT by run: a run is a stroke and cannot fork, so
 // four strands at a junction draw as four runs — but they are two ropes, and
 // two ropes tied end to end are one. The count follows the rope, not the ink.
 const ropes = ropePieces(parts.filter((p) => p.t === 'rod' && p.chain));
 let ropeCount = 0;
 for (const c of ropes) {
 ropeCount += c.pieces;
 if (c.water) water += c.pieces; else wood += c.pieces;
 }
 // Deliberately NOT `wheels + wood + water`: written this way it is exactly
 // `parts.length` for any design without a rope, whatever is in the list.
 const pieces = parts.filter((p) => !(p.t === 'rod' && p.chain)).length + ropeCount;
 // **The heaviest PIN, for the NRW badge (§11.4).** Summed per pin, not per
 // rod, because that is where the load actually lands and because the whole
 // point of the badge is that two 200s bolted to one pin are a 400 — "no
 // sneaking 2×200 density rods". A lone rod is a pin with one rod on it, so a
 // single 300 fails on its own endpoints without a special case.
 //
 // Rope links count like any other stick: an internal pin carries two of them,
 // so a rope wears twice its own weight there. That is the true load, and a
 // default rope (weight 1) sits at 2, nowhere near the bar.
 const pinWeight = new Map();
 for (const p of parts) {
 if (p.t !== 'rod') continue;
 const w = Number(p.weight) || 1;
 for (const k of [jointKey(p.x1, p.y1), jointKey(p.x2, p.y2)]) {
 pinWeight.set(k, (pinWeight.get(k) || 0) + w);
 }
 }
 let maxPinWeight = 0;
 for (const v of pinWeight.values()) if (v > maxPinWeight) maxPinWeight = v;
 return { pieces, parts: parts.length, kg: estimateWeightKg(parts), wood, water, ghost, wheels, poweredWheels, maxPinWeight };
}

// ---------- the census (the Advanced bar's FULL tier, 2026-08-09) ----------
//
// "Wheels: TOTAL SMALLSUBTOTAL (L, F, R) / STDSUBTOTAL (L, F, R) / LRGSUBTOTAL
// (L, F, R). Rod: TOTAL (WET, HARD)."
//
// A breakdown `designStats` cannot give: it answers "how much have I spent"
// (pieces, parts, kg) and this answers "of WHAT" — which is the question you
// ask while trying to fit a machine under a challenge's piece bar, or while
// working out why a build is heavy.
//
// Here rather than in the bar that draws it, for the reason sizes.js exists: a
// number a gate cannot reach is a number that ships wrong. The bar is DOM and
// unreachable headlessly; this is a pure function of the parts list.
//
// **Wheels are bucketed by NEAREST radius, not by exact match.** A hand-edited
// or imported level can carry a radius off the ladder entirely, and a census
// that silently dropped those would under-report the machine it is describing.
// Same rule the scroll-resize uses to decide which rung it is standing on.
//
// Rods delegate to `designStats` for wood/water so the two can never disagree
// about what a rope counts as — a rope is one PIECE and many links, and the
// census speaks in pieces, like everything the player is scored on.
export function pieceCensus(parts) {
 const st = designStats(parts);
 const sizes = WHEEL_SIZES.map((r, i) => ({
 r, label: WHEEL_SIZE_LABELS[i], total: 0, ccw: 0, free: 0, cw: 0,
 }));
 for (const p of parts) {
 if (p.t !== 'wheel') continue;
 let best = 0;
 for (let i = 1; i < WHEEL_SIZES.length; i++) {
 if (Math.abs(WHEEL_SIZES[i] - p.r) < Math.abs(WHEEL_SIZES[best] - p.r)) best = i;
 }
 const row = sizes[best];
 row.total++;
 row[p.kind === 'ccw' ? 'ccw' : p.kind === 'cw' ? 'cw' : 'free']++;
 }
 return {
 wheels: { total: st.wheels, sizes },
 rods: { total: st.wood + st.water, water: st.water, wood: st.wood },
 pieces: st.pieces, parts: st.parts, kg: st.kg,
 };
}

// …and what an AUTHOR is spending, which is a different list entirely: a player
// has wheels and sticks, an author has the world they sit in. Pins are summed
// across all three homes they can have (a prop's, a terrain piece's, and the
// level's own loose ones) because "how many pins are in this level" is one
// question however they are stored.
export function levelCensus(level) {
 const terrain = level?.terrain || [];
 const props = level?.props || [];
 const pinsOn = (list) => list.reduce((n, o) => n + propPins(o).length, 0);
 return {
 terrain: terrain.length,
 props: props.length,
 texts: (level?.texts || []).length,
 goalObjs: (level?.goalObjs || []).length,
 // **Build and goal counted apart** (2026-08-09, on request). They were one
 // `zones` number, which is the one thing a zone count must not be: the two
 // are opposite ends of the level — where the machine may be built and where
 // the green thing has to arrive — and a level with two of one and none of
 // the other is broken in a way "2 zones" cannot say.
 buildZones: (level?.buildZones || []).length,
 goalZones: (level?.goalZones || []).length,
 fixedParts: (level?.fixedParts || []).length,
 pins: pinsOn(terrain) + pinsOn(props) + (level?.pins || []).length,
 };
}

// ---------- advanced mode (2026-08-09) ----------
//
// **Off by default, and that is the whole point.** A new player opening a level
// meets a canvas, a piece toolbar and a play bar — and, until this switch
// existed, also an Advanced bar of eleven align ops, a readout of frame rates
// and coordinates, and a piece that starts glowing gold for reasons nothing on
// screen explains. Every one of those is useful and none of them is useful
// YET; together they are the difference between "a game" and "a tool I am
// probably going to break".
//
// So it gates the three things that only mean anything once you already know
// what they are: the Advanced bar, the info chip, and the align anchor's ring.
// Not the piece toolbar, not the dock, not the right-click menus — those are
// how the game is played, and hiding them would be hiding the game.
//
// One key, read by the editor and written by the Settings page, so there is no
// second copy of "is this on" to drift.
export const ADVANCED_KEY = 'advanced';
export function advancedMode() { return store.get(ADVANCED_KEY, false) === true; }
export function setAdvancedMode(on) { store.set(ADVANCED_KEY, !!on); }

// ---------- which physics (2026-08-10 — answered for good 2026-08-17) ----------
//
// This was a play-testing switch between the fitted `lifirik` profile and
// `fc`, kept on the device and written by Settings. The trial ended when the
// engine became fcsim: a profile fitted to imitate FC under another solver
// has nothing left to say when FC's own solver is what runs ("We don't need
// LIFIRIK physics anymore. Just FCLike will do."). The function stays because
// every construction site asks it; the answer stopped being a question. The
// old `physics` store key is simply ignored — a device that once picked
// lifirik needs no migration to stop being asked.
export function physicsMode() { return 'fc'; }

// ---------- frame rate (2026-08-09) ----------
//
// Counted over a WINDOW rather than from the last frame's delta. A per-frame
// `1000/dt` is the honest instantaneous rate and completely unreadable: it
// swings by tens between consecutive frames on an idle machine, so the number
// on screen is a blur and any judgement about it is guesswork. Averaging over
// half a second gives a figure you can actually read and compare.
//
// Returns `null` while the window is still filling — "nothing new to say" —
// so the caller only touches the DOM twice a second instead of sixty times.
//
// Here rather than in the frame loop because the loop is rAF-driven and no gate
// can reach it (the pane it is tested in does not even run rAF). This is the
// arithmetic; the loop only hands it timestamps.
export function fpsTick(state, ts, windowMs = 500) {
 if (state.at == null || ts < state.at) { state.at = ts; state.n = 0; return null; }
 state.n++;
 const dt = ts - state.at;
 if (dt < windowMs) return null;
 const fps = Math.round(state.n * 1000 / dt);
 state.at = ts;
 state.n = 0;
 return fps;
}

// ---------- a slider lets go when the hand does (2026-08-23) ----------
//
// On report: *"After adjusting a slider it should not hold focus. e.g. Slide
// speed to 2x and hit SPACE to start a run. Currently the focus is slider and
// SPACE does nothing. Same for density, etc."*
//
// Exactly right, and the mechanism is the editor's own guard: `_keyDown`
// returns early when the event's target is an INPUT, so a range that kept
// focus after a drag silently swallowed every shortcut — Space above all,
// pressed at the one moment you have just set the speed you want to watch at.
//
// **Pointer interactions only.** A keyboard user who TABBED to the slider is
// USING the focus — arrows step the value — and blurring under them would take
// the control away mid-adjustment. A pointer drag has no further use for the
// focus the click left behind; releasing it is what hands the keyboard back to
// the room. Delegated and capture-phase, so every range on every screen —
// speed, density, volume, the scrub line, a menu's chip-slider — is covered by
// the one listener, including any slider built after this ran.
//
// The blur waits a tick: the browser fires `change` after `pointerup`, and a
// control blurred first can drop the very commit the drag was for.
export function installSliderRelease(root = typeof document !== 'undefined' ? document : null) {
 if (!root) return;
 root.addEventListener('pointerup', (e) => {
 const t = e.target;
 if (t && t.tagName === 'INPUT' && t.type === 'range' && typeof t.blur === 'function') {
 setTimeout(() => t.blur(), 0);
 }
 }, true);
}

// ---------- the interface preferences (§12, 2026-08-23) ----------
//
// The dark plate landed with its hook already named in the stylesheet: "data-hud
// on #app overrides it in either direction so a setting can drive it later."
// This is the later — and density beside it, because the two are the same kind
// of fact: how the HUD sits on this device, chosen by the person using it.
//
// Resolved HERE and only applied in the DOM: an absent attribute is what lets
// the stylesheet's own detection speak (@media prefers-color-scheme for the
// theme, @media pointer: coarse for the density), so 'system' and 'compact'
// RESOLVE TO NULL rather than to a value — writing them as attributes would
// pin the detected answer at its current value forever.
export const HUD_THEMES = ['system', 'light', 'dark'];
export function hudThemeAttr(pref) {
 return pref === 'light' || pref === 'dark' ? pref : null;
}
// 'compact' is the stylesheet's own desktop default (--bar-scale 0.8); the
// other two override BOTH detections — an explicit preference outranks a
// detected one in either direction, exactly as data-hud does for the theme.
export const HUD_DENSITIES = ['compact', 'cozy', 'touch'];
export function hudDensityAttr(pref) {
 return pref === 'cozy' || pref === 'touch' ? pref : null;
}

export function applyHudPrefs(rootEl) {
 const root = rootEl || (typeof document !== 'undefined' ? document.getElementById('app') : null);
 if (!root) return;
 const th = hudThemeAttr(store.get('hudTheme', 'system'));
 if (th) root.setAttribute('data-hud', th); else root.removeAttribute('data-hud');
 const dn = hudDensityAttr(store.get('hudDensity', 'compact'));
 if (dn) root.setAttribute('data-density', dn); else root.removeAttribute('data-density');
}

// ---------- formatting ----------

export function fmtTime(sec) {
 if (sec == null || !isFinite(sec)) return '—';
 if (sec < 60) return tf('{s}s', { s: sec.toFixed(1) });
 const m = Math.floor(sec / 60), s = sec - m * 60;
 return tf('{m}m {s}s', { m, s: s.toFixed(1) });
}

export function fmtKg(kg) {
 if (kg == null || !isFinite(kg)) return '—';
 return tf('{n} kg', { n: kg >= 100 ? Math.round(kg) : kg.toFixed(1) });
}

// **Dates are ISO 8601, everywhere, in the reader's local time** (2026-08-18,
// "either use 2026-08-18 format, or country appropriate dates — I
// don't want to see any American style dates while I am in Australia"). The
// browser's `toLocale*` calls format by the BROWSER's locale, and a Windows
// in Australia set to English (US) says en-US, so every date on the site read
// 8/18/2026. `2026-08-18` needs no country and reads the same in all nine
// languages; the time is 24-hour. The one place a browser still draws its
// own — the `datetime-local` picker in the challenge composer — is the
// browser's control, and it shows the value it holds in its own dress.
const p2 = (n) => String(n).padStart(2, '0');
export function fmtDate(ts) {
 const d = new Date(ts);
 if (!isFinite(d)) return '';
 return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function fmtDateTime(ts) {
 const d = new Date(ts);
 if (!isFinite(d)) return '';
 return `${fmtDate(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function timeAgo(ts) {
 const s = Math.max(0, (Date.now() - ts) / 1000);
 if (s < 60) return t('just now');
 if (s < 3600) return tf('{n}m ago', { n: Math.floor(s / 60) });
 if (s < 86400) return tf('{n}h ago', { n: Math.floor(s / 3600) });
 if (s < 86400 * 30) return tf('{n}d ago', { n: Math.floor(s / 86400) });
 return fmtDate(ts);
}

// **How long something would TAKE**, where `timeAgo` says how long ago it was.
// One unit, rounded, and never "1 days": every band starts at two of itself, so
// the only 1 this ladder can print is one second.
export function fmtSpan(s) {
 if (!Number.isFinite(s) || s <= 0) return '';
 if (s < 90) return tf('{n} s', { n: Math.max(1, Math.round(s)) });
 if (s < 5400) return tf('{n} min', { n: Math.round(s / 60) });
 if (s < 86400 * 2) return tf('{n} h', { n: Math.round(s / 3600) });
 if (s < 86400 * 730) return tf('{n} days', { n: Math.round(s / 86400) });
 return tf('{n} years', { n: Math.round(s / (86400 * 365.25)) });
}

// Thousands, grouped by hand rather than by `toLocaleString`, for the reason the
// dates give: the browser's locale is not the language the game is speaking.
export const fmtCount = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function starStr(avg) {
 if (!avg) return '';
 const full = Math.round(avg);
 return '★'.repeat(full) + '☆'.repeat(5 - full);
}
