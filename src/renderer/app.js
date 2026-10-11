import { createVitals, listCameras } from './vitals.js';
import { connect } from './net.js';
import { gameSocketUrl } from '../socket-url.js';
import * as sound from './sound.js';
import { createMapView } from './map-view.js';
import { isMinigame, mountMinigame } from './minigames.js';
import { roomAt, TASKS } from '../shared/map.js';

const HOLD_TASK_MS = 2500;
const CALM_TASK_MS = 6000;
const CALM_TOLERANCE_BPM = 6;
const HISTORY_POINTS = 40;

const $ = (sel) => document.querySelector(sel);
const main = $('#main');

const ui = {
  config: null,
  vitals: null,
  myVitals: null,
  net: null,
  connection: 'offline',
  joinLog: [],
  hostInfo: null,
  state: null,
  clockOffset: 0,
  activeTask: null,
  minigame: null,
  history: new Map(),
  lastPhase: null,
  map: null,
  faceCams: new Map(), // playerId -> jpeg data URL
};

const clientId = sessionStorage.getItem('vv-client-id') || crypto.randomUUID();
sessionStorage.setItem('vv-client-id', clientId);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function now() { return Date.now() + ui.clockOffset; }

function secondsLeft() {
  const s = ui.state;
  if (!s || !s.phaseEndsAt) return null;
  return Math.max(0, Math.ceil((s.phaseEndsAt - now()) / 1000));
}

function avatar(color, { dead = false, size = 64 } = {}) {
  return `
    <svg class="avatar ${dead ? 'dead' : ''}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="14" y="6" width="36" height="52" rx="18" fill="${color}" />
      <rect x="18" y="16" width="28" height="14" rx="7" fill="#0b0f1a" opacity="0.85" />
      <polyline points="20,23 26,23 29,18 33,28 36,21 38,23 44,23" fill="none" stroke="#5ef0b4" stroke-width="2" stroke-linejoin="round" />
      ${dead ? '<line x1="16" y1="10" x2="48" y2="54" stroke="#0b0f1a" stroke-width="4" />' : ''}
    </svg>`;
}

function faceCamUrl(playerId) {
  return ui.faceCams.get(playerId) || null;
}

