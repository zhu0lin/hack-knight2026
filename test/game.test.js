'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { Game, createGameServer } = require('../src/server/game-server');
const MAP = require('../src/shared/map');
const { gameSocketUrl } = require('../src/socket-url');
const RULES = require('../src/shared/minigame-rules');
const EXPR = require('../src/shared/expressions');

function lockedVitals(bpm, baseline = 70) {
  return { bpm, confidence: 90, baseline, locked: true, hint: null };
}

function place(player, x, y) {
  player.x = x;
  player.y = y;
}

function startedGame() {
  const game = new Game({});
  const a = game.addPlayer({ clientId: 'a', name: 'Ann' });
  const b = game.addPlayer({ clientId: 'b', name: 'Ben' });
  const c = game.addPlayer({ clientId: 'c', name: 'Cat' });
  game.start(a.id);
  game.advance();
  const impostor = [a, b, c].find((p) => p.role === 'impostor');
  const crew = [a, b, c].filter((p) => p.role === 'crew');
  return { game, a, b, c, impostor, crew };
}

function pressButton(game, player) {
  place(player, MAP.EMERGENCY_BUTTON.x, MAP.EMERGENCY_BUTTON.y);
  game.callMeeting(player.id);
}

test('assigns exactly one impostor and hides roles from other players', () => {
  const { game, impostor, crew } = startedGame();
  assert.strictEqual(game.phase, 'tasks');
  const view = game.viewFor(crew[0].id);
  assert.strictEqual(view.me.role, 'crew');
  assert.ok(view.players.every((p) => p.role === null));
  assert.strictEqual(game.viewFor(impostor.id).me.role, 'impostor');
});

test('requires minimum players to start', () => {
  const game = new Game({});
  const a = game.addPlayer({ clientId: 'a', name: 'Ann' });
  assert.throws(() => game.start(a.id), /at least 3/);
});

test('players spawn on walkable ground around the emergency button', () => {
  const { game } = startedGame();
  for (const p of game.players.values()) {
    assert.ok(MAP.isWalkable(p.x, p.y), `${p.name} spawned inside a wall`);
    assert.ok(MAP.distance(p, MAP.EMERGENCY_BUTTON) <= MAP.SPAWN.radius + 1);
  }
});

test('moves are rejected through walls or when teleporting', () => {
  const { game, a } = startedGame();
  place(a, 1200, 375);
  game.move(a.id, 1250, 375);
  assert.strictEqual(a.x, 1250);
  game.move(a.id, 1600, 375);
  assert.strictEqual(a.x, 1250, 'teleport accepted');
  place(a, 970, 200);
  game.move(a.id, 930, 200);
  assert.strictEqual(a.x, 970, 'walked through a wall');
});

test('tasks only complete at their station', () => {
  const { game, crew } = startedGame();
  const player = crew[0];
  const task = player.tasks[0];
  place(player, 1200, 375);
  if (MAP.distance(player, task) > MAP.USE_RANGE + 15) {
    game.completeTask(player.id, task.id);
    assert.strictEqual(task.done, false);
  }
  place(player, task.x, task.y);
  game.completeTask(player.id, task.id);
  assert.strictEqual(task.done, true);
});

test('emergency button only works in range', () => {
  const { game, crew } = startedGame();
  place(crew[0], 200, 800);
  game.callMeeting(crew[0].id);
  assert.strictEqual(game.phase, 'tasks');
  pressButton(game, crew[0]);
  assert.strictEqual(game.phase, 'discussion');
});

test('kills need range and cooldown, leave a body that can be reported', () => {
  const game = new Game({});
  const players = ['Ann', 'Ben', 'Cat', 'Dan'].map((n) => game.addPlayer({ clientId: n, name: n }));
  game.start(players[0].id);
  game.advance();
  const impostor = players.find((p) => p.role === 'impostor');
  const [victim, witness] = players.filter((p) => p.role === 'crew');

  place(impostor, 200, 800);
  place(victim, 600, 800);
  impostor.killReadyAt = 0;
  game.kill(impostor.id, victim.id);
  assert.strictEqual(victim.alive, true, 'killed from across the map');

  place(victim, 250, 800);
  impostor.killReadyAt = game.clock() + 10_000;
  game.kill(impostor.id, victim.id);
  assert.strictEqual(victim.alive, true, 'cooldown ignored');

  impostor.killReadyAt = 0;
  game.kill(impostor.id, victim.id);
  assert.strictEqual(victim.alive, false);
  assert.strictEqual(game.bodies.length, 1);

  place(witness, 1200, 375);
  game.report(witness.id, game.bodies[0].id);
  assert.strictEqual(game.phase, 'tasks', 'reported from out of range');
  place(witness, 300, 800);
  game.report(witness.id, game.bodies[0].id);
  assert.strictEqual(game.phase, 'discussion');
  assert.strictEqual(game.bodies.length, 0);
  assert.match(game.meetingCaller, /body/);
});

