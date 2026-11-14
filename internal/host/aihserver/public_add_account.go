package aihserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// staticAddAuthModes 是「立即建号」的认证方式：Node 的 add 入口曾把这三类分流到
// 静态凭据入库，其余才启动 OAuth 作业。分流放在 Go，避免浏览器感知两种语义。
var staticAddAuthModes = map[string]struct{}{
	"api-key":     {},
	"auth-token":  {},
	"vertex-ai":   {},
}

const addAccountBodyLimit = 1 << 20

// newPublicAddAccountHandler 把浏览器的新增账号请求分流给 OAuth 作业或静态入库。
//
// replaceExisting 只属于 Node 旧入口的语义，静态入库用严格 JSON 解码，先剥掉它。
func newPublicAddAccountHandler(oauth http.Handler, oauthPath string, static http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(io.LimitReader(request.Body, addAccountBodyLimit))
		if err != nil {
			writeSystemJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_request_body"})
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			// 非 JSON：交给 OAuth 处理器按原有错误语义返回。
			cloned := request.Clone(request.Context())
			cloned.Body = io.NopCloser(bytes.NewReader(body))
			oauth.ServeHTTP(response, cloned)
			return
		}
		mode := strings.ToLower(strings.TrimSpace(fmt.Sprint(payload["authMode"])))
		target := oauth
		if _, isStatic := staticAddAuthModes[mode]; isStatic {
			if static == nil {
				writeSystemJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "account_store_unavailable"})
				return
			}
			target = static
			delete(payload, "replaceExisting")
			if filtered, marshalErr := json.Marshal(payload); marshalErr == nil {
				body = filtered
			}
		}
		cloned := request.Clone(request.Context())
		cloned.Body = io.NopCloser(bytes.NewReader(body))
		cloned.ContentLength = int64(len(body))
		if target == oauth && oauthPath != "" {
			// OAuth 处理器按管理路径分派，公开路径必须先改写。
			cloned.URL.Path = oauthPath
		}
		target.ServeHTTP(response, cloned)
	})
}
