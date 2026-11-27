import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface LockOptions {
  /** How long to wait for another process before giving up. */
  waitMs: number;
  /** A lock older than this was left by a process that died; it is taken over. Shorter than `waitMs`, so a waiter outlasts it. */
  staleMs: number;
}

export const LOCK_DEFAULTS: LockOptions = { waitMs: 10_000, staleMs: 5_000 };

/** Returned instead of the callback's value when the lock could not be had in time. */
export const BUSY: unique symbol = Symbol('busy');

/** Asks whether this process still owns the lock: false once a waiter took it over because the holder was too slow. */
export type StillHeld = () => Promise<boolean>;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Windows keeps the name of a deleted file until every handle on it is closed; creating or reading it meanwhile
 * fails with one of these instead of EEXIST / ENOENT. There they mean "held, try again".
 */
const WINDOWS_PENDING: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pending = (error: unknown, platform: string): boolean => platform === 'win32' && WINDOWS_PENDING.has(code(error) ?? '');

/** `realpath` of the nearest folder that exists, plus the segments below it: stable before and after the folders are created. */
async function realOrNearest(path: string): Promise<string> {
  const rest: string[] = [];
  let current: string = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (error) {
      const parent: string = dirname(current);
      if (code(error) !== 'ENOENT' || parent === current) throw error;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * This user's own folder of locks inside the OS temp folder (`translify-<uid>`, mode 0700). On a temp folder
 * shared by several users nobody else can then leave a lock that this user cannot remove, or create one in
 * advance under a name that is easy to guess. Windows has no uid and gives every user their own temp folder.
 * A folder of that name that is not a plain directory of this user is never trusted: someone else got there first
 * (or the temp folder is unusable), and the locks go to this user's cache folder instead. Every process of the user
 * meets the same obstacle and so lands in the same place.
 */
export async function lockFolder(
  base: string = tmpdir(),
  uid: number | null = process.getuid?.() ?? null,
  fallback: string = cacheLockFolder(),
): Promise<string> {
  try {
    return await ownFolder(join(base, `translify-${uid ?? 'locks'}`), uid);
  } catch {
    return ownFolder(fallback, uid);
  }
}

/** `~/.cache/translify/locks` (XDG), `%LOCALAPPDATA%\\translify\\locks` on Windows. */
export function cacheLockFolder(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string {
  // An empty or relative value would resolve against the cwd (often a repo); ignore it, as the XDG spec says.
  const absolute = (value: string | undefined): string | undefined => (value !== undefined && isAbsolute(value) ? value : undefined);
  const local: string | undefined = absolute(env.LOCALAPPDATA);
  if (platform === 'win32' && local !== undefined) return join(local, 'translify', 'locks');

  return join(absolute(env.XDG_CACHE_HOME) ?? join(homedir(), '.cache'), 'translify', 'locks');
}

async function ownFolder(folder: string, uid: number | null): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await lstat(folder);
  if (!info.isDirectory() || (uid !== null && info.uid !== uid)) throw new Error(`${folder} is not a folder owned by this user`);
  // Left open by an earlier umask or by hand: close it again.
  if (uid !== null && (info.mode & 0o077) !== 0) await chmod(folder, 0o700);

  return folder;
}

/**
 * The lock for a file lives in the OS temp folder, named by a hash of the file's real path: nothing is ever
 * created in the working tree.
 */
export async function lockPathFor(path: string): Promise<string> {
  return join(await lockFolder(), `${await lockName(path)}.lock`);
}

const lockName = async (path: string): Promise<string> =>
  createHash('sha256')
    .update(await realOrNearest(resolve(path)))
    .digest('hex')
    .slice(0, 32);

/**
 * Where CLI 0.13.4 kept the lock of a file: straight in the temp folder. This version takes that lock as well,
 * after its own, so the two versions running at once on one file (a stale `npx` cache beside a global install)
 * still take turns. Best effort only: it sits in a folder others can write to, so it is never allowed to block
 * for good. Drop it once 0.13.4 is no longer around.
 */
export async function legacyLockPathFor(path: string, base: string = tmpdir()): Promise<string> {
  return join(base, `translify-${await lockName(path)}.lock`);
}

interface Seen {
  token: string;
  age: number;
}

/** What is in a lock file and how old it is; undefined when it is gone (or, on Windows, going). */
async function look(path: string, platform: string): Promise<Seen | undefined> {
  try {
    const [token, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);

    return { token, age: Date.now() - info.mtimeMs };
  } catch (error) {
    if (code(error) === 'ENOENT' || pending(error, platform)) return undefined;
    throw error;
  }
}

/** A date far in the future is as wrong as one far in the past (the clock was set back); neither is a live holder. */
const stale = (seen: Seen, staleMs: number): boolean => Math.abs(seen.age) > staleMs;

/** Remove the file only while it still holds `token`, so a lock someone else created in the meantime is left alone. */
async function removeIfToken(path: string, token: string, platform: string): Promise<void> {
  const seen: Seen | undefined = await look(path, platform);
  if (seen?.token === token) await rm(path, { force: true });
}

const create = async (path: string, token: string, platform: string): Promise<boolean> => {
  try {
    await writeFile(path, token, { flag: 'wx' });

    return true;
  } catch (error) {
    if (code(error) === 'EEXIST' || pending(error, platform)) return false;
    throw error;
  }
};

/**
 * Remove `lock` if it is still the abandoned one first seen (`token`), one process at a time: the takeover is itself
 * done under a second lock (`<lock>.takeover`) and re-checked inside it. Without that, two waiters could both see
 * the dead lock, and the slower one would delete the lock the faster one had just created and enter beside it.
 */
export async function removeIfStale(lock: string, token: string, staleMs: number, platform: string = process.platform): Promise<void> {
  const takeover = `${lock}.takeover`;
  const mine: string = randomBytes(8).toString('hex');
  if (!(await create(takeover, mine, platform))) {
    // Held for two reads and an unlink only; one this old belongs to a process that died right there.
    const other: Seen | undefined = await look(takeover, platform);
    if (other !== undefined && stale(other, staleMs)) await removeIfToken(takeover, other.token, platform);

    return;
  }
  try {
    const seen: Seen | undefined = await look(lock, platform);
    if (seen !== undefined && seen.token === token && stale(seen, staleMs)) await rm(lock, { force: true });
  } finally {
    await removeIfToken(takeover, mine, platform);
  }
}

/**
 * Run `fn` while holding the lock of `path`, so two processes never read-modify-write the same file at once.
 * Keep `fn` short (no network): the lock is a plain file created with `wx` that holds a random token, and one
 * older than `staleMs` is treated as abandoned and taken over. A holder that was merely slow (a suspended
 * process, a stalled disk) can therefore lose its lock: `fn` gets `held()` and must ask it right before it
 * writes. The release removes the lock only while it still carries this run's token.
 */
export async function withFileLock<T>(
  path: string,
  fn: (held: StillHeld) => Promise<T>,
  options: LockOptions = LOCK_DEFAULTS,
  platform: string = process.platform,
): Promise<T | typeof BUSY> {
  const lock: string = await lockPathFor(path);
  const legacy: string = await legacyLockPathFor(path);
  const token: string = randomBytes(16).toString('hex');
  const deadline: number = Date.now() + options.waitMs;

  while (!(await create(lock, token, platform))) {
    if (Date.now() >= deadline) return BUSY;
    const seen: Seen | undefined = await look(lock, platform);
    if (seen !== undefined && stale(seen, options.staleMs)) await removeIfStale(lock, seen.token, options.staleMs, platform);
    // Gone already (released between the failed create and the look): try again at once.
    else if (seen === undefined) continue;
    await sleep(5 + Math.floor(Math.random() * 30));
  }

  let legacyHeld = false;
  try {
    const older: 'held' | 'skipped' | 'busy' = await holdLegacy(legacy, token, deadline, options, platform);
    if (older === 'busy') return BUSY;
    legacyHeld = older === 'held';

    return await fn(
      async () =>
        (await look(lock, platform))?.token === token && (!legacyHeld || (await look(legacy, platform).catch(() => undefined))?.token === token),
    );
  } finally {
    if (legacyHeld) await removeIfToken(legacy, token, platform).catch(() => undefined);
    await removeIfToken(lock, token, platform);
  }
}

/**
 * Take the 0.13.4 lock too, waiting for a live holder like for any lock. Anything that goes wrong with it (the
 * temp folder refuses the file, a dead lock of another user cannot be removed) is `skipped`: the own lock is held,
 * and a lock in a shared folder must not be able to stop this version from working.
 */
async function holdLegacy(lock: string, token: string, deadline: number, options: LockOptions, platform: string): Promise<'held' | 'skipped' | 'busy'> {
  try {
    while (!(await create(lock, token, platform))) {
      if (Date.now() >= deadline) return 'busy';
      const seen: Seen | undefined = await look(lock, platform);
      if (seen !== undefined && stale(seen, options.staleMs)) await removeIfStale(lock, seen.token, options.staleMs, platform);
      else if (seen === undefined) continue;
      await sleep(5 + Math.floor(Math.random() * 30));
    }

    return 'held';
  } catch {
    return 'skipped';
  }
}
