package webuitoolkitcoreapi

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/network"
)

func (h *Handler) handleMirrors(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	forceRefresh := r.URL.Query().Get("refresh") == "1"
	writeJSON(w, http.StatusOK, h.mirrorsMgr.GetStatus(r.Context(), forceRefresh))
}

func (h *Handler) handleMirrorsSet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	res := h.mirrorsMgr.SetMirror(r.Context(), body.Type, body.URL)
	if res.Error == "unsupported_mirror_type" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_mirror_type"})
		return
	}
	writeJSON(w, serviceResultStatus(res.OK, res.Error, res.ExitCode), res)
}

func (h *Handler) handleMirrorsPing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	if strings.TrimSpace(body.URL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "url_required"})
		return
	}
	ping := h.mirrorsMgr.Ping(r.Context(), body.URL)
	status := http.StatusOK
	if ping.Error != nil && *ping.Error == "invalid_url" {
		status = http.StatusBadRequest
	}
	writeJSON(w, status, ping)
}

func (h *Handler) handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	forceRefresh := r.URL.Query().Get("refresh") == "1"
	writeJSON(w, http.StatusOK, h.networkMgr.GetProxyStatus(r.Context(), forceRefresh))
}

func (h *Handler) handleProxySet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		Target   string `json:"target"`
		ProxyURL string `json:"proxyUrl"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, errMsg, errMsg)
		return
	}
	res := h.networkMgr.SetToolProxy(r.Context(), body.Target, body.ProxyURL)
	errCode := ""
	if res.Error != nil {
		errCode = *res.Error
	}
	if errCode == "unsupported_proxy_target" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_proxy_target"})
		return
	}
	writeJSON(w, serviceResultStatus(res.OK, errCode, nil), res)
}

func (h *Handler) handleConnectivity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	q := r.URL.Query()
	route := q.Get("route")
	if route == "" {
		route = "direct"
	}
	forceRefresh := q.Get("refresh") == "1"
	data := h.networkMgr.GetConnectivity(r.Context(), network.ConnectivityConfig{
		Route:    route,
		ProxyURL: q.Get("proxyUrl"),
	}, forceRefresh)
	writeJSON(w, serviceResultStatus(data.OK, data.Error, nil), data)
}
