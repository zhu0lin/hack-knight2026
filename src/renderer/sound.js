let ctx = null;

function audio() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, duration, { type = 'sine', gain = 0.15 } = {}) {
  const ac = audio();
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ac.currentTime + start;
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export function spike() {
  tone(880, 0, 0.12, { type: 'square', gain: 0.08 });
  tone(880, 0.18, 0.12, { type: 'square', gain: 0.08 });
}

export function alarm() {
  for (let i = 0; i < 3; i++) {
    tone(520, i * 0.4, 0.2, { type: 'sawtooth', gain: 0.08 });
    tone(390, i * 0.4 + 0.2, 0.2, { type: 'sawtooth', gain: 0.08 });
  }
}

export function thud() {
  tone(90, 0, 0.5, { type: 'triangle', gain: 0.3 });
}

export function accuse() {
  tone(330, 0, 0.15, { type: 'triangle' });
  tone(247, 0.15, 0.3, { type: 'triangle' });
}

export function blip() {
  tone(1200, 0, 0.08, { gain: 0.1 });
}

export function roleReveal() {
  tone(196, 0, 0.8, { type: 'sine', gain: 0.2 });
  tone(147, 0.3, 1.0, { type: 'sine', gain: 0.15 });
}

export function fanfare() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.15, 0.3, { type: 'triangle', gain: 0.12 }));
}
