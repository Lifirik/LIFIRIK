// prune-dead-solves.mjs — every winning solve in the database is replayed
// against its level as it stands; the ones that no longer win are deleted.
//
// node scripts/prune-dead-solves.mjs --dry
// node scripts/prune-dead-solves.mjs --db data/db.sqlite
// node scripts/prune-dead-solves.mjs --from 1 --to 32 campaign numbers only
//
// (2026-08-19: "So lets delete all the solves in DEV/PROD that no
// longer work.") The physics moved twice today (one motor per hub, FC's
// torque; the big wheel ∝ r²) and the Starters were rescaled by 4/3, so a
// solve recorded before that is a claim the level no longer backs. Every
// solve is judged the way the server judges a save: the design replayed
// from its stored parts and goal positions on the level's current data,
// through the same Simulation the game runs. What no longer wins goes the
// way the DELETE route sends it — off the log, its design row and share
// card with it — and the owner index rebuilds itself at the next boot.
//
// Left alone, and said so: a won solve with no stored design (nothing to
// replay), an attempt (never claimed a win), and a solve backing an open
// race or challenge (the route refuses those too). RUN AGAINST A STOPPED
// SERVER — it holds the store in memory and writes the old rows back.
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(root, p)).href;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const DB_PATH = arg('db', process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite'));
const FROM = arg('from', null) != null ? Number(arg('from')) : null;
const TO = arg('to', null) != null ? Number(arg('to')) : null;
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const MAX_S = Number(arg('seconds', 95));

const { initEngine, Simulation } = await import(u('public/js/sim.js'));
await initEngine(path.join(root, 'public/vendor/fcsim/fcsim.wasm'));

if (!DRY && !FORCE) {
 const port = /[\\/]LP[\\/]/.test(DB_PATH) ? 3232 : 3000;
 const up = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
 if (up) { console.log(`a server is answering on :${port} for this database — stop it first (or --force).`); process.exit(2); }
}
const store = openStore(DB_PATH);
const db = store.readAll();
const norm = (d) => { for (const k of ['terrain', 'props', 'buildZones', 'goalZones', 'goalObjs', 'fixedParts', 'texts', 'pins']) d[k] = d[k] || []; d.groups = d.groups || {}; return d; };
const replay = (level, parts, goals) => {
 const sim = new Simulation(level, { parts }, goals ? { goalPositions: goals } : {});
 const N = Math.round(MAX_S * 30);
 let f = 0;
 while (f < N && !sim.won && !sim.goalLost) { sim._fixedStep(); f++; }
 const out = { won: sim.won, time: sim.won ? sim.winTime : null };
 sim.destroy();
 return out;
};

const levels = Object.values(db.levels)
 .filter((l) => (FROM == null && TO == null) || (l.official && l.num >= (FROM ?? -Infinity) && l.num <= (TO ?? Infinity)))
 .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || String(a.name).localeCompare(String(b.name)));
const dirty = { levels: new Set(), users: new Set(), sessions: new Set(), content: new Set() };
let checked = 0, dead = 0, kept = 0, unverifiable = 0, protectedN = 0;
const byUser = {};
console.log(`${levels.length} levels in ${DB_PATH}${DRY ? ' (dry run)' : ''}\n`);
for (const l of levels) {
 const log = l.solveLog || [];
 if (!log.length) continue;
 const level = norm(structuredClone(l.data));
 const gone = [];
 const notes = [];
 for (const s of log) {
 if (!s.won) continue; // an attempt never claimed a win
 const d = s.hasDesign ? store.getDesign(s.id) : null;
 if (!d || !Array.isArray(d.design)) { unverifiable++; notes.push(`${s.by || 'anon'} "${s.name || ''}" has no design to replay`); continue; }
 if ((l.race && l.race.solveId === s.id && !l.race.winner) || (l.challenges || []).some((c) => c.solveId === s.id && !c.closedAt)) {
 protectedN++; notes.push(`${s.by || 'anon'} "${s.name || ''}" backs an open challenge — left`); continue;
 }
 checked++;
 const r = replay(level, d.design, d.goals || null);
 if (r.won) { kept++; continue; }
 dead++;
 gone.push(s);
 byUser[s.by || 'anon'] = (byUser[s.by || 'anon'] || 0) + 1;
 }
 if (gone.length || notes.length) {
 console.log(`#${l.num ?? '-'} ${l.name}: ${gone.length ? gone.length + ' dead — ' + gone.map((s) => `${s.by || 'anon'} "${s.name || ''}"`).join(', ') : 'all still win'}${notes.length ? '\n ' + notes.join('\n ') : ''}`);
 }
 if (!DRY && gone.length) {
 const ids = new Set(gone.map((s) => s.id));
 l.solveLog = log.filter((s) => !ids.has(s.id));
 for (const s of gone) { if (s.hasDesign) store.delDesign(s.id); store.delCard('S' + s.id); }
 dirty.levels.add(l.id);
 }
}
if (!DRY && dirty.levels.size) console.log(`\nwrote ${store.writeDirty(db, dirty)} level rows`);
store.close();
console.log(`\n${checked} winning solves replayed: ${kept} still win, ${dead} ${DRY ? 'would be ' : ''}deleted` +
 (Object.keys(byUser).length ? ` (${Object.entries(byUser).map(([k, v]) => `${k} ${v}`).join(', ')})` : '') +
 `; ${unverifiable} without a design left, ${protectedN} backing a challenge left.`);
