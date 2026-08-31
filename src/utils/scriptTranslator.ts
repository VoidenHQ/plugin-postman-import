/**
 * Best-effort translation of a Postman `pm.*` pre-request/test script into
 * Voiden's `voiden.*` scripting API (see the voiden-scripting skill for the
 * full target API). Translation only happens if the ENTIRE script resolves
 * to recognized, safe patterns — if any line contains something this module
 * doesn't understand (control flow, `pm.sendRequest`, an unrecognized chai
 * matcher, custom helper functions, ...), the WHOLE script is left
 * untranslated and falls back to the existing commented-out rendering.
 * Never a half-translated, half-commented script.
 *
 * Chai matcher → voiden.assert operator mapping is shared conceptually with
 * bruno-importer's and insomnia-importer's translators — all three tools
 * embed the same Chai.js BDD library, only the wrapping function names
 * (`pm.test`/`test`/`insomnia.test`, `pm.expect`/`expect`/`insomnia.expect`)
 * and field-access syntax differ.
 */

// Postman collapses 4 variable scopes (environment/collection/global/local)
// into Voiden's single runtime-variable store — a real simplification, not
// a perfect equivalent, but the only R/W store voiden.* scripting exposes.
const PM_VAR_SCOPES = ['environment', 'collectionVariables', 'globals', 'variables'];

// Chai matcher name → voiden.assert operator. `matches`/`.to.match(regex)` is
// deliberately excluded — voiden.assert's exact handling of a RegExp value
// for the "matches" operator isn't confirmed, so guessing wrong isn't worth
// the risk; that one matcher always falls back to unsafe.
// Keys here are the plain matcher text as it actually appears in source code
// (e.g. "be.below", dot not escaped) — these double as regex capture-group
// lookup keys, so they must match exactly what `RegExpMatchArray` returns.
// Escaping for the regex ALTERNATION itself happens separately, in
// escapeForAlternation() below — never store an escaped key here.
const CHAI_MATCHER_MAP: Record<string, string> = {
  eql: '==',
  equal: '===',
  'be.above': '>',
  'be.greaterThan': '>',
  'be.at.least': '>=',
  'be.gte': '>=',
  'be.below': '<',
  'be.lessThan': '<',
  'be.at.most': '<=',
  'be.lte': '<=',
  include: 'contains',
  contain: 'contains',
};
// Negation only supported where unambiguous.
const CHAI_NOT_MATCHER_MAP: Record<string, string> = {
  eql: '!=',
  equal: '!==',
};
// Property-style matchers — no parens/argument.
const CHAI_PROPERTY_MATCHERS: Record<string, string> = {
  'be.true': 'truthy',
  'be.ok': 'truthy',
  'be.false': 'falsy',
};

function escapeForAlternation(keys: string[]): string {
  return keys.map((k) => k.replace(/\./g, '\\.')).join('|');
}

const MATCHER_ALTERNATION = escapeForAlternation(Object.keys(CHAI_MATCHER_MAP));

/**
 * Apply all the direct pm.* → voiden.* substitutions that are safe anywhere
 * in an expression (not just as a whole statement) — variable get/set,
 * response/request field access, console.log. Runs BEFORE assert-line
 * matching so a variable call nested inside an expect() argument (e.g.
 * `pm.environment.get("uid")` inside `.to.eql("x" + pm.environment.get("uid"))`)
 * is already voiden.* by the time that line is checked.
 */
