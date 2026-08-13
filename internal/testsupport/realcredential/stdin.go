// Package realcredential 安全读取人工授权的真实验收凭据。
package realcredential

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
)

const maxCredentialBytes = 1 << 20

var (
	// ErrInvalidCredential 表示标准输入不是允许的单账号真实验收凭据。
	ErrInvalidCredential = errors.New("真实验收凭据输入无效")
)

// DecodeCodexSub2API 从标准单账号 sub2api 文档解码 Codex 凭据。
func DecodeCodexSub2API(reader io.Reader) (accountapp.Credential, error) {
	payload, err := readBounded(reader)
	if err != nil {
		return nil, err
	}
	defer clear(payload)
	credential, _, err := sub2api.NewDecoder().DecodeAccount(payload)
	if err != nil {
		return nil, errors.Join(ErrInvalidCredential, err)
	}
	if credential == nil || credential.ProviderID() != "codex" {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

// DecodeClaudeAuthToken 从一次性 JSON 解码第三方 Claude auth-token。
// 该格式只服务测试进程，不持久化也不作为账号迁移格式。
func DecodeClaudeAuthToken(reader io.Reader) (accountapp.Credential, error) {
	payload, err := readBounded(reader)
	if err != nil {
		return nil, err
	}
	defer clear(payload)
	var input struct {
		AuthToken string `json:"auth_token"`
		BaseURL   string `json:"base_url"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return nil, ErrInvalidCredential
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidCredential
	}
	auth, err := claudeauth.NewAuthTokenAuth(claudeauth.AuthTokenInput{
		AuthToken: input.AuthToken,
		BaseURL:   input.BaseURL,
	})
	input.AuthToken = ""
	if err != nil {
		return nil, ErrInvalidCredential
	}
	return auth, nil
}

// DecodeCodexAccountFile 从一个 0600 私有 envelope 同时读取正式账号身份和
// 标准 sub2api 凭据，避免测试把任意身份与真实凭据拼接成伪账号。
func DecodeCodexAccountFile(
	path string,
) (accountcore.AccountRef, accountapp.Credential, []string, error) {
	return decodeAccountFile(path, DecodeCodexSub2API)
}

// DecodeClaudeAccountFile 从一个 0600 私有 envelope 同时读取正式账号身份和
// 第三方 auth-token，避免测试把任意身份与真实凭据拼接成伪账号。
func DecodeClaudeAccountFile(
	path string,
) (accountcore.AccountRef, accountapp.Credential, []string, error) {
	return decodeAccountFile(path, DecodeClaudeAuthToken)
}

// decodeAccountFile 只在测试进程内拆开账号身份与凭据 JSON。
func decodeAccountFile(
	path string,
	decodeCredential func(io.Reader) (accountapp.Credential, error),
) (accountcore.AccountRef, accountapp.Credential, []string, error) {
	file, err := openPrivateFile(path)
	if err != nil {
		return accountcore.AccountRef(""), nil, nil, err
	}
	defer func() { _ = file.Close() }()
	payload, err := readBounded(file)
	if err != nil {
		return accountcore.AccountRef(""), nil, nil, err
	}
	defer clear(payload)
	var envelope struct {
		AccountRef string          `json:"account_ref"`
		Models     []string        `json:"models"`
		Credential json.RawMessage `json:"credential"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return accountcore.AccountRef(""), nil, nil, ErrInvalidCredential
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return accountcore.AccountRef(""), nil, nil, ErrInvalidCredential
	}
	accountRef, err := accountcore.ParseAccountRef(envelope.AccountRef)
	models, validModels := normalizeModels(envelope.Models)
	if err != nil || !validModels || len(envelope.Credential) == 0 ||
		decodeCredential == nil {
		return accountcore.AccountRef(""), nil, nil, ErrInvalidCredential
	}
	credential, err := decodeCredential(bytes.NewReader(envelope.Credential))
	clear(envelope.Credential)
	if err != nil || credential == nil {
		return accountcore.AccountRef(""), nil, nil, ErrInvalidCredential
	}
	return accountRef, credential, models, nil
}

// normalizeModels 验证远端账号目录非空、无空值且没有重复模型。
func normalizeModels(values []string) ([]string, bool) {
	if len(values) == 0 {
		return nil, false
	}
	models := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		model := strings.TrimSpace(value)
		if model == "" {
			return nil, false
		}
		if _, exists := seen[model]; exists {
			return nil, false
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	return models, true
}

// ContainsModels 判断远端账号目录是否完整包含目标模型集合。
func ContainsModels(models []string, required ...string) bool {
	if len(models) == 0 || len(required) == 0 {
		return false
	}
	available := make(map[string]struct{}, len(models))
	for _, model := range models {
		available[model] = struct{}{}
	}
	for _, model := range required {
		if _, exists := available[model]; !exists {
			return false
		}
	}
	return true
}

// readBounded 有界读取一次 stdin，并拒绝空输入和超限输入。
func readBounded(reader io.Reader) ([]byte, error) {
	if reader == nil {
		return nil, ErrInvalidCredential
	}
	payload, err := io.ReadAll(io.LimitReader(reader, maxCredentialBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxCredentialBytes {
		clear(payload)
		return nil, ErrInvalidCredential
	}
	return payload, nil
}

// openPrivateFile 拒绝符号链接、非 0600 文件与可能发生替换的路径。
func openPrivateFile(path string) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() ||
		before.Mode().Perm() != 0o600 || before.Size() <= 0 ||
		before.Size() > maxCredentialBytes {
		return nil, ErrInvalidCredential
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrInvalidCredential
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		_ = file.Close()
		return nil, ErrInvalidCredential
	}
	return file, nil
}
