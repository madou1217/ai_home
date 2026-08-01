package aihcli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// TestNewCreatesSingleDatabaseAndClosesIdempotently 验证生产组合根只打开 $AIH_HOME/aih.db。
func TestNewCreatesSingleDatabaseAndClosesIdempotently(t *testing.T) {
	aiHomeDir := t.TempDir()
	app, err := New(context.Background(), Options{
		AIHomeDir: aiHomeDir,
		Stdin:     bytes.NewReader(nil),
		Stdout:    io.Discard,
		Stderr:    io.Discard,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	databasePath := filepath.Join(aiHomeDir, sqliteaccount.DatabaseFileName)
	info, err := os.Stat(databasePath)
	if err != nil {
		t.Fatalf("Stat(aih.db) error = %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("aih.db mode = %#o", info.Mode().Perm())
	}
	if err := app.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := app.Close(); err != nil {
		t.Fatalf("Close(second) error = %v", err)
	}
}

// TestRunRequiresGatewayKeyOnlyForRelayMode 验证 Native 指定账号不会读取 Server Key。
func TestRunRequiresGatewayKeyOnlyForRelayMode(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	plannerError := errors.New("planner reached")
	planner := &recordingPlanner{err: plannerError}
	runner := &recordingRunner{}
	app, err := newApp(catalog, planner, runner)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	if err := app.Run(context.Background(), "codex", []string{"9", "resume"}, GatewayConfig{}); !errors.Is(err, plannerError) {
		t.Fatalf("Run(native) error = %v", err)
	}
	if planner.calls != 1 || planner.intent.Mode() != providerlaunch.LaunchModeNativeDirect ||
		planner.intent.CLIAccountID().Int64() != 9 {
		t.Fatalf("Native intent = %v, calls=%d", planner.intent, planner.calls)
	}
	if err := app.Run(context.Background(), "codex", nil, GatewayConfig{BaseURL: "http://127.0.0.1:9527"}); !errors.Is(err, providerlaunch.ErrInvalidGatewayEndpoint) {
		t.Fatalf("Run(gateway without key) error = %v", err)
	}
	if planner.calls != 1 {
		t.Fatal("无 Key Gateway 不得进入规划器")
	}
	if err := app.Run(context.Background(), "claude", []string{"relay", "9", "--model", "opus"}, GatewayConfig{
		BaseURL:   "http://127.0.0.1:9527",
		ClientKey: "client-key-with-at-least-thirty-two-characters",
	}); !errors.Is(err, plannerError) {
		t.Fatalf("Run(pinned gateway) error = %v", err)
	}
	if planner.calls != 2 || planner.intent.Mode() != providerlaunch.LaunchModeGatewayRelay ||
		planner.intent.CLIAccountID().Int64() != 9 {
		t.Fatalf("Gateway intent = %v, calls=%d", planner.intent, planner.calls)
	}
	if runner.calls != 0 {
		t.Fatal("规划失败不得执行 Runtime")
	}
}

// TestRunRejectsProvidersWithoutRegisteredStrategies 验证当前只开放研究完成的双 Provider。
func TestRunRejectsProvidersWithoutRegisteredStrategies(t *testing.T) {
	catalog, _ := providers.NewCatalog(providers.BuiltinManifest())
	app, err := newApp(catalog, &recordingPlanner{}, &recordingRunner{})
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	if err := app.Run(context.Background(), "gemini", nil, GatewayConfig{}); !errors.Is(err, ErrInvalidRunRequest) {
		t.Fatalf("Run(gemini) error = %v", err)
	}
}

// TestGatewayConfigFormattingRedactsClientKey 验证 Host 配置不会被常见日志格式泄漏。
func TestGatewayConfigFormattingRedactsClientKey(t *testing.T) {
	secret := "client-key-that-must-never-appear-in-formatting"
	config := GatewayConfig{BaseURL: "http://127.0.0.1:9527", ClientKey: secret}
	formatted := fmt.Sprintf("%v\n%+v\n%#v", config, config, config)
	if strings.Contains(formatted, secret) {
		t.Fatalf("GatewayConfig 泄漏 Client Key: %s", formatted)
	}
}

// recordingPlanner 记录 Host 解析后的意图并在执行前停止。
type recordingPlanner struct {
	intent providerlaunch.LaunchIntent
	err    error
	calls  int
}

// Plan 保存意图并返回预设错误。
func (planner *recordingPlanner) Plan(
	_ context.Context,
	intent providerlaunch.LaunchIntent,
	_ providerlaunch.GatewayEndpoint,
) (providerlaunch.LaunchPlan, error) {
	planner.calls++
	planner.intent = intent
	return providerlaunch.LaunchPlan{}, planner.err
}

// recordingRunner 统计 Host 是否越过失败的规划边界。
type recordingRunner struct{ calls int }

// Run 记录调用次数。
func (runner *recordingRunner) Run(context.Context, providerlaunch.LaunchPlan, []string) error {
	runner.calls++
	return nil
}