function sparkline(playerId, color) {
  const points = ui.history.get(playerId) || [];
  if (points.length < 2) return '<svg class="spark"></svg>';
  const min = Math.min(...points) - 3;
  const max = Math.max(...points) + 3;
  const coords = points.map((v, i) => {
    const x = (i / (HISTORY_POINTS - 1)) * 160;
    const y = 36 - ((v - min) / (max - min || 1)) * 32;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark" viewBox="0 0 160 40" preserveAspectRatio="none">
    <polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2" />
  </svg>`;
}

function heartStyle(bpm) {
  return bpm ? `animation-duration:${(60 / bpm).toFixed(2)}s` : 'animation:none';
}

// ---- vitals sidebar ---------------------------------------------------------

function renderVitalsPanel(v) {
  ui.myVitals = v;
  $('#my-bpm').textContent = v.bpm ?? '--';
  $('#my-conf').textContent = v.bpm ? `${Math.round(v.confidence)}%` : '--';
  $('#my-baseline').textContent = v.baseline ? `${v.baseline} BPM` : '--';
  $('#my-heart').style.cssText = heartStyle(v.bpm);
  $('#calib-bar').style.width = `${Math.round(v.calibrationProgress * 100)}%`;
  $('#calib-label').textContent = v.locked
    ? 'Vitals locked'
    : v.bpm ? 'Calibrating resting pulse... sit still' : 'Waiting for a pulse reading...';
  $('#calib-label').classList.toggle('ok', v.locked);

  const coach = $('#coach');
  const hint = v.status === 'error' ? null : v.hint;
  coach.textContent = hint || '';
  coach.classList.toggle('hidden', !hint || v.validationOk);

  const err = $('#vitals-error');
  err.textContent = v.error || '';
  err.classList.toggle('hidden', !v.error);

  if (ui.activeTask && ui.activeTask.kind === 'calm') progressCalmTask(v);
}

function sendVitals() {
  if (!ui.net || !ui.myVitals) return;
  const v = ui.myVitals;
  ui.net.send('hr_update', {
    vitals: {
      bpm: v.bpm,
      confidence: v.confidence,
      baseline: v.baseline,
      locked: v.locked,
      hint: v.validationOk ? null : v.hint,
    },
  });
}

// ---- face cams ----------------------------------------------------------------

const FACE_CAM_SIZE = 200;
const faceCamCanvas = document.createElement('canvas');
faceCamCanvas.width = FACE_CAM_SIZE;
faceCamCanvas.height = FACE_CAM_SIZE;
const faceCamCtx = faceCamCanvas.getContext('2d');

function setFaceCam(playerId, jpeg) {
  if (!playerId || !jpeg) return;
  ui.faceCams.set(playerId, jpeg);
}

function sendFaceSnapshot() {
  const video = $('#cam');
  if (!video.videoWidth) return;
  const size = Math.min(video.videoWidth, video.videoHeight);
  faceCamCtx.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, FACE_CAM_SIZE, FACE_CAM_SIZE);
  const jpeg = faceCamCanvas.toDataURL('image/jpeg', 0.65);
  if (ui.state && ui.state.me) setFaceCam(ui.state.me.id, jpeg);
  if (ui.net) ui.net.send('face_snapshot', { jpeg });
}

// ---- toasts -----------------------------------------------------------------

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3500);
  setTimeout(() => el.remove(), 4000);
}

// ---- networking -------------------------------------------------------------

function pushJoinLog(message) {
  const stamp = new Date().toLocaleTimeString();
  ui.joinLog = [...ui.joinLog.slice(-7), `${stamp}  ${message}`];
  console.log(`[join] ${message}`);
  if (window.vv && window.vv.log) window.vv.log(`[join] ${message}`);
  if (!ui.state) render();
}

function joinServer(url, name) {
  if (ui.net) ui.net.close();
  ui.state = null;
  ui.joinName = name;
  pushJoinLog(`join requested by "${name}" → ${url}`);
  ui.net = connect(url, {
    onLog: pushJoinLog,
    onReset: () => {
      toast('Ended the game. Joining the lobby...', 'info');
      ui.state = null;
      ui.net.join(ui.joinName, clientId);
    },
    onStatus: (status) => {
      ui.connection = status;
      if (status === 'disconnected' && ui.state) toast('Lost connection to host, retrying...', 'warn');
      render();
    },
    onState: (state) => {
      ui.clockOffset = state.serverNow - Date.now();
      recordHistory(state);
      const prev = ui.lastPhase;
      ui.state = state;
      ui.lastPhase = state.phase;
      if (prev !== state.phase) onPhaseChange(prev, state.phase);
      render();
    },
    onPositions: (positions) => {
      if (ui.map) ui.map.setPositions(positions);
    },
    onFaceCam: setFaceCam,
    onEvent: handleEvent,
    onError: (message) => toast(message, 'warn'),
  });
  ui.net.join(name, clientId);
}

function recordHistory(state) {
  for (const p of state.players) {
    if (p.vitals.bpm === null) continue;
    const list = ui.history.get(p.id) || [];
    list.push(p.vitals.bpm);
    if (list.length > HISTORY_POINTS) list.shift();
    ui.history.set(p.id, list);
  }
}

function onPhaseChange(prev, phase) {
  clearActiveTask();
  if (phase === 'roles') sound.roleReveal();
  if (phase === 'discussion') sound.alarm();
  if (phase === 'gameover') sound.fanfare();
}

function handleEvent(event) {
  const me = ui.state && ui.state.me;
  switch (event.type) {
    case 'spike':
      sound.spike();
      toast(event.text, 'danger');
      break;
    case 'kill':
      clearActiveTask();
      sound.thud();
      toast('You were eliminated. You are a ghost now: you can drift through walls and watch.', 'danger');
      break;
    case 'accuse':
      sound.accuse();
      toast(event.text, 'warn');
      break;
    case 'fake_vitals':
      if (me && event.playerId === me.id) toast('Fake vitals active: everyone sees your resting pulse.', 'info');
      break;
    case 'vote':
      break;
    default:
      if (event.text) toast(event.text);
  }
}

// ---- tasks ------------------------------------------------------------------

function startTask(assigned) {
  if (ui.activeTask) return;
  // The server's task copy may come from an older map; the client's map decides how a task is played.
  const task = { ...assigned, ...(TASKS.find((t) => t.id === assigned.id) || {}) };
  if (isMinigame(task.kind)) {
    const layer = $('#task-layer');
    if (!layer) return;
    ui.activeTask = { id: task.id, kind: task.kind };
    layer.classList.add('active');
    ui.minigame = mountMinigame(layer, task, { onComplete: () => finishTask(task.id) });
  } else if (task.kind === 'calm') {
    if (!ui.myVitals || !ui.myVitals.locked) {
      toast('Finish calibrating your resting pulse first.', 'warn');
      return;
    }
    ui.activeTask = { id: task.id, kind: 'calm', calmMs: 0, lastAt: Date.now() };
  } else {
    ui.activeTask = { id: task.id, kind: 'hold', startedAt: Date.now() };
    setTimeout(() => finishTask(task.id), HOLD_TASK_MS);
  }
  render();
}

function progressCalmTask(v) {
  const t = ui.activeTask;
  const nowMs = Date.now();
  const calm = v.bpm !== null && v.baseline !== null && Math.abs(v.bpm - v.baseline) <= CALM_TOLERANCE_BPM;
  t.calmMs = calm ? t.calmMs + (nowMs - t.lastAt) : Math.max(0, t.calmMs - (nowMs - t.lastAt));
  t.lastAt = nowMs;
  t.calm = calm;
  if (t.calmMs >= CALM_TASK_MS) finishTask(t.id);
  else render();
}

function clearActiveTask() {
  ui.activeTask = null;
  if (ui.minigame) {
    ui.minigame.destroy();
    ui.minigame = null;
  }
  const layer = $('#task-layer');
  if (layer) layer.classList.remove('active');
}

function cancelTask() {
  if (!ui.activeTask) return;
  clearActiveTask();
  render();
}

function finishTask(taskId) {
  if (!ui.activeTask || ui.activeTask.id !== taskId) return;
  clearActiveTask();
  ui.net.send('complete_task', { taskId });
  sound.blip();
  render();
}

function taskProgress(task) {
  const t = ui.activeTask;
  if (!t || t.id !== task.id) return 0;
  if (t.kind === 'hold') return Math.min(1, (Date.now() - t.startedAt) / HOLD_TASK_MS);
  return Math.min(1, t.calmMs / CALM_TASK_MS);
}

// ---- views ------------------------------------------------------------------

function render() {
  if (!ui.net || !ui.state) {
    if (!ui.net) return;
    main.innerHTML = `<div class="center"><div class="panel"><h2>Connecting to host...</h2>
      <p class="muted">${esc(ui.connection)}</p>
      ${ui.joinLog.length ? `<div class="log">${ui.joinLog.map((line) => `<div>${esc(line)}</div>`).join('')}</div>` : ''}
      <button class="btn ghost" data-action="abandon_game">End game in progress</button>
      </div></div>`;
    return;
  }
  if (ui.state.phase === 'tasks') {
    renderMap();
    return;
  }
  unmountMap();
  const views = { lobby: lobbyView, roles: rolesView, discussion: meetingView, voting: meetingView, reveal: revealView, gameover: gameoverView };
  main.innerHTML = (views[ui.state.phase] || lobbyView)();
}

function renderMap() {
  if (!ui.map) {
    main.classList.add('map-mode');
    main.innerHTML = '<div class="map-stage"><canvas id="map-canvas"></canvas><div id="hud"></div><div id="task-layer"></div></div>';
    ui.map = createMapView($('#map-canvas'), {
      send: (type, payload) => ui.net.send(type, payload),
      now,
      isBusy: () => !!ui.activeTask,
      useTask: startTask,
      cancelTask,
    });
  }
  ui.map.setState(ui.state);
  $('#hud').innerHTML = hudView();
}

function unmountMap() {
  if (!ui.map) return;
  clearActiveTask();
  ui.map.destroy();
  ui.map = null;
  main.classList.remove('map-mode');
}

function setupView() {
  const savedName = localStorage.getItem('vv-name') || '';
  main.innerHTML = `
    <div class="center">
      <div class="panel setup">
        <h1>Vital Verdict</h1>
        <p class="tagline">A social-deduction game where your heart gives you away.</p>
        <label>Your name<input id="name" maxlength="16" value="${esc(savedName)}" placeholder="e.g. Alex" /></label>
        <div class="setup-actions">
          <div class="setup-col">
            <h3>Host on this laptop</h3>
            <p class="muted">Starts a game server on port ${ui.config.port}. Other laptops on the same Wi-Fi join you.</p>
            <button id="host" class="btn primary">Host game</button>
          </div>
          <div class="setup-col">
            <h3>Join a friend</h3>
            <input id="host-addr" placeholder="IP, or https://….run.app" value="${esc(localStorage.getItem('vv-host') || '')}" />
            <p class="muted">Same Wi-Fi: their IP. Campus: the Cloud Run URL.</p>
            <button id="join" class="btn">Join game</button>
            <button id="reset-game" class="btn ghost">End game in progress</button>
          </div>
        </div>
        ${ui.config.missingKey ? '<p class="warn-box">No <code>PRESAGE_API_KEY</code> found in <code>.env</code>. Running with simulated vitals.</p>' : ''}
      </div>
    </div>`;

  const nameInput = $('#name');
  const getName = () => {
    const name = nameInput.value.trim();
    if (!name) { toast('Enter your name first', 'warn'); nameInput.focus(); return null; }
    localStorage.setItem('vv-name', name);
    return name;
  };

  $('#host').onclick = async () => {
    const name = getName();
    if (!name) return;
    try {
      ui.hostInfo = await window.vv.hostGame();
      joinServer(`ws://localhost:${ui.hostInfo.port}`, name);
      render();
    } catch (err) {
      toast(`Could not start server: ${err.message}`, 'danger');
    }
  };
  $('#join').onclick = () => {
    const name = getName();
    if (!name) return;
    const addr = $('#host-addr').value.trim();
    if (!addr) { toast('Enter the host IP or server address', 'warn'); return; }
    localStorage.setItem('vv-host', addr);
    const url = gameSocketUrl(addr, ui.config.port);
    pushJoinLog(`typed host "${addr}", dialing ${url}`);
    joinServer(url, name);
    render();
  };
  $('#reset-game').onclick = () => endGameInProgress(nameInput.value.trim());
}

