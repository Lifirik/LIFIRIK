// gravity.js — which way is down (§5.10).
//
// Pure: no DOM, no node built-ins, no Box2D. The editor (game.js), the solver
// (sim.js) and the level validator (server.js) must agree on exactly one
// schema and one field function, so it lives on its own — the same reasoning
// that put the size floors in sizes.js and the contact dials in surfaces.js.
//
// ---------------------------------------------------------------------------
// A planet is a terrain BALL that pulls
// ---------------------------------------------------------------------------
// `{ type:'ball', x, y, r, planet:{ pull? } }`. Nothing else in the level says
// anything about gravity: the well is not a separate placeable object, it is a
// property of a piece that is already there. That choice is the whole reason
// this feature is small — a planet drags, resizes, rotates, groups, takes a
// motion path, copies, pastes, deletes and undoes because a terrain ball
// already does all of those things, and the sim reads the well's centre off
// the piece's LIVE body pose, so a planet on a path carries its gravity with
// it.
//
// Balls only, and deliberately: "which way is down" has to have an answer at
// every point around the piece, and a rounded box or a painted outline has no
// single centre that produces one. The editor offers the toggle on balls; the
// server refuses it anywhere else.
//
// ---------------------------------------------------------------------------
// The field: constant magnitude, nearest planet wins
// ---------------------------------------------------------------------------
// A body inside a planet level feels exactly `GRAVITY * pull` toward the
// centre of the NEAREST planet, measured surface-to-surface. Both halves of
// that are gameplay decisions taken against the pinned binary, and both had a
// tempting alternative that measures badly:
//
//   * Inverse-square (real gravity, anchored so the surface reads exactly
//     GRAVITY) makes the play area outside a couple of radii uninhabitable.
//     Measured: a ball 40 m from a 3 m planet feels 0.07 m/s², drifts 9 mm in
//     20 s and then FALLS ASLEEP — a machine parked slightly too far out
//     freezes in mid-air and never comes down, which reads as a broken game
//     rather than as weak gravity. Constant magnitude means every piece
//     anywhere in the level weighs what it looks like it weighs.
//
//   * Summing every planet's pull (real superposition) breaks resting the
//     moment there are two. With constant magnitude the far planet pulls just
//     as hard as the one you are standing on, so the sum points along the
//     bisector and lifts a piece off a surface it was happily sitting on.
//     Nearest-wins keeps every surface a surface, and gives a binary system a
//     clean neutral line to cross instead of a tug-of-war everywhere.
//
// Nearest is by SURFACE distance (`|p − c| − r`), not centre distance: a
// 300 px planet and a 30 px one 800 px apart split the space at the midpoint
// of the GAP, so hovering 100 px above the big one is never claimed by the
// small one 370 px away.
//
// The field is a pure function of body poses and authored numbers — no
// randomness, no clock — so replays stay bit-identical (§5.8).
// **7.5, down from 13** (2026-08-14, on request: *"fix planet gravity back to
// 7.5 equivalent"*). This was not a feel change, it was a broken promise: the
// paragraph directly below has always said a planet at pull 1 weighs exactly
// what flat ground weighs, and that stopped being true on 2026-08-12 when the
// LIFIRIK profile's own gravity moved 13 → 7.5 and this number did not follow.
// A planet level was 1.73× heavier than the same level laid flat, in both
// profiles, and nothing said so.
//
// It is the copy that caused it, so the copy is gone: `PHYSICS.lifirik.gravity`
// now REFERENCES this constant rather than restating it, and `fieldAt` takes
// the live profile's gravity so an FC planet is FC's gravity — the same
// promise sim.js's motor constants make ("the constants themselves, not copies
// of them"), and the same way it was broken.
// **10, measured against FC's own engine** (2026-08-15). This was 7.5, adopted
// as "FC's own" from a fit against recordings. It is not FC's own: fcsim — FC's
// engine reconstructed in C, Box2D 2.x in doubles — sets `gravity.y = 300` in
// world units at 30 units/metre, which is 10 m/s².
//
// Measured rather than argued, by running the same falling wheel through both
// solvers (scripts/probe-fcref.mjs): over two seconds FC drops it 610 px, 7.5
// dropped it 451 — 26% short — and 10 drops it 601, which is 1.4% out. That
// last 1.4% is the residue of FC's 1/30 step against our 1/60 in a
// semi-implicit integrator, and no constant can remove it.
//
// Everything else in the FC profile was already exact: friction, restitution,
// densities, motor speed, and both damping rates once converted out of Box2D
// 2.x's per-step convention. Gravity was the one number left.
export const GRAVITY = 10;        // m/s² — flat-world gravity; a planet at pull 1 matches it

