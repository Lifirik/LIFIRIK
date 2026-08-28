// seed-official-levels.js — wipe + republish the official campaign.
//
// Geometry and campaign headings live in scripts/campaign-seed.json (the
// curated live campaign). RUN WITH THE SERVER STOPPED — the in-memory db
// and debounced save would overwrite this edit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';
import { hashPassword, newSalt } from '../auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const DB_PATH = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'campaign-seed.json'), 'utf8'));
const SEED_LEVELS = SEED.levels;
const SEED_CAMPAIGNS = SEED.campaigns || [];

const uid = () => crypto.randomBytes(8).toString('base64url');

function levelPreview(data) {
  return {
    terrain: data.terrain || [],
    backLevel: data.backLevel,
    props: data.props || [],
    fixedParts: data.fixedParts || [],
    texts: data.texts || [],
    pins: data.pins || [],
    buildZones: data.buildZones || [],
    goalZones: data.goalZones || [],
    goalObjs: data.goalObjs || [],
    background: data.background,
    backScale: data.backScale, backAlpha: data.backAlpha,
  };
}

const store = openStore(DB_PATH);
const db = store.readAll();

const force = process.argv.includes('--force');
{
  const officials = Object.values(db.levels).filter((l) => l.official);
  const solves = officials.reduce((n, l) => n + (l.solveLog?.length || 0), 0);
  const moved = officials.filter((l) => l.seedSlot != null && l.seedSlot !== l.slot).length;
  const countOff = officials.length && officials.length !== SEED_LEVELS.length;
  if (!force && (solves || moved || countOff)) {
    console.error('REFUSING to re-seed — this would delete the campaign and rebuild it.');
    if (solves) console.error(`  ${solves} solve(s) on campaign levels would be destroyed, with their replays.`);
    if (countOff) console.error(`  the campaign holds ${officials.length} level(s); the seed has ${SEED_LEVELS.length}.`);
    if (moved) console.error(`  ${moved} level(s) have been moved to a different number by an admin.`);
    console.error('');
    console.error('The Admin screen\'s # column is how you reorder the campaign without losing any of that.');
    console.error('Re-run with --force if wiping it really is what you want.');
    process.exit(1);
  }
}

let wiped = 0;
for (const [id, lvl] of Object.entries(db.levels)) {
  if (lvl.official) { delete db.levels[id]; wiped++; }
}

const used = new Set(Object.keys(db.levels));
SEED_LEVELS.forEach((seed, slot) => {
  const stamped = JSON.parse(JSON.stringify(seed.data));
  let id = seed.id && !used.has(seed.id) ? seed.id : uid();
  used.add(id);
  db.levels[id] = {
    id,
    name: seed.name,
    author: 'LIFIRIK',
    desc: seed.desc || '',
    hint: seed.hint || '',
    data: stamped,
    preview: levelPreview(stamped),
    createdAt: Date.now() - (SEED_LEVELS.length - slot) * 1000,
    plays: 0,
    ratings: {},
    difficulties: {},
    comments: [],
    solveLog: [],
    official: true,
    slot,
    seedSlot: slot,
    num: slot + 1,
  };
});

db.campaigns = {};
for (const c of SEED_CAMPAIGNS) {
  db.campaigns[c.id] = JSON.parse(JSON.stringify(c));
}

db.users ||= {};
const hasDefaultAdmin = Object.values(db.users).some((u) => u.nameLower === 'lifirik');
if (!hasDefaultAdmin) {
  const salt = newSalt();
  const id = uid();
  db.users[id] = {
    id,
    name: 'LIFIRIK',
    nameLower: 'lifirik',
    salt,
    hash: hashPassword('changeme!', salt),
    createdAt: Date.now(),
    isAdmin: true,
    isModerator: true,
    points: 100,
    pointsLog: [{ delta: 100, reason: 'welcome', at: Date.now() }],
    lastActiveDate: null,
    lastMonthlyGrant: null,
    subscribed: true,
    premiumUntil: Date.parse('2100-01-01T00:00:00Z'),
    limits: { levels: 1000, solves: 10000, comments: 1000 },
    status: 'active',
  };
}

store.importAll(db);
const check = store.readAll();
store.close();
if (Object.values(check.levels).filter(l => l.official).length !== SEED_LEVELS.length) {
  console.error('FATAL: officials did not read back after writing.');
  process.exit(1);
}
console.log(`seeded ${SEED_LEVELS.length} official levels and ${SEED_CAMPAIGNS.length} campaign(s) (${wiped} old officials wiped) → ${DB_PATH}`);
if (!hasDefaultAdmin) {
  console.log('default admin  LIFIRIK  /  changeme!   (change this after first sign-in)');
}
