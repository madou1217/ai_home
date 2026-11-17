# R4 Go settings owner and three Node writer transition checkpoint

> 2026-11-18, Asia/Shanghai. Owner 01a1da1b. This is a narrow engineering checkpoint, not a shared runtime deployment or completion of R4/W0-W6.

## Authority and scope

- Supervisor `01a1df63` approved the initial eight production paths in `pm-b8778629` and the 93 stale-input contract in `pm-567eb669`. `pm-dbd6dc29` approved bounded dirty-event convergence and the OpenAI delete transaction port. `pm-27bca9ff` approved exactly two platform watcher files; `pm-4b59cfbb` approved this one low-sensitivity document.
- No tests, synthetic accounts/tokens, branch, worktree, shared restart, deployment, live database mutation or stamp operation was introduced. Production inferencecatalog/Chat/Terminal/OAuth business scopes were not edited.
- The remaining Node timer is not removed. This source checkpoint removes the enabled, provider-default and model-policy reverse writers; their publish/retirement acceptance remains **blocked** on the canonical Vertex placeholder guard described below. Credential/adoption/probe/routing-exclusion/usage compatibility remains with its existing owners.

## Data and implementation contract

- Canonical `accounts.enabled` and `account_defaults` are not seeded from old Node projections. The real snapshot contains one old `up` versus canonical disabled conflict; it must not revive an account.
- Real input: 121 account settings, 0 legacy model settings, 32 links including 3 non-identity mappings; 26 previously managed policy keys. Canonical policies: 22 force-disable, 4 force-enable, 977 inherit. Exactly 93 settings resolve to absent canonical accounts; they are retained in the document, ignored for policy writes and counted as `ignored_stale_count`, not fabricated or re-imported.
- Application planning uses normalized policy fields only, disable wins on merged identities, and only previously managed overrides can return to inherit. The host adapter retains the existing v5 normalization and complete document. Invalid SQL/JSON/ref ownership is an error, never an empty or identity fallback.
- Settings, policy relations and independent `go-model-settings:managed:v1` ownership commit in the same `BEGIN IMMEDIATE` connection; routing writes stay serialized until the stable in-memory index and observer are published. Cancellation and writer admission reuse the existing production model transaction.
- The initial marker imports legacy ownership once; it never means skip subsequent startup. One Go Store-owned dirty-event consumer coalesces canonical DB/WAL invalidations, re-enters the same transaction/planner, and does not write unchanged rows. This is eventual convergence, not instantaneous cross-process consistency.
- Darwin uses a parent vnode and exact `aih.db`/`aih.db-wal` vnodes, no directory-child enumeration. Handles are CLOEXEC with a wake pipe and single-loop cleanup. Root identity loss is visible; only the original inode at the original non-symlink path can rearm. Close cancels and waits. Other platforms retain fsnotify; no non-Darwin runtime acceptance is claimed.
- OpenAI model deletion uses a transaction-held mutate port, not an outside read followed by a whole-document save.

## Source provenance

- Final private archive baseline: `d8df8c417ea7e5857cc5e1a6441b1c04116c9012`. Only the ten owned production contents below overlay that baseline. Shared main subsequently advancing does not retroactively change these artifacts.
- `source-index-v1.json`, `source-index-v2.json`, `source-index-v3.json` and `final-source-index.json` preserve each reviewed content boundary. Final ten-source hashes:

| Production path | SHA-256 |
| --- | --- |
| `application/modelsettingssync/planner.go` | `2a237fba0cd5ab486a7396b58b32b6f094abca8bcbf89b22da68ad1e32e3806b` |
| `application/modelsettingssync/service.go` | `1a2e6f5cd5e82b15023fa54e1d9434cb86883b8ce74bf82f666b15b173c9a412` |
| `application/modelsettingssync/ports.go` | `ddf5670291783885c1fbbf15775ebe27e387609c296c4d46fbbe49c59bb2a85a` |
| `internal/adapters/accounts/sqliteaccount/model_settings_sync.go` | `d4b529bc0acd14e3ba2334c2541718dfaeaf1977307b1731a29241927f4d4160` |
| `internal/adapters/accounts/sqliteaccount/database.go` | `597624babb329e1a1bf465ffd525866f46dbf763137c546fbf676814e85f90a5` |
| `internal/host/aihserver/model_settings_store.go` | `eb417fd4dc01dc5e0ea722929b002fed306e318b0fe67bb112b1e60c3b135e07` |
| `lib/server/go-account-sync.js` | `82c16ccea2c4cb3a92df313029dd6cea13e0811e8e0019839b4ee7e23bf345a2` |
| `internal/host/aihserver/webuiroutes.go` | `10356855650505c83f3f894459b6587b8b9cbd71e718f22799eddd2df22a500e` |
| `internal/adapters/accounts/sqliteaccount/model_settings_watch_darwin.go` | `f9acfe31902b977734948780eda964adb4a4f1a5ff68d24c61fd44372d46f711` |
| `internal/adapters/accounts/sqliteaccount/model_settings_watch_other.go` | `ca4ce63d4f54994dade4ee9974f938d61c911efdc1dac01e41e682666f8a89a0` |