function endGameInProgress(name) {
  const addr = ($('#host-addr') && $('#host-addr').value.trim()) || localStorage.getItem('vv-host') || '';
  if (!addr) { toast('Enter the server address first', 'warn'); return; }
  const url = gameSocketUrl(addr, ui.config.port);
  if (ui.net) {
    ui.joinName = name || ui.joinName;
    ui.net.send('abandon_game');
    return;
  }
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { ws.close(); toast('Server did not answer the reset', 'warn'); }, 8000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'abandon_game' }));
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'reset') return;
    clearTimeout(timer);
    ws.close();
    toast('Ended the game on the server.', 'info');
    if (!name) return;
    localStorage.setItem('vv-name', name);
    joinServer(url, name);
  };
  ws.onerror = () => {};
}

function isHost() { return ui.state.me && ui.state.hostId === ui.state.me.id; }

function lobbyView() {
  const s = ui.state;
  const humans = s.players.filter((p) => !p.isBot);
  const notReady = humans.filter((p) => !p.vitals.locked);
  const canStart = s.players.length >= s.config.minPlayers;
  return `
    <div class="lobby">
      <header class="phase-head">
        <h2>Lobby</h2>
        ${ui.hostInfo ? `<div class="join-info">Others join at <b>${ui.hostInfo.addresses.map(esc).join('</b> or <b>') || 'localhost'}</b></div>` : ''}
      </header>
      <div class="coach-card">
        <b>Before we start:</b> sit still, face the camera, light in front of you (not behind), upper chest visible.
        Wait for <span class="ok">Vitals locked</span> on the left.
      </div>
      <div class="player-grid">
        ${s.players.map((p) => `
          <div class="player-card ${p.vitals.locked ? 'ready' : ''}">
            ${avatar(p.color)}
            <div class="pname">${esc(p.name)}${p.isHost ? ' <span class="tag">host</span>' : ''}${p.isBot ? ' <span class="tag">bot</span>' : ''}</div>
            <div class="pstatus">${p.vitals.locked ? `Locked &middot; resting ${p.vitals.baseline} BPM` : esc(p.vitals.hint || 'Calibrating...')}</div>
          </div>`).join('')}
      </div>
      ${isHost() ? `
        <div class="host-controls">
          <button class="btn ghost" data-action="add_bot">+ Add bot</button>
          <button class="btn ghost" data-action="remove_bot">- Remove bot</button>
          <button class="btn primary" data-action="start_game" ${canStart ? '' : 'disabled'}>Start game</button>
        </div>
        <p class="muted">${canStart ? (notReady.length ? `Waiting on calibration: ${notReady.map((p) => esc(p.name)).join(', ')} (you can still start)` : 'Everyone is calibrated.') : `Need ${s.config.minPlayers}+ players. Add bots to test solo.`}</p>`
        : '<p class="muted">Waiting for the host to start...</p>'}
    </div>`;
}

