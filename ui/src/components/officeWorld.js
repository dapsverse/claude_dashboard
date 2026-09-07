// The office as a simulation, kept entirely free of React and of the DOM — the same reasoning as
// officeDesks.js and runList.js. Everything here is a plain function over plain data, so "does an
// agent that walks to the pantry come back to its own desk" is a unit test rather than something you
// have to watch happen. OfficeScene.jsx owns the clock and the pixels; this file owns the behaviour.
//
// Randomness is injected (`rng`) rather than reached for. Every branch in here is a coin flip, and a
// simulation that calls Math.random directly is a simulation you cannot write a single assertion
// about.

import { assignDesks } from './officeDesks.js';

// ---------------------------------------------------------------- room geometry
//
// Shared with officeArt.jsx: the art draws the pantry counter where PANTRY_SPOT says people stand,
// and the two files disagreeing is how you get an agent sipping coffee from the middle of the floor.

export const ROOM = { w: 256, h: 160 };
export const WALL = 8;

// The floor starts below the upper wall band that carries the windows.
export const FLOOR_TOP = 28;

// One horizontal aisle, and every walk in the building routes through it. This is the whole of the
// pathfinding: the room is a rectangle with furniture pushed to its edges, so "step into the aisle,
// walk along it, step off it" already looks like a person using a corridor. A* would be a lie about
// how complicated this room is.
//
// ponytail: single hardcoded aisle, so every route is at most three legs and nothing avoids anything
// else. Ceiling: it only holds while the furniture stays at the edges and the aisle stays empty. Add
// a walkability grid and real pathfinding if the room ever gains an obstacle in the middle of it.
// Chosen so the walking band is clear of furniture on both sides: the back row's desks end at y=53
// and the front row's monitors start at y=88, leaving the aisle a genuinely empty strip rather than
// a line that clips through a monitor every time somebody uses it.
export const LANE = 80;

export const DOOR = { x: 0, y: 112, w: WALL, h: 28 };
export const DOOR_SPOT = [4, 126];
// One step inside the door, before the aisle routing takes over — without it a sprite entering from
// the doorway would walk up the inside of the left wall to reach the aisle.
export const ENTRY_SPOT = [20, 126];

// Six seats, three across and two deep, fixed rather than computed from the occupant count so a desk
// never slides out from under whoever is already sitting at it.
export const DESK_SEATS = [
  [40, 60], [96, 60], [152, 60],
  [40, 122], [96, 122], [152, 122],
];

export const PANTRY_SPOT = [214, 56];
export const COOLER_SPOT = [216, 122];
export const BIN_RECT = { x: 196, y: 140, w: 18, h: 16 };
export const BIN_SPOT = [205, 148];

export function isOverBin(x, y) {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= BIN_RECT.x && x <= BIN_RECT.x + BIN_RECT.w
    && y >= BIN_RECT.y && y <= BIN_RECT.y + BIN_RECT.h;
}

export function beginDrag(world, id) {
  return { ...world, actors: world.actors.map((a) => a.id === id && a.role === 'worker' && !a.dragging
    ? { ...a, dragging: true, dragOrigin: [a.x, a.y] } : a) };
}

export function dragTo(world, id, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return world;
  return { ...world, actors: world.actors.map((a) => a.id === id && a.dragging ? { ...a, x, y } : a) };
}

export function endDrag(world, id, { rng = Math.random, instant = false } = {}) {
  return { ...world, actors: world.actors.map((a) => {
    if (a.id !== id || !a.dragging) return a;
    // Restore the origin so the frozen route still starts where the walk was interrupted.
    const next = { ...a, x: a.dragOrigin[0], y: a.dragOrigin[1], dragging: false, dragOrigin: null };
    if (instant && next.state !== 'oncall' && next.state !== 'leaving') {
      [next.x, next.y] = DESK_SEATS[next.deskIndex];
      next.path = [];
      sendHome(next, rng);
    }
    return next;
  }) };
}

