/* global console, process, setTimeout, Buffer */
// A real `translify push --watch` process against a local stand-in server: the polling, the timers and the
// signal handling that unit tests drive with a fake clock. Run after `pnpm build`:
//   node scripts/watch-smoke.mjs
// Exits 0 when the watch started, pushed a saved change by itself, survived a refused file and stopped cleanly.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const windows = process.platform === 'win32';

/** Every push the server saw, as the manifest's namespaces. */
const pushes = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/whoami')) {
      res.end(JSON.stringify({ project: { defaultLocale: 'en' }, locales: ['en', 'it'] }));

      return;
    }
    const body = Buffer.concat(chunks).toString('latin1');
    pushes.push(/"namespace":"([^"]+)"/.exec(body)?.[1]);
    if (body.includes('{"broken"')) {
      res.statusCode = 422;
      res.end(JSON.stringify({ code: 'VALIDATION_FAILED', errors: [{ file: 'locales/en/cart.json', reason: 'File is not valid JSON' }] }));

      return;
    }
    const created = pushes.length > 1 ? 1 : 0;
    res.end(JSON.stringify({ dryRun: false, locales: { en: { created, updated: 0, unchanged: 1, skippedFilled: 0, unknownKeys: [] } }, orphans: [], pruned: 0 }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const cwd = await mkdtemp(join(tmpdir(), 'tfy-watch-smoke-'));
const put = async (path, text) => {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), text);
};
await put('translify.json', JSON.stringify({ apiUrl: `http://127.0.0.1:${server.address().port}/api`, files: [{ pattern: 'locales/{locale}/{namespace}.json', format: 'json' }] }));
await put('locales/en/cart.json', '{"a":"A"}');
await put('locales/it/cart.json', '{"a":"A it"}');

const child = spawn(process.execPath, [cli, 'push', '--watch', '--debounce', '500'], {
  cwd,
  env: { ...process.env, TRANSLIFY_SECRET_KEY: `sk_${'x'.repeat(43)}`, NO_COLOR: '1' },
});
let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));
const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

const fail = (why) => {
  console.error(`watch smoke FAILED: ${why}\n--- output\n${output}`);
  child.kill();
  process.exit(1);
};
/** Polls for a condition, bounded: no fixed sleeps. */
const until = async (what, test, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

await until('the start push', () => /pushed 1 namespace\(s\)/.test(output));
await put('locales/it/cart.json', '{"a":"changed target"}');
await put('locales/en/cart.json', '{"a":"A","b":"B"}');
await until('the saved change to be pushed', () => /cart: 1 created/.test(output));
if (pushes.length !== 2) fail(`expected 2 pushes (the target file is not watched), saw ${pushes.length}`);

await put('locales/en/cart.json', '{"broken"');
await until('the refusal to be reported', () => /The push was rejected/.test(output));
await put('locales/en/cart.json', '{"a":"A","b":"B","c":"C"}');
await until('the fixed file to be pushed', () => pushes.length === 4);

if (windows) {
  // No SIGINT between processes on Windows: Ctrl-C in a console is the only clean stop, and it cannot be sent here.
  child.kill();
  await exited;
} else {
  child.kill('SIGINT');
  const { code, signal } = await exited;
  if (code !== 0) fail(`expected exit 0 after SIGINT, got code ${code} signal ${signal}`);
}
server.close();
console.log(`watch smoke OK (${process.platform}, ${pushes.length} pushes)`);
