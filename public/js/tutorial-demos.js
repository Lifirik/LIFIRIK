// tutorial-demos.js — the machines the /learn page runs live (§18).
//
// One module, two consumers: the tutorial page embeds these in canvases, and
// verify-tutorial.mjs PROVES they still win. That is the whole point of the
// split — a physics retune (wheel torque, friction, gravity) that breaks the
// tutorial's own machines should fail a gate, not quietly turn the "watch it
// work" page into a "watch it fail" page. Determinism (§5.8) is what makes a
// live demo loop identical on every visit.
//
// Coordinates were not designed, they were ITERATED — see the dead ends
// recorded in verify-tutorial.mjs. Tune them there, where the proof runs.

// The cart: two powered wheels and one stick between the hubs — the smallest
// machine that does something. It drives right and rolls the goal ball into a
// walled pocket inside the goal zone.
export const CART_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 30, w: 1400, h: 60, texture: 'grass' },
    // the pocket wall: the shove only has to ROLL the ball in; without it the
    // cart climbs over the ball at full torque and drives off with the ball
    // dribbling to a stop a few px short of "fully inside"
    { type: 'box', x: 322, y: -35, w: 24, h: 70, texture: 'granite' },
  ],
  props: [],
  buildZones: [{ x: -230, y: -70, w: 260, h: 140 }],
  goalZones: [{ x: 250, y: -40, w: 110, h: 80 }],
  // **The ball starts at 140, not 120** (2026-08-24, the fcsim re-authoring).
  // Rolling resistance died with the engine cut, so a ball the shove leaves
  // short of the pocket rolls back out of everything forever; at 120 the cart's
  // push gave out at x=177 and the ball wandered home. Swept 140/170/200/230:
  // every one wins, 140 keeps the longest drive on screen (t=5.23 s).
  goalObjs: [{ shape: 'ball', x: 140, y: -15, r: 15 }],
  win: 'goalObj',
};
export const CART_DESIGN = { parts: [
  { t: 'wheel', kind: 'cw', x: -260, y: -15, r: 15, id: 'c1' },
  { t: 'wheel', kind: 'cw', x: -180, y: -15, r: 15, id: 'c2' },
  { t: 'rod', kind: 'wood', x1: -260, y1: -15, x2: -180, y2: -15, id: 'c3' },
] };

// The catapult: a counterweight trebuchet, from a design the play-tester
// built in the Maker. An A-frame stand, a lever balanced across its apex, two
// max-weight sticks as the counterweight on the raised end, and the goal crate
// sitting on the ground in front of the low end. Drop the counterweight, the
// low end sweeps up, and the crate is thrown 415 px downrange with 134 px of
// air. Six pieces, no motors — every force in it is gravity.
//
// It replaced a two-piece stomp-seesaw because this is the machine people
// actually want to build: it has a STAND, and the counterweight teaches that
// a heavy stick is a tool and not just a wall.
//
// Design notes, learned by sweeping (see the dead ends recorded in
// verify-tutorial.mjs):
//  - the lever must be TILTED, counterweight end high and throwing end low. A
//    level lever throws the payload straight up and it lands where it started;
//  - the payload sits on the GROUND in front of the low end, not on the lever.
//    A flat rod has no cup, so a payload placed on it just slides off;
//  - the apex sits under the lever's balance point: at x = -150 a straight rod
//    from (-250, -112) to (-50, -20) passes within a pixel of the apex, which
//    is what lets it pivot instead of toppling.
export const CATAPULT_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 30, w: 1400, h: 60, texture: 'grass' },
    // Backstop. Without it the crate clips the goal zone in passing, wins on
    // the way through and then sails off the world — technically a solve, and
    // it looks like a miss. With it the crate lands and STAYS, which is what
    // a delivery should look like on the page that teaches what one is.
    { type: 'box', x: 400, y: -55, w: 20, h: 110, texture: 'granite' },
  ],
  props: [],
  buildZones: [{ x: -150, y: -130, w: 460, h: 280 }],
  goalZones: [{ x: 320, y: -52, w: 170, h: 104 }],
  // **The crate sits ABOVE the lever's free end, not on the ground past it**
  // (fixed 2026-08-12). Parked on the ground at (-40,-15) it simply
  // rolled clear before the counterweight had done anything, which no amount of
  // counterweight repaired: across 105 legal weight-and-position variants, none
  // won at all. Seated over the arm it works at the first ask, because the
  // crate FALLS the last 35 px onto an end that is already swinging up to meet
  // it — the drop and the throw are the same movement.
  goalObjs: [{ shape: 'box', x: -65.52, y: -87.94, w: 26, h: 26 }],
  win: 'goalObj',
};
export const CATAPULT_DESIGN = { parts: [
  // the A-frame stand
  { t: 'rod', kind: 'wood', x1: -150, y1: -72, x2: -192, y2: -1, id: 'legL' },
  { t: 'rod', kind: 'wood', x1: -150, y1: -72, x2: -108, y2: -1, id: 'legR' },
  { t: 'rod', kind: 'wood', x1: -192, y1: -1, x2: -108, y2: -1, id: 'base' },
  // the throwing arm, balanced across the apex
  { t: 'rod', kind: 'wood', x1: -240, y1: -120, x2: -40, y2: -28, id: 'lever' },
  // **ONE stick at x36** (2026-08-24, the fcsim re-authoring; was x20). On
  // fcsim ballistics x20 under-throws (the crate lands 109 px out, on the
  // ground) and heavier is not simply better: the sweep 24..56 in steps of 4
  // shows a knife-edge — 32 falls short, 40 whips the crate off to the LEFT —
  // with exactly one clean delivery at 36 (t=6.47 s, apex −368, crate resting
  // at (260, −13) inside the 320±85 zone). Deterministic physics is what
  // makes a knife-edge livable: it replays identically, and gate 2 holds it.
  { t: 'rod', kind: 'wood', x1: -260, y1: -210, x2: -190, y2: -210, id: 'cwA', weight: 36 },
] };

