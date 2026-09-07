// Everything in the room that never moves, drawn as rectangles on a whole-pixel grid — no sprite
// sheet, no PNG, no third-party tileset. That is a licensing decision as much as a lazy one:
// agentpanel ships to npm under MIT, and the look this is chasing belongs to somebody else. Rects
// under `shape-rendering: crispEdges` reproduce the style without shipping anyone's art.
//
// Split out of OfficeScene.jsx because it is long and completely inert. Coordinates that a walking
// agent has to agree with (seats, the pantry, the door) come from officeWorld.js rather than being
// repeated here — the two files disagreeing is how you get someone sipping coffee in mid-air.

import { BIN_RECT, DESK_SEATS, DOOR, FLOOR_TOP, LANE, ROOM } from './officeWorld.js';

// Planks run across the room, seams staggered row to row. Two shades alternating is the whole
// effect; a third would not survive being 12 pixels tall.
//
// The seams have to be long and faint. At 34px with a dark seam colour the floor read as a brick
// wall rather than as floorboards — the eye takes frequent high-contrast verticals as masonry.
const PLANK_H = 12;
const SEAM_W = 72;

function Floor() {
  const rows = [];
  for (let y = FLOOR_TOP, i = 0; y < ROOM.h; y += PLANK_H, i++) {
    const h = Math.min(PLANK_H, ROOM.h - y);
    rows.push(<rect key={`p${y}`} x={0} y={y} width={ROOM.w} height={h} className={i % 2 ? 'off-floor-b' : 'off-floor-a'} />);
    for (let x = i % 2 ? SEAM_W / 2 : 0; x < ROOM.w; x += SEAM_W) {
      rows.push(<rect key={`s${y}-${x}`} x={x} y={y} width={1} height={h} className="off-seam" />);
    }
  }
  return <g>{rows}</g>;
}

function Window({ x }) {
  return (
    <g>
      <rect x={x} y={3} width={44} height={18} className="off-wood-dark" />
      <rect x={x + 2} y={5} width={40} height={14} className="off-glass" />
      {/* A wash of lighter sky in the top half, then the mullions over it. */}
      <rect x={x + 2} y={5} width={40} height={6} className="off-glass-lit" />
      <rect x={x + 21} y={5} width={2} height={14} className="off-wood-dark" />
      <rect x={x + 2} y={11} width={40} height={2} className="off-wood-dark" />
      <rect x={x - 2} y={21} width={48} height={3} className="off-wood" />
    </g>
  );
}

function Desk({ seat: [sx, sy] }) {
  return (
    <g>
      {/* Screen first: it sits behind the desk from this angle, and behind the occupant, who is
          drawn later still. */}
      <rect x={sx - 9} y={sy - 34} width={18} height={12} className="off-screen-frame" />
      <rect x={sx - 8} y={sy - 33} width={16} height={9} className="off-screen" />
      <rect x={sx - 6} y={sy - 31} width={9} height={1} className="off-screen-line" />
      <rect x={sx - 6} y={sy - 29} width={6} height={1} className="off-screen-line" />
      <rect x={sx - 6} y={sy - 27} width={11} height={1} className="off-screen-line" />

      <rect x={sx - 18} y={sy - 22} width={36} height={12} className="off-desk" />
      <rect x={sx - 18} y={sy - 12} width={36} height={3} className="off-wood-dark" />
      <rect x={sx - 17} y={sy - 9} width={2} height={4} className="off-wood-dark" />
      <rect x={sx + 15} y={sy - 9} width={2} height={4} className="off-wood-dark" />

      {/* A mug and a paper stack, so six desks are not six identical rectangles. */}
      <rect x={sx + 10} y={sy - 20} width={4} height={4} className="off-mug" />
      <rect x={sx - 16} y={sy - 18} width={7} height={5} className="off-paper" />

      {/* The chair, drawn before the occupant so the occupant sits in it — and two pixels wider on
          each side than the 12px sprite, so it frames them instead of reading as their trousers. */}
      <rect x={sx - 8} y={sy - 2} width={16} height={12} className="off-chair" />
      <rect x={sx - 8} y={sy - 2} width={2} height={12} className="off-chair-arm" />
      <rect x={sx + 6} y={sy - 2} width={2} height={12} className="off-chair-arm" />
      <rect x={sx - 8} y={sy + 8} width={16} height={2} className="off-wood-dark" />
    </g>
  );
}

function Plant({ x, y }) {
  return (
    <g>
      <rect x={x + 2} y={y + 8} width={10} height={7} className="off-pot" />
      <rect x={x + 2} y={y + 8} width={10} height={2} className="off-pot-rim" />
      <rect x={x + 4} y={y + 2} width={6} height={7} className="off-plant" />
      <rect x={x} y={y + 4} width={4} height={4} className="off-plant" />
      <rect x={x + 10} y={y + 3} width={4} height={5} className="off-plant" />
      <rect x={x + 5} y={y} width={4} height={3} className="off-plant-lit" />
    </g>
  );
}

