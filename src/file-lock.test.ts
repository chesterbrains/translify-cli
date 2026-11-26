import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUSY, lockPathFor, withFileLock } from './file-lock.js';

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
});