// ---------- the contrast pair: ends that meet, join ----------
//
// The one rule the whole game rests on, taught the only way it can be TOLD in
// one glance: the same three sticks twice, and the only difference is whether
// their ends touch.
//
// Two earlier versions of this contrast were built and thrown away, both
// because measurement said the lesson would have been a LIE (see
// verify-tutorial.mjs):
//  - an unjoined CART still wins. The stick falls off, but a lone powered
//    wheel just drives into the ball and shoves it in anyway;
//  - an unjoined CATAPULT wins at some gaps and not others — at 3 px the
//    collapsing stand happens to fling the crate into the zone. A demo that
//    depends on chaos is a demo that will one day teach the opposite.
// A loaded A-frame is decisive and dull about it: joined, it holds the plank
// up all day; unjoined, the legs scissor and everything ends flat.
// **The ball sits WELL clear of the goal zone**, and that is not decoration. A
// level needs a goal piece and a goal zone to be a legal level, and the first
// cut of this one had the ball parked inside the zone — so the sim won on frame
// one and the page drew "★ Solved!" across a heap of collapsed sticks, on the
// step whose whole job is to show that heap failing. Gate 6 holds the rule for
// every demo: none of them may start already solved.
export const STAND_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 30, w: 900, h: 60, texture: 'grass' }],
  props: [],
  buildZones: [{ x: 0, y: -60, w: 260, h: 180 }],
  goalZones: [{ x: 380, y: -30, w: 80, h: 70 }],
  goalObjs: [{ shape: 'ball', x: 160, y: -15, r: 12 }],
  win: 'goalObj',
};

// apex (0,-84), feet (-52,-1) and (52,-1), a heavy plank resting across the top.
// `gap` pulls each stick in toward its own middle, so no end reaches another.
const standParts = (gap) => {
  const seg = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    return { x1: x1 + dx / L * gap, y1: y1 + dy / L * gap, x2: x2 - dx / L * gap, y2: y2 - dy / L * gap };
  };
  return [
    { t: 'rod', kind: 'wood', ...seg(0, -84, -52, -1), id: 'legL' },
    { t: 'rod', kind: 'wood', ...seg(0, -84, 52, -1), id: 'legR' },
    { t: 'rod', kind: 'wood', ...seg(-52, -1, 52, -1), id: 'base' },
    // **weight 20, down from 50** (2026-08-24): fcsim joints TEAR under load,
    // and a x50 plank tears the apex pin out of its own stand — the joined
    // frame collapsed to y=−40 and the lesson read backwards. Swept 50/20/15/
    // 10/5/1: 20 and under all hold (y≈−92.5); the loose frame still drops it
    // (y=−19) at 20, so the contrast survives intact.
    { t: 'rod', kind: 'wood', x1: -45, y1: -90, x2: 45, y2: -90, weight: 20, id: 'load' },
  ];
};
export const STAND_JOINED = { parts: standParts(0) };
export const STAND_LOOSE = { parts: standParts(4) };

