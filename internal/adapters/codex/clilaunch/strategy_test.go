package clilaunch_test

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	"github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
)

const (
	codexAccessSecret  = "codex-access-secret-must-not-leak"
	codexRefreshSecret = "codex-refresh-secret-must-not-leak"
	codexAPIKeySecret  = "codex-api-key-secret-must-not-leak"
)

// TestStrategyBuildsOAuthProjection 验证 OAuth 使用官方 auth.json 且投影保持共享原生状态。
func TestStrategyBuildsOAuthProjection(t *testing.T) {
	auth := mustOAuth(t)
	binding := mustBinding(t, auth)
	result, err := clilaunch.NewStrategy().Build(binding)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if result.ProviderID() != codex.ProviderID || !result.IsValid() {
		t.Fatalf("StrategyResult 无效: provider=%s", result.ProviderID())
	}
	projectionInput, exists := result.Projection()
	if !exists {
		t.Fatal("缺少 OAuth 投影")
	}
	if projectionInput.OwnerAccountRef() != binding.AccountRef() ||
		projectionInput.EnvironmentKey() != "CODEX_HOME" ||
		!projectionInput.PreserveNativeState() {
		t.Fatalf("OAuth 投影合同错误: %v", projectionInput)
	}
	files := projectionInput.Files()
	if len(files) != 1 || files[0].RelativePath() != "auth.json" || files[0].Mode() != 0o600 {
		t.Fatalf("OAuth 投影文件错误: %#v", files)
	}
	decoded, err := authfile.Decode(files[0].RevealContent(), authfile.DecodeOptions{})
	if err != nil {
		t.Fatalf("投影 auth.json 不能重新解析: %v", err)
	}
	decodedOAuth, ok := decoded.(*codex.OAuthAuth)
	if !ok ||
		decodedOAuth.AccessToken() != auth.AccessToken() ||
		decodedOAuth.RefreshToken() != auth.RefreshToken() ||
		decodedOAuth.IDToken() != auth.IDToken() {
		t.Fatal("OAuth 投影没有无损保存官方凭据")
	}
	if resultCredential := result.Credential(); resultCredential.Kind() != "oauth" ||
		resultCredential.Mode() != "refreshable" {
		t.Fatalf("OAuth 摘要错误: %v", resultCredential)
	}
	environment := result.Environment()
	if len(environment.RevealSet()) != 0 ||
		!slices.Contains(environment.UnsetNames(), "OPENAI_API_KEY") ||
		!slices.Contains(environment.UnsetNames(), "CODEX_ACCESS_TOKEN") {
		t.Fatalf("OAuth 环境隔离错误: %v", environment)
	}
	assertNoSecrets(t, result, projectionInput, files[0])
}

// TestStrategyBuildsAPIKeyProviderArgs 验证 API Key endpoint 进入 Responses model_provider 而非无效环境别名。
func TestStrategyBuildsAPIKeyProviderArgs(t *testing.T) {
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  codexAPIKeySecret,
		BaseURL: "https://gateway.example.test/openai/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	result, err := clilaunch.NewStrategy().Build(mustBinding(t, auth))
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if _, exists := result.Projection(); exists {
		t.Fatal("API Key 不应创建 auth.json 投影")
	}
	arguments := result.Arguments()
	wantArguments := []string{
		"-c", "model_provider=aih_account",
		"-c", `model_providers.aih_account.name="AIH Account"`,
		"-c", "model_providers.aih_account.base_url=https://gateway.example.test/openai/v1",
		"-c", "model_providers.aih_account.wire_api=responses",
		"-c", "model_providers.aih_account.env_key=OPENAI_API_KEY",
	}
	if !slices.Equal(arguments, wantArguments) {
		t.Fatalf("API Key 参数错误:\n got=%v\nwant=%v", arguments, wantArguments)
	}
	if !slices.Equal(
		result.ArgumentsAfterSubcommands(),
		[]string{"exec", "resume", "app-server"},
	) {
		t.Fatalf("Codex 参数插入策略错误: %v", result.ArgumentsAfterSubcommands())
	}
	resolvedExec, err := result.ResolveArguments([]string{"exec", "--json"})
	if err != nil {
		t.Fatalf("ResolveArguments(exec) error = %v", err)
	}
	wantExec := append([]string{"exec"}, wantArguments...)
	wantExec = append(wantExec, "--json")
	if !slices.Equal(resolvedExec, wantExec) {
		t.Fatalf("exec 参数位置错误:\n got=%v\nwant=%v", resolvedExec, wantExec)
	}
	resolvedRoot, err := result.ResolveArguments([]string{"--version"})
	if err != nil {
		t.Fatalf("ResolveArguments(root) error = %v", err)
	}
	wantRoot := append(append([]string(nil), wantArguments...), "--version")
	if !slices.Equal(resolvedRoot, wantRoot) {
		t.Fatalf("根参数位置错误:\n got=%v\nwant=%v", resolvedRoot, wantRoot)
	}
	resolvedPrompt, err := result.ResolveArguments([]string{"--model", "exec"})
	if err != nil {
		t.Fatalf("ResolveArguments(prompt) error = %v", err)
	}
	wantPrompt := append(append([]string(nil), wantArguments...), "--model", "exec")
	if !slices.Equal(resolvedPrompt, wantPrompt) {
		t.Fatalf("非首 token 误触发子命令规则:\n got=%v\nwant=%v", resolvedPrompt, wantPrompt)
	}
	for _, argument := range arguments {
		if strings.Contains(argument, codexAPIKeySecret) {
			t.Fatal("API Key 泄漏到 argv")
		}
	}
	environment := result.Environment()
	if environment.RevealSet()["OPENAI_API_KEY"] != codexAPIKeySecret ||
		slices.Contains(environment.UnsetNames(), "OPENAI_API_KEY") ||
		!slices.Contains(environment.UnsetNames(), "OPENAI_BASE_URL") {
		t.Fatalf("API Key 环境错误: %v", environment)
	}
	credential := result.Credential()
	if credential.Kind() != "api_key" || credential.Mode() != "" {
		t.Fatalf("API Key 摘要错误: %v", credential)
	}
	assertNoSecrets(t, result, environment)
}

