import { describe, expect, it } from 'vitest';

import { patchJson, pullOrder, type PatchResult } from './json-patch.js';

// The backend's sortDeep orders keys by UTF-16 code unit at every depth, then JS puts integer-like keys first.
const sortDeep = (node: unknown): unknown =>
  typeof node === 'object' && node !== null && !Array.isArray(node)
    ? Object.fromEntries(
        Object.keys(node)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((key) => [key, sortDeep((node as Record<string, unknown>)[key])]),
      )
    : node;
const pulled = (tree: unknown): string => `${JSON.stringify(sortDeep(tree), null, 2)}\n`;
// A document laid out as given (fixtures that must stay in a specific order).
const raw = (tree: unknown): string => `${JSON.stringify(tree, null, 2)}\n`;
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
    const before = style === 'nested' ? { zeta: 'z', auth: { login: 'Log in' } } : { zeta: 'z', 'auth.login': 'Log in' };
    const after =
      style === 'nested'
        ? { zeta: 'z', checkout: { promo: { title: 'Limited offer' } }, auth: { login: 'Log in' } }
        : { zeta: 'z', 'checkout.promo.title': 'Limited offer', 'auth.login': 'Log in' };
    expect(patched(patchJson(pulled(before), 'checkout.promo.title', 'Limited offer', style))).toBe(pulled(after));
  });

  it('appends when the siblings are not in pull order', () => {
    expect(patched(patchJson(raw({ b: '1', a: '2' }), 'aa', 'x', 'flat'))).toBe(raw({ b: '1', a: '2', aa: 'x' }));
  });

  it('integer-like segments keep their place and sort numerically', () => {
    const text = raw({ errors: { '404': 'Not found', '500': 'Server', other: 'x' } });
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

  it('keeps a minified document minified on insert and replace', () => {
    expect(patched(patchJson('{"a":"1","c":"3"}', 'b', '2', 'flat'))).toBe('{"a":"1","b":"2","c":"3"}');
    expect(patched(patchJson('{"a":"1","c":"3"}', 'z', '2', 'flat'))).toBe('{"a":"1","c":"3","z":"2"}');
    expect(patched(patchJson('{"c":"3","a":"1"}', 'b', '2', 'flat'))).toBe('{"c":"3","a":"1","b":"2"}');
    expect(patched(patchJson('{ "a": "1", "c": "3" }', 'b', '2', 'flat'))).toBe('{ "a": "1", "b": "2", "c": "3" }');
    expect(patched(patchJson('{"a":"1"}', 'b.c.d', 'v', 'nested'))).toBe('{"a":"1","b":{"c":{"d":"v"}}}');
    expect(patched(patchJson('{}', 'b', '2', 'flat'))).toBe('{"b":"2"}');
    expect(patched(patchJson('{"a":"1","b":"2"}', 'a', 'x', 'flat'))).toBe('{"a":"x","b":"2"}');
  });

  it('keeps an inline object inline inside a multi-line file', () => {
    const text = '{\n  "a": {"x": "1", "z": "3"},\n  "b": "2"\n}\n';
    expect(patched(patchJson(text, 'a.y', 'v', 'nested'))).toBe('{\n  "a": {"x": "1", "y": "v", "z": "3"},\n  "b": "2"\n}\n');
  });

  it('refuses to insert below a parent name that occurs twice', () => {
    const text = '{"a":{"x":"1"},"a":{"y":"2"}}';
    expect(patchJson(text, 'a.z', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'ambiguous', at: 'a' });
  });

  it('a duplicated name hides its earlier copies, as JSON.parse does', () => {
    // The server sees only {"a":{"c":"2"}}: a.b is not a key there, so it is not edited in the invisible first copy.
    expect(patchJson('{"a":{"b":"1"},"a":{"c":"2"}}', 'a.b', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'ambiguous', at: 'a' });
    // The visible (last) copy is the one that is edited.
    const text = '{"a":{"b":"1"},"a":{"b":"2"}}';
    expect(patched(patchJson(text, 'a.b', 'v', 'nested'))).toBe('{"a":{"b":"1"},"a":{"b":"v"}}');
  });

  it('pins dotted-prefix coexistence: the server reads a.b and a.b.c as distinct keys', () => {
    // {"a":"x"} + flat a.b: two distinct keys on the server.
    expect(patched(patchJson(pulled({ a: 'x' }), 'a.b', 'v', 'flat'))).toBe(pulled({ 'a.b': 'v', a: 'x' }));
    // {"a.b":"x"} + nested a.b.c: distinct keys, so the nested branch is added beside the dotted one.
    expect(patched(patchJson(pulled({ 'a.b': 'x' }), 'a.b.c', 'v', 'nested'))).toBe(pulled({ a: { b: { c: 'v' } }, 'a.b': 'x' }));
    // {"a.b.c":"x"} + nested a.b: distinct keys again.
    expect(patched(patchJson(pulled({ 'a.b.c': 'x' }), 'a.b', 'v', 'nested'))).toBe(pulled({ a: { b: 'v' }, 'a.b.c': 'x' }));
    // {"a.b":"x"} + flat a.b.c: distinct keys again.
    expect(patched(patchJson(pulled({ 'a.b': 'x' }), 'a.b.c', 'v', 'flat'))).toBe(pulled({ 'a.b': 'x', 'a.b.c': 'v' }));
  });

  it('with a leaf and an object both matching the key, the leaf wins whatever the order', () => {
    // An object at the same path is not a key on the server; the leaf is.
    const objectLast = '{\n  "a.b": "old",\n  "a": {\n    "b": {\n      "c": "1"\n    }\n  }\n}\n';
    const objectFirst = '{\n  "a": {\n    "b": {\n      "c": "1"\n    }\n  },\n  "a.b": "old"\n}\n';
    expect(patched(patchJson(objectLast, 'a.b', 'new', 'nested'))).toBe(objectLast.replace('"old"', '"new"'));
    expect(patched(patchJson(objectFirst, 'a.b', 'new', 'nested'))).toBe(objectFirst.replace('"old"', '"new"'));
  });

  it('a copy under an array-index name that is not the first in the document is ambiguous: the server reads it first', () => {
    // JavaScript lists "1" before "1.x" whatever the document says, so "the last one" differs on the server.
    expect(patchJson('{"1.x":"a","1":{"x":"b"}}', '1.x', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'ambiguous', at: '1.x' });
    expect(patchJson('{"n":{"1.x":"a","1":{"x":"b"}}}', 'n.1.x', 'v', 'nested')).toEqual({ action: 'skipped', reason: 'ambiguous', at: 'n.1.x' });
  });

  it('where document order and the server\'s order agree, the last copy is still the one edited', () => {
    // The index name comes first in the document too.
    expect(patchJson('{"1":{"x":"b"},"1.x":"a"}', '1.x', 'v', 'nested')).toEqual({ action: 'patched', text: '{"1":{"x":"b"},"1.x":"v"}' });
    // Above the array-index range JavaScript keeps document order.
    expect(patchJson('{"99999999999.x":"a","99999999999":{"x":"b"}}', '99999999999.x', 'v', 'nested')).toEqual({
      action: 'patched',
      text: '{"99999999999.x":"a","99999999999":{"x":"v"}}',
    });
    // One copy only is patched as ever.
    expect(patchJson('{"1":{"x":"b"}}', '1.x', 'v', 'nested')).toEqual({ action: 'patched', text: '{"1":{"x":"v"}}' });
  });
});
