package responseswebsocket

import (
	"context"
	"encoding/json"
	"sort"
	"sync"

	"github.com/coder/websocket"
)

const maxStatelessContextBytes = 32 * 1024 * 1024

// statelessConnection keeps one completed turn on this connection. API-key
// relays may accept Responses WebSockets without retaining store:false response
// IDs. Expand known incremental requests before forwarding them so tool results
// arrive with their calls. This is transient wire state, not a conversation store.
type statelessConnection struct {
	Connection
	mu            sync.Mutex
	lastID        string
	lastInput     []json.RawMessage
	pendingInput  []json.RawMessage
	pendingValid  bool
	pendingOutput map[int]json.RawMessage
	outputBytes   int
}

func (connection *statelessConnection) Write(ctx context.Context, kind websocket.MessageType, payload []byte) error {
	if kind == websocket.MessageText {
		payload = connection.prepare(payload)
	}
	return connection.Connection.Write(ctx, kind, payload)
}

func (connection *statelessConnection) Read(ctx context.Context) (websocket.MessageType, []byte, error) {
	kind, payload, err := connection.Connection.Read(ctx)
	if err == nil && kind == websocket.MessageText {
		connection.observe(payload)
	}
	return kind, payload, err
}

func (connection *statelessConnection) prepare(payload []byte) []byte {
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil || string(frame["type"]) != `"response.create"` {
		return payload
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.pendingInput, connection.pendingValid = nil, false
	connection.pendingOutput, connection.outputBytes = nil, 0
	// Stored responses keep the upstream's own continuation semantics.
	if string(frame["store"]) != "false" {
		return payload
	}
	input, ok := statelessInput(frame["input"])
	if !ok {
		return payload
	}
	var previous string
	_ = json.Unmarshal(frame["previous_response_id"], &previous)
	if previous != "" {
		if previous != connection.lastID || connection.lastInput == nil {
			// Never invent context for an unknown ID or an earlier connection.
			return payload
		}
		expanded := make([]json.RawMessage, 0, len(connection.lastInput)+len(input))
		input = append(append(expanded, connection.lastInput...), input...)
		encoded, err := json.Marshal(input)
		if err != nil || len(encoded) > maxStatelessContextBytes {
			return payload
		}
		frame["input"] = encoded
		delete(frame, "previous_response_id")
		prepared, err := json.Marshal(frame)
		if err != nil || len(prepared) > maxStatelessContextBytes {
			return payload
		}
		payload = prepared
	}
	if statelessInputSize(input) <= maxStatelessContextBytes {
		connection.pendingInput, connection.pendingValid = input, true
	}
	return payload
}

func (connection *statelessConnection) observe(payload []byte) {
	var event struct {
		Type        string          `json:"type"`
		OutputIndex int             `json:"output_index"`
		Item        json.RawMessage `json:"item"`
		Response    struct {
			ID     string            `json:"id"`
			Output []json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return
	}
	switch event.Type {
	case "response.output_item.done", "response.completed", "response.failed", "response.incomplete", "error":
	default:
		return
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if event.Type == "response.output_item.done" {
		if !connection.pendingValid || event.OutputIndex < 0 || len(event.Item) == 0 || string(event.Item) == "null" {
			return
		}
		if connection.pendingOutput == nil {
			connection.pendingOutput = make(map[int]json.RawMessage)
		}
		connection.outputBytes += len(event.Item) - len(connection.pendingOutput[event.OutputIndex])
		if connection.outputBytes > maxStatelessContextBytes {
			connection.pendingOutput, connection.pendingValid = nil, false
			return
		}
		connection.pendingOutput[event.OutputIndex] = event.Item
		return
	}
	defer func() {
		connection.pendingInput, connection.pendingValid = nil, false
		connection.pendingOutput, connection.outputBytes = nil, 0
	}()
	if event.Type != "response.completed" {
		return
	}
	connection.lastID, connection.lastInput = "", nil
	if !connection.pendingValid || event.Response.ID == "" {
		return
	}
	// Codex's Responses Lite stream ends with output:[] even after emitting
	// completed tool items. Those items are the authoritative full outputs.
	if len(event.Response.Output) == 0 && len(connection.pendingOutput) > 0 {
		indices := make([]int, 0, len(connection.pendingOutput))
		for index := range connection.pendingOutput {
			indices = append(indices, index)
		}
		sort.Ints(indices)
		for _, index := range indices {
			event.Response.Output = append(event.Response.Output, connection.pendingOutput[index])
		}
	}
	if statelessInputSize(connection.pendingInput)+statelessInputSize(event.Response.Output) > maxStatelessContextBytes {
		return
	}
	connection.lastID = event.Response.ID
	connection.lastInput = append(connection.pendingInput, event.Response.Output...)
}

func statelessInput(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return []json.RawMessage{}, true
	}
	var input []json.RawMessage
	if json.Unmarshal(raw, &input) == nil {
		return input, true
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return nil, false
	}
	item, _ := json.Marshal(map[string]string{"role": "user", "content": text})
	return []json.RawMessage{item}, true
}

func statelessInputSize(input []json.RawMessage) int {
	size := 2
	for _, item := range input {
		size += len(item) + 1
	}
	return size
}
