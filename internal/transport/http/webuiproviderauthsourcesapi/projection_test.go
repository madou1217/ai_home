package webuiproviderauthsourcesapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"runtime"
	"strings"
	"testing"
)

// TestResponseMatchesNodeShape 锁死响应形状：键名、键序与缺省值必须与 Node
// /v0/webui/accounts/provider-auth-sources 逐字一致（Node 侧已实测转储）。
func TestResponseMatchesNodeShape(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	body := strings.TrimSpace(request(t, handler, http.MethodGet, Path+"?provider=claude").Body.String())
	wanted := `{"ok":true,"supported":true,"provider":"claude","methods":[{"authMode":"oauth-browser","sources":[{"id":"claude-host-local","kind":"local","clientDependent":true,"requiresApp":"cli","authMode":"oauth-browser","handler":"","pluginLogin":false,"directImport":true,"description":"读取本机 claude 客户端的登录态并直接入库，不需要用户手动导出","available":false,"installable":true,"alreadyImported":false,"reason":"client_not_installed","implementation":null}],"preferredSourceId":"","installableSourceId":"claude-host-local","localSourceAvailable":false}],"derivedBy":"go_partial","unfilledFields":["sources[].alreadyImported","pluginSources"]}`
	if body != wanted {
		t.Fatalf("响应形状与契约不符\n got: %s\nwant: %s", body, wanted)
	}
}

// TestResponseShapeIsCompleteWithPorts 锁死「端口齐全时自称完整」的形状：
// unfilledFields 必须是空数组而不是 null，derivedBy 不再降级。
func TestResponseShapeIsCompleteWithPorts(t *testing.T) {
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir:         t.TempDir(),
		ExistingIdentities:  func(context.Context, string) (map[string]struct{}, error) { return nil, nil },
		LocalSourceIdentity: func(context.Context, string, string) (string, bool) { return "", false },
		PluginSources:       func(context.Context, string) ([]PluginSource, error) { return nil, nil },
	})
	body := strings.TrimSpace(request(t, handler, http.MethodGet, Path+"?provider=claude").Body.String())
	wanted := `{"ok":true,"supported":true,"provider":"claude","methods":[{"authMode":"oauth-browser","sources":[{"id":"claude-host-local","kind":"local","clientDependent":true,"requiresApp":"cli","authMode":"oauth-browser","handler":"","pluginLogin":false,"directImport":true,"description":"读取本机 claude 客户端的登录态并直接入库，不需要用户手动导出","available":false,"installable":true,"alreadyImported":false,"reason":"client_not_installed","implementation":null}],"preferredSourceId":"","installableSourceId":"claude-host-local","localSourceAvailable":false}],"derivedBy":"go","unfilledFields":[]}`
	if body != wanted {
		t.Fatalf("响应形状与契约不符\n got: %s\nwant: %s", body, wanted)
	}
}

