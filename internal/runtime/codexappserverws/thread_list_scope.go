package codexappserverws

import (
	"encoding/json"
	"errors"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
)

var ErrThreadListTrackerFull = errors.New("thread_list_context_capacity_exceeded")

const maxThreadListContexts = 512
const maxThreadListContextBytes = 512 * 1024

type threadListScope struct {
	cwd         string
	allProjects bool
}

// ThreadListScopeTracker enforces the caller's project on every response page.
// A remote server's own working directory is not the client's project. With no
// known client cwd, fail closed unless all projects was explicitly requested.
type ThreadListScopeTracker struct {
	mu     sync.Mutex
	scopes map[string]threadListScope
	bytes  int
}

func NewThreadListScopeTracker() *ThreadListScopeTracker {
	return &ThreadListScopeTracker{scopes: make(map[string]threadListScope)}
}

func (tracker *ThreadListScopeTracker) Close() {
	tracker.mu.Lock()
	clear(tracker.scopes)
	tracker.bytes = 0
	tracker.mu.Unlock()
}

func (tracker *ThreadListScopeTracker) Remember(raw []byte, opts RewriteOptions) {
	_ = tracker.TryRemember(raw, opts)
}

func (tracker *ThreadListScopeTracker) TryRemember(raw []byte, opts RewriteOptions) error {
	payload := parseRawObjectOrNil(raw)
	if extractTrimmedMethod(payload["method"]) != "thread/list" {
		return nil
	}
	id := resumeRequestKey(payload["id"])
	if id == "" {
		return nil
	}
	params := parseRawObjectOrEmpty(payload["params"])
	allProjects := opts.SkipInjectCwd || isJSONTrue(params["allProjects"])
	cwd := unmarshalTrimmedString(params["cwd"])
	if cwd == "" && !allProjects {
		cwd = opts.Cwd
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if _, exists := tracker.scopes[id]; exists {
		return ErrResumeRequestDuplicate
	}
	if len(tracker.scopes) >= maxThreadListContexts || tracker.bytes+len(id)+len(cwd) > maxThreadListContextBytes {
		return ErrThreadListTrackerFull
	}
	tracker.bytes += len(id) + len(cwd)
	tracker.scopes[id] = threadListScope{cwd: cwd, allProjects: allProjects}
	return nil
}

func (tracker *ThreadListScopeTracker) Patch(raw []byte) []byte {
	payload := parseRawObjectOrNil(raw)
	if len(payload["method"]) != 0 || (len(payload["result"]) == 0 && len(payload["error"]) == 0) {
		return raw
	}
	id := resumeRequestKey(payload["id"])
	tracker.mu.Lock()
	scope, found := tracker.scopes[id]
	if found {
		delete(tracker.scopes, id)
		tracker.bytes -= len(id) + len(scope.cwd)
	}
	tracker.mu.Unlock()
	if !found || (scope.cwd == "" && scope.allProjects) {
		return raw
	}
	result := parseRawObjectOrNil(payload["result"])
	var rows []json.RawMessage
	if result == nil || json.Unmarshal(result["data"], &rows) != nil {
		return raw
	}
	selected := make([]json.RawMessage, 0, len(rows))
	for _, row := range rows {
		thread := parseRawObjectOrNil(row)
		if sessionproject.MatchesCwd(unmarshalTrimmedString(thread["cwd"]), scope.cwd) {
			selected = append(selected, row)
		}
	}
	if len(selected) == len(rows) && scope.cwd != "" {
		return raw
	}
	result["data"], _ = marshalNoEscapeHTML(selected)
	if scope.cwd == "" {
		// No project context: do not invite pagination through the host history.
		result["nextCursor"] = json.RawMessage("null")
		if _, exists := result["backwardsCursor"]; exists {
			result["backwardsCursor"] = json.RawMessage("null")
		}
	}
	payload["result"], _ = marshalNoEscapeHTML(result)
	encoded, err := marshalNoEscapeHTML(payload)
	if err != nil {
		return raw
	}
	return encoded
}