function Pantry() {
  return (
    <g>
      {/* Counter along the top-right, with the machine standing on it. PANTRY_SPOT is the floor tile
          directly below this — an agent on coffee break stands here facing up. */}
      <rect x={200} y={12} width={14} height={14} className="off-metal" />
      <rect x={202} y={15} width={10} height={5} className="off-screen" />
      <rect x={204} y={21} width={6} height={4} className="off-metal-dark" />
      <rect x={220} y={20} width={5} height={6} className="off-mug" />
      <rect x={228} y={21} width={5} height={5} className="off-mug-alt" />

      <rect x={194} y={26} width={54} height={12} className="off-desk" />
      <rect x={194} y={38} width={54} height={4} className="off-wood-dark" />
      <rect x={194} y={26} width={54} height={2} className="off-desk-lit" />
    </g>
  );
}

function Cooler() {
  return (
    <g>
      <rect x={228} y={94} width={12} height={12} className="off-glass" />
      <rect x={228} y={94} width={12} height={4} className="off-glass-lit" />
      <rect x={226} y={106} width={16} height={16} className="off-metal" />
      <rect x={230} y={110} width={8} height={3} className="off-metal-dark" />
      <rect x={226} y={122} width={16} height={2} className="off-wood-dark" />
    </g>
  );
}

function Whiteboard() {
  return (
    <g>
      <rect x={160} y={4} width={38} height={17} className="off-wood-dark" />
      <rect x={162} y={6} width={34} height={13} className="off-board" />
      <rect x={165} y={9} width={18} height={1} className="off-board-ink" />
      <rect x={165} y={12} width={24} height={1} className="off-board-ink" />
      <rect x={165} y={15} width={12} height={1} className="off-board-ink" />
    </g>
  );
}

function Clock({ now, reducedMotion }) {
  const date = new Date(now);
  const h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  return (
    <g>
      <circle cx={232} cy={12} r={7} className="off-wood-dark" />
      <circle cx={232} cy={12} r={5} className="off-board" />
      <rect data-clock-hand="hour" x={231.5} y={9} width={1} height={3} className="off-board-ink" transform={`rotate(${((h % 12) + m / 60) * 30} 232 12)`} />
      <rect data-clock-hand="minute" x={231.5} y={8} width={1} height={4} className="off-board-ink" transform={`rotate(${(m + s / 60) * 6} 232 12)`} />
      {!reducedMotion && <rect data-clock-hand="second" x={231.75} y={8} width={0.5} height={4} fill="var(--accent)" transform={`rotate(${s * 6} 232 12)`} />}
    </g>
  );
}

// One flat layer, drawn in back-to-front order. Nothing here is interactive and nothing here is
// state — the clock reads its time from the scene so this layer owns no timers.
export function OfficeArt({ now = 0, reducedMotion = false, binActive = false }) {
  return (
    <g>
      <rect x={0} y={0} width={ROOM.w} height={ROOM.h} className="off-wall" />
      <rect x={0} y={0} width={ROOM.w} height={6} className="off-wall-shade" />
      <Floor />
      {/* Baseboard: the seam between wall and floor, and the only thing that sells the room as
          having a wall at all rather than a change of colour. */}
      <rect x={0} y={FLOOR_TOP - 4} width={ROOM.w} height={4} className="off-wood" />
      <rect x={0} y={FLOOR_TOP - 1} width={ROOM.w} height={1} className="off-wood-dark" />

      <Window x={30} />
      <Window x={106} />
      <Whiteboard />
      <Clock now={now} reducedMotion={reducedMotion} />

      {/* The rug sits in the aisle, which is exactly where the traffic is. */}
      <rect x={60} y={LANE - 14} width={104} height={28} className="off-rug" />
      <rect x={60} y={LANE - 14} width={104} height={2} className="off-rug-edge" />
      <rect x={60} y={LANE + 12} width={104} height={2} className="off-rug-edge" />
      <rect x={86} y={LANE - 8} width={52} height={16} className="off-rug-inner" />

      <rect x={DOOR.x} y={DOOR.y - 2} width={DOOR.w + 2} height={DOOR.h + 4} className="off-wood-dark" />
      <rect x={DOOR.x} y={DOOR.y} width={DOOR.w} height={DOOR.h} className="off-wood" />
      <rect x={DOOR.x + 6} y={DOOR.y + 13} width={2} height={3} className="off-metal" />

      <Pantry />
      <Cooler />
      <g data-office-bin data-active={binActive} transform={`translate(${BIN_RECT.x} ${BIN_RECT.y})`}>
        <rect x={2} y={4} width={BIN_RECT.w - 4} height={BIN_RECT.h - 4} className="off-metal" />
        <rect x={0} y={2} width={BIN_RECT.w} height={3} className="off-wood-dark" />
        <rect x={6} y={0} width={6} height={2} className="off-metal" />
        {[5, 8, 11].map((x) => <rect key={x} x={x} y={7} width={1} height={7} className="off-wood-dark" />)}
        {binActive && <rect x={0} y={0} width={BIN_RECT.w} height={BIN_RECT.h} fill="none" stroke="var(--accent)" strokeWidth={2} />}
      </g>
      {DESK_SEATS.map((seat, i) => <Desk key={i} seat={seat} />)}
      <Plant x={10} y={138} />
      <Plant x={232} y={138} />
      <Plant x={10} y={34} />
    </g>
  );
}
