// audio.js — every sound in the game, synthesised. No asset files.
//
// Nothing here is a recording. Impacts, stingers and the rolling bed are all
// built from oscillators and one shared noise buffer, for four reasons that all
// pointed the same way:
//
//  - there is no build step and `dist/` must stay self-contained; the only
//    vendored binary in the project is the wasm, and it earns its place;
//  - a physics game's impacts want to be CONTINUOUS in the impact speed. A
//    gentle nudge and a 17 m/s crash are the same voice at two ends of a dial,
//    which is what a sample set cannot do without a dozen velocity layers;
//  - the same reasoning that made the terrain textures procedural (§10.2);
//  - no licensing, no attribution, no download.
//
// ---------------------------------------------------------------------------
// Import safety
// ---------------------------------------------------------------------------
// Seven of the nine verify suites run under node with no WebAudio at all, and
// `game.js` imports this module unconditionally. So NOTHING here touches
// `window`, `document` or `AudioContext` at import time — the context is built
// lazily by `initAudio()`, which browsers only permit from a user gesture
// anyway. Every play function is a no-op until then, and stays a no-op forever
// under node. That is a hard rule: a module-scope `new AudioContext()` would
// take the whole test suite down.
import { store, clamp } from './util.js';
import { MAT } from './surfaces.js';

// ---------------------------------------------------------------------------
// What can be switched off, and what it sounds like
// ---------------------------------------------------------------------------

// Four independent sections. Someone who wants the machine to sound like a
// machine but finds interface clicks fussy should get exactly that, so these
// are checkboxes rather than one master switch with a volume.
export const SOUND_SECTIONS = {
  impacts: { name: 'Impacts', hint: 'pieces landing, hitting and colliding — the loudest and most useful layer' },
  motion: { name: 'Motion', hint: 'the rolling bed and motor hum while a machine runs' },
  stingers: { name: 'Outcomes', hint: 'solved, goal lost, swept, and a badge earned' },
  ui: { name: 'Interface', hint: 'placing, deleting and undoing in the editor' },
};
export const SECTION_KEYS = Object.keys(SOUND_SECTIONS);

// Five voicings of the same events. A theme never changes WHICH sounds play or
// when — only what they sound like — so switching is safe mid-session and
// needs no reload.
//
// Each theme has its own SYNTHESIS ROUTINE (`style`, dispatched in playImpact
// and the stingers), not a parameter set fed to one shared routine. The first
// version did the latter — three scalings of the same noise-plus-tone burst —
// and the play-tested verdict was that they were "too similar", which they
// were, structurally: no gain knob turns a knock into an arpeggio. The knobs
// that remain (`pitch`, `gain`, `wave`) season the interface blips and
// stingers; the impact CHARACTER lives in the per-style functions below.
export const SOUND_THEMES = {
  physical: {
    name: 'Physical', style: 'physical',
    hint: 'Real materials: wood knocks, metal rings, mud thuds, bright ticks on ice. Quiet and short — stays out of the way over a long session.',
    pitch: 1, gain: 0.9, wave: 'triangle',
  },
  arcade: {
    name: 'Arcade', style: 'chip',
    hint: '8-bit. Impacts are square-wave zaps that dive in pitch, harder hits start higher; the win is a proper chiptune arpeggio.',
    pitch: 1.2, gain: 0.9, wave: 'square',
  },
  toy: {
    name: 'Music box', style: 'music',
    hint: 'Every impact is a note on a pentatonic scale — what it hits picks the note, how hard picks the loudness. A busy machine plays itself a tune.',
    pitch: 1, gain: 0.85, wave: 'sine',
  },
  heavy: {
    name: 'Heavy', style: 'heavy',
    hint: 'Industrial. A deep sub-thump under every landing, clang on metal, rumble on stone — machines feel twice their weight.',
    pitch: 0.9, gain: 1, wave: 'triangle',
  },
  drums: {
    name: 'Drum kit', style: 'drum',
    hint: 'Impacts are percussion: soft ground is the kick drum, crates are the snare, ice and metal are hi-hats. A collapsing machine is a drum fill.',
    pitch: 1, gain: 0.95, wave: 'triangle',
  },
};
export const THEME_KEYS = Object.keys(SOUND_THEMES);
export const DEFAULT_THEME = 'physical';

