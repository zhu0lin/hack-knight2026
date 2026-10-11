import {
  WORLD, ROOMS, WALKABLE, TASKS, VENTS, EMERGENCY_BUTTON, SPEED,
  USE_RANGE, KILL_RANGE, REPORT_RANGE, BUTTON_RANGE, VISION, isWalkable, distance, nearestVent, roomAt,
} from '../shared/map.js';
import { emojiFor } from '../shared/expressions.js';

const SEND_INTERVAL_MS = 66;
const VIEW_HEIGHT = 900;

const STARS = Array.from({ length: 220 }, () => ({
  x: Math.random() * WORLD.width,
  y: Math.random() * WORLD.height,
  r: Math.random() * 1.6 + 0.3,
}));

const VENT_CYCLE_KEYS = { a: 'prev', arrowleft: 'prev', d: 'next', arrowright: 'next' };

const MOVE_KEYS = {
  w: [0, -1], arrowup: [0, -1],
  s: [0, 1], arrowdown: [0, 1],
  a: [-1, 0], arrowleft: [-1, 0],
  d: [1, 0], arrowright: [1, 0],
};

function drawBean(ctx, x, y, color, { alpha = 1, lying = false } = {}) {
  ctx.save();
  ctx.translate(x, y);
  if (lying) ctx.rotate(Math.PI / 2);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 22, 16, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-15, -24, 30, 46, 15);
  ctx.fill();
  ctx.fillStyle = '#0b0f1a';
  ctx.beginPath();
  ctx.roundRect(-11, -15, 22, 11, 5);
  ctx.fill();
  ctx.strokeStyle = '#5ef0b4';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-9, -9.5);
  ctx.lineTo(-4, -9.5);
  ctx.lineTo(-2, -13);
  ctx.lineTo(1, -6);
  ctx.lineTo(3, -11);
  ctx.lineTo(5, -9.5);
  ctx.lineTo(9, -9.5);
  ctx.stroke();
  ctx.restore();
}

/**
 * Canvas map for the tasks phase. Owns the local player's position (client-side
 * movement with wall collision) and renders everyone else from server positions.
 */
