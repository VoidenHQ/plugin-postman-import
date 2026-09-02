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

// Chai matcher name → voiden.assert operator. `.to.match(regex)` is handled
// separately (translateMatchStatement below), not through this map — its
// argument is a regex literal, not a plain expression, so it needs its own
// extraction logic. Confirmed against voiden-scripting's actual runtime
// (plugins/voiden-scripting/src/lib/scriptEngine.ts's evaluateAssertion):
// the "matches" operator does `new RegExp(String(expected)).test(String(actual))`
// — `expected` must be the regex's plain source text (no `/.../ ` delimiters,
// no flags), not a RegExp object (`String(/foo/)` would stringify to the
// literal text `"/foo/"`, delimiters included, which `new RegExp(...)` would
// then treat as literal slash characters to match — silently wrong).
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

/**
 * Translate one `pm.expect(EXPR).to.MATCHER(ARG)` / `.to.be.true` statement.
 * Returns null if unrecognized. `testName` is the enclosing `pm.test("...",
 * ...)`'s description, if any — carried through as `voiden.assert`'s
 * message argument so it isn't silently lost (Postman's own test runner
 * surfaces that string per-assertion in its report; dropping it would make
 * a failure harder to place than the original script was).
 */
function translateExpectStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();

  for (const [matcher, op] of Object.entries(CHAI_PROPERTY_MATCHERS)) {
    const re = new RegExp(`^pm\\.expect\\((.+)\\)\\s*\\.to\\.${matcher.replace(/\./g, '\\.')}\\s*;?$`);
    const m = trimmed.match(re);
    if (m) {
      if (hasForeignToken(m[1])) return null;
      const messageArg = testName !== null ? `, undefined, ${JSON.stringify(testName)}` : '';
      return `voiden.assert(${m[1]}, "${op}"${messageArg});`;
    }
  }

  const callRe = new RegExp(`^pm\\.expect\\((.+?)\\)\\s*\\.to\\.(not\\.)?(${MATCHER_ALTERNATION})\\((.*)\\)\\s*;?$`);
  const m = trimmed.match(callRe);
  if (!m) return null;
  const [, actual, notPrefix, matcher, arg] = m;
  const op = notPrefix ? CHAI_NOT_MATCHER_MAP[matcher] : CHAI_MATCHER_MAP[matcher];
  if (!op) return null; // negation not supported for this particular matcher
  if (hasForeignToken(actual) || hasForeignToken(arg)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(${actual}, "${op}", ${arg}${messageArg});`;
}

/** Postman's `pm.response.to.have.status(n)` shorthand — no expect()/test() involved. */
function translateStatusShorthand(line: string, testName: string | null): string | null {
  const m = line.trim().match(/^pm\.response\.to\.have\.status\((.+?)\)\s*;?$/);
  if (!m) return null;
  if (hasForeignToken(m[1])) return null;
  const message = testName ?? `Status is ${m[1].replace(/["'`]/g, '')}`;
  return `voiden.assert(voiden.response.status, "==", ${m[1]}, ${JSON.stringify(message)});`;
}

/**
 * Postman's `pm.response.to.be.json` shorthand — a bare Chai property-getter
 * statement (no call, no expect() wrapper) that validates the response's
 * Content-Type. Approximated as a header-contains check rather than
 * re-parsing the body (Voiden's response.body is already parsed if JSON, so
 * there's nothing left to re-validate there).
 */
function translateJsonShorthand(line: string, testName: string | null): string | null {
  const m = line.trim().match(/^pm\.response\.to\.be\.json\s*;?$/);
  if (!m) return null;
  const message = testName ?? 'Response is JSON';
  return `voiden.assert(voiden.response.headers["content-type"], "contains", "json", ${JSON.stringify(message)});`;
}

/**
 * `pm.expect(EXPR).to.(not.)have.property(ARG)` — Chai's property-existence
 * matcher. Approximated via voiden.assert's "truthy"/"falsy" on a bracket
 * access, since there's no dedicated "has property" operator. This is not a
 * perfect equivalent — a property present but holding a falsy value (`0`,
 * `""`, `false`) would read as "missing" here — but it's the right call for
 * the overwhelmingly common case (checking a key exists on a JSON body).
 */
function translatePropertyStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.(not\.)?have\.property\((.+?)\)\s*;?$/);
  if (!m) return null;
  const [, actual, notPrefix, arg] = m;
  if (hasForeignToken(actual) || hasForeignToken(arg)) return null;
  const op = notPrefix ? 'falsy' : 'truthy';
  const messageArg = testName !== null ? `, undefined, ${JSON.stringify(testName)}` : '';
  return `voiden.assert((${actual})[${arg}], "${op}"${messageArg});`;
}

/**
 * `pm.expect(EXPR).to.be.within(MIN, MAX)` — Chai's inclusive-range matcher
 * (the shape behind Postman's own common `.to.be.within(200, 299)` status-
 * range idiom). There's no single `voiden.assert` operator for "between", so
 * this expands into two calls (`>=` MIN and `<=` MAX) that must both pass —
 * equivalent to the original range check. The negated form
 * (`.to.not.within(...)`, meaning "outside the range") isn't handled: that's
 * an OR of two conditions, which can't be expressed as two independent
 * `voiden.assert` calls that both need to pass, so it correctly falls
 * through to the unrecognized-construct path instead.
 */
function translateWithinStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.be\.within\((.+?),\s*(.+?)\)\s*;?$/);
  if (!m) return null;
  const [, actual, min, max] = m;
  if (hasForeignToken(actual) || hasForeignToken(min) || hasForeignToken(max)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(${actual}, ">=", ${min}${messageArg});\nvoiden.assert(${actual}, "<=", ${max}${messageArg});`;
}

/**
 * `pm.expect(EXPR).to.match(/pattern/)` — Chai's regex-match matcher.
 * Only a literal, flag-less regex argument translates (`/pattern/`, no
 * `/pattern/i` etc.) — voiden.assert's "matches" operator does
 * `new RegExp(String(expected)).test(String(actual))`, which has no way to
 * carry regex flags through, so a flagged regex would silently lose its
 * flag's meaning if translated; a non-literal argument (a variable holding a
 * RegExp) is also left alone since `String(aRegexObject)` includes the
 * `/.../ ` delimiters, which would corrupt the pattern.
 */
function translateMatchStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.match\(\s*\/(.+)\/\s*\)\s*;?$/);
  if (!m) return null;
  const [, actual, pattern] = m;
  if (hasForeignToken(actual)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(${actual}, "matches", ${JSON.stringify(pattern)}${messageArg});`;
}

