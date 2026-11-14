// Package webuidesktoptranslationapi exposes OS-helper ownership, separate from translation inference.
package webuidesktoptranslationapi

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

const Path = "/v1/management/webui/translation"

type Handler struct {
	Service   *desktoptranslation.Service
	Authorize func(*http.Request) bool
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil || h.Authorize == nil {
		write(w, 503, map[string]any{"ok": false, "error": "desktop_translation_unavailable"})
		return
	}
	if !h.Authorize(r) {
		write(w, 401, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	focus := strings.HasSuffix(r.URL.Path, "/focus")
	if r.Method == http.MethodGet && !focus {
		write(w, 200, map[string]any{"ok": true, "system": h.Service.GetStatus(r.Context())})
		return
	}
	if r.Method != http.MethodPost {
		write(w, 405, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2049))
	if err != nil || len(raw) > 2048 {
		write(w, 413, map[string]any{"ok": false, "error": "request_body_too_large"})
		return
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil {
		write(w, 400, map[string]any{"ok": false, "error": "invalid_json"})
		return
	}
	if focus {
		if directLocal(r) {
			var v struct {
				ID         string `json:"id"`
				Focused    bool   `json:"focused"`
				ObservedAt int64  `json:"observedAt"`
				Revision   int64  `json:"revision"`
			}
			if json.Unmarshal(raw, &v) == nil {
				h.Service.UpdateFocus(v.ID, v.Focused, v.ObservedAt, v.Revision)
			}
		}
	} else {
		var action string
		_ = json.Unmarshal(body["action"], &action)
		switch {
		case action == "request-permission":
			err = h.Service.RequestPermission()
		case body["serverTarget"] != nil:
			if body["serverTargets"] != nil {
				var targets []translation.SystemServerTarget
				err = json.Unmarshal(body["serverTargets"], &targets)
				if err == nil {
					err = h.Service.SetServerTargets(r.Context(), targets)
				}
			}
			if err == nil {
				var target translation.SystemServerTarget
				err = json.Unmarshal(body["serverTarget"], &target)
				if err == nil {
					err = h.Service.SetServerTarget(r.Context(), target)
				}
			}
		case body["executionTarget"] != nil:
			var target string
			err = json.Unmarshal(body["executionTarget"], &target)
			if err == nil {
				err = h.Service.SetExecutionTarget(r.Context(), target)
			}
		case body["enabled"] != nil:
			var enabled bool
			err = json.Unmarshal(body["enabled"], &enabled)
			if err == nil {
				err = h.Service.SetEnabled(r.Context(), enabled)
			}
		default:
			write(w, 400, map[string]any{"ok": false, "error": "invalid_system_translation_action"})
			return
		}
	}
	if err != nil {
		write(w, 400, map[string]any{"ok": false, "error": "desktop_translation_action_failed", "detail": "桌面翻译操作未完成，请检查配置或权限"})
		return
	}
	write(w, 200, map[string]any{"ok": true, "system": h.Service.GetStatus(r.Context())})
}
func directLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	for _, key := range []string{"X-Aih-Server-Id", "X-Forwarded-For", "Forwarded", "X-Real-IP"} {
		if r.Header.Get(key) != "" {
			return false
		}
	}
	return true
}
func write(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