test('vents sit on walkable ground in networks of at least two', () => {
  for (const v of MAP.VENTS) {
    assert.ok(MAP.isWalkable(v.x, v.y), `${v.id} is inside a wall`);
    assert.ok(MAP.VENTS.filter((o) => o.network === v.network).length >= 2);
  }
});

test('only a living impostor near a vent can enter it', () => {
  const { game, impostor, crew } = startedGame();
  const vent = MAP.VENTS[0];
  place(crew[0], vent.x, vent.y);
  game.vent(crew[0].id, 'enter');
  assert.strictEqual(crew[0].ventId, null, 'crew entered a vent');

  place(impostor, 1200, 375);
  game.vent(impostor.id, 'enter');
  assert.strictEqual(impostor.ventId, null, 'entered from out of range');

  place(impostor, vent.x + 40, vent.y);
  game.vent(impostor.id, 'enter');
  assert.strictEqual(impostor.ventId, vent.id);
  assert.strictEqual(impostor.x, vent.x);

  game.vent(impostor.id, 'exit');
  impostor.alive = false;
  game.vent(impostor.id, 'enter');
  assert.strictEqual(impostor.ventId, null, 'a ghost entered a vent');
});

test('venting cycles within one network, blocks actions, and hides the impostor', () => {
  const { game, impostor, crew } = startedGame();
  const [first, ...rest] = MAP.VENTS.filter((v) => v.network === MAP.VENTS[0].network);
  place(impostor, first.x, first.y);
  game.vent(impostor.id, 'enter');

  game.vent(impostor.id, 'next');
  assert.strictEqual(impostor.ventId, rest[0].id);
  assert.deepStrictEqual([impostor.x, impostor.y], [rest[0].x, rest[0].y]);
  game.vent(impostor.id, 'prev');
  game.vent(impostor.id, 'prev');
  assert.strictEqual(impostor.ventId, rest[rest.length - 1].id);

  const before = { x: impostor.x, y: impostor.y };
  game.move(impostor.id, impostor.x + 10, impostor.y);
  assert.deepStrictEqual({ x: impostor.x, y: impostor.y }, before, 'walked while vented');

  place(crew[0], impostor.x + 30, impostor.y);
  impostor.killReadyAt = 0;
  game.kill(impostor.id, crew[0].id);
  assert.strictEqual(crew[0].alive, true, 'killed from inside a vent');

  const crewView = game.viewFor(crew[0].id);
  assert.ok(!crewView.players.some((p) => p.id === impostor.id));
  assert.ok(!game.positions(crew[0].id).some(([id]) => id === impostor.id));
  assert.strictEqual(crewView.me.ventId, null);
  const ownView = game.viewFor(impostor.id);
  assert.strictEqual(ownView.me.ventId, impostor.ventId);
  assert.ok(ownView.players.some((p) => p.id === impostor.id));

  game.vent(impostor.id, 'exit');
  assert.strictEqual(impostor.ventId, null);
  assert.deepStrictEqual({ x: impostor.x, y: impostor.y }, before);
  assert.ok(game.viewFor(crew[0].id).players.some((p) => p.id === impostor.id));
});

test('a meeting pulls the impostor out of the vents', () => {
  const { game, impostor, crew } = startedGame();
  place(impostor, MAP.VENTS[0].x, MAP.VENTS[0].y);
  game.vent(impostor.id, 'enter');
  pressButton(game, crew[0]);
  assert.strictEqual(game.phase, 'discussion');
  assert.strictEqual(impostor.ventId, null);
  assert.strictEqual(game.viewFor(crew[0].id).players.length, 3);
});

