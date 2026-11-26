import { applyEdits, modify, parseTree, type Edit, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';

export type PatchResult =
  | { action: 'patched' | 'created' | 'unchanged'; text: string }
  | { action: 'skipped'; reason: 'invalid' | 'blocked' | 'ambiguous'; at?: string };

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
  key: Node;
  value: Node;
}

const propertiesOf = (object: Node): Property[] =>
  (object.children ?? []).flatMap((property) => {
    const [name, value] = property.children ?? [];

    return name !== undefined && value !== undefined && typeof name.value === 'string' ? [{ name: name.value, key: name, value }] : [];
  });

/** What JSON.parse keeps: of several properties with one name only the last is visible. */
const visibleProperties = (object: Node): Property[] => {
  const last = new Map<string, Property>();

  for (const property of propertiesOf(object)) {
    last.delete(property.name);
    last.set(property.name, property);
  }

  return [...last.values()];
};

type Search = { found: 'leaf'; value: Node } | { found: 'blocked' } | { found: 'ambiguous' } | { found: 'none' };

/**
 * Matches the key under any split of its dots; of several leaves the last in document order wins, as in the server's
 * parser. The exception: JavaScript lists an array-index name (`"1"`) before every other name whatever the document
 * says, so when the copy under such a name is not the first one in the document (`"1.x"`, then `"1": { "x" }`) the
 * server's last differs from the file's, and the file has to be fixed rather than guessed at.
 */
function search(object: Node, rest: string): Search {
  let leaf: Node | undefined;
  let blocked = false;
  const leafNames: string[] = [];

  for (const { name, value } of visibleProperties(object)) {
    if (name === rest) {
      if (value.type === 'string') {
        leaf = value;
        leafNames.push(name);
      } else blocked = true;
    } else if (rest.startsWith(`${name}.`) && value.type === 'object') {
      const inner = search(value, rest.slice(name.length + 1));

      if (inner.found === 'ambiguous') return inner;
      if (inner.found === 'leaf') {
        leaf = inner.value;
        leafNames.push(name);
      } else if (inner.found === 'blocked') blocked = true;
    }
  }

  if (leafNames.slice(1).some(isIndexName)) return { found: 'ambiguous' };
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

const hasBreak = (text: string): boolean => /[\r\n]/.test(text);

/**
 * An object written on one line keeps its compact form: the entry is inserted by hand with the separators the
 * object already uses, so no other byte moves. An empty object is inline only in a document with no line break.
 */
function inlineEdit(
  body: string,
  parent: Node,
  properties: Property[],
  added: string[],
  value: string,
  insertAt: number,
): Edit | undefined {
  const first = properties[0];
  const inline = first === undefined ? !body.includes('\n') : !hasBreak(body.slice(parent.offset, parent.offset + parent.length));

  if (!inline) return undefined;

  const colon = first === undefined ? ':' : body.slice(first.key.offset + first.key.length, first.value.offset);
  const second = properties[1];
  const comma =
    first !== undefined && second !== undefined
      ? body.slice(first.value.offset + first.value.length, second.key.offset)
      : colon.endsWith(' ')
        ? ', '
        : ',';
  const render = (segments: string[]): string => {
    const [head, ...tail] = segments as [string, ...string[]];

    return `${JSON.stringify(head)}${colon}${tail.length === 0 ? JSON.stringify(value) : `{${render(tail)}}`}`;
  };
  const entry = render(added);

  if (first === undefined) return { offset: parent.offset, length: parent.length, content: `{${entry}}` };

  const before = properties[insertAt];

  if (before !== undefined) return { offset: before.key.offset, length: 0, content: entry + comma };

  const last = properties[properties.length - 1] as Property;

  return { offset: last.value.offset + last.value.length, length: 0, content: comma + entry };
}

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
  if (hit.found === 'ambiguous') return { action: 'skipped', reason: 'ambiguous', at: key };

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
    const matches = propertiesOf(parent).filter((property) => property.name === segment);
    const next = matches[0]?.value;

    if (next === undefined) break;
    existing.push(segment);
    // JSON.parse keeps the last duplicate, so an entry added to the first would be invisible to the server.
    if (matches.length > 1) return { action: 'skipped', reason: 'ambiguous', at: existing.join('.') };
    if (next.type !== 'object') return { action: 'skipped', reason: 'blocked', at: existing.join('.') };
    parent = next;
  }

  const added = segments.slice(existing.length);
  const first = added[0] as string;
  const properties = propertiesOf(parent);
  const names = properties.map((property) => property.name);
  const sorted = names.every((name, index) => index === 0 || pullOrder(names[index - 1] as string, name) <= 0);
  const position = sorted ? names.findIndex((name) => pullOrder(name, first) > 0) : -1;
  const insertAt = position === -1 ? names.length : position;

  const inline = inlineEdit(body, parent, properties, added, value, insertAt);

  if (inline !== undefined) return { action: 'patched', text: bom + applyEdits(body, [inline]) };

  const edits = modify(body, [...existing, first], nest(added.slice(1), value), {
    formattingOptions: formattingOf(body),
    getInsertionIndex: () => insertAt,
  });

  return { action: 'patched', text: bom + applyEdits(body, edits) };
}