/**
 * `pm.expect(EXPR).to.(not.)be.null` / `.to.(not.)be.undefined` /
 * `.to.(not.)exist`. Chai's `.exist`/`.not.exist` check "not null AND not
 * undefined" — expressible exactly with voiden.assert's loose `!=`/`==`
 * against `null`, since JS's loose equality treats `null == undefined` as
 * true. `.null`/`.undefined` are strict checks, so they use `===`/`!==`.
 */
function translateExistenceStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const patterns: Array<[RegExp, string, 'null' | 'undefined']> = [
    [/^pm\.expect\((.+?)\)\s*\.to\.not\.be\.null\s*;?$/, '!==', 'null'],
    [/^pm\.expect\((.+?)\)\s*\.to\.be\.null\s*;?$/, '===', 'null'],
    [/^pm\.expect\((.+?)\)\s*\.to\.not\.be\.undefined\s*;?$/, '!==', 'undefined'],
    [/^pm\.expect\((.+?)\)\s*\.to\.be\.undefined\s*;?$/, '===', 'undefined'],
    [/^pm\.expect\((.+?)\)\s*\.to\.not\.exist\s*;?$/, '==', 'null'],
    [/^pm\.expect\((.+?)\)\s*\.to\.exist\s*;?$/, '!=', 'null'],
  ];
  for (const [re, op, literal] of patterns) {
    const m = trimmed.match(re);
    if (!m) continue;
    if (hasForeignToken(m[1])) return null;
    const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
    return `voiden.assert(${m[1]}, "${op}", ${literal}${messageArg});`;
  }
  return null;
}

// typeof-safe type names only — "array"/"object"/"null"/"date" etc. can't be
// distinguished by `typeof` alone (typeof [] === typeof {} === "object"), so
// `.to.be.a("array")` etc. are deliberately excluded here and fall through
// to the unrecognized-construct fallback instead of risking a wrong check.
const TYPEOF_SAFE_TYPES = new Set(['string', 'number', 'boolean', 'function', 'undefined', 'bigint', 'symbol']);