// Where the orchestrator is willing to stand. A list rather than a random point in the rectangle:
// random coordinates put it inside a desk about a third of the time.
export const PATROL_SPOTS = [
  [24, LANE], [80, LANE], [140, LANE], [190, LANE],
  PANTRY_SPOT, COOLER_SPOT,
  [40, 146], [110, 146], [180, 146],
];

export const ORCHESTRATOR_ID = '__orchestrator__';

export const MAX_DESKS = DESK_SEATS.length;
export const CALL_MS = 2500;

// Pixels per second. Slow enough to read as walking at this scale; the sprite is 12px wide.
const SPEED = 34;

// Distance in pixels covered per leg of the walk cycle — the legs swap every STRIDE px travelled,
// which ties the animation to the movement rather than to the wall clock. Stop moving and the legs
// stop mid-stride instead of running on the spot.
const STRIDE = 6;

// ---------------------------------------------------------------- state durations

// A stint at the desk is long and every excursion is short, which is what keeps the room reading as
// an office rather than a cafe. Combined with the weights below, an agent spends roughly two thirds
// of its life seated.
const DURATION = {
  working: [12000, 30000],
  coffee: [3000, 5000],
  cooler: [2500, 4000],
  stretching: [2000, 3500],
  chatting: [3000, 5000],
  idle: [2000, 6000],
};

// `working` outweighs everything else combined. Lower it and the desks empty out.
const ACTIVITY_WEIGHTS = [
  ['working', 12],
  ['coffee', 3],
  ['cooler', 2],
  ['stretching', 2],
  ['chatting', 2],
];

const BUBBLE = {
  oncall: '☎',
  coffee: '☕',
  cooler: 'brb',
  stretching: 'ngh...',
  chatting: '...',
};

// A single fixed line reads as scripted the tenth time it pops up, so the acknowledgement
// is picked at random from a small pool instead of hardcoded to one phrase.
export const ACK_BUBBLES = ['Okay boss', 'Consider it done boss', 'Affirmative boss'];

// ---------------------------------------------------------------- helpers

const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);

