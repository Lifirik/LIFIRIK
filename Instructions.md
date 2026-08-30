# How to play LIFIRIK

This is the standalone player manual. The same material, stepped and with
live demos, is in the app under **?** — Beginner, Level Maker, **Advanced**,
and FC. Every key and click is listed on `/keys`.

Build a machine. Press Play. Put the green things in the green box. That is
the entire game. Everything else is you getting cleverer about it.

---

## The idea

A **level** is three things:

- a **violet box** — the **build zone**. Your pieces have to *start* inside it.
- a **green box** — the **goal zone**. Every green thing has to end up *fully
  inside* it.
- one or more **green things** (balls or crates) to deliver.

Press **Space** (or ▶) to run the machine. Press it again to stop. Losing
costs nothing: the machine resets to exactly where you built it. The clock
only ever remembers your best.

A level may have several of either zone. **Zones that touch or overlap count
as one region** — a piece may span the whole of it. Zones with space between
them stay separate; nothing may bridge the gap.

Where the machine goes after Play is entirely its own business. A small build
zone far from the work is not a smaller level, it is a longer throw.

---

## Building a machine

**Click** to drop a wheel. **Drag** to draw a stick, from one end to the
other. Two wheels and one stick is a cart, and a cart will get you further
than you would think.

### Pins

Where two ends meet, they **pin together**. A pin is a hinge: it holds fast
but can still swing. Ends only. A stick crossing the *middle* of another
stick is just contact — no pin.

A **triangle** cannot change shape without changing the length of a side, so
it is the one shape that stays rigid on hinges alone. When something you
build folds up under load, the cure is nearly always one more stick making a
triangle of it.

The little dots on a wheel are pins. Drawing a stick near one snaps its end
on.

### Wheels

Three letters, engraved on the face:

| | |
|---|---|
| **L** | motor, rolls left |
| **R** | motor, rolls right |
| **F** | free — no motor, it just rolls |

Three **sizes**. Bigger is genuinely stronger — a large wheel pushes like
eight standard ones. Click a placed wheel (or its menu) to change size and
direction. Keys: **L** / **F** / **R** pick the wheel tools, **H** a wood
stick, **W** a water stick.

A powered wheel is only an engine once something sits on its **hub**. With an
empty hub there is nothing to push against, so it free-rolls. Any stick, crate
pin, or other pin on that hub is a shaft.

A wheel **rigidly framed** to its own hub fights itself — the motor turns the
wheel against the frame, the frame is bolted to the wheel, and the whole thing
stalls. A powered wheel wants to drive a **hinge**. If a machine shakes itself
apart for no reason you can see, count how many motors are wrestling each
other.

Uphill and a cart that spins in place instead of climbing is **grip**, not a
broken wheel: more weight over the wheel, or a bigger one.

### Sticks, rope, water

- **Wood stick** — solid. The default.
- **Water stick** — solid to the world, but *your own machine* passes through
  it. Scaffolding, in one piece. Box the cargo in water sticks and drive out
  through the walls.
- **Rope** — hold **Alt** and drag a stick tool. A hanging chain of links,
  for cranes, tow-lines and swings. Real physics, not decoration. Right-click
  a rope: the Weight slider sets the whole length at once. **Alt**+right-click
  for a single link. A **wet rope** (Alt with the water stick) hangs through
  your machine.

### Weight

Select a stick and **scroll**, or use the slider on its menu: **1 to 100**.
Weight is how you build counterweights, pendulums, rams and anchors — an
engine that needs no motor. The dock's **kg** readout is the whole machine
honestly weighed. Some challenges score on it.

Two heavy sticks bolted to the same point are one joint carrying both. A pin
asked to hold more than **×200** costs a tidiness badge. Spread a huge
counterweight across two pins.

### The piece's own menu

**Right-click a piece** (or hold a finger still on it). What it is made of,
how heavy, which way it turns, how big. That one gesture is most of the
editor.

**Double-click** a piece to select its whole connected machine. **Ctrl+Z**
undoes absolutely anything. The **scroll wheel** zooms — except over a
selected piece, where it resizes.

On a touch screen: one finger is the left button, hold still for the menu,
pinch to zoom. The toolbar's Shift / Ctrl / Alt chips stand in for the held
keys.

### The three modifier stories

Learn these and most of the rest follows.

