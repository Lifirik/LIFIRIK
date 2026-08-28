// sizes.js — how small a level piece is allowed to get.
//
// Pure: no DOM, no node built-ins. The editor (game.js) and the FC importer
// (fcimport.js, which server.js also loads) must clamp to the *same* rule, so
// the rule lives on its own rather than in either of them.
//
// Two parts, because one number can't say what we mean:
//
//   every axis ≥ MIN_AXIS   AND   w × h ≥ MIN_AREA
//
// A per-axis floor alone can't tell a deliberate 1×10 blade (a lip, a wire, a
// thin shelf) from a 3×3 speck that reads as a rendering artifact. The area
// term draws that line: 1×10 and 2×5 are legal, 3×3 is not.
//
// The physics is comfortable far below this — at PPM 30 a 1 px plate is
// 0.033 m, and measured against the shipped binary: a non-bullet prop dropped
// onto a 1 px static plate at 2650 px/s still lands on it (the solver runs
// 32 sub-steps on light levels), a powered wheel rolls the length of one
// without dropping through, and a 0.011 kg sliver rests with zero jitter. So
// the floor here is about staying visible on screen and grabbable in the
// editor, not about what the solver can take. Two things do degrade below
// ~2 px, both cosmetic: corner rounding switches off (cornerRadiusOf clamps
// the radius to min(hw,hh), and sim/render drop to a sharp box under 1 px),
// and a sub-pixel piece shimmers when the camera is zoomed out.
export const MIN_AXIS = 1;        // px
export const MIN_AREA = 10;       // px² — 1×10, 2×5, 3×4 …

// A ball can't be a sliver, so the area rule would only license dust (area 10
// is r 1.78). It gets a radius floor instead, sized to sit just above MIN_AREA
// (r 2 → 12.6 px²).
export const MIN_BALL_R = 2;      // px

// The epsilon matters: the clamps below hit the area boundary by dividing, and
// (MIN_AREA / h) * h can land a few ulps short of MIN_AREA — a piece the editor
// just produced must never read as illegal.
export const pieceBoxLegal = (w, h) => w >= MIN_AXIS && h >= MIN_AXIS && w * h >= MIN_AREA - 1e-9;

// Editor clamp — the nearest legal box when a drag is making a piece smaller.
// The THIN axis stays thin: a blade dragged too short stops at the shortest
// legal blade instead of springing back into a square.
export function clampPieceBox(w, h) {
  let nw = Math.max(w || 0, MIN_AXIS);
  let nh = Math.max(h || 0, MIN_AXIS);
  if (nw * nh < MIN_AREA) {
    if (nw >= nh) nw = MIN_AREA / nh;
    else nh = MIN_AREA / nw;
  }
  return { w: nw, h: nh };
}

// Conversion clamp — same rule, but aspect ratio preserved, because an
// imported piece is a shape someone authored elsewhere rather than a live
// drag: a tiny square should come out a slightly bigger square, not a blade.
export function fitPieceBox(w, h) {
  let nw = Math.max(w || 0, MIN_AXIS);
  let nh = Math.max(h || 0, MIN_AXIS);
  if (nw * nh < MIN_AREA) {
    const f = Math.sqrt(MIN_AREA / (nw * nh));
    nw *= f; nh *= f;
  }
  return { w: nw, h: nh };
}

export const clampBallR = (r) => Math.max(r || 0, MIN_BALL_R);

