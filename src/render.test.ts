import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { PushResponse } from './commands/push.js';
import type { LintCell, LintResponse } from './commands/lint.js';
import type { Config } from './config.js';
import { renderPush, summarizePush, renderLint } from './render.js';

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

describe('renderPush review state', () => {
  const row = (res: PushResponse, locale: string): string =>
    plain(res).split('\n').find((line) => line.trim().startsWith(locale))!;

  it('suffixes a locale that wrote cells with the status they landed in', () => {
    const res: PushResponse = {
      ...base,
      locales: { ...base.locales, fr: { ...base.locales.en!, status: 'NEEDS_REVIEW' }, de: { ...base.locales.en!, status: 'DRAFT' } },
    };

    expect(row(res, 'fr')).toMatch(/· needs review$/);
    expect(row(res, 'de')).toMatch(/· draft$/);
  });

  it('adds no suffix for approved cells, a missing status, or a locale that wrote nothing', () => {
    const res: PushResponse = {
      ...base,
      locales: {
        en: { ...base.locales.en!, status: 'APPROVED' },
        fr: { ...base.locales.en! },
        de: { created: 0, updated: 0, unchanged: 9, skippedFilled: 0, unknownKeys: [], status: 'NEEDS_REVIEW' },
      },
    };

    for (const locale of ['en', 'fr', 'de']) expect(row(res, locale)).not.toMatch(/·/);
  });

  it('reports approved targets sent back to review by a source change', () => {
    expect(plain({ ...base, staleReset: 3 })).toContain(
      '3 approved translation(s) went back to review because their source text changed.',
    );
    expect(plain({ ...base, dryRun: true, staleReset: 3 })).toContain(
      '3 approved translation(s) would go back to review because their source text changed.',
    );
  });

  it('says nothing about stale cells when none were reset or the server does not report it', () => {
    expect(plain({ ...base, staleReset: 0 })).not.toMatch(/back to review/);
    expect(plain(base)).not.toMatch(/back to review/);
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
      staleReset: 0,
    });
  });

  it('carries staleReset', () => {
    expect(summarizePush({ ...base, staleReset: 4 }).staleReset).toBe(4);
  });
});

