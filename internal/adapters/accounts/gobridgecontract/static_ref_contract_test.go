// Package gobridgecontract 守卫 Go 与 Node 共同实现的账号合同（contracts/go-bridge）。
package gobridgecontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

type staticRefVector struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	Secret   string `json:"secret"`
	BaseURL  string `json:"base_url"`
	Expect   struct {
		Valid      bool   `json:"valid"`
		AccountRef string `json:"account_ref"`
		BaseURL    string `json:"base_url"`
	} `json:"expect"`
}

// TestStaticAccountRefVectors 保证 Node 迁移账本预测的静态账号引用与 Go 真实派生一致。
func TestStaticAccountRefVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "contracts", "go-bridge", "static-account-ref-vectors.json"))
	if err != nil {
		t.Fatalf("读取共享静态账号样例失败: %v", err)
	}
	var document struct {
		Vectors []staticRefVector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &document); err != nil || len(document.Vectors) == 0 {
		t.Fatalf("解析共享静态账号样例失败: %v", err)
	}
	for _, vector := range document.Vectors {
		source, baseURL, err := buildStatic(vector)
		if !vector.Expect.Valid {
			if err == nil {
				t.Errorf("%s/%s %q: 期望 Go 拒绝，实际接受", vector.Provider, vector.Kind, vector.BaseURL)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s/%s %q: 期望接受，得到 %v", vector.Provider, vector.Kind, vector.BaseURL, err)
			continue
		}
		ref, err := accountcore.DeriveAccountRef(source)
		if err != nil || string(ref) != vector.Expect.AccountRef || baseURL != vector.Expect.BaseURL {
			t.Errorf("%s/%s %q: ref=%s base=%s err=%v，期望 ref=%s base=%s",
				vector.Provider, vector.Kind, vector.BaseURL, ref, baseURL, err, vector.Expect.AccountRef, vector.Expect.BaseURL)
		}
	}
}

func buildStatic(vector staticRefVector) (accountcore.IdentitySource, string, error) {
	switch {
	case vector.Provider == "codex" && vector.Kind == "api_key":
		auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: vector.Secret, BaseURL: vector.BaseURL})
		if err != nil {
			return nil, "", err
		}
		return auth, auth.BaseURL(), nil
	case vector.Provider == "claude" && vector.Kind == "api_key":
		auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: vector.Secret, BaseURL: vector.BaseURL})
		if err != nil {
			return nil, "", err
		}
		return auth, auth.BaseURL(), nil
	case vector.Provider == "claude" && vector.Kind == "auth_token":
		auth, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: vector.Secret, BaseURL: vector.BaseURL})
		if err != nil {
			return nil, "", err
		}
		return auth, auth.BaseURL(), nil
	default:
		return nil, "", os.ErrInvalid
	}
}