## Private evidence provenance

- Root: `/private/tmp/aih-r4-modelsettings-nodeoff-20261118-rX6oAW`. Online SQLite backup opened the actual canonical source read-only with `query_only` and a read transaction; snapshot SHA-256 `626f76b502b7b36fe1ac3eaec2806583e509814e6976fde6945397089a0c222d`, 975486976 bytes. No legacy DB fallback.
- The frozen low-sensitivity evidence index has 113 SHA entries: `cae3dca255bc769fdefff030e4af5e7cc059a4665a62398511fcdd901570b408`. Permission, review, commit and cleanup receipts created later are separate and do not silently alter this index.
- Final build/vet exit 0. Final production `aih-server` SHA-256 `ecef11a540695d2d27e29315ee10a85686bb7370f405fca90eeb088f57fc7dac`; final production-host bootstrap SHA-256 `ca6c4b2832a3a01ee0b0c33ad3b367072d413ed3950da78239a1c94f5d29d02e`.
- Earlier host hashes remain distinct in `binary-index.json`: initial `679bcbc...`, route probe `ccfeccc...`, event owner `4cadd637...`, exact Darwin watcher `59681b88...`, import port `42aec910...`, lifecycle bootstrap `bdc3d0c4...`. Only private operational delegation grew; no fixture or copied model-policy business logic was used.
- Strict host runs deny child fork/foreign exec and outbound network, with private HOME/path/locks and no configured Node host/RPC. Actual production CLI runs use system PATH without Node and no Node supervision/frontdoor; Darwin serveridentity needs `/bin/ps`, so CLI evidence is not called an OS-noexec guarantee.

## Real observations and retained failures

