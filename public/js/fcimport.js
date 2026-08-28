// fcimport.js — FC-format level text → LIFIRIK level data (§11.1).
//
// Pure: no DOM, no fetch, no node built-ins. `server.js` imports this exact
// file for POST /api/import/fc and the /import screen imports it for its live
// preview, so the two can never drift apart.
//
// SOURCE FORMAT. Entries separated by `;` (newlines tolerated), fields by `,`:
//
// CODE,x,y,w,h,rotationDegrees
//
// x/y are CENTRE coordinates and y grows downward — the same frame LIFIRIK
// uses (§3), so nothing is flipped here. Rotation is degrees, positive =
// clockwise on screen, which is also LIFIRIK's sign for `angle` radians.
// Circles in this CODE dialect carry their DIAMETER — in w and h both, or in
// the save's own four-field form `SC,x,y,d,rot`, where the fourth number is
// the circle's spin and not a height. The WORD dialect measures its level
// circles the other way (see `ballR`, which holds the whole radius/diameter
// story — it is two rules, split by spelling and by role).
//
// BA build area → buildZones[] GA goal area → goalZones[]
// SR static rect → terrain box SC static circle → terrain ball
// DR dynamic rect → props box DC dynamic circle → props ball
// GR goal rect → goalObjs box GC goal circle → goalObjs ball
//
// ANY OTHER two-letter code ending in R or C is read rather than refused: `?R`
// is a static rectangle, `?C` a static circle, and **the leading letter picks
// the texture** (`textureForLetter`) — `CR` is a rectangle of grass, `KC` a
// circle of mud. The eight codes above always win, so `SC` and `GC` keep
// meaning what they have always meant.
//
// The letter→texture map is a fixed rotation of `TEXTURES`, anchored so that C
// is grass, and it is a MAP rather than a random draw on purpose: the same
// letter has to give the same texture in the preview, in the draft, on the
// server and tomorrow, or the same paste is a different level twice. These are
// the only pieces that carry a texture of their own, so they ignore the import
// screen's terrain-texture choice instead of following it — the letter is
// naming the piece, not decorating the level.
//
// THE MACHINE. Three more statements carry a source SOLUTION, and they are
// shaped nothing like the pieces above — a machine is a graph, not a list of
// boxes:
//
// J,x,y a joint: a bare point, no size, no piece of its own
// R,material,nodeA,nodeB a rod spanning two joints (0 = water, 1 = wood,
// anything else water with a warning)
// W,motorState,node a wheel centred on a joint
// (0 = free, 1 = clockwise, 2 or -1 = anticlockwise)
//
// A node is a BACK-REFERENCE COUNTED IN ENTRIES, not in joints: `-1` is the
// entry immediately above this one, `-2` the one above that, and the entry it
// lands on has to be a `J`. Three fresh joints followed by their triangle is
// therefore `-3,-2` / `-3,-2` / `-5,-3` — the offsets GROW as the rods
// themselves push the joints further up the paste, which is the whole
// difference from counting joints and the reason a rod can point at another
// rod and have to be refused. Nothing else in the paste is affected: the
// offsets are relative, so a machine reads the same wherever it sits.
//
// (A positive number is not something the format writes; it is read as a
// 1-based entry number and reported, since guessing quietly at a machine's
// wiring is how an import comes out plausible and wrong.)
//
// **The BUILD AREA sorts them into two piles** (see `inBuildArea`). A part
// wholly inside it was built by a player, so it comes back as `design` — the
// player's own machine, which the import screen puts on the Test tab. A part
// with any part of itself outside was authored, so it lands in `fixedParts`,
// the LEVEL's own machine (§11.1), which the sim runs identically to a
// player's, motors and all. Both go through one scale-and-translate, so a
// player's stick written at a level wheel's hub is still bolted to it.
//
// LIFIRIK has no joint object — **sharing an exact coordinate is what forms a
// joint** (§5.4), so a rod end written at a wheel's hub IS bolted to it, and
// the source's node graph survives as the coordinates it resolved to. For the
// code dialect above that is the whole story, because a node reference resolves
// to a shared point and there is nothing a declaration could add.
//
// **The word dialect's `[…]` lists say more than a coordinate can, and they are
// kept** (2026-08-16, see `att` and `wireUp`). A coordinate can only say "these
// two touch"; the source also says which touching pairs are BOLTED, and the two
// differ exactly where an FC machine is cleverest. A weight in FC is a pile of
// identical sticks on one spot — they share both of their ends, so the
// coordinate rule welds the pile into a rigid beam at both ends, where the
// source pinned it at one and left the other swinging. TestLevel's machine is
// 48 declared attachments against the 71 that bucketing infers.
//
// This used to be handled by FANNING the pile — rotating each stick a tenth of
// a pixel about its pinned end so the free ends stopped sharing a coordinate.
// That worked, and it lied about where the pieces are. `att` states the thing
// directly instead, so an imported design's coordinates are the source's.
//
// A wheel that carries no size in the source comes across at the 40-unit
// standard — the standard LIFIRIK wheel at the nominal scale — because that
// is the one every PLAYER wheel is (51 of them, measured, below). A wheel
// that DOES carry one keeps it, whatever it is: FC's XML has a `<width>` per
// wheel and a hand-authored level uses it, and a 450-unit powered wheel is a
// 450-unit powered wheel (2026-08-22, see `convertParts`).
//
// This used to snap every wheel onto the three-rung ladder (`snapWheelR`) on
// the grounds that a wheel off the ladder has its pin ring somewhere no
// editor-drawn part can meet. That reason expired when the shell landed
// (2026-08-17): an imported wheel's ring is FC's own four spokes at the
// SOURCE radius, planned in sim.js, and the ladder never moved it. All the
// snap moved was the number the RENDERER and the transpiler read.
//
// SCALE. **The source base is 40 units to a standard wheel, and it is MEASURED**
// (2026-08-11). This said 50 for the life of the project, and the wheel is the
// only fixed-size piece the format has — everything else is drawn at whatever
// size its author dragged out — so it is the only honest thing to anchor on and
// the number had to be right. Read off 32 real saved FC1 designs
// (`contraption_design_*.sol`, zlib inside the Flash shared object, the
// original `<playerBlocks>` XML inside that): **51 player wheels, every one of
// them 40.0 units**, alongside 692 solid rods at 8.0 thick and 439 hollow at
// 4.0. FC's own physics agrees from the other side — its 1.33 m wheel
// at 30 units per metre is 40 units.
//
// LIFIRIK's standard wheel used to be 30 px across. That made **0.75 px per
// source unit** the nominal mapping: an FC wheel landed exactly on a LIFIRIK
// wheel. The wheel then moved to 40 px (FC's own 40 units), so the shipped
// default is 1.0 — one source unit is one pixel, and nothing converts.
//
// **0.6 was this number computed off the wrong wheel** (30 ÷ 50), and it is
// worth being clear about what it cost, because it was not obvious: the wheel
// came out right anyway — 25 × 2 × 0.6 is also 30 px — while the whole level
// around it came out at 0.8× its proper size. Machines imported correct onto
// terrain a fifth too small, which makes a converted level easier than the one
// its author drew, and is exactly the sort of wrong that looks fine.
//
// Nothing stored moves: this is the value the field STARTS at, and every
// existing level was converted once and saved. The field keeps three decimals
// because suggestScale() produces them — it reads a level's own goal pieces
// back against the standard wheel (40 px across) and is offered as a one-click alternative,
// which is a HEURISTIC and not a second anchor: FC goal pieces are author-sized
// (the same 32 designs carry them at 20.4, 26.3, 40, 90 units and more), so the
// suggestion is "make this level's median goal piece our standard size", useful
// for a level authored off an unknown base and not evidence about the format.
//
// Everything the conversion cannot carry across (rotation on a goal piece,
// pieces past a §11.2 cap, sub-floor thicknesses) is reported in `warnings`
// rather than silently dropped — the import screen shows the list before the
// level ever reaches the Maker.

import { fitPieceBox, clampBallR, MIN_AXIS, MIN_AREA, MIN_BALL_R, pieceBoxLegal, snapWheelR, WHEEL_SIZES, STD_WHEEL_R,
 rectCorners, footprintInRect, clampRodWeight, ROD_WEIGHT_MAX } from './sizes.js';
import { fcMachinePrint, jointKey } from './util.js';
// Both pure, both already shared with the server — the texture list is the
// canonical one the picker, the validator and the solver read (§5.9).
import { TEXTURES } from './surfaces.js';

// **1.0, because a LIFIRIK pixel is now an FC unit** (2026-08-15). The standard
// wheel moved from 15 to 20 px of radius — FC's own — so the 40-unit wheel this
// scale is anchored on lands on it untouched, and there is nothing left to
// convert. See sizes.js for why the wheel moved rather than the world.
//
// The field is still there, and still does what it did: a design drawn against
// some other base, or one an author wants bigger, is exactly what it is for.
// What has gone is the need to use it for an ordinary FC import.
export const DEFAULT_SCALE = 1.0;
export const SCALE_DECIMALS = 3; // how the import field reads it back

// The terrain texture an FC paste arrives in unless the screen says otherwise.
// Exported because the import screen has to pre-select the same one, and two
// copies of a default is how a dropdown comes to disagree with what it does.
export const FC_DEFAULT_TEXTURE = 'classic';

// Half the 40-unit standard wheel this whole scale is anchored on (see the
// header): × DEFAULT_SCALE it is exactly STD_WHEEL_R. Measured, 51 wheels
// across 32 saved designs, no exceptions — and it is the size the format
// never lets a PLAYER choose, which is what makes it the anchor. It is not
// the only size the format can hold: a wheel block carries its own `<width>`
// and a hand-authored level uses it (a 450-unit drive, 2026-08-22), so this
// is the default for a wheel that states no size, not a law about wheels.
export const FC_WHEEL_R = 20;

// How close a scaled radius has to be to one of LIFIRIK's three before it IS
// that rung. This is the whole remaining job of the ladder in this file: at
// the shipped scale an FC wheel is r 20 to the bit and lands on the standard
// rung exactly, and a scale of 0.75 makes it r 15 and it stays r 15. Set by
// what it replaced — the same 0.05 that used to decide whether a snap was
// worth warning about, so the set of pastes that change is exactly the set
// that used to warn.
const LADDER_EPS = 0.05;

// §11.2 / validateLevelData caps — hit them here, with a warning, rather than
// letting the server reject the whole import.
// **props 200 → 500 → 1000** (2026-08-18, design 11947603): an FC level built
// of 230 zero-height ghost lines lost thirty to the old cap, the manifests
// then disagreed, and the C world was refused — the whole design fell to a
// wrong JS build over a cost brake; and the arty ones run to more. Priced
// at a thousand crates all awake: 1.17 ms a step, nothing asleep. The
// server's validateLevelData and the client's FRONT_CAPS moved with it.
const CAP = { terrain: 500, props: 1000, goalObjs: 64, buildZones: 8, goalZones: 8, fixedParts: 1000, pins: 64 };

export const FC_CODES = {
 BA: { role: 'buildZone', shape: 'box', label: 'build area' },
 GA: { role: 'goalZone', shape: 'box', label: 'goal area' },
 SR: { role: 'terrain', shape: 'box', label: 'static rect' },
 SC: { role: 'terrain', shape: 'ball', label: 'static circle' },
 DR: { role: 'prop', shape: 'box', label: 'dynamic rect' },
 DC: { role: 'prop', shape: 'ball', label: 'dynamic circle' },
 GR: { role: 'goal', shape: 'box', label: 'goal rect' },
 GC: { role: 'goal', shape: 'ball', label: 'goal circle' },
};

// The three machine statements (see the header). Kept apart from FC_CODES
// because they share none of its grammar — no x,y,w,h,angle, no piece.
export const FC_PART_CODES = { J: 'joint', R: 'rod', W: 'wheel' };

// A letter → the texture it names, for the `?R` / `?C` codes above.
//
// A fixed rotation of the canonical texture list, anchored on the one letter
// that was specified: **C is grass**. Everything else falls out of the
// alphabet from there, which is worth more than 26 hand-picked pairs — there
// is one thing to remember, one thing to change, and no table to keep in step
// with a texture being added. (Add one and every letter past the anchor
// shifts. That is fine for a code nobody has used yet and would NOT be fine
// for a stored level: a texture is baked onto the piece at import, so a paste
// converted today keeps the look it converted with.)
//
// 26 letters over 16 textures, so the tail repeats — A and Q are both glass.
// Deliberate: the alternative is refusing letters at random depending on how
// many textures happen to exist.
const LETTER_A = 65;
const LETTER_ANCHOR = 'C', TEXTURE_ANCHOR = 'grass';
const LETTER_SHIFT = TEXTURES.indexOf(TEXTURE_ANCHOR) - (LETTER_ANCHOR.charCodeAt(0) - LETTER_A);

export function textureForLetter(ch) {
 const i = String(ch || '').toUpperCase().charCodeAt(0) - LETTER_A;
 if (!(i >= 0 && i <= 25)) return null;
 const n = TEXTURES.length;
 return TEXTURES[(((i + LETTER_SHIFT) % n) + n) % n];
}

// Any two-letter code FC_CODES doesn't know, ending in R or C. Returns the
// same `{ role, shape, label, texture }` shape a known code has, so the parser
// has one path rather than two.
// `pick` is the import screen's per-code override (2026-08-10): the letter map
// is a guess about what a stranger's code meant, and the screen now lists every
// code a paste used with a texture selector beside it, so the guess is a
// STARTING POINT rather than a verdict. Keyed by the whole code rather than by
// its letter, because that is what the list shows — `CR` and `CC` are two rows
// and a reader who set one did not thereby set the other.
function letterCode(code, pick) {
 if (!/^[A-Z][RC]$/.test(code)) return null;
 const texture = (pick && pick[code]) || textureForLetter(code[0]);
 if (!texture) return null;
 const shape = code[1] === 'R' ? 'box' : 'ball';
 return { role: 'terrain', shape, label: `${texture} ${shape === 'box' ? 'rect' : 'circle'}`, texture };
}

// A rod's material and a wheel's motor state, in the source's own numbering,
// with LIFIRIK's own words accepted alongside so a hand-written test string can
// say what it means.
//
// **The two disagree about what to do with a value neither knows, and that is
// deliberate.**
//
// A MATERIAL falls back to WATER, on request (2026-08-09), and reports which
// values it did that to. Only two materials are known to exist, the numbering
// beyond 0/1 is not confirmed, and the cost of getting one wrong is a stick
// that collides with the wrong things — the machine still stands, still drives,
// and the difference is visible in the preview and one right-click away in the
// Maker. Losing the stick entirely is the bigger lie: the truss it was part of
// silently stops being a truss.
//
// A MOTOR STATE still SKIPS the entry, and must keep skipping. It is the case
// sizes.js's `badMachinePart` refuses to default for: anything that is not
// 'free' lands in the powered branch, so a guess drives a motor the author
// never placed — a machine that runs off on its own is not a wheel with the
// wrong tint.
//
// If a source turns up numbering either of these some other way, the fix is one
// line here, and the warnings will have named the values it actually used.
//
// **2 and 3 arrived on 2026-08-10, and they are read rather than guessed.**
// FC Gold (Zhyrek) adds two rod kinds FC1 never had, and its own bytecode says
// which is which — `Rod.endConstructor` in `FCGold.jar` branches on the type
// and sets, in order: 0 → height 0.1 with collision filter 4/1 (water), 1 →
// height 0.2 at the default density (wood), 2 → height 0.2 with
// `density = 20.0`, and 3 → height 0.1 with filter 8/0, which collides with
// nothing at all. The README confirms the third: "Gold rods: 20x heavier than
// wood rods".
//
// So GOLD is not a material of ours — it is a wood stick with the weight dial
// turned up, and our dial goes to 1000, so it comes across exactly rather than
// approximately. GHOST is a material of ours as of the same day (§5.2).
const ROD_KINDS = { 0: 'water', 1: 'wood', 2: 'wood', 3: 'ghost' };
// …and what the source's number implies about the dial. Only gold sets one.
const GOLD_WEIGHT = 20;
const ROD_WEIGHTS = { 2: GOLD_WEIGHT };
const WHEEL_KINDS = { 0: 'free', 1: 'cw', 2: 'ccw', '-1': 'ccw' };
const ROD_FALLBACK = 'water';

