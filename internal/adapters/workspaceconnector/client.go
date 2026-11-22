package workspaceconnector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	defaultHeartbeat      = 15 * time.Second
	defaultRequestTimeout = 30 * time.Second
	defaultMaxConcurrent  = 4
	clientReadLimit       = 8 * 1024 * 1024
	clientWriteWait       = 10 * time.Second
	clientHandshakeWait   = 10 * time.Second
	clientReadIdle        = 90 * time.Second
)

type Config struct {
	Endpoint       string
	Root           string
	Label          string
	Token          string
	WorkspaceID    string
	ConnectorID    string
	Heartbeat      time.Duration
	RequestTimeout time.Duration
	MaxConcurrent  int
	OnSession      func(Session) error
}

type Session struct {
	SessionID    string
	WorkspaceID  string
	ConnectorID  string
	SessionToken string
	Endpoint     string
	Root         string
	Label        string
	Platform     string
	Capabilities remoteconnector.Capabilities
}

type Connector struct {
	ws      *websocket.Conn
	fs      *filesystem
	config  Config
	session Session

	writeMu sync.Mutex
}

// ConnectURL derives the WebSocket endpoint from a Server profile endpoint.
// An existing path prefix is preserved for reverse-proxied deployments.
func ConnectURL(endpoint string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Host == "" {
		return "", errors.New("workspace connector endpoint is invalid")
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", errors.New("workspace connector endpoint must be http(s) or ws(s)")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + remoteconnector.ConnectPath
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

// Dial performs the hello handshake once. Call Serve to keep the session open;
// reconnects are the caller's decision so token rotation stays explicit.
func Dial(ctx context.Context, config Config) (*Connector, error) {
	root := strings.TrimSpace(config.Root)
	files, err := newFilesystem(root)
	if err != nil {
		return nil, err
	}
	connectURL, err := ConnectURL(config.Endpoint)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.Token) == "" {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "workspace connector token is required")
	}
	ws, _, err := websocket.Dial(ctx, connectURL, &websocket.DialOptions{
		HTTPClient:      &http.Client{},
		CompressionMode: websocket.CompressionDisabled,
		HTTPHeader:      http.Header{"User-Agent": []string{"aih-workspace-connector"}},
	})
	if err != nil {
		return nil, fmt.Errorf("connect workspace connector: %w", err)
	}
	ws.SetReadLimit(clientReadLimit)
	closeOnError := func() { _ = ws.CloseNow() }

	capabilities := remoteconnector.NormalizeCapabilities(remoteconnector.Capabilities{
		ReadFile: true, WriteFile: true, ListDirectory: true, Search: true,
	})
	hello := remoteconnector.Hello{
		Type:         remoteconnector.MessageHello,
		Token:        strings.TrimSpace(config.Token),
		WorkspaceID:  strings.TrimSpace(config.WorkspaceID),
		ConnectorID:  strings.TrimSpace(config.ConnectorID),
		RootLabel:    filepath.Base(files.sandbox.root),
		Platform:     runtime.GOOS,
		Capabilities: capabilities,
	}
	payload, _ := json.Marshal(hello)
	if err := writeMessage(ctx, ws, remoteconnector.Message{
		Type: remoteconnector.MessageHello, Payload: payload,
	}, nil); err != nil {
		closeOnError()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "cannot send connector hello")
	}
	frame, err := readMessage(ctx, ws, clientHandshakeWait)
	if err != nil {
		closeOnError()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "server did not accept the connector hello")
	}
	if frame.Type == remoteconnector.MessageError {
		closeOnError()
		return nil, messageError(frame)
	}
	if frame.Type != remoteconnector.MessageHelloAccepted {
		closeOnError()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server returned an unexpected hello response")
	}
	var accepted remoteconnector.HelloAccepted
	if err := json.Unmarshal(frame.Payload, &accepted); err != nil {
		closeOnError()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server returned an invalid hello acceptance")
	}
	if strings.TrimSpace(accepted.WorkspaceID) == "" {
		closeOnError()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server did not bind a workspace")
	}
	token := strings.TrimSpace(accepted.SessionToken)
	if token == "" {
		token = strings.TrimSpace(config.Token)
	}
	connectorID := strings.TrimSpace(accepted.ConnectorID)
	if connectorID == "" {
		connectorID = strings.TrimSpace(config.ConnectorID)
	}
	session := Session{
		SessionID: accepted.SessionID, WorkspaceID: accepted.WorkspaceID,
		ConnectorID: connectorID, SessionToken: token,
		Endpoint: config.Endpoint, Root: files.sandbox.root,
		Label: config.Label, Platform: runtime.GOOS,
		Capabilities: remoteconnector.NormalizeCapabilities(accepted.Capabilities),
	}
	if config.OnSession != nil {
		if err := config.OnSession(session); err != nil {
			closeOnError()
			return nil, fmt.Errorf("persist workspace connector session: %w", err)
		}
	}
	return &Connector{ws: ws, fs: files, config: config, session: session}, nil
}

func (connector *Connector) Session() Session { return connector.session }

