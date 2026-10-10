# Translify CLI

Push, pull and publish [Translify](https://translify.tommasofeltrin.work) translations from your repository.

The CLI reads a `translify.json` that maps your translation files (i18next JSON, XLIFF or Flutter ARB) to a Translify project, and uses a project **secret key** to:

- `push` source and target files up to Translify,
- `pull` the current translations back into your files,
- `status` to fail CI when local files differ from Translify,
- `publish` an environment.

## Install

### Standalone binary (no Node needed)

macOS and Linux (x64 or arm64):

```bash
curl -fsSL https://github.com/chesterbrains/translify-cli/releases/latest/download/install.sh | sh
```

The script checks the download against the release's `SHA256SUMS` and installs `translify` to `~/.local/bin` (set `TRANSLIFY_INSTALL_DIR` to change it, `TRANSLIFY_VERSION=v0.1.0` to pin a version). It never uses `sudo`.

On Windows, download `translify-windows-x64.exe` from the [releases page](https://github.com/chesterbrains/translify-cli/releases).

### With Node

Requires Node 20 or newer.

```bash
# run without installing
npx translify --help

# or add it to a project
npm i -D translify
npx translify --help
```

`translify` is an alias of `@chesterbrains/translify-cli`: the same CLI, so `npm i -D @chesterbrains/translify-cli` and `npm i -D translify` both work.

## Create a secret key

In Translify, open your project's API keys, create a **secret key** (it starts with `sk_`) and give it the scopes you need: `PULL` to pull and run `status`, `PUSH` to push, `PUBLISH` to publish. The raw key is shown once.

Give the key to the CLI in one of two ways:

- set `TRANSLIFY_SECRET_KEY` (always wins; use this in CI), or
- run `translify login` and paste it. It is stored in `~/.config/translify/credentials` (or under `$XDG_CONFIG_HOME`).

Never commit a key. Delivery keys (public keys used by apps to download published translations) do not work here.

## Quickstart: i18next

```
locales/
  en/common.json
  it/common.json
```

```bash
export TRANSLIFY_SECRET_KEY=sk_...
npx translify init            # detects your layout, writes translify.json
npx translify push --dry-run  # show what would change, write nothing
npx translify push
npx translify pull
```

`translify.json`:

```json
{
  "$schema": "https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json",
  "apiUrl": "https://translify.tommasofeltrin.work/api",
  "files": [
    { "pattern": "locales/{locale}/{namespace}.json", "format": "json" }
  ]
}
```

Every field is described in the [`translify.json` reference](#translifyjson-reference).

## Quickstart: Flutter

`l10n.yaml`:

```yaml
arb-dir: lib/l10n
template-arb-file: app_en.arb
output-localization-file: app_localizations.dart
```

`translify.json`:

```json
{
  "$schema": "https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json",
  "apiUrl": "https://translify.tommasofeltrin.work/api",
  "files": [
    { "pattern": "lib/l10n/app_{locale}.arb", "format": "arb", "namespace": "app" }
  ],
  "locales": { "en_US": "en-US" }
}
```

ARB files always use a fixed `namespace`. The `locales` map is only needed for locales that Flutter names with an underscore (`app_en_US.arb`); `translify init` suggests it for you.

Set the key first (`export TRANSLIFY_SECRET_KEY=sk_...` or `translify login`), then:

```bash
npx translify init
npx translify push
npx translify pull
flutter gen-l10n
```

`"@@locale"` is optional in ARB files: when it is absent, the file's locale is used. When it is present it must match the file's locale (case and `_`/`-` are ignored). On `pull`, the CLI writes `@@locale` using the locale name on disk (for example `en_US` in `app_en_US.arb`), as `flutter gen-l10n` expects.

## `translify.json` reference

`translify.json` lives in the repository root; every command reads it from the current directory. The
[JSON schema](schema/translify.schema.json) gives editors completion and validation through `$schema`. Unknown
fields are refused, and so is any field whose name contains `key`, `secret` or `token`: keys never go in this file.

| Field | Type | Required | Description |
|---|---|---|---|
| `$schema` | string | no | Schema URL for editor support. Ignored by the CLI. |
| `apiUrl` | URL | yes | The Translify API base, ending in `/api`, e.g. `https://translify.tommasofeltrin.work/api`. |
| `files` | array | yes | One rule per kind of translation file. Each rule has the fields below. |
| `files[].pattern` | string | yes | Path relative to `translify.json`, with `/` separators. Must contain `{locale}` once and may contain `{namespace}` once, e.g. `locales/{locale}/{namespace}.json`. |
| `files[].format` | `json` \| `xliff` \| `arb` | yes | File format: i18next JSON, XLIFF or Flutter ARB. |
| `files[].namespace` | string | when the pattern has no `{namespace}`, and always for `arb` | Fixed namespace for every file the rule matches. Lowercase kebab-case, at most 64 characters. |
| `files[].jsonStyle` | `nested` \| `flat` | no | Only for `json`. `nested` (the default) writes `{ "a": { "b": "…" } }`, `flat` writes `{ "a.b": "…" }`. |
| `locales` | object | no | Maps a locale name on disk to a Translify locale code, e.g. `{ "en_US": "en-US" }`. Unmapped names pass through unchanged. Two names may not map to the same code, and a target may not itself be a mapped name. |

Each file must be matched by one rule only, and each (locale, namespace) pair must come from one file only;
otherwise the CLI stops before sending anything and names the files involved.

## Commands

| Command | What it does |
|---|---|
| `translify init` | Create `translify.json` (interactive) |
| `translify login` | Store a secret key on this machine (interactive) |
| `translify push` | Upload source and target files |
| `translify pull` | Download translation files |
| `translify status` | Exit 1 if local files differ from Translify |
| `translify lint` | Exit 6 if translations in Translify have placeholder errors (or too many warnings) |
| `translify publish <env>` | Publish an environment, e.g. `production` |

Options:

- `push`: `--dry-run`, `--overwrite-targets`, `--prune`, `-y/--yes`, `--namespace <ns>`, `--status <draft|needs-review|approved>`
- `pull` and `status`: `--from <working|env:slug>`, `--locale <locale>` (as named on disk), `--namespace <ns>`, `--only-approved`
- `publish`: `--fail-on-withheld`, `--allow-errors`
- `lint`: `--namespace <ns>`, `--locale <locale>` (as named on disk), `--severity <error|warning>` (only list cells whose worst issue is this severity; counts and the exit code are unaffected), `--max-warnings <n>`
- `--json` on `push`, `pull`, `status`, `publish` and `lint`: machine-readable output on stdout
- `--debug` (global): print error details and stack traces

## Conflict rules

`push` is conservative by default:

- **Source locale: your files win.** Existing source translations are overwritten with what is in the file.
- **Target locales: Translify fills only the gaps.** Keys that already have a translation are left alone and counted as skipped.
- `--overwrite-targets` also overwrites existing target translations.
- `--prune` deletes keys that no longer exist in your source files, together with their translations. See [Prune safety](#prune-safety).
- `--yes` skips the confirmation prompt for the two destructive flags. Without a terminal and without `--yes`, a destructive push is refused and nothing changes.
- `--dry-run` shows the effect of any combination and writes nothing.

## Prune safety

`translify push --prune` is the only command that deletes keys. What it deletes, and what stops it:

- **Only the namespaces in this push.** A key is an orphan when its namespace is in the push and its source file no
  longer has it. Namespaces you did not push (another rule, another repository, `--namespace` left them out) are never
  touched.
- **Never published keys.** A key published to any environment is listed as kept and survives. Unpublish it in
  Translify first if it really should go.
- **Never a whole namespace by accident.** If a source file in the push has no entries, the push is refused
  (`VALIDATION_FAILED` with `emptySourcePrune`) instead of deleting every key in that namespace. Emptying a namespace
  is done in the Translify web app.
- **Exactly the list you confirmed.** The CLI always runs a dry run first, shows the keys it would delete and asks
  for confirmation. The real push sends a digest of that list; if the server's list differs by then (keys added,
  removed or published in between), it refuses with `ORPHANS_CHANGED` and writes nothing. A server too old to return
  the digest makes `--prune` refuse.
- **No silent prune in CI.** Without a terminal, `--prune` is refused unless you pass `--yes`.
- **Atomic.** The whole push, deletions included, is one transaction: if anything fails, nothing is written.

`--yes` confirms whatever that run's dry run lists, so in CI review the list before it runs unattended. One way:
show the orphans on pull requests and prune on `main`.

```yaml
# on pull_request: list what a prune would delete, change nothing
- run: npx translify push --prune --dry-run
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}

# on push to main: prune for real
- run: npx translify push --prune --yes
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

## Review

When the project has **Require review** turned on in Translify:

- `push` lands target-locale translations it writes as **needs review**. `--status draft` or `--status needs-review` picks the status explicitly, and `--status approved` approves them as they land. The source file is always approved. Each locale row shows the status its cells landed in, and the output counts approved translations that went back to review because this push changed their source text.
- Without review, `push` approves everything it writes, and `--status draft` / `--status needs-review` are refused (`REVIEW_DISABLED`).
- `publish` to an environment with **Publish approved text only** ships the last approved text of each translation. The output adds how many translations were **carried over** (the approved text went out instead of a newer, unapproved edit) and how many were **withheld** (never approved, so left out). Publishing still succeeds; `--fail-on-withheld` exits 5 when anything was withheld, for pipelines that must ship everything reviewed.
- `publish` refuses when a translation that would go live has a placeholder error (a missing or extra placeholder, invalid ICU, a printf type mismatch). Nothing is published, the refused translations are listed like `lint` lists them, and the command exits 6. Warnings never block. On an environment with **Publish approved text only**, only approved translations count: one carried over from its last approved text never blocks. `--allow-errors` publishes anyway and reports how many went out with errors; the publish is recorded in the activity log with the override.
- `pull --only-approved` writes the approved text from the working copy and leaves out translations that were never approved, for building a release bundle without publishing. `status --only-approved` compares against the same. It works with `--from working` only: environments already apply the gate.

## CI (GitHub Actions)

Store the key in the repository secrets as `TRANSLIFY_SECRET_KEY`.

Push on main:

```yaml
name: Translify push
on:
  push:
    branches: [main]
jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx translify push
        env:
          TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

Fail a pull request when local files drift from Translify:

```yaml
name: Translify status
on: pull_request
jobs:
  status:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx translify status
        env:
          TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

Fail CI when translations in Translify have placeholder errors:

```yaml
- run: npx translify lint --max-warnings 0
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

`lint` checks what is stored in Translify, not your local files; run it after `push`, or before `pull`/`publish` on deploy.
It covers what this repository pulls: only the namespaces of fixed-`namespace` rules, or the whole
project when a rule uses `{namespace}`. It needs a key with the `pull` scope.

Pull and publish on deploy:

```yaml
- run: npx translify lint
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
- run: npx translify pull
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
- run: npx translify publish production
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The request or input was rejected, or `status` found drift, or a destructive flag was not confirmed |
| 2 | Key problem: invalid, revoked, wrong kind of key, or a missing scope |
| 3 | Plan quota exceeded |
| 4 | Network failure, server error, push too large, CLI too old, transaction conflict, or rate limited after 3 retries |
| 5 | `publish --fail-on-withheld`: the publish went through, but the review gate withheld some translations |
| 6 | Placeholder errors: `lint` found them (or more warnings than `--max-warnings`), or `publish` refused because translations with errors would go live |

The server's error `code` decides the exit code first; the HTTP status is only used for codes the CLI does not know.

## Troubleshooting

| Code | Exit | What to do |
|---|---|---|
| `VALIDATION_FAILED` | 1 | Nothing was written. The output lists `file:line key: reason`; fix those entries and push again. |
| `LOCALE_NOT_FOUND` | 1 | A locale in your files is not enabled in the project. Enable it in Translify, or map it with `locales` in `translify.json`. |
| `NAMESPACE_NOT_FOUND` | 1 | The namespace does not exist in the project. Create it in Translify or fix the `--namespace` / pattern. |
| `VALIDATION_FAILED` with `emptySourcePrune` | 1 | `--prune` was refused because a source file in the push has no entries (it would delete the whole namespace). Push the real source file, or drop `--prune`; emptying a namespace is done in the Translify web app. |
| `JSON_STYLE_REQUIRES_JSON` | 1 | `jsonStyle` only applies to rules with `"format": "json"`. Remove it from the other rules. |
| `BAD_REQUEST` | 1 | The request was malformed. Re-run with `--debug` for the server's message. |
| `ENVIRONMENT_NOT_FOUND` / `ENVIRONMENT_ARCHIVED` | 1 | Check the environment slug passed to `publish` or `--from env:<slug>`, and that it is not archived. |
| `PROJECT_ARCHIVED` | 1 | The project is archived; unarchive it in Translify. |
| `SECRET_KEY_IN_URL` | 1 | A secret key was sent in a query string. Pass it only via `TRANSLIFY_SECRET_KEY` or `translify login`. |
| `KEY_INVALID` | 2 | The key is not recognised. Check `TRANSLIFY_SECRET_KEY` and `apiUrl`. |
| `KEY_REVOKED` | 2 | Create a new secret key in Translify. |
| `KEY_WRONG_KIND` | 2 | You supplied a non-secret key. The CLI needs an `sk_` key. |
| `SCOPE_MISSING` | 2 | The key lacks the scope named in the message (`PULL`, `PUSH` or `PUBLISH`). Create a key that has it. |
| `QUOTA_EXCEEDED` | 3 | Your plan limit was reached (usually translation keys). Remove keys, or push a smaller set. |
| `PUSH_TOO_LARGE` | 4 | Split the push by namespace: `translify push --namespace <ns>`. |
| `CLI_TOO_OLD` | 4 | Upgrade: `npm i -g @chesterbrains/translify-cli@latest` (or use `npx translify@latest`). |
| `ORPHANS_CHANGED` | 1 | The orphan list changed between the dry run and the real push (keys were added, removed or published). Nothing was written; run `translify push --prune` again to review the new list. |
| `REVIEW_DISABLED` | 1 | `push --status draft` or `--status needs-review` on a project without review. Turn on **Require review** in the project settings, or drop `--status`. Nothing was written. |
| `APPROVED_ONLY_REQUIRES_WORKING` | 1 | `--only-approved` was combined with `--from env:<slug>`. Pull an environment without it; it already holds only what its gate allowed. |
| `INVALID_CELLS` | 6 | `publish` refused: translations that would go live have placeholder errors. Nothing was published; the output lists them like `lint` does. Fix them in Translify, or re-run with `--allow-errors` to publish anyway (recorded in the activity log). |
| `TRANSACTION_CONFLICT` | 4 | Another write collided with yours. Retry. |
| `RATE_LIMITED` | 4 | The CLI already retried 3 times, honouring `Retry-After`. Wait a moment and retry. |
| `INTERNAL_ERROR` / `DATABASE_ERROR` / 5xx | 4 | A server problem. Retry shortly; if it persists, re-run with `--debug` and report it. |
| Network error | 4 | `Could not reach <apiUrl>`: check `apiUrl` in `translify.json` and your connection. |
| Request timed out | 4 | A request took longer than 180 s. Retry, or split the push with `--namespace`. |
| `Too many files (N > 500)` | 1 | A push carries at most 500 files. Split it with `--namespace`. |
| `@@locale` does not match | 1 | `@@locale` is optional, but if an `.arb` file has it, it must match the file's locale (case and `_`/`-` are ignored). Fix or remove it and push again. |
| `No translify.json here` | 1 | Run `translify init` in the repository root. |
| `status` reports drift | 1 | Run `translify pull` (or `push`) to bring the two sides back in line. |

## Releasing the `translify` alias

The unscoped `translify` package lives in `alias/`. Its `bin.js` just imports `@chesterbrains/translify-cli`, which it depends on at `>=0.1.0 <1.0.0`, so it follows every 0.x release of the CLI without a republish. It only needs republishing (with a bumped range) for a 1.x major:

```bash
cd alias && npm publish --access public   # then approve the staged release
```

The alias is not part of the CLI's npm tarball and is ignored by lint, typecheck and tests.
