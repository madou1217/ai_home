package codexappserverws

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

var ErrResumeTrackerFull = errors.New("resume_context_capacity_exceeded")
var ErrResumeRequestDuplicate = errors.New("resume_request_id_already_pending")

const maxResumeContexts = 512
const maxResumeContextBytes = 512 * 1024

type trackedResumeRequest struct{ threadID string }

// ResumeTracker owns a bounded set of in-flight response patches. Keys preserve
// the JSON-RPC ID type; numeric 1 and string "1" must never share a context.
type ResumeTracker struct {
	mu       sync.Mutex
	contexts map[string]trackedResumeRequest
	bytes    int
}

func NewResumeTracker() *ResumeTracker {
	return &ResumeTracker{contexts: make(map[string]trackedResumeRequest)}
}

func (tracker *ResumeTracker) Close() {
	tracker.mu.Lock()
	clear(tracker.contexts)
	tracker.bytes = 0
	tracker.mu.Unlock()
}

// RememberRequest retains the existing best-effort adapter contract. New
// transport owners use TryRememberRequest and explicitly reject saturation.
func (tracker *ResumeTracker) RememberRequest(raw []byte) bool {
	ok, _ := tracker.TryRememberRequest(raw)
	return ok
}

func (tracker *ResumeTracker) TryRememberRequest(raw []byte) (bool, error) {
	if tracker == nil {
		return false, nil
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimSpace(raw), &payload) != nil || payload == nil {
		return false, nil
	}
	var method string
	if json.Unmarshal(payload["method"], &method) != nil || method != "thread/resume" {
		return false, nil
	}
	id := resumeRequestKey(payload["id"])
	if id == "" {
		return false, nil
	}
	thread := extractRequestThreadID(payload["params"])
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if _, exists := tracker.contexts[id]; exists {
		return false, ErrResumeRequestDuplicate
	}
	if len(tracker.contexts) >= maxResumeContexts || tracker.bytes+len(id)+len(thread) > maxResumeContextBytes {
		return false, ErrResumeTrackerFull
	}
	tracker.contexts[id] = trackedResumeRequest{threadID: thread}
	tracker.bytes += len(id) + len(thread)
	return true, nil
}

func (tracker *ResumeTracker) PatchResponse(raw []byte) []byte {
	if tracker == nil {
		return raw
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimSpace(raw), &payload) != nil || payload == nil {
		return raw
	}
	if len(payload["method"]) != 0 || (len(payload["result"]) == 0 && len(payload["error"]) == 0) {
		return raw
	}
	id := resumeRequestKey(payload["id"])
	if id == "" {
		return raw
	}
	tracker.mu.Lock()
	context, found := tracker.contexts[id]
	if found {
		delete(tracker.contexts, id)
		tracker.bytes -= len(id) + len(context.threadID)
	}
	tracker.mu.Unlock()
	if !found {
		return raw
	}
	result := parseRawObjectOrNil(payload["result"])
	if result == nil {
		return raw
	}
	if _, exists := result["threadIds"]; exists {
		return raw
	}
	thread := strings.TrimSpace(context.threadID)
	if thread == "" {
		if object := parseRawObjectOrNil(result["thread"]); object != nil {
			thread = unmarshalTrimmedString(object["id"])
		}
	}
	if thread == "" {
		return raw
	}
	ids, err := marshalNoEscapeHTML([]string{thread})
	if err != nil {
		return raw
	}
	result["threadIds"] = ids
	payload["result"], err = marshalNoEscapeHTML(result)
	if err != nil {
		return raw
	}
	encoded, err := marshalNoEscapeHTML(payload)
	if err != nil {
		return raw
	}
	return encoded
}

func resumeRequestKey(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var value string
		if json.Unmarshal(trimmed, &value) != nil {
			return ""
		}
		return "s:" + value
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	if decoder.Decode(&number) != nil || number == "" {
		return ""
	}
	return "n:" + string(number)
}
