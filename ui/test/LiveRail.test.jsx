import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { formatElapsed } from '../src/components/RunRow.jsx';

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
});