/** `pm.expect(EXPR).to.be.a("string")` / `.to.be.an("number")` — Chai's type matcher, typeof-safe subset only. */
function translateTypeofStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.be\.an?\(\s*(['"])(.+?)\2\s*\)\s*;?$/);
  if (!m) return null;
  const [, actual, , typeName] = m;
  if (hasForeignToken(actual)) return null;
  if (!TYPEOF_SAFE_TYPES.has(typeName)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(typeof (${actual}), "==", ${JSON.stringify(typeName)}${messageArg});`;
}

/** `pm.expect(EXPR).to.have.lengthOf(n)` — exact for both strings and arrays, both of which carry a real `.length`. */
function translateLengthOfStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.have\.lengthOf\((.+?)\)\s*;?$/);
  if (!m) return null;
  const [, actual, len] = m;
  if (hasForeignToken(actual) || hasForeignToken(len)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert((${actual}).length, "==", ${len}${messageArg});`;
}

/**
 * `pm.expect(EXPR).to.be.oneOf([...])` — Chai's array-membership matcher.
 * voiden.assert's "contains" operator checks `actual.includes(expected)`
 * when `actual` is an array, so this translates by swapping which side is
 * "actual" — the options array becomes voiden.assert's `actual`, and the
 * value being checked becomes its `expected`.
 */
function translateOneOfStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.be\.oneOf\((.+?)\)\s*;?$/);
  if (!m) return null;
  const [, actual, options] = m;
  if (hasForeignToken(actual) || hasForeignToken(options)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(${options}, "contains", ${actual}${messageArg});`;
}

/**
 * `pm.expect(EXPR).to.be.closeTo(expected, delta)` — Chai's approximate-
 * number matcher. No single voiden.assert operator for "close to", so this
 * expands into the same two-sided range check `.within` uses, with the
 * bounds computed as arithmetic expressions in the *generated* code (not
 * evaluated here) — `expected - delta` and `expected + delta`.
 */
function translateCloseToStatement(line: string, testName: string | null): string | null {
  const trimmed = line.trim();
  const m = trimmed.match(/^pm\.expect\((.+?)\)\s*\.to\.be\.closeTo\((.+?),\s*(.+?)\)\s*;?$/);
  if (!m) return null;
  const [, actual, expected, delta] = m;
  if (hasForeignToken(actual) || hasForeignToken(expected) || hasForeignToken(delta)) return null;
  const messageArg = testName !== null ? `, ${JSON.stringify(testName)}` : '';
  return `voiden.assert(${actual}, ">=", (${expected}) - (${delta})${messageArg});\nvoiden.assert(${actual}, "<=", (${expected}) + (${delta})${messageArg});`;
}

// Captures the test's description text (group 2) so callers can thread it
// through as each assertion's voiden.assert message argument.
const TEST_OPEN_RE = /^pm\.test\(\s*(['"])(.*?)\1\s*,\s*(function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{\s*$/;
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
  let currentTestName: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (trimmed === '') { out.push(''); continue; }
    if (trimmed.startsWith('//')) { out.push(line); continue; }

    if (!inTestBlock) {
      const openMatch = trimmed.match(TEST_OPEN_RE);
      if (openMatch) { inTestBlock = true; currentTestName = openMatch[2]; continue; } // drop pm.test(...) { wrapper, keep its name
    }
    if (inTestBlock && TEST_CLOSE_RE.test(trimmed)) { inTestBlock = false; currentTestName = null; continue; } // drop closing });

    const statusLine = translateStatusShorthand(trimmed, currentTestName);
    if (statusLine) { out.push(statusLine); continue; }

    const jsonLine = translateJsonShorthand(trimmed, currentTestName);
    if (jsonLine) { out.push(jsonLine); continue; }

    const propertyLine = translatePropertyStatement(trimmed, currentTestName);
    if (propertyLine) { out.push(propertyLine); continue; }

    const withinLine = translateWithinStatement(trimmed, currentTestName);
    if (withinLine) { out.push(withinLine); continue; }

    const matchLine = translateMatchStatement(trimmed, currentTestName);
    if (matchLine) { out.push(matchLine); continue; }

    const existenceLine = translateExistenceStatement(trimmed, currentTestName);
    if (existenceLine) { out.push(existenceLine); continue; }

    const typeofLine = translateTypeofStatement(trimmed, currentTestName);
    if (typeofLine) { out.push(typeofLine); continue; }

    const lengthOfLine = translateLengthOfStatement(trimmed, currentTestName);
    if (lengthOfLine) { out.push(lengthOfLine); continue; }

    const oneOfLine = translateOneOfStatement(trimmed, currentTestName);
    if (oneOfLine) { out.push(oneOfLine); continue; }

    const closeToLine = translateCloseToStatement(trimmed, currentTestName);
    if (closeToLine) { out.push(closeToLine); continue; }

    const expectLine = translateExpectStatement(trimmed, currentTestName);
    if (expectLine) { out.push(expectLine); continue; }

    // Anything with no remaining foreign token (pm.*, still-open test(/expect() calls)
    // is already fully substituted plain JS / voiden.* — safe to keep as-is.
    // require(...)/import are left as-is deliberately: Voiden's JS scripting
    // engine runs each script in a real Node.js subprocess (see
    // voiden-scripting's scriptEngine.ts — spawned with `cwd: projectPath`,
    // a real require() passed into the script function), so a plain
    // `require('moment')`-style call is exactly as usable here as it is in
    // Postman itself, resolving against the active Voiden project's own
    // node_modules. Whether that specific package is actually installed in
    // the project is a runtime concern for the user, not a translation-
    // safety concern for this module.
    if (!/\bpm\.\w|\bpm\.test\(|\bpm\.expect\(/.test(trimmed)) { out.push(line); continue; }

    // Unrecognized construct — bail out for the whole script.
    return { body: rawScript, safe: false };
  }

  if (inTestBlock) return { body: rawScript, safe: false }; // unterminated block — regex mismatch, don't risk it

  return { body: out.join('\n'), safe: true };
}
