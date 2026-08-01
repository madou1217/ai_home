package providercli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestBinaryResolverHonorsOverrideAndBypassesLegacyCodexHook 验证显式二进制和旧 Hook 委托路径。
func TestBinaryResolverHonorsOverrideAndBypassesLegacyCodexHook(t *testing.T) {
	t.Run("显式覆盖", func(t *testing.T) {
		resolver := binaryResolver{
			lookupEnv: func(name string) (string, bool) {
				if name == "AIH_CLAUDE_BINARY" {
					return "/opt/claude-official", true
				}
				return "", false
			},
			lookPath: func(value string) (string, error) { return value, nil },
		}
		got, err := resolver.Resolve("claude", "claude")
		if err != nil || got != "/opt/claude-official" {
			t.Fatalf("Resolve() = %q, %v", got, err)
		}
	})

	t.Run("绕过旧 Hook", func(t *testing.T) {
		directory := t.TempDir()
		hook := filepath.Join(directory, "codex")
		upstream := hook + ".aih-original"
		if err := os.WriteFile(hook, []byte("#!/bin/sh\n# aih-codex-cli-hook\n"), 0o700); err != nil {
			t.Fatalf("WriteFile(hook) error = %v", err)
		}
		if err := os.WriteFile(upstream, []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatalf("WriteFile(upstream) error = %v", err)
		}
		resolver := binaryResolver{
			lookupEnv: func(string) (string, bool) { return "", false },
			lookPath:  func(string) (string, error) { return hook, nil },
		}
		got, err := resolver.Resolve("codex", "codex")
		if err != nil || got != upstream {
			t.Fatalf("Resolve() = %q, %v", got, err)
		}
	})
}

// TestBinaryResolverFailsClosedForBrokenOverrideAndHook 验证错误覆盖和无委托 Hook 不回退。
func TestBinaryResolverFailsClosedForBrokenOverrideAndHook(t *testing.T) {
	resolver := binaryResolver{
		lookupEnv: func(string) (string, bool) { return " codex", true },
		lookPath:  func(string) (string, error) { return "", errors.New("unexpected lookup") },
	}
	if _, err := resolver.Resolve("codex", "codex"); !errors.Is(err, ErrProviderBinaryNotFound) {
		t.Fatalf("Resolve(invalid override) error = %v", err)
	}

	directory := t.TempDir()
	hook := filepath.Join(directory, "codex")
	if err := os.WriteFile(hook, []byte("aih-codex-cli-hook"), 0o700); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	resolver = binaryResolver{
		lookupEnv: func(string) (string, bool) { return "", false },
		lookPath:  func(string) (string, error) { return hook, nil },
	}
	if _, err := resolver.Resolve("codex", "codex"); err == nil {
		t.Fatal("损坏旧 Hook 不得静默执行")
	}
}
