package main

import (
	"bytes"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

func TestBuildLegacyCatalogPreservesPresentationShape(t *testing.T) {
	// 旧版 Node 投影必须保留扁平展示字段，同时继续由规范合同派生。
	manifest := providers.BuiltinManifest()
	legacy := buildLegacyCatalog(manifest)

	if got, want := len(legacy.Providers), len(manifest.Providers); got != want {
		t.Fatalf("旧版 Provider 数量错误: got=%d want=%d", got, want)
	}
	if legacy.Providers[0] != manifest.Providers[0].Presentation {
		t.Fatal("旧版 Provider 展示字段没有从规范合同派生")
	}
	if len(legacy.DeprecatedGatewayProviders) != 1 || legacy.DeprecatedGatewayProviders[0] != "gemini" {
		t.Fatalf("旧版废弃清单错误: %v", legacy.DeprecatedGatewayProviders)
	}
}

func TestRenderClientTypeScriptUsesGeneratedContract(t *testing.T) {
	// Client 文件必须包含生成警告、稳定类型和认证选项目录。
	output, err := renderClientTypeScript(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("生成 TypeScript Provider 投影失败: %v", err)
	}
	for _, expected := range [][]byte{
		[]byte("请编辑 `core/providers/builtins.go`"),
		[]byte("export type ProviderId"),
		[]byte("export const PROVIDER_AUTH_OPTIONS"),
	} {
		if !bytes.Contains(output, expected) {
			t.Fatalf("TypeScript Provider 投影缺少 %q", expected)
		}
	}
}
