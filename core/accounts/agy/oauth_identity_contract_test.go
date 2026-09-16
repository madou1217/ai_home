package agy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// agyIdentityVectorContract 是 AGY OAuth 身份向量的跨语言契约。
//
// Node 侧由 test/agy-oauth-identity-vector.test.js 读同一份文件。
//
// AGY 是唯一以邮箱为身份向量的 Provider：它的原生 oauthToken 文档里没有 user id 或 uuid，
// 没有更稳定的字段可用。所以这里要钉的不是「用哪个字段」，而是**校验强度**——
// Node 原先只做 trim + lowercase，会铸出 `oauth:agy:no-at-sign` 这类 Go 直接拒绝的种子，
// 也就是「Node 能建、Go 永远寻址不到」的账号。
//
// 见 docs/architecture/codex-oauth-identity-vector-adr.md。
type agyIdentityVectorContract struct {
	Provider      string `json:"provider"`
	Kind          string `json:"kind"`
	SeedPrefix    string `json:"seed_prefix"`
	SourceField   string `json:"source_field"`
	Normalization string `json:"normalization"`
	Vectors       []struct {
		Name             string `json:"name"`
		Email            string `json:"email"`
		WantIdentitySeed string `json:"want_identity_seed"`
		WantAccountRef   string `json:"want_account_ref"`
	} `json:"vectors"`
}

func loadAgyIdentityVectorContract(t *testing.T) agyIdentityVectorContract {
	t.Helper()

	path := filepath.Join("..", "..", "..", "contracts", "agy-oauth-identity.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 AGY 身份向量契约失败: %v", err)
	}
	var contract agyIdentityVectorContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("解析 AGY 身份向量契约失败: %v", err)
	}
	if len(contract.Vectors) < 17 {
		t.Fatalf("契约向量过少: %d", len(contract.Vectors))
	}
	return contract
}

// newContractOAuthAuth 用给定邮箱构造一个满足领域校验的 AGY OAuth 凭据。
func newContractOAuthAuth(t *testing.T, email string) (*OAuthAuth, error) {
	t.Helper()
	return NewOAuthAuth(OAuthInput{
		Email:         email,
		AccessToken:   "synthetic-access-token",
		RefreshToken:  "synthetic-refresh-token",
		ExpiresAtMS:   1900000000000,
		RefreshedAtMS: 1800000000000,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	})
}

// TestAgyOAuthIdentityVectorMatchesContract 用共享契约逐个钉住 AGY 身份向量。
func TestAgyOAuthIdentityVectorMatchesContract(t *testing.T) {
	t.Parallel()

	contract := loadAgyIdentityVectorContract(t)

	if contract.Provider != ProviderID {
		t.Fatalf("契约 Provider = %q, 期望 %q", contract.Provider, ProviderID)
	}
	if contract.Kind != "oauth" {
		t.Fatalf("契约 Kind = %q", contract.Kind)
	}
	if contract.SeedPrefix != "oauth:agy:" {
		t.Fatalf("契约 seed 前缀 = %q", contract.SeedPrefix)
	}
	if contract.SourceField != "nativeAuth.email" {
		t.Fatalf("契约来源字段 = %q", contract.SourceField)
	}

	for _, vector := range contract.Vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()

			auth, err := newContractOAuthAuth(t, vector.Email)
			if vector.WantIdentitySeed == "" {
				if err == nil {
					t.Fatalf("期望身份不可验证，却得到 seed=%q", auth.IdentitySeed())
				}
				return
			}
			if err != nil {
				t.Fatalf("期望 seed=%q，却报错: %v", vector.WantIdentitySeed, err)
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

// TestAgyOAuthIdentityEmailValidation 单独钉住邮箱形状校验。
//
// 这些输入 Go 的 mail.ParseAddress 会拒绝；Node 必须同样拒绝，否则会铸出
// Go 永远寻址不到的账号。
func TestAgyOAuthIdentityEmailValidation(t *testing.T) {
	t.Parallel()

	rejected := []string{
		"user:tag@example.com",
		"user..name@example.com",
		".user@example.com",
		"user.@example.com",
		`"a b"@example.com`,
		"user@example.com.",
		"@example.com",
		"user@",
		"no-at-sign",
		"a b@c.com",
		"",
	}
	for _, email := range rejected {
		if _, err := newContractOAuthAuth(t, email); err == nil {
			t.Fatalf("邮箱 %q 应当被拒绝", email)
		}
	}

	accepted := []string{
		"user@example.com",
		"USER@Example.COM",
		" user@example.com ",
		"user@localhost",
		"user+tag@example.com",
		"user@[127.0.0.1]",
	}
	for _, email := range accepted {
		if _, err := newContractOAuthAuth(t, email); err != nil {
			t.Fatalf("邮箱 %q 应当被接受: %v", email, err)
		}
	}
}
