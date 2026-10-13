'use strict';
/* Dota 2 ADHD Coach — dashboard.
   Turns live Game State Integration data into ONE clear instruction at a time, plus short voice alerts. */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getJson = (url, opts) => fetch(url, opts).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const CDN = 'https://cdn.cloudflare.steamstatic.com';

const faNum = (s) => String(s).replace(/\d/g, (c) => '۰۱۲۳۴۵۶۷۸۹'[c]);
// ?overlay = the small always-on-top window that sits over the game (opened by overlay.ps1)
const OVERLAY = new URLSearchParams(location.search).has('overlay');
if (OVERLAY) document.title = 'Dota Coach Overlay';

function fmt(sec) {
  if (sec == null || Number.isNaN(sec)) return '--:--';
  const neg = sec < 0;
  const s = Math.abs(Math.floor(sec));
  return `${neg ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Bought every game, but never "the next big item".
const CONSUMABLES = new Set(['tango', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'tpscroll', 'ward_observer', 'ward_sentry',
  'ward_dispenser', 'smoke_of_deceit', 'dust', 'blood_grenade', 'tome_of_knowledge', 'branches', 'magic_stick', 'cheese', 'aegis',
  'refresher_shard', 'famango', 'great_famango', 'greater_famango']);
// Basic items that are core on their own even though they upgrade into something later.
const STANDALONE = new Set(['blink']);
const BOOTS_T1 = new Set(['power_treads', 'phase_boots', 'arcane_boots', 'tranquil_boots']);
const BOOTS_ANY = new Set([...BOOTS_T1, 'travel_boots', 'travel_boots_2', 'guardian_greaves', 'boots_of_bearing']);
const HIDDEN_ABILITY = /^(plus_|ability_|generic_hidden|seasonal_|twin_gate|special_bonus|dota_)/;
const PHASES = [['start', 'start_game_items'], ['early', 'early_game_items'], ['mid', 'mid_game_items'], ['late', 'late_game_items']];
const PHASE_FA = { start: 'شروع', early: 'اول بازی', mid: 'وسط بازی', late: 'آخر بازی' };
const RANK = ['🥇', '🥈', '🥉'];

const S = {
  consts: null,
  config: { timers: [], lanUrls: [], setup: null },
  game: null,
  source: 'none',
  lastMsgAt: 0,
  d: null, // derived view of the current state
  build: null,
  buildHeroId: 0,
  skills: null,
  skillsHeroId: 0,
  ai: null, // enemy lineup + counter items from the optional AI coach (server-side, OpenRouter)
  aiSpoken: null,
  neutralTab: null,
  matchId: null,
  spoken: {},
  announced: new Set(),
  alertLog: [],
  stashSince: 0,
  rosh: null,
  // the overlay is click-through, so it can't be clicked; overlay.ps1 starts it with autoplay allowed instead
  audioOk: OVERLAY,
  overlays: 0,
  settings: loadSettings(),
};

// ---------------- settings ----------------
function loadSettings() {
  const def = { voice: true, lang: 'fa', faVoice: '', simple: false, ultVoice: false, shopClip: true, timers: {} };
  try { return { ...def, ...JSON.parse(localStorage.getItem('coach.settings') || '{}') }; } catch { return def; }
}
function saveSettings() {
  try { localStorage.setItem('coach.settings', JSON.stringify(S.settings)); } catch {}
  // shared through the server so the overlay (separate browser profile, not clickable) follows along
  fetch('/api/settings', { method: 'POST', body: JSON.stringify(S.settings) }).catch(() => {});
}

async function loadSharedSettings() {
  try {
    const shared = await getJson('/api/settings');
    if (shared && Object.keys(shared).length) applySettings(shared);
  } catch {}
}

function applySettings(next) {
  const voiceChanged = next.lang !== S.settings.lang || next.faVoice !== S.settings.faVoice;
  S.settings = { ...S.settings, ...next, timers: { ...(next.timers || {}) } };
  try { localStorage.setItem('coach.settings', JSON.stringify(S.settings)); } catch {}
  if (voiceChanged && OVERLAY) { speechSynthesis.cancel(); speak(SAMPLE, 'info'); } // let them hear the new voice
  onState();
}
const timerOn = (t) => S.settings.timers[t.id] ?? t.on;

// ---------------- voice ----------------
// Persian voices come from Microsoft Edge's online "Natural" voices (fa-IR: Dilara, Farid).
// Browsers without one (Chrome, most phones) fall back to English.
const voices = { fa: [], en: null };
function pickVoices() {
  const vs = speechSynthesis.getVoices();
  const natural = (v) => (/natural|online/i.test(v.name) ? 1 : 0);
  voices.fa = vs.filter((v) => /^fa/i.test(v.lang)).sort((a, b) => natural(b) - natural(a));
  voices.en = vs.find((v) => /^en[-_]US/i.test(v.lang) && /natural|aria|jenny|guy|zira/i.test(v.name)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
const faVoice = () => voices.fa.find((v) => v.name === S.settings.faVoice) || voices.fa[0] || null;
if ('speechSynthesis' in window) {
  pickVoices();
  speechSynthesis.onvoiceschanged = pickVoices;
}

let audioCtx = null;
function chime(kind) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = { danger: 330, buy: 880 }[kind] || 660;
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(t + 0.3);
  } catch {}
}

// msg = { fa, en }
function speak(msg, kind) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  if (!OVERLAY && S.overlays > 0) return; // the small in-game window does the talking
  if (kind === 'danger') speechSynthesis.cancel();
  chime(kind);
  const fa = S.settings.lang !== 'en' ? faVoice() : null;
  const u = new SpeechSynthesisUtterance(fa ? msg.fa : msg.en);
  const v = fa || voices.en;
  if (v) u.voice = v;
  u.lang = fa ? 'fa-IR' : 'en-US';
  u.rate = fa ? 1.0 : 1.05;
  speechSynthesis.speak(u);
}

// key + cooldown keep each alert from nagging.
function say(key, msg, cooldownSec, kind = 'info') {
  const now = Date.now();
  if (S.spoken[key] && now - S.spoken[key] < cooldownSec * 1000) return;
  S.spoken[key] = now;
  S.alertLog.unshift({ clock: S.d?.clock, text: msg.fa, kind });
  S.alertLog.length = Math.min(S.alertLog.length, 6);
  speak(msg, kind);
}

// ---------------- data ----------------
async function loadConsts() {
  try {
    S.consts = await getJson('/api/constants');
    if (S.buildHeroId) loadBuild(S.buildHeroId);
    onState();
  } catch {
    setTimeout(loadConsts, 10000);
  }
}

async function loadConfig() {
  try { S.config = await getJson('/api/config'); } catch {}
  scheduleRender();
}

async function loadBuild(heroId) {
  if (S.buildHeroId !== heroId) S.build = null;
  S.buildHeroId = heroId;
  if (!S.consts) return;
  try {
    const pop = await getJson(`/api/build/${heroId}`);
    if (S.buildHeroId === heroId) S.build = computeBuild(pop);
  } catch {
    if (S.buildHeroId === heroId) {
      const h = S.consts.heroes[heroId];
      S.build = h ? genericBuild(h) : { error: true };
      // keep trying for the real, hero-specific build
      setTimeout(() => { if (S.buildHeroId === heroId && (S.build?.error || S.build?.generic)) loadBuild(heroId); }, 60000);
    }
  }
  onState();
}

async function loadSkills(heroId) {
  if (S.skillsHeroId !== heroId) S.skills = null;
  S.skillsHeroId = heroId;
  try {
    const sk = await getJson(`/api/skills/${heroId}`);
    if (S.skillsHeroId === heroId) S.skills = sk;
  } catch {
    if (S.skillsHeroId === heroId) {
      S.skills = { error: true };
      setTimeout(() => { if (S.skillsHeroId === heroId && S.skills?.error) loadSkills(heroId); }, 60000);
    }
  }
  onState();
}

const prettyAbility = (name) => name.split('_').slice(name.split('_').length > 2 ? 1 : 0).join(' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Which ability to level next: follow the pro order, skipping points already spent and anything not learnable yet.
function nextSkill(d) {
  const abil = Object.values(d.g.abilities || {});
  if (!abil.length || !(d.hero.level > 0)) return null;
  const byName = Object.fromEntries(abil.map((a) => [a.name, a]));
  const lv = (n) => byName[n]?.level || 0;
  const talentsTaken = Object.keys(d.hero).filter((k) => /^talent_\d+$/.test(k) && d.hero[k]).length;
  const canLearn = (name) => {
    const a = byName[name];
    if (!a) return false;
    const next = (a.level || 0) + 1;
    if (a.ultimate) return next <= 3 && d.hero.level >= [6, 12, 18][next - 1];
    return next <= 4 && d.hero.level >= 2 * next - 1;
  };
  // In the current patch talents don't use ability points: one ability point per level, plus a talent at 10/15/20/25.
  const basics = abil.filter((a) => !HIDDEN_ABILITY.test(a.name) && !/innate/.test(a.name));
  const abilityPoints = Math.max(0, d.hero.level - basics.reduce((n, a) => n + (a.level || 0), 0));
  const talentPoints = Math.max(0, [10, 15, 20, 25].filter((l) => d.hero.level >= l).length - talentsTaken);

  let nextAbility = null;
  let nextTalent = null;
  const order = S.skills?.order;
  if (order?.length) {
    const used = {};
    let talentsSeen = 0;
    for (const o of order) {
      if (o.talent) {
        talentsSeen++;
        if (talentsSeen > talentsTaken && !nextTalent) nextTalent = { ...o, pro: true };
        continue;
      }
      used[o.name] = (used[o.name] || 0) + 1;
      if (!nextAbility && used[o.name] > lv(o.name) && canLearn(o.name)) nextAbility = { ...o, pro: true };
    }
  }
  if (!nextAbility) {
    // no pro data (or the order ran out): ultimate whenever possible, otherwise keep maxing your highest skill
    const learn = basics.filter((a) => canLearn(a.name));
    const pick = learn.find((a) => a.ultimate) || learn.filter((a) => !a.ultimate).sort((a, b) => (b.level || 0) - (a.level || 0))[0];
    if (pick) nextAbility = { name: pick.name, dname: prettyAbility(pick.name), img: `${CDN}/apps/dota2/images/dota_react/abilities/${pick.name}.png`, pro: false };
  }
  if (abilityPoints > 0 && nextAbility) return { ...nextAbility, points: abilityPoints };
  if (talentPoints > 0) return { ...(nextTalent || { name: 'talent', dname: 'Talent', img: null, pro: false }), talent: true, points: talentPoints };
  return nextAbility ? { ...nextAbility, points: 0 } : null;
}

// Only used when OpenDota can't be reached: a sensible build from the hero's type.
const GENERIC_BUILDS = {
  support: {
    start: ['tango', 'branches', 'branches', 'enchanted_mango', 'blood_grenade', 'faerie_fire'],
    early: ['tranquil_boots', 'magic_wand'], mid: ['glimmer_cape', 'force_staff', 'solar_crest'], late: ['aeon_disk', 'lotus_orb', 'guardian_greaves'],
  },
  supportInt: {
    start: ['tango', 'branches', 'branches', 'enchanted_mango', 'blood_grenade', 'faerie_fire'],
    early: ['arcane_boots', 'magic_wand'], mid: ['glimmer_cape', 'force_staff', 'aether_lens'], late: ['aeon_disk', 'lotus_orb', 'guardian_greaves'],
  },
  agiMelee: {
    start: ['tango', 'quelling_blade', 'branches', 'branches', 'slippers', 'circlet'],
    early: ['power_treads', 'wraith_band', 'magic_wand'], mid: ['manta', 'black_king_bar'], late: ['butterfly', 'skadi', 'satanic'],
  },
  agiRanged: {
    start: ['tango', 'branches', 'branches', 'slippers', 'circlet', 'faerie_fire'],
    early: ['power_treads', 'wraith_band', 'magic_wand'], mid: ['dragon_lance', 'maelstrom', 'black_king_bar'], late: ['hurricane_pike', 'mjollnir', 'butterfly', 'satanic'],
  },
  str: {
    start: ['tango', 'quelling_blade', 'branches', 'branches', 'gauntlets', 'faerie_fire'],
    early: ['phase_boots', 'bracer', 'magic_wand'], mid: ['blink', 'black_king_bar'], late: ['assault', 'heart', 'overwhelming_blink'],
  },
  intCore: {
    start: ['tango', 'branches', 'branches', 'circlet', 'mantle', 'faerie_fire'],
    early: ['null_talisman', 'power_treads', 'magic_wand'], mid: ['kaya_and_sange', 'black_king_bar', 'blink'], late: ['sheepstick', 'octarine_core', 'shivas_guard'],
  },
};

// Hand-written fallbacks for specific heroes whose type-based guess would be poor.
const HERO_BUILDS = {
  npc_dota_hero_pudge: {
    start: ['tango', 'branches', 'branches', 'faerie_fire', 'enchanted_mango', 'quelling_blade'],
    early: ['tranquil_boots', 'magic_wand'], mid: ['blink', 'aghanims_shard', 'blade_mail'], late: ['heart', 'ultimate_scepter', 'overwhelming_blink'],
  },
};

function genericBuild(h) {
  const melee = h.attack_type === 'Melee';
  let kind;
  if (!(h.roles || []).includes('Carry')) kind = h.primary_attr === 'int' ? 'supportInt' : 'support';
  else if (h.primary_attr === 'int') kind = 'intCore';
  else if (h.primary_attr === 'str' || (h.primary_attr === 'all' && melee)) kind = 'str';
  else kind = melee ? 'agiMelee' : 'agiRanged';
  const b = HERO_BUILDS[h.name] || GENERIC_BUILDS[kind];
  const ok = (list) => list.filter((k) => itemInfo(k)?.cost > 0);
  return { start: ok(b.start), early: ok(b.early), mid: ok(b.mid), late: ok(b.late), generic: true };
}

const itemInfo = (k) => S.consts?.items?.[k] || null;
const itemName = (k) => itemInfo(k)?.name || String(k || '').replace(/_/g, ' ');
const itemKey = (slot) => (slot?.name && slot.name !== 'empty' ? slot.name.replace(/^item_/, '') : null);

const partsMemo = new Map();
function deepParts(k, depth = 0) {
  if (partsMemo.has(k)) return partsMemo.get(k);
  const out = new Set();
  if (depth < 6) {
    for (const c of itemInfo(k)?.components || []) {
      out.add(c);
      for (const cc of deepParts(c, depth + 1)) out.add(cc);
    }
  }
  partsMemo.set(k, out);
  return out;
}

// OpenDota purchase popularity -> a clean "what to build" list per game phase.
function computeBuild(pop) {
  const ids = S.consts.itemIds;
  const rows = {};
  const firstPhase = {};
  PHASES.forEach(([p, field], i) => {
    rows[p] = Object.entries(pop[field] || {})
      .map(([id, n]) => ({ k: ids[id], n }))
      .filter((r) => r.k && itemInfo(r.k) && itemInfo(r.k).tier == null && itemInfo(r.k).cost > 0)
      .sort((a, b) => b.n - a.n);
    if (i > 0) for (const r of rows[p]) firstPhase[r.k] ??= i;
  });
  // For each item, the earliest phase in which something built from it shows up.
  const parentPhase = {};
  for (const [k, i] of Object.entries(firstPhase)) {
    for (const c of deepParts(k)) parentPhase[c] = Math.min(parentPhase[c] ?? 9, i);
  }
  const out = {};
  const seen = new Set();
  PHASES.forEach(([p], i) => {
    const max = Math.max(1, ...rows[p].map((r) => r.n));
    out[p] = rows[p].filter((r) => {
      if (r.n < max * (p === 'start' ? 0.12 : 0.18)) return false;
      if (p === 'start') return true;
      if (CONSUMABLES.has(r.k) || seen.has(r.k)) return false;
      const basic = !(itemInfo(r.k).components || []).length;
      if (parentPhase[r.k] != null) {
        if (basic && !STANDALONE.has(r.k)) return false; // just a piece of a bigger item
        if (!basic && parentPhase[r.k] <= i) return false; // upgraded in the same phase anyway
      }
      return true;
    }).map((r) => { seen.add(r.k); return r.k; }).slice(0, p === 'start' ? 7 : 6);
  });
  return out;
}

// Gold still needed for `k`, crediting parts already held, plus which basic parts are missing.
function need(k, pool, top = true) {
  const it = itemInfo(k);
  if (!it) return { cost: 0, missing: [] };
  if (!top) {
    const i = pool.indexOf(k);
    if (i >= 0) { pool.splice(i, 1); return { cost: 0, missing: [] }; }
  }
  const comps = it.components || [];
  if (!comps.length) return { cost: it.cost, missing: [k] };
  let cost = 0;
  let partsCost = 0;
  const missing = [];
  for (const c of comps) {
    const r = need(c, pool, false);
    cost += r.cost;
    missing.push(...r.missing);
    partsCost += itemInfo(c)?.cost || 0;
  }
  return { cost: cost + Math.max(0, it.cost - partsCost), missing };
}

// The AI's counter items, only if they belong to the match being played.
const aiCounters = (d) => (S.ai?.analysis && S.ai.matchId === d.map?.matchid ? S.ai.analysis.counters || [] : []);

// Some items can't be bought until a set time (e.g. Aghanim's Shard) — see "itemUnlocks" in config.json.
const unlockAt = (k) => S.config.itemUnlocks?.[k] ?? null;
const isLocked = (k, clock) => unlockAt(k) != null && clock < unlockAt(k);

// Everything you effectively have: items held (and their parts), plus consumed buffs that leave no item —
// Aghanim's Shard is eaten on purchase, and Aghanim's Blessing gives the Scepter effect with no Scepter item.
function ownedKeys(d) {
  const owned = new Set();
  for (const k of d.heldKeys) {
    owned.add(k);
    for (const c of deepParts(k)) owned.add(c);
  }
  if (d.hero.aghanims_shard) owned.add('aghanims_shard');
  if (d.hero.aghanims_scepter) ['ultimate_scepter', 'ultimate_scepter_2'].forEach((k) => owned.add(k));
  return owned;
}

function nextPurchase(d) {
  const b = S.build;
  if (!b || b.error || !S.consts || d.clock == null || d.clock < 0) return null;
  const owned = ownedKeys(d);
  const hasBoots = d.heldKeys.some((k) => BOOTS_ANY.has(k));
  // counter items for THIS match's enemies jump the queue
  const list = [...aiCounters(d).map((c) => c.key), ...(d.clock < 900 ? b.early : []), ...b.mid, ...b.late];
  const queue = [...new Set(list)].filter((k) => !owned.has(k) && !(hasBoots && BOOTS_T1.has(k)) && !isLocked(k, d.clock));
  if (!queue.length) return null;
  const key = queue[0];
  const r = need(key, [...d.heldKeys]);
  const part = [...new Set(r.missing)]
    .filter((m) => itemInfo(m) && itemInfo(m).cost <= d.gold)
    .sort((a, b2) => itemInfo(b2).cost - itemInfo(a).cost)[0] || null;
  return { key, cost: r.cost, canBuy: d.gold >= r.cost, part, queue: queue.slice(0, 4) };
}

function upcomingTimers(d) {
  if (d.clock == null || !(d.live || d.pre)) return [];
  const out = [];
  for (const t of S.config.timers || []) {
    if (!timerOn(t)) continue;
    let at = null;
    if (t.times) at = t.times.find((x) => x >= d.clock) ?? null;
    else if (t.every) at = d.clock <= t.first ? t.first : t.first + Math.ceil((d.clock - t.first) / t.every) * t.every;
    if (at != null) out.push({ ...t, at, left: Math.round(at - d.clock) });
  }
  return out.sort((a, b) => a.left - b.left);
}

function derive() {
  const g = S.game || {};
  const map = g.map || null;
  const player = g.player || {};
  const hero = g.hero || {};
  const items = g.items || {};
  const st = (map?.game_state || '').replace('DOTA_GAMERULES_STATE_', '');
  const range = (pre, a, b) => Array.from({ length: b - a }, (_, i) => items[pre + (a + i)] || null);
  const inv = range('slot', 0, 6);
  const back = range('slot', 6, 9);
  const stash = range('stash', 0, 6);
  const d = {
    g, map, player, hero, items, st,
    clock: map ? map.clock_time : null,
    connected: !!S.game && Date.now() - S.lastMsgAt < 45000,
    heroInfo: hero.id > 0 ? S.consts?.heroes?.[hero.id] || null : null,
    inv, back, stash,
    neutrals: Object.keys(items).filter((k) => /^neutral\d+$/.test(k)).sort().map((k) => items[k]),
    tp: items.teleport0 || null,
    heldKeys: [...inv, ...back, ...stash].map(itemKey).filter(Boolean),
    gold: player.gold ?? 0,
    picking: /HERO_SELECTION|STRATEGY_TIME|PLAYER_DRAFT|TEAM_SHOWCASE|WAIT_FOR/.test(st),
    pre: st === 'PRE_GAME',
    live: st === 'GAME_IN_PROGRESS',
    post: st === 'POST_GAME',
    paused: !!map?.paused,
    alive: hero.alive !== false,
    hpPct: hero.health_percent ?? (hero.max_health ? Math.round((100 * hero.health) / hero.max_health) : 100),
  };
  d.stashCount = stash.filter(itemKey).length;
  d.noTp = d.live && hero.id > 0 && 'teleport0' in items && (!itemKey(d.tp) || d.tp.charges === 0);
  d.hasNeutral = d.neutrals.some(itemKey);
  d.next = nextPurchase(d);
  d.timers = upcomingTimers(d);
  d.skill = d.live || d.pre ? nextSkill(d) : null;
  d.ult = Object.values(g.abilities || {}).find((a) => a.ultimate) || null;
  return d;
}

// ---------------- events -> voice ----------------
function detect(d, p) {
  const mid = d.map?.matchid;
  if (mid && mid !== S.matchId) {
    S.matchId = mid;
    S.spoken = {};
    S.announced.clear();
    S.alertLog = [];
    S.rosh = null;
    S.neutralTab = null;
  }
  if (!p) return;
  const name = d.heroInfo?.localized_name;
  const item = d.next ? itemName(d.next.key) : '';
  if (d.hero.id > 0 && !(p.hero.id > 0) && name) {
    say('pick', { fa: `${name}! بزن بریم. بیلدش آماده‌ست`, en: `${name}. Let's go!` }, 60);
  }
  if (d.pre && d.hero.id > 0 && !d.heldKeys.length) {
    say('start', { fa: 'آیتم‌های شروع رو بخر', en: 'Buy your starting items.' }, 600, 'buy');
  }
  if (!(d.live || d.pre) || d.paused) return;

  // a new AI analysis with a different #1 counter item: say it once
  const top = aiCounters(d)[0];
  if (top && S.aiSpoken !== top.key) {
    S.aiSpoken = top.key;
    say(`ai:${S.ai.analysis.id}`, { fa: `آیتم ضد دشمن: ${itemName(top.key)}. ${top.why}`, en: `Counter item: ${itemName(top.key)}.` }, 0, 'buy');
  }

  if (p.hero.level && d.hero.level > p.hero.level && d.hero.level <= 30) {
    const lv = d.hero.level;
    const sk = d.skill;
    say(`lvl${lv}`, sk
      ? { fa: `لِوِل ${faNum(lv)}. ${sk.talent ? 'تلنت ' : ''}${sk.dname} رو بگیر`, en: `Level ${lv}. Take ${sk.dname}.` }
      : { fa: `لِوِل ${faNum(lv)}. یه اسکیل بگیر`, en: `Level ${lv}. Skill up.` }, 0);
  }
  if (p.alive && !d.alive) {
    say('dead', d.next?.canBuy
      ? { fa: `مُردی. الان ${item} رو بخر`, en: `You died. Buy ${item}.` }
      : { fa: 'مُردی. وقت خریده', en: 'You died. Time to shop.' }, 10, 'danger');
  }
  if (d.alive && d.hpPct <= 25 && p.hpPct > 25) {
    say('lowhp', { fa: 'جونت کمه! برو عقب', en: 'Low health! Back off.' }, 12, 'danger');
  }

  for (const t of d.timers) {
    if (t.left < 0 || t.left > t.warn) continue;
    const k = `t:${t.id}@${t.at}`;
    if (S.announced.has(k)) continue;
    S.announced.add(k);
    const fa = (t.sayFa || `${t.fa}، {s} ثانیه دیگه`).replace('{s}', faNum(t.left));
    say(k, { fa, en: t.say.replace('{s}', t.left) }, 0);
  }
  const inBuild = (k) => ['early', 'mid', 'late'].some((ph) => S.build?.[ph]?.includes(k));
  for (const [k, t] of Object.entries(S.config.itemUnlocks || {})) {
    if (p.clock < t && d.clock >= t && inBuild(k) && !ownedKeys(d).has(k)) {
      say(`unlock:${k}`, { fa: `${itemName(k)} الان توی شاپ فعال شد`, en: `${itemName(k)} is now available.` }, 0, 'buy');
    }
  }
  if (d.next?.canBuy && d.live) {
    say(`buy:${d.next.key}`, { fa: `پول ${item} رو داری. بخرش`, en: `You can buy ${item}.` }, 90, 'buy');
  }
  if (d.noTp && d.alive && d.clock > 60) say('tp', { fa: 'تی‌پی نداری! یکی بخر', en: 'No TP scroll. Buy one.' }, 120);
  if (d.stashCount && d.alive) {
    S.stashSince ||= Date.now();
    if (Date.now() - S.stashSince > 8000) {
      say('stash', { fa: 'آیتمات توی استش موندن. کوریر رو بفرست', en: 'Items in stash. Send the courier.' }, 60);
    }
  } else {
    S.stashSince = 0;
  }
  if (!d.hasNeutral && d.live && d.clock > 45) say('neutral', { fa: 'آیتم نوترال انتخاب کن', en: 'Pick a neutral item.' }, 300);
  if (S.settings.ultVoice && d.ult && p.ult && d.ult.level > 0 && p.ult.cooldown > 0 && d.ult.cooldown === 0) {
    say('ult', { fa: 'آلتیمیت آماده‌ست', en: 'Ultimate ready.' }, 5);
  }
  for (const e of d.g.events || []) {
    if (!/roshan_killed/i.test(e.event_type || '') || S.rosh?.gt === e.game_time) continue;
    const offset = (d.map.game_time ?? 0) - (d.map.clock_time ?? 0);
    S.rosh = { gt: e.game_time, at: (e.game_time ?? d.map.game_time) - offset };
    say('rosh', { fa: 'روشان مُرد. هشت تا یازده دقیقه دیگه برمی‌گرده', en: 'Roshan is dead. Back in 8 to 11 minutes.' }, 30);
  }
}

