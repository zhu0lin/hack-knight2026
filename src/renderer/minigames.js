import {
  COURSE_WAYPOINTS, WIRE_COLORS, judgeSwipe, wirePuzzle, checkWire, courseStep,
} from '../shared/minigame-rules.js';
import * as sound from './sound.js';

const WIRE_HEX = { red: '#ff4d6d', blue: '#3498db', yellow: '#ffd54f', pink: '#ff6fb5' };
const SWIPE_SLOT_START = 40;

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Sizes a canvas for the device pixel ratio and returns a context drawing in CSS pixels. */
function setupCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function pointerPos(canvas, e, width, height) {
  const rect = canvas.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) / rect.width) * width, y: ((e.clientY - rect.top) / rect.height) * height };
}

// ---- ID card swipe ----------------------------------------------------------

function swipeGame(body, { setStatus, complete }) {
  body.innerHTML = `
    <div class="swipe-track">
      <div class="swipe-slot"><span>INSERT</span><span>READ</span></div>
      <div class="swipe-card"><b>ID</b><span>CREW</span></div>
    </div>
    <div class="swipe-light"></div>`;
  const track = body.querySelector('.swipe-track');
  const card = body.querySelector('.swipe-card');
  const light = body.querySelector('.swipe-light');
  let drag = null;
  setStatus('Drag the card through the reader at a steady pace.');

  const place = (left) => { card.style.transform = `translateX(${left}px)`; };
  const reset = (message) => {
    drag = null;
    place(0);
    if (message) {
      setStatus(message, 'bad');
      light.className = 'swipe-light bad';
      sound.buzz();
    }
  };

  card.addEventListener('pointerdown', (e) => {
    card.setPointerCapture(e.pointerId);
    drag = { startX: e.clientX, left: 0, maxLeft: 0, enteredAt: null };
    light.className = 'swipe-light';
  });
  card.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const travel = track.clientWidth - card.offsetWidth;
    const left = Math.max(0, Math.min(travel, e.clientX - drag.startX));
    if (drag.enteredAt !== null && left < drag.maxLeft - 12) {
      reset('Bad read. Keep the card moving forward.');
      return;
    }
    drag.maxLeft = Math.max(drag.maxLeft, left);
    drag.left = left;
    place(left);
    if (drag.enteredAt === null && left >= SWIPE_SLOT_START) drag.enteredAt = performance.now();
    if (left >= travel && drag.enteredAt !== null) {
      const verdict = judgeSwipe(performance.now() - drag.enteredAt);
      if (verdict === 'ok') {
        drag = null;
        light.className = 'swipe-light ok';
        setStatus('Accepted. Thank you.', 'ok');
        complete();
      } else {
        reset(verdict === 'too_fast' ? 'Too fast. Try again.' : 'Too slow. Try again.');
      }
    }
  });
  card.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.enteredAt !== null) reset('Bad read. Swipe all the way through.');
    else reset();
  });
  return null;
}

// ---- wires ------------------------------------------------------------------

function wiresGame(body, { setStatus, complete }) {
  const W = 440;
  const H = 260;
  const puzzle = wirePuzzle();
  body.innerHTML = `<div class="wire-order"></div><canvas class="mg-canvas"></canvas>`;
  const order = body.querySelector('.wire-order');
  const canvas = body.querySelector('canvas');
  const ctx = setupCanvas(canvas, W, H);
  const rowY = (i) => 40 + i * ((H - 80) / (WIRE_COLORS.length - 1));
  const leftEnds = puzzle.left.map((color, i) => ({ color, x: 40, y: rowY(i) }));
  const rightEnds = puzzle.right.map((color, i) => ({ color, x: W - 40, y: rowY(i) }));
  let connected = [];
  let drag = null;
  let flashUntil = 0;
  let raf = 0;
  let finished = false;
  setStatus('Connect the wires in the order shown above.');

  const renderOrder = () => {
    order.innerHTML = puzzle.sequence.map((c, i) => `
      <span class="wire-chip ${i < connected.length ? 'done' : ''} ${i === connected.length ? 'next' : ''}" style="background:${WIRE_HEX[c]}">${i + 1}</span>`).join('');
  };
  renderOrder();

  const near = (list, p, r) => list.find((end) => Math.hypot(end.x - p.x, end.y - p.y) <= r);

  canvas.addEventListener('pointerdown', (e) => {
    if (finished) return;
    const p = pointerPos(canvas, e, W, H);
    const end = near(leftEnds, p, 24);
    if (!end || connected.includes(end.color)) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { from: end, to: p };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) drag.to = pointerPos(canvas, e, W, H);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const target = near(rightEnds, pointerPos(canvas, e, W, H), 28);
    const from = drag.from;
    drag = null;
    if (!target) return;
    const result = checkWire(puzzle.sequence, connected.length, from.color, target.color);
    if (result === 'ok') {
      connected = [...connected, from.color];
      sound.blip();
      if (connected.length === WIRE_COLORS.length) {
        finished = true;
        setStatus('Wires reconnected.', 'ok');
        complete();
      } else {
        setStatus('Connect the wires in the order shown above.');
      }
    } else {
      connected = [];
      flashUntil = performance.now() + 450;
      sound.buzz();
      setStatus(result === 'wrong_color' ? 'Colors must match. Panel reset.' : 'Wrong order. Panel reset.', 'bad');
    }
    renderOrder();
  });

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = performance.now() < flashUntil ? '#4a1422' : '#161c30';
    ctx.fillRect(0, 0, W, H);
    ctx.lineCap = 'round';
    const wire = (from, to, color) => {
      ctx.strokeStyle = WIRE_HEX[color];
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo((from.x + to.x) / 2, from.y, (from.x + to.x) / 2, to.y, to.x, to.y);
      ctx.stroke();
    };
    for (const color of connected) {
      wire(leftEnds.find((l) => l.color === color), rightEnds.find((r) => r.color === color), color);
    }
    if (drag) wire(drag.from, drag.to, drag.from.color);
    for (const end of [...leftEnds, ...rightEnds]) {
      ctx.fillStyle = '#0b0f1a';
      ctx.fillRect(end.x - 22, end.y - 14, 44, 28);
      ctx.fillStyle = WIRE_HEX[end.color];
      ctx.fillRect(end.x - 16, end.y - 9, 32, 18);
    }
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}