// TestStrategyRejectsInvalidAndForeignBindings 验证空绑定和其他 Provider 凭据失败关闭。
func TestStrategyRejectsInvalidAndForeignBindings(t *testing.T) {
	strategy := clilaunch.NewStrategy()
	if _, err := strategy.Build(accountapp.CredentialBinding{}); !errors.Is(err, clilaunch.ErrInvalidBinding) {
		t.Fatalf("Build(empty) error = %v", err)
	}
	foreign := foreignCredential{}
	accountRef, err := accountapp.NewCredentialBinding(
		mustOAuthBinding(t).AccountRef(),
		codex.ProviderID,
		foreign,
	)
	if err != nil {
		t.Fatalf("NewCredentialBinding() error = %v", err)
	}
	if _, err := strategy.Build(accountRef); !errors.Is(err, clilaunch.ErrUnsupportedCredential) {
		t.Fatalf("Build(foreign) error = %v", err)
	}
}

// mustOAuth 创建可被官方 auth.json 编码器往返的测试 OAuth。
func mustOAuth(t *testing.T) *codex.OAuthAuth {
	t.Helper()
	idToken := buildJWT(t, map[string]any{
		"sub": "codex-launch-user",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":    "codex-launch-user",
			"chatgpt_account_id": "codex-launch-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       codexAccessSecret,
		RefreshToken:      codexRefreshSecret,
		IDToken:           idToken,
		RefreshedAtMS:     1_700_000_000_000,
		ExplicitAccountID: "codex-launch-workspace",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// mustBinding 创建凭据身份派生的稳定账号绑定。
func mustBinding(t *testing.T, credential accountapp.Credential) accountapp.CredentialBinding {
	t.Helper()
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(accountRef, codex.ProviderID, credential)
	if err != nil {
		t.Fatalf("NewCredentialBinding() error = %v", err)
	}
	return binding
}

// mustOAuthBinding 创建测试错误分支需要的有效 Codex 账号引用。
func mustOAuthBinding(t *testing.T) accountapp.CredentialBinding {
	t.Helper()
	return mustBinding(t, mustOAuth(t))
}

// buildJWT 创建领域测试使用的无签名三段 JWT；不用于任何网络认证。
func buildJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("Marshal(claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// assertNoSecrets 验证常用格式化路径不会输出任何 Codex 凭据。
func assertNoSecrets(t *testing.T, values ...any) {
	t.Helper()
	formatted := ""
	for _, value := range values {
		formatted += fmt.Sprintf("%v\n%+v\n%#v\n", value, value, value)
	}
	for _, secret := range []string{codexAccessSecret, codexRefreshSecret, codexAPIKeySecret} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("格式化结果泄漏 Codex 凭据 %q: %s", secret, formatted)
		}
	}
}

// foreignCredential 模拟 Provider 一致但不属于封闭 Codex 领域的非法凭据实现。
type foreignCredential struct{}

// ProviderID 返回伪造的 Codex Provider。
func (foreignCredential) ProviderID() string { return codex.ProviderID }

// IdentitySeed 返回测试使用的稳定伪造身份。
func (foreignCredential) IdentitySeed() string { return "foreign:codex:launch" }

// String 返回不含凭据的测试摘要。
func (foreignCredential) String() string { return "foreignCredential" }

// GoString 返回不含凭据的测试摘要。
func (foreignCredential) GoString() string { return "foreignCredential" }
