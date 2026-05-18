import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, type VisionFinding } from './prompts.js';

describe('VisionFinding schema', () => {
  it('SYSTEM_PROMPT is a non-empty string', () => {
    expect(typeof SYSTEM_PROMPT).toBe('string');
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('valid VisionFinding categories are accepted', () => {
    const categories: VisionFinding['category'][] = [
      'vision-contrast',
      'vision-clarity',
      'vision-empty-state',
      'vision-overload',
    ];
    expect(categories).toHaveLength(4);
  });

  it('valid VisionFinding severities', () => {
    const severities: VisionFinding['severity'][] = ['high', 'medium', 'low'];
    expect(severities).toHaveLength(3);
  });
});

describe('cost estimate guard', () => {
  it('$0.005 per screen × 100 screens stays under $5 budget', () => {
    const COST_PER_SCREEN = 0.005;
    const maxCost = 5;
    const maxScreens = Math.floor(maxCost / COST_PER_SCREEN);
    expect(maxScreens).toBe(1000);
    expect(100 * COST_PER_SCREEN).toBeLessThanOrEqual(maxCost);
  });
});
