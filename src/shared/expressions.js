'use strict';

// Keys are the SmartSpectra ExpressionType codes.
const EXPRESSIONS = {
  1: { name: 'angry', emoji: '\u{1F620}' },
  2: { name: 'contempt', emoji: '\u{1F612}' },
  3: { name: 'disgust', emoji: '\u{1F922}' },
  4: { name: 'fear', emoji: '\u{1F628}' },
  5: { name: 'happy', emoji: '\u{1F604}' },
  6: { name: 'neutral', emoji: '\u{1F610}' },
  7: { name: 'sad', emoji: '\u{1F622}' },
  8: { name: 'surprise', emoji: '\u{1F62E}' },
};

const BY_NAME = Object.fromEntries(Object.values(EXPRESSIONS).map((e) => [e.name, e]));

const HOLD_MS = 500;
const STALE_MS = 3000;

function isExpression(name) {
  return typeof name === 'string' && Object.hasOwn(BY_NAME, name);
}

function emojiFor(name) {
  return isExpression(name) ? BY_NAME[name].emoji : '';
}

// decodeMetrics reports `type` as the enum name ("HAPPY"); raw protobuf objects use the numeric code.
function expressionFor(type) {
  return typeof type === 'string' ? BY_NAME[type.toLowerCase()] : EXPRESSIONS[type];
}

/** Name of the highest-confidence expression in SDK `scores`, or null if none reaches `minScore` (0-100). */
function topExpression(scores, minScore = 45) {
  let best = null;
  for (const s of scores || []) {
    const e = expressionFor(s.type);
    if (!e || !(s.confidence >= minScore)) continue;
    if (!best || s.confidence > best.confidence) best = { name: e.name, confidence: s.confidence };
  }
  return best ? best.name : null;
}

/** Smooths per-frame expressions so the shown one only changes after a challenger leads for HOLD_MS. */
class ExpressionTracker {
  constructor() {
    this.shown = null;
    this.candidate = null;
    this.candidateSince = 0;
    this.lastAt = -Infinity;
  }

  push(name, now) {
    this.lastAt = now;
    if (!name || name === this.shown) {
      this.candidate = null;
      return;
    }
    if (this.shown === null) {
      this.shown = name;
      return;
    }
    if (name !== this.candidate) {
      this.candidate = name;
      this.candidateSince = now;
    } else if (now - this.candidateSince >= HOLD_MS) {
      this.shown = name;
      this.candidate = null;
    }
  }

  current(now) {
    return now - this.lastAt > STALE_MS ? null : this.shown;
  }
}

module.exports = { EXPRESSIONS, HOLD_MS, STALE_MS, isExpression, emojiFor, topExpression, ExpressionTracker };
