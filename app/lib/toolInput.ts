/**
 * A tool answer with its fields put back where they belong.
 *
 * A forced tool call does not guarantee the shape of what comes back. On a real
 * tailor — IBM's AI Software Engineer Intern posting, five attempts in three
 * minutes, all refunded — the model returned ONE field. `structure` held a
 * complete, valid resume, and then, still inside the same string, every other
 * answer it had been asked for, in the wire format of the call itself:
 *
 *     {"summary":…,"experience":[…],…}</parameter>
 *     <parameter name="log">[…]</parameter>
 *     <parameter name="matchScore">40</parameter>
 *     …
 *     </invoke>
 *
 * Nothing downstream could read that. The honesty pass saw a string where a
 * resume should be and found no entries, the guard found nothing to pair, and
 * the route refused it as unusable. Nothing had been lost — the resume and all
 * five other answers were sitting right there — it had only been put in the
 * wrong box. A sixth attempt on the same resume came back well-formed and saved,
 * so this is intermittent rather than tied to one profile, which is exactly why
 * retrying told the person nothing.
 *
 * It is not new either. Before the route learned to refuse an unusable answer,
 * the guard restored every entry from the profile and saved THAT as the
 * tailored resume — the "Amazon" run, 28 of 28 bullets untouched, a credit
 * spent. Refusing made the failure visible; this makes it recoverable.
 *
 * Deliberately conservative. A field is only rebuilt when it is provably in the
 * wrong shape — a string where the schema asks for an object or array, or text
 * carrying the call's own parameter markers — and a field that arrived properly
 * is never overwritten by a copy found inside another. When the text cannot be
 * read as what the schema wants, it is left exactly as it came, so the honest
 * "that came back unusable" still fires instead of a guess being saved.
 */

/** The part of a tool definition this reads. `Anthropic.Tool` satisfies it. */
export interface ToolShape {
  input_schema: { properties?: unknown };
}

const OPEN = '<parameter name="';
const CLOSE = '</parameter>';
const JAMMED_PARAMETER = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g;

const typeOf = (schema: unknown): string | undefined => {
  const type = (schema as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type : undefined;
};

/**
 * The first complete JSON object or array at the front of some text.
 *
 * Braces inside strings are skipped, so a bullet that mentions "{curly}" does
 * not end the resume early.
 */
function leadingJson(text: string): unknown {
  const start = text.search(/\S/);
  if (start < 0 || (text[start] !== '{' && text[start] !== '[')) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Text read as the type the schema asks for, or undefined when it is not one. */
function asType(text: string, type: string | undefined): unknown {
  const trimmed = text.trim();
  switch (type) {
    case 'string':
      return trimmed;
    case 'integer':
    case 'number': {
      const n = Number(trimmed);
      if (!trimmed || !Number.isFinite(n)) return undefined;
      return type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
    default:
      try {
        return JSON.parse(trimmed);
      } catch {
        return leadingJson(trimmed);
      }
  }
}

/**
 * The tool's answer with every recoverable field in its own place.
 *
 * `repaired` names what was rebuilt, so the caller can log it: a recovery that
 * happens silently is a model misbehaviour nobody can count.
 */
export function recoverToolInput(
  input: unknown,
  tool: ToolShape,
): { input: Record<string, unknown>; repaired: string[] } {
  const given =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const properties = (tool.input_schema?.properties ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...given };
  const repaired: string[] = [];

  for (const [name, value] of Object.entries(given)) {
    if (typeof value !== 'string') continue;

    const type = typeOf(properties[name]);
    const jammed = value.includes(OPEN) || value.includes(CLOSE);
    const structured = type === 'object' || type === 'array';
    // An ordinary string field is somebody's text — a job description, a
    // reason — and is never reinterpreted unless the call's own markers prove
    // something else was swallowed into it.
    if (!jammed && !structured) continue;

    // This field's own value is everything before the first marker.
    const markers = [value.indexOf(CLOSE), value.indexOf(OPEN)].filter((i) => i >= 0);
    const head = markers.length ? value.slice(0, Math.min(...markers)) : value;
    const own = asType(head, type);
    if (own !== undefined && (!structured || (typeof own === 'object' && own !== null))) {
      out[name] = own;
      repaired.push(name);
    }

    if (!jammed) continue;
    for (const [, other, text] of value.matchAll(JAMMED_PARAMETER)) {
      // Never overwrite a field that arrived properly, and never invent one the
      // tool does not have.
      if (other === name || other in given || !(other in properties) || other in out) continue;
      const recovered = asType(text, typeOf(properties[other]));
      if (recovered === undefined) continue;
      out[other] = recovered;
      repaired.push(other);
    }
  }

  return { input: out, repaired };
}
