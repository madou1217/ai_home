'use strict';

// Go-compatible identity component primitives.
//
// Both the Codex and the Claude identity vectors have to be byte-identical to
// Go's, because accountRef is `acct_` + sha256('unique:' + seed)[:20] on both
// sides. A one-character seed difference mints a second account for the same
// upstream account.
//
// These live in one module on purpose. The rules below are subtle enough that a
// second copy would drift: Go's `strings.TrimSpace` follows `unicode.IsSpace`,
// which is *not* JS `\s` (it includes U+0085 NEL), and Go's `firstNonEmpty`
// returns the trimmed value while skipping values that trim to empty.
//
// See docs/architecture/codex-oauth-identity-vector-adr.md.

// U+0085 (NEL) and U+00A0 (NBSP) are in Go's `unicode.IsSpace` but not in JS
// `\s`, so a leading or trailing NEL would otherwise survive here.
const GO_SPACE_CLASS = '\\s\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const GO_SPACE_LEADING = new RegExp(`^[${GO_SPACE_CLASS}]+`);
const GO_SPACE_TRAILING = new RegExp(`[${GO_SPACE_CLASS}]+$`);

// Go caps the normalized email at 320 characters.
const MAX_EMAIL_LENGTH = 320;

// RFC 5322 `atext` — the characters allowed in a dot-atom (local part or domain
// label). Notably absent: `:` `;` `<` `>` `[` `]` `"` `,` and whitespace.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOT_ATOM = `${ATEXT}+(?:\\.${ATEXT}+)*`;
// `[127.0.0.1]` style address literals — Go accepts these (`mail.ParseAddress`).
const ADDRESS_LITERAL = '\\[[^\\]\\s]+\\]';
const EMAIL_PATTERN = new RegExp(`^${DOT_ATOM}@(?:${DOT_ATOM}|${ADDRESS_LITERAL})$`);

// Mirrors Go's `strings.TrimSpace` for the code points that matter here.
function trimGoSpace(value) {
  return String(value || '').replace(GO_SPACE_LEADING, '').replace(GO_SPACE_TRAILING, '');
}

// Mirrors Go's `firstNonEmpty`: return the first value whose **Go-trimmed** form
// is non-empty, and return it *trimmed*.
function firstGoTrimmedNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimGoSpace(value);
    if (trimmed) return trimmed;
  }
  return '';
}

// Mirrors Go's `hasControlCharacter`: any rune < 0x20 or == 0x7f.
function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(String(value || ''));
}

// Mirrors Go's `isIdentityComponent`: non-empty after a Go-style trim, no `:`
// (it would make the colon-separated seed ambiguous), no U+FFFD (Go rejects
// `utf8.RuneError`), no control characters.
function isIdentityComponent(value) {
  const normalized = trimGoSpace(value);
  if (!normalized) return false;
  if (normalized.includes(':')) return false;
  if (normalized.includes('\uFFFD')) return false;
  return !hasControlCharacter(normalized);
}

// Mirrors Go's `normalizeEmail` in the agy and claude packages
// (core/accounts/agy/oauth.go:146, core/accounts/claude/validation.go:53):
// trim, lowercase, then require a well-formed address.
//
// Go additionally runs the result through `mail.ParseAddress` (RFC 5322) and
// requires `parsed.Address === normalized`. Shipping a full RFC 5322 parser to
// JS is not worth it, but the *reachable* subset is small and was probed
// directly against Go's implementation. What it enforces:
//
//   local part      dot-atom (RFC 5322 atext, dot-separated, no empty atoms)
//   domain          dot-atom, or an address literal `[...]`
//   either side     non-empty, no whitespace, no control characters, no U+FFFD
//   whole value     exactly one `@`, length <= 320
//
// Verified against Go for every case below — all agree:
//   ACCEPT  user@example.com, USER@Example.COM, " user@example.com ",
//           user@localhost (no dot required), a+b@c.com, a_b@c.com, a-b@c.com,
//           a@[127.0.0.1]
//   REJECT  a:b@c.com (colon is not atext), a..b@c.com, .a@c.com, a.@c.com,
//           "a b"@c.com (quoted local part), a@c.com., a@@c.com, @c.com, a@,
//           a b@c.com
//
// Residual: Go's parser also accepts a few exotic forms a real provider login
// never produces (for example an RFC 5322 comment or a quoted local part with
// escaped characters). Where the two differ this rejects, so the failure
// direction is closed — we refuse to mint an identity rather than invent one Go
// would never produce.
//
// Returns '' when any check fails, which callers treat as
// `identity_unverifiable`.
function normalizeEmailComponent(raw) {
  const normalized = trimGoSpace(raw).toLowerCase();
  if (!normalized || normalized.length > MAX_EMAIL_LENGTH) return '';
  if (normalized.includes('\uFFFD')) return '';
  if (hasControlCharacter(normalized)) return '';
  if (/\s/.test(normalized)) return '';
  if (normalized.split('@').length !== 2) return '';
  return EMAIL_PATTERN.test(normalized) ? normalized : '';
}

// Go's `uuidPattern` (core/accounts/claude/validation.go).
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Mirrors Go's `normalizeUUID` (core/accounts/claude/validation.go:42):
//   - the raw value must already be trimmed (`raw != TrimSpace(raw)` is an error,
//     not something Go silently fixes);
//   - it must match the UUID pattern;
//   - it is lowercased.
//
// Returns '' when any of those fail, which callers treat as
// `identity_unverifiable`. Skipping the lowercase step is not cosmetic: it makes
// an uppercase UUID produce a different accountRef than Go's for the same
// account.
function normalizeUuidComponent(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = trimGoSpace(raw);
  if (raw !== trimmed) return '';
  if (!UUID_PATTERN.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

module.exports = {
  GO_SPACE_CLASS,
  MAX_EMAIL_LENGTH,
  UUID_PATTERN,
  firstGoTrimmedNonEmpty,
  hasControlCharacter,
  isIdentityComponent,
  normalizeEmailComponent,
  normalizeUuidComponent,
  trimGoSpace
};