| | |
|---|---|
| **Ctrl** | On the canvas, Ctrl+click **deletes** the piece under the cursor (Cmd+click on a Mac). Everywhere else: undo, redo, copy, paste, cut, select all, save. |
| **Alt** | The finer version: a small piece, a rope instead of one stick, a waypoint on a path, 10° rotate, the 20 px grid. |
| **Shift** | A plain drag moves the whole connected machine. Shift+drag moves *just that piece* — links stretch to stay connected. Shift+drag empty space pans. 45° rotate. |

**Middle-drag** a piece (Create tab) puts it where the ordinary rules refuse —
through terrain, into another piece. Authoring only.

**S** cycles snap: **ON** (40 px grid always), **REVERSED** (free until you
hold a snap key), **OFF**. Authors start on REVERSED.

Every binding: `/keys`.

---

## Playing levels

**Campaign** is LIFIRIK's own levels, in two sets, in the order they were
meant to be met.

**Workshop** is everybody else's. Play them, rate them, take on a challenge.
Featured levels sit in their own row.

**Anonymous play works everywhere.** An account adds attribution, a profile,
cross-device saves, and the right to publish.

On a level you are *playing*, nothing interrupts the run but Space and Stop.
A stray click must not cost the attempt. Looking around is free: pan, zoom,
**Z** to fit.

While a run is on, a **scrub line** appears on the play bar when the pointer
is near it. Drag it to rewind; keep going past the end and it simulates
onward. Arrow keys step a tenth of a second; Shift steps a whole one.

**Files ▸ Open in Level Maker** takes that level's layout (and your machine,
and wherever you have staged the goal pieces) into the Maker as a **new local
draft**. It carries no level id, so it can never write back over the level it
came from.

### Winning, saving, records

"In" means **fully inside** — the whole green thing over the line, not a toe.
The moment it is, you have won, and the clock stops. Every green thing has to
be home.

Save a winning run. Visibility is yours: this device only, private to your
account, unlisted (anyone with the link), or public. A public or unlisted
solve has been seen; you unpublish it rather than delete it. Local saves
delete outright.

Each level keeps three records (time, pieces, weight) and who holds each.
**Solves** (top bar) opens the level's table: every run, badges, comments.
Escape or ✕ closes it.

Your profile lists local saves too, tagged as local, with a local/server
filter.

### Badges

Badges notice *how* you did it — no wheels, no motors, nothing but rope, one
single piece. They are computed from what the machine actually was and did,
never granted, never applied for. The red-ringed family is the connoisseur's
set: doing without a whole class of tool and winning anyway.

### Challenges

From a saved run: **Match me? Beat me?** Tick Time, Pieces, and/or Weight,
and post it. Anyone can try to beat the number without being shown how you
did it. When it ends, your machine is revealed either way. They run 30 days.
Some stake points; winner takes the pot.

A live challenge **locks the level's visibility** until it closes.

---

## Level Maker

`/maker`, or Maker in the nav. Two tabs:

- **Create** is the level — ground, zones, the green things, scenery, the
  level's own machines.
- **Test** is the same level as a player meets it, with the machine tools.

Space runs the machine in either one. Beat it yourself on Test before anyone
else can.

Nothing in the Maker is required. A level is still three things. The rest is
what you *may* do.

### The bones

**Build zone.** Drag its corners. Up to eight of them. The cheapest
difficulty dial you have: make it smaller before you make the level harder.
**Ctrl+A** in Create takes the whole level, zones included, so shifting
everything 40 px left is one chord and an arrow key.

**Goal pieces.** Balls and crates, up to eight, plus up to eight goal zones.
A crate is a different problem from a ball — one rolls away, the other has to
be pushed. Right-click for **Density**: ×0.25 is a balloon, ×8 is something
you have to lift. Colour tells you which is which (darker is heavier). A goal
piece parked *outside* every build zone belongs to the level — the player
cannot drag it, only reach it.

**Terrain.** A **box** and a **boulder** are drags: press one corner, pull to
the other. **Paint** (**P**): click points or drag to trace, close the loop.
**Enter** closes, **Backspace** takes a point back. Afterwards every vertex
is still draggable; **Alt**+click an edge inserts one; double-click a point
flips it between a **corner** and a **curve** with handles.

