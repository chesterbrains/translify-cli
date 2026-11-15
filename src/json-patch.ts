import { applyEdits, modify, parseTree, type Edit, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';

export type PatchResult =
  | { action: 'patched' | 'created' | 'unchanged'; text: string }
  | { action: 'skipped'; reason: 'invalid' | 'blocked'; at?: string };

const BOM = '﻿';
// JS orders integer-like own keys first, and only canonical array indices (below 2^32 - 1) count.
const MAX_ARRAY_INDEX = 4294967294;
const isIndexName = (name: string): boolean => /^(0|[1-9]\d*)$/.test(name) && Number(name) <= MAX_ARRAY_INDEX;

/** Pull's sibling order: integer-like names (`0`, `404`; canonical, no leading zero) first, ascending numerically; then the rest by UTF-16 code unit. */
export function pullOrder(a: string, b: string): number {
  const aIndex = isIndexName(a);
  const bIndex = isIndexName(b);

  if (aIndex && bIndex) return Number(a) - Number(b);
  if (aIndex) return -1;
  if (bIndex) return 1;
  if (a < b) return -1;

  return a > b ? 1 : 0;
}

interface Property {
  name: string;
  value: Node;
}

const propertiesOf = (object: Node): Property[] =>
  (object.children ?? []).flatMap((property) => {
    const [name, value] = property.children ?? [];

    return name !== undefined && value !== undefined && typeof name.value === 'string' ? [{ name: name.value, value }] : [];
  });

type Search = { found: 'leaf'; value: Node } | { found: 'blocked' } | { found: 'none' };

/** Matches the key under any split of its dots; of several leaves the last in document order wins, as in the server's parser. */
function search(object: Node, rest: string): Search {
  let leaf: Node | undefined;
  let blocked = false;

  for (const { name, value } of propertiesOf(object)) {
    if (name === rest) {
      if (value.type === 'string') leaf = value;
      else blocked = true;
    } else if (rest.startsWith(`${name}.`) && value.type === 'object') {
      const inner = search(value, rest.slice(name.length + 1));

      if (inner.found === 'leaf') leaf = inner.value;
      else if (inner.found === 'blocked') blocked = true;
    }
  }

  if (leaf !== undefined) return { found: 'leaf', value: leaf };

  return blocked ? { found: 'blocked' } : { found: 'none' };
}

function formattingOf(text: string): FormattingOptions {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];

  return {
    insertSpaces: indent === undefined || !indent.startsWith('\t'),
    tabSize: indent === undefined || indent.startsWith('\t') ? 2 : indent.length,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  };
}

const nest = (segments: string[], value: string): unknown =>
  segments.reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), value);

export function patchJson(text: string | undefined, key: string, value: string, style: 'nested' | 'flat'): PatchResult {
  if (text === undefined) {
    const tree = style === 'nested' ? nest(key.split('.'), value) : { [key]: value };

    return { action: 'created', text: `${JSON.stringify(tree, null, 2)}\n` };
  }

  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  const errors: ParseError[] = [];
  const root = parseTree(body, errors, { disallowComments: true, allowTrailingComma: false });

  if (errors.length > 0 || root === undefined || root.type !== 'object') return { action: 'skipped', reason: 'invalid' };

  const hit = search(root, key);

  if (hit.found === 'blocked') return { action: 'skipped', reason: 'blocked', at: key };

  if (hit.found === 'leaf') {
    if (hit.value.value === value) return { action: 'unchanged', text };

    const edit: Edit = { offset: hit.value.offset, length: hit.value.length, content: JSON.stringify(value) };

    return { action: 'patched', text: bom + applyEdits(body, [edit]) };
  }

  // Not found: pick the path to insert at. Flat keeps the dots in one name.
  const segments = style === 'flat' ? [key] : key.split('.');
  const existing: string[] = [];
  let parent: Node = root;

  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index] as string;
    const next = propertiesOf(parent).find((property) => property.name === segment)?.value;

    if (next === undefined) break;
    existing.push(segment);
    if (next.type !== 'object') return { action: 'skipped', reason: 'blocked', at: existing.join('.') };
    parent = next;
  }

  const added = segments.slice(existing.length);
  const first = added[0] as string;
  const names = propertiesOf(parent).map((property) => property.name);
  const sorted = names.every((name, index) => index === 0 || pullOrder(names[index - 1] as string, name) <= 0);
  const position = sorted ? names.findIndex((name) => pullOrder(name, first) > 0) : -1;
  const insertAt = position === -1 ? names.length : position;

  const edits = modify(body, [...existing, first], nest(added.slice(1), value), {
    formattingOptions: formattingOf(body),
    getInsertionIndex: () => insertAt,
  });

  return { action: 'patched', text: bom + applyEdits(body, edits) };
}
