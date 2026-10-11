import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const withConfig = async (content: unknown): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'tfy-'));
  await writeFile(join(root, 'translify.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return root;
};

const base = { apiUrl: 'https://x/api', files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json' }] };

describe('loadConfig', () => {
  it('loads a valid config with defaults', async () => {
    const root = await withConfig(base);
    expect(await loadConfig(root)).toEqual({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
      locales: {},
    });
  });

  it('names the offending field', async () => {
    const root = await withConfig({ apiUrl: 'https://x/api', files: [{ pattern: 'l/{namespace}.json', format: 'json' }] });
    await expect(loadConfig(root)).rejects.toThrow(/files\.0\.pattern.*\{locale\}/);
  });

  it('requires a namespace when the pattern has none, and always for ARB', async () => {
    const root = await withConfig({ apiUrl: 'https://x/api', files: [{ pattern: 'l/{locale}.arb', format: 'arb' }] });
    await expect(loadConfig(root)).rejects.toThrow(/namespace/);
    const arb = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{namespace}/{locale}.arb', format: 'arb' }],
    });
    await expect(loadConfig(arb)).rejects.toThrow(/files\.0\.namespace/);
  });

  it('rejects a malformed namespace', async () => {
    const root = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{locale}.xlf', format: 'xliff', namespace: 'Web App' }],
    });
    await expect(loadConfig(root)).rejects.toThrow(/files\.0\.namespace/);
  });

  it('rejects a locale map whose target is not a valid locale code', async () => {
    const root = await withConfig({ ...base, locales: { en_US: 'en_US' } });
    await expect(loadConfig(root)).rejects.toThrow(/locales\.en_US/);
  });

  it('keeps a valid locale map', async () => {
    const root = await withConfig({ ...base, locales: { en_US: 'en-US' } });
    expect((await loadConfig(root)).locales).toEqual({ en_US: 'en-US' });
  });

  it('refuses a key in the config', async () => {
    const root = await withConfig({ apiUrl: 'https://x/api', apiKey: 'sk_x', files: [] });
    await expect(loadConfig(root)).rejects.toThrow(/TRANSLIFY_SECRET_KEY/);
  });

  it('explains a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tfy-'));
    await expect(loadConfig(root)).rejects.toThrow(/translify init/);
  });

  it('rejects a locale map with duplicate targets', async () => {
    const root = await withConfig({ ...base, locales: { en_US: 'en-US', en: 'en-US' } });
    await expect(loadConfig(root)).rejects.toThrow(/locales\.en.*en-US/);
  });

  it('rejects a map target that is another disk locale (chains)', async () => {
    const root = await withConfig({ ...base, locales: { en: 'en-GB', 'en-GB': 'fr' } });
    await expect(loadConfig(root)).rejects.toThrow(/locales\.en/);
  });

  it('rejects repeated placeholders', async () => {
    const root = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: '{locale}/{locale}.json', format: 'json', namespace: 'a' }],
    });
    await expect(loadConfig(root)).rejects.toThrow(/files\.0\.pattern.*once/);
    const ns = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: '{locale}/{namespace}/{namespace}.json', format: 'json' }],
    });
    await expect(loadConfig(ns)).rejects.toThrow(/files\.0\.pattern.*once/);
  });

  it('rejects unknown fields in a file rule', async () => {
    const root = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonstyle: 'flat' }],
    });
    await expect(loadConfig(root)).rejects.toThrow(/files\.0/);
  });
});

describe('loadConfig xliffDialect', () => {
  it('accepts xliffDialect on xliff rules only', async () => {
    const ok = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{locale}.xlf', format: 'xliff', namespace: 'web', xliffDialect: 'angular' }],
    });
    expect((await loadConfig(ok)).files[0]).toMatchObject({ xliffDialect: 'angular' });

    const bad = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', xliffDialect: 'angular' }],
    });
    await expect(loadConfig(bad)).rejects.toThrow(/files\.0\.xliffDialect only applies to format "xliff"/);
  });
});

describe('loadConfig xliffDialect xcode', () => {
  it('requires xliffOriginal with xcode and refuses it elsewhere', async () => {
    const ok = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'L/{locale}.xliff', format: 'xliff', namespace: 'ios', xliffDialect: 'xcode', xliffOriginal: 'Sources/App/Localizable.xcstrings' }],
    });
    expect((await loadConfig(ok)).files[0]).toMatchObject({ xliffDialect: 'xcode', xliffOriginal: 'Sources/App/Localizable.xcstrings' });

    const missing = await withConfig({ apiUrl: 'https://x/api', files: [{ pattern: 'L/{locale}.xliff', format: 'xliff', namespace: 'ios', xliffDialect: 'xcode' }] });
    await expect(loadConfig(missing)).rejects.toThrow(/files\.0\.xliffOriginal required with xliffDialect "xcode"/);

    const stray = await withConfig({
      apiUrl: 'https://x/api',
      files: [{ pattern: 'L/{locale}.xlf', format: 'xliff', namespace: 'web', xliffDialect: 'angular', xliffOriginal: 'x' }],
    });
    await expect(loadConfig(stray)).rejects.toThrow(/files\.0\.xliffOriginal only applies to xliffDialect "xcode"/);
  });
});
