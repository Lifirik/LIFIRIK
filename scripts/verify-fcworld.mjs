// verify-fcworld.mjs — every FC-imported level in the database, checked on
// both of its build paths.
//
// node scripts/verify-fcworld.mjs [--db data/db.sqlite] [--only 2] [--quiet]
//
// An imported level has two ways of becoming a physics world (sim.js): the C
// LOADER — fcsim's own xml/graph/gen inside the engine, bit-exact with
// ft.jtai.dev, used for a machine made of FC's own pieces — and the JS BUILD,
// LIFIRIK's own construction of the same level, used the moment a machine
// carries a piece FC has not got. Three things have to hold for the pair to be
// honest, and each was found broken once (2026-08-18) before this existed:
//
// 1. the manifest agrees with the piles: fcWorld.levels[i].dynamic is how
// sim.js maps the C bodies onto the terrain and prop records, and a
// count that disagrees means the C loader silently never engages;
// 2. the level's own published solve WINS on the C loader, in the time its
// solve row claims — a Sticks level ships with the machine that solved
// it at home, and that machine replaying is the whole promise;
// 3. the LEVEL, empty, behaves the same on both paths: every goal piece
// within 3 px, second by second, until it leaves the level. This is what
// caught the zero-width DynamicRectangle — an invisible static line in
// FC, an 8 px falling prop here, and the ball's own perch on Sticks 01.
//
// (3) has a BASELINE rather than a zero: some levels have SOMETHING unsupported
// at frame 0 — usually the cargo (a rolling ball, a pinball among props), but a
// falling PROP does it too, drifting on ulps for seconds before it reaches a
// cargo that has been sitting still the whole time. Two builds that differ by a
// last ulp then part company — only the C loader is exact, which is why
// FC-piece machines use it. The gate is "no more than the known ones", named, so an extra is a
// regression and one fewer is progress worth reading. Runs from the DB
// directly (read-only copy) — the campaign lives there, not in levels.js.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gates } from './gatekit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const DB_PATH = arg('db', process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite'));

const { initEngine, Simulation } = await import(u('public/js/sim.js'));
const { fcMachineXml } = await import(u('public/js/fcworld.js'));
// …and the IMPORTER, for gate 6: a wheel's size is decided there and read
// everywhere else, so the only honest place to ask about it is a real paste.
const { convertFcLevel, fcXmlToPaste } = await import(u('public/js/fcimport.js'));
const { WHEEL_SIZES, STD_WHEEL_R, MIN_BALL_R } = await import(u('public/js/sizes.js'));
// …and the EDITOR, for gate 5: what a ghost line stops is a question the editor
// has to answer the same way the physics does, and the only honest way to hold
// it to that is to ask its own predicates.
const { GameScreen } = await import(u('public/js/game.js'));
const { terrainBlocks, terrainCollider, isGhostLine } = await import(u('public/js/util.js'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));
const { gate, section, summary } = gates();

// Levels that diverge between the paths with NO machine at all — the cargo is
// in flight from the first frame and the two builds part company on ulps.
// Listed so the set can only shrink without comment.
//
// **Keyed on levelId, not name.** These were 'Sticks 03', 'Sticks 26' and
// 'Sticks 30' until b3d4438 dropped two DESTROPOCALYPSE levels and renumbered
// the series; the same three puzzles then answered to 05, 28 and 30, and this
// gate failed the deploy reporting a regression that had not happened. A
// campaign name is a POSITION and positions move. The id is the puzzle.
// Re-baselined 2026-08-20 for the new stick series (fc-pick-levels.mjs): the
// old three left the campaign with the levels they were on, so these are not
// the same puzzles renamed — they are the new set's own. Measured, not assumed:
// each was checked for what is actually moving at frame 0.
const KNOWN_CHAOTIC = new Set([
 'Gt5_asZL734', // Sticks 01 — cargo in free flight from frame 0, parts at 2 s
 'aR66ixjfjxc', // Sticks 10 — cargo in free flight from frame 0, parts at 17 s
 'rqDailWjIvY', // Sticks 15 — cargo RESTS; two props fall from frame 0 and
 // reach it, so the paths part at 8 s
 'FLVkh-XwSOY', // Sticks 24 — cargo in free flight from frame 0, parts at 4 s
]);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const levels = db.prepare('SELECT json FROM levels').all().map((r) => JSON.parse(r.json))
 .filter((l) => l.data && l.data.fcWorld && l.data.fcWorld.xml)
 .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || String(a.name).localeCompare(String(b.name)));
const designOf = (solveId) => { const r = db.prepare('SELECT json FROM designs WHERE solveId=?').get(solveId); return r ? JSON.parse(r.json).design : null; };

// The level's OWN solve — the machine it was imported with, posted by the
// account that published it (Sticks) — not merely the newest winning one:
// since AlgoMech's prunings sit at the top of solveLog, "newest" is a
// pruned copy and the transpile-to-source gate would compare the wrong
// machine. Falls back to the OLDEST winning solve with a design.
const ownSolve = (l) => {
 const withDesign = (l.solveLog || []).filter((s) => s.won && designOf(s.id));
 return withDesign.find((s) => s.byId === l.authorId || s.by === l.author) || withDesign[withDesign.length - 1] || null;
};

