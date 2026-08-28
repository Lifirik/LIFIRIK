// set-role.mjs — make an existing account an admin or a moderator (§13).
//
//   node scripts/set-role.mjs ada --admin           # grant
//   node scripts/set-role.mjs ada --no-admin        # revoke
//   node scripts/set-role.mjs ada --moderator
//   node scripts/set-role.mjs ada --no-moderator
//   node scripts/set-role.mjs                       # just list who has what
//
// THE GAP THIS FILLS. `invite.mjs --admin` can only mint a NEW admin, and the
// admin page's right-click roles menu needs an admin to reach it — so an
// install whose one admin account is lost, or whose first admin was created
// without the flag, had no way in at all. The README's answer was a five-step
// round trip (`db:export` → hand-edit the JSON → move it over `db.json` →
// delete `db.sqlite*` → restart to re-import) which deletes the database on
// the way to changing one boolean.
//
// `isAdmin` implies every moderator power, so `--moderator` only matters on an
// account that is NOT an admin (server.js's requireModerator). Setting both is
// allowed and harmless — it is what you want if you plan to take Admin away
// later and leave the moderator behind.
//
// THE LAST ADMIN IS PROTECTED. Revoking the only admin leaves a site nobody can
// administer, and the only way back is this script — which is fine, but it
// should be a decision rather than a slip, so it needs `--force`. The web UI
// refuses the same thing more bluntly: you cannot change your own roles there.
//
// RUN WITH THE SERVER STOPPED. It holds the whole store in memory and would
// write its own copy back over this (§16).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.LIFIRIK_DB || path.join(root, 'data', 'db.sqlite');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const name = args.find((a) => !a.startsWith('--'));

const store = openStore(DB_PATH);
const db = store.readAll();
const users = Object.values(db.users || {});

const roleOf = (u) => (u.isAdmin ? 'admin' : u.isModerator ? 'moderator' : '—');
const listAll = () => {
  console.log('\n  account            role');
  for (const u of users.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${u.name.padEnd(18)} ${roleOf(u)}`);
  }
  console.log(`\n  ${users.filter((u) => u.isAdmin).length} admin(s), ${users.filter((u) => u.isModerator).length} moderator(s)`);
};

if (!name) {
  console.log('usage: node scripts/set-role.mjs <name> [--admin|--no-admin] [--moderator|--no-moderator] [--force]');
  listAll();
  store.close();
  process.exit(0);
}

const user = users.find((u) => u.nameLower === name.toLowerCase());
if (!user) {
  console.error(`No account called "${name}". Names are matched case-insensitively.`);
  console.error('Existing accounts: ' + users.map((u) => u.name).join(', '));
  store.close();
  process.exit(1);
}

const want = {};
if (flag('--admin')) want.isAdmin = true;
if (flag('--no-admin')) want.isAdmin = false;
if (flag('--moderator')) want.isModerator = true;
if (flag('--no-moderator')) want.isModerator = false;

if (!Object.keys(want).length) {
  console.log(`\n  ${user.name}: ${roleOf(user)}`);
  console.log('  (pass --admin / --no-admin / --moderator / --no-moderator to change it)');
  listAll();
  store.close();
  process.exit(0);
}

// the guard: don't let the last admin be revoked by accident
if (want.isAdmin === false && user.isAdmin) {
  const others = users.filter((u) => u.isAdmin && u.id !== user.id);
  if (!others.length && !flag('--force')) {
    console.error(`\n  "${user.name}" is the ONLY admin. Revoking it leaves nobody who can`);
    console.error('  administer the site, and this script is the only way back.');
    console.error('  Promote somebody else first, or pass --force if you mean it.\n');
    store.close();
    process.exit(1);
  }
}

const before = roleOf(user);
const changed = [];
for (const [k, v] of Object.entries(want)) {
  if (!!user[k] === v) continue;
  // absent rather than false, the same way the rest of the store stores a
  // default — a user record carrying `isAdmin: false` reads as a decision
  if (v) user[k] = true; else delete user[k];
  changed.push(`${k} → ${v}`);
}

if (!changed.length) {
  console.log(`\n  ${user.name} is already ${before}. Nothing to do.`);
  store.close();
  process.exit(0);
}

store.importAll(db);
store.close();

console.log(`\n  ${user.name}: ${before} → ${roleOf(user)}   (${changed.join(', ')})`);
if (want.isAdmin === true) console.log('  Admins get: users, levels, solves, curation, and every moderator power.');
console.log('  They will see it on their next page load — sessions are untouched.\n');
