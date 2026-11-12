package egress

import (
	"encoding/json"
	"strings"
	"testing"
)

func bindingJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return string(raw)
}

// TestParseBindingNormalizesLikeNode 锁住 normalizeEgressBinding() 的形状判定：
// url 推断、retired 形状、pool 选择校验、未知模式与损坏记录。
func TestParseBindingNormalizesLikeNode(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		raw        string
		wantMode   string
		wantProxy  string
		wantRetire bool
		wantErr    bool
	}{
		{
			name:      "只有 proxyUrl 时按 url 解释",
			raw:       bindingJSON(t, map[string]any{"proxyUrl": " http://127.0.0.1:7890 "}),
			wantMode:  ModeURL,
			wantProxy: "http://127.0.0.1:7890",
		},
		{
			name:      "显式 url",
			raw:       bindingJSON(t, map[string]any{"mode": "URL", "proxyUrl": "socks5://127.0.0.1:1080"}),
			wantMode:  ModeURL,
			wantProxy: "socks5://127.0.0.1:1080",
		},
		{
			name:      "direct 保留历史 proxyUrl",
			raw:       bindingJSON(t, map[string]any{"mode": "direct", "proxyUrl": "http://127.0.0.1:7890"}),
			wantMode:  ModeDirect,
			wantProxy: "http://127.0.0.1:7890",
		},
		{
			name:     "system",
			raw:      bindingJSON(t, map[string]any{"mode": "system"}),
			wantMode: ModeSystem,
		},
		{
			name:     "tun",
			raw:      bindingJSON(t, map[string]any{"mode": "tun"}),
			wantMode: ModeTUN,
		},
		{
			name:      "pool 清空 proxyUrl",
			raw:       bindingJSON(t, map[string]any{"mode": "pool", "proxyUrl": "http://127.0.0.1:7890", "strategy": "sticky", "scope": map[string]any{"kind": "groups", "groups": []any{"g1", "g2"}}}),
			wantMode:  ModePool,
			wantProxy: "",
		},
		{
			name:       "历史 node 记录标记 retired",
			raw:        bindingJSON(t, map[string]any{"mode": "node", "nodeId": "abc"}),
			wantMode:   "node",
			wantRetire: true,
		},
		{
			name:       "没有 mode 但只剩 nodeId 也标记 retired",
			raw:        bindingJSON(t, map[string]any{"nodeId": "abc"}),
			wantMode:   "node",
			wantRetire: true,
		},
		{
			name:       "没有 mode 但只剩 groupId 也标记 retired",
			raw:        bindingJSON(t, map[string]any{"groupId": "g1"}),
			wantMode:   "group",
			wantRetire: true,
		},
		{
			name:    "未知模式按非法记录",
			raw:     bindingJSON(t, map[string]any{"mode": "magic"}),
			wantErr: true,
		},
		{
			name:    "url 缺 proxyUrl",
			raw:     bindingJSON(t, map[string]any{"mode": "url"}),
			wantErr: true,
		},
		{
			name:    "空对象",
			raw:     bindingJSON(t, map[string]any{}),
			wantErr: true,
		},
		{
			name:    "数组不是记录",
			raw:     "[]",
			wantErr: true,
		},
		{
			name:    "损坏 JSON",
			raw:     "{",
			wantErr: true,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			binding, err := parseBinding(testCase.raw)
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("parseBinding() 期望报错，实际得到 %#v", binding)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBinding() error = %v", err)
			}
			if binding.Mode != testCase.wantMode {
				t.Errorf("Mode = %q，期望 %q", binding.Mode, testCase.wantMode)
			}
			if binding.ProxyURL != testCase.wantProxy {
				t.Errorf("ProxyURL = %q，期望 %q", binding.ProxyURL, testCase.wantProxy)
			}
			if binding.Retired != testCase.wantRetire {
				t.Errorf("Retired = %v，期望 %v", binding.Retired, testCase.wantRetire)
			}
		})
	}
}

