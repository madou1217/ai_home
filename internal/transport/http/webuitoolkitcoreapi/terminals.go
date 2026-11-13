package webuitoolkitcoreapi

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
)

func (h *Handler) handleTerminalsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, terminals.ListClientTerminals(h.terminalsOpts))
}

func (h *Handler) handleTerminalsPlan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body struct {
		TerminalID string `json:"terminalId"`
		Action     string `json:"action"`
	}
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, "invalid_terminal_payload", errMsg)
		return
	}
	res := terminals.ResolveTerminalActionPlan(body.TerminalID, body.Action, h.terminalsOpts)
	status := http.StatusOK
	if !res.OK {
		status = terminalErrorStatus(res.Error)
	}
	writeJSON(w, status, res)
}

func (h *Handler) handleTerminalsOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body terminals.OpenRequest
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, "invalid_terminal_payload", errMsg)
		return
	}
	res := terminals.OpenClientTerminal(body, h.terminalsOpts)
	status := http.StatusOK
	if !res.OK {
		status = terminalErrorStatus(res.Error)
	}
	writeJSON(w, status, res)
}

func (h *Handler) handleTerminalsExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	var body terminals.StartRequest
	if ok, status, errMsg := decodeJSONBody(w, r, smallBodyMaxBytes, &body); !ok {
		writeError(w, status, "invalid_terminal_payload", errMsg)
		return
	}
	res := h.terminalJobs.Start(r.Context(), body)
	if res.OK {
		writeJSON(w, http.StatusAccepted, res)
		return
	}
	writeJSON(w, terminalErrorStatus(res.Error), res)
}

func (h *Handler) handleTerminalsJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	job := h.terminalJobs.Get(jobID)
	if job == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "job_not_found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "job": job})
}

func terminalErrorStatus(errCode string) int {
	switch errCode {
	case "confirmation_required":
		return http.StatusPreconditionRequired
	case "web_terminal_required":
		return http.StatusConflict
	}
	if strings.HasPrefix(errCode, "unsupported_") || strings.HasPrefix(errCode, "terminal_") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}