describe('renderLint', () => {
  const config = { apiUrl: 'http://x', files: [], locales: { it_IT: 'it' } } as unknown as Config;
  const cell = (over: Partial<LintCell>): LintCell => ({
    namespace: 'shop',
    key: 'cart.items',
    locale: 'it',
    severity: 'ERROR',
    value: 'articoli',
    issues: [{ code: 'PLACEHOLDER_MISSING', severity: 'ERROR', arg: 'count' }],
    ...over,
  });
  const res = (over: Partial<LintResponse>): LintResponse => ({
    summary: { errors: 0, warnings: 0, locales: [] },
    cells: [],
    truncated: false,
    ...over,
  });
  const text = (r: LintResponse, view?: { severity?: 'error' | 'warning' }): string =>
    stripVTControlCharacters(renderLint(r, config, view));

  it('groups by namespace and key, prints the disk locale, and totals per locale', () => {
    const out: string = text(
      res({
        summary: {
          errors: 2,
          warnings: 1,
          locales: [
            { locale: 'en', errors: 0, warnings: 0 },
            { locale: 'it', errors: 2, warnings: 0 },
            { locale: 'pl', errors: 0, warnings: 1 },
          ],
        },
        cells: [
          cell({ namespace: 'admin', key: 'panel.greeting', issues: [{ code: 'PLACEHOLDER_MISSING', severity: 'ERROR', arg: 'name' }] }),
          cell({
            key: 'cart.files',
            locale: 'pl',
            severity: 'WARNING',
            issues: [{ code: 'PLURAL_CATEGORY_MISSING', severity: 'WARNING', arg: 'n', categories: ['few', 'many'] }],
          }),
          cell({}),
        ],
      }),
    );

    expect(out.split('\n')).toEqual([
      'admin',
      '  panel.greeting',
      '    it_IT    error    missing placeholder {name}',
      'shop',
      '  cart.files',
      '    pl       warning  plural {n} is missing few, many',
      '  cart.items',
      '    it_IT    error    missing placeholder {count}',
      '',
      '✖ 2 errors, 1 warning — it_IT 2/0 · pl 0/1',
    ]);
  });

  it('words every known issue code', () => {
    const issues = [
      { code: 'PLACEHOLDER_EXTRA', severity: 'ERROR', arg: 'total' },
      { code: 'PLACEHOLDER_KIND_MISMATCH', severity: 'WARNING', arg: 'd' },
      { code: 'PLURAL_CATEGORY_UNKNOWN', severity: 'WARNING', arg: 'n', categories: ['few'] },
    ] as const;
    const out: string = text(res({ summary: { errors: 1, warnings: 0, locales: [] }, cells: [cell({ issues: [...issues] })] }));

    expect(out).toContain('unexpected placeholder {total}');
    expect(out).toContain('placeholder {d} is used differently than in the source');
    expect(out).toContain('plural {n} has categories this locale does not use: few');
  });

  it('shows the value under ICU_INVALID only, quoted and cut to 80 characters', () => {
    const long: string = `Total {amount, number ${'x'.repeat(100)}`;
    const out: string = text(
      res({
        summary: { errors: 1, warnings: 0, locales: [] },
        cells: [
          cell({
            value: long,
            issues: [{ code: 'ICU_INVALID', severity: 'ERROR', message: 'EXPECT_ARGUMENT_CLOSING_BRACE', offset: 14 }],
          }),
        ],
      }),
    );
    const lines: string[] = out.split('\n');

    expect(lines[2]).toBe('    it_IT    error    invalid ICU: EXPECT_ARGUMENT_CLOSING_BRACE at 14');
    expect(lines[3]).toBe(`                      ${JSON.stringify(`${long.slice(0, 79)}…`)}`);
    expect(text(res({ summary: { errors: 1, warnings: 0, locales: [] }, cells: [cell({})] }))).not.toContain('"articoli"');
  });

  it('prints an unknown issue code as-is', () => {
    const out: string = text(
      res({ summary: { errors: 1, warnings: 0, locales: [] }, cells: [cell({ issues: [{ code: 'SOMETHING_NEW', severity: 'ERROR' }] })] }),
    );

    expect(out).toContain('    it_IT    error    SOMETHING_NEW');
  });

  it('says a clean project is clean, counting locales', () => {
    expect(text(res({ summary: { errors: 0, warnings: 0, locales: [{ locale: 'en', errors: 0, warnings: 0 }] } }))).toBe(
      '✔ No issues in 1 locale(s).',
    );
    expect(text(res({}))).toBe('✔ No issues in 0 locale(s).');
  });

  it('marks a warnings-only result with ⚠ and still states the counts when no rows are listed', () => {
    const out: string = text(
      res({ summary: { errors: 0, warnings: 2, locales: [{ locale: 'pl', errors: 0, warnings: 2 }] } }),
      { severity: 'error' },
    );

    expect(out).toBe('⚠ 0 errors, 2 warnings — pl 0/2');
  });

  it('adds a truncation line counting the cells the filter matched', () => {
    const summary = { errors: 1500, warnings: 300, locales: [{ locale: 'it', errors: 1500, warnings: 300 }] };
    const cells: LintCell[] = Array.from({ length: 1000 }, (_, index) => cell({ key: `k${index}` }));

    expect(text(res({ summary, cells, truncated: true }))).toContain(
      'Showing first 1000 of 1800 cells. Narrow with --namespace / --locale, or use --json.',
    );
    expect(text(res({ summary, cells, truncated: true }), { severity: 'error' })).toContain('Showing first 1000 of 1500 cells.');
  });
});