// ---------- the three wheels ----------
//
// L, F, R as three lanes rather than three sentences. Same cart, same level,
// one letter different — and the numbers come out perfectly symmetric
// (−424 / 0 / +424 px in three seconds), which is the picture.
// Same rule as STAND_LEVEL: the ball is parked far off to the left, outside the
// zone and outside the picture, where neither the left-driving cart nor the
// right-driving one can reach it inside the loop. These three lanes are about
// which way a wheel goes, and a win banner in the corner would be answering a
// question nobody asked.
export const LANE_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 30, w: 1600, h: 60, texture: 'grass' }],
  props: [],
  buildZones: [{ x: 0, y: -40, w: 320, h: 120 }],
  goalZones: [{ x: 700, y: -30, w: 80, h: 70 }],
  goalObjs: [{ shape: 'ball', x: -720, y: -15, r: 12 }],
  win: 'goalObj',
};
export const laneCart = (kind) => ({ parts: [
  { t: 'wheel', kind, x: -40, y: -15, r: 15, id: 'a' },
  { t: 'wheel', kind, x: 40, y: -15, r: 15, id: 'b' },
  { t: 'rod', kind: 'wood', x1: -40, y1: -15, x2: 40, y2: -15, id: 'r' },
] });

// ---------- the skeleton of a level ----------
//
// What every level is made of and nothing else: somewhere to build (violet),
// somewhere to deliver (green), and a green thing. Drawn static, by the real
// renderer, for the step that says "now make one".
export const SKELETON_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 30, w: 700, h: 60, texture: 'grass' }],
  props: [],
  buildZones: [{ x: -170, y: -60, w: 200, h: 130 }],
  goalZones: [{ x: 190, y: -35, w: 130, h: 80 }],
  goalObjs: [{ shape: 'ball', x: 20, y: -15, r: 15 }],
  win: 'goalObj',
};

// ---------- the FC retraining demos (§18) ----------
//
// Each one is a difference an FC player would otherwise have to be TOLD, shown
// running instead. They are gated like every other demo on the pages: a claim
// the page makes about this engine is a claim `verify-tutorial.mjs` checks.

// **No axle, no power** (e08cb4a, 2026-08-24 — the rule this pair teaches).
// A cw/ccw wheel is a motor ONLY if something sits on its hub — a rod end
// or any pin (util.wheelHasAxle); a bare powered wheel free-rolls and goes nowhere.
// The demo is the contrast: the same wheel twice, and the only difference is
// one stick on the hub. Bare drifts 0 px in 8 s; axled wins at t=3.87 s.
// (This section used to claim the opposite — "a powered wheel needs nothing
// bolted to it" — which was true of the pre-fcsim motor and is not true now.)
export const SOLO_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 30, w: 1400, h: 60, texture: 'grass' },
    { type: 'box', x: 322, y: -35, w: 24, h: 70, texture: 'granite' }],
  props: [],
  buildZones: [{ x: -230, y: -70, w: 260, h: 140 }],
  goalZones: [{ x: 250, y: -40, w: 110, h: 80 }],
  goalObjs: [{ shape: 'ball', x: 120, y: -15, r: 15 }],
  win: 'goalObj',
};
export const SOLO_BARE = { parts: [{ t: 'wheel', kind: 'cw', x: -200, y: -15, r: 15, id: 'solo' }] };
export const SOLO_DESIGN = { parts: [
  { t: 'wheel', kind: 'cw', x: -200, y: -15, r: 15, id: 'solo' },
  { t: 'rod', kind: 'wood', x1: -200, y1: -15, x2: -140, y2: -15, id: 'axle' },
] };

// **The weight dial does real work** — a balance beam with the SAME stick each
// side, and only the right one's weight changed. At ×1 it sits dead level; at
// ×400 it slams. Measured: 0.0° against 180°. Nobody has to stack fifty of
// anything to make something heavy.
export const BEAM_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 120, w: 900, h: 60, texture: 'grass' },
    { type: 'box', x: 0, y: 30, w: 18, h: 120, texture: 'granite' }],   // pillar, top at y = −30
  props: [],
  buildZones: [{ x: 0, y: -120, w: 420, h: 260 }],
  // Both parked far off to the left, out of frame and out of reach. The heavy
  // beam slamming down knocked the ball into the zone and WON at 3.7 s, which
  // would have flashed "Solved!" over a demo that is not about winning at all
  // (the same trap gate 6 exists for).
  goalZones: [{ x: -1400, y: 60, w: 80, h: 70 }],
  goalObjs: [{ shape: 'ball', x: -700, y: 75, r: 12 }],
  win: 'goalObj',
};
const beamParts = (weight) => [
  { t: 'rod', kind: 'wood', x1: -110, y1: -36, x2: 110, y2: -36, id: 'beam' },
  { t: 'rod', kind: 'wood', x1: -108, y1: -44, x2: -60, y2: -44, id: 'left' },
  { t: 'rod', kind: 'wood', x1: 60, y1: -44, x2: 108, y2: -44, weight, id: 'right' },
];
export const BEAM_LIGHT = { parts: beamParts(1) };
// ×100, the dial's own ceiling (ROD_WEIGHT_MAX, sizes.js) — this was ×400,
// a number the dial has not reached since 2026-08-12, teaching a setting
// nobody can set. Measured: the beam slams to 69.4° at ×100, exactly as it
// did at ×400.
export const BEAM_HEAVY = { parts: beamParts(100) };