function onState() {
  const p = S.d;
  const d = derive();
  if (d.hero.id > 0 && d.hero.id !== S.buildHeroId) loadBuild(d.hero.id);
  if (d.hero.id > 0 && d.hero.id !== S.skillsHeroId) loadSkills(d.hero.id);
  S.d = d;
  detect(d, p && p.connected ? p : null);
  syncShopClipboard(d);
  scheduleRender();
}

// Keeps the WHOLE next item's name on the clipboard (not just the piece): pasted into the shop search it shows
// the full recipe, and an item you can't afford yet goes to Quick Buy, which then buys the pieces in order.
// Only one window does it (the overlay when open), and only when the item changes.
function syncShopClipboard(d) {
  if (!S.settings.shopClip || !d.live || (!OVERLAY && S.overlays > 0)) return;
  const name = d.next && itemName(d.next.key);
  if (!name || name === S.lastClip) return;
  S.lastClip = name;
  fetch('/api/clipboard', { method: 'POST', body: JSON.stringify({ text: name }) }).catch(() => {});
}

// ---------------- the ONE instruction ----------------
function decideAction(d) {
  const next = d.next;
  const img = (k) => itemInfo(k)?.img;
  if (!d.connected) return { cls: 'idle', icon: '🔌', title: 'منتظر Dota 2 هستم…', sub: 'Dota رو باز کن. اگه بار اوله، مراحل پایین رو یه بار انجام بده 👇' };
  if (!d.map) return { cls: 'idle', icon: '🎮', title: 'تو منوی Dota هستی', sub: 'یه بازی پیدا کن — من آماده‌ام!' };
  if (d.post) {
    const pl = d.player;
    return { cls: 'calm', icon: '🎉', title: 'بازی تموم شد — GG!', sub: `K/D/A: ${pl.kills ?? 0}/${pl.deaths ?? 0}/${pl.assists ?? 0} · GPM ${pl.gpm ?? '-'}` };
  }
  if (!(d.hero.id > 0)) return { cls: 'info', icon: '🧙', title: 'هیروت رو انتخاب کن', sub: 'به محض انتخاب، بیلد و آیتم‌هاش رو نشونت می‌دم' };
  if (d.picking || d.clock < 0) {
    const start = S.build?.start || [];
    if (!start.length) return { cls: 'info', icon: '⏳', title: 'دارم بیلد هیروت رو می‌گیرم…', sub: '' };
    const heldPool = [...d.heldKeys];
    const missing = start.filter((k) => { const i = heldPool.indexOf(k); if (i < 0) return true; heldPool.splice(i, 1); return false; });
    return {
      cls: missing.length ? 'buy' : 'calm', icon: '🛒',
      title: missing.length ? 'آیتم‌های شروع رو بخر' : 'آیتم‌های شروع رو داری ✓',
      sub: missing.length ? 'پیشنهاد محبوب‌ترین‌ها برای این هیرو:' : 'برو لاین. موفق باشی 💪',
      icons: start,
      // the n-th copy of an item counts as owned if you hold at least n of it
      owned: start.map((k, i) => {
        const nth = start.slice(0, i + 1).filter((x) => x === k).length;
        return nth <= start.filter((x) => x === k).length - missing.filter((x) => x === k).length;
      }),
    };
  }
  if (d.paused) return { cls: 'info', icon: '⏸', title: 'بازی متوقف شده', sub: 'یه نفس عمیق بکش 😌' };
  if (!d.alive) {
    const bb = d.hero.buyback_cooldown === 0 && d.gold >= (d.hero.buyback_cost ?? Infinity);
    return {
      cls: 'dead', icon: '💀', title: `مُردی — ${faNum(d.hero.respawn_seconds ?? '?')} ثانیه تا زنده شدن`,
      sub: next?.canBuy ? `بهترین وقت برای خریده: ${itemName(next.key)} 🛒` : bb ? `بای‌بک داری (${faNum(d.hero.buyback_cost)} طلا)` : 'تا زنده بشی، آیتم بخر و نقشه رو نگاه کن',
      img: next?.canBuy ? img(next.key) : null,
    };
  }
  if (d.hpPct <= 25) return { cls: 'danger', icon: '🏃', title: 'جونت کمه! برو عقب', sub: `فقط ${faNum(d.hpPct)}٪ جون داری — هیل کن یا برگرد بیس` };
  if (d.skill?.points > 0) {
    return {
      cls: 'info', icon: '🆙', img: d.skill.img,
      title: `${d.skill.talent ? 'تلنت' : 'اسکیل'} بگیر: ${d.skill.dname}`,
      sub: d.skill.talent ? 'این یه تلنته — از درخت تلنت انتخابش کن' : `ترتیب اسکیل از روی ${faNum(S.skills?.matches || 0)} بازی حرفه‌ای`,
    };
  }
  const soon = d.timers.find((t) => t.left >= 0 && t.left <= t.warn);
  if (soon) return { cls: 'warn', icon: '⏱', title: soon.left > 0 ? `${soon.fa} — ${faNum(soon.left)} ثانیه دیگه` : `${soon.fa} — همین الان!`, sub: '' };
  if (d.noTp && d.clock > 60) return { cls: 'warn', icon: '🌀', title: 'تی‌پی نداری!', sub: 'همین الان یکی بخر — بدون تی‌پی نمی‌تونی به کمک تیم بری' };
  const paste = S.settings.shopClip ? ' · شاپ: Ctrl+V' : '';
  if (next?.canBuy) return { cls: 'buy', icon: '💰', title: `بخر: ${itemName(next.key)}`, sub: `پولش رو داری! (${faNum(next.cost)} طلا)${paste}`, img: img(next.key) };
  if (d.stashCount) return { cls: 'info', icon: '🐴', title: 'آیتمات توی استش موندن!', sub: 'کوریر رو بفرست تا برات بیاره' };
  if (next?.part) return { cls: 'buy', icon: '🧩', title: `بخر: ${itemName(next.part)}`, sub: `یه تیکه از ${itemName(next.key)}${paste}`, img: img(next.part) };
  if (!d.hasNeutral && d.clock > 45 && d.heroInfo) {
    const best = neutralPicks(d, neutralState(d).nextTier);
    return { cls: 'info', icon: '💎', title: 'آیتم نوترال انتخاب کن', sub: `بهترین‌ها برات: ${itemName(best.artifacts[0])} + ${itemName(best.enchants[0])}` };
  }
  if (next) {
    const pct = Math.min(100, Math.round((100 * d.gold) / Math.max(1, next.cost)));
    return { cls: 'calm', icon: '🌾', title: 'آروم و پیوسته فارم کن', sub: `آیتم بعدی: ${itemName(next.key)} — ${faNum(next.cost - d.gold)} طلا کم داری`, img: img(next.key), progress: pct };
  }
  return { cls: 'calm', icon: '🌾', title: 'فارم کن و کنار تیمت باش', sub: '' };
}

