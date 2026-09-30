package clientversion

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestCompareFollowsSemverPrecedence 覆盖预发布版本：0.158.0-alpha.2.1 < 0.158.0，
// 数字标识按数值比较，字符串比较会出错的场景都必须正确。
func TestCompareFollowsSemverPrecedence(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		left, right string
		want        int
	}{
		{"0.146.0", "0.158.0", -1},
		{"0.158.0-alpha.2.1", "0.158.0", -1},
		{"0.158.0-alpha.2.1", "0.154.0", 1},
		{"0.158.0-alpha.10", "0.158.0-alpha.9", 1},
		{"0.158.0-alpha.2", "0.158.0-alpha.2.1", -1},
		{"0.158.0-alpha", "0.158.0-beta", -1},
		{"0.158.0-1", "0.158.0-alpha", -1},
		{"2.1.283", "2.1.229", 1},
		{"1.10.0", "1.9.9", 1},
		{"0.158.0", "0.158.0", 0},
	} {
		got := MustParse(testCase.left).Compare(MustParse(testCase.right))
		if got != testCase.want {
			t.Fatalf("Compare(%s, %s) = %d, want %d", testCase.left, testCase.right, got, testCase.want)
		}
	}
}

// TestParseExtractsVersionFromCLIOutputAndUserAgent 验证常见 CLI/UA 文本。
func TestParseExtractsVersionFromCLIOutputAndUserAgent(t *testing.T) {
	t.Parallel()

	for text, want := range map[string]string{
		"codex-cli 0.158.0-alpha.2.1\n":         "0.158.0-alpha.2.1",
		"2.1.283 (Claude Code)":                 "2.1.283",
		"codex_exec/0.158.0-alpha.2.1 (Mac OS)": "0.158.0-alpha.2.1",
	} {
		version, ok := Parse(text)
		if !ok || version.String() != want {
			t.Fatalf("Parse(%q) = %q %v, want %q", text, version, ok, want)
		}
	}
	if _, ok := Parse("no version here"); ok {
		t.Fatal("parsed version from plain text")
	}
}

// TestResolverTakesMaxOfSourcesAndOnlyRaises 验证最低版本、学习版本取最大且单调，
// 显式配置优先，学习结果跨实例持久化。
func TestResolverTakesMaxOfSourcesAndOnlyRaises(t *testing.T) {
	t.Parallel()

	storePath := filepath.Join(t.TempDir(), "client-versions.json")
	resolver, err := NewResolver(ResolverOptions{
		Provider: "codex",
		Floor:    "0.158.0",
		Learned:  NewLearnedStore(storePath),
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	if resolver.Current() != "0.158.0" {
		t.Fatalf("floor current = %q", resolver.Current())
	}
	resolver.Observe(MustParse("0.158.0-alpha.2.1"))
	if resolver.Current() != "0.158.0" {
		t.Fatalf("lower learned version raised current to %q", resolver.Current())
	}
	resolver.Observe(MustParse("0.160.1"))
	resolver.Observe(MustParse("0.159.0"))
	if resolver.Current() != "0.160.1" {
		t.Fatalf("learned current = %q", resolver.Current())
	}
	if payload, err := os.ReadFile(storePath); err != nil || len(payload) == 0 {
		t.Fatalf("learned store not written: %v", err)
	}
	reopened, err := NewResolver(ResolverOptions{Provider: "codex", Floor: "0.158.0", Learned: NewLearnedStore(storePath)})
	if err != nil || reopened.Current() != "0.160.1" {
		t.Fatalf("reopened current = %q, %v", reopened.Current(), err)
	}
	pinned, err := NewResolver(ResolverOptions{Provider: "codex", Floor: "0.158.0", Configured: "0.150.0", Learned: NewLearnedStore(storePath)})
	if err != nil || pinned.Current() != "0.150.0" {
		t.Fatalf("configured current = %q, %v", pinned.Current(), err)
	}
}

// TestResolverProbesLocalCLI 用一个输出版本号的脚本验证本机探测，失败的命令被忽略。
func TestResolverProbesLocalCLI(t *testing.T) {
	t.Parallel()

	script := filepath.Join(t.TempDir(), "fake-cli")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho 'fake-cli 0.170.2'\n"), 0o700); err != nil {
		t.Fatalf("write script: %v", err)
	}
	resolver, err := NewResolver(ResolverOptions{
		Provider:      "codex",
		Floor:         "0.158.0",
		ProbeCommands: []string{filepath.Join(t.TempDir(), "missing"), script},
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	resolver.Probe(context.Background())
	if resolver.Current() != "0.170.2" {
		t.Fatalf("probed current = %q", resolver.Current())
	}
	resolver.Start(context.Background())
	if err := resolver.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if _, err := NewResolver(ResolverOptions{Provider: "codex", Floor: "v1"}); err == nil {
		t.Fatal("invalid floor accepted")
	}
}

// 服务一启动就可能有请求进来：探测完成前只报最低版本会让按版本下发的新模型被上游拒绝，
// 并把所有账号对该模型长时间冷却。Start 返回时必须已知本机版本，且结果留给下次启动。
func TestStartKnowsLocalVersionBeforeServingAndRemembersIt(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	script := filepath.Join(dir, "fake-cli")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 0.2\necho 'codex-cli 0.159.2'\n"), 0o700); err != nil {
		t.Fatalf("write script: %v", err)
	}
	storePath := filepath.Join(dir, "client-versions.json")
	resolver, err := NewResolver(ResolverOptions{
		Provider:      "codex",
		Floor:         "0.158.0",
		ProbeCommands: []string{script},
		Learned:       NewLearnedStore(storePath),
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	resolver.Start(context.Background())
	defer resolver.Close()
	if resolver.Current() != "0.159.2" {
		t.Fatalf("current right after Start = %q", resolver.Current())
	}
	restarted, err := NewResolver(ResolverOptions{Provider: "codex", Floor: "0.158.0", Learned: NewLearnedStore(storePath)})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}
	if restarted.Current() != "0.159.2" {
		t.Fatalf("current after restart before probing = %q", restarted.Current())
	}
}
