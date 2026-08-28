// invite.mjs — create an account for someone you actually know.
//
// The only other way to make a user is the public register route, which is
// closed while the game is invite-only (REGISTRATION=closed), and hand-editing
// the store is how you end up with a half-formed user record that crashes a
// route three weeks later. This builds the same record the server builds.
//
//   node scripts/invite.mjs ada                 # a level author
//   node scripts/invite.mjs ada --admin         # ... who can also moderate/curate
//   node scripts/invite.mjs ada --password xyz  # if they gave you one
//
// RUN WITH THE SERVER STOPPED. It holds the whole store in memory and would
// write its own copy back over this (§16).
//
// FOUNDER ACCOUNTS ARE FREE FOREVER. Everyone invited now is building the thing
// that gets sold later, so they're marked subscribed with a premiumUntil far
// past any plausible paywall. Doing it at creation costs one line; doing it
// afterwards means finding the right five accounts in a database, from memory,
// under pressure.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';
import { hashPassword, newSalt, generatePassword, reservedName } from '../auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');

// same rule the register route enforces (§12) — an account that can't sign in
// through the normal form is worse than no account
const NAME_RE = /^[\w][\w \-.]{1,18}[\w]$/;
const DEFAULT_LIMITS = { levels: 100, solves: 1000, comments: 1000 };
const FOREVER = Date.parse('2100-01-01T00:00:00Z');
const WELCOME_POINTS = 100;   // must match server.js's constant (§11.5)

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const name = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--password');

if (!name) {
  console.error('usage: node scripts/invite.mjs <name> [--admin] [--moderator] [--password <pw>] [--force]');
  process.exit(1);
}
if (!NAME_RE.test(name)) {
  console.error(`"${name}" isn't a usable name: 3–20 characters, letters/digits/space/-/./_, not starting or ending with punctuation.`);
  process.exit(1);
}
// Reserved names (auth.mjs) are refused HERE too — this script is the other
// door onto the user table, and a rule only the HTTP route knows is a rule
// with a hole in it. `--force` is the deliberate override: minting the
// site's own staff account is precisely what that looks like, and somebody
// typing it has said out loud that they meant this name.
{
  const word = reservedName(name);
  if (word && !flag('--force')) {
    console.error(`"${name}" is a reserved name (it reads as "${word}"). Pass --force if you mean to mint it deliberately.`);
    process.exit(1);
  }
  if (word) console.log(`  note      "${name}" is reserved — minting it anyway (--force)\n`);
}

const password = valueOf('--password') || generatePassword();
if (password.length < 4) { console.error('password must be at least 4 characters'); process.exit(1); }

const store = openStore(DB_PATH);
const db = store.readAll();

const nameLower = name.toLowerCase();
if (Object.values(db.users).some(u => u.nameLower === nameLower)) {
  console.error(`"${name}" already exists. Names are unique case-insensitively.`);
  store.close();
  process.exit(1);
}

const salt = newSalt();
const user = {
  id: crypto.randomBytes(8).toString('base64url'),
  name, nameLower, salt, hash: hashPassword(password, salt),
  createdAt: Date.now(),
  isAdmin: flag('--admin'),
  isModerator: flag('--admin') || flag('--moderator'),
  // same welcome grant a self-registered account gets (server.js WELCOME_POINTS
  // — kept in step by hand, since this script deliberately doesn't import the
  // server). A challenge prize costs at least 1 point, so an account that
  // opened on nothing couldn't set one on its first day.
  points: WELCOME_POINTS,
  pointsLog: [{ delta: WELCOME_POINTS, reason: 'welcome', at: Date.now() }],
  lastActiveDate: null, lastMonthlyGrant: null,
  // free forever — see the note at the top
  subscribed: true, premiumUntil: FOREVER,
  limits: { ...DEFAULT_LIMITS },
  status: 'active',
};
db.users[user.id] = user;
store.importAll(db);

// read it back: "no exception" is not the same as "the account is in there"
const check = store.readAll().users[user.id];
store.close();
if (!check || check.nameLower !== nameLower) {
  console.error('FATAL: the account did not read back after writing.');
  process.exit(1);
}

const role = user.isAdmin ? 'admin' : user.isModerator ? 'moderator' : 'level author';
console.log('');
console.log(`  account   ${name}   (${role})`);
console.log(`  password  ${password}`);
console.log('');
console.log('  Free forever (subscribed, premium until 2100) — they are building the product.');
console.log('  This password is not stored anywhere in readable form. Send it now, or run');
console.log('  the script again with a different name; there is no way to look it up later.');
console.log('');
