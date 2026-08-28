// build.mjs — produce `dist/`, the thing you actually deploy.
//
// Two jobs, and the second one is the point:
//
//  1. Make it smaller. The client ships ~470 KB of ES modules written for
//     humans; bundled and minified it's a fraction of that, in one request
//     instead of nine.
//
//  2. Make the deploy contain no readable source. Minifying while the original
//     files still sit in `public/js/` protects nothing — View Source just reads
//     those instead. So `dist/` is built from scratch and holds ONLY built
//     output: no `public/js/`, no data, no scripts you don't
//     need at runtime. What isn't in dist can't be served.
//
// The server is bundled too, which incidentally solves a real problem: server.js
// imports `./public/js/fcimport.js` (one converter, two runtimes — §14), and that
// path doesn't exist in a dist without client sources. Bundling inlines it.
//
// `dist/` is self-contained and runs exactly like the source tree:
//     cd dist && npm ci --omit=dev && node server.js
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const sizeOf = (p) => fs.statSync(p).size;
const dirSize = (d) => fs.readdirSync(d, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(d, e.name)) : sizeOf(path.join(d, e.name))), 0);

try {
  fs.rmSync(dist, { recursive: true, force: true });
} catch (e) {
  if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
  // Windows won't unlink a directory that is some process's working directory
  console.error(`Can't clear dist/ — something is using it.`);
  console.error(`A built server still running from in there is the usual culprit; stop it and try again.`);
  process.exit(1);
}
fs.mkdirSync(path.join(dist, 'public'), { recursive: true });

// ---- client: one module graph -> one minified file ----
const clientSrc = path.join(root, 'public', 'js', 'main.js');
const clientOut = path.join(dist, 'public', 'app.js');
const client = await build({
  entryPoints: [clientSrc],
  bundle: true, minify: true, format: 'esm', target: ['es2022'],
  outfile: clientOut, legalComments: 'none',
  // The engine wasm is FETCHED at runtime (initEngine), so nothing to
  // externalise for it any more. `node:*` covers sim.js's Node-only branch
  // (the offscreen scripts read the wasm off disk); it is dead code in the
  // browser and must simply not be resolved at bundle time.
  external: ['node:*'],
  metafile: true,
});
const clientRaw = Object.keys(client.metafile.inputs)
  .reduce((n, f) => n + sizeOf(path.join(root, f)), 0);

// ---- server: same treatment, and it inlines the shared converter ----
const serverOut = path.join(dist, 'server.js');
await build({
  entryPoints: [path.join(root, 'server.js')],
  bundle: true, minify: true, format: 'esm', platform: 'node', target: ['node22'],
  outfile: serverOut, legalComments: 'none',
  packages: 'external',   // express and node builtins stay external
});

// ---- static assets ----
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const cssMin = (await build({
  stdin: { contents: css, loader: 'css', resolveDir: path.join(root, 'public') },
  minify: true, write: false,
})).outputFiles[0].text;
fs.writeFileSync(path.join(dist, 'public', 'style.css'), cssMin);

// index.html: same shell, pointed at the bundle
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .replace("import { boot } from '/js/main.js';", "import { boot } from '/app.js';");
if (html.includes('/js/main.js')) throw new Error('index.html entry point was not rewritten — check the script tag');
fs.writeFileSync(path.join(dist, 'public', 'index.html'), html);

// the pinned wasm + glue, byte for byte: this file IS the determinism contract
// (§5.8), so it is copied and never processed
const vendorFrom = path.join(root, 'public', 'vendor');
fs.cpSync(vendorFrom, path.join(dist, 'public', 'vendor'), { recursive: true });

// the dictionaries ride as-is too: they are fetched by URL at boot
// (/i18n/<code>.json), so bundling could never see them — and the denylist
// walk below skips directories, which is exactly how an asset FOLDER goes
// missing from a deploy the way a file no longer can
fs.cpSync(path.join(root, 'public', 'i18n'), path.join(dist, 'public', 'i18n'), { recursive: true });