| Evidence | Actual result and boundary |
| --- | --- |
| 01-02 | Initial production Store open under strict noexec exited 0, imported all 26 ownership keys with policy writes 0 and ignored stale 93; original settings bytes/timestamp and accounts/default/state/credentials/aliases matched input. |
| 03 initial | Private runner used identical management/client keys; production correctly rejected exit 1. Only private environment keys were separated, and the failure is retained. |
| 03-15 | Real existing workbuddy model changed to force-disable/effective false, restart held it; restore returned inherit/effective true. Busy, full-request cancellation and malformed real-map gates preserved rows; good retry succeeded. |
| 16-17 RED | Earlier slice deleted a real cline manual setting with HTTP 200 but left force-enable and ownership active, including restart. This regression evidence is not rewritten as success. |
| 18-19 RED | Earlier slice did not replan ownership when an actual non-identity mapping was removed, including restart without settings save. |
| 21-26 | Event-owner version repaired the old delete on startup without resave; fixed public delete released ownership in-call. Real link removal/restoration converged in 0.100/0.175 seconds and quiescent rows did not change. These are not silently reattributed to later binaries. |
| 27-28 | Real native export succeeded; strict public management DELETE returned 503 `account_runtime_unverifiable`. No ps mock, lease bypass or product identity weakening was used. |
| 31 | Root move experiment expected a policy row that had already been released and the driver raised StopIteration. It is inconclusive for the old silent-unarm race, not a red or green proof. Original private root/link bytes were restored. |
| 32 | A second full Host on the same private home exited 1 `backup_core_writer_busy`; it is not reported as a two-Host convergence pass. |
| 35-39 | Exact watcher version: move and restore the same original private-root inode, then real link removal/restoration converged in 0.097/0.201 seconds. Quiet one second then another change converged in 0.195 seconds. Unavailable-root error logged; Close exited 0. |
| 40-44 | Authorized production Store.DeleteAccount on derived real copy exited 0; unchanged real native portable document restored same ID via production backupaccounts.Import (created 1, failed 0). Separate real Store observer converged to force-enable/candidate in 0.190 seconds without settings save. This is a production-port observation, not public HTTP DELETE success. |
| 34/38/45 | Initial lsof query omitted access flags and yielded no identified event FDs: inconclusive. Corrected actual `lsof +fg` saw O_EVTONLY 0x8000 on exactly original directory, DB and WAL, and no unrelated child watches. |
| 46 | Same-process twelve production Store Open/Close cycles under strict profile: goroutines 3 to 3, FDs 8 to 8, exit 0. This bounded sample is not a proof against all lifetime races. |
| 47-48 | A live production Store kept SQLite connections; journal-mode DELETE was correctly refused as locked. No live WAL was unlinked and no live DB was replaced. |
| 49-51 | OS-only probe compiled exact production Darwin watcher with package-name/bootstrap adaptation, no copied business function. With no live target SQLite handle, SQLite removed/recreated WAL with a new inode; exact watch delivered events. A real online backup was atomically installed, then later real writes still produced events. This does not claim live SQLite hot reload or supported online DB replacement. |
| 52 | Actual remaining Node reconciler ran two real rounds against private production Go HTTP: 36 requests, consisting of 32 routing-exclusion PUTs and 4 usage GETs. Retired enabled/default/model-policy RPC count 0; canonical accounts/defaults/models unchanged. Two credential-generation-unordered errors per round remain visible. This deliberately includes Node and is not strict Node-off evidence. |
| 53-56 | Real production Host PUT changed an independent production Store process candidate true to false in 0.117 seconds, restore false to true in 0.091 seconds. Quiet 0.8-second row digests stayed equal; secondary Store exit 0. This is not two full Hosts. |
| 57-67 FINAL | Final latest-main artifacts: real HTTP disable 200, force-disable/effective false, restart retained it; fixed delete 200 and ownership release; busy 2.004 seconds/HTTP 500 with rows unchanged; full 27955-byte PUT canceled before writer release with rows unchanged; malformed real map 500 with rows unchanged, recovery 200; quiet 0.8 seconds unchanged. Final actual CLI restarted with inherit/effective true and no Node PATH. |
| 68 | Main private copy retains both credential-table HMACs, accounts/default/state and three alias tables relative to input. Live query-only ending HMACs match alias3/accounts/default/state but both credential tables and account_models changed concurrently; cause is not attributed. Never claim the entire live database or all credentials unchanged. |
| 69 | Read-only aggregate of the original real canonical snapshot: one typed Vertex placeholder, zero enabled, zero model-policy/force-enable/effective/candidate-by-facts rows. This proves only the current real input is safe; it does not cover a late import, manual enable or a newly created policy. No placeholder/model/credential fixture was made. |

Final evidence binding: `evidence-index-final.json` adds the real 69 aggregate and private archive build/vet logs to the unchanged frozen 113-entry index. It has 116 SHA-256 entries and complete file SHA-256 `231db0a1a3f7b70aa50d372e088b598e55aa5be9c7273d29ec1be5d50aa0ec2c`. The original index remains unchanged; neither index authenticates a release or closes the Vertex gate.

## Review, delivery and open limits

- Publish gate: removing the old enabled writer also removes its Vertex-placeholder forced-disable exception. Go discovery/upstream rejection is not candidate exclusion. `Registrar.Register` still defaults enabled, and manual force-enable can create a policy; the current disabled placeholder aggregate does not establish safe late import. Supervisor `pm-27dec375` permits this ten-source engineering checkpoint but explicitly blocks publish and three-writer retirement acceptance until a focused canonical typed-credential/routing guard closes that gap. No enabled mutation or credential scan was added to the model-settings planner.
- Independent review first identified two P1 discontinuities and a P2 root-watch lifecycle defect. v3 ten-source review `pm-aa829ddb` found those source connection points corrected and no new blocking source point at that time; final hash-bound source/document review is pending before checkpoint, including this newly disclosed Vertex gate. Static review is not reviewer-owned runtime execution or production release permission.
- At this document draft: no new source/doc commit yet; checkpoint is pending owner explicit pathspec and pre/post index verification. No shared loaded/deployment/stamp acceptance, no remote push claim. Final commit and review receipts will be reported separately rather than fabricated into this pre-commit document.
- Engineering checkpoint acceptance does not establish the three-writer publish gate or retire every remaining Node service. Credential refresh/adoption/probe/routing-exclusion/usage and other slices require their own owner and exit gates. Go-only alias work already landed separately and is not redone here.
- Open evidence limits: no external inference was executed; candidate membership is not upstream acceptance. Actual legacyModels input was empty, so nonempty provider-wide expansion is source reviewed but not a real-data positive. Not all cancellation/overflow races or non-Darwin backends were exercised. Event convergence remains eventual.
- The fresh root contains sensitive copies/portable plaintext/logs/keys, owner-only permissions. Cleanup is **not yet performed or authorized by prior roots**; it needs this run's exact manifest approval after low-sensitivity/full SHA and process/handle evidence is saved. Root/source/binaries/low-sensitivity artifacts and lock inodes must remain. No secure-erasure claim.

