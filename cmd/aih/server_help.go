package main

import (
	"fmt"
	"strings"
)

const serverUsageText = `
\x1b[36mAI Home Server Helpers\x1b[0m

\x1b[33mUsage:\x1b[0m
  aih serve
  aih server
  aih server start
  aih server restart [--force|--graceful]   # 默认平滑：等在跑的推理流收尾；--force 立即换进程
  aih server stop [--force|--graceful]
  aih server status
  aih server add [name] --url <server-url> --management-key <key>
  aih server ls [--json]
  aih server use <id|name|url>
  aih server remove <id|name|url>
  aih server config [show|get|set|unset|list] [--show-secrets] [--qr [--qr-url <server-url>]] [--json] [--one-line] [--verbose] [<filter>] [--host <ip>] [--port <n>] [--client-key <key>] [--management-key <key>] [--proxy-url <a,b,c>] [--clear-management-key --confirm-clear-management-key] [--open-network|--local-only]
  aih server autostart <install|uninstall|status>
  aih daemon <start|restart|stop|status|autostart>
  aih server serve
  aih server serve [--port <n>]

\x1b[33mNotes:\x1b[0m
  - Default listen: {{default-base-url}}
  - OpenAI-compatible endpoint: {{default-base-url}}/v1
  - Server runs provider-specific adapters (codex/gemini/claude/agy/opencode) with dedicated base URLs.
  - Default provider mode is auto (routes by model hint: gpt/o* -> codex, gemini* -> gemini, claude* -> claude, agy*/antigravity* -> agy, opencode-go/* -> opencode).
  - Default strategy is random (Node: remaining usage weighted by active requests and recent starts; Go: remaining usage).
  - Session affinity is a preference: quota, model cooldown and request pressure can select another account.
  - No extra key setup is required in default mode.
  - aih serve is equivalent to aih server start (daemon mode).
  - aih daemon is an alias for aih server.
  - Saved Server connections use only Server URL + Management Key.
  - autostart uses launchd on macOS, systemd user services on Linux, and the Windows Startup folder.

\x1b[33mAdvanced (optional):\x1b[0m
  aih server config
  aih server config list [--json] [--one-line] [<filter>]
  aih server config set --open-network --client-key <key> --management-key <key>
  aih server config unset proxy-url
  aih server serve [--host <ip>] [--port <n>] [--backend codex-adapter] [--provider codex|gemini|claude|agy|opencode|auto] [--codex-base-url <url>] [--codex-client-version <version>] [--gemini-base-url <url>] [--claude-base-url <url>] [--agy-base-url <url>] [--codex-models <csv>] [--proxy-url <url>] [--no-proxy <hosts>] [--strategy round-robin|random] [--codex-max-concurrency <n>] [--gemini-max-concurrency <n>] [--claude-max-concurrency <n>] [--agy-max-concurrency <n>] [--opencode-max-concurrency <n>] [--queue-limit <n>] [--session-affinity-ttl-ms <ms>] [--session-affinity-max <n>] [--client-key <key>] [--management-key <key>] [--cooldown-ms <ms>] [--max-attempts <n>] [--upstream-timeout-ms <ms>]
  aih server env [--base-url <url>] [--api-key <key>]
  aih server sync-codex [--management-url <url>] [--key <management-key>] [--parallel <1-32>] [--limit <n>] [--dry-run]
  management APIs: /v0/management/status, /v0/management/metrics, /v0/management/accounts, /v0/management/models, /v0/management/reload
`

// defaultBaseURLToken 在帮助文本里占位默认服务地址；实际值由共享监听契约派生，
// 避免默认端口改动后帮助文本撒谎。
const defaultBaseURLToken = "{{default-base-url}}"

func showServerUsage(runtime commandRuntime) {
	text := strings.ReplaceAll(serverUsageText, `\x1b`, "\x1b")
	text = strings.ReplaceAll(text, defaultBaseURLToken, defaultGatewayBaseURL)
	_, _ = fmt.Fprint(runtime.stdout, text+"\n")
}

func runServerFallback(arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || (arguments[0] != "server" && arguments[0] != "daemon") {
		return false, nil
	}
	action := ""
	if len(arguments) > 1 {
		action = strings.TrimSpace(arguments[1])
	}
	_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] Unknown server action '%s'.\x1b[0m\n", action)
	showServerUsage(runtime)
	return true, cliExitCode{code: 1}
}
