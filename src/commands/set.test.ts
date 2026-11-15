import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { runSet, targetFile, type SetDeps, type SetOptions, type SetResponse } from './set.js';

type Rule = { pattern: string; format: string; jsonStyle?: 'nested' | 'flat'; namespace?: string };
const rule = (over: Partial<Rule> = {}): Rule => ({ pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested', ...over });
const config = (files: Rule[] = [rule()], locales: Record<string, string> = {}): Config =>
  ({ apiUrl: 'http://x', files, locales }) as unknown as Config;

const res = (over: Partial<SetResponse> = {}): SetResponse => ({
  namespace: 'common',
  key: 'promo.title',
  locale: 'en',
  isSource: true,
  outcome: 'updated',
  keyCreated: false,
  keyRestored: false,
  status: 'APPROVED',
  statusDowngraded: false,
  issueSeverity: null,
  issues: null,
  staleReset: 0,
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'translify-set-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), text);
};
const read = (path: string) => readFile(join(dir, path), 'utf8');

const run = async (
  key: string,
  locale: string,
  value: string,
  opts: SetOptions,
  response: SetResponse,
  cfg: Config = config(),
  readStdin: SetDeps['readStdin'] = undefined,
) => {
  const put = vi.fn().mockResolvedValue(response);
  const out: string[] = [];
  const code = await runSet(key, locale, value, opts, {
    cwd: dir,
    config: cfg,
    api: { put, get: vi.fn() } as never,
    out: (l) => out.push(l),
    err: () => undefined,
    readStdin,
  });

  return { code, out, put };
};

const runFailing = (error: unknown, key: string, locale: string, value: string) =>
  runSet(key, locale, value, {}, {
    cwd: dir,
    config: config(),
    api: { put: vi.fn().mockRejectedValue(error), get: vi.fn() } as never,
    out: () => undefined,
    err: () => undefined,
    readStdin: undefined,
  });

const runNoStdin = (key: string, locale: string, value: string) => runFailing(undefined, key, locale, value);

describe('runSet', () => {
  it('writes the server, then patches the one entry', async () => {
    await write('locales/en/common.json', '{\n  "promo": {\n    "title": "Old"\n  }\n}\n');
    const { code, out, put } = await run('promo.title', 'en', 'Limited offer', {}, res({ namespace: 'common' }));
    expect(code).toBe(EXIT.ok);
    expect(put).toHaveBeenCalledWith('/cli/v1/translation', { key: 'promo.title', locale: 'en', value: 'Limited offer' });
    expect(await read('locales/en/common.json')).toBe('{\n  "promo": {\n    "title": "Limited offer"\n  }\n}\n');
    expect(out).toEqual(['Updated promo.title (en) in namespace common. Status: approved.', 'Updated locales/en/common.json.']);
  });

  it('a new key creates the file when there is none', async () => {
    const { out } = await run('promo.title', 'en', 'Hi', { namespace: 'shop' }, res({ namespace: 'shop', keyCreated: true, outcome: 'created' }));
    expect(await read('locales/en/shop.json')).toBe('{\n  "promo": {\n    "title": "Hi"\n  }\n}\n');
    expect(out).toEqual(['Created promo.title (en) in namespace shop. Status: approved.', 'Created locales/en/shop.json.']);
  });

  it('a refused request leaves the disk alone', async () => {
    await write('locales/it/common.json', '{}\n');
    const refusal = new CliError(EXIT.failed, 'x', { statusCode: 422, code: 'SOURCE_REQUIRED', defaultLocale: 'en' });
    await expect(runFailing(refusal, 'promo.title', 'it', 'Ciao')).rejects.toMatchObject({
      exitCode: EXIT.failed,
      message: "Key 'promo.title' does not exist. Set its source text (en) first.",
    });
    expect(await read('locales/it/common.json')).toBe('{}\n');
  });

  it('a server without the route says so', async () => {
    const missing = new CliError(EXIT.failed, 'x', { statusCode: 404 });
    await expect(runFailing(missing, 'k', 'en', 'v')).rejects.toMatchObject({ message: expect.stringContaining('does not support get and set') });
  });

  it('reports demotion, downgrade and issues', async () => {
    const { out } = await run(
      'promo.title',
      'fr',
      'Bonjour',
      { status: 'approved', write: false },
      res({
        locale: 'fr',
        isSource: false,
        status: 'NEEDS_REVIEW',
        statusDowngraded: true,
        issueSeverity: 'ERROR',
        issues: [{ code: 'MISSING_PLACEHOLDER', severity: 'ERROR', arg: 'name' }],
        staleReset: 2,
      }),
    );
    expect(out).toEqual([
      'Updated promo.title (fr) in namespace common. Status: needs-review.',
      '2 approved translation(s) moved back to needs-review.',
      'Requested approved, landed needs-review: the translation has placeholder errors.',
      'warning: placeholder error: MISSING_PLACEHOLDER name',
    ]);
  });

  it('--no-write leaves files alone and --json says why', async () => {
    const { out } = await run('k', 'en', 'v', { write: false, json: true }, res({ key: 'k' }));
    expect(JSON.parse(out[0]!).file).toEqual({ path: null, action: 'skipped', reason: 'no-write' });
    await expect(read('locales/en/common.json')).rejects.toThrow();
  });

  it('an unchanged outcome and a restored key name their verb', async () => {
    await write('locales/en/common.json', '{\n  "k": "v"\n}\n');
    const unchanged = await run('k', 'en', 'v', {}, res({ key: 'k', outcome: 'unchanged' }));
    expect(unchanged.out).toEqual(['Unchanged k (en) in namespace common. Status: approved.', 'locales/en/common.json already up to date.']);
    const restored = await run('k', 'en', 'v', { write: false }, res({ key: 'k', keyRestored: true }));
    expect(restored.out[0]).toBe('Restored k (en) in namespace common. Status: approved.');
  });

  it.each([
    ['a broken file', '{ "a": ', 'locales/en/common.json is not valid JSON; run `translify pull` to sync the file.'],
    ['a blocked path', '{\n  "promo": "text"\n}\n', 'locales/en/common.json holds a value at "promo"; run `translify pull` to sync the file.'],
  ])('%s: the server write stands, the file is untouched, exit 0', async (_name, text, line) => {
    await write('locales/en/common.json', text);
    const { code, out } = await run('promo.title', 'en', 'Hi', {}, res());
    expect(code).toBe(EXIT.ok);
    expect(out.at(-1)).toBe(line);
    expect(await read('locales/en/common.json')).toBe(text);
  });

  it('a non-JSON rule gets the pull hint; no rule at all says so', async () => {
    const xliff = config([{ pattern: 'i18n/{locale}.xlf', format: 'xliff', namespace: 'common' }]);
    expect((await run('k', 'en', 'v', {}, res(), xliff)).out.at(-1)).toBe(
      'Local patching is not supported for xliff yet; run `translify pull` to sync the file.',
    );
    const other = config([{ pattern: 'l/{locale}.json', format: 'json', jsonStyle: 'nested', namespace: 'other' }]);
    expect((await run('k', 'en', 'v', { namespace: 'common' }, res(), other)).out.at(-1)).toBe(
      'No files rule covers en/common; nothing written locally.',
    );
  });

  it('--json prints response and file; flags map onto the request; an alias locale is mapped both ways', async () => {
    const cfg = config([{ pattern: 'locales/{locale}.json', format: 'json', jsonStyle: 'flat', namespace: 'app' }], { fr_FR: 'fr' });
    const { out, put } = await run('k', 'fr_FR', 'v', { status: 'needs-review', json: true }, res({ namespace: 'app', key: 'k', locale: 'fr', isSource: false }), cfg);
    expect(put).toHaveBeenCalledWith('/cli/v1/translation', { key: 'k', locale: 'fr', value: 'v', namespace: 'app', status: 'NEEDS_REVIEW' });
    expect(JSON.parse(out[0]!).file).toEqual({ path: 'locales/fr_FR.json', action: 'created' });
    expect(out).toHaveLength(1);
  });

  it('value from stdin; a terminal stdin and an empty value are refused before any request', async () => {
    const piped = await run('k', 'en', '-', { write: false }, res(), undefined, async () => 'from a pipe\n');
    expect(piped.put.mock.calls[0]![1]).toMatchObject({ value: 'from a pipe' });
    await expect(runNoStdin('k', 'en', '-')).rejects.toMatchObject({ exitCode: EXIT.failed, message: expect.stringContaining('needs piped input') });
    await expect(runFailing(undefined, 'k', 'en', '')).rejects.toMatchObject({ exitCode: EXIT.failed, message: expect.stringContaining('empty value') });
  });

  it('a file lookup that throws after the 200 is a skipped io outcome, exit 0', async () => {
    await write('a/en.json', '{}');
    await write('b/en.json', '{}');
    const cfg = config([
      { pattern: 'a/{locale}.json', format: 'json', namespace: 'common' },
      { pattern: 'b/{locale}.json', format: 'json', namespace: 'common' },
    ]);
    const { code, out } = await run('k', 'en', 'v', { json: true }, res({ key: 'k' }), cfg);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!).file).toMatchObject({ path: null, action: 'skipped', reason: 'io' });
  });
});

describe('targetFile', () => {
  const ctx = {};

  it('prefers a file already on disk, whatever its format', () => {
    const xliff = { pattern: 'i18n/{locale}.xlf', format: 'xliff', namespace: 'common' } as never;
    const cfg = config([rule({ namespace: 'common' }), xliff]);
    const found = targetFile([{ path: 'i18n/en.xlf', locale: 'en', namespace: 'common', rule: xliff }], cfg, ctx, 'en', 'common');
    expect(found).toMatchObject({ path: 'i18n/en.xlf', exists: true });
  });

  it('else the first json rule, else any rule, else nothing', () => {
    const xliff = { pattern: 'i18n/{locale}.xlf', format: 'xliff', namespace: 'common' };
    expect(targetFile([], config([xliff, rule({ namespace: 'common' })]), ctx, 'en', 'common')).toMatchObject({ path: 'locales/en/common.json', exists: false });
    expect(targetFile([], config([xliff]), ctx, 'en', 'common')).toMatchObject({ path: 'i18n/en.xlf', exists: false });
    expect(targetFile([], config([xliff]), ctx, 'en', 'other')).toBeUndefined();
  });

  it('a wildcard rule does not cover a namespace a fixed rule claims', () => {
    const cfg = config([rule({ pattern: 'a/{locale}/{namespace}.json' }), rule({ pattern: 'b/{locale}.json', namespace: 'shop' })]);
    expect(targetFile([], cfg, ctx, 'en', 'shop')).toMatchObject({ path: 'b/en.json' });
    expect(targetFile([], cfg, ctx, 'en', 'misc')).toMatchObject({ path: 'a/en/misc.json' });
  });
});
