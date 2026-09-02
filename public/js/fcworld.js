// fcworld.js — a machine on an FC-imported level, said in FC's own XML.
//
// **Any FC-piece machine on an FC level takes FC's builder** (2026-08-18,
// D1: "FC pieces on an FC level → FC's builder", one rule instead
// of one special case). An imported level carries its source world
// (level.fcWorld: the transpiled retrieveLevel XML, and the manifests sim.js
// maps the C bodies onto records by). Until now only the PRISTINE imported
// design went through fcsim's own xml/graph/gen — the moment a player moved
// a stick, added one, or the solver proposed one, the whole world was rebuilt
// by LIFIRIK's own JS path: near-identical physics, not bit-exact, and the
// pristine Sticks solves replayed 32/32 on the C loader against 5/32 on it.
//
// This module writes the XML the C loader wants for ANY machine made of FC's
// pieces: the level's own blocks verbatim (their digit strings untouched, so
// fp_strtod reads exactly what the source wrote), the goal blocks verbatim,
// and the machine as SolidRod / HollowRod / NoSpinWheel / ClockwiseWheel /
// CounterClockwiseWheel blocks with the `<joints>` lists FC's graph resolves
// (graph.c add_rod / add_wheel: a block names the EARLIER blocks it is
// jointed to, and each end or hub attaches to the closest joint of a named
// block within 10 units — a rod's ends, a wheel's hub and four rim spokes, a
// goal rect's centre and four corners — or founds its own).
//
// **What may go through, and what may not.** The C loader is FC's semantics
// entire, so a machine goes this way only when saying it in FC's dialect
// loses nothing:
// - every part is an FC piece: a wood or water rod with no weight dial and
// no rope chain; a free / cw / ccw wheel of any radius;
// - every joint the part makes (LIFIRIK's rule: pins sharing an exact
// coordinate) is one FC's graph has — another rod's end, a wheel's hub or
// one of its four cardinal spokes, a goal rect's centre or corner, a goal
// wheel's hub or spoke. A rod on an inner-ring pin, a diagonal slot or a
// crate's edge midpoint is bolted to something FC cannot name, and the
// honest world for it is the JS build, which has those pins;
// - nothing in the level is LIFIRIK's own bolt — no level pins, no pins on
// props or terrain (an FC import has none; a Maker edit may add them);
// - a dragged goal piece is a goal block with an empty joints list that no
// other block names, so its position can simply be rewritten.
// Anything else returns a refusal, and the sim builds the JS world as before.
//
// **An untouched imported part keeps its source digits.** A part the importer
// declared (`att`, `srcSeq`, `shell`) that still agrees with its shell is
// written as the XML block it came from — rotation, position, width and
// height copied character for character — so a pristine design transpiled
// here IS its own source XML with the ids renumbered, and an edited one stays
// bit-exact on every stick the edit did not touch. Everything else is written
// from the stored coordinates in the shortest round-trip decimal, which
// fp_strtod reads to the same double a replay will read again: deterministic,
// and exactly what FC would build from this XML if it were sent there.
//
// Block order is FC's own where FC had one: the level's goal blocks and the
// surviving imported blocks in their source order (a block may only name a
// block above it, so order IS part of the graph — the same `srcSeq` sort
// _planJoints uses), then the hand-built parts in the order they were laid.
import { goalPinOffsets, wheelPinOffsets } from './util.js';

// LIFIRIK's coordinate rule: two pins are one joint when jointKey agrees,
// which is 0.1 px. FC then attaches within 10, so anything this names, FC
// finds.
const TOL = 0.1 + 1e-9;
const near = (ax, ay, bx, by) => Math.abs(ax - bx) <= TOL && Math.abs(ay - by) <= TOL;
// A part or scenery piece is still AT its source block. Tighter than the
// 2.5 px import-snap window on stored wheel hubs: that window is why a 1 px
// editor nudge re-emitted the original XML and Play jumped back.
const AT_SRC = 0.01;
const atSource = (x, y, bx, by) => Math.abs(x - bx) < AT_SRC && Math.abs(y - by) < AT_SRC;
// FC's four spokes / LIFIRIK's four cardinal rim pins, at exact r (no trig
// on the cardinals — util.js ringOffsets says the same, so both parties hold
// bit-identical floats). A rotated wheel's spokes ride its rotation.
const A4 = [0, Math.PI / 2, Math.PI, 4.71238898038469];
const spokes = (x, y, r, rot) => (rot
 ? A4.map((a) => [x + Math.cos(rot + a) * r, y + Math.sin(rot + a) * r])
 : [[x + r, y], [x, y + r], [x - r, y], [x, y - r]]);
