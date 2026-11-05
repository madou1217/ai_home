package zcoderelay

import (
	"errors"
	"strings"
)

// 推理端点（2026-10-27 真机纠偏后的官方形态）：
//
//   - start-plan / 套餐未知：zcode.z.ai 自己的 zcode-plan 端点，单头 Bearer <长期 jwt>；
//   - coding plan：按区域走 ultra 端点，双头
//     Authorization: Bearer <区域 access_token>
//     X-Zcode-Authorization: Bearer <zcodejwttoken>。
//
// 两者不可互换：start-plan 打到 ultra 会得到 401，被判成 auth_invalid（1 年冷却）。
// Node 侧这段判断散落在 provider-api-base-url.js 的注释与函数里，这里收敛成
// 「一张表 + 一个纯函数」。
const (
	// Path 是 Anthropic Messages 的上游路径。
	Path = "/v1/messages"

	// PlanJWTBaseURL 服务 start-plan 家族，只认长期 jwt。
	PlanJWTBaseURL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
	// UltraZAIBaseURL 服务 zai 区域的 coding plan。
	UltraZAIBaseURL = "https://zcode.z.ai/api/v1/ultra-zai/anthropic"
	// UltraBigmodelBaseURL 服务 bigmodel 区域的 coding plan。
	UltraBigmodelBaseURL = "https://zcode.z.ai/api/v1/ultra/anthropic"
)

// ErrMissingCredential 表示端点需要的凭据缺失。
var ErrMissingCredential = errors.New("zcode 推理凭据缺失")

// ResolveInferenceBaseURL 由 plan_id 与区域判定推理端点。
//
// 顺序与 Node 一致，且**不能调换**：
//  1. plan_id 含 start-plan → zcode-plan 端点（与区域无关）；
//  2. plan_id 为空 → zcode-plan 端点（这类账号通常只有长期 jwt）；
//  3. 其余按区域走 ultra；区域未知再按 plan_id 关键字兜底。
func ResolveInferenceBaseURL(planID, region string) string {
	text := strings.ToLower(strings.TrimSpace(planID))
	if strings.Contains(text, "start-plan") {
		return PlanJWTBaseURL
	}
	if text == "" {
		return PlanJWTBaseURL
	}
	switch strings.ToLower(strings.TrimSpace(region)) {
	case "zai":
		return UltraZAIBaseURL
	case "bigmodel":
		return UltraBigmodelBaseURL
	}
	for _, kind := range []string{"individual-coding-plan", "team-coding-plan"} {
		if strings.Contains(text, kind) {
			return UltraBigmodelBaseURL
		}
	}
	return PlanJWTBaseURL
}

// AuthHeaders 返回该端点需要的鉴权头。
//
// zcode-plan 端点只认长期 jwt；ultra 端点必须同时带区域 access_token 与 jwt。
func AuthHeaders(baseURL, accessToken, jwt string) (map[string]string, error) {
	base := strings.TrimSpace(baseURL)
	jwt = strings.TrimSpace(jwt)
	if base == "" {
		return nil, ErrMissingCredential
	}
	if base == PlanJWTBaseURL {
		if jwt == "" {
			return nil, ErrMissingCredential
		}
		return map[string]string{"Authorization": "Bearer " + jwt}, nil
	}
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" || jwt == "" {
		return nil, ErrMissingCredential
	}
	return map[string]string{
		"Authorization":         "Bearer " + accessToken,
		"X-Zcode-Authorization": "Bearer " + jwt,
	}, nil
}

// IsUltraEndpoint 判断端点是否需要双鉴权头。
func IsUltraEndpoint(baseURL string) bool {
	base := strings.TrimSpace(baseURL)
	return base == UltraZAIBaseURL || base == UltraBigmodelBaseURL
}
