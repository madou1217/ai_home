package providerlaunch_test

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

const specSecret = "provider-launch-secret-must-not-leak"

// TestEnvironmentPatchIsImmutableAndRedacted 验证环境值只能经显式接口取得且不能反向修改。
func TestEnvironmentPatchIsImmutableAndRedacted(t *testing.T) {
	input := map[string]string{"SECRET_TOKEN": specSecret}
	patch, err := providerlaunch.NewEnvironmentPatch(
		input,
		[]string{"OLD_TOKEN", "LEGACY_TOKEN"},
	)
	if err != nil {
		t.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	input["SECRET_TOKEN"] = "mutated-input"
	revealed := patch.RevealSet()
	if revealed["SECRET_TOKEN"] != specSecret {
		t.Fatal("构造输入修改影响了环境补丁")
	}
	revealed["SECRET_TOKEN"] = "mutated-output"
	if patch.RevealSet()["SECRET_TOKEN"] != specSecret {
		t.Fatal("显式读取结果修改影响了环境补丁")
	}
	if !slices.Equal(patch.SetNames(), []string{"SECRET_TOKEN"}) ||
		!slices.Equal(patch.UnsetNames(), []string{"LEGACY_TOKEN", "OLD_TOKEN"}) {
		t.Fatalf("环境变量名不稳定: set=%v unset=%v", patch.SetNames(), patch.UnsetNames())
	}
	assertRedacted(t, patch, specSecret)
}

// TestEnvironmentPatchRejectsInvalidInputs 验证环境名、空值、NUL 和 set/unset 冲突均失败关闭。
func TestEnvironmentPatchRejectsInvalidInputs(t *testing.T) {
	tests := []struct {
		name  string
		set   map[string]string
		unset []string
	}{
		{name: "变量名以数字开头", set: map[string]string{"1TOKEN": "value"}},
		{name: "变量值为空", set: map[string]string{"TOKEN": ""}},
		{name: "变量值含 NUL", set: map[string]string{"TOKEN": "value\x00suffix"}},
		{name: "删除变量重复", unset: []string{"TOKEN", "TOKEN"}},
		{name: "设置和删除冲突", set: map[string]string{"TOKEN": "value"}, unset: []string{"TOKEN"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := providerlaunch.NewEnvironmentPatch(test.set, test.unset); err == nil {
				t.Fatal("无效环境补丁应被拒绝")
			}
		})
	}
}

// TestStrategyResultCopiesArgumentsAndRuntime 验证 Strategy 输出不能通过切片或 Runtime 副本修改。
func TestStrategyResultCopiesArgumentsAndRuntime(t *testing.T) {
	environment, err := providerlaunch.NewEnvironmentPatch(map[string]string{"TOKEN": specSecret}, nil)
	if err != nil {
		t.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	runtime, err := providerlaunch.NewCodexExternalAuthRuntime(
		specSecret,
		"workspace-test",
		"plus",
	)
	if err != nil {
		t.Fatalf("NewCodexExternalAuthRuntime() error = %v", err)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor("oauth", "refreshable")
	if err != nil {
		t.Fatalf("NewCredentialDescriptor() error = %v", err)
	}
	arguments := []string{"-c", "model_provider=openai"}
	afterSubcommands := []string{"exec"}
	result, err := providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:                "codex",
		Binary:                    "codex",
		Arguments:                 arguments,
		ArgumentsAfterSubcommands: afterSubcommands,
		Environment:               environment,
		Runtime:                   runtime,
		Credential:                descriptor,
	})
	if err != nil {
		t.Fatalf("NewStrategyResult() error = %v", err)
	}
	arguments[0] = "mutated"
	afterSubcommands[0] = "mutated"
	if !result.IsValid() {
		t.Fatal("外部修改影响了 Strategy 结果")
	}
	revealedRuntime := result.Runtime().RevealParameters()
	revealedRuntime["access_token"] = "mutated"
	if result.Runtime().RevealParameters()["access_token"] != specSecret {
		t.Fatal("Runtime 敏感参数被外部修改")
	}
	resolved, err := result.ResolveArguments([]string{"exec", "--json"})
	if err != nil {
		t.Fatalf("ResolveArguments() error = %v", err)
	}
	if !slices.Equal(resolved, []string{"exec", "-c", "model_provider=openai", "--json"}) {
		t.Fatalf("参数插入结果错误: %v", resolved)
	}
	if _, err := result.ResolveArguments([]string{"exec", "bad\x00argument"}); !errors.Is(
		err,
		providerlaunch.ErrInvalidProcessArguments,
	) {
		t.Fatalf("ResolveArguments(NUL) error = %v", err)
	}
	assertRedacted(t, result, specSecret, "workspace-test", "plus")
	assertRedacted(t, result.Runtime(), specSecret, "workspace-test", "plus")
}

// TestStrategyResultRejectsAccountScopedHomes 验证任何 Strategy 都不能切换共享状态根。
func TestStrategyResultRejectsAccountScopedHomes(t *testing.T) {
	descriptor, err := providerlaunch.NewCredentialDescriptor("oauth", "refreshable")
	if err != nil {
		t.Fatalf("NewCredentialDescriptor() error = %v", err)
	}
	for _, key := range []string{
		"HOME",
		"USERPROFILE",
		"XDG_CONFIG_HOME",
		"CODEX_HOME",
		"CODEX_SQLITE_HOME",
		"CLAUDE_CONFIG_DIR",
	} {
		t.Run(key+" set", func(t *testing.T) {
			environment, patchErr := providerlaunch.NewEnvironmentPatch(map[string]string{key: "/tmp/account-home"}, nil)
			if patchErr != nil {
				t.Fatalf("NewEnvironmentPatch() error = %v", patchErr)
			}
			if _, strategyErr := providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
				ProviderID:  "codex",
				Binary:      "codex",
				Environment: environment,
				Runtime:     providerlaunch.NewDirectProcessRuntime(),
				Credential:  descriptor,
			}); !errors.Is(strategyErr, providerlaunch.ErrInvalidStrategyResult) {
				t.Fatalf("NewStrategyResult(%s set) error = %v", key, strategyErr)
			}
		})
		t.Run(key+" unset", func(t *testing.T) {
			environment, patchErr := providerlaunch.NewEnvironmentPatch(nil, []string{key})
			if patchErr != nil {
				t.Fatalf("NewEnvironmentPatch() error = %v", patchErr)
			}
			if _, strategyErr := providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
				ProviderID:  "claude",
				Binary:      "claude",
				Environment: environment,
				Runtime:     providerlaunch.NewDirectProcessRuntime(),
				Credential:  descriptor,
			}); !errors.Is(strategyErr, providerlaunch.ErrInvalidStrategyResult) {
				t.Fatalf("NewStrategyResult(%s unset) error = %v", key, strategyErr)
			}
		})
	}
}

// assertRedacted 验证所有常用 fmt 路径均不会输出指定秘密。
func assertRedacted(t *testing.T, value any, secrets ...string) {
	t.Helper()
	formatted := strings.Join([]string{
		fmt.Sprintf("%v", value),
		fmt.Sprintf("%+v", value),
		fmt.Sprintf("%#v", value),
		fmt.Sprintf("%s", value),
	}, "\n")
	for _, secret := range secrets {
		if secret != "" && strings.Contains(formatted, secret) {
			t.Fatalf("格式化结果泄漏凭据 %q: %s", secret, formatted)
		}
	}
}
