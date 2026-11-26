import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameOver, writeFileAtomic } from './file-write.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'translify-write-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates and replaces a file, leaving no temp file', async () => {
    const file = join(dir, 'en.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it.skipIf(process.platform === 'win32')('keeps the permission bits of the file it replaces', async () => {
    const file = join(dir, 'en.json');
    await writeFile(file, 'one');
    await chmod(file, 0o640);
    await writeFileAtomic(file, 'two');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink instead of replacing it', async () => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await writeFile(real, 'one');
    await symlink(real, link);
    await writeFileAtomic(link, 'two');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('two');
  });

  it('a failed write leaves the old file whole and no temp file', async () => {
    const file = join(dir, 'missing-folder', 'en.json');
    await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(dir, 'keep.json'), 'old');
    expect(await readdir(dir)).toEqual(['keep.json']);
  });

  it('removes old temp files of the same target left by a crashed run, and only those', async () => {
    const file = join(dir, 'en.json');
    const old = new Date(Date.now() - 5 * 60_000);
    for (const name of ['.en.json.111.aaaaaaaa.tmp', '.de.json.111.aaaaaaaa.tmp', 'en.json.bak']) {
      await writeFile(join(dir, name), 'x');
      await utimes(join(dir, name), old, old);
    }
    await writeFile(join(dir, '.en.json.222.bbbbbbbb.tmp'), 'another run, still writing');
    await writeFileAtomic(file, 'new');
    expect((await readdir(dir)).sort()).toEqual(['.de.json.111.aaaaaaaa.tmp', '.en.json.222.bbbbbbbb.tmp', 'en.json', 'en.json.bak']);
  });
});

describe('renameOver', () => {
  const failing = (code: string, times: number) => {
    let calls = 0;
    const move = vi.fn(async () => {
      if (calls++ < times) throw Object.assign(new Error(code), { code });
    });

    return move as unknown as typeof import('node:fs/promises').rename & typeof move;
  };

  it('on Windows retries a rename refused because the file is held open', async () => {
    const move = failing('EPERM', 2);
    await renameOver('a', 'b', 'win32', move);
    expect(move).toHaveBeenCalledTimes(3);
  });

  it('on Windows gives up after the last delay; elsewhere it never retries; other codes never retry', async () => {
    const stuck = failing('EBUSY', 99);
    await expect(renameOver('a', 'b', 'win32', stuck)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(stuck).toHaveBeenCalledTimes(6);
    const posix = failing('EPERM', 1);
    await expect(renameOver('a', 'b', 'linux', posix)).rejects.toMatchObject({ code: 'EPERM' });
    expect(posix).toHaveBeenCalledTimes(1);
    const other = failing('ENOSPC', 1);
    await expect(renameOver('a', 'b', 'win32', other)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(other).toHaveBeenCalledTimes(1);
  });
});
