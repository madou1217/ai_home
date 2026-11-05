package modelcatalog

import (
	"context"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestKnownModelsAreAllRoutable(t *testing.T) {
	if len(KnownModels) == 0 {
		t.Fatal("静态清单为空")
	}
	for _, model := range KnownModels {
		if !IsRoutableModelID(model) {
			t.Fatalf("%q 不在 %s 命名空间", model, NamespacePrefix)
		}
	}
	// Node 侧刻意排除的命名空间不能再混进来。
	for _, model := range KnownModels {
		if len(model) >= len("cline-free/") && model[:len("cline-free/")] == "cline-free/" {
			t.Fatalf("不应包含 cline-free 模型: %q", model)
		}
	}
}

func TestDiscoverModelsReturnsCopy(t *testing.T) {
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_01ABC")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{}}`))
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	source := New()
	models, err := source.DiscoverModels(context.Background(), credential)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != len(KnownModels) {
		t.Fatalf("模型数 = %d, want %d", len(models), len(KnownModels))
	}
	models[0] = "mutated"
	if KnownModels[0] == "mutated" {
		t.Fatal("返回值必须是副本，不能改到包级清单")
	}
}
