'use strict';

const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');
const MAP = require('../shared/map');

const DEFAULT_CONFIG = {
  minPlayers: 3,
  tasksPerPlayer: 3,
  taskPhaseMs: 150_000,
  discussionMs: 60_000,
  votingMs: 30_000,
  revealMs: 7_000,
  roleRevealMs: 5_000,
  killCooldownMs: 25_000,
  fakeVitalsMs: 25_000,
  spikeBpm: 10,
  vitalsStaleMs: 15_000,
  botTaskMinMs: 5_000,
  botTaskMaxMs: 11_000,
};

const TICK_MS = 66;
const STATE_EVERY_TICKS = 15;
const MAX_MOVE_PER_MESSAGE = 120;
const RANGE_SLACK = 15;
const MAX_FACE_SNAPSHOT_CHARS = 150_000;

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fb5', '#ecf0f1', '#8d6e63'];

const BOT_NAMES = ['Nova', 'Pixel', 'Juno', 'Rook', 'Echo', 'Sable'];

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class Game {
  constructor(config, clock = Date.now) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clock = clock;
    this.players = new Map();
    this.hostId = null;
    this.listeners = new Set();
    this.lastTickAt = clock();
    this.resetRound();
  }

  resetRound() {
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.meetingNumber = 0;
    this.meetingCaller = null;
    this.spotlight = null;
    this.lastEjection = null;
    this.winner = null;
    this.bodies = [];
    this.log = [];
    for (const p of this.players.values()) this.resetPlayer(p);
    this.resetPositions();
  }

  // ---- events -------------------------------------------------------------

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(event) {
    if (event.text) this.log = [...this.log.slice(-19), { at: this.clock(), text: event.text }];
    for (const fn of this.listeners) fn(event);
  }

  // ---- players ------------------------------------------------------------

  addPlayer({ clientId, name, isBot = false }) {
    const existing = clientId && [...this.players.values()].find((p) => p.clientId === clientId);
    if (existing) {
      existing.connected = true;
      if (name) existing.name = name.slice(0, 16);
      return existing;
    }
    if (this.phase !== 'lobby') throw new Error('Game already in progress');
    const used = new Set([...this.players.values()].map((p) => p.color));
    const player = {
      id: crypto.randomUUID().slice(0, 8),
      clientId: clientId || null,
      name: (name || 'Player').slice(0, 16),
      color: COLORS.find((c) => !used.has(c)) || COLORS[this.players.size % COLORS.length],
      isBot,
      connected: true,
      vitals: { bpm: null, confidence: 0, baseline: null, locked: false, hint: null, at: 0 },
    };
    this.players.set(player.id, player);
    if (!this.hostId && !isBot) this.hostId = player.id;
    this.resetPlayer(player);
    this.resetPositions();
    this.emit({ type: 'join', text: `${player.name} joined` });
    return player;
  }

  resetPlayer(p) {
    Object.assign(p, {
      role: null, alive: true, tasks: [], vote: null, killReadyAt: 0,
      fakeUntil: 0, fakeBpm: null, fakeUsedInMeeting: -1, spiking: false, ventId: null,
    });
    if (p.isBot) p.nav = { path: [], workingOn: null, workUntil: 0 };
  }

  resetPositions() {
    const list = [...this.players.values()];
    list.forEach((p, i) => {
      Object.assign(p, MAP.spawnPoint(i, list.length));
      if (p.nav) p.nav = { path: [], workingOn: null, workUntil: 0 };
    });
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(id);
      this.emit({ type: 'leave', text: `${p.name} left` });
    } else {
      p.connected = false;
    }
    if (this.hostId === id) {
      const next = [...this.players.values()].find((q) => !q.isBot && q.connected);
      this.hostId = next ? next.id : null;
    }
  }

  addBot() {
    if (this.phase !== 'lobby') return;
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) || `Bot${this.players.size}`;
    const bot = this.addPlayer({ name, isBot: true });
    const resting = 64 + Math.round(Math.random() * 14);
    bot.sim = { resting, bpm: resting, stress: 0 };
    bot.vitals = { bpm: resting, confidence: 90, baseline: resting, locked: true, hint: null, at: this.clock() };
  }

  removeBot() {
    if (this.phase !== 'lobby') return;
    const bot = [...this.players.values()].reverse().find((p) => p.isBot);
    if (bot) this.removePlayer(bot.id);
  }

  updateVitals(id, v) {
    const p = this.players.get(id);
    if (!p) return;
    p.vitals = {
      bpm: Number.isFinite(v.bpm) ? Math.round(v.bpm) : null,
      confidence: Number(v.confidence) || 0,
      baseline: Number.isFinite(v.baseline) ? Math.round(v.baseline) : null,
      locked: !!v.locked,
      hint: typeof v.hint === 'string' ? v.hint.slice(0, 80) : null,
      at: this.clock(),
    };
  }

  move(id, x, y) {
    const p = this.players.get(id);
    if (!p || p.isBot || p.ventId || this.phase !== 'tasks') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.hypot(x - p.x, y - p.y) > MAX_MOVE_PER_MESSAGE) return;
    if (p.alive ? !MAP.isWalkable(x, y, MAP.PLAYER_RADIUS - 2) : (x < 0 || y < 0 || x > MAP.WORLD.width || y > MAP.WORLD.height)) return;
    p.x = x;
    p.y = y;
  }

  vent(id, action) {
    const p = this.players.get(id);
    if (!p || p.role !== 'impostor' || !p.alive || this.phase !== 'tasks') return;
    let target = null;
    if (action === 'enter') {
      if (!p.ventId) target = MAP.nearestVent(p, MAP.VENT_RANGE + RANGE_SLACK);
    } else if (p.ventId && (action === 'next' || action === 'prev')) {
      target = MAP.ventNeighbor(p.ventId, action === 'next' ? 1 : -1);
    } else if (p.ventId && action === 'exit') {
      p.ventId = null;
      return;
    }
    if (!target) return;
    p.ventId = target.id;
    p.x = target.x;
    p.y = target.y;
  }

  hiddenFrom(p, viewerId) {
    return this.phase === 'tasks' && !!p.ventId && p.id !== viewerId;
  }

  // ---- derived ------------------------------------------------------------

  alive() { return [...this.players.values()].filter((p) => p.alive); }
  impostorsAlive() { return this.alive().filter((p) => p.role === 'impostor'); }
  crewAlive() { return this.alive().filter((p) => p.role === 'crew'); }

  redistributeTasks(deadPlayer) {
    if (deadPlayer.role !== 'crew') return;
    const unfinished = deadPlayer.tasks.filter((t) => !t.done);
    if (!unfinished.length) return;
    const survivors = this.crewAlive();
    if (!survivors.length) return;
    unfinished.forEach((task, i) => survivors[i % survivors.length].tasks.push(task));
    deadPlayer.tasks = deadPlayer.tasks.filter((t) => t.done);
  }

  taskProgress() {
    const crew = [...this.players.values()].filter((p) => p.role === 'crew');
    const total = crew.reduce((n, p) => n + p.tasks.length, 0);
    const done = crew.reduce((n, p) => n + p.tasks.filter((t) => t.done).length, 0);
    return total ? done / total : 0;
  }

  displayedVitals(p, now = this.clock()) {
    const v = p.vitals;
    if (!v.at || now - v.at > this.config.vitalsStaleMs) {
      return { bpm: null, baseline: v.baseline, delta: null, spike: false, locked: v.locked, hint: 'No signal' };
    }
    let bpm = v.bpm;
    if (p.fakeUntil > now && p.fakeBpm !== null) {
      bpm = p.fakeBpm + Math.round((Math.random() - 0.5) * 3);
    }
    const delta = bpm !== null && v.baseline !== null ? bpm - v.baseline : null;
    return {
      bpm,
      baseline: v.baseline,
      delta,
      spike: v.locked && delta !== null && delta >= this.config.spikeBpm,
      locked: v.locked,
      hint: v.hint,
    };
  }

  // ---- phase machine ------------------------------------------------------

  setPhase(phase, durationMs) {
    this.phase = phase;
    this.phaseEndsAt = durationMs ? this.clock() + durationMs : null;
  }

  start(byId) {
    if (byId !== this.hostId || this.phase !== 'lobby') return;
    const players = [...this.players.values()];
    if (players.length < this.config.minPlayers) {
      throw new Error(`Need at least ${this.config.minPlayers} players (add bots for testing)`);
    }
    for (const p of players) this.resetPlayer(p);
    const impostor = shuffle(players)[0];
    for (const p of players) {
      p.role = p === impostor ? 'impostor' : 'crew';
      p.tasks = shuffle(MAP.TASKS).slice(0, this.config.tasksPerPlayer).map((t) => ({ ...t, done: false }));
      p.killReadyAt = this.clock() + this.config.roleRevealMs + this.config.killCooldownMs;
    }
    this.meetingNumber = 0;
    this.winner = null;
    this.lastEjection = null;
    this.bodies = [];
    this.log = [];
    this.resetPositions();
    this.setPhase('roles', this.config.roleRevealMs);
    this.emit({ type: 'game_start', text: 'Shift started. One of you is an impostor.' });
  }

  completeTask(id, taskId) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'tasks' || !p.alive || p.ventId) return;
    const task = p.tasks.find((t) => t.id === taskId);
    if (!task || task.done) return;
    if (MAP.distance(p, task) > MAP.USE_RANGE + RANGE_SLACK) return;
    task.done = true;
    if (p.role === 'crew' && this.taskProgress() >= 1) this.finish('crew', 'All tasks completed!');
  }

  kill(id, targetId) {
    const killer = this.players.get(id);
    const target = this.players.get(targetId);
    if (this.phase !== 'tasks' || !killer || !target) return;
    if (killer.role !== 'impostor' || !killer.alive || killer.ventId || !target.alive || target.role === 'impostor') return;
    if (this.clock() < killer.killReadyAt) return;
    if (MAP.distance(killer, target) > MAP.KILL_RANGE + RANGE_SLACK) return;
    target.alive = false;
    this.redistributeTasks(target);
    killer.killReadyAt = this.clock() + this.config.killCooldownMs;
    this.bodies.push({ id: crypto.randomUUID().slice(0, 8), playerId: target.id, x: target.x, y: target.y });
    this.emit({ type: 'kill', private: true, playerId: target.id });
    this.checkWin();
  }

  callMeeting(id) {
    const p = this.players.get(id);
    if (this.phase !== 'tasks' || !p || !p.alive || p.ventId) return;
    if (MAP.distance(p, MAP.EMERGENCY_BUTTON) > MAP.BUTTON_RANGE + RANGE_SLACK) return;
    this.startMeeting(`${p.name} pressed the emergency button`);
  }

  report(id, bodyId) {
    const p = this.players.get(id);
    const body = this.bodies.find((b) => b.id === bodyId);
    if (this.phase !== 'tasks' || !p || !p.alive || p.ventId || !body) return;
    if (MAP.distance(p, body) > MAP.REPORT_RANGE + RANGE_SLACK) return;
    const victim = this.players.get(body.playerId);
    this.startMeeting(`${p.name} found ${victim ? victim.name : 'someone'}'s body`);
  }

  startMeeting(reason) {
    this.meetingNumber += 1;
    this.meetingCaller = reason;
    this.spotlight = null;
    this.bodies = [];
    for (const p of this.players.values()) {
      p.vote = null;
      p.spiking = false;
      p.ventId = null;
    }
    this.setPhase('discussion', this.config.discussionMs);
    this.emit({ type: 'meeting', text: reason });
  }

  accuse(id, targetId) {
    const by = this.players.get(id);
    const target = this.players.get(targetId);
    if (!by || !target || !by.alive || !target.alive) return;
    if (this.phase !== 'discussion' && this.phase !== 'voting') return;
    this.spotlight = { targetId, byId: id, at: this.clock() };
    this.emit({ type: 'accuse', targetId, text: `${by.name} accuses ${target.name}! Watch their pulse...` });
  }

  fakeVitals(id) {
    const p = this.players.get(id);
    if (!p || p.role !== 'impostor' || !p.alive) return;
    if (this.phase !== 'discussion' && this.phase !== 'voting') return;
    if (p.fakeUsedInMeeting === this.meetingNumber) return;
    p.fakeUsedInMeeting = this.meetingNumber;
    p.fakeUntil = this.clock() + this.config.fakeVitalsMs;
    p.fakeBpm = p.vitals.baseline ?? p.vitals.bpm ?? 70;
    this.emit({ type: 'fake_vitals', private: true, playerId: id });
  }

  vote(id, targetId) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase !== 'voting' || p.vote !== null) return;
    if (targetId !== 'skip') {
      const target = this.players.get(targetId);
      if (!target || !target.alive) return;
    }
    p.vote = targetId;
    this.emit({ type: 'vote', text: `${p.name} voted` });
    if (this.alive().every((q) => q.vote !== null)) this.tallyVotes();
  }

  tallyVotes() {
    const counts = new Map();
    for (const p of this.alive()) {
      const key = p.vote ?? 'skip';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topId, topCount] = ranked[0] || ['skip', 0];
    const tie = ranked.length > 1 && ranked[1][1] === topCount;
    const votes = [...this.players.values()]
      .filter((p) => p.alive)
      .map((p) => ({ voterId: p.id, targetId: p.vote ?? 'skip' }));

    if (topId === 'skip' || tie) {
      this.lastEjection = { playerId: null, wasImpostor: false, tie, votes };
      this.emit({ type: 'ejection', text: tie ? 'Tied vote. No one was ejected.' : 'Vote skipped. No one was ejected.' });
    } else {
      const ejected = this.players.get(topId);
      ejected.alive = false;
      this.redistributeTasks(ejected);
      this.lastEjection = { playerId: ejected.id, wasImpostor: ejected.role === 'impostor', tie: false, votes };
      this.emit({
        type: 'ejection',
        text: `${ejected.name} was ejected. ${ejected.role === 'impostor' ? 'They WERE the impostor.' : 'They were not the impostor.'}`,
      });
    }
    this.spotlight = null;
    this.setPhase('reveal', this.config.revealMs);
  }

  skipPhase(byId) {
    if (byId !== this.hostId) return;
    this.advance();
  }

  advance() {
    switch (this.phase) {
      case 'roles':
        this.setPhase('tasks', this.config.taskPhaseMs);
        break;
      case 'tasks':
        this.startMeeting('The shift timer ran out');
        break;
      case 'discussion':
        this.setPhase('voting', this.config.votingMs);
        this.emit({ type: 'voting', text: 'Voting is open!' });
        break;
      case 'voting':
        this.tallyVotes();
        break;
      case 'reveal':
        if (!this.checkWin()) {
          for (const p of this.players.values()) {
            if (p.role === 'impostor') p.killReadyAt = this.clock() + this.config.killCooldownMs;
          }
          this.resetPositions();
          this.setPhase('tasks', this.config.taskPhaseMs);
        }
        break;
      default:
        break;
    }
  }

  checkWin() {
    if (this.phase === 'lobby' || this.phase === 'gameover') return false;
    if (this.impostorsAlive().length === 0) return this.finish('crew', 'The impostor was caught!');
    if (this.impostorsAlive().length >= this.crewAlive().length) return this.finish('impostor', 'The impostor outnumbers the crew!');
    return false;
  }

  finish(winner, reason) {
    this.winner = { team: winner, reason };
    for (const p of this.players.values()) p.ventId = null;
    this.setPhase('gameover', null);
    this.emit({ type: 'gameover', text: reason });
    return true;
  }

  playAgain(byId) {
    if (byId !== this.hostId) return;
    for (const p of [...this.players.values()]) {
      if (!p.connected && !p.isBot) this.players.delete(p.id);
    }
    this.resetRound();
    this.emit({ type: 'lobby', text: 'Back to the lobby' });
  }

  // Drops whatever match is running so a new group can join. Used by the debug button.
  abandonGame() {
    this.players.clear();
    this.hostId = null;
    this.resetRound();
    this.emit({ type: 'lobby', text: 'Debug reset. The game was ended.' });
  }

  // ---- ticking ------------------------------------------------------------

  tick(now = this.clock()) {
    const dt = Math.min(1.5, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    this.tickBotVitals(now, dt);
    if (this.phase === 'tasks') this.tickBotsOnMap(now, dt);
    if (this.phase === 'voting') this.tickBotVotes(dt);
    if (this.phaseEndsAt && now >= this.phaseEndsAt) this.advance();
    if (this.phase === 'discussion' || this.phase === 'voting') {
      for (const p of this.alive()) {
        const { spike } = this.displayedVitals(p, now);
        if (spike && !p.spiking) {
          this.emit({ type: 'spike', playerId: p.id, text: `${p.name}'s pulse is spiking!` });
        }
        p.spiking = spike;
      }
    }
  }

  bots() { return [...this.players.values()].filter((p) => p.isBot); }

  tickBotVitals(now, dt) {
    for (const bot of this.bots()) {
      const s = bot.sim;
      const accused = this.spotlight && this.spotlight.targetId === bot.id && now - this.spotlight.at < 20_000;
      const rate = dt * (accused ? (bot.role === 'impostor' ? 5 : 2.5) : -1.2);
      s.stress = Math.min(28, Math.max(0, s.stress + rate));
      s.bpm += ((s.resting + s.stress - s.bpm) * 0.35 + (Math.random() - 0.5) * 2) * Math.min(1, dt);
      bot.vitals = { ...bot.vitals, bpm: Math.round(s.bpm), at: now };
    }
  }

  walk(bot, dist) {
    const path = bot.nav.path;
    while (dist > 0 && path.length) {
      const target = path[0];
      const d = MAP.distance(bot, target);
      if (d <= dist) {
        bot.x = target.x;
        bot.y = target.y;
        path.shift();
        dist -= d;
      } else {
        bot.x += ((target.x - bot.x) / d) * dist;
        bot.y += ((target.y - bot.y) / d) * dist;
        dist = 0;
      }
    }
  }

  tickBotsOnMap(now, dt) {
    for (const bot of this.bots()) {
      if (!bot.alive || this.phase !== 'tasks') continue;
      const nav = bot.nav;

      if (bot.role === 'crew') {
        const body = this.bodies.find((b) => MAP.distance(bot, b) <= MAP.REPORT_RANGE);
        if (body && Math.random() < dt * 0.8) {
          this.report(bot.id, body.id);
          return;
        }
      } else {
        const victim = this.crewAlive().find((p) => MAP.distance(bot, p) <= MAP.KILL_RANGE);
        if (victim && now >= bot.killReadyAt && Math.random() < dt * 0.6) {
          this.kill(bot.id, victim.id);
          if (this.phase !== 'tasks') return;
        }
      }

      if (nav.workingOn) {
        if (now < nav.workUntil) continue;
        this.completeTask(bot.id, nav.workingOn);
        nav.workingOn = null;
        if (this.phase !== 'tasks') return;
      }

      if (nav.path.length) {
        this.walk(bot, MAP.SPEED * dt);
        continue;
      }

      if (bot.role === 'impostor') {
        const targets = this.crewAlive();
        if (!targets.length) continue;
        const prey = targets.reduce((a, b) => (MAP.distance(bot, a) <= MAP.distance(bot, b) ? a : b));
        nav.path = MAP.nearestNode(bot) === MAP.nearestNode(prey) ? [{ x: prey.x, y: prey.y }] : MAP.route(bot, prey).slice(0, 2);
        continue;
      }

      const atTask = bot.tasks.find((t) => !t.done && MAP.distance(bot, t) <= MAP.USE_RANGE);
      if (atTask) {
        nav.workingOn = atTask.id;
        const { botTaskMinMs, botTaskMaxMs } = this.config;
        nav.workUntil = now + botTaskMinMs + Math.random() * (botTaskMaxMs - botTaskMinMs);
        continue;
      }
      const next = bot.tasks.find((t) => !t.done);
      const dest = next || MAP.TASKS[Math.floor(Math.random() * MAP.TASKS.length)];
      nav.path = MAP.route(bot, dest);
    }
  }

  tickBotVotes(dt) {
    for (const bot of this.bots()) {
      if (!bot.alive || bot.vote !== null || Math.random() > dt * 0.25) continue;
      const options = this.alive().filter((p) => p.id !== bot.id && !(bot.role === 'impostor' && p.role === 'impostor'));
      const suspect = this.spotlight && this.spotlight.targetId !== bot.id ? this.spotlight.targetId : null;
      const pick = suspect && Math.random() < 0.6 ? suspect : Math.random() < 0.3 ? 'skip' : (shuffle(options)[0] || { id: 'skip' }).id;
      this.vote(bot.id, pick);
    }
  }

  // ---- views --------------------------------------------------------------

  positions(viewerId) {
    return [...this.players.values()]
      .filter((p) => !this.hiddenFrom(p, viewerId))
      .map((p) => [p.id, Math.round(p.x), Math.round(p.y)]);
  }

  publicPlayer(p, now) {
    const revealRoles = this.phase === 'gameover';
    const ejected = this.lastEjection && this.lastEjection.playerId === p.id;
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
      connected: p.connected,
      alive: p.alive,
      isHost: p.id === this.hostId,
      role: revealRoles || ejected ? p.role : null,
      voted: p.vote !== null,
      x: Math.round(p.x),
      y: Math.round(p.y),
      vitals: this.displayedVitals(p, now),
    };
  }

  viewFor(playerId, now = this.clock()) {
    const me = this.players.get(playerId);
    const view = {
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      serverNow: now,
      hostId: this.hostId,
      meetingNumber: this.meetingNumber,
      meetingCaller: this.meetingCaller,
      spotlight: this.spotlight,
      lastEjection: this.phase === 'reveal' || this.phase === 'gameover' ? this.lastEjection : null,
      winner: this.winner,
      taskProgress: this.taskProgress(),
      config: { minPlayers: this.config.minPlayers, spikeBpm: this.config.spikeBpm },
      players: [...this.players.values()].filter((p) => !this.hiddenFrom(p, playerId)).map((p) => this.publicPlayer(p, now)),
      bodies: this.bodies,
      log: this.log,
      me: null,
    };
    if (me) {
      view.me = {
        id: me.id,
        role: me.role,
        alive: me.alive,
        tasks: me.tasks,
        vote: me.vote,
        killReadyAt: me.role === 'impostor' ? me.killReadyAt : null,
        fakeAvailable: me.role === 'impostor' && me.fakeUsedInMeeting !== this.meetingNumber,
        fakeUntil: me.role === 'impostor' ? me.fakeUntil : 0,
        ventId: me.ventId,
      };
    }
    return view;
  }
}

