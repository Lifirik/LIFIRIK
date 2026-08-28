// server.js — Express app + REST API + JSON-file persistence (§11.2, §12).
// One JSON file is the entire datastore, written only through db-file.mjs
// (temp + fsync + atomic rename). Auth and write routes are rate limited
// (ratelimit.mjs). Still missing before this faces the open internet: HTTPS
// (terminate it in front — see README) and password reset.

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, TABLES } from './storage.mjs';
import { rateLimit, consume, resetKey, clientIp, isLoopback, TRUST_PROXY } from './ratelimit.mjs';
import { hashPassword, newSalt, passwordMatches, generatePassword, reservedName } from './auth.mjs';
// The FC-format converter is a client module (the #/import screen imports it
// straight from /js/) and deliberately dependency-free, so the server shares
// the file rather than keeping a second copy of the mapping in sync.
import { convertFcLevel, levelData as fcLevelData, fcXmlToPaste } from './public/js/fcimport.js';
// How small a piece is allowed to be — the same module the editor and the
// importer clamp with, for the same reason the converter is shared: a level
// arriving as hand-written JSON has to clear the bar the editor can't go under.
import { MIN_AXIS, MIN_AREA, MIN_BALL_R, pieceBoxLegal,
 COORD_MAX, DENSITY_MIN, DENSITY_MAX, PROP_TEXTURES, badPath, badMachinePart } from './public/js/sizes.js';
import { badSurface, TEXTURES, surfaceOf } from './public/js/surfaces.js';
// The label schema and its validator (§10.6) — one module, shared with the
// editor and the renderer, for the same reason surfaces.js is shared: three
// places must agree on exactly one answer to "is this legal".
import { badTextPiece } from './public/js/textmodel.js';
import { badPlanet, badPieceGravity } from './public/js/gravity.js';
import { SETS, normalizeCampaigns, publicCampaign, defaultStarterSections } from './public/js/levels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
// Overridable so tests (and a second instance) can run against a scratch
// database instead of the live one. Unset in normal use.
const DB_PATH = process.env.LIFIRIK_DB || path.join(DATA_DIR, 'db.sqlite');
const LEGACY_JSON = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 3000;
// Invite-only while the game is being built: accounts come from
// scripts/invite.mjs, and the public sign-up route refuses. This is a second
// lock, not the first one — a closed register route still leaves anonymous
// play open to anyone who can reach the site, so the gate itself belongs in
// front (see README, Deploying it).
const REGISTRATION_OPEN = process.env.REGISTRATION !== 'closed';

// Official challenges past this slot need a signed-in account to PLAY (the
// list still shows every card — a locked level you can see is a reason to
// join). Enforced where the level DATA is fetched, not in the client: the
// client's locks are presentation. 0-based slots, so 16 = challenges 17–32.
const FREE_OFFICIAL_SLOTS = parseInt(process.env.FREE_SLOTS || '16', 10);

// ---------- the tuning dials (§13.1) ----------
//
// Everything here is a number you can move without breaking anything that has
// already happened. **That is the whole selection rule, and it is why the list
// is shorter than it could be:** a recorded solve is a REPLAY against the
// physics (§5.8), so every constant the simulation reads — the step, gravity,
// motor speed and torque, rod weights, contact stiffness, rope link length — is
// deliberately NOT here. Those live in the client where the determinism
// contract can see them, and moving one silently invalidates every time on the
// board. `MESSAGE_MAX` is left out for the same kind of reason: util.js carries
// the matching copy and a gate reads both, so an env var would let the two
// disagree at runtime with the suite still green.
//
// A bad value is clamped rather than obeyed, and says so on the way past. An
// unreadable environment should not be able to take the site down, and a
// typo'd `LIMIT_LEVELS=abc` that silently became 0 would look exactly like a
// bug in the quota code.
//
// **Changes need a restart** — `server.js` is read once at process start
// (DEPLOY.bat and GOLIVE.bat both do it). The admin Tuning panel shows what is
// actually live, which is the only number worth trusting.
const envNotes = [];
function envInt(name, dflt, min, max) {
 const raw = process.env[name];
 if (raw == null || raw === '') return dflt;
 const n = Math.round(Number(raw));
 if (!Number.isFinite(n)) { envNotes.push(`${name}="${raw}" is not a number - using ${dflt}`); return dflt; }
 const v = Math.min(Math.max(n, min), max);
 if (v !== n) envNotes.push(`${name}=${n} is outside ${min}..${max} - clamped to ${v}`);
 return v;
}

// **One row per dial, and the row is the whole truth about it**: the env var,
// the shipped default, the hard clamp, a sentence saying what it does, and the
// span that is actually sensible to move it within. The clamp and the sensible
// range are DIFFERENT numbers and both are worth showing — `PASSWORD_MIN` is
// clamped 1..128 because those are the values that cannot break the server, and
// is sensibly 4..12 because outside that you are either not asking for a
// password or asking for a passphrase.
//
// Written as data rather than as a wall of `envInt` calls so the admin panel can
// SHOW all of it. The panel used to print a name and a number, which tells you
// what a dial is set to and nothing whatever about whether you should touch it.
const DIALS = [
 { group: 'Accounts', key: 'passwordMin', env: 'PASSWORD_MIN', dflt: 4, min: 1, max: 128, sane: '4-12',
 what: 'Shortest password accepted, on sign-up and on change.' },
 { group: 'Accounts', key: 'welcomePoints', env: 'WELCOME_POINTS', dflt: 100, min: 0, max: 100000, sane: '0-500',
 what: 'Points a brand-new account opens with. Points are a token and buy nothing (§11.5).' },
 { group: 'Accounts', key: 'sessionDays', env: 'SESSION_DAYS', dflt: 60, min: 1, max: 3650, sane: '7-180',
 what: 'How long a sign-in lasts before the browser has to sign in again.' },
 { group: 'Accounts', key: 'testEconomy', env: 'TEST_ECONOMY', dflt: 0, min: 0, max: 1, sane: '0 on the open internet',
 what: 'The fake points shop. 1 = the test-mode Buy/Subscribe buttons grant points with no real charge; 0 = both routes refuse. Default is off — with it on, any signed-in player can mint points and premium.' },

 // 1000 / 10000 (2026-08-17, on request): these caps exist to stop
 // trolling, fraud and flooding — not to ration honest use — so they sit
 // far above anything a person playing the game reaches by hand.
 { group: 'What one account may store', key: 'limitLevels', env: 'LIMIT_LEVELS', dflt: 1000, min: 0, max: 100000, sane: '100-5000',
 what: 'Levels a NEW account may save on the server. Existing accounts keep theirs; edit those per user in Users.' },
 { group: 'What one account may store', key: 'limitSolves', env: 'LIMIT_SOLVES', dflt: 10000, min: 0, max: 1000000, sane: '2000-50000',
 what: 'Saved runs a new account may keep. Local saves are unlimited and cost the server nothing.' },
 { group: 'What one account may store', key: 'limitComments', env: 'LIMIT_COMMENTS', dflt: 1000, min: 0, max: 1000000, sane: '200-5000',
 what: 'Comments a new account may leave.' },

 { group: 'Challenges', key: 'prizeMin', env: 'PRIZE_MIN', dflt: 1, min: 0, max: 100000, sane: '0-5',
 what: 'Smallest prize you may stake on a challenge. 0 lets people post one for nothing.' },
 { group: 'Challenges', key: 'prizeMax', env: 'PRIZE_MAX', dflt: 500, min: 1, max: 1000000, sane: '50-2000',
 what: 'Largest prize. Staked up front, so nobody can promise points they no longer have.' },
 { group: 'Challenges', key: 'raceMaxDays', env: 'RACE_MAX_DAYS', dflt: 90, min: 1, max: 3650, sane: '7-180',
 what: 'How far ahead a sealed timed debut may be scheduled.' },
 { group: 'Challenges', key: 'beatmeMaxDays', env: 'BEATME_MAX_DAYS', dflt: 30, min: 1, max: 3650, sane: '7-90',
 what: 'Longest a Match/Beat Me bar may run. The composer defaults to exactly this.' },
 { group: 'Challenges', key: 'beatmeMinMinutes', env: 'BEATME_MIN_MINUTES', dflt: 15, min: 1, max: 100000, sane: '5-60',
 what: 'Shortest a bar may run — long enough that somebody could actually see it.' },

 { group: 'Size limits', key: 'levelMaxMB', env: 'LEVEL_MAX_MB', dflt: 2, min: 1, max: 64, sane: '2-8',
 what: 'Biggest level the server will store. The per-piece caps normally bind first.' },
 { group: 'Size limits', key: 'fcTextMax', env: 'FC_TEXT_MAX', dflt: 500000, min: 1000, max: 20000000, sane: '100k-2M',
 what: 'Longest Fantastic Contraption level text the importer will read.' },
 { group: 'Size limits', key: 'paintMaxPts', env: 'PAINT_MAX_PTS', dflt: 24, min: 3, max: 512, sane: '12-64',
 what: 'Points in one piece of painted terrain. Higher is smoother and costs the solver more.' },

 { group: 'Abuse budgets', key: 'loginFailMax', env: 'LOGIN_FAIL_MAX', dflt: 30, min: 1, max: 100000, sane: '10-50',
 what: 'Wrong passwords allowed against one name per window before it is locked out for a while.' },
 { group: 'Abuse budgets', key: 'loginFailWindowMin', env: 'LOGIN_FAIL_WINDOW_MIN', dflt: 15, min: 1, max: 1440, sane: '5-60',
 what: 'How long that window is, in minutes.' },
];

const TUNING = {};
for (const d of DIALS) TUNING[d.key] = envInt(d.env, d.dflt, d.min, d.max);
if (TUNING.prizeMax < TUNING.prizeMin) {
 envNotes.push(`PRIZE_MAX (${TUNING.prizeMax}) is below PRIZE_MIN (${TUNING.prizeMin}) - raising it to match`);
 TUNING.prizeMax = TUNING.prizeMin;
}
// Said out loud at boot as well as shown in the panel: a clamped dial that only
// appears on an admin screen nobody opened is a setting silently not taking.
for (const note of envNotes) console.warn('config: ' + note);

// When this process started, so the Tuning panel can say how old the running
// configuration is - the dials are read once, at start (see DEPLOY.bat).
const STARTED_AT = Date.now();

// ---------- db ----------
//
// Still one in-memory object, still read directly by every route — SQLite
// replaced the *writing* only (storage.mjs explains why). Saves now write the
// rows that changed instead of re-serialising the entire datastore.

// `content` is the admin's text overrides (§13.1) — a key -> string map, empty
// on a fresh install, where the shipped defaults in public/js/content.js are
// the whole of the site's words.
let db = { levels: {}, users: {}, sessions: {}, content: {}, campaigns: {} };
let store = null;

function loadDb() {
 const fresh = !fs.existsSync(DB_PATH);
 store = openStore(DB_PATH);

 // One-time upgrade from the JSON era. The .json is only READ — it stays
 // exactly where it is as a rollback, and `npm run db:export` writes a fresh
 // one back out any time.
 if (fresh && fs.existsSync(LEGACY_JSON)) {
 let legacy;
 try {
 legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
 } catch (e) {
 // Parse-fail here = wipe risk (§16). Refuse to run rather than start
 // empty over a file that probably still has everything in it.
 console.error('FATAL: data/db.json exists but failed to parse:', e.message);
 console.error('Fix or move the file, then restart. Refusing to start fresh over it.');
 process.exit(1);
 }
 for (const t of ['levels', 'users', 'sessions', 'content', 'campaigns']) legacy[t] ||= {};
 const rows = store.importAll(legacy);
 console.log(`migrated data/db.json -> ${path.basename(DB_PATH)} (${rows} rows). The .json is untouched; keep it as your rollback.`);
 }

 db = store.readAll();
 console.log(`db loaded: ${Object.keys(db.levels).length} levels, ${Object.keys(db.users).length} users`);
 backfills();
 rebuildOwnIndex(); // from scratch every boot — index drift never survives a restart
}

// ---------- the anonymous list cache ----------
//
// GET /api/levels is the request every player makes on arriving, it is
// identical for every signed-out viewer asking with the same filters, and it
// was the measured concurrency ceiling: 11-14 ms to build and ~2.4 MB to
// serialise, so ~70-90 requests/second TOTAL, and the p95 of a click at 500
// simultaneous arrivals was 631 ms on today's corpus (5+ seconds on a
// 500-level one). Caching the SERIALISED body — not the array, the string,
// because JSON.stringify of 2.4 MB per hit would keep most of the cost —
// turns the stampede case into a Map lookup.
//
// Two staleness bounds, belt and braces: `listGen` bumps on every level-row
// dirty mark (publish, rating, comment, play count, a challenge opening — all
// of them schedule a level save), and the TTL catches anything that changes a
// summary WITHOUT touching a level row (crown tiers move when user points
// do). So a new level is visible the same instant it saves, and a crown is
// never more than a second stale. Signed-in viewers bypass entirely — their
// list is filtered by who they are (own unlisted levels, admin sight).
let listGen = 0;
const listCache = new Map(); // key -> { gen, at, body }
const LIST_CACHE_TTL = 1000;
const LIST_CACHE_KEYS_MAX = 64; // distinct filter combinations worth keeping

// What changed since the last flush. A save with no hint marks everything,
// which is slower but never wrong — so a missed or mistaken hint costs
// performance, not correctness.
// **There is one set per table in `storage.mjs`'s TABLES, and that is a
// requirement rather than a tidiness.** `writeDirty` walks those table names and
// iterates `dirty[table]`, so a table with no set here throws `undefined is not
// iterable` on the first hinted save — every save in the game, since only the
// fallback path passes `all`. Adding a table means adding its set.
const dirty = { all: false };
for (const t of Object.keys(TABLES)) dirty[t] = new Set();
function markDirty(hint) {
 if (!hint) { dirty.all = true; listGen++; return; }
 if (hint.level) { dirty.levels.add(hint.level); listGen++; }
 if (hint.user) dirty.users.add(hint.user);
 if (hint.session) dirty.sessions.add(hint.session);
 if (hint.sessions) for (const t of hint.sessions) dirty.sessions.add(t);
 if (hint.content) dirty.content.add(hint.content);
 if (hint.campaign) dirty.campaigns.add(hint.campaign);
 if (hint.campaigns) for (const id of hint.campaigns) dirty.campaigns.add(id);
 if (hint.all) dirty.all = true;
}
function clearDirty() {
 for (const t of Object.keys(TABLES)) dirty[t].clear();
 dirty.all = false;
}

let saveTimer = null;
function scheduleSave(hint) {
 markDirty(hint);
 if (saveTimer) return;
 saveTimer = setTimeout(() => {
 saveTimer = null;
 writeDirtyNow();
 }, 400);
}

// **The three table names here are derived, not typed.** Writing them out a
// second time is what broke the `content` table on the day it was added: the
// set existed in `dirty`, the route marked it, and this function quietly
// dropped it out of the snapshot — so `writeDirty` iterated `undefined`, threw,
// and every content edit was rolled back into "db save failed" on a console
// nobody was watching. It read back perfectly all session and was gone after a
// restart. Reading TABLES means adding a table is one edit, not three.
const TABLE_NAMES = Object.keys(TABLES);

function writeDirtyNow() {
 if (!store) return;
 const snapshot = { all: dirty.all };
 for (const t of TABLE_NAMES) snapshot[t] = new Set(dirty[t]);
 if (!snapshot.all && TABLE_NAMES.every(t => !snapshot[t].size)) return;
 clearDirty();
 try {
 store.writeDirty(db, snapshot);
 } catch (e) {
 // Put the marks back so the next flush retries them rather than dropping
 // the writes on the floor.
 console.error('db save failed:', e.message);
 dirty.all = dirty.all || snapshot.all;
 for (const t of TABLE_NAMES) for (const k of snapshot[t]) dirty[t].add(k);
 }
}

// A debounced save that never fires is a save that never happened — up to
// 400 ms of accepted writes live only in memory. Flush them on the way out, so
// "signed up, then the box restarted" isn't a lost account.
function flushDb() {
 if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
 writeDirtyNow();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
 // taking the handler means taking responsibility for exiting
 process.on(sig, () => { flushDb(); store?.close(); process.exit(0); });
}
process.on('exit', flushDb); // sync-only context; the whole write path is sync

// Default per-user server quotas. Server space is the scarce resource, so
// only things that OCCUPY it are capped — a Local save costs the server
// nothing and is deliberately unlimited (§11.6). Per-user overridable by an
// admin, which is why they live on the user record rather than as constants.
// The env defaults only decide what a NEW account opens with. An account
// already in the database keeps whatever it was given, which is what makes
// raising the default safe: nobody's stored limit moves under them, and an
// admin can still lift one account on its own in Admin > Users.
const DEFAULT_LIMITS = { levels: TUNING.limitLevels, solves: TUNING.limitSolves, comments: TUNING.limitComments };

