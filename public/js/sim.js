// sim.js — Simulation: builds & steps the world in FC'S OWN ENGINE (§5).
//
// The engine is fcsim's Box2D 2.x — doubles, fixed-point trig, FC's collision
// filter — vendored under engine/ and compiled to public/vendor/fcsim/
// fcsim.wasm by engine/build.sh. It replaced Box2D v3 outright (2026-08-17):
// the parity war ended by regression, and TestLevel solves here because this
// IS the solver it solves in.
//
// Binding conventions, all three of them:
// * the engine is NATIVELY pixel-units (b2_lengthUnitsPerMeter = 30 in
// b2Settings.h — FC units ARE our pixels since sizes.js). Nothing converts
// at the boundary. PPM survives only as the 30-px "legacy metre" for the
// few authored numbers still written in SI (surface tangentSpeed, the hit
// threshold, motor torque);
// * one wasm INSTANCE per Simulation by default — the module compiles once
// (initEngine) and instantiates per world, so the live run and the
// offscreen aftermath run cannot see each other, and destroy() drops the
// instance. The solver may pass opts.engine to reuse an instance whose
// world_create_ex / world_reset are reentrant; the game never does.
// No handles, no .delete(), nothing owned;
// * bodies are INTEGERS (creation order), and every read is a flat exported
// function: E.body_x(i), E.body_vx(i), E.world_step(dt, iters).

import {
 jointKey, wheelHasAxle, loosePinOffsets, wheelPinOffsets, goalPinOffsets, propPins, cornerRadiusOf, clamp, wrapToPi, STD_WHEEL_R,
 samplePathPts, pathPosAt, SPIN_RATE_DIVISOR, rectCorners, isPaint, paintOutlineOf, polyBounds,
 joinedZoneClusters, polyInRectUnion, spinPivotOf, fcMachinePrint, terrainCollider, terrainCanMove,
} from './util.js';
// cornerRadiusOf serves the WIN GEOMETRY above (_pieceFullyInGoal deflates a
// box goal by its drawn corner radius) — the physics shape stopped rounding
// corners with the engine, the containment question did not.
import { surfaceOf, textureSurface, materialForTexture, MAT, LEGACY_TEXTURES } from './surfaces.js';
import { clampRodWeight, ROD_WEIGHT_MIN, clampDensity } from './sizes.js';
import { GRAVITY, planetsOf, fieldAt, pieceGravityOf, floatsAway } from './gravity.js';
import { fcMachineXml } from './fcworld.js';

// ---------- constants (§5.1, §5.5) ----------

export const PPM = 30; // px per legacy metre — a UNIT, not a boundary (see header)
// FC's own clock: 1/30 s, 10 solver iterations (fcsim gen.c). Every frame
// count below is written against this rate. The game rendered at 60 while the
// sim stepped at 60 before the regression; now the sim steps at 30 and view()
// interpolates EVERY body between steps, so the screen never learns.
export const STEP = 1 / 30; // fixed timestep, never varied
export const STEP_ITERS = 10; // solver iterations, FC's own
// The flat-world gravity, and what a planet at pull 1 matches (§5.10). It lives
// in gravity.js because a planet's pull is anchored to it and that module is the
// one the server can import; re-exported here because this is where every caller
// has always looked for it, and `PHYSICS.lifirik.gravity` IS this constant.
export { GRAVITY };
export const WIN_FRAMES = 6; // consecutive frames fully-inside (≈0.2 s at 30 Hz)

// ---- the aftermath: does the delivery actually HOLD? (§7.1/§11.4) ----
//
// Winning only proves every goal piece was fully inside its zone for 12
// frames. That is a real moment, but it says nothing about whether the piece
// stays there — a machine can shove a crate through the zone and out the far
// side, or park on top of it and knock it out three seconds later. So the win
// opens a watch window that runs for up to one simulated minute:
//
// 1. every piece inside its zone AND at rest → Nailed It, decided now
// 2. every piece inside its zone for 10 s straight → Nailed It
// 3. neither, and the minute runs out → no Nailed It
//
// and, independently, if every piece ends up back inside a BUILD zone during
// that window, the machine fetched its delivery home again — Boomerang.
//
// Nobody waits two real minutes for this: the client re-runs the solve in a
// second, offscreen Simulation and fast-forwards the window (determinism, §5.8,
// makes that re-run the same run). The rules live here so the live sim and the
// offscreen one can never disagree about what they saw.
// **ONE minute, not two** (2026-08-07, on request: "speed up the RESULTS, 1 min
// good enough"). This is the cap and almost nothing reaches it — the window
// already stops the moment the world goes quiet (`QUIET_FRAMES`) or a delivery
// comes to rest, which is how the overwhelming majority of runs end it. The cap
// is what a machine that never settles costs: a powered wheel still turning,
// a crate still creeping. Two minutes of that was a long wait for a verdict
// whose answer had stopped changing, and it is paid TWICE — once by the
// offscreen re-run behind "Results!", and again by the progress bar the player
// sits and watches. Halving it halves the worst case and changes nothing about
// a run that settles.
export const AFTERMATH_FRAMES = 30 * 60; // 1800 — the one-minute cap, at 30 steps/s
// **TEN seconds, not twenty** (2026-08-05): the number is read as a countdown
// by whoever is watching the delivery sit there, and ten is the one people
// count in. It only ever decides the second of Nailed It's two routes — a
// delivery that comes to REST takes the badge immediately, at any duration —
// so this is the fallback for something still drifting inside the zone, and
// twenty seconds of watching a crate creep was a long way to be told what the
// first rule usually answers at once.
export const HELD_FRAMES = 10 * 30; // 300 — "remained in the goal"
// "0 velocity" in practice: soft contacts leave a resting body with a hair of
// residual motion, so at-rest is a threshold, not a comparison to zero. A
// tenth of the old Nailed It speed bar (10 px/s), which was "nearly at rest".
export const AT_REST_SPEED = 1; // px/s
export const AT_REST_SPIN = 0.05; // rad/s (≈3°/s)
// Once NOTHING in the world is moving any more, the remaining frames can't
// change any verdict — stop early instead of grinding out the full window. A
// powered wheel spins forever, so a running machine never trips this.
export const QUIET_FRAMES = 23; // ~0.75 s at 30 Hz, same wait it always was
// Goal-zone containment slack, px. Was 0.5 (just enough for one frame of
// Box2D's ~0.003 px resting penetration); Nailed It needs a goal piece to
// stay _inGoal for the FULL 5 s grace window (all 300 frames), and a piece
// resting on a floor right at the zone's edge can jitter more than half a
// pixel across 300 frames of normal contact settling — bumped to a few px
// so "resting on the floor, inside the zone" reliably reads as in for the
// whole window instead of dropping out for a frame here and there.
//
// This is a tolerance for PHYSICAL jitter, not a way to rescue a zone that
// doesn't reach the ground: Align→Touch overlaps a zone into the surface it
// touches (see _touchCoord) precisely so this never has to absorb an
// authoring gap. Don't raise it to paper over zone placement.
export const GOAL_SLACK = 2;

// THE VOID: how far below the lowest thing in the level counts as "gone for
// good". Named once because two rules depend on it meaning the same line —
// `goalLost` (a delivery that fell out of the world, §7.1) and `sweep` (the
// player's whole machine did, §11.4). It has to clear the deepest terrain by
// enough that a piece merely falling PAST a ledge isn't mistaken for a piece
// that has left, which is why it is measured from `levelMaxY` rather than
// being an absolute y.
export const VOID_DROP = 750;

// THE VOID, on a planet (§5.10). Radial gravity has no "below", so the line
// becomes a circle around everything the level authored, and `gone` becomes
// "escaped". The margin is much larger than VOID_DROP for a reason that is
// easy to miss: an ordinary level's sky is unbounded — you may throw a piece
// as high as you like and it is never lost, because the void is only ever
// underneath. A circle closes the sky off, so the margin has to be a sky.
//
// The budget is a LAUNCH SPEED, so the distance has to follow gravity. It was
// 2400 px against 390 px/s² (13 m/s²): a piece leaving the surface at 1000 px/s
// rose 1282 px and came home, and it took ~1370 px/s to actually escape — well
// above anything a machine throws by accident, and gated both ways (§15 gate 17).
//
// **4200, up from 2400** (2026-08-14), because planet gravity is now 7.5 m/s²
// = 225 px/s² and the same 2400 px line would have quietly closed the sky:
// v²/2a puts a 1000 px/s throw at 2222 px, which clears the old line by 178 px
// and would have written off an ordinary lob as "escaped". Same arithmetic,
// same 1370 px/s escape speed: 1370²/(2 × 225) = 4171 → 4200.
export const VOID_ESCAPE = 4200;

// **5 rad/s, down from 10 — FC's own number** (2026-08-14, on request: *"match
// wheel.friction, motorSpeed, goal.boxRestitution to FC"*).
//
// It is the constant rather than `PHYSICS.lifirik.motorSpeed` that moved, because
// the profile REFERENCES this and because it is also `wheelMotorSpeed`'s default
// for a caller with no profile — LIFIRIK being the default profile, the two have
// to be the same number or an unqualified call means something the game does not.
//
// This is the single loudest value in the whole table. Measured leave-one-in by
// `scripts/probe-fcweight.mjs`, motorSpeed alone accounted for 97% of the
// LIFIRIK→FC gap on driving, 87% on climbing, 70% on throwing and 69% on
// shoving — so halving it halves how fast the game happens, everywhere. With
// the r-scaling law above, every wheel now drives at 75 px/s.
export const MOTOR_SPEED = 5; // rad/s — FC's own, adopted 2026-08-14 (was 10)
// **100 N·m, up from 12** (2026-08-12, on request, and provisional pending
// playtest: *"Lets go 100 for now. Sounds more fun."*).
//
// A flail — a rod on a powered wheel, swinging a goal ball — could not throw at
// 12. It was found by switching to the FC profile, where the same machine
// threw and won, and torque turned out to be the ONLY reason: swapping each FC
// value into LIFIRIK one at a time, motorTorque 12→50 gave 129 px of air where
// full FC gives 131, and motorSpeed, wheel friction, wheel damping, wheel
// density, ball friction and every restitution each gave exactly the 21 px the
// shipped numbers do. Nothing else was implicated at all.
//
// Measured on that machine, air under the thrown ball:
//
// torque 12 16 20 25 40 50 75 100 150
// air 21 40 59 79 106 129 186 246 364
//
// It cannot throw at 12 and it overshoots the zone entirely at 150. The
// campaign solves 32/32 at every value tried between, and the jammed-rods pin
// gate stays at 0.35 px against its 1 px bar, so nothing structural objects to
// the range — this is a feel number, chosen by playtest, and provisional.
export const MOTOR_TORQUE = 100; // N·m — for a STANDARD wheel; see below

// **How a powered wheel's torque scales with its size.**
//
// This was a flat MOTOR_TORQUE at every radius, and that is backwards: the
// force a tyre pushes with is torque / radius, so a flat torque meant doubling
// the wheel HALVED its push while QUADRUPLING its mass. Measured across the
// three sizes it came out 48 / 24 / 12 N — the big wheel was the weakest piece
// in the game, at 0.3 times its own weight, and could climb a 12° slope where
// the standard wheel managed 38°. That is precisely why a player wanting to
// throw something heavy bolted ten small wheels together instead of using the
// big one.
//
// The LONE drive (§5.5) never had this problem: it applies `I * LONE_TORQUE`,
// so its torque already scales with rotational inertia. The same wheel was
// therefore 12 N pinned into a machine and 165 N driving on its own — a 14×
// disagreement between the two ways of driving one piece, in opposite
// directions across the size range.
//
// The fix was to make the joint motor follow the lone drive's law — torque ∝
// rotational inertia, which is ∝ r⁴ — and that held until 2026-08-12.
//
// **It is now torque ∝ r, and the lone drive follows the JOINT motor rather
// than the other way round** (on request: *"Is it reasonable to just double for
// the large wheel and half for the small wheel?"*). Doubling and halving across
// 7.5 / 15 / 30 is exactly ∝ r, and dividing by the radius it acts on, that
// makes **rim force identical on every wheel**: 200 N flat, where r⁴ gave
// 25 / 200 / 1600 and the big wheel was 64× the push of the small one.
//
// That is the trade r⁴ never offered. Under r⁴ the big wheel won on force AND
// on top speed (rim speed is ∝ r at a flat motorSpeed), so the small wheel had
// no niche but cost and space. Now size buys speed, reach and clearance, and
// every wheel pushes the same.
//
// **Both drives had to move together, or this would just re-open the old bug in
// the other direction.** Measured before the change, lone ÷ jointed came out
// 0.94 / 0.10 / 0.10 across the three sizes under r⁴ — flat where it matters,
// the 0.94 being the `max(I, 0.05)` floor binding on the small wheel and not
// the law — and would have gone 0.12 / 0.10 / 0.83 with the joint motor alone
// changed, an 8× swing in whether a wheel is stronger bolted in or driving
// alone. So the lone drive's cap is now `wheelMotorTorque` itself: ONE law and
// one number for both ways of driving a wheel, which is the promise the r⁴
// change was making and could only keep while the two laws happened to agree.
//
// `LONE_TORQUE` is gone with it. It was the lone cap as an angular ACCELERATION
// (117 rad/s², i.e. `I · LONE_TORQUE`), and an acceleration ceiling is a torque
// ceiling ∝ I — the r⁴ law wearing a different hat. The servo that drives
// toward motorSpeed is untouched: `(target − w) · I · LONE_GAIN` is still a
// torque asking for a fixed angular acceleration, and only its clamp changed.
//
// **And now torque ∝ r²** (2026-08-19 on Weird Wheels 3 — one big
// wheel against a gang of two and a gang of four standard wheels lifting the
// same pendulum: "I wanted the big wheel to be 4x strong the standard wheel.
// Looks to be only 2x? Can we adjust the big wheel without changing the
// speed?"). ∝ r made the big wheel a two-wheel gang; ∝ r² makes it the four-
// wheel gang he meant, and the small wheel a quarter. Rim force is ∝ r now
// (big pushes twice, small half) where ∝ r had it flat; the speed law below
// (ω ∝ 1/r, every wheel at 150 px/s) is untouched, and the lone drive follows
// this one number as before. FC's own wheels stay flat (D1's C loader drives
// every imported wheel at gen.c's 5e7 whatever its size) — this is LIFIRIK's
// ladder, on LIFIRIK's levels.
export const wheelMotorTorque = (r, P = null) =>
 (P ? P.motorTorque : MOTOR_TORQUE) * (((r || STD_WHEEL_R) / STD_WHEEL_R) ** 2);

// **How a powered wheel's SPEED scales with its size — ω ∝ 1/r, so every wheel
// drives at the same 150 px/s** (2026-08-14, on request: *"I think the wheels
// need to move at the same speed. Just big wheel can lift more weight."*).
//
// `motorSpeed` was flat at every radius, which is a flat ANGULAR speed, and a
// flat angular speed is a rim speed ∝ r. Measured on a two-wheel cart, steady
// ground speed:
//
// r 7.5 15 30
// was 75 150 300 (ω 10 everywhere)
// now 150 150 150 (ω 20 / 10 / 5)
//
// — a 4× spread closed to 1.00×, which is the brief exactly.
//
// **The torque law is UNCHANGED, because it was already the half he wanted.**
// The tempting second move is τ ∝ r², to give the big wheel back a strength
// advantage in place of the speed it just lost. It is unnecessary: τ ∝ r means
// a big wheel already lifts far more than a small one wherever the lever is
// something OTHER than the wheel itself. Measured on a crane — a wheel bolted
// to the world by two rim pins, a 200 px arm on its hub, heaviest stub the arm
// still swings up past horizontal (rod weight units):
//
// r 7.5 15 30
// τ ∝ r 3 30 100 ← shipped, and already 33×
// τ ∝ r² 0 30 100 ← small wheel lifts NOTHING
//
// So "the big wheel lifts more" is a property of the law that is already here,
// and r² only takes the small wheel's floor out from under it: on a loaded
// cart it drops from a 40° climb to 15° while the big wheel goes to 50°. The
// change asked for was to stop size buying SPEED, and that is one exponent.
//
// **What flat rim force means and why the crane disagrees with the ramp.** τ ∝ r
// divided by the r it acts through is a flat 200 N at every rim, so on the
// GROUND every wheel pushes the same — a loaded cart climbs 40/40/35° across
// the three sizes, and an empty one is grip-bound at 50° regardless (wheel
// friction 2.0 against granite 0.85 combines to 1.30, i.e. 52.5°). A crane arm
// is not the rim: its lever is the arm's own length, so what reaches it is raw
// TORQUE, and torque is ∝ r. Both readings are the same law, and a player
// meets it as "big wheels for lifting and reach, small wheels to fit".
//
// Both drives move together, which is the promise `wheelMotorTorque` already
// makes: the lone drive (§5.5) servos toward this same function rather than a
// bare `P.motorSpeed`, or a wheel driving alone and the same wheel bolted into
// a machine would disagree about how fast they mean to turn.
export const wheelMotorSpeed = (r, P = null) =>
 (P ? P.motorSpeed : MOTOR_SPEED) * (STD_WHEEL_R / (r || STD_WHEEL_R));
export const LONE_GAIN = 18; // s⁻¹

// N·m → the engine's own torque unit. The engine works in FC units — length
// ×30, and mass ×900 with it (same density number over an area 30² bigger) —
// so force converts ×27000 and torque ×810000. Sanity: the profile's 50 N·m
// motor lands at 4.05e7, right beside FC's own gen.c constant of 5e7, which
// "matching the spirit of" is exactly what 50 was chosen to do.
export const TORQUE_FC = 810000;

// **Continuous collision died with the engine, and that is FC being FC.**
// The old Box2D v3 backend flagged fast rods as bullets, split each fixed
// step into three collision samples, and stiffened contacts to 240 Hz — three
// mechanisms against thin-stick tunnelling and soft-contact crush that this
// engine simply does not have. FC's own machines tunnel their sticks at speed
// and always have; a regression to FC's physics is a regression to that too.
// If a native LIFIRIK level turns out to lean on a fast thin stick, the honest
// lever is the level, not a solver FC never ran.

// Collisions below this approach speed (m/s) are not reported as hits (§17).
export const HIT_THRESHOLD = 1.0;
// A collapsing machine can hit many things in one step; past this many the
// frame is a crash rather than a set of distinguishable sounds, and buffering
// more only makes the mixer's job harder.
const HIT_BUFFER = 24;
// Shared empty result, so the common "nothing collided" frame allocates nothing
// and cannot be mutated into a surprise by a caller.
const EMPTY_HITS = Object.freeze([]);

export const ROD_THICK = 4; // px (0.133 m)

