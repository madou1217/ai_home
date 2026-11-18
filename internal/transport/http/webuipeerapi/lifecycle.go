package webuipeerapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

const (
	CancelPath = MessagesPath + "/cancel"
	ResumePath = MessagesPath + "/resume"
)

func (handler *Handler) handleLifecycle(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 64*1024)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input peer.LifecycleInput
	if err := decoder.Decode(&input); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_lifecycle_input"})
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_lifecycle_input"})
		return
	}
	store := peer.NewDispatchStore(handler.aiHomeDir, peer.StoreOptions{Now: handler.now})
	var rec *peer.Record
	var err error
	if request.URL.Path == CancelPath {
		rec, err = store.CancelMessage(input)
	} else {
		rec, err = store.ResumeMessage(input)
	}
	if err != nil {
		status := http.StatusConflict
		switch {
		case errors.Is(err, peer.ErrMessageNotFound):
			status = http.StatusNotFound
		case errors.Is(err, peer.ErrInvalidRecord), errors.Is(err, peer.ErrIdentityMismatch):
			status = http.StatusBadRequest
		case errors.Is(err, peer.ErrStoreUnavailable):
			status = http.StatusServiceUnavailable
		}
		writeJSON(response, status, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "record": rec})
}
