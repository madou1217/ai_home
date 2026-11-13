package codexresetcredit

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
	codexstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codex"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const codexAppServerPassthroughEnv = "AIH_CODEX_APP_SERVER_PASSTHROUGH"

// CredentialReader 按账号引用读取凭据（由 *sqliteaccount.Store 满足）。
type CredentialReader interface {
	GetCredential(ctx context.Context, accountRef accountcore.AccountRef) (accountapp.Credential, error)
}

// Transport 抽象与 Codex app-server 的 RPC 交互。
type Transport interface {
	AssertOAuthAccount(ctx context.Context, accountRef string) error
	ReadRateLimits(ctx context.Context, accountRef string) (map[string]any, error)
	ConsumeCredit(ctx context.Context, accountRef string, operationID string, creditID string) (map[string]any, error)
}

// StdioTransport 通过 codex app-server --listen stdio:// 调用官方重置卡 RPC。
type StdioTransport struct {
	AIHomeDir      string
	HostHomeDir    string
	Credentials    CredentialReader
	ResolveBinary  func() (string, error)
	RequestTimeout time.Duration
}

type expectedOAuthIdentity struct {
	expectedEmail     string
	expectedCodexHome string
	runtimeDir        string
}

func (t *StdioTransport) resolveOAuthIdentity(ctx context.Context, accountRef string) (expectedOAuthIdentity, *codex.OAuthAuth, error) {
	refText, err := requireAccountRef(accountRef)
	if err != nil {
		return expectedOAuthIdentity{}, nil, err
	}
	if t == nil || t.Credentials == nil || strings.TrimSpace(t.AIHomeDir) == "" {
		return expectedOAuthIdentity{}, nil, newCodedError("codex_reset_runtime_unavailable", "Codex 重置需要账号凭据服务", http.StatusServiceUnavailable)
	}
	ref, err := accountcore.ParseAccountRef(refText)
	if err != nil {
		return expectedOAuthIdentity{}, nil, newCodedError("invalid_account_ref", "账号引用无效", http.StatusBadRequest)
	}
	cred, err := t.Credentials.GetCredential(ctx, ref)
	if err != nil || cred == nil || strings.ToLower(strings.TrimSpace(cred.ProviderID())) != "codex" {
		return expectedOAuthIdentity{}, nil, newCodedError("codex_account_identity_unavailable", "Codex 账号凭据不可用", http.StatusConflict)
	}
	if _, isAPIKey := cred.(*codex.APIKeyAuth); isAPIKey {
		return expectedOAuthIdentity{}, nil, newCodedError("codex_reset_oauth_required", "只有 Codex OAuth 账号支持重置额度", http.StatusBadRequest)
	}
	oauth, ok := cred.(*codex.OAuthAuth)
	if !ok || oauth == nil {
		return expectedOAuthIdentity{}, nil, newCodedError("codex_account_identity_unavailable", "Codex OAuth 凭据无效", http.StatusConflict)
	}
	email := strings.ToLower(strings.TrimSpace(oauth.Email()))
	if !strings.Contains(email, "@") {
		return expectedOAuthIdentity{}, nil, newCodedError("codex_account_identity_unavailable", "Codex OAuth 账号缺少邮箱身份", http.StatusConflict)
	}
	runtimeDir := filepath.Join(strings.TrimSpace(t.AIHomeDir), "run", "auth-projections", "codex", ref.String())
	codexHome := filepath.Join(runtimeDir, ".codex")
	return expectedOAuthIdentity{
		expectedEmail:     email,
		expectedCodexHome: codexHome,
		runtimeDir:        runtimeDir,
	}, oauth, nil
}

// AssertOAuthAccount 校验账号是否为有效 Codex OAuth 账号，并准备投影 auth.json。
func (t *StdioTransport) AssertOAuthAccount(ctx context.Context, accountRef string) error {
	expected, oauth, err := t.resolveOAuthIdentity(ctx, accountRef)
	if err != nil {
		return err
	}
	return ensureCodexAuthProjection(ctx, expected.runtimeDir, oauth)
}

