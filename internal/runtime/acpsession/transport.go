package acpsession

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

// ConnectorTransport exposes an ACP stdio stream running on the Workspace
// Connector host. It deliberately uses the existing request/response channel;
// each Read is a bounded long-poll, each Write is one small request.
type ConnectorTransport struct {
	hub         *workspaceconnector.Hub
	workspaceID string
	sessionID   string
	ctx         context.Context

	mu        sync.Mutex
	buffer    []byte
	eof       bool
	errText   string
	closeOnce sync.Once
}

func StartConnectorTransport(ctx context.Context, hub *workspaceconnector.Hub, workspaceID string) (*ConnectorTransport, string, error) {
	if hub == nil {
		return nil, "", fmt.Errorf("workspace connector hub is unavailable")
	}
	raw, err := hub.CallWithTimeout(ctx, workspaceID, remoteconnector.OperationStartAgentACP,
		remoteconnector.StartAgentACPRequest{Cwd: "."}, 30*time.Second)
	if err != nil {
		return nil, "", err
	}
	var result remoteconnector.StartAgentACPResult
	if err := decodeJSON(raw, &result); err != nil {
		return nil, "", err
	}
	if result.SessionID == "" || result.Cwd == "" {
		return nil, "", fmt.Errorf("connector returned an invalid ACP session")
	}
	return &ConnectorTransport{hub: hub, workspaceID: workspaceID, sessionID: result.SessionID, ctx: context.Background()}, result.Cwd, nil
}

func (transport *ConnectorTransport) Reader() io.Reader { return transport }
func (transport *ConnectorTransport) Writer() io.Writer { return transport }

func (transport *ConnectorTransport) Read(p []byte) (int, error) {
	for {
		transport.mu.Lock()
		if len(transport.buffer) > 0 {
			n := copy(p, transport.buffer)
			transport.buffer = transport.buffer[n:]
			transport.mu.Unlock()
			return n, nil
		}
		if transport.eof {
			errText := transport.errText
			transport.mu.Unlock()
			if errText != "" {
				return 0, fmt.Errorf("connector ACP stream: %s", errText)
			}
			return 0, io.EOF
		}
		transport.mu.Unlock()
		if err := transport.readChunk(); err != nil {
			return 0, err
		}
	}
}

func (transport *ConnectorTransport) readChunk() error {
	raw, err := transport.hub.CallWithTimeout(transport.ctx, transport.workspaceID,
		remoteconnector.OperationReadAgentACP,
		remoteconnector.ReadAgentACPRequest{SessionID: transport.sessionID, WaitMS: 10000}, 15*time.Second)
	if err != nil {
		return err
	}
	var result remoteconnector.ReadAgentACPResult
	if err := decodeJSON(raw, &result); err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(result.Data)
	if err != nil {
		return fmt.Errorf("connector ACP stream returned invalid data")
	}
	transport.mu.Lock()
	if len(data) > 0 {
		transport.buffer = append(transport.buffer, data...)
	}
	if result.Error != "" {
		transport.errText = result.Error
	}
	if result.EOF {
		transport.eof = true
	}
	transport.mu.Unlock()
	return nil
}

func (transport *ConnectorTransport) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	_, err := transport.hub.CallWithTimeout(transport.ctx, transport.workspaceID,
		remoteconnector.OperationWriteAgentACP,
		remoteconnector.WriteAgentACPRequest{SessionID: transport.sessionID, Data: base64.StdEncoding.EncodeToString(p)}, 15*time.Second)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (transport *ConnectorTransport) Close() error {
	var closeErr error
	transport.closeOnce.Do(func() {
		_, closeErr = transport.hub.CallWithTimeout(context.Background(), transport.workspaceID,
			remoteconnector.OperationCloseAgentACP,
			remoteconnector.CloseAgentACPRequest{SessionID: transport.sessionID}, 10*time.Second)
	})
	return closeErr
}

func (transport *ConnectorTransport) Stderr() string {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.errText
}

func decodeJSON(raw []byte, target any) error {
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode connector ACP response: %w", err)
	}
	return nil
}
