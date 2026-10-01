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
  pruneDigest: 'abc123',
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

  it('lists deletable orphans, shows published ones as kept, and hints --prune', () => {
    const output: string = plain({
      ...base,
      orphans: [
        { namespace: 'cart', key: 'legacy', published: false },
        { namespace: 'cart', key: 'live', published: true },
      ],
    });

    expect(output).toMatch(/1 key\(s\) in Translify are not in your source files/);
    expect(output).toMatch(/cart:legacy$/m);
    expect(output).toContain('1 key(s) kept — published; unpublish it in Translify to delete it:');
    expect(output).toMatch(/cart:live$/m);
    expect(output).toMatch(/--prune/);
  });

  it('does not hint --prune when --prune was passed', () => {
    const res: PushResponse = { ...base, orphans: [{ namespace: 'cart', key: 'legacy', published: false }] };

    expect(stripVTControlCharacters(renderPush(res, { prune: true }))).not.toMatch(/Use --prune/);
    expect(plain(res)).toMatch(/Use --prune/);
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

  const orphans = [
    { namespace: 'cart', key: 'a', published: false },
    { namespace: 'cart', key: 'b', published: false },
  ];

  it('a dry run with prune says the keys would be deleted, never that they were', () => {
    const output: string = plain({ ...base, dryRun: true, orphans, pruned: 2 });

    expect(output).toMatch(/^Dry run/);
    expect(output).toMatch(/Would delete 2 key\(s\)/);
    expect(output).toMatch(/2 key\(s\) not in your source files would be deleted:/);
    expect(output).not.toMatch(/Deleted/);
    expect(output).not.toMatch(/Use --prune/);
  });

  it('a real prune words the orphan list as deleted keys', () => {
    const output: string = plain({ ...base, dryRun: false, orphans, pruned: 2 });

    expect(output).toMatch(/Deleted 2 key\(s\) that were not in your source files:/);
    expect(output).toMatch(/cart:a$/m);
    expect(output).not.toMatch(/are not in your source files/);
    expect(output).not.toMatch(/Use --prune/);
    expect(output).not.toMatch(/Would delete/);
    expect(output.match(/Deleted/g)).toHaveLength(1);
  });

  it('a real prune counts the keys actually deleted and notes those kept because they were published meanwhile', () => {
    const output: string = plain({ ...base, dryRun: false, orphans, pruned: 1 });

    expect(output).toContain('Deleted 1 key(s) that were not in your source files (1 kept: published during the push):');
    expect(output).not.toMatch(/Deleted 2/);
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