// ---------------------------------------------------------------------------
// The wheel ladder (§4)
// ---------------------------------------------------------------------------
// A wheel is the one piece that is NOT freely resizable: three sizes, chosen by
// modifier at placement, never dragged afterwards. These numbers lived in
// util.js next to the pin formulas that consume them, and that is still where
// the editor, the renderer and the sim read them — util.js re-exports all three
// so nothing changed for them. They live HERE now because the FC importer has
// to land an imported wheel ON this ladder, and it cannot import util.js: it is
// the server's converter too, and util.js is DOM from its second line. Same
// reasoning as the size floors above — one set of numbers, in the one module
// every side of the game can reach.
// **A LIFIRIK pixel IS an FC unit** (2026-08-15, "I want to be a super set of
// FC. But exact in the ways we can be").
//
// The standard wheel was 30 px across against FC's 40, so the importer shrank
// every design by 0.75 to land one on the other, and gravity had to be 0.75 of
// FC's to keep the smaller world running at the same speed. That was
// self-consistent — dynamic similarity, measured at 1.4% over two seconds of
// falling (scripts/probe-fcref.mjs) — but it left a scale factor in the middle
// of everything, and an imported design permanently 3/4 the size it was drawn.
//
// So the wheel moves instead: 20 px of radius is FC's own wheel, read out of
// fcsim (`shape.wheel.radius = 20.0`) and confirmed from the other side by 51
// real wheels in 32 saved designs, every one of them 40 units across. With it
// the importer needs no scale at all, gravity is FC's own 10 m/s², and the
// motor laws land on FC exactly: `wheelMotorSpeed` gives a standard wheel
// MOTOR_SPEED itself, 5 rad/s, for a rim speed of 100 px/s — FC's number.
//
// The LADDER keeps its shape rather than its numbers. It doubles either side of
// the standard wheel, so FC's single wheel is the middle rung and LIFIRIK's two
// extra sizes sit around it — which is what "a superset" means here: nothing
// removed, FC's wheel exactly representable.
export const STD_WHEEL_R = 20;
export const WHEEL_SIZES = [10, 20, 40];
export const DEFAULT_WHEEL_R = STD_WHEEL_R;

// THE EDITOR'S TWO GRIDS, and they live here because they ARE the wheel. Three
// files derived the same pair from STD_WHEEL_R independently — game.js,
// levels.js and verify-editor.mjs — which is the shape of bug this file exists
// to stop: when the wheel moved 15 -> 20 the suite went on asserting a grid the
// game no longer had and reported 75 editor bugs that were not there
// (2026-08-15). game.js's own copy still called them 30 and 15 in a comment.
//
// The coarse one is a whole multiple of the fine one, so every coarse node is a
// fine node too and moving between the two grids never fights you.
export const GRID_STEP = STD_WHEEL_R * 2;      // 40 — Shift
export const GRID_FINE = STD_WHEEL_R;          // 20 — Alt (the finer one)

// WHICH RUNG A PLACEMENT TAKES, and it is a rule rather than a lookup because
// two things now have an opinion: the rung the editor is ARMED with, and the
// modifier held at the moment of the click.
//
// It used to be the modifier alone — Alt for small, Shift+Alt for large, and
// the standard wheel if you held nothing. That is a size you cannot see until
// you have already pressed the key, on the most overloaded key in the editor,
// and it has to be re-held for every single piece. `,` and `.` arm a rung
// instead: it persists, the info chip names it and the hover ghost draws it.
//
// The modifier still WINS, unchanged, for the reason the number keys still
// work beside the letters — nobody's hands have to be re-taught. Hold Alt and
// you get the small one whatever is armed, which is also what makes the pair
// useful together: arm the size you are laying a row of, reach for Alt on the
// one that is different.
export const RUNG_NAMES = ['small', 'standard', 'large'];
export const DEFAULT_RUNG = 1;

export function placeRung(armed, alt, shift) {
  if (alt) return shift ? WHEEL_SIZES.length - 1 : 0;
  return clampRung(armed);
}

// CLAMPED, not wrapped. A ladder with three rungs is short enough that wrapping
// would put you two rungs from where you thought one keypress had taken you,
// and the two keys are `,` and `.` — which wear `<` and `>`, and neither of
// those has ever meant "and then round again".
//
// `i == null` FIRST, because `+null` is 0 and 0 is a real rung: a stored value
// that had gone missing would have come back as `small` rather than as the
// default, silently, and the same trap catches '' and false. Anything that is
// not already a number is refused outright rather than coerced.
export const clampRung = (i) => (
  typeof i === 'number' && Number.isFinite(i)
    ? Math.max(0, Math.min(WHEEL_SIZES.length - 1, Math.round(i)))
    : DEFAULT_RUNG);

export const stepRung = (armed, dir) => clampRung(clampRung(armed) + Math.sign(dir));

// The radius that rung means. Named so nothing has to index WHEEL_SIZES with a
// number it worked out itself — which is how the placement ladder and the wheel
// ladder came apart the first time (see `_beginLevelPlacement`).
export const rungRadius = (i) => WHEEL_SIZES[clampRung(i)];
export const rungName = (i) => RUNG_NAMES[clampRung(i)];

