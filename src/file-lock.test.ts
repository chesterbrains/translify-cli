import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUSY, lockFolder, lockPathFor, removeIfStale, withFileLock } from './file-lock.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'translify-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('runs one holder at a time and leaves nothing behind, in the project or the temp folder', async () => {
    const file = join(dir, 'en.json');
    let inside = 0;
    let most = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        withFileLock(file, async () => {
          most = Math.max(most, ++inside);
          await new Promise((done) => setTimeout(done, 2));
          inside--;

          return index;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(await readdir(dir)).toEqual([]);
    await expect(readFile(await lockPathFor(file))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives up with BUSY when a live lock outlasts the wait, and leaves that lock alone', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    await writeFile(lock, 'other\n');
    try {
      expect(await withFileLock(file, async () => 'ran', { waitMs: 60, staleMs: 60_000 })).toBe(BUSY);
      expect(await readFile(lock, 'utf8')).toBe('other\n');
    } finally {
      await rm(lock, { force: true });
    }
  });

  it('takes over a lock left by a dead process', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    await writeFile(lock, 'dead\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withFileLock(file, async () => 'ran', { waitMs: 1000, staleMs: 5000 })).toBe('ran');
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the lock when the callback throws', async () => {
    const file = join(dir, 'en.json');
    await expect(
      withFileLock(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await withFileLock(file, async () => 'again')).toBe('again');
  });

  it('two spellings of one file share a lock; two files do not', async () => {
    await writeFile(join(dir, 'en.json'), '{}');
    expect(await lockPathFor(join(dir, 'en.json'))).toBe(await lockPathFor(join(dir, 'sub', '..', 'en.json')));
    expect(await lockPathFor(join(dir, 'en.json'))).not.toBe(await lockPathFor(join(dir, 'de.json')));
  });

  it('many waiters on one dead lock: still one holder at a time, and no takeover lock is left', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    await writeFile(lock, 'dead\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let inside = 0;
    let most = 0;
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        withFileLock(
          file,
          async () => {
            most = Math.max(most, ++inside);
            await new Promise((done) => setTimeout(done, 1));
            inside--;

            return true;
          },
          { waitMs: 5000, staleMs: 2000 },
        ),
      ),
    );
    expect(results.every((result) => result === true)).toBe(true);
    expect(most).toBe(1);
    await expect(readFile(`${lock}.takeover`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a takeover lock left by a dead process does not block the takeover for good', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    const old = new Date(Date.now() - 60_000);
    for (const path of [lock, `${lock}.takeover`]) {
      await writeFile(path, 'dead\n');
      await utimes(path, old, old);
    }
    expect(await withFileLock(file, async () => 'ran', { waitMs: 2000, staleMs: 1000 })).toBe('ran');
    await expect(readFile(`${lock}.takeover`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removeIfStale leaves the lock alone while another waiter holds the takeover, when the lock was replaced, and when it is fresh', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    const old = new Date(Date.now() - 60_000);
    try {
      // Another waiter is mid-takeover: this one must not touch the lock.
      await writeFile(lock, 'dead');
      await utimes(lock, old, old);
      await writeFile(`${lock}.takeover`, 'other waiter');
      await removeIfStale(lock, 'dead', 1000);
      expect(await readFile(lock, 'utf8')).toBe('dead');
      expect(await readFile(`${lock}.takeover`, 'utf8')).toBe('other waiter');
      await rm(`${lock}.takeover`);

      // The dead lock was already replaced by a new holder (another token), however old its date looks.
      await writeFile(lock, 'new holder');
      await utimes(lock, old, old);
      await removeIfStale(lock, 'dead', 1000);
      expect(await readFile(lock, 'utf8')).toBe('new holder');

      // Same token but refreshed since it was seen.
      await writeFile(lock, 'dead');
      await removeIfStale(lock, 'dead', 1000);
      expect(await readFile(lock, 'utf8')).toBe('dead');

      // Still the dead one: removed, and the takeover lock is released.
      await utimes(lock, old, old);
      await removeIfStale(lock, 'dead', 1000);
      await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${lock}.takeover`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(lock, { force: true });
      await rm(`${lock}.takeover`, { force: true });
    }
  });

  it('a holder slower than the stale limit learns it lost the lock and does not release the new holder\'s', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    const timings = { waitMs: 2000, staleMs: 80 };
    let secondEntered: (() => void) | undefined;
    const entered = new Promise<void>((done) => (secondEntered = done));
    let releaseSecond: (() => void) | undefined;
    const hold = new Promise<void>((done) => (releaseSecond = done));

    const slow = withFileLock(
      file,
      async (held) => {
        expect(await held()).toBe(true);
        await entered;

        return held();
      },
      timings,
    );
    await new Promise((done) => setTimeout(done, 120));
    const second = withFileLock(
      file,
      async (held) => {
        secondEntered?.();
        await hold;

        return held();
      },
      timings,
    );

    expect(await slow).toBe(false);
    // The slow holder has released by now; the lock on disk is still the second holder's.
    await utimes(lock, new Date(), new Date());
    expect(await readFile(lock, 'utf8')).not.toBe('');
    releaseSecond?.();
    expect(await second).toBe(true);
    await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a lock dated far in the future (the clock was set back) is abandoned too', async () => {
    const file = join(dir, 'en.json');
    const lock = await lockPathFor(file);
    await writeFile(lock, 'dead');
    const future = new Date(Date.now() + 3_600_000);
    await utimes(lock, future, future);
    expect(await withFileLock(file, async () => 'ran', { waitMs: 1000, staleMs: 500 })).toBe('ran');
  });

  it.skipIf(process.platform === 'win32')('the lock of a file under a symlinked folder is the same before and after its folders exist', async () => {
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'locales'));
    const file = join(dir, 'locales', 'fr', 'common.json');
    const before = await lockPathFor(file);
    await mkdir(join(dir, 'locales', 'fr'));
    expect(await lockPathFor(file)).toBe(before);
    await writeFile(file, '{}');
    expect(await lockPathFor(file)).toBe(before);
    expect(await lockPathFor(join(dir, 'real', 'fr', 'common.json'))).toBe(before);
  });
});

describe('lockFolder', () => {
  it.skipIf(process.platform === 'win32')('is this user\'s own folder, closed to others, and holds the locks', async () => {
    const folder = await lockFolder(dir);
    expect(folder).toBe(join(dir, `translify-${process.getuid?.()}`));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await lockFolder(dir)).toBe(folder);
    expect((await lockPathFor(join(dir, 'en.json'))).startsWith(`${await lockFolder()}`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses a folder of that name that belongs to someone else, or is not a folder', async () => {
    await mkdir(join(dir, 'translify-12345'));
    await expect(lockFolder(dir, 12345)).rejects.toThrow(/not a folder owned by this user/);
    await writeFile(join(dir, 'translify-777'), 'x');
    await expect(lockFolder(dir, 777)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it.skipIf(process.platform === 'win32')('closes a folder of its own that was left open to others', async () => {
    const folder = join(dir, `translify-${process.getuid?.()}`);
    await mkdir(folder);
    await chmod(folder, 0o777);
    expect(await lockFolder(dir)).toBe(folder);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
  });

  it('without a uid (Windows) the folder has a fixed name', async () => {
    expect(await lockFolder(dir, null)).toBe(join(dir, 'translify-locks'));
  });
});
