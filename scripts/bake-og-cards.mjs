// bake-og-cards.mjs — redraw every stored share card from the live renderer.
//
// Cards are JPEGs baked in a browser (server.js §11.10): node has no canvas,
// and a second renderer would drift. This opens headless Chrome against the
// same `shareCardDataUrl` the Workshop cards use, then writes the bytes into
// the cards table. Safe to run while the server is up — cards live outside
// the in-memory db, and GET /og reads them from sqlite on each request.
//
// Run: node scripts/bake-og-cards.mjs
// Optional: --levels-only  skip solution cards
//           --solves-only  skip level cards

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PUBLIC = path.join(root, 'public');
const DB_PATH = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');
const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.BAKE_PORT || 9247);
const CDP_PORT = Number(process.env.BAKE_CDP || 9248);
const CARD_MAX = 400 * 1024;

const args = new Set(process.argv.slice(2));
const levelsOnly = args.has('--levels-only');
const solvesOnly = args.has('--solves-only');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const BAKED_HTML = `<!doctype html>
<meta charset="utf-8">
<title>bake</title>
<script type="module">
import { shareCardDataUrl } from '/js/render.js';
window.bake = (preview, opts) => shareCardDataUrl(preview, opts || {});
window.__ready = true;
</script>
`;

function jpegBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!m) return null;
  let buf;
  try { buf = Buffer.from(m[1], 'base64'); } catch { return null; }
  if (buf.length < 256 || buf.length > CARD_MAX) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return null;
  return buf;
}

function staticServer() {
  return http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '/bake') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(BAKED_HTML);
      return;
    }
    const rel = path.normalize(url.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitHttp(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok || r.status === 404) return;
    } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error('never answered: ' + url);
}

async function cdpConnect(port) {
  await waitHttp(`http://127.0.0.1:${port}/json/version`);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page') || list[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('no CDP page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

async function waitReady(send) {
  for (let i = 0; i < 80; i++) {
    const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
    if (r.result?.value) return;
    await sleep(50);
  }
  throw new Error('baker page never set window.__ready — render.js failed to load');
}

async function bakeOne(send, preview, opts) {
  // Args via callFunctionOn so a fat level never has to live inside an
  // expression string (CDP has blown up on that).
  const obj = await send('Runtime.evaluate', { expression: 'window.bake' });
  const objectId = obj.result?.objectId;
  if (!objectId) return null;
  const out = await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function (preview, opts) { return this(preview, opts); }',
    arguments: [{ value: preview }, { value: opts || {} }],
    returnByValue: true,
  });
  return out.result?.value || null;
}

const store = openStore(DB_PATH);
const db = store.readAll();
const jobs = [];
if (!solvesOnly) {
  for (const l of Object.values(db.levels)) {
    if (l.private) continue;
    if (l.race && !l.race.openedAt) continue;   // sealed: a card would leak the level
    if (!l.data) continue;
    jobs.push({ key: 'L' + l.id, name: l.name || l.id, data: l.data, opts: {} });
  }
}
if (!levelsOnly) {
  for (const l of Object.values(db.levels)) {
    if (l.private) continue;
    if (l.race && !l.race.openedAt) continue;
    for (const s of (l.solveLog || [])) {
      if (!s.hasDesign) continue;
      if (!(s.public || s.unlisted)) continue;
      const d = store.getDesign(s.id);
      if (!d?.design) continue;
      jobs.push({
        key: 'S' + s.id,
        name: (l.name || l.id) + ' / ' + (s.by || s.id),
        data: l.data,
        opts: { design: d.design, goals: d.goals },
      });
    }
  }
}

console.log(`baking ${jobs.length} card${jobs.length === 1 ? '' : 's'} (${jobs.filter((j) => j.key.startsWith('L')).length} levels, ${jobs.filter((j) => j.key.startsWith('S')).length} solves)`);

if (!fs.existsSync(CHROME)) {
  console.error('no Chrome at ' + CHROME + ' — set CHROME=');
  process.exit(2);
}

const server = staticServer();
await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lifirik-bake-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--mute-audio',
  '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  `http://127.0.0.1:${PORT}/bake`,
], { stdio: 'ignore' });

let done = 0, failed = 0;
try {
  const cdp = await cdpConnect(CDP_PORT);
  await cdp.send('Runtime.enable');
  await waitReady(cdp.send);
  for (const job of jobs) {
    try {
      const url = await bakeOne(cdp.send, job.data, job.opts);
      const bytes = jpegBytes(url);
      if (!bytes) { failed++; console.log('FAIL  ' + job.key + '  ' + job.name); continue; }
      store.putCard(job.key, bytes);
      done++;
      if (done % 10 === 0 || done + failed === jobs.length) {
        console.log(`  ${done + failed}/${jobs.length}  last ${bytes.length} B  ${job.name}`);
      }
    } catch (e) {
      failed++;
      console.log('FAIL  ' + job.key + '  ' + (e.message || e));
    }
  }
  cdp.close();
} finally {
  chrome.kill();
  server.close();
  store.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* tmp */ }
}

console.log(`drew ${done} card${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
if (failed) process.exit(1);