// The nearest rung to a free radius — how a converted wheel gets a size it is
// allowed to have.
//
// Nearest in RATIO, not in pixels, because the ladder DOUBLES. Take 10.9 px:
// it is 45% above the small wheel and 27% below the standard one, so it is
// plainly a standard wheel that came out slightly small — but by pixel
// difference it is 3.4 px from the small one and 4.1 px from the standard, and
// the two rules disagree. Every ratio boundary sits at the geometric mean
// (10.6 and 21.2), which is the only split that treats a wheel the same
// whatever end of the ladder it is nearest.
export function snapWheelR(r) {
  const v = +r;
  if (!isFinite(v) || v <= 0) return STD_WHEEL_R;
  let best = WHEEL_SIZES[0];
  for (const s of WHEEL_SIZES) {
    if (Math.abs(Math.log(v / s)) < Math.abs(Math.log(v / best))) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// How heavy a stick may be (§5.3)
// ---------------------------------------------------------------------------
// `weight` multiplies a rod's density (wood 0.55, water 0.15), and the ceiling
// was 50 for the whole life of the project. It is 1000 now, on request — and
// the honest part of that is `ROD_WEIGHT_SAFE`, because the top of the range
// is not free.
//
// Measured against the pinned binary, on §15 gate 16's own two rigs (a light
// lever carrying the load across two legs, and a heavy stick dropped at
// 900 px/s onto a held one). Worst centreline gap, where 4.00 px = surfaces
// touching and the gate's bar is 2.5:
//
//   weight     1     50    100    250    500    1000   2000
//   crush   4.00   3.72   3.38   2.79   1.60    0.22   0.02
//   drop    held   held   held   held  THROUGH  held   held
//
// So up to 250 the guarantees §15 makes still hold. At 500 the load has sunk
// more than half way through a 4 px stick AND tunnels at speed; by 1000 it is
// visually straight through its supports. Contact stiffness cannot buy it
// back — at 1000 the gap is 1.31 px at 480 Hz and saturates at 2.23 px by
// 960 Hz, still under the bar, and raising CONTACT_HERTZ would change every
// recorded solve time (§5.8) to fix a case nothing shipped uses.
//
// **THE CEILING CAME DOWN TO 100** (2026-08-12, on request: *"Sticks down to
// sensible ×100 per stick"*). The table above is why it is the right number
// rather than a round one: ×100 measures 3.38 px of crush against a 2.5 px bar
// and holds a 900 px/s drop, so the whole of the range is now inside the
// guarantees §15 makes, with margin. Everything the old top end bought was a
// stick that sinks through what it rests on, and the honest answer to "make it
// heavier than that" is that the solver stops modelling it.
//
// One thing went with the ceiling: the toast that fired on the way past 250.
// It cannot fire now — no single stick can reach it — and a warning that
// cannot happen is worse than none.
export const ROD_WEIGHT_MIN = 1;
export const ROD_WEIGHT_MAX = 100;

// **What a PIN may carry, summed** (2026-08-12, on request: *"NRW badge becomes
// — No more than ×200 on a pin"*). A different question from the ceiling above
// and it always was: the ceiling is about one stick sinking through what it
// rests on, this is about how much a single joint is asked to hold. Counted per
// pin, so two heavy sticks bolted to the same point do not slip through
// separately — which is exactly the loophole the badge exists to close.
//
// 200 is two sticks at the new ceiling. That is deliberate: the badge should
// read as "nothing silly is bolted here", and a pair of maximum sticks is the
// most a reasonable machine puts on one pin.
export const PIN_WEIGHT_SAFE = 200;

// **A WEIGHTLESS water stick was tried on 2026-08-12 and cut the same day**, and
// the floor of 1 below is the whole of what is left of it. Recorded because the
// obvious reading of "allow 0 density" is wrong twice over, and the second
// reason is not something the next attempt would guess:
//
//  1. A zero-density shape gives the body zero mass, and Box2D reads zero mass
//     as INFINITE mass. A literal 0 does not make a stick weightless, it nails
//     it to the world — a lone one refused to fall (0.00 px against 198) and
//     froze a whole assembly hanging off it. Substituting a hair (0.001) fixes
//     that, and looks like the answer.
//  2. It is not the answer. A near-massless stick cannot act as a STRUCTURAL
//     link. Two props driven apart by their gravity dials and joined by one
//     tore the joint open by 1665 px, against 3 px for the same stick at ×1.
//     The error is proportional to 1/mass with no cliff — 0.5 → 0.77 px,
//     0.25 → 1.52, 0.1 → 3.75, 0.001 → 297 — so there is no epsilon that both
//     feels weightless and holds. Substeps do not rescue it either: 32 → 256,
//     eight times the cost, moved 1665 px to 1436.
//
// That is an iterative solver's honest limit at a 25,000:1 mass ratio, not a
// tuning miss. A rigid link between two heavy bodies wants to be a joint
// between THOSE TWO bodies, not two joints through a light one.
export const clampRodWeight = (w) => {
  const n = +w;
  if (!isFinite(n)) return ROD_WEIGHT_MIN;
  return n < ROD_WEIGHT_MIN ? ROD_WEIGHT_MIN : n > ROD_WEIGHT_MAX ? ROD_WEIGHT_MAX : n;
};

// The stick-weight slider's scale (§8.2), here rather than in game.js so a gate
// can reach it — the menu that uses it is DOM and the headless suite has none.
//
// **Logarithmic, matching the tint** (`weightFrac` in render.js): the range is
// 1–1000, so a linear slider spends nine tenths of its travel above ×100 where
// almost nothing is ever set, and cannot resolve the single steps at the bottom
// where nearly everything is. On a log scale each DOUBLING is an even step of
// travel, which is also how weight is actually reached (±1, ±10, ±100).
//
// Snapped so the slider can land on a round number rather than ×2.13: whole
// numbers below 10, fives below 100, twenty-fives above.
// **The ladder IS the list, one notch per rung** (2026-08-12). It used to be a
// hundred notches mapped through `pow` and then snapped to round numbers, which
// was right for a 1–1000 range: the rounding collapsed a few neighbours and the
// rest of the travel was live. At 1–100 the same arrangement is **72% dead** —
// the snapping only ever yields 28 distinct values, so 73 of the 101 notches
// repeat the one before them and the handle sticks as you drag.
//
// Measured across the alternatives before choosing: 100 notches → 28 distinct
// (28% live), 60 → 27 (44%), 40 → 24 (59%), 20 → 17 (81%, and it has lost
// seven rungs). Every notch count trades dead travel against reachable values,
// and indexing the rungs directly refuses the trade: **28 stops, 28 values,
// nothing repeated and nothing lost.**
//
// The spacing is still logarithmic — singles to 10, then fives — because that
// is where sticks actually get set. It is just written down instead of derived
// and re-rounded.
export const WEIGHT_STEPS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
];
export const WEIGHT_NOTCHES = WEIGHT_STEPS.length - 1;

// Nearest by RATIO rather than by difference: the ladder is geometric, so a
// hand-edited ×12 belongs next to ×10 rather than ×15 (they are 1.2 and 1.25
// away in ratio, but 2 and 3 away in difference).
export const weightNotch = (w) => {
  const v = clampRodWeight(w);
  let best = 0, bestErr = Infinity;
  WEIGHT_STEPS.forEach((s, i) => {
    const err = Math.abs(Math.log(s / v));
    if (err < bestErr) { bestErr = err; best = i; }
  });
  return best;
};

export const weightAtNotch = (n) =>
  WEIGHT_STEPS[Math.min(Math.max(Math.round(+n || 0), 0), WEIGHT_NOTCHES)];


// ---------- the scenery layer's own two dials (§10.5) ----------
//
// `BACKDROP_SCALE` (0.8) and `BACKDROP_ALPHA` (0.55) in render.js are the
// DEFAULTS, and they are now the defaults of an authored per-level value
// rather than the only answer. A level that wants its background closer and
// bolder, or further off and fainter, says so and the setting is saved with it.
//
// **The decision lives here, not in the slider.** A rule that only exists
// inside the DOM handler that draws it is a rule no gate can reach — the same
// reason `weightAtNotch` and `initialSnapMode` moved out of the menus and the
// constructor. The slider reads these; so does the renderer; so does the
// server when it validates a save.
export const BACK_SCALE_MIN = 0.2, BACK_SCALE_MAX = 1;
export const BACK_ALPHA_MIN = 0, BACK_ALPHA_MAX = 1;

// The ceiling on scale is 1 and it is load-bearing: at 1 the scenery layer sits
// in the play plane exactly, and above it the layer would reach the player
// MAGNIFIED — parallax the wrong way round, and a fence (§10.7) computed from
// `PLAY_BOUND / scale` that grows instead of shrinking. 0.2 at the far end is
// where a whole level compresses to a fifth and reads as horizon.
//
// **This dial is DEPTH, and since 2026-08-05 it is the parallax factor too.**
// The layer is scaled about the camera (`drawBackLevel`'s `pivot`), so it drifts
// against the world at exactly this number — and it has to be this number,
// because apparent size and apparent motion both go as 1/distance. A layer drawn
// at 0.8 that drifted at some other rate would be claiming two distances at
// once. So parallax needed no third dial: shrink, fade and drift all come off
// the two values a level already stores. At 1 there is no shrink AND no drift,
// which is the same statement twice — the layer is in the play plane.
// `n == null` is checked BEFORE Number(), because `Number(null)` is 0 and 0 is
// a legitimate fade. Without the guard an explicit null — which is what a
// round trip through JSON can leave behind — clamped to the minimum instead of
// reading as "not set", so a level that never chose a shrink came back at 0.2.
const dial = (n, lo, hi) => {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!isFinite(v)) return null;
  return Math.min(Math.max(v, lo), hi);
};
export function clampBackScale(n) { return dial(n, BACK_SCALE_MIN, BACK_SCALE_MAX); }
export function clampBackAlpha(n) { return dial(n, BACK_ALPHA_MIN, BACK_ALPHA_MAX); }

