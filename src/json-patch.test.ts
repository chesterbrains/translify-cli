import { describe, expect, it } from 'vitest';

import { patchJson, pullOrder, type PatchResult } from './json-patch.js';

const pulled = (tree: unknown): string => `${JSON.stringify(tree, null, 2)}\n`;
const patched = (r: PatchResult): string => {
  if (r.action === 'skipped') throw new Error(r.reason);
  return r.text;
};

describe('patchJson', () => {
  it('replaces one leaf and changes nothing else', () => {
    const text = '{\n    "b": "2",\n    "a": {"x": "1",   "y": "old"}\n}\n';
    expect(patched(patchJson(text, 'a.y', 'new', 'nested'))).toBe('{\n    "b": "2",\n    "a": {"x": "1",   "y": "new"}\n}\n');
  });

  it('finds the key under any split of its dots', () => {
    expect(patched(patchJson(pulled({ 'a.b': { c: 'old' } }), 'a.b.c', 'new', 'nested'))).toBe(pulled({ 'a.b': { c: 'new' } }));
    expect(patched(patchJson(pulled({ a: { 'b.c': 'old' } }), 'a.b.c', 'new', 'flat'))).toBe(pulled({ a: { 'b.c': 'new' } }));
  });

  it('with the key present twice, edits the last occurrence', () => {
    const text = '{\n  "a": {\n    "b": "first"\n  },\n  "a.b": "last"\n}\n';
    expect(patched(patchJson(text, 'a.b', 'new', 'nested'))).toBe('{\n  "a": {\n    "b": "first"\n  },\n  "a.b": "new"\n}\n');
  });

  it.each(['nested', 'flat'] as const)('pull equivalence (%s): a pulled file plus set equals the new pull', (style) => {
    const before = style === 'nested' ? { auth: { login: 'Log in' }, zeta: 'z' } : { 'auth.login': 'Log in', zeta: 'z' };
    const after =
      style === 'nested'
        ? { auth: { login: 'Log in' }, checkout: { promo: { title: 'Limited offer' } }, zeta: 'z' }
        : { 'auth.login': 'Log in', 'checkout.promo.title': 'Limited offer', zeta: 'z' };
    expect(patched(patchJson(pulled(before), 'checkout.promo.title', 'Limited offer', style))).toBe(pulled(after));
  });

  it('appends when the siblings are not in pull order', () => {
    expect(patched(patchJson(pulled({ b: '1', a: '2' }), 'aa', 'x', 'flat'))).toBe(pulled({ b: '1', a: '2', aa: 'x' }));
  });

  it('integer-like segments keep their place and sort numerically', () => {
    const text = pulled({ errors: { '404': 'Not found', '500': 'Server', other: 'x' } });
    expect(patched(patchJson(text, 'errors.409', 'Conflict', 'nested'))).toBe(
      '{\n  "errors": {\n    "404": "Not found",\n    "409": "Conflict",\n    "500": "Server",\n    "other": "x"\n  }\n}\n',
    );
    expect(pullOrder('10', '9')).toBeGreaterThan(0);
    expect(pullOrder('9', 'a')).toBeLessThan(0);
    expect(pullOrder('007', '1')).toBeGreaterThan(0); // not canonical: a plain string
  });

  it('writes a value exactly as JSON.stringify would', () => {
    const value = 'Line1\n"q" \\   é 🎉';
    expect(patched(patchJson(pulled({ a: 'x' }), 'a', value, 'flat'))).toBe(pulled({ a: value }));
  });

  it('keeps tabs, CRLF and a BOM', () => {
    const text = '﻿{\r\n\t"a": "1"\r\n}\r\n';
    expect(patched(patchJson(text, 'b', '2', 'flat'))).toBe('﻿{\r\n\t"a": "1",\r\n\t"b": "2"\r\n}\r\n');
  });

  it('unchanged, created, and the two skips', () => {
    const text = pulled({ a: 'x', b: { c: 'y' } });
    expect(patchJson(text, 'a', 'x', 'flat')).toEqual({ action: 'unchanged', text });
    expect(patchJson(undefined, 'a.b', 'v', 'nested')).toEqual({ action: 'created', text: pulled({ a: { b: 'v' } }) });
    expect(patchJson(undefined, 'a.b', 'v', 'flat')).toEqual({ action: 'created', text: pulled({ 'a.b': 'v' }) });
    expect(patchJson(text, 'a.deep', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'blocked', at: 'a' });
    expect(patchJson(text, 'b', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'blocked', at: 'b' });
    expect(patchJson('{ "a": ', 'a', 'v', 'flat')).toEqual({ action: 'skipped', reason: 'invalid' });
    expect(patchJson('[]', 'a', 'v', 'flat')).toEqual({ action: 'skipped', reason: 'invalid' });
    expect(patchJson('{}\n', 'a', 'v', 'flat').action).toBe('patched');
  });

  it('inserts into an empty parent in the pull layout', () => {
    expect(patched(patchJson('{}\n', 'a.b.c', 'v', 'nested'))).toBe(pulled({ a: { b: { c: 'v' } } }));
    expect(patched(patchJson('{}\n', 'a', 'v', 'flat'))).toBe(pulled({ a: 'v' }));
    expect(patched(patchJson('{\n  "a": {}\n}\n', 'a.b', 'v', 'nested'))).toBe(pulled({ a: { b: 'v' } }));
  });
});