Then right-click any of it for its **texture**. Sixteen of them, and they are
not paint: ice is slippery, mud grips, rubber bounces, a **belt** carries
whatever touches it. Under the swatches sit Grip, Bounce and Belt — you can
override any one without touching the others.

A **boulder** has one more trick. Right-click, turn on **Planet**, and it
becomes a gravity well. Downward gravity switches off. Pieces rest on every
side of it, wheels drive around it. Two planets give you a neutral line.
Try it once before deciding it is not for you.

**Props.** Loose crates or balls with real weight that belong to nobody. Not
a goal, not terrain: they move. Stack them, block a doorway, leave one
balanced. Same Density ladder as goal pieces. A prop can be a **ghost**:
frozen in place, the machine's *sticks* swing straight through it, while
wheels, cargo and other props still land on it — a shelf you can reach
through. (This is not GhostRun. GhostRun is below.)

**Pins on props.** **Alt**+click a prop to drop a pin, up to eight, then
right-click the pin for **Fixed to background**. A pin bolted to the
background is a hinge. A pin that is *not* fixed is a place the player can
bolt a stick to — a trailer, a bucket, a counterweight they did not have to
build. A loose pin can carry a **radius** (right-click it): centre plus eight
slots round the rim.

The gold on a pin is load. A busy one wears a hex nut.

### In the hand

Right-click **empty space** in Create for the background picker and a mini
toolbar. **⌇ / ╱** rewrites every handle on a painted outline or a path at
once.

Every slider is also a number: **double-click it** and type 137, or 0.06, or
42. Some dials switch units (px/s, or how many seconds the trip should take).

**Ctrl+click** adds to a selection. **Ctrl+drag** on empty space is a
marquee. Two or more selected grows an align chip (edges, centres, **Touch**)
and a gold rotate knob for the whole arrangement. **Ctrl+double-click**
promotes the piece under the cursor to the align **anchor** — it glows gold.

**Ctrl+C / Ctrl+V** — paste *aims*: hold V, move the cursor, release to drop.
**Ctrl+X** is a true cut. The clipboard is **cross-level** and survives a
reload. **Ctrl+Shift+V** aims on the 40 px grid, **Ctrl+Alt+V** on the 20 px
one.

The grid is **40 px**, exactly one standard wheel across. **Alt** is the 20 px
half-grid.

### Make it move

On the Create tab the machine tools place **level pieces** — parts belonging
to the level itself: a footbridge, a crane, a windmill, a ladder somebody
else built and left behind. They simulate exactly like a player's parts,
which means they fall over if you did not brace them, and it means the player
can pin their own sticks onto yours. A powered wheel among them is a level
that does something the instant Play is pressed.

**＋ path** on almost anything. One waypoint to start; drag it, **Alt**+click
the curve to add more. **Once**, **there-and-back**, or a closed **loop**
(drag the last waypoint onto the start). Speed 4 to 800 px/s. Select a piece
that has a path and the editor draws ghosts of it along the route, so you can
see what it sweeps. Moving terrain is honest physics: it carries what stands
on it and shoves what blocks it. A goal zone on a path is a moving target. A
build zone on a path is legal.

**↻ spin.** No waypoints — the piece turns where it stands. The **spin
centre** is a handle you can drag: leave it in the middle and the piece turns
on the spot; move it and the piece **orbits** that point. Spin and "follow
the path's direction" are opposites. A piece does one or the other. A one-way
path can **stop spinning when it arrives**.

**Groups.** Select two or more, group them. They drag, resize and rotate
together, and the group can take a motion of its own. A group's motion is
applied *on top of* each member's own, never instead of it — a cog can keep
spinning while the platform it is bolted to travels.

**Labels** (**T**). Signs, titles, instructions. Nothing collides with a
label. Font, colour, size, depth, and they can take a path too.

**Scenery** is atmosphere. None of it can be touched, and none of it affects
a solve.

### Publish

**Publish…** offers the same destinations as a save: this device, private,
unlisted, Workshop. Start shy and go public later. The **description** shows
on the card — no spoilers. Your own solve goes up with it; that is what
proves the level is possible, and it sets the first time on the board.

After that: ratings, comments, challenges on your own level.

---

## Advanced use

None of this is needed to have a good time. It is for finishing a machine
that is already close.

The in-app walkthrough is **?** → **Advanced** (`/learn/advanced`).

