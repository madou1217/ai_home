package modelcatalogsettings

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const (
	testRefA = "acct_11111111111111111111"
	testRefB = "acct_22222222222222222222"
	// testNow 固定归一化用的「当前时间」，让缺失时间戳的断言可复现。
	testNow = int64(1_700_000_000_000)
)

func priceOf(value float64) *float64 {
	return &value
}

// TestNormalizeAccountModelFields 锁住 v5 记录字段的防御性归一化。
func TestNormalizeAccountModelFields(t *testing.T) {
	document := map[string]any{
		"accountModels": []any{map[string]any{
			"model":         " Claude-Sonnet-4 ",
			"provider":      " CLaude ",
			"accountRef":    " " + testRefA + " ",
			"enabled":       false,
			"manual":        true,
			"default":       true,
			"defaultModel":  false,
			"description":   "  主力  ",
			"customPricing": map[string]any{"input": 3.0, "output": "15", "cache_read": 0.3, "cacheWrite": -1.0, "bogus": 9.0},
			"createdAt":     1000.0,
			"created_at":    999.0,
			"updatedAt":     2000.0,
		}},
	}
	settings := normalizeAt(document, testNow)
	if settings.Version != SettingsVersion {
		t.Fatalf("version = %d, want %d", settings.Version, SettingsVersion)
	}
	if len(settings.AccountModels) != 1 {
		t.Fatalf("accountModels = %d, want 1", len(settings.AccountModels))
	}
	record := settings.AccountModels[0]
	if record.ID != "Claude-Sonnet-4" || record.Provider != "claude" || record.AccountRef != testRefA {
		t.Fatalf("identity = %q/%q/%q", record.ID, record.Provider, record.AccountRef)
	}
	if record.Enabled || !record.Manual || !record.DefaultModel {
		t.Fatalf("flags enabled=%v manual=%v default=%v", record.Enabled, record.Manual, record.DefaultModel)
	}
	if record.Description != "主力" {
		t.Fatalf("description = %q", record.Description)
	}
	wantPricing := &CustomPricing{
		Input:     priceOf(3),
		Output:    priceOf(15),
		CacheRead: priceOf(0.3),
	}
	if !reflect.DeepEqual(record.CustomPricing, wantPricing) {
		t.Fatalf("customPricing = %+v, want %+v", record.CustomPricing, wantPricing)
	}
	if record.CreatedAtMS != 1000 || record.UpdatedAtMS != 2000 {
		t.Fatalf("timestamps = %d/%d", record.CreatedAtMS, record.UpdatedAtMS)
	}
}

// TestNormalizeDedupesAndSorts 锁住 (accountRef, 小写 id) 身份和落盘顺序。
func TestNormalizeDedupesAndSorts(t *testing.T) {
	document := map[string]any{
		"accountModels": []any{
			map[string]any{"id": "b-model", "provider": "zcode", "accountRef": testRefB},
			map[string]any{"id": "a-model", "provider": "zcode", "accountRef": testRefA},
			map[string]any{"id": "A-MODEL", "provider": "zcode", "accountRef": testRefA, "manual": true},
			map[string]any{"id": "c-model", "provider": "claude", "accountRef": testRefA},
		},
	}
	records := normalizeAt(document, testNow).AccountModels
	if len(records) != 3 {
		t.Fatalf("accountModels = %d, want 3: %+v", len(records), records)
	}
	got := []string{records[0].Provider + "/" + records[0].AccountRef + "/" + records[0].ID,
		records[1].Provider + "/" + records[1].AccountRef + "/" + records[1].ID,
		records[2].Provider + "/" + records[2].AccountRef + "/" + records[2].ID}
	want := []string{"claude/" + testRefA + "/c-model", "zcode/" + testRefA + "/A-MODEL", "zcode/" + testRefB + "/b-model"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("records = %v, want %v", got, want)
	}
	if !records[1].Manual {
		t.Fatal("后写入的同身份记录必须覆盖前一条")
	}
}

