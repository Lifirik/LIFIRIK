// storage.mjs — the datastore behind the in-memory `db` object.
//
// WHY THIS EXISTS. The JSON file worked beautifully at friends-and-family
// scale and hits a wall the moment it isn't: every mutation re-serialised and
// rewrote the ENTIRE datastore. One player nudging a rating from 4 to 5 wrote
// every level, every user and every solve back to disk. At 50 MB that's
// hundreds of milliseconds of blocking I/O per save, several times a second —
// it doesn't degrade, it falls over.
//
// WHAT CHANGED, AND WHAT DIDN'T. Rows live in SQLite; the shape of the data
// does not change at all. The server still holds the same `db` object in
// memory and every route still reads it exactly as before — this replaces the
// *writing*, not the model. A save now writes only the rows that actually
// changed, inside one transaction, so cost tracks the edit rather than the
// database.
//
// Each table is `(id, json)`. Storing whole records as JSON keeps every route
// working on the objects it already expects, which is what makes this a
// storage swap instead of a rewrite. When a query needs to be indexed — "levels
// by author", say — that column gets extracted then, and only then.
//
// THE REMAINING CEILING, stated plainly: everything is still loaded into memory
// at boot, so RAM bounds the corpus, not the disk. At a thousand players that
// is nowhere near binding. At a hundred thousand levels it will be, and the fix
// is to move list/detail reads onto real queries — which this shape allows
// without touching the write path again.
//
// No dependency: node:sqlite is built in.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 2;   // 2: replay designs live in their own table (see the v2 block)

