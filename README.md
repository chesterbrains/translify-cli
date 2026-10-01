# Translify CLI

Push, pull and publish [Translify](https://translify.tommasofeltrin.work) translations from your repository.

The CLI reads a `translify.json` that maps your translation files (i18next JSON, XLIFF or Flutter ARB) to a Translify project, and uses a project **secret key** to:

- `push` source and target files up to Translify,
- `pull` the current translations back into your files,
- `status` to fail CI when local files differ from Translify,
- `publish` an environment.

## Install

Requires Node 20 or newer.

```bash
# run without installing
npx @chesterbrains/translify-cli@0.1 --help

# or add it to a project (then `npx translify` runs the local copy)
npm i -D @chesterbrains/translify-cli
npx translify --help
```

Always use the full scoped name `@chesterbrains/translify-cli` when running through `npx` and no local install exists (including in CI). The unscoped name `translify` on npm is not ours: `npx translify` without a local install would download whatever package holds that name, with your secret key in the environment.

Standalone binaries (no Node needed) are coming soon.

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
npx @chesterbrains/translify-cli@0.1 init            # detects your layout, writes translify.json
npx @chesterbrains/translify-cli@0.1 push --dry-run  # show what would change, write nothing
npx @chesterbrains/translify-cli@0.1 push
npx @chesterbrains/translify-cli@0.1 pull
```

(If you installed it with `npm i -D`, `npx translify ...` is equivalent.)

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

- `pattern` must contain `{locale}`. `{namespace}` is optional; without it, set a fixed `"namespace"` on the rule.
- `format` is `json`, `xliff` or `arb`. JSON also takes `"jsonStyle": "nested"` (default) or `"flat"`.
- `locales` maps a locale name on disk to the Translify locale code, for example `{ "en_US": "en-US" }`. Omit it when the names already match.

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
npx @chesterbrains/translify-cli@0.1 init
npx @chesterbrains/translify-cli@0.1 push
npx @chesterbrains/translify-cli@0.1 pull
flutter gen-l10n
```

Translify requires every ARB file to declare `"@@locale"` (Flutter treats it as optional). `translify init` warns about each file that lacks it; add `"@@locale": "<locale>"` to those files before the first push. On `pull`, the CLI writes `@@locale` using the locale name on disk (for example `en_US` in `app_en_US.arb`), as `flutter gen-l10n` expects.

## Commands

| Command | What it does |
|---|---|
| `translify init` | Create `translify.json` (interactive) |
| `translify login` | Store a secret key on this machine (interactive) |
| `translify push` | Upload source and target files |
| `translify pull` | Download translation files |
| `translify status` | Exit 1 if local files differ from Translify |
| `translify publish <env>` | Publish an environment, e.g. `production` |

Options:

- `push`: `--dry-run`, `--overwrite-targets`, `--prune`, `-y/--yes`, `--namespace <ns>`
- `pull` and `status`: `--from <working|env:slug>`, `--locale <locale>` (as named on disk), `--namespace <ns>`
- `--json` on `push`, `pull`, `status` and `publish`: machine-readable output on stdout
- `--debug` (global): print error details and stack traces

## Conflict rules

`push` is conservative by default:

- **Source locale: your files win.** Existing source translations are overwritten with what is in the file.
- **Target locales: Translify fills only the gaps.** Keys that already have a translation are left alone and counted as skipped.
- `--overwrite-targets` also overwrites existing target translations.
- `--prune` deletes keys that no longer exist in your source files. Keys that are already published to an environment are never pruned: the push is refused with `ORPHANS_PUBLISHED`.
- `--yes` skips the confirmation prompt for the two destructive flags. Without a terminal and without `--yes`, a destructive push is refused and nothing changes.
- `--dry-run` shows the effect of any combination and writes nothing.

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
      - run: npx @chesterbrains/translify-cli@0.1 push
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
      - run: npx @chesterbrains/translify-cli@0.1 status
        env:
          TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

Pull and publish on deploy:

```yaml
- run: npx @chesterbrains/translify-cli@0.1 pull
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
- run: npx @chesterbrains/translify-cli@0.1 publish production
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

The server's error `code` decides the exit code first; the HTTP status is only used for codes the CLI does not know.

## Troubleshooting

| Code | Exit | What to do |
|---|---|---|
| `VALIDATION_FAILED` | 1 | Nothing was written. The output lists `file:line key: reason`; fix those entries and push again. |
| `LOCALE_NOT_FOUND` | 1 | A locale in your files is not enabled in the project. Enable it in Translify, or map it with `locales` in `translify.json`. |
| `NAMESPACE_NOT_FOUND` | 1 | The namespace does not exist in the project. Create it in Translify or fix the `--namespace` / pattern. |
| `VALIDATION_FAILED` with `emptySourcePrune` | 1 | `--prune` was refused because a source file in the push has no entries (it would delete the whole namespace). Push the real source file, or drop `--prune`; emptying a namespace is done in the Translify web app. |
| `ORPHANS_PUBLISHED` | 1 | `--prune` would delete keys that are published. Unpublish them first, or drop `--prune`. |
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
| `CLI_TOO_OLD` | 4 | Upgrade: `npm i -g @chesterbrains/translify-cli@latest` (or use `npx ...@latest`). |
| `TRANSACTION_CONFLICT` | 4 | Another write collided with yours. Retry. |
| `RATE_LIMITED` | 4 | The CLI already retried 3 times, honouring `Retry-After`. Wait a moment and retry. |
| `INTERNAL_ERROR` / `DATABASE_ERROR` / 5xx | 4 | A server problem. Retry shortly; if it persists, re-run with `--debug` and report it. |
| Network error | 4 | `Could not reach <apiUrl>`: check `apiUrl` in `translify.json` and your connection. |
| Request timed out | 4 | A request took longer than 180 s. Retry, or split the push with `--namespace`. |
| `Too many files (N > 500)` | 1 | A push carries at most 500 files. Split it with `--namespace`. |
| `ARB file is missing @@locale` | 1 | Add `"@@locale": "<locale>"` (for example `"en"`) to that `.arb` file and push again. |
| `No translify.json here` | 1 | Run `translify init` in the repository root. |
| `status` reports drift | 1 | Run `translify pull` (or `push`) to bring the two sides back in line. |