test('flags a spike relative to baseline and fake vitals mask it', () => {
  const { game, impostor, crew } = startedGame();
  pressButton(game, crew[0]);
  game.updateVitals(impostor.id, lockedVitals(92, 70));
  assert.strictEqual(game.displayedVitals(impostor).spike, true);

  game.fakeVitals(impostor.id);
  const faked = game.displayedVitals(impostor);
  assert.strictEqual(faked.spike, false);
  assert.ok(Math.abs(faked.bpm - 70) <= 2);

  game.fakeVitals(impostor.id);
  assert.strictEqual(game.viewFor(impostor.id).me.fakeAvailable, false);
});

test('crew wins by voting out the impostor, and survivors respawn after a meeting', () => {
  const { game, impostor, crew } = startedGame();
  pressButton(game, crew[0]);
  game.advance();
  assert.strictEqual(game.phase, 'voting');
  for (const p of game.alive()) game.vote(p.id, impostor.id);
  assert.strictEqual(game.phase, 'reveal');
  assert.strictEqual(game.lastEjection.wasImpostor, true);
  game.advance();
  assert.strictEqual(game.winner.team, 'crew');
});

test('impostor wins once they equal the crew', () => {
  const { game, impostor, crew } = startedGame();
  impostor.killReadyAt = 0;
  place(impostor, crew[0].x + 30, crew[0].y);
  game.kill(impostor.id, crew[0].id);
  assert.strictEqual(game.phase, 'gameover');
  assert.strictEqual(game.winner.team, 'impostor');
});

test('tied vote ejects nobody', () => {
  const { game, a, b, c } = startedGame();
  pressButton(game, a);
  game.advance();
  game.vote(a.id, b.id);
  game.vote(b.id, a.id);
  game.vote(c.id, 'skip');
  assert.strictEqual(game.lastEjection.playerId, null);
  assert.strictEqual(game.lastEjection.tie, true);
});

test('bots walk the map, do tasks, and play a full game to completion', () => {
  let t = Date.now();
  const game = new Game(
    { taskPhaseMs: 60_000, discussionMs: 2000, votingMs: 2000, revealMs: 1000, roleRevealMs: 1000, killCooldownMs: 5000, botTaskMs: 1000 },
    () => t,
  );
  const host = game.addPlayer({ clientId: 'h', name: 'Host' });
  for (let i = 0; i < 4; i++) game.addBot();
  game.start(host.id);
  let botMoved = false;
  let walls = 0;
  for (let i = 0; i < 20_000 && game.phase !== 'gameover'; i++) {
    t += 100;
    if (game.phase === 'voting' && host.alive && host.vote === null) game.vote(host.id, 'skip');
    game.tick();
    for (const bot of game.bots()) {
      if (bot.alive && game.phase === 'tasks') {
        if (!MAP.isWalkable(bot.x, bot.y, 4)) walls += 1;
        if (MAP.distance(bot, MAP.EMERGENCY_BUTTON) > MAP.SPAWN.radius + 5) botMoved = true;
      }
    }
  }
  assert.ok(botMoved, 'bots never left spawn');
  assert.strictEqual(walls, 0, 'bots walked through walls');
  assert.strictEqual(game.phase, 'gameover');
  assert.ok(['crew', 'impostor'].includes(game.winner.team));
});

