// levels.js — PAGES metadata + SEED_LEVELS (new 30 px-base units) + newMakerLevel().
//
// The 32 officials in slot order (§14). First Steps is the §14 worked
// example verbatim; the rest are authored in the new base following the
// conversion-era design rules: gaps ≤ ~28 px, steps ≤ ~12 px, hills as
// shallow rotated boxes (~11°), no reversed-angle V seams (stage 2 is a
// translation of a proven stage 1), wide goals for multi-piece levels,
// elevated goals keep the tow wheel on the same ledge as the ball.
//
// Textures are NOT set here — the seed script stamps granite (unset) on
// slots 0–15 and sand on 16–31 (§14.4).

// sizes.js and not util.js, deliberately: this file is read by the SERVER at
// seed time, and sizes.js is the DOM-free leaf that exists so the size ladder
// can be had without dragging the client into it. `newMakerLevel` is the only
// thing here that needs it.
import { STD_WHEEL_R, GRID_STEP } from './sizes.js';

export const PAGES = [
  { id: 'foundations', name: 'Foundations', blurb: 'Wheels, sticks and pins. Learn what a machine is.' },
  { id: 'masterworks', name: 'Masterworks', blurb: 'Edges, shelves and swinging things. Build with intent.' },
  { id: 'newground', name: 'New Ground', blurb: 'Sand underfoot and the ground itself starts moving.' },
  { id: 'farcountry', name: 'Far Country', blurb: 'Long hauls and strange contraptions at the edge of the map.' },
];

// **Campaigns are admin-defined slices of the numbered campaign** (the
// Admin > Campaigns tab). Each has a title, a byline, and sections — each
// section a title, a byline, and an inclusive 1-based range ("1,8" is
// levels #1 through #8). The campaign's own from/to is the span of its
// sections. The four PAGES above are only the shipped default for Starters.
// Slots stay one dense 0..n-1 run on the server; anything past every named
// range is still shown under More.
export const CAMPAIGN_TITLE_MAX = 80;
export const CAMPAIGN_BYLINE_MAX = 400;
export const CAMPAIGN_MAX = 40;
export const CAMPAIGN_SECTION_MAX = 16;

export function defaultStarterSections(content = null) {
  return PAGES.map((p, i) => ({
    title: p.name,
    byline: String(content?.['campaign.page.' + p.id] || p.blurb || '').slice(0, CAMPAIGN_BYLINE_MAX),
    from: i * 8 + 1,
    to: (i + 1) * 8,
  }));
}

export const SETS = [
  { id: 'starters', name: 'Starters', title: 'Starters', from: 1, to: 16,
    byline: '16 levels to learn the game by, in 2 parts.',
    blurb: '16 levels to learn the game by, in 2 parts.',
    sections: [
      { title: 'Foundations', byline: 'Wheels, sticks and pins. Learn what a machine is.', from: 1, to: 8 },
      { title: 'Masterworks', byline: 'Build with intent.', from: 9, to: 16 },
    ] },
  { id: 'main-course', name: 'Main Course', title: 'Main Course', from: 17, to: 32,
    byline: '',
    blurb: '',
    sections: [
      { title: 'New Ground', byline: 'Just starting to get interesting now.', from: 17, to: 24 },
      { title: 'Far Country', byline: 'Strange contraptions.', from: 25, to: 32 },
    ] },
];

// A slot's campaign, or null past the named ones (More, and the play
// screen's "^" when there is no set to go up to). `campaigns` is the live
// admin list when the caller has it; SETS is the shipped default.
export function setOfSlot(slot, campaigns = SETS) {
  if (slot == null || !Number.isInteger(slot)) return null;
  const n = slot + 1;
  const list = Array.isArray(campaigns) && campaigns.length ? campaigns : SETS;
  return list.find((s) => Number.isInteger(s.from) && Number.isInteger(s.to) && n >= s.from && n <= s.to) || null;
}