// **Resolve, don't default at the call site.** `null` from the clamps above
// means "the level did not say", which is not the same as 0 — an alpha of 0 is
// a deliberate invisible backdrop and must survive a round trip, while a
// missing one has to fall back. Every reader goes through these two so a level
// authored before the dials existed draws exactly as it always did.
export function backScaleOf(level, dflt) {
  const v = clampBackScale(level?.backScale);
  return v == null ? dflt : v;
}
export function backAlphaOf(level, dflt) {
  const v = clampBackAlpha(level?.backAlpha);
  return v == null ? dflt : v;
}

// ---------- wire bounds (§14) ----------
//
// Everything below exists because `num()` alone — "is it a finite number" —
// was the whole of what the server asked of a magnitude, and finite is not
// the same as sane. The solver's currency is float32: a coordinate that
// survives JSON at 1e40 px overflows to Infinity at the wasm boundary and
// every pose in the level is NaN one step later, for everyone who opens it.
// Density is worse — it multiplies into mass, so 1e300 is NaN immediately.
// The editor can author none of these (the fence is ±4020, the density dial
// stops at 8); these bounds are for the doors hand-written JSON comes
// through, and they live HERE so the server, the sim and a gate all read the
// one answer (same reasoning as the size floors at the top of this file).
//
// COORD_MAX is deliberately absurd — 250× the fence, 1000× the biggest
// coordinate in the corpus when it landed (1126 px) — because its job is to
// refuse overflow, not to police taste. Same for SPEED_MAX (corpus max 246).
export const COORD_MAX = 1e6;     // px — positions, sizes, waypoints, pins
export const SPEED_MAX = 1e5;     // px/s — path speed and spinSpeed
export const PATH_MAX_PTS = 24;   // waypoints — restated by the server since §9.1

