package translation

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSettingsPersistenceAndRoutes(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	now := time.UnixMilli(1700000000000)

	// 初始为空
	got, err := ReadSettings(ctx, dbPath)
	if err != nil {
		t.Fatalf("ReadSettings empty err = %v", err)
	}
	if got != nil {
		t.Fatalf("ReadSettings empty = %+v, want nil", got)
	}

	// 无效数据目录拒绝写入
	if _, err := WriteSettingsPatch(ctx, "", map[string]any{"source": "en"}, now); err == nil {
		t.Fatalf("expected error on empty databasePath")
	}

	// 写入全量合法补丁，忽略未知字段，规范化 route
	updated, err := WriteSettingsPatch(ctx, dbPath, map[string]any{
		"source":          "en",
		"target":          "zh",
		"model":           "gpt-4.1",
		"provider":        "codex",
		"systemEnabled":   true,
		"autoCopy":        false,
		"copyScope":       "all",
		"readingTheme":    "dark",
		"executionTarget": "local",
		"targetPolicy":    "fixed",
		"shortcut":        "CommandOrControl+Shift+T",
		"chatShortcut":    "CommandOrControl+Shift+Y",
		"unknownKey":      "should-be-ignored",
		"routes": []any{
			map[string]any{
				"id":         "r1",
				"provider":   "deepl",
				"model":      "deepl-default",
				"enabled":    true,
				"priority":   0,
				"operations": []any{"selection", "page"},
			},
			map[string]any{
				"id":            "r2",
				"provider":      "aih-gateway",
				"model":         "gpt-4.1",
				"modelProvider": "codex",
				"enabled":       true,
				"priority":      1,
			},
		},
	}, now)
	if err != nil {
		t.Fatalf("WriteSettingsPatch err = %v", err)
	}
	if updated.Source != "en" || updated.Target != "zh-Hans" || updated.Model != "gpt-4.1" || updated.Provider != "codex" {
		t.Fatalf("unexpected updated settings: %+v", updated)
	}
	if len(updated.Routes) != 2 || updated.Routes[0].Provider != "deepl" || updated.Routes[1].Model != "gpt-4.1" {
		t.Fatalf("unexpected routes: %+v", updated.Routes)
	}

	// 重读校验局部补丁保留原值
	patched, err := WriteSettingsPatch(ctx, dbPath, map[string]any{
		"autoCopy": true,
	}, now.Add(time.Second))
	if err != nil {
		t.Fatalf("second WriteSettingsPatch err = %v", err)
	}
	if !patched.AutoCopy || patched.Model != "gpt-4.1" || len(patched.Routes) != 2 {
		t.Fatalf("patch failed to preserve existing fields: %+v", patched)
	}

	reloaded, err := ReadSettings(ctx, dbPath)
	if err != nil || reloaded == nil {
		t.Fatalf("ReadSettings err = %v, val = %+v", err, reloaded)
	}
	if !reloaded.AutoCopy || reloaded.UpdatedAt != now.Add(time.Second).UnixMilli() {
		t.Fatalf("reloaded mismatch: %+v", reloaded)
	}
}

func TestProviderDescriptorsAndConfigPersistence(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	now := time.UnixMilli(1700000001000)

	descs := BuiltinProviderDescriptors()
	if len(descs) != 8 {
		t.Fatalf("BuiltinProviderDescriptors len = %d, want 8", len(descs))
	}
	deepl, ok := FindProviderDescriptor("deepl")
	if !ok {
		t.Fatalf("deepl descriptor missing")
	}
	if !CanExecuteProvider("deepl", "selection") || !CanExecuteProvider("aih-gateway", "selection") {
		t.Fatalf("CanExecuteProvider invariants failed")
	}

	// 未知字段应返回 400 ConfigError
	_, err := WriteProviderConfig(ctx, dbPath, deepl, map[string]any{"badField": "x"}, now)
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) || cfgErr.StatusCode != 400 {
		t.Fatalf("expected 400 ConfigError for unknown field, got %v", err)
	}

	// 写入 secret (apiKey) 和普通 endpoint，投影结果不暴露明文 secret
	proj, err := WriteProviderConfig(ctx, dbPath, deepl, map[string]any{
		"apiKey":   "secret-key-123",
		"endpoint": "https://api-free.deepl.com/v2/translate",
	}, now)
	if err != nil {
		t.Fatalf("WriteProviderConfig err = %v", err)
	}
	if !proj.Configured || !proj.SecretConfigured["apiKey"] {
		t.Fatalf("expected configured=true and apiKey configured: %+v", proj)
	}
	if _, leaksSecret := proj.Values["apiKey"]; leaksSecret {
		t.Fatalf("secret apiKey must not appear in PublicProviderConfig.Values")
	}
	if proj.Values["endpoint"] != "https://api-free.deepl.com/v2/translate" {
		t.Fatalf("unexpected endpoint in Values: %+v", proj.Values)
	}

	// 内部读取应包含明文 apiKey 供适配器调用
	rawCfg, err := ReadProviderConfig(ctx, dbPath, deepl)
	if err != nil {
		t.Fatalf("ReadProviderConfig err = %v", err)
	}
	if rawCfg["apiKey"] != "secret-key-123" {
		t.Fatalf("ReadProviderConfig missing secret: %+v", rawCfg)
	}

	// 列表状态展示 deepl 已配置
	statuses, err := ListProviderStatuses(ctx, dbPath)
	if err != nil || len(statuses) != 8 {
		t.Fatalf("ListProviderStatuses err=%v len=%d", err, len(statuses))
	}
	var foundDeepL bool
	for _, s := range statuses {
		if s.ID == "deepl" {
			foundDeepL = true
			if !s.Configured || !s.Executable {
				t.Fatalf("deepl status unexpected: %+v", s)
			}
		}
	}
	if !foundDeepL {
		t.Fatalf("deepl missing from ListProviderStatuses")
	}
}
