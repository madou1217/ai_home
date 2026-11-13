package clilaunch

import (
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestBuildAPIKeyInjectsCredentialEnv 守住 api-key 账号的启动边界：密钥只进子进程，
// 宿主 CODEBUDDY_AUTH_TOKEN 被剥掉，伪 HOME 仍然要求投影。
func TestBuildAPIKeyInjectsCredentialEnv(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "codebuddycn",
		APIKey:     "sk-test-family-key",
		BaseURL:    "https://example.invalid/v2",
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(accountRef, "codebuddycn", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	strategy, err := NewStrategy("codebuddycn", true)
	if err != nil {
		t.Fatalf("strategy: %v", err)
	}
	result, err := strategy.Build(binding)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	environment := result.Environment()
	set := environment.RevealSet()
	if set["CODEBUDDY_API_KEY"] != "sk-test-family-key" {
		t.Fatalf("api key env = %#v", set)
	}
	if set["CODEBUDDY_BASE_URL"] != "https://example.invalid/v2" {
		t.Fatalf("base url env = %#v", set)
	}
	if set["CODEBUDDY_INTERNET_ENVIRONMENT"] != "internal" {
		t.Fatalf("site env = %#v", set)
	}
	if !contains(environment.UnsetNames(), "CODEBUDDY_AUTH_TOKEN") {
		t.Fatalf("AUTH_TOKEN 必须被剥掉: %#v", environment.UnsetNames())
	}
	if !result.Projection().Required() || result.Projection().Mode() != providerlaunch.ProjectionModeFakeHome {
		t.Fatalf("投影要求 = %#v", result.Projection())
	}
	if result.Credential().Kind() != accountcore.StaticAPIKeyAuthKind {
		t.Fatalf("credential kind = %q", result.Credential().Kind())
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// TestBuildRejectsWrongProvider api-key 不能跨 Provider 复用。
func TestBuildRejectsWrongProvider(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "codebuddy",
		APIKey:     "sk-other",
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	binding, err := accountapp.NewCredentialBinding(accountRef, "codebuddy", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	strategy, _ := NewStrategy("codebuddycn", true)
	err = nil
	if _, buildErr := strategy.Build(binding); buildErr != nil {
		err = buildErr
	}
	if err == nil {
		t.Fatal("跨 Provider 的 api-key 必须被拒绝")
	}
}

// TestBuildInternationalStripsHostSite api-key 国际站账号必须剥掉宿主的站点选择，
// 否则宿主选了国内站会把这个账号静默打到另一个站点。
func TestBuildInternationalStripsHostSite(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "codebuddy",
		APIKey:     "sk-intl",
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	binding, err := accountapp.NewCredentialBinding(accountRef, "codebuddy", credential)
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	strategy, _ := NewStrategy("codebuddy", false)
	result, err := strategy.Build(binding)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	unset := result.Environment().UnsetNames()
	if !contains(unset, "CODEBUDDY_INTERNET_ENVIRONMENT") ||
		!contains(unset, "CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT") {
		t.Fatalf("国际站必须剥掉宿主站点变量: %v", unset)
	}
	if !contains(unset, "CODEBUDDY_CONFIG_DIR") || !contains(unset, "WORKBUDDY_CONFIG_DIR") {
		t.Fatalf("配置根变量必须剥掉: %v", unset)
	}
	if set := result.Environment().RevealSet(); set["CODEBUDDY_INTERNET_ENVIRONMENT"] != "" {
		t.Fatalf("国际站不应注入站点变量: %#v", set)
	}
}
