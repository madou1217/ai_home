package codexappserverapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"strings"
	"sync"
	"time"
)

const (
	MaxChunkAssemblyBytes = 4 * 1024 * 1024
	maxChunkStreams       = 16
	maxChunkSegments      = 4096
	maxChunkRetainedBytes = 8 * 1024 * 1024
	chunkLifetime         = 30 * time.Second
)

type chunkKey struct{ direction, kind, client, stream, sequence string }
type chunkAssemblyEntry struct {
	parts                     [][]byte
	received, bytes, declared int
	expires                   time.Time
}

// RemoteChunkAssembler observes tracing only. Hard per-connection count, byte,
// segment and age limits prevent diagnostic traffic from retaining unbounded
// payloads. Actual forwarding never depends on successful assembly.
type RemoteChunkAssembler struct {
	mu         sync.Mutex
	chunks     map[chunkKey]*chunkAssemblyEntry
	retained   int
	timer      *time.Timer
	closed     bool
	writeTrace func(map[string]any)
}

func NewRemoteChunkAssembler(writeTrace func(map[string]any)) *RemoteChunkAssembler {
	return &RemoteChunkAssembler{chunks: make(map[chunkKey]*chunkAssemblyEntry), writeTrace: writeTrace}
}

func (assembler *RemoteChunkAssembler) Close() {
	assembler.mu.Lock()
	assembler.closed = true
	if assembler.timer != nil {
		assembler.timer.Stop()
		assembler.timer = nil
	}
	clear(assembler.chunks)
	assembler.retained = 0
	assembler.mu.Unlock()
}

func chunkInteger(raw any, maximum int) (int, bool) {
	value, ok := raw.(float64)
	return int(value), ok && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= float64(maximum) && math.Trunc(value) == value
}

func (assembler *RemoteChunkAssembler) Accept(envelope map[string]any, direction string) {
	if assembler == nil || assembler.writeTrace == nil || envelope == nil {
		return
	}
	kind, _ := envelope["type"].(string)
	if kind != "client_message_chunk" && kind != "server_message_chunk" {
		return
	}
	count, countOK := chunkInteger(envelope["segment_count"], maxChunkSegments)
	id, idOK := chunkInteger(envelope["segment_id"], maxChunkSegments-1)
	declared, sizeOK := chunkInteger(envelope["message_size_bytes"], MaxChunkAssemblyBytes)
	if _, exists := envelope["message_size_bytes"]; !exists {
		sizeOK = true
	}
	if !countOK || !idOK || !sizeOK || count == 0 || id >= count {
		return
	}
	encoded, _ := envelope["message_chunk_base64"].(string)
	if encoded == "" || len(encoded) > base64.StdEncoding.EncodedLen(MaxChunkAssemblyBytes) {
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) > MaxChunkAssemblyBytes {
		return
	}
	client, _ := envelope["client_id"].(string)
	stream, _ := envelope["stream_id"].(string)
	sequence, err := json.Marshal(envelope["seq_id"])
	if err != nil || len(client) > 4096 || len(stream) > 4096 || len(sequence) > 4096 {
		return
	}
	key := chunkKey{direction, kind, client, stream, string(sequence)}
	now := time.Now()
	assembler.mu.Lock()
	if assembler.closed {
		assembler.mu.Unlock()
		return
	}
	drop := func(k chunkKey) {
		if old := assembler.chunks[k]; old != nil {
			assembler.retained -= old.bytes
			delete(assembler.chunks, k)
		}
	}
	for k, entry := range assembler.chunks {
		if !now.Before(entry.expires) {
			drop(k)
		}
	}
	entry := assembler.chunks[key]
	if entry == nil {
		if len(assembler.chunks) >= maxChunkStreams {
			assembler.mu.Unlock()
			return
		}
		entry = &chunkAssemblyEntry{parts: make([][]byte, count), declared: declared, expires: now.Add(chunkLifetime)}
		assembler.chunks[key] = entry
		if assembler.timer == nil {
			assembler.timer = time.AfterFunc(chunkLifetime, assembler.expire)
		}
	}
	if len(entry.parts) != count || entry.declared != declared {
		drop(key)
		assembler.mu.Unlock()
		return
	}
	if old := entry.parts[id]; old != nil {
		if !bytes.Equal(old, decoded) {
			drop(key)
		}
		assembler.mu.Unlock()
		return
	}
	if entry.bytes+len(decoded) > MaxChunkAssemblyBytes || assembler.retained+len(decoded) > maxChunkRetainedBytes {
		drop(key)
		assembler.mu.Unlock()
		return
	}
	entry.parts[id] = decoded
	entry.bytes += len(decoded)
	entry.received++
	assembler.retained += len(decoded)
	if entry.received != count {
		assembler.mu.Unlock()
		return
	}
	drop(key)
	assembler.mu.Unlock()
	if declared > 0 && entry.bytes != declared {
		return
	}
	raw := make([]byte, 0, entry.bytes)
	for _, part := range entry.parts {
		raw = append(raw, part...)
	}
	var message map[string]any
	_ = json.Unmarshal(raw, &message)
	assembler.writeTrace(map[string]any{"direction": strings.TrimSpace(direction), "binary": false, "summary": map[string]any{
		"type": kind + "_reassembled", "clientId": client, "streamId": stream, "seqId": envelope["seq_id"], "segmentCount": count, "messageSizeBytes": declared, "message": SummarizeJSONRPCMessage(message),
	}})
}

// expire releases incomplete messages even when the WebSocket stays idle.
func (assembler *RemoteChunkAssembler) expire() {
	assembler.mu.Lock()
	defer assembler.mu.Unlock()
	if assembler.closed {
		return
	}
	now := time.Now()
	var next time.Time
	for key, entry := range assembler.chunks {
		if !now.Before(entry.expires) {
			assembler.retained -= entry.bytes
			delete(assembler.chunks, key)
		} else if next.IsZero() || entry.expires.Before(next) {
			next = entry.expires
		}
	}
	if next.IsZero() {
		assembler.timer = nil
	} else {
		assembler.timer.Reset(time.Until(next))
	}
}