func ensureCodexAuthProjection(ctx context.Context, runtimeDir string, oauth *codex.OAuthAuth) error {
	writes, err := (codexstorage.Materializer{}).Materialize(
		ctx,
		accountprojection.Request{
			ProviderID: "codex",
			Credential: oauth,
		},
		accountprojection.Policy{},
		runtimeDir,
	)
	if err != nil {
		return newCodedError("codex_account_runtime_home_unavailable", err.Error(), http.StatusConflict)
	}
	for _, w := range writes {
		if mkErr := os.MkdirAll(filepath.Dir(w.Path), 0o700); mkErr != nil {
			return newCodedError("codex_account_runtime_home_unavailable", mkErr.Error(), http.StatusConflict)
		}
		tmp := w.Path + ".tmp"
		mode := w.Mode
		if mode == 0 {
			mode = 0o600
		}
		if wrErr := os.WriteFile(tmp, w.Data, mode); wrErr != nil {
			_ = os.Remove(tmp)
			return newCodedError("codex_account_runtime_home_unavailable", wrErr.Error(), http.StatusConflict)
		}
		if rnErr := os.Rename(tmp, w.Path); rnErr != nil {
			_ = os.Remove(tmp)
			return newCodedError("codex_account_runtime_home_unavailable", rnErr.Error(), http.StatusConflict)
		}
	}
	return nil
}

// ReadRateLimits 通过 stdio app-server 查询当前 rateLimits。
func (t *StdioTransport) ReadRateLimits(ctx context.Context, accountRef string) (map[string]any, error) {
	return t.invoke(ctx, accountRef, "account/rateLimits/read", map[string]any{})
}

// ConsumeCredit 通过 stdio app-server 消费一张重置卡（creditId 为空时省略以由上游选卡）。
func (t *StdioTransport) ConsumeCredit(ctx context.Context, accountRef string, operationID string, creditID string) (map[string]any, error) {
	params := map[string]any{
		"idempotencyKey": strings.TrimSpace(operationID),
	}
	if cid := strings.TrimSpace(creditID); cid != "" {
		params["creditId"] = cid
	}
	return t.invoke(ctx, accountRef, "account/rateLimitResetCredit/consume", params)
}

func (t *StdioTransport) invoke(ctx context.Context, accountRef string, method string, params any) (map[string]any, error) {
	expected, oauth, err := t.resolveOAuthIdentity(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	if err := ensureCodexAuthProjection(ctx, expected.runtimeDir, oauth); err != nil {
		return nil, err
	}
	resolveBin := t.ResolveBinary
	if resolveBin == nil {
		resolveBin = func() (string, error) {
			return providercli.ResolveBinary("codex", "codex")
		}
	}
	binPath, err := resolveBin()
	if err != nil {
		return nil, newCodedError("codex_command_unavailable", err.Error(), http.StatusServiceUnavailable)
	}
	hostHome := strings.TrimSpace(t.HostHomeDir)
	if hostHome == "" {
		hostHome, _ = os.UserHomeDir()
	}
	timeout := t.RequestTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	client, err := appserver.Dial(ctx, appserver.Config{
		Command:        binPath,
		Args:           []string{"app-server", "--listen", "stdio://"},
		Dir:            hostHome,
		Env:            buildCodexResetEnv(hostHome, expected.expectedCodexHome),
		RequestTimeout: timeout,
		ClientInfo: appserver.ClientInfo{
			Name:    "aih-reset-credit",
			Title:   "AI Home Reset Credit",
			Version: "1.0.0",
		},
	})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, newCodedError("codex_reset_consume_timeout", "Codex 重置请求超时，结果需要核对", http.StatusGatewayTimeout)
		}
		return nil, newCodedError("codex_reset_rpc_failed", err.Error(), http.StatusServiceUnavailable)
	}
	defer func() { _ = client.Close() }()

	if err := validateAppServerIdentity(ctx, client, expected); err != nil {
		return nil, err
	}

	var result map[string]any
	if err := client.Request(ctx, method, params, &result); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, newCodedError("codex_reset_consume_timeout", "Codex 重置请求超时，结果需要核对", http.StatusGatewayTimeout)
		}
		var rpcErr *appserver.RPCError
		if errors.As(err, &rpcErr) && rpcErr != nil {
			if errors.Is(err, appserver.ErrMethodNotFound) {
				return nil, newCodedError("codex_reset_not_supported", "当前 Codex 版本不支持重置卡接口", http.StatusBadRequest)
			}
			return nil, newCodedError("codex_reset_rpc_error", rpcErr.Error(), http.StatusBadGateway)
		}
		return nil, newCodedError("codex_reset_result_unknown", err.Error(), http.StatusBadGateway)
	}
	if result == nil {
		result = map[string]any{}
	}
	return result, nil
}

