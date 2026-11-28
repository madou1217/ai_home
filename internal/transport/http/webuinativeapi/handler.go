// Package webuinativeapi exposes live provider-native CLI sessions that are not
// backed by a tmux/web terminal. They can only be continued through the
// provider's resume command, so the WebUI opens a durable terminal running
// `aih <provider> resume <sessionId>` on demand.
package webuinativeapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

const (
	// Path is the native session inventory endpoint.
	Path = "/v1/management/webui/native-sessions"
)

// Authorizer validates WebUI management access.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies configures the native session inventory.
type Dependencies struct {
	Authorizer  Authorizer
	AIHomeDir   string
	HostHomeDir string
	Getenv      func(string) string
}

// Handler serves GET Path.
type Handler struct {
	authorizer  Authorizer
	aiHomeDir   string
	hostHomeDir string
	getenv      func(string) string
}

// NewHandler creates the handler. Missing authorizer fails closed.
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, http.ErrNotSupported
	}
	getenv := deps.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	return &Handler{
		authorizer:  deps.Authorizer,
		aiHomeDir:   strings.TrimSpace(deps.AIHomeDir),
		hostHomeDir: strings.TrimSpace(deps.HostHomeDir),
		getenv:      getenv,
	}, nil
}

type sessionView struct {
	SessionKey      string `json:"sessionKey"`
	Label           string `json:"label"`
	Cwd             string `json:"cwd"`
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
	Source          string `json:"source"`
	Status          string `json:"status"`
	AttachMode      string `json:"attachMode"`
	ResumeCommand   string `json:"resumeCommand,omitempty"`
}

// ServeHTTP returns provider-native sessions that are alive but not attached to
// tmux. The full session identity is required for a safe resume.
func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || h.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "native_sessions_unavailable"})
		return
	}
	if !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	if h.aiHomeDir == "" {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "native_sessions_home_missing"})
		return
	}

	targets, err := peer.ListTargets(request.Context(), h.aiHomeDir, h.hostHomeDir, h.getenv)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "native_sessions_unavailable"})
		return
	}
	cli := resolveCLIPath()
	sessions := make([]sessionView, 0, len(targets))
	for _, target := range targets {
		if target.Channel != "native" || strings.TrimSpace(target.SessionID) == "" {
			continue
		}
		provider := strings.TrimSpace(target.Provider)
		sessionID := strings.TrimSpace(target.SessionID)
		if provider == "" || !safeToken(provider) || !safeToken(sessionID) {
			continue
		}
		label := strings.TrimSpace(target.Name)
		if label == "" {
			label = provider + " · " + shorten(sessionID)
		}
		sessions = append(sessions, sessionView{
			SessionKey:      "native-live:" + provider + ":" + sessionID,
			Label:           label,
			Cwd:             strings.TrimSpace(target.CWD),
			Provider:        provider,
			NativeSessionID: sessionID,
			Source:          "native",
			Status:          "running",
			AttachMode:      "resume",
			ResumeCommand:   resumeCommand(cli, provider, sessionID),
		})
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "sessions": sessions})
}

// resolveCLIPath locates the Go CLI next to the running server binary.
func resolveCLIPath() string {
	executable, err := os.Executable()
	if err != nil || strings.TrimSpace(executable) == "" {
		return ""
	}
	candidate := filepath.Join(filepath.Dir(executable), "aih-go")
	if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
		return candidate
	}
	return ""
}

func resumeCommand(cli, provider, sessionID string) string {
	args := []string{provider, "resume", sessionID}
	parts := make([]string, 0, len(args)+1)
	if cli != "" {
		parts = append(parts, shellQuote(cli))
	} else {
		parts = append(parts, "aih")
	}
	for _, arg := range args {
		parts = append(parts, shellQuote(arg))
	}
	return strings.Join(parts, " ")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

func safeToken(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.', r == ':':
		default:
			return false
		}
	}
	return true
}

func shorten(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}