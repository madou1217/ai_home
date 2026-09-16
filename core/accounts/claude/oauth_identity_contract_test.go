package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// claudeIdentityVectorContract 是 Claude OAuth 身份向量的跨语言契约。
//
// Node 侧由 test/claude-oauth-identity-vector.test.js 读同一份文件。两端都从
// `acct_` + sha256("unique:" + seed)[:20] 派生 accountRef，所以种子差一个字符就会给同一个
// Claude 账号铸出两个本地账号。
//
// 这份契约钉住的三个真实分歧：Node 原先保留 UUID 的原始大小写、接受非 UUID 字符串、
// 并把未 trim 的值 trim 掉；而 Go 统一小写、强制 UUID 形状、直接拒绝未 trim 的值。
//
// 见 docs/architecture/codex-oauth-identity-vector-adr.md。
type claudeIdentityVectorContract struct {
	Provider      string `json:"provider"`
	Kind          string `json:"kind"`
	SeedPrefix    string `json:"seed_prefix"`
	SourceField   string `json:"source_field"`
	Normalization string `json:"normalization"`
	Vectors       []struct {
		Name             string `json:"name"`
		AccountUUID      string `json:"account_uuid"`
		AccountEmail     string `json:"account_email"`
		WantIdentitySeed string `json:"want_identity_seed"`
		WantAccountRef   string `json:"want_account_ref"`
	} `json:"vectors"`
}

func loadClaudeIdentityVectorContract(t *testing.T) claudeIdentityVectorContract {
	t.Helper()

	path := filepath.Join("..", "..", "..", "contracts", "claude-oauth-identity.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 Claude 身份向量契约失败: %v", err)
	}
	var contract claudeIdentityVectorContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("解析 Claude 身份向量契约失败: %v", err)
	}
	if len(contract.Vectors) < 10 {
		t.Fatalf("契约向量过少: %d", len(contract.Vectors))
	}
	return contract
}

// TestClaudeOAuthIdentityVectorMatchesContract 用共享契约逐个钉住 Claude 身份向量。
//
// 断言的是端到端结果：account.uuid → identitySeed → accountRef。
func TestClaudeOAuthIdentityVectorMatchesContract(t *testing.T) {
	t.Parallel()

	contract := loadClaudeIdentityVectorContract(t)

	if contract.Provider != ProviderID {
		t.Fatalf("契约 Provider = %q, 期望 %q", contract.Provider, ProviderID)
	}
	if contract.Kind != "oauth" {
		t.Fatalf("契约 Kind = %q", contract.Kind)
	}
	if contract.SeedPrefix != "oauth:claude:uuid:" {
		t.Fatalf("契约 seed 前缀 = %q", contract.SeedPrefix)
	}
	if contract.SourceField != "claudeAiOauth.account.uuid" {
		t.Fatalf("契约来源字段 = %q", contract.SourceField)
	}

	for _, vector := range contract.Vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()

			identity, err := ValidateOAuthIdentity(OAuthIdentity{
				AccountUUID: vector.AccountUUID,
			})
			if vector.WantIdentitySeed == "" {
				if err == nil {
					t.Fatalf("期望身份不可验证，却得到 %q", identity.AccountUUID)
				}
				return
			}
			if err != nil {
				t.Fatalf("期望 seed=%q，却报错: %v", vector.WantIdentitySeed, err)
			}

			auth, err := NewOAuthAuth(OAuthInput{
				AccessToken:  "synthetic-access-token",
				RefreshToken: "synthetic-refresh-token",
				ExpiresAtMS:  1900000000000,
				Scopes:       []string{"user:inference"},
				Identity:     identity,
			})
			if err != nil {
				t.Fatalf("NewOAuthAuth() error = %v", err)
			}
			if got := auth.IdentitySeed(); got != vector.WantIdentitySeed {
				t.Fatalf("IdentitySeed() = %q, 期望 %q", got, vector.WantIdentitySeed)
			}

			accountRef, err := accountcore.DeriveAccountRef(auth)
			if err != nil {
				t.Fatalf("DeriveAccountRef() error = %v", err)
			}
			if got := accountRef.String(); got != vector.WantAccountRef {
				t.Fatalf("accountRef = %q, 期望 %q", got, vector.WantAccountRef)
			}
		})
	}
}

// TestClaudeOAuthIdentityUuidIsCaseInsensitive 单独钉住「大小写不产生第二个账号」。
//
// 这是这份契约存在的主要理由：Go 一直统一小写，Node 曾经保留原始大小写，
// 于是同一个账号在两端得到不同的 accountRef。
func TestClaudeOAuthIdentityUuidIsCaseInsensitive(t *testing.T) {
	t.Parallel()

	lower := "1fb09d73-89ab-cdef-0123-456789abcdef"
	upper := "1FB09D73-89AB-CDEF-0123-456789ABCDEF"

	refFor := func(raw string) string {
		t.Helper()
		identity, err := ValidateOAuthIdentity(OAuthIdentity{AccountUUID: raw})
		if err != nil {
			t.Fatalf("ValidateOAuthIdentity(%q) error = %v", raw, err)
		}
		auth, err := NewOAuthAuth(OAuthInput{
			AccessToken:  "synthetic-access-token",
			RefreshToken: "synthetic-refresh-token",
			ExpiresAtMS:  1900000000000,
			Scopes:       []string{"user:inference"},
			Identity:     identity,
		})
		if err != nil {
			t.Fatalf("NewOAuthAuth() error = %v", err)
		}
		accountRef, err := accountcore.DeriveAccountRef(auth)
		if err != nil {
			t.Fatalf("DeriveAccountRef() error = %v", err)
		}
		return accountRef.String()
	}

	if refFor(lower) != refFor(upper) {
		t.Fatalf("大小写不同却得到不同 accountRef: %s vs %s", refFor(lower), refFor(upper))
	}
}