function pickWeighted(rng, entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

// Step into the aisle, along it, then off it. Legs that would not move are dropped, so an agent
// already standing in the aisle does not first walk to itself.
export function route(fromX, fromY, toX, toY) {
  const legs = [[fromX, LANE], [toX, LANE], [toX, toY]];
  const out = [];
  let px = fromX;
  let py = fromY;
  for (const [x, y] of legs) {
    if (x === px && y === py) continue;
    out.push([x, y]);
    px = x;
    py = y;
  }
  return out;
}

// ---------------------------------------------------------------- actors

function worker(spec, { seated, rng }) {
  const [seatX, seatY] = DESK_SEATS[spec.deskIndex];
  const base = {
    id: spec.runId,
    role: 'worker',
    agentType: spec.agentType ?? 'unknown',
    deskIndex: spec.deskIndex,
    facing: 'down',
    bubble: null,
    partner: null,
    step: 0,
  };
  // `seated` is the reduced-motion path: no walk in from the door, no animation to miss.
  if (seated) {
    return { ...base, x: seatX, y: seatY, state: 'working', next: 'working', path: [], timer: between(rng, DURATION.working) };
  }
  return {
    ...base,
    x: DOOR_SPOT[0],
    y: DOOR_SPOT[1],
    facing: 'right',
    state: 'walking',
    next: 'working',
    path: [ENTRY_SPOT, ...route(ENTRY_SPOT[0], ENTRY_SPOT[1], seatX, seatY)],
    timer: 0,
  };
}

export function createWorld() {
  return {
    // Elapsed simulation time. Only the renderer uses it, to decide whose turn it is to speak — a
    // wall clock would do, but the world already advances in known steps and this keeps the whole
    // scene a function of the world rather than of Date.now().
    t: 0,
    actors: [{
      id: ORCHESTRATOR_ID,
      role: 'orchestrator',
      agentType: 'orchestrator',
      deskIndex: null,
      x: 24,
      y: LANE,
      facing: 'right',
      state: 'idle',
      next: 'idle',
      path: [],
      timer: 1500,
      bubble: null,
      partner: null,
      step: 0,
    }],
  };
}

// Reconciles who is in the room against who is actually running. Desk allocation itself is still
// officeDesks.assignDesks — an occupied desk is never handed to someone new, which is the property
// that stops a sprite teleporting mid-walk.
// An agent already walking out whose run turns out to be still going. Turning it around from
// wherever it has got to is the whole of this: pushing it through unchanged let it reach the door and
// be removed, while the sync had already decided not to spawn a replacement — so the run carried on
// with no sprite at all, until some unrelated change re-ran the sync and walked it back in from the
// door. That reappearance was the visible half of the bug; the silent gap before it was the real one.
function reseat(actor, spec, { rng, instant }) {
  const [seatX, seatY] = DESK_SEATS[spec.deskIndex];
  const base = {
    ...actor,
    deskIndex: spec.deskIndex,
    agentType: spec.agentType ?? actor.agentType,
    bubble: null,
    partner: null,
  };
  // Its old desk was free while it was leaving, so it may not be getting the same one back — the
  // assignment decides, not the actor.
  if (instant) {
    return { ...base, x: seatX, y: seatY, state: 'working', next: 'working', path: [], timer: between(rng, DURATION.working) };
  }
  return { ...base, state: 'walking', next: 'working', timer: 0, path: route(actor.x, actor.y, seatX, seatY) };
}

export function syncActors(world, runningRuns, { rng = Math.random, instant = false } = {}) {
  // A completed run must leave from its real position, even if completion arrived mid-drag.
  const runningIds = new Set(runningRuns.map((run) => run.id));
  for (const a of world.actors) {
    if (a.dragging && !runningIds.has(a.id)) world = endDrag(world, a.id, { rng, instant });
  }
  const present = world.actors
    .filter((a) => a.role === 'worker' && a.state !== 'leaving')
    .map((a) => ({ runId: a.id, agentType: a.agentType, deskIndex: a.deskIndex }));
  const { assignments } = assignDesks(present, runningRuns, MAX_DESKS);
  const wanted = new Map(assignments.map((a) => [a.runId, a]));

  const actors = [];
  for (const a of world.actors) {
    if (a.role === 'orchestrator') { actors.push(a); continue; }
    if (wanted.has(a.id)) {
      const spec = wanted.get(a.id);
      wanted.delete(a.id);
      actors.push(a.state === 'leaving' ? reseat(a, spec, { rng, instant }) : a);
      continue;
    }
    // Nobody walks out under reduced motion — there is no tick to carry them to the door, so they
    // would stand there for the rest of the session.
    if (instant) continue;
    if (a.state === 'leaving') { actors.push(a); continue; }
    actors.push({
      ...a,
      state: 'leaving',
      next: 'leaving',
      bubble: null,
      partner: null,
      path: [...route(a.x, a.y, ENTRY_SPOT[0], ENTRY_SPOT[1]), DOOR_SPOT],
    });
  }
  for (const spec of wanted.values()) actors.push(worker(spec, { seated: instant, rng }));

  return { ...world, actors };
}

// ---------------------------------------------------------------- movement

// Walks `a` along its path by however far SPEED allows in `dtMs`, consuming waypoints as it reaches
// them. Returns true when the path is exhausted. Mutates — the caller works on clones.
function advance(a, dtMs) {
  let budget = (SPEED * dtMs) / 1000;
  while (budget > 0 && a.path.length > 0) {
    const [tx, ty] = a.path[0];
    const dx = tx - a.x;
    const dy = ty - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) a.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (dist <= budget) {
      a.x = tx;
      a.y = ty;
      a.path.shift();
      a.step = (a.step + dist) % (STRIDE * 2);
      budget -= dist;
    } else {
      a.x += (dx / dist) * budget;
      a.y += (dy / dist) * budget;
      a.step = (a.step + budget) % (STRIDE * 2);
      budget = 0;
    }
  }
  return a.path.length === 0;
}

