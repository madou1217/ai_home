# Durable host Codex provider registration

The default `model_provider` is a selection, not the lifetime of a named
`model_providers` entry. API-key and OAuth `set-default` both maintain a complete
`aih_server` registration. OAuth still selects `openai`, keeps native OAuth
credentials and removes only the AIH-managed native endpoint override. Expired
OAuth credentials do not change this rule. The gateway definition uses the
existing `aih-codex-provider-auth.js --gateway --ai-home ...` command, not an
OAuth account's nonexistent API key. The account header follows explicit
set-default's selected account, as does the existing gateway connection contract.

The Node server's existing background lifecycle starts an independent host
registration reconciler immediately and every 15 seconds; stop cancels it.
Missing definitions are restored using the current gateway configuration and
selected default account (or the ordinary unpinned gateway when none is set).
An existing registration, its endpoint, and its account pin are left unchanged
by periodic repair. No default selection, auth.json, thread metadata, other
providers, MCP configuration, or sandbox configuration is rewritten by it.

The reconciler targets only the explicit host `.codex/config.toml`, not a
process-inherited CODEX_HOME. It requires an existing real `.codex` directory,
rejects redirected/oversized configs, parses TOML before and after the edit,
and defers invalid or sealed-inline layouts instead of corrupting them.
Publication uses a private temporary file, snapshot rechecks and atomic rename
(or create-if-absent). Concurrent native writers are not a shared transaction:
a later deletion is handled on the next successful pass. IO failures use the
existing bounded-backoff loop and emit reason codes without config/secret text.
This is eventual repair while the server is running and the file is writable,
not an assertion that an external process can never delete the registration.

A TOML parser (`smol-toml`, pinned in package.json) is used rather than testing
for a header substring that may be in instructions/comments. Run `npm install`
when updating a source-linked installation, then restart the actual Node server.
Already-running native Apps may need their thread reopened or the App restarted
to reload configuration. A resolved provider still needs a reachable gateway,
a valid account and an available model; this change does not fake authentication.

Regression tests cover API-key -> valid/expired OAuth -> API-key, native auth
preservation, startup and repeated missing-block repair, no-default/no-auth
repair, idempotence, actual SQLite/daemon integration, quoted headers, multiline
examples, CRLF, TOML errors, symlinks, write races, write failure and shutdown.
Sandbox OAuth cleanup remains unchanged. Tests use synthetic credentials and
mocked/local dependencies, never real App credentials or billed inference.
