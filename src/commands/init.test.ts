import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { detectLayout, runInit, suggestLocaleMap, type InitDeps, type WhoamiInfo } from './init.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

describe('detectLayout', () => {
  it('detects i18next under public/locales', async () => {
    expect(await detectLayout(await tree({ 'public/locales/en/common.json': '{}' }))).toEqual([
      { pattern: 'public/locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' },
    ]);
  });

  it.each(['locales', 'src/locales', 'src/i18n'])('detects i18next under %s', async (root) => {
    expect(await detectLayout(await tree({ [`${root}/en/common.json`]: '{}' }))).toEqual([
      { pattern: `${root}/{locale}/{namespace}.json`, format: 'json', jsonStyle: 'nested' },
    ]);
  });

  it('detects Flutter from l10n.yaml', async () => {
    const root: string = await tree({
      'l10n.yaml': 'arb-dir: lib/i18n\ntemplate-arb-file: strings_en.arb\n',
      'lib/i18n/strings_en.arb': '{}',
    });
    expect(await detectLayout(root)).toEqual([{ pattern: 'lib/i18n/strings_{locale}.arb', format: 'arb', namespace: 'app' }]);
  });

  it('defaults l10n.yaml to lib/l10n and app_en.arb', async () => {
    expect(await detectLayout(await tree({ 'l10n.yaml': 'synthetic-package: false\n' }))).toEqual([
      { pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' },
    ]);
  });

  it('detects Flutter from lib/l10n/*.arb without l10n.yaml', async () => {
    expect(await detectLayout(await tree({ 'lib/l10n/app_en.arb': '{}' }))).toEqual([
      { pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' },
    ]);
  });

  it('returns nothing for an unknown layout', async () => {
    expect(await detectLayout(await tree({ 'README.md': '' }))).toEqual([]);
  });
});

describe('suggestLocaleMap', () => {
  it('maps locales that differ only by case or separator', () => {
    expect(suggestLocaleMap(['en_US', 'it-IT', 'fr'], ['en-US', 'it-IT', 'fr'])).toEqual({ en_US: 'en-US' });
    expect(suggestLocaleMap(['pt_br'], ['pt-BR'])).toEqual({ pt_br: 'pt-BR' });
  });

  it('skips unrelated locales, and targets that would collide or chain', () => {
    expect(suggestLocaleMap(['de'], ['en-US'])).toEqual({});
    expect(suggestLocaleMap(['en_US', 'en-us'], ['en-US'])).toEqual({ en_US: 'en-US' });
    expect(suggestLocaleMap(['en_US', 'en-US'], ['en-US'])).toEqual({});
  });
});

const deps = (cwd: string, over: Partial<InitDeps> = {}): { d: InitDeps; out: string[] } => {
  const out: string[] = [];
  const d: InitDeps = {
    cwd,
    isTty: true,
    out: (line) => out.push(line),
    apiUrlDefault: 'https://example.test/api',
    prompt: { input: async (_m, def) => def, confirm: async () => true },
    fetchWhoami: async () => undefined,
    ...over,
  };

  return { d, out };
};

const WHOAMI: WhoamiInfo = {
  project: { name: 'Acme', slug: 'acme', defaultLocale: 'en-US' },
  locales: ['en-US', 'it-IT'],
};

describe('runInit', () => {
  it('writes a translify.json that loadConfig accepts, with $schema and no key', async () => {
    const cwd: string = await tree({ 'public/locales/en/common.json': '{}' });
    const { d } = deps(cwd);

    expect(await runInit(d)).toBe(0);
    const raw: string = await readFile(join(cwd, 'translify.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).$schema).toBe('https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json');
    expect(raw).not.toMatch(/key|secret|token/i);
    await expect(loadConfig(cwd)).resolves.toEqual({
      apiUrl: 'https://example.test/api',
      files: [{ pattern: 'public/locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
      locales: {},
    });
  });

  it('still writes a valid file with an example rule when nothing is detected', async () => {
    const cwd: string = await tree({ 'README.md': '' });
    const { d, out } = deps(cwd);

    expect(await runInit(d)).toBe(0);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ files: [expect.any(Object)] });
    expect(out.join('\n')).toMatch(/edit files\[\]/);
  });

  it('writes the suggested locales map from whoami and still validates', async () => {
    const cwd: string = await tree({ 'locales/en_US/common.json': '{}', 'locales/it-IT/common.json': '{}' });
    const { d, out } = deps(cwd, { fetchWhoami: async () => WHOAMI });

    expect(await runInit(d)).toBe(0);
    expect(out.join('\n')).toMatch(/Project: Acme, default locale en-US; locales: en-US, it-IT/);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: { en_US: 'en-US' } });
  });

  it('leaves the map out when the suggestion is declined', async () => {
    const cwd: string = await tree({ 'locales/en_US/common.json': '{}' });
    const { d } = deps(cwd, { fetchWhoami: async () => WHOAMI, prompt: { input: async (_m, def) => def, confirm: async () => false } });

    await runInit(d);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: {} });
  });

  it('refuses to overwrite an existing translify.json without confirmation', async () => {
    const cwd: string = await tree({ 'translify.json': 'KEEP', 'locales/en/a.json': '{}' });
    const confirm = vi.fn().mockResolvedValue(false);
    const { d } = deps(cwd, { prompt: { input: async (_m, def) => def, confirm } });

    expect(await runInit(d)).toBe(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/overwrite/i), false);
    expect(await readFile(join(cwd, 'translify.json'), 'utf8')).toBe('KEEP');
  });

  it('overwrites when confirmed', async () => {
    const cwd: string = await tree({ 'translify.json': 'KEEP', 'locales/en/a.json': '{}' });

    expect(await runInit(deps(cwd).d)).toBe(0);
    await expect(loadConfig(cwd)).resolves.toBeDefined();
  });

  it('rejects a bad apiUrl and writes nothing', async () => {
    const cwd: string = await tree({ 'locales/en/a.json': '{}' });
    const { d } = deps(cwd, { prompt: { input: async () => 'not a url', confirm: async () => true } });

    expect(await runInit(d)).toBe(1);
    await expect(readFile(join(cwd, 'translify.json'), 'utf8')).rejects.toThrow();
  });

  it('needs a TTY and does not prompt without one', async () => {
    const cwd: string = await tree({});
    const input = vi.fn();
    const { d, out } = deps(cwd, { isTty: false, prompt: { input, confirm: vi.fn() } });

    expect(await runInit(d)).toBe(1);
    expect(input).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/terminal/);
  });
});
