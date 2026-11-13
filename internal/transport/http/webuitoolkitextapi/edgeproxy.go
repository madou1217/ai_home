package webuitoolkitextapi

import (
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/edgeproxy"
)

const edgeMaxJSONBodyBytes = 64 * 1024

type edgeErrorPayload struct {
	OK bool `json:"ok"`
	*edgeproxy.EdgeError
}

type edgeApplyRequest struct {
	Provider          string `json:"provider"`
	Mode              string `json:"mode"`
	Domain            string `json:"domain"`
	Name              string `json:"name"`
	LocalPort         int    `json:"localPort"`
	RemotePort        int    `json:"remotePort"`
	UDP               *bool  `json:"udp"`
	Reload            *bool  `json:"reload"`
	DryRun            bool   `json:"dryRun"`
	AIHPort           int    `json:"aihPort"`
	CertDir           string `json:"certDir"`
	TLSTerminatorPort int    `json:"tlsTerminatorPort"`
}

func (h *Handler) serveEdge(w http.ResponseWriter, r *http.Request, path string) {
	if h.edge == nil {
		writeError(w, http.StatusServiceUnavailable, "edge_service_unavailable", "边缘代理服务不可用")
		return
	}

	switch path {
	case EdgePath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		aihPort := h.resolveAIHPort(r, queryPositiveInt(r, "aihPort"))
		writeJSON(w, http.StatusOK, h.edge.Status(r.Context(), aihPort))

	case EdgePlanPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		q := r.URL.Query()
		provider := strings.TrimSpace(q.Get("provider"))
		if provider == "" {
			provider = "nginx"
		}
		if !edgeproxy.IsKnownKind(provider) {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":       false,
				"error":    "edge_unknown_provider",
				"provider": provider,
			})
			return
		}
		mode := strings.TrimSpace(q.Get("mode"))
		if mode == "" {
			mode = "split"
		}
		planOpts := edgeproxy.PlanOptions{
			Domain:     strings.TrimSpace(q.Get("domain")),
			Mode:       mode,
			RemotePort: queryPositiveInt(r, "remotePort"),
			UDP:        q.Get("udp") != "0",
			AIHPort:    h.resolveAIHPort(r, queryPositiveInt(r, "aihPort")),
		}
		plan, edgeErr := h.edge.Plan(provider, planOpts)
		if edgeErr != nil {
			writeJSON(w, edgeErr.HTTPStatus(), edgeErrorPayload{OK: false, EdgeError: edgeErr})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"plan": plan,
		})

	case EdgeApplyPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var req edgeApplyRequest
		if err := readJSONTarget(w, r, &req, edgeMaxJSONBodyBytes); err != nil {
			if errors.Is(err, errBodyTooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "request_body_too_large", "请求体过大")
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "invalid_json_body",
			})
			return
		}
		provider := strings.TrimSpace(req.Provider)
		if !edgeproxy.IsKnownKind(provider) {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":       false,
				"error":    "edge_unknown_provider",
				"provider": provider,
			})
			return
		}
		mode := strings.TrimSpace(req.Mode)
		if mode == "" {
			mode = "split"
		}
		udp := true
		if req.UDP != nil {
			udp = *req.UDP
		}
		reload := true
		if req.Reload != nil {
			reload = *req.Reload
		}
		applyOpts := edgeproxy.PlanOptions{
			Domain:            strings.TrimSpace(req.Domain),
			Mode:              mode,
			Name:              strings.TrimSpace(req.Name),
			LocalPort:         req.LocalPort,
			RemotePort:        req.RemotePort,
			UDP:               udp,
			Reload:            reload,
			DryRun:            req.DryRun,
			AIHPort:           h.resolveAIHPort(r, req.AIHPort),
			CertDir:           strings.TrimSpace(req.CertDir),
			TLSTerminatorPort: req.TLSTerminatorPort,
		}
		result, edgeErr := h.edge.Apply(r.Context(), provider, applyOpts)
		if edgeErr != nil {
			writeJSON(w, edgeErr.HTTPStatus(), edgeErrorPayload{OK: false, EdgeError: edgeErr})
			return
		}
		status := http.StatusOK
		if !result.OK {
			status = (&edgeproxy.EdgeError{Code: result.ErrorCode}).HTTPStatus()
		}
		writeJSON(w, status, result)

	default:
		writeError(w, http.StatusNotFound, "not_found", "未找到边缘代理路由")
	}
}

func (h *Handler) resolveAIHPort(r *http.Request, explicit int) int {
	if explicit > 0 && explicit <= 65535 {
		return explicit
	}
	if h.defaultAIHPort > 0 && h.defaultAIHPort <= 65535 {
		return h.defaultAIHPort
	}
	if raw := strings.TrimSpace(os.Getenv("AIH_PORT")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 65535 {
			return n
		}
	}
	if r != nil && r.Host != "" {
		if _, portStr, err := net.SplitHostPort(r.Host); err == nil {
			if n, err := strconv.Atoi(portStr); err == nil && n > 0 && n <= 65535 {
				return n
			}
		}
	}
	return edgeproxy.DefaultAIHPort
}

func queryPositiveInt(r *http.Request, key string) int {
	if r == nil || r.URL == nil {
		return 0
	}
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 || n > 65535 {
		return 0
	}
	return n
}