// **Rope joints are plain free hinges, and the angular-spring mechanism is
// GONE** (2026-08-17, with the engine). It shipped OFF (hertz 0 — measured by
// probe-tread.mjs as the wrong lever anyway: tread flop is laid-in SLACK, a
// whole-link rounding in `_chainWrap`, and no hinge stiffness can take slack
// out), and this engine's revolute has no spring to hang it on. If tread flop
// ever needs fixing, the fix was and is the editor laying the loop to the
// hull's actual perimeter.
// The editor's placement minimum, and the sim's own floor beneath it.
//
// MIN_ROD_LEN was 10, then 5, and is 2 (2026-08-21, on request). A short stick
// is a perfectly good BODY and a perfectly good JOINT, which is the thing to
// know before worrying about the number. Measured on a stub bolted to a driven
// hub, worst joint separation over 600 frames:
//
// length 0.1px 0.5px 1px 2px 5px 10px 30px
// gap 0.0000 0.0000 0.0000 0.0001 0.0002 0.0003 0.0001
//
// — nothing degrades, nothing goes NaN, and the peak speeds are the same at
// every length. The floor is not about the solver.
//
// **What FCSIM enforces, for the record** (src/arena.cpp, `adjust_new_rod`):
// a new rod whose free end lands shorter than 10 is STRETCHED to 10 along the
// drag — never refused, and a zero-length one is pushed out +x. And the clamp
// is skipped entirely when the end attaches to an existing joint, so FC's own
// editor will bolt two joints together at ANY separation, down to zero. Its
// solver enforces nothing at all: `get_rod_shell` is a rect of width =
// distance, whatever that distance is. So FC is stricter than this on a free
// end and looser between joints, and the shape of the rule — a floor for a
// gesture, no floor for a deliberate pin-to-pin stub — is the same shape as
// `_placeRodFinish`'s.
//
// What actually degrades with a very short stick is not the stick, it is the
// geometry it implies: joining two pins 2 px apart puts the two pieces 2 px
// apart, and unless they share a pin they will overlap and shove each other.
// That is honest physics and it is already reachable (two wheels on a shared
// pin overlap far more), so it is the author's call, not a floor's.
export const MIN_ROD_LEN = 2; // px — editor placement minimum (a hand-drawn stick)
export const ROD_SKIP_LEN = 0.5; // rods shorter than this are skipped entirely

// **The shortest link a GENERATOR lays, which is a different question.** A
// rope, a chain wrap or a hull simplification is choosing lengths on the
// author's behalf, and the answer to "how short before it stops being a link"
// there is not the answer to "how short may somebody deliberately draw". At 5
// a rope's links run 5–12 px around their 8 px target and the join never
// leaves a crumb behind; letting them collapse to MIN_ROD_LEN would make a
// dragged rope quietly heavier every time it had to reach a pin.
export const MIN_LINK_LEN = 5; // px — rope links, chain wraps, hull corners

// ---------------------------------------------------------------------------
// How long a stick keeps moving — FC's OWN numbers, in FC's OWN form
// ---------------------------------------------------------------------------
// **FC1 damps rods and nothing else** — its sticks carry linearDamping 0.009
// and angularDamping 0.2 while its wheels, balls and crates carry none. That
// asymmetry is visible on a recording — a wheel and a wood rod released
// together separate by 260 px in 2.4 s — and it is why FC machines settle
// instead of jittering while its crates still slide freely.
//
// These constants spent a year translated: the v3 backend damped per second
// scaled by dt, so FC's nominals had to be measured through an exponential and
// carried as 6.694/s and 0.271/s. This engine stores damping the way FC's did
// — b2Body_ctor keeps `1 − d` as a plain per-step RETENTION multiplied in
// every step, no dt anywhere near it — so the constants are FC's own literals
// again and the whole conversion story is history (git has it). The window
// really is that sharp in FC: a reference solve that works at 0.009 fails at
// 0.010, 11% — which is also why regressing the ENGINE beat translating its
// numbers.
//
// The linear term is the one that costs something: it is why a thrown stick's
// range dies the way FC's does. If throws ever need their range back, that is
// the constant to reach for.
export const ROD_ANGULAR_DAMPING = 0.2; // per-step retention loss, FC's literal
export const ROD_LINEAR_DAMPING = 0.009;

// ---------------------------------------------------------------------------
// ONE PHYSICS (2026-08-10 as a pickable pair; one since 2026-08-17)
// ---------------------------------------------------------------------------
// `fc` is not a guess: every value is measured from FC1's own behaviour and
// checked against recordings — three drops for gravity, two ramps for
// friction (its cart climbs 33° and fails 36°, and atan(0.7) is 35.0°), a
// bounce for restitution, two pendulums for damping.
//
// **The fitted `lifirik` profile is DELETED** (2026-08-17, on request: *"We
// don't need LIFIRIK physics anymore. Just FCLike will do."*). It existed to
// imitate FC under Box2D 3.1, and the conversion war it fought — damping
// through measured exponentials, gravity through wheel-diameter rescales,
// pendulum Π-rigs with a falling ball for a ruler — ended when the residual
// (a 23% slow swing, 12% off a catapult's throw) proved to live in the
// SOLVER, not in any number a table could carry. The engine is FC's own
// solver now, read by the constants it was measured from; a profile fitted
// to imitate it from outside had nothing left to say. Git holds the full
// war, and commit eadf26d is the last one where the loser is readable.
//
// **What is deliberately NOT in here: terrain textures.** FC gives every
// static surface friction 0.7 and has nothing else; LIFIRIK has sixteen
// textures whose whole point is that ice, mud and belt behave differently
// (§5.9). Forcing 0.7 would not be "FC physics", it would be deleting a
// feature — the same is true of every extra the profile never owned (belts,
// radial gravity, gold rods, ghost rods). Those are FEATURE code; the table
// only carries the world's raw numbers.
//
// Kept as a one-entry table rather than flattened to constants: `P.` is how
// every construction site reads these, the shape is load-bearing in the
// probes, and a second profile earned its way in once already.
export const PHYSICS = {
// **Jointed pieces do NOT collide in FC, and ours already don't** — checked
// 2026-08-11 and recorded here because the obvious outside source says the
// opposite. `fcsim` (a C reimplementation) sets `collideConnected = true` on
// every joint, which reads as "FC lets bolted parts shove each other". The
// running game says otherwise, confirmed directly: two bolted
// parts pass through each other, always. So `collideConnected = false` in
// `_pinToAnchor` and in the part-to-part joints is FC's behaviour, not a
// departure from it, and it is not a difference for this table to switch.
 fc: {
 name: 'FC',
 // FC's own rule: consecutive pieces only, N - 1 joints on a shared pin
 // (fcsim gen.c `gen_joint_stack`). Adopted 2026-08-15 on request, after
 // scripts/probe-jointstack.mjs measured what it does to a stack.
 jointChain: true,
 // 300 px/s² in fcsim's own units at 30 units/metre — see gravity.js, and
 // scripts/probe-fcref.mjs for the falling wheel that measured it. Correct
 // only now that a LIFIRIK pixel IS an FC unit (sizes.js): at the old 0.75
 // scale the right answer was 0.75 of this, and was.
 gravity: 10,
 motorSpeed: 5,
 // 5e7 in FC — a number chosen to mean "never stalls", and this was 1e6 to
 // match the spirit of it. **The line that used to sit here, "nothing in a
 // level can load it enough to matter", was wrong** (2026-08-12), and a
 // three-part machine disproved it: a wheel with one rod on its hub and
 // another on a rim pin drives the two rods into each other, they collide
 // correctly — and then the motor, which by construction never gives up,
 // keeps pushing until the solver can no longer hold the pin. The joint
 // opens 11.3 px and the rod is visibly torn off its pin.
 //
 // Swapping ONLY this number moves the tear from one profile to the other,
 // so it is the cause and nothing else is: FC with LIFIRIK's 12 N·m holds at
 // 0.1 px, LIFIRIK with FC's 1e6 tears at 11.9 px.
 //
 // Measured on that machine, worst joint gap over 8 s against how far a
 // plain two-wheel cart drives in 3 s:
 //
 // torque 12 50 200 1e3 … 1e6
 // gap 0.1 0.4 1.5 11.3 (saturated)
 // drives 139 135 132 131
 //
 // The separation saturates from 1e3 up, and the DRIVING barely moves across
 // the whole range — 6% — because a wheel on flat ground is speed-limited,
 // not torque-limited. So the last four orders of magnitude bought nothing
 // and cost 100× the joint integrity.
 //
 // **This was a deliberate departure from FC's number, and it was
 // provisional** ("whack 50 in there for now so it kinda works") — the
 // table above is Box2D v3's soft joints tearing under a big motor. The
 // engine is FC's own now (2026-08-17), whose revolutes hold FC's 5e7 the
 // way FC's do, and the C loader already drives every imported wheel at
 // exactly that. So the standard native wheel gets FC's number too
 // (2026-08-19 on Weird Wheels: "Is this correct FC physics?"):
 // 5e7 in the engine's unit is 5e7 / TORQUE_FC here, and the r-scaling
 // around it stays LIFIRIK's own.
 motorTorque: 50000000 / 810000, // = 61.73 N·m: FC's gen.c 5e7, exactly, at r 20
 wheel: { density: 1, friction: 0.7, restitution: 0.2, angularDamping: 0 },
 rod: {
 // **2:1, and heavy enough to do work** (2026-08-11). Two corrections in
 // one pair of numbers, and the second was found by a machine that would
 // not throw:
 //
 // · the RATIO is 2:1, from the measured 8/4 thicknesses (see above).
 // · the SCALE was 0.625× too light. What matters to a gravity-driven
 // machine is not a stick's mass but its mass against the level's, and
 // FC's stick-to-goal-piece ratio is 0.080 where ours was 0.050 —
 // measured, on a 100-unit stick beside a 100×100 goal rect imported
 // together. Two separate shrinks cause it: our rods are one fixed
 // 4 px thickness where FC's wood is 8 units, and the importer scales
 // a level's lengths by 0.75 while a rod's thickness stays put. So a
 // stick arrived with five eighths of the mass it needed to shift
 // anything, and a catapult built of them did nothing at all.
 //
 // × 1.6 puts the ratio on FC's 0.080 exactly. The pendulum fit below is
 // untouched by it: angular damping decays a velocity independently of
 // mass, and a uniform rod's swing period is a length, not a weight.
 // **2.0 and 1.0 make a stick weigh what FC's weighs, exactly.**
 //
 // FC carries the wood/water difference in WIDTH — 8 units against 4, at a
 // single density of 1 — and we carry it in density at a single 4 px
 // thickness. What a lever, a counterweight and a dropped beam all care
 // about is neither of those on its own but the product: mass per unit
 // length. FC's wood is 8 x 1 = 8 and its water 4 x 1 = 4, so at our
 // thickness the densities that match them are 8/4 = 2 and 4/4 = 1.
 //
 // 1.44 and 0.72 were the same calculation against the OLD world, where a
 // level's lengths were scaled by 0.75 on import while a rod's thickness
 // stayed put. With a LIFIRIK pixel now an FC unit (sizes.js) that
 // correction is gone and the arithmetic is direct.
 //
 // The 2:1 between the two kinds was always right; only the absolute was
 // scale-dependent.
 // **…and since 2026-08-15 the thicknesses are FC's too**, on request, so
 // the compensation above is no longer needed and the densities are FC's
 // own flat 1.0. A wood stick is 8 wide here and a water one 4, exactly as
 // graph.c has them; `pinToPin` ends the capsule at its pins the way FC's
 // box does. Mass per unit length is unchanged (8 x 1 and 4 x 1) — what
 // changes is the FOOTPRINT, which was never right and could not be fixed
 // by a density.
 woodThick: 8, waterThick: 4, pinToPin: true, boxRods: true,
 // a machine's sticks pass through each other (see the mask note in
 // `_addShape`'s rod branch) — without this a chained stack fans out
 woodDensity: 1.0, waterDensity: 1.0, friction: 0.7,
 woodRestitution: 0.2, waterRestitution: 0.2,
 // FC's own literals, read by FC's own engine — the exponential
 // conversion they used to travel through is gone (see the constants).
 angularDamping: 0.2, linearDamping: 0.009,
 },
 // **The `joint` block is gone, and its absence is the whole point of the
 // engine underneath** (2026-08-17). FC's joints come apart under load — 15
 // px on TestLevel's stack landing — and a week of fitting v3's constraint
 // tuning to that (6 Hz matched the measurement, 12 Hz survived the look)
 // bought a machine that deformed the right AMOUNT and still threw 648 px
 // where FC threw 986. The give was never a dial; it was the old solver's
 // Baumgarte position correction, and now the old solver is what runs, so
 // every joint gives exactly the way FC's do at no setting at all.
 // **The default ground, FC's own** (2026-08-16). fcsim's static environment
 // is friction 0.7 where SURFACE_LEGACY — granite, neon and classic, i.e.
 // every official and every import — is 0.85. Only the `fc` profile carries
 // this, and `_terrainSurface` applies it only to those three textures, so
 // ice is still ice and a hand-set surface still wins. Restitution already
 // agrees at 0 and is restated so the pair is readable in one glance.
 terrain: { friction: 0.7, restitution: 0 },
 // **Restitution 0.2 — FC's DYNAMIC environment** (2026-08-18, corrected).
 // This said 0 "matching fcsim's static environment", reasoning that FC
 // has no separate prop. It has two environments: graph.c's
 // static_env_material (density 0, restitution 0) for StaticRectangle /
 // StaticCircle, and dynamic_env_material (density 1, restitution 0.2)
 // for DynamicRectangle / DynamicCircle — which is exactly what a prop
 // is. Measured on Sticks 26's empty level: with 0 the JS build parted
 // from the C loader inside the first second; with 0.2 it tracks the
 // whole first bounce and parts at 5 s on ulps (verify-fcworld 3).
 prop: { friction: 0.7, restitution: 0.2, linearDamping: 0, angularDamping: 0 },
 goal: { ballFriction: 0.7, boxFriction: 0.7, ballRestitution: 0.2, boxRestitution: 0.2, angularDamping: 0 },
 },
};
export const PHYSICS_KEYS = Object.keys(PHYSICS);
// Every key answers `fc` now — the profile question is settled (2026-08-17,
// "We don't need LIFIRIK physics anymore"), but old callers still pass their
// stored strings and gates still probe with nonsense on purpose.
export const physicsOf = () => PHYSICS.fc;

// Collision categories — identical to legacy; this IS the game's feel (§5.2).
//
// **GHOST is the one addition** (2026-08-10), for the rod kind FC Gold has and
// FC1 did not: it touches NOTHING. Not terrain, not props, not the machine,
// not the goal pieces — a water stick already passes through your own machine
// and still lands on the floor, and the difference between those two is the
// whole piece.
//
// Its mask is 0, and that is all that is needed: Box2D requires BOTH sides to
// admit each other, so nothing has to be told about `CAT.GHOST` for a ghost to
// be ignored by it. The category still gets a bit of its own rather than
// sharing WATER's, so a ghost is distinguishable to anything that asks what it
// hit (`drainHits`, §17.2) even though the answer is always "nothing".
// **GHOSTPROP is the second addition** (2026-08-24, "turn a prop into a
// ghost… stuck to the background and sticks pass, balls/wheels do not"): a
// STATIC prop that wheels, goal pieces and ordinary props land on while
// every kind of stick sails through.
//
// **It SHARES bit 64 with GHOST, and it has to** — the wasm harness packs
// category and mask into SEVEN bits each (harness.c UD_PACK, `& 0x7f`), so
// bit 128 would be silently truncated to a category of 0 that collides with
// nothing (measured: the first cut did exactly that, and every gate that
// dropped a wheel onto the shelf watched it fall through). The share is
// safe because a ghost ROD's mask is 0: even though wheels, goals and props
// now admit bit 64, the filter needs BOTH sides to agree, and the rod side
// never does. Only a ghost PROP answers on that bit with a mask of its own.
export const CAT = { ENV: 1, WHEEL: 2, ROD: 4, WATER: 8, GOAL: 16, PROP: 32, GHOST: 64, GHOSTPROP: 64 };
export const MASK = {
 ENV: 0xFFFF,
 WHEEL: CAT.ENV | CAT.WHEEL | CAT.GOAL | CAT.PROP | CAT.ROD | CAT.GHOSTPROP,
 ROD: CAT.ENV | CAT.GOAL | CAT.PROP | CAT.ROD | CAT.WHEEL,
 WATER: CAT.ENV | CAT.PROP,
 GHOST: 0,
 GOAL: CAT.ENV | CAT.WHEEL | CAT.ROD | CAT.GOAL | CAT.PROP | CAT.GHOSTPROP,
 PROP: CAT.ENV | CAT.WHEEL | CAT.ROD | CAT.GOAL | CAT.PROP | CAT.WATER | CAT.GHOSTPROP,
 GHOSTPROP: CAT.WHEEL | CAT.GOAL | CAT.PROP,
};

// ---------- wasm boot ----------

let M = null; // the compiled engine MODULE — instantiated per Simulation

export async function initEngine(url = '/vendor/fcsim/fcsim.wasm') {
 if (M) return M;
 // Browser and Node both come through here — the offscreen scripts import
 // this file directly and hand it a filesystem path. `compile` over
 // `compileStreaming` on the fetch path, so a mis-served MIME type cannot
 // become a boot failure.
 const s = String(url);
 if (typeof process === 'undefined' && typeof fetch === 'function') {
 M = await WebAssembly.compile(await (await fetch(s)).arrayBuffer());
 } else {
 const { readFile } = await import('node:fs/promises');
 const { fileURLToPath } = await import('node:url');
 M = await WebAssembly.compile(await readFile(s.startsWith('file:') ? fileURLToPath(s) : s));
 }
 return M;
}

export async function initBox2D(moduleUrl) {
 return initEngine(moduleUrl || '/vendor/fcsim/fcsim.wasm');
}

function engineModule() {
 if (!M) throw new Error('engine wasm is not initialised yet — await initEngine()');
 return M;
}

// Box2D v3 is gone (2026-08-17). The stub keeps old probe imports failing
// with a sentence instead of a TypeError.
export function box2d() {
 throw new Error('Box2D v3 was removed — the engine is fcsim now; drive it through Simulation');
}

export function box2dReady() { return !!M; }
export function engineReady() { return !!M; }

// Kinematic-mover test shared with the renderer: a pathless member of a moving
// group must NOT be baked into the static slab (§10.2).
// Rebuild a `view()`-shaped object from a recorded frame (§7.3), so a scrubbed
// frame goes through the ordinary drawing path — there is no second renderer,
// and a recorded frame cannot look different from the frame it was taken from.
// A free function over a `tapeShape()` + the pose buffer: it needs no live
// Simulation, which is what lets a tape outlive the run that made it.
export function viewFromTape(shape, src, at) {
 const v = { terrain: [], props: [], goals: [], wheels: [], rods: [], goalZones: shape.goalZones, texts: shape.texts };
 let i = at;
 const take = () => { const p = { x: src[i], y: src[i + 1], angle: src[i + 2] }; i += 3; return p; };
 for (const t of shape.terrain) {
 if (t.moving) v.terrain.push({ def: t.def, ...take(), moving: true });
 else v.terrain.push({ def: t.def, x: t.def.x, y: t.def.y, angle: t.def.angle || 0, moving: false });
 }
 for (const def of shape.props) v.props.push({ def, ...take() });
 for (const def of shape.goals) v.goals.push({ def, ...take() });
 for (const w of shape.wheels) v.wheels.push({ part: w.part, fixed: w.fixed, ...take() });
 for (const r of shape.rods) {
 const p = take();
 const hx = (r.len / 2) * Math.cos(p.angle), hy = (r.len / 2) * Math.sin(p.angle);
 v.rods.push({ part: r.part, fixed: r.fixed, x1: p.x - hx, y1: p.y - hy, x2: p.x + hx, y2: p.y + hy });
 }
 return v;
}

// **Lives in util.js now** (2026-08-21), because GhostRun's route field has to
// ask the same question and util.js cannot import this file — sim.js imports
// util.js, so the arrow only goes one way. Re-exported under its own name: every
// caller in the project imports it from here, and a move is not a rename.
export { terrainCanMove };

