// clean-db.mjs — one-shot reset of the live data store.
//
// Removes everything that isn't authored content we want to keep:
//   * every solve record on every level (official ones included)
//   * every level that isn't official and isn't explicitly kept (below)
//   * every comment and every level rating
//   * every user's points balance and points history   (--keep-points to skip)
//
// Keeps: the 32 official levels, user accounts, sessions.
//
// WHAT ELSE TO KEEP. The 32 officials are always kept; anything else is named
// on the command line, because "which community levels matter" is a judgement
// that changes every time this is run and must never be a default:
//
//   --keep-name=<regex>   keep levels whose NAME matches (case-insensitive),
//                         repeatable
//   --keep-id=<id>        keep one level by id, repeatable
//   --keep-points         leave every user's points balance and history alone
//   --dry-run             print exactly what WOULD go, change nothing
//
//   node scripts/clean-db.mjs --dry-run --keep-name=learn --keep-id=yxXteCC5Emc
//
// **Run it with --dry-run first.** The backup is real and it works, but reading
// a list of names is cheaper than restoring one.
//
// Writes a timestamped .bak next to the database first — this is destructive
// and the backup is the only way back.
//
// The server holds the whole DB in memory and rewrites it on any mutation, so
// it MUST be stopped (or restarted straight after) or it will simply save the
// old data back over this. Run: node scripts/clean-db.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const values = (name) => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
const dryRun = flag('dry-run');
const keepPoints = flag('keep-points');
const keepIds = new Set(values('keep-id'));
const keepNames = values('keep-name').map(p => new RegExp(p, 'i'));
const unknown = argv.filter(a => !/^--(dry-run|keep-points|keep-name=|keep-id=)/.test(a));
if (unknown.length) {
  console.error('Unknown argument(s):', unknown.join(' '));
  console.error('Usage: node scripts/clean-db.mjs [--dry-run] [--keep-points] [--keep-name=<regex>] [--keep-id=<id>]');
  process.exit(1);
}

// Always kept, whatever the flags say. Everything else has to be asked for.
const keeps = (lvl) => !!lvl.official
  || keepIds.has(lvl.id)
  || keepNames.some(re => re.test(lvl.name || ''));

const store = openStore(dbPath);
const db = store.readAll();

const all = Object.values(db.levels || {});
const doomed = all.filter(l => !keeps(l));
const survivors = all.filter(keeps);

const before = {
  levels: all.length,
  solves: all.reduce((n, l) => n + (l.solveLog || []).length, 0),
  comments: all.reduce((n, l) => n + (l.comments || []).length, 0),
  ratings: all.reduce((n, l) => n + Object.keys(l.ratings || {}).length, 0),
  points: Object.values(db.users || {}).reduce((n, u) => n + (u.points || 0), 0),
};

// Name every level either way round. A count is not reviewable; a list is.
const line = (l) => `   ${String(l.num ?? 0).padStart(6)}  ${(l.official ? 'campaign' : 'community').padEnd(9)}  ${l.name}`;
console.log(`KEEP (${survivors.length}):`);
for (const l of survivors.filter(l => !l.official)) console.log(line(l));
console.log(`   …plus ${survivors.filter(l => l.official).length} official campaign levels`);
console.log(`\nREMOVE (${doomed.length}):`);
for (const l of doomed) console.log(line(l));
console.log('');

if (dryRun) {
  console.log('--dry-run: nothing was changed.');
  console.log(`would clear ${before.solves} solves, ${before.comments} comments, ${before.ratings} ratings`
    + (keepPoints ? ', and leave points alone' : `, and ${before.points} points across ${Object.keys(db.users || {}).length} users`));
  store.close();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// SQLite's own copy, not fs.copyFileSync — with WAL on, the newest commits
// can still be in the -wal sidecar and a plain file copy would miss them.
const bak = store.backupTo(dbPath + '.pre-clean-' + stamp + '.bak');

for (const [id, lvl] of Object.entries(db.levels || {})) {
  if (!keeps(lvl)) { delete db.levels[id]; continue; }
  lvl.solveLog = [];
  lvl.comments = [];
  lvl.ratings = {};
  lvl.plays = 0;
}

if (!keepPoints) {
  for (const u of Object.values(db.users || {})) {
    u.points = 0;
    u.pointsLog = [];
  }
}

store.importAll(db);
store.close();

const after = {
  levels: Object.keys(db.levels).length,
  solves: Object.values(db.levels).reduce((n, l) => n + l.solveLog.length, 0),
  comments: Object.values(db.levels).reduce((n, l) => n + l.comments.length, 0),
};

console.log('backup   ', path.basename(bak));
console.log('removed  ', doomed.length, 'levels,', before.solves, 'solves,',
  before.comments, 'comments,', before.ratings, 'ratings'
  + (keepPoints ? ' (points left alone)' : ', ' + before.points + ' points'));
console.log('kept     ', after.levels, 'levels,', Object.keys(db.users || {}).length, 'users');
console.log('now      ', after.solves, 'solves,', after.comments, 'comments');
