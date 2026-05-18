import { describe, it, expect, beforeEach } from 'vitest';
import { graphAnalyzer, resetIssueCounter } from './analyzer.js';
import type { FigmaFile } from '../types.js';

beforeEach(() => resetIssueCounter());

function makeFile(pages: FigmaFile['document']['children']): FigmaFile {
  return {
    name: 'Test', lastModified: '2026-01-01', version: '1',
    document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: pages },
  };
}

describe('dead-end detection', () => {
  it('flags screens with no outgoing interactions that are destinations', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        { id: '2:1', name: 'Dead End', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const deadEnds = issues.filter(i => i.category === 'dead-end');
    expect(deadEnds.length).toBe(1);
    expect(deadEnds[0].screenName).toBe('Dead End');
    expect(deadEnds[0].severity).toBe('critical');
  });

  it('does not flag screens with BACK action as dead ends', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Settings', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Back', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' as const }] }],
          }],
        },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const deadEnds = issues.filter(i => i.category === 'dead-end');
    expect(deadEnds.length).toBe(0);
  });
});

describe('orphan detection', () => {
  it('flags unreachable screens', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        { id: '2:0', name: 'Home', type: 'FRAME' },
        { id: '2:1', name: 'Orphan', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const orphans = issues.filter(i => i.category === 'orphan');
    expect(orphans.length).toBe(1);
    expect(orphans[0].screenName).toBe('Orphan');
    expect(orphans[0].severity).toBe('high');
  });

  it('warns when no flow starting points exist', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      children: [
        { id: '2:0', name: 'Home', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const orphans = issues.filter(i => i.category === 'orphan');
    expect(orphans.length).toBe(1);
    expect(orphans[0].severity).toBe('medium');
    expect(orphans[0].message).toContain('No flow starting points');
  });
});

describe('missing back-nav detection', () => {
  it('flags screens without back navigation', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        { id: '2:1', name: 'Details', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const backNav = issues.filter(i => i.category === 'back-nav');
    expect(backNav.length).toBe(1);
    expect(backNav[0].screenName).toBe('Details');
  });

  it('does not flag starting point destinations', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        { id: '2:0', name: 'Home', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const backNav = issues.filter(i => i.category === 'back-nav');
    expect(backNav.length).toBe(0);
  });

  it('does not flag screens with BACK action on destination (audit fix #1)', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Details', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Back', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' as const }] }],
          }],
        },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const backNav = issues.filter(i => i.category === 'back-nav');
    expect(backNav.length).toBe(0);
  });

  it('does not flag screens with CLOSE action on destination', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        {
          id: '2:1', name: 'Modal', type: 'FRAME',
          children: [{
            id: '3:1', name: 'Close', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' as const }] }],
          }],
        },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, {});
    const backNav = issues.filter(i => i.category === 'back-nav');
    expect(backNav.length).toBe(0);
  });
});

describe('counter reset (audit fix #5)', () => {
  it('resets issue IDs when analyze() called multiple times', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        { id: '2:1', name: 'Dead End', type: 'FRAME' },
      ],
    }]);

    const issues1 = await graphAnalyzer.analyze(file, {});
    const issues2 = await graphAnalyzer.analyze(file, {});
    // IDs should be the same across runs (counter resets)
    expect(issues1[0].id).toBe(issues2[0].id);
  });
});

describe('skip checks', () => {
  it('respects --skip flag', async () => {
    const file = makeFile([{
      id: '1:0', name: 'Page', type: 'CANVAS',
      flowStartingPoints: [{ nodeId: '2:0', name: 'Flow' }],
      children: [
        {
          id: '2:0', name: 'Home', type: 'FRAME',
          children: [{
            id: '3:0', name: 'Btn', type: 'RECTANGLE',
            interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE' as const, destinationId: '2:1', navigation: 'NAVIGATE' as const }] }],
          }],
        },
        { id: '2:1', name: 'Dead End', type: 'FRAME' },
      ],
    }]);

    const issues = await graphAnalyzer.analyze(file, { skip: ['dead-end', 'back-nav'] });
    const categories = new Set(issues.map(i => i.category));
    expect(categories.has('dead-end')).toBe(false);
    expect(categories.has('back-nav')).toBe(false);
  });
});