// ---------------------------------------------------------------------------
// Materials → timbre
// ---------------------------------------------------------------------------
// WHAT a thing is made of is surfaces.js's `MAT`, tagged onto every shape at
// construction and read back off a collision. What that SOUNDS like is here.
//
// Base voice per material, before the theme scales it. `noise` is the body of
// the impact (a band of filtered noise), `tone` the pitched part that tells you
// what it was. `ring` > 1 lengthens the tone relative to the noise, which is
// the whole difference between a knock and a clang.
const VOICE = {
  [MAT.STONE]: { hz: 1300, q: 1.1, dur: 0.085, tone: 190, ring: 0.7, lp: false },
  [MAT.ICE]: { hz: 4600, q: 3.5, dur: 0.055, tone: 2100, ring: 0.8, lp: false },
  [MAT.METAL]: { hz: 3000, q: 7, dur: 0.30, tone: 620, ring: 2.6, lp: false },
  [MAT.WOOD]: { hz: 950, q: 2.2, dur: 0.10, tone: 300, ring: 0.9, lp: false },
  [MAT.SOFT]: { hz: 380, q: 0.8, dur: 0.09, tone: 110, ring: 0.4, lp: true },
  [MAT.RUBBER]: { hz: 700, q: 1.6, dur: 0.16, tone: 240, ring: 1.4, lp: true, bend: -0.45 },
  [MAT.GLASS]: { hz: 6200, q: 5, dur: 0.09, tone: 2600, ring: 1.2, lp: false },
  [MAT.PROP]: { hz: 1000, q: 2, dur: 0.10, tone: 280, ring: 0.9, lp: false },
  [MAT.GOAL]: { hz: 1500, q: 2.4, dur: 0.11, tone: 430, ring: 1.1, lp: false },
  [MAT.WHEEL]: { hz: 620, q: 1.4, dur: 0.11, tone: 200, ring: 0.8, lp: true, bend: -0.3 },
  [MAT.ROD]: { hz: 1100, q: 2.6, dur: 0.09, tone: 340, ring: 0.8, lp: false },
  [MAT.WATER]: { hz: 2400, q: 0.9, dur: 0.13, tone: 0, ring: 0, lp: false },
};

// Which of the two shapes in a collision names the sound. The SURFACE wins:
// hitting ice should sound icy whatever hit it, and terrain is the thing a
// player is aiming at. Between two loose pieces the higher id wins, which puts
// goal pieces and wheels above generic props — arbitrary but stable, and a
// coin-flip per frame would make one collision sound like two different things.
const TERRAIN_MATS = new Set([MAT.STONE, MAT.ICE, MAT.METAL, MAT.WOOD, MAT.SOFT, MAT.RUBBER, MAT.GLASS]);
export function impactMaterial(a, b) {
  const av = VOICE[a] ? a : MAT.STONE, bv = VOICE[b] ? b : MAT.STONE;
  const aT = TERRAIN_MATS.has(av), bT = TERRAIN_MATS.has(bv);
  if (aT !== bT) return aT ? av : bv;
  return Math.max(av, bv);
}

// ---------------------------------------------------------------------------
// Settings (pure — the settings screen and the gates read these with no context)
// ---------------------------------------------------------------------------

export const SOUND_DEFAULTS = {
  on: true,
  volume: 0.7,
  theme: DEFAULT_THEME,
  sections: { impacts: true, motion: true, stingers: true, ui: true },
};

// Read-and-repair: anything missing, misspelled or out of range falls back
// rather than reaching the engine. These values come out of localStorage, which
// is user-editable and survives across versions where a theme may have been
// renamed or a section added.
export function soundSettings() {
  const raw = store.get('sound', null) || {};
  const sections = {};
  for (const k of SECTION_KEYS) {
    sections[k] = typeof raw.sections?.[k] === 'boolean' ? raw.sections[k] : SOUND_DEFAULTS.sections[k];
  }
  return {
    on: typeof raw.on === 'boolean' ? raw.on : SOUND_DEFAULTS.on,
    volume: typeof raw.volume === 'number' && isFinite(raw.volume)
      ? clamp(raw.volume, 0, 1) : SOUND_DEFAULTS.volume,
    theme: SOUND_THEMES[raw.theme] ? raw.theme : DEFAULT_THEME,
    sections,
  };
}

