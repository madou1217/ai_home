// Package webuiaccountbrowserapi exposes the authenticated account-browser
// profile foundation. A retained profile is not proof of an open browser or a
// persisted third-party login; those require an attached, verified host.
package webuiaccountbrowserapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
)

const (
	BasePath         = "/v1/management/webui/account-browser"
	ProfilePath      = BasePath + "/profiles/{provider}/{accountRef}"
	CapabilitiesPath = BasePath + "/capabilities"
)

type Authorizer interface{ Authorized(*http.Request) bool }

type Dependencies struct {
	Authorizer Authorizer
	Authority  Authority
	Runtime    *accountbrowser.Service
}

type Handler struct {
	authorizer Authorizer
	authority  Authority
	runtime    *accountbrowser.Service
}

func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Authority == nil || deps.Runtime == nil {
		return nil, errors.New("account browser dependencies unavailable")
	}
	return &Handler{authorizer: deps.Authorizer, authority: deps.Authority, runtime: deps.Runtime}, nil
}

// ServeHTTP is registered on the exact method/path patterns by the composition
// root; the existing router generates browser aliases without another service.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h == nil || h.authorizer == nil || h.authority == nil || h.runtime == nil {
		writeError(w, http.StatusServiceUnavailable, "browser_service_unavailable")
		return
	}
	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if r.Body != nil {
		var byteBuffer [1]byte
		n, err := io.ReadFull(r.Body, byteBuffer[:])
		if n != 0 || (err != nil && err != io.EOF) {
			writeError(w, http.StatusBadRequest, "unexpected_request_body")
			return
		}
	}
	if r.URL.Path == CapabilitiesPath {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "profileRegistry": true, "hostAvailable": h.runtime.HostAvailable(),
			"electron": false, "stage": "profile-foundation",
		})
		return
	}
	identity, err := h.authority.Resolve(r.Context(), r.PathValue("provider"), r.PathValue("accountRef"))
	if err != nil {
		h.writeRuntimeError(w, err)
		return
	}
	var profile accountbrowser.Profile
	created := false
	switch {
	case strings.HasSuffix(r.URL.Path, "/open") && r.Method == http.MethodPost:
		profile, err = h.runtime.Open(r.Context(), identity)
	case strings.HasSuffix(r.URL.Path, "/close") && r.Method == http.MethodPost:
		profile, err = h.runtime.Close(r.Context(), identity)
	case r.Method == http.MethodGet && !strings.HasSuffix(r.URL.Path, "/open") && !strings.HasSuffix(r.URL.Path, "/close"):
		profile, err = h.runtime.Get(r.Context(), identity)
	case r.Method == http.MethodPost && !strings.HasSuffix(r.URL.Path, "/open") && !strings.HasSuffix(r.URL.Path, "/close"):
		profile, created, err = h.runtime.Ensure(r.Context(), identity)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if err != nil {
		h.writeRuntimeError(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{
		"ok": true, "profile": profile, "created": created,
		"hostAvailable": h.runtime.HostAvailable(),
	})
}

func (h *Handler) writeRuntimeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accountbrowser.ErrInvalidIdentity):
		writeError(w, http.StatusBadRequest, "invalid_browser_identity")
	case errors.Is(err, ErrAccountNotFound), errors.Is(err, accountbrowser.ErrProfileNotFound):
		writeError(w, http.StatusNotFound, "browser_profile_not_found")
	case errors.Is(err, accountbrowser.ErrProfileCorrupt), errors.Is(err, accountbrowser.ErrUnsafePath):
		writeError(w, http.StatusConflict, "browser_profile_unavailable")
	case errors.Is(err, accountbrowser.ErrHostUnavailable):
		writeError(w, http.StatusServiceUnavailable, "browser_host_unavailable")
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusRequestTimeout, "browser_request_cancelled")
	default:
		// Filesystem paths and upstream errors never enter public responses.
		writeError(w, http.StatusServiceUnavailable, "browser_service_unavailable")
	}
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": code})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
