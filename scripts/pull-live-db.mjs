// pull-live-db.mjs — bring the LIVE database back to the dev tree.
// Run: node scripts/pull-live-db.mjs [--from <path>] [--to <path>]
//
// Called by DEPLOY.bat, and standalone when you just want today's live data
// without shipping code. **Live gets code, dev gets data** — this is the second
// half, and it only ever runs in that direction.
//
// **It is a VACUUM INTO, not a file copy, and storage.mjs says why:** with WAL
// on, recent commits live in the `-wal` sidecar, so copying `db.sqlite` by hand
// can hand you a database missing its newest writes — silently, with every
// older row present and correct. `VACUUM INTO` asks SQLite for a complete
// standalone file and gets one. It also works on a database that is open, so
// this is safe whether or not the live server happens to be stopped.
//
// The dev database it replaces is backed up first. Dev data is expendable and
// the whole point of this script is to overwrite it — but a one-line rename
// costs nothing and this project's `data/` is full of `.pre-<reason>.bak` files
// for the same reason.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const from = path.resolve(arg('from', 'C:/Users/Richa/Desktop/LP/data/db.sqlite'));
const to = path.resolve(arg('to', path.join(root, 'data', 'db.sqlite')));

if (!fs.existsSync(from)) {
  console.error(`No live database at ${from}`);
  process.exit(1);
}
if (path.resolve(from) === path.resolve(to)) {
  console.error('Source and destination are the same file — refusing.');
  process.exit(1);
}

const liveSize = fs.statSync(from).size;
const walPath = from + '-wal';
const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
console.log(`live   ${from}`);
console.log(`       ${(liveSize / 1024).toFixed(0)} KB + ${(walSize / 1024).toFixed(0)} KB of write-ahead log`);

// ---- back the dev database out of the way ----
//
// **The backup is a VACUUM INTO as well, and the first version of this file was
// not.** It renamed `db.sqlite` to `.bak` and then deleted the `-wal` beside it
// — which is the same trap this script exists to avoid, committed against the
// backup instead of the copy. Measured after the first real deploy: the backup
// held 53 levels where the dev database had 55, and the two that were missing
// were the newest ones, sitting in a write-ahead log that had just been
// deleted. A backup you cannot restore from is worse than no backup, because
// you stop looking for the data.
fs.mkdirSync(path.dirname(to), { recursive: true });
if (fs.existsSync(to)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${to}.pre-pull-${stamp}.bak`;
  fs.rmSync(bak, { force: true });                     // VACUUM INTO refuses to overwrite
  const old = new DatabaseSync(to);
  try { old.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`); } finally { old.close(); }
  const n = (() => {
    const d = new DatabaseSync(bak);
    try { return d.prepare('SELECT COUNT(*) AS n FROM levels').get().n; } catch { return '?'; } finally { d.close(); }
  })();
  console.log(`backup ${path.basename(bak)}  (${n} levels, write-ahead log included)`);
  fs.rmSync(to, { force: true });
}
// Only now: a sidecar belongs to the database that has just been backed up and
// removed, and left in place SQLite would try to apply it to the new file.
for (const side of ['-wal', '-shm']) fs.rmSync(to + side, { force: true });

// ---- the copy itself ----
const db = new DatabaseSync(from);
try {
  db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

// ---- prove it arrived, rather than trusting the absence of an error ----
const check = new DatabaseSync(to);
const count = (t) => {
  try { return check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return '—'; }
};
const levels = count('levels'), users = count('users');
check.close();

console.log(`dev    ${to}`);
console.log(`       ${(fs.statSync(to).size / 1024).toFixed(0)} KB · ${levels} levels · ${users} users`);
if (levels === 0 || levels === '—') {
  console.error('That database has no levels in it — something is wrong, check the backup.');
  process.exit(1);
}
