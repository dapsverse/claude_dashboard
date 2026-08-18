import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Agents } from '../src/pages/Agents.jsx';
import { Skills } from '../src/pages/Skills.jsx';
import { Activity } from '../src/pages/Activity.jsx';

const agents = [
  { kind: 'agent', name: 'reviewer', description: 'Reviews code.', tools: 'Read, Grep', model: 'opus', scope: 'user', source: null },
  { kind: 'agent', name: 'plugin-agent', description: 'From a plugin.', tools: null, model: null, scope: 'plugin', source: 'superpowers' },
];

const skills = [
  { kind: 'skill', name: 'brainstorming', description: 'Turns ideas into designs.', scope: 'plugin', source: 'superpowers', version: '6.3.0' },
];

describe('Agents page', () => {
  it('lists each agent with its scope badge', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('plugin')).toBeTruthy();
  });

  it('shows the plugin source when there is one', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText(/superpowers/)).toBeTruthy();
  });

  it('names the empty state', () => {
    render(<Agents agents={[]} />);
    expect(screen.getByText(/no agents found/i)).toBeTruthy();
  });

  it('does not render a blank tools row for an empty tools array', () => {
    render(<Agents agents={[{ kind: 'agent', name: 'no-tools', description: 'd', tools: [], model: null, scope: 'user', source: null }]} />);
    expect(screen.queryByText('tools')).toBeNull();
  });

  it('reports a load failure instead of implying the catalog is empty', () => {
    render(<Agents agents={[]} catalogError="request_failed_500" />);
    expect(screen.getByText(/could not load/i)).toBeTruthy();
    expect(screen.queryByText(/no agents found/i)).toBeNull();
  });

  it('keeps showing a previously loaded list when a later refresh fails', () => {
    render(<Agents agents={agents} catalogError="request_failed_500" />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
    expect(screen.getByText(/could not refresh/i)).toBeTruthy();
  });
});

describe('Skills page', () => {
  it('shows the plugin version', () => {
    render(<Skills skills={skills} />);
    expect(screen.getByText(/6\.3\.0/)).toBeTruthy();
  });

  it('filters by the search term', async () => {
    render(<Skills skills={[...skills, { kind: 'skill', name: 'zzz-other', description: '', scope: 'user', source: null, version: null }]} initialQuery="brain" />);
    expect(screen.queryByText('zzz-other')).toBeNull();
    expect(screen.getByText('brainstorming')).toBeTruthy();
  });

  it('names a genuinely empty catalog rather than implying a search happened', () => {
    render(<Skills skills={[]} />);
    expect(screen.getByText(/no skills found/i)).toBeTruthy();
  });

  it('distinguishes no search matches from a genuinely empty catalog', () => {
    render(<Skills skills={skills} initialQuery="zzz-nonexistent" />);
    expect(screen.getByText(/no skills match/i)).toBeTruthy();
    expect(screen.queryByText(/no skills found/i)).toBeNull();
  });

  it('reports a load failure instead of implying no skills exist', () => {
    render(<Skills skills={[]} catalogError="request_failed_500" />);
    expect(screen.getByText(/could not load/i)).toBeTruthy();
    expect(screen.queryByText(/no skills found/i)).toBeNull();
  });

  it('keeps showing a previously loaded list when a later refresh fails', () => {
    render(<Skills skills={skills} catalogError="request_failed_500" />);
    expect(screen.getByText('brainstorming')).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
    expect(screen.getByText(/could not refresh/i)).toBeTruthy();
  });
});

describe('Activity page', () => {
  it('renders finished runs with their duration', () => {
    render(<Activity runs={[{ id: 'a', agentType: 'qa', description: 'tests', status: 'done', startedAt: 0, durationMs: 5000 }]} />);
    expect(screen.getByText('qa')).toBeTruthy();
    expect(screen.getByText('5s')).toBeTruthy();
  });

  it('tells the user when hooks are not installed rather than showing an empty list', () => {
    render(<Activity runs={[]} hooksInstalled={false} />);
    expect(screen.getByText(/agentpanel init/)).toBeTruthy();
  });

  it('recovers once the health check reports hooks are installed after mount', () => {
    const { rerender } = render(<Activity runs={[]} hooksInstalled={false} />);
    expect(screen.getByText(/agentpanel init/)).toBeTruthy();

    rerender(<Activity runs={[]} hooksInstalled={true} />);
    expect(screen.queryByText(/agentpanel init/)).toBeNull();
    expect(screen.getByText(/no agent runs recorded yet/i)).toBeTruthy();
  });
});