// One-time startup backfills for schema-widening (§12): records predating
// id/won/public get won:true, public:true.
function backfills() {
 let touched = false;
 // One-time rehash of the session table (see sessionKey): rows written before
 // tokens were hashed are keyed by the RAW 32-char token; hashed keys are 43
 // chars of base64url. Re-keying in place keeps every existing sign-in alive
 // — the browser goes on sending the raw token, and lookups hash it first.
 {
 const rekeyed = [];
 for (const [k, sess] of Object.entries(db.sessions)) {
 if (k.length === 43) continue;
 delete db.sessions[k];
 db.sessions[sessionKey(k)] = sess;
 rekeyed.push(k, sessionKey(k));
 }
 if (rekeyed.length) {
 scheduleSave({ sessions: rekeyed });
 console.log(`sessions: rehashed ${rekeyed.length / 2} pre-hash rows (nobody signed out)`);
 }
 }
 // The campaign hub subtitle was edited in Admin > Text; the default in
 // content.js is now the live wording. Drop the stale override so the page
 // does not keep serving the old sentence until someone hits Reset.
 {
 const stale = db.content?.['campaign.sub'];
 if (typeof stale === 'string' && /working on the ordering/i.test(stale)) {
 delete db.content['campaign.sub'];
 scheduleSave({ content: 'campaign.sub' });
 }
 }
 // The Sticks campaign set was retired. Drop leftover admin overrides so a
 // deleted key does not sit in the table forever.
 if (db.content) {
 for (const k of ['campaign.set.sticks', 'campaign.set.sticks.name']) {
 if (k in db.content) {
 delete db.content[k];
 scheduleSave({ content: k });
 }
 }
 }
 // Campaigns are admin-defined (title, byline, sections with ranges). An
 // empty table is a fresh install or a database from before this existed —
 // seed the shipped Starters with its four parts. Rows that already exist
 // but have no sections get one covering their range, or the four Starters
 // parts if they are still 1–32.
 {
 db.campaigns ||= {};
 if (!Object.keys(db.campaigns).length) {
 for (const src of SETS) {
 const row = {
 id: src.id,
 title: String(src.title || src.name).slice(0, 80),
 byline: String(src.byline || src.blurb || '').slice(0, 400),
 from: src.from,
 to: src.to,
 sections: Array.isArray(src.sections) && src.sections.length
 ? src.sections.map((s) => ({ title: s.title, byline: s.byline || '', from: s.from, to: s.to }))
 : defaultStarterSections(db.content),
 };
 db.campaigns[row.id] = row;
 scheduleSave({ campaign: row.id });
 }
 }
 for (const c of Object.values(db.campaigns)) {
 if (Array.isArray(c.sections) && c.sections.length) continue;
 if (c.id === 'starters' && c.from === 1 && c.to === 32) {
 c.sections = defaultStarterSections(db.content);
 } else if (Number.isInteger(c.from) && Number.isInteger(c.to)) {
 c.sections = [{ title: c.title || c.name || 'Section', byline: '', from: c.from, to: c.to }];
 } else continue;
 c.from = Math.min(...c.sections.map((s) => s.from));
 c.to = Math.max(...c.sections.map((s) => s.to));
 scheduleSave({ campaign: c.id });
 }
 for (const k of ['campaign.set.starters', 'campaign.set.starters.name',
 'campaign.page.foundations', 'campaign.page.masterworks',
 'campaign.page.newground', 'campaign.page.farcountry']) {
 if (db.content && k in db.content) {
 delete db.content[k];
 scheduleSave({ content: k });
 }
 }
 }
 // Level numbers for anything predating them: officials from their slot,
 // community levels in creation order so the sequence matches their history.
 const unnumbered = Object.values(db.levels).filter(l => !num(l.num));
 if (unnumbered.length) {
 for (const l of unnumbered.filter(l => l.official && num(l.slot))) { l.num = l.slot + 1; touched = true; }
 let next = PLAYER_LEVEL_BASE;
 for (const l of Object.values(db.levels)) if (num(l.num) && l.num >= next) next = l.num + 1;
 for (const l of unnumbered.filter(l => !num(l.num)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
 l.num = next++; touched = true;
 }
 }
 // Solve numbers, oldest first, then seed the in-memory counter from the max.
 const allSolves = Object.values(db.levels).flatMap(l => l.solveLog || []);
 for (const s of allSolves) if (num(s.num) && s.num > solveNumCounter) solveNumCounter = s.num;
 for (const s of allSolves.filter(s => !num(s.num)).sort((a, b) => (a.at || 0) - (b.at || 0))) {
 s.num = ++solveNumCounter; touched = true;
 }

 for (const lvl of Object.values(db.levels)) {
 lvl.solveLog ||= [];
 lvl.comments ||= [];
 lvl.ratings ||= {};
 // {voterKey: 1..10}, the same shape as ratings. Sets `touched` like every
 // other backfill here — `||=` alone leaves the map in memory only, so it
 // would be re-added on every boot and never actually written.
 if (lvl.difficulties == null) { lvl.difficulties = {}; touched = true; }
 for (const s of lvl.solveLog) {
 if (s.id == null) { s.id = uid(); touched = true; }
 if (s.won == null) { s.won = true; touched = true; }
 if (s.public == null) { s.public = true; touched = true; }
 if (s.ratings == null) { s.ratings = {}; touched = true; }
 }
 for (const c of lvl.comments) {
 if (c.votes == null) { c.votes = {}; touched = true; }
 }
 }
 for (const u of Object.values(db.users)) {
 if (u.points == null) { u.points = 0; touched = true; }
 u.pointsLog ||= [];
 if (u.limits == null) { u.limits = { ...DEFAULT_LIMITS }; touched = true; }
 else for (const k of Object.keys(DEFAULT_LIMITS)) {
 if (!num(u.limits[k])) { u.limits[k] = DEFAULT_LIMITS[k]; touched = true; }
 }
 if (u.status == null) { u.status = 'active'; touched = true; }
 }
 // Bake surfaces onto any stored level that predates publish-time freezing
 // (§5.8, bakeSurfaces): each piece gets the numbers it PLAYS WITH TODAY, so
 // the freeze changes nothing about how any existing level feels — it only
 // stops future TEXTURE_SURFACE retunes from reaching back into them. A
 // piece is unbaked if any of the four dials is missing.
 {
 const unbaked = (t) => !t.surface || ['friction', 'restitution', 'rollingResistance', 'tangentSpeed']
 .some(k => typeof t.surface[k] !== 'number');
 let baked = 0;
 for (const lvl of Object.values(db.levels)) {
 const lists = [lvl.data?.terrain || [], lvl.data?.backLevel?.terrain || []];
 if (lists.some(list => list.some(unbaked))) {
 bakeSurfaces(lvl.data);
 baked++; touched = true;
 }
 }
 if (baked) console.log(`surfaces: baked ${baked} pre-freeze levels at today's numbers`);
 }
 if (touched) scheduleSave(); // no hint: a backfill can touch every row, once, at boot
}

// ---------- quotas & account status ----------

function limitOf(user, key) {
 const v = user?.limits?.[key];
 return num(v) ? v : DEFAULT_LIMITS[key];
}

// What a user currently occupies on the server. Counted by walking the levels
// rather than kept as a counter on the user: a counter drifts the moment
// anything is deleted by an admin or a moderator, and at this scale the walk
// is free.
// ---------- who-owns-what index ----------
//
// userId -> { solves: [{lvl, s}], levels: n, comments: n }. This existed as a
// full walk of every level × every solve × every comment — and it ran on every
// authed response (usageOf sits inside publicUser), plus twice more per
// profile view (the solve list and solvedDifficulty). Measured at 8.4 ms per
// call on a 5 000-level corpus; with a 1 000-solve account that walk was the
// profile page. The index makes all three consumers O(what you own).
//
// Drift is the failure mode of a maintained index, so two rules hold here:
// * it is REBUILT from scratch on every boot (rebuildOwnIndex in loadDb) —
// a missed hook costs staleness until the next restart, never forever;
// * entries are REFS to the live records ({lvl, s}), not copies — a field
// mutation (closeChallenge publishing a solve, a rename) needs no hook at
// all, only genuine adds and removes do, and those are the five routes
// that create or destroy: level POST/DELETE, solve POST/DELETE, comment
// POST (with its 300-cap trim) and comment DELETE.
let ownIndex = new Map();
function ownOf(userId) {
 let o = ownIndex.get(userId);
 if (!o) ownIndex.set(userId, o = { solves: [], levels: 0, comments: 0 });
 return o;
}
function rebuildOwnIndex() {
 ownIndex = new Map();
 for (const lvl of Object.values(db.levels)) {
 if (!lvl.official && lvl.authorId) ownOf(lvl.authorId).levels++;
 for (const s of lvl.solveLog) if (s.byId) ownOf(s.byId).solves.push({ lvl, s });
 for (const c of lvl.comments) if (c.byId) ownOf(c.byId).comments++;
 }
}
function unindexSolve(s) {
 if (!s.byId) return;
 const o = ownIndex.get(s.byId);
 if (!o) return;
 const i = o.solves.findIndex(e => e.s === s);
 if (i >= 0) o.solves.splice(i, 1);
}
function unindexLevel(lvl) {
 if (!lvl.official && lvl.authorId) {
 const o = ownIndex.get(lvl.authorId);
 if (o && o.levels > 0) o.levels--;
 }
 for (const s of lvl.solveLog || []) unindexSolve(s);
 for (const c of lvl.comments || []) if (c.byId) {
 const o = ownIndex.get(c.byId);
 if (o && o.comments > 0) o.comments--;
 }
}

function usageOf(userId) {
 const o = ownIndex.get(userId);
 return { levels: o?.levels || 0, solves: o?.solves.length || 0, comments: o?.comments || 0 };
}

// 'hold' is a read-only freeze — the account still works, it just can't add
// anything. 'banned' is the same plus no sign-in. Both are reversible, which
// is why neither deletes the user's existing content.
function blockedReason(user) {
 if (!user) return null;
 if (user.status === 'banned') return 'This account is banned.';
 if (user.status === 'hold') return 'This account is on hold — you can browse and play, but not save to the server.';
 return null;
}

function requireWritable(req, res) {
 const user = userFromReq(req);
 if (!user) { err(res, 401, 'Sign in first.'); return null; }
 const why = blockedReason(user);
 if (why) { err(res, 403, why); return null; }
 return user;
}

function uid() {
 return crypto.randomBytes(8).toString('base64url');
}

// ---------- level and solve numbers (§11.2) ----------
//
// Short, stable, human-quotable integers, separate from the base64url ids the
// URLs use. They exist so an exported file can be named for what it IS —
// "LEVEL - 000007 - The Climb.json" sorts, reads and gets talked about in a way
// that "LEVEL - The Climb.json" doesn't.
//
// 1 .. 32 the campaign, always slot + 1, so a re-seed reproduces the
// same numbers rather than shuffling them
// 33 .. 9999 reserved: room to add standard levels without renumbering
// anything a player already has on disk
// 10000+ community levels, in publication order
//
// Solves have their own sequence from 1, across the whole site.
const PLAYER_LEVEL_BASE = 10000;
const OFFICIAL_LEVEL_MAX = 9999;

function nextLevelNum() {
 let max = PLAYER_LEVEL_BASE - 1;
 for (const l of Object.values(db.levels)) {
 if (num(l.num) && l.num > max) max = l.num;
 }
 return max + 1;
}

// Solves outnumber levels by orders of magnitude, so this is counted once at
// boot and incremented in memory rather than re-walked on every save. A restart
// recomputes it from the data, so it can't drift out of step with reality.
let solveNumCounter = 0;
function nextSolveNum() { return ++solveNumCounter; }

// ---------- badges (same pure function as the client, §11.4) ----------

// WET is "nothing but water" — no wood, no wheels, and no `water > 0` term, so
// a solve that uses no pieces at all takes it (along with rods and powerless:
// the empty machine is the limit of every sparseness badge). See util.js's copy
// for the full reasoning and for why this is what makes the ladder nest.
const isWet = (s) => (s.wood | 0) === 0 && (s.wheels | 0) === 0;

const BADGE_DEFS = [
 { id: 'solved', test: s => !!s.won },
 { id: 'wet', test: isWet },
 { id: 'rods', test: s => (s.wheels | 0) === 0 },
 { id: 'powerless', test: s => (s.poweredWheels | 0) === 0 },
 // No POWERED badge (2026-08-04): "at least one powered wheel" marked the
 // ordinary case, while every other badge marks a constraint somebody chose
 // to work under. Mirrors util.js's computeBadges, which is what
 // verify-challenges asserts the two agree on.
 { id: 'untampered', test: s => !!s.untampered },
 { id: 'nailedIt', test: s => !!s.won && !!s.nailedIt },
 { id: 'boomerang', test: s => !!s.won && !!s.boomerang },
 // SWEEP — every piece the player built ended in the void; a no-piece solve
 // takes it for free, the same way the empty machine takes WET. Mirrors
 // util.js's computeBadges exactly; verify-challenges.mjs asserts the two
 // agree on a published level's badge union so they can't drift.
 { id: 'sweep', test: s => !!s.won && !!s.sweep },
 // NRW — no pin carries more than PIN_WEIGHT_SAFE of stick weight, summed per
 // PIN so two heavy sticks bolted together do not slip through separately.
 // **200 since 2026-08-12**, on request, and it is two sticks at the new ×100
 // ceiling rather than a round number. `maxPinWeight` is computed by
 // designStats (util.js); a solve recorded before the stat existed carries
 // null and does NOT get the badge, because "nobody measured" is not "nothing
 // heavy". Restated here rather than imported for the same reason the rest of
 // this list is — util.js carries DOM helpers and can't be loaded here — and
 // verify-challenges asserts the two copies agree.
 { id: 'nrw', test: s => s.maxPinWeight != null && s.maxPinWeight <= 200 },
];

function computeBadges(stats) {
 // **A machine built outside the build area earns NOTHING** (§Free World,
 // 2026-08-09) — not even `solved`. Mirrors util.js's computeBadges, which
 // returns early for exactly the same reason: the build area is the constraint
 // the puzzle IS, and a delivery made from anywhere at all has not answered
 // the question the level asked.
 //
 // This copy is why the badges came back. They are DERIVED and never stored
 // (§11.4), so every listing recomputes them from the solve record — and a
 // record that had dropped `escaped` on the way in recomputed as a legal one.
 if (stats.escaped) return [];
 return BADGE_DEFS.filter(b => b.test(stats)).map(b => b.id);
}

// Challenge ladder rank (§11.8). Mirrors util.js's badgeRank exactly — the same
// deliberate duplication the badge predicates already live with, since util.js
// carries DOM helpers and can't be imported here.
function badgeRank(s) {
 // An escaped run has no badges at all, so it cannot stand on the ladder
 // either — a challenge must not be beatable by a machine built outside the
 // build area. Same early return, same reason (§Free World).
 if (s.escaped) return 0;
 if (isWet(s)) return 3;
 if ((s.wheels | 0) === 0) return 2;
 if ((s.poweredWheels | 0) === 0) return 1;
 return 0;
}
// Mirrors util.js's BADGE_DEFS names for the same three rungs (2026-08-04:
// "powerless"/"rods only" → "no power"/"no wheels", so the ladder reads as one
// sentence — wet ⊂ no wheels ⊂ no power).
const BADGE_RANK_NAMES = ['any machine', 'no power', 'no wheels', 'wet'];

function levelBadges(lvl) {
 const set = new Set();
 for (const s of lvl.solveLog) {
 if (!s.public || !s.won) continue;
 for (const id of computeBadges(s)) set.add(id);
 }
 return [...set];
}

// A level's headline records, over its PUBLICLY saved wins only: the lightest,
// the fewest pieces, and the quickest. Three separate leaders — the lightest
// solve is rarely also the fastest, and collapsing them into one "best" would
// hide two thirds of what people compete over. Unlisted and private saves are
// excluded for the same reason they're excluded from `solves`: a record nobody
// can look at isn't a record.
//
// Each record carries WHO holds it (`kgBy`/`piecesBy`/`timeBy` = {name, id}).
// **Ties go to whoever got there first**, by `at` — matching a record on the
// nose is not taking it off the person who set it. That has to be an explicit
// comparison rather than a property of the loop: `solveLog` is newest-first
// (see the POST), so a plain `<` would hand every tie to the LATEST claimant,
// which is exactly backwards.
function levelBest(lvl) {
 const rec = { kg: null, pieces: null, time: null, kgBy: null, piecesBy: null, timeBy: null };
 // `name: null` rather than a missing key: an anonymous run still HOLDS the
 // record, and the client has to be able to tell "nobody has set this" from
 // "somebody signed out did"
 const who = (s) => ({ name: s.by || null, id: s.byId || null });
 const consider = (key, val, s) => {
 if (!num(val)) return;
 const cur = rec[key];
 const better = cur == null || val < cur ||
 (val === cur && s.at < (rec[key + 'At'] ?? Infinity));
 if (!better) return;
 rec[key] = val;
 rec[key + 'By'] = who(s);
 rec[key + 'At'] = s.at;
 };
 for (const s of lvl.solveLog) {
 if (!s.public || !s.won) continue;
 consider('kg', s.kg, s);
 consider('pieces', s.pieces, s);
 consider('time', s.time, s);
 }
 // the `*At` keys are the tie-breaker's own bookkeeping, not part of the
 // contract — the client is told what the record is and who holds it
 delete rec.kgAt; delete rec.piecesAt; delete rec.timeAt;
 return rec;
}

// ---------- auth ----------

const NAME_RE = /^[\w][\w \-.]{1,18}[\w]$/;
const SESSION_TTL = TUNING.sessionDays * 24 * 3600 * 1000;
const SESSION_CAP = 2000;

// **Sessions are stored under sha256(token), never the token itself.** The
// browser holds the raw bearer token; the datastore holds only its hash — so
// a leaked db.sqlite (a backup on a USB stick, a copied dev pull) is not a
// bag of every signed-in account. Costs one hash per request, which scrypt's
// ~100 ms login makes a rounding error. Raw tokens are 24 bytes → 32 chars
// of base64url; hashes are 43 — backfills() uses that to rehash pre-hash
// rows once, in place, so nobody was signed out by the change.
const sessionKey = (token) => crypto.createHash('sha256').update(token).digest('base64url');

function makeSession(userId) {
 const token = crypto.randomBytes(24).toString('base64url');
 const key = sessionKey(token);
 db.sessions[key] = { userId, at: Date.now() };
 // cap: evict oldest
 const evicted = [];
 const entries = Object.entries(db.sessions);
 if (entries.length > SESSION_CAP) {
 entries.sort((a, b) => a[1].at - b[1].at);
 for (const [t] of entries.slice(0, entries.length - SESSION_CAP)) { delete db.sessions[t]; evicted.push(t); }
 }
 scheduleSave({ sessions: [key, ...evicted] });
 return token;
}

// Single points mutation path (floor 0), log ≤ 200 (§11.5).
function grantPoints(user, delta, reason, by) {
 user.points = Math.max(0, (user.points || 0) + delta);
 user.pointsLog.unshift({ delta, reason, by, at: Date.now() });
 if (user.pointsLog.length > 200) user.pointsLog.length = 200;
 scheduleSave({ user: user.id });
}

// What a new account opens with (§11.5). A challenge prize has a floor of 1
// point, and an account that started on 0 and earned +1 a day would have met
// that as a day-one wall — so the welcome grant is what makes the feature
// reachable the moment you sign up. Granted through grantPoints rather than
// written into the record, so it shows in the new user's own points log like
// every other movement.
const WELCOME_POINTS = TUNING.welcomePoints;

// Prize escrow (§11.8). Staked up front rather than promised: grantPoints
// floors at 0, so a creator who later spent down would leave a winner claiming
// points that no longer exist. Every movement goes through the one mutation
// path above, so a prize is auditable in both users' logs.
const PRIZE_MIN = TUNING.prizeMin, PRIZE_MAX = TUNING.prizeMax;

function stakePrize(user, amount) {
 grantPoints(user, -amount, 'challenge prize staked');
}
function payPrize(winner, amount, fromName) {
 if (amount > 0) grantPoints(winner, amount, 'challenge prize won', fromName);
}
function refundPrize(creatorId, amount, why = 'challenge prize refunded') {
 if (!(amount > 0)) return;
 const u = db.users[creatorId];
 if (u) grantPoints(u, amount, why);
}

// ---------- who is here right now ----------
//
// "Active" is a five-minute window over the LAST REQUEST each account made, and
// it lives in memory on purpose: it is a question about this instant, so a
// figure that survived a restart would be a lie about a process that wasn't
// running. Nothing is persisted and nothing is scheduled — one Map write on a
// request that was already doing work. (Writing it onto the user record instead
// would mean a scheduleSave on essentially every request in the app, to store a
// number whose whole shelf life is five minutes.)
//
// It can only see accounts: an anonymous visitor sends no token, so there is
// nobody to name. The admin page says so rather than implying the site is empty.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const lastSeen = new Map(); // userId -> { at, path }

function markActive(userId, req) {
 lastSeen.set(userId, { at: Date.now(), path: req.method + ' ' + req.path });
 // The map is bounded by the number of ACCOUNTS, not by traffic, so it cannot
 // run away — but a long-lived process accumulates one dead entry per user who
 // ever signed in, so stale rows are dropped whenever it grows past the window
 // being useful for.
 if (lastSeen.size > 500) {
 const cutoff = Date.now() - ACTIVE_WINDOW_MS;
 for (const [id, v] of lastSeen) if (v.at < cutoff) lastSeen.delete(id);
 }
}

function activeUsers(windowMs = ACTIVE_WINDOW_MS) {
 const cutoff = Date.now() - windowMs;
 const rows = [];
 for (const [id, v] of lastSeen) {
 if (v.at < cutoff) continue;
 const u = db.users[id];
 if (!u) continue; // deleted account, still in the map
 rows.push({
 name: u.name, at: v.at, last: v.path,
 isAdmin: !!u.isAdmin, isModerator: !!u.isModerator,
 status: u.status || 'active',
 });
 }
 return rows.sort((a, b) => b.at - a.at);
}

// Lazy grants inside userFromReq on any authenticated request (§11.5).
function userFromReq(req) {
 const h = req.headers.authorization || '';
 const m = h.match(/^Bearer (.+)$/);
 if (!m) return null;
 const key = sessionKey(m[1]); // stored hashed — see makeSession
 const sess = db.sessions[key];
 if (!sess) return null;
 if (Date.now() - sess.at > SESSION_TTL) { delete db.sessions[key]; scheduleSave({ session: key }); return null; }
 const user = db.users[sess.userId];
 if (!user) return null;
 markActive(user.id, req); // "who is here right now" — in memory, see above
 const today = new Date().toISOString().slice(0, 10);
 if (user.lastActiveDate !== today) {
 user.lastActiveDate = today;
 grantPoints(user, 1, 'daily activity');
 }
 const month = today.slice(0, 7);
 if (user.subscribed && user.lastMonthlyGrant !== month) {
 user.lastMonthlyGrant = month;
 grantPoints(user, 1000, 'monthly subscription (TEST MODE)');
 }
 return user;
}

// Crown tiers computed fresh (§11.5): gold = top max(1, ceil(n·1%)) of
// positive-point users, silver = next to max(gold, ceil(n·10%)).
function crownTiers() {
 const ranked = Object.values(db.users)
 .filter(u => (u.points || 0) > 0)
 .sort((a, b) => (b.points || 0) - (a.points || 0));
 const n = ranked.length;
 const map = {};
 if (!n) return map;
 const goldN = Math.max(1, Math.ceil(n * 0.01));
 const silverN = Math.max(goldN, Math.ceil(n * 0.10));
 ranked.forEach((u, i) => {
 if (i < goldN) map[u.id] = 'gold';
 else if (i < silverN) map[u.id] = 'silver';
 });
 return map;
}

function publicUser(user, crowns) {
 return {
 id: user.id, name: user.name, points: user.points || 0,
 isAdmin: !!user.isAdmin, isModerator: !!user.isModerator, subscribed: !!user.subscribed,
 premiumUntil: user.premiumUntil || null,
 crown: (crowns || crownTiers())[user.id] || null,
 // the client greys out its save buttons on 'hold' rather than letting a
 // save round-trip just to be refused
 status: user.status || 'active',
 limits: { ...DEFAULT_LIMITS, ...(user.limits || {}) },
 usage: usageOf(user.id),
 };
}

// ---------- level helpers ----------

function levelPreview(data) {
 return {
 terrain: data.terrain || [],
 // the scenery is most of what a level LOOKS like, so a thumbnail without
 // it would misrepresent the very levels that bothered to have one (§10.5)
 backLevel: data.backLevel,
 props: data.props || [],
 fixedParts: data.fixedParts || [],
 // labels are part of what a level LOOKS like (§10.6) — a card without the
 // title the author put on it misrepresents the level, same as the scenery
 texts: data.texts || [],
 // loose world pins are furniture of the level the same way a bolted-on
 // terrain pin is — a card that dropped them showed a hinge hanging off
 // nothing visible
 pins: data.pins || [],
 buildZones: data.buildZones || [],
 goalZones: data.goalZones || [],
 goalObjs: data.goalObjs || [],
 background: data.background,
 // the scenery's own shrink and fade (§10.5) — a thumbnail drawn at the
 // shipped defaults would misrepresent the levels that set them
 backScale: data.backScale, backAlpha: data.backAlpha,
 };
}

// The scenery layer's two authored dials, clamped (§10.5). Mirrors sizes.js's
// `clampBackScale`/`clampBackAlpha` — that file is importable here in
// principle, but every other rule in this server is restated rather than
// imported and one exception would be the confusing kind.
//
// **`undefined` and 0 are different answers.** A missing dial means "the level
// did not say" and must stay missing so the client falls back to the shipped
// default; an alpha of 0 is a deliberate invisible backdrop and must survive
// the round trip. Returning `undefined` for absent is what keeps those apart.
function backDial(v, lo, hi) {
 if (v == null) return undefined;
 const n = Number(v);
 if (!isFinite(n)) return undefined;
 return Math.min(Math.max(n, lo), hi);
}

function num(v) { return typeof v === 'number' && isFinite(v); }

// Piece geometry (§11.1). Terrain names its shape `type`; props and goal pieces
// name it `shape` — an easy thing to get wrong by hand, and getting it wrong
// used to be silent. sim.js dispatches `x.shape === 'ball' ? {circle: x.r} :
// {box: x}` (and terrain the same on `x.type`), so an unrecognised or missing
// shape falls through to the BOX branch and b2MakeBox is handed undefined
// half-extents. Box2D accepts it; every pose on that body is NaN within ~0.3 s
// of pressing Play, the piece vanishes, and the level is unplayable for
// everyone who opens it. Nothing the editor can build gets here — hand-edited
// JSON (POST/PUT /api/levels, "Load level from file") and the FC importer do,
// and this is their only gate.
//
// So the shape is REQUIRED, not defaulted: `{ type:'ball', … }` on a prop is
// the mistake worth catching, and defaulting to box is exactly what hid it.
// The fourth field is "is this a prop", which only `gravity` asks — a prop is
// the one piece that carries its own gravity scale, so the kind has to travel
// with the piece rather than being guessed from `what` at the far end.
// `isProp` and `movable` are two different questions and a goal piece answers
// them differently, which is why they are two columns rather than one flag:
// isProp picks the TEXTURE vocabulary (props have their own sixteen), movable
// says whether the piece may carry its own `gravity` (§5.10). A goal piece
// takes terrain's textures and a prop's gravity dial.
const PIECE_KINDS = [
 ['terrain', 'type', 'terrain piece', false, false],
 ['props', 'shape', 'prop', true, true],
 ['goalObjs', 'shape', 'goal piece', false, true],
];

// A painted terrain piece (§5.3) carries no w/h/r at all — its vertices are
// its shape, and they become a Box2D chain loop. The floors that matter here
// are the ones that keep the chain builder sane: at least a triangle, no more
// than the 24 anchors the editor allows (a loop IS a closed path, so it gets
// the same cap as path.pts), and every coordinate a real number.
const MAX_PAINT_PTS = TUNING.paintMaxPts;
function badPaintPiece(o, at) {
 if (!num(o.x) || !num(o.y)) return `${at}: x and y must be numbers`;
 if (!Array.isArray(o.pts)) return `${at}: a painted piece needs a pts array`;
 // pts holds every vertex after the first plus the closing duplicate, so a
 // triangle is 3 entries and the cap counts the same way the editor does
 if (o.pts.length < 3) return `${at}: a painted piece needs at least 3 points`;
 if (o.pts.length > MAX_PAINT_PTS) return `${at}: too many points (max ${MAX_PAINT_PTS})`;
 for (const p of o.pts) {
 if (!p || !num(p.x) || !num(p.y)) return `${at}: every painted point needs numeric x and y`;
 for (const h of ['h1', 'h2']) {
 if (p[h] != null && (!num(p[h].x) || !num(p[h].y))) return `${at}: a painted point's ${h} must be numeric`;
 }
 }
 for (const h of ['h1', 'h2']) {
 if (o[h] != null && (!num(o[h].x) || !num(o[h].y))) return `${at}: ${h} must be numeric`;
 }
 return null;
}

function badPiece(o, shapeKey, what, i, isProp, movable) {
 const at = `${what} ${i + 1}`;
 if (!o || typeof o !== 'object') return `${at} is not a piece`;
 // Physics before geometry, and before the paint branch returns: surface
 // values go straight into the solver's contact material, so an out-of-range
 // friction is the same class of hazard as a NaN width. Rejected rather than
 // clamped — a level that plays differently from how it was authored is
 // worse than one that fails to save with a reason (surfaces.js).
 const surfBad = badSurface(o, at);
 if (surfBad) return surfBad;
 // Same class, same reasoning (§5.10): `planet` decides which way down is for
 // every dynamic body in the level, so an out-of-range pull or a planet on
 // something with no centre is refused rather than quietly ignored.
 const planetBad = badPlanet(o, at);
 if (planetBad) return planetBad;
 // A MOVABLE piece's own gravity (§5.10) — a prop or a goal piece — and the
 // same three reasons: it scales the force on a body, it is authored by a dial
 // with a range, and the piece it lands on may not be one that has the dial at
 // all. Checked before the paint branch returns for the same reason the two
 // above are — a painted terrain piece carrying `gravity` is exactly the
 // misunderstanding worth naming.
 const gravBad = badPieceGravity(o, at, movable);
 if (gravBad) return gravBad;
 // **Two texture vocabularies, and a piece may only speak its own.** Props got
 // sixteen of their own on 2026-08-12 and they are a DIFFERENT set from
 // terrain's — deliberately, since the whole point of them is being unmistakable
 // for a hillside. So the check is per kind rather than one shared list: a prop
 // asking for 'granite' and a terrain slab asking for 'candy' are both
 // mistakes, and both used to be one wave-through away from a piece that draws
 // as its fallback and looks like the editor lost the setting.
 const vocab = isProp ? PROP_TEXTURES : TEXTURES;
 if (o.texture != null && !vocab.includes(o.texture)) {
 return `${at}: unknown ${isProp ? 'prop ' : ''}texture '${String(o.texture).slice(0, 20)}'`;
 }
 const shape = o[shapeKey];
 if (shapeKey === 'type' && shape === 'paint') return badPaintPiece(o, at);
 // The message names the KEY as well as the value: a prop carrying `type`
 // instead of `shape` reads as perfectly sensible JSON, so "shape must be…"
 // is the whole diagnosis.
 if (shape !== 'box' && shape !== 'ball') {
 // clipped, because the offending value came out of a 2 MB request body and
 // has no business being echoed back at full length
 const got = shape === undefined ? 'nothing'
 : typeof shape === 'string' ? `'${shape.slice(0, 20)}'`
 : String(shape).slice(0, 20);
 return `${at}: ${shapeKey} must be ${shapeKey === 'type' ? "'box', 'ball' or 'paint'" : "'box' or 'ball'"} (got ${got})`;
 }
 if (!num(o.x) || !num(o.y)) return `${at}: x and y must be numbers`;
 // Finite is not the same as sane (sizes.js §14): a coordinate that survives
 // JSON at 1e40 px overflows float32 at the wasm boundary — Infinity inside
 // the solver, NaN poses one step later, for everyone who opens the level.
 // The bound is 250× the fence, so it refuses overflow, never taste.
 if (Math.abs(o.x) > COORD_MAX || Math.abs(o.y) > COORD_MAX) {
 return `${at}: x and y must be within ±${COORD_MAX}`;
 }
 if (shape === 'ball') {
 if (!num(o.r)) return `${at}: a ball needs a numeric r`;
 if (o.r < MIN_BALL_R) return `${at}: r must be at least ${MIN_BALL_R} px (got ${o.r})`;
 if (o.r > COORD_MAX) return `${at}: r must be at most ${COORD_MAX}`;
 } else {
 if (!num(o.w) || !num(o.h)) return `${at}: a box needs numeric w and h`;
 if (!pieceBoxLegal(o.w, o.h)) {
 return `${at}: a box must be at least ${MIN_AXIS} px on each side and ${MIN_AREA} px² in area (got ${o.w}×${o.h})`;
 }
 if (o.w > COORD_MAX || o.h > COORD_MAX) return `${at}: w and h must be at most ${COORD_MAX}`;
 }
 // Optional numbers, checked only when present. `density` is the one that
 // reaches the solver the same way a missing w does — it goes straight to
 // shapeDef.density, and a NaN mass gives NaN poses just as fast.
 for (const k of ['angle', 'density', 'radius']) {
 if (o[k] != null && !num(o[k])) return `${at}: ${k} must be a number`;
 }
 // Density's RANGE, not just its type — it multiplies into mass, so 1e300 is
 // NaN immediately. The range is the editor's own dial clamp (sizes.js), and
 // out of range is REJECTED like a surface or a planet, not silently clamped:
 // a level that plays differently from how it was authored is worse than one
 // that fails to save with a reason. (The sim ALSO clamps — clampDensity —
 // for local levels that never meet this route.)
 if (o.density != null && (o.density < DENSITY_MIN || o.density > DENSITY_MAX)) {
 return `${at}: density must be between ${DENSITY_MIN} and ${DENSITY_MAX} (got ${o.density})`;
 }
 // A motion path can poison the same way (NaN waypoint or speed → NaN into
 // b2Body_SetTargetTransform). One shared answer for terrain, groups and
 // labels — badPath in sizes.js — where before this only labels were read.
 const pathBad = badPath(o.path, at);
 if (pathBad) return pathBad;
 return null;
}

// **Publishing FREEZES a level's physics** (§5.8). surfaces.js's header names
// the trap this closes: an untouched piece used to resolve its friction at
// SIMULATION time from TEXTURE_SURFACE, so retuning ice there retuned every
// published level that used ice — and every recorded time on those levels
// quietly stopped re-simulating true. Baking the RESOLVED surface onto each
// terrain piece at the publish boundary makes a stored level mean the numbers
// it was published with, forever.
//
// The bake writes exactly what the piece plays like today — surfaceOf's own
// merge of explicit keys over texture defaults — so nothing changes feel on
// the day it lands; what changes is that a future retune of TEXTURE_SURFACE
// moves DRAFTS (still live-resolved, deliberately: retuning during authoring
// is the point of the table) and leaves the published record alone. Runs
// AFTER validateLevelData, which has already rejected out-of-range values.
function bakeSurfaces(data) {
 for (const t of (data?.terrain || [])) t.surface = surfaceOf(t);
 for (const t of (data?.backLevel?.terrain || [])) t.surface = surfaceOf(t);
}

function validateLevelData(data) {
 if (!data || typeof data !== 'object') return 'missing level data';
 // **The scenery dials are CLAMPED, not rejected** (§10.5). A hand-written
 // scale of 40 is not an attack, it is a number out of range, and a level is a
 // big thing to refuse over one dial — so it is pulled into range in place,
 // the same way `clampRodWeight` handles a hand-written weight. Absent stays
 // absent so the client falls back to the shipped default; 0 survives, because
 // an invisible backdrop is a legitimate choice.
 if (data.backScale != null) data.backScale = backDial(data.backScale, 0.2, 1);
 if (data.backAlpha != null) data.backAlpha = backDial(data.backAlpha, 0, 1);
 const json = JSON.stringify(data);
 // 2 MB: a level with fixedParts near its cap reaches ~130 KB, so the byte cap
 // keeps plenty of headroom above the count cap and the count cap stays the one
 // that actually binds. (It was sized for a 5000 fixedParts cap at ~650 KB;
 // that cap is now 1000 and the headroom is simply larger.)
 if (json.length > TUNING.levelMaxMB * 1024 * 1024) return `level too large (${TUNING.levelMaxMB} MB max)`;
 // **fixedParts is 1000, matching the client's MAX_FIXED_PARTS and its
 // MAX_DESIGN_PARTS.** It was 5000, which was never priced: these build as
 // dynamic bodies through the same path a player's pieces do, so 5000 of them
 // was a level that cost 19.3 ms of a 16.67 ms frame with everything asleep —
 // unplayable before the player placed a single piece. The table is in
 // game.js beside MAX_FIXED_PARTS; verify-editor.mjs gates the two agreeing.
 // props 200 → 500 → 1000 (2026-08-18): an FC level of 230 ghost lines lost
 // thirty to the old cap and its import fell apart over it, and the arty
 // ones run further. Priced: a thousand crates all awake step in 1.17 ms;
 // asleep they are nothing. Matches the client's FRONT_CAPS.
 for (const [key, cap] of [['terrain', 500], ['props', 1000], ['fixedParts', 1000], ['buildZones', 8], ['goalZones', 8], ['texts', 60]]) {
 if (data[key] != null) {
 if (!Array.isArray(data[key])) return key + ' must be an array';
 if (data[key].length > cap) return `too many ${key} (max ${cap})`;
 }
 }
 // 8 → 64 (2026-08-18): FC levels in the wild carry 17, 41 goal pieces, and
 // a goal piece costs what a prop costs. Matches the client's FRONT_CAPS.
 // **…and ZERO is allowed** (2026-08-18: "battle bot levels — someone
 // builds on the left, someone adds to the saved solve on the right, the
 // machines fight. No goal piece required."). A level with no cargo is a
 // SANDBOX: it plays, it never wins (both win tests already read an empty
 // goal set as "not yet", never as vacuous truth), and a run on it saves as
 // an attempt. Forcing a placeholder crate into it was the importer
 // misreading a fight as a delivery.
 if (!Array.isArray(data.goalObjs) || data.goalObjs.length > 64) {
 return 'a level may carry up to 64 goal pieces';
 }
 for (const z of ['buildZones', 'goalZones']) {
 const arr = data[z] || [];
 if (!Array.isArray(arr)) return `${z} must be an array`;
 // a goal ZONE is only demanded when there is cargo to bring to it — a
 // sandbox (no goal pieces) may have none; a build zone is always needed
 const needOne = z === 'buildZones' || data.goalObjs.length > 0;
 if (needOne && arr.length < 1) return `a level needs at least one ${z === 'buildZones' ? 'build' : 'goal'} zone`;
 for (const r of arr) {
 if (!r || !num(r.x) || !num(r.y) || !num(r.w) || !num(r.h)) return `bad ${z === 'buildZones' ? 'build' : 'goal'} zone`;
 // Same magnitude rule pieces get (badPiece), plus w/h must be POSITIVE:
 // a zero- or negative-size zone is a rectangle every containment test
 // reads as empty — a level whose goal can never be reached, saved
 // without a word of complaint.
 if (Math.abs(r.x) > COORD_MAX || Math.abs(r.y) > COORD_MAX
 || !(r.w > 0) || !(r.h > 0) || r.w > COORD_MAX || r.h > COORD_MAX) {
 return `bad ${z === 'buildZones' ? 'build' : 'goal'} zone`;
 }
 }
 }
 // Shape and size, before anything is allowed near Box2D (see badPiece). All
 // three lists get the same treatment because all three dispatch the same way
 // and fail the same way — terrain just spells the key differently.
 for (const [key, shapeKey, what, isProp, movable] of PIECE_KINDS) {
 const arr = data[key] || [];
 for (let i = 0; i < arr.length; i++) {
 const bad = badPiece(arr[i], shapeKey, what, i, isProp, movable);
 if (bad) return bad;
 }
 }
 // Every pin becomes a real joint at sim time, and joints pair up within
 // a shared coordinate — so an unbounded pin list is a cheap way to make the
 // solver crawl for anyone who opens the level. Same cap the editor enforces.
 //
 // TERRAIN carries pins on the same terms now (2026-08-07) and needs the
 // identical numbers: a pin is a pin whatever it is on, and a validator that
 // capped one list and not the other would be a hole in the shape of the
 // newer feature.
 for (const t of (data.terrain || [])) {
 if (t?.pins != null) {
 if (!Array.isArray(t.pins)) return 'terrain pins must be an array';
 if (t.pins.length > 8) return 'too many pins on a terrain piece (max 8)';
 for (const pin of t.pins) {
 if (!pin || !num(pin.x) || !num(pin.y)) return 'bad terrain pin';
 if (Math.abs(pin.x) > COORD_MAX || Math.abs(pin.y) > COORD_MAX) return 'bad terrain pin';
 }
 }
 }
 for (const p of (data.props || [])) {
 if (p?.pins != null) {
 if (!Array.isArray(p.pins)) return 'prop pins must be an array';
 if (p.pins.length > 8) return 'too many pins on a prop (max 8)';
 for (const pin of p.pins) {
 if (!pin || !num(pin.x) || !num(pin.y)) return 'bad prop pin';
 if (Math.abs(pin.x) > COORD_MAX || Math.abs(pin.y) > COORD_MAX) return 'bad prop pin';
 }
 }
 // propPins() also reads the pre-array `pin` on old levels, and that one
 // becomes a world hinge — so it needs the same numbers as the rest.
 if (p?.pin != null && (!num(p.pin.x) || !num(p.pin.y))) return 'bad prop pin';
 }
 // THE LEVEL'S OWN LOOSE PINS (2026-08-08) — a pin bolted to the world rather
 // than to a piece. Same coordinate rule the other two get, because it is the
 // same pin; only the CAP differs, and deliberately. Eight is a ceiling on one
 // crate because eight hinges on one crate is a strange crate; a level does not
 // share these out among pieces, so the ceiling belongs to the level. Each one
 // still costs exactly what a terrain pin costs — one revolute joint per rod
 // end that lands on it — and terrain alone may already carry 500 × 8, so 64
 // is a bound, not a budget. Must equal MAX_LEVEL_PINS in game.js;
 // verify-validation.mjs gates the two agreeing.
 if (data.pins != null) {
 if (!Array.isArray(data.pins)) return 'level pins must be an array';
 if (data.pins.length > 64) return 'too many loose pins (max 64)';
 for (const pin of data.pins) {
 if (!pin || !num(pin.x) || !num(pin.y)) return 'bad level pin';
 if (Math.abs(pin.x) > COORD_MAX || Math.abs(pin.y) > COORD_MAX) return 'bad level pin';
 // a BOSS pin's flange radius (2026-08-24) — optional, and bounded like
 // any number the sim will build geometry from
 if (pin.r != null && (!num(pin.r) || pin.r < 8 || pin.r > 60)) return 'bad boss pin radius';
 }
 }
 for (let i = 0; i < (data.texts || []).length; i++) {
 const bad = badTextPiece(data.texts[i], i);
 if (bad) return bad;
 // A label MOVES (§9.3), so its path is the same hazard a terrain piece's
 // is. One shared answer for all three path carriers now — badPath in
 // sizes.js — where this block used to be the only one that read the
 // waypoints at all (terrain and groups checked length alone).
 const pathBad = badPath(data.texts[i].path, `label ${i + 1}`);
 if (pathBad) return pathBad;
 }
 for (const [gid, g] of Object.entries(data.groups || {})) {
 const pathBad = badPath(g?.path, `group ${String(gid).slice(0, 20)}`);
 if (pathBad) return pathBad;
 }
 // Machine parts were COUNTED (the cap above) and never READ: any of the
 // 1000 could be `{t:'wheel'}` with no radius, which is NaN/PPM into
 // b2Circle and NaN poses for everyone who opens the level. Same treatment
 // the three piece lists get, from the same kind of validator (sizes.js).
 for (let i = 0; i < (data.fixedParts || []).length; i++) {
 const bad = badMachinePart(data.fixedParts[i], `fixed part ${i + 1}`);
 if (bad) return bad;
 }
 if (data.background != null && (typeof data.background !== 'string' || data.background.length > 20)) {
 return 'bad background id';
 }
 // THE SOURCE WORLD (fcimport.js `fcWorld`): an FC level's own XML, plus the
 // two manifests that map its blocks onto this level's piles. Unread here
 // until 2026-08-22, because until then only a local publish script ever sent
 // one — the Maker's save dropped it. It ships on every save of an imported
 // level now, so it gets the same read everything else on the payload gets.
 //
 // What is at stake is not this server: the string goes to fcsim's own C XML
 // parser inside every viewer's wasm instance, and the manifests index the
 // bodies it makes. sim.js already refuses the whole path when the manifests
 // disagree with the level's piles — that is an INTEGRITY check, and it is not
 // a bounds check. This is the bounds check: shapes, finite numbers and caps
 // sized off the foreground's own (1000 parts + 64 goals of machine, 500
 // terrain + 1000 props of level), so nothing here can be unbounded work.
 const fcw = data.fcWorld;
 if (fcw != null) {
 if (typeof fcw !== 'object' || Array.isArray(fcw)) return 'fcWorld must be an object';
 if (typeof fcw.xml !== 'string' || !fcw.xml.length) return 'fcWorld needs its source XML';
 if (fcw.xml.length > 1024 * 1024) return 'fcWorld XML too large (1 MB max)';
 for (const k of ['dx', 'dy']) {
 if (!num(fcw[k]) || Math.abs(fcw[k]) > COORD_MAX) return `bad fcWorld ${k}`;
 }
 if (fcw.print != null && (typeof fcw.print !== 'string' || fcw.print.length > 256 * 1024)) return 'bad fcWorld print';
 if (!Array.isArray(fcw.players) || fcw.players.length > 2048) return 'bad fcWorld player manifest';
 if (!Array.isArray(fcw.levels) || fcw.levels.length > 2048) return 'bad fcWorld level manifest';
 for (const b of fcw.players) {
 // `t` is fcsim's own block type (4 goal rect, 5/6/7 wheels, 8/9 rods) —
 // the sim switches on it, so an unknown number is a rec on no body.
 if (!b || typeof b !== 'object' || ![4, 5, 6, 7, 8, 9].includes(b.t)) return 'bad fcWorld player block';
 }
 for (const b of fcw.levels) {
 if (!b || typeof b !== 'object' || typeof b.dynamic !== 'boolean') return 'bad fcWorld level block';
 }
 }

 // THE BACKGROUND LEVEL (§10.5): a whole second world, validated with the same
 // machinery and HALF the caps, because scenery must not be able to cost more
 // than the level it decorates. It reaches the same renderer as the foreground,
 // so "the sim ignores it" is not a reason to trust it — a malformed shape that
 // would NaN a body breaks a draw just as thoroughly.
 const back = data.backLevel;
 if (back != null) {
 if (typeof back !== 'object' || Array.isArray(back)) return 'backLevel must be an object';
 // ONE level of depth. Without this, rendering and validation both recurse
 // until the stack gives out, on a payload anyone can hand-write.
 if (back.backLevel != null) return 'a background level cannot have a background level of its own';
 // No player back there, so nothing to deliver and nowhere to build.
 for (const k of ['buildZones', 'goalZones', 'goalObjs']) {
 if (back[k] != null) return `a background level has no ${k} — there is no player in it`;
 }
 // `pins` at HALF the foreground's 64, like every other list here — the
 // scenery runs its own Simulation (§10.5), so a loose pin back there is a
 // real revolute joint and has to be priced as one.
 for (const [key, cap] of [['terrain', 250], ['props', 100], ['fixedParts', 500], ['texts', 30], ['pins', 32]]) {
 if (back[key] == null) continue;
 if (!Array.isArray(back[key])) return `backLevel.${key} must be an array`;
 if (back[key].length > cap) return `too many ${key} in the background level (max ${cap})`;
 }
 for (const pin of (back.pins || [])) {
 if (!pin || !num(pin.x) || !num(pin.y)) return 'bad background level pin';
 if (Math.abs(pin.x) > COORD_MAX || Math.abs(pin.y) > COORD_MAX) return 'bad background level pin';
 }
 for (const [key, shapeKey, what, isProp, movable] of [['terrain', 'type', 'background terrain piece', false, false], ['props', 'shape', 'background prop', true, true]]) {
 const arr = back[key] || [];
 for (let i = 0; i < arr.length; i++) {
 const bad = badPiece(arr[i], shapeKey, what, i, isProp, movable);
 if (bad) return bad;
 }
 }
 // The scenery layer's machine really simulates (§10.5), so its parts get
 // the same read the foreground's now do.
 for (let i = 0; i < (back.fixedParts || []).length; i++) {
 const bad = badMachinePart(back.fixedParts[i], `background fixed part ${i + 1}`);
 if (bad) return bad;
 }
 for (let i = 0; i < (back.texts || []).length; i++) {
 const bad = badTextPiece(back.texts[i], i, 'background label');
 if (bad) return bad;
 }
 if (back.background != null && (typeof back.background !== 'string' || back.background.length > 20)) {
 return 'bad background id in the background level';
 }
 }
 return null;
}

// ---------- challenges (§11.8) ----------
//
// Two kinds, both hanging off the level record so they ride the existing
// scheduleSave({ level }) dirty hint with no new table:
//
// lvl.race one timed debut — private until revealAt, first public
// solve takes it and gets named on the level.
// lvl.challenges many live "match or beat this" bars, one per poster.

const RACE_MAX_AHEAD = TUNING.raceMaxDays * 24 * 3600 * 1000; // no scheduling a year out
const BEATME_MAX_WINDOW = TUNING.beatmeMaxDays * 24 * 3600 * 1000;
const BEATME_MIN_WINDOW = TUNING.beatmeMinMinutes * 60 * 1000;

// The challenge MESSAGE — the challenger's own line, carried with the countdown
// wherever it is shown. Both kinds can have one, and it is written once when the
// challenge is made: the bar is clamped at that moment and so are the words.
//
// Mirrors util.js's `cleanMessage` line for line — the same deliberate
// duplication the badge predicates and `badgeRank` already live with, since
// util.js carries DOM helpers and can't be loaded here. This copy is the one
// that decides what is STORED, so it runs on everything that reaches the
// database whatever a client did or didn't do first; gate 9 drives it to
// util.js's own `MESSAGE_MAX` so the two cannot drift quietly apart.
//
// **It truncates rather than refuses**, like `clampRodWeight` and the scenery
// dials: an over-long message is a paragraph where a line was asked for, not an
// attack, and a challenge with a staked prize on it is far too big a thing to
// reject over one line of trash talk.
const MESSAGE_MAX = 140;
function cleanMessage(s) {
 if (typeof s !== 'string') return '';
 const flat = s.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
 const chars = [...flat];
 return (chars.length > MESSAGE_MAX ? chars.slice(0, MESSAGE_MAX).join('') : flat).trim();
}

// Bars compare with an epsilon because "equal or less" has to include EQUAL:
// determinism (§5.8) makes reproducing the challenger's own time to the last
// bit reachable, and a bare `<=` on floats would deny that exact match.
const BAR_EPS = 1e-9;
const underBar = (v, bar) => bar == null || (num(v) && v <= bar + BAR_EPS);

// Does this solve's numbers clear the bar? Purely the terms — no ownership, no
// visibility. Split out from `qualifies` because two different questions ask
// it: "did this run win the challenge" and "has this challenge already been
// beaten by something on the board" (below), and they differ only in who the
// solve belongs to and whether anyone can see it.
function meetsBars(s, ch) {
 const bars = ch.bars || {};
 if (!underBar(s.time, bars.time)) return false;
 if (!underBar(s.pieces, bars.pieces)) return false;
 if (!underBar(s.kg, bars.kg)) return false;
 if (badgeRank(s) < (ch.badge | 0)) return false;
 if (ch.nailedIt && !s.nailedIt) return false;
 if (ch.boomerang && !s.boomerang) return false;
 // Sweep is a demandable badge, not a ladder rank — see util.js's qualifies()
 if (ch.sweep && !s.sweep) return false;
 return true;
}

// Does this solve WIN the challenge? Public and won, by somebody with an
// account, and not the challenger's own — plus the terms.
function qualifies(s, ch) {
 if (!s || !s.won || !s.public || !s.byId) return false;
 if (s.byId === ch.byId) return false;
 return meetsBars(s, ch);
}

// A challenge nobody could lose is not a challenge: if a solve already on
// public display clears the bar, the answer is sitting there to be loaded and
// re-saved. Checked against EVERY published win, the poster's own included —
// their own public solve gives the game away just as completely as anyone
// else's. (This is how "beat my RODS run" gets refused on a level that already
// has a published WET one: the ladder nests, so wet clears a rods bar.)
function alreadyBeaten(lvl, ch) {
 return lvl.solveLog.find(s => s.won && s.public && meetsBars(s, ch)) || null;
}

const raceSealed = (lvl) => !!lvl.race && !lvl.race.openedAt;

// Closing a Beat Me always publishes the challenger's own solve: the bar was
// the only thing on show while it ran, and the machine behind it is the prize
// for turning up. Winner or timeout, the reveal is the same.
function closeChallenge(lvl, ch, winnerSolve) {
 const own = lvl.solveLog.find(s => s.id === ch.solveId);
 if (own) { own.public = true; own.unlisted = false; }
 ch.closedAt = Date.now();
 if (winnerSolve) {
 ch.winner = { name: winnerSolve.by, userId: winnerSolve.byId, solveId: winnerSolve.id, at: Date.now() };
 const w = db.users[winnerSolve.byId];
 if (w) payPrize(w, ch.prize | 0, ch.by);
 } else {
 refundPrize(ch.byId, ch.prize | 0, 'challenge prize returned (nobody beat it)');
 }
 scheduleSave({ level: lvl.id });
}

// Opens races whose moment has come and closes Beat Mes that have run out.
// Driven BOTH by a timer and lazily from the read routes: a timer alone stops
// being true across a restart, and a lazy check alone never fires on an idle
// server — and a reveal that waits for the next visitor isn't a reveal.
function sweepChallenges(now = Date.now()) {
 let touched = 0;
 for (const lvl of Object.values(db.levels)) {
 if (lvl.race && !lvl.race.openedAt && now >= lvl.race.revealAt) {
 lvl.race.openedAt = now;
 delete lvl.listed;
 delete lvl.private;
 touched++;
 scheduleSave({ level: lvl.id });
 }
 for (const ch of lvl.challenges || []) {
 if (!ch.closedAt && now >= ch.endsAt) { closeChallenge(lvl, ch, null); touched++; }
 }
 }
 return touched;
}
setInterval(() => sweepChallenges(), 15_000).unref?.();

function challengeSummary(ch) {
 return {
 id: ch.id, by: ch.by, byId: ch.byId,
 bars: ch.bars, badge: ch.badge | 0,
 nailedIt: !!ch.nailedIt, boomerang: !!ch.boomerang, sweep: !!ch.sweep,
 prize: ch.prize | 0,
 message: ch.message,
 postedAt: ch.postedAt, endsAt: ch.endsAt,
 closedAt: ch.closedAt, winner: ch.winner,
 };
}

// A live stake freezes the filing dial ("The visibility dropdowns need some
// logic. ie At least: no change if it is currently a Challenge", 2026-08-07):
// an open challenge or an undecided race is other people's business conducted
// on this level — competitors staked points against a level they can reach —
// and a SEALED race's visibility belongs to its countdown, whose reveal is
// the thing that makes it public. Null when the dial is free to move.
function liveStakeReason(lvl) {
 if (lvl.race && !lvl.race.winner) {
 return raceSealed(lvl)
 ? 'This level is sealed behind a countdown — the reveal changes its visibility, not the dial.'
 : 'This level has a live timed challenge — its visibility is fixed until the race is decided.';
 }
 if ((lvl.challenges || []).some(c => !c.closedAt)) {
 return 'This level has a live challenge on it — it stays reachable until the challenge closes.';
 }
 return null;
}

function raceSummary(lvl) {
 if (!lvl.race) return undefined;
 const r = lvl.race;
 return {
 by: r.by, byId: r.byId, revealAt: r.revealAt, openedAt: r.openedAt,
 prize: r.prize | 0, winner: r.winner,
 // The message goes out with the TEASER, and that is the whole point of it:
 // the sealed card is a name, a clock and a stake, and this is the only
 // thing on it written by a person. Nothing about a level can be
 // reconstructed from it — it is the challenger's own words, published
 // deliberately, unlike the description it sits above.
 message: r.message,
 sealed: !r.openedAt,
 };
}

// ---------- has anybody but the author touched this level? (§11.9) ----------
//
// **The line for editing a level in place is the first PLAYER, not publishing.**
// An author should be able to keep fixing a level they have saved — publishing
// it does not stop that being the same level — but the moment somebody else has
// played or solved it, its geometry is load-bearing for other people's work: a
// solve is a REPLAY against that geometry (§5.8), so moving a single block
// silently invalidates every recorded time on it.
//
// So this asks about OTHER people, and the author's own testing is deliberately
// invisible to it. That distinction is the whole reason `outsidePlays` exists
// beside `plays`: `plays` is a stat and counts everyone, this counts an
// audience. Without it the author's first look at their own published level
// would lock their own level against them.
//
// Legacy rows carry `plays` and no `outsidePlays`, and are read the pessimistic
// way — an old level with plays on it is treated as touched. That is the safe
// direction for a rule about not destroying other people's work, and it costs
// nothing: a level created since this shipped has the precise count.
function levelSettled(lvl) {
 if (!lvl) return false;
 if ((lvl.solveLog || []).some(s => s.byId && s.byId !== lvl.authorId)) return true;
 if (lvl.outsidePlays === undefined) return (lvl.plays || 0) > 0;
 return lvl.outsidePlays > 0;
}

function levelSummary(lvl, crowns) {
 const ratings = Object.values(lvl.ratings || {});
 const author = lvl.authorId ? db.users[lvl.authorId] : null;
 // A sealed race is a TEASER: name, who set it, when it opens, what's staked
 // — and nothing that would let anyone see or reconstruct the level early.
 // No preview thumbnail, no records, no badge union, no description. The card
 // exists so people know to turn up, which is the whole point of everyone
 // getting it at the same moment.
 if (raceSealed(lvl)) {
 return {
 id: lvl.id, num: lvl.num, name: lvl.name,
 author: lvl.author, authorId: lvl.authorId || null,
 createdAt: lvl.createdAt,
 sealed: true,
 race: raceSummary(lvl),
 authorCrown: author ? (crowns || crownTiers())[author.id] || null : null,
 };
 }
 return {
 id: lvl.id, num: lvl.num, name: lvl.name, author: lvl.author, authorId: lvl.authorId || null,
 desc: lvl.desc, createdAt: lvl.createdAt,
 plays: lvl.plays || 0,
 solves: lvl.solveLog.filter(s => s.won && s.public).length,
 rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
 ratingCount: ratings.length,
 // how hard, 1–10 — a separate axis from how good, because a brilliant
 // level can be easy and a tedious one can be brutal
 difficulty: avgOf(lvl.difficulties),
 difficultyCount: Object.keys(lvl.difficulties || {}).length,
 // Always rebuilt from `data`, never the snapshot stored at save. Adding a
 // field to levelPreview (pins, scenery, …) has to reach every card already
 // on the site, and a stale stored preview is how a thumbnail used to keep
 // drawing a level the author no longer has.
 preview: lvl.data ? levelPreview(lvl.data) : lvl.preview,
 official: !!lvl.official,
 slot: lvl.official ? lvl.slot : undefined,
 featured: lvl.featured ? true : undefined,
 inspiredBy: lvl.inspiredBy, // "inspired by" credit snapshot — absent for most levels
 listed: lvl.listed === false ? false : undefined,
 // Whether the author may still edit this one in place (§11.9). Derived
 // rather than stored, and sent to everyone because it is derived from
 // `plays` and `solves`, which are already in this payload — the only thing
 // it adds is the author-vs-audience distinction the client cannot make.
 settled: levelSettled(lvl) || undefined,
 // only ever reaches its owner or an admin (the list and detail routes both
 // gate on it), and the owner's own lists need it to offer "make this a
 // challenge" on exactly the levels that qualify
 private: lvl.private ? true : undefined,
 badges: levelBadges(lvl),
 best: levelBest(lvl),
 race: raceSummary(lvl),
 // live bars only in the list payload — a decided challenge is history, and
 // the detail route carries the full set for anyone who wants it
 challenges: (lvl.challenges || []).filter(c => !c.closedAt).map(challengeSummary),
 authorCrown: author ? (crowns || crownTiers())[author.id] || null : null,
 };
}

// Mean of a {voterId: value} map, or null when nobody has voted. Shared by
// level stars, solve stars and comment thumbs so "rating" means the same
// arithmetic everywhere it's shown.
function avgOf(map) {
 const vals = Object.values(map || {});
 return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// How hard is the ground a player has actually covered: the mean difficulty of
// the DISTINCT levels they have beaten, using each level's crowd average rather
// than their own vote. Levels nobody has rated for difficulty are skipped, not
// counted as easy — so the count is levels-that-had-a-difficulty, and a player
// whose solves are all unrated reads as null rather than 0.
// `includePrivate` follows the same visibility rule as the solve list itself:
// only the owner and admins see private wins reflected here.
function solvedDifficulty(userId, includePrivate) {
 if (!userId) return { value: null, count: 0 };
 // the user's own ownIndex slice instead of every level × every solve —
 // DISTINCT levels still, via the Set, so five wins on one level count once
 const seen = new Set();
 const vals = [];
 for (const { lvl, s } of (ownIndex.get(userId)?.solves || [])) {
 if (!s.won || !(includePrivate || s.public)) continue;
 if (seen.has(lvl.id)) continue;
 seen.add(lvl.id);
 const d = avgOf(lvl.difficulties);
 if (d != null) vals.push(d);
 }
 return {
 value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
 count: vals.length,
 };
}

// ---------- app ----------

const app = express();
// Only when something in front is actually setting X-Forwarded-For. Left off,
// a proxied deployment buckets every visitor together and the first burst locks
// out the site; turned on without a proxy, anyone can spoof a fresh identity
// per request and the limits mean nothing.
if (TRUST_PROXY) app.set('trust proxy', true);
// 3mb (up from 600kb): a level carries terrain, props and up to 1000 fixed
// parts, checked against the tighter 2 MB validateLevelData cap once parsed;
// other payload types (solves, comments) keep their own smaller per-route caps
app.use(express.json({ limit: '3mb' }));

// static with revalidation (304s) — client files served fresh (§16)
app.use(express.static(path.join(__dirname, 'public'), {
 cacheControl: true,
 setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
}));

// ---------- share cards & link unfurling (§11.10) ----------
//
// **A real path is why this exists.** A `#/play/<id>` fragment never leaves
// the browser, so Discord fetching a leftover hash link still sees `/`. The
// share URL is `/play/<id>`, served here with real Open Graph tags. The app
// rewrites any leftover `#/…` fragment to that path on boot.
//
// **The image is baked in the AUTHOR'S browser, never here.** The client
// already draws these — `renderPreview` is what paints every Workshop card —
// so the publish path renders 1200x630 and posts the JPEG with the level. The
// alternative was a native canvas library on a Windows desktop deploy to
// re-implement a renderer that already exists, for a picture that changes only
// when a level is saved.
const CARD_W = 1200, CARD_H = 630;
const CARD_MAX_BYTES = 400 * 1024;

// A posted card, as bytes, or null. **The magic bytes are checked rather than
// the declared type**: this comes back out of the server under an image
// content type, and a data URL's `image/jpeg` is a claim by whoever posted it.
function cardBytes(dataUrl) {
 if (typeof dataUrl !== 'string' || dataUrl.length > CARD_MAX_BYTES * 2) return null;
 const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
 if (!m) return null;
 let buf;
 try { buf = Buffer.from(m[1], 'base64'); } catch { return null; }
 if (buf.length < 256 || buf.length > CARD_MAX_BYTES) return null;
 if (buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return null; // SOI + marker
 return buf;
}

const htmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
 { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

// The absolute origin, as the visitor reached it — og:image must be absolute,
// and behind Caddy that means trusting X-Forwarded-Proto (TRUST_PROXY, set on
// the live box). Falls back to the request's own host so a direct :3232 hit
// still produces working tags.
const originOf = (req) => `${req.protocol}://${req.get('host')}`;

// **May this thing be unfurled at all?** Three rules, and the first is the one
// that would silently break a feature: a SEALED race deliberately withholds
// its name, description and preview until the moment it opens (§11.8), so a
// pasted link must not show the level early — that is the entire point of the
// countdown. Private is a flat no. Unlisted IS allowed: the link is the
// sharing mechanism there, so somebody pasting one means to share it.
// **Order matters here, and it is the opposite of the obvious one.** A sealed
// race is PRIVATE by construction — the race route refuses to seal anything
// else — so testing `private` first would refuse every sealed race, which is
// exactly the card people most want to paste: the announcement is deliberately
// public (it is in the Workshop list, and search matches sealed races on their
// name alone), while the level behind it is not.
//
// So `sealed` is decided first and comes back as a FLAG rather than a refusal.
// What it withholds is everything that would let somebody see or reconstruct
// the level early — the description, the preview, the image — and never the
// name, the terms or the clock, none of which are secret.
function shareableLevel(id) {
 const lvl = db.levels[id];
 if (!lvl) return null;
 if (raceSealed(lvl)) return { lvl, sealed: true };
 if (lvl.private) return null;
 return { lvl, sealed: false };
}

// The live challenge on a level, if any — race first, then the earliest open
// bar, which is the order the card itself draws them in (`challengeChip`).
function liveChallengeOf(lvl) {
 if (lvl.race && !lvl.race.winner) return { kind: 'race', ch: lvl.race };
 const c = (lvl.challenges || []).find((x) => !x.closedAt);
 return c ? { kind: 'beatme', ch: c } : null;
}

// **Absolute, never relative.** An unfurl is CACHED by whoever renders it —
// for hours on Discord — so "opens in 3 days" quietly becomes a lie sitting in
// somebody's channel. A date survives caching. UTC because a shared link is
// read from anywhere and the server's own timezone means nothing to a reader.
const UNFURL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function whenText(ms) {
 if (!num(ms)) return null;
 const d = new Date(ms);
 const p2 = (n) => String(n).padStart(2, '0');
 return `${d.getUTCDate()} ${UNFURL_MONTHS[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

// What has to be beaten, in the card's own vocabulary. Restated rather than
// imported from util.js's `challengeTerms` for the reason every other client
// rule in this file is: util.js builds DOM, so node cannot load it.
const unfurlTime = (s) => (s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`);
const unfurlKg = (k) => (k >= 100 ? `${Math.round(k)} kg` : `${k.toFixed(1)} kg`);
function termsText(ch) {
 const bits = [];
 const bars = ch.bars || {};
 if (num(bars.time)) bits.push(`≤ ${unfurlTime(bars.time)}`);
 if (num(bars.pieces)) bits.push(`≤ ${bars.pieces} pcs`);
 if (num(bars.kg)) bits.push(`≤ ${unfurlKg(bars.kg)}`);
 if (ch.badge) bits.push(BADGE_RANK_NAMES[ch.badge] || '');
 if (ch.nailedIt) bits.push('Nailed It');
 if (ch.boomerang) bits.push('Boomerang');
 if (ch.sweep) bits.push('Sweep');
 return bits.filter(Boolean).join(' · ');
}

// The title and description a CHALLENGE card should paste as (§11.10). The
// message is already one line and length-capped on the way in (cleanMessage at
// the post routes), so it needs no second cleaning here.
function challengeUnfurl(lvl, live) {
 const { kind, ch } = live;
 const said = ch.message ? ` “${ch.message}”` : '';
 const prize = ch.prize ? `🏅${ch.prize} point${ch.prize === 1 ? '' : 's'}` : null;
 if (kind === 'race') {
 if (!ch.openedAt) {
 return {
 title: `🏁 ${lvl.name} — a timed challenge on LIFIRIK`,
 desc: [`Set by ${ch.by || 'somebody'}.`, `Opens ${whenText(ch.revealAt)}.`,
 prize ? `${prize} to the first solve.` : null].filter(Boolean).join(' ') + said,
 };
 }
 return {
 title: `🏁 ${lvl.name} — first solve wins`,
 desc: [`Set by ${ch.by || 'somebody'}.`, prize ? `${prize} to the first solve.` : null,
 'Nobody has taken it yet.'].filter(Boolean).join(' ') + said,
 };
 }
 const terms = termsText(ch);
 return {
 title: `⚔ Beat ${ch.by || 'somebody'} on ${lvl.name}`,
 desc: [terms || 'Match the run.', prize, `ends ${whenText(ch.endsAt)}`]
 .filter(Boolean).join(' · ') + said,
 };
}

// **The app shell, with tags injected — not a bounce page.** Now that the
// client routes on the path (§12), `/play/<id>` IS the level's URL: the same
// HTML every other screen gets, plus this level's own Open Graph tags in the
// head. A crawler reads the tags and stops; a person gets the app, already at
// the right screen, with no redirect in the way.
//
// Read from disk per request rather than cached, for the same reason the
// client files are served `no-cache`: a deploy replaces index.html underneath
// a running process, and a shell cached at boot would serve the old one until
// somebody restarted the server (§16). It is 500 bytes.
function appShell(tags = '') {
 const file = path.join(__dirname, 'public', 'index.html');
 const html = fs.readFileSync(file, 'utf8');
 return tags ? html.replace('</head>', tags + '\n</head>') : html;
}

function ogTags({ title, desc, image, url }) {
 return [
 `<meta property="og:type" content="website">`,
 `<meta property="og:site_name" content="LIFIRIK">`,
 `<meta property="og:title" content="${htmlEsc(title)}">`,
 `<meta property="og:description" content="${htmlEsc(desc)}">`,
 `<meta property="og:url" content="${htmlEsc(url)}">`,
 image
 ? `<meta property="og:image" content="${htmlEsc(image)}">\n`
 + `<meta property="og:image:type" content="image/jpeg">\n`
 + `<meta property="og:image:width" content="${CARD_W}">\n`
 + `<meta property="og:image:height" content="${CARD_H}">\n`
 + `<meta name="twitter:card" content="summary_large_image">`
 : `<meta name="twitter:card" content="summary">`,
 ].join('\n');
}

const err = (res, code, msg) => res.status(code).json({ error: msg });

// The card itself. Immutable per save — a re-publish writes a new one under
// the same key — so it is cacheable hard, which matters because a popular
// Discord message means one fetch per reader.
app.get('/og/:key', (req, res) => {
 const key = String(req.params.key).replace(/\.jpg$/, '');
 const bytes = store?.getCard(key);
 if (!bytes) return res.status(404).type('text/plain').send('no card');
 res.setHeader('Content-Type', 'image/jpeg');
 res.setHeader('Content-Length', String(bytes.length));
 res.setHeader('Cache-Control', 'public, max-age=600');
 res.setHeader('X-Content-Type-Options', 'nosniff');
 res.end(bytes);
});

// `/play/<levelId>` and `/play/<levelId>/<solveId>` — the level's real URL,
// served with its own Open Graph tags in the head (§11.10). A crawler reads
// the tags; a person gets the app, already at the right screen.
app.get('/play/:id/:solveId?', (req, res) => {
 const { id, solveId } = req.params;
 const share = shareableLevel(id);
 const origin = originOf(req);
 const url = `${origin}/play/${encodeURIComponent(id)}${solveId ? '/' + encodeURIComponent(solveId) : ''}`;
 // A level nobody may unfurl still has to OPEN — the app's own screens say
 // "no such level", or ask a sealed race's viewer to come back at the reveal,
 // and both are better answers than a 404. It just gets the plain shell.
 if (!share) return res.type('html').send(appShell());
 const { lvl, sealed } = share;
 const solve = solveId ? (lvl.solveLog || []).find((s) => s.id === solveId) : null;
 // a private solve is nobody's to unfurl; unlisted is a link somebody chose
 // to hand out, same rule the level itself gets
 const shown = solve && (solve.public || solve.unlisted) ? solve : null;
 // **A sealed race gets no picture, ever.** Not the level's card, not a
 // solve's: seeing the level early is the one thing the seal exists to stop,
 // and an image is the loudest way to leak it.
 const cardKey = shown ? 'S' + shown.id : 'L' + lvl.id;
 const image = !sealed && store?.getCard(cardKey) ? `${origin}/og/${cardKey}.jpg` : null;

 // A card carrying a live challenge should paste as the CHALLENGE — that is
 // what somebody copying its link means by it (§11.10). A specific solve
 // still wins over it: a link to a run is a link to that run.
 const live = shown ? null : liveChallengeOf(lvl);
 const bits = [];
 if (shown) {
 if (num(shown.time)) bits.push(`${shown.time.toFixed(1)}s`);
 if (shown.pieces) bits.push(`${shown.pieces} piece${shown.pieces === 1 ? '' : 's'}`);
 if (num(shown.kg) && shown.kg > 0) bits.push(`${shown.kg.toFixed(1)} kg`);
 }
 const ch = live ? challengeUnfurl(lvl, live) : null;
 res.type('html').send(appShell(ogTags({
 title: shown
 ? `${shown.by || 'Somebody'}'s solution to ${lvl.name} — LIFIRIK`
 : ch ? ch.title
 : `${lvl.name} — LIFIRIK`,
 desc: shown
 ? (bits.join(' · ') || 'A solved machine.')
 : ch ? ch.desc
 // the level's OWN description is never shown for a sealed race — the
 // branch above always claims it, since sealed implies a live race
 : (lvl.desc || '').trim() || `A level by ${lvl.author || 'somebody'}. Build a machine and deliver the pink thing.`,
 image,
 url,
 })));
});

// **Every other app route gets the shell.** With the hash gone (§12) a deep
// link is a real path, and the server has to answer it — `/browse` reaching
// express.static finds no file and would 404 the whole site on a refresh.
//
// Listed explicitly rather than a blanket `*`: an unknown path stays a real
// 404 instead of quietly rendering the home page, which is what turns a typo
// or a dead link into something the visitor can see is wrong. The list is the
// router's own switch in main.js — the one place they must agree, and
// verify-editor gate 33 holds them to it.
const APP_ROUTES = ['campaign', 'browse', 'maker', 'import', 'user', 'settings',
 'keys', 'learn', 'fc', 'admin', 'moderation', 'support', 'fcimport'];
// `/` is not here: express.static already serves public/index.html for it,
// with the no-cache header the rest of the client files get.
for (const r of APP_ROUTES) {
 app.get(`/${r}`, (req, res) => res.type('html').send(appShell()));
 app.get(`/${r}/*`, (req, res) => res.type('html').send(appShell()));
}

// What the client needs to know before it draws anything. Deliberately tiny and
// public: no counts, no names, nothing that isn't already obvious from using
// the site.
// A fingerprint of the client files on disk. Cheap on purpose — names, sizes
// and mtimes, never contents — because it is asked for on every tab refocus.
//
// It exists because of a failure mode that costs an hour every time it happens
// and looks like anything but what it is (§16): the app is a single page, so
// opening a different level in an open tab re-renders a screen without
// re-fetching a single module. A tab left open across an edit therefore keeps
// running the OLD code while showing the NEW level, and the bug you then chase
// is a bug that was fixed on disk. `Cache-Control: no-cache` doesn't help —
// nothing is being fetched to revalidate.
//
// Cached for a second so a burst of refocuses is one stat() pass.
const CLIENT_DIRS = ['', 'js'];
let buildCache = { at: 0, id: '' };
function clientBuildId() {
 const now = Date.now();
 if (now - buildCache.at < 1000) return buildCache.id;
 const h = crypto.createHash('sha1');
 for (const dir of CLIENT_DIRS) {
 const abs = path.join(__dirname, 'public', dir);
 let names;
 try { names = fs.readdirSync(abs).sort(); } catch { continue; }
 for (const name of names) {
 if (!/\.(js|css|html|mjs)$/.test(name)) continue;
 try {
 const st = fs.statSync(path.join(abs, name));
 h.update(`${dir}/${name}:${st.size}:${st.mtimeMs};`);
 } catch { /* vanished mid-scan */ }
 }
 }
 buildCache = { at: now, id: h.digest('hex').slice(0, 12) };
 return buildCache.id;
}

// Admin-defined campaign slices (title, byline, inclusive 1-based range).
// Empty table is seeded in backfills(); this is the live list the hub and
// the play-screen "^" both read. Sorted by start number so the hub follows
// the campaign's own numbering.
function campaignList() {
 const rows = Object.values(db.campaigns || {});
 const list = (rows.length ? rows : SETS).map(publicCampaign)
 .sort((a, b) => a.from - b.from || a.to - b.to || a.title.localeCompare(b.title));
 return list;
}

app.get('/api/config', (req, res) => {
 res.json({
 registrationOpen: REGISTRATION_OPEN,
 freeSlots: FREE_OFFICIAL_SLOTS,
 build: clientBuildId(),
 campaigns: campaignList(),
 });
});

app.get('/api/campaigns', (req, res) => {
 res.json({ campaigns: campaignList() });
});

// ---------- rate limits ----------
//
// Budgets are set from what a real player does, then multiplied generously —
// they exist to stop floods and password guessing, not to police enthusiasm.
// A signed-in user is bucketed by account rather than address, so a household
// or a school behind one NAT can't throttle each other.
const byUserOrIp = (req) => {
 const u = userFromReq(req);
 return u ? 'u:' + u.id : 'ip:' + clientIp(req);
};
// **Admins get ten times the write budgets** (2026-08-18, "raise the limits
// for everyone a bit and admin accounts x10"). The limits exist to stop
// floods, and an admin doing curation — republishing a series, backfilling
// cards, re-describing thirty levels — is exactly the enthusiasm they were
// never meant to police. Everyone else's numbers went up too, below: a real
// player was never near them, and a script an admin runs should not be
// either. RATE_LIMIT_DISABLED=1 in the environment switches the lot off
// for a one-off bulk job on a dev box (ratelimit.mjs).
const adminX10 = (n) => (req) => (userFromReq(req)?.isAdmin ? n * 10 : n);

// Catch-all: ~3 requests a second sustained, well above anything the client
// does, and the only thing standing between a crude flood and the JSON store.
app.use('/api', rateLimit({
 name: 'api', windowMs: 5 * 60_000, max: 900,
 message: 'Slow down a moment — too many requests.',
}));

// Login is the expensive one: scryptSync blocks the event loop for ~100 ms, so
// this is a DoS budget as much as a guessing budget. Two keys, because they
// stop different attacks — one host trying many accounts, and many hosts
// trying one account.
const loginByIp = rateLimit({
 name: 'login-ip', windowMs: 15 * 60_000, max: 20,
 message: 'Too many sign-in attempts. Wait a few minutes and try again.',
});
// Per-account budget, spent by FAILURES only and never applied to a correct
// password — see the login route. Locking an account on failed attempts is a
// griefing tool, not a defence: usernames here are public, so anyone could
// freeze anyone out for fifteen minutes at a time, indefinitely. What this
// does buy is a brake on guessing one account from many addresses, which the
// per-IP budget alone can't see.
const LOGIN_FAIL_BUDGET = { windowMs: TUNING.loginFailWindowMin * 60_000, max: TUNING.loginFailMax };
const registerLimit = rateLimit({
 name: 'register', windowMs: 60 * 60_000, max: 5,
 message: 'Too many accounts created from here. Try again later.',
});

// Ordinary writes: rating, commenting, voting, saving a solve.
// 120 → 300 per 5 min (2026-08-18); one a second sustained is still a flood.
const writeLimit = rateLimit({
 name: 'write', windowMs: 5 * 60_000, max: adminX10(300), by: byUserOrIp,
 message: 'You\'re doing that a lot — give it a minute.',
});
// Expensive writes: a level is up to 2 MB, a solve carries a whole design, and an FC
// import parses up to half a million characters before anything is stored.
// 60 → 240 an hour (2026-08-18): a level+solve pair every 30 s is a busy
// author, and a rename PUT was costing the same as a 2 MB level under 60.
const heavyLimit = rateLimit({
 name: 'heavy', windowMs: 60 * 60_000, max: adminX10(240), by: byUserOrIp,
 message: 'That\'s a lot of saving for one hour. Try again shortly.',
});
// The play counter fires on every level opened, so it gets its own roomy
// budget rather than eating into the one that protects the datastore.
const playLimit = rateLimit({
 name: 'play', windowMs: 5 * 60_000, max: adminX10(600), by: byUserOrIp,
 message: 'Too many plays counted just now.',
});

// ---- auth ----

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

app.post('/api/auth/register', registerLimit, (req, res) => {
 if (!REGISTRATION_OPEN) {
 return err(res, 403, 'LIFIRIK is invite-only at the moment. Ask for an account and one will be made for you.');
 }
 const { name, password, email } = req.body || {};
 if (email != null && email !== '' && (typeof email !== 'string' || email.length > 120 || !EMAIL_RE.test(email))) {
 return err(res, 400, 'That email address doesn\'t look right.');
 }
 if (typeof name !== 'string' || !NAME_RE.test(name)) {
 return err(res, 400, 'Name must be 3–20 characters: letters, digits, spaces, - . _');
 }
 if (typeof password !== 'string' || password.length < TUNING.passwordMin) {
 return err(res, 400, `Password must be at least ${TUNING.passwordMin} characters.`);
 }
 const nameLower = name.toLowerCase();
 if (Object.values(db.users).some(u => u.nameLower === nameLower)) {
 return err(res, 409, 'That name is taken.');
 }
 // Reserved names (auth.mjs): holding one is a claim about who you are, and
 // a player called "Moderator" needs no exploit to do damage. 409 like a
 // taken name, because from the register form's side that is what it is —
 // and it names the word, since "reserved" over a name that looks innocent
 // to its owner reads as a bug.
 {
 const word = reservedName(name);
 if (word) return err(res, 409, `That name is reserved — it reads as “${word}”, which belongs to the site. Pick another.`);
 }
 const salt = newSalt();
 const user = {
 id: uid(), name, nameLower, salt, hash: hashPassword(password, salt),
 email: typeof email === 'string' && email ? email : undefined,
 createdAt: Date.now(), points: 0, pointsLog: [],
 lastActiveDate: null, lastMonthlyGrant: null, subscribed: false, premiumUntil: null,
 limits: { ...DEFAULT_LIMITS }, status: 'active',
 };
 db.users[user.id] = user;
 grantPoints(user, WELCOME_POINTS, 'welcome');
 const token = makeSession(user.id);
 scheduleSave({ user: user.id });
 res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', loginByIp, (req, res) => {
 const { name, password } = req.body || {};
 const SAME_ERROR = 'Unknown name or wrong password.'; // same error for both (§11.2)
 if (typeof name !== 'string' || typeof password !== 'string') return err(res, 401, SAME_ERROR);
 const acct = name.toLowerCase();
 // Charged only when the attempt is wrong, so the owner of the account can
 // always get in — including while someone else is hammering their name.
 // Unknown names are charged too, or the budget would say which names exist.
 const failed = () => {
 if (isLoopback(clientIp(req))) return err(res, 401, SAME_ERROR);
 const gate = consume('login-fail', acct, LOGIN_FAIL_BUDGET);
 if (!gate.ok) {
 res.setHeader('Retry-After', String(gate.resetSec));
 return err(res, 429, 'Too many failed attempts on that account. Wait a few minutes and try again.');
 }
 return err(res, 401, SAME_ERROR);
 };
 const user = Object.values(db.users).find(u => u.nameLower === acct);
 if (!user) return failed();
 if (!passwordMatches(password, user.salt, user.hash)) return failed();
 resetKey('login-fail', acct); // a good password forgives the failures before it
 // Checked only AFTER the password verifies — telling an unauthenticated
 // caller that a name is banned would leak which names exist.
 if (user.status === 'banned') return err(res, 403, 'This account is banned.');
 const token = makeSession(user.id);
 res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
 const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
 if (m) { const key = sessionKey(m[1]); delete db.sessions[key]; scheduleSave({ session: key }); }
 res.json({ ok: true });
});

// Change your OWN password (§12). There is no self-service RESET — no mail is
// ever sent, so a forgotten password still needs an admin
// (`/admin/users/:name/reset-password`) or `scripts/set-password.mjs`. This is
// the other half: an account holder who knows their password can change it
// without asking anybody.
//
// **The current password is required, and that is not ceremony.** A bearer
// token is what an unattended tab hands to whoever sits down at it; without
// this check, walking past an open laptop would be enough to take an account
// permanently. It is the same reason the admin route drops every other session.
app.post('/api/auth/password', writeLimit, (req, res) => {
 const user = requireWritable(req, res);
 if (!user) return;
 const { current, next } = req.body || {};
 if (typeof current !== 'string' || typeof next !== 'string') return err(res, 400, 'Both passwords are required.');
 // Charged on failure only, and against the account name, so this cannot be
 // used as an oracle to brute-force the current password from a stolen token.
 if (!passwordMatches(current, user.salt, user.hash)) {
 if (isLoopback(clientIp(req))) return err(res, 403, 'That is not your current password.');
 const gate = consume('login-fail', user.nameLower, LOGIN_FAIL_BUDGET);
 if (!gate.ok) {
 res.setHeader('Retry-After', String(gate.resetSec));
 return err(res, 429, 'Too many attempts. Wait a few minutes and try again.');
 }
 return err(res, 403, 'That is not your current password.');
 }
 if (next.length < TUNING.passwordMin) return err(res, 400, `Password must be at least ${TUNING.passwordMin} characters.`);
 if (next === current) return err(res, 400, 'That is the password you already have.');
 resetKey('login-fail', user.nameLower);

 user.salt = newSalt();
 user.hash = hashPassword(next, user.salt);
 // **Everywhere else is signed out, and this tab is not.** Changing a password
 // is the move you make when you think somebody else has it, so leaving their
 // sessions alive would make the whole exercise decorative. Keeping the caller
 // signed in is what stops it feeling like a punishment for good practice.
 // hashed like the map's keys — comparing the raw bearer against hashed keys
 // would never match, and "keep the caller signed in" would silently break
 const rawOwn = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
 const own = rawOwn ? sessionKey(rawOwn) : null;
 const dropped = [];
 for (const [tok, sess] of Object.entries(db.sessions)) {
 if (sess.userId !== user.id || tok === own) continue;
 delete db.sessions[tok];
 dropped.push(tok);
 }
 scheduleSave({ user: user.id, sessions: dropped });
 res.json({ ok: true, signedOut: dropped.length });
});

app.get('/api/auth/me', (req, res) => {
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Not signed in.');
 res.json({ user: publicUser(user) });
});

// ---- users ----

app.get('/api/users/:name', (req, res) => {
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 const viewer = userFromReq(req);
 const own = viewer && viewer.id === target.id;
 const crowns = crownTiers();

 const levels = Object.values(db.levels)
 .filter(l => l.authorId === target.id)
 .filter(l => own || viewer?.isAdmin || l.listed !== false)
 .sort((a, b) => b.createdAt - a.createdAt)
 .map(l => levelSummary(l, crowns));

 // the ownIndex slice, not a walk of every level × every solve — this loop
 // was measured at 8.4 ms per profile view on a 5 000-level corpus
 const solves = [];
 for (const { lvl, s } of (ownIndex.get(target.id)?.solves || [])) {
 if (!s.public && !own) continue;
 solves.push({
 levelId: lvl.id, levelName: lvl.name,
 // whose it is — every row here is this profile's owner by construction,
 // but the shared row/delete widgets ask the solve, not the page, so
 // they can be reused wherever a solve is listed
 byId: s.byId,
 // The run's OWN name — what the player typed when they saved it. The
 // profile table shows it as a column (§8.2), and this payload was the
 // reason it rendered as a dash on every row: the level's solve panel has
 // always sent it, this one never did.
 name: s.name,
 id: s.id, num: s.num, won: s.won, time: s.time, pieces: s.pieces, kg: s.kg,
 wood: s.wood, water: s.water, wheels: s.wheels, poweredWheels: s.poweredWheels,
 untampered: s.untampered, nailedIt: s.nailedIt, boomerang: s.boomerang, sweep: s.sweep,
 maxPinWeight: s.maxPinWeight,
 // rides every projection, for the reason `computeBadges` explains: the
 // listings recompute badges from these fields, so a solve that arrives
 // without it recomputes as a legal one (§Free World)
 escaped: !!s.escaped,
 public: s.public, unlisted: !!s.unlisted, at: s.at,
 hasDesign: !!s.hasDesign,
 // so the owner's own list can offer "challenge others" on the solves
 // that qualify, and say so on the ones already backing one
 challengeId: own ? (lvl.challenges || []).find(c => c.solveId === s.id && !c.closedAt)?.id : undefined,
 });
 }
 solves.sort((a, b) => b.at - a.at);

 const sd = solvedDifficulty(target.id, own || !!viewer?.isAdmin);
 res.json({
 ...publicUser(target, crowns),
 createdAt: target.createdAt,
 levels,
 solves: solves.slice(0, 100),
 solvedDifficulty: sd.value,
 solvedDifficultyCount: sd.count,
 pointsLog: own ? target.pointsLog : undefined,
 });
});

app.post('/api/users/:name/gift-points', writeLimit, (req, res) => {
 const giver = userFromReq(req);
 if (!giver) return err(res, 401, 'Sign in to gift points.');
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 if (target.id === giver.id) return err(res, 400, 'You can\'t gift points to yourself.');
 const amount = Math.floor(Number(req.body?.amount));
 if (!(amount >= 1 && amount <= 500)) return err(res, 400, 'Gift 1–500 points.');
 if ((giver.points || 0) < amount) return err(res, 400, 'Not enough points.');
 grantPoints(giver, -amount, `gift to ${target.name}`);
 grantPoints(target, amount, `gift from ${giver.name}`, giver.name);
 res.json({ ok: true, points: giver.points });
});

app.post('/api/users/:name/adjust-points', (req, res) => {
 const admin = userFromReq(req);
 if (!admin?.isAdmin) return err(res, 403, 'Admins only.');
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 const delta = Math.floor(Number(req.body?.delta));
 if (!delta) return err(res, 400, 'Non-zero signed delta required.');
 grantPoints(target, delta, req.body?.reason || 'admin adjust', admin.name);
 res.json({ ok: true, points: target.points });
});

// ---- admin (§13) ----
// isAdmin: full power (this section). isModerator: comment removal only
// (DELETE /api/levels/:id/comments/:commentId, above) — never sees this page.

function requireAdmin(req, res) {
 const user = userFromReq(req);
 if (!user?.isAdmin) { err(res, 403, 'Admins only.'); return null; }
 return user;
}

// isAdmin implies every moderator power (§13).
function requireModerator(req, res) {
 const user = userFromReq(req);
 if (!user?.isModerator && !user?.isAdmin) { err(res, 403, 'Moderators only.'); return null; }
 return user;
}

// Diagnostic counts + on-disk db size — never raw records (password
// hashes/salts, session tokens) even to admins.
app.get('/api/admin/overview', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const levels = Object.values(db.levels);
 let dbBytes = 0;
 try { dbBytes = fs.statSync(DB_PATH).size; } catch { /* not saved yet */ }
 res.json({
 users: Object.keys(db.users).length,
 admins: Object.values(db.users).filter(u => u.isAdmin).length,
 moderators: Object.values(db.users).filter(u => u.isModerator).length,
 levels: levels.length,
 officialLevels: levels.filter(l => l.official).length,
 communityLevels: levels.filter(l => !l.official).length,
 unlistedLevels: levels.filter(l => l.listed === false).length,
 totalComments: levels.reduce((n, l) => n + (l.comments?.length || 0), 0),
 totalSolves: levels.reduce((n, l) => n + (l.solveLog?.length || 0), 0),
 sessions: Object.keys(db.sessions).length,
 activeNow: activeUsers().length,
 dbBytes,
 dbPath: DB_PATH,
 uptimeSec: Math.round(process.uptime()),
 });
});

// Who is on the site right now — accounts whose last request landed inside the
// window. Its own endpoint rather than a field on /overview so the admin page
// can re-poll just this (it changes by the second; the rest of that payload
// doesn't), and it reports `windowMs` and `sinceRestart` so the page can state
// what the list actually means instead of implying an empty site.
app.get('/api/admin/active', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const windowMs = Math.min(
 24 * 3600 * 1000,
 Math.max(60 * 1000, parseInt(req.query.windowMs, 10) || ACTIVE_WINDOW_MS));
 res.json({
 windowMs,
 now: Date.now(),
 // the list only knows what has happened since this process started, which
 // matters when the answer is "nobody"
 sinceRestart: Math.round(process.uptime() * 1000),
 users: activeUsers(windowMs),
 });
});

// Management list — usage, limits and quality scores per user. Never
// salt/hash/sessions. Usage and the three averages are computed by walking the
// levels once here rather than per user, so the whole table is one pass
// regardless of how many accounts there are.
app.get('/api/admin/users', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const crowns = crownTiers();
 const acc = {}; // userId -> tallies
 const bucket = (id) => (acc[id] ||= {
 levels: 0, solves: 0, comments: 0,
 levelStars: [], solveStars: [], commentVotes: [], solvedDiffs: [],
 });
 for (const lvl of Object.values(db.levels)) {
 if (!lvl.official && lvl.authorId) {
 const b = bucket(lvl.authorId);
 b.levels++;
 const r = avgOf(lvl.ratings);
 if (r != null) b.levelStars.push(r);
 }
 // solvedDifficulty is per DISTINCT level, so beating the same level five
 // times must not weight it five times — accumulated here in the one pass
 // over levels rather than calling solvedDifficulty() per user, which would
 // be users × levels
 const lvlDiff = avgOf(lvl.difficulties);
 const credited = new Set();
 for (const s of lvl.solveLog) {
 if (!s.byId) continue;
 const b = bucket(s.byId);
 b.solves++;
 const r = avgOf(s.ratings);
 if (r != null) b.solveStars.push(r);
 if (s.won && lvlDiff != null && !credited.has(s.byId)) {
 credited.add(s.byId);
 b.solvedDiffs.push(lvlDiff); // admins see private wins too
 }
 }
 for (const c of lvl.comments) {
 if (!c.byId) continue;
 const b = bucket(c.byId);
 b.comments++;
 const v = avgOf(c.votes);
 if (v != null) b.commentVotes.push(v);
 }
 // solve notes are comments too, and votable since thumbs went on all of
 // them — so they count toward the same standing
 for (const s of lvl.solveLog) {
 if (!s.byId || !s.comment) continue;
 const v = avgOf(s.commentVotes);
 if (v != null) bucket(s.byId).commentVotes.push(v);
 }
 }
 const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
 const list = Object.values(db.users)
 .map(u => {
 const b = acc[u.id] || bucket(u.id);
 return {
 id: u.id, name: u.name, email: u.email || null,
 createdAt: u.createdAt, lastActiveDate: u.lastActiveDate || null,
 points: u.points || 0,
 isAdmin: !!u.isAdmin, isModerator: !!u.isModerator,
 subscribed: !!u.subscribed, crown: crowns[u.id] || null,
 status: u.status || 'active',
 levels: b.levels, levelLimit: limitOf(u, 'levels'), levelRating: mean(b.levelStars),
 solves: b.solves, solveLimit: limitOf(u, 'solves'), solveRating: mean(b.solveStars),
 comments: b.comments, commentLimit: limitOf(u, 'comments'), commentRating: mean(b.commentVotes),
 solvedDifficulty: mean(b.solvedDiffs), solvedDifficultyCount: b.solvedDiffs.length,
 };
 })
 .sort((a, b) => b.createdAt - a.createdAt);
 res.json(list);
});

// Raise or lower one user's quotas. Absent keys are left alone, so the client
// can PATCH a single cell without having to send the whole set back.
app.post('/api/admin/users/:name/limits', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 target.limits ||= { ...DEFAULT_LIMITS };
 for (const k of Object.keys(DEFAULT_LIMITS)) {
 const v = req.body?.[k];
 if (v === undefined) continue;
 if (!num(v) || v < 0 || v > 1e6) return err(res, 400, `Bad limit for ${k}.`);
 target.limits[k] = Math.round(v);
 }
 scheduleSave({ user: target.id });
 res.json({ ok: true, limits: target.limits });
});