### Turn it on

Right-click the **toolbar's grip** — the handle you drag the bar around with
— and press **⚙**. The Advanced bar appears (bottom-left by default), and an
**info chip** starts reading whatever is under the pointer: frames per
second, and a live description of the piece.

The same menu:

- fold this bar to its handle (or **Shift+A** to cycle the Advanced bar:
  handle → tools → tools and counts)
- hide *every* bar to one spot, and click that spot to bring them back
- **expanded toolbar** — every shape its own button, delete tool visible
- **bindings chip** — live card of what left / middle / right mouse and the
  arrows do right now, given the current tool and modifiers

The play bar has its own brief/expanded pair on *its* grip (Revert, Undo,
Redo, Fit).

On a touch screen the grip's menu is the same hold-still gesture as a
piece's.

### What is on the Advanced bar

| | |
|---|---|
| **Snap** | The 40 px grid. Same three states **S** cycles. |
| **Free World** | Build *anywhere* in the level, not just the violet box. A run with any piece left outside scores **nothing**: no badges, no solve. You can still save the attempt. The level wears a weave while it is on. |
| **GhostRun** | The ghost button. Next section. |
| **Speed** | How fast Play *plays*, not how the physics ticks. The sim is a fixed step either way. |

Select two or more pieces and the second row lights up: align left / right /
top / bottom / centres, **Touch** (slide together to a 2 px gap), **even
spread**, wrap a rope around the selection, **group** / ungroup, delete.

Align measures against the **anchor** — the first piece you picked, glowing
gold. **Ctrl+double-click** promotes whatever is under the cursor.

The third tier of the bar (Shift+A twice) is a **census**: wheels by size,
each split L · F · R, then sticks by material, and in Create the level's own
parts too.

### GhostRun

**Edit the machine against a chosen second of its own future**, without
pressing Play.

Press the ghost on the Advanced bar. A chip appears. Your machine is drawn
faintly over the level **as it will be at the aimed second**, with the road
the cargo takes to get there and ten pictures of it along the way, evenly
spaced in time — so the gaps between them are its speed.

Every edit re-runs the machine to that second, so the ghost follows what you
build. No recorded run is needed to start. If you *have* just watched a run
and parked the scrub line, that moment is the opening aim.

The chip's **dial** is the second you are looking at, **0.1 s to 100 s**
(cubed, so the first part of the travel is the short aims, where a sweep is
cheap). Drag it; a matrix that is up re-runs itself at the new second once
you let go. The play scrub line re-aims it too.

**Hide** on the chip puts the future overlay away without leaving GhostRun.
The hollow machine at the aimed second is what covers the build; the roads,
the score and the sweep stay. Show brings it back. Same item on the ground's
right-click menu.

The chip also prints **two numbers**: where the cargo *is* at the aim (what
the ghost draws), and the closest it ever came (what a sweep scores). They
differ the moment a machine overshoots.

GhostRun is a **second simulation**, not a rewind of a recording. A tape
says what a machine did. GhostRun answers what a *different* machine would
do. Catch-up is visible on purpose: after an edit the ghost replays itself at
speed and settles. That is both the honest picture of the work and the thing
that tells you the mode is working on a level too heavy to answer instantly.

Press the ghost again to switch it off.

### Roads

Right-click **empty ground** in GhostRun and draw the cargo a **road** —
corners in the order it should travel them, ending at the goal.

Use one when the cargo has to go the wrong way first, which on some levels
is the only way it ever goes the right way. Without a road, the score is
straight-line distance to the nearest goal — fine until "closer to the goal"
is the wrong question.

- Drag a corner to move it, right-click one to remove it.
- Several roads are allowed; the **best** of them counts.
- On a level with more than one cargo, each road belongs to one.

Right-click a **goal piece** or a **goal zone** to pair them. Numbered on the
zones themselves; the chip writes `1→2` when cargo 1 is sent to goal 2. "Any
goal" is the default. The *real* win condition is still any piece in any
zone — pairing only changes what GhostRun *scores*.

### Tweaking — pin sweeps and weight sweeps

This is the rest of GhostRun: **ask the future what a millimetre does**.

**Right-click one of your own pins** — any pin you are allowed to move, the
**cargo's own included** — and **sweep** it. The level's pins stay out of it;
this is a list of things the player may move, not a list of pins.

