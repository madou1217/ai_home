package modelcatalog

import (
	"context"
	"errors"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// goldenModels 是 cline 目录的冻结快照，来源是迁移前 Node 的 KNOWN_CLINE_MODELS
// （官方 SDK 的推荐清单，已逐条对 /chat/completions 实测可用）。
//
// 为什么要在 Go 侧再钉一遍：Node 的静态清单已删除，Go 成为唯一真值源；如果只断言
// 「都在 cline-pass/ 命名空间里」，删一条模型、加一条上游没实测过的模型都不会报错，
// 目录会静默漂移。改动这份清单必须同时改测试，并在提交信息里说明实测依据。
var goldenModels = []string{
	"cline-pass/deepseek-v4-pro",
	"cline-pass/deepseek-v4.1-flash",
	"cline-pass/glm-5.3",
	"cline-pass/glm-5.3-flash",
	"cline-pass/kimi-k3",
	"cline-pass/mimo-v2.5",
	"cline-pass/mimo-v2.5-pro",
	"cline-pass/mimo-v2.6-flash",
	"cline-pass/mimo-v2.6-pro",
	"cline-pass/minimax-m3",
	"cline-pass/muse-spark-1.3-contributor",
	"cline-pass/qwen3.7-max",
	"cline-pass/qwen3.7-plus",
	"cline-pass/qwen3.8-max",
}

func clineCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_01ABC")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{}}`))
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

func TestKnownModelsMatchGoldenList(t *testing.T) {
	if len(KnownModels) != len(goldenModels) {
		t.Fatalf("模型数 = %d, want %d", len(KnownModels), len(goldenModels))
	}
	for index, want := range goldenModels {
		if KnownModels[index] != want {
			t.Fatalf("KnownModels[%d] = %q, want %q", index, KnownModels[index], want)
		}
	}
	// 顺序也是对外契约的一部分：WebUI 与 CLI 按清单顺序展示，重排会让目录看起来变过。
	for _, model := range KnownModels {
		if model != strings.ToLower(strings.TrimSpace(model)) {
			t.Fatalf("%q 必须是已归一的小写 ID", model)
		}
		if !IsRoutableModelID(model) {
			t.Fatalf("%q 不在 %s 命名空间", model, NamespacePrefix)
		}
		// Node 侧刻意排除的命名空间不能再混进来（本网关 API 面上一律 403）。
		if strings.HasPrefix(model, "cline-free/") {
			t.Fatalf("不应包含 cline-free 模型: %q", model)
		}
	}
}

func TestIsRoutableModelID(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"cline-pass/glm-5.3", true},
		{"CLINE-PASS/GLM-5.3", true},
		{"  cline-pass/glm-5.3  ", true},
		// 裸模型名会与 zcode 的 glm-* 抢路由，绝不能认。
		{"glm-5.3", false},
		{"cline-free/mimo-v2.6-flash", false},
		{"", false},
		{"anthropic/claude-sonnet-4.5", false},
	}
	for _, testCase := range cases {
		if got := IsRoutableModelID(testCase.model); got != testCase.want {
			t.Fatalf("IsRoutableModelID(%q) = %v, want %v", testCase.model, got, testCase.want)
		}
	}
}

func TestDiscoverModelsReturnsCopy(t *testing.T) {
	source := New()
	models, err := source.DiscoverModels(context.Background(), clineCredential(t))
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

// 静态清单不联网：目录源根本不持有 HTTP 客户端，任何 Provider 的凭据都不该改变结果。
func TestDiscoverModelsRejectsForeignCredential(t *testing.T) {
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "user_02XYZ")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{}}`))
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	if _, err := New().DiscoverModels(context.Background(), credential); !errors.Is(err, ErrUnsupportedCredential) {
		t.Fatalf("error = %v, want ErrUnsupportedCredential", err)
	}
}

func TestDiscoverModelsRejectsMissingInput(t *testing.T) {
	source := New()
	if _, err := source.DiscoverModels(nil, clineCredential(t)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil ctx error = %v, want ErrInvalidRequest", err)
	}
	if _, err := source.DiscoverModels(context.Background(), nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("nil credential error = %v, want ErrInvalidRequest", err)
	}
}