// **The ground is a material, not a colour** (§5.9). The same crate on the
// same tilted floor: mud holds it where it was put, ice lets it go.
//
// **Re-authored for fcsim, 2026-08-24.** The rolling-ball rig above relied on
// ROLLING RESISTANCE, and rolling resistance is DEAD on this engine (verify-
// surfaces gate 6 holds that door) — both floors read identical and the page
// lied. What fcsim expresses vividly is STATIC GRIP: the same crate on the
// same tilted floor — mud (grip 1.20) holds it exactly where it was put, ice
// (grip 0.06) lets it slide clean off the level. Swept 0.20/0.26/0.32 rad: at
// 0.20 even ice holds, at 0.26 the contrast is emphatic (mud moves 0.1 px in
// 8 s, ice is 1260 px away and still going).
export const GRIP_LEVEL = (texture) => ({
  terrain: [{ type: 'box', x: 0, y: 40, w: 760, h: 36, angle: 0.26, texture }],
  props: [],
  buildZones: [{ x: -500, y: -160, w: 100, h: 100 }],
  goalZones: [{ x: 1600, y: 300, w: 80, h: 70 }],    // far away: this demo never wins
  // resting ON the tilted surface: the slab top under x=-240, less the crate's
  // half-height, both in the slab's own lean
  goalObjs: [{ shape: 'box', x: -240, y: 22 - 240 * Math.tan(0.26) - 18, w: 26, h: 26, angle: 0.26 }],
  win: 'goalObj',
});
export const GRIP_SHOWN = ['mud', 'ice'];

// **A conveyor carries whatever touches it**, with nothing pushing. The crate
// starts at rest and travels −200 → +210 in five seconds on `tangentSpeed`
// alone. There is no machine in this level at all.
export const BELT_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 60, w: 620, h: 40, texture: 'belt' }],
  props: [],
  buildZones: [{ x: -260, y: -60, w: 110, h: 110 }],
  goalZones: [{ x: 1200, y: 0, w: 90, h: 76 }],    // far away: this demo never wins
  goalObjs: [{ shape: 'box', x: -200, y: 20, w: 28, h: 28 }],
  win: 'goalObj',
};

// **Even the goal can move.** A goal zone is a group rider with its own motion
// record (§9.3), so the place you have to deliver to need not sit still.
export const MOVER_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 30, w: 1000, h: 60, texture: 'grass' }],
  props: [],
  buildZones: [{ x: -260, y: -70, w: 220, h: 140 }],
  goalZones: [{ x: 120, y: -46, w: 120, h: 92,
    path: { pts: [{ x: 120, y: -46 }, { x: 300, y: -46 }], mode: 'pingpong', speed: 70 } }],
  // ball at 40, was −20 (2026-08-24): with rolling resistance dead a shove
  // that leaves the ball short of the zone leaves it wandering backward for
  // good — at −20 the cart's push gave out at x=28. From 40 it wins at 5.60 s.
  goalObjs: [{ shape: 'ball', x: 40, y: -15, r: 14 }],
  win: 'goalObj',
};
export const MOVER_DESIGN = { parts: [
  { t: 'wheel', kind: 'cw', x: -220, y: -15, r: 15, id: 'm1' },
  { t: 'wheel', kind: 'cw', x: -140, y: -15, r: 15, id: 'm2' },
  { t: 'rod', kind: 'wood', x1: -220, y1: -15, x2: -140, y2: -15, id: 'm3' },
] };

// **More than one of each zone is allowed** — up to eight (§11.1). Static, for
// the picture that says so.
//
// **Both green things REST on something**, and the shelf under the upper build
// zone is there for that reason (2026-08-10). They used to hang in mid-air —
// 16 px and 129 px above anything — which is legal level design and a poor
// PICTURE: a still is drawn at the authored poses, so a floating crate draws
// as well as a standing one and reads as a mistake nobody made. Gate 7c holds
// the rule now.
export const TWO_ZONE_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 40, w: 800, h: 60, texture: 'grass' },
    { type: 'box', x: 60, y: -60, w: 240, h: 20, texture: 'granite' },
    { type: 'box', x: -195, y: -131, w: 200, h: 18, texture: 'granite' }],
  props: [],
  buildZones: [{ x: -230, y: -50, w: 170, h: 120 }, { x: -230, y: -190, w: 170, h: 100 }],
  goalZones: [{ x: 130, y: -100, w: 110, h: 60 }, { x: 300, y: -30, w: 110, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -150, y: -4, r: 14 }, { shape: 'box', x: -150, y: -153, w: 26, h: 26 }],
  win: 'goalObj',
};

