import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FileRule } from '../config.js';
import { detectRails } from './rails.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const yml = (locale: string): string => `---\n# comment\n${locale}:\n  hello: Hi\n`;
const rule = (pattern: string, namespace: string): FileRule => ({
  pattern,
  format: 'yaml',
  yamlDialect: 'rails',
  namespace,
});

describe('detectRails', () => {
  it('finds nothing without config/locales', async () => {
    expect(await detectRails(await tree({ Gemfile: '', 'config/application.rb': '' }))).toEqual({ rules: [], notes: [] });
  });

  it('finds nothing without a Gemfile or application.rb', async () => {
    expect((await detectRails(await tree({ 'config/locales/en.yml': yml('en') }))).rules).toEqual([]);
  });

  it('proposes one rule per shape', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/it.yml': yml('it'),
      'config/locales/devise.en.yml': yml('en'),
      'config/locales/devise.it.yml': yml('it'),
      'config/locales/models/en.yml': yml('en'),
    });

    expect(await detectRails(cwd)).toEqual({
      rules: [
        rule('config/locales/devise.{locale}.yml', 'devise'),
        rule('config/locales/models/{locale}.yml', 'models'),
        rule('config/locales/{locale}.yml', 'app'),
      ],
      notes: [],
    });
  });

  it('recognises regional and script locales', async () => {
    const cwd: string = await tree({
      'config/application.rb': '',
      'config/locales/pt-BR.yaml': yml('pt-BR'),
      'config/locales/zh-Hant.yaml': yml('zh-Hant'),
    });

    expect((await detectRails(cwd)).rules).toEqual([rule('config/locales/{locale}.yaml', 'app')]);
  });

  it('skips multi-root and mismatched files with a note', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/all.yml': 'en:\n  a: A\nit:\n  a: B\n',
      'config/locales/fr.yml': yml('de'),
    });
    const found = await detectRails(cwd);

    expect(found.rules).toEqual([rule('config/locales/{locale}.yml', 'app')]);
    expect(found.notes).toHaveLength(2);
    expect(found.notes[0]).toContain('config/locales/all.yml');
    expect(found.notes[0]).toContain('config/locales/fr.yml');
  });

  it('ignores vendor, node_modules and tmp', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/vendor/gem.en.yml': yml('en'),
      'config/locales/tmp/x.en.yml': yml('en'),
    });

    expect((await detectRails(cwd)).rules).toEqual([rule('config/locales/{locale}.yml', 'app')]);
  });

  it('suffixes colliding namespaces', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/devise.en.yml': yml('en'),
      'config/locales/devise/en.yml': yml('en'),
    });

    expect((await detectRails(cwd)).rules.map((r) => r.namespace).sort()).toEqual(['devise', 'devise-2']);
  });

  it('recognises a locale directory', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en/devise.yml': yml('en'),
      'config/locales/it/devise.yml': yml('it'),
    });

    expect(await detectRails(cwd)).toEqual({
      rules: [rule('config/locales/{locale}/devise.yml', 'devise')],
      notes: [],
    });
  });

  it('puts {locale} on the directory when the file is named like the locale too', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en/en.yml': yml('en'),
    });

    expect((await detectRails(cwd)).rules).toEqual([rule('config/locales/{locale}/en.yml', 'en')]);
  });

  it('warns when a skipped file still matches a proposed rule', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/all.yml': 'en:\n  a: A\nit:\n  a: B\n',
      'config/locales/fr.yml': yml('de'),
      'config/locales/devise.en.yml': yml('en'),
      'config/locales/other.en.yml': yml('de'),
    });
    const { notes } = await detectRails(cwd);

    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain('config/locales/{locale}.yml also matches config/locales/all.yml, config/locales/fr.yml');
    expect(notes[1]).toContain('push will read them as locale files');
    expect(notes.join('\n')).not.toContain('devise.{locale}.yml also');
  });

  it('reads BOM, CRLF and flow-style roots, and skips double documents', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': '\uFEFF---\r\nen:\r\n  a: A\r\n',
      'config/locales/it.yml': 'it: {a: b}\n',
      'config/locales/multi.de.yml': 'de:\n  a: A\n---\nde:\n  b: B\n',
    });
    const found = await detectRails(cwd);

    expect(found.rules).toEqual([rule('config/locales/{locale}.yml', 'app')]);
    expect(found.notes[0]).toContain('multi.de.yml');
  });

  it('keeps .yml and .yaml shapes apart with distinct namespaces', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/it.yaml': yml('it'),
    });

    expect((await detectRails(cwd)).rules).toEqual([
      rule('config/locales/{locale}.yaml', 'app'),
      rule('config/locales/{locale}.yml', 'app-2'),
    ]);
  });
});
