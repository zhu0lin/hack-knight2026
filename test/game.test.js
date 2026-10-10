'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { Game, createGameServer } = require('../src/server/game-server');
const { gameSocketUrl } = require('../src/socket-url');

function lockedVitals(bpm, baseline = 70) {
  return { bpm, confidence: 90, baseline, locked: true, hint: null };
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

test('flags a spike relative to baseline and fake vitals mask it', () => {
  const { game, impostor, crew } = startedGame();
  game.callMeeting(crew[0].id);
  game.updateVitals(impostor.id, lockedVitals(92, 70));
  assert.strictEqual(game.displayedVitals(impostor).spike, true);

  game.fakeVitals(impostor.id);
  const faked = game.displayedVitals(impostor);
  assert.strictEqual(faked.spike, false);
  assert.ok(Math.abs(faked.bpm - 70) <= 2);

  game.fakeVitals(impostor.id);
  assert.strictEqual(game.viewFor(impostor.id).me.fakeAvailable, false);
});

test('crew wins by voting out the impostor', () => {
  const { game, impostor } = startedGame();
  game.callMeeting(impostor.id);
  game.advance();
  assert.strictEqual(game.phase, 'voting');
  for (const p of game.alive()) game.vote(p.id, impostor.id);
  assert.strictEqual(game.phase, 'reveal');
  assert.strictEqual(game.lastEjection.wasImpostor, true);
  assert.strictEqual(game.phase === 'gameover' || game.checkWin(), true);
  assert.strictEqual(game.winner.team, 'crew');
});

test('impostor wins once they equal the crew', () => {
  const { game, impostor, crew } = startedGame();
  impostor.killReadyAt = 0;
  game.kill(impostor.id, crew[0].id);
  assert.strictEqual(game.phase, 'gameover');
  assert.strictEqual(game.winner.team, 'impostor');
});

test('kill respects cooldown', () => {
  const { game, impostor, crew } = startedGame();
  game.kill(impostor.id, crew[0].id);
  assert.strictEqual(crew[0].alive, true);
});

test('tied vote ejects nobody', () => {
  const { game, a, b, c } = startedGame();
  game.callMeeting(a.id);
  game.advance();
  game.vote(a.id, b.id);
  game.vote(b.id, a.id);
  game.vote(c.id, 'skip');
  assert.strictEqual(game.lastEjection.playerId, null);
  assert.strictEqual(game.lastEjection.tie, true);
});

test('bots play a full game to completion', () => {
  let t = Date.now();
  const game = new Game(
    { taskPhaseMs: 3000, discussionMs: 2000, votingMs: 2000, revealMs: 1000, roleRevealMs: 1000, killCooldownMs: 2000 },
    () => t,
  );
  const host = game.addPlayer({ clientId: 'h', name: 'Host' });
  for (let i = 0; i < 4; i++) game.addBot();
  game.start(host.id);
  for (let i = 0; i < 2000 && game.phase !== 'gameover'; i++) {
    t += 1000;
    if (game.phase === 'voting' && host.alive && host.vote === null) game.vote(host.id, 'skip');
    game.tick();
  }
  assert.strictEqual(game.phase, 'gameover');
  assert.ok(['crew', 'impostor'].includes(game.winner.team));
});

test('LAN server relays heart rate between connected clients', async () => {
  const port = 17777;
  const server = createGameServer({ port, log: () => {} });
  await server.ready;

  const open = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const client = { ws, state: null, id: null };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') client.id = msg.playerId;
      if (msg.type === 'state') client.state = msg.state;
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
  await new Promise((r) => setTimeout(r, 1300));

  const seen = ben.state.players.find((p) => p.name === 'Ann');
  assert.strictEqual(seen.vitals.bpm, 84);
  assert.strictEqual(seen.vitals.delta, 12);
  assert.strictEqual(seen.vitals.spike, true);
  assert.strictEqual(ben.state.hostId, ann.id);

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

test('join addresses become the right websocket URL', () => {
  assert.strictEqual(gameSocketUrl('192.168.1.20', 7777), 'ws://192.168.1.20:7777');
  assert.strictEqual(gameSocketUrl('192.168.1.20:7777', 7777), 'ws://192.168.1.20:7777');
  assert.strictEqual(gameSocketUrl('localhost', 7777), 'ws://localhost:7777');
  assert.strictEqual(gameSocketUrl('https://vital-verdict-abc.run.app/', 7777), 'wss://vital-verdict-abc.run.app');
  assert.strictEqual(gameSocketUrl('wss://vital-verdict-abc.run.app', 7777), 'wss://vital-verdict-abc.run.app');
  assert.strictEqual(gameSocketUrl('vital-verdict-abc.run.app', 7777), 'wss://vital-verdict-abc.run.app');
});
