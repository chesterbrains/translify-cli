// Runs many `translify set` processes at once against a local fake server and checks that the locale file ends
// up holding every entry. Real processes, so it covers what the in-process unit tests cannot: the file lock and the
// atomic write between separate programs, on whatever OS runs it. Needs `pnpm build` first.
//
//   node scripts/parallel-set.mjs [total=48] [atOnce=12]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const total = Number(process.argv[2] ?? 48);
const atOnce = Number(process.argv[3] ?? 12);

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const sent = body === '' ? {} : JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        namespace: 'common',
        key: sent.key,
        locale: sent.locale,
        isSource: true,
        outcome: 'created',
        keyCreated: true,
        keyRestored: false,
        status: 'APPROVED',
        statusDowngraded: false,
        issueSeverity: null,
        issues: null,
        staleReset: 0,
      }),
    );
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

const setOnce = (cwd, key, locale) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [cli, 'set', key, locale, `value of ${key}`], {
      cwd,
      // Not a real key: the fake server checks nothing, the CLI only checks the shape.
      env: { ...process.env, TRANSLIFY_SECRET_KEY: `sk_${'a'.repeat(43)}`, NO_COLOR: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => done({ key, code, output }));
  });

/** `total` sets, `atOnce` at a time, all on one file of `locale`. */
async function scenario(name, locale, prepare) {
  const cwd = await mkdtemp(join(tmpdir(), 'translify-parallel-'));
  try {
    const config = { apiUrl, files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json', namespace: 'common' }] };
    await writeFile(join(cwd, 'translify.json'), JSON.stringify(config));
    await prepare(cwd);

    const keys = Array.from({ length: total }, (_, index) => `k${String(index).padStart(3, '0')}.title`);
    const queue = [...keys];
    const results = [];
    await Promise.all(
      Array.from({ length: atOnce }, async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) results.push(await setOnce(cwd, key, locale));
      }),
    );

    const folder = join(cwd, 'locales', locale);
    const file = JSON.parse(await readFile(join(folder, 'common.json'), 'utf8'));
    const missing = keys.filter((key) => file[key.split('.')[0]]?.title !== `value of ${key}`);
    const failed = results.filter((result) => result.code !== 0 || !/(Updated|Created) locales/.test(result.output));
    const leftovers = (await readdir(folder)).filter((entry) => entry !== 'common.json');

    console.log(`${name}: ${keys.length - missing.length} of ${keys.length} entries, ${failed.length} failed runs, ${leftovers.length} leftover files`);
    for (const result of failed.slice(0, 5)) console.log(`  ${result.key}: exit ${result.code}: ${result.output.trim()}`);
    if (leftovers.length > 0) console.log(`  leftovers: ${leftovers.join(', ')}`);

    return missing.length === 0 && failed.length === 0 && leftovers.length === 0;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const results = [
  await scenario('existing file', 'en', async (cwd) => {
    await mkdir(join(cwd, 'locales', 'en'), { recursive: true });
    await writeFile(join(cwd, 'locales', 'en', 'common.json'), '{}\n');
  }),
  await scenario('file and folder created by the first run', 'fr', async () => undefined),
];
server.close();
process.exit(results.every(Boolean) ? 0 : 1);