// What the pull dial multiplies. 1 = the same weight as an ordinary level, so
// a machine built on flat ground behaves the same when it is stood on a
// planet's surface — that is the point of anchoring to GRAVITY rather than
// giving planets a gravity number of their own.
export const PULL_DEFAULT = 1;
export const PULL_NOTCHES = [0.25, 0.5, 1, 1.5, 2, 3];
export const PULL_MIN = PULL_NOTCHES[0];
export const PULL_MAX = PULL_NOTCHES[PULL_NOTCHES.length - 1];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && isFinite(v);

// ---------------------------------------------------------------------------
// One piece's own gravity: `{ shape:'box', …, gravity: -1 }`
// ---------------------------------------------------------------------------
// A multiplier on what gravity does to ONE piece and nothing else in the level.
// 1 is an ordinary piece's weight, 0 hangs exactly where it was put, −1 falls
// UP as fast as an ordinary piece falls down, and 2 drops twice as briskly.
// Absent means 1, the same trick pull, density and surface use.
//
// **Props and GOAL PIECES both** (2026-08-14, on request: "Add gravity to goal
// pieces (same as Props)"). This was a prop-only dial, on the reasoning that
// the goal pieces are the run's cargo and every win condition is "did they get
// there", so floating cargo was a different game rather than a different
// level. That was a taste call rather than a physical obstacle, and the taste
// went the other way: "deliver the balloon that wants to leave" is a puzzle in
// exactly the way a ×8 crate you cannot push is one, and the machine still has
// to get it home. Terrain is still refused — it is static, and a gravity scale
// on a body that never moves means nothing.
//
// It is a gravity SCALE and NOT a negative mass, which is the tempting reading
// and is unbuildable: density multiplies into mass, mass cancels out of free
// fall (a = F/m), so a negative one would fall at exactly the normal rate and
// then solve every contact with a negative inverse mass — pieces sucked into
// surfaces and NaN poses, not lift. Box2D carries a per-body gravity scale for
// precisely this, so a floating prop keeps a positive mass and an honest
// contact solve: it weighs what it looks like it weighs, gravity just points
// the other way for it.
//
// The range is the DIAL's, and it is SYMMETRIC: whatever a piece can be made to
// do downward it can be made to do upward, so −2 is a piece that leaves as hard
// as a 2 arrives and the ladder reads the same in both directions from 0. The
// ends are where they are because 2× is about as brisk as a piece can drop and
// still be something an author can build against — past that it is off the
// level before you can aim at it, in whichever direction it went.
export const PIECE_GRAVITY_NOTCHES = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
export const PIECE_GRAVITY_DEFAULT = 1;
export const PIECE_GRAVITY_MIN = PIECE_GRAVITY_NOTCHES[0];
export const PIECE_GRAVITY_MAX = PIECE_GRAVITY_NOTCHES[PIECE_GRAVITY_NOTCHES.length - 1];

// Clamped, never trusted — the sim reads a level that may never have met the
// server (a local file, the FC importer), and this number is a factor on the
// force pushing a body, so a hand-written 1e9 is a body across the county in
// one step. Same treatment as pullOf.
export function pieceGravityOf(o) {
  const g = o && o.gravity;
  return isNum(g) ? clamp(g, PIECE_GRAVITY_MIN, PIECE_GRAVITY_MAX) : PIECE_GRAVITY_DEFAULT;
}

