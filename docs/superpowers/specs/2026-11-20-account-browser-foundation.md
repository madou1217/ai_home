# Account browser foundation — implementation stage 1

Approved intent: user asked to start implementation after controlled host/memory proofs. This stage implements shared account-profile infrastructure now; it does not silently choose WebView over a full stable browser, claim OAuth compatibility, or fabricate browser frames.

## Scope and boundary
- One server/provider/stable accountRef maps deterministically to one opaque browser profile; no CLI alias/display name/index identity, no credentials stored in metadata.
- Durable server-local profile metadata plus0700 profile/data directories and0600 metadata. Close releases actual host view if present and never deletes profile/data. Metadata does NOT guarantee browser cookies/session restore.
- A focused runtime defines host lifecycle through an interface. Without an attached host, opening returns explicit browser_host_unavailable and does not allocate fake open sessions. No Electron dependency/fallback, no debug/automation flags, no launches in stage1.
- Authenticated HTTP routes under /v1/management/webui/account-browser; automatic /v0/webui alias uses same handler. Provider/account are revalidated against the actual account store before any filesystem write; server identity is read from existing app_kv server:identity, never derived from URL/host/CLI name. Missing/malformed authority fails closed.
- Cross-process first-create must not overwrite another valid profile; interrupted/incompatible/symlink metadata fails closed, not silently resets. No user-controlled filesystem paths.
- No UI button opening a fake browser. Existing copy/external browser actions remain unchanged. No product browser implementation until full frame/input bridge and chosen engine boundary are established.
- Desktop only; no tests/test cases written. Real HTTP/filesystem actions in disposable task data demonstrate lifecycle/validation/restart/race isolation. Go build/vet complement but do not replace real evidence.

## Ownership and precise paths
Original owner AWS agy gemini-4-neon-xhigh, conversation193f84c1-49a4-4983-bbaf-e222ba327d73: new internal/runtime/accountbrowser/*.go only. Coordinator01a1f72b: new internal/transport/http/webuiaccountbrowserapi/*.go; new internal/host/aihserver/webui_account_browser_routes.go; only import+builder-call hunk in existing internal/host/aihserver/webuiroutes.go; these two docs. No web/src/services/api.ts edit because peer changes exist. No worktree/branch/source copy; remote uses actual existing /home/ubuntu/ai_home.

## API contract
- GET /account-browser/profiles/{provider}/{accountRef}: existing profile metadata or404; no create.
- POST same: ensure unique persistent profile (201created/200existing); response profile identity and status; no absolute path/token/cookie.
- POST .../open: ensure validated profile then require concrete host;503browser_host_unavailable currently, never fake success.
- POST .../close: idempotently release actual view if present, retain durable profile/data; report closed, not a browser login guarantee.
- GET /account-browser/capabilities: host attached flag, Electron false, actual capability info, not unsupported all-green.

## Delivery gate
Independent review, actual disposable HTTP/filesystem execution with process restart and same/different identity observations; no test files. Original-owner runtime plus coordinator integration reviewed as one logical dependency-complete milestone. Fresh HEAD/disk/index audit, git diff --cached --stat, explicit-path scoped commit, postcommitstat/tree review and push main. Preserve peer index via fresh temporary index if necessary. No production restart/deploy in this stage. First milestone is backend foundation, not complete virtual browser.

## Stage1 evidence boundary (2026-11-20)
Runtime andHTTP go build/go vet passed. Full internal/host/aihserver build passed on current shared working tree after peer changes settled; source-exact commit build remains a separate gate. Real task-owned localhostHTTP+SQLite+filesystem run21checks passed, including processrestart, provider/account/serverauthority, two sameprovider identities, closedataretention,24concurrentHTTPclients across2processes with singlefirstcreatewinner,corruptmetadataandsymlinkrejection. No testcaseswritten. No concretehostattached;Openreturns503asdesigned. No browserUI,OAuth/sessioncookies,peraccountproxy,visualacceptance or productionrelease claimed. WindowsspecificACL andpowerfailurebehavior notverified.
