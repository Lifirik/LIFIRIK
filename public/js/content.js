// content.js — the words, and the one place they can be changed (§13.1).
//
// **Every long-form string in the game has a key here, a default here, and may
// have an override in the DATABASE.** An admin edits the override from
// Admin > Text and it is live for everybody on their next load; no deploy, no
// restart. The default is what ships, so an empty `content` table is not a
// blank site — it is exactly the site as written.
//
// The split is deliberate and it is the same one §11.9 draws around a level:
// **the words are editable, the structure is not.** A tutorial step's
// paragraphs are text; the live physics demo above them, the button that opens
// the Maker, the badge grid — those are code, because they are not sentences
// and a text box is the wrong shape for them. Anything you can say in a
// sentence lives here; anything you would have to *build* stays where it is.
//
// Button labels, tooltips and error messages are deliberately NOT here. They
// are load-bearing UI rather than prose — "Cancel" being editable buys nothing
// and an admin who renamed it would break the interface for everybody, with no
// gate able to tell.

// i18n.js is standalone (it imports nothing), so this is not a cycle: txt()
// below asks it for the current language's version of a key before falling
// back to the override chain and the English defs.
import { langOf, contentTranslation } from './i18n.js';

// ---------- the tiny markup ----------
//
// Plain text with four affordances, chosen because they are the four things the
// existing copy actually does. Anything else is left alone rather than escaped
// into mojibake, so a stray asterisk is a stray asterisk.
//
//   blank line   a new paragraph
//   ~ at line start   that paragraph is muted (the quiet aside under the point)
//   **bold**
//   [[Space]] [[Ctrl+Z]]   a key, drawn as a keycap; + splits a chord
//   [label](/route)   a link
//
// Parsed to DOM nodes, never innerHTML: every one of these strings is editable
// by an admin, and an admin is still a person who can paste a script tag.
export function parseRich(text, { el, keys }) {
  const paras = String(text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const out = [];
  for (const raw of paras) {
    const line = raw.trim();
    if (!line) continue;
    const muted = line.startsWith('~');
    const body = muted ? line.slice(1).trim() : line;
    out.push(el('p', muted ? { class: 'muted' } : {}, ...inline(body, { el, keys })));
  }
  return out;
}

// One pass, longest-token-first, so `[[A]]` is never mistaken for `[A](...)`.
const TOKEN = /(\[\[[^\]]+\]\])|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
function inline(s, { el, keys }) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(keys(...m[1].slice(2, -2).split('+').map(k => k.trim())));
    else if (m[2]) out.push(el('b', {}, m[2].slice(2, -2)));
    else {
      const label = m[3].slice(1, m[3].indexOf(']'));
      let href = m[3].slice(m[3].indexOf('](') + 2, -1);
      // Leftover `#/keys` bookmarks become `/keys`. In-page `#section` stays.
      if (href.startsWith('#/')) href = href.slice(1);
      // Only in-app routes and plain http(s). An admin typing `javascript:`
      // into a text box should get a dead link rather than a script.
      //
      // **`/route` is in the list, and its absence was a bug the whole time
      // routes stopped being hashes** (§12). This test was written when every
      // in-app link looked like `#/maker`; paths landed, the copy was updated
      // to `[Maker](/maker)` — and every single link in every editable string
      // silently became `href="#"`, which looks like a link, hovers like a
      // link and goes nowhere. Nothing failed and nothing said so.
      //
      // `\/(?!\/)` and not `\/`: `//evil.example` is a protocol-relative URL
      // that leaves the site, so the one shape a leading slash must NOT admit
      // is a second one. `#` stays for in-page anchors.
      const safe = /^(#|\/(?!\/)|https?:)/.test(href) ? href : '#';
      out.push(el('a', { href: safe }, label));
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---------- the registry ----------
//
// `group` is only how the admin page stacks them. `key` is the contract: it is
// what the database stores against, so renaming one orphans its override.
export const CONTENT = [
  // ---- the front page ----
  { key: 'home.tagline', group: 'Home', label: 'Hero tagline',
    def: 'A dynamic, repeating mechanism governed solely by the physical laws of force and motion.' },
  { key: 'home.sub', group: 'Home', label: 'Hero sub-heading',
    def: 'Build machines from wheels and sticks. Deliver the green things. That\'s the whole deal — the rest is engineering.' },
  { key: 'home.fresh', group: 'Home', label: 'Workshop row heading',
    def: 'Fresh from the Workshop' },

  // ---- the campaign ----
  { key: 'campaign.title', group: 'Campaign', label: 'Page title', def: 'Campaigns' },
  { key: 'campaign.sub', group: 'Campaign', label: 'Page sub-heading',
    def: 'All the current campaigns are listed here. Enjoy!' },
  // Campaign titles, bylines and section headings live on Admin > Campaigns.

  // ---- the workshop ----
  { key: 'workshop.title', group: 'Workshop', label: 'Page title', def: 'Community Workshop' },
  { key: 'workshop.sub', group: 'Workshop', label: 'Page byline',
    def: 'The community made these! You are also in the community... Get making!' },
  // NOT "live": a sealed race is a challenge that has not opened yet, and those
  // are the ones most worth turning up for (§11.8).
  { key: 'workshop.challenges', group: 'Workshop', label: 'Challenges tab heading', def: '🏁 Challenges' },
  { key: 'workshop.challengesSub', group: 'Workshop', label: 'Challenges tab blurb',
    def: 'Beat the clock, or beat somebody\'s numbers. Winner takes the staked points. Some are still counting down to their reveal.' },
  { key: 'workshop.featured', group: 'Workshop', label: 'Featured heading', def: '★ Featured' },
  { key: 'workshop.featuredSub', group: 'Workshop', label: 'Featured blurb', def: 'Hand-picked by the LIFIRIK team.' },

  // ---- how to play: four chapters, nineteen steps (§18) ----
  //
  // Titles and prose only. Each step's demo, sandbox, mock-up or badge grid is
  // code, and the buttons at the end of a step are code, because a link that
  // has to work is not a sentence.
  //
  // Every step has `title` and `body`; a step MAY have `more` — the fold-out
  // under the picture for whoever wants the deeper layer. The body must stand
  // alone without it: the fold is a gift, never homework. TOUR_PLAN below is
  // the structure, and verify-tutorial.mjs holds the two in step.

  // ---- chapter 1 · Play ----
  // The KEYS still say `pink` (2026-08-12). They are internal, an admin's edits
  // are stored against them, and renaming would orphan every one — so the copy
  // and the labels moved to green and the keys stayed where they are.
  { key: 'tour.play.pink.title', group: 'Beginner · 1 Play', label: 'Green ball — title', def: 'Somebody needs this green ball moved.' },
  { key: 'tour.play.pink.body', group: 'Beginner · 1 Play', label: 'Green ball — body', rich: true, def:
`It has to end up in the **green box**. You build a machine that does it, out of wheels and sticks, then press [[Space]] — or the ▶ button — to set it going.

That is the entire game. Everything else is just you getting cleverer about it.

~That machine up there is really running — same physics as the real game, not a video.` },
  { key: 'tour.play.pink.more', group: 'Beginner · 1 Play', label: 'Green ball — more', rich: true, def:
`"In" means **fully inside** — the whole green thing over the line, not a toe. The moment it is, you have won, and the clock stops.

Losing costs nothing. The machine resets to exactly where you built it, as many times as you like, and nobody is counting your attempts. The clock only ever remembers your best.` },

  { key: 'tour.play.built.title', group: 'Beginner · 1 Play', label: 'Built — title', def: 'Here is one being built.' },
  { key: 'tour.play.built.body', group: 'Beginner · 1 Play', label: 'Built — body', rich: true, def:
`**Click** to drop a wheel — a tap does the same. **Drag** to draw a stick, from one end to the other. Then press [[Space]] and watch it go.

Two wheels and one stick. That is a cart, and a cart will get you further than you would think.

~Put something in the wrong place? [[Ctrl+Z]] takes it back. There is nothing on this page you can break and nothing you can lose — so poke at it.` },
  { key: 'tour.play.built.more', group: 'Beginner · 1 Play', label: 'Built — more', rich: true, def:
`Watch where the stick's ends went: **onto the wheels' hubs**. The little dots are pins, and drawing a stick near one snaps its end on, so you rarely have to be accurate.

The violet box is the **build area** — your pieces have to start inside it. Where the machine goes after you press Play is entirely its own business.` },

  { key: 'tour.play.try.title', group: 'Beginner · 1 Play', label: 'Try it — title', def: 'Your turn. Build it right here.' },
  { key: 'tour.play.try.body', group: 'Beginner · 1 Play', label: 'Try it — body', rich: true, def:
`The same level, live, and yours to build in. **Two R wheels** in the violet box, **one stick** between their hubs, then **▶**.

If the cart drives off and shoves the ball home, that gold flash is yours — the first of many.

~This little canvas is the real physics too. Undo takes back the last piece; Clear starts you over; nothing you do here is saved or judged.` },
  { key: 'tour.play.try.more', group: 'Beginner · 1 Play', label: 'Try it — more', rich: true, def:
`Some things worth trying while you are here, because they all teach something:

**One R wheel, nothing else.** Nothing happens — a wheel is only a motor once something sits on its hub. Give it a stub of stick and off it goes. **A stick that misses the hubs.** The cart falls apart; ends have to MEET to join, which is the next step's whole story. **A wall of sticks in front of the ball.** You cannot build outside the violet box, however hard you try.` },

  { key: 'tour.play.join.title', group: 'Beginner · 1 Play', label: 'Joining — title', def: 'Ends that meet, join.' },
  { key: 'tour.play.join.body', group: 'Beginner · 1 Play', label: 'Joining — body', rich: true, def:
`This is the one rule worth knowing. Where two ends meet, they **pin together** — and a pin is a hinge, so it holds fast but can still swing.

Same four sticks on both sides. The only difference is whether the ends touch.` },
  { key: 'tour.play.join.more', group: 'Beginner · 1 Play', label: 'Joining — more', rich: true, def:
`A pin is a **hinge**, not a weld — it holds the ends together and lets them turn. That is why the loose frame scissors: nothing was holding its corners at all. And it is why the joined frame is a **triangle** — a triangle cannot change shape without changing the length of a side, so it is the one shape that stays rigid on hinges alone. When something you build folds up under load, the cure is nearly always one more stick making a triangle of it.

Ends only. A stick crossing the MIDDLE of another stick touches it the way a boot touches the floor — no pin, just contact.` },

  { key: 'tour.play.wheels.title', group: 'Beginner · 1 Play', label: 'Wheels — title', def: 'Wheels come in three.' },
  { key: 'tour.play.wheels.body', group: 'Beginner · 1 Play', label: 'Wheels — body', rich: true, def:
`Same cart three times, one letter different — and the letter is engraved right on the wheel's face. **L** and **R** are engines: with a stick — or any pin — on the hub they roll themselves the way their letter says. **F** is a free wheel: no motor, it just rolls, and it is what you want under something you are only carrying.` },
  { key: 'tour.play.wheels.more', group: 'Beginner · 1 Play', label: 'Wheels — more', rich: true, def:
`Wheels come in three **sizes** too, and bigger is genuinely stronger — a large wheel pushes like eight standard ones. Click a placed wheel and its own menu changes its size and direction; on a keyboard, [[L]] [[F]] [[R]] pick the wheel tools and [[H]] a stick.

Uphill and a cart that spins in place instead of climbing? That is not a broken wheel, that is **grip** — try more weight over the wheel, or a bigger one.` },

  { key: 'tour.play.go.title', group: 'Beginner · 1 Play', label: 'Go play — title', def: 'That is genuinely enough.' },
  { key: 'tour.play.go.body', group: 'Beginner · 1 Play', label: 'Go play — body', rich: true, def:
`Wheels, sticks, pins, [[Space]], [[Ctrl+Z]]. Everything in the Campaign's first levels falls to exactly what you now know.

The chapters after this one are for coming back to — when a level makes you wish for a better tool, the tool is waiting here. None of it is required to have a good time.

~Played **Fantastic Contraption**? There is a [page of just the differences](/learn/fc) — skip everything you already know.` },

  // ---- chapter 2 · Build smarter ----
  { key: 'tour.build.ask.title', group: 'Beginner · 2 Build smarter', label: 'Ask the piece — title', def: 'If you are stuck, ask the piece.' },
  { key: 'tour.build.ask.body', group: 'Beginner · 2 Build smarter', label: 'Ask the piece — body', rich: true, def:
`**Right-click a piece** — or hold a finger still on it — and it opens its own little menu: what it is made of, how heavy, which way it turns, how big. That one gesture is most of this chapter; the piece will tell you what it can do.

~On a touch screen, two fingers **pinch to zoom**, and the toolbar's Shift / Ctrl / Alt chips stand in for the held keys. Everything else is the same editor.` },
  { key: 'tour.build.ask.more', group: 'Beginner · 2 Build smarter', label: 'Ask the piece — more', rich: true, def:
`Worth meeting by name: **double-click** (or double-tap) a piece to select its whole connected machine, drag the selection and it all comes along. [[Ctrl+Z]] undoes absolutely anything, as far back as you like. And the **scroll wheel** zooms — except over a selected piece, where it resizes: a stick's weight, a wheel's size.

Every binding in the game lives on the [Controls](/keys) page, in one boring list. Nobody learns it top to bottom; you look up the one thing you want.` },

  { key: 'tour.build.solo.title', group: 'Beginner · 2 Build smarter', label: 'Solo wheel — title', def: 'A powered wheel needs something on its hub.' },
  { key: 'tour.build.solo.body', group: 'Beginner · 2 Build smarter', label: 'Solo wheel — body', rich: true, def:
`The same wheel twice, and the only difference is **one stick on the hub** — the whole difference between an engine and a paperweight.

A motor drives its wheel **relative to** whatever is bolted to the hub. With an empty hub there is nothing to push against, so the wheel just free-rolls. Any stick will do — a frame, a stub, a rope's end — as long as its end sits on the hub pin. A crate's pin, or any other pin on the hub, is the same shaft.` },
  { key: 'tour.build.solo.more', group: 'Beginner · 2 Build smarter', label: 'Solo wheel — more', rich: true, def:
`The relative part has a sharp edge worth knowing early: a wheel **rigidly framed** to its own hub fights itself — the motor turns the wheel against the frame, the frame is bolted to the wheel, and the whole thing stalls or bucks. A powered wheel wants to drive a **hinge**.

So: an axle stick on every engine, free wheels inside the frame, and if a machine shakes itself apart for no reason you can see, count how many motors are wrestling each other.` },

  { key: 'tour.build.weight.title', group: 'Beginner · 2 Build smarter', label: 'Weight — title', def: 'The weight dial does real work.' },
  { key: 'tour.build.weight.body', group: 'Beginner · 2 Build smarter', label: 'Weight — body', rich: true, def:
`The same stick on both ends of the beam. The only difference is one number on the right-hand one — and the beam slams.

Select a stick and **scroll**, or use the slider on its menu: **1 to 100**. Nobody has to stack fifty of anything to make something heavy.` },
  { key: 'tour.build.weight.more', group: 'Beginner · 2 Build smarter', label: 'Weight — more', rich: true, def:
`Weight is how you build counterweights, pendulums, rams and anchors — an engine that needs no motor. The dock's **kg** readout is the whole machine honestly weighed, and some levels' challenges score on it.

Weight adds up at the pin: two heavy sticks bolted to the same point are one joint carrying both, and a pin asked to hold more than **×200** costs you one of the tidiness badges. If a counterweight needs more, spread it across two pins.` },

  { key: 'tour.build.gravity.title', group: 'Beginner · 2 Build smarter', label: 'Gravity — title', def: 'Gravity is a free motor.' },
  { key: 'tour.build.gravity.body', group: 'Beginner · 2 Build smarter', label: 'Gravity — body', rich: true, def:
`Not one wheel in it. One heavy stick falls, the arm swings, and the crate is thrown right across the level.

Everything you just learned in one machine: pins that hinge, a triangle that stands, weight that works.

~The tilt is what does it — an arm that starts level throws the crate straight up, and it lands exactly where it began.` },
  { key: 'tour.build.gravity.more', group: 'Beginner · 2 Build smarter', label: 'Gravity — more', rich: true, def:
`The recipe, if you want to build one: an **A-frame** (two legs and a base — the triangle), a long arm balanced **across** its apex, counterweight on the high end, payload **above the low end of the arm**. The arm must start tilted, and the payload must sit OVER the arm rather than on the ground in front of it — parked on the ground it just rolls clear while the weight is still falling, and no amount of counterweight fixes that.

Machines with no motors at all get noticed — there is a badge for it, and it is one of the satisfying ones.` },

  { key: 'tour.build.ground.title', group: 'Beginner · 2 Build smarter', label: 'Ground — title', def: 'The ground is a material, not a colour.' },
  { key: 'tour.build.ground.body', group: 'Beginner · 2 Build smarter', label: 'Ground — body', rich: true, def:
`The same crate on the same tilted floor. The **mud** holds it exactly where it was put; the **ice** lets it slide clean away. And that third one is a **conveyor** — the crate is carried along with no machine anywhere in the level.

Read the ground before you build. It is telling you what the level wants.` },
  { key: 'tour.build.ground.more', group: 'Beginner · 2 Build smarter', label: 'Ground — more', rich: true, def:
`Grass, granite, sand, mud, ice, rubber, belts — every texture grips differently, some bounce, and a belt carries whatever touches it in the direction it runs. Wheels care the most: an engine on ice is a suggestion, on rubber it is a command.

A belt is also a tool to exploit: if it runs toward the goal, a delivery can be nothing but a gentle nudge onto the belt.` },

  { key: 'tour.build.ropes.title', group: 'Beginner · 2 Build smarter', label: 'Ropes — title', def: 'Ropes, and sticks made of water.' },
  { key: 'tour.build.ropes.body', group: 'Beginner · 2 Build smarter', label: 'Ropes — body', rich: true, def:
`Hold [[Alt]] and drag a stick tool, and instead of one rigid stick you lay **rope** — a hanging chain of little links, for cranes, tow-lines and swings.

A **water stick** is stranger and better: solid to the world, but **your own machine passes through it**. Scaffolding, in one piece.

~That is the toolkit. When a level beats you, the answer is usually one of these six steps — come back and it will still be here. The rest of the bindings live on [Controls](/keys).` },
  { key: 'tour.build.ropes.more', group: 'Beginner · 2 Build smarter', label: 'Ropes — more', rich: true, def:
`Rope is real physics, not decoration — each link has weight and the whole run swings honestly. Right-click a rope and its Weight slider sets the whole length at once. A **wet rope** (Alt with the water stick) hangs through your machine, which is exactly what a safety line wants.

Water sticks make cages the machine can leave: box the green thing in water sticks and drive out through the walls.` },

  // ---- the Level Maker guide: four chapters, seventeen steps ----
  //
  // **Its own PART of the page, not a chapter of the tutorial** — somebody who
  // wants to author a level is not partway through learning to play, and the
  // four-step sketch this replaced could only ever wave at the toolbar. The
  // arc is the same one the beginner chapters use, applied to a different job:
  // what a level is MADE of, then how to work fast, then how to make it move,
  // then how to let it go.
  //
  // Every picture on it is a real level from tutorial-demos.js drawn by the
  // game's own renderer, and the three that move are gated in
  // verify-tutorial.mjs beside every other demo.

  // ---- Level Maker · 1 The bones ----
  { key: 'tour.make.three.title', group: 'Level Maker · 1 The bones', label: 'Three things — title', def: 'A level is three things.' },
  { key: 'tour.make.three.body', group: 'Level Maker · 1 The bones', label: 'Three things — body', rich: true, def:
`Somewhere to build (the **violet box**), somewhere to deliver (the **green box**), and a **green thing** to deliver. Lay some ground under them and you have made a level. That is not a simplification — that is the whole requirement.

The [Maker](/maker) opens on the **Create** tab with exactly this started for you, so the shortest possible first level is: drag the ground wider, press Play.

~Nothing in this chapter is required. Everything after this step is a thing you MAY do, in roughly the order people reach for them.` },
  { key: 'tour.make.three.more', group: 'Level Maker · 1 The bones', label: 'Three things — more', rich: true, def:
`Two tabs, and the difference matters. **Create** is the level — ground, zones, the green things, scenery. **Test** is the same level as a player meets it, with the machine tools, so you can build a solution without ever leaving the Maker. [[Space]] runs the machine in either one.

Start small anyway. The best first level is one idea the player can see the whole of, and you can always publish another. A level that took an evening and a level that took four minutes get the same card in the Workshop.` },

  { key: 'tour.make.build.title', group: 'Level Maker · 1 The bones', label: 'Build zone — title', def: 'The build zone is the difficulty.' },
  { key: 'tour.make.build.body', group: 'Level Maker · 1 The bones', label: 'Build zone — body', rich: true, def:
`Same level twice. Same ball, same wall, same green box — the only thing that changed is the **violet box**, and one of them is a shrug and the other is a puzzle.

That rectangle is where the player's pieces have to **start**. Where the machine goes afterwards is entirely its own business, so a small zone far from the work is not a smaller level, it is a longer throw.

~Drag its corners like anything else. Up to **eight** of them, and [[Ctrl+A]] takes the zones too, so shifting the whole level is one chord and an arrow key.` },
  { key: 'tour.make.build.more', group: 'Level Maker · 1 The bones', label: 'Build zone — more', rich: true, def:
`**Zones that touch are one region** — a stick may span the seam — so two overlapping rectangles are simply one oddly-shaped build area. Zones with a gap between them genuinely split the machine, which is a puzzle of its own: two little machines, or one that throws to its partner.

The commonest first-level mistake is a build zone so generous that the answer is "a big cart". Try making it smaller before you make the level harder. It is the cheapest difficulty dial you have and it never makes a level unfair, only tighter.` },

  { key: 'tour.make.goal.title', group: 'Level Maker · 1 The bones', label: 'Goal pieces — title', def: 'The green things, and where they go.' },
  { key: 'tour.make.goal.body', group: 'Level Maker · 1 The bones', label: 'Goal pieces — body', rich: true, def:
`A **goal piece** is what you are asking for; a **goal zone** is where it has to arrive. Up to **eight** of each, and every green thing has to be home before the level counts as solved.

They come as balls and crates, and a crate is a different problem from a ball — one rolls away from you, the other has to be pushed. Right-click either for its **Density**: that third crate is ×4, and it draws darker because it really is heavier.

~A goal piece parked OUTSIDE every build zone belongs to the level — the player cannot drag it, only reach it. Where you put it is level design.` },
  { key: 'tour.make.goal.more', group: 'Level Maker · 1 The bones', label: 'Goal pieces — more', rich: true, def:
`Two deliveries in different directions is the cheapest way to make one machine do two clever things, and it costs you one extra piece to author. Two green things into **one** zone is a different puzzle again: the machine has to come back for the second.

Density is a real dial and not a label. At ×0.25 a crate is a balloon that a light shove sends flying; at ×8 it is something you have to lift rather than nudge. And a goal zone takes a motion path like anything else — the last chapter of this guide is about that.` },

  { key: 'tour.make.terrain.title', group: 'Level Maker · 1 The bones', label: 'Terrain — title', def: 'The ground is something you design.' },
  { key: 'tour.make.terrain.body', group: 'Level Maker · 1 The bones', label: 'Terrain — body', rich: true, def:
`Everything in that picture is terrain. A **box** and a **boulder** are drags — press one corner, pull to the other. The sand hill on the left was **painted**: press [[P]], click points or drag to trace, and close the loop to make it solid ground.

Then right-click any of it for its **texture**. Sixteen of them, and they are not paint — ice is slippery, mud grips like glue, rubber bounces, and a **belt** carries whatever touches it. A level's floor is half of what that level asks for.

~Under the swatches are the three dials the texture set for you — Grip, Bounce and Belt — and you can override any one without touching the others. An icy-looking stone ramp is one slider.` },
  { key: 'tour.make.terrain.more', group: 'Level Maker · 1 The bones', label: 'Terrain — more', rich: true, def:
`The painter is worth ten minutes of your time: click for a corner, drag to trace freehand, [[Backspace]] takes a point back, [[Enter]] closes it. Afterwards every vertex is still draggable, [[Alt]]+click on an edge inserts one, and double-clicking a point flips it between a **corner** and a **curve** with handles.

A **boulder** has one more trick. Right-click one, turn on **Planet**, and it becomes a gravity well: downward gravity switches off and the level stops having a "down" at all. It is the biggest change one toggle can make to a level — try it once before deciding it is not for you.` },

  { key: 'tour.make.props.title', group: 'Level Maker · 1 The bones', label: 'Props — title', def: 'Props are things that are simply there.' },
  { key: 'tour.make.props.body', group: 'Level Maker · 1 The bones', label: 'Props — body', rich: true, def:
`A **prop** is a loose crate or ball with real weight that belongs to nobody. It is not a goal piece — nothing has to be delivered — and it is not terrain, because it moves. Stack them, block a doorway with them, leave one balanced somewhere it should not be.

They carry the same **Density** ladder the goal pieces do, and the colour tells you which is which: that dark ball is ×4, and the big pale crate is ×0.25 and weighs less than the small ones stacked beside it.

~Props are the cheapest way to make a level feel like a place instead of a diagram.` },
  { key: 'tour.make.props.more', group: 'Level Maker · 1 The bones', label: 'Props — more', rich: true, def:
`A tower of crates is a genuine puzzle, because knocking it over is permanent: a machine that has to pass twice has to survive what it did the first time.

A prop is also the one thing in the level the player's machine can pick up and carry — nothing stops a scoop from taking one along — and it collides with everything, so a heavy prop parked on a slope is a hazard that arrives on its own schedule.

Its menu can also make it a **ghost**: frozen in place, the machine's sticks swing straight through it, while wheels, cargo and other props still land on it — a shelf you can reach through.` },

  { key: 'tour.make.pins.title', group: 'Level Maker · 1 The bones', label: 'Pins — title', def: 'Pin a prop and it becomes a hinge.' },
  { key: 'tour.make.pins.body', group: 'Level Maker · 1 The bones', label: 'Pins — body', rich: true, def:
`There is **no machine in that level**. The plank is a prop with a **pin** through its middle, and a pin bolted to the background is a hinge — it holds the plank up in the air and lets it turn. Drop something heavy on one end and the other end throws.

[[Alt]]+click a prop to drop a pin on it, up to eight, then right-click the pin for **Fixed to background**.

~The bolt on a pin counts what meets there: the more parties a joint holds, the bigger its hardware, and a busy one wears a **hex nut**. Gold means it is holding something.` },
  { key: 'tour.make.pins.more', group: 'Level Maker · 1 The bones', label: 'Pins — more', rich: true, def:
`A pin that is **not** fixed is the other half of the feature and the more interesting one: it is a place the PLAYER can bolt a stick to. Anything sharing that exact coordinate joints to the prop, so a pinned crate becomes part of somebody's machine — a trailer, a bucket, a counterweight they did not have to build.

Pins ride every transform. Resize the crate, rotate it, drag it across the level — a pin put on a corner stays on that corner, which is what makes "hinge this plank at that end" something you can author accurately rather than approximately.

A loose level pin can also carry a **radius** — right-click it — which turns the point into a bolt ring: the centre plus eight slots round the rim, for hanging machines off something big.` },

  // ---- Level Maker · 2 In the hand ----
  { key: 'tour.make.right.title', group: 'Level Maker · 2 In the hand', label: 'Right-click — title', def: 'If you are stuck, right-click it.' },
  { key: 'tour.make.right.body', group: 'Level Maker · 2 In the hand', label: 'Right-click — body', rich: true, def:
`**Every piece has its own menu**, and it is where most of this guide actually lives. Delete at the top, then whatever that particular piece has: a texture picker, a Density or Weight slider, corner rounding, the layer chevrons, a motion path.

Above all of it sits a **mini toolbar** — the same tools as the main one, under your cursor, so you rarely have to travel back to the bar you dragged into a corner.

~On a touch screen, hold a finger still on the piece. Same menu, same everything.` },
  { key: 'tour.make.right.more', group: 'Level Maker · 2 In the hand', label: 'Right-click — more', rich: true, def:
`Right-click **empty space** in Create and you get the background picker and the toolbar — the one gesture in the editor that used to do nothing at all.

Two things live only here: **⌇ smooth / ╱ straight**, which rewrites every handle on a painted outline or a path at once; and a **rope's** Weight, which sets the whole length as far as the next junction ([[Alt]]+right-click for a single link).

And while a machine is running, right-click is **Stop** and nothing else — every other item in that menu edits geometry the simulation already owns.` },

  { key: 'tour.make.sliders.title', group: 'Level Maker · 2 In the hand', label: 'Typing a dial — title', def: 'Every slider is also a number.' },
  { key: 'tour.make.sliders.body', group: 'Level Maker · 2 In the hand', label: 'Typing a dial — body', rich: true, def:
`Drag a slider while you are exploring. **Double-click it** the moment you know the number — a box opens in its place that takes the value exactly: 137, or 0.06, or 42.

Double-click the slider's **label** to send the box away again. [[Enter]] commits, [[Esc]] hands the slider back.

~Some dials can be typed in more than one unit — a travel speed as px/s, or as how many seconds the trip should take. The little button beside the box switches which.` },
  { key: 'tour.make.sliders.more', group: 'Level Maker · 2 In the hand', label: 'Typing a dial — more', rich: true, def:
`This matters most where the right answer is a number rather than a feel: a belt at exactly 3, two platforms that must travel at the same speed, a spin that has to take four seconds because the gap it swings past is open for four seconds.

The choice is remembered per dial. If you always type the weight, weight always opens as a box.` },

  { key: 'tour.make.select.title', group: 'Level Maker · 2 In the hand', label: 'Selecting — title', def: 'Select more than one thing.' },
  { key: 'tour.make.select.body', group: 'Level Maker · 2 In the hand', label: 'Selecting — body', rich: true, def:
`A click picks one piece. **[[Ctrl]]+click** adds another. **[[Ctrl]]+drag on empty space** sweeps a marquee around everything you want, and **[[Ctrl+A]]** takes the whole tab — in Create that is the entire level, both kinds of zone included.

With two or more selected you get the align chip: edges, centres, and **Touch**, which slides one piece up against another with no gap left between them.

~Everything moves together after that — drag it, or nudge it with the [[Arrows]].` },
  { key: 'tour.make.select.more', group: 'Level Maker · 2 In the hand', label: 'Selecting — more', rich: true, def:
`A multi-selection of level pieces also grows a **gold rotate knob**, and dragging it turns the whole arrangement about its centre rather than spinning each piece where it stands — which is the difference between rotating a staircase and ruining one. [[Shift]] snaps the turn to 45°, [[Alt]] to 10°.

Every align operation measures against the **first** piece you picked; **[[Ctrl]]+double-click** promotes whatever is under the cursor to that anchor, and the anchor **glows gold** so you always know which it is.

**Double-click** is the other selector, and it takes the whole physically connected assembly — everything sharing a pin with what you clicked, plus its group mates.` },

  { key: 'tour.make.copy.title', group: 'Level Maker · 2 In the hand', label: 'Copy & paste — title', def: 'Cut, copy, paste — even into another level.' },
  { key: 'tour.make.copy.body', group: 'Level Maker · 2 In the hand', label: 'Copy & paste — body', rich: true, def:
`**[[Ctrl+C]]** copies the selection. **[[Ctrl+V]]** arms it rather than dropping it: hold [[V]] down, move the cursor to aim, and it lands when you let go — so twenty of something is one held chord and twenty taps.

**[[Ctrl+X]]** is a true cut, so cut-then-paste **moves** things. And the clipboard is **cross-level**: copy a hillside out of one level, open another, paste it in.

~[[Ctrl+Shift+V]] aims on the 40 px grid and [[Ctrl+Alt+V]] on the 20 px one. The clipboard also survives a reload.` },
  { key: 'tour.make.copy.more', group: 'Level Maker · 2 In the hand', label: 'Copy & paste — more', rich: true, def:
`The thing worth building this way is a **motif**. Draw one good arch, one good step, one good spinning cog with its path already set — a path is copied along with its piece — and then paste it five times across the level.

Levels that look composed are nearly always levels where something was copied. It is also the fastest way to keep a level CONSISTENT: five identical platforms genuinely are identical, rather than five platforms that are nearly the same and read as sloppy.` },

  { key: 'tour.make.grid.title', group: 'Level Maker · 2 In the hand', label: 'The grid — title', def: 'Hold Shift, and things line up.' },
  { key: 'tour.make.grid.body', group: 'Level Maker · 2 In the hand', label: 'The grid — body', rich: true, def:
`The same three slabs, twice. On the left they were dropped by eye; on the right the grid was in force, and they have merged into one wall — because two pieces on neighbouring nodes **meet**, with no gap to fall through and no overlap to fight.

The grid is **40 px**, which is exactly one standard wheel across. [[Alt]] gives you the 20 px half-grid for the sizes in between.

~Press [[S]] to cycle the snap button: **REVERSED** (the Maker's default — nothing snaps until you hold [[Shift]]), then **ON**, then **OFF**.` },
  { key: 'tour.make.grid.more', group: 'Level Maker · 2 In the hand', label: 'The grid — more', rich: true, def:
`It snaps a placement, a move, a resize — the **corner you drag** goes on the node and the opposite corner stays put — and a paste. So a whole level can be built on the lattice without you measuring anything once.

The grid draws itself whenever it is in force, so what you are about to land on is always on screen. This is the difference between a level that looks hand-made and one that looks built: a 4 px step where two floors nearly meet is exactly the sort of thing a player's wheel finds every single time.` },

  // ---- Level Maker · 3 Make it move ----
  { key: 'tour.make.parts.title', group: 'Level Maker · 3 Make it move', label: 'Level pieces — title', def: 'The level can own a machine.' },
  { key: 'tour.make.parts.body', group: 'Level Maker · 3 Make it move', label: 'Level pieces — body', rich: true, def:
`Those wheels and sticks are not the player's. On the Create tab the machine tools place **level pieces** — parts belonging to the level itself: a footbridge, a crane, a windmill, a ladder somebody else built and left behind.

They simulate exactly like a player's parts, which means they fall over if you did not brace them — and it means the player can **pin their own sticks onto yours**.

~Everything the Beginner chapters taught about wheels, sticks and triangles applies here unchanged. A level piece is a piece.` },
  { key: 'tour.make.parts.more', group: 'Level Maker · 3 Make it move', label: 'Level pieces — more', rich: true, def:
`Two ways to use them. As **scaffolding**: something already in the world the player has to work with — a plank they can shove, an axle they can drive, a gate that is in the way until it is not. And as a **hint**: half a machine, left sitting in the build zone, quietly saying "something like this".

A **powered** wheel among the level's own parts — with a stick on its hub, same as anywhere — is a level that does something on its own the instant Play is pressed. Give a level an engine and you have made a puzzle about timing.` },

  { key: 'tour.make.path.title', group: 'Level Maker · 3 Make it move', label: 'Paths — title', def: 'Give anything a path.' },
  { key: 'tour.make.path.body', group: 'Level Maker · 3 Make it move', label: 'Paths — body', rich: true, def:
`The green box in that level is **sliding back and forth**, and the level is still perfectly winnable — the machine has to arrive at the right moment, which is the entire puzzle.

Right-click almost anything and press **＋ path**. You get one waypoint just above the piece; drag it where you want it, [[Alt]]+click the curve to add more, and choose how it runs: **once**, **there-and-back**, or a closed **loop** (drag the last waypoint onto the start).

~Speed is a slider, 4 to 800 px/s. Select a piece that has a path and the editor draws ghosts of it all along the route, so you can see what it sweeps before you ever press Play.` },
  { key: 'tour.make.path.more', group: 'Level Maker · 3 Make it move', label: 'Paths — more', rich: true, def:
`**Moving terrain is honest physics** — it carries what stands on it and shoves what blocks it — so an elevator is a platform with a vertical path and nothing else at all.

Terrain, props, zones and labels can each take one. A goal zone on a path makes "deliver it there" a moving target. A build zone on a path is legal, and cruel, and somebody should try it.

The info chip reports where a one-way trip **ends** — position and angle — which is how you line a lift up flush with a ledge instead of three pixels under it.` },

  { key: 'tour.make.spin.title', group: 'Level Maker · 3 Make it move', label: 'Spin — title', def: '…or just spin it.' },
  { key: 'tour.make.spin.body', group: 'Level Maker · 3 Make it move', label: 'Spin — body', rich: true, def:
`The same menu, the other button: **↻ spin**. No waypoints at all — the piece turns where it stands, for as long as the level runs, at whatever speed you dial.

That paddle is **one terrain box with one setting on it**, and there is no machine anywhere in the level. Spin makes cogs, turntables, revolving doors, windmills and paddle wheels; it is the cheapest motion in the game and the one players notice most.

~Spin and "follow the path's direction" are opposites. A piece does one or the other.` },
  { key: 'tour.make.spin.more', group: 'Level Maker · 3 Make it move', label: 'Spin — more', rich: true, def:
`The **spin centre** is a handle you can drag, drawn as a crosshair so it is never mistaken for a waypoint. Leave it in the middle and the piece turns on the spot; move it and the piece **orbits** that point instead — which is how you get a moon, a Ferris-wheel car, or a hammer on the end of an arm. Drag it home again and the override clears.

A one-way path can also be told to **stop spinning when it arrives**: a door that swings open once and then stays open.` },

  { key: 'tour.make.groups.title', group: 'Level Maker · 3 Make it move', label: 'Groups — title', def: 'Group things and they travel as one.' },
  { key: 'tour.make.groups.body', group: 'Level Maker · 3 Make it move', label: 'Groups — body', rich: true, def:
`That lift is **two terrain pieces sharing a group**, with one path on the group. The crate is attached to nothing whatsoever — it is standing on a floor that goes up, which is all a lift has ever been.

Select two or more pieces and group them. From then on they drag together, resize together and rotate together, and the group can be given a motion of its own.

~Zones and labels ride a group too — so a goal zone can travel with the platform it sits on, and a sign can ride the thing it is naming.` },
  { key: 'tour.make.groups.more', group: 'Level Maker · 3 Make it move', label: 'Groups — more', rich: true, def:
`**A group's motion is applied on top of each member's own**, never instead of it. So a cog can keep spinning while the platform it is bolted to travels, and a spinning arm can orbit a moving hub. That composability is where the genuinely memorable levels live, and it costs one extra path.

The group's own handles are worth knowing: a rotate knob above it, and four corner handles that stretch the whole arrangement at once — so a staircase you built once can be made twice as wide without touching a single step.` },

  // ---- Level Maker · 4 Publish it ----
  { key: 'tour.make.beat.title', group: 'Level Maker · 4 Publish it', label: 'Beat it — title', def: 'Beat it yourself before anyone else can.' },
  { key: 'tour.make.beat.body', group: 'Level Maker · 4 Publish it', label: 'Beat it — body', rich: true, def:
`Switch to the **Test** tab — your level exactly as a player will meet it — and solve it. If you cannot, nobody can, and you would rather find that out now than in the comments.

When you win, **save the run** and keep it **Private** for the moment. You will want it in a minute.

~This is also where you find out whether the level is FUN, which is a different question from whether it is possible. Two attempts is a good level; twenty is a level with a difficulty problem.` },
  { key: 'tour.make.beat.more', group: 'Level Maker · 4 Publish it', label: 'Beat it — more', rich: true, def:
`Watch what your own machine did, not just whether it won. If it won by an accident you did not design — a piece bouncing off a wall you put there for decoration — a stranger will find that route in a minute and never see yours.

The other thing to try is solving it **badly** on purpose. A level with exactly one answer is a lock; a level with three is a puzzle, and the third one is usually the one people write about.` },

  { key: 'tour.make.publish.title', group: 'Level Maker · 4 Publish it', label: 'Publish — title', def: 'Then let it go.' },
  { key: 'tour.make.publish.body', group: 'Level Maker · 4 Publish it', label: 'Publish — body', rich: true, def:
`**Publish…** offers real destinations: on this device only, private to your account, unlisted (anyone with the link), or the open Workshop. You can start shy and go public later, and you can keep editing it afterwards either way.

Two boxes ask for words and they are not the same box. The **description** shows on the level's card, where people read it before they decide — so no spoilers. The **hint** is hidden behind a button, for when somebody is stuck.

~Your solve goes up with it. That is what proves the level is possible, and it quietly sets the first time on the board.` },
  { key: 'tour.make.publish.more', group: 'Level Maker · 4 Publish it', label: 'Publish — more', rich: true, def:
`After that the level is a place other people go: ratings, comments, and **challenges** — put a bar on your own level, a time or a piece count or a weight, and let people come at it for thirty days with your own machine sealed.

The best first level is one idea the player can see the whole of. Publish it, watch one person play it, and make the next one. That loop is the entire hobby.` },

  // ---- chapter 4 · Compete ----
  { key: 'tour.win.badges.title', group: 'Beginner · 3 Compete', label: 'Badges — title', def: 'Badges notice HOW you did it.' },
  { key: 'tour.win.badges.body', group: 'Beginner · 3 Compete', label: 'Badges — body', rich: true, def:
`Solve with no wheels, no motors, nothing but rope, one single piece — the game is watching, and it says so on your solve for everybody to see.

Badges are worked out from what your machine actually **was and did** — never granted, never applied for. They turn a solved level back into six fresh puzzles.` },
  { key: 'tour.win.badges.more', group: 'Beginner · 3 Compete', label: 'Badges — more', rich: true, def:
`Because they are computed, they cannot lie — a "No Wheels" run genuinely contained no wheel from start to finish. The negative ones (the red-ringed family) are the connoisseur's set: doing without a whole class of tool and winning anyway.

Chasing a badge is the best teacher in the game. "No motors" hands you the gravity chapter; "fewest pieces" teaches economy nothing else will.` },

  { key: 'tour.win.dare.title', group: 'Beginner · 3 Compete', label: 'Dare — title', def: 'Now dare somebody.' },
  { key: 'tour.win.dare.body', group: 'Beginner · 3 Compete', label: 'Dare — body', rich: true, def:
`Go to your own solves, find the run you saved, and pick **⚔ Match me? Beat me?** Tick **Time**, leave the rest, and post it.

That is a **timed challenge**. Anyone can try to beat your number — without being shown how you did it. When it ends, your machine is revealed to everybody either way.

~You have just gone from "what is this" to setting the bar. That is the whole game, both ends of it.` },
  { key: 'tour.win.dare.more', group: 'Beginner · 3 Compete', label: 'Dare — more', rich: true, def:
`Challenges can score **time**, **piece count** or **weight**, alone or together, and they run for 30 days. Your machine stays sealed while the challenge runs — competitors see the level and your numbers, never your solution — which is what makes beating it worth something.

Some challenges stake points. Winner takes the pot; the leaderboards remember.` },

  { key: 'tour.win.out.title', group: 'Beginner · 3 Compete', label: 'Out — title', def: 'That is the lot.' },
  { key: 'tour.win.out.body', group: 'Beginner · 3 Compete', label: 'Out — body', rich: true, def:
`You can play, you can build with the whole toolkit, you can author levels and run competitions on them. There is no chapter five; from here the game is other people.

~When a machine is already close and you want millimetres, that is [Advanced](/learn/advanced) — GhostRun, and tweaking a pin or a weight against the future. Everything else lives on [Controls](/keys), and none of it is needed to have a good time.` },

  // ---- Advanced · GhostRun and tweaking ----
  //
  // A fourth PART, not a chapter of Beginner. Somebody finishing a machine by
  // millimetres is not partway through learning to play, and burying GhostRun
  // in "Build smarter" would put it in front of people who have not yet built
  // a cart. The door is the same `?`; the page is its own URL.

  { key: 'tour.adv.mode.title', group: 'Advanced · 1 The bar', label: 'The door — title', def: 'Advanced mode is a door on the toolbar.' },
  { key: 'tour.adv.mode.body', group: 'Advanced · 1 The bar', label: 'The door — body', rich: true, def:
`Right-click the toolbar's **grip** — the handle you drag the bar around with — and press **⚙**. The Advanced bar appears, and an info chip starts reading whatever is under the pointer.

That is the whole door. Everything in this part lives behind it. Nothing in the rest of the game changes until you open it.

~On a touch screen the grip's menu is the same hold-still gesture as a piece's.` },
  { key: 'tour.adv.mode.more', group: 'Advanced · 1 The bar', label: 'The door — more', rich: true, def:
`[[Shift+A]] cycles the Advanced bar: handle only, then tools, then tools and counts. Double-tap any bar's grip to fold it. ⤫ in that menu hides every bar to one spot, which is how you get the canvas to yourself.

The same ⚙ used to live on the Settings page. It is on the toolbar now because a mode switch two screens away is a mode nobody finds.` },

  { key: 'tour.adv.bar.title', group: 'Advanced · 1 The bar', label: 'The bar — title', def: 'Snap, Free World, Ghost, speed.' },
  { key: 'tour.adv.bar.body', group: 'Advanced · 1 The bar', label: 'The bar — body', rich: true, def:
`**Snap** is the 40 px grid — the same one [[S]] cycles. **Free World** lets you build anywhere in the level, not just the violet box. A run with any piece left outside scores nothing: no badges, no solve. You can still save the attempt.

**GhostRun** is the next chapter. The slider is playback speed, not the physics clock.

Select two or more pieces and the second row lights up: align, touch, spread, wrap a rope, group, delete.` },
  { key: 'tour.adv.bar.more', group: 'Advanced · 1 The bar', label: 'The bar — more', rich: true, def:
`The info chip is the other half of the mode — frames per second, and a live readout of the piece under the pointer. Expand the toolbar from the same grip menu if you want every shape as its own button.

None of this is required to play. All of it is for finishing a machine that is already close.` },

  { key: 'tour.adv.ghost.title', group: 'Advanced · 2 Ghost mode', label: 'GhostRun — title', def: 'GhostRun draws a second of the future.' },
  { key: 'tour.adv.ghost.body', group: 'Advanced · 2 Ghost mode', label: 'GhostRun — body', rich: true, def:
`Press the ghost on the Advanced bar. Your machine is drawn faintly as it will be at a chosen second, with the road the cargo takes to get there and ten pictures of it along the way — the gaps between them are its speed.

Every edit re-runs the machine to that second, so the ghost follows what you build. You never have to press Play to start.

The chip carries the dial, **0.1 s to 100 s**. **Hide** puts the overlay away without leaving the mode, if the ghost is covering the build.` },
  { key: 'tour.adv.ghost.more', group: 'Advanced · 2 Ghost mode', label: 'GhostRun — more', rich: true, def:
`The ghost is a second simulation, not a rewind of a recording. A tape says what a machine did; GhostRun answers what a different machine would do. Catch-up is visible on purpose: after an edit the ghost replays itself at speed and settles.

The play scrub line re-aims it too, when you have a run to scrub. Full bindings live on [Controls](/keys).` },

  { key: 'tour.adv.road.title', group: 'Advanced · 2 Ghost mode', label: 'Roads — title', def: 'Draw the cargo a road.' },
  { key: 'tour.adv.road.body', group: 'Advanced · 2 Ghost mode', label: 'Roads — body', rich: true, def:
`Right-click empty ground to lay a **road** — corners in the order the cargo should travel them, ending at the goal. Use one when the cargo has to go the wrong way first, which on some levels is the only way it ever goes the right way.

Drag a corner to move it, right-click one to remove it. Several roads are allowed and the best of them counts. On a level with more than one cargo, each road belongs to one.

Right-click a goal piece or a goal zone to pair them: the chip writes 1→2 when cargo 1 is sent to goal 2. “Any goal” is the default, and the real win is still any piece in any zone.` },
  { key: 'tour.adv.road.more', group: 'Advanced · 2 Ghost mode', label: 'Roads — more', rich: true, def:
`A road is what a sweep scores against. Without one, the score is straight-line distance to the nearest goal — fine until the cargo has to go backwards first, at which point “closer to the goal” is the wrong question. Draw the road, then sweep.` },

  { key: 'tour.adv.tweak.title', group: 'Advanced · 2 Ghost mode', label: 'Tweaking — title', def: 'Tweak a pin, or a weight.' },
  { key: 'tour.adv.tweak.body', group: 'Advanced · 2 Ghost mode', label: 'Tweaking — body', rich: true, def:
`Right-click one of **your own pins** — the cargo's included — and **sweep** it. Hundreds of positions, each a full re-run, scored by how far it gets the cargo along its road (or straight at the goal if you have not drawn one).

Three rungs: **1 px**, **0.1 px**, **0.01 px**. The coarse one finds the region; the fine ones find what is inside it.

Right-click a **stick** to sweep its weight instead — all hundred whole weights, ×1 to ×100. A rope sweeps every link together.

Hover a cell for that candidate's road. **Green** beats the machine you have, **gold** delivers (deepest gold is soonest), **grey** is a spot the editor refuses. Click any measured cell to put the pin there. [[Esc]] stops a sweep; what it measured stays.` },
  { key: 'tour.adv.tweak.more', group: 'Advanced · 2 Ghost mode', label: 'Tweaking — more', rich: true, def:
`Nothing is applied automatically — a click is what moves the machine. The middle cross puts it back. The scale under the field says what the colours are worth. After a coarse sweep the chip offers the next finer rung at the winner.

A long aim is a slow sweep, because every cell is a full rollout to that second. Start the dial near where the cargo actually misses.` },

  { key: 'support.title', group: 'Support', label: 'Page title', def: 'Support' },
  { key: 'support.sub', group: 'Support', label: 'Page sub-heading',
    def: 'How to reach a human about the game.' },
  { key: 'support.body', group: 'Support', label: 'Page body', rich: true,
    def: 'Edit this page from Admin ▸ Text to add a contact address or notes for players.' },

  // ---- Settings (2026-08-10) ----
  //
  // The panels that explain a CHOICE rather than label a control. Each one is
  // a paragraph an admin might reasonably want to reword.
  //
  // `settings.physics.*` left with the panel they explained (2026-08-17,
  // "We don't need LIFIRIK physics anymore. Just FCLike will do."): the
  // lifirik/fc switch was a play-testing trial on the same terms as the pin
  // picker below, the fc side won when the engine became fcsim itself, and
  // the four keys — blurb, two hints, the solve-invalidation caveat — had
  // gone stale twice in one afternoon even while the choice existed. The
  // history of their rewording, and probe-fcweight.mjs's leave-one-in
  // measurements behind it, live in git.
  // `settings.pins.*` left with the panel they explained (2026-08-12): the
  // dots/groove switch was a trial, the groove won, and a settings card
  // offering a choice of one is a question with no answer. Editable text with
  // no reader is a trap for whoever next edits it.
  // `settings.advanced.blurb` left with the section it explained (2026-08-12):
  // Advanced mode moved onto the toolbar's grip menu, where it is a tooltip on
  // an icon rather than a paragraph on a page nobody was reading it on. An
  // editable text key with no reader is a trap for whoever next edits it.
  { key: 'settings.language.blurb', group: 'Settings', label: 'Language — blurb',
    def: 'Kept on this device. The game\'s own words change; what other players wrote — level titles, comments, dares — stays in whatever language they wrote it.' },
  { key: 'settings.graphics.blurb', group: 'Settings', label: 'Graphics — blurb',
    def: 'How the game looks, on this device. Nothing simulates differently in any of these, and thumbnails and share cards stay standard so what you publish looks the same to everybody — but clips record the style you play in.' },

  // ---- Import (2026-08-10) ----
  //
  // The one screen that explains a FORMAT, which is the kind of thing that
  // gets clarified repeatedly as real pastes turn up. The code table under it
  // stays code: it is generated from the parser's own vocabulary, so a hand-
  // edited copy of it would be a second source of truth that goes stale.
  // Short on purpose (2026-08-10, on request). The old lede spelled out the
  // whole grammar — every code's mapping, the separators, the coordinate
  // frame — above a screen that already lists the codes in a table, shows the
  // result live, and says what it did in its own warnings. A lede is for
  // telling somebody they are in the right place.
  { key: 'import.lede', group: 'Import', label: 'Page lede',
    def: 'FCML in various formats can be converted. Paste it in and watch the preview.' },
  { key: 'import.draft', group: 'Import', label: 'What happens on import',
    def: 'Imports land in the Level Maker as a local draft — play-test it there, fix anything the warnings flagged, then Save to publish it to the Workshop. An imported machine arrives as the level\'s own, on the Level tab, where it can be edited or deleted like anything else you built there.' },
];

// ---------- the help page's shape (§18) ----------
//
// **Four PARTS, because there are four different people at that door.**
// Somebody who has never played, somebody who wants to author a level,
// somebody finishing a machine by millimetres, and somebody arriving from
// Fantastic Contraption are not at different points of one journey — they
// want different pages, and the `?` in the nav is the only place any of them
// will look. So the parts are the top level, each is a real URL.
//
// FC has no chapters: it is a written page (`fcBody()` in main.js) rather than
// a stepped tour, because its reader already knows how to build and wants a
// list of differences to scan, not a sequence to walk.
export const TOUR_PARTS = [
  { id: 'beginner', name: 'Beginner', href: '/learn',
    tagline: 'Never played? Start here — five minutes to your first win' },
  { id: 'maker', name: 'Level Maker', href: '/learn/maker',
    tagline: 'Build a level of your own, in as much detail as you want' },
  { id: 'advanced', name: 'Advanced', href: '/learn/advanced',
    tagline: 'GhostRun, pin sweeps, and the rest of the toolkit' },
  { id: 'fc', name: 'FC', href: '/learn/fc',
    tagline: 'Coming from Fantastic Contraption? Just the differences' },
];

// **The structure, as data, so a gate can hold it against the registry.**
// Chapters in order of NEED: Play alone is a complete game, and every chapter
// after it is a place to come back to rather than a wall to climb first —
// that is what keeps the extra detail from scaring anybody off. The shell in
// main.js renders whatever is listed here; each step id maps to
// `tour.<id>.title` / `.body` / optionally `.more` above, and to a `show()`
// builder in main.js. Every chapter names the PART it belongs to, and
// verify-tutorial.mjs fails if the three files disagree about what exists.
export const TOUR_PLAN = [
  { id: 'play', part: 'beginner', name: 'Play', tagline: 'Enough to enjoy yourself — five minutes',
    steps: ['play.pink', 'play.built', 'play.try', 'play.join', 'play.wheels', 'play.go'] },
  { id: 'build', part: 'beginner', name: 'Build smarter', tagline: 'The tools that turn tries into machines',
    steps: ['build.ask', 'build.solo', 'build.weight', 'build.gravity', 'build.ground', 'build.ropes'] },
  { id: 'win', part: 'beginner', name: 'Compete', tagline: 'Badges, dares, and other people',
    steps: ['win.badges', 'win.dare', 'win.out'] },

  { id: 'bones', part: 'maker', name: 'The bones', tagline: 'What a level is actually made of',
    steps: ['make.three', 'make.build', 'make.goal', 'make.terrain', 'make.props', 'make.pins'] },
  { id: 'hands', part: 'maker', name: 'In the hand', tagline: 'The Create tab, and how to work fast in it',
    steps: ['make.right', 'make.sliders', 'make.select', 'make.copy', 'make.grid'] },
  { id: 'alive', part: 'maker', name: 'Make it move', tagline: 'Level pieces, paths, spin and groups',
    steps: ['make.parts', 'make.path', 'make.spin', 'make.groups'] },
  { id: 'ship', part: 'maker', name: 'Publish it', tagline: 'Beat your own level, then let it go',
    steps: ['make.beat', 'make.publish'] },

  { id: 'advbar', part: 'advanced', name: 'The Advanced bar', tagline: 'Turn it on, then use it',
    steps: ['adv.mode', 'adv.bar'] },
  { id: 'ghost', part: 'advanced', name: 'Ghost mode', tagline: 'Edit against a second of the future',
    steps: ['adv.ghost', 'adv.road', 'adv.tweak'] },
];

const BY_KEY = new Map(CONTENT.map(c => [c.key, c]));

// ---------- the live overrides ----------
//
// One fetch at boot. A key with no override, an override that is blank, or a
// server that could not be reached all fall back to the shipped default, so the
// worst case for this whole feature is the site as written.
let overrides = {};
export function setOverrides(map) { overrides = map && typeof map === 'object' ? map : {}; }
export function allOverrides() { return { ...overrides }; }

export function txt(key) {
  // In another language the shipped translation outranks the admin's override:
  // the override was written in English against the English default, and
  // "edited more recently" is not "right in Russian". A key the translation
  // set is missing falls through to the override chain, so the worst case is
  // one paragraph in English rather than a blank.
  if (langOf() !== 'en') {
    const tr = contentTranslation(key);
    if (tr) return tr;
  }
  const o = overrides[key];
  if (typeof o === 'string' && o.trim()) return o;
  return BY_KEY.get(key)?.def ?? '';
}
export function isOverridden(key) {
  const o = overrides[key];
  return typeof o === 'string' && o.trim() && o !== BY_KEY.get(key)?.def;
}
export function defaultOf(key) { return BY_KEY.get(key)?.def ?? ''; }
