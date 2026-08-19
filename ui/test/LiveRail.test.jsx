import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { formatElapsed } from '../src/components/RunRow.jsx';
import { upsertRun, mergeSnapshot } from '../src/components/runList.js';

const run = (over = {}) => ({
  id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'add auth',
  status: 'running', startedAt: 1000, endedAt: null, durationMs: null, ...over,
});

describe('formatElapsed', () => {
  it('formats each magnitude', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(134_000)).toBe('2m14s');
    expect(formatElapsed(3_780_000)).toBe('1h03m');
  });
  it('never renders a negative clock', () => {
    expect(formatElapsed(-5)).toBe('0s');
  });
  it('never renders the literal string "NaN" for a missing or invalid value', () => {
    expect(formatElapsed(NaN)).toBe('0s');
    expect(formatElapsed(undefined)).toBe('0s');
    expect(formatElapsed(null)).toBe('0s');
  });
});

describe('LiveRail', () => {
  it('shows agent type, description, and a live elapsed time', () => {
    render(<LiveRail runs={[run()]} now={135_000} />);
    expect(screen.getByText('programmer')).toBeTruthy();
    expect(screen.getByText('add auth')).toBeTruthy();
    expect(screen.getByText('2m14s')).toBeTruthy();
  });

  it('freezes the clock for finished runs at their recorded duration', () => {
    render(<LiveRail runs={[run({ status: 'done', endedAt: 5000, durationMs: 4000 })]} now={999_999} />);
    expect(screen.getByText('4s')).toBeTruthy();
  });

  it('labels a stale run so a dead spinner is never shown', () => {
    render(<LiveRail runs={[run({ status: 'stale', endedAt: 9000, durationMs: 8000 })]} now={999_999} />);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it('explains the empty state instead of rendering nothing', () => {
    render(<LiveRail runs={[]} now={0} />);
    expect(screen.getByText(/no agents running/i)).toBeTruthy();
  });

  it('sorts running runs above finished ones', () => {
    render(<LiveRail now={10_000} runs={[
      run({ id: 'a', status: 'done', endedAt: 2000, durationMs: 1000, agentType: 'qa' }),
      run({ id: 'b', status: 'running', agentType: 'reviewer' }),
    ]} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].textContent).toContain('reviewer');
  });

  it('gives done and error distinct dot shapes, not just distinct colours', () => {
    render(<LiveRail now={10_000} runs={[
      run({ id: 'd', status: 'done', agentType: 'qa', endedAt: 2000, durationMs: 1000 }),
      run({ id: 'e', status: 'error', agentType: 'programmer2', endedAt: 3000, durationMs: 2000 }),
    ]} />);
    const doneDot = screen.getByText('qa').closest('li').querySelector('.dot');
    const errorDot = screen.getByText('programmer2').closest('li').querySelector('.dot');
    expect(doneDot.className).toBe('dot done');
    expect(errorDot.className).toBe('dot error');
    expect(doneDot.className).not.toBe(errorDot.className);
  });

  it('gives a failed run a visible text label, not colour alone', () => {
    render(<LiveRail runs={[run({ status: 'error', endedAt: 4000, durationMs: 3000 })]} now={10_000} />);
    expect(screen.getByText('error')).toBeTruthy();
  });

  it('hides the ticking elapsed clock from assistive tech so it is never read aloud', () => {
    render(<LiveRail runs={[run()]} now={135_000} />);
    expect(screen.getByText('2m14s').getAttribute('aria-hidden')).toBe('true');
  });
});

// The stream can deliver an event for a run before the initial GET /api/runs snapshot resolves
// (the stream opens immediately; the snapshot goes through the daemon and a disk read). The
// snapshot must not then clobber what the stream already reported.
describe('run list reconciliation (stream vs. snapshot race)', () => {
  it('keeps the streamed version of a run when the snapshot later reports a stale copy of it', () => {
    const streamed = run({ status: 'running' });
    const staleFromDisk = run({ status: 'running', description: 'stale, pre-event copy' });
    let runs = [];
    runs = upsertRun(runs, streamed);
    const streamedIds = new Set([streamed.id]);

    runs = mergeSnapshot(runs, streamedIds, [staleFromDisk]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(streamed);
  });

  it('keeps a streamed run the snapshot does not mention at all', () => {
    const streamed = run({ id: 'only-in-stream', status: 'running' });
    let runs = upsertRun([], streamed);
    const streamedIds = new Set([streamed.id]);

    runs = mergeSnapshot(runs, streamedIds, []);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(streamed);
  });

  it('fills in a snapshot run the stream has not reported yet', () => {
    const fromSnapshot = run({ id: 'only-in-snapshot', status: 'done', durationMs: 500 });
    const runs = mergeSnapshot([], new Set(), [fromSnapshot]);

    expect(runs).toEqual([fromSnapshot]);
  });

  it('leaves exactly one row when two events for the same id arrive', () => {
    const first = run({ status: 'running' });
    const second = run({ status: 'done', endedAt: 2000, durationMs: 1000 });
    let runs = upsertRun([], first);
    runs = upsertRun(runs, second);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(second);
  });

  it('dedupes a running run that GET /api/runs lists in both active and recent', () => {
    // listRecent does not filter by status, so a running run can sit in both arrays of the same
    // snapshot response with the same id. Concatenating active and recent naively would render it
    // twice; the merge must collapse that overlap on its own, without relying on the API shape.
    const seenTwice = run({ status: 'running' });
    const runs = mergeSnapshot([], new Set(), [seenTwice, seenTwice]);

    expect(runs).toHaveLength(1);
  });
});
