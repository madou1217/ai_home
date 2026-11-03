# Managed skill native-client demo evidence

Date: 2026-10-26. Branch: `codex/plugin-management-closure`.

## What is implemented

`aih skill install/list/enable/disable/remove/doctor` manages accepted skill
snapshots and their native directory or instruction-block projections. Install
immediately enables a skill. Explicit disable/removal remains durable when AIH
subsequently prepares a provider launch. The former implicit `aih-collab` injector
now delegates to this manager; matching legacy projections are adopted safely.

Run these commands from this branch's checkout (the globally installed AIH may
still point at a different checkout):

```sh
node bin/ai-home.js skill install assets/provider-skills/aih-demo --provider claude --json
node bin/ai-home.js skill list --provider claude --json
# In Claude Code, invoke /aih-demo; the skill instructs AIH_SKILL_DEMO_OK.
node bin/ai-home.js skill disable aih-demo --provider claude --json
node bin/ai-home.js skill enable aih-demo --provider claude --json
node bin/ai-home.js skill doctor --provider claude --json
node bin/ai-home.js skill remove aih-demo --provider claude --json
```

Substitute `codex` for its native skill directory; explicitly invoke `$aih-demo`
in a Codex prompt. OpenCode receives an instruction projection and can be prompted
with `Run the aih-demo skill`.

## Reproducible isolated native probes

The following commands were actually run. Each creates disposable AIH, host,
provider-config and working directories, launches the installed native CLI,
performs four lifecycle stages, then removes its temporary files.

```sh
node scripts/skill-native-demo.js --provider claude --binary /Users/model/.local/bin/claude
node scripts/skill-native-demo.js --provider codex --binary /Users/model/.codex/packages/standalone/releases/0.164.0-aarch64-apple-darwin/bin/codex.aih-original
node scripts/skill-native-demo.js --provider opencode --binary /Users/model/Library/pnpm/bin/opencode
```

The Codex command selects the original native executable behind the machine's
AIH shell hook, so the fixture controls configuration for this isolated run.
Other machines should pass their own native executable using `--binary`.

| Native client | Installed version | Enabled | Disabled | Re-enabled | Removed |
|---|---|---|---|---|---|
| Codex | 0.164.0 | body observed; marker returned | neither | body observed; marker returned | neither |
| Claude Code | 2.1.310 | body observed; marker returned | neither | body observed; marker returned | neither |
| OpenCode | 1.17.18 | body observed; marker returned | neither | body observed; marker returned | neither |

All 12 stages exited 0, made requests to the fixture, and passed. All three final
doctor reports were healthy. Codex/Claude made one fixture request per stage;
OpenCode made two. The prompt contains the skill name but not its expected output.
The fixture returns `AIH_SKILL_DEMO_OK` only when the native request contains the
installed skill body; otherwise it returns `SKILL_NOT_LOADED`. The runner parses
native assistant-result events rather than grepping arbitrary stdout for success.

**Evidence boundary:** these are real native clients against a deterministic
local inference fixture. They establish native discovery, prompt inclusion,
response rendering and enable/disable/remove effects. They do not establish
remote model reasoning or upstream availability. No real provider key is used.

The OpenCode probe initially failed because the manager used its auth-data root
(`.local/share/opencode`) instead of configuration root (`.config/opencode`).
Inspection of the installed CLI's instruction loader confirmed the config-root
lookup. A failing regression test now checks that path explicitly; the descriptor
was corrected and the same native probe then passed.

## Current limits and remaining work

- AGY and the declared CodeBuddy-family skill projections have management support;
  their native executables were not found on this machine's current PATH. Their
  native-use status remains unverified. Pi/DSH were also absent from current PATH.
- Cline is installed, but its skill boundary is undeclared. The manager reports
  unsupported; implementing or verifying Cline's own skill mechanism remains
  part of the all-provider audit. Other undeclared providers also fail closed.
- Skills follow AIH's existing host-shared storage policy. Account-private skill
  overrides are not implemented. Native account projections reuse host resources.
- Snapshot bytes remain cached after removal. A removed record remains as a
  tombstone to stop built-in auto-reinstallation; list hides removed records.
- SQLite serializes manager operations, and individual file replacements are
  staged, but database and filesystem writes are not one crash-atomic transaction.
- Native plugin management, MCP management, all-provider reports and actual
  OpenCode/DeepSeek/Pi import/adaptation demos remain outstanding. This milestone
  does not complete the overall plugin-management goal.

## Validation

```sh
node --test test/skill-manager.test.js test/skill-command.test.js test/native-resource-registry.test.js test/native-resource-management.test.js test/plugin-management-closure.test.js
npm run providers:check
go test ./core/providers
git diff --check
```

Node: 27 passed, 0 failed. Provider snapshot check passed. Go provider package
compiled (`[no test files]`). No WebUI source changed.