// ---------------- rendering ----------------
function setHTML(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}
function show(el, on) { el.hidden = !on; }

function icon(k, cls = '') {
  const it = itemInfo(k);
  const name = it?.name || k;
  return `<span class="ic ${cls}" title="${esc(name)}">${it?.img ? `<img src="${esc(it.img)}" alt="${esc(name)}">` : `<b>${esc(name)}</b>`}</span>`;
}

function slotHTML(slot, extraCls = '') {
  const k = itemKey(slot);
  if (!k) return `<div class="slot empty ${extraCls}"></div>`;
  const it = itemInfo(k);
  const cd = slot.cooldown > 0 ? `<div class="cd">${Math.ceil(slot.cooldown)}</div>` : '';
  const ch = slot.charges > 0 ? `<span class="ch">${slot.charges}</span>` : '';
  const body = it?.img ? `<img src="${esc(it.img)}" alt="${esc(it.name)}" title="${esc(it.name)}">` : `<span class="nm">${esc(itemName(k))}</span>`;
  return `<div class="slot ${extraCls}">${body}${cd}${ch}</div>`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const d = S.d || derive();
  d.connected = !!S.game && Date.now() - S.lastMsgAt < 45000; // goes stale if Dota closes
  document.body.classList.toggle('simple', !!S.settings.simple);
  $('#btnVoice').classList.toggle('off', !S.settings.voice);
  $('#btnSimple').classList.toggle('off', !S.settings.simple);
  show($('#unlock'), S.settings.voice && !S.audioOk);
  show($('#demoBar'), S.source === 'demo' && d.connected);

  const conn = $('#conn');
  conn.className = `conn ${d.connected ? (S.source === 'demo' ? 'demo' : 'on') : ''}`;
  $('#connText').textContent = d.connected ? (S.source === 'demo' ? 'دمو' : 'وصل به Dota ✓') : 'Dota وصل نیست';
  $('#clock').textContent = d.map ? fmt(d.clock) : '--:--';
  $('#clock').title = d.map?.daytime === false ? 'شب' : 'روز';
  const team = d.player.team_name;
  if (d.map && (team === 'radiant' || team === 'dire')) {
    const us = team === 'radiant' ? d.map.radiant_score : d.map.dire_score;
    const them = team === 'radiant' ? d.map.dire_score : d.map.radiant_score;
    setHTML($('#score'), `${d.map.daytime === false ? '🌙' : '☀️'} <span class="us">ما ${us ?? 0}</span> — <span class="them">${them ?? 0} اونا</span>`);
  } else {
    setHTML($('#score'), d.map ? (d.map.daytime === false ? '🌙' : '☀️') : '');
  }

  document.body.classList.toggle('overlay', OVERLAY);
  if (OVERLAY) {
    renderAction(d);
    renderMini(d);
    return;
  }
  renderOnboard(d);
  renderAction(d);
  const inMatch = d.connected && d.map && d.hero.id > 0;
  show($('#hero'), inMatch);
  show($('#items'), inMatch && !d.picking);
  show($('#build'), inMatch && !!S.build);
  show($('#neutral'), inMatch && !!d.heroInfo);
  show($('#ai'), inMatch && !!S.ai);
  show($('#timers'), inMatch && (d.timers.length > 0 || !!S.rosh));
  show($('#log'), inMatch && S.alertLog.length > 0);
  if (!inMatch) return;
  renderHero(d);
  if (!d.picking) renderItems(d);
  if (S.build) renderBuild(d);
  if (d.heroInfo) renderNeutral(d);
  if (S.ai) renderAI(d);
  renderTimers(d);
  renderLog();
}