// A pose `_lerpPose` can actually interpolate. `_moverPose` returns x/y/angle;
// the lerp needs `c`/`s` too, because it blends the DIRECTION VECTOR rather
// than the angle (which is what stops a mover spinning the long way round at
// the ±π wrap). A body's pose carries them already — a bodyless mover has to
// add them, and without this a rotating label lerps its angle to NaN.
function textPose(p) {
 return { x: p.x, y: p.y, angle: p.angle, c: Math.cos(p.angle), s: Math.sin(p.angle) };
}

function pathSpinRate(path) {
 if (!path || !path.spin) return 0;
 const spinSpeed = path.spinSpeed ?? path.speed ?? 60; // ?? — 0 is legitimate
 return (path.spin < 0 ? -1 : 1) * Math.abs(spinSpeed) / SPIN_RATE_DIVISOR;
}

// Per-piece (or per-group) motion state advanced exactly once per fixed step.
function makeMotion(origin, path) {
 if (!path) return null;
 const sampled = (path.pts && path.pts.length) ? samplePathPts(origin, path) : null;
 // The custom spin centre (§9.1), resolved ONCE — null when the author never
 // moved it, which is both the fast path and the determinism guarantee: a
 // motion without one runs the exact arithmetic it always has, so no level
 // authored before pivots existed can simulate differently. Only meaningful
 // with spin (`spinPivotOf`'s callers all gate on it), and orient is already
 // spin's exclusive opposite, so `angle` below is pure spin whenever this is
 // set.
 const pv = path.spin ? spinPivotOf(path, origin.x, origin.y) : null;
 return {
 sampled,
 speed: path.speed ?? 40,
 mode: path.mode || 'once',
 spinRate: pathSpinRate(path),
 spinStop: !!path.spinStop, // stop spinning once the trip is over
 orient: !!path.orient && !path.spin, // spin and orient are mutually exclusive
 pivot: pv && pv.custom ? { x: pv.x, y: pv.y } : null,
 s: 0, dir: 1, angle: 0, // angle = accumulated spin
 stopped: false, // spinStop has fired
 tan0: sampled ? pathPosAt(sampled, 0).tan : 0,
 };
}

function advanceMotion(m) {
 if (!m) return;
 if (!m.stopped) m.angle += m.spinRate * STEP;
 if (!m.sampled || m.sampled.total <= 0) return;
 const total = m.sampled.total;
 if (m.sampled.closed) {
 m.s = (m.s + m.speed * STEP) % total; // closed paths always circulate forward
 } else if (m.mode === 'pingpong') {
 m.s += m.dir * m.speed * STEP;
 if (m.s >= total) { m.s = total - (m.s - total); m.dir = -1; }
 else if (m.s <= 0) { m.s = -m.s; m.dir = 1; }
 m.s = clamp(m.s, 0, total);
 } else {
 m.s = Math.min(m.s + m.speed * STEP, total); // once: stop at end
 // §9.1 spinStop: freeze the spin the moment the trip is over, ON the
 // exact angle the trip's own duration implies — the landing step
 // otherwise contributes a whole step of spin past the end (a fifth of a
 // degree at the slowest notch, twenty at the fastest), and the resting
 // angle is an authored value: it's what the end ghost draws, what the
 // info chip prints, and what the piece is being lined up against. Only
 // reachable from this branch — a closed loop and a pingpong never
 // finish, so a spin opted in on one of those keeps turning forever,
 // exactly as the editor's toggle says it will.
 if (m.spinStop && m.s >= total && !m.stopped) {
 m.stopped = true;
 if (m.speed > 0) m.angle = m.spinRate * (total / m.speed);
 }
 }
}

// Current pose offset of a motion: {dx, dy, dAngle} relative to authored pose.
function motionOffset(m, origin) {
 if (!m) return { dx: 0, dy: 0, dAngle: 0 };
 let dx = 0, dy = 0, dAngle = m.angle;
 if (m.sampled) {
 const p = pathPosAt(m.sampled, m.s);
 dx = p.x - origin.x; dy = p.y - origin.y;
 if (m.orient) dAngle += wrapToPi(p.tan - m.tan0);
 }
 return { dx, dy, dAngle };
}

// ---------- Simulation ----------

// The world-anchor's identity in the joint PLAN, which runs before any body
// exists (see _planJoints) — loose pins and `fixed` prop pins bolt to it.
const ANCHOR = Object.freeze({ anchor: true });

export class Simulation {
 // level: level data (§11.1); design: {parts: []}; opts:
 // goalPositions — [{x, y}] per goalObj (editor-staged positions)
 constructor(level, design, opts = {}) {
 // Game path: a fresh wasm instance. Solver path: opts.engine reuses one
 // (world_reset + world_create_ex are reentrant; see harness.c).
 this._wasm = opts.engine || new WebAssembly.Instance(engineModule());
 const E = this.E = this._wasm.exports;
 if (opts.engine && typeof E.world_reset === 'function') E.world_reset();
 this.opts = opts;
 // HEADLESS: nobody is going to draw this world or listen to it — the
 // solver, the sweeps, the gates. Two per-step jobs exist only for those
 // two audiences and are skipped: the pose snapshots view() interpolates
 // between (§ the note in _fixedStep), and the collision scan the sound bed
 // drains (§17), which is switched off in the engine as well as here. It
 // moves NOTHING: measured pose-for-pose identical across every solve, and
 // view() still answers, from the live pose instead of a blended one.
 // Worth a third of a headless step — the snapshots alone were 21% of it.
 this.headless = !!opts.headless;
 if (this.headless && E.set_hits) E.set_hits(0);
 // Which physics this world runs (§ PHYSICS). Frozen at construction: a
 // profile that could change mid-run would break determinism (§5.8), and
 // every reader below takes it from here rather than from a setting.
 this.P = physicsOf(opts.physics);
 this.level = level;
 // Live, mutable copies of the goal zones — moved during simulation, both
 // by their own authored motion path (§9.3, same mechanism as a terrain
 // piece's own path) and by riding a terrain group they're grouped with.
 // level.goalZones itself is never touched; win checks and the renderer
 // read this instead. groupId travels per-element off the authored zone.
 this.goalZoneRecs = (level.goalZones || []).map((z) => ({ def: z, motion: z.path ? makeMotion(z, z.path) : null }));
 this.liveGoals = this.goalZoneRecs.map((r) => ({ ...r.def }));
 // TEXT LABELS MOVE (§10.6/§9.3) — on their own path, or riding a group's,
 // through the identical `{def, motion}` record a goal zone uses and the
 // identical `_moverPose`. A label has no BODY and never gets one: it is
 // decoration, so it collides with nothing, carries nothing and is not in
 // any win check. That is exactly why it can be a bodyless mover in the
 // first place, and why this costs one array rather than a second physics
 // path. `level.texts` is never touched; the renderer reads view().texts.
 // `currPose` is SEEDED with the authored pose, and that is not tidiness: the
 // first step's `prevPose` comes from it, and taking the already-advanced
 // pose instead would make the first frame's pair identical — one step with
 // no interpolation at all, against a slab that does interpolate. Terrain
 // dodges this by capturing `prevPose` from the body BEFORE the advance
 // (_fixedStep); a bodyless mover has to seed it explicitly.
 this.textRecs = (level.texts || []).map((t) => ({
 def: t,
 motion: t.path ? makeMotion(t, t.path) : null,
 currPose: textPose({ x: t.x, y: t.y, angle: t.angle || 0 }),
 }));
 this._buildClusters = null; // build zones never move mid-run — computed once, lazily (§7.2a)
 this.time = 0;
 this.won = false;
 this.winTime = null;
 this.goalLost = false;
 // …and WHICH WAY it went, so the client can say the true sentence: a piece
 // that floated out through the top did not "fall" anywhere (§5.10).
 this.goalLostUp = false;
 this._winStreak = 0;
 // post-win watch window (§7.1/§11.4) — public so the client can show its
 // progress and read the verdict off it
 this.afterElapsed = 0;
 this.afterDone = false;
 this.nailedIt = false;
 this.nailedItBy = null; // 'rest' | 'held' — which of the two rules awarded it
 this.boomerang = false;
 // SWEEP (§11.4): every piece the PLAYER built has fallen into the void.
 // Seeded at the end of the constructor, once the parts and the void line
 // both exist — see there.
 this.sweep = false;
 this._heldStreak = 0;
 this._quietStreak = 0;
 this._acc = 0;
 this.destroyed = false;

 // ---- world ----
 //
 // Radial levels (§5.10) switch the world's own gravity OFF and drive every
 // dynamic body from _applyRadialGravity instead. All of it or none of it:
 // leaving y-down switched on underneath a planet would keep pulling a
 // piece resting on the planet's north pole toward the south one, so there
 // is exactly one "down" per level and a planet is what decides it. A level
 // with no planets is untouched, to the bit.
 this.planetDefs = planetsOf(level);
 this.radial = this.planetDefs.length > 0;
 // **Bounds and the void come FIRST now** — this engine FREEZES a body
 // whose AABB leaves the world box (b2Body_Freeze: proxies gone, pose
 // stuck), so the box has to be drawn before the first body exists, and
 // drawn generously: past the void line below, a sky's worth above, and
 // wide enough sideways that no honest throw meets the edge. A frozen
 // piece past the void line is invisible to the game — its verdicts were
 // rendered on the way through it.
 const bounds = this._computeLevelBounds();
 this.levelMaxY = bounds.maxY;
 this.levelMinY = bounds.minY;
 this.voidLine = this._computeVoid();
 const gravPx = this.radial ? 0 : this.P.gravity * PPM; // m/s² → units/s², y-down
 // `opts.worldAabb` is a probe's door (the fidelity rigs): the broadphase
 // SORTS proxies on bounds quantized over this box, so the box's size can
 // reorder pair creation — and a degenerate stack resolves its identical
 // contacts in exactly that order. Nothing in the game passes it.
 const AB = this.opts?.worldAabb;
 if (AB) {
 E.world_create_ex(gravPx, AB.minX, AB.minY, AB.maxX, AB.maxY);
 } else if (this.radial) {
 const v = this.voidLine, m = v.outside + 2000;
 E.world_create_ex(0, v.x - m, v.y - m, v.x + m, v.y + m);
 } else {
 E.world_create_ex(gravPx,
 bounds.minX - 20000, this.levelMinY - 30000,
 bounds.maxX + 20000, this.voidLine.below + VOID_DROP + 2000);
 }
 // Bolted parts pass through each other — the game's rule since the
 // beginning, restated to an engine whose own default (fcsim's gen.c) is
 // the opposite. The pin filter already exempts every pin-sharing pair,
 // so this flag is belt to that brace.
 E.set_collide_connected(0);

 this.terrain = []; // {def, body, moving, motion, group, edgeBodies?}
 this.planets = []; // {rec, r, pull} — the terrain records that pull (§5.10)
 this.props = []; // {def, body}
 this.goals = []; // {def, body, x0, y0}
 this.wheels = []; // {part, body, fixed}
 this.rods = []; // {part, body, len, fixed}
 this._hits = []; // collisions since the last drainHits() (§17)
 this.jointRecs = []; // {a, b, x, y, motor} — bookkeeping for harness/debug
 this.loneDrives = []; // {body, dir}
 this.groupStates = {}; // groupId -> {motion, pivot}
 // body index → MAT id, for the sound layer: a hit comes back as two body
 // indices, and this is the only channel from a collision to "what were
 // these two things made of" (§17.2).
 this._matByBody = [];

 // **The joint plan comes before the first body** (see _planJoints): the
 // engine's filter answers at body creation and never again, so every
 // body must be born already knowing the coordinates it will be jointed
 // at — those and only those stop colliding.
 const designParts = (design && design.parts) || [];
 const fixedParts = level.fixedParts || [];
 this._bodyOf = new Map(); // plan entity → engine body index

 // **THE C LOADER** (2026-08-17): a PRISTINE imported design builds its
 // world through fcsim's own xml/graph/gen, vendored into the engine —
 // bit-exact with ft.jtai.dev by construction, which no JS build can
 // promise (measured: two winnable machines lost to last-ulp parse and
 // expression differences a degenerate impact amplified 1e12-fold).
 // Physics runs in the SOURCE frame; `_fcShift` moves every pose read
 // into the level's drawn frame, so the screen and the win geometry never
 // learn. An EDITED machine takes the JS path below — its extra pieces
 // are LIFIRIK's, and LIFIRIK physics is the honest answer for them.
 // …and the C world spawns cargo where the XML says, so a DRAGGED goal
 // piece is an edit too — the same invisible-to-the-print class as a
 // toggled stick (2026-08-17). Positions equal to the level's own are a
 // drag that never happened and stay pristine.
 const goalsMoved = (opts.goalPositions || []).some((g, i) => {
 const d = (level.goalObjs || [])[i];
 return g && d && (g.x !== d.x || g.y !== d.y);
 });
 if (level.fcWorld) {
 const W = level.fcWorld;
 const machineOrder = [...(level.fixedParts || []), ...designParts]
 .filter(p => p.t === 'wheel' || p.t === 'rod')
 .sort((a, b) => (a.srcSeq ?? 1e9) - (b.srcSeq ?? 1e9));
 if (!goalsMoved && this._fcPristine(level, designParts)) {
 // the source's own XML, digit for digit — the pristine import
 this._buildFcWorld(level, W.xml, W.players, machineOrder, opts.goalPositions);
 return;
 }
 // **Any FC-piece machine takes FC's builder** (2026-08-18, D1). Not
 // only the pristine design: a player's sticks and wheels on an
 // imported level, an edited import, a solver's candidate — anything
 // that can be said in FC's own dialect is built by fcsim's own graph
 // and gen from that dialect (fcworld.js), so it plays exactly as it
 // would at ft.jtai.dev. What cannot be said there — a weight dial, a
 // rope, a joint on a pin FC has not got, a LIFIRIK bolt on the level —
 // takes the JS build below, which has those things.
 const said = this._fcTranspiled(level, designParts, opts.goalPositions);
 if (said) {
 this._buildFcWorld(level, said.xml, said.players, said.order, opts.goalPositions);
 return;
 }
 }
 this._planJoints(designParts, fixedParts, opts.goalPositions);

 // shared static anchor body at the origin — `fixed` prop pins bolt to it,
 // and so do the level's own loose pins.
 this._stagePins(this._plannedPins.get(ANCHOR) || []);
 this.anchorBody = E.add_ghost_body(0, 0);
 this._bodyOf.set(ANCHOR, this.anchorBody);
 this._matByBody[this.anchorBody] = 0;

 // ---- group motion state (JSON document order — §5.8) ----
 for (const [gid, g] of Object.entries(level.groups || {})) {
 // pivot anchors to terrain when any is grouped (matches the terrain's
 // own rotation centre exactly); a zone-only group (no terrain — e.g.
 // two goal zones grouped together) falls back to the zones' own
 // average so it isn't silently inert (§9.3).
 // …and LABELS are on that fallback list too: a group of nothing but
 // labels is a legitimate thing to make — a title and its subtitle
 // travelling together — and would otherwise have no pivot at all.
 const members = (level.terrain || []).filter(t => t.groupId === gid);
 const pivotSources = members.length ? members : [
 ...(level.buildZones || []), ...(level.goalZones || []), ...(level.texts || []),
 ].filter(z => z.groupId === gid);
 if (!pivotSources.length) continue;
 let px = 0, py = 0;
 for (const m of pivotSources) { px += m.x; py += m.y; }
 const pivot = { x: px / pivotSources.length, y: py / pivotSources.length };
 let motion = null;
 if (g.path) {
 motion = makeMotion(pivot, g.path);
 if (motion && motion.spinRate) motion.orient = false; // group spin overrides group orient
 }
 // The group's SPIN centre: the authored override when there is one, the
 // members' average otherwise (§9.1). Split from `pivot` because pivot is
 // also the path's translation origin, and moving where a group TURNS
 // must not move where its path STARTS.
 const sp = g.path?.spin ? spinPivotOf(g.path, pivot.x, pivot.y) : pivot;
 this.groupStates[gid] = { motion, pivot, spinPivot: { x: sp.x, y: sp.y } };
 }

 // ---- terrain ----
 //
 // There is no kinematic body type here: a mover is a STATIC body the step
 // teleports (see _advanceMovers), which is also why its pins and shapes
 // are built exactly like any other terrain's.
 for (const t of (level.terrain || [])) {
 const moving = terrainCanMove(t, level);
 // A painted piece is its OUTLINE (§5.3): the interior is empty. The old
 // engine has no chain shape, so the outline is a fence of thin static
 // boxes, one body per edge, outer face exactly on the authored line —
 // see _addPaintEdges. Same material and filter as every other terrain
 // body, so it slides, brakes and blocks identically.
 // What the piece is made of (surfaces.js): its own `surface` where it
 // sets one, its texture's default otherwise. The officials set no
 // texture at all, so they resolve to granite and simulate identically.
 const surf = this._terrainSurface(t);
 const tMat = materialForTexture(t.texture);
 const m = { ...surf, category: CAT.ENV, mask: MASK.ENV, mat: tMat };
 this._stagePins(this._plannedPins.get(t) || []);
 let body, edgeBodies = null;
 if (isPaint(t)) {
 edgeBodies = this._addPaintEdges(t, m);
 // a degenerate outline (< 3 points) still owes the record a body
 body = edgeBodies ? edgeBodies[0].idx : E.add_ghost_body(t.x, t.y);
 } else {
 // **A `line` piece collides at ZERO extent on the axis it names**
 // (2026-08-18): an FC level's zero-width DynamicRectangle — an
 // invisible static line at home, imported as terrain drawn at stick
 // thickness (fcimport boxOf). The drawn box is for the eye; the body
 // is FC's own degenerate box, built through the same b2BoxDef the C
 // loader uses, so a ball rests on it where it rests at home and not
 // 4 px higher.
 // …and it comes from `terrainCollider` (util.js) rather than being
 // written out here, because the EDITOR has to measure against the same
 // geometry: a wheel resting on a ghost line rests on this zero-height
 // body, and an editor that measured the 8 px drawing instead refused
 // the position the physics puts it in (2026-08-21).
 const box = terrainCollider(t);
 body = this._addBody(t.type === 'ball' ? { circle: t.r } : { box },
 { x: t.x, y: t.y, angle: t.angle || 0 }, m);
 }
 this._bodyOf.set(t, body);
 const motion = t.path ? makeMotion(t, t.path) : null;
 const rec = { def: t, body, edgeBodies, moving, motion, group: t.groupId || null };
 this.terrain.push(rec);
 // A planet's centre is its terrain record's LIVE pose, not its authored
 // one — put a planet on a motion path and the whole gravity field
 // travels with it (§5.10). Matched here rather than by searching
 // level.terrain afterwards so the pairing can't drift.
 const pd = this.planetDefs.find((p) => p.def === t);
 if (pd) this.planets.push({ rec, r: pd.r, pull: pd.pull });
 }

 // ---- props ----
 for (const p of (level.props || [])) {
 // A prop may fall UP (§5.10). The engine has no per-body gravity dial,
 // so the harness applies (scale − 1)·m·g as a per-step force — the body
 // keeps a positive mass and an honest contact solve, which is the whole
 // reason "negative density" was never the answer (gravity.js). Clamped
 // there, not trusted here, for the same reason density is.
 //
 // The scale does nothing at all on a radial level: a planet level runs
 // world gravity 0 and pushes every body by hand, so the scale is folded
 // into `this.dynamics` below instead.
 const propG = pieceGravityOf(p);
 this._stagePins(this._plannedPins.get(p) || []);
 // **A GHOST prop is stuck to the background** (2026-08-24): density 0
 // makes it static, and the GHOSTPROP filter makes it a floor for
 // wheels, goal pieces and other props that no stick can feel. Its
 // motion path, gravity dial and density dial are all moot on a body
 // that never moves; the pins it carries still bolt like anything
 // static (a hinge to a ghost is a hinge to the background).
 const ghost = !!p.ghost;
 const body = this._addBody(p.shape === 'ball' ? { circle: p.r } : { box: p },
 { x: p.x, y: p.y, angle: p.angle || 0 }, ghost ? {
 density: 0, friction: this.P.prop.friction, restitution: this.P.prop.restitution,
 category: CAT.GHOSTPROP, mask: MASK.GHOSTPROP, mat: MAT.PROP,
 } : {
 density: clampDensity(p.density ?? 1), friction: this.P.prop.friction, restitution: this.P.prop.restitution,
 category: CAT.PROP, mask: MASK.PROP, mat: MAT.PROP,
 }, ghost ? { linear: 0, angular: 0 } : { linear: this.P.prop.linearDamping, angular: this.P.prop.angularDamping });
 if (!ghost) E.body_gravity_scale(body, propG);
 this._bodyOf.set(p, body);
 // `fixed` pins (a hinge to the static background) and every other joint
 // this prop takes part in are in the PLAN — made real in _makeJoints.
 this.props.push({ def: p, body, gravityScale: propG });
 }

 // ---- goal pieces (positions possibly staged by the editor) ----
 const goalObjs = level.goalObjs || [];
 goalObjs.forEach((g, i) => {
 const pos = (opts.goalPositions && opts.goalPositions[i]) || g;
 // A goal piece may fall UP too (§5.10) — same harness scale the props
 // use. Absent is 1, so every level authored before the dial existed
 // builds exactly as it did. The authored spawn angle gets the same
 // treatment as props — goalPinOffsets rotates the pin lattice to
 // match, so joints land on the tilted corners.
 const goalG = pieceGravityOf(g);
 this._stagePins(this._plannedPins.get(g) || []);
 const mat = g.shape === 'ball'
 ? { density: clampDensity(g.density ?? 1), friction: this.P.goal.ballFriction, restitution: this.P.goal.ballRestitution,
 category: CAT.GOAL, mask: MASK.GOAL, mat: MAT.GOAL }
 : { density: clampDensity(g.density ?? 1), friction: this.P.goal.boxFriction, restitution: this.P.goal.boxRestitution,
 category: CAT.GOAL, mask: MASK.GOAL, mat: MAT.GOAL };
 const body = this._addBody(g.shape === 'ball' ? { circle: g.r } : { box: g },
 { x: pos.x, y: pos.y, angle: g.angle || 0 }, mat,
 { linear: 0, angular: this.P.goal.angularDamping });
 E.body_gravity_scale(body, goalG);
 this._bodyOf.set(g, body);
 // `ceiling` is decided ONCE, from the authored dial, rather than asked of
 // the live velocity every frame: "can this piece come back" is a property
 // of the level, and a rule read off the pose would make the verdict
 // depend on when it was asked (§5.8).
 this.goals.push({ def: g, body, x0: pos.x, y0: pos.y, gravityScale: goalG, ceiling: floatsAway(g) });
 });

 // ---- machine parts: design.parts then level.fixedParts (§5.4) ----
 for (const part of designParts) this._buildPart(part, false);
 for (const part of fixedParts) this._buildPart(part, true);

 // ---- the joint plan, made real (§5.4) ----
 this._makeJoints();

 // Sub-steps died with the old solver: this engine has one dial, the
 // iteration count, and it is FC's own 10 (STEP_ITERS) for every machine.
 this.jointCount = this.jointRecs.length;

 // Everything radial gravity has to push, with its mass taken once. Mass
 // never changes after construction (no shape is added or removed at
 // runtime). Order is props → goals → wheels → rods, i.e. stored order
 // within each list (§5.8).
 //
 // `push` is mass ALREADY multiplied by the body's gravity scale, and it is
 // named for what it is rather than called `mass`, because it is not one: a
 // prop with `gravity: -1` weighs its full mass in every collision and is
 // pushed the other way by the field. The world's own gravity is OFF here
 // (0 on a radial level), so the harness's gravity scale — the whole of the
 // feature on a flat level — is dead weight in this branch and the scale
 // has to be folded in by hand. Folded ONCE, with the mass.
 this.dynamics = this.radial
 ? [...this.props, ...this.goals, ...this.wheels, ...this.rods]
 .map((r) => ({ body: r.body, push: E.body_mass(r.body) * (r.gravityScale ?? 1) }))
 : [];

 // Seeded now that the parts exist AND the void line is known. A machine
 // with no parts starts SWEPT: `every` over an empty list is true, and that
 // is the honest answer rather than a special case. A 0-piece solve has
 // trivially left nothing behind, which is exactly what the badge is for.
 this.sweep = this._allPartsVoid();

 // **Every dynamic body is interpolated for the screen now** (§9.4, grown
 // whole-world with the 30 Hz step): _fixedStep snapshots prevPose before
 // integrating and currPose after, and view() blends by the frame's alpha.
 // Only the DRAWN pose blends — every rule reads live state, so nothing
 // about a verdict can depend on the display's refresh rate.
 this._lerpRecs = [...this.props, ...this.goals, ...this.wheels, ...this.rods];
 }