## Canonical Vertex credential guard follow-up — 2026-11-18

The preceding 81-line checkpoint is retained verbatim as historical status. It landed as `7ee554693926634ca91f8f566f5e65f34337afec`; independent postcommit review `pm-6aa0d5d3` accepted its exact engineering scope **with publish block**. Supervisor `pm-540c4b27` separately approved eight canonical-guard production paths and `pm-0be6be25` approved this appendix in the same document. No new schema, service, timer, account/model/credential fixture, test case, live database write or shared restart was introduced.

### Guard authority and atomicity

- The existing canonical typed `*gemini.VertexAuth` with `Placeholder()==true` is the only persisted guard authority. A separate derived `credentialExcluded` index bit participates in the one `serves` predicate together with user enabled and the existing routing-exclusion bit. Neither manual enable nor Node exclusion-clear can remove the credential bit. User enabled/default state is not rewritten.
- Register, RegisterNew, ReplaceCredential CAS, portable restore/create/identity-match, static Vertex rotation and identity rekey capture full canonical routing facts in the same credential transaction. The existing routing-write lock is held through commit and one guarded index publication; rekey no longer publishes first and patches exclusion afterward. Startup uses one read transaction, and model-settings adapter route reconstruction includes the typed guard without adding credential business logic to the application planner.
- A legacy state-only update for an unseen Gemini index entry defaults to guarded until canonical typed restoration supplies its actual bit. Existing bits are retained. A valid but as-yet-unverified Gemini account can be temporarily unavailable; the existing canonical event reconciliation, not user settings resave, resolves it. This missing-entry protection is **not cross-Store linearizability**: a different Store changing a previously verified credential still has the documented eventual-convergence boundary.
- Invalid typed Vertex records return an error rather than false/empty. This is a focused typed-credential guard, not a claim that every possible database or credential corruption is detected.

### Exact production provenance

Final eight-source index `guard-source-index-v2.json`, SHA-256 `4425c176a7b2d1458defe9e944aa5d91d3ec6f0eac2d4f0bef12223af224c234`:

| Production path | Complete SHA-256 |
| --- | --- |
| `internal/adapters/accounts/sqliteaccount/credential_routing_guard.go` | `e04536719bb503afb3178966c4226cc60272b732540120a6a6a953e6e0d90892` |
| `internal/adapters/accounts/sqliteaccount/routing_index.go` | `ad053e2778b5d378c7cd74b3fbfe6f3209d9b1e66dfa1d4aaabd644447389a5e` |
| `internal/adapters/accounts/sqliteaccount/credential_store.go` | `6ad68aa31b139c8da2568f47f172028ccc75218deded4cc2a3b2fb00fbb34a82` |
| `internal/adapters/accounts/sqliteaccount/registration_store.go` | `99d6a0ed293f0a9b6c7e65fc39a51cb8763623bf1a33a29fe994e07c993ef83b` |
| `internal/adapters/accounts/sqliteaccount/portable_restore.go` | `e3ab47931aa6df272b703adab83c2e158062b7974775562b9f3ddf26f78dabe4` |
| `internal/adapters/accounts/sqliteaccount/static_credential_rotation_store.go` | `2b84bfcf40fbea5ce6c7b2843ab37dcfb85243ba118d4f1c86a213b257d3da95` |
| `internal/adapters/accounts/sqliteaccount/rekey_store.go` | `64a72f6d833470bdb79cd64432937402d37708f6dad489c4c801ee65b9ef1de3` |
| `internal/adapters/accounts/sqliteaccount/model_settings_sync.go` | `04010920e0a2bfcdd75a7667fcf570effcc688f29cfb3c692e5ed5d480c3359f` |