function rolesView() {
  const me = ui.state.me;
  const impostor = me.role === 'impostor';
  return `
    <div class="center">
      <div class="role-reveal ${impostor ? 'impostor' : 'crew'}">
        <div class="role-sub">You are</div>
        <div class="role-name">${impostor ? 'THE IMPOSTOR' : 'CREW'}</div>
        <p>${impostor
          ? 'Eliminate the crew without getting caught. Press V at a vent to travel unseen. In meetings you can fake calm vitals once. Keep your heart steady.'
          : 'Finish your tasks and find the impostor. Watch for pulse spikes when someone is accused.'}</p>
      </div>
    </div>`;
}

function timerChip() {
  const left = secondsLeft();
  return left === null ? '' : `<div class="timer ${left <= 10 ? 'low' : ''}">${left}s</div>`;
}

function hostSkip(label) {
  return isHost() ? `<button class="btn small ghost" data-action="skip_phase">${label}</button>` : '';
}

function taskModal() {
  const t = ui.activeTask;
  if (!t || isMinigame(t.kind)) return '';
  const task = ui.state.me.tasks.find((x) => x.id === t.id);
  if (!task) return '';
  const pct = Math.round(taskProgress(task) * 100);
  const calmNote = t.kind === 'calm'
    ? `<div class="calm-note ${t.calm ? 'ok' : 'bad'}">${t.calm ? 'Steady... keep breathing slowly' : 'Pulse too far from resting - relax'}</div>` : '';
  return `
    <div class="task-modal">
      <h3>${esc(task.label)}</h3>
      <div class="bar big-bar"><div class="bar-fill" style="width:${pct}%"></div></div>
      ${calmNote}
      <div class="muted">Esc to cancel</div>
    </div>`;
}