function renderAction(d) {
  const a = decideAction(d);
  const el = $('#action');
  el.className = `action ${a.cls}`;
  const icons = a.icons ? `<div class="icons" dir="ltr">${a.icons.map((k, i) => icon(k, a.owned?.[i] ? 'own' : '')).join('')}</div>` : '';
  const progress = a.progress != null ? `<div class="progress"><i style="width:${a.progress}%"></i></div>` : '';
  setHTML(el, `
    ${a.img ? `<img class="big-img" src="${esc(a.img)}" alt="">` : `<div class="ico">${a.icon}</div>`}
    <div class="txt">
      <div class="title">${esc(a.title)}</div>
      ${a.sub ? `<div class="sub">${esc(a.sub)}</div>` : ''}
      ${icons}${progress}
    </div>`);
}

// Under the instruction in the overlay: HP + gold, then next skill / next item / next timer.
function renderMini(d) {
  const el = $('#mini');
  if (!(d.connected && d.map && d.hero.id > 0) || d.picking) return setHTML(el, '');
  const hp = d.alive ? d.hpPct : 0;
  const t = d.timers[0];
  const sk = d.skill;
  const nx = d.next;
  const img = (src) => (src ? `<img src="${esc(src)}" alt="" onerror="this.remove()">` : '');
  setHTML(el, `
    <div class="row1">
      <div class="bar hp ${hp <= 25 ? 'low' : ''}"><i style="width:${hp}%"></i><span>${hp}%</span></div>
      <span class="g">💰 ${d.gold}</span>
    </div>
    <div class="row2">
      ${sk ? `<span class="c2 ${sk.points > 0 ? 'hot' : ''}">${img(sk.img)}اسکیل: ${esc(sk.dname)}</span>` : ''}
      ${nx ? `<span class="c2 ${nx.canBuy || nx.part ? 'buy' : ''}">${img(itemInfo(nx.key)?.img)}${esc(itemName(nx.key))}${S.settings.shopClip ? ' 📋' : ''}</span>` : ''}
      ${t ? `<span class="c2">⏱ ${esc(t.fa.replace(/\s*\(.*\)/, ''))} <b dir="ltr">${fmt(t.left)}</b></span>` : ''}
    </div>
    ${d.heroInfo ? neutralRows(d, img) : ''}
    ${aiRow(d, img)}`);
}