// ---------- a prop's texture vocabulary (2026-08-12) ----------
//
// Sixteen, and a DIFFERENT set from terrain's on purpose — the whole point of
// them is being unmistakable for a hillside (render.js `PROP_TEX` has the
// palettes and motifs, and why each one is what it is).
//
// **The names live HERE and not in render.js** for the same reason the size
// floors and the density clamp do: the server has to validate them, and the
// server has no business importing the renderer. render.js keeps the LOOKS,
// this keeps the vocabulary, and §15 asserts the two lists are identical — a
// texture that draws but cannot be saved, or saves but cannot draw, is exactly
// the kind of half-wired feature that split ownership produces.
//
// Order is the picker's row order, not alphabetical: the loud flat patterns
// first, the materials next, the three ANIMATED ones last, so the grid reads
// as a progression rather than a bag.
export const PROP_TEXTURES = [
  'candy', 'hazard', 'chevron', 'polka', 'checker', 'scales', 'denim', 'carbon',
  'marble', 'bubbles', 'citrus', 'studs', 'stars',
  'circuit', 'plasma', 'holo',
];

// The density range is the EDITOR'S own: its dial snaps 0.25–8 across a clamp
// of 0.01–1000 (densityNotch in game.js reads these). Out of range is
// REJECTED at the server like a surface or a planet (badSurface/badPlanet),
// and CLAMPED at the sim like a rod weight (clampRodWeight) — belt and
// braces, because sim.js must be safe on its own against a hand-loaded LOCAL
// level that never met the server.
export const DENSITY_MIN = 0.01;
export const DENSITY_MAX = 1000;
export const clampDensity = (d) => {
  const n = +d;
  if (!isFinite(n)) return 1;
  return Math.min(Math.max(n, DENSITY_MIN), DENSITY_MAX);
};