// **Can this piece leave upward and never come back?** (2026-08-14, with the
// goal-piece dial: "pieces that float away are lost".)
//
// An ordinary level's sky is unbounded — you may throw a piece as high as you
// like and it is never lost, because gravity brings it home and the void is
// only ever underneath (sim.js VOID_DROP). That stops being true at exactly
// 0: a piece with no downward pull hangs where the machine left it, and a
// negative one leaves for good. Those are the pieces the sim gives a ceiling.
//
// **Strictly `<= 0`, so every level that already exists is untouched.** Absent
// gravity is 1, so no piece authored before this dial existed can be given a
// ceiling by it, and no replay changes — which is the property that made
// closing the sky safe to do at all rather than a rule that would have to be
// versioned (§5.8).
export function floatsAway(o) {
  return pieceGravityOf(o) <= 0;
}

// Which notch the slider handle sits on. Nearest by DIFFERENCE, not by ratio
// like pullNotch and densityNotch: those ladders are geometric and this one is
// linear — it has to cross zero, and a ratio has nothing to say about 0 or
// about a negative. Only ever used to place the handle; the stored value is
// left alone until the author drags it.
export function pieceGravityNotch(g) {
  const target = clamp(isNum(g) ? g : PIECE_GRAVITY_DEFAULT, PIECE_GRAVITY_MIN, PIECE_GRAVITY_MAX);
  let best = PIECE_GRAVITY_NOTCHES.indexOf(PIECE_GRAVITY_DEFAULT), bestErr = Infinity;
  PIECE_GRAVITY_NOTCHES.forEach((n, i) => {
    const err = Math.abs(n - target);
    if (err < bestErr) { bestErr = err; best = i; }
  });
  return best;
}

// Validation for the server, matching the badPiece/badPlanet convention:
// out of range is REJECTED rather than clamped, because a level that plays
// differently from how it was authored is worse than one that fails to save
// with a reason. `movable` because a static piece has no use for the dial —
// terrain never moves, so a gravity scale on it is a misunderstanding worth
// naming rather than quietly ignoring (the same call badPlanet makes about a
// planet on a box).
export function badPieceGravity(o, at, movable) {
  if (!o || typeof o !== 'object' || !('gravity' in o)) return null;
  if (!movable) return `${at}: only a prop or goal piece can have its own 'gravity'`;
  // Keyed off PRESENT, not off `!= null`: JSON has no NaN, so a number that
  // failed a round trip arrives as null, and waving that through as "absent,
  // use the default" is the silent reading this family of checks refuses.
  if (!isNum(o.gravity)) return `${at}: gravity must be a number`;
  if (o.gravity < PIECE_GRAVITY_MIN || o.gravity > PIECE_GRAVITY_MAX) {
    return `${at}: gravity must be between ${PIECE_GRAVITY_MIN} and ${PIECE_GRAVITY_MAX} (got ${o.gravity})`;
  }
  return null;
}

// A terrain piece is a gravity source iff it carries `planet` AND is a ball.
// The type check is not paranoia: hand-written JSON and the FC importer can
// both put `planet` on a box, and a box has no centre-out direction that
// makes the field mean anything.
export function isPlanet(t) {
  return !!(t && t.planet && t.type === 'ball' && isNum(t.r));
}

// Which notch the Pull slider should sit on for a given value — nearest by
// ratio, not by difference, because the ladder is roughly geometric and a
// hand-edited 0.3 belongs next to 0.25 rather than 0.5. Only ever used to
// place the handle; the stored value is left alone until the author drags it.
// (The density slider has the same helper for the same reason.)
export function pullNotch(pull) {
  const target = Math.log2(isNum(pull) ? clamp(pull, PULL_MIN, PULL_MAX) : PULL_DEFAULT);
  let best = PULL_NOTCHES.indexOf(PULL_DEFAULT), bestErr = Infinity;
  PULL_NOTCHES.forEach((n, i) => {
    const err = Math.abs(Math.log2(n) - target);
    if (err < bestErr) { bestErr = err; best = i; }
  });
  return best;
}