function hudView() {
  const s = ui.state;
  const me = s.me;
  const impostor = me.role === 'impostor';
  const pos = ui.map && ui.map.position();
  const room = pos ? roomAt(pos.x, pos.y) : null;
  return `
    <div class="hud-top">
      <div class="taskbar"><div class="taskbar-fill" style="width:${Math.round(s.taskProgress * 100)}%"></div><span>Crew tasks ${Math.round(s.taskProgress * 100)}%</span></div>
      <div class="hud-right">${impostor ? '<span class="tag danger">impostor</span>' : ''}${timerChip()}${hostSkip('Skip to meeting')}</div>
    </div>
    <div class="hud-tasks">
      <h4>${impostor ? 'Fake tasks (blend in)' : 'Tasks'}</h4>
      ${me.tasks.map((t) => `<div class="hud-task ${t.done ? 'done' : ''}">${t.done ? '&#10003;' : '&#9679;'} ${esc(roomAt(t.x, t.y))}: ${esc(t.label)}</div>`).join('')}
      ${!me.alive ? '<div class="ghost-note">You are a ghost. Drift around and watch.</div>' : ''}
    </div>
    ${room ? `<div class="hud-room">${esc(room)}</div>` : ''}
    <div class="hud-keys">${me.ventId
      ? 'A/D switch vent &middot; V climb out'
      : `WASD move &middot; E use &middot; R report${impostor ? ' &middot; Q eliminate &middot; V vent' : ''}`}</div>
    ${taskModal()}`;
}

