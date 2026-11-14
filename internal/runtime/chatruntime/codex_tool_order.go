package chatruntime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

const (
	maxCodexToolOrderEvents = 256
	maxCodexToolOrderBytes  = 16 << 20
	maxCodexToolOrderCalls  = 8192
)

// CodexToolOrder 协调 rawResponseItem 与 typed lifecycle 事件的发布顺序，保证工具卡与正文不乱序。
type CodexToolOrder struct {
	mu                 sync.Mutex
	drainMu            sync.Mutex
	pendingEvents      int
	pendingBytes       int
	failure            error
	calls              map[string]*codexOrderedCall
	order              []string
	cursor             int
	aliases            map[string]any // *codexOrderedCall | struct{} (ambiguous)
	outputsBeforeCalls map[string]struct{}
	nextSlot           int
}

type codexOrderedCall struct {
	slot       string
	primary    string
	sourceIDs  map[string]struct{}
	aliases    []string
	events     []codexQueuedToolEvent
	flush      bool
	outputSeen bool
	ambiguous  bool
	released   bool
}

type codexQueuedToolEvent struct {
	fn    func() error
	bytes int
}

var codexAmbiguousSentinel = struct{}{}

// NewCodexToolOrder 构造单轮工具顺序协调器。
func NewCodexToolOrder() *CodexToolOrder {
	return &CodexToolOrder{
		calls:              make(map[string]*codexOrderedCall),
		aliases:            make(map[string]any),
		outputsBeforeCalls: make(map[string]struct{}),
	}
}

// ObserveRaw 记录 rawResponseItem 中的工具调用或结果并推进可释放槽位。
func (o *CodexToolOrder) ObserveRaw(msg CodexJSONRPCMessage) error {
	if msg.Method != "rawResponseItem/completed" {
		return nil
	}
	item, _ := msg.Params["item"].(map[string]any)
	if item == nil {
		return nil
	}
	stage, aliases, sourceID := codexRawToolIdentity(item)
	if len(aliases) == 0 {
		return nil
	}
	o.drainMu.Lock()
	defer o.drainMu.Unlock()
	o.mu.Lock()
	if o.failure != nil {
		err := o.failure
		o.mu.Unlock()
		return err
	}
	if len(o.calls) >= maxCodexToolOrderCalls || len(o.outputsBeforeCalls) >= maxCodexToolOrderCalls {
		o.failure = NewError("codex_tool_order_capacity", http.StatusServiceUnavailable, nil)
		o.mu.Unlock()
		return o.runWrites(nil)
	}
	if stage == "call" {
		o.registerLocked(aliases, sourceID)
	} else if stage == "output" {
		o.noteOutputLocked(aliases)
	}
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	return o.runWrites(writes)
}

// DispatchOrdered preserves the legacy constructor port; real mapped events pass a byte cost.
func (o *CodexToolOrder) DispatchOrdered(callID string, fn func() error) error {
	return o.dispatch(callID, 1, fn)
}

func (o *CodexToolOrder) dispatch(callID string, bytes int, fn func() error) error {
	if fn == nil {
		return nil
	}
	o.drainMu.Lock()
	defer o.drainMu.Unlock()
	o.mu.Lock()
	if o.failure != nil {
		err := o.failure
		o.mu.Unlock()
		return err
	}
	call := o.resolveLocked(callID)
	if call == nil || call.released || call.ambiguous {
		o.mu.Unlock()
		return o.runWrites([]codexQueuedToolEvent{{fn: fn}})
	}
	if o.pendingEvents >= maxCodexToolOrderEvents || bytes > maxCodexToolOrderBytes-o.pendingBytes {
		o.failure = NewError("codex_tool_order_capacity", http.StatusServiceUnavailable, nil)
		o.mu.Unlock()
		return o.runWrites(nil)
	}
	o.pendingEvents++
	o.pendingBytes += bytes
	call.events = append(call.events, codexQueuedToolEvent{fn: fn, bytes: bytes})
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	// Pending earlier tools are released by future raw/typed events. Never wait for
	// those future events on the sole dispatch worker; all actual writes remain ordered.
	return o.runWrites(writes)
}

// Flush 强制释放全部剩余挂起工具槽位中的事件。
func (o *CodexToolOrder) Flush() error {
	o.drainMu.Lock()
	defer o.drainMu.Unlock()
	o.mu.Lock()
	for i := o.cursor; i < len(o.order); i++ {
		if call := o.calls[o.order[i]]; call != nil {
			call.flush = true
		}
	}
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	return o.runWrites(writes)
}