function partKind(v, table, names) {
 const s = String(v ?? '').trim().toLowerCase();
 if (names.includes(s)) return s;
 if (s === '') return null;
 const n = Number(s);
 return Number.isFinite(n) ? (table[n] ?? null) : null;
}
const rodKind = v => partKind(v, ROD_KINDS, ['wood', 'water', 'ghost']);
// The weight a source material implies, or nothing. Read off the same raw
// value the kind was, so gold's "wood at ×20" is one lookup rather than a
// special case sitting next to the rod that needs it.
const rodWeight = (v) => {
 const n = Number(String(v ?? '').trim());
 return Number.isFinite(n) ? ROD_WEIGHTS[n] : undefined;
};
const wheelKind = v => partKind(v, WHEEL_KINDS, ['free', 'cw', 'ccw']);

const round4 = v => Math.round(v * 1e4) / 1e4 + 0; // +0 kills -0
const ceil4 = v => Math.ceil(v * 1e4) / 1e4 + 0; // same precision, never downward
const round5 = v => Math.round(v * 1e5) / 1e5 + 0;
const clip = (s, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- the long names, and the third surface ----------
//
// The same statement turns up written three ways, and they are read by ONE
// parser rather than three:
//
// BA,-200,-100,210,210,0
// BuildArea (-200, -100), (210, 210), 0
// BA -200 -100 210
//
// Commas, whitespace and parentheses are all just SEPARATORS; `#7` is a label;
// `[3, 5]` is a dependency list. None of them changes what a field means, so
// the parser strips the lot and reads what is left POSITIONALLY:
//
// type[#id] x y [w] [h] [rot] [dep …]
//
// **Leaving a field out is meaningful** (2026-08-09): no height means SQUARE
// (h = w), which is what lets a circle carry one number, and no rotation means
// zero. An explicit `0` height is not the same statement — it stays 0 and gets
// grown to the size floor like any other sliver, because a zero-thickness
// plank is a real thing to paste.
//
// Long names for the same eight codes, plus the machine's own:
const FC_ALIASES = {
 buildarea: 'BA', goalarea: 'GA', buildareatri: 'BA', goalareatri: 'GA',
 staticrect: 'SR', staticcircle: 'SC',
 dynamicrect: 'DR', dynamiccircle: 'DC',
 goalrect: 'GR', goalcircle: 'GC',
 // `GoalBall` is the same piece under a rounder word (2026-08-10). The short
 // form already accepted `GB`; only the long one was missing, so a paste
 // written out in full lost its goal piece to the `?C` letter rule — which
 // read it as a static circle of glass and left the level with nothing to
 // deliver.
 goalball: 'GC',
 // **A zone can be drawn ROUND as well as triangular** (2026-08-10). Both
 // shapes were already the same problem — LIFIRIK zones are rectangles
 // (§7.2) — but only the triangles had names here, so a circular one fell
 // through to the `?C` letter rule and came in as a static circle of
 // TERRAIN: the level lost its build area and gained a boulder.
 buildareacircle: 'BA', goalareacircle: 'GA',
};
// A zone drawn as anything but a RECTANGLE — a triangle or a circle. LIFIRIK
// zones are rectangles (§7.2), so it comes in as the rectangle it is drawn
// inside and says so — the alternative is refusing a whole build area over its
// corners. The set holds both shapes because the consequence is identical, and
// each name says which it was, so the warning can just list them.
const FC_TRI = new Set(['buildareatri', 'goalareatri', 'buildareacircle', 'goalareacircle']);
// The machine, named rather than coded. A beam's material is decided by its
// THICKNESS (water 4, wood 8) with the name as the fallback, because that is
// what the format says distinguishes them.
const FC_PART_ALIASES = {
 placedcwwheel: { t: 'wheel', kind: 'cw' },
 placedccwwheel: { t: 'wheel', kind: 'ccw' },
 placedupwheel: { t: 'wheel', kind: 'free' },
 placedrod: { t: 'rod', kind: 'water' },
 placedstick: { t: 'rod', kind: 'wood' },
 placedpin: { t: 'pin' },
 // **The same five without the `Placed`** (2026-08-10). A third exporter
 // writes the machine as `Rod#3 (…) [2]` and `Stick#1 (…)`, and every one of
 // them was skipped as an unknown piece code — a paste of 65 entries lost all
 // 65 machine parts and imported as bare terrain. The thickness still decides
 // the material either way (water 4, wood 8, `beamKind` below), so these are
 // the same two pieces under shorter names and not a third kind of anything.
 cwwheel: { t: 'wheel', kind: 'cw' },
 ccwwheel: { t: 'wheel', kind: 'ccw' },
 upwheel: { t: 'wheel', kind: 'free' },
 unpoweredwheel: { t: 'wheel', kind: 'free' },
 rod: { t: 'rod', kind: 'water' },
 stick: { t: 'rod', kind: 'wood' },
 pin: { t: 'pin' },
 // **A wheel can BE the cargo** (2026-08-17): FC marks any player block
 // `goalBlock`, and a free wheel wearing it is a delivery on wheels — seen
 // in the wild on design 12687531. The word carries the flag; the C loader
 // and its win test read it.
 goalupwheel: { t: 'wheel', kind: 'free', goal: true },
 goalcwwheel: { t: 'wheel', kind: 'cw', goal: true },
 goalccwwheel: { t: 'wheel', kind: 'ccw', goal: true },
};
const BEAM_THICK = { water: 4, wood: 8 };
const beamKind = (thick, named) => {
 if (!Number.isFinite(thick) || thick <= 0) return named;
 return Math.abs(thick - BEAM_THICK.water) <= Math.abs(thick - BEAM_THICK.wood) ? 'water' : 'wood';
};

// How far a dependency may pull something. A dependency says two entities are
// bolted together, and in LIFIRIK that means one coordinate (§5.4) — but the
// source states each end independently, so the two arrive a rounding apart and
// the joint quietly fails to form. Snapping closes exactly that gap and nothing
// wider: 2 source units is ~1.2 px at the nominal scale, far past any rounding
// and far short of moving a part somewhere it wasn't. Anything further apart is
// REPORTED instead, because at that distance the disagreement is not rounding —
// it is the reader having the format wrong, and that is worth being told.
const SNAP_TOL = 2;

// Is this line the legend some exports carry at the top? It names the fields
// instead of giving values, so it is neither a statement nor a mistake — and
// it is the one thing in the paste that says what unit the angles are in.
const LEGEND_RE = /\b(centre?_x|center_x|joint_indices|rotation_(?:deg|rad)\w*|width|height)\b/i;

// ---------- parse ----------

// Never throws: every unusable chunk comes back in `errors` with its 1-based
// entry number, so a single typo costs one piece instead of the whole paste.
//
// → { entries, parts, joints, errors, absoluteNodes, assumedWater, lettered, … }
// `entries` are the geometry pieces; `parts` are machine parts with their
// nodes already resolved to source-unit coordinates, in the `{ t, kind, … }`
// shape §11.1 stores — so converting one is a scale and a translation and
// nothing else. `joints` is every bare point read (a `J` or a `PlacedPin`),
// for the count.
export function parseFcText(text, pick = null) {
 const entries = [];
 const parts = [];
 const joints = [];
 const errors = [];
 let absoluteNodes = 0;
 const assumedWater = []; // the raw material values that fell back to water
 const lettered = []; // codes read by the ?R / ?C rule rather than the table
 const triZones = []; // triangular zones flattened to their bounding rect
 let pins = 0; // PlacedPins — bare points, and anchors of nothing
 let masslessProps = 0; // zero-area dynamics, read as the statics FC makes them
 const namedThick = []; // beams whose thickness disagreed with their name
 const badDeps = []; // dependencies naming an id nothing defined
 const farDeps = []; // …and ones too far away to be a rounding error
 let snapped = 0; // ends pulled onto what they say they are bolted to
 const anchorsById = new Map(); // #id → the points other entities may name
 // **WHAT THE SOURCE SAID IS BOLTED TO WHAT** — the word dialect's `[n]` list,
 // kept rather than spent (2026-08-16). `wireUp` used to read a dependency,
 // move an end onto it and forget it; the statement itself is the only thing
 // that can tell a stack pinned at ONE end from a bundle welded at both, and
 // rebuilding it from geometry afterwards is exactly what cannot be done.
 //
 // { part, end, toId } end 0 or 1 for a beam, null for a one-point entity
 //
 // `part` is the object, not an id: an entity with no `#id` of its own can
 // still NAME others, so the declaring side cannot be keyed on a number that
 // may not exist. `partsById` is the other direction, which does need one.
 const decls = [];
 // Every `[…]` the paste SPEAKS, whether or not it resolved (2026-08-17,
 // sweep finds 12476885 and 10885065): `decls` records only declarations
 // that landed on a retained part within snapping distance, so a paste
 // whose only joints sit on CARGO lines (a goal wheel bolted to the goal
 // rect) or span further than SNAP_TOL counted as UNDECLARED — and an
 // undeclared paste gets no C world, exact digits, or source order. The
 // dialect is declared by being spoken, not by resolving.
 let declTokens = 0;
 const partsById = new Map(); // #id → the machine part it defined, if any
 const pinIds = new Set(); // …and the ids that were bare pins

 // ENTRIES, counted the way a node reference counts them.
 //
 // `line` is the position of the entry being read among the entries that are
 // really there, which is NOT its position in the split: `split` collapses
 // runs of separators but still yields an empty chunk for a leading `;` or a
 // stray `, ,`, and one of those shifting the numbering would silently rewire
 // every rod in the paste. It is also the number the errors report, so
 // "entry 12" in a warning and "-3 from entry 12" mean the same thing.
 //
 // `lineText` and `lineJoint` are that numbering's two lookups: what an entry
 // said, and the joint it defined if it was a `J`.
 let line = -1;
 const lineText = [];
 const lineJoint = [];

 // A node reference → the joint it names, or a reason it names nothing.
 // Resolved DURING the walk, never after it, because every offset is relative
 // to the entry doing the asking.
 const node = (v, from) => {
 const raw = String(v ?? '').trim();
 const n = Number(raw === '' ? NaN : raw);
 if (!Number.isFinite(n) || !Number.isInteger(n) || n === 0) {
 return { err: `"${clip(raw, 12) || '(blank)'}" is not a joint reference (-1 is the entry above this one)` };
 }
 // Negative counts back in ENTRIES from this one; positive is read as a
 // 1-based entry number and counted, so the UI can say it was assumed.
 const at = n < 0 ? from + n : n - 1;
 if (n > 0) absoluteNodes++;
 if (at < 0 || at >= from) {
 return { err: n < 0
 ? `there is no entry ${-n} back from here (this is entry ${from + 1})`
 : `entry ${n} is not above this one (this is entry ${from + 1})` };
 }
 if (!lineJoint[at]) {
 return { err: `entry ${at + 1} is not a joint (${clip(lineText[at] || '', 24)})` };
 }
 return { pt: lineJoint[at] };
 };

 // Every angle read, so the unit can be decided once for the whole paste
 // rather than guessed per statement (see `angleUnit` below).
 const rawAngles = [];
 let declaredUnit = null;
 // …and what an FCRes-style `@name` / `@description` header said, if anything.
 let declaredName = null, declaredDesc = null;

 // **Wiring happens AFTER the whole paste is read** (2026-08-11), and it has
 // to. A dependency is judged by DISTANCE — two anchors within SNAP_TOL are
 // the same joint stated twice — and a beam's ends cannot be worked out until
 // the paste's angle unit is settled, which takes every angle in the file.
 // Wiring as we went meant judging a RADIANS paste's geometry in degrees:
 // `Stick#2 (48.6, 278.5), (579.2, 8), 2.3136 [1]` really meets Stick#1 1.1
 // units away, and was measured at 251.7 and refused. Every joint in the file
 // went the same way, so the machine imported as a heap of unattached sticks
 // that collapsed the moment it was played — found on a real imported test
 // level that would not solve.
 //
 // So each entity pushes a closure here instead of wiring itself, and they run
 // in paste order once `angleUnit` is known and the beams have been re-laid.
 // Order is the whole of what makes ids work (a dependency may only name an id
 // ABOVE it), so it is preserved exactly: each closure does what that entity
 // used to do inline, in the same sequence it used to do it.
 const deferred = [];
 const later = (fn) => deferred.push(fn);

 // A dependency is satisfied by a shared COORDINATE, so all "wiring up" means
 // is pulling this entity's nearest free anchor onto the one it names — when
 // they are already within SNAP_TOL of each other. Anchors are handed in as
 // getters/setters because what moves differs by entity: a rod moves ONE END,
 // everything else moves bodily.
 // **HOW MANY entries there are is the declaration; WHICH END is geometry.**
 //
 // The list was read here for a while as positional — entry 0 is end 0, entry
 // 1 is end 1, the way fcsim's block `joints` array is indexed — and a real
 // paste says otherwise outright. Gate 6i's two sticks are
 // `Stick#2 (48.625, 278.475), (579.222137871128, 8), 2.31357612810866 [1]`,
 // and its ONE entry belongs to Stick#2's end 1:
 //
 // my end 0 → their end 0 579.222 my end 1 → their end 0 0.000
 // my end 0 → their end 1 723.770 my end 1 → their end 1 164.862
 //
 // Read positionally that is a joint 579 units wide, refused as too far apart,
 // and the machine imports as loose sticks. So a dependency names a BLOCK and
 // not one of its ends, and the end it belongs to is the end that touches it.
 //
 // **What the list still says, and it is the whole point, is HOW MANY of my
 // ends are bolted at all.** One entry means one end is attached and the other
 // is FREE — free even with thirty identical sticks sitting exactly on it,
 // which is the state the coordinate rule cannot express and the reason a pile
 // no longer has to be fanned apart to behave.
 //
 // `used` keeps two dependencies off one end. Ties go to the positional
 // reading and then to the lower index, which only ever arises on a pile —
 // where every gap is 0 because every end coincides, and the sticks must all
 // pick the SAME end or the pile is bolted alternately.
 //
 // A one-point entity (a pin, a wheel, a piece of scenery) has one anchor and
 // every dependency it states is about that point.
 const wireUp = (tag, anchors, deps, owner = null) => {
 const used = new Set();
 deps.forEach((d, j) => {
 const theirs = anchorsById.get(d);
 if (!theirs) { badDeps.push(`${tag} → #${d}`); return; }
 let best = null;
 for (let k = 0; k < anchors.length; k++) {
 if (used.has(k)) continue;
 for (const t of theirs) {
 const gap = Math.hypot(anchors[k].x - t.x, anchors[k].y - t.y);
 // Strictly nearer wins; an exact tie goes to the positional reading.
 const better = !best || gap < best.gap
 || (gap === best.gap && k === j && best.k !== j);
 if (better) best = { k, t, gap };
 }
 }
 if (!best) return;
 if (best.gap > SNAP_TOL) { farDeps.push(`${tag} → #${d}, ${round4(best.gap)} units apart`); return; }
 used.add(best.k);
 // **A part-to-part declaration does not move geometry any more**
 // (2026-08-17, on the imported walker whose 8 snapped ends compounded
 // into a missed win). The sim joints an id-named pair BY DECLARATION,
 // at the target's own node, exactly as fcsim's graph does — coordinate
 // equality is not required, so the source's sub-unit roundings stay in
 // the shells where FC put them. Everything else a dependency can name
 // (scenery, a goal piece, a pin) still welds by COORDINATE, so those
 // still close the rounding the old way.
 const partToPart = owner && partsById.has(d);
 if (best.gap > 0 && !partToPart) { anchors[best.k].set(best.t.x, best.t.y); snapped++; }
 // Recorded whether or not anything moved: a joint that was already exact
 // is still a joint, and it is the DECLARATION that is being kept here.
 if (owner) decls.push({ part: owner, end: anchors.length > 1 ? best.k : null, toId: d });
 });
 };

 // **A LINE that begins with `;` is a comment, not an entry** (2026-08-10).
 //
 // `;` is this format's entry separator AND FC Resource's comment marker, and
 // the two only look like a conflict. A separator can never START a line's
 // content — an entry beginning with one would be the empty entry before it —
 // so "first non-space character on the line" tells them apart with nothing
 // left ambiguous. Without this, every FCRes export opened with eight warnings
 // about unknown piece codes called "Level:" and "Author:", which is the
 // importer complaining about the file's own title page.
 //
 // `@name` / `@description` are the same header's directives. They carry the
 // level's name and blurb, which this converter otherwise has to be TOLD, so
 // they are read rather than merely skipped.
 const src = String(text || '').replace(/\r\n?/g, '\n');
 const kept = [];
 for (const ln of src.split('\n')) {
 const t = ln.trim();
 if (t.startsWith(';')) continue;
 const at = /^@(\w+)\s*(.*)$/.exec(t);
 if (at) {
 const v = at[2].trim();
 if (v && at[1].toLowerCase() === 'name') declaredName = v;
 if (v && at[1].toLowerCase() === 'description') declaredDesc = v;
 continue;
 }
 kept.push(ln);
 }
 kept.join('\n').split(/[;\n\r]+/).forEach((raw) => {
 const s = raw.trim();
 if (!s) return;
 // The legend, if a paste carries one: no numbers of its own, and the only
 // place the angle unit is ever stated outright.
 if (LEGEND_RE.test(s) && !/(^|\s|[,(])-?\d/.test(s.replace(/#\d+/g, ''))) {
 if (/rotation_deg|angle_deg|_deg\b/i.test(s)) declaredUnit = 'deg';
 else if (/rotation_rad|angle_rad|_rad\b/i.test(s)) declaredUnit = 'rad';
 return;
 }
 // FC Gold's own header row, `M,name,?,description`, which its `.fcg` saves
 // open with. Same job as the `@name` directive above and the same reason to
 // read it rather than skip it — but it arrives as an ENTRY rather than a
 // line, because a `.fcg` is one long `;`-joined string with no newlines at
 // all. Recognised by its shape and not merely its letter: a real piece code
 // is followed by numbers, so anything numeric here is left to be parsed and
 // complained about normally.
 if (/^M$/i.test((s.split(',')[0] || '').trim()) && !/^-?[\d.]+$/.test((s.split(',')[1] || '').trim())) {
 const mf = s.split(',');
 if (!declaredName && mf[1]?.trim()) declaredName = mf[1].trim();
 if (!declaredDesc && mf[3]?.trim()) declaredDesc = mf[3].trim();
 return;
 }
 const i = ++line;
 lineText[i] = s;
 const skip = (why) => errors.push({ index: i, text: s, why });

 // Strip the annotations, then let commas, spaces and brackets all be the
 // one separator they are.
 let body = s;
 let deps = [];
 const dm = /\[([^\]]*)\]\s*$/.exec(body);
 if (dm) {
 deps = dm[1].split(/[\s,]+/).map(Number).filter(Number.isFinite);
 body = body.slice(0, dm.index);
 }
 const tok = body.trim().split(/[\s,()]+/).filter(Boolean);
 const head = /^([A-Za-z][A-Za-z0-9_]*)(?:\s*#\s*(\d+))?$/.exec(tok[0] || '');
 if (!head) return skip(tok[0] ? `unknown piece code "${clip(tok[0], 12)}"` : 'no piece code');
 const code = head[1].toUpperCase();
 const long = head[1].toLowerCase();
 const id = head[2] != null ? Number(head[2]) : null;
 let n = tok.slice(1).map(Number);

 // **A PARENTHESIS IS A GROUP, and the group's ARITY is information**
 // (2026-08-11). Everything above treats `(` and `)` as separators, which is
 // right about what they SEPARATE and wrong about what they enclose: this
 // format writes `(x, y), (w, h), rot`, and a piece that has only one size
 // writes `(w)` — one number, not two.
 //
 // Read positionally that is a disaster rather than a nuisance, because the
 // rotation slides into the missing slot: `Rod#0 (-199.9, 80),
 // (168.244686), 2.1719` came out as a beam 168.2 long and **2.17 thick,
 // unrotated**, and a beam's thickness IS its material (4 water, 8 wood), so
 // every water rod in a paste written that way arrived as WOOD lying flat.
 // Found on an imported rig where the whole triangle came in wood.
 //
 // So when the groups are there they are believed, and `sizeStated` carries
 // how many numbers the size group held — which is the same question
 // `ballDia` and `beamKind` were already guessing at from the field count.
 // Nothing changes for the comma and space spellings, which have no groups
 // and keep the positional reading they always had.
 let sizeStated = null;
 const groups = [...body.matchAll(/\(([^)]*)\)/g)];
 if (groups.length >= 2) {
 // `.filter(Boolean)` BEFORE `Number`, and it is not tidiness: splitting
 // ", 2.1719" yields a leading empty chunk, `Number('')` is 0 rather than
 // NaN, and that 0 sails through `isFinite` into the rotation slot — which
 // shoved the real rotation one place along, into the dependency list.
 // The entry loop above keeps a note about the same trap.
 const nums = t => t.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
 const pos = nums(groups[0][1]), size = nums(groups[1][1]);
 const last = groups[groups.length - 1];
 const tail = nums(body.slice(last.index + last[0].length));
 if (pos.length >= 2 && size.length >= 1) {
 sizeStated = size.length;
 // The same [x, y, w, h, rot, …deps] the positional path builds, with
 // `h` genuinely ABSENT when the source did not state one.
 n = [pos[0], pos[1], size[0], size.length > 1 ? size[1] : undefined, ...tail];
 }
 }

 if (FC_PART_CODES[code] && !FC_PART_ALIASES[long]) {
 const f = tok;
 if (code === 'J') {
 const x = n[0], y = n[1];
 if (!Number.isFinite(x) || !Number.isFinite(y)) return skip('a joint needs x,y');
 // A joint is recorded against its ENTRY, which is how it is referred
 // to; `joints` is only the count. A `J` that fails above records
 // nothing, so a reference to it lands on "not a joint" rather than on
 // the joint before it — the numbering never shifts.
 lineJoint[i] = { x, y };
 joints.push({ x, y });
 return;
 }
 if (code === 'W') {
 const kind = wheelKind(f[1]);
 if (!kind) return skip(`motor state "${clip(f[1] || '', 12)}" isn't one I know (0 free, 1 clockwise, 2 or -1 anticlockwise)`);
 const at = node(f[2], i);
 if (at.err) return skip(at.err);
 parts.push({ t: 'wheel', kind, x: at.pt.x, y: at.pt.y, text: s });
 return;
 }
 // An unknown material is a water rod (see ROD_KINDS).
 const kind = rodKind(f[1]);
 const a = node(f[2], i), b = node(f[3], i);
 if (a.err) return skip(a.err);
 if (b.err) return skip(b.err);
 // Two ends at one point is not a short stick, it is no stick: it has no
 // direction, so the sim gets a zero-length capsule and the renderer a
 // zero-length line. The usual cause is a rod naming one joint twice.
 if (a.pt.x === b.pt.x && a.pt.y === b.pt.y) return skip('both ends of that rod are on the same point');
 // Recorded only once the rod is really landing, and BY THE VALUE rather
 // than as a tally: the note exists to say what the source was numbering,
 // and counting a guess made for a rod that was then skipped for a bad
 // node would be reporting an assumption nothing was built on.
 if (!kind) assumedWater.push(String(f[1] ?? '').trim());
 const wgt = rodWeight(f[1]);
 parts.push({
 t: 'rod', kind: kind || ROD_FALLBACK,
 x1: a.pt.x, y1: a.pt.y, x2: b.pt.x, y2: b.pt.y,
 // gold: a wood stick with the dial turned up (see ROD_KINDS). Absent
 // on every other material, which is how ×1 is stored everywhere else.
 ...(wgt ? { weight: wgt } : {}),
 text: s,
 });
 return;
 }

 // The positional read, shared by every remaining kind: x, y, then a size,
 // then the two that may be left off.
 if (!Number.isFinite(n[0]) || !Number.isFinite(n[1])) {
 return skip('needs x,y (then a size, then rotation)');
 }
 const x = n[0], y = n[1];
 const w = Math.abs(n[2]);
 // Absent height means SQUARE; an explicit 0 is a 0.
 const h = n[3] == null || Number.isNaN(n[3]) ? w : Math.abs(n[3]);
 // …but "square" and "no second number was given" are different facts, and
 // two kinds of piece need the second one: a beam, whose thickness IS its
 // material, and a circle, whose fourth number is a rotation rather than a
 // height. Grouped, the source says outright and both read it the same way.
 // UNGROUPED they must keep their own fallbacks, which are not the same
 // guess: a beam positionally is `x y len thick rot`, so a fourth number is
 // its thickness, while a circle is `x y d rot`, so a fourth number is not a
 // size at all and it takes FIVE fields before one is (see `ballDia`).
 // Collapsing the two broke gate 6g, which is exactly what it is for.
 const twoSizesBeam = sizeStated != null ? sizeStated >= 2 : (n[3] != null && !Number.isNaN(n[3]));
 const twoSizesBall = sizeStated != null ? sizeStated >= 2 : n.length >= 5;
 const rot = Number.isFinite(n[4]) ? n[4] : 0;
 if (Number.isFinite(rot) && rot !== 0) rawAngles.push(rot);
 // Trailing numbers past the rotation are the bare form of the same
 // dependency list `[…]` carries. One reading, two spellings.
 if (!deps.length && n.length > 5) deps = n.slice(5).filter(Number.isFinite);
 if (deps.length) declTokens++; // spoken is declared — see declTokens above

 // **A GoalCircle wearing machine markings IS a goal wheel** (2026-08-17,
 // design 12721078: a car — goal wheels bolted to a goal rect, which "did
 // not stay together"). FC has no round goal BLOCK: its round cargo is a
 // goal-flagged wheel, and at least one exporter spells that
 // `GoalCircle#1 (…), (40, 40), 0, [0]` — the very dialect
 // FC_EXAMPLE_LONG teaches. An `#id` or a `[…]` list is machine speech a
 // level piece has no use for, so such a line takes the wheel path here
 // (hub + spoke anchors, deps kept, cargo below like every goal wheel);
 // a bare GoalCircle stays the legacy goal ball.
 const partDef = (FC_ALIASES[long] === 'GC' || code === 'GC') && (id != null || deps.length)
 ? { t: 'wheel', kind: 'free', goal: true }
 : FC_PART_ALIASES[long];
 if (partDef) {
 const at = (px, py) => ({ x: px, y: py });
 if (partDef.t === 'pin') {
 // A pin is a coordinate and nothing else — LIFIRIK has no joint object,
 // so whatever the source hung on it is already bolted by sharing the
 // point (§5.4). Recorded so beams can name it, counted as a joint, and
 // never drawn. One object, referenced by both lists, so a dependency
 // that nudges it nudges what everything else will read.
 //
 // It is also the one thing a declaration can name that has no PART to
 // name back (see `att`): three sticks on one pin are three statements
 // about the pin and none about each other. `pinIds` is how the resolver
 // tells that from a dependency that named nothing at all.
 if (id != null) pinIds.add(id);
 const pt = at(x, y);
 later(() => {
 wireUp(`${head[1]}#${id ?? '?'}`, [{
 get x() { return pt.x; }, get y() { return pt.y; },
 set(nx, ny) { pt.x = nx; pt.y = ny; },
 }], deps);
 if (id != null) anchorsById.set(id, [pt]);
 });
 joints.push(pt);
 pins++;
 return;
 }
 if (partDef.t === 'wheel') {
 // The size tuple is the wheel's BOX, so half of it is the radius; a
 // wheel that gave no size is the source's standard one. The rotation
 // rides along: FC's spokes sit at rot + k·90° and a declared piece
 // may be bolted to one.
 //
 // **A wheel that states ZERO states zero** (2026-08-22). This read
 // `w > 0`, so a stated 0 took the same standard-wheel fallback as a
 // wheel that stated nothing — and they are opposite facts. FC gives a
 // zero-radius wheel no mass and a massless body never moves (the same
 // rule the ghost lines run on), so `UPWheel#6 (…), (0, 0), 0` is an
 // invisible ANCHOR POINT, which is how a hand-authored level bolts
 // things to the background. Four of them came in as four standard grey
 // wheels that were not there and fell the moment anything took the
 // level off the C loader. `Number.isFinite` is the whole distinction:
 // an absent size is NaN here, a stated one is a number.
 const part = { t: 'wheel', kind: partDef.kind, x, y, rot, srcId: id ?? null,
 rSrc: Number.isFinite(w) ? Math.max(w, h) / 2 : FC_WHEEL_R, goalFlag: !!partDef.goal, text: s };
 parts.push(part);
 if (id != null) partsById.set(id, part);
 later(() => {
 wireUp(`${head[1]}#${id ?? '?'}`, [{
 get x() { return part.x; }, get y() { return part.y; },
 set(nx, ny) { part.x = nx; part.y = ny; },
 }], deps, part);
 // **A wheel offers its hub AND its four spokes** (2026-08-17): FC
 // bolts rods to the rim spokes (fcsim add_wheel), and a dependency
 // aimed at one used to measure 20 units from the only anchor this
 // table knew — the hub — and be dropped as "too far apart". The
 // trig here only ARBITRATES within SNAP_TOL; the sim re-derives
 // the exact node through the engine's own arithmetic.
 if (id != null) {
 const anchors = [at(part.x, part.y)];
 const a0 = part.rot || 0;
 for (const k of [0, Math.PI / 2, Math.PI, 4.71238898038469]) {
 anchors.push(at(part.x + Math.cos(a0 + k) * part.rSrc,
 part.y + Math.sin(a0 + k) * part.rSrc));
 }
 anchorsById.set(id, anchors);
 }
 });
 return;
 }
 // A beam: centre, LENGTH and THICKNESS, and an angle it lies along. The
 // ends are what LIFIRIK stores, and they are also what a dependency is
 // about, so they are worked out here rather than at conversion.
 //
 // **A length of exactly ZERO is a piece, not a mistake** (2026-08-17,
 // sweep: 16 designs refused over it, and the technique is named):
 // FC's "ghost rods" — zero-length boxes that rectangles pass through
 // while circles still ride their edges, and free-floating pin anchors.
 // The quirk is the solver's own degenerate-box arithmetic, and the
 // solver IS fcsim now, so carrying the part is the whole of the work:
 // both ends land on the centre, the thickness still names the kind,
 // and the engine does what FC's does because it is FC's. Only NaN and
 // negative lengths are still refused.
 if (!(w > 0) && w !== 0) return skip('a beam needs a length');
 // No thickness stated is not a thickness of `w` — it is the NAME's turn.
 const kind = beamKind(twoSizesBeam ? h : NaN, partDef.kind);
 if (twoSizesBeam && kind !== partDef.kind) namedThick.push(`${head[1]} at ${h}`);
 const part = { t: 'rod', kind, x, y, len: w, rot, srcId: id ?? null, x1: 0, y1: 0, x2: 0, y2: 0, text: s };
 parts.push(part);
 if (id != null) partsById.set(id, part);
 // A provisional lay, so anything that reads a beam's ends before the unit
 // is settled sees something sane; the real one happens below, once every
 // angle in the paste has had its say. The WIRING waits for that — see
 // `later` — because a dependency is decided by how far apart two ends
 // are, and ends laid in the wrong unit are not off by a little.
 layBeam(part, 'deg');
 later(() => {
 wireUp(`${head[1]}#${id ?? '?'}`, [
 { get x() { return part.x1; }, get y() { return part.y1; }, set(nx, ny) { part.snap1 = { x: nx, y: ny }; part.x1 = nx; part.y1 = ny; } },
 { get x() { return part.x2; }, get y() { return part.y2; }, set(nx, ny) { part.snap2 = { x: nx, y: ny }; part.x2 = nx; part.y2 = ny; } },
 ], deps, part);
 if (id != null) anchorsById.set(id, [at(part.x1, part.y1), at(part.x2, part.y2)]);
 });
 return;
 }

 // A known code first, always — `SC` and `GC` end in C and are not
 // circles-of-something-beginning-with-S-or-G.
 const alias = FC_ALIASES[long];
 // …then the letter rule for a short code, and the same idea for a long
 // name: whatever `FooRect` is, it is a rect, and refusing it outright over
 // a word we don't know throws away geometry we can read perfectly well.
 const def = FC_CODES[alias || code]
 || (alias ? null : letterCode(code, pick))
 || (long.length > 2 && /rect(angle)?$/.test(long) ? FC_CODES.SR : null)
 || (long.length > 2 && /(circle|ball|disc)$/.test(long) ? FC_CODES.SC : null);
 if (!def) {
 return skip(`unknown piece code "${clip(head[1], 16)}"`);
 }
 // A width has to be THERE, but it may be zero: a zero-thickness plank is a
 // real thing to paste and becomes a blade at the size floor (see `grown`).
 // Absent is the only failure, which is the same distinction the height
 // makes one line above.
 if (!Number.isFinite(w)) return skip('needs a width');
 if (FC_TRI.has(long)) triZones.push(head[1]);
 // Counted only for a piece that really lands, like the rod materials
 if (!alias && !FC_CODES[code]) lettered.push(code);
 // **How big a circle is, settled HERE and once** — see `ballDia`. It is
 // stored as a diameter in source units and everything downstream reads
 // that one field, because "how big is a circle" living in two places is
 // exactly how the bounds and the piece came to disagree before.
 const ball = def.shape === 'ball' ? ballDia(w, h, twoSizesBall, long.length > 2, def.role) : null;
 // **A dynamic piece with NO AREA is a static one** (2026-08-18, measured
 // on the Sticks series). FC level authors draw invisible platforms and
 // walls as `DynamicRectangle`s of width 0, and it works because Box2D 2.0
 // gives a zero-area shape zero mass and a zero-mass body the static flag
 // (b2Body_ctor: `m_mass > 0` or `e_staticFlag`) — the engine that IS
 // fcsim's now. Read as a prop it fell into the void from frame 0, taking
 // whatever rested on it along: 21 of the 32 Sticks levels have one, and
 // on the JS build path 17 of their solves lost the cargo inside three
 // seconds. So it is TERRAIN here — drawn at ghost-line thickness like any
 // zero axis (boxOf), still a level piece, and never a body with mass.
 // fcPasteToXml's manifest makes the same call, so the C-path rec mapping
 // (`levels[i].dynamic`) and this list agree on which pile it is in.
 // `massless` marks it, so the surface below can give it FC's own dynamic
 // environment material (friction 0.7, restitution 0.2) rather than the
 // static one, which is what the C loader builds.
 // **…and a zero-area GOAL block is the same body, doing a different job**
 // (2026-08-22). It cannot be rerouted to terrain the way a prop is — the
 // C world's manifest counts goal blocks and a missing one puts every later
 // rec on the wrong body — so it stays cargo and is MARKED instead. What it
 // actually is, on a hand-authored level, is FC's anchor: a static point a
 // powered wheel is bolted to, which is the only way that game has of
 // saying "pinned to the background". convertFcLevel turns the mark into a
 // LIFIRIK loose pin so the JS build says it too.
 const zeroArea = fcMassless(def.shape, w, h, ball && ball.dia);
 const massless = def.role === 'prop' && zeroArea;
 if (massless) masslessProps++;
 const entry = {
 code: alias || code, role: massless ? 'terrain' : def.role, shape: def.shape, label: def.label,
 texture: def.texture || null, x, y, w, h, rot, text: s,
 ...(massless ? { massless: true } : {}),
 ...(def.role === 'goal' && zeroArea ? { anchor: true } : {}),
 ...(ball || {}),
 };
 entries.push(entry);
 later(() => {
 if (id != null) anchorsById.set(id, [{ x, y }]);
 wireUp(`${head[1]}#${id ?? '?'}`, [{
 get x() { return entry.x; }, get y() { return entry.y; },
 set(nx, ny) { entry.x = nx; entry.y = ny; },
 }], deps);
 });
 });

 // ---- the angle unit, decided once for the paste ----
 //
 // The same field is degrees in one export and radians in another, and a
 // number alone cannot always say which. What CAN say: the legend, if there
 // is one; and the values themselves, since nothing in a level is rotated six
 // radians and nothing is authored to four decimal places in degrees. So:
 // anything past 2π is degrees, and a paste whose angles are all small AND
 // finely fractional (3.117, -1.5398) is radians. Everything else is degrees,
 // which is what the code format has always been. Reported either way, so a
 // wrong guess is one line of warning rather than a level lying on its side.
 const maxAbs = rawAngles.reduce((m, a) => Math.max(m, Math.abs(a)), 0);
 const fineFraction = rawAngles.some(a => Math.abs(a) >= 0.05 && /\.\d{3}/.test(String(a)));
 const angleUnit = declaredUnit
 || (rawAngles.length && maxAbs <= Math.PI * 2 + 1e-9 && fineFraction ? 'rad' : 'deg');
 const toRad = a => (angleUnit === 'rad' ? a : a * Math.PI / 180);
 for (const e of entries) e.rad = round5(toRad(e.rot));
 for (const p of parts) if (p.t === 'rod' && p.len != null) layBeam(p, angleUnit);

 // …and NOW the dependencies, on geometry that is finally in the right unit,
 // in the order the paste stated them (see `later`).
 for (const fn of deferred) fn();

 return {
 entries, parts, joints, errors, absoluteNodes, assumedWater, lettered,
 triZones, namedThick, badDeps, farDeps, snapped, angleUnit, pins, masslessProps,
 decls, declTokens, partsById, pinIds,
 angleDeclared: !!declaredUnit,
 declaredName, declaredDesc,
 };
}

// Is a DYNAMIC level piece one Box2D 2.0 would make static — no area, so no
// mass? The one rule, asked by the parser (which pile the entry goes in) and
// by fcPasteToXml (which pile the C-path manifest says it is in), so the two
// cannot disagree. Sizes are the source's numbers: a box needs both axes,
// a circle its diameter. Every one seen in the wild is a rect (1,324 across
// 692 cached designs, not one circle) — the circle case is the same physics
// and is carried for the rule's sake.
export function fcMassless(shape, w, h, dia = null) {
 if (shape === 'ball') return (dia != null ? dia : w) === 0;
 return w === 0 || h === 0;
}

// A beam's ends, from its centre, length and angle. Called twice: once while
// parsing (so a dependency has ends to snap), and again once the paste's angle
// unit is settled. Any end a dependency pinned stays where it was put — that
// coordinate came from another entity, not from this one's arithmetic.
function layBeam(p, unit) {
 const a = unit === 'rad' ? p.rot : p.rot * Math.PI / 180;
 const hx = Math.cos(a) * p.len / 2, hy = Math.sin(a) * p.len / 2;
 p.x1 = p.snap1 ? p.snap1.x : p.x - hx;
 p.y1 = p.snap1 ? p.snap1.y : p.y - hy;
 p.x2 = p.snap2 ? p.snap2.x : p.x + hx;
 p.y2 = p.snap2 ? p.snap2.y : p.y + hy;
}

// ---------- how big is a circle ----------
//
// **The format measures its round things THREE ways, and which one applies is
// decided by the SPELLING and by the ROLE.** One number, three readings:
//
// dialect terrain / prop circle goal piece wheel
// word names RADIUS diameter diameter
// short codes DIAMETER diameter diameter
//
// The word-dialect radius is not a guess: zhyrek — who wrote FC Gold and is on
// the FC20 team — complained about it in as many words in the community
// channel ("why are wheels represented by their diameter but level circles are
// represented by radius"), marcxb's note while converting a level is "Need to
// 2x circle radius it seems", and a reference render placed beside ours is
// what caught it. Every one of those pastes is written in the long names.
//
// **The short-code dialect states a DIAMETER** (2026-08-11), on a paste of 90
// entries that came out with boulders twice the size of the level. Two things
// say so on that paste alone. Its one goal circle is `GC,…,47.9,…`, and a goal
// piece is measured with the wheels either way — 47.9 × 0.6 gives a 28.7 px
// piece against LIFIRIK's standard 30, so the paste's scale is the nominal one
// and every other number on it can be read against that. Its circles are then
// 82.6 and 371 units: 1.6 m and 7.4 m across as diameters, in a level 35 m
// wide. Doubled they are a 15-metre boulder, which is not a thing that paste
// contains.
//
// So the rule that shipped for a day — one rule for all level circles — was
// half right, the same way the rule before it was: the halves are split by
// spelling, and only the pastes written in words were ever measured.
//
// A CIRCLE ALSO CARRIES ONE SIZE, NOT TWO. Where a rect's tuple is (w, h, rot),
// a circle's is (d, rot) — one field shorter — so on `SC,-299.4,-280.4,203.6,
// -156.4` that fourth number is a ROTATION and not a height. It was being read
// as one: the size came out as `max(w, h)`, which survives a rotation smaller
// than the circle and silently inflates any circle rotated past its own
// diameter, and which reported "the width and height disagreed" about a piece
// whose width and height do not. A fifth number means the size really was
// stated twice (the word dialect writes `(60, 60)`), and then the two are
// compared and the larger wins as before.
//
// → `{ dia, squashed }` in SOURCE UNITS. Every reader downstream — the piece,
// the bounds, the auto-scale — takes `dia` and does no arithmetic of its own,
// because two of them disagreeing is the bug this whole note is about.
// `sized` is "the source gave TWO size numbers" — from the parenthesis group
// where there is one, and from the field count where there is not. It used to
// be re-derived here from a raw field count, which was the same guess made in a
// second place; the caller now knows the answer outright.
function ballDia(w, h, sized, worded, role) {
 const stated = sized ? Math.max(w, h) : w;
 return {
 dia: stated * (worded && role !== 'goal' ? 2 : 1),
 squashed: sized && Math.abs(w - h) > 0.5,
 };
}

// ---------- a STACK of identical sticks is one stick with a weight ----------
//
// (2026-08-11, on an imported test level that would not throw. Groups of
// stacked sticks are the standard FC idiom for a weight — which is exactly why
// LIFIRIK offers the density dial instead.)
//
// FC has no weight dial, so a player makes a heavy thing by piling identical
// sticks on one spot — 31 of them in that level, every one at the same centre,
// length and angle, each naming the one before it.
//
// **All of them come across, and that is the point**: a pile is not one heavy
// stick. In FC it is pinned at ONE end — the end that carries on into the rest
// of the machine — so the free ends can fan apart, and they do, which is part
// of how the machine behaves. Collapsing the pile to a single stick at ×31
// would give the right mass and lose that entirely.
//
// What has to be dealt with is our joint model. Joints here come from SHARED
// COORDINATES (§5.4), so a pile whose sticks agree at BOTH ends arrives pinned
// to itself at both — 465 revolute joints per end, 959 in this 46-part machine,
// and the solver turns that into a lump that cannot swing at all. Measured on
// the level that would not throw: every part still, the goal piece untouched
// after twenty seconds.
//
// So the free ends are FANNED, by the smallest amount that is a different
// joint (the sim buckets ends with `jointKey`, which rounds to 0.1 px — see
// `addPin`). A rotation about the pinned end, spread symmetrically so the
// bundle's mean angle does not move, of one bucket per stick: a 31-stick pile
// on a 240 px arm ends up spanning about a degree, invisible on screen, and
// every stick is free to swing about the end it hangs from.
//
// Identical means IDENTICAL — same material, both ends on the same points to
// four decimals, which is what copy-pasting a stick in place produces. Two
// sticks that merely overlap are two sticks and are left alone.
//
// ---------------------------------------------------------------------------
// **THIS IS NOW THE FALLBACK, not the answer** (2026-08-16). Fanning infers
// which end is pinned — `carryingEnd` guesses it from what the pile touches,
// and admits outright that a pile touching nothing at either end is a coin
// toss. Where the source states it (`att`, the `[…]` lists), it is stated, the
// pile keeps its exact coordinates, and this never runs: `convertFcLevel` skips
// it whenever the paste declares anything. What is left here is for a paste
// that says nothing, which is every code-dialect (`J`/`R`/`W`) machine.
const STACK_DP = 1e4;
const STACK_FAN_PX = 0.15; // > jointKey's 0.1 px, so each free end is its own
const endKey = (x, y) => `${Math.round(x * STACK_DP)},${Math.round(y * STACK_DP)}`;

// Which end of a stack CARRIES ON — the one that meets something outside the
// pile. That is the end FC pins, and the other is the one that may fan. With
// nothing else at either end (a pile that is purely a free weight, which the
// level this came from has) the choice cannot matter, so it is the first.
function carryingEnd(stack, outside) {
 const a = stack[0];
 const at = (x, y) => outside.has(endKey(x, y));
 if (at(a.x1, a.y1) && !at(a.x2, a.y2)) return 1;
 if (at(a.x2, a.y2) && !at(a.x1, a.y1)) return 2;
 return 1;
}

function fanStacks(parts, scale) {
 const groups = new Map();
 for (const p of parts) {
 if (p.t !== 'rod') continue;
 // Order-insensitive: the same stick written end-for-end is the same stick.
 const ends = [endKey(p.x1, p.y1), endKey(p.x2, p.y2)].sort();
 const key = `${p.kind}|${ends[0]}|${ends[1]}`;
 if (!groups.has(key)) groups.set(key, []);
 groups.get(key).push(p);
 }
 const stacks = [...groups.values()].filter(g => g.length > 1);
 if (!stacks.length) return { stacked: 0, biggest: 0, piles: 0 };

 // Every endpoint that does NOT belong to a stack, so "carries on" can be
 // asked. Wheel hubs and bare joints count: a pile hung on a hub is hung on
 // the hub's end.
 const stacked = new Set(stacks.flat());
 const outside = new Set();
 for (const p of parts) {
 if (stacked.has(p)) continue;
 if (p.t === 'rod') { outside.add(endKey(p.x1, p.y1)); outside.add(endKey(p.x2, p.y2)); }
 else outside.add(endKey(p.x, p.y));
 }

 let biggest = 0, total = 0;
 for (const g of stacks) {
 const end = carryingEnd(g, outside);
 const px = end === 1 ? g[0].x1 : g[0].x2, py = end === 1 ? g[0].y1 : g[0].y2;
 const fx = end === 1 ? g[0].x2 : g[0].x1, fy = end === 1 ? g[0].y2 : g[0].y1;
 const len = Math.hypot(fx - px, fy - py) || 1;
 // One jointKey bucket of arc per stick, in SOURCE units.
 const step = (STACK_FAN_PX / (scale || 1)) / len;
 const mid = (g.length - 1) / 2;
 g.forEach((p, i) => {
 const a = (i - mid) * step;
 const c = Math.cos(a), s = Math.sin(a);
 const dx = fx - px, dy = fy - py;
 const nx = px + dx * c - dy * s, ny = py + dx * s + dy * c;
 if (end === 1) { p.x1 = px; p.y1 = py; p.x2 = nx; p.y2 = ny; }
 else { p.x2 = px; p.y2 = py; p.x1 = nx; p.y1 = ny; }
 });
 biggest = Math.max(biggest, g.length);
 total += g.length;
 }
 return { stacked: total, biggest, piles: stacks.length };
}

// ---------- the build area says which pieces are somebody's SOLUTION ----------
//
// (2026-08-11, on request: *"Assume all pieces in the build area are solution
// pieces. And all with any part outside are level pieces."*)
//
// A paste is very often a level WITH a solve sitting in it — the source exports
// what was on screen, and what was on screen is somebody's machine parked in the
// build area. Everything of theirs came across as the LEVEL's own furniture,
// which is a level that arrives already solved, already running the moment
// anyone presses Play, and needing to be taken apart by hand in the Maker. The
// build area is the source's own statement of which is which: it is the region
// the player may build in, so what is inside it was built, and what is not was
// authored.
//
// **Nothing is thrown away.** A part inside the build area becomes the PLAYER's
// (`design`, the Test tab's own machine, §8.2) rather than the level's — which
// is what it was in the source, and where Reset can clear the lot in one press
// if you want the level solved from scratch.
//
// **"Any part outside" is a containment test, not a centre test**, and it is the
// EDITOR'S containment test — `footprintInRect` out of sizes.js, the same
// function `_boxInBuildZoneStrict` uses to decide whether a machine has left the
// zone. A rod anchored to the world and reaching into the build area is a level
// piece by this rule, which is right: it is bolted to something the player
// cannot have placed.
//
// Judged on the piece's TRUE shape, which is why the footprint pair is worth
// reaching for — a circle is its centre held `r` from every edge, a rotated
// plank is its four real corners, and a rod is its two ends (exactly what
// `_segInBuildZoneStrict` asks of a stick). A box would hold a big wheel
// further from the boundary than a small one.
//
// **Zero slack**, where the editor allows 0.5 px: that tolerance exists to stop
// integer arrow-nudges creeping past a boundary, which nothing in a paste does,
// and slack here would only ever make the zone bigger and delete more. Every
// judgement call in this rule leans the same way — when in doubt it is a LEVEL
// piece, because a piece wrongly kept is visible in the preview and a piece
// wrongly dropped is gone.
//
// It applies to the MACHINE and to nothing else, because a player's machine is
// what a build area holds: a design is sticks, wheels and pins (§5.4), and the
// other pools have no player form to be marked as. Which leaves three exempt,
// and none of the three is a hedge:
// - a player cannot place static scenery, in the source or here, so a static
// piece inside the build area is an obstacle the author put there to be built
// around. Reading one as a solve would be wrong every single time;
// - a goal piece STARTS in the build area in this format — it is the thing you
// carry out of it. The paste this rule was written for has its goal ball
// sitting in one, and taking that out is taking the level's win condition
// (`validateLevelData` then demands one, so the importer would invent a
// placeholder crate somewhere else entirely);
// - a loose PROP has no player form at all. It stays in the level and is
// reported, because that is the one case the rule as asked for cannot be
// honoured and a reader should hear it from the importer rather than work it
// out from a preview.
//
// A paste with no build area constrains nothing and nothing is inside it, the
// same fast path the editor takes. Note that the importer INVENTS a build zone
// when a paste has none (see the fallbacks) — this runs first, deliberately, so
// a zone we made up cannot eat pieces we were given.
// **2 source units of slack, not 0** (2026-08-18). Measured across the sweep's
// 578 rod-only winners: 126 had a stick or two "outside" the build area, and
// the worst overhang among the complex ones was 1.7 units — a rod END pinned
// on the zone's edge, its centre-line a hair over from FC's own placement
// rounding. FC accepted every one of those machines as built inside the
// area; a rule that strands them as level pieces is stricter than the game
// they came from, and it broke a real player's imported solve into "level
// sticks" and "player sticks" over a fraction of a pixel. A stick's half-
// thickness (4 units solid, 2 hollow) is the honest tolerance: within it the
// PIECE still touches the zone even where its centre-line does not.
const SOLUTION_SLACK = 2;

// A parsed entry or machine part as a footprint, in SOURCE units.
function srcFootprint(o) {
 if (o.t === 'wheel') return { pts: [{ x: o.x, y: o.y }], r: o.rSrc ?? FC_WHEEL_R };
 if (o.t === 'rod') return { pts: [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }], r: 0 };
 if (o.shape === 'ball') return { pts: [{ x: o.x, y: o.y }], r: (o.dia || 0) / 2 };
 return { pts: rectCorners({ x: o.x, y: o.y, w: o.w, h: o.h, angle: o.rad || 0 }), r: 0 };
}

// Wholly inside ONE build zone. One zone rather than the union: the editor gives
// a piece spanning two TOUCHING zones a second chance (§7.2a) and this does not,
// so a piece bridging a seam is judged a level piece and kept — the safe way to
// be wrong.
export function inBuildArea(o, zones) {
 if (!zones || !zones.length) return false;
 const fp = srcFootprint(o);
 return zones.some(z => footprintInRect(fp, z, SOLUTION_SLACK));
}

// Conservative AABB of a parsed entry, in source units (rotation included).
// `rad` throughout — the source's own unit is settled during parsing, so
// nothing downstream has to know which one the paste was written in.
function entryBounds(e) {
 if (e.shape === 'ball') {
 // `dia` is `ballDia`'s answer and the only reading of a circle there is —
 // this function had its OWN copy of that rule for a day and got a different
 // answer from the piece, which put the level extent and `suggestScale` out
 // by 2× on any level with a circle in it. The fallback is for the synthetic
 // entries `levelExtent` builds out of a CONVERTED level, where the radius
 // is already known and is handed over as `w = h = r × 2`.
 const r = (e.dia != null ? e.dia : Math.max(e.w, e.h)) / 2;
 return { minX: e.x - r, minY: e.y - r, maxX: e.x + r, maxY: e.y + r };
 }
 const a = e.rad || 0;
 const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
 const hx = (e.w / 2) * c + (e.h / 2) * s;
 const hy = (e.w / 2) * s + (e.h / 2) * c;
 return { minX: e.x - hx, minY: e.y - hy, maxX: e.x + hx, maxY: e.y + hy };
}

// The same for a machine part, and it works in either frame: a wheel read out
// of the source has no radius of its own (they are all the 50-unit standard),
// a converted one carries the px radius it was snapped to.
function partBounds(p) {
 if (p.t === 'wheel') {
 const r = Number.isFinite(p.r) ? p.r : FC_WHEEL_R;
 return { minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r };
 }
 return {
 minX: Math.min(p.x1, p.x2), minY: Math.min(p.y1, p.y2),
 maxX: Math.max(p.x1, p.x2), maxY: Math.max(p.y1, p.y2),
 };
}

// Pieces and parts in one list — `t` is the machine's own key (§11.1) and no
// piece has ever had one.
const anyBounds = o => (o.t ? partBounds(o) : entryBounds(o));

function unionBounds(list, boundsOf) {
 let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
 for (const item of list) {
 const b = boundsOf(item);
 if (b.minX < minX) minX = b.minX;
 if (b.minY < minY) minY = b.minY;
 if (b.maxX > maxX) maxX = b.maxX;
 if (b.maxY > maxY) maxY = b.maxY;
 }
 if (!isFinite(minX)) return null;
 return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Bounds of a converted LIFIRIK level, in px — what the UI reports as the
// level's footprint, and the same shapes renderPreview() frames on.
export function levelExtent(level) {
 const items = [
 ...(level.terrain || []).map(o => ({ o })),
 ...(level.props || []).map(o => ({ o })),
 ...(level.goalObjs || []).map(o => ({ o })),
 ...(level.buildZones || []).map(o => ({ o })),
 ...(level.goalZones || []).map(o => ({ o })),
 // The machine counts: renderPreview() frames on fixedParts, so a footprint
 // that left them out would disagree with the picture beside it.
 ...(level.fixedParts || []).map(o => ({ o })),
 ];
 return unionBounds(items, ({ o }) => (o.t ? partBounds(o) : entryBounds({
 shape: o.r != null ? 'ball' : 'box',
 x: o.x, y: o.y, w: o.r != null ? o.r * 2 : o.w, h: o.r != null ? o.r * 2 : o.h,
 rad: o.angle || 0,
 })));
}

// The scale that puts THIS level's goal pieces back on LIFIRIK's standard
// goal piece (the wheel's diameter) — the honest alternative to DEFAULT_SCALE
// when a level was authored off a different base. null when the source has no
// goal pieces.
export function suggestScale(entries) {
 const want = STD_WHEEL_R * 2;
 const sizes = entries
 .filter(e => e.role === 'goal')
 .map(e => (e.shape === 'ball' ? e.dia : Math.min(e.w, e.h)))
 .filter(v => v > 0)
 .sort((a, b) => a - b);
 if (!sizes.length) return null;
 const median = sizes[(sizes.length - 1) >> 1];
 return Math.round((want / median) * 1000) / 1000;
}

// ---------- convert ----------

// opts: { scale, recentre, texture, background, corners, name, desc }
// → { level, warnings, stats } — `level` is the Maker's level shape (data
// fields + name/desc), ready for a draft, a publish payload, or the Maker.
// **The paste, transpiled to FC's XML at the STRING level** (2026-08-17, for
// the C loader). No number in the output ever existed as a JS double: the
// digit substrings are lifted from the paste's own characters and placed
// between tags, so fcsim's fp_strtod reads exactly what the source wrote.
// This deliberately re-tokenizes with its own (simpler) grammar — the word
// dialect's `Kind#id (x, y), (w[, h])[, rot] [deps]` — and answers null for
// anything it cannot carry faithfully, which routes that paste to the JS
// build instead of guessing.
//
// Returns { xml, players } — `players` is the per-player-block manifest
// ({ t, goal }) the sim maps its recs with, in the XML's own order.
const FC_XML_TAGS = {
 staticrect: { tag: 'StaticRectangle', pool: 0 },
 staticcircle: { tag: 'StaticCircle', pool: 0 },
 dynamicrect: { tag: 'DynamicRectangle', pool: 0 },
 dynamiccircle: { tag: 'DynamicCircle', pool: 0 },
 goalrect: { tag: 'JointedDynamicRectangle', pool: 1, goal: true, t: 4 },
 upwheel: { tag: 'NoSpinWheel', pool: 1, t: 5 },
 unpoweredwheel: { tag: 'NoSpinWheel', pool: 1, t: 5 },
 cwwheel: { tag: 'ClockwiseWheel', pool: 1, t: 6 },
 ccwwheel: { tag: 'CounterClockwiseWheel', pool: 1, t: 7 },
 goalupwheel: { tag: 'NoSpinWheel', pool: 1, goal: true, t: 5 },
 goalcwwheel: { tag: 'ClockwiseWheel', pool: 1, goal: true, t: 6 },
 goalccwwheel: { tag: 'CounterClockwiseWheel', pool: 1, goal: true, t: 7 },
 // A round goal is a WHEEL only when its line wears machine markings — the
 // same `#id`-or-`[…]` test the parser applies. A bare one is a real goal
 // ball, which this path cannot carry (needMark bails below).
 goalcircle: { tag: 'NoSpinWheel', pool: 1, goal: true, t: 5, needMark: true },
 goalball: { tag: 'NoSpinWheel', pool: 1, goal: true, t: 5, needMark: true },
 gc: { tag: 'NoSpinWheel', pool: 1, goal: true, t: 5, needMark: true },
 stick: { tag: 'SolidRod', pool: 1, t: 8, thick: '8' },
 placedstick: { tag: 'SolidRod', pool: 1, t: 8, thick: '8' },
 rod: { tag: 'HollowRod', pool: 1, t: 9, thick: '4' },
 placedrod: { tag: 'HollowRod', pool: 1, t: 9, thick: '4' },
};

// **The other direction: retrieveLevel XML → the paste dialect** (2026-08-18,
// the .fcxml door). Digits travel VERBATIM — every number is lifted as the
// characters the XML carries and never through a JS double, for the same
// last-ulp reason fcPasteToXml above works at the string level. This is the
// generator probe-fcpair and fc-sweep have each carried privately; the door
// made it a third copy, which is when it became an export instead.
// Returns null when the XML is not usable: no start/end zones ever passes,
// and with `requireDesign` (the .fcxml door's mode, and the default) an XML
// with no player blocks is refused too — that door is a DESIGN door. The
// import screen passes requireDesign: false, because a level with no
// player blocks is a perfectly good thing to import (2026-08-24, "importer
// needs to process XML input as well").
// **What a retrieveLevel XML knows about itself** (2026-08-18, "include the
// original level number in the description for the Sticks levels and any
// other time we grab levels from FCsim"). `levelId` is FC's own number for
// the LEVEL — the one that opens it at fantasticcontraption.com/?levelId=N
// and ft.jtai.dev/?levelId=N; `levelNumber` is FC's sequence number and is
// only ever filled for its own official levels (community levels carry it
// empty). The design id is not in the XML at all — it comes from the
// filename or the caller. `name` is the level's own title.
export function fcXmlMeta(xml, designId = null) {
 const src = String(xml || '');
 const g = (t) => ((src.match(new RegExp('<' + t + '>([\\s\\S]*?)</' + t + '>')) || [])[1] || '').trim();
 return {
 designId: designId != null && String(designId).match(/^\d+$/) ? String(designId) : null,
 levelId: g('levelId').match(/^\d+$/) ? g('levelId') : null,
 levelNumber: g('levelNumber').match(/^\d+$/) ? g('levelNumber') : null,
 name: g('name').replace(/\s+/g, ' ').slice(0, 60) || null,
 };
}
// The provenance line an FC-sourced level carries when nobody could look the
// names up — the same shape as scripts/fc-meta.mjs's fcCredit (which knows
// the level's title and author and the design's builder), with the gaps
// stated: "level N, solved by an unknown builder". The server replaces this
// with the credited line at stash time whenever it can (fcCreditPaste).
export function fcProvenance(meta) {
 if (!meta.designId && !meta.levelId && !meta.name) return '';
 // the same shape fcCredit writes when the names ARE known (fc-meta.mjs,
 // 2026-08-24) — for a design import <name> is the DESIGN's nickname, for a
 // level import it is the level's own title
 const num = meta.levelNumber ? ` #${meta.levelNumber}` : '';
 if (meta.designId) {
 const lvl = (meta.levelId ? `Level ${meta.levelId}` : 'A level') + num;
 return `${lvl},\nsolved by an unknown builder` + (meta.name ? ` — "${meta.name.slice(0, 40)}"` : '')
 + ` (design ${meta.designId}).\nThanks to FantasticContraption.com.`;
 }
 const lvl = meta.name
 ? `"${meta.name.slice(0, 40)}"` + (meta.levelId ? ` (level ${meta.levelId}${num})` : num)
 : (meta.levelId ? `Level ${meta.levelId}${num}` : `A level${num}`);
 return `${lvl}.\nThanks to FantasticContraption.com.`;
}

export function fcXmlToPaste(xml, { designId = null, requireDesign = true } = {}) {
 const src = String(xml || '');
 if (!src.includes('<retrieveLevel>')) return null;
 const numS = (b, t) => { const m = b.match(new RegExp('<' + t + '>(-?[\\d.eE+-]+)</' + t + '>')); return m ? m[1] : '0'; };
 const posS = (b) => { const m = b.match(/<position>\s*<x>(-?[\d.eE+-]+)<\/x>\s*<y>(-?[\d.eE+-]+)<\/y>\s*<\/position>/); return m ? { x: m[1], y: m[2] } : null; };
 const WORD = {
 StaticRectangle: 'StaticRect', StaticCircle: 'StaticCircle',
 DynamicRectangle: 'DynamicRect', DynamicCircle: 'DynamicCircle',
 JointedDynamicRectangle: 'GoalRect',
 NoSpinWheel: 'UpWheel', ClockwiseWheel: 'CWWheel', CounterClockwiseWheel: 'CCWWheel',
 SolidRod: 'Stick', HollowRod: 'Rod',
 };
 const zone = (tag) => {
 const m = src.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
 if (!m) return null;
 const p = posS(m[1]);
 return p && `(${p.x}, ${p.y}), (${numS(m[1], 'width')}, ${numS(m[1], 'height')})`;
 };
 const start = zone('start'), end = zone('end');
 if (!start || !end) return null;
 const L = [];
 const meta = fcXmlMeta(src, designId);
 if (meta.name) L.push('@name ' + meta.name.slice(0, 60));
 // …and everything else the XML knows about itself, as the description the
 // Maker's save dialog preloads — the ONE provenance line every path that
 // takes a level from FC writes (fcProvenance): the .fcxml door, the sweep's
 // report links and the Sticks publisher all say the same thing.
 // one line: the paste grammar is line-oriented, so the credit's own line
 // breaks become spaces here (they survive where desc is set directly)
 const prov = fcProvenance(meta).replace(/\n/g, ' ');
 if (prov) L.push('@description ' + prov.slice(0, 300));
 L.push(`BuildArea ${start}`, `GoalArea ${end}`);
 let players = 0;
 for (const m of src.matchAll(/<(StaticRectangle|StaticCircle|DynamicRectangle|DynamicCircle|JointedDynamicRectangle|NoSpinWheel|ClockwiseWheel|CounterClockwiseWheel|SolidRod|HollowRod)(\s+id\s*=\s*["'](\d+)["'])?\s*>([\s\S]*?)<\/\1>/g)) {
 const [, type,, bid, body] = m;
 const p = posS(body);
 if (!p) return null;
 if (/Rod|Wheel|Jointed/.test(type)) players++;
 let tag = WORD[type];
 // a goal wheel is cargo, and the word says so (see FC_PART_ALIASES)
 if (/<goalBlock>true<\/goalBlock>/.test(body) && /Wheel/.test(type)) tag = 'Goal' + tag;
 tag += bid != null ? '#' + bid : '';
 const att = [...body.matchAll(/<jointedTo>\s*(\d+)\s*<\/jointedTo>/g)].map(x => x[1]);
 L.push(`${tag} (${p.x}, ${p.y}), (${numS(body, 'width')}, ${numS(body, 'height')}), ${numS(body, 'rotation')}`
 + (att.length ? ` [${att.join(', ')}]` : ''));
 }
 return (players || !requireDesign) ? L.join('\n') : null;
}

export function fcPasteToXml(text) {
 const NUM = '(-?[\\d.]+(?:[eE][-+]?\\d+)?)';
 const LINE = new RegExp(`^(\\w+)(?:#(\\d+))?\\s*\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*\\)\\s*,\\s*\\(\\s*${NUM}(?:\\s*,\\s*${NUM})?\\s*\\)(?:\\s*,\\s*${NUM})?(?:\\s*\\[([\\d,\\s]*)\\])?\\s*$`);
 const lvl = [], ply = [], players = [], levels = [];
 let start = null, end = null;
 for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
 const line = raw.trim();
 if (!line || line.startsWith(';') || line.startsWith('@')) continue;
 const m = line.match(LINE);
 if (!m) {
 // **STRICT, and it has to be** (2026-08-17, the vanished import): a
 // line that LOOKS like a piece statement but doesn't fit this grammar
 // used to be skipped — which built a world quietly missing blocks, so
 // every rec after the hole mapped onto the wrong body and the run
 // "played" invisibly off-screen. If it names a piece and we can't
 // carry it, the whole paste goes to the JS build instead.
 if (/^\w+(#\d+)?\s*\(/.test(line)) return null;
 continue; // legends, headers — genuinely not pieces
 }
 const [, word, id, x, y, w, h, rot, deps] = m;
 const kind = word.toLowerCase();
 if (kind === 'buildarea') { start = { x, y, w, h: h ?? w }; continue; }
 if (kind === 'goalarea') { end = { x, y, w, h: h ?? w }; continue; }
 const def = FC_XML_TAGS[kind];
 if (!def) return null; // a word this table cannot carry — JS build
 const joints = (deps || '').split(',').map(s => s.trim()).filter(Boolean);
 // a bare GoalCircle is a real goal ball, which this path cannot carry —
 // the parser makes the same machine-markings distinction
 if (def.needMark && id == null && !joints.length) return null;
 const block = ` <${def.tag}${''}${id != null ? ` id="${id}"` : ''}>
 <rotation>${rot ?? '0'}</rotation>
 <position><x>${x}</x><y>${y}</y></position>
 <width>${w}</width>
 <height>${h ?? def.thick ?? w}</height>
 <goalBlock>${def.goal ? 'true' : 'false'}</goalBlock>
 ${joints.length ? `<joints>${joints.map(j => `<jointedTo>${j}</jointedTo>`).join('')}</joints>` : '<joints/>'}
 </${def.tag}>`;
 if (def.pool === 0) {
 lvl.push(block);
 // `dynamic` is which PILE the converted level keeps the piece in
 // (props or terrain — sim.js maps the C bodies onto recs by it), and a
 // zero-area dynamic is in the terrain pile, by the same rule the parser
 // applied (fcMassless). The XML still carries the source's `0`
 // verbatim, so the C loader builds FC's own massless body regardless.
 const isDyn = kind.startsWith('dynamic');
 const zeroArea = isDyn && fcMassless(kind === 'dynamiccircle' ? 'ball' : 'box', Number(w), Number(h ?? w));
 levels.push({ dynamic: isDyn && !zeroArea });
 } else {
 ply.push(block);
 players.push({ t: def.t, goal: !!def.goal });
 }
 }
 if (!start || !end || !ply.length) return null;
 const zone = (tag, z) =>
 ` <${tag}>
 <position><x>${z.x}</x><y>${z.y}</y></position>
 <width>${z.w}</width>
 <height>${z.h}</height>
 </${tag}>`;
 const xml = `<?xml version="1.0"?><retrieveLevel>
<levelId></levelId>
<levelNumber></levelNumber>
<name></name>
<formatVersion>1</formatVersion>
<level>
 <levelBlocks>
${lvl.join('\n')}
 </levelBlocks>
 <playerBlocks>
${ply.join('\n')}
 </playerBlocks>
${zone('start', start)}
${zone('end', end)}
</level>
</retrieveLevel>`;
 return { xml, players, levels };
}

export function convertFcLevel(text, opts = {}) {
 // **retrieveLevel XML is a first-class input** (2026-08-24, on report:
 // *"importer needs to process XML input as well"*). Fetched or hand-pasted,
 // the XML is turned into the paste dialect by the same generator the .fcxml
 // door uses, then converted exactly as a paste — ONE pipeline, so the scale,
 // the textures and the solution checkbox cannot behave differently by entry
 // route. requireDesign is false here: a level fetched without a design is a
 // perfectly good import, and the zones are the only hard requirement — a
 // retrieveLevel with no start/end is not a level at all.
 if (String(text || '').includes('<retrieveLevel>')) {
 const paste = fcXmlToPaste(text, { designId: opts.fcDesignId || null, requireDesign: false });
 if (paste == null) throw new Error('That is retrieveLevel XML, but it has no build and goal areas — not a level.');
 text = paste;
 }
 const scale = Number.isFinite(+opts.scale) && +opts.scale > 0 ? +opts.scale : DEFAULT_SCALE;
 const recentre = opts.recentre !== false;
 // **`classic` is what an FC paste comes out as** (2026-08-16, on request:
 // that texture was drawn for these imports). It has to be WRITTEN on every
 // piece, because the game's own unset default is granite (§14.4) — so
 // granite, and only granite, still converts to `null` and rides on the
 // fallback rather than bloating the level for no visual change.
 //
 // Physically it is the same ground either way: granite, neon and classic are
 // all pinned to SURFACE_LEGACY (surfaces.js), so this changes what an import
 // LOOKS like and nothing about how it plays.
 const texture = opts.texture === 'granite' ? null
 : (opts.texture ? String(opts.texture) : FC_DEFAULT_TEXTURE);
 const background = opts.background ? String(opts.background) : null;
 // Corners: 0 by default, and written explicitly on every box. Source pieces
 // are sharp rectangles, so LIFIRIK's unset-means-8px rounding (§5.3) would
 // be a shape the author never drew — most visible on the thin planks, where
 // cornerRadiusOf clamps the radius to half the thickness and turns the whole
 // piece into a capsule. Overridable for anyone who wants the house style.
 const corners = Number.isFinite(+opts.corners) && +opts.corners >= 0 ? +opts.corners : 0;

 // The screen's per-code texture picks, if it sent any (see `letterCode`).
 const parsed = parseFcText(text, opts.letterTextures || null);
 const {
 joints, errors, absoluteNodes, assumedWater, lettered,
 triZones, namedThick, badDeps, farDeps, snapped, angleUnit, angleDeclared, pins, masslessProps,
 } = parsed;
 const warnings = errors.map(e => `Entry ${e.index + 1} skipped — ${e.why}: ${clip(e.text)}`);

 // ---- the machine in the build area is the PLAYER'S (see `inBuildArea`) ----
 //
 // Sorted HERE, before anything else looks at the paste, because two things
 // downstream have to agree about which pool a part is in — the level it goes
 // into and the design it goes into are converted by the same `at()` and must
 // still share coordinates afterwards (§5.4).
 //
 // Off with `solutionInBuild: false`, which puts the whole machine in the level
 // the way it always did.
 const takeSolution = opts.solutionInBuild !== false;
 const srcZones = parsed.entries
 .filter(e => e.role === 'buildZone')
 .map(e => ({ x: e.x, y: e.y, w: e.w, h: e.h, angle: e.rad || 0 }));
 const entries = parsed.entries;
 // A pile of identical sticks is a WEIGHT, pinned at one end (see `fanStacks`).
 // Done before anything measures or sorts the parts, since it moves ends.
 //
 // **Only when the paste does not say** (2026-08-16). Fanning is a workaround
 // for not knowing which end is bolted: it moves geometry, by a tenth of a
 // pixel, so that the coordinate rule arrives at the answer the source already
 // stated outright. Where the source DOES state it — the `[n]` lists, see
 // `att` below — the pile hangs by the end FC pinned and its free ends are
 // free because they are declared free, so nothing has to be nudged and an
 // imported design's coordinates are the source's to the last decimal.
 // **…or every machine part carries an `#id`** (2026-08-18 on the
 // no-joints exemplars: "just a solve with only one free wheel — even
 // no-piece solves are ok, maybe someone just moves the goal piece"). A
 // lone wheel, or a design of nothing but the moved cargo, has NOTHING to
 // bolt and so speaks no `[…]` — and was refused the C world for it, as if
 // it were the legacy dialect. The FC dialect is declared by its SHAPE: the
 // exporter numbers every machine block, the legacy forms never do. So an
 // ID on every part (goal wheels included — they are cargo, but they are
 // machine blocks in the paste) is the same statement as a dependency
 // list, made by a paste with no dependencies to state.
 const allIdd = parsed.parts.length > 0 && parsed.parts.every(p => p.srcId != null);
 const declaresJoints = parsed.decls.length > 0 || parsed.declTokens > 0 || allIdd;
 // The SOURCE ORDER of the machine parts, marked before the build-area split
 // scatters them across two pools: fcsim resolves each block's declarations
 // against the blocks already walked, so a rod naming a wheel only finds its
 // spokes if the wheel was processed first — and "first" means the paste's
 // order, not the pool's (2026-08-17, a goal wheel outside the build area).
 if (declaresJoints) parsed.parts.forEach((p, i) => { p.srcSeq = i; });
 const stacks = declaresJoints ? { stacked: 0, biggest: 0, piles: 0 } : fanStacks(parsed.parts, scale);
 // **A goal-flagged wheel is CARGO, not a machine part** (2026-08-17, design
 // 12723961 — its only delivery is a free wheel). It leaves the parts pools
 // entirely and joins goalObjs as a BALL below: the level gets its goal
 // piece (the server requires one, the zone UI shows one), and on the C
 // path the block is still fcsim's wheel, goal flag and all.
 const goalWheels = parsed.parts.filter(p => p.t === 'wheel' && p.goalFlag);
 const isPlayers = p => takeSolution && inBuildArea(p, srcZones);
 const parts = parsed.parts.filter(p => !p.goalFlag && !isPlayers(p));
 const playerParts = parsed.parts.filter(p => !p.goalFlag && isPlayers(p));
 // A loose piece inside the build area is NOT made a player piece, because
 // there is no such thing: a design is sticks, wheels and pins (§5.4), and a
 // dynamic crate is not one of them. It stays a level prop and is reported, so
 // the one case the rule cannot honour is visible rather than quietly decided.
 const propsInBuild = takeSolution
 ? entries.filter(e => e.role === 'prop' && inBuildArea(e, srcZones)).length : 0;

 // Nothing to say about a unit nothing used — and the PLAYER's parts count.
 // They were left out when the build area started sorting the machine into two
 // piles, so a paste whose only rotations are in its solve reported no angle
 // unit at all and never warned that it had read radians: the one paste where
 // that warning matters most is the one that is nothing but a machine.
 const rawAnglesSeen = entries.some(e => e.rot) || parts.some(p => p.rot) || playerParts.some(p => p.rot);

 if (lettered.length) {
 // Which code became which texture, said once per distinct code — the piece
 // is silent about it afterwards (a texture is just a texture once it is on
 // the piece), so this is the only place the mapping is visible.
 const seen = [...new Set(lettered)];
 const shown = seen.slice(0, 6).map(c => `${c} → ${textureForLetter(c[0])}`).join(', ');
 warnings.push(`${plural(lettered.length, 'piece', 'pieces')} used a code that isn't in the format; anything ending R or C is read as a static rectangle or circle and the first letter picks the texture (${shown}${seen.length > 6 ? ', …' : ''}). They are ordinary terrain — change the look in the Maker if a letter guessed wrong.`);
 }

 // Recentre on the origin: source levels sit wherever they were authored,
 // and LIFIRIK's editor grid, camera and hand-authored levels all work
 // around (0,0). Purely a translation — no contact relationship moves.
 // The PLAYER's parts are in the union too, and have to be: this is one
 // translation applied to everything, and a design framed by a different
 // number than its level is a design standing beside it.
 let ox = 0, oy = 0;
 const srcBounds = unionBounds([...entries, ...parts, ...playerParts, ...goalWheels], anyBounds);
 if (recentre && srcBounds) {
 ox = -(srcBounds.minX + srcBounds.maxX) / 2;
 oy = -(srcBounds.minY + srcBounds.maxY) / 2;
 }

 let grown = 0; // pieces pushed up to an editor floor
 let squashedBalls = 0; // circles whose w and h disagreed
 let unrotatedGoals = 0; // goal pieces that had to drop their rotation

 // **A DECLARED paste is stored to the last bit** (2026-08-17). round4 keeps
 // hand-authored JSON tidy, but re-quantizing a source number moves it by a
 // few 1e-13 — `round4(21.65)` is not `Number("21.65")` — and an FC replay's
 // degenerate stack impact amplifies exactly those bits. The source's own
 // decimals are already short, so the tidiness this loses is nothing and
 // the fidelity it buys is the machine doing what it did at home.
 const r4 = declaresJoints ? (v => v) : round4;
 const at = e => ({ x: r4((e.x + ox) * scale), y: r4((e.y + oy) * scale) });
 const boxOf = (e) => {
 // **A ZERO axis is a ghost line, and it draws at stick thickness**
 // (2026-08-18, design 11947603 — 230 of them hand-placed to draw a
 // face). FC's own client and fcsim render a zero-height rect as a bar
 // about a stick wide, and a portrait made of them only reads that way;
 // the 1 px hairline the area floor gave them left a faint sketch. So the
 // zero axis takes STICK thickness here. Physics does not follow: on the
 // C path the transpiled XML still carries the source's 0 verbatim and
 // the engine builds FC's own degenerate box, so a bit-exact replay
 // stays bit-exact — this is what the piece LOOKS like, and what the
 // JS build (an edited machine) collides with, which for a level whose
 // lines look like bars is the honest body.
 const GHOST_LINE_THICK = 8; // BEAM_THICK.wood — a stick's own width
 const w0 = (e.w === 0 && e.h > 0 ? GHOST_LINE_THICK : e.w) * scale;
 const h0 = (e.h === 0 && e.w > 0 ? GHOST_LINE_THICK : e.h) * scale;
 if (!pieceBoxLegal(w0, h0)) grown++;
 const fit = fitPieceBox(w0, h0);
 let w = round4(fit.w), h = round4(fit.h);
 // fitPieceBox lands a sub-floor piece EXACTLY on the area floor, and
 // rounding to 4 dp from there can shave it back under — a 0×29 source
 // rect at scale 0.25 comes out 1.1744 × 8.5147 = 9.9997 px², which the
 // server then refuses. Round the other way in that one case: ceiling can
 // only grow an axis, so what comes out is legal as written, and the caps
 // and floors stay something the importer absorbs with a warning rather
 // than something that bounces the whole import (see CAP above).
 if (!pieceBoxLegal(w, h)) { w = ceil4(fit.w); h = ceil4(fit.h); }
 return { w, h };
 };
 // A circle is a SCALE and nothing else here: `ballDia` already decided what
 // the source's number meant (radius, diameter, or one size stated twice) and
 // left a diameter in source units behind, which is the only reading of it
 // anywhere in this file. Wheels are the same rule from the other end and are
 // untouched — `FC_WHEEL_R` (25 = half the 50-unit standard) reads them as a
 // diameter and always has.
 const ballR = (e) => {
 if (e.squashed) squashedBalls++;
 const r0 = e.dia * scale / 2;
 if (r0 < MIN_BALL_R) grown++;
 return round4(clampBallR(r0));
 };
 // Already radians, and already the paste's own unit (`angleUnit`) — the sign
 // convention is LIFIRIK's either way, so there is nothing to flip.
 const angleOf = e => (e.rad ? round5(e.rad) : 0);
 // zones are plain rects with no corner rounding to speak of — only pieces
 // carry the radius
 const pieceBox = e => ({ ...boxOf(e), radius: corners });

 const terrain = [], props = [], goalObjs = [], buildZones = [], goalZones = [];
 // **FC's anchors, in LIFIRIK's own words** (2026-08-22: *"The
 // UPWheels and the main wheel are all pinned in the FC1/FC2/FCSim case.
 // Ours just fall."*).
 //
 // FC has no pin object. What it has is a body with no mass — a block with a
 // zero axis, a wheel with a zero radius — which Box2D makes STATIC, so
 // anything bolted to one is bolted to the world. That is how a hand-authored
 // level nails a powered wheel down, and this paste does it twice over: a
 // 0×0 goal rect under the big drive's hub, and four 0-radius no-spin wheels
 // at the corners.
 //
 // On the C loader none of this needs saying — fcsim reads the source XML and
 // makes those bodies itself. But the C loader is not always there: it goes
 // the moment the machine carries something FC cannot spell, and it USED to
 // go the moment the level was saved out of the Maker (`_levelData` shipped
 // no `fcWorld`, fixed with this). Then LIFIRIK's own build runs, and it had
 // nothing that says "anchor" — so five wheels fell out of a level that is
 // motionless at home.
 //
 // LIFIRIK's word for it is a LOOSE PIN, which bolts whatever shares its
 // coordinate to the static background (sim.js `anchorBody`). One per
 // zero-area player block, marked `fc` so fcworld.js knows it is the source's
 // own anchor restated and not a LIFIRIK bolt the XML would have to carry
 // (which is still a refusal — see `fcMachineXml`).
 const fcPins = [];
 const pinKeys = new Set();
 // Deduped by jointKey, because two anchors on one coordinate are one anchor:
 // this paste's big wheel and the 0×0 goal rect it hangs from are the same
 // point to the last decimal, and two pins there would be two joints to the
 // background rather than one.
 const pinAt = (p) => {
 const k = jointKey(p.x, p.y);
 if (pinKeys.has(k)) return;
 pinKeys.add(k);
 fcPins.push({ x: p.x, y: p.y, fc: 1 });
 };

 for (const e of entries) {
 const pos = at(e);
 const angle = angleOf(e);

 if (e.role === 'buildZone' || e.role === 'goalZone') {
 const zone = { ...pos, ...boxOf(e) };
 if (angle) zone.angle = angle;
 (e.role === 'buildZone' ? buildZones : goalZones).push(zone);
 } else if (e.role === 'terrain') {
 const t = e.shape === 'ball'
 ? { type: 'ball', ...pos, r: ballR(e) }
 : { type: 'box', ...pos, ...pieceBox(e) };
 if (angle && e.shape === 'box') t.angle = angle;
 // A code that names its own material (CR) beats the screen's choice —
 // it is naming the piece, not decorating the level.
 if (e.texture || texture) t.texture = e.texture || texture;
 // A massless dynamic (see parseFcText) is a static made of FC's DYNAMIC
 // environment material — friction 0.7 like the ground, but restitution
 // 0.2 where the ground has 0 (fcsim graph.c: dynamic_env_material vs
 // static_env_material). Only the bounce is stated: the friction is the
 // ground's own and the `fc` profile already supplies it, and a piece
 // that names its friction is treated as hand-tuned and loses that.
 // …and it COLLIDES as the line it is: `line` names the axis the source
 // wrote as 0, and sim.js builds that axis at zero extent — the same
 // degenerate box FC's gen builds — while the piece still draws at the
 // stick thickness boxOf gave it. Without this a ball rested 4 px higher
 // on the JS build than on the C loader, on ten of the 32 Sticks levels.
 if (e.massless) {
 t.surface = { restitution: 0.2 };
 if (e.shape === 'box') t.line = e.w === 0 ? 'w' : 'h';
 }
 terrain.push(t);
 } else if (e.role === 'prop') {
 const p = e.shape === 'ball'
 ? { shape: 'ball', ...pos, r: ballR(e) }
 : { shape: 'box', ...pos, ...pieceBox(e) };
 if (angle && e.shape === 'box') p.angle = angle;
 props.push(p);
 } else {
 // Goal pieces spawn axis-aligned: sim.js gives them an identity rotation
 // and then lets physics own the angle (§5.3), so a rotated source goal
 // piece cannot be reproduced — say so instead of pretending.
 if (angle && e.shape === 'box') unrotatedGoals++;
 goalObjs.push(e.shape === 'ball'
 ? { shape: 'ball', ...pos, r: ballR(e) } // a diameter in both dialects — see ballDia
 : { shape: 'box', ...pos, ...pieceBox(e) });
 // …and a zero-area one is an ANCHOR wearing cargo's clothes (see the
 // `anchor` mark in parseFcText): FC makes it static, so it and whatever
 // shares its coordinate are bolted to the world.
 if (e.anchor) pinAt(pos);
 }
 }
 // …and the goal WHEELS, as balls, after the entry-borne goal pieces — the
 // C-path mapping pulls box-goals and ball-goals as separate queues, so the
 // two families only need their own internal order (2026-08-17).
 for (const p of goalWheels) {
 goalObjs.push({ shape: 'ball', ...at(p), r: round4(clampBallR(p.rSrc * scale)) });
 }

 // ---- the machine (§5.4) ----
 //
 // A part is a scale and a translation and nothing else. `at()` is the very
 // map every piece above went through, so two ends that resolved to one joint
 // still share a coordinate to the last decimal — and sharing a coordinate is
 // what bolts them together, so the source's node graph arrives intact with
 // nothing carrying it.
 //
 // Ids are `fc1`, `fc2`… rather than `uid()`: they are editor bookkeeping (the
 // drag maps key on them, and a part with no id collapses several into one),
 // `uid()` lives in util.js where this file deliberately cannot reach, and a
 // converter that returns the same JSON twice for the same paste is worth more
 // here than a random one. Nothing else in a level carries an id, so they
 // cannot collide with anything.
 // **Both pools go through this same function**, and that is the whole of what
 // keeps a player's stick bolted to a level's wheel: `at()` is one scale and
 // one translation, so two ends that resolved to one joint in the source still
 // share a coordinate to the last decimal on either side of the split (§5.4).
 // Ids are prefixed apart (`fc` / `fcp`) because the two lists are stored in
 // two places and an id is only ever unique within its own.
 // **`att` — what the SOURCE said each attachment point is bolted to**, one
 // entry per point in the source's own order: two for a rod (its ends), one
 // for a wheel (its hub). It is fcsim's block `joints` array, kept.
 //
 // 'fcp7' bolted to that part, and to nothing else
 // null DECLARED FREE — something may be sitting on this point, and the
 // source says it is not bolted to it
 // true bolted to something that is not a part of the machine (a bare
 // pin, a piece of scenery) or to more than one thing at once —
 // neither of which a single id can name, so this end falls back to
 // the coordinate rule and welds whatever it is touching
 //
 // The three states are the whole point: `null` is the one LIFIRIK could never
 // say for itself, and it is what lets a stack of 31 identical sticks hang by
 // one end instead of welding into a lump at both.
 //
 // **All or nothing per paste** (`declaresJoints`, decided up beside the fan).
 // A paste that never used the `[n]` syntax gets no `att` at all and keeps the
 // coordinate rule exactly as it always had it — which is what the code
 // dialect (`J`/`R`/`W`) does, where a shared node IS a shared coordinate and
 // there is nothing left for a declaration to add.
 const idOf = new Map();
 parts.forEach((p, i) => idOf.set(p, 'fc' + (i + 1)));
 playerParts.forEach((p, i) => idOf.set(p, 'fcp' + (i + 1)));
 const attOf = new Map();
 if (declaresJoints) {
 for (const { part, end, toId } of parsed.decls) {
 const slot = end == null ? 0 : end;
 const target = parsed.partsById.get(toId);
 // A pin, a piece of scenery, or a part that fell out of both pools: real
 // attachments, none of them nameable, all of them "weld what you touch".
 const named = target && idOf.has(target) ? idOf.get(target) : true;
 let a = attOf.get(part);
 if (!a) attOf.set(part, a = []);
 // Two statements about one point cannot both be named by one id, so the
 // point opens up rather than one of them being dropped on the floor.
 a[slot] = a[slot] == null ? named : (a[slot] === named ? named : true);
 }
 }
 // Ends the source never mentioned are DECLARED FREE, so the array is filled
 // out to the piece's real number of points rather than left short — a missing
 // trailing entry and an explicit `null` have to mean the same thing.
 const attFor = (p) => {
 if (!declaresJoints) return null;
 const a = attOf.get(p) || [];
 const n = p.t === 'wheel' ? 1 : 2;
 return Array.from({ length: n }, (_, k) => (a[k] === undefined ? null : a[k]));
 };

 const offLadder = []; // radii that are not one of LIFIRIK's three
 const convertParts = (list, prefix) => list.map((p, i) => {
 const id = idOf.get(p) || (prefix + (i + 1));
 const att = attFor(p);
 // **The SOURCE SHELL rides beside the endpoints on declared parts**
 // (2026-08-17). fcsim's graph derives a declared piece's geometry from
 // its centre + length + rotation through its own fixed-point trig, and
 // the sim now does the same (`_planJoints`) — so the shell has to arrive
 // UNROUNDED: `at()` rounds to 4 dp and endpoints round-trip through JS
 // trig, and either perturbation is enough to split a degenerate stick
 // pile's first impact. Translation and scale only; no round4.
 const shellAt = (sp) => (att ? {
 ...(sp.srcSeq != null ? { srcSeq: sp.srcSeq } : {}),
 shell: { x: (sp.x + ox) * scale, y: (sp.y + oy) * scale,
 ...(sp.len != null ? { len: sp.len * scale } : {}),
 ...(sp.rSrc != null ? { r: sp.rSrc * scale } : {}), // a wheel's SOURCE radius — its spokes sit on it
 rot: angleUnit === 'rad' ? (sp.rot || 0) : (sp.rot || 0) * Math.PI / 180 },
 } : {});
 if (p.t === 'wheel') {
 // **A wheel comes across at the size the source drew it** (2026-08-22,
 // a 450-unit powered wheel filling a level's arena: *"a big working
 // wheel pinned"*). This used to put every imported wheel on the
 // three-rung ladder, on the premise stated in the header — every FC
 // wheel is the same wheel, so anything off the ladder is arithmetic —
 // and that premise is simply false for a hand-authored level: FC's XML
 // carries a `<width>` per wheel and its level authors use it.
 //
 // Snapping a 450 to r 40 never changed the PHYSICS, which is what hid
 // it: the body, the four spokes and the motor all come off the SHELL
 // (sim.js `_wheelShellOf`, `_planJoints`), which kept the source
 // radius. It changed everything else. The renderer draws `part.r`, so
 // a wheel 450 units across drew as an 80-unit disc spinning inside its
 // own footprint; the editor's pin lattice sat on the drawn rim, five
 // wheels in from the real one; and the transpiler resolves a
 // hand-built stick's joints against `spokes(p.x, p.y, p.r)`
 // (fcworld.js `nodesOfPart`), so a stick bolted to the big wheel's rim
 // named nothing. One number, wrong in three places, and right in the
 // one place anybody had measured.
 //
 // The ladder still absorbs the ARITHMETIC, and only that: a rung
 // within `LADDER_EPS` of the scaled radius wins, which is the same
 // 0.05 this line already used to decide whether the snap was worth
 // warning about. At the shipped scale FC's own 40-unit wheel is r 20
 // to the bit, so every level already imported comes out identical —
 // what moves is exactly the set that used to warn.
 //
 // What it does NOT buy: a radius off the ladder is not a wheel anybody
 // can BUILD (§4 — the toolbar has three sizes and a placed wheel is
 // resized along them). The level may contain one, an import may hand
 // the Test tab one, and the warning below says so.
 const raw = (p.rSrc ?? FC_WHEEL_R) * scale;
 const rung = snapWheelR(raw);
 const onLadder = Math.abs(rung - raw) <= LADDER_EPS;
 if (!onLadder) offLadder.push(round4(clampBallR(raw)));
 // clampBallR, not a wheel floor of its own: a wheel and a goal ball are
 // the same round piece to the pin lattice and to the editor, and 2 px is
 // where that family bottoms out (sizes.js).
 const r = onLadder ? rung : round4(clampBallR(raw));
 return { t: 'wheel', kind: p.kind, ...at(p), r, id, ...(att ? { att } : {}), ...shellAt(p) };
 }
 const a = at({ x: p.x1, y: p.y1 }), b = at({ x: p.x2, y: p.y2 });
 // `weight` rides along, or gold arrives as an ordinary wood stick — this
 // rebuild is the last place a field can be silently dropped, and the one
 // it dropped was the whole difference between a counterweight and a
 // twig. Spread rather than named one-by-one so the next field to be added
 // upstream does not have to remember this line exists.
 return { t: 'rod', kind: p.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
 ...(p.weight ? { weight: p.weight } : {}), id, ...(att ? { att } : {}), ...shellAt(p) };
 });
 const fixedParts = convertParts(parts, 'fc');
 const design = convertParts(playerParts, 'fcp');
 // …and the other anchor family: a wheel the source drew with no radius. It
 // stays a wheel — the manifests count it and the C loader builds fcsim's own
 // zero-radius body for it — but LIFIRIK cannot store a piece of no size
 // (badMachinePart wants r > 0), so it lands on the round floor of 2 px and
 // would have mass and fall. The pin is what holds it, exactly as FC's own
 // masslessness does.
 for (const p of [...parts, ...playerParts, ...goalWheels]) {
 if (p.t === 'wheel' && p.rSrc === 0) pinAt(at(p));
 }

 // **What the build area claimed**, said first, because it is the one warning
 // about pieces that are not in the level — everything below is about pieces
 // that are.
 if (design.length) {
 warnings.push(`${plural(design.length, 'machine part', 'machine parts')} sat wholly inside the build area, so ${design.length === 1 ? 'it came in as the PLAYER\'s piece' : 'they came in as the PLAYER\'s pieces'} — on the Test tab, exactly as if you had built ${design.length === 1 ? 'it' : 'them'} — rather than as part of the level. The build area is where a player builds, so what is inside it was built rather than authored. Press Reset on the Test tab to clear the lot and solve the level from scratch.`);
 }
 // **The source said what is bolted to what**, so say so — this is the one
 // thing that stops a pile of identical sticks welding into a lump, and it is
 // invisible on screen: the machine simply behaves.
 if (declaresJoints) {
 const declared = [...fixedParts, ...design].filter(p => p.att);
 const free = declared.reduce((n, p) => n + p.att.filter(a => a === null).length, 0);
 warnings.push(`The paste says which pieces are bolted together (the \`[…]\` lists), so that is what was built: ${plural(declared.length, 'part', 'parts')} carry their own joints and ${plural(free, 'end is', 'ends are')} left FREE even where something is sitting exactly on them. Nothing was moved to make that work — the pieces are where the source put them, to the last decimal. Sticks piled on one spot are how a weight is made in a game with no weight dial; LIFIRIK's own answer is the density dial on one stick (up to ×${ROD_WEIGHT_MAX}), which is worth knowing if you rebuild this by hand.`);
 }
 if (stacks.stacked) {
 warnings.push(`${plural(stacks.stacked, 'stick', 'sticks')} came in stacked, in ${plural(stacks.piles, 'pile', 'piles')} (the biggest is ${stacks.biggest}) — which is how a weight is made in a game with no weight dial. All of them are here and all of them move: a pile is pinned at the end that carries on into the machine and its free ends FAN, so those ends have been spread by a tenth of a pixel each, the least that is a separate joint. Left exactly stacked they would share both ends, pin themselves together hundreds of times over, and the machine would not swing at all. LIFIRIK's own answer to a weight is the density dial on one stick (up to ×${ROD_WEIGHT_MAX}), which is worth knowing if you rebuild this by hand.`);
 }
 if (propsInBuild) {
 warnings.push(`${plural(propsInBuild, 'loose piece', 'loose pieces')} also sat inside the build area but stayed in the LEVEL: a player's machine is sticks, wheels and pins, and a loose crate or ball is none of those, so there is nothing for one to become. Delete ${propsInBuild === 1 ? 'it' : 'them'} in the Maker if ${propsInBuild === 1 ? 'it was' : 'they were'} part of somebody's solve.`);
 }
 if (fixedParts.length) {
 warnings.push(`The source's machine came across as the LEVEL's own (${plural(fixedParts.length, 'part', 'parts')}): it is built and running the moment anyone presses Play, motors and all, and it counts for nothing in the piece and weight stats. ${design.length ? 'These are the parts that reach OUTSIDE the build area, so they were authored rather than built.' : 'Delete it in the Maker if the level is meant to be solved from scratch.'}`);
 }
 if (assumedWater.length) {
 // Named values, deduped and in the order they appeared: "3 rods" says how
 // much of the machine is a guess, and "2, 5" is the thing that tells you
 // the mapping needs changing. Four is plenty to see a pattern.
 const seen = [...new Set(assumedWater)];
 const shown = seen.slice(0, 4).map(v => `"${clip(v, 12) || '(blank)'}"`).join(', ');
 warnings.push(`${plural(assumedWater.length, 'rod', 'rods')} had a material I don't know (${shown}${seen.length > 4 ? ', …' : ''}) and came in as WATER — 0 is water, 1 is wood, 2 is gold (a wood stick at ×${GOLD_WEIGHT}) and 3 is ghost. Anything else is a guess, and water sticks pass through wheels, other sticks and goal pieces, so check the blue ones are the blue ones before publishing.`);
 }
 if (absoluteNodes) {
 warnings.push(`${plural(absoluteNodes, 'joint reference', 'joint references')} in the machine ${absoluteNodes === 1 ? 'was' : 'were'} positive; the format counts BACK in entries (-1 is the entry above), so ${absoluteNodes === 1 ? 'it was' : 'they were'} read as a 1-based entry number instead. Check those sticks landed where you expect.`);
 }
 if (offLadder.length) {
 // Named radii, deduped, biggest first: "one wheel at r225" is the whole
 // story on a level built around a giant drive, and a list of four is what
 // says the source was drawn off a different base entirely.
 const seen = [...new Set(offLadder)].sort((a, b) => b - a);
 const shown = seen.slice(0, 4).map(v => 'r' + v).join(', ');
 warnings.push(`${plural(offLadder.length, 'wheel', 'wheels')} came out at a size LIFIRIK's toolbar doesn't have (${shown}${seen.length > 4 ? ', …' : ''}) and ${offLadder.length === 1 ? 'kept it' : 'kept them'} — that is the size the source drew, and it is what the wheel already turned at, so anything less would be drawing one wheel and simulating another. A wheel that size can't be BUILT: the toolbar has three (r ${WHEEL_SIZES.join(' / ')} px) and scrolling a selected wheel steps along them, so deleting this one is a one-way door.`);
 }
 if (fcPins.length) {
 warnings.push(`${plural(fcPins.length, 'machine block', 'machine blocks')} in the source had no size at all — a 0×0 rect, a wheel of no radius — and ${fcPins.length === 1 ? 'that is' : 'those are'} how FC bolts things to the BACKGROUND: a body with no mass never moves, so anything jointed to it is nailed down. LIFIRIK says the same thing with a loose pin, and ${fcPins.length === 1 ? 'one is' : `${fcPins.length} are`} placed on ${fcPins.length === 1 ? 'that point' : 'those points'}. Move one in the Maker and you unbolt whatever was hanging on it.`);
 }
 if (masslessProps) {
 warnings.push(`${plural(masslessProps, 'dynamic piece', 'dynamic pieces')} had no area (a width or height of 0) and came in as TERRAIN: FC's engine gives a zero-area body no mass and a massless body never moves, which is how its level authors draw invisible platforms and walls. ${masslessProps === 1 ? 'It draws' : 'They draw'} at stick thickness and ${masslessProps === 1 ? 'stays' : 'stay'} put, exactly as at home.`);
 }
 if (triZones.length) {
 warnings.push(`${plural(triZones.length, 'zone', 'zones')} in the source ${triZones.length === 1 ? 'was' : 'were'} not a rectangle (${[...new Set(triZones)].join(', ')}) and came in as the rectangle each is drawn inside. LIFIRIK zones are rectangles, so the corners are now part of the area — reshape it in the Maker if that gives the player somewhere they shouldn't be.`);
 }
 if (namedThick.length) {
 // The names and the thicknesses are two statements of the same fact, so a
 // disagreement means one of the two readings is wrong — and it is worth
 // saying which one won rather than silently picking.
 warnings.push(`${plural(namedThick.length, 'beam', 'beams')} named one material and measured the other (${[...new Set(namedThick)].slice(0, 4).join(', ')}); the THICKNESS won — 4 is water, 8 is wood.`);
 }
 if (snapped) {
 warnings.push(`${plural(snapped, 'end', 'ends')} moved by up to ${SNAP_TOL} source units onto the part they say they are joined to. Sharing an exact coordinate is what makes a joint in LIFIRIK (§5.4), and the source states each end separately, so this is the rounding between them being closed.`);
 }
 if (farDeps.length) {
 warnings.push(`${plural(farDeps.length, 'connection', 'connections')} named in the source ${farDeps.length === 1 ? 'is' : 'are'} too far apart to be a joint and ${farDeps.length === 1 ? 'was' : 'were'} left alone (${farDeps.slice(0, 3).join('; ')}${farDeps.length > 3 ? '; …' : ''}). If there are a lot of these, the angles or the lengths are being read wrong rather than the level being loose.`);
 }
 if (badDeps.length) {
 warnings.push(`${plural(badDeps.length, 'connection', 'connections')} named an id nothing in the paste defines (${badDeps.slice(0, 4).join(', ')}${badDeps.length > 4 ? ', …' : ''}) — a dependency can only name an entity ABOVE it.`);
 }
 // Only the LONG form's pins get this, not the code format's `J`. A `J` is
 // documented as a bare point and nobody expects one to hold anything up; a
 // `PlacedPin` is named "pin" and described as an anchor, so it is worth
 // saying out loud that it anchors nothing here.
 if (pins) {
 warnings.push(`${plural(pins, 'pin', 'pins')} came in as ${pins === 1 ? 'a plain junction' : 'plain junctions'}: LIFIRIK has no joint object, so anything that met there is bolted by sharing the coordinate and the pin itself stores nothing. If one of them was meant to bolt the machine to the BACKGROUND, place a loose pin there in the Maker — that is the piece that does it.`);
 }
 // Only the surprising reading is worth a warning. Degrees is what this
 // importer has always meant by an angle, and the screen shows the unit on
 // every import anyway — a line saying "these are degrees" on every rotated
 // level is noise that teaches nothing.
 if (rawAnglesSeen && !angleDeclared && angleUnit === 'rad') {
 warnings.push('Angles were read as RADIANS: the paste didn\'t say, and every one of them is inside ±2π and finely fractional, which degrees are not written as. If the level came out on its side, that is the field to check.');
 }

 if (grown) {
 warnings.push(`${plural(grown, 'piece', 'pieces')} came out under the smallest a LIFIRIK piece can be (${MIN_AXIS} px per side and ${MIN_AREA} px² of area, or ${MIN_BALL_R} px radius for a ball) and ${grown === 1 ? 'was' : 'were'} grown to it — a zero-thickness plank becomes a ${MIN_AXIS} px blade.`);
 }
 if (squashedBalls) {
 warnings.push(`${plural(squashedBalls, 'circle', 'circles')} had a width and height that disagreed; the larger became the diameter.`);
 }
 if (unrotatedGoals) {
 warnings.push(`${plural(unrotatedGoals, 'goal piece', 'goal pieces')} lost its rotation — goal pieces always spawn axis-aligned in LIFIRIK.`);
 }

 // ---- caps (§11.2) ----

 // Goal pieces past the cap stay in the level as ordinary props rather than
 // vanishing: the puzzle changes either way, but the level keeps its mass and
 // its obstacles instead of developing holes.
 if (goalObjs.length > CAP.goalObjs) {
 const extra = goalObjs.splice(CAP.goalObjs);
 for (const g of extra) props.push({ shape: g.shape, x: g.x, y: g.y, ...(g.r != null ? { r: g.r } : { w: g.w, h: g.h, radius: g.radius }) });
 warnings.push(`LIFIRIK allows ${CAP.goalObjs} goal pieces; the other ${extra.length} became ordinary props (they still fall and get in the way, they just don't need delivering).`);
 }
 // The player's design is capped by the same number from the other side —
 // `MAX_DESIGN_PARTS` in game.js is 1000 too, and the Maker would refuse to
 // add the 1001st, so an import that handed it more would be handing it a
 // board it cannot edit.
 for (const [list, key, what] of [[terrain, 'terrain', 'terrain pieces'], [props, 'props', 'props'], [buildZones, 'buildZones', 'build zones'], [goalZones, 'goalZones', 'goal zones'], [fixedParts, 'fixedParts', 'machine parts'], [design, 'fixedParts', 'parts of the player\'s machine'], [fcPins, 'pins', 'anchor pins']]) {
 if (list.length > CAP[key]) {
 const dropped = list.length - CAP[key];
 list.length = CAP[key];
 warnings.push(`Dropped ${plural(dropped, what.replace(/s$/, ''), what)} past LIFIRIK's cap of ${CAP[key]}.`);
 }
 }

 // ---- fallbacks for what the source never had ----

 const goalCentre = unionBounds(goalObjs, o => entryBounds({
 shape: o.r != null ? 'ball' : 'box', x: o.x, y: o.y,
 w: o.r != null ? o.r * 2 : o.w, h: o.r != null ? o.r * 2 : o.h, rad: 0,
 }));
 // fixedParts are in here so a paste that is ONLY a machine still frames its
 // placeholders somewhere sensible — the alternative is the ±100 fallback,
 // i.e. a goal zone parked on top of the machine it should be across from.
 const all = unionBounds([...terrain, ...props, ...goalObjs, ...buildZones, ...goalZones, ...fixedParts], o => (o.t ? partBounds(o) : entryBounds({
 shape: o.r != null ? 'ball' : 'box', x: o.x, y: o.y,
 w: o.r != null ? o.r * 2 : o.w, h: o.r != null ? o.r * 2 : o.h,
 rad: o.angle || 0,
 }))) || { minX: -100, minY: -100, maxX: 100, maxY: 100, w: 200, h: 200 };

 // **No goal piece is NOT invented any more** (2026-08-18, on
 // 12283303: "battle bot levels — someone builds on the left, someone adds
 // to the saved solve on the right, the machines fight. No goal piece
 // required."). The placeholder crate this used to park in the build area
 // was the importer misreading a fight as a delivery — and it desynced the
 // C world's manifest for every such design (28 in the sweep, tallied
 // "no-goal"). A level with no cargo is a sandbox: the server accepts it,
 // it plays, it never wins, and a run on it saves as an attempt. Said in a
 // warning so nobody hunts for the win condition.
 if (!goalObjs.length) {
 warnings.push('The source has no goal piece — this is a sandbox (a battle-bot arena, say): it plays, but there is nothing to deliver and no run on it counts as a win. Add a goal piece in the Maker if it wants one.');
 }
 if (!buildZones.length) {
 const g = goalCentre || all;
 buildZones.push({ x: round4(g.minX + g.w / 2), y: round4(g.minY + g.h / 2), w: 200, h: 150 });
 warnings.push('The source had no build area, so a 200×150 px one was placed over the goal pieces — reposition it in the Level Maker.');
 }
 if (!goalZones.length) {
 goalZones.push({ x: round4(all.maxX - Math.min(120, all.w * 0.15)), y: round4(all.minY + all.h / 2), w: 120, h: 104 });
 warnings.push('The source had no goal area, so a placeholder 120×104 px goal zone was parked at the right-hand edge — move it onto real ground before publishing.');
 }

 const level = {
 // The screen's own box wins, then the paste's `@name` header, then the
 // fallback — a person who typed a name meant it, and a paste that carried
 // one still beats "Imported Level".
 name: String(opts.name || parsed.declaredName || '').trim().slice(0, 60) || 'Imported Level',
 desc: String(opts.desc || parsed.declaredDesc || '').trim().slice(0, 400),
 terrain, props, fixedParts, groups: {},
 buildZones, goalZones, goalObjs,
 win: 'goalObj',
 };
 if (background) level.background = background;
 // Omitted entirely when the source had no anchors, so an ordinary import
 // carries no empty key — the same way `texts` and `backLevel` are handled.
 if (fcPins.length) level.pins = fcPins;

 // **THE SOURCE WORLD, for the C loader** (2026-08-17). A declared paste at
 // scale 1 carries its FC XML — TRANSPILED from the paste at the STRING
 // level, digit-for-digit — so the sim can hand it to fcsim's own
 // xml/graph/gen inside the engine and the machine replays bit-exactly.
 // The drawn level above is the SAME world shifted by (dx, dy); the sim
 // adds that shift back at the pose boundary, so physics runs in FC's frame
 // while the screen keeps LIFIRIK's.
 //
 // STRINGS, not doubles, and that is the whole point: a number that
 // round-trips through a JS double comes back one ulp away from what
 // fcsim's fp_strtod reads off the same digits, and a degenerate stack
 // impact turns that bit into a fork. The paste's own characters go into
 // the XML verbatim and only fp_strtod ever parses them.
 //
 // Goal BALLS stay off this path (fcsim's graph has no jointed circle) —
 // the JS build carries those levels instead.
 if (declaresJoints && scale === 1 && !entries.some(e => e.role === 'goal' && e.shape === 'ball')) {
 const t = fcPasteToXml(text);
 // **The manifests must AGREE with the converted level, or no C world at
 // all** (2026-08-17, the vanished import): a transpiled world with one
 // block more or fewer than the level maps every rec after the hole onto
 // the wrong body, and the run plays invisibly somewhere else. A count
 // mismatch means the two parsers disagreed about the paste, and the JS
 // build — which drew the level the player is looking at — is the one to
 // trust.
 const agrees = t
 && t.levels.filter(b => !b.dynamic).length === terrain.length
 && t.levels.filter(b => b.dynamic).length === props.length
 && t.players.filter(b => b.t === 4 || b.goal).length === goalObjs.length
 && t.players.filter(b => b.t !== 4 && !b.goal).length
 === [...fixedParts, ...design].filter(p => p.t === 'wheel' || p.t === 'rod').length;
 if (agrees) {
 level.fcWorld = {
 dx: ox * scale, dy: oy * scale,
 xml: t.xml,
 players: t.players,
 levels: t.levels,
 // the machine's fingerprint: the sim compares it before taking the C
 // path, so an edited machine honestly falls back to the JS build
 print: fcMachinePrint(fixedParts, design),
 };
 }
 }

 const extent = levelExtent(level);
 return {
 level,
 // **The player's own machine, beside the level rather than inside it.** It
 // is the design shape `design.parts` holds and the Test tab edits (§8.2) —
 // the import screen writes it into the new draft's `autosave.draft.<id>`
 // slot, which is the same door "Take this level into the Maker" already
 // carries a half-built machine through. Empty for a paste with no solve in
 // its build area, so a caller can hand it straight on without asking.
 design,
 warnings,
 stats: {
 scale,
 // `parsed` is everything the paste yielded, machine included — it is what
 // both callers test before saying "nothing usable in there", and a paste
 // of nothing but a solution is a perfectly usable thing to import.
 // Counted BEFORE the build area takes its share, or a paste that is
 // nothing but a solve would report "nothing usable in there" and be
 // refused, when what really happened is that it was all read and all
 // recognised as a solve.
 parsed: parsed.entries.length + parsed.parts.length,
 skipped: errors.length,
 terrain: terrain.length,
 props: props.length,
 goalObjs: goalObjs.length,
 buildZones: buildZones.length,
 goalZones: goalZones.length,
 joints: joints.length,
 // The MACHINE the paste had, both pools together — the screen's "12
 // wheels · 30 sticks" is about what came across, and it would be a lie
 // that read differently depending on where a level's build area happened
 // to be drawn. The split is the two counts under it.
 wheels: [...fixedParts, ...design].filter(p => p.t === 'wheel').length,
 rods: [...fixedParts, ...design].filter(p => p.t === 'rod').length,
 fixedParts: fixedParts.length,
 // …and the player's, which is the number worth showing: a level that came
 // in already solved should say so on the page and not only in a warning.
 designParts: design.length,
 // The one case the build-area rule could not honour (see `propsInBuild`).
 propsInBuild,
 // Which way the one ambiguous field was read, and whether that was the
 // paste's word or ours — the screen shows it, because it is the setting
 // most likely to be wrong and the least likely to be noticed.
 angleUnit: rawAnglesSeen ? angleUnit : null,
 angleDeclared,
 // **Every code the letter rule had to guess at, with what it guessed.**
 // The screen turns this into one row per code with a texture selector
 // beside it — a guess you can see and overrule beats a guess reported in
 // a sentence after the fact. Counted so the busiest code is at the top,
 // because that is the one worth getting right.
 letterCodes: [...new Set(lettered)]
 .map(c => ({ code: c, n: lettered.filter(x => x === c).length, texture: (opts.letterTextures || {})[c] || textureForLetter(c[0]) }))
 .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
 offset: { x: round4(ox * scale), y: round4(oy * scale) },
 suggestedScale: suggestScale(entries),
 extent: extent && {
 w: round4(extent.w), h: round4(extent.h),
 metresW: round4(extent.w / 30), metresH: round4(extent.h / 30),
 },
 },
 };
}

// The data half of a converted level — exactly what POST /api/levels wants,
// with name/desc kept out of it (§11.2).
export function levelData(level) {
 const d = {
 terrain: level.terrain, props: level.props,
 fixedParts: level.fixedParts || [], groups: level.groups || {},
 buildZones: level.buildZones, goalZones: level.goalZones,
 goalObjs: level.goalObjs, win: level.win || 'goalObj',
 };
 if (level.background) d.background = level.background;
 return d;
}
