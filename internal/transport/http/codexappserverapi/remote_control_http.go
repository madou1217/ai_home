package codexappserverapi

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

// HTTP bodies are streamed, not duplicated into 64 MiB Go slices. Requests keep
// the existing size ceiling; responses are not truncated at that request limit.
func (handler *RemoteControlHandler) serveHTTPRequest(response http.ResponseWriter, request *http.Request) {
	target := handler.targetURL(request.URL, false)
	if request.ContentLength > MaxRemoteHTTPBodyBytes {
		http.Error(response, "request_body_too_large", http.StatusRequestEntityTooLarge)
		return
	}
	body := http.MaxBytesReader(response, request.Body, MaxRemoteHTTPBodyBytes)
	defer body.Close()
	upstream, err := http.NewRequestWithContext(request.Context(), request.Method, target.String(), body)
	if err != nil {
		http.Error(response, "remote_control_proxy_failed", http.StatusInternalServerError)
		return
	}
	upstream.ContentLength = request.ContentLength
	if request.ContentLength == 0 && (request.Body == nil || request.Body == http.NoBody) {
		upstream.Body = nil
	}
	upstream.Header = copyFilteredHeaders(request.Header, nil)
	handler.trace(map[string]any{"direction": "http_to_chatgpt", "method": request.Method, "path": target.Path, "bodyBytes": request.ContentLength})
	remote, err := handler.httpClient.Do(upstream)
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			http.Error(response, "request_body_too_large", http.StatusRequestEntityTooLarge)
			return
		}
		handler.trace(map[string]any{"direction": "http_from_chatgpt", "error": SanitizeTraceText(err.Error(), 4000)})
		http.Error(response, "remote_control_proxy_upstream_failed", http.StatusBadGateway)
		return
	}
	defer remote.Body.Close()
	for key, values := range copyFilteredHeaders(remote.Header, nil) {
		for _, value := range values {
			response.Header().Add(key, value)
		}
	}
	if remote.ContentLength >= 0 {
		response.Header().Set("Content-Length", strconv.FormatInt(remote.ContentLength, 10))
	}
	controller := http.NewResponseController(response)
	defer controller.SetWriteDeadline(time.Time{})
	response.WriteHeader(remote.StatusCode)
	_ = controller.Flush()
	buffer := make([]byte, 32*1024)
	var copied int64
	for {
		n, readErr := remote.Body.Read(buffer)
		if n > 0 {
			_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
			written, writeErr := response.Write(buffer[:n])
			copied += int64(written)
			if writeErr != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				handler.trace(map[string]any{"direction": "http_response_incomplete", "error": SanitizeTraceText(readErr.Error(), 4000)})
				panic(http.ErrAbortHandler)
			}
			break
		}
	}
	handler.trace(map[string]any{"direction": "http_from_chatgpt", "method": request.Method, "path": target.Path, "status": remote.StatusCode, "bodyBytes": copied, "requestId": remote.Header.Get("X-Request-Id"), "cfRay": remote.Header.Get("Cf-Ray")})
}
