package aihserver

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuiauth"
)

const drainLease = 10 * time.Minute

// drainHandler is mounted only on this server's loopback listener. It is the
// admission gate used by CLI/WebUI restart before a service-manager signal:
// begin stops new inference and reports how many streams must finish; cancel
// reopens admission if the restart is abandoned.
type drainHandler struct {
	streams *streamShutdown
	key     func() string
}

func newDrainHandler(streams *streamShutdown, key func() string) http.Handler {
	return &drainHandler{streams: streams, key: key}
}

func (handler *drainHandler) managementKey() string {
	if handler == nil || handler.key == nil {
		return ""
	}
	return handler.key()
}

func (handler *drainHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeDrainJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":    false,
			"error": "method_not_allowed",
		})
		return
	}
	auth := webuiauth.AuthorizeManagementKeyOrLoopback(request, handler.managementKey())
	if !auth.OK {
		if auth.StatusCode == http.StatusUnauthorized {
			response.Header().Set("WWW-Authenticate", "Bearer")
		}
		writeDrainJSON(response, auth.StatusCode, map[string]any{
			"ok":    false,
			"error": auth.Reason,
		})
		return
	}
	if handler.streams == nil {
		writeDrainJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "drain_unavailable",
		})
		return
	}
	action := request.URL.Query().Get("action")
	if action == "" {
		action = "begin"
	}
	switch action {
	case "begin":
		active := handler.streams.beginDrain(drainLease)
		writeDrainJSON(response, http.StatusOK, map[string]any{
			"ok":               true,
			"action":           "begin",
			"active_inference": active,
		})
	case "cancel":
		handler.streams.cancelDrain()
		writeDrainJSON(response, http.StatusOK, map[string]any{
			"ok":     true,
			"action": "cancel",
		})
	default:
		writeDrainJSON(response, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "invalid_drain_action",
		})
	}
}

func writeDrainJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
