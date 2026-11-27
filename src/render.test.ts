import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

import type { PushResponse } from './commands/push.js';
import type { LintCell, LintResponse } from './commands/lint.js';
import type { Config } from './config.js';
import { renderPush, renderReasonCells, summarizePush, renderLint } from './render.js';

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

  it('orphan names and locale codes from the server are printed with control characters escaped', () => {
    const output: string = plain({
      ...base,
      locales: { 'e\x1b[31mn': { created: 1, updated: 0, unchanged: 0, skipped: 0, unknownKeys: [] } } as never,
      orphans: [{ namespace: 'ca\x1b[31mrt', key: 'leg\nacy' }],
    });

    expect(output).toContain('    ca\\x1b[31mrt:leg\\nacy');
    expect(output).toContain('e\\x1b[31mn');
    // Unstripped: whatever colour codes this CLI adds itself, the server's sequence must not be among them.
    const raw: string = renderPush({
      ...base,
      locales: { 'e\x1b[31mn': { created: 1, updated: 0, unchanged: 0, skippedFilled: 0, unknownKeys: ['ca\x1b[31mrt:x'] } },
      orphans: [{ namespace: 'ca\x1b[31mrt', key: 'legacy' }],
    });
    expect(raw).not.toContain('\x1b[31m');
    expect(raw).toContain('ca\\x1b[31mrt:x');
  });

  it('counts are printed through the same escape: text sent where a number belongs cannot drive the terminal', () => {
    const raw: string = renderPush({
      ...base,
      locales: { en: { created: '1\x1b[2J' as never, updated: 0, unchanged: 0, skippedFilled: 0, unknownKeys: [] } },
      pruned: '2\x1b[2J' as never,
      orphans: [{ namespace: 'cart', key: 'legacy' }],
    });
    expect(raw).not.toContain('\x1b[2J');
    expect(raw).toContain('1\\x1b[2J created');
    expect(raw).toContain('2\\x1b[2J key(s)');
  });

  it('the other counts of a push, and the totals of lint, go through it too', () => {
    const bad = '5\x1b[2J' as never;
    const push: string = renderPush({
      ...base,
      locales: { it: { created: 0, updated: 0, unchanged: 0, skippedFilled: 3, unknownKeys: [] } },
      staleReset: 2,
      keysRestored: 4,
    });
    // Real numbers print as they always did.
    expect(stripVTControlCharacters(push)).toContain('3 kept');
    expect(stripVTControlCharacters(push)).toContain('2 approved translation(s)');
    expect(stripVTControlCharacters(push)).toContain('Restored 4 key(s)');

    const config = { apiUrl: 'http://x', files: [], locales: {} } as unknown as Config;
    const lint: string = renderLint(
      { summary: { errors: bad, warnings: 1, locales: [{ locale: 'it', errors: 2, warnings: 1 }] }, cells: [], truncated: false },
      config,
    );
    expect(lint).not.toContain('\x1b[2J');
    expect(stripVTControlCharacters(lint)).toContain('5\\x1b[2J errors, 1 warning — it 2/1');
  });

  it('lists orphans and hints --prune', () => {
    const output: string = plain({
      ...base,
      orphans: [
        { namespace: 'cart', key: 'legacy' },
        { namespace: 'cart', key: 'live' },
      ],
    });

    expect(output).toMatch(/2 key\(s\) in Translify are not in your source files/);
    expect(output).toMatch(/cart:legacy$/m);
    expect(output).toMatch(/cart:live$/m);
    expect(output).not.toMatch(/published/);
    expect(output).toMatch(/Use --prune to move them to the trash\./);
  });

  it('does not hint --prune when --prune was passed', () => {
    const res: PushResponse = { ...base, orphans: [{ namespace: 'cart', key: 'legacy' }] };

    expect(stripVTControlCharacters(renderPush(res, { prune: true }))).not.toMatch(/Use --prune/);
    expect(plain(res)).toMatch(/Use --prune/);
  });

  it('caps a long orphan list', () => {
    const orphans = Array.from({ length: 25 }, (_, i) => ({ namespace: 'n', key: `k${i}` }));
    const output: string = plain({ ...base, orphans });

    expect(output).toMatch(/n:k19/);
    expect(output).not.toMatch(/n:k20/);
    expect(output).toMatch(/and 5 more/);
  });

  it('reports pruned keys as moved to the trash, never as deleted', () => {
    const output: string = plain({ ...base, pruned: 4 });

    expect(output).toMatch(/Moved 4 key\(s\) to the Translify trash \(restorable for 30 days\)\./);
    expect(output).not.toMatch(/[Dd]elete/);
    expect(plain(base)).not.toMatch(/trash/);
  });

  const orphans = [
    { namespace: 'cart', key: 'a' },
    { namespace: 'cart', key: 'b' },
  ];

  it('a dry run with prune says the keys would go to the trash, never that they did', () => {
    const output: string = plain({ ...base, dryRun: true, orphans, pruned: 2 });

    expect(output).toMatch(/^Dry run/);
    expect(output).toMatch(/2 key\(s\) not in your source files would be moved to the trash:/);
    expect(output).toMatch(/Would move 2 key\(s\) to the trash \(restorable for 30 days\)\./);
    expect(output).not.toMatch(/Moved/);
    expect(output).not.toMatch(/[Dd]elete/);
    expect(output).not.toMatch(/Use --prune/);
  });

  it('a real prune words the orphan list as keys moved to the trash', () => {
    const output: string = plain({ ...base, dryRun: false, orphans, pruned: 2 });

    expect(output).toMatch(/Moved 2 key\(s\) that were not in your source files to the trash \(restorable for 30 days\):/);
    expect(output).toMatch(/cart:a$/m);
    expect(output).not.toMatch(/are not in your source files/);
    expect(output).not.toMatch(/Use --prune/);
    expect(output).not.toMatch(/Would move/);
    expect(output.match(/Moved/g)).toHaveLength(1);
  });

  it('a real prune counts the keys actually archived and notes those archived meanwhile', () => {
    const output: string = plain({ ...base, dryRun: false, orphans, pruned: 1 });

    expect(output).toContain(
      'Moved 1 key(s) that were not in your source files to the trash (restorable for 30 days; 1 already archived meanwhile):',
    );
    expect(output).not.toMatch(/Moved 2/);
  });

  it('reports keys restored from the trash, as done or as would-be', () => {
    expect(plain({ ...base, keysRestored: 3 })).toMatch(/Restored 3 key\(s\) from the trash\./);
    expect(plain({ ...base, dryRun: true, keysRestored: 1 })).toMatch(/Would restore 1 key\(s\) from the trash\./);
    expect(plain(base)).not.toMatch(/[Rr]estore/);
    expect(plain({ ...base, keysRestored: 0 })).not.toMatch(/[Rr]estore/);
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
      summarizePush({ ...base, orphans: [{ namespace: 'a', key: 'b' }], pruned: 0, keysRestored: 2 }),
    ).toEqual({
      dryRun: false,
      created: 12,
      updated: 3,
      unchanged: 780,
      skippedFilled: 41,
      unknownKeys: 2,
      orphans: 1,
      pruned: 0,
      keysRestored: 2,
      staleReset: 0,
    });
  });

  it('defaults keysRestored to 0 when the server omits it', () => {
    expect(summarizePush(base).keysRestored).toBe(0);
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

  describe('key conflicts', () => {
    const withRules = (files: unknown[]): Config => ({ apiUrl: 'http://x', files, locales: {} }) as unknown as Config;
    const nested = withRules([{ pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }]);
    const conflicts = {
      summary: { errors: 0, warnings: 0, locales: [{ locale: 'en', errors: 0, warnings: 0 }], keyConflicts: 2 },
      keyConflicts: [
        { namespace: 'admin', key: 'panel', below: ['panel.title'], belowCount: 1 },
        { namespace: 'shop', key: 'cart', below: ['cart.a', 'cart.b', 'cart.c', 'cart.d'], belowCount: 30 },
      ],
      keyConflictsTruncated: false,
    };
    const lines = (r: LintResponse, cfg: Config): string[] => stripVTControlCharacters(renderLint(r, cfg)).split('\n');

    it('a nested JSON rule lists them above the verdict, which stays clean', () => {
      expect(lines(res(conflicts), nested)).toEqual([
        'Keys that are also the path above other keys (2):',
        'admin',
        '  panel  above  panel.title',
        'shop',
        '  cart  above  cart.a, cart.b, cart.c (+27 more)',
        'A nested JSON file cannot hold both: `pull` writes one and drops the other. Set "jsonStyle": "flat" on the files rule, or rename one of the two keys.',
        'Not counted as an error or a warning.',
        '',
        '✔ No issues in 1 locale(s).',
      ]);
    });

    it('a layout that holds both keys says nothing: flat JSON, Symfony YAML, Android, no rule at all', () => {
      for (const files of [
        [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonStyle: 'flat' }],
        [{ pattern: 't/{namespace}.{locale}.yaml', format: 'yaml', yamlDialect: 'symfony', jsonStyle: 'nested' }],
        [{ pattern: 'app/values-{locale}/strings.xml', format: 'android', namespace: 'shop' }],
        [],
      ]) {
        expect(lines(res(conflicts), withRules(files))).toEqual(['✔ No issues in 1 locale(s).']);
      }
    });

    it('only namespaces a nested rule writes are listed; a Rails rule gets its own outcome line', () => {
      const mixed = withRules([
        { pattern: 'config/locales/{locale}.yml', format: 'yaml', yamlDialect: 'rails', namespace: 'admin' },
        { pattern: 'l/{locale}/shop.json', format: 'json', jsonStyle: 'flat', namespace: 'shop' },
      ]);
      expect(lines(res(conflicts), mixed)).toEqual([
        'Keys that are also the path above other keys (1):',
        'admin',
        '  panel  above  panel.title',
        'A Rails YAML file cannot hold both: `pull` refuses it (keyConflict). Rename one of the two keys.',
        'Not counted as an error or a warning.',
        '',
        '✔ No issues in 1 locale(s).',
      ]);
    });

    it('sits between the cells and the totals when there are issues, and says when the server capped the list', () => {
      const out: string[] = lines(
        res({
          ...conflicts,
          summary: { errors: 1, warnings: 0, locales: [{ locale: 'it', errors: 1, warnings: 0 }], keyConflicts: 450 },
          cells: [cell({})],
          keyConflictsTruncated: true,
        }),
        nested,
      );
      expect(out.slice(0, 4)).toEqual(['shop', '  cart.items', '    it       error    missing placeholder {count}', '']);
      expect(out[4]).toBe('Keys that are also the path above other keys (2):');
      expect(out).toContain('The server listed only the first 2 of 450 such keys in the namespaces linted, so this list may be incomplete.');
      expect(out.slice(-2)).toEqual(['', '✖ 1 error, 0 warnings — it 1/0']);
    });

    it('a namespace owned by a fixed-namespace rule is judged by that rule alone, as pull writes it', () => {
      const wildcardNested = { pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' };
      // `shop` goes to Android (holds both), `admin` to flat JSON: the nested wildcard writes neither.
      const owned = withRules([
        wildcardNested,
        { pattern: 'app/values-{locale}/strings.xml', format: 'android', namespace: 'shop' },
        { pattern: 'l/{locale}/admin.json', format: 'json', jsonStyle: 'flat', namespace: 'admin' },
      ]);
      expect(lines(res(conflicts), owned)).toEqual(['✔ No issues in 1 locale(s).']);

      // Only `shop` is owned: `admin` still falls to the nested wildcard.
      const half = withRules([wildcardNested, { pattern: 'app/values-{locale}/strings.xml', format: 'android', namespace: 'shop' }]);
      expect(lines(res(conflicts), half).slice(0, 3)).toEqual([
        'Keys that are also the path above other keys (1):',
        'admin',
        '  panel  above  panel.title',
      ]);

      // Two fixed rules for one namespace, one of them nested: it is listed.
      const both = withRules([
        { pattern: 'app/values-{locale}/strings.xml', format: 'android', namespace: 'shop' },
        { pattern: 'l/{locale}/shop.json', format: 'json', jsonStyle: 'nested', namespace: 'shop' },
      ]);
      expect(lines(res(conflicts), both)[1]).toBe('shop');
    });

    it('a count below the names sent never prints a negative remainder', () => {
      const odd = { ...conflicts, keyConflicts: [{ namespace: 'shop', key: 'cart', below: ['cart.a', 'cart.b', 'cart.c', 'cart.d', 'cart.e'], belowCount: 2 }] };
      expect(lines(res(odd), nested)[2]).toBe('  cart  above  cart.a, cart.b, cart.c (+2 more)');
    });

    it('a capped list of which the rules hide a part: the header counts what is listed, the cap line the server\'s numbers', () => {
      // Three entries came back of 450; this repo's nested rule writes only `shop`, so two of the three are hidden.
      const shopOnly = withRules([{ pattern: 'l/{locale}/shop.json', format: 'json', jsonStyle: 'nested', namespace: 'shop' }]);
      const out: string[] = lines(
        res({
          summary: { errors: 0, warnings: 0, locales: [{ locale: 'en', errors: 0, warnings: 0 }], keyConflicts: 450 },
          keyConflicts: [
            { namespace: 'admin', key: 'panel', below: ['panel.title'], belowCount: 1 },
            { namespace: 'other', key: 'x', below: ['x.y'], belowCount: 1 },
            { namespace: 'shop', key: 'cart', below: ['cart.title'], belowCount: 1 },
          ],
          keyConflictsTruncated: true,
        }),
        shopOnly,
      );
      expect(out.slice(0, 4)).toEqual([
        'Keys that are also the path above other keys (1):',
        'shop',
        '  cart  above  cart.title',
        'The server listed only the first 3 of 450 such keys in the namespaces linted, so this list may be incomplete.',
      ]);

      // Capped, and every entry that came back is hidden: nothing to list, so nothing is said at all.
      const flatOnly = withRules([{ pattern: 'l/{locale}/shop.json', format: 'json', jsonStyle: 'flat', namespace: 'shop' }]);
      expect(lines(res({ ...conflicts, keyConflictsTruncated: true }), flatOnly)).toEqual(['✔ No issues in 1 locale(s).']);
    });

    it('a server that does not send them yet changes nothing', () => {
      expect(lines(res({ summary: { errors: 0, warnings: 0, locales: [] } }), nested)).toEqual(['✔ No issues in 0 locale(s).']);
    });
  });

  it('text from the server cannot drive the terminal: control characters print as escapes, in cells and key conflicts', () => {
    const esc = '\x1b[2K\x1b[31m';
    const nested = { apiUrl: 'http://x', files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }], locales: {} } as unknown as Config;
    const raw: string = renderLint(
      res({
        summary: { errors: 1, warnings: 0, locales: [{ locale: `i${esc}t`, errors: 1, warnings: 0 }], keyConflicts: 1 },
        cells: [cell({ namespace: `sh${esc}op`, key: `cart${esc}.items\nfake line`, locale: `i${esc}t`, issues: [{ code: `ODD${esc}`, severity: 'ERROR', arg: `a${esc}` }] })],
        keyConflicts: [{ namespace: `sh${esc}op`, key: `ca${esc}rt`, below: [`ca${esc}rt.title`], belowCount: 1 }],
        keyConflictsTruncated: false,
      }),
      nested,
    );
    // Only this CLI's own colour codes may remain; none of the server's sequences, and no line it could have faked.
    expect(raw).not.toContain('\x1b[2K');
    expect(stripVTControlCharacters(raw)).toContain('  cart\\x1b[2K\\x1b[31m.items\\nfake line');
    expect(stripVTControlCharacters(raw)).toContain('  ca\\x1b[2K\\x1b[31mrt  above  ca\\x1b[2K\\x1b[31mrt.title');
    expect(stripVTControlCharacters(raw).split('\n')).not.toContain('fake line');
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

describe('reason texts', () => {
  it('name no single target format', () => {
    const lines = renderReasonCells(
      ['ordinal', 'formattedArg', 'literalBrace', 'invalidKey'].map((reason) => ({ namespace: 'n', key: 'k', locale: 'en', reason })),
      undefined,
    ).join('\n');

    expect(lines).not.toMatch(/Angular/);
    expect(lines).toMatch(/valid resource name/);
  });
});