// True on the half of the stride where the near leg is forward. Rendering reads this rather than a
// frame counter, so a sprite that stops moving stops stepping.
export function strideForward(actor) {
  return actor.step < STRIDE;
}

function sendHome(a, rng) {
  const [seatX, seatY] = DESK_SEATS[a.deskIndex];
  a.bubble = null;
  a.partner = null;
  if (a.x === seatX && a.y === seatY) {
    a.state = 'working';
    a.next = 'working';
    a.timer = between(rng, DURATION.working);
    a.facing = 'down';
    return;
  }
  a.state = 'walking';
  a.next = 'working';
  a.path = route(a.x, a.y, seatX, seatY);
}

function endCall(a, rng, instant) {
  a.callHeld = false;
  a.bubble = null;
  a.partner = null;
  if (a.role === 'orchestrator') {
    a.state = 'idle';
    a.next = 'idle';
    a.timer = between(rng, DURATION.idle);
  } else {
    // With no movement ticks, returning home must also be instantaneous.
    if (instant) [a.x, a.y] = DESK_SEATS[a.deskIndex];
    sendHome(a, rng);
  }
}

function startCall(a) {
  return { ...a, state: 'oncall', next: 'oncall', path: [], partner: null, bubble: BUBBLE.oncall };
}

function acknowledge(a, rng = Math.random) {
  const bubble = ACK_BUBBLES[Math.floor(rng() * ACK_BUBBLES.length)];
  return { ...a, state: 'ack', next: 'ack', path: [], partner: null,
    bubble, timer: CALL_MS, callHeld: false, ackPending: false };
}

export function startBossAck(world, rng = Math.random) {
  return {
    ...world,
    callVersion: (world.callVersion ?? 0) + 1,
    actors: world.actors.map((a) => a.role !== 'orchestrator' ? a
      : a.callHeld ? { ...a, ackPending: true } : acknowledge(a, rng)),
  };
}

/** A user send or assistant message renews the short call without releasing a pending decision. */
export function startBossCall(world) {
  return {
    ...world,
    // A renewal must re-arm the reduced-motion timeout even when the timer is still 2500.
    callVersion: (world.callVersion ?? 0) + 1,
    actors: world.actors.map((a) => a.role === 'orchestrator'
      ? { ...startCall(a), callHeld: a.callHeld === true, timer: CALL_MS } : a),
  };
}

export function applyCalls(world, { callingIds, bossCalling, rng, instant = false }) {
  // Only an open modal holds the boss's handset. An absent or overflow worker can leave a call id
  // behind, but that id must never turn a short message notification into a permanent boss call.
  const bossHeld = bossCalling;
  return {
    ...world,
    actors: world.actors.map((a) => {
      if (a.state === 'leaving') return a;
      const held = a.role === 'orchestrator' ? bossHeld : callingIds.has(a.id);
      if (held) return { ...startCall(a), callHeld: true,
        ackPending: a.ackPending || a.state === 'ack', timer: a.state === 'oncall' ? a.timer : 0 };
      if (a.role === 'orchestrator' && a.ackPending) return acknowledge(a, rng);
      if (!a.callHeld || a.state !== 'oncall') return a;
      const next = { ...a, callHeld: false };
      if (next.timer <= 0) {
        // Release a call at the real origin; reduced motion must not teleport a held sprite.
        if (a.dragging) [next.x, next.y] = a.dragOrigin;
        endCall(next, rng, instant);
        if (a.dragging) {
          next.dragOrigin = [next.x, next.y];
          next.x = a.x;
          next.y = a.y;
        }
      }
      return next;
    }),
  };
}

