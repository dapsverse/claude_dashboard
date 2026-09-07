import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { OfficeArt } from '../src/components/officeArt.jsx';
import { OfficeScene } from '../src/components/OfficeScene.jsx';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { CALL_MS, ORCHESTRATOR_ID } from '../src/components/officeWorld.js';
import { latestMessageAt, initialChatState, appendUserMessage, applyChatEvent } from '../src/components/chatState.js';

const run = { id: 's:a', agentType: 'programmer', status: 'running', startedAt: 1000 };
const hand = (container, name) => container.querySelector(`[data-clock-hand="${name}"]`);
const sprite = (container, id = ORCHESTRATOR_ID) => container.querySelector(`.sprite[data-run-id="${id}"]`);
const position = (element) => element.parentElement.getAttribute('transform');
const reducedMotion = () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 6, 3, 0, 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('office wall clock', () => {
  it.each([[3, 0, 0, 90, 0, 0], [9, 30, 0, 285, 180, 0], [15, 15, 30, 97.5, 93, 180]])(
    'rotates hands from twelve for local time %i:%i:%i', (h, m, s, hour, minute, second) => {
      const { container } = render(<svg><OfficeArt now={new Date(2026, 8, 6, h, m, s).getTime()} /></svg>);
      for (const [name, angle] of [['hour', hour], ['minute', minute], ['second', second]]) {
        expect(hand(container, name).getAttribute('transform')).toBe(`rotate(${angle} 232 12)`);
      }
    },
  );

  it('updates each second independently of the simulation and cleans up timers', () => {
    const { container, unmount } = render(<OfficeScene runs={[]} />);
    act(() => vi.advanceTimersByTime(999));
    expect(hand(container, 'second').getAttribute('transform')).toBe('rotate(0 232 12)');
    act(() => vi.advanceTimersByTime(1));
    expect(hand(container, 'second').getAttribute('transform')).toBe('rotate(6 232 12)');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the correct time without seconds, updating only each minute under reduced motion', () => {
    reducedMotion();
    const { container } = render(<OfficeScene runs={[]} />);
    expect(hand(container, 'second')).toBeNull();
    expect(hand(container, 'hour').getAttribute('transform')).toBe('rotate(90 232 12)');
    act(() => vi.advanceTimersByTime(59999));
    expect(hand(container, 'minute').getAttribute('transform')).toBe('rotate(0 232 12)');
    act(() => vi.advanceTimersByTime(1));
    expect(hand(container, 'minute').getAttribute('transform')).toBe('rotate(6 232 12)');
  });

  it('changes cadence and removes the seconds hand when the preference changes', () => {
    let change;
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: (_, fn) => { change = fn; }, removeEventListener() {} }));
    const { container } = render(<OfficeScene runs={[]} />);
    act(() => vi.advanceTimersByTime(1000));
    act(() => change({ matches: true }));
    expect(hand(container, 'second')).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    const angle = hand(container, 'minute').getAttribute('transform');
    act(() => vi.advanceTimersByTime(1000));
    expect(hand(container, 'minute').getAttribute('transform')).toBe(angle);
    act(() => change({ matches: false }));
    expect(hand(container, 'second').getAttribute('transform')).toBe('rotate(12 232 12)');
  });
});

