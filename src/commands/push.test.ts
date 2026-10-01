import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError } from '../errors.js';
import { runPush, type PushResponse } from './push.js';


const counts = (over: Partial<PushResponse['locales'][string]> = {}): PushResponse['locales'][string] => ({
  created: 0,
  updated: 0,
  unchanged: 3,
  skippedFilled: 0,
  unknownKeys: [],
  ...over,
});

const response = (over: Partial<PushResponse> = {}): PushResponse => ({
  dryRun: true,
  locales: { en: counts({ created: 1 }) },
  orphans: [{ namespace: 'cart', key: 'old', published: false }],
  pruned: 0,
  ...over,
});

const setup = async (post = vi.fn().mockResolvedValue(response())) => {
  const cwd: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  await mkdir(join(cwd, 'locales/en'), { recursive: true });
  await writeFile(join(cwd, 'locales/en/cart.json'), '{"a":"A"}');
  const config: Config = {
    apiUrl: 'https://x/api',
    files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
    locales: {},
  };
  const get = vi.fn().mockResolvedValue({ project: { name: 'P', slug: 'p', defaultLocale: 'en' } });
  const out: string[] = [];
  const err: string[] = [];
  const confirm = vi.fn();

  return {
    cwd,
    post,
    get,
    out,
    err,
    confirm,
    deps: {
      cwd,
      config,
      api: { post, get } as never,
      isTty: false,
      confirm,
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
};

const formOf = (post: ReturnType<typeof vi.fn>, call: number): FormData => post.mock.calls[call]![1] as FormData;
const text = (lines: string[]): string => stripVTControlCharacters(lines.join('\n'));

describe('runPush', () => {
  it('refuses more than 500 files before any request', async () => {
    const { deps, post, cwd } = await setup();
    await Promise.all(
      Array.from({ length: 500 }, async (_v, i) => writeFile(join(cwd, `locales/en/n${i}.json`), '{"a":"A"}')),
    );
    const error = (await runPush({}, deps).catch((caught: unknown) => caught)) as CliError;

    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe('Too many files (501 > 500): split the push with --namespace.');
    expect(post).not.toHaveBeenCalled();
  });

  it('sends one multipart request with a file<N> field per file and a manifest mapping to it', async () => {
    const { deps, post } = await setup();
    const code = await runPush({}, deps);

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe('/cli/v1/push');
    const form: FormData = formOf(post, 0);
    expect(JSON.parse(String(form.get('manifest')))).toEqual([
      { field: 'file0', path: 'locales/en/cart.json', format: 'json', locale: 'en', namespace: 'cart' },
    ]);
    expect(await (form.get('file0') as File).text()).toBe('{"a":"A"}');
    expect(form.get('dryRun')).toBe('false');
    expect(form.get('prune')).toBe('false');
    expect(form.get('overwriteTargets')).toBe('false');
  });

  it('gives files that share a basename distinct fields, and the manifest maps each to its own', async () => {
    const { deps, post, cwd } = await setup();
    await mkdir(join(cwd, 'locales/it'), { recursive: true });
    await writeFile(join(cwd, 'locales/it/cart.json'), '{"a":"Ai"}');
    await runPush({}, deps);

    const form: FormData = formOf(post, 0);
    const manifest: Array<{ field: string; path: string; locale: string }> = JSON.parse(String(form.get('manifest')));
    expect(manifest.map((item) => item.field)).toEqual(['file0', 'file1']);
    for (const item of manifest) {
      const body: string = await (form.get(item.field) as File).text();
      expect(body).toBe(item.locale === 'en' ? '{"a":"A"}' : '{"a":"Ai"}');
    }
    expect(form.getAll('files')).toEqual([]);
  });

  it('a plain push makes no dry-run round trip and never asks', async () => {
    const { deps, post, confirm, get } = await setup(vi.fn().mockResolvedValue(response({ dryRun: false })));
    await runPush({}, { ...deps, isTty: true });

    expect(post).toHaveBeenCalledTimes(1);
    expect(formOf(post, 0).get('dryRun')).toBe('false');
    expect(confirm).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('--dry-run sends one dry run and stops, even with --prune', async () => {
    const { deps, post, confirm } = await setup();
    const code = await runPush({ dryRun: true, prune: true }, { ...deps, isTty: true });

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(formOf(post, 0).get('dryRun')).toBe('true');
    expect(formOf(post, 0).get('prune')).toBe('true');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('--prune without a TTY and without --yes exits 1 after a dry run, writing nothing', async () => {
    const { deps, post, out, err } = await setup();
    const code = await runPush({ prune: true }, deps);

    expect(code).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(formOf(post, 0).get('dryRun')).toBe('true');
    expect(text(out)).toContain('cart:old');
    expect(text(err)).toMatch(/--yes/);
  });

  it('--prune --yes without a TTY runs the dry run, then the real push', async () => {
    const { deps, post, confirm } = await setup();
    const code = await runPush({ prune: true, yes: true }, deps);

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(formOf(post, 0).get('dryRun')).toBe('true');
    expect(formOf(post, 1).get('prune')).toBe('true');
    expect(formOf(post, 1).get('dryRun')).toBe('false');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('--prune on a TTY asks, and stops on no', async () => {
    const { deps, post, confirm } = await setup();
    confirm.mockResolvedValue(false);
    const code = await runPush({ prune: true }, { ...deps, isTty: true });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/delete 1 key/i));
    expect(code).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('--prune on a TTY asks, and pushes on yes', async () => {
    const { deps, post, confirm } = await setup();
    confirm.mockResolvedValue(true);
    const code = await runPush({ prune: true }, { ...deps, isTty: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(formOf(post, 1).get('dryRun')).toBe('false');
  });

  it('--prune --yes on a TTY does not ask', async () => {
    const { deps, post, confirm } = await setup();
    const code = await runPush({ prune: true, yes: true }, { ...deps, isTty: true });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('--prune with zero orphans proceeds to the real push without asking (F19)', async () => {
    const { deps, post, confirm } = await setup(vi.fn().mockResolvedValue(response({ orphans: [] })));
    const code = await runPush({ prune: true }, deps);

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(formOf(post, 1).get('dryRun')).toBe('false');
    expect(formOf(post, 1).get('prune')).toBe('true');
  });

  it('--prune sends the confirmed unpublished orphans as pruneKeys, and no prune list on the dry run', async () => {
    const preview: PushResponse = response({
      orphans: [
        { namespace: 'cart', key: 'old', published: false },
        { namespace: 'cart', key: 'live', published: true },
        { namespace: 'home', key: 'gone', published: false },
      ],
    });
    const { deps, post } = await setup(vi.fn().mockResolvedValue(preview));
    await runPush({ prune: true, yes: true }, deps);

    expect(formOf(post, 0).get('pruneKeys')).toBeNull();
    expect(JSON.parse(String(formOf(post, 1).get('pruneKeys')))).toEqual(['cart:old', 'home:gone']);
  });

  it('--prune with zero orphans sends an empty pruneKeys list', async () => {
    const { deps, post } = await setup(vi.fn().mockResolvedValue(response({ orphans: [] })));
    await runPush({ prune: true }, deps);

    expect(formOf(post, 1).get('pruneKeys')).toBe('[]');
  });

  it('without --prune, pruneKeys is never sent', async () => {
    const { deps, post } = await setup();
    await runPush({ overwriteTargets: true, yes: true }, deps);

    expect(formOf(post, 1).get('pruneKeys')).toBeNull();
  });

  it('reports orphans that appeared since the dry run as kept', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(
        response({
          dryRun: false,
          pruned: 1,
          orphans: [
            { namespace: 'cart', key: 'old', published: false },
            { namespace: 'cart', key: 'fresh', published: false },
          ],
        }),
      );
    const { deps, err } = await setup(post);
    await runPush({ prune: true, yes: true }, deps);

    expect(text(err)).toContain('1 new orphan(s) appeared since the dry run and were kept: cart:fresh');
    expect(text(err)).not.toContain('cart:old');
  });

  it('prints no new-orphan message when the real push lists only confirmed orphans', async () => {
    const { deps, err } = await setup();
    await runPush({ prune: true, yes: true }, deps);

    expect(text(err)).not.toContain('appeared since the dry run');
  });

  it('--overwrite-targets counts only target-locale updates, and asks', async () => {
    const preview: PushResponse = response({
      orphans: [],
      locales: { en: counts({ updated: 5 }), it: counts({ updated: 2 }), de: counts({ updated: 1 }) },
    });
    const { deps, post, confirm, get } = await setup(vi.fn().mockResolvedValue(preview));
    confirm.mockResolvedValue(false);
    const code = await runPush({ overwriteTargets: true }, { ...deps, isTty: true });

    expect(get).toHaveBeenCalledWith('/cli/v1/whoami');
    expect(formOf(post, 0).get('overwriteTargets')).toBe('true');
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/overwrite 3 existing translation/i));
    expect(code).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('--overwrite-targets counts every locale when the project has no default locale', async () => {
    const preview: PushResponse = response({ orphans: [], locales: { en: counts({ updated: 5 }), it: counts({ updated: 2 }) } });
    const { deps, confirm, get } = await setup(vi.fn().mockResolvedValue(preview));
    get.mockResolvedValue({ project: { name: 'P', slug: 'p', defaultLocale: null } });
    confirm.mockResolvedValue(false);
    await runPush({ overwriteTargets: true }, { ...deps, isTty: true });

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/overwrite 7 existing translation/i));
  });

  it('--overwrite-targets with zero affected cells proceeds without asking (F19)', async () => {
    const preview: PushResponse = response({ orphans: [], locales: { en: counts({ updated: 5 }), it: counts() } });
    const { deps, post, confirm } = await setup(vi.fn().mockResolvedValue(preview));
    const code = await runPush({ overwriteTargets: true }, deps);

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(formOf(post, 1).get('overwriteTargets')).toBe('true');
    expect(formOf(post, 1).get('dryRun')).toBe('false');
  });

  it('--prune with published orphans surfaces the 409 from the dry run, without a prompt', async () => {
    const refusal = new CliError(1, 'Published keys would be pruned: cart:old. Unpublish them first, or drop --prune.');
    const { deps, post, confirm } = await setup(vi.fn().mockRejectedValue(refusal));

    await expect(runPush({ prune: true }, { ...deps, isTty: true })).rejects.toBe(refusal);
    expect(post).toHaveBeenCalledTimes(1);
    expect(formOf(post, 0).get('dryRun')).toBe('true');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('--namespace limits the files', async () => {
    const { deps, post, cwd } = await setup();
    await writeFile(join(cwd, 'locales/en/other.json'), '{"b":"B"}');
    await runPush({ namespace: 'cart' }, deps);

    const manifest: Array<{ namespace: string }> = JSON.parse(String(formOf(post, 0).get('manifest')));
    expect(manifest.map((item) => item.namespace)).toEqual(['cart']);
    expect(formOf(post, 0).get('file1')).toBeNull();
  });

  it('exits 1 with a hint when no files match', async () => {
    const { deps, post, err } = await setup();
    const code = await runPush({ namespace: 'nothing' }, deps);

    expect(code).toBe(1);
    expect(post).not.toHaveBeenCalled();
    expect(text(err)).toMatch(/namespace "nothing"/);
  });

  it('--json prints one JSON document with the raw response and a summary', async () => {
    const real: PushResponse = response({ dryRun: false, orphans: [] });
    const { deps, out } = await setup(vi.fn().mockResolvedValue(real));
    await runPush({ json: true }, deps);

    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!);
    expect(doc.response).toEqual(real);
    expect(doc.summary).toMatchObject({ dryRun: false, created: 1, unchanged: 3, orphans: 0, pruned: 0 });
    expect(out[0]).not.toMatch(/sk_|authorization/i);
  });

  it('--json with --prune --yes keeps stdout one JSON document, carrying the preview too', async () => {
    const real: PushResponse = response({ dryRun: false, orphans: [], pruned: 1 });
    const post = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(real);
    const { deps, out } = await setup(post);
    await runPush({ json: true, prune: true, yes: true }, deps);

    expect(out).toHaveLength(1);
    const doc = JSON.parse(out[0]!);
    expect(doc.preview).toEqual(response());
    expect(doc.response).toEqual(real);
    expect(doc.summary.pruned).toBe(1);
  });
});
