// Package proxyleaseapi exposes authenticated task-scoped proxy selection.
package proxyleaseapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/managedproxy"
	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
)

const CandidatesPath = "/v1/management/proxy-candidates"
const LeasesPath = "/v1/management/proxy-leases"

type Authorizer interface{ Authorized(*http.Request) bool }
type Handler struct {
	Authorizer Authorizer
	Runtime    *sshproxy.LeaseManager
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Authorizer == nil || !h.Authorizer.Authorized(r) {
		http.Error(w, "unauthorized", 401)
		return
	}
	if h.Runtime == nil {
		http.Error(w, "proxy runtime unavailable", 503)
		return
	}
	path := r.URL.Path
	if r.Method == "GET" && (path == CandidatesPath || strings.HasSuffix(path, "/webui/proxy-candidates")) {
		write(w, 200, map[string]any{"ok": true, "candidates": h.Runtime.Candidates()})
		return
	}
	if path == LeasesPath && r.Method == "POST" {
		var body struct {
			Selector string `json:"selector"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body) != nil {
			write(w, 400, map[string]any{"ok": false, "error": "invalid_proxy_selector"})
			return
		}
		lease, err := h.Runtime.Acquire(r.Context(), body.Selector)
		if err != nil {
			write(w, 409, map[string]any{"ok": false, "error": "proxy_unavailable", "message": err.Error()})
			return
		}
		write(w, 201, map[string]any{"ok": true, "id": lease.ID, "name": lease.Name, "proxyUrl": lease.ProxyURL})
		return
	}
	id := strings.TrimPrefix(path, LeasesPath+"/")
	if id == path || id == "" {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(id, "/connect") && r.Method == "GET" {
		id = strings.TrimSuffix(id, "/connect")
		h.connect(w, r, id)
		return
	}
	if r.Method == "DELETE" && !strings.Contains(id, "/") {
		h.Runtime.Release(id)
		write(w, 200, map[string]any{"ok": true})
		return
	}
	http.NotFound(w, r)
}
func (h *Handler) connect(w http.ResponseWriter, r *http.Request, id string) {
	if len(id) != 48 || !strings.EqualFold(r.Header.Get("Upgrade"), "aih-proxy") {
		http.Error(w, "proxy Upgrade required", 400)
		return
	}
	upstream, err := h.Runtime.Connect(r.Context(), id)
	if err != nil {
		http.Error(w, "proxy lease unavailable", 410)
		return
	}
	connection, buffer, err := http.NewResponseController(w).Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	_, err = fmt.Fprint(buffer, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: aih-proxy\r\n\r\n")
	if err == nil {
		err = buffer.Flush()
	}
	if err != nil {
		connection.Close()
		upstream.Close()
		return
	}
	managedproxy.Pipe(connection, upstream, buffer.Reader)
}
func write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