// ---------- "is this piece inside that zone" (§7.2) ----------
//
// The containment primitives live HERE, with the size floors and the caps, for
// the same reason those do: more than one door has to give the same answer.
// util.js re-exports all three, so the editor, the clamp and every existing
// caller are unchanged — but `fcimport.js` can now reach them, and it must.
// The importer decides which of a paste's pieces are somebody's SOLUTION by
// asking whether they are inside the build area, and if that question had a
// second implementation it would eventually answer differently from the editor
// enforcing the same boundary a minute later, on the same level.
//
// (They were moved out of util.js on 2026-08-11 and are otherwise untouched.
// fcimport.js is imported by server.js and util.js is not; dragging three
// thousand lines of client code into the server to reach eleven lines of
// geometry is the trade this avoids.)

export function rectCorners(r) {
  const hw = r.w / 2, hh = r.h / 2, a = r.angle || 0;
  const c = Math.cos(a), s = Math.sin(a);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
    x: r.x + dx * c - dy * s,
    y: r.y + dx * s + dy * c,
  }));
}

export function boundsCorners(b) {
  return [
    { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY },
  ];
}

// **A bounds may carry its own true shape**, and when it does, every rule uses
// that instead of the box:
//   `r`    — a circle of that radius about the bounds' centre (wheels, balls)
//   `pts`  — the real outline (a tilted crate's four true corners)
// `footprintOf` normalises the two into one `{ pts, r }`.
//
// This matters because a box is a bad stand-in for a piece the moment the axes
// differ. A circle's AABB is a square, which sticks out past the circle by 41%
// of the radius at the corners; a tilted crate's AABB can be half again its
// size. Testing those boxes against a TILTED zone holds a big wheel much
// further from the edge than a small one and keeps a rotated crate absurdly far
// from every edge — both visible immediately, and neither the rule anyone means.
export function footprintOf(bounds) {
  if (bounds.pts?.length) return { pts: bounds.pts, r: bounds.r || 0 };
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  if (bounds.r != null) return { pts: [{ x: cx, y: cy }], r: bounds.r };
  return { pts: boundsCorners(bounds), r: 0 };
}

// Is this footprint fully inside one (possibly rotated) rect? Exact for both
// carried shapes: a circle is its centre held `r` in from every edge, a polygon
// is every vertex inside. Measured in the rect's own frame.
export function footprintInRect(fp, rect, slack = 0) {
  const hw = rect.w / 2 + slack - fp.r, hh = rect.h / 2 + slack - fp.r;
  if (hw < 0 || hh < 0) return false;             // the piece cannot fit at all
  const a = rect.angle || 0;
  if (!a) return fp.pts.every(p => Math.abs(p.x - rect.x) <= hw && Math.abs(p.y - rect.y) <= hh);
  const c = Math.cos(a), s = Math.sin(a);
  return fp.pts.every((p) => {
    const dx = p.x - rect.x, dy = p.y - rect.y;
    return Math.abs(dx * c + dy * s) <= hw && Math.abs(-dx * s + dy * c) <= hh;
  });
}

