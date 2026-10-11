'use strict';

const WORLD = { width: 2400, height: 1500 };

const PLAYER_RADIUS = 18;
const SPEED = 230;
const USE_RANGE = 80;
const KILL_RANGE = 100;
const REPORT_RANGE = 120;
const BUTTON_RANGE = 90;
const VENT_RANGE = 70;
const VISION = { crew: 380, impostor: 520 };

const ROOMS = [
  { id: 'mess', name: 'Mess Hall', x: 950, y: 175, w: 500, h: 400 },
  { id: 'medbay', name: 'Medbay', x: 450, y: 250, w: 300, h: 250 },
  { id: 'lab', name: 'Lab', x: 1650, y: 250, w: 300, h: 250 },
  { id: 'hub', name: 'Hub', x: 1050, y: 700, w: 300, h: 200 },
  { id: 'reactor', name: 'Reactor', x: 50, y: 600, w: 300, h: 400 },
  { id: 'nav', name: 'Navigation', x: 2050, y: 600, w: 300, h: 400 },
  { id: 'elec', name: 'Electrical', x: 450, y: 1050, w: 300, h: 250 },
  { id: 'storage', name: 'Storage', x: 950, y: 975, w: 500, h: 400 },
  { id: 'comms', name: 'Comms', x: 1650, y: 1050, w: 300, h: 250 },
];

// Corridors overlap the rooms they join by 10 units so the walkable union has no seams.
const CORRIDORS = [
  { x: 740, y: 325, w: 220, h: 100 },   // medbay - mess
  { x: 1440, y: 325, w: 220, h: 100 },  // mess - lab
  { x: 1150, y: 565, w: 100, h: 145 },  // mess - hub
  { x: 1150, y: 890, w: 100, h: 95 },   // hub - storage
  { x: 340, y: 750, w: 720, h: 100 },   // reactor - hub
  { x: 1340, y: 750, w: 720, h: 100 },  // hub - nav
  { x: 550, y: 490, w: 100, h: 270 },   // medbay - west junction
  { x: 550, y: 840, w: 100, h: 220 },   // west junction - electrical
  { x: 1750, y: 490, w: 100, h: 270 },  // lab - east junction
  { x: 1750, y: 840, w: 100, h: 220 },  // east junction - comms
  { x: 740, y: 1125, w: 220, h: 100 },  // electrical - storage
  { x: 1440, y: 1125, w: 220, h: 100 }, // storage - comms
];

const WALKABLE = [...ROOMS, ...CORRIDORS];

const TASKS = [
  { id: 'wires', label: 'Reconnect the sensor wires', kind: 'hold', room: 'elec', x: 500, y: 1100 },
  { id: 'card', label: 'Swipe your ID badge', kind: 'hold', room: 'comms', x: 1900, y: 1100 },
  { id: 'samples', label: 'Sort the lab samples', kind: 'hold', room: 'lab', x: 1900, y: 300 },
  { id: 'reactor', label: 'Calm the reactor (stay near your resting BPM)', kind: 'calm', room: 'reactor', x: 120, y: 680 },
  { id: 'scan', label: 'Run a medbay scan', kind: 'hold', room: 'medbay', x: 500, y: 300 },
  { id: 'fuel', label: 'Refuel the engines', kind: 'hold', room: 'storage', x: 1000, y: 1320 },
  { id: 'course', label: 'Chart the course', kind: 'hold', room: 'nav', x: 2280, y: 800 },
];

// Vents in the same network connect to each other; list order is the cycle order.
const VENTS = [
  { id: 'medbay-vent', network: 'west', room: 'medbay', x: 680, y: 440 },
  { id: 'reactor-vent', network: 'west', room: 'reactor', x: 270, y: 930 },
  { id: 'comms-vent', network: 'west', room: 'comms', x: 1880, y: 1240 },
  { id: 'lab-vent', network: 'east', room: 'lab', x: 1720, y: 440 },
  { id: 'nav-vent', network: 'east', room: 'nav', x: 2130, y: 930 },
  { id: 'elec-vent', network: 'east', room: 'elec', x: 700, y: 1240 },
];

const EMERGENCY_BUTTON = { x: 1200, y: 375 };
const SPAWN = { x: 1200, y: 375, radius: 110 };