// active | hold (read-only freeze) | banned (also blocks sign-in). Neither
// state deletes anything the user has already saved — both are reversible.
app.post('/api/admin/users/:name/status', (req, res) => {
 const admin = requireAdmin(req, res);
 if (!admin) return;
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 const s = req.body?.status;
 if (!['active', 'hold', 'banned'].includes(s)) return err(res, 400, 'status must be active, hold or banned.');
 if (target.id === admin.id && s !== 'active') return err(res, 400, 'You can\'t hold or ban your own account.');
 target.status = s;
 const dropped = [];
 if (s === 'banned') {
 // drop live sessions so the ban takes effect now, not at token expiry
 for (const [tok, sess] of Object.entries(db.sessions)) {
 if (sess.userId === target.id) { delete db.sessions[tok]; dropped.push(tok); }
 }
 }
 scheduleSave({ user: target.id, sessions: dropped });
 res.json({ ok: true, status: s });
});

// Reset someone's password (§13). There is no self-service reset and no mail
// is ever sent (§12), so this route and `scripts/set-password.mjs` are the only
// two recovery paths that exist — the script for when nobody can sign in at
// all, this for every other time.
//
// **The new password is returned ONCE, in this response, and is then
// unrecoverable.** That is not a compromise, it is the only way an admin can
// hand it over: what is stored is a scrypt hash over a fresh salt, and nothing
// anywhere can read it back. The client shows it once and says so.
//
// A NEW SALT EVERY TIME, for the same reason the script rotates one: a reset
// is the one moment it costs nothing, and it means an old captured hash cannot
// be tested against the new password offline.
//
// SIGNS THE TARGET OUT EVERYWHERE — a reset that leaves live tokens has reset
// nothing. The one exception is the caller's own session when an admin resets
// their OWN password: signing yourself out of the tab you are working in is a
// surprise, not a security gain, and every other session of theirs still goes.
app.post('/api/admin/users/:name/reset-password', writeLimit, (req, res) => {
 const admin = requireAdmin(req, res);
 if (!admin) return;
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');

 const given = req.body?.password;
 let password;
 if (given == null || given === '') {
 password = generatePassword();
 } else {
 // the same floor the register route enforces — this must not be able to
 // set a password the sign-in form would then refuse
 if (typeof given !== 'string' || given.length < 4) return err(res, 400, 'A password must be at least 4 characters.');
 if (given.length > 200) return err(res, 400, 'That password is too long (200 max).');
 password = given;
 }

 target.salt = newSalt();
 target.hash = hashPassword(password, target.salt);

 const rawOwn = (req.headers.authorization || '').match(/^Bearer (.+)$/)?.[1];
 const own = rawOwn ? sessionKey(rawOwn) : null; // hashed, like the map's keys
 const dropped = [];
 for (const [tok, sess] of Object.entries(db.sessions)) {
 if (sess.userId !== target.id) continue;
 if (target.id === admin.id && tok === own) continue; // keep the tab you're in
 delete db.sessions[tok];
 dropped.push(tok);
 }
 scheduleSave({ user: target.id, sessions: dropped });
 res.json({ ok: true, password, signedOut: dropped.length, generated: given == null || given === '' });
});

