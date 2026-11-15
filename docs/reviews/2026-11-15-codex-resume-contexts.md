# Bounded Codex resume/list contexts — 2026-11-15

## Source review and correction

The existing Node scoped-resume proxy used an unbounded pending frame array and response-context Map. The Go ResumeTracker inherited unbounded map growth and normalized number1/string"1" to the same key. A server request with a matching ID could also consume a pending client response context. Thread-list scope tracking had the same ID collision, consumption and retention issues.

This checkpoint extracts the focused resume tracker, adds explicit error-aware admission, and bounds each tracker to512 contexts/512 KiB of keys and scope data. Keys retain JSON-RPC string/number identity and exact numeric spelling. Only result/error responses consume a context; server requests/notifications cannot. Explicit Close releases all state. Terminal errors release capacity just like successful responses.

The existing Go app-server bridge now checks admission failures and fails its connection explicitly instead of silently forwarding requests it cannot track. The old boolean/void adapter methods remain compatible for call sites, but production streaming owners use the checked interfaces. A subsequent native-resume transport checkpoint returns a structured capacity error for new requests and preserves accepted in-flight contexts.

## Actual evidence

- `aih-resume-wire-live-ye24xb`: actual wscat CLI upstream, actual native transport, real WebSocket client. Request cwd/model-provider/history rewrite observed at upstream with9007199254740997 intact. Numeric1 and string"1" responses were delivered with their distinct threadIds; a server request did not steal the pending context. Request513 returned `resume_context_capacity_exceeded`; an upstream error released capacity and allowed another request. Keys absent from process argv; active helper shutdown exit0 in1,009 ms.
- `aih-resume-scope-final-M2zQnU`: final list tracker filtered foreign-project response rows while preserving nextCursor; explicit allProjects retained both project rows. Request513 returned `thread_list_context_capacity_exceeded`. Keyless/wrong-key local handshakes401 and browser Origin403 were actually observed.
- Production-source vet, native/full snapshot build and affected Windows/Linux package cross-builds passed. No new test cases, mocked handlers or shared service changes.

These observations used the separately checkpointed native transport; this leaf tracker commit itself does not switch the Node launcher. Full vendor resume acceptance and startup safety are recorded with that transport checkpoint. Original review sidecars lack remaining context, so the owner documents self_review rather than independent approval. Overall migration remains active.