 // ------- construction helpers -------

 // **The ground a profile says it is standing on** (2026-08-16).
 //
 // Terrain takes its surface from its TEXTURE (surfaces.js), not from the
 // physics profile — which is right, because ice is slippery whatever engine
 // you are matching. But it meant the one FC constant nothing could reach:
 // fcsim's static environment is friction 0.7, and granite / neon / classic
 // are all pinned to SURFACE_LEGACY's 0.85, so every FC import ran on ground
 // 21% grippier than FC's and no amount of work on the `fc` profile touched
 // it.
 //
 // So the profile may override the DEFAULT ground and only that. A texture
 // that means something — ice, rubber, belt, mud — keeps its own numbers, and
 // so does any piece whose author has set a surface by hand. What is left is
 // exactly the "unset look" the officials and every import wear.
 //
 // **A BAKED default is not a hand-tune** (2026-08-18). Publishing bakes
 // surfaceOf() onto every terrain piece (server.js bakeSurfaces), so every
 // published piece carries `surface.friction` — the texture's own 0.85, not
 // a number anybody chose — and "any friction is hand-tuned" quietly defeated
 // this override on every published import: the Sticks levels ran their JS
 // build on 0.85 ground while the C loader ran FC's 0.7, and the empty level
 // rolled apart on three of them (verify-fcworld 3). A friction that EQUALS
 // the texture's default is the bake talking; only a friction that differs
 // from it is an author's, and only that wins.
 _terrainSurface(t) {
 const surf = surfaceOf(t);
 const legacy = this.P.terrain;
 if (!legacy) return surf;
 const tex = t.texture || 'granite';
 if (!LEGACY_TEXTURES.has(tex)) return surf;
 const own = t.surface && t.surface.friction;
 const dflt = textureSurface(tex).friction;
 if (typeof own === 'number' && isFinite(own) && Math.abs(own - dflt) > 1e-9) return surf; // hand-tuned wins
 return { ...surf, friction: legacy.friction };
 }

 // The C-path fingerprint: the machine's drawn coordinates, exactly as the
 // importer printed them (fcWorld.print). A player ADDING a piece breaks the
 // att/count test; a player merely MOVING one breaks only this — and a moved
 // piece means the machine is not the source's any more, so the honest build
 // is the JS one.
 _fcPristine(level, designParts) {
 const W = level.fcWorld;
 const mach = [...(level.fixedParts || []), ...designParts]
 .filter(p => p.t === 'wheel' || p.t === 'rod');
 // An EMPTY machine is legitimate since goal wheels became cargo
 // (2026-08-17, sweep find 12476885: goal wheels bolted to the goal rect
 // and nothing else — the whole design is its cargo). The count and
 // print checks below still hold the line for such a level.
 if (!mach.every(p => Array.isArray(p.att))) return false;
 if (W.print == null || !Array.isArray(W.players) || !Array.isArray(W.levels)) return false;
 // The manifests must still map ONE-TO-ONE onto the level's own lists —
 // a hole here puts every later rec on the wrong body, which played as
 // the whole world vanishing (2026-08-17). Any disagreement → JS build.
 if (W.levels.filter(b => !b.dynamic).length !== (level.terrain || []).length) return false;
 if (W.levels.filter(b => b.dynamic).length !== (level.props || []).length) return false;
 if (W.players.filter(b => b.t === 4 || b.goal).length !== (level.goalObjs || []).length) return false;
 const machBlocks = W.players.filter(b => b.t !== 4 && !b.goal);
 if (machBlocks.length !== mach.length) return false;
 // **The print is coordinates only, so the KINDS check against the
 // manifest** (2026-08-17: watch a solve, toggle a stick, hit
 // Play — the run played the BAKED machine and the stop redrew his edit).
 // A stick toggled to water, a wheel's spin flipped: same coordinates,
 // different physics, and the stored manifest already names every
 // block's type — solid 8 / hollow 9, free 5 / cw 6 / ccw 7. A weight
 // dial (gold) has no FC spelling at all, so any weight is an edit.
 const inOrder = mach.slice().sort((a, b) => (a.srcSeq ?? 1e9) - (b.srcSeq ?? 1e9));
 for (let i = 0; i < inOrder.length; i++) {
 const p = inOrder[i], t = machBlocks[i].t;
 if (p.weight != null) return false;
 const want = p.t === 'wheel'
 ? (p.kind === 'cw' ? 6 : p.kind === 'ccw' ? 7 : p.kind === 'free' ? 5 : -1)
 : (p.kind === 'wood' ? 8 : p.kind === 'water' ? 9 : -1);
 if (t !== want) return false;
 }
 return fcMachinePrint(level.fixedParts || [], designParts) === W.print;
 }

 // The machine said in FC's dialect (fcworld.js), or null when it cannot be
 // — and the reason kept on the instance, so a probe (or a solver) can ask
 // why a candidate fell to the JS build. The manifests must still map onto
 // the level's own lists, the same one-to-one the pristine path demands.
 _fcTranspiled(level, designParts, goalPositions) {
 const W = level.fcWorld;
 this._fcRefusal = null;
 if (!Array.isArray(W.players) || !Array.isArray(W.levels)) { this._fcRefusal = 'no manifests'; return null; }
 if (W.levels.filter(b => !b.dynamic).length !== (level.terrain || []).length
 || W.levels.filter(b => b.dynamic).length !== (level.props || []).length) { this._fcRefusal = 'level manifest disagrees with the piles'; return null; }
 const said = fcMachineXml(level, designParts, { goalPositions });
 if (said.refusal) { this._fcRefusal = said.refusal; return null; }
 if (said.players.filter(b => b.t === 4 || b.goal).length !== (level.goalObjs || []).length) { this._fcRefusal = 'goal manifest disagrees'; return null; }
 return said;
 }

 // fcsim's own world for an FC-dialect machine: the XML straight into the C
 // xml/graph/gen (fc_load_xml), recs mapped onto the C bodies in list order,
 // FC's own win test, and every pose read shifted by (dx, dy) into the
 // level's drawn frame. `xml`/`players` are the source's own for a pristine
 // import and fcworld.js's for anything else; `machineOrder` is the machine
 // parts in the XML's block order. The b2 world the constructor made a
 // moment ago is abandoned inside this instance — gen_world brings its own
 // — and both go together at destroy().
 _buildFcWorld(level, xml, players, machineOrder, goalPositions) {
 const E = this.E;
 const W = level.fcWorld;
 this._fcShift = { dx: W.dx, dy: W.dy };
 this._fcWorld = true;
 // the transpiled XML, through fcsim's OWN parse — fp_strtod reads the
 // paste's exact digits, which is where the last ulp lives
 const bytes = new TextEncoder().encode(xml);
 if (bytes.length > E.fc_xml_cap()) throw new Error('fc world too large');
 new Uint8Array(E.memory.buffer, E.fc_xml_buf(), bytes.length).set(bytes);
 if (E.fc_load_xml(bytes.length) < 0) throw new Error('fc world failed to parse');
 // **The LEVEL recs first** — statics draw from their defs, but the view
 // walks this.terrain to draw them at all, and props draw from live
 // poses; skipping these was the whole world vanishing on Play
 // (2026-08-17). Level blocks registered in XML order = manifest order =
 // the converted level's own list order (_fcPristine holds the counts).
 {
 let lb = 0, ti = 0, pi = 0;
 for (const b of W.levels) {
 if (b.dynamic) {
 const def = (level.props || [])[pi++];
 if (def) {
 this.props.push({ def, body: lb, gravityScale: 1 });
 this._matByBody[lb] = MAT.PROP;
 }
 } else {
 const def = (level.terrain || [])[ti++];
 if (def) {
 this.terrain.push({ def, body: lb, edgeBodies: null, moving: false, motion: null, group: null });
 this._matByBody[lb] = materialForTexture(def.texture);
 }
 }
 lb++;
 }
 }
 // …then the player list in the XML's own order — which is the paste's.
 // Goal blocks pull from level.goalObjs as TWO family queues (rect goals
 // are boxes, goal WHEELS came in as balls), so each family only needs
 // its own internal order; the machine pulls from `machineOrder`, the
 // parts in the order their blocks were written.
 const machineParts = machineOrder;
 const boxGoals = (level.goalObjs || []).filter(g => g.shape === 'box');
 const ballGoals = (level.goalObjs || []).filter(g => g.shape === 'ball');
 let body = E.fc_level_count(), bgi = 0, wgi = 0, mi = 0;
 for (const b of players) {
 if (b.t === 4 || b.goal) {
 const def = b.t === 4 ? boxGoals[bgi++] : ballGoals[wgi++];
 // x0/y0 is where the piece STARTED this run — the staged (dragged)
 // spot when there is one, as on the JS build — which is what the
 // return-and-escape rules measure from
 const gi = def ? (level.goalObjs || []).indexOf(def) : -1;
 const pos = (def && goalPositions && goalPositions[gi]) || def;
 if (def) this.goals.push({ def, body, x0: pos.x, y0: pos.y, gravityScale: 1, ceiling: false });
 this._matByBody[body] = MAT.GOAL;
 } else {
 const part = machineParts[mi++];
 if (part && b.t >= 5 && b.t <= 7) {
 this.wheels.push({ part, body, fixed: false });
 this._matByBody[body] = MAT.WHEEL;
 } else if (part) {
 const len = Math.hypot(part.x2 - part.x1, part.y2 - part.y1);
 this.rods.push({ part, body, len, fixed: false });
 this._matByBody[body] = part.kind === 'water' || part.kind === 'ghost' ? MAT.WATER : MAT.ROD;
 }
 }
 body++;
 }
 this.jointCount = this.goals.length + machineParts.length; // a display figure, not a solver one
 this.dynamics = []; // no planets on an imported level
 this.sweep = this._allPartsVoid();
 this._lerpRecs = [...this.props, ...this.goals, ...this.wheels, ...this.rods];
 }

 // Queue attachment coordinates for the NEXT body created (§5.4). The
 // engine's collision filter is asked exactly once per pair, at body
 // creation, so "these two share a pin and therefore never collide" has to
 // be known before either body exists — this replaces both v3 mechanisms at
 // once (the revolute's collideConnected exemption AND the filter joints
 // that covered coincident-but-unbolted pairs). Staging a coordinate nothing
 // else shares excludes nothing, so every attachment point is staged without
 // asking which ones will meet a partner.
 _stagePins(coords) {
 for (const c of coords) this.E.pin_next(c.x, c.y);
 }

 // One body, one shape, in the engine's own forms: circle, or SHARP box.
 // `sharpBox` and `box` are one case now — `cornerRadiusOf` is gone with the
 // engine, because FC's crates have corners, and so do FC's rods. Rolling
 // resistance is gone with it (grass/sand/mud keep their friction and lose
 // their extra drag): the old solver carried it as a material field, this
 // one has no such concept, and it is noted here so its absence is a fact
 // rather than a mystery.
 //
 // Belts: the authored sign is "positive runs rightward on an unrotated
 // floor", and that is the engine's own sign — measured at the smoke gate
 // (+50 drove the crate +x at exactly 50 units/s). The v3 boundary negated;
 // this one passes it straight through.
 _addBody(geom, pose, m, damp = null) {
 const E = this.E;
 // authored in m/s (the surfaces.js contract, shared with beltScrollPx's
 // visual scroll) — the engine wants units/s, hence the one ×PPM
 if (m.tangentSpeed) E.set_tangent_speed(m.tangentSpeed * PPM);
 const density = m.density ?? 0; // 0 is FC's own "static"
 const lin = damp ? damp.linear : 0, ang = damp ? damp.angular : 0;
 let idx;
 if (geom.circle != null) {
 idx = E.add_circle(pose.x, pose.y, geom.circle, density,
 m.friction, m.restitution ?? 0, lin, ang, m.category, m.mask);
 // add_circle spawns at angle 0 (the probe API's shape); an authored
 // spawn angle lands via one teleport before anything has velocity.
 if (pose.angle) E.body_teleport(idx, pose.x, pose.y, pose.angle, 0, 0, 0);
 } else {
 const o = geom.sharpBox || geom.box;
 idx = E.add_box(pose.x, pose.y, o.w / 2, o.h / 2, pose.angle || 0, density,
 m.friction, m.restitution ?? 0, lin, ang, m.category, m.mask);
 }
 this._matByBody[idx] = m.mat || 0;
 return idx;
 }