func (o *CodexToolOrder) registerLocked(aliases []string, sourceID string) {
	uniq := uniqueNonEmptyStrings(aliases)
	if len(uniq) == 0 {
		return
	}
	var prior *codexOrderedCall
	priorCount := 0
	for _, a := range uniq {
		if owner, ok := o.aliases[a].(*codexOrderedCall); ok && owner != nil {
			if prior == nil {
				prior = owner
				priorCount = 1
			} else if prior != owner {
				priorCount++
			}
		}
	}
	if priorCount != 1 {
		prior = nil
	}
	source := strings.TrimSpace(sourceID)
	samePrimary := prior != nil && prior.primary == uniq[0]
	sourceConflict := samePrimary && source != "" && len(prior.sourceIDs) > 0
	if sourceConflict {
		_, exists := prior.sourceIDs[source]
		sourceConflict = !exists
	}
	allFreeOrPrior := true
	if samePrimary && !sourceConflict {
		for _, a := range uniq {
			if cur, exists := o.aliases[a]; exists && cur != prior {
				allFreeOrPrior = false
				break
			}
		}
		if allFreeOrPrior {
			for _, a := range uniq {
				o.bindAliasLocked(a, prior)
			}
			if source != "" {
				prior.sourceIDs[source] = struct{}{}
			}
			return
		}
	}

	o.nextSlot++
	call := &codexOrderedCall{
		slot:       fmt.Sprintf("tool-%d", o.nextSlot),
		primary:    uniq[0],
		sourceIDs:  make(map[string]struct{}),
		aliases:    uniq,
		outputSeen: false,
	}
	if source != "" {
		call.sourceIDs[source] = struct{}{}
	}
	for _, a := range uniq {
		if _, seen := o.outputsBeforeCalls[a]; seen {
			call.outputSeen = true
		}
		delete(o.outputsBeforeCalls, a)
	}
	o.calls[call.slot] = call
	o.order = append(o.order, call.slot)
	for _, a := range uniq {
		o.bindAliasLocked(a, call)
	}
}

func (o *CodexToolOrder) noteOutputLocked(aliases []string) {
	for _, a := range uniqueNonEmptyStrings(aliases) {
		if owner, ok := o.aliases[a].(*codexOrderedCall); ok && owner != nil {
			owner.outputSeen = true
		} else if _, exists := o.aliases[a]; !exists {
			o.outputsBeforeCalls[a] = struct{}{}
		}
	}
}

func (o *CodexToolOrder) resolveLocked(alias string) *codexOrderedCall {
	clean := strings.TrimSpace(alias)
	if clean == "" {
		return nil
	}
	owner, ok := o.aliases[clean].(*codexOrderedCall)
	if !ok {
		return nil
	}
	return owner
}

func (o *CodexToolOrder) bindAliasLocked(alias string, call *codexOrderedCall) {
	existing, exists := o.aliases[alias]
	if !exists {
		o.aliases[alias] = call
		return
	}
	if existing == call || existing == codexAmbiguousSentinel {
		if existing == codexAmbiguousSentinel {
			call.ambiguous = true
		}
		return
	}
	if other, ok := existing.(*codexOrderedCall); ok && other != nil {
		other.ambiguous = true
	}
	call.ambiguous = true
	o.aliases[alias] = codexAmbiguousSentinel
}

func (o *CodexToolOrder) collectDrainLocked() []codexQueuedToolEvent {
	var writes []codexQueuedToolEvent
	for o.cursor < len(o.order) {
		call := o.calls[o.order[o.cursor]]
		if call == nil {
			o.cursor++
			continue
		}
		if !call.ambiguous && len(call.events) == 0 && !call.outputSeen && !call.flush {
			break
		}
		call.released = true
		o.cursor++
		for _, event := range call.events {
			o.pendingEvents--
			o.pendingBytes -= event.bytes
		}
		writes = append(writes, call.events...)
		call.events = nil
	}
	return writes
}

func (o *CodexToolOrder) runWrites(writes []codexQueuedToolEvent) error {
	for _, q := range writes {
		o.mu.Lock()
		failed := o.failure
		o.mu.Unlock()
		if failed != nil {
			break
		}
		if err := q.fn(); err != nil {
			o.mu.Lock()
			o.failure = err
			o.mu.Unlock()
			break
		}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.failure != nil {
		for _, call := range o.calls {
			clear(call.events)
			call.events = nil
		}
		o.pendingEvents = 0
		o.pendingBytes = 0
	}
	return o.failure
}

// mappedToolCost counts the actual payload we retain, not an arbitrary fixed event estimate.
func mappedToolCost(mapped CodexMappedMessage) (int, error) {
	raw, err := json.Marshal(mapped.Payload)
	return len(raw), err
}

func codexRawToolIdentity(item map[string]any) (string, []string, string) {
	t := asString(item["type"])
	sourceID := asString(item["id"])
	switch t {
	case "function_call", "custom_tool_call", "tool_search_call":
		callID := asString(item["call_id"])
		return "call", []string{callID, sourceID}, sourceID
	case "local_shell_call":
		return "call", []string{asString(item["call_id"]), sourceID}, sourceID
	case "web_search_call", "image_generation_call":
		return "call", []string{sourceID, asString(item["call_id"])}, sourceID
	case "function_call_output", "custom_tool_call_output", "tool_search_output":
		return "output", []string{asString(item["call_id"]), sourceID}, sourceID
	default:
		return "", nil, ""
	}
}

func uniqueNonEmptyStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		clean := strings.TrimSpace(s)
		if clean == "" {
			continue
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
	}
	return out
}