function createGameServer({ port = 7777, config = {}, log = console.log } = {}) {
  const game = new Game(config);
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Map();

  const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const broadcastState = () => {
    const now = game.clock();
    for (const [ws, playerId] of sockets) send(ws, { type: 'state', state: game.viewFor(playerId, now) });
  };
  const broadcastPositions = () => {
    for (const [ws, playerId] of sockets) send(ws, { type: 'positions', positions: game.positions(playerId) });
  };

  game.onEvent((event) => {
    for (const [ws, playerId] of sockets) {
      if (event.private && event.playerId !== playerId) continue;
      send(ws, { type: 'event', event });
    }
    broadcastState();
  });

  wss.on('connection', (ws, req) => {
    const remote = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    log(`[vital-verdict] connection from ${remote}`);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (err) {
        const preview = String(raw).slice(0, 80);
        log(`[vital-verdict] bad message from ${remote}: ${err.message} (${preview})`);
        return;
      }
      const playerId = sockets.get(ws);
      try {
        if (msg.type === 'abandon_game') {
          log(`[vital-verdict] debug reset from ${remote}`);
          game.abandonGame();
          for (const sock of [...sockets.keys()]) sockets.delete(sock);
          send(ws, { type: 'reset' });
          broadcastState();
          return;
        }
        if (msg.type === 'join') {
          log(`[vital-verdict] join request from ${remote} name="${msg.name || ''}"`);
          const player = game.addPlayer({ clientId: msg.clientId, name: msg.name });
          sockets.set(ws, player.id);
          log(`[vital-verdict] ${player.name} joined as ${player.id} from ${remote}`);
          send(ws, { type: 'welcome', playerId: player.id });
          broadcastState();
          return;
        }
        if (!playerId) {
          log(`[vital-verdict] ignored "${msg.type}" from ${remote} before they joined`);
          return;
        }
        switch (msg.type) {
          case 'hr_update': game.updateVitals(playerId, msg.vitals || {}); return;
          case 'face_snapshot': {
            if (typeof msg.jpeg !== 'string') return;
            if (msg.jpeg.length > MAX_FACE_SNAPSHOT_CHARS) {
              log(`[vital-verdict] rejected oversized face_snapshot from ${remote} (${msg.jpeg.length} chars)`);
              return;
            }
            const payload = JSON.stringify({ type: 'facecam', playerId, jpeg: msg.jpeg });
            for (const sock of sockets.keys()) {
              if (sock !== ws && sock.readyState === sock.OPEN) sock.send(payload);
            }
            return;
          }
          case 'move': game.move(playerId, Number(msg.x), Number(msg.y)); return;
          case 'start_game': game.start(playerId); break;
          case 'add_bot': if (playerId === game.hostId) game.addBot(); break;
          case 'remove_bot': if (playerId === game.hostId) game.removeBot(); break;
          case 'complete_task': game.completeTask(playerId, msg.taskId); break;
          case 'kill': game.kill(playerId, msg.targetId); break;
          case 'vent': game.vent(playerId, msg.action); break;
          case 'call_meeting': game.callMeeting(playerId); break;
          case 'report': game.report(playerId, msg.bodyId); break;
          case 'accuse': game.accuse(playerId, msg.targetId); break;
          case 'fake_vitals': game.fakeVitals(playerId); break;
          case 'vote': game.vote(playerId, msg.targetId); break;
          case 'skip_phase': game.skipPhase(playerId); break;
          case 'play_again': game.playAgain(playerId); break;
          default:
            log(`[vital-verdict] unknown message "${msg.type}" from ${remote}`);
            return;
        }
        broadcastState();
      } catch (err) {
        log(`[vital-verdict] ${msg.type} from ${remote} failed: ${err.message}`);
        send(ws, { type: 'error', message: err.message });
      }
    });
    ws.on('error', (err) => {
      log(`[vital-verdict] socket error from ${remote}: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      const playerId = sockets.get(ws);
      const why = reason && reason.length ? ` reason="${reason}"` : '';
      log(`[vital-verdict] disconnect from ${remote} code=${code} player=${playerId || 'none'}${why}`);
      sockets.delete(ws);
      if (playerId) game.removePlayer(playerId);
      broadcastState();
    });
  });

  let ticks = 0;
  wss.on('wsClientError', (err, _socket, request) => {
    const remote = (request && request.socket && request.socket.remoteAddress) || 'unknown';
    log(`[vital-verdict] handshake failed from ${remote}: ${err.message}`);
  });

  const timer = setInterval(() => {
    game.tick();
    if (game.phase === 'tasks') broadcastPositions();
    ticks += 1;
    if (ticks % STATE_EVERY_TICKS === 0) broadcastState();
  }, TICK_MS);

  httpServer.on('error', (err) => {
    log(`[vital-verdict] server error on :${port}: ${err.code ? `${err.code} ` : ''}${err.message}`);
  });

  const ready = new Promise((resolve, reject) => {
    httpServer.once('listening', () => {
      const addr = httpServer.address();
      log(`[vital-verdict] game server listening on ${addr.address}:${addr.port}`);
      resolve();
    });
    httpServer.once('error', reject);
  });

  httpServer.listen(port, '0.0.0.0');

  return {
    game,
    ready,
    close() {
      clearInterval(timer);
      for (const ws of sockets.keys()) ws.terminate();
      wss.close();
      httpServer.close();
    },
  };
}

module.exports = { Game, createGameServer, DEFAULT_CONFIG };