// ---------- the Level Maker guide (§18) ----------
//
// **The authoring chapter's examples, as real levels.** Every picture on that
// chapter is one of these drawn by `renderPreview` — the game's own renderer,
// the same one that draws a level card — rather than a screenshot, so a piece
// that changes how it looks changes here too and none of them can rot into a
// picture of a game this is not. The three that MOVE run a real `Simulation`
// and are gated beside every other demo (`DEMO_CLAIMS`).
//
// They are also meant to be READ as levels: each is a small, sane, buildable
// thing rather than a diagram of one, because the chapter's job is to make
// somebody want to open the Maker.

// **The build zone is the difficulty dial.** Same level, same goal, same ball:
// one has a roomy build area right beside the work, the other a small one
// across the map. Nothing else differs, which is the whole lesson.
const zoneLevel = (build) => ({
  terrain: [
    { type: 'box', x: 0, y: 60, w: 1100, h: 60, texture: 'grass' },
    { type: 'box', x: 130, y: -10, w: 24, h: 80, texture: 'granite' },
  ],
  props: [],
  buildZones: [build],
  goalZones: [{ x: 300, y: -10, w: 130, h: 90 }],
  goalObjs: [{ shape: 'ball', x: 0, y: 15, r: 15 }],
  win: 'goalObj',
});
export const ZONE_ROOMY = zoneLevel({ x: -170, y: -35, w: 320, h: 170 });
export const ZONE_TIGHT = zoneLevel({ x: -400, y: -5, w: 120, h: 110 });

// **The green things.** Three goal pieces and two goal zones in one picture: a
// ball, a crate, and the same crate at ×4 density — which draws darker, so
// "heavier" is something the picture says without a caption.
export const GOALS_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 60, w: 820, h: 60, texture: 'grass' }],
  props: [],
  buildZones: [{ x: -260, y: -25, w: 190, h: 150 }],
  goalZones: [{ x: 130, y: -12, w: 120, h: 96 }, { x: 285, y: -12, w: 110, h: 96 }],
  goalObjs: [
    { shape: 'ball', x: -100, y: 15, r: 15 },
    { shape: 'box', x: -40, y: 16, w: 28, h: 28 },
    { shape: 'box', x: 20, y: 16, w: 28, h: 28, density: 4 },
  ],
  win: 'goalObj',
};

// **The ground is a thing you design.** One of each terrain kind in one scene:
// a painted sand hill, a granite boulder, an ice ramp, a conveyor and a brick
// wall, all sitting on a grass floor.
export const TERRAIN_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 70, w: 1100, h: 60, texture: 'grass' },
    // A painted outline: absolute vertices, the last one duplicating the
    // origin to close the loop (§11.1). Explicit zero handles keep the edges
    // straight — an unset handle is the auto Catmull-Rom tangent, which bows
    // every edge outward and turns a drawn ridge into a blob.
    { type: 'paint', texture: 'sand', x: -350, y: 40, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 },
      pts: [
        { x: -300, y: -8, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } },
        { x: -250, y: -36, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } },
        { x: -196, y: -6, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } },
        { x: -160, y: 40, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } },
        { x: -350, y: 40, h1: { x: 0, y: 0 }, h2: { x: 0, y: 0 } },
      ] },
    { type: 'ball', x: -80, y: 6, r: 34, texture: 'granite' },
    { type: 'box', x: 90, y: -6, w: 200, h: 16, angle: 0.34, texture: 'ice' },
    { type: 'box', x: 270, y: 26, w: 190, h: 18, texture: 'belt' },
    { type: 'box', x: 400, y: -30, w: 26, h: 80, texture: 'brick' },
  ],
  props: [],
  buildZones: [{ x: -470, y: -30, w: 120, h: 120 }],
  goalZones: [{ x: 470, y: 0, w: 100, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -430, y: 26, r: 14 }],
  win: 'goalObj',
};