// TestUnfilledFieldsFollowInjectedPorts 锁死缺口清单的派生规则：注入端口即不再宣称缺失。
func TestUnfilledFieldsFollowInjectedPorts(t *testing.T) {
	identityPort := func(context.Context, string) (map[string]struct{}, error) { return nil, nil }
	sourceSeedPort := func(context.Context, string, string) (string, bool) { return "", false }
	pluginPort := func(context.Context, string) ([]PluginSource, error) { return nil, nil }
	cases := []struct {
		name         string
		dependencies Dependencies
		wanted       []string
		derivedBy    string
	}{
		{
			name:         "没有端口时只剩 Node 独有的两块",
			dependencies: Dependencies{HostHomeDir: t.TempDir()},
			wanted:       []string{"sources[].alreadyImported", "pluginSources"},
			derivedBy:    derivedByGoPartial,
		},
		{
			name: "只接去重端口时仍缺插件来源",
			dependencies: Dependencies{
				HostHomeDir:         t.TempDir(),
				ExistingIdentities:  identityPort,
				LocalSourceIdentity: sourceSeedPort,
			},
			wanted:    []string{"pluginSources"},
			derivedBy: derivedByGoPartial,
		},
		{
			name: "只接插件端口时仍缺去重",
			dependencies: Dependencies{
				HostHomeDir:   t.TempDir(),
				PluginSources: pluginPort,
			},
			wanted:    []string{"sources[].alreadyImported"},
			derivedBy: derivedByGoPartial,
		},
		{
			name: "端口齐全",
			dependencies: Dependencies{
				HostHomeDir:         t.TempDir(),
				ExistingIdentities:  identityPort,
				LocalSourceIdentity: sourceSeedPort,
				PluginSources:       pluginPort,
			},
			wanted:    []string{},
			derivedBy: derivedByGo,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newTestHandlerWithDependencies(t, testCase.dependencies)
			payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
			if payload.DerivedBy != testCase.derivedBy {
				t.Errorf("derivedBy = %q，期望 %q", payload.DerivedBy, testCase.derivedBy)
			}
			if len(payload.UnfilledFields) != len(testCase.wanted) {
				t.Fatalf("unfilledFields = %v，期望 %v", payload.UnfilledFields, testCase.wanted)
			}
			for index, key := range testCase.wanted {
				if payload.UnfilledFields[index] != key {
					t.Errorf("unfilledFields[%d] = %q，期望 %q", index, payload.UnfilledFields[index], key)
				}
			}
			raw := map[string]any{}
			if err := json.Unmarshal(request(t, handler, http.MethodGet, Path+"?provider=claude").Body.Bytes(), &raw); err != nil {
				t.Fatalf("解析响应失败: %v", err)
			}
			// 空清单必须是 []，不能是 null：调用方按数组消费。
			if _, ok := raw["unfilledFields"].([]any); !ok {
				t.Errorf("unfilledFields 原始值 = %#v，期望数组", raw["unfilledFields"])
			}
		})
	}
}

// TestInstallableFollowsContractDeclaration 锁死 Go 侧的安装方案判定：
// 合同声明了可分发包 / 该平台安装落点才算可安装，其余一律不可安装。
func TestInstallableFollowsContractDeclaration(t *testing.T) {
	cases := []struct {
		provider string
		app      string
		wanted   bool
		why      string
	}{
		{provider: "claude", app: appCLI, wanted: true, why: "声明了 @anthropic-ai/claude-code"},
		{provider: "grok", app: appCLI, wanted: false, why: "合同没有声明可分发的 CLI 包"},
		{provider: "kiro", app: appCLI, wanted: false, why: "kiro 只有桌面端安装落点"},
	}
	if runtime.GOOS == "darwin" {
		cases = append(cases, struct {
			provider string
			app      string
			wanted   bool
			why      string
		}{provider: "kiro", app: appDesktop, wanted: true, why: "macOS 声明了 Kiro.app 安装落点"})
	}
	for _, testCase := range cases {
		handler := newTestHandler(t, t.TempDir(), nil)
		definition, known := handler.catalog.Get(testCase.provider)
		if !known {
			t.Fatalf("%s 不在内置合同里", testCase.provider)
		}
		if got := installableFromContract(definition, testCase.app); got != testCase.wanted {
			t.Errorf("installableFromContract(%s, %s) = %v，期望 %v（%s）",
				testCase.provider, testCase.app, got, testCase.wanted, testCase.why)
		}
	}
}

// TestCanInstallPortOverridesContract 锁死宿主注入的安装判定优先于合同声明。
func TestCanInstallPortOverridesContract(t *testing.T) {
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		CanInstall:  func(provider, app string) bool { return provider == "claude" && app == appCLI },
	})
	method := methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude")), "oauth-browser")
	source := sourceByID(t, method, "claude-host-local")
	if !source.Installable || method.InstallableSourceID != "claude-host-local" {
		t.Errorf("installable/sourceId = %v/%q，期望走宿主注入的判定",
			source.Installable, method.InstallableSourceID)
	}
	// 覆盖成「不可安装」时也要如实反映，不能把合同的结论漏出来。
	denied := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		CanInstall:  func(string, string) bool { return false },
	})
	source = sourceByID(t, methodByAuthMode(t, decode(t, request(t, denied, http.MethodGet, Path+"?provider=claude")), "oauth-browser"), "claude-host-local")
	if source.Installable || source.Reason != reasonClientUnavailable {
		t.Errorf("installable/reason = %v/%q，期望 false/%q", source.Installable, source.Reason, reasonClientUnavailable)
	}
}

