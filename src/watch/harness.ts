import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi, type Mock } from 'vitest';

import type { Config } from '../config.js';
import type { PushResponse } from '../commands/push.js';
import type { FileStat, SessionDeps, WatchOptions } from './session.js';
import { WatchSession } from './session.js';

/** Test-only: a project folder whose files exist on disk (for the glob) and whose stat / bytes the test controls. */
export interface Harness {
  session: WatchSession;
  out: string[];
  err: string[];
  get: Mock;
  post: Mock;
  read: Mock;
  stopping: { value: boolean };
  /** Create or rewrite a file; `mtimeMs` defaults to 0 (long settled). */
  put: (path: string, content: string, mtimeMs?: number) => Promise<void>;
  remove: (path: string) => Promise<void>;
  /** The manifest of the n-th push request. */
  manifest: (call: number) => Array<{ path: string; namespace: string; locale: string }>;
  flag: (call: number, name: string) => string | null;
}

export const counts = (over: Partial<PushResponse['locales'][string]> = {}): PushResponse['locales'][string] => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  skippedFilled: 0,
  unknownKeys: [],
  ...over,
});

export const answer = (over: Partial<PushResponse> = {}): PushResponse => ({
  dryRun: false,
  locales: { en: counts({ unchanged: 1 }) },
  orphans: [],
  pruned: 0,
  ...over,
});

export const harness = async (
  files: Record<string, string>,
  opts: Partial<WatchOptions> = {},
  config: Partial<Config> = {},
): Promise<Harness> => {
  const cwd: string = await mkdtemp(join(tmpdir(), 'tfy-watch-'));
  const disk: Map<string, { bytes: Uint8Array<ArrayBuffer>; mtimeMs: number }> = new Map();
  const put = async (path: string, content: string, mtimeMs: number = 0): Promise<void> => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
    disk.set(path, { bytes: new Uint8Array(Buffer.from(content)), mtimeMs });
  };
  const remove = async (path: string): Promise<void> => {
    await rm(join(cwd, path));
    disk.delete(path);
  };
  for (const [path, content] of Object.entries(files)) await put(path, content);

  const out: string[] = [];
  const err: string[] = [];
  const get: Mock = vi.fn().mockResolvedValue({ project: { defaultLocale: 'en' } });
  const post: Mock = vi.fn().mockResolvedValue(answer());
  const read: Mock = vi.fn(async (path: string) => {
    const file = disk.get(path);
    if (file === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

    return file.bytes;
  });
  const stopping = { value: false };
  const deps: SessionDeps = {
    cwd,
    config: {
      apiUrl: 'https://x/api',
      files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
      locales: {},
      ...config,
    },
    api: { get, post } as never,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    clock: () => new Date(2026, 10, 27, 12, 4, 31),
    stat: async (path: string): Promise<FileStat | undefined> => {
      const file = disk.get(path);

      return file === undefined ? undefined : { mtimeMs: file.mtimeMs, size: file.bytes.length };
    },
    read,
    stopping: () => stopping.value,
  };
  const session: WatchSession = new WatchSession({ debounceMs: 2000, ...opts }, deps, { defaultLocale: 'en', context: {} });
  const form = (call: number): FormData => post.mock.calls[call]![1] as FormData;

  return {
    session,
    out,
    err,
    get,
    post,
    read,
    stopping,
    put,
    remove,
    manifest: (call) => JSON.parse(form(call).get('manifest') as string),
    flag: (call, name) => form(call).get(name) as string | null,
  };
};