export function setSoundSettings(patch) {
  const next = { ...soundSettings(), ...patch };
  if (patch.sections) next.sections = { ...soundSettings().sections, ...patch.sections };
  store.set('sound', next);
  applySettings(next);
  return next;
}

const enabled = (s, section) => s.on && s.sections[section];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let ctx = null;         // null until a user gesture; stays null under node
let master = null;      // volume
let bus = null;         // limiter — a collapsing machine must not clip
let noiseBuf = null;
let voices = 0;         // rough count of sounding voices, for the cap
let motion = null;      // the continuous rolling/motor bed, built on demand

const MAX_VOICES = 14;  // beyond this a pile-up is mud, not detail

export const audioReady = () => !!ctx;

// Build the context. Safe to call repeatedly and safe to call under node (it
// returns false). Browsers refuse to start audio outside a user gesture, so
// game.js calls this from the first pointerdown.
export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
  if (typeof window === 'undefined') return false;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  try {
    ctx = new AC();
  } catch { return false; }
  bus = ctx.createDynamicsCompressor();
  bus.threshold.value = -14;
  bus.knee.value = 12;
  bus.ratio.value = 8;
  bus.attack.value = 0.003;
  bus.release.value = 0.12;
  master = ctx.createGain();
  bus.connect(master);
  master.connect(ctx.destination);
  // one second of white noise, reused by every impact — generating a buffer per
  // hit would allocate megabytes over a long session
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  applySettings(soundSettings());
  return true;
}

function applySettings(s) {
  if (!master) return;
  master.gain.setTargetAtTime(s.on ? s.volume : 0, ctx.currentTime, 0.02);
  if (motion && !enabled(s, 'motion')) motionSet(0, 0, 0);
}

// An audio track for the clip recorder (§11.11) — the SAME signal the player
// hears, tapped after the limiter and the volume, so a clip sounds like the
// session did (muted game = silent clip, which is what "record what I see"
// means). Null when audio never started: MediaRecorder treats a missing track
// as video-only, so the caller just skips it.
export function audioCaptureTrack() {
  if (!ctx || !master) return null;
  const dest = ctx.createMediaStreamDestination();
  master.connect(dest);
  const track = dest.stream.getAudioTracks()[0] || null;
  // the tap holds a graph edge alive; hand the caller a way to cut it when
  // the recording stops, or every clip leaks a destination node
  return track ? { track, stop: () => { try { master.disconnect(dest); } catch { /* already gone */ } } } : null;
}

// Suspend/resume with the tab, so a backgrounded game is silent and cheap.
export function setAudioSuspended(quiet) {
  if (!ctx) return;
  if (quiet && ctx.state === 'running') ctx.suspend();
  else if (!quiet && ctx.state === 'suspended') ctx.resume();
}

// ---------- primitives ----------

const now = () => ctx.currentTime;

function panner(x) {
  // x is -1..1; StereoPannerNode is not in every engine, so fall back to silence
  // of opinion rather than to an exception.
  if (!ctx.createStereoPanner) return null;
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(x, -1, 1);
  return p;
}

