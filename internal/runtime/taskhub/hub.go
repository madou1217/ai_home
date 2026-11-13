// Package taskhub 提供 WebUI 统一任务队列的聚合快照与实时 SSE 推送中心。
//
// 契约对齐 lib/server/webui-task-hub.js：
//   - RegisterSource 按源注册活跃任务快照函数（status 为 queued 或 running）；
//   - ListActive 按 createdAt 升序、id 字典序去重合并返回当前活跃任务；
//   - Publish 向全部 SSE 订阅者实时推送单条任务状态变更；
//   - Watch 建立推送通道并在建立时发送 connected / snapshot。
package taskhub

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

// Task 是统一任务队列里的通用任务视图，保留各源（environment / account-activity 等）的原始字段。
type Task map[string]any

// Event 是 /v1/management/webui/tasks/watch 推送的 SSE 事件帧。
type Event struct {
	Type  string `json:"type"`
	Tasks []Task `json:"tasks,omitempty"`
	Task  Task   `json:"task,omitempty"`
}

// SourceFunc 返回某个任务源当前的任务列表。
type SourceFunc func() []Task

type subscriber struct {
	events chan Event
	done   chan struct{}
	once   sync.Once
}

func (s *subscriber) closeDone() {
	s.once.Do(func() { close(s.done) })
}

// Hub 维护任务源注册表与 SSE 订阅者集合。
type Hub struct {
	mu          sync.RWMutex
	sources     map[string]SourceFunc
	subscribers map[*subscriber]struct{}
}

// NewHub 创建一个空的任务聚合中心。
func NewHub() *Hub {
	return &Hub{
		sources:     make(map[string]SourceFunc),
		subscribers: make(map[*subscriber]struct{}),
	}
}

// IsActiveStatus 判断任务状态是否仍处于排队或执行中。
func IsActiveStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "queued", "running":
		return true
	default:
		return false
	}
}

// RegisterSource 按 id 注册一个活跃任务快照源，并返回注销函数。
func (hub *Hub) RegisterSource(id string, list SourceFunc) func() {
	if hub == nil {
		return func() {}
	}
	sourceID := strings.TrimSpace(id)
	if sourceID == "" || list == nil {
		return func() {}
	}
	hub.mu.Lock()
	hub.sources[sourceID] = list
	hub.mu.Unlock()
	return func() {
		hub.mu.Lock()
		delete(hub.sources, sourceID)
		hub.mu.Unlock()
	}
}

// ListActive 聚合所有已注册源的 queued/running 任务，按 createdAt 升序、id 升序排列。
func (hub *Hub) ListActive() []Task {
	if hub == nil {
		return []Task{}
	}
	hub.mu.RLock()
	callbacks := make([]SourceFunc, 0, len(hub.sources))
	for _, fn := range hub.sources {
		callbacks = append(callbacks, fn)
	}
	hub.mu.RUnlock()

	byID := make(map[string]Task)
	for _, fn := range callbacks {
		for _, raw := range fn() {
			normalized := normalizeTask(raw)
			if normalized == nil {
				continue
			}
			if !IsActiveStatus(taskString(normalized, "status")) {
				continue
			}
			byID[taskString(normalized, "id")] = normalized
		}
	}

	result := make([]Task, 0, len(byID))
	for _, task := range byID {
		result = append(result, task)
	}
	sort.Slice(result, func(i, j int) bool {
		leftCreated := taskInt64(result[i], "createdAt")
		rightCreated := taskInt64(result[j], "createdAt")
		if leftCreated != rightCreated {
			return leftCreated < rightCreated
		}
		return taskString(result[i], "id") < taskString(result[j], "id")
	})
	return result
}

// Publish 向所有订阅者推送一条任务变更事件。
func (hub *Hub) Publish(task Task) {
	if hub == nil {
		return
	}
	normalized := normalizeTask(task)
	if normalized == nil {
		return
	}
	event := Event{Type: "task", Task: normalized}

	hub.mu.RLock()
	subs := make([]*subscriber, 0, len(hub.subscribers))
	for sub := range hub.subscribers {
		subs = append(subs, sub)
	}
	hub.mu.RUnlock()

	for _, sub := range subs {
		select {
		case <-sub.done:
			continue
		default:
		}
		select {
		case sub.events <- event:
		default:
			// 慢消费者不阻塞业务作业推进；下次 snapshot/事件会补齐状态。
		}
	}
}

// PublishTyped 将强类型作业结构体转为 Task（附带 source 标识）后广播。
func (hub *Hub) PublishTyped(source string, job any) {
	task, ok := structToTask(source, job)
	if !ok {
		return
	}
	hub.Publish(task)
}

// Subscribe 订阅任务中心事件流；调用者必须调用返回的 cancel 释放资源。
func (hub *Hub) Subscribe() (<-chan Event, func()) {
	sub := &subscriber{
		events: make(chan Event, 32),
		done:   make(chan struct{}),
	}
	hub.mu.Lock()
	hub.subscribers[sub] = struct{}{}
	hub.mu.Unlock()

	cancel := func() {
		hub.mu.Lock()
		delete(hub.subscribers, sub)
		hub.mu.Unlock()
		sub.closeDone()
	}
	return sub.events, cancel
}

// StructToTask 把任意 Go 结构体编码成 Task map 并附加 source 字段（未设置时）。
func StructToTask(source string, job any) (Task, bool) {
	return structToTask(source, job)
}

func structToTask(source string, job any) (Task, bool) {
	if job == nil {
		return nil, false
	}
	encoded, err := json.Marshal(job)
	if err != nil {
		return nil, false
	}
	var mapped Task
	if err := json.Unmarshal(encoded, &mapped); err != nil {
		return nil, false
	}
	normalized := normalizeTask(mapped)
	if normalized == nil {
		return nil, false
	}
	if src := strings.TrimSpace(source); src != "" && taskString(normalized, "source") == "" {
		normalized["source"] = src
	}
	return normalized, true
}

func normalizeTask(raw Task) Task {
	if len(raw) == 0 {
		return nil
	}
	id := taskString(raw, "id")
	if id == "" {
		return nil
	}
	copied := make(Task, len(raw))
	for k, v := range raw {
		copied[k] = v
	}
	copied["id"] = id
	return copied
}

func taskString(task Task, key string) string {
	v, ok := task[key]
	if !ok || v == nil {
		return ""
	}
	text, ok := v.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func taskInt64(task Task, key string) int64 {
	v, ok := task[key]
	if !ok || v == nil {
		return 0
	}
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		parsed, _ := n.Int64()
		return parsed
	default:
		return 0
	}
}