// **Props are loose things the machine can shove**, and their density is on
// the picture: the stack is standard, the ball is ×4 (dark), the big crate is
// ×0.25 (pale) and weighs less than the small ones under it.
export const PROPS_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 60, w: 820, h: 60, texture: 'grass' }],
  props: [
    { shape: 'box', x: -70, y: 15, w: 30, h: 30 },
    { shape: 'box', x: -70, y: -15, w: 30, h: 30 },
    { shape: 'box', x: -70, y: -45, w: 30, h: 30 },
    { shape: 'ball', x: 40, y: 8, r: 22, density: 4 },
    { shape: 'box', x: 160, y: 8, w: 44, h: 44, density: 0.25 },
  ],
  buildZones: [{ x: -260, y: -25, w: 150, h: 130 }],
  goalZones: [{ x: 300, y: -10, w: 110, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -240, y: 16, r: 14 }],
  win: 'goalObj',
};

// **A pin is a hinge.** A plank prop pinned through its middle, a heavy ball
// dropped on one end, a crate sitting on the other — a see-saw with no machine
// in it at all. Nothing here is the player's; it is what the LEVEL does on its
// own the moment Play is pressed.
//
// **There is deliberately no post under the plank**, and that was measured
// rather than chosen: anything solid beneath a pinned plank stops it turning
// almost at once (the underside runs into the post's corner within a few
// degrees — 7° with a pillar under it, against 30° free), so the see-saw
// looked stuck. A fixed pin bolts the plank to the world on its own; the pin
// IS the post, and drawing one beside it would have taught the opposite.
// **The zone and the green thing are parked off the left of the frame**, the
// way BEAM_LEVEL parks its goal: a level needs both to be legal, and this demo
// is not about either. Drawn in frame they were a violet box clipped by the
// canvas edge and a green ball sitting on the floor doing nothing, on a step
// about hinges. They stay ON the ground rather than being thrown to x=1400,
// so nothing in the world is falling for ten seconds.
export const PIN_LEVEL = {
  terrain: [{ type: 'box', x: 0, y: 60, w: 1020, h: 60, texture: 'grass' }],
  props: [
    { shape: 'box', x: 0, y: -40, w: 250, h: 14, pins: [{ x: 0, y: -40, fixed: true }] },
    { shape: 'box', x: 100, y: -60, w: 26, h: 26 },
    { shape: 'ball', x: -100, y: -210, r: 17, density: 4 },
  ],
  buildZones: [{ x: -440, y: -14, w: 90, h: 90 }],
  goalZones: [{ x: 1400, y: 0, w: 90, h: 76 }],     // far away: this demo never wins
  goalObjs: [{ shape: 'ball', x: -470, y: 16, r: 14 }],
  win: 'goalObj',
};

// **The level can own a machine.** Fixed parts are wheels and sticks that
// belong to the level rather than to the player: a footbridge on two pillars
// with a free roller on top, which the player can pin their own sticks to.
export const PARTS_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 70, w: 900, h: 60, texture: 'grass' },
    { type: 'box', x: -120, y: 10, w: 26, h: 60, texture: 'granite' },
    { type: 'box', x: 160, y: 10, w: 26, h: 60, texture: 'granite' },
  ],
  props: [],
  fixedParts: [
    { t: 'rod', kind: 'wood', x1: -120, y1: -20, x2: 160, y2: -20, id: 'span' },
    { t: 'rod', kind: 'wood', x1: -120, y1: -20, x2: 20, y2: -84, id: 'braceL' },
    { t: 'rod', kind: 'wood', x1: 160, y1: -20, x2: 20, y2: -84, id: 'braceR' },
    { t: 'wheel', kind: 'free', x: 20, y: -84, r: 15, id: 'roller' },
  ],
  buildZones: [{ x: -300, y: -40, w: 140, h: 140 }],
  goalZones: [{ x: 330, y: 0, w: 110, h: 80 }],
  goalObjs: [{ shape: 'ball', x: -290, y: 26, r: 14 }],
  win: 'goalObj',
};

// **The grid, in one contrast.** Three identical slabs placed by eye, and the
// same three on the 40 px grid — where they merge into one silhouette, because
// pieces on neighbouring nodes MEET with no gap and no overlap.
const gridLevel = (slabs) => ({
  terrain: [{ type: 'box', x: 0, y: 70, w: 620, h: 60, texture: 'grass' }, ...slabs],
  props: [],
  buildZones: [{ x: -220, y: -20, w: 110, h: 110 }],
  goalZones: [{ x: 210, y: 0, w: 90, h: 76 }],
  goalObjs: [{ shape: 'ball', x: -210, y: 27, r: 13 }],
  win: 'goalObj',
});
export const GRID_LOOSE = gridLevel([
  { type: 'box', x: -64, y: 8, w: 60, h: 60, texture: 'brick' },
  { type: 'box', x: -1, y: 13, w: 60, h: 60, texture: 'brick', angle: 0.045 },
  { type: 'box', x: 63, y: 5, w: 60, h: 60, texture: 'brick' },
]);
export const GRID_SNAPPED = gridLevel([
  { type: 'box', x: -60, y: 10, w: 60, h: 60, texture: 'brick' },
  { type: 'box', x: 0, y: 10, w: 60, h: 60, texture: 'brick' },
  { type: 'box', x: 60, y: 10, w: 60, h: 60, texture: 'brick' },
]);

