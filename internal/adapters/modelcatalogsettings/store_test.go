package modelcatalogsettings

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func tempDatabasePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), appstate.DatabaseFileName)
}

func readStoredDocument(t *testing.T, databasePath string) map[string]any {
	t.Helper()
	value, found, err := appstate.ReadKV(context.Background(), databasePath, DatabaseKey)
	if err != nil {
		t.Fatalf("ReadKV: %v", err)
	}
	if !found {
		t.Fatalf("app_kv 缺少 %q", DatabaseKey)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(value), &document); err != nil {
		t.Fatalf("落盘 JSON 非法: %v", err)
	}
	return document
}

// TestLoadMissingDatabase 验证全新数据根返回空设置而不是错误。
func TestLoadMissingDatabase(t *testing.T) {
	settings, err := Load(context.Background(), tempDatabasePath(t))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if settings.Version != SettingsVersion || len(settings.AccountModels) != 0 || len(settings.LegacyModels) != 0 {
		t.Fatalf("settings = %+v", settings)
	}
	if settings.UpdatedAtMS != 0 {
		t.Fatalf("updatedAt = %d", settings.UpdatedAtMS)
	}
}

// TestSaveThenLoadRoundTrip 验证归一化结果落盘、可原样读回，坏记录不会入库。
func TestSaveThenLoadRoundTrip(t *testing.T) {
	ctx := context.Background()
	databasePath := tempDatabasePath(t)
	saved, err := Save(ctx, databasePath, map[string]any{
		"version": 1.0,
		"accountModels": []any{
			map[string]any{
				"id": "claude-sonnet-4", "provider": "claude", "accountRef": testRefA,
				"manual": true, "description": " 主力 ",
				"customPricing": map[string]any{"input": 3.0},
			},
			map[string]any{"id": "gpt-5", "provider": "codex", "accountRef": testRefA, "enabled": false},
			map[string]any{"id": "ghost", "accountRef": "acct_zzz"},
		},
		"models": []any{map[string]any{"id": "legacy-model", "provider": "zcode"}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if saved.Version != SettingsVersion {
		t.Fatalf("version = %d, want %d", saved.Version, SettingsVersion)
	}
	if saved.UpdatedAtMS <= 0 {
		t.Fatalf("updatedAt = %d", saved.UpdatedAtMS)
	}
	if len(saved.AccountModels) != 2 || len(saved.LegacyModels) != 1 {
		t.Fatalf("saved = %+v", saved)
	}

	loaded, err := Load(ctx, databasePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !settingsEqual(loaded, saved) {
		t.Fatalf("round trip changed settings:\nloaded=%+v\nsaved=%+v", loaded, saved)
	}

	if _, err := os.Stat(databasePath); err != nil {
		t.Fatalf("app-state.db 未创建: %v", err)
	}
	document := readStoredDocument(t, databasePath)
	if document["version"] != float64(SettingsVersion) {
		t.Fatalf("落盘 version = %v", document["version"])
	}
	if document["updatedAt"] != float64(saved.UpdatedAtMS) {
		t.Fatalf("落盘 updatedAt = %v, want %d", document["updatedAt"], saved.UpdatedAtMS)
	}
	if len(document["accountModels"].([]any)) != 2 {
		t.Fatalf("落盘 accountModels = %v", document["accountModels"])
	}
	if len(document["legacyModels"].([]any)) != 1 {
		t.Fatalf("落盘 legacyModels = %v", document["legacyModels"])
	}
	for _, item := range document["accountModels"].([]any) {
		record, _ := item.(map[string]any)
		if _, present := record["defaultModel"]; !present {
			t.Fatalf("账号记录必须带 defaultModel: %v", record)
		}
		if record["id"] == "gpt-5" {
			if _, present := record["customPricing"]; present {
				t.Fatalf("gpt-5 不应有 customPricing: %v", record)
			}
		}
	}
}

// TestLoadNormalizesLegacyDocument 验证 Node 写下的脏文档读取时被清洗。
func TestLoadNormalizesLegacyDocument(t *testing.T) {
	ctx := context.Background()
	databasePath := tempDatabasePath(t)
	raw := `{"version":5,"accountModels":[{"id":"m1","accountRef":"acct_bad"},{"id":"m2","provider":"unknown","accountRef":"` + testRefA + `"}],"models":[{"id":"legacy","provider":"claude","enabled":false}],"updatedAt":123}`
	if err := appstate.WriteKV(ctx, databasePath, DatabaseKey, raw, 123); err != nil {
		t.Fatalf("seed: %v", err)
	}
	settings, err := Load(ctx, databasePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(settings.AccountModels) != 1 || settings.AccountModels[0].ID != "m2" {
		t.Fatalf("accountModels = %+v", settings.AccountModels)
	}
	if settings.AccountModels[0].Provider != "" {
		t.Fatalf("未知 provider 必须归空: %+v", settings.AccountModels[0])
	}
	if len(settings.LegacyModels) != 1 || settings.LegacyModels[0].Enabled {
		t.Fatalf("legacyModels = %+v", settings.LegacyModels)
	}
	if settings.UpdatedAtMS != 123 {
		t.Fatalf("updatedAt = %d", settings.UpdatedAtMS)
	}
}

// TestSaveRequiresDatabasePath 空路径必须显式失败，不能静默写出无关的库。
func TestSaveRequiresDatabasePath(t *testing.T) {
	if _, err := Save(context.Background(), "  ", nil); !errors.Is(err, ErrMissingDatabasePath) {
		t.Fatalf("Save() error = %v", err)
	}
	settings, err := Load(context.Background(), "")
	if err != nil || settings.Version != SettingsVersion {
		t.Fatalf("Load empty = %+v, %v", settings, err)
	}
}

func settingsEqual(left Settings, right Settings) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}
