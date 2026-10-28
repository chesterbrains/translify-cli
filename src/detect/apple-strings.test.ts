import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectAppleStrings } from './apple-strings.js';
import { detectLayout } from './index.js';

const tree = async (paths: string[]): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '');
  }

  return root;
};

const rule = (format: string, namespace: string, table: string, dir: string = 'Sources/App') => ({
  pattern: `${dir}/{locale}.lproj/${table}.${format}`,
  format,
  namespace,
});

describe('detectAppleStrings', () => {
  it('ignores a repo without .lproj', async () => {
    expect(await detectAppleStrings(await tree(['package.json']))).toEqual({ rules: [], notes: [] });
  });

  it('proposes one strings rule per table', async () => {
    const cwd: string = await tree(['Sources/App/en.lproj/Localizable.strings', 'Sources/App/it.lproj/Localizable.strings']);

    expect(await detectAppleStrings(cwd)).toEqual({ rules: [rule('strings', 'localizable', 'Localizable')], notes: [] });
  });

  it('adds a stringsdict rule with the same namespace', async () => {
    const cwd: string = await tree([
      'Sources/App/en.lproj/Localizable.strings',
      'Sources/App/it.lproj/Localizable.strings',
      'Sources/App/en.lproj/Localizable.stringsdict',
    ]);

    expect((await detectAppleStrings(cwd)).rules).toEqual([
      rule('strings', 'localizable', 'Localizable'),
      rule('stringsdict', 'localizable', 'Localizable'),
    ]);
  });

  it('gives each table its own pair', async () => {
    const cwd: string = await tree([
      'Sources/App/en.lproj/Localizable.strings',
      'Sources/App/en.lproj/Localizable.stringsdict',
      'Sources/App/en.lproj/Errors.strings',
      'Sources/App/it.lproj/Errors.strings',
    ]);

    expect((await detectAppleStrings(cwd)).rules).toEqual([
      rule('strings', 'errors', 'Errors'),
      rule('strings', 'localizable', 'Localizable'),
      rule('stringsdict', 'localizable', 'Localizable'),
    ]);
  });

  it('uses {locale}.lproj at the root', async () => {
    const cwd: string = await tree(['en.lproj/Localizable.strings', 'it.lproj/Localizable.strings']);

    expect((await detectAppleStrings(cwd)).rules).toEqual([
      { pattern: '{locale}.lproj/Localizable.strings', format: 'strings', namespace: 'localizable' },
    ]);
  });

  it('notes when only Base.lproj holds the table', async () => {
    const cwd: string = await tree(['Sources/App/Base.lproj/Localizable.strings']);

    expect(await detectAppleStrings(cwd)).toEqual({
      rules: [rule('strings', 'localizable', 'Localizable')],
      notes: ['Only Base.lproj holds Localizable: map it with "locales": { "Base": "<your default locale>" }'],
    });
  });

  it('ignores build output', async () => {
    const cwd: string = await tree(['.build/x/en.lproj/Localizable.strings', 'Pods/P/en.lproj/Localizable.strings']);

    expect(await detectAppleStrings(cwd)).toEqual({ rules: [], notes: [] });
  });

  it('suffixes a table found in two directories', async () => {
    const cwd: string = await tree(['A/en.lproj/Localizable.strings', 'B/en.lproj/Localizable.strings', 'B/it.lproj/Localizable.strings']);
    const found = await detectAppleStrings(cwd);

    expect(found.rules).toEqual([
      rule('strings', 'localizable', 'Localizable', 'A'),
      rule('strings', 'localizable-2', 'Localizable', 'B'),
    ]);
    expect(found.notes).toEqual(['Two directories hold a Localizable table: the second one (B) is namespace localizable-2.']);
  });

  it('runs next to the Xcode detector', async () => {
    const cwd: string = await tree(['App/Localizable.xcstrings', 'App/en.lproj/Legacy.strings']);
    const rules = (await detectLayout(cwd)).rules;

    expect(rules.map((r) => r.format)).toEqual(['xliff', 'strings']);
  });
});