// ---- editable text (§13.1) ----
//
// The site's long-form words, overridable at runtime. Defaults live in
// `public/js/content.js` and ship with the code; only what an admin has
// actually CHANGED is stored here, so the table is empty on a fresh install and
// the site still reads exactly as written.
//
// **The server does not know the key list, and that is on purpose.** Validating
// against it would mean a second copy of content.js here, out of date the first
// time a key is added; the client already falls back to its own default for
// anything it does not recognise, so an unknown key is inert rather than
// dangerous. What the server does enforce is size and shape, which is what
// stops this being an unbounded write endpoint attached to an admin session.
const CONTENT_KEY_MAX = 80;
const CONTENT_TEXT_MAX = 4000;
const CONTENT_KEYS_MAX = 500;

app.get('/api/content', (req, res) => {
 res.json(db.content || {});
});

app.post('/api/admin/content', writeLimit, (req, res) => {
 if (!requireAdmin(req, res)) return;
 const { key, text } = req.body || {};
 if (typeof key !== 'string' || !/^[\w.-]{1,80}$/.test(key)) return err(res, 400, 'Bad content key.');
 db.content ||= {};
 // An empty string is "put it back to the shipped default", not "make this
 // blank" — the same `|| undefined` reasoning the challenge message uses, and
 // it means Reset needs no second route.
 const clean = typeof text === 'string' ? text.replace(/\r\n/g, '\n').slice(0, CONTENT_TEXT_MAX).trim() : '';
 if (!clean) delete db.content[key];
 else {
 if (!(key in db.content) && Object.keys(db.content).length >= CONTENT_KEYS_MAX) {
 return err(res, 400, `That is ${CONTENT_KEYS_MAX} overrides already — something is wrong.`);
 }
 db.content[key] = clean;
 }
 // the precise hint: one key, one row. `writeDirty` reads the live value back
 // out of `db.content`, so a delete and a write take the same path.
 scheduleSave({ content: key });
 res.json({ ok: true, key, text: db.content[key] ?? null, overrides: Object.keys(db.content).length });
});