Private latest-main archive baseline is `549387601872535d222d48eb0909961dabc33dad`. Production package build and vet each exited 0; the archive bootstrap only delegates to production ports. Operational artifact `vertex-operational-latest2` SHA-256 `b0af37149f09190dff12383c2a2b50545f5c635e836438f8e820300c4396923a` produced 97–100. The subsequent bootstrap-only settings-call addition produced `vertex-operational-final3` SHA-256 `73d6677ec7532e9ed5a650a2efacf9f1ee66e83eb7d929611a38bb7bbf51c650` and 101; production eight-source hashes are identical. Do not equate earlier v1 binaries or empty build logs with these final executions.

### Actual isolated evidence

| Evidence | Observation and limit |
| --- | --- |
| 70 / 71 | With the original real placeholder, the pre-guard production Store reported one serviceable Gemini account after manual enable and Node exclusion-clear. Guarded Store reported zero while user enabled remained true. Real Gemini model rows were zero: this is an actual route-account regression/repair, not a positive model-candidate inference run. |
| 72–81 | Original real portable entry: private production delete then ImportInto created 1/failed 0 with the same ref; repeat unchanged 1. Actual registrar, registration port, same-real-credential replacement with stale repeat CAS conflict, Vertex rotation and process restarts all retained the guard. No credential or model was synthesized. |
| 82 / 83a / 85 | First attempted original JSON truncation was rejected by the existing SQLite json-valid/object CHECK before the guard was exercised; it is not a guard-pass result. The observer was closed. No constraint was bypassed. |
| 87–92 | Only the existing real placeholder field's type was damaged (bool to string, still valid object JSON). Existing Store kept the account excluded and logged reconciliation failure; a new Store exited 1 with typed-guard error. Exact original JSON restoration recovered exit 0. A separate production Store imported the same real portable entry while the first observed continued exclusion. Actual WorkBuddy candidate true → disable false → restore true showed the guard did not globally disable routing. |
| 93–96 | Final v2 production sources rebuilt and repeated local ports, invalid typed credential, independent Store and real non-Gemini candidate controls; results remained guarded. These are retained separately from v1. |
| 97–100 latest-main | Latest-main artifact repeated ten actual canonical-port operations including a bounded two-Store import/enable missing-entry cycle (0.011 seconds): immediate, Node-clear and post-quiet serviceable Gemini counts all zero. This did not instrument private index internals and is not a proof every scheduling race was traversed. Process tree contained the actual Go process and zero descendants under no-Node PATH plus Seatbelt fork/foreign-exec denial. Bad typed startup exited 1, exact recovery exited 0, independent import succeeded, observer Close exited 0, and real WorkBuddy candidate control was true/false/true. Two Store processes are not two full HTTP Hosts. |
| 101 final3 | Real unchanged full settings document through production Service.Save: applied 0/ignored-stale 93, canonical enabled true retained, serviceable Gemini 0; next process restart also 0. This confirms the guarded settings-route restoration path with the final production hashes. |

Guard evidence is separately frozen in `guard-evidence-index-final.json`: 46 low-sensitivity entries, complete file SHA-256 `51f44d731ec65cd1409e1af12f0d6b4f3a37c3eb3a2a4353cbb32d2cdcc89311`. Earlier 113/116-entry indexes remain unchanged. Full binary/source/selected real-portable SHA values, source origin and actual build exit receipts are retained outside the repository; no credential plaintext is included here.

### Review and remaining acceptance boundary

- v1 source review `pm-3de3e57b` and v2 focused source review `pm-1d69b894` found no blocking source point within their recorded hashes; final hash-bound document/evidence review and owner nine-path checkpoint are pending at appendix preparation. This text does not invent a future commit, reviewer-owned runtime execution, remote push or shared loaded state.
- The real data has one Gemini placeholder and zero Gemini model rows, with no real non-placeholder Gemini or replacement identity credential sample. Valid non-placeholder guard clearing, identity rekey positive acceptance, and placeholder model-candidate positive/negative are source-reviewed boundaries, not actual runtime positives. No fixture was introduced to erase those limits.
- These observations close the demonstrated local route-account safety regression and cover actual late import, restart, manual enable, Node-clear and typed-error failure cases for the existing input. Whole R4, all Node services, upstream inference acceptance and production publish/Node-off acceptance remain separate supervisor gates; this appendix grants no deployment permission.
- Unified push is owned by the supervisor. Two read-only remote probes failed with `Connection closed by UNKNOWN port 65535`; no proxy/remote/SSH settings were changed. Shared loaded/restart/deploy were not attempted.
- Private sensitive artifacts now also include the derived `guard-home`, real portable export and private raw logs. They remain owner-only and need this run's fresh exact cleanup manifest authorization after complete low-sensitivity, process/handle and lock evidence; no prior root permission is reused.