// tableName -> the key used by the in-memory object
//
// `content` is the admin's text overrides (§13.1): a plain key -> string map,
// not records with ids like the other three. It rides the same machinery
// anyway, because the alternative was a special case in readAll, writeDirty and
// the migration for the sake of one table whose rows happen to be short.
export const TABLES = {
  levels: 'id',
  users: 'id',
  sessions: 'token',
  content: 'k',
  campaigns: 'id',
};

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);

  // WAL: readers never block the writer, and a crash rolls back to the last
  // committed transaction instead of leaving a torn file.
  sql.exec('PRAGMA journal_mode = WAL');
  // FULL, not NORMAL: an fsync per commit costs a millisecond or two at one
  // flush per 400 ms, and buys "the write is on the platter when we say it is".
  // Durability was the whole point of moving off the JSON file.
  sql.exec('PRAGMA synchronous = FULL');
  sql.exec('PRAGMA foreign_keys = ON');

  sql.exec(`
    CREATE TABLE IF NOT EXISTS levels   (id      TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users    (id      TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token   TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content  (k       TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns (id     TEXT PRIMARY KEY, json TEXT NOT NULL);
    /* Replay payloads, OUT of the level rows and OUT of TABLES on purpose:
       readAll must never load them (a design is up to 320 KB and a level can
       hold hundreds — they were most of the ~0.2 MB/level the server held at
       boot), and writeDirty must never rewrite them (a design is immutable
       from the moment it is saved, so it is written once, here, and read on
       demand). */
    CREATE TABLE IF NOT EXISTS designs  (solveId TEXT PRIMARY KEY, json TEXT NOT NULL);
    /* Share cards: the 1200x630 JPEG a level or a solve unfurls as when its
       link is pasted into Discord, WhatsApp or Slack. Out of TABLES for the
       same two reasons designs are — readAll must never pull ~100 KB of image
       per level into memory at boot, and a card is written once and then only
       read. Bytes, not base64: a BLOB is what this is, and base64 would cost a
       third more disk for nothing. */
    CREATE TABLE IF NOT EXISTS cards    (k TEXT PRIMARY KEY, bytes BLOB NOT NULL, at INTEGER NOT NULL);
    /* the retired bench table is deliberately NOT dropped here: an old copy of
       a database is allowed to keep its orphan table, and a DROP on open would
       destroy it the moment anyone inspected a backup. */
    CREATE TABLE IF NOT EXISTS meta     (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  sql.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));

  // ---- v2: move inline replay designs out of the level rows ----
  //
  // One-way and one-time, guarded by the meta row. Walks every level, lifts
  // each solve's {design, goals} into the designs table, leaves `hasDesign:
  // true` behind, and rewrites the level row — inside one transaction, so a
  // power cut mid-migration is a rollback, not a half-moved corpus.
  {
    const schema = Number(sql.prepare('SELECT v FROM meta WHERE k = ?').get('schema')?.v || 1);
    if (schema < 2) {
      const putDesign = sql.prepare('INSERT OR REPLACE INTO designs (solveId, json) VALUES (?, ?)');
      const putLevel = sql.prepare('UPDATE levels SET json = ? WHERE id = ?');
      let moved = 0;
      sql.exec('BEGIN IMMEDIATE');
      try {
        for (const row of sql.prepare('SELECT id, json FROM levels').all()) {
          const lvl = JSON.parse(row.json);
          let touched = false;
          for (const s of lvl.solveLog || []) {
            if (s.design === undefined) continue;
            putDesign.run(s.id, JSON.stringify({ design: s.design, goals: s.goals }));
            delete s.design;
            delete s.goals;
            s.hasDesign = true;
            touched = true;
            moved++;
          }
          if (touched) putLevel.run(JSON.stringify(lvl), row.id);
        }
        sql.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema', '2');
        sql.exec('COMMIT');
      } catch (e) {
        try { sql.exec('ROLLBACK'); } catch { /* commit never happened */ }
        throw e;
      }
      if (moved) console.log(`storage: v2 migration moved ${moved} replay designs out of the level rows`);
    }
  }

  const design = {
    get: sql.prepare('SELECT json FROM designs WHERE solveId = ?'),
    put: sql.prepare('INSERT OR REPLACE INTO designs (solveId, json) VALUES (?, ?)'),
    del: sql.prepare('DELETE FROM designs WHERE solveId = ?'),
  };
  const card = {
    get: sql.prepare('SELECT bytes FROM cards WHERE k = ?'),
    put: sql.prepare('INSERT OR REPLACE INTO cards (k, bytes, at) VALUES (?, ?, ?)'),
    del: sql.prepare('DELETE FROM cards WHERE k = ?'),
    has: sql.prepare('SELECT k FROM cards'),
  };

  const put = {}, del = {}, all = {};
  for (const [table, key] of Object.entries(TABLES)) {
    put[table] = sql.prepare(`INSERT INTO ${table} (${key}, json) VALUES (?, ?)
                              ON CONFLICT(${key}) DO UPDATE SET json = excluded.json`);
    del[table] = sql.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
    all[table] = sql.prepare(`SELECT ${key} AS k, json FROM ${table}`);
  }

  return {
    // Whole datastore into the shape server.js has always used.
    readAll() {
      const out = { levels: {}, users: {}, sessions: {}, content: {}, campaigns: {} };
      for (const table of Object.keys(TABLES)) {
        for (const row of all[table].all()) out[table][row.k] = JSON.parse(row.json);
      }
      return out;
    },

    // `dirty` is { levels:Set, users:Set, sessions:Set, all:bool }.
    // A marked id that is no longer in memory was deleted, so the same mark
    // covers insert, update and delete — the caller never has to say which.
    // Returns how many rows were touched, for logging and for the tests.
    writeDirty(db, dirty) {
      let rows = 0;
      sql.exec('BEGIN IMMEDIATE');
      try {
        if (dirty.all) {
          // Fallback path: any save that didn't say what it changed. Always
          // correct, just proportional to the whole store — which is why the
          // hot routes all pass a hint.
          for (const table of Object.keys(TABLES)) {
            const live = db[table] || {};
            const seen = new Set();
            for (const [k, v] of Object.entries(live)) { put[table].run(k, JSON.stringify(v)); seen.add(k); rows++; }
            for (const row of all[table].all()) if (!seen.has(row.k)) { del[table].run(row.k); rows++; }
          }
        } else {
          for (const table of Object.keys(TABLES)) {
            for (const k of dirty[table]) {
              const v = (db[table] || {})[k];
              if (v === undefined) del[table].run(k);
              else put[table].run(k, JSON.stringify(v));
              rows++;
            }
          }
        }
        sql.exec('COMMIT');
      } catch (e) {
        try { sql.exec('ROLLBACK'); } catch { /* the commit never happened */ }
        throw e;
      }
      return rows;
    },

    // Import a plain {levels,users,sessions} object — the JSON file's
    // shape. Used by the migration and by the tests.
    importAll(data) {
      const dirty = { all: true };
      return this.writeDirty(data, dirty);
    },

    // A consistent copy, taken by SQLite itself. Copying the .sqlite file by
    // hand is a trap: with WAL on, recent commits may live in the -wal
    // sidecar, so a plain file copy can be a database missing its newest
    // writes. VACUUM INTO always produces a complete, standalone file.
    backupTo(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.rmSync(file, { force: true });                    // VACUUM INTO refuses to overwrite
      sql.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      return file;
    },

    checkpoint() { try { sql.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ } },
    close() { this.checkpoint(); sql.close(); },

    // ---- replay designs (write-once, read-on-demand — see the table's own
    // comment). Not part of TABLES, so readAll/writeDirty never touch them;
    // a design is stored the moment its solve is accepted and deleted the
    // moment its solve (or its whole level) is.
    getDesign(solveId) {
      const row = design.get.get(solveId);
      return row ? JSON.parse(row.json) : null;
    },
    putDesign(solveId, obj) { design.put.run(solveId, JSON.stringify(obj)); },
    delDesign(solveId) { design.del.run(solveId); },

    // ---- share cards (see the table). `k` is 'L<levelId>' or 'S<solveId>'.
    getCard(k) {
      const row = card.get.get(k);
      // node:sqlite hands a BLOB back as a Uint8Array; res.end wants a Buffer
      return row ? Buffer.from(row.bytes) : null;
    },
    putCard(k, bytes) { card.put.run(k, bytes, Date.now()); },
    delCard(k) { card.del.run(k); },
    cardKeys() { return card.has.all().map((r) => r.k); },

    raw: sql,
  };
}
