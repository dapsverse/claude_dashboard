import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { formatElapsed } from '../src/components/RunRow.jsx';
import { upsertRun, mergeSnapshot, visibleRuns, finishedIds } from '../src/components/runList.js';

const run = (over = {}) => ({
  id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'add auth',
  status: 'running', startedAt: 1000, endedAt: null, durationMs: null, projectPath: '/proj', ...over,
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

describe('LiveRail run detail', () => {
  it('animates only the rows that are actually running', () => {
    const { container } = render(
      <LiveRail runs={[run(), run({ id: 's1:t2', status: 'done', durationMs: 10 })]} now={2000} />,
    );
    expect(container.querySelectorAll('.working').length).toBe(1);
    expect(container.querySelector('.run.running .working')).toBeTruthy();
  });

  it('expands a row on click and collapses it on a second click', () => {
    render(<LiveRail runs={[run({ prompt: 'add auth to the login route' })]} now={2000} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('add auth to the login route')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('add auth to the login route')).toBeNull();
  });

  it('opens one row at a time', () => {
    render(<LiveRail runs={[run({ prompt: 'first prompt' }), run({ id: 's1:t2', prompt: 'second prompt' })]} now={2000} />);
    const [first, second] = screen.getAllByRole('button');
    fireEvent.click(first);
    expect(screen.getByText('first prompt')).toBeTruthy();
    fireEvent.click(second);
    expect(screen.queryByText('first prompt')).toBeNull();
    expect(screen.getByText('second prompt')).toBeTruthy();
  });

  it('says so rather than showing an empty box when no prompt was recorded', () => {
    render(<LiveRail runs={[run({ prompt: null })]} now={2000} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText(/No prompt was recorded/)).toBeTruthy();
  });

  // The rail's rows come from the hook path, which only learns that a run opened and later closed.
  // What the subagent is doing right now comes from the session's own progress events, keyed by the
  // tool_use id that is the second half of the run id.
  it('shows what a running subagent is doing, matched by the tool_use half of the run id', () => {
    render(
      <LiveRail
        runs={[run()]}
        now={2000}
        taskActivity={{ t1: { kind: 'task_progress', lastToolName: 'Grep', usage: { input_tokens: 900, output_tokens: 100 } } }}
      />,
    );
    expect(screen.getByText('running Grep')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('1,000')).toBeTruthy();
  });

  it('does not claim live activity for a finished run', () => {
    render(
      <LiveRail
        runs={[run({ status: 'done', durationMs: 4000 })]}
        now={2000}
        taskActivity={{ t1: { kind: 'task_progress', lastToolName: 'Grep' } }}
      />,
    );
    expect(screen.queryByText('running Grep')).toBeNull();
  });
});

describe('visibleRuns', () => {
  const mine = run({ id: 'mine' });
  const theirs = run({ id: 'theirs', projectPath: '/other' });
  const orphan = run({ id: 'orphan', projectPath: null });

  it('keeps only the selected project once one is selected', () => {
    expect(visibleRuns([mine, theirs], { projectPath: '/proj' }).map((r) => r.id)).toEqual(['mine']);
  });

  // A run whose session was never recorded cannot be attributed to any project, and hiding it would
  // strand a running agent with nothing on screen to explain where it went.
  it('keeps a run that names no project at all', () => {
    expect(visibleRuns([orphan, theirs], { projectPath: '/proj' }).map((r) => r.id)).toEqual(['orphan']);
  });

  it('filters nothing before a project is selected', () => {
    expect(visibleRuns([mine, theirs], { projectPath: null })).toHaveLength(2);
  });

  it('drops dismissed rows', () => {
    expect(visibleRuns([mine, orphan], { projectPath: '/proj', dismissed: new Set(['mine']) }).map((r) => r.id))
      .toEqual(['orphan']);
  });
});

describe('finishedIds', () => {
  it('names every row that is not running', () => {
    const rows = [run({ id: 'a' }), run({ id: 'b', status: 'done' }), run({ id: 'c', status: 'stale' })];
    expect(finishedIds(rows)).toEqual(['b', 'c']);
  });
});

describe('LiveRail scoping', () => {
  const props = { now: 2000, taskActivity: {} };

  it('shows only the selected project\'s agents', () => {
    render(<LiveRail {...props} projectPath="/proj" runs={[run({ id: 'a', description: 'mine' }), run({ id: 'b', description: 'theirs', projectPath: '/other' })]} />);
    expect(screen.getByText('mine')).toBeTruthy();
    expect(screen.queryByText('theirs')).toBe(null);
  });

  it('says the emptiness is about this project when one is selected', () => {
    render(<LiveRail {...props} projectPath="/proj" runs={[run({ projectPath: '/other' })]} />);
    expect(screen.getByText(/in this project/)).toBeTruthy();
  });

  it('clears finished rows on request and leaves running ones alone', () => {
    render(<LiveRail {...props} projectPath="/proj" runs={[
      run({ id: 'a', description: 'still working' }),
      run({ id: 'b', description: 'all done', status: 'done', durationMs: 1000 }),
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /clear finished/i }));
    expect(screen.getByText('still working')).toBeTruthy();
    expect(screen.queryByText('all done')).toBe(null);
  });

  it('offers nothing to clear when every row is running', () => {
    render(<LiveRail {...props} projectPath="/proj" runs={[run()]} />);
    expect(screen.queryByRole('button', { name: /clear finished/i })).toBe(null);
  });
});