// **Spin on the spot** — a path with no waypoints at all, which is what the
// editor's "↻ spin" button seeds. A paddle turning at the floor sweeps a crate
// along it, with nothing driving the crate and no machine in the level.
export const SPIN_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 60, w: 900, h: 60, texture: 'grass' },
    // Centre 46 px above the floor with a 75 px reach, so the tip passes
    // within a pixel of the ground — high enough not to plough it, low enough
    // to catch a crate standing on it. `spin: -1` is the sign whose BOTTOM
    // travels rightward (y is down, §3), which is the direction the eye reads.
    { type: 'box', x: 0, y: -46, w: 150, h: 14, texture: 'steel',
      path: { pts: [], spin: -1, spinSpeed: 137 } },
  ],
  props: [{ shape: 'box', x: -50, y: 15, w: 28, h: 28 }],
  // parked off the left of the frame, for PIN_LEVEL's reason
  buildZones: [{ x: -370, y: -15, w: 90, h: 90 }],
  goalZones: [{ x: 1400, y: 0, w: 90, h: 76 }],     // far away: this demo never wins
  goalObjs: [{ shape: 'ball', x: -400, y: 17, r: 13 }],
  win: 'goalObj',
};

// **A group travels as one thing, and moving terrain carries what stands on
// it.** The lift is two terrain pieces sharing a `groupId` — a floor and its
// back wall — with the group's own path running straight up. The crate is not
// attached to anything: it is simply standing on a floor that goes up, which
// is all an elevator has ever been.
export const LIFT_LEVEL = {
  terrain: [
    { type: 'box', x: 0, y: 90, w: 900, h: 60, texture: 'grass' },
    // the high walkway the lift arrives flush with, at y = −119
    { type: 'box', x: -60, y: -110, w: 200, h: 18, texture: 'granite' },
    { type: 'box', x: 120, y: 50, w: 150, h: 18, texture: 'steel', groupId: 'lift' },
    { type: 'box', x: 186, y: 26, w: 18, h: 66, texture: 'steel', groupId: 'lift' },
  ],
  // The group pivot is the members' average — (153, 38) — so the path's one
  // waypoint is that point 160 px higher. `once`: it goes up and stays up.
  groups: { lift: { path: { pts: [{ x: 153, y: -122 }], mode: 'once', speed: 42 } } },
  props: [],
  // In frame, unlike PIN's and SPIN's: this demo ends with a delivery, so the
  // green box is the payoff and a level showing one zone and not the other
  // would look like it had lost something.
  buildZones: [{ x: -155, y: -5, w: 120, h: 130 }],
  goalZones: [{ x: 120, y: -134, w: 130, h: 96 }],
  goalObjs: [{ shape: 'box', x: 100, y: 27, w: 28, h: 28 }],
  win: 'goalObj',
};

// **The levels drawn as a STILL PICTURE, and what "still" has to mean.**
//
// A running demo announces its own breakage — you watch it fail. A still one
// cannot: it is drawn at the AUTHORED poses, so a crate resting 20 px in the
// air, or half sunk into the floor it is meant to be standing on, draws
// perfectly and is a picture of a level nobody authored. `verify-tutorial`
// walks this list, presses Play on each, and requires that nothing moves.
//
// `staged` is how many bodies a level deliberately parks in mid-air — a goal
// piece inside a build zone is legitimate level design, since the player may
// pick it up and it falls the moment the run begins. Nothing needs it today;
// the field exists so that the answer to a future floating piece is "say so
// here", not "drop the level from the list".
export const STILL_PICTURES = [
  { id: 'skeleton', level: SKELETON_LEVEL },
  { id: 'zone-roomy', level: ZONE_ROOMY },
  { id: 'zone-tight', level: ZONE_TIGHT },
  { id: 'two-zone', level: TWO_ZONE_LEVEL },
  { id: 'goals', level: GOALS_LEVEL },
  { id: 'terrain', level: TERRAIN_LEVEL },
  { id: 'props', level: PROPS_LEVEL },
  { id: 'parts', level: PARTS_LEVEL },
  { id: 'grid-loose', level: GRID_LOOSE },
  { id: 'grid-snapped', level: GRID_SNAPPED },
];

