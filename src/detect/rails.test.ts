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
      'config/locales/es-419.yaml': yml('es-419'),
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

  it('skips a locale folder holding a file named after the locale, and suggests a rename', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en/en.yml': yml('en'),
      'config/locales/it/it.yml': yml('it'),
      'config/locales/en/devise.yml': yml('en'),
      'config/locales/it/devise.yml': yml('it'),
    });
    const { rules, notes } = await detectRails(cwd);

    expect(rules).toEqual([rule('config/locales/{locale}/devise.yml', 'devise')]);
    expect(notes).toEqual([
      'Skipped Rails locale files named after the locale inside a locale folder (a pattern holds {locale} once): config/locales/en/en.yml, config/locales/it/it.yml. Rename them, e.g. en/en.yml to en/main.yml, and run init again.',
    ]);
  });

  it('skips en/devise.en.yml too, the locale being in the folder and the name', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en/devise.en.yml': yml('en'),
      'config/locales/it/devise.it.yml': yml('it'),
    });
    const { rules, notes } = await detectRails(cwd);

    expect(rules).toEqual([]);
    expect(notes[0]).toContain('config/locales/en/devise.en.yml, config/locales/it/devise.it.yml');
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
      'config/locales/de.yaml': yml('de'),
      'config/locales/fr.yml': yml('fr'),
    });

    expect((await detectRails(cwd)).rules).toEqual([
      rule('config/locales/{locale}.yaml', 'app'),
      rule('config/locales/{locale}.yml', 'app-2'),
    ]);
  });

  it('finds a Rails app below the repo root and writes patterns relative to it', async () => {
    const cwd: string = await tree({
      'apps/web/Gemfile': '',
      'apps/web/config/locales/en.yml': yml('en'),
      'apps/web/config/locales/it.yml': yml('it'),
      'backend/config/application.rb': '',
      'backend/config/locales/devise.en.yml': yml('en'),
      'backend/config/locales/devise.it.yml': yml('it'),
      'a/b/c/config/locales/en.yml': yml('en'),
    });
    const { rules } = await detectRails(cwd);

    expect(rules.map((r) => r.pattern).sort()).toEqual([
      'apps/web/config/locales/{locale}.yml',
      'backend/config/locales/devise.{locale}.yml',
    ]);
    expect(new Set(rules.map((r) => r.namespace)).size).toBe(2);
  });

  it('ignores a config/locales folder that has no Gemfile or application.rb beside it', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'docs/config/locales/en.yml': yml('en'),
      'docs/config/locales/it.yml': yml('it'),
    });

    expect((await detectRails(cwd)).rules).toEqual([]);
  });

  it('names a deep shape after its file, falling back to the last directory', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/models/user.en.yml': yml('en'),
      'config/locales/models/user.it.yml': yml('it'),
      'config/locales/views/user.en.yml': yml('en'),
      'config/locales/views/user.it.yml': yml('it'),
    });
    const { rules } = await detectRails(cwd);

    expect(rules).toEqual([
      rule('config/locales/models/user.{locale}.yml', 'user'),
      rule('config/locales/views/user.{locale}.yml', 'views-user'),
    ]);
  });

  it('does not take foo.bar.yml for a locale file, but still takes a lone en', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': yml('en'),
      'config/locales/it.yml': yml('it'),
      'config/locales/foo.bar.yml': yml('bar'),
      'config/locales/solo.en.yml': yml('en'),
    });
    const { rules, notes } = await detectRails(cwd);

    expect(rules.map((r) => r.pattern).sort()).toEqual(['config/locales/solo.{locale}.yml', 'config/locales/{locale}.yml']);
    expect(notes.join('\n')).toContain('config/locales/foo.bar.yml');
  });

  it('rejects tokens that are not locale codes', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/x.defaults.yml': yml('defaults'),
      'config/locales/y.defaults.yml': yml('defaults'),
      'config/locales/en.yml': yml('en'),
    });

    expect((await detectRails(cwd)).rules.map((r) => r.pattern)).toEqual(['config/locales/{locale}.yml']);
  });

  it('skips a %YAML directive when reading the root key', async () => {
    const cwd: string = await tree({
      Gemfile: '',
      'config/locales/en.yml': '%YAML 1.1\n---\nen:\n  a: A\n',
      'config/locales/it.yml': '%YAML 1.1\n---\nit:\n  a: A\n',
    });

    expect(await detectRails(cwd)).toEqual({ rules: [rule('config/locales/{locale}.yml', 'app')], notes: [] });
  });
});
