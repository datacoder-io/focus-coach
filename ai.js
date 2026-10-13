'use strict';
// Optional AI coach (OpenRouter): reads the enemy heroes from Dota's top bar, then suggests counter items
// for this match. Without an API key in secrets.json everything else keeps working and this part stays off.
// Calls are rare on purpose: one picture at the start, then a short text analysis every few minutes or on death.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
// Text analysis: cheap and fast. Reading hero portraits needs a stronger eye — small models misread most of
// them in testing (one call per match, ~$0.004). Both can be overridden in secrets.json ("model", "visionModel").
const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
const DEFAULT_VISION_MODEL = 'anthropic/claude-sonnet-5.5';
const ANALYZE_EVERY = 300; // game seconds between routine re-analyses
const SCAN_RETRY_MS = 30000;
const MAX_SCAN_TRIES = 6;
// never worth an AI suggestion (dust and sentries stay allowed: they counter invisible heroes)
const SKIP_ITEMS = /^(recipe_|ward_observer|ward_dispenser|tpscroll|tango|flask|clarity|enchanted_mango|faerie_fire|smoke_of_deceit|blood_grenade|branches|aegis|cheese|refresher_shard)/;

const SYSTEM = `You are a concise Dota 2 coach (patch 7.41) for a player with ADHD. From the match state, decide which items best counter the enemy lineup for THIS player's hero and role right now.
Rules:
- Suggest 2-4 counter items, best first, using item names exactly from the allowed list.
- Never suggest an item the player already has.
- Respect role, game time and gold: a support doesn't rush 6000-gold items; early on prefer affordable answers.
- Prefer items the hero commonly builds when they also answer the enemies.
- Every reason is ONE short, casual Persian (Farsi) sentence that names the enemy hero or ability it answers.
Also give up to 3 biggest enemy threats (one short Persian reason each), a one-sentence Persian summary of the enemy lineup, and one short Persian tip for right now.
Output ONLY JSON: {"enemy_summary_fa":"...","threats":[{"hero":"...","why_fa":"..."}],"counter_items":[{"item":"...","why_fa":"..."}],"tip_fa":"..."}`;

// The first complete {...} block in the answer — models sometimes add a second block or a note after it.
function parseJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  let depth = 0;
  let inString = false;
  for (let i = start; start >= 0 && i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('AI did not return JSON');
}

