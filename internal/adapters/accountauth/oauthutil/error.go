package oauthutil

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/accountcredentials"
)

const maxOAuthErrorCodeLength = 80

// DecodeErrorCode 从有界 OAuth 错误响应中提取可用于分类的安全 code。
//
// 返回值不会包含 description、message、Token 或完整响应正文。
func DecodeErrorCode(
	reader io.Reader,
	maxBytes int64,
) string {
	var envelope struct {
		Error json.RawMessage `json:"error"`
		Code  string          `json:"code"`
	}
	if err := DecodeJSONResponse(reader, maxBytes, &envelope); err != nil {
		return ""
	}
	code := envelope.Code
	if len(envelope.Error) > 0 {
		var direct string
		if json.Unmarshal(envelope.Error, &direct) == nil {
			code = direct
		} else {
			var nested struct {
				Code string `json:"code"`
				Type string `json:"type"`
			}
			if json.Unmarshal(envelope.Error, &nested) == nil {
				if nested.Code != "" {
					code = nested.Code
				} else {
					code = nested.Type
				}
			}
		}
	}
	code = strings.ToLower(strings.TrimSpace(code))
	if !validErrorCode(code) {
		return ""
	}
	return code
}

// validErrorCode 只允许固定长度的低敏机器错误标识。
func validErrorCode(value string) bool {
	if value == "" || len(value) > maxOAuthErrorCodeLength {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			character == '_' ||
			character == '-' ||
			character == '.' ||
			character == ':' {
			continue
		}
		return false
	}
	return true
}

// ClassifyRefreshError 把 OAuth Token Endpoint 状态映射为共享应用错误。
func ClassifyRefreshError(statusCode int, errorCode string) error {
	if statusCode == http.StatusUnauthorized ||
		statusCode == http.StatusForbidden ||
		refreshTokenInvalid(errorCode) {
		return accountcredentials.ErrReauthenticationRequired
	}
	if statusCode >= http.StatusBadRequest &&
		statusCode < http.StatusInternalServerError &&
		statusCode != http.StatusRequestTimeout &&
		statusCode != http.StatusTooManyRequests {
		return accountcredentials.ErrRefreshRejected
	}
	return accountcredentials.ErrRefreshUnavailable
}

// refreshTokenInvalid 只接受明确表示 Refresh Token 失效的机器码。
func refreshTokenInvalid(code string) bool {
	switch code {
	case "expired_refresh_token",
		"invalid_grant",
		"invalid_token",
		"invalid_refresh_token",
		"refresh_token_expired",
		"refresh_token_invalid",
		"refresh_token_not_found",
		"refresh_token_revoked",
		"revoked_refresh_token":
		return true
	default:
		return false
	}
}