function vitalsCard(p, s) {
  const me = s.me;
  const v = p.vitals;
  const spot = s.spotlight && s.spotlight.targetId === p.id;
  const deltaText = v.delta === null ? (v.locked ? '' : 'not calibrated') : `${v.delta > 0 ? '+' : ''}${v.delta} vs resting`;
  const voting = s.phase === 'voting';
  const canAct = me.alive && p.alive;
  const face = faceCamUrl(p.id);
  return `
    <div class="vitals-card ${p.alive ? '' : 'dead'} ${v.spike ? 'spike' : ''} ${spot ? 'spotlight' : ''}">
      ${spot ? '<div class="spot-tag">ACCUSED</div>' : ''}
      <div class="face-tile" style="${face ? `background-image:url('${face}')` : `background:${p.color}`}">
        ${!face ? `<div class="face-fallback">${esc((p.name[0] || '?').toUpperCase())}</div>` : ''}
        <div class="face-caption">
          <span class="pname">${esc(p.name)}${p.id === me.id ? ' (you)' : ''}</span>
          <span class="muted">${p.alive ? (p.voted ? 'voted' : '') : 'out'}</span>
        </div>
      </div>
      ${p.alive ? `
        <div class="vc-bpm"><span class="heart" style="${heartStyle(v.bpm)}">&#9829;</span>${v.bpm ?? '--'}<span class="unit">BPM</span></div>
        <div class="vc-delta ${v.spike ? 'bad' : ''}">${esc(deltaText)}</div>
        ${sparkline(p.id, v.spike ? '#ff4d6d' : p.color)}
        <div class="vc-actions">
          ${canAct && p.id !== me.id ? `<button class="btn small ghost" data-accuse="${p.id}">Accuse</button>` : ''}
          ${voting && canAct && me.vote === null && p.id !== me.id ? `<button class="btn small primary" data-vote="${p.id}">Vote</button>` : ''}
        </div>` : '<div class="vc-out">No vitals</div>'}
    </div>`;
}

function meetingView() {
  const s = ui.state;
  const me = s.me;
  const voting = s.phase === 'voting';
  const fakeActive = me.fakeUntil > now();
  return `
    <div class="meeting">
      <header class="phase-head">
        <h2>${voting ? 'Vote now' : 'Emergency meeting'}</h2>
        <div class="muted">${esc(s.meetingCaller)} &middot; spike = ${s.config.spikeBpm}+ BPM above resting</div>
        ${timerChip()}
      </header>
      <div class="vitals-grid">${s.players.map((p) => vitalsCard(p, s)).join('')}</div>
      <div class="footer-row">
        ${voting && me.alive && me.vote === null ? '<button class="btn" data-vote="skip">Skip vote</button>' : ''}
        ${voting && me.vote !== null ? '<span class="muted">Vote cast. Waiting for others...</span>' : ''}
        ${me.role === 'impostor' && me.alive ? `<button class="btn impostor-btn" data-action="fake_vitals" ${me.fakeAvailable ? '' : 'disabled'}>${fakeActive ? 'Fake vitals ACTIVE' : me.fakeAvailable ? 'Fake calm vitals (1x)' : 'Fake vitals used'}</button>` : ''}
        ${hostSkip(voting ? 'End voting' : 'Start voting')}
      </div>
      <div class="log">${s.log.slice(-5).reverse().map((l) => `<div>${esc(l.text)}</div>`).join('')}</div>
    </div>`;
}

