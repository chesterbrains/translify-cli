import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectXcode } from './xcode.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const RULE = { format: 'xliff', xliffDialect: 'xcode' } as const;
const NO_XLIFF_NOTE: string = 'No XLIFF files yet: `translify pull` creates Localization/<locale>.xliff; `xcodebuild -importLocalizations` reads them.';

describe('detectXcode', () => {
  it('ignores a repo without a String Catalog', async () => {
    expect(await detectXcode(await tree({ 'Package.swift': '' }))).toEqual({ rules: [], notes: [] });
  });

  it('proposes Localization/{locale}.xliff for one catalog with no XLIFF yet', async () => {
    const cwd: string = await tree({ 'Sources/App/Localizable.xcstrings': '{}' });
    expect(await detectXcode(cwd)).toEqual({
      rules: [{ ...RULE, pattern: 'Localization/{locale}.xliff', namespace: 'localizable', xliffOriginal: 'Sources/App/Localizable.xcstrings' }],
      notes: [NO_XLIFF_NOTE],
    });
  });

  it('uses the directory of locale-named XLIFF files when they all sit in one place', async () => {
    const cwd: string = await tree({ 'App/Strings.xcstrings': '{}', 'Translations/en.xliff': '', 'Translations/it_IT.xliff': '' });
    expect(await detectXcode(cwd)).toEqual({
      rules: [{ ...RULE, pattern: 'Translations/{locale}.xliff', namespace: 'strings', xliffOriginal: 'App/Strings.xcstrings' }],
      notes: [],
    });
  });

  it('uses {locale}.xliff when the XLIFF files are at the root', async () => {
    const cwd: string = await tree({ 'Localizable.xcstrings': '{}', 'en.xliff': '' });
    expect((await detectXcode(cwd)).rules[0]?.pattern).toBe('{locale}.xliff');
  });

  it('falls back to the default when XLIFF files are spread out or not named after a locale', async () => {
    const spread: string = await tree({ 'Localizable.xcstrings': '{}', 'a/en.xliff': '', 'b/it.xliff': '' });
    expect((await detectXcode(spread)).rules[0]?.pattern).toBe('Localization/{locale}.xliff');
    const named: string = await tree({ 'Localizable.xcstrings': '{}', 'x/en.xliff': '', 'x/export.xliff': '' });
    expect((await detectXcode(named)).rules[0]?.pattern).toBe('Localization/{locale}.xliff');
  });

  it('ignores build folders, pods, node_modules and .xcloc export bundles', async () => {
    const cwd: string = await tree({
      'Sources/App/Localizable.xcstrings': '{}',
      '.build/checkouts/dep/Localizable.xcstrings': '{}',
      'Pods/Lib/Localizable.xcstrings': '{}',
      'node_modules/x/Localizable.xcstrings': '{}',
      'DerivedData/x/Localizable.xcstrings': '{}',
      'out/en.xcloc/Localized Contents/en.xliff': '',
    });
    const { rules } = await detectXcode(cwd);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe('Localization/{locale}.xliff');
  });

  it('gives several catalogs their own folder and names, numbering duplicate basenames', async () => {
    const cwd: string = await tree({
      'App/Localizable.xcstrings': '{}',
      'Widget/Localizable.xcstrings': '{}',
      'Widget/Info Plist.xcstrings': '{}',
      'Translations/en.xliff': '',
    });
    const { rules, notes } = await detectXcode(cwd);
    expect(rules).toEqual([
      { ...RULE, pattern: 'Localization/localizable/{locale}.xliff', namespace: 'localizable', xliffOriginal: 'App/Localizable.xcstrings' },
      { ...RULE, pattern: 'Localization/info-plist/{locale}.xliff', namespace: 'info-plist', xliffOriginal: 'Widget/Info Plist.xcstrings' },
      { ...RULE, pattern: 'Localization/localizable-2/{locale}.xliff', namespace: 'localizable-2', xliffOriginal: 'Widget/Localizable.xcstrings' },
    ]);
    expect(notes).toEqual([
      'Several String Catalogs: each gets its own folder under Localization/, created by `translify pull`.',
      'Two catalogs are named Localizable.xcstrings: the second one is namespace localizable-2.',
    ]);
  });
});
