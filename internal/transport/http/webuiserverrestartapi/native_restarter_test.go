package webuiserverrestartapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func TestHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	os.Exit(0)
}

func makeFakeCLIEntry(t *testing.T, repoRoot string) string {
	t.Helper()
	binDir := filepath.Join(repoRoot, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	entryPath := filepath.Join(binDir, "ai-home.js")
	if err := os.WriteFile(entryPath, []byte("// cli\n"), 0o644); err != nil {
		t.Fatalf("write entry file: %v", err)
	}
	return entryPath
}

func TestNewNativeRestarterNilWhenAIHomeEmpty(t *testing.T) {
	if r := NewNativeRestarter(NativeRestarterOptions{}); r != nil {
		t.Fatalf("expected nil restarter when AIHomeDir is empty, got %+v", r)
	}
	var nilRestarter *NativeRestarter
	if _, err := nilRestarter.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable from nil restarter, got %v", err)
	}
}

func TestNativeRestarterSpawnsDetachedAndReadsAppliedConfig(t *testing.T) {
	aiHome := t.TempDir()
	repoRoot := t.TempDir()
	entryPath := makeFakeCLIEntry(t, repoRoot)

	source, err := webuiserverconfigapi.OpenSource(aiHome)
	if err != nil {
		t.Fatalf("OpenSource: %v", err)
	}
	if err := source.UpdateServerConfig(context.Background(), func(_ string, _ bool) (string, error) {
		raw, marshalErr := json.Marshal(map[string]any{
			"host":                       "127.0.0.1",
			"port":                       9620,
			"openNetwork":                true,
			"apiKey":                     "sk-client-secret",
			"managementKey":              "mk-admin-secret",
			"goCoreEnabled":              true,
			"goCoreRoutes":               []string{"inference.chat", "inference.chat", "webui.accounts"},
			"upstreamErrorRuleProviders": []string{"Codex", "agy"},
			"largePasteChars":            40,
		})
		return string(raw), marshalErr
	}); err != nil {
		t.Fatalf("UpdateServerConfig: %v", err)
	}

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv(restartContextEnv, "mode=elevated,sourceAuto=1")

	var gotName string
	var gotArgs []string
	var capturedCmd *exec.Cmd
	restarter := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir:    aiHome,
		RepoRoot:     repoRoot,
		NodeExecPath: "/custom/node",
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			gotName = name
			gotArgs = append([]string(nil), args...)
			capturedCmd = exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
			return capturedCmd
		},
	})
	if restarter == nil {
		t.Fatal("expected non-nil NativeRestarter")
	}

	ctx, cancel := context.WithCancel(context.Background())
	outcome, err := restarter.Restart(ctx, RestartJob{ID: "job-1"})
	// 立即取消上下文，验证分离进程不会受调用方 ctx 取消波及。
	cancel()
	if err != nil {
		t.Fatalf("Restart failed: %v", err)
	}
	if outcome.PID <= 0 {
		t.Fatalf("expected positive PID, got %d", outcome.PID)
	}
	if gotName != "/custom/node" {
		t.Fatalf("unexpected node executable: %q", gotName)
	}
	wantArgs := []string{entryPath, "server", "restart"}
	if !reflect.DeepEqual(gotArgs, wantArgs) {
		t.Fatalf("unexpected args: got %v, want %v", gotArgs, wantArgs)
	}
	if capturedCmd == nil || capturedCmd.Stdin != nil || capturedCmd.Stdout != nil || capturedCmd.Stderr != nil {
		t.Fatalf("expected nil stdio on detached command")
	}
	assertDetachedSysProcAttr(t, capturedCmd)

	var restartEnvCount int
	var restartEnvValue string
	for _, item := range capturedCmd.Env {
		if strings.HasPrefix(item, restartContextEnv+"=") {
			restartEnvCount++
			restartEnvValue = item
		}
	}
	if restartEnvCount != 1 || restartEnvValue != restartContextEnv+"="+restartContextValue {
		t.Fatalf("expected single %s=%s entry, count=%d val=%q", restartContextEnv, restartContextValue, restartEnvCount, restartEnvValue)
	}

	cfg := outcome.AppliedConfig
	if cfg["host"] != "0.0.0.0" ||
		cfg["port"] != float64(9620) ||
		cfg["openNetwork"] != true ||
		cfg["apiKey"] != "" ||
		cfg["managementKey"] != "" ||
		cfg["apiKeyConfigured"] != true ||
		cfg["managementKeyConfigured"] != true ||
		cfg["largePasteChars"] != float64(50) {
		t.Fatalf("unexpected appliedConfig: %+v", cfg)
	}
	if routes, ok := cfg["goCoreRoutes"].([]any); !ok || len(routes) != 2 || routes[0] != "inference.chat" {
		t.Fatalf("unexpected goCoreRoutes: %#v", cfg["goCoreRoutes"])
	}
	if providers, ok := cfg["upstreamErrorRuleProviders"].([]any); !ok || len(providers) != 2 || providers[0] != "codex" {
		t.Fatalf("unexpected upstreamErrorRuleProviders: %#v", cfg["upstreamErrorRuleProviders"])
	}
}