function revealView() {
  const s = ui.state;
  const e = s.lastEjection;
  const ejected = e && e.playerId ? s.players.find((p) => p.id === e.playerId) : null;
  const name = (id) => (id === 'skip' ? 'Skip' : esc((s.players.find((p) => p.id === id) || {}).name || '?'));
  return `
    <div class="center">
      <div class="panel reveal">
        ${ejected ? `${avatar(ejected.color, { size: 120 })}
          <h2>${esc(ejected.name)} was ejected.</h2>
          <p class="reveal-role ${e.wasImpostor ? 'bad' : ''}">${e.wasImpostor ? 'They WERE the impostor.' : 'They were not the impostor.'}</p>`
          : `<h2>No one was ejected.</h2><p class="muted">${e && e.tie ? 'The vote was tied.' : 'The vote was skipped.'}</p>`}
        <div class="votes">${(e ? e.votes : []).map((v) => `<div>${name(v.voterId)} &rarr; ${name(v.targetId)}</div>`).join('')}</div>
      </div>
    </div>`;
}

function gameoverView() {
  const s = ui.state;
  const crewWon = s.winner.team === 'crew';
  const meWon = s.me && s.me.role === s.winner.team;
  return `
    <div class="center">
      <div class="panel gameover ${crewWon ? 'crew' : 'impostor'}">
        <h1>${crewWon ? 'Crew wins' : 'Impostor wins'}</h1>
        <p>${esc(s.winner.reason)}</p>
        <p class="big-result">${meWon ? 'Victory' : 'Defeat'}</p>
        <div class="roster">
          ${s.players.map((p) => `
            <div class="roster-row">
              ${avatar(p.color, { size: 36 })}
              <span class="pname">${esc(p.name)}</span>
              <span class="tag ${p.role === 'impostor' ? 'danger' : ''}">${p.role}</span>
            </div>`).join('')}
        </div>
        ${isHost() ? '<button class="btn primary" data-action="play_again">Back to lobby</button>' : '<p class="muted">Waiting for host...</p>'}
      </div>
    </div>`;
}

// ---- input ------------------------------------------------------------------

main.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled || !ui.net) return;
  const { action, accuse, vote } = btn.dataset;
  if (action) ui.net.send(action);
  else if (accuse) ui.net.send('accuse', { targetId: accuse });
  else if (vote) ui.net.send('vote', { targetId: vote });
});

// ---- camera selection --------------------------------------------------------

async function populateCameraList() {
  let cams;
  try {
    cams = await listCameras();
  } catch {
    return;
  }
  const select = $('#cam-select');
  const saved = localStorage.getItem('vv-camera') || '';
  select.innerHTML = cams
    .map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `Camera ${i + 1}`)}</option>`)
    .join('');
  $('#cam-select-wrap').classList.toggle('hidden', cams.length < 2);
  if (saved && cams.some((d) => d.deviceId === saved)) select.value = saved;
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  ui.config = await window.vv.getConfig();
  if (ui.config.sim) {
    $('#sim-badge').classList.remove('hidden');
    $('#sim-help').classList.remove('hidden');
  }
  ui.vitals = createVitals({ apiKey: ui.config.apiKey, sim: ui.config.sim, onChange: renderVitalsPanel });
  $('#recalibrate').onclick = () => ui.vitals.recalibrate();

  const savedCamera = localStorage.getItem('vv-camera') || undefined;
  await ui.vitals.start($('#cam'), savedCamera);
  await populateCameraList();
  navigator.mediaDevices.addEventListener('devicechange', populateCameraList);
  $('#cam-select').onchange = (e) => {
    const deviceId = e.target.value;
    if (!deviceId) return;
    localStorage.setItem('vv-camera', deviceId);
    ui.vitals.setDevice(deviceId);
  };

  setInterval(sendVitals, 1000);
  setInterval(sendFaceSnapshot, 33);
  setInterval(() => {
    if (ui.map) renderMap();
  }, 150);

  setupView();
}

boot();