// **Every other file in `public/` comes too — a DENYLIST, and that is the fix.**
//
// This block used to be an allowlist: index.html, style.css, vendor, and
// nothing else. Anything later added to `public/` was therefore absent from the
// deploy, silently, with no error at build time and none at runtime either —
// just a 404 for a file the page asks for.
//
// So the default is now "copy it". The two names skipped below are skipped
// because they were BUILT above, not because they are unwanted.
const built = new Set(['index.html', 'style.css']);
const assets = [];
for (const e of fs.readdirSync(path.join(root, 'public'), { withFileTypes: true })) {
  // js/ is bundled into app.js and must NOT be copied (that is this script's
  // second job — see the header); vendor/ is handled above.
  if (e.isDirectory() || built.has(e.name)) continue;
  fs.copyFileSync(path.join(root, 'public', e.name), path.join(dist, 'public', e.name));
  assets.push(e.name);
}

// ---- runtime files ----
for (const f of ['LICENSE']) fs.copyFileSync(path.join(root, f), path.join(dist, f));

// A package.json with no devDependencies and no build scripts — `npm ci
// --omit=dev` on the box installs express and nothing else.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, license: pkg.license,
  type: 'module', main: 'server.js',
  scripts: { start: 'node server.js', seed: 'node scripts/seed-official-levels.js' },
  dependencies: pkg.dependencies,
}, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(dist, 'package-lock.json'));

// seeding is the one script a fresh box needs; it pulls in levels.js, so bundle it
fs.mkdirSync(path.join(dist, 'scripts'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'scripts', 'seed-official-levels.js')],
  bundle: true, minify: true, format: 'esm', platform: 'node', target: ['node22'],
  outfile: path.join(dist, 'scripts', 'seed-official-levels.js'),
  packages: 'external', legalComments: 'none',
});

// ---- report, and prove the leaks are absent ----
console.log('client   ' + kb(clientRaw).padStart(9) + ' of source -> ' + kb(sizeOf(clientOut)) + '  (one file, was ' + Object.keys(client.metafile.inputs).length + ')');
console.log('css      ' + kb(css.length).padStart(9) + '           -> ' + kb(cssMin.length));
console.log('server   ' + kb(sizeOf(path.join(root, 'server.js'))).padStart(9) + '           -> ' + kb(sizeOf(serverOut)));
console.log('assets   ' + String(assets.length).padStart(9) + ' copied  (' + (assets.join(', ') || 'none') + ')');
console.log('dist     ' + kb(dirSize(dist)).padStart(9) + ' total (' + kb(sizeOf(path.join(dist, 'public', 'vendor', 'fcsim', 'fcsim.wasm'))) + ' of that is the engine)');

// **No asset reference may dangle.** The copy above fixes the QR; this is what
// stops the next one. Every root-absolute asset URL the BUILT output asks for
// has to be a file that is really in `dist/public` — checked against the
// bundle, the minified css and the rewritten html, which between them is
// everything the browser will act on. It fails the build, where the answer is
// one line, instead of the page, where it is a broken image nobody reports for
// a fortnight.
const refs = new Set();
const ASSET_URL = /["'(](\/[A-Za-z0-9._\-/]+\.(?:svg|png|jpe?g|gif|webp|ico|avif|woff2?|ttf|otf|mp3|ogg|wav|webmanifest))["')]/g;
for (const src of [fs.readFileSync(clientOut, 'utf8'), cssMin, html]) {
  for (const m of src.matchAll(ASSET_URL)) refs.add(m[1]);
}
let dangling = 0;
for (const r of [...refs].sort()) {
  if (fs.existsSync(path.join(dist, 'public', r))) continue;
  console.error(`MISSING: ${r} — the build references it, dist/public has no such file`);
  dangling++;
}
if (dangling) process.exit(1);

const banned = [
  ['public/js', 'client source'],
  ['data', 'the datastore'],
  ['node_modules', 'dependencies (installed on the box)'],
  ['.gitignore', 'repo config'],
];
let leaked = 0;
for (const [rel, what] of banned) {
  if (fs.existsSync(path.join(dist, rel))) { console.error(`LEAK: dist/${rel} — ${what}`); leaked++; }
}
if (leaked) process.exit(1);
console.log('\nno source, no data in dist/ — deploy this directory');