func TestNativeRestarterEnvFallbacksAndMissingDefaults(t *testing.T) {
	aiHome := t.TempDir()
	entryDir := t.TempDir()
	envEntry := filepath.Join(entryDir, "custom-entry.js")
	if err := os.WriteFile(envEntry, []byte("// custom\n"), 0o644); err != nil {
		t.Fatalf("write env entry: %v", err)
	}

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv(nodeExecEnv, "/env/node")
	t.Setenv(entryFileEnv, envEntry)

	var gotName string
	var gotArgs []string
	restarter := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir: aiHome,
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			gotName = name
			gotArgs = append([]string(nil), args...)
			return exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
		},
	})
	outcome, err := restarter.Restart(context.Background(), RestartJob{})
	if err != nil {
		t.Fatalf("Restart with missing app-state.db failed: %v", err)
	}
	if gotName != "/env/node" {
		t.Fatalf("expected node from env, got %q", gotName)
	}
	if len(gotArgs) != 3 || gotArgs[0] != envEntry {
		t.Fatalf("expected entry from env %q, got %v", envEntry, gotArgs)
	}
	if outcome.AppliedConfig["host"] != "127.0.0.1" ||
		outcome.AppliedConfig["port"] != float64(9527) ||
		outcome.AppliedConfig["apiKeyConfigured"] != false ||
		outcome.AppliedConfig["managementKeyConfigured"] != false {
		t.Fatalf("unexpected default appliedConfig: %+v", outcome.AppliedConfig)
	}
}

func TestNativeRestarterUnavailableErrors(t *testing.T) {
	aiHome := t.TempDir()
	missingRepo := t.TempDir()

	t.Setenv(nodeExecEnv, "")
	t.Setenv(entryFileEnv, "")

	rMissingEntry := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir:    aiHome,
		RepoRoot:     missingRepo,
		NodeExecPath: "/custom/node",
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			t.Fatal("commandFactory should not be called when entry file is missing")
			return nil
		},
	})
	if _, err := rMissingEntry.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable when entry file missing, got %v", err)
	}

	entryPath := makeFakeCLIEntry(t, missingRepo)
	t.Setenv("PATH", t.TempDir())
	rMissingNode := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir:     aiHome,
		EntryFilePath: entryPath,
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			t.Fatal("commandFactory should not be called when node binary is missing")
			return nil
		},
	})
	if _, err := rMissingNode.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable when node missing from PATH, got %v", err)
	}
	// 显式注入无效的 AIH_SERVER_NODE_EXEC 且未使用 CommandFactory 时同样回 server_restart_unavailable
	t.Setenv(nodeExecEnv, filepath.Join(missingRepo, "missing-node"))
	fallbackExecRestarter := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir:     aiHome,
		EntryFilePath: entryPath,
	})
	if _, err := fallbackExecRestarter.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable when explicit AIH_SERVER_NODE_EXEC is missing, got %v", err)
	}
}
