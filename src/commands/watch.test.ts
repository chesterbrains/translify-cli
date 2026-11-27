import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { answer } from '../watch/harness.js';
import { runWatch, tickDelay, watchRefusal, type WatchDeps } from './watch.js';

const setup = async (files: Record<string, string> = { 'locales/en/cart.json': '{"a":"A"}' }) => {
  const cwd: string = await mkdtemp(join(tmpdir(), 'tfy-run-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  const config: Config = {
    apiUrl: 'https://x/api',
    files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
    locales: {},
  };
  const out: string[] = [];
  const err: string[] = [];
  const get = vi.fn().mockResolvedValue({ project: { defaultLocale: 'en' }, locales: ['en', 'it'] });
  const post = vi.fn().mockResolvedValue(answer());
  /** Each sleep the loop asked for, with the handle to end it. */
  const sleeps: Array<{ ms: number; wake: () => void }> = [];
  let signal: (() => void) | undefined;
  const removed = vi.fn();
  const exit = vi.fn();
  let now: number = 1_000_000;
  /** What every file reads as; a test swaps it to fake a save. */
  const file = { text: '{"a":"A"}', mtimeMs: 0 };
  const deps: WatchDeps = {
    cwd,
    config,
    api: { get, post } as never,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    clock: () => new Date(2026, 10, 27, 12, 4, 31),
    stat: async () => ({ mtimeMs: file.mtimeMs, size: file.text.length }),
    read: async () => new Uint8Array(Buffer.from(file.text)),
    now: () => (now += 500),
    sleep: (ms: number) => {
      let wake: () => void = () => undefined;
      const done: Promise<void> = new Promise((resolve) => {
        wake = resolve;
      });
      sleeps.push({ ms, wake });

      return { done, wake };
    },
    onSignal: (handler: () => void) => {
      signal = handler;

      return removed;
    },
    exit,
  };
  /** Lets the loop run until it is parked in its next sleep. */
  const parked = async (count: number): Promise<void> => {
    await vi.waitFor(() => expect(sleeps.length).toBe(count));
  };

  return { deps, file, out, err, get, post, sleeps, removed, exit, parked, signal: () => signal!() };
};

describe('watchRefusal', () => {
  it.each([
    [{ prune: true }, '--prune'],
    [{ overwriteTargets: true }, '--overwrite-targets'],
    [{ dryRun: true }, '--dry-run'],
    [{ json: true }, '--json'],
  ])('--watch with %j is refused', (flags, name) => {
    expect(watchRefusal({ watch: true, ...flags })).toContain(`--watch cannot be combined with ${name}`);
  });

  it('--debounce needs --watch, a whole number and at least 500', () => {
    expect(watchRefusal({ debounce: '1000' })).toBe('--debounce needs --watch.');
    for (const bad of ['499', 'abc', '1.5', '', '-1']) {
      expect(watchRefusal({ watch: true, debounce: bad }), bad).toBe('--debounce must be a whole number of milliseconds, at least 500.');
    }
    expect(watchRefusal({ watch: true, debounce: '500' })).toBeUndefined();
    expect(watchRefusal({ watch: true })).toBeUndefined();
  });
});

describe('tickDelay', () => {
  it('is 500 ms after a fast scan and ten times the scan after a slow one', () => {
    expect(tickDelay(20)).toBe(500);
    expect(tickDelay(120)).toBe(1200);
  });
});

describe('runWatch', () => {
  it('a refused flag combination sends nothing and exits 1', async () => {
    const h = await setup();

    expect(await runWatch({ watch: true, prune: true }, h.deps)).toBe(EXIT.failed);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.err[0]).toContain('--watch cannot be combined with --prune');
  });

  it('a project without a default locale is refused', async () => {
    const h = await setup();
    h.get.mockResolvedValue({ project: { defaultLocale: null } });

    expect(await runWatch({ watch: true }, h.deps)).toBe(EXIT.failed);
    expect(h.err).toEqual(['This project has no default locale; set one in Translify, then run translify push --watch again.']);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('no source file at start exits 1 naming the source locale and the namespace filter', async () => {
    const h = await setup({ 'locales/it/cart.json': '{}' });

    expect(await runWatch({ watch: true }, h.deps)).toBe(EXIT.failed);
    expect(h.err).toEqual(['No files matched the translify.json patterns for the source locale en.']);

    const filtered = await setup();
    expect(await runWatch({ watch: true, namespace: 'nav' }, filtered.deps)).toBe(EXIT.failed);
    expect(filtered.err).toEqual(['No files matched the translify.json patterns for the source locale en for namespace "nav".']);
  });

  it('a whoami failure at start is the plain CLI error', async () => {
    const h = await setup();
    h.get.mockRejectedValue(new CliError(EXIT.auth, 'This key was revoked.', {}, 401));

    await expect(runWatch({ watch: true }, h.deps)).rejects.toThrow('This key was revoked.');
  });

  it('prints the watching line, pushes at start, then polls after each sleep; the first signal ends it with 0', async () => {
    const h = await setup({ 'locales/en/cart.json': '{"a":"A"}', 'locales/en/nav.json': '{}', 'locales/it/cart.json': '{}' });
    const running = runWatch({ watch: true }, h.deps);

    await h.parked(1);
    expect(h.out).toEqual([
      'Watching 2 source file(s) (en) in 2 namespace(s). Ctrl-C to stop.',
      '12:04:31 pushed 2 namespace(s): 0 created, 0 updated, 2 unchanged',
    ]);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.sleeps[0]!.ms).toBe(500);

    h.sleeps[0]!.wake();
    await h.parked(2);
    h.sleeps[1]!.wake();
    await h.parked(3);

    h.signal();
    expect(await running).toBe(EXIT.ok);
    expect(h.removed).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('a signal during a push lets it finish, sends nothing more, and exits 0', async () => {
    const h = await setup({ 'locales/en/cart.json': '{"a":"A"}', 'locales/en/nav.json': '{}' });
    let release: (value: unknown) => void = () => undefined;
    h.post.mockImplementationOnce(async () => new Promise((resolve) => (release = resolve)));
    const running = runWatch({ watch: true }, h.deps);
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));

    h.signal();
    release(answer());

    expect(await running).toBe(EXIT.ok);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('the second signal exits 130 at once', async () => {
    const h = await setup();
    h.post.mockImplementationOnce(async () => new Promise(() => undefined));
    void runWatch({ watch: true }, h.deps);
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));

    h.signal();
    expect(h.exit).not.toHaveBeenCalled();
    h.signal();
    expect(h.exit).toHaveBeenCalledWith(130);
  });

  it('a tick that returns an exit code ends the watch with it', async () => {
    const h = await setup();
    h.post.mockRejectedValue(new CliError(EXIT.auth, 'This key was revoked.', { code: 'KEY_REVOKED' }, 401));

    expect(await runWatch({ watch: true }, h.deps)).toBe(EXIT.auth);
    expect(h.removed).toHaveBeenCalledTimes(1);
  });

  it('--debounce reaches the session', async () => {
    const h = await setup();
    const running = runWatch({ watch: true, debounce: '60000' }, h.deps);
    await h.parked(1);
    // A change now would wait a minute: nothing but the start push goes out over the next polls.
    h.file.text = '{"a":"B"}';
    h.file.mtimeMs = 5;
    h.sleeps[0]!.wake();
    await h.parked(2);
    h.sleeps[1]!.wake();
    await h.parked(3);
    expect(h.post).toHaveBeenCalledTimes(1);

    h.signal();
    await running;
  });
});
