# Stable native identities: registration, renewal and export boundaries

## Contract

A local account is named by a Provider's stable identity, not a changing email,
access token, refresh token, file timestamp or CLI numeric alias. An unavailable
stable identity is `identity_unverifiable`; it does not allocate a substitute
account. Gemini and Antigravity retain their separately documented, validated
email exception. Static API keys retain their genuine key-fingerprint vector.

This change affects **new identity derivation and same-user capture**. Existing
account references are not silently rekeyed. Their explicit migration uses a
separate reviewed transaction tool. A known account with legacy credentials can
still be exported: backup is not a fresh registration attempt.

## Policy modules and exact vectors

| Module | Verified identity material | Vector |
|---|---|---|
| `subject-oauth-identity.js` | Consistent Kimi user ID / JWT subject | `oauth:kimi:user:<sha256(subject)[:16]>` |
| Same module | Consistent CodeBuddy-family user ID, with Provider-scoped prefix | `oauth:<provider>:user:<sha256(subject)[:16]>` |
| Same module | ZCode's decoded native user ID / consistent JWT subject | `oauth:zcode:user:<sha256(subject)[:16]>` |
| `qoder-auth-metadata.js` | Materialized native UID plus actual grant | `oauth:<qoder\|qodercn>:uid:<uid>` |
| `opencode-identity.js` | Complete normalized upstream grant set | `oauth:opencode:auth:<sha256(sorted entries joined by newline)[:16]>` |
| `grok-identity.js` | Existing stable, deduplicated user/principal set | Existing Grok stable-ID vector, unchanged here |
| `kiro-identity.js` | Authenticated UserInfo subject, scoped by fixed service authority | `oauth:kiro:user:<sha256(endpoint + newline + subject)[:16]>` |

OpenCode OAuth entries are `upstream:oauth:id:<case-sensitive subject>`. Static
entries preserve `upstream:type:key:<sha256(key)[:16]>`; native empty `{}`
placeholders contribute no grant, while a partially populated unverifiable
entry rejects the whole set. A normalized upstream-name collision also rejects.

`identity-subject.js` centralizes bounded field validation, conflicting-alias
checks and duplicate-key rejection. JWT decoding is **metadata inspection, not
signature verification**. The upstream still authenticates every credential.

Qoder display metadata remains display metadata. An opaque native credential
may retain its recorded account label for an already registered runtime, but a
console `Welcome` label cannot authorize a new stable account. This code does
not invent a decoder for undocumented native/WASM blobs.

## Kiro evidence: source, asynchronous boundary and limits

The native token database alone does not establish a stable user. Instead of
hashing its rotating refresh token, the adapter obtains `userInfo.userId` from
an authenticated GetUsageLimits response, then binds that evidence to the exact
access/refresh snapshot. The response email is not stored as identity.

Pinned upstream evidence is the AWS-maintained Amazon Q source revision
[`15cc8f3cd18c4272925ce1c7053268eedff1ea0a`](https://github.com/aws/amazon-q-developer-cli/tree/15cc8f3cd18c4272925ce1c7053268eedff1ea0a):

- [`UserInfo`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-client/src/types/_user_info.rs) declares the stable `user_id` field and display email.
- [`GetUsageLimitsOutput`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-client/src/operation/get_usage_limits/_get_usage_limits_output.rs) carries UserInfo.
- [`GetUsageLimits`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/amzn-codewhisperer-client/src/operation/get_usage_limits.rs) specifies Bearer authentication, POST, JSON 1.0 and `AmazonCodeWhispererService.GetUsageLimits`.

That repository states that current Kiro CLI is closed source. These references
prove this adapter's pinned protocol, **not a live compatibility test against
all current Kiro editions**. No real Kiro account was used for this verification.
A rejected or unsupported endpoint remains an explicit error, never a fallback
identity derived from token bytes.

`kiro-native-login.js` separates asynchronous enrichment from pure derivation.
CLI completion, Web OAuth completion and explicit native-directory import use
it. Dry-run import remains offline. After the request, both the native file
snapshot and the DB credential generation are checked; a late result cannot
overwrite a newer DB generation. Existing-account writes use compare-and-swap.
Cancellation beats a late response. There is no arbitrary endpoint override,
redirect, unbounded retry, or token-bearing diagnostic.

## Executable evidence

- `test/strict-provider-identity.test.js`: stable vectors, alias conflicts,
  mixed identities, duplicate JSON, rotated grants, redacted errors and exact
  Kiro wire request.
- `test/kiro-identity-integration.test.js`: real temporary SQLite native store,
  register → renew → same ID, foreign-user rejection, offline dry-run vs explicit
  import, cancellation and stale DB generation rejection.
- Existing projection, PTY, transfer/export, desktop lifecycle and Web OAuth
  suites remain part of the full Node gate. Successful fixtures now contain a
  stable identity; the old token-only success assertions were replaced by
  explicit rejection tests, not skipped.
- The full suite is run on an isolated source snapshot with a temporary HOME;
  macOS sandbox denies production account/config reads and writes and restricts
  networking to localhost. Live-provider opt-in tests remain opt-in.

## Review and design decisions

`subject/opencode/kiro identity modules → Strategy + immutable observations →`
keep Provider identity rules separate from process/DB/network side effects →
exact vector and negative tests.

`kiro-identity-probe / kiro-native-login → Adapter + orchestration →` bound,
cancellable authenticated lookup and version-checked handoff → native SQLite,
transport and race tests.

`kiro-credential-version → optimistic concurrency →` request completion order
must not decide the current credential → stale generation rejection test.

SOLID review: pure identity policies do not depend on runtime launchers; network
and persistence have narrow injectable boundaries; unknown formats fail rather
than weakening another Provider's contract. KISS/DRY/YAGNI review: reuse the
existing credential store and native projection pipeline; no shadow account
table, new runtime dependency, speculative refresh service or access-control
product. This scope is self-reviewed; an independent migration review does not
imply independent approval of these identity changes.