func validateAppServerIdentity(ctx context.Context, client *appserver.Client, expected expectedOAuthIdentity) error {
	var initPayload struct {
		CodexHome string `json:"codexHome"`
	}
	if raw := client.InitializeResult(); len(raw) > 0 {
		_ = json.Unmarshal(raw, &initPayload)
	}
	actualHome := normalizeRealPath(initPayload.CodexHome)
	expectedHome := normalizeRealPath(expected.expectedCodexHome)
	if actualHome == "" || actualHome != expectedHome {
		return newCodedError("codex_app_server_runtime_home_mismatch", "Codex app-server 运行目录与账号不匹配", http.StatusConflict)
	}

	var accountRes struct {
		Account *struct {
			Type  string `json:"type"`
			Email string `json:"email"`
		} `json:"account"`
	}
	if err := client.Request(ctx, "account/read", map[string]any{"refreshToken": false}, &accountRes); err != nil {
		return newCodedError("codex_app_server_account_identity_missing", err.Error(), http.StatusConflict)
	}
	if accountRes.Account == nil {
		return newCodedError("codex_app_server_account_type_mismatch", "Codex app-server 未返回 ChatGPT 账号", http.StatusConflict)
	}
	if strings.ToLower(strings.TrimSpace(accountRes.Account.Type)) != "chatgpt" {
		return newCodedError("codex_app_server_account_type_mismatch", "Codex app-server 账号类型不匹配", http.StatusConflict)
	}
	actualEmail := strings.ToLower(strings.TrimSpace(accountRes.Account.Email))
	if actualEmail == "" || !strings.Contains(actualEmail, "@") {
		return newCodedError("codex_app_server_account_identity_missing", "Codex app-server 账号缺少邮箱身份", http.StatusConflict)
	}
	if actualEmail != expected.expectedEmail {
		return newCodedError("codex_app_server_account_identity_mismatch", "Codex app-server 登录邮箱与账号不匹配", http.StatusConflict)
	}
	return nil
}

func normalizeRealPath(p string) string {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(trimmed)
	if err != nil {
		resolved, err = filepath.Abs(trimmed)
		if err != nil {
			resolved = filepath.Clean(trimmed)
		}
	}
	if runtime.GOOS == "windows" {
		return strings.ToLower(resolved)
	}
	return resolved
}

func buildCodexResetEnv(hostHome string, codexHome string) []string {
	overrides := map[string]string{
		"CODEX_HOME":                   codexHome,
		"CODEX_SQLITE_HOME":            codexHome,
		codexAppServerPassthroughEnv:   "1",
	}
	if hostHome != "" {
		overrides["HOME"] = hostHome
		overrides["USERPROFILE"] = hostHome
		overrides["XDG_CONFIG_HOME"] = hostHome
		overrides["XDG_DATA_HOME"] = filepath.Join(hostHome, ".local", "share")
		overrides["XDG_STATE_HOME"] = filepath.Join(hostHome, ".local", "state")
	}
	stripped := map[string]struct{}{
		"OPENAI_API_KEY":  {},
		"OPENAI_BASE_URL": {},
		"CODEX_API_KEY":   {},
	}

	base := os.Environ()
	out := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if _, drop := stripped[name]; drop {
			continue
		}
		if _, replaced := overrides[name]; replaced {
			continue
		}
		out = append(out, entry)
	}
	for k, v := range overrides {
		out = append(out, k+"="+v)
	}
	return out
}
