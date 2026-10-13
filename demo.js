'use strict';
// Fake match generator: lets you see the dashboard working without launching Dota 2.
// Produces the same JSON shape that Dota's Game State Integration sends.

const SPEED = 4; // game seconds per real second
const TICK_MS = 500;
const START = -90;
const END = 2700;

// [from clock, items]
const INVENTORY = [
  [-9999, []],
  [-55, ['tango', 'quelling_blade', 'branches', 'branches', 'circlet', 'faerie_fire']],
  [200, ['quelling_blade', 'wraith_band', 'magic_wand', 'boots']],
  [430, ['quelling_blade', 'wraith_band', 'magic_wand', 'power_treads', 'ring_of_health']],
  [840, ['bfury', 'wraith_band', 'magic_wand', 'power_treads']],
  [1260, ['bfury', 'manta', 'magic_wand', 'power_treads']],
  [1900, ['bfury', 'manta', 'power_treads', 'skadi', 'black_king_bar']],
];
const NEUTRAL = [[-9999, null], [50, 'possessed_mask'], [960, 'poor_mans_shield'], [1560, 'serrated_shiv'], [2160, 'flayers_bota']];

const pick = (table, t) => table.filter(([from]) => t >= from).pop();
const slot = (name, extra = {}) => ({ name: name ? `item_${name}` : 'empty', can_cast: !!name, cooldown: 0, passive: false, ...extra });

function makeState(t) {
  const [boughtAt, inv] = pick(INVENTORY, t);
  const neutral = pick(NEUTRAL, t)[1];
  const picking = t < -75;
  const state = picking ? 'DOTA_GAMERULES_STATE_HERO_SELECTION' : t < -60 ? 'DOTA_GAMERULES_STATE_STRATEGY_TIME' : t < 0 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
  const pos = Math.max(0, t);
  const dead = t >= 600 && t < 640;
  const lowHp = t >= 560 && t < 600;
  const level = Math.min(30, 1 + Math.floor(pos / 75));
  const maxHp = 600 + level * 90;
  const hpPct = dead ? 0 : lowHp ? 18 : Math.round(62 + 35 * Math.sin(t / 23));
  const maxMana = 290 + level * 25;
  const manaPct = Math.round(55 + 40 * Math.cos(t / 31));
  const gold = t < -55 ? 600 : Math.min(9999, Math.floor(120 + (t - boughtAt) * (4.5 + pos / 450)));

  const items = {};
  for (let i = 0; i < 9; i++) items[`slot${i}`] = slot(inv[i], inv[i] === 'magic_wand' ? { charges: 7 + (Math.floor(t / 30) % 10) } : {});
  for (let i = 0; i < 6; i++) items[`stash${i}`] = slot(null);
  if (t >= 1650 && t < 1700) items.stash0 = slot('ultimate_orb');
  items.teleport0 = t >= 500 && t < 560 || picking ? slot(null) : slot('tpscroll', { charges: 1 });
  items.neutral0 = slot(neutral);

  const cd = (period, len) => Math.max(0, len - (pos % period));
  return {
    provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: Math.floor(Date.now() / 1000) },
    map: {
      name: 'start', matchid: 'demo', game_time: t + 90, clock_time: Math.floor(t),
      daytime: Math.floor(pos / 300) % 2 === 0, nightstalker_night: false,
      radiant_score: Math.floor(pos / 90), dire_score: Math.floor(pos / 110),
      game_state: state, paused: false, win_team: 'none',
    },
    player: {
      name: 'You', team_name: 'radiant', activity: 'playing',
      kills: Math.floor(pos / 160), deaths: Math.floor(pos / 600), assists: Math.floor(pos / 210),
      last_hits: Math.floor(pos / 9), denies: Math.floor(pos / 90),
      gold, gold_reliable: Math.floor(gold / 3), gold_unreliable: gold - Math.floor(gold / 3),
      gpm: Math.floor(320 + pos / 8), xpm: Math.floor(380 + pos / 7),
    },
    hero: picking ? { id: 0 } : {
      id: 8, name: 'npc_dota_hero_juggernaut', level, alive: !dead,
      respawn_seconds: dead ? 640 - Math.floor(t) : 0,
      buyback_cost: 200 + level * 60, buyback_cooldown: 0,
      health: Math.round(maxHp * hpPct / 100), max_health: maxHp, health_percent: hpPct,
      mana: Math.round(maxMana * manaPct / 100), max_mana: maxMana, mana_percent: manaPct,
      silenced: false, stunned: false, disarmed: false, magicimmune: false, hexed: false, muted: false, break: false, smoked: false, has_debuff: false,
    },
    abilities: picking ? {} : {
      ability0: { name: 'juggernaut_blade_fury', level: Math.min(4, Math.ceil(level / 2)), can_cast: true, passive: false, ability_active: true, cooldown: cd(40, 12), ultimate: false },
      ability1: { name: 'juggernaut_healing_ward', level: Math.min(4, Math.floor(level / 4)), can_cast: true, passive: false, ability_active: true, cooldown: cd(60, 8), ultimate: false },
      ability2: { name: 'juggernaut_blade_dance', level: Math.min(4, Math.floor(level / 3)), can_cast: false, passive: true, ability_active: true, cooldown: 0, ultimate: false },
      ability3: { name: 'juggernaut_omni_slash', level: level >= 18 ? 3 : level >= 12 ? 2 : level >= 6 ? 1 : 0, can_cast: true, passive: false, ability_active: true, cooldown: cd(90, 30), ultimate: true },
    },
    items,
    events: t >= 1500 && t < 1504 ? [{ event_type: 'roshan_killed', game_time: 1590, killed_by_team: 'radiant' }] : [],
  };
}

function createDemo(push) {
  let t = START;
  push(makeState(t));
  const timer = setInterval(() => {
    t += SPEED * TICK_MS / 1000;
    if (t > END) t = START;
    push(makeState(t));
  }, TICK_MS);
  return { stop: () => clearInterval(timer) };
}

module.exports = { createDemo };
