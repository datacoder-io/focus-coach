'use strict';
// Dota 2 ADHD Coach — local server.
// Dota 2 pushes live game state here through Valve's official Game State Integration (GSI),
// and the dashboard in /public receives it in real time over Server-Sent Events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const { createDemo } = require('./demo');
const { createAI } = require('./ai');

const ROOT = __dirname;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const CONFIG = readJson(path.join(ROOT, 'config.json'));
const PORT = CONFIG.port || 3005;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const OPENDOTA = 'https://api.opendota.com/api';
// Same data OpenDota serves, published as the npm package "dotaconstants" — used when OpenDota is down.
const CONSTANTS_MIRROR = 'https://cdn.jsdelivr.net/npm/dotaconstants/build';
const CDN = 'https://cdn.cloudflare.steamstatic.com';
const HOUR = 3600e3;
const BOOT_ID = Date.now();
const ARGS = new Set(process.argv.slice(2));

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- live state + SSE ----------
const clients = new Set();
const overlayClients = new Set(); // the small in-game window; while one is open, it alone does the talking
let voiceStatus = null; // what the overlay reported after trying to speak (it can't be clicked to unlock audio)
let lastState = null;
let lastAt = 0;
let source = 'none'; // 'dota' | 'demo' | 'none'
let demo = null;

const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
const broadcast = (msg) => { for (const res of clients) send(res, msg); };
const stateMsg = () => ({ type: 'state', source, ago: Date.now() - lastAt, state: lastState });

function pushState(state, from) {
  lastState = state;
  lastAt = Date.now();
  source = from;
  broadcast(stateMsg());
  if (from === 'dota') ai.onState(state);
}

// Requests from this PC only — a phone on the Wi-Fi must not touch your clipboard or API key.
const isLocal = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');

const pingMsg = () => ({ type: 'ping', source, ago: lastAt ? Date.now() - lastAt : null, overlays: overlayClients.size });
setInterval(() => broadcast(pingMsg()), 5000);

function startDemo() {
  if (!demo) demo = createDemo((s) => pushState(s, 'demo'));
}

function stopDemo({ reset = true } = {}) {
  if (!demo) return;
  demo.stop();
  demo = null;
  if (reset) {
    lastState = null;
    lastAt = 0;
    source = 'none';
    broadcast({ type: 'reset' });
  }
}

function handleGsi(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 5e6) req.destroy();
  });
  req.on('end', () => {
    res.writeHead(200);
    res.end();
    let state;
    try { state = JSON.parse(body); } catch { return; }
    if (CONFIG.token && state.auth?.token !== CONFIG.token) return;
    delete state.auth;
    if (demo) {
      // A real match always wins over the demo; menu heartbeats don't interrupt it.
      if (!state.map) return;
      stopDemo({ reset: false });
      console.log('Real Dota 2 match detected — demo stopped.');
    }
    if (source !== 'dota') console.log('Connected to Dota 2 ✓');
    pushState(state, 'dota');
  });
}

function handleEvents(req, res, isOverlay) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  send(res, { type: 'version', v: BOOT_ID }); // lets open pages reload themselves after an update
  clients.add(res);
  if (isOverlay) {
    overlayClients.add(res);
    broadcast(pingMsg());
  }
  if (lastState) send(res, stateMsg());
  req.on('close', () => {
    clients.delete(res);
    if (overlayClients.delete(res)) broadcast(pingMsg());
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
}

// ---------- hero / item data from OpenDota (cached on disk) ----------
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dota-adhd-coach' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.json();
}

// Disk cache: fresh copy if young enough, otherwise recompute; an old copy beats nothing when offline.
const inflight = new Map();
function cachedCompute(name, maxAgeMs, compute) {
  if (inflight.has(name)) return inflight.get(name);
  const job = (async () => {
    const file = path.join(CACHE_DIR, name);
    let stat = null;
    try { stat = fs.statSync(file); } catch {}
    if (stat && Date.now() - stat.mtimeMs < maxAgeMs) return readJson(file);
    try {
      const data = await compute();
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    } catch (e) {
      if (stat) return readJson(file);
      throw e;
    }
  })().finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}

