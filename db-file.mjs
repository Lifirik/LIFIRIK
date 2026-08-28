// db-file.mjs — the one way anything in this project is allowed to write
// data/db.json.
//
// That single file is the entire datastore, so a torn write is not a corrupted
// record, it is every level, user and solve. `fs.writeFileSync` straight over
// the live file gives you exactly that whenever the process dies, the disk
// fills, or the plug comes out mid-write — and the server's boot-time refusal
// to start on a parse failure (§12) only makes the loss loud, it doesn't undo
// it.
//
// The fix is the standard one: write a temp file beside the target, flush it to
// the platter, then rename over the top. rename(2) is atomic within a
// filesystem — a reader sees the whole old file or the whole new one, never a
// half of each — and the fsync before it is what extends that promise from
// "survives a crash" to "survives a power cut", since otherwise the rename can
// land while the bytes are still in the page cache.
//
// Used by server.js (every debounced save) and by the offline scripts, which
// write the same file and inherit the same failure if they do it by hand.
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // beside the target on purpose: rename is only atomic within one filesystem,
  // so an OS temp dir would quietly turn this back into a copy
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, contents);   // loops internally — no short writes
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    replaceFile(tmp, filePath);
    fsyncDir(dir);   // durability of the rename itself, not just of its contents
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

// Windows can transiently refuse the replace when a virus scanner, a backup
// agent or an editor holds the target open — a lock that lasts milliseconds,
// not a real failure. Back off and retry rather than dropping the save. POSIX
// just replaces it.
function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!transient || attempt >= 4) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

// POSIX only: a rename isn't durable until the directory entry is flushed.
// Windows exposes no handle for this and doesn't need one, and a failure here
// is never worth failing an otherwise-good save over.
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch { /* best effort */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}