// Waypoint graph for bots. Every edge is axis-aligned and lies inside the walkable area.
const NODES = {
  mess: [1200, 375], medbay: [600, 375], lab: [1800, 375], hub: [1200, 800],
  reactor: [200, 800], nav: [2200, 800], elec: [600, 1175], storage: [1200, 1175],
  comms: [1800, 1175], westJunction: [600, 800], eastJunction: [1800, 800],
};

const EDGES = [
  ['medbay', 'mess'], ['mess', 'lab'], ['mess', 'hub'], ['hub', 'storage'],
  ['hub', 'westJunction'], ['westJunction', 'reactor'], ['westJunction', 'medbay'], ['westJunction', 'elec'],
  ['hub', 'eastJunction'], ['eastJunction', 'nav'], ['eastJunction', 'lab'], ['eastJunction', 'comms'],
  ['elec', 'storage'], ['storage', 'comms'],
];

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function inRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function pointWalkable(x, y) {
  return WALKABLE.some((r) => inRect(x, y, r));
}

/** True when a player-sized circle centered at (x, y) fits inside the walkable area. */
function isWalkable(x, y, radius = PLAYER_RADIUS) {
  if (!pointWalkable(x, y)) return false;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (!pointWalkable(x + Math.cos(a) * radius, y + Math.sin(a) * radius)) return false;
  }
  return true;
}

function roomAt(x, y) {
  const room = ROOMS.find((r) => inRect(x, y, r));
  return room ? room.name : null;
}

function spawnPoint(index, count) {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return { x: SPAWN.x + Math.cos(angle) * SPAWN.radius, y: SPAWN.y + Math.sin(angle) * SPAWN.radius };
}

function nearestNode(pos) {
  let best = null;
  let bestDist = Infinity;
  for (const [id, [x, y]] of Object.entries(NODES)) {
    const d = Math.hypot(pos.x - x, pos.y - y);
    if (d < bestDist) { best = id; bestDist = d; }
  }
  return best;
}

const NEIGHBORS = {};
for (const [a, b] of EDGES) {
  (NEIGHBORS[a] = NEIGHBORS[a] || []).push(b);
  (NEIGHBORS[b] = NEIGHBORS[b] || []).push(a);
}

function nodePath(from, to) {
  const dist = { [from]: 0 };
  const prev = {};
  const open = new Set(Object.keys(NODES));
  while (open.size) {
    let current = null;
    for (const id of open) if (dist[id] !== undefined && (current === null || dist[id] < dist[current])) current = id;
    if (current === null || current === to) break;
    open.delete(current);
    for (const next of NEIGHBORS[current] || []) {
      const [ax, ay] = NODES[current];
      const [bx, by] = NODES[next];
      const alt = dist[current] + Math.hypot(ax - bx, ay - by);
      if (dist[next] === undefined || alt < dist[next]) { dist[next] = alt; prev[next] = current; }
    }
  }
  const path = [to];
  while (path[0] !== from && prev[path[0]]) path.unshift(prev[path[0]]);
  return path;
}

/** Waypoints (excluding the start) that walk from one position to another along the graph. */
function route(from, to) {
  const start = nearestNode(from);
  const end = nearestNode(to);
  const points = nodePath(start, end).map((id) => ({ x: NODES[id][0], y: NODES[id][1] }));
  points.push({ x: to.x, y: to.y });
  return points;
}

function nearestVent(pos, range = VENT_RANGE) {
  let best = null;
  for (const v of VENTS) {
    const d = distance(pos, v);
    if (d <= range && (!best || d < distance(pos, best))) best = v;
  }
  return best;
}

/** The vent `step` places away from `ventId` within its network (1 = next, -1 = previous). */
function ventNeighbor(ventId, step) {
  const vent = VENTS.find((v) => v.id === ventId);
  if (!vent) return null;
  const network = VENTS.filter((v) => v.network === vent.network);
  const i = network.indexOf(vent);
  return network[(i + step + network.length) % network.length];
}

module.exports = {
  WORLD, PLAYER_RADIUS, SPEED, USE_RANGE, KILL_RANGE, REPORT_RANGE, BUTTON_RANGE, VENT_RANGE, VISION,
  ROOMS, CORRIDORS, WALKABLE, TASKS, VENTS, EMERGENCY_BUTTON, SPAWN, NODES, EDGES,
  distance, isWalkable, roomAt, spawnPoint, nearestNode, route, nearestVent, ventNeighbor,
};
