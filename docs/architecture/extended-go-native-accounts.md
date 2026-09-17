# Extended Go native account domain — verified scope

## Delivered boundary

The Go native decoder registry now covers all 15 concrete catalog identifiers:
Codex, Claude, Antigravity, Gemini, OpenCode, Grok, Qoder Global/CN, Kimi, Kiro,
ZCode, CodeBuddy Global/CN and WorkBuddy Global/CN. This is **account-domain
coverage**, not a claim that every Provider has Go inference, browser OAuth,
quota discovery or default WebUI support.

Existing Codex/Claude automatic artifact import is unchanged. Other Providers
can enter through the authenticated native import API and the explicit command:

```text
aih account import <provider> --artifact-file <file.json>
```

The command remains part of the Go CLI/Preview, not the default Node `aih`.
It reads only the caller-selected regular file, refuses symlinks and oversized
input, validates the Provider envelope, and submits it to the configured Go
Management API. It does not scan HOME, open the local account DB, or echo secrets.

Extended artifacts use `{ "native_auth_json": <provider-native object> }`.
Kiro requires the identity-evidence envelope documented in
[stable native identity closure](stable-native-identity-closure.md). Opaque
Qoder WASM blobs and encrypted ZCode documents without a supported materialized
identity remain explicit errors; the decoder does not pretend to reverse them.

## Invariants and design patterns

| Module | Pattern | Reason | Executable evidence |
|---|---|---|---|
| `core/accounts/native_identity.go` | Immutable value objects / named constructors | No caller-selected identity-seed setter; fixed Provider scope and exact vector construction | Shared Node/Go vectors and invalid-subject tests |
| `nativeaccount/*_policy.go` | Strategy + anti-corruption adapter | Separate actual Provider shapes; reject duplicate keys, conflicting subjects, station mismatch and token-only enrollment | Decoder tests and 25 shared synthetic vectors |
| `sqliteaccount/credential_native.go` | Codec registry | Re-derive identity on both encode and decode; independent stored identity cannot authorize a foreign payload | Forged write and stored-payload tamper tests |
| `core/accounts/native_generation.go` | Partial-order value object | Changed bytes, file mtime and arrival order do not prove a newer grant | Newer/older/mixed/missing-evidence tests |
| `application/accounts/reauthentication.go` | Use-case orchestration | Compare credential-origin generations and preserve AccountRef, alias, enabled/default relations | Real SQLite renewal tests for 12 extended identifiers |
| `cmd/aih/account_import_artifact.go` | Composition root / explicit adapter | Expose the implemented native import without adding ambient credential discovery | CLI → authenticated management request test |

A byte-identical grant is idempotent. A later credential-origin `iat`/expiry can
replace an older grant; an unordered or conflicting generation cannot. Static
native key identities remain static. OpenCode can contain a mixture of OAuth
and static upstreams while retaining a complete, sorted identity set.

Antigravity native files may omit a refresh timestamp. The new native constructor
represents that fact as zero/unknown instead of inventing epoch time. The existing
OAuth-exchange constructor remains strict. Native expiry stays a millisecond or
RFC3339 value as declared by the artifact, not an assumed seconds conversion.

The formerly flaky server smoke test expected model discovery to be synchronous
with account creation. It now polls the actual catalog with a bounded deadline,
matching the documented asynchronous lifecycle; failed HTTP responses still fail.

## Verification and production ownership

`GOPROXY=off go test -json -p 2 ./...`: **2,472 passed, 30 opt-in tests skipped,
zero failures; 93 package passes, 7 packages without tests**. `gofmt -l` is empty
in the touched Go scope. Shared fixture contract: **25 Node cases and their Go
counterparts pass**. These tests use synthetic grants and temporary databases;
no live-provider inference is implied.

A read-only audit of the existing host `aih.db` found zero rows in `accounts`,
`account_credentials`, `account_defaults` and `account_profiles`; SQLite
`quick_check` returned `ok`. There are therefore no existing Go account keys to
rekey on that host. This does **not** authorize copying the populated Node DB
into Go or switching production ownership. The default Node runtime remains
unchanged, with no dual writes, shadow accounts or readback fallback.

SOLID/KISS/DRY review: provider parsing stays outside the core; named identity
constructors and a small generation value replace arbitrary seed injection and
fake refresh-token capabilities. Persistence reuses the decoder rather than a
second identity parser. No dependency, permission subsystem or speculative
provider transport was introduced. Self-review found and corrected the earlier
last-arrival-wins native rotation draft before this scope was submitted.
