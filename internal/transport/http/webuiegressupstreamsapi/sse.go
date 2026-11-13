package webuiegressupstreamsapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const defaultHeartbeatInterval = 25 * time.Second

func (handler *Handler) serveWatchSSE(responseWriter http.ResponseWriter, request *http.Request) {
	headers := responseWriter.Header()
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	responseWriter.WriteHeader(http.StatusOK)

	events, cancel := handler.manager.SubscribeWatch()
	defer cancel()

	readyPayload := map[string]any{
		"type": "ready",
		"at":   handler.now().UnixMilli(),
	}
	if !writeSSEData(responseWriter, readyPayload) {
		return
	}
	flushResponse(responseWriter)

	ticker := time.NewTicker(handler.heartbeatInterval)
	defer ticker.Stop()

	ctxDone := request.Context().Done()
	for {
		select {
		case <-ctxDone:
			return
		case evt, open := <-events:
			if !open {
				return
			}
			if !writeSSEData(responseWriter, evt) {
				return
			}
			flushResponse(responseWriter)
		case <-ticker.C:
			if _, err := fmt.Fprint(responseWriter, ": heartbeat\n\n"); err != nil {
				return
			}
			flushResponse(responseWriter)
		}
	}
}

func writeSSEData(responseWriter http.ResponseWriter, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	_, err = fmt.Fprintf(responseWriter, "data: %s\n\n", encoded)
	return err == nil
}

func flushResponse(responseWriter http.ResponseWriter) {
	if flusher, ok := responseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
