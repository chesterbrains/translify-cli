import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VERSION } from './version.js';

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const pkgUrl: URL = new URL('../package.json', import.meta.url);
    const pkg: { version: string } = JSON.parse(readFileSync(pkgUrl, 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