// How long each demo runs before looping (seconds). Chosen to show the win
// banner beat: the win lands around t=3, a moment to enjoy it, reset.
// **cart and solo run to 9 s, from 7** (2026-08-14), for the same reason `grip`
// did on 2026-08-12 and with the same arithmetic: `motorSpeed` became FC's 5
// (was 10), so every powered wheel turns at half the rate and every demo that
// DRIVES somewhere takes about twice as long to get there. Measured win times
// against the +2 s "time to enjoy it" margin these windows carry:
//
//     demo         wins at   needs   was   now
//     cart           5.27s    7.3s     7     9
//     solo-wheel     6.13s    8.1s     7     9
//     catapult       3.43s    5.4s     7     7   (flung, not driven)
//     mover-zone     4.27s    6.3s     9     9
//     lift-group     3.17s    5.2s     8     8
//
// The three that did not move are the three that do not drive — which is the
// tell that this is the motor and not a general slowdown.
// Re-timed 2026-08-24 with the fcsim re-authoring, same arithmetic:
//
//     demo         wins at   needs   was   now
//     cart           5.23s    7.2s     9     9
//     solo-wheel     3.87s    5.9s     9     7   (axled now; bare shows stillness)
//     catapult       6.47s    8.5s     7     9   (heavier throw, longer flight)
//     mover-zone     5.60s    7.6s     9     9
//     grip          (contrast lands by 6s)  9     7
export const DEMO_LOOP_S = {
  cart: 9, catapult: 9, stand: 5, lane: 2.4,
  // **grip runs to 9 s, from 7** (2026-08-12). FC gravity is 7.5 against the
  // old 13, so everything rolls more slowly and the mud/ice contrast needs
  // longer on screen to read. Measured on the demo's own two floors: the ball
  // on mud has stopped for good at 298 px, while the one on ice is at 450 px
  // after 6 s, 736 after 8 and 1020 after 10 — so the lesson is unchanged and
  // only its pacing was tuned to the old gravity.
  solo: 7, beam: 2.8, grip: 7, belt: 6, mover: 9,
  pin: 6, spin: 7, lift: 8,
};

// **What each demo CLAIMS, as data.** The tutorial says "watch this work" and
// "watch this fail"; gates read this list and check the sim agrees, so a
// physics retune cannot quietly turn either into the other. A counter-example
// that starts working is exactly as broken as an example that stops.
export const DEMO_CLAIMS = [
  { id: 'cart', level: CART_LEVEL, design: CART_DESIGN, wins: true, within: DEMO_LOOP_S.cart - 2 },
  { id: 'catapult', level: CATAPULT_LEVEL, design: CATAPULT_DESIGN, wins: true, within: DEMO_LOOP_S.catapult - 2 },
  { id: 'stand-joined', level: STAND_LEVEL, design: STAND_JOINED, holdsUp: true },
  { id: 'stand-loose', level: STAND_LEVEL, design: STAND_LOOSE, holdsUp: false },
  { id: 'lane-ccw', level: LANE_LEVEL, design: laneCart('ccw'), travels: -1 },
  { id: 'lane-free', level: LANE_LEVEL, design: laneCart('free'), travels: 0 },
  { id: 'lane-cw', level: LANE_LEVEL, design: laneCart('cw'), travels: 1 },
  // the FC retraining demos
  { id: 'solo-wheel', level: SOLO_LEVEL, design: SOLO_DESIGN, wins: true, within: DEMO_LOOP_S.solo - 2 },
  // the other half of the axle-rule contrast: the bare wheel must go nowhere
  { id: 'solo-bare', level: SOLO_LEVEL, design: SOLO_BARE, quiet: true },
  { id: 'mover-zone', level: MOVER_LEVEL, design: MOVER_DESIGN, wins: true, within: DEMO_LOOP_S.mover - 2 },
  { id: 'beam-light', level: BEAM_LEVEL, design: BEAM_LIGHT, quiet: true },
  { id: 'beam-heavy', level: BEAM_LEVEL, design: BEAM_HEAVY, quiet: true },
  { id: 'grip-mud', level: GRIP_LEVEL('mud'), design: { parts: [] }, quiet: true },
  { id: 'grip-ice', level: GRIP_LEVEL('ice'), design: { parts: [] }, quiet: true },
  { id: 'belt', level: BELT_LEVEL, design: { parts: [] }, quiet: true },
  // the Level Maker guide's three moving examples
  { id: 'pin-seesaw', level: PIN_LEVEL, design: { parts: [] }, quiet: true },
  { id: 'spin-paddle', level: SPIN_LEVEL, design: { parts: [] }, quiet: true },
  { id: 'lift-group', level: LIFT_LEVEL, design: { parts: [] }, wins: true, within: DEMO_LOOP_S.lift - 2 },
];
