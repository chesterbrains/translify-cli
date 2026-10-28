# Translify CLI

Push, pull and publish [Translify](https://translify.tommasofeltrin.work) translations from your repository.

The CLI reads a `translify.json` that maps your translation files (i18next JSON, XLIFF or Flutter ARB) to a Translify project, and uses a project **secret key** to:

- `push` source and target files up to Translify,
- `pull` the current translations back into your files,
- `status` to fail CI when local files differ from Translify,
- `publish` an environment.

Complete example apps — React + i18next at runtime, Flutter (ARB) and Angular (XLIFF) at build time — live in [translify-examples](https://github.com/chesterbrains/translify-examples).

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
- run `translify login` (or let `translify init` ask for it) and paste it. It is stored in `~/.config/translify/credentials` (or under `$XDG_CONFIG_HOME`).

Never commit a key. Delivery keys (public keys used by apps to download published translations) do not work here.

## Quickstart: i18next

```
locales/
  en/common.json
  it/common.json
```

```bash
export TRANSLIFY_SECRET_KEY=sk_...
npx translify init            # detects your layout, asks for your key, writes translify.json
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

## Angular (XLIFF)

Angular's `@angular/localize` writes a template interpolation as an inline `<ph>` element and a template ICU as
`{VAR_PLURAL, …}` / `{VAR_SELECT, …}`, and matches a translation's placeholders by the `equiv` name. Plain ICU text
(`Hello, {name}`) in an Angular XLIFF is therefore literal text at build time. Set `xliffDialect` on the rule and the
server converts both ways:

```json
{ "files": [{ "pattern": "src/locale/messages.{locale}.xlf", "format": "xliff", "namespace": "web", "xliffDialect": "angular" }] }
```

`translify init` reads `angular.json` and writes this rule for you (one per distinct translation path, namespace = project name); `ng extract-i18n` must be run with `--format=xlf2 --out-file messages.<sourceLocale>.xlf` so the source file matches it.

Give every template string `i18n="@@<key>"` so the unit ids are your keys. A translation file's `trgLang` must be the
Translify locale code: with `"locales": { "it": "it-IT" }` the file is still `messages.it.xlf`, but it declares
`trgLang="it-IT"`, or `push` is refused with `File targets it but it-IT was requested`. What `pull` writes:

| Translify value | Angular unit |
|---|---|
| `Hello, {name}` | `Hello, <ph id="0" equiv="INTERPOLATION" disp="{{ name }}"/>` |
| `{a} {b} {a}` | ids `0`, `1`, `2`; `equiv` `INTERPOLATION`, `INTERPOLATION_1`, `INTERPOLATION` (one name per distinct argument, in order of first appearance in the source; a translation reuses the source's names however it reorders them) |
| `{count, plural, one {{count} item} other {# items}}` (the whole message) | `{VAR_PLURAL, plural, one {<ph id="0" equiv="INTERPOLATION" disp="{{ count }}"/> item} other {<ph id="1" equiv="INTERPOLATION" disp="{{ count }}"/> items}}` |
| `{g, select, male {he} other {they}}` (the whole message) | `{VAR_SELECT, select, male {he} other {they}}` |

What `push` reads from `ng extract-i18n --format=xlf2` output:

| Angular | Translify argument |
|---|---|
| `<ph equiv="INTERPOLATION" disp="{{ name }}"/>` | `{name}` |
| `disp="{{ count() }}"`, `disp="{{ user.name }}"`, `disp="{{ price | currency }}"` | the head identifier: `{count}`, `{user}`, `{price}` (also through `!.` and `[…]`); two that collide become `{user}` and `{user_2}` |
| no usable `disp` | `{p0}`, `{p1}`, … from the `equiv` number |
| `VAR_PLURAL` / `VAR_SELECT` | named after the first interpolation inside its branches, else `count` / `value` |

Units Angular hashes for a message that mixes text with an ICU are dropped, and `<note category="location">` is not a
description. After a round trip `#` comes back as `{count}`, and a plural or select with no interpolation inside keeps
`count` / `value` as its argument.

Not supported in this version (the pull is refused with `XLIFF_DIALECT_UNSUPPORTED`, the push reports the unit): text
beside a plural or select, two ICUs in one message, a plural or select inside another, `selectordinal`, `number` /
`date` / `time` formats, a quoted literal brace (`'{'`), HTML inside a message, and keys whose placeholders are printf or
i18next rather than ICU. Give
such a key its own element so the ICU is the whole message, or move it to a JSON rule. A complete example is the
Angular app in [translify-examples](https://github.com/chesterbrains/translify-examples).

## Xcode (XLIFF)

Xcode exports and imports **XLIFF 1.2** (`<trans-unit>`), keeps printf placeholders (`%@`, `%lld`) literal, and spreads one
String Catalog entry over several units for plurals and substitutions. Set `xliffDialect: "xcode"` and `xliffOriginal` on the
rule and the server converts both ways; Translify keeps ICU, so the same catalog serves React, Flutter, Angular and iOS, and
iOS translations get placeholder validation (Xcode's own import accepts a target that lost its `%@` without a word).

```json
{ "files": [{ "pattern": "Localization/{locale}.xliff", "format": "xliff", "namespace": "ios",
              "xliffDialect": "xcode", "xliffOriginal": "Sources/App/Localizable.xcstrings" }] }
```

`translify init` finds every `.xcstrings` and writes this rule for you (namespace = catalog name, `xliffOriginal` = its path; `Localization/{locale}.xliff` unless locale-named `.xliff` files already sit in one folder).

Workflow:

1. Seed once: `xcodebuild -exportLocalizations -localizationPath out -exportLanguage en`, copy
   `out/en.xcloc/Localized Contents/en.xliff` to `Localization/en.xliff`, `translify push`.
2. Translate in Translify, then `translify pull`.
3. `xcodebuild -importLocalizations -localizationPath Localization/it.xliff` (a bare `.xliff` works; `<file original>`
   comes from `xliffOriginal`).

What `pull` writes (arguments are positional, numbered by first appearance in the source, so a reordered translation keeps
its meaning; the printf type comes from the push that created the key, else `%@` for text, `%lld` for a plural's count, `%f`
for a fraction):

| Translify value | Units |
|---|---|
| `Hello, {name}` | `key` → `Hello, %1$@` |
| `{count, plural, one {# item} other {# items}}` | `key\|==\|plural.one` → `%1$lld item`, `key\|==\|plural.other` → `%1$lld items` |
| `You have {count, plural, one {# item} other {# items}} in your cart, {name}` | `key` → `You have %1$#@count@ in your cart, %2$@`, plus `key\|==\|substitutions.count.plural.one` / `.other` |
| untranslated | the unit has a `<source>` and no `<target>`, which Xcode shows as untranslated |

What `push` reads: `%@` / `%1$@` → `{arg1}` (renamed to the key's own argument when the key already exists), `%lld` →
`{arg2}` or `#` inside a plural, `%.2f` → `{arg, number}`, `%%` → `%`; `|==|plural.*` units → one ICU plural named `count`;
a `%#@name@` substitution → the plural inside the sentence. The printf types are kept in the key's metadata for the next
pull. Device variations (`|==|device.*`), unknown unit kinds and legacy `.strings`/`.stringsdict` exports are reported as
`unsupportedVariation` and skipped.

Not supported in this version (the pull is refused with `XLIFF_DIALECT_UNSUPPORTED`): `select` and `selectordinal`, exact
matches (`=0`) and `offset`, two plurals in one message, nested plurals, number formats without a known printf type (e.g.
currency), a translation whose shape differs from the source (plain text for a plural), and keys whose
placeholders are printf or i18next rather than ICU. A complete example is `examples/ios-xcstrings` in
[translify-examples](https://github.com/chesterbrains/translify-examples).

## Android (strings.xml)

Android keeps strings in `res/values/strings.xml` (default language) and `res/values-<qualifier>/strings.xml`
(translations). Set `format: "android"` and a fixed `namespace` on the rule; Translify keeps ICU, so the same keys serve
React, Flutter, iOS and Android, and Android translations get placeholder validation (`%1$s` lost in Italian fails
at runtime, not at build).

```json
{ "files": [{ "pattern": "app/src/main/res/values-{locale}/strings.xml", "format": "android", "namespace": "strings" }] }
```

`translify init` finds every `res/values/*.xml` whose root is `<resources>` and writes one rule per file (namespace =
file name, kebab-case; `donottranslate.xml` is skipped). Several modules with a `values/` directory get a note.

The folder qualifier follows Android's rules: `it` → `values-it`, `pt-BR` → `values-pt-rBR`, anything else (a script, a
three-letter language) → `values-b+sr+Latn`. The project's **default locale is the plain `values/` folder**, so the CLI
asks the server for it (one `whoami` per run) and the `-{locale}` part of the pattern disappears for it. The `locales` map
still applies after this mapping, for anything unusual.

Workflow:

1. `translify push` sends `values/strings.xml` (the default locale) and any `values-*` files you already have.
2. Translate in Translify.
3. `translify pull` writes `values-it/strings.xml` and the rest. Android falls back to `values/` for a string a locale
   does not have, so untranslated keys are left out.

What `pull` writes (positions are kept exactly as the pushed `values/strings.xml` wrote them: `%2$s by %1$s` stays
`%2$s by %1$s`, gaps like `%1$s %3$s` are kept, and a plural's count keeps its position, e.g. `%2$d songs by %1$s`. Only keys
created in the web UI or from another format are numbered by first appearance in the source. Translations are written with
the same positions as the source, so a reordered Italian keeps its meaning. The specifier comes from the push that created
the key, else `%s` for text, `%d` for a plural's count, `%f` for a fraction):

| Translify value | Written |
|---|---|
| `Hello, {name}` | `<string name="key">Hello, %1$s</string>` |
| `{count, plural, one {# item} other {# items}}` (the whole message) | `<plurals name="key">` with `<item quantity="one">%1$d item</item>`, `<item quantity="other">%1$d items</item>` |
| `Save 10% with {code}` | `Save 10%% with %1$s` (`%` is written `%%` for every key that has placeholders) |
| `colors.0`, `colors.1` pushed from a `<string-array>` | `<string-array name="colors">` with one `<item>` each; left out of a locale until every item is translated |
| a description | `<!-- … -->` above the element, in the default-locale file |

Elements are sorted by key with a four-space indent, so `translify status` is byte-stable.

What `push` reads: `<string>`, `<plurals>` (one ICU plural, `other` required) and `<string-array>` (keys `name.0`, `name.1`, …).
`%s` / `%1$s` → `{arg1}` (renamed to the key's own argument when the key already exists), `%d` → `{arg2}` or `#` inside a
plural, `%.2f` → `{arg, number}`, `%%` → `%` (always, whether or not the string has a placeholder). `<b>`, `<i>` and `<a href>` tags are kept as they are; `<xliff:g>` tags are
dropped and their content kept. Escapes are read like Android does (`\'`, `\"`, `\n`, `\uXXXX`, quotes preserve
whitespace) and written back the same way: apostrophes are always escaped (`\'`), a string with leading, trailing or
doubled spaces is wrapped in quotes, `&`, `<` and `>` in text become entities. Resources that are not strings
(`<bool>`, `<dimen>`, `<color>`, …) are skipped with a warning, as are strings marked `translatable="false"`.

Advice:

- Keep `translatable="false"` strings (and everything that is not a string: dimens, colors, styles) in
  `donottranslate.xml` or another file you do not push. A pull **rewrites** the file, so anything Translify does not hold
  would be dropped, and a push warns with a count of what it skipped.
- A literal `<b>` in a text is written back as a tag: a stored `<b>` cannot be told apart from markup. Keep a string
  that must show a literal tag out of Translify (`translatable="false"`).
- Keys must match `[A-Za-z_][A-Za-z0-9_.]*`: a `-` collides in `R` and a leading digit does not compile.

Not supported in this version (the pull is refused with `ANDROID_UNSUPPORTED`, the push reports the element): `select` and
`selectordinal`, exact matches (`=0`) and `offset`, text around a plural (the plural must be the whole message), two
plurals in one message, nested plurals, number formats without a known printf type (e.g. currency), a translation whose
shape differs from the source (plain text for a plural), keys whose placeholders are printf or i18next rather than ICU,
keys with a `-` or a leading digit, and a string-array whose item keys are not contiguous from `.0`. Pushing a
`<plurals>` without `other`, an unknown `quantity`, or an `<item>` without `type="string"` is a row error.

## iOS (.strings / .stringsdict)

Classic iOS and macOS projects keep strings in `<locale>.lproj/Localizable.strings` (plain text) and
`<locale>.lproj/Localizable.stringsdict` (plurals). Translify holds one ICU value per key, so a key lives in one of the
two files, decided by its **default-locale** value: plain text goes to `.strings`, a plural (or text with one plural) goes
to `.stringsdict`. Add two rules with the same `namespace`, one per format:

```json
{
  "files": [
    { "pattern": "Sources/App/{locale}.lproj/Localizable.strings", "format": "strings", "namespace": "localizable" },
    { "pattern": "Sources/App/{locale}.lproj/Localizable.stringsdict", "format": "stringsdict", "namespace": "localizable" }
  ]
}
```

`translify init` finds every `<locale>.lproj/<Table>.strings` / `.stringsdict` and writes the rules (namespace = table
name, kebab-case); `init` only notes a table that exists in `Base.lproj` alone, so add the `locales` mapping yourself (see below). Projects on a String Catalog (`.xcstrings`) should use the
[Xcode (XLIFF)](#xcode-xliff) dialect instead: it round-trips the catalog through Xcode's own import and export, and this
format is for projects that still ship `.strings` files.

What `pull` writes (arguments are positional Foundation printf, numbered by first appearance in the source; the specifier
comes from the push that created the key, else `@` for text, `lld` for a plural's count or `{n, number}`, `f` for a fraction):

| Translify value | Written |
|---|---|
| `Welcome` | `.strings`: `"key" = "Welcome";` |
| `Hello, {name}` | `.strings`: `"key" = "Hello, %1$@";` |
| `{n, number} of {total, number}` | `.strings`: `"key" = "%1$lld of %2$lld";` (positions follow the source, so a reordered translation keeps its meaning) |
| `Save 10% with {code}` | `.strings`: `"key" = "Save 10%% with %1$@";` (`%` is written `%%` only for keys that have placeholders; push always reads `%%` as `%`) |
| `{count, plural, =0 {No items} one {# item} other {# items}}` (the whole message) | `.stringsdict`: `NSStringLocalizedFormatKey` = `%1$#@count@` with one variable holding `zero` / `one` / `other` (`=0` is `zero`) |
| `{name} has {count, plural, one {# song} other {# songs}}` | `.stringsdict`: the text stays in `NSStringLocalizedFormatKey` (`%1$@ has %2$#@count@`) and the plural is its variable |
| a description | `/* … */` on the line directly above the entry, in the default-locale file only |

`.strings` escapes `\"`, `\\`, `\n`, `\t`, `\r` and `\Uxxxx`; push reads them back. Entries are sorted by key with a blank
line between them, so `translify status` is byte-stable. A comment is the key's description only when it sits directly
above the entry (`/* … */` or `// …`, no blank line in between); a trailing comment on the same line is ignored, and
Xcode's `No comment provided by engineer.` is dropped.

Workflow:

1. `translify push` sends `en.lproj/Localizable.strings` and `.stringsdict` (the default locale) and any other `.lproj` you
   already have.
2. Translate in Translify.
3. `translify pull` writes the other `.lproj` files. iOS falls back to the development language for a key a locale does not
   have, so untranslated keys are left out.

`Base.lproj` is not a locale: map it to the default language with `"locales": { "Base": "en-US" }`.

Keys must be identifiers (letters, digits, `.`, `_`, `-`; at most 255 characters). Keys with spaces or punctuation
(sentence keys such as `"Add to cart"`, English text used as the key) are refused as row error `invalidKey`; rename them
to identifiers, or keep those files on an XLIFF rule.

If one key appears in both the `.strings` and the `.stringsdict` of a locale, the push reports `duplicateKey` on the
`.strings` row: at runtime stringsdict wins, so that is the entry Translify keeps.

`--prune` with only one file of the pair archives only keys of that file's shape: a `.strings` push never trashes plural keys
and a `.stringsdict` push never trashes plain keys. Push both rules together to prune the whole namespace. The
empty-source safeguard looks at both files of a namespace.

UTF-16 files (Xcode's default for older projects) are refused with `File is UTF-16; convert it to UTF-8 (iconv -f UTF-16 -t UTF-8)`.

Not supported in this version (the pull is refused with `STRINGS_UNSUPPORTED`, the output lists the cells and why):
`select` and `selectordinal`, exact matches other than `=0`, `offset`, two plurals in one message, nested plurals, number
formats without a known printf type (e.g. currency), a translation whose shape differs from the source (plain text for a
plural), and keys whose placeholders are printf or i18next rather than ICU.

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
| `files[].format` | `json` \| `xliff` \| `arb` \| `android` \| `strings` \| `stringsdict` | yes | File format: i18next JSON, XLIFF, Flutter ARB, Android `strings.xml` ([Android (strings.xml)](#android-stringsxml)) or iOS `.strings` / `.stringsdict` ([iOS (.strings / .stringsdict)](#ios-strings--stringsdict)). |
| `files[].namespace` | string | when the pattern has no `{namespace}`, and always for `arb`, `android`, `strings` and `stringsdict` | Fixed namespace for every file the rule matches. Lowercase kebab-case, at most 64 characters. |
| `files[].jsonStyle` | `nested` \| `flat` | no | Only for `json`. `nested` (the default) writes `{ "a": { "b": "…" } }`, `flat` writes `{ "a.b": "…" }`. |
| `files[].xliffDialect` | `angular` \| `xcode` | no | Only for `xliff`. `angular` writes `@angular/localize` placeholders on pull and reads `ng extract-i18n` output on push ([Angular (XLIFF)](#angular-xliff)); `xcode` writes XLIFF 1.2 for String Catalogs and reads `xcodebuild -exportLocalizations` output ([Xcode (XLIFF)](#xcode-xliff)). |
| `files[].xliffOriginal` | string | with `xliffDialect: "xcode"` | The String Catalog path Xcode knows, e.g. `Sources/App/Localizable.xcstrings`; written to `<file original>`. Xcode imports nothing when it does not match the project. Only with `xcode`. |
| `locales` | object | no | Maps a locale name on disk to a Translify locale code, e.g. `{ "en_US": "en-US" }`. Unmapped names pass through unchanged. Two names may not map to the same code, and a target may not itself be a mapped name. The map renames files only: an XLIFF's `trgLang` (2.0) or `target-language` (1.2), when present, must be the Translify code itself, or `push` is refused with `File targets it but it-IT was requested`. |

Each file must be matched by one rule only, and each (locale, namespace) pair must come from one file only;
otherwise the CLI stops before sending anything and names the files involved.

## Commands

| Command | What it does |
|---|---|
| `translify init` | Create `translify.json`: detects i18next, Flutter, Angular, Xcode and Android layouts, asks for your key (interactive, or `--yes`) |
| `translify login` | Store a secret key on this machine (interactive) |
| `translify push` | Upload source and target files |
| `translify pull` | Download translation files |
| `translify status` | Exit 1 if local files differ from Translify |
| `translify lint` | Exit 6 if translations in Translify have placeholder errors (or too many warnings) |
| `translify publish <env>` | Publish an environment, e.g. `production` |

Options:

- `init`: `-y/--yes` (no prompts: every detected rule, the suggested locale map, the key from `TRANSLIFY_SECRET_KEY` or a previous login; fails instead of overwriting), `--api-url <url>`
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
- `--prune` moves keys that no longer exist in your source files to the Translify trash, together with their translations. They can be restored for 30 days. See [Prune safety](#prune-safety).
- `--yes` skips the confirmation prompt for the two destructive flags. Without a terminal and without `--yes`, a destructive push is refused and nothing changes.
- `--dry-run` shows the effect of any combination and writes nothing.

## Prune safety

`translify push --prune` is the only command that removes keys. It never deletes on the spot: it archives them. What
it archives, and what stops it:

- **Only the namespaces in this push.** A key is an orphan when its namespace is in the push and its source file no
  longer has it. Namespaces you did not push (another rule, another repository, `--namespace` left them out) are never
  touched.
- **Archived, not deleted.** A pruned key goes to the trash in Translify, with its translations and their history.
  It is deleted for good 30 days later. Until then, restore it from the trash on the project's Translations tab, or
  push a source file that names it again: the push restores it in place and reports it as restored.
- **Live keys too.** A key that is live in an environment is archived like any other, but the
  environment keeps serving it until its next publish, which drops it. Restore it before then if it should stay.
- **Never a whole namespace by accident.** If a source file in the push has no entries, the push is refused
  (`VALIDATION_FAILED` with `emptySourcePrune`) instead of archiving every key in that namespace. Emptying a namespace
  is done in the Translify web app.
- **Exactly the list you confirmed.** The CLI always runs a dry run first, shows the keys it would archive and asks
  for confirmation. The real push sends a digest of that list; if the server's list differs by then (keys added,
  removed, archived or restored in between), it refuses with `ORPHANS_CHANGED` and writes nothing. A server too old to return
  the digest makes `--prune` refuse.
- **No silent prune in CI.** Without a terminal, `--prune` is refused unless you pass `--yes`.
- **Atomic.** The whole push, archives and restores included, is one transaction: if anything fails, nothing is written.

`--yes` confirms whatever that run's dry run lists, so in CI review the list before it runs unattended. One way:
show the orphans on pull requests and prune on `main`.

```yaml
# on pull_request: list what a prune would archive, change nothing
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

## Webhooks

A project's admins can add webhooks under **Integrations**. Translify calls them with `publication.created` every time
an environment's live batch changes: a publish, a rollback or an unpublish (`batch.kind` says which). A publish whose
result is identical to what is live emits nothing. `ping` is the test event, sent by "Send test" and by the
verification dispatch that saves a GitHub webhook.

Deliveries are made by a worker, not by the request that published: five attempts, waiting 1 minute, 5 minutes,
30 minutes and 2 hours between them, then the delivery is `DEAD` and can be resent from the app. The log keeps 30
days. The delivery id is the same on every attempt (`X-Translify-Delivery` and the payload's `id`), so a receiver that
answers slowly and gets the retry can dedupe on it. Answer 2xx as soon as the request is accepted and do the work
afterwards; the sender waits 10 seconds.

### Payload

```json
{
  "id": "<delivery id>",
  "event": "publication.created",
  "createdAt": "2026-10-25T14:02:11.000Z",
  "project": { "id": "…", "slug": "shop", "name": "Shop" },
  "environment": { "id": "…", "slug": "production", "name": "Production", "requireApproved": true },
  "batch": {
    "id": "…", "seq": 41, "kind": "PUBLISH",
    "publishedCount": 1280, "addedCount": 3, "changedCount": 14, "removedCount": 0,
    "withheldCount": 0, "errorCount": 0
  },
  "actor": { "type": "user", "id": "…", "name": "Anna Rossi" }
}
```

`addedCount`, `changedCount` and `removedCount` are the batch's diff against the previous live batch: a first publish
has everything in `addedCount`; an `UNPUBLISH` has `publishedCount: 0` and everything that went offline in
`removedCount`. "Did anything change" is the sum of the three. `withheldCount` is what a `requireApproved` gate kept
back, `errorCount` the cells that went live with placeholder errors (a publish with `--allow-errors` or the app's
"publish anyway", or a rollback, which skips the gate). `actor.type` is `user`, `apiKey`
(a CLI publish; `name` is the key's name) or `system`. A `ping` carries `id`, `event`, `createdAt`, `project` and
`webhook { id, target, destination }` only.

### Verify a delivery

Generic webhooks `POST` the payload as `application/json` to an `https://` URL on a public host, with:

| Header | Value |
| --- | --- |
| `X-Translify-Event` | `publication.created` or `ping` |
| `X-Translify-Delivery` | the delivery id, identical on every attempt |
| `X-Translify-Timestamp` | unix seconds when the attempt was sent |
| `X-Translify-Signature` | `v1=<hex hmac-sha256(secret, "<timestamp>.<body>")>` |
| `User-Agent` | `translify-webhooks/1` |

The signing secret is shown once when the webhook is created: a generated `whsec_…`, or the 16 to 255 characters you
supplied. Verify over the raw body, compare in constant time and refuse a timestamp more than 300 s (5 minutes) away
from now:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, headers, secret) {
  const timestamp = Number(headers['x-translify-timestamp']);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const given = Buffer.from(String(headers['x-translify-signature'] ?? ''));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
```

### GitHub

A webhook with the **GitHub** target sends a
[`repository_dispatch`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) instead:
`POST https://api.github.com/repos/<owner>/<repo>/dispatches` with `event_type` `translify.publication` (or
`translify.ping`) and the payload above as `client_payload`. No signature: GitHub authenticates the token.

The token is a fine-grained personal access token with **Contents: Read and write** on that one repository (that is
the permission `repository_dispatch` needs). Translify verifies it with a `translify.ping` dispatch before saving and
refuses a token or repository GitHub rejects; the expiry GitHub reports is shown in the list from 14 days out.

[`recipes/github-actions/translify-pull-on-publish.yml`](https://github.com/chesterbrains/translify-cli/blob/main/recipes/github-actions/translify-pull-on-publish.yml)
is the workflow that closes the loop: on `translify.publication` it runs `translify pull --from env:<slug>` for the
environment in the payload, commits, opens a pull request whose body carries the publish summary (batch, counts,
actor), runs the build step you add and merges. Three things to set after copying it: the repository setting **Allow
GitHub Actions to create and approve pull requests** (Settings → Actions → General; without it the job token cannot
open the PR); the environment the repository follows, a literal in the job's `if:`, with the webhook limited to that
environment in Translify since every environment pulls into the same files; and your build in the commented Build
step, so a pull that does not compile leaves the pull request open instead of merging. The workflow builds and merges
inside the same run because a pull request opened with `GITHUB_TOKEN` never triggers other workflows; a protected
default branch needs the Merge step removed or a bypass for the token. The
[translify-examples](https://github.com/chesterbrains/translify-examples/blob/main/.github/workflows/translify-pull-on-publish.yml)
repository runs this workflow against the demo project.

## CI (GitHub Actions)

Store the key in the repository secrets as `TRANSLIFY_SECRET_KEY`. Three ready-made workflows live in
[`recipes/github-actions/`](https://github.com/chesterbrains/translify-cli/tree/main/recipes/github-actions); copy the
one you need to `.github/workflows/` as it is.

- [`translify-push.yml`](https://github.com/chesterbrains/translify-cli/blob/main/recipes/github-actions/translify-push.yml)
  runs `push --dry-run` on every pull request and keeps its output in one comment on the PR, updated on each push to the
  branch (a refused push lands there too and fails the job); on `main` it pushes for real, with an optional `publish`
  step. Key scope: `PUSH` (and `PUBLISH` for the optional step). Pull requests from forks are skipped: they have no
  access to secrets.
- [`translify-release.yml`](https://github.com/chesterbrains/translify-cli/blob/main/recipes/github-actions/translify-release.yml)
  is for apps that bundle translations at build time: `lint`, then `pull`, your build, then `publish` to the environment
  chosen in the Actions tab (or on a tag). Key scopes: `PULL` and `PUBLISH`.
- [`translify-pull-on-publish.yml`](https://github.com/chesterbrains/translify-cli/blob/main/recipes/github-actions/translify-pull-on-publish.yml)
  runs when Translify's GitHub webhook announces a publish: `pull --from env:<slug>` for the published environment,
  commit, a pull request with the publish summary, your build, merge. Key scope: `PULL`. Setup in [Webhooks](#webhooks).

All three use `npx -y translify`, so they follow every 0.x release; pin a version (`npx -y @chesterbrains/translify-cli@0.6`) if a breaking
release must not turn the workflow red on its own.

Fail a pull request when local files drift from Translify:

```yaml
- run: npx -y translify status
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

Fail CI when translations in Translify have placeholder errors:

```yaml
- run: npx -y translify lint --max-warnings 0
  env:
    TRANSLIFY_SECRET_KEY: ${{ secrets.TRANSLIFY_SECRET_KEY }}
```

`lint` checks what is stored in Translify, not your local files; run it after `push`, or before `pull`/`publish` on deploy.
It covers what this repository pulls: only the namespaces of fixed-`namespace` rules, or the whole
project when a rule uses `{namespace}`. It needs a key with the `pull` scope.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The request or input was rejected, or `status` found drift, or a destructive flag was not confirmed |
| 2 | Key problem: invalid, revoked, wrong kind of key, or a missing scope |
| 3 | Plan quota exceeded |
| 4 | Network failure, server error, push too large, CLI too old, transaction conflict, or rate limited after 3 retries |
| 5 | `publish --fail-on-withheld`: the publish went through, but the review gate withheld some translations |
| 6 | Placeholder errors: `lint` found them (or more warnings than `--max-warnings`), `publish` refused because translations with errors would go live, or `pull` refused an Angular/Xcode XLIFF, Android or iOS rule |

The server's error `code` decides the exit code first; the HTTP status is only used for codes the CLI does not know.

## Troubleshooting

| Code | Exit | What to do |
|---|---|---|
| `VALIDATION_FAILED` | 1 | Nothing was written. The output lists `file:line key: reason`; fix those entries and push again. |
| `LOCALE_NOT_FOUND` | 1 | A locale in your files is not enabled in the project. Enable it in Translify, or map it with `locales` in `translify.json`. |
| `NAMESPACE_NOT_FOUND` | 1 | The namespace does not exist in the project. Create it in Translify or fix the `--namespace` / pattern. |
| `VALIDATION_FAILED` with `emptySourcePrune` | 1 | `--prune` was refused because a source file in the push has no entries (it would archive the whole namespace). Push the real source file, or drop `--prune`; emptying a namespace is done in the Translify web app. |
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
| `ORPHANS_CHANGED` | 1 | The orphan list changed between the dry run and the real push (keys were added, removed, archived or restored). Nothing was written; run `translify push --prune` again to review the new list. |
| `REVIEW_DISABLED` | 1 | `push --status draft` or `--status needs-review` on a project without review. Turn on **Require review** in the project settings, or drop `--status`. Nothing was written. |
| `APPROVED_ONLY_REQUIRES_WORKING` | 1 | `--only-approved` was combined with `--from env:<slug>`. Pull an environment without it; it already holds only what its gate allowed. |
| `INVALID_CELLS` | 6 | `publish` refused: translations that would go live have placeholder errors. Nothing was published; the output lists them like `lint` does. Fix them in Translify, or re-run with `--allow-errors` to publish anyway (recorded in the activity log). |
| `XLIFF_DIALECT_UNSUPPORTED` | 6 | `pull` refused: a translation cannot be written in the rule's XLIFF dialect (Angular: text beside a plural, nested plurals, number/date formats; Xcode: `select`, `=0`/`offset`, a translation of a different shape; both: printf/i18next keys). Nothing was written; the output lists the cells and why. Split the text, or move the key to a JSON rule. See [Angular (XLIFF)](#angular-xliff) and [Xcode (XLIFF)](#xcode-xliff). |
| `ANDROID_UNSUPPORTED` | 6 | `pull` refused: a translation cannot be written as Android `strings.xml` (`select`, `=0`/`offset`, text around a plural, two or nested plurals, an unknown number format, a translation of a different shape, printf/i18next keys, a key with `-` or a leading digit, a gapped array). Nothing was written; the output lists the cells and why. Split the text, or move the key to a JSON rule. See [Android (strings.xml)](#android-stringsxml). |
| `STRINGS_UNSUPPORTED` | 6 | `pull` refused: a translation cannot be written as iOS `.strings` / `.stringsdict` (`select`, exact matches other than `=0`, `offset`, two or nested plurals, an unknown number format, a translation of a different shape, printf/i18next keys). Nothing was written; the output lists the cells and why. Split the text, or move the key to a JSON rule. See [iOS (.strings / .stringsdict)](#ios-strings--stringsdict). |
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
