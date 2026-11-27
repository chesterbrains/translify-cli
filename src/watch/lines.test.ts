import { describe, expect, it } from 'vitest';

import { answer, counts } from './harness.js';
import { followUps, orphanNote, pushLine, stamp, startSummary } from './lines.js';

describe('watch lines', () => {
  it('stamp is the local time, zero padded', () => {
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('03:04:05');
  });

  it('pushLine names the namespace and the non-zero counts of the source locale', () => {
    expect(pushLine('app', answer({ locales: { en: counts({ created: 2, updated: 1, unchanged: 9 }) } }), 'en')).toBe('app: 2 created, 1 updated');
    expect(pushLine('app', answer({ locales: { en: counts({ updated: 3 }) } }), 'en')).toBe('app: 3 updated');
    expect(pushLine('app', answer({ locales: { en: counts({ unchanged: 9 }) } }), 'en')).toBe('app: unchanged');
  });

  it('pushLine says unchanged when the answer lacks the source locale', () => {
    expect(pushLine('app', answer({ locales: {} }), 'en')).toBe('app: unchanged');
  });

  it('followUps: warnings escaped, the stale reset and the restores', () => {
    expect(
      followUps(answer({ warnings: ['locales/en/app.json: \u001b[31mred'], staleReset: 3, keysRestored: 1 })),
    ).toEqual([
      'warning: locales/en/app.json: \\x1b[31mred',
      '3 approved translation(s) went back to review because their source text changed.',
      'Restored 1 key(s) from the trash.',
    ]);
    expect(followUps(answer())).toEqual([]);
  });

  it('orphanNote counts, names the namespace and points at prune', () => {
    expect(orphanNote('app', 2)).toBe('2 key(s) in Translify are not in your source files (app). Run translify push --prune when done.');
  });

  it('startSummary sums the source locale over every answer', () => {
    const one = answer({ locales: { en: counts({ created: 1, unchanged: 100 }) } });
    const two = answer({ locales: { en: counts({ updated: 2, unchanged: 140 }) } });

    expect(startSummary([one, two], 'en')).toBe('pushed 2 namespace(s): 1 created, 2 updated, 240 unchanged');
  });
});
