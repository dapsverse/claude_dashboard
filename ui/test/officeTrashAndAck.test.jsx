import { describe, it, expect } from 'vitest';
import {
  ACK_BUBBLES, BIN_RECT, BIN_SPOT, CALL_MS, DESK_SEATS, ORCHESTRATOR_ID,
  applyCalls, beginDrag, createWorld, dragTo, endDrag, isOverBin,
  startBossAck, startBossCall, syncActors, tick,
} from '../src/components/officeWorld.js';
import { planTrashAction, takeoverMessage } from '../src/components/trashAction.js';

const rng = () => 0.5;
// Matches the production formula in `acknowledge`, so this stays correct if the pool ever grows.
const ACK_BUBBLE = ACK_BUBBLES[Math.floor(0.5 * ACK_BUBBLES.length)];
const run = { id: 's:a', agentId: 'worker-a', agentType: 'programmer', status: 'running',
  projectPath: '/project', startedAt: '2026-09-06T00:00:00Z', description: 'Repair login', prompt: 'Fix the expired token retry' };
const worker = (world) => world.actors.find((a) => a.id === run.id);
const boss = (world) => world.actors.find((a) => a.id === ORCHESTRATOR_ID);
const worldWithWorker = (instant = false) => syncActors(createWorld(), [run], { rng, instant });
const calls = (world, bossCalling) => applyCalls(world, { bossCalling, callingIds: new Set(), rng });

describe('bin geometry', () => {
  it('includes the centre and all four edges of the drawn bin', () => {
    expect(isOverBin(...BIN_SPOT)).toBe(true);
    for (const x of [BIN_RECT.x, BIN_RECT.x + BIN_RECT.w]) {
      for (const y of [BIN_RECT.y, BIN_RECT.y + BIN_RECT.h]) expect(isOverBin(x, y)).toBe(true);
    }
  });

  it.each([[195.9, 148], [214.1, 148], [205, 139.9], [205, 156.1], [NaN, 148], [205, Infinity], [null, 148]])(
    'rejects a point outside the bin (%s, %s)', (x, y) => expect(isOverBin(x, y)).toBe(false),
  );
});

describe('drag lifecycle', () => {
  it('freezes a walking worker and its route, then resumes from the original position without mutation', () => {
    const original = worldWithWorker();
    const before = structuredClone(worker(original));
    let world = beginDrag(original, run.id);
    world = dragTo(world, run.id, ...BIN_SPOT);
    const held = structuredClone(worker(world));
    world = tick(world, 10000, rng);
    expect(worker(world)).toEqual(held);
    expect(worker(original)).toEqual(before);
    world = endDrag(world, run.id, { rng });
    expect(worker(world)).toMatchObject({ ...before, dragging: false, dragOrigin: null });
    world = tick(world, 100, rng);
    expect([worker(world).x, worker(world).y]).not.toEqual([before.x, before.y]);
  });

  it('ignores the boss, missing ids, and movement without a drag', () => {
    const world = worldWithWorker();
    expect(beginDrag(world, ORCHESTRATOR_ID)).toEqual(world);
    expect(beginDrag(world, 'missing')).toEqual(world);
    expect(dragTo(world, run.id, ...BIN_SPOT)).toEqual(world);
    expect(endDrag(world, run.id, { rng })).toEqual(world);
  });

  it('keeps the first origin on repeated begin and rejects invalid coordinates', () => {
    let world = beginDrag(worldWithWorker(), run.id);
    const origin = worker(world).dragOrigin;
    world = beginDrag(dragTo(world, run.id, ...BIN_SPOT), run.id);
    expect(worker(world).dragOrigin).toEqual(origin);
    expect(dragTo(world, run.id, NaN, 0)).toBe(world);
  });

  it('returns to the desk immediately under reduced motion', () => {
    let world = dragTo(beginDrag(worldWithWorker(true), run.id), run.id, ...BIN_SPOT);
    world = tick(world, 10000, rng, { instant: true });
    expect([worker(world).x, worker(world).y]).toEqual(BIN_SPOT);
    world = endDrag(world, run.id, { rng, instant: true });
    expect([worker(world).x, worker(world).y]).toEqual(DESK_SEATS[0]);
    expect(worker(world).state).toBe('working');
  });

  it('retains a pending call while dragged and after release', () => {
    let world = dragTo(beginDrag(worldWithWorker(true), run.id), run.id, ...BIN_SPOT);
    world = applyCalls(world, { callingIds: new Set([run.id]), bossCalling: false, rng });
    world = tick(world, 10000, rng);
    expect([worker(world).x, worker(world).y]).toEqual(BIN_SPOT);
    world = endDrag(world, run.id, { rng, instant: true });
    expect(worker(world)).toMatchObject({ callHeld: true, state: 'oncall', x: 40, y: 60 });
  });

  it('allows a run that finishes mid-drag to leave instead of getting stuck', () => {
    let world = dragTo(beginDrag(worldWithWorker(true), run.id), run.id, ...BIN_SPOT);
    world = syncActors(world, [], { rng });
    expect(worker(world)).toMatchObject({ dragging: false, state: 'leaving', x: 40, y: 60 });
    expect(worker(tick(world, 30000, rng))).toBeUndefined();
  });

  it('does not teleport a dragged worker when its permission is released under reduced motion', () => {
    let world = applyCalls(worldWithWorker(true), { callingIds: new Set([run.id]), bossCalling: false, rng });
    world = dragTo(beginDrag(world, run.id), run.id, ...BIN_SPOT);
    world = applyCalls(world, { callingIds: new Set(), bossCalling: false, rng, instant: true });
    expect([worker(world).x, worker(world).y]).toEqual(BIN_SPOT);
    world = endDrag(world, run.id, { rng, instant: true });
    expect(worker(world)).toMatchObject({ state: 'working', x: 40, y: 60 });
  });
});

