# Route ownership facts vs forwarding policy — 2026-11-15

Checkpoint `b207435cd` corrects a narrow source-of-truth mismatch; it does not claim the Node runtime can be removed.

## Changed facts

- Go-first public `/healthz` and `/readyz` are handled directly by Go. The manifest now describes that public owner.
- The Node child/private listener and legacy Node-first listener still answer their own health/readiness. Node's forwarding resolver explicitly excludes these host-local entries, so changing public-owner facts cannot make Node proxy its health back to Go.
- Desktop translation `/v0/webui/translation/system` (GET/POST) and `/focus` (POST) are explicit Node-owned leaves. Translation inference/settings being Go-owned never proved the OS helper lifecycle had migrated.
- Two historical preview aggregates retain their owner fields but have explicit descriptions warning that broad namespace summaries are not evidence for every child endpoint. They require later precise decomposition, not blanket owner reassignment.

## Evidence

Actual imported Node resolver, before/after generated manifest: effective forwarding entry list remained exactly equal (61 entries); `gateway.health` was not forwarded; disabled Go mode yielded an empty forwarding set. GET system and POST focus classify as `node.translation_desktop_host`. `go run ./cmd/route-ownership-manifest --check`, `node --check`, package build and source collector completed successfully. No mock server or new test files.

Read-only running topology on this pass: public Go PID37584 on 127.0.0.1:9527; its Node child listened on 127.0.0.1:61458. Both `/healthz` and `/readyz` returned200. Public readiness contained `inference_catalog_ready`, private readiness contained `go_core`; these are different process views, not an assertion of identical semantics. Authenticated GET translation/system returned200 and system status at both ports, consistent with Go front-door forwarding to the existing Node desktop service. No POST focus, permissions, helper start/stop or selection capture was triggered.

The live observations verify existing topology, **not that this newly committed manifest has been deployed**. Future release must regenerate/rebuild any route-manifest-dependent stamp together with the changed projection. No service was restarted for this metadata correction. No production configuration, account, credential or helper was changed.

## Remaining scope

Route-count percentages are not completion percentages. Native/external launch residuals, desktop translation execution/helper lifecycle, plugins, packaging, provider-specific runtime behavior and browser acceptance remain independent migration gates. Full objective remains active.
