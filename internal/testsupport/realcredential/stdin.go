// Package realcredential 安全读取人工授权的真实验收凭据。
package realcredential

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"

	accountapp "github.com/madou1217/ai_home/application/accounts"
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

// DecodeCodexSub2APIFile 从 0600 普通临时文件读取单账号标准文档。
func DecodeCodexSub2APIFile(path string) (accountapp.Credential, error) {
	file, err := openPrivateFile(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return DecodeCodexSub2API(file)
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

// DecodeClaudeAuthTokenFile 从 0600 普通临时文件读取一次性 auth-token DTO。
func DecodeClaudeAuthTokenFile(path string) (accountapp.Credential, error) {
	file, err := openPrivateFile(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return DecodeClaudeAuthToken(file)
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