// The AI's best counter item for this match, plus the next two as icons.
function aiRow(d, img) {
  const cs = aiCounters(d);
  if (!cs.length) return '';
  return `<div class="row3"><span class="lbl">🛡</span>${cs.slice(0, 3).map((c, i) => (i === 0
    ? `<span class="c2 best ai">${img(itemInfo(c.key)?.img)}${esc(itemName(c.key))}</span>`
    : `<span class="alt" title="${esc(itemName(c.key))}">${img(itemInfo(c.key)?.img)}</span>`)).join('')}</div>`;
}

function renderAI(d) {
  const ai = S.ai;
  const el = $('#ai');
  const title = '<h2>⚔️ دشمن‌ها و آیتم ضد <span class="tag">هوش مصنوعی</span></h2>';
  if (!ai.enabled) {
    return setHTML(el, `${title}
      <p class="muted">برای اینکه مربی دشمن‌ها رو بشناسه و آیتم ضدشون رو بگه، کلید OpenRouter لازمه.</p>
      <div class="keyrow"><input id="aiKey" type="password" placeholder="sk-or-..." autocomplete="off" dir="ltr"><button data-act="ai-key">ذخیره</button></div>
      <p class="muted">کلید فقط روی همین کامپیوتر می‌مونه (فایل secrets.json).</p>`);
  }
  const hero = (id) => S.consts?.heroes?.[id];
  const portrait = (id) => (hero(id)?.img ? `<img class="ep" src="${esc(hero(id).img)}" alt="" title="${esc(hero(id).localized_name)}">` : '');
  const thisMatch = ai.matchId === d.map?.matchid;
  const an = thisMatch ? ai.analysis : null;
  const owned = ownedKeys(d);
  const status = {
    idle: '⏳ اول بازی دشمن‌ها رو از بالای صفحه می‌شناسم',
    scanning: '📸 دارم دشمن‌ها رو از بالای صفحه می‌شناسم…',
    analyzing: '🧠 دارم آیتم‌های ضد رو حساب می‌کنم…',
    error: `⚠️ ${ai.error || ''}`,
  }[ai.status] || '';
  setHTML(el, `${title}
    ${thisMatch && ai.enemies?.length ? `<div class="enemies">${ai.enemies.map(portrait).join('')}</div>` : ''}
    ${an?.summary ? `<p class="aisum">${esc(an.summary)}</p>` : ''}
    ${an?.counters?.length ? `<h3 class="nh">🛡 آیتم‌های ضد — به ترتیب</h3><ol class="nlist">${an.counters.map((c, i) => `
      <li class="${i === 0 ? 'top' : ''} ${owned.has(c.key) ? 'held' : ''}"><span class="rank">${RANK[i] || i + 1}</span>${icon(c.key)}
        <div><div class="nn">${esc(itemName(c.key))}${owned.has(c.key) ? ' ✓ داری' : ''}</div><div class="why">${esc(c.why)}</div></div></li>`).join('')}</ol>` : ''}
    ${an?.threats?.length ? `<h3 class="nh">⚠️ خطرناک‌ترین‌ها</h3><ul class="threats">${an.threats.map((t) => `
      <li>${portrait(t.heroId)}<div><b>${esc(t.hero)}</b><div class="why">${esc(t.why)}</div></div></li>`).join('')}</ul>` : ''}
    ${an?.tip ? `<p class="aitip">💡 ${esc(an.tip)}</p>` : ''}
    ${ai.status !== 'ready' ? `<p class="muted">${esc(status)}</p>` : ''}
    <div class="aifoot"><span class="muted" dir="ltr">AI cost this match: $${(ai.cost || 0).toFixed(4)}</span><button data-act="ai-rescan">🔄 دوباره اسکن کن</button></div>`);
}

