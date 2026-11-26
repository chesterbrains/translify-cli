import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { lockPathFor } from '../file-lock.js';
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


describe('runSet', () => {
  it('a local read/write failure after the server accepted: exit 0, a skipped io outcome', async () => {
    await mkdir(join(dir, 'locales/en/common.json'), { recursive: true });
    const { code, out } = await run('promo.title', 'en', 'Hello', {}, res());
    expect(code).toBe(EXIT.ok);
    expect(out.at(-1)).toMatch(/^Could not write locales\/en\/common\.json:/);
    const json = await run('promo.title', 'en', 'Hello', { json: true }, res());
    expect(json.code).toBe(EXIT.ok);
    expect(JSON.parse(json.out[0]!).file).toEqual({ path: 'locales/en/common.json', action: 'skipped', reason: 'io' });
  });

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

  const TAIL = 'Nothing was sent to Translify and nothing was written.';
  const BROKEN: [string, string, string, string][] = [
    ['a broken file', '{ "a": ', 'invalid', `locales/en/common.json is not valid JSON. ${TAIL} Fix the file or run \`translify pull\`, or pass --no-write to update Translify only.`],
    [
      'a blocked path',
      '{\n  "promo": "text"\n}\n',
      'blocked',
      `locales/en/common.json holds a value at "promo", and a nested JSON file cannot keep "promo.title" beside it. ${TAIL} Set "jsonStyle": "flat" on this files rule to keep both, or pass --no-write to update Translify only.`,
    ],
    [
      'an ambiguous path',
      '{"promo":{"a":"1"},"promo":{"b":"2"}}',
      'ambiguous',
      `locales/en/common.json has "promo" more than once. ${TAIL} Fix the file, or pass --no-write to update Translify only.`,
    ],
  ];

  it.each(BROKEN)('%s is refused before the request: nothing sent, file untouched, exit 1, --json names the reason', async (_name, text, reason, line) => {
    await write('locales/en/common.json', text);
    const put = vi.fn();
    const out: string[] = [];
    const deps: SetDeps = { cwd: dir, config: config(), api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined };
    const error = await runSet('promo.title', 'en', 'Hi', { json: true }, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT.failed);
    expect((error as CliError).message).toBe(`${line} If "promo.title" belongs to another namespace, name it with --namespace.`);
    expect(out).toEqual([JSON.stringify({ response: null, file: { path: 'locales/en/common.json', action: 'skipped', reason } })]);
    expect(put).not.toHaveBeenCalled();
    expect(await read('locales/en/common.json')).toBe(text);
  });

  it('the check covers both directions and a known namespace; a flat rule holds both keys', async () => {
    const pinned = config([rule({ namespace: 'common' })]);
    await write('locales/en/common.json', '{\n  "promo": {\n    "title": "x"\n  }\n}\n');
    const put = vi.fn();
    const out: string[] = [];
    const deps: SetDeps = { cwd: dir, config: pinned, api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined };
    const error = await runSet('promo', 'en', 'Hi', {}, deps).catch((e: unknown) => e);
    // The namespace is known, so no --namespace hint; without --json nothing goes to stdout.
    expect((error as CliError).message).toBe(
      'locales/en/common.json has "promo" as something other than a text entry (usually an object holding other keys), and a nested JSON file cannot also keep "promo" as a key. Nothing was sent to Translify and nothing was written. Set "jsonStyle": "flat" on this files rule to keep both, or pass --no-write to update Translify only.',
    );
    expect(out).toEqual([]);
    expect(put).not.toHaveBeenCalled();

    const flat = config([rule({ jsonStyle: 'flat' })]);
    await write('locales/en/common.json', '{\n  "promo": "text"\n}\n');
    const ok = await run('promo.title', 'en', 'Hi', {}, res(), flat);
    expect(ok.code).toBe(EXIT.ok);
    expect(JSON.parse(await read('locales/en/common.json'))).toEqual({ promo: 'text', 'promo.title': 'Hi' });
  });

  it('--no-write skips the check', async () => {
    await write('locales/en/common.json', '{"promo":"x"}');
    const { code, put } = await run('promo.title', 'en', 'Hi', { write: false }, res());
    expect(code).toBe(EXIT.ok);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a namespace only the server can name, with several files for the locale, is not checked: the write stands, exit 0', async () => {
    await write('locales/en/common.json', '{"promo":"x"}');
    await write('locales/en/other.json', '{}');
    const { code, out, put } = await run('promo.title', 'en', 'Hi', {}, res());
    expect(code).toBe(EXIT.ok);
    expect(put).toHaveBeenCalledTimes(1);
    expect(out.at(-1)).toBe(
      'locales/en/common.json holds a value at "promo", and a nested JSON file cannot keep "promo.title" beside it; nothing written locally. Set "jsonStyle": "flat" on this files rule to keep both.',
    );
    const json = await run('promo.title', 'en', 'Hi', { json: true }, res());
    expect(JSON.parse(json.out[0]!).file).toEqual({ path: 'locales/en/common.json', action: 'skipped', reason: 'blocked' });
  });

  it.each(BROKEN)('%s that appears between the check and the write: the server write stands, exit 0', async (_name, text, reason) => {
    await write('locales/en/common.json', '{}\n');
    const put = vi.fn().mockImplementation(async () => {
      await write('locales/en/common.json', text);

      return res();
    });
    const out: string[] = [];
    const deps: SetDeps = { cwd: dir, config: config(), api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined };
    expect(await runSet('promo.title', 'en', 'Hi', { json: true }, deps)).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!).file).toEqual({ path: 'locales/en/common.json', action: 'skipped', reason });
    expect(await read('locales/en/common.json')).toBe(text);
  });

  it('many set commands at once on one file keep every entry', async () => {
    await write('locales/en/common.json', '{\n  "a": "1"\n}\n');
    const keys = Array.from({ length: 25 }, (_, index) => `k${String(index).padStart(2, '0')}.title`);
    const codes = await Promise.all(keys.map(async (key) => (await run(key, 'en', key, {}, res({ key }))).code));
    expect(codes.every((code) => code === EXIT.ok)).toBe(true);
    const file = JSON.parse(await read('locales/en/common.json')) as Record<string, { title: string } | string>;
    expect(Object.keys(file).sort()).toEqual(['a', ...keys.map((key) => key.split('.')[0]!)].sort());
    expect(await readdir(join(dir, 'locales/en'))).toEqual(['common.json']);
  });

  it('a file another process holds past the wait: the server write stands, a skipped busy outcome, exit 0', async () => {
    await write('locales/en/common.json', '{}\n');
    const lock = await lockPathFor(join(dir, 'locales/en/common.json'));
    await writeFile(lock, 'other\n');
    try {
      const out: string[] = [];
      const put = vi.fn().mockResolvedValue(res());
      const deps: SetDeps = { cwd: dir, config: config(), api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined, lock: { waitMs: 50, staleMs: 60_000 } };
      expect(await runSet('promo.title', 'en', 'Hi', {}, deps)).toBe(EXIT.ok);
      expect(out.at(-1)).toBe('locales/en/common.json is being written by another translify process; nothing written locally. Run `translify pull` to sync the file.');
      expect(await runSet('promo.title', 'en', 'Hi', { json: true }, deps)).toBe(EXIT.ok);
      expect(JSON.parse(out.at(-1)!).file).toEqual({ path: 'locales/en/common.json', action: 'skipped', reason: 'busy' });
      expect(await read('locales/en/common.json')).toBe('{}\n');
    } finally {
      await rm(lock, { force: true });
    }
  });

  it('a file that cannot be read is refused before the request: nothing sent, exit 1, --json reason io', async () => {
    await mkdir(join(dir, 'locales/en/common.json'), { recursive: true });
    const put = vi.fn();
    const out: string[] = [];
    // The namespace is pinned, so the file is known although nothing on disk matches as a file.
    const deps: SetDeps = { cwd: dir, config: config([rule({ namespace: 'common' })]), api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined };
    const error = await runSet('promo.title', 'en', 'Hi', { json: true }, deps).catch((e: unknown) => e);
    expect((error as CliError).exitCode).toBe(EXIT.failed);
    expect((error as CliError).message).toMatch(/^Could not read locales\/en\/common\.json: .*Nothing was sent to Translify and nothing was written\. Fix the file, or pass --no-write to update Translify only\.$/);
    expect(out).toEqual([JSON.stringify({ response: null, file: { path: 'locales/en/common.json', action: 'skipped', reason: 'io' } })]);
    expect(put).not.toHaveBeenCalled();
  });

  describe('a rule that needs whoami (Android)', () => {
    const android = config([rule(), { pattern: 'app/values-{locale}/strings.xml', format: 'android' }]);
    const deps = (get: ReturnType<typeof vi.fn>, put: ReturnType<typeof vi.fn>, err: string[]): SetDeps => ({
      cwd: dir,
      config: android,
      api: { put, get } as never,
      out: () => undefined,
      err: (l) => err.push(l),
      readStdin: undefined,
    });

    it('asks whoami once for the check and the patch together', async () => {
      await write('locales/en/common.json', '{}\n');
      const get = vi.fn().mockResolvedValue({ project: { defaultLocale: 'en' }, locales: ['en'] });
      const put = vi.fn().mockResolvedValue(res());
      const err: string[] = [];
      expect(await runSet('promo.title', 'en', 'Hi', {}, deps(get, put, err))).toBe(EXIT.ok);
      expect(get).toHaveBeenCalledTimes(1);
      expect(err).toEqual([]);
      expect(JSON.parse(await read('locales/en/common.json'))).toEqual({ promo: { title: 'Hi' } });
    });

    it('a lookup that fails says the file was not checked, and the write goes ahead', async () => {
      await write('locales/en/common.json', '{"promo":"x"}');
      const get = vi.fn().mockRejectedValue(new Error('whoami down'));
      const put = vi.fn().mockResolvedValue(res());
      const err: string[] = [];
      expect(await runSet('promo.title', 'en', 'Hi', {}, deps(get, put, err))).toBe(EXIT.ok);
      expect(err).toEqual(['Could not check the local file before sending (whoami down); continuing without the check.']);
      expect(put).toHaveBeenCalledTimes(1);
      expect(await read('locales/en/common.json')).toBe('{"promo":"x"}');
    });
  });

  it('a set that lost its lock while patching (it was stalled) writes nothing and reports busy', async () => {
    await write('locales/en/common.json', '{}\n');
    const out: string[] = [];
    const put = vi.fn().mockResolvedValue(res());
    // The lock ran the patch, but a waiter took the lock over meanwhile: held() answers false.
    const withLock = (async (_path: string, fn: (held: () => Promise<boolean>) => Promise<unknown>) => fn(async () => false)) as never;
    const deps: SetDeps = { cwd: dir, config: config(), api: { put, get: vi.fn() } as never, out: (l) => out.push(l), err: () => undefined, readStdin: undefined, withLock };
    expect(await runSet('promo.title', 'en', 'Hi', { json: true }, deps)).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!).file).toEqual({ path: 'locales/en/common.json', action: 'skipped', reason: 'busy' });
    expect(await read('locales/en/common.json')).toBe('{}\n');
  });

  it('a file that is mid-write by another set (broken for a moment) is looked at again, not refused', async () => {
    await write('locales/en/common.json', '{ "a": ');
    setTimeout(() => void write('locales/en/common.json', '{}\n'), 15);
    const { code, out, put } = await run('promo.title', 'en', 'Hi', {}, res());
    expect(code).toBe(EXIT.ok);
    expect(put).toHaveBeenCalledTimes(1);
    expect(out.at(-1)).toBe('Updated locales/en/common.json.');
  });

  it('a locale typed in another case than the files on disk patches the existing file', async () => {
    await write('locales/pt-BR/common.json', '{}\n');
    const { out } = await run('promo.title', 'pt-br', 'Oi', {}, res({ locale: 'pt-BR' }));
    expect(out.at(-1)).toBe('Updated locales/pt-BR/common.json.');
    expect(await readdir(join(dir, 'locales'))).toEqual(['pt-BR']);
  });

  it('a server that spells the locale in another case still gets its file patched; a file named with leading dots is inside the project', async () => {
    const cfg = config([rule({ pattern: '..locales/{locale}/{namespace}.json' })]);
    await write('..locales/pt-BR/common.json', '{}\n');
    const { code, out } = await run('promo.title', 'pt-BR', 'Oi', {}, res({ locale: 'pt-br' }), cfg);
    expect(code).toBe(EXIT.ok);
    expect(out.at(-1)).toBe('Updated ..locales/pt-BR/common.json.');
    expect(JSON.parse(await read('..locales/pt-BR/common.json'))).toEqual({ promo: { title: 'Oi' } });
  });

  it('a response path that resolves outside the project is refused: no read, no write', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'translify-outer-'));
    const inner = join(parent, 'project');
    await mkdir(inner);
    const put = vi.fn().mockResolvedValue(res({ namespace: '../../evil' }));
    const out: string[] = [];
    try {
      const code = await runSet('promo.title', 'en', 'Hi', { json: false }, {
        cwd: inner,
        config: config([rule({ pattern: '{namespace}/{locale}.json' })]),
        api: { put, get: vi.fn() } as never,
        out: (l) => out.push(l),
        err: () => undefined,
        readStdin: undefined,
      });
      expect(code).toBe(EXIT.ok);
      expect(out.at(-1)).toBe('Refusing to write ../../evil/en.json: it resolves outside the project directory.');
      expect(await readdir(parent)).toEqual(['project']);
      expect(await readdir(inner)).toEqual([]);

      out.length = 0;
      await runSet('promo.title', 'en', 'Hi', { json: true }, {
        cwd: inner,
        config: config([rule({ pattern: '{namespace}/{locale}.json' })]),
        api: { put, get: vi.fn() } as never,
        out: (l) => out.push(l),
        err: () => undefined,
        readStdin: undefined,
      });
      expect(JSON.parse(out[0]!).file).toEqual({ path: null, action: 'skipped', reason: 'outside' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('a response for another locale or namespace than asked touches nothing', async () => {
    const wrongLocale = await run('promo.title', 'en', 'Hi', {}, res({ locale: 'de' }));
    expect(wrongLocale.out.at(-1)).toBe('The server answered for de/common, not what was asked; nothing written locally.');
    const wrongNamespace = await run('promo.title', 'en', 'Hi', { namespace: 'shop', json: true }, res({ namespace: 'common' }));
    expect(JSON.parse(wrongNamespace.out[0]!).file).toEqual({ path: null, action: 'skipped', reason: 'mismatch' });
    await expect(read('locales/de/common.json')).rejects.toThrow();
    await expect(read('locales/en/common.json')).rejects.toThrow();
  });

  it('a plural issue lists its categories', async () => {
    const { out } = await run(
      'k',
      'ru',
      'v',
      { write: false },
      res({ locale: 'ru', issues: [{ code: 'PLURAL_MISSING', severity: 'WARNING', categories: ['few', 'many'] }] }),
    );
    expect(out).toContain('warning: placeholder warning: PLURAL_MISSING few, many');
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
    const refusedPut = vi.fn();
    const refuse = (value: string) =>
      runSet('k', 'en', value, {}, { cwd: dir, config: config(), api: { put: refusedPut, get: vi.fn() } as never, out: () => undefined, err: () => undefined, readStdin: undefined });
    await expect(refuse('-')).rejects.toMatchObject({ exitCode: EXIT.failed, message: expect.stringContaining('needs piped input') });
    await expect(refuse('')).rejects.toMatchObject({ exitCode: EXIT.failed, message: expect.stringContaining('empty value') });
    expect(refusedPut).not.toHaveBeenCalled();
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
