import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODE_EXIT } from './http.js';

const readme: string = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const schema: { properties: Record<string, unknown> & { files: { items: { properties: Record<string, unknown> } } } } = JSON.parse(
  readFileSync(new URL('../schema/translify.schema.json', import.meta.url), 'utf8'),
);

/** The body of the `## <heading>` section, up to the next `## `. */
const section = (heading: string): string => {
  const start: number = readme.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`README has no "## ${heading}" section`);
  const rest: string = readme.slice(start + heading.length + 5);
  const end: number = rest.search(/\n## /);

  return end === -1 ? rest : rest.slice(0, end);
};

/** Table rows as cells, header and separator rows dropped. */
const rows = (body: string): string[][] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

const codesIn = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

// The README is the public reference the app links to: these keep it in step with the code.
describe('README', () => {
  it('lists every server error code the CLI maps, with the exit code it maps to', () => {
    const exits: Map<string, Set<string>> = new Map();
    for (const [first, exit] of rows(section('Troubleshooting'))) {
      for (const code of codesIn(first!)) exits.set(code, (exits.get(code) ?? new Set()).add(exit!));
    }

    for (const [code, exit] of Object.entries(CODE_EXIT)) {
      expect(exits.get(code), code).toEqual(new Set([String(exit)]));
    }
  });

  it('documents every translify.json field in the config reference', () => {
    const documented: string[] = rows(section('`translify.json` reference')).flatMap(([first]) => codesIn(first!));
    const fields: string[] = [
      ...Object.keys(schema.properties),
      ...Object.keys(schema.properties.files.items.properties).map((key) => `files[].${key}`),
    ];

    expect(documented.toSorted()).toEqual(fields.toSorted());
  });
});
