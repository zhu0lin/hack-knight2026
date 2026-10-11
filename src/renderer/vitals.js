import { SmartSpectraSDK, MetricType, ValidationCode } from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { ExpressionTracker, topExpression } from '../shared/expressions.js';

const MIN_CONFIDENCE = 40;
const CALIBRATION_MS = 20_000;
const MIN_CALIBRATION_SAMPLES = 5;

const VALIDATION_HINTS = {
  [ValidationCode.kOk]: null,
  [ValidationCode.kNoFaceFound]: 'No face found - look at the camera',
  [ValidationCode.kMultipleFacesFound]: 'Only one face per camera, please',
  [ValidationCode.kFaceNotCentered]: 'Center your face in the frame',
  [ValidationCode.kFaceSizeOutOfRange]: 'Adjust your distance to the camera',
  [ValidationCode.kTooDark]: 'Too dark - add light in front of you',
  [ValidationCode.kTooBright]: 'Too bright - reduce backlight / glare',
  [ValidationCode.kChestNotVisible]: 'Lean back so your upper chest is visible',
  [ValidationCode.kCameraTuning]: 'Camera tuning... hold still',
  [ValidationCode.kFrameRateTooLow]: 'Frame rate too low - close other apps',
  [ValidationCode.kExcessiveMotion]: 'Too much motion - sit still',
  [ValidationCode.kFaceTooClose]: 'Move back a little',
  [ValidationCode.kFaceTooFar]: 'Move closer to the camera',
  [ValidationCode.kFaceTooHigh]: 'Lower the camera or move down',
  [ValidationCode.kFaceTooLow]: 'Raise the camera or move up',
  [ValidationCode.kFaceNotForward]: 'Face the camera directly',
};

export function hintFor(code, fallback) {
  if (code in VALIDATION_HINTS) return VALIDATION_HINTS[code];
  return fallback || 'Adjust position / lighting';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Tracks the latest pulse reading and derives a resting baseline from the
 * first CALIBRATION_MS of confident samples.
 */
class VitalsTracker {
  constructor(onChange) {
    this.onChange = onChange;
    this.state = {
      status: 'idle',
      bpm: null,
      confidence: 0,
      stable: false,
      hint: 'Starting camera...',
      validationOk: false,
      baseline: null,
      locked: false,
      calibrationProgress: 0,
      error: null,
      expression: null,
    };
    this.samples = [];
    this.calibrationStartedAt = null;
    this.expressions = new ExpressionTracker();
    setInterval(() => this.refreshExpression(), 1000);
  }

  pushExpression(name) {
    this.expressions.push(name, Date.now());
    this.refreshExpression();
  }

  refreshExpression() {
    const expression = this.expressions.current(Date.now());
    if (expression !== this.state.expression) this.update({ expression });
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.onChange({ ...this.state });
  }

  recalibrate() {
    this.samples = [];
    this.calibrationStartedAt = null;
    this.update({ baseline: null, locked: false, calibrationProgress: 0 });
  }

  pushPulse(bpm, confidence, stable) {
    const good = confidence >= MIN_CONFIDENCE || stable;
    const patch = { bpm, confidence, stable };
    if (!this.state.locked && good) {
      const now = Date.now();
      if (this.calibrationStartedAt === null) this.calibrationStartedAt = now;
      this.samples.push(bpm);
      const elapsed = now - this.calibrationStartedAt;
      patch.calibrationProgress = Math.min(1, elapsed / CALIBRATION_MS);
      if (elapsed >= CALIBRATION_MS && this.samples.length >= MIN_CALIBRATION_SAMPLES) {
        patch.baseline = Math.round(median(this.samples));
        patch.locked = true;
        patch.calibrationProgress = 1;
      }
    }
    this.update(patch);
  }
}

class PresageSource {
  constructor(apiKey, tracker) {
    this.tracker = tracker;
    this.sdk = new SmartSpectraSDK({
      apiKey,
      requestedMetrics: [MetricType.PULSE_RATE, MetricType.EXPRESSIONS],
    });
  }

  async start(videoEl) {
    const { sdk, tracker } = this;
    sdk.on('streamAvailable', (stream) => {
      videoEl.srcObject = stream;
    });
    sdk.on('processingStatus', (status) => {
      const names = ['uninitialized', 'idle', 'starting', 'running', 'stopping', 'error'];
      tracker.update({ status: names[status] || String(status) });
    });
    sdk.on('validationStatus', (code, _ts, hint) => {
      tracker.update({
        validationOk: code === ValidationCode.kOk,
        hint: hintFor(code, hint),
      });
    });
    sdk.on('metrics', (buf) => {
      const metrics = decodeMetrics(buf);
      const pulse = metrics.cardio?.pulseRate?.at(-1);
      if (pulse && pulse.value > 0) {
        tracker.pushPulse(Math.round(pulse.value), pulse.confidence, pulse.stable);
      }
      const expression = metrics.face?.expression?.at(-1);
      if (expression) tracker.pushExpression(topExpression(expression.scores));
    });
    sdk.on('error', (code, message) => {
      tracker.update({ status: 'error', error: `SmartSpectra error ${code}: ${message}` });
    });
    tracker.update({ status: 'starting', hint: 'Camera tuning... hold still' });
    try {
      await sdk.start();
    } catch (err) {
      tracker.update({ status: 'error', error: err.message || String(err) });
    }
  }
}

/**
 * Stand-in for the SDK when no API key is configured. Produces a plausible
 * resting pulse that random-walks; holding the "H" key simulates stress.
 */
class SimulatedSource {
  constructor(tracker) {
    this.tracker = tracker;
    this.resting = 66 + Math.round(Math.random() * 12);
    this.bpm = this.resting;
    this.stress = 0;
    this.stressHeld = false;
    this.faceHeld = null;
  }

  async start(videoEl) {
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 360 } })
      .then((stream) => { videoEl.srcObject = stream; })
      .catch(() => {});

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'h') this.stressHeld = true;
      if (SIM_FACE_KEYS[k]) this.faceHeld = SIM_FACE_KEYS[k];
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'h') this.stressHeld = false;
      if (SIM_FACE_KEYS[k] === this.faceHeld) this.faceHeld = null;
    });

    this.tracker.update({ status: 'running', validationOk: true, hint: null });
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.tracker.pushExpression(this.faceHeld || (this.stressHeld ? 'fear' : 'neutral')), 100);
  }

  tick() {
    this.stress = this.stressHeld ? Math.min(30, this.stress + 4) : Math.max(0, this.stress - 1.5);
    const target = this.resting + this.stress;
    this.bpm += (target - this.bpm) * 0.35 + (Math.random() - 0.5) * 2;
    this.tracker.pushPulse(Math.round(this.bpm), 90, true);
  }
}

const SIM_FACE_KEYS = { 1: 'happy', 2: 'surprise', 3: 'angry', 4: 'sad' };

function isTyping(e) {
  const tag = e.target && e.target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

export function createVitals({ apiKey, sim, onChange }) {
  const tracker = new VitalsTracker(onChange);
  const source = sim ? new SimulatedSource(tracker) : new PresageSource(apiKey, tracker);
  return {
    start: (videoEl) => source.start(videoEl),
    recalibrate: () => tracker.recalibrate(),
    get state() { return { ...tracker.state }; },
  };
}
