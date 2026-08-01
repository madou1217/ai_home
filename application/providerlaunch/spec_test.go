package providerlaunch_test

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
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

// TestProjectionRequestProtectsFilesAndOwnership 验证投影路径、0600 权限、账号归属和内容副本。
func TestProjectionRequestProtectsFilesAndOwnership(t *testing.T) {
	accountRef := mustAccountRef(t, "acct_0123456789abcdef0123")
	content := []byte(specSecret)
	file, err := providerlaunch.NewProjectionFile("auth.json", content)
	if err != nil {
		t.Fatalf("NewProjectionFile() error = %v", err)
	}
	content[0] = 'X'
	request, err := providerlaunch.NewProjectionRequest(
		providerlaunch.ProjectionRequestInput{
			OwnerAccountRef:     accountRef,
			EnvironmentKey:      "CODEX_HOME",
			PreserveNativeState: true,
			Files:               []providerlaunch.ProjectionFile{file},
		},
	)
	if err != nil {
		t.Fatalf("NewProjectionRequest() error = %v", err)
	}
	files := request.Files()
	if len(files) != 1 || files[0].Mode() != 0o600 ||
		string(files[0].RevealContent()) != specSecret {
		t.Fatalf("投影文件错误: %#v", files)
	}
	mutated := files[0].RevealContent()
	mutated[0] = 'Y'
	if string(request.Files()[0].RevealContent()) != specSecret {
		t.Fatal("投影文件内容被外部修改")
	}
	if request.OwnerAccountRef() != accountRef ||
		request.EnvironmentKey() != "CODEX_HOME" ||
		!request.PreserveNativeState() {
		t.Fatalf("投影合同错误: %v", request)
	}
	assertRedacted(t, request, specSecret)
	assertRedacted(t, file, specSecret)
}

// TestProjectionRequestRejectsUnsafePathsAndAmbiguousFiles 验证路径穿越和重复目标不能进入 Runtime。
func TestProjectionRequestRejectsUnsafePathsAndAmbiguousFiles(t *testing.T) {
	for _, relativePath := range []string{"", "/auth.json", "../auth.json", "dir/../auth.json", `dir\auth.json`} {
		t.Run(relativePath, func(t *testing.T) {
			if _, err := providerlaunch.NewProjectionFile(relativePath, []byte("secret")); err == nil {
				t.Fatal("不安全投影路径应被拒绝")
			}
		})
	}
	file, err := providerlaunch.NewProjectionFile("auth.json", []byte("secret"))
	if err != nil {
		t.Fatalf("NewProjectionFile() error = %v", err)
	}
	if _, err := providerlaunch.NewProjectionRequest(
		providerlaunch.ProjectionRequestInput{
			OwnerAccountRef:     mustAccountRef(t, "acct_0123456789abcdef0123"),
			EnvironmentKey:      "CODEX_HOME",
			PreserveNativeState: true,
			Files:               []providerlaunch.ProjectionFile{file, file},
		},
	); err == nil {
		t.Fatal("重复投影文件应被拒绝")
	}
}

// TestStrategyResultCopiesArgumentsAndProjection 验证 Strategy 输出不能通过切片或指针修改。
func TestStrategyResultCopiesArgumentsAndProjection(t *testing.T) {
	environment, err := providerlaunch.NewEnvironmentPatch(map[string]string{"TOKEN": specSecret}, nil)
	if err != nil {
		t.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	file, err := providerlaunch.NewProjectionFile("auth.json", []byte(specSecret))
	if err != nil {
		t.Fatalf("NewProjectionFile() error = %v", err)
	}
	projection, err := providerlaunch.NewProjectionRequest(providerlaunch.ProjectionRequestInput{
		OwnerAccountRef:     mustAccountRef(t, "acct_0123456789abcdef0123"),
		EnvironmentKey:      "CODEX_HOME",
		PreserveNativeState: true,
		Files:               []providerlaunch.ProjectionFile{file},
	})
	if err != nil {
		t.Fatalf("NewProjectionRequest() error = %v", err)
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
		Projection:                &projection,
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
}

// mustAccountRef 创建测试使用的规范稳定账号引用。
func mustAccountRef(t *testing.T, value string) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
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
