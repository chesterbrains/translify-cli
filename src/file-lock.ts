import { createHash } from 'node:crypto';
import { rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { realTarget } from './file-write.js';

export interface LockOptions {
  /** How long to wait for another process before giving up. */
  waitMs: number;
  /** A lock older than this was left by a process that died; it is taken over. Shorter than `waitMs`, so a waiter outlasts it. */
  staleMs: number;
}

export const LOCK_DEFAULTS: LockOptions = { waitMs: 10_000, staleMs: 5_000 };

/** Returned instead of the callback's value when the lock could not be had in time. */
export const BUSY: unique symbol = Symbol('busy');

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * The lock for a file lives in the OS temp folder, named by a hash of the file's real path: nothing is ever
 * created in the working tree. A file that does not exist yet is named through its (real) folder.
 */
export async function lockPathFor(path: string): Promise<string> {
  const absolute: string = resolve(path);
  let real: string = await realTarget(absolute);
  if (real === absolute) real = join(await realTarget(dirname(absolute)), basename(absolute));

  return join(tmpdir(), `translify-${createHash('sha256').update(real).digest('hex').slice(0, 32)}.lock`);
}

/**
 * Run `fn` while holding the lock of `path`, so two processes never read-modify-write the same file at once.
 * Keep `fn` short (no network): the lock is a plain file created with `wx`, and one older than `staleMs` is
 * treated as abandoned.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: LockOptions = LOCK_DEFAULTS): Promise<T | typeof BUSY> {
  const lock: string = await lockPathFor(path);
  const deadline: number = Date.now() + options.waitMs;

  for (;;) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }

    try {
      if (Date.now() - (await stat(lock)).mtimeMs > options.staleMs) {
        await rm(lock, { force: true });
        continue;
      }
    } catch (error) {
      // Released between the failed create and the stat: try again at once.
      if (code(error) === 'ENOENT') continue;
      throw error;
    }

    if (Date.now() >= deadline) return BUSY;
    await sleep(10 + Math.floor(Math.random() * 30));
  }

  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}
