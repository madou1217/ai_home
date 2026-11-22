package webuiworkspaceconnectorapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const (
	connectAuthTimeout  = 5 * time.Second
	connectIdleTimeout  = 60 * time.Second
	connectHeartbeat    = 15 * time.Second
	connectPingTimeout  = 5 * time.Second
	connectFirstFrame   = 16 * 1024
	connectReadLimit    = 8 * 1024 * 1024
	connectWriteTimeout = 10 * time.Second
)

func (handler *Handler) serveConnect(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(response, http.MethodGet)
		return
	}
	// Browser origins are never valid here: the connector is a CLI process. A
	// non-empty Origin therefore means a browser page attempted the handshake.
	if strings.TrimSpace(request.Header.Get("Origin")) != "" {
		writeError(response, http.StatusForbidden, "forbidden", "browser origins are not allowed for workspace connectors")
		return
	}
	ws, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(connectFirstFrame)
	defer func() { _ = ws.CloseNow() }()

	hello, err := readHello(request.Context(), ws)
	if err != nil {
		closeWithProtocolError(ws, err)
		return
	}
	workspace, sessionToken, err := handler.authenticateHello(request.Context(), hello)
	if err != nil {
		closeWithProtocolError(ws, err)
		return
	}
	capabilities := remoteconnector.IntersectCapabilities(workspace.Capabilities, hello.Capabilities)
	if len(capabilities.NamesOrDerived()) == 0 {
		closeWithProtocolError(ws, remoteconnector.NewProtocolError(remoteconnector.CodeCapabilityNotAllowed, "connector declared no granted capability"))
		return
	}
	rootLabel := sanitizeDisplay(hello.RootLabel, workspace.RootLabel)
	platform := sanitizeDisplay(hello.Platform, workspace.Platform)
	connection := workspaceconnector.NewConnection(ws, workspaceconnector.ConnectionInfo{
		WorkspaceID:  workspace.ID,
		ConnectorID:  workspace.ConnectorID,
		SessionID:    newSessionID(),
		RootLabel:    rootLabel,
		Platform:     platform,
		Capabilities: capabilities,
	})
	generation, err := handler.hub.Attach(connection)
	if err != nil {
		closeWithProtocolError(ws, remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "cannot attach connector session"))
		return
	}
	defer handler.hub.Detach(workspace.ID, generation)
	defer connection.Close("handler_exit")

	accepted := remoteconnector.HelloAccepted{
		Type:         remoteconnector.MessageHelloAccepted,
		SessionID:    connection.Info().SessionID,
		WorkspaceID:  workspace.ID,
		ConnectorID:  workspace.ConnectorID,
		SessionToken: sessionToken,
		Capabilities: capabilities,
		HeartbeatSec: int(connectHeartbeat / time.Second),
	}
	payload, _ := json.Marshal(accepted)
	if err := connection.Send(request.Context(), remoteconnector.Message{
		Type: remoteconnector.MessageHelloAccepted, SessionID: accepted.SessionID,
		WorkspaceID: workspace.ID, Payload: payload,
	}); err != nil {
		return
	}
	ws.SetReadLimit(connectReadLimit)

	connCtx, cancel := context.WithCancel(request.Context())
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(connectHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-connection.Closed():
				return
			case <-ticker.C:
				pingCtx, pingCancel := context.WithTimeout(connCtx, connectPingTimeout)
				err := ws.Ping(pingCtx)
				pingCancel()
				if err != nil {
					connection.Close("heartbeat_failed")
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-pingDone
	}()

	for {
		frameType, raw, readErr := readFrame(connCtx, ws, connectIdleTimeout)
		if readErr != nil {
			return
		}
		if frameType != websocket.MessageText {
			_ = connection.Send(connCtx, remoteconnector.Message{
				Type:  remoteconnector.MessageError,
				Error: &remoteconnector.Error{Code: remoteconnector.CodeProtocolError, Message: "connector frames must be text"},
			})
			continue
		}
		var message remoteconnector.Message
		if err := json.Unmarshal(raw, &message); err != nil {
			_ = connection.Send(connCtx, remoteconnector.Message{
				Type:  remoteconnector.MessageError,
				Error: &remoteconnector.Error{Code: remoteconnector.CodeProtocolError, Message: "connector frame is not valid JSON"},
			})
			continue
		}
		connection.Touch()
		switch message.Type {
		case remoteconnector.MessageHeartbeat:
			_ = handler.store.Touch(connCtx, workspace.ID)
			_ = connection.Send(connCtx, remoteconnector.Message{Type: remoteconnector.MessageHeartbeatAck})
		case remoteconnector.MessageResponse, remoteconnector.MessageError:
			connection.Deliver(message)
		case remoteconnector.MessageGoodbye:
			return
		case remoteconnector.MessageRequest:
			_ = connection.Send(connCtx, remoteconnector.Message{
				Type: remoteconnector.MessageError, ID: message.ID,
				Error: &remoteconnector.Error{Code: remoteconnector.CodeServerUnsupported, Message: "the server does not accept connector requests"},
			})
		default:
			_ = connection.Send(connCtx, remoteconnector.Message{
				Type: remoteconnector.MessageError, ID: message.ID,
				Error: &remoteconnector.Error{Code: remoteconnector.CodeProtocolError, Message: "unsupported connector message type"},
			})
		}
	}
}

