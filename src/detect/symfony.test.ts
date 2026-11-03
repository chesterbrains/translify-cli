import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FileRule } from '../config.js';
import { detectSymfony } from './symfony.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const legacy = (pattern: string): FileRule => ({ pattern, format: 'yaml', yamlDialect: 'symfony', jsonStyle: 'flat' });
const icu = (pattern: string): FileRule => ({ pattern, format: 'yaml', yamlDialect: 'symfony-icu' });

describe('detectSymfony', () => {
  it('finds nothing without translations/', async () => {
    expect(await detectSymfony(await tree({ 'composer.json': '{}' }))).toEqual({ rules: [], notes: [] });
  });

  it('finds nothing without composer.json or symfony.lock', async () => {
    expect((await detectSymfony(await tree({ 'translations/messages.en.yaml': '' }))).rules).toEqual([]);
  });

  it('proposes one legacy rule for several domains and locales', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'translations/messages.en.yaml': '',
      'translations/messages.it.yaml': '',
      'translations/validators.en.yaml': '',
      'translations/validators.fr_FR.yaml': '',
      'translations/notes.txt': '',
      'translations/messages.xx.yaml': '',
    });

    expect(await detectSymfony(cwd)).toEqual({ rules: [legacy('translations/{namespace}.{locale}.yaml')], notes: [] });
  });

  it('accepts symfony.lock and proposes the ICU rule', async () => {
    const cwd: string = await tree({ 'symfony.lock': '{}', 'translations/messages+intl-icu.en.yaml': '' });

    expect(await detectSymfony(cwd)).toEqual({ rules: [icu('translations/{namespace}+intl-icu.{locale}.yaml')], notes: [] });
  });

  it('serves a domain with both styles by the ICU rule and notes it once', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'translations/messages.en.yaml': '',
      'translations/messages.it.yaml': '',
      'translations/messages+intl-icu.en.yaml': '',
      'translations/messages+intl-icu.it.yaml': '',
    });

    expect(await detectSymfony(cwd)).toEqual({
      rules: [icu('translations/{namespace}+intl-icu.{locale}.yaml')],
      notes: [
        'Domain messages has both messages.en.yaml and messages+intl-icu.en.yaml; Translify keeps one style per domain: move the legacy messages into the ICU file or change the rule.',
      ],
    });
  });

  it('keeps the legacy rule when another domain is legacy-only', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'translations/messages.en.yaml': '',
      'translations/messages+intl-icu.en.yaml': '',
      'translations/validators.en.yaml': '',
    });
    const { rules, notes } = await detectSymfony(cwd);

    expect(rules).toEqual([
      legacy('translations/{namespace}.{locale}.yaml'),
      icu('translations/{namespace}+intl-icu.{locale}.yaml'),
    ]);
    expect(notes).toHaveLength(1);
  });

  it('notes a domain that is not a valid namespace and leaves it out of the rules', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'translations/EasyAdminBundle.en.yaml': '',
      'translations/EasyAdminBundle.it.yaml': '',
      'translations/admin_panel.en.yml': '',
    });

    expect(await detectSymfony(cwd)).toEqual({
      rules: [],
      notes: [
        'translations/EasyAdminBundle.en.yaml is domain "EasyAdminBundle", which is not a valid namespace: add { "pattern": "translations/EasyAdminBundle.{locale}.yaml", "format": "yaml", "yamlDialect": "symfony", "namespace": "easy-admin-bundle" } by hand.',
        'translations/admin_panel.en.yml is domain "admin_panel", which is not a valid namespace: add { "pattern": "translations/admin_panel.{locale}.yml", "format": "yaml", "yamlDialect": "symfony", "namespace": "admin-panel" } by hand.',
      ],
    });
  });

  it('notes an ICU domain that is not a valid namespace with the symfony-icu dialect', async () => {
    const cwd: string = await tree({ 'composer.json': '{}', 'translations/EasyAdminBundle+intl-icu.en.yaml': '' });

    expect(await detectSymfony(cwd)).toEqual({
      rules: [],
      notes: [
        'translations/EasyAdminBundle+intl-icu.en.yaml is domain "EasyAdminBundle", which is not a valid namespace: add { "pattern": "translations/EasyAdminBundle+intl-icu.{locale}.yaml", "format": "yaml", "yamlDialect": "symfony-icu", "namespace": "easy-admin-bundle" } by hand.',
      ],
    });
  });

  it('writes one rule per extension', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'translations/messages.en.yaml': '',
      'translations/validators.en.yml': '',
    });

    expect((await detectSymfony(cwd)).rules).toEqual([
      legacy('translations/{namespace}.{locale}.yaml'),
      legacy('translations/{namespace}.{locale}.yml'),
    ]);
  });

  it('ignores vendor/ and does not recurse', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'vendor/x/translations/messages.en.yaml': '',
      'translations/sub/messages.en.yaml': '',
    });

    expect(await detectSymfony(cwd)).toEqual({ rules: [], notes: [] });
  });

  it('ignores node_modules/ and var/', async () => {
    const cwd: string = await tree({
      'composer.json': '{}',
      'node_modules/x/translations/messages.en.yaml': '',
      'node_modules/x/composer.json': '{}',
      'var/translations/messages.en.yaml': '',
      'var/composer.json': '{}',
    });

    expect(await detectSymfony(cwd)).toEqual({ rules: [], notes: [] });
  });

  it('finds the marker of an app whose folder holds glob metacharacters', async () => {
    const cwd: string = await tree({ '(app)/composer.json': '{}', '(app)/translations/messages.en.yaml': '' });

    expect((await detectSymfony(cwd)).rules).toEqual([legacy('(app)/translations/{namespace}.{locale}.yaml')]);
  });

  it('finds an app below the root with a prefixed pattern', async () => {
    const cwd: string = await tree({ 'apps/api/composer.json': '{}', 'apps/api/translations/messages.en.yaml': '' });

    expect((await detectSymfony(cwd)).rules).toEqual([legacy('apps/api/translations/{namespace}.{locale}.yaml')]);
  });
});