export function pullOf(t) {
  const p = t && t.planet && t.planet.pull;
  return isNum(p) ? clamp(p, PULL_MIN, PULL_MAX) : PULL_DEFAULT;
}

// Every gravity source in the level, in stored order (§5.8 — construction
// order is part of the input). `{def, x, y, r, pull}`; x/y/r are px.
export function planetsOf(level) {
  const out = [];
  for (const t of (level && level.terrain) || []) {
    if (isPlanet(t)) out.push({ def: t, x: t.x, y: t.y, r: t.r, pull: pullOf(t) });
  }
  return out;
}

export const hasPlanets = (level) => planetsOf(level).length > 0;

// The planet whose SURFACE is closest to (px, py), or null. Ties go to the
// earlier entry, which is stored order, which is deterministic.
export function nearestPlanet(px, py, planets) {
  let best = null, bestGap = Infinity;
  for (const p of planets) {
    const gap = Math.hypot(px - p.x, py - p.y) - p.r;
    if (gap < bestGap) { bestGap = gap; best = p; }
  }
  return best;
}

// Acceleration at (px, py) in m/s², as {x, y}. Zero when the level has no
// planets — callers use that to mean "ordinary y-down gravity applies", which
// is what keeps every existing level bit-identical.
//
// Positions are px (world units everywhere outside the sim boundary); the
// return is m/s² because the only thing that integrates it is Box2D.
// `g` is the ACTIVE profile's gravity, so a planet at pull 1 weighs exactly what
// flat ground does under the same physics — the invariant GRAVITY's own note
// describes. The sim passes `this.P.gravity`; the default is for the editor,
// the renderer and the server, none of which pick a profile, and `downAt` needs
// only the direction, where the magnitude cancels.
export function fieldAt(px, py, planets, g = GRAVITY) {
  const p = nearestPlanet(px, py, planets);
  if (!p) return { x: 0, y: 0 };
  const dx = p.x - px, dy = p.y - py;
  const d = Math.hypot(dx, dy);
  // dead centre of a planet: no direction exists. Solid, so unreachable in
  // play, but a level can author a prop there and NaN poses spread instantly.
  if (!(d > 1e-9)) return { x: 0, y: 0 };
  const a = g * p.pull;
  return { x: (dx / d) * a, y: (dy / d) * a };
}

// Unit vector pointing the way a dropped piece would fall, for the editor and
// the renderer. Falls back to world-down so a caller can use it unconditionally.
export function downAt(px, py, planets) {
  const f = fieldAt(px, py, planets);
  const m = Math.hypot(f.x, f.y);
  return m > 1e-9 ? { x: f.x / m, y: f.y / m } : { x: 0, y: 1 };
}

// Validation for the server. Returns an error string or null, matching the
// badPiece/badSurface convention. Out of range is REJECTED rather than
// clamped, for the same reason surfaces are: a level that plays differently
// from how it was authored is worse than one that fails to save with a reason.
export function badPlanet(o, at) {
  const pl = o && o.planet;
  if (pl == null) return null;
  if (typeof pl !== 'object' || Array.isArray(pl)) return `${at}: planet must be an object`;
  if (o.type !== 'ball') return `${at}: only a ball can be a planet`;
  // Keyed off what is PRESENT, not off `!= null` — JSON has no NaN, so a
  // number that failed to survive a round trip arrives as null, and `{pull:
  // null}` waved through as "absent, use the default" is exactly the silent
  // reading this whole family of checks exists to refuse (§16).
  for (const k of Object.keys(pl)) {
    if (k !== 'pull') return `${at}: planet has no '${String(k).slice(0, 20)}' setting`;
    if (!isNum(pl.pull)) return `${at}: planet.pull must be a number`;
    if (pl.pull < PULL_MIN || pl.pull > PULL_MAX) {
      return `${at}: planet.pull must be between ${PULL_MIN} and ${PULL_MAX} (got ${pl.pull})`;
    }
  }
  return null;
}
