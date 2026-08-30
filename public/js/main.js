// main.js — app shell: path router + every screen (§12 client routes).

import { $, el, esc, appendAll, store, fmtTime, fmtKg, fmtDate, fmtDateTime, timeAgo, starStr, starRating, difficultyRating, difficultyWord, computeBadges, badgeRow, badgeEl, installTooltips, BADGE_DEFS, CORNER_RADIUS_DEFAULT, CORNER_RADIUS_LARGE, fmtCountdown, challengeTerms, challengeTip, cleanMessage, MESSAGE_MAX, badgeRank, badgeDef, BADGE_RANKS, undoReturnsToMaker, nextCampaignLevel, prevCampaignLevel, routeParts, pathFromHash, go, hideTip, refreshTip, liveChallenges, challengeChipEl, countdownText, migrateProgressToIds, navShown,
 HUD_THEMES, HUD_DENSITIES, applyHudPrefs, installSliderRelease } from './util.js';
import { initBox2D, Simulation } from './sim.js';
import { renderPreview, shareCardDataUrl, wordmarkSVG, faviconSVG, COLORS, BACKGROUNDS, drawBackdrop,
 drawTerrainAll, drawZones, drawWheel, drawRod, drawRods, liveRods, wheelCargoBackToFront, goalStackR, drawGoalPiece, drawProp, drawPinDot,
 textureTile, toolIconSVG, zOrderIconSVG, ghostIconSVG, freeWorldIconSVG, mouseButtonIconSVG, navArrowSVG, textureSwatchURL } from './render.js';
import { api } from './api.js';
import { GameScreen, MACHINE_TOOLS, LEVEL_TOOLS, toolBadge, toolOther } from './game.js';
import { SETS, setOfSlot, newMakerLevel, formatCampaignRange, normalizeCampaigns } from './levels.js';
import { convertFcLevel, levelData as fcLevelData, DEFAULT_SCALE as FC_DEFAULT_SCALE, SCALE_DECIMALS as FC_SCALE_DECIMALS, FC_DEFAULT_TEXTURE } from './fcimport.js';
import { TEXTURES } from './surfaces.js';
import { CONTENT, TOUR_PLAN, TOUR_PARTS, txt, parseRich, setOverrides, allOverrides, defaultOf, isOverridden } from './content.js';
import { CART_LEVEL, CART_DESIGN, CATAPULT_LEVEL, CATAPULT_DESIGN, DEMO_LOOP_S,
 STAND_LEVEL, STAND_JOINED, STAND_LOOSE, LANE_LEVEL, laneCart, SKELETON_LEVEL,
 SOLO_LEVEL, SOLO_DESIGN, SOLO_BARE, BEAM_LEVEL, BEAM_LIGHT, BEAM_HEAVY, GRIP_LEVEL, GRIP_SHOWN,
 BELT_LEVEL, MOVER_LEVEL, MOVER_DESIGN, TWO_ZONE_LEVEL,
 ZONE_ROOMY, ZONE_TIGHT, GOALS_LEVEL, TERRAIN_LEVEL, PROPS_LEVEL, PIN_LEVEL,
 PARTS_LEVEL, GRID_LOOSE, GRID_SNAPPED, SPIN_LEVEL, LIFT_LEVEL } from './tutorial-demos.js';
import {
 initAudio, setAudioSuspended, soundSettings, setSoundSettings, auditionSection,
 SOUND_SECTIONS, SECTION_KEYS, SOUND_THEMES, THEME_KEYS,
} from './audio.js';
import { GFX_STYLES, GFX_KEYS, gfxSettings, setGfxStyle, gfxIsPost, applyGfx, ensureGfxDefs } from './gfx.js';
import { initI18n, setLang, langOf, LANGS, flagSVG, t, tf } from './i18n.js';

let appEl, mainEl, navUserEl;
let currentScreen = null;
// Server-side switches the UI has to respect. Fetched once at boot; if the
// call fails we assume the permissive default and let the server refuse — an
// unreachable server shouldn't decide what the interface offers.
let config = { registrationOpen: true, freeSlots: 32, campaigns: SETS };

// ---------- boot ----------

export async function boot() {
 appEl = $('#app');
 appEl.innerHTML = '';
 installTooltips();
 // Before the first el() call, because el() is where translation happens: a
 // splash drawn first would flash English at everybody else. One same-origin
 // fetch, and English (or a failed fetch) costs nothing at all.
 await initI18n();
 // the stored theme/density, before anything paints — a dark-theme user must
 // not get a white flash while the wasm warms up
 applyHudPrefs(appEl);
 // …and sliders hand the keyboard back when the pointer lets go, everywhere
 installSliderRelease();
 const splash = el('div', { class: 'splash' },
 el('div', { class: 'splash-mark', html: wordmarkSVG(40) }),
 el('p', { class: 'muted' }, 'warming up the physics…'));
 appEl.append(splash);

 // favicon from the L-wheel
 const fav = document.createElement('link');
 fav.rel = 'icon';
 fav.href = 'data:image/svg+xml,' + encodeURIComponent(faviconSVG());
 document.head.append(fav);

 try {
 await initBox2D('/vendor/fcsim/fcsim.wasm'); // FC's own engine (2026-08-17)
 } catch (err) {
 console.error(err);
 splash.innerHTML = '';
 splash.append(
 el('h2', {}, 'Physics failed to load'),
 el('p', { class: 'muted' }, String(err?.message || err)),
 el('button', { class: 'btn primary', onclick: () => location.reload() }, 'Retry'));
 return;
 }

 await api.me(); // refresh cached user, self-heal stale localStorage
 // Both before the first paint, and both non-fatal. The text overrides (§13.1)
 // fall back to the shipped defaults in content.js if the call fails, so an
 // unreachable server costs the site its admin edits, not its words.
 config = await api.config();
 if (!Array.isArray(config.campaigns) || !config.campaigns.length) config.campaigns = SETS;
 setOverrides(await api.content());

 appEl.innerHTML = '';
 const nav = el('nav', { class: 'nav' },
 el('a', { class: 'brand', href: '/', html: wordmarkSVG(22) }),
 // "Campaign" and not "Challenges": a challenge is now a competition inside
 // the Workshop (§11.8), and the nav can't use the same word for the 32
 // authored levels. Campaign is what the game has always called them
 // (§11.2) and it carries the sense of a progression the four pages have.
 el('a', { class: 'nav-link', href: '/campaign', title: 'All the current campaigns are listed here. Enjoy!' }, 'Campaigns'),
 el('a', { class: 'nav-link', href: '/browse', title: 'Levels by everybody else — play them, rate them, take on a challenge' }, 'Workshop'),
 el('a', { class: 'nav-link', href: '/maker', title: 'Build a level of your own, and publish it to the Workshop' }, 'Maker'),
 // **Import is NOT in the nav**, and the route is untouched — `/import`
 // still works, and every link to it still lands. It sat between Maker and
 // the help icons advertising a thing almost nobody does, and the one group
 // who DO have a pile of levels to bring across are the people arriving from
 // Fantastic Contraption, who have their own page. The door is on that page
 // now, where the people who want it already are.
 // **One help door, four parts behind it** (§18). FC used to be a nav tab
 // of its own, on the reasoning that somebody arriving from Fantastic
 // Contraption will not open a tutorial — which was right about the old `?`,
 // a single beginner's tour with the differences buried in step six. It is
 // not right about this one: `?` now opens a page whose top row is
 // Beginner / Level Maker / Advanced / FC, so the differences — and GhostRun
 // — are one visible click from the door rather than hidden in a sequence.
 // Two letters of nav have gone back to being one icon, and `/fc` still routes.
 el('a', { class: 'nav-link nav-icon', href: '/learn', title: 'Help — playing, making levels, advanced use, and coming from FC' }, '?'),
 // A cog, not the ♪ it was. The screen behind it stopped being sound-only
 // when the password panel landed there (§13.1), and a music note is a
 // promise about what is on a page — somebody looking for their password
 // would never open it.
 el('a', { class: 'nav-link nav-icon', href: '/settings', title: 'Settings — theme, language, graphics, sound, password' }, '⚙'),
 // The globe is a menu, not a page: somebody staring at an interface in the
 // wrong language needs the way out to be one icon deep, not behind a cog
 // whose label they cannot read. The href is real so the link still lands
 // somewhere sensible if the menu ever fails to open; pageMenu's
 // preventDefault is what keeps it a menu the rest of the time. The names
 // are endonyms and never translated — 日本語 is its own translation.
 el('a', {
 class: 'nav-link nav-icon', href: '/settings', title: 'Language',
 onclick: (e) => pageMenu(e, null, LANGS.map((l) => ({
 label: l.name, on: l.code === langOf(), icon: flagSVG(l.code),
 onclick: () => { if (l.code !== langOf() && setLang(l.code)) location.reload(); },
 }))),
 }, '🌐'),
 el('a', { class: 'nav-link nav-icon', href: '/support', title: 'Support' }, '♥'),
 el('span', { class: 'spacer' }),
 navUserEl = el('span', { class: 'nav-user' }),
 );
 // The L of the wordmark, as a button (§10.4 — faviconSVG IS the L-wheel
 // alone). Only the stylesheet ever shows it: coarse pointer, game screen,
 // nav away. Its tap is handled with the other peek inputs below.
 const navKnob = el('button', { class: 'nav-knob', 'aria-label': 'Menu', title: 'Menu', html: faviconSVG(22) });
 mainEl = el('main', { class: 'main' });
 appEl.append(nav, navKnob, mainEl);
 renderNavUser();

 // **The nav hides itself while a game is up** (2026-08-11, on request). Which
 // screens and what moves is the stylesheet's half (`#app:has(.main.full)`,
 // where the fixed nav lets the level's own bar rise to the top of the
 // screen); the rule for when it comes back is `navShown` in util.js, which is
 // where the two thresholds live so a gate can hold them.
 //
 // Nothing here needs to know about routes: `.main.full` is the state, and the
 // class this toggles does nothing on a screen that isn't one. Hover events
 // skip touch — a finger cannot hover in the top three pixels — so a finger
 // gets the knob instead: its tap says y=0, the strip's own number, and any
 // other tap reports where it landed, which is exactly what `navShown` asks.
 // Same thresholds, same function, two input styles.
 let navPeeking = false;
 const navPeek = (y) => {
 const on = navShown(y, nav.offsetHeight, navPeeking);
 if (on === navPeeking) return;
 navPeeking = on;
 appEl.classList.toggle('nav-peek', on);
 };
 window.addEventListener('pointermove', (e) => {
 if (e.pointerType === 'touch') return;
 navPeek(e.clientY);
 }, { passive: true });
 // Leaving the window over the TOP edge is the pointer on its way to the
 // browser's own chrome and back; anywhere else it has gone for good. Same
 // rule, same numbers — a negative clientY is inside the reveal strip.
 document.documentElement.addEventListener('pointerleave', (e) => {
 if (e.pointerType === 'touch') return;
 navPeek(e.clientY);
 });
 // The finger's half of the same rule (2026-08-14, on request). The knob's
 // tap is the top strip; every other tap is the pointer's position; a tap on
 // the peeked nav lands inside navH+8 and keeps it, one below sends it away.
 // click rather than pointerdown for the knob itself, so a keyboard's Enter
 // on the focused button opens the nav the same way a finger does.
 navKnob.addEventListener('click', () => navPeek(0));
 window.addEventListener('pointerdown', (e) => {
 if (e.pointerType !== 'touch') return;
 if (e.target instanceof Node && navKnob.contains(e.target)) return;
 navPeek(e.clientY);
 }, { passive: true });

 // One pipe for every navigation: the browser's back/forward buttons fire
 // popstate natively, and `go()` dispatches a synthetic one after pushState.
 window.addEventListener('popstate', route);

 // **Every in-app link becomes a pushState.** Delegated from the document, so
 // the forty-odd <a href="/…"> in this file need no click handler of their
 // own and no future one can forget to add it. Everything a browser is
 // supposed to keep doing is left alone: modified clicks (open in a new tab),
 // middle clicks, downloads, `target`, and anything off this origin.
 document.addEventListener('click', (e) => {
 if (e.defaultPrevented || e.button !== 0) return;
 if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
 const a = e.target?.closest?.('a');
 if (!a || a.hasAttribute('download')) return;
 if (a.target && a.target !== '_self') return;
 const href = a.getAttribute('href');
 if (!href) return;
 const fromHash = pathFromHash(href);
 if (fromHash) { e.preventDefault(); go(fromHash); return; }
 if (href.startsWith('#')) return; // an in-page anchor is not a route
 let url;
 try { url = new URL(a.href, location.href); } catch { return; }
 if (url.origin !== location.origin) return;
 e.preventDefault();
 go(url.pathname + url.search);
 });
 // Browsers refuse to start an AudioContext outside a user gesture, and a
 // context can be suspended again by the platform at any time — so this stays
 // subscribed rather than firing once. initAudio() is a no-op when the context
 // already exists and running, so the steady-state cost is a function call.
 window.addEventListener('pointerdown', () => initAudio(), { passive: true });
 window.addEventListener('keydown', () => initAudio(), { passive: true });
 // a backgrounded tab should be silent, and should not be mixing audio at all
 document.addEventListener('visibilitychange', () => setAudioSuspended(document.hidden));
 watchForNewBuild();
 const legacy = pathFromHash(location.hash);
 if (legacy) history.replaceState(null, '', legacy);
 route();
}

// ---------- stale-tab detector ----------
//
// The app is a single page: opening another level in an open tab
// re-renders a screen without re-fetching a single module. A tab left open
// across an edit keeps running the OLD code while showing the NEW level, and
// the bug you then chase is one that was fixed on disk (§16). Nothing about
// cache headers helps: nothing is being fetched to revalidate.
//
// So the tab asks, quietly, whether the client files have changed under it —
// on refocus, which is precisely when someone comes back from an editor. No
// polling, no timer, nothing while you are actually using the page.
function watchForNewBuild() {
 const loaded = config.build;
 if (!loaded) return; // older server, or the config call failed
 let dismissed = null;
 let last = 0;
 let note = null;

 const show = (build) => {
 if (note || dismissed === build) return;
 const reload = el('button', { class: 'btn tiny primary', onclick: () => location.reload() }, 'Reload');
 const close = el('button', {
 class: 'btn tiny ghost build-note-x', title: 'Dismiss — this build won\'t ask again',
 onclick: () => { dismissed = build; note.remove(); note = null; },
 }, '✕');
 note = el('div', { class: 'build-note' },
 el('span', {}, 'Newer build on the server'), reload, close);
 document.body.append(note);
 };

 const check = async () => {
 if (document.hidden) return;
 const now = Date.now();
 if (now - last < 4000) return; // a refocus burst is one question
 last = now;
 try {
 const c = await api.config();
 if (c.build && c.build !== loaded) show(c.build);
 } catch { /* offline — say nothing */ }
 };

 document.addEventListener('visibilitychange', check);
 window.addEventListener('focus', check);
}

function renderNavUser() {
 navUserEl.innerHTML = '';
 const u = api.user();
 if (u) {
 appendAll(navUserEl,
 u.isAdmin ? el('a', { class: 'nav-link', href: '/admin' }, '🛠 Admin') : null,
 (u.isModerator || u.isAdmin) ? el('a', { class: 'nav-link', href: '/moderation' }, '🚩 Moderation') : null,
 el('a', { class: 'nav-link points', href: '/user/' + encodeURIComponent(u.name), title: 'Points (worth nothing)' },
 crownFor(u) + '⬡ ' + (u.points ?? 0)),
 el('a', { class: 'nav-link user', href: '/user/' + encodeURIComponent(u.name), title: 'Your profile — your levels, your saved runs, and where your points went' }, u.name),
 el('button', { class: 'btn ghost tiny', onclick: async () => { await api.logout(); renderNavUser(); route(); } }, 'Sign out'),
 );
 } else {
 // appendAll, not append: a conditional null goes through native append as
 // the literal text "null" (see util.js) — which is exactly what this grew
 // the moment Join became conditional
 appendAll(navUserEl,
 el('button', { class: 'btn ghost tiny', onclick: () => authModal('login') }, 'Sign in'),
 // invite-only: offering "Join" when the route refuses is just a button
 // that apologises
 config.registrationOpen
 ? el('button', { class: 'btn primary tiny', onclick: () => authModal('register') }, 'Join')
 : null,
 );
 }
}

function crownFor(u) {
 return u?.crown === 'gold' ? '👑 ' : u?.crown === 'silver' ? '🥈 ' : '';
}

// ---------- Ctrl+Z after clicking away from the Maker ----------
//
// The site nav sits above the editor, so one stray click on it takes the whole
// screen away mid-build. The draft itself is safe — the Maker autosaves on every
// commit — but you are no longer looking at it, and clicking "Maker" again does
// NOT bring you back: with no draft id in the hash that route mints a fresh one,
// so an accidental click looks exactly like losing the level. Asked for as
// "ability to Ctrl-Z if you accidentally click away from the Maker screen":
// Ctrl+Z is the undo key everywhere in this app, and leaving by accident is the
// thing there is to undo.
//
// The last Maker route is remembered on teardown, and Ctrl+Z anywhere else goes
// back to it. Returning does not consume it (undoing the same accident twice is
// not a mistake you can make), and it stands down inside the Maker, where Ctrl+Z
// is the editor's own undo — GameScreen binds its own window listener, so this
// one checks the route rather than trusting listener order.
//
// What it does NOT restore is the undo STACK: that is 150 level snapshots held in
// memory, and putting it in localStorage would risk the quota for the sake of a
// history nobody has asked to outlive the screen. You come back to your level
// exactly as you left it; the history behind it starts fresh.
let makerReturn = null;
// …and the way OUT of it: the last route that was not a Maker, remembered by
// the router as it leaves each screen, so the editor's own Back returns to
// where you came from (2026-08-19: "Campaign -> Level 11 -> Open In
// Level Maker -> Back -> ??? Main Page ??? I would like to be back at Level
// 11"). A Maker opened cold (a pasted link) has nowhere to go but home.
let makerFrom = null;
let routedPath = null; // the path the router last mounted, whatever it was
let returnNote = null;
// Set for the one navigation that IS the return. Without it the trip back
// records the screen it is leaving, so `makerReturn` ends up pointing at the
// blank draft you just escaped and a second Ctrl+Z bounces you into it — a
// ping-pong between two levels, with the key alternating between them. Going
// back is not an accident to be undone.
let returningToMaker = false;

function goBackToMaker() {
 const to = makerReturn;
 if (!to) return;
 returningToMaker = true;
 clearReturnNote();
 go(to);
}

function clearReturnNote() {
 returnNote?.remove();
 returnNote = null;
}

// Shown only when the departure was NOT the editor's own Back button: a
// deliberate exit needs no offer to undo it, and would be nagged by one.
//
// **It survives the next navigation**, and that is the point of it. It used to
// clear on any route change, which meant that clicking away and then clicking
// anything else took the offer off the screen — leaving a shortcut that still
// worked and nothing on the page saying so. An accident does not become less of
// an accident because you clicked once more afterwards. It goes when it is used,
// when it is dismissed, or when you are back in the Maker; nowhere else.
//
// It also covers the one case the keyboard cannot: Ctrl+Z stands down while the
// focus is in a text field (there it is the field's own undo), so on a page with
// a search box the BUTTON is the way back.
function showReturnNote() {
 clearReturnNote();
 returnNote = el('div', { class: 'build-note return-note' },
 el('span', {}, 'Left the Maker — your draft is saved'),
 el('button', {
 class: 'btn tiny primary',
 onclick: goBackToMaker,
 }, '⤺ Back (Ctrl+Z)'),
 el('button', { class: 'btn tiny ghost build-note-x', title: 'Dismiss', onclick: clearReturnNote }, '✕'));
 document.body.append(returnNote);
}

function leftMaker(path, { deliberate }) {
 // The trip BACK records nothing: it is the undo, not another thing to undo.
 if (returningToMaker) { returningToMaker = false; return; }
 // '/maker' with no id never mounted anything — it redirects to a minted id,
 // and sending someone "back" to it would mint another empty draft
 if (!/^\/maker\/.+/.test(path || '')) return;
 makerReturn = path;
 if (!deliberate) showReturnNote();
}

function isTypingIn(target) {
 const tag = target?.tagName;
 return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

// **Ctrl+Z brings back the last level of the session, from anywhere — including
// from inside a fresh, empty Maker.**
//
// That last part is the whole of it, and it was missing. Clicking "Maker" in the
// nav does not reopen what you were working on: with no draft id in the hash the
// route MINTS a new one, so you land on a blank editor. Pressing Ctrl+Z there
// used to do nothing at all, because this handler stood down inside `#/maker`
// and the editor's own undo had an empty stack to work with — the one place the
// shortcut was most obviously wanted was the one place it was refused.
//
// So the rule is: the editor's undo comes FIRST, always. Only when it has
// nothing left of its own (`canUndo()`) does Ctrl+Z mean "and before this level,
// I was in another one". It can never eat an edit — a level with a single
// change in it answers `canUndo()` true and keeps the key.
window.addEventListener('keydown', (e) => {
 if (!makerReturn || !e.ctrlKey || e.shiftKey || e.altKey) return;
 if ((e.key || '').toLowerCase() !== 'z') return;
 if (isTypingIn(e.target)) return;
 // The whole decision is `undoReturnsToMaker` in util.js — a pure predicate
 // living where a gate can reach it, because this rule shipped wrong once and
 // nothing headless could have caught it here (§8.2).
 if (!undoReturnsToMaker({
 path: location.pathname,
 makerReturn,
 canUndo: !!currentScreen?.canUndo?.(),
 })) return;
 e.preventDefault();
 goBackToMaker();
});

// ---------- router ----------

function route() {
 // **Paths, not a hash.** The `#` is gone (§12): the router reads
 // location.pathname, `go()` pushStates, and a delegated click handler turns
 // every in-app <a> into a pushState instead of a page load. What that buys
 // is that every URL in the app is a real URL the server sees — which is the
 // whole reason a level link can unfurl in Discord at all (§11.10).
 const path = location.pathname || '/';
 // routeParts, not a raw split: it drops empty segments and decodes each one
 // without throwing on a link clipped mid-escape (util.js has the gate).
 const parts = routeParts(path);
 hideTip(); // a tip left showing across a navigation is stranded on nothing
 // The note goes when you are back at THAT LEVEL and not before (see
 // showReturnNote): an offer to undo an accident that expires on the next click
 // is an offer you will miss. Matched against the remembered route rather than
 // "any Maker screen", because the case it exists for is landing in a DIFFERENT
 // Maker — clicking "Maker" in the nav mints a blank draft, and a blank editor
 // is exactly where you most need telling that your level is one key away.
 // Cleared ahead of the teardown that may create a fresh one, so leaving again
 // re-offers rather than stacking.
 if (path === makerReturn) clearReturnNote();
 // the screen being left is where a Maker opened NEXT will return to — unless
 // it was itself a Maker (a draft minted from a draft keeps the older origin)
 if (routedPath != null && !/^\/maker(\/|$)/.test(routedPath)) makerFrom = routedPath;
 // Play ‹ › / Back follow WHERE they opened the level, not whether it is
 // also a campaign slot. Set only when leaving Workshop or Campaign; play→play
 // (next/prev) keeps the origin so an official Workshop level stays Workshop.
 if (routedPath != null) {
 if (routedPath.startsWith('/browse')) store.set(PLAY_NAV_KEY, 'workshop');
 else if (routedPath.startsWith('/campaign')) store.set(PLAY_NAV_KEY, 'campaign');
 else if (!routedPath.startsWith('/play')) store.set(PLAY_NAV_KEY, null);
 }
 routedPath = path + (location.search || '');
 currentScreen?.destroy?.();
 currentScreen = null;
 mainEl.innerHTML = '';
 mainEl.className = 'main';
 window.scrollTo(0, 0);

 // an empty path IS the home page — routeParts drops the empty segments, so
 // "/" arrives here as [] and needs no string comparison
 if (!parts.length) return homeScreen();
 switch (parts[0]) {
 case 'campaign': return campaignScreen(parts[1] || null); // /campaign is the hub, /campaign/<set> one set
 case 'browse': return browseScreen();
 case 'play': return playScreen(parts[1], parts[2]);
 case 'maker':
 if (parts[1] === 'official' && parts[2]) return makerScreen({ officialId: parts[2] });
 // …and the same door for an ordinary author on their OWN level (§11.9).
 // Same machinery as the admin path — load the server record, save back to
 // it — and a separate route only so the wording, and the server's own
 // rules, can tell an author's edit from an admin's.
 if (parts[1] === 'level' && parts[2]) return makerScreen({ levelId: parts[2] });
 return makerScreen({ draftId: parts[1] });
 case 'import': return importScreen();
 // The .fcxml door (2026-08-18): fc-open.cmd stashed a design file on the
 // server and opened the browser here; convert at the import screen's
 // defaults and land in the Maker with the machine on the Test tab.
 case 'fcimport': return fcFileScreen(parts[1]);
 case 'user': return userScreen(parts[1]);
 case 'settings': return settingsScreen();
 case 'keys': return keysScreen();
 case 'support': return supportScreen();
 // `/learn`, `/learn/maker`, `/learn/advanced`, `/learn/fc` — one screen, four parts (§18).
 case 'learn': return learnScreen(parts[1]);
 // **`/fc` is kept alive rather than redirected.** It is the URL that has
 // been handed to FC players in chat rooms and comments, and a link that
 // 404s is worse than a link that lands somewhere honest — it lands on the
 // FC part, which is exactly what it always did.
 case 'fc': return learnScreen('fc');
 case 'admin': return adminScreen();
 case 'moderation': return moderationScreen();
 default: return homeScreen();
 }
}

// ---------- home ----------

function homeScreen() {
 document.title = 'LIFIRIK';
 mainEl.append(
 el('section', { class: 'hero' },
 el('div', { class: 'hero-mark', html: wordmarkSVG(64) }),
 el('p', { class: 'hero-tag' }, txt('home.tagline')),
 el('p', { class: 'hero-sub' }, txt('home.sub')),
 el('div', { class: 'hero-actions' },
 el('a', { class: 'btn primary big', href: '/campaign' }, '▶ Play the Campaign'),
 el('a', { class: 'btn big', href: '/browse' }, 'Community Workshop'),
 el('a', { class: 'btn big', href: '/maker' }, 'Level Maker'),
 // A plain button like its three neighbours (2026-08-23, on report:
 // *"'How to play' on entry screen needs a button surround to match
 // others."*). It wore `.ghost` — transparent border, invisible until
 // hovered — which de-emphasised the one action a NEW player is here
 // for. The row reads as four doors now, not three doors and a draught.
 // The `.ghost` "All the controls" links inside the learn pages keep
 // theirs: there it is a footnote under prose, not a peer in a row.
 el('a', { class: 'btn big', href: '/learn' }, 'How to play'),
 )),
 );
 const feat = el('section', { class: 'cards-row' });
 mainEl.append(el('h2', { class: 'section-title' }, txt('home.fresh')), feat);
 api.levels({ sort: 'new' }).then(list => {
 for (const rec of list.slice(0, 8)) feat.append(levelCard(rec));
 if (!list.length) feat.append(el('p', { class: 'muted' }, 'Nothing published yet — be the first.'));
 }).catch(() => feat.append(el('p', { class: 'muted' }, 'Workshop is offline.')));
}

// ---------- campaign (the 32 authored levels) ----------
//
// Not to be confused with a Challenge (§11.8), which is a competition on a
// Workshop level. These are the authored levels, in four pages of eight, and
// the word for them everywhere in the code and the UI is "campaign".

// **The campaign is a HUB of set cards, and each set is its own page**
// (2026-08-18, on request: "intro cards for the series packs — 4× thumbnails
// of first levels in the series, description text of what to expect, and when
// you click it, it goes through to the N levels in that series. Two columns.").
// `/campaign` draws one card per set — a 2×2 of the set's first four level
// thumbnails, its name and introduction, how many levels and how many of them
// you've solved — and `/campaign/<setId>` is that set alone, drawn exactly as
// the whole-campaign page used to draw it (Starters keeps its four parts).
// A set that is empty on this server draws no card, and any level past the
// last named set is still reachable through a "More" card, so the campaign
// screen never hides a level it has.
function campaignScreen(setId = null) {
 document.title = t('Campaigns — LIFIRIK');
 let progress = store.get('progress', {});
 const wrap = el('div', { class: 'challenges' });
 const backLink = setId ? el('p', { class: 'muted campaign-back' }, el('a', { href: '/campaign' }, '‹ ' + t('All sets'))) : null;
 // appendAll, not append: a conditional null goes through native append as
 // the literal text "null" (util.js) — which is exactly what the hub showed
 appendAll(mainEl,
 el('h1', { class: 'page-title' },
 txt('campaign.title'),
 setId ? null : el('span', { class: 'page-byline' }, txt('campaign.sub'))),
 backLink,
 wrap);
 Promise.all([
 api.levels({ official: 1, sort: 'slot' }),
 api.campaigns().catch(() => ({ campaigns: config.campaigns || SETS })),
 ]).then(([rawList, campRes]) => {
 let list = rawList;
 // Progress was keyed by SLOT until an admin could move a level off its own
 // number (§13). This is the last moment the old mapping is still true, so
 // the carry-over happens here, once, before anything is drawn from it.
 // **A slotless `official` is not part of the campaign** (see campaignOrder,
 // server.js): this database carries some, and they have never appeared here
 // because the old grid asked for slots by number and they had none. Slicing
 // the list in order would have started rendering them, which is a change
 // nobody asked for — so the filter states out loud what the old lookup was
 // doing by accident.
 list = list.filter(l => l.slot != null);
 const moved = migrateProgressToIds(progress, list);
 if (moved) { store.set('progress', moved); progress = moved; }
 // **Campaigns are admin-defined slices** (Admin > Campaigns): each has a
 // title, a byline, and an inclusive 1-based range of campaign numbers.
 // Starters still draws its four sub-headed parts; any number past every
 // named range is still shown under More. Sliced by campaign number rather
 // than looked up slot by slot: the server keeps slots dense, so a gap
 // could never blank out a page even if one appeared.
 const cardFor = (rec) => {
 const done = progress[rec.id];
 // levels past the free window: shown to everyone (the card is the
 // advert), playable only signed-in — the server enforces the same line
 const locked = rec.slot >= (config.freeSlots ?? 32) && !api.user();
 return levelCard(rec, {
 corner: locked
 ? el('span', { class: 'card-lock', title: tf('Account is FREE! The first {n} levels you don\'t need an account. The account is just a place to save your solves etc.', { n: config.freeSlots ?? 16 }) }, '🔒')
 : done ? el('span', { class: 'card-done', title: tf('Solved in {time} · {n} pcs', { time: fmtTime(done.time), n: done.pieces }) }, '⭐') : null,
 subtitle: done ? tf('best {time} · {n} pcs · {kg}', { time: fmtTime(done.time), n: done.pieces, kg: fmtKg(done.kg) }) : null,
 showEdit: !!api.user()?.isAdmin,
 locked,
 });
 };
 const gridOf = (recs) => { const g = el('div', { class: 'cards-grid' }); for (const r of recs) g.append(cardFor(r)); return g; };
 const named = Array.isArray(campRes?.campaigns) && campRes.campaigns.length
 ? campRes.campaigns : (config.campaigns || SETS);
 config.campaigns = named;
 const lastNum = named.reduce((m, s) => Math.max(m, s.to || 0), 0);
 const numOf = (l) => (Number.isInteger(l.num) ? l.num : (l.slot != null ? l.slot + 1 : 0));
 const sets = list.some(l => numOf(l) > lastNum)
 ? [...named, { id: 'more', name: t('More'), title: t('More'), from: lastNum + 1, to: Infinity, byline: '', blurb: '' }]
 : named;
 const setName = (set) => set.title || set.name || txt('campaign.set.' + set.id + '.name') || t('Campaign');
 const setBlurb = (set) => set.byline || set.blurb || txt('campaign.set.' + set.id) || '';
 const membersOf = (set) => list.filter(l => {
 const n = numOf(l);
 return n >= set.from && n <= set.to;
 });

 // ---- the hub: one card per set ----
 if (!setId) {
 const hub = el('div', { class: 'set-cards' });
 for (const set of sets) {
 const members = membersOf(set);
 if (!members.length) continue; // an empty set is not a card
 const solved = members.filter(m => progress[m.id]).length;
 // Four equal quarters of the set: 1 thumb, then 4, then 16, then the
 // rest packed in. Empty slots stay as blanks so a short set still
 // reads as the same mosaic.
 const setThumb = (rec) => {
 const cv = el('canvas', { class: 'set-thumb', width: 264, height: 148 });
 if (rec?.preview) { try { renderPreview(cv, rec.preview); } catch { /* bad preview */ } }
 return rec ? cv : el('div', { class: 'set-thumb set-thumb-blank' });
 };
 const quarter = (cls, recs, slots, cols) => {
 const q = el('div', { class: 'set-q ' + cls });
 if (cols) q.style.setProperty('--cols', String(cols));
 for (let i = 0; i < slots; i++) q.append(setThumb(recs[i]));
 return q;
 };
 const q1 = members.slice(0, 1);
 const q4 = members.slice(1, 5);
 const q16 = members.slice(5, 21);
 const qAll = members.slice(21);
 const allCols = qAll.length > 16 ? Math.ceil(Math.sqrt(qAll.length)) : 4;
 const thumbs = el('div', { class: 'set-thumbs' },
 quarter('set-q-1', q1, 1),
 quarter('set-q-4', q4, 4),
 quarter('set-q-16', q16, 16),
 quarter('set-q-all', qAll, allCols * allCols, allCols));
 hub.append(el('a', { class: 'card set-card', href: '/campaign/' + encodeURIComponent(set.id) },
 thumbs,
 el('div', { class: 'set-card-body' },
 el('h2', { class: 'set-title' }, setName(set)),
 el('p', { class: 'muted set-blurb' }, setBlurb(set)),
 el('p', { class: 'set-count' },
 tf('{n} levels', { n: members.length })
 + (solved ? ' · ' + tf('{n} solved', { n: solved }) : '')
 + ' ›'))));
 }
 wrap.append(hub);
 if (!hub.children.length && list.length) wrap.append(el('p', { class: 'muted' }, t('No sets to show.')));
 if (!list.length) {
 wrap.append(el('p', { class: 'muted' },
 'No campaign levels found — run "npm run seed" on the server to install the 32.'));
 }
 return;
 }

 // ---- one set: its levels, drawn as the whole page used to be ----
 const chosen = sets.find(s => s.id === setId);
 if (!chosen) { wrap.append(el('p', { class: 'muted' }, t('No such set.'))); return; }
 document.title = setName(chosen) + ' — ' + t('Campaigns — LIFIRIK');
 for (const set of [chosen]) {
 const members = membersOf(set);
 const sec = el('section', { class: 'challenge-set' },
 el('h2', { class: 'set-title' }, setName(set)),
 // admin-editable (§13.1); levels.js still holds the shipped wording
 el('p', { class: 'muted set-blurb' }, setBlurb(set)));
 if (!members.length) { sec.append(el('p', { class: 'muted' }, t('Nothing in this set yet.'))); wrap.append(sec); continue; }
 const sections = (set.sections || []).filter((s) => Number.isInteger(s.from) && Number.isInteger(s.to));
 if (sections.length) {
 const claimed = new Set();
 for (const page of sections) {
 const recs = members.filter((l) => {
 const n = numOf(l);
 return n >= page.from && n <= page.to;
 });
 for (const r of recs) claimed.add(r.id);
 if (!recs.length) continue;
 sec.append(el('section', { class: 'challenge-page' },
 el('h3', {}, page.title || page.name),
 page.byline || page.blurb ? el('p', { class: 'muted' }, page.byline || page.blurb) : null,
 gridOf(recs)));
 }
 const leftover = members.filter((l) => !claimed.has(l.id));
 if (leftover.length) sec.append(gridOf(leftover));
 } else {
 sec.append(gridOf(members));
 }
 wrap.append(sec);
 }
 }).catch(() => wrap.append(el('p', { class: 'muted' }, 'Could not reach the server.')));
}

// ---------- browse (workshop) ----------

function browseScreen() {
 document.title = t('Workshop — LIFIRIK');
 // Remembered, like every other filtered list (§8.1): browsing the Workshop
 // is a search you refine, and the whole point of refining one is clicking
 // into a level and coming back to it — which used to reset the lot.
 const prefs = tablePrefs('browse', { sort: 'new', badge: new Set(), badgeNot: new Set(), done: '', author: '', q: '' });
 const state = prefs.state;
 const grid = el('div', { class: 'cards-grid' });
 const search = el('input', { class: 'input search', placeholder: 'Search title & comments…', value: state.q });
 // title/comment text lives on the server (comments never ship in the list
 // payload), so search re-fetches rather than filtering the already-loaded
 // page — debounced so it doesn't hit the API on every keystroke
 let searchT = null;
 search.addEventListener('input', () => {
 state.q = search.value.trim();
 clearTimeout(searchT);
 searchT = setTimeout(load, 250);
 });

 const authorInput = el('input', { class: 'input author', placeholder: 'Author…', value: state.author });
 authorInput.addEventListener('input', () => { state.author = authorInput.value.trim().toLowerCase(); refresh(); });

 const sortSel = el('select', { class: 'input', title: 'How the list is ordered' },
 el('option', { value: 'new' }, 'Newest'),
 el('option', { value: 'top' }, 'Top rated'),
 el('option', { value: 'played' }, 'Most played'),
 el('option', { value: 'slot' }, '# order'),
 // last in the list: it answers "where is the one I remember the name of",
 // which is a different question from the three rankings above it
 el('option', { value: 'alpha' }, 'Alphabetical'));
 sortSel.value = state.sort;
 sortSel.addEventListener('change', () => { state.sort = sortSel.value; load(); });

 // The same widget every other list uses (see badgeFilter) — it sits beside
 // the search box now rather than on a row of its own, because it is part of
 // the same question. `state.badge` is its set, so refresh() is unchanged.
 // Solved ✅ is the public-solve filter (Off → none → has), not a second
 // circle. The leftover `solved` select is folded into that badge once.
 if (state.solved === '0') { state.badge.delete('solved'); state.badgeNot.add('solved'); }
 else if (state.solved === '1') { state.badge.add('solved'); state.badgeNot.delete('solved'); }
 state.solved = '';
 const badges = badgeFilter(() => refresh(), [...state.badge], {
 exclude: [...state.badgeNot],
 });
 state.badge = badges.set;
 state.badgeNot = badges.exclude;
 const badgeBar = badges.el;
 const doneStar = triFilterBtn({
 key: 'done',
 state,
 glyph: { off: '⭐', none: '☆', yes: '⭐' },
 titles: {
 off: t('Off. Click for incomplete.'),
 none: t('Only incomplete. You have no star. Click for completed.'),
 yes: t('Only completed. You have the star. Click to turn off.'),
 },
 aria: t('Filter by whether you have completed this level'),
 onChange: () => refresh(),
 });

 // The 🏁 filter button that used to sit here is GONE: it re-fetched the list
 // with `challenge=1` to show exactly what the Challenges tab now shows, and
 // two doors to one view is one door too many. The server's `?challenge=1`
 // filter is untouched — it is still the right answer for an API caller.

 // Curated picks, above the chronological list. Hidden entirely when nothing
 // is featured yet, so an empty shelf never greets a first visitor.
 const featuredWrap = el('section', { class: 'featured-row hidden' });
 const featuredGrid = el('div', { class: 'cards-grid' });
 featuredWrap.append(
 el('h2', { class: 'section-title' }, txt('workshop.featured')),
 el('p', { class: 'muted' }, txt('workshop.featuredSub')),
 featuredGrid,
 );

 // Everything with a clock on it, on its own tab (§11.8).
 //
 // **The word "live" is not in it, deliberately.** A sealed race is a
 // challenge that has not opened yet — announced on purpose, countdown
 // running, nobody able to play it — so calling the tab Live would be wrong
 // about the ones most worth looking at.
 const chalWrap = el('section', { class: 'challenge-row' });
 const chalGrid = el('div', { class: 'cards-grid' });
 chalWrap.append(
 el('h2', { class: 'section-title' }, txt('workshop.challenges')),
 el('p', { class: 'muted' }, txt('workshop.challengesSub')),
 chalGrid,
 );

 // Two tabs, Levels first because that is what the Workshop IS — challenges
 // are an event on a level rather than a separate kind of thing. Both panels
 // render from the SAME fetched list (`all`), so switching costs nothing and
 // the two can never disagree about what exists.
 const tabBar = el('div', { class: 'page-tabs' });
 const chalCount = el('span', { class: 'page-tab-n' });
 const levelsPanel = el('section', { class: 'page-panel' },
 featuredWrap,
 // One row, same order as every other searchable list: text, author,
 // selects, badges (§8.2).
 el('div', { class: 'browse-search-row' }, search, authorInput, sortSel, doneStar, badgeBar),
 grid);
 const chalPanel = el('section', { class: 'page-panel hidden' }, chalWrap);
 const WORKSHOP_TAB_KEY = 'workshopTab';
 // Levels is the default and stays the default across visits unless you
 // deliberately went to Challenges last time.
 let openTab = store.get(WORKSHOP_TAB_KEY) === 'challenges' ? 'challenges' : 'levels';
 // Declared before showTab: that function reads `all`, and the first
 // showTab() used to run while `let all` was still in the temporal dead
 // zone — a throw that aborted load(), so every later search landed in
 // "Could not reach the server."
 let all = [];
 const showTab = (id) => {
 openTab = id;
 store.set(WORKSHOP_TAB_KEY, id);
 levelsPanel.classList.toggle('hidden', id !== 'levels');
 chalPanel.classList.toggle('hidden', id !== 'challenges');
 for (const b of tabBar.children) b.classList.toggle('on', b.dataset.tab === id);
 // the queue is the list this tab is showing, so ‹ › from a Challenges
 // card walks challenges, not the Levels sort underneath
 if (all.length) saveWorkshopQueue(id === 'challenges' ? all.filter(isLiveChallenge) : workshopFiltered(all, state));
 };
 tabBar.append(
 el('button', { class: 'page-tab', dataset: { tab: 'levels' }, onclick: () => showTab('levels'),
 title: 'Every published level, filterable and sortable' }, 'Levels'),
 el('button', { class: 'page-tab', dataset: { tab: 'challenges' }, onclick: () => showTab('challenges'),
 title: 'Open challenges — beat the poster’s run before it ends and see their machine' }, 'Challenges', chalCount));

 mainEl.append(
 el('h1', { class: 'page-title' },
 txt('workshop.title'),
 el('span', { class: 'page-byline' }, txt('workshop.sub'))),
 tabBar,
 levelsPanel,
 chalPanel,
 );
 showTab(openTab);

 // The ⭐ the campaign grid has always worn, on Workshop cards too (§11.6).
 // Progress became id-keyed for every level when the campaign's numbers became
 // movable, and a star that only ever appeared on 32 of the levels you'd
 // solved read as the Workshop not counting. The corner alone, though — the
 // campaign replaces its subtitle with your best run, but a Workshop card's
 // subtitle is the author and the ratings, which is what you browse BY, so
 // the best run rides the star's tooltip instead.
 const doneCorner = (progress, rec) => {
 const done = progress[rec.id];
 return done ? el('span', { class: 'card-done', title: tf('Solved in {time} · {n} pcs', { time: fmtTime(done.time), n: done.pieces }) }, '⭐') : null;
 };
 function refresh() {
 prefs.save(); // every control repaints, so one save here catches them all
 const progress = store.get('progress', {});
 grid.innerHTML = '';
 // a sealed race has no badges to match on — filtering by badge is asking a
 // question about solves, and it hasn't been playable for a second yet
 const list = workshopFiltered(all, state);
 for (const rec of list) grid.append(levelCard(rec, { showFeature: !!api.user()?.isAdmin, onFeatured: load, corner: doneCorner(progress, rec) }));
 if (!list.length) grid.append(el('p', { class: 'muted' }, 'No levels match.'));
 saveWorkshopQueue(openTab === 'challenges' ? all.filter(isLiveChallenge) : list);

 featuredGrid.innerHTML = '';
 const picks = all.filter(r => r.featured);
 featuredWrap.classList.toggle('hidden', !picks.length);
 for (const rec of picks) featuredGrid.append(levelCard(rec, { showFeature: !!api.user()?.isAdmin, onFeatured: load, corner: doneCorner(progress, rec) }));

 chalGrid.innerHTML = '';
 const running = all.filter(isLiveChallenge);
 chalCount.textContent = running.length ? String(running.length) : '';
 // The tab always exists, even at zero — a tab that comes and goes is worse
 // than an empty one, because you cannot learn where anything is.
 if (running.length) {
 for (const rec of running) chalGrid.append(levelCard(rec, { showFeature: false, corner: doneCorner(progress, rec) }));
 } else {
 chalGrid.append(el('p', { class: 'muted' },
 'Nothing running just now. A challenge is set from your own levels and solves — ',
 'seal a private level for a timed debut, or put one of your private winning runs up as a bar to beat.'));
 }
 }
 function load() {
 // One fetch for both tabs: the Challenges tab is a filter over this same
 // list, so it can never show a level the Levels tab has never heard of.
 api.levels({ sort: state.sort, q: state.q || undefined })
 .then(list => { all = list; refresh(); })
 .catch(() => grid.append(el('p', { class: 'muted' }, 'Could not reach the server.')));
 }
 // Countdowns have to tick, or a card claiming "2m 14s" is a lie ten seconds
 // later. One timer for the whole page, repainting only the chips.
 const tick = setInterval(() => {
 for (const node of mainEl.querySelectorAll('[data-deadline]')) {
 node.textContent = countdownText(node.dataset.kind, +node.dataset.deadline);
 }
 }, 1000);
 currentScreen = { destroy() { clearInterval(tick); } };
 load();
}

// The Workshop list the player is actually looking at — sort, search, author,
// badges, solved, and which tab. Solves ‹ › and the play HUD walk THIS, not
// the unfiltered catalogue, so "next" is the next card they would have clicked.
const WORKSHOP_QUEUE_KEY = 'workshopQueue';
function saveWorkshopQueue(list) {
 store.set(WORKSHOP_QUEUE_KEY, (list || [])
 .filter((r) => r && r.id && !r.sealed)
 .map((r) => ({ id: r.id, name: r.name })));
}
// Workshop 3-click circle: '' (off) → '0' (none) → '1' (yes) → ''.
function triFilterBtn({ key, state, glyph, titles, aria, onChange }) {
 if (state[key] !== '0' && state[key] !== '1') state[key] = '';
 const btn = el('button', { type: 'button', class: 'star-filter', 'aria-label': aria, 'data-tip-1line': '' }, '');
 const paint = () => {
 const v = state[key];
 const mode = v === '0' ? 'none' : v === '1' ? 'yes' : 'off';
 btn.dataset.mode = mode;
 btn.textContent = glyph[mode];
 btn.setAttribute('data-tip', titles[mode]);
 refreshTip();
 };
 paint();
 btn.addEventListener('click', () => {
 state[key] = state[key] === '' ? '0' : state[key] === '0' ? '1' : '';
 paint();
 onChange();
 });
 return btn;
}

function matchesDone(id, done) {
 if (done !== '0' && done !== '1') return true;
 const progress = store.get('progress', {}) || {};
 return done === '1' ? !!progress[id] : !progress[id];
}

function doneStarCorner(rec) {
 if (!rec?.id) return null;
 const done = (store.get('progress', {}) || {})[rec.id];
 return done ? el('span', { class: 'card-done', title: tf('Solved in {time} · {n} pcs', { time: fmtTime(done.time), n: done.pieces }) }, '⭐') : null;
}

// Spreadsheet ↔ tiles, remembered with the rest of the table (§8.1). Far right
// of the filter row so the search and badges keep their left-to-right order.
function viewToggle(state, onChange) {
 if (state.view !== 'tiles') state.view = 'table';
 const wrap = el('span', { class: 'view-toggle' });
 const mk = (view, label, glyph) => {
 const btn = el('button', {
 type: 'button',
 class: 'view-toggle-btn',
 'data-tip-1line': '',
 'data-tip': label,
 'aria-label': label,
 }, glyph);
 btn.addEventListener('click', () => {
 if (state.view === view) return;
 state.view = view;
 paint();
 onChange();
 });
 return btn;
 };
 const tableBtn = mk('table', t('Spreadsheet'), '☰');
 const tilesBtn = mk('tiles', t('Tiles'), '▦');
 const paint = () => {
 tableBtn.classList.toggle('on', state.view === 'table');
 tilesBtn.classList.toggle('on', state.view === 'tiles');
 };
 paint();
 wrap.append(tableBtn, tilesBtn);
 return wrap;
}

function fillTiles(grid, rows, emptyText, cardFor) {
 grid.innerHTML = '';
 if (!rows.length) {
 grid.append(el('p', { class: 'muted' }, emptyText));
 return;
 }
 for (const r of rows) grid.append(cardFor(r));
}

function solveCard(s) {
 const href = (!s.levelId || !s.id || (s.local && (!s.design || s.levelId === 'scratch')))
 ? null
 : `/play/${encodeURIComponent(s.levelId)}/${encodeURIComponent(s.id)}`;
 const cv = el('canvas', { class: 'card-thumb', width: 264, height: 148 });
 let thumb = cv;
 if (s.preview || s.design) {
 try { renderPreview(cv, s.preview || s.design); } catch { thumb = el('div', { class: 'card-thumb card-thumb-empty' }); }
 } else if (s.id && !s.local) {
 thumb = el('img', { class: 'card-thumb', src: '/og/S' + encodeURIComponent(s.id) + '.jpg', alt: '' });
 } else {
 thumb = el('div', { class: 'card-thumb card-thumb-empty' });
 }
 const stats = s.won
 ? `${fmtTime(s.time)} · ${s.pieces ?? '—'} pcs${s.kg != null ? ' · ' + fmtKg(s.kg) : ''}`
 : t('attempt');
 return el(href ? 'a' : 'div', {
 class: 'card' + (s.won ? '' : ' attempt') + (s.local ? ' local' : ''),
 href: href || undefined,
 },
 thumb,
 el('div', { class: 'card-body' },
 el('div', { class: 'card-title' }, s.levelName || t('a level'),
 s.local ? el('span', { class: 'muted' }, ' (local)') : null),
 el('div', { class: 'card-sub muted' },
 [s.name, s.by || (s.local ? t('on this device') : ''), stats].filter(Boolean).join(' · ')),
 badgeRow(computeBadges(s), 'card-badges', { tiny: true })),
 );
}

function workshopFiltered(all, state) {
 let list = all || [];
 if (state.author) list = list.filter((r) => (r.author || '').toLowerCase().includes(state.author));
 const badges = state.badge;
 if (badges && badges.size) list = list.filter((r) => !r.sealed && [...badges].every((b) => (r.badges || []).includes(b)));
 const badgeNot = state.badgeNot;
 if (badgeNot && badgeNot.size) list = list.filter((r) => ![...badgeNot].some((b) => (r.badges || []).includes(b)));
 if (state.done === '1' || state.done === '0') list = list.filter((r) => matchesDone(r.id, state.done));
 return list;
}
function workshopNeighbors(id) {
 const q = store.get(WORKSHOP_QUEUE_KEY, []) || [];
 const i = q.findIndex((x) => x.id === id);
 return {
 prev: i > 0 ? q[i - 1] : null,
 next: i >= 0 && i < q.length - 1 ? q[i + 1] : null,
 };
}
// True when this play session started from the Workshop list — even if the
// same record is also an official campaign slot.
const PLAY_NAV_KEY = 'playNavSource';
function fromWorkshopPlay() {
 return store.get(PLAY_NAV_KEY) === 'workshop';
}

// A level is "live" if it has a race that hasn't been won or any open bar —
// which is `liveChallenges` (util.js) finding anything, and is now asked that
// way rather than by a second copy of the same test living here.
function isLiveChallenge(rec) {
 return liveChallenges(rec).length > 0;
}

// The chip a challenge level wears on its card: what kind, what's staked, and
// how long is left. Sealed races get the whole corner, since the card has no
// thumbnail to speak for it.
//
// **The chip is the countdown, so the message goes with it** (§11.8), on its
// own line under the chip rather than inside it — a chip is `nowrap` and a
// message is a sentence, and threading one through would stretch the card to
// the width of whatever somebody typed. The line is clamped to two in CSS, and
// the FULL terms — prize, bars, badge requirements, deadline — hang off the
// hover, which is the only surface here with room for them.
//
// The hover is `data-tip` rather than a `title`: the native tooltip takes about
// a second to appear, can't hold the six lines this needs, and silently
// collapses the newlines in them. `installTooltips` is delegated from the
// document, so a card built here is covered without doing anything.
function challengeChip(rec) {
 // **One `.chal-one` per challenge, and IT carries the hover** — not the chip
 // inside it. The chip is a 20 px pill, and the first report of this feature
 // was *"I had to point at the little challenge bar"*: a popup you can only
 // reach by hitting a target that small is a popup most people never see. The
 // row is the target now, so pointing anywhere at the challenge — the chip,
 // the message, the space beside either — brings up its terms.
 //
 // Per challenge rather than per CARD because a level can carry several, and
 // a single tip over the lot could only ever describe one of them.
 const rows = [];
 for (const c of liveChallenges(rec)) {
 rows.push(el('div', { class: 'chal-one', 'data-tip': c.tip, 'data-tip-wide': true },
 challengeChipEl(c),
 // the span is what the two-line clamp lives on — clamping the bubble
 // itself needs `overflow: hidden`, which would crop its tail off
 c.message
 ? el('div', { class: 'chal-message' },
 el('span', {}, `${c.kind === 'race' ? '🏁' : '⚔'} “${c.message}” — ${c.by}`))
 : null));
 }
 if (!rows.length) return null;
 return el('div', { class: 'chal-block' }, ...rows);
}

function levelCard(rec, opts = {}) {
 const cv = el('canvas', { class: 'card-thumb', width: 264, height: 148 });
 if (rec.preview) {
 try { renderPreview(cv, rec.preview); } catch { /* bad preview */ }
 }
 // A sealed race has no preview by design (the server doesn't send one), so
 // the thumbnail says what it is instead of sitting blank.
 if (rec.sealed) {
 const c = cv.getContext('2d');
 c.fillStyle = '#232a35';
 c.fillRect(0, 0, cv.width, cv.height);
 c.fillStyle = 'rgba(255,255,255,.9)';
 c.font = '600 15px system-ui, sans-serif';
 c.textAlign = 'center';
 c.fillText(t('🏁 sealed until the reveal'), cv.width / 2, cv.height / 2 + 5);
 }
 // Both scales, readonly: a card is one big <a>, so these render as spans and
 // the counts live in their tooltips rather than trailing the row as text.
 const scales = el('span', { class: 'card-scales' },
 starRating(rec, null, { readonly: true }),
 difficultyRating(rec, null, { readonly: true }));
 const sealed = !!rec.sealed;
 const href = rec.local
 ? '/maker/' + encodeURIComponent(rec.draftId)
 : '/play/' + encodeURIComponent(rec.id);
 const card = el('a', {
 class: 'card' + (opts.locked ? ' locked' : '') + (sealed ? ' sealed' : '') + (rec.local ? ' local' : ''),
 href,
 // locked cards go to the sign-in modal instead of a screen that would
 // only 401 — the server still guards the data either way. A sealed race
 // isn't playable at all yet, so its card doesn't pretend to be a door.
 onclick: rec.local ? undefined : sealed
 ? (e) => e.preventDefault()
 : opts.locked ? (e) => { e.preventDefault(); authModal('login'); } : undefined,
 },
 cv,
 opts.corner || null,
 opts.showFeature && !rec.official ? el('button', {
 class: 'card-feature-btn' + (rec.featured ? ' on' : ''),
 title: rec.featured ? 'Featured — click to remove from the shelf' : 'Feature this level in the Workshop',
 onclick: async (e) => {
 e.preventDefault(); e.stopPropagation();
 e.target.disabled = true;
 try { await api.featureLevel(rec.id, !rec.featured); opts.onFeatured?.(); }
 catch (ex) { e.target.disabled = false; alert(ex.message || 'Could not change that.'); }
 },
 }, rec.featured ? '★' : '☆') : null,
 opts.showEdit ? el('button', {
 class: 'card-edit-btn', title: 'Edit this level in place (admin)',
 onclick: (e) => {
 e.preventDefault(); e.stopPropagation();
 go('/maker/official/' + encodeURIComponent(rec.id));
 },
 }, '✏') : null,
 el('div', { class: 'card-body' },
 el('div', { class: 'card-title' },
 rec.official ? el('span', { class: 'chip-official', title: 'Campaign level' }, '★ ' + (rec.slot + 1) + ' ') : null,
 // private and unlisted are both `listed:false` on the wire; only the
 // owner ever sees either, and telling them apart is the difference
 // between "anyone with the link" and "nobody but me"
 rec.name, rec.local ? el('span', { class: 'muted' }, ' (local)')
 : sealed ? null
 : rec.private ? el('span', { class: 'muted' }, ' (private)')
 : rec.listed === false ? el('span', { class: 'muted' }, ' (unlisted)') : null),
 opts.subtitle
 ? el('div', { class: 'card-sub muted' }, opts.subtitle)
 : el('div', { class: 'card-sub muted' },
 `${rec.author || t('anonymous')}${rec.authorCrown ? ' ' + (rec.authorCrown === 'gold' ? '👑' : '🥈') : ''}`,
 // a sealed race has no plays, no solves and no ratings to show —
 // showing zeroes would read as "nobody liked it"
 sealed ? '' : ' · ', sealed ? null : scales,
 sealed ? null : el('span', { title: '▶ times played · ⭐ times solved' },
 ` · ▶${rec.plays || 0} ⭐${rec.solves || 0}`)),
 // THE DESCRIPTION, on the card. It used to appear only on the details
 // panel — which you reach by opening the level, i.e. after the decision
 // it could have helped you make. Two lines here is the moment it is
 // worth anything: it turns a wall of names into a shelf you can browse.
 // Clamped in CSS rather than truncated in JS so the full text is still
 // there for search engines, screen readers and the details panel.
 // A SEALED race hides it with everything else: its description is the
 // author's pitch for a level nobody may read yet (§11.8).
 !sealed && rec.desc ? el('p', { class: 'card-desc muted', title: rec.desc }, rec.desc) : null,
 challengeChip(rec),
 // the union of every solve's badges — ghosts here mean "nobody has
 // solved it that way yet", which is the interesting half of the row
 sealed ? null : badgeRow(rec.badges, 'card-badges', { tiny: true, ghostNote: 'no solve has managed this yet' }),
 ));
 return card;
}

// ---------- play ----------

async function playScreen(id, solveCode) {
 mainEl.className = 'main full';
 const holder = el('div', { class: 'screen-holder' });
 mainEl.append(holder);
 let rec;
 try {
 rec = await api.level(id);
 } catch (e) {
 // 401 = a locked campaign level reached by URL while signed out.
 // Signing in re-routes this same screen (authModal's submit calls route()).
 if (e.status === 401) {
 // Three lines, as written (2026-08-18): the account is FREE and the copy
 // must not read like a paywall. The server's 401 carries the same
 // sentence; drawn line by line here so it reads as three thoughts.
 const n = config.freeSlots ?? 16;
 holder.append(el('div', { class: 'center-msg' },
 el('h2', {}, '🔒 ' + t('Account is FREE!')),
 el('p', { class: 'muted' },
 tf('The first {n} levels you don\'t need an account.', { n }), el('br'),
 t('The account is just a place to save your solves etc.')),
 el('div', {},
 el('button', { class: 'btn primary', onclick: () => authModal('login') }, 'Sign in'),
 ' ',
 config.registrationOpen ? el('button', { class: 'btn', onclick: () => authModal('register') }, 'Join') : null,
 ' ',
 el('a', { class: 'btn ghost', href: '/campaign' }, tf('The first {n}', { n }))),
 ));
 return;
 }
 holder.append(el('div', { class: 'center-msg' },
 el('h2', {}, 'Level not found'),
 el('a', { class: 'btn', href: '/browse' }, 'Back to the Workshop')));
 return;
 }
 document.title = rec.name + ' — LIFIRIK';
 // A sealed race has no `data` to mount — the countdown IS the page until the
 // moment arrives, and it reloads itself when it does so nobody has to sit
 // there refreshing (§11.8).
 if (rec.sealed) return sealedRacePage(holder, rec);
 // a bare level page is not a share link; one carrying a solve code is
 await mountPlayable(holder, rec, solveCode, null, { fromLink: !!solveCode });
}

function sealedRacePage(holder, rec) {
 const clock = el('div', { class: 'race-clock' });
 const paint = () => {
 const left = rec.race.revealAt - Date.now();
 clock.textContent = left > 0 ? fmtCountdown(left) : t('opening…');
 if (left <= 0) { clearInterval(tick); setTimeout(() => location.reload(), 1200); }
 };
 const tick = setInterval(paint, 1000);
 currentScreen = { destroy() { clearInterval(tick); } };
 paint();
 // The challenger's own line, under the clock. This screen is a name and a
 // number until the moment arrives — the message is the only thing on it with
 // a person behind it, and this is the countdown the feature was asked for
 // (§11.8). The terms are already spelled out below it in full, so it carries
 // no tooltip: a popup repeating the paragraph it is sitting on is noise.
 const said = cleanMessage(rec.race.message);
 holder.append(el('div', { class: 'center-msg' },
 el('h2', {}, '🏁 ' + rec.name),
 el('p', { class: 'muted' }, tf('A timed challenge set by {who}. Nobody can open it until the clock runs out — then everyone gets it at once, and the first solved run saved publicly takes it.', { who: rec.race.by })),
 clock,
 el('p', { class: 'muted' }, fmtDateTime(rec.race.revealAt)),
 said ? el('blockquote', { class: 'race-message' }, `“${said}”`, el('cite', {}, '— ' + rec.race.by)) : null,
 rec.race.prize ? el('p', {}, tf(rec.race.prize > 1 ? '🏅 {n} points to the winner — a token, worth nothing.' : '🏅 {n} point to the winner — a token, worth nothing.', { n: rec.race.prize })) : null,
 el('a', { class: 'btn', href: '/browse' }, 'Back to the Workshop'),
 ));
}

// #/lvl/<code> and #/watch/<code> — the client-side share codes — are GONE,
// readers included (2026-07-30, the user's call). Nothing had produced the
// links since both Share buttons were removed; the readers were kept a while
// so links already handed out still opened, and now they don't: an old share
// URL falls through the router to the home screen. `decodeShare`,
// `encodeShare` and their codec helpers left util.js in the same change —
// grep history for `shareScreen` / `watchScreen` if they are ever wanted back.

async function mountPlayable(holder, rec, solveCode, directWatch, { fromLink = false } = {}) {
 const gameHost = el('div', { class: 'game-host' });
 holder.append(gameHost);

 let watchSolve = directWatch || null;
 if (!watchSolve && solveCode && rec.solveList) {
 watchSolve = rec.solveList.find(s => s.id === solveCode && (s.design || s.hasDesign));
 }
 // not in the (already-fetched) general list — could be an unlisted solve,
 // reachable only via this direct URL, so ask the dedicated endpoint too
 if (!watchSolve && solveCode && rec.id) {
 try { watchSolve = await api.fetchSolve(rec.id, solveCode); } catch { /* private or gone */ }
 }
 // **…and finally THIS BROWSER.** A Local save is a complete solve record,
 // design and all (§11.6), stored under `localSolves.<levelId>` — and until
 // now nothing ever read one back. It could be made, listed on your profile
 // and deleted, and never watched: three of the four verbs. Reported as "local
 // saves aren't accessible any more", and the run was sitting on the machine
 // the whole time with no door to it.
 //
 // Last, deliberately: a server solve of the same id is the shared one, and
 // this browser's copy must not shadow it.
 if (!watchSolve && solveCode && rec.id) {
 watchSolve = store.get('localSolves.' + rec.id, [])
 .find((s) => s.id === solveCode && s.design) || null;
 }
 if (watchSolve && !watchSolve.design && solveCode && rec.id && !watchSolve.local) {
 try {
 const full = await api.fetchSolve(rec.id, solveCode);
 watchSolve = { ...watchSolve, design: full.design, goals: full.goals ?? watchSolve.goals };
 } catch { /* loadSolve will say if there is still no machine */ }
 }

 // The Solves screen lives on <body>, not inside the holder: "takes over the
 // entire screen" has to mean over the site nav too, and a fixed element
 // nested in the holder's stacking context can't. It is built on demand and
 // torn down with the screen — see currentScreen.destroy below, which is the
 // only thing standing between navigating away and a panel left on top of
 // the next page.
 let info = null;
 const workshopOrigin = fromWorkshopPlay();
 const openSolves = () => {
 info?.destroy();
 info = levelInfoScreen(rec, watchReplay, {
 officials,
 freeSlots: config.freeSlots ?? 32,
 signedIn: !!api.user(),
 fromWorkshop: workshopOrigin,
 });
 info.open();
 };

 // `waitToStart` only on the FIRST mount from a link. The in-app "watch this
 // solve" button below re-mounts through the same function, and that click is
 // already a gesture the visitor made on purpose — arming it there would just
 // be a second thing to press.
 // **The next campaign level, resolved before the player can win.** The win
 // banner offers a Next button and it has to know both that there IS one and
 // what it is called, so this cannot wait until the moment of winning — a
 // button that appears a beat late is a button you have already clicked past.
 //
 // Campaign levels only, and one extra request on those alone. `nextCampaignLevel`
 // (util.js) owns the four ways of answering "no" — the shell only routes.
 let nextRec = null, prevRec = null, officials = [];
 if (!workshopOrigin && rec.official && rec.slot != null) {
 try {
 officials = await api.levels({ official: 1, sort: 'slot' });
 const terms = { slot: rec.slot, levels: officials, freeSlots: config.freeSlots ?? 32, signedIn: !!api.user() };
 nextRec = nextCampaignLevel(terms);
 prevRec = prevCampaignLevel(terms);
 } catch { /* offline: no Next, and the rest of the screen is unaffected */ }
 }
 // **‹ ^ ›** follow origin, not official-ness: a campaign slot opened from
 // the Workshop still walks that Workshop list, and Back/^ return to /browse.
 const set = !workshopOrigin && rec.official && rec.slot != null ? setOfSlot(rec.slot, config.campaigns) : null;
 const campaignNav = !workshopOrigin && rec.official && rec.slot != null ? {
 prev: prevRec ? { name: prevRec.name, go: () => go('/play/' + prevRec.id) } : null,
 up: { name: set ? set.name : null, go: () => go(set ? '/campaign/' + encodeURIComponent(set.id) : '/campaign') },
 next: nextRec ? { name: nextRec.name, go: () => go('/play/' + nextRec.id) } : null,
 } : (() => {
 const w = workshopNeighbors(rec.id);
 return {
 prev: w.prev ? { name: w.prev.name, go: () => go('/play/' + w.prev.id) } : null,
 up: { name: t('Workshop'), go: () => go('/browse'),
 title: t('Workshop — the list you were browsing') },
 next: w.next ? { name: w.next.name, go: () => go('/play/' + w.next.id) } : null,
 emptyPrev: t('This is the first level in this list'),
 emptyNext: t('This is the last level in this list'),
 };
 })();
 if (workshopOrigin) {
 const w = workshopNeighbors(rec.id);
 nextRec = w.next ? { id: w.next.id, name: w.next.name } : null;
 }

 const mountGame = (solve, { waitToStart = false } = {}) => new GameScreen(gameHost, {
 level: rec.data,
 name: rec.name,
 desc: rec.desc,
 hint: rec.hint,
 levelId: rec.id,
 levelNum: rec.num, // names exported files (§11.2)
 ratingState: rec, // shared with the Solves screen's stars
 // What is running ON this level, so the play screen can say so itself
 // (§11.8). Resolved here rather than inside the game because the game is
 // handed a level, not a level RECORD — and the same list is what the
 // Workshop card is drawn from, so the two cannot disagree.
 challenges: liveChallenges(rec),
 officialSlot: rec.official ? rec.slot : null,
 mode: 'play',
 watchSolve: solve,
 waitToStart,
 onSolves: openSolves,
 // Named, not just an id: the button says where it goes ("Next: Rocky Steps"),
 // because "Next" alone on the last screen of a level you have just beaten
 // gives no reason to press it.
 nextLevel: nextRec ? { name: nextRec.name, num: nextRec.num } : null,
 campaignNav,
 onNext: nextRec ? () => { go('/play/' + nextRec.id); } : null,
 onExit: () => { go(workshopOrigin || !rec.official ? '/browse' : '/campaign'); },
 });

 let screen = mountGame(watchSolve, { waitToStart: fromLink });
 currentScreen = {
 // A player builds a machine here exactly as an author does, so this screen
 // answers for Ctrl+Z on the same terms the Maker does (see makerReturn).
 // It used to answer nothing at all, which is half of why the key threw
 // people out of the level they were playing.
 canUndo: () => screen.canUndo(),
 destroy() { screen.destroy(); info?.destroy(); },
 };

 // Load somebody's solve into the running screen (§11.3): close the panel, and
 // their machine is on the build area with the preroll naming them over it.
 //
 // **It does NOT re-mount.** This used to destroy the GameScreen and build a new
 // one around the solve, which was fine while watching was a mode you could back
 // out of — but a loaded solve is the player's own design, and the way back to
 // what they had is Ctrl+Z. A fresh screen has an empty undo stack, so that key
 // would have had nothing to give back.
 function watchReplay(solve, fromRec = rec) {
 info?.close();
 // Browsing another campaign level's solves: this GameScreen is still the
 // level they opened. Watch has to load THAT level, then the machine.
 if (fromRec && fromRec.id !== rec.id) {
 go(solve?.id
 ? `/play/${encodeURIComponent(fromRec.id)}/${encodeURIComponent(solve.id)}`
 : `/play/${encodeURIComponent(fromRec.id)}`);
 return;
 }
 screen.loadSolve(solve);
 }
}

// What's at stake on this level, in the details panel: the open race (or who
// took it), and every live bar with what it demands and how long is left.
// Read-only — setting one lives in the save dialog, where the solve that backs
// it is (§11.8).
function challengePanel(rec) {
 const rows = [];
 const me = api.user();
 // What the challenger said, wherever their challenge is listed. A quote
 // rather than a run of body text: it is the one line on this panel that
 // isn't the game talking (§11.8).
 const messageEl = (c) => {
 const t = cleanMessage(c.message);
 return t ? el('div', { class: 'chal-message panel' }, `“${t}”`) : null;
 };
 // **The one control that writes anything on this read-only panel**, and it is
 // here because this is where you are when you notice the message is missing
 // or wrong. Only the person who set the challenge sees it, and only while it
 // is still live — the terms are fixed, the words are not (§11.8).
 const editBtn = (c, save) => {
 if (!me || c.byId !== me.id) return null;
 return el('button', {
 class: 'btn tiny',
 title: cleanMessage(c.message)
 ? 'Rewrite what you said with this challenge — the terms stay as they are'
 : 'Add a line of your own, shown with the countdown',
 onclick: () => messageComposer(c, save),
 }, cleanMessage(c.message) ? '✎ message' : '✎ add a message');
 };
 if (rec.race) {
 const r = rec.race;
 rows.push(el('div', { class: 'chal-row' },
 // the tip hangs off the HEADING, not the row: a row also carries buttons,
 // and a popup that covers the control you are reaching for is worse than
 // no popup
 el('b', { 'data-tip': challengeTip(r, 'race'), 'data-tip-wide': true }, '🏁 Timed challenge'),
 r.winner
 ? el('span', {}, ' — ' + tf('won by {who}', { who: r.winner.name }))
 : el('span', {}, ' — open: the first solved run saved ',
 el('b', {}, 'publicly'), ' takes it', r.prize ? ` · 🏅${r.prize}` : ''),
 el('div', { class: 'muted' }, tf('set by {who}', { who: r.by })),
 messageEl(r),
 r.winner ? null : editBtn(r, (text) => api.setRaceMessage(rec.id, text))));
 }
 for (const c of (rec.challenges || [])) {
 if (c.closedAt && !c.winner) continue;
 const live = !c.closedAt;
 rows.push(el('div', { class: 'chal-row' },
 el('b', { 'data-tip': challengeTip(c, 'beatme'), 'data-tip-wide': true },
 live ? '⚔ Match me? Beat me?' : '⚔ Beaten'),
 el('div', {}, challengeTerms(c) || 'anything goes'),
 messageEl(c),
 el('div', { class: 'muted' },
 `${c.by}${c.prize ? ` · 🏅${c.prize}` : ''}`,
 live
 ? el('span', {}, ' · ', el('b', { 'data-deadline': String(c.endsAt), 'data-kind': 'beatme' }, countdownText('beatme', c.endsAt)))
 : ' · ' + tf('won by {who}', { who: esc(c.winner.name) })),
 live ? editBtn(c, (text) => api.setChallengeMessage(rec.id, c.id, text)) : null,
 live && me && c.byId === me.id ? el('button', {
 class: 'btn tiny danger',
 title: 'Withdraw this challenge — your stake comes back and your solve publishes',
 onclick: async (e) => {
 e.target.disabled = true;
 try { await api.withdrawChallenge(rec.id, c.id); location.reload(); }
 catch (ex) { e.target.disabled = false; alert(ex.message || 'Could not withdraw.'); }
 },
 }, 'Withdraw') : null));
 }
 if (!rows.length) return null;
 return el('section', { class: 'chal-panel' }, ...rows);
}

// ---------- the Solves screen (level details, records, solves, comments) ----------
//
// One full-screen panel, opened from the game's own top bar. It replaced a
// 340 px slide-out aside behind a floating ℹ disc: the disc sat on top of the
// level and said nothing about what it hid, and the column it opened was too
// narrow for the thing people actually come here for — comparing solves
// against each other. Comparison wants a table, and a table wants the width.
//
// Order is fixed and deliberate: what this level IS (and the link to send
// someone), then the three records, then everybody's solves, then the talking.
function levelInfoScreen(rec, onWatch, campaign = null) {
 const root = el('div', { class: 'info-screen' });
 const body = el('div', { class: 'info-body' });
 const closeBtn = el('button', { class: 'btn ghost info-close', title: 'Back to the level (Esc)' }, '✕');
 const title = el('h2', {}, rec.name || 'Level');
 const unpublished = el('span', { class: 'muted' }, '🔒 unpublished');
 unpublished.classList.toggle('hidden', rec.listed !== false);

 const openedTitle = document.title;
 const openedFromId = rec.id;
 const close = () => {
 root.remove();
 window.removeEventListener('keydown', onKey, true);
 document.title = openedTitle;
 };
 // ✕ and the thumbnail play the level THIS panel is showing — which is
 // not always the one still running under it, after ‹ ›.
 const goToDisplayed = () => {
 if (rec.id && rec.id !== openedFromId) {
 close();
 go('/play/' + encodeURIComponent(rec.id));
 } else close();
 };

 // ‹ ^ › on the Solves bar (2026-08-26): skip through the list this level
 // came from — campaign order, or the Workshop's current filters and sort —
 // without dropping back to play. Watch then loads THAT level and the machine.
 const canWalk = true;
 // Freeze HOW we walk at open: a Workshop list that happens to include a
 // campaign level must not suddenly switch to slot order mid-browse.
 const walkCampaign = !campaign?.fromWorkshop && !!(rec.official && rec.slot != null);
 let busy = false;
 const around = (r) => {
 if (walkCampaign) {
 const terms = {
 slot: r.slot, levels: campaign?.officials || [],
 freeSlots: campaign?.freeSlots ?? 32, signedIn: !!campaign?.signedIn,
 };
 const set = setOfSlot(r.slot, config.campaigns);
 return {
 prev: prevCampaignLevel(terms),
 next: nextCampaignLevel(terms),
 up: {
 name: set ? set.name : null,
 go: () => go(set ? '/campaign/' + encodeURIComponent(set.id) : '/campaign'),
 },
 emptyPrev: t('This is the first level'),
 emptyNext: t('This is the last level you can play from here'),
 };
 }
 const w = workshopNeighbors(r.id);
 return {
 prev: w.prev,
 next: w.next,
 up: {
 name: t('Workshop'),
 go: () => go('/browse'),
 title: t('Workshop — the list you were browsing'),
 },
 emptyPrev: t('This is the first level in this list'),
 emptyNext: t('This is the last level in this list'),
 };
 };
 const prevBtn = el('button', { class: 'btn dock-mini icon-btn nav-arrow', html: navArrowSVG('left') });
 const upBtn = el('button', { class: 'btn dock-mini icon-btn nav-arrow', html: navArrowSVG('up') });
 const nextBtn = el('button', { class: 'btn dock-mini icon-btn nav-arrow', html: navArrowSVG('right') });
 const syncNav = () => {
 const n = around(rec);
 prevBtn.disabled = !n.prev || busy;
 prevBtn.title = n.prev ? tf('Previous: {name} — its solves', { name: n.prev.name }) : (n.emptyPrev || 'This is the first level');
 upBtn.title = n.up.title
 || (n.up.name ? tf('{set} — every level in the set', { set: n.up.name }) : 'The campaign');
 upBtn.onclick = () => n.up.go();
 nextBtn.disabled = !n.next || busy;
 nextBtn.title = n.next ? tf('Next: {name} — its solves', { name: n.next.name }) : (n.emptyNext || 'This is the last level you can play from here');
 };
 const showNeighbor = async (which) => {
 const n = around(rec);
 const target = which === 'prev' ? n.prev : n.next;
 if (!target?.id || busy) return;
 busy = true; syncNav();
 try {
 const full = await api.level(target.id);
 rec = full;
 title.textContent = rec.name || 'Level';
 unpublished.classList.toggle('hidden', rec.listed !== false);
 document.title = (rec.name || 'Level') + ' — LIFIRIK';
 paint();
 body.scrollTop = 0;
 } catch { /* locked or gone — stay on this level */ }
 busy = false; syncNav();
 };
 prevBtn.onclick = () => showNeighbor('prev');
 nextBtn.onclick = () => showNeighbor('next');
 if (canWalk) syncNav();

 const onKey = (e) => {
 // capture-phase, so it beats the canvas's own key handling — which is
 // switched off while this is up anyway (GameScreen._uiCovered)
 if (e.key === 'Escape') { e.stopPropagation(); goToDisplayed(); return; }
 if (!canWalk) return;
 if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
 if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); showNeighbor('prev'); }
 else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); showNeighbor('next'); }
 };
 closeBtn.addEventListener('click', goToDisplayed);

 const paint = () => paintInfoBody(body, rec, (s) => onWatch(s, rec), goToDisplayed);

 root.append(
 el('div', { class: 'info-bar' },
 canWalk ? el('span', { class: 'hud-nav' }, prevBtn, upBtn, nextBtn) : null,
 title,
 unpublished,
 el('span', { class: 'spacer' }),
 closeBtn),
 body);

 paint();

 return {
 open() {
 document.body.append(root);
 window.addEventListener('keydown', onKey, true);
 body.scrollTop = 0;
 },
 close,
 destroy: close,
 };
}

// Split out from levelInfoScreen so the handful of controls that change the
// record (publish/unpublish, solve visibility) can redraw the body without
// tearing down the panel, its scroll position or its key handler.
function paintInfoBody(body, rec, onWatch, onOpenLevel) {
 body.innerHTML = '';
 const repaint = () => paintInfoBody(body, rec, onWatch, onOpenLevel);
 appendAll(body,
 infoDetailsSection(rec, repaint, onOpenLevel),
 infoRecordsSection(rec),
 rec.id ? infoSolvesSection(rec, onWatch, repaint) : null,
 rec.id ? infoCommentsSection(rec) : null,
 );
}

// ---- 1. what this level is, with the link to hand somebody ----

function infoDetailsSection(rec, repaint, onOpenLevel) {
 const me = api.user();
 const ownsLevel = !!(me && (me.id === rec.authorId || me.isAdmin));

 const thumb = el('canvas', { class: 'info-thumb', width: 384, height: 216 });
 // The live level data beats the stored preview when we have it: this screen
 // is opened from the level, so it can show the level rather than the
 // snapshot taken when it was published.
 const preview = rec.data || rec.preview;
 if (preview) { try { renderPreview(thumb, preview); } catch { /* bad preview */ } }
 if (onOpenLevel && rec.id) {
 thumb.classList.add('clickable');
 thumb.title = t('Play this level');
 thumb.addEventListener('click', onOpenLevel);
 }

 return el('section', { class: 'info-section info-details' },
 thumb,
 el('div', { class: 'info-meta' },
 el('p', { class: 'muted' },
 tf('by {who}', { who: rec.author || t('anonymous') }),
 rec.official ? ' · ' + tf('Campaign level #{n}', { n: (rec.slot || 0) + 1 }) : '',
 rec.createdAt ? ` · ${timeAgo(rec.createdAt)}` : ''),
 // "Give them credit" (§11.9): the level that sparked this one, as its
 // author chose to say. A snapshot, so the name is the name it had when
 // credited — the LINK still works if the level lives, and the words
 // survive if it doesn't (credit is not a row lock, §11.3).
 rec.inspiredBy ? el('p', { class: 'muted info-inspired' },
 '💐 inspired by ',
 el('a', { href: '/play/' + encodeURIComponent(rec.inspiredBy.levelId) }, `“${rec.inspiredBy.name}”`),
 ' ' + tf('by {who}', { who: rec.inspiredBy.by })) : null,
 rec.desc ? el('p', { class: 'info-desc' }, rec.desc) : null,
 rec.id ? el('div', { class: 'info-scales' },
 starRating(rec, (i) => api.rate(rec.id, i)),
 difficultyRating(rec, (i) => api.rateDifficulty(rec.id, i))) : null,
 el('p', { class: 'info-counts muted' },
 tf('▶ {p} plays · ⭐ {s} solves', { p: rec.plays || 0, s: rec.solves || 0 })),
 badgeRow(rec.badges, 'info-badges', { ghostNote: 'no solve has managed this yet' }),
 levelLinkRow(rec),
 ownsLevel ? el('button', {
 class: 'btn tiny',
 title: rec.listed === false
 ? 'List this level in the Workshop again'
 : 'Take this level out of the Workshop listings — the direct link keeps working for anyone you gave it to. Full lock-down is Private, on your profile\'s visibility dropdown',
 onclick: async (e) => {
 const next = rec.listed === false;
 e.target.disabled = true;
 try {
 await api.updateLevel(rec.id, { listed: next });
 rec.listed = next ? undefined : false;
 repaint();
 } catch { e.target.disabled = false; alert('Could not change publish state.'); }
 },
 }, rec.listed === false ? 'Re-publish level' : 'Unpublish level') : null,
 challengePanel(rec),
 ));
}

// The direct URL, shown in full and copyable in one click — this is the thing
// people paste into Discord, and hunting for it in the browser's address bar
// while the game is full-screen is a worse experience than it sounds.
function levelLinkRow(rec) {
 if (!rec.id) return null;
 // The PATH form (§11.10). A `#` fragment never reaches the server, so a
 // leftover hash link pasted into Discord unfurls as the bare site — this
 // URL is served with the level's own title, description and thumbnail.
 const url = location.origin + '/play/' + encodeURIComponent(rec.id);
 const field = el('input', { class: 'input info-url', readonly: true, value: url, spellcheck: 'false' });
 field.addEventListener('focus', () => field.select());
 const btn = el('button', { class: 'btn tiny', title: 'Copy this level\'s link' }, 'Copy link');
 btn.addEventListener('click', async () => {
 try {
 await navigator.clipboard.writeText(url);
 btn.textContent = t('Copied ✓');
 setTimeout(() => { btn.textContent = t('Copy link'); }, 1400);
 } catch { field.select(); document.execCommand?.('copy'); }
 });
 return el('div', { class: 'info-link-row' },
 el('label', { class: 'muted' }, 'Direct link'), field, btn);
}

// ---- 2. the three records, and who holds each ----

function infoRecordsSection(rec) {
 const best = rec.best;
 if (!best || (best.kg == null && best.pieces == null && best.time == null)) return null;
 // `*By` comes from the server, which breaks ties in favour of whoever got
 // there FIRST — matching a record doesn't take it off the person who set it.
 // A record with no holder at all means nobody has set it; a holder with no
 // name means somebody signed out did. Those are different facts and a dash
 // for both would lose one of them.
 const holder = (by) => {
 if (!by) return el('div', { class: 'record-by muted' }, '—');
 if (!by.name) return el('div', { class: 'record-by muted' }, 'anonymous');
 return el('div', { class: 'record-by muted' },
 by.id ? el('a', { href: '/user/' + encodeURIComponent(by.name) }, by.name) : by.name);
 };
 const tile = (val, label, by) => el('div', { class: 'record' },
 el('div', { class: 'record-val' }, val),
 el('div', { class: 'muted' }, label),
 holder(by));
 return el('section', { class: 'info-section' },
 el('h3', {}, 'Records'),
 el('div', { class: 'level-records' },
 tile(best.kg != null ? fmtKg(best.kg) : '—', 'lightest', best.kgBy),
 tile(best.pieces != null ? String(best.pieces) : '—', 'fewest pieces', best.piecesBy),
 tile(best.time != null ? fmtTime(best.time) : '—', 'quickest', best.timeBy),
 ));
}

// ---- 3. every solve, as a sortable/filterable sheet ----

// Columns are declared once: a header cell, how to read the value for sorting,
// and how to draw it. Sorting and rendering therefore can't disagree about
// what a column means, which is the usual way a table like this rots.
const SOLVE_COLS = [
 { id: 'num', label: '#', cls: 'num', get: (s) => s.num || 0 },
 { id: 'by', label: 'Who', cls: 'who', get: (s) => (s.by || '').toLowerCase() },
 { id: 'name', label: 'Name', cls: 'name', get: (s) => (s.name || '').toLowerCase() },
 { id: 'time', label: 'Time', cls: 'n', get: (s) => (s.won && s.time != null ? s.time : Infinity) },
 { id: 'pieces', label: 'Pieces', cls: 'n', get: (s) => (s.won ? s.pieces ?? Infinity : Infinity) },
 { id: 'kg', label: 'Weight', cls: 'n', get: (s) => (s.won ? s.kg ?? Infinity : Infinity) },
 { id: 'badges', label: 'Badges', cls: 'badges', get: (s) => computeBadges(s).length },
 { id: 'rating', label: 'Rating', cls: 'n', get: (s) => (s.rating ?? -1) },
 { id: 'at', label: 'Saved', cls: 'n', get: (s) => s.at || 0 },
];

function infoSolvesSection(rec, onWatch, repaint) {
 // **This level's own Local saves sit in here with the server's.** That was
 // always the intent — `_saveSolveLocally`'s comment says a Local save is
 // "the same shape the server stores, so the level's own solve list can show
 // them alongside server ones without a second code path" — and the list was
 // never actually given them, so the one screen where you would go looking for
 // your run on THIS level was the one screen that didn't have it.
 //
 // They are yours and they are on this device, so no author filter or
 // visibility rule applies: `localSolveRows` tags them `local: true` and the
 // row chrome already knows what that means (the `local` class, the on-device
 // delete, no copy-link).
 const local = rec.id ? localSolveRows().filter((s) => s.levelId === rec.id) : [];
 const all = [...local, ...(rec.solveList || [])];
 // Default: newest first, which is the order the server sends and the order
 // "what just happened" wants. Every other column sorts ascending first
 // because for time/pieces/weight ascending IS the leaderboard.
 // Remembered across levels, not per level (§8.1): "show me the wet ones" is
 // a habit you carry from level to level, and re-picking it on every one
 // would make the filter not worth using.
 const prefs = tablePrefs('level.solves',
 { sort: 'at', dir: -1, q: '', author: '', status: '', badges: new Set(), badgeNot: new Set(), view: 'table' });
 const state = prefs.state;

 const search = el('input', { class: 'input search', placeholder: 'Search solves…', value: state.q });
 const authorIn = el('input', { class: 'input author', placeholder: 'Solve author…', value: state.author });
 const badges = badgeFilter(() => paint(), [...state.badges], { exclude: [...state.badgeNot] });
 state.badges = badges.set;
 state.badgeNot = badges.exclude;
 const statusSel = el('select', { class: 'input' },
 el('option', { value: '' }, 'Wins & attempts'),
 el('option', { value: 'won' }, 'Wins only'),
 el('option', { value: 'attempt' }, 'Attempts only'));
 statusSel.value = state.status;
 const count = el('span', { class: 'muted info-count' });
 const view = viewToggle(state, () => paint());
 const tbody = el('tbody', {});
 const tiles = el('div', { class: 'tiles-grid hidden' });

 // Everything is already in memory (the level payload carries up to 80
 // solves), so filtering is local and instant — no debounce, no re-fetch.
 // The author box is separate from the text box for the same reason the
 // Workshop's is: "show me everything by Ada" and "show me anything
 // mentioning ramp" are different questions and answering them with one
 // field makes both worse.
 for (const inp of [search, authorIn]) inp.addEventListener('input', () => { read(); paint(); });
 statusSel.addEventListener('change', () => { read(); paint(); });
 function read() {
 state.q = search.value.trim().toLowerCase();
 state.author = authorIn.value.trim().toLowerCase();
 state.status = statusSel.value;
 }

 const head = el('tr', {});
 for (const c of SOLVE_COLS) {
 // `head` is what the column SHOWS, `label` is what it is CALLED. The same
 // for every column that fits a word; the split exists so a column narrow
 // enough to be an icon (Visibility → 👁) still says "Sort by Visibility"
 // on hover rather than "Sort by 👁".
 const th = el('th', { class: c.cls, title: tf('Sort by {col}', { col: t(c.label) }) }, c.head ?? c.label, el('span', { class: 'sort-mark' }));
 th.addEventListener('click', () => {
 if (state.sort === c.id) state.dir = -state.dir;
 else { state.sort = c.id; state.dir = c.id === 'at' ? -1 : 1; }
 paint();
 });
 head.append(th);
 }
 head.append(el('th', { class: 'act' }, ''));
 const tableWrap = el('div', { class: 'solve-table-wrap' },
 el('table', { class: 'solve-table' }, el('thead', {}, head), tbody));

 function paint() {
 state.badges = badges.set;
 state.badgeNot = badges.exclude;
 prefs.save();
 const col = SOLVE_COLS.find(c => c.id === state.sort) || SOLVE_COLS[0];
 const rows = all.filter((s) => {
 if (state.status === 'won' && !s.won) return false;
 if (state.status === 'attempt' && s.won) return false;
 if (state.author && !(s.by || '').toLowerCase().includes(state.author)) return false;
 if (!badges.matches(computeBadges(s))) return false;
 if (state.q) {
 const hay = `${s.by || ''} ${s.name || ''} ${s.comment || ''} ${s.num || ''}`.toLowerCase();
 if (!hay.includes(state.q)) return false;
 }
 return true;
 }).sort((a, b) => {
 const av = col.get(a), bv = col.get(b);
 if (av === bv) return (b.at || 0) - (a.at || 0); // stable-ish: newest first within a tie
 return av > bv ? state.dir : -state.dir;
 });

 for (const th of head.children) th.classList.remove('sorted-up', 'sorted-down');
 const idx = SOLVE_COLS.findIndex(c => c.id === state.sort);
 if (idx >= 0) head.children[idx].classList.add(state.dir > 0 ? 'sorted-up' : 'sorted-down');

 tbody.innerHTML = '';
 for (const s of rows) tbody.append(infoSolveRow(rec, s, onWatch, repaint));
 count.textContent = rows.length === all.length
 ? tf('{n} shown', { n: all.length })
 : tf('{n} of {m} shown', { n: rows.length, m: all.length });
 if (!rows.length) {
 tbody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(SOLVE_COLS.length + 1) },
 all.length ? 'Nothing matches those filters.' : 'No solves yet. Be first.')));
 }
 const tilesOn = state.view === 'tiles';
 tableWrap.classList.toggle('hidden', tilesOn);
 tiles.classList.toggle('hidden', !tilesOn);
 if (tilesOn) {
 fillTiles(tiles, rows, all.length ? 'Nothing matches those filters.' : 'No solves yet. Be first.',
 (s) => solveCard({ ...s, levelId: s.levelId || rec.id, levelName: s.levelName || rec.name }));
 }
 }
 paint();

 return el('section', { class: 'info-section' },
 el('h3', {}, tf('Solves ({n})', { n: rec.solves || 0 })),
 // Author BEFORE search — the one row on the site that reverses §8.2's
 // text-first order, on request (2026-08-05), and the table it filters is
 // why it reads right: solves are runs BY people, the first named column
 // is the player, and "show me ada's runs" is the question this panel is
 // opened with far more often than "find the word ramp".
 el('div', { class: 'info-filters' }, authorIn, search, statusSel, badges.el, count, view),
 tableWrap,
 tiles,
 );
}

function infoSolveRow(rec, s, onWatch, repaint) {
 const me = api.user();
 const badges = computeBadges(s);

 let visCtrl = null;
 if (me && (me.id === s.byId || me.isAdmin)) {
 // While this run backs a live bar the stops narrow to two: where it
 // stands, and PUBLIC — which concedes (closes the challenge, returns the
 // stake). Every other move 409s, and a control that offers a refusal is
 // the shape §16 is about.
 const cur = s.public ? 'public' : s.unlisted ? 'unlisted' : 'private';
 const stops = s.challengeId
 ? [['public', 'Public'], [cur, cur[0].toUpperCase() + cur.slice(1)]].filter((x, i, a) => a.findIndex(y => y[0] === x[0]) === i)
 : [['public', 'Public'], ['unlisted', 'Unlisted'], ['private', 'Private']];
 const visSel = el('select', {
 class: 'input solve-visibility',
 title: s.challengeId
 ? 'This run is backing a live challenge — hiding the machine is the deal. Publishing it closes the challenge and returns your stake.'
 : 'Public: searchable, everyone sees it. Unlisted: hidden from lists, but the direct link works. Private: nobody but you (or a guessed link) can see it.',
 },
 ...stops.map(([v, label]) => el('option', { value: v }, label)));
 visSel.value = cur;
 visSel.addEventListener('change', async () => {
 const v = visSel.value;
 try {
 await api.setSolveVisibility(rec.id, s.id, v);
 s.public = v === 'public'; s.unlisted = v === 'unlisted';
 repaint();
 } catch {
 alert('Could not change visibility.');
 visSel.value = s.public ? 'public' : s.unlisted ? 'unlisted' : 'private';
 }
 });
 visCtrl = visSel;
 }

 // the shareable link only actually works for unlisted or public — a private
 // solve is invisible even to a guessed link, so don't offer one that would
 // just mislead whoever it's handed to
 let linkBtn = null;
 if ((s.public || s.unlisted) && s.id && (me?.id === s.byId || me?.isAdmin)) {
 linkBtn = el('button', { class: 'btn tiny', title: 'Copy a direct link to this solution' }, '📋');
 linkBtn.addEventListener('click', async () => {
 const url = location.origin + '/play/' + encodeURIComponent(rec.id) + '/' + encodeURIComponent(s.id);
 try {
 await navigator.clipboard.writeText(url);
 const old = linkBtn.textContent;
 linkBtn.textContent = '✓';
 setTimeout(() => { linkBtn.textContent = old; }, 1200);
 } catch { prompt('Link:', url); }
 });
 }

 // Delete, on your own PRIVATE solves only. The server enforces the same
 // rule; this just doesn't offer a button that would be refused. A public or
 // unlisted solve has been seen by other people — it can be made private
 // first, which is the deliberate two-step.
 const delBtn = s.local
 ? localDeleteButton(s, () => repaint())
 : deleteSolveButton(rec.id, s, () => {
 rec.solveList = (rec.solveList || []).filter(x => x.id !== s.id);
 if (s.won && s.public) rec.solves = Math.max(0, (rec.solves || 1) - 1);
 repaint();
 });

 const note = s.comment
 ? el('div', { class: 'solve-note muted' },
 `“${s.comment}”`,
 // a note is a comment, so it gets thumbs like every other comment
 commentThumbs(
 { byId: s.byId, up: s.commentUp, down: s.commentDown, yourVote: s.yourCommentVote },
 (v) => api.voteSolveComment(rec.id, s.id, v)))
 : null;

 const tr = el('tr', { class: 'solve-tr' + (s.won ? '' : ' attempt') + (s.local ? ' local' : '') },
 el('td', { class: 'num muted' }, s.num ? '#' + s.num : ''),
 el('td', { class: 'who' },
 // A local save has no author on the server to link to — it is yours, and
 // saying so beats the bare "anonymous" the fallback would print.
 s.local ? el('span', { class: 'muted', title: 'Kept in this browser only — never sent to the server' }, 'on this device')
 : s.byId ? el('a', { href: '/user/' + encodeURIComponent(s.by) }, s.by) : (s.by || t('anonymous')),
 // a private/unlisted solve only ever appears in this list for its owner
 // or an admin (server-side filter) — safe to show unconditionally
 s.public === false ? el('span', { class: 'muted' }, s.unlisted ? ' 🔗' : ' 🔒') : null),
 el('td', { class: 'name' }, s.name || '',
 // Remix credit (§11.3) — the run was built on somebody's loaded solve,
 // and their name rides with it wherever the run is listed. "after", the
 // word cover versions use, because that is what this is.
 s.basedOn ? el('span', { class: 'muted solve-after', title: tf("Built on {who}'s solve — loaded, then saved as this run", { who: s.basedOn.by }) }, ' · ' + tf('after {who}', { who: s.basedOn.by })) : null,
 note),
 el('td', { class: 'n' }, s.won ? fmtTime(s.time) : el('span', { class: 'muted' }, 'attempt')),
 el('td', { class: 'n' }, s.won ? String(s.pieces ?? '') : ''),
 el('td', { class: 'n' }, s.won ? fmtKg(s.kg) : ''),
 el('td', { class: 'badges' }, badgeRow(badges, 'solve-badges', { tiny: true })),
 el('td', { class: 'n' }, solveStars(rec.id, s) || el('span', { class: 'muted' }, '—')),
 el('td', { class: 'n muted' }, s.at ? timeAgo(s.at) : ''),
 el('td', { class: 'act' },
 visCtrl, linkBtn, delBtn,
 // Watch LOADS it (§11.3) — their machine becomes yours to run, take apart
 // or change, credited by the card that opens it. The tooltip says so,
 // because a button that replaces what you were building should admit it,
 // and it names the way back.
 (s.design || s.hasDesign) ? el('button', {
 class: 'btn tiny',
 title: s.won
 ? 'Load this machine and run it — it becomes yours to change. Ctrl+Z puts your own build back.'
 : 'Load this attempt and run it — it becomes yours to change. Ctrl+Z puts your own build back.',
 onclick: async () => {
 let sol = s;
 if (!sol.design && rec.id && s.id && !s.local) {
 try {
 const full = await api.fetchSolve(rec.id, s.id);
 sol = { ...s, design: full.design, goals: full.goals ?? s.goals };
 } catch { /* gone or private */ }
 }
 if (!sol.design) return;
 onWatch(sol);
 },
 }, '▶ Watch') : null),
 );
 hoverThumb(tr, () => solveThumbContent(s));
 return tr;
}

// The ✕ on a solve. Offered only where the server would allow it: your own
// (or an admin's view of a) PRIVATE solve. Public and unlisted runs have an
// audience, so they get made private first — a two-step that makes "this is
// gone for good" a thing you say twice.
// The ✕ on a LOCAL save. Nothing to do with the server: it removes the record
// from this browser's `localSolves.<levelId>` and nothing else. One helper
// because two tables show local saves now — your profile and the level's own
// solve list — and a delete that only worked on one of them is the kind of
// half-feature this whole round is about.
function localDeleteButton(s, after) {
 if (!s.levelId || !s.id) return null;
 const b = el('button', {
 class: 'btn tiny danger',
 title: 'Delete this local save — permanent, and only on this device',
 }, '✕');
 b.addEventListener('click', async () => {
 if (!await confirmModal('Delete this local save?',
 ['It only exists in this browser — it was never saved to the server.', `This can't be undone.`])) return;
 const key = 'localSolves.' + s.levelId;
 store.set(key, store.get(key, []).filter(x => x.id !== s.id));
 after?.(s);
 });
 return b;
}

function deleteSolveButton(levelId, s, after) {
 const me = api.user();
 if (!levelId || !s.id) return null;
 // **Never a SERVER delete on a local save.** There is no row on the server to
 // delete, so this would 404 — and an ADMIN reached it, because the ownership
 // test below is satisfied by `isAdmin` alone and a local record has no
 // `byId` to fail it. `localDeleteButton` is the one that means anything here.
 if (s.local) return null;
 const mine = me && (me.id === s.byId || me.isAdmin);
 // private OR unlisted — the same line the level button and the route draw:
 // public is protected, everything that was never listed is yours to remove
 const unlisted = s.public === false;
 if (!mine || (!unlisted && !me?.isAdmin)) return null;
 const b = el('button', {
 class: 'btn tiny danger',
 title: tf('Delete this {vis} solve — permanent', { vis: t(s.unlisted ? 'unlisted' : s.public ? 'public' : 'private') }),
 }, '✕');
 b.addEventListener('click', async () => {
 if (!await confirmModal('Delete this solve?',
 [s.name ? tf('“{name}” will be removed for good.', { name: s.name }) : t('This solve will be removed for good.'), `This can't be undone.`])) return;
 b.disabled = true;
 try { await api.deleteSolve(levelId, s.id); after?.(s); }
 catch (ex) { b.disabled = false; alert(t(ex.message || 'Could not delete that.')); }
 });
 return b;
}

// ---- 4. the talking ----

function infoCommentsSection(rec) {
 // the count is re-read from the list rather than baked into the heading, so
 // posting one doesn't leave "Comments (0)" sitting above a comment
 const heading = el('h3', {});
 const wrap = el('div', { class: 'comments' });
 const paintCount = () => { heading.textContent = tf('Comments ({n})', { n: (rec.comments || []).length }); };
 paintCount();

 const canModerate = !!(api.user()?.isAdmin || api.user()?.isModerator);
 const commentRow = (c) => {
 const textEl = el('p', {}, esc(c.text));
 return el('div', { class: 'comment' },
 el('strong', {}, esc(c.author || t('anonymous'))),
 el('span', { class: 'muted' }, ' ' + timeAgo(c.at)),
 commentThumbs(c, (v) => api.voteComment(rec.id, c.id, v)),
 canModerate ? el('button', {
 class: 'btn tiny ghost comment-remove', title: 'Replace this comment\'s text with a default redaction (moderator)',
 onclick: async () => {
 if (!await confirmModal('Replace this comment?',
 ['Its text becomes "What are they like!".'], { confirmLabel: 'Replace' })) return;
 try { const updated = await api.replaceComment(rec.id, c.id); textEl.textContent = updated.text; }
 catch { alert('Could not replace the comment.'); }
 },
 }, '✎') : null,
 canModerate ? el('button', {
 class: 'btn tiny ghost comment-remove', title: 'Remove this comment (moderator)',
 onclick: async (e) => {
 if (!await confirmModal('Remove this comment?', ['It will be deleted for good.'], { confirmLabel: 'Remove' })) return;
 try {
 await api.deleteComment(rec.id, c.id);
 e.target.closest('.comment').remove();
 rec.comments = (rec.comments || []).filter(x => x.id !== c.id);
 paintCount();
 }
 catch { alert('Could not remove the comment.'); }
 },
 }, '✕') : null,
 textEl);
 };
 for (const c of (rec.comments || [])) wrap.append(commentRow(c));

 const comIn = el('input', { class: 'input', placeholder: 'Say something…', maxlength: 280 });
 const send = el('button', {
 class: 'btn tiny primary',
 onclick: async () => {
 const text = comIn.value.trim();
 if (!text) return;
 try {
 const c = await api.comment(rec.id, text, api.user() ? undefined : store.get('playerName', '') || 'anonymous');
 (rec.comments ||= []).push(c);
 wrap.append(commentRow(c));
 paintCount();
 comIn.value = '';
 } catch { /* offline */ }
 },
 }, 'Post');

 return el('section', { class: 'info-section' },
 heading, wrap, el('div', { class: 'comment-input' }, comIn, send));
}

// A compact 5-star control for one published solution. Only shown on solves
// that are actually published — an unlisted or private one has no audience to
// rate it — and never on your own, which the server refuses anyway.
function solveStars(levelId, s) {
 if (!s.public || !s.won) return null;
 const me = api.user();
 const mine = me && s.byId === me.id;
 const wrap = el('span', { class: 'solve-stars' });
 // the numbers live in the tooltip, same as the level's own scales
 const paint = () => {
 wrap.setAttribute('data-tip-1line', '');
 wrap.setAttribute('data-tip', s.rating != null
 ? tf(s.ratingCount === 1 ? 'Solution rated {a} out of 5 from 1 rating' : 'Solution rated {a} out of 5 from {n} ratings', { a: s.rating.toFixed(1), n: s.ratingCount })
 + (s.yourRating ? tf(' · you gave it {m}', { m: s.yourRating }) : '')
 : t(mine ? 'Nobody has rated your solution yet' : 'Unrated — click a star to rate this solution'));
 };
 if (!mine && me) {
 for (let i = 1; i <= 5; i++) {
 const b = el('button', {
 class: 'star tiny' + ((s.yourRating || 0) >= i ? ' on' : ''),
 title: tf('Rate this solution {i}/5', { i }),
 }, '★');
 b.addEventListener('click', async () => {
 try {
 const r = await api.rateSolve(levelId, s.id, i);
 s.yourRating = i; s.rating = r.rating; s.ratingCount = r.ratingCount;
 [...wrap.querySelectorAll('.star')].forEach((st, j) => st.classList.toggle('on', j < i));
 paint();
 } catch (e) { alert(e.message || 'Could not rate that.'); }
 });
 wrap.append(b);
 }
 } else if (s.rating != null) {
 wrap.append(el('span', { class: 'muted' }, starStr(s.rating)));
 }
 paint();
 return wrap;
}

// Thumbs up/down on a comment. Clicking the way you already voted clears it,
// which is the only way to un-vote — matching how the server treats a repeat.
// Thumbs for any comment anywhere — a level comment or the note on a solve.
// `state` needs { byId, up, down, yourVote } and is updated in place so the
// caller's record stays true; `cast(v)` does whichever API call applies and
// returns the server's fresh tally.
function commentThumbs(state, cast) {
 const me = api.user();
 const wrap = el('span', { class: 'comment-votes' });
 const tally = el('span', { class: 'muted' });
 const paint = () => {
 const up = state.up || 0, down = state.down || 0;
 tally.textContent = (up || down) ? ` ${up ? '+' + up : ''}${up && down ? ' ' : ''}${down ? '−' + down : ''}` : '';
 };
 // Signed in, and not your own words: the same rule the server enforces, so
 // the buttons are never offered for a request that would be refused.
 if (me && state.byId !== me.id) {
 const mk = (v, glyph, title) => {
 const b = el('button', { class: 'btn tiny ghost vote' + (state.yourVote === v ? ' on' : ''), title }, glyph);
 b.addEventListener('click', async () => {
 try {
 const r = await cast(v);
 state.yourVote = r.yours; state.up = r.up; state.down = r.down; state.score = r.score;
 [...wrap.querySelectorAll('.vote')].forEach(x => x.classList.remove('on'));
 if (r.yours === v) b.classList.add('on');
 paint();
 } catch (e) { alert(e.message || 'Could not vote.'); }
 });
 return b;
 };
 wrap.append(mk(1, '👍', 'Helpful'), mk(-1, '👎', 'Not helpful'));
 }
 paint();
 wrap.append(tally);
 return wrap;
}

// ---------- maker ----------

function makerScreen({ draftId, officialId, levelId } = {}) {
 mainEl.className = 'main full';
 const holder = el('div', { class: 'screen-holder' });
 // GameScreen overwrites its root element's className to 'game-root'
 // (position:absolute), so it needs its OWN child div here — handing it
 // `holder` directly destroys `.screen-holder`'s position:relative anchor
 // and the editor's whole top bar (Back/name/Machine·Level tabs) ends up
 // positioned against the viewport, hidden behind the sticky site nav.
 const gameHost = el('div', { class: 'game-host' });
 holder.append(gameHost);
 mainEl.append(holder);
 document.title = t('Level Maker — LIFIRIK');

 // Set by the editor's own '‹ Back', read by the teardown below. Every
 // departure lands in destroy() — including a deliberate one, which navigates
 // and so routes like any other — so "was this on purpose" has to be a flag
 // carried across, not a second call site. (It was two call sites first, and
 // the deliberate exit nagged anyway: onExit said "deliberate", then the
 // hashchange it caused ran destroy(), which said "accidental".)
 let deliberateExit = false;
 const mount = (level, opts = {}) => {
 const screen = new GameScreen(gameHost, {
 level,
 name: level.name || 'Level Maker',
 desc: level.desc,
 mode: 'maker',
 draftId: opts.draftId,
 adminOfficialId: opts.officialId,
 levelId: opts.officialId || opts.levelId || null,
 // the author's own server level, opened to edit in place (§11.9)
 serverLevelId: opts.levelId || null,
 serverSettled: opts.settled || false,
 // a draft has no number until it's published; exports read 000000
 levelNum: opts.levelNum ?? null,
 isOfficial: opts.isOfficial,
 inspiredBy: opts.inspiredBy || null, // prefills the publish dialog's credit box (§11.9)
 // Back is "where you came from": the level you opened this from, the
 // campaign page, the Workshop — home only when there is nowhere else
 onExit: () => { deliberateExit = true; go(makerFrom || '/'); },
 });
 currentScreen = {
 // the shell asks before taking Ctrl+Z off the editor (see makerReturn)
 canUndo: () => screen.canUndo(),
 destroy() {
 // Whatever took us off this screen, remember the way back — Ctrl+Z
 // undoes the departure (see makerReturn). Only an ACCIDENT gets the
 // note; leaving on purpose needs no offer to undo it.
 leftMaker(makerHash, { deliberate: deliberateExit });
 screen.destroy();
 },
 };
 };
 // the route as it stands now, captured before anything can navigate: by the
 // time destroy() runs, location.pathname is already the NEW screen's
 const makerHash = location.pathname;

 if (officialId) {
 // admin edit-in-place through the normal Maker (§13) — works on ANY
 // level id, not just the 32 officials; isOfficial only affects wording
 api.level(officialId).then(rec => {
 const level = { ...rec.data, name: rec.name, desc: rec.desc, hint: rec.hint };
 mount(level, { officialId, isOfficial: !!rec.official, levelNum: rec.num, inspiredBy: rec.inspiredBy });
 }).catch(() => holder.append(el('p', { class: 'center-msg' }, 'Level not found.')));
 return;
 }

 // An author editing one of their own server levels (§11.9) — the same load
 // and the same save-back as the admin path above, minus the admin wording.
 // `settled` decides whether the layout may still travel with it, and it is
 // asked of the SERVER rather than assumed: the level may have been played
 // between the profile listing this button and the author clicking it.
 if (levelId) {
 api.level(levelId).then(rec => {
 const level = { ...rec.data, name: rec.name, desc: rec.desc, hint: rec.hint };
 mount(level, { levelId, settled: !!rec.settled, levelNum: rec.num, inspiredBy: rec.inspiredBy });
 }).catch(() => holder.append(el('p', { class: 'center-msg' }, 'Level not found, or not yours to edit.')));
 return;
 }

 if (draftId) {
 const drafts = store.get('maker.drafts', {});
 const d = drafts[draftId];
 // A draft that has already been saved to the server reopens as THAT level
 // (§11.9) — the link is the whole point, and a draft that forgot it would
 // quietly start a second copy on the next save.
 if (d && d.serverId) {
 api.level(d.serverId).then(rec => {
 const level = { ...rec.data, name: rec.name, desc: rec.desc, hint: rec.hint };
 mount(level, { levelId: d.serverId, settled: !!rec.settled, levelNum: rec.num, draftId, inspiredBy: rec.inspiredBy });
 }).catch(() => mount(d.level, { draftId })); // deleted server-side: it is a local draft again
 return;
 }
 if (d) { mount(d.level, { draftId }); return; }
 }
 const id = draftId || Math.random().toString(36).slice(2, 8);
 if (!draftId) {
 go('/maker/' + id);
 return;
 }
 mount(newMakerLevel(), { draftId: id });
}

// ---------- import (FC-format level text → a LIFIRIK level) ----------

// Hand-authored demo in source units, and format documentation in one: a
// 1400×100 ground slab with a small ramp, a 100-high ledge carrying the goal
// area, a boulder, a loose plank, and the goal ball parked in the build area.
// The ledge is a `CR` rather than an `SR` so the example carries the letter
// rule too — it comes out grass, and stays grass whatever the texture picker
// says, because the code names it.
//
// Plus a machine, because the three machine statements read nothing like the
// pieces and an example is the shortest way to say so: three joints, the three
// sticks between them, and a driven wheel on each of the two on the ground —
// an FC car, sitting on the slab behind the ball it is there to push.
//
// **A node counts back in ENTRIES, not in joints**, which is why the offsets
// grow as it goes: each rod pushes the joints one further up the paste, so the
// triangle is -3,-2 then -3,-2 again then -5,-3, and both wheels reach past
// three rods with -6. Worth reading twice — it is the one thing about the
// format that does not work the way it looks like it does. The offsets are
// relative, so this block behaves identically wherever it sits in a paste.
const FC_EXAMPLE = [
 'BA,-450,-50,300,200,0',
 'GA,250,-105,160,110,0',
 'SR,0,100,1400,100,0',
 'CR,250,25,200,150,0',
 'SR,-150,60,220,40,-14',
 'DC,20,5,90,90,0',
 'DR,110,-55,120,14,0',
 'GC,-450,25,50,50,0',
 'J,-580,25',
 'J,-500,25',
 'J,-540,-45',
 'R,1,-3,-2',
 'R,1,-3,-2',
 'R,1,-5,-3',
 'W,1,-6',
 'W,1,-6',
].join(';');

// The long form of the same example: his own six lines, plus a machine to show
// the Placed* statements. The goal crate keeps its 90° on purpose — it is the
// one thing in the paste that can't cross, and the warning says so.
const FC_EXAMPLE_LONG = [
 'Type#index (center_x, center_y), (width, height), rotation_degrees, [joint_indices...]',
 'BuildArea (-200, -100), (210, 210), 0',
 'GoalArea (200, -50), (110, 110), 0',
 'StaticRect (0, 20), (1000, 40), 0',
 'StaticCircle (0, 20), (60, 60), 0',
 'GoalRect#0 (0, -30), (30, 90), 90',
 'GoalCircle#1 (0, -30), (40, 40), 0, [0]',
 'PlacedPin#2 (-160, -25)',
 'PlacedCWWheel#3 (-100, -25), (50, 50), 0',
 'PlacedRod#4 (-130, -25), (60, 4), 0, [2, 3]',
].join('\n');

// (`FC_CODE_HELP` lived here — a fifteen-row table of the whole grammar under
// the paste box, removed 2026-08-10 on request along with the lede that said
// the same things in prose. It was a reference manual printed on the one screen
// that does not need one: you arrive holding text somebody else wrote, paste
// it, and the preview says whether it worked. What it could not read, the
// warnings name; the codes it had to guess at now get a row and a selector of
// their own. The two example buttons remain, and they teach the grammar by
// being it.)

// ---------- tutorial (§18) ----------
//
// The demos are REAL: each canvas runs an actual Simulation of the machines
// in tutorial-demos.js and draws it with the game's own renderer. Determinism
// (§5.8) is what makes that possible — the loop replays identically on every
// visit — and verify-tutorial.mjs gates that the machines still win, so a
// physics retune cannot quietly turn "watch it work" into "watch it fail".
const DEMO_FPS_STEP = 1 / 60;
// Where a demo points its camera. Pulled out of `liveDemo` because three
// things now need it — the running demo, the build-along, and the static
// picture — and a demo framed differently from the one beside it reads as a
// different game rather than the same one twice.
//
// `box` overrides the automatic framing, which is what the contrast demos
// want: they are about a machine, and the level's goal zone sits far off to
// one side purely so the level is legal.
function demoFrame(level, w, h, box) {
 let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
 const grow = (x0, y0, x1, y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };
 if (box) {
 grow(box.x - box.w / 2, box.y - box.h / 2, box.x + box.w / 2, box.y + box.h / 2);
 } else {
 for (const z of [...level.buildZones, ...level.goalZones]) grow(z.x - z.w / 2, z.y - z.h / 2, z.x + z.w / 2, z.y + z.h / 2);
 for (const t of level.terrain.slice(1)) grow(t.x - t.w / 2, t.y - t.h / 2, t.x + t.w / 2, t.y + t.h / 2);
 grow(minX, 40, maxX, 40); // include a strip of floor
 }
 const pad = box ? 8 : 30;
 const zoom = Math.min((w * 2) / (maxX - minX + pad * 2), (h * 2) / (maxY - minY + pad * 2));
 return { zoom, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// One scene, drawn at rest: the level with nothing running. Shared by the
// build-along (which needs a backdrop to place pieces onto) and by the static
// picture of a level's skeleton.
function drawSceneAtRest(ctx, level, { zones = true } = {}) {
 // Zones under the terrain, same as the game and as renderPreview — a still
 // that printed the violet wash on top of the floor was a picture of a
 // build area showing through the level.
 if (zones) drawZones(ctx, level);
 drawTerrainAll(ctx, level, null, 0);
 for (const g of (level.goalObjs || [])) drawGoalPiece(ctx, g, null);
}

// A mouse pointer, drawn at a constant SIZE on screen whatever the demo's
// zoom — it is a picture of the reader's own cursor, and a cursor that grew
// with the camera would read as part of the world.
function drawDemoCursor(ctx, x, y, zoom, pressed) {
 const s = 1.6 / zoom;
 ctx.save();
 ctx.translate(x, y);
 ctx.scale(s, s);
 if (pressed) {
 ctx.beginPath();
 ctx.arc(0, 0, 9, 0, Math.PI * 2);
 ctx.fillStyle = 'rgba(101,88,230,.22)';
 ctx.fill();
 }
 ctx.beginPath();
 ctx.moveTo(0, 0); ctx.lineTo(0, 15.5); ctx.lineTo(4.1, 12.1); ctx.lineTo(6.7, 18);
 ctx.lineTo(9.4, 16.7); ctx.lineTo(6.8, 11); ctx.lineTo(11.6, 10.4); ctx.closePath();
 ctx.fillStyle = pressed ? '#6558e6' : '#fff';
 ctx.strokeStyle = '#232a35';
 ctx.lineWidth = 1.5;
 ctx.lineJoin = 'round';
 ctx.fill();
 ctx.stroke();
 ctx.restore();
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The box the hand works inside — the machine's own extent, with room around it
// for the cursor to come in from and for the ground under it.
function buildBoxOf(design) {
 let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
 for (const p of design.parts) {
 const xs = p.t === 'wheel' ? [p.x - p.r, p.x + p.r] : [p.x1, p.x2];
 const ys = p.t === 'wheel' ? [p.y - p.r, p.y + p.r] : [p.y1, p.y2];
 minX = Math.min(minX, ...xs); maxX = Math.max(maxX, ...xs);
 minY = Math.min(minY, ...ys); maxY = Math.max(maxY, ...ys);
 }
 const padX = 78, padTop = 62, padBot = 34; // room for the cursor, and the floor
 return {
 x: (minX + maxX) / 2, y: (minY - padTop + maxY + padBot) / 2,
 w: (maxX - minX) + padX * 2, h: (maxY + padBot) - (minY - padTop),
 };
}

// The gestures that build a design, as a timeline. A wheel is a CLICK; a stick
// is a DRAG, and showing the drag is the whole point — "press here, pull to
// there" is a sentence nobody reads and a picture everybody follows.
function buildScript(design) {
 const MOVE = 0.42, CLICK = 0.26, DRAG = 0.58, GAP = 0.16, HOLD = 1.1;
 const acts = [];
 let t = 0, cur = null;
 for (const p of design.parts) {
 const a = p.t === 'wheel' ? { x: p.x, y: p.y } : { x: p.x1, y: p.y1 };
 const b = p.t === 'wheel' ? a : { x: p.x2, y: p.y2 };
 acts.push({ kind: 'move', from: cur || { x: a.x - 70, y: a.y - 60 }, to: a, t0: t, dur: MOVE });
 t += MOVE;
 const dur = p.t === 'wheel' ? CLICK : DRAG;
 acts.push({ kind: p.t === 'wheel' ? 'click' : 'drag', part: p, from: a, to: b, t0: t, dur });
 t += dur + GAP;
 cur = b;
 }
 return { acts, buildS: t + HOLD, end: cur };
}

// Where the hand is, and how much of the machine exists, at time t.
function buildStateAt(script, design, t) {
 const placed = [];
 let cursor = script.acts[0]?.from || { x: 0, y: 0 }, pressed = false, partial = null;
 for (const a of script.acts) {
 if (t >= a.t0 + a.dur) { // finished
 if (a.kind !== 'move') placed.push(a.part);
 cursor = a.to;
 continue;
 }
 if (t < a.t0) break; // not started
 const k = (t - a.t0) / a.dur;
 const ease = k * k * (3 - 2 * k); // smoothstep — a hand, not a servo
 cursor = { x: a.from.x + (a.to.x - a.from.x) * ease, y: a.from.y + (a.to.y - a.from.y) * ease };
 if (a.kind === 'click') { pressed = true; cursor = a.to; }
 if (a.kind === 'drag') {
 pressed = true;
 partial = { ...a.part, x2: cursor.x, y2: cursor.y };
 }
 break;
 }
 return { cursor, placed, partial, pressed };
}

function liveDemo(level, design, loopS, { w = 560, h = 300, box = null, zones = true, build = false } = {}) {
 const cv = el('canvas', { class: 'demo-canvas', width: w * 2, height: h * 2 });
 const ctx = cv.getContext('2d');
 let sim = null, time = 0, raf = 0, visible = false, dead = false;

 const wide = demoFrame(level, w, h, box);
 // A build-along runs the hand first and the machine after, on one clock, so
 // the reader sees the thing they were just shown being made actually work.
 const script = build ? buildScript(design) : null;
 const buildS = script ? script.buildS : 0;
 // …and it watches from CLOSE UP while the hand works, then pulls back for the
 // run. A gesture shown at the scale of a whole level is a 20 px wheel
 // appearing in a corner; the level shown at the scale of a gesture cuts off
 // the payoff. So it is both, in the order you need them, with half a second
 // of travel between so the move reads as a camera rather than as a cut.
 const near = script ? demoFrame(level, w, h, buildBoxOf(design)) : wide;
 const PULL_S = 0.55;
 const cameraAt = (t) => {
 if (!script) return wide;
 const k = clamp01((t - buildS) / PULL_S);
 const e = k * k * (3 - 2 * k);
 return {
 zoom: near.zoom + (wide.zoom - near.zoom) * e,
 cx: near.cx + (wide.cx - near.cx) * e,
 cy: near.cy + (wide.cy - near.cy) * e,
 };
 };

 // **Every restart destroys the world it is replacing.** A Simulation owns a
 // Box2D world in wasm, which the JS garbage collector knows nothing about, so
 // dropping the reference leaks it. It always did — but one page with two
 // demos looping every seven seconds leaked slowly enough that nobody saw it.
 // The tour builds fresh demos on every step and runs three at once, and the
 // wasm heap gave out within a minute of opening it: `Aborted(stack overflow)`
 // from the binary, on a page containing no recursion at all.
 const restart = () => {
 if (sim) sim.destroy();
 sim = new Simulation(level, design);
 time = 0;
 };
 const frame = () => {
 if (dead) return;
 raf = requestAnimationFrame(frame);
 if (!visible || !sim) return;
 time += DEMO_FPS_STEP;
 if (time >= loopS + buildS) restart();
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 drawBackdrop(ctx, w * 2, h * 2, 'dusk', time);
 const { zoom, cx, cy } = cameraAt(time);
 ctx.setTransform(zoom, 0, 0, zoom, w - cx * zoom, h - cy * zoom);

 // ---- the hand, before the machine ----
 if (script && time < buildS) {
 const st = buildStateAt(script, design, time);
 drawSceneAtRest(ctx, level, { zones });
 drawRods(ctx, [...st.placed.filter((p) => p.t === 'rod'), ...(st.partial ? [st.partial] : [])], {});
 for (const p of st.placed) if (p.t === 'wheel') drawWheel(ctx, p, { x: p.x, y: p.y }, {});
 drawDemoCursor(ctx, st.cursor.x, st.cursor.y, zoom, st.pressed);
 return;
 }

 sim.step(DEMO_FPS_STEP);
 const view = sim.view();
 if (zones) drawZones(ctx, level, { goalRects: view.goalZones });
 drawTerrainAll(ctx, level, view.terrain, time);
 for (const p of view.props) drawProp(ctx, p.def, p);
 // the game's Z order: wheels and cargo by size, sticks in front
 for (const it of wheelCargoBackToFront(view.wheels, view.goals, (w) => w.part.r, (g) => goalStackR(g.def))) {
 if (it.kind === 'wheel') drawWheel(ctx, it.ref.part, it.ref, {});
 else drawGoalPiece(ctx, it.ref.def, it.ref);
 }
 drawRods(ctx, liveRods(view.rods), {});
 // the payoff beat: a gold WIN flash once the machine has done its job
 if (sim.won) {
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.font = '700 40px system-ui';
 ctx.textAlign = 'center';
 ctx.fillStyle = 'rgba(212,160,23,0.92)';
 ctx.fillText(t('★ Solved!'), w, 64);
 }
 };
 // only burn CPU while the demo is on screen
 const io = new IntersectionObserver((entries) => {
 visible = entries[0].isIntersecting;
 if (visible && !sim) restart();
 });
 io.observe(cv);
 raf = requestAnimationFrame(frame);
 // the router clears mainEl on navigation; stop the loop when the canvas goes
 const mo = new MutationObserver(() => {
 if (!document.contains(cv)) {
 dead = true;
 cancelAnimationFrame(raf); io.disconnect(); mo.disconnect();
 if (sim) { sim.destroy(); sim = null; } // …and the last one, on the way out
 }
 });
 mo.observe(document.body, { childList: true, subtree: true });
 return cv;
}

// A draped rope, drawn by the game's OWN rope pass rather than as an
// impression of one: a sagging run of links sharing a `chain` id, which is
// exactly what Alt+drag lays down (§10.1). Both figures are the same run — only
// the stick kind differs, which is the whole claim the picture is making.
function ropeFigure(kind) {
 const N = 12, xa = -36, xb = 36, y0 = -31, sag = 23;
 const pt = (i) => ({ x: xa + (xb - xa) * (i / N), y: y0 + Math.sin(Math.PI * (i / N)) * sag });
 const links = [];
 for (let i = 0; i < N; i++) {
 const a = pt(i), b = pt(i + 1);
 links.push({ t: 'rod', kind, chain: 'fig', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
 }
 return (c) => drawRods(c, links, {});
}

// Every buildable part, as labelled figures — the reference page's glossary.
function partsGlossary() {
 return el('div', { class: 'piece-row' },
 // r 20 — the STANDARD wheel — so the figure carries the engraved kind
 // letter the real piece wears (r 15 sits under the letter floor and
 // showed the reference page a bare face, 2026-08-25)
 pieceFigure((c) => drawWheel(c, { t: 'wheel', kind: 'ccw', r: 20 }, { x: 0, y: -15 }, {}), 'L wheel — rolls left'),
 pieceFigure((c) => drawWheel(c, { t: 'wheel', kind: 'free', r: 20 }, { x: 0, y: -15 }, {}), 'F wheel — free'),
 pieceFigure((c) => drawWheel(c, { t: 'wheel', kind: 'cw', r: 20 }, { x: 0, y: -15 }, {}), 'R wheel — rolls right'),
 pieceFigure((c) => drawRod(c, { t: 'rod', kind: 'wood', x1: -34, y1: -8, x2: 34, y2: -26 }, {}), 'Wood stick — solid'),
 pieceFigure((c) => drawRod(c, { t: 'rod', kind: 'water', x1: -34, y1: -8, x2: 34, y2: -26 }, {}), 'Water stick — passes through your machine'),
 pieceFigure(ropeFigure('wood'), 'Wood rope — Alt+drag a stick tool'),
 pieceFigure(ropeFigure('water'), 'Wet rope — hangs through your machine'),
 pieceFigure((c) => drawGoalPiece(c, { shape: 'ball', r: 14 }, { x: 0, y: -18 }), 'Goal piece — deliver these'));
}

// A static piece drawn with the game's own art, as a small labelled figure.
function pieceFigure(draw, label, { w = 92, h = 78 } = {}) {
 const cv = el('canvas', { width: w * 2, height: h * 2, class: 'piece-canvas' });
 const ctx = cv.getContext('2d');
 ctx.setTransform(2, 0, 0, 2, w, h * 0.92);
 draw(ctx);
 return el('div', { class: 'piece-fig' }, cv, el('span', {}, label));
}

// ---------- pictures of CONTROLS (§18) ----------
//
// **Built from the editor's own CSS atoms, never screenshotted.** Three steps
// of the Level Maker guide are about a piece of interface rather than a piece
// of physics — the right-click menu, a slider you can type into, the keys that
// copy and paste — and a screenshot of any of them is a picture that starts
// rotting the day it is taken. These are the real classes (`ctx-menu`,
// `ctx-tool`, `tex-grid`, `dial-row`, `typable`), the real tool artwork
// (`toolIconSVG`, the same SVG the toolbar button draws) and the real texture
// swatches, laid out by hand and wired to nothing. When the menu is restyled,
// the picture of it is restyled too.
//
// Inert on purpose: a mock-up that half-works is worse than one that plainly
// does not, and the live article is one click away in the Maker.

// The mini toolbar every context menu opens with — Play, the tools, delete.
const mockTools = (ids, cols) => el('div', { class: 'ctx-tools', style: { '--ctx-cols': String(cols) } },
 ...ids.map((id) => el('span', {
 class: 'ctx-tool' + (id === 'terrain-box' ? ' active' : ''),
 html: toolIconSVG(id, 18) || '',
 })));

// A dial row: name, control, value — the shape every slider in the editor has.
// The value column stays put when the box opens, because that is what the real
// row does: `_typable` replaces the SLIDER inside its own cell and never
// touches the readout beside it.
const mockDial = (name, value, pos, { typed = false } = {}) => el('div', { class: 'dial-row' },
 el('span', { class: 'dial-name' }, name),
 typed
 ? el('span', { class: 'typable' },
 el('span', { class: 'typable-box' }, el('input', { class: 'typable-input', value, disabled: true })))
 : el('input', { type: 'range', min: '0', max: '100', value: String(pos), disabled: true }),
 el('span', { class: 'dial-val' }, value));

// A labelled row of mini-toolbar cells — Layer, Motion, Spin.
const mockLine = (label, ...cells) => el('div', { class: 'ctx-line' },
 el('span', { class: 'ctx-line-label' }, label),
 el('span', { class: 'ctx-cells' }, ...cells));
const mockCell = (html, text) => el('span', { class: 'ctx-tool' }, text ? text : null, html ? el('span', { html }) : null);

// A terrain piece's whole menu, as the author meets it.
function terrainMenuMock() {
 return el('div', { class: 'ctx-menu tour-menu' },
 mockTools(['pointer', 'wheel-ccw', 'wheel-free', 'wheel-cw', 'rod-wood', 'terrain-box', 'terrain-paint'], 7),
 el('div', { class: 'ctx-item ctx-strong danger' }, 'Delete'),
 el('div', { class: 'ctx-title' }, 'Texture'),
 el('div', { class: 'tex-grid' },
 ...['granite', 'grass', 'sand', 'ice', 'rubber', 'mud', 'belt', 'brick'].map((tx) => el('span', {
 class: 'tex-swatch' + (tx === 'ice' ? ' active' : ''),
 title: tx[0].toUpperCase() + tx.slice(1),
 style: { backgroundImage: `url(${textureSwatchURL(tx, 52, 52)})` },
 }))),
 el('div', { class: 'ctx-title tex-head' }, 'Surface', el('span', { class: 'tex-reset' }, 'reset')),
 mockDial('Grip', '0.06', 3),
 mockDial('Bounce', '0.00', 0),
 mockDial('Drag', '0.000', 0),
 mockDial('Belt', 'off', 50),
 mockLine('Layer',
 mockCell(zOrderIconSVG('front')), mockCell(zOrderIconSVG('up')),
 mockCell(zOrderIconSVG('down')), mockCell(zOrderIconSVG('back'))),
 mockLine('Motion', mockCell(null, '＋'), mockCell(null, '↻')));
}

// The same dial twice: dragged, and typed. The whole of "double-click it".
function sliderMock() {
 const panel = (caption, ...rows) => el('div', { class: 'tour-panel' },
 el('div', { class: 'ctx-menu tour-menu tour-menu-narrow' }, ...rows),
 el('span', { class: 'tour-panel-label' }, caption));
 return el('div', { class: 'tour-pair' },
 panel('drag it — for exploring',
 el('div', { class: 'ctx-title' }, 'Motion'),
 mockDial('Travel', '76', 62),
 mockDial('Spin', '0', 50)),
 panel('double-click it — for knowing',
 el('div', { class: 'ctx-title' }, 'Motion'),
 mockDial('Travel', '76', 62, { typed: true }),
 mockDial('Spin', '0', 50)));
}

// A row of gestures: a mark (keycap or the game's own icon), then what it
// does. The buttons step already uses this shape for the three mouse buttons.
// `{ html }` is a drawn glyph — GhostRun, Free World, a mouse button — so the
// Advanced tour shows the control you will look for, not a word for it.
const gestureMark = (k) => (k && typeof k === 'object' && k.html)
 ? el('span', { class: 'keycol-icon tour-button-icon', html: k.html })
 : el('kbd', {}, k);
const gestureRows = (...rows) => el('div', { class: 'tour-buttons' },
 ...rows.map(([k, lead, rest]) => el('div', { class: 'tour-button' },
 gestureMark(k),
 el('span', {}, el('b', {}, lead), rest ? ' ' + rest : null))));
const gIcon = (svg) => ({ html: svg });
const gMouse = (which) => gIcon(mouseButtonIconSVG(which, 22));

// ---------- the tutorial (§18) ----------
//
// **A journey, not a document.** This used to be one long page of nine prose
// sections with two demos in it — good writing that a newcomer scrolled past.
// It is now a sequence: one idea per screen, a picture on every single one, the
// words underneath the picture, and a Next button. Nothing to skim, nothing to
// scroll, no way to be lost.
//
// THE RULE THIS PAGE IS BUILT ON: show, then say. Every step leads with
// something running — a real `Simulation`, drawn by the real renderer — and the
// prose only names what you have already watched happen. Where a rule needed
// stating, it is staged as a CONTRAST instead: the same machine twice, one
// thing different, both live. You cannot mis-read "ends that meet, join" when
// the loose one is lying on the floor next to it.
//
// THE ARC is chosen by desire rather than by taxonomy — each step should make
// you want the next. Watch a machine work → watch one being built → the one
// rule → the three wheels → the buttons → gravity does it for free → make a
// level → beat it → dare somebody. It ends where the player becomes an author
// with something at stake, because that is the point at which somebody stays.
//
// WHAT IS DELIBERATELY NOT HERE: the tool table, the seventy shortcuts, the
// badge definitions, terrain surfaces, groups, motion paths, the scenery layer,
// ropes, water sticks, the fence. All of it is on `/keys`, one click away.
// A tutorial that lists everything teaches nothing; this one teaches ten things
// and trusts the reference for the rest.

const TOUR_KEY = 'learnStep';

// A key on a keycap, and a row of them — used instead of writing the name of a
// key in prose, so the eye finds it without reading.
const tourKeys = (...ks) => el('span', { class: 'tour-keys' },
 ...ks.map((k) => el('kbd', {}, k)));

// A demo with its own caption, for the contrast pairs where the caption IS the
// lesson ("ends 4 px apart" / "ends touching").
const tourPanel = (label, node, tone) =>
 el('div', { class: 'tour-panel' + (tone ? ' ' + tone : '') },
 node, el('span', { class: 'tour-panel-label' }, label));

// One frame of a level at rest — no simulation, no loop. For the step that
// shows what a level is MADE of, where motion would only distract.
function stillPicture(level, { w = 460, h = 210, box = null } = {}) {
 const cv = el('canvas', { class: 'demo-canvas', width: w * 2, height: h * 2 });
 const ctx = cv.getContext('2d');
 const { zoom, cx, cy } = demoFrame(level, w, h, box);
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 drawBackdrop(ctx, w * 2, h * 2, 'dusk', 0);
 ctx.setTransform(zoom, 0, 0, zoom, w - cx * zoom, h - cy * zoom);
 drawSceneAtRest(ctx, level);
 return cv;
}

// The WHOLE level at rest — props, the level's own machine, labels and all.
//
// `stillPicture` above draws terrain, zones and goal pieces, which is every
// piece the beginner chapters have. The Level Maker guide's examples are made
// of exactly the things it leaves out, so this one goes through
// `renderPreview` — the same pass that draws a level card, and the only
// drawing code in the app that knows how to put a whole level on a canvas. A
// second hand-rolled scene walker would be a second thing to keep in step with
// the renderer, and it would be wrong first about whichever piece was added
// next.
function levelPicture(level, { w = 480, h = 240 } = {}) {
 const cv = el('canvas', { class: 'demo-canvas', width: w * 2, height: h * 2 });
 renderPreview(cv, level);
 return cv;
}

// The prose of a tutorial step, from the content registry (§13.1): admin
// editable, with `**bold**`, `[[Space]]` keycaps and `[label](/hash)` links.
// `tourKeys` is passed in rather than imported by content.js — the parser is
// pure and knows nothing about how this app draws a key.
const rich = (key) => parseRich(txt(key), { el, keys: tourKeys });

// ---------- the hands-on step (§18) ----------
//
// **A tiny real editor, three tools wide.** The step before this one SHOWS a
// cart being built; this one hands the reader the same level and the same two
// gestures — click a wheel down, drag a stick out — against the genuine
// Simulation, so their first win happens inside the tutorial rather than
// being promised by it. Deliberately NOT a GameScreen: no selection, no
// undo-stack, no menus — placing, running, and taking back are the whole
// vocabulary, because the step teaches two gestures and a payoff, not an
// editor.
//
// What it borrows from the real thing it borrows exactly: parts use the
// design schema, joints form the way §6 says (shared endpoint coordinates —
// the snap makes them EQUAL, not close), the build zone confines placement,
// and CART_LEVEL is the same level verify-tutorial proves winnable with the
// cart the prose asks for. If the retune ever breaks that machine, the gate
// fails before this canvas can disappoint anybody.
function tryItStep() {
 const w = 520, h = 260;
 const level = CART_LEVEL;
 const frame = demoFrame(level, w, h);
 const cv = el('canvas', { class: 'demo-canvas try-canvas', width: w * 2, height: h * 2 });
 const ctx = cv.getContext('2d');
 const R = 15; // the standard wheel (§4's ladder)
 const SNAP_R = 14; // world px — a touch looser than the editor's, fingers welcome
 const MIN_STICK = 20; // shorter is a click that wobbled, not a stick

 const parts = [];
 let tool = 'wheel-cw'; // the R wheel — the one the prose asks for
 let ghost = null; // the stick being dragged out
 let sim = null, simTime = 0, raf = 0, dead = false, idN = 0;

 const zone = level.buildZones[0];
 const clampZone = (x, y, pad) => ({
 x: Math.min(Math.max(x, zone.x - zone.w / 2 + pad), zone.x + zone.w / 2 - pad),
 y: Math.min(Math.max(y, zone.y - zone.h / 2 + pad), zone.y + zone.h / 2 - pad),
 });
 const pins = () => parts.flatMap((p) => p.t === 'wheel'
 ? [{ x: p.x, y: p.y }]
 : [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }]);
 // Snap to an existing pin, or clamp into the zone. Snapping returns the
 // pin's own floats — equality is what makes the joint (§6, jointKey).
 const snapOrClamp = (x, y, pad) => {
 let best = null, bd = SNAP_R;
 for (const pt of pins()) {
 const d = Math.hypot(pt.x - x, pt.y - y);
 if (d < bd) { bd = d; best = pt; }
 }
 return best ? { x: best.x, y: best.y } : clampZone(x, y, pad);
 };
 const toWorld = (e) => {
 const r = cv.getBoundingClientRect();
 // CSS scales the canvas, so client px → device px first (the ×2 backing
 // store), then through the same frame the drawing uses
 const dx = (e.clientX - r.left) * (w * 2) / r.width;
 const dy = (e.clientY - r.top) * (h * 2) / r.height;
 return { x: (dx - w) / frame.zoom + frame.cx, y: (dy - h) / frame.zoom + frame.cy };
 };

 const draw = () => {
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 drawBackdrop(ctx, w * 2, h * 2, 'dusk', simTime);
 ctx.setTransform(frame.zoom, 0, 0, frame.zoom, w - frame.cx * frame.zoom, h - frame.cy * frame.zoom);
 if (sim) {
 const view = sim.view();
 drawZones(ctx, level, { goalRects: view.goalZones });
 drawTerrainAll(ctx, level, view.terrain, simTime);
 // the game's Z order, as in the demo above
 for (const it of wheelCargoBackToFront(view.wheels, view.goals, (w) => w.part.r, (g) => goalStackR(g.def))) {
 if (it.kind === 'wheel') drawWheel(ctx, it.ref.part, it.ref, {});
 else drawGoalPiece(ctx, it.ref.def, it.ref);
 }
 drawRods(ctx, liveRods(view.rods), {});
 if (sim.won) {
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.font = '700 40px system-ui';
 ctx.textAlign = 'center';
 ctx.fillStyle = 'rgba(212,160,23,0.92)';
 ctx.fillText(t('★ Solved!'), w, 64);
 }
 return;
 }
 drawSceneAtRest(ctx, level);
 drawRods(ctx, [...parts.filter((p) => p.t === 'rod'), ...(ghost ? [ghost] : [])], {});
 for (const p of parts) if (p.t === 'wheel') drawWheel(ctx, p, { x: p.x, y: p.y }, {});
 for (const pt of pins()) drawPinDot(ctx, pt.x, pt.y);
 };

 const stopSim = () => {
 if (sim) { sim.destroy(); sim = null; }
 cancelAnimationFrame(raf);
 simTime = 0;
 playBtn.textContent = '▶';
 playBtn.classList.remove('playing');
 draw();
 };
 const runSim = () => {
 if (!parts.length) return;
 ghost = null;
 sim = new Simulation(level, { parts });
 playBtn.textContent = '■';
 playBtn.classList.add('playing');
 const frameFn = () => {
 if (dead || !sim) return;
 raf = requestAnimationFrame(frameFn);
 simTime += DEMO_FPS_STEP;
 sim.step(DEMO_FPS_STEP);
 draw();
 // long enough to watch the whole delivery and enjoy the flash; a run
 // nobody stops should hand the canvas back rather than loop forever
 if (simTime >= 12) stopSim();
 };
 raf = requestAnimationFrame(frameFn);
 };

 cv.addEventListener('pointerdown', (e) => {
 e.preventDefault();
 if (sim) { stopSim(); return; } // a press anywhere hands the canvas back, like the editor
 const p = toWorld(e);
 if (tool === 'rod') {
 const a = snapOrClamp(p.x, p.y, 0);
 ghost = { t: 'rod', kind: 'wood', x1: a.x, y1: a.y, x2: a.x, y2: a.y };
 try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic or already lifted */ }
 draw();
 return;
 }
 const kind = tool.slice(6);
 const at = snapOrClamp(p.x, p.y, R);
 parts.push({ t: 'wheel', kind, x: at.x, y: at.y, r: R, id: 'try' + (++idN) });
 draw();
 });
 cv.addEventListener('pointermove', (e) => {
 if (!ghost) return;
 const p = toWorld(e);
 const b = snapOrClamp(p.x, p.y, 0);
 ghost.x2 = b.x; ghost.y2 = b.y;
 draw();
 });
 const finishGhost = () => {
 if (!ghost) return;
 if (Math.hypot(ghost.x2 - ghost.x1, ghost.y2 - ghost.y1) >= MIN_STICK) {
 parts.push({ ...ghost, id: 'try' + (++idN) });
 }
 ghost = null;
 draw();
 };
 cv.addEventListener('pointerup', finishGhost);
 cv.addEventListener('pointercancel', () => { ghost = null; draw(); });

 // the little toolbar — active tool lit, like the real one
 let playBtn;
 const toolBtns = [];
 const toolBtn = (id, label, hint) => {
 const b = el('button', {
 class: 'btn try-tool' + (tool === id ? ' active' : ''), title: hint,
 onclick: () => { tool = id; toolBtns.forEach((tb) => tb.el.classList.toggle('active', tb.id === tool)); },
 }, label);
 toolBtns.push({ id, el: b });
 return b;
 };
 playBtn = el('button', { class: 'btn play-btn', title: 'Run the machine — press again to stop', onclick: () => (sim ? stopSim() : runSim()) }, '▶');
 const bar = el('div', { class: 'try-tools' },
 toolBtn('wheel-cw', 'R wheel', 'Drives right — tap to place'),
 toolBtn('wheel-ccw', 'L wheel', 'Drives left'),
 toolBtn('wheel-free', 'F wheel', 'No motor, just rolls'),
 toolBtn('rod', 'Stick', 'Drag from one end to the other — ends near a hub snap on'),
 playBtn,
 el('button', { class: 'btn', title: 'Take back the last piece', onclick: () => { if (!sim) { parts.pop(); draw(); } } }, '⤺ Undo'),
 el('button', { class: 'btn', title: 'Start over', onclick: () => { if (!sim) { parts.length = 0; draw(); } } }, '✕ Clear'));

 // same lifecycle as liveDemo: the wasm world dies with the canvas
 const mo = new MutationObserver(() => {
 if (!document.contains(cv)) {
 dead = true;
 cancelAnimationFrame(raf);
 if (sim) { sim.destroy(); sim = null; }
 mo.disconnect();
 }
 });
 mo.observe(document.body, { childList: true, subtree: true });

 draw();
 return el('div', { class: 'try-wrap' }, cv, bar);
}

// ---------- the steps' pictures (§18) ----------
//
// One builder per step id in TOUR_PLAN (content.js). The registry owns every
// sentence; this table owns everything that has to WORK — demos, the sandbox,
// mock-ups, buttons. `extra()` is the odd paragraph of working buttons some
// steps end with; it renders after the body and before the fold.
function tourShows() {
 const contrastBox = { x: 0, y: -40, w: 180, h: 130 };
 const laneBox = { x: 0, y: -22, w: 720, h: 118 };
 const doors = () => el('p', { class: 'tour-out' },
 el('a', { class: 'btn primary big', href: '/campaign' }, '▶ Play the Campaign'),
 el('a', { class: 'btn big', href: '/browse' }, 'Community Workshop'),
 el('a', { class: 'btn big', href: '/maker' }, 'Level Maker'),
 el('a', { class: 'btn big ghost', href: '/keys' }, 'All the controls'));
 // The authoring chapter's own exit ramp: it ends somebody at the Maker, not
 // at the Campaign, because the thing they have just read seventeen steps of
 // is a thing you do rather than a thing you watch.
 const makerDoors = () => el('p', { class: 'tour-out' },
 el('a', { class: 'btn primary big', href: '/maker' }, '🛠 Open the Maker'),
 el('a', { class: 'btn big', href: '/browse' }, 'See what others made'),
 el('a', { class: 'btn big', href: '/import' }, 'Import an FC level'),
 el('a', { class: 'btn big ghost', href: '/keys' }, 'All the controls'));
 return {
 'play.pink': { show: () => liveDemo(CART_LEVEL, CART_DESIGN, DEMO_LOOP_S.cart, { w: 520, h: 260 }) },
 'play.built': { show: () => liveDemo(CART_LEVEL, CART_DESIGN, DEMO_LOOP_S.cart, { w: 520, h: 260, build: true }) },
 'play.try': { show: () => tryItStep() },
 'play.join': {
 show: () => el('div', { class: 'tour-pair' },
 tourPanel('ends not quite touching', liveDemo(STAND_LEVEL, STAND_LOOSE, DEMO_LOOP_S.stand,
 { w: 250, h: 210, box: contrastBox, zones: false }), 'bad'),
 tourPanel('ends touching', liveDemo(STAND_LEVEL, STAND_JOINED, DEMO_LOOP_S.stand,
 { w: 250, h: 210, box: contrastBox, zones: false }), 'good')),
 },
 'play.wheels': {
 show: () => el('div', { class: 'tour-trio' },
 tourPanel('L — drives left', liveDemo(LANE_LEVEL, laneCart('ccw'), DEMO_LOOP_S.lane,
 { w: 220, h: 104, box: laneBox, zones: false })),
 tourPanel('F — just rolls', liveDemo(LANE_LEVEL, laneCart('free'), DEMO_LOOP_S.lane,
 { w: 220, h: 104, box: laneBox, zones: false })),
 tourPanel('R — drives right', liveDemo(LANE_LEVEL, laneCart('cw'), DEMO_LOOP_S.lane,
 { w: 220, h: 104, box: laneBox, zones: false }))),
 },
 'play.go': {
 show: () => liveDemo(CART_LEVEL, CART_DESIGN, DEMO_LOOP_S.cart, { w: 460, h: 200 }),
 extra: doors,
 },
 'build.ask': {
 // The buttons ROW is code because each row is a picture of a control; the
 // touch row sits with them because a phone's reader deserves the same
 // glance-answer, not a footnote (§19).
 show: () => el('div', { class: 'tour-buttons' },
 el('div', { class: 'tour-button' }, el('kbd', {}, 'Left'),
 el('span', {}, el('b', {}, 'Do the thing.'), ' Pick a piece up, put a new one down, drag the view around.')),
 el('div', { class: 'tour-button' }, el('kbd', {}, 'Right'),
 el('span', {}, el('b', {}, 'Ask the piece.'), ' Every piece has its own little menu — what it is made of, how heavy, which way it turns.')),
 el('div', { class: 'tour-button' }, el('kbd', {}, 'Middle'),
 el('span', {}, el('b', {}, 'Move the view.'), ' Drag the level around, even while a machine is running.')),
 el('div', { class: 'tour-button' }, el('kbd', {}, 'Touch'),
 el('span', {}, el('b', {}, 'One finger is the left button.'), ' Hold still on a piece for its menu, pinch with two fingers to zoom, double-tap for double-click.'))),
 },
 // the axle-rule pair (2026-08-24): the same wheel twice, and the only
 // difference is one stick on the hub
 'build.solo': {
 show: () => el('div', { class: 'tour-pair' },
 tourPanel('bare hub — it free-rolls', liveDemo(SOLO_LEVEL, SOLO_BARE, DEMO_LOOP_S.solo,
 { w: 250, h: 190, box: { x: 40, y: -10, w: 780, h: 360 }, zones: false })),
 tourPanel('a stick on the hub — a motor', liveDemo(SOLO_LEVEL, SOLO_DESIGN, DEMO_LOOP_S.solo,
 { w: 250, h: 190, box: { x: 40, y: -10, w: 780, h: 360 } }))),
 },
 'build.weight': {
 // the same framings the FC page settled by eye — a demo framed
 // differently from the one it repeats reads as a different game
 show: () => el('div', { class: 'tour-pair' },
 tourPanel('both sticks ×1', liveDemo(BEAM_LEVEL, BEAM_LIGHT, DEMO_LOOP_S.beam,
 { w: 250, h: 190, box: { x: 0, y: -20, w: 300, h: 220 }, zones: false })),
 tourPanel('right stick ×100', liveDemo(BEAM_LEVEL, BEAM_HEAVY, DEMO_LOOP_S.beam,
 { w: 250, h: 190, box: { x: 0, y: -20, w: 300, h: 220 }, zones: false }))),
 },
 'build.gravity': { show: () => liveDemo(CATAPULT_LEVEL, CATAPULT_DESIGN, DEMO_LOOP_S.catapult, { w: 520, h: 260 }) },
 'build.ground': {
 show: () => el('div', { class: 'tour-trio' },
 tourPanel('mud holds it', liveDemo(GRIP_LEVEL(GRIP_SHOWN[0]), { parts: [] }, DEMO_LOOP_S.grip,
 { w: 220, h: 130, box: { x: 100, y: 30, w: 1000, h: 500 }, zones: false })),
 tourPanel('ice lets it go', liveDemo(GRIP_LEVEL(GRIP_SHOWN[1]), { parts: [] }, DEMO_LOOP_S.grip,
 { w: 220, h: 130, box: { x: 100, y: 30, w: 1000, h: 500 }, zones: false })),
 tourPanel('a belt carries', liveDemo(BELT_LEVEL, { parts: [] }, DEMO_LOOP_S.belt,
 { w: 220, h: 130, box: { x: 0, y: 20, w: 700, h: 260 }, zones: false }))),
 },
 'build.ropes': {
 show: () => el('div', { class: 'piece-row tour-pieces' },
 pieceFigure((c) => drawRod(c, { t: 'rod', kind: 'wood', x1: -34, y1: -8, x2: 34, y2: -26 }, {}), 'Wood stick — solid'),
 pieceFigure(ropeFigure('wood'), 'Wood rope — Alt+drag a stick tool'),
 pieceFigure((c) => drawRod(c, { t: 'rod', kind: 'water', x1: -34, y1: -8, x2: 34, y2: -26 }, {}), 'Water stick — your machine passes through'),
 pieceFigure(ropeFigure('water'), 'Wet rope — hangs through your machine')),
 },
 // ---- Level Maker · 1 The bones ----
 'make.three': {
 show: () => stillPicture(SKELETON_LEVEL, { w: 500, h: 230 }),
 extra: () => el('p', {}, el('a', { class: 'btn primary', href: '/maker' }, 'Open the Maker'),
 ' ', el('span', { class: 'muted' }, 'it opens on the Create tab, with a level already started')),
 },
 'make.build': {
 // The one contrast in this chapter, and it earns the form: two pictures
 // that differ in exactly one rectangle say "this is the dial" in a way
 // no sentence about difficulty can.
 show: () => el('div', { class: 'tour-pair' },
 tourPanel('a roomy zone, right by the work', levelPicture(ZONE_ROOMY, { w: 250, h: 170 })),
 tourPanel('the same level, from over there', levelPicture(ZONE_TIGHT, { w: 250, h: 170 }))),
 // The second picture is an EXTRA rather than a second panel above: "up
 // to eight of each" is a different claim from "the zone is the dial",
 // and stacking it into the contrast would have made the contrast a
 // four-way comparison of nothing in particular.
 extra: () => el('div', {},
 el('p', { class: 'muted' },
 'Up to eight of each, too — two build areas and two goal boxes are the cheapest way to make one machine do two clever things:'),
 levelPicture(TWO_ZONE_LEVEL, { w: 500, h: 220 })),
 },
 'make.goal': { show: () => levelPicture(GOALS_LEVEL, { w: 520, h: 230 }) },
 'make.terrain': { show: () => levelPicture(TERRAIN_LEVEL, { w: 520, h: 230 }) },
 'make.props': { show: () => levelPicture(PROPS_LEVEL, { w: 520, h: 230 }) },
 // Framed by hand, like the contrast demos: the box has to reach y −227 or
 // the ball the whole thing starts with is cut in half by the canvas edge
 // on the one frame everybody sees, which is the first one.
 'make.pins': { show: () => liveDemo(PIN_LEVEL, { parts: [] }, DEMO_LOOP_S.pin, { w: 520, h: 250, box: { x: 0, y: -70, w: 640, h: 330 } }) },

 // ---- Level Maker · 2 In the hand ----
 'make.right': { show: () => el('div', { class: 'tour-menu-wrap' }, terrainMenuMock()) },
 'make.sliders': { show: () => sliderMock() },
 'make.select': {
 show: () => gestureRows(
 ['Click', 'One piece.', 'Drag it to move it.'],
 ['Ctrl+Click', 'Add another.', 'Click it again to drop it back out.'],
 ['Ctrl+Drag', 'A marquee.', 'On empty space, sweep a box round everything you want.'],
 ['Ctrl+A', 'The lot.', 'In Create that is the whole level, both kinds of zone included.'],
 ['Double-click', 'Everything joined to it.', 'One pin at a time, all the way out — plus its group mates.']),
 },
 'make.copy': {
 show: () => gestureRows(
 ['Ctrl+C', 'Copy.', 'Whatever is selected, however much of it there is.'],
 ['Ctrl+V', 'Aim, then drop.', 'Hold V, move the cursor, let go where you want it.'],
 ['Ctrl+X', 'Cut.', 'It goes to the clipboard, so cut-then-paste moves things.'],
 ['Ctrl+Shift+V', 'Paste on the grid.', 'Ctrl+Alt+V uses the fine 20 px one.']),
 },
 'make.grid': {
 show: () => el('div', { class: 'tour-pair' },
 tourPanel('placed by eye', levelPicture(GRID_LOOSE, { w: 250, h: 170 }), 'bad'),
 tourPanel('placed on the grid', levelPicture(GRID_SNAPPED, { w: 250, h: 170 }), 'good')),
 },

 // ---- Level Maker · 3 Make it move ----
 'make.parts': { show: () => levelPicture(PARTS_LEVEL, { w: 520, h: 230 }) },
 'make.path': { show: () => liveDemo(MOVER_LEVEL, MOVER_DESIGN, DEMO_LOOP_S.mover, { w: 520, h: 240 }) },
 'make.spin': { show: () => liveDemo(SPIN_LEVEL, { parts: [] }, DEMO_LOOP_S.spin, { w: 520, h: 220, box: { x: 60, y: -30, w: 620, h: 240 } }) },
 'make.groups': { show: () => liveDemo(LIFT_LEVEL, { parts: [] }, DEMO_LOOP_S.lift, { w: 520, h: 260, box: { x: 30, y: -50, w: 520, h: 300 } }) },

 // ---- Level Maker · 4 Publish it ----
 'make.beat': {
 // A mock of the save box, like the challenge mock below it — the flow is
 // the lesson, and a picture of the control teaches it faster than prose.
 show: () => el('div', { class: 'tour-mock' },
 el('div', { class: 'tour-mock-title' }, '💾 Save this machine'),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', disabled: true }), el('span', { class: 'chip-label' }, 'On this device')),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', checked: true, disabled: true }), el('span', { class: 'chip-label' }, 'Private — only you')),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', disabled: true }), el('span', { class: 'chip-label' }, 'Published to the Workshop')),
 el('div', { class: 'chip-note muted' }, 'A saved winning run is a solve — the next chapter builds on it.'),
 el('div', { class: 'tour-mock-actions' }, el('span', { class: 'btn primary' }, 'Save'))),
 },
 'make.publish': {
 show: () => el('div', { class: 'tour-mock' },
 el('div', { class: 'tour-mock-title' }, '📤 Publish this level'),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', disabled: true }), el('span', { class: 'chip-label' }, 'On this device')),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', disabled: true }), el('span', { class: 'chip-label' }, 'Private — only you')),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', disabled: true }), el('span', { class: 'chip-label' }, 'Unlisted — anyone with the link')),
 el('div', { class: 'chip-row' }, el('input', { type: 'radio', checked: true, disabled: true }), el('span', { class: 'chip-label' }, 'The Workshop — everybody')),
 el('div', { class: 'chip-row' },
 el('span', { class: 'chip-label' }, 'Description'),
 el('input', { class: 'input', value: 'Two crates, one lift, no wheels needed.', disabled: true })),
 el('div', { class: 'chip-note muted' }, 'Shown on the card, so no spoilers. The hint below it is hidden until somebody asks.'),
 el('div', { class: 'tour-mock-actions' }, el('span', { class: 'btn primary' }, 'Publish'))),
 extra: makerDoors,
 },
 'win.badges': {
 show: () => el('div', { class: 'badge-grid tour-badges' },
 ...BADGE_DEFS.slice(0, 6).map((bd) => el('div', { class: 'badge-card' },
 // the real badge, not a bare glyph: a negative badge is the thing in
 // a red prohibition ring, and drawn without it "⚡" sat next to the
 // words "No Power" saying the opposite (§11.4)
 badgeEl(bd.id),
 el('span', {}, el('b', {}, bd.name), el('br'), el('span', { class: 'muted' }, bd.desc))))),
 },
 'win.dare': {
 show: () => el('div', { class: 'tour-mock' },
 el('div', { class: 'tour-mock-title' }, '⚔ Match me? Beat me?'),
 el('div', { class: 'chip-row' },
 el('input', { type: 'checkbox', checked: true, disabled: true }),
 el('span', { class: 'chip-label' }, 'Time'),
 el('input', { class: 'input', value: '4.62', disabled: true })),
 el('div', { class: 'chip-row' },
 el('input', { type: 'checkbox', disabled: true }),
 el('span', { class: 'chip-label' }, 'Pieces'),
 el('input', { class: 'input', value: '6', disabled: true })),
 el('div', { class: 'chip-note muted' }, 'Runs for 30 days.'),
 el('div', { class: 'tour-mock-actions' },
 el('span', { class: 'btn primary' }, 'Post the challenge'))),
 },
 'win.out': {
 show: () => liveDemo(CART_LEVEL, CART_DESIGN, DEMO_LOOP_S.cart, { w: 460, h: 200 }),
 extra: doors,
 },

 // ---- Advanced · GhostRun and tweaking ----
 //
 // No live physics here: the claim is about an editor mode, not a machine
 // that has to win. Gesture rows, same shape as the Maker's "in the hand"
 // chapter — press this, get that.
 'adv.mode': {
 show: () => gestureRows(
 [gMouse('right'), 'The toolbar grip.', 'Right-click the handle you drag the bar with — the same menu that folds it.'],
 ['⚙', 'Advanced mode.', 'The bar appears; the info chip starts reading the pointer.'],
 ['⌨', 'The key/mouse chip.', 'Live Left / Middle / Right, scroll, and arrows for the tool and modifiers you are holding. Scroll over a selected stick varies its weight.'],
 ['Shift+A', 'Cycle the bar.', 'Handle only, then tools, then tools and counts.']),
 },
 'adv.bar': {
 show: () => gestureRows(
 ['#', 'The 40 px grid.', 'The same three states S cycles on the Advanced bar.'],
 [gIcon(freeWorldIconSVG(26)), 'Build anywhere.', 'A piece left outside the violet box scores nothing.'],
 [gIcon(ghostIconSVG(26)), 'A second of the future.', 'Freeze it and keep editing. The next chapter.'],
 [gIcon('<svg width="28" height="16" viewBox="0 0 28 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><line x1="2" y1="8" x2="26" y2="8" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="8" r="4.2" fill="currentColor"/></svg>'),
 'Playback, not physics.', 'How fast Play plays. The sim is a fixed step either way.']),
 },
 'adv.ghost': {
 show: () => gestureRows(
 [gIcon(ghostIconSVG(26)), 'Switch it on.', 'No run needed. The chip carries the dial, 0.1 s to 100 s.'],
 [gIcon('<svg width="28" height="16" viewBox="0 0 28 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><line x1="2" y1="8" x2="26" y2="8" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="8" r="4.2" fill="currentColor"/></svg>'),
 'Pick the second.', 'Every edit re-runs the machine to it, so the ghost follows what you build.'],
 [gIcon('<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 12 Q12 5.2 20.5 12 Q12 18.8 3.5 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M6 19 L18 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'),
 'Overlay away.', 'The hollow machine covers the build; roads and the sweep stay.']),
 },
 'adv.road': {
 show: () => gestureRows(
 [gMouse('right'), 'Lay a road.', 'Right-click empty ground. Corners in order, ending at the goal — for cargo that has to go the wrong way first.'],
 [gMouse('left'), 'Move or remove.', 'Drag a corner; right-click one to drop it. Several roads are allowed; the best of them counts.'],
 [gIcon(toolIconSVG('goal-ball', 26)), 'Pair cargo → zone.', 'Right-click a goal piece or zone. The chip writes 1→2. Any goal is the default.']),
 },
 'adv.tweak': {
 show: () => gestureRows(
 [gIcon(toolIconSVG('pin', 26)), 'Sweep a pin.', 'Right-click one of yours — the cargo\'s too. 225 positions, three rungs: 1 px, 0.1 px, 0.01 px.'],
 [gIcon(toolIconSVG('rod-wood', 26)), 'Sweep a weight.', 'Right-click a stick. All hundred whole weights, ×1 to ×100. A rope sweeps every link together.'],
 [gMouse('left'), 'Adopt a cell.', 'Green beats what you have, gold delivers, grey the editor refuses. Nothing applies itself.'],
 ['Esc', 'Stop the sweep.', 'What it measured stays on the chip and is still clickable.']),
 extra: () => el('p', { class: 'tour-out' },
 el('a', { class: 'btn primary big', href: '/keys' }, 'All the controls'),
 el('a', { class: 'btn big', href: '/maker' }, 'Level Maker'),
 el('a', { class: 'btn big', href: '/campaign' }, 'Campaign')),
 },
 };
}

// The four-part switcher at the top of the help page (§18). Real links, not
// buttons: each part is a URL somebody can be sent, which is the whole reason
// the FC page can stop being a nav tab without becoming unreachable.
function partTabs(active) {
 return el('nav', { class: 'tour-parts' },
 ...TOUR_PARTS.map((pt) => el('a', {
 class: 'tour-part' + (pt.id === active ? ' on' : ''),
 href: pt.href,
 title: t(pt.tagline),
 }, el('b', {}, t(pt.name)), el('span', { class: 'muted' }, t(pt.tagline)))));
}

// `/learn`, `/learn/maker`, `/learn/advanced`, `/learn/fc` — and `/fc`, which
// routes here too. An unrecognised second segment is the Beginner part rather
// than a 404: this is the help page, and the least helpful thing it could do
// is refuse.
function learnScreen(partId) {
 const part = TOUR_PARTS.find((p) => p.id === partId) || TOUR_PARTS[0];
 if (part.id === 'fc') return fcPart();
 return tourPart(part);
}

function tourPart(part) {
 const titles = {
 maker: 'Making levels — LIFIRIK',
 advanced: 'Advanced use — LIFIRIK',
 };
 document.title = t(titles[part.id] || 'How to play — LIFIRIK');
 const shows = tourShows();
 // The flat list, with each step remembering its chapter — Next simply walks
 // it, so a chapter boundary is a border you cross without noticing you
 // crossed it, which is the layering doing its job. Scoped to THIS part: Next
 // must not walk off the end of the beginner's tour into the authoring guide,
 // which is a different page for a different person.
 const chaptersOf = TOUR_PLAN.filter((ch) => ch.part === part.id);
 const steps = chaptersOf.flatMap((ch, ci) => ch.steps.map((id) => ({ id, ch, ci })));
 // Where you were last time, remembered PER PART — a reader halfway through
 // the authoring guide and a reader halfway through the tutorial are two
 // different bookmarks, and one key for both would keep throwing each of them
 // into the other's page.
 const key = TOUR_KEY + '.' + part.id;
 let i = Math.min(Math.max(store.get(key, 0) | 0, 0), steps.length - 1);

 const chapters = el('div', { class: 'tour-chapters' });
 const stage = el('div', { class: 'tour-stage' });
 const rail = el('div', { class: 'tour-rail' });
 const back = el('button', { class: 'btn' }, '← Back');
 const next = el('button', { class: 'btn primary' }, 'Next →');
 const count = el('p', { class: 'tour-count muted' });

 const go = (n) => {
 i = Math.max(0, Math.min(steps.length - 1, n));
 store.set(key, i);
 const s = steps[i];
 const body = [
 el('h1', { class: 'tour-title' }, txt(`tour.${s.id}.title`)),
 el('div', { class: 'tour-show' }, (shows[s.id]?.show || (() => el('div')))()),
 el('div', { class: 'tour-say' },
 ...rich(`tour.${s.id}.body`),
 shows[s.id]?.extra ? shows[s.id].extra() : null),
 ];
 // The fold: the deeper layer for whoever wants it, folded so it costs
 // nothing to walk past. `txt()` is '' for a step without one, and an
 // admin can blank a fold away the same way.
 const more = txt(`tour.${s.id}.more`);
 if (more.trim()) {
 body.push(el('details', { class: 'tour-more' },
 el('summary', {}, 'More, if you want it'),
 el('div', { class: 'tour-more-body' }, ...rich(`tour.${s.id}.more`))));
 }
 stage.replaceChildren(...body);
 count.textContent = t(s.ch.name) + ' · ' + tf('{i} of {n}', { i: s.ch.steps.indexOf(s.id) + 1, n: s.ch.steps.length });
 back.disabled = i === 0;
 next.textContent = t(i === steps.length - 1 ? 'Start again' : 'Next →');
 // chapter tabs: where you are, and that the rest EXISTS without demanding
 // anything — the tagline under each name is its whole sales pitch
 chapters.replaceChildren(...chaptersOf.map((ch, ci) => el('button', {
 class: 'tour-chapter' + (ci === s.ci ? ' on' : '') + (ci < s.ci ? ' done' : ''),
 title: t(ch.tagline),
 onclick: () => go(steps.findIndex((st) => st.ci === ci)),
 }, el('b', {}, `${ci + 1} · ${t(ch.name)}`), el('span', { class: 'muted' }, t(ch.tagline)))));
 // dots for THIS chapter only — nineteen dots was a wall, six is a pocket
 rail.replaceChildren(...s.ch.steps.map((id, k) => el('button', {
 class: 'tour-dot' + (id === s.id ? ' on' : '') + (steps.findIndex((st) => st.id === id) < i ? ' done' : ''),
 title: txt(`tour.${id}.title`),
 onclick: () => go(steps.findIndex((st) => st.id === id)),
 })));
 stage.scrollIntoView({ block: 'nearest' });
 };

 back.onclick = () => go(i - 1);
 next.onclick = () => go(i === steps.length - 1 ? 0 : i + 1);

 // Arrow keys, because a sequence that can only be driven by aiming at a
 // button is a sequence you stop driving.
 const onKey = (e) => {
 // `e.target` is not always an element — a synthetic event dispatched on
 // `window` has no `matches`, and an exception here would take the arrow
 // keys out entirely without ever showing up in normal use (a real keypress
 // with nothing focused targets `body`, which does have it).
 const t = e.target;
 if (t && typeof t.matches === 'function' && t.matches('input, textarea, select')) return;
 if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
 if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
 };
 window.addEventListener('keydown', onKey);
 const mo = new MutationObserver(() => {
 if (!document.contains(stage)) { window.removeEventListener('keydown', onKey); mo.disconnect(); }
 });
 mo.observe(document.body, { childList: true, subtree: true });

 mainEl.append(el('section', { class: 'panel tour' },
 partTabs(part.id),
 el('div', { class: 'tour-head' },
 count,
 el('a', { class: 'tour-skip muted', href: '/keys' }, 'Skip to the controls')),
 chapters,
 rail,
 stage,
 el('div', { class: 'tour-nav' }, back, next)));
 go(i);
}
// ---------- FC retraining (§18) ----------
//
// **For people arriving from Fantastic Contraption**, who already know how to
// build and do not need the tutorial — they need the DIFFERENCES, and they need
// them without being told they are beginners. Hence the tone: everything you
// know still works, here is what got easier.
//
// The same rule the tutorial runs on: **show, then say.** Every claim about
// this engine on this page is a real `Simulation` from `tutorial-demos.js`,
// gated in `verify-tutorial.mjs` (gate 7). If a retune ever made one of these
// differences untrue, a gate fails rather than the page quietly lying to the
// audience least able to tell.
//
// **What is NOT asserted here is anything about FC itself.** The differences
// were named by somebody who knows that game; this page only ever says what
// happens HERE, so nothing on it can rot into a wrong claim about a game this
// codebase has no copy of.
//
// **A part of the help page rather than a nav tab of its own** (2026-08-10).
// It kept every word; what changed is where its door is. It stays a WRITTEN
// page — headings and paragraphs to scan — rather than being cut into tour
// steps, because its reader already knows how to build and wants to find one
// difference, not walk through fifteen.

function fcPart() {
 document.title = t('Coming from FC — LIFIRIK');
 const p = (...kids) => el('p', {}, ...kids);
 const muted = (...kids) => el('p', { class: 'muted' }, ...kids);
 const b = (t) => el('b', {}, t);

 // One difference: a heading, the thing running, and the words underneath.
 const diff = (title, show, ...say) => el('section', { class: 'fc-diff' },
 el('h2', {}, title),
 show ? el('div', { class: 'fc-show' }, show) : null,
 el('div', { class: 'fc-say' }, ...say));

 // No `good`/`bad` tone on these pairs, deliberately. The tutorial's contrast
 // has a right answer and a wrong one; these do not — a x1 stick is not a
 // mistake and mud is not a worse floor than ice. Colouring them would teach
 // a judgement nobody made.
 const pair = (aLabel, aNode, bLabel, bNode) => el('div', { class: 'tour-pair' },
 tourPanel(aLabel, aNode), tourPanel(bLabel, bNode));

 const keyRow = (k, what) => el('tr', {},
 el('td', {}, el('span', { class: 'keycol' }, ...k.split(' ').map((x) => el('kbd', {}, x)))),
 el('td', {}, what));

 mainEl.append(el('section', { class: 'panel settings fc' },
 partTabs('fc'),
 el('h1', {}, 'Coming from Fantastic Contraption'),
 p('You already know how to build. This page is only the ', b('differences'),
 ' — the things that would otherwise cost you an hour of wondering why the old trick is not working, or, worse, would never come up at all because you would never think to try.'),
 muted('Everything on this page is really running. Same physics, same rules, same renderer as the game.'),

 el('h2', { class: 'fc-part' }, 'Building'),
 p('The canvas uses the same mouse chords as Flash FC: ', b('Ctrl+click deletes'),
 ', ', b('Shift-drag a rod or wheel moves the whole machine'),
 ', ', b('Shift-drag a joint moves only that pin'),
 ', and ', b('Shift-drag empty pans'),
 '. Left-drag empty still pans too. Snap is the S button; Alt is the finer grid.'),

 diff('Weight is a dial, not a pile.',
 pair('the same stick at ×1', liveDemo(BEAM_LEVEL, BEAM_LIGHT, DEMO_LOOP_S.beam,
 { w: 250, h: 220, box: { x: 0, y: -20, w: 300, h: 220 }, zones: false }),
 'the same stick at ×100', liveDemo(BEAM_LEVEL, BEAM_HEAVY, DEMO_LOOP_S.beam,
 { w: 250, h: 220, box: { x: 0, y: -20, w: 300, h: 220 }, zones: false })),
 p('Identical beams. Identical sticks on both ends. The only difference is that the right-hand stick on the right-hand beam has been turned up.'),
 p('Select a stick and ', b('scroll'), ' it: ', el('span', { class: 'keycol' }, el('kbd', {}, 'scroll')),
 ' is ±1, ', el('span', { class: 'keycol' }, el('kbd', {}, 'Shift'), el('kbd', {}, 'scroll')), ' is ±10, and ',
 el('span', { class: 'keycol' }, el('kbd', {}, 'Alt'), el('kbd', {}, 'scroll')), ' is ±100. The range is 1 to 100, and the whole of it stays firmly on top of what it rests on. ',
 'Or ', b('right-click the stick'), ' and drag the Weight slider, which is the same dial with the numbers on it.'),
 muted('Weight adds up at the pin: bolt two heavy sticks to one point and that joint is carrying both. A pin asked to hold more than ×200 costs you one of the tidiness badges.')),

 diff('Alt+drag draws a rope, and a rope is one piece.',
 el('div', { class: 'fc-static' }, ropeStrip()),
 p('Hold ', el('kbd', {}, 'Alt'), ' with either stick tool and drag. You get a run of short hinged links that drapes and swings — and the piece counter charges you ', b('one'), ' for the whole thing, however long it is.'),
 p('Two ropes tied end to end are one rope. A rope with another tied into its middle is two. It counts the way you would count real rope.'),
 p('It ', b('weighs'), ' the way you would weigh real rope, too: the weight dial sets a whole length at once, as far as the next junction — tie anything on and that is where the next length starts. A rope that has to CARRY wants weight, and it is a strong lever: ×50 stretches a quarter as far as ×1 under the same load.'),
 muted('A wood rope is solid. A wet rope hangs straight through your own machine and the goal pieces, catching only on terrain and props — so you can run one right through the middle of what you have built.')),

 diff('Ropes, sticks and wheels are all still just pins.',
 null,
 p('Nothing about joining changed: ends that meet share a pin, and a shared pin is a free hinge. What is new is that there is more of everything to pin to — three wheel sizes, and a large wheel pushes like eight standard ones.'),
 muted('And the piece cap is 1000, so the machine is rarely the thing that runs out.')),

 el('h2', { class: 'fc-part' }, 'The world'),

 diff('The ground is a material.',
 pair('mud — holds it', liveDemo(GRIP_LEVEL(GRIP_SHOWN[0]), { parts: [] }, DEMO_LOOP_S.grip,
 { w: 250, h: 190, box: { x: 100, y: 30, w: 1000, h: 500 }, zones: false }),
 'ice — lets it go', liveDemo(GRIP_LEVEL(GRIP_SHOWN[1]), { parts: [] }, DEMO_LOOP_S.grip,
 { w: 250, h: 190, box: { x: 100, y: 30, w: 1000, h: 500 }, zones: false })),
 p('The same crate on the same tilted floor — one is mud and one is ice. The mud holds it exactly where it was put, all day; the ice lets it slide clean off the level.'),
 p('Every terrain piece carries its dials on its right-click menu: ', b('Grip'), ', ', b('Bounce'), ' and ', b('Belt'),
 ' do the work. Sixteen textures set sensible defaults — ice is slippery, rubber bounces, belts carry — and you can override any of them per piece.'),
 muted('So "the floor" is a thing you design, not a constant you work around.')),

 diff('A conveyor carries whatever touches it.',
 liveDemo(BELT_LEVEL, { parts: [] }, DEMO_LOOP_S.belt, { w: 520, h: 190, box: { x: 0, y: 20, w: 700, h: 260 } }),
 p('There is ', b('no machine in that level'), '. Not one piece. The crate is simply sitting on a belt, and the belt is taking it somewhere.'),
 muted('That is the Belt dial — a surface speed, positive or negative, on any terrain piece you like.')),

 diff('The goal itself can move.',
 liveDemo(MOVER_LEVEL, MOVER_DESIGN, DEMO_LOOP_S.mover, { w: 520, h: 230 }),
 p('Terrain moves along authored paths, in groups, spinning or not — and zones are riders on the same machinery, so the ', b('goal zone'), ' can be on a path too. Watch the green box.'),
 muted('Which means "deliver it there" can be a moving target, and levels can have timing in them.')),

 diff('More than one build zone. More than one goal zone.',
 el('div', { class: 'fc-static' }, stillPicture(TWO_ZONE_LEVEL, { w: 520, h: 240 })),
 p('Up to eight of each. A level can ask you to build in two separate places, or deliver two different things to two different destinations.'),
 muted('Zones that touch count as one region, so two overlapping build zones are simply a bigger, oddly-shaped build zone.')),

 el('h2', { class: 'fc-part' }, 'Winning'),

 diff('Winning is a moment. Holding it is a badge.',
 null,
 p('The win fires the instant every goal piece is inside its zone — a crate shoved clean through and out the far side still wins, exactly as you would expect.'),
 p('What is new is that the game keeps watching for up to a minute afterwards. Every piece inside and ', b('at rest'), ', or inside for ten unbroken seconds, earns ',
 b('Nailed It'), '. Send your machine back to fetch every goal piece home to the build zone afterwards and that is ', b('Boomerang'), '.'),
 muted('Badges are worked out from what your machine actually was and did — never granted, never stored. Build with no wheels at all, or nothing but water, and people will notice.')),

 diff('Your run is a thing you keep.',
 null,
 p('Solves are recorded and replayable, and the physics is deterministic, so a saved run plays back exactly. You can put a private winning run up as a ',
 b('challenge'), ' — beat this time, or this piece count, or this weight — and nobody sees your machine until it ends.'),
 muted('The Workshop, the campaign, ratings and comments are all here too. See ', el('a', { href: '/learn' }, 'How to play'), ' for the tour of that side.')),

 el('h2', { class: 'fc-part' }, 'Hands — what your fingers need to relearn'),
 el('table', { class: 'keys-table' }, el('tbody', {},
 keyRow('Space', 'Play, and press it again to stop. Works while you are building'),
 keyRow('Ctrl Z', 'Undo — properly, all the way back. Ctrl+Y or Ctrl+Shift+Z redoes'),
 keyRow('Right-click', 'Every piece has its own menu: what it is made of, how it turns, what colour. If you are ever stuck, right-click the thing'),
 keyRow('Middle-drag', 'Put a piece where the rules say it cannot go — through terrain, inside another piece. On empty space it pans'),
 keyRow('Scroll', 'Zoom. Over a SELECTED piece it resizes instead — a stick’s weight, a wheel’s size (it steps through the three), a label’s size'),
 keyRow('Ctrl Click', 'Delete — same as Flash. Cmd+click on a Mac'),
 keyRow('Shift Drag', 'Move just that piece — connected links stretch to stay on. On a joint: that pin only. On empty space: pan'),
 keyRow('S', 'Cycles the snap button: ON (everything snaps) → REVERSED (free; Alt for the fine grid) → OFF. Shift is move/pan, not snap. It starts OFF for players'),
 keyRow('Ctrl C', 'Copy, paste, cut, select-all — marquee is Ctrl+Shift-drag empty, whole machine is a plain drag (click selects one piece)'),
 keyRow('Z', 'Zoom to fit the zones. Shift+Z fits the whole level'),
 keyRow('Alt Drag', 'On a stick tool: draw a rope. On a placement: the small piece. On the grid: the fine 20 px one'))),
 muted('The full list — every key, every click — is on ', el('a', { href: '/keys' }, 'Controls'), '.'),

 el('h2', { class: 'fc-part' }, 'If you used to make levels'),
 muted('The differences only, as everywhere else on this page. The full walk-through — zones, terrain, props, pins, motion, groups — is the ',
 el('a', { href: '/learn/maker' }, 'Level Maker guide'), '.'),

 diff('The grid, and when to want it.',
 null,
 p('The snap button has three states and starts ', b('OFF'), ' for players. As an author you probably want ',
 b('ON'), ': everything lands on a 40 px grid — exactly one standard wheel across, so two pieces on neighbouring nodes ', b('touch'), ' with no gap and no overlap. ',
 el('kbd', {}, 'Shift'), ' is reserved for moving and panning, like Flash.'),
 p(el('kbd', {}, 'Alt'), ' gives the 20 px half-grid. Press ', el('kbd', {}, 'S'),
 ' for REVERSED (free placement, Alt still fine-snaps) or OFF (never).'),
 muted('The grid draws itself whenever it is in force, so you can always see what you are landing on.')),

 diff('There is text.',
 null,
 p('Press ', el('kbd', {}, 'T'), ' and type. Signs, titles, arrows saying "this way", a joke on a distant wall. Seventeen fonts, any colour, three depths — behind the terrain, over it, or in front of everything.'),
 muted('Labels can be grouped and given motion paths like anything else, so a sign can ride the platform it is naming.')),

 diff('Things move, in complicated ways.',
 null,
 p('Any terrain piece can take a path of Bézier waypoints — travel, spin, ping-pong or loop, with speeds and stops. Group pieces together and the group gets its own motion ',
 el('i', {}, 'on top'), ' of each member’s, so a spinning cog can orbit a moving platform.'),
 muted('Zones and labels ride groups the same way. This is where the interesting levels are.')),

 diff('There is a whole background layer.',
 null,
 p('Press ', el('kbd', {}, 'B'), ' and you step into a second scene that plays behind yours — its own terrain, its own props, its own machine, running its own simulation. Distant hills, a factory grinding away on the horizon, weather.'),
 p(b('None of it can be touched, and none of it affects a solve.'), ' It is atmosphere, and it costs the player nothing.'),
 muted('Half the caps of the real level, and it can never have a background of its own.')),

 diff('And a few things that will change how you think about a level.',
 null,
 el('ul', { class: 'learn-steps' },
 el('li', {}, b('Props'), ' — scenery with physics that is not part of anyone’s machine, and can be pinned to the world as a hinge.'),
 el('li', {}, b('Density'), ' on props and goal pieces, not just sticks. The colour is the clue: darker is heavier, on every family.'),
 el('li', {}, b('Painted terrain'), ' — draw a freehand outline and it becomes solid ground.'),
 el('li', {}, b('Mini planets'), ' — a boulder can be a gravity well, and then the level has no "down".'),
 el('li', {}, b('Challenges'), ' on your published level: a sealed timed debut, or a bar for people to beat.')),
 muted('Then solve your own level before you publish it. If you cannot, nobody can — and you would rather learn that now than from the comments.')),

 el('p', { class: 'tour-out' },
 el('a', { class: 'btn primary big', href: '/maker' }, 'Open the Maker'),
 el('a', { class: 'btn big', href: '/campaign' }, 'Play the Campaign'),
 el('a', { class: 'btn big', href: '/import' }, 'Import an FC level'),
 el('a', { class: 'btn big ghost', href: '/keys' }, 'All controls')),
 muted('Got old FC level text? ', el('a', { href: '/import' }, 'Paste it in'), ' — the importer converts it, machine and all.')));
}

// A wood rope and a wet rope, drawn by the game's own rope pass, with the piece
// count under each — the whole "one piece" claim in one picture.
function ropeStrip() {
 const cv = el('canvas', { class: 'demo-canvas', width: 1040, height: 300 });
 const ctx = cv.getContext('2d');
 const drape = (kind, chain, x0, x1, y0, sag, n) => {
 const pt = (i) => { const t = i / n; return { x: x0 + (x1 - x0) * t, y: y0 + Math.sin(Math.PI * t) * sag }; };
 return Array.from({ length: n }, (_, i) => {
 const a = pt(i), b = pt(i + 1);
 return { t: 'rod', kind, chain, id: chain + i, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
 });
 };
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.clearRect(0, 0, 1040, 300);
 const panel = (parts, ox, label) => {
 ctx.setTransform(2.3, 0, 0, 2.3, ox, 70);
 drawRods(ctx, parts, {});
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.fillStyle = '#5a6474';
 ctx.font = '600 15px system-ui, sans-serif';
 ctx.textAlign = 'center';
 ctx.fillText(label, ox, 250);
 };
 panel(drape('wood', 'w', -80, 80, 8, 44, 20), 262, 'wood rope — 20 links, 1 piece');
 panel(drape('water', 'v', -80, 80, 8, 44, 20), 778, 'wet rope — 20 links, 1 piece');
 return cv;
}

// ---------- controls reference (§18) ----------
//
// The deliberately linear page: every shortcut and click variation in one
// place. Two design rules keep it honest:
// - the tool rows are generated FROM MACHINE_TOOLS/LEVEL_TOOLS — the same
// objects the toolbar tooltips read — so they cannot drift from the game;
// - the keyboard rows are hand-written but the bindings they document are
// driven through _keyDown by verify-editor gates, so a renamed shortcut
// fails a gate rather than silently outdating this page.
function keysScreen() {
 document.title = t('Controls — LIFIRIK');
 const kbd = (txt) => el('kbd', {}, txt);
 // '+' joins keys pressed together; '/' and '…' pass through as separators
 // ("L / F / R" is three alternatives, not a chord)
 const keys = (spec) => {
 const out = [];
 let prevKey = false;
 for (const tok of spec.split(' ')) {
 if (tok === '/' || tok === '…') { out.push(el('span', { class: 'muted' }, ` ${tok} `)); prevKey = false; continue; }
 if (prevKey) out.push(el('span', { class: 'muted' }, '+'));
 out.push(kbd(tok));
 prevKey = true;
 }
 return el('span', { class: 'keycol' }, ...out);
 };
 const row = (k, what) => el('tr', {}, el('td', {}, typeof k === 'string' ? keys(k) : k), el('td', {}, what));
 const table = (title, rows, note) => el('div', { class: 'keys-block' },
 el('h2', {}, title),
 note ? el('p', { class: 'muted' }, note) : null,
 el('table', { class: 'keys-table' }, el('tbody', {}, ...rows)));

 // The three modifier stories — learn these and most rows below follow.
 // They lead the page because the alternative is memorising forty rows: almost
 // every binding here is one of these three ideas applied to whatever is under
 // the cursor, and someone who has read them can predict the rest.
 const stories = el('div', { class: 'key-stories' },
 el('div', { class: 'key-story' }, el('h3', {}, '⌃ Ctrl — delete & commands'),
 el('p', {}, 'On the canvas, Ctrl+click (Cmd+click on a Mac) deletes the piece under the cursor — the Fantastic Contraption chord. Ctrl+Shift+click adds to a selection; Ctrl+Shift-drag empty is a marquee. Everywhere else: undo, redo, copy, paste, cut, select all, save.')),
 el('div', { class: 'key-story' }, el('h3', {}, '⎇ Alt — the finer version'),
 el('p', {}, 'A small piece instead of standard, a rope instead of one stick, a waypoint inserted on a path, 10° rotate steps instead of free, the 20 px grid instead of the 40 px one.')),
 el('div', { class: 'key-story' }, el('h3', {}, '⇧ Shift — one piece, or pan'),
 el('p', {}, 'A plain drag moves the whole connected machine. Shift+drag moves just that piece — links stretch and shrink to stay connected. Shift+drag a joint moves only that pin. Shift+drag empty space pans. With Alt, the large piece. 45° rotate steps, arrows stride the grid, fit everything, send all the way to the back.')));

 const toolRows = (tools) => tools.map(t => row(
 el('span', { class: 'keycol' },
 kbd(toolBadge(t)),
 toolOther(t) ? el('span', { class: 'muted' }, ' or ') : null,
 toolOther(t) ? kbd(toolOther(t)) : null),
 el('span', {}, el('b', {}, t.name), ' — ' + t.hint)));

 mainEl.append(el('section', { class: 'panel settings keys' },
 el('h1', {}, 'Controls'),
 el('p', { class: 'muted' },
 'Every key and every mouse gesture, in one boring list. New? The ',
 el('a', { href: '/learn' }, 'tutorial'), ' is friendlier, and there is a ',
 el('a', { href: '/learn/maker' }, 'guide to making levels'), ' and an ',
 el('a', { href: '/learn/advanced' }, 'Advanced'), ' walkthrough of GhostRun and tweaking. Coming from ',
 el('a', { href: '/learn/fc' }, 'Fantastic Contraption'), '? Start there.'),
 stories,

 // ---- the mouse first: it is what you actually hold ----
 table('The mouse', [
 row(el('span', { class: 'keycol' }, kbd('Left')), 'Select a piece · drag it to move the whole connected machine · on empty space, drag to pan the view'),
 row(el('span', { class: 'keycol' }, kbd('Shift'), el('span', { class: 'muted' }, '+'), kbd('Left')), 'On a piece: move only that piece — connected links stretch to stay on. On a joint: move only that pin. On empty space: pan'),
 row(el('span', { class: 'keycol' }, kbd('Ctrl'), el('span', { class: 'muted' }, '+'), kbd('Left')), 'Delete whatever is under the cursor (Cmd+click on a Mac). Ctrl+Alt+click takes a single rope link. Ctrl+Shift+click adds to a selection; Ctrl+Shift-drag empty is a marquee'),
 row(el('span', { class: 'keycol' }, kbd('Left'), el('span', { class: 'muted' }, ' with a tool')), 'Place that piece. Click for the standard size, or DRAW it: press one corner and drag to the opposite one, the way you draw a stick. A boulder spans the drag — it starts where you press and ends under the cursor'),
 row(el('span', { class: 'keycol' }, kbd('Middle')), el('span', {},
 el('b', {}, 'Put it where it should not go'), ' — drag a piece straight through terrain, into another piece, anywhere the ordinary rules refuse (Create tab). On empty space it pans, and it keeps panning while a machine runs')),
 row(el('span', { class: 'keycol' }, kbd('Right')), 'The piece\'s own menu — texture and surface, Planet on a boulder, wheel kind and size, a stick\'s weight, paths, layer, font and colour on a label. On a ROPE the Weight slider sets the whole length to the next junction; Alt+Right-click to set one link instead. In the Maker, while a machine is running, it stops it instead'),
 row(el('span', { class: 'keycol' }, kbd('Ctrl'), el('span', { class: 'muted' }, '+'), kbd('Right')),
 'The same menu as a plain Right-click — Mini Toolbar on empty ground, the piece or pin menu on a target. Delete is Ctrl+Left'),
 row(el('span', { class: 'keycol' }, kbd('Double-click')), 'Select the whole connected machine · on a label, edit its words · on a rotate knob, back to 0°'),
 row(el('span', { class: 'keycol' }, kbd('Scroll')), 'Zoom. Over a SELECTED piece it resizes instead: a stick\'s weight, a label\'s size, anything else bigger or smaller'),
 ], 'The left button does the work, the middle button breaks the rules, the right button explains itself.'),

 // ---- touch: the same editor, one finger at a time (§19) ----
 table('A touch screen', [
 row(el('span', { class: 'keycol' }, kbd('One finger')), 'Everything the left button does — tap to select, drag to move or place, drag empty space to pan'),
 row(el('span', { class: 'keycol' }, kbd('Two fingers')), 'Pinch to zoom, and the view follows the fingers. Landing a second finger cancels whatever the first had started — it means "I wanted the camera", never half a drag'),
 row(el('span', { class: 'keycol' }, kbd('Hold still')), 'The piece\'s own menu — everything Right-click offers, after half a second of not moving'),
 row(el('span', { class: 'keycol' }, kbd('Double-tap')), 'The double-click: the whole connected machine, a label\'s words, a knob back to 0°'),
 row(el('span', { class: 'keycol' }, kbd('Shift'), el('span', { class: 'muted' }, ' / '), kbd('Ctrl'), el('span', { class: 'muted' }, ' / '), kbd('Alt'), el('span', { class: 'muted' }, ' chips')),
 'The held keys, as latches on the toolbar — tap one on, do the gesture, tap it off. Shift to move the whole machine or pan, Ctrl to delete, Alt to lay rope with a stick tool'),
 ], 'Nothing to install and nothing separate to learn: a finger is the mouse, and the two things a finger hasn\'t got — more buttons, a wheel — are a hold and a pinch.'),

 table('Everywhere', [
 row('Space', 'Play / stop the machine — in Create too. In the Maker, while it runs, anything you press stops it: a key, or a click on a piece. Looking around is free — a plain click on empty canvas pans, as do middle-drag and the scroll wheel, and Z to fit and S for the grid carry on. On a level you are PLAYING nothing interrupts the run but Space and the Stop button: it is your attempt, and a stray click must not cost it'),
 row('Ctrl Z', 'Undo. When the editor has nothing left to undo — a blank new draft, or any other page — it takes you back to the last level you had open this session. Clicking “Maker” gives you an empty draft; Ctrl+Z brings your level back'),
 row('Ctrl Y', 'Redo (Ctrl+Shift+Z works too)'),
 row('Ctrl A', 'Select everything this tab owns — your machine in Test; in Create the whole level, build and goal zones included, so “shift it all 40 px left” is one chord and an arrow key'),
 row('Ctrl C', 'Copy the selection'),
 row('Ctrl V', 'Paste — hold V, aim with the cursor, release to drop'),
 row('Ctrl Shift V', 'Paste aimed on the 40 px grid'),
 row('Ctrl Shift Alt V', 'Paste aimed on the 20 px grid (Ctrl+Alt+V does the same)'),
 row('Ctrl X', 'Cut the piece under the cursor (or the selection) to the clipboard — paste it somewhere else to move it'),
 row('Ctrl S', 'Save — opens the same box the Save button does (and stops the browser offering to save the page)'),
 row('Z', 'Zoom to fit the build and goal zones'),
 row('Shift Z', 'Zoom to fit the whole level'),
 row('Arrows', 'Nudge the selection 0.1 px — Alt for 0.01, Shift+Alt for a whole 1. Shift on its own steps it onto the 40 px grid. After clicking a resize or rotate handle they drive THAT handle instead'),
 row('Arrows', 'While a run is on the scrub line: step a tenth of a second. Shift (or ↑ ↓) steps a whole one, and stepping PAST the end simulates the machine onward so you can look into its future. The line itself appears on the play bar while a run is going and your pointer is near it — it is there whenever there is a run to rewind, and out of the way when there is not'),
 row(el('span', { class: 'keycol' }, kbd('Drag'), el('span', { class: 'muted' }, ' the scrub line')),
 'Keep going past the end and it runs the machine ON. The slider stops at the end and your pointer does not, and how far past you hold it is the speed — a nudge is about real time, a long pull is a dozen seconds of future a second'),
 row('Delete', 'Delete the selection (Backspace works too)'),
 row('Esc', 'Cancel the drag / close the menu / stop painting / dismiss a box'),
 row('Enter', 'Close a painted outline · in a box, press the main button'),
 row('Shift R', 'Reset — the machine in Test, the level in Create. Resetting the level asks first; clearing the machine does not, because Ctrl+Z brings it straight back'),
 // The bars fold to their handle. The gesture (double-tap the grip) is one
 // you have to already know about, aimed at a 24px target that is wherever
 // you last dragged the bar to — so the keys are the discoverable half.
 row('Shift T', 'Fold the piece toolbar down to just its handle, and back. Works while a machine runs — getting a bar off the thing you are watching is exactly when you want it'),
 row('Shift P', 'The same for the play bar at the bottom'),
 ]),

 // ---- GhostRun (§ GhostRun) ----
 // On this page rather than in the tutorial because it is a REFERENCE: the
 // mode announces itself in tooltips and in the menus it opens, and what a
 // list like this is for is the two or three gestures you would otherwise
 // have to be told. It is advanced-mode only, which the note says up front —
 // a row nobody can reach is worse than no row.
 table('GhostRun — editing against the future', [
 // **The button's OWN drawing, not a 👻.** This page can draw — every tool
 // row above it prints the real `toolIconSVG` — and a reference page is
 // exactly where showing the wrong picture costs somebody a hunt round a
 // toolbar for an icon that is not there. (Same lesson the negative badges
 // taught: on a surface that can draw the subject, draw it.)
 row(el('span', { class: 'keycol' }, el('span', { class: 'keycol-icon', html: ghostIconSVG(20) }), el('span', { class: 'muted' }, ' on the Advanced bar')),
 'Switch it on. A chip appears; your machine is drawn faintly over the level as it will be at the aimed second, with the road the cargo takes to get there and ten pictures of it along the way, evenly spaced in time — so the gaps between them are its speed'),
 row(el('span', { class: 'keycol' }, kbd('Drag'), el('span', { class: 'muted' }, ' the chip\'s dial')),
 'Choose the second you are looking at, 0.1 s to 100 s. A matrix that is up re-runs itself at the new second once you let go — the pin has not changed, only the question. Every edit re-runs the machine to it, so the ghost follows what you build. (The play scrub line re-aims it too, when you have a run to scrub.)'),
 row(el('span', { class: 'keycol' }, kbd('Hide'), el('span', { class: 'muted' }, ' on the chip')),
 'Put the future overlay away without leaving GhostRun. The hollow machine at the aimed second is what covers the build; the roads, the score and the sweep stay. Show brings it back. Same item on the ground’s right-click menu'),
 row(el('span', { class: 'keycol' }, kbd('Right-click'), el('span', { class: 'muted' }, ' the ground')),
 'Draw the cargo a ROAD — corners in the order it should travel them, ending at the goal. Use one when the cargo has to go the wrong way first, which on some levels is the only way it ever goes the right way. Drag a corner to move it, right-click one to remove it. Several roads are allowed and the best of them counts; on a level with more than one cargo, each road belongs to one'),
 row(el('span', { class: 'keycol' }, kbd('Right-click'), el('span', { class: 'muted' }, ' a goal piece or a goal zone')),
 'On a level with more than one goal, pick which cargo goes to which pad. The ghost then scores that piece against that zone alone — a delivery to the other pad no longer counts as close. Numbered on the zones themselves; the chip writes 1→2 when cargo 1 is sent to goal 2. “Any goal” is the default, and the real win condition is still any piece in any zone'),
 row(el('span', { class: 'keycol' }, kbd('Right-click'), el('span', { class: 'muted' }, ' one of your pins')),
 'SWEEP it — any pin you are allowed to move, the CARGO’s own included: 225 positions for it, each one a full re-run, scored by how far it gets the cargo along its road — or straight at the goal if you have not drawn one. Three rungs, 1 px, 0.1 px and 0.01 px, the same three steps the arrow keys nudge by; each covers a tenth of the width of the one above, so the coarse one finds the region and the fine ones find what is inside it'),
 row(el('span', { class: 'keycol' }, kbd('Right-click'), el('span', { class: 'muted' }, ' a stick')),
 'Sweep its DENSITY instead — all hundred whole weights ×1 to ×100, laid out 10×10, scored the same way. A rope sweeps every link together, as its own slider writes them. It is the same field and the same click: one hand-set value against a hundred measured ones'),
 row(el('span', { class: 'keycol' }, kbd('Click'), el('span', { class: 'muted' }, ' the field')),
 'Hover a cell and the cargo’s road for that candidate is drawn over the level in slate — free, because it is the run the cell was scored from. Every position is measured and painted as it goes: green beats the machine you have, gold DELIVERS (deepest gold is soonest), grey is a spot the editor refuses. Click any measured cell — while the sweep is still running if you like — and the pin goes there — always measured from where the sweep began, so you can walk a cluster and watch each one, and the middle cross puts it back. The scale under it says what the colours are worth'),
 row('Esc', 'Stop a sweep. What it measured stays on the chip and is still clickable, and it says how much of the grid it covered'),
 ], 'Advanced mode only (the ⚙ menu). Edit a machine against a chosen second of its own future: pick the second, and the ghost shows you what your changes do to it without ever pressing Play. No run needed to start. Walked through under Help → Advanced.'),

 // The visual glossary. It used to live on the tutorial, which is now a
 // ten-step arc with no room for a catalogue — and a catalogue is what this
 // is, so the reference page is where it belongs. Drawn by the game's own
 // renderer, ropes included, so it cannot show a piece the game no longer has.
 el('div', { class: 'keys-block' },
 el('h2', {}, 'The pieces'),
 el('p', { class: 'muted' }, 'Every part you can build a machine from, drawn the size you get.'),
 partsGlossary()),

 table('Picking a tool', [
 row('1 … 0', 'The toolbar in order — the number printed on each button'),
 row('L / F / R', 'The three wheels — Left-rolling, Free, Right-rolling'),
 row('H / W', 'Hard (wood) stick, Water stick'),
 row('G / P / T', 'Goal piece, terrain Painter, Text label (Create tab)'),
 row('X', 'The delete tool'),
 row('B', 'Step into the background and back out (Create tab)'),
 ], 'Every tool has a number — its place on the toolbar — and the ones worth a word have a letter too. Both always work.'),

 table('Test tab — building a machine', toolRows(MACHINE_TOOLS)),
 table('Create tab — authoring the level', toolRows(LEVEL_TOOLS.filter(t => !MACHINE_TOOLS.some(m => m.id === t.id)))),

 table('Selecting & editing', [
 row('Click', 'Select that one piece · drag to move the whole connected machine'),
 row('Double-click', 'Select the whole connected machine'),
 row('Ctrl Click', 'Delete the piece under the cursor (Fantastic Contraption). Cmd+click on a Mac'),
 row('Ctrl Shift Click', 'Add to / remove from the selection (2+ selected shows the align chip)'),
 row('Ctrl Shift Drag', 'On empty space: marquee — sweep a box round everything you want'),
 row('Ctrl Double-click', 'Make this piece the align anchor — it glows gold, and the align ops measure everything else against it'),
 row('Shift Drag', 'On a piece: only that piece moves, links stretch to stay connected. On a joint: that pin only. On empty space: pan'),
 row('Alt Drag', 'Snap to the 20 px half-grid — the finer one, half a standard wheel'),
 row(el('span', { class: 'keycol' }, kbd('Alt'), el('span', { class: 'muted' }, ' while placing')),
 'Works on the ghost too: press to start placing, then hold Alt to snap it to the 20 px grid before you let go. A stick puts both ends on it. Snap ON (S) already puts a plain place on the 40 px grid'),
 row('S', el('span', {},
 'Cycles the ', el('b', {}, 'snap button'), ' through its three states (bottom bar). ',
 el('b', {}, '# ON'), ' — everything snaps, the grid stays on screen. ',
 el('b', {}, '⇧# REVERSED'), ' — free until you hold Alt for the 20 px grid. ',
 el('b', {}, '⊘ OFF'), ' — nothing snaps. Shift is move and pan, not snap. ',
 el('span', { class: 'muted' }, 'New players start on OFF and authors on REVERSED; whichever you pick is remembered.'))),
 row(el('span', { class: 'keycol' }, kbd('Middle'), el('span', { class: 'muted' }, ' drag')),
 'Move a piece where the rules say it cannot go — through terrain, inside another piece. Authoring only: the Create tab, where a level may legitimately want a crate half-sunk in a boulder. Ctrl+Shift+drag does the same, if your hand is already there'),
 row('Scroll', 'On a selected stick: set its weight (Shift ±10, Alt ±100, or use the slider on its right-click menu) · on a ROPE it sets the whole length at once, as far as the next junction · on a selected wheel: step through the three sizes · on a label: its size · on terrain, props and goal pieces: bigger or smaller'),
 row(el('span', { class: 'keycol' }, kbd('Rotate knob')), 'Free rotate · Shift 45° steps · Alt 10° steps · double-click resets to 0°'),
 row('[ / ]', 'Send backward / bring forward (z-order)'),
 row('Shift [ / ]', 'All the way to the back / front'),
 row('Alt Click', 'On a motion path: insert a node · on a prop: drop an attachment pin'),
 row(el('span', { class: 'keycol' }, kbd('Double-click'), el('span', { class: 'muted' }, ' a node')),
 'On a painted outline or motion-path node: flip that point between a CORNER — straight edges through it — and a CURVE, which gets handles you can drag'),
 ]),

 table('Text labels (Create)', [
 row('T', 'The label tool — click where you want it and type. Signs, titles, instructions: nothing collides with a label, and the machine never touches one'),
 row('Double-click', 'Edit the words again — with the font, colour, alignment and style controls'),
 row(el('span', { class: 'keycol' }, kbd('Drag'), el('span', { class: 'muted' }, ' a corner')),
 'Resize it. Text scales as a whole, so the corner opposite the one you grab stays put'),
 row('Scroll', 'Over a selected label: step its size through the same ladder the pieces use (10 · 15 · 20 · 30 · 45 · 60 · 90 · 120 · 180)'),
 row(el('span', { class: 'keycol' }, kbd('Rotate knob')), 'Turn it · double-click the knob to put it back upright'),
 row('[ / ]', 'Its depth, like any other piece. Three places: behind the terrain, over the terrain (the default — under anything that moves, so a label can never hide the machine by accident), or in front of the whole world. Two labels at the same depth swap first; Shift goes all the way'),
 row('Right-click', 'Font, colour and style, its depth, and a motion path — the same controls the edit box offers, wherever you happen to be'),
 ]),

 table('Painting terrain', [
 row('Click', 'Drop a point'),
 row(el('span', { class: 'keycol' }, kbd('Drag')), 'Trace freehand — the curve is simplified when you let go'),
 row('Enter', 'Close the outline and make it solid (clicking the first point, or double-clicking, does the same)'),
 row('Backspace', 'Take back the last point'),
 row('Esc', 'Throw the whole stroke away'),
 row(el('span', { class: 'keycol' }, kbd('Double-click'), el('span', { class: 'muted' }, ' a point')),
 'Afterwards: corner ⇄ curve on that one point'),
 ]),

 el('p', { class: 'muted' },
 'Nothing here is configurable yet. If a binding fights something your keyboard or browser already does, say so — that is a bug in this list, not in your keyboard.')));
}

function supportScreen() {
 document.title = t('Support — LIFIRIK');
 mainEl.append(el('section', { class: 'panel support' },
 el('h1', {}, txt('support.title')),
 el('p', { class: 'muted' }, txt('support.sub')),
 ...rich('support.body'),
 ));
}

// ---------- sound settings (§12) ----------
//
// Every control auditions what it changes. A theme picker whose options are
// three words is a guess; one that plays four impacts when you pick it is a
// decision. Everything is local to the device (localStorage) — sound is a
// property of where you are sitting, not of an account, and it must work
// signed out.
// One card's preview: the same little scene, six times over, differing only in
// the pass it reaches the screen through. Drawn at 2× its CSS size so a wobble
// measured in device pixels survives being scaled down.
function gfxPreviewCanvas(style) {
 const W = 300, H = 200;
 const dst = el('canvas', { class: 'set-gfx-canvas', width: W, height: H });
 const d = dst.getContext('2d');
 // sky straight onto the card, exactly as _draw keeps it out of the style
 const sky = d.createLinearGradient(0, 0, 0, H);
 sky.addColorStop(0, COLORS.skyTop);
 sky.addColorStop(1, COLORS.skyBot);
 d.fillStyle = sky;
 d.fillRect(0, 0, W, H);
 // …and the world on transparency, by the real painters
 const world = document.createElement('canvas');
 world.width = W; world.height = H;
 const g = world.getContext('2d');
 g.fillStyle = g.createPattern(textureTile('grass'), 'repeat');
 g.fillRect(10, 150, W - 20, 40);
 g.strokeStyle = '#63482c';
 g.lineWidth = 3;
 g.strokeRect(10, 150, W - 20, 40);
 // the same alpha rule _draw applies (X-Ray, gfx.js): pieces only, terrain
 // stays opaque — and the card's rod deliberately runs UNDER both wheels, so
 // the one thing X-Ray is for is the thing the card shows
 const xopt = style.worldAlpha ? { alpha: style.worldAlpha } : {};
 drawRod(g, { t: 'rod', kind: 'wood', x1: 90, y1: 135, x2: 190, y2: 135 }, { ...xopt });
 drawWheel(g, { t: 'wheel', kind: 'cw', x: 90, y: 135, r: 15 }, { x: 90, y: 135 }, { ...xopt });
 drawWheel(g, { t: 'wheel', kind: 'free', x: 190, y: 135, r: 15 }, { x: 190, y: 135 }, { ...xopt });
 drawGoalPiece(g, { shape: 'ball', x: 245, y: 136, r: 14 }, { x: 245, y: 136 }, { ...xopt });
 if (gfxIsPost(style)) {
 ensureGfxDefs();
 // the preview is a lone canvas — no DOM grain layer over it — so the
 // grain paints IN here, the way it no longer does on the live screen
 dst.__gfxInline = true;
 applyGfx(d, world, style);
 } else {
 d.drawImage(world, 0, 0);
 }
 return dst;
}

function settingsScreen() {
 document.title = t('Settings — LIFIRIK');
 let s = soundSettings();

 const rerender = () => { mainEl.innerHTML = ''; settingsScreen(); };
 const save = (patch, { audition = null } = {}) => {
 s = setSoundSettings(patch);
 if (audition) { initAudio(); auditionSection(audition); }
 };

 const master = el('label', { class: 'set-row set-master' },
 el('input', {
 type: 'checkbox', checked: s.on || undefined,
 onchange: (e) => { save({ on: e.target.checked }); rerender(); },
 }),
 el('span', { class: 'set-label' }, 'Sound on'));

 const volVal = el('span', { class: 'set-val' }, Math.round(s.volume * 100) + '%');
 const volume = el('label', { class: 'set-row' },
 el('span', { class: 'set-label' }, 'Volume'),
 el('input', {
 type: 'range', min: '0', max: '1', step: '0.01', value: String(s.volume),
 disabled: !s.on || undefined,
 oninput: (e) => {
 volVal.textContent = Math.round(e.target.value * 100) + '%';
 setSoundSettings({ volume: parseFloat(e.target.value) });
 },
 // audition on release only: auditioning per input event would stack a
 // hundred overlapping voices across one drag of the slider. Audition an
 // ENABLED section — with impacts switched off, demonstrating impacts is
 // demonstrating silence, and the slider reads as broken.
 onchange: () => {
 initAudio();
 auditionSection(SECTION_KEYS.find(k => soundSettings().sections[k]) || 'ui');
 },
 }),
 volVal);

 const themes = el('div', { class: 'set-themes' },
 ...THEME_KEYS.map(k => el('button', {
 class: 'set-theme' + (s.theme === k ? ' active' : ''),
 disabled: !s.on || undefined,
 onclick: () => {
 save({ theme: k }, { audition: 'impacts' });
 for (const b of themes.children) b.classList.toggle('active', b.dataset.theme === k);
 },
 'data-theme': k,
 },
 el('span', { class: 'set-theme-name' }, SOUND_THEMES[k].name),
 el('span', { class: 'set-theme-hint' }, SOUND_THEMES[k].hint))));

 const sections = el('div', { class: 'set-sections' },
 ...SECTION_KEYS.map(k => el('div', { class: 'set-section' },
 el('label', { class: 'set-row' },
 el('input', {
 type: 'checkbox', checked: s.sections[k] || undefined, disabled: !s.on || undefined,
 onchange: (e) => save({ sections: { [k]: e.target.checked } },
 { audition: e.target.checked ? k : null }),
 }),
 el('span', { class: 'set-label' }, SOUND_SECTIONS[k].name),
 el('span', { class: 'muted set-hint' }, SOUND_SECTIONS[k].hint)),
 el('button', {
 class: 'btn tiny', disabled: !s.on || undefined,
 title: 'Hear it', onclick: () => { initAudio(); auditionSection(k); },
 }, '▸ hear'))));

 // appendAll, not append: passwordPanel() is null when nobody is signed in,
 // and native append stringifies a null into the literal text "null" — which
 // is exactly what sat at the bottom of this page ("There is a random
 // 'Null' on the end of the Settings pages", 2026-08-06).
 // ---- graphics (§12's audition rule, in pixels) ----
 //
 // A style you can only read the name of is a guess: each card draws the same
 // little scene — sky, grass, a small machine, the green thing — through the
 // REAL pipeline (the render.js painters, then gfx.js's composite), so picking
 // a look is comparing looks rather than words. Clicking applies immediately;
 // there is no separate save.
 const gfx = gfxSettings();
 const gfxCards = el('div', { class: 'set-themes set-gfx' },
 ...GFX_KEYS.map((k) => {
 const st = GFX_STYLES[k];
 return el('button', {
 class: 'set-theme set-gfx-card' + (gfx.style === k ? ' active' : ''),
 onclick: () => {
 setGfxStyle(k);
 for (const b of gfxCards.children) b.classList.toggle('active', b.dataset.gfx === k);
 },
 'data-gfx': k,
 },
 gfxPreviewCanvas(st),
 el('span', { class: 'set-theme-name' }, st.name),
 el('span', { class: 'set-theme-hint' }, st.hint));
 }));

 // **The physics picker is GONE** (2026-08-17, on request: *"We don't need
 // LIFIRIK physics anymore. Just FCLike will do."*). It was a play-testing
 // switch from 2026-08-10 between the fitted `lifirik` profile and `fc`; the
 // trial ended the day the engine became fcsim — a profile fitted to imitate
 // FC under another solver has nothing left to say when FC's own solver is
 // what runs. `physicsMode()` in util.js now answers 'fc' to everyone, the
 // same way this panel's other retired trial went (see the pin picker note
 // below), along with `settings.physics.*` in content.js. The extras the
 // profile never owned — belts, surfaces, radial gravity, gold rods — are
 // feature code and stay.

 // **The wheel-pin picker is GONE** (2026-08-12, on request: *"Get rid of Pin
 // Wheels and the menu option. Grooves win!"*). It was a play-testing switch
 // from 2026-08-11 between `dots` and `groove`; the trial is over and the
 // groove is simply what a wheel looks like now. A settings card offering a
 // choice of one is a question with no answer, so the whole panel went with
 // it, along with `settings.pins.*` in content.js.
 //
 // Nothing that was built comes apart: the groove's slots were always a strict
 // superset of the dots', so every joint a saved machine has it still has
 // (util.js has the property and verify-pins gates it).

 // ---- language ----
 //
 // Same card grid as the sound themes, so picking a language looks like
 // picking anything else here. The endonym leads and the English name is the
 // hint underneath — the person this card exists for is reading a page in a
 // language they don't want, and 简体中文 is legible to them where "Chinese"
 // may not be. Applying reloads: half the visible page was built with the
 // old words, and a reload is the one honest re-render.
 const langCards = el('div', { class: 'set-themes set-langs' },
 ...LANGS.map((l) => el('button', {
 class: 'set-theme' + (langOf() === l.code ? ' active' : ''),
 lang: l.code,
 onclick: () => { if (l.code !== langOf() && setLang(l.code)) location.reload(); },
 },
 el('span', { class: 'lang-flag set-lang-flag', html: flagSVG(l.code) }),
 el('span', { class: 'set-lang-copy' },
 el('span', { class: 'set-theme-name' }, l.name),
 el('span', { class: 'set-theme-hint' }, l.eng)))));


 // ---- interface (2026-08-23) ----
 //
 // The dark plate shipped with its setting named and unbuilt ("data-hud on
 // #app overrides it in either direction so a setting can drive it later" —
 // style.css). Two rows of pills, applied immediately like everything else on
 // this page. 'System' and 'Compact' clear the attribute rather than set a
 // value, which is what lets the stylesheet's own detection keep speaking.
 const pillRow = (key, options, dflt) => {
 const row = el('div', { class: 'set-pills' });
 const current = store.get(key, dflt);
 for (const opt of options) {
 const b = el('button', {
 class: 'btn' + (opt.id === current ? ' active' : ''),
 ...(opt.tip ? { title: opt.tip } : {}),
 onclick: () => {
 store.set(key, opt.id);
 applyHudPrefs();
 for (const c of row.children) c.classList.toggle('active', c === b);
 },
 }, opt.word);
 row.append(b);
 }
 return row;
 };
 const themeRow = pillRow('hudTheme',
 [{ id: 'system', word: 'System', tip: 'Follow the device — dark when it is dark' },
 { id: 'light', word: 'Light', tip: 'Light plates, whatever the device says' },
 { id: 'dark', word: 'Dark', tip: 'Dark plates, whatever the device says' }], 'system');
 const densityRow = pillRow('hudDensity',
 [{ id: 'compact', word: 'Compact', tip: 'The tightest bars — most room for the level' },
 { id: 'cozy', word: 'Cozy', tip: 'A little more air around every button' },
 { id: 'touch', word: 'Touch', tip: 'Finger-sized controls for touch screens' }], 'compact');
 appendAll(mainEl,
 // A page title above the panels, because the cog now leads here and landing
 // on a page headed "Sound" would say the password panel underneath it was
 // somewhere else.
 el('h1', { class: 'page-title' }, '⚙ Settings'),
 el('section', { class: 'panel settings' },
 el('h1', {}, 'Interface'),
 el('p', { class: 'muted' }, 'The plates follow your device unless you say otherwise, and density is how much room the bars and their buttons take.'),
 el('h2', {}, 'Theme'),
 themeRow,
 el('h2', {}, 'Density'),
 densityRow),
 el('section', { class: 'panel settings' },
 el('h1', {}, 'Language'),
 el('p', { class: 'muted' }, txt('settings.language.blurb')),
 langCards),
 el('section', { class: 'panel settings' },
 el('h1', {}, 'Graphics'),
 el('p', { class: 'muted' }, txt('settings.graphics.blurb')),
 gfxCards),
 el('section', { class: 'panel settings' },
 el('h1', {}, 'Sound'),
 el('p', { class: 'muted' },
 'Settings are kept on this device. Impacts get louder the harder they land '
 + 'and take their character from what was hit — what that character IS '
 + 'depends on the theme below.'),
 master,
 volume,
 el('h2', {}, 'Character'),
 themes,
 el('h2', {}, 'What makes sound'),
 sections),
 // **Advanced mode is NOT on this page any more** (2026-08-12, on request:
 // *"Get rid of advanced mode section on COG"*). It moved onto the toolbar's
 // grip menu — right-click the handle — which is both where it takes effect
 // and, now, where it takes effect IMMEDIATELY. The section here was three
 // paragraphs explaining a mode you then had to go and find, with the
 // honest but dismal footnote "takes effect next time you open a level".
 //
 // Deliberately not left as a second door. Two controls for one flag is two
 // places to look and one of them is always the stale one — and the whole
 // reason this could move is that the toolbar copy is exactly the same
 // setting, not a shadow of it.
 passwordPanel());
}

// Change your own password (§12). On the Settings screen because it is the only
// page about YOU rather than about a level — and signed out it is not drawn at
// all, since there is nothing here for somebody with no account.
//
// **There is no "forgot password" and this does not pretend otherwise.** No mail
// is ever sent, so the panel says plainly who to ask; an empty box promising a
// reset link that never arrives would be worse than the honest sentence.
function passwordPanel() {
 const me = api.user();
 if (!me) return null;
 const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password' });
 const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password' });
 const again = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password again' });
 const note = el('p', { class: 'form-error' });
 const go = el('button', { class: 'btn primary' }, 'Change it');
 go.addEventListener('click', async () => {
 note.className = 'form-error';
 // Checked here rather than by the server, because the server is never sent
 // the confirmation — "these two do not match" is a question about this form.
 if (next.value !== again.value) { note.textContent = t('The two new passwords do not match.'); return; }
 if (!current.value || !next.value) { note.textContent = t('Fill in all three boxes.'); return; }
 go.disabled = true;
 try {
 const r = await api.changePassword(current.value, next.value);
 note.className = 'form-ok';
 note.textContent = r.signedOut
 ? tf(r.signedOut > 1 ? 'Done. You are still signed in here; {n} other sessions were signed out.' : 'Done. You are still signed in here; 1 other session was signed out.', { n: r.signedOut })
 : t('Done. Your password is changed.');
 for (const i of [current, next, again]) i.value = '';
 } catch (e) {
 note.textContent = t(e.message || 'Could not change it.');
 } finally { go.disabled = false; }
 });
 return el('section', { class: 'panel settings' },
 el('h1', {}, 'Password'),
 el('p', { class: 'muted' },
 'Changing it signs out every other browser you are signed in on, and leaves this one alone. ',
 'There is no reset by email — nothing here ever sends mail — so if you forget it, ask an admin.'),
 el('label', { class: 'field' }, 'Current password', current),
 el('label', { class: 'field' }, 'New password', next),
 el('label', { class: 'field' }, 'New password again', again),
 note,
 el('div', { class: 'modal-actions' }, go));
}

// **The .fcxml door's landing** (2026-08-18): the token names a design file
// fc-open.cmd stashed on the server seconds ago. Fetch it (one shot — the
// stash deletes on read), convert at the import screen's own defaults, and
// walk straight through to the Maker exactly the way ⤷ Open in Maker does:
// draft slot, the solve into the draft's autosave, go. The screen itself is
// only ever seen on failure — an expired token, or a file the converter
// cannot read — where it says what happened and offers the paste box.
async function fcFileScreen(token) {
 document.title = t('Import — LIFIRIK');
 const note = el('p', { class: 'muted' }, t('Importing the design file…'));
 mainEl.append(el('section', { class: 'panel' }, el('h1', {}, t('FC design file')), note));
 const fail = (msg) => {
 note.textContent = msg;
 note.after(el('p', {}, el('a', { class: 'btn tiny', href: '/import' }, t('Open the import screen'))));
 };
 let paste;
 try {
 const r = await fetch('/api/fc-file/' + encodeURIComponent(token || ''));
 const j = await r.json();
 if (!r.ok) return fail(j.error || t('That import link expired — double-click the file again.'));
 paste = j.paste;
 } catch {
 return fail(t('Could not reach the server — is it running?'));
 }
 let out;
 try {
 out = convertFcLevel(paste); // the import screen's defaults, exactly
 } catch (ex) {
 return fail(t('Could not read that file: ') + (ex.message || t('unknown error')));
 }
 if (!out.stats.parsed) return fail(t('No usable pieces in that file.'));
 const id = 'fc' + Math.random().toString(36).slice(2, 8);
 const drafts = store.get('maker.drafts', {});
 drafts[id] = { level: out.level, savedAt: Date.now(), name: out.level.name };
 store.set('maker.drafts', drafts);
 const design = out.design?.parts ?? out.design;
 if (design?.length) {
 store.set('autosave.draft.' + id, {
 parts: design,
 goals: out.level.goalObjs.map(g => ({ x: g.x, y: g.y })),
 });
 }
 go('/maker/' + id);
}

function importScreen() {
 document.title = t('Import — LIFIRIK');

 const ta = el('textarea', {
 class: 'input import-text', spellcheck: 'false', rows: 12,
 placeholder: 'CODE,x,y,width,height,angle;CODE,x,y,width,height,angle;…',
 });
 const nameIn = el('input', { class: 'input', maxlength: 60, placeholder: 'Imported Level' });
 // Three decimals everywhere the scale is shown: suggest() reports
 // thousandths, so the old 0.005 step could not land on them and the field
 // read them back rounded. The default is 1.000 (one source unit = one
 // pixel). The decimals are for the suggested values, not for it.
 const fmtScale = (v) => Number(v).toFixed(FC_SCALE_DECIMALS);
 const scaleIn = el('input', { class: 'input', type: 'number', min: '0.01', max: '20', step: '0.001', value: fmtScale(FC_DEFAULT_SCALE) });
 const suggestBtn = el('button', {
 class: 'btn tiny', disabled: true,
 title: 'Rescale so this level\'s own goal pieces land on LIFIRIK\'s standard 40 px goal piece',
 }, 'suggest');
 const recentreIn = el('input', { type: 'checkbox', checked: true });
 // On by default because it is the common case and because the alternative is
 // silent: a paste is usually a level with somebody's machine parked in its
 // build area, and imported whole that level arrives already solved.
 const solutionIn = el('input', { type: 'checkbox', checked: true });
 // Pre-selected on the converter's own default rather than on whatever sits
 // first in TEXTURES — the dropdown has to say what the import is going to do.
 const texSel = el('select', { class: 'input' },
 TEXTURES.map(t => el('option', { value: t, selected: t === FC_DEFAULT_TEXTURE || undefined },
 t[0].toUpperCase() + t.slice(1))));
 const bgSel = el('select', { class: 'input' },
 // 'space' rides past el()'s translation as a Text node: bare 'Space' is
 // the keyboard key's dictionary entry, and a dictionary keyed by the
 // English itself cannot hold a second sense of the same word (i18n.js).
 // The sky stays English; the key under the thumb translates.
 Object.keys(BACKGROUNDS).map(b => el('option', { value: b },
 b === 'space' ? document.createTextNode('Space') : b[0].toUpperCase() + b.slice(1))));
 // Sharp by default: source pieces are plain rectangles, so LIFIRIK's 8 px
 // house rounding would be a shape the author never drew. Same three values
 // the Maker's own corner toggle offers.
 const cornerSel = el('select', { class: 'input' },
 el('option', { value: '0' }, 'Sharp (0 px)'),
 el('option', { value: String(CORNER_RADIUS_DEFAULT) }, tf('Rounded ({n} px)', { n: CORNER_RADIUS_DEFAULT })),
 el('option', { value: String(CORNER_RADIUS_LARGE) }, tf('Rounded ({n} px)', { n: CORNER_RADIUS_LARGE })));

 const canvas = el('canvas', { class: 'import-preview', width: 660, height: 372 });
 const statsEl = el('div', { class: 'import-stats' });
 const warnEl = el('ul', { class: 'import-warnings' });
 const errEl = el('p', { class: 'form-error' });

 const openBtn = el('button', { class: 'btn primary', disabled: true, onclick: () => openInMaker() }, 'Open in Level Maker');
 const fileBtn = el('button', { class: 'btn', disabled: true, onclick: () => downloadJSON() }, '⭳ Level JSON');
 const copyBtn = el('button', { class: 'btn', disabled: true, onclick: (e) => copyJSON(e.target) }, 'Copy JSON');

 let current = null; // last good { level, warnings, stats }
 let timer = null;
 // **One texture pick per lettered code** (2026-08-10, on request: "add in
 // individual selectors for the extra terrains… list the unknown ones with a
 // texture selector next to them").
 //
 // The letter rule (`textureForLetter`) is a guess about what a stranger's
 // `CR` or `KC` meant, and it used to be reported in a sentence AFTER the
 // import — a guess you can read and not a guess you can answer. These are the
 // answers, keyed by the whole code, and they survive a re-convert so
 // adjusting the scale does not throw away the textures you just chose.
 const letterPick = {};
 const letterRow = el('div', { class: 'import-letters hidden' });

 const stat = (value, label) => el('span', { class: 'import-stat' }, el('b', {}, value), ' ', label);
 const countStat = (n, one, many) => stat(n, n === 1 ? one : many);

 function paint() {
 statsEl.innerHTML = '';
 warnEl.innerHTML = '';
 const ctx = canvas.getContext('2d');
 ctx.setTransform(1, 0, 0, 1, 0, 0);
 ctx.clearRect(0, 0, canvas.width, canvas.height);

 for (const b of [openBtn, fileBtn, copyBtn]) b.disabled = !current;
 suggestBtn.disabled = !current?.stats.suggestedScale;
 suggestBtn.textContent = current?.stats.suggestedScale ? tf('suggest {n}', { n: fmtScale(current.stats.suggestedScale) }) : t('suggest');
 if (!current) return;

 const s = current.stats;
 renderPreview(canvas, current.level);
 appendAll(statsEl,
 countStat(s.parsed, 'entry read', 'entries read'),
 s.skipped ? stat(s.skipped, 'skipped') : null,
 countStat(s.terrain, 'terrain piece', 'terrain pieces'),
 countStat(s.props, 'prop', 'props'),
 countStat(s.goalObjs, 'goal piece', 'goal pieces'),
 countStat(s.buildZones + s.goalZones, 'zone', 'zones'),
 // The machine, only when there is one — every level has terrain and
 // zones, and most imports have no parts at all. Joints are counted even
 // though nothing is stored for one (§5.4: a joint IS a shared
 // coordinate), because they are statements in the paste and the numbers
 // have to add up to what was pasted.
 s.joints ? countStat(s.joints, 'joint', 'joints') : null,
 s.wheels ? countStat(s.wheels, 'wheel', 'wheels') : null,
 s.rods ? countStat(s.rods, 'stick', 'sticks') : null,
 // What the build area claimed. On the page rather than only in the
 // warning below it: a level that arrives already solved should say so
 // where the other counts are.
 s.designParts ? stat(s.designParts, 'in the player\'s machine (Test tab)') : null,
 // Which way the one ambiguous field was read. Shown only when the paste
 // actually turns something, and it says whether the paste stated the
 // unit or we judged it — a level on its side is this chip.
 s.angleUnit ? stat(s.angleUnit === 'rad' ? 'radians' : 'degrees',
 s.angleDeclared ? 'as stated' : 'read from the values') : null,
 s.extent ? stat(`${Math.round(s.extent.w)}×${Math.round(s.extent.h)}`, 'px across') : null,
 s.extent ? stat(`${s.extent.metresW.toFixed(1)}×${s.extent.metresH.toFixed(1)}`, 'metres') : null,
 );
 for (const w of current.warnings) warnEl.append(el('li', {}, w));
 paintLetterRows(s.letterCodes || []);
 }

 // A row per code the letter rule guessed at: what it said, how many pieces
 // wear it, and a selector set to the guess. Rebuilt on every paint because
 // the codes change with the paste — but the PICKS live outside this function,
 // so a rebuild restores what was chosen rather than resetting it.
 function paintLetterRows(codes) {
 letterRow.innerHTML = '';
 letterRow.classList.toggle('hidden', !codes.length);
 if (!codes.length) return;
 letterRow.append(el('p', { class: 'muted import-letters-lede' },
 'Codes this format does not define. The first letter picked a texture — change any of them:'));
 for (const { code, n, texture } of codes) {
 const sel = el('select', { class: 'input' },
 TEXTURES.map(t => el('option', { value: t, selected: t === texture || undefined }, t[0].toUpperCase() + t.slice(1))));
 sel.addEventListener('change', () => { letterPick[code] = sel.value; convert(); });
 letterRow.append(el('label', { class: 'import-letter' },
 el('b', {}, code),
 el('span', { class: 'muted' }, tf(n === 1 ? '{n} piece' : '{n} pieces', { n })),
 sel));
 }
 }

 // **The credit, with real names** (2026-08-24). The converted level's desc
 // starts as fcProvenance's "unknown builder" line; when the paste is a
 // retrieveLevel document its levelId lets the server look the names up —
 // cached index first, FC only on a miss — and the desc every later step
 // reads (Open in Maker's draft, the JSON download, the Maker's publish
 // dialog) is upgraded in place. Keyed so one paste asks once.
 let fcCreditLine = null, fcCreditKey = null;
 function applyCredit() {
 if (current && fcCreditLine) current.level.desc = fcCreditLine.slice(0, 300);
 }
 function lookupCredit() {
 const levelId = (ta.value.match(/<levelId>\s*(\d+)\s*<\/levelId>/) || [])[1] || null;
 if (!levelId) { fcCreditLine = null; fcCreditKey = null; return; }
 const key = levelId;
 if (key === fcCreditKey) { applyCredit(); return; }
 fcCreditKey = key;
 fcCreditLine = null;
 fetch('/api/fc-meta?level=' + levelId)
 .then((r) => (r.ok ? r.json() : null))
 .then((j) => {
 if (!j || fcCreditKey !== key) return; // the paste moved on
 fcCreditLine = j.credit || null;
 applyCredit();
 })
 .catch(() => { /* the provenance line stands */ });
 }

 function convert() {
 errEl.textContent = '';
 if (!ta.value.trim()) { current = null; paint(); return; }
 try {
 const out = convertFcLevel(ta.value, {
 name: nameIn.value,
 scale: parseFloat(scaleIn.value),
 recentre: recentreIn.checked,
 texture: texSel.value,
 background: bgSel.value,
 corners: parseFloat(cornerSel.value),
 solutionInBuild: solutionIn.checked,
 letterTextures: letterPick,
 });
 current = out.stats.parsed ? out : null;
 if (current) { lookupCredit(); applyCredit(); }
 if (!current) errEl.textContent = t('No usable pieces in there — entries look like "SR,x,y,w,h,angle", separated by semicolons.');
 } catch (ex) {
 current = null;
 errEl.textContent = t('Could not read that: ') + (ex.message || t('unknown error'));
 }
 paint();
 }

 const convertSoon = () => { clearTimeout(timer); timer = setTimeout(convert, 180); };

 ta.addEventListener('input', convertSoon);
 for (const input of [nameIn, recentreIn, solutionIn, texSel, bgSel, cornerSel]) input.addEventListener('change', convert);
 scaleIn.addEventListener('input', convertSoon);
 // Scale gets its own change handler rather than joining the loop above:
 // the displayed value is normalised to three decimals FIRST, so the preview
 // is always the conversion of the number actually shown in the field.
 scaleIn.addEventListener('change', () => {
 if (Number.isFinite(+scaleIn.value) && scaleIn.value.trim() !== '') scaleIn.value = fmtScale(scaleIn.value);
 convert();
 });
 suggestBtn.addEventListener('click', () => {
 if (!current?.stats.suggestedScale) return;
 scaleIn.value = fmtScale(current.stats.suggestedScale);
 convert();
 });

 // The Maker is the destination rather than a straight publish: LIFIRIK's
 // wheels and rods are not the source game's, so an imported level needs a
 // play-test (and usually a nudged goal zone) before it deserves a slot in
 // the Workshop. Publishing then goes through the Maker's normal Save.
 function openInMaker() {
 if (!current) return;
 const id = 'fc' + Math.random().toString(36).slice(2, 8);
 const drafts = store.get('maker.drafts', {});
 drafts[id] = { level: current.level, savedAt: Date.now(), name: current.level.name };
 store.set('maker.drafts', drafts);
 // **The solve rides along, onto the Test tab** (2026-08-11). Whatever of the
 // paste's machine sat inside the build area is the PLAYER's, so it goes
 // where a player's machine goes: the draft's own autosave slot, the key the
 // Maker reads on mount. Exactly the door `_takeIntoMaker` in game.js already
 // carries a half-built machine through — same key, same shape, same reason.
 // `goals` alongside, because the slot stores both and the Maker restores
 // both; the goal pieces have not been moved, so these are where the level
 // says they are.
 if (current.design?.length) {
 store.set('autosave.draft.' + id, {
 parts: current.design,
 goals: current.level.goalObjs.map(g => ({ x: g.x, y: g.y })),
 });
 }
 go('/maker/' + id);
 }

 // Same shape the Maker's own "Save level to file" writes, so the file can be
 // loaded straight back in through Level ▸ Load.
 function levelFilePayload() {
 return { name: current.level.name, desc: current.level.desc, ...fcLevelData(current.level) };
 }

 function downloadJSON() {
 if (!current) return;
 const safe = (current.level.name || 'level').replace(/[^\w \-.]/g, '').trim().slice(0, 40) || 'level';
 const blob = new Blob([JSON.stringify(levelFilePayload(), null, 2)], { type: 'application/json' });
 const url = URL.createObjectURL(blob);
 // 000000: an import isn't in the database until it's published (§11.2)
 const a = el('a', { href: url, download: `LEVEL - 000000 - ${safe}.json` });
 document.body.append(a);
 a.click();
 a.remove();
 URL.revokeObjectURL(url);
 }

 async function copyJSON(btn) {
 if (!current) return;
 try {
 await navigator.clipboard.writeText(JSON.stringify(levelFilePayload(), null, 2));
 const was = btn.textContent;
 btn.textContent = t('Copied ✓');
 setTimeout(() => { btn.textContent = was; }, 1400);
 } catch {
 errEl.textContent = t('Clipboard blocked by the browser — use ⭳ Level JSON instead.');
 }
 }

 appendAll(mainEl,
 el('h1', { class: 'page-title' }, 'Import a level'),
 el('p', { class: 'muted import-lede' }, txt('import.lede')),
 el('div', { class: 'import-grid' },
 el('section', { class: 'import-panel' },
 el('div', { class: 'import-panel-head' },
 el('h2', {}, 'Level text'),
 el('button', { class: 'btn tiny', onclick: () => { ta.value = FC_EXAMPLE; convert(); } }, 'Load example'),
 el('button', { class: 'btn tiny', title: 'The same grammar written out in full — long names, brackets, one entity per line', onclick: () => { ta.value = FC_EXAMPLE_LONG; convert(); } }, 'Long form'),
 el('button', { class: 'btn tiny ghost', onclick: () => { ta.value = ''; convert(); } }, 'Clear')),
 ta,
 errEl,
 el('div', { class: 'import-opts' },
 el('label', { class: 'field' }, 'Level name', nameIn),
 el('label', { class: 'field' }, 'Terrain texture', texSel),
 el('label', { class: 'field' }, 'Background', bgSel),
 el('label', { class: 'field' }, 'Corners', cornerSel),
 el('label', { class: 'field' }, 'Scale (px per source unit)',
 el('div', { class: 'import-scale' }, scaleIn, suggestBtn))),
 letterRow,
 el('label', { class: 'check' }, recentreIn, 'Recentre the level on the origin'),
 el('label', { class: 'check', title: 'A paste is usually a level with somebody\'s machine parked in its build area. Anything wholly inside the area comes in as the player\'s machine on the Test tab; anything with any part outside it is part of the level.' },
 solutionIn, 'The build area holds a solution — bring it in as the player\'s machine'),
 el('p', { class: 'muted' },
 tf('Default {n}: one source unit is one pixel. FC\'s standard wheel is 40 units across, and so is LIFIRIK\'s, so an ordinary paste lands at the size the author drew. Use suggest if a level was authored off a different base.', { n: fmtScale(FC_DEFAULT_SCALE) }))),
 el('section', { class: 'import-panel' },
 el('h2', {}, 'Preview'),
 canvas,
 statsEl,
 warnEl,
 el('div', { class: 'import-actions' }, openBtn, fileBtn, copyBtn),
 el('p', { class: 'muted' }, txt('import.draft')))),
 );

 paint();
 currentScreen = { destroy() { clearTimeout(timer); } };
}

// ---------- admin ----------

// A right-click menu for the SHELL. The editor has its own (`_showCtxMenu` in
// game.js) but it hangs off a GameScreen and positions inside that pane, so a
// page cannot borrow it. Same `.ctx-menu` / `.ctx-item` / `.ctx-title` classes,
// so the two look like one idea — the difference is `position: fixed` against
// the viewport instead of absolute inside a pane, which is what a menu opened
// on a page-length table needs.
//
// `items` are `{ label, on, disabled, title, danger, onclick }`. A `null` entry
// is skipped, so a caller can build the list with conditionals inline.
let openPageMenu = null;
function closePageMenu() {
 if (openPageMenu?._away) window.removeEventListener('pointerdown', openPageMenu._away, true);
 openPageMenu?.remove();
 openPageMenu = null;
}
function pageMenu(e, title, items) {
 e.preventDefault();
 closePageMenu();
 const menu = el('div', { class: 'ctx-menu' });
 menu.style.position = 'fixed';
 if (title) menu.append(el('div', { class: 'ctx-title' }, title));
 for (const it of items) {
 if (!it) continue;
 const mark = (it.on === undefined ? '' : (it.on ? '☑ ' : '☐ ')) + it.label;
 const b = el('button', {
 class: 'ctx-item' + (it.icon ? ' ctx-item-flag' : '') + (it.on ? ' active' : '') + (it.danger ? ' danger' : ''),
 title: it.title || '',
 onclick: () => { closePageMenu(); it.onclick?.(); },
 },
 it.icon ? el('span', { class: 'lang-flag', html: it.icon }) : null,
 mark);
 if (it.disabled) { b.disabled = true; b.classList.add('muted'); b.onclick = null; }
 menu.append(b);
 }
 if (!menu.querySelector('.ctx-item')) return; // nothing to offer, so no menu
 document.body.append(menu);
 // Clamp AFTER appending — until it is in the document it has no size. Same
 // reasoning as the editor's, and the same failure without it: a menu opened
 // near the bottom of a long table runs off the screen.
 const PAD = 8;
 const m = menu.getBoundingClientRect();
 const x = Math.max(PAD, Math.min(e.clientX, window.innerWidth - PAD - m.width));
 const y = Math.max(PAD, Math.min(e.clientY, window.innerHeight - PAD - m.height));
 menu.style.left = x + 'px';
 menu.style.top = y + 'px';
 openPageMenu = menu;
 // Dismissal: anywhere else, Escape, or the page moving under it. `once` on
 // each, and re-armed by the next open.
 // Dismissal presses must be OUTSIDE the menu. The old listener closed on
 // ANY pointerdown, one shot — which included the press that was choosing an
 // item: the menu vanished mid-tap, the detached button never received its
 // click, and the item silently did nothing. Invisible to every scripted
 // test, because a synthetic .click() carries no pointerdown — it took a
 // real finger on the admin's "Delete account…" to catch it ("same
 // problem!", 2026-08-06). Capture phase, so a press on something that
 // stops propagation still closes the menu; not `once`, because a press
 // INSIDE the menu that does not close it must not disarm the outside one.
 const away = (ev) => { if (!menu.contains(ev.target)) closePageMenu(); };
 menu._away = away;
 setTimeout(() => {
 window.addEventListener('pointerdown', away, true);
 window.addEventListener('scroll', closePageMenu, { once: true, capture: true });
 }, 0);
 window.addEventListener('keydown', function esc(ev) {
 if (ev.key === 'Escape') { closePageMenu(); window.removeEventListener('keydown', esc); }
 });
}

// The two admin spreadsheets use the same columns/sort/select machinery as a
// profile's, so the pages behave identically and there is one set of rules.
// `get` returns the value to sort on — never the rendered cell, so a column can
// sort by a number while printing "4.3 (12)".
const ADMIN_LEVEL_COLS = [
 // The campaign number, and it is EDITABLE in the cell (§13) — sorting by it
 // puts the campaign in its running order at the top of the table, which is
 // the view you want while reordering it. Non-campaign levels sort after every
 // numbered one rather than before, so typing a number into one is a promotion
 // from the bottom of the list instead of a scroll to find it.
 {
 id: 'slot', label: '#', cls: 'n',
 get: (l) => (l.official && l.slot != null ? l.slot : 1e9),
 // not in the campaign = no number to sort by, so it sits below the ones
 // that have one in both directions (see refreshLevels' comparator)
 tail: (l) => !(l.official && l.slot != null),
 },
 { id: 'name', label: 'Level', cls: 'name', get: (l) => (l.name || '').toLowerCase() },
 { id: 'author', label: 'Author', cls: 'who', get: (l) => (l.author || '').toLowerCase() },
 { id: 'plays', label: 'Plays', cls: 'n', get: (l) => l.plays || 0 },
 { id: 'solves', label: 'Solves', cls: 'n', get: (l) => l.solves || 0 },
 { id: 'rating', label: 'Rating', cls: 'n', get: (l) => (l.rating ?? -1) },
 { id: 'diff', label: 'Difficulty', cls: 'n', get: (l) => (l.difficulty ?? -1) },
 // What has actually been DONE on this level — the union over its public
 // solves (§11.4), which is the same `l.badges` the filter beside the table
 // matches on, so the column and the filter can never tell different stories.
 // Sorted by how many, because "which levels has nobody managed a wet run on"
 // is the question an admin brings to a badge column.
 { id: 'badges', label: 'Badges', cls: 'badges', get: (l) => (l.badges || []).length },
 { id: 'at', label: 'Saved', cls: 'n', get: (l) => l.createdAt || 0 },
];

const ADMIN_SOLVE_COLS = [
 { id: 'level', label: 'Level', cls: 'name', get: (s) => (s.levelName || '').toLowerCase() },
 // the solve's own title (2026-08-19: "Solves should have the Solve title in the spreadsheet")
 { id: 'title', label: 'Solve', cls: 'name', get: (s) => (s.name || '').toLowerCase() },
 { id: 'by', label: 'Player', cls: 'who', get: (s) => (s.by || '').toLowerCase() },
 // an attempt has no time, and sorting by time should not scatter attempts
 // through the winners — Infinity puts every one of them at the far end
 { id: 'time', label: 'Time', cls: 'n', get: (s) => (s.won && s.time != null ? s.time : Infinity) },
 { id: 'pieces', label: 'Pieces', cls: 'n', get: (s) => (s.won ? s.pieces ?? Infinity : Infinity) },
 { id: 'kg', label: 'Weight', cls: 'n', get: (s) => (s.won ? s.kg ?? Infinity : Infinity) },
 { id: 'badges', label: 'Badges', cls: 'badges', get: (s) => computeBadges(s).length },
 { id: 'vis', label: 'Visibility', cls: 'vis', get: (s) => (s.public ? 1 : 0) },
 { id: 'at', label: 'When', cls: 'n', get: (s) => s.at || 0 },
];

// The campaign number, editable where it is shown (§13). Type a number, press
// Enter: that level becomes campaign N, and whatever was there moves down.
// Clear the box (or press ✕) to take a level out of the campaign.
//
// **A text box rather than drag-to-reorder**, and that is the whole interaction
// design here. The thing an admin wants to say is "this one is 13" — they know
// the number, they are looking at a numbered list. Dragging expresses "up eleven
// rows", which is the same fact restated as a chore, and it has to be performed
// inside a table that scrolls. Typing also survives sorting and filtering the
// table underneath it, which dragging cannot.
//
// Enter commits and nothing else does — no commit on blur, matching the Users
// tab's editable limits. A number that changes because you clicked away is a
// number you did not mean to change.
function campaignNumCell(l, onDone) {
 const shown = () => (l.official && l.slot != null ? String(l.slot + 1) : '');
 const input = el('input', {
 class: 'input campaign-num',
 value: shown(),
 placeholder: '–',
 inputmode: 'numeric',
 title: l.official
 ? 'Campaign number. Type another and press Enter — everything from there on shifts down. Empty it to drop the level out of the campaign.'
 : 'Not in the campaign. Type a number and press Enter to put it there.',
 });
 const commit = async (raw) => {
 const text = raw.trim();
 if (text === '' && !l.official) return; // nothing to do
 if (text !== '' && l.official && +text === l.slot + 1) return; // already there
 const n = parseInt(text, 10);
 if (text !== '' && !(n >= 1)) {
 input.value = shown();
 return alert('Type a whole number from 1, or empty the box to take it out of the campaign.');
 }
 input.disabled = true;
 try {
 if (text === '') await api.removeFromCampaign(l.id);
 else await api.setCampaignNumber(l.id, n);
 onDone();
 } catch (e) {
 input.disabled = false;
 input.value = shown();
 alert(e.message || 'Could not change that number.');
 }
 };
 input.addEventListener('keydown', (e) => {
 if (e.key === 'Enter') { e.preventDefault(); commit(input.value); }
 if (e.key === 'Escape') { input.value = shown(); input.blur(); }
 });
 input.addEventListener('blur', () => { input.value = shown(); });
 return el('span', { class: 'campaign-num-cell' },
 input,
 l.official ? el('button', {
 class: 'btn tiny ghost',
 title: 'Take this level out of the campaign — it stays a level, with its solves and comments, and goes back to the Workshop',
 onclick: () => commit(''),
 }, '✕') : null);
}

function adminScreen() {
 document.title = 'Admin — LIFIRIK';
 // The one page that gets the full monitor: the users grid needs 1150 px and
 // the default shell is 1100, so it scrolled sideways on every screen ever
 // made until this line existed.
 mainEl.className = 'main wide';
 if (!api.user()?.isAdmin) {
 mainEl.append(el('div', { class: 'center-msg' },
 el('h2', {}, 'Admins only'),
 el('p', { class: 'muted' }, 'You need to be signed in as an admin to see this page.')));
 return;
 }

 const overviewWrap = el('div', { class: 'admin-overview' }, el('p', { class: 'muted' }, 'Loading…'));
 const activeWrap = el('div', { class: 'admin-active' }, el('p', { class: 'muted' }, 'Loading…'));
 const usersWrap = el('div', { class: 'admin-users' });
 const levelsWrap = el('div', { class: 'admin-levels' });
 const solvesWrap = el('div', { class: 'admin-solves' });

 // Same row as every other searchable list on the site (§8.2): text, author,
 // selects, all on ONE line. These used to be bare `.input`s in a plain flex
 // row, and `.input` is `width: 100%` — so each one demanded the full width and
 // the three controls stacked into three rows of their own.
 // **Every one of these is remembered** (§8.1, `tablePrefs`) — search text,
 // author, the sort AND the column the table is ordered by. The rule is the
 // one the profile tables already followed and the rest of the site did not:
 // going into a level and coming back should land you where you were, not on
 // a screen that has forgotten the question you were asking. Admin especially,
 // where the question is usually several clicks of set-up.
 const userPrefs = tablePrefs('admin.users', { q: '', sort: 'createdAt', dir: -1 });
 const levelPrefs = tablePrefs('admin.levels',
 { q: '', author: '', order: 'new', sort: 'at', dir: -1, badges: new Set(), badgeNot: new Set(), done: '', view: 'table' });
 const solvePrefs = tablePrefs('admin.solves',
 { q: '', sort: 'at', dir: -1, badges: new Set(), badgeNot: new Set(), view: 'table' });

 const userSearch = el('input', { class: 'input search', placeholder: 'Search name or email…', value: userPrefs.state.q });

 const levelSearch = el('input', { class: 'input search', placeholder: 'Search title & comments…', value: levelPrefs.state.q });
 const levelAuthor = el('input', { class: 'input author', placeholder: 'Author…', value: levelPrefs.state.author });
 const levelSort = el('select', { class: 'input' },
 el('option', { value: 'new' }, 'Newest'),
 el('option', { value: 'top' }, 'Top rated'),
 el('option', { value: 'played' }, 'Most played'),
 el('option', { value: 'slot' }, '# order'),
 el('option', { value: 'alpha' }, 'Alphabetical'));
 levelSort.value = levelPrefs.state.order;
 // The same badge filter every other list wears (§8.2) — the admin tables
 // were the last two without one. Levels match on the level's badge UNION
 // (any public solve earned it), solves on the row's own badges, exactly the
 // split the Workshop and a profile already make.
 const levelBadges = badgeFilter(() => refreshLevels(), [...levelPrefs.state.badges], {
 exclude: [...levelPrefs.state.badgeNot],
 });
 levelPrefs.state.badges = levelBadges.set;
 levelPrefs.state.badgeNot = levelBadges.exclude;
 const levelStar = triFilterBtn({
 key: 'done',
 state: levelPrefs.state,
 glyph: { off: '⭐', none: '☆', yes: '⭐' },
 titles: {
 off: t('Off. Click for incomplete.'),
 none: t('Only incomplete. You have no star. Click for completed.'),
 yes: t('Only completed. You have the star. Click to turn off.'),
 },
 aria: t('Filter by whether you have completed this level'),
 onChange: () => refreshLevels(),
 });
 const levelView = viewToggle(levelPrefs.state, () => refreshLevels());
 const levelTableWrap = el('div', { class: 'solve-table-wrap' });
 const levelTiles = el('div', { class: 'tiles-grid hidden' });

 const solveFilter = el('input', { class: 'input search', placeholder: 'Filter by level or player…', value: solvePrefs.state.q });
 const solveBadges = badgeFilter(() => renderSolves(), [...solvePrefs.state.badges], {
 exclude: [...solvePrefs.state.badgeNot],
 });
 solvePrefs.state.badges = solveBadges.set;
 solvePrefs.state.badgeNot = solveBadges.exclude;
 const solveView = viewToggle(solvePrefs.state, () => renderSolves());
 const solveTableWrap = el('div', { class: 'solve-table-wrap' });
 const solveTiles = el('div', { class: 'tiles-grid hidden' });
 const campaignsWrap = el('div', { class: 'admin-campaigns' });
 const textWrap = el('div', { class: 'admin-text' });
 const tuningWrap = el('div', {});

 // ---- seven sections, one at a time ----
 //
 // It was one long scroll, and adding Text and Tuning is what tipped it over:
 // the two panels an admin visits least sat between Users and Levels, so every
 // trip to Solves went past 35 textareas.
 //
 // **Each tab loads on the first look, not on arrival.** Opening this page used
 // to fire six requests — overview, active, users, levels, solves, tuning —
 // whichever one you came for. Now it fires the one you asked for, and each
 // other tab pays for itself when you open it.
 //
 // The choice is REMEMBERED (`store`), for the same reason the tutorial
 // remembers its step: an admin comes back to this page for the same reason
 // they left it, and landing on Database every time is a click of tax on every
 // visit. Not in the path — `/admin/users` would look tidier, but a path
 // change re-routes and rebuilds the whole screen, which would throw away the
 // lazy loading the tabs just bought.
 const TABS = [
 { id: 'db', label: 'Database', body: [overviewWrap], load: loadOverview },
 { id: 'active', label: 'Active now', body: [activeWrap], load: loadActive },
 {
 id: 'users', label: 'Users', load: loadUsers,
 body: [
 el('div', { class: 'browse-search-row' }, userSearch,
 el('span', { class: 'muted' }, 'Click a column to sort. Limits are editable — type and press Enter. ⋯ (or a right-click) for Admin and Moderator.')),
 usersWrap,
 ],
 },
 {
 id: 'levels', label: 'Levels', load: loadLevels,
 body: [el('div', { class: 'browse-search-row' }, levelSearch, levelAuthor, levelSort, levelStar, levelBadges.el, levelView), levelsWrap],
 },
 { id: 'campaigns', label: 'Campaigns', body: [campaignsWrap], load: loadCampaigns },
 {
 id: 'solves', label: 'Solves', load: loadSolves,
 body: [el('div', { class: 'browse-search-row' }, solveFilter, solveBadges.el, solveView), solvesWrap],
 },
 { id: 'text', label: 'Text', body: [textWrap], load: renderText },
 { id: 'tuning', label: 'Tuning', body: [tuningWrap], load: loadTuning },
 ];

 const tabBar = el('div', { class: 'page-tabs' });
 const panels = new Map();
 const loaded = new Set();
 const ADMIN_TAB_KEY = 'adminTab';
 let openTab = TABS.some(t => t.id === store.get(ADMIN_TAB_KEY)) ? store.get(ADMIN_TAB_KEY) : TABS[0].id;

 function showTab(id) {
 openTab = id;
 store.set(ADMIN_TAB_KEY, id);
 for (const [tid, p] of panels) p.classList.toggle('hidden', tid !== id);
 for (const btn of tabBar.children) btn.classList.toggle('on', btn.dataset.tab === id);
 if (!loaded.has(id)) { loaded.add(id); TABS.find(t => t.id === id).load(); }
 }

 for (const t of TABS) {
 const btn = el('button', { class: 'page-tab', dataset: { tab: t.id }, onclick: () => showTab(t.id) }, t.label);
 tabBar.append(btn);
 panels.set(t.id, el('section', { class: 'page-panel hidden' }, ...t.body));
 }

 mainEl.append(
 el('h1', { class: 'page-title' }, '🛠 Admin'),
 tabBar,
 ...panels.values(),
 );
 showTab(openTab);

 function loadOverview() {
 api.adminOverview().then(o => {
 overviewWrap.innerHTML = '';
 const stat = (label, val) => el('div', { class: 'admin-stat' }, el('div', { class: 'admin-stat-val' }, String(val)), el('div', { class: 'muted' }, label));
 overviewWrap.append(
 el('div', { class: 'admin-stat-grid' },
 stat('users', o.users), stat('admins', o.admins), stat('moderators', o.moderators),
 stat('levels', o.levels), stat('official', o.officialLevels), stat('community', o.communityLevels),
 stat('unlisted', o.unlistedLevels), stat('comments', o.totalComments), stat('solve records', o.totalSolves),
 stat('sessions', o.sessions), stat('active now', o.activeNow ?? '—'), stat('server uptime', fmtTime(o.uptimeSec)),
 ),
 el('p', { class: 'muted' }, `db.json: ${(o.dbBytes / 1024).toFixed(1)} KB · ${esc(o.dbPath)}`),
 shareCardRow(),
 );
 }).catch(() => { overviewWrap.innerHTML = ''; overviewWrap.append(el('p', { class: 'muted' }, 'Could not load overview.')); });
 }

 // ---- share cards: draw the ones that predate them (§11.10) ----
 //
 // A card is baked in the AUTHOR'S browser when a level is saved, which means
 // every level published before the feature existed has none — and those are
 // precisely the levels there are to share today. This draws them here, in
 // the admin's browser, from the same data the Workshop cards use, and posts
 // them one at a time. "Missing" is the first-time backfill; "all" is the
 // redraw when the renderer itself changed (zone Z-order, scenery haze) and
 // every already-baked JPEG is a picture of the old pass.
 function shareCardRow() {
 const status = el('span', { class: 'muted' }, '');
 const sweep = async (all) => {
 const btns = [missingBtn, allBtn];
 for (const b of btns) b.disabled = true;
 status.textContent = ' checking…';
 let todo;
 try { todo = (await api.adminOgMissing(all)).missing; }
 catch (e) { status.textContent = ' ' + (e.message || 'could not check'); for (const b of btns) b.disabled = false; return; }
 if (!todo.length) {
 status.textContent = all ? ' no public levels to draw.' : ' every level already has one.';
 for (const b of btns) b.disabled = false;
 return;
 }
 let done = 0, failed = 0;
 for (const row of todo) {
 status.textContent = ` ${done + failed}/${todo.length} — ${row.name}`;
 try {
 // Full `data`, not the compact preview: a card is the level, and
 // `shareCardDataUrl` already frames and draws from either. Data is
 // the source of truth when a preview field was added after save.
 const full = await api.level(row.id);
 const card = shareCardDataUrl(full.data || full.preview);
 if (!card) { failed++; continue; }
 await api.adminOgPut(row.id, card);
 done++;
 } catch { failed++; }
 }
 status.textContent = ` drew ${done} card${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`;
 for (const b of btns) b.disabled = false;
 };
 const missingBtn = el('button', { class: 'btn tiny' }, 'Draw missing share cards');
 const allBtn = el('button', { class: 'btn tiny' }, 'Redraw all share cards');
 missingBtn.addEventListener('click', () => sweep(false));
 allBtn.addEventListener('click', () => sweep(true));
 return el('p', { class: 'muted' }, missingBtn, ' ', allBtn, status);
 }

 // ---- active now: who has done something in the last five minutes ----
 //
 // The window is the server's (ACTIVE_WINDOW_MS) and it reports it, so this
 // page never has to restate the number and risk disagreeing with it. Two
 // things it says out loud rather than implying:
 //
 // * it only knows ACCOUNTS. Anonymous visitors send no token, so there is
 // nobody to name — an empty list is not proof the site is empty.
 // * it only knows since the last RESTART, because last-seen is held in
 // memory. A server up for two minutes cannot know about five.
 //
 // Re-polled on a timer because this is the one thing on the page that is
 // stale the moment it renders; the timer dies with the screen (currentScreen).
 const agoShort = (at, now) => {
 const s = Math.max(0, Math.round((now - at) / 1000));
 if (s < 10) return 'now';
 if (s < 60) return s + 's ago';
 return Math.floor(s / 60) + 'm ago';
 };
 function renderActive(d) {
 activeWrap.innerHTML = '';
 const mins = Math.round(d.windowMs / 60000);
 const short = d.sinceRestart < d.windowMs;
 if (!d.users.length) {
 activeWrap.append(el('p', { class: 'muted' },
 short
 ? `Nobody yet — the server has only been up ${fmtTime(Math.round(d.sinceRestart / 1000))}, and this list starts empty on a restart.`
 : `Nobody signed in has done anything in the last ${mins} minutes.`));
 return;
 }
 const table = el('div', { class: 'admin-user-table' });
 for (const u of d.users) {
 table.append(el('div', { class: 'admin-user-row' + (u.status === 'banned' ? ' banned' : u.status === 'hold' ? ' held' : '') },
 el('span', { class: 'admin-user-name' },
 el('span', { class: 'active-dot', title: 'Active' }, '●'),
 el('a', { href: '/user/' + encodeURIComponent(u.name) }, u.name),
 u.isAdmin ? el('span', { class: 'role-tag', title: 'Admin' }, ' A') : null,
 u.isModerator ? el('span', { class: 'role-tag', title: 'Moderator' }, ' M') : null),
 el('span', { class: 'muted' }, agoShort(u.at, d.now)),
 // the request itself, not a guess at what they were "doing" — it is the
 // only thing actually known, and it is the useful thing when something
 // is hammering the API
 el('span', { class: 'muted admin-active-path' }, u.last || ''),
 ));
 }
 activeWrap.append(table,
 el('p', { class: 'muted' },
 `${d.users.length} signed-in account${d.users.length === 1 ? '' : 's'} active in the last ${mins} minutes`,
 short ? ' (since this server started — the list resets on a restart)' : '',
 '. Anonymous visitors can\'t be counted: they send no session.'));
 }
 function loadActive() {
 return api.adminActive().then(renderActive).catch(() => {
 activeWrap.innerHTML = '';
 activeWrap.append(el('p', { class: 'muted' }, 'Could not load who is active.'));
 });
 }
 // No eager call: the tab bar loads this one when it is first opened, like
 // every other section. The poll below only ticks while it is the open tab —
 // re-fetching a panel nobody is looking at is exactly the cost the tabs were
 // meant to remove.
 const activeTick = setInterval(() => { if (openTab === 'active') loadActive(); }, 20000);
 currentScreen = { destroy() { clearInterval(activeTick); } };

 // ---- users: one fetch, filtered/sorted client-side ----
 //
 // A real table rather than a list of cards: the point of this page is
 // comparing accounts against each other and against their limits, which
 // needs aligned columns you can sort on. `headroom` sorts are the ones that
 // actually matter in practice — "who is closest to their cap" — so each
 // usage column sorts by remaining room, not raw count.
 let allUsers = [];
 let sortKey = userPrefs.state.sort, sortDir = userPrefs.state.dir;

 const COLS = [
 { key: 'name', label: 'User', get: u => u.name, cmp: (a, b) => a.name.localeCompare(b.name) },
 { key: 'email', label: 'Email', get: u => u.email || '—', cmp: (a, b) => (a.email || '').localeCompare(b.email || '') },
 { key: 'createdAt', label: 'Joined', get: u => new Date(u.createdAt).toISOString().slice(0, 10), cmp: (a, b) => a.createdAt - b.createdAt },
 { key: 'points', label: 'Points', get: u => u.points, cmp: (a, b) => a.points - b.points, num: true },
 { key: 'levels', label: 'Levels', usage: 'levels', limit: 'levelLimit', cmp: (a, b) => (a.levelLimit - a.levels) - (b.levelLimit - b.levels) },
 { key: 'levelRating', label: 'Lvl ★', rating: 'levelRating', cmp: (a, b) => (a.levelRating ?? -1) - (b.levelRating ?? -1) },
 { key: 'solves', label: 'Solves', usage: 'solves', limit: 'solveLimit', cmp: (a, b) => (a.solveLimit - a.solves) - (b.solveLimit - b.solves) },
 { key: 'solveRating', label: 'Solve ★', rating: 'solveRating', cmp: (a, b) => (a.solveRating ?? -1) - (b.solveRating ?? -1) },
 // not how hard THEY say things are — the mean crowd difficulty of the
 // distinct levels they've actually beaten
 { key: 'solvedDifficulty', label: 'Avg diff', rating: 'solvedDifficulty', cmp: (a, b) => (a.solvedDifficulty ?? -1) - (b.solvedDifficulty ?? -1) },
 { key: 'comments', label: 'Comments', usage: 'comments', limit: 'commentLimit', cmp: (a, b) => (a.commentLimit - a.comments) - (b.commentLimit - b.comments) },
 { key: 'commentRating', label: 'Cmt 👍', rating: 'commentRating', cmp: (a, b) => (a.commentRating ?? -2) - (b.commentRating ?? -2) },
 { key: 'status', label: 'State', cmp: (a, b) => (a.status || '').localeCompare(b.status || '') },
 ];

 // Which server field each usage column's limit maps to, for the PATCH.
 const LIMIT_FIELD = { levelLimit: 'levels', solveLimit: 'solves', commentLimit: 'comments' };

 function renderUsers() {
 usersWrap.innerHTML = '';
 const q = userSearch.value.trim().toLowerCase();
 userPrefs.state.q = userSearch.value;
 userPrefs.state.sort = sortKey;
 userPrefs.state.dir = sortDir;
 userPrefs.save();
 const list = (q
 ? allUsers.filter(u => u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
 : allUsers.slice());
 const col = COLS.find(c => c.key === sortKey);
 if (col) list.sort((a, b) => col.cmp(a, b) * sortDir);
 const me = api.user();

 const head = el('div', { class: 'admin-grid-row head' },
 ...COLS.map(c => el('button', {
 class: 'admin-grid-h' + (sortKey === c.key ? ' sorted' : ''),
 title: c.usage ? 'Sort by remaining headroom' : 'Sort by ' + c.label,
 onclick: () => {
 if (sortKey === c.key) sortDir = -sortDir;
 else { sortKey = c.key; sortDir = c.key === 'name' || c.key === 'email' ? 1 : -1; }
 renderUsers();
 },
 }, c.label + (sortKey === c.key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''))));

 const table = el('div', { class: 'admin-grid' }, head);

 for (const u of list) {
 const cells = COLS.map(c => {
 if (c.usage) {
 // "used / limit", the limit editable in place. Turns red once the
 // account is at its cap so a full user is visible at a glance.
 const used = u[c.usage], cap = u[c.limit];
 const input = el('input', {
 class: 'admin-limit', type: 'number', min: '0', value: String(cap),
 title: `${used} used of ${cap}. Edit and press Enter to change the limit.`,
 });
 input.addEventListener('keydown', async (e) => {
 if (e.key !== 'Enter') return;
 const v = parseInt(input.value, 10);
 if (!isFinite(v) || v < 0) { input.value = String(cap); return; }
 try {
 await api.adminSetLimits(u.name, { [LIMIT_FIELD[c.limit]]: v });
 u[c.limit] = v;
 renderUsers();
 } catch (err) { alert(err.message || 'Could not set the limit.'); input.value = String(cap); }
 });
 return el('span', { class: 'admin-grid-c' + (used >= cap ? ' at-limit' : '') },
 el('span', { class: 'admin-used' }, String(used)), el('span', { class: 'muted' }, ' / '), input);
 }
 if (c.rating) {
 const v = u[c.rating];
 return el('span', { class: 'admin-grid-c muted' }, v == null ? '—' : v.toFixed(2));
 }
 if (c.key === 'status') {
 const sel = el('select', { class: 'admin-status ' + (u.status || 'active') },
 el('option', { value: 'active' }, 'active'),
 el('option', { value: 'hold' }, 'hold'),
 el('option', { value: 'banned' }, 'banned'));
 sel.value = u.status || 'active';
 sel.disabled = u.id === me.id;
 sel.addEventListener('change', async () => {
 try { await api.adminSetStatus(u.name, sel.value); u.status = sel.value; renderUsers(); }
 catch (err) { alert(err.message || 'Could not change status.'); sel.value = u.status || 'active'; }
 });
 return el('span', { class: 'admin-grid-c' }, sel);
 }
 if (c.key === 'name') {
 // **A visible button as well as the right-click.** The context menu
 // has been the only way in, with a line of help text above the table
 // saying so — and it was still reported as "no way to give somebody
 // admin". A menu you have to be told about is a menu most people
 // never find; the ⋯ opens exactly the same one.
 const roles = el('button', {
 class: 'btn tiny role-btn', title: 'Roles — Admin and Moderator',
 onclick: (e) => { e.preventDefault(); e.stopPropagation(); roleMenu(e, u); },
 }, '⋯');
 return el('span', { class: 'admin-grid-c admin-user-name' },
 crownFor(u), el('a', { href: '/user/' + encodeURIComponent(u.name) }, u.name),
 u.id === me.id ? el('span', { class: 'muted' }, ' (you)') : null,
 u.isAdmin ? el('span', { class: 'role-tag', title: 'Admin' }, ' A') : null,
 u.isModerator ? el('span', { class: 'role-tag', title: 'Moderator' }, ' M') : null,
 el('span', { class: 'spacer' }), roles);
 }
 return el('span', { class: 'admin-grid-c' + (c.num ? ' num' : '') }, String(c.get(u)));
 });
 const row = el('div', { class: 'admin-grid-row' + (u.status === 'banned' ? ' banned' : u.status === 'hold' ? ' held' : '') }, ...cells);
 // **Roles live on a right-click.** `POST /api/admin/users/:name/role` and
 // `api.adminSetRole` have both existed for a long time and NOTHING called
 // the second one — the plumbing was finished and the tap was never fitted,
 // so the documented way to make an admin was a five-step round trip
 // through a JSON export that deletes the database on the way (README).
 //
 // A menu rather than two more columns: the grid is already eleven wide,
 // and a role is something you change once in the life of an account, not
 // something you scan.
 row.addEventListener('contextmenu', (e) => roleMenu(e, u));
 table.append(row);
 }
 if (!list.length) table.append(el('p', { class: 'muted' }, 'No users match.'));
 usersWrap.append(table);

 // The menu itself, opened from the ⋯ button and from a right-click
 // anywhere on the row — one definition, two doors.
 function roleMenu(e, u) {
 const isMe = u.id === me.id;
 const setRole = async (patch, revert) => {
 try {
 await api.adminSetRole(u.name, patch);
 Object.assign(u, patch);
 renderUsers();
 } catch (err) { alert(err.message || 'Could not change the role.'); revert?.(); }
 };
 pageMenu(e, u.name, [
 {
 label: 'Admin', on: !!u.isAdmin, disabled: isMe,
 // The same guard the status dropdown already has (`sel.disabled =
 // u.id === me.id`), and here it is load-bearing rather than tidy: an
 // admin who unticks their own box cannot tick it back, and on a
 // one-admin install that is the site locked with no way in but the
 // database. Hand it to somebody else and let them demote you.
 title: isMe ? 'You cannot change your own roles — promote someone else and let them do it'
 : u.isAdmin ? 'Full power: users, levels, solves, curation' : 'Grant full admin power',
 onclick: () => setRole({ isAdmin: !u.isAdmin }),
 },
 {
 label: 'Moderator', on: !!u.isModerator, disabled: isMe,
 title: isMe ? 'You cannot change your own roles'
 : u.isAdmin ? 'Admins already have every moderator power (§13) — this only matters if you take Admin away'
 : 'Comment removal only',
 onclick: () => setRole({ isModerator: !u.isModerator }),
 },
 {
 label: 'Delete account…', danger: true, disabled: isMe || !!u.isAdmin,
 title: isMe ? 'Not from the inside — another admin has to do it'
 : u.isAdmin ? 'Admins cannot be deleted — take the role away first, then delete'
 : 'Delete this account AND its levels, solves, comments, votes — no undo of any kind',
 onclick: () => deleteAccountModal(u),
 },
 ]);
 }

 // The "Are you sure!?", with the account's name typed back to arm the
 // button. The server enforces the same `confirm` — this box is the honest
 // half of the interface, not the guard — and hold/ban stay the right tool
 // for a PERSON who is the problem; this one is for CONTENT that is
 // (spam), where freezing the author leaves the mess on every listing.
 function deleteAccountModal(u) {
 modal(`🗑 Delete ${u.name} — everything, forever`, (body, close) => {
 const input = el('input', { class: 'input', placeholder: u.name, autocomplete: 'off', spellcheck: 'false' });
 const errEl = el('p', { class: 'form-error' });
 const go = el('button', { class: 'btn danger', disabled: true }, 'Are you sure!? Yes — delete it all');
 input.addEventListener('input', () => { go.disabled = input.value !== u.name; });
 go.addEventListener('click', async () => {
 go.disabled = true;
 let r;
 try { r = await api.adminDeleteUser(u.name, input.value); }
 catch (ex) { go.disabled = false; errEl.textContent = ex.message || 'Could not delete that account.'; return; }
 const i = allUsers.findIndex(x => x.id === u.id);
 if (i >= 0) allUsers.splice(i, 1);
 renderUsers();
 // the receipt replaces the dialog wholesale, like the password
 // reveal — no button left to press twice, no doubt about what went
 body.textContent = '';
 appendAll(body,
 el('p', {}, `${esc(u.name)} is gone: ${r.levels} level${r.levels === 1 ? '' : 's'}, ${r.solves} solve${r.solves === 1 ? '' : 's'}, ${r.comments} comment${r.comments === 1 ? '' : 's'}, ${r.ratings} rating${r.ratings === 1 ? '' : 's'}${r.challenges ? `, ${r.challenges} open challenge${r.challenges === 1 ? '' : 's'}` : ''}, and ${r.sessions} live session${r.sessions === 1 ? '' : 's'}.`),
 el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', onclick: close }, 'Done')));
 });
 appendAll(body,
 el('p', {}, `This deletes the account and everything it owns — `,
 el('b', {}, `${u.levels} level${u.levels === 1 ? '' : 's'}, ${u.solves} solve${u.solves === 1 ? '' : 's'}, ${u.comments} comment${u.comments === 1 ? '' : 's'}`),
 ` — plus its ratings, its open challenges, and every live session. Campaign levels they authored stay: those belong to the game now.`),
 el('p', { class: 'muted' }, 'There is no undo of any kind. Type the account\'s name to arm the button.'),
 input, errEl,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: close }, 'Cancel'), go));
 });
 }
 }
 // ---- Text: the site's own words, editable live (§13.1) ----
 //
 // The default is always on screen next to the box, because "what did this say
 // before I touched it" is the question you have the moment you have changed
 // something, and the answer being a deploy away is what stops people editing
 // at all. Clearing the box restores the default — the server treats empty as
 // "no override", so Reset needs no second route.
 // ---- Campaigns: title, byline, then sections (title, byline, range) ----
 //
 // The hub's set cards are this list. Each section is a heading on the
 // campaign page covering an inclusive range of campaign numbers.
 function loadCampaigns() {
 const blankSection = () => ({ title: '', byline: '', range: '' });
 const blankCampaign = () => ({ id: '', title: '', byline: '', sections: [blankSection()] });
 const fromApi = (c) => ({
 id: c.id,
 title: c.title || c.name || '',
 byline: c.byline || c.blurb || '',
 sections: (c.sections && c.sections.length ? c.sections : [{ title: c.title || '', byline: '', from: c.from, to: c.to }])
 .map((s) => ({ title: s.title || s.name || '', byline: s.byline || s.blurb || '', range: formatCampaignRange(s.from, s.to) })),
 });
 const status = el('p', { class: 'muted' }, 'Loading…');
 campaignsWrap.innerHTML = '';
 campaignsWrap.append(status);
 api.campaigns().then((r) => {
 let rows = (r.campaigns || []).map(fromApi);
 if (!rows.length) rows = [blankCampaign()];
 const list = el('div', {});
 const note = el('p', { class: 'form-error' });
 const paint = () => {
 list.innerHTML = '';
 rows.forEach((row, i) => {
 if (!row.sections.length) row.sections = [blankSection()];
 const titleIn = el('input', { class: 'input', maxlength: '80', value: row.title, placeholder: 'Starters' });
 const bylineIn = el('textarea', { class: 'input admin-text-area', rows: '2', maxlength: '400', placeholder: 'What this series is for' });
 bylineIn.value = row.byline;
 titleIn.addEventListener('input', () => { row.title = titleIn.value; });
 bylineIn.addEventListener('input', () => { row.byline = bylineIn.value; });
 const sectionBox = el('div', { class: 'admin-campaign-sections' });
 row.sections.forEach((sec, si) => {
 const sTitle = el('input', { class: 'input', maxlength: '80', value: sec.title, placeholder: 'Foundations' });
 const sRange = el('input', { class: 'input', value: sec.range, placeholder: '1,8' });
 const sBy = el('textarea', { class: 'input admin-text-area', rows: '2', maxlength: '400', placeholder: 'What this part is' });
 sBy.value = sec.byline;
 sTitle.addEventListener('input', () => { sec.title = sTitle.value; });
 sRange.addEventListener('input', () => { sec.range = sRange.value; });
 sBy.addEventListener('input', () => { sec.byline = sBy.value; });
 sectionBox.append(el('div', { class: 'admin-campaign-section' },
 el('div', { class: 'admin-campaign-row' },
 el('label', { class: 'field' }, 'Section title', sTitle),
 el('label', { class: 'field' }, 'Range', sRange),
 el('button', {
 class: 'btn tiny ghost', title: 'Remove this section',
 onclick: () => {
 row.sections.splice(si, 1);
 if (!row.sections.length) row.sections.push(blankSection());
 paint();
 },
 }, 'Remove')),
 el('label', { class: 'field' }, 'Section byline', sBy)));
 });
 list.append(el('div', { class: 'admin-campaign' },
 el('div', { class: 'admin-campaign-row admin-campaign-head' },
 el('label', { class: 'field' }, 'Title', titleIn),
 el('button', {
 class: 'btn tiny ghost', title: 'Remove this campaign',
 onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push(blankCampaign()); paint(); },
 }, 'Remove campaign')),
 el('label', { class: 'field' }, 'Byline', bylineIn),
 sectionBox,
 el('button', { class: 'btn tiny', onclick: () => { row.sections.push(blankSection()); paint(); } }, 'Add section')));
 });
 };
 paint();
 const save = el('button', { class: 'btn primary' }, 'Save campaigns');
 save.addEventListener('click', async () => {
 note.className = 'form-error';
 note.textContent = '';
 const payload = rows
 .filter((row) => row.title.trim() || row.byline.trim() || row.sections.some((s) => s.title.trim() || s.range.trim()))
 .map((row) => ({
 id: row.id,
 title: row.title,
 byline: row.byline,
 sections: row.sections
 .filter((s) => s.title.trim() || s.range.trim() || s.byline.trim())
 .map((s) => ({ title: s.title, byline: s.byline, range: s.range })),
 }));
 if (!payload.length) { note.textContent = t('Keep at least one campaign.'); return; }
 const parsed = normalizeCampaigns(payload);
 if (parsed.error) { note.textContent = parsed.error; return; }
 save.disabled = true;
 try {
 const out = await api.setCampaigns(parsed.campaigns);
 config.campaigns = out.campaigns || parsed.campaigns;
 rows = (out.campaigns || parsed.campaigns).map(fromApi);
 paint();
 note.className = 'form-ok';
 note.textContent = t('Saved. The Campaigns page uses this list.');
 } catch (e) {
 note.textContent = e.message || t('Could not save.');
 } finally { save.disabled = false; }
 });
 campaignsWrap.innerHTML = '';
 campaignsWrap.append(
 el('p', { class: 'muted' },
 'Each campaign is a named series. Sections are the headings on its page — title, byline, and an inclusive range of campaign numbers. ',
 el('code', {}, '1,8'), ' is levels #1 through #8. Numbers in no campaign still appear under More.'),
 list,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: () => { rows.push(blankCampaign()); paint(); } }, 'Add campaign'),
 save),
 note);
 }).catch(() => {
 campaignsWrap.innerHTML = '';
 campaignsWrap.append(el('p', { class: 'muted' }, 'Could not load campaigns.'));
 });
 }

 function renderText() {
 textWrap.innerHTML = '';
 textWrap.append(el('p', { class: 'muted' },
 'The long-form words. Saved to the database and live for everybody on their next load — no deploy. ',
 'Empty means "use the shipped default". ',
 el('b', {}, 'Bodies take a little markup:'), ' **bold**, [[Space]] or [[Ctrl+Z]] for a key, [label](/keys) for a link.'));
 let group = null;
 for (const c of CONTENT) {
 if (c.group !== group) { group = c.group; textWrap.append(el('h3', { class: 'admin-text-group' }, group)); }
 const area = el('textarea', {
 class: 'input admin-text-area' + (c.rich ? ' tall' : ''),
 rows: String(c.rich ? 6 : 2), value: '',
 });
 area.value = txt(c.key);
 const status = el('span', { class: 'muted admin-text-status' }, isOverridden(c.key) ? 'edited' : 'default');
 const save = async (text) => {
 status.textContent = 'saving…';
 try {
 const r = await api.setContent(c.key, text);
 const map = allOverrides();
 if (r.text == null) delete map[c.key]; else map[c.key] = r.text;
 setOverrides(map);
 area.value = txt(c.key);
 status.textContent = isOverridden(c.key) ? 'edited' : 'default';
 } catch (err) { status.textContent = err.message || 'could not save'; }
 };
 textWrap.append(el('div', { class: 'admin-text-row' },
 el('div', { class: 'admin-text-head' },
 el('b', {}, c.label),
 el('code', { class: 'admin-text-key' }, c.key),
 status,
 el('span', { class: 'spacer' }),
 el('button', { class: 'btn tiny', onclick: () => save(area.value) }, 'Save'),
 el('button', {
 class: 'btn tiny ghost', title: 'Put the shipped wording back',
 onclick: () => { area.value = defaultOf(c.key); save(''); },
 }, 'Reset')),
 area));
 }
 }

 // ---- Tuning: what this process is actually running on (§13.1) ----
 //
 // Read-only, and it says why: these are environment variables, so the live
 // value is whatever the process started with. A form here would be a lie
 // until the next restart.
 function renderTuning(d) {
 tuningWrap.innerHTML = '';
 // **Five columns, because a name and a number tell you what a dial is set
 // to and nothing about whether you should touch it.** The sensible span and
 // the hard clamp are different questions — one is advice, the other is what
 // the server will actually accept — so both are shown, the clamp quietly.
 const head = () => el('div', { class: 'admin-tune-row head' },
 el('span', {}, 'Variable'), el('span', {}, 'Now'), el('span', {}, 'What it does'),
 el('span', {}, 'Sensible'), el('span', {}, 'Default'));
 const rows = (title, items) => {
 const t = el('div', { class: 'admin-tune' }, head());
 for (const it of items) {
 t.append(el('div', {
 class: 'admin-tune-row' + (it.set ? ' set' : ''),
 title: it.min != null ? `${it.env} — accepted range ${it.min} to ${it.max}; anything outside is clamped` : it.env,
 },
 el('code', {}, it.env),
 el('b', {}, String(it.value)),
 el('span', { class: 'admin-tune-what' }, it.what || ''),
 el('span', { class: 'admin-tune-sane' }, it.sane || '—'),
 el('span', { class: 'muted' },
 String(it.dflt),
 it.set ? el('span', { class: 'admin-tune-flag' }, ' set') : null)));
 }
 return el('div', {}, el('h3', { class: 'admin-text-group' }, title), t);
 };
 tuningWrap.append(el('p', { class: 'muted' },
 'Set these in ', el('code', {}, 'GOLIVE.bat'), ' (live) or your shell (dev), then restart — ',
 el('code', {}, 'DEPLOY.bat'), ' does both. A value outside its range is clamped and said out loud at boot rather than obeyed. ',
 el('b', {}, 'Nothing the physics reads is here'), ': a recorded solve is a replay (§5.8), so a motor or a gravity dial would rewrite every time on the board.'));
 if (d.notes?.length) {
 tuningWrap.append(el('div', { class: 'admin-tune-notes' },
 el('b', {}, 'This process had something to say about its configuration:'),
 ...d.notes.map(n => el('div', {}, n))));
 }
 // grouped the way the dials themselves declare, so a new one lands in the
 // right place without this screen being told about it
 const groups = [...new Set(d.dials.map(x => x.group || 'Numbers'))];
 for (const g of groups) tuningWrap.append(rows(g, d.dials.filter(x => (x.group || 'Numbers') === g)));
 tuningWrap.append(rows('Switches', d.flags));
 tuningWrap.append(el('p', { class: 'muted' },
 'Running since ' + fmtDateTime(d.startedAt) + '.'));
 }
 function loadTuning() {
 api.adminTuning().then(renderTuning)
 .catch(() => { tuningWrap.append(el('p', { class: 'muted' }, 'Could not load the tuning panel.')); });
 }

 function loadUsers() {
 api.adminUsers().then(list => { allUsers = list; renderUsers(); })
 .catch(() => { usersWrap.innerHTML = ''; usersWrap.append(el('p', { class: 'muted' }, 'Could not load users.')); });
 }
 userSearch.addEventListener('input', renderUsers);

 // ---- levels: the same spreadsheet the profile uses ----
 //
 // It was a flat list of divs: no sortable columns, no way in to a level but a
 // View button, and no delete at all — so the one page whose whole job is
 // scanning and comparing was the one that could not sort. Same `sortHeader` /
 // `markSorted` / `bulkSelect` as a profile's table, so the two behave
 // identically and there is one set of rules to learn.
 //
 // Search and sort still hit the SERVER (title and comment text is not in the
 // list payload, §12); the column headers sort what came back, and the author
 // box filters it. Two sorts is not a contradiction: the server picks WHICH
 // 500, the header picks how you read them.
 let allLevels = [];
 // the column sort IS part of the remembered set — `levelPrefs.state` carries
 // it directly, so sorting by # and coming back finds the campaign in order
 const levelState = levelPrefs.state;
 const levelBulk = bulkSelect({
 noun: 'level',
 keyOf: (l) => 'id:' + l.id,
 // Admin may delete anything that is not one of the 32 campaign levels —
 // the same rule `DELETE /api/levels/:id` applies to an admin, and the same
 // one `deletableLevel` reaches on a profile.
 canDelete: (l) => !!l.id && !l.official,
 describe: (l) => `“${l.name}”${l.author ? ' by ' + l.author : ''}`,
 deleteOne: (l) => api.deleteLevel(l.id),
 onDone: () => loadLevels(),
 });
 levelBulk.onRepaint(() => refreshLevels());
 const levelHead = sortHeader(ADMIN_LEVEL_COLS, levelState, () => refreshLevels(), true, levelBulk.headBox);
 const levelBody = el('tbody', {});

 function refreshLevels() {
 const a = levelAuthor.value.trim().toLowerCase();
 // one place records the question being asked — every control routes through
 // a repaint, so saving here catches all of them without a save call per
 // listener (§8.1)
 levelState.q = levelSearch.value;
 levelState.author = levelAuthor.value;
 levelState.order = levelSort.value;
 levelState.badges = levelBadges.set;
 levelState.badgeNot = levelBadges.exclude;
 levelPrefs.save();
 const col = ADMIN_LEVEL_COLS.find(c => c.id === levelState.sort) || ADMIN_LEVEL_COLS[0];
 const list = allLevels
 .filter(l => (!a || (l.author || '').toLowerCase().includes(a))
 // a sealed race has no badges to match on — same rule as the Workshop
 && levelBadges.matches(l.sealed ? [] : l.badges)
 && matchesDone(l.id, levelState.done))
 .sort((x, y) => {
 // A row with NO value for this column sinks to the bottom whichever way
 // the sort runs. Reversing "#" should show the campaign backwards, not
 // put twenty-three levels that simply have no number above the ones that
 // do. Only a column that declares `tail` has an "unset" to sink.
 const xt = !!col.tail?.(x), yt = !!col.tail?.(y);
 if (xt !== yt) return xt ? 1 : -1;
 const av = col.get(x), bv = col.get(y);
 if (av === bv) return (y.createdAt || 0) - (x.createdAt || 0);
 return av > bv ? levelState.dir : -levelState.dir;
 });
 markSorted(levelHead, ADMIN_LEVEL_COLS, levelState);
 levelBulk.setShown(list);
 levelBody.innerHTML = '';
 for (const l of list) {
 const tr = el('tr', { class: 'solve-tr' },
 levelBulk.cell(l),
 el('td', { class: 'n' }, campaignNumCell(l, () => loadLevels())),
 el('td', { class: 'name' },
 l.official ? el('span', { class: 'chip-official' }, '★ ') : null,
 // straight through to the level, which is what a name in a list of
 // levels should do
 el('a', { href: '/play/' + encodeURIComponent(l.id) }, l.name || '(untitled)'),
 l.listed === false ? el('span', { class: 'muted' }, ' [unlisted]') : null),
 el('td', { class: 'who' },
 l.author ? el('a', { href: '/user/' + encodeURIComponent(l.author) }, l.author)
 : el('span', { class: 'muted' }, 'anonymous')),
 el('td', { class: 'n' }, String(l.plays || 0)),
 el('td', { class: 'n' }, String(l.solves || 0)),
 el('td', { class: 'n' }, l.rating != null ? `${l.rating.toFixed(1)} (${l.ratingCount})` : '—'),
 el('td', { class: 'n' }, l.difficulty != null ? `${l.difficulty.toFixed(1)} (${l.difficultyCount})` : '—'),
 // The FULL set with ghosts, exactly as a Workshop card wears it: the
 // empty slots are the interesting half here — they say what nobody has
 // managed on this level yet. A sealed race has no solves to have earned
 // anything, so it gets none rather than a row of nine ghosts.
 el('td', { class: 'badges' }, l.sealed ? el('span', { class: 'muted' }, '—')
 : badgeRow(l.badges, 'solve-badges', { tiny: true, ghostNote: 'no solve has managed this yet' })),
 el('td', { class: 'n muted' }, l.createdAt ? timeAgo(l.createdAt) : ''),
 el('td', { class: 'act' },
 // the vis dropdown for a NON-official level — an admin re-files any
 // of them; officials stay public and offer no dial to say otherwise
 l.official ? null
 : levelStakeLocked(l) ? el('span', { class: 'muted', 'data-tip-1line': '', 'data-tip': 'Live challenge — visibility locked until it closes' }, '⚔')
 : visSelect(visLabel(l),
 'Where this level lives — public, unlisted (link only) or private',
 async (v) => { await api.updateLevel(l.id, { visibility: v }); loadLevels(); }),
 el('a', { class: 'btn tiny', href: '/maker/official/' + l.id, title: 'Edit this level in place, saving directly (admin — works on any level, not just officials)' }, '✏'),
 deleteLevelButton(l, () => loadLevels())),
 );
 hoverThumb(tr, () => levelThumbContent(l));
 levelBody.append(tr);
 }
 if (!list.length) {
 levelBody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(ADMIN_LEVEL_COLS.length + 2) }, 'No levels match.')));
 }
 levelBulk.refresh();
 const tilesOn = levelState.view === 'tiles';
 levelTableWrap.classList.toggle('hidden', tilesOn);
 levelTiles.classList.toggle('hidden', !tilesOn);
 if (tilesOn) {
 levelBulk.bar.classList.add('hidden');
 fillTiles(levelTiles, list, 'No levels match.',
 (l) => levelCard(l, { showFeature: true, onFeatured: loadLevels, showEdit: true, corner: doneStarCorner(l) }));
 }
 }
 let levelLoadT = null;
 function loadLevels() {
 api.levels({ sort: levelSort.value, q: levelSearch.value.trim() || undefined })
 .then(list => { allLevels = list; refreshLevels(); })
 .catch(() => {
 levelBody.innerHTML = '';
 levelBody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(ADMIN_LEVEL_COLS.length + 2) }, 'Could not load levels.')));
 });
 }
 levelSearch.addEventListener('input', () => { clearTimeout(levelLoadT); levelLoadT = setTimeout(loadLevels, 250); });
 levelAuthor.addEventListener('input', refreshLevels);
 // **The dropdown and the column headers are the same question and must give
 // the same answer.** The select orders the SERVER's list; the headers order it
 // again locally in `refreshLevels`, and the local one always won — so picking
 // "# order" fetched a perfectly numbered list and then threw it away, leaving
 // the table in Saved order. It read as `– – – – 1 12 11 10 9 8`, which is not
 // a sort anybody asked for. The bug was always there; the # column is just the
 // first thing that made it legible.
 //
 // Choosing a sort now sets both, so the header arrow always marks the column
 // the table is actually in. # goes ASCENDING — a campaign reads 1, 2, 3 —
 // while the counts and dates go descending, where "most" and "newest" are what
 // you opened the tab to see.
 const LEVEL_SORT_COL = { new: ['at', -1], top: ['rating', -1], played: ['plays', -1], slot: ['slot', 1], alpha: ['name', 1] };
 levelSort.addEventListener('change', () => {
 const [id, dir] = LEVEL_SORT_COL[levelSort.value] || LEVEL_SORT_COL.new;
 levelState.sort = id;
 levelState.dir = dir;
 loadLevels();
 });
 levelTableWrap.append(el('table', { class: 'solve-table' }, el('thead', {}, levelHead), levelBody));
 levelsWrap.append(levelBulk.bar, levelTableWrap, levelTiles);

 // ---- solves: the same again, and the link opens THE SOLVE ----
 //
 // Fetched once (an admin sees private ones too) and worked client-side. The
 // 150-row cap is gone with the div list: a real table scrolls in its own box,
 // and an admin filtering for a player's runs wants all of them, not the first
 // 150 by date.
 let allSolves = [];
 const solveState = solvePrefs.state;
 const solveBulk = bulkSelect({
 noun: 'solve',
 keyOf: (s) => `${s.levelId}:${s.id}`,
 canDelete: (s) => !!s.levelId && !!s.id,
 describe: (s) => `${s.by || 'anonymous'} on ${s.levelName || 'a level'}`,
 deleteOne: (s) => api.deleteSolve(s.levelId, s.id),
 onDone: () => loadSolves(),
 });
 solveBulk.onRepaint(() => renderSolves());
 const solveHead = sortHeader(ADMIN_SOLVE_COLS, solveState, () => renderSolves(), true, solveBulk.headBox);
 const solveBody = el('tbody', {});

 function renderSolves() {
 const q = solveFilter.value.trim().toLowerCase();
 solveState.q = solveFilter.value;
 solveState.badges = solveBadges.set;
 solveState.badgeNot = solveBadges.exclude;
 solvePrefs.save();
 const col = ADMIN_SOLVE_COLS.find(c => c.id === solveState.sort) || ADMIN_SOLVE_COLS[0];
 const list = allSolves
 .filter(s => (!q || (s.levelName || '').toLowerCase().includes(q) || (s.name || '').toLowerCase().includes(q) || (s.by || '').toLowerCase().includes(q))
 // same derivation the row's own badge cell uses, so the filter can
 // never disagree with what the table shows
 && solveBadges.matches(computeBadges(s)))
 .sort((x, y) => {
 const av = col.get(x), bv = col.get(y);
 if (av === bv) return (y.at || 0) - (x.at || 0);
 return av > bv ? solveState.dir : -solveState.dir;
 });
 markSorted(solveHead, ADMIN_SOLVE_COLS, solveState);
 solveBulk.setShown(list);
 solveBody.innerHTML = '';
 for (const s of list) {
 const tr = el('tr', { class: 'solve-tr' + (s.won ? '' : ' attempt') },
 solveBulk.cell(s),
 // the run itself, not its level — the same click-through a profile's
 // solves table has
 el('td', { class: 'name' }, solveLink(s) || el('span', { class: 'muted' }, s.levelName || '(deleted level)')),
 el('td', { class: 'name' }, s.name ? s.name : el('span', { class: 'muted' }, s.won ? 'untitled' : 'attempt')),
 el('td', { class: 'who' },
 s.by ? el('a', { href: '/user/' + encodeURIComponent(s.by) }, s.by)
 : el('span', { class: 'muted' }, 'anonymous')),
 el('td', { class: 'n' }, s.won ? fmtTime(s.time) : el('span', { class: 'muted' }, 'attempt')),
 el('td', { class: 'n' }, s.won ? String(s.pieces ?? '') : ''),
 el('td', { class: 'n' }, s.won ? fmtKg(s.kg) : ''),
 el('td', { class: 'badges' }, badgeRow(computeBadges(s), 'solve-badges', { tiny: true })),
 // the same dropdown the profile rows carry — an admin may re-file
 // anyone's run (the route has always allowed it; the tap is new)
 visCell(solveVisLabel(s), 'run', s.challengeId, async (v) => {
 await api.setSolveVisibility(s.levelId, s.id, v);
 s.public = v === 'public'; s.unlisted = v === 'unlisted' || undefined;
 renderSolves();
 }, s.challengeId ? ['public'] : null),
 el('td', { class: 'n muted' }, s.at ? timeAgo(s.at) : ''),
 // the row's own ✕ as well as the bulk bar, so one-off culls need no
 // selection — and the header's actions column has a cell under it
 el('td', { class: 'act' }, deleteSolveButton(s.levelId, s, () => loadSolves())),
 );
 hoverThumb(tr, () => solveThumbContent(s));
 solveBody.append(tr);
 }
 if (!list.length) {
 solveBody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(ADMIN_SOLVE_COLS.length + 2) }, 'No solves match.')));
 }
 solveBulk.refresh();
 const tilesOn = solveState.view === 'tiles';
 solveTableWrap.classList.toggle('hidden', tilesOn);
 solveTiles.classList.toggle('hidden', !tilesOn);
 if (tilesOn) {
 solveBulk.bar.classList.add('hidden');
 fillTiles(solveTiles, list, 'No solves match.', solveCard);
 }
 }
 function loadSolves() {
 api.adminSolves().then(list => { allSolves = list; renderSolves(); })
 .catch(() => {
 solveBody.innerHTML = '';
 solveBody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(ADMIN_SOLVE_COLS.length + 2) }, 'Could not load solves.')));
 });
 }
 solveFilter.addEventListener('input', renderSolves);
 solveTableWrap.append(el('table', { class: 'solve-table' }, el('thead', {}, solveHead), solveBody));
 solvesWrap.append(solveBulk.bar, solveTableWrap, solveTiles);
}

// ---------- moderation ----------

// Available to isModerator too, not just isAdmin — admins reach the exact
// same page via the same route (§13: "admin has every moderator power").
function moderationScreen() {
 document.title = 'Moderation — LIFIRIK';
 const me = api.user();
 if (!me?.isModerator && !me?.isAdmin) {
 mainEl.append(el('div', { class: 'center-msg' },
 el('h2', {}, 'Moderators only'),
 el('p', { class: 'muted' }, 'You need to be signed in as a moderator (or admin) to see this page.')));
 return;
 }

 const wrap = el('div', { class: 'admin-users' });
 mainEl.append(
 el('h1', { class: 'page-title' }, '🚩 Moderation'),
 el('p', { class: 'muted' },
 'Comments flagged for a likely bad word, or sitting on a level with a rough average rating. ' +
 'This is a triage list, not a verdict — read each one before acting.'),
 wrap,
 );

 api.flaggedComments().then(list => {
 wrap.innerHTML = '';
 const table = el('div', { class: 'admin-user-table' });
 for (const row of list) {
 const textEl = el('p', { class: 'flagged-text' }, esc(row.text));
 const item = el('div', { class: 'admin-user-row flagged-row' },
 el('div', { class: 'flagged-body' },
 el('div', {},
 el('a', { class: 'admin-user-name', href: '/play/' + encodeURIComponent(row.levelId) }, row.levelName || '(deleted level)'),
 el('span', { class: 'muted' }, ' · ' + esc(row.author || 'anonymous') + ' · ' + timeAgo(row.at)),
 row.levelRating != null ? el('span', { class: 'muted' }, ` · level avg ${row.levelRating.toFixed(1)}★`) : null,
 ),
 textEl,
 el('div', { class: 'muted' }, row.reasons.join(', ')),
 ),
 el('button', {
 class: 'btn tiny ghost', title: 'Replace this comment\'s text with a default redaction',
 onclick: async () => {
 if (!await confirmModal('Replace this comment?',
 ['Its text becomes "What are they like!".'], { confirmLabel: 'Replace' })) return;
 try {
 const updated = await api.replaceComment(row.levelId, row.commentId);
 textEl.textContent = updated.text;
 } catch { alert('Could not replace the comment.'); }
 },
 }, '✎ Replace'),
 el('button', {
 class: 'btn tiny ghost', title: 'Remove this comment entirely',
 onclick: async () => {
 if (!await confirmModal('Remove this comment?', ['It will be deleted for good.'], { confirmLabel: 'Remove' })) return;
 try { await api.deleteComment(row.levelId, row.commentId); item.remove(); }
 catch { alert('Could not remove the comment.'); }
 },
 }, '✕ Remove'),
 );
 table.append(item);
 }
 if (!list.length) table.append(el('p', { class: 'muted' }, 'Nothing flagged right now.'));
 wrap.append(table);
 }).catch(() => { wrap.innerHTML = ''; wrap.append(el('p', { class: 'muted' }, 'Could not load flagged comments.')); });
}

// ---------- user profile ----------

async function userScreen(name) {
 document.title = name + ' — LIFIRIK';
 let p;
 try {
 p = await api.profile(name);
 } catch {
 mainEl.append(el('div', { class: 'center-msg' }, el('h2', {}, 'No such engineer')));
 return;
 }
 const isMe = api.user()?.name?.toLowerCase() === name.toLowerCase();
 const head = el('section', { class: 'profile-head' },
 el('h1', { class: 'page-title' }, crownFor(p) + p.name),
 el('p', { class: 'muted' }, tf('joined {date} · ⬡ {n} points', { date: fmtDate(p.createdAt), n: p.points }),
 el('span', { class: 'points-disclaimer' }, ' (points are worth nothing)')),
 // how hard the ground they've covered is — the crowd difficulty of the
 // levels they've beaten, which says more about a player than a solve count
 el('p', { class: 'muted profile-diff' },
 'Average difficulty solved: ',
 p.solvedDifficulty != null
 ? el('span', {
 class: 'diff-strong',
 'data-tip-1line': '',
 'data-tip': isMe
 ? tf(p.solvedDifficultyCount === 1 ? 'Mean crowd difficulty of the 1 rated level you have beaten' : 'Mean crowd difficulty of the {n} rated levels you have beaten', { n: p.solvedDifficultyCount })
 : tf(p.solvedDifficultyCount === 1 ? 'Mean crowd difficulty of the 1 rated level {who} has beaten' : 'Mean crowd difficulty of the {n} rated levels {who} has beaten', { n: p.solvedDifficultyCount, who: p.name }),
 }, `${p.solvedDifficulty.toFixed(1)} / 10 · ${difficultyWord(p.solvedDifficulty)}`)
 : el('span', {
 'data-tip-1line': '',
 'data-tip': 'Needs a solved level that somebody has rated for difficulty',
 }, '—'),
 ),
 );
 mainEl.append(head);

 // points actions
 const actions = el('div', { class: 'profile-actions' });
 if (isMe) {
 actions.append(
 el('button', {
 class: 'btn tiny',
 title: 'TEST MODE — adds 100 points, charges nothing',
 onclick: async (e) => {
 try { const r = await api.testBuy(); e.target.textContent = `⬡ +100 (now ${r.points})`; await api.me(); renderNavUser(); } catch { /* offline */ }
 },
 }, '🧪 Buy 100 points (test mode)'),
 el('button', {
 class: 'btn tiny',
 title: 'TEST MODE — grants a fake subscription: +1000 points monthly',
 onclick: async (e) => {
 try { const r = await api.testSubscribe(); e.target.textContent = `subscribed ✓ (${r.points})`; await api.me(); renderNavUser(); } catch { /* offline */ }
 },
 }, '🧪 Subscribe (test mode)'),
 el('span', { class: 'muted' }, ' No payment processor is attached. These buttons are fake by design.'),
 );
 } else if (api.user()) {
 actions.append(el('button', {
 class: 'btn tiny',
 onclick: async (e) => {
 const amt = parseInt(prompt(t('Gift how many points? (1–500)'), '10') || '0', 10);
 if (!amt) return;
 try { await api.giftPoints(p.name, amt); e.target.textContent = tf('Gifted {n} ⬡', { n: amt }); }
 catch (ex) { alert(t(ex.message)); }
 },
 }, '🎁 Gift points'));
 if (api.user()?.isAdmin) {
 actions.append(el('button', {
 class: 'btn tiny danger',
 onclick: async () => {
 const d = parseInt(prompt('Adjust points by (signed):', '0') || '0', 10);
 if (!d) return;
 try { await api.adjustPoints(p.name, d, 'admin adjust'); location.reload(); } catch (ex) { alert(ex.message); }
 },
 }, '⚖ Admin adjust'));
 actions.append(resetPasswordButton(p));
 }
 }
 mainEl.append(actions);

 // Local saves are yours and live in THIS browser, so they only ever appear on
 // your own profile — and until now they appeared nowhere at all: the Maker
 // wrote drafts and the save dialog wrote local solves, and neither had a
 // list. Merged into the same tables as the server's, tagged, and filterable,
 // because "where did I put that" shouldn't depend on remembering which.
 const localLevels = isMe ? localDraftRows() : [];
 // **Your own levels are not enough to name these.** A local save is usually
 // on somebody ELSE'S level — an official one, most often — and resolving
 // against `p.levels` alone left exactly those rows showing a raw id where the
 // level's name belongs, which is what was reported. The list endpoint carries
 // every level's name, it is one request, and the server already caches it, so
 // ask it and fall back to your own list if it fails.
 let knownLevels = p.levels;
 if (isMe && localSolveRows(p.levels).some((s) => s.levelName === s.levelId)) {
 try {
 const all = await api.levels({});
 knownLevels = [...(all?.levels || all?.items || all || []), ...p.levels];
 } catch { /* offline or refused — the id is still true, and the row still opens */ }
 }
 const localSolves = isMe ? localSolveRows(knownLevels) : [];

 // **Two tabs, Solves first.** They were stacked, Levels on top, which had the
 // page leading with the emptier half of it: everybody solves before they
 // build, and most people solve far more than they ever publish. The counts
 // ride on the tabs so the shape of somebody's profile is readable without
 // opening either one. Same machinery as the Workshop's and the admin's tab
 // bars — one `page-tabs` row, `page-panel hidden` for the panel that isn't up.
 // The points log is YOURS alone — the server only sends `pointsLog` to the
 // owner (§11.5) — so the third tab exists only on your own profile, rather
 // than appearing empty on everybody else's.
 const tabs = [
 { id: 'solves', label: 'Solves', n: localSolves.length + p.solves.length,
 body: profileSolvesSection(p, isMe, localSolves) },
 { id: 'levels', label: 'Levels', n: localLevels.length + p.levels.length,
 body: profileLevelsSection(p, isMe, localLevels) },
 ];
 if (isMe && p.pointsLog) {
 tabs.push({ id: 'points', label: 'Points', n: p.pointsLog.length, body: pointsLogSection(p) });
 }
 const tabBar = el('div', { class: 'page-tabs' });
 const panels = new Map();
 const PROFILE_TAB_KEY = 'profileTab';
 const remembered = store.get(PROFILE_TAB_KEY);
 // Solves leads, and an unknown or now-missing remembered tab falls back to
 // it — otherwise somebody who last looked at Points on their own profile
 // would land on a blank page when they open somebody else's.
 let openTab = tabs.some((t) => t.id === remembered) ? remembered : 'solves';
 const showTab = (id) => {
 openTab = id;
 store.set(PROFILE_TAB_KEY, id);
 for (const [tid, panel] of panels) panel.classList.toggle('hidden', tid !== id);
 for (const b of tabBar.children) b.classList.toggle('on', b.dataset.tab === id);
 };
 for (const t of tabs) {
 tabBar.append(el('button', { class: 'page-tab', dataset: { tab: t.id }, onclick: () => showTab(t.id) },
 t.label, el('span', { class: 'page-tab-n' }, String(t.n))));
 panels.set(t.id, el('section', { class: 'page-panel hidden' }, t.body));
 }
 mainEl.append(tabBar, ...panels.values());
 showTab(openTab);

}

// The points log, as a tab of its own (§11.5). It used to hang below both
// tables, which meant scrolling past everything you had ever built to reach
// it; the server caps the stored log at 200 and this shows all of them, since
// a tab you opened on purpose is a tab you came to read.
function pointsLogSection(p) {
 const rows = p.pointsLog || [];
 const sec = el('section', {}, el('h2', { class: 'section-title' }, tf('Points ({n})', { n: p.points })));
 if (!rows.length) {
 sec.append(el('p', { class: 'muted' }, 'Nothing yet. Points arrive for signing in, for solving, and from other people.'));
 return sec;
 }
 const log = el('div', { class: 'points-log' });
 for (const row of rows) {
 log.append(el('div', { class: 'points-row muted' },
 // the sign is the whole story of a row, so it leads and it is coloured
 el('span', { class: 'points-delta ' + (row.delta > 0 ? 'up' : 'down') },
 `${row.delta > 0 ? '+' : ''}${row.delta}`),
 // the reason is the server's own English ('daily activity', 'challenge
 // prize won') — a t() here is what lets the dictionary carry them
 ' ' + t(row.reason) + (row.by ? ' ' + tf('(by {who})', { who: row.by }) : '') + ` · ${timeAgo(row.at)}`));
 }
 sec.append(log);
 return sec;
}

// ---------- local saves (this browser only) ----------

// The Maker's drafts, as rows shaped like a level summary so one table can
// show them beside server levels.
function localDraftRows() {
 const drafts = store.get('maker.drafts', {});
 return Object.entries(drafts).map(([id, d]) => ({
 local: true,
 draftId: id,
 id: null,
 name: d.name || d.level?.name || 'Untitled draft',
 createdAt: d.savedAt || 0,
 savedAt: d.savedAt || 0,
 preview: d.level || null,
 goalObjs: d.level?.goalObjs?.length || 0,
 terrain: d.level?.terrain?.length || 0,
 }));
}

// Local solves are stored per level (`localSolves.<levelId>`), which is right
// for the level screen and useless for "what have I saved" — so they're
// gathered back up here.
// `levels` is whatever level list the caller already has in hand — on a profile
// that is your own levels. Records saved before `_localSolveRecord` carried a
// `levelName` have only an ID, and showing a raw `8XwvdyI7E3g` where a level's
// name belongs is what "local saves aren't accessible" looked like from
// outside. Resolving against a list we already hold costs nothing and fixes the
// common case (your own level) without a request per row; anything still
// unresolved keeps the id, which is at least true, and the row LINKS now, so
// one click shows you what it is.
function localSolveRows(levels = []) {
 const named = new Map((levels || []).filter(l => l?.id).map(l => [l.id, l.name]));
 const out = [];
 for (const key of store.keys()) {
 if (!key.startsWith('localSolves.')) continue;
 const levelId = key.slice('localSolves.'.length);
 for (const s of store.get(key, [])) {
 out.push({
 ...s, local: true, levelId,
 levelName: s.levelName || named.get(levelId) || levelId,
 });
 }
 }
 return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---------- profile: levels ----------

const PROFILE_LEVEL_COLS = [
 { id: 'name', label: 'Level', cls: 'name', get: (r) => (r.name || '').toLowerCase() },
 // Where is the row's COLOUR here too, and Visibility is one glyph — the same
 // pair of moves the solves table made, so the two tables still read as one
 // thing seen twice rather than two designs (§8.2).
 { id: 'vis', label: 'Visibility', head: '👁', cls: 'vis', get: (r) => visRank(r) },
 { id: 'plays', label: 'Plays', cls: 'n', get: (r) => r.plays || 0 },
 { id: 'solves', label: 'Solves', cls: 'n', get: (r) => r.solves || 0 },
 { id: 'rating', label: 'Rating', cls: 'n', get: (r) => (r.rating ?? -1) },
 { id: 'diff', label: 'Difficulty', cls: 'n', get: (r) => (r.difficulty ?? -1) },
 { id: 'at', label: 'Saved', cls: 'n', get: (r) => r.createdAt || 0 },
];

const visRank = (r) => (r.local ? 0 : r.private ? 1 : r.listed === false ? 2 : 3);
const visLabel = (r) => (r.local ? 'local' : r.private ? 'private' : r.listed === false ? 'unlisted' : 'public');
// A live stake locks the filing dial — the server refuses the change (409),
// so the dropdown must not offer it ("no change if it is currently a
// Challenge", 2026-08-07). `challenges` in a summary is live-only and a
// decided race carries its winner, so this reads straight off the row.
const levelStakeLocked = (r) => !!(r.race && !r.race.winner) || (r.challenges || []).length > 0;

// MULTI-DELETE (§13). Deleting levels one ✕ at a time is fine for one and
// miserable for twenty, which is what a session of testing leaves behind.
//
// Two rules the checkboxes inherit rather than reinvent, because a selection
// that can be made and then not acted on is the "finicky, sometimes fails"
// shape §16 is about:
//
// * only DELETABLE rows get a checkbox. `deletableLevel` is the same
// predicate `deleteLevelButton` uses, and it is the same rule the server
// enforces on `DELETE /api/levels/:id` — a public level is protected
// because deleting it deletes other people's solves with it.
// * the header box selects what you can SEE. It respects the filters above
// it, because that is what the filters are for: search "test", tick the
// header, delete the lot.
//
// Identity is a string key, not the row object: sorting and filtering rebuild
// every row, so a Set of objects would empty itself the first time you sorted.
const levelKey = (r) => (r.local ? 'local:' + r.draftId : 'id:' + r.id);

function deletableLevel(r) {
 if (r.local) return true; // a draft in this browser is yours alone
 const me = api.user();
 if (!r.id || r.official) return false;
 const unlisted = r.private || r.listed === false;
 return unlisted || !!me?.isAdmin;
}

function profileLevelsSection(p, isMe, localRows) {
 const all = [...localRows, ...p.levels];
 // remembered per table, and only on your OWN profile — someone else's page is
 // a visit, not a workspace, and inheriting your filters there would just hide
 // their levels (§8.1)
 const prefs = tablePrefs(isMe ? 'profile.levels' : 'profile.levels.guest',
 { sort: 'at', dir: -1, q: '', where: '', badges: new Set(), badgeNot: new Set(), done: '', view: 'table' });
 const state = prefs.state;
 const heading = el('h2', { class: 'section-title' }, '');
 const search = el('input', { class: 'input search', placeholder: 'Search levels…' });
 const whereSel = whereFilter();
 // A level's badges are the union over its PUBLIC solves, so filtering by one
 // asks "has anybody beaten this level that way" — and a local draft, which
 // has no solves at all, correctly drops out the moment any badge is picked.
 const badges = badgeFilter(() => paint(), [...state.badges], { exclude: [...state.badgeNot] });
 state.badges = badges.set;
 state.badgeNot = badges.exclude;
 const doneStar = triFilterBtn({
 key: 'done',
 state,
 glyph: { off: '⭐', none: '☆', yes: '⭐' },
 titles: {
 off: t('Off. Click for incomplete.'),
 none: t('Only incomplete. You have no star. Click for completed.'),
 yes: t('Only completed. You have the star. Click to turn off.'),
 },
 aria: t('Filter by whether you have completed this level'),
 onChange: () => paint(),
 });
 const view = viewToggle(state, () => paint());
 const tbody = el('tbody', {});
 const tiles = el('div', { class: 'tiles-grid hidden' });
 // the selection, and the row set it is allowed to refer to. `shown` is
 // Decided ONCE, and used for both the header column and every row. It was a
 // function called at two different times — the header is built once, the rows
 // on every repaint — so any change of answer in between left a table with tick
 // boxes and no select-all. Nothing can change it without re-rendering the
 // screen anyway (signing in re-routes), so a constant is the only
 // self-consistent choice.
 const canPick = isMe || !!api.user()?.isAdmin;
 const reload = () => route(); // simplest correct refresh after a delete
 const bulk = bulkSelect({
 noun: 'level',
 keyOf: levelKey,
 canDelete: deletableLevel,
 describe: (r) => `“${r.name}”`,
 deleteOne: async (r) => {
 if (!r.local) return api.deleteLevel(r.id);
 // a draft lives in this browser and nowhere else — no server to ask
 const drafts = store.get('maker.drafts', {});
 delete drafts[r.draftId];
 store.set('maker.drafts', drafts);
 store.del?.('autosave.draft.' + r.draftId);
 },
 onDone: reload,
 });
 bulk.onRepaint(() => paint());
 const head = sortHeader(PROFILE_LEVEL_COLS, state, () => paint(), true,
 canPick ? bulk.headBox : null);

 function paint() {
 state.q = search.value.trim().toLowerCase();
 state.where = whereSel.value;
 const col = PROFILE_LEVEL_COLS.find(c => c.id === state.sort) || PROFILE_LEVEL_COLS[0];
 const rows = all.filter((r) => {
 if (!matchesWhere(r, state.where)) return false;
 if (!badges.matches(r.badges)) return false;
 if (!matchesDone(r.id, state.done)) return false;
 if (state.q && !(r.name || '').toLowerCase().includes(state.q)) return false;
 return true;
 }).sort((a, b) => {
 const av = col.get(a), bv = col.get(b);
 if (av === bv) return (b.createdAt || 0) - (a.createdAt || 0);
 return av > bv ? state.dir : -state.dir;
 });
 markSorted(head, PROFILE_LEVEL_COLS, state);
 state.badges = badges.set; // the picking is part of the question (§8.1)
 state.badgeNot = badges.exclude;
 prefs.save();
 bulk.setShown(rows);
 heading.textContent = rows.length !== all.length
 ? tf('Levels ({n} of {m})', { n: rows.length, m: all.length })
 : tf('Levels ({n})', { n: rows.length });
 tbody.innerHTML = '';
 for (const r of rows) tbody.append(profileLevelRow(r, isMe, reload, canPick ? bulk : null));
 if (!rows.length) {
 tbody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(PROFILE_LEVEL_COLS.length + (canPick ? 2 : 1)) },
 all.length ? 'Nothing matches those filters.' : 'No levels yet.')));
 }
 bulk.refresh();
 const tilesOn = state.view === 'tiles';
 tableWrap.classList.toggle('hidden', tilesOn);
 tiles.classList.toggle('hidden', !tilesOn);
 if (tilesOn) {
 bulk.bar.classList.add('hidden');
 fillTiles(tiles, rows, all.length ? 'Nothing matches those filters.' : 'No levels yet.',
 (r) => levelCard(r, { corner: doneStarCorner(r) }));
 }
 }
 search.addEventListener('input', paint);
 whereSel.addEventListener('change', paint);
 // restore what was typed and picked last time, before the first paint
 search.value = state.q || '';
 if ([...whereSel.options].some(o => o.value === state.where)) whereSel.value = state.where;
 else state.where = '';
 const tableWrap = el('div', { class: 'solve-table-wrap' },
 el('table', { class: 'solve-table' }, el('thead', {}, head), tbody));
 paint();

 return el('section', { class: 'profile-table' },
 heading,
 el('div', { class: 'info-filters' }, search, whereSel, doneStar, badges.el, view),
 bulk.bar,
 tableWrap,
 tiles);
}

function profileLevelRow(r, isMe, reload, bulk) {
 const open = r.local
 ? el('a', { href: '/maker/' + encodeURIComponent(r.draftId) }, r.name)
 : el('a', { href: '/play/' + encodeURIComponent(r.id) }, r.name);
 const acts = [];
 if (isMe && r.local) {
 acts.push(el('a', { class: 'btn tiny', href: '/maker/' + encodeURIComponent(r.draftId) }, '✎ Open'));
 const del = el('button', { class: 'btn tiny danger', title: 'Delete this local draft — permanent, and only on this device' }, '✕');
 del.addEventListener('click', async () => {
 if (!await confirmModal('Delete this local draft?',
 [tf('“{name}” only exists in this browser — it was never saved to the server.', { name: r.name }), `This can't be undone.`])) return;
 const drafts = store.get('maker.drafts', {});
 delete drafts[r.draftId];
 store.set('maker.drafts', drafts);
 store.del?.('autosave.draft.' + r.draftId);
 reload();
 });
 acts.push(del);
 } else if (isMe) {
 // **The way back into your own level** (§11.9), and the reason the whole
 // edit-in-place path is reachable at all: without a door here, "you can
 // keep updating it" is true and unusable. Offered on every level of yours —
 // once somebody has played it the Maker still opens, it just says the
 // layout is fixed and saves the text. Officials are excluded: they belong
 // to the campaign and have the admin's own ✏ elsewhere.
 if (!r.official && !r.local) {
 acts.push(el('a', {
 class: 'btn tiny', href: '/maker/level/' + encodeURIComponent(r.id),
 title: r.settled
 ? 'Open in the Maker. People have played this one, so its layout is fixed — the name, description and hint still save.'
 : 'Open in the Maker and keep editing. Saving writes back to this same level — no new copy.',
 }, r.settled ? '✎ Details' : '✎ Edit'));
 }
 acts.push(levelChallengeAction(r));
 acts.push(deleteLevelButton(r, reload));
 }
 const tr = el('tr', { class: 'solve-tr' + (r.local ? ' local' : '') },
 bulk ? bulk.cell(r) : null,
 el('td', { class: 'name' }, open,
 r.official ? el('span', { class: 'muted' }, ' · ' + tf('campaign #{n}', { n: (r.slot || 0) + 1 })) : null),
 visCell(visLabel(r), 'level', levelStakeLocked(r) ? 'stake' : null,
 // your own server level re-files from the row; officials stay public
 // (the server refuses anyway), a local draft has nothing to re-file,
 // and a LIVE STAKE locks the dial — the ⚔ says why
 isMe && !r.local && !r.official && r.id && !levelStakeLocked(r)
 ? async (v) => { await api.updateLevel(r.id, { visibility: v }); reload(); }
 : null),
 el('td', { class: 'n' }, r.local ? '—' : String(r.plays || 0)),
 el('td', { class: 'n' }, r.local ? '—' : String(r.solves || 0)),
 el('td', { class: 'n' }, r.local ? '—' : (r.rating != null ? r.rating.toFixed(1) : '—')),
 el('td', { class: 'n' }, r.local ? '—' : (r.difficulty != null ? r.difficulty.toFixed(1) : '—')),
 el('td', { class: 'n muted' }, r.createdAt ? timeAgo(r.createdAt) : ''),
 el('td', { class: 'act' }, ...acts.filter(Boolean)),
 );
 hoverThumb(tr, () => levelThumbContent(r));
 return tr;
}

// Delete, on your own PRIVATE levels only — the server enforces the same rule.
// A public or unlisted level has been played, rated and solved by other people,
// and those solves are their work; unpublishing is the reversible step, and it
// keeps them.
// Deletable = anything that was never LISTED: private and unlisted both, plus
// local drafts (their own branch in profileLevelRow — they never reach the
// server at all). Public is the one that is protected, because deleting it
// deletes other people's solves along with it. The button has to agree with
// DELETE /api/levels/:id exactly, or it offers a delete the server refuses —
// which is the same "finicky, sometimes fails" shape as a silent no-op.
function deleteLevelButton(r, reload) {
 const me = api.user();
 if (!r.id || r.official) return null;
 const unlisted = r.private || r.listed === false;
 if (!unlisted && !me?.isAdmin) return null;
 const b = el('button', {
 class: 'btn tiny danger',
 title: tf('Delete this {vis} level — permanent', { vis: t(r.private ? 'private' : r.listed === false ? 'unlisted' : 'public') }),
 }, '✕');
 b.addEventListener('click', async () => {
 if (!await confirmModal('Delete this level?',
 [tf('“{name}” and everything saved on it will be removed for good.', { name: r.name }), `This can't be undone.`])) return;
 b.disabled = true;
 try { await api.deleteLevel(r.id); reload(); }
 catch (ex) { b.disabled = false; alert(t(ex.message || 'Could not delete that.')); }
 });
 return b;
}

// ---------- profile: solves ----------

const PROFILE_SOLVE_COLS = [
 { id: 'level', label: 'Level', cls: 'name', get: (s) => (s.levelName || '').toLowerCase() },
 // **The run's own name, as a column.** It was a grey sub-line under the level
 // name, which made it unsortable and easy to miss — and it is the only thing
 // on the row the player wrote themselves. The level's own Solves panel has
 // had a Name column all along (SOLVE_COLS); this is the same column.
 { id: 'name', label: 'Name', cls: 'solve-name', get: (s) => (s.name || '').toLowerCase() },
 // `where` (local vs server) was a column and is now the row's COLOUR — see
 // .solve-table tr.local in style.css. The filter above the table still asks
 // the question; the table no longer spends a column answering it on every
 // row when the answer is the same for almost all of them.
 { id: 'vis', label: 'Visibility', head: '👁', cls: 'vis', get: (s) => solveVisRank(s) },
 { id: 'time', label: 'Time', cls: 'n', get: (s) => (s.won && s.time != null ? s.time : Infinity) },
 { id: 'pieces', label: 'Pieces', cls: 'n', get: (s) => (s.won ? s.pieces ?? Infinity : Infinity) },
 { id: 'kg', label: 'Weight', cls: 'n', get: (s) => (s.won ? s.kg ?? Infinity : Infinity) },
 { id: 'badges', label: 'Badges', cls: 'badges', get: (s) => computeBadges(s).length },
 { id: 'at', label: 'Saved', cls: 'n', get: (s) => s.at || 0 },
];

// A link to THE SOLVE — `/play/<levelId>/<solveId>`, which `playScreen` reads
// as "open this level with that run staged to watch". Null when there is nothing
// to open: a LOCAL solve never left this browser, and the route can only stage a
// run whose machine was actually saved (`rec.solveList.find(s => s.id === … &&
// s.design)`), so an attempt with no design falls back to plain text rather than
// offering a link that lands on the level and shrugs.
function solveLink(s, label = null) {
 if (!s.levelId || !s.id) return null;
 // **A LOCAL save opens too** — `mountPlayable` stages it out of this browser,
 // so the route works even though the run never reached the server. What it
 // still can't open is a local save with no machine (an attempt) or one made
 // off a level entirely, which lands under the `scratch` key and has no level
 // to load. `copySolveLinkButton` keeps its own `s.local` guard: this URL
 // opens the run HERE and would show a stranger an empty level.
 if (s.local && (!s.design || s.levelId === 'scratch')) return null;
 return el('a', {
 href: `/play/${encodeURIComponent(s.levelId)}/${encodeURIComponent(s.id)}`,
 // "loads", because that is what opening a solve does now (§11.3) — the
 // machine arrives on the board, credited by its title card
 title: s.won ? 'Open the level with this run loaded' : 'Open the level with this attempt loaded',
 }, label ?? (s.levelName || 'this level'));
}

// ---------- hover thumbnails on the spreadsheets ----------
//
// "Thumbnails mouse over for all Level/Solve spreadsheets? Costly/slow?"
// (2026-08-07) — cheap, because both halves already exist: level rows carry
// the compact `preview` their cards are drawn from (renderPreview — no
// network at all), and every saved solve uploaded a share card that
// /og/S<id>.jpg serves with cache headers. A hover costs one cached image
// fetch at worst and a small local render at best. Mouse only (a finger has
// no hover, and the tap already opens the thing), and delayed so scrolling
// THROUGH a table doesn't strobe panels.
let hoverThumbEl = null;
let hoverThumbTimer = null;
function killHoverThumb() {
 clearTimeout(hoverThumbTimer);
 hoverThumbTimer = null;
 hoverThumbEl?.remove();
 hoverThumbEl = null;
}

// **A panel that outlives the row it belonged to is a panel stuck on screen.**
// Reported as "thumbnails do not disappear when you click through to Watch a
// level — thumbnail randomly left on screen" (2026-08-07): clicking a row
// NAVIGATES, the router empties `mainEl`, and the row is gone before it can
// fire the `mouseleave` that was the only thing tidying up. The panel lives on
// document.body, so nothing else takes it away with the page.
//
// Dismissal therefore belongs on the DOCUMENT, not only on the row — the same
// conclusion `installTooltips` reached for the same reason (§16: a rule that
// can only fire while the element still exists is a rule with a hole in it).
// `popstate` is the load-bearing one, since every in-app navigation goes
// through `go()`, which dispatches one; the pointerdown catches the press that
// STARTS a navigation before it happens; scroll/resize cover the page moving
// under a panel that was measured against a rectangle.
//
// Installed once, lazily, so no future caller of `hoverThumb` has to remember
// to arm anything — and the pending TIMER is cancelled too, or a panel that
// had not appeared yet arrives after the page it belonged to has gone.
let hoverThumbArmed = false;
function armHoverThumbDismissal() {
 if (hoverThumbArmed) return;
 hoverThumbArmed = true;
 window.addEventListener('popstate', killHoverThumb);
 window.addEventListener('pointerdown', killHoverThumb, true);
 window.addEventListener('scroll', killHoverThumb, true);
 window.addEventListener('resize', killHoverThumb);
 window.addEventListener('blur', killHoverThumb);
}

function hoverThumb(row, build) {
 armHoverThumbDismissal();
 let t = null;
 row.addEventListener('mouseenter', () => {
 clearTimeout(t);
 t = hoverThumbTimer = setTimeout(() => {
 killHoverThumb();
 const content = build();
 if (!content) return;
 hoverThumbEl = el('div', { class: 'hover-thumb' }, content);
 document.body.append(hoverThumbEl);
 const r = row.getBoundingClientRect();
 const hb = hoverThumbEl.getBoundingClientRect();
 const PAD = 8;
 // beside the row, below-right of its start; flipped above when the
 // bottom of the window would clip it
 const x = Math.max(PAD, Math.min(r.left + 60, innerWidth - hb.width - PAD));
 const y = r.bottom + 6 + hb.height > innerHeight - PAD
 ? Math.max(PAD, r.top - hb.height - 6)
 : r.bottom + 6;
 hoverThumbEl.style.left = x + 'px';
 hoverThumbEl.style.top = y + 'px';
 }, 150);
 });
 row.addEventListener('mouseleave', () => { clearTimeout(t); killHoverThumb(); });
 // a wheel-scroll slides the row out from under the panel — the panel goes
 // with the hover it belonged to
 row.addEventListener('wheel', killHoverThumb, { passive: true });
}

// The two builders. A level draws its own preview locally when the row
// carries one and falls back to its card; a solve IS its card (the machine
// is the interesting half, and only the card has it). `onerror` closes the
// panel rather than leaving a broken-image frame — old rows may predate
// cards, and that absence is not worth a placeholder.
function levelThumbContent(r) {
 if (r.preview || r.data) {
 const cv = el('canvas', { class: 'hover-thumb-canvas', width: 384, height: 216 });
 try { renderPreview(cv, r.data || r.preview); return cv; } catch { /* fall through to the card */ }
 }
 if (r.id && !r.local) {
 return el('img', { class: 'hover-thumb-img', src: '/og/L' + encodeURIComponent(r.id) + '.jpg', onerror: killHoverThumb });
 }
 return null;
}
function solveThumbContent(s) {
 if (!s.id || s.local) return null;
 return el('img', { class: 'hover-thumb-img', src: '/og/S' + encodeURIComponent(s.id) + '.jpg', onerror: killHoverThumb });
}

const solveVisRank = (s) => (s.local ? 0 : s.public === false && !s.unlisted ? 1 : s.unlisted ? 2 : 3);
const solveVisLabel = (s) => (s.local ? 'local' : s.public === false && !s.unlisted ? 'private' : s.unlisted ? 'unlisted' : 'public');

// **Where a thing lives, as one glyph.** Four states down a narrow column,
// where the words were four different widths of the same grey sentence. The
// icons are the ones each state already wore elsewhere — 💾 is the old
// `where-tag` local pill, 🔒 is the lock the visibility select talks about —
// so nothing here teaches a new vocabulary.
//
// **Every one carries its word on hover**, because an icon alone is a rebus:
// the tip is the sentence the column used to spend its width on, and it says
// what the state MEANS rather than just naming it. The noun is passed in
// because both tables share this — a level and a run are not hidden from you
// in quite the same words.
const VIS_ICONS = {
 local: { icon: '💾', tip: (n) => tf('Local — this {noun} is saved in this browser only. It never reached the server, and clearing site data loses it', { noun: t(n) }) },
 private: { icon: '🔒', tip: (n) => tf('Private — nobody but you can open this {noun}, even with the link', { noun: t(n) }) },
 unlisted: { icon: '🔗', tip: () => t('Unlisted — kept out of every list, but the direct link works for anyone you give it to') },
 public: { icon: '🌐', tip: () => t('Public — listed, searchable, and open to everyone') },
};
// The three server states as a compact select wearing the same icons the
// column always has — the dropdown half of visCell, and the admin tables'
// inline control. `current` is a label from visLabel/solveVisLabel; onChange
// gets the picked value and may throw, which puts the old value back.
function visSelect(current, tip, onChange, only = null) {
 // `only` narrows the stops to what the SERVER will actually accept — a
 // dropdown offering a move that 409s is the "finicky, sometimes fails"
 // shape §16 is about. The backing run of a live challenge is the case:
 // publishing it concedes (closes the bar, returns the stake), and nothing
 // else re-files it, so those are the only two stops it gets.
 const stops = [['public', '🌐 public'], ['unlisted', '🔗 unlisted'], ['private', '🔒 private']]
 .filter(([v]) => !only || only.includes(v) || v === current);
 const sel = el('select', { class: 'input vis-select', 'data-tip-1line': '', 'data-tip': tip },
 ...stops.map(([v, label]) => el('option', { value: v }, label)));
 sel.value = current;
 sel.addEventListener('change', async () => {
 sel.disabled = true;
 try { await onChange(sel.value); }
 catch (ex) { alert(t(ex.message || 'Could not change visibility.')); sel.value = current; sel.disabled = false; }
 });
 return sel;
}

function visCell(label, noun, challengeId, onChange, only = null) {
 const v = VIS_ICONS[label];
 // ⚔ rides alongside rather than replacing the state: a run backing a live
 // challenge is still private (that is the whole mechanism — the machine
 // stays hidden until the bar closes), so hiding one behind the other would
 // lose the fact the column exists to show.
 const tip = challengeId ? v.tip(noun) + t('. Carrying a live challenge — visibility is locked until it closes') : v.tip(noun);
 // With `onChange` the cell is EDITABLE — the dropdown, where the icon was
 // ("change Visibility with drop down on Spreadsheet for all", 2026-08-07).
 // Local stays a plain glyph: it has no server row to re-file.
 if (onChange && label !== 'local') {
 return el('td', { class: 'vis' }, visSelect(label, tip, onChange, only), challengeId ? ' ⚔' : '');
 }
 return el('td', { class: 'vis', 'data-tip-1line': '', 'data-tip': tip },
 v.icon, challengeId ? ' ⚔' : '');
}

function profileSolvesSection(p, isMe, localRows) {
 const all = [...localRows, ...p.solves];
 const prefs = tablePrefs(isMe ? 'profile.solves' : 'profile.solves.guest',
 { sort: 'at', dir: -1, q: '', where: '', status: '', badges: new Set(), badgeNot: new Set(), view: 'table' });
 const state = prefs.state;
 const heading = el('h2', { class: 'section-title' }, '');
 // The filter has always matched the run's own name as well as the level's —
 // it just had nothing to match on, because the profile payload didn't carry
 // `name` until the column needed it. The placeholder said "by level" and was
 // therefore telling the truth about a search that could only do half its job.
 const search = el('input', { class: 'input search', placeholder: 'Search levels and names…' });
 const whereSel = whereFilter();
 const badges = badgeFilter(() => paint(), [...state.badges], { exclude: [...state.badgeNot] });
 state.badges = badges.set;
 state.badgeNot = badges.exclude;
 const view = viewToggle(state, () => paint());
 const statusSel = el('select', { class: 'input' },
 el('option', { value: '' }, 'Wins & attempts'),
 el('option', { value: 'won' }, 'Wins only'),
 el('option', { value: 'attempt' }, 'Attempts only'));
 const tbody = el('tbody', {});
 const tiles = el('div', { class: 'tiles-grid hidden' });
 const reload = () => route();
 // Same rule the row's own ✕ obeys: your own solves, and a LOCAL one is yours
 // by definition since it never left this browser. `deleteSolveButton` checks
 // the same thing, and the server checks it again.
 const canPick = isMe || !!api.user()?.isAdmin;
 const bulk = bulkSelect({
 noun: 'solve',
 keyOf: (x) => (x.local ? 'local:' : 'id:') + x.levelId + ':' + x.id,
 canDelete: () => canPick,
 describe: (x) => `${x.levelName || t('a level')}${x.won ? ' — ' + fmtTime(x.time) : ' ' + t('(attempt)')}`,
 deleteOne: async (x) => {
 if (!x.local) return api.deleteSolve(x.levelId, x.id);
 const key = 'localSolves.' + x.levelId;
 store.set(key, store.get(key, []).filter(y => y.id !== x.id));
 },
 onDone: reload,
 });
 bulk.onRepaint(() => paint());
 const head = sortHeader(PROFILE_SOLVE_COLS, state, () => paint(), true,
 canPick ? bulk.headBox : null);

 function paint() {
 state.q = search.value.trim().toLowerCase();
 state.where = whereSel.value;
 state.status = statusSel.value;
 const col = PROFILE_SOLVE_COLS.find(c => c.id === state.sort) || PROFILE_SOLVE_COLS[0];
 const rows = all.filter((s) => {
 // `matchesWhere`, not a pair of inline tests — which is what this was,
 // and they asked whether `state.where === 'server'`, an option that has
 // not existed since the filter grew Private/Unlisted/Public. Local was
 // the only choice that did anything; the other three silently matched
 // everything. The levels table has always called the shared function,
 // whose own comment says it exists so the two cannot disagree.
 if (!matchesWhere(s, state.where)) return false;
 if (state.status === 'won' && !s.won) return false;
 if (state.status === 'attempt' && s.won) return false;
 if (!badges.matches(computeBadges(s))) return false;
 if (state.q && !`${s.levelName || ''} ${s.name || ''}`.toLowerCase().includes(state.q)) return false;
 return true;
 }).sort((a, b) => {
 const av = col.get(a), bv = col.get(b);
 if (av === bv) return (b.at || 0) - (a.at || 0);
 return av > bv ? state.dir : -state.dir;
 });
 markSorted(head, PROFILE_SOLVE_COLS, state);
 state.badges = badges.set;
 state.badgeNot = badges.exclude;
 prefs.save();
 bulk.setShown(rows);
 heading.textContent = rows.length !== all.length
 ? tf('Solves ({n} of {m})', { n: rows.length, m: all.length })
 : tf('Solves ({n})', { n: rows.length });
 tbody.innerHTML = '';
 for (const s of rows) tbody.append(profileSolveRow(s, isMe, reload, canPick ? bulk : null));
 if (!rows.length) {
 tbody.append(el('tr', {}, el('td', { class: 'info-empty muted', colspan: String(PROFILE_SOLVE_COLS.length + (canPick ? 2 : 1)) },
 all.length ? 'Nothing matches those filters.' : 'No solves yet.')));
 }
 bulk.refresh();
 const tilesOn = state.view === 'tiles';
 tableWrap.classList.toggle('hidden', tilesOn);
 tiles.classList.toggle('hidden', !tilesOn);
 if (tilesOn) {
 bulk.bar.classList.add('hidden');
 fillTiles(tiles, rows, all.length ? 'Nothing matches those filters.' : 'No solves yet.', solveCard);
 }
 }
 for (const c of [search]) c.addEventListener('input', paint);
 for (const c of [whereSel, statusSel]) c.addEventListener('change', paint);
 // restore last time's search and filters before the first paint
 search.value = state.q || '';
 if ([...whereSel.options].some(o => o.value === state.where)) whereSel.value = state.where;
 else state.where = '';
 statusSel.value = state.status || '';
 const tableWrap = el('div', { class: 'solve-table-wrap' },
 el('table', { class: 'solve-table' }, el('thead', {}, head), tbody));
 paint();

 return el('section', { class: 'profile-table' },
 heading,
 el('div', { class: 'info-filters' }, search, whereSel, statusSel, badges.el, view),
 bulk.bar,
 tableWrap,
 tiles);
}

// **Copy the link to a SOLUTION** (§11.10). The row already links to the run,
// but a link you can only click is a link you cannot hand to anybody: right-
// click → copy on an <a> is a thing most people never do, and the URL is what
// unfurls in Discord with the winning machine drawn on the level. Offered on
// exactly the runs that HAVE a URL — a local save never left this browser, and
// a private one is nobody else's to open.
function copySolveLinkButton(s) {
 if (!s.levelId || s.local || !s.id) return null;
 if (s.public === false && !s.unlisted) return null;
 const url = `${location.origin}/play/${encodeURIComponent(s.levelId)}/${encodeURIComponent(s.id)}`;
 const btn = el('button', { class: 'btn tiny', title: 'Copy a link to this run — it unfurls with the machine' }, '📋');
 btn.addEventListener('click', async (e) => {
 e.preventDefault();
 e.stopPropagation();
 try {
 await navigator.clipboard.writeText(url);
 btn.textContent = '✓';
 setTimeout(() => { btn.textContent = '📋'; }, 1400);
 } catch { window.prompt('Copy this link', url); }
 });
 return btn;
}

function profileSolveRow(s, isMe, reload, bulk) {
 const acts = [copySolveLinkButton(s)];
 if (isMe && s.local) {
 acts.push(localDeleteButton(s, reload));
 } else if (isMe) {
 // the profile is cross-level, so a delete here needs the level id too
 acts.push(deleteSolveButton(s.levelId, s, reload));
 // challenge action on your own private won runs (§11.8)
 const priv = s.public === false && !s.unlisted;
 if (priv && s.won && !s.challengeId) {
 acts.push(el('button', {
 class: 'btn tiny',
 title: 'Challenge others to match or beat this run — your machine stays hidden until it ends',
 onclick: () => beatMeComposer(s, () => route()),
 }, '⚔'));
 }
 }
 const tr = el('tr', { class: 'solve-tr' + (s.won ? '' : ' attempt') + (s.local ? ' local' : '') },
 bulk ? bulk.cell(s) : null,
 el('td', { class: 'name' },
 // **The link opens THE SOLVE, not the level.** `/play/<level>/<solve>`
 // loads the level with that run staged to watch — which is what a row in
 // a table of solves is about. It used to drop you on the level's front
 // page, from where finding the run you had just clicked meant scrolling a
 // list of everybody's. Only a saved server solve has a URL: a local one
 // never left this browser, and an attempt has no machine stored.
 solveLink(s) || (s.levelName || '—')),
 // the run's own name — no longer duplicated as a sub-line under the level
 el('td', { class: 'solve-name' }, s.name || el('span', { class: 'muted' }, '—')),
 visCell(solveVisLabel(s), 'run', s.challengeId,
 isMe && !s.local && s.id
 ? async (v) => { await api.setSolveVisibility(s.levelId, s.id, v); reload(); }
 : null,
 // backing a live bar: publishing is the concede and the only move the
 // server takes — so it is the only other stop offered
 s.challengeId ? ['public'] : null),
 el('td', { class: 'n' }, s.won ? fmtTime(s.time) : el('span', { class: 'muted' }, 'attempt')),
 el('td', { class: 'n' }, s.won ? String(s.pieces ?? '') : ''),
 el('td', { class: 'n' }, s.won ? fmtKg(s.kg) : ''),
 el('td', { class: 'badges' }, badgeRow(computeBadges(s), 'solve-badges', { tiny: true })),
 el('td', { class: 'n muted' }, s.at ? timeAgo(s.at) : ''),
 el('td', { class: 'act' }, ...acts.filter(Boolean)),
 );
 hoverThumb(tr, () => solveThumbContent(s));
 return tr;
}

// ---------- shared table chrome ----------

// The badge filter, in every place that searches solves or levels — the
// Workshop, the Solves screen, and both profile tables. One widget, so the
// eight badges mean the same thing and sit in the same order wherever you meet
// them, and so "filter by 💧" is a habit rather than a per-screen feature.
//
// Three clicks per badge: off → only with → only without → off. Selecting
// several "with" is an **AND**: show me runs that were wet AND untampered.
// That's the Workshop's long-standing rule and the useful one — OR would
// broaden the list with every click, which is the opposite of filtering.
//
// `matches` takes the badge ids of one row, so callers pass `r.badges` for a
// level (the union over its public solves) or `computeBadges(s)` for a solve.
// `initial` restores a remembered picking (§8.1) — an array off disk, filtered
// against the CURRENT badge list so a stored id that no longer exists (the
// retired `powered`, say) is dropped rather than sitting in the set filtering
// out everything for ever with no button to un-press it.
function badgeFilter(onChange, initial = null, opts = {}) {
 const known = new Set(BADGE_DEFS.map(b => b.id));
 const set = new Set([...(Array.isArray(initial) ? initial : [])].filter(id => known.has(id)));
 const exclude = new Set([...(Array.isArray(opts.exclude) ? opts.exclude : [])].filter(id => known.has(id)));
 for (const id of set) exclude.delete(id);
 const wrap = el('span', { class: 'badge-filter' });
 // Three clicks, every badge: off → only with → only without → off. The tip
 // is live (refreshTip) so it names the NEXT click, not a static description.
 const tipFor = (b) => {
 if (set.has(b.id)) return t(b.filterYes);
 if (exclude.has(b.id)) return t(b.filterNone);
 return t(b.filterOff);
 };
 for (const b of BADGE_DEFS) {
 const btn = el('button', {
 class: 'btn tiny badge-btn',
 'data-tip': tipFor(b),
 'data-tip-1line': '',
 'aria-label': t('Filter by ') + t(b.name),
 // the badge itself, so a negative one wears its ring here too — `tip:
 // false` because the BUTTON carries the hover and the badge's own would
 // otherwise win, being the nearer [data-tip]
 }, badgeEl(b.id, true, { tiny: true, tip: false }));
 const paint = () => {
 btn.classList.toggle('active', set.has(b.id));
 btn.classList.toggle('exclude', exclude.has(b.id));
 btn.dataset.tip = tipFor(b);
 };
 paint();
 btn.addEventListener('click', () => {
 if (set.has(b.id)) { set.delete(b.id); exclude.add(b.id); }
 else if (exclude.has(b.id)) { exclude.delete(b.id); }
 else { set.add(b.id); }
 paint();
 refreshTip();
 onChange();
 });
 wrap.append(btn);
 }
 return {
 el: wrap,
 set,
 exclude,
 matches: (ids) => {
 const have = ids || [];
 if (set.size && ![...set].every(b => have.includes(b))) return false;
 if ([...exclude].some(b => have.includes(b))) return false;
 return true;
 },
 };
}

// Where a thing lives. Only offered when there is actually something local to
// filter for — a toggle with one possible answer is furniture.
// WHERE + VISIBILITY in one dropdown, because to the person reading the table
// they are one question: "which of my things am I looking at?" Local is a place
// and private/unlisted/public are states, but they never overlap — a local
// draft has no visibility and a server row is always exactly one of the three —
// so a single list of five is honest and a pair of dropdowns was not.
const WHERE_OPTIONS = [
 ['', 'All'],
 ['local', 'Local'],
 ['private', 'Private'],
 ['unlisted', 'Unlisted'],
 ['public', 'Public'],
];

// Always all five, even when a category is currently empty. The old version
// hid "Local" whenever you had no drafts, which sounds tidy and isn't: a filter
// that appears and disappears depending on your data changes position under the
// cursor, and "there are no local ones" is an answer worth being able to ASK
// for. An empty result already says so in the table.
function whereFilter() {
 return el('select', { class: 'input' },
 ...WHERE_OPTIONS.map(([value, label]) => el('option', { value }, label)));
}

// Does a row match the where/visibility filter? One function, so the levels
// table and the solves table cannot disagree about what "unlisted" means —
// they spell their own visibility differently (`listed`/`private` on a level,
// `public`/`unlisted` on a solve), which is exactly the sort of difference
// that grows two subtly different filters if it is written out twice.
function matchesWhere(row, where) {
 if (!where) return true;
 if (where === 'local') return !!row.local;
 if (row.local) return false; // a draft has no visibility
 const vis = row.public !== undefined
 ? (row.public ? 'public' : row.unlisted ? 'unlisted' : 'private') // solve
 : (row.private ? 'private' : row.listed === false ? 'unlisted' : 'public'); // level
 return vis === where;
}

// Search text, filters and sort, remembered per table (§8.1). Coming back to
// your own profile and finding it sorted the way you left it is the whole of
// it; losing a search you just typed because you clicked into a level and came
// back is the thing it fixes. Stored under one key per table, and merged over
// the defaults so a stored value from an older shape can never break a screen.
function tablePrefs(key, defaults) {
 const saved = store.get('prefs.' + key, null);
 const state = { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
 // **Badge pickings are Sets in memory and arrays on disk, and the way BACK
 // is the half that was missing.** `save` already flattened a Set to an
 // array; nothing rebuilt one, so a table whose default was a Set got a bare
 // array from storage and every `.has()` on it threw. Restoring here means a
 // caller declares `new Set()` as its default and simply gets a Set, whatever
 // the disk holds — including the older shape from before badges were
 // remembered at all.
 for (const k of Object.keys(defaults)) {
 if (defaults[k] instanceof Set) state[k] = new Set(Array.isArray(state[k]) ? state[k] : [...(state[k] || [])]);
 }
 return {
 state,
 save() {
 const out = {};
 for (const k of Object.keys(defaults)) {
 out[k] = state[k] instanceof Set ? [...state[k]] : state[k];
 }
 store.set('prefs.' + key, out);
 },
 };
}

// One clickable header row for a column table (same look and behaviour as the
// Solves screen's — see SOLVE_COLS for why columns are declared once).
// ---------- bulk select + delete, for any of the spreadsheets ----------
//
// Written ONCE and used by all three tables (a profile's levels, a profile's
// solves, and both admin lists), because three copies of a destructive control
// is how one of them ends up with a rule the others don't have — the same
// argument that put the label schema and the level lists in one place each.
//
// The caller supplies four things and gets back the parts to hang in its table:
//
// keyOf(row) a STRING identity. Not the row object: sorting and
// filtering rebuild every row, so a Set of objects empties
// itself the first time a column header is clicked.
// canDelete(row) the same predicate the row's own ✕ uses, which must be the
// same rule the server enforces — a box that can be ticked
// for something the server will refuse is the "finicky,
// sometimes fails" shape (§16). Rows it rejects get an EMPTY
// cell, not a disabled box.
// deleteOne(row) async; throw to report a failure, which is then NAMED.
// describe(row) what to call it in the confirm dialog.
//
// `setShown(rows)` is called from the table's paint with whatever the filters
// left on screen. Selection is pruned to that set, so the bar can never offer to
// delete something you are not looking at, and the header box means "these".
function bulkSelect({ keyOf, canDelete, deleteOne, describe, noun = 'item', onDone }) {
 const picked = new Set();
 let shown = [];
 const headBox = el('input', {
 type: 'checkbox', class: 'row-pick', title: tf('Select every {noun} here that can be deleted', { noun: t(noun) }),
 });
 const bar = el('div', { class: 'bulk-bar hidden' });

 const pickable = () => shown.filter(canDelete);
 const chosen = () => shown.filter(r => picked.has(keyOf(r)) && canDelete(r));

 // Three states, because two would lie: none, some, all — of what is
 // selectable in the CURRENT list. `indeterminate` is the honest middle.
 function syncHead() {
 const rows = pickable();
 const n = rows.filter(r => picked.has(keyOf(r))).length;
 headBox.disabled = rows.length === 0;
 headBox.checked = rows.length > 0 && n === rows.length;
 headBox.indeterminate = n > 0 && n < rows.length;
 }

 function paintBar() {
 const n = chosen().length;
 bar.classList.toggle('hidden', n === 0);
 // emptied even when hiding: a display:none bar still holding "20 selected"
 // is a stale count waiting to flash up the next time something is ticked
 bar.textContent = '';
 if (!n) return;
 const del = el('button', { class: 'btn tiny danger' }, tf('✕ Delete {n} selected', { n }));
 del.addEventListener('click', () => run(del));
 bar.append(
 el('span', {}, tf('{n} selected', { n })),
 del,
 el('button', { class: 'btn tiny ghost', onclick: () => { picked.clear(); refresh(); } }, 'Clear'));
 }

 function refresh() { syncHead(); paintBar(); }

 // Sequential on purpose: these are writes behind a rate limiter, and a burst
 // of thirty parallel DELETEs starts being refused halfway through — the worst
 // possible moment, since some are already gone. One at a time, counted, and
 // whatever failed is named rather than left to be discovered.
 async function run(btn) {
 const rows = chosen();
 if (!rows.length) return;
 const names = rows.slice(0, 6).map(describe).join(', ');
 const more = rows.length > 6 ? tf(' and {n} more', { n: rows.length - 6 }) : '';
 if (!await confirmModal(tf('Delete {n} {noun}?', { n: rows.length, noun: t(rows.length > 1 ? noun + 's' : noun) }),
 [`${names}${more}.`, `This can't be undone.`],
 { confirmLabel: tf('Delete {n}', { n: rows.length }) })) return;
 btn.disabled = true;
 let gone = 0;
 const failed = [];
 for (const r of rows) {
 try { await deleteOne(r); picked.delete(keyOf(r)); gone++; }
 catch (ex) { failed.push(`${describe(r)}: ${t(ex.message || 'refused')}`); }
 }
 if (failed.length) {
 alert(tf('Deleted {gone} of {n}.', { gone, n: rows.length }) + '\n\n' + t('These were refused:') + '\n' + failed.join('\n'));
 }
 onDone?.();
 }

 headBox.addEventListener('change', () => {
 const rows = pickable();
 if (headBox.checked) for (const r of rows) picked.add(keyOf(r));
 else for (const r of rows) picked.delete(keyOf(r));
 refresh();
 // the row boxes are rebuilt by the caller's paint; ask for one
 onRepaint?.();
 });
 let onRepaint = null;

 return {
 headBox,
 bar,
 onRepaint: (fn) => { onRepaint = fn; },
 // called from the table's paint, with what the filters left on screen
 setShown(rows) {
 shown = rows;
 for (const k of [...picked]) if (!rows.some(r => keyOf(r) === k)) picked.delete(k);
 },
 // the <td> for one row — empty when the row can't be deleted
 cell(row) {
 if (!canDelete(row)) return el('td', { class: 'pick' });
 const key = keyOf(row);
 const box = el('input', { type: 'checkbox', class: 'row-pick', title: 'Select for bulk delete' });
 box.checked = picked.has(key);
 box.addEventListener('change', () => {
 if (box.checked) picked.add(key); else picked.delete(key);
 refresh();
 });
 return el('td', { class: 'pick' }, box);
 },
 refresh,
 };
}

// `pickBox` prepends a select-all column. It is NOT a sortable header — clicking
// it must toggle the boxes, not re-sort the table under the hand that is about
// to tick them.
function sortHeader(cols, state, onSort, withActions, pickBox = null) {
 const tr = el('tr', {});
 if (pickBox) tr.append(el('th', { class: 'pick' }, pickBox));
 for (const c of cols) {
 // `head` is what the column SHOWS, `label` is what it is CALLED. The same
 // for every column that fits a word; the split exists so a column narrow
 // enough to be an icon (Visibility → 👁) still says "Sort by Visibility"
 // on hover rather than "Sort by 👁".
 const th = el('th', { class: c.cls, title: tf('Sort by {col}', { col: t(c.label) }) }, c.head ?? c.label, el('span', { class: 'sort-mark' }));
 th.addEventListener('click', () => {
 if (state.sort === c.id) state.dir = -state.dir;
 else { state.sort = c.id; state.dir = c.id === 'at' ? -1 : 1; }
 onSort();
 });
 tr.append(th);
 }
 if (withActions) tr.append(el('th', { class: 'act' }, ''));
 return tr;
}

function markSorted(headRow, cols, state) {
 for (const th of headRow.children) th.classList.remove('sorted-up', 'sorted-down');
 const i = cols.findIndex(c => c.id === state.sort);
 if (i < 0) return;
 // The arrow is placed by POSITION, and a select-all column shifts every
 // header along by one — so the offset is measured rather than assumed. Read
 // off the row itself (not from a flag passed in) so this cannot drift from
 // whatever `sortHeader` actually built.
 const off = headRow.children[0]?.classList.contains('pick') ? 1 : 0;
 headRow.children[i + off]?.classList.add(state.dir > 0 ? 'sorted-up' : 'sorted-down');
}

// The challenge action on your own level rows. Only a PRIVATE level can become
// a timed challenge — it has to be sealed before the clock starts, so anything
// already published or unlisted has been seen and can't be a mystery.
//
// **It is styled like the delete button beside it, and that is the fix for a
// real bug.** These buttons began life on Workshop CARDS, where they were
// absolutely positioned in the corner and revealed by `.card:hover` — and when
// they moved to the profile TABLE, the markup came with them and the CSS did
// not. On a table row there is no `.card` ancestor, so the hover rule could
// never match and the button sat at `opacity: 0` forever; there is no
// positioned ancestor either, so had it ever shown, `position: absolute` would
// have parked it in the top-left corner of the page. The feature worked
// perfectly and was invisible — reachable only by tabbing to it — which is why
// it read as "there is no option to make a timed challenge".
//
// The lesson is §16's "a condition that enumerates every case by naming the
// only one that exists": the reveal named an ANCESTOR the button no longer had.
// A plain `btn tiny`, exactly like the ✕ next to it, cannot go stale that way.
function levelChallengeAction(rec) {
 if (rec.official) return null;
 if (rec.race) {
 if (rec.race.winner || rec.race.openedAt) return null; // opened: no going back
 return [
 el('button', {
 class: 'btn tiny chal-sealed',
 title: tf('Opens {when} · 🏅{prize} — click to call it off and get the stake back', { when: fmtDateTime(rec.race.revealAt), prize: rec.race.prize }),
 onclick: async (e) => {
 e.preventDefault(); e.stopPropagation();
 if (!await confirmModal('Call off this timed challenge?',
 ['Your stake comes back and the level stays private.'], { confirmLabel: 'Call it off' })) return;
 try { await api.cancelRace(rec.id); route(); } catch (ex) { alert(t(ex.message || 'Could not cancel.')); }
 },
 }, '🏁 sealed'),
 // **And the message, from here specifically.** A sealed race's card is
 // deliberately not clickable (§11.8) — even for its own author, since the
 // list payload is the teaser for everybody — so the details panel that
 // carries the other copy of this button cannot be reached by clicking.
 // This row is the only place the person who set it will find it.
 el('button', {
 class: 'btn tiny',
 title: cleanMessage(rec.race.message)
 ? 'Rewrite the line shown with the countdown'
 : 'Add a line of your own, shown with the countdown',
 onclick: (e) => {
 e.preventDefault(); e.stopPropagation();
 messageComposer(rec.race, (text) => api.setRaceMessage(rec.id, text), () => route());
 },
 }, cleanMessage(rec.race.message) ? '✎' : '✎ message'),
 ];
 }
 if (!rec.private) return null;
 return el('button', {
 class: 'btn tiny',
 title: 'Turn this private level into a timed challenge — it opens for everyone at a moment you pick',
 onclick: (e) => { e.preventDefault(); e.stopPropagation(); raceComposer(rec, () => route()); },
 }, '🏁 challenge');
}

// ---------- challenge composers (§11.8) ----------
//
// Both live here, on the profile, and not in the save dialogs they used to be
// bolted to. Setting a challenge is a decision about work you already have —
// made once you know the level is worth somebody's evening, or that the run is
// worth beating — and asking it at save time asked it at the one moment you
// knew least. Saving is just saving now; this is the afterthought it always
// should have been.

// Are you sure? — the app's own, never `window.confirm`.
//
// **This is a bug fix, not a restyle.** `confirm()` is the browser's dialog,
// not ours, and the browser is allowed to take it away: after a couple of them
// Chrome offers "prevent this page from creating additional dialogs", and once
// that is ticked EVERY later confirm() returns `false` instantly and silently
// for the life of the page. Every one of these guards a delete written as
// `if (!confirm(...)) return;` — so the button goes dead, with no dialog, no
// error and no clue, and the report is "the ✕ doesn't work". Reproduced here:
// a real click on a local draft's ✕ did nothing at all, while calling the same
// handler with confirm stubbed to true deleted it correctly.
//
// A dialog we own cannot be suppressed, matches the rest of the app, and can
// say what is about to happen in more than one line. Resolves true/false, and
// resolves FALSE on every dismissal route (Cancel, the backdrop, Escape) so a
// caller can never hang waiting for an answer that isn't coming.
function confirmModal(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
 return new Promise((resolve) => {
 let done = false;
 const finish = (v) => { if (!done) { done = true; resolve(v); } };
 const overlay = modal(title, (body, close) => {
 const go = el('button', { class: 'btn ' + (danger ? 'danger' : 'primary') }, confirmLabel);
 go.addEventListener('click', () => { finish(true); close(); });
 appendAll(body,
 ...(Array.isArray(message) ? message : [message]).map(m => el('p', {}, m)),
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: () => { finish(false); close(); } }, 'Cancel'),
 go));
 go.focus();
 });
 // the backdrop click and Escape both close it without answering — that is
 // a "no", and it has to resolve or the caller waits forever
 overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) finish(false); });
 const onKey = (e) => {
 if (e.key === 'Escape') { finish(false); overlay.remove(); }
 if (!document.body.contains(overlay)) document.removeEventListener('keydown', onKey);
 };
 document.addEventListener('keydown', onKey);
 });
}

function modal(title, build) {
 const overlay = el('div', { class: 'modal-overlay' });
 const box = el('div', { class: 'modal' }, el('h3', {}, title));
 const body = el('div', { class: 'modal-body' });
 box.append(body);
 overlay.append(box);
 const close = () => overlay.remove();
 overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
 build(body, close);
 document.body.append(overlay);
 return overlay;
}

// local time in, epoch ms out — a `datetime-local` value has no zone, so it
// must be read back through the same local frame the user typed it in
const localDatetimeValue = (d) =>
 new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// The challenge message field, identical in both composers (§11.8) — one line
// in the challenger's own words, shown with the countdown wherever the
// challenge is.
//
// **`maxlength` is a courtesy, not the rule.** The server runs `cleanMessage`
// over whatever arrives and stores what comes out, so a paste that beats the
// attribute is truncated rather than refused; this just means the counter is
// telling the truth while you type. The live count is over CODE POINTS, the
// same way the cap counts them, or a message made of emoji would read as full
// at half the length it is.
// Rewrite (or add, or clear) the line on a challenge you already set. Takes a
// `save` rather than ids, because the two kinds live at different routes and
// the dialog does not care which one it is looking at.
//
// **Empty is a legitimate answer**, so the button says "Save" rather than
// "Set": clearing it is how you take back something you would rather not have
// said, and refusing an empty field would leave withdrawing the whole challenge
// as the only way out.
function messageComposer(c, save, onDone) {
 modal('✎ Challenge message', (body, close) => {
 const said = messageField('Who is gunna do this first!');
 said.input.value = cleanMessage(c.message);
 said.refresh();
 const errEl = el('p', { class: 'form-error' });
 appendAll(body,
 el('p', { class: 'muted' },
 'Shown with the countdown wherever this challenge appears, and in the popup with the full terms. ',
 'The terms themselves stay exactly as you set them — this is only what you said.'),
 said.el,
 said.note,
 errEl,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: close }, 'Cancel'),
 el('button', {
 class: 'btn primary',
 onclick: async (e) => {
 e.target.disabled = true;
 errEl.textContent = '';
 try { await save(said.value()); }
 catch (ex) {
 e.target.disabled = false;
 errEl.textContent = t(ex.message || 'Could not save that.');
 return;
 }
 close();
 (onDone || (() => location.reload()))();
 },
 }, 'Save')));
 said.input.focus();
 });
}

function messageField(placeholder) {
 const input = el('input', {
 class: 'input', maxlength: String(MESSAGE_MAX), placeholder,
 });
 const note = el('div', { class: 'chip-note muted' });
 const refresh = () => {
 const left = MESSAGE_MAX - [...cleanMessage(input.value)].length;
 note.textContent = input.value.trim()
 ? tf(left === 1 ? '1 character left.' : '{n} characters left.', { n: left })
 : t('Optional — it shows with the countdown, and the full terms come up on hover.');
 };
 input.addEventListener('input', refresh);
 refresh();
 return {
 el: el('label', { class: 'field' }, 'Challenge message', input),
 note,
 // exposed so the edit dialog can seed an existing message and re-count it
 input,
 refresh,
 value: () => cleanMessage(input.value),
 };
}

function raceComposer(rec, onDone) {
 const u = api.user();
 const when = new Date(Date.now() + 24 * 3600 * 1000);
 when.setMinutes(0, 0, 0);
 modal('🏁 Turn this into a timed challenge', (body, close) => {
 const at = el('input', { class: 'input', type: 'datetime-local', value: localDatetimeValue(when) });
 const said = messageField('Who is gunna do this first!');
 const prize = el('input', { class: 'input', type: 'number', min: '1', max: '500', step: '1', value: '1' });
 const note = el('div', { class: 'chip-note muted' });
 const errEl = el('p', { class: 'form-error' });
 const refresh = () => {
 const ms = Date.parse(at.value);
 note.textContent = !Number.isFinite(ms) ? t('Pick a date and time.')
 : ms <= Date.now() ? t('That moment has already passed.')
 : tf('Sealed for {t}, then everyone gets it at once.', { t: fmtCountdown(ms - Date.now()) });
 };
 at.addEventListener('input', refresh);
 refresh();
 appendAll(body,
 el('p', { class: 'muted' },
 // NOT esc() — el() appends this through createTextNode, so escaping it
 // here shows a level called "Bob's Barn" as "Bob&#39;s Barn"
 tf('"{name}" stays sealed — no preview, no description, nobody can open it — until the moment you pick. ', { name: rec.name }),
 'Then it publishes for everyone at the same instant, and the first solved run saved publicly takes it.'),
 el('label', { class: 'field' }, 'Opens at (your local time)', at),
 note,
 said.el,
 said.note,
 el('label', { class: 'field' }, tf('Prize (points — you have {n}; a token, worth nothing)', { n: u?.points ?? 0 }), prize),
 errEl,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: close }, 'Cancel'),
 el('button', {
 class: 'btn primary',
 onclick: async (e) => {
 e.target.disabled = true;
 errEl.textContent = '';
 const ms = Date.parse(at.value);
 if (!Number.isFinite(ms)) { e.target.disabled = false; errEl.textContent = t('Pick a reveal time.'); return; }
 try {
 await api.makeRace(rec.id, { revealAt: ms, prize: parseInt(prize.value, 10) || 1, message: said.value() });
 } catch (ex) {
 e.target.disabled = false;
 errEl.textContent = t(ex.message || 'Could not set that challenge.');
 return;
 }
 close();
 onDone?.();
 },
 }, 'Set the challenge'),
 ),
 );
 });
}

// Admin-only, on a user's profile (§13). The other recovery path is
// `scripts/set-password.mjs`, which needs the server stopped and a shell — this
// is the same operation for the ordinary case of somebody just forgetting.
//
// **Generated by default, and shown exactly once.** The field is there because
// an admin sometimes needs a password they can say out loud down a phone, but
// leaving it blank is the better answer and is what the button does on its own:
// `generatePassword()` is unambiguous read aloud (no l/1/I, no O/0) and worth
// ~62 bits. Once the modal closes the password is gone — what is stored is a
// scrypt hash over a fresh salt, and nothing can read it back.
function resetPasswordButton(p) {
 return el('button', {
 class: 'btn tiny danger',
 title: `Give ${p.name} a new password — signs them out everywhere, and the new one is shown once`,
 onclick: () => modal(`🔑 Reset ${p.name}'s password`, (body, close) => {
 const pw = el('input', { class: 'input', maxlength: 200, placeholder: 'Leave blank to generate a strong one' });
 const errEl = el('p', { class: 'form-error' });
 const go = el('button', { class: 'btn primary' }, 'Reset it');
 go.addEventListener('click', async () => {
 go.disabled = true;
 errEl.textContent = '';
 let r;
 try {
 r = await api.adminResetPassword(p.name, pw.value.trim() || undefined);
 } catch (ex) {
 go.disabled = false;
 errEl.textContent = ex.message || 'Could not reset that password.';
 return;
 }
 // THE ONE SHOWING. Replace the whole dialog rather than adding to it,
 // so there is no "Reset it" button left to press twice and no doubt
 // about which password is the live one.
 body.textContent = '';
 const copy = el('button', { class: 'btn tiny' }, 'Copy');
 copy.addEventListener('click', async () => {
 try { await navigator.clipboard.writeText(r.password); copy.textContent = 'Copied ✓'; }
 catch { copy.textContent = 'Select it and copy'; }
 });
 appendAll(body,
 el('p', {}, `${esc(p.name)}'s password is now:`),
 el('div', { class: 'reveal-row' }, el('code', { class: 'reveal-code' }, r.password), copy),
 el('p', { class: 'muted' },
 'This is the only time it is shown — the database keeps a hash of it and nothing can read it back. ',
 r.signedOut
 ? `Signed out of ${r.signedOut} live session${r.signedOut === 1 ? '' : 's'}.`
 : 'They had no live sessions to sign out.'),
 el('div', { class: 'modal-actions' }, el('button', { class: 'btn primary', onclick: close }, 'Done')));
 });
 appendAll(body,
 el('p', { class: 'muted' },
 `Gives ${esc(p.name)} a new password and signs them out everywhere`,
 api.user()?.name === p.name ? ' except this tab' : '',
 '. There is no self-service reset and no mail is ever sent, so you will have to hand it over yourself.'),
 el('label', { class: 'field' }, 'New password (optional)', pw),
 errEl,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: close }, 'Cancel'), go));
 }),
 }, '🔑 Reset password');
}

function beatMeComposer(solve, onDone) {
 const u = api.user();
 const mineRank = badgeRank(solve);
 modal('⚔ Match me? Beat me?', (body, close) => {
 const use = {
 time: el('input', { type: 'checkbox', checked: true }),
 pieces: el('input', { type: 'checkbox', checked: true }),
 kg: el('input', { type: 'checkbox' }),
 };
 const val = {
 time: el('input', { class: 'input', type: 'number', step: '0.01', min: String(solve.time ?? 0), value: String(Math.round((solve.time ?? 0) * 100) / 100) }),
 pieces: el('input', { class: 'input', type: 'number', step: '1', min: String(solve.pieces | 0), value: String(solve.pieces | 0) }),
 kg: el('input', { class: 'input', type: 'number', step: '0.1', min: String(solve.kg ?? 0), value: String(Math.round((solve.kg ?? 0) * 10) / 10) }),
 };
 const row = (key, label) => el('label', { class: 'chip-row' }, use[key], el('span', { class: 'chip-label' }, label), val[key]);
 // only the ranks this run actually reached — the rest would be refused
 const badgeSel = el('select', { class: 'input' },
 ...BADGE_RANKS.slice(0, mineRank + 1).map((id, i) =>
 el('option', { value: String(i) }, i === 0 ? 'Any machine' : (badgeDef(id)?.name || id))));
 badgeSel.value = '0';
 const nailed = el('input', { type: 'checkbox', disabled: !solve.nailedIt });
 const boom = el('input', { type: 'checkbox', disabled: !solve.boomerang });
 const sweep = el('input', { type: 'checkbox', disabled: !solve.sweep });
 // A MONTH by default, which is also the server's ceiling
 // (BEATME_MAX_WINDOW, 30 days). A bar is a standing invitation rather than
 // an event — nobody is watching a clock on it, and the thing that ends it
 // is almost always somebody beating it rather than time running out. At a
 // day the common outcome was a challenge quietly expiring before anyone
 // who'd enjoy it happened to look at the level.
 const days = el('input', { class: 'input', type: 'number', min: '0', max: '30', value: '30' });
 const hours = el('input', { class: 'input', type: 'number', min: '0', max: '23', value: '0' });
 // Defaulting AT the ceiling makes one thing possible that wasn't before:
 // 30 days plus any hours at all is over the limit, so the composer would
 // post a request the server refuses. The note is the same live readout the
 // race composer has, and it makes the boundary visible instead of turning
 // a nudge of the hours field into a 400.
 const MAX_RUN_HOURS = 30 * 24;
 const runNote = el('div', { class: 'chip-note muted' });
 const runHours = () => (parseInt(days.value, 10) || 0) * 24 + (parseInt(hours.value, 10) || 0);
 const runError = () => {
 const h = runHours();
 if (h <= 0) return t('Pick how long it runs — 15 minutes at the very least.');
 if (h > MAX_RUN_HOURS) return tf('Too long — {n} days is the maximum.', { n: MAX_RUN_HOURS / 24 });
 return null;
 };
 const refreshRun = () => {
 const bad = runError();
 runNote.textContent = bad || tf('Runs for {t} — ends {when}.', { t: fmtCountdown(runHours() * 3600 * 1000), when: fmtDateTime(Date.now() + runHours() * 3600 * 1000) });
 runNote.classList.toggle('muted', !bad);
 };
 days.addEventListener('input', refreshRun);
 hours.addEventListener('input', refreshRun);
 refreshRun();
 const said = messageField('Who is gunna beat this!');
 const prize = el('input', { class: 'input', type: 'number', min: '1', max: '500', value: '1' });
 const errEl = el('p', { class: 'form-error' });
 appendAll(body,
 el('p', { class: 'muted' },
 tf('Your run on {level}: {time} · {n} pcs · {kg}. ', { level: solve.levelName, time: fmtTime(solve.time), n: solve.pieces, kg: fmtKg(solve.kg) }),
 'Set the bar at or below it — others match or beat it without seeing your machine, ',
 'and when the challenge ends your solution publishes either way.'),
 el('div', { class: 'chip-label' }, 'They must be at or under'),
 row('time', 'Time'), row('pieces', 'Pieces'), row('kg', 'Weight'),
 // **Setting nothing is a choice, not an omission.** The server used to
 // refuse a challenge with no terms; on a level nobody has published a
 // win on, finishing it at all IS the bar, and it is the hardest one that
 // level has. Said here because a form with every box unticked otherwise
 // reads as unfinished.
 el('div', { class: 'chip-note muted' },
 'Leave everything below unset and the challenge is simply to solve it — '
 + 'which only stands while nobody has published a win here.'),
 el('label', { class: 'field' }, 'Machine must be at least', badgeSel),
 el('label', { class: 'check' }, nailed, 'Must also earn Nailed It', solve.nailedIt ? '' : ' (your run didn\'t)'),
 el('label', { class: 'check' }, boom, 'Must also earn Boomerang', solve.boomerang ? '' : ' (your run didn\'t)'),
 el('label', { class: 'check' }, sweep, 'Must also earn Sweep', solve.sweep ? '' : ' (your run didn\'t)'),
 el('div', { class: 'chip-row' }, el('span', { class: 'chip-label' }, 'Runs for'), days, el('span', {}, 'days'), hours, el('span', {}, 'hours')),
 runNote,
 said.el,
 said.note,
 el('label', { class: 'field' }, tf('Prize (points — you have {n}; a token, worth nothing)', { n: u?.points ?? 0 }), prize),
 errEl,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: close }, 'Cancel'),
 el('button', {
 class: 'btn primary',
 onclick: async (e) => {
 e.target.disabled = true;
 errEl.textContent = '';
 // caught here rather than by the server, so the ceiling reads as a
 // limit on the field instead of a rejected post
 const runBad = runError();
 if (runBad) { e.target.disabled = false; errEl.textContent = runBad; return; }
 const bars = {};
 for (const key of ['time', 'pieces', 'kg']) if (use[key].checked) bars[key] = Number(val[key].value);
 try {
 await api.postChallenge(solve.levelId, {
 solveId: solve.id, bars,
 badge: parseInt(badgeSel.value, 10) || 0,
 nailedIt: nailed.checked, boomerang: boom.checked, sweep: sweep.checked,
 days: parseInt(days.value, 10) || 0,
 hours: parseInt(hours.value, 10) || 0,
 prize: parseInt(prize.value, 10) || 1,
 message: said.value(),
 });
 } catch (ex) {
 e.target.disabled = false;
 errEl.textContent = t(ex.message || 'Could not post that challenge.');
 return;
 }
 close();
 onDone?.();
 },
 }, 'Post the challenge'),
 ),
 );
 });
}

// ---------- auth modal ----------

function authModal(mode) {
 const overlay = el('div', { class: 'modal-overlay' });
 const nameIn = el('input', { class: 'input', placeholder: 'Name', maxlength: 20, autocomplete: 'username' });
 const passIn = el('input', { class: 'input', placeholder: 'Password (4+ characters)', type: 'password', autocomplete: mode === 'register' ? 'new-password' : 'current-password' });
 // Optional: there's no password reset and no mail is ever sent, so it exists
 // purely so an admin has a way to reach an account holder.
 const emailIn = mode === 'register'
 ? el('input', { class: 'input', placeholder: 'Email (optional)', type: 'email', autocomplete: 'email', maxlength: 120 })
 : null;
 const err = el('p', { class: 'form-error' });
 const submit = async () => {
 err.textContent = '';
 try {
 if (mode === 'register') await api.register(nameIn.value.trim(), passIn.value, emailIn.value.trim());
 else await api.login(nameIn.value.trim(), passIn.value);
 overlay.remove();
 renderNavUser();
 route();
 } catch (ex) {
 err.textContent = t(ex.message || 'That didn\'t work.');
 }
 };
 passIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
 const box = el('div', { class: 'modal' },
 el('h3', {}, mode === 'register' ? 'Join LIFIRIK' : 'Sign in'),
 el('div', { class: 'modal-body' },
 el('p', { class: 'muted' }, mode === 'register'
 ? 'Accounts are optional — they add attribution, a public profile, and saved machines you can reach from any device.'
 : 'Welcome back, engineer.'),
 el('label', { class: 'field' }, 'Name', nameIn),
 el('label', { class: 'field' }, 'Password', passIn),
 emailIn ? el('label', { class: 'field' }, 'Email', emailIn) : null,
 err,
 el('div', { class: 'modal-actions' },
 el('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
 el('button', { class: 'btn primary', onclick: submit }, mode === 'register' ? 'Create account' : 'Sign in'),
 // invite-only: no route from the sign-in form to a sign-up form that
 // the server would only refuse
 (config.registrationOpen || mode === 'register') ? el('button', {
 class: 'btn ghost',
 onclick: () => { overlay.remove(); authModal(mode === 'register' ? 'login' : 'register'); },
 }, mode === 'register' ? 'I have an account' : 'I\'m new here') : null,
 )),
 );
 overlay.append(box);
 overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) overlay.remove(); });
 document.body.append(overlay);
 nameIn.focus();
}