describe('trash action planning', () => {
  it.each(['done', 'error', 'stale'])('dismisses a %s run even in another project', (status) => {
    expect(planTrashAction({ ...run, status }, { selectedProjectPath: '/other' })).toEqual({ kind: 'dismiss' });
  });

  it('requests takeover only with a known matching project', () => {
    expect(planTrashAction(run, { selectedProjectPath: '/project' })).toEqual({ kind: 'takeover' });
  });

  it.each([['/other', '/project'], [null, '/project'], [undefined, '/project'], [null, null], ['', ''], ['/project', null]])(
    'refuses unmatched or unknown projects (%s, %s)', (projectPath, selectedProjectPath) => {
      expect(planTrashAction({ ...run, projectPath }, { selectedProjectPath })).toEqual({
        kind: 'refuse',
        reason: 'agen ini milik sesi Claude Code lain — dashboard hanya mengamatinya lewat hooks dan tidak punya kanal untuk menggantinya',
      });
    },
  );

  it('builds a deterministic brief identifying the original agent, task, elapsed time and narrower replacement', () => {
    const message = takeoverMessage(run, { now: '2026-09-06T00:02:14Z' });
    for (const text of [run.id, run.agentId, run.agentType, run.description, run.prompt, '134 detik',
      'Hentikan agen tersebut', 'agen pengganti', 'LEBIH SEMPIT', 'solusi tugas yang sama', 'kriteria selesai']) {
      expect(message).toContain(text);
    }
    expect(takeoverMessage(run, { now: '2026-09-06T00:02:14Z' })).toBe(message);
  });

  it('handles numeric timestamps and missing task metadata without NaN or undefined', () => {
    expect(takeoverMessage({ ...run, startedAt: 1000 }, { now: 3000 })).toContain('2 detik');
    const message = takeoverMessage({ id: 'missing' }, { now: 3000 });
    expect(message).toContain('Sudah berjalan: tidak diketahui');
    expect(message).not.toMatch(/NaN|undefined/);
  });
});

describe('boss acknowledgement', () => {
  it.each([false, true])('closes the phone, shows the exact bubble and expires after 2500ms (instant=%s)', (instant) => {
    const original = startBossCall(worldWithWorker());
    let world = startBossAck(original, rng);
    expect(boss(original).state).toBe('oncall');
    expect(worker(world)).toBe(worker(original));
    expect(boss(world)).toMatchObject({ state: 'ack', bubble: ACK_BUBBLE, path: [], timer: CALL_MS });
    world = tick(world, CALL_MS - 1, rng, { instant });
    expect(boss(world).state).toBe('ack');
    world = tick(world, 1, rng, { instant });
    expect(boss(world)).toMatchObject({ state: 'idle', bubble: null });
  });

  it('renews the timer and reduced-motion timeout signal', () => {
    const original = startBossAck(createWorld());
    const world = startBossAck(tick(original, 1000, rng));
    expect(boss(world).timer).toBe(CALL_MS);
    expect(world.callVersion).toBeGreaterThan(original.callVersion);
  });

  it('queues ack behind a held call and starts a full duration only after release', () => {
    let world = startBossAck(calls(createWorld(), true));
    world = tick(world, 20000, rng);
    expect(boss(world)).toMatchObject({ state: 'oncall', bubble: '☎', callHeld: true, ackPending: true });
    world = calls(world, false);
    expect(boss(world)).toMatchObject({ state: 'ack', bubble: ACK_BUBBLE, timer: CALL_MS, callHeld: false });
  });

  it('lets a new held permission interrupt ack and resumes it after release', () => {
    let world = calls(startBossAck(createWorld()), true);
    expect(boss(world).state).toBe('oncall');
    world = calls(world, false);
    expect(boss(world)).toMatchObject({ state: 'ack', timer: CALL_MS });
  });

  it('picks the acknowledgement phrase at random from the full pool, not always the first one', () => {
    const world = startBossCall(worldWithWorker());
    const phraseFor = (roll) => boss(startBossAck(world, () => roll)).bubble;
    expect(phraseFor(0)).toBe(ACK_BUBBLES[0]);
    expect(phraseFor(0.5)).toBe(ACK_BUBBLES[1]);
    expect(phraseFor(0.99)).toBe(ACK_BUBBLES[2]);
  });
});