test('LAN server relays heart rate and positions between connected clients', async () => {
  const port = 17777;
  const server = createGameServer({ port, log: () => {} });
  await server.ready;

  const open = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const client = { ws, state: null, id: null, positions: null };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') client.id = msg.playerId;
      if (msg.type === 'state') client.state = msg.state;
      if (msg.type === 'positions') client.positions = msg.positions;
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', name, clientId: name }));
      resolve(client);
    });
  });

  const ann = await open('Ann');
  const ben = await open('Ben');
  await new Promise((r) => setTimeout(r, 100));
  ann.ws.send(JSON.stringify({ type: 'hr_update', vitals: lockedVitals(84, 72) }));
  ann.ws.send(JSON.stringify({ type: 'expression', name: 'surprise' }));
  await new Promise((r) => setTimeout(r, 1300));

  const seen = ben.state.players.find((p) => p.name === 'Ann');
  assert.strictEqual(seen.vitals.bpm, 84);
  assert.strictEqual(seen.vitals.delta, 12);
  assert.strictEqual(seen.vitals.spike, true);
  assert.strictEqual(seen.expression, 'surprise');
  assert.strictEqual(ben.state.hostId, ann.id);

  ann.ws.send(JSON.stringify({ type: 'add_bot' }));
  ann.ws.send(JSON.stringify({ type: 'start_game' }));
  ann.ws.send(JSON.stringify({ type: 'skip_phase' }));
  await new Promise((r) => setTimeout(r, 200));
  const me = server.game.players.get(ann.id);
  ann.ws.send(JSON.stringify({ type: 'move', x: me.x + 20, y: me.y }));
  await new Promise((r) => setTimeout(r, 300));
  const annPos = ben.positions.find(([id]) => id === ann.id);
  assert.strictEqual(annPos[1], Math.round(me.x));

  for (const p of server.game.players.values()) p.role = 'crew';
  me.role = 'impostor';
  place(me, MAP.VENTS[0].x, MAP.VENTS[0].y);
  ann.ws.send(JSON.stringify({ type: 'vent', action: 'enter' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(ann.state.me.ventId, MAP.VENTS[0].id);
  assert.ok(!ben.state.players.some((p) => p.id === ann.id));
  assert.ok(!ben.positions.some(([id]) => id === ann.id));

  ann.ws.close();
  ben.ws.close();
  server.close();
});

test('health check responds ok for Cloud Run', async () => {
  const port = 17778;
  const server = createGameServer({ port, log: () => {} });
  await server.ready;
  const result = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body, 'ok');
  server.close();
});

