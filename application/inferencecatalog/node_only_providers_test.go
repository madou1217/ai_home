package inferencecatalog

import (
	"context"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

type stubModelReader struct {
	models []accountapp.RoutableModel
}

func (reader stubModelReader) ListRoutableModels(context.Context) ([]accountapp.RoutableModel, error) {
	return reader.models, nil
}

type stubFactory struct {
	providerID inference.ProviderID
}

func (factory stubFactory) ProviderID() inference.ProviderID { return factory.providerID }

func (factory stubFactory) BuildRoute(runtimecore.ModelID) (inferencegateway.Route, error) {
	return inferencegateway.Route{}, nil
}

func mustRoutableModel(t *testing.T, catalog *providers.Catalog, providerID, modelID string) accountapp.RoutableModel {
	t.Helper()
	model, err := accountapp.NewRoutableModel(catalog, providerID, modelID)
	if err != nil {
		t.Fatalf("NewRoutableModel(%s, %s) error = %v", providerID, modelID, err)
	}
	return model
}

// 2026-11-06 事故：kiro 的模型没有 Factory，Build 直接失败，整个 Go 路由目录变空，
// 所有请求都被交还 Node。Node-only Provider 必须显式声明并跳过，而不是让快照失败。
func TestBuildSkipsDeclaredNodeOnlyProviders(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	builder, err := NewBuilder(
		stubModelReader{models: []accountapp.RoutableModel{
			mustRoutableModel(t, catalog, "kiro", "kiro-test-model"),
		}},
		stubFactory{providerID: "codex"},
	)
	if err != nil {
		t.Fatal(err)
	}
	builder.WithNodeOnlyProviders("kiro")
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Build() error = %v（node-only Provider 不应让整个快照失败）", err)
	}
	if snapshot.RouteCount() != 0 {
		t.Fatalf("node-only Provider 不应产生 Canonical 规则: %d", snapshot.RouteCount())
	}
	if snapshot.ModelCount() != 0 {
		t.Fatalf("node-only Provider 的模型不应进 Go 目录: %d", snapshot.ModelCount())
	}
}

func TestBuildStillFailsForUndeclaredProviderWithoutFactory(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	builder, err := NewBuilder(
		stubModelReader{models: []accountapp.RoutableModel{
			mustRoutableModel(t, catalog, "kiro", "kiro-test-model"),
		}},
		stubFactory{providerID: "codex"},
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = builder.Build(context.Background())
	if err == nil {
		t.Fatal("未声明的 Provider 缺 Factory 必须报错（防止漏注册被静默吞掉）")
	}
	if !strings.Contains(err.Error(), "kiro") {
		t.Fatalf("错误必须带上 Provider: %v", err)
	}
}