export function createMapView(canvas, hooks) {
  const ctx = canvas.getContext('2d');
  const keys = new Set();
  const others = new Map();
  let state = null;
  let me = null;
  let lastFrame = performance.now();
  let lastSend = 0;
  let lastSent = null;
  let raf = 0;
  let prompt = null;

  const myPlayer = () => state && state.players.find((p) => p.id === state.me.id);
  const amAlive = () => state && state.me.alive;
  const amImpostor = () => state && state.me.role === 'impostor';
  const myVent = () => (state && state.me.ventId ? VENTS.find((v) => v.id === state.me.ventId) : null);

  function setState(next) {
    state = next;
    if (!me) {
      const p = myPlayer();
      if (p) me = { x: p.x, y: p.y };
    }
    const vent = myVent();
    if (vent) {
      me = { x: vent.x, y: vent.y };
      keys.clear();
    }
    const listed = new Set(next.players.map((p) => p.id));
    for (const id of others.keys()) if (!listed.has(id)) others.delete(id);
    for (const p of next.players) {
      if (p.id === next.me.id) continue;
      const o = others.get(p.id);
      if (!o) others.set(p.id, { x: p.x, y: p.y, tx: p.x, ty: p.y });
    }
  }

  function setPositions(list) {
    if (!state) return;
    for (const [id, x, y, expression] of list) {
      if (id === state.me.id) continue;
      if (!state.players.some((p) => p.id === id)) continue;
      let o = others.get(id);
      if (o) { o.tx = x; o.ty = y; } else others.set(id, (o = { x, y, tx: x, ty: y }));
      o.expression = expression;
    }
  }

  // ---- interaction targets ------------------------------------------------

  const canAct = () => me && amAlive() && !myVent();

  function nearestTask() {
    if (!canAct()) return null;
    return state.me.tasks.find((t) => !t.done && distance(me, t) <= USE_RANGE) || null;
  }

  function nearButton() {
    return canAct() && distance(me, EMERGENCY_BUTTON) <= BUTTON_RANGE;
  }

  function nearestBody() {
    if (!canAct()) return null;
    return (state.bodies || []).find((b) => distance(me, b) <= REPORT_RANGE) || null;
  }

  function enterableVent() {
    if (!canAct() || !amImpostor()) return null;
    return nearestVent(me);
  }

  function killTarget() {
    if (!canAct() || !amImpostor()) return null;
    let best = null;
    for (const p of state.players) {
      if (p.id === state.me.id || !p.alive) continue;
      const o = others.get(p.id);
      if (!o) continue;
      const d = distance(me, o);
      if (d <= KILL_RANGE && (!best || d < best.d)) best = { id: p.id, name: p.name, d };
    }
    return best;
  }

  function killCooldown() {
    return Math.max(0, Math.ceil((state.me.killReadyAt - hooks.now()) / 1000));
  }

  function computePrompt() {
    if (!state || !me) return null;
    if (hooks.isBusy()) return null;
    if (myVent()) return '[A/D] Switch vent     [V] Climb out';
    const parts = [];
    const task = nearestTask();
    if (task) parts.push(`[E] ${task.label}`);
    else if (nearButton()) parts.push('[E] Emergency meeting');
    const body = nearestBody();
    if (body) parts.push('[R] Report body');
    if (enterableVent()) parts.push('[V] Vent');
    const target = killTarget();
    if (target) {
      const cd = killCooldown();
      parts.push(cd ? `Kill ready in ${cd}s` : `[Q] Eliminate ${target.name}`);
    }
    return parts.join('     ');
  }

  // ---- input --------------------------------------------------------------

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (myVent()) {
      if (VENT_CYCLE_KEYS[k] || MOVE_KEYS[k]) e.preventDefault();
      if (e.repeat) return;
      if (VENT_CYCLE_KEYS[k]) hooks.send('vent', { action: VENT_CYCLE_KEYS[k] });
      else if (k === 'v') hooks.send('vent', { action: 'exit' });
      return;
    }
    if (MOVE_KEYS[k]) {
      keys.add(k);
      e.preventDefault();
      return;
    }
    if (e.repeat || !state || !me) return;
    if (k === 'e') {
      const task = nearestTask();
      if (task) hooks.useTask(task);
      else if (nearButton()) hooks.send('call_meeting');
    } else if (k === 'r') {
      const body = nearestBody();
      if (body) hooks.send('report', { bodyId: body.id });
    } else if (k === 'q') {
      const target = killTarget();
      if (target && !killCooldown()) hooks.send('kill', { targetId: target.id });
    } else if (k === 'v') {
      if (!hooks.isBusy() && enterableVent()) {
        keys.clear();
        hooks.send('vent', { action: 'enter' });
      }
    } else if (k === 'escape') {
      hooks.cancelTask();
    }
  }

  function onKeyUp(e) {
    keys.delete(e.key.toLowerCase());
  }

  function onBlur() { keys.clear(); }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ---- simulation ---------------------------------------------------------

  function step(dt) {
    for (const o of others.values()) {
      o.x += (o.tx - o.x) * Math.min(1, dt * 12);
      o.y += (o.ty - o.y) * Math.min(1, dt * 12);
    }
    if (!me || !state || hooks.isBusy() || myVent()) return;
    let dx = 0;
    let dy = 0;
    for (const k of keys) {
      dx += MOVE_KEYS[k][0];
      dy += MOVE_KEYS[k][1];
    }
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const dist = SPEED * dt;
      const nx = me.x + (dx / len) * dist;
      const ny = me.y + (dy / len) * dist;
      if (amAlive()) {
        if (isWalkable(nx, me.y)) me.x = nx;
        if (isWalkable(me.x, ny)) me.y = ny;
      } else {
        me.x = Math.min(WORLD.width, Math.max(0, nx));
        me.y = Math.min(WORLD.height, Math.max(0, ny));
      }
    }
    const nowMs = performance.now();
    if (nowMs - lastSend >= SEND_INTERVAL_MS && (!lastSent || lastSent.x !== me.x || lastSent.y !== me.y)) {
      hooks.send('move', { x: Math.round(me.x * 10) / 10, y: Math.round(me.y * 10) / 10 });
      lastSend = nowMs;
      lastSent = { x: me.x, y: me.y };
    }
  }

  // ---- rendering ----------------------------------------------------------

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
  }

  function drawWorld(scale) {
    ctx.fillStyle = '#7d8bb8';
    for (const s of STARS) {
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r / scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#4b5a8f';
    for (const r of WALKABLE) ctx.fillRect(r.x - 10, r.y - 10, r.w + 20, r.h + 20);
    ctx.fillStyle = '#262d48';
    for (const r of WALKABLE) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#2f3757';
    for (const r of ROOMS) ctx.fillRect(r.x, r.y, r.w, r.h);

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (const r of ROOMS) {
      for (let x = r.x + 50; x < r.x + r.w; x += 50) {
        ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      }
      for (let y = r.y + 50; y < r.y + r.h; y += 50) {
        ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(232,236,248,0.35)';
    ctx.font = '600 22px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    for (const r of ROOMS) ctx.fillText(r.name.toUpperCase(), r.x + r.w / 2, r.y + 34);

    ctx.fillStyle = '#3d4670';
    ctx.beginPath();
    ctx.arc(EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath();
    ctx.arc(EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffd1da';
    ctx.lineWidth = 3;
    ctx.stroke();

    const mine = new Set(state.me.tasks.filter((t) => !t.done).map((t) => t.id));
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
    for (const t of TASKS) {
      const active = mine.has(t.id);
      if (active) {
        ctx.fillStyle = `rgba(255, 213, 79, ${0.15 + pulse * 0.25})`;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 34, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = active ? '#ffd54f' : '#56608a';
      ctx.fillRect(t.x - 14, t.y - 10, 28, 20);
      ctx.fillStyle = '#0b0f1a';
      ctx.fillRect(t.x - 10, t.y - 6, 20, 9);
    }

    const current = myVent();
    for (const v of VENTS) {
      ctx.fillStyle = '#1a1f33';
      ctx.fillRect(v.x - 22, v.y - 14, 44, 28);
      ctx.strokeStyle = current && current.id === v.id ? '#ff4d6d' : '#56608a';
      ctx.lineWidth = 3;
      ctx.strokeRect(v.x - 22, v.y - 14, 44, 28);
      ctx.lineWidth = 2;
      for (let i = -14; i <= 14; i += 7) {
        ctx.beginPath();
        ctx.moveTo(v.x + i, v.y - 10);
        ctx.lineTo(v.x + i, v.y + 10);
        ctx.stroke();
      }
    }
  }

  function drawVentOverlay(w, h) {
    const vent = myVent();
    if (!vent) return;
    ctx.fillStyle = 'rgba(40, 6, 14, 0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '700 22px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff8fa3';
    ctx.fillText(`In the vents: ${roomAt(vent.x, vent.y) || ''}`, w / 2, 120);
  }

  function drawActors(vision) {
    const meAlive = amAlive();
    const visible = (pos) => !meAlive || distance(me, pos) <= vision;

    for (const b of state.bodies || []) {
      if (!visible(b)) continue;
      const p = state.players.find((q) => q.id === b.playerId);
      drawBean(ctx, b.x, b.y, p ? p.color : '#888', { lying: true });
      ctx.fillStyle = '#ff4d6d';
      ctx.font = '700 16px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('BODY', b.x, b.y - 30);
    }

    const drawn = [];
    for (const p of state.players) {
      if (p.id === state.me.id) continue;
      const o = others.get(p.id);
      if (!o) continue;
      if (!p.alive && meAlive) continue;
      if (!visible(o)) continue;
      drawn.push({
        p, x: o.x, y: o.y,
        expression: o.expression !== undefined ? o.expression : p.expression,
        bpm: p.vitals.bpm,
        spike: p.vitals.spike,
      });
    }
    const self = myPlayer();
    if (self && !myVent()) {
      const mine = hooks.myVitals ? hooks.myVitals() : null;
      drawn.push({
        p: self, x: me.x, y: me.y, isMe: true,
        expression: mine ? mine.expression : null,
        bpm: mine ? mine.bpm : self.vitals.bpm,
        spike: self.vitals.spike,
      });
    }
    drawn.sort((a, b) => a.y - b.y);

    for (const { p, x, y, isMe, expression, bpm, spike } of drawn) {
      drawBean(ctx, x, y, p.color, { alpha: p.alive ? 1 : 0.45 });
      ctx.font = `${isMe ? 700 : 600} 15px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = p.alive ? '#e8ecf8' : 'rgba(232,236,248,0.5)';
      ctx.fillText(p.name, x, y - 32);
      if (p.alive) drawHeadBubble(x, y - 66, expression, bpm, spike);
    }
  }

  /** Bubble above a player's head with their expression emoji and current BPM. */
  function drawHeadBubble(x, y, expression, bpm, spike) {
    const emoji = emojiFor(expression);
    const pulse = Number.isFinite(bpm) ? `\u2665 ${bpm}` : '';
    if (!emoji && !pulse) return;
    const emojiFont = '26px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    const pulseFont = '700 16px -apple-system, sans-serif';
    ctx.font = pulseFont;
    const pulseW = pulse ? ctx.measureText(pulse).width : 0;
    const emojiW = emoji ? 30 : 0;
    const gap = emoji && pulse ? 6 : 0;
    const w = emojiW + gap + pulseW + 20;
    const left = x - w / 2;

    ctx.fillStyle = spike ? 'rgba(90,12,28,0.9)' : 'rgba(11,15,26,0.75)';
    ctx.beginPath();
    ctx.roundRect(left, y - 18, w, 36, 12);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 18);
    ctx.lineTo(x + 6, y + 18);
    ctx.lineTo(x, y + 25);
    ctx.closePath();
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (emoji) {
      ctx.fillStyle = '#ffffff';
      ctx.font = emojiFont;
      ctx.fillText(emoji, left + 10, y + 1);
    }
    if (pulse) {
      ctx.font = pulseFont;
      const px = left + 10 + emojiW + gap;
      ctx.fillStyle = '#ff4d6d';
      ctx.fillText('\u2665', px, y + 1);
      ctx.fillStyle = spike ? '#ff8fa3' : '#e8ecf8';
      ctx.fillText(` ${bpm}`, px + ctx.measureText('\u2665').width, y + 1);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  }

  function drawFog(w, h, radiusPx) {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, radiusPx * 0.75, w / 2, h / 2, radiusPx);
    gradient.addColorStop(0, 'rgba(5,7,15,0)');
    gradient.addColorStop(1, 'rgba(5,7,15,0.92)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }

  function drawTaskArrows(w, h, scale) {
    const margin = 28;
    const top = 90;
    for (const t of state.me.tasks) {
      if (t.done) continue;
      const sx = w / 2 + (t.x - me.x) * scale;
      const sy = h / 2 + (t.y - me.y) * scale;
      if (sx > margin && sx < w - margin && sy > top && sy < h - margin) continue;
      const angle = Math.atan2(sy - h / 2, sx - w / 2);
      const ex = Math.min(w - margin, Math.max(margin, w / 2 + Math.cos(angle) * w));
      const ey = Math.min(h - margin, Math.max(top, h / 2 + Math.sin(angle) * h));
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(angle);
      ctx.fillStyle = '#ffd54f';
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPrompt(w, h) {
    if (!prompt) return;
    ctx.font = '700 18px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const width = ctx.measureText(prompt).width + 36;
    ctx.fillStyle = 'rgba(11,15,26,0.85)';
    ctx.beginPath();
    ctx.roundRect(w / 2 - width / 2, h - 86, width, 40, 10);
    ctx.fill();
    ctx.fillStyle = '#ffd54f';
    ctx.fillText(prompt, w / 2, h - 60);
  }

  function frame(t) {
    const dt = Math.min(0.1, (t - lastFrame) / 1000);
    lastFrame = t;
    step(dt);
    const { w, h, dpr } = resize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070f';
    ctx.fillRect(0, 0, w, h);

    if (state && me) {
      const scale = h / VIEW_HEIGHT;
      const vision = amImpostor() ? VISION.impostor : VISION.crew;
      ctx.save();
      ctx.translate(w / 2 - me.x * scale, h / 2 - me.y * scale);
      ctx.scale(scale, scale);
      drawWorld(scale);
      drawActors(vision);
      ctx.restore();
      if (amAlive()) drawFog(w, h, vision * scale);
      drawVentOverlay(w, h);
      drawTaskArrows(w, h, scale);
      prompt = computePrompt();
      drawPrompt(w, h);
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    setState,
    setPositions,
    position: () => me,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    },
  };
}
