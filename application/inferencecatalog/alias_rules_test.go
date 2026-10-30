package inferencecatalog

import (
	"reflect"
	"testing"

	"github.com/madou1217/ai_home/application/modelalias"
)

func TestAliasDisplayModelsListsConcreteAliasItself(t *testing.T) {
	got := aliasDisplayModels(modelalias.Record{Alias: "my-model", Target: "gpt-6.1-sol"}, "codex")
	want := []modelalias.DisplayModel{{Alias: "my-model", Target: "gpt-6.1-sol", Provider: "codex"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("display models = %#v, want %#v", got, want)
	}
}

func TestAliasDisplayModelsExpandsWildcardFromNodeProjection(t *testing.T) {
	record := modelalias.Record{
		Alias:  "claude-*",
		Target: "claude-opus-5.5",
		// 前缀不符与含通配符的条目必须丢掉。
		DisplayModels: []string{"claude-opus-5-5", "gpt-6.1-sol", "claude-sonnet-5-5", "claude-*"},
	}
	got := aliasDisplayModels(record, "kiro")
	want := []modelalias.DisplayModel{
		{Alias: "claude-opus-5-5", Target: "claude-opus-5.5", Provider: "kiro"},
		{Alias: "claude-sonnet-5-5", Target: "claude-opus-5.5", Provider: "kiro"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("display models = %#v, want %#v", got, want)
	}
}

func TestAliasDisplayModelsOmitsWildcardWithoutProjection(t *testing.T) {
	if got := aliasDisplayModels(modelalias.Record{Alias: "claude-*", Target: "claude-opus-5.5"}, "kiro"); len(got) != 0 {
		t.Fatalf("wildcard without display list should list nothing, got %#v", got)
	}
}