// What this process is ACTUALLY running on (§13.1) — the dials, where each one
// came from, and anything the environment got wrong on the way in.
//
// **Read-only on purpose.** These are environment variables, so the live value
// is whatever the process started with; a form that appeared to change them
// would be lying until the next restart. The panel exists so the number you are
// tuning against is the number in force, rather than the one you remember
// putting in a .bat file.
app.get('/api/admin/tuning', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const isSet = (name) => process.env[name] != null && process.env[name] !== '';
 res.json({
 // The whole row, not just the number: what it does, what it shipped as,
 // where it can sensibly go, and the hard clamp beyond that.
 dials: DIALS.map(d => ({
 key: d.key, env: d.env, group: d.group, what: d.what,
 value: TUNING[d.key], dflt: d.dflt, sane: d.sane, min: d.min, max: d.max,
 set: isSet(d.env),
 })),
 // the switches that are not numbers, reported the same way
 flags: [
 { key: 'registrationOpen', env: 'REGISTRATION', value: REGISTRATION_OPEN, dflt: true, sane: 'closed | anything else',
 what: 'REGISTRATION=closed turns the public sign-up route off. Accounts then come from scripts/invite.mjs only.', set: isSet('REGISTRATION') },
 { key: 'freeCampaignSlots', env: 'FREE_SLOTS', value: FREE_OFFICIAL_SLOTS, dflt: 16, sane: '0-32',
 what: 'How many campaign levels play without an account. The rest still SHOW — a locked level you can see is a reason to join.', set: isSet('FREE_SLOTS') },
 { key: 'trustProxy', env: 'TRUST_PROXY', value: TRUST_PROXY, dflt: false, sane: '1 only behind a proxy',
 what: 'Read the visitor\'s IP from X-Forwarded-For. On without a proxy, anyone forges a fresh identity; off behind one, every visitor shares a rate-limit bucket.', set: isSet('TRUST_PROXY') },
 { key: 'host', env: 'HOST', value: process.env.HOST || '0.0.0.0', dflt: '0.0.0.0', sane: '127.0.0.1 behind a proxy',
 what: 'Which interface to listen on. 127.0.0.1 keeps the app off the LAN so the only way in is the TLS proxy.', set: isSet('HOST') },
 { key: 'port', env: 'PORT', value: PORT, dflt: 3000, sane: '3000 dev, 3232 live',
 what: 'The port this process listens on.', set: isSet('PORT') },
 { key: 'rateLimitDisabled', env: 'RATE_LIMIT_DISABLED', value: process.env.RATE_LIMIT_DISABLED === '1', dflt: false, sane: 'never on a public box',
 what: 'Turns the request limiter off entirely. Loopback (this machine talking to itself) is already unlimited; this flag is for forcing the same off on a non-local bind. Never on a public box.', set: isSet('RATE_LIMIT_DISABLED') },
 ],
 notes: envNotes,
 startedAt: STARTED_AT,
 });
});

app.post('/api/admin/users/:name/role', (req, res) => {
 const admin = requireAdmin(req, res);
 if (!admin) return;
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 const { isAdmin, isModerator } = req.body || {};
 if (typeof isAdmin === 'boolean') target.isAdmin = isAdmin;
 if (typeof isModerator === 'boolean') target.isModerator = isModerator;
 scheduleSave({ user: target.id });
 res.json({ ok: true, isAdmin: !!target.isAdmin, isModerator: !!target.isModerator });
});

// Delete an account and everything it owns (§13). The opposite of hold/ban,
// which are reversible by design — this one exists for the account whose
// CONTENT is the problem (spam, abuse), where freezing the author still
// leaves the mess on every listing.
//
// What goes, and what stays:
// - their WORKSHOP LEVELS go whole — each through the same cascade the
// level-delete route runs (ownIndex, design rows, share cards) — and any
// OPEN challenge somebody ELSE staked on one is refunded before it goes;
// - their SOLVES go from every level that keeps existing (officials of
// theirs included: an official level is the game's, its solve log is not);
// - their COMMENTS, their RATINGS and difficulty votes go — a deleted
// spammer's opinions should not keep steering averages;
// - an OPEN race or challenge THEY posted is called off (their stake dies
// with the account); CLOSED ones stay — they are other people's history,
// and they carry name snapshots rather than live references;
// - their sessions die, then the record itself.
//
// **`confirm` must be the account's exact name**, typed back — the "Are you
// sure!?" is enforced here rather than trusted to the client, because this
// is the one admin button with no undo of any kind.
//
// Refuses admins (demote first — two deliberate steps, so one stolen admin
// token cannot behead the others) and the caller themself.
app.delete('/api/admin/users/:name', writeLimit, (req, res) => {
 const admin = requireAdmin(req, res);
 if (!admin) return;
 const target = Object.values(db.users).find(u => u.nameLower === req.params.name.toLowerCase());
 if (!target) return err(res, 404, 'No such user.');
 if (target.id === admin.id) return err(res, 400, 'You can\'t delete your own account.');
 if (target.isAdmin) return err(res, 400, 'That account is an admin — take the role away first, then delete.');
 if ((req.body?.confirm ?? '') !== target.name) {
 return err(res, 400, `Type the account's name back exactly to confirm: "${target.name}".`);
 }
 const id = target.id;
 const gone = { levels: 0, solves: 0, comments: 0, ratings: 0, challenges: 0, sessions: 0 };

 for (const lvl of Object.values(db.levels)) {
 // Their own Workshop level: the whole thing goes, exactly as the
 // level-delete route takes it — but force-called-off, so live stakes by
 // OTHERS are refunded rather than stranded.
 if (lvl.authorId === id && !lvl.official) {
 for (const ch of lvl.challenges || []) {
 if (!ch.closedAt && ch.byId && ch.byId !== id && (ch.prize | 0) > 0) {
 refundPrize(ch.byId, ch.prize | 0, 'challenge returned (level deleted with its author)');
 }
 }
 unindexLevel(lvl);
 for (const s of lvl.solveLog) if (s.hasDesign) store.delDesign(s.id);
 for (const s of lvl.solveLog) store.delCard('S' + s.id);
 store.delCard('L' + lvl.id);
 delete db.levels[lvl.id];
 gone.levels++;
 scheduleSave({ level: lvl.id }); // a marked id no longer in memory IS the delete
 continue;
 }

 // Every surviving level: scrub what the account left on it.
 let touched = false;
 const theirSolves = lvl.solveLog.filter(s => s.byId === id);
 if (theirSolves.length) {
 const goneIds = new Set(theirSolves.map(s => s.id));
 // a race propped up by a solve that is leaving is a race with no bar —
 // called off unless it already finished (a winner is history)
 if (lvl.race && !lvl.race.winner && (lvl.race.byId === id || goneIds.has(lvl.race.solveId))) {
 delete lvl.race;
 }
 for (const s of theirSolves) {
 unindexSolve(s);
 if (s.hasDesign) store.delDesign(s.id);
 store.delCard('S' + s.id);
 }
 lvl.solveLog = lvl.solveLog.filter(s => s.byId !== id);
 gone.solves += theirSolves.length;
 touched = true;
 }
 if (lvl.race && !lvl.race.winner && lvl.race.byId === id) { delete lvl.race; touched = true; }
 const openTheirs = (lvl.challenges || []).filter(ch => ch.byId === id && !ch.closedAt);
 if (openTheirs.length) {
 lvl.challenges = lvl.challenges.filter(ch => !(ch.byId === id && !ch.closedAt));
 gone.challenges += openTheirs.length;
 touched = true;
 }
 const theirComments = (lvl.comments || []).filter(c => c.byId === id);
 if (theirComments.length) {
 const o = ownIndex.get(id);
 if (o) o.comments = Math.max(0, o.comments - theirComments.length);
 lvl.comments = lvl.comments.filter(c => c.byId !== id);
 gone.comments += theirComments.length;
 touched = true;
 }
 const voteKey = 'user:' + id;
 if (lvl.ratings && voteKey in lvl.ratings) { delete lvl.ratings[voteKey]; gone.ratings++; touched = true; }
 if (lvl.difficulties && voteKey in lvl.difficulties) { delete lvl.difficulties[voteKey]; touched = true; }
 if (touched) scheduleSave({ level: lvl.id });
 }

 const dropped = [];
 for (const [tok, sess] of Object.entries(db.sessions)) {
 if (sess.userId === id) { delete db.sessions[tok]; dropped.push(tok); }
 }
 gone.sessions = dropped.length;
 delete db.users[id];
 ownIndex.delete(id);
 scheduleSave({ user: id, sessions: dropped });
 res.json({ ok: true, deleted: target.name, ...gone });
});

