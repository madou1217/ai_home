// Package codexresumeapi owns the project-scoped Codex CLI resume WebSocket.
package codexresumeapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const maxFrameBytes = 16 * 1024 * 1024

type Options struct {
	Context                                   context.Context
	RemoteURL, UpstreamToken, LocalToken, Cwd string
}
type Handler struct {
	options Options
	slots   chan struct{}
	client  *http.Client
}

func New(options Options) (*Handler, error) {
	target, err := url.Parse(options.RemoteURL)
	if err != nil || target.Host == "" || (target.Scheme != "ws" && target.Scheme != "wss") || target.User != nil || target.Fragment != "" || strings.TrimSpace(options.Cwd) == "" {
		return nil, errors.New("resume_proxy_configuration_invalid")
	}
	if target.Scheme == "ws" {
		host := target.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return nil, errors.New("resume_proxy_remote_requires_tls")
		}
	}
	for _, key := range []string{"token", "api_key", "access_token", "authorization"} {
		if target.Query().Get(key) != "" {
			return nil, errors.New("resume_proxy_query_credentials_forbidden")
		}
	}
	if len(options.LocalToken) < 32 || len(options.LocalToken) > 8192 || len(options.UpstreamToken) > 8192 || strings.ContainsAny(options.LocalToken+options.UpstreamToken, "\r\n\x00") {
		return nil, errors.New("resume_proxy_credentials_invalid")
	}
	if options.Context == nil {
		options.Context = context.Background()
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(request *http.Request) (*url.URL, error) {
		if request.URL.Scheme == "http" {
			return nil, nil
		}
		return http.ProxyFromEnvironment(request)
	}
	return &Handler{options: options, slots: make(chan struct{}, 8), client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (handler *Handler) Close() { handler.client.CloseIdleConnections() }

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if request.Header.Get("Origin") != "" {
		http.Error(response, "resume_proxy_cli_only", http.StatusForbidden)
		return
	}
	if request.URL.Path != "/" || request.URL.RawQuery != "" {
		http.NotFound(response, request)
		return
	}
	fields := strings.Fields(request.Header.Get("Authorization"))
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || subtle.ConstantTimeCompare([]byte(fields[1]), []byte(handler.options.LocalToken)) != 1 {
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	select {
	case handler.slots <- struct{}{}:
		defer func() { <-handler.slots }()
	default:
		http.Error(response, "resume_proxy_busy", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithCancel(handler.options.Context)
	defer cancel()
	stopRequest := context.AfterFunc(request.Context(), cancel)
	defer stopRequest()
	header := make(http.Header)
	if handler.options.UpstreamToken != "" {
		header.Set("Authorization", "Bearer "+handler.options.UpstreamToken)
	}
	dialCtx, stopDial := context.WithTimeout(ctx, 10*time.Second)
	upstream, _, err := websocket.Dial(dialCtx, handler.options.RemoteURL, &websocket.DialOptions{HTTPClient: handler.client, HTTPHeader: header, CompressionMode: websocket.CompressionDisabled})
	stopDial()
	if err != nil {
		http.Error(response, "resume_upstream_unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.CloseNow()
	client, err := websocket.Accept(response, request, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer client.CloseNow()
	client.SetReadLimit(maxFrameBytes)
	upstream.SetReadLimit(maxFrameBytes)
	tracker := codexappserverws.NewResumeTracker()
	defer tracker.Close()
	scopes := codexappserverws.NewThreadListScopeTracker()
	defer scopes.Close()
	var workers sync.WaitGroup
	workers.Add(2)
	stop := func() { cancel(); _ = client.CloseNow(); _ = upstream.CloseNow() }
	go func() {
		defer workers.Done()
		defer stop()
		for {
			kind, raw, err := client.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageText {
				if err = scopes.TryRemember(raw, codexappserverws.RewriteOptions{Cwd: handler.options.Cwd}); err != nil {
					if errors.Is(err, codexappserverws.ErrResumeRequestDuplicate) {
						return
					}
					if !writeCapacityError(ctx, client, raw, err.Error()) {
						return
					}
					continue
				}
				raw = codexappserverws.RewriteClientMessage(raw, codexappserverws.RewriteOptions{Cwd: handler.options.Cwd})
				if _, err = tracker.TryRememberRequest(raw); err != nil {
					if errors.Is(err, codexappserverws.ErrResumeRequestDuplicate) {
						return
					}
					if !writeCapacityError(ctx, client, raw, err.Error()) {
						return
					}
					continue
				}
			}
			if writeFrame(ctx, upstream, kind, raw) != nil {
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		defer stop()
		for {
			kind, raw, err := upstream.Read(ctx)
			if err != nil {
				return
			}
			if kind == websocket.MessageText {
				raw = scopes.Patch(tracker.PatchResponse(raw))
			}
			if writeFrame(ctx, client, kind, raw) != nil {
				return
			}
		}
	}()
	workers.Wait()
}

func writeFrame(ctx context.Context, conn *websocket.Conn, kind websocket.MessageType, raw []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return conn.Write(ctx, kind, raw)
}
func writeCapacityError(ctx context.Context, conn *websocket.Conn, raw []byte, reason string) bool {
	var request map[string]json.RawMessage
	if json.Unmarshal(raw, &request) != nil {
		return false
	}
	response := map[string]any{"id": request["id"], "error": map[string]any{"code": -32000, "message": reason}}
	encoded, err := json.Marshal(response)
	return err == nil && writeFrame(ctx, conn, websocket.MessageText, encoded) == nil
}
