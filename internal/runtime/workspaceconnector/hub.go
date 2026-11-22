package workspaceconnector

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	DefaultCallTimeout = 30 * time.Second
	connectorWriteWait = 10 * time.Second
	maxPendingCalls    = 64
	// maxCallTimeout bounds any single RPC wait. run_command is the only
	// operation that needs more than the default file-operation budget.
	maxCallTimeout = remoteconnector.MaxCommandTimeout + 30*time.Second
)

var ErrHubClosed = errors.New("workspace connector hub is closed")

// ConnectionInfo is the identity a Server handler attaches after a successful
// hello. RootLabel is display-only and never used for path resolution.
type ConnectionInfo struct {
	WorkspaceID  string
	ConnectorID  string
	SessionID    string
	RootLabel    string
	Platform     string
	Capabilities remoteconnector.Capabilities
}

type callResult struct {
	message remoteconnector.Message
	err     error
}

// Connection is one live connector session. All writes are serialized because
// heartbeat acknowledgements and RPC responses share the same socket.
type Connection struct {
	ws           *websocket.Conn
	info         ConnectionInfo
	connectedAt  time.Time
	generation   uint64
	lastSeenUnix atomic.Int64

	writeMu   sync.Mutex
	pendingMu sync.Mutex
	pending   map[string]chan callResult
	closed    atomic.Bool
	closedCh  chan struct{}
	closeOnce sync.Once
}

func NewConnection(ws *websocket.Conn, info ConnectionInfo) *Connection {
	connection := &Connection{
		ws:          ws,
		info:        info,
		connectedAt: time.Now(),
		pending:     make(map[string]chan callResult),
		closedCh:    make(chan struct{}),
	}
	connection.Touch()
	return connection
}

func (connection *Connection) Info() ConnectionInfo { return connection.info }

func (connection *Connection) ConnectedAt() time.Time { return connection.connectedAt }

func (connection *Connection) Touch() {
	connection.lastSeenUnix.Store(time.Now().UnixMilli())
}

func (connection *Connection) LastSeen() time.Time {
	return time.UnixMilli(connection.lastSeenUnix.Load())
}

func (connection *Connection) Closed() <-chan struct{} { return connection.closedCh }

func (connection *Connection) Active() bool { return connection != nil && !connection.closed.Load() }

// Send serializes one protocol message. A failed write closes the connection so
// all pending calls fail instead of waiting for their individual timeouts.
func (connection *Connection) Send(ctx context.Context, message remoteconnector.Message) error {
	if connection == nil || connection.closed.Load() {
		return remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "connector is disconnected")
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "cannot encode connector message")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	connection.writeMu.Lock()
	defer connection.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, connectorWriteWait)
	defer cancel()
	if err := connection.ws.Write(writeCtx, websocket.MessageText, encoded); err != nil {
		connection.Close("write_failed")
		return remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "connector write failed")
	}
	return nil
}

// Deliver routes a connector response to the waiting caller.
func (connection *Connection) Deliver(message remoteconnector.Message) bool {
	if connection == nil || message.ID == "" {
		return false
	}
	connection.pendingMu.Lock()
	waiter, found := connection.pending[message.ID]
	if found {
		delete(connection.pending, message.ID)
	}
	connection.pendingMu.Unlock()
	if !found {
		return false
	}
	waiter <- callResult{message: message}
	return true
}

// Close tears down the socket and fails every in-flight call. It is safe to
// call from any goroutine and on an already closed connection.
func (connection *Connection) Close(reason string) {
	if connection == nil {
		return
	}
	connection.closeOnce.Do(func() {
		connection.closed.Store(true)
		close(connection.closedCh)
		connection.pendingMu.Lock()
		pending := connection.pending
		connection.pending = make(map[string]chan callResult)
		connection.pendingMu.Unlock()
		for _, waiter := range pending {
			waiter <- callResult{err: remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "connector session closed: "+reason)}
		}
		_ = connection.ws.CloseNow()
	})
}

// Call sends one capability-scoped RPC and waits for its bounded response.
func (connection *Connection) Call(ctx context.Context, operation string, payload any) (json.RawMessage, error) {
	return connection.CallWithTimeout(ctx, operation, payload, DefaultCallTimeout)
}

// CallWithTimeout is Call with an explicit wait budget. The budget is clamped
// to maxCallTimeout; zero falls back to DefaultCallTimeout.
func (connection *Connection) CallWithTimeout(ctx context.Context, operation string, payload any, timeout time.Duration) (json.RawMessage, error) {
	if connection == nil || !connection.Active() {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceOffline, "workspace connector is offline")
	}
	if !remoteconnector.SupportsOperation(connection.info.Capabilities, operation) {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeCapabilityNotAllowed, "workspace connector does not grant "+operation)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "cannot encode operation payload")
	}
	requestID := newID("rq-")
	waiter := make(chan callResult, 1)
	connection.pendingMu.Lock()
	if len(connection.pending) >= maxPendingCalls {
		connection.pendingMu.Unlock()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceOffline, "too many pending workspace requests")
	}
	connection.pending[requestID] = waiter
	connection.pendingMu.Unlock()

	removeWaiter := func() {
		connection.pendingMu.Lock()
		delete(connection.pending, requestID)
		connection.pendingMu.Unlock()
	}
	if err := connection.Send(ctx, remoteconnector.Message{
		Type:      remoteconnector.MessageRequest,
		ID:        requestID,
		Operation: operation,
		Payload:   encoded,
	}); err != nil {
		removeWaiter()
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if timeout <= 0 {
		timeout = DefaultCallTimeout
	}
	if timeout > maxCallTimeout {
		timeout = maxCallTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-waiter:
		if result.err != nil {
			return nil, result.err
		}
		if result.message.Error != nil {
			return nil, remoteconnector.NewProtocolError(result.message.Error.Code, result.message.Error.Message)
		}
		return result.message.Payload, nil
	case <-ctx.Done():
		removeWaiter()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeRequestTimeout, "workspace request was cancelled")
	case <-timer.C:
		removeWaiter()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeRequestTimeout, "workspace request timed out")
	case <-connection.closedCh:
		removeWaiter()
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceOffline, "workspace connector is offline")
	}
}

