import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FileRule } from '../config.js';
import { detectLayout } from './index.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const rules = async (cwd: string): Promise<FileRule[]> => (await detectLayout(cwd)).rules;

describe('detectLayout', () => {
  it('detects i18next under public/locales', async () => {
    expect(await rules(await tree({ 'public/locales/en/common.json': '{}' }))).toEqual([
      { pattern: 'public/locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' },
    ]);
  });

  it.each(['locales', 'src/locales', 'src/i18n'])('detects i18next under %s', async (root) => {
    expect(await rules(await tree({ [`${root}/en/common.json`]: '{}' }))).toEqual([
      { pattern: `${root}/{locale}/{namespace}.json`, format: 'json', jsonStyle: 'nested' },
    ]);
  });

  it('detects Flutter from l10n.yaml', async () => {
    const root: string = await tree({
      'l10n.yaml': 'arb-dir: lib/i18n\ntemplate-arb-file: strings_en.arb\n',
      'lib/i18n/strings_en.arb': '{}',
    });
    expect(await rules(root)).toEqual([{ pattern: 'lib/i18n/strings_{locale}.arb', format: 'arb', namespace: 'app' }]);
  });

  it('defaults l10n.yaml to lib/l10n and app_en.arb', async () => {
    expect(await rules(await tree({ 'l10n.yaml': 'synthetic-package: false\n' }))).toEqual([
      { pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' },
    ]);
  });

  it('detects Flutter from lib/l10n/*.arb without l10n.yaml', async () => {
    expect(await rules(await tree({ 'lib/l10n/app_en.arb': '{}' }))).toEqual([
      { pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' },
    ]);
  });

  it.each([
    ['app_en_US.arb', 'app'],
    ['app_pt_BR.arb', 'app'],
    ['app_zh_Hant.arb', 'app'],
    ['my_app_en.arb', 'my_app'],
    ['strings_en.arb', 'strings'],
  ])('derives the ARB prefix from %s', async (template, prefix) => {
    const root: string = await tree({ 'l10n.yaml': `arb-dir: lib/l10n\ntemplate-arb-file: ${template}\n` });
    expect(await rules(root)).toEqual([{ pattern: `lib/l10n/${prefix}_{locale}.arb`, format: 'arb', namespace: 'app' }]);
  });

  it('reads l10n.yaml with quotes, comments, CRLF and a leading ./', async () => {
    const root: string = await tree({
      'l10n.yaml': '# arb-dir: nope\r\narb-dir: "./lib/i18n/"  # where\r\ntemplate-arb-file: \'app_en_US.arb\'\r\n',
    });
    expect(await rules(root)).toEqual([{ pattern: 'lib/i18n/app_{locale}.arb', format: 'arb', namespace: 'app' }]);
  });

  it('returns nothing for an unknown layout', async () => {
    expect(await detectLayout(await tree({ 'README.md': '' }))).toEqual({ rules: [], notes: [] });
  });
});