// Best picks for the craft window: artifact (left column) and enchantment (right column).
function neutralRows(d, img) {
  const ns = neutralState(d);
  const { artifacts, enchants } = neutralPicks(d, ns.nextTier);
  const row = (label, keys) => `<div class="row3"><span class="lbl">${label}</span>${keys.slice(0, 3).map((k, i) => (i === 0
    ? `<span class="c2 best">${img(itemInfo(k)?.img)}${esc(itemName(k))}</span>`
    : `<span class="alt" title="${esc(itemName(k))}">${img(itemInfo(k)?.img)}</span>`)).join('')}</div>`;
  return row(`💎 T${faNum(ns.nextTier)}`, artifacts) + row('✨', enchants);
}

function renderOnboard(d) {
  const el = $('#onboard');
  const on = !d.connected;
  show(el, on);
  if (!on) return;
  const setup = S.config.setup;
  const cfgOk = !!setup?.cfgFile;
  const launchOk = !!setup?.launchOptionFound;
  const lan = (S.config.lanUrls || [])[0];
  setHTML(el, `
    <h2>🚀 راه‌اندازی — فقط یک بار</h2>
    <ol class="steps">
      <li>${cfgOk ? '<span class="st ok">✓ اتصال به Dota نصب شده</span>' : '<span class="st no">✗ اتصال نصب نشده</span> — فایل <code>START.bat</code> رو اجرا کن'}</li>
      <li>${launchOk ? '<span class="st ok">✓ Launch Option پیدا شد</span>' : `<span class="st no">Launch Option رو اضافه کن:</span><br>
        Steam ← روی Dota 2 راست‌کلیک ← <b>Properties</b> ← <b>Launch Options</b> ← اینو بنویس:<br>
        <code>-gamestateintegration</code> <button data-act="copy">📋 کپی</button>`}</li>
      <li>Dota 2 رو باز کن. <span class="muted">(اگه از قبل بازه، یه بار ببند و دوباره باز کن)</span></li>
      <li>همین! وقتی وارد بازی بشی، این صفحه خودش زنده می‌شه ⚡</li>
    </ol>
    <div class="row">
      <button class="bigbtn" data-act="demo-on">👀 دمو رو نشونم بده</button>
    </div>
    ${lan ? `<p class="muted">📱 روی گوشی (همون وای‌فای) اینو باز کن: <code>${esc(lan)}</code></p>` : ''}`);
}

function renderHero(d) {
  const h = d.hero;
  const info = d.heroInfo;
  const pl = d.player;
  const bad = [['stunned', 'استان'], ['silenced', 'سایلنس'], ['hexed', 'هکس'], ['disarmed', 'دیزارم'], ['muted', 'میوت'], ['break', 'بریک']]
    .filter(([k]) => h[k]).map(([, fa]) => `<span class="chip bad">${fa}</span>`);
  const good = [h.smoked && 'اسموک', h.magicimmune && 'ضد جادو', h.aghanims_scepter && 'Aghanim', h.aghanims_shard && 'Shard']
    .filter(Boolean).map((x) => `<span class="chip">${x}</span>`);
  const attr = { str: 'قدرتی', agi: 'چابکی', int: 'هوشی', all: 'یونیورسال' }[info?.primary_attr] || '';
  const hp = h.alive === false ? 0 : d.hpPct;
  const bbReady = h.buyback_cooldown === 0;
  // ✓ = can buy back now, -N = short N gold, m:ss = on cooldown
  const bb = h.buyback_cost ? (bbReady ? (d.gold >= h.buyback_cost ? '✓' : `-${h.buyback_cost - d.gold}`) : fmt(h.buyback_cooldown)) : '-';
  const abil = Object.values(d.g.abilities || {})
    .filter((a) => a.name && !HIDDEN_ABILITY.test(a.name))
    .map((a) => `<div class="ab ${a.ultimate ? 'ult' : ''} ${a.level ? '' : 'zero'}" title="${esc(a.name)}">
      <img src="${CDN}/apps/dota2/images/dota_react/abilities/${esc(a.name)}.png" alt="" onerror="this.style.opacity=0">
      ${a.cooldown > 0 ? `<div class="cd">${Math.ceil(a.cooldown)}</div>` : ''}
      <div class="pips">${'<i></i>'.repeat(Math.min(a.level || 0, 6))}</div></div>`).join('');
  setHTML($('#hero'), `
    <div class="hero-top">
      ${info?.img ? `<img class="portrait" src="${esc(info.img)}" alt="">` : ''}
      <div>
        <div class="hname">${esc(info?.localized_name || h.name || '')}<span class="lvl">Lv ${h.level ?? 1}</span></div>
        <div class="chips">${attr ? `<span class="chip">${attr}</span>` : ''}${info?.attack_type ? `<span class="chip">${info.attack_type === 'Melee' ? 'ملی' : 'رنج'}</span>` : ''}${bad.join('')}${good.join('')}</div>
      </div>
      <div class="gold" title="طلا">💰 ${d.gold}</div>
    </div>
    <div class="bar hp ${hp <= 25 ? 'low' : ''}"><i style="width:${hp}%"></i><span>HP ${h.health ?? 0} / ${h.max_health ?? 0}</span></div>
    <div class="bar mana"><i style="width:${h.mana_percent ?? 0}%"></i><span>${h.mana ?? 0} / ${h.max_mana ?? 0}</span></div>
    <div class="stats">
      <div class="stat"><b>${pl.kills ?? 0}/${pl.deaths ?? 0}/${pl.assists ?? 0}</b><small>کیل/مرگ/اسیست</small></div>
      <div class="stat"><b>${pl.last_hits ?? 0}/${pl.denies ?? 0}</b><small>لست‌هیت/دنای</small></div>
      <div class="stat"><b>${pl.gpm ?? 0}</b><small>طلا در دقیقه</small></div>
      <div class="stat"><b>${bb}</b><small>بای‌بک</small></div>
    </div>
    ${abil ? `<div class="abil">${abil}</div>` : ''}
    ${d.skill ? `<div class="nextskill ${d.skill.points > 0 ? 'hot' : ''}">🆙 اسکیل بعدی: ${d.skill.img ? `<img src="${esc(d.skill.img)}" alt="" onerror="this.remove()">` : ''}<b>${esc(d.skill.dname)}</b>
      <span class="muted">${d.skill.pro ? `(از ${faNum(S.skills?.matches || 0)} بازی حرفه‌ای)` : '(پیشنهاد کلی)'}</span></div>` : ''}`);
}

