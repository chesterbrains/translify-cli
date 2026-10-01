import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findFiles, pathFor, toFsLocale, toTranslifyLocale } from './patterns.js';
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