// TestParseBindingPoolSelection 锁住 normalizePoolSelection()/normalizePoolScope()
// 的 kind/strategy 归一化与运行时节点名拒绝。
func TestParseBindingPoolSelection(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name          string
		document      map[string]any
		wantStrategy  string
		wantScopeKind string
		wantErr       bool
	}{
		{
			name:          "缺省选择",
			document:      map[string]any{"mode": "pool"},
			wantStrategy:  "shared",
			wantScopeKind: "all",
		},
		{
			name:          "分组选择",
			document:      map[string]any{"mode": "pool", "strategy": "sticky", "scope": map[string]any{"kind": "groups", "groups": []any{"g1"}}},
			wantStrategy:  "sticky",
			wantScopeKind: "groups",
		},
		{
			name:          "节点选择按 nodeId 对象",
			document:      map[string]any{"mode": "pool", "strategy": "session", "scope": map[string]any{"nodes": []any{map[string]any{"nodeId": "node-entity-1"}}}},
			wantStrategy:  "session",
			wantScopeKind: "nodes",
		},
		{
			name:          "显式 kind 但空白名单按全部节点",
			document:      map[string]any{"mode": "pool", "scope": map[string]any{"kind": "groups", "groups": []any{}}},
			wantStrategy:  "shared",
			wantScopeKind: "all",
		},
		{
			name:          "未知策略回落 shared",
			document:      map[string]any{"mode": "pool", "strategy": "weird"},
			wantStrategy:  "shared",
			wantScopeKind: "all",
		},
		{
			name:     "运行时节点名非法",
			document: map[string]any{"mode": "pool", "scope": map[string]any{"nodes": []any{"node-3"}}},
			wantErr:  true,
		},
		{
			name:     "对象项没有任何标识字段",
			document: map[string]any{"mode": "pool", "scope": map[string]any{"nodes": []any{map[string]any{"name": "x"}}}},
			wantErr:  true,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			binding, err := parseBinding(bindingJSON(t, testCase.document))
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("parseBinding() 期望报错，实际得到 %#v", binding)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseBinding() error = %v", err)
			}
			if binding.PoolStrategy != testCase.wantStrategy {
				t.Errorf("PoolStrategy = %q，期望 %q", binding.PoolStrategy, testCase.wantStrategy)
			}
			if binding.PoolScopeKind != testCase.wantScopeKind {
				t.Errorf("PoolScopeKind = %q，期望 %q", binding.PoolScopeKind, testCase.wantScopeKind)
			}
		})
	}
}

// TestParseBindingUpdatedAt 锁住 normalizeUpdatedAt() 的数字/数字字符串兼容。
func TestParseBindingUpdatedAt(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		raw  string
		want int64
	}{
		{name: "数字", raw: bindingJSON(t, map[string]any{"mode": "direct", "updatedAt": 1700000000123}), want: 1700000000123},
		{name: "数字字符串", raw: bindingJSON(t, map[string]any{"mode": "direct", "updatedAt": "1700000000456"}), want: 1700000000456},
		{name: "负数归零", raw: bindingJSON(t, map[string]any{"mode": "direct", "updatedAt": -5}), want: 0},
		{name: "非数字归零", raw: bindingJSON(t, map[string]any{"mode": "direct", "updatedAt": "yesterday"}), want: 0},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			binding, err := parseBinding(testCase.raw)
			if err != nil {
				t.Fatalf("parseBinding() error = %v", err)
			}
			if binding.UpdatedAtMS != testCase.want {
				t.Errorf("UpdatedAtMS = %d，期望 %d", binding.UpdatedAtMS, testCase.want)
			}
		})
	}
}

// TestBindingKey 锁住键格式与空引用保护。
func TestBindingKey(t *testing.T) {
	t.Parallel()
	if got := bindingKey(" acct_0123456789abcdef0123 "); got != "account:egress:acct_0123456789abcdef0123" {
		t.Errorf("bindingKey() = %q", got)
	}
	if got := bindingKey("   "); got != "" {
		t.Errorf("空引用的 bindingKey() = %q，期望空串", got)
	}
}

// TestParseBindingErrorMessage 保证形状错误保留 Node 的错误码文案。
func TestParseBindingErrorMessage(t *testing.T) {
	t.Parallel()
	_, err := parseBinding("{}")
	if err == nil || !strings.Contains(err.Error(), "invalid_account_egress_binding_record") {
		t.Fatalf("parseBinding({}) error = %v，期望包含 invalid_account_egress_binding_record", err)
	}
}