// Recent solves across ALL levels (public and private — admins see
// everything), newest-first, capped. The per-level page also shows solves
// (with the admin bypass on GET /api/levels/:id above) — this is a faster
// way to browse recent activity without opening each level individually.
app.get('/api/admin/solves', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const rows = [];
 for (const lvl of Object.values(db.levels)) {
 for (const s of lvl.solveLog) {
 rows.push({
 levelId: lvl.id, levelName: lvl.name,
 id: s.id, num: s.num, by: s.by, byId: s.byId, won: s.won, time: s.time, pieces: s.pieces,
 name: s.name, // the solve's own title, for the admin spreadsheet (2026-08-19)
 kg: s.kg, wood: s.wood, water: s.water, wheels: s.wheels,
 poweredWheels: s.poweredWheels, untampered: s.untampered, nailedIt: s.nailedIt, boomerang: s.boomerang, sweep: s.sweep,
 maxPinWeight: s.maxPinWeight,
 escaped: !!s.escaped,
 public: s.public, unlisted: s.unlisted || undefined, // the third stop, for the vis dropdown
 // truthy while this run backs a live bar of either kind — the admin
 // table's dial locks on it, the same way the profile's does
 challengeId: (lvl.challenges || []).find(c => c.solveId === s.id && !c.closedAt)?.id
 || (lvl.race && !lvl.race.winner && lvl.race.solveId === s.id ? 'race' : undefined),
 at: s.at,
 });
 }
 }
 rows.sort((a, b) => b.at - a.at);
 res.json(rows.slice(0, 300));
});

// ---- points (TEST MODE — fake purchases, no payment processor) ----

// Both gated on TUNING.testEconomy: with it on, any signed-in player can mint
// points and premium at will, which is fine on a friends-and-family box and an
// open faucet on a public one. The dial ships ON (it is the only shop there
// is) and shows in the admin Tuning panel with its own launch warning.
app.post('/api/points/test-buy', (req, res) => {
 if (!TUNING.testEconomy) return err(res, 403, 'Purchases are switched off on this server.');
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 grantPoints(user, 100, 'test-mode purchase (+100, no real charge)');
 res.json({ ok: true, points: user.points, testMode: true });
});

app.post('/api/points/test-subscribe', (req, res) => {
 if (!TUNING.testEconomy) return err(res, 403, 'Purchases are switched off on this server.');
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 user.subscribed = true;
 user.premiumUntil = Date.now() + 30 * 24 * 3600 * 1000;
 const month = new Date().toISOString().slice(0, 7);
 if (user.lastMonthlyGrant !== month) {
 user.lastMonthlyGrant = month;
 grantPoints(user, 1000, 'monthly subscription (TEST MODE)');
 }
 scheduleSave({ user: user.id });
 res.json({ ok: true, points: user.points, subscribed: true, testMode: true });
});

// ---- moderation (§13): triage queue for possibly-dodgy comments ----

// Small, generic substring list — a triage heuristic only, not a verdict:
// moderators still read and decide what actually gets removed/replaced.
const PROFANITY_WORDS = [
 'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'piss',
 'slut', 'whore', 'retard', 'nigger', 'faggot',
];
function looksDodgy(text) {
 const t = (text || '').toLowerCase();
 return PROFANITY_WORDS.some(w => t.includes(w));
}

function levelRating(lvl) {
 const vals = Object.values(lvl.ratings || {});
 return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Surfaces comments worth a moderator's attention: either the text itself
// looks dodgy, or it sits on a level with a rough ride (avg ≤2★, ≥3
// ratings so one angry vote doesn't flag an otherwise-fine level).
app.get('/api/moderation/flagged', (req, res) => {
 if (!requireModerator(req, res)) return;
 const rows = [];
 for (const lvl of Object.values(db.levels)) {
 const rating = levelRating(lvl);
 const ratingCount = Object.keys(lvl.ratings || {}).length;
 const lowRated = rating != null && rating <= 2 && ratingCount >= 3;
 for (const c of (lvl.comments || [])) {
 const dodgy = looksDodgy(c.text);
 if (!dodgy && !lowRated) continue;
 rows.push({
 levelId: lvl.id, levelName: lvl.name, levelRating: rating,
 commentId: c.id, author: c.author, text: c.text, at: c.at,
 reasons: [dodgy ? 'dodgy' : null, lowRated ? 'low-rated level' : null].filter(Boolean),
 });
 }
 }
 rows.sort((a, b) => b.at - a.at);
 res.json(rows.slice(0, 200));
});

// ---- levels ----

app.get('/api/levels', (req, res) => {
 const viewer = userFromReq(req);
 sweepChallenges(); // a reveal must not wait for the 15 s tick to be true — and it runs BEFORE the cache read, so a reveal invalidates the entry it would have been served from
 // The cache key is built from the params this route actually READS — never
 // the whole query string, because api.js appends a per-browser `client` id
 // to every call and keying on it would make the hit rate exactly zero.
 const cacheKey = viewer ? null : ['official', 'featured', 'challenge', 'author', 'solved', 'q', 'badge', 'sort']
 .map(k => `${k}=${req.query[k] ?? ''}`).join('&');
 if (cacheKey != null) {
 const hit = listCache.get(cacheKey);
 if (hit && hit.gen === listGen && Date.now() - hit.at < LIST_CACHE_TTL) {
 res.setHeader('X-List-Cache', 'hit');
 return res.type('application/json').send(hit.body);
 }
 }
 const crowns = crownTiers();
 let list = Object.values(db.levels);

 // excludes listed:false unless owner/admin (§12) — EXCEPT a sealed race,
 // which is deliberately unlisted-but-announced: everyone can see one is
 // coming, nobody can see what it is (levelSummary serves the teaser)
 list = list.filter(l => l.listed !== false || raceSealed(l) || viewer?.isAdmin || (viewer && l.authorId === viewer.id));

 if (req.query.official === '1') list = list.filter(l => l.official);
 if (req.query.featured === '1') list = list.filter(l => l.featured);
 // the Workshop's "challenges only" filter: anything with a live race or a
 // live bar on it
 if (req.query.challenge === '1') {
 list = list.filter(l => (l.race && !l.race.winner) || (l.challenges || []).some(c => !c.closedAt));
 }
 if (req.query.author) {
 const a = String(req.query.author).toLowerCase();
 list = list.filter(l => (l.author || '').toLowerCase() === a);
 }
 if (req.query.solved === '1') list = list.filter(l => l.solveLog.some(s => s.won && s.public));
 if (req.query.solved === '0') list = list.filter(l => !l.solveLog.some(s => s.won && s.public));
 // title/comment text search — matched server-side (never in the summary
 // payload itself) so a level with no matching name/desc can still surface
 // via a comment mentioning it, without bloating every list response with
 // full comment text
 if (req.query.q) {
 const qRaw = String(req.query.q);
 const q = qRaw.toLowerCase();
 // exact, case-sensitive id match — lets a solve's saved levelId (or a
 // pasted #/play/<id> URL fragment) resolve straight to its level; ids
 // are base64url (mixed-case), so this must NOT run through toLowerCase
 list = list.filter(l =>
 l.id === qRaw ||
 (l.name || '').toLowerCase().includes(q) ||
 // a sealed race matches on its NAME alone: searching its hidden
 // description would answer questions about a level nobody may read yet
 (!raceSealed(l) && ((l.desc || '').toLowerCase().includes(q) ||
 (l.comments || []).some(c => (c.text || '').toLowerCase().includes(q)))));
 }
 if (req.query.badge) {
 const wanted = String(req.query.badge).split(',').filter(Boolean);
 list = list.filter(l => {
 const b = levelBadges(l);
 return wanted.every(x => b.includes(x));
 });
 }
 const sort = req.query.sort || 'new';
 if (sort === 'slot') {
 list.sort((a, b) =>
 (a.official ? a.slot : 1e9) - (b.official ? b.slot : 1e9) || b.createdAt - a.createdAt);
 } else if (sort === 'top') {
 const score = l => {
 const r = Object.values(l.ratings || {});
 return r.length ? r.reduce((x, y) => x + y, 0) / r.length + Math.min(r.length, 10) * 0.02 : 0;
 };
 list.sort((a, b) => score(b) - score(a));
 } else if (sort === 'played') {
 list.sort((a, b) => (b.plays || 0) - (a.plays || 0));
 } else if (sort === 'alpha') {
 // `localeCompare` with numeric collation, so "Level 2" precedes "Level 10"
 // — a plain string sort puts 10 first, which reads as broken on any set of
 // levels named in a series. Ties (duplicate names are allowed) fall back to
 // newest, so the order is total and the list never reshuffles between
 // identical requests.
 list.sort((a, b) =>
 (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
 || b.createdAt - a.createdAt);
 } else {
 list.sort((a, b) => b.createdAt - a.createdAt);
 }
 const payload = list.slice(0, 500).map(l => levelSummary(l, crowns));
 if (cacheKey != null) {
 const body = JSON.stringify(payload);
 if (listCache.size >= LIST_CACHE_KEYS_MAX) listCache.clear(); // a flood of odd filters must not become a leak
 listCache.set(cacheKey, { gen: listGen, at: Date.now(), body });
 res.setHeader('X-List-Cache', 'miss');
 return res.type('application/json').send(body);
 }
 res.json(payload);
});

app.post('/api/levels', heavyLimit, (req, res) => {
 // Server saves need an account (§11.6). An anonymous row has no owner to
 // edit it, unpublish it, count it against a quota or answer for it, and the
 // Local destination — which is unlimited and costs the server nothing — is
 // exactly what someone without an account should be using. Existing
 // anonymous levels keep working; this only closes the door to new ones.
 const user = requireWritable(req, res);
 if (!user) return;
 {
 const used = usageOf(user.id).levels;
 const cap = limitOf(user, 'levels');
 if (used >= cap) {
 return err(res, 409, `Level save limit reached (${used}/${cap}). Delete one of yours, or keep this one local.`);
 }
 }
 const { name, desc, data, author, listed, visibility, hint, card } = req.body || {};
 if (typeof name !== 'string' || !name.trim() || name.length > 60) return err(res, 400, 'Bad level name.');
 const bad = validateLevelData(data);
 if (bad) return err(res, 400, bad);
 bakeSurfaces(data); // publishing freezes the physics (§5.8)
 const lvl = {
 id: uid(),
 num: nextLevelNum(),
 name: name.trim(),
 // the account is the author; official/slot are NEVER settable here. `hint`
 // is, and is the author's own text on the author's own level — same trust
 // as `desc`. It used to be officials-only, which left a Workshop author who
 // had written a level needing a nudge with no way to give one.
 author: user.name,
 authorId: user.id,
 desc: typeof desc === 'string' ? desc.slice(0, 400) : '',
 data,
 preview: levelPreview(data),
 createdAt: Date.now(),
 plays: 0,
 ratings: {},
 difficulties: {},
 comments: [],
 solveLog: [],
 };
 // Levels use the same four-way vocabulary as solves, minus Local (a local
 // level never reaches this route). `listed:false` is the old spelling of
 // unlisted and still accepted; private additionally hides it from a guessed
 // id, which GET /api/levels/:id already enforces via the owner/admin check.
 if (visibility === 'unlisted' || listed === false) lvl.listed = false;
 else if (visibility === 'private') { lvl.listed = false; lvl.private = true; }
 if (typeof hint === 'string' && hint.trim()) lvl.hint = hint.trim().slice(0, 300);
 // "Inspired by" credit (2026-08-07) — the level-side twin of a solve's remix
 // credit (§11.3): a link to the level that sparked this one, stored as a
 // SNAPSHOT {levelId, name, by, byId} so the credit survives the original
 // being renamed or deleted — credit is not a row lock. Resolved here rather
 // than trusted: an id that points at nothing is refused, not stored as
 // junk. Crediting your OWN other level is allowed on purpose — that is
 // what a sequel is. A PRIVATE level cannot be credited by anyone but its
 // owner: the credit would leak that it exists.
 if (typeof req.body?.inspiredBy === 'string' && req.body.inspiredBy.trim()) {
 const src = db.levels[req.body.inspiredBy.trim()];
 if (!src) return err(res, 400, 'That "inspired by" link doesn\'t point at a level.');
 if (src.private && src.authorId !== user.id && !user.isAdmin) {
 return err(res, 400, 'That "inspired by" level is private.');
 }
 lvl.inspiredBy = { levelId: src.id, name: src.name, by: src.author || 'anonymous', byId: src.authorId || null };
 }
 db.levels[lvl.id] = lvl;
 if (!lvl.official && lvl.authorId) ownOf(lvl.authorId).levels++; // ownIndex: level born (same predicate as rebuild)
 // The share card, if the client managed to draw one. Optional on purpose:
 // a level that arrives without one is published anyway and simply unfurls
 // as title-and-description until it is saved again (§11.10).
 { const b = cardBytes(card); if (b) store.putCard('L' + lvl.id, b); }
 scheduleSave({ level: lvl.id });
 res.json(levelSummary(lvl));
});

// FC-format level text → LIFIRIK level data. Converts only: nothing is saved
// here, so the caller keeps the normal POST /api/levels path (with its auth,
// limits and visibility rules) by posting back the { name, desc, data } this
// returns. The #/import screen converts in the browser with the same module
// for its live preview; this route is the scriptable door to it.
const FC_TEXT_MAX = TUNING.fcTextMax;

app.post('/api/import/fc', heavyLimit, (req, res) => {
 const { text, name, desc, scale, recentre, texture, background, corners, solutionInBuild } = req.body || {};
 if (typeof text !== 'string' || !text.trim()) return err(res, 400, 'Paste some FC-format level text.');
 if (text.length > FC_TEXT_MAX) return err(res, 400, `Level text too large (${FC_TEXT_MAX} chars max).`);
 if (scale != null && (typeof scale !== 'number' || !isFinite(scale) || scale <= 0 || scale > 20)) {
 return err(res, 400, 'Scale must be a number between 0 and 20.');
 }
 if (corners != null && (typeof corners !== 'number' || !isFinite(corners) || corners < 0 || corners > 64)) {
 return err(res, 400, 'Corner radius must be a number between 0 and 64.');
 }
 let out;
 try {
 out = convertFcLevel(text, { name, desc, scale, recentre, texture, background, corners, solutionInBuild });
 } catch (e) {
 return err(res, 400, 'Could not read that level text: ' + (e.message || 'unknown error'));
 }
 if (!out.stats.parsed) return err(res, 400, 'No usable pieces in that text — expected entries like "SR,x,y,w,h,angle" separated by semicolons.');
 const data = fcLevelData(out.level);
 const bad = validateLevelData(data);
 if (bad) return err(res, 400, 'Converted level is not valid: ' + bad);
 // `design` is the player's own machine — whatever of the paste's solve sat
 // inside its build area (§11.3 / fcimport's `inBuildArea`). It is NOT part of
 // the level and is not validated as one; it rides beside the data so a client
 // can put it on the Test tab, which is what the import screen does.
 res.json({ name: out.level.name, desc: out.level.desc, data, design: out.design, warnings: out.warnings, stats: out.stats });
});

// **The .fcxml door.** POST the raw retrieveLevel XML; GET the stashed paste
// once. Memory-only, one-shot, two-minute TTL. The import screen consumes
// the token and lands in the Maker with the machine on the Test tab.
const fcFileStash = new Map(); // token → { paste, at }
const FC_STASH_TTL = 120_000, FC_STASH_MAX = 16;
async function fcStash(res, xml, designId) {
 const paste = fcXmlToPaste(xml, { designId });
 if (!paste) return null;
 const now = Date.now();
 for (const [k, v] of fcFileStash) if (now - v.at > FC_STASH_TTL) fcFileStash.delete(k);
 if (fcFileStash.size >= FC_STASH_MAX) { err(res, 429, 'Too many pending imports — try again in a minute.'); return null; }
 const token = uid();
 fcFileStash.set(token, { paste, at: now });
 return token;
}
app.post('/api/fc-file', heavyLimit, express.text({ type: '*/*', limit: '3mb' }), async (req, res) => {
 // the filename rides the query so the description can name the design id
 // the XML itself does not carry
 const designId = (String(req.query.fn || '').match(/(\d{3,})/) || [])[1] || null;
 const xml = String(req.body || '');
 if (!fcXmlToPaste(xml, { designId })) return err(res, 400, 'Not a Fantastic Contraption design file (retrieveLevel XML with player blocks).');
 const token = await fcStash(res, xml, designId);
 if (token) res.type('text/plain').send(token);
});
app.get('/api/fc-file/:token', (req, res) => {
 const v = fcFileStash.get(req.params.token);
 if (!v || Date.now() - v.at > FC_STASH_TTL) {
 return err(res, 404, 'That import link expired — double-click the file again.');
 }
 fcFileStash.delete(req.params.token); // one shot: a link is not a share
 res.json({ paste: v.paste });
});

// Curation (§13). The 32 campaign slots are stamped only by the seed script
// from levels.js, and re-seeding wipes and re-stamps all of them — so promoting
// a community level by giving it a slot would work until the next seed and then
// silently vanish. `featured` is a separate, additive mark: it survives
// re-seeding, needs no slot to be free, collides with nothing, and comes off
// again as easily as it went on.
//
// A featured level that later deserves to be a campaign level graduates the
// other way: export it from the Maker and paste it into levels.js, where the
// campaign actually lives.
// **Backfill, and the only door to somebody else's card.** Cards are baked in
// the author's browser at save time, so every level published before §11.10
// has none — and they are exactly the levels there are to share today. This
// lets the admin screen render the missing ones client-side (it already draws
// every one of them as a Workshop card) and post them in a sweep. Admin-only:
// writing an image that unfurls under another author's level is not a thing
// any player should be able to do.
app.get('/api/admin/og/missing', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const have = new Set(store.cardKeys());
 // `?all=1` is the redraw-everything sweep: a thumbnail's drawing can change
 // without the level changing (zone Z-order, scenery haze, …), and those
 // cards have to be baked again rather than skipped as "already have one".
 const all = req.query.all === '1' || req.query.all === 'true';
 const missing = Object.values(db.levels)
 .filter((l) => !l.private && !raceSealed(l) && (all || !have.has('L' + l.id)))
 .map((l) => ({ id: l.id, name: l.name }));
 res.json({ missing, total: Object.keys(db.levels).length, have: have.size });
});

app.post('/api/admin/og/:id', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const lvl = db.levels[req.params.id];
 if (!lvl) return err(res, 404, 'No such level.');
 const bytes = cardBytes(req.body?.card);
 if (!bytes) return err(res, 400, `Not a JPEG data URL under ${Math.round(CARD_MAX_BYTES / 1024)} KB.`);
 store.putCard('L' + lvl.id, bytes);
 res.json({ ok: true, bytes: bytes.length });
});

app.post('/api/admin/levels/:id/feature', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const on = req.body?.featured;
 if (typeof on !== 'boolean') return err(res, 400, 'featured must be true or false.');
 if (lvl.official) return err(res, 400, 'Official campaign levels are already curated — featuring is for community levels.');
 if (on) lvl.featured = true; else delete lvl.featured;
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, featured: !!lvl.featured });
});

// ---------- the campaign as an ORDERED LIST an admin can edit (§13) ----------
//
// **Slots used to be the seed script's alone**, and the note above still holds
// for what it was arguing about: `featured` is the right way to put a community
// level on the Workshop shelf. What it did NOT provide is a way to say "this is
// campaign 13 now", and re-running the seed to get one is the most destructive
// thing on the box — it deletes every official and re-creates it with a fresh
// id, so every solve, comment, rating and challenge on the campaign goes with
// them. Curating from here keeps the ids, and the ids are what all of that
// hangs off.
//
// **So the DATABASE is the campaign's order now, not levels.js.** The seed
// script is a from-cold bootstrap; once anything has been moved here, re-seeding
// is a nuke rather than a refresh, and it refuses to run without --force to say
// so out loud.
//
// The slot is the number: `num` is kept at `slot + 1` for officials, exactly as
// the seed stamps it (§11.2), so "campaign 13" means one thing whether you are
// reading a card, a URL or an exported filename.

// **`official` is not the same thing as "in the campaign", and this database
// proves it.** There are levels carrying `official: true` with no slot at all —
// an older generation that outlived the seeding that made them — and they have
// never appeared on the campaign page, because the grid used to ask for slots by
// number and none of them answered. They are real levels with real plays and
// real solves on them; they are just not part of the running order.
//
// So the order is levels with a SLOT, and a slotless official is left exactly
// where it is. The alternative — treating `official` as membership — would have
// meant the first reorder anybody performed silently drafted twelve forgotten
// levels onto the end of the campaign, which is not a thing a renumber should
// do. Giving one a number through the admin screen adds it deliberately, which
// is the only way it should happen.
function campaignOrder() {
 return Object.values(db.levels)
 .filter((l) => l.official && num(l.slot))
 // createdAt breaks a tie rather than leaving it to object order, so two
 // levels that somehow share a slot still sort the same way twice running
 .sort((a, b) => a.slot - b.slot || (a.createdAt || 0) - (b.createdAt || 0));
}

// Slots are a DENSE 0..n-1 run, restored after every move — which is what makes
// "insert at 13" mean something. A gap would show up as a hole in the campaign
// grid, and two levels sharing a slot would make the page render one of them
// twice and the other never.
//
// Writes only what actually moved: a reorder near the end of the campaign should
// not mark all thirty-something levels dirty and rewrite them.
function reflowCampaign(order = campaignOrder()) {
 order.forEach((lvl, i) => {
 if (lvl.slot === i && lvl.num === i + 1) return;
 lvl.slot = i;
 lvl.num = i + 1;
 scheduleSave({ level: lvl.id });
 });
 return order;
}

// A level about to become a campaign level has to be one people can actually
// play, and must not be carrying a competition — `POST /levels/:id/challenges`
// already refuses an official, so letting one in through this door would leave
// the invariant broken from the other side.
function campaignRefusal(lvl) {
 if (lvl.private) return 'That level is private — publish it before making it a campaign level.';
 if (lvl.listed === false) return 'That level is unpublished — re-publish it before making it a campaign level.';
 if (lvl.race && !lvl.race.winner) return 'Call off the timed challenge on it first — campaign levels can\'t carry one.';
 if ((lvl.challenges || []).some((c) => !c.closedAt)) return 'Withdraw the live challenge on it first — campaign levels can\'t carry one.';
 return null;
}

// PUT a level into the campaign at a number, moving whatever is there down.
// One operation for both jobs, because they are the same job: a level that is
// not in the campaign JOINS at that number, one already in it MOVES to it, and
// either way everything from that number on shifts by one. `number` is 1-based
// — it is the number on the card, and an admin typing "13" means the thirteenth.
app.put('/api/admin/campaigns', writeLimit, (req, res) => {
 if (!requireAdmin(req, res)) return;
 const parsed = normalizeCampaigns(req.body?.campaigns);
 if (parsed.error) return err(res, 400, parsed.error);
 if (!parsed.campaigns.length) return err(res, 400, 'Keep at least one campaign.');
 db.campaigns ||= {};
 const next = {};
 for (const c of parsed.campaigns) next[c.id] = c;
 const ids = new Set([...Object.keys(db.campaigns), ...Object.keys(next)]);
 db.campaigns = next;
 scheduleSave({ campaigns: [...ids] });
 res.json({ ok: true, campaigns: campaignList() });
});

app.put('/api/admin/levels/:id/slot', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const n = req.body?.number;
 if (!Number.isInteger(n) || n < 1) return err(res, 400, 'number must be a whole number, 1 or more.');
 const refusal = campaignRefusal(lvl);
 if (refusal) return err(res, 400, refusal);

 const rest = campaignOrder().filter((l) => l !== lvl);
 // Past the end is not an error, it is "put it last" — an admin asking for 40
 // in a campaign of 32 wants it on the end, and refusing would be pedantry
 // about a number they can see is at the bottom of the list anyway.
 const at = Math.min(n - 1, rest.length);
 const joining = !lvl.official;
 if (joining) {
 // ownIndex counts a member's OWN levels and its predicate is
 // `!official && authorId` — so joining the campaign is a removal from that
 // tally. Missing this would inflate an author's level count until the next
 // restart rebuilt the index (and only until then, which is worse: it would
 // look like it fixed itself).
 if (lvl.authorId) { const o = ownIndex.get(lvl.authorId); if (o && o.levels > 0) o.levels--; }
 lvl.official = true;
 // Featuring is the Workshop shelf; the campaign is a different shelf, and a
 // level on both would appear twice under two different justifications.
 delete lvl.featured;
 }
 rest.splice(at, 0, lvl);
 reflowCampaign(rest);
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, joined: joining, number: lvl.num, slot: lvl.slot, campaign: campaignSummary(rest) });
});