// Has this level been PUBLISHED? server.js's own three-stop dial (§ the
// visibility route): public is neither flag, unlisted is listed === false,
// private is both. Only the first has promised anybody anything.
//
// Gate 2 demands a winning solve because a Sticks level ships with the machine
// that solved it at home, and that machine replaying is the whole promise. A
// private Maker save has made no such promise — it is somebody's draft.
//
// **This became reachable on 2026-08-22.** Until the _levelData whitelist was
// fixed, a Maker save silently dropped fcWorld, so this file's population was
// the campaign and nothing else. The moment saves kept it, the first private
// import in the database failed a deploy for not having shipped with a solve.
// The build gates (1, 3, 5, 6) still run on it, and should: that a pasted
// level constructs identically on both paths is worth asking of any import.
const published = (l) => !l.private && l.listed !== false;

// **A solve may carry a piece FC has not got.** Candidate's own solve
// (2026-08-24, the first such row) rides a rod with the weight dial at 100 —
// which is what the importer itself writes: a pile of identical sticks is
// FC's standing idiom for a weight, and fcimport.js folds the pile into one
// weighted stick (gold arrives the same way). Such a machine takes the JS
// build BY DESIGN — D1 scopes the C loader to FC-piece machines and the
// refusal list is closed — so for it the honest expectations flip: the
// replay must still WIN (gate 2 holds it to the row's time on either path),
// and the transpile must refuse for exactly the piece the design carries.
// The cross-check against the parts is the teeth: a refusal naming a piece
// the design has NOT got is a misclassification, drops through to the strict
// gate, and fails as loudly as ever.
const lifirikOnly = (parts, refusal) =>
 (refusal === 'a weighted rod' && parts.some((p) => p.t === 'rod' && p.weight != null && p.weight !== 1))
 || (refusal === 'a rope' && parts.some((p) => p.t === 'rod' && p.chain != null))
 ? refusal : null;

const norm = (data) => {
 for (const k of ['terrain', 'props', 'buildZones', 'goalZones', 'goalObjs', 'fixedParts', 'texts', 'pins']) data[k] = data[k] || [];
 data.groups = data.groups || {};
 return data;
};

// one run: won/time/lost, the goals' poses per second keyed by def index
const run = (level, parts, secs) => {
 const sim = new Simulation(level, { parts }, {});
 const gi = sim.goals.map((g) => level.goalObjs.indexOf(g.def));
 const snap = () => { const o = []; sim.goals.forEach((g, k) => { const q = sim._pose(g.body); o[gi[k]] = { x: q.x, y: q.y }; }); return o; };
 const per = [];
 let f = 0;
 const N = Math.round(secs * 30);
 while (f < N && !sim.won && !sim.goalLost) {
 if (f % 30 === 0) per.push(snap());
 sim._fixedStep(); f++;
 }
 const out = { won: sim.won, time: sim.won ? sim.winTime : null, lost: sim.goalLost, at: f / 30, per, fc: !!sim._fcWorld };
 sim.destroy();
 return out;
};

section('1', () => {
 for (const l of levels) {
 const W = l.data.fcWorld;
 const dyn = W.levels.filter((b) => b.dynamic).length;
 const ok = dyn === (l.data.props || []).length && W.levels.length - dyn === (l.data.terrain || []).length;
 gate(`1. ${l.name}: manifest ${W.levels.length - dyn} static / ${dyn} dynamic matches terrain ${(l.data.terrain || []).length} / props ${(l.data.props || []).length}`, ok);
 }
});

section('2', () => {
 for (const l of levels) {
 const level = norm(structuredClone(l.data));
 const solve = ownSolve(l);
 if (!solve) continue;
 const parts = designOf(solve.id);
 const r = run(level, parts, 95);
 if (!r.won) continue;
 const only = lifirikOnly(parts, fcMachineXml(level, parts, {}).refusal);
 if (only) {
 gate(`2. ${l.name}: its solve (${parts.length} pieces) carries ${only} — FC has not got it, so it replays on the JS build and wins`,
 !r.fc && r.won,
 `${r.fc ? 'C path?!' : 'JS path'}, ${r.won ? 'won ' + r.time.toFixed(2) + 's' : r.lost ? 'LOST' : 'no win'}, row says ${(+solve.time).toFixed(2)}s`);
 } else {
 gate(`2. ${l.name}: its solve (${parts.length} pieces) replays on the C loader and wins`, r.fc && r.won,
 `${r.fc ? 'C path' : 'JS PATH'}, ${r.won ? 'won ' + r.time.toFixed(2) + 's' : r.lost ? 'LOST' : 'no win'}, row says ${(+solve.time).toFixed(2)}s`);
 }
 if (+solve.time > 0.05) gate(`2. ${l.name}: …in the time its solve row claims`, Math.abs(r.time - solve.time) < 0.05, `${r.time.toFixed(3)} vs ${(+solve.time).toFixed(3)}`);
 }
});