function substituteKnownCalls(text: string): string {
  let out = text;
  for (const scope of PM_VAR_SCOPES) {
    out = out.replace(new RegExp(`pm\\.${scope}\\.set\\(`, 'g'), 'voiden.variables.set(');
    out = out.replace(new RegExp(`pm\\.${scope}\\.get\\(`, 'g'), 'voiden.variables.get(');
  }
  out = out.replace(/pm\.response\.json\(\)/g, 'voiden.response.body');
  out = out.replace(/pm\.response\.text\(\)/g, 'voiden.response.body');
  out = out.replace(/pm\.response\.code\b/g, 'voiden.response.status');
  out = out.replace(/pm\.response\.status\b/g, 'voiden.response.statusText');
  out = out.replace(/pm\.response\.responseTime\b/g, 'voiden.response.time');
  out = out.replace(/pm\.response\.responseSize\b/g, 'voiden.response.size');
  out = out.replace(/pm\.response\.headers\.get\((.+?)\)/g, 'voiden.response.headers[$1]');
  out = out.replace(/pm\.request\.headers\.add\(/g, 'voiden.request.headers.push(');
  out = out.replace(/pm\.request\.url\b/g, 'voiden.request.url');
  out = out.replace(/pm\.request\.method\b/g, 'voiden.request.method');
  out = out.replace(/pm\.request\.body\.raw\b/g, 'voiden.request.body');
  out = out.replace(/console\.log\(/g, 'voiden.log(');
  return out;
}

// A captured sub-expression (the "actual" or "arg" inside expect(...)) must
// itself be free of any remaining pm.* token before the match is accepted —
// matching the outer expect(...).to.X(...) shape is not enough on its own.
// Without this, something like
// `pm.expect(pm.response.headers.get("x")).to.eql(y)` — a call this module
// doesn't substitute — would shape-match and get accepted with a literal,
// untranslated pm.* call left inside the "safe" output, exactly the
// half-translated result this module exists to prevent.
function hasForeignToken(expr: string): boolean {
  return /\bpm\.\w/.test(expr);
}

/** Translate one `pm.expect(EXPR).to.MATCHER(ARG)` / `.to.be.true` statement. Returns null if unrecognized. */
function translateExpectStatement(line: string): string | null {
  const trimmed = line.trim();

  for (const [matcher, op] of Object.entries(CHAI_PROPERTY_MATCHERS)) {
    const re = new RegExp(`^pm\\.expect\\((.+)\\)\\s*\\.to\\.${matcher.replace(/\./g, '\\.')}\\s*;?$`);
    const m = trimmed.match(re);
    if (m) {
      if (hasForeignToken(m[1])) return null;
      return `voiden.assert(${m[1]}, "${op}");`;
    }
  }

  const callRe = new RegExp(`^pm\\.expect\\((.+?)\\)\\s*\\.to\\.(not\\.)?(${MATCHER_ALTERNATION})\\((.*)\\)\\s*;?$`);
  const m = trimmed.match(callRe);
  if (!m) return null;
  const [, actual, notPrefix, matcher, arg] = m;
  const op = notPrefix ? CHAI_NOT_MATCHER_MAP[matcher] : CHAI_MATCHER_MAP[matcher];
  if (!op) return null; // negation not supported for this particular matcher
  if (hasForeignToken(actual) || hasForeignToken(arg)) return null;
  return `voiden.assert(${actual}, "${op}", ${arg});`;
}

/** Postman's `pm.response.to.have.status(n)` shorthand — no expect()/test() involved. */
function translateStatusShorthand(line: string): string | null {
  const m = line.trim().match(/^pm\.response\.to\.have\.status\((.+?)\)\s*;?$/);
  if (!m) return null;
  if (hasForeignToken(m[1])) return null;
  return `voiden.assert(voiden.response.status, "==", ${m[1]}, "Status is ${m[1].replace(/["'`]/g, '')}");`;
}

const TEST_OPEN_RE = /^pm\.test\(\s*(['"]).*?\1\s*,\s*(function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{\s*$/;
const TEST_CLOSE_RE = /^\}\s*\)\s*;?\s*$/;

/**
 * Join a chained-method continuation (a line ending mid-expression, with the
 * next line starting with `.`) back into one logical line before per-line
 * matching — real-world formatting often wraps a long `expect(...)` chain
 * across lines (confirmed in a real Kong/insomnia example fixture using the
 * same shape: `expect(...)\n  .to.eql(...)`), which the per-line matchers
 * below can't see across otherwise. Purely mechanical — not general JS
 * parsing — so it only fixes this one specific, common shape.
 */
function joinChainedMethodLines(lines: string[]): string[] {
  const joined: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const prev = joined[joined.length - 1];
    if (prev !== undefined && trimmed.startsWith('.') && !/[;{}]\s*(\/\/.*)?$/.test(prev)) {
      joined[joined.length - 1] = `${prev} ${trimmed}`;
    } else {
      joined.push(line);
    }
  }
  return joined;
}

/**
 * Translate a full script. Returns { body, safe: true } with a live
 * voiden.*-only script when every line resolved; { safe: false } (body is
 * the original untouched text) when anything was unrecognized, signaling
 * the caller to fall back to the commented-out rendering instead.
 */
export function translatePostmanScript(rawScript: string): { body: string; safe: boolean } {
  const substituted = substituteKnownCalls(rawScript);
  const lines = joinChainedMethodLines(substituted.split(/\r?\n/));
  const out: string[] = [];
  let inTestBlock = false;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (trimmed === '') { out.push(''); continue; }
    if (trimmed.startsWith('//')) { out.push(line); continue; }

    if (!inTestBlock && TEST_OPEN_RE.test(trimmed)) { inTestBlock = true; continue; } // drop pm.test(...) { wrapper
    if (inTestBlock && TEST_CLOSE_RE.test(trimmed)) { inTestBlock = false; continue; } // drop closing });

    const statusLine = translateStatusShorthand(trimmed);
    if (statusLine) { out.push(statusLine); continue; }

    const expectLine = translateExpectStatement(trimmed);
    if (expectLine) { out.push(expectLine); continue; }

    // Anything with no remaining foreign token (pm.*, still-open test(/expect() calls)
    // is already fully substituted plain JS / voiden.* — safe to keep as-is.
    if (!/\bpm\.\w|\bpm\.test\(|\bpm\.expect\(/.test(trimmed)) { out.push(line); continue; }

    // Unrecognized construct — bail out for the whole script.
    return { body: rawScript, safe: false };
  }

  if (inTestBlock) return { body: rawScript, safe: false }; // unterminated block — regex mismatch, don't risk it

  return { body: out.join('\n'), safe: true };
}