// One voice: a burst of filtered noise, an optional pitched body, one envelope.
function burst({ hz, q, dur, tone, ring, lp, bend = 0, gain, pan, wave, toneGain, delay = 0 }) {
  const t = now() + delay;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(gain, t + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  const p = panner(pan);
  if (p) { out.connect(p); p.connect(bus); } else out.connect(bus);

  // noise body
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = lp ? 'lowpass' : 'bandpass';
  f.frequency.setValueAtTime(hz, t);
  f.Q.value = q;
  if (bend) f.frequency.exponentialRampToValueAtTime(Math.max(60, hz * (1 + bend)), t + dur);
  src.connect(f); f.connect(out);
  src.start(t);
  src.stop(t + dur + 0.02);

  // pitched body — what tells you it was metal and not stone
  if (tone > 0 && ring > 0 && toneGain > 0) {
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(tone, t);
    if (bend) o.frequency.exponentialRampToValueAtTime(Math.max(30, tone * (1 + bend)), t + dur * ring);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(gain * toneGain, t + 0.003);
    og.gain.exponentialRampToValueAtTime(0.0006, t + dur * ring);
    o.connect(og); og.connect(out);
    o.start(t);
    o.stop(t + dur * ring + 0.02);
    o.onended = () => { voices--; };
  } else {
    src.onended = () => { voices--; };
  }
  voices++;
}

// A short pitched note, for stingers and interface sounds.
function blip({ freq, dur = 0.09, gain = 0.2, wave = 'triangle', to = 0, delay = 0, pan = 0, attack = 0.008 }) {
  const t = now() + delay;
  const o = ctx.createOscillator();
  o.type = wave;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
  o.connect(g);
  const p = pan ? panner(pan) : null;
  if (p) { g.connect(p); p.connect(bus); } else g.connect(bus);
  o.start(t);
  o.stop(t + dur + 0.02);
  voices++;
  o.onended = () => { voices--; };
}

// ---------- impacts ----------

// `speed` is the approach speed Box2D reported, in m/s. HIT_FLOOR matches the
// world's hit-event threshold; HIT_FULL is about the speed of a piece dropped
// from the top of a tall level, so the range covers what actually happens
// rather than what is theoretically possible.
const HIT_FLOOR = 1.2;
const HIT_FULL = 14;

// ---------- the five impact voices, one per theme style ----------
//
// Uniform signature (v, m, n, pan, th): the material's base voice, the
// material id, the 0..1 normalised impact, the stereo position, the theme.
// Loudness everywhere rises fast at the quiet end and flattens — a 12 m/s
// crash is not ten times the crash of 1.2 m/s, it is about twice as loud and
// much brighter/deeper depending on the style.

// Real materials: filtered-noise body + a pitched tone that names the material.
function impactPhysical(v, m, n, pan, th) {
  const amp = 0.06 + 0.34 * Math.pow(n, 0.65);
  const bright = 1 + 0.5 * n;   // harder hits ring brighter and shorter
  burst({
    hz: v.hz * bright, q: v.q, dur: v.dur * (1.25 - 0.35 * n),
    tone: v.tone, ring: v.ring, lp: v.lp, bend: v.bend || 0,
    gain: amp * th.gain, pan, wave: th.wave, toneGain: v.tone ? 0.5 : 0,
  });
}

// 8-bit: a square zap that dives in pitch. The material picks the note (soft
// things low, glassy things high), the impact speed raises the whole zap.
const CHIP_SEMIS = {
  [MAT.SOFT]: 0, [MAT.STONE]: 2, [MAT.WOOD]: 4, [MAT.PROP]: 5, [MAT.RUBBER]: 7,
  [MAT.WHEEL]: 7, [MAT.ROD]: 9, [MAT.GOAL]: 11, [MAT.METAL]: 12,
  [MAT.WATER]: 14, [MAT.GLASS]: 16, [MAT.ICE]: 19,
};
function impactChip(v, m, n, pan, th) {
  const f0 = 220 * Math.pow(2, (CHIP_SEMIS[m] ?? 2) / 12) * (1 + n) * th.pitch;
  blip({ freq: f0, to: f0 * 0.3, dur: 0.08 + 0.06 * n,
    gain: (0.09 + 0.20 * n) * th.gain, wave: 'square', pan, attack: 0.002 });
  // a tick of noise on the front, or every zap sounds like a laser
  burst({ hz: 3200, q: 1, dur: 0.018, tone: 0, ring: 0, lp: false,
    gain: (0.04 + 0.08 * n) * th.gain, pan, wave: 'square', toneGain: 0 });
}

// Music box: every impact is a note on the major pentatonic — the material is
// the note, the speed is the velocity. A busy machine plays itself a tune.
const PENTA = [0, 2, 4, 7, 9];
function impactMusic(v, m, n, pan, th) {
  const f = 294 * Math.pow(2, (PENTA[m % 5] + 12 * (m % 3)) / 12) * th.pitch;
  const g = (0.05 + 0.22 * Math.pow(n, 0.7)) * th.gain;
  blip({ freq: f, dur: 0.45 + 0.4 * n, gain: g, wave: 'sine', pan });
  blip({ freq: f * 3, dur: 0.15, gain: g * 0.22, wave: 'sine', pan });   // mallet partial
  burst({ hz: 850, q: 0.7, dur: 0.03, tone: 0, ring: 0, lp: true,
    gain: g * 0.35, pan, wave: 'sine', toneGain: 0 });                    // felt thump
}

// Industrial: a sub thump under everything, with the material's own voice
// lowered and lengthened on top. Machines feel twice their weight.
function impactHeavy(v, m, n, pan, th) {
  const g = (0.09 + 0.33 * Math.pow(n, 0.7)) * th.gain;
  blip({ freq: 85 + 45 * n, to: 34, dur: 0.26 + 0.22 * n, gain: g, wave: 'sine', pan, attack: 0.004 });
  burst({ hz: Math.max(200, v.hz * 0.45), q: v.q, dur: v.dur * 1.6,
    tone: v.tone * 0.5, ring: v.ring * 1.5, lp: true, bend: -0.2,
    gain: g * 0.45, pan, wave: 'triangle', toneGain: v.tone ? 0.6 : 0 });
}

// Drum kit: the material picks the drum. Soft ground and stone are the kick,
// crates and sticks the snare, ice/glass/metal the hi-hat, wheels a tom.
function impactDrum(v, m, n, pan, th) {
  const g = (0.09 + 0.30 * Math.pow(n, 0.65)) * th.gain;
  if (m === MAT.ICE || m === MAT.GLASS || m === MAT.METAL) {
    burst({ hz: 8200, q: 0.6, dur: 0.05 + 0.05 * n, tone: 0, ring: 0, lp: false,
      gain: g * 0.7, pan, wave: 'square', toneGain: 0 });                 // hat
  } else if (m === MAT.SOFT || m === MAT.STONE || m === MAT.RUBBER) {
    blip({ freq: 105 + 55 * n, to: 42, dur: 0.16, gain: g * 1.25, wave: 'sine', pan, attack: 0.003 }); // kick
  } else if (m === MAT.WHEEL) {
    blip({ freq: 175, to: 95, dur: 0.18, gain: g, wave: 'sine', pan, attack: 0.003 });                 // tom
  } else {
    burst({ hz: 1800, q: 0.5, dur: 0.11, tone: 0, ring: 0, lp: false,
      gain: g * 0.8, pan, wave: 'triangle', toneGain: 0 });               // snare wires
    blip({ freq: 195, to: 160, dur: 0.09, gain: g * 0.5, wave: 'triangle', pan });   // snare body
  }
}

const IMPACT_STYLES = {
  physical: impactPhysical, chip: impactChip, music: impactMusic,
  heavy: impactHeavy, drum: impactDrum,
};

export function playImpact({ speed, matA, matB, pan = 0 }) {
  const s = soundSettings();
  if (!ctx || !enabled(s, 'impacts')) return false;
  if (!(speed > HIT_FLOOR)) return false;
  if (voices > MAX_VOICES) return false;
  const th = SOUND_THEMES[s.theme];
  const m = impactMaterial(matA, matB);
  const v = VOICE[m] || VOICE[MAT.STONE];
  const n = clamp((speed - HIT_FLOOR) / (HIT_FULL - HIT_FLOOR), 0, 1);
  (IMPACT_STYLES[th.style] || impactPhysical)(v, m, n, pan, th);
  return true;
}

// ---------- the continuous bed: rolling and motor ----------
//
// Ceiling gains for the two wheel voices. Down to 15% of their first values
// (0.16 / 0.05) over two rounds of play-testing: everything else in the mix is
// transient, so a bed that merely sits level with an impact ends up dominating
// simply by never stopping. It should be felt rather than listened to.
//
// These are the whole "how loud are the wheels" control — nothing else in the
// game feeds the bed, since `roll` comes from wheel rim speed and `motor` from
// powered wheels only, both via sim.wheelMotion().
const ROLL_GAIN = 0.024;
const MOTOR_GAIN = 0.0075;

function motionBuild() {
  const t = now();
  // rolling: band-passed noise whose centre rises with speed
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 320;
  f.Q.value = 0.9;
  const rollGain = ctx.createGain();
  rollGain.gain.value = 0;
  src.connect(f); f.connect(rollGain); rollGain.connect(bus);
  src.start(t);
  // motor: a low saw, only for powered wheels
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 60;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const motGain = ctx.createGain();
  motGain.gain.value = 0;
  o.connect(lp); lp.connect(motGain); motGain.connect(bus);
  o.start(t);
  motion = { src, f, rollGain, o, motGain };
}

// Called every rendered frame while a machine runs. `roll` and `motor` are
// 0..1; `pitch` is a speed factor. Everything is a setTargetAtTime glide, never
// a jump — stepping a gain per frame is what makes engine sounds buzz.
function motionSet(roll, motor, pitch) {
  if (!motion) return;
  const t = now();
  motion.rollGain.gain.setTargetAtTime(roll * ROLL_GAIN, t, 0.05);
  motion.f.frequency.setTargetAtTime(300 + 900 * pitch, t, 0.06);
  motion.motGain.gain.setTargetAtTime(motor * MOTOR_GAIN, t, 0.06);
  motion.o.frequency.setTargetAtTime(48 + 70 * pitch, t, 0.06);
}

export function playMotion({ roll = 0, motor = 0, pitch = 0 } = {}) {
  const s = soundSettings();
  if (!ctx) return;
  if (!enabled(s, 'motion')) { if (motion) motionSet(0, 0, 0); return; }
  if (!motion) motionBuild();
  const th = SOUND_THEMES[s.theme];
  motionSet(clamp(roll, 0, 1), clamp(motor, 0, 1), clamp(pitch, 0, 1) * th.pitch);
}

export function stopMotion() { if (motion) motionSet(0, 0, 0); }

// ---------- stingers and interface ----------

const SCALE = [0, 4, 7, 12, 16, 19];   // major triad stack, so any subset agrees

// One phrase per outcome PER STYLE, not one melody re-waved. The phrase is a
// list of blips: [semitones-or-freq, delay, dur, gain, wave]. Styles missing an
// entry fall back to the physical phrase, so adding a theme never silences an
// outcome.
const seq = (steps) => (th, g) => steps.forEach(([f, d, dur, gn, wave, to]) => blip({
  freq: f, delay: d, dur, gain: gn * g, wave, to: to || 0,
}));
// drum voices, reused by the drum stingers
const kick = (d, g) => blip({ freq: 120, to: 42, dur: 0.15, gain: 0.30 * g, wave: 'sine', delay: d, attack: 0.003 });
const snare = (d, g) => { burst({ hz: 1800, q: 0.5, dur: 0.11, tone: 0, ring: 0, lp: false, gain: 0.22 * g, pan: 0, wave: 'triangle', toneGain: 0, delay: d }); };
const hat = (d, g) => burst({ hz: 8200, q: 0.6, dur: 0.05, tone: 0, ring: 0, lp: false, gain: 0.14 * g, pan: 0, wave: 'square', toneGain: 0, delay: d });

const N = (semi, base = 330) => base * Math.pow(2, semi / 12);

const STINGERS = {
  physical: {
    win: seq([0, 1, 2, 3].map(i => [N(SCALE[i]), i * 0.075, 0.22, 0.16, 'triangle'])),
    lost: seq([0, 1, 2].map(i => [300 * Math.pow(2, -SCALE[i] / 12), i * 0.09, 0.26, 0.15, 'sine'])),
    sweep: seq([0, 1, 2, 3, 4, 5].map(i => [N(SCALE[i], 700), i * 0.045, 0.12, 0.09, 'sine'])),
    badge: seq([0, 2].map(i => [N(SCALE[i], 880), i * 0.06, 0.18, 0.13, 'triangle'])),
  },
  chip: {
    // a proper chiptune fanfare: fast 8-note arpeggio up two octaves
    win: seq([0, 4, 7, 12, 16, 19, 24, 28].map((s, i) => [N(s, 262), i * 0.04, 0.09, 0.13, 'square'])),
    lost: seq([[N(0, 220), 0, 0.16, 0.14, 'square', N(0, 220) * 0.5],
      [N(-2, 220), 0.14, 0.30, 0.14, 'square', N(-2, 220) * 0.4]]),
    sweep: seq([0, 12, 24, 12, 0].map((s, i) => [N(s, 440), i * 0.05, 0.07, 0.10, 'square'])),
    badge: seq([[N(0, 660), 0, 0.07, 0.13, 'square'], [N(12, 660), 0.07, 0.14, 0.13, 'square']]),
  },
  music: {
    // a gentle bell phrase with long ring — the music-box version of a cheer
    win: seq([[N(0, 587), 0, 0.7, 0.13, 'sine'], [N(4, 587), 0.12, 0.7, 0.12, 'sine'],
      [N(7, 587), 0.24, 0.9, 0.12, 'sine'], [N(12, 587), 0.42, 1.1, 0.11, 'sine']]),
    lost: seq([[N(0, 294), 0, 0.8, 0.13, 'sine'], [N(-4, 294), 0.3, 1.1, 0.12, 'sine']]),
    sweep: seq([0, 2, 4, 7, 9].map((s, i) => [N(s, 880), i * 0.07, 0.4, 0.07, 'sine'])),
    badge: seq([[N(9, 587), 0, 0.8, 0.11, 'sine'], [N(16, 587), 0.09, 1.0, 0.09, 'sine']]),
  },
  heavy: {
    // two low booms and a bright strike — an anvil of an outcome
    win: (th, g) => { kick(0, g * 1.2); kick(0.16, g * 1.2);
      burst({ hz: 3000, q: 6, dur: 0.5, tone: 620, ring: 2.4, lp: false, gain: 0.16 * g, pan: 0, wave: 'triangle', toneGain: 0.7, delay: 0.32 }); },
    lost: seq([[110, 0, 0.9, 0.22, 'sine', 30]]),
    sweep: (th, g) => [0, 1, 2, 3].forEach(i => kick(i * 0.11, g * (1 - i * 0.2))),
    badge: (th, g) => { burst({ hz: 3000, q: 6, dur: 0.4, tone: 620, ring: 2.2, lp: false, gain: 0.15 * g, pan: 0, wave: 'triangle', toneGain: 0.7 }); },
  },
  drum: {
    // the win is a fill; everything is played on the kit
    win: (th, g) => { kick(0, g); snare(0.12, g); kick(0.24, g); kick(0.32, g); snare(0.44, g); hat(0.56, g); },
    lost: (th, g) => { kick(0, g); blip({ freq: 130, to: 60, dur: 0.5, gain: 0.16 * g, wave: 'sine', delay: 0.15 }); },
    sweep: (th, g) => [0, 1, 2, 3, 4, 5].forEach(i => hat(i * 0.07, g)),
    badge: (th, g) => { snare(0, g); hat(0.08, g); },
  },
};

export function playStinger(name) {
  const s = soundSettings();
  if (!ctx || !enabled(s, 'stingers')) return false;
  const th = SOUND_THEMES[s.theme];
  const fn = (STINGERS[th.style] || STINGERS.physical)[name] || STINGERS.physical[name];
  if (!fn) return false;
  fn(th, th.gain);
  return true;
}

const UI = {
  place: { freq: 520, dur: 0.05, gain: 0.10, wave: 'triangle' },
  delete: { freq: 300, dur: 0.07, gain: 0.10, wave: 'triangle', to: 170 },
  undo: { freq: 400, dur: 0.06, gain: 0.08, wave: 'sine', to: 520 },
  click: { freq: 660, dur: 0.03, gain: 0.07, wave: 'sine' },
  deny: { freq: 200, dur: 0.10, gain: 0.11, wave: 'square', to: 150 },
};

export function playUi(name) {
  const s = soundSettings();
  if (!ctx || !enabled(s, 'ui') || !UI[name]) return false;
  const th = SOUND_THEMES[s.theme];
  const u = UI[name];
  blip({ ...u, freq: u.freq * th.pitch, gain: u.gain * th.gain, to: u.to ? u.to * th.pitch : 0 });
  return true;
}

// The settings screen needs to demonstrate a section without a running game.
export function auditionSection(section) {
  if (!initAudio()) return false;
  switch (section) {
    case 'impacts':
      // one soft, one wooden, one metallic, one glassy — under the drum theme
      // that is kick, snare, hat, hat; under the music box, four different
      // notes; under every theme, the full character in four hits
      [MAT.SOFT, MAT.WOOD, MAT.METAL, MAT.ICE].forEach((m, i) => setTimeout(
        () => playImpact({ speed: 4 + i * 3, matA: m, matB: m, pan: (i - 1.5) * 0.4 }), i * 150));
      return true;
    case 'motion':
      playMotion({ roll: 0.8, motor: 0.7, pitch: 0.5 });
      setTimeout(() => stopMotion(), 900);
      return true;
    case 'stingers': return playStinger('win');
    case 'ui': ['place', 'click', 'delete'].forEach((n, i) => setTimeout(() => playUi(n), i * 130)); return true;
    default: return false;
  }
}