section('3', () => {
 const divergers = [];
 for (const l of levels) {
 const level = norm(structuredClone(l.data));
 // the machine STRIPPED from the C world, so an empty design is pristine
 // and takes the C loader — the level alone, on FC's own build
 const W = level.fcWorld;
 const bare = {
 ...W,
 xml: W.xml.replace(/<(SolidRod|HollowRod|NoSpinWheel|ClockwiseWheel|CounterClockwiseWheel)(\s+id="\d+")?>[\s\S]*?<\/\1>/g,
 (m) => /<goalBlock>true<\/goalBlock>/.test(m) ? m : ''),
 players: W.players.filter((b) => b.t === 4 || b.goal),
 print: '', // fcMachinePrint of an empty machine — what _fcPristine recomputes for []
 };
 const cLevel = { ...level, fcWorld: bare };
 const c = run(cLevel, [], 20);
 const j = run({ ...level, fcWorld: null }, [], 20);
 if (!c.fc) { gate(`3. ${l.name}: the empty level takes the C loader`, false, 'fell to the JS build'); continue; }
 const secs = Math.min(c.per.length, j.per.length);
 let divergeAt = null;
 for (let s = 0; s < secs && divergeAt == null; s++) {
 for (let i = 0; i < level.goalObjs.length; i++) {
 const a = c.per[s][i], b = j.per[s][i];
 if (!a || !b) continue;
 if (Math.hypot(a.x - b.x, a.y - b.y) > 3) { divergeAt = s; break; }
 }
 }
 if (divergeAt != null) divergers.push(`${l.name}@${divergeAt}s`);
 gate(`3. ${l.name}: empty level agrees on both paths for ${secs}s`,
 divergeAt == null,
 divergeAt == null ? `${level.goalObjs.length} goal(s), C ${c.lost ? 'lost@' + c.at : 'ran'}, JS ${j.lost ? 'lost@' + j.at : 'ran'}` : `diverges at ${divergeAt}s`);
 }
});

// ---- 4. any FC-piece machine takes FC's builder (D1, fcworld.js) ----
//
// The pristine design said in FC's dialect must BE its source XML (digits
// and joint lists verbatim, whitespace aside) and win in the identical time
// through the C loader; the same design minus a stick — an edit, which used
// to mean the JS build — must still take the C loader; and a hand-built
// stick machine on the level must too, while a machine FC cannot say (a
// weight dial, a joint on a pin FC has not got) is refused to the JS build.
section('4', () => {
 const ws = (s) => s.replace(/\s+/g, '');
 const build = (level, parts, opts = {}) => {
 const sim = new Simulation(level, { parts }, opts);
 const out = { fc: !!sim._fcWorld, refusal: sim._fcRefusal, joints: sim._fcWorld ? sim.E.fc_joint_count() : null };
 sim.destroy();
 return out;
 };
 for (const l of levels) {
 const level = norm(structuredClone(l.data));
 const solve = ownSolve(l);
 if (!solve) continue;
 const parts = designOf(solve.id);
 const said = fcMachineXml(level, parts, {});
 // The one exemption, cross-checked: a design carrying a piece FC cannot
 // say does not round-trip — it is refused to the JS build, in so many
 // words, the same sentence gate 4h demands of a hand-weighted stick.
 const only = lifirikOnly(parts, said.refusal);
 if (only) {
 const b = build(level, parts);
 gate(`4. ${l.name}: the pristine design carries ${only}, which FC cannot say — refused to the JS build`,
 !b.fc && /weighted|rope/.test(b.refusal || ''), b.refusal || 'took the C loader');
 continue;
 }
 const roundTrip = !said.refusal && ws(said.xml) === ws(level.fcWorld.xml);
 if (roundTrip) gate(`4. ${l.name}: the pristine design transpiles to its own source XML`, roundTrip, said.refusal || `${said.players.length} player blocks`);
 if (said.refusal || !roundTrip) continue;
 const forced = { ...level, fcWorld: { ...level.fcWorld, print: '__not_pristine__' } };
 const a = run(level, parts, 95), b = run(forced, parts, 95);
 if (a.won && b.won) gate(`4. ${l.name}: …and wins identically through the C loader when transpiled`, b.fc && Math.abs(a.time - b.time) < 1e-9, `${a.won ? a.time.toFixed(3) : 'no'} vs ${b.won ? b.time.toFixed(3) : 'no'}${b.fc ? '' : ' (JS!)'}`);
 const edited = build(level, parts.slice(0, -1));
 gate(`4. ${l.name}: the design minus one stick takes the C loader`, edited.fc, edited.refusal || `${edited.joints} joints`);
 }
 // hand-built, on the first level: a triangle in the build zone
 if (levels.length) {
 const level = norm(structuredClone(levels[0].data));
 const b = level.buildZones[0], cx = b.x, cy = b.y;
 const tri = [
 { t: 'rod', kind: 'wood', x1: cx - 60, y1: cy + 40, x2: cx + 60, y2: cy + 40, id: 'a' },
 { t: 'rod', kind: 'wood', x1: cx + 60, y1: cy + 40, x2: cx, y2: cy - 50, id: 'b' },
 { t: 'rod', kind: 'water', x1: cx, y1: cy - 50, x2: cx - 60, y2: cy + 40, id: 'c' },
 ];
 const t = build(level, tri);
 gate(`4h. ${levels[0].name}: a hand-built triangle takes the C loader with its three joints`, t.fc && t.joints === 3, t.refusal || `${t.joints} joints`);
 const cart = [
 { t: 'wheel', kind: 'cw', x: cx - 40, y: cy, r: 20, id: 'w1' },
 { t: 'wheel', kind: 'cw', x: cx + 40, y: cy, r: 20, id: 'w2' },
 { t: 'rod', kind: 'wood', x1: cx - 40, y1: cy, x2: cx + 40, y2: cy, id: 'axle' },
 { t: 'rod', kind: 'wood', x1: cx - 40, y1: cy, x2: cx, y2: cy - 60, id: 'm1' },
 { t: 'rod', kind: 'wood', x1: cx + 40, y1: cy, x2: cx, y2: cy - 60, id: 'm2' },
 ];
 const c = build(level, cart);
 gate(`4h. …and a two-wheel cart with its five`, c.fc && c.joints === 5, c.refusal || `${c.joints} joints`);
 const w = build(level, [{ ...tri[0], weight: 50 }]);
 gate('4h. …while a WEIGHTED stick is refused to the JS build', !w.fc && /weighted/.test(w.refusal || ''), w.refusal || 'took the C loader');
 const d = 40 * Math.SQRT1_2;
 const slot = build(level, [
 { t: 'wheel', kind: 'free', x: cx, y: cy, r: 40, id: 'w' },
 { t: 'rod', kind: 'wood', x1: cx + d, y1: cy + d, x2: cx + 140, y2: cy - 30, id: 'r' },
 ]);
 gate('4h. …and a stick on a wheel\'s 45° slot — a pin FC has not got — is refused too', !slot.fc && /pin FC/.test(slot.refusal || ''), slot.refusal || 'took the C loader');
 const spoke = build(level, [
 { t: 'wheel', kind: 'free', x: cx, y: cy, r: 40, id: 'w' },
 { t: 'rod', kind: 'wood', x1: cx + 40, y1: cy, x2: cx + 140, y2: cy - 30, id: 'r' },
 ]);
 gate('4h. …but one on its rim SPOKE is FC\'s own, and goes through', spoke.fc && spoke.joints === 1, spoke.refusal || `${spoke.joints} joints`);
 }
});

