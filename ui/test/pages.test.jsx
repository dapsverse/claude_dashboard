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
});