func readHello(ctx context.Context, ws *websocket.Conn) (remoteconnector.Hello, error) {
	frameType, raw, err := readFrame(ctx, ws, connectAuthTimeout)
	if err != nil {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "connector did not send a hello frame in time")
	}
	if frameType != websocket.MessageText {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "hello frame must be text")
	}
	var envelope remoteconnector.Message
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "hello frame is not valid JSON")
	}
	if envelope.Type != remoteconnector.MessageHello {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeProtocolError, "first frame must be hello")
	}
	var hello remoteconnector.Hello
	if len(envelope.Payload) > 0 {
		if err := json.Unmarshal(envelope.Payload, &hello); err != nil {
			return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "hello payload is not valid JSON")
		}
	} else if err := json.Unmarshal(raw, &hello); err != nil {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "hello is not valid JSON")
	}
	hello.Token = strings.TrimSpace(hello.Token)
	hello.WorkspaceID = strings.TrimSpace(hello.WorkspaceID)
	hello.ConnectorID = strings.TrimSpace(hello.ConnectorID)
	hello.Capabilities = remoteconnector.NormalizeCapabilities(hello.Capabilities)
	if hello.Token == "" {
		return remoteconnector.Hello{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "connector token is missing")
	}
	return hello, nil
}

func (handler *Handler) authenticateHello(ctx context.Context, hello remoteconnector.Hello) (workspaceconnector.Workspace, string, error) {
	if hello.WorkspaceID == "" {
		workspace, token, err := handler.store.ClaimEnrollment(ctx, hello.Token, hello)
		if err != nil {
			return workspaceconnector.Workspace{}, "", err
		}
		return workspace, token, nil
	}
	workspace, err := handler.store.Authenticate(ctx, hello.WorkspaceID, hello.Token)
	if err != nil {
		return workspaceconnector.Workspace{}, "", err
	}
	if hello.ConnectorID != "" && hello.ConnectorID != workspace.ConnectorID {
		return workspaceconnector.Workspace{}, "", remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "connector identity does not match the enrolled workspace")
	}
	return workspace, "", nil
}

func readFrame(ctx context.Context, ws *websocket.Conn, timeout time.Duration) (websocket.MessageType, []byte, error) {
	readCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return ws.Read(readCtx)
}

func closeWithProtocolError(ws *websocket.Conn, err error) {
	code := remoteconnector.ErrorCode(err)
	message := ""
	if protocolErr := asProtocolError(err); protocolErr != nil {
		message = protocolErr.Message
	}
	payload, _ := json.Marshal(remoteconnector.Message{
		Type:  remoteconnector.MessageError,
		Error: &remoteconnector.Error{Code: code, Message: message},
	})
	writeCtx, cancel := context.WithTimeout(context.Background(), connectWriteTimeout)
	_ = ws.Write(writeCtx, websocket.MessageText, payload)
	cancel()
	status := websocket.StatusPolicyViolation
	if code == remoteconnector.CodeInternal {
		status = websocket.StatusInternalError
	}
	_ = ws.Close(status, code)
}

func sanitizeDisplay(primary, fallback string) string {
	if value := strings.TrimSpace(primary); value != "" {
		return value
	}
	return strings.TrimSpace(fallback)
}

func newSessionID() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return "ss-000000000000000000"
	}
	return "ss-" + hex.EncodeToString(buffer)
}
