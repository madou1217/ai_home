package clilogin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"
)

// kiro 的 CLI 登录只写出一张 auth_kv 裸库；身份证据必须由 GetUsageLimits 现场获取，
// 所以登录后用 kirooauth.ImportRefreshToken 兑换/验证并构建完整 artifact。

func init() {
	providerSpecs["kiro"] = providerSpec{layout: kiroLoginLayout, readCredential: kiroLoginCredential}
}

// kiroReadAuth 是测试注入点；生产直接读账号目录里的 data.sqlite3。
var kiroReadAuth = kirodb.ReadAuth

// kiroImport 是测试注入点；生产走真实 Kiro Desktop token 端点 + GetUsageLimits。
var kiroImport = func(refreshToken string, region string) ([]byte, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	provider, err := kirooauth.NewLogin(client, time.Now)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, err := provider.ImportRefreshToken(ctx, kirooauth.RefreshTokenImportInput{
		RefreshToken: refreshToken,
		Region:       region,
	})
	if err != nil {
		return nil, err
	}
	if len(result.Artifacts) == 0 {
		return nil, errors.New("kiro 登录验证未返回凭据")
	}
	return result.Artifacts, nil
}

// kiroLoginLayout：KIRO_TEST_DB_PATH 指向一次性目录里的凭据库，HOME 保持宿主。
func kiroLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	env["KIRO_TEST_DB_PATH"] = filepath.Join(runtimeDir, "data.sqlite3")
	delete(env, "KIRO_HOME")
	delete(env, "KIRO_API_KEY")
	return runtimeDir, env, nil
}

// kiroLoginCredential 读取登录库里的 refresh_token，交给 ImportRefreshToken 验证。
func kiroLoginCredential(configDir string) ([]byte, error) {
	auth, found, err := kiroReadAuth(context.Background(), filepath.Join(configDir, "data.sqlite3"))
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrCredentialMissing
	}
	var token struct {
		RefreshToken string `json:"refresh_token"`
		Region       string `json:"region"`
	}
	if err := json.Unmarshal(auth.Raw, &token); err != nil {
		return nil, ErrCredentialMissing
	}
	if strings.TrimSpace(token.RefreshToken) == "" {
		return nil, ErrCredentialMissing
	}
	artifacts, err := kiroImport(strings.TrimSpace(token.RefreshToken), strings.TrimSpace(token.Region))
	if err != nil {
		return nil, fmt.Errorf("验证 Kiro 登录凭据失败: %w", err)
	}
	return json.Marshal(map[string]json.RawMessage{"native_auth_json": artifacts})
}