function startActivity(a, actors, rng) {
  const choice = pickWeighted(rng, ACTIVITY_WEIGHTS);

  if (choice === 'working') {
    a.timer = between(rng, DURATION.working);
    a.facing = 'down';
    return;
  }

  if (choice === 'chatting') {
    // Only interrupt someone who is actually at their desk. Chasing an agent that is itself walking
    // somewhere means arriving at a seat they have already left.
    const candidates = actors.filter((o) => o.role === 'worker' && o.id !== a.id && o.state === 'working' && !o.dragging);
    if (candidates.length === 0) {
      a.timer = between(rng, DURATION.working);
      return;
    }
    const target = candidates[Math.floor(rng() * candidates.length)];
    const [seatX, seatY] = DESK_SEATS[target.deskIndex];
    a.state = 'walking';
    a.next = 'chatting';
    a.partner = target.id;
    a.path = route(a.x, a.y, seatX + 16, seatY);
    return;
  }

  const spot = choice === 'coffee' ? PANTRY_SPOT : COOLER_SPOT;
  a.state = 'walking';
  a.next = choice;
  a.path = route(a.x, a.y, spot[0], spot[1]);
}

function onArrive(a, byId, rng) {
  if (a.state === 'leaving') { a.gone = true; return; }

  a.state = a.next;
  a.timer = between(rng, DURATION[a.state] ?? DURATION.idle);

  if (a.state === 'chatting') {
    const partner = byId.get(a.partner);
    // The partner may have wandered off — or finished — between the decision and the arrival. Standing
    // there talking to an empty chair for a few seconds is a better failure than a crash.
    if (partner && partner.state === 'working' && !partner.dragging) {
      partner.state = 'chatting';
      partner.next = 'working';
      partner.partner = a.id;
      partner.timer = a.timer;
      partner.bubble = BUBBLE.chatting;
      partner.facing = 'right';
    } else {
      a.partner = null;
    }
    a.facing = 'left';
    a.bubble = BUBBLE.chatting;
    return;
  }

  a.bubble = BUBBLE[a.state] ?? null;
  if (a.state === 'working') a.facing = 'down';
}

function onTimeout(a, actors, rng) {
  if (a.role === 'orchestrator') {
    // No desk, no work: it wanders and it stands still, and the standing still is the point — a
    // sprite on a fixed loop reads as a mechanism, one that pauses reads as somebody thinking.
    const spot = PATROL_SPOTS[Math.floor(rng() * PATROL_SPOTS.length)];
    a.state = 'walking';
    a.next = 'idle';
    a.path = route(a.x, a.y, spot[0], spot[1]);
    return;
  }
  if (a.state === 'working') { startActivity(a, actors, rng); return; }
  sendHome(a, rng);
}

// One step of the simulation. Returns a new world with new actor objects — React needs a changed
// identity to re-render, and cloning seven small objects ten times a second costs nothing.
export function tick(world, dtMs, rng = Math.random, { instant = false } = {}) {
  const actors = world.actors.map((a) => ({ ...a, path: a.path.map((p) => p) }));
  const byId = new Map(actors.map((a) => [a.id, a]));

  for (const a of actors) {
    if (a.dragging) continue;
    if (a.state === 'oncall' || a.state === 'ack') {
      a.timer = Math.max(0, a.timer - dtMs);
      if (!a.callHeld && a.timer === 0) endCall(a, rng, instant);
      continue;
    }
    if (instant) continue;
    if (a.path.length > 0) {
      if (advance(a, dtMs)) onArrive(a, byId, rng);
      continue;
    }
    a.timer -= dtMs;
    if (a.timer <= 0) onTimeout(a, actors, rng);
  }

  return { ...world, t: world.t + dtMs, actors: actors.filter((a) => !a.gone) };
}