// TestNormalizeSplitsLegacyAndDropsAccountScopeMarkers 锁住 models[] 的三路分流。
func TestNormalizeSplitsLegacyAndDropsAccountScopeMarkers(t *testing.T) {
	document := map[string]any{
		"models": []any{
			map[string]any{"id": "account-model", "provider": "claude", "accountRef": testRefA},
			map[string]any{"id": "legacy-model", "provider": "claude", "manual": true, "description": " 旧 "},
			map[string]any{"id": "legacy-model", "provider": "claude", "enabled": false},
			map[string]any{"id": "legacy-model", "provider": "zcode"},
			map[string]any{"id": "bad-ref", "accountRef": "acct_bad"},
			map[string]any{"id": "account-key-model", "accountKey": "k"},
			map[string]any{"id": "account-id-model", "accountId": 3},
			map[string]any{"id": "unique-key-model", "uniqueKey": "u"},
			map[string]any{"id": "", "provider": "claude"},
		},
	}
	settings := normalizeAt(document, testNow)
	if len(settings.AccountModels) != 1 || settings.AccountModels[0].ID != "account-model" {
		t.Fatalf("accountModels = %+v", settings.AccountModels)
	}
	if len(settings.LegacyModels) != 2 {
		t.Fatalf("legacyModels = %+v", settings.LegacyModels)
	}
	legacy := settings.LegacyModels[0]
	if legacy.ID != "legacy-model" || legacy.Provider != "claude" || legacy.Enabled || legacy.Manual {
		t.Fatalf("claude legacy = %+v", legacy)
	}
	if settings.LegacyModels[1].Provider != "zcode" {
		t.Fatalf("zcode legacy = %+v", settings.LegacyModels[1])
	}
}

// TestNormalizeCustomPricing 只保留已知维度的非负有限数，缺值不落空键。
func TestNormalizeCustomPricing(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  *CustomPricing
	}{
		{name: "missing", value: nil, want: nil},
		{name: "not object", value: "pricing", want: nil},
		{name: "empty array", value: []any{}, want: nil},
		{name: "negative", value: map[string]any{"input": -1.0}, want: nil},
		{name: "non numeric", value: map[string]any{"input": "abc"}, want: nil},
		{name: "zero is a price", value: map[string]any{"input": 0.0}, want: &CustomPricing{Input: priceOf(0)}},
		{name: "legacy cache key", value: map[string]any{"cache_read": "0.5"}, want: &CustomPricing{CacheRead: priceOf(0.5)}},
		{name: "modern key shadows legacy", value: map[string]any{"cacheRead": nil, "cache_read": 0.5}, want: nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizeCustomPricing(testCase.value)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("normalizeCustomPricing() = %+v, want %+v", got, testCase.want)
			}
		})
	}
}

// TestNormalizeToleratesGarbage 坏文档一律降级成空设置，不 panic 也不阻塞读取。
func TestNormalizeToleratesGarbage(t *testing.T) {
	documents := []any{
		nil,
		"",
		"null",
		"not json",
		"[]",
		map[string]any{"accountModels": "x", "models": 5.0, "updatedAt": "abc"},
	}
	for _, document := range documents {
		settings := Normalize(document)
		if settings.Version != SettingsVersion || settings.UpdatedAtMS != 0 {
			t.Fatalf("%v: version=%d updatedAt=%d", document, settings.Version, settings.UpdatedAtMS)
		}
		if settings.AccountModels == nil || settings.LegacyModels == nil {
			t.Fatalf("%v: 空数组必须是空切片", document)
		}
		if len(settings.AccountModels) != 0 || len(settings.LegacyModels) != 0 {
			t.Fatalf("%v: 应当没有任何记录", document)
		}
	}

	// Node 只认字面布尔 false；字符串 "false" 不能把模型停用。
	settings := normalizeAt(map[string]any{
		"accountModels": []any{map[string]any{"id": "m", "accountRef": testRefA, "enabled": "false"}},
	}, testNow)
	if !settings.AccountModels[0].Enabled {
		t.Fatal("非布尔 enabled 必须保持启用")
	}
}

// TestNormalizeIsIdempotent 保证 Go 写回的文档再读一遍不变形。
func TestNormalizeIsIdempotent(t *testing.T) {
	document := map[string]any{
		"accountModels": []any{
			map[string]any{"id": "claude-sonnet-4", "provider": "claude", "accountRef": testRefA, "customPricing": map[string]any{"input": 3.0}},
			map[string]any{"id": "gpt-5", "provider": "unknown", "accountRef": testRefB, "default": true},
		},
		"models":    []any{map[string]any{"id": "legacy-model", "provider": "zcode"}},
		"updatedAt": 123.0,
	}
	first := normalizeAt(document, testNow)
	second := normalizeAt(first, testNow)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("二次归一化改变了文档：\nfirst=%+v\nsecond=%+v", first, second)
	}
}

// TestSettingsJSONShape 锁住落盘字段：空数组、版本号、未设置的自定义价不出现。
func TestSettingsJSONShape(t *testing.T) {
	payload, err := json.Marshal(Normalize(nil))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(payload) != `{"version":5,"accountModels":[],"legacyModels":[],"updatedAt":0}` {
		t.Fatalf("empty settings = %s", payload)
	}

	settings := normalizeAt(map[string]any{
		"accountModels": []any{map[string]any{"id": "claude-sonnet-4", "provider": "claude", "accountRef": testRefA}},
	}, testNow)
	payload, err = json.Marshal(settings.AccountModels[0])
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if strings.Contains(string(payload), "customPricing") {
		t.Fatalf("没有自定义价的记录不应落 customPricing: %s", payload)
	}
}
