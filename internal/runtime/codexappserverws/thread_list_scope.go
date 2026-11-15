package codexappserverws

import (
	"encoding/json"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
)

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
}

func NewThreadListScopeTracker() *ThreadListScopeTracker {
	return &ThreadListScopeTracker{scopes: make(map[string]threadListScope)}
}

func (tracker *ThreadListScopeTracker) Remember(raw []byte, opts RewriteOptions) {
	payload := parseRawObjectOrNil(raw)
	if extractTrimmedMethod(payload["method"]) != "thread/list" {
		return
	}
	id := extractJSONRPCIDKey(payload)
	if id == "" {
		return
	}
	params := parseRawObjectOrEmpty(payload["params"])
	allProjects := opts.SkipInjectCwd || isJSONTrue(params["allProjects"])
	cwd := unmarshalTrimmedString(params["cwd"])
	if cwd == "" && !allProjects {
		cwd = opts.Cwd
	}
	tracker.mu.Lock()
	tracker.scopes[id] = threadListScope{cwd: cwd, allProjects: allProjects}
	tracker.mu.Unlock()
}

func (tracker *ThreadListScopeTracker) Patch(raw []byte) []byte {
	payload := parseRawObjectOrNil(raw)
	id := extractJSONRPCIDKey(payload)
	tracker.mu.Lock()
	scope, found := tracker.scopes[id]
	delete(tracker.scopes, id)
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