// ---- course -----------------------------------------------------------------

function courseGame(body, { setStatus, complete }) {
  const S = 360;
  body.innerHTML = '<canvas class="mg-canvas"></canvas>';
  const canvas = body.querySelector('canvas');
  const ctx = setupCanvas(canvas, S, S);
  let index = 0;
  let ship = { ...COURSE_WAYPOINTS[0] };
  let dragging = false;
  let finished = false;
  let raf = 0;
  setStatus('Drag the ship through each waypoint in order. Stay on the route.');

  const backToWaypoint = (message) => {
    dragging = false;
    ship = { ...COURSE_WAYPOINTS[index] };
    if (message) {
      setStatus(message, 'bad');
      sound.buzz();
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (finished) return;
    const p = pointerPos(canvas, e, S, S);
    if (Math.hypot(p.x - ship.x * S, p.y - ship.y * S) > 30) return;
    canvas.setPointerCapture(e.pointerId);
    dragging = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pointerPos(canvas, e, S, S);
    const target = { x: p.x / S, y: p.y / S };
    // Walk in small steps so a fast drag can't skip over a waypoint.
    const steps = Math.max(1, Math.ceil(Math.hypot(target.x - ship.x, target.y - ship.y) / 0.01));
    const from = ship;
    for (let i = 1; i <= steps && dragging; i++) {
      const pos = { x: from.x + ((target.x - from.x) * i) / steps, y: from.y + ((target.y - from.y) * i) / steps };
      const result = courseStep(index, pos);
      if (result.status === 'off_course') {
        backToWaypoint(`Off course! Back to waypoint ${index + 1}.`);
        return;
      }
      ship = pos;
      if (result.status === 'advanced') {
        index = result.index;
        sound.blip();
        setStatus(`Waypoint ${index + 1} reached. Keep going.`, 'ok');
      } else if (result.status === 'done') {
        index = result.index;
        ship = { ...COURSE_WAYPOINTS[index] };
        dragging = false;
        finished = true;
        setStatus('Course charted.', 'ok');
        complete();
      }
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (dragging && !finished) backToWaypoint(`Let go. Back to waypoint ${index + 1}.`);
  });

  function draw() {
    ctx.fillStyle = '#0b1024';
    ctx.fillRect(0, 0, S, S);
    for (let i = 1; i < COURSE_WAYPOINTS.length; i++) {
      const a = COURSE_WAYPOINTS[i - 1];
      const b = COURSE_WAYPOINTS[i];
      ctx.strokeStyle = i <= index ? '#5ef0b4' : 'rgba(232,236,248,0.45)';
      ctx.lineWidth = i <= index ? 4 : 2;
      ctx.setLineDash(i <= index ? [] : [8, 8]);
      ctx.beginPath();
      ctx.moveTo(a.x * S, a.y * S);
      ctx.lineTo(b.x * S, b.y * S);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    COURSE_WAYPOINTS.forEach((w, i) => {
      ctx.fillStyle = i <= index ? '#5ef0b4' : i === index + 1 ? '#ffd54f' : '#56608a';
      ctx.beginPath();
      ctx.arc(w.x * S, w.y * S, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b0f1a';
      ctx.font = '700 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), w.x * S, w.y * S);
    });
    const next = COURSE_WAYPOINTS[Math.min(index + 1, COURSE_WAYPOINTS.length - 1)];
    const angle = Math.atan2(next.y - ship.y, next.x - ship.x);
    ctx.save();
    ctx.translate(ship.x * S, ship.y * S);
    ctx.rotate(angle);
    ctx.fillStyle = '#e8ecf8';
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -10);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-10, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}

const GAMES = { swipe: swipeGame, wires: wiresGame, course: courseGame };

export function isMinigame(kind) {
  return Object.hasOwn(GAMES, kind);
}

/** Mounts the minigame for `task` into `container`. Calls `onComplete` once when it is solved. */
export function mountMinigame(container, task, { onComplete }) {
  const root = document.createElement('div');
  root.className = 'minigame';
  root.innerHTML = `
    <h3>${esc(task.label)}</h3>
    <div class="mg-body"></div>
    <div class="mg-status"></div>
    <div class="muted">Esc to cancel</div>`;
  container.appendChild(root);
  const statusEl = root.querySelector('.mg-status');
  let done = false;
  let timer = 0;
  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = `mg-status ${kind}`;
  };
  const complete = () => {
    if (done) return;
    done = true;
    timer = setTimeout(onComplete, 500);
  };
  const cleanup = GAMES[task.kind](root.querySelector('.mg-body'), { setStatus, complete });
  return {
    destroy() {
      clearTimeout(timer);
      if (cleanup) cleanup();
      root.remove();
    },
  };
}
