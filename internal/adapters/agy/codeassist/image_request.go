package codeassist

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"time"
)

// PrepareImageGenerateContent 为图片生成准备一次 Code Assist generateContent 调用：
// 查询账号 project，把原生 Gemini 请求体（contents / generationConfig）包成与推理路径相同的
// antigravity agent 信封，并返回应施加的请求头。Code Assist 不接受裸 Gemini 请求体。
func PrepareImageGenerateContent(
	ctx context.Context,
	client HTTPClient,
	accessToken string,
	model string,
	inner map[string]any,
) ([]byte, func(*http.Request), error) {
	if ctx == nil || client == nil || accessToken == "" || model == "" || inner == nil {
		return nil, nil, ErrInvalidDependencies
	}
	project, err := loadProjectForToken(ctx, client, accessToken)
	if err != nil {
		return nil, nil, err
	}
	requestID, sessionID, err := newRequestIdentities(time.Now(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	request := make(map[string]any, len(inner)+1)
	for key, value := range inner {
		request[key] = value
	}
	request["sessionId"] = sessionID
	body, err := json.Marshal(map[string]any{
		"project":            project,
		"requestId":          requestID,
		"request":            request,
		"model":              model,
		"userAgent":          "antigravity",
		"requestType":        "agent",
		"enabledCreditTypes": []string{"GOOGLE_ONE_AI"},
	})
	if err != nil {
		return nil, nil, ErrInvalidDependencies
	}
	return body, func(outgoing *http.Request) { applyTokenHeaders(outgoing, accessToken, false) }, nil
}
