'use strict';

const crypto = require('crypto');
const http = require('http');
const { WebSocketServer } = require('ws');

const DEFAULT_CONFIG = {
  minPlayers: 3,
  tasksPerPlayer: 3,
  taskPhaseMs: 90_000,
  discussionMs: 60_000,
  votingMs: 30_000,
  revealMs: 7_000,
  roleRevealMs: 5_000,
  killCooldownMs: 25_000,
  fakeVitalsMs: 25_000,
  spikeBpm: 10,
  vitalsStaleMs: 15_000,
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ff6fb5', '#ecf0f1', '#8d6e63'];

const TASKS = [
  { id: 'wires', label: 'Reconnect the sensor wires', kind: 'hold' },
  { id: 'card', label: 'Swipe your ID badge', kind: 'hold' },
  { id: 'samples', label: 'Sort the lab samples', kind: 'hold' },
  { id: 'reactor', label: 'Calm the reactor (stay near your resting BPM)', kind: 'calm' },
  { id: 'scan', label: 'Run a medbay scan', kind: 'hold' },
];

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
    this.log = [];
    for (const p of this.players.values()) {
      p.role = null;
      p.alive = true;
      p.tasks = [];
      p.vote = null;
      p.killReadyAt = 0;
      p.fakeUntil = 0;
      p.fakeBpm = null;
      p.fakeUsedInMeeting = -1;
      p.spiking = false;
    }
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
    this.emit({ type: 'join', text: `${player.name} joined` });
    return player;
  }

  resetPlayer(p) {
    Object.assign(p, {
      role: null, alive: true, tasks: [], vote: null, killReadyAt: 0,
      fakeUntil: 0, fakeBpm: null, fakeUsedInMeeting: -1, spiking: false,
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

  // ---- derived ------------------------------------------------------------

  alive() { return [...this.players.values()].filter((p) => p.alive); }
  impostorsAlive() { return this.alive().filter((p) => p.role === 'impostor'); }
  crewAlive() { return this.alive().filter((p) => p.role === 'crew'); }

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
      p.tasks = shuffle(TASKS).slice(0, this.config.tasksPerPlayer).map((t) => ({ ...t, done: false }));
      p.killReadyAt = this.clock() + this.config.roleRevealMs + this.config.killCooldownMs;
    }
    this.meetingNumber = 0;
    this.winner = null;
    this.lastEjection = null;
    this.log = [];
    this.setPhase('roles', this.config.roleRevealMs);
    this.emit({ type: 'game_start', text: 'Shift started. One of you is an impostor.' });
  }

  completeTask(id, taskId) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'tasks' || !p.alive) return;
    const task = p.tasks.find((t) => t.id === taskId);
    if (!task || task.done) return;
    task.done = true;
    if (p.role === 'crew' && this.taskProgress() >= 1) this.finish('crew', 'All tasks completed!');
  }

  kill(id, targetId) {
    const killer = this.players.get(id);
    const target = this.players.get(targetId);
    if (this.phase !== 'tasks' || !killer || !target) return;
    if (killer.role !== 'impostor' || !killer.alive || !target.alive || target.role === 'impostor') return;
    if (this.clock() < killer.killReadyAt) return;
    target.alive = false;
    killer.killReadyAt = this.clock() + this.config.killCooldownMs;
    this.emit({ type: 'kill', targetId, text: `${target.name} was found unconscious!` });
    this.checkWin();
  }

  callMeeting(id) {
    const p = this.players.get(id);
    if (this.phase !== 'tasks' || (p && !p.alive)) return;
    this.startMeeting(p ? p.name : 'The timer');
  }

  startMeeting(callerName) {
    this.meetingNumber += 1;
    this.meetingCaller = callerName;
    this.spotlight = null;
    for (const p of this.players.values()) {
      p.vote = null;
      p.spiking = false;
    }
    this.setPhase('discussion', this.config.discussionMs);
    this.emit({ type: 'meeting', text: `Emergency meeting called by ${callerName}` });
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
        this.startMeeting('The shift timer');
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
    this.setPhase('gameover', null);
    this.emit({ type: 'gameover', text: reason });
    return true;
  }

  playAgain(byId) {
    if (byId !== this.hostId) return;
    this.resetRound();
    for (const p of [...this.players.values()]) {
      if (!p.connected && !p.isBot) this.players.delete(p.id);
    }
    this.emit({ type: 'lobby', text: 'Back to the lobby' });
  }

  // ---- ticking ------------------------------------------------------------

  tick(now = this.clock()) {
    this.tickBots(now);
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

  tickBots(now) {
    const bots = [...this.players.values()].filter((p) => p.isBot);
    for (const bot of bots) {
      const s = bot.sim;
      const accused = this.spotlight && this.spotlight.targetId === bot.id && now - this.spotlight.at < 20_000;
      if (accused) s.stress = Math.min(28, s.stress + (bot.role === 'impostor' ? 5 : 2.5));
      else s.stress = Math.max(0, s.stress - 1.2);
      s.bpm += (s.resting + s.stress - s.bpm) * 0.35 + (Math.random() - 0.5) * 2;
      bot.vitals = { ...bot.vitals, bpm: Math.round(s.bpm), at: now };

      if (!bot.alive) continue;
      if (this.phase === 'tasks') {
        if (bot.role === 'crew' && Math.random() < 0.06) {
          const task = bot.tasks.find((t) => !t.done);
          if (task) this.completeTask(bot.id, task.id);
        }
        if (bot.role === 'impostor' && now >= bot.killReadyAt && Math.random() < 0.08) {
          const targets = this.crewAlive();
          if (targets.length) this.kill(bot.id, shuffle(targets)[0].id);
        }
      }
      if (this.phase === 'voting' && bot.vote === null && Math.random() < 0.15) {
        const options = this.alive().filter((p) => p.id !== bot.id && p.role !== (bot.role === 'impostor' ? 'impostor' : null));
        const suspect = this.spotlight && this.spotlight.targetId !== bot.id ? this.spotlight.targetId : null;
        const pick = suspect && Math.random() < 0.6 ? suspect : Math.random() < 0.3 ? 'skip' : (shuffle(options)[0] || { id: 'skip' }).id;
        this.vote(bot.id, pick);
      }
    }
  }

  // ---- views --------------------------------------------------------------

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
      players: [...this.players.values()].map((p) => this.publicPlayer(p, now)),
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
          case 'start_game': game.start(playerId); break;
          case 'add_bot': if (playerId === game.hostId) game.addBot(); break;
          case 'remove_bot': if (playerId === game.hostId) game.removeBot(); break;
          case 'complete_task': game.completeTask(playerId, msg.taskId); break;
          case 'kill': game.kill(playerId, msg.targetId); break;
          case 'call_meeting': game.callMeeting(playerId); break;
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

  wss.on('wsClientError', (err, _socket, request) => {
    const remote = (request && request.socket && request.socket.remoteAddress) || 'unknown';
    log(`[vital-verdict] handshake failed from ${remote}: ${err.message}`);
  });

  const timer = setInterval(() => {
    game.tick();
    broadcastState();
  }, 1000);

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