// LiveStatus is the in-memory liveness view merged with the durable record by
// the management API. It never includes a token.
type LiveStatus struct {
	Online       bool
	SessionID    string
	ConnectedAt  int64
	LastSeenAt   int64
	RootLabel    string
	Platform     string
	Capabilities remoteconnector.Capabilities
}

type Hub struct {
	mu          sync.Mutex
	connections map[string]*Connection
	generation  uint64
	closed      bool
}

func NewHub() *Hub {
	return &Hub{connections: make(map[string]*Connection)}
}

// Attach makes connection the current session for its workspace and closes any
// previous session. Generation fencing ensures the old handler cannot detach
// the replacement when its read loop exits.
func (hub *Hub) Attach(connection *Connection) (uint64, error) {
	if hub == nil || connection == nil {
		return 0, errors.New("workspace connector hub is invalid")
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return 0, ErrHubClosed
	}
	hub.generation++
	connection.generation = hub.generation
	previous := hub.connections[connection.info.WorkspaceID]
	hub.connections[connection.info.WorkspaceID] = connection
	if previous != nil && previous != connection {
		previous.Close("superseded")
	}
	return connection.generation, nil
}

func (hub *Hub) Detach(workspaceID string, generation uint64) {
	if hub == nil {
		return
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	current := hub.connections[workspaceID]
	if current != nil && current.generation == generation {
		delete(hub.connections, workspaceID)
	}
}

func (hub *Hub) connection(workspaceID string) *Connection {
	if hub == nil {
		return nil
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return hub.connections[workspaceID]
}

func (hub *Hub) Online(workspaceID string) bool {
	connection := hub.connection(workspaceID)
	return connection != nil && connection.Active()
}

func (hub *Hub) Status(workspaceID string) (LiveStatus, bool) {
	connection := hub.connection(workspaceID)
	if connection == nil || !connection.Active() {
		return LiveStatus{}, false
	}
	return LiveStatus{
		Online:       true,
		SessionID:    connection.info.SessionID,
		ConnectedAt:  connection.connectedAt.UnixMilli(),
		LastSeenAt:   connection.LastSeen().UnixMilli(),
		RootLabel:    connection.info.RootLabel,
		Platform:     connection.info.Platform,
		Capabilities: connection.info.Capabilities,
	}, true
}

func (hub *Hub) Call(ctx context.Context, workspaceID, operation string, payload any) (json.RawMessage, error) {
	return hub.CallWithTimeout(ctx, workspaceID, operation, payload, CallTimeoutFor(operation, payload))
}

// CallTimeoutFor derives the RPC wait budget from the operation. Only
// run_command carries its own bounded timeout; everything else uses the file
// operation budget. Both the tool endpoint and the raw RPC endpoint go through
// this function so they cannot drift.
func CallTimeoutFor(operation string, payload any) time.Duration {
	if operation != remoteconnector.OperationRunCommand {
		return DefaultCallTimeout
	}
	var request remoteconnector.RunCommandRequest
	if payload != nil {
		if encoded, err := json.Marshal(payload); err == nil {
			_ = json.Unmarshal(encoded, &request)
		}
	}
	return remoteconnector.CommandTimeout(request.TimeoutMS) + 15*time.Second
}

// CallWithTimeout routes one RPC with an explicit wait budget.
func (hub *Hub) CallWithTimeout(ctx context.Context, workspaceID, operation string, payload any, timeout time.Duration) (json.RawMessage, error) {
	connection := hub.connection(workspaceID)
	if connection == nil || !connection.Active() {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceOffline, "workspace connector is offline")
	}
	return connection.CallWithTimeout(ctx, operation, payload, timeout)
}

// Disconnect closes one live session without revoking its enrollment.
func (hub *Hub) Disconnect(workspaceID, reason string) {
	hub.disconnect(workspaceID, reason, nil)
}

// DisconnectWithError tells the connector why it is being closed before the
// socket goes away. Revocation uses this so the CLI stops immediately instead
// of retrying the same token.
func (hub *Hub) DisconnectWithError(workspaceID, reason, code, message string) {
	hub.disconnect(workspaceID, reason, &remoteconnector.Error{Code: code, Message: message})
}

func (hub *Hub) disconnect(workspaceID, reason string, protocolErr *remoteconnector.Error) {
	connection := hub.connection(workspaceID)
	if connection == nil {
		return
	}
	if protocolErr != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = connection.Send(ctx, remoteconnector.Message{Type: remoteconnector.MessageError, Error: protocolErr})
		cancel()
	}
	connection.Close(reason)
	hub.mu.Lock()
	if hub.connections[workspaceID] == connection {
		delete(hub.connections, workspaceID)
	}
	hub.mu.Unlock()
}

// Close terminates every connection and rejects future attaches.
func (hub *Hub) Close() {
	if hub == nil {
		return
	}
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.closed = true
	connections := hub.connections
	hub.connections = make(map[string]*Connection)
	hub.mu.Unlock()
	for _, connection := range connections {
		connection.Close("server_shutdown")
	}
}
