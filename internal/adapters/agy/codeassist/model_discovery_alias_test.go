package codeassist

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

func TestDecodeModelCatalogExpandsAliases(t *testing.T) {
	payload := []byte(`{
		"models": {
			"gemini-3.8-flash-tiered": {
				"displayName": "Gemini 3.8 Flash (Medium)",
				"aliases": ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"],
				"commandModelIds": {"low": "gemini-3.8-flash-low"}
			}
		}
	}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"gemini-3.8-flash-tiered", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if !seen[want] {
			t.Fatalf("model %q missing from %v", want, models)
		}
	}
	for _, alias := range []string{"gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if wires[alias] != "gemini-3.8-flash-tiered" {
			t.Fatalf("wire %q = %q", alias, wires[alias])
		}
	}
}

func TestDecodeModelCatalogExpandsTieredBase(t *testing.T) {
	payload := []byte(`{"models":{"gemini-3.8-flash-tiered":{}}}`)
	models, _, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if !seen[want] {
			t.Fatalf("tiered expansion missing %q: %v", want, models)
		}
	}
}

// 上游的别名字段没有类型契约：数字、布尔、对象、非法 ID 都可能出现。
// 畸形形状只能丢弃该别名，不能让目录解码 panic，也不能清空整份目录。
func TestDecodeModelCatalogMalformedAliasShapes(t *testing.T) {
	cases := []struct {
		name    string
		aliases string
		want    []string
	}{
		{"number", `42`, nil},
		{"boolean", `true`, nil},
		{"null", `null`, nil},
		{"empty object", `{}`, nil},
		{"numbers array", `[1, 2, 3.5]`, nil},
		// 非字符串节点被忽略，字符串叶子按目录规则保留。
		{"mixed array", `[null, true, {"nested": [false, ["deep"]]}]`, []string{"deep"}},
		{"display name object", `{"displayName": "Gemini 3.8 Flash (Medium)", "rank": 2}`, nil},
		{"invalid ids", `["", " gemini-3.8-flash-high", "gemini 3.8 flash", "gemini-3.8-flash\u0000high", "chat_gemini", "tab_predict", "MODEL_PLACEHOLDER", "models/gemini", "placeholder-model"]`, nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			payload := []byte(fmt.Sprintf(
				`{"models":{"gemini-3.8-flash":{"aliases":%s}}}`,
				testCase.aliases,
			))
			models, wires, err := decodeModelCatalog(payload)
			if err != nil {
				t.Fatalf("decodeModelCatalog = %v, want base model preserved", err)
			}
			want := append([]string{"gemini-3.8-flash"}, testCase.want...)
			if len(models) != len(want) {
				t.Fatalf("models = %v, want %v", models, want)
			}
			seen := make(map[string]bool, len(models))
			for _, model := range models {
				seen[model] = true
			}
			for _, model := range want {
				if !seen[model] {
					t.Fatalf("model %q missing from %v", model, models)
				}
			}
			if len(wires) != len(testCase.want) {
				t.Fatalf("wires = %v, want only %v", wires, testCase.want)
			}
			for _, alias := range testCase.want {
				if wires[alias] != "gemini-3.8-flash" {
					t.Fatalf("wire %q = %q", alias, wires[alias])
				}
			}
		})
	}
}

// 畸形条目不能连带吞掉同一字段里的合法别名。
func TestDecodeModelCatalogMalformedAliasesDoNotHideValidOnes(t *testing.T) {
	payload := []byte(`{
		"models": {
			"gemini-3.8-flash": {
				"aliases": ["gemini-3.8-flash-high", 7, {"displayName": "Gemini 3.8 Flash (Medium)"}, ["gemini-3.8-flash-low"], "tab_predict", ""],
				"commandModelIds": {"fast": "gemini-3.8-flash-fast", "broken": 3}
			}
		}
	}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatalf("decodeModelCatalog = %v, want valid aliases kept", err)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-fast"} {
		if !seen[want] {
			t.Fatalf("model %q missing from %v", want, models)
		}
	}
	for alias, wire := range map[string]string{
		"gemini-3.8-flash-high": "gemini-3.8-flash",
		"gemini-3.8-flash-low":  "gemini-3.8-flash",
		"gemini-3.8-flash-fast": "gemini-3.8-flash",
	} {
		if wires[alias] != wire {
			t.Fatalf("wire %q = %q, want %q", alias, wires[alias], wire)
		}
	}
	if len(wires) != 3 {
		t.Fatalf("wires = %v, want only valid aliases", wires)
	}
}

