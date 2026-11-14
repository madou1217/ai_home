package webuiserverrestartapi

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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

func TestNewNativeRestarterNilWhenAIHomeEmpty(t *testing.T) {
	if r := NewNativeRestarter(NativeRestarterOptions{}); r != nil {
		t.Fatalf("expected nil restarter when AIHomeDir is empty, got %+v", r)
	}
	var nilRestarter *NativeRestarter
	if _, err := nilRestarter.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable from nil restarter, got %v", err)
	}
}

// TestNativeRestarterSpawnsDetachedAndReadsAppliedConfig 锁住原生重启的两条合同：
// 命令来自服务管理器（不经 Node），且 appliedConfig 是脱敏后的持久化视图。
func TestNativeRestarterSpawnsDetachedAndReadsAppliedConfig(t *testing.T) {
	aiHome := t.TempDir()

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
		AIHomeDir: aiHome,
		ResolveCommand: func() (string, []string, error) {
			return "/fake/launchctl", []string{"kickstart", "-k", "gui/501/com.meadeo.ai_home"}, nil
		},
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
	if gotName != "/fake/launchctl" {
		t.Fatalf("unexpected restarter executable: %q", gotName)
	}
	wantArgs := []string{"kickstart", "-k", "gui/501/com.meadeo.ai_home"}
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

// TestNativeRestarterAppliedConfigDefaults 验证缺少 config:server 时的脱敏缺省值。
func TestNativeRestarterAppliedConfigDefaults(t *testing.T) {
	aiHome := t.TempDir()

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")

	restarter := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir: aiHome,
		ResolveCommand: func() (string, []string, error) {
			return "/fake/launchctl", []string{"kickstart", "-k", "gui/501/com.meadeo.ai_home"}, nil
		},
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			return exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
		},
	})
	outcome, err := restarter.Restart(context.Background(), RestartJob{})
	if err != nil {
		t.Fatalf("Restart with missing app-state.db failed: %v", err)
	}
	if outcome.AppliedConfig["host"] != "127.0.0.1" ||
		outcome.AppliedConfig["port"] != float64(9527) ||
		outcome.AppliedConfig["apiKeyConfigured"] != false ||
		outcome.AppliedConfig["managementKeyConfigured"] != false {
		t.Fatalf("unexpected default appliedConfig: %+v", outcome.AppliedConfig)
	}
}

// TestNativeRestarterUnavailableWithoutServiceManager 没有受管服务时明确失败，不退回 Node。
func TestNativeRestarterUnavailableWithoutServiceManager(t *testing.T) {
	aiHome := t.TempDir()

	restarter := NewNativeRestarter(NativeRestarterOptions{
		AIHomeDir: aiHome,
		ResolveCommand: func() (string, []string, error) {
			return "", nil, ErrRestartUnavailable
		},
		CommandFactory: func(name string, args ...string) *exec.Cmd {
			t.Fatal("commandFactory should not be called without a service manager")
			return nil
		},
	})
	if _, err := restarter.Restart(context.Background(), RestartJob{}); !errors.Is(err, ErrRestartUnavailable) {
		t.Fatalf("expected ErrRestartUnavailable, got %v", err)
	}
}
