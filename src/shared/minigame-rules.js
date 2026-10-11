'use strict';

const SWIPE_MIN_MS = 600;
const SWIPE_MAX_MS = 1300;

const WIRE_COLORS = ['red', 'blue', 'yellow', 'pink'];

// Coordinates are fractions of a square canvas.
const COURSE_WAYPOINTS = [
  { x: 0.1, y: 0.85 },
  { x: 0.3, y: 0.3 },
  { x: 0.52, y: 0.72 },
  { x: 0.72, y: 0.18 },
  { x: 0.9, y: 0.62 },
];
const WAYPOINT_RADIUS = 0.05;
const OFF_COURSE_DISTANCE = 0.09;

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function judgeSwipe(ms) {
  if (ms < SWIPE_MIN_MS) return 'too_fast';
  if (ms > SWIPE_MAX_MS) return 'too_slow';
  return 'ok';
}

function wirePuzzle() {
  return { left: shuffle(WIRE_COLORS), right: shuffle(WIRE_COLORS), sequence: shuffle(WIRE_COLORS) };
}

/** Judges connecting `leftColor` to `rightColor` when `doneCount` wires of `sequence` are already connected. */
function checkWire(sequence, doneCount, leftColor, rightColor) {
  if (leftColor !== rightColor) return 'wrong_color';
  if (sequence[doneCount] !== leftColor) return 'wrong_order';
  return 'ok';
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Advances the ship along the course. `index` is the last waypoint reached.
 * Returns the new index and a status of 'moving', 'advanced', 'done' or 'off_course'.
 */
function courseStep(index, pos) {
  const next = COURSE_WAYPOINTS[index + 1];
  if (!next) return { index, status: 'done' };
  if (Math.hypot(pos.x - next.x, pos.y - next.y) <= WAYPOINT_RADIUS) {
    const reached = index + 1;
    return { index: reached, status: reached === COURSE_WAYPOINTS.length - 1 ? 'done' : 'advanced' };
  }
  if (distanceToSegment(pos, COURSE_WAYPOINTS[index], next) > OFF_COURSE_DISTANCE) return { index, status: 'off_course' };
  return { index, status: 'moving' };
}

module.exports = {
  SWIPE_MIN_MS, SWIPE_MAX_MS, WIRE_COLORS, COURSE_WAYPOINTS, WAYPOINT_RADIUS, OFF_COURSE_DISTANCE,
  judgeSwipe, wirePuzzle, checkWire, courseStep,
};
