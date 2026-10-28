import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { findFiles, fromAndroidQualifier, pathFor, toAndroidQualifier, toFsLocale, toTranslifyLocale } from './patterns.js';
import type { Config } from './config.js';

const config = (over: Partial<Config> = {}): Config => ({
  apiUrl: 'https://x/api',
  files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json' }],
  locales: {},
  ...over,
});

const tree = async (paths: string[]): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '{}');
  }
  return root;
};

describe('findFiles', () => {
  it('extracts locale and namespace from the pattern', async () => {
    const root = await tree(['locales/en/cart.json', 'locales/it/cart.json', 'locales/en/README.md']);
    const found = await findFiles(config(), root);

    expect(found.map(({ path, locale, namespace }) => ({ path, locale, namespace }))).toEqual([
      { path: 'locales/en/cart.json', locale: 'en', namespace: 'cart' },
      { path: 'locales/it/cart.json', locale: 'it', namespace: 'cart' },
    ]);
  });

  it('uses the fixed namespace and maps locales for ARB', async () => {
    const root = await tree(['lib/l10n/app_en_US.arb', 'lib/l10n/app_it.arb']);
    const found = await findFiles(
      config({
        files: [{ pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' }],
        locales: { en_US: 'en-US' },
      }),
      root,
    );

    expect(found.map(({ locale, namespace }) => [locale, namespace])).toEqual([
      ['en-US', 'app'],
      ['it', 'app'],
    ]);
  });

  it('passes an unmapped locale through unchanged', async () => {
    const root = await tree(['lib/l10n/app_en_US.arb']);
    const found = await findFiles(
      config({ files: [{ pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' }] }),
      root,
    );

    expect(found.map(({ locale }) => locale)).toEqual(['en_US']);
  });

  it('returns POSIX paths even on Windows-style input', async () => {
    const root = await tree(['locales/en/cart.json']);
    expect((await findFiles(config(), root))[0]?.path).toBe('locales/en/cart.json');
    const backslashed = config({ files: [{ pattern: 'locales\\{locale}\\{namespace}.json', format: 'json' }] });
    expect((await findFiles(backslashed, root))[0]?.path).toBe('locales/en/cart.json');
  });
});

describe('findFiles safety', () => {
  it('does not match a decoy that only resembles the pattern', async () => {
    const root = await tree(['app.en.json', 'appXen.json']);
    const found = await findFiles(
      config({ files: [{ pattern: 'app.{locale}.json', format: 'json', namespace: 'app' }] }),
      root,
    );
    expect(found.map(({ path }) => path)).toEqual(['app.en.json']);
  });

  it('refuses a path matched by two rules', async () => {
    const root = await tree(['locales/en/cart.json']);
    const rules = [
      { pattern: 'locales/{locale}/{namespace}.json', format: 'json' as const },
      { pattern: 'locales/{locale}/cart.json', format: 'json' as const, namespace: 'cart' },
    ];
    const error: unknown = await findFiles(config({ files: rules }), root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(1);
    expect((error as CliError).message).toContain('locales/en/cart.json');
  });

  it('refuses an unmapped locale colliding with a mapped one', async () => {
    const root = await tree(['lib/app_en_US.arb', 'lib/app_en-US.arb']);
    const files = [{ pattern: 'lib/app_{locale}.arb', format: 'arb' as const, namespace: 'app' }];
    const error: unknown = await findFiles(config({ files, locales: { en_US: 'en-US' } }), root).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/app_en_US\.arb.*app_en-US\.arb|app_en-US\.arb.*app_en_US\.arb/);
  });
});

describe('pathFor and locale maps', () => {
  it('round-trips mapped locales', () => {
    const c = config({ locales: { en_US: 'en-US' } });
    expect(toTranslifyLocale('en_US', c)).toBe('en-US');
    expect(toFsLocale('en-US', c)).toBe('en_US');
    expect(toFsLocale(toTranslifyLocale('en_US', c), c)).toBe('en_US');
    expect(toFsLocale('it', c)).toBe('it');
    expect(toTranslifyLocale('it', c)).toBe('it');
  });

  it('builds a path from a pattern', () => {
    const c = config({ locales: { en_US: 'en-US' } });
    expect(pathFor({ pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' }, 'en-US', 'app', c)).toBe(
      'lib/l10n/app_en_US.arb',
    );
    expect(pathFor(c.files[0]!, 'it', 'cart', c)).toBe('locales/it/cart.json');
  });
});

describe('Android qualifiers', () => {
  it.each([
    ['it', 'it'],
    ['pt-BR', 'pt-rBR'],
    ['sr-Latn', 'b+sr+Latn'],
    ['zh-Hans-CN', 'b+zh+Hans+CN'],
    ['fil', 'b+fil'],
  ])('maps %s to %s and back', (code, qualifier) => {
    expect(toAndroidQualifier(code)).toBe(qualifier);
    expect(fromAndroidQualifier(qualifier)).toBe(code);
  });
});

describe('Android qualifier symmetry', () => {
  it.each(['it', 'pt-rBR', 'b+sr+Latn', 'b+fil', 'b+zh+Hans+CN'])('round-trips %s', (qualifier) => {
    expect(toAndroidQualifier(fromAndroidQualifier(qualifier))).toBe(qualifier);
  });

  it('does not read a three-letter language outside b+ as a locale', async () => {
    const cfg: Config = {
      apiUrl: 'https://x/api',
      files: [{ pattern: 'res/values-{locale}/strings.xml', format: 'android', namespace: 'strings' }],
      locales: {},
    };
    const root = await tree(['res/values/strings.xml', 'res/values-fil/strings.xml', 'res/values-fil-rPH/strings.xml', 'res/values-b+fil+PH/strings.xml']);
    const found = await findFiles(cfg, root, { defaultLocale: 'en' });

    expect(found.map((match) => match.locale).sort()).toEqual(['en', 'fil-PH']);
  });

  it('names values/ plus values-<default> as a default-locale clash', async () => {
    const cfg: Config = {
      apiUrl: 'https://x/api',
      files: [{ pattern: 'res/values-{locale}/strings.xml', format: 'android', namespace: 'strings' }],
      locales: {},
    };
    const root = await tree(['res/values/strings.xml', 'res/values-en/strings.xml']);

    await expect(findFiles(cfg, root, { defaultLocale: 'en' })).rejects.toThrow(
      'res/values/strings.xml and res/values-en/strings.xml both hold the default locale en: Android reads values/ as the default, so remove values-en/ or change the project default locale',
    );
  });
});

describe('android rules', () => {
  const android = (over: Partial<Config> = {}): Config =>
    config({
      files: [{ pattern: 'app/src/main/res/values-{locale}/strings.xml', format: 'android', namespace: 'strings' }],
      ...over,
    });
  const files = [
    'app/src/main/res/values/strings.xml',
    'app/src/main/res/values-pt-rBR/strings.xml',
    'app/src/main/res/values-b+sr+Latn/strings.xml',
    'app/src/main/res/values-night/strings.xml',
    'app/src/main/res/values-it/plurals.xml',
  ];

  it('matches values/ as the default locale and decodes qualifiers', async () => {
    const found = await findFiles(android(), await tree(files), { defaultLocale: 'en' });

    expect(found.map(({ path, locale, namespace }) => ({ path, locale, namespace }))).toEqual([
      { path: 'app/src/main/res/values-b+sr+Latn/strings.xml', locale: 'sr-Latn', namespace: 'strings' },
      { path: 'app/src/main/res/values-pt-rBR/strings.xml', locale: 'pt-BR', namespace: 'strings' },
      { path: 'app/src/main/res/values/strings.xml', locale: 'en', namespace: 'strings' },
    ]);
  });

  it('applies the locales map after the qualifier mapping', async () => {
    const found = await findFiles(android({ locales: { 'pt-BR': 'pt' } }), await tree(files), { defaultLocale: 'en' });

    expect(found.map((match) => match.locale)).toContain('pt');
  });

  it('needs the default locale', async () => {
    await expect(findFiles(android(), await tree(files))).rejects.toThrow(CliError);
    await expect(findFiles(android(), await tree(files))).rejects.toThrow(/default locale/);
  });

  it('renders the default locale as values/ and others as qualifiers', () => {
    const rule = android().files[0]!;
    const context = { defaultLocale: 'en' };

    expect(pathFor(rule, 'en', 'strings', android(), context)).toBe('app/src/main/res/values/strings.xml');
    expect(pathFor(rule, 'pt-BR', 'strings', android(), context)).toBe('app/src/main/res/values-pt-rBR/strings.xml');
    expect(pathFor(rule, 'sr-Latn', 'strings', android(), context)).toBe('app/src/main/res/values-b+sr+Latn/strings.xml');
    expect(() => pathFor(rule, 'it', 'strings', android())).toThrow(/default locale/);
  });
});

describe('strings and stringsdict slot pairing', () => {
  const rule = (format: 'strings' | 'stringsdict' | 'json', ext: string) => ({
    pattern: `App/{locale}.lproj/Localizable.${ext}`,
    format,
    namespace: 'localizable',
  });

  it('lets a strings and a stringsdict rule share a cell, refuses a json rule on it', async () => {
    const root = await tree(['App/en.lproj/Localizable.strings', 'App/en.lproj/Localizable.stringsdict', 'App/en.lproj/Localizable.json']);
    const pair: Config = config({ files: [rule('strings', 'strings'), rule('stringsdict', 'stringsdict')] });
    const found = await findFiles(pair, root);
    expect(found.map((match) => match.path).sort()).toEqual(['App/en.lproj/Localizable.strings', 'App/en.lproj/Localizable.stringsdict']);

    const reversed: Config = config({ files: [rule('stringsdict', 'stringsdict'), rule('strings', 'strings')] });
    expect(await findFiles(reversed, root)).toHaveLength(2);

    const clash: Config = config({ files: [rule('strings', 'strings'), rule('json', 'json')] });
    await expect(findFiles(clash, root)).rejects.toThrow(/both map to locale en, namespace localizable/);
    const same: Config = config({ files: [rule('strings', 'strings'), rule('strings', 'strings')] });
    await expect(findFiles(same, root)).rejects.toThrow(/matched by more than one files rule/);
  });
});
