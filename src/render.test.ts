import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { PushResponse } from './commands/push.js';
import { renderPush, summarizePush } from './render.js';

const plain = (res: PushResponse): string => stripVTControlCharacters(renderPush(res));

const base: PushResponse = {
  dryRun: false,
  locales: {
    it: { created: 0, updated: 0, unchanged: 300, skippedFilled: 41, unknownKeys: ['cart:old', 'cart:gone'] },
    en: { created: 12, updated: 3, unchanged: 480, skippedFilled: 0, unknownKeys: [] },
  },
  orphans: [],
  pruned: 0,
};

describe('renderPush', () => {
  it('heads a dry run and a real push differently', () => {
    expect(plain({ ...base, dryRun: true })).toMatch(/^Dry run/);
    expect(plain(base)).toMatch(/^Pushed/);
  });

  it('prints created, updated and unchanged per locale, sorted', () => {
    const lines: string[] = plain(base).split('\n');
    const en: number = lines.findIndex((line) => line.trim().startsWith('en'));
    const it: number = lines.findIndex((line) => line.trim().startsWith('it'));

    expect(en).toBeGreaterThan(0);
    expect(it).toBeGreaterThan(en);
    expect(lines[en]).toMatch(/12 created/);
    expect(lines[en]).toMatch(/3 updated/);
    expect(lines[en]).toMatch(/480 unchanged/);
  });

  it('reports translator edits kept and unknown keys', () => {
    const it: string = plain(base).split('\n').find((line) => line.trim().startsWith('it'))!;

    expect(it).toMatch(/41 kept/);
    expect(plain(base)).toMatch(/2 unknown key\(s\).*cart:old, cart:gone/);
  });

  it('lists orphans, marks published ones, and hints --prune', () => {
    const output: string = plain({
      ...base,
      orphans: [
        { namespace: 'cart', key: 'legacy', published: false },
        { namespace: 'cart', key: 'live', published: true },
      ],
    });

    expect(output).toMatch(/2 key\(s\) in Translify are not in your source files/);
    expect(output).toMatch(/cart:legacy$/m);
    expect(output).toMatch(/cart:live .*published/m);
    expect(output).not.toMatch(/cart:legacy .*published/m);
    expect(output).toMatch(/--prune/);
    expect(output).toMatch(/unpublish/i);
  });

  it('caps a long orphan list', () => {
    const orphans = Array.from({ length: 25 }, (_, i) => ({ namespace: 'n', key: `k${i}`, published: false }));
    const output: string = plain({ ...base, orphans });

    expect(output).toMatch(/n:k19/);
    expect(output).not.toMatch(/n:k20/);
    expect(output).toMatch(/and 5 more/);
  });

  it('reports pruned keys', () => {
    expect(plain({ ...base, pruned: 4 })).toMatch(/Deleted 4 key\(s\)/);
    expect(plain(base)).not.toMatch(/Deleted/);
  });
});

describe('summarizePush', () => {
  it('totals across locales', () => {
    expect(
      summarizePush({ ...base, orphans: [{ namespace: 'a', key: 'b', published: true }], pruned: 0 }),
    ).toEqual({
      dryRun: false,
      created: 12,
      updated: 3,
      unchanged: 780,
      skippedFilled: 41,
      unknownKeys: 2,
      orphans: 1,
      publishedOrphans: 1,
      pruned: 0,
    });
  });
});