function createAI({ root, cacheDir, loadData, onChange }) {
  const secretsFile = path.join(root, 'secrets.json');
  const ai = { status: 'idle', error: null, matchId: null, allies: [], enemies: [], analysis: null, cost: 0, model: null };
  let busy = false;
  let lastState = null;
  let lastScanTry = 0;
  let scanTries = 0;
  let lastAnalysisClock = null;
  let lastDeathAnalysis = 0;
  let wasAlive = true;

  const secrets = () => {
    try { return JSON.parse(fs.readFileSync(secretsFile, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
  };
  const apiKey = () => String(secrets().openrouterApiKey || '').trim();
  const textModel = () => secrets().model || DEFAULT_MODEL;
  const visionModel = () => secrets().visionModel || DEFAULT_VISION_MODEL;
  const publicState = () => ({ ...ai, enabled: !!apiKey(), model: textModel(), visionModel: visionModel() });
  const changed = () => onChange(publicState());
  const fail = (e) => {
    ai.status = 'error';
    ai.error = String(e.message || e).slice(0, 200);
    changed();
  };

  function saveKey(key) {
    const k = String(key || '').trim();
    if (!/^sk-or-[\w-]{20,}$/.test(k)) return false;
    fs.writeFileSync(secretsFile, JSON.stringify({ ...secrets(), openrouterApiKey: k, model: secrets().model || DEFAULT_MODEL }, null, 2));
    changed();
    if (lastState) onState(lastState);
    return true;
  }

  // Thinking is off by default: some models otherwise spend the whole token budget thinking and return nothing.
  // Models that insist on thinking get a short, low-effort think and a bigger budget instead.
  async function ask(model, messages, maxTokens, think = false) {
    const res = await fetch(OPENROUTER, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Dota 2 ADHD Coach',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: think ? maxTokens + 2000 : maxTokens,
        temperature: think ? undefined : 0.2,
        reasoning: think ? { effort: 'low' } : { enabled: false },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    ai.cost += Number(j.usage?.cost) || 0;
    const err = j.error?.message;
    if (!think && /reasoning is mandatory/i.test(err || '')) return ask(model, messages, maxTokens, true);
    if (!res.ok || err) throw new Error(err || `OpenRouter ${res.status}`);
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error(`no answer from ${model} (${j.choices?.[0]?.finish_reason || 'empty'})`);
    return text;
  }

  function capture() {
    const out = path.join(cacheDir, 'topbar.png');
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'capture.ps1'), '-Out', out],
        { timeout: 20000, windowsHide: true },
        (err) => (err ? reject(new Error('screen capture failed')) : resolve(fs.readFileSync(out).toString('base64'))));
    });
  }

  // 1) Who's in this match: one picture of the top bar.
  async function scan(state) {
    busy = true;
    lastScanTry = Date.now();
    scanTries++;
    ai.status = 'scanning';
    changed();
    try {
      const { consts } = await loadData(state.hero.id);
      const names = Object.values(consts.heroes).map((h) => h.localized_name).sort();
      const img = await capture();
      const myTeam = state.player?.team_name === 'dire' ? 'Dire' : 'Radiant';
      const text = await ask(visionModel(), [
        { role: 'system', content: 'You identify Dota 2 heroes from their in-game portraits. Answer with JSON only.' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This is a crop of the Dota 2 in-game top bar. The game clock is in the middle. The 5 hero portraits LEFT of the clock are the Radiant team, the 5 RIGHT of it are the Dire team. Grey portraits are dead heroes. '
                + `Known for sure: ${consts.heroes[state.hero.id].localized_name} is on ${myTeam}. `
                + `Identify every portrait in order from left to right, using names exactly from this list: ${names.join(', ')}. `
                + 'If a slot is empty or you are unsure, use null. Reply only with JSON: {"radiant":[5 names],"dire":[5 names]}',
            },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } },
          ],
        },
      ], 400, true);
      const j = parseJson(text);
      const byName = new Map(Object.entries(consts.heroes).map(([id, h]) => [h.localized_name.toLowerCase(), Number(id)]));
      const ids = (arr) => (Array.isArray(arr) ? arr : []).map((n) => (n ? byName.get(String(n).toLowerCase()) || null : null));
      const radiant = ids(j.radiant);
      const dire = ids(j.dire);
      const ours = state.player?.team_name === 'dire' ? dire : radiant;
      const theirs = state.player?.team_name === 'dire' ? radiant : dire;
      // sanity check: your own hero must be on your side, and most enemies readable (else Dota wasn't on screen)
      if (!ours.includes(state.hero.id) || theirs.filter(Boolean).length < 4) throw new Error('top bar not readable — is Dota on screen?');
      ai.allies = ours.filter((id) => id && id !== state.hero.id);
      ai.enemies = theirs.filter(Boolean);
      busy = false;
      await analyze(state, 'start');
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  // 2) What to build against them, given where the game is now.
  async function analyze(state, reason) {
    busy = true;
    ai.status = 'analyzing';
    changed();
    try {
      const { consts, abilities, heroAbilities, build } = await loadData(state.hero.id);
      const hero = (id) => consts.heroes[id];
      const itemName = (k) => consts.items[k]?.name || k;
      const me = hero(state.hero.id);
      const held = Object.entries(state.items || {})
        .filter(([slot, s]) => /^(slot|stash)\d+$/.test(slot) && s?.name && s.name !== 'empty')
        .map(([, s]) => itemName(s.name.replace(/^item_/, '')));
      const describe = (id) => {
        const h = hero(id);
        const lines = (heroAbilities[h.name]?.abilities || [])
          .filter((a) => a && !/generic_hidden/.test(a))
          .map((a) => {
            const ab = abilities[a];
            if (!ab?.dname) return null;
            const tags = [ab.dmg_type, ab.bkbpierce === 'Yes' ? 'pierces BKB' : null].filter(Boolean).join(', ');
            return `  - ${ab.dname}${tags ? ` [${tags}]` : ''}: ${String(ab.desc || '').replace(/\s+/g, ' ').slice(0, 150)}`;
          })
          .filter(Boolean);
        return `${h.localized_name} (${(h.roles || []).join(', ')}; ${h.attack_type})\n${lines.join('\n')}`;
      };
      const popular = build
        ? ['early_game_items', 'mid_game_items', 'late_game_items'].map((f) => Object.entries(build[f] || {})
          .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => itemName(consts.itemIds[id])).join(', '))
        : [];
      const allowed = Object.entries(consts.items).filter(([k, it]) => it.cost > 0 && it.tier == null && !SKIP_ITEMS.test(k)).map(([, it]) => it.name);
      const p = state.player || {};
      const clock = state.map.clock_time;
      const minutes = Math.max(1, clock / 60);
      const role = (me.roles || []).includes('Carry') && (clock < 480 || (p.last_hits || 0) / minutes >= 2) ? 'core' : 'support';
      const prompt = [
        `Game time: ${Math.floor(clock / 60)}:${String(Math.abs(clock) % 60).padStart(2, '0')}. Reason for this check: ${reason}.`,
        `My hero: ${me.localized_name} (${(me.roles || []).join(', ')}), playing as ${role}. Level ${state.hero.level}. Gold ${p.gold}. K/D/A ${p.kills}/${p.deaths}/${p.assists}. Last hits ${p.last_hits}.`,
        `My items: ${held.join(', ') || 'none'}.`,
        popular.length ? `Usual items for my hero — early: ${popular[0]}; mid: ${popular[1]}; late: ${popular[2]}.` : '',
        `Allies: ${ai.allies.map((id) => hero(id)?.localized_name).join(', ') || 'unknown'}.`,
        `Enemies and their abilities:\n${ai.enemies.map(describe).join('\n')}`,
        `Allowed item names: ${allowed.join(', ')}.`,
      ].filter(Boolean).join('\n');
      const j = parseJson(await ask(textModel(), [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], 1200));
      const itemKey = new Map(Object.entries(consts.items).map(([k, it]) => [it.name.toLowerCase(), k]));
      const heroId = new Map(Object.entries(consts.heroes).map(([id, h]) => [h.localized_name.toLowerCase(), Number(id)]));
      ai.analysis = {
        id: Date.now(),
        clock,
        reason,
        summary: String(j.enemy_summary_fa || '').slice(0, 220),
        tip: String(j.tip_fa || '').slice(0, 220),
        threats: (j.threats || []).slice(0, 3).map((t) => ({ heroId: heroId.get(String(t.hero || '').toLowerCase()) || null, hero: String(t.hero || ''), why: String(t.why_fa || '').slice(0, 160) })),
        counters: (j.counter_items || []).map((c) => ({ key: itemKey.get(String(c.item || '').toLowerCase()), why: String(c.why_fa || '').slice(0, 160) }))
          .filter((c) => c.key && !SKIP_ITEMS.test(c.key)).slice(0, 4),
      };
      lastAnalysisClock = clock;
      ai.status = 'ready';
      ai.error = null;
      changed();
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  }

  function onState(state) {
    lastState = state;
    const map = state.map;
    const hero = state.hero;
    if (!map || !(hero?.id > 0) || !apiKey()) return;
    if (map.matchid !== ai.matchId) {
      Object.assign(ai, { matchId: map.matchid, allies: [], enemies: [], analysis: null, cost: 0, status: 'idle', error: null });
      scanTries = 0;
      lastAnalysisClock = null;
      changed();
    }
    const died = wasAlive && hero.alive === false;
    wasAlive = hero.alive !== false;
    if (!/PRE_GAME|GAME_IN_PROGRESS/.test(map.game_state || '') || map.paused || busy) return;
    if (!ai.enemies.length) {
      if (scanTries < MAX_SCAN_TRIES && Date.now() - lastScanTry > SCAN_RETRY_MS) scan(state);
      return;
    }
    if (died && Date.now() - lastDeathAnalysis > 120000) {
      lastDeathAnalysis = Date.now();
      analyze(state, 'I just died');
    } else if (lastAnalysisClock == null || map.clock_time - lastAnalysisClock >= ANALYZE_EVERY) {
      analyze(state, 'routine check');
    }
  }

  function rescan() {
    ai.enemies = [];
    ai.allies = [];
    scanTries = 0;
    lastScanTry = 0;
    if (lastState) onState(lastState);
  }

  return { onState, publicState, saveKey, rescan };
}

module.exports = { createAI };