const NUM = (v) => String(v); // shortest round-trip; fp_strtod reads exponents too

const BLOCK_RE = /<(StaticRectangle|StaticCircle|DynamicRectangle|DynamicCircle|JointedDynamicRectangle|NoSpinWheel|ClockwiseWheel|CounterClockwiseWheel|SolidRod|HollowRod)(\s+id\s*=\s*["'](\d+)["'])?\s*>([\s\S]*?)<\/\1>/g;
const numS = (b, t) => { const m = b.match(new RegExp('<' + t + '>\\s*(-?[\\d.eE+-]+)\\s*</' + t + '>')); return m ? m[1] : null; };
const posS = (b) => { const m = b.match(/<position>\s*<x>\s*(-?[\d.eE+-]+)\s*<\/x>\s*<y>\s*(-?[\d.eE+-]+)\s*<\/y>\s*<\/position>/); return m ? { x: m[1], y: m[2] } : null; };
const jointsOf = (b) => [...b.matchAll(/<jointedTo>\s*(\d+)\s*<\/jointedTo>/g)].map((m) => +m[1]);
const WHEEL_TAG = { free: 'NoSpinWheel', cw: 'ClockwiseWheel', ccw: 'CounterClockwiseWheel' };
const WHEEL_T = { NoSpinWheel: 5, ClockwiseWheel: 6, CounterClockwiseWheel: 7 };
const ROD_TAG = { wood: 'SolidRod', water: 'HollowRod' };
const ROD_T = { SolidRod: 8, HollowRod: 9 };

// The player blocks of the level's source XML, split and typed.
function playerBlocksOf(xml) {
 const open = xml.indexOf('<playerBlocks>'), close = xml.indexOf('</playerBlocks>');
 if (open < 0 || close < 0) return null;
 const head = xml.slice(0, open + '<playerBlocks>'.length);
 const body = xml.slice(open + '<playerBlocks>'.length, close);
 const tail = xml.slice(close);
 const blocks = [];
 for (const m of body.matchAll(BLOCK_RE)) {
 const [text, type,, bid, inner] = m;
 blocks.push({ text, type, id: bid != null ? +bid : null, inner, goal: /<goalBlock>true<\/goalBlock>/.test(inner), joints: jointsOf(inner) });
 }
 return { head, tail, blocks };
}

// Does an imported part still sit on the source block, so the source's own
// digits may be reused? That is NOT `shellLive`. `shellLive` asks whether the
// stored coords still agree with the shell — and after a 1 px editor move
// that carried the shell with them, they do. Re-emitting the ORIGINAL xml
// then built Play at the old hub, which is the jump-back. The shell's centre
// is the source position; if the editor translated it, this is a new block.
function partMatchesBlock(p, blk, dx, dy) {
 const pos = posS(blk.inner);
 if (!pos) return false;
 const bx = Number(pos.x) + dx, by = Number(pos.y) + dy;
 // **The KIND has to match too, not just the geometry** (2026-08-19, found by
 // measurement: flipping every rod's material on Sticks 09 produced a
 // byte-identical XML and a bit-identical win). This is the same trap
 // `_fcPristine` names — "a stick toggled to water, a wheel's spin flipped:
 // same coordinates, different physics" — and the transpiler walked into it
 // from the other side: a part whose kind alone changed still matched its
 // source block, so the block was re-emitted verbatim and the toggle did
 // nothing at all. A tag is the kind: solid/hollow rod, no-spin/cw/ccw wheel.
 if (p.t === 'wheel') {
 if (blk.type !== WHEEL_TAG[p.kind]) return false;
 if (p.shell && !atSource(p.shell.x, p.shell.y, bx, by)) return false;
 return Math.abs(bx - p.x) <= 2.5 && Math.abs(by - p.y) <= 2.5;
 }
 if (blk.type !== ROD_TAG[p.kind]) return false;
 if (p.shell && !atSource(p.shell.x, p.shell.y, bx, by)) return false;
 const rot = Number(numS(blk.inner, 'rotation') ?? 0), len = Number(numS(blk.inner, 'width') ?? 0);
 const cw = Math.cos(rot) * len / 2, sw = Math.sin(rot) * len / 2;
 const e1 = p.snap1 ?? { x: bx - cw, y: by - sw };
 const e2 = p.snap2 ?? { x: bx + cw, y: by + sw };
 return Math.abs(e1.x - p.x1) < AT_SRC && Math.abs(e1.y - p.y1) < AT_SRC
 && Math.abs(e2.x - p.x2) < AT_SRC && Math.abs(e2.y - p.y2) < AT_SRC;
}

// The level's scenery blocks, in XML order — the same order `W.levels` maps
// onto `terrain` / `props`. The C loader never rewrites these, so a Ctrl+A
// move of the whole level that left them behind in the XML jumped the floor
// (and everything on it) back on Play.
function sceneryBlocksOf(xml) {
 const open = xml.indexOf('<levelBlocks>'), close = xml.indexOf('</levelBlocks>');
 if (open < 0 || close < 0) return [];
 const body = xml.slice(open + '<levelBlocks>'.length, close);
 const blocks = [];
 for (const m of body.matchAll(BLOCK_RE)) {
 const [, type,, , inner] = m;
 blocks.push({ type, inner, pos: posS(inner) });
 }
 return blocks;
}

// The pieces of one XML block, re-serialised with a new id and joint list.
function blockXml(tag, id, rot, x, y, w, h, goal, joints) {
 return ` <${tag} id="${id}">
 <rotation>${rot}</rotation>
 <position><x>${x}</x><y>${y}</y></position>
 <width>${w}</width>
 <height>${h}</height>
 <goalBlock>${goal ? 'true' : 'false'}</goalBlock>
 ${joints.length ? `<joints>${joints.map((j) => `<jointedTo>${j}</jointedTo>`).join('')}</joints>` : '<joints/>'}
 </${tag}>`;
}

// → { xml, players, order } or { refusal }
// xml the level's source XML with the player blocks replaced;
// players the per-player-block manifest ({t, goal}) in the XML's order —
// what _buildFcWorld maps its recs with;
// order the machine parts in the order they were written, so the recs
// pull the right part for each block.
export function fcMachineXml(level, designParts, opts = {}) {
 const W = level.fcWorld;
 if (!W || !W.xml || !Array.isArray(W.players)) return { refusal: 'no source world' };
 const dx = W.dx || 0, dy = W.dy || 0;
 const machine = [...(designParts || []), ...(level.fixedParts || [])]
 .filter((p) => p.t === 'wheel' || p.t === 'rod');
 // ---- LIFIRIK's own bolts make it LIFIRIK's level ----
 //
 // **…but an `fc` pin is not LIFIRIK's, it is the source's, restated**
 // (2026-08-22). FC bolts to the background with a body that has no mass — a
 // 0×0 block, a wheel of no radius — and the importer now places a loose pin
 // on each so the JS build can hold what FC holds. Those points are ALREADY
 // in the XML as the blocks they came from, so the C loader needs nothing
 // said and refusing over them would take every such level off the exact
 // path for restating a fact it already has. A pin the AUTHOR placed is a
 // different matter and still ends the transcription: FC has no way to write
 // it down.
 if ((level.pins || []).some((p) => !p?.fc)) return { refusal: 'the level has loose pins' };
 for (const list of [level.props || [], level.terrain || []]) {
 for (const p of list) if ((Array.isArray(p.pins) && p.pins.length) || p.pin) return { refusal: 'a level piece carries a pin' };
 }
 // The C loader builds scenery from the source XML, verbatim. A select-all
 // nudge that moved the floor (and the machine with it) has to take the JS
 // build — there is no dialect for "the whole level slid a pixel".
 {
 const scenery = sceneryBlocksOf(W.xml);
 if (scenery.length !== (W.levels || []).length) return { refusal: 'level manifest disagrees with the scenery XML' };
 let ti = 0, pi = 0;
 for (let i = 0; i < scenery.length; i++) {
 const pos = scenery[i].pos;
 if (!pos) return { refusal: 'a scenery block has no position' };
 const live = (W.levels[i] && W.levels[i].dynamic)
 ? (level.props || [])[pi++]
 : (level.terrain || [])[ti++];
 if (!live) return { refusal: 'scenery manifest disagrees with the piles' };
 if (!atSource(live.x, live.y, Number(pos.x) + dx, Number(pos.y) + dy)) {
 return { refusal: 'the scenery moved' };
 }
 }
 }
 // ---- every part an FC piece ----
 for (const p of machine) {
 if (p.t === 'rod') {
 if (!ROD_TAG[p.kind]) return { refusal: `a ${p.kind} rod` };
 if (p.weight != null && p.weight !== 1) return { refusal: 'a weighted rod' };
 if (p.chain != null) return { refusal: 'a rope' };
 } else if (!WHEEL_TAG[p.kind]) return { refusal: `a ${p.kind} wheel` };
 }
 const src = playerBlocksOf(W.xml);
 if (!src) return { refusal: 'the source XML has no player list' };
 const goalBlocks = src.blocks.filter((b) => b.goal);
 const srcMachine = src.blocks.filter((b) => b.type !== 'JointedDynamicRectangle'); // srcSeq counts these (goal wheels included)

 // ---- the goal pieces: FC's nodes on each, and which block each is ----
 // Box goals pull JointedDynamicRectangles in order, ball goals pull goal
 // wheels in order — the two family queues _buildFcWorld uses.
 const goalObjs = level.goalObjs || [];
 const positions = opts.goalPositions || [];
 const boxBlocks = goalBlocks.filter((b) => b.type === 'JointedDynamicRectangle');
 const ballBlocks = goalBlocks.filter((b) => b.type !== 'JointedDynamicRectangle');
 let bi = 0, wi = 0;
 const goalNodes = []; // per goalObj: { blk, fc: [[x,y]…], other: [[x,y]…], moved }
 for (let i = 0; i < goalObjs.length; i++) {
 const g = goalObjs[i];
 const blk = g.shape === 'box' ? boxBlocks[bi++] : ballBlocks[wi++];
 if (!blk) return { refusal: 'a goal piece has no source block' };
 const pos = positions[i] || g;
 // Create-tab moves write BOTH g.x and goalPositions, so "staged !== spawn"
 // never saw them. Compare to the source block, which is the XML Play
 // would otherwise rebuild.
 const srcPos = posS(blk.inner);
 const moved = !srcPos || !atSource(pos.x, pos.y, Number(srcPos.x) + dx, Number(srcPos.y) + dy);
 let fc;
 if (g.shape === 'box') {
 const a = g.angle || 0, c = Math.cos(a), s = Math.sin(a), hw = g.w / 2, hh = g.h / 2;
 fc = [[0, 0], [hw, hh], [-hw, hh], [hw, -hh], [-hw, -hh]].map(([ox, oy]) => [pos.x + ox * c - oy * s, pos.y + ox * s + oy * c]);
 } else {
 const rot = Number(numS(blk.inner, 'rotation') ?? 0);
 fc = [[pos.x, pos.y], ...spokes(pos.x, pos.y, g.r, rot)];
 }
 // every other pin LIFIRIK draws on it — inner rings and frames — is not FC's
 const other = goalPinOffsets(g).map(([ox, oy]) => [pos.x + ox, pos.y + oy])
 .filter(([x, y]) => !fc.some(([fx, fy]) => near(x, y, fx, fy)));
 goalNodes.push({ blk, fc, other, moved });
 }
 // a dragged goal block must be free of joints in the source, both ways
 for (const gn of goalNodes) {
 if (!gn.moved) continue;
 if (gn.blk.joints.length) return { refusal: 'a dragged goal piece is jointed in the source' };
 if (gn.blk.id != null && src.blocks.some((b) => b !== gn.blk && b.joints.includes(gn.blk.id))) return { refusal: 'a dragged goal piece is named by another block' };
 }

 // ---- order: source order for what came from the source, then the rest ----
 const bySeq = new Map();
 for (const p of machine) if (p.srcSeq != null && !bySeq.has(p.srcSeq)) bySeq.set(p.srcSeq, p);
 let nextId = Math.max(-1, ...src.blocks.map((b) => (b.id != null ? b.id : -1))) + 1;
 const emitted = []; // { part|null, blk|null, id, nodes: {fc:[[x,y]], other:[[x,y]]}, isGoal }
 const order = []; // machine parts in emitted order
 const players = [];
 const out = [];
 const seenParts = new Set();

 // FC's nodes on a machine part, and LIFIRIK's extra pins on it
 const nodesOfPart = (p) => {
 if (p.t === 'rod') return { fc: [[p.x1, p.y1], [p.x2, p.y2]], other: [] };
 const fc = [[p.x, p.y], ...spokes(p.x, p.y, p.r, 0)];
 const other = wheelPinOffsets(p.r).map(([ox, oy]) => [p.x + ox, p.y + oy])
 .filter(([x, y]) => !fc.some(([fx, fy]) => near(x, y, fx, fy)));
 return { fc, other };
 };
 // the coordinate rule for one attachment point: which earlier blocks does
 // it sit on — and is it on any pin FC cannot name?
 const nameAt = (x, y) => {
 const ids = [];
 for (const e of emitted) {
 if (e.nodes.other.some(([ox, oy]) => near(x, y, ox, oy))) return { refusal: 'a joint on a pin FC has not got' };
 if (e.nodes.fc.some(([fx, fy]) => near(x, y, fx, fy))) ids.push(e.id);
 }
 return { ids };
 };
 const emitPart = (p, blk) => {
 seenParts.add(p);
 // A source part keeps its source id, so the source's own joint lists
 // (its and everyone else's) stay true without a remap; a hand-built
 // part gets the next id above anything the source used.
 const id = blk && blk.id != null ? blk.id : nextId++;
 // **Joints: the source's own list where there is one, the coordinate
 // rule where there is not.** A source part's `<joints>` is FC's truth
 // for it, kept VERBATIM and in order (find_closest_joint breaks a tie
 // between two nodes at one coordinate by list order, and a stack's
 // chaining hangs on that) — a named block the edit deleted is simply
 // not found (graph.c find_block), which is FC's own answer to a missing
 // neighbour, and a hand-built part laid on it later names IT, which is
 // the same joint from the other side. A hand-built part — no `att` — is
 // jointed by coordinate at every point, the only truth the editor has.
 let joints;
 if (blk) joints = [...blk.joints];
 else {
 joints = [];
 const points = p.t === 'rod' ? [[p.x1, p.y1], [p.x2, p.y2]] : [[p.x, p.y]];
 for (const [x, y] of points) {
 const r = nameAt(x, y);
 if (r.refusal) return r.refusal;
 joints.push(...r.ids);
 }
 }
 joints = [...new Set(joints)].filter((j) => j !== id);
 let text;
 if (blk && partMatchesBlock(p, blk, dx, dy)) {
 // the source's own digits, re-headed
 const inner = blk.inner.replace(/<joints>[\s\S]*?<\/joints>|<joints\/>/, joints.length ? `<joints>${joints.map((j) => `<jointedTo>${j}</jointedTo>`).join('')}</joints>` : '<joints/>');
 text = ` <${blk.type} id="${id}">${inner}</${blk.type}>`;
 players.push({ t: WHEEL_T[blk.type] ?? ROD_T[blk.type], goal: false });
 } else if (p.t === 'rod') {
 const tag = ROD_TAG[p.kind];
 const cx = (p.x1 + p.x2) / 2 - dx, cy = (p.y1 + p.y2) / 2 - dy;
 const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
 const rot = Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
 text = blockXml(tag, id, NUM(rot), NUM(cx), NUM(cy), NUM(len), p.kind === 'wood' ? '8' : '4', false, joints);
 players.push({ t: ROD_T[tag], goal: false });
 } else {
 const tag = WHEEL_TAG[p.kind];
 text = blockXml(tag, id, '0', NUM(p.x - dx), NUM(p.y - dy), NUM(p.r * 2), NUM(p.r * 2), false, joints);
 players.push({ t: WHEEL_T[tag], goal: false });
 }
 out.push(text);
 order.push(p);
 emitted.push({ part: p, blk: null, id, nodes: nodesOfPart(p), isGoal: false });
 return null;
 };
 const emitGoal = (blk) => {
 const gn = goalNodes.find((g) => g.blk === blk);
 let text = blk.text;
 if (gn && gn.moved) {
 const i = goalNodes.indexOf(gn);
 const pos = positions[i];
 text = text.replace(/<position>[\s\S]*?<\/position>/, `<position><x>${NUM(pos.x - dx)}</x><y>${NUM(pos.y - dy)}</y></position>`);
 }
 out.push(' ' + text.trim());
 players.push({ t: blk.type === 'JointedDynamicRectangle' ? 4 : WHEEL_T[blk.type], goal: true });
 emitted.push({ part: null, blk, id: blk.id, nodes: gn ? { fc: gn.fc, other: gn.other } : { fc: [], other: [] }, isGoal: true });
 };

 // walk the source's player list: goal blocks in place, surviving imported
 // parts in place (a deleted one leaves no block behind)
 let seq = 0;
 for (const blk of src.blocks) {
 if (blk.goal) { emitGoal(blk); if (blk.type !== 'JointedDynamicRectangle') seq++; continue; }
 if (blk.type === 'JointedDynamicRectangle') continue; // a non-goal goal rect: not a thing FC writes
 const p = bySeq.get(seq++);
 if (!p || seenParts.has(p)) continue;
 const refusal = emitPart(p, blk);
 if (refusal) return { refusal };
 }
 // …then everything the player (or the solver) laid, in the order laid
 for (const p of machine) {
 if (seenParts.has(p)) continue;
 const refusal = emitPart(p, null);
 if (refusal) return { refusal };
 }
 const xml = src.head + '\n' + out.join('\n') + '\n ' + src.tail;
 return { xml, players, order };
}
