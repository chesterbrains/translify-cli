import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectAngular } from './angular.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const angularJson = (projects: Record<string, unknown>): string => JSON.stringify({ version: 1, projects });
const RULE = { format: 'xliff', xliffDialect: 'angular' } as const;

describe('detectAngular', () => {
  it('ignores a repo without angular.json', async () => {
    expect(await detectAngular(await tree({ 'package.json': '{}' }))).toEqual({ rules: [], notes: [] });
  });

  it('reads a string translation path and names the namespace after the project', async () => {
    const cwd: string = await tree({
      'angular.json': angularJson({ 'My Shop': { i18n: { sourceLocale: 'en-US', locales: { 'it-IT': 'src/locale/messages.it-IT.xlf' } } } }),
    });
    const { rules, notes } = await detectAngular(cwd);
    expect(rules).toEqual([{ ...RULE, pattern: 'src/locale/messages.{locale}.xlf', namespace: 'my-shop' }]);
    expect(notes).toContain('Angular source locale for My Shop: en-US.');
    expect(notes.join('\n')).toContain('--format=xlf2 --out-file messages.en-US.xlf');
  });

  it('accepts array and object translation values, and an object sourceLocale', async () => {
    const cwd: string = await tree({
      'angular.json': angularJson({
        web: {
          i18n: {
            sourceLocale: { code: 'en', baseHref: '/' },
            locales: { fr: ['src/locale/messages.fr.xlf', 'src/locale/extra.fr.xlf'], de: { translation: 'src/locale/messages.de.xlf' } },
          },
        },
      }),
    });
    const { rules, notes } = await detectAngular(cwd);
    expect(rules).toEqual([{ ...RULE, pattern: 'src/locale/messages.{locale}.xlf', namespace: 'web' }]);
    expect(notes).toContain('Angular source locale for web: en.');
  });

  it('writes one rule per distinct pattern across projects', async () => {
    const cwd: string = await tree({
      'angular.json': angularJson({
        shop: { i18n: { locales: { it: 'projects/shop/src/locale/messages.it.xlf' } } },
        admin: { i18n: { locales: { it: 'projects/admin/src/locale/messages.it.xlf', fr: 'projects/admin/src/locale/messages.fr.xlf' } } },
        lib: { projectType: 'library' },
      }),
    });
    expect((await detectAngular(cwd)).rules).toEqual([
      { ...RULE, pattern: 'projects/shop/src/locale/messages.{locale}.xlf', namespace: 'shop' },
      { ...RULE, pattern: 'projects/admin/src/locale/messages.{locale}.xlf', namespace: 'admin' },
    ]);
  });

  it('replaces the last bounded occurrence of the code, not one inside a folder name', async () => {
    const cwd: string = await tree({
      'angular.json': angularJson({ app: { i18n: { locales: { es: './src\\resources\\messages.es.xlf' } } } }),
    });
    expect((await detectAngular(cwd)).rules).toEqual([{ ...RULE, pattern: 'src/resources/messages.{locale}.xlf', namespace: 'app' }]);
  });

  it('notes a path that does not contain its code, and falls back to the default rule when nothing usable is left', async () => {
    const cwd: string = await tree({
      'angular.json': angularJson({ app: { i18n: { locales: { it: 'src/locale/italian.xlf' } } } }),
    });
    const { rules, notes } = await detectAngular(cwd);
    expect(rules).toEqual([{ ...RULE, pattern: 'src/locale/messages.{locale}.xlf', namespace: 'app' }]);
    expect(notes).toContain('src/locale/italian.xlf does not contain its locale code it; add that rule by hand.');
    expect(notes.join('\n')).toContain('assumes the default');
  });

  it('falls back to the default rule when no project has i18n', async () => {
    const cwd: string = await tree({ 'angular.json': angularJson({ 'Fancy App': { projectType: 'application' } }) });
    const { rules, notes } = await detectAngular(cwd);
    expect(rules).toEqual([{ ...RULE, pattern: 'src/locale/messages.{locale}.xlf', namespace: 'fancy-app' }]);
    expect(notes.join('\n')).toContain('--out-file messages.<sourceLocale>.xlf');
  });

  it('skips with a note when angular.json is not JSON, and when it has no projects', async () => {
    expect(await detectAngular(await tree({ 'angular.json': '{ nope' }))).toEqual({ rules: [], notes: ['angular.json is not valid JSON, skipped.'] });
    expect(await detectAngular(await tree({ 'angular.json': '{}' }))).toEqual({ rules: [], notes: [] });
  });

  it('falls back to the namespace "app" for a name with no letters or digits', async () => {
    const cwd: string = await tree({ 'angular.json': angularJson({ '---': { i18n: { locales: { it: 'src/locale/messages.it.xlf' } } } }) });
    expect((await detectAngular(cwd)).rules[0]?.namespace).toBe('app');
  });
});
