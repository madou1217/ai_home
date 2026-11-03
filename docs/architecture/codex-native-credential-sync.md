# Codex native credential reconciliation

## Scope

A locally running AIH Node server observes the normal host `.codex/auth.json`
and registered Codex desktop/account runtime auth files. A native App or CLI may
log in without being launched by AIH. Observation starts with the server and
runs every three seconds (minimum configurable interval one second); shutdown
stops the observer. No browser credential interception or remote login endpoint
is added. Existing `set-default` API-key/OAuth transport rules are unchanged.

The reader requires explicit host/AIH directories and a stable regular file.
It does not search backups, exports, session transcripts, arbitrary home
subdirectories or symlinked auth files. A native application using keychain-only
storage or another custom home is not covered by the default file observer.
This document describes this repository's implementation, not a newly verified
upstream product guarantee. Current official App protocol documentation and a
real native App login were not available for this implementation's local tests.

## Freshness, not file copy time

A complete OAuth snapshot has access and refresh credentials, consistent local
identity metadata and a usable generation clock. JWT decoding is metadata
parsing, not signature validation; only the user's local trusted auth stores are
inputs. Resolve the existing canonical OAuth identity before choosing a record:
update the matching record, or register a different identity separately. Neither
the old default account nor a runtime directory name identifies a new login.
No workspace-specific accountRef scheme is introduced.

1. Identical tokens are a no-op, even when a file is touched or `last_refresh`
   changes. Do not bump credential revisions for copying unchanged data.
2. Compare access-token `iat` when both snapshots provide it. A strictly newer
   issuance can replace an older one. A strictly older issuance cannot win via
   a newer file modification time.
3. For equal issuance, or when issuance cannot order the snapshots, compare
   `last_refresh` when both have it.
4. Different credentials with unorderable/equal clocks are a conflict, not a
   last-writer-wins update. Future-dated clocks beyond the tolerated skew are
   rejected. Empty/partial files and API-key stubs never erase an OAuth grant.
5. Expiry is not issuance. A newer complete grant can still be adopted after its
   access token expires while AIH was offline; the existing OAuth refresh path
   then performs actual upstream renewal. File mtime and DB update time are not
   substitutes for credential-generation time.

Conditional publication uses the existing SQLite compare-and-swap operation.
The entire auth snapshot is replaced together; unrelated native metadata is
preserved. Initial publication uses INSERT-if-absent rather than a blind upsert
in the gap after identity registration. Competing writers cause re-read and
freshness re-evaluation. Auth-source reads use inode/size/mtime/ctime stability;
these file attributes avoid unnecessary parsing, not determine which grant wins.

## Runtime and forward synchronization

Successful adoption records a credential fingerprint and observation time. The
Codex pool loader uses this marker only while it matches the current tokens.
Unrelated metadata writes cannot clear an authentication failure. Evidence
against an older credential can be retired after a newer adoption; this is
permission to retry, not proof of successful upstream authentication. Manual
disablement, quota policy, per-model cooldowns and unrelated account cooldowns
remain in force.

Before forward host synchronization or managed runtime projection, reconcile
newer native files into the database first. Automatic auth-update hooks pass
`preserveNativeLogin`: they must not select the old default again over a different
native login, a logout or unreadable native login state. Explicit `set-default`
remains an intentional selection and can project the selected account after
saving any independently logged-in identity. An unorderable target credential
generation stops managed runtime projection rather than overwriting the native file.

A refresh HTTP call captures the DB auth generation used for its request. Late
success, rejection or transport failure cannot overwrite or invalidate a newer
App login. Publication is conditional; metadata-only concurrent edits are
merged without losing an otherwise valid rotated refresh grant. Auth-generation
changes cancel the old result. Failures contain codes, not raw source credentials.

Manual Codex account deletion records a non-secret removal marker in the
existing key-value store within the deletion transaction. The automatic
observer respects it across restarts, even if a standalone App leaves its
credentials on disk. An explicit account registration can restore that identity
and clears the marker transactionally. No deleted account is silently recreated.

No global default-account pointer, historical thread metadata, session data,
or other provider records are modified by reverse observation. A running AIH
server is not a provider registration in an App configuration. The separate
missing-provider/thread-restore problem and a running desktop wrapper's
identity/transport handoff still require their own end-to-end verification.

## Verification

`test/codex-native-credential-sync.test.js` exercises freshness, matching,
source boundaries, idempotence, races, polling and callback retries with real
files and a storage test double. `test/codex-native-credential-integration.test.js`
uses the actual SQLite store, canonical registration, host projection, managed
runtime preparation, refresh executor (mock HTTP), server observer and runtime
state service. `test/codex-native-credential-pool.test.js` uses the actual account
pool loader and must run with repository dependencies installed.

Run those tests together with `test/server.codex-token-refresh.test.js`,
`test/server.token-refresh-daemon.test.js`, `test/host-sync.test.js`,
`test/runtime-support.wiring.bootstrap.test.js`, and the account state suites.
Full repository CI remains the merge gate; isolated tests are not a native App
end-to-end test. Tests use temporary directories and synthetic credentials only.
