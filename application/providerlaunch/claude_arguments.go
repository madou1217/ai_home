package providerlaunch

// ClaudeOptionRequiresValue recognizes public and hidden required-value options
// of the supported Claude 2.1 CLI. Their values are opaque even when they look
// like AIH flags. Inline --option=value consumes no additional token; optional
// value options retain the official parser's normal meaning.
func ClaudeOptionRequiresValue(option string) bool {
	switch option {
	case "--add-dir", "--advisor", "--agent", "--agent-color",
		"--agent-id", "--agent-name", "--agent-type", "--agents",
		"--allowed-tools", "--allowedTools", "--append-subagent-system-prompt", "--append-subagent-system-prompt-file",
		"--append-system-prompt", "--append-system-prompt-file", "--attach-serve", "--autocompact",
		"--betas", "--channels", "--client-data-url", "--correlation-id",
		"--cwd", "--dangerously-load-development-channels", "--debug-file", "--deep-link-cwd-b64",
		"--deep-link-last-fetch", "--deep-link-repo", "--disallowed-tools", "--disallowedTools",
		"--effort", "--environment", "--fallback-model", "--fast-mode",
		"--file", "--forward-home-settings", "--input-format", "--json-schema", "--inherit-permission-mode", "--managed-settings",
		"--lead-verify-key", "--max-budget-usd", "--max-thinking-tokens", "--max-turns",
		"--mcp-config", "--messaging-socket-path", "--model", "--name",
		"--on-branch", "--output-format", "--parent-session-id", "--permission-mode",
		"--permission-prompt-tool", "--permission-prompts", "--plan-mode-instructions", "--plugin-dir", "--plugin-dir-no-mcp",
		"--plugin-url", "--pool", "--prefill", "--prefill-b64",
		"--proactivity", "--project-config-root", "--ref", "--remote-control-session-name-prefix",
		"--resume-drops-turn", "--resume-session-at", "--rewind-files", "--runner-declares",
		"--sdk-url", "--session-began-as-copy", "--session-id", "--setting-sources",
		"--settings", "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot",
		"--task-budget", "--team-name", "--teammate-mode", "--thinking",
		"--thinking-display", "--tools", "--watch-artifact", "--watch-artifact-no-autoreact",
		"--workload", "-n":
		return true
	default:
		return false
	}
}