export function parseCampaignRange(text) {
  const s = String(text || '').trim();
  const one = s.match(/^(\d{1,4})$/);
  if (one) {
    const n = +one[1];
    return n >= 1 ? { from: n, to: n } : null;
  }
  const m = s.match(/^(\d{1,4})\s*[,.\-–—]+\s*(\d{1,4})$/);
  if (!m) return null;
  let from = +m[1], to = +m[2];
  if (from > to) [from, to] = [to, from];
  if (from < 1) return null;
  return { from, to };
}

export function formatCampaignRange(from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return '';
  return from + ',' + to;
}

export function campaignSlug(title) {
  const s = String(title || '').toLowerCase().normalize('NFKD')
    .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return s || 'campaign';
}

export function publicCampaign(c) {
  const title = c.title || c.name || '';
  const byline = c.byline || c.blurb || '';
  const sections = (c.sections || []).map((s) => ({
    title: s.title, byline: s.byline || '', from: s.from, to: s.to,
  })).sort((a, b) => a.from - b.from || a.to - b.to);
  return { id: c.id, title, name: title, byline, blurb: byline, from: c.from, to: c.to, sections };
}

function readRange(raw, label) {
  let from = raw.from, to = raw.to;
  if (raw.range != null && String(raw.range).trim() !== '') {
    const r = parseCampaignRange(raw.range);
    if (!r) return { error: `Range "${raw.range}" is not two numbers like 1,8.` };
    from = r.from;
    to = r.to;
  }
  from = +from;
  to = +to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > 9999) {
    return { error: `${label} needs a range like 1,8.` };
  }
  return { from, to };
}

function normalizeSections(rawList, campaignTitle) {
  const src = Array.isArray(rawList) ? rawList : [];
  if (src.length > CAMPAIGN_SECTION_MAX) return { error: `"${campaignTitle}" can have at most ${CAMPAIGN_SECTION_MAX} sections.` };
  const sections = [];
  for (const raw of src) {
    const title = String(raw.title || raw.name || '').replace(/\s+/g, ' ').trim().slice(0, CAMPAIGN_TITLE_MAX);
    if (!title) return { error: `Every section in "${campaignTitle}" needs a title.` };
    const byline = String(raw.byline || raw.blurb || '').replace(/\r\n/g, '\n').trim().slice(0, CAMPAIGN_BYLINE_MAX);
    const range = readRange(raw, `"${title}"`);
    if (range.error) return range;
    sections.push({ title, byline, from: range.from, to: range.to });
  }
  sections.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i], b = sections[j];
      if (a.from <= b.to && b.from <= a.to) {
        return { error: `${a.title} (${formatCampaignRange(a.from, a.to)}) overlaps ${b.title} (${formatCampaignRange(b.from, b.to)}) in "${campaignTitle}".` };
      }
    }
  }
  return { sections };
}

// Shape and overlap check for the admin save. Used by the server and the
// admin tab, so a rejected range is the same sentence in both places.
// A campaign is title + byline + sections (each with title, byline, range).
// A lone campaign-level range still works: it becomes one section.
export function normalizeCampaigns(input) {
  if (!Array.isArray(input)) return { error: 'campaigns must be a list.' };
  if (input.length > CAMPAIGN_MAX) return { error: `At most ${CAMPAIGN_MAX} campaigns.` };
  const used = new Set();
  const out = [];
  for (const raw of input) {
    const title = String(raw.title || raw.name || '').replace(/\s+/g, ' ').trim().slice(0, CAMPAIGN_TITLE_MAX);
    if (!title) return { error: 'Every campaign needs a title.' };
    const byline = String(raw.byline || raw.blurb || '').replace(/\r\n/g, '\n').trim().slice(0, CAMPAIGN_BYLINE_MAX);
    let sectionsIn = Array.isArray(raw.sections) ? raw.sections : [];
    if (!sectionsIn.length) {
      const whole = readRange(raw, `"${title}"`);
      if (whole.error) return { error: `"${title}" needs a section with a range like 1,8.` };
      sectionsIn = [{ title, byline: '', from: whole.from, to: whole.to }];
    }
    const got = normalizeSections(sectionsIn, title);
    if (got.error) return got;
    if (!got.sections.length) return { error: `"${title}" needs at least one section.` };
    const from = Math.min(...got.sections.map((s) => s.from));
    const to = Math.max(...got.sections.map((s) => s.to));
    let id = String(raw.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || id === 'more') id = campaignSlug(title);
    if (id === 'more') id = 'campaign';
    const base = id;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    out.push({ id, title, byline, from, to, sections: got.sections });
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      if (a.from <= b.to && b.from <= a.to) {
        return { error: `${a.title} (${formatCampaignRange(a.from, a.to)}) overlaps ${b.title} (${formatCampaignRange(b.from, b.to)}).` };
      }
    }
  }
  return { campaigns: out };
}

