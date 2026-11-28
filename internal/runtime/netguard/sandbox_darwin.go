//go:build darwin

package netguard

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// SandboxConfig describes a macOS strict CLI launch.
type SandboxConfig struct {
	ProxyURL string
	DNS      DNSMode
	// AllowAllLoopback keeps local AIH gateway/MCP/OAuth callbacks working.
	// The proxy itself is always loopback.
	AllowAllLoopback bool
}

// NewSandboxCommand wraps a CLI with sandbox-exec and a profile that denies
// external IP sockets while allowing loopback. The returned cleanup must run
// after the process exits; it removes the temporary profile.
func NewSandboxCommand(ctx context.Context, config SandboxConfig, name string, args ...string) (*exec.Cmd, func(), error) {
	proxyURL := strings.TrimSpace(config.ProxyURL)
	if proxyURL == "" {
		return nil, nil, errors.New("sandbox 严格模式需要代理 URL")
	}
	parsed, err := url.Parse(proxyURL)
	if err != nil || parsed == nil || parsed.Hostname() == "" {
		return nil, nil, errors.New("代理 URL 无效")
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return nil, nil, errors.New("sandbox 代理入口必须是 loopback")
	}
	executable, err := exec.LookPath(name)
	if err != nil {
		return nil, nil, fmt.Errorf("找不到可执行文件 %s: %w", name, err)
	}
	profile := buildSandboxProfile(config)
	file, err := os.CreateTemp("", "aih-sandbox-*.sb")
	if err != nil {
		return nil, nil, err
	}
	profilePath := file.Name()
	if _, err := file.WriteString(profile); err != nil {
		_ = file.Close()
		_ = os.Remove(profilePath)
		return nil, nil, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(profilePath)
		return nil, nil, err
	}
	_ = os.Chmod(profilePath, 0o600)
	cleanup := func() { _ = os.Remove(profilePath) }

	commandArgs := append([]string{"-f", profilePath, executable}, args...)
	command := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", commandArgs...)
	command.Env = sandboxEnvironment(os.Environ(), proxyURL)
	return command, cleanup, nil
}

func buildSandboxProfile(config SandboxConfig) string {
	var builder strings.Builder
	builder.WriteString("(version 1)\n")
	builder.WriteString("(allow default)\n")
	builder.WriteString("(deny network-outbound (remote ip))\n")
	builder.WriteString("(allow network-outbound (remote ip \"localhost:*\"))\n")
	// Loopback is the trusted local bridge (proxy, AIH gateway, MCP,
	// OAuth callbacks). External IPs remain denied above.
	_ = config.AllowAllLoopback

	return builder.String()
}

func isLoopbackHost(host string) bool {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

func sandboxEnvironment(base []string, proxyURL string) []string {
	blocked := map[string]struct{}{
		"HTTP_PROXY": {}, "http_proxy": {},
		"HTTPS_PROXY": {}, "https_proxy": {},
		"ALL_PROXY": {}, "all_proxy": {},
		"NO_PROXY": {}, "no_proxy": {},
	}
	environment := make([]string, 0, len(base)+10)
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, drop := blocked[name]; drop {
				continue
			}
		}
		environment = append(environment, entry)
	}
	bypass := "127.0.0.1,localhost,::1"
	environment = append(environment,
		"HTTP_PROXY="+proxyURL, "http_proxy="+proxyURL,
		"HTTPS_PROXY="+proxyURL, "https_proxy="+proxyURL,
		"ALL_PROXY="+proxyURL, "all_proxy="+proxyURL,
		"NO_PROXY="+bypass, "no_proxy="+bypass,
		"NODE_USE_ENV_PROXY=1",
	)
	return environment
}

// ExecutableInSandbox is a helper for launch code that wants the resolved
// absolute path of a command before wrapping it.
func ExecutableInSandbox(name string) (string, error) {
	return exec.LookPath(name)
}