// 别名解码是显式栈：深层嵌套不能靠 Go 调用栈递归，也不能无限展开。
func TestDecodeCatalogAliasesDeepNesting(t *testing.T) {
	nest := func(depth int, leaf string) string {
		return strings.Repeat("[", depth) + `"` + leaf + `"` + strings.Repeat("]", depth)
	}
	t.Run("under node budget", func(t *testing.T) {
		const depth = 2000
		payload := []byte(fmt.Sprintf(
			`{"models":{"gemini-3.8-flash":{"aliases":%s}}}`,
			nest(depth, "gemini-3.8-flash-deep"),
		))
		models, wires, err := decodeModelCatalog(payload)
		if err != nil {
			t.Fatalf("decodeModelCatalog = %v", err)
		}
		seen := make(map[string]bool, len(models))
		for _, model := range models {
			seen[model] = true
		}
		if !seen["gemini-3.8-flash-deep"] {
			t.Fatalf("deep alias missing from %v", models)
		}
		if wires["gemini-3.8-flash-deep"] != "gemini-3.8-flash" {
			t.Fatalf("wire = %q", wires["gemini-3.8-flash-deep"])
		}
	})
	t.Run("over node budget", func(t *testing.T) {
		// 每层数组都消耗节点预算，叶子别名必须被丢弃而不是继续展开。
		const depth = 9000
		aliases := decodeCatalogAliases(modelCatalogDetail{
			Aliases: json.RawMessage(nest(depth, "gemini-3.8-flash-deep")),
		})
		if len(aliases) != 0 {
			t.Fatalf("aliases = %v, want node budget to drop leaf", aliases)
		}
	})
	t.Run("beyond json depth limit", func(t *testing.T) {
		const depth = 20000
		// 别名字段自身无法解码时只丢弃别名，目录其余部分仍然可用。
		aliases := decodeCatalogAliases(modelCatalogDetail{
			Aliases: json.RawMessage(nest(depth, "gemini-3.8-flash-deep")),
		})
		if len(aliases) != 0 {
			t.Fatalf("aliases = %v, want none", aliases)
		}
		// 整份目录超过编码器嵌套上限属于无效上游响应，必须稳定报错而不是 panic。
		payload := []byte(fmt.Sprintf(
			`{"models":{"gemini-3.8-flash":{"aliases":%s}}}`,
			nest(depth, "gemini-3.8-flash-deep"),
		))
		models, wires, err := decodeModelCatalog(payload)
		if !errors.Is(err, ErrInvalidUpstreamResponse) {
			t.Fatalf("err = %v, want ErrInvalidUpstreamResponse", err)
		}
		if models != nil || wires != nil {
			t.Fatalf("models = %v, wires = %v, want nil on rejection", models, wires)
		}
	})
}

// 直接喂给别名解码的 RawMessage 也可能是坏 JSON（上游字段被截断）。
// 这类输入只能被忽略，不能 panic。
func TestDecodeCatalogAliasesToleratesBrokenRaw(t *testing.T) {
	for _, raw := range []string{
		`["gemini-3.8-flash-high"`,
		`{"aliases": [`,
		`[{}, ]`,
	} {
		aliases := decodeCatalogAliases(modelCatalogDetail{
			Aliases:              json.RawMessage(raw),
			Alias:                json.RawMessage(raw),
			CommandModelIDs:      json.RawMessage(raw),
			CommandModelIDsSnake: json.RawMessage(raw),
		})
		if len(aliases) != 0 {
			t.Fatalf("decodeCatalogAliases(%q) = %v, want none", raw, aliases)
		}
	}
}

// 别名数量必须有上界：一个模型可以声明成千上万个别名，解码不能把它们全部留在内存里。
func TestDecodeCatalogAliasesIsBounded(t *testing.T) {
	limit := accountapp.MaxDiscoveredModelsPerAccount
	build := func(prefix string, count int) json.RawMessage {
		ids := make([]string, count)
		for index := range ids {
			ids[index] = fmt.Sprintf("%s%04d", prefix, index)
		}
		raw, err := json.Marshal(ids)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	aliases := decodeCatalogAliases(modelCatalogDetail{
		Aliases:              build("alias-a-", limit),
		Alias:                build("alias-b-", limit),
		CommandModelIDs:      build("alias-c-", limit),
		CommandModelIDsSnake: build("alias-d-", limit),
	})
	if len(aliases) > limit {
		t.Fatalf("len(aliases) = %d, want <= %d", len(aliases), limit)
	}
	if len(aliases) == 0 {
		t.Fatal("aliases empty, want bounded but non-empty")
	}
	seen := make(map[string]struct{}, len(aliases))
	for index, alias := range aliases {
		if _, exists := seen[alias]; exists {
			t.Fatalf("duplicate alias %q", alias)
		}
		seen[alias] = struct{}{}
		if index > 0 && aliases[index-1] > alias {
			t.Fatalf("aliases not sorted at %d: %q > %q", index, aliases[index-1], alias)
		}
	}
}

// 目录总量上限与别名预算一致：刚好填满预算的目录可用，超过一档就整体拒绝，
// 不允许出现「部分接收但数量失控」的中间态。
func TestDecodeModelCatalogAliasFloodBoundary(t *testing.T) {
	limit := accountapp.MaxDiscoveredModelsPerAccount
	buildPayload := func(aliasCount int) []byte {
		ids := make([]string, aliasCount)
		for index := range ids {
			ids[index] = fmt.Sprintf("alias-%04d", index)
		}
		raw, err := json.Marshal(ids)
		if err != nil {
			t.Fatal(err)
		}
		return []byte(fmt.Sprintf(`{"models":{"gemini-3.8-flash":{"aliases":%s}}}`, raw))
	}
	models, wires, err := decodeModelCatalog(buildPayload(limit - 1))
	if err != nil {
		t.Fatalf("decodeModelCatalog at limit = %v, want accepted", err)
	}
	if len(models) != limit {
		t.Fatalf("len(models) = %d, want %d", len(models), limit)
	}
	if len(wires) != limit-1 {
		t.Fatalf("len(wires) = %d, want %d", len(wires), limit-1)
	}
	models, wires, err = decodeModelCatalog(buildPayload(limit))
	if err == nil {
		t.Fatalf("decodeModelCatalog over limit = %v, want bounded rejection", models)
	}
	if models != nil || wires != nil {
		t.Fatalf("models = %v, wires = %v, want nil on rejection", models, wires)
	}
}