// Serve owns the connected session. It returns ctx.Err() on cancellation, a
// permanent protocol error when reconnecting cannot help, and a transport error
// otherwise.
func (connector *Connector) Serve(ctx context.Context) error {
	if connector == nil || connector.ws == nil {
		return errors.New("workspace connector is not connected")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	heartbeat := connector.config.Heartbeat
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeat
	}
	requestTimeout := connector.config.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = defaultRequestTimeout
	}
	maxConcurrent := connector.config.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = defaultMaxConcurrent
	}
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-ticker.C:
				if err := connector.send(connCtx, remoteconnector.Message{Type: remoteconnector.MessageHeartbeat}); err != nil {
					_ = connector.ws.CloseNow()
					return
				}
				pingCtx, pingCancel := context.WithTimeout(connCtx, 5*time.Second)
				err := connector.ws.Ping(pingCtx)
				pingCancel()
				if err != nil {
					_ = connector.ws.CloseNow()
					return
				}
			}
		}
	}()

	semaphore := make(chan struct{}, maxConcurrent)
	var workers sync.WaitGroup
	defer func() {
		cancel()
		workers.Wait()
		<-heartbeatDone
		_ = connector.ws.CloseNow()
	}()

	for {
		frame, err := readMessage(connCtx, connector.ws, clientReadIdle)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("workspace connector session disconnected")
		}
		switch frame.Type {
		case remoteconnector.MessageRequest:
			if strings.TrimSpace(frame.ID) == "" {
				continue
			}
			select {
			case semaphore <- struct{}{}:
			case <-connCtx.Done():
				return connCtx.Err()
			}
			workers.Add(1)
			go func(message remoteconnector.Message) {
				defer workers.Done()
				defer func() { <-semaphore }()
				requestCtx, requestCancel := context.WithTimeout(connCtx, requestTimeout)
				defer requestCancel()
				response := connector.execute(requestCtx, message)
				_ = connector.send(connCtx, response)
			}(frame)
		case remoteconnector.MessageError:
			// A Server-side error frame is only terminal when it invalidates the
			// token or the protocol. Other errors are per-request and are delivered
			// through Call on the Server side.
			if frame.Error != nil && remoteconnector.IsPermanent(frame.Error.Code) {
				return remoteconnector.NewProtocolError(frame.Error.Code, frame.Error.Message)
			}
		case remoteconnector.MessageGoodbye:
			return nil
		}
	}
}

func (connector *Connector) execute(ctx context.Context, request remoteconnector.Message) remoteconnector.Message {
	result, err := connector.fs.execute(ctx, request.Operation, request.Payload)
	if err != nil {
		code := remoteconnector.ErrorCode(err)
		message := ""
		var protocolErr *remoteconnector.ProtocolError
		if errors.As(err, &protocolErr) {
			message = protocolErr.Message
		}
		return remoteconnector.Message{
			Type: remoteconnector.MessageError, ID: request.ID,
			Error: &remoteconnector.Error{Code: code, Message: message},
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return remoteconnector.Message{
			Type: remoteconnector.MessageError, ID: request.ID,
			Error: &remoteconnector.Error{Code: remoteconnector.CodeInternal, Message: "cannot encode operation result"},
		}
	}
	return remoteconnector.Message{Type: remoteconnector.MessageResponse, ID: request.ID, Payload: encoded}
}

func (connector *Connector) send(ctx context.Context, message remoteconnector.Message) error {
	return writeMessage(ctx, connector.ws, message, &connector.writeMu)
}

func (connector *Connector) Close() {
	if connector == nil || connector.ws == nil {
		return
	}
	goodbye, _ := json.Marshal(remoteconnector.Message{Type: remoteconnector.MessageGoodbye})
	writeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	_ = connector.ws.Write(writeCtx, websocket.MessageText, goodbye)
	cancel()
	_ = connector.ws.Close(websocket.StatusNormalClosure, "client_stop")
}

func writeMessage(ctx context.Context, ws *websocket.Conn, message remoteconnector.Message, mutex *sync.Mutex) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if mutex != nil {
		mutex.Lock()
		defer mutex.Unlock()
	}
	writeCtx, cancel := context.WithTimeout(ctx, clientWriteWait)
	defer cancel()
	return ws.Write(writeCtx, websocket.MessageText, encoded)
}

func readMessage(ctx context.Context, ws *websocket.Conn, timeout time.Duration) (remoteconnector.Message, error) {
	readCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	frameType, raw, err := ws.Read(readCtx)
	if err != nil {
		return remoteconnector.Message{}, err
	}
	if frameType != websocket.MessageText {
		return remoteconnector.Message{}, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server frame must be text")
	}
	var message remoteconnector.Message
	if err := json.Unmarshal(raw, &message); err != nil {
		return remoteconnector.Message{}, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server frame is not valid JSON")
	}
	return message, nil
}

func messageError(message remoteconnector.Message) error {
	if message.Error == nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "server rejected the connector")
	}
	return remoteconnector.NewProtocolError(message.Error.Code, message.Error.Message)
}