function renderItems(d) {
  const tpMissing = d.noTp;
  const neutralSlots = d.neutrals.length ? d.neutrals : [null];
  const stash = d.stashCount
    ? `<div class="stash">🐴 <b>آیتم تو Stash</b> — کوریر بفرست<div class="row">${d.stash.map((s) => slotHTML(s)).join('')}</div></div>`
    : '';
  setHTML($('#items'), `
    <h2>🎒 آیتم‌ها</h2>
    <div class="inv">${d.inv.map((s) => slotHTML(s)).join('')}</div>
    <div class="inv-extra">
      <div><div class="back">${d.back.map((s) => slotHTML(s)).join('')}</div><div class="lbl">کوله</div></div>
      <div>${slotHTML(d.tp, tpMissing ? 'tpmiss' : '')}<div class="lbl">TP</div></div>
      <div>${neutralSlots.map((s) => slotHTML(s, 'neutral')).join('')}<div class="lbl">Neutral</div></div>
    </div>
    ${stash}`);
}

function renderBuild(d) {
  const b = S.build;
  if (b.error) {
    setHTML($('#build'), '<h2>🛠 بیلد</h2><p class="muted">اطلاعات بیلد الان در دسترس نیست (اینترنت؟). بعداً دوباره امتحان می‌کنم.</p>');
    return;
  }
  const owned = ownedKeys(d);
  const next = d.next;
  let box = '';
  if (next) {
    const pct = Math.min(100, Math.round((100 * d.gold) / Math.max(1, next.cost)));
    box = `<div class="nextbox">${icon(next.key, 'next')}<div class="nb">
      <div><b>آیتم بعدی: ${esc(itemName(next.key))}</b></div>
      <div class="muted">${next.canBuy ? '✅ پولش رو داری — بخر!' : `${next.cost - d.gold} طلای دیگه لازمه`}</div>
      <div class="progress"><i style="width:${pct}%"></i></div></div></div>`;
  }
  const rows = PHASES.map(([p]) => b[p]?.length ? `<div class="phase"><div class="pn">${PHASE_FA[p]}</div><div class="row">${b[p]
    .map((k) => icon(k, owned.has(k) ? 'own' : next?.key === k ? 'next' : isLocked(k, d.clock) ? 'locked' : '')).join('')}</div></div>` : '').join('');
  const title = b.generic
    ? '🛠 بیلد عمومی <span class="tag">OpenDota فعلاً در دسترس نیست — مدام دوباره امتحان می‌کنم</span>'
    : '🛠 بیلد محبوب این هیرو <span class="tag">از بازی‌های اخیر</span>';
  setHTML($('#build'), `<h2>${title}</h2>${box}${rows}`);
}

function heroProfile(d) {
  const h = d.heroInfo;
  const roles = h.roles || [];
  const p = {
    any: 1,
    melee: +(h.attack_type === 'Melee'), ranged: +(h.attack_type === 'Ranged'),
    str: +(h.primary_attr === 'str'), agi: +(h.primary_attr === 'agi'), int: +(h.primary_attr === 'int'), all: +(h.primary_attr === 'all'),
  };
  for (const r of ['Nuker', 'Disabler', 'Initiator', 'Durable', 'Escape', 'Pusher']) p[r.toLowerCase()] = +roles.includes(r);
  let core = roles.includes('Carry') ? 1 : 0;
  const min = (d.clock || 0) / 60;
  const lh = d.player.last_hits;
  if (min >= 8 && lh != null) core = lh / min >= 2.8 ? 1 : lh / min < 1.3 ? 0 : core; // how you're actually playing it
  p.core = core;
  p.support = 1 - core;
  return p;
}

const isEnchant = (k) => !!k && k.startsWith('enhancement_');

// What you hold now: the artifact (neutral0) and its enchantment (neutral1). item_level is the crafted tier.
function neutralState(d) {
  const held = d.neutrals.filter((s) => itemKey(s));
  const tier = Math.max(0, ...held.map((s) => s.item_level || itemInfo(itemKey(s))?.tier || 0));
  return {
    artifact: itemKey(held.find((s) => !isEnchant(itemKey(s)))),
    enchant: itemKey(held.find((s) => isEnchant(itemKey(s)))),
    tier,
    nextTier: Math.min(5, tier + 1),
  };
}

// Both columns of the craft window, best fit for this hero first.
function neutralPicks(d, tier) {
  const prof = heroProfile(d);
  const score = (table, k) => Object.entries(table[k]?.w || {}).reduce((s, [f, w]) => s + w * (prof[f] || 0), 0);
  const rank = (keys, table) => keys.map((k) => ({ k, s: score(table, k) })).sort((a, b) => b.s - a.s).map((x) => x.k);
  return {
    prof,
    artifacts: rank(Object.keys(S.consts.items).filter((k) => S.consts.items[k].tier === tier && !isEnchant(k)), window.NEUTRALS),
    enchants: rank(Object.keys(window.ENCHANTMENTS).filter((k) => itemInfo(k)), window.ENCHANTMENTS),
  };
}

function renderNeutral(d) {
  const ns = neutralState(d);
  const tab = S.neutralTab ?? ns.nextTier;
  const { prof, artifacts, enchants } = neutralPicks(d, tab);
  const tabs = [1, 2, 3, 4, 5].map((t) => `<button data-act="ntab" data-tier="${t}" class="${t === tab ? 'on' : ''} ${t === ns.nextTier ? 'rec' : ''}">T${t}</button>`).join('');
  const rows = (keys, table, held, limit) => keys.slice(0, limit).map((k, i) => `
    <li class="${i < 3 ? 'top' : ''} ${held === k ? 'held' : ''}">
      <span class="rank">${RANK[i] || i + 1}</span>${icon(k)}
      <div><div class="nn">${esc(itemName(k))}${held === k ? ' ✓ داری' : ''}</div><div class="why">${esc(table[k]?.fa || '')}</div></div>
    </li>`).join('');
  setHTML($('#neutral'), `
    <h2>💎 آیتم نوترال — مخصوص ${esc(d.heroInfo.localized_name)} <span class="tag">${prof.core ? 'نقش: کور' : 'نقش: ساپورت'}</span></h2>
    <div class="tabs">${tabs}</div>
    <p class="muted" style="margin:0 0 8px">توی پنجره‌ی Craft، از هر ستون <b>اونی که توی این لیست بالاتره</b> رو بردار 👇</p>
    <h3 class="nh">Artifact <span class="muted">(ستون چپ)</span></h3>
    <ol class="nlist">${rows(artifacts, window.NEUTRALS, ns.artifact, 12) || '<li>آیتمی برای این Tier پیدا نشد</li>'}</ol>
    <h3 class="nh">Enchantment <span class="muted">(ستون راست)</span></h3>
    <ol class="nlist">${rows(enchants, window.ENCHANTMENTS, ns.enchant, 8)}</ol>`);
}