// A rotated ramp box whose TOP surface runs (x0,y0) → (x1,y1), extended by
// `ext` px at both ends so seams overlap neighbours (corner rounding hides
// inside the overlap). h is the slab thickness (standard terrain 60).
function ramp(x0, y0, x1, y1, h = 60, ext = 14) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const ax0 = x0 - ux * ext, ay0 = y0 - uy * ext;
  const ax1 = x1 + ux * ext, ay1 = y1 + uy * ext;
  const theta = Math.atan2(dy, dx);
  const mx = (ax0 + ax1) / 2, my = (ay0 + ay1) / 2;
  // push the centre half a thickness along the local +y (down-normal)
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  return {
    type: 'box',
    x: +(mx + nx * h / 2).toFixed(2),
    y: +(my + ny * h / 2).toFixed(2),
    w: +(len + ext * 2).toFixed(2),
    h,
    angle: +theta.toFixed(5),
  };
}

// flat slab whose top spans [xa, xb] at height `top` (thickness h)
function flat(xa, xb, top = 0, h = 60) {
  return { type: 'box', x: +((xa + xb) / 2).toFixed(2), y: +(top + h / 2).toFixed(2), w: +(xb - xa).toFixed(2), h };
}

export const SEED_LEVELS = [

  // ============ Page 1 — Foundations ============

  { // slot 0 — the §14 worked example, verbatim
    name: 'First Steps',
    desc: 'Welcome, engineer. Get the green ball to the goal zone — it\'s a pin, so build your machine right onto it.',
    hint: 'Hang two sticks off the ball\'s pin, snap an R wheel onto the end of each, and press Play.',
    terrain: [{ type: 'box', x: 0, y: 28.125, w: 1031.25, h: 56.25 }],
    props: [],
    buildZones: [{ x: -290.625, y: -75, w: 215.625, h: 150 }],
    goalZones: [{ x: 300, y: -51.5625, w: 131.25, h: 103.125 }],
    goalObjs: [{ shape: 'ball', x: -290.625, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 1
    name: 'Double Delivery',
    desc: 'Two green balls, one wide goal. Whatever you build has to move them both.',
    hint: 'You don\'t have to carry them — a rolling machine that shoves both balls ahead of itself will do fine.',
    terrain: [flat(-600, 600)],
    props: [],
    buildZones: [{ x: -330, y: -75, w: 240, h: 150 }],
    goalZones: [{ x: 380, y: -52, w: 220, h: 104 }],
    goalObjs: [
      { shape: 'ball', x: -300, y: -15, r: 15 },
      { shape: 'ball', x: -230, y: -15, r: 15 },
    ],
    win: 'goalObj',
  },

  { // slot 2
    name: 'Mind the Gap',
    desc: 'The floor is missing a piece. Small wheels fall in; machines with a wheelbase roll right over.',
    hint: 'Two wheels joined by a stick bridge the gap. Bolt the ball\'s pin to the front of the train.',
    terrain: [flat(-600, 0), flat(24, 624)],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 450, y: -52, w: 120, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 3
    name: 'The Climb',
    desc: 'The goal sits on a plateau. Grip matters more than speed on the way up.',
    hint: 'Powered wheels grip hard. A two-wheel train pulling the ball takes the slope without drama.',
    terrain: [
      flat(-605, -88),
      ramp(-100, 0, 200, -60),
      flat(188, 700, -60),
    ],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 500, y: -112, w: 120, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 4
    name: 'The Wall',
    desc: 'They built a wall across the flats. They also, helpfully, left the ramps.',
    hint: 'Up one side, down the other. Keep the machine short so it doesn\'t high-centre on the crest.',
    terrain: [
      flat(-700, -318),
      ramp(-330, 0, -30, -60),
      flat(-42, 42, -60),
      ramp(30, -60, 330, 0),
      flat(318, 700),
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 520, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 5
    name: 'Special Delivery',
    desc: 'The parcel is already out on the road, past your build zone. You can\'t bolt to it — go push.',
    hint: 'It\'s light. A chain of three powered wheels rolls out and bulldozes it the whole way home.',
    terrain: [flat(-600, 600)],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 400, y: -52, w: 200, h: 104 }],
    goalObjs: [{ shape: 'box', x: -300, y: -15, w: 30, h: 30, density: 0.25 }],
    win: 'goalObj',
  },

  { // slot 6
    name: 'Tipping Point',
    desc: 'The bridge is a plank balanced on a single pin. It holds — mostly.',
    hint: 'Drive steadily. The plank tips a little as you cross, but it can\'t go far — don\'t panic and reverse.',
    terrain: [flat(-700, -70), flat(70, 700)],
    props: [
      { shape: 'box', x: 0, y: -5, w: 220, h: 10, density: 1, pin: { x: 0, y: -5 } },
    ],
    buildZones: [{ x: -550, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 500, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -550, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 7
    name: 'Off the Pedestal',
    desc: 'Somebody put the ball on a little plinth, just out of reach. Rude. Knock it down and take it home.',
    hint: 'The plinth is low enough to climb. Roll into the ball, bump it off, and keep pushing.',
    terrain: [
      flat(-650, 650),
      { type: 'box', x: -280, y: -5, w: 40, h: 10 },
    ],
    props: [],
    buildZones: [{ x: -430, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 450, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -280, y: -25, r: 15 }],
    win: 'goalObj',
  },

  // ============ Page 2 — Masterworks ============

  { // slot 8
    name: 'Over the Edge',
    desc: 'The road just… stops. The goal is down in the quarry. Commit.',
    hint: 'Speed off the edge and let gravity do the middle part. Machines land better than you\'d think.',
    terrain: [
      flat(-700, 80),
      flat(80, 820, 120),
      { type: 'box', x: 790, y: 90, w: 60, h: 180 },
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 500, y: 68, w: 200, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'fog',
  },

  { // slot 9
    name: 'Low Clearance',
    desc: 'A ceiling over the road. Tall machines need not apply.',
    hint: 'Keep everything at wheel height — a flat two-wheel tow slides under with room to spare.',
    terrain: [
      flat(-650, 650),
      { type: 'box', x: 50, y: -90, w: 500, h: 60 },
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 480, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 10
    name: 'Stairway',
    desc: 'Three shallow steps between you and the landing. Wheels barely notice; the ball needs convincing.',
    hint: 'Each step is only a few pixels tall. Keep pushing — momentum carries the ball up.',
    terrain: [
      flat(-700, -38),
      flat(-50, 162, -11),
      flat(150, 362, -22),
      flat(350, 750, -33),
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 600, y: -85, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 11
    name: 'Pendulum Alley',
    desc: 'Two planks hang over the road, itching to swing. Stay low and they\'ll only wave as you pass.',
    hint: 'The pendulums hang just above wheel height. A low tow brushes through; tall builds get batted.',
    terrain: [flat(-650, 650)],
    props: [
      { shape: 'box', x: -50, y: -96, w: 10, h: 108, density: 1.2, pin: { x: -50, y: -150 } },
      { shape: 'box', x: 200, y: -96, w: 10, h: 108, density: 1.2, pin: { x: 200, y: -150 } },
    ],
    buildZones: [{ x: -480, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 460, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -480, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 12
    name: 'High Shelf',
    desc: 'The whole job happens on the top shelf. The floor is a long way down and does not count.',
    hint: 'Everything you need is already up here. Build on the ball\'s ledge and don\'t look over the side.',
    terrain: [
      flat(-650, -100, -100),
      { type: 'box', x: 0, y: -85, w: 220, h: 30 },
      flat(100, 650, -100),
      flat(-750, 750, 200),
    ],
    props: [],
    buildZones: [{ x: -450, y: -175, w: 200, h: 150 }],
    goalZones: [{ x: 450, y: -152, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -115, r: 15 }],
    win: 'goalObj',
    background: 'night',
  },

  { // slot 13
    name: 'Rolling Hills',
    desc: 'Two gentle rises, one after the other. The second hill is the first one\'s twin.',
    hint: 'If your machine takes hill one, it takes hill two — they\'re identical. Momentum is a bonus, grip is the plan.',
    terrain: [
      flat(-1000, -238),
      ramp(-250, 0, -50, -40),
      flat(-62, 62, -40),
      ramp(50, -40, 250, 0),
      flat(238, 262),
      ramp(250, 0, 450, -40),
      flat(438, 562, -40),
      ramp(550, -40, 750, 0),
      flat(738, 1000),
    ],
    props: [],
    buildZones: [{ x: -700, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 900, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -700, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 14
    name: 'Freight',
    desc: 'A big, dense crate sits in your yard. It does not want to move. Hitch up and make it.',
    hint: 'It\'s in the build zone, so bolt a stick to its corner pin. One wheel won\'t shift it — use the grip of several.',
    terrain: [flat(-650, 650)],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 430, y: -52, w: 160, h: 104 }],
    goalObjs: [{ shape: 'box', x: -480, y: -20, w: 40, h: 40, density: 1.6 }],
    win: 'goalObj',
    background: 'rain',
  },

  { // slot 15
    name: 'The Gauntlet',
    desc: 'A hill, a gap and a ceiling, in that order. Every lesson so far, back to back.',
    hint: 'Short wheelbase for the crest, wide enough for the gap, low enough for the ceiling. Two wheels and a stick, basically.',
    terrain: [
      flat(-800, -338),
      ramp(-350, 0, -150, -40),
      flat(-162, -38, -40),
      ramp(-50, -40, 150, 0),
      flat(138, 330),
      flat(354, 954),
      { type: 'box', x: 600, y: -90, w: 300, h: 60 },
    ],
    props: [],
    buildZones: [{ x: -700, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 850, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -700, y: -15, r: 15 }],
    win: 'goalObj',
  },

  // ============ Page 3 — New Ground ============

  { // slot 16
    name: 'Twin Peaks',
    desc: 'Two proper hills with a quiet valley between them. The sand doesn\'t make it easier.',
    hint: 'Take the first peak slow and straight. The valley is flat — regroup there before the second.',
    terrain: [
      flat(-900, -288),
      ramp(-300, 0, -50, -50),
      flat(-62, 62, -50),
      ramp(50, -50, 300, 0),
      flat(288, 512),
      ramp(500, 0, 750, -50),
      flat(738, 862, -50),
      ramp(850, -50, 1100, 0),
      flat(1088, 1300),
    ],
    props: [],
    buildZones: [{ x: -600, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 1150, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -600, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'snow',
  },

  { // slot 17
    name: 'The Trench',
    desc: 'The road dips into a trench. Getting down is free; getting out is the whole level.',
    hint: 'The exit ramp is long and shallow. Enter with speed, keep the power on, and climb out the far side.',
    terrain: [
      flat(-700, -188),
      ramp(-200, 0, -80, 40),
      flat(-92, 232, 40),
      ramp(220, 40, 520, 0),
      flat(508, 1020),
    ],
    props: [],
    buildZones: [{ x: -600, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 850, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -600, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'fog',
  },

  { // slot 18
    name: 'Loose Change',
    desc: 'Someone spilled a pocketful of little boulders across the road. Plough through.',
    hint: 'The coins are light. A steady machine shoulders them aside — don\'t stop in the middle of the pile.',
    terrain: [flat(-650, 650)],
    props: [
      { shape: 'ball', x: -100, y: -7.5, r: 7.5, density: 0.6 },
      { shape: 'ball', x: -40, y: -7.5, r: 7.5, density: 0.6 },
      { shape: 'ball', x: 20, y: -7.5, r: 7.5, density: 0.6 },
      { shape: 'ball', x: 90, y: -7.5, r: 7.5, density: 0.6 },
      { shape: 'ball', x: 160, y: -7.5, r: 7.5, density: 0.6 },
    ],
    buildZones: [{ x: -480, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 460, y: -52, w: 160, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -480, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'candy',
  },

  { // slot 19
    name: 'Zigzag Ramp',
    desc: 'Two long, lazy ramps with a landing between. Height is earned a few degrees at a time.',
    hint: 'Neither ramp is steep. A powered pair with the ball in tow walks up both without slipping.',
    terrain: [
      flat(-800, -288),
      ramp(-300, 0, 0, -45),
      flat(-12, 212, -45),
      ramp(200, -45, 500, -90),
      flat(488, 900, -90),
    ],
    props: [],
    buildZones: [{ x: -650, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 750, y: -142, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -650, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 20
    name: 'The Overhang',
    desc: 'A slab of rock leans out over the road, lower at the far end. Duck.',
    hint: 'Clearance shrinks as you go — lowest at the exit. Flat builds only through here.',
    terrain: [
      flat(-650, 650),
      { type: 'box', x: 225, y: -85, w: 250, h: 60, angle: 0.06 },
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 500, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 21
    name: 'Boulder Alley',
    desc: 'Half-buried boulders make the road lumpy, and a couple of loose ones roll free.',
    hint: 'The buried ones are just bumps — roll over them. The loose ones move; push them along or around.',
    terrain: [
      flat(-700, 700),
      { type: 'ball', x: -50, y: 22, r: 30 },
      { type: 'ball', x: 150, y: 20, r: 30 },
      { type: 'ball', x: 350, y: 22, r: 30 },
    ],
    props: [
      { shape: 'ball', x: -150, y: -15, r: 15 },
      { shape: 'ball', x: 250, y: -15, r: 15 },
    ],
    buildZones: [{ x: -550, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 550, y: -52, w: 150, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -550, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 22
    name: 'The Drawbridge',
    desc: 'The bridge is there right now. It will not always be there. You understand the assignment.',
    hint: 'The platform starts in place and sinks away slowly. Go immediately — hesitation is how machines drown.',
    terrain: [
      flat(-600, 100),
      flat(200, 800),
      {
        type: 'box', x: 150, y: 10, w: 220, h: 20,
        path: { pts: [{ x: 450, y: 10 }], mode: 'pingpong', speed: 14 },
      },
    ],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 600, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 23
    name: 'Triple Delivery',
    desc: 'Three green balls. One very wide goal. The whole family goes home together.',
    hint: 'Push the herd from behind — the balls bump each other along. The goal is wide enough for all three, but only just.',
    terrain: [flat(-700, 700)],
    props: [],
    buildZones: [{ x: -360, y: -75, w: 240, h: 150 }],
    goalZones: [{ x: 420, y: -52, w: 260, h: 104 }],
    goalObjs: [
      { shape: 'ball', x: -355, y: -15, r: 15 },
      { shape: 'ball', x: -300, y: -15, r: 15 },
      { shape: 'ball', x: -245, y: -15, r: 15 },
    ],
    win: 'goalObj',
  },

  // ============ Page 4 — Far Country ============

  { // slot 24
    name: 'Crate Convoy',
    desc: 'Two crates lined up in your yard. Hitch them nose to tail and haul the convoy home.',
    hint: 'Corner pin to corner pin, then a stick to your wheels. The convoy is only as strong as its hitches.',
    terrain: [flat(-700, 700)],
    props: [],
    buildZones: [{ x: -430, y: -75, w: 260, h: 150 }],
    goalZones: [{ x: 430, y: -52, w: 220, h: 104 }],
    goalObjs: [
      { shape: 'box', x: -520, y: -15, w: 30, h: 30 },
      { shape: 'box', x: -450, y: -15, w: 30, h: 30 },
    ],
    win: 'goalObj',
    background: 'sunset',
  },

  { // slot 25
    name: 'The Spiral',
    desc: 'A great arm turns slowly over the road. It never quite reaches the ground. Probably.',
    hint: 'The blade\'s lowest sweep clears a wheel-high machine. Stay flat and drive through without flinching.',
    terrain: [
      flat(-650, 650),
      {
        type: 'box', x: 100, y: -145, w: 200, h: 14,
        path: { spin: 1, spinSpeed: 30 },
      },
      {
        type: 'box', x: 380, y: -190, w: 140, h: 12,
        path: { spin: -1, spinSpeed: 45 },
      },
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 480, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'aurora',
  },

  { // slot 26
    name: 'Tightrope',
    desc: 'A thin beam over a very deep nothing. The beam is flat. Your nerve is the variable.',
    hint: 'It\'s only falling if you steer. Straight line, steady power, don\'t build anything that wobbles.',
    terrain: [
      flat(-600, -100),
      { type: 'box', x: 100, y: 10, w: 400, h: 20 },
      flat(300, 800),
    ],
    props: [],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 600, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'night',
  },

  { // slot 27
    name: 'Sandpit',
    desc: 'A pit full of loose little stones. They shift underfoot, and the way out is a long shallow climb.',
    hint: 'Wade in with power to spare — three wheels beat two here. The stones part if you keep the wheels turning.',
    terrain: [
      flat(-750, -38),
      flat(-50, 112, 25),
      ramp(100, 25, 250, 0),
      flat(238, 750),
    ],
    props: [
      { shape: 'ball', x: -30, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: -12, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 6, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 24, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 42, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 60, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 78, y: 17.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: -21, y: 2.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: -3, y: 2.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 15, y: 2.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 33, y: 2.5, r: 7.5, density: 0.5 },
      { shape: 'ball', x: 51, y: 2.5, r: 7.5, density: 0.5 },
    ],
    buildZones: [{ x: -560, y: -75, w: 240, h: 150 }],
    goalZones: [{ x: 500, y: -52, w: 150, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -520, y: -15, r: 15 }],
    win: 'goalObj',
  },

  { // slot 28
    name: 'The Vault',
    desc: 'The goal sits inside a stone vault with one low doorway. Deliveries through the slot, please.',
    hint: 'The doorway is taller than it looks — a flat tow fits with room. Don\'t overshoot into the back wall. Actually, do — it\'s fine.',
    terrain: [
      flat(-750, 750),
      { type: 'box', x: 450, y: -105, w: 340, h: 60 },
      { type: 'box', x: 650, y: -45, w: 60, h: 150 },
    ],
    props: [],
    buildZones: [{ x: -500, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 500, y: -37, w: 180, h: 74 }],
    goalObjs: [{ shape: 'ball', x: -500, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'night',
  },

  { // slot 29
    name: 'Counterweight',
    desc: 'A see-saw bridge with a crate riding the near end. The crate keeps your side down — until you pass the middle.',
    hint: 'Cross without stopping. Past the pivot the plank leans your way, which is exactly the direction you wanted to go.',
    terrain: [flat(-600, 0), flat(160, 760)],
    props: [
      { shape: 'box', x: 80, y: -6, w: 280, h: 12, density: 1, pin: { x: 80, y: -6 } },
      { shape: 'box', x: -40, y: -24.5, w: 25, h: 25, density: 2 },
    ],
    buildZones: [{ x: -450, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 560, y: -52, w: 140, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -450, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'sunset',
  },

  { // slot 30
    name: 'The Long Haul',
    desc: 'Nothing fancy. Just a very, very long road, a few buried stones, and one crack near the end.',
    hint: 'Endurance run. Build something boring and reliable — the flashy machines die of wobble around the second bump.',
    terrain: [
      flat(-1280, 1200),
      { type: 'ball', x: -100, y: 22, r: 30 },
      { type: 'ball', x: 400, y: 22, r: 30 },
      { type: 'ball', x: 900, y: 22, r: 30 },
      flat(1222, 1700),
    ],
    props: [],
    buildZones: [{ x: -1150, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 1550, y: -52, w: 150, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -1150, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'sunset',
  },

  { // slot 31
    name: 'Grand Gauntlet',
    desc: 'The hill. The gap. The pendulum. The ceiling. Everything the Far Country taught you, in one road.',
    hint: 'The same honest machine that solved each piece solves the whole: short, low, two powered wheels, ball in front.',
    terrain: [
      flat(-900, -338),
      ramp(-350, 0, -150, -40),
      flat(-162, -38, -40),
      ramp(-50, -40, 150, 0),
      flat(138, 400),
      flat(424, 1500),
      { type: 'box', x: 950, y: -90, w: 300, h: 60 },
    ],
    props: [
      { shape: 'box', x: 600, y: -96, w: 10, h: 108, density: 1.2, pin: { x: 600, y: -150 } },
    ],
    buildZones: [{ x: -800, y: -75, w: 200, h: 150 }],
    goalZones: [{ x: 1300, y: -52, w: 150, h: 104 }],
    goalObjs: [{ shape: 'ball', x: -800, y: -15, r: 15 }],
    win: 'goalObj',
    background: 'aurora',
  },
];

// Fresh-maker template — the first thing every author sees, and the shape they
// will edit rather than start from scratch, so it is worth being exact about.
//
// Authored in the Maker itself ("New Starter Layout for Maker") and transcribed
// here rather than fetched: the Maker has to open with no account, no network
// and no particular row existing in the database, and a template that could
// 404 is a Maker that can fail to start.
//
// Every number is on the positional grid (§8.1): the floor spans x −440…400,
// the build zone −400…−120 and the goal zone 120…360, all sitting on the
// floor's surface at y = 0. Which matters more than tidiness — an author
// dragging the first piece onto a grid node finds it lines up with what is
// already there, instead of being 5 px out from the start.
//
// **Re-laid on the 40 grid on 2026-08-15** (Path B: a LIFIRIK pixel is an FC
// unit, so GRID_STEP went 30 → 40). Every edge was a multiple of 30 and none of
// them was a multiple of 40, which made the one promise this template exists to
// keep — that the first drag lines up — false for every new author. Written as
// multiples of `G` rather than transcribed again, so the next scale change
// carries the template with it.
//
// The crate's −G/2 − 0.01 is REST_GAP below flush (§8.2): a 40 px crate resting
// on y = 0 has its centre at −20, and the editor's own sweeps leave a piece
// exactly that hundredth of a pixel clear rather than touching. An earlier
// template hovered it, so the very first thing a new author saw on pressing
// Play was the goal piece dropping.
export function newMakerLevel() {
  const G = GRID_STEP;
  return {
    name: 'Untitled Level',
    desc: '',
    terrain: [{ type: 'box', x: -G / 2, y: G, w: G * 21, h: G * 2 }],   // x −440…400, top at y = 0
    props: [],
    fixedParts: [],
    buildZones: [{ x: -G * 6.5, y: -G * 2.5, w: G * 7, h: G * 5 }],     // x −400…−120
    goalZones: [{ x: G * 6, y: -G * 2.5, w: G * 6, h: G * 5 }],         // x 120…360
    goalObjs: [{ shape: 'box', x: -G * 4.5, y: -G / 2 - 0.01, w: G, h: G }],
    win: 'goalObj',
  };
}

// Split a flat seed entry into server-record fields vs level data (§11.2:
// name/desc/hint live at the record top level, not inside data).
export function seedToRecord(seed) {
  const { name, desc, hint, ...data } = seed;
  return { name, desc, hint, data };
}
