package desktopsession

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// call 发一次官方 AuthService RPC。
//
// 返回 HTTP 状态与解析后的 JSON；非 200 也读 body（RefreshToken 的 401 响应里
// 同样没有 token，但保留同一读取路径，避免出现「状态码分支各自解码」的重复）。
func (service *Service) call(
	ctx context.Context,
	accountRef string,
	method string,
	payload map[string]any,
	accessToken string,
) (int, map[string]any, error) {
	client := service.client
	if service.transport != nil {
		resolved, err := service.transport(ctx, accountRef)
		if err != nil {
			return 0, nil, err
		}
		if resolved != nil {
			client = resolved
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, service.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		service.baseURL+"/"+authService+"/"+method,
		bytes.NewReader(body),
	)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	response, err := client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return 0, nil, ctxErr
		}
		return 0, nil, err
	}
	if response == nil || response.Body == nil {
		return 0, nil, newError("empty_auth_response")
	}
	defer func() {
		_ = response.Body.Close()
	}()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if readErr != nil || len(raw) > maxResponseBytes {
		return response.StatusCode, nil, readErr
	}
	object, ok := decodeObject(raw)
	if !ok {
		return response.StatusCode, nil, nil
	}
	return response.StatusCode, object, nil
}

// decodeObject 解析 JSON 对象；数组按空对象处理（与 Node typeof [] === 'object' 同形），
// 字符串/数字/布尔与非法 JSON 返回 ok=false。
func decodeObject(body []byte) (map[string]any, bool) {
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, false
	}
	switch typed := value.(type) {
	case map[string]any:
		return typed, true
	case []any:
		return map[string]any{}, true
	default:
		return nil, false
	}
}

// readStringField 依次读取第一个非空字符串字段（camelCase 优先，兼容 snake_case）。
func readStringField(data map[string]any, names ...string) string {
	if data == nil {
		return ""
	}
	for _, name := range names {
		value, exists := data[name]
		if !exists || value == nil {
			continue
		}
		if text, ok := value.(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

// statusText 把状态码归一成 Node 文案里的片段；0 表示没有拿到响应。
func statusText(status int) string {
	if status <= 0 {
		return "unknown"
	}
	return strconv.Itoa(status)
}

// normalizeAccountRef 校验账号引用形态。
func normalizeAccountRef(accountRef string) (accountcore.AccountRef, error) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		return "", ErrInvalidAccountRef
	}
	return ref, nil
}

// parseJWTExpiryMS 读取 JWT 的 exp 声明并换算成毫秒；不透明 token 返回 0。
//
// 与 Node parseJwtExpiryMs 同口径：只认三段式 JWT 与数字 exp，解析失败一律 0，
// 由调用方按「已过期」处理（保守侧）。
func parseJWTExpiryMS(token string) int64 {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return 0
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// 兼容带 padding 的 base64url（Node Buffer.from(...,'base64url') 两种都收）。
		decoded, err = base64.URLEncoding.DecodeString(parts[1])
	}
	if err != nil {
		return 0
	}
	var claims struct {
		Exp json.Number `json:"exp"`
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil {
		return 0
	}
	seconds, err := claims.Exp.Int64()
	if err != nil || seconds <= 0 {
		return 0
	}
	return seconds * 1000
}
