import { useEffect, useRef, useState } from 'react';
import { OfficeArt } from './officeArt.jsx';
import { runToolUseId } from './runList.js';
import { MAX_DESKS, ROOM, applyCalls, beginDrag, createWorld, dragTo, endDrag, isOverBin, startBossAck, startBossCall, strideForward, syncActors, tick } from './officeWorld.js';

// 10fps. Pixel art at this scale has nothing to gain from 60, and this panel sits beside a live
// transcript — it has no business being the most expensive thing on the page.
const TICK_MS = 100;

// Long enough to read, short enough not to become a second activity log. The row below already
// carries the full text; this is the glanceable version.
const BUBBLE_MAX = 22;

// How long one agent's task description stays up before the turn passes to the next.
const SPEAKING_MS = 4000;

// --accent is deliberately absent: the orchestrator wears it, and it is the one sprite that has to
// be picked out of a full room at a glance.
const SHIRTS = ['#4ade80', '#f87171', '#fbbf24', '#c084fc', '#38bdf8', '#fb923c', '#a3e635', '#f472b6'];
const HAIRS = ['#3b2a1e', '#6b4423', '#c9a227', '#8b1e1e', '#2b2b33', '#a8adb8'];

// Deterministic, not random: the same agent type always gets the same look, so a reload does not
// reshuffle who is who. Purely decorative — never load-bearing the way a status colour is.
//
// Two independent draws off one hash rather than one, because a single six-colour palette collides
// constantly: the real agent roster put four of six sprites in the same shirt. 8 shirts x 6 hair
// colours is 48 combinations, so a collision now needs both draws to land together.
function lookFor(agentType) {
  let hash = 0;
  for (const ch of agentType) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { shirt: SHIRTS[hash % SHIRTS.length], hair: HAIRS[(hash >>> 5) % HAIRS.length] };
}