describe('office telephone poses', () => {
  it.each([false, true])('blips for a local user send and assistant receive, then stays quiet (reduced=%s)', (reduced) => {
    if (reduced) reducedMotion();
    let chat = initialChatState;
    const { container, rerender } = render(<OfficeScene runs={[]} messageAt={latestMessageAt(chat)} />);
    expect(sprite(container).querySelector('.sprite-phone')).toBeNull();
    chat = appendUserMessage(chat, 'hello', 1000);
    rerender(<OfficeScene runs={[]} messageAt={latestMessageAt(chat)} />);
    expect(sprite(container).querySelector('.sprite-phone')).toBeTruthy();
    act(() => vi.advanceTimersByTime(CALL_MS));
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    expect(sprite(container).querySelector('.sprite-phone')).toBeNull();
    chat = applyChatEvent(chat, 'chat.message', {
      messageId: 'reply', role: 'assistant', ts: 2000, blocks: [{ type: 'text', text: 'hi' }],
    });
    rerender(<OfficeScene runs={[]} messageAt={latestMessageAt(chat)} />);
    act(() => vi.advanceTimersByTime(CALL_MS - 100));
    expect(sprite(container).querySelector('.sprite-phone')).toBeTruthy();
    act(() => vi.advanceTimersByTime(100));
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    act(() => vi.advanceTimersByTime(60000));
    expect(sprite(container).querySelector('.sprite-phone')).toBeNull();
  });

  it.each([false, true])('closing a modal preserves the original blip deadline (reduced=%s)', (reduced) => {
    if (reduced) reducedMotion();
    const { container, rerender } = render(<OfficeScene runs={[]} />);
    rerender(<OfficeScene runs={[]} messageAt={1000} bossCalling />);
    act(() => vi.advanceTimersByTime(1000));
    rerender(<OfficeScene runs={[]} messageAt={1000} />);
    act(() => vi.advanceTimersByTime(1400));
    expect(sprite(container).querySelector('.sprite-phone')).toBeTruthy();
    act(() => vi.advanceTimersByTime(100));
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    expect(sprite(container).querySelector('.sprite-phone')).toBeNull();
  });

  it('draws a pixel handset on the matched worker and holds it stationary until released', () => {
    const { container, rerender } = render(<OfficeScene runs={[run]} callingRunIds={[run.id]} />);
    const start = position(sprite(container, run.id));
    expect(sprite(container, run.id).querySelectorAll('.sprite-phone rect').length).toBeGreaterThan(1);
    expect(sprite(container).querySelector('.sprite-phone')).toBeNull();
    act(() => vi.advanceTimersByTime(10000));
    expect(position(sprite(container, run.id))).toBe(start);
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('oncall');
    rerender(<OfficeScene runs={[run]} />);
    expect(sprite(container, run.id).querySelector('.sprite-phone')).toBeNull();
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('walking');
  });

  it.each([false, true])('reacts only to newer messages and expires the pose (reduced=%s)', (reduced) => {
    if (reduced) reducedMotion();
    const { container, rerender } = render(<OfficeScene runs={[]} messageAt={1000} />);
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    rerender(<OfficeScene runs={[]} messageAt={2000} />);
    expect(sprite(container).querySelector('.sprite-phone')).toBeTruthy();
    const start = position(sprite(container));
    act(() => vi.advanceTimersByTime(1500));
    rerender(<OfficeScene runs={[]} messageAt={2000} />);
    act(() => vi.advanceTimersByTime(900));
    expect(position(sprite(container))).toBe(start);
    expect(sprite(container).getAttribute('data-state')).toBe('oncall');
    act(() => vi.advanceTimersByTime(100));
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    rerender(<OfficeScene runs={[]} messageAt={null} />);
    rerender(<OfficeScene runs={[]} messageAt={1500} />);
    rerender(<OfficeScene runs={[]} messageAt={2000} />);
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
  });

  it('starts a call for the first message after null and renews it for another newer message', () => {
    reducedMotion();
    const { container, rerender } = render(<OfficeScene runs={[]} />);
    rerender(<OfficeScene runs={[]} messageAt={1000} />);
    act(() => vi.advanceTimersByTime(1500));
    rerender(<OfficeScene runs={[]} messageAt={2000} />);
    act(() => vi.advanceTimersByTime(1500));
    expect(sprite(container).getAttribute('data-state')).toBe('oncall');
    act(() => vi.advanceTimersByTime(1000));
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
  });

  it('keeps held poses under reduced motion through a message timeout and returns workers to their desks', () => {
    reducedMotion();
    const { container, rerender } = render(<OfficeScene runs={[run]} callingRunIds={new Set([run.id])} bossCalling />);
    const start = position(sprite(container, run.id));
    rerender(<OfficeScene runs={[run]} callingRunIds={[run.id]} bossCalling messageAt={1000} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(sprite(container).getAttribute('data-state')).toBe('oncall');
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('oncall');
    rerender(<OfficeScene runs={[run]} messageAt={1000} />);
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('working');
    expect(position(sprite(container, run.id))).toBe(start);
    expect(container.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('applies a pending call when the matching run arrives later', () => {
    const { container, rerender } = render(<OfficeScene runs={[]} callingRunIds={[run.id]} />);
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
    rerender(<OfficeScene runs={[run]} callingRunIds={[run.id]} />);
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('oncall');
    expect(sprite(container).getAttribute('data-state')).toBe('idle');
  });

  it('passes both call signals through LiveRail', () => {
    const { container, rerender } = render(<LiveRail runs={[run]} now={1000} />);
    rerender(<LiveRail runs={[run]} now={1000} callingRunIds={[run.id]} messageAt={2000} />);
    expect(sprite(container).getAttribute('data-state')).toBe('oncall');
    expect(sprite(container, run.id).getAttribute('data-state')).toBe('oncall');
  });
});
