# LIFIRIK

A 2D physics contraption-building game: build machines out of **wheels** and
**rods** inside a **build zone**, press Play, and deliver every pink **goal
piece** into the **goal zone**. Ships with a 31-level campaign in two sets, a level maker, a
community workshop with timed and beat-my-score challenges, accounts, deterministic
solve replays, and badges.

A level may have several of either zone. **Zones that touch or overlap count as
one region** — a piece may span the whole of it — while zones with space between
them stay separate and nothing may bridge the gap (§7.2a).

Down is not always down: mark a terrain boulder a **planet** and the whole level
goes radial — pieces rest on every side of it, wheels drive around it, and a
sideways launch orbits. Two planets give you a neutral line to cross (§5.10).

The name is a made-up word: *a dynamic, repeating mechanism governed solely by
the physical laws of force and motion* (**L**ift + em**pIRI**c + Kinemat**IK**).

A note on reading the code: the `§n` tags scattered through comments are
stable internal rule identifiers — two sites citing the same `§n` implement
the same rule, and the tag is how they find each other. Treat them as
cross-references, not citations.

## Run it

Unzip anywhere. You need [Node.js](https://nodejs.org/) 22 or newer.

**This PC only:** double-click `SetupForLocalPlayServer.bat`, then open http://localhost:3000

Sign in as **LIFIRIK** / **changeme!** (created on first seed). Change that password.

**The internet (Windows):** install [Caddy](https://caddyserver.com/docs/install#windows), put your domain in `Caddyfile` (replace `lifirik.example`), point DNS at this PC, forward ports 80 and 443, then double-click `SetupForInternetServer.bat`. Later updates: `DEPLOY.bat`. Later restarts: `Production\GOLIVE.bat`.

```bash
npm install          # express + esbuild (build only); physics is vendored fcsim.wasm
npm run seed         # install/reset the official campaign (server STOPPED)
npm start            # http://localhost:3000
```

Development serves `public/` straight off disk — no build step, edit and reload.
`npm run build` is only for deploying (see below).

**Reload after editing client code.** The app is a single page: opening another
level in an open tab re-renders the screen without re-fetching a single
module — the tab keeps running the code it started with. If it notices the files
have changed under it (on tab refocus), a small pill appears bottom-left offering
a reload; dismissing it is per-build.

- **Physics**: FC's Box2D 2.x, compiled to `public/vendor/fcsim/fcsim.wasm`.
  Every client runs the bit-identical binary: that file **is** the determinism
  contract. Upgrading it is a breaking event for recorded solve times.
- **Server**: Node + Express, SQLite (`data/db.sqlite`) as the whole datastore,
  held in memory and written row-by-row (`storage.mjs`). Auth and write routes
  are rate limited. HTTPS is terminated by the proxy in front (see Deploying it).
  No SELF-SERVICE password reset (no mail is ever sent) — the owner of the box
  resets one with `node scripts/set-password.mjs <name>`, which rotates the salt
  and signs that account out everywhere. Edit the store only with the server
  stopped.
- **Client**: vanilla ES modules, no build step in development. Canvas 2D
  rendering. `npm run build` bundles and minifies for deployment.

## Verification (§15 acceptance gates)

```bash
node scripts/verify.mjs             # determinism, joints, pitching, rim-pin, contact, painted terrain, fast deliveries
node scripts/verify-validation.mjs  # the publish gate, on a real server + scratch DB
node scripts/verify-challenges.mjs  # challenges, prizes, badge rules and level records
node scripts/verify-admin.mjs       # passwords, roles, editable text, tuning dials
node scripts/verify-zones.mjs       # zones that touch are one region; drag-obstacle geometry
node scripts/verify-ownership.mjs   # what an author may delete, and who may write a hint
node scripts/verify-editor.mjs      # the editor's drag/placement/containment rules on GameScreen
node scripts/verify-surfaces.mjs    # terrain surface materials: grip, bounce, conveyor belts
node scripts/verify-audio.mjs       # sound: hit events, materials, and that listening changes nothing
node scripts/verify-tutorial.mjs    # the /learn page's live demos must WIN (cart, flying-crate catapult)
node scripts/verify-pins.mjs        # the wheel pin lattice and the dots/groove switch
node scripts/verify-gfx.mjs         # the graphics style table and its read-and-repair
```

Every suite shares `scripts/gatekit.mjs`, so every suite takes the same flags:

```bash
node scripts/verify-editor.mjs --only 76b     # one gate: 0.6s, not 9.6s
node scripts/verify-pins.mjs --only knockout  # or match on the gate's words
node scripts/verify-editor.mjs --list         # every gate's id and name
node scripts/verify-editor.mjs --times        # the slowest ids, to find what to wrap
node scripts/verify.mjs --quiet               # failures only
```

`--only` takes an exact id or any substring of a gate's name, and is repeatable.
A filter that matches nothing exits **2** rather than 0 — a typo must never read
as a pass. Gates wrapped in `section()` are skipped whole, which is where the
speed comes from: `--only` on the editor suite is 0.6s against 9.6s for the lot.

The first two must pass after **any** change to physics constants, piece sizes, or the
Box2D binary; the two server-backed ones after anything that touches the API, the
store or the badge/challenge rules; `verify-zones.mjs` after anything that touches
build/goal zone containment; `verify-editor.mjs` after anything in `game.js` that
moves, places or validates a piece; `verify-surfaces.mjs` after anything touching
terrain materials or the texture list; `verify-audio.mjs` after anything touching
the sound layer or the hit-event plumbing; `verify-tutorial.mjs` after any physics
retune (its machines are the tutorial); `verify-admin.mjs` after anything touching
passwords, roles, the editable text or the tuning dials; `verify-pins.mjs` after
anything touching the wheel pin lattice or the pin styles. All twelve are fast and none
of them touch `data/`
— the server-backed ones spawn their own process against a scratch database, and
`verify-editor.mjs` needs no server, no database and no wasm at all.

## Layout

```
SetupForLocalPlayServer.bat     unzip -> http://localhost:3000
SetupForInternetServer.bat      unzip -> public HTTPS on this Windows PC
DEPLOY.bat                      later updates of Production/
GOLIVE.bat                      start/restart the folder it sits in (live: PORT 3232)
server.js                       Express app + REST API
scripts/build.mjs               production build -> dist/ (esbuild)
scripts/invite.mjs              create an account (invite-only alpha)
scripts/set-password.mjs        reset one's password (rotates the salt, signs them out)
auth.mjs                        password hashing — one place: server, invite, reset
deploy/                         Caddyfile (TLS) + systemd unit
storage.mjs                     SQLite datastore — row writes, WAL, backups
ratelimit.mjs                   in-memory request limiter (auth + writes)
db-file.mjs                     temp file + fsync + atomic rename (JSON export)
data/db.sqlite                  entire datastore (levels, users, sessions, bench)
scripts/
  seed-official-levels.js       wipes + republishes the official campaign (server stopped!)
  campaign-seed.json            the curated campaign (levels + headings)
  verify.mjs                    §15 gates 1,2,4,5,6,8,10,13,18 (headless harness)
  verify-validation.mjs         §15 gate 7 (the publish gate, real server)
  verify-challenges.mjs         §15 gate 9 (challenges, prizes, badges, records)
  verify-zones.mjs              §15 gate 11 (zone regions + drag obstacles)
  verify-ownership.mjs          §15 gate 12 (delete rules, hint authoring)
  verify-editor.mjs             §15 gates 13,14,18,19,20 (editor drags, sweeps, resting places)
  verify-surfaces.mjs           §15 gate 15 (terrain surface materials, grip/bounce/belt)
  verify-audio.mjs              §15 gate 16 (sound, and its non-effect on the sim)
  verify-tutorial.mjs           §15 gate 17 (the tutorial's live demos must win)
  verify-admin.mjs              §15 gate 19 (passwords, roles, editable text, dials)
  deploy.ps1 + pull-live-db.mjs  DEPLOY.bat: ship dist/ to live, pull live data back
public/
  index.html  style.css         shell + all styling (design tokens; --teal is violet)
  vendor/fcsim/                 pinned fcsim.wasm (the only vendored dependency)
  js/
    main.js                     path router + every screen
    game.js                     GameScreen — canvas, HUD, editor, play loop
    sim.js                      Simulation — builds & steps the Box2D world
    render.js                   all canvas drawing
    camera.js                   world↔screen transform
    levels.js                   PAGES + SETS + SEED_LEVELS fixtures + newMakerLevel()
    content.js                  every long-form string: key, shipped default, and
                                  the tiny markup admins type into Admin > Text (§13.1)
    fcimport.js                 FC-format level text → LIFIRIK level data (shared
                                  with server.js; §14)
    sizes.js                    how small a piece may get — 1 px per axis AND
                                  10 px² area, ball r 2 (§4; editor + import)
    surfaces.js                 what terrain is made OF — the 16 textures, the
                                  three contact dials behind them (grip, bounce,
                                  belt), and the material classes (§5.9; editor
                                  + sim + server validation)
    gravity.js                  which way down is — GRAVITY, and the planets that
                                  redirect it (§5.10; editor + sim + server
                                  validation)
    audio.js                    every sound, synthesised — no asset files (§17)
    tutorial-demos.js           the /learn page's machines — shared with the gate
                                  that proves they still win (§18)
    api.js                      REST wrapper + localStorage auth
    util.js                     pins/geometry/Bézier/badges + the editor's pure
                                  rules (the ones a DOM handler must not own)
```

## Deploying it

**First time on this Windows PC:** `SetupForInternetServer.bat` (see Run it).
It builds `Production/`, copies the campaign database in, and starts Caddy +
Node. The public site is HTTPS; Node itself listens on `127.0.0.1:3232`.

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

Everything expensive — all ten suites, then the build — happens **before**
anything is stopped, so a red gate or a failed build leaves the live site up and
untouched. The outage is the copy, and it is measured in seconds.

Two details that are easy to get wrong and are handled in
[`scripts/deploy.ps1`](scripts/deploy.ps1):

- **The database comes back by `VACUUM INTO`, never a file copy.** With WAL on,
  the newest commits live in the `-wal` sidecar. Measured on the live database:
  a plain copy of `db.sqlite` read 17 sessions where `VACUUM INTO` read 18, with
  the server writing nothing in between — a silent loss of the newest writes,
  every older row present and correct.
- **The push is a clean sweep, not a paste-over.** `dist/` has no `public/js`,
  so copying it *onto* a tree that has one leaves the old readable source in
  place and still served. `Production/data` and `Production/node_modules`
  are the only things kept.

For a Linux box instead:

```bash
npm run build        # -> dist/  (bundled, minified, no source, no data)
```

`dist/` is self-contained and runs exactly like the source tree. Copy it to the
box, install runtime deps, seed once, start:

```bash
rsync -a --delete dist/ you@box:/srv/lifirik/
ssh you@box 'cd /srv/lifirik && npm ci --omit=dev && node scripts/seed-official-levels.js'
```

Then TLS and supervision, both in [`deploy/`](deploy/):

| file | what it does |
|---|---|
| `deploy/Caddyfile` | HTTPS with automatic Let's Encrypt certs, compression, security headers, proxy to `127.0.0.1:3000` |
| `deploy/lifirik.service` | systemd unit — restarts on failure, `TRUST_PROXY=1`, `HOST=127.0.0.1`, SIGTERM long enough for the save flush |

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # edit the domain first
sudo cp deploy/lifirik.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lifirik caddy
```

Four things that matter more than the rest:

- **Terminate HTTPS in front, and bind the app to loopback.** Passwords are posted
  in the clear otherwise. `HOST=127.0.0.1` is what stops the app *also* answering
  on the public interface over plain HTTP, which would make the certificate
  bypassable by asking for `:3000` directly. It defaults to `0.0.0.0` because a
  container has to accept outside traffic; the systemd unit pins it.
- **`TRUST_PROXY=1` only when a proxy really is in front.** Off behind one, every
  visitor shares a rate-limit bucket and the first burst locks out the site; on
  without one, anyone spoofs `X-Forwarded-For` and the limits do nothing.
  `RATE_LIMIT_DISABLED=1` turns limiting off for local work.
- **One process, one disk.** SQLite on local disk, held in memory: a single
  instance with a persistent volume. Not scale-to-zero serverless, and not two
  replicas — they would overwrite each other silently.
- **Back up `data/`.** Nothing else on the box is irreplaceable; that directory
  is. Copy `data/db.sqlite` (server stopped, or after a checkpoint) and keep
  the copy off the box.

Compression is Caddy's job (`encode zstd gzip`), not the app's — the 230 KB
bundle goes out at roughly a quarter of that and Node spends nothing on it.

## Invite-only (closed alpha)

A fresh seed creates admin **LIFIRIK** / **changeme!**. Change it, especially on a public box.

```bash
node scripts/invite.mjs ada --admin      # server STOPPED; prints the password once
node scripts/set-password.mjs LIFIRIK    # server STOPPED; reset a forgotten one
REGISTRATION=closed npm start            # public sign-up returns 403
```

Invited accounts are marked free forever (`subscribed`, premium to 2100) — the
people building the levels shouldn't meet a paywall they helped create.

**`REGISTRATION=closed` is the second lock, not the first.** Anonymous play needs
no account, so a closed register route still leaves everything readable to anyone
with the URL. The real gate goes in front, in the Caddyfile:

```caddyfile
basic_auth {
    alpha $2a$14$...        # generate with: caddy hash-password
}
```

Curation: an admin can ★ any community level from the Workshop
(`POST /api/admin/levels/:id/feature`). Featured levels get their own row above
the list and **survive a full re-seed** — unlike the 32 campaign slots, which
`npm run seed` wipes and re-stamps from `scripts/campaign-seed.json`. A featured
level that earns a place in the campaign graduates by being exported from the
Maker into that seed.

## What must not leave the box

MIT — see [LICENSE](LICENSE). The game code may be copied. **`data/db.sqlite` may
not**: password hashes, per-user salts, live session tokens, email addresses.
It is `.gitignore`d. Committing it once puts real credentials in the history
permanently.

The server does not serve anything outside `public/` over HTTP: `express.static`
is mounted on `public/` alone, and `/server.js`, `/data/db.sqlite`,
`/package.json`, `/scripts/deploy.ps1` and traversal attempts (`/../`, `%2e%2e`)
all 404. Re-check this after touching any route.

## Notes

- **Roles.** An admin can set them from the Admin page: right-click a row in the
  Users table for **Admin** and **Moderator**. You cannot change your OWN roles
  there — an admin who unticks their own box cannot tick it back, and on a
  one-admin install that is the site locked with no way in but the database.

  From the box, with the server stopped:

  ```bash
  node scripts/set-role.mjs ada --admin        # or --no-admin / --moderator
  node scripts/set-role.mjs                    # just list who has what
  ```

  Revoking the LAST admin needs `--force`, since this script is then the only
  way back. (This used to be documented as `npm run db:export` → hand-edit the
  JSON → move it over `data/db.json` → delete `data/db.sqlite*` → restart to
  re-import, which deletes the database on the way to changing one boolean. It
  still works; there is no reason to do it.)
- Anonymous play works everywhere; accounts add attribution, profiles, and
  cross-device bench sync.
- **Import** (`/import`) turns FC-format level text (`SR,x,y,w,h,angle;…`) into
  a LIFIRIK level at 1 px per source unit, previews it, and hands it to the
  Level Maker as a local draft to play-test before publishing. Same conversion
  is scriptable: `POST /api/import/fc {"text": "…"}` → `{name, desc, data,
  warnings, stats}`, which you can post straight on to `POST /api/levels`.
- **Files ▸ Open in Level Maker** on any play screen takes that level's layout
  (and your machine, and wherever you've staged the goal pieces) into the Maker
  as a **new local draft** — a starting point for your own. It carries no level
  id, so it can never write back over the level it came from.
- **Solves** (top bar, next to Save and Files) opens a full-screen panel: the
  level's details and thumbnail with a copyable direct link, the three records
  and who holds each, every solve as a sortable/searchable table (with its own
  author box), then the comments. Escape or ✕ closes it.
- **Your profile lists local saves too** — Maker drafts and locally-saved
  solutions, merged into the same tables as the server's, tagged `💾 local`, with
  a local/server filter. Before this they were written and never listed.
- **Deleting is private-only.** You can delete your own private levels and
  private solves; a public or unlisted one has been played and solved by other
  people, so unpublish it instead (which keeps their work). Local saves delete
  outright — they only exist in that browser.
- **Hints** are optional and editable on every level save; a level with no hint
  shows no Hint button.
- Points shop is off by default (`TEST_ECONOMY=0`). Purchases and subscriptions
  are fake when it is on; no payment processor exists.
- To reset the whole install: stop the server, delete `data/db.sqlite*`, run
  `npm run seed`.