// Tries each URL in order.
function cached(name, urls, maxAgeMs) {
  return cachedCompute(name, maxAgeMs, async () => {
    let lastErr = null;
    for (const url of [].concat(urls)) {
      try { return await fetchJson(url); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  });
}

// Skill order the way pros currently play the hero: the most typical order among a few recent pro matches.
async function buildSkillOrder(heroId) {
  const [ids, abilities, matches] = await Promise.all([
    cached('ability_ids.json', [`${OPENDOTA}/constants/ability_ids`, `${CONSTANTS_MIRROR}/ability_ids.json`], 72 * HOUR),
    cached('abilities.json', [`${OPENDOTA}/constants/abilities`, `${CONSTANTS_MIRROR}/abilities.json`], 72 * HOUR),
    fetchJson(`${OPENDOTA}/heroes/${heroId}/matches`),
  ]);
  const orders = [];
  for (const m of matches.slice(0, 10)) {
    if (orders.length >= 5) break;
    try {
      const match = await fetchJson(`${OPENDOTA}/matches/${m.match_id}`);
      const p = match.players?.find((x) => x.hero_id === Number(heroId));
      const order = (p?.ability_upgrades_arr || []).map((id) => ids[id]).filter(Boolean);
      if (order.length >= 10) orders.push(order);
    } catch {}
  }
  if (!orders.length) throw new Error('no skill data');
  const agree = (a, b) => a.reduce((n, x, i) => n + (x === b[i]), 0);
  const best = orders
    .map((o) => ({ o, score: orders.reduce((n, other) => n + agree(o, other), 0) + o.length / 100 }))
    .sort((a, b) => b.score - a.score)[0].o;
  return {
    matches: orders.length,
    order: best.map((name) => ({
      name,
      // talent names carry value placeholders like "+{s:value}s Dismember Duration" — drop them with their unit
      dname: String(abilities[name]?.dname || name).replace(/[+\-x]?\{s:[^}]+\}[%sx]?\s*/g, '').trim(),
      img: abilities[name]?.img ? CDN + abilities[name].img : null,
      talent: name.startsWith('special_bonus'),
    })),
  };
}

let constantsPromise = null;
function getConstants() {
  constantsPromise ??= buildConstants().catch((e) => { constantsPromise = null; throw e; });
  return constantsPromise;
}

async function buildConstants() {
  const [heroes, items] = await Promise.all([
    cached('heroes.json', [`${OPENDOTA}/constants/heroes`, `${CONSTANTS_MIRROR}/heroes.json`], 72 * HOUR),
    cached('items.json', [`${OPENDOTA}/constants/items`, `${CONSTANTS_MIRROR}/items.json`], 72 * HOUR),
  ]);
  const outItems = {};
  const itemIds = {};
  for (const [key, it] of Object.entries(items)) {
    outItems[key] = {
      name: it.dname || key,
      cost: it.cost || 0,
      img: it.img ? CDN + it.img : null,
      components: it.components || null,
      tier: it.tier ?? null,
    };
    if (it.id != null) itemIds[it.id] = key;
  }
  const outHeroes = {};
  for (const h of Object.values(heroes)) {
    outHeroes[h.id] = {
      name: h.name,
      localized_name: h.localized_name,
      primary_attr: h.primary_attr,
      attack_type: h.attack_type,
      roles: h.roles || [],
      img: h.img ? CDN + h.img : null,
    };
  }
  return { heroes: outHeroes, items: outItems, itemIds };
}

const buildUrl = (heroId) => `${OPENDOTA}/heroes/${heroId}/itemPopularity`;

const ai = createAI({
  root: ROOT,
  cacheDir: CACHE_DIR,
  loadData: async (heroId) => {
    const [consts, abilities, heroAbilities] = await Promise.all([
      getConstants(),
      cached('abilities.json', [`${OPENDOTA}/constants/abilities`, `${CONSTANTS_MIRROR}/abilities.json`], 72 * HOUR),
      cached('hero_abilities.json', [`${OPENDOTA}/constants/hero_abilities`, `${CONSTANTS_MIRROR}/hero_abilities.json`], 72 * HOUR),
    ]);
    let build = null;
    try { build = await cached(`build_${heroId}.json`, buildUrl(heroId), 12 * HOUR); } catch {}
    return { consts, abilities, heroAbilities, build };
  },
  onChange: (state) => broadcast({ type: 'ai', ai: state }),
});

// Quietly keeps every hero's build on disk (refreshed weekly), so an OpenDota outage
// mid-session never leaves you without a hero-specific build.
async function prefetchBuilds() {
  try {
    const { heroes } = await getConstants();
    for (const id of Object.keys(heroes)) {
      const file = path.join(CACHE_DIR, `build_${id}.json`);
      let fresh = false;
      try { fresh = Date.now() - fs.statSync(file).mtimeMs < 7 * 24 * HOUR; } catch {}
      if (fresh) continue;
      fs.writeFileSync(file, JSON.stringify(await fetchJson(buildUrl(id))));
      await new Promise((r) => setTimeout(r, 1500)); // stay well under OpenDota's free rate limit
    }
    setTimeout(prefetchBuilds, 24 * HOUR);
  } catch {
    setTimeout(prefetchBuilds, 10 * 60e3); // OpenDota down — try again later
  }
}

// ---------- misc ----------
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

function setupInfo() {
  try { return readJson(path.join(CACHE_DIR, 'setup.json')); } catch { return null; }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function openWindow(url) {
  // Edge "app mode" gives a clean window with no tabs or address bar; fall back to the default browser.
  exec(`start "" msedge --app=${url} --window-size=560,1000`, (err) => {
    if (err) exec(`start "" ${url}`);
  });
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/') return handleGsi(req, res);
    if (url.pathname === '/events') return handleEvents(req, res, url.searchParams.has('overlay'));
    if (url.pathname === '/api/voice-status' && req.method === 'POST') {
      voiceStatus = { ...(await readBody(req)), at: new Date().toISOString() };
      console.log('Overlay voice:', JSON.stringify(voiceStatus));
      return sendJson(res, { ok: true });
    }
    if (url.pathname === '/api/status') return sendJson(res, { source, overlays: overlayClients.size, voiceStatus });
    // Settings live here, not in each window: the overlay runs in its own browser profile and can't be clicked.
    if (url.pathname === '/api/settings') {
      const file = path.join(CACHE_DIR, 'settings.json');
      if (req.method === 'POST') {
        const settings = await readBody(req);
        if (settings && typeof settings === 'object') {
          fs.writeFileSync(file, JSON.stringify(settings));
          broadcast({ type: 'settings', settings });
        }
        return sendJson(res, { ok: true });
      }
      try { return sendJson(res, readJson(file)); } catch { return sendJson(res, {}); }
    }
    // Puts the next item's name on the clipboard so it can be pasted (Ctrl+V) into the shop search.
    if (url.pathname === '/api/clipboard' && req.method === 'POST') {
      const text = (await readBody(req))?.text;
      if (!isLocal(req) || typeof text !== 'string' || !/^[\w '’.-]{1,60}$/.test(text)) return sendJson(res, { ok: false }, 400);
      const clip = spawn('clip');
      clip.on('error', () => {});
      clip.stdin.end(text);
      return sendJson(res, { ok: true });
    }
    if (url.pathname === '/api/ai') return sendJson(res, ai.publicState());
    if (url.pathname === '/api/ai/key' && req.method === 'POST') {
      if (!isLocal(req)) return sendJson(res, { ok: false }, 403);
      return sendJson(res, { ok: ai.saveKey((await readBody(req))?.key) });
    }
    if (url.pathname === '/api/ai/license' && req.method === 'POST') {
      if (!isLocal(req)) return sendJson(res, { ok: false }, 403);
      return sendJson(res, await ai.saveLicense((await readBody(req))?.key));
    }
    if (url.pathname === '/api/ai/rescan' && req.method === 'POST') {
      ai.rescan();
      return sendJson(res, { ok: true });
    }
    if (url.pathname === '/api/test-voice' && req.method === 'POST') {
      broadcast({ type: 'test-voice' });
      return sendJson(res, { ok: true });
    }
    if (url.pathname === '/api/constants') return sendJson(res, await getConstants());
    const m = url.pathname.match(/^\/api\/build\/(\d+)$/);
    if (m) return sendJson(res, await cached(`build_${m[1]}.json`, buildUrl(m[1]), 12 * HOUR));
    const sk = url.pathname.match(/^\/api\/skills\/(\d+)$/);
    if (sk) return sendJson(res, await cachedCompute(`skills_${sk[1]}.json`, 24 * HOUR, () => buildSkillOrder(sk[1])));
    if (url.pathname === '/api/config') {
      return sendJson(res, { timers: CONFIG.timers || [], itemUnlocks: CONFIG.itemUnlocks || {}, lanUrls: lanUrls(), setup: setupInfo() });
    }
    if (url.pathname === '/api/demo' && req.method === 'POST') {
      if (url.searchParams.get('on') === '1') startDemo();
      else stopDemo();
      return sendJson(res, { demo: !!demo });
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    return sendJson(res, { error: String(e.message || e) }, 502);
  }
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`Port ${PORT} is busy — the coach is probably already running.`);
  if (ARGS.has('--open')) openWindow(`http://localhost:${PORT}`);
  setTimeout(() => process.exit(0), 1500);
});

server.listen(PORT, '0.0.0.0', () => {
  const local = `http://localhost:${PORT}`;
  console.log('');
  console.log('  ==============================================');
  console.log('   Dota 2 ADHD Coach is running');
  console.log(`   On this PC:  ${local}`);
  for (const u of lanUrls()) console.log(`   On phone:    ${u}   (same Wi-Fi)`);
  console.log('   Keep this window open while you play.');
  console.log('  ==============================================');
  console.log('');
  if (ARGS.has('--demo')) startDemo();
  if (ARGS.has('--open')) openWindow(local);
  getConstants()
    .then(() => console.log('Hero & item data ready.'))
    .catch((e) => console.log('Could not load hero/item data yet (will retry):', e.message));
  setTimeout(prefetchBuilds, 5000);
});