A grid of positions (225 on a pin, a 15×15 around where it is now), each one
a **full re-run** of the machine to the aimed second, scored by how far it
gets the cargo along its road — or straight at the goal if you have not drawn
one.

Three rungs, the same three steps the arrow keys nudge by:

| Rung | Step |
|---|---|
| Coarse | **1 px** |
| Fine | **0.1 px** |
| Finest | **0.01 px** |

Each covers a tenth of the width of the one above, so the coarse one finds
the region and the fine ones find what is inside it. After a coarse sweep the
chip offers the next finer rung at the winner.

**Right-click a stick** to sweep its **weight** instead — all hundred whole
weights, ×1 to ×100, laid out 10×10, scored the same way. A rope sweeps every
link together, as its own slider writes them.

The field paints as it fills in. You can keep editing the view; Esc stops it.

| Colour | Meaning |
|---|---|
| **Green** | Beats the machine you already have (closer at the aim) |
| **Gold** | Delivers. Deepest gold is soonest |
| **Grey** | A spot the editor refuses |
| The tick on the scale | Where you stand now |

**Hover** a cell and that candidate's cargo road is drawn over the level in
slate — free, because it is the run the cell was scored from. **Click** any
measured cell — while the sweep is still running, if you like — and the pin
goes there, always measured from where the sweep began, so you can walk a
cluster and watch each one. The **middle cross** puts it back.

Nothing is applied automatically. A click is what moves the machine.

**Esc** stops a sweep. What it measured stays on the chip and is still
clickable, and it says how much of the grid it covered.

A long aim is a slow sweep, because every cell is a full rollout to that
second. Start the dial near where the cargo actually misses.

Arrow keys still nudge 0.1 px (Alt 0.01, Shift+Alt a whole 1, Shift alone
steps onto the 40 px grid). The sweep is for when you want a *picture* of
the neighbourhood, not one step.

---

## Settings

The cog. All of it is **this device**, not the account — it works signed out.

- **Language.** The game's own words change. What other players wrote (level
  titles, comments, dares) stays in whatever language they wrote it.
- **Graphics.** Normal, Poster, X-Ray, Neon. Nothing simulates differently
  in any of these. Thumbnails and share cards stay Normal so what you
  publish looks the same to everybody; **clips** record the style you play
  in.
- **Sound.** On/off, volume, five themes (Physical, Arcade, Music box,
  Heavy, Drum kit), and four layers you can mute independently (Impacts,
  Motion, Outcomes, Interface). Synthesised — no asset files. Listening
  changes nothing about the sim.
- **Password**, when signed in.

Theme (light/dark) follows with the rest of the chrome.

---

## Import

`/import`. Paste Fantastic Contraption level text (`SR,x,y,w,h,angle;…` or
FCML). It lands in the Maker as a local draft — play-test it, read the
warnings, then save. An imported machine arrives as the level's own, on the
Create tab.

The same conversion is an API: `POST /api/import/fc`.

Coming from FC in general: `/learn/fc` is *just the differences*. `/fc`
still lands there.

---

## Accounts and the rest of the site

- Sign in / Join in the nav. Invite-only alpha may have public sign-up
  closed; anonymous play still works.
- **Profile** — your levels, your saved runs, local drafts merged in.
- **Support** — `/support`. Whatever the operator has written there.
- Direct links to a level work; copy one from the Solves panel.

You can delete your own **private** levels and private solves. A public or
unlisted one has been played by other people — unpublish it instead.

---

## Controls (the short list)

The long list is `/keys`. The ones you actually hold:

| | |
|---|---|
| **Space** | Play / stop |
| **Ctrl+Z / Y** | Undo / redo |
| **Ctrl+S** | Save |
| **Z / Shift+Z** | Fit zones / fit the whole level |
| **Arrows** | Nudge the selection (see Advanced for the step sizes). During a run, step the scrub line |
| **Delete** | The selection |
| **Esc** | Cancel, close, stop a sweep |
| **1 … 0** | Toolbar in order |
| **Shift+T / Shift+P** | Fold the piece toolbar / the play bar |
| **Shift+R** | Reset (the machine in Test, the level in Create) |
| **Shift+A** | Cycle the Advanced bar (Advanced mode only) |

That is enough to find the rest.
