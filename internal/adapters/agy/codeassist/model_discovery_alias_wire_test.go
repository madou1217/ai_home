package codeassist

import (
	"reflect"
	"testing"
)

// 目录里的别名 ID 必须每次刷新都解析到同一个 wire model：Go map 遍历顺序
// 不固定，冲突别名若按「最后写入者赢」，同一份上游响应会产生漂移的转发表。
func TestDecodeModelCatalogAliasWireDeterministic(t *testing.T) {
	payload := []byte(`{
		"models": {
			"zeta-flash-tiered": {"aliases": ["shared-flash", "zeta-flash-high"]},
			"alpha-flash-tiered": {"aliases": ["shared-flash", "alpha-flash-high"]}
		}
	}`)
	var wantModels []string
	var wantWires map[string]string
	for iteration := 0; iteration < 200; iteration++ {
		models, wires, err := decodeModelCatalog(payload)
		if err != nil {
			t.Fatal(err)
		}
		if iteration == 0 {
			wantModels, wantWires = models, wires
			continue
		}
		if !reflect.DeepEqual(models, wantModels) || !reflect.DeepEqual(wires, wantWires) {
			t.Fatalf("iteration %d drifted: models = %v, wires = %v, want models = %v, want wires = %v",
				iteration, models, wires, wantModels, wantWires)
		}
	}
	if got := wantWires["shared-flash"]; got != "alpha-flash-tiered" {
		t.Fatalf("shared-flash wire = %q, want deterministic winner alpha-flash-tiered", got)
	}
	for alias, want := range map[string]string{
		"alpha-flash-high": "alpha-flash-tiered",
		"zeta-flash-high":  "zeta-flash-tiered",
	} {
		if got := wantWires[alias]; got != want {
			t.Fatalf("alias %q wire = %q, want declaring base %q", alias, got, want)
		}
	}
}

// 转发表必须闭合到目录内的真实模型：别名链、deprecated 链都要在刷新时展开，
// 否则 Resolve 会把另一个公开 ID（甚至别名）当成 wire model 发给上游。
func TestDecodeModelCatalogAliasWireClosure(t *testing.T) {
	payload := []byte(`{
		"models": {
			"base-model": {"aliases": ["old-alias"]},
			"old-base": {"aliases": ["new-alias"]}
		},
		"deprecatedModelIds": {
			"legacy-model": "old-alias",
			"old-base": "base-model"
		}
	}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	wantWires := map[string]string{
		"legacy-model": "base-model",
		"old-alias":    "base-model",
		"old-base":     "base-model",
		"new-alias":    "base-model",
	}
	if !reflect.DeepEqual(wires, wantWires) {
		t.Fatalf("wires = %v, want %v", wires, wantWires)
	}
	assertWireClosure(t, models, wires)
}

// 别名与 deprecated 互相指向时不能把环写进转发表；热路径只有一次 map 读取，
// 环会让 Resolve 落在另一个待转发 ID 上。环整体丢弃，目录本身保留。
func TestDecodeModelCatalogAliasWireCycleDropped(t *testing.T) {
	payload := []byte(`{
		"models": {
			"a-model": {"aliases": ["b-model"]}
		},
		"deprecatedModelIds": {"a-model": "b-model"}
	}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(wires) != 0 {
		t.Fatalf("wires = %v, want cycle dropped", wires)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"a-model", "b-model"} {
		if !seen[want] {
			t.Fatalf("model %q missing from %v", want, models)
		}
	}
}

func assertWireClosure(t *testing.T, models []string, wires map[string]string) {
	t.Helper()
	available := make(map[string]struct{}, len(models))
	for _, model := range models {
		available[model] = struct{}{}
	}
	for publicID, wireID := range wires {
		if _, ok := available[publicID]; !ok {
			t.Fatalf("wire key %q not in models %v", publicID, models)
		}
		if _, ok := available[wireID]; !ok {
			t.Fatalf("wire %q -> %q target not in models %v", publicID, wireID, models)
		}
		if _, chained := wires[wireID]; chained {
			t.Fatalf("wire %q -> %q is not flattened", publicID, wireID)
		}
	}
}
