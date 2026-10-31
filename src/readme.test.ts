import { readFileSync, readdirSync } from 'node:fs';

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

  it('documents the two iOS rules, the identifier-key rule and the stringsdict-wins note', () => {
    const ios: string = section('iOS (.strings / .stringsdict)');

    for (const needle of ['"format": "strings"', '"format": "stringsdict"', 'sentence keys', 'Base.lproj', 'stringsdict wins']) {
      expect(ios, needle).toContain(needle);
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

  it('links every GitHub Actions recipe from the CI section', () => {
    const ci: string = section('CI (GitHub Actions)');
    const recipes: string[] = readdirSync(new URL('../recipes/github-actions', import.meta.url)).filter((name) => name.endsWith('.yml'));

    expect(recipes.length).toBeGreaterThan(0);
    for (const recipe of recipes) {
      expect(ci, recipe).toContain(`https://github.com/chesterbrains/translify-cli/blob/main/recipes/github-actions/${recipe}`);
    }
    const words: string[] = ['One', 'Two', 'Three', 'Four', 'Five'];
    expect(ci).toContain(`${words[recipes.length - 1]} ready-made workflows`);
  });

  it('ships a verify snippet that compares byte lengths before timingSafeEqual', () => {
    const webhooks: string = section('Webhooks');
    // A forged header with a non-ASCII character has a different byte length than string length; comparing the
    // Buffers keeps timingSafeEqual from throwing a RangeError instead of returning false.
    expect(webhooks).toMatch(/const given = Buffer\.from\(/);
    expect(webhooks).toMatch(/given\.length === wanted\.length && timingSafeEqual\(given, wanted\)/);
  });

  it('documents every webhook header and the signature format in the Webhooks section', () => {
    const webhooks: string = section('Webhooks');
    for (const header of ['X-Translify-Event', 'X-Translify-Delivery', 'X-Translify-Timestamp', 'X-Translify-Signature']) {
      expect(webhooks, header).toContain(`\`${header}\``);
    }
    expect(webhooks).toContain('translify-webhooks/1');
    expect(webhooks).toMatch(/v1=/);
    expect(webhooks).toMatch(/hmac-sha256/i);
    expect(webhooks).toMatch(/300 s|5 minutes/);
    expect(webhooks).toMatch(/timingSafeEqual/);
  });

  it('documents every publication.created payload field', () => {
    const webhooks: string = section('Webhooks');
    for (const field of [
      'publishedCount',
      'addedCount',
      'changedCount',
      'removedCount',
      'withheldCount',
      'errorCount',
      'requireApproved',
      'translify.publication',
      'translify.ping',
      'client_payload',
    ]) {
      expect(webhooks, field).toContain(field);
    }
    expect(webhooks).toContain('recipes/github-actions/translify-pull-on-publish.yml');
  });

  it('tells the GitHub recipe user about the protected branch and the build step', () => {
    const webhooks: string = section('Webhooks');
    expect(webhooks).toMatch(/protected\s+default branch/);
    expect(webhooks).toMatch(/Three things to set/);
    expect(webhooks).toMatch(/16 to 255 characters/);
  });

  it('describes --prune as archiving to the trash, in the README and in the CLI help', () => {
    const safety: string = section('Prune safety');
    expect(safety).toMatch(/archives/);
    expect(safety).toMatch(/trash/);
    expect(safety).toMatch(/30 days/);
    expect(safety).toMatch(/restore/i);
    expect(safety).not.toMatch(/[Nn]ever published/);
    expect(section('Commands')).not.toMatch(/`--prune` deletes/);

    const help: string = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const prune: string = help.split('\n').find((line) => line.includes("'--prune'"))!;
    expect(prune).toMatch(/trash/);
    expect(prune).not.toMatch(/published keys are kept/);
  });

  it('documents the init flags next to the other command options', () => {
    const options: string = section('Commands');
    expect(options).toMatch(/- `init`: .*`-y\/--yes`.*`--api-url <url>`/);
  });

  it('documents the Rails rule, normalize layout, framework data and array gaps', () => {
    const rails: string = section('Rails (YAML)');
    for (const needle of ['"yamlDialect": "rails"', 'i18n-tasks normalize', 'line_width', 'arrayGap', '"locales"']) {
      expect(rails, needle).toContain(needle);
    }
    expect(rails).toContain('%%%{');
    expect(rails).toContain('invalidRaw');
    expect(rails).not.toContain('literal `%` directly before an argument');
    expect(rails).not.toContain('`%%{` → a literal');
    expect(readme).not.toContain('a `%` before an argument');
    expect(readme).not.toContain('percentBeforeArg');
  });
});