test('abandon_game ends a match so a new player can join', async () => {
  const port = 17779;
  const server = createGameServer({ port, log: () => {} });
  await server.ready;
  const host = server.game.addPlayer({ clientId: 'h', name: 'Host' });
  server.game.addBot();
  server.game.addBot();
  server.game.start(host.id);
  assert.notStrictEqual(server.game.phase, 'lobby');

  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', resolve);
  });
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  ws.send(JSON.stringify({ type: 'join', name: 'New', clientId: 'new' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(messages.some((m) => m.type === 'error' && m.message === 'Game already in progress'), true);

  ws.send(JSON.stringify({ type: 'abandon_game' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(server.game.phase, 'lobby');
  assert.strictEqual(server.game.players.size, 0);
  assert.strictEqual(messages.some((m) => m.type === 'reset'), true);

  ws.send(JSON.stringify({ type: 'join', name: 'New', clientId: 'new' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(messages.some((m) => m.type === 'welcome'), true);
  assert.strictEqual(server.game.players.size, 1);

  ws.close();
  server.close();
});

test('topExpression picks the most confident SDK expression above the threshold', () => {
  assert.strictEqual(EXPR.topExpression([{ type: 5, confidence: 80 }, { type: 8, confidence: 60 }]), 'happy');
  assert.strictEqual(EXPR.topExpression([{ type: 5, confidence: 30 }, { type: 7, confidence: 40 }]), null);
  assert.strictEqual(EXPR.topExpression([{ type: 99, confidence: 90 }]), null);
  assert.strictEqual(EXPR.topExpression(undefined), null);
  assert.strictEqual(EXPR.topExpression([{ type: 'NEUTRAL', confidence: 88 }, { type: 'SAD', confidence: 5 }]), 'neutral');
  assert.strictEqual(EXPR.topExpression([{ type: 'BOGUS', confidence: 99 }]), null);
});

test('expression tracker ignores blips, switches after the hold time, and goes stale', () => {
  const t = new EXPR.ExpressionTracker();
  t.push('neutral', 0);
  assert.strictEqual(t.current(0), 'neutral');
  t.push('happy', 100);
  t.push('neutral', 150);
  t.push('neutral', 400);
  assert.strictEqual(t.current(400), 'neutral', 'one-frame blip changed the face');
  t.push('happy', 500);
  t.push('happy', 500 + EXPR.HOLD_MS - 1);
  assert.strictEqual(t.current(1000), 'neutral');
  t.push('happy', 500 + EXPR.HOLD_MS);
  assert.strictEqual(t.current(1000), 'happy');
  assert.strictEqual(t.current(1000 + EXPR.STALE_MS + 1), null);
});

test('server stores valid expressions and hides stale or dead ones', () => {
  let now = 1_000_000;
  const game = new Game({}, () => now);
  const a = game.addPlayer({ clientId: 'a', name: 'Ann' });
  const b = game.addPlayer({ clientId: 'b', name: 'Ben' });
  game.setExpression(a.id, 'grumpy');
  assert.strictEqual(game.displayedExpression(a), null, 'accepted an unknown name');
  game.setExpression(a.id, 'happy');
  assert.strictEqual(game.positions(b.id).find(([id]) => id === a.id)[3], 'happy');
  assert.strictEqual(game.viewFor(b.id).players.find((p) => p.id === a.id).expression, 'happy');
  now += 5000;
  assert.strictEqual(game.displayedExpression(a), null, 'stale expression still shown');
  game.setExpression(a.id, 'sad');
  a.alive = false;
  assert.strictEqual(game.displayedExpression(a), null, 'dead player still emoting');
});

test('bots show an expression and look worried when accused', () => {
  const game = new Game({});
  const host = game.addPlayer({ clientId: 'h', name: 'Host' });
  game.addBot();
  game.addBot();
  game.start(host.id);
  const bot = game.bots()[0];
  game.tick();
  assert.ok(EXPR.isExpression(game.displayedExpression(bot)));
  game.startMeeting('test');
  game.accuse(host.id, bot.id);
  game.tick();
  assert.ok(['fear', 'surprise'].includes(game.displayedExpression(bot)));
});

test('card swipe only accepts a moderate pace', () => {
  assert.strictEqual(RULES.judgeSwipe(RULES.SWIPE_MIN_MS - 1), 'too_fast');
  assert.strictEqual(RULES.judgeSwipe((RULES.SWIPE_MIN_MS + RULES.SWIPE_MAX_MS) / 2), 'ok');
  assert.strictEqual(RULES.judgeSwipe(RULES.SWIPE_MAX_MS + 1), 'too_slow');
});

test('wires must match colors and follow the panel order', () => {
  const { left, right, sequence } = RULES.wirePuzzle();
  for (const list of [left, right, sequence]) assert.deepStrictEqual([...list].sort(), [...RULES.WIRE_COLORS].sort());
  const [first, second] = sequence;
  assert.strictEqual(RULES.checkWire(sequence, 0, first, second), 'wrong_color');
  assert.strictEqual(RULES.checkWire(sequence, 0, second, second), 'wrong_order');
  assert.strictEqual(RULES.checkWire(sequence, 0, first, first), 'ok');
  assert.strictEqual(RULES.checkWire(sequence, 1, second, second), 'ok');
});

test('course waypoints are reached in order and straying resets', () => {
  const W = RULES.COURSE_WAYPOINTS;
  for (const w of W) assert.ok(w.x >= 0 && w.x <= 1 && w.y >= 0 && w.y <= 1);

  assert.deepStrictEqual(RULES.courseStep(0, W[2]), { index: 0, status: 'off_course' }, 'skipped a waypoint');
  const mid = { x: (W[0].x + W[1].x) / 2, y: (W[0].y + W[1].y) / 2 };
  assert.deepStrictEqual(RULES.courseStep(0, mid), { index: 0, status: 'moving' });
  assert.deepStrictEqual(RULES.courseStep(0, W[1]), { index: 1, status: 'advanced' });
  assert.strictEqual(RULES.courseStep(0, { x: mid.x + 0.2, y: mid.y }).status, 'off_course');
  assert.deepStrictEqual(RULES.courseStep(W.length - 2, W[W.length - 1]), { index: W.length - 1, status: 'done' });
});

test('join addresses become the right websocket URL', () => {
  assert.strictEqual(gameSocketUrl('192.168.1.20', 7777), 'ws://192.168.1.20:7777');
  assert.strictEqual(gameSocketUrl('192.168.1.20:7777', 7777), 'ws://192.168.1.20:7777');
  assert.strictEqual(gameSocketUrl('localhost', 7777), 'ws://localhost:7777');
  assert.strictEqual(gameSocketUrl('https://vital-verdict-abc.run.app/', 7777), 'wss://vital-verdict-abc.run.app');
  assert.strictEqual(gameSocketUrl('wss://vital-verdict-abc.run.app', 7777), 'wss://vital-verdict-abc.run.app');
  assert.strictEqual(gameSocketUrl('vital-verdict-abc.run.app', 7777), 'wss://vital-verdict-abc.run.app');
});
