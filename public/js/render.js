// render.js — all canvas drawing: textures, parts, overlays, thumbnails (§10).
// Everything draws in world space unless noted; pins are world-space sized
// (they're part of the piece — screen-constant pins look wrong at every zoom
// but one).

import {
 seedRand, cornerRadiusOf, wheelPinOffsets, wheelRings, jointKey, goalPinOffsets, goalRings, propPins, clamp, loosePinOffsets,
 rectCorners, GOAL_PIN_INSET, isPaint, paintAnchors, segControls, paintOutlineOf, polyBounds,
 polyArea2, ropeRuns, occupiedPins, pinOwnerCounts, ringSlots, STD_WHEEL_R, SNAP_PIN_DOT, setBadgeArt,
 CELL_WON, SWEEP_GRID_MAJOR,
} from './util.js';
import { terrainCanMove, PPM } from './sim.js';
// straight from i18n.js, not via util.js: util.js imports from THIS file's
// consumers nowhere, but render is imported by util's own importers and the
// standalone module keeps the graph flat. Canvas text never meets the DOM
// funnels, so the two zone words translate here.
import { t, tf } from './i18n.js';
import { surfaceOf } from './surfaces.js';
import { ROD_WEIGHT_MIN, ROD_WEIGHT_MAX, backScaleOf, backAlphaOf } from './sizes.js';
import { planetsOf, downAt, pieceGravityOf, PIECE_GRAVITY_DEFAULT, PIECE_GRAVITY_MAX } from './gravity.js';
import {
 TEXT_LINE_H, textFontSpec, textFontKey, textSizeOf, textAlignOf, textLines,
 textColourHex, haloFor, textZOf, TEXT_Z_DEFAULT,
} from './textmodel.js';

// ---------- palette (§10.1) ----------
// NOTE: the violet accent is historically stored in a variable named --teal —
// do not "fix" the name.

export const COLORS = {
 accent: '#6558e6',
 ink: '#232a35',
 skyTop: '#ccd7f6',
 skyBot: '#fdebd8',
 wheelCw: '#ffa62b', // R wheel, rolls right
 wheelCcw: '#54a0ff', // L wheel, rolls left
 wheelFree: '#cbd3e1', // F wheel, unpowered
 woodEdge: '#7d5a38',
 woodCore: '#a87b4f',
 water: '#48c6ef',
 // A ghost is a water stick that has let go of the world, so it is water's
 // hue drained of it — cold, pale, and never mistaken for the bright one.
 ghost: '#9fb4c9',
 // **Green, from 2026-08-12** (on request), and chosen as a like-for-like swap
 // rather than a new colour: the pink it replaces measured luminance 153 and
 // its edge 114, and these measure 157 and 114 — the same weight on the page,
 // rotated round the wheel. Hue 150° against the terrain greens' 98–113°, and
 // 80% saturation against their 28–40%, which is what actually keeps a goal
 // piece off the grass it is usually standing on. **Saturation is the
 // separator, not brightness**: at density 4 the piece measures 116 against
 // grass's 116 exactly, and at density 8 it is 96 against moss's 92. Its
 // outline stays clear of both at every step, which is what carries it there.
 goal: '#1ae680',
 goalDark: '#13a65c',
 prop: '#e0a458',
 propDark: '#a9763b',
 // **An FC ghost line — a zero-width level rect** (2026-08-18:
 // "colour matched to props — a slightly different [orange] to alert to the
 // fact they allow rods through"). It is FC's degenerate box: static, boxes
 // and sticks pass through it, round things ride on it. Terrain in the data
 // (it never moves), a prop's family by eye — and one step brighter and more
 // saturated than a prop's tan, so the difference reads before the surprise.
 ghostLine: '#f4ae3c',
 ghostLineDark: '#a86f1e',
 pinDark: '#232a35',
 pinLight: '#ffffff',
 // The core of a pin with something ON it (§6.3). Not a new colour: it is the
 // gold a loose level pin has always had, for the same reason — that pin is
 // holding something.
 pinLive: '#ffd76a',
};

// ---------- THE LIGHT (§10.1) ----------
//
// One vector, stated once, and every bevel, rim, crescent and cast shadow in
// the game derives from it. Before this there was no light direction at all:
// `strokeThenFill` laid ONE flat `spec.edge` all the way round a slab, so the
// rim was the same value on top of a ledge as underneath its overhang, and
// nothing in the picture said which way was up.
//
// (x, y) is the direction the light TRAVELS, in world space — down and to the
// right, so a surface facing up-left is lit and one facing down-right is not.
// 30° off vertical: the elevation is what grass answers to and the azimuth is
// what gives a wall a lit side, and there is no third constraint on it.
//
// `key` is the sky's own top colour warmed; `bounce` is skyBot verbatim, which
// is the warm ground light already in the backdrop gradient; `occ` is the ink
// every shadow in the game is mixed toward. Deriving two of the three from the
// sky is deliberate — it is what stops the shading and the backdrop being two
// opinions about the same weather.
export const LIGHT = {
 x: 0.5, y: 0.8660254,
 key: '#fff2d6',
 bounce: COLORS.skyBot,
 occ: '#0a1220',
};

// A blend between two colours. `shade` only moves toward black or white, which
// is enough for a tint of one hue and not enough for a lit edge — a highlight
// is the material carried toward the KEY, not toward paper.
//
// **It takes `rgb(...)` as well as `#rrggbb`, and that is not politeness.**
// mixHex RETURNS `rgb(...)`, so the moment one result is fed into another —
// which is exactly what a ridge does, lifting its own derived band colour
// toward white — a hex-only parser produces `rgb(NaN,NaN,NaN)`. Canvas does
// not throw on an invalid fillStyle; it silently keeps the previous one. The
// symptom was three distant hills rendering as three near-black hairlines,
// and it took a column of getImageData to see that the "crest" was whatever
// colour had been set last rather than a colour of its own.
function rgbOf(c) {
 if (c[0] === '#') {
 const n = parseInt(c.slice(1), 16);
 return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
 }
 const m = /(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)\D+(-?\d+(?:\.\d+)?)/.exec(c);
 return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
export function mixHex(a, b, t) {
 const [ar, ag, ab] = rgbOf(a), [br, bg, bb] = rgbOf(b);
 return `rgb(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)})`;
}

export function shade(hex, f) {
 // f < 1 darkens toward black, f > 1 lightens toward white
 const n = parseInt(hex.slice(1), 16);
 let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
 if (f <= 1) { r *= f; g *= f; b *= f; }
 else { const t = f - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
 return `rgb(${Math.round(clamp(r, 0, 255))},${Math.round(clamp(g, 0, 255))},${Math.round(clamp(b, 0, 255))})`;
}

// How heavy a rod reads, 0..1, for everything that tints one (scroll on a
// selected rod, §8.2). **Logarithmic, because the range is now 1–1000.** It was
// linear over 1–50 and saturated at ×38, so with a twenty-times-wider ceiling
// every stick from ×38 up would have looked identical — the exact complaint the
// water-rod comment below already records at the old range. On a log scale each
// DOUBLING of weight is an even step of darkness, which is how weight is
// actually reached (±1, ±10, ±100).
//
// The visible cost, stated plainly: full darkness now means ×1000 rather than
// ×38, so an existing ×50 stick draws paler than it used to. Nothing simulates
// differently — this is the only thing that changed about it.
export function weightFrac(weight) {
 // `?? 1`, not `|| 1`: a water stick may now be weightless and 0 is falsy, so
 // `||` would have drawn every weightless stick at the ×1 tint. The clamp's
 // own floor still keeps the log scale sane — a 0 tints as the lightest stick
 // there is, which is exactly what it is.
 const w = clamp(weight ?? 1, ROD_WEIGHT_MIN, ROD_WEIGHT_MAX);
 return Math.log(w / ROD_WEIGHT_MIN) / Math.log(ROD_WEIGHT_MAX / ROD_WEIGHT_MIN);
}

export function weightShade(hex, weight) {
 return shade(hex, 1 - 0.45 * weightFrac(weight));
}

// Props and goal pieces darken as they get denser and pale as they get
// lighter, so mass is legible at a glance without opening anything. The
// editor's ladder is doublings (0.25 … 8), so the shade steps with log2 —
// one even 13% step per notch, symmetric about the default 1, which is left
// exactly as authored. Clamped to the ladder's range so a hand-edited density
// can't wash a piece out to white or black.
export function densityShade(hex, density) {
 const d = clamp(+density || 1, 0.25, 8);
 return shade(hex, 1 - clamp(Math.log2(d), -2, 3) * 0.13);
}

// **The outline every piece wears: 2.2 px, flat, at every size and shape**
// (§10.1). Props were flattened to it on 2026-08-07 and goal pieces joined them
// on 2026-08-12 — the crate came off a flat 2.4 and the BALL off
// `max(2, r · 0.13)`, which is the very rule props had been rescued from and
// which nobody had noticed was still living in the goal family. Its floor hid
// it up to r 15.4, i.e. exactly up to the default size: a goal ball only ever
// looked wrong once somebody made one bigger, where it reached 3.9 px at r 30
// and 13 at r 100, beside a crate's 2.4.
//
// An outline is a drawing CONVENTION, not a property of the object — which is
// the same reason the groove is one width on every wheel (§6.1). A tyre may
// scale with its wheel because a tyre is a real part; a line drawn around a
// thing to say where it ends may not.
//
// **Flat across PIECES, not across world scales** (2026-08-15). Path B made a
// LIFIRIK pixel an FC unit, so every piece this line is drawn around got 4/3
// bigger while the line did not — and a detent, which did scale, came out
// thicker than the outline enclosing it. The rule the paragraph above is
// defending is "one width whatever the piece is", and that survives; the number
// defending it is a world length like any other.
export const PIECE_OUTLINE = STD_WHEEL_R * (2.2 / 15); // 2.93 (was 2.2 at r 15)
// Kept because `PROP_OUTLINE` is the name it has been imported under, and
// because widening a concept without renaming the old door is what `piecePins`
// already does beside `propPins` for the same reason.
export { PIECE_OUTLINE as PROP_OUTLINE };

export function wheelFill(kind) {
 return kind === 'cw' ? COLORS.wheelCw : kind === 'ccw' ? COLORS.wheelCcw : COLORS.wheelFree;
}

// ---------- pins ----------

// World-space and the same at every radius (§6). Named because the wheel's
// direction arrows are sized to clear a pin dot rather than a pin coordinate,
// and a dot that grew while the arrow's clearance didn't would put the arrow
// under the pins.
// One constant with two names: the editor's snap floor (util.js) and the dot it
// is aiming at are the same number by rule, so they are the same binding now
// rather than two literals and a gate hoping they stay level.
export const PIN_DOT_R = SNAP_PIN_DOT; // 2.4 (was 1.8 at r 15 — Path B)

// **An OCCUPIED pin is drawn bigger, with a gold core** (2026-08-12, §6.3): a
// pin with something on it is a different thing from a place where something
// could go, and until now they were the same mark. Wider *and* recoloured
// because either alone is missable — at 1× a standard wheel's pin is 3.6 px
// across, and a 0.8 px core changing colour inside it is not a signal.
//
// Every piece that draws a pin asks the same question through here — a rod
// end, a crate corner, a prop's mount and a wheel slot all answer it the same
// way — so `occupied` (util.js) is threaded through the piece painters'
// `opts` rather than being worked out per piece.
export const PIN_DOT_LIVE_R = STD_WHEEL_R * (2.3 / 15); // 3.07 (was 2.3 at r 15)
export const pinIsLive = (occupied, x, y) => !!occupied && occupied.has(jointKey(x, y));

// `rad` overrides the dot's size, and only drawRods passes it: a pin where
// three or more sticks meet is drawn as a bigger bolt, because how many meet
// there is a fact the builder wants and had no way to see. Left at 0 the size
// is exactly what it has always been, which is what every other caller — and
// every gate that measures a bead by its radius — relies on.
//
// **…and a pin where FIVE or more meet is a HEX NUT** (2026-08-24, on request:
// *"Gold small, medium and hex"*): the hardware ladder's top rung is a shape,
// not another size, because past medium the sizes stop being tellable apart
// and shape reads before brightness — the same law as the family pill and the
// hatched matrix cell. Flat-topped and unrotated: pins do not turn.
// The core's reach inside its dot (2026-08-24, from a screenshot: "the
// yellow bit to be a hexagon. And the border is still too thick… for the
// normal pin unconnected a thinner border more white part"): a hex nut's
// gold core is the NUT'S OWN SHAPE at most of its size, and the plain
// unconnected dot shows more light than dark. Fractions of the dot rather
// than px, so every size on the bolt ladder keeps the same rim.
// **The rim is a WIDTH, not a fraction** (2026-08-24, "does the triangle
// have the correct border? Looks thin?" — it was: shrinking a polygon to
// 0.72 of its circumradius leaves an edge-to-edge border of 0.28·R·cos(π/n),
// so the triangle's rim ran 42% thinner than the hexagon's). The family
// reference is the hexagon's rim as approved; every shape's core is inset by
// that same distance along its own apothem, and the circle wears it too.
const POLY_RIM = 0.28 * Math.cos(Math.PI / 6); // of the bolt's radius
const coreR = (r, sides) => r * (1 - POLY_RIM / (sides ? Math.cos(Math.PI / sides) : 1));
const PIN_CORE_IDLE = 1.45; // light core of an unconnected dot — thin rim

// Which way each nut sits ("pins do not turn" — one fixed pose per shape):
// triangle and pentagon point UP, the square sits on its flat, the hexagon
// keeps its flat top. A phase per side count, nothing else.
const POLY_PHASE = { 3: -Math.PI / 2, 4: Math.PI / 4, 5: -Math.PI / 2, 6: Math.PI / 6 };

// `shape` is the nut's SIDE COUNT (3..6), or falsy for the round dot. The
// old boolean `hex` still answers as 6, so nothing speaking the old
// signature draws differently than it did.
export function drawPinDot(ctx, x, y, live = false, rad = 0, shape = 0) {
 const sides = shape === true ? 6 : (shape | 0);
 const polyPath = (r) => {
 ctx.beginPath();
 const phase = POLY_PHASE[sides] ?? 0;
 for (let i = 0; i < sides; i++) {
 const a = phase + i * (2 * Math.PI / sides);
 const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
 i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
 }
 ctx.closePath();
 };
 const outer = rad || (live ? PIN_DOT_LIVE_R : PIN_DOT_R);
 if (sides >= 3 && rad) polyPath(rad);
 else {
 ctx.beginPath();
 ctx.arc(x, y, outer, 0, Math.PI * 2);
 }
 ctx.fillStyle = COLORS.pinDark;
 ctx.fill();
 // the core matches its bolt, at one rim width for the whole family ("the
 // circle's border is too much… please match to the others"); only the
 // unconnected dot keeps its own lighter rule
 if (sides >= 3 && rad) polyPath(coreR(rad, sides));
 else {
 ctx.beginPath();
 ctx.arc(x, y, live ? coreR(outer, 0) : PIN_CORE_IDLE * (rad ? rad / PIN_DOT_R : 1), 0, Math.PI * 2);
 }
 ctx.fillStyle = live ? COLORS.pinLive : COLORS.pinLight;
 ctx.fill();
}

// The `groove` style's mark (2026-08-11, §6.1): one machined race per ring,
// with a detent at every slot on it. **Nothing about where a rod attaches
// changes** — the race is drawn on the ring `wheelRings` already returns, and
// the detents ARE the slots — but a wheel at rest reads as a part with a
// channel cut in it rather than as a disc wearing four beads.
//
// **One width, everywhere: 1.8** (2026-08-12, on request — "it gets thinner the
// bigger the wheel gets; I'd like it always the same as the big wheel's").
//
// It used to be 2.6 with a clamp for rings that had no room, and the only ring
// that ever hit the clamp was the LARGE wheel's outer one — 27, three px inside
// a 4.2 px rim stroke, leaving 1.8 of clear face. So the biggest wheel wore the
// thinnest groove, which is exactly backwards from how it reads: that ring is
// the most prominent one in the game.
//
// 1.8 is therefore not a taste: it is **the tightest room any ring in the game
// has**, taken as the width of all of them. Gated against the geometry rather
// than typed and trusted (verify-pins gate 7), so if a wheel size or an inset
// ever moves, the gate says so instead of a groove quietly crossing a rim.
//
// The face rescaled with the wheel on 2026-08-15 (Path B), so the numbers in
// the paragraphs above are the old ones — every length on this face is 4/3 of
// what it reads, and every RATIO between them is untouched. Derived from
// STD_WHEEL_R rather than retyped, which is what the gate above is for.
export const GROOVE_W = STD_WHEEL_R * 0.12; // 2.4 (was 1.8 at r 15)
// **The detent, made easier to see** (2026-08-12, on request). It was a 1.2 bar
// exactly as long as the channel was wide, which at 1.8 made it a 1.5:1 stub
// sitting INSIDE the groove — a mark you had to look for. It is now wider, and
// it CROSSES the channel's walls rather than stopping at them: breaking the
// groove's line either side is what the eye actually catches, and it turns a
// 1.2×1.8 mark into a 2.0×3.4 one, near three times the ink.
//
// The overhang is allowed to touch the rim on the large wheel's outer ring,
// where there is no clear face outside the channel. That is not a lapse: the
// `dots` beads at that same radius have always overlapped the rim by 0.9, so a
// tick doing the same is the art already there rather than a new liberty.
export const DETENT_W = STD_WHEEL_R * (2.0 / 15); // 2.667 (was 2.0 at r 15)
export const DETENT_OVER = STD_WHEEL_R * (0.8 / 15); // 1.067 (was 0.8)
// How much longer slot 0's detent is than its neighbours — the index mark that
// gives a wheel a period of one revolution (see drawGroove). A multiplier on
// the reach, so it is the same mark at every radius and in both pin styles.
export const INDEX_LEN = 2.4;
// The rim stroke, named because three things are measured off it now: its own
// width, the arrow shaft's, and how much face is left for a groove inside it.
export const rimWidthOf = (r) => Math.max(STD_WHEEL_R / 6, r * 0.14); // floor 3.33 (was 2.5)
// How wide the channel on `rad` is: ONE width, everywhere (2026-08-17). The
// old clamp measured the face OUTSIDE a ring against the rim, and the rim
// ring has none — it draws INWARD instead (see drawGroove), so the clamp's
// question no longer exists. The signature stays so no call site moves.
export const grooveWidth = (rad, r) => GROOVE_W;

// **The channel 30% darker, and the detents 30% darker twice** (2026-08-12, on
// request, in that order — the second step was for the ticks alone). Written as
// the arithmetic rather than as the answer, because each was asked for as a
// step from where it stood, and the chain is what a later reader needs to know
// before taking another one.
//
// `shade` multiplies the fill, so a factor IS a relative luminance: these can
// be compared with each other and with the rim's 0.62 directly, and what has to
// hold is not a value but an ORDER with daylight in it — detent on channel,
// channel on the rim it is cut beside, rim on the face (verify-pins gate 7).
// The detent is now within a shade of the ink a pin is drawn in, which is the
// floor: past that a tick stops being a mark on the wheel and becomes a hole.
export const GROOVE_INK = 0.5 * 0.7; // was 0.5
export const DETENT_INK = 0.34 * 0.7 * 0.7; // was 0.34, then 0.238

// The width is passed in rather than worked out here: a wheel's is clamped by
// the rim it is cut beside (`grooveWidth`), and a goal piece's never is.
//
// **A ring ON THE PIECE'S EDGE draws inward** (2026-08-17, with the lattice
// moving to FC's rim spokes): the SLOT stays exactly at `rad` — that is the
// joint, and it does not move — but the channel is cut just inside it and the
// detents run INWARD from the rim, pointing at the centre, so the machining
// stays on the face instead of hanging half off the piece. `edge` is the
// piece's own radius; a ring within a groove-width of it takes this treatment
// and every inner ring draws exactly as it always has.
function drawGroove(ctx, { rad, n }, w, fill, edge = Infinity) {
 const onEdge = rad > edge - w;
 const race = onEdge ? rad - w / 2 : rad; // channel centreline
 ctx.beginPath();
 ctx.arc(0, 0, race, 0, Math.PI * 2);
 ctx.lineWidth = w;
 ctx.strokeStyle = shade(fill, GROOVE_INK);
 ctx.stroke();
 // The lit outer wall — one hairline, and the whole of what makes the channel
 // read as cut INTO the face rather than drawn on top of it.
 ctx.beginPath();
 ctx.arc(0, 0, race + w / 2, 0, Math.PI * 2);
 ctx.lineWidth = 0.7;
 ctx.strokeStyle = shade(fill, 1.3);
 ctx.stroke();
 // The slots, as detents. One path and one stroke for the whole ring: an
 // edge ring's detents run from the rim inward; an inner ring's cross the
 // channel symmetrically, exactly as before.
 // **Slot 0 is the INDEX, and it is keyed by LENGTH** (2026-08-23). A wheel
 // is very nearly rotationally symmetric — the letters are a 2-fold pair, the
 // arrows a 2-fold pair, this ring 4-, 8- or 16-fold — so nothing on it has a
 // period of one revolution and a spinning wheel is very nearly the same
 // picture frame to frame. Measured on the shipped constants: at MOTOR_SPEED
 // 5 rad/s a standard wheel turns 4.77° per 60 Hz frame, which is 1.67 px of
 // travel at the rim — under what a periodic texture needs to read as motion,
 // while the detent ring's own period is 45° and nine frames away.
 //
 // One mark with a period of ONE revolution fixes it, and orientation is the
 // channel to spend it in: the discrimination threshold is about a degree,
 // against a full cycle for a texture. Every ring keys its own slot 0 and
 // they all sit at angle 0, so they line up into a single radial index.
 //
 // Length, not width, and not a second stroke: the detent count and the
 // detent WIDTH are both gated (verify-pins gate 7), and this is the same
 // path, the same stroke and the same n as before — it costs nothing and it
 // leaves both assertions true.
 ctx.beginPath();
 const half = w / 2 + DETENT_OVER;
 for (let i = 0; i < n; i++) {
 const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
 const k = i === 0 ? INDEX_LEN : 1;
 if (onEdge) {
 const inner = rad - (w + DETENT_OVER) * k;
 ctx.moveTo(c * rad, s * rad);
 ctx.lineTo(c * inner, s * inner);
 } else {
 ctx.moveTo(c * (rad - half * k), s * (rad - half * k));
 ctx.lineTo(c * (rad + half), s * (rad + half));
 }
 }
 ctx.lineWidth = DETENT_W;
 ctx.lineCap = 'butt';
 ctx.strokeStyle = shade(fill, DETENT_INK);
 ctx.stroke();
}

// **The goal piece's surface** (2026-08-12, chosen from five): a honeycomb, the
// texture of an engineered lightweight panel, under the races and clipped to
// the piece so it rides its rotation.
//
// **8 px across the flats.** Play runs 0.4× to 8× (camera.js), so at the bottom
// a default goal piece is 12 screen px: anything finer than about 4 world px
// aliases into grey mush exactly when you have zoomed out to see your whole
// machine. A cell this size degrades to an even tint down there instead, which
// is a texture failing gracefully rather than a pattern failing loudly.
//
// **Each wall is drawn ONCE.** Every interior wall belongs to two cells, so a
// grid of whole hexagons draws all of them twice. Inside one stroke that does
// not ghost — the overlap rasterises once, the fault the F's crossbar had
// (§10.1) needs two STROKES — but it is exactly double the path for nothing.
// Each cell lays only the three walls it owns and its neighbours lay the rest.
//
// **And the path is built once per SIZE, not once per frame.** A goal piece is
// redrawn 60 times a second and its comb never changes; a `Path2D` kept by size
// turns the construction into a lookup. Measured on a 60×30 crate: whole
// hexagons rebuilt every frame **214 µs**, three-walls-per-cell rebuilt 60 µs,
// three-walls cached **13 µs**. On an r 100 ball, 5.6 ms became 118 µs. This is
// the route the sprite-cache note above prescribes for exactly this — "Path2D
// reuse or culling density, not bitmaps" — and it keeps the vector crispness
// that ruled bitmaps out, because it caches the PATH and not the pixels.
//
// Drawn in the piece's own EDGE colour, which `densityShade` has already
// darkened or paled: the comb follows the weight of the thing without knowing
// anything about weight.
const HEX_R = 4.6; // circumradius; 8.0 across the flats
const HEX_ALPHA = 0.45;
const HEX_DX = Math.sqrt(3) * HEX_R, HEX_DY = 1.5 * HEX_R;
export const hexFits = (half) => half >= HEX_R * 2;

const hexVert = (cx, cy, i) => [
 cx + Math.cos((i * 60 + 30) * Math.PI / 180) * HEX_R,
 cy + Math.sin((i * 60 + 30) * Math.PI / 180) * HEX_R,
];
// `sink` is a Path2D in a browser and the context itself under node, where
// there is no Path2D and the gates still have to see the segments.
// **Cells that cannot reach the clip are not built** (2026-08-12). The comb is
// clipped to the piece, and it was laid over the piece's bounding box plus a
// fixed TWO cells of margin on every side — a rounding error on a big piece and
// the whole picture on a small one, where most of what was stroked was thrown
// away by the clip it never touched. Cells built, before → after:
//
// ball r15 99 → 23 r30 195 → 93 r60 483 → 313 r100 1085 → 821
// crate 30 99 → 23 crate 120×60 315 → 181
//
// `HEX_R` is the exact slack: it is a cell's circumradius, so a wall's furthest
// point is never more than HEX_R from its own centre, and a cell whose centre
// is beyond `half + HEX_R` cannot put ink inside the clip.
//
// **It does not change a pixel**, and that is measured rather than argued —
// rendered both ways at 3× supersample against a control that diffs the old
// build with itself, 0 differing subpixels at every size and both shapes.
//
// **The clip is used as a BOX even for a ball**, deliberately. Culling a ball's
// comb to an ellipse instead is the obvious next 27% and it moved pixels at the
// rim: cells whose centre sits just outside `r + HEX_R` still have a wall
// within 0.16 px of the clip, and a 0.55-wide stroke reaches back inside. A
// wider slack did not close it either, so the ellipse is not shipped — the
// saving was real and the explanation was not, and an unexplained visual
// change on every goal ball in the game is not worth 27% of a texture.
function buildComb(sink, halfX, halfY) {
 const rx = halfX + HEX_R, ry = halfY + HEX_R;
 // Loop bounds from the SLACKED extent, so the two `abs` tests are what
 // decides and the loop is never the thing doing the culling.
 const cols = Math.ceil(rx / HEX_DX) + 2, rows = Math.ceil(ry / HEX_DY) + 2;
 for (let row = -rows; row <= rows; row++) {
 // Every other row steps half a cell across — that offset IS the honeycomb.
 const cy = row * HEX_DY, ox = (row % 2 ? HEX_DX / 2 : 0);
 if (Math.abs(cy) > ry) continue;
 for (let col = -cols; col <= cols; col++) {
 const cx = col * HEX_DX + ox;
 if (Math.abs(cx) > rx) continue;
 for (const i of [1, 2, 3]) {
 const [x0, y0] = hexVert(cx, cy, i - 1), [x1, y1] = hexVert(cx, cy, i);
 sink.moveTo(x0, y0);
 sink.lineTo(x1, y1);
 }
 }
 }
 return sink;
}

const combCache = new Map();
function combPath(halfX, halfY) {
 if (typeof Path2D === 'undefined') return null; // node: gates draw direct
 const key = `${halfX.toFixed(1)}x${halfY.toFixed(1)}`;
 let p = combCache.get(key);
 if (!p) {
 p = buildComb(new Path2D(), halfX, halfY);
 // Dragging a resize handle mints a new size every frame, so this is bounded
 // rather than left to grow with the gesture. A level's goal pieces are few
 // and their sizes stop changing the moment the drag ends.
 if (combCache.size > 24) combCache.clear();
 combCache.set(key, p);
 }
 return p;
}

function drawHoneycomb(ctx, half, edge, alpha) {
 ctx.save();
 ctx.globalAlpha = ctx.globalAlpha * alpha;
 ctx.lineWidth = 0.55;
 ctx.strokeStyle = edge;
 const p = combPath(half.x, half.y);
 if (p) ctx.stroke(p);
 else { ctx.beginPath(); buildComb(ctx, half.x, half.y); ctx.stroke(); }
 ctx.restore();
}

// The same race on a CRATE (2026-08-12): a rounded rectangle instead of a
// circle, and its detents laid along the outward normal at each slot rather
// than along a radius — which for a corner is the diagonal and for an edge
// midpoint is that edge's own normal, so a detent always crosses the channel
// square rather than leaning at the corners.
//
// `cr` is the frame's own corner radius, the piece's less however far in this
// frame sits: an inner frame of a rounded box is a rounded box with a tighter
// corner, and one that kept the outer radius would bulge past its own channel.
function drawFrameGroove(ctx, { a, b, pts }, cr, w, fill) {
 roundRectPath(ctx, a, b, cr);
 ctx.lineWidth = w;
 ctx.strokeStyle = shade(fill, GROOVE_INK);
 ctx.stroke();
 roundRectPath(ctx, a + w / 2, b + w / 2, Math.max(cr + w / 2, 0));
 ctx.lineWidth = 0.7;
 ctx.strokeStyle = shade(fill, 1.3);
 ctx.stroke();
 ctx.beginPath();
 for (const [x, y] of pts) {
 // On the frame, a slot is on an edge, a corner, or both — and which it is
 // IS the normal: a coordinate at its half-extent contributes that axis.
 const nx = Math.abs(Math.abs(x) - a) < 1e-9 ? Math.sign(x) : 0;
 const ny = Math.abs(Math.abs(y) - b) < 1e-9 ? Math.sign(y) : 0;
 const L = Math.hypot(nx, ny) || 1;
 const reach = w / 2 + DETENT_OVER;
 const ux = (nx / L) * reach, uy = (ny / L) * reach;
 ctx.moveTo(x - ux, y - uy);
 ctx.lineTo(x + ux, y + uy);
 }
 ctx.lineWidth = DETENT_W;
 ctx.lineCap = 'butt';
 ctx.strokeStyle = shade(fill, DETENT_INK);
 ctx.stroke();
}

// The centre is a pin with no ring — `goalRings` never includes (0,0) — so
// without its own mark an empty crate looks like you cannot bolt there. Same
// detent the rings use, as a cross: two ticks through the origin. A live bead
// still sits on top when something is actually connected.
function drawCenterCross(ctx, fill, ext) {
 // Same reach as a ring detent (`drawGroove` / `drawFrameGroove`), not the
 // index tick — that one is 2.4× longer so a spinning wheel has a period,
 // and using it here made the hub look like a different mark.
 const reach = Math.min(GROOVE_W / 2 + DETENT_OVER, Math.max(ext * 0.45, 0.8));
 if (reach < 0.6) return;
 ctx.beginPath();
 ctx.moveTo(-reach, 0); ctx.lineTo(reach, 0);
 ctx.moveTo(0, -reach); ctx.lineTo(0, reach);
 ctx.lineWidth = DETENT_W;
 ctx.lineCap = 'butt';
 ctx.strokeStyle = shade(fill, DETENT_INK);
 ctx.stroke();
}

// ---------- wheels ----------

// The three letters, redrawn as a SET (2026-08-12). Monoline 2.6 in a 24×24
// cell, cap height 6.5 → 17.5, stem at x 8.5, and **one width for all three**:
// the L's foot, the F's top arm and the R's bowl all reach x 15.8, so the three
// share a baseline, a width and — because the pair is placed off that box — a
// spacing. Every point below is on one of those four lines; nothing is where it
// is by eye.
//
// Two things were wrong with the set this replaces:
//
// **The F ghosted where its crossbar met the stem.** Not the shape's fault —
// the crossbar was a second `beginPath`/`stroke`, and at 22% alpha two strokes
// that touch composite twice, so the junction came out visibly darker than
// either mark. Each letter is now ONE path of several subpaths and a single
// stroke: the overlap is rasterised once and a junction weighs what a stroke
// weighs. (The SVG twin never had it — one `<path>`, one stroke.)
//
// **The R's leg was short and sprang from nowhere.** It started at x 12.8,
// inside the bowl rather than at its corner, and landed at 16.5 while the bowl
// bulged to 16.8 — so the leg leaned back under a letter that overhung it. It
// now leaves the bowl's bottom-right corner and lands on the baseline exactly
// under the bowl's widest point, which is where an R's leg goes.
//
// A point is [x, y], or ['q', cx, cy, x, y] for a quadratic.
const LETTER_PATHS = {
 ccw: [[[8.5, 6.5], [8.5, 17.5], [15.8, 17.5]]], // L
 free: [[[8.5, 17.5], [8.5, 6.5], [15.8, 6.5]], [[8.5, 11.9], [13.9, 11.9]]], // F
 cw: [ // R
 [[8.5, 17.5], [8.5, 6.5], [13.2, 6.5], ['q', 15.8, 6.5, 15.8, 9.45],
 ['q', 15.8, 12.4, 13.2, 12.4], [8.5, 12.4]],
 [[12.3, 12.4], [15.8, 17.5]],
 ],
};

// The same paths as an SVG `d`, so the toolbar button, the wordmark and the No
// Wheels badge draw the letter this file draws rather than a copy of it that
// has to be kept in step by hand (they were, and the R in the icon still had
// the old leg an hour after the canvas got a new one).
export const letterPathD = (kind, cx = 0) => (LETTER_PATHS[kind] || []).map((sub) =>
 sub.map((p, i) => (i === 0 ? `M ${p[0] + cx} ${p[1]}`
 : p[0] === 'q' ? `Q ${p[1] + cx} ${p[2]} ${p[3] + cx} ${p[4]}`
 : `L ${p[0] + cx} ${p[1]}`)).join(' ')).join(' ');

// Where the ink actually is inside that cell, and how big the pair of them is.
// MEASURED off the paths above rather than off the cell, because the cell's
// centre is (12,12) and the ink's is (12.15,12) — a letter placed by its cell
// sits visibly off to one side of where it was asked for, which is the
// difference between a balanced pair and one that has drifted.
//
// One box for all three, and since the redraw it is EXACT for all three rather
// than the widest of them: that is what "one width for the set" buys.
const LETTER_STROKE = 2.6;
const LETTER_INK = { x0: 8.5, x1: 15.8, y0: 6.5, y1: 17.5 };
// **The groove darker, twice** (2026-08-25, on request, then "Darker please").
// The plate's first cut was OCC at .30 (~45 luma off the face). The first
// step (×1.4 → .42) still whispered on the bright L and R; this is a
// doubling of the original, written as the product so both asks stay
// visible. The lip is the same pass it was — a darker groove against the
// same key is more of a cut, not less.
export const LETTER_LIP_A = 0.34;
export const LETTER_GROOVE_A = 0.30 * 2; // was 0.30, then 0.42
// How far the cut's lit lip rides up-light of the groove: 0.092 of the letter's
// own ink height, in cell units — scale by `letterScale(r)` for wheel px. The
// fraction is Mk II's (its 0.085 of a box whose ink fills 0.92), kept as a
// share of the LETTER so the lip thins with the letter rather than with the pen.
export const LETTER_LIP_OFF = (LETTER_INK.y1 - LETTER_INK.y0) * 0.092;
const LETTER_INK_CX = (LETTER_INK.x0 + LETTER_INK.x1) / 2 - 12; // +0.15
const LETTER_HALF_W = (LETTER_INK.x1 - LETTER_INK.x0) / 2 + LETTER_STROKE / 2; // 4.95
const LETTER_HALF_H = (LETTER_INK.y1 - LETTER_INK.y0) / 2 + LETTER_STROKE / 2; // 6.8

// Half the 0.85 the single centred letter used to be — "smaller text" — and
// SWEPT rather than picked: the standard wheel stops fitting its pair inside
// its own ring between 0.50 and 0.55, and 0.42 was the largest tried that
// still left about a millimetre of slack at both ends of the band on the
// tightest wheel there is.
//
// Then shrunk 10% (2026-08-24, "slightly clipped by the rim — only for play
// wheels"): the LARGE wheel's band reaches the pin ring sitting ON its rim,
// so at 0.42 the pair's outer corners reached radius 37.6 while the engraving
// clips at 0.92 r = 36.8 — the rim band cut them. At 0.378 the corner lands
// at 36.78, inside the clip at every ladder size. The SVG marks (wordmark,
// toolbar, badge, favicon) draw at their own cell size and are untouched.
export const LETTER_SCALE = 0.42 * 0.9;
const LETTER_GAP = 0.8; // daylight kept off the wall behind and the ring in front

export const letterScale = (r) => (r * 2 / 24) * LETTER_SCALE;

// **The widest clear annulus on the face** is where the pair lives. On a
// standard wheel that is the band between the hub bead and the ring; on a large
// one the gap BETWEEN its two rings is wider — 15 px against 10.2 — and that is
// where the letters go (2026-08-12, on request: they used to straddle the inner
// ring, which is what the single centred letter had always done).
//
// Derived rather than declared, so it cannot disagree with the lattice: change
// a ring and the letters move with it, in both pin styles at once.
function letterBand(rings) {
 let best = null, lo = PIN_DOT_R;
 for (const g of rings) {
 if (!best || g.rad - lo > best.hi - best.lo) best = { lo, hi: g.rad };
 lo = g.rad;
 }
 return best;
}

// The engraving is clipped to this fraction of the wheel — one name shared by
// the clip the painter sets and the fit maths below, so the two can never
// disagree about where the letter's world ends.
export const LETTER_CLIP = 0.92;

// Where each copy's centre sits: the MIDDLE of the range in which the whole
// letter box fits inside that band — clear of the wall behind it and inside the
// ring in front, corner included.
//
// **Zero means no letters**, which is how the small wheel ends up bare (on
// request) without a radius being named in an `if`: its band is 2.7 px of face
// and the pair is over the hub bead before it has cleared it, at every scale
// there is.
export function letterOffset(r, rings) {
 // The small wheel stays letter-free BY RULE (2026-08-17): moving the ring
 // out to the rim widened its clear band enough that the arithmetic below
 // suddenly fit a letter onto a 10 px face, and a cramped letter is worse
 // than none. The band maths used to answer this by accident; now the
 // intent is stated.
 if (r < STD_WHEEL_R) return 0;
 const band = letterBand(rings);
 if (!band) return 0;
 const ls = letterScale(r);
 const halfW = LETTER_HALF_W * ls, halfH = LETTER_HALF_H * ls;
 // **The clip is as real a wall as the ring** (2026-08-24, "still being
 // clipped on the outer edge of large wheels"): the large wheel's band runs
 // to the pin ring sitting ON its rim, 2.4 px past where the engraving clip
 // cuts, so the old fit parked ink in a strip the clip then removed. The
 // outer wall is whichever is nearer. And the lit lip swings with spin —
 // the counter-rotated light points anywhere in the face's frame over one
 // revolution — so the outer fit pads the box by the lip's reach; the inner
 // wall keeps the bare box, because a lip grazing the web recess is shading
 // while a lip crossing the clip is a visible amputation.
 const lip = LETTER_LIP_OFF * ls;
 const hi = Math.min(band.hi - LETTER_GAP, r * LETTER_CLIP);
 const room = hi ** 2 - (halfH + lip) ** 2;
 if (room <= 0) return 0;
 const dMin = band.lo + LETTER_GAP + halfW;
 const dMax = Math.sqrt(room) - halfW - lip;
 return dMax >= dMin ? (dMin + dMax) / 2 : 0;
}

// One path, one stroke — see the ghosting note above. The letter is drawn in a
// 24×24 local cell centred at 0,0.
function strokeLetter(ctx, kind) {
 ctx.save();
 ctx.translate(-12, -12);
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.beginPath();
 for (const sub of LETTER_PATHS[kind] || []) {
 ctx.moveTo(sub[0][0], sub[0][1]);
 for (let i = 1; i < sub.length; i++) {
 const p = sub[i];
 if (p[0] === 'q') ctx.quadraticCurveTo(p[1], p[2], p[3], p[4]);
 else ctx.lineTo(p[0], p[1]);
 }
 }
 ctx.stroke();
 ctx.restore();
}

// **A sprite cache for wheels was built here on 2026-08-03 and REJECTED.**
// A wheel is the dearest piece to draw (9.2 µs vs a stick's 3.4, measured),
// and its look is a pure function of (kind, r) — so pre-rendering to a bitmap
// and blitting under the transform looked like a 3-4× win. It measured badly:
// resampling a rasterised wheel through rotation and the scale ladder never
// beat 91% of pixels within 8 units of the vector path at any zoom (40% at
// 0.5×), and parity even flipped with sub-pixel alignment (61.6% vs 97.3% at
// the SAME zoom, half-pixel apart). The wheel is the most-watched moving
// object in the game; a visibly softer one is a feel change, and the bar was
// 99%. Vector wheels re-rasterise their strokes crisp at every angle and
// every zoom, and that is worth the microseconds. If the piece ceiling ever
// really binds, the honest routes are Path2D reuse or culling density, not
// bitmaps. (paintWheelBody stayed factored out; drawWheelVector is the seam
// the parity claim was measured against and any future attempt must be too.)
//
// **OVERRULED 2026-08-24** ("Let's bake them wheels now!") — and the 2003
// verdict's two teeth were pulled rather than ignored: the sprite now holds
// only the static half at a 2× supersample over the screen's own density
// (downscale-only resampling, which is what the old whole-wheel cache never
// had), and the recording-context gates keep the vector painter because a
// recording ctx has no drawImage to blit with. See the cache below drawWheel,
// and `wheelBakeCheck` for the parity numbers this build was measured to.
// **The drive arrow's barb, as two fractions of the radius.** A plain object
// rather than two consts because `scripts/probe-barb.mjs` sweeps it — the barb
// is pure feel, and this file's own rule for a number that sets feel is that it
// is measured against renders rather than chosen (the arrows have been redrawn
// three times already; see the head's comment).
//
// reach how far the barb hangs INWARD past the shaft
// len how far back along the shaft it runs
//
// `reach` came down 0.20 → 0.15 on 2026-08-12, on request: *"The barbs on the
// wheels could squeeze in a little to look a bit more centred."* The barb is
// entirely on the arc's inner side by construction (that is what keeps the
// outer profile smooth), so its mass hangs below the shaft's centreline and the
// head reads as slung under the arrow rather than sitting on it. Squeezing the
// reach is what pulls the head's centroid back toward the shaft.
//
// Swept in probe-barb.mjs, which records the real fill path rather than
// re-deriving it. How far the head hangs under the shaft, px:
//
// r7.5 r15 r30
// 0.20 1.12 1.83 3.38 ← was
// 0.15 1.12 1.61 2.93 ← is
// 0.10 1.12 1.48 2.47 ← the 1.8 px floor is binding by here
//
// Under about 0.13 there is not enough head left to read as an arrowhead, which
// is the other end of the trade and why this is not simply smaller.
//
// **The SMALL wheel does not move, at any setting** — 1.12 px all the way down
// the sweep. Its barb is clamped by the hub pin dot (`barbR`, below), not by
// this dial: an r7.5 wheel's arc rides only 4.35 px out, so the head has to
// stop short of the hub whatever the reach says. A sweep at one radius would
// have shown a clean proportional response and missed that entirely.
export const BARB = { reach: 0.15, len: 0.30 };

// **Where the drive arrow rides on the face** (2026-08-12, on request: *"I still
// feel the wheels barbs need to move closer to centre. Like half way between the
// two grooves or groove and axle."*).
//
// 'pins' the arc rides out until its outer edge just touches the pin dots it
// sweeps under — what this did before, and why a large wheel's arrows
// sat right under its outer race at 23.5 of a possible 27.
// 'band' the arc's INNER EDGE sits midway across the empty face inside that
// ring — midpoint + half a shaft. Between the two grooves on a large
// wheel (12 and 27 → midpoint 19.5), between the groove and the axle
// on the standard one (12 → 6), and clamped off the hub dot on the
// small one, whose 15 px width leaves no room to reach its own 2.25.
//
// Worth recording why the request needed this rather than another turn of
// BARB.reach: measured before touching anything, the barb's POINT was already
// at 5.95 on a standard wheel against a 6.0 midpoint, and already 2.2 px INSIDE
// the midpoint on a large one. The barb had nowhere left to go — it was the
// whole arrow that was sitting out under the pins.
export const ARROW_SEAT = { mode: 'band' };

// ---------- THE TIME LAW: the future is HOLLOW, not faded (§10.6) ----------
//
// A prediction used to be the present at `globalAlpha = 0.42`, and alpha is
// the one channel that could not afford it. Compositing is linear — the
// result is a·fg + (1−a)·bg — so EVERY colour difference is multiplied by
// alpha before the pixel is written, including the difference the game's core
// reading depends on. Measured over skyTop:
//
// solid R↔L 272 R↔F 195 L↔F 133 R's saturation 0.831
// α 0.42 R↔L 114 R↔F 82 L↔F 56 R's saturation 0.287
//
// Fifty-six RGB units is not a distinction. In the future — which is exactly
// where you are studying a machine to decide what to change — "which way does
// that wheel drive" was 42% of itself.
//
// So a ghosted piece is drawn HOLLOW: its own outline, in its own hue, at full
// strength, with nothing inside it. Nothing is thrown away except area. It is
// the same rule the ghost STICK already follows, for the same reason, and it
// costs less to draw than the solid piece it replaces.
function paintWheelGhost(ctx, w, opts = {}) {
 const r = w.r;
 const fill = wheelFill(w.kind);
 const ink = shade(fill, 0.55);
 const ring = (rad, lw, dash) => {
 ctx.beginPath();
 ctx.arc(0, 0, rad, 0, Math.PI * 2);
 ctx.lineWidth = lw;
 if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
 ctx.stroke();
 ctx.setLineDash([]);
 };
 // a pale collar first, so a hollow wheel survives a dark hillside the same
 // way a hollow stick does
 ctx.strokeStyle = 'rgba(255,255,255,0.34)';
 ring(r, 4.2);
 ctx.strokeStyle = ink;
 ring(r, 1.9);
 ring(r * 0.80, 1.2, [3.5, 4]);
 ring(Math.max(r * 0.24, 2), 1.4);
 // the kind letter is the direction channel that survives being hollow, so it
 // is the one mark a ghosted wheel keeps
 const rings = wheelRings(r);
 const d = letterOffset(r, rings);
 if (d) {
 const ls = letterScale(r);
 ctx.strokeStyle = ink;
 ctx.lineWidth = LETTER_STROKE * 0.6;
 ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 for (const turn of [0, Math.PI]) {
 ctx.save();
 ctx.rotate(turn);
 ctx.translate(-d, 0);
 ctx.scale(ls, ls);
 ctx.translate(-LETTER_INK_CX, 0);
 ctx.lineWidth = LETTER_STROKE;
 strokeLetter(ctx, w.kind);
 ctx.restore();
 }
 }
}

// **The painter is two halves now** (2026-08-24, the bake overruled in:
// "Let's bake them wheels now!"). STATIC is everything pure in (kind, r) —
// body, tyre, rim and bevel, arrows, races — and is what the sprite cache
// bakes once per (kind, r, density). OVERLAY is everything that changes
// per instance or per frame — the letters (whose lit lip counter-rotates
// with spin), the fixed-part fuzz, the occupancy beads and the hub — and is
// drawn in vector over the blit every frame. `paintWheelBody` composes the
// two in that order, so the vector path and the sprite path lay the same
// marks in the same sequence and parity between them is structural, not
// hoped for. (One visible consequence, accepted: the letters moved from
// before the arrows to after the races — the two never overlap by
// `letterOffset`'s own fit, so the pixels only differ along the sub-pixel
// sliver where a lip crosses a race edge.)
function paintWheelBody(ctx, w, opts = {}, spin = 0) {
 if (opts.ghost) { paintWheelGhost(ctx, w, opts); return; }
 paintWheelStatic(ctx, w);
 paintWheelOverlay(ctx, w, opts, spin);
}

function paintWheelStatic(ctx, w) {
 const r = w.r;
 const fill = wheelFill(w.kind);
 // body
 ctx.beginPath();
 ctx.arc(0, 0, r, 0, Math.PI * 2);
 ctx.fillStyle = fill;
 ctx.fill();
 // ---------- THE TYRE, AND ITS RAKED TREAD (§6.4, 2026-08-23) ----------
 //
 // A wheel was a coloured disc with a chunky border. It is now a dark tyre
 // bolted to a lit face, and the tyre carries a tread whose blocks RAKE the
 // way the wheel drives: forward on an R, back on an L, square on an F.
 //
 // A wheel is a TYRE ON A RIM, and the two want telling apart. The band is
 // narrow and only a little darker — the wide, treaded version measured worse
 // than no band at all: it read as dirt, it dulled the piece's colour (an
 // orange R wheel came out washed) and it cost the crisp rim that made the
 // wheel legible at a glance. Direction is the swoosh's job and the swoosh is
 // better at it than any rake.
 //
 // The pixels went into a BEVEL instead: one lit arc on the key side, one
 // shaded arc opposite, both inside the band. Two arcs, no texture, and the
 // rim reads as a machined edge rather than a drawn circle.
 const rimW = rimWidthOf(r);
 // litExtent, not r: an FC-imported or hand-edited wheel can be far past the
 // ladder's r40, and a rim and band that grow linearly with it are the "huge
 // bevels" the light law exists to stop. On the ladder litExtent is identity,
 // so every editor wheel is untouched.
 const tyreD = Math.max(GROOVE_W * 0.9, litExtent(r) * 0.115);
 const tyreIn = Math.max(r - tyreD, r * 0.6);
 const rimLW = Math.max(1.4, litExtent(r) * 0.06);
 {
 ctx.beginPath();
 ctx.arc(0, 0, r, 0, Math.PI * 2);
 ctx.arc(0, 0, tyreIn, 0, Math.PI * 2, true);
 ctx.fillStyle = shade(fill, 0.8);
 ctx.fill('evenodd');
 }
 // the rim, inset so the ink ends exactly on the collision circle. (The
 // straddling version painted 1–2 px proud of r at every size, which the
 // rod's own DRAWN <= COLLIDES note had already ruled against.)
 {
 const lw = rimLW;
 const rr = Math.max(r - lw / 2, 0.1);
 ctx.beginPath();
 ctx.arc(0, 0, rr, 0, Math.PI * 2);
 ctx.lineWidth = lw;
 ctx.strokeStyle = shade(fill, 0.5);
 ctx.stroke();
 // The bevel. LIGHT.x/y is the world's key direction; atan2 turns it into
 // the arc that faces the light. Measured over five spin angles the lit arc
 // stays put at -120° and the rim's lit-minus-shaded contrast goes 74..80
 // luma to 82..90 with no drift — so this reads as a lit edge rather than a
 // highlight painted on the wheel and carried round with it.
 if (lw >= 1.8) {
 const key = Math.atan2(-LIGHT.y, -LIGHT.x);
 const arc = Math.PI * 0.62;
 ctx.lineWidth = lw * 0.5;
 ctx.beginPath();
 ctx.arc(0, 0, rr, key - arc / 2, key + arc / 2);
 ctx.strokeStyle = mixHex(shade(fill, 0.5), LIGHT.key, 0.5);
 ctx.stroke();
 ctx.beginPath();
 ctx.arc(0, 0, rr, key + Math.PI - arc / 2, key + Math.PI + arc / 2);
 ctx.strokeStyle = mixHex(shade(fill, 0.5), LIGHT.occ, 0.45);
 ctx.stroke();
 }
 }
 // Asked for ONCE and used twice — to size the direction arrows and to draw
 // the pins. A wheel is the dearest piece there is (9.2 µs, see above), so the
 // second call and its array are worth not making.
 //
 // The RINGS rather than the coordinates: the arrows only ever wanted the
 // outermost RADIUS, and the groove style draws one race per ring instead of a
 // dot per slot. The coordinates are expanded below, and only in the style
 // that actually needs them — which is what keeps a 24-slot large wheel from
 // building a 24-entry array nobody reads.
 const rings = wheelRings(r);
 // The outermost ring the marks answer to: 12 on a standard wheel, 27 on a
 // large one (whose inner ring is the same 12). Hoisted out of the arrow block
 // for the seat maths below. (The letters used to share it from here; they
 // measure their own rings in the overlay now.)
 let ringR = 0;
 for (const g of rings) ringR = Math.max(ringR, g.rad);
 // The next groove INWARD of that one, or the axle when there isn't one: the
 // large wheel has races at 12 and 27, everything else has just the one. This
 // is what `ARROW_SEAT`'s 'band' mode measures the empty face against.
 let innerRingR = 0;
 for (const g of rings) if (g.rad < ringR) innerRingR = Math.max(innerRingR, g.rad);
 // The letters live in `paintWheelOverlay` now — their lit lip counter-rotates
 // with spin, which is exactly what a once-baked sprite cannot hold.
 // Direction arrows: 90° of arc each, centred north and south, between the
 // compass pins.
 //
 // **The FREE wheel gets the shafts and no barbs** (2026-08-09, on request),
 // which is the whole distinction drawn in one mark: every wheel turns, so
 // every wheel carries the two arcs, and only a wheel that is DRIVEN says
 // which way. A bare pair of arcs is not a half-finished arrow — it is the
 // same sentence with the direction left off, and the F reads it out.
 //
 // **Two of them, opposite each other** (2026-08-09, on request). One arrow at
 // the top has to be read as "this whole wheel turns that way"; a matched pair
 // pointing opposite ways round the hub IS rotation, with nothing to infer.
 // It also survives the wheel turning: with one arrow there is half a
 // revolution where it is on the far side from wherever you are looking, and
 // with two there is always one facing you.
 //
 // The pair is the same drawing 180° apart, which is why it is a helper called
 // twice rather than a second set of coordinates — and why the forward end
 // falls out of the spin rather than being stated: for CW the tip is the
 // increasing-angle end of each arc, for CCW the decreasing one, and that is
 // true of both halves without a special case.
 //
 // **How far the barb reaches, and how long it is** — both as fractions of the
 // wheel's radius, named and mutable so `probe-barb.mjs` can sweep them and a
 // change of feel is a measurement rather than a taste (see BARB below).
 //
 // **A BARB ON THE INSIDE EDGE, and the outside edge left alone** (2026-08-09,
 // on request — the third go at this head, and the two before it are why the
 // shape is built the way it is rather than drawn as a triangle on a tangent).
 //
 // First it was two stroked legs whose apex sat exactly ON the arc's endpoint,
 // where the arc's own round cap is: the cap bulged through the middle of the
 // head and pushed its visible mass to one side. Then it was a filled triangle
 // symmetric about the shaft, which fixed that and brought its own problem —
 // a symmetric head sticks out BOTH ways, so the arrow's outer profile grew a
 // lump at the end and the clean sweep of the arc was gone.
 //
 // So the head is now half of one: the shaft runs the full quarter as a plain
 // arc, untouched and uncut, and the barb is a filled triangle hanging off its
 // INNER side. The outer edge is therefore smooth *by construction* rather
 // than by two things lining up — nothing is drawn outside the arc at all, so
 // there is no seam to open, no cap to bulge through it, and nothing to keep
 // in step when the stroke width changes with radius.
 //
 // The barb tapers forward into the shaft's own nose and reaches back and
 // inward, which is what makes it read as a direction rather than a bump.
 //
 // **Its leading edge is TANGENT to the round cap** (2026-08-09: "no visible
 // line at front of the barb. Just a point"). Aim that edge at the cap's
 // CENTRE instead and the cap stands ~0.3 px proud of it, so the two outlines
 // cross and the crossing draws as a short line across the barb's front — a
 // blunt nose instead of a point. Tangent, they meet at exactly one point and
 // the silhouette runs barb-point → straight edge → round the nose → back
 // along the outer arc with no corner anywhere.
 //
 // **Sized off the two things already on the wheel** rather than off `r`:
 // the shaft is 0.8 of the rim's own width, and the arc rides out until its
 // outer edge just touches the pin dots it sweeps under (2026-08-09, on
 // request). Both matter beyond taste — a proportional radius put a large
 // wheel's arrows in the empty space between its two pin rings, and picking
 // the ring from `wheelRings` means the arrow follows the pins if the lattice
 // ever moves (§6.1) instead of quietly drifting under them — which is also
 // what makes the arrows land identically in both pin styles, since neither
 // style moves a ring.
 {
 const powered = w.kind !== 'free';
 const cwSpin = w.kind === 'cw';
 const shaftW = rimW * 0.8;
 // `ringR` — the outermost ring the arrow sweeps under — is computed above,
 // where the letters read it too.
 // Touching the dots, not the pin coordinates. Floored at the radius this
 // sat at before: a SMALL wheel's ring is only 4.5 px out and its dots are
 // 1.8, so there is no room inside it for an arrow at all — that wheel is
 // 15 px across and its pins are the same size as everyone's.
 // 'pins' rides out until the shaft's outer edge touches the dots it sweeps
 // under; 'band' seats it midway across the empty face inside that ring —
 // between the two grooves on a large wheel, between the groove and the axle
 // on the others. Named and mutable for the same reason BARB is: so a change
 // of feel is a measurement (see ARROW_SEAT).
 const seatPins = Math.max(ringR - PIN_DOT_R - shaftW * 0.5, r * 0.58);
 // **Half a shaft further out than the midpoint** (2026-08-12, second pass:
 // *"I think they need to be slightly further out now… current + 1/2 the
 // thickness of the shaft."*). That puts the shaft's INNER EDGE on the
 // midpoint rather than its centre-line, so the arc reads as sitting on the
 // empty band instead of straddling it.
 // Never so far in that the shaft's inner edge crowds the hub pin dot.
 const seatBand = Math.max((ringR + innerRingR) / 2 + shaftW * 0.5,
 PIN_DOT_R + 1 + shaftW * 0.5);
 const ar = ARROW_SEAT.mode === 'band' ? seatBand : seatPins;
 const hl = Math.max(3.6, BARB.len * r); // barb length, back along the shaft
 // 1.8 is the old 2.4 floor carried down by the same squeeze as `reach`
 // (0.20 → 0.15). Left at 2.4 it would have bound at r15 — 0.15 × 15 is
 // 2.25 — and the standard wheel, the one the request is about, would not
 // have moved at all.
 const hw = Math.max(1.8, BARB.reach * r); // how far it reaches past the shaft
 ctx.strokeStyle = shade(fill, 0.5);
 ctx.fillStyle = shade(fill, 0.5);
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 const dir = cwSpin ? 1 : -1;
 const at = (a, rad) => [Math.cos(a) * rad, Math.sin(a) * rad];
 // One arrow across the quarter `from`→`to` (given in increasing angle). The
 // tip is the increasing end when the wheel turns CW and the decreasing end
 // when it turns CCW, which is what lets the same call serve both halves.
 const arrow = (from, to) => {
 ctx.beginPath();
 ctx.lineWidth = shaftW;
 ctx.arc(0, 0, ar, from, to);
 ctx.stroke();
 if (!powered) return; // a free wheel turns, but nothing drives it
 // The barb, at the spin-forward end. `hl` is an arc LENGTH turned into an
 // angle, so it is the same barb at every radius, and it is capped at a
 // fraction of the sweep so a small wheel's barb can't eat its own arrow.
 const tip = cwSpin ? to : from;
 const base = tip - dir * Math.min(hl / ar, (to - from) * 0.5);
 // Inward, but never onto the hub pin dot — at r 7.5 the arc itself is
 // only 4.35 px out, so an unclamped barb lands in the middle of it and
 // the arrow reads as a smudge on the hub.
 const barbR = Math.max(ar - shaftW * 0.5 - hw, PIN_DOT_R + 1);
 const [px, py] = at(base, barbR); // the point of the barb
 const [cx, cy] = at(tip, ar); // the cap's centre
 // Where that point's tangent touches the cap. Two solutions; the one on
 // the hub side is the one the barb is on.
 const vx = cx - px, vy = cy - py, L = Math.hypot(vx, vy);
 let nx = cx, ny = cy;
 if (L > shaftW * 0.5) {
 const tl = Math.sqrt(L * L - shaftW * shaftW * 0.25);
 const a = Math.atan2(shaftW * 0.5, tl);
 const touch = (s) => [
 px + ((vx * Math.cos(s) - vy * Math.sin(s)) / L) * tl,
 py + ((vx * Math.sin(s) + vy * Math.cos(s)) / L) * tl,
 ];
 const [t1, t2] = [touch(a), touch(-a)];
 const out = ([x, y]) => x * Math.cos(tip) + y * Math.sin(tip); // how far out it lies
 [nx, ny] = out(t1) < out(t2) ? t1 : t2;
 }
 ctx.beginPath();
 ctx.moveTo(nx, ny); // the nose, on the cap and tangent to it
 ctx.lineTo(px, py); // out to the point of the barb
 ctx.lineTo(...at(base, ar)); // and back under the shaft, which hides this edge
 ctx.closePath();
 ctx.fill();
 };
 arrow(-Math.PI * 3 / 4, -Math.PI / 4); // north, between the top pins
 arrow(Math.PI / 4, Math.PI * 3 / 4); // south, the same drawing turned half round
 }
 // pins ride with the wheel body
 for (const g of rings) drawGroove(ctx, g, grooveWidth(g.rad, r), fill, r);
}

// Everything on a wheel that a (kind, r) sprite cannot hold: the engraved
// letters (their lit lip counter-rotates with spin), the fixed-part fuzz, and
// the occupancy marks. Drawn in vector after the static half — over the blit
// on the sprite path, after `paintWheelStatic` on the vector one — so the two
// paths are the same drawing.
function paintWheelOverlay(ctx, w, opts = {}, spin = 0) {
 const r = w.r;
 // Occupancy is asked in WORLD coordinates (the wheel's authored centre plus
 // the offset) because that is what a joint key is, and answered here in local
 // ones because that is where the mark goes. Absent — a toolbar icon, a piece
 // figure, a thumbnail of nothing in particular — every slot reads empty,
 // which for a wheel with nothing on it is the truth.
 const occ = opts.occupied;
 const hubKeys = opts.hubKeys;
 const liveAt = (ox, oy) => {
 if (!pinIsLive(occ, w.x + ox, w.y + oy)) return false;
 // a rim slot parked on another wheel's hub is not this wheel's joint —
 // the other hub already wears the bead. Lighting it was the extra gold
 // pin on a standard wheel sitting on a large one.
 if ((ox || oy) && hubKeys && hubKeys.has(jointKey(w.x + ox, w.y + oy))) return false;
 return true;
 };
 const rings = wheelRings(r);
 // Engraved kind-letter watermark, clipped to the rim (§10.1).
 //
 // **A PAIR, half a turn apart** (2026-08-12, on request): the letter upright
 // on the LEFT and the same letter upside down on the RIGHT, at half the size
 // the single centred one used to be. Built the way the direction arrows are
 // — one drawing, called twice, the second inside a 180° rotation — so the
 // two can never drift apart, and the pair reads the same way up from either
 // side of the wheel.
 //
 // **Where** the pair sits is `letterOffset`: the middle of the widest clear
 // annulus this wheel has, which puts the standard wheel's letters between the
 // hub and its ring and the large wheel's out between its TWO rings. A zero
 // means the face has no room for them, which is how the small wheel ends up
 // bare (both on request) without a radius being named here.
 const d = letterOffset(r, rings);
 if (d) {
 // **The letter is CUT, not printed** (2026-08-24, on request: *"the
 // embossed L,F,R I like"*, then *"like the attached image"* — the Mk II
 // plate). The cut is the plate's own two passes: a warm KEY lip riding
 // up-light of the stroke, and the world's occlusion ink laid over it as
 // the groove. The ink is OCC, not a tint of the face — that is the whole
 // difference between the whisper this replaces (a face-shade at .22 that
 // measured ~21 luma off the face) and the plate's first cut (~45), then
 // the asked-for step up (LETTER_GROOVE_A). The offsets are
 // the WORLD's light counter-rotated into the face's frame, because a cut
 // is geometry and geometry turns: the lit lip stays facing the sun while
 // the wheel spins, exactly as the rim's bevel does.
 ctx.save();
 ctx.beginPath();
 ctx.arc(0, 0, r * LETTER_CLIP, 0, Math.PI * 2);
 ctx.clip();
 const baseA = ctx.globalAlpha;
 const ls = letterScale(r);
 const letter = () => {
 ctx.save();
 ctx.translate(-d, 0);
 ctx.scale(ls, ls);
 ctx.translate(-LETTER_INK_CX, 0); // centred on its INK, not on its cell
 ctx.lineWidth = LETTER_STROKE;
 strokeLetter(ctx, w.kind);
 ctx.restore();
 };
 const cs2 = Math.cos(-spin), sn2 = Math.sin(-spin);
 const lx = LIGHT.x * cs2 - LIGHT.y * sn2, ly = LIGHT.x * sn2 + LIGHT.y * cs2;
 const off = LETTER_LIP_OFF * ls;
 const pass = (dx, dy, col, a) => {
 ctx.save();
 ctx.globalAlpha = baseA * a;
 ctx.strokeStyle = col;
 ctx.translate(dx, dy);
 letter(); // left, upright
 ctx.rotate(Math.PI); letter(); // right, upside down
 ctx.restore();
 };
 pass(-lx * off, -ly * off, LIGHT.key, LETTER_LIP_A); // the lit lip, up-light
 pass(0, 0, LIGHT.occ, LETTER_GROOVE_A); // the groove ink, on top
 ctx.restore();
 }
 // fixed-part fuzz (level-authored parts, edit tabs only) — over the races
 // now that every static mark draws first
 if (opts.fuzz) wheelFuzz(ctx, w, r);
 // **An occupied slot wears the bead**, drawn last and over the channel, so
 // "something is pinned here" stands out from the race it sits in. The live
 // bead is 4.6 px across against a 1.8 channel, so it stands proud of it
 // rather than sitting in it.
 //
 // The offsets are only expanded when somebody actually asked about
 // occupancy: the coordinates have to be the lattice's own (a cos/sin walk
 // would land a rounding away from the key the sim bucketed on), and a wheel
 // nobody asked about should not pay for the array.
 if (occ) {
 for (const [ox, oy] of wheelPinOffsets(r)) if (liveAt(ox, oy)) drawPinDot(ctx, ox, oy, true);
 }
 drawPinDot(ctx, 0, 0, liveAt(0, 0)); // hub — always a bead, and the motor point
}

// ---------- the wheel sprite cache (2026-08-24, the decline overruled) ----------
//
// The 2026-08-03 cache was rejected because a whole-wheel sprite resampled
// its crisp strokes soft; the standing decline after Mk II added the second
// objection — a blit hides the drawing from the recording-context gates.
// Both are answered structurally now:
//
// * SOFTNESS: the sprite holds only `paintWheelStatic`, baked at the pow-2
// ceiling of the ctx's own density times a 2× supersample, so the blit
// only ever DOWNSCALES an image with at least twice the screen's detail —
// Mk II's answer, measured on this build by `wheelBakeCheck` below. The
// marks that must stay exact per frame (letters with their sun-facing
// lip, occupancy beads, fuzz) never enter the sprite at all: the same
// `paintWheelOverlay` that the vector path runs draws them over the blit.
// * THE GATES: a recording context has no `drawImage` and node has no
// `document`, so every headless gate falls through to `drawWheelVector`
// and keeps exercising the one true painter — the same painter the bake
// itself calls into the sprite. What the gates cannot reach is only the
// blit transform, and `wheelBakeCheck` is the callable parity check that
// measures exactly that, in the browser, against the vector path.
//
// X-Ray (opts.alpha < 1) keeps the vector path: its point is per-mark
// compositing with what is already under the wheel, and a flattened blit
// composites the whole wheel once.
const WHEEL_SPRITE_SS = 2; // supersample over the screen's density
const WHEEL_SPRITE_PAD = 6; // world px past r: detent overhang + index tick + aa
const WHEEL_SPRITE_MAX_SIDE = 1600; // px; a bigger bake falls back to vector
const WHEEL_SPRITE_CAP = 64; // distinct (kind, r, density, seat) entries
const wheelSprites = new Map();
export function wheelSpriteStats() { return { size: wheelSprites.size }; }

function wheelSpriteFor(kind, r, density) {
 // pow-2 density buckets: pinch-zoom rebakes only on octave crossings, and
 // the blit ratio stays in the downscale half where the supersample lives
 const bucket = Math.min(4, Math.max(0.5, 2 ** Math.ceil(Math.log2(Math.max(density, 1e-3)))));
 const s = bucket * WHEEL_SPRITE_SS;
 const side = Math.ceil((r + WHEEL_SPRITE_PAD) * 2 * s);
 if (side > WHEEL_SPRITE_MAX_SIDE) return null;
 const key = `${kind}|${r}|${s}|${ARROW_SEAT.mode}`;
 let spr = wheelSprites.get(key);
 if (spr) return spr;
 if (wheelSprites.size >= WHEEL_SPRITE_CAP) wheelSprites.clear(); // crude, rare, correct
 const canvas = document.createElement('canvas');
 canvas.width = canvas.height = side;
 const c = canvas.getContext('2d');
 c.translate(side / 2, side / 2);
 c.scale(s, s);
 paintWheelStatic(c, { kind, r });
 spr = { canvas, s };
 wheelSprites.set(key, spr);
 return spr;
}

export function drawWheel(ctx, w, pose, opts = {}) {
 // culling (§10.3): outside the padded view rect the whole wheel is work
 // nobody sees. Additive — no clip passed, no change in behaviour.
 if (opts.clip) {
 const P = w.r * 1.25 + 8; // rim stroke + pin dots overhang
 const c = opts.clip;
 if (pose.x + P < c.minX || pose.x - P > c.maxX || pose.y + P < c.minY || pose.y - P > c.maxY) return;
 }
 if (typeof document !== 'undefined' && typeof ctx.drawImage === 'function'
 && !opts.ghost && (opts.alpha == null || opts.alpha === 1)) {
 const m = ctx.getTransform();
 const spr = wheelSpriteFor(w.kind, w.r, Math.hypot(m.a, m.b));
 if (spr) {
 ctx.save();
 ctx.translate(pose.x, pose.y);
 ctx.save();
 ctx.rotate(pose.angle || 0);
 ctx.imageSmoothingEnabled = true;
 ctx.imageSmoothingQuality = 'high';
 const wr = spr.canvas.width / spr.s;
 ctx.drawImage(spr.canvas, -wr / 2, -wr / 2, wr, wr);
 paintWheelOverlay(ctx, w, opts, pose.angle || 0);
 ctx.restore();
 wheelTone(ctx, w.r);
 ctx.restore();
 return;
 }
 }
 drawWheelVector(ctx, w, pose, opts);
}

// The parity-and-price check the sprite answers to, callable from the dev
// console: draws the same wheel through both paths at `angles` spins, diffs
// every pixel, then times both warm. The 2026-08-03 bar was "91% of pixels
// within 8 units" and it failed; this is the same question asked of the
// split-painter bake.
export function wheelBakeCheck({ r = 40, kind = 'cw', density = 2, angles = 8, bar = 8, reps = 300 } = {}) {
 if (typeof document === 'undefined') return null;
 const side = Math.ceil((r + WHEEL_SPRITE_PAD + 2) * 2 * density);
 const mk = () => { const c = document.createElement('canvas'); c.width = c.height = side; return c.getContext('2d', { willReadFrequently: true }); };
 const ga = mk(), gb = mk();
 let worst = null;
 for (let i = 0; i < angles; i++) {
 const angle = (i / angles) * Math.PI * 2 + 0.13;
 for (const g of [ga, gb]) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, side, side); g.setTransform(density, 0, 0, density, side / 2, side / 2); }
 drawWheelVector(ga, { kind, r }, { x: 0, y: 0, angle }, {});
 drawWheel(gb, { kind, r }, { x: 0, y: 0, angle }, {});
 const da = ga.getImageData(0, 0, side, side).data, db = gb.getImageData(0, 0, side, side).data;
 let past = 0, max = 0;
 for (let p = 0; p < da.length; p += 4) {
 for (let ch = 0; ch < 4; ch++) {
 const dd = Math.abs(da[p + ch] - db[p + ch]);
 if (dd > max) max = dd;
 if (dd > bar) { past++; break; }
 }
 }
 const withinPct = 100 - (past / (side * side)) * 100;
 if (!worst || withinPct < worst.withinPct) worst = { withinPct: +withinPct.toFixed(2), maxDelta: max, angle: +angle.toFixed(2) };
 }
 const time = (fn) => { const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(i); return (performance.now() - t0) * 1000 / reps; };
 const vectorUs = time((i) => drawWheelVector(gb, { kind, r }, { x: 0, y: 0, angle: i * 0.05 }, {}));
 const spriteUs = time((i) => drawWheel(gb, { kind, r }, { x: 0, y: 0, angle: i * 0.05 }, {}));
 return { r, kind, density, bar, ...worst, vectorUs: +vectorUs.toFixed(1),
 spriteUs: +spriteUs.toFixed(1), speedup: +(vectorUs / spriteUs).toFixed(2), sprites: wheelSprites.size };
}
if (typeof window !== 'undefined') {
 window.wheelBakeCheck = wheelBakeCheck;
 window.wheelSpriteStats = wheelSpriteStats;
}

// The pre-sprite path, whole and reachable — the fuzz fallback above uses it,
// and so does the parity check that decides the sprite cache is allowed to
// exist at all (a test seam in the ratelimit._resetBuckets tradition: the
// sprite's claim is "indistinguishable from this", and a claim needs the
// thing it is measured against).
// ---------- the light on a wheel, and why it is OUTSIDE the rotate ----------
//
// A world light does not turn with the object it lights. Everything a wheel
// draws — the rim, the races, the detents, the letters, the arrows, the beads
// — belongs to the wheel and turns with it; the two crescents that say where
// the sun is belong to the WORLD and must not. So they are drawn after
// paintWheelBody returns, back in the unrotated frame, over the marks rather
// than under them: a light falls on the machining too.
//
// Same law as a slab (see litFills): a disc offset up-light filled with key
// lights everything except the down-light crescent; a disc offset down-light
// filled with occ darkens everything except the up-light one; across the body
// the two overlap and cancel. Top-left bright, bottom-right shaded, one
// smooth turn between — and it stays put while the wheel spins, which is what
// makes the spin visible at all.
//
// Three arcs and two fills, all at the wheel's own radius, so nothing here can
// be mistaken for a pin: a bead is a lone filled circle of PIN_DOT_R
// (verify-pins gate 7) and no wheel in the ladder has that radius.
const WHEEL_KEY_OFF = 0.34, WHEEL_KEY_A = 0.20;
const WHEEL_OCC_OFF = 0.30, WHEEL_OCC_A = 0.22;

function wheelTone(ctx, r) {
 ctx.save();
 ctx.beginPath();
 ctx.arc(0, 0, r, 0, Math.PI * 2);
 ctx.clip();
 const a0 = ctx.globalAlpha;
 ctx.beginPath();
 ctx.arc(LIGHT.x * r * WHEEL_OCC_OFF, LIGHT.y * r * WHEEL_OCC_OFF, r, 0, Math.PI * 2);
 ctx.globalAlpha = a0 * WHEEL_OCC_A; ctx.fillStyle = LIGHT.occ; ctx.fill();
 ctx.beginPath();
 ctx.arc(-LIGHT.x * r * WHEEL_KEY_OFF, -LIGHT.y * r * WHEEL_KEY_OFF, r, 0, Math.PI * 2);
 ctx.globalAlpha = a0 * WHEEL_KEY_A; ctx.fillStyle = LIGHT.key; ctx.fill();
 ctx.restore();
}

export function drawWheelVector(ctx, w, pose, opts = {}) {
 ctx.save();
 ctx.translate(pose.x, pose.y);
 if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
 ctx.save();
 ctx.rotate(pose.angle || 0);
 paintWheelBody(ctx, w, opts, pose.angle || 0);
 ctx.restore();
 // a hollow wheel has no body for the light to land on, so it gets none
 if (!opts.ghost) wheelTone(ctx, w.r);
 ctx.restore();
}

// Light black diagonal cross-hatch (±45°), generously covering a
// halfSize-radius square around (cx,cy) — the caller sets a clip path first,
// so lines are drawn wide and simply get trimmed to the piece's true shape.
function hatchLines(ctx, cx, cy, halfSize) {
 const step = 4.5;
 ctx.save();
 ctx.strokeStyle = 'rgba(0,0,0,.25)';
 ctx.lineWidth = 0.9;
 ctx.beginPath();
 for (let o = -halfSize * 2; o <= halfSize * 2; o += step) {
 ctx.moveTo(cx + o - halfSize, cy - halfSize);
 ctx.lineTo(cx + o + halfSize, cy + halfSize);
 ctx.moveTo(cx + o - halfSize, cy + halfSize);
 ctx.lineTo(cx + o + halfSize, cy - halfSize);
 }
 ctx.stroke();
 ctx.restore();
}

function wheelFuzz(ctx, w, r) {
 ctx.save();
 ctx.beginPath();
 ctx.arc(0, 0, r, 0, Math.PI * 2);
 ctx.clip();
 hatchLines(ctx, 0, 0, r);
 ctx.restore();
}

// ---------- rods, and ropes ----------
//
// A rod is a rod. A ROPE is a run of rods laid in ONE gesture — Alt+drag chain
// paint, or a chain wrap — which is why they carry a shared `chain` id. Nothing
// about the physics differs: every link is the same capsule it always was
// (§5.3), pinned to its neighbours the same way, so no existing solve moves and
// there is no second body type to get wrong. What differs is that the renderer
// knows the run is one object, and draws it as one continuous line — a twisted
// lay running the whole length, and pins at the two ENDS instead of at every
// joint. That, and only that, is the difference between a rope and a row of
// sticks bolted end to end.
//
// **Both kinds fall out of the rod kind already there**, at no cost: a WOOD
// rope is the wood stick's palette, a WET rope is the water stick's — and a wet
// rope keeps `MASK.WATER` (§5.2), so it hangs straight through wheels, sticks
// and goal pieces and catches only on terrain and props. A line you can route
// through your own machine.

// **Wheels draw BEHIND rods, biggest first** (2026-08-19: "Wheels
// need to be Z level behind rods. Z order: Big wheel, standard wheel, small
// wheel, rods."). One order for every drawer — the game, the scenery layer,
// the cards — so a solution card reads as the run it came from. Stable, so
// two wheels of a size keep the order they were laid.
export function wheelsBackToFront(wheels, rOf = (w) => w.r) {
 return wheels.map((w, i) => [w, i]).sort((a, b) => (rOf(b[0]) - rOf(a[0])) || (a[1] - b[1])).map(([w]) => w);
}

// Visual radius of cargo for the same stack as wheels: a ball is its r, a
// crate is the larger half-side. Smaller discs draw in front so a tiny goal
// is not lost inside a big wheel, and a tiny wheel is not lost under a crate.
export function goalStackR(g) {
 if (!g) return 0;
 if (g.shape === 'ball') return g.r || 0;
 return Math.max((g.w || 0) / 2, (g.h || 0) / 2);
}

// Wheels and cargo as one back-to-front list. Rods stay in front of this
// stack. Same-size items keep input order (fixed wheels, then player wheels,
// then cargo, unless size puts a smaller one later).
export function wheelCargoBackToFront(wheels, goals, rWheel = (w) => w.r, rGoal = (g) => goalStackR(g)) {
 const items = [];
 for (const w of wheels) items.push({ kind: 'wheel', ref: w, r: rWheel(w) });
 for (const g of goals) items.push({ kind: 'goal', ref: g, r: rGoal(g) });
 return wheelsBackToFront(items, (it) => it.r);
}

export function drawRod(ctx, rDef, opts = {}) {
 ctx.save();
 if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
 ctx.lineCap = 'round';
 rodBody(ctx, rDef, rDef.x1, rDef.y1, rDef.x2, rDef.y2, opts);
 if (opts.fuzz) rodFuzz(ctx, rDef, opts);
 // A stick's ends are pins like any other, so they answer the occupancy
 // question too — the end bolted to something reads live, the end hanging in
 // the air does not, which is the whole of what a builder wants to see.
 //
 // `noPins` is drawRods' own flag: the batch draws one boss per COORDINATE
 // rather than one per end, so it suppresses these and draws them itself.
 // Nothing else passes it, so a stick drawn on its own is unchanged.
 if (!opts.noPins) {
 drawPinDot(ctx, rDef.x1, rDef.y1, pinIsLive(opts.occupied, rDef.x1, rDef.y1));
 drawPinDot(ctx, rDef.x2, rDef.y2, pinIsLive(opts.occupied, rDef.x2, rDef.y2));
 }
 ctx.restore();
}

// The stroked body of one rod, no pins. Split out for the rope pass, which
// draws its links as exactly the sticks they are and then withholds the pins in
// the middle — so a rope can never draw a width its capsule doesn't have.
// Caller owns save/restore, `lineCap` and the base alpha.
// **HOW WIDE A STICK IS DRAWN — a number of its own** (2026-08-20, on request:
// "Width for rendered wood, instead of 8 wide make it 5.66 wide (density/weight
// stay the same)… Simulated width stays the same").
//
// This was taken from the physics profile's `woodThick`/`waterThick` (2026-08-16)
// so a stick drew the width it touched things at. That fixed a real complaint —
// under `fc` a wood stick is EIGHT px in the world and was drawing 5, so a
// machine that had visibly not touched anything moved — but eight px of wood
// reads as a plank, and a hundred of them read as a solid mass rather than a
// linkage. So the drawn width is now its own constant again and 5.66 is the
// asked-for number: still wide enough that a contact is not a surprise, narrow
// enough that a 119-stick machine has daylight in it.
//
// The stick still SIMULATES 8 (sim.js `woodThick`), and its density and mass
// are untouched — this changes what you see, not what it does.
//
// A second thing falls out of it: the width no longer depends on being told
// which physics is in play, so the drag ghost and the icons — which draw with
// no profile at all and so fell back to 5 — are the same width as the stick
// they become (2026-08-20, "when drawing wood rods they should ghost the same
// as the final rods. Currently they are thinner").
//
// The two-tone wood stays two-tone: the darker edge is the full thickness and
// the core is inset by a constant 1.5.
//
// **LENGTH is deliberately left alone.** A round cap still overhangs each pin
// by half the stroke, so a stick draws a little longer than the span it was
// built between. That is the game's look and was not part of the request.
const WOOD_CORE_INSET = 1.5;
export const ROD_DRAW_W = { wood: 5.66, water: 4 };
const rodDrawW = (kind) => (kind === 'water' || kind === 'ghost' ? ROD_DRAW_W.water : ROD_DRAW_W.wood);

function rodBody(ctx, rDef, x1, y1, x2, y2, opts) {
 const P = opts.P || null;
 const w = rodDrawW(rDef.kind);
 // **A GHOST stick is drawn as an absence** (2026-08-10). It touches nothing
 // at all, so the art has to say "this is not really here" — and it has to say
 // it against a WATER stick, which passes through your own machine and is the
 // piece it will be mistaken for. Water is a solid bright line; a ghost is a
 // dashed outline with a hollow middle, so the level shows through it.
 //
 // It still darkens with weight like the other two: the dial does the same
 // work on it, and a heavy ghost is the one honest reason to build one.
 // A stick in the FUTURE is hollow in exactly the way a ghost stick is — same
 // law, same reason (see paintWheelGhost) — but in its OWN hue, because a
 // prediction of a water stick is a prediction of a water stick. Falling
 // through to the ghost branch below would have said the wrong thing twice:
 // that it is weightless and that it collides with nothing.
 if (opts.ghost && rDef.kind !== 'ghost') {
 const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
 const nx = -dy / len, ny = dx / len;
 const a0 = opts.alpha ?? 1;
 const hue = rDef.kind === 'water' ? COLORS.water : COLORS.woodEdge;
 const ink = weightShade(hue, rDef.weight ?? 1);
 const line = (off, width, style) => {
 ctx.beginPath();
 ctx.moveTo(x1 + nx * off, y1 + ny * off);
 ctx.lineTo(x2 + nx * off, y2 + ny * off);
 ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke();
 };
 ctx.globalAlpha = a0 * 0.30;
 line(0, w + 3.4, '#ffffff');
 ctx.globalAlpha = a0;
 line(-w * 0.5, 1.3, ink);
 line(w * 0.5, 1.3, ink);
 return;
 }
 if (rDef.kind === 'ghost') {
 const wgt = rDef.weight ?? 1;
 const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
 const nx = -dy / len, ny = dx / len;
 const a0 = opts.alpha ?? 1;
 const line = (off, width, style, dash) => {
 ctx.beginPath();
 ctx.moveTo(x1 + nx * off, y1 + ny * off);
 ctx.lineTo(x2 + nx * off, y2 + ny * off);
 ctx.lineWidth = width; ctx.strokeStyle = style;
 if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
 ctx.stroke();
 };
 // **HOLLOW, and it has to survive both backgrounds.** A ghost touches
 // nothing at all, so it is drawn as its own two EDGES with nothing inside
 // — the same law the prediction layer uses for anything that has let go of
 // the world. The dashed line it replaces said the right thing and could
 // not be seen saying it: pale blue-grey at 72% disappeared into a dusk sky
 // above and into granite below.
 //
 // A pale collar underneath carries it over dark terrain, the cold edges
 // carry it over bright sky, and the end brackets say exactly where it
 // stops — which the round caps of a dashed line never did.
 ctx.globalAlpha = a0 * 0.34;
 line(0, w + 4.2, '#ffffff');
 ctx.globalAlpha = a0;
 const col = weightShade(COLORS.ghost, wgt);
 line(-w * 0.5, 1.5, col);
 line(w * 0.5, 1.5, col);
 ctx.globalAlpha = a0 * 0.62;
 line(0, 1.2, col, [4.5, 5.5]);
 ctx.globalAlpha = a0;
 ctx.setLineDash([]);
 ctx.lineWidth = 1.5;
 ctx.strokeStyle = col;
 for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
 const b = w * 0.5 + 3;
 ctx.beginPath();
 ctx.moveTo(ex + nx * b, ey + ny * b);
 ctx.lineTo(ex - nx * b, ey - ny * b);
 ctx.stroke();
 }
 ctx.lineDashOffset = 0;
 return;
 }
 if (rDef.kind === 'water') {
 // water sticks take weight exactly like wood ones, so they darken with it
 // exactly like wood ones. The bright core has to fade as well: on a 3.5px
 // stroke a full-strength white centre line swamps the shading and a heavy
 // stick looked identical to a ×1 one. Same log scale as the tint, so the
 // two fade in step.
 const wgt = rDef.weight ?? 1;
 const heavy = weightFrac(wgt);
 ctx.globalAlpha = (opts.alpha ?? 1) * 0.85;
 ctx.strokeStyle = weightShade(COLORS.water, wgt);
 ctx.lineWidth = w;
 ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
 ctx.globalAlpha = (opts.alpha ?? 1);
 ctx.strokeStyle = `rgba(255,255,255,${0.9 - 0.7 * heavy})`;
 ctx.lineWidth = 1;
 ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
 // the denomination bands, translucent — seen THROUGH the water rather
 // than painted on it
 if (wgt >= 5) {
 const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
 const ux = dx / len, uy = dy / len;
 drawWeightBands(ctx, x1, y1, ux, uy, -uy, ux, len, w, wgt, opts.alpha ?? 1, 0.55);
 }
 } else {
 const wgt = rDef.weight ?? 1;
 ctx.strokeStyle = weightShade(COLORS.woodEdge, wgt);
 ctx.lineWidth = w;
 ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
 ctx.strokeStyle = weightShade(COLORS.woodCore, wgt);
 ctx.lineWidth = Math.max(w - WOOD_CORE_INSET, 1);
 ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
 woodDetail(ctx, rDef, x1, y1, x2, y2, w, wgt, opts);
 }
}

// ---------- what a stick is made of, and how heavy it is ----------
//
// **Weight had exactly one channel and it saturates.** `weightFrac` is a log
// ramp 45% deep, so ×10 and ×100 are two barely-different browns — the file's
// own note about the old linear range says the same thing happened at ×38.
// Darkness stays; two more channels join it, and one of them is COUNTABLE:
//
// · the GRAIN says it is timber rather than a coloured capsule
// · the LIT LIP says which way the sun is, the same sun as everything else
// · the BANDS say how heavy, in a number you can count: none / one / two /
// three, at ×1-3 / ×4-10 / ×11-30 / ×31 and up
//
// Nothing here changes the stroke WIDTH. The drawn width is a constant on
// purpose (ROD_DRAW_W, 2026-08-20) and verify-editor counts rope links by it,
// so a weight-varying girth would break a gate that is measuring something
// else entirely. Marks are cheaper than geometry anyway.
// **The bands are DENOMINATIONS now, not a count** (2026-08-24, on request:
// "Bands on Sticks… Bronze/Copper, Silver, Gold. B = 5 | S = 20 | G = 50").
// A stick's weight decomposes greedily, largest coin first, and wears the
// result reading inward from each end:
//
// 5 B 20 S 35 SBBB 50 G 65 GBBB 100 GG
//
// — the resistor-code idea, with three metals a builder already knows the
// order of. Below 5 a stick says nothing: that is the ordinary stick, and
// most of a machine is ordinary sticks. Weights past 100 keep spending gold
// (150 = GGG); a stick too short for its full code shows it at one end, and
// one too short for that shows nothing rather than a lie.
export const BAND_VALUES = [['G', 50], ['S', 20], ['B', 5]];
export function bandCode(weight) {
 let w = Math.floor((weight ?? 1) / 5) * 5; // the dial moves in fives
 if (w < 5) return '';
 let out = '';
 for (const [ch, v] of BAND_VALUES) while (w >= v) { out += ch; w -= v; }
 return out;
}
// Gold is the game's own brass (--gold, the points' colour) — NOT the pale
// #ffd76a of a live pin, which already means "holding something". Silver is
// a cool plate, bronze sits between the woods.
const BAND_COLORS = { G: '#d4a017', S: '#b9c0c8', B: '#b06b3a' };
const BAND_INSET = 9, BAND_PITCH = 4.4, GRAIN_MIN_LEN = 18;

function woodDetail(ctx, rDef, x1, y1, x2, y2, w, wgt, opts) {
 const dx = x2 - x1, dy = y2 - y1;
 const len = Math.hypot(dx, dy);
 if (len < 1) return;
 const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
 const a0 = ctx.globalAlpha;
 // the grain: two hairlines seeded off the stick's own geometry, so no two
 // sticks are the same board and the same stick is the same board every frame
 if (len >= GRAIN_MIN_LEN) {
 const rand = seedRand(((x1 * 73856093) ^ (y1 * 19349663) ^ (len * 83492791)) | 0);
 ctx.globalAlpha = a0 * 0.30;
 ctx.strokeStyle = weightShade(COLORS.woodEdge, wgt);
 ctx.lineWidth = 0.8;
 for (let g = 0; g < 2; g++) {
 const off = (g ? 1 : -1) * w * (0.14 + rand() * 0.10);
 ctx.beginPath();
 for (let i = 0; i <= 4; i++) {
 const s = i / 4, j = (rand() - 0.5) * w * 0.16;
 const px = x1 + dx * s + nx * (off + j), py = y1 + dy * s + ny * (off + j);
 i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
 }
 ctx.stroke();
 }
 }
 // the lit lip, on whichever side of THIS stick faces the light
 {
 const lit = (nx * LIGHT.x + ny * LIGHT.y) >= 0 ? -1 : 1;
 const o = lit * w * 0.30;
 ctx.globalAlpha = a0 * 0.42;
 ctx.strokeStyle = LIGHT.key;
 ctx.lineWidth = Math.max(w * 0.20, 0.6);
 ctx.beginPath();
 ctx.moveTo(x1 + nx * o, y1 + ny * o);
 ctx.lineTo(x2 + nx * o, y2 + ny * o);
 ctx.stroke();
 }
 drawWeightBands(ctx, x1, y1, ux, uy, nx, ny, len, w, wgt, a0, 1);
 ctx.globalAlpha = a0;
}

// The denomination bands, shared by wood and water (water passes bandAlpha
// < 1 — "Water needs translucent version" — so the metals read as seen
// through the stick rather than painted on it). Reading inward from each
// end, first coin nearest the tip; a stick without room for both ends shows
// one, without room for one shows nothing.
function drawWeightBands(ctx, x1, y1, ux, uy, nx, ny, len, w, wgt, a0, bandAlpha) {
 const code = bandCode(wgt);
 if (!code) return;
 const span = BAND_PITCH * (code.length - 1);
 const both = len > BAND_INSET * 2 + span + BAND_PITCH;
 const one = len > BAND_INSET + span + 6;
 if (!both && !one) return;
 const half = w * 0.60;
 ctx.lineCap = 'butt';
 for (let e = 0; e < (both ? 2 : 1); e++) {
 for (let b = 0; b < code.length; b++) {
 const at = e ? len - BAND_INSET - b * BAND_PITCH : BAND_INSET + b * BAND_PITCH;
 const px = x1 + ux * at, py = y1 + uy * at;
 const gold = code[b] === 'G';
 ctx.globalAlpha = a0 * bandAlpha;
 ctx.strokeStyle = BAND_COLORS[code[b]];
 ctx.lineWidth = gold ? 2.6 : 1.8;
 ctx.beginPath();
 ctx.moveTo(px + nx * half, py + ny * half);
 ctx.lineTo(px - nx * half, py - ny * half);
 ctx.stroke();
 ctx.globalAlpha = a0 * bandAlpha * (gold ? 0.5 : 0.34);
 ctx.strokeStyle = LIGHT.key;
 ctx.lineWidth = 0.9;
 ctx.beginPath();
 ctx.moveTo(px + nx * half - LIGHT.x * 1.1, py + ny * half - LIGHT.y * 1.1);
 ctx.lineTo(px - nx * half - LIGHT.x * 1.1, py - ny * half - LIGHT.y * 1.1);
 ctx.stroke();
 }
 }
 ctx.lineCap = 'round';
 ctx.globalAlpha = a0;
}

function rodFuzz(ctx, rDef, opts = {}) {
 const { x1, y1, x2, y2 } = rDef;
 const len = Math.hypot(x2 - x1, y2 - y1) || 1;
 const angle = Math.atan2(y2 - y1, x2 - x1);
 const halfW = rodDrawW(rDef.kind) / 2; // the stroke drawn above
 ctx.save();
 ctx.translate(x1, y1);
 ctx.rotate(angle);
 ctx.beginPath();
 ctx.rect(0, -halfW, len, halfW * 2);
 ctx.clip();
 hatchLines(ctx, len / 2, 0, len / 2 + halfW);
 ctx.restore();
}

// ---------- ropes ----------

const ROPE_LAY_PITCH = 4.5; // px along the rope between strand marks
const ROPE_LAY_MIN_PX = 2.4; // …below this on SCREEN they are noise, so skip them

// A mark has to FIT the body it is drawn on, and the two bodies are not the
// same width. A mark sized for wood overhangs a wet rope by a third of a pixel
// on each side, and a third of a pixel is the whole difference between a rope
// and a net — measured, at ×2.6, on a drape of eight links.
//
// **So the mark is a FRACTION of the stroke, not a number of pixels**
// (2026-08-16). The two used to be typed against the 5 and 3.5 the body was
// stroked at; now that the body's width comes off the physics profile, a typed
// mark would overhang a wood rope by three px under `fc`. These fractions are
// the old numbers divided by the old widths — 2.10/5 and 1.45/3.5 both round to
// 0.42, 1.50/5 and 1.04/3.5 both to 0.30 — so a rope at ROD_THICK draws exactly
// what it always drew. `slant` holds the same ~55° lean either way, and the wet
// rope's marks are lighter because they cross a bright core rather than a matte
// one.
const ROPE_LAY_HW = 0.42; // half-width, as a fraction of the body's stroke
const ROPE_LAY_SLANT = 0.30; // …and the lean along it
const ROPE_LAY_ALPHA = { wood: 0.50, water: 0.42 };

// The lay is a groove in the rope's OWN colour — it takes the same weight tint
// the body takes and is then darkened, so the marks stay legible on a heavy
// rope instead of vanishing into it.
const layShade = (hex, weight) => shade(hex, 0.62 * (1 - 0.45 * weightFrac(weight)));

function drawRope(ctx, run, opts = {}) {
 ctx.save();
 if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
 ctx.lineCap = 'round';
 // Bodies first, all of them, before any lay goes on: each link is exactly the
 // stick it is in the sim, and the round caps meeting on a shared pin fill the
 // joint — so the run reads as one line without the drawing having to pretend
 // every link weighs the same. Per-link weight tinting survives intact.
 for (const L of run.links) {
 rodBody(ctx, L.rod, L.ax, L.ay, L.bx, L.by, opts);
 if (opts.fuzz) rodFuzz(ctx, { kind: L.rod.kind, x1: L.ax, y1: L.ay, x2: L.bx, y2: L.by }, opts);
 }
 ropeLay(ctx, run, opts);
 // Pins at the two ENDS only. A closed loop has neither.
 if (!run.closed && run.links.length) {
 const a = run.links[0], b = run.links[run.links.length - 1];
 drawPinDot(ctx, a.ax, a.ay, pinIsLive(opts.occupied, a.ax, a.ay));
 drawPinDot(ctx, b.bx, b.by, pinIsLive(opts.occupied, b.bx, b.by));
 }
 ctx.restore();
}

// A strand mark every ROPE_LAY_PITCH px measured along the WHOLE run. The phase
// carrying across a link boundary is the point of it: a twist that restarted at
// each joint would just be re-drawing the joints the pins were removed from.
function ropeLay(ctx, run, opts) {
 const sc = ctx.getTransform ? Math.abs(ctx.getTransform().a) || 1 : 1;
 if (ROPE_LAY_PITCH * sc < ROPE_LAY_MIN_PX) return; // thumbnails, zoomed right out
 ctx.save();
 ctx.lineCap = 'butt'; // marks stop at the body's edge
 ctx.lineWidth = 1.1;
 let s = ROPE_LAY_PITCH / 2; // half a pitch in, off the end pin
 for (const L of run.links) {
 const dx = L.bx - L.ax, dy = L.by - L.ay;
 const len = Math.hypot(dx, dy);
 if (!(len > 0.001)) continue;
 // `!== 'wood'` rather than `=== 'water'`: nothing can lay a GHOST rope
 // today (no tool, and the importer never chains), but if one ever exists
 // the wet lay is the right one for it — the wood lay would draw twist
 // marks on a stick that is not there.
 const wet = L.rod.kind !== 'wood';
 const bodyW = rodDrawW(L.rod.kind);
 const hw = bodyW * ROPE_LAY_HW, slant = bodyW * ROPE_LAY_SLANT;
 const ux = dx / len, uy = dy / len;
 const hx = -uy * hw, hy = ux * hw; // across the rope
 const sx = ux * slant, sy = uy * slant; // and the lean along it
 ctx.globalAlpha = (opts.alpha ?? 1) * (wet ? ROPE_LAY_ALPHA.water : ROPE_LAY_ALPHA.wood);
 ctx.strokeStyle = layShade(wet ? COLORS.water : COLORS.woodEdge, L.rod.weight);
 ctx.beginPath();
 for (; s < len; s += ROPE_LAY_PITCH) {
 const px = L.ax + ux * s, py = L.ay + uy * s;
 ctx.moveTo(px + hx + sx, py + hy + sy);
 ctx.lineTo(px - hx - sx, py - hy - sy);
 }
 ctx.stroke();
 s -= len; // carry the phase into the next link
 }
 ctx.restore();
}

// **The one entry point for drawing a machine's sticks**, because whether a rod
// is a stick or part of a rope is a question about its NEIGHBOURS — no single
// rod can answer it, so no per-rod call could.
//
// Every entry is a rod def to draw: `kind`, `weight`, `chain` and the four
// coordinates. When those coordinates are LIVE ones out of the sim, pass the
// authored part as `part` as well — see `ropeRuns`. Ropes draw after the plain
// sticks, which is also the right way round to look at: a rope lies over the
// machine it is tied to.
export function drawRods(ctx, rods, opts = {}) {
 const runs = ropeRuns(rods);
 // culling (§10.3): a stick whose padded bbox misses the view rect draws
 // nothing anyone sees — measured, 1000 offscreen sticks still cost 65% of
 // onscreen without this. ROPES are deliberately not culled per link (a run
 // draws as one continuous lay), and not at all: a run is one object and
 // partial culling would cut the line. Additive: no clip, no change.
 const c = opts.clip;
 const out = c ? (r) => {
 const pad = 12; // thickness + endpoint pins
 return Math.max(r.x1, r.x2) + pad < c.minX || Math.min(r.x1, r.x2) - pad > c.maxX
 || Math.max(r.y1, r.y2) + pad < c.minY || Math.min(r.y1, r.y2) - pad > c.maxY;
 } : null;
 // **Wood behind water** (2026-08-20, on request: "Z order: Big wheel,
 // standard wheel, small wheel, goal piece, wood, water"). Here rather than at
 // the eleven call sites, so the game, the Maker, the scenery layer, the cards
 // and the icons cannot drift apart — a solution card reads as the run it came
 // from because there is only one order. Ghost sticks ride with water: they
 // are the pieces you look THROUGH, and they belong on top of what they show.
 // Stable within a pass, so two sticks of a kind keep the order they were laid.
 const woodFirst = (r) => (r.kind === 'water' || r.kind === 'ghost' ? 1 : 0);
 const loose = rods.map((r, i) => [r, i]).filter(([r]) => !r.chain && !(out && out(r)))
 .sort((a, b) => (woodFirst(a[0]) - woodFirst(b[0])) || (a[1] - b[1]));
 // ---------- ONE BOSS PER PIN, not one per stick END (2026-08-23) ----------
 //
 // Six sticks meeting at a joint drew twelve pin dots, six of them exactly on
 // top of the other six: 24 arcs and 24 fills to produce the picture of one
 // bolt. A 200-stick machine spent 400 dots on about 90 actual pins.
 //
 // So the bodies are drawn per stick and the pins ONCE per coordinate, and
 // the count is put to use rather than thrown away: how many sticks meet
 // there is a fact a builder wants and had no way to see. One or two is a
 // bolt, three or more a bigger one — the same mark, grown.
 //
 // `drawRod` is untouched and still draws its own two pins, because it is
 // also called on its own (a drag ghost, a toolbar figure, verify-pins gate
 // 10, which asserts exactly one live bead and one empty one from it). Only
 // the BATCH dedupes, and the batch is what a machine goes through.
 const pinAt = new Map();
 for (const [r] of loose) {
 drawRod(ctx, r, { ...opts, noPins: true });
 // drawn at the LIVE end, counted by the AUTHORED one: `pinOwners` is
 // keyed on authored coordinates (util.pinOwnerCounts — live poses
 // separate by fractions under load), and a joint keeps its identity
 const ends = [[r.x1, r.y1, r.part?.x1 ?? r.x1, r.part?.y1 ?? r.y1],
 [r.x2, r.y2, r.part?.x2 ?? r.x2, r.part?.y2 ?? r.y2]];
 for (const [px, py, ax, ay] of ends) {
 const k = jointKey(px, py);
 const e = pinAt.get(k);
 if (e) e.n++; else pinAt.set(k, { x: px, y: py, n: 1, ak: jointKey(ax, ay) });
 }
 }
 for (const p of pinAt.values()) {
 // **The hardware ladder is a SHAPE ladder, and the number is the PIN
 // COUNT** (2026-08-24, "circle, triangle, square, pentagon, stop at
 // hexagon… pins on things count. eg. Wheels, goal pieces, prop pins,
 // background pins"): every party whose pin sits at the coordinate counts
 // one — rod ends, a wheel's slot, the cargo's corner, a prop's mount,
 // the world's own loose pin. One or two parties stay the round bolt;
 // three meet under a triangle, four a square, five a pentagon, six or
 // more the hexagon — stopping at the one nut hardware actually makes.
 const n = Math.max(opts.pinOwners?.get(p.ak) ?? 0, p.n);
 const sides = n >= 3 ? Math.min(n, 6) : 0;
 // the ladder is MONOTONE ("the 2 pin circle is still bigger than the
 // rest"): a two-party bolt sits at the plain dot's size, under every
 // nut — the bare PIN_DOT_LIVE_R would put the pair a step above the
 // hexagon. Gold and the bigger core still say "bolted".
 const rad = sides ? PIN_DOT_R * 1.12 : (n === 2 ? PIN_DOT_R : 0);
 drawPinDot(ctx, p.x, p.y, pinIsLive(opts.occupied, p.x, p.y), rad, sides);
 }
 for (const run of runs) drawRope(ctx, run, opts);
}

// The sim's rod records as draw defs: authored kind/weight/chain, LIVE
// coordinates, and the authored part carried along for `ropeRuns` to key
// topology on. Four callers had this spread written out by hand; only the
// `part` is new, and leaving it off any one of them would have that view's
// ropes shudder apart under load and nowhere else.
export const liveRods = (rods) =>
 rods.map((r) => ({ ...r.part, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, part: r.part }));

// ---------- goal pieces & props ----------

// ---------- the light on a loose piece (§10.1) ----------
//
// The same law as a slab and a wheel, on a body that can be at any angle: the
// piece's own silhouette, clipped to itself and filled twice — once shifted
// down-light with the occlusion ink, once shifted up-light with the key. The
// SHIFT is in world coordinates and the SHAPE is in the piece's, which is why
// the transform is unwound and rewound around each fill: a crate lying on its
// side must be lit from the same place as the crate standing next to it.
//
// `build(ctx)` lays the piece's outline in its LOCAL frame — the same call the
// body already makes, so a shape can never be lit as something other than
// itself. The caller is already translated to the piece and NOT rotated.
const PIECE_OCC_D = 0.22, PIECE_OCC_A = 0.22; // fractions of the half-extent
const PIECE_KEY_D = 0.26, PIECE_KEY_A = 0.20;
const PIECE_SEAT_D = 0.10, PIECE_SEAT_A = 0.24;

// **How much of a piece its light may claim** (2026-08-23, on report: *"Huge
// things don't need huge bevels and huge lighted edges. Grow in relation to ln
// of size?"* — and ln is exactly right, for a reason worth writing down). The
// lit lip and the seat shadow are fractions of the half-extent, which reads
// correctly across the ladder and then keeps going: a 400 px-half crate wore a
// 104 px key lip, a quarter of the piece painted as "edge".
//
// Below LIGHT_REF the extent passes through untouched — every ladder-rung
// piece keeps the look the fractions were tuned on. Above it the growth is
// logarithmic, and the JOIN IS SEAMLESS: d/de of REF·(1 + ln(e/REF)) is REF/e,
// which is exactly 1 at e = REF — the natural log is the one curve whose slope
// there matches the linear branch, so there is no kink for the eye to find at
// the boundary and no piece size where the rule visibly switches on.
//
// LIGHT_REF is 2×STD_WHEEL_R = 40: the half-extent of a standard-rung terrain
// box and the radius of the ladder's largest wheel — the biggest thing the
// look was ever tuned against.
export const LIGHT_REF = STD_WHEEL_R * 2;
export const litExtent = (e) => (
 e <= LIGHT_REF ? e : LIGHT_REF * (1 + Math.log(e / LIGHT_REF)));

function pieceLight(ctx, build, angle, ext) {
 const a0 = ctx.globalAlpha;
 ctx.save();
 ctx.rotate(angle);
 ctx.beginPath(); build(ctx);
 ctx.clip();
 ctx.rotate(-angle);
 const lit = litExtent(ext);
 const pass = (d, col, al) => {
 ctx.save();
 ctx.translate(LIGHT.x * lit * d, LIGHT.y * lit * d);
 ctx.rotate(angle);
 ctx.beginPath(); build(ctx);
 ctx.globalAlpha = a0 * al;
 ctx.fillStyle = col;
 ctx.fill();
 ctx.restore();
 };
 pass(PIECE_OCC_D, LIGHT.occ, PIECE_OCC_A);
 pass(-PIECE_KEY_D, LIGHT.key, PIECE_KEY_A);
 ctx.restore();
}

// The shadow a loose piece drops on whatever is under it, following its SHAPE
// rather than a circle — a crate should not sit in a round puddle. Drawn
// before the body, in the world frame, at the same offset everything else in
// the scene is lit from.
function pieceSeat(ctx, build, angle, ext) {
 const a0 = ctx.globalAlpha;
 const lit = litExtent(ext);
 ctx.save();
 ctx.translate(LIGHT.x * lit * PIECE_SEAT_D, LIGHT.y * lit * PIECE_SEAT_D);
 ctx.rotate(angle);
 ctx.beginPath(); build(ctx);
 ctx.globalAlpha = a0 * PIECE_SEAT_A;
 ctx.fillStyle = LIGHT.occ;
 ctx.fill();
 ctx.restore();
}

function roundRectPath(ctx, hw, hh, r) {
 ctx.beginPath();
 if (r < 1) { ctx.rect(-hw, -hh, hw * 2, hh * 2); return; }
 ctx.moveTo(-hw + r, -hh);
 ctx.arcTo(hw, -hh, hw, hh, r);
 ctx.arcTo(hw, hh, -hw, hh, r);
 ctx.arcTo(-hw, hh, -hw, -hh, r);
 ctx.arcTo(-hw, -hh, hw, -hh, r);
 ctx.closePath();
}

export function drawGoalPiece(ctx, g, pose, opts = {}) {
 const x = pose ? pose.x : g.x, y = pose ? pose.y : g.y;
 // live pose angle when simulating; the authored spawn angle otherwise
 // (edit-time goalPositions carry x/y only)
 const angle = (pose && pose.angle != null) ? pose.angle : (g.angle || 0);
 const outline = (c) => {
 if (g.shape === 'ball') c.arc(0, 0, g.r, 0, Math.PI * 2);
 else roundRectPath(c, g.w / 2, g.h / 2, cornerRadiusOf(g));
 };
 const ext = g.shape === 'ball' ? g.r : Math.max(g.w, g.h) / 2;
 ctx.save();
 ctx.translate(x, y);
 if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
 // The cargo in the future is hollow too, but it keeps MORE than the other
 // pieces do: where the cargo ends up is the whole question the mode exists
 // to answer, so it holds a full-strength outline and a dashed inner ring
 // rather than a single line. No seat — a prediction is not resting on
 // anything yet.
 if (opts.ghost) {
 const ink = densityShade(COLORS.goalDark, g.density);
 ctx.rotate(angle);
 ctx.globalAlpha = (opts.alpha ?? 1) * 0.34;
 ctx.beginPath(); outline(ctx);
 ctx.lineWidth = PIECE_OUTLINE + 2.6; ctx.strokeStyle = '#ffffff'; ctx.stroke();
 ctx.globalAlpha = opts.alpha ?? 1;
 ctx.beginPath(); outline(ctx);
 // Heavier than the machine's 1.9. With everything hollow, LINE WEIGHT is
 // what says which mark matters — and where the cargo ends up is the whole
 // question the mode exists to answer, so it is the heaviest line in the
 // prediction.
 ctx.lineWidth = 3.0; ctx.strokeStyle = ink; ctx.stroke();
 ctx.beginPath();
 if (g.shape === 'ball') ctx.arc(0, 0, Math.max(g.r * 0.58, 2), 0, Math.PI * 2);
 else roundRectPath(ctx, Math.max(g.w / 2 - 5, 2), Math.max(g.h / 2 - 5, 2), cornerRadiusOf(g));
 ctx.lineWidth = 1.1; ctx.setLineDash([3.5, 4]); ctx.strokeStyle = ink;
 ctx.stroke(); ctx.setLineDash([]);
 ctx.restore();
 return;
 }
 pieceSeat(ctx, outline, angle, ext);
 ctx.rotate(angle);
 const fill = densityShade(COLORS.goal, g.density);
 const edge = densityShade(COLORS.goalDark, g.density);
 if (g.shape === 'ball') {
 ctx.beginPath();
 ctx.arc(0, 0, g.r, 0, Math.PI * 2);
 ctx.fillStyle = fill; // flat, no shine
 ctx.fill();
 ctx.lineWidth = PIECE_OUTLINE;
 ctx.strokeStyle = edge;
 ctx.stroke();
 } else {
 const hw = g.w / 2, hh = g.h / 2, cr = cornerRadiusOf(g);
 roundRectPath(ctx, hw, hh, cr);
 ctx.fillStyle = fill;
 ctx.fill();
 ctx.lineWidth = PIECE_OUTLINE;
 ctx.strokeStyle = edge;
 ctx.stroke();
 }
 // **The honeycomb goes on first**, clipped to the piece and under everything
 // else: it is the surface the races are cut into, not a mark laid over them.
 // Skipped where a cell would be bigger than the piece it is meant to texture
 // — on an r 2 goal ball a single hex wall crossing the face reads as a scratch
 // rather than as a material.
 {
 const half = g.shape === 'ball'
 ? { x: g.r, y: g.r }
 : { x: g.w / 2, y: g.h / 2 };
 if (hexFits(Math.min(half.x, half.y))) {
 ctx.save();
 if (g.shape === 'ball') { ctx.beginPath(); ctx.arc(0, 0, g.r, 0, Math.PI * 2); }
 else roundRectPath(ctx, g.w / 2, g.h / 2, cornerRadiusOf(g));
 ctx.clip();
 drawHoneycomb(ctx, half, edge, HEX_ALPHA);
 ctx.restore();
 }
 }
 // **A goal piece is machined like a wheel** (2026-08-12, on request): the same
 // race and the same detents, repeated inward to fill the face (§6.2). The
 // single white inner frame line this replaces was the ancestor of it — it
 // existed to say "the crate pins sit here", which a channel with a detent at
 // every slot says properly, and for every ring rather than one.
 //
 // The rings come from `goalRings`, the pins below from `goalPinOffsets`, and
 // both are expansions of the same function — so a detent cannot land where a
 // pin is not.
 {
 for (const ring of goalRings(g)) {
 // Shaded off the piece's FILL, not its edge — that is the relationship a
 // wheel's groove has to its body, and shading off the already-dark edge
 // would darken twice and lose the channel against the outline.
 if (ring.pts) drawFrameGroove(ctx, ring, Math.max(cornerRadiusOf(g) - (g.w / 2 - ring.a), 0), GROOVE_W, fill);
 else drawGroove(ctx, ring, GROOVE_W, fill, g.r);
 }
 drawCenterCross(ctx, fill, ext);
 }
 // **Unrotated offsets** — `ctx.rotate(angle)` above has already put us in the
 // crate's frame, and `goalPinOffsets` rotates by `g.angle` itself (it has to:
 // `goalPins` builds WORLD coordinates from it, and that is what snapping and
 // jointing match on). Passing the piece through as-is applied the rotation
 // twice, so on a tilted crate the drawn dots sat somewhere the pins are not —
 // a 60×30 crate at 45° drew its corner pin at (−12, 27) while the real pin
 // was at (10.6, 27.6). Only the DOTS were wrong; snapping was always right,
 // which is exactly why it read as the pins being out of sync with the piece.
 //
 // Wheels never had this: `wheelPinOffsets(r)` takes no angle, so there is
 // nothing for a canvas rotation to double up on.
 // Occupancy is asked in world coordinates off the START pose (staged drag,
 // else authored), not the live sim pose: a crate on its way to the goal
 // still has the joints it started with, and reading `_pose` would flicker.
 // `pinOrigin` is that start; without it the authored centre is the start.
 // …and on a TILTED crate the drawn offset and the world one are different
 // lists — the canvas is already rotated, so the dot goes at the unrotated
 // offset while the pin it asks about is at the rotated one. Same index, two
 // frames; conflating them would light up the wrong corner.
 const flat = goalPinOffsets({ ...g, angle: 0 });
 const world = g.angle ? goalPinOffsets(g) : flat;
 const originX = opts.pinOrigin?.x ?? g.x, originY = opts.pinOrigin?.y ?? g.y;
 for (let i = 0; i < flat.length; i++) {
 const live = pinIsLive(opts.occupied, originX + world[i][0], originY + world[i][1]);
 // The channel and its detents ARE the empty marks — the centre's own
 // mark is the cross drawn above. A bead is a CONNECTION: only slots
 // that actually share a joint light up.
 if (!live) continue;
 drawPinDot(ctx, flat[i][0], flat[i][1], true);
 }
 // the light, in the world frame — the cargo is lit by the same sun as the
 // slab it is standing on and the wheel that is about to hit it
 ctx.rotate(-angle);
 pieceLight(ctx, outline, angle, ext);
 ctx.restore();
}

export function drawProp(ctx, p, pose, opts = {}) {
 const x = pose ? pose.x : p.x, y = pose ? pose.y : p.y;
 const angle = pose ? (pose.angle || 0) : (p.angle || 0);
 // the piece's own outline, in its local frame, named once so the body, the
 // seat under it and the light on it can never be three different shapes
 const outline = (c) => {
 if (p.shape === 'ball') c.arc(0, 0, p.r, 0, Math.PI * 2);
 else roundRectPath(c, p.w / 2, p.h / 2, cornerRadiusOf(p));
 };
 const ext = p.shape === 'ball' ? p.r : Math.max(p.w, p.h) / 2;
 ctx.save();
 ctx.translate(x, y);
 if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
 // a GHOST prop (§5.2 GHOSTPROP) is half-there on purpose: sticks pass
 // through it, so it wears the ghost's own faded body — and a dashed edge
 // below, the same sentence ghost sticks speak
 if (p.ghost) ctx.globalAlpha = (opts.alpha ?? 1) * 0.45;
 pieceSeat(ctx, outline, angle, ext);
 ctx.rotate(angle);
 // **A texture, if the prop has one** (2026-08-12). Untextured is still the
 // default and still exactly what it was — `p.texture` absent means the plain
 // orange, so every level that exists is untouched.
 //
 // The pattern is in the piece's LOCAL frame, because `ctx.rotate` above has
 // already happened: the stripes turn with the crate, which is what makes it a
 // painted object rather than a hole cut in a backdrop. `densityShade` still
 // owns the outline (see propEdgeOf) so weight stays readable across the set.
 const pat = isPropTexture(p.texture) ? propPattern(ctx, p.texture, opts.t || 0) : null;
 ctx.fillStyle = pat || densityShade(COLORS.prop, p.density); // plain = clean, untextured
 ctx.strokeStyle = pat ? propEdgeOf(p) : densityShade(COLORS.propDark, p.density);
 // One outline weight at every size. A radius-proportional stroke turned a
 // big boulder into a piece with a 13 px rim while the crate beside it kept
 // 2.2 — the outline is a drawing convention, not a feature of the object,
 // so it stays put as the prop grows. Boxes were already constant; this is
 // the ball matching them.
 ctx.lineWidth = PIECE_OUTLINE;
 if (p.shape === 'ball') {
 ctx.beginPath();
 ctx.arc(0, 0, p.r, 0, Math.PI * 2);
 ctx.fill();
 ctx.stroke();
 } else {
 roundRectPath(ctx, p.w / 2, p.h / 2, cornerRadiusOf(p));
 ctx.fill();
 ctx.stroke();
 }
 if (p.ghost) {
 ctx.globalAlpha = opts.alpha ?? 1;
 ctx.setLineDash([5, 4]);
 ctx.strokeStyle = COLORS.ghost;
 ctx.lineWidth = 1.6;
 ctx.beginPath();
 outline(ctx);
 ctx.stroke();
 ctx.setLineDash([]);
 }
 // Attachment pins. A `fixed` one hinges the prop on the world (§5.6) and
 // keeps the original gold centre; a plain one is only a connection point for
 // machine parts, drawn hollow so the two are never confused at a glance.
 //
 // Drawn INSIDE the pose transform, in the prop's local frame, so they ride
 // the live body during play. Pin coordinates are stored absolute against the
 // AUTHORED pose (§5.6), so each has to be converted to an offset first —
 // drawing them at their stored coordinates left them hanging in mid-air the
 // moment the prop moved, which in play is immediately.
 const ca = Math.cos(-(p.angle || 0)), sa = Math.sin(-(p.angle || 0));
 for (const pin of propPins(p)) {
 const dx = pin.x - p.x, dy = pin.y - p.y;
 const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
 ctx.beginPath();
 ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
 // A `fixed` pin was already gold, and that turns out to be the same
 // sentence the rest of the game now says with it: this pin is holding
 // something. So a plain pin with a stick on it takes the gold core too,
 // and only a pin with nothing on it stays hollow.
 if (pin.fixed || pinIsLive(opts.occupied, pin.x, pin.y)) {
 ctx.fillStyle = COLORS.pinDark;
 ctx.fill();
 ctx.beginPath();
 ctx.arc(lx, ly, 1.2, 0, Math.PI * 2);
 ctx.fillStyle = COLORS.pinLive;
 ctx.fill();
 } else {
 ctx.fillStyle = COLORS.pinLight;
 ctx.fill();
 ctx.lineWidth = 1.1;
 ctx.strokeStyle = COLORS.pinDark;
 ctx.stroke();
 }
 }
 // …and the light, back in the world frame. A prop was a pattern-filled
 // rounded rect and nothing else: identical treatment for a rubber crate and
 // a carbon one, no bevel, no response at the silhouette — a sticker rather
 // than an object. This is the same two fills a slab and a wheel get, so all
 // three now agree about where the sun is.
 ctx.rotate(-angle);
 pieceLight(ctx, outline, angle, ext);
 ctx.restore();
}

// ---------- PROP TEXTURES (2026-08-12) ----------
//
// Sixteen, on request, and *"noticeably different from any terrain ones"*. That
// is a constraint on the whole set rather than on each entry, and it is met two
// ways at once:
//
// * **Palette.** Terrain is a world: greys, browns, greens, sand, ice, one
// lava and one neon. Props are MANUFACTURED — saturated, synthetic colours
// no hillside has. Nothing here is a grey or an earth tone.
// * **Motif.** A terrain tile is speckle: random blotches, grain, sparkle,
// with at most a line grid or a brick bond laid over it. Every prop tile is
// a REGULAR pattern instead — stripes, dots, checks, scales, weave. Speckle
// reads as material seen from far away; pattern reads as a made object, and
// that is the difference a player has to spot at a glance while a crate
// rolls past.
//
// Cheap, and MEASURED, because probe-cost.mjs's finding is that the renderer is
// what caps a level. The tile is built once per texture (`propTileCache`) and
// the CanvasPattern once per texture (`propPatternCache`), so a prop costs one
// `fillStyle =` and the fill it was already doing — nothing is rebuilt per
// frame, per prop, or per size.
//
// At the 200-prop cap, one full pass: **0.42 ms plain, 0.32 ms candy, 0.66 ms
// plasma** (Chrome, 60×60 crates). A textured prop is inside the noise of an
// untextured one, and the animated ones cost about 0.2 ms per 200 — around 1.5%
// of a 16 ms frame for a level made entirely of moving crates.
//
// **Three of them move**, which costs a `setTransform` on an already-built
// pattern and nothing else — no second tile, no per-frame drawing, no clock
// beyond the `t` the conveyor belts already take. `scroll` is px/sec.
const PROP_TEX = {
 // barber-pole diagonals — the sweetshop end of the set
 // `w` is 8 because 2·w must DIVIDE the 64 px tile — see the `stripe` case
 candy: { base: '#ffd7e8', edge: '#c14d80', kind: 'stripe', a: '#ff5c9e', w: 8 },
 // the one everybody reads instantly: DANGER, do not stand under it
 hazard: { base: '#ffca18', edge: '#8a6a00', kind: 'stripe', a: '#1d1d1d', w: 8 },
 chevron: { base: '#ffe2c2', edge: '#c26a24', kind: 'chevron', a: '#ff8b28' },
 polka: { base: '#3fc8e8', edge: '#1a7c94', kind: 'dots', a: '#ffffff', r: 5.5 },
 checker: { base: '#ff43c8', edge: '#9c1479', kind: 'check', a: '#ffffff', n: 4 },
 scales: { base: '#17a97e', edge: '#0a5f46', kind: 'scales', a: '#3fd3a4', b: '#0d7d5c' },
 denim: { base: '#3a5a9c', edge: '#1d3563', kind: 'weave', a: '#4d70bb', b: '#2b4478', w: 4 },
 carbon: { base: '#2a2d33', edge: '#0d0f12', kind: 'weave', a: '#3a3f47', b: '#1b1e22', w: 6 },
 marble: { base: '#f4f1ea', edge: '#a8a093', kind: 'veins', a: '#b9b2a4', b: '#d8d2c6' },
 bubbles: { base: '#7fe3e0', edge: '#2b8f8c', kind: 'bubbles', a: '#ffffff' },
 citrus: { base: '#ff9f1c', edge: '#b45f00', kind: 'segments', a: '#ffd88a', b: '#ffffff' },
 studs: { base: '#e03b2f', edge: '#8d1b13', kind: 'studs', a: '#ff6b5e', b: '#a82219' },
 stars: { base: '#1b1f5c', edge: '#0a0c2e', kind: 'stars', a: '#ffd85e', b: '#8f9bff' },
 // the movers
 circuit: { base: '#10262b', edge: '#0a171a', kind: 'circuit', a: '#3dffa8', b: '#1f6b55', scroll: { x: 0, y: 14 } },
 plasma: { base: '#4a1f8f', edge: '#26104d', kind: 'plasma', a: '#c46bff', b: '#6be0ff', scroll: { x: 18, y: -11 } },
 holo: { base: '#dfe6ff', edge: '#7a86b8', kind: 'holo', scroll: { x: 26, y: 0 } },
};
// The LOOKS live here; the vocabulary lives in sizes.js, where the server can
// reach it without importing a renderer. §15 asserts the two lists are
// identical — a texture that draws but cannot be saved, or saves but cannot
// draw, is the half-wired failure split ownership always produces.
export const PROP_TEX_LOOKS = Object.keys(PROP_TEX);
export const isPropTexture = (name) => Object.prototype.hasOwnProperty.call(PROP_TEX, name);

const PROP_TILE = 64; // px; every motif below tiles on it
const propTileCache = new Map();
const propPatternCache = new Map();

// The tile. Built once per name — the motifs are all regular, so the only ones
// needing the 9-offset wrap trick terrain uses are the two with random
// placement (`veins`, `bubbles`); everything else tiles by construction.
export function propTextureTile(name) {
 if (propTileCache.has(name)) return propTileCache.get(name);
 const spec = PROP_TEX[name] || PROP_TEX.candy;
 const S = PROP_TILE;
 const cv = document.createElement('canvas');
 cv.width = cv.height = S;
 const c = cv.getContext('2d');
 const rand = seedRand(name.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 11) | 0);
 c.fillStyle = spec.base;
 c.fillRect(0, 0, S, S);
 const wrapped = (draw) => {
 for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
 c.save(); c.translate(ox, oy); draw(); c.restore();
 }
 };
 switch (spec.kind) {
 // 45° bars, drawn as filled PARALLELOGRAMS rather than stroked lines.
 //
 // A stroked diagonal does not tile: its ends are capped and its period has
 // nothing to do with the tile, so the first version showed the tile grid
 // straight through the pattern as a plaid of seams. Filling the bar exactly
 // and stepping by a period that DIVIDES the tile fixes both — over the
 // height of the tile a 45° bar shifts sideways by exactly S, so the pattern
 // meets itself at the edge iff `2·w` divides S. That is why the widths in
 // the table are 8 and not 9: it is arithmetic, not taste.
 case 'stripe': {
 const p = spec.w * 2;
 c.fillStyle = spec.a;
 for (let k = -S; k < S * 2; k += p) {
 c.beginPath();
 c.moveTo(k, 0); c.lineTo(k + spec.w, 0);
 c.lineTo(k + spec.w + S, S); c.lineTo(k + S, S);
 c.closePath();
 c.fill();
 }
 break;
 }
 case 'chevron': {
 c.save();
 c.strokeStyle = spec.a;
 c.lineWidth = 6;
 c.lineJoin = 'miter';
 for (let y = -S; y < S * 2; y += 16) {
 c.beginPath();
 for (let x = 0; x <= S; x += S / 2) { c.lineTo(x, y + (x / (S / 2) % 2 ? 8 : 0)); }
 c.stroke();
 }
 c.restore();
 break;
 }
 // A staggered grid — four to a tile, offset row to row, which is the
 // arrangement that stops a dot field reading as rows and columns. Two per
 // tile was the first try and an ordinary 86 px crate showed barely two
 // dots on it, which reads as a blemish rather than as a pattern.
 case 'dots': {
 c.fillStyle = spec.a;
 for (const [cx, cy] of [[S * 0.125, S * 0.125], [S * 0.625, S * 0.125],
 [S * 0.375, S * 0.625], [S * 0.875, S * 0.625]]) {
 wrapped(() => { c.beginPath(); c.arc(cx, cy, spec.r, 0, Math.PI * 2); c.fill(); });
 }
 break;
 }
 case 'check': {
 c.fillStyle = spec.a;
 const q = S / spec.n;
 for (let i = 0; i < spec.n; i++) {
 for (let j = 0; j < spec.n; j++) if ((i + j) % 2) c.fillRect(i * q, j * q, q, q);
 }
 break;
 }
 // overlapping half-discs, brick-offset per row — a fish/dragon skin
 case 'scales': {
 const r = S / 4;
 for (let row = 0; row < 4; row++) {
 for (let col = -1; col < 5; col++) {
 const cx = col * r * 2 + (row % 2 ? r : 0), cy = row * r * 1.35;
 wrapped(() => {
 c.beginPath();
 c.arc(cx, cy, r, 0, Math.PI);
 c.fillStyle = row % 2 ? spec.a : spec.b;
 c.fill();
 });
 }
 }
 break;
 }
 // over-under twill: the same two bars on both axes, which is what makes
 // denim denim and carbon fibre carbon fibre at two different scales
 case 'weave': {
 const w = spec.w;
 for (let i = 0; i < S; i += w * 2) {
 c.fillStyle = spec.a; c.fillRect(i, 0, w, S);
 c.fillStyle = spec.b; c.fillRect(0, i + w, S, w);
 }
 break;
 }
 // Marble wants MORE vein than looks right in a swatch: seven faint ones on
 // a 64 px tile came out as a clean cream crate with a scratch on it. Twice
 // as many, and darker, is what reads as stone at the size a prop is.
 case 'veins': {
 c.lineCap = 'round';
 for (let i = 0; i < 14; i++) {
 const x0 = rand() * S, y0 = rand() * S;
 const col = i % 2 ? spec.a : spec.b;
 wrapped(() => {
 c.beginPath();
 c.moveTo(x0, y0);
 let x = x0, y = y0;
 for (let k = 0; k < 4; k++) {
 x += (rand() - 0.5) * 30; y += (rand() - 0.5) * 30;
 c.lineTo(x, y);
 }
 c.strokeStyle = col;
 c.lineWidth = 1 + rand() * 2.4;
 c.globalAlpha = 0.9;
 c.stroke();
 });
 }
 c.globalAlpha = 1;
 break;
 }
 case 'bubbles': {
 for (let i = 0; i < 9; i++) {
 const x = rand() * S, y = rand() * S, r = 3 + rand() * 8;
 wrapped(() => {
 c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
 c.strokeStyle = spec.a; c.lineWidth = 1.6; c.globalAlpha = 0.85; c.stroke();
 c.globalAlpha = 0.22; c.fillStyle = spec.a; c.fill();
 });
 }
 c.globalAlpha = 1;
 break;
 }
 // citrus: wedges radiating from each corner, so the fruit reads whole
 // wherever the tile is cut
 case 'segments': {
 for (const [cx, cy] of [[0, 0], [S, 0], [0, S], [S, S], [S / 2, S / 2]]) {
 for (let k = 0; k < 8; k++) {
 const a0 = k * Math.PI / 4 + 0.08, a1 = (k + 1) * Math.PI / 4 - 0.08;
 c.beginPath();
 c.moveTo(cx, cy);
 c.arc(cx, cy, S / 3.2, a0, a1);
 c.closePath();
 c.fillStyle = k % 2 ? spec.a : spec.b;
 c.globalAlpha = 0.55;
 c.fill();
 }
 }
 c.globalAlpha = 1;
 break;
 }
 // moulded plastic: a stud grid with a lit top-left and a shaded underside,
 // which is the whole of why a brick reads as 3D at any size
 case 'studs': {
 const q = S / 2;
 for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
 const cx = i * q + q / 2, cy = j * q + q / 2;
 c.beginPath(); c.arc(cx, cy + 1.5, q * 0.3, 0, Math.PI * 2);
 c.fillStyle = spec.b; c.fill();
 c.beginPath(); c.arc(cx, cy, q * 0.3, 0, Math.PI * 2);
 c.fillStyle = spec.a; c.fill();
 c.beginPath(); c.arc(cx - q * 0.09, cy - q * 0.09, q * 0.14, 0, Math.PI * 2);
 c.fillStyle = 'rgba(255,255,255,.45)'; c.fill();
 }
 break;
 }
 case 'stars': {
 const star = (cx, cy, r, col) => {
 c.beginPath();
 for (let k = 0; k < 10; k++) {
 const rad = k % 2 ? r * 0.44 : r;
 const a = -Math.PI / 2 + k * Math.PI / 5;
 c.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
 }
 c.closePath();
 c.fillStyle = col; c.fill();
 };
 for (const [x, y, r, col] of [[S * 0.28, S * 0.3, 8, spec.a], [S * 0.75, S * 0.68, 6, spec.a],
 [S * 0.72, S * 0.2, 3.4, spec.b], [S * 0.2, S * 0.78, 3, spec.b]]) {
 wrapped(() => star(x, y, r, col));
 }
 break;
 }
 // board traces and pads. The tile is deliberately a LADDER up the y axis so
 // the scroll below reads as current flowing rather than as the piece
 // sliding around inside its own outline.
 case 'circuit': {
 c.strokeStyle = spec.b; c.lineWidth = 2;
 for (const x of [S * 0.2, S * 0.5, S * 0.8]) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, S); c.stroke(); }
 c.beginPath(); c.moveTo(S * 0.2, S * 0.3); c.lineTo(S * 0.5, S * 0.3); c.stroke();
 c.beginPath(); c.moveTo(S * 0.5, S * 0.7); c.lineTo(S * 0.8, S * 0.7); c.stroke();
 c.fillStyle = spec.a;
 for (const [x, y] of [[S * 0.2, S * 0.3], [S * 0.5, S * 0.7], [S * 0.8, S * 0.15], [S * 0.5, S * 0.3]]) {
 c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill();
 }
 break;
 }
 case 'plasma': {
 for (let i = 0; i < 6; i++) {
 const x = rand() * S, y = rand() * S, r = 14 + rand() * 16;
 const col = i % 2 ? spec.a : spec.b;
 wrapped(() => {
 const g = c.createRadialGradient(x, y, 0, x, y, r);
 g.addColorStop(0, col);
 g.addColorStop(1, 'rgba(0,0,0,0)');
 c.fillStyle = g;
 c.globalAlpha = 0.55;
 c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
 });
 }
 c.globalAlpha = 1;
 break;
 }
 // Iridescence: a FULL hue cycle across the tile, so the last stop is the
 // same colour as the first and the bands meet themselves at the edge.
 // Diagonal was the first attempt and it tiled as hard rainbow blocks — a
 // gradient across a square is seamless only along the axis it runs on, and
 // 0…360 is what makes even that axis join. Scrolled sideways it is the
 // oil-slick shift a holographic sticker does when you tilt it.
 case 'holo': {
 const g = c.createLinearGradient(0, 0, S, 0);
 for (let k = 0; k <= 12; k++) g.addColorStop(k / 12, `hsl(${k * 30} 95% 76%)`);
 c.fillStyle = g;
 c.fillRect(0, 0, S, S);
 break;
 }
 }
 propTileCache.set(name, cv);
 return cv;
}

// The pattern, built once and reused. `t` seconds only matters for the three
// with `scroll`, and it moves the PATTERN rather than the piece — the fill and
// the outline stay exactly where the physics put them.
export function propPattern(ctx, name, t = 0) {
 const spec = PROP_TEX[name];
 if (!spec) return null;
 let pat = propPatternCache.get(name);
 if (!pat) {
 pat = ctx.createPattern(propTextureTile(name), 'repeat');
 if (!pat) return null;
 propPatternCache.set(name, pat);
 }
 // `DOMMatrix` is guarded rather than assumed: a browser without it (or a
 // headless context) gets a perfectly good STILL texture instead of a thrown
 // error, which is the right way for decoration to degrade.
 if (spec.scroll && pat.setTransform && typeof DOMMatrix !== 'undefined') {
 // wrapped into one tile, so the offset never grows: a run left going for
 // ten minutes would otherwise hand the compositor a translation in the tens
 // of thousands of px for no visible difference.
 const wrap = (v) => ((v % PROP_TILE) + PROP_TILE) % PROP_TILE;
 pat.setTransform(new DOMMatrix([1, 0, 0, 1, wrap(spec.scroll.x * t), wrap(spec.scroll.y * t)]));
 }
 return pat;
}

// A prop's edge colour: the texture's own, still density-shaded, so a heavy
// candy crate is a darker candy crate exactly as a heavy plain one is darker.
export const propEdgeOf = (p) => densityShade(PROP_TEX[p.texture]?.edge || COLORS.propDark, p.density);

// The picker's swatch (game.js), rendered at whatever the cell is.
export function propTextureSwatchURL(name, w = 26, h = w) {
 const cv = document.createElement('canvas');
 cv.width = w; cv.height = h;
 const c = cv.getContext('2d');
 const pat = c.createPattern(propTextureTile(name), 'repeat');
 if (pat) { c.fillStyle = pat; c.fillRect(0, 0, w, h); }
 const spec = PROP_TEX[name];
 if (spec?.edge) { c.strokeStyle = spec.edge; c.lineWidth = 2; c.strokeRect(1, 1, w - 2, h - 2); }
 return cv.toDataURL();
}

// **Which way a piece falls, drawn on it — Create only** (§5.10).
//
// A piece's `gravity` is the one setting in the editor with no visible
// consequence until you press Play: Density shades the piece (`densityShade`),
// a texture is the piece's own surface, a pin is a dot — but a piece that falls
// upward looks exactly like one that doesn't, and an author laying out a level
// has no way to see which is which. So the dial gets a mark, on the same terms
// as the gravity FIELD's lattice: authored information, shown while editing and
// gone in play, where the piece answers the question by moving.
//
// Props and goal pieces both, since 2026-08-14 — and the goal piece is the one
// that needed it most, being the piece a level is ABOUT. `pose` is separate
// from `def` for exactly that reason: a goal piece's live position is the
// editor's `goalPositions`, not its authored x/y, the same split
// `drawGoalPiece` takes.
//
// **It points along the local field, not at the screen.** On a planet level
// "up" is a different direction for every prop, and an arrow that always
// pointed at the top of the screen would be lying about exactly the levels
// where the answer is hard to work out — so it takes `downAt` like everything
// else that has to know which way down is.
//
// Nothing is drawn at 1×. The ordinary case is the one that must stay quiet, or
// every level in the game grows arrows overnight.
export const GRAV_MARK_MIN_HALF = 5; // px — a piece under this is too small to carry one
export const GRAV_MARK_MAX = 18; // px — and a boulder-sized one stops growing here
export function drawPieceGravity(ctx, p, pose, planets) {
 const g = pieceGravityOf(p);
 if (g === PIECE_GRAVITY_DEFAULT) return false;
 const half = p.shape === 'ball' ? p.r : Math.min(p.w || 0, p.h || 0) / 2;
 if (!(half >= GRAV_MARK_MIN_HALF)) return false;
 const at = pose || p;
 const reach = Math.min(half * 0.72, GRAV_MARK_MAX);
 const d = downAt(at.x, at.y, planets && planets.length ? planets : []);
 ctx.save();
 ctx.translate(at.x, at.y);
 // local +y along the real down: (0,1) maps to (−sin a, cos a), so a is the
 // angle that sends it to d
 ctx.rotate(Math.atan2(-d.x, d.y));
 // Two passes, light under dark, for the same reason a pin has a rim: the
 // piece's fill is `densityShade`d across a 5-stop range and a single-colour
 // mark that reads on a 0.25× crate is lost on an 8× one.
 const paint = (path) => {
 ctx.lineCap = 'round'; ctx.lineJoin = 'round';
 ctx.lineWidth = 3.6; ctx.strokeStyle = 'rgba(255,255,255,.85)';
 path(); ctx.stroke();
 ctx.lineWidth = 1.6; ctx.strokeStyle = COLORS.ink;
 path(); ctx.stroke();
 };
 if (g === 0) {
 // Nothing pulls it, so there is no direction to point: a bar ACROSS the
 // fall line, which is the one mark that says "this does not fall" rather
 // than "this falls a very small amount".
 const w = reach * 0.85;
 paint(() => { ctx.beginPath(); ctx.moveTo(-w, 0); ctx.lineTo(w, 0); });
 } else {
 const s = g < 0 ? -1 : 1; // which end of the line the head is on
 // Length carries the magnitude, with a floor: at ±2 it is the full reach,
 // and the floor is there so a 0.5× arrow is still an arrow rather than a
 // smudge with a head on it.
 const len = reach * (0.4 + 0.6 * Math.min(Math.abs(g) / PIECE_GRAVITY_MAX, 1));
 const tip = s * len, tail = -s * len * 0.55;
 const hl = Math.min(len * 0.5, reach * 0.55), hw = hl * 0.62;
 paint(() => {
 ctx.beginPath();
 ctx.moveTo(0, tail); ctx.lineTo(0, tip);
 ctx.moveTo(-hw, tip - s * hl); ctx.lineTo(0, tip); ctx.lineTo(hw, tip - s * hl);
 });
 }
 ctx.restore();
 return true;
}

// ---------- the positional grid (§8.1) ----------

// Drawn only while a move is actually snapping to it, so it is feedback rather
// than furniture: hold the modifier and the nodes you can land on appear.
//
// `step` is the world-space snap step. What gets DRAWN may be coarser: at
// zoom 0.25 a 40 px grid is 10 screen px and turns to mush, so the drawn step
// climbs by the size ladder's own doubling (30 → 60 → 120) until a cell is at
// least MIN_CELL_PX across. The snap is unaffected — you still land on every
// node, the picture just stops trying to show all of them.
//
// `clip` is a list of world rects to confine it to (the build zones, while
// solving) or null for the whole viewport (authoring, where a piece may go
// anywhere). Rects may be rotated (§7.2a), so each is clipped in its own frame.
const MIN_CELL_PX = 14;

export function drawGrid(ctx, cam, step, clip) {
 if (!step) return;
 let s = step;
 while (s * cam.zoom < MIN_CELL_PX) s *= 2;
 const tl = cam.toWorld(0, 0), br = cam.toWorld(cam.vw, cam.vh);
 const x0 = Math.floor(tl.x / s) * s, x1 = Math.ceil(br.x / s) * s;
 const y0 = Math.floor(tl.y / s) * s, y1 = Math.ceil(br.y / s) * s;
 // a hard cap, so a pathological camera can never turn this into a hang
 if ((x1 - x0) / s > 400 || (y1 - y0) / s > 400) return;

 ctx.save();
 if (clip && clip.length) {
 ctx.beginPath();
 for (const r of clip) {
 if (!r) continue;
 if (r.angle) {
 const c = Math.cos(r.angle), sn = Math.sin(r.angle), hw = r.w / 2, hh = r.h / 2;
 const pt = (dx, dy) => [r.x + dx * c - dy * sn, r.y + dx * sn + dy * c];
 const p = [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
 ctx.moveTo(p[0][0], p[0][1]);
 for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]);
 ctx.closePath();
 } else {
 ctx.rect(r.x - r.w / 2, r.y - r.h / 2, r.w, r.h);
 }
 }
 ctx.clip();
 }
 ctx.strokeStyle = 'rgba(101,88,230,.22)'; // the BUILD zone's own hue
 ctx.lineWidth = 1 / cam.zoom; // one screen px at any zoom
 ctx.beginPath();
 for (let x = x0; x <= x1; x += s) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
 for (let y = y0; y <= y1; y += s) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
 ctx.stroke();
 // the origin reads differently, so a level always has one landmark that says
 // which way the grid is counting
 ctx.strokeStyle = 'rgba(101,88,230,.45)';
 ctx.lineWidth = 1.5 / cam.zoom;
 ctx.beginPath();
 ctx.moveTo(0, y0); ctx.lineTo(0, y1);
 ctx.moveTo(x0, 0); ctx.lineTo(x1, 0);
 ctx.stroke();
 ctx.restore();
}

// ---------- the background layer (§10.5) ----------
//
// Scenery with no physics: `level.backdrop` holds terrain-shaped pieces that
// the sim never sees, drawn smaller and paler so they read as distance.
//
// **A separate ARRAY, not a flag on terrain.** The sim builds a body for every
// entry in `level.terrain`, so a flag would mean a filter, and a filter is one
// bug away from a decoration that collides — silently, and only in play. An
// array the sim never iterates cannot do that, and it keeps §5.8 intact:
// construction order is still the stored order of the pieces that exist.
//
// Scaled about the WORLD ORIGIN rather than about the camera. Camera-relative
// scaling is true parallax and looks better in motion, but it moves the
// background against the foreground as you pan, so a scene composed in the
// editor comes apart the moment the view shifts — and composing scenery is the
// entire job here. This way the two layers hold their arrangement at every
// camera position, and the depth cue is the size and the fade.
export const BACKDROP_SCALE = 0.8; // one number to tune the perspective
export const BACKDROP_ALPHA = 0.55; // ...and one for how far away it reads

// ---------- what the player will never see (§10.7) ----------
//
// ONE rule, drawn in whatever frame the canvas is currently in: **red means the
// player will never see this.** A player's view is held inside ±`PLAY_BOUND`
// (camera.js), so that box is the whole of what "seen" means, and everything
// outside it is tinted.
//
// The two frames it gets asked in, and why the number differs:
//
// ±PLAY_BOUND world coordinates — the normal Maker view.
// Also exactly where the build fence sits, so
// the tint doubles as the mark on it.
// ±PLAY_BOUND/BACKDROP_SCALE the scenery layer's OWN coordinates, while
// the Maker has it swapped in for 1:1 editing
// (§10.5). The layer is drawn to the player
// scaled about the world origin, so its 5000
// lands on 4000 of world. Scenery may be any
// size — the tint is the only thing that
// stops at a number, and it is advice.
export const UNSEEN_TINT = 'rgba(226, 52, 52, 0.20)';

// Tint everything beyond ±half. Four rects rather than an even-odd path: the
// region is unbounded, so it is filled only out to the viewport's own corners,
// which is the only part of it that can be on screen — and they must not
// OVERLAP, or the corners double the alpha and read as a different rule. The
// two side bands are therefore trimmed to what the top and bottom left.
export function drawUnseen(ctx, cam, half) {
 const tl = cam.toWorld(0, 0), br = cam.toWorld(cam.vw, cam.vh);
 const x0 = Math.min(tl.x, br.x), x1 = Math.max(tl.x, br.x);
 const y0 = Math.min(tl.y, br.y), y1 = Math.max(tl.y, br.y);
 if (x0 >= -half && x1 <= half && y0 >= -half && y1 <= half) return; // wholly inside
 ctx.save();
 ctx.fillStyle = UNSEEN_TINT;
 if (y0 < -half) ctx.fillRect(x0, y0, x1 - x0, Math.min(y1, -half) - y0);
 if (y1 > half) ctx.fillRect(x0, Math.max(y0, half), x1 - x0, y1 - Math.max(y0, half));
 const my0 = Math.max(y0, -half), my1 = Math.min(y1, half);
 if (my1 > my0) {
 if (x0 < -half) ctx.fillRect(x0, my0, Math.min(x1, -half) - x0, my1 - my0);
 if (x1 > half) ctx.fillRect(Math.max(x0, half), my0, x1 - Math.max(x0, half), my1 - my0);
 }
 ctx.restore();
}

// THREE LAYERS, back to front: the animated sky (`drawBackdrop`), then this —
// a whole second level, running its own simulation — then the real world where
// the goal pieces are.
//
// `view` is that level's own `sim.view()` while it is running, or null for
// authored poses. Everything is drawn through the SAME functions the foreground
// uses, so a background level looks like a level rather than like an
// impression of one, and there is no second renderer to keep in step.
//
// **The fade is ONE composite, not a globalAlpha over every pass.** Setting
// globalAlpha and then drawing fill, texture and stroke on top of each other
// is not a fade: wherever two passes overlap the alphas stack back toward
// solid (0.55 five deep is 0.98), and a scenery slab that reads solid is the
// exact confusion the fade exists to prevent. So the layer is drawn at full
// strength into a scratch canvas and laid over the sky in a single pass —
// measured in a real browser: max alpha 251/255 the stacked way, ≤ 141 this
// way, which is 0.55 exactly.
// `scale`/`also` exist for ONE other caller: the Maker's scenery-edit toggle
// (§10.5) draws the REAL level as a reference ghost while the layer is being
// edited 1:1 — same composite, scale 1/BACKDROP_SCALE (which is exactly where
// the world sits relative to the layer's own coordinates), and `also(sctx)`
// adds the zones and goal pieces the three lists don't carry.
//
// **PARALLAX (2026-08-05), and it needed no new dial.** `pivot` is the camera's
// world centre; passing it scales the layer about the CAMERA instead of about
// the world origin, and that one change is the whole of parallax:
//
// about the origin screen = (p·s − c)·z — camera moves both layers by
// the same −c·z. No parallax.
// about the camera screen = (p − c)·s·z — the layer moves by −c·s·z,
// slower than the world by `s`.
//
// So the parallax factor IS the scale, and it has to be: apparent size and
// apparent motion both go as 1/distance, so a layer drawn at 0.8 that did not
// also move at 0.8 would be claiming two different distances at once. The
// existing `backScale` dial is the depth control — shrink, fade and now drift
// off the two numbers a level already stores.
//
// With the camera at the origin this is arithmetically identical to what it
// replaced, which is why every level composed before it still opens looking
// exactly as its author left it.
//
// The comment this replaces argued the other way — that origin-scaling keeps a
// composed scene together as you pan. It does, and that is also what made the
// depth cue die the moment anything moved: a background welded to the
// foreground reads as a flat painting on the same pane of glass. Composing
// against a reference position is what parallax costs, and it is the ordinary
// price of the effect.
let _backScratch = null;
export function drawBackLevel(ctx, back, view, time = 0, { alpha = BACKDROP_ALPHA, scale = BACKDROP_SCALE, also = null, pivot = null, haze = null } = {}) {
 if (!back) return;
 const hasAny = (back.terrain || []).length || (back.props || []).length
 || (back.fixedParts || []).length || (back.texts || []).length;
 if (!hasAny && !also) return;
 const W = ctx.canvas.width, H = ctx.canvas.height;
 if (!_backScratch) _backScratch = document.createElement('canvas');
 if (_backScratch.width !== W || _backScratch.height !== H) { _backScratch.width = W; _backScratch.height = H; }
 const s = _backScratch.getContext('2d');
 s.setTransform(1, 0, 0, 1, 0, 0);
 s.clearRect(0, 0, W, H);
 s.setTransform(ctx.getTransform()); // dpr + camera, whatever the caller set
 // scale about the camera's world centre when given one (parallax), about the
 // world origin when not — `pivot` null keeps the 1:1 scenery-edit ghost and
 // any other caller exactly as they were
 if (pivot) {
 s.translate(pivot.x, pivot.y);
 s.scale(scale, scale);
 s.translate(-pivot.x, -pivot.y);
 } else {
 s.scale(scale, scale);
 }
 // …and the layer's labels move too (§9.3). The scenery runs a whole
 // simulation of its own (`bgSim`), so `view.texts` exists here exactly as it
 // does for the foreground — passing the poses to the terrain and the machine
 // and not to the signs is how a moving sign on a distant wall stands still
 // while the wall it is painted on slides out from under it.
 const liveTexts = view ? view.texts : null;
 drawTexts(s, back, 'behind', undefined, liveTexts); // a sign on a distant wall (§10.6)
 drawTerrainAll(s, back, view ? view.terrain : null, time);
 drawTexts(s, back, 'over', undefined, liveTexts);
 if (view) {
 for (const p of view.props) drawProp(s, p.def, p);
 for (const w of wheelsBackToFront(view.wheels, (w) => w.part.r)) drawWheel(s, w.part, w, {}); // wheels behind rods, biggest first
 drawRods(s, liveRods(view.rods), {});
 } else {
 for (const p of (back.props || [])) drawProp(s, p, null);
 for (const part of wheelsBackToFront((back.fixedParts || []).filter((p) => p.t === 'wheel'))) drawWheel(s, part, { x: part.x, y: part.y }, {});
 drawRods(s, (back.fixedParts || []).filter((p) => p.t === 'rod'), {});
 }
 drawTexts(s, back, 'front', undefined, liveTexts);
 if (also) also(s);
 ctx.save();
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 // **Soft, not blurry** (2026-08-23, on report: *"The blurry background is
 // too blurry, it makes my eyes hurt. Try soft, not blurry."*). The fade used
 // to be TRANSLUCENCY — the whole layer blitted at 0.55 — so the sky ghosted
 // through every piece and the eye read the mush as defocus it kept trying to
 // resolve. With a `haze` colour the recession is applied INSIDE the layer
 // instead: a source-atop wash at (1 − alpha), then an OPAQUE blit. The
 // arithmetic is identical per pixel — 0.55·piece + 0.45·sky either way — so
 // the tonal distance is exactly what it was; what changes is that edges stay
 // solid and nothing shows through anything. Aerial perspective is how real
 // distance looks: far things are sky-coloured, not transparent.
 //
 // Only with a haze: the Maker's scenery-edit reference ghost passes none and
 // keeps real translucency, because a reference ghost MEANS see-through.
 if (haze) {
 s.save();
 s.setTransform(1, 0, 0, 1, 0, 0);
 s.globalCompositeOperation = 'source-atop';
 s.globalAlpha = 1 - alpha;
 s.fillStyle = haze;
 s.fillRect(0, 0, W, H);
 s.restore();
 ctx.globalAlpha = 1;
 } else ctx.globalAlpha = alpha;
 ctx.drawImage(_backScratch, 0, 0);
 ctx.restore();
}

// The colour distance wears, for the scenery haze: the level's own sky, read
// near the horizon where the layer actually stands. One place derives it so
// the renderer and any preview agree.
export function skyHazeOf(name) {
 const bg = BACKGROUNDS[bgOf(name)];
 return mixHex(bg.top, bg.bot, 0.65);
}

// ---------- text labels (§10.6) ----------
//
// A sign, a title, an instruction, a joke on a distant wall. Decoration with no
// body: the sim never hears about `level.texts` at all.
//
// The SCHEMA — fonts, palette, limits, and the validator — lives in
// textmodel.js, because the editor, this renderer and the server's own
// validation must agree on exactly one of it (the surfaces.js precedent). What
// is here is only what needs a canvas: measuring and drawing.

// ---------- measuring ----------
//
// A text piece has no authored w/h: its box is whatever the font makes of the
// string, so everything that needs one — the hit test, the selection outline,
// the resize handles, Fit, the thumbnail — has to MEASURE it. That happens
// exactly once per distinct (string, size, font, weight, style) and is cached,
// because `measureText` is the expensive call in the whole draw and the same
// label is measured on every frame it is selected.
//
// **The headless fallback is deliberate and approximate.** `verify-editor.mjs`
// runs with no document, so there is no canvas to measure with; it falls back to
// 0.55 em per character, which is close enough for the gates that ask about
// PLACEMENT and picking (they choose points well inside or well outside a box)
// and is never used in a browser. Anything asserting exact glyph metrics belongs
// in a real browser, not the suite.
const TEXT_EM_GUESS = 0.55;
let _measureCtx = null;
const _measureCache = new Map();

function measureCtx() {
 if (_measureCtx !== null) return _measureCtx;
 try {
 _measureCtx = document.createElement('canvas').getContext('2d');
 } catch { _measureCtx = false; } // no DOM: the fallback below owns it
 return _measureCtx;
}

// { w, h, lines, lineH, size } in world px. `w` is the widest line.
export function measureTextPiece(t) {
 const size = textSizeOf(t);
 const lines = textLines(t);
 const key = `${textFontKey(t)}|${size}|${t?.bold ? 1 : 0}|${t?.italic ? 1 : 0}|${lines.join('\n')}`;
 const hit = _measureCache.get(key);
 if (hit) return hit;
 const lineH = size * TEXT_LINE_H;
 const c = measureCtx();
 let w = 0;
 if (c) {
 c.font = textFontSpec(t, size);
 for (const ln of lines) w = Math.max(w, c.measureText(ln).width);
 } else {
 for (const ln of lines) w = Math.max(w, ln.length * size * TEXT_EM_GUESS);
 }
 // A single space of side padding and a hair of vertical, so the box a user
 // grabs is never tighter than the glyphs they can see (descenders, italic
 // overhang) — and so an empty string still has something to click.
 const out = {
 w: Math.max(w + size * 0.3, size * 0.6),
 h: Math.max(lines.length * lineH, lineH),
 lines, lineH, size,
 };
 // Bounded: a level is capped at MAX_TEXTS pieces and each is re-measured only
 // when its content changes, so this is small in practice — but an editor
 // session that drags a size handle generates one entry per pixel, so it is
 // capped rather than trusted.
 if (_measureCache.size > 600) _measureCache.clear();
 _measureCache.set(key, out);
 return out;
}

// The axis-aligned box of an UNROTATED piece, centred on x/y — the frame every
// other box-like piece in the game is described in (§3), so the editor's
// existing rotated-rect helpers (`rectCorners`, `pointInRect`) work on a text
// piece unchanged.
export function textBox(t) {
 const m = measureTextPiece(t);
 return { x: t.x, y: t.y, w: m.w, h: m.h, angle: t.angle || 0 };
}

// ---------- drawing ----------
//
// Centred on x/y and rotated about it, like every other piece. The optional
// outline is a halo stroked UNDER the fill (`lineJoin: round` so it doesn't spike
// at corners) — it exists because a label's whole job is to be readable, and the
// backdrop it lands on is the author's choice, not the label's.
export function drawTextPiece(ctx, t, { alpha = 1 } = {}) {
 const m = measureTextPiece(t);
 if (!m.lines.length) return;
 const align = textAlignOf(t);
 ctx.save();
 if (alpha !== 1) ctx.globalAlpha *= alpha;
 ctx.translate(t.x, t.y);
 if (t.angle) ctx.rotate(t.angle);
 ctx.font = textFontSpec(t, m.size);
 ctx.textAlign = align;
 ctx.textBaseline = 'middle';
 ctx.lineJoin = 'round';
 ctx.miterLimit = 2;
 const fill = textColourHex(t);
 // Halo colour is computed from the ink's own brightness, not picked from a
 // list of exceptions: an "outline" that vanished into its own fill would be a
 // control that does nothing on half the palette, and with a colour PICKER
 // there is no palette to enumerate (`haloFor`, textmodel.js).
 const halo = haloFor(fill);
 const x0 = align === 'left' ? -m.w / 2 + m.size * 0.15
 : align === 'right' ? m.w / 2 - m.size * 0.15
 : 0;
 // first baseline: the block is centred, so the top line sits half a block up
 // plus half a line down
 const y0 = -m.h / 2 + m.lineH / 2;
 for (let i = 0; i < m.lines.length; i++) {
 const y = y0 + i * m.lineH;
 if (t.outline) {
 ctx.strokeStyle = halo;
 ctx.lineWidth = Math.max(1, m.size * 0.16);
 ctx.strokeText(m.lines[i], x0, y);
 }
 ctx.fillStyle = fill;
 ctx.fillText(m.lines[i], x0, y);
 }
 ctx.restore();
}

// The labels of ONE depth slot, in array order (§10.6). A level's stack is a
// fixed sequence of passes, so a label's Z is which pass it draws with — the
// caller makes three calls at three points in its own draw, and `slot` says
// which. Array order breaks ties within a slot.
// `live` is the sim's `view.texts` — poses parallel to `level.texts`, for
// labels that move (§9.3). Absent while editing, so an author sees the authored
// position; present while a run is going, exactly like terrain and goal zones.
// Index-parallel rather than keyed: a label has no id, and the sim builds its
// records from this same array in this same order (§5.8).
export function drawTexts(ctx, level, slot = TEXT_Z_DEFAULT, opts, live = null) {
 const list = level?.texts || [];
 for (let i = 0; i < list.length; i++) {
 const t = list[i];
 if (textZOf(t) !== slot) continue;
 const v = live && live[i];
 drawTextPiece(ctx, v ? { ...t, x: v.x, y: v.y, angle: v.angle } : t, opts);
 }
}

// THE THREE CALL POINTS, stated once so no caller gets it half right — the
// editor's `_draw`, the thumbnail and the scenery layer all do exactly this:
//
// drawTexts(ctx, lv, 'behind') …before the terrain
// drawTerrainAll(…)
// drawTexts(ctx, lv, 'over') …after the terrain, before anything that moves
// props → rods → wheels → goal pieces
// drawTexts(ctx, lv, 'front') …last
//
// A caller that draws only 'over' still gets every default-depth label, which is
// what makes this safe to add to an existing draw.

// ---------- gravity wells (§5.10) ----------

// A soft halo out to twice the radius, under everything. It is the only thing
// on screen that says a ball is a planet, and it has to say it in PLAY as well
// as in the editor — a player who cannot tell which ball is pulling cannot
// read the level at all. Drawn from the LIVE pose (a planet may be a mover),
// so callers pass positions, not defs.
export function drawPlanetHalos(ctx, planets) {
 for (const p of planets) {
 const r0 = p.r, r1 = p.r * (1.55 + 0.25 * Math.min(p.pull, 2));
 const g = ctx.createRadialGradient(p.x, p.y, r0 * 0.96, p.x, p.y, r1);
 g.addColorStop(0, 'rgba(101,88,230,0.20)');
 g.addColorStop(0.45, 'rgba(101,88,230,0.08)');
 g.addColorStop(1, 'rgba(101,88,230,0)');
 ctx.fillStyle = g;
 ctx.beginPath();
 ctx.arc(p.x, p.y, r1, 0, Math.PI * 2);
 ctx.fill();
 }
}

// ---------- the gravity FLUX (§5.10) ----------
//
// "Planet levels: live gravity flux background… Subtle background texture
// for flux" (2026-08-07). Faint streaks falling into each well, running in
// play as well as edit — the halo says where a planet IS, the flux says what
// it is DOING, quietly, all the time.
//
// **Stateless, like the fireworks**: every streak is a pure function of
// (planet, index, time) — no particle state, no allocation churn, nothing to
// reset when a run starts or a scrub rewinds (a scrubbed frame simply passes
// its own clock and the flux rewinds with it for free). The azimuths walk
// the golden angle so the ring never reads as spokes; the fall runs on an
// accelerating curve because that is what falling looks like; and the pull
// dial sets the tempo, so a 3× planet visibly drinks faster than a 0.25×.
//
// Split from the drawing so verify.mjs can hold the claims still without a
// canvas: determinism, the radial band, and the alpha ceiling that keeps
// "subtle" a number rather than an opinion.
export const FLUX_STREAKS = 26; // per planet — two planets cost 52 thin strokes
export const FLUX_ALPHA_MAX = 0.16; // the ceiling that keeps it a texture, not a show
const FLUX_OUT = 3.1, FLUX_IN = 1.05; // the radial band, in planet radii
const GOLDEN = 2.399963; // radians — the angle that never repeats a spoke

export function fluxSeeds(p, t) {
 const out = [];
 const rOut = p.r * FLUX_OUT, rIn = p.r * FLUX_IN;
 const speed = 0.10 * (0.6 + 0.4 * Math.min(p.pull ?? 1, 3)); // cycles/sec, pull sets tempo
 for (let i = 0; i < FLUX_STREAKS; i++) {
 // fixed lane + a very slow orbital drift, alternating direction so the
 // whole ring never reads as rotating
 const a = i * GOLDEN + (i % 2 ? 1 : -1) * t * 0.03;
 const f = ((t * speed + i * 0.618) % 1 + 1) % 1; // 0 = outer edge, 1 = surface
 const fall = Math.pow(f, 1.35); // accelerates inward
 const r = rOut - (rOut - rIn) * fall;
 const len = p.r * 0.14 * (0.5 + f); // the tail stretches as it speeds up
 const c = Math.cos(a), s = Math.sin(a);
 out.push({
 x: p.x + c * r, y: p.y + s * r, // head (inner end)
 x2: p.x + c * (r + len), y2: p.y + s * (r + len), // tail (outer end)
 alpha: Math.sin(Math.PI * f) * FLUX_ALPHA_MAX, // fades in at the rim, out at the surface
 });
 }
 return out;
}

export function drawGravityFlux(ctx, planets, t) {
 if (!planets.length) return;
 ctx.save();
 ctx.lineWidth = 1.4;
 ctx.lineCap = 'round';
 for (const p of planets) {
 for (const st of fluxSeeds(p, t)) {
 ctx.strokeStyle = `rgba(101,88,230,${st.alpha.toFixed(3)})`;
 ctx.beginPath();
 ctx.moveTo(st.x, st.y);
 ctx.lineTo(st.x2, st.y2);
 ctx.stroke();
 }
 }
 ctx.restore();
}

// Editor only: a sparse field of "a piece dropped here falls THAT way" ticks.
//
// One picture answers the question a planet level otherwise makes an author
// guess at, and it answers it for the case that is genuinely hard to reason
// about — two planets, where the arrows swing round and the neutral line
// between them draws itself. Sampled on a screen-space lattice so the density
// is the same at every zoom, and skipped inside a planet (there is no "down"
// in there, and nothing can be placed there anyway).
const FIELD_STEP_PX = 46; // screen px between samples
export function drawGravityField(ctx, cam, planets) {
 if (!planets.length) return;
 const step = FIELD_STEP_PX / cam.zoom;
 const tl = cam.toWorld(0, 0), br = cam.toWorld(cam.vw, cam.vh);
 const x0 = Math.floor(tl.x / step) * step, y0 = Math.floor(tl.y / step) * step;
 const cols = Math.ceil((br.x - x0) / step), rows = Math.ceil((br.y - y0) / step);
 if (cols * rows > 2400) return; // same guard drawGrid takes
 const len = 11 / cam.zoom, head = 3.6 / cam.zoom;
 // an arrow is drawn from `len` behind the sample point to `len` in front of
 // it, so clearing the surface means clearing it by the whole half-length —
 // otherwise the tip pokes through the rim of the planet it is pointing at
 const clearance = len + 2 / cam.zoom;
 ctx.save();
 ctx.strokeStyle = 'rgba(101,88,230,.30)';
 ctx.lineWidth = 1.3 / cam.zoom;
 ctx.lineCap = 'round';
 ctx.beginPath();
 for (let i = 0; i <= cols; i++) {
 for (let j = 0; j <= rows; j++) {
 const x = x0 + i * step, y = y0 + j * step;
 let inside = false;
 for (const p of planets) {
 if (Math.hypot(x - p.x, y - p.y) < p.r + clearance) { inside = true; break; }
 }
 if (inside) continue;
 const d = downAt(x, y, planets);
 const tipX = x + d.x * len, tipY = y + d.y * len;
 ctx.moveTo(x - d.x * len, y - d.y * len);
 ctx.lineTo(tipX, tipY);
 // arrowhead: two barbs, so the tick reads as a direction not a dash
 ctx.moveTo(tipX, tipY);
 ctx.lineTo(tipX - d.x * head + d.y * head, tipY - d.y * head - d.x * head);
 ctx.moveTo(tipX, tipY);
 ctx.lineTo(tipX - d.x * head - d.y * head, tipY - d.y * head + d.x * head);
 }
 }
 ctx.stroke();
 ctx.restore();
}

// ---------- zones ----------

// **The word is a WATERMARK now, and every zone of a type shows one shared
// layer of it** (2026-08-24, on request: remove the corner word, "show
// through to a layer of BUILD or GOAL repeated as a pattern at 45deg, each
// line 50% offset… the text slightly darker than the background. Overlapping
// /rotated GOAL areas show through to the same layer/image so do not get
// messy.")
//
// The mechanics that make "the same layer" true: all rects of a type go into
// ONE path and are filled ONCE (nonzero winding — overlap does not darken),
// and the word pattern is a repeating tile whose transform is set in WORLD
// space, so two goal areas at different angles over the same ground reveal
// one continuous sheet of GOAL GOAL GOAL rather than two colliding stencils.
// The tile holds two rows, the second slid half a word — the 50% offset —
// and the pattern is turned 45° as a whole.
const ZONE_WORD_FS = 9; // world px — zooms with the place ("half scale" then "another 25%", 2026-08-24)
const ZONE_WORD_SS = 3; // the tile is rasterised at 3× and the pattern scaled back down, so the
 // words survive zoom and the 45° lean crisp ("too blurry", 2026-08-24)
const ZONE_WORD_FONT = `700 ${ZONE_WORD_FS}px system-ui, sans-serif`;

// **One cell for every zone word** (2026-08-24, "GOAL centred under BUILD"):
// both labels share the widest word's step, and each word is centred in that
// cell — so when the goal family's sheet rides half a line-pitch below the
// build family's, every GOAL sits centred directly under a BUILD.
const zoneWordGrids = new Map();
function zoneWordGrid(labels) {
 const key = labels.join('|');
 let m = zoneWordGrids.get(key);
 if (m) return m;
 const g = document.createElement('canvas').getContext('2d');
 g.font = ZONE_WORD_FONT;
 const widest = Math.max(...labels.map((l) => g.measureText(l).width));
 m = { step: Math.max(8, Math.ceil(widest + ZONE_WORD_FS * 1.2)), // word + its gap
 rowH: Math.ceil(ZONE_WORD_FS * 1.8) };
 zoneWordGrids.set(key, m);
 return m;
}

const zoneWordTiles = new Map();
function zoneWordTile(label, rgb, alpha, grid) {
 const key = `${label}|${rgb}|${alpha}|${grid.step}`;
 let c = zoneWordTiles.get(key);
 if (c) return c;
 c = document.createElement('canvas');
 c.width = grid.step * ZONE_WORD_SS;
 c.height = grid.rowH * 2 * ZONE_WORD_SS; // two rows, the second offset 50%
 const g = c.getContext('2d');
 g.scale(ZONE_WORD_SS, ZONE_WORD_SS);
 g.font = ZONE_WORD_FONT;
 g.textBaseline = 'middle';
 g.fillStyle = `rgba(${rgb},${alpha})`;
 const x0 = (grid.step - g.measureText(label).width) / 2; // centred in the shared cell
 g.fillText(label, x0, grid.rowH * 0.5);
 g.fillText(label, x0 - grid.step / 2, grid.rowH * 1.5); // the offset row, drawn twice
 g.fillText(label, x0 + grid.step / 2, grid.rowH * 1.5); // so the seam wraps clean
 zoneWordTiles.set(key, c);
 return c;
}

export function drawZones(ctx, level, opts = {}) {
 // A zone is a PLACE, not an annotation (2026-08-23) — corner brackets, no
 // border through the level, no ruled grid. The label plate went the same
 // way (2026-08-24): the word lives in the wash itself now, see above.
 const corners = (r) => {
 const c = r.angle ? Math.cos(r.angle) : 1, s = r.angle ? Math.sin(r.angle) : 0;
 const hw = r.w / 2, hh = r.h / 2;
 return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
 .map(([ox, oy]) => [r.x + ox * c - oy * s, r.y + ox * s + oy * c]);
 };
 // Both words up front, so the grid the tiles share is built from the same
 // pair every family sees — see zoneWordGrid.
 const wordLabels = [t('BUILD'), t('GOAL')];
 const insideOther = (rects, self, x, y) => rects.some((o) => {
 if (o === self) return false;
 const c = o.angle ? Math.cos(-o.angle) : 1, s = o.angle ? Math.sin(-o.angle) : 0;
 const dx = x - o.x, dy = y - o.y;
 const lx = dx * c - dy * s, ly = dx * s + dy * c;
 // strictly inside: a marker ON a shared edge is meeting its neighbour,
 // not doubling up inside it
 return Math.abs(lx) < o.w / 2 - 0.5 && Math.abs(ly) < o.h / 2 - 0.5;
 });

 const family = (rects, rgb, fillA, wordA, edgeA, label, lineShift = 0) => {
 if (!rects.length) return;
 // ---- one wash, one word-layer, for every zone of the type ----
 ctx.save();
 ctx.beginPath();
 for (const r of rects) {
 const q = corners(r);
 ctx.moveTo(q[0][0], q[0][1]);
 for (let i = 1; i < 4; i++) ctx.lineTo(q[i][0], q[i][1]);
 ctx.closePath();
 }
 ctx.fillStyle = `rgba(${rgb},${fillA})`;
 ctx.fill();
 // the word layer — slightly darker than the wash because it is the same
 // colour laid again. Skipped without ceremony where there is no DOM to
 // make a tile with (headless probes): the wash alone stands.
 try {
 if (typeof document !== 'undefined' && typeof DOMMatrix !== 'undefined' && ctx.createPattern) {
 const grid = zoneWordGrid(wordLabels);
 const tile = zoneWordTile(label, rgb, wordA, grid);
 const pat = ctx.createPattern(tile, 'repeat');
 if (pat && pat.setTransform) {
 // The sheet leans 45° as a whole; `lineShift` then slides it along its
 // own line direction by that fraction of the line pitch. GOAL rides
 // half a pitch below BUILD, so where a goal zone overlaps a build zone
 // the two words interleave line-for-line — each GOAL centred under a
 // BUILD (shared grid above) — instead of printing on the same
 // baselines (2026-08-24, on request). The trailing scale undoes the
 // tile's supersample; the translate is in world px, applied after it.
 pat.setTransform(new DOMMatrix().rotate(-45).translate(0, lineShift * grid.rowH).scale(1 / ZONE_WORD_SS));
 ctx.fillStyle = pat;
 ctx.fill();
 }
 }
 } catch { /* the wash alone stands */ }
 ctx.restore();
 // ---- the viewfinder brackets, per zone, minus any doubled-up parts ----
 // "Any part of an area's edge markers disappear if they are doubled up"
 // — a bracket leg whose middle sits inside ANOTHER zone of the same type
 // is marking an edge the region no longer has, so it is not drawn.
 ctx.save();
 ctx.strokeStyle = `rgba(${rgb},${edgeA})`;
 ctx.lineWidth = 2.4;
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 ctx.beginPath();
 for (const r of rects) {
 const c = r.angle ? Math.cos(r.angle) : 1, s = r.angle ? Math.sin(r.angle) : 0;
 const W = (ox, oy) => [r.x + ox * c - oy * s, r.y + ox * s + oy * c];
 const hw = r.w / 2, hh = r.h / 2;
 const a = Math.min(18, r.w * 0.24, r.h * 0.24);
 for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
 const corner = W(sx * hw, sy * hh);
 for (const [ex, ey] of [[sx * hw - sx * a, sy * hh], [sx * hw, sy * hh - sy * a]]) {
 const end = W(ex, ey);
 const mid = [(corner[0] + end[0]) / 2, (corner[1] + end[1]) / 2];
 if (insideOther(rects, r, mid[0], mid[1])) continue;
 ctx.moveTo(corner[0], corner[1]);
 ctx.lineTo(end[0], end[1]);
 }
 }
 }
 ctx.stroke();
 ctx.restore();
 };

 const builds = level.buildZones || [];
 const goals = opts.goalRects || level.goalZones || [];
 family(builds, '101,88,230', 0.10, 0.14, 0.65, wordLabels[0]);
 // The goal ZONE takes the goal piece's own green (2026-08-12), so the place
 // and the thing that has to reach it are one colour.
 family(goals, '26,230,128', 0.16, 0.20, 0.8, wordLabels[1], 0.5);
}

// **FREE WORLD's weave** (2026-08-09) — a faint purple cross-hatch over the
// WHOLE buildable universe, not over the old build zone.
//
// That is the correction it was given on the day: the mode does not enlarge the
// build area, it replaces it with the world, so marking the old rectangle drew
// attention to precisely the boundary that has stopped applying. The weave says
// "all of this is yours now", and the thing it covers is `±limit` — the fence
// (§10.7), which Free World does NOT lift and which is therefore still the
// honest edge of what you can build in.
//
// Two 45° passes in opposite directions, because it has to read as woven rather
// than striped: stripes are already this game's dashed-edge vocabulary and
// would be a second meaning for one mark.
//
// **Far more subtle than the first cut**, also on the day. This is a background
// state covering the entire screen for as long as the mode is on, not a
// highlight you look at once: at 0.34 alpha it competed with the level. The
// numbers below are the whole of the tuning — a wider pitch, a hairline, and an
// alpha low enough that it reads as a tint of the sky until you look for it.
const WEAVE_PITCH = 26;
const WEAVE_ALPHA = 0.055;
export function drawFreeWorldWeave(ctx, limit, view) {
 // Only the diagonals that cross what is ON SCREEN. The world box is 8040 px
 // across, which at this pitch is ~620 lines in two directions every frame,
 // most of them nowhere near the camera — and the pitch is world-space (so the
 // weave densifies as you zoom out and stays legible at level scale), which
 // means the count grows exactly when the frame can least afford it.
 const x0 = Math.max(-limit, view ? view.minX : -limit);
 const y0 = Math.max(-limit, view ? view.minY : -limit);
 const x1 = Math.min(limit, view ? view.maxX : limit);
 const y1 = Math.min(limit, view ? view.maxY : limit);
 if (!(x1 > x0 && y1 > y0)) return; // camera is outside the world box
 ctx.save();
 ctx.beginPath();
 ctx.rect(x0, y0, x1 - x0, y1 - y0);
 ctx.clip();
 ctx.strokeStyle = `rgba(150,90,240,${WEAVE_ALPHA})`;
 ctx.lineWidth = 1;
 const snap = (v) => Math.floor(v / WEAVE_PITCH) * WEAVE_PITCH;
 const reach = (x1 - x0) + (y1 - y0);
 ctx.beginPath();
 // "\" lines are x − y = c; "/" lines are x + y = c. Anchored to the WORLD
 // origin (`snap`), never to the camera, so the pattern is nailed to the level
 // and does not crawl while you pan.
 for (let c = snap(x0 - y1); c <= x1 - y0; c += WEAVE_PITCH) {
 ctx.moveTo(c + y0, y0); ctx.lineTo(c + y1, y1);
 }
 for (let c = snap(x0 + y0); c <= x1 + y1; c += WEAVE_PITCH) {
 ctx.moveTo(c - y0, y0); ctx.lineTo(c - y1, y1);
 }
 ctx.stroke();
 ctx.restore();
 // …and the fence itself, so "all of this" has a visible edge. Drawn only
 // where it is actually in shot.
 ctx.save();
 ctx.strokeStyle = `rgba(150,90,240,${WEAVE_ALPHA * 4})`;
 ctx.lineWidth = 2;
 ctx.setLineDash([12, 9]);
 ctx.strokeRect(-limit, -limit, limit * 2, limit * 2);
 ctx.restore();
}

// ---------- terrain textures (§10.2) ----------

// `struct` names the ONE primitive that makes a family recognisable as a
// material rather than as a hue (§10.2, 2026-08-23). Before it, every entry
// here was drawn by the same three passes — ten blotches, 130 grain dots,
// 26 sparkles — so granite, mud, moss, sand and rubber were one material in
// five palettes, and two grey slabs were indistinguishable in the picker and
// on the hillside alike. It is additive: an entry with no `struct` draws
// exactly what it drew before, to the pixel.
const TEX = {
 granite: { base: '#9aa1ac', edge: '#5d6470', blotch: ['#8b929e', '#a7aeb9', '#868d99'], grain: '#6f7681', sparkle: '#e8ecf2', struct: 'bedding' },
 grass: { base: '#8a6b4a', edge: '#63482c', blotch: ['#7d5f40', '#967753', '#816448'], grain: '#5f4832', sparkle: '#c8a87e', struct: 'bedding' },
 sand: { base: '#dcc084', edge: '#a98e55', blotch: ['#d2b477', '#e5cd97', '#cbab68'], grain: '#b3945c', sparkle: '#fff3cf', struct: 'ripple' },
 ice: { base: '#cfe6f7', edge: '#8fb9d9', blotch: ['#c0dcf2', '#e2f2fd', '#b3d4ec'], grain: '#a5c8e2', sparkle: '#ffffff', struct: 'facet' },
 neon: { base: '#221647', edge: '#8f7bff', blotch: [], grain: '', sparkle: '' },
 // `flat` = solid colour, full stop: no speckle tile, no edge stroke, no cap
 // strip. Abutting slabs therefore merge into one silhouette with no seam,
 // which is the whole point of it.
 // its own green rather than grass's cap green (#4a9440) — otherwise the two
 // read as the same swatch in the editor's texture picker
 classic: { base: '#5da84c', edge: null, flat: true, blotch: [], grain: '', sparkle: '' },

 // ---- added with surfaces.js: textures that look like what they DO ----
 // Speckle alone reads as "stone of some colour", so the ones whose identity
 // is a structure — planks, courses, brick bonds — carry a primitive on top
 // (see `lines`/`bricks` in textureTile).
 rubber: { base: '#2f3238', edge: '#15171b', blotch: ['#35383f', '#292c31', '#3a3e46'], grain: '#22252a', sparkle: '#4d525c', struct: 'knurl' },
 steel: {
 base: '#8d98a6', edge: '#59626d', blotch: ['#96a1ae', '#848f9d'], grain: '#79838f', sparkle: '#dae1e8',
 lines: [{ dir: 'h', period: 8, w: 1, color: '#6f7a86', alpha: 0.35 }],
 struct: 'brushed',
 },
 wood: {
 base: '#a97a4b', edge: '#6b4826', blotch: ['#b3854f', '#9d6f42', '#a87a4a'], grain: '#7d5730', sparkle: '#d8b183',
 lines: [{ dir: 'h', period: 32, w: 2.5, color: '#6b4826', alpha: 0.55 }],
 struct: 'timbergrain',
 },
 mud: { base: '#5a4a33', edge: '#372c1e', blotch: ['#63523a', '#4f412c', '#6b5a41'], grain: '#423522', sparkle: '#8a7550', struct: 'cell' },
 snow: { base: '#eef4fa', edge: '#b4c5d5', blotch: ['#e4edf6', '#f8fbff', '#dde8f3'], grain: '#cad8e6', sparkle: '#ffffff', struct: 'drift' },
 brick: {
 base: '#a0503c', edge: '#5f2c20', blotch: ['#ac5a44', '#95482f'], grain: '#7d3c2c', sparkle: '#c88a70',
 bricks: { w: 48, h: 16, mortar: '#d7c8b4', alpha: 0.9 },
 },
 lava: { base: '#2b2320', edge: '#ff7a2f', blotch: ['#3a2c25', '#241d1a', '#57331f'], grain: '#1b1513', sparkle: '#ff9d4d', struct: 'crack' },
 moss: { base: '#4a6b3c', edge: '#2b4223', blotch: ['#547a43', '#415e35', '#5d8449'], grain: '#37502d', sparkle: '#93bd7a', struct: 'cell' },
 belt: {
 // sticky purple goo — glossy blobs and a wet sparkle, no structure. The
 // conveying is said entirely by the LOOP (drawBeltBand, §17.5), whose
 // colour is `lug`; the material itself only has to say "grips". A belt
 // at 0 m/s is just this goo: nothing is conveying, so nothing runs.
 base: '#7b52c9', edge: '#4a2f85',
 blotch: ['#8a63d6', '#6b44b8', '#9a75e0'], grain: '#5d3aa6', sparkle: '#e4d6ff',
 lug: '#f2ecff',
 },
 glass: {
 base: '#cbe6ec', edge: '#87b2bd', blotch: ['#c0e0e8', '#dcf1f5'], grain: '#aed2da', sparkle: '#ffffff',
 lines: [{ dir: 'v', period: 48, w: 5, color: '#ffffff', alpha: 0.32 }],
 },
};

// Every texture that has a LOOK here. surfaces.js separately lists every
// texture that has a FEEL, and the two lists must name exactly the same set —
// a texture in one and not the other is either an invisible material or a
// silently-granite one. Gated (verify-surfaces.mjs) rather than trusted,
// because the two halves live in different files by design.
export const TEXTURE_LOOKS = Object.keys(TEX);

// ---------- ONE PRIMITIVE PER FAMILY (§10.2) ----------
//
// Every one of these is a fact about how the material is MADE: rock lies in
// beds, wind leaves ripples in sand, ice cleaves along planes, moss and mud
// are cells, snow drifts, lava cracks, steel is brushed, timber has a grain
// direction and knots. That is what lets a player name a material from across
// the level, and — unlike hue — it survives every colour-vision transform and
// every desaturated backdrop.
//
// Each is lit by LIGHT: the cut is dark, and the lip on the up-light side of
// the cut is the key. Two strokes, offset, exactly as the terrain rim is.
function drawStruct(c, spec, S, rand, wrapped) {
 const cut = spec.grain || spec.edge || '#000';
 const lip = mixHex(spec.base, LIGHT.key, 0.55);
 const dx = -LIGHT.x * 1.5, dy = -LIGHT.y * 1.5; // toward the light
 c.save();
 c.lineCap = 'round';
 switch (spec.struct) {
 case 'bedding': {
 // five beds. The joint wobbles as a sinusoid that CLOSES on the tile,
 // so the bands cannot seam however wide the hillside is.
 const n = 5, h = S / n;
 for (let i = 0; i < n; i++) {
 const y0 = i * h + (rand() - 0.5) * h * 0.3, amp = 2 + rand() * 2, k = 1 + ((i * 2) % 3);
 const bed = (off) => {
 c.beginPath();
 for (let x = 0; x <= S; x += 6) c.lineTo(x, y0 + off + Math.sin((x / S) * Math.PI * 2 * k) * amp);
 c.stroke();
 };
 c.globalAlpha = 0.34; c.strokeStyle = lip; c.lineWidth = 1.2; bed(dy);
 c.globalAlpha = 0.42; c.strokeStyle = cut; c.lineWidth = 1.6; bed(0);
 }
 // vertical fractures, wrapped so they tile
 c.globalAlpha = 0.28; c.strokeStyle = cut; c.lineWidth = 1.1;
 for (let i = 0; i < 4; i++) {
 const x = rand() * S, y = rand() * S, len = h * (0.5 + rand() * 0.8);
 wrapped(() => { c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rand() - 0.5) * 5, y + len); c.stroke(); });
 }
 break;
 }
 case 'ripple': {
 const n = 8, h = S / n;
 for (let i = 0; i < n; i++) {
 const y0 = i * h, amp = 2.2, k = 2;
 const row = (off, w, col, a) => {
 c.globalAlpha = a; c.strokeStyle = col; c.lineWidth = w;
 c.beginPath();
 for (let x = 0; x <= S; x += 5) c.lineTo(x, y0 + off + Math.sin((x / S) * Math.PI * 2 * k + i) * amp);
 c.stroke();
 };
 row(2.2, 2.4, cut, 0.22); // the trough's shadow
 row(dy, 1.4, lip, 0.40); // and the crest the wind piled up
 }
 break;
 }
 case 'facet': {
 // ice breaks along planes: straight cleavages, each with a bright edge
 // and its own shadow a pixel down-light.
 for (let i = 0; i < 7; i++) {
 const x = rand() * S, y = rand() * S, a = rand() * Math.PI, len = S * (0.3 + rand() * 0.5);
 const cx = Math.cos(a) * len, cy = Math.sin(a) * len;
 wrapped(() => {
 c.globalAlpha = 0.20; c.strokeStyle = cut; c.lineWidth = 3;
 c.beginPath(); c.moveTo(x - cx - dx, y - cy - dy); c.lineTo(x + cx - dx, y + cy - dy); c.stroke();
 c.globalAlpha = 0.55; c.strokeStyle = lip; c.lineWidth = 1.2;
 c.beginPath(); c.moveTo(x - cx, y - cy); c.lineTo(x + cx, y + cy); c.stroke();
 });
 }
 break;
 }
 case 'cell': {
 for (let i = 0; i < 22; i++) {
 const x = rand() * S, y = rand() * S, r = S * (0.05 + rand() * 0.09);
 wrapped(() => {
 c.globalAlpha = 0.30; c.strokeStyle = cut; c.lineWidth = 1.3;
 c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
 c.globalAlpha = 0.32; c.strokeStyle = lip; c.lineWidth = 1.2;
 c.beginPath(); c.arc(x + dx * 0.5, y + dy * 0.5, r * 0.86, Math.PI * 0.9, Math.PI * 1.9); c.stroke();
 });
 }
 break;
 }
 case 'drift': {
 const n = 6, h = S / n;
 for (let i = 0; i < n; i++) {
 const y0 = i * h;
 c.globalAlpha = 0.42; c.fillStyle = lip;
 c.beginPath();
 c.moveTo(0, y0 + h);
 for (let x = 0; x <= S; x += 8) c.lineTo(x, y0 + h * 0.55 + Math.sin((x / S) * Math.PI * 2 + i) * h * 0.22);
 c.lineTo(S, y0 + h); c.closePath(); c.fill();
 c.globalAlpha = 0.16; c.strokeStyle = cut; c.lineWidth = 1; c.stroke();
 }
 break;
 }
 case 'crack': {
 // a crust with something hot under it. The glow is the family's own
 // sparkle, which for lava is already the bright orange.
 const glow = spec.sparkle || lip;
 for (let i = 0; i < 12; i++) {
 let x = rand() * S, y = rand() * S, a = rand() * Math.PI * 2;
 const pts = [[x, y]];
 for (let k = 0; k < 5; k++) { a += (rand() - 0.5) * 1.4; x += Math.cos(a) * 8; y += Math.sin(a) * 8; pts.push([x, y]); }
 wrapped(() => {
 const run = () => { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const q of pts) c.lineTo(q[0], q[1]); c.stroke(); };
 c.globalAlpha = 0.55; c.strokeStyle = spec.edge; c.lineWidth = 2.4; run();
 c.globalAlpha = 0.75; c.strokeStyle = glow; c.lineWidth = 0.9; run();
 });
 }
 break;
 }
 case 'brushed': {
 // the hairlines are already `lines`; what steel is missing is the one
 // specular band that says it is polished metal and not painted grey.
 c.globalAlpha = 1;
 const g = c.createLinearGradient(0, 0, 0, S);
 g.addColorStop(0.26, mixHex(spec.base, LIGHT.key, 0));
 g.addColorStop(0.34, mixHex(spec.base, LIGHT.key, 0.42));
 g.addColorStop(0.42, mixHex(spec.base, LIGHT.key, 0));
 c.globalAlpha = 0.5; c.fillStyle = g; c.fillRect(0, 0, S, S);
 break;
 }
 case 'timbergrain': {
 // the `lines` entry gives plank COURSES; the grain runs along them, and
 // two knots stop twenty planks reading as one extruded shape.
 c.globalAlpha = 0.26; c.strokeStyle = cut; c.lineWidth = 1.1;
 for (let i = 0; i < 7; i++) {
 const y0 = (i + 0.5) * (S / 7);
 c.beginPath();
 for (let x = 0; x <= S; x += 6) c.lineTo(x, y0 + Math.sin((x / S) * Math.PI * 2 * (1 + i % 2) + i) * 2);
 c.stroke();
 }
 for (let i = 0; i < 2; i++) {
 const x = rand() * S, y = rand() * S;
 wrapped(() => {
 for (let k = 3; k > 0; k--) {
 c.globalAlpha = 0.30; c.strokeStyle = cut; c.lineWidth = 1.1;
 c.beginPath(); c.ellipse(x, y, k * 3.2, k * 2.1, 0.4, 0, Math.PI * 2); c.stroke();
 }
 });
 }
 break;
 }
 case 'knurl': {
 // moulded rubber: a diamond lattice on an 8 px pitch, which divides 96.
 const p = 8;
 for (let y = 0; y < S; y += p) for (let x = 0; x < S; x += p) {
 const ox = ((y / p) & 1) ? p / 2 : 0;
 c.globalAlpha = 0.42; c.fillStyle = cut;
 c.beginPath(); c.arc(x + ox, y, 2.3, 0, Math.PI * 2); c.fill();
 c.globalAlpha = 0.26; c.fillStyle = lip;
 c.beginPath(); c.arc(x + ox + dx * 0.6, y + dy * 0.6, 1.6, 0, Math.PI * 2); c.fill();
 }
 break;
 }
 }
 c.globalAlpha = 1;
 c.restore();
}

const tileCache = new Map();

export function textureTile(name) {
 const spec = TEX[name] || TEX.granite;
 if (tileCache.has(name)) return tileCache.get(name);
 const S = 96;
 const cv = document.createElement('canvas');
 cv.width = cv.height = S;
 const c = cv.getContext('2d');
 const rand = seedRand(name.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) | 0);
 // opaque base
 c.fillStyle = spec.base;
 c.fillRect(0, 0, S, S);
 if (spec.flat) { tileCache.set(name, cv); return cv; } // solid colour, nothing on top
 // every blob drawn at all 9 wrap offsets so the repeating tile has no seams
 const wrapped = (draw) => {
 for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
 c.save(); c.translate(ox, oy); draw(); c.restore();
 }
 };
 // big semi-opaque blotches for coverage
 for (let i = 0; i < 10; i++) {
 const x = rand() * S, y = rand() * S, r = 10 + rand() * 22;
 const col = spec.blotch[(i % spec.blotch.length) | 0] || spec.base;
 wrapped(() => {
 c.beginPath();
 c.ellipse(x, y, r, r * (0.55 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
 c.fillStyle = col;
 c.globalAlpha = 0.5;
 c.fill();
 });
 }
 // fine grain
 for (let i = 0; i < 130; i++) {
 const x = rand() * S, y = rand() * S, r = 0.4 + rand() * 1.1;
 wrapped(() => {
 c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
 c.globalAlpha = 0.25 + rand() * 0.25;
 c.fillStyle = spec.grain;
 c.fill();
 });
 }
 // sparkle
 for (let i = 0; i < 26; i++) {
 const x = rand() * S, y = rand() * S;
 wrapped(() => {
 c.beginPath(); c.arc(x, y, 0.5 + rand() * 0.7, 0, Math.PI * 2);
 c.globalAlpha = 0.3 + rand() * 0.4;
 c.fillStyle = spec.sparkle;
 c.fill();
 });
 }

 // ---- the family's own STRUCTURE ----
 // Drawn after the noise and before the periodic primitives, and subject to
 // the same seam rule: anything blob-like goes through `wrapped`, anything
 // stripe-like closes on S by construction. Its numbers are all fractions of
 // S so the pass is independent of the tile size.
 if (spec.struct) drawStruct(c, spec, S, rand, wrapped);

 // ---- structural primitives ----
 // Both are periodic on S in both axes BY CONSTRUCTION rather than by being
 // drawn at wrap offsets, because a stripe is infinite: nudging a copy
 // sideways changes nothing. That is why every period below divides 96 —
 // a seam anywhere in these would tile into a visible grid across a whole
 // hillside.
 c.globalAlpha = 1;
 if (spec.bricks) {
 const { w, h, mortar, alpha = 1 } = spec.bricks;
 c.save();
 c.globalAlpha = alpha;
 c.strokeStyle = mortar;
 c.lineWidth = 1.5;
 for (let y = 0; y <= S; y += h) {
 c.beginPath(); c.moveTo(0, y); c.lineTo(S, y); c.stroke();
 // running bond: every other course steps half a brick, so the vertical
 // period is 2h and 2h must divide S as well
 const off = ((y / h) % 2) ? w / 2 : 0;
 for (let x = off; x < S + w; x += w) {
 c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + h); c.stroke();
 }
 }
 c.restore();
 }
 for (const ln of (spec.lines || [])) {
 c.save();
 c.globalAlpha = ln.alpha ?? 1;
 c.strokeStyle = ln.color;
 c.lineWidth = ln.w;
 for (let d = 0; d < S; d += ln.period) {
 c.beginPath();
 if (ln.dir === 'v') { c.moveTo(d, 0); c.lineTo(d, S); }
 else { c.moveTo(0, d); c.lineTo(S, d); }
 c.stroke();
 }
 c.restore();
 }
 c.globalAlpha = 1;
 tileCache.set(name, cv);
 return cv;
}

function texOf(t) {
 const n = t.texture || 'granite';
 return TEX[n] ? n : 'granite';
}

// A texture as the editor's picker shows it: the real tile at the real scale,
// with the same edge stroke terrain gets, as a data URL for a CSS background.
//
// Sixteen flat colour chips could not be told apart — half of these differ by
// structure (planks, courses, brick bonds) rather than by hue, and two of the
// original six were never their tile's colour anyway. So the picker shows the
// actual render, which means the two special-cased draw paths have to be
// special-cased once more here: neon is a glowing outline that never uses its
// tile, and grass is dirt wearing a turf cap that lives in a separate pass.
// Anything else is exactly what strokeThenFill would produce.
//
// **The swatch is not necessarily square** (2026-08-08). The picker's cells are
// the mini toolbar's button — wider than they are tall — and a square swatch
// stretched over one by `background-size: cover` is cropped top and bottom,
// which is survivable for a tile and fatal for GRASS: its turf cap is the top
// 30%, and cropping ~20% off each end ate most of the one feature that names
// it. So the caller asks for the aspect it is going to draw at, and every
// proportion in here is taken from the axis it actually belongs to.
const swatchCache = new Map();
export function textureSwatchURL(name, size = 44, h = size) {
 const key = name + ':' + size + 'x' + h;
 if (swatchCache.has(key)) return swatchCache.get(key);
 const spec = TEX[name] || TEX.granite;
 const cv = document.createElement('canvas');
 cv.width = size; cv.height = h;
 const c = cv.getContext('2d');
 if (name === 'neon') {
 c.fillStyle = TEX.neon.base;
 c.fillRect(0, 0, size, h);
 c.shadowColor = TEX.neon.edge;
 c.shadowBlur = 9;
 c.strokeStyle = TEX.neon.edge;
 c.lineWidth = 3;
 c.strokeRect(3, 3, size - 6, h - 6);
 } else {
 c.fillStyle = c.createPattern(textureTile(name), 'repeat');
 c.fillRect(0, 0, size, h);
 if (name === 'grass') {
 const capH = Math.round(h * 0.3);
 c.fillStyle = GRASS.base;
 c.fillRect(0, 0, size, capH);
 c.fillStyle = GRASS.dark;
 c.fillRect(0, capH - 1.5, size, 1.5);
 }
 if (spec.edge && !spec.flat) {
 c.strokeStyle = spec.edge;
 c.lineWidth = 3;
 c.strokeRect(1.5, 1.5, size - 3, h - 3);
 }
 }
 const url = cv.toDataURL();
 swatchCache.set(key, url);
 return url;
}

// A painted loop's outline, as the true Bézier curve rather than the sampled
// polygon the physics uses — the canvas draws cubics natively, so the drawn
// edge is exact and costs one call per segment. `off` shifts every point
// (mover local frames, drag ghosts); `origin` re-bases the first anchor when a
// pose moves the piece.
// A painted loop, ALWAYS EMITTED CLOCKWISE — the same direction every other
// terrain shape is built in, and the same one `paintOutlineOf` normalises to
// for the physics ("clockwise = solid", §5.3).
//
// **This is a bug fix, and the bug was a hole in the world.** Every static
// same-texture piece goes into ONE Path2D and is filled once, so that abutting
// slabs read as a single silhouette with no internal seam. That fill uses
// canvas's default NONZERO rule, under which two overlapping subpaths union
// only if they wind the same way and CANCEL if they oppose. Boxes, balls and
// rounded boxes are always clockwise; a painted loop used to be emitted in
// whatever order the author happened to trace it. Trace one anticlockwise, lay
// a boulder across it, and the overlap punched a hole showing the background —
// and it was a coin flip, because the same two pieces were fine if you had
// drawn the loop the other way round. Paint-on-paint could do it too.
//
// The physics never agreed with any of that: `paintOutlineOf` normalises before
// building the chain, so the hole was purely visual and a machine would collide
// with what looked like empty space.
//
// Reversing is EXACT, not a re-fit: segment i runs A_i → A_{i+1} with controls
// (c1, c2), so the same segment backwards is A_{i+1} → A_i with (c2, c1). Same
// curve, same control points, opposite direction — nothing is resampled and the
// drawn shape is identical to the one the author made.
function paintOutlinePath(path, t, off = { x: 0, y: 0 }) {
 const anchors = paintAnchors(t);
 if (anchors.length < 3) return;
 const segs = [];
 for (let i = 0; i < anchors.length - 1; i++) segs.push(segControls(anchors, i, true));
 if (!segs.length) return;
 const at = (p) => [p.x + off.x, p.y + off.y];
 // The last anchor duplicates the first (a painted piece IS a closed path,
 // §11.1), so the ring to measure is the anchors without it. polyArea2 is
 // positive for clockwise in this y-down frame — the identical test, on the
 // identical convention, that paintOutlineOf uses.
 const clockwise = polyArea2(anchors.slice(0, -1)) >= 0;
 if (clockwise) {
 path.moveTo(...at(segs[0].p0));
 for (const s of segs) path.bezierCurveTo(...at(s.c1), ...at(s.c2), ...at(s.p3));
 } else {
 path.moveTo(...at(segs[segs.length - 1].p3));
 for (let i = segs.length - 1; i >= 0; i--) {
 const s = segs[i];
 path.bezierCurveTo(...at(s.c2), ...at(s.c1), ...at(s.p0));
 }
 }
 path.closePath();
}

// Append a terrain piece's outline to a Path2D at a given pose.
export function terrainPath(path, t, pose) {
 const x = pose ? pose.x : t.x, y = pose ? pose.y : t.y;
 const angle = pose ? (pose.angle || 0) : (t.angle || 0);
 if (isPaint(t)) {
 // anchors are absolute, so a pose is a translation of the whole loop —
 // the same delta the sim applies to the body
 paintOutlinePath(path, t, { x: x - t.x, y: y - t.y });
 return;
 }
 if (t.type === 'ball') {
 path.moveTo(x + t.r, y);
 path.arc(x, y, t.r, 0, Math.PI * 2);
 return;
 }
 const hw = t.w / 2, hh = t.h / 2, r = cornerRadiusOf(t);
 const c = Math.cos(angle), s = Math.sin(angle);
 const P = (dx, dy) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c });
 if (r < 1) {
 const p0 = P(-hw, -hh), p1 = P(hw, -hh), p2 = P(hw, hh), p3 = P(-hw, hh);
 path.moveTo(p0.x, p0.y);
 path.lineTo(p1.x, p1.y); path.lineTo(p2.x, p2.y); path.lineTo(p3.x, p3.y);
 path.closePath();
 return;
 }
 // rounded corners via arcTo on the rotated corner points (§10.2)
 const p0 = P(-hw, -hh), p1 = P(hw, -hh), p2 = P(hw, hh), p3 = P(-hw, hh);
 const m01 = P(0, -hh);
 path.moveTo(m01.x, m01.y);
 path.arcTo(p1.x, p1.y, p2.x, p2.y, r);
 path.arcTo(p2.x, p2.y, p3.x, p3.y, r);
 path.arcTo(p3.x, p3.y, p0.x, p0.y, r);
 path.arcTo(p0.x, p0.y, p1.x, p1.y, r);
 path.closePath();
}

// Local-frame variant of terrainPath (origin at 0,0, unrotated) — used for
// movers. A pattern fill is evaluated in whatever transform is active at
// fill-time; if a mover's shape were built in world coordinates (like a
// static's), the pattern would stay anchored to world space while the shape
// slid across it — the texture would appear to swim in place rather than
// travel with the piece. Building the shape here instead and letting
// ctx.translate/rotate (in drawTerrainAll) place it makes the pattern's own
// origin ride along with the piece.
function terrainPathLocal(path, t) {
 if (isPaint(t)) { paintOutlinePath(path, t, { x: -t.x, y: -t.y }); return; }
 if (t.type === 'ball') {
 path.moveTo(t.r, 0);
 path.arc(0, 0, t.r, 0, Math.PI * 2);
 return;
 }
 const hw = t.w / 2, hh = t.h / 2, r = cornerRadiusOf(t);
 if (r < 1) {
 path.moveTo(-hw, -hh);
 path.lineTo(hw, -hh); path.lineTo(hw, hh); path.lineTo(-hw, hh);
 path.closePath();
 return;
 }
 path.moveTo(0, -hh);
 path.arcTo(hw, -hh, hw, hh, r);
 path.arcTo(hw, hh, -hw, hh, r);
 path.arcTo(-hw, hh, -hw, -hh, r);
 path.arcTo(-hw, -hh, hw, -hh, r);
 path.closePath();
}

// Draw all terrain. terrainViews: sim view array (poses) or null (edit mode,
// authored poses). Static same-texture pieces union into one seamless slab;
// neon and movers draw individually (§10.2).
// **Which moving pieces may be unioned together, and with whom.** Returns the
// bucket key two movers must share to be drawn as one shape, or null for a
// piece that has to be drawn on its own. Pulled out of `drawTerrainAll` so a
// gate can reach it: the drawing needs a real canvas (textureTile), and the
// part worth testing is this decision, not the pixels.
//
// The rule, and why each clause is there:
// * a GROUP, because its members move rigidly together and therefore share
// one frame — which is the whole reason a union is possible at all;
// * the same TEXTURE, because that is what a union is (statics bucket by
// texture for the same reason);
// * NEON never, it has its own clustered draw (drawNeonSet);
// * and not a member carrying its OWN path on top of the group's, because
// that breaks the rigidity the shared frame depends on.
export function movingUnionKey(t, level) {
 const gid = t.groupId;
 if (!gid || !level?.groups?.[gid]) return null;
 if (t.path?.pts?.length) return null;
 const tex = texOf(t);
 if (tex === 'neon') return null;
 return gid + '|' + tex;
}

export function drawTerrainAll(ctx, level, terrainViews, time = 0, clip = null) {
 const terrain = level.terrain || [];
 let items = terrain.map((t, i) => ({
 t,
 pose: terrainViews ? terrainViews[i] : null,
 moving: terrainViews ? terrainViews[i].moving : terrainCanMove(t, level),
 }));
 // culling (§10.3): 500 terrain pieces draw in 1.17 ms whether or not the
 // camera can see them. The bound is the half-diagonal around the LIVE pose
 // (a mover is culled where it IS), padded far enough (200) that grassCap's
 // adjacency — a visible piece's cap depends on its neighbours — still sees
 // every neighbour that could touch anything on screen. Painted pieces are
 // never culled: their extent lives in their outline, and they are rare
 // enough that the check would cost more than it saves.
 if (clip) {
 items = items.filter(({ t, pose }) => {
 if (isPaint(t)) return true;
 const hd = (t.type === 'ball' ? (t.r || 0) : Math.hypot(t.w || 0, t.h || 0) / 2) + 200;
 const cx = pose ? pose.x : t.x, cy = pose ? pose.y : t.y;
 return cx + hd >= clip.minX && cx - hd <= clip.maxX && cy + hd >= clip.minY && cy - hd <= clip.maxY;
 });
 }

 // 0. **FC ghost lines** (`line` — a zero-width level rect, imported as
 // static terrain drawn at stick thickness, fcimport.js) are drawn in the
 // PROP family's colours, not the terrain's: they came from FC as
 // "DynamicRectangle"s, they look like props there, and a slab of grass
 // texture would say "ground" about a thing sticks pass through. Their own
 // yellow (COLORS.ghostLine) says the rest. Kept out of the texture unions
 // below and drawn AFTER them, so a line lying on a slab shows.
 const ghostLines = items.filter((it) => it.t.line && !it.moving && !isPaint(it.t));
 items = items.filter((it) => !ghostLines.includes(it));

 // 1. static slabs by texture (neon excluded)
 //
 // Belts stopped needing their own sub-key when the chevrons went (§17.5):
 // the goo tile is isotropic, so every belt unions like any other texture,
 // and each running piece's LOOP circulates at its own speed on top — per
 // PIECE, never per union, because each belt is its own body and its own
 // circulation, like adjacent real conveyor segments.
 const byTex = new Map();
 for (const it of items) {
 const tex = texOf(it.t);
 if (it.moving || tex === 'neon') continue;
 if (!byTex.has(tex)) byTex.set(tex, { tex, list: [] });
 byTex.get(tex).list.push(it);
 }
 for (const [, { tex, list }] of byTex) {
 const path = new Path2D();
 for (const it of list) terrainPath(path, it.t, it.pose);
 // the loop is per PIECE even when the fill is a union: each belt is its
 // own body and its own circulation (§17.5)
 strokeThenFill(ctx, path, tex,
 (c) => { for (const it of list) drawBeltBand(c, it.t, it.pose, time); });
 for (const it of list) grassCap(ctx, it, items);
 }
 for (const it of ghostLines) drawGhostLine(ctx, it.t);

 // 2. neon: grouped clusters get combined stroke-then-fill so internal seams
 // vanish; loose neon draws individually
 const neonStatics = items.filter(it => texOf(it.t) === 'neon' && !it.moving);
 drawNeonSet(ctx, neonStatics);

 // 3. movers individually at live pose — drawn in the piece's OWN local
 // frame (translate/rotate the context) so the texture pattern travels
 // rigidly with it instead of swimming in place under a moving cutout of a
 // world-anchored tile (§10.2)
 // 3a. **A moving GROUP unions like a static one.** Overlapping same-texture
 // slabs merge seamlessly while they sit still, because statics are unioned
 // by texture above — and the moment an author gave them a motion path they
 // fell into the per-piece loop below and grew seams between them. Reported
 // as exactly that: "a group of same texture terrains that overlap do merge
 // when grouped; when I give them motion they no longer merge."
 //
 // The per-piece local frame exists so a texture travels rigidly with its
 // piece rather than swimming under a world-anchored tile (§10.2). Members of
 // one GROUP move rigidly TOGETHER, so they share a frame — which is the
 // whole reason this is possible at all. The shared frame is derived as the
 // rigid map authored→live, taken from any one member: rotate by its turn,
 // about its own authored origin, then land on its live one. Every other
 // member follows because the motion is common to all of them.
 //
 // Excluded: a member carrying its OWN path on top of the group's, which
 // breaks the rigidity this depends on. Those keep the per-piece draw, as
 // does any group of one — same pixels, less machinery.
 const grouped = new Map();
 for (const it of items) {
 if (!it.moving) continue;
 const key = movingUnionKey(it.t, level);
 if (!key) continue;
 if (!grouped.has(key)) grouped.set(key, { tex: texOf(it.t), list: [] });
 grouped.get(key).list.push(it);
 }
 const unioned = new Set();
 for (const [, { tex, list }] of grouped) {
 if (list.length < 2) continue;
 const a = list[0];
 const ax = a.t.x, ay = a.t.y, aa = a.t.angle || 0;
 const lx = a.pose ? a.pose.x : ax, ly = a.pose ? a.pose.y : ay;
 const la = a.pose ? (a.pose.angle || 0) : aa;
 ctx.save();
 ctx.translate(lx, ly);
 ctx.rotate(la - aa);
 ctx.translate(-ax, -ay);
 const path = new Path2D();
 for (const it of list) { terrainPath(path, it.t, null); unioned.add(it); }
 // the belt loop stays per PIECE even when the fill is a union, exactly as
 // it does for the statics above (§17.5)
 // Lighting is a world-space offset; this frame is rotated by (la − aa),
 // so pass that angle so the key still comes from the sky, not the piece.
 strokeThenFill(ctx, path, tex,
 (c) => { for (const it of list) drawBeltBand(c, it.t, null, time); },
 la - aa);
 ctx.restore();
 for (const it of list) grassCap(ctx, it, items);
 }

 for (const it of items) {
 if (!it.moving || unioned.has(it)) continue;
 const tex = texOf(it.t);
 if (tex === 'neon') { drawNeonSet(ctx, [it]); continue; }
 // pose is null in edit mode (not simulating) — fall back to the
 // authored pose, same as terrainPath()'s own pose-or-authored pattern.
 // Skipping this fallback crashed here on it.pose.x whenever a piece
 // had ANY path (even mid-authoring, before Play is ever pressed),
 // which aborted the rest of the frame's draw calls — every piece drawn
 // after this point (goal pieces, wheels, the placement ghost, ...)
 // silently vanished for the rest of that render.
 const px = it.pose ? it.pose.x : it.t.x;
 const py = it.pose ? it.pose.y : it.t.y;
 const pa = it.pose ? (it.pose.angle || 0) : (it.t.angle || 0);
 ctx.save();
 ctx.translate(px, py);
 ctx.rotate(pa);
 const path = new Path2D();
 terrainPathLocal(path, it.t);
 // Local frame is rotated by the live pose, so inverse-rotate LIGHT or
 // a spinning platform's highlight would travel with the slab.
 strokeThenFill(ctx, path, tex,
 (c) => drawBeltBand(c, it.t, null, time, true),
 pa);
 ctx.restore();
 grassCap(ctx, it, items);
 }
}

// An FC ghost line, in the prop family's dress (see COLORS.ghostLine): a
// rounded bar at its authored pose, the prop outline weight, no texture, no
// grass cap — and HALF TRANSLUCENT (2026-08-18: "let's go 50%
// translucent as well"), which is the plainest way a drawing can say "things
// pass through this". Static by nature — a massless body never moves — so
// the authored pose IS the live one.
export const GHOST_LINE_ALPHA = 0.5;
export function drawGhostLine(ctx, t) {
 ctx.save();
 ctx.translate(t.x, t.y);
 ctx.rotate(t.angle || 0);
 ctx.globalAlpha *= GHOST_LINE_ALPHA;
 ctx.fillStyle = COLORS.ghostLine;
 ctx.strokeStyle = COLORS.ghostLineDark;
 ctx.lineWidth = PIECE_OUTLINE;
 roundRectPath(ctx, t.w / 2, t.h / 2, cornerRadiusOf(t));
 ctx.fill();
 ctx.stroke();
 ctx.restore();
}

// Terrain pins (2026-08-07), in their OWN pass after every terrain piece.
//
// Not inside drawTerrainAll for a structural reason: statics are unioned by
// TEXTURE into one path and stroked as a group, so there is no per-piece
// moment in there to hang a decoration on — and a pin drawn under the next
// texture's fill would vanish. A separate pass costs one loop over pieces
// that HAVE pins, which is nearly always none.
//
// Coordinates are absolute against the AUTHORED pose, exactly as a prop's
// are, so a mover's pins are converted to local offsets and re-applied at
// the live pose — the same conversion drawProp does, for the same reason:
// stored coordinates alone leave them hanging in mid-air the moment the
// piece moves.
export function drawTerrainPins(ctx, level, terrainViews) {
 const terrain = level.terrain || [];
 for (let i = 0; i < terrain.length; i++) {
 const t = terrain[i];
 const pins = propPins(t);
 if (!pins.length) continue;
 const pose = terrainViews ? terrainViews[i] : null;
 const px = pose ? pose.x : t.x, py = pose ? pose.y : t.y;
 const pa = pose ? (pose.angle || 0) : (t.angle || 0);
 const a0 = t.angle || 0;
 const c0 = Math.cos(-a0), s0 = Math.sin(-a0);
 const ca = Math.cos(pa), sa = Math.sin(pa);
 for (const pin of pins) {
 // authored world → the piece's own frame → live world
 const dx = pin.x - t.x, dy = pin.y - t.y;
 const lx = dx * c0 - dy * s0, ly = dx * s0 + dy * c0;
 const x = px + lx * ca - ly * sa, y = py + lx * sa + ly * ca;
 ctx.beginPath();
 ctx.arc(x, y, 2.9, 0, Math.PI * 2);
 ctx.fillStyle = COLORS.pinDark;
 ctx.fill();
 ctx.beginPath();
 ctx.arc(x, y, 1.3, 0, Math.PI * 2);
 ctx.fillStyle = '#ffd76a';
 ctx.fill();
 }
 }
}

// The level's OWN pins (2026-08-08) — the loose ones, bolted to the world and
// riding no piece at all. Their own pass for the reason terrain's have one, and
// a simpler one: there is no piece to convert coordinates against. A loose pin
// never moves, so its stored coordinate IS where it is drawn, in every mode.
//
// Deliberately the same disc as every other pin: it is the same pin, and a
// hinge that looked different depending on what it was bolted to would be
// teaching a difference that isn't there. The one addition is a pale ring —
// a pin on a piece sits on that piece's fill, and a loose one has open sky
// behind it, where a 2.9 px dark dot on a dark backdrop is a speck.
export function drawLevelPins(ctx, level) {
 const dot = (x, y) => {
 ctx.beginPath();
 ctx.arc(x, y, 4.5, 0, Math.PI * 2);
 ctx.strokeStyle = 'rgba(255,255,255,.8)';
 ctx.lineWidth = 1.5;
 ctx.stroke();
 ctx.beginPath();
 ctx.arc(x, y, 2.9, 0, Math.PI * 2);
 ctx.fillStyle = COLORS.pinDark;
 ctx.fill();
 ctx.beginPath();
 ctx.arc(x, y, 1.3, 0, Math.PI * 2);
 ctx.fillStyle = '#ffd76a';
 ctx.fill();
 };
 for (const pin of (level.pins || [])) {
 // **A BOSS pin is a flange** (2026-08-24): a plate the size of its radius,
 // then the ordinary pin disc at every slot it offers — the slots ARE
 // pins, so they wear exactly the pin's own face, dark ring and gold core.
 // The plate itself speaks the pin's own language writ large: the dark
 // border outside, a GOLD ring just inside it matched to the same circle
 // ("internal (yellow) shape matched to external"), both at half the
 // first cut's line weight.
 if (pin.r) {
 ctx.beginPath();
 ctx.arc(pin.x, pin.y, pin.r + 4, 0, Math.PI * 2);
 ctx.fillStyle = 'rgba(70,62,54,.35)';
 ctx.fill();
 ctx.strokeStyle = COLORS.pinDark;
 ctx.lineWidth = 1;
 ctx.stroke();
 ctx.beginPath();
 ctx.arc(pin.x, pin.y, pin.r + 4 - 1.6, 0, Math.PI * 2);
 ctx.strokeStyle = '#ffd76a';
 ctx.lineWidth = 1;
 ctx.stroke();
 }
 for (const [ox, oy] of loosePinOffsets(pin)) dot(pin.x + ox, pin.y + oy);
 }
}

// terrain outline width. grassCap re-strokes the same silhouette with this to
// cover the dirt's outer half — they must stay equal.
const EDGE_W = 4.5;

// `between` runs after the edge stroke and before the fill — anything drawn
// there is clipped to the border's own visible weight by the fill, exactly
// like the edge itself. The belt loop is its one caller (§17.5): its lugs
// ARE the border, so they must live in the border's layer.
// ---------- the light on a slab, and why it is TWO FILLS ----------
//
// A slab has to acquire a top and a side. The obvious way — walk the edges and
// dot each normal with LIGHT — cannot be done here: by the time a bucket
// reaches this function it is a single unioned Path2D (§10.2), with no
// vertices to walk and no per-piece anything.
//
// The next idea, and the one tried first, was to stroke the silhouette twice
// with the pale copy pushed against the light. It works geometrically and it
// is invisible: the part of the pale stroke that survives is the part OUTSIDE
// the piece, where it is competing with the sky rather than describing the
// surface. Measured on a brick slab against dusk, the lit lip was 1.4 px of
// mid-tan on a pale backdrop — no read at all.
//
// So both halves of the light are FILLS of the same path, clipped to it and
// offset:
//
// · shifted DOWN-light and filled with occ → darkens every pixel that has
// material up-light of it, leaving a bright band along the top-left edge
// · shifted UP-light and filled with key → lights every pixel that has
// material down-light of it, leaving a dark band along the bottom-right
//
// The two overlap across the body and cancel to roughly nothing, so what is
// left is exactly a lit top, a shaded underside, and a smooth turn between
// them — on a box, on a boulder, and on a freehand painter loop identically,
// because no vertex is ever inspected.
//
// **Fills, not strokes, and that is the load-bearing part.** Static
// same-texture pieces union into ONE path, so a bright line drawn after the
// fill would put every buried interior seam straight back and a hillside
// would come apart into the boxes it was assembled from. A fill of a nonzero
// union has no interior edges to find, so it cannot un-merge anything.
const AO_D = 10, AO_ALPHA = 0.20; // down-light: the shaded underside
const KEY_D = 9, KEY_ALPHA = 0.22; // up-light: the lit top

// Canvas-space LIGHT when the current transform is already rotated by
// `angle`. litFills offsets in the CURRENT space; a mover is drawn after
// ctx.rotate(pose), so a raw LIGHT.x/y offset rotates with the piece.
function lightInLocal(angle) {
 if (!angle) return LIGHT;
 const c = Math.cos(angle), s = Math.sin(angle);
 return { x: LIGHT.x * c + LIGHT.y * s, y: -LIGHT.x * s + LIGHT.y * c };
}

function litFills(ctx, path, lightAngle = 0) {
 const L = lightInLocal(lightAngle);
 ctx.save();
 ctx.clip(path);
 ctx.save();
 ctx.translate(L.x * AO_D, L.y * AO_D);
 ctx.globalAlpha = AO_ALPHA; ctx.fillStyle = LIGHT.occ; ctx.fill(path);
 ctx.restore();
 ctx.save();
 ctx.translate(-L.x * KEY_D, -L.y * KEY_D);
 ctx.globalAlpha = KEY_ALPHA; ctx.fillStyle = LIGHT.key; ctx.fill(path);
 ctx.restore();
 ctx.restore();
}

function strokeThenFill(ctx, path, tex, between = null, lightAngle = 0) {
 const spec = TEX[tex] || TEX.granite;
 ctx.save();
 if (!spec.flat) {
 ctx.lineWidth = EDGE_W;
 ctx.lineJoin = 'round';
 ctx.strokeStyle = spec.edge;
 ctx.stroke(path);
 }
 if (between) between(ctx);
 ctx.fillStyle = ctx.createPattern(textureTile(tex), 'repeat');
 ctx.fill(path);
 if (!spec.flat) litFills(ctx, path, lightAngle);
 ctx.restore();
}

// ---------- moving surfaces (§17.5) ----------
//
// A conveyor that does not visibly run is a hazard stripe. `tangentSpeed`
// (§5.9) is the one surface dial with no other way to see it — grip, bounce and
// drag all announce themselves the moment something touches the piece, but a
// belt looks exactly like a floor until you put a crate on it. So it runs,
// in the editor as well as in play: that is what makes the Belt slider legible
// and its SIGN obvious without having to press Play.
//
// A piece RUNS if something would actually be conveyed: a non-zero belt
// speed, whatever the texture. A belt-textured piece dialed to 0 is just the
// sticky goo — nothing is conveying, so nothing runs, and no other piece in
// the game changes appearance by a pixel.
export const beltRuns = (t) => surfaceOf(t).tangentSpeed !== 0;

// How far the surface has travelled, in px, along the piece's local +x.
//
// Split out and exported ONLY so it can be gated: it is the one part of this
// with a sign convention to get wrong, and the rest needs a canvas the
// headless suites do not have. Positive tangentSpeed carries things toward
// local +x (§5.9, measured), so the belt's top run travels that way and the
// lug band goes with it — get this backwards and the belt visibly runs one
// way while pushing crates the other.
export const beltScrollPx = (t, time) => surfaceOf(t).tangentSpeed * PPM * time;

// THE BELT LOOP. Lugs circulating around the piece's outline the way a real
// belt wraps its rollers: the top run travels +x, the return underneath
// travels −x, and the ends wrap around — which is exactly what the physics
// does to whatever touches each face. (The fill used to translate instead,
// and that lied in both halves: a real belt's skin does not slide through
// its own body, and Box2D's tangent speed acts along the CONTACT tangent, so
// a crate against the underside is pushed the OPPOSITE way to one on top.)
//
// One dashed stroke does every shape. Box, rounded box, ball and painted
// outlines are all built CLOCKWISE — the same winding invariant the one-fill
// silhouette leans on (§10.2, gate 19) — so advancing `lineDashOffset` by
// −beltScrollPx moves every loop's lugs along the path direction: +x across
// the top of a clockwise outline, −x back along the bottom, at the surface's
// real speed.
//
// The lugs ARE the border. Same width as the edge stroke, drawn in
// strokeThenFill's `between` layer — after the edge, before the fill — so
// the fill covers their inner half exactly as it covers the edge's, and a
// lug carries precisely the border's visible weight. The gaps show the dark
// edge beneath: a running belt reads as a dashed border marching round the
// piece, a stopped one keeps its plain border.
const BELT_LUG = 12, BELT_GAP = 20;
function drawBeltBand(ctx, t, pose, time, local = false) {
 if (!beltRuns(t)) return; // 0 m/s conveys nothing: no loop
 const path = new Path2D();
 if (local) terrainPathLocal(path, t);
 else terrainPath(path, t, pose);
 ctx.save();
 ctx.lineWidth = EDGE_W;
 ctx.lineJoin = 'round';
 ctx.strokeStyle = (TEX[texOf(t)].lug || TEX.belt.lug);
 ctx.setLineDash([BELT_LUG, BELT_GAP]);
 ctx.lineDashOffset = -beltScrollPx(t, time);
 ctx.stroke(path);
 ctx.restore();
}

function drawNeonSet(ctx, items) {
 if (!items.length) return;
 // cluster by groupId; ungrouped are their own cluster
 const clusters = new Map();
 for (const it of items) {
 const k = it.t.groupId || ('solo:' + items.indexOf(it));
 if (!clusters.has(k)) clusters.set(k, []);
 clusters.get(k).push(it);
 }
 for (const [, list] of clusters) {
 const path = new Path2D();
 for (const it of list) terrainPath(path, it.t, it.pose);
 ctx.save();
 ctx.shadowColor = TEX.neon.edge;
 ctx.shadowBlur = 14;
 ctx.lineWidth = 3;
 ctx.lineJoin = 'round';
 ctx.strokeStyle = TEX.neon.edge;
 ctx.stroke(path);
 ctx.shadowBlur = 0;
 ctx.fillStyle = TEX.neon.base;
 ctx.fill(path);
 ctx.restore();
 }
}

// grass: sharp-edged green cap along each piece's local top edge, tapered
// blades seeded by WORLD position (continuous across seams); within a group
// the cap is geometrically clipped by each same-group mate's silhouette —
// one clip('evenodd') PER MATE, sequentially (§10.2).
function grassCap(ctx, it, allItems) {
 if (texOf(it.t) !== 'grass') return;
 const t = it.t;
 const x = it.pose ? it.pose.x : t.x, y = it.pose ? it.pose.y : t.y;
 const angle = it.pose ? (it.pose.angle || 0) : (t.angle || 0);
 ctx.save();
 // clip by same-group mates
 if (t.groupId) {
 const mates = allItems.filter(o => o !== it && o.t.groupId === t.groupId);
 for (const m of mates) {
 const p = new Path2D();
 p.rect(-1e5, -1e5, 2e5, 2e5);
 terrainPath(p, m.t, m.pose);
 ctx.clip(p, 'evenodd');
 }
 }
 ctx.translate(x, y);
 ctx.rotate(angle);

 const shape = new Path2D();
 terrainPathLocal(shape, t);

 // The dirt underneath is stroke-THEN-fill, so its real silhouette is the
 // outline grown by half of EDGE_W. Painting the turf inside the path only
 // covers the inner half of that stroke and leaves a brown rim above the
 // grass — most obvious on the corner arcs, where the rim is the whole
 // corner. So the turf is laid down exactly the same way, stroke and all,
 // through a horizontal band clip.
 const turf = (colour, y0, h) => {
 ctx.save();
 const band = new Path2D();
 band.rect(-1e4, y0, 2e4, h);
 ctx.clip(band);
 ctx.lineJoin = 'round';
 ctx.lineWidth = EDGE_W;
 ctx.strokeStyle = colour;
 ctx.stroke(shape);
 ctx.fillStyle = colour;
 ctx.fill(shape);
 ctx.restore();
 };

 if (isPaint(t)) {
 // Same horizontal-band treatment as a box: turf across the top of the
 // silhouette, thick enough to swallow the curve. It doesn't follow an
 // overhang round to its underside — neither does the box case, and grass
 // under a ledge is not what anyone is drawing.
 const local = paintLocalOutline(t);
 if (local) {
 const b = polyBounds(local);
 const capH = Math.min(9, Math.max(4, (b.maxY - b.minY) * 0.35));
 turf(GRASS.base, b.minY - EDGE_W, capH + EDGE_W);
 turf(GRASS.dark, b.minY + capH - 1.4, 1.4);
 }
 drawFringe(ctx, t);
 ctx.restore();
 return;
 }

 if (t.type === 'ball') {
 const depth = Math.min(6, t.r * 0.5);
 ctx.save();
 // hollow out the middle so the turf reads as a rind following the
 // curvature, not a flat-bottomed chord across the top
 const rind = new Path2D();
 rind.rect(-1e4, -1e4, 2e4, 2e4);
 rind.arc(0, 0, Math.max(t.r - depth, 0.5), 0, Math.PI * 2);
 ctx.clip(rind, 'evenodd');
 turf(GRASS.base, -t.r - EDGE_W, t.r + EDGE_W); // top half only
 ctx.restore();
 drawFringe(ctx, t);
 ctx.restore();
 return;
 }

 const hh = t.h / 2, cr = cornerRadiusOf(t);
 // deep enough to swallow the corner radius, or the arcs stay brown
 const capH = Math.min(Math.max(7, cr + 2), t.h);
 turf(GRASS.base, -hh - EDGE_W, capH + EDGE_W);
 turf(GRASS.dark, -hh + capH - 1.4, 1.4); // soil line where turf meets dirt
 drawFringe(ctx, t);
 ctx.restore();
}

// The fringe is hundreds of tiny paths and it is IDENTICAL every frame — it
// lives in the piece's local frame and is seeded by world position, so pose
// and camera never touch it. Building it per frame cost ~1.4 ms on a
// grass-heavy scene; built once and bucketed by colour it is four fills.
const fringeCache = new WeakMap();

// A painted piece's outline in its own local frame — what grassCap clips
// against and what the fringe stands on. Same sampled polygon the physics
// uses, so turf never sits where the surface isn't.
function paintLocalOutline(t) {
 const pts = paintOutlineOf(t);
 return pts ? pts.map(p => ({ x: p.x - t.x, y: p.y - t.y })) : null;
}

function drawFringe(ctx, t) {
 // a painted loop has no w/h/r to key on: its vertices ARE its shape, so
 // editing one has to invalidate the cached blades
 const key = isPaint(t)
 ? 'paint|' + paintAnchors(t).map(a => `${Math.round(a.x * 10)},${Math.round(a.y * 10)}`).join(';')
 : `${t.type}|${t.w}|${t.h}|${t.r}|${cornerRadiusOf(t)}|${t.x}|${t.y}`;
 let hit = fringeCache.get(t);
 if (!hit || hit.key !== key) {
 hit = { key, paths: buildFringe(t) };
 fringeCache.set(t, hit);
 }
 // dark/mid are the back row and light/tip the front, so filling in palette
 // order keeps the two passes layered the way they were drawn
 for (const [colour, path] of hit.paths) {
 ctx.fillStyle = colour;
 ctx.fill(path);
 }
}

function buildFringe(t) {
 const rand = seedRand(Math.round(t.x * 13 + t.y * 7) | 0);
 const paths = new Map([GRASS.dark, GRASS.mid, GRASS.light, GRASS.tip].map(c => [c, new Path2D()]));
 if (isPaint(t)) {
 const local = paintLocalOutline(t);
 if (!local) return paths;
 // Blades stand on every edge that faces upward, each rotated to that
 // edge's outward normal — the boulder treatment generalised, which is
 // what makes a painted ridge read as a ridge rather than a flat lawn.
 // paintOutline() guarantees clockwise winding (y-down), so the outward
 // normal of a→b is (dy, −dx).
 for (let pass = 0; pass < 2; pass++) {
 for (let i = 0, n = local.length; i < n; i++) {
 const a = local[i], b = local[(i + 1) % n];
 const dx = b.x - a.x, dy = b.y - a.y;
 const len = Math.hypot(dx, dy);
 if (len < 0.5) continue;
 const nx = dy / len, ny = -dx / len;
 if (ny > -0.35) continue; // not facing up enough
 const count = Math.max(1, Math.round(len / 3.4));
 // rotate the blade's own up (0,−1) onto the normal
 const deg = (Math.atan2(nx, -ny) * 180) / Math.PI;
 for (let k = 0; k < count; k++) {
 const f = (k + 0.5 + (rand() - 0.5) * 0.9) / count;
 grassBlade(paths, rand, new DOMMatrix()
 .translate(a.x + dx * f + nx, a.y + dy * f + ny)
 .rotate(deg), pass);
 }
 }
 }
 return paths;
 }
 if (t.type === 'ball') {
 // blades stand along the top arc, each rotated to that point's normal
 const n = Math.max(5, Math.round((Math.PI * t.r) / 3.6));
 for (let pass = 0; pass < 2; pass++) {
 for (let i = 0; i < n; i++) {
 const a = Math.PI + (Math.PI * (i + 0.5 + (rand() - 0.5) * 0.8)) / n;
 const m = new DOMMatrix()
 .rotate(((a + Math.PI / 2) * 180) / Math.PI)
 .translate(0, -(t.r + 1));
 grassBlade(paths, rand, m, pass);
 }
 }
 return paths;
 }
 // Only over the flat part of the top — a blade above a rounded corner
 // floats off the surface.
 const hw = t.w / 2, hh = t.h / 2, cr = cornerRadiusOf(t);
 const flatL = -hw + cr * 0.6, flatR = hw - cr * 0.6;
 const span = Math.max(flatR - flatL, 0);
 const n = Math.round(span / 3.4);
 // two passes: a short dark row behind, a taller light row in front, so the
 // fringe has depth instead of reading as a row of identical spikes
 for (let pass = 0; pass < 2; pass++) {
 for (let i = 0; i < n; i++) {
 const bx = flatL + ((i + 0.5 + (rand() - 0.5) * 0.9) / n) * span;
 grassBlade(paths, rand, new DOMMatrix().translate(bx, -hh - 1), pass);
 }
 }
 return paths;
}

const GRASS = {
 dark: '#2f6b2a', // soil line and the darkest back blades
 mid: '#3d8a35',
 base: '#4a9440', // the turf itself
 light: '#63b04e', // front row
 tip: '#7fc766', // highlight on the tallest front blades
};

// One blade, rooted at the origin of `m` and growing up (-y), appended to the
// bucket for its colour. `pass` 0 = short dark blade behind, 1 = taller light
// blade in front.
function grassBlade(paths, rand, m, pass) {
 const back = pass === 0;
 const h = back ? 3 + rand() * 3.5 : 5.5 + rand() * 6;
 const dir = rand() < 0.5 ? -1 : 1;
 const lean = dir * (0.15 + rand() * 0.85) * h * 0.6;
 const w = (back ? 1.1 : 1.4) + rand() * 0.35;
 // Both edges sweep through one control point set BACK from the straight
 // base→tip line, so the blade arcs over and tapers to a point instead of
 // standing up as a triangle.
 const cx = lean * 0.12, cy = -h * 0.62;
 const blade = new Path2D();
 blade.moveTo(-w, 0);
 blade.quadraticCurveTo(cx - w * 0.8, cy, lean, -h);
 blade.quadraticCurveTo(cx + w * 0.8, cy, w, 0);
 blade.closePath();
 const colour = back
 ? (rand() < 0.5 ? GRASS.dark : GRASS.mid)
 : (h > 9.5 ? GRASS.tip : GRASS.light);
 paths.get(colour).addPath(blade, m);
}

// ---------- backgrounds (§10.2) — 8 gentle animated styles ----------

export const BACKGROUNDS = {
 dusk: { top: '#ccd7f6', bot: '#fdebd8' },
 rain: { top: '#9fb0c8', bot: '#d7dde8' },
 snow: { top: '#d8e4f2', bot: '#f6f8fb' },
 fog: { top: '#c3c9d4', bot: '#e8eaef' },
 night: { top: '#1c2340', bot: '#3c4670' },
 sunset: { top: '#f7b267', bot: '#f4845f' },
 aurora: { top: '#0f2233', bot: '#22485c' },
 candy: { top: '#ffd3e8', bot: '#c8f4e4' },
 // For planet levels (§5.10): stars all the way down, because a radial level
 // has no ground half and no sky half. 'night' fades to blue and puts its
 // stars in the top three quarters, which reads as "outdoors at night" and
 // draws a horizon exactly where a planet level does not have one.
 space: { top: '#05070f', bot: '#0d1226' },
};

export function bgOf(name) {
 return BACKGROUNDS[name] ? name : 'dusk';
}

// Sky parallax (§10.5, 2026-08-05; brought nearer 2026-08-23 on report:
// *"bring the parallax closer i.e. move more"*). 0.7 of the scenery layer's
// drift — read as 1.4× its distance, where the old /2 read as twice and left
// the horizon near-frozen (ridge drift bottomed out at 3% of the camera).
// Apparent motion goes as 1/distance, and the factor must stay BELOW the
// layer's own or the sky slides faster than the ground and reads as the
// nearest thing in the picture — the effect upside down. Derived from
// `backScale` for the same reason the scenery's own drift is (sizes.js): one
// dial is the depth, and a second number could only ever disagree with it.
export const SKY_PARALLAX_OF = (backScale) => backScale * 0.7;

// Only HORIZONTALLY, and the sky WRAPS. Vertical drift would slide the horizon
// off the gradient it belongs to, and the gradient itself never moves — it is
// the one thing here genuinely at infinity. The feature field is drawn twice,
// a viewport apart, so panning can never open a seam; each pass reseeds from
// the same 99, so the two are the same sky rather than two different ones.
//
// full-screen backdrop in SCREEN space; t in seconds for the slow animated layer
// **The sky gradient is 128 solid bands, not a createLinearGradient fill**
// (2026-08-18, "43 fps in Normal graphic mode" — idle, on Sticks 26).
// MEASURED on a 1.8 Mpx canvas, GPU-synced: the two-stop gradient fill was
// 2.9 ms of a 7 ms frame — a solid fill of the same viewport is 0.2 ms, and
// 128 solid bands are 0.3. A gradient fill is evaluated per pixel wherever the
// canvas is not GPU-composited, and it was 40% of every idle frame; on a
// 4K-class screen, most of the budget. 128 steps over any viewport is finer
// than a pixel and finer than 8-bit colour, so the picture is the same one.
// (A cached bitmap of the sky was tried first and REJECTED by the same ruler:
// a full-viewport drawImage cost 13 ms on that canvas — bitmaps are dearer
// than the fill they would replace.)
const SKY_BANDS = 128;
const hexRGB = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
export function drawBackdrop(ctx, w, h, name, t, panX = 0) {
 const bg = BACKGROUNDS[bgOf(name)];
 const A = hexRGB(bg.top), B = hexRGB(bg.bot);
 const bh = h / SKY_BANDS;
 for (let i = 0; i < SKY_BANDS; i++) {
 const f = i / (SKY_BANDS - 1);
 ctx.fillStyle = `rgb(${Math.round(A[0] + (B[0] - A[0]) * f)},${Math.round(A[1] + (B[1] - A[1]) * f)},${Math.round(A[2] + (B[2] - A[2]) * f)})`;
 ctx.fillRect(0, i * bh, w, bh + 1); // +1: bands overlap a hair so no seam ever shows
 }
 // **Two passes, and the split is what stops the drift breaking three of the
 // nine skies.** A WASH fills the whole viewport (the sunset's glow, the space
 // nebula, the aurora's bands); drawn twice it would lay its alpha over itself
 // and read as a band of the wrong colour, and slid sideways it would show its
 // own edge. Those belong to the sky itself, like the gradient, and hold still.
 // POINTS — clouds, rain, snow, fog, stars, confetti — are objects at a
 // distance, so they drift, and they are drawn twice a viewport apart so a pan
 // can never open a gap where the field runs out.
 drawSkyFeatures(ctx, w, h, name, t, 'wash');
 drawRidges(ctx, w, h, bg, name, panX);
 const off = w > 0 ? -(((panX % w) + w) % w) : 0;
 for (const dx of (off === 0 ? [0] : [off, off + w])) {
 ctx.save();
 ctx.translate(dx, 0);
 drawSkyFeatures(ctx, w, h, name, t, 'points');
 ctx.restore();
 }
}

// ---------- the horizon, and three bands of land behind it (§10.4) ----------
//
// The sky was a two-stop ramp and a few drifting points. On a 1280×760 frame
// that is about seventy per cent of the picture with nothing in it — no
// horizon, no depth, and no answer to where the camera is when it pans.
//
// Three silhouette bands at 0.08, 0.17 and 0.31 of the camera. They are FILLS,
// not blits: caching the sky as a bitmap was rejected here by measurement
// (a full-viewport drawImage cost more than the fill it replaced), and a band
// is one path of w/6 points and one fill — the same idiom as the 128 gradient
// bands above it.
//
// The profile is evaluated at WORLD x (screen x plus the band's own share of
// the pan), so it is continuous by construction and needs no wrapping and no
// second copy — unlike the points pass, which has a finite field to run out of.
//
// Three octaves through a ridged transform, (1 − |sin|)^1.5, because a plain
// sine reads as a row of blobs and land does not: the transform puts a sharp
// crest where the sine had a smooth peak and a broad saddle where it had a
// trough.
//
// ATMOSPHERIC PERSPECTIVE falls out of deriving the colour rather than
// authoring it: each band is the sky's OWN bottom colour carried toward the
// occlusion ink, further for the near bands, so the furthest is barely
// separated from the air in front of it and the nearest is a silhouette. Nine
// backdrops, no new palette, and a backdrop added later gets its ridges free.
// Nearly doubled 2026-08-23 ("move more"): with the old [0.08, 0.17, 0.31]
// under the old sky factor the nearest ridge crawled at 12% of the camera and
// the farthest at 3% — static enough to read as a painted pane. Still ordered,
// still all below 1 of the sky's own drift, so the layers keep their depth
// order and none overtakes the scenery.
const RIDGE_RATIOS = [0.14, 0.30, 0.55];
// The horizon sits high and the bands are SHALLOW. The first cut put it at
// 0.70 with an amplitude of 0.135 and the hills came out as foreground dunes
// filling the bottom four-tenths of the frame — on Rolling Hills, whose own
// platform sits at 0.43, the backdrop was bigger than the level. A distant
// range is small, and it is the SKY that most of the frame belongs to.
const HORIZON_F = 0.62;

function ridgeProfile(x, band) {
 const per = 210 + band * 130, ph = band * 2.7;
 const o1 = Math.pow(1 - Math.abs(Math.sin(x / per + ph)), 1.5);
 const o2 = Math.pow(1 - Math.abs(Math.sin(x / (per * 0.41) + ph * 2.3)), 1.7);
 const o3 = Math.sin(x / (per * 0.13) + ph * 5) * 0.5 + 0.5;
 return o1 + o2 * 0.42 + o3 * 0.10;
}

// How finely a ridge is walked. 6 px put 427 points on each band at a
// 2560-wide canvas and the profile is far smoother than that; 10 costs
// nothing visible and a third of the path.
const RIDGE_STEP = 10;
// How soft each band's crest is, FARTHEST FIRST (2026-08-23/24, on report:
// *"The mountains still look like they are blurry as if I forgot my glasses.
// The two layer nature makes that so. Just a soft actual blur would be
// better. Or fade."*). The old look was two crisp layers per band — the fill
// and a crest strip 3.2 px under the same profile — and two sharp edges that
// close together is exactly what a misfocused eye produces, which is why it
// read as needing glasses.
//
// It is his "or fade", and the fade is the measurement's choice, not the
// compromise: a real ctx.filter blur on the three bands cost 15 ms a frame at
// 2560×1440 in software raster — ten times the whole sky — because a filter
// pays per pixel. The feather below pays per PATH: the band fills once,
// opaque, and the same Path2D fills three more times, stepped upward at
// falling alpha, which builds a soft gradient crest out of exactly the kind
// of fill this pass already ran. Farther bands feather wider — the eye is
// focused on the machine, so distance is softer, which is what a real
// background does.
const RIDGE_SOFT = [2.2, 1.5, 1.0]; // px per feather step
const RIDGE_FEATHER = [[1, 0.42], [2, 0.20], [3, 0.09]]; // step ×, alpha

function drawRidges(ctx, w, h, bg, name, panX) {
 // A planet level has no ground half and no sky half, so it gets no horizon —
 // the same reason `space` keeps its stars all the way down.
 if (bgOf(name) === 'space') return;
 const base = h * HORIZON_F;
 const ampOf = (b) => h * (0.058 - b * 0.013);
 const y0Of = (b) => base + b * h * 0.030;
 // How far down a band has to be painted. Everything below the band in front
 // of it is covered, so painting to the bottom of the canvas was two whole
 // viewports of overdraw — measured at 2560x1440 as 2.33 ms of the 3.2 ms
 // this redesign cost a frame, nearly three quarters of it.
 //
 // The floor is the next band's LOWEST crest — its y0, where its profile is
 // zero — and not its highest. Taking the highest was the first attempt and
 // it was wrong twice over: the bands are only 0.03h apart with amplitudes
 // near 0.05h, so they interleave, and the "floor" came out ABOVE this
 // band's own lowest crest. The polygon then closed upward and the fill
 // inverted — three hills rendered as three dark hairlines.
 const floorOf = (b) => (b === RIDGE_RATIOS.length - 1 ? h : Math.min(h, y0Of(b + 1) + 2));
 ctx.save();
 for (let b = 0; b < RIDGE_RATIOS.length; b++) {
 const shift = panX * RIDGE_RATIOS[b];
 const amp = ampOf(b);
 const y0 = y0Of(b);
 const foot = floorOf(b);
 const at = (x) => y0 - amp * ridgeProfile(x + shift, b);
 // ONE path, four fills. The opaque fill is the band; the three feather
 // fills are the same path stepped UP at falling alpha, so above the solid
 // crest sits a short gradient into the sky — the soft edge, made of fills
 // rather than of a filter. Below the crest they land on the opaque fill
 // and vanish. (The crest strip that used to be drawn under the profile is
 // gone: it was the second of the two crisp layers, and that double edge
 // WAS the forgot-my-glasses look.)
 const path = new Path2D();
 path.moveTo(0, foot);
 for (let x = 0; x <= w; x += RIDGE_STEP) path.lineTo(x, at(x));
 path.lineTo(w, foot);
 path.closePath();
 // The feather gets its own SHALLOW path — the same crest line closed just
 // deep enough that no shifted copy's bottom edge can surface over sky
 // (bottom = y0 + 3·soft + 2: the deepest upward step leaves it at y0 + 2,
 // still inside the opaque band at every valley). Feathering the full band
 // path was measured first: its fills pay per pixel like any fill, and
 // three copies of a band that runs to the canvas foot were most of a
 // 7.4 ms backdrop. The strip is a twentieth of that area.
 const soft = RIDGE_SOFT[b] ?? 1;
 const yB = y0 + 3 * soft + 2;
 const feather = new Path2D();
 feather.moveTo(0, yB);
 for (let x = 0; x <= w; x += RIDGE_STEP) feather.lineTo(x, at(x));
 feather.lineTo(w, yB);
 feather.closePath();
 // Always DARKER than the air in front of it, whatever the sky. Derived
 // from bg.bot at 0.14 the dusk bands came out lighter than the mid-sky and
 // read as sunlit dunes in the foreground rather than as distance. The ramp
 // is also the FADE the report offered: the farthest band sits nearest the
 // sky's own colour.
 const band = mixHex(bg.bot, LIGHT.occ, 0.15 + b * 0.09);
 ctx.fillStyle = band;
 ctx.fill(path);
 for (const [step, a] of RIDGE_FEATHER) {
 ctx.save();
 ctx.globalAlpha = a;
 ctx.translate(0, -step * soft);
 ctx.fill(feather);
 ctx.restore();
 }
 }
 ctx.restore();
}

function drawSkyFeatures(ctx, w, h, name, t, pass) {
 const points = pass === 'points', wash = pass === 'wash';
 const rand = seedRand(99);
 ctx.save();
 switch (bgOf(name)) {
 case 'dusk': {
 if (!points) break;
 ctx.globalAlpha = 0.10;
 ctx.fillStyle = '#ffffff';
 for (let i = 0; i < 6; i++) {
 const cx = ((rand() * 1.3 + t * 0.006 * (0.4 + rand() * 0.6)) % 1.3 - 0.15) * w;
 const cy = (0.08 + rand() * 0.4) * h;
 const r = (0.09 + rand() * 0.1) * w;
 ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 case 'rain': {
 if (!points) break;
 ctx.globalAlpha = 0.18;
 ctx.strokeStyle = '#7f93b3';
 ctx.lineWidth = 1;
 for (let i = 0; i < 42; i++) {
 const sx = rand() * w, sp = 320 + rand() * 260;
 const yy = (rand() * h + t * sp) % (h + 40) - 20;
 ctx.beginPath(); ctx.moveTo(sx, yy); ctx.lineTo(sx - 4, yy + 15); ctx.stroke();
 }
 break;
 }
 case 'snow': {
 if (!points) break;
 ctx.globalAlpha = 0.5;
 ctx.fillStyle = '#ffffff';
 for (let i = 0; i < 36; i++) {
 const sp = 18 + rand() * 26;
 const sx = (rand() * w + Math.sin(t * 0.7 + i) * 18);
 const yy = (rand() * h + t * sp) % (h + 12) - 6;
 ctx.beginPath(); ctx.arc(sx, yy, 1 + rand() * 1.8, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 case 'fog': {
 if (!points) break;
 ctx.globalAlpha = 0.10;
 ctx.fillStyle = '#ffffff';
 for (let i = 0; i < 5; i++) {
 const yy = (0.25 + i * 0.16) * h;
 const off = ((t * (4 + i * 2.4) + rand() * w * 2) % (w * 1.6)) - w * 0.3;
 ctx.beginPath(); ctx.ellipse(off, yy, w * 0.34, 26 + rand() * 20, 0, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 case 'night': {
 if (!points) break;
 for (let i = 0; i < 60; i++) {
 const sx = rand() * w, sy = rand() * h * 0.75;
 const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (0.4 + rand()) + i));
 ctx.globalAlpha = 0.7 * tw;
 ctx.fillStyle = '#e8ecff';
 ctx.beginPath(); ctx.arc(sx, sy, rand() * 1.3 + 0.3, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 case 'space': {
 // one faint drift of colour, then stars over the WHOLE height — the
 // nebula is the wash (it fills the viewport), the stars are the points
 if (wash) {
 ctx.globalAlpha = 0.16;
 const nx = w * 0.34, ny = h * 0.58;
 const neb = ctx.createRadialGradient(nx, ny, 10, nx, ny, Math.max(w, h) * 0.55);
 neb.addColorStop(0, '#4b3f8f');
 neb.addColorStop(0.55, 'rgba(52,64,138,0.35)');
 neb.addColorStop(1, 'rgba(13,18,38,0)');
 ctx.fillStyle = neb;
 ctx.fillRect(0, 0, w, h);
 break;
 }
 for (let i = 0; i < 110; i++) {
 const sx = rand() * w, sy = rand() * h;
 const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * (0.3 + rand() * 0.8) + i));
 ctx.globalAlpha = 0.85 * tw;
 ctx.fillStyle = i % 9 === 0 ? '#cfd8ff' : '#ffffff';
 ctx.beginPath(); ctx.arc(sx, sy, rand() * 1.2 + 0.25, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 case 'sunset': {
 // the sun AND its rays are one object anchored to the sky, and its glow
 // fills the viewport — all wash, no drift
 if (!wash) break;
 ctx.globalAlpha = 0.30;
 const cx = w * 0.72, cy = h * 0.30;
 const rg = ctx.createRadialGradient(cx, cy, 8, cx, cy, w * 0.45);
 rg.addColorStop(0, '#fff3b0');
 rg.addColorStop(1, 'rgba(255,243,176,0)');
 ctx.fillStyle = rg;
 ctx.fillRect(0, 0, w, h);
 ctx.globalAlpha = 0.10;
 ctx.fillStyle = '#fff3b0';
 for (let i = 0; i < 5; i++) {
 const a = i * 1.257 + t * 0.05;
 ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
 ctx.fillRect(0, -6, w * 0.5, 12);
 ctx.restore();
 }
 break;
 }
 case 'aurora': {
 // bands drawn from x=0 to x=w and filled down to the bottom edge — a
 // wash by construction: shifted it would show its own end
 if (!wash) break;
 ctx.globalAlpha = 0.16;
 for (let b = 0; b < 3; b++) {
 ctx.fillStyle = ['#5ef2b8', '#7ba9ff', '#c07bff'][b];
 ctx.beginPath();
 ctx.moveTo(0, h);
 for (let x = 0; x <= w; x += 24) {
 const yy = h * (0.22 + b * 0.1) + Math.sin(x * 0.008 + t * (0.35 + b * 0.12) + b * 2) * 34;
 ctx.lineTo(x, yy);
 }
 ctx.lineTo(w, 0); ctx.lineTo(0, 0);
 ctx.closePath(); ctx.fill();
 }
 break;
 }
 case 'candy': {
 if (!points) break;
 ctx.globalAlpha = 0.18;
 for (let i = 0; i < 14; i++) {
 const sp = 8 + rand() * 14;
 const sx = rand() * w + Math.sin(t * 0.5 + i * 2) * 12;
 const yy = h + 20 - ((rand() * h + t * sp) % (h + 40));
 ctx.fillStyle = ['#ff9ecb', '#8fe3c6', '#ffd76a'][i % 3];
 ctx.beginPath(); ctx.arc(sx, yy, 4 + rand() * 8, 0, Math.PI * 2); ctx.fill();
 }
 break;
 }
 }
 ctx.restore();
}

// ---------- thumbnails ----------

// Static mini-render of a level preview {terrain, props, fixedParts, build,
// goal, goalObjs, background} onto a canvas (level cards, challenge tiles).
export function renderPreview(canvas, preview, opts = {}) {
 const ctx = canvas.getContext('2d');
 const w = canvas.width, h = canvas.height;
 const bg = BACKGROUNDS[bgOf(preview.background)];
 const grad = ctx.createLinearGradient(0, 0, 0, h);
 grad.addColorStop(0, bg.top); grad.addColorStop(1, bg.bot);
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.fillStyle = grad;
 ctx.fillRect(0, 0, w, h);

 // bounds
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 const grow = (x0, y0, x1, y1) => {
 minX = Math.min(minX, x0); minY = Math.min(minY, y0);
 maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
 };
 // A piece's true extent. Three things this has to get right, all of which it
 // previously did not:
 // - a PAINTED piece has no w/h at all, so `Math.hypot(t.w, t.h)` was NaN and
 // one painted piece anywhere poisoned every bound, dropping the whole
 // thumbnail onto the ±100 fallback below and mis-framing the level;
 // - a rotated box needs its rotated corners, not its diagonal applied to
 // BOTH axes — that made an 800×60 floor reserve an 802×802 square and
 // every flat level render tiny and vertically padded;
 // - props and fixed parts are part of the level and were simply left out, so
 // anything sitting past the terrain got cropped off the edge.
 const growPiece = (o, shapeKey) => {
 if (isPaint(o)) {
 const pts = paintOutlineOf(o);
 if (pts && pts.length) {
 const b = polyBounds(pts);
 grow(b.minX, b.minY, b.maxX, b.maxY);
 }
 return;
 }
 if (o[shapeKey] === 'ball') { grow(o.x - o.r, o.y - o.r, o.x + o.r, o.y + o.r); return; }
 if (!(o.w > 0) || !(o.h > 0)) return; // never let a malformed piece poison the frame
 const b = polyBounds(rectCorners(o)); // angle-aware
 grow(b.minX, b.minY, b.maxX, b.maxY);
 };
 // `opts.goals` — where the SOLVER put the goal pieces before their run
 // (§7.2's staging). A solution card that framed and drew them at the
 // authored spot showed a machine reaching for a goal piece that is not
 // there, which is a thumbnail lying about the run it depicts. Bounds first:
 // a goal staged out past the terrain has to be in frame like anything else.
 const goalAt = (g, i) => (opts.goals?.[i] ? { ...g, x: opts.goals[i].x, y: opts.goals[i].y } : g);
 for (const t of (preview.terrain || [])) growPiece(t, 'type');
 for (const p of (preview.props || [])) growPiece(p, 'shape');
 (preview.goalObjs || []).forEach((g, i) => growPiece(goalAt(g, i), 'shape'));
 for (const z of [...(preview.buildZones || []), ...(preview.goalZones || [])]) growPiece(z, 'shape');
 // `opts.design` is a SOLVED machine drawn over the level — what a solution's
 // share card is (§11.10). It joins the bounds like any other part, or a
 // machine built out past the terrain would be framed off the edge, which is
 // exactly the crop the fixedParts line above exists to prevent.
 const design = opts.design || [];
 for (const part of [...(preview.fixedParts || []), ...design]) {
 if (part.t === 'wheel') grow(part.x - part.r, part.y - part.r, part.x + part.r, part.y + part.r);
 else if (part.t === 'rod') {
 grow(Math.min(part.x1, part.x2), Math.min(part.y1, part.y2),
 Math.max(part.x1, part.x2), Math.max(part.y1, part.y2));
 }
 }
 if (!isFinite(minX)) { minX = -100; minY = -100; maxX = 100; maxY = 100; }
 const pad = 24;
 const sc = Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2));
 ctx.setTransform(sc, 0, 0, sc,
 w / 2 - ((minX + maxX) / 2) * sc,
 h / 2 - ((minY + maxY) / 2) * sc);

 // Terrain: the SAME renderer the game uses, not a second flat-colour
 // impression of it.
 //
 // This used to draw each piece individually with a solid base colour, and
 // every one of the differences that produced was a thumbnail lying about the
 // level: abutting or overlapping same-texture pieces showed an internal seam
 // where the game merges them into one silhouette; the stroke went on AFTER
 // the fill instead of under it, so the outline sat inside the shape at a
 // different weight; grass grew a cap only on boxes, so grass boulders and
 // painted grass hills had none; neon lost its glow; and with sixteen textures
 // — half of which now differ by STRUCTURE rather than hue — a belt, a brick
 // wall and a plank floor were three flat rectangles.
 //
 // `null` views means authored poses (a thumbnail is the level at rest) and
 // time 0 keeps conveyors still, so a thumbnail is deterministic.
 //
 // **The stack is the game's stack** (game.js `_draw`). Scenery, then zones,
 // then planet halos, then labels / terrain / pins, then the moving pieces.
 // A card that drew the violet wash AFTER the floor printed BUILD across
 // every slab the build area covered — "show-through" of a place that, in
 // play, sits on the ground under the level. Same for the goal zone. Same
 // for scenery that used to blit translucent instead of haze-washed, so the
 // sky ghosted through every distant piece.
 drawBackLevel(ctx, preview.backLevel, null, 0, {
 scale: backScaleOf(preview, BACKDROP_SCALE),
 alpha: backAlphaOf(preview, BACKDROP_ALPHA),
 haze: skyHazeOf(preview.background),
 });
 // Zones under everything, exactly as the game has them (game.js "zones under
 // everything").
 drawZones(ctx, preview);
 // A planet is the single most important thing to be able to spot from a
 // level card — it changes what the whole level IS — and without the halo it
 // is just another round boulder (§5.10). Under the terrain so a planet's
 // own texture sits on top of its halo, same as the game.
 drawPlanetHalos(ctx, planetsOf(preview));
 // labels at their three depths (§10.6), the same sequence the editor uses —
 // so a card is the level, not an impression of it
 drawTexts(ctx, preview, 'behind');
 drawTerrainAll(ctx, preview, null, 0);
 drawTerrainPins(ctx, preview, null);
 drawLevelPins(ctx, preview);
 drawTexts(ctx, preview, 'over');
 // A card's pins answer the occupancy question too (§6.3), from the same one
 // pass — a solution card whose every joint read empty would be a picture of
 // a machine that is not bolted together.
 const owners = pinOwnerCounts({ parts: design }, preview, opts.goals);
 const po = { occupied: occupiedPins({ parts: design }, preview, owners), hubKeys: new Set(owners.hubs.keys()) };
 for (const p of (preview.props || [])) drawProp(ctx, p, null, po);
 // wheels and cargo by size, then sticks — same stack as the game
 const cardWheels = [
 ...(preview.fixedParts || []).filter((p) => p.t === 'wheel'),
 ...design.filter((p) => p.t === 'wheel'),
 ];
 const cardGoals = (preview.goalObjs || []).map((g, i) => ({ g, pose: opts.goals?.[i] || null }));
 for (const it of wheelCargoBackToFront(cardWheels, cardGoals, (w) => w.r, (e) => goalStackR(e.g))) {
 if (it.kind === 'wheel') drawWheel(ctx, it.ref, { x: it.ref.x, y: it.ref.y }, po);
 else {
 const { g, pose } = it.ref;
 drawGoalPiece(ctx, g, pose, { ...po, pinOrigin: pose || g });
 }
 }
 drawRods(ctx, (preview.fixedParts || []).filter((p) => p.t === 'rod'), po);
 drawRods(ctx, design.filter((p) => p.t === 'rod'), po);
 drawTexts(ctx, preview, 'front');
 ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// A share card as a JPEG data URL, or null (§11.10). Here rather than in
// game.js because both callers — publishing a level, saving a solution — want
// the identical picture, and because a card that fails to draw must never stop
// a save: the level publishes without one and gets its card on the next save.
export function shareCardDataUrl(preview, opts = {}) {
 try {
 const cv = document.createElement('canvas');
 cv.width = 1200; cv.height = 630; // the size every unfurler wants
 renderPreview(cv, preview, opts);
 // 0.82 puts a busy level around 90-140 KB, inside the server's 400 KB cap
 // and inside what WhatsApp will fetch
 return cv.toDataURL('image/jpeg', 0.82);
 } catch { return null; }
}

// ---------- wordmark (§10.4) ----------
// Built from game pieces, no text glyphs — L/F/R are wheels in their real
// colors with hand-drawn letter strokes, the I's are water-rod capsules with
// end pins, K is four wood-rod segments meeting at one shared pin.

// **The icon is DERIVED from the canvas wheel, not drawn to look like it**
// (2026-08-12, on request: *"Update wheel art. LIFIRIK and toolbars etc."*).
//
// This used to be a flat disc with a thin rim and four beads in a cross, which
// was the `dots` wheel of two pin styles ago. The wheel in play has had a
// machined race with a detent at every slot since 2026-08-11 (§6.1) and its
// drive arrows moved off the pins today, and none of that reached the wordmark,
// the toolbar or the favicon — because they were a separate drawing.
//
// So every radius below comes from the same functions the canvas uses —
// `wheelRings`, `ringSlots`, `rimWidthOf`, `GROOVE_W`, `DETENT_W`, `BARB`,
// `ARROW_SEAT` — measured on a STD_WHEEL_R wheel and scaled into the 24 px
// cell. Change the wheel and the mark follows; there is nothing here to keep in
// step by hand, which is the same promise `letterPathD` already makes for the
// letter strokes.
const CELL_R = 11; // the wheel's radius inside a 24 px cell
// **The thinnest a mark may render before it comes off** (2026-08-12, on
// request: *"Drop detent if needed"*, then *"Maybe drop the arrows as well!"*).
//
// A stroke needs a whole device pixel to read as a line. Under that it is a
// partial-alpha smear, and eight detents plus two arrows ring the letter in grey
// fuzz instead of marking anything. 1.2 px is the bar: measuring the eight-mark
// amplitude round the race puts the collapse just under it — 4.8% of the ring's
// mean at 12 px against 8-15% at every size from 14 up.
//
// **Each mark is judged on its OWN stroke**, not on the icon's size, so the rule
// still holds if any of these constants move. That they currently vanish
// together is arithmetic, not a decision: a detent is DETENT_W (2.0) and an
// arrow shaft is rimWidthOf × 0.8 (2.5 × 0.8 = 2.0), so both are 1.47 px in the
// 24 px cell and both cross 1.2 px at 20 px rendered. The 24 px toolbar keeps
// them; the 16 px favicon, where they are 0.98 px, does not.
//
// The race and the letter never drop. The race is what makes the disc read as a
// wheel rather than a coin, and the letter is the whole point of the mark.
const MARK_MIN_PX = 1.2;
function svgWheelCell(cx, kind, px = 24) {
 const fill = wheelFill(kind);
 const rim = kind === 'cw' ? '#c77c14' : kind === 'ccw' ? '#2f7fd6' : '#9aa5b5';
 const R0 = STD_WHEEL_R;
 const s = CELL_R / R0; // canvas px → cell px
 const cxx = cx + 12, cyy = 12;
 const P = (rad, ang) => [(cxx + Math.cos(ang) * rad).toFixed(2), (cyy + Math.sin(ang) * rad).toFixed(2)];

 const rimW = rimWidthOf(R0) * s;
 const rings = wheelRings(R0);
 let ringR = 0;
 for (const g of rings) ringR = Math.max(ringR, g.rad);
 let innerRingR = 0;
 for (const g of rings) if (g.rad < ringR) innerRingR = Math.max(innerRingR, g.rad);
 // the ring sits ON the rim now, so the race is cut just inside it — the
 // same edge rule drawGroove uses (2026-08-17)
 const raceR = (ringR > R0 - grooveWidth(ringR, R0)
 ? ringR - grooveWidth(ringR, R0) / 2 : ringR) * s;
 const grooveW = grooveWidth(ringR, R0) * s;
 const ink = shade(fill, GROOVE_INK);

 // the race, and a detent at every slot on it — the detents ARE the slots
 const slots = ringSlots(ringR);
 const detentPx = DETENT_W * s * (px / 24);
 let detents = '';
 for (let i = 0; detentPx >= MARK_MIN_PX && i < slots; i++) {
 const a = (i / slots) * Math.PI * 2 - Math.PI / 2;
 const half = (grooveW / 2 + DETENT_OVER * s);
 const [x1, y1] = P(raceR - half, a);
 const [x2, y2] = P(raceR + half, a);
 detents += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#232a35" stroke-width="${(DETENT_W * s).toFixed(2)}" stroke-linecap="butt"/>`;
 }

 // the drive arrows, on the same seat the canvas gives them
 const shaftW = rimWidthOf(R0) * 0.8 * s;
 const seatBand = Math.max((ringR + innerRingR) / 2 + rimWidthOf(R0) * 0.8 * 0.5, PIN_DOT_R + 1 + rimWidthOf(R0) * 0.8 * 0.5) * s;
 const seatPins = Math.max(ringR - PIN_DOT_R - rimWidthOf(R0) * 0.8 * 0.5, R0 * 0.58) * s;
 const ar = ARROW_SEAT.mode === 'band' ? seatBand : seatPins;
 const powered = kind !== 'free';
 const dir = kind === 'cw' ? 1 : -1;
 const hw = Math.max(1.8, BARB.reach * R0) * s;
 const hl = Math.max(3.6, BARB.len * R0) * s;
 const barbR = Math.max(ar - shaftW * 0.5 - hw, (PIN_DOT_R + 1) * s);
 let arrows = '';
 const showArrows = shaftW * (px / 24) >= MARK_MIN_PX;
 for (const from of showArrows ? [Math.PI * 0.25, Math.PI * 1.25] : []) {
 const to = from + Math.PI * 0.5;
 const [sx, sy] = P(ar, from), [ex, ey] = P(ar, to);
 arrows += `<path d="M ${sx} ${sy} A ${ar.toFixed(2)} ${ar.toFixed(2)} 0 0 1 ${ex} ${ey}" fill="none" stroke="${ink}" stroke-width="${shaftW.toFixed(2)}" stroke-linecap="round" opacity=".6"/>`;
 if (!powered) continue;
 const tip = dir > 0 ? to : from;
 const base = tip - dir * Math.min(hl / ar, (to - from) * 0.5);
 const [px, py] = P(barbR, base);
 const [ax, ay] = P(ar - shaftW * 0.5, tip);
 const [bx, by] = P(ar + shaftW * 0.5, tip);
 arrows += `<path d="M ${px} ${py} L ${ax} ${ay} L ${bx} ${by} Z" fill="${ink}" opacity=".6"/>`;
 }

 // **The letter goes on top and at full strength, the arrows sit back at .6.**
 // On the canvas the letter is a faint engraved watermark, and copying that
 // here cost the mark its job: with the letters at .28 the 26 px wordmark
 // spelled nothing at all and a toolbar button stopped saying which wheel it
 // was. The arrows carry the new art; the letter carries the meaning — and
 // with the I's gone the four letters are the whole word.
 //
 // **The cut reaches the marks too** (2026-08-24, "same used for titles,
 // badges etc."): the same warm KEY lip the canvas engraving wears, offset
 // the same 0.092-of-the-letter up-light, under the ink. What does NOT copy
 // across is the ink's alpha — the wheel face can whisper because it is big
 // and repeated; a 22 px mark that whispers spells nothing (see above), so
 // the ink stays solid and only the lip says "cut".
 const letter = letterPathD(kind, cx);
 const lipOff = `translate(${(-LIGHT.x * LETTER_LIP_OFF).toFixed(2)} ${(-LIGHT.y * LETTER_LIP_OFF).toFixed(2)})`;
 const dot = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#232a35"/><circle cx="${x}" cy="${y}" r="${(r * 0.42).toFixed(2)}" fill="#fff"/>`;
 // **The letter is KNOCKED OUT of the machining, not laid over it** (2026-08-12,
 // on request: *"we need the LFR to be XOR'd maybe to be more prominant"*).
 // Drawn on top it was the same near-black as the detents and the arrows it
 // crossed, so at 26 px the four glyphs read as texture and the word did not
 // read at all. The mask cuts a channel 1.8 px wider than the stroke through
 // the race, the detents and the arrows, so the letter always sits in a moat
 // of the wheel's own fill — legible on any of the three colours, and on a
 // light page or a dark one, without a second colour to keep in step.
 const uid = `wm-${kind}-${Math.round((cx + 12) * 10)}`;
 // The moat is 5.0 now, not 4.2: it has to hold the lip too, whose stroke
 // reaches (0.092 × 11) + 1.2 = 2.2 from the path's centreline up-light.
 return `
 <mask id="${uid}" maskUnits="userSpaceOnUse" x="${cx}" y="0" width="24" height="24">
 <rect x="${cx}" y="0" width="24" height="24" fill="#fff"/>
 <path d="${letter}" fill="none" stroke="#000" stroke-width="5.0" stroke-linecap="round" stroke-linejoin="round"/>
 </mask>
 <circle cx="${cxx}" cy="${cyy}" r="${CELL_R}" fill="${fill}"/>
 <circle cx="${cxx}" cy="${cyy}" r="${CELL_R}" fill="none" stroke="${rim}" stroke-width="${rimW.toFixed(2)}"/>
 <g mask="url(#${uid})">
 <circle cx="${cxx}" cy="${cyy}" r="${raceR.toFixed(2)}" fill="none" stroke="${ink}" stroke-width="${grooveW.toFixed(2)}"/>
 ${detents}
 ${arrows}
 </g>
 <path d="${letter}" fill="none" stroke="${LIGHT.key}" stroke-opacity=".8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="${lipOff}"/>
 <path d="${letter}" fill="none" stroke="#232a35" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
 ${dot(cxx, cyy, (PIN_DOT_R * s).toFixed(2))}`;
}

// **The No Wheels badge's wheel, and the toolbar's, are this wheel** (§11.4).
// One cell, no wordmark offset, at whatever size the asker wants — the marks
// inside it thin themselves out below `MARK_MIN_PX` exactly as they do in the
// 26 px wordmark, so a 15 px badge gets the readable subset for free.
export function wheelBadgeSVG(kind = 'free', px = 15) {
 return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false">`
 + svgWheelCell(0, kind, px) + '</svg>';
}

// Published to util.js as this module loads, because the badge lives there and
// the drawing lives here: util.js cannot import this file (render.js imports
// IT), so the art is pushed rather than pulled. Every surface that draws a
// badge already loads the renderer — it is what draws the game — so this is
// what a player sees, and the hand copy in util.js is only a placeholder for
// a page that somehow has badges without a renderer.
setBadgeArt({ freeWheel: wheelBadgeSVG('free', 15) });

function svgWoodK(cx) {
 const rod = (x1, y1, x2, y2) => `
 <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#7d5a38" stroke-width="4.6" stroke-linecap="round"/>
 <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#a87b4f" stroke-width="2.9" stroke-linecap="round"/>`;
 const pin = (x, y) => `<circle cx="${x}" cy="${y}" r="1.3" fill="#232a35"/><circle cx="${x}" cy="${y}" r="0.55" fill="#fff"/>`;
 const jx = cx + 8, jy = 13;
 return `
 ${rod(jx, 3, jx, jy)}${rod(jx, jy, jx, 21)}${rod(jx, jy, cx + 18, 3.5)}${rod(jx, jy, cx + 18, 20.5)}
 ${pin(jx, 3)}${pin(jx, 21)}${pin(cx + 18, 3.5)}${pin(cx + 18, 20.5)}${pin(jx, jy)}`;
}

// L I F I R I K — spaced by INK, not on a fixed cell pitch.
//
// The three glyph builders above all draw inside a nominal 24 px cell, but they
// do not FILL it, and none of them fills it the same way: a wheel is a r=11
// circle whose 1.8 px rim overhangs to 23.8 px, a water I is a 4.6 px capsule
// floating in the middle of a cell, and the K is four rods 14.6 px across whose
// left edge sits 5.7 px into one. On the old 26 px pitch that made the gap
// before the **K** 17.4 px against 11.8 px everywhere else — half again as wide
// as any other gap, and the whole of why the K read as standing on its own.
//
// So each glyph declares where its paint starts within its cell (`ink`) and how
// wide that paint really is (`w`), and the loop below places them nose-to-tail
// with ONE gap between every neighbouring pair. `WORDMARK_GAP` is then the only
// spacing number in the wordmark, which is what makes "the same for all"
// structural rather than something to keep re-tuning by eye.
//
// The numbers are MEASURED, not read off the geometry: the wordmark is
// rasterised and scanned column by column for ink (that is how the rim's 0.9 px
// overhang was caught — declaring the wheel as its nominal 1..23 left the K's
// gap 0.8 px wide of the other five). Re-measure after touching any glyph.
// **The I's are gone, and implied** (2026-08-12, on request: *"lets get rid of
// the Water Rod i's in the name. They can be just implied from now on… All the
// Wheels and sticks ("K") close together."*). Four glyphs now — L F R K — read
// as LIFIRIK because the eye supplies the I's, the way a logo is allowed to.
// `svgWaterI` went with them rather than sitting here unused; git has it if the
// mark ever wants the capsules back.
//
// The gap halves again with them gone. Three 4.6 px capsules were doing a lot
// of the spacing work, and at the old 5.9 the four remaining glyphs read as
// four separate buttons rather than one word.
const WORDMARK_GAP = 2.6; // px between neighbours' ink
const WORDMARK_PAD = 0.1; // px of air before the first letter and after the last
const WORDMARK = [
 { draw: (cx, px) => svgWheelCell(cx, 'ccw', px), ink: 0.1, w: 23.8 }, // L
 { draw: (cx, px) => svgWheelCell(cx, 'free', px), ink: 0.1, w: 23.8 }, // (I) F
 { draw: (cx, px) => svgWheelCell(cx, 'cw', px), ink: 0.1, w: 23.8 }, // (I) R
 { draw: svgWoodK, ink: 5.7, w: 14.6 }, // (I) K
];

export function wordmarkSVG(height = 26) {
 let x = WORDMARK_PAD, cells = '';
 // a 24-unit cell inside a 26-unit-tall viewBox drawn `height` px tall renders
 // at this many device px, which is what decides whether detents survive
 const cellPx = 24 * (height / 26);
 for (const g of WORDMARK) {
 cells += g.draw(x - g.ink, cellPx); // the cell origin that puts this glyph's ink at x
 x += g.w + WORDMARK_GAP;
 }
 // **`ceil`, not `round`** (2026-08-09, reported as "the LIFIRIK brand top left
 // has a tiny bit of the K cut off on the right"). The cursor lands on a
 // fraction — the glyph widths are measured, not whole — and rounding it DOWN
 // shaves that fraction off the viewBox while the K's last round cap is still
 // painting into it. `PAD` is 0.1px, so there was never any slack to absorb
 // it: the rounding was the whole margin. Ceil can only ever add a fraction of
 // transparent air, which nothing can see.
 const vbW = Math.ceil(x - WORDMARK_GAP + WORDMARK_PAD);
 const wpx = Math.round(vbW * (height / 26));
 return `<svg class="wordmark" width="${wpx}" height="${height}" viewBox="0 0 ${vbW} 26" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LIFIRIK"><g transform="translate(0,1)">${cells}</g></svg>`;
}

// Favicon = the L-wheel alone. **16 by default, and that is the detail level as
// well as the box**: a tab icon is drawn at 16 px far more often than anything
// else, and at that size the detents are 0.98 px of smear (see DETENT_MIN_PX).
// One static SVG cannot answer two sizes, so it answers the one people see.
export function faviconSVG(px = 16) {
 return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${svgWheelCell(0, 'ccw', px)}</svg>`;
}

// ---------- toolbar piece icons ----------
// Tool buttons show the matching piece art: wheels without their pins,
// rods with their endpoint pins, terrain/prop/goal as themselves.

const svgPin = (x, y, r = 1.6) =>
 `<circle cx="${x}" cy="${y}" r="${r}" fill="#232a35"/><circle cx="${x}" cy="${y}" r="${r * 0.45}" fill="#fff"/>`;

// The toolbar wheels ARE the wordmark's wheels (2026-08-05, on request):
// this used to be a near-copy of svgWheelCell minus the pins and the hub —
// which made the toolbar sell a wheel with no pins, when the pins are how a
// wheel joins a machine at all. One drawing now, so the piece on the button,
// the piece in the wordmark and the piece inside the No Wheels badge are the
// same object, because they are.
function svgWheelIcon(kind) {
 return svgWheelCell(0, kind, 24); // toolbar buttons draw the cell at its own size
}

function svgRodIcon(kind) {
 if (kind === 'water') {
 return `
 <line x1="5" y1="19" x2="19" y2="5" stroke="#48c6ef" stroke-width="4.4" stroke-linecap="round" opacity=".9"/>
 <line x1="5" y1="19" x2="19" y2="5" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".85"/>
 ${svgPin(5, 19)}${svgPin(19, 5)}`;
 }
 return `
 <line x1="5" y1="19" x2="19" y2="5" stroke="#7d5a38" stroke-width="5.4" stroke-linecap="round"/>
 <line x1="5" y1="19" x2="19" y2="5" stroke="#a87b4f" stroke-width="3.6" stroke-linecap="round"/>
 ${svgPin(5, 19)}${svgPin(19, 5)}`;
}

function svgTerrainIcon(shape) {
 if (shape === 'ball') {
 return `<circle cx="12" cy="12" r="9.5" fill="${TEX.granite.base}" stroke="${TEX.granite.edge}" stroke-width="2"/>
 <circle cx="9" cy="9.5" r="1.1" fill="${TEX.granite.grain}" opacity=".6"/>
 <circle cx="15" cy="13" r="1.3" fill="${TEX.granite.grain}" opacity=".5"/>`;
 }
 return `<rect x="3" y="5" width="18" height="14" rx="3" fill="${TEX.granite.base}" stroke="${TEX.granite.edge}" stroke-width="2"/>
 <circle cx="9" cy="10" r="1.1" fill="${TEX.granite.grain}" opacity=".6"/>
 <circle cx="15" cy="14" r="1.3" fill="${TEX.granite.grain}" opacity=".5"/>`;
}

function svgPropIcon(shape) {
 if (shape === 'ball') {
 return `<circle cx="12" cy="12" r="9" fill="${COLORS.prop}" stroke="${COLORS.propDark}" stroke-width="2"/>`;
 }
 return `<rect x="4" y="4" width="16" height="16" rx="3.5" fill="${COLORS.prop}" stroke="${COLORS.propDark}" stroke-width="2"/>`;
}

function svgGoalIcon(shape) {
 // The BALL, for the goal family's second button (2026-08-12). Same green,
 // same inner race, same four pins as the crate — a goal ball is the same
 // piece with a different silhouette, and the icon says exactly that. The pins
 // sit on the diagonals at r·0.707 so they land on the rim rather than
 // floating off it the way the crate's corner lattice would.
 const hub = `<path d="M 12 9.4 V 14.6 M 9.4 12 H 14.6" fill="none" stroke="${COLORS.goalDark}" stroke-width="1.3" stroke-linecap="butt"/>`;
 if (shape === 'ball') {
 const d = 8.5 * Math.SQRT1_2;
 return `
 <circle cx="12" cy="12" r="9" fill="${COLORS.goal}" stroke="${COLORS.goalDark}" stroke-width="2"/>
 <circle cx="12" cy="12" r="5.5" fill="none" stroke="#fff" stroke-width="1.1" opacity=".7"/>
 ${hub}
 ${svgPin(12 - d, 12 - d, 1.3)}${svgPin(12 + d, 12 - d, 1.3)}${svgPin(12 - d, 12 + d, 1.3)}${svgPin(12 + d, 12 + d, 1.3)}`;
 }
 return `
 <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="${COLORS.goal}" stroke="${COLORS.goalDark}" stroke-width="2"/>
 <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="none" stroke="#fff" stroke-width="1.1" opacity=".7"/>
 ${hub}
 ${svgPin(6.5, 6.5, 1.3)}${svgPin(17.5, 6.5, 1.3)}${svgPin(6.5, 17.5, 1.3)}${svgPin(17.5, 17.5, 1.3)}`;
}

const TOOL_ICON_BODIES = {
 pointer: `<path d="M 7 3.5 L 7 17 L 10.5 13.8 L 13 19.5 L 15.6 18.3 L 13.1 12.8 L 17.8 12.4 Z"
 fill="#fff" stroke="#232a35" stroke-width="1.6" stroke-linejoin="round"/>`,
 'wheel-ccw': svgWheelIcon('ccw'),
 'wheel-free': svgWheelIcon('free'),
 'wheel-cw': svgWheelIcon('cw'),
 'rod-wood': svgRodIcon('wood'),
 'rod-water': svgRodIcon('water'),
 'terrain-box': svgTerrainIcon('box'),
 'terrain-ball': svgTerrainIcon('ball'),
 'prop-box': svgPropIcon('box'),
 'prop-ball': svgPropIcon('ball'),
 'goal-piece': svgGoalIcon('box'),
 'goal-ball': svgGoalIcon('ball'),
 'terrain-paint': svgPaintIcon(),
 // A serif capital T drawn as strokes, not a text glyph — the wordmark's own
 // rule (§10.4): a font the icon relied on is a font somebody hasn't got.
 text: `<path d="M 4.5 6 H 19.5 M 12 6 V 18.5" stroke="currentColor" stroke-width="2.6"
 stroke-linecap="round" fill="none"/>
 <path d="M 8.6 18.5 H 15.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>`,
 delete: `<path d="M 6 6 L 18 18 M 18 6 L 6 18" stroke="#e05555" stroke-width="2.6" stroke-linecap="round"/>`,
 // The pin TOOL (2026-08-08) — the pin exactly as the canvas draws one
 // (drawTerrainPins: a dark disc with a gold core, at its 2.9/1.3 proportions)
 // with four short ticks aiming at it. The ticks are the only part that says
 // "put one HERE" rather than "here is a pin", which is the difference between
 // a tool icon and a picture of the thing.
 pin: `<path d="M 12 2.4 V 5.2 M 12 18.8 V 21.6 M 2.4 12 H 5.2 M 18.8 12 H 21.6"
 stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none" opacity=".55"/>
 <circle cx="12" cy="12" r="6.4" fill="currentColor"/>
 <circle cx="12" cy="12" r="2.9" fill="#ffd76a"/>`,
 // not a tool — the context menu's mini toolbar leads with Play, in the same
 // icon grid as the rest and in the dock's own accent.
 //
 // There was a `stop` square beside it, for the one-cell menu a right-click
 // used to open while a machine ran. That menu is gone (a right-click stops the
 // run outright now), and with it the only caller, so the icon went too rather
 // than sitting here as a thing that draws nothing.
 play: `<path d="M 8 4.8 L 19 12 L 8 19.2 Z" fill="${COLORS.accent}" stroke="${COLORS.accent}"
 stroke-width="1.8" stroke-linejoin="round"/>`,
};

// **The painter, drawn as what it MAKES** (2026-08-12, on request: "change paint
// icon to concave terrain looking thing and place with ball crate in terrains").
//
// It was a paintbrush — a picture of the instrument, in a row where every other
// terrain icon is a picture of the piece. The brush also said "colour", which is
// the one thing this tool does not do: the texture picker does that, and the
// painter's whole point is a shape the box and the ball cannot make.
//
// So: a granite piece with a CONCAVE top, the scooped bowl you would trace by
// hand, in the same base/edge/grain palette as its two siblings. Concave is the
// right word for the icon because it is the shape a rectangle and a circle
// provably cannot give you — the silhouette is the feature.
function svgPaintIcon() {
 return `
 <path d="M 3 20.4 V 8.6 C 6.6 8.6 8.4 11.1 9.7 13.2 C 10.8 15 11.4 15.9 12 15.9
 C 12.6 15.9 13.2 15 14.3 13.2 C 15.6 11.1 17.4 8.6 21 8.6 V 20.4 Z"
 fill="${TEX.granite.base}" stroke="${TEX.granite.edge}" stroke-width="2" stroke-linejoin="round"/>
 <circle cx="6.6" cy="17.4" r="1.1" fill="${TEX.granite.grain}" opacity=".6"/>
 <circle cx="16.8" cy="16.6" r="1.3" fill="${TEX.granite.grain}" opacity=".5"/>`;
}

// `size` only changes the rendered box — the viewBox stays 24×24, so a small
// icon is the identical artwork scaled down rather than a second drawing that
// can drift from it (§8.2 mini toolbar).
export function toolIconSVG(id, size = 24) {
 const body = TOOL_ICON_BODIES[id];
 if (!body) return null;
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}

// Chain wrap: 5 links of hinged chain forming a closed pentagon loop, pins
// at each joint — matches what the tool actually does (wrap a hull of links
// all the way around the selection).
export function chainWrapIconSVG() {
 const pts = [];
 const N = 5;
 for (let i = 0; i < N; i++) {
 const a = -Math.PI / 2 + (i / N) * Math.PI * 2; // first vertex points up
 pts.push([12 + Math.cos(a) * 8.5, 12 + Math.sin(a) * 8.5]);
 }
 let body = '';
 for (let i = 0; i < N; i++) {
 const p0 = pts[i], p1 = pts[(i + 1) % N]; // wraps at i=4 to close the loop
 body += `<line x1="${p0[0].toFixed(1)}" y1="${p0[1].toFixed(1)}" x2="${p1[0].toFixed(1)}" y2="${p1[1].toFixed(1)}" stroke="#7d5a38" stroke-width="4" stroke-linecap="round"/>`;
 body += `<line x1="${p0[0].toFixed(1)}" y1="${p0[1].toFixed(1)}" x2="${p1[0].toFixed(1)}" y2="${p1[1].toFixed(1)}" stroke="#a87b4f" stroke-width="2.4" stroke-linecap="round"/>`;
 }
 for (const [x, y] of pts) body += svgPin(x.toFixed(1), y.toFixed(1), 1.35);
 return `<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;
}

// Touch: two blocks with arrows closing the gap between them — clearer at a
// glance than the handshake emoji it replaces ("slide together until they
// touch", not "cooperate").
// Even spread (the align chip): outer bars solid — they stay put — and the
// middle one hollow with nudge arrows, because it is the one that moves.
export function spreadIconSVG() {
 return `<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
 `<rect x="1.5" y="6.5" width="4.6" height="11" rx="1.4" fill="currentColor"/>` +
 `<rect x="17.9" y="6.5" width="4.6" height="11" rx="1.4" fill="currentColor"/>` +
 `<rect x="9.7" y="6.5" width="4.6" height="11" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
 `<path d="M7.2 12 H8.6 M15.4 12 H16.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>` +
 `</svg>`;
}

// EXPAND / COLLAPSE, for the bar-mode cells in a grip menu (2026-08-12, drawn
// to a picture: three stacked bars over a solid down-triangle). It says "there
// is more of this below" in the one vocabulary a toolbar already speaks — bars
// are what a bar is made of, and the triangle is the same "unfold" arrow every
// disclosure control in the world uses.
//
// `currentColor` throughout, like every other `.ctx-tool` glyph, so it turns
// white on the teal when the mode is on without a second drawing.
//
// Collapsed flips the triangle to point UP: the button is a toggle and the
// arrow is the half of it that says which way it will go, so a fixed arrow
// would be lying in one of the two states.
export function expandIconSVG(expanded = false, size = 18) {
 const bars = [3.6, 8.2, 12.8].map(y => `<rect x="3.5" y="${y}" width="17" height="3.1" fill="currentColor"/>`).join('');
 const tri = expanded
 ? '<path d="M 3.5 22 L 20.5 22 L 12 16.4 Z" fill="currentColor"/>'
 : '<path d="M 3.5 17.2 L 20.5 17.2 L 12 22.8 Z" fill="currentColor"/>';
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${bars}${tri}</svg>`;
}

export function touchIconSVG() {
 return `<svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
 `<rect x="1.5" y="6.5" width="6" height="11" rx="1.5" fill="currentColor"/>` +
 `<rect x="16.5" y="6.5" width="6" height="11" rx="1.5" fill="currentColor"/>` +
 `<path d="M8.7 12 H11.4 M9.9 10.1 L11.6 12 L9.9 13.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
 `<path d="M15.3 12 H12.6 M14.1 10.1 L12.4 12 L14.1 13.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
 `</svg>`;
}

// GROUP / UNGROUP: two chain links, joined or pulled apart (2026-08-10, on
// request that the bar's one chain button also ungroup when that is what the
// selection wants).
//
// **Drawn rather than typed, and the context menu's own comment says why**: it
// carries the pair as two WORDS because there is no glyph for "ungroup" that
// reads as ⛓'s opposite, and the one that looks like it would — a chain with
// U+20E0 over it — does not composite over an emoji base at all. A menu has
// room for words; a 44 px button does not, so this is the third way out. The
// two states differ in exactly one thing, the gap, which is the whole idea.
export function groupIconSVG(broken, size = 22) {
 const link = (x, w) => `<rect x="${x}" y="7.5" width="${w}" height="9" rx="4.5"/>`;
 const body = broken
 // pulled apart, with the snapped ends flicking away from each other so the
 // gap reads as a BREAK rather than as two links that happen to be near
 ? link(1, 9.5) + link(13.5, 9.5)
 + `<path d="M11 9.6 L12.6 8.2 M11 14.4 L12.6 15.8" stroke-width="1.6"/>`
 : link(2.5, 12) + link(9.5, 12);
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${body}</g></svg>`;
}

// FREE WORLD: a wireframe globe (2026-08-10, on request, from a reference
// drawing). The whole world, rather than the ✦ Free the button wore — which
// was a sparkle, and a sparkle means "new" or "magic" everywhere else it has
// ever been printed. This mode's promise is exactly one thing: the WORLD is
// yours to build in, not the violet box.
//
// **`currentColor`, and that is what makes the on-state work.** The button
// fills solid purple when the mode is on (`.free-world.active`), so an icon
// with the weave's purple baked into it would go invisible at precisely the
// moment it is telling you something. Off, the button carries the purple as
// its text colour and the globe inherits it; on, the colour flips to white and
// the globe comes with it.
//
// The latitudes are drawn as ARCS bowing away from the equator, which is a lie
// an orthographic globe does not tell — every latitude circle projects to a
// straight chord from this viewpoint — and is what the reference drew, what
// every globe icon draws, and what actually reads as a sphere at 18 px. A
// straight-chord version was rendered beside it and looks like a grid in a
// circle.
export function freeWorldIconSVG(size = 18) {
 const bow = 2.6; // how far the latitude arcs lift off their chord
 const lat = (y) => {
 // where the circle is at that height, so an arc starts and ends ON it
 const dx = Math.sqrt(Math.max(0, 100 - (y - 12) ** 2));
 const dir = y < 12 ? -1 : 1; // away from the equator, both halves
 return `M ${(12 - dx).toFixed(2)} ${y} Q 12 ${(y + dir * bow).toFixed(2)} ${(12 + dx).toFixed(2)} ${y}`;
 };
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">`
 + `<circle cx="12" cy="12" r="10"/>`
 + `<line x1="12" y1="2" x2="12" y2="22"/>`
 + `<line x1="2" y1="12" x2="22" y2="12"/>`
 + `<ellipse cx="12" cy="12" rx="4.7" ry="10"/>`
 + `<path d="${lat(7.4)}"/>`
 + `<path d="${lat(16.6)}"/>`
 + `</g></svg>`;
}

// GHOSTRUN: a ghost, drawn as a wireframe like the globe beside it — same
// stroke weight, same `currentColor`, so the two mode switches on the Advanced
// bar read as a pair and the icon survives the button filling in behind it.
//
// **Tall and narrow, because the button is** (§ GhostRun: a half-width cell).
// The natural silhouette of the thing is exactly that shape, which is the happy
// half of the constraint: a 16×24 viewBox at a 44 px button's height comes out
// at the same optical weight as the 24×24 glyphs, without the letterboxing an
// icon drawn square would need.
//
// The hem is three scallops rather than the four or five a bigger drawing would
// take — at 22 px wide a fourth is a wobble, and the shape has to say "ghost"
// at a glance or it says nothing. The eyes are filled dots for the same reason
// the globe's meridians are arcs: it is what reads, not what is true.
export function ghostIconSVG(size = 26) {
 const w = Math.round(size * (16 / 24));
 return `<svg width="${w}" height="${size}" viewBox="0 0 16 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<path d="M 2.6 20.6 L 2.6 9.4 A 5.4 5.4 0 0 1 13.4 9.4 L 13.4 20.6`
 + ` q -1.8 2.7 -3.6 0 q -1.8 -2.7 -3.6 0 q -1.8 2.7 -3.6 0 Z"`
 + ` fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>`
 + `<circle cx="5.9" cy="9.6" r="1.25" fill="currentColor"/>`
 + `<circle cx="10.1" cy="9.6" r="1.25" fill="currentColor"/>`
 + `</svg>`;
}

// **The road the cargo took** (§ GhostRun) — every goal piece's path from the
// start of the run to the moment the ghost is aiming at, drawn as one line.
//
// Two strokes, which is this file's standard answer for a mark that has to stay
// legible over anything (see `_pulseShapes`): a soft wide one that carries the
// shape across pale grass and a thin bright one that survives dark terrain.
// Widths divided by the ZOOM, so it is a line at every scale rather than a hair
// at 4× and a ribbon at 0.3×.
//
// The goal piece's own green, because the road belongs to the thing at the end
// of it — the same argument that gave the goal ZONE that green in the first
// place (`drawZones`): the place, the cargo and the way there are one colour,
// and the machine keeps its own.
export function drawGoalTrace(ctx, pts, opts = {}) {
 if (!pts || pts.length < 2) return;
 const z = opts.zoom || 1;
 const a = opts.alpha ?? 1;
 // `rgb` lets the same road be drawn in a second colour for the cell under the
 // pointer (§ GhostRun's hover preview): green is the cargo's own road, and a
 // possibility that is not the current one must not claim it.
 const rgb = opts.rgb || '26,230,128';
 ctx.save();
 ctx.lineJoin = 'round';
 ctx.lineCap = 'round';
 if (opts.dash) ctx.setLineDash(opts.dash.map((v) => v / z));
 ctx.beginPath();
 ctx.moveTo(pts[0].x, pts[0].y);
 for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
 for (const [w, al] of [[7 / z, 0.16 * a], [1.9 / z, 0.8 * a]]) {
 ctx.lineWidth = w;
 ctx.strokeStyle = `rgba(${rgb},${al.toFixed(3)})`;
 ctx.stroke();
 }
 // ---------- TIME PIPS: speed you can count (2026-08-23) ----------
 //
 // The trace is one sample per fixed step, so the SPACING along it already
 // is the cargo's speed — bunched where it dawdles, strung out where it
 // flies. Nothing said so. The ten cargo stamps along the road were the only
 // speed cue, and they are a fixed COUNT over the whole run: at a half-second
 // aim they sit 0.05 s apart and at a hundred-second aim 10 s apart, so
 // "bunched" and "strung out" were relative to a scale that moved with the
 // dial and was never printed.
 //
 // A pip every quarter second and a longer one on the second is a scale that
 // does not move: six pips to the hill is a second and a half, at any aim.
 // Both sets are one path and one stroke, halo under and ink over — the same
 // two-pass idiom the road itself uses, so they read over grass, snow and
 // lava alike.
 if (opts.pips !== false && pts.length > 3) {
 const per = opts.perSecond || 30; // samples in a second
 const minor = Math.max(1, Math.round(per / 4));
 const run = (every, half) => {
 ctx.beginPath();
 let drew = false;
 for (let i = every; i < pts.length - 1; i += every) {
 if (every === minor && i % (minor * 4) === 0) continue; // a major owns that one
 const p = pts[i], q = pts[i + 1] || pts[i - 1];
 const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy);
 if (l < 1e-6) continue;
 const nx = -dy / l * half, ny = dx / l * half;
 ctx.moveTo(p.x + nx, p.y + ny);
 ctx.lineTo(p.x - nx, p.y - ny);
 drew = true;
 }
 if (!drew) return;
 ctx.lineWidth = (half > 5 ? 2.1 : 1.4) / z;
 ctx.strokeStyle = `rgba(255,255,255,${(0.55 * a).toFixed(3)})`;
 ctx.stroke();
 ctx.lineWidth = (half > 5 ? 1.3 : 0.9) / z;
 ctx.strokeStyle = `rgba(${rgb},${(0.95 * a).toFixed(3)})`;
 ctx.stroke();
 };
 ctx.setLineDash([]);
 run(minor, 3.4 / z);
 run(minor * 4, 6.2 / z);
 }
 ctx.restore();
}

// **Where the cargo is being asked to GO** (§ GhostRun) — the sweep's target,
// as a crosshair you can pick up and put anywhere.
//
// It exists because distance-to-the-goal is not a route (util.js `ghostAimGap`
// says why at length): sometimes the cargo has to be carried away from the goal
// before anything can carry it there, and only the person building the machine
// knows that. So the mark is draggable and the goal is merely where it starts.
//
// **Gold, and neither of the colours already spoken for.** Violet is the build
// area and green is the goal — a target drawn in either would be claiming to be
// one of them. Gold is this game's "the thing being aimed at" colour already
// (the selection anchor's ring), which is exactly the sense wanted.
//
// Hollow at the centre, so whatever it is parked on stays visible: the whole
// point of putting it somewhere is that somewhere matters. Sized in SCREEN px
// (everything divided by the zoom) — it is a control, not a thing in the world,
// and a control that shrinks to nothing when you zoom out is unusable at the
// exact moment you are placing it across the level.
export function drawGhostTarget(ctx, pt, opts = {}) {
 if (!pt) return;
 const z = opts.zoom || 1;
 const R = 11 / z, arm = 17 / z;
 const a = opts.dim ? 0.5 : 1; // still on the goal = still a default
 ctx.save();
 ctx.lineCap = 'round';
 // a dark under-stroke, so the mark survives a pale sky and a dark hillside
 // alike — the same two-pass trick every other mark that must not be lost uses
 for (const [w, col] of [[4.4 / z, `rgba(35,42,53,${(0.30 * a).toFixed(3)})`], [2.1 / z, `rgba(212,160,23,${(0.95 * a).toFixed(3)})`]]) {
 ctx.lineWidth = w;
 ctx.strokeStyle = col;
 ctx.beginPath();
 ctx.arc(pt.x, pt.y, R, 0, Math.PI * 2);
 ctx.moveTo(pt.x - arm, pt.y); ctx.lineTo(pt.x - R * 0.45, pt.y);
 ctx.moveTo(pt.x + R * 0.45, pt.y); ctx.lineTo(pt.x + arm, pt.y);
 ctx.moveTo(pt.x, pt.y - arm); ctx.lineTo(pt.x, pt.y - R * 0.45);
 ctx.moveTo(pt.x, pt.y + R * 0.45); ctx.lineTo(pt.x, pt.y + arm);
 ctx.stroke();
 }
 if (opts.tag) {
 ctx.font = `700 ${11 / z}px system-ui, sans-serif`;
 ctx.textAlign = 'center';
 ctx.textBaseline = 'bottom';
 ctx.lineWidth = 3 / z;
 ctx.strokeStyle = 'rgba(255,255,255,0.85)';
 ctx.strokeText(opts.tag, pt.x, pt.y - arm - 2 / z);
 ctx.fillStyle = `rgba(150,110,10,${a.toFixed(2)})`;
 ctx.fillText(opts.tag, pt.x, pt.y - arm - 2 / z);
 }
 if (opts.label) {
 // **Beside it, not above it.** Above is where the goal zone prints its own
 // "GOAL", and the crosshair's default position is the middle of that zone —
 // so a centred label landed exactly on the word every time the mark had not
 // been moved yet. To the right there is nothing to collide with in either
 // state, and the reading order still runs mark-then-number.
 ctx.font = `700 ${12 / z}px system-ui, sans-serif`;
 ctx.textAlign = 'left';
 ctx.textBaseline = 'middle';
 ctx.lineWidth = 3 / z;
 ctx.strokeStyle = 'rgba(255,255,255,0.85)';
 ctx.strokeText(opts.label, pt.x + arm + 3 / z, pt.y);
 ctx.fillStyle = `rgba(150,110,10,${a.toFixed(2)})`;
 ctx.fillText(opts.label, pt.x + arm + 3 / z, pt.y);
 }
 ctx.restore();
}

// **Which pad is which** (§ GhostRun, more than one goal zone). The menu
// talks about "goal 2"; this is that number, on the zone itself, so the two
// cannot disagree. Gold, like every other GhostRun mark.
export function drawGhostZoneIndex(ctx, zone, n, opts = {}) {
 if (!zone) return;
 const z = opts.zoom || 1;
 const a = opts.active ? 1 : 0.5;
 ctx.save();
 ctx.font = `700 ${14 / z}px system-ui, sans-serif`;
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 ctx.lineWidth = 3.4 / z;
 ctx.strokeStyle = 'rgba(255,255,255,0.9)';
 const s = String(n);
 ctx.strokeText(s, zone.x, zone.y);
 ctx.fillStyle = `rgba(150,110,10,${a.toFixed(2)})`;
 ctx.fillText(s, zone.x, zone.y);
 ctx.restore();
}

// **A road the player drew** (§ GhostRun) — the corners they put down, in the
// order the cargo travels them, ending at the goal.
//
// Drawn as a route rather than as a set of marks: a line with the corners on it,
// numbered, and an arrowhead on each leg so the ORDER is visible. Order is the
// whole content of a road — "all the way left, then right and down" is the same
// four points as "right and down, then all the way left" and means the opposite.
//
// Gold, like the single crosshair it grew out of, and for the same reason:
// violet is the build area and green is the goal, so a road drawn in either
// would be claiming to be one of them.
export function drawGhostRoad(ctx, pts, goalPt, opts = {}) {
 if (!pts?.length) return;
 const z = opts.zoom || 1;
 const a = opts.dim ? 0.35 : 1;
 const nodes = goalPt ? [...pts, goalPt] : pts;
 ctx.save();
 ctx.lineCap = 'round';
 ctx.lineJoin = 'round';
 // the two-pass stroke every mark that must survive any background uses here
 for (const [w, col] of [[5 / z, `rgba(35,42,53,${(0.22 * a).toFixed(3)})`], [2 / z, `rgba(212,160,23,${(0.95 * a).toFixed(3)})`]]) {
 ctx.lineWidth = w;
 ctx.strokeStyle = col;
 ctx.beginPath();
 ctx.moveTo(nodes[0].x, nodes[0].y);
 for (let i = 1; i < nodes.length; i++) ctx.lineTo(nodes[i].x, nodes[i].y);
 ctx.stroke();
 }
 // an arrowhead at the middle of each leg — which way the cargo is meant to go
 ctx.fillStyle = `rgba(212,160,23,${(0.95 * a).toFixed(3)})`;
 for (let i = 0; i < nodes.length - 1; i++) {
 const A = nodes[i], B = nodes[i + 1];
 const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
 if (len < 24 / z) continue;
 const mx = A.x + dx / 2, my = A.y + dy / 2, ux = dx / len, uy = dy / len;
 const h = 7 / z, wdt = 4.2 / z;
 ctx.beginPath();
 ctx.moveTo(mx + ux * h, my + uy * h);
 ctx.lineTo(mx - ux * h - uy * wdt, my - uy * h + ux * wdt);
 ctx.lineTo(mx - ux * h + uy * wdt, my - uy * h - ux * wdt);
 ctx.closePath();
 ctx.fill();
 }
 // the corners themselves, numbered, because they are what you drag
 const R = 6.5 / z;
 ctx.font = `700 ${10 / z}px system-ui, sans-serif`;
 ctx.textAlign = 'center';
 ctx.textBaseline = 'middle';
 pts.forEach((q, i) => {
 ctx.beginPath();
 ctx.arc(q.x, q.y, R, 0, Math.PI * 2);
 ctx.fillStyle = `rgba(255,255,255,${(0.92 * a).toFixed(3)})`;
 ctx.fill();
 ctx.lineWidth = 2 / z;
 ctx.strokeStyle = `rgba(212,160,23,${(0.95 * a).toFixed(3)})`;
 ctx.stroke();
 ctx.fillStyle = `rgba(120,88,8,${a.toFixed(2)})`;
 ctx.fillText(String(i + 1), q.x, q.y + 0.4 / z);
 });
 // whose road it is, once a level has more than one thing to deliver
 if (opts.many && opts.cargo != null) {
 ctx.font = `700 ${11 / z}px system-ui, sans-serif`;
 ctx.lineWidth = 3 / z;
 ctx.strokeStyle = 'rgba(255,255,255,0.85)';
 ctx.textAlign = 'left';
 const tag = `▸ ${opts.cargo}`;
 ctx.strokeText(tag, pts[0].x + 10 / z, pts[0].y - 10 / z);
 ctx.fillStyle = `rgba(150,110,10,${a.toFixed(2)})`;
 ctx.fillText(tag, pts[0].x + 10 / z, pts[0].y - 10 / z);
 }
 if (opts.label) {
 const end = nodes[nodes.length - 1];
 ctx.font = `700 ${12 / z}px system-ui, sans-serif`;
 ctx.textAlign = 'left';
 ctx.lineWidth = 3 / z;
 ctx.strokeStyle = 'rgba(255,255,255,0.85)';
 ctx.strokeText(opts.label, end.x + 14 / z, end.y);
 ctx.fillStyle = `rgba(150,110,10,${a.toFixed(2)})`;
 ctx.fillText(opts.label, end.x + 14 / z, end.y);
 }
 ctx.restore();
}

// **What the pin sweep MEASURED** (§ GhostRun) — one square per cell, painted
// into the sweep chip's own little canvas rather than onto the level.
//
// It is drawn at all because of what the search space is. On a boundary that
// box-counts at D≈1.44 the winning cells are not a hill with a top, they are
// scattered — so a tool that swept a thousand positions and quietly reported
// one of them would be throwing away the only picture anyone has of where the
// good ones ARE. The field is the answer; the winner is a bookmark in it.
//
// **It is a CHIP, not an overlay** (2026-08-21, on request: *"The graph should
// be presented in a relocatable chip/tile"*). Drawn over the level it could
// only ever be legible at the coarsest rung: the finest sweep spans 0.32 world
// px, which is a third of one pixel on screen at 1× and nothing at all zoomed
// out. In a tile each cell is 4 px whatever the rung is measuring, so the three
// resolutions are the same picture at three scales instead of one picture and
// two invisible ones.
//
// **Only the cells that BEAT the machine you already have are painted.** The
// haystack is the overwhelming majority and painting it would bury the needles
// in exactly the noise this is meant to cut through — so "no better" is the
// bare tile, and what you see is a scatter of bright cells, which is the honest
// shape of the result. Cells the EDITOR refuses (a stick through the ground, a
// piece out of the build zone) get a faint slate wash instead of nothing,
// because "you may not put it there" and "there is nothing there" are different
// answers and only one of them is about physics.
//
// `cells` is row-major from the top-left, `NaN` for a cell not yet reached — so
// this draws a sweep in progress exactly as it draws a finished one, and the
// tile fills in as it goes.
export function drawSweepField(ctx, field, size, opts = {}) {
 if (!field?.cells) return;
 // **The chip's paper and ink follow its plate** (2026-08-24, the dark
 // follow-through): the caller may pass `bg` and `ink` read live off the
 // chip's computed tokens. The defaults are the exact literals this function
 // has always painted, so a caller passing nothing — every gate — is
 // byte-identical, and the marks derive their alphas from ONE ink.
 const inkRGB = /^#?[0-9a-f]{6}$/i.test(String(opts.ink || '').replace('#', ''))
 ? hexRGB(String(opts.ink).startsWith('#') ? opts.ink : '#' + opts.ink)
 : [35, 42, 53];
 const inkA = (a) => `rgba(${inkRGB[0]},${inkRGB[1]},${inkRGB[2]},${a})`;
 const { side, base, best } = field;
 // `size` is the tile's width. Height may differ — the Ghost chip matches
 // Play/Advanced in width and grows as tall as the field wants when a
 // matrix lands (opts.h, or `{w,h}`). A number still means a square, so
 // every gate passing 64 stays byte-identical.
 const tw = size?.w ?? size;
 const th = size?.h ?? opts.h ?? tw;
 const cw = tw / side, ch = th / side; // one cell, in tile px
 ctx.save();
 ctx.clearRect(0, 0, tw, th);
 ctx.fillStyle = opts.bg || '#f4f6fb';
 ctx.fillRect(0, 0, tw, th);
 // **What "no better" is measured against.** Normally the origin cell — the
 // machine you already have, which the sweep measures first for exactly this
 // reason. But it can itself be Infinity: the editor is entitled to refuse the
 // build's own pin position (a Free World machine with a piece outside the
 // zone), and dividing by an infinite span paints the whole box in NaN. So the
 // reference falls back to the worst finite cell measured, which keeps the
 // grading honest — the field still says which cells are better than which.
 let worst = -Infinity;
 for (const v of field.cells) if (Number.isFinite(v) && v > worst) worst = v;
 let hi = base;
 if (!Number.isFinite(hi)) hi = worst;
 const span = Math.max(1e-6, hi - best); // how much there was to win
 const usable = Number.isFinite(hi) && Number.isFinite(best);
 // **…and how much there was to LOSE** (2026-08-22: *"I think colour
 // in the white with shades of red. Scale: red -> green -> gold"*). The blank
 // half of the field was never "no data" — it was every position that scored
 // WORSE than the machine you already have, which is most of the box, and on
 // a sweep whose origin already delivers it is ALL of it: nothing can be
 // nearer than delivered, so a working machine used to paint gold dots on
 // white paper and show no gradient at all. Now the same ramp runs both ways
 // from the origin, and a field always has a shape to read.
 const lossSpan = Math.max(1e-6, worst - hi);
 // **A cell that DELIVERED is gold, and graded on how FAST** (2026-08-21, on
 // request: *"If 'Delivered' a gold dot in the middle of the matrix? … Or maybe
 // the whole cell gold graded on speed?"* — the second, and it is the better
 // of the two).
 //
 // Green grades on DISTANCE, which every winner has already reduced to zero: a
 // dozen positions that all deliver came out identically bright, and the
 // question you actually have next is which of them delivers SOONEST. Gold has
 // that answer, and it costs nothing to give — `winTimes` is stored per cell
 // already, so this is a fill, not a rollout.
 //
 // Two families, two meanings: green says how near it got, gold says how fast
 // it arrived. And gold is this game's "the one you want" colour, so the
 // winners read out of the field before you have looked at anything else.
 //
 // Opaque, not a wash: a pale gold over a pale green would sit between the two
 // families and belong to neither.
 const wins = field.flags && field.winTimes;
 let fast = Infinity, slow = -Infinity;
 if (wins) {
 for (let i = 0; i < field.cells.length; i++) {
 if (!(field.flags[i] & CELL_WON)) continue;
 const t = field.winTimes[i];
 if (!Number.isFinite(t)) continue;
 if (t < fast) fast = t;
 if (t > slow) slow = t;
 }
 }
 const winSpan = Math.max(1e-6, slow - fast);
 for (let i = 0; i < field.cells.length; i++) {
 const v = field.cells[i];
 if (Number.isNaN(v)) continue;
 const x = (i % side) * cw, y = Math.floor(i / side) * ch;
 let fill = null;
 if (wins && (field.flags[i] & CELL_WON)) {
 // fastest is the deepest gold, slowest the palest — more of the good
 // thing, more colour. A single winner has nothing to grade against and
 // takes the full strength it has earned.
 const t = field.winTimes[i];
 const f = Number.isFinite(t) && slow > fast ? clamp((slow - t) / winSpan, 0, 1) : 1;
 fill = `rgb(${Math.round(245 - 69 * f)},${Math.round(215 - 91 * f)},${Math.round(130 - 122 * f)})`;
 } else if (v === Infinity) fill = 'rgba(120,140,165,0.30)'; // the editor said no — hatched below too
 else if (usable && v < hi - 1e-9) {
 // graded over the range the sweep actually found, so the best cell is
 // full strength whether it won by 400 px or by 4
 const g = clamp((hi - v) / span, 0, 1);
 fill = `rgba(19,166,92,${(0.16 + 0.78 * g).toFixed(3)})`;
 } else if (usable && v > hi + 1e-9) {
 // The same two alphas the other way, in the palette's own danger red
 // (`--danger` / `UNSEEN_TINT`), graded over the range the sweep found
 // BELOW the origin. Two families, one axis: how far from the machine you
 // already have, and which side of it. The origin itself takes neither —
 // it is the zero of both ramps and is drawn with its own outline.
 const b = clamp((v - hi) / lossSpan, 0, 1);
 fill = `rgba(226,52,52,${(0.16 + 0.78 * b).toFixed(3)})`;
 }
 if (!fill) continue;
 ctx.fillStyle = fill;
 ctx.fillRect(x, y, Math.ceil(cw), Math.ceil(ch));
 }
 // **A refused cell is HATCHED, not merely tinted** (2026-08-23, on report:
 // *"Ghost Matrix needs different colour for out of bounds cells. Currently
 // blends with the white cells too closely."* Measured, the report is exactly
 // right and no colour fixes it: the old 0.22 slate wash composited to within
 // 3 luma of the PALEST graded cells — the 0.16-alpha ends of both the green
 // and the red ramps — so whatever alpha the tint took, it collided with some
 // rung of a ramp somewhere. The two ramps own brightness; "not a place at
 // all" has to say so in a different channel, and the diagonal hatch is the
 // map-maker's word for it. Same law as the tool cell's broken rail and the
 // family pill: shape reads before brightness.
 ctx.strokeStyle = 'rgba(84,99,120,0.55)';
 ctx.lineWidth = 1;
 ctx.beginPath();
 for (let i = 0; i < field.cells.length; i++) {
 if (field.cells[i] !== Infinity) continue;
 const x = (i % side) * cw, y = Math.floor(i / side) * ch;
 ctx.moveTo(x, y + ch);
 ctx.lineTo(x + cw, y);
 }
 ctx.stroke();
 // **Grid lines, and they are affordable** (2026-08-21: *"Can we afford some
 // grid lines for the matrices?"*). Thirty-two strokes into a 150 px canvas
 // against 225 rollouts — the sweep does not notice, and neither would a sweep
 // ten times the size.
 //
 // What they buy is COUNTING. The readout gives a cell's offset in px, but the
 // thing you do with a field is look at a bright patch and work out where it is
 // relative to the middle — and a wash of adjacent same-coloured cells has no
 // marks to count. A heavier line every SWEEP_GRID_MAJOR gives that a scale.
 //
 // Over the fills rather than under, because separating two neighbours that
 // scored alike is the whole job; faint enough that the data still reads as the
 // message and the lines as the paper. And the half-pixel offset is what keeps
 // a 1 px line one pixel instead of a 2 px smear — the cell size is a whole
 // number by construction (`SWEEP_CHIP_UNIT`), so every line lands on an
 // integer and every one of them needs it.
 // The OUTER edges are left to the canvas's own CSS border — drawing them here
 // as well doubles the left and top and misses the right and bottom, which sit
 // half a pixel outside the bitmap.
 ctx.lineWidth = 1;
 for (let i = 1; i < side; i++) {
 const atX = Math.round(i * cw) + 0.5, atY = Math.round(i * ch) + 0.5;
 ctx.strokeStyle = (i % SWEEP_GRID_MAJOR === 0) ? inkA(0.24) : inkA(0.10);
 ctx.beginPath();
 ctx.moveTo(atX, 0); ctx.lineTo(atX, th);
 ctx.moveTo(0, atY); ctx.lineTo(tw, atY);
 ctx.stroke();
 }

 // The machine you already have, so the picture has a "you are here". A cross
 // rather than a fill: the origin cell carries a score like any other and
 // covering it would hide the one number the rest are graded against.
 if (field.originIdx != null) {
 const ox = (field.originIdx % side) * cw + cw / 2, oy = Math.floor(field.originIdx / side) * ch + ch / 2;
 ctx.strokeStyle = inkA(0.75);
 ctx.lineWidth = 1.2;
 ctx.beginPath();
 ctx.moveTo(ox - cw, oy); ctx.lineTo(ox + cw, oy);
 ctx.moveTo(ox, oy - ch); ctx.lineTo(ox, oy + ch);
 ctx.stroke();
 }
 // **A ring on the winner, in nothing the field can paint** (2026-08-21: *"
 // Highlight the best one."*). It used to be gold — which was fine while the
 // field was green, and went invisible the moment delivering cells became gold
 // themselves: on a level where a lot of positions work, the mark for THE one
 // was lost in a wash of near-identical gold.
 //
 // So it is drawn the way every mark in this game that has to survive any
 // background is drawn: two passes, a heavy ink ring with a bright core inside
 // it. Ink reads on gold and on pale green; white reads on ink and on slate.
 // Between them there is no fill this field can produce that swallows it.
 //
 // Sized from the CELL, so it is a ring at 7 px a cell and still a ring at 18 —
 // and drawn a whisker outside its cell, which is what keeps it distinct from
 // the thin inside line the hovered cell gets.
 if (field.bestIdx != null) {
 const w = Math.max(2.5, Math.min(cw, ch) * 0.22);
 const bx = (field.bestIdx % side) * cw, by = Math.floor(field.bestIdx / side) * ch;
 for (const [lw, col] of [[w, 'rgba(35,42,53,0.95)'], [w * 0.45, 'rgba(255,255,255,0.95)']]) {
 ctx.lineWidth = lw;
 ctx.strokeStyle = col;
 ctx.strokeRect(bx - w / 2, by - w / 2, cw + w, ch + w);
 }
 }
 // …and the cell under the pointer, so a click can be aimed.
 if (field.hoverIdx != null) {
 ctx.strokeStyle = inkA(0.9);
 ctx.lineWidth = 1.5;
 ctx.strokeRect((field.hoverIdx % side) * cw - 0.5, Math.floor(field.hoverIdx / side) * ch - 0.5, cw + 1, ch + 1);
 }
 ctx.restore();
}

// Corner-rounding toggle: a small square swatch showing sharp/8px/16px
// corners, used as a show-and-tell trio instead of a "corner 8"/"corner 0"
// text label. `px` is the actual piece corner radius (0/8/16) — icon rx
// scales with it so the three icons read as visibly distinct steps.
const CORNER_ICON_RX = { 0: 0, 8: 6, 16: 10 };
export function cornerIconSVG(px) {
 const rx = CORNER_ICON_RX[px] ?? 0;
 return `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="${rx}" fill="none" stroke="currentColor" stroke-width="2.6"/></svg>`;
}

// Z-order chevrons: one chevron = one layer, two = all the way. Drawn as a
// four-icon ladder (front / up / down / back) so the direction reads without
// language, with the words and keys left to the tooltips.
const Z_ICON_CHEVRONS = {
 one: [[6, 15, 12, 9, 18, 15]],
 all: [[6, 11, 12, 5, 18, 11], [6, 19, 12, 13, 18, 19]],
};
// **The campaign nav's arrows** (2026-08-19, picture: a solid,
// rounded arrowhead, like ▶ but drawn, at Record's width). One shape — a
// triangle with a rounded join, filled with the button's own colour — turned
// left, up or right; the up one is the way to the set's list.
export function navArrowSVG(dir, size = 9) {
 const rot = dir === 'left' ? 180 : dir === 'up' ? -90 : 0;
 return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<path d="M7 4.5 L19 12 L7 19.5 Z" fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" transform="rotate(${rot} 12 12)"/></svg>`;
}

// Mouse with one button lit — bindings chip L/M/R stand-ins. Double-click
// is the same mouse with a 2 on the body, so every row's icon is one size.
export function mouseButtonIconSVG(which, size = 14) {
 const dbl = which === 'dbl';
 const L = which === 'left' || dbl, M = which === 'middle', R = which === 'right';
 return `<svg width="${size}" height="${size}" viewBox="0 0 16 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<path d="M3.2 8.2 C3.2 17.2 5.2 18.6 8 18.6 C10.8 18.6 12.8 17.2 12.8 8.2" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<path d="M3.2 8.2 C3.2 3.6 5.4 2.2 8 2.2 L8 8.2 Z" fill="${L ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<path d="M12.8 8.2 C12.8 3.6 10.6 2.2 8 2.2 L8 8.2 Z" fill="${R ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<rect x="7.15" y="3.6" width="1.7" height="4.2" rx="0.85" fill="${M ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.1"/>`
 + (dbl ? `<text x="8" y="16.15" text-anchor="middle" font-size="6.6" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">2</text>` : '')
 + `</svg>`;
}

// Scroll wheel — the same mouse as L/M/R, wheel filled, with ticks so it is
// not mistaken for middle-click (that one lights the wheel too, without ticks).
export function scrollWheelIconSVG(size = 14) {
 return `<svg width="${size}" height="${size}" viewBox="0 0 16 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + `<path d="M3.2 8.2 C3.2 17.2 5.2 18.6 8 18.6 C10.8 18.6 12.8 17.2 12.8 8.2" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<path d="M3.2 8.2 C3.2 3.6 5.4 2.2 8 2.2 L8 8.2 Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<path d="M12.8 8.2 C12.8 3.6 10.6 2.2 8 2.2 L8 8.2 Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round"/>`
 + `<rect x="7.15" y="3.6" width="1.7" height="4.2" rx="0.85" fill="currentColor" stroke="currentColor" stroke-width="1.1"/>`
 + `<path d="M8 0.6 L8 1.8 M8 18.2 L8 19.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`
 + `</svg>`;
}

// Four-way arrow pad — the bindings chip's stand-in for ←↑→↓.
export function arrowKeysIconSVG(size = 12) {
 const arm = (rot) =>
 `<path d="M8 1.4 L10.15 4.6 L5.85 4.6 Z" fill="currentColor" transform="rotate(${rot} 8 8)"/>`;
 return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
 + arm(0) + arm(90) + arm(180) + arm(-90)
 + `</svg>`;
}

export function zOrderIconSVG(dir) {
 const rows = dir === 'front' || dir === 'back' ? Z_ICON_CHEVRONS.all : Z_ICON_CHEVRONS.one;
 // Both pairs are drawn pointing up and rotated for the downward halves, so
 // "one layer" and "all the way" read as exact mirrors rather than as two
 // hand-written sets of coordinates that drift apart.
 const flip = dir === 'down' || dir === 'back' ? ' transform="rotate(180 12 12)"' : '';
 const body = rows.map(([x1, y1, x2, y2, x3, y3]) =>
 `<path d="M${x1} ${y1} L${x2} ${y2} L${x3} ${y3}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
 return `<svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g${flip}>${body}</g></svg>`;
}
