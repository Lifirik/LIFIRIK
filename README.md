# LIFIRIK

A 2D physics contraption-building game. Build a machine from **wheels** and
**rods** inside a **build zone**, press Play, and deliver every green **goal
piece** into a **goal zone**. Official campaign (31 levels, two sets), a level
maker, a community workshop with timed and beat-my-score challenges, accounts,
deterministic solve replays, and badges.

Zones that touch or overlap count as **one region**. A gap between them is a
gap nothing may bridge. Mark a terrain boulder a **planet** and the whole
level goes radial: pieces rest on every side of it, wheels drive around it, a
sideways launch orbits. Two planets give you a neutral line to cross.

The name is a made-up word: *a dynamic, repeating mechanism governed solely by
the physical laws of force and motion* (**L**ift + em**pIRI**c + Kinemat**IK**).

**How to play, make levels, GhostRun, and tweaking:**
[Instructions.md](Instructions.md). In the app, **?** is the same material
(`/learn`, `/learn/maker`, `/learn/advanced`, `/learn/fc`). Every key and
click is on `/keys`.

The `§n` tags in comments are stable internal rule identifiers — two sites
citing the same `§n` implement the same rule. Treat them as cross-references,
not citations.

## Run it

Unzip anywhere. You need [Node.js](https://nodejs.org/) 22 or newer.

**This PC only:** double-click `SetupForLocalPlayServer.bat`, then open
http://localhost:3000

Sign in as **LIFIRIK** / **changeme!** (created on first seed). Change that
password.

**The internet (Windows):** install [Caddy](https://caddyserver.com/docs/install#windows),
put your domain in `Caddyfile` (replace `lifirik.example`), point DNS at this
PC, forward ports 80 and 443, then double-click `SetupForInternetServer.bat`.
Later updates: `DEPLOY.bat`. Later restarts: `Production\GOLIVE.bat`.

```bash
npm install          # express + esbuild (build only); physics is vendored fcsim.wasm
npm run seed         # install/reset the official campaign (server STOPPED)
npm start            # http://localhost:3000
```

Development serves `public/` straight off disk — no build step, edit and
reload. `npm run build` is only for deploying.

**Reload after editing client code.** The app is a single page: opening
another level in an open tab re-renders without re-fetching a module. If the
files have changed under it (on tab refocus), a pill appears bottom-left
offering a reload; dismissing it is per-build.

- **Physics:** Fantastic Contraption's Box2D 2.x, compiled to
  `public/vendor/fcsim/fcsim.wasm`. Every client runs that bit-identical
  binary — the file **is** the determinism contract. Upgrading it breaks
  recorded solve times.
- **Server:** Node + Express, SQLite (`data/db.sqlite`) held in memory and
  written row-by-row (`storage.mjs`). Auth and write routes are rate limited.
  HTTPS is terminated by the proxy in front. No mail, so no self-service
  password reset: `node scripts/set-password.mjs <name>` rotates the salt and
  signs that account out everywhere. Edit the store only with the server
  stopped.
- **Client:** vanilla ES modules, Canvas 2D. `npm run build` bundles and
  minifies for deployment.

## Verification

`DEPLOY.bat` runs this set, all of them, **before** anything live is stopped:

```bash
node scripts/verify.mjs              # determinism, joints, contact, terrain, deliveries
node scripts/verify-editor.mjs       # placement, drags, containment (no wasm)
node scripts/verify-surfaces.mjs     # grip, bounce, conveyor belts
node scripts/verify-zones.mjs        # touching zones are one region
node scripts/verify-audio.mjs        # sound, and that listening changes nothing
node scripts/verify-validation.mjs   # the publish gate (scratch DB)
node scripts/verify-tutorial.mjs     # /learn demos still win
node scripts/verify-challenges.mjs   # challenges, prizes, badges, records
node scripts/verify-ownership.mjs    # who may delete, who may write
node scripts/verify-admin.mjs        # passwords, roles, editable text, tuning
node scripts/verify-i18n.mjs         # the nine languages against the copy
node scripts/verify-fcworld.mjs      # FC-imported levels, both build paths
node scripts/verify-ghostrun.mjs     # GhostRun overlay, pin sweep, scoring
```

Also there, not in the deploy list: `verify-pins`, `verify-gfx`,
`verify-axles`, `verify-ghostprops`.

Every suite takes the same flags (`scripts/gatekit.mjs`):

```bash
node scripts/verify-editor.mjs --only 76b     # one gate
node scripts/verify-pins.mjs --only knockout  # or match on the gate's words
node scripts/verify-editor.mjs --list         # every gate's id and name
node scripts/verify-editor.mjs --times        # the slowest ids
node scripts/verify.mjs --quiet               # failures only
```

`--only` is an exact id or any substring of a gate's name, and is repeatable.
A filter that matches nothing exits **2** — a typo must never read as a pass.
None of these touch `data/`; server-backed suites spawn their own process
against a scratch database.

## Layout

```
SetupForLocalPlayServer.bat     unzip → http://localhost:3000
SetupForInternetServer.bat      unzip → public HTTPS on this Windows PC
DEPLOY.bat                      later updates of Production/
GOLIVE.bat                      start/restart the folder it sits in (live: PORT 3232)
server.js                       Express app + REST API
auth.mjs                        password hashing — one place
storage.mjs                     SQLite — row writes, WAL, backups
ratelimit.mjs                   in-memory limiter (auth + writes)
Caddyfile                       TLS terminator for the Windows public site
deploy/                         Linux Caddyfile + systemd unit
engine/                         Box2D / fcsim sources (the wasm is already built)
scripts/
  build.mjs                     production build → dist/
  campaign-seed.json            the curated campaign
  seed-official-levels.js       wipe + republish it (server stopped)
  invite.mjs / set-password.mjs / set-role.mjs
  deploy.ps1                    what DEPLOY.bat actually runs
  verify*.mjs                   the gates above
public/                         the client (vanilla ES modules + fcsim.wasm)
data/db.sqlite                  entire datastore — gitignored, not for the repo
```

Player-facing copy lives in `public/js/content.js` (editable from Admin ▸ Text)
and in [Instructions.md](Instructions.md).

## Deploying it

**First time on this Windows PC:** `SetupForInternetServer.bat`. It builds
`Production/`, copies the campaign database in, and starts Caddy + Node. The
public site is HTTPS; Node itself listens on `127.0.0.1:3232`.

**Later updates:** `DEPLOY.bat` from this folder. It ships `dist/` into
`Production/` and pulls the live database back here. Do not point `-LP` at
the source folder — the clean sweep would replace it with the built copy.

| | |
|---|---|
| `SetupForInternetServer.bat` | first-time public site |
| `DEPLOY.bat` | later updates (gates, build, copy, pull data) |
| `DEPLOY.bat -SkipTests` | emergencies only — ships without the gates |
| `DEPLOY.bat -NoPull` | ship code, leave the dev database alone |
| `Production\GOLIVE.bat` | start the live site from cold, deploy nothing |

Everything expensive — the suites, then the build — happens **before**
anything is stopped. A red gate or a failed build leaves the live site up.
The outage is the copy, and it is measured in seconds.

Two details that are easy to get wrong, handled in
[`scripts/deploy.ps1`](scripts/deploy.ps1):

- **The database comes back by `VACUUM INTO`, never a file copy.** With WAL
  on, the newest commits live in the `-wal` sidecar. A plain copy of
  `db.sqlite` silently drops the newest writes.
- **The push is a clean sweep, not a paste-over.** `dist/` has no
  `public/js`, so copying it *onto* a tree that has one leaves the old
  readable source in place and still served. `Production/data` and
  `Production/node_modules` are the only things kept.

For a Linux box:

```bash
npm run build        # → dist/  (bundled, minified, no source, no data)
rsync -a --delete dist/ you@box:/srv/lifirik/
ssh you@box 'cd /srv/lifirik && npm ci --omit=dev && node scripts/seed-official-levels.js'
```

Then TLS and supervision, both in [`deploy/`](deploy/):

| file | what it does |
|---|---|
| `deploy/Caddyfile` | HTTPS (Let's Encrypt), compression, security headers, proxy to `127.0.0.1:3000` |
| `deploy/lifirik.service` | systemd — restarts on failure, `TRUST_PROXY=1`, `HOST=127.0.0.1` |

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # edit the domain first
sudo cp deploy/lifirik.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lifirik caddy
```

Four things that matter more than the rest:

- **Terminate HTTPS in front, and bind the app to loopback.** Passwords are
  posted in the clear otherwise. `HOST=127.0.0.1` is what stops the app
  *also* answering on the public interface over plain HTTP. It defaults to
  `0.0.0.0` because a container has to accept outside traffic; the systemd
  unit pins it.
- **`TRUST_PROXY=1` only when a proxy really is in front.** Off behind one,
  every visitor shares a rate-limit bucket; on without one, anyone spoofs
  `X-Forwarded-For` and the limits do nothing. `RATE_LIMIT_DISABLED=1` turns
  limiting off for local work.
- **One process, one disk.** SQLite on local disk, held in memory. Not
  scale-to-zero, and not two replicas — they would overwrite each other.
- **Back up `data/`.** Nothing else on the box is irreplaceable. Copy
  `data/db.sqlite` (server stopped, or after a checkpoint) and keep the copy
  off the box.

Compression is Caddy's job (`encode zstd gzip`), not the app's.

## Invite-only (closed alpha)

A fresh seed creates admin **LIFIRIK** / **changeme!**. Change it, especially
on a public box.

```bash
node scripts/invite.mjs ada --admin      # server STOPPED; prints the password once
node scripts/set-password.mjs LIFIRIK    # server STOPPED; reset a forgotten one
REGISTRATION=closed npm start            # public sign-up returns 403
```

Invited accounts are marked free forever (`subscribed`, premium to 2100).

**`REGISTRATION=closed` is the second lock, not the first.** Anonymous play
needs no account, so a closed register route still leaves everything readable
to anyone with the URL. The real gate goes in front, in the Caddyfile:

```caddyfile
basic_auth {
    alpha $2a$14$...        # generate with: caddy hash-password
}
```

An admin can ★ any community level from the Workshop. Featured levels survive
a full re-seed; the campaign slots do not — `npm run seed` wipes and re-stamps
them from `scripts/campaign-seed.json`.

## What must not leave the box

MIT — see [LICENSE](LICENSE). The game code may be copied. **`data/db.sqlite`
may not**: password hashes, per-user salts, live session tokens, email
addresses. It is `.gitignore`d. Committing it once puts real credentials in
the history permanently.

The server does not serve anything outside `public/` over HTTP:
`express.static` is mounted on `public/` alone, and `/server.js`,
`/data/db.sqlite`, `/package.json`, `/scripts/deploy.ps1` and traversal
attempts (`/../`, `%2e%2e`) all 404. Re-check this after touching any route.

## Operator notes

- **Roles.** Admin page, right-click a row in Users: **Admin** and
  **Moderator**. You cannot change your own roles there — an admin who
  unticks their own box cannot tick it back.

  ```bash
  node scripts/set-role.mjs ada --admin        # or --no-admin / --moderator
  node scripts/set-role.mjs                    # list who has what
  ```

  Revoking the last admin needs `--force`. Server stopped.

- Anonymous play works everywhere. Accounts add attribution, profiles, and
  cross-device bench sync.
- Import (`/import`) turns FC-format level text into a LIFIRIK draft in the
  Maker. Same conversion: `POST /api/import/fc`.
- Deleting is private-only. A public or unlisted level has been played by
  other people; unpublish it instead. Local saves delete outright.
- Points shop is off by default (`TEST_ECONOMY=0`). Purchases are fake when
  it is on; no payment processor exists.
- To reset the whole install: stop the server, delete `data/db.sqlite*`, run
  `npm run seed`.