// A real accessibility requirement rather than a CSS nicety, which is why it is read in JS: the
// motion here is a JS tick, and a `prefers-reduced-motion` block in the stylesheet cannot stop a
// setInterval. Honouring it means not running the simulation at all — agents are placed at their
// desks and stay there.
function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query)?.matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq?.addEventListener) return undefined;
    const onChange = (event) => setReduced(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// Eyes are the whole of the facing cue at 12 pixels wide — there is no room for a turned body, and a
// sprite that never looks where it is going reads as being dragged rather than walking.
const EYES = {
  down: [[-2, -4], [1, -4]],
  left: [[-3, -4]],
  right: [[2, -4]],
  up: [],
};

function Actor({ actor, onPointerDown }) {
  const walking = !actor.dragging && actor.path.length > 0;
  const boss = actor.role === 'orchestrator';
  const skin = boss ? '#f6d3ae' : '#f0c8a0';
  const { shirt, hair } = boss
    ? { shirt: 'var(--accent)', hair: '#2b2b33' }
    : lookFor(actor.agentType);
  // The legs swap on distance travelled, not on a frame counter, so stopping mid-room does not
  // leave the sprite jogging in place.
  const spread = walking && strideForward(actor) ? 1 : 0;

  // Two nested groups, deliberately: the outer one carries the position as a plain SVG `transform`
  // attribute and is never touched by CSS, because a CSS transform on an SVG element replaces its
  // attribute transform rather than composing with it — put both on one node and the position is
  // simply gone. The inner group owns the idle bob.
  return (
    <g transform={`translate(${Math.round(actor.x)} ${Math.round(actor.y)})`}>
      <g
        className={`sprite${walking ? ' walking' : ''}${actor.state === 'leaving' ? ' leaving' : ''}`}
        data-run-id={actor.id}
        data-state={actor.state}
        data-dragging={actor.dragging || undefined}
        onPointerDown={actor.role === 'worker' ? onPointerDown : undefined}
        style={actor.role === 'worker' ? { touchAction: 'none', cursor: actor.dragging ? 'grabbing' : 'grab' } : undefined}
      >
        <g className="sprite-body">
          {/* Shadow, so the sprite is standing on the floor rather than floating over it. */}
          <rect x={-4} y={8} width={8} height={1} className="off-shadow" />
          <rect x={-4} y={-10} width={8} height={actor.facing === 'up' ? 6 : 4} className="sprite-hair" fill={hair} />
          {/* A hat brim, and the only structural difference between the two roles: the orchestrator
              has to be findable in a room of six without reading any text. */}
          {boss && <rect x={-6} y={-7} width={12} height={1} fill={shirt} />}
          <rect x={-3} y={-6} width={6} height={5} fill={skin} />
          {EYES[actor.facing].map(([ex, ey], i) => (
            <rect key={i} x={ex} y={ey} width={1} height={1} className="off-eye" />
          ))}
          <rect x={-4} y={-1} width={8} height={6} fill={shirt} />
          <rect x={-6} y={-1} width={2} height={4} fill={skin} />
          <rect x={4} y={-1} width={2} height={4} fill={skin} />
          {actor.state === 'oncall' && (
            <g className="sprite-phone" transform={actor.facing === 'left' ? 'scale(-1 1)' : undefined}>
              <rect x={4} y={-3} width={2} height={4} fill={skin} />
              <rect x={5} y={-7} width={1} height={6} className="off-eye" />
              <rect x={3} y={-7} width={3} height={2} className="off-eye" />
              <rect x={3} y={-2} width={3} height={2} className="off-eye" />
            </g>
          )}
          <rect x={-3 - spread} y={5} width={2} height={4} className="sprite-legs" />
          <rect x={1 + spread} y={5} width={2} height={4} className="sprite-legs" />
        </g>
      </g>
    </g>
  );
}

// Drawn in a pass of its own, after every actor, so a bubble is never hidden behind the sprite
// standing in front of its owner.
function Bubble({ actor, text }) {
  // Cut at a word boundary, but only when the cut actually broke a word: "Investigate EVM chain…" is
  // a phrase and "Investigate EVM chain pr…" is a glitch, yet backing off unconditionally would
  // throw away a word that fitted exactly. Nothing to back off to (one long token) keeps the hard
  // cut — a bubble is better short than empty.
  const room = BUBBLE_MAX - 1;
  const cut = text.slice(0, room);
  const brokeAWord = /\S/.test(text.charAt(room));
  const boundary = cut.lastIndexOf(' ');
  const kept = brokeAWord && boundary > room / 2 ? cut.slice(0, boundary) : cut;
  const trimmed = text.length <= BUBBLE_MAX ? text : `${kept.trimEnd()}…`;
  // ponytail: bubble width is a per-character estimate, not a measurement. 3.6px is the advance of
  // the 6px monospace it is set in; measuring properly means a getBBox per bubble per frame, which
  // is real layout thrash to buy a decorative box a couple of pixels. Ceiling: it is only right
  // while .off-bubble-text stays monospace at 6px — change either and the box stops fitting.
  const width = Math.max(14, trimmed.length * 3.6 + 7);
  const y = Math.round(actor.y);
  // Clamped to the room: an agent at the pantry is 42px from the right wall, and a bubble wide
  // enough to hold "running WebFetch" would otherwise hang outside the scene and be clipped by the
  // panel. The tail stays over the speaker's head, so a shifted bubble still points at its owner.
  const centre = Math.min(Math.max(Math.round(actor.x), width / 2 + 2), ROOM.w - width / 2 - 2);
  const tail = Math.round(actor.x) - centre;
  return (
    <g className="office-bubble" transform={`translate(${centre} ${y - 14})`}>
      <rect x={-width / 2} y={-12} width={width} height={12} rx={3} className="off-bubble" />
      <rect x={tail - 2} y={-1} width={4} height={2} className="off-bubble-tail" />
      <text x={0} y={-3.5} textAnchor="middle" className="off-bubble-text">{trimmed}</text>
    </g>
  );
}

// Pure aesthetic: a little office that agents visibly walk into while their run is live, wander
// around inside while they work, and walk back out of the moment they stop. Nothing here is a source
// of truth — the list below it already says the same thing in words, which is what makes the scene
// itself safe to hide from assistive technology entirely. officeWorld.js owns the behaviour; this
// component owns the clock and the pixels.
export function OfficeScene({
  runs, taskActivity = {}, expanded = false, onToggleExpand = null,
  messageAt = null, decisionAt = null, callingRunIds = [], bossCalling = false, onTrashRun = null,
}) {
  const runningRuns = runs.filter((r) => r.status === 'running');
  const reduced = usePrefersReducedMotion();
  const [world, setWorld] = useState(createWorld);
  const [now, setNow] = useState(Date.now);
  // Mounting with an existing transcript establishes a baseline, not a new-message notification.
  const lastMessageAt = useRef(messageAt);
  const lastDecisionAt = useRef(decisionAt);
  const drag = useRef(null);

  function pointerPosition(event) {
    const svg = event.currentTarget.ownerSVGElement ?? event.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // The default SVG meet alignment can letterbox the expanded office.
    const scale = Math.min(rect.width / ROOM.w, rect.height / ROOM.h);
    return [(event.clientX - rect.left - (rect.width - ROOM.w * scale) / 2) / scale,
      (event.clientY - rect.top - (rect.height - ROOM.h * scale) / 2) / scale];
  }

  function pointerDown(event, actor) {
    if (event.button !== 0 || drag.current || !onTrashRun) return;
    const point = pointerPosition(event);
    if (!point) return;
    event.preventDefault();
    const svg = event.currentTarget.ownerSVGElement;
    svg.setPointerCapture(event.pointerId);
    drag.current = { id: actor.id, pointerId: event.pointerId };
    setWorld((current) => dragTo(beginDrag(current, actor.id), actor.id, ...point));
  }

  function pointerMove(event) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointerPosition(event);
    if (point) setWorld((current) => dragTo(current, active.id, ...point));
  }

  function pointerEnd(event, cancelled = false) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    const point = pointerPosition(event);
    setWorld((current) => endDrag(current, active.id, { instant: reduced }));
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled && point && isOverBin(...point)) onTrashRun?.(active.id);
  }

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), reduced ? 60000 : 1000);
    return () => clearInterval(timer);
  }, [reduced]);

  // Keyed by the sorted set of running ids so the effect only reruns when who is running actually
  // changes, not on every unrelated re-render of the rail (a tick of `now`, a different run's
  // activity line updating).
  const key = runningRuns.map((r) => r.id).sort().join(',');
  const latest = useRef(runningRuns);
  latest.current = runningRuns;

  useEffect(() => {
    setWorld((current) => syncActors(current, latest.current, { instant: reduced }));
  }, [key, reduced]);

  const callKey = JSON.stringify([...callingRunIds].sort());
  useEffect(() => {
    setWorld((current) => applyCalls(current, {
      callingIds: new Set(JSON.parse(callKey)), bossCalling, rng: Math.random, instant: reduced,
    }));
  }, [callKey, bossCalling, key, reduced]);

  useEffect(() => {
    if (!Number.isFinite(messageAt)) return;
    if (lastMessageAt.current !== null && messageAt <= lastMessageAt.current) return;
    lastMessageAt.current = messageAt;
    setWorld(startBossCall);
  }, [messageAt]);

  useEffect(() => {
    if (!Number.isFinite(decisionAt)) return;
    if (lastDecisionAt.current !== null && decisionAt <= lastDecisionAt.current) return;
    lastDecisionAt.current = decisionAt;
    setWorld(startBossAck);
  }, [decisionAt]);

  useEffect(() => {
    if (reduced) return undefined;
    const timer = setInterval(() => setWorld((current) => tick(current, TICK_MS)), TICK_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  const boss = world.actors.find((actor) => actor.role === 'orchestrator');
  const callRemaining = boss.state === 'oncall' || boss.state === 'ack' ? boss.timer : 0;
  useEffect(() => {
    // Status still expires with motion disabled; a one-shot timeout never advances a walk.
    if (!reduced || callRemaining <= 0) return undefined;
    const timer = setTimeout(() => {
      setWorld((current) => tick(current, callRemaining, Math.random, { instant: true }));
    }, callRemaining);
    return () => clearTimeout(timer);
  }, [reduced, callRemaining, boss.state, world.callVersion]);

  // What each agent gets to say, and deliberately NOT the name of the tool it is inside. "running
  // Bash" is not a thought anybody has ever had at a desk; what it was asked to do — "Count 1 to
  // 1000" — is. The task description also comes off the run itself, which the hooks record for every
  // agent, so a subagent dispatched from a terminal gets a bubble too; progress events only exist
  // for the project whose session is open in the chat.
  const said = new Map();
  for (const run of runningRuns) {
    const activity = taskActivity[runToolUseId(run)];
    // A reported status beats the original brief: it is the same task, said more currently.
    const text = activity?.status ?? activity?.summary ?? run.description;
    if (text) said.set(run.id, text);
  }

  const seated = world.actors.filter((a) => a.role === 'worker' && a.state !== 'leaving');
  const overflow = Math.max(0, runningRuns.length - Math.min(seated.length, MAX_DESKS));

  // Task descriptions take turns rather than all showing at once, because they physically cannot all
  // show at once: desks are 56px apart and a 22-character bubble is 86px wide, so three side by side
  // in a row overflow the room and paint over each other. Six of them turned the office into two
  // solid bars of text. One at a time, four seconds each, reads like glancing round a room — and
  // every agent still gets its say.
  //
  // Flavour is exempt: "brb" is six pixels of text, it never collides, and it marks the moment the
  // room is actually worth looking at.
  const speakers = world.actors.filter((a) => a.role === 'worker' && a.state !== 'leaving');
  const turn = speakers.length > 0 ? speakers[Math.floor(world.t / SPEAKING_MS) % speakers.length] : null;
  const bubbles = world.actors
    .map((actor) => ({
      actor,
      text: actor.bubble ?? (actor.id === turn?.id ? said.get(actor.id) : null),
    }))
    .filter((b) => b.text && b.actor.state !== 'leaving');

  return (
    <div className={`office${expanded ? ' expanded' : ''}`}>
      <svg viewBox={`0 0 ${ROOM.w} ${ROOM.h}`} className="office-scene" aria-hidden="true"
        onPointerMove={pointerMove} onPointerUp={pointerEnd}
        onPointerCancel={(event) => pointerEnd(event, true)} onLostPointerCapture={(event) => pointerEnd(event, true)}>
        <OfficeArt now={now} reducedMotion={reduced} binActive={world.actors.some((a) => a.dragging && isOverBin(a.x, a.y))} />
        {/* Back row before front row, so a sprite in the aisle overlaps the desk it is standing in
            front of rather than being swallowed by it. */}
        {[...world.actors]
          .sort((a, b) => Number(!!a.dragging) - Number(!!b.dragging) || a.y - b.y)
          .map((actor) => <Actor key={actor.id} actor={actor} onPointerDown={(event) => pointerDown(event, actor)} />)}
        {bubbles.map(({ actor, text }) => <Bubble key={actor.id} actor={actor} text={text} />)}
      </svg>
      {overflow > 0 && <span className="office-overflow" aria-hidden="true">+{overflow}</span>}
      {onToggleExpand && (
        // Outside the aria-hidden scene on purpose: the drawing is decoration, but the control that
        // resizes half the page is not, and it needs a real name and a real pressed state.
        <button
          type="button"
          className="btn subtle office-zoom"
          aria-pressed={expanded}
          onClick={onToggleExpand}
        >
          {expanded ? 'Shrink office' : 'Expand office'}
        </button>
      )}
    </div>
  );
}