// TestAlreadyImportedHidesRegisteredHostLogin 锁死去重语义：本机登录态的指纹已在账号池里，
// 来源就不再作为可导入来源（Node 的用户要求「已存在就不显示」）。
func TestAlreadyImportedHidesRegisteredHostLogin(t *testing.T) {
	hostHomeDir := t.TempDir()
	writeFile(t, hostHomeDir, ".claude", ".credentials.json")
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: hostHomeDir,
		ExistingIdentities: func(_ context.Context, provider string) (map[string]struct{}, error) {
			if provider != "claude" {
				return nil, nil
			}
			return map[string]struct{}{"oauth:claude:uuid:abc": {}}, nil
		},
		LocalSourceIdentity: func(_ context.Context, provider, sourceID string) (string, bool) {
			return "oauth:claude:uuid:abc", provider == "claude" && sourceID == "claude-host-local"
		},
		PluginSources: func(context.Context, string) ([]PluginSource, error) { return nil, nil },
	})
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
	method := methodByAuthMode(t, payload, "oauth-browser")
	source := sourceByID(t, method, "claude-host-local")
	if !source.AlreadyImported {
		t.Fatalf("alreadyImported = false，指纹命中账号池时必须判已入库")
	}
	if source.Available {
		t.Errorf("available = true，已入库的来源不能再作为可导入来源")
	}
	if source.Reason != reasonAccountAlreadyRegistered {
		t.Errorf("reason = %q，期望 %q", source.Reason, reasonAccountAlreadyRegistered)
	}
	if method.PreferredSourceID != "" || method.LocalSourceAvailable {
		t.Errorf("preferred/local = %q/%v，期望空/false", method.PreferredSourceID, method.LocalSourceAvailable)
	}
}

// TestAlreadyImportedFailsOpen 锁死 fail-open：指纹读不出来或账号池读失败时不做去重判断。
func TestAlreadyImportedFailsOpen(t *testing.T) {
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{
			name: "指纹读不出来",
			dependencies: Dependencies{
				ExistingIdentities: func(context.Context, string) (map[string]struct{}, error) {
					return map[string]struct{}{"seed": {}}, nil
				},
				LocalSourceIdentity: func(context.Context, string, string) (string, bool) { return "", false },
			},
		},
		{
			name: "账号池读失败",
			dependencies: Dependencies{
				ExistingIdentities:  func(context.Context, string) (map[string]struct{}, error) { return nil, errors.New("db down") },
				LocalSourceIdentity: func(context.Context, string, string) (string, bool) { return "seed", true },
			},
		},
		{
			name: "指纹不在账号池里",
			dependencies: Dependencies{
				ExistingIdentities: func(context.Context, string) (map[string]struct{}, error) {
					return map[string]struct{}{"other": {}}, nil
				},
				LocalSourceIdentity: func(context.Context, string, string) (string, bool) { return "seed", true },
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			hostHomeDir := t.TempDir()
			writeFile(t, hostHomeDir, ".claude", ".credentials.json")
			dependencies := testCase.dependencies
			dependencies.HostHomeDir = hostHomeDir
			handler := newTestHandlerWithDependencies(t, dependencies)
			payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
			method := methodByAuthMode(t, payload, "oauth-browser")
			source := sourceByID(t, method, "claude-host-local")
			if source.AlreadyImported || !source.Available {
				t.Fatalf("alreadyImported/available = %v/%v，期望 false/true（fail-open）",
					source.AlreadyImported, source.Available)
			}
		})
	}
}

