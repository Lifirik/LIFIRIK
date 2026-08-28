// drop-users.mjs — remove named accounts and everything attributable to them.
//
// Used to clear test accounts out of the live store. Deletes the user, their
// sessions, and any levels/solves/comments/ratings they authored,
// so nothing is left pointing at an id that no longer exists.
//
// Takes a timestamped backup first. The server MUST be stopped: it holds the
// whole DB in memory and rewrites it on any mutation, so a running instance
// will simply save the old data back over this.
//
// Run: node scripts/drop-users.mjs <name> [<name>...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');

const names = process.argv.slice(2);
if (!names.length) {
  console.error('usage: node scripts/drop-users.mjs <name> [<name>...]');
  process.exit(1);
}

const store = openStore(dbPath);
const db = store.readAll();
const wanted = new Set(names.map(n => n.toLowerCase()));
const targets = Object.values(db.users || {}).filter(u => wanted.has((u.nameLower || u.name || '').toLowerCase()));

if (!targets.length) {
  console.log('no matching users — nothing to do');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
store.backupTo(dbPath + '.pre-dropusers-' + stamp + '.bak');

const ids = new Set(targets.map(u => u.id));
let levels = 0, solves = 0, comments = 0, ratings = 0, sessions = 0;

for (const [id, lvl] of Object.entries(db.levels || {})) {
  if (!lvl.official && ids.has(lvl.authorId)) { delete db.levels[id]; levels++; continue; }
  const s0 = (lvl.solveLog || []).length;
  lvl.solveLog = (lvl.solveLog || []).filter(s => !ids.has(s.byId));
  solves += s0 - lvl.solveLog.length;
  const c0 = (lvl.comments || []).length;
  lvl.comments = (lvl.comments || []).filter(c => !ids.has(c.byId));
  comments += c0 - lvl.comments.length;
  // ratings are keyed 'user:<id>' for signed-in raters — and difficulty votes
  // use the identical keying, so they have to be swept the same way
  for (const map of [lvl.ratings, lvl.difficulties]) {
    for (const k of Object.keys(map || {})) {
      if (ids.has(k.replace(/^user:/, ''))) { delete map[k]; ratings++; }
    }
  }
  // and ratings/votes cast BY these users on things other people own
  for (const s of lvl.solveLog) {
    for (const k of Object.keys(s.ratings || {})) if (ids.has(k)) delete s.ratings[k];
  }
  for (const c of lvl.comments) {
    for (const k of Object.keys(c.votes || {})) if (ids.has(k)) delete c.votes[k];
  }
}

for (const [tok, sess] of Object.entries(db.sessions || {})) {
  if (ids.has(sess.userId)) { delete db.sessions[tok]; sessions++; }
}
for (const u of targets) delete db.users[u.id];

store.importAll(db);
store.close();

console.log('dropped  ', targets.map(u => u.name).join(', '));
console.log('also removed', levels, 'levels,', solves, 'solves,', comments, 'comments,',
  ratings, 'rating/difficulty votes,', sessions, 'sessions');
console.log('remaining users:', Object.values(db.users).map(u => u.name).join(', ') || '(none)');
