package providerlaunch_test

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
)

// TestParseLaunchIntentSeparatesGatewayAndNative 验证账号数字只在无 relay 前缀时选择 Native。
func TestParseLaunchIntentSeparatesGatewayAndNative(t *testing.T) {
	catalog := mustProviderCatalog(t)
	tests := []struct {
		name       string
		arguments  []string
		wantMode   providerlaunch.LaunchMode
		wantClient string
		wantRelay  string
		wantID     int64
		wantArgs   []string
		wantPinned bool
	}{
		{
			name:       "默认 Gateway 账号池",
			arguments:  []string{"resume", "thread-1"},
			wantMode:   providerlaunch.LaunchModeGatewayRelay,
			wantClient: "codex",
			wantRelay:  "codex",
			wantArgs:   []string{"resume", "thread-1"},
		},
		{
			name:       "显式 Gateway 账号池",
			arguments:  []string{"relay", "--version"},
			wantMode:   providerlaunch.LaunchModeGatewayRelay,
			wantClient: "codex",
			wantRelay:  "codex",
			wantArgs:   []string{"--version"},
		},
		{
			name:       "Gateway 固定账号",
			arguments:  []string{"relay", "8", "--model", "opus"},
			wantMode:   providerlaunch.LaunchModeGatewayRelay,
			wantClient: "codex",
			wantRelay:  "codex",
			wantID:     8,
			wantArgs:   []string{"--model", "opus"},
			wantPinned: true,
		},
		{
			name:       "Gateway 跨 Provider 固定账号",
			arguments:  []string{"relay", "claude", "9", "--model", "claude-opus-5"},
			wantMode:   providerlaunch.LaunchModeGatewayRelay,
			wantClient: "codex",
			wantRelay:  "claude",
			wantID:     9,
			wantArgs:   []string{"--model", "claude-opus-5"},
			wantPinned: true,
		},
		{
			name:       "Native 指定账号",
			arguments:  []string{"9", "resume", "thread-2"},
			wantMode:   providerlaunch.LaunchModeNativeDirect,
			wantClient: "codex",
			wantRelay:  "codex",
			wantID:     9,
			wantArgs:   []string{"resume", "thread-2"},
			wantPinned: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			intent, err := providerlaunch.ParseLaunchIntent(catalog, "codex", test.arguments)
			if err != nil {
				t.Fatalf("ParseLaunchIntent() error = %v", err)
			}
			if intent.Mode() != test.wantMode ||
				intent.ClientProviderID() != test.wantClient ||
				intent.RelayProviderID() != test.wantRelay ||
				intent.CLIAccountID().Int64() != test.wantID ||
				intent.HasPinnedAccount() != test.wantPinned ||
				!slices.Equal(intent.Arguments(), test.wantArgs) {
				t.Fatalf("LaunchIntent 模式错误: mode=%s id=%d pinned=%t args=%v",
					intent.Mode(), intent.CLIAccountID(), intent.HasPinnedAccount(), intent.Arguments())
			}
		})
	}
}

// TestParseLaunchIntentRejectsAmbiguousAccountIDs 验证零、前导零、溢出和 NUL 不会降级成参数。
func TestParseLaunchIntentRejectsAmbiguousAccountIDs(t *testing.T) {
	catalog := mustProviderCatalog(t)
	for _, arguments := range [][]string{
		{"0"},
		{"01"},
		{"9223372036854775808"},
		{"relay", "0"},
		{"relay", "01"},
		{"relay", "claude"},
		{"relay", "claude", "--model", "opus"},
		{"relay", "unknown", "9"},
		{"--model", "bad\x00value"},
	} {
		if _, err := providerlaunch.ParseLaunchIntent(catalog, "claude", arguments); !errors.Is(
			err,
			providerlaunch.ErrInvalidLaunchIntent,
		) {
			t.Fatalf("ParseLaunchIntent(%q) error = %v", arguments, err)
		}
	}
}

// TestNativeSelectionRequestFailsClosedForGateway 验证 Gateway 意图不能越界触发账号凭据读取。
func TestNativeSelectionRequestFailsClosedForGateway(t *testing.T) {
	catalog := mustProviderCatalog(t)
	for _, arguments := range [][]string{nil, {"relay", "3"}} {
		intent, err := providerlaunch.ParseLaunchIntent(catalog, "claude", arguments)
		if err != nil {
			t.Fatalf("ParseLaunchIntent() error = %v", err)
		}
		if _, err := intent.NativeSelectionRequest(); !errors.Is(
			err,
			providerlaunch.ErrLaunchModeMismatch,
		) {
			t.Fatalf("NativeSelectionRequest() error = %v", err)
		}
	}

	native, err := providerlaunch.ParseLaunchIntent(catalog, "claude", []string{"3", "--version"})
	if err != nil {
		t.Fatalf("ParseLaunchIntent(native) error = %v", err)
	}
	request, err := native.NativeSelectionRequest()
	if err != nil || request.ProviderID != "claude" || request.CLIAccountID.Int64() != 3 {
		t.Fatalf("NativeSelectionRequest() = %#v, %v", request, err)
	}
}

// TestLaunchIntentFormattingHidesForwardArguments 验证 prompt 或原生参数不会进入诊断日志。
func TestLaunchIntentFormattingHidesForwardArguments(t *testing.T) {
	const sensitiveArgument = "prompt-secret-must-not-leak"
	intent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		"codex",
		[]string{"7", sensitiveArgument},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	formatted := fmt.Sprintf("%v\n%+v\n%#v", intent, intent, intent)
	if strings.Contains(formatted, sensitiveArgument) {
		t.Fatalf("LaunchIntent 格式化泄漏透传参数: %s", formatted)
	}
}

// mustProviderCatalog 创建当前内置 Provider 的只读测试目录。
func mustProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}