function renderTimers(d) {
  const rows = d.timers.slice(0, 5).map((t) => `<li class="${t.left <= t.warn ? 'soon' : ''}"><span>${esc(t.fa)}</span><b>${fmt(t.left)}</b></li>`);
  if (S.rosh && d.clock != null) {
    const min = S.rosh.at + 480 - d.clock;
    const max = S.rosh.at + 660 - d.clock;
    if (max > 0) rows.unshift(`<li class="${min <= 0 ? 'soon' : ''}"><span>🐉 روشان برمی‌گرده</span><b>${min > 0 ? `${fmt(min)} – ${fmt(max)}` : `تا ${fmt(max)}`}</b></li>`);
  }
  setHTML($('#timers'), `<h2>⏱ تایمرها</h2><ul class="tlist">${rows.join('')}</ul>`);
}

function renderLog() {
  setHTML($('#log'), `<h2>🔔 هشدارهای اخیر</h2><ul class="log">${S.alertLog
    .map((a) => `<li><span>${fmt(a.clock)}</span>${esc(a.text)}</li>`).join('')}</ul>`);
}

// ---------------- settings dialog ----------------
function openSettings() {
  const dlg = $('#settings');
  const timers = (S.config.timers || []).map((t) => `<label><input type="checkbox" data-timer="${esc(t.id)}" ${timerOn(t) ? 'checked' : ''}> ${esc(t.fa)}</label>`).join('');
  const lan = (S.config.lanUrls || []).map((u) => `<code>${esc(u)}</code>`).join(' ');
  setHTML(dlg, `
    <h3>⚙️ تنظیمات</h3>
    <label><input type="checkbox" data-set="voice" ${S.settings.voice ? 'checked' : ''}> 🔊 صدای مربی</label>
    <label>🗣 زبان صدا:
      <select data-setval="lang">
        <option value="fa" ${S.settings.lang !== 'en' ? 'selected' : ''}>فارسی</option>
        <option value="en" ${S.settings.lang === 'en' ? 'selected' : ''}>English</option>
      </select></label>
    ${voices.fa.length
      ? `<label>🎙 گوینده: <select data-setval="faVoice">${voices.fa.map((v) => `<option value="${esc(v.name)}" ${faVoice()?.name === v.name ? 'selected' : ''}>${esc(voiceLabel(v))}</option>`).join('')}</select></label>`
      : '<p class="warnline">⚠️ این مرورگر صدای فارسی نداره، برای همین انگلیسی حرف می‌زنم. برای صدای فارسی، صفحه رو با Microsoft Edge باز کن (فایل START.bat خودش با Edge بازش می‌کنه).</p>'}
    <label><input type="checkbox" data-set="simple" ${S.settings.simple ? 'checked' : ''}> 🧘 حالت خیلی ساده (فقط دستور اصلی + HP)</label>
    <label><input type="checkbox" data-set="ultVoice" ${S.settings.ultVoice ? 'checked' : ''}> ✨ بگو وقتی آلتیمیت آماده شد</label>
    <label><input type="checkbox" data-set="shopClip" ${S.settings.shopClip ? 'checked' : ''}> 📋 اسم آیتم بعدی رو کپی کن (توی شاپ: Ctrl+V)</label>
    <h3 style="margin-top:14px">⏱ هشدار تایمرها</h3>
    ${timers}
    ${lan ? `<p class="muted">📱 روی گوشی: ${lan}</p>` : ''}
    <div class="row"><button data-act="test-voice">🔈 تست صدا</button><button data-act="close">بستن</button></div>`);
  dlg.showModal();
}

const voiceLabel = (v) => (/دلارا|dilara/i.test(v.name) ? 'دلارا (خانم)' : /فرید|farid/i.test(v.name) ? 'فرید (آقا)' : v.name);
const SAMPLE = { fa: 'سلام! من مربی دوتای تو هستم. پول بلک کینگ بار رو داری، بخرش', en: 'Hi! You can buy Black King Bar.' };

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.set) S.settings[el.dataset.set] = el.checked;
  else if (el.dataset.timer) S.settings.timers[el.dataset.timer] = el.checked;
  else if (el.dataset.setval) {
    S.settings[el.dataset.setval] = el.value;
    speechSynthesis.cancel();
    speak(SAMPLE, 'info'); // let them hear the new voice right away (the overlay does it itself when open)
  } else return;
  saveSettings();
  onState();
});

document.addEventListener('click', async (e) => {
  if (!S.audioOk) {
    S.audioOk = true; // any click unlocks browser audio
    if (S.settings.voice) speak({ fa: 'مربی آماده‌ست', en: 'Coach ready.' }, 'info');
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return scheduleRender();
  const act = btn.dataset.act;
  if (act === 'voice') { S.settings.voice = !S.settings.voice; saveSettings(); if (!S.settings.voice) speechSynthesis.cancel(); }
  else if (act === 'simple') { S.settings.simple = !S.settings.simple; saveSettings(); }
  else if (act === 'settings') openSettings();
  else if (act === 'close') $('#settings').close();
  else if (act === 'test-voice') {
    if (S.overlays > 0) fetch('/api/test-voice', { method: 'POST' }).catch(() => {}); // the overlay is the one talking
    else speak(SAMPLE, 'buy');
  }
  else if (act === 'ntab') S.neutralTab = Number(btn.dataset.tier);
  else if (act === 'ai-key') {
    const r = await getJson('/api/ai/key', { method: 'POST', body: JSON.stringify({ key: $('#aiKey')?.value }) }).catch(() => ({ ok: false }));
    btn.textContent = r.ok ? '✓ ذخیره شد' : '✗ کلید درست نیست';
  } else if (act === 'ai-rescan') fetch('/api/ai/rescan', { method: 'POST' }).catch(() => {});
  else if (act === 'copy') { try { await navigator.clipboard.writeText('-gamestateintegration'); btn.textContent = '✓ کپی شد'; } catch {} }
  else if (act === 'demo-on' || act === 'demo-off') { try { await getJson(`/api/demo?on=${act === 'demo-on' ? 1 : 0}`, { method: 'POST' }); } catch {} }
  scheduleRender();
});

// ---------------- live connection ----------------
// The overlay can't be clicked, so tell the server whether speaking actually works there.
function overlayVoiceCheck() {
  if (!OVERLAY || !('speechSynthesis' in window)) return;
  const report = (ok, error) => fetch('/api/voice-status', { method: 'POST', body: JSON.stringify({ ok, error, voice: faVoice()?.name || null }) }).catch(() => {});
  const u = new SpeechSynthesisUtterance(S.settings.lang !== 'en' && faVoice() ? 'مربی آماده‌ست' : 'Coach ready.');
  const v = (S.settings.lang !== 'en' && faVoice()) || voices.en;
  if (v) { u.voice = v; u.lang = v.lang; }
  u.onstart = () => report(true);
  u.onerror = (e) => report(false, e.error);
  speechSynthesis.speak(u);
}

function connect() {
  const es = new EventSource(OVERLAY ? '/events?overlay=1' : '/events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'ping') {
      S.overlays = m.overlays || 0;
    } else if (m.type === 'ai') {
      S.ai = m.ai;
      onState();
    } else if (m.type === 'settings') {
      applySettings(m.settings);
    } else if (m.type === 'test-voice') {
      if (OVERLAY) speak(SAMPLE, 'buy');
    } else if (m.type === 'version') {
      if (S.bootId && S.bootId !== m.v) location.reload(); // server restarted with new code
      S.bootId = m.v;
    } else if (m.type === 'state') {
      S.game = m.state;
      S.source = m.source;
      S.lastMsgAt = Date.now() - (m.ago || 0);
      onState();
    } else if (m.type === 'reset') {
      S.game = null;
      S.source = 'none';
      S.d = null;
      onState();
    }
  };
}

loadConfig();
loadConsts();
loadSharedSettings();
getJson('/api/ai').then((a) => { S.ai = a; onState(); }).catch(() => {});
connect();
setTimeout(overlayVoiceCheck, 2500); // give the voice list time to load
setInterval(() => { if (!S.d?.connected) loadConfig(); }, 15000);
setInterval(scheduleRender, 1000);
scheduleRender();
