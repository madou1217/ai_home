package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// identityVectorContract 是跨语言身份向量契约。
//
// Node 侧由 test/codex-oauth-identity-vector.test.js 读同一份文件。两端都从
// `acct_` + sha256("unique:" + seed)[:20] 派生 accountRef，所以种子差一个字符就会
// 给同一个上游账号铸出两个本地账号——这个测试把那种偏差变成失败，而不是静默分叉。
//
// 见 docs/architecture/codex-oauth-identity-vector-adr.md。
type identityVectorContract struct {
	Provider         string   `json:"provider"`
	Kind             string   `json:"kind"`
	SeedPrefix       string   `json:"seed_prefix"`
	ClaimNamespace   string   `json:"claim_namespace"`
	SourceToken      string   `json:"source_token"`
	UserIDClaimOrder []string `json:"user_id_claim_order"`
	Vectors          []struct {
		Name   string `json:"name"`
		Tokens struct {
			IDToken     string `json:"id_token"`
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
		WantUserID       string `json:"want_user_id"`
		WantIdentitySeed string `json:"want_identity_seed"`
		WantAccountRef   string `json:"want_account_ref"`
	} `json:"vectors"`
}

// syntheticAccessToken 只在契约没有提供 access_token 时使用。
//
// 目的是让失败的向量**只可能因为身份链**失败：如果 access token 缺失，NewOAuthAuth 会
// 先因为缺 access token 报错，那样测试就测不到身份判定，等于把一条空断言伪装成通过。
const syntheticAccessToken = "synthetic-access-token"

// syntheticRefreshToken 同上：凭证结构要求它非空。
const syntheticRefreshToken = "synthetic-refresh-token"

// loadIdentityVectorContract 读取并校验契约文件的结构。
func loadIdentityVectorContract(t *testing.T) identityVectorContract {
	t.Helper()

	path := filepath.Join("..", "..", "..", "contracts", "codex-oauth-identity.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取身份向量契约失败: %v", err)
	}
	var contract identityVectorContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("解析身份向量契约失败: %v", err)
	}
	if len(contract.Vectors) < 10 {
		t.Fatalf("契约向量过少: %d", len(contract.Vectors))
	}
	return contract
}

// TestCodexOAuthIdentityVectorMatchesContract 用共享契约逐个钉住身份向量。
//
// 断言的是**端到端**结果：ID Token → identitySeed → accountRef。任何一环与 Node 不一致
// 都会在这里失败。
func TestCodexOAuthIdentityVectorMatchesContract(t *testing.T) {
	t.Parallel()

	contract := loadIdentityVectorContract(t)

	if contract.Provider != ProviderID {
		t.Fatalf("契约 Provider = %q, 期望 %q", contract.Provider, ProviderID)
	}
	if contract.Kind != "oauth" {
		t.Fatalf("契约 Kind = %q", contract.Kind)
	}
	if contract.ClaimNamespace != codexAuthClaimNamespace {
		t.Fatalf(
			"契约 claim 命名空间 = %q, 期望 %q",
			contract.ClaimNamespace,
			codexAuthClaimNamespace,
		)
	}
	// 身份只取自 ID Token，且取值链固定为 chatgpt_user_id → user_id → sub。
	if contract.SourceToken != "id_token" {
		t.Fatalf("契约 source_token = %q", contract.SourceToken)
	}
	wantOrder := []string{"chatgpt_user_id", "user_id", "sub"}
	if len(contract.UserIDClaimOrder) != len(wantOrder) {
		t.Fatalf("契约取值链 = %v", contract.UserIDClaimOrder)
	}
	for index, want := range wantOrder {
		if contract.UserIDClaimOrder[index] != want {
			t.Fatalf("契约取值链 = %v, 期望 %v", contract.UserIDClaimOrder, wantOrder)
		}
	}

	for _, vector := range contract.Vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			t.Parallel()

			accessToken := vector.Tokens.AccessToken
			if accessToken == "" {
				accessToken = syntheticAccessToken
			}
			auth, err := NewOAuthAuth(OAuthInput{
				AccessToken:  accessToken,
				RefreshToken: syntheticRefreshToken,
				IDToken:      vector.Tokens.IDToken,
			})

			if vector.WantIdentitySeed == "" {
				if err == nil {
					t.Fatalf(
						"期望身份不可验证，却得到 seed=%q",
						auth.IdentitySeed(),
					)
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

// TestCodexOAuthIdentityNeverUsesEmail 是这条 ADR 存在的理由本身。
//
// 邮箱只在展示与导入关联里出现；一旦它参与身份，邮箱变更就会改写 accountRef，而这正是
// §8.1 明文禁止的。这里用一个「只有邮箱、没有稳定用户 ID」的 ID Token 钉住它。
func TestCodexOAuthIdentityNeverUsesEmail(t *testing.T) {
	t.Parallel()

	idToken := buildTestJWT(map[string]any{
		"sub":                      "",
		"email":                    "user@example.com",
		codexProfileClaimNamespace: map[string]any{"email": "user@example.com"},
		codexAuthClaimNamespace:    map[string]any{},
	})
	if _, err := NewOAuthAuth(OAuthInput{
		AccessToken:  syntheticAccessToken,
		RefreshToken: syntheticRefreshToken,
		IDToken:      idToken,
	}); err == nil {
		t.Fatal("只有邮箱的 ID Token 不应产生身份")
	}

	// 同一份 claim 里同时有邮箱和用户 ID 时，身份必须只取用户 ID。
	idToken = buildTestJWT(map[string]any{
		"sub":                      "sub-user",
		"email":                    "user@example.com",
		codexProfileClaimNamespace: map[string]any{"email": "user@example.com"},
		codexAuthClaimNamespace:    map[string]any{"chatgpt_user_id": "user-123"},
	})
	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken:  syntheticAccessToken,
		RefreshToken: syntheticRefreshToken,
		IDToken:      idToken,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	if got, want := auth.IdentitySeed(), "oauth:codex:user-123"; got != want {
		t.Fatalf("IdentitySeed() = %q, 期望 %q", got, want)
	}
	if auth.IdentitySeed() == "oauth:codex:user@example.com" {
		t.Fatal("身份向量回退到了邮箱")
	}
}
