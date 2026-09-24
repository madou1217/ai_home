package codex

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// workspaceVector 是 Go 与 Node 共享的工作区合同样例（contracts/go-bridge）。
type workspaceVector struct {
	Name              string          `json:"name"`
	Claims            json.RawMessage `json:"claims"`
	IDToken           string          `json:"id_token"`
	ExplicitAccountID string          `json:"explicit_account_id"`
	Expect            struct {
		OK                bool   `json:"ok"`
		WorkspaceID       string `json:"workspace_id"`
		UpstreamAccountID string `json:"upstream_account_id"`
		Error             string `json:"error"`
	} `json:"expect"`
}

// TestWorkspaceContractVectors 保证 Go 工作区语义与 Node 的 lib/account/codex-workspace.js 逐条一致。
func TestWorkspaceContractVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "go-bridge", "codex-workspace-vectors.json"))
	if err != nil {
		t.Fatalf("读取共享工作区样例失败: %v", err)
	}
	var document struct {
		Vectors []workspaceVector `json:"vectors"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("解析共享工作区样例失败: %v", err)
	}
	if len(document.Vectors) == 0 {
		t.Fatal("共享工作区样例为空")
	}
	for _, vector := range document.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			idToken := vector.IDToken
			if idToken == "" {
				idToken = "h." + base64.RawURLEncoding.EncodeToString(vector.Claims) + ".s"
			}
			auth, err := NewOAuthAuth(OAuthInput{
				AccessToken:       "access-token",
				RefreshToken:      "refresh-token",
				IDToken:           idToken,
				ExplicitAccountID: vector.ExplicitAccountID,
			})
			if !vector.Expect.OK {
				if got := workspaceErrorClass(err); got != vector.Expect.Error {
					t.Fatalf("错误分类 = %q (%v)，期望 %q", got, err, vector.Expect.Error)
				}
				return
			}
			if err != nil {
				t.Fatalf("期望成功，得到 %v", err)
			}
			if auth.AccountID() != vector.Expect.WorkspaceID {
				t.Fatalf("AccountID = %q，期望 %q", auth.AccountID(), vector.Expect.WorkspaceID)
			}
			if auth.UpstreamAccountID() != vector.Expect.UpstreamAccountID {
				t.Fatalf("UpstreamAccountID = %q，期望 %q", auth.UpstreamAccountID(), vector.Expect.UpstreamAccountID)
			}
		})
	}
}

func workspaceErrorClass(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errInvalidIDToken):
		return "invalid_id_token"
	case errors.Is(err, errInvalidOAuthAccountID):
		return "invalid_account_id"
	case errors.Is(err, errOAuthAccountIDMismatch):
		return "account_id_mismatch"
	default:
		return "other:" + err.Error()
	}
}