// Validation for a motion path, in the badSurface/badPlanet convention:
// an error string, or null. Shared by terrain paths, group paths and label
// paths, which until this existed were checked three different amounts in
// three places (labels: numbers; terrain and groups: length only — so a
// hand-written NaN waypoint or speed reached makeMotion, poisoned the
// mover's offset, and went into b2Body_SetTargetTransform as NaN).
//
// `mode`, `spin`, `spinStop` and `orient` are deliberately NOT validated:
// mode falls back to 'once' on any junk, and the other three are read for
// truthiness or sign alone — no value of them can produce a NaN.
export function badPath(p, at) {
  if (p == null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) return `${at}: bad path`;
  if (p.pts != null) {
    if (!Array.isArray(p.pts)) return `${at}: path pts must be an array`;
    if (p.pts.length > PATH_MAX_PTS) return `path too long (${PATH_MAX_PTS} waypoints max)`;
    for (const q of p.pts) {
      if (!q || typeof q.x !== 'number' || !isFinite(q.x) || typeof q.y !== 'number' || !isFinite(q.y)) {
        return `${at}: bad path waypoint`;
      }
      if (Math.abs(q.x) > COORD_MAX || Math.abs(q.y) > COORD_MAX) {
        return `${at}: path waypoint out of range (±${COORD_MAX})`;
      }
    }
  }
  for (const k of ['speed', 'spinSpeed']) {
    if (p[k] == null) continue;
    if (typeof p[k] !== 'number' || !isFinite(p[k])) return `${at}: path ${k} must be a number`;
    if (Math.abs(p[k]) > SPEED_MAX) return `${at}: path ${k} out of range (±${SPEED_MAX})`;
  }
  // The spin centre (§9.1) — same finite-and-bounded read a waypoint gets,
  // because it feeds the same pose arithmetic a waypoint does.
  if (p.pivot != null) {
    const v = p.pivot;
    if (typeof v !== 'object' || Array.isArray(v)
      || typeof v.x !== 'number' || !isFinite(v.x) || typeof v.y !== 'number' || !isFinite(v.y)) {
      return `${at}: bad spin centre`;
    }
    if (Math.abs(v.x) > COORD_MAX || Math.abs(v.y) > COORD_MAX) {
      return `${at}: spin centre out of range (±${COORD_MAX})`;
    }
  }
  return null;
}

// Validation for a MACHINE part — a level's fixedParts and a solve's replayed
// design, which until this existed were counted and never read: 1000 parts,
// 320 KB, and any of them could be `{t:'wheel'}` with no radius at all, which
// is NaN/PPM into b2Circle and NaN poses for everyone who watches the replay.
//
// The kind lists are strict for the same reason a piece's shape is ("required,
// not defaulted" — server.js PIECE_KINDS): an unknown wheel kind is not inert,
// it lands in the `kind !== 'free'` branch and becomes a POWERED wheel, so a
// typo drives a motor the author never placed. The corpus was scanned before
// this landed: every stored part is exactly {wheel, rod} × the five kinds.
//
// `weight` is only required to be a finite number here — its range belongs to
// clampRodWeight, which already owns it at both the editor and the sim, and a
// hand-written 5000 has always meant "1000, the hard way".
export function badMachinePart(p, at) {
  const fin = (v) => typeof v === 'number' && isFinite(v);
  const inRange = (v) => Math.abs(v) <= COORD_MAX;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return `${at} is not a machine part`;
  if (p.t === 'wheel') {
    if (!['free', 'cw', 'ccw'].includes(p.kind)) return `${at}: wheel kind must be free, cw or ccw`;
    if (!fin(p.x) || !fin(p.y)) return `${at}: x and y must be numbers`;
    if (!inRange(p.x) || !inRange(p.y)) return `${at}: x and y must be within ±${COORD_MAX}`;
    if (!fin(p.r) || !(p.r > 0) || p.r > COORD_MAX) return `${at}: r must be a positive number up to ${COORD_MAX}`;
  } else if (p.t === 'rod') {
    // `ghost` joined on 2026-08-10: import-only for now (no tool places one),
    // but the validator is what a hand-written level and an FC Gold paste both
    // arrive through, so it has to admit the kind before anything can carry it.
    if (!['wood', 'water', 'ghost'].includes(p.kind)) return `${at}: rod kind must be wood, water or ghost`;
    for (const k of ['x1', 'y1', 'x2', 'y2']) {
      if (!fin(p[k])) return `${at}: ${k} must be a number`;
      if (!inRange(p[k])) return `${at}: ${k} must be within ±${COORD_MAX}`;
    }
    if (p.weight != null && !fin(p.weight)) return `${at}: weight must be a number`;
  } else {
    return `${at}: t must be 'wheel' or 'rod'`;
  }
  return null;
}