 // Painted terrain (§5.3): the outline is the collision, the interior is
 // empty. The old engine has no chain shape, so the outline becomes a fence
 // of thin static boxes — one BODY per edge, because shapes are fixed at
 // body creation here and a fence of bodies is the same fence.
 //
 // * The OUTER face of each box lies exactly on the authored line: the box
 // is offset half its thickness toward the interior, so from outside —
 // the only side play happens on — the paint collides where it draws.
 // * Which side is "interior" is DECIDED BY TEST, not winding lore: the
 // first edge's candidate normal is checked with a point-in-polygon and
 // the winding sense it implies is applied to every edge. Guessing the
 // winding is how a bowl gets built.
 // * Each box runs half a thickness long at both ends, so neighbouring
 // edges seal their shared corner instead of leaving a wedge.
 //
 // Returns [{idx, lx, ly, la}] — engine body plus the edge's pose in the
 // piece's own frame, which is what lets a painted MOVER teleport the whole
 // fence as one rigid thing (_teleportMover).
 _addPaintEdges(t, m) {
 const pts = paintOutlineOf(t);
 if (!pts || pts.length < 3) return null; // degenerate: no fence, no crash
 const a0 = t.angle || 0;
 const T = 4; // fence thickness, px
 // point-in-polygon (ray cast), once, to orient the fence
 const inside = (x, y) => {
 let inn = false;
 for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
 const yi = pts[i].y, yj = pts[j].y, xi = pts[i].x, xj = pts[j].x;
 if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn;
 }
 return inn;
 };
 let sense = 0;
 const out = [];
 const c0 = Math.cos(-a0), s0 = Math.sin(-a0);
 for (let i = 0; i < pts.length; i++) {
 const p = pts[i], q = pts[(i + 1) % pts.length];
 const dx = q.x - p.x, dy = q.y - p.y;
 const len = Math.hypot(dx, dy);
 if (len < 0.5) continue;
 const ux = dx / len, uy = dy / len;
 if (!sense) {
 // candidate normal (left of travel); probe a whisker inside
 const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
 sense = inside(mx + uy * 2, my - ux * 2) ? 1 : -1;
 }
 const nx = sense * uy, ny = sense * -ux; // inward normal
 const cx = (p.x + q.x) / 2 + nx * (T / 2);
 const cy = (p.y + q.y) / 2 + ny * (T / 2);
 const ang = Math.atan2(dy, dx);
 const idx = this._addBody({ sharpBox: { w: len + T, h: T } },
 { x: cx, y: cy, angle: ang }, m);
 // the edge's pose in the piece frame, for movers
 const rx = cx - t.x, ry = cy - t.y;
 out.push({ idx, lx: rx * c0 - ry * s0, ly: rx * s0 + ry * c0, la: ang - a0 });
 }
 return out.length ? out : null;
 }

 _buildPart(part, fixed) {
 if (part.t === 'wheel') {
 // A SHELLED (imported) wheel is built the way get_wheel_shell builds
 // it: body at the resolved hub NODE, at the SOURCE radius and rotation.
 // A native wheel is exactly what it always was.
 const WS = this._wheelShellOf.get(part);
 this._stagePins(this._plannedPins.get(part) || []);
 const body = this._addBody({ circle: WS ? WS.r : part.r },
 WS ? { x: WS.x, y: WS.y, angle: WS.rot } : { x: part.x, y: part.y, angle: 0 }, {
 density: this.P.wheel.density, friction: this.P.wheel.friction, restitution: this.P.wheel.restitution,
 category: CAT.WHEEL, mask: MASK.WHEEL, mat: MAT.WHEEL,
 }, { linear: 0, angular: this.P.wheel.angularDamping });
 this._bodyOf.set(part, body);
 this.wheels.push({ part, body, fixed });
 } else if (part.t === 'rod') {
 // A DECLARED rod's physical span runs node-to-node (see _planJoints —
 // FC rebuilds the shell from the resolved graph), and its shell is
 // derived with fcsim's OWN EXPRESSIONS (get_rod_shell): sqrt(dx²+dy²)
 // rather than hypot, `x0 + dx/2` rather than the midpoint sum, the
 // engine's fp_atan2 rather than Math's. None of that is pedantry: the
 // two engines agreed to 2e-13 for thirteen frames and then a
 // degenerate stack impact amplified exactly those last bits into half
 // a unit in one step. Hand-built rods keep the arithmetic they have
 // always had.
 const S = this._nodeSpanOf.get(part);
 const dx = S ? S.x2 - S.x1 : part.x2 - part.x1;
 const dy = S ? S.y2 - S.y1 : part.y2 - part.y1;
 const len = S ? Math.sqrt(dx * dx + dy * dy) : Math.hypot(dx, dy);
 if (len < ROD_SKIP_LEN) return;
 // Three kinds now, so this is a lookup rather than a boolean (§5.2).
 // A GHOST is a water stick that has also stopped touching the world:
 // same thin, light body, same lack of bounce, mask 0.
 const ghost = part.kind === 'ghost';
 const water = part.kind === 'water' || ghost;
 // Clamped, not trusted: a design arrives over the wire (a replay payload,
 // a hand-written level's fixedParts) and nothing on the server bounds
 // this, so a weight of 1e9 would be a NaN pose one contact later. Same
 // belt-and-braces reasoning as surfaceOf (§5.9).
 const weight = clampRodWeight(part.weight ?? ROD_WEIGHT_MIN);
 // **Every rod is a SHARP BOX now, on both profiles** (2026-08-17): FC's
 // rod is a rectangle (gen.c) and the engine has circle and polygon only
 // — the capsule left with the solver that had one. What each profile
 // still decides is the FOOTPRINT:
 //
 // `fc` FC's own: 8 units wide solid, 4 hollow, ending at its
 // pins (pinToPin), density flat 1.
 // `lifirik` one 4 px thickness, wood heavy by density (2.0), and the
 // box runs ROD_THICK longer than the pin span — the same
 // end-to-end length the old capsule's overhanging caps
 // gave it, so a stick still bridges what it used to bridge.
 //
 // The corners are a real character change for `lifirik` (a cap rolls
 // off a ledge where a corner catches) and exactly the character FC
 // always had. The renderer still draws a round-capped stroke either
 // way, exactly as before.
 const RP = this.P.rod;
 const thick = water ? (RP.waterThick ?? ROD_THICK) : (RP.woodThick ?? ROD_THICK);
 const boxLen = RP.pinToPin ? len : len + thick;
 const cx = S ? S.x1 + dx / 2 : (part.x1 + part.x2) / 2;
 const cy = S ? S.y1 + dy / 2 : (part.y1 + part.y2) / 2;
 const ang = S ? this.E.fp_atan2(dy, dx) : Math.atan2(dy, dx);
 this._stagePins(this._plannedPins.get(part) || []);
 const body = this._addBody({ sharpBox: { w: boxLen, h: thick } },
 { x: cx, y: cy, angle: ang }, {
 // water rods are light (low density above), so any bounce reads as a
 // much bigger, more erratic velocity change per collision than the
 // same restitution gives a heavier wood rod — zeroed out entirely
 // for water (wood keeps its small bounce).
 density: (water ? this.P.rod.waterDensity : this.P.rod.woodDensity) * weight,
 friction: this.P.rod.friction,
 restitution: water ? this.P.rod.waterRestitution : this.P.rod.woodRestitution,
 category: ghost ? CAT.GHOST : water ? CAT.WATER : CAT.ROD,
 mask: ghost ? MASK.GHOST : water ? MASK.WATER : MASK.ROD,
 mat: water ? MAT.WATER : MAT.ROD,
 }, {
 // A stick's own damping, overridable per-Simulation so a probe can
 // sweep it. It is the one number FC1 sets on rods and on NOTHING
 // else — see ROD_ANGULAR_DAMPING.
 linear: this.opts?.rodLinearDamping ?? this.P.rod.linearDamping,
 angular: this.opts?.rodAngularDamping ?? this.P.rod.angularDamping,
 });
 this._bodyOf.set(part, body);
 this.rods.push({ part, body, len, fixed });
 }
 }

 // Sharing an exact coordinate is what forms a joint (§5.4) — and WHICH
 // pairs will joint is decided HERE, before a single body exists.
 //
 // It has to be, and for a subtler reason than it used to. The engine's
 // filter answers once, at body creation, so "these two never collide" must
 // be staged onto the bodies at birth — that part was always true. What
 // moved (2026-08-17, on the imported walker that threw 37% long) is WHAT
 // gets staged: only the coordinates a JOINT will actually form at. FC's own
 // law is share-a-NODE — fcsim's collision_filter excludes two blocks that
 // are jointed at the same point, and nothing else — so a stick whose end is
 // DECLARED FREE collides with the pile it rests in, even sitting exactly on
 // it. Staging every attachment coordinate (the old rule, inherited from the
 // v3 filter-joint pass) exempted 970 such pairs on that walker: its 32-rod
 // bundle fell as a zero-width sheaf instead of shoving itself into a fan,
 // and the machine kept the energy FC spends on the shove.
 //
 // So this method PLANS: the same buckets, the same chain/att/motor rules,
 // producing a joint list plus, per entity, the coordinates it will be
 // jointed at — those and only those get staged by the creation loops, and
 // _makeJoints turns the plan into constraints once the bodies exist.
 _planJoints(designParts, fixedParts, goalPositions) {
 this._jointPlan = [];
 this._plannedPins = new Map(); // entity → [{x, y}], deduped per entity
 this._motorisedHubs = new Set();
 this._nodeSpanOf = new Map(); // rod part → its node-to-node physical span
 this._wheelShellOf = new Map(); // wheel part → its FC shell (hub node, raw radius, rotation)
 const planPin = (ent, x, y) => {
 let arr = this._plannedPins.get(ent);
 if (!arr) this._plannedPins.set(ent, arr = []);
 if (!arr.some(p => p.x === x && p.y === y)) arr.push({ x, y });
 };
 const plan = (a, b, x, y, spin, torque, motor) => {
 this._jointPlan.push({ a, b, x, y, spin, torque, motor });
 planPin(a, x, y);
 planPin(b, x, y);
 };

 // `fixed` prop pins bolt the prop to the static background — planned
 // first, matching the order they were always created in.
 for (const p of (this.level.props || [])) {
 for (const pin of propPins(p)) {
 if (pin.fixed) plan(ANCHOR, p, pin.x, pin.y, 0, 0, false);
 }
 }

 // **FC'S OWN GRAPH, ported from fcsim graph.c** (2026-08-17, found on the
 // imported walker that ran 5% hot and missed its win by one rect).
 //
 // For parts that DECLARE (`att`), fcsim does not joint by coordinate at
 // all. Walking blocks in order, each attachment point either JOINS the
 // closest existing node among its named targets' nodes — at ANY distance,
 // the source's sub-unit roundings included — or FOUNDS a new node at its
 // own position. A node keeps the coordinate it was founded with, so a
 // chain of thirty roundings collapses onto its first owner's numbers;
 // and a rod's PHYSICAL SPAN is then rebuilt node-to-node, which is the
 // one kind of "snap" FC really does perform. Anchoring each link at its
 // own raw endpoint instead seeded a 0.02-unit error at frame 4 that grew
 // to a 28-px miss by the win.
 //
 // Joints per node are the consecutive chain gen_joint_stack builds, in
 // attach order. The bucket pass below still handles OPEN (`true`) ends
 // and everything that never declared — every machine built in this
 // editor included.
 const E = this.E;
 const allParts = [...designParts, ...fixedParts];
 const partById = new Map();
 for (const p of allParts) if (p.id != null) partById.set(p.id, p);
 // **No axle, no power** (2026-08-24, util.wheelHasAxle): a native powered
 // wheel is a motor only when something sits on its hub — a rod end, or
 // any pin (crate / ball goal piece, loose pin, prop, terrain). Decided
 // once per build, from every part and pin in the world — a level's own
 // fixed rod or cargo pin is as good a shaft as the player's. Shelled
 // (FC-imported) wheels never consult this: FC's law is FC's, and the
 // bit-exact replays stay bit-exact.
 this._axledWheels = new Set();
 for (const p of allParts) {
 if (p.t === 'wheel' && (p.kind === 'cw' || p.kind === 'ccw')
 && wheelHasAxle(p, allParts, this.level, goalPositions)) {
 this._axledWheels.add(p);
 }
 }
 const nativePowerOf = (p) => (this._wheelShellOf.has(p) || this._axledWheels.has(p));
 // **A shell speaks only while it AGREES with the part** (2026-08-18,
 // night of "PLAY moves them back"). The shell froze the
 // import-time geometry for last-ulp fidelity, and every consumer below
 // read it INSTEAD of the stored coordinates — so a stick the editor
 // moved rebuilt at its import position the moment Play pressed, while
 // the editor kept drawing the move. An edit divorces the two; the
 // stored coordinates are then the truth and the shell must step aside.
 // "Agrees" allows for what import itself did to the stored ends: a
 // snapped end's expectation is its recorded snap (snap1/snap2), and a
 // wheel's hub may sit up to its 2-unit snap from the raw shell.
 const shellLive = (p) => {
 const s = p.shell;
 if (!s) return false;
 if (p.t === 'wheel') {
 return Math.abs(s.x - p.x) <= 2.5 && Math.abs(s.y - p.y) <= 2.5;
 }
 if (s.len == null) return false;
 const cw = Math.cos(s.rot) * s.len / 2, sw = Math.sin(s.rot) * s.len / 2;
 const e1 = p.snap1 ?? { x: s.x - cw, y: s.y - sw };
 const e2 = p.snap2 ?? { x: s.x + cw, y: s.y + sw };
 return Math.abs(e1.x - p.x1) < 0.01 && Math.abs(e1.y - p.y1) < 0.01
 && Math.abs(e2.x - p.x2) < 0.01 && Math.abs(e2.y - p.y2) < 0.01;
 };
 const skipRod = (p) => p.t === 'rod'
 && (shellLive(p) && p.shell.len != null
 ? p.shell.len
 : Math.hypot(p.x2 - p.x1, p.y2 - p.y1)) < ROD_SKIP_LEN;
 {
 // fcsim's own cap: an end joins the closest candidate node within 10
 // units (IMPORT_JOINT_EDGE_MAX_DISTANCE), else founds its own. The
 // candidate list is per-BLOCK — every node of every part this one
 // names — and BOTH ends search it, which is what bolts a chained pile
 // at both of its coincident ends and makes it the rigid two-node
 // bundle FC actually simulates.
 const JOIN_MAX = 10.0;
 const nodes = []; // {x, y, atts: [part…]} in creation order
 const nodesOfPart = new Map(); // part → its resolved nodes (rod 2, wheel 1 + rings)
 // A declared part's endpoints derive from its SOURCE SHELL through the
 // ENGINE's own fixed-point trig (get_rod_endpoints, verbatim) — the
 // stored endpoints went through JS trig and a 4-dp round at import, and
 // on a pile of coincident sticks either difference is a seed the first
 // impact amplifies. Parts without a shell (hand-built) keep their
 // stored endpoints: they never had another representation.
 const endsOf = (p) => {
 if (shellLive(p) && p.shell.len != null) {
 // get_rod_endpoints to the OPERATION: `w_half` is halved FIRST and
 // multiplies second — (cos·len)/2 rounds differently in the last
 // bit, and the last bit is the whole point of this path.
 const wHalf = p.shell.len / 2;
 const cw = E.fp_cos(p.shell.rot) * wHalf;
 const sw = E.fp_sin(p.shell.rot) * wHalf;
 return [{ x: p.shell.x - cw, y: p.shell.y - sw },
 { x: p.shell.x + cw, y: p.shell.y + sw }];
 }
 return [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }];
 };
 const hubOf = (p) => (shellLive(p) ? { x: p.shell.x, y: p.shell.y } : { x: p.x, y: p.y });
 // fcsim walks the paste's own order — a declaration only finds a node
 // that already exists, so the walk order IS part of the graph. The
 // build-area split interleaves the pools; `srcSeq` restores the source.
 const ordered = allParts.some(p => p.srcSeq != null)
 ? [...allParts].sort((a, b) => (a.srcSeq ?? 1e9) - (b.srcSeq ?? 1e9))
 : allParts;
 for (const p of ordered) {
 if (!Array.isArray(p.att) || skipRod(p)) continue;
 const cands = [];
 for (const v of p.att) {
 if (v == null || v === true) continue;
 const t = partById.get(v);
 if (t && t !== p && nodesOfPart.has(t)) cands.push(...nodesOfPart.get(t));
 }
 const closest = (x, y) => {
 let best = null;
 for (const n of cands) {
 const d = Math.hypot(n.x - x, n.y - y);
 if (d < (best ? best.d : JOIN_MAX)) best = { d, n };
 }
 return best ? best.n : null;
 };
 const found = (x, y) => {
 const n = { x, y, atts: [], blocks: new Set() };
 nodes.push(n);
 return n;
 };
 const attach = (n, part) => { n.atts.push(part); n.blocks.add(part); };
 if (p.t === 'wheel') {
 const h = hubOf(p);
 const hub = closest(h.x, h.y) || found(h.x, h.y);
 attach(hub, p);
 // ring pins are the spokes' descendants: block-OWNED nodes of their
 // own, so a DECLARED piece naming this wheel can land on one. A
 // SHELLED wheel gets FC's exact four — hub + fp trig at the SOURCE
 // radius and rotation (add_wheel, verbatim, its 3π/2 literal
 // included); a hand-built wheel's lattice rides wheelPinOffsets,
 // whose main ring now sits on the rim for exactly this reason.
 let rings;
 if (shellLive(p) && p.shell.r != null) {
 const A4 = [0.0, Math.PI / 2, Math.PI, 4.71238898038469];
 rings = A4.map(a => {
 const n = found(hub.x + E.fp_cos(p.shell.rot + a) * p.shell.r,
 hub.y + E.fp_sin(p.shell.rot + a) * p.shell.r);
 n.blocks.add(p);
 n.gen = p; // block-OWNED: the wheel heads this node's chain (gen_joint_stack)
 return n;
 });
 } else {
 rings = wheelPinOffsets(p.r).map(([ox, oy]) => {
 const n = found(h.x + ox, h.y + oy);
 n.blocks.add(p);
 n.gen = p;
 return n;
 });
 }
 // the wheel BODY sits at its resolved hub, at its SOURCE radius and
 // rotation — get_wheel_shell reads the node and the raw width, and
 // a ladder-snapped stand-in is a different machine. A MOVED wheel's
 // shell is stale (see shellLive) and stays out of this map, so the
 // body build and the motor law both fall back to the editor's own
 // reading of the part.
 if (shellLive(p) && p.shell.r != null) {
 this._wheelShellOf.set(p, { x: hub.x, y: hub.y, r: p.shell.r, rot: p.shell.rot });
 }
 nodesOfPart.set(p, [hub, ...rings]);
 } else {
 const [e0, e1] = endsOf(p);
 let n0 = closest(e0.x, e0.y);
 let n1 = closest(e1.x, e1.y);
 // **One hinge per pair — fcsim's own guard** (add_rod): both ends
 // may join nodes, unless the two nodes are one node or already
 // share an attached block; then the second end FOUNDS its own.
 // This is what keeps a chained pile bolted at exactly one end and
 // its far ends free — 44 joints on the walker, not 75.
 if (n0 && n1 && (n0 === n1 || [...n0.blocks].some(b => n1.blocks.has(b)))) n1 = null;
 if (!n0) n0 = found(e0.x, e0.y);
 attach(n0, p);
 if (!n1) n1 = found(e1.x, e1.y);
 attach(n1, p);
 nodesOfPart.set(p, [n0, n1]);
 // the span runs node-to-node — THIS is FC's snap, and it is part
 // of the physics build, not a mutation of the stored design
 this._nodeSpanOf.set(p, { x1: n0.x, y1: n0.y, x2: n1.x, y2: n1.y });
 }
 }
 // gen_joint_stack: per node, consecutive pairs in attach order — and a
 // block-OWNED node (a wheel's spoke) chains from its OWNER first, which
 // is how a rod bolted to a spoke is bolted to the WHEEL.
 for (const n of nodes) {
 const line = [];
 if (n.gen) line.push(n.gen);
 for (const p of n.atts) if (!line.includes(p)) line.push(p);
 // a wheel's own SPIN at this node — nonzero only at its hub. A shelled
 // (imported) wheel spins with FC's own numbers — a flat ±5 whatever the
 // radius (add_wheel) — where a native wheel keeps LIFIRIK's r-scaled law.
 const spinOf = (p) => {
 if (!p || p.t !== 'wheel' || p.kind === 'free') return 0;
 const sh = this._wheelShellOf.get(p);
 // no axle, no power — native wheels only; a shell keeps FC's law
 if (!sh && !this._axledWheels.has(p)) return 0;
 const hub = sh ? (n.x === sh.x && n.y === sh.y) : (n.x === p.x && n.y === p.y);
 if (!hub) return 0;
 const dir = p.kind === 'cw' ? +1 : -1;
 return dir * (sh ? 5 : wheelMotorSpeed(p.r, this.P));
 };
 const torqueOf = (p) => (this._wheelShellOf.has(p) ? 50000000 : wheelMotorTorque(p.r, this.P) * TORQUE_FC);
 for (let i = 0; i + 1 < line.length; i++) {
 const A = line[i], B = line[i + 1];
 const { spin, torque, motor, wheel } = this._fcMotor(spinOf(A), spinOf(B), i === 0, A, B, torqueOf);
 if (motor) this._motorisedHubs.add(wheel);
 plan(A, B, n.x, n.y, spin, torque, motor);
 }
 }
 }

 // Gather attachment points into buckets; Map iterates in insertion order.
 const buckets = new Map();
 const addPin = (x, y, entry) => {
 const key = jointKey(x, y);
 let arr = buckets.get(key);
 if (!arr) buckets.set(key, arr = []);
 arr.push({ ...entry, x, y });
 };

 // every goal piece: pins around its (possibly staged) position
 (this.level.goalObjs || []).forEach((g, i) => {
 const pos = (goalPositions && goalPositions[i]) || g;
 for (const [ox, oy] of goalPinOffsets(g)) {
 addPin(pos.x + ox, pos.y + oy, { kind: 'goal', ent: g });
 }
 });

 // props: author-placed pins, already in world coordinates. These make a
 // prop a connectable part of a machine — a rod end dropped on one joints
 // to it exactly like a goal-piece pin. Their `fixed` flag was planned
 // above, not here.
 for (const p of (this.level.props || [])) {
 for (const pin of propPins(p)) {
 addPin(pin.x, pin.y, { kind: 'prop', ent: p });
 }
 }

 // TERRAIN pins (2026-08-07), on exactly the same terms — which is the
 // whole reason they were cheap to add: this map pairs BODIES that share a
 // coordinate, and it has never cared what kind of body. What each one
 // means falls out of the body it lands on rather than needing a flag:
 //
 // static terrain → a bolt to the world. The joint is a free hinge, so
 // a stick pinned to a wall SWINGS from it and cannot
 // be pulled off — which is what an author reaching
 // for "attach this here" means.
 // a moving platform → the same hinge, travelling. The rod rides the
 // kinematic body, so a swing arm on a lift is one
 // pin rather than a mechanism.
 //
 // A painted outline gets them too: the pin is a coordinate, and the body
 // is the body whatever its shape.
 for (const t of (this.level.terrain || [])) {
 for (const pin of propPins(t)) {
 addPin(pin.x, pin.y, { kind: 'terrain', ent: t });
 }
 }

 // THE LEVEL'S OWN PINS (2026-08-08) — a pin on nothing, bolted to the world.
 //
 // No new machinery at all, which is the point: `anchorBody` is the static
 // world body a `fixed` prop pin already hinges on, and this map has never
 // cared what kind of body it is pairing. So a rod end that lands on a loose
 // pin gets the identical free hinge it gets from a pin on a static wall —
 // the third case util.js's `piecePins` note already described, which simply
 // had nowhere to be stored until now.
 //
 // Every loose pin names the SAME body, so two of them sharing a coordinate
 // fall out through the same-body test below rather than jointing the world
 // to itself. A BOSS pin (util.loosePinOffsets) is the same statement made
 // nine times — centre and rim slots, each a world bolt.
 for (const pin of (this.level.pins || [])) {
 for (const [ox, oy] of loosePinOffsets(pin)) {
 addPin(pin.x + ox, pin.y + oy, { kind: 'world', ent: ANCHOR });
 }
 }

 // wheels: hub (isCenter — motor eligibility) + ring pins; rods: endpoints.
 // Sources: design.parts THEN level.fixedParts — fixed parts joint
 // identically (§5.4). Wheels/rods are created in that same order.
 const partEntry = (part) => {
 if (part.t === 'wheel') {
 addPin(part.x, part.y, { kind: 'wheel', ent: part, part, isCenter: true });
 for (const [ox, oy] of wheelPinOffsets(part.r)) {
 addPin(part.x + ox, part.y + oy, { kind: 'wheel', ent: part, part });
 }
 } else if (part.t === 'rod') {
 const len = Math.hypot(part.x2 - part.x1, part.y2 - part.y1);
 if (len < ROD_SKIP_LEN) return; // _buildPart skips it, so the plan must too
 addPin(part.x1, part.y1, { kind: 'rod', ent: part, part });
 addPin(part.x2, part.y2, { kind: 'rod', ent: part, part });
 }
 };
 for (const part of designParts) partEntry(part);
 for (const part of fixedParts) partEntry(part);

 // Entities are objects (or the ANCHOR sentinel), so identity is equality.
 const entKey = (e) => e;
 const sameEnt = (a, b) => a.ent === b.ent;

 // ---- what an imported piece DECLARES (see the filter below) ----
 //
 // `att` is one entry per attachment point, in the source's order: a rod's
 // two ends, a wheel's hub. Which point this bucket entry IS decides which
 // entry of `att` speaks for it — that is the per-END distinction the whole
 // thing exists for, since a stacked stick shares BOTH of its ends and is
 // bolted at only one of them.
 //
 // A wheel answers 0 for its ring pins as well as its hub: the ring lattice
 // is LIFIRIK's own (§4), the source has no such thing, and a wheel that is
 // bolted to several pieces has already opened up (`true`) on the import
 // side — so the rings resolve to "weld what you touch" exactly as before.
 const attIndexOf = (e) => {
 if (!e.part || !Array.isArray(e.part.att)) return -1;
 if (e.kind === 'wheel') return 0;
 if (e.kind !== 'rod') return -1;
 return (e.x === e.part.x1 && e.y === e.part.y1) ? 0 : 1;
 };
 const declaresAt = (e) => attIndexOf(e) >= 0;

 // **WHICH PAIRS GET A JOINT, when more than two pieces share a coordinate
 // — and the two profiles answer differently** (2026-08-15, on request).
 //
 // LIFIRIK pins every pair: N pieces on a pin, C(N, 2) joints. FC's
 // `gen_joint_stack` (fcsim gen.c) walks its attach list and joints
 // CONSECUTIVE pieces only: N - 1. At two pieces the two rules are the same
 // joint, so ordinary machines are untouched and only STACKS diverge.
 //
 // It is not a cost difference, which is why it is worth a profile flag.
 // Measured in FC's own solver (scripts/probe-jointstack.mjs): 31 coincident
 // rods hung off a pin drift 54 px under the chain and 0.01 px under
 // all-pairs, about 1.7 px per rod, starting at exactly three. Coincident
 // rods collide and shove each other apart; a revolute joint holds only to
 // within a slop, so a chain accumulates that slop once per link while
 // all-pairs keeps every piece one hop from the anchor. Raising the
 // iteration count does not touch it (10 → 300 moves 54.21 to 54.32), so it
 // is the shape of the constraint graph and not the budget spent solving it.
 // A stick stack is therefore a floppy bundle in FC and a rigid beam here,
 // and that is a technique behaving differently, not a rounding error.
 //
 // **The chain's ORDER is the bucket's**, which is insertion order and so
 // deterministic (§5.8): goal pins, props, terrain, the level's own pins,
 // then the design's parts and the level's fixed parts. That puts anchors at
 // the HEAD, which is what FC's `joint->gen` amounts to — machine pieces
 // chain off the thing they are bolted to rather than the anchor landing in
 // the middle of the run. FC reads its order off the attach lists in the
 // saved design; we have no such list, so the order a piece arrived in is
 // the nearest honest thing.
 //
 // Deduped by ENTITY first: a chain must link distinct pieces or a repeated
 // one silently breaks it in two, where all-pairs merely skips that pair.
 const pairsAt = (entries) => {
 const out = [];
 if (!this.P.jointChain) {
 for (let i = 0; i < entries.length; i++) {
 for (let j = i + 1; j < entries.length; j++) out.push([entries[i], entries[j]]);
 }
 return out;
 }
 const seen = new Set(), line = [];
 for (const e of entries) {
 const k = entKey(e.ent);
 if (seen.has(k)) continue;
 seen.add(k);
 line.push(e);
 }
 for (let i = 0; i + 1 < line.length; i++) out.push([line[i], line[i + 1]]);
 return out;
 };

 // an entry's own SPIN at this bucket: a powered wheel's, at its hub —
 // if it has earned its motor (no axle, no power)
 const spinOfEntry = (e) => (e.kind === 'wheel' && e.isCenter && e.part.kind !== 'free'
 && nativePowerOf(e.part)
 ? (e.part.kind === 'cw' ? +1 : -1) * wheelMotorSpeed(e.part.r, this.P) : 0);
 const torqueOfPart = (p) => wheelMotorTorque(p.r, this.P) * TORQUE_FC;
 const wheelPairs = new Map(); // wheel → the non-rod entities it is already jointed to (see below)
 const partOrd = new Map();
 allParts.forEach((p, i) => partOrd.set(p, i));
 const hubOccupiedBy = (wheelEntry, otherEnt) => {
 const hub = buckets.get(jointKey(wheelEntry.part.x, wheelEntry.part.y));
 return !!(hub && hub.some(e => e.ent === otherEnt));
 };
 // Two wheels that share both hubs at different points (a standard wheel
 // sitting on a large wheel's face: small hub on the inner ring, small
 // rim on the large hub) used to joint at whichever hub was processed
 // first — the large one — so they locked at the SMALL wheel's edge.
 // Prefer the smaller wheel's axle; equal size, the one added later.
 const preferredWheelHub = (a, b) => {
 const hubA = hubOccupiedBy(a, b.ent), hubB = hubOccupiedBy(b, a.ent);
 if (hubA && hubB) {
 const ra = a.part.r || 0, rb = b.part.r || 0;
 if (ra !== rb) return ra < rb ? a : b;
 return (partOrd.get(a.ent) ?? 0) >= (partOrd.get(b.ent) ?? 0) ? a : b;
 }
 if (hubA) return a;
 if (hubB) return b;
 return null;
 };
 for (const [, entries] of buckets) {
 if (entries.length < 2) continue;
 // **The pair's PLACE in the chain decides the motor** (FC's rule, below):
 // the pairs come out of pairsAt in chain order, and only the first one
 // is "first". Skipped pairs (same piece; both sides declaring) do not
 // count as the first — a chain that opens with a skipped pair is one FC
 // never saw, and the next real pair is its opening.
 let first = true;
 for (const [e0, e1] of pairsAt(entries)) {
 let A = e0, Bb = e1;
 if (sameEnt(A, Bb)) continue; // skip same-piece pairs
 // **A wheel shares at most ONE joint with any non-rod body**
 // (2026-08-19 wheel-on-wheel; 2026-08-26 any pin). Two wheels on one
 // axle share every pin of the smaller — hub and rings — and a wheel
 // snapped onto a crate (or ball, or boss pin) does the same, because
 // goal pieces wear the wheel's own lattice. The coordinate rule then
 // laid a revolute at every coincidence and the extra hinges welded
 // the motor shut: a crate pin on the hub counted as an axle, the
 // motor came on, and nothing could turn. One joint, and if they
 // share the hub that joint is the hub — the shaft the motor pushes
 // against. A rod is the exception: two ends on two of a wheel's
 // pins is a brace, and must stay one.
 //
 // **Two wheels attach by an AXLE** (2026-08-26). Putting a standard
 // wheel on a large wheel's face shares the large hub (the standard's
 // rim) AND the standard hub (the large inner ring). The large hub
 // is processed first, so the joint used to land on the standard's
 // EDGE. Prefer the smaller wheel's hub; equal size, the one added
 // later — "when a wheel is added to another wheel it should be
 // attached by its axle."
 {
 const w = A.kind === 'wheel' ? A : (Bb.kind === 'wheel' ? Bb : null);
 const other = w === A ? Bb : A;
 if (w && other.kind !== 'rod') {
 let seenWith = wheelPairs.get(w.ent);
 if (!seenWith) wheelPairs.set(w.ent, seenWith = new Set());
 if (seenWith.has(other.ent)) continue;
 if (other.kind === 'wheel') {
 const prefer = preferredWheelHub(A, Bb);
 if (prefer && !prefer.isCenter) continue;
 seenWith.add(other.ent);
 let back = wheelPairs.get(other.ent);
 if (!back) wheelPairs.set(other.ent, back = new Set());
 back.add(w.ent);
 } else {
 if (!w.isCenter && hubOccupiedBy(w, other.ent)) continue;
 seenWith.add(other.ent);
 }
 }
 }
 // **A DECLARED piece says what it is bolted to, and touching is not
 // enough** (2026-08-16). LIFIRIK infers joints from shared coordinates
 // because that is how its editor works, and for anything built here it
 // is the only truth there is. An imported FC machine carries the real
 // answer on the pieces themselves (`att`, see fcimport.js) and the two
 // disagree: a pile of identical sticks shares BOTH of its ends, so the
 // coordinate rule welds it into a lump at both while the source pinned
 // it at one — and a weight welded to the arm it hangs from cannot swing.
 //
 // **Both sides must be declaring**, which is what scopes this. A rod
 // landing on a goal-piece pin, a prop, terrain, a level pin or any
 // hand-built part still joints by coordinate: that is the game's rule,
 // and one imported piece does not get to unbolt the level around it.
 // The pools are irrelevant — a design part and a fixed part that both
 // came from one paste are as declared as two of either.
 //
 // An id-NAMED pair was already planned from its declaration above (or
 // deliberately dropped by it); only an OPEN (`true`) end still welds
 // what it touches here.
 if (declaresAt(A) && declaresAt(Bb)) {
 const va = A.part.att[attIndexOf(A)] ?? null;
 const vb = Bb.part.att[attIndexOf(Bb)] ?? null;
 if (va !== true && vb !== true) continue;
 }
 // **FC's motor rule, not "every rod on the hub gets one"** (2026-08-19,
 // "Addition of extra rod to wheel is making it stronger!?").
 // It did: every (hub, rod) pair in the chain was motorised, so a second
 // rod on a powered hub was a second motor — driven, not hanging — and
 // the wheel had twice the drive. See _fcMotor for the rule FC actually
 // runs: one motorised joint per hub stack, everything else a free hinge.
 const { spin, torque, motor, wheel } = this._fcMotor(spinOfEntry(A), spinOfEntry(Bb), first, A.part, Bb.part, torqueOfPart);
 first = false;
 if (motor) this._motorisedHubs.add(wheel);
 plan(A.ent, Bb.ent, A.x, A.y, spin, torque, motor);
 }
 }
 }

 // **FC's motor rule** — gen.c gen_joint_stack, verbatim in spirit: at one
 // node the attached blocks are chained in order, and each consecutive pair
 // (n_i, n_{i+1}) gets a revolute whose motor speed is
 // spin(n_1) − spin(n_0) for the first pair,
 // spin(n_{i+1}) for every later one,
 // where spin is a powered wheel's own ±speed at its hub and 0 for anything
 // else. So a powered wheel motorises EXACTLY ONE joint — with the block
 // beside it in the chain (the one before it, or the first after it when it
 // leads) — and every other rod on that hub is a plain free hinge that hangs.
 // Two cw wheels on one hub read spin(W2) − spin(W1) = 0 for their own pair
 // and spin(W2) against the next, which is FC's stacked-wheel behaviour, kept.
 //
 // body1 is A and body2 is B, as gen_joint has them; b2's motorSpeed is
 // ω(body2) − ω(body1), so (rod, wheel) gets +s and (wheel, rod) gets −s —
 // the same physical drive from either side, and no swapping of the pair.
 // Torque is the wheel's own (r-scaled for a native wheel, FC's literal for a
 // shelled one); when both sides are wheels the one whose spin the pair
 // carries lends its torque.
 _fcMotor(sA, sB, first, A, B, torqueOf) {
 const spin = first ? sB - sA : sB;
 if (!spin) return { spin: 0, torque: 0, motor: false, wheel: null };
 const wheel = (sB !== 0 && B && B.t === 'wheel') ? B : A;
 return { spin, torque: torqueOf(wheel), motor: true, wheel };
 }

 // The plan, made real: bodies exist now (this._bodyOf), so every planned
 // pair becomes a revolute. **SHARING A PLANNED PIN IS WHAT LETS TWO PIECES
 // PASS THROUGH EACH OTHER** — the creation loops staged exactly the
 // coordinates planned above, so the engine's own filter (two bodies
 // remembering the same pin never collide — fcsim's share-a-NODE law,
 // confirmed against the C++ fcsim's `share_joint`, which walks a block's
 // ACTUAL joints) already covers every pair that is bolted here, and only
 // those. A declared-free end sitting exactly on a pile COLLIDES with it,
 // which is FC's rule and the thickness a stick-bundle weight gets its feel
 // from.
 //
 // A joint that GIVES needs no setting: the give the fc profile spent a week
 // tuning v3 toward is this solver's own position correction, on every pin,
 // at no dial at all.
 _makeJoints() {
 const E = this.E;
 for (const j of this._jointPlan) {
 const a = this._bodyOf.get(j.a), b = this._bodyOf.get(j.b);
 if (a == null || b == null) continue; // a planned piece that never built (skipped sliver)
 E.add_joint(a, b, j.x, j.y, j.spin, j.torque);
 this.jointRecs.push({ a, b, x: j.x, y: j.y, motor: j.motor });
 }
 // Lone drives: powered wheels whose hub produced no motorised joint (§5.5).
 for (const w of this.wheels) {
 if (w.part.kind === 'free') continue;
 if (this._motorisedHubs.has(w.part)) continue;
 // no axle, no power (2026-08-24): a bare motor wheel free-rolls. The
 // one lone drive left is a wheel whose AXLE exists but produced no
 // motorised joint — a rod at the hub with nothing on its far end
 // (a pin on the hub always produces a joint) — and an FC shell,
 // which keeps FC's own law.
 if (!this._wheelShellOf.has(w.part) && !this._axledWheels.has(w.part)) continue;
 // the radius rides along: the cap is now the joint motor's own torque
 // law, which is a function of r (see wheelMotorTorque)
 this.loneDrives.push({ body: w.body, dir: w.part.kind === 'cw' ? +1 : -1, r: w.part.r });
 }
 }

 // The lowest and highest authored y in the level. `maxY` is the floor the
 // void hangs under (VOID_DROP below it); `minY` is the ceiling a FLOATING
 // goal piece escapes through (VOID_DROP above it) — see _inVoid. One walk,
 // because the two lines are the same walk and drifting apart is how one of
 // them ends up clearing a piece the other does not.
 _computeLevelBounds() {
 let maxY = 100, minY = 0, minX = 0, maxX = 100;
 const cons = (y) => { if (y > maxY) maxY = y; if (y < minY) minY = y; };
 const consX = (x) => { if (x > maxX) maxX = x; if (x < minX) minX = x; };
 // both edges of every piece: the bottom sets the floor, the top the ceiling
 const span = (y, half) => { cons(y + half); cons(y - half); };
 const spanX = (x, half) => { consX(x + half); consX(x - half); };
 for (const t of (this.level.terrain || [])) {
 // a painted loop's own (x, y) is only its first anchor — the piece
 // reaches as far down as its outline does, and the void line has to
 // clear the whole piece or a goal piece resting on it reads as lost
 if (isPaint(t)) {
 const o = paintOutlineOf(t);
 if (o) { const b = polyBounds(o); cons(b.maxY); cons(b.minY); consX(b.minX); consX(b.maxX); }
 continue;
 }
 span(t.y, t.type === 'ball' ? t.r : (t.h || 0) / 2);
 spanX(t.x, t.type === 'ball' ? t.r : (t.w || 0) / 2);
 }
 for (const p of (this.level.props || [])) {
 span(p.y, p.shape === 'ball' ? p.r : (p.h || 0) / 2);
 spanX(p.x, p.shape === 'ball' ? p.r : (p.w || 0) / 2);
 }
 for (const z of (this.level.buildZones || [])) { span(z.y, z.h / 2); spanX(z.x, z.w / 2); }
 for (const z of (this.level.goalZones || [])) { span(z.y, z.h / 2); spanX(z.x, z.w / 2); }
 return { maxY, minY, minX, maxX };
 }

 // Where the world ends, in the shape the level's gravity gives it.
 //
 // ordinary level {below: y} — the line every existing level uses,
 // VOID_DROP under the lowest thing in it
 // planet level {x, y, outside} — a circle around everything authored,
 // VOID_ESCAPE clear of the furthest of it
 //
 // A planet level cannot use the y line, and not as a matter of taste: the
 // far side of a planet IS "below the level" by that test, so a crate resting
 // peacefully on the south pole of a big enough world would read as fallen
 // out of it. Both shapes are computed from the same authored content — the
 // rule is "clear of everything the author placed", stated in the geometry
 // the level actually has.
 _computeVoid() {
 if (!this.radial) return { below: this.levelMaxY, above: this.levelMinY };
 let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
 const cons = (x, y, ex = 0) => {
 if (x - ex < minX) minX = x - ex;
 if (x + ex > maxX) maxX = x + ex;
 if (y - ex < minY) minY = y - ex;
 if (y + ex > maxY) maxY = y + ex;
 };
 for (const t of (this.level.terrain || [])) {
 // a painted loop's own (x, y) is only its first anchor (§11.1)
 if (isPaint(t)) {
 const o = paintOutlineOf(t);
 if (o) { const b = polyBounds(o); cons(b.minX, b.minY); cons(b.maxX, b.maxY); }
 continue;
 }
 cons(t.x, t.y, t.type === 'ball' ? t.r : Math.max(t.w || 0, t.h || 0) / 2);
 }
 for (const p of (this.level.props || [])) cons(p.x, p.y, p.shape === 'ball' ? p.r : Math.max(p.w || 0, p.h || 0) / 2);
 for (const z of [...(this.level.buildZones || []), ...(this.level.goalZones || [])]) {
 cons(z.x, z.y, Math.max(z.w, z.h) / 2);
 }
 if (!isFinite(minX)) { minX = maxX = minY = maxY = 0; } // a level of nothing but goal pieces
 const x = (minX + maxX) / 2, y = (minY + maxY) / 2;
 const reach = Math.hypot(maxX - minX, maxY - minY) / 2;
 return { x, y, outside: reach + VOID_ESCAPE };
 }

 // Has this pose left the world? One question, asked identically by goalLost
 // (§7.1), sweep (§11.4) and the sound bed — which is the whole reason it is
 // a method: three call sites meaning three slightly different things about
 // "gone" is exactly how a planet level ends up losing a piece that is still
 // sitting on it.
 //
 // **`ceiling` closes the sky, and almost nothing asks for it** (2026-08-14,
 // with the goal-piece gravity dial: "pieces that float away are lost"). An
 // ordinary level's sky is deliberately unbounded — a machine may throw its
 // cargo as high as it likes and gravity brings it home, so a catapult mid-arc
 // must never read as lost. That argument runs out at a gravity of 0 or less:
 // such a piece is not on its way back. So the ceiling is offered only to the
 // pieces the level authored that way (`floatsAway`, decided at construction),
 // and every other piece — every piece in every level that existed before this
 // dial — is asked exactly the question it was asked before.
 //
 // A planet level never needs it: its void is already a circle, which closed
 // the sky the day it was written.
 _inVoid(pose, ceiling = false) {
 const v = this.voidLine;
 if (v.outside !== undefined) return Math.hypot(pose.x - v.x, pose.y - v.y) > v.outside;
 if (ceiling && pose.y < v.above - VOID_DROP) return true;
 return pose.y > v.below + VOID_DROP;
 }

 // Radial gravity (§5.10): every dynamic body pulled toward the nearest
 // planet's centre, at a constant `P.gravity * pull` — the ACTIVE profile's
 // gravity, so a planet at pull 1 weighs what flat ground weighs under the
 // same physics (see gravity.js). Called once per physics
 // slice, for the same reason the lone drives are — Box2D clears applied
 // forces at the end of every b2World_Step, so applying once and stepping
 // three times leaves two of the three slices weightless.
 //
 // `wake = false` is load-bearing, not a micro-optimisation: pass true and a
 // body resting on a planet is woken again every single step, so NOTHING in
 // a planet level ever sleeps. Measured against the pinned binary — with
 // false, four balls dropped at N/E/S/W all come to rest exactly on the
 // surface and report awake = false.
 _applyRadialGravity() {
 if (!this.radial) return;
 const E = this.E;
 // Planet centres come off the live bodies (a planet may be a mover), and
 // are re-read once per step rather than per body: with N bodies and M
 // planets that is M reads instead of N*M.
 const field = this.planets.map((p) => {
 const c = p.rec.moving ? this._pose(p.rec.body) : p.rec.def;
 return { x: c.x, y: c.y, r: p.r, pull: p.pull };
 });
 for (const d of this.dynamics) {
 const a = fieldAt(E.body_x(d.body), E.body_y(d.body), field, this.P.gravity);
 if (!a.x && !a.y) continue;
 // `push` already carries the body's gravity scale, so a prop at 0 gets a
 // zero force here rather than a wasted wasm call, and a negative one is
 // pushed away from the planet it would otherwise fall onto. fieldAt
 // answers in m/s² (the gravity.js contract, shared with the server);
 // the engine wants units/s², hence the one ×PPM. The harness does not
 // wake a sleeper for this — a piece asleep on a planet stays asleep,
 // exactly as the old wake=false call behaved.
 if (!d.push) continue;
 E.body_apply_force(d.body, a.x * PPM * d.push, a.y * PPM * d.push);
 }
 }

 // ------- stepping -------

 // Frame pump: accumulate real dt clamped to ≤ 0.12 s, run whole fixed steps
 // up to 5 per render frame; if the cap is hit dump the remainder (§5.1).
 step(dtReal) {
 if (this.destroyed) return;
 this._acc += Math.min(Math.max(dtReal, 0), 0.12);
 let n = 0;
 while (this._acc >= STEP && n < 5) {
 this._fixedStep();
 this._acc -= STEP;
 n++;
 }
 if (n >= 5 && this._acc >= STEP) this._acc = 0;
 }

 _fixedStep() {
 const E = this.E;
 // snapshot EVERY dynamic pose BEFORE this step integrates, so view() can
 // interpolate between it and the post-step pose for render frames that
 // land between two fixed steps. This was movers-only when the sim stepped
 // at 60; at FC's 30 it is the whole world, or machines would visibly
 // stutter on any display. Only the DRAWN pose blends — every rule below
 // reads live state.
 if (!this.headless) {
 for (const t of this.terrain) {
 if (t.moving) t.prevPose = t.currPose || this._pose(t.body);
 }
 for (const r of this._lerpRecs) r.prevPose = r.currPose || this._pose(r.body);
 }
 // advance group motions & movers, teleport mover bodies (§9.3/§9.4)
 this._advanceMovers();
 // lone-drive torques (§5.5) — the engine clears forces after every step
 // (b2Island), so per-step application is the native semantics. The cap is
 // the JOINT motor's own torque, so a wheel driving alone and the same
 // wheel bolted into a machine are limited by one number; the servo asks
 // for a fixed angular acceleration toward motorSpeed. Inertia and torque
 // share the ×810000 unit factor (both are mass × length²; time carries
 // over unchanged), which is why TORQUE_FC appears on both.
 for (const ld of this.loneDrives) {
 const target = ld.dir * wheelMotorSpeed(ld.r, this.P); // +dir here (opposite sign to
 const w = E.body_w(ld.body); // the joint's — the joint drives
 const I = Math.max(E.body_inertia(ld.body), 0.05 * TORQUE_FC); // the ROD rel. the WHEEL)
 const cap = wheelMotorTorque(ld.r, this.P) * TORQUE_FC;
 const t = clamp((target - w) * I * LONE_GAIN, -cap, cap);
 E.body_apply_torque(ld.body, t);
 }
 // radial gravity (§5.10)
 this._applyRadialGravity();
 E.world_step(STEP, STEP_ITERS);
 // The harness buffers hits for exactly one step — take them now (§17).
 if (!this.headless) {
 this._collectHits();
 for (const t of this.terrain) {
 if (t.moving) t.currPose = this._pose(t.body);
 }
 for (const r of this._lerpRecs) r.currPose = this._pose(r.body);
 }
 this.time += STEP;
 this._checkWin();
 // Watched over the WHOLE run, not just the aftermath: a machine can throw
 // itself off the world long before the delivery lands, and the aftermath
 // doesn't run at all on 'anyPiece' levels or when nothing was delivered.
 // Latched, so this costs one early-exit scan a frame and then nothing.
 if (!this.sweep && this._allPartsVoid()) this.sweep = true;
 this._advanceAftermath();
 }

 // ---------- collisions, for the sound layer (§17) ----------
 //
 // The harness buffers hits for the step that just ran and nothing else, so
 // they have to be taken here, inside the fixed step. The buffer is drained
 // once per RENDERED frame, which at 8× playback is several steps' worth —
 // hence the cap, and hence the fact that nothing here plays a sound: this
 // file has no business knowing whether the player has audio switched on.
 //
 // A hit is a pair that TOUCHES this step and did not touch last step, and
 // its violence arrives as a Δv (impulse × combined inverse mass) in
 // units/s. One ÷PPM keeps `speed` in the m/s scale the mixer was tuned
 // against, and HIT_THRESHOLD meaning what it always meant — the engine has
 // no threshold of its own, so the settle-vs-collision line is drawn here.
 //
 // Cost when nothing is colliding is one `hit_count` read per step.
 _collectHits() {
 const E = this.E;
 const n = E.hit_count();
 if (!n) return;
 const dx = this._fcShift ? this._fcShift.dx : 0;
 const dy = this._fcShift ? this._fcShift.dy : 0;
 for (let i = 0; i < n; i++) {
 if (this._hits.length >= HIT_BUFFER) break;
 const speed = E.hit_dv(i) / PPM;
 if (speed < HIT_THRESHOLD) continue; // a settle, not a collision
 this._hits.push({
 speed,
 x: E.hit_x(i) + dx,
 y: E.hit_y(i) + dy,
 matA: this._matByBody[E.hit_a(i)] || 0,
 matB: this._matByBody[E.hit_b(i)] || 0,
 });
 }
 }

 // What the machine's wheels are doing, for the sound bed (§17).
 //
 // Wheels past the void line are EXCLUDED, which is the whole reason this is
 // a method here rather than a loop in game.js: a powered wheel spins forever
 // whether or not it is still in the world, so a machine that threw itself off
 // the level went on whirring from the abyss for the rest of the run. The void
 // line is the same one `goalLost` and `sweep` use (VOID_DROP), so a piece
 // counts as gone at exactly the moment the rest of the game says it is.
 //
 // Raw aggregates, not levels: how loud a rim speed of 260 px/s ought to be is
 // a feel decision, and it belongs with the mixer rather than the solver.
 wheelMotion() {
 const E = this.E;
 let rim = 0, spin = 0, n = 0, powered = 0;
 for (const w of this.wheels) {
 if (this._inVoid(this._pose(w.body))) continue;
 const s = Math.abs(E.body_w(w.body));
 rim += s * (w.part.r || 15);
 n++;
 if (w.part.kind === 'cw' || w.part.kind === 'ccw') { powered++; spin += s; }
 }
 return {
 rim: n ? rim / n : 0, // px/s at the tyre, averaged
 spin: powered ? spin / powered : 0, // rad/s, powered wheels only
 count: n,
 powered,
 };
 }

 // Everything that has collided since the last call. Returns [] when nothing
 // has, so a caller can drain unconditionally every frame.
 drainHits() {
 if (!this._hits.length) return EMPTY_HITS;
 const out = this._hits;
 this._hits = [];
 return out;
 }

 // Linear pose blend for render interpolation only — never used by physics/
 // win logic, which always reads live body state via _pose()/b2Body_Get*
 // directly. Per-step angular deltas are tiny, so lerping cos/sin and
 // re-deriving the angle is a fine, wraparound-free approximation (no need
 // for a true slerp).
 _lerpPose(prev, curr, alpha) {
 if (!prev) return curr;
 const c = prev.c + (curr.c - prev.c) * alpha;
 const s = prev.s + (curr.s - prev.s) * alpha;
 return {
 x: prev.x + (curr.x - prev.x) * alpha,
 y: prev.y + (curr.y - prev.y) * alpha,
 c, s, angle: Math.atan2(s, c),
 };
 }

 _advanceMovers() {
 // advance each group's shared state exactly once per step (§9.3) —
 // terrain and goal zones both read this.groupStates fresh when
 // computing their own pose, so nothing else needs to consume this loop.
 for (const gid of Object.keys(this.groupStates)) {
 advanceMotion(this.groupStates[gid].motion);
 }
 for (const t of this.terrain) {
 if (!t.moving) continue;
 advanceMotion(t.motion);
 this._teleportMover(t, this._moverPose(t));
 }
 // goal zones: own motion (a zone can have its own path, exactly like a
 // terrain piece — §9.3) plus group motion on top when grouped. The zone
 // has no physics body, so this is a plain pose recompute onto the live
 // copy, not a Box2D call.
 for (const rec of this.goalZoneRecs) advanceMotion(rec.motion);
 for (let i = 0; i < this.goalZoneRecs.length; i++) {
 const pose = this._moverPose(this.goalZoneRecs[i]);
 this.liveGoals[i].x = pose.x; this.liveGoals[i].y = pose.y; this.liveGoals[i].angle = pose.angle;
 }
 // …and text labels, on exactly the same terms and in the same place.
 //
 // **Two poses, because a label has to be INTERPOLATED like the terrain it
 // may be grouped to.** A terrain mover is a kinematic body whose drawn pose
 // is lerped between fixed steps by the frame's `alpha` (see view()); a pose
 // written once per step and read raw is therefore up to one whole step out
 // of phase with it. Measured on a label grouped to a slab moving at
 // 100 px/s: a constant 1.67 px of separation — exactly one step — which
 // reads as a sign that will not sit still on its own platform.
 for (const rec of this.textRecs) advanceMotion(rec.motion);
 for (const rec of this.textRecs) {
 rec.prevPose = rec.currPose; // seeded authored at construction
 rec.currPose = textPose(this._moverPose(rec));
 }
 }

 // Base pose from the piece's own motion; group motion applied on top
 // (§9.3). Shared by terrain movers ({def, motion, group}), goal-zone records
 // and text labels ({def, motion} — def.groupId stands in for `group`).
 _moverPose(t) {
 const def = t.def;
 const own = motionOffset(t.motion, def);
 let x = def.x, y = def.y;
 // A custom spin centre (§9.1) turns the piece's POSITION about it as well
 // as its angle — that is the whole difference between spinning and
 // orbiting, and it is why the default (pivot null, the piece's own
 // centre) adds no arithmetic at all: rotating a point about itself is the
 // identity, so the fast path skips it and pivot-less levels simulate
 // bit-identically to the day before pivots existed. The rotation lands
 // BEFORE the path offset, so a pivot rides a moving path with its piece.
 const pv = t.motion && t.motion.pivot;
 if (pv && own.dAngle) {
 const c = Math.cos(own.dAngle), s = Math.sin(own.dAngle);
 const rx = x - pv.x, ry = y - pv.y;
 x = pv.x + rx * c - ry * s;
 y = pv.y + rx * s + ry * c;
 }
 x += own.dx; y += own.dy;
 let angle = (def.angle || 0) + own.dAngle;
 const gid = t.group || def.groupId;
 const gs = gid && this.groupStates[gid];
 if (gs && gs.motion) {
 const gm = motionOffset(gs.motion, gs.pivot);
 const ga = gm.dAngle;
 if (ga) {
 // the group turns about its SPIN centre — its authored pivot override,
 // or the members' average it has always used (§9.1). Translation stays
 // measured from gs.pivot: moving the spin centre must not slide the
 // whole group's path sideways.
 const c = Math.cos(ga), s = Math.sin(ga);
 const dx = x - gs.spinPivot.x, dy = y - gs.spinPivot.y;
 x = gs.spinPivot.x + dx * c - dy * s;
 y = gs.spinPivot.y + dx * s + dy * c;
 }
 x += gm.dx; y += gm.dy;
 angle += ga;
 }
 return { x, y, angle };
 }

 // Movers (§9.4): a static body teleported along its authored path, CARRYING
 // the velocity of its own motion — the contact solver reads a body's
 // velocity for friction targets, and that is the whole of how a platform
 // drags what rests on it (measured at the smoke gate: platform slid 120,
 // crate rode 114). The harness side also wakes whatever the mover touches,
 // because a sleeping crate does not re-run its contacts and would be left
 // hovering where its platform used to be. Velocity is the finite difference
 // of the authored poses — exact for the path actually travelled this step.
 _teleportMover(t, pose) {
 const E = this.E;
 const last = t._lastPose || { x: t.def.x, y: t.def.y, angle: t.def.angle || 0 };
 const w = (pose.angle - last.angle) / STEP;
 if (t.edgeBodies) {
 // a painted mover is a rigid fence: each edge's piece-frame pose rides
 // the piece's new pose, and each edge carries its own velocity delta
 const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
 const lc = Math.cos(last.angle), ls = Math.sin(last.angle);
 for (const e of t.edgeBodies) {
 const nx = pose.x + e.lx * c - e.ly * s, ny = pose.y + e.lx * s + e.ly * c;
 const ox = last.x + e.lx * lc - e.ly * ls, oy = last.y + e.lx * ls + e.ly * lc;
 E.body_teleport(e.idx, nx, ny, pose.angle + e.la,
 (nx - ox) / STEP, (ny - oy) / STEP, w);
 }
 } else {
 E.body_teleport(t.body, pose.x, pose.y, pose.angle,
 (pose.x - last.x) / STEP, (pose.y - last.y) / STEP, w);
 }
 t._lastPose = { x: pose.x, y: pose.y, angle: pose.angle };
 }

 // ------- win detection (§7.1) — pure geometry, no sensors -------

 _checkWin() {
 if (this.won || this.goalLost) return;
 // **An FC-built world wins by FC's own test** (2026-08-17): every goal
 // block's AABB fully inside the goal area, zero slack, decided the
 // instant it is true — no dwell. That is the rule ft.jtai.dev decides
 // the same design by, and a replay that wins there must win here on the
 // same tick. The C side owns the geometry (fc_goal_won); goalLost, sweep
 // and the aftermath keep reading the shifted poses exactly as ever.
 if (this._fcWorld) {
 if (this.E.fc_goal_won()) {
 this.won = true;
 this.winTime = this.time;
 }
 return;
 }
 if (!this.liveGoals.length) return;
 // legacy alt mode: any wheel/rod body center inside any goal zone counts (§7.1)
 if (this.level.win === 'anyPiece') {
 let anyIn = false;
 for (const list of [this.wheels, this.rods]) {
 for (const rec of list) {
 const pose = this._pose(rec.body);
 if (this.liveGoals.some((zone) => this._inGoal(pose.x, pose.y, zone))) { anyIn = true; break; }
 }
 if (anyIn) break;
 }
 if (anyIn) {
 this._winStreak++;
 if (this._winStreak >= WIN_FRAMES) { this.won = true; this.winTime = this.time; }
 } else this._winStreak = 0;
 return;
 }
 if (!this.goals.length) return;
 const allIn = this._allGoalsIn();
 if (this.goalLost) return; // flagged inside _allGoalsIn
 if (allIn) {
 this._winStreak++;
 if (this._winStreak >= WIN_FRAMES) {
 this.won = true;
 this.winTime = this.time;
 // the qualifying streak already counts toward "remained in the goal"
 this._heldStreak = this._winStreak;
 }
 return;
 }
 // The run of contained frames just ended, short of WIN_FRAMES. Any run at
 // all means every goal piece was, at one and the same instant, fully
 // inside a goal zone — and that IS the delivery (§7.1). Waiting out the
 // dwell instead would make a fast delivery *unwinnable* rather than
 // merely hard: a 30 px crate crossing a 120 px zone at 800 px/s is fully
 // inside for 7 frames and no machine can do better.
 //
 // Reacting to the break rather than predicting it is the whole trick.
 // The obvious alternative — waive the dwell when the piece is moving too
 // fast to complete it — has to extrapolate, and extrapolation is wrong
 // exactly when physics intervenes: a piece dropping INTO a zone at speed
 // looks like it will shoot out the bottom, then lands on the floor and
 // stays. (Measured: that mis-fired on Twin Peaks, winning 11 frames
 // early.) Waiting for the run to actually end can't be wrong about what
 // already happened, and it leaves every delivery that does dwell — which
 // is every official and every recorded solve — timed to the frame.
 //
 // Whether the piece STAYS there is a different question with its own
 // answer: Nailed It (§7.1a), which watches for a minute after this.
 if (this._winStreak > 0) {
 this.won = true;
 this.winTime = this.time;
 this._heldStreak = this._winStreak;
 }
 this._winStreak = 0;
 }

 // True iff a single goal piece sits fully inside ONE given zone — every
 // sample point (corners for a box, the centre for a ball) must clear the
 // SAME zone, not "each point in some zone," or a piece could straddle the
 // gap between two disjoint zones and incorrectly validate. Zones that
 // actually touch get their second chance in _pieceInZones, as a region.
 _pieceFullyInGoal(g, pose, zone) {
 if (g.def.shape === 'ball') {
 // circle fully inside: centre within the goal deflated by r
 // (equivalent to the AABB-corner test for unrotated goals)
 return this._inGoal(pose.x, pose.y, zone, g.def.r);
 }
 // The physical shape is a rounded box (§5.3): fully inside ⇔ each
 // corner-circle centre (core corner, inset by the corner radius) sits
 // within the goal deflated by that radius. Testing the sharp visual
 // corners instead fails a crate dragging tilted on its rounded corner.
 const cr = cornerRadiusOf(g.def);
 const hw = Math.max(g.def.w / 2 - cr, 0), hh = Math.max(g.def.h / 2 - cr, 0);
 const { c, s } = pose;
 for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
 const wx = pose.x + dx * c - dy * s;
 const wy = pose.y + dx * s + dy * c;
 if (!this._inGoal(wx, wy, zone, cr)) return false;
 }
 return true;
 }

 // The piece's outer footprint as a polygon, for the cluster test below: the
 // AABB square for a ball (§7.1's own wording for the ball rule) and the four
 // SHARP corners for a crate. Sharp, not the rounded-box core corners
 // _pieceFullyInGoal tests, because the rounded shape is a subset of its
 // sharp box: a sharp box inside the union guarantees the real shape is, and
 // erring on the strict side is the only safe direction for a win condition.
 // (The one-zone test above stays exact, so nothing loses its rounding
 // allowance except a piece that is spanning a seam.)
 _pieceFootprint(g, pose) {
 if (g.def.shape === 'ball') {
 const r = g.def.r;
 return [
 { x: pose.x - r, y: pose.y - r }, { x: pose.x + r, y: pose.y - r },
 { x: pose.x + r, y: pose.y + r }, { x: pose.x - r, y: pose.y + r },
 ];
 }
 const hw = g.def.w / 2, hh = g.def.h / 2;
 const { c, s } = pose;
 return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
 x: pose.x + dx * c - dy * s,
 y: pose.y + dx * s + dy * c,
 }));
 }

 // True iff a goal piece is inside the delivery area described by `zones`:
 // inside ONE of them, or — when zones touch or overlap — inside the single
 // region they form (§7.2a). Two zones drawn edge to edge read as one bigger
 // area, so a crate that spans the seam is delivered; zones with real space
 // between them stay separate and a piece may still not bridge the gap.
 //
 // `clusters` is a lazily-built cache the caller threads through its own
 // loop: the fast path answers nearly every frame, and the exact union test
 // is only worth its cost for the pieces it turns down.
 _pieceInZones(g, pose, zones, clusters) {
 if (zones.some((zone) => this._pieceFullyInGoal(g, pose, zone))) return true;
 const joined = clusters();
 if (!joined.length) return false;
 const poly = this._pieceFootprint(g, pose);
 return joined.some((c) => polyInRectUnion(poly, c, GOAL_SLACK));
 }

 // True iff every goal piece currently sits fully inside AT LEAST ONE goal
 // zone — or one cluster of touching zones (any-piece-any-region —
 // §7.1/§7.2a/§9.3). Also flags goalLost (a piece fell far below the level)
 // as a side effect of the same position scan. Shared by initial win
 // detection and the post-win grace-period settle check.
 _allGoalsIn() {
 let allIn = true;
 // Goal zones move (own path, group motion), so this can't be cached
 // across frames — but it is built at most once per call, and only if some
 // piece actually fails the single-zone test.
 let joined = null;
 const clusters = () => (joined ??= joinedZoneClusters(this.liveGoals, GOAL_SLACK));
 for (const g of this.goals) {
 const pose = this._pose(g.body);
 if (this._inVoid(pose, g.ceiling)) {
 this.goalLost = true;
 // Only a flat level has a direction to report — a radial one's void is
 // a circle, and "up" there is whichever way the piece happened to go.
 this.goalLostUp = this.voidLine.above !== undefined && pose.y < this.voidLine.above;
 return false;
 }
 if (!allIn) continue;
 if (!this._pieceInZones(g, pose, this.liveGoals, clusters)) allIn = false;
 }
 return allIn;
 }

 // Same containment test, against the BUILD zones — Boomerang asks whether
 // the machine brought its delivery all the way home again. Build zones
 // never move during a run, so their clusters are computed once.
 _allGoalsInBuild() {
 const zones = this.level.buildZones || [];
 if (!zones.length || !this.goals.length) return false;
 const clusters = () => (this._buildClusters ??= joinedZoneClusters(zones, GOAL_SLACK));
 for (const g of this.goals) {
 const pose = this._pose(g.body);
 if (!this._pieceInZones(g, pose, zones, clusters)) return false;
 }
 return true;
 }

 // SWEEP (§11.4): has every piece the PLAYER built left the world?
 //
 // `fixed` parts are excluded on purpose — those are the LEVEL's furniture,
 // not the player's machine, and a badge about what you built can't be
 // decided by scenery you didn't. The same void line `goalLost` uses, so
 // "gone" means one thing in this file.
 //
 // Cheap in the case that matters: it returns on the first part still in
 // play, which for almost every machine is the first part it looks at. Only a
 // machine actually falling apart pays for the full scan, and only until it
 // latches.
 _allPartsVoid() {
 const gone = (rec) => rec.fixed || this._inVoid(this._pose(rec.body));
 return this.wheels.every(gone) && this.rods.every(gone);
 }

 // Every goal piece stopped: linear AND angular, because a crate spinning on
 // the spot inside the zone hasn't settled, it's still being worked on.
 _goalsAtRest() {
 const E = this.E;
 for (const g of this.goals) {
 if (Math.hypot(E.body_vx(g.body), E.body_vy(g.body)) >= AT_REST_SPEED) return false;
 if (Math.abs(E.body_w(g.body)) >= AT_REST_SPIN) return false;
 }
 return true;
 }

 // The machine has stopped — every wheel and rod still, linear and angular.
 // Split out of `_worldQuiet` because SWEEP asks only this half: whether the
 // delivery has settled says nothing about whether the machine is still on
 // its way out of the world.
 _partsAtRest() {
 const E = this.E;
 for (const list of [this.wheels, this.rods]) {
 for (const rec of list) {
 if (Math.hypot(E.body_vx(rec.body), E.body_vy(rec.body)) >= AT_REST_SPEED) return false;
 if (Math.abs(E.body_w(rec.body)) >= AT_REST_SPIN) return false;
 }
 }
 return true;
 }

 // Nothing anywhere is moving — goal pieces, wheels and rods all stopped, so
 // no later frame can change either verdict. Props are deliberately excluded:
 // a boulder still rolling away in the corner can't reach the delivery.
 _worldQuiet() {
 return this._goalsAtRest() && this._partsAtRest();
 }

 // The post-win watch (see the AFTERMATH_FRAMES block at the top). Runs on
 // every Simulation, live or offscreen; the client just fast-forwards a
 // second one to get the answer without a one-minute wait.
 _advanceAftermath() {
 if (!this.won || this.afterDone) return;
 // 'anyPiece' levels win on a machine part entering the zone, so there's no
 // delivery to hold and nothing to watch
 if (this.level.win === 'anyPiece' || !this.goals.length) { this.afterDone = true; return; }
 // **A lost goal answers the DELIVERY question, not the SWEEP one.** A piece
 // in the void is never coming back, so Nailed It and Boomerang are settled
 // the moment it goes — but the machine that threw it off the world is
 // usually still falling alongside it, and Sweep is about the machine.
 //
 // Ending here outright is what made a run that drives clean off the right
 // edge earn no Sweep: measured on the reported case, the goal was lost at
 // 11.77 s and the last part crossed the void line at 11.85 s — five frames
 // later, with the window already shut. So the window stays open for that
 // one question, and closes as soon as it is answered: the machine has swept
 // (latched, never un-latches), or it has stopped moving and therefore never
 // will. Same `AFTERMATH_FRAMES` cap as any other run, so nothing can hang.
 //
 // Observation only — this method applies no forces, so when `afterDone`
 // flips cannot move a pose (§5.8 determinism is untouched, gate 1 holds it).
 if (this.goalLost) {
 this.afterElapsed++;
 if (this.sweep || this._partsAtRest() || this.afterElapsed >= AFTERMATH_FRAMES) this.afterDone = true;
 return;
 }
 this.afterElapsed++;

 if (this._allGoalsIn()) {
 this._heldStreak++;
 // 1. in the zone and stopped — settled, no need to watch the clock out
 if (!this.nailedIt && this._goalsAtRest()) { this.nailedIt = true; this.nailedItBy = 'rest'; }
 // 2. or in the zone long enough that "still drifting" stops mattering
 if (!this.nailedIt && this._heldStreak >= HELD_FRAMES) { this.nailedIt = true; this.nailedItBy = 'held'; }
 } else {
 this._heldStreak = 0;
 }

 if (!this.boomerang && this._allGoalsInBuild()) this.boomerang = true;

 this._quietStreak = this._worldQuiet() ? this._quietStreak + 1 : 0;
 // 3. out of time (or out of motion) — whatever is latched above stands
 if (this.afterElapsed >= AFTERMATH_FRAMES || this._quietStreak >= QUIET_FRAMES) this.afterDone = true;
 }

 // Point (or circle of radius `deflate`) inside the goal rect, with
 // GOAL_SLACK px of slack — see its doc comment (goal-zone edges often sit
 // exactly on walkable surfaces and Box2D's soft contacts rest bodies with
 // ~0.003 px penetration; without slack a ball resting through a
 // floor-level goal never counts as inside).
 _inGoal(px, py, goal, deflate = 0) {
 const a = goal.angle || 0;
 let dx = px - goal.x, dy = py - goal.y;
 if (a) {
 const c = Math.cos(-a), s = Math.sin(-a);
 const rx = dx * c - dy * s, ry = dx * s + dy * c;
 dx = rx; dy = ry;
 }
 return Math.abs(dx) <= goal.w / 2 - deflate + GOAL_SLACK &&
 Math.abs(dy) <= goal.h / 2 - deflate + GOAL_SLACK;
 }

 // fastest goal piece's |linearVelocity| × PPM, px/s (Nailed It, §7.1)
 maxGoalSpeed() {
 const E = this.E;
 let max = 0;
 for (const g of this.goals) {
 const sp = Math.hypot(E.body_vx(g.body), E.body_vy(g.body));
 if (sp > max) max = sp;
 }
 return max;
 }

 // ------- reading state -------

 _pose(body) {
 const E = this.E;
 const angle = E.body_angle(body); // unbounded radians — never wrapped
 // An FC-built world runs in its SOURCE frame; the shift moves every read
 // into the level's drawn frame. Physics never sees it.
 const dx = this._fcShift ? this._fcShift.dx : 0;
 const dy = this._fcShift ? this._fcShift.dy : 0;
 return { x: E.body_x(body) + dx, y: E.body_y(body) + dy, angle, c: Math.cos(angle), s: Math.sin(angle) };
 }

 // px-space poses for the renderer, same relative order as edit mode (§10.1).
 // ---------- the scrub tape (§7.3) ----------
 //
 // How many bodies a frame of this run needs, and the ORDER they are written
 // in. Every consumer walks the same order, so a tape frame is a bare run of
 // numbers with no keys — the `def`/`part` objects it belongs to are static
 // and live here, not on the tape.
 //
 // Static terrain is excluded on purpose: it cannot move, so recording it
 // would be storing the same number sixty times a second.
 tapeBodies() {
 const out = [];
 for (const t of this.terrain) if (t.moving) out.push(t.body);
 for (const p of this.props) out.push(p.body);
 for (const g of this.goals) out.push(g.body);
 for (const w of this.wheels) out.push(w.body);
 for (const r of this.rods) out.push(r.body);
 return out;
 }

 // x, y, angle per body, straight into a caller-owned Float32Array at `at`.
 // Three floats, not five: `c`/`s` exist on a live pose to keep the mover lerp
 // off the ±π wrap, and a recorded frame is never lerped — it is a frame that
 // already happened.
 writeTape(dst, at) {
 const bodies = this._tapeBodies || (this._tapeBodies = this.tapeBodies());
 for (let i = 0; i < bodies.length; i++) {
 const p = this._pose(bodies[i]);
 dst[at + i * 3] = p.x;
 dst[at + i * 3 + 1] = p.y;
 dst[at + i * 3 + 2] = p.angle;
 }
 return bodies.length * 3;
 }

 // The STATIC half of a frame — every `def`/`part` the poses belong to, in the
 // same order `writeTape` walks. Taken once, at the start of a run.
 //
 // **The tape has to outlive the Simulation that made it.** Scrubbing pauses
 // the run, and stopping destroys the sim and frees its wasm bodies — a tape
 // that still had to ask a live sim what its rods were would go blank at the
 // exact moment you wanted to look at it. So the recording is self-contained:
 // this snapshot plus the pose buffer is the whole of it, and none of it
 // touches wasm.
 tapeShape() {
 return {
 terrain: this.terrain.map((t) => ({ def: t.def, moving: t.moving })),
 props: this.props.map((p) => p.def),
 goals: this.goals.map((g) => g.def),
 wheels: this.wheels.map((w) => ({ part: w.part, fixed: w.fixed })),
 rods: this.rods.map((r) => ({ part: r.part, fixed: r.fixed, len: r.len })),
 goalZones: this.liveGoals,
 texts: this.textRecs.map((r) => ({ x: r.def.x, y: r.def.y, angle: r.def.angle || 0 })),
 };
 }

 view() {
 // how far the wall clock has drifted past the last completed physics
 // step, as a fraction of one step — used to smooth mover rendering
 // between fixed steps (see _fixedStep's prevPose/currPose comment)
 const alpha = clamp(this._acc / STEP, 0, 1);
 const v = {
 terrain: [], props: [], goals: [], wheels: [], rods: [],
 goalZones: this.liveGoals,
 // interpolated between fixed steps exactly as terrain movers are, so a
 // label grouped to a slab holds station with it (§9.3)
 texts: this.textRecs.map((r) => (r.currPose
 ? this._lerpPose(r.prevPose, r.currPose, alpha)
 : { x: r.def.x, y: r.def.y, angle: r.def.angle || 0 })),
 };
 for (const t of this.terrain) {
 v.terrain.push(t.moving
 ? { def: t.def, ...this._lerpPose(t.prevPose, t.currPose || this._pose(t.body), alpha), moving: true }
 : { def: t.def, x: t.def.x, y: t.def.y, angle: t.def.angle || 0, moving: false });
 }
 // Machine bodies interpolate exactly as movers always have (§9.4): the
 // sim steps at FC's 30 Hz and the screen does not — prev/curr come from
 // _fixedStep's whole-world snapshots. Rules never read these.
 for (const p of this.props) {
 v.props.push({ def: p.def, ...this._lerpPose(p.prevPose, p.currPose || this._pose(p.body), alpha) });
 }
 for (const g of this.goals) {
 v.goals.push({ def: g.def, ...this._lerpPose(g.prevPose, g.currPose || this._pose(g.body), alpha) });
 }
 for (const w of this.wheels) {
 v.wheels.push({ part: w.part, fixed: w.fixed, ...this._lerpPose(w.prevPose, w.currPose || this._pose(w.body), alpha) });
 }
 for (const r of this.rods) {
 const pose = this._lerpPose(r.prevPose, r.currPose || this._pose(r.body), alpha);
 const hx = (r.len / 2) * pose.c, hy = (r.len / 2) * pose.s;
 v.rods.push({
 part: r.part, fixed: r.fixed,
 x1: pose.x - hx, y1: pose.y - hy,
 x2: pose.x + hx, y2: pose.y + hy,
 });
 }
 return v;
 }

 // Worst separation across all pin joints, px — §15 harness metric.
 worstJointGap() {
 let worst = 0;
 for (const j of this.jointRecs) {
 // measure via each body's current world point of the stored pin
 const pa = this._worldPointOf(j.a, j.x, j.y, j);
 const pb = this._worldPointOf(j.b, j.x, j.y, j);
 const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
 if (d > worst) worst = d;
 }
 return worst;
 }

 _worldPointOf(body, pinX, pinY, rec) {
 if (!rec._locals) rec._locals = new Map();
 let loc = rec._locals.get(body);
 if (!loc) {
 // local coords were fixed at construction; capture once lazily using the
 // initial pin position (bodies are at authored poses when jointRecs are
 // created, but this getter may run later — so store at first call only
 // if the sim hasn't stepped; harness captures pre-step). Plain inverse
 // transform — the engine keeps no local anchors we could ask for.
 const p = this._pose(body);
 const dx = pinX - p.x, dy = pinY - p.y;
 loc = { x: dx * p.c + dy * p.s, y: -dx * p.s + dy * p.c };
 rec._locals.set(body, loc);
 }
 const p = this._pose(body);
 return { x: p.x + loc.x * p.c - loc.y * p.s, y: p.y + loc.x * p.s + loc.y * p.c };
 }

 // Capture joint locals now (call right after construction, before stepping,
 // when using worstJointGap in the harness).
 captureJointLocals() {
 for (const j of this.jointRecs) {
 this._worldPointOf(j.a, j.x, j.y, j);
 this._worldPointOf(j.b, j.x, j.y, j);
 }
 }

 destroy() {
 if (this.destroyed) return null;
 this.destroyed = true;
 // The world IS the wasm instance. The game drops it. The solver's eval
 // pool passes recycleEngine and gets the instance back to step again.
 const wasm = this._wasm;
 this.E = null;
 this._wasm = null;
 return this.opts && this.opts.recycleEngine ? wasm : null;
 }
}
