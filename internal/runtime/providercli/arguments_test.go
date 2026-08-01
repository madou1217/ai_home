package providercli

import (
	"errors"
	"slices"
	"testing"
)

// TestCodexRemoteArgumentsSupportsOnlyOfficialInteractiveEntrypoints 验证 root/resume/fork 的精确插入位置。
func TestCodexRemoteArgumentsSupportsOnlyOfficialInteractiveEntrypoints(t *testing.T) {
	remote := "unix:///tmp/codex.sock"
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{name: "root", args: []string{"-m", "gpt-5"}, want: []string{"--remote", remote, "-m", "gpt-5"}},
		{name: "resume", args: []string{"resume", "abc"}, want: []string{"resume", "--remote", remote, "abc"}},
		{name: "fork after config", args: []string{"-c", "model_provider=\"openai\"", "fork", "abc"}, want: []string{"-c", "model_provider=\"openai\"", "fork", "--remote", remote, "abc"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := codexRemoteArguments(test.args, remote)
			if err != nil || !slices.Equal(got, test.want) {
				t.Fatalf("codexRemoteArguments() = %v, %v; want %v", got, err, test.want)
			}
		})
	}
}

// TestCodexRemoteArgumentsRejectsNonInteractiveSubcommands 验证 OAuth Remote 不回退到不支持入口。
func TestCodexRemoteArgumentsRejectsNonInteractiveSubcommands(t *testing.T) {
	for _, subcommand := range []string{"exec", "review", "login", "app-server"} {
		t.Run(subcommand, func(t *testing.T) {
			if _, err := codexRemoteArguments(
				[]string{subcommand},
				"unix:///tmp/codex.sock",
			); !errors.Is(err, ErrCodexRemoteUnsupported) {
				t.Fatalf("codexRemoteArguments(%s) error = %v", subcommand, err)
			}
		})
	}
}

// TestValidateManagedArgumentsProtectsAccountAndRoutingBoundary 验证用户不能覆盖 AIH 管理的认证路由。
func TestValidateManagedArgumentsProtectsAccountAndRoutingBoundary(t *testing.T) {
	for _, args := range [][]string{
		{"--remote", "unix:///tmp/other.sock"},
		{"--oss"},
		{"-c", "model_provider=other"},
		{"--config=model_providers.other.base_url=https://example.test"},
	} {
		if err := validateManagedArguments("codex", args); !errors.Is(err, ErrManagedArgumentConflict) {
			t.Fatalf("validateManagedArguments(%v) error = %v", args, err)
		}
	}
	if err := validateManagedArguments("codex", []string{"--model", "gpt-5", "-c", "sandbox_mode=read-only"}); err != nil {
		t.Fatalf("普通 Codex 参数被误拒绝: %v", err)
	}
	if err := validateManagedArguments("claude", []string{"--bare"}); !errors.Is(err, ErrManagedArgumentConflict) {
		t.Fatalf("Claude --bare error = %v", err)
	}
}