// …and out again. The level stays exactly where it is otherwise — same id, same
// solves, same comments — it just stops being part of the campaign and goes back
// to being an ordinary Workshop level.
app.delete('/api/admin/levels/:id/slot', (req, res) => {
 if (!requireAdmin(req, res)) return;
 const lvl = findLevel(req, res);
 if (!lvl) return;
 if (!lvl.official) return err(res, 400, 'That level is not in the campaign.');
 delete lvl.official;
 delete lvl.slot;
 // Back to the community range (§11.2). Its old 1..32 number belongs to
 // whichever level holds that campaign place now, and two levels answering to
 // "7" is exactly what the number exists to prevent.
 lvl.num = nextLevelNum();
 if (lvl.authorId) ownOf(lvl.authorId).levels++; // ownIndex: back in the author's own tally
 scheduleSave({ level: lvl.id });
 const order = reflowCampaign();
 res.json({ ok: true, number: lvl.num, campaign: campaignSummary(order) });
});

// What the admin screen redraws from: enough to show the list in order without
// a second round trip for it.
function campaignSummary(order) {
 return order.map((l) => ({ id: l.id, num: l.num, slot: l.slot, name: l.name }));
}

function findLevel(req, res) {
 const lvl = db.levels[req.params.id];
 if (!lvl) { err(res, 404, 'No such level.'); return null; }
 return lvl;
}

// ---- challenges (§11.8) ----

// The board: everything live, soonest deadline first, plus what was decided
// recently so a winner gets their moment rather than vanishing at the buzzer.
app.get('/api/challenges', (req, res) => {
 sweepChallenges();
 const crowns = crownTiers();
 const live = [], decided = [];
 const RECENT = 7 * 24 * 3600 * 1000;
 for (const lvl of Object.values(db.levels)) {
 if (lvl.race) {
 const row = { kind: 'race', level: levelSummary(lvl, crowns), race: raceSummary(lvl) };
 if (!lvl.race.winner) live.push({ ...row, at: lvl.race.revealAt });
 else if (Date.now() - lvl.race.winner.at < RECENT) decided.push(row);
 }
 for (const ch of lvl.challenges || []) {
 // a sealed race's bars would leak its stats — it has none yet anyway
 if (raceSealed(lvl)) continue;
 const row = { kind: 'beatme', level: levelSummary(lvl, crowns), challenge: challengeSummary(ch) };
 if (!ch.closedAt) live.push({ ...row, at: ch.endsAt });
 else if (Date.now() - ch.closedAt < RECENT) decided.push(row);
 }
 }
 live.sort((a, b) => a.at - b.at);
 decided.sort((a, b) => (b.challenge?.closedAt || b.race?.winner?.at || 0) - (a.challenge?.closedAt || a.race?.winner?.at || 0));
 res.json({ live: live.slice(0, 100), decided: decided.slice(0, 30) });
});

// Turn a level you already saved PRIVATE into a timed challenge (§11.8).
//
// Deliberately not part of publishing. Setting a challenge is a decision about
// a level you already have, made after you've played it and know it's worth
// somebody's evening — folding it into the save dialog made it a thing you
// answered on the way past, at the one moment you knew least about the level.
// Private is the precondition rather than a side effect: the level has to be
// sealed already, so nobody has seen it before the clock starts.
app.post('/api/levels/:id/race', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 if (lvl.authorId !== user.id && !user.isAdmin) return err(res, 403, 'Not your level.');
 if (lvl.official) return err(res, 400, 'Campaign levels can\'t be challenges.');
 if (lvl.race) return err(res, 409, 'That level is already a challenge.');
 if (!lvl.private) return err(res, 400, 'Save the level as Private first — a challenge has to be sealed before it opens.');
 if (lvl.solveLog.some(s => s.public)) return err(res, 400, 'That level already has a published solve.');

 const revealAt = Number(req.body?.revealAt);
 if (!num(revealAt)) return err(res, 400, 'Bad reveal time.');
 if (revealAt <= Date.now()) return err(res, 400, 'The reveal time has to be in the future.');
 if (revealAt > Date.now() + RACE_MAX_AHEAD) return err(res, 400, 'Reveal times can be at most 90 days out.');
 const prize = req.body?.prize == null ? PRIZE_MIN : Math.floor(Number(req.body.prize));
 if (!num(prize) || prize < PRIZE_MIN || prize > PRIZE_MAX) {
 return err(res, 400, `A prize must be ${PRIZE_MIN}–${PRIZE_MAX} points.`);
 }
 if ((user.points || 0) < prize) return err(res, 400, `Not enough points — you have ${user.points || 0}.`);

 lvl.race = {
 by: user.name, byId: user.id, revealAt, prize,
 // `|| undefined` rather than '' — an absent message has no business being a
 // key in the database, and every reader already asks whether there is one
 message: cleanMessage(req.body?.message) || undefined,
 openedAt: null, winner: null,
 };
 stakePrize(user, prize);
 scheduleSave({ level: lvl.id });
 res.json(levelSummary(lvl));
});

// Call it off, but only while it's still sealed: once it has opened, people
// have played it and a winner may be mid-run. The stake comes back and the
// level goes back to being an ordinary private level.
app.delete('/api/levels/:id/race', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 if (lvl.authorId !== user.id && !user.isAdmin) return err(res, 403, 'Not your level.');
 if (!lvl.race) return err(res, 404, 'That level isn\'t a challenge.');
 if (lvl.race.openedAt) return err(res, 400, 'It has already opened — that can\'t be undone.');
 refundPrize(lvl.race.byId, lvl.race.prize | 0, 'challenge prize returned (called off)');
 delete lvl.race;
 scheduleSave({ level: lvl.id });
 res.json({ ok: true });
});

// Post a "match or beat this" bar from one of your own PRIVATE solves. The
// numbers go on show; the machine that made them doesn't, until the challenge
// closes.
app.post('/api/levels/:id/challenges', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const b = req.body || {};
 const own = lvl.solveLog.find(s => s.id === b.solveId);
 if (!own) return err(res, 404, 'No such solve.');
 if (own.byId !== user.id) return err(res, 403, 'That isn\'t your solve.');
 if (!own.won) return err(res, 400, 'Only a solved run can set a challenge.');
 if (own.public) return err(res, 400, 'That solve is already published — a challenge hides the machine until it ends.');
 if ((lvl.challenges || []).some(c => !c.closedAt && c.byId === user.id)) {
 return err(res, 409, 'You already have a live challenge on this level.');
 }

 const hours = Math.floor(Number(b.hours ?? 0)) + Math.floor(Number(b.days ?? 0)) * 24;
 const window = hours * 3600 * 1000;
 if (!num(window) || window < BEATME_MIN_WINDOW || window > BEATME_MAX_WINDOW) {
 return err(res, 400, 'A challenge has to run between 15 minutes and 30 days.');
 }
 const prize = b.prize == null ? PRIZE_MIN : Math.floor(Number(b.prize));
 if (!num(prize) || prize < PRIZE_MIN || prize > PRIZE_MAX) {
 return err(res, 400, `A prize must be ${PRIZE_MIN}–${PRIZE_MAX} points.`);
 }
 if ((user.points || 0) < prize) return err(res, 400, `Not enough points — you have ${user.points || 0}.`);

 // You cannot demand what you haven't done. Every bar is checked against the
 // poster's own solve: no asking for a faster time, fewer pieces, less weight
 // or a badge than the run being challenged actually managed.
 const bars = {};
 for (const [key, mine] of [['time', own.time], ['pieces', own.pieces], ['kg', own.kg]]) {
 const raw = b.bars?.[key];
 if (raw == null || raw === '') continue;
 const v = Number(raw);
 if (!num(v) || v <= 0) return err(res, 400, `Bad ${key} bar.`);
 if (num(mine) && v < mine - BAR_EPS) {
 return err(res, 400, `You can't set a ${key} bar better than your own solve (${mine}).`);
 }
 bars[key] = v;
 }
 const badge = Math.max(0, Math.min(3, Math.floor(Number(b.badge ?? 0)) || 0));
 if (badge > badgeRank(own)) return err(res, 400, 'You can\'t demand a badge your own solve didn\'t earn.');
 if (b.nailedIt && !own.nailedIt) return err(res, 400, 'Your own solve didn\'t earn Nailed It.');
 if (b.boomerang && !own.boomerang) return err(res, 400, 'Your own solve didn\'t earn Boomerang.');
 if (b.sweep && !own.sweep) return err(res, 400, 'Your own solve didn\'t earn Sweep.');
 // **A challenge with no terms is "solve it at all", and that is a real
 // challenge** (2026-08-08, on request). This used to be refused outright —
 // "a challenge needs at least one thing to beat" — which was wrong about a
 // level nobody has published a win on: there, simply finishing it IS the
 // thing to beat, and it is the hardest bar the level has to offer.
 //
 // Nothing is lost by allowing it, because `alreadyBeaten` below is the rule
 // that actually protects a challenge from being pointless, and it handles
 // this case exactly right: with no terms, `meetsBars` is true of EVERY
 // published win, so a bar-less challenge is refused the moment the level has
 // one — and allowed while it has none. That is precisely "still a valid
 // challenge if no published solutions yet".
 const noTerms = !Object.keys(bars).length && !badge && !b.nailedIt && !b.boomerang && !b.sweep;

 const ch = {
 id: uid(),
 by: user.name, byId: user.id, solveId: own.id,
 bars, badge,
 nailedIt: !!b.nailedIt || undefined,
 boomerang: !!b.boomerang || undefined,
 sweep: !!b.sweep || undefined,
 prize,
 message: cleanMessage(b.message) || undefined,
 postedAt: Date.now(),
 endsAt: Date.now() + window,
 };

 // Refuse a bar the board has already cleared. Note this is checked AFTER the
 // clamp above, so the two rules meet in the obvious place: if a published
 // solve already beats your own run, there is no legal bar left to set on
 // this level — you can't ask for better than you did, and asking for what
 // you did is asking for something already on display.
 const done = alreadyBeaten(lvl, ch);
 if (done) {
 const how = [
 done.time != null ? `${(+done.time).toFixed(2)}s` : null,
 `${done.pieces | 0} pcs`,
 `${(+done.kg || 0).toFixed(1)} kg`,
 BADGE_RANK_NAMES[badgeRank(done)],
 ].filter(Boolean).join(' · ');
 // A bar-less challenge fails this for a different reason than a barred
 // one, and saying "set a harder bar" to someone who set none is advice
 // about a control they never touched. It is the same rule either way —
 // the answer is already on display — but the way out is not.
 return err(res, 409, noTerms
 ? `${done.by || 'A published solve'} has already solved this one (${how}), so "just solve it" is already answered. Set a bar they haven't cleared.`
 : `${done.by || 'A published solve'} has already done that (${how}). Set a harder bar — or there isn't one left on this level.`);
 }
 lvl.challenges = lvl.challenges || [];
 lvl.challenges.push(ch);
 stakePrize(user, prize);
 scheduleSave({ level: lvl.id });
 res.json(challengeSummary(ch));
});

// Withdraw your own (or any, as an admin). The stake comes back; the solve
// publishes, exactly as it would have at the buzzer — the bar was public, so
// the machine behind it doesn't get to stay secret just because the challenge
// was pulled.
app.delete('/api/levels/:id/challenges/:cid', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const ch = (lvl.challenges || []).find(c => c.id === req.params.cid);
 if (!ch) return err(res, 404, 'No such challenge.');
 if (ch.byId !== user.id && !user.isAdmin) return err(res, 403, 'Not your challenge.');
 if (ch.closedAt) return err(res, 400, 'That challenge is already over.');
 closeChallenge(lvl, ch, null);
 res.json({ ok: true });
});

// ---- rewriting the message (§11.8) ----
//
// **The TERMS are written once; the message is not, and the difference is the
// whole point of the split.** A bar is clamped at post time because people are
// playing against it — moving it under them would invalidate runs already
// made. The message is flavour: nothing anyone has to beat depends on a word of
// it, so the person who wrote it can rewrite it, and clearing it is allowed too.
//
// It exists because "written once" was tried first and was wrong in the most
// ordinary case there is: every challenge that already existed when the feature
// shipped could never show one, and the only way to add it was to destroy the
// challenge and re-make it — which for a bar publishes the solve behind it.
// A rule that makes the user demolish their own work to use a feature is a rule
// with no argument behind it.
//
// Live only, both kinds. A decided challenge is history and reads as a record;
// letting its author reword it afterwards would let them rewrite what they
// said before they knew how it went.
function setChallengeMessage(req, res, pick) {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const target = pick(lvl);
 if (!target) return err(res, 404, 'No such challenge.');
 const { owner, live, why } = target;
 if (owner !== user.id && !user.isAdmin) return err(res, 403, 'Not your challenge.');
 if (!live) return err(res, 400, why);
 // Same `|| undefined` as on the way in: clearing it removes the key rather
 // than leaving an empty string for every reader to test for separately.
 target.rec.message = cleanMessage(req.body?.message) || undefined;
 scheduleSave({ level: lvl.id });
 return res.json({ ok: true, message: target.rec.message });
}

app.post('/api/levels/:id/race/message', writeLimit, (req, res) =>
 setChallengeMessage(req, res, (lvl) => lvl.race && {
 rec: lvl.race,
 owner: lvl.race.byId,
 live: !lvl.race.winner,
 why: 'That challenge has been won — its message stands as it was.',
 }));

app.post('/api/levels/:id/challenges/:cid/message', writeLimit, (req, res) =>
 setChallengeMessage(req, res, (lvl) => {
 const ch = (lvl.challenges || []).find(c => c.id === req.params.cid);
 return ch && {
 rec: ch,
 owner: ch.byId,
 live: !ch.closedAt,
 why: 'That challenge is over — its message stands as it was.',
 };
 }));

app.get('/api/levels/:id', (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 sweepChallenges(); // opening on read, so a countdown page can't be stale
 const viewer = userFromReq(req);
 const isOwner = viewer && lvl.authorId === viewer.id;
 // A sealed race answers with the TEASER rather than 404: its existence is
 // public on purpose (the countdown is the announcement), while its data,
 // preview, comments and solves stay sealed until the moment. The author and
 // admins get the real thing so it can be tested before it opens.
 if (raceSealed(lvl) && !isOwner && !viewer?.isAdmin) {
 return res.json({ ...levelSummary(lvl, crownTiers()), solveList: [], comments: [] });
 }
 // UNLISTED (listed:false) is a LINK tier: kept out of every list, but the
 // direct link works — which is what the publish dialog has promised all
 // along, what the delete route's reasoning already assumed ("it reached
 // exactly the people its author handed the link to"), what the OG route
 // already served, and what solves have always done. PRIVATE is the state
 // where a guessed id must 404 — and it does, without leaking that there
 // was anything to find. This guard used to 404 both, which made "Unlisted"
 // a promise the link could not keep (caught by ownership gate 11,
 // 2026-08-07, the day the third stop became switchable).
 if (lvl.private && !isOwner && !viewer?.isAdmin) return err(res, 404, 'No such level.');
 // later challenges are the account carrot: the list shows them to everyone,
 // but the playable payload needs a sign-in (401, so the client offers one)
 if (lvl.official && lvl.slot >= FREE_OFFICIAL_SLOTS && !viewer) {
 // Wording (2026-08-18): the account is not a paywall and the
 // message must not read like one
 return err(res, 401, `Account is FREE! The first ${FREE_OFFICIAL_SLOTS} levels you don't need an account. The account is just a place to save your solves etc.`);
 }
 const crowns = crownTiers();
 const own = (s) => viewer && s.byId === viewer.id;

 // public + own-private; replay payloads only on the newest 30 (§11.2).
 // Designs live in their own table now (storage.mjs v2), so the newest-30
 // attach is up to thirty point reads — SQLite's page cache makes a hot
 // level's reads memory-speed, and the response shape is unchanged to the
 // byte, which is why no client code moved.
 const visible = lvl.solveLog.filter(s => s.public || own(s) || viewer?.isAdmin).slice(0, 80);
 const newest30 = new Set(lvl.solveLog.slice(0, 30).map(s => s.id));
 const solveList = visible.map(s => {
 const d = newest30.has(s.id) && s.hasDesign ? store.getDesign(s.id) : null;
 return {
 id: s.id, num: s.num, by: s.by, byId: s.byId, name: s.name, won: s.won, time: s.time, pieces: s.pieces,
 basedOn: s.basedOn, // remix credit — "after <name>", §11.3
 kg: s.kg, wood: s.wood, water: s.water, wheels: s.wheels,
 poweredWheels: s.poweredWheels, untampered: s.untampered, nailedIt: s.nailedIt, boomerang: s.boomerang, sweep: s.sweep,
 maxPinWeight: s.maxPinWeight,
 // rides every projection, for the reason `computeBadges` explains: the
 // listings recompute badges from these fields, so a solve that arrives
 // without it recomputes as a legal one (§Free World)
 escaped: !!s.escaped,
 at: s.at, public: s.public, unlisted: !!s.unlisted, comment: s.comment,
 hasDesign: !!s.hasDesign,
 commentUp: Object.values(s.commentVotes || {}).filter(x => x > 0).length,
 commentDown: Object.values(s.commentVotes || {}).filter(x => x < 0).length,
 yourCommentVote: viewer ? (s.commentVotes?.[viewer.id] || 0) : 0,
 rating: avgOf(s.ratings), ratingCount: Object.keys(s.ratings || {}).length,
 yourRating: viewer ? (s.ratings?.[viewer.id] || null) : null,
 design: d?.design, goals: d?.goals,
 };
 });

 const summary = levelSummary(lvl, crowns);
 const clientKey = viewer ? 'user:' + viewer.id : req.query.client;
 res.json({
 ...summary,
 data: lvl.data,
 hint: lvl.hint,
 comments: lvl.comments.slice(-100).map(c => ({
 id: c.id, author: c.author, byId: c.byId, text: c.text, at: c.at, edited: c.edited,
 score: avgOf(c.votes),
 up: Object.values(c.votes || {}).filter(x => x > 0).length,
 down: Object.values(c.votes || {}).filter(x => x < 0).length,
 yourVote: viewer ? (c.votes?.[viewer.id] || 0) : 0,
 })),
 solveList,
 yourRating: clientKey ? lvl.ratings[clientKey] || null : null,
 yourDifficulty: clientKey ? (lvl.difficulties || {})[clientKey] || null : null,
 });
});

app.put('/api/levels/:id', heavyLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 if (lvl.authorId !== user.id && !user.isAdmin) return err(res, 403, 'Not your level.');
 const { name, desc, data, hint, listed, card, inspiredBy } = req.body || {};
 // A re-save redraws the card under the same key — the geometry may have
 // changed, and a thumbnail of the old layout is worse than none.
 { const b = cardBytes(card); if (b) store.putCard('L' + lvl.id, b); }
 if (typeof name === 'string' && name.trim() && name.length <= 60) lvl.name = name.trim();
 if (typeof desc === 'string') lvl.desc = desc.slice(0, 400);
 if (data !== undefined) {
 // **Only the GEOMETRY freezes** (§11.9), and only once somebody else has
 // played or solved it. The name, the description and the hint stay editable
 // for the life of the level — they are what an author most wants to fix
 // after watching people play, and none of them can invalidate a replay.
 // Drawing the line around `data` rather than around the whole record is
 // what makes "you can no longer edit this" a narrow, explicable rule
 // instead of a wall.
 //
 // Admins are exempt: editing a played level in place is exactly what the
 // official-level path is for, and it is done knowing what it costs.
 if (!user.isAdmin && levelSettled(lvl)) {
 return err(res, 409, 'Someone else has played this level, so its layout is fixed now — recorded solves are replays against it. You can still edit the name, description and hint, or save a copy.');
 }
 const bad = validateLevelData(data);
 if (bad) return err(res, 400, bad);
 bakeSurfaces(data); // an edit re-freezes at today's numbers (§5.8)
 lvl.data = data;
 lvl.preview = levelPreview(data);
 }
 // Hints used to be officials-only, which meant a Workshop author could write
 // a level that needed a nudge and had no way to give one. It is the author's
 // own text on the author's own level — same trust as `desc`. An empty string
 // clears it, which is what makes the Hint button disappear (§8.2).
 if (typeof hint === 'string') {
 const h = hint.trim().slice(0, 300);
 if (h) lvl.hint = h; else delete lvl.hint;
 }
 // credit is text-like, never invalidates a replay, and stays editable for
 // the life of the level like the hint — '' clears it, same idiom
 if (typeof inspiredBy === 'string') {
 const v = inspiredBy.trim();
 if (!v) delete lvl.inspiredBy;
 else {
 const src = db.levels[v];
 if (!src) return err(res, 400, 'That "inspired by" link doesn\'t point at a level.');
 if (src.private && src.authorId !== user.id && !user.isAdmin) {
 return err(res, 400, 'That "inspired by" level is private.');
 }
 lvl.inspiredBy = { levelId: src.id, name: src.name, by: src.author || 'anonymous', byId: src.authorId || null };
 }
 }
 // Both filing paths — the old boolean and the three-stop dial below — hold
 // still while the level carries a live stake, and only when the call would
 // actually MOVE it: re-asserting where it already stands is not a change
 // worth refusing.
 if (listed === true && lvl.listed === false) {
 const why = liveStakeReason(lvl);
 if (why) return err(res, 409, why);
 }
 if (listed === false && lvl.listed !== false) {
 const why = liveStakeReason(lvl);
 if (why) return err(res, 409, why);
 }
 if (listed === true) delete lvl.listed; // relist
 if (listed === false) lvl.listed = false;
 // The full three-stop dial as ONE field, matching the publish dialog and
 // the spreadsheets' dropdown (2026-08-07). `listed` above stays for old
 // callers — this is the same dial with the third stop (private) reachable:
 // unpublishing has always been the reversible step, and private is just
 // unpublished plus "a guessed link 404s", which GET already enforces off
 // these two flags.
 if (typeof req.body?.visibility === 'string') {
 const v = req.body.visibility;
 if (!['public', 'unlisted', 'private'].includes(v)) {
 return err(res, 400, 'visibility must be public, unlisted, or private.');
 }
 if (lvl.official && v !== 'public') return err(res, 400, 'Campaign levels stay public.');
 const current = lvl.private ? 'private' : lvl.listed === false ? 'unlisted' : 'public';
 if (v !== current) {
 const why = liveStakeReason(lvl);
 if (why) return err(res, 409, why);
 }
 if (v === 'public') { delete lvl.listed; delete lvl.private; }
 else if (v === 'unlisted') { lvl.listed = false; delete lvl.private; }
 else { lvl.listed = false; lvl.private = true; }
 }
 scheduleSave({ level: lvl.id });
 res.json(levelSummary(lvl));
});

// Delete a level. **Private only**, and only your own (admins excepted).
//
// The privacy rule is the whole safety argument: a public or unlisted level has
// been handed to other people — played, rated, commented on, solved — and those
// solves are their work, not the author's to erase. A private level has an
// audience of one, so removing it destroys nothing anybody else owns.
//
// Live stakes block it outright rather than being silently refunded here: the
// challenge routes own the points ledger (§11.8), and a delete path that also
// moved points would be a second place for that arithmetic to live.
app.delete('/api/levels/:id', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 const own = lvl.authorId === user.id;
 if (!own && !user.isAdmin) return err(res, 403, 'Not your level.');
 if (lvl.official) return err(res, 400, 'Campaign levels can\'t be deleted.');
 // PUBLIC is the only visibility that is protected, and unlisted is not it.
 // The argument for the rule is other people's work — a public level has been
 // played, rated, commented on and solved, and deleting it deletes solves that
 // belong to whoever set them. An unlisted level was never listed anywhere: it
 // reached exactly the people its author handed the link to, which is the same
 // audience a private one has plus a deliberate act of sharing. Holding those
 // hostage to an "unpublish to private, then delete" two-step protected
 // nothing and just read as the button being broken.
 if (lvl.listed !== false && !user.isAdmin) {
 return err(res, 400, 'A public level can\'t be deleted — unpublish it to unlisted or private first, and note that unpublishing keeps other people\'s solves.');
 }
 if (lvl.race && !lvl.race.winner) return err(res, 400, 'Call off the timed challenge first.');
 if ((lvl.challenges || []).some(c => !c.closedAt)) return err(res, 400, 'Withdraw the live challenge on it first.');
 unindexLevel(lvl); // ownIndex: the level, its solves and its comments all go
 for (const s of lvl.solveLog) if (s.hasDesign) store.delDesign(s.id); // and their design rows
 for (const s of lvl.solveLog) store.delCard('S' + s.id); // …and every share card
 store.delCard('L' + lvl.id);
 delete db.levels[lvl.id];
 // The same hint an update uses: writeDirty treats a marked id that is no
 // longer in memory as a delete, so there is no separate "it went away" call
 // to forget. A made-up hint key would have marked nothing and persisted
 // nothing — the row would come back at the next boot.
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, deleted: lvl.id });
});