// ---------- 5. what an FC ghost line stops ----------
//
// An FC ghost line is the zero-width DynamicRectangle this suite's own banner
// already names — an invisible static line at home, imported as terrain and
// DRAWN at stick thickness so there is something to look at. What it actually
// collides with is not obvious from either the data or the drawing, and the
// EDITOR had guessed wrong: it treated one as ordinary terrain and refused
// every stick laid across it. Reported as *"I should be able to put rods
// through ghost blocks. Not wheels. It is stopping me editing as 'no rods
// through terrain'."*
//
// So this gate measures the physics and then holds the editor to it. Both
// halves matter: an editor that refuses what the game runs is a wall you cannot
// see, and one that allows what the game blocks is a machine that explodes on
// Play.
section('5', () => {
 const rig = (ghost, over = {}) => ({
 terrain: [
 { type: 'box', x: 0, y: 0, w: 800, h: 8, texture: 'classic', ...(ghost ? { line: 'h' } : {}) },
 { type: 'box', x: 0, y: 600, w: 2000, h: 60 },
 ],
 props: [], buildZones: [{ x: 0, y: -300, w: 1600, h: 600 }],
 goalZones: [{ x: 700, y: -20, w: 60, h: 60 }],
 goalObjs: [], fixedParts: [], texts: [], pins: [], groups: {}, win: 'goalObj', ...over,
 });
 // Drop it from 80 px up and see where it is 8 s later: past the line, or on it.
 const falls = (level, parts, pick) => {
 const sim = new Simulation(level, { parts }, { headless: true, physics: 'fc' });
 for (let i = 0; i < 240; i++) sim._fixedStep();
 const y = sim._pose(pick(sim).body).y;
 sim.destroy();
 return y > 100;
 };
 const ROD = [{ t: 'rod', kind: 'wood', id: 'a', x1: -60, y1: -80, x2: 60, y2: -80 }];
 const WHEEL = [{ t: 'wheel', kind: 'free', id: 'w', x: 0, y: -80, r: 20 }];
 const BALL = { goalObjs: [{ shape: 'ball', x: 0, y: -80, r: 15 }] };
 const CRATE = { goalObjs: [{ shape: 'box', x: 0, y: -80, w: 40, h: 40 }] };
 const rod = (s) => s.rods[0], wheel = (s) => s.wheels[0], goal = (s) => s.goals[0];

 const through = {
 stick: falls(rig(true), ROD, rod),
 wheel: falls(rig(true), WHEEL, wheel),
 ball: falls(rig(true, BALL), [], goal),
 crate: falls(rig(true, CRATE), [], goal),
 };
 gate('5. a stick falls straight through a ghost line', through.stick);
 gate('5. …and so does a crate', through.crate);
 gate('5. …while a wheel rides on it', !through.wheel);
 gate('5. …and so does a ball', !through.ball);
 gate('5. ORDINARY terrain holds every one of them (the control)',
 !falls(rig(false), ROD, rod) && !falls(rig(false), WHEEL, wheel)
 && !falls(rig(false, BALL), [], goal) && !falls(rig(false, CRATE), [], goal));

 // …which is exactly the rule util.js states, so the editor cannot hold a
 // second opinion about it.
 const line = { type: 'box', x: 0, y: 0, w: 800, h: 8, line: 'h' };
 const solid = { type: 'box', x: 0, y: 0, w: 800, h: 8 };
 gate('5. the shared rule says the same: round is stopped, box is not',
 terrainBlocks(line, 'round') === !through.wheel
 && terrainBlocks(line, 'box') === !through.stick
 && terrainBlocks(solid, 'box') && terrainBlocks(solid, 'round'));
 gate('5. …and a ghost line is recognised by the flag the importer writes',
 isGhostLine(line) && !isGhostLine(solid));
 // The body is the DEGENERATE box, not the 8 px band it is drawn as — which is
 // the other half: a wheel resting on a ghost line rests on the zero-height
 // line, and an editor measuring the drawing calls that 4 px buried.
 gate('5. the collider is the zero-extent box, not the drawing',
 terrainCollider(line).h === 0 && terrainCollider(line).w === 800
 && terrainCollider({ ...line, line: 'w' }).w === 0
 && terrainCollider(solid) === solid);

 // Now the EDITOR, through its own predicates on a real screen.
 const S = Object.create(GameScreen.prototype);
 Object.assign(S, {
 level: { ...rig(true), backLevel: { terrain: [], props: [], fixedParts: [], texts: [], pins: [], groups: {} } },
 design: { parts: [] }, goalPositions: [], goalMoved: [], tab: 'machine', mode: 'play',
 freeWorld: false, playing: false, sel: null, multiSel: [], drag: null,
 });
 S._toast = () => {};
 const across = { t: 'rod', kind: 'wood', id: 'x', x1: -60, y1: 0, x2: 60, y2: 0 }; // dead on the line
 gate('5. THE REPORT: a stick may be laid straight across a ghost line',
 S._rodInvalid(across, null, false) == null, S._rodInvalid(across, null, false));
 gate('5. …and is still refused across ordinary terrain',
 (S.level.terrain[0] = solid, S._rodInvalid(across, null, false) != null));
 S.level.terrain[0] = line;
 // A wheel is the one thing it stops, and it is stopped by the LINE rather
 // than by the band: resting exactly on it is legal, sitting over it is not.
 const resting = { t: 'wheel', kind: 'free', id: 'w', x: 0, y: -20, r: 20 };
 const buried = { t: 'wheel', kind: 'free', id: 'w', x: 0, y: 0, r: 20 };
 gate('5. a wheel RESTING on a ghost line is legal — it is where the physics puts it',
 S._wheelInvalid(resting, null, false) == null, S._wheelInvalid(resting, null, false));
 gate('5. …and one sitting THROUGH it is still refused',
 S._wheelInvalid(buried, null, false) != null);
 // …and the same split for the pieces an author places.
 gate('5. a CRATE may be placed across a ghost line, and a BALL may not',
 !S._pieceInTerrain({ shape: 'box', w: 40, h: 40 }, { x: 0, y: 0 })
 && S._pieceInTerrain({ shape: 'ball', r: 15 }, { x: 0, y: 0 }));
 gate('5. …while ordinary terrain refuses both',
 (S.level.terrain[0] = solid,
 S._pieceInTerrain({ shape: 'box', w: 40, h: 40 }, { x: 0, y: 0 })
 && S._pieceInTerrain({ shape: 'ball', r: 15 }, { x: 0, y: 0 })));
});

