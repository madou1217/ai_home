package codexappserverapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

func (h *RemoteControlHandler) serveWebSocket(response http.ResponseWriter, request *http.Request) {
	target := h.targetURL(request.URL, true)
	h.trace(map[string]any{
		"direction": "ws_connect_to_chatgpt",
		"path":      target.Path,
	})

	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()

	dialOpts := &websocket.DialOptions{
		HTTPClient: h.httpClient,
		HTTPHeader: copyFilteredHeaders(request.Header, wsHandshakeHeaders),
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, 20*time.Second)
	upstream, _, err := websocket.Dial(dialCtx, target.String(), dialOpts)
	dialCancel()
	if err != nil {
		h.trace(map[string]any{
			"direction": "ws_connect_to_chatgpt",
			"path":      target.Path,
			"error":     SanitizeTraceText(err.Error(), 4000),
		})
		http.Error(response, "remote_control_ws_upstream_failed", http.StatusBadGateway)
		return
	}

	client, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		_ = upstream.CloseNow()
		return
	}
	client.SetReadLimit(maxAppServerLineBytes)
	upstream.SetReadLimit(maxAppServerLineBytes)

	chunks := NewRemoteChunkAssembler(h.writeTrace)
	defer chunks.Close()
	var closeOnce sync.Once
	shutdown := func() {
		closeOnce.Do(func() {
			cancel()
			_ = client.CloseNow()
			_ = upstream.CloseNow()
		})
	}
	defer shutdown()

	var wg sync.WaitGroup
	wg.Add(2)

	// client -> upstream
	go func() {
		defer wg.Done()
		defer shutdown()
		for {
			msgType, data, readErr := client.Read(ctx)
			if readErr != nil {
				if !errors.Is(readErr, context.Canceled) {
					h.trace(map[string]any{
						"direction": "ws_client_error",
						"error":     SanitizeTraceText(readErr.Error(), 4000),
					})
				}
				return
			}
			if msgType == websocket.MessageBinary {
				h.trace(map[string]any{
					"direction": "ws_app_server_to_chatgpt",
					"binary":    true,
					"summary":   map[string]any{"type": "binary"},
				})
				if writeErr := writeRemoteFrame(ctx, upstream, websocket.MessageBinary, data); writeErr != nil {
					return
				}
				continue
			}

			var envelope map[string]any
			_ = json.Unmarshal(bytes.TrimSpace(data), &envelope)
			suppressedIDs := ReadRemoteHydrationSuppressionState(h.suppressStateFile, h.now().UnixMilli())
			suppressed := ShouldSuppressRemoteHydrationEnvelope(envelope, suppressedIDs)
			var summary any = SummarizeRemoteEnvelope(envelope)
			if envelope == nil {
				summary = SummarizeRemoteEnvelope(string(data))
			}
			traceEntry := map[string]any{
				"direction": "ws_app_server_to_chatgpt",
				"binary":    false,
				"summary":   summary,
			}
			if suppressed {
				traceEntry["suppressed"] = true
				traceEntry["reason"] = "hidden_hydration_notification"
			}
			h.trace(traceEntry)
			chunks.Accept(envelope, "ws_app_server_to_chatgpt")
			if suppressed {
				continue
			}
			if writeErr := writeRemoteFrame(ctx, upstream, websocket.MessageText, data); writeErr != nil {
				return
			}
		}
	}()

	// upstream -> client
	go func() {
		defer wg.Done()
		defer shutdown()
		for {
			msgType, data, readErr := upstream.Read(ctx)
			if readErr != nil {
				if !errors.Is(readErr, context.Canceled) {
					h.trace(map[string]any{
						"direction": "ws_upstream_error",
						"error":     SanitizeTraceText(readErr.Error(), 4000),
					})
				}
				return
			}
			if msgType == websocket.MessageBinary {
				h.trace(map[string]any{
					"direction": "ws_chatgpt_to_app_server",
					"binary":    true,
					"summary":   map[string]any{"type": "binary"},
				})
				if writeErr := writeRemoteFrame(ctx, client, websocket.MessageBinary, data); writeErr != nil {
					return
				}
				continue
			}
			var envelope map[string]any
			_ = json.Unmarshal(bytes.TrimSpace(data), &envelope)
			rewritten, changed, summary := RewriteRemoteControlPayload(data)
			h.trace(map[string]any{
				"direction": "ws_chatgpt_to_app_server",
				"binary":    false,
				"rewritten": changed,
				"summary":   summary,
			})
			chunks.Accept(envelope, "ws_chatgpt_to_app_server")
			if writeErr := writeRemoteFrame(ctx, client, websocket.MessageText, rewritten); writeErr != nil {
				return
			}
		}
	}()

	wg.Wait()
}

func writeRemoteFrame(ctx context.Context, conn *websocket.Conn, kind websocket.MessageType, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return conn.Write(ctx, kind, data)
}
