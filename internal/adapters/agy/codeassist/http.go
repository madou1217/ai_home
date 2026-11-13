package codeassist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/agy/clientversion"
)

const (
	defaultBaseURL  = "https://daily-cloudcode-pa.googleapis.com/v1internal"
	clientSessionID = "00000000-0000-4000-8000-000000000000"
	maxProjectBytes = 2 * 1024 * 1024

	// antigravityClientBuild 是真实 agy CLI User-Agent 里的构建号。
	// 服务端不校验它的具体值，保留只为与 CLI 的请求形态一致。
	antigravityClientBuild = "1018951551"
)

// antigravityUserAgent 复刻 agy CLI 的客户端身份。
//
// 服务端按 User-Agent 区分客户端：`antigravity/<ver> darwin/arm64` 会被当成
// Code Assist 客户端，fetchAvailableModels 只返回 19~23 个模型且不含 gemini-4；
// 只有 `antigravity/cli/<ver> (aidev_client; ...)` 才返回 Antigravity 的完整
// 目录（Ultra 账号 29 个模型，含 gemini-4 argon/carbon 的 low/medium/high）。
func antigravityUserAgent() string {
	return "antigravity/cli/" + clientversion.Detect() +
		" (aidev_client; os_type=darwin; arch=arm64; cl=" + antigravityClientBuild +
		"; auth_method=consumer)"
}

// GenerateContentURL 是 Code Assist 非流式 generateContent 的完整地址。
//
// 图片生成走这条入口：它与流式入口共享同一个 base，只是不带 `?alt=sse`。
// 导出它是为了让图片子系统复用同一份地址定义，而不是各写一份字面量。
const GenerateContentURL = defaultBaseURL + ":generateContent"

func loadProject(
	ctx context.Context,
	client HTTPClient,
	auth *agy.OAuthAuth,
) (string, error) {
	return loadProjectForToken(ctx, client, auth.AccessToken())
}

// loadProjectForToken 用裸 Access Token 查询账号的 Code Assist project（图片子系统只持有 token）。
func loadProjectForToken(
	ctx context.Context,
	client HTTPClient,
	accessToken string,
) (string, error) {
	payload, err := json.Marshal(map[string]any{
		"metadata": map[string]string{
			"ideType":    "ANTIGRAVITY",
			"platform":   "PLATFORM_UNSPECIFIED",
			"pluginType": "GEMINI",
		},
	})
	if err != nil {
		return "", ErrInvalidDependencies
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		defaultBaseURL+":loadCodeAssist",
		strings.NewReader(string(payload)),
	)
	if err != nil {
		return "", ErrInvalidDependencies
	}
	applyTokenHeaders(request, accessToken, false)
	response, err := client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		return "", err
	}
	if response == nil || response.Body == nil {
		return "", ErrInvalidDependencies
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return "", fmt.Errorf("AGY Code Assist load project HTTP %d", response.StatusCode)
	}
	var document struct {
		Project string `json:"cloudaicompanionProject"`
	}
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxProjectBytes,
		&document,
	); err != nil || !validOpaque(document.Project) {
		return "", errors.New("AGY Code Assist project 响应无效")
	}
	return document.Project, nil
}

func applyHeaders(request *http.Request, auth *agy.OAuthAuth, claudeModel bool) {
	applyTokenHeaders(request, auth.AccessToken(), claudeModel)
}

func applyTokenHeaders(request *http.Request, accessToken string, claudeModel bool) {
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	version := clientversion.Detect()
	request.Header.Set("User-Agent", antigravityUserAgent())
	request.Header.Set("x-client-name", "antigravity")
	request.Header.Set("x-client-version", version)
	request.Header.Set("x-vscode-sessionid", clientSessionID)
	if claudeModel {
		request.Header.Set("anthropic-beta", "claude-code-20250219")
	}
}

func validOpaque(value string) bool {
	return value != "" && value == strings.TrimSpace(value) &&
		len(value) <= 1024 && !strings.ContainsAny(value, "\r\n\x00")
}
