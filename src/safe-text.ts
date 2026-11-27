/**
 * Control characters: C0 (escape, newline, tab and bell included), delete, C1, and the two Unicode line breaks.
 * Built from code points, so no raw control character sits in this source file.
 */
const CONTROL: RegExp = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x2028, 0x2029],
  ]
    .map(([from, to]) => `\\u{${(from as number).toString(16)}}-\\u{${(to as number).toString(16)}}`)
    .join('')}]`,
  'gu',
);

/**
 * Text that came from the server (a key, a namespace, a locale, a message) made safe to print on a terminal:
 * every control character is shown as an escape (`\x1b`, `\n`, `\u2028`) instead of being sent. A name stored in
 * Translify could otherwise move the cursor, recolour or overwrite lines of the output, or fake a line of it. The
 * server's own rules keep keys and namespaces clean today; the CLI does not rely on that. Never used for `--json`
 * output or for a value printed raw on request (`translify get <key> <locale>`).
 */
export function safeText(text: string): string {
  return text.replace(CONTROL, (char) => {
    if (char === '\n') return '\\n';
    if (char === '\r') return '\\r';
    if (char === '\t') return '\\t';
    const point: number = char.codePointAt(0) ?? 0;

    return point <= 0xff ? `\\x${point.toString(16).padStart(2, '0')}` : `\\u${point.toString(16).padStart(4, '0')}`;
  });
}