// ---------------------------------------------------------------------------
// 6. A WHEEL THE SOURCE DREW BIG (2026-08-22)
// ---------------------------------------------------------------------------
//
// CWWheel#5 (9.2588, 5.0766), (450, 450), 0 [1]
// GoalRect#1 (9.2588, 5.0766), (0, 0), 0
//
// — a level's own powered drive, 450 units across, bolted at its hub to a
// zero-area block. FC gives a zero-area body no mass and a massless body never
// moves (see the ghost lines above), so that block is a static anchor and the
// pair is the only way FC has of saying "a wheel pinned to the background".
//
// Every FC wheel anybody had MEASURED was 40 units (51 of them, across 32 saved
// designs), so the importer used to read the size as arithmetic and pull it
// onto LIFIRIK's three-rung ladder. On a hand-authored level that is simply
// false, and the failure was silent in the one place anybody looks: the body,
// the four spokes and the motor all come off the SHELL and kept the source
// radius, so the physics was right and only the drawing was wrong — an 80-unit
// disc spinning inside a 450-unit footprint.
//
// The gate is therefore "the disc drawn is the disc built", asked of the whole
// import rather than of one number, plus the two things that make this
// construct what it is: it is PINNED, and its motor is FC's own.
section('6', () => {
 // own level, boiled to its two anchors: a 0×0 goal rect under the
 // drive's hub, and a no-radius no-spin wheel off to one side.
 const paste = (dia, joint, extra = []) => [
 'BuildArea (0, 0), (2000, 2000)',
 'GoalArea (900, 900), (100, 100)',
 'StaticRect (0, 900), (2000, 40), 0',
 'GoalBall#0 (900, 850), (36, 36), 0',
 'GoalRect#1 (0, 0), (0, 0), 0',
 `CWWheel#2 (0, 0), (${dia}, ${dia}), 0${joint ? ' [1]' : ''}`,
 ...extra,
 ].join('\n');
 const build = (dia, joint = true, extra = []) => {
 const out = convertFcLevel(paste(dia, joint, extra), { recentre: false });
 const design = { parts: out.design };
 const sim = new Simulation(out.level, design, {
 headless: true, goalPositions: out.level.goalObjs.map((g) => ({ x: g.x, y: g.y })),
 });
 // `_plannedPins` exists only where `_planJoints` ran, which is only the JS
 // build — `_fcPristine`/`_fcTranspiled` are METHODS and always truthy.
 return { out, design, sim, wheel: design.parts.find((p) => p.kind === 'cw'), js: !!sim._plannedPins };
 };
 const spin = (r, frames) => { let f = 0; while (f < frames) { r.sim._fixedStep(); f++; } return r.sim.view().wheels.find((w) => w.part === r.wheel); };

 const big = build(450);
 gate('6. a 450-unit wheel comes in at r225 — the size the source drew it',
 big.wheel.r === 225, `r${big.wheel.r} (rungs are ${WHEEL_SIZES.join('/')})`);
 gate('6. …and says so, rather than snapping and staying quiet',
 (big.out.warnings || []).some((w) => /toolbar doesn't have/.test(w) && /r225/.test(w)),
 (big.out.warnings || []).find((w) => /toolbar/.test(w))?.slice(0, 70) || 'no warning');
 // THE INVARIANT. The renderer draws `part.r`; the engine builds `shell.r`.
 // One number or two is the whole of what this section is about.
 gate('6. …the disc DRAWN is the disc BUILT (part.r is the shell radius)',
 big.wheel.r === big.wheel.shell.r, `drawn r${big.wheel.r} vs built r${big.wheel.shell.r}`);
 gate('6. …and none of it costs the C loader',
 !big.js, big.js ? 'fell to the JS build' : 'fcsim\'s own graph and gen');
 // PINNED: the zero-area block holds the hub still under a live motor.
 const held = spin(big, 300);
 gate('6. the hub does not move — the zero-area block is FC\'s pin',
 Math.abs(held.x) < 1e-9 && Math.abs(held.y) < 1e-9, `hub (${held.x}, ${held.y}) after 10 s`);
 const loose = build(450, false);
 const fell = spin(loose, 300);
 gate('6. …and the control falls, so it is the JOINT holding it and not the size',
 fell.y > 300, `unjointed wheel reached y ${fell.y.toFixed(1)}`);
 // WORKING, and what "working" gets you at this size. FC's motor is a FLAT
 // 5 rad/s against 5e7 N·m whatever the radius (gen.c `gen_joint`, no size
 // term), while a disc's inertia is ∝ r⁴ — so the same construct at the
 // standard radius turns at exactly FC's 5 rad/s, and at r225 the identical
 // torque moves it 0.002 rad and Box2D sleeps it. That is FC's answer, not a
 // LIFIRIK shortfall: the big wheel is pinned and powered and it does not
 // turn. Pinned here so nobody "fixes" it into a divergence.
 const std = build(40);
 const turned = spin(std, 30);
 gate('6. the same construct at the STANDARD size turns at FC\'s flat 5 rad/s',
 Math.abs(turned.angle - 5) < 1e-6, `${turned.angle.toFixed(4)} rad in 1 s`);
 gate('6. …and at r225 the same 5e7 against r⁴ inertia does not — FC\'s own answer',
 Math.abs(held.angle) < 0.01, `${held.angle.toFixed(4)} rad in 10 s`);
 // …and the anchor this whole file rests on has not moved: an FC wheel that
 // states the standard 40 units is STD_WHEEL_R to the bit at the shipped
 // scale, so nothing already imported changes size.
 gate('6. an ordinary 40-unit FC wheel is still exactly the standard rung',
 std.wheel.r === STD_WHEEL_R && std.wheel.r === std.wheel.shell.r,
 `r${std.wheel.r} vs STD_WHEEL_R ${STD_WHEEL_R}`);

 // ---- 6p: and the same rule at the other end — a wheel of NO radius ----
 //
 // (2026-08-22: *"The UPWheels and the main wheel are all pinned in
 // the FC1/FC2/FCSim case. Ours just fall."* and *"Initially works fine in
 // Maker Create, but fails in test and after being saved."*)
 //
 // `UPWheel#6 (…), (0, 0), 0` is a wheel the source drew with no radius —
 // massless, therefore static, therefore an invisible ANCHOR, which is the
 // only way FC has of bolting anything to the background. It came in as a
 // standard grey wheel, because the size read was `w > 0` and a stated 0 took
 // the same fallback as a stated nothing. Two opposite facts, one branch.
 //
 // The anchors then have to survive leaving the C loader, and there were two
 // ways to leave it: an edit FC cannot spell, and — until now — pressing Save,
 // because `_levelData` is a whitelist and `fcWorld` was not on it. Both land
 // on LIFIRIK's own build, which had no way to say "anchor" at all.
 const anchors = build(450, true, ['UPWheel#3 (600, 0), (0, 0), 0']);
 const zero = anchors.design.parts.find((p) => p.kind === 'free');
 gate('6p. a wheel the source drew with NO radius is not a standard wheel',
 zero.r === MIN_BALL_R, `r${zero.r} (the round floor; a standard wheel is r${STD_WHEEL_R})`);
 gate('6p. …every zero-area block gets a pin, marked as the source\'s own',
 (anchors.out.level.pins || []).length === 2 && (anchors.out.level.pins || []).every((p) => p.fc),
 JSON.stringify(anchors.out.level.pins));
 gate('6p. …one pin, not two, where the wheel and its anchor share a point',
 (anchors.out.level.pins || []).filter((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9).length === 1,
 `${(anchors.out.level.pins || []).length} pins for 2 anchors and 1 hub on one of them`);
 // THE REPORT. Strip the C loader and run LIFIRIK's own build: at home this
 // level does not move, so neither may this.
 const noFc = { ...JSON.parse(JSON.stringify(anchors.out.level)) };
 delete noFc.fcWorld;
 const own = new Simulation(noFc, { parts: JSON.parse(JSON.stringify(anchors.design.parts)) },
 { headless: true, goalPositions: noFc.goalObjs.map((g) => ({ x: g.x, y: g.y })) });
 const y0 = own.view().wheels.map((w) => w.y);
 for (let i = 0; i < 300; i++) own._fixedStep();
 const drop = own.view().wheels.map((w, i) => Math.abs(w.y - y0[i]));
 gate('6p. …so LIFIRIK\'s OWN build holds what FC held — nothing falls',
 !!own._plannedPins && drop.every((d) => d < 1e-9),
 `${own._plannedPins ? 'JS build' : 'C loader (wrong path for this gate)'}, drops ${drop.map((d) => d.toFixed(1)).join('/')}`);
 gate('6p. …while the pins cost the C loader nothing, because FC already has them',
 !anchors.js, anchors.js ? 'fell to the JS build' : 'still fcsim\'s own graph and gen');
 // …and an AUTHOR's pin is still a pin FC cannot write down.
 const mine = { ...anchors.out.level, pins: [...(anchors.out.level.pins || []), { x: 300, y: 0 }] };
 gate('6p. …but a pin the author placed still ends the transcription',
 /loose pins/.test(fcMachineXml(mine, anchors.design.parts, {}).refusal || ''),
 fcMachineXml(mine, anchors.design.parts, {}).refusal || 'transcribed anyway');
 // …and the save that used to throw the whole thing away.
 {
 const S = Object.create(GameScreen.prototype);
 S.level = anchors.out.level;
 S.backEditing = false;
 const saved = S._levelData();
 gate('6p. a Maker save keeps the source world — the whitelist trap, sprung',
 saved.fcWorld === anchors.out.level.fcWorld && (saved.pins || []).length === 2,
 `fcWorld ${saved.fcWorld ? 'kept' : 'DROPPED'}, ${(saved.pins || []).length} pins kept`);
 }
});

// ---------- XML is a first-class import (2026-08-24) ----------
//
// "importer needs to process XML input as well." retrieveLevel XML in the
// textarea converts through the same pipeline as the paste dialect. These
// drive the real convertFcLevel on a fixture, offline.
section('fcxml', () => {
 const XML = (blocks, zones = true) => `<?xml version="1.0"?><retrieveLevel>
<levelId>496911</levelId>
<levelNumber></levelNumber>
<name>Fixture</name>
<level>
<levelBlocks>${blocks}</levelBlocks>
${zones ? `<start><position><x>-100</x><y>0</y></position><width>200</width><height>100</height></start>
<end><position><x>300</x><y>0</y></position><width>100</width><height>100</height></end>` : ''}
</level>
</retrieveLevel>`;
 const STATIC = '<StaticRectangle><rotation>0</rotation><position><x>0</x><y>60</y></position><width>400</width><height>20</height></StaticRectangle>';
 const CARGO = '<NoSpinWheel id="7"><rotation>0</rotation><position><x>-80</x><y>-20</y></position><width>40</width><height>40</height><goalBlock>true</goalBlock></NoSpinWheel>';

 {
 const out = convertFcLevel(XML(STATIC + CARGO), {});
 gate('fcxml. retrieveLevel XML converts straight from the textarea',
 out.stats.parsed > 0 && out.level.terrain.length === 1 && out.level.goalObjs.length === 1,
 `${out.stats.parsed} parsed, ${out.level.terrain.length} terrain, ${out.level.goalObjs.length} cargo`);
 // the credit's shape is (2026-08-24): the name quoted, the id
 // in brackets, the site named once by the thanks line
 gate('fcxml. …and carries FC\'s own provenance without being told anything',
 /"Fixture" \(level 496911\)/.test(out.level.desc) && /Thanks to FantasticContraption\.com\./.test(out.level.desc),
 out.level.desc);
 }
 {
 // the case the old code refused: a LEVEL with no player pieces at all —
 // fcXmlToPaste was a design door and required them
 const out = convertFcLevel(XML(STATIC), {});
 gate('fcxml. a level with no design converts too — zones are the only hard requirement',
 out.stats.parsed > 0 && out.level.terrain.length === 1,
 'requireDesign: false is the import screen\'s mode');
 }
 {
 // …while the .fcxml door keeps its design requirement untouched
 gate('fcxml. the .fcxml door still refuses a design file with no design in it',
 fcXmlToPaste(XML(STATIC)) === null && fcXmlToPaste(XML(STATIC), { requireDesign: false }) !== null);
 }
 {
 let threw = null;
 try { convertFcLevel(XML('', false), {}); } catch (e) { threw = e.message; }
 gate('fcxml. zoneless XML throws the sentence, not the paste-grammar hint',
 /no build and goal areas/.test(threw || ''), String(threw));
 }
 {
 const withId = convertFcLevel(XML(STATIC + CARGO), { fcDesignId: '12345' });
 const bare = convertFcLevel(XML(STATIC + CARGO), {});
 gate('fcxml. a known design id signs itself, and a hand-paste does not invent one',
 /\(design 12345\)/.test(withId.level.desc) && !/design \d/.test(bare.level.desc),
 withId.level.desc);
 }
});

// ---------- a translated shell is still the machine (2026-09-01) ----------
//
// "The cut/paste machines are not stuck together at their pins." / "Ctrl-Shift
// select everything and move it a little bit. Everything breaks. When run the
// pieces jump back."
//
// Play rebuilds a shelled wheel from `shell` while the hub is within 2.5 px
// (import snap). A 1 px editor move that left the shell behind therefore
// rebuilt the wheels at the OLD hub and the rods at the NEW ends. This fixture
// is the machine AFTER a correct 1 px translation: stored coords, shell and
// snap ends all shifted together. Play must start at the new spot, with the
// declared pin still holding.
section('moved-shell', () => {
  const world = () => ({
    terrain: [{ type: 'box', x: 0, y: 30, w: 2400, h: 60 }],
    props: [], buildZones: [{ x: 0, y: -150, w: 2000, h: 300 }],
    goalZones: [{ x: 900, y: -40, w: 120, h: 80 }],
    goalObjs: [{ shape: 'ball', x: -900, y: -20, r: 15 }],
    fixedParts: [], texts: [], pins: [], groups: {},
  });
  const machine = (dx) => {
    const w = {
      t: 'wheel', kind: 'free', x: dx, y: -20, r: 20, id: 'w1',
      att: [null], shell: { x: dx, y: -20, r: 20, rot: 0 },
    };
    const r = {
      t: 'rod', kind: 'wood', x1: dx, y1: -20, x2: dx + 80, y2: -20, id: 'r1',
      att: ['w1', null],
      shell: { x: dx + 40, y: -20, len: 80, rot: 0 },
      snap1: { x: dx, y: -20 }, snap2: { x: dx + 80, y: -20 },
    };
    return [w, r];
  };
  const pose = (dx) => {
    const sim = new Simulation(world(), { parts: machine(dx) }, { headless: true, physics: 'fc' });
    const x = sim.wheels[0] ? sim._pose(sim.wheels[0].body).x : NaN;
    const joints = sim.jointRecs.length;
    sim.destroy();
    return { x, joints };
  };
  const at0 = pose(0);
  const at1 = pose(1);
  gate('moved-shell. a 1 px translation of a shelled machine Plays at the new hub, not the old one',
    Math.abs(at0.x) < 0.05 && Math.abs(at1.x - 1) < 0.05,
    `unmoved ${at0.x}, moved ${at1.x}`);
  gate('moved-shell. …and the declared pin still holds',
    at0.joints >= 1 && at1.joints === at0.joints,
    `joints at 0: ${at0.joints}, at 1 px: ${at1.joints}`);
});

// ---------- a 1 px move of an IMPORTED machine must not jump back ----------
//
// The JS-path gate above never had `fcWorld`, so it could not catch this:
// Play prefers the C loader, and the transpiler reused the source XML for any
// part still within 2.5 px of its block (wheels) or whose snap ends still
// agreed with the stored ends (rods). After the editor started carrying the
// shell with a nudge, BOTH stayed true — original XML, pieces jump back.
section('moved-import', () => {
  const paste = [
    'BuildArea (-400, -250), (800, 400)',
    'GoalArea (280, -80), (120, 80)',
    'StaticRect (0, 30), (1200, 60), 0',
    'GoalRect#0 (300, -20), (40, 30), 0',
    'Stick#1 (40, -20), (80, 8), 0',
    'CWWheel#2 (0, -20), (40, 40), 0 [1]',
  ].join('\n');
  const imported = convertFcLevel(paste, { recentre: false, scale: 1 });
  gate('moved-import. the fixture has a C-loader world',
    !!(imported.level && imported.level.fcWorld && imported.level.fcWorld.xml),
    imported.level?.fcWorld ? 'fcWorld' : 'no fcWorld');

  const shiftPart = (p, dx, dy) => {
    if (p.t === 'wheel') { p.x += dx; p.y += dy; }
    else { p.x1 += dx; p.y1 += dy; p.x2 += dx; p.y2 += dy; }
    if (p.shell) { p.shell.x += dx; p.shell.y += dy; }
    if (p.snap1) { p.snap1.x += dx; p.snap1.y += dy; }
    if (p.snap2) { p.snap2.x += dx; p.snap2.y += dy; }
  };
  const clone = () => JSON.parse(JSON.stringify({
    level: imported.level,
    design: { parts: imported.design || [] },
  }));
  const wheelX = (pack) => {
    const sim = new Simulation(pack.level, pack.design, {
      headless: true, physics: 'fc',
      goalPositions: pack.level.goalObjs.map((g) => ({ x: g.x, y: g.y })),
    });
    const w = sim.wheels[0];
    const x = w ? sim._pose(w.body).x : NaN;
    const t = sim.terrain[0];
    const tx = t ? sim._pose(t.body).x : NaN;
    const joints = sim._fcWorld ? sim.E.fc_joined_count() : sim.jointRecs.length;
    const path = sim._fcWorld ? 'C' : 'JS';
    sim.destroy();
    return { x, tx, joints, path };
  };

  const unmoved = clone();
  const at0 = wheelX(unmoved);
  const w0 = (unmoved.design.parts.find((p) => p.t === 'wheel')
    || unmoved.level.fixedParts.find((p) => p.t === 'wheel'));
  gate('moved-import. unmoved, Play sits on the authored hub',
    w0 && Math.abs(at0.x - w0.x) < 0.05,
    `pose ${at0.x} authored ${w0 && w0.x} path ${at0.path}`);

  const nudged = clone();
  for (const p of [...nudged.design.parts, ...nudged.level.fixedParts]) shiftPart(p, 1, 0);
  const at1 = wheelX(nudged);
  const w1 = (nudged.design.parts.find((p) => p.t === 'wheel')
    || nudged.level.fixedParts.find((p) => p.t === 'wheel'));
  gate('moved-import. a 1 px machine nudge Plays at the new hub, not the old one',
    w1 && Math.abs(at1.x - w1.x) < 0.05 && Math.abs(at1.x - (w0.x + 1)) < 0.05,
    `pose ${at1.x} want ${w1 && w1.x} was ${w0 && w0.x} path ${at1.path}`);
  gate('moved-import. …and the pin still holds',
    at1.joints >= 1,
    `${at1.joints} joints on ${at1.path}`);

  const whole = clone();
  for (const p of [...whole.design.parts, ...whole.level.fixedParts]) shiftPart(p, 1, 0);
  for (const t of whole.level.terrain) { t.x += 1; }
  for (const g of whole.level.goalObjs) { g.x += 1; }
  const atAll = wheelX(whole);
  gate('moved-import. Ctrl+A + 1 px (machine and floor) does not jump the floor back',
    Math.abs(atAll.tx - (at0.tx + 1)) < 0.05,
    `terrain pose ${atAll.tx} was ${at0.tx} path ${atAll.path}`);
  gate('moved-import. …or the machine',
    Math.abs(atAll.x - (w0.x + 1)) < 0.05,
    `wheel pose ${atAll.x} want ${w0.x + 1} path ${atAll.path}`);
});

summary();