// Delete one solve. Same rule, same reason: private ones only, so nothing
// anybody else can see disappears from under them — and a solve backing a live
// challenge is the challenge's evidence until it closes.
app.delete('/api/levels/:id/solves/:solveId', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 const i = lvl.solveLog.findIndex(s => s.id === req.params.solveId);
 if (i < 0) return err(res, 404, 'No such solve.');
 const s = lvl.solveLog[i];
 const own = s.byId === user.id;
 if (!own && !user.isAdmin) return err(res, 403, 'Not your solve.');
 // Same rule as a level, one level down: public is protected, unlisted is not
 // (an unlisted solve is a link you chose to hand somebody, not a listing).
 if (s.public && !user.isAdmin) {
 return err(res, 400, 'A public solve can\'t be deleted — set it to Unlisted or Private first.');
 }
 if (lvl.race?.solveId === s.id && !lvl.race.winner) return err(res, 400, 'That solve is backing a timed challenge.');
 if ((lvl.challenges || []).some(c => c.solveId === s.id && !c.closedAt)) {
 return err(res, 400, 'That solve is backing a live challenge — withdraw it first.');
 }
 lvl.solveLog.splice(i, 1);
 unindexSolve(s); // ownIndex
 if (s.hasDesign) store.delDesign(s.id); // the design row goes with its solve
 store.delCard('S' + s.id); // and so does its share card
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, deleted: s.id, solves: lvl.solveLog.filter(x => x.won && x.public).length });
});

app.post('/api/levels/:id/rate', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 const stars = Math.round(Number(req.body?.stars));
 if (!(stars >= 1 && stars <= 5)) return err(res, 400, 'Stars must be 1–5.');
 const key = user ? 'user:' + user.id : String(req.body?.clientId || '');
 if (!key) return err(res, 400, 'Missing client id.');
 lvl.ratings[key] = stars; // upsert
 scheduleSave({ level: lvl.id });
 const vals = Object.values(lvl.ratings);
 res.json({ ok: true, rating: vals.reduce((a, b) => a + b, 0) / vals.length, ratingCount: vals.length });
});

// How hard was it, 1–10. Deliberately the same rules as /rate — same voter key
// (account, else client id), same upsert, same anonymous allowance — so the two
// axes can never disagree about who is allowed an opinion.
app.post('/api/levels/:id/difficulty', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 const value = Math.round(Number(req.body?.difficulty));
 if (!(value >= 1 && value <= 10)) return err(res, 400, 'Difficulty must be 1–10.');
 const key = user ? 'user:' + user.id : String(req.body?.clientId || '');
 if (!key) return err(res, 400, 'Missing client id.');
 lvl.difficulties ||= {};
 lvl.difficulties[key] = value; // upsert
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, difficulty: avgOf(lvl.difficulties), difficultyCount: Object.keys(lvl.difficulties).length });
});

app.post('/api/levels/:id/comments', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 if (user) {
 const why = blockedReason(user);
 if (why) return err(res, 403, why);
 const used = usageOf(user.id).comments;
 const cap = limitOf(user, 'comments');
 if (used >= cap) return err(res, 409, `Comment limit reached (${used}/${cap}).`);
 }
 const text = String(req.body?.text || '').trim().slice(0, 280);
 if (!text) return err(res, 400, 'Empty comment.');
 const c = {
 id: uid(),
 author: user ? user.name : String(req.body?.author || 'anonymous').slice(0, 20) || 'anonymous',
 // stored so a comment can be counted against its author's quota and
 // scored in the admin table — `author` is a display name and two users
 // can't be told apart by it after a rename
 byId: user ? user.id : undefined,
 text,
 votes: {},
 at: Date.now(),
 };
 lvl.comments.push(c);
 if (c.byId) ownOf(c.byId).comments++; // ownIndex
 // the 300-cap trim removes the OLDEST comments — each spliced one comes off
 // its author's count too, or the index drifts high exactly on busy levels
 if (lvl.comments.length > 300) {
 for (const old of lvl.comments.splice(0, lvl.comments.length - 300)) {
 if (old.byId) { const o = ownIndex.get(old.byId); if (o && o.comments > 0) o.comments--; }
 }
 }
 scheduleSave({ level: lvl.id });
 res.json(c);
});

// Thumbs up/down on a comment, one vote per user (re-voting replaces, voting
// the same way twice clears). Stored ±1 so the average is a single number in
// [-1, 1] — the same arithmetic as the star ratings, just a coarser scale.
app.post('/api/levels/:id/comments/:commentId/vote', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const c = lvl.comments.find(x => x.id === req.params.commentId);
 if (!c) return err(res, 404, 'No such comment.');
 if (c.byId && c.byId === user.id) return err(res, 403, 'You can\'t vote on your own comment.');
 const v = req.body?.vote;
 if (![1, -1, 0].includes(v)) return err(res, 400, 'vote must be 1, -1 or 0.');
 c.votes ||= {};
 if (v === 0 || c.votes[user.id] === v) delete c.votes[user.id];
 else c.votes[user.id] = v;
 scheduleSave({ level: lvl.id });
 res.json({
 ok: true,
 score: avgOf(c.votes),
 up: Object.values(c.votes).filter(x => x > 0).length,
 down: Object.values(c.votes).filter(x => x < 0).length,
 yours: c.votes[user.id] || 0,
 });
});

// moderator power (§13): remove a rude/off-topic comment. Admins get this
// for free too — isAdmin implies every moderator power.
app.delete('/api/levels/:id/comments/:commentId', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 if (!requireModerator(req, res)) return;
 const before = lvl.comments.length;
 const gone = lvl.comments.filter(c => c.id === req.params.commentId);
 lvl.comments = lvl.comments.filter(c => c.id !== req.params.commentId);
 if (lvl.comments.length === before) return err(res, 404, 'No such comment.');
 for (const c of gone) if (c.byId) { // ownIndex
 const o = ownIndex.get(c.byId);
 if (o && o.comments > 0) o.comments--;
 }
 scheduleSave({ level: lvl.id });
 res.json({ ok: true });
});

// moderator power: redact a comment's text in place (keeps the row/author/
// timestamp, unlike DELETE) — defaults to a canned replacement so a
// moderator can cover up a bad word/ideology with one click.
const DEFAULT_REDACTION = 'What are they like!';
app.put('/api/levels/:id/comments/:commentId', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 if (!requireModerator(req, res)) return;
 const c = lvl.comments.find(x => x.id === req.params.commentId);
 if (!c) return err(res, 404, 'No such comment.');
 const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 280) : '';
 c.text = text || DEFAULT_REDACTION;
 scheduleSave({ level: lvl.id });
 res.json(c);
});

app.post('/api/levels/:id/play', playLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 lvl.plays = (lvl.plays || 0) + 1;
 // …and separately, how many of those were somebody OTHER than the author
 // (§11.9). `plays` is the stat and counts everyone; this is what decides
 // whether the level is still the author's to edit, and an author testing
 // their own level must not lock it against themselves. A signed-out visitor
 // has no id and is therefore always "somebody else", which is the right way
 // round: they are an audience the author cannot account for.
 const viewer = userFromReq(req);
 if (!lvl.authorId || !viewer || viewer.id !== lvl.authorId) {
 lvl.outsidePlays = (lvl.outsidePlays || 0) + 1;
 } else if (lvl.outsidePlays === undefined) {
 lvl.outsidePlays = 0; // start the precise count, so the legacy read stops applying
 }
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, plays: lvl.plays });
});

// Saving a solve is now always DELIBERATE — the client no longer posts every
// win and every abandoned attempt. What lands here is something a player
// named and chose to keep, so it counts against their quota and carries a
// visibility from the start rather than being filed private-by-default and
// sorted out later. "Local" never reaches this route at all; that's the whole
// point of offering it (§11.6).
app.post('/api/levels/:id/solve', heavyLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 // Same rule as publishing a level (§11.6): the server's three visibility
 // tiers all presume an owner, so saving here needs an account. Local is the
 // destination without one, and it is unlimited.
 const user = requireWritable(req, res);
 if (!user) return;
 {
 const used = usageOf(user.id).solves;
 const cap = limitOf(user, 'solves');
 if (used >= cap) {
 return err(res, 409, `Solve save limit reached (${used}/${cap}). Delete an old one, or save this locally instead.`);
 }
 }
 const b = req.body || {};
 const won = b.won !== false;
 const vis = ['public', 'unlisted', 'private'].includes(b.visibility) ? b.visibility : null;
 const rec = {
 id: uid(),
 num: nextSolveNum(),
 by: user.name,
 byId: user.id,
 name: typeof b.name === 'string' ? b.name.slice(0, 60) : undefined,
 ratings: {},
 won,
 // full float precision — never mutate stored numerics through lossy
 // round-trips; recorded times are re-verified against re-simulation (§5.8)
 time: num(b.time) ? b.time : null,
 pieces: b.pieces | 0,
 kg: num(b.kg) ? b.kg : 0,
 wood: b.wood | 0, water: b.water | 0,
 wheels: b.wheels | 0, poweredWheels: b.poweredWheels | 0,
 untampered: !!b.untampered,
 nailedIt: !!b.nailedIt,
 boomerang: !!b.boomerang,
 sweep: !!b.sweep,
 // The heaviest PIN, for the NRW badge (§11.4). `null` when the client did
 // not send one, and `computeBadges` reads null as "nobody measured" rather
 // than "nothing heavy" — a solve recorded before the stat existed keeps its
 // gap instead of being handed a badge no one checked. The server
 // re-simulates from the authored level (§5.8), so a lie here is a lie about
 // the design that replay would contradict.
 maxPinWeight: num(b.maxPinWeight) ? b.maxPinWeight : null,
 // **Built outside the build area** (§Free World, 2026-08-09). Stored on the
 // same terms as `sweep` and `nailedIt` — a fact about the run the client
 // asserts and the server keeps. It has to be KEPT: badges are derived and
 // never stored, so a record that dropped this flag recomputed as a legal
 // solve everywhere it was ever listed, which is how a machine built out in
 // the open ended up wearing badges.
 escaped: !!b.escaped,
 at: Date.now(),
 // The save dialog always sends one; private is the safe default for a
 // client that doesn't, since it can be published afterwards but an
 // accidental publish can't be un-seen.
 public: vis === 'public',
 unlisted: vis === 'unlisted',
 };
 if (typeof b.comment === 'string' && b.comment.trim()) {
 rec.comment = b.comment.trim().slice(0, 128);
 }
 // Remix credit (§11.3): a run built on somebody's loaded solve names them.
 // The client sends only the ID it loaded; the name is looked up HERE, from
 // the record on this level — a client-supplied name would be a forgeable
 // byline, and "after DoLLy" is a claim about DoLLy. Denormalised because it
 // is one: the credit is to whoever set that solve at the time it was built
 // on, and it must survive the original being deleted (credit is not a
 // foreign key). Silently dropped when the id names nothing on this level —
 // a stale claim is not worth failing a save over — and when it names the
 // saver's own solve, because crediting yourself is noise wearing a feature.
 if (typeof b.basedOnSolveId === 'string') {
 const src = lvl.solveLog.find((s) => s.id === b.basedOnSolveId);
 if (src && src.byId !== user.id) {
 rec.basedOn = { solveId: src.id, by: src.by || 'anonymous', byId: src.byId || null };
 }
 }
 // Attempts are watchable too: the machine is the thing you come back to,
 // whether or not this run finished. A win still gets the share card below.
 if (Array.isArray(b.design)) {
 // matches the client's MAX_DESIGN_PARTS (1000) — the byte cap scales with
 // it (80 KB was the 300-part allowance; drag-placed parts carry full-
 // precision floats, so ~500 parts can legitimately reach ~100 KB). Measured
 // on the densest thing a player can build, a machine of long ropes: 1000
 // parts serialises to 126 KB, so 320 KB keeps the same headroom the 500-part
 // cap had. **This number is sized FROM the client's** — a machine somebody
 // can build and then cannot save their winning run of is the worst outcome
 // of the pair being out of step, and it is silent until someone wins.
 if (b.design.length > 1000) return err(res, 400, 'Replay too large (1000 parts max).');
 if (JSON.stringify(b.design).length > 320 * 1024) return err(res, 400, 'Replay too large (320 KB max).');
 // Counted and sized was the whole of what this route asked of a replay,
 // and any of the 1000 parts could be `{t:'wheel'}` with no radius — NaN
 // poses for everyone who ever watches it. Same validator the level's own
 // fixedParts go through (sizes.js), because they are the same parts.
 for (let i = 0; i < b.design.length; i++) {
 const bad = badMachinePart(b.design[i], `replay part ${i + 1}`);
 if (bad) return err(res, 400, bad);
 }
 if (b.goals != null && (!Array.isArray(b.goals) || b.goals.length > 64)) return err(res, 400, 'Bad goal positions.');
 // The staged goal positions feed body construction the same way a part's
 // coordinates do, so they get the same finite-and-bounded read.
 for (const g of (b.goals || [])) {
 if (!g || !num(g.x) || !num(g.y) || Math.abs(g.x) > COORD_MAX || Math.abs(g.y) > COORD_MAX) {
 return err(res, 400, 'Bad goal positions.');
 }
 }
 // The design never touches the in-memory record: it is written ONCE to
 // its own table (immutable from here on) and read back on demand — the
 // level row, the boot-time RAM and every writeDirty of this level stay
 // the size of the stats, not the machine. `hasDesign` is the flag the
 // read routes attach from.
 store.putDesign(rec.id, { design: b.design, goals: Array.isArray(b.goals) ? b.goals : undefined });
 rec.hasDesign = true;
 // A solution's own card shows the winning machine on the level (§11.10)
 { const img = cardBytes(b.card); if (img) store.putCard('S' + rec.id, img); }
 }
 lvl.solveLog.unshift(rec); // newest-first
 if (rec.byId) ownOf(rec.byId).solves.push({ lvl, s: rec }); // ownIndex
 const challengeResult = settleChallenges(lvl, rec);
 // No per-level truncation any more. It used to drop everything past 120,
 // which was harmless when the client posted every win automatically — the
 // log was a firehose and the tail was noise. Now every entry is something a
 // player deliberately named and kept, so silently deleting the oldest would
 // be destroying their work. Growth is bounded by the per-user solve quota
 // instead, and reads are already capped (solveList ≤ 100, replays ≤ 30).
 scheduleSave({ level: lvl.id });
 res.json({
 id: rec.id,
 num: rec.num,
 visibility: rec.public ? 'public' : rec.unlisted ? 'unlisted' : 'private',
 solves: lvl.solveLog.filter(s => s.won && s.public).length,
 best: levelBest(lvl),
 ...challengeResult,
 });
});

// Everything a freshly saved solve can win, decided here because this is the
// one place a run becomes public. Node runs one turn at a time, so "first"
// needs no lock: the read of `winner` and the write of it are the same tick.
//
// Only a PUBLIC win counts, for both kinds. A private record proves nothing to
// anyone else, and a challenge whose winner nobody can inspect is a rumour.
function settleChallenges(lvl, rec) {
 const out = {};
 if (!rec.won || !rec.public || !rec.byId) return out;

 // the race: first past the post, and never the person who set it
 const race = lvl.race;
 if (race && race.openedAt && !race.winner && race.byId !== rec.byId) {
 race.winner = { name: rec.by, userId: rec.byId, solveId: rec.id, at: Date.now() };
 // the winner's name goes to the FRONT of the description, where it stays
 // for good — the level then carries on as an ordinary level (§11.8)
 lvl.desc = `🏁 First solved by ${rec.by} — ${lvl.desc || ''}`.slice(0, 400).trim();
 const w = db.users[rec.byId];
 if (w) payPrize(w, race.prize | 0, race.by);
 // the message rides along so the win card can quote what it just answered —
 // the bar summaries below carry theirs the same way (challengeSummary)
 out.raceWon = { prize: race.prize | 0, by: race.by, message: race.message };
 }

 // every live bar on this level, oldest first so a run that clears two takes
 // them in the order they were set
 const won = [];
 for (const ch of lvl.challenges || []) {
 if (ch.closedAt) continue;
 if (Date.now() >= ch.endsAt) { closeChallenge(lvl, ch, null); continue; }
 // The challenger publishing their OWN backing solve ends it, stake
 // refunded — the machine behind the bar was the only thing being withheld,
 // so once it's on display there's nothing left to win. (Reachable through
 // the visibility route, not through a fresh save.)
 if (rec.id === ch.solveId) { closeChallenge(lvl, ch, null); continue; }
 if (!qualifies(rec, ch)) continue;
 closeChallenge(lvl, ch, rec);
 // the whole challenge, not just its id: the winner is told what they beat,
 // and they may not have been trying (§11.8)
 won.push(challengeSummary(ch));
 }
 if (won.length) out.challengesWon = won;
 return out;
}

// Star-rate a saved solution, 1–5, one rating per user (re-rating replaces).
// Mirrors level rating exactly, including that you can't rate your own.
app.post('/api/levels/:id/solve/:solveId/rate', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const s = lvl.solveLog.find(x => x.id === req.params.solveId);
 if (!s) return err(res, 404, 'No such solve.');
 if (!s.public) return err(res, 403, 'That solution isn\'t published.');
 if (s.byId && s.byId === user.id) return err(res, 403, 'You can\'t rate your own solution.');
 const v = req.body?.rating;
 if (!num(v) || v < 1 || v > 5) return err(res, 400, 'rating must be 1–5.');
 s.ratings ||= {};
 s.ratings[user.id] = Math.round(v);
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, rating: avgOf(s.ratings), ratingCount: Object.keys(s.ratings).length });
});

// Three-tier visibility for a solve (§ save flow):
// - public: fully searchable/listed — anyone browsing the level sees it.
// - unlisted: not in the level's solve list, but fetchable (replay
// included) by anyone who has the direct #/play/:id/:solveId link.
// - private: invisible to everyone but the owner/admin, even with a
// guessed solve id — GET .../solve/:solveId 404s the same as a bad id.
// GET /api/levels/:id's solveList filter (s.public || own(s) ||
// viewer?.isAdmin) re-evaluates fresh every request, so this takes effect
// for everyone else's view immediately, not just future listings.
app.post('/api/levels/:id/solve/:solveId/visibility', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 if (!user) return err(res, 401, 'Sign in first.');
 const s = lvl.solveLog.find(x => x.id === req.params.solveId);
 if (!s) return err(res, 404, 'No such solve.');
 if (s.byId !== user.id && !user.isAdmin) return err(res, 403, 'Not your solve.');
 const v = req.body?.visibility;
 if (!['public', 'unlisted', 'private'].includes(v)) {
 return err(res, 400, 'visibility must be public, unlisted, or private.');
 }
 // A run backing a LIVE bar has its visibility spoken for ("no change if it
 // is currently a Challenge", 2026-08-07) — but the lock is a ONE-WAY door,
 // not a wall, because PUBLISHING it is already a defined move: it closes
 // the challenge, returns the stake and reveals the machine (settleChallenges
 // below; verify-challenges gate 5 is the concede). What the lock refuses is
 // every OTHER re-filing, and unlisted is the reason it must: a challenge
 // hides the machine until it ends, and "unlisted" would hand out a working
 // link to it while competitors are still paying to guess.
 const backsLive = (lvl.challenges || []).some(c => c.solveId === s.id && !c.closedAt);
 const backsRace = !!(lvl.race && !lvl.race.winner && lvl.race.solveId === s.id);
 if (backsLive || backsRace) {
 const current = s.public ? 'public' : s.unlisted ? 'unlisted' : 'private';
 if (v !== current && v !== 'public') {
 return err(res, 409, backsRace
 ? 'That run is backing the timed challenge — sealed until the race is decided. Publishing it is the only move that re-files it, and that decides the race.'
 : 'That run is backing a live challenge — hiding the machine IS the deal. Publishing it closes the challenge and returns your stake; nothing else re-files it.');
 }
 }
 const wasPublic = !!s.public;
 s.public = v === 'public';
 s.unlisted = v === 'unlisted';
 // Publishing an OLD solve is the second door to "a run became public", and
 // for challenges it counts exactly like saving a new one: without this, a
 // qualifying run could be saved privately during a challenge and published
 // the moment it ended, winning nothing and beating the bar in plain sight.
 // Same rule for the race, whose winner is defined as the first solve saved
 // PUBLICLY — the moment it becomes public is that moment.
 const settled = !wasPublic && s.public ? settleChallenges(lvl, s) : {};
 scheduleSave({ level: lvl.id });
 res.json({ ok: true, visibility: v, ...settled });
});

// Dedicated single-solve fetch (replay included) for the direct-link case —
// separate from the level page's general solveList so an unlisted solve is
// reachable by its own URL without ever appearing in that general listing.
app.get('/api/levels/:id/solve/:solveId', (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const viewer = userFromReq(req);
 const s = lvl.solveLog.find(x => x.id === req.params.solveId);
 if (!s) return err(res, 404, 'No such solve.');
 const own = viewer && s.byId === viewer.id;
 // private (default): 404 rather than 403, so a guessed id can't even
 // confirm a solve exists there (matches the unpublished-level pattern)
 if (!s.public && !s.unlisted && !own && !viewer?.isAdmin) return err(res, 404, 'No such solve.');
 res.json({
 id: s.id, num: s.num, by: s.by, byId: s.byId, won: s.won, time: s.time, pieces: s.pieces,
 basedOn: s.basedOn, // remix credit — the preroll card says "after <name>", §11.3
 kg: s.kg, wood: s.wood, water: s.water, wheels: s.wheels,
 poweredWheels: s.poweredWheels, untampered: s.untampered, nailedIt: s.nailedIt, boomerang: s.boomerang, sweep: s.sweep,
 maxPinWeight: s.maxPinWeight,
 escaped: !!s.escaped,
 at: s.at, public: s.public, unlisted: !!s.unlisted, comment: s.comment,
 commentUp: Object.values(s.commentVotes || {}).filter(x => x > 0).length,
 commentDown: Object.values(s.commentVotes || {}).filter(x => x < 0).length,
 yourCommentVote: viewer ? (s.commentVotes?.[viewer.id] || 0) : 0,
 // from the designs table (storage.mjs v2) — the record itself carries
 // only hasDesign, and pre-split records that never had one return null
 ...(s.hasDesign ? (store.getDesign(s.id) || {}) : {}),
 });
});

app.post('/api/levels/:id/solve/:solveId/comment', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = userFromReq(req);
 const s = lvl.solveLog.find(x => x.id === req.params.solveId);
 if (!s) return err(res, 404, 'No such solve.');
 const comment = String(req.body?.comment || '').slice(0, 128);
 if (s.byId) {
 if (!user || user.id !== s.byId) return err(res, 403, 'Not your solve.');
 } else if (s.comment != null) {
 return err(res, 403, 'Anonymous solve notes can only be set once.');
 }
 s.comment = comment;
 scheduleSave({ level: lvl.id });
 res.json({ ok: true });
});

// A solve's note is a comment like any other — same voting rules as the level
// comments above, on the same shape of `votes` map, so "thumbs on comments"
// means every comment and not just the ones under the level.
app.post('/api/levels/:id/solve/:solveId/comment/vote', writeLimit, (req, res) => {
 const lvl = findLevel(req, res);
 if (!lvl) return;
 const user = requireWritable(req, res);
 if (!user) return;
 const s = lvl.solveLog.find(x => x.id === req.params.solveId);
 if (!s) return err(res, 404, 'No such solve.');
 if (!s.comment) return err(res, 400, 'That solve has no note to vote on.');
 if (s.byId && s.byId === user.id) return err(res, 403, 'You cannot vote on your own note.');
 const v = req.body?.vote;
 if (![1, -1, 0].includes(v)) return err(res, 400, 'vote must be 1, -1 or 0.');
 s.commentVotes ||= {};
 // pressing the same thumb again takes it back, exactly like a level comment
 if (v === 0 || s.commentVotes[user.id] === v) delete s.commentVotes[user.id];
 else s.commentVotes[user.id] = v;
 scheduleSave({ level: lvl.id });
 res.json({
 ok: true,
 score: avgOf(s.commentVotes),
 up: Object.values(s.commentVotes).filter(x => x > 0).length,
 down: Object.values(s.commentVotes).filter(x => x < 0).length,
 yours: s.commentVotes[user.id] || 0,
 });
});

// The bench (named machine slots, synced per account) was retired: saving a
// machine now goes through the ordinary solve save, which already offers this
// device / private / unlisted / published. Its routes, table and rows are all
// gone; the last contents were archived to data/bench-archive-*.json first.

// ---------- start ----------

loadDb();
// HOST=127.0.0.1 behind a TLS proxy on the same box: without it the app also
// answers on the public interface over plain HTTP, and everything the
// certificate was for is bypassable by asking for :3000 directly. Left at
// 0.0.0.0 by default because a container or PaaS has to receive traffic from
// outside itself — the deploy/lifirik.service unit pins it to loopback.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
 console.log(`LIFIRIK listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
 + (HOST === '0.0.0.0' ? ' (all interfaces — set HOST=127.0.0.1 when a proxy fronts this)' : ''));
});
