import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { OfficeScene } from '../src/components/OfficeScene.jsx';
import { DESK_SEATS, DOOR_SPOT, ORCHESTRATOR_ID } from '../src/components/officeWorld.js';

const running = (id, agentType = 'programmer') => ({ id, status: 'running', agentType });
const done = (id, agentType = 'programmer') => ({ id, status: 'done', agentType });

const sprites = (container) => [...container.querySelectorAll('.sprite')]
  .filter((s) => s.getAttribute('data-run-id') !== ORCHESTRATOR_ID);

// The scene positions a sprite by its ancestor's transform attribute, so this is where the sprite
// actually is on screen.
function seatOf(sprite) {
  const [, x, y] = sprite.closest('[transform]').getAttribute('transform').match(/translate\((-?\d+) (-?\d+)\)/);
  return [Number(x), Number(y)];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OfficeScene', () => {
  it('always draws the room, occupied or not', () => {
    const { container } = render(<OfficeScene runs={[]} />);
    expect(container.querySelectorAll('.off-desk')).toHaveLength(DESK_SEATS.length + 1); // six desks plus the pantry counter
    expect(sprites(container)).toHaveLength(0);
  });

  it('brings a running run in through the door rather than materialising it at a desk', () => {
    const { container } = render(<OfficeScene runs={[running('a')]} />);
    const found = sprites(container);
    expect(found).toHaveLength(1);
    expect(found[0].getAttribute('data-run-id')).toBe('a');
    expect(seatOf(found[0])).toEqual(DOOR_SPOT);
  });

  it('ignores a run that is not running', () => {
    const { container } = render(<OfficeScene runs={[done('a')]} />);
    expect(sprites(container)).toHaveLength(0);
  });

  it('walks a sprite to its desk over the following seconds', () => {
    vi.useFakeTimers();
    const { container } = render(<OfficeScene runs={[running('a')]} />);
    // Allow the entrance walk to finish, then check before the shortest working stint can expire.
    // At twenty seconds the worker may already have randomly chosen to leave for the pantry.
    act(() => { vi.advanceTimersByTime(6000); });
    expect(seatOf(sprites(container)[0])).toEqual(DESK_SEATS[0]);
  });

  it('keeps a sprite visible and marked leaving after its run stops, then removes it once it reaches the door', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<OfficeScene runs={[running('a')]} />);
    act(() => { vi.advanceTimersByTime(15000); });
    rerender(<OfficeScene runs={[done('a')]} />);

    const leaving = container.querySelector('.sprite.leaving');
    expect(leaving).toBeTruthy();
    expect(leaving.getAttribute('data-run-id')).toBe('a');

    act(() => { vi.advanceTimersByTime(20000); });
    expect(sprites(container)).toHaveLength(0);
  });

  // A regression test for a real bug: the position was an SVG `transform` attribute on the very
  // element that also carried a CSS `animation` touching `transform`. In SVG, a CSS transform on an
  // element replaces its presentation-attribute transform outright rather than composing with it —
  // so every sprite snapped to (0,0), the top-left of the scene, wherever it was meant to be. The
  // fix keeps positioning (the attribute) and animation (CSS, local to the sprite) on separate
  // elements; this test pins that split so it cannot silently come back together.
  it('positions a sprite via an ancestor\'s transform attribute, never the animated element\'s own', () => {
    const { container } = render(<OfficeScene runs={[running('a')]} />);
    const sprite = sprites(container)[0];
    expect(sprite.getAttribute('transform')).toBe(null);
    const positioned = sprite.closest('[transform]');
    expect(positioned).toBeTruthy();
    expect(positioned).not.toBe(sprite);
    expect(container.querySelector('.sprite-body').getAttribute('transform')).toBe(null);
  });

  it('caps seating at six and shows the rest as an overflow badge', () => {
    const runs = Array.from({ length: 8 }, (_, i) => running(`r${i}`));
    const { container } = render(<OfficeScene runs={runs} />);
    expect(sprites(container)).toHaveLength(6);
    expect(container.querySelector('.office-overflow').textContent).toBe('+2');
  });

  it('gives each agent type its own colour so two sprites are told apart', () => {
    const { container } = render(<OfficeScene runs={[running('a', 'programmer'), running('b', 'reviewer')]} />);
    const shirt = (id) => container
      .querySelector(`.sprite[data-run-id="${id}"] .sprite-hair`)
      .getAttribute('fill');
    expect(shirt('a')).not.toBe(shirt('b'));
  });

  const said = (container) => [...container.querySelectorAll('.off-bubble-text')].map((t) => t.textContent);

  describe('thought bubbles', () => {
    // "running Bash" is not a thought anybody has at a desk. What the agent was asked to do is, and
    // it comes off the run itself — which the hooks record for every agent, so this works for a
    // subagent dispatched from a terminal, where no progress events exist at all.
    it('says what the agent was asked to do, not which tool it is inside', () => {
      const { container } = render(
        <OfficeScene
          runs={[{ ...running('sess:t1'), description: 'Count 1 to 1000' }]}
          taskActivity={{ t1: { kind: 'task_progress', lastToolName: 'Bash' } }}
        />,
      );
      expect(said(container)).toEqual(['Count 1 to 1000']);
    });

    it('prefers a reported status, which is the same task said more currently', () => {
      const { container } = render(
        <OfficeScene
          runs={[{ ...running('sess:t1'), description: 'Count 1 to 1000' }]}
          taskActivity={{ t1: { kind: 'task_notification', status: 'reached 700' } }}
        />,
      );
      expect(said(container)).toEqual(['reached 700']);
    });

    // Progress events are keyed by the tool_use half of the run id, the same lookup the rows use.
    it('falls back to the description when the activity is for a different run', () => {
      const { container } = render(
        <OfficeScene
          runs={[{ ...running('sess:t1'), description: 'Count 1 to 1000' }]}
          taskActivity={{ tOTHER: { kind: 'task_notification', status: 'reached 700' } }}
        />,
      );
      expect(said(container)).toEqual(['Count 1 to 1000']);
    });

    it('truncates at a word boundary rather than running off the room', () => {
      const { container } = render(
        <OfficeScene runs={[{ ...running('sess:t1'), description: 'Investigate EVM chain price data source' }]} />,
      );
      const [text] = said(container);
      expect(text.length).toBeLessThanOrEqual(22);
      // A cut phrase, not a cut word: "…EVM chain pr…" reads as a rendering glitch.
      expect(text).toBe('Investigate EVM chain…');
    });

    it('truncates mid-word when there is no boundary to cut at', () => {
      const { container } = render(
        <OfficeScene runs={[{ ...running('sess:t1'), description: 'x'.repeat(80) }]} />,
      );
      expect(said(container)[0].length).toBeLessThanOrEqual(22);
    });

    // Six descriptions cannot physically coexist: desks are 56px apart and a full-width bubble is
    // 86px, so a whole row of them overflows the room and paints over itself. They take turns.
    it('lets one agent speak at a time, however many are working', () => {
      const runs = Array.from({ length: 6 }, (_, i) => ({
        ...running(`sess:t${i}`), description: `task number ${i}`,
      }));
      const { container } = render(<OfficeScene runs={runs} />);
      expect(said(container)).toHaveLength(1);
    });

    it('passes the turn on, so every agent gets its say', () => {
      vi.useFakeTimers();
      const runs = Array.from({ length: 4 }, (_, i) => ({
        ...running(`sess:t${i}`), description: `task number ${i}`,
      }));
      const { container } = render(<OfficeScene runs={runs} />);
      const heard = new Set();
      for (let elapsed = 0; elapsed < 24000; elapsed += 1000) {
        act(() => { vi.advanceTimersByTime(1000); });
        for (const text of said(container)) heard.add(text);
      }
      // Flavour bubbles can join in, so this is a floor rather than an exact set: what matters is
      // that the turn moved past the first agent and reached all four.
      for (let i = 0; i < 4; i++) expect(heard).toContain(`task number ${i}`);
    });

    it('says nothing for an agent with no description and nothing to flavour', () => {
      const { container } = render(<OfficeScene runs={[running('a')]} />);
      expect(container.querySelector('.off-bubble-text')).toBe(null);
    });

    it('lets flavour interrupt the turn — someone at the coffee machine is not thinking about the ticket', () => {
      vi.useFakeTimers();
      const { container } = render(
        <OfficeScene runs={[{ ...running('sess:t1'), description: 'Count 1 to 1000' }]} />,
      );
      let flavoured = false;
      for (let elapsed = 0; elapsed < 400000 && !flavoured; elapsed += 1000) {
        act(() => { vi.advanceTimersByTime(1000); });
        // Only one bubble is ever drawn for one agent, so a flavour bubble showing means the
        // description gave way to it rather than stacking on top.
        flavoured = said(container).some((t) => t !== 'Count 1 to 1000');
        expect(said(container).length).toBeLessThanOrEqual(1);
      }
      expect(flavoured).toBe(true);
    });
  });

  describe('the orchestrator', () => {
    it('is always on screen, whether or not anyone else is working', () => {
      const { container } = render(<OfficeScene runs={[]} />);
      expect(container.querySelectorAll(`.sprite[data-run-id="${ORCHESTRATOR_ID}"]`)).toHaveLength(1);
    });

    it('is not one of the seated agents and never counts toward the desk cap', () => {
      const runs = Array.from({ length: 8 }, (_, i) => running(`r${i}`));
      const { container } = render(<OfficeScene runs={runs} />);
      expect(container.querySelectorAll(`.sprite[data-run-id="${ORCHESTRATOR_ID}"]`)).toHaveLength(1);
      expect(sprites(container)).toHaveLength(6);
      expect(container.querySelector('.office-overflow').textContent).toBe('+2');
    });

    it('does not stay in one place', () => {
      vi.useFakeTimers();
      const { container } = render(<OfficeScene runs={[]} />);
      // Sampled over the window rather than compared start-to-end: the patrol is random, and it is
      // perfectly allowed to be back where it began after any given interval. What must not happen
      // is it never being anywhere else.
      const places = new Set();
      for (let elapsed = 0; elapsed < 40000; elapsed += 1000) {
        act(() => { vi.advanceTimersByTime(1000); });
        places.add(seatOf(container.querySelector(`.sprite[data-run-id="${ORCHESTRATOR_ID}"]`)).join(','));
      }
      expect(places.size).toBeGreaterThan(1);
    });
  });

  describe('the expand control', () => {
    it('is absent unless the shell offers somewhere to expand into', () => {
      const { container } = render(<OfficeScene runs={[]} />);
      expect(container.querySelector('.office-zoom')).toBe(null);
    });

    it('is a real named control rather than part of the decoration', () => {
      const onToggleExpand = vi.fn();
      const { container } = render(<OfficeScene runs={[]} onToggleExpand={onToggleExpand} />);
      const button = container.querySelector('.office-zoom');
      // Inside an aria-hidden subtree it would be a button no screen reader could reach — the scene
      // is decorative, the control that resizes half the page is not.
      expect(button.closest('[aria-hidden="true"]')).toBe(null);
      expect(button.getAttribute('aria-pressed')).toBe('false');
      button.click();
      expect(onToggleExpand).toHaveBeenCalledTimes(1);
    });

    it('reports itself as pressed while expanded', () => {
      const { container } = render(<OfficeScene runs={[]} expanded onToggleExpand={() => {}} />);
      expect(container.querySelector('.office-zoom').getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('reduced motion', () => {
    it('seats everyone immediately and never starts the simulation', () => {
      const setInterval = vi.spyOn(globalThis, 'setInterval');
      vi.stubGlobal('matchMedia', (query) => ({
        matches: query.includes('prefers-reduced-motion'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      try {
        const { container } = render(<OfficeScene runs={[running('a')]} />);
        // Straight to the desk: there is no tick to carry it there, so a walk-in would leave the
        // sprite parked in the doorway for the rest of the session.
        expect(seatOf(sprites(container)[0])).toEqual(DESK_SEATS[0]);
        // The wall clock updates once a minute; the 100ms movement simulation stays off.
        expect(setInterval).toHaveBeenCalledTimes(1);
        expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 60000);
      } finally {
        vi.unstubAllGlobals();
        setInterval.mockRestore();
      }
    });
  });
});
