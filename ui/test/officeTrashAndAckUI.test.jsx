import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OfficeScene } from '../src/components/OfficeScene.jsx';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { RunRow } from '../src/components/RunRow.jsx';
import { ACK_BUBBLES, BIN_SPOT, ORCHESTRATOR_ID } from '../src/components/officeWorld.js';
import { takeoverMessage } from '../src/components/trashAction.js';

const run = { id: 's:a', status: 'running', projectPath: '/project', agentType: 'programmer', description: 'Repair login', startedAt: 1000 };
const sprite = (container, id = run.id) => container.querySelector(`.sprite[data-run-id="${id}"]`);
const position = (element) => element.parentElement.getAttribute('transform');
const reducedMotion = () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));

function pointerSetup(container, rect = { left: 20, top: 30, width: 512, height: 320 }) {
  const svg = container.querySelector('svg');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect);
  svg.setPointerCapture = vi.fn();
  svg.hasPointerCapture = vi.fn(() => true);
  svg.releasePointerCapture = vi.fn();
  const scale = Math.min(rect.width / 256, rect.height / 160);
  const pointer = (x, y, pointerId = 1) => ({ pointerId, button: 0,
    clientX: rect.left + (rect.width - 256 * scale) / 2 + x * scale,
    clientY: rect.top + (rect.height - 160 * scale) / 2 + y * scale });
  return { svg, pointer };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(135000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('office pointer controls', () => {
  it.each([
    { left: 20, top: 30, width: 512, height: 320 },
    { left: 70, top: 15, width: 768, height: 480 },
    { left: 10, top: 15, width: 768, height: 640 },
  ])('converts pointer coordinates, freezes the worker, highlights the bin and drops exactly once (%j)', (rect) => {
    const onTrashRun = vi.fn();
    const { container } = render(<OfficeScene runs={[run]} onTrashRun={onTrashRun} />);
    const actor = sprite(container);
    const original = position(actor);
    const { svg, pointer } = pointerSetup(container, rect);
    fireEvent.pointerDown(actor, pointer(40, 60));
    expect(svg.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(svg, pointer(...BIN_SPOT));
    expect(position(actor)).toBe('translate(205 148)');
    expect(container.querySelector('[data-office-bin]').getAttribute('data-active')).toBe('true');
    act(() => vi.advanceTimersByTime(1000));
    expect(position(actor)).toBe('translate(205 148)');
    fireEvent.pointerUp(svg, pointer(...BIN_SPOT));
    expect(onTrashRun).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(position(actor)).toBe(original);
    expect(svg.releasePointerCapture).toHaveBeenCalledWith(1);
    fireEvent.lostPointerCapture(svg, pointer(...BIN_SPOT));
    expect(onTrashRun).toHaveBeenCalledTimes(1);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it.each(['outside', 'pointerCancel', 'lostPointerCapture'])('restores normal behaviour without trash on %s', (ending) => {
    const onTrashRun = vi.fn();
    const { container } = render(<OfficeScene runs={[run]} onTrashRun={onTrashRun} />);
    const actor = sprite(container);
    const original = position(actor);
    const { svg, pointer } = pointerSetup(container);
    fireEvent.pointerDown(actor, pointer(40, 60));
    fireEvent.pointerMove(svg, pointer(...BIN_SPOT));
    if (ending === 'outside') fireEvent.pointerUp(svg, pointer(100, 80));
    else fireEvent[ending](svg, pointer(...BIN_SPOT));
    expect(onTrashRun).not.toHaveBeenCalled();
    expect(position(actor)).toBe(original);
    expect(container.querySelector('[data-office-bin]').getAttribute('data-active')).toBe('false');
    act(() => vi.advanceTimersByTime(100));
    expect(position(actor)).not.toBe(original);
  });

  it('ignores the boss, secondary buttons and other pointers', () => {
    const onTrashRun = vi.fn();
    const { container } = render(<OfficeScene runs={[run]} onTrashRun={onTrashRun} />);
    const { svg, pointer } = pointerSetup(container);
    fireEvent.pointerDown(sprite(container, ORCHESTRATOR_ID), pointer(24, 80));
    fireEvent.pointerUp(svg, pointer(...BIN_SPOT));
    fireEvent.pointerDown(sprite(container), { ...pointer(40, 60), button: 2 });
    expect(svg.setPointerCapture).not.toHaveBeenCalled();
    fireEvent.pointerDown(sprite(container), pointer(40, 60));
    fireEvent.pointerMove(svg, pointer(...BIN_SPOT, 2));
    fireEvent.pointerUp(svg, pointer(...BIN_SPOT, 2));
    expect(position(sprite(container))).toBe('translate(40 60)');
    expect(onTrashRun).not.toHaveBeenCalled();
    fireEvent.pointerUp(svg, pointer(...BIN_SPOT));
    expect(onTrashRun).toHaveBeenCalledExactlyOnceWith(run.id);
  });
});

describe('accessible trash actions', () => {
  it('RunRow invokes the supplied handler with the run id', () => {
    const onTrashRun = vi.fn();
    render(<ul><RunRow run={run} now={135000} expanded onTrashRun={onTrashRun} /></ul>);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(onTrashRun).toHaveBeenCalledExactlyOnceWith(run.id);
  });

  it('the row button and sprite drop send the same takeover through LiveRail, keeping the run visible', async () => {
    reducedMotion();
    const onTakeover = vi.fn(async () => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<LiveRail runs={[run]} now={135000} projectPath="/project" onTakeover={onTakeover} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Take over' })));
    const { svg, pointer } = pointerSetup(container);
    fireEvent.pointerDown(sprite(container), pointer(40, 60));
    await act(async () => fireEvent.pointerUp(svg, pointer(...BIN_SPOT)));
    expect(onTakeover.mock.calls).toEqual([[takeoverMessage(run, { now: 135000 })], [takeoverMessage(run, { now: 135000 })]]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('PERMINTAAN take over dikirim ke orkestrator — proses tidak dibunuh paksa');
    expect(screen.getByRole('listitem').className).toContain('running');
  });

  it.each([{ projectPath: null, selected: '/project' }, { projectPath: '/other', selected: null }])(
    'refuses an unknown or foreign project visibly (%j)', async ({ projectPath, selected }) => {
      const onTakeover = vi.fn();
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      render(<LiveRail runs={[{ ...run, projectPath }]} now={135000} projectPath={selected} onTakeover={onTakeover} />);
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Take over' })));
      expect(screen.getByRole('status').textContent).toContain('dashboard hanya mengamatinya lewat hooks dan tidak punya kanal untuk menggantinya');
      expect(onTakeover).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, 'throw'])('reports a failed takeover send (%s)', async (failure) => {
    const onTakeover = vi.fn(async () => { if (failure === 'throw') throw new Error('offline'); return false; });
    render(<LiveRail runs={[run]} now={135000} projectPath="/project" onTakeover={onTakeover} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Take over' })));
    expect(screen.getByRole('status').textContent).toContain('gagal dikirim');
    expect(screen.getByRole('listitem').className).toContain('running');
  });

  it.each([true, false])('dismisses only the selected finished run optimistically, with rollback on failure (ok=%s)', async (ok) => {
    let resolve;
    const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<LiveRail runs={[{ ...run, status: 'done' }, { ...run, id: 's:b', description: 'Other task' }]} now={135000} />);
    const row = screen.getAllByRole('listitem').find((item) => item.className.includes('done'));
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/runs/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: [run.id] }) }));
    await act(async () => resolve({ ok, status: ok ? 200 : 500, json: async () => ok ? { dismissed: [run.id] } : { error: 'offline' } }));
    expect(screen.getAllByRole('listitem')).toHaveLength(ok ? 1 : 2);
    if (!ok) expect(screen.getByRole('status').textContent).toContain('could not be cleared');
  });
});

describe('ack bubble lifecycle in the scene', () => {
  it.each([false, true])('baselines on mount, renders the complete literal and expires in 2500ms (reduced=%s)', (reduced) => {
    if (reduced) reducedMotion();
    const { container, rerender, unmount } = render(<OfficeScene runs={[]} decisionAt={1000} />);
    const boss = () => sprite(container, ORCHESTRATOR_ID);
    expect(boss().getAttribute('data-state')).toBe('idle');
    rerender(<OfficeScene runs={[]} decisionAt={2000} />);
    expect(boss().getAttribute('data-state')).toBe('ack');
    expect(ACK_BUBBLES).toContain(container.querySelector('.off-bubble-text').textContent);
    expect(boss().querySelector('.sprite-phone')).toBeNull();
    act(() => vi.advanceTimersByTime(2400));
    expect(boss().getAttribute('data-state')).toBe('ack');
    act(() => vi.advanceTimersByTime(100));
    expect(boss().getAttribute('data-state')).toBe('idle');
    expect(container.querySelector('.off-bubble-text')).toBeNull();
    rerender(<OfficeScene runs={[]} decisionAt={null} />);
    rerender(<OfficeScene runs={[]} decisionAt={2000} />);
    expect(boss().getAttribute('data-state')).toBe('idle');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes decisionAt through LiveRail and renews the one-shot reduced-motion timeout', () => {
    reducedMotion();
    const { container, rerender } = render(<LiveRail runs={[]} now={0} />);
    rerender(<LiveRail runs={[]} now={0} decisionAt={1000} />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<LiveRail runs={[]} now={0} decisionAt={2000} />);
    act(() => vi.advanceTimersByTime(1500));
    expect(sprite(container, ORCHESTRATOR_ID).getAttribute('data-state')).toBe('ack');
    act(() => vi.advanceTimersByTime(1000));
    expect(sprite(container, ORCHESTRATOR_ID).getAttribute('data-state')).toBe('idle');
  });

  it('waits for all held boss calls and then gives ack its full reduced-motion lifetime', () => {
    reducedMotion();
    const { container, rerender } = render(<OfficeScene runs={[]} bossCalling />);
    rerender(<OfficeScene runs={[]} bossCalling decisionAt={1000} />);
    act(() => vi.advanceTimersByTime(6000));
    expect(sprite(container, ORCHESTRATOR_ID).getAttribute('data-state')).toBe('oncall');
    expect(screen.queryByText((text) => ACK_BUBBLES.includes(text))).toBeNull();
    rerender(<OfficeScene runs={[]} decisionAt={1000} />);
    act(() => vi.advanceTimersByTime(2499));
    expect(sprite(container, ORCHESTRATOR_ID).getAttribute('data-state')).toBe('ack');
    act(() => vi.advanceTimersByTime(1));
    expect(sprite(container, ORCHESTRATOR_ID).getAttribute('data-state')).toBe('idle');
  });
});