// TestPluginSourcesJoinBuiltinMethods 锁死插件来源的投影：与内置来源同形、参与同一排序分组，
// 指纹命中账号池时同样标成已入库。
func TestPluginSourcesJoinBuiltinMethods(t *testing.T) {
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		ExistingIdentities: func(context.Context, string) (map[string]struct{}, error) {
			return map[string]struct{}{"plugin:seed": {}}, nil
		},
		LocalSourceIdentity: func(context.Context, string, string) (string, bool) { return "", false },
		PluginSources: func(_ context.Context, provider string) ([]PluginSource, error) {
			if provider != "claude" {
				return nil, nil
			}
			return []PluginSource{{
				ID:          "claude-plugin-login",
				Kind:        kindRemote,
				AuthMode:    "oauth-device",
				PluginLogin: true,
				Description: "插件提供的设备码登录",
				Available:   boolPointer(true),
				Identity:    "plugin:seed",
			}}, nil
		},
	})
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
	method := methodByAuthMode(t, payload, "oauth-device")
	source := sourceByID(t, method, "claude-plugin-login")
	if !source.PluginLogin {
		t.Errorf("pluginLogin = false，插件来源的登录任务必须走 /plugin-login")
	}
	if !source.AlreadyImported || source.Available || source.Reason != reasonAccountAlreadyRegistered {
		t.Errorf("alreadyImported/available/reason = %v/%v/%q，期望 true/false/%q",
			source.AlreadyImported, source.Available, source.Reason, reasonAccountAlreadyRegistered)
	}

	// 插件来源也可以让「合同里没有来源」的 Provider 变得 supported。
	pluginOnly := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		PluginSources: func(_ context.Context, provider string) ([]PluginSource, error) {
			if provider != "acme" {
				return nil, nil
			}
			return []PluginSource{{ID: "acme-plugin", Kind: kindRemote, AuthMode: "oauth-device"}}, nil
		},
	})
	acme := decode(t, request(t, pluginOnly, http.MethodGet, Path+"?provider=acme"))
	if !acme.Supported || len(acme.Methods) != 1 {
		t.Fatalf("supported/methods = %v/%+v，期望 true 且恰好一个认证方式", acme.Supported, acme.Methods)
	}
	if acme.Methods[0].PreferredSourceID != "acme-plugin" {
		t.Errorf("preferredSourceId = %q，期望 acme-plugin", acme.Methods[0].PreferredSourceID)
	}

	// 没有插件端口时不凭空造来源。
	bare := newTestHandler(t, t.TempDir(), nil)
	if payload := decode(t, request(t, bare, http.MethodGet, Path+"?provider=acme")); payload.Supported || len(payload.Methods) != 0 {
		t.Errorf("supported/methods = %v/%+v，期望 false 且空数组", payload.Supported, payload.Methods)
	}
}

// TestPluginSourceWithoutAvailabilityIsAvailable 锁死 Node 的 source.available !== false：
// 插件没有声明可用性时视为可用，不能因为缺省布尔值把登录入口压成不可用。
func TestPluginSourceWithoutAvailabilityIsAvailable(t *testing.T) {
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		PluginSources: func(_ context.Context, provider string) ([]PluginSource, error) {
			if provider != "claude" {
				return nil, nil
			}
			return []PluginSource{{ID: "claude-plugin-login", Kind: kindRemote, AuthMode: "oauth-device"}}, nil
		},
	})
	method := methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude")), "oauth-device")
	source := sourceByID(t, method, "claude-plugin-login")
	if !source.Available || source.Reason != "" {
		t.Fatalf("available/reason = %v/%q，期望 true/空", source.Available, source.Reason)
	}
}

// boolPointer 是插件可用性的显式声明替身。
func boolPointer(value bool) *bool { return &value }

// TestPluginSourceBridgeFailureIsEmpty 锁死插件端口失败时按「没有插件来源」降级，不影响内置来源。
func TestPluginSourceBridgeFailureIsEmpty(t *testing.T) {
	handler := newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: t.TempDir(),
		PluginSources: func(context.Context, string) ([]PluginSource, error) {
			return nil, errors.New("plugin runtime down")
		},
	})
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
	if !payload.Supported || len(payload.Methods) != 1 {
		t.Fatalf("supported/methods = %v/%+v，期望内置来源仍可用", payload.Supported, payload.Methods)
	}
	method := methodByAuthMode(t, payload, "oauth-browser")
	if len(method.Sources) != 1 || method.Sources[0].ID != "claude-host-local" {
		t.Errorf("sources = %+v，期望只有内置来源", method.Sources)
	}
}
