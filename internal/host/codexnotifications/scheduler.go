package codexnotifications

import (
	"container/heap"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

const maxLiveThreads = 2048

type pending struct {
	threadID string
	active   bool
	due      time.Time
	index    int
}
type pendingHeap []*pending

func (h pendingHeap) Len() int           { return len(h) }
func (h pendingHeap) Less(i, j int) bool { return h[i].due.Before(h[j].due) }
func (h pendingHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i]; h[i].index = i; h[j].index = j }
func (h *pendingHeap) Push(value any) {
	entry := value.(*pending)
	entry.index = len(*h)
	*h = append(*h, entry)
}
func (h *pendingHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	old[len(old)-1] = nil
	*h = old[:len(old)-1]
	last.index = -1
	return last
}

type scheduler struct {
	live     map[string]bool
	pending  map[string]*pending
	queue    pendingHeap
	debounce time.Duration
}

func newScheduler(debounce time.Duration) *scheduler {
	return &scheduler{live: make(map[string]bool), pending: make(map[string]*pending), debounce: debounce}
}
func (scheduler *scheduler) add(id string) error {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 4096 {
		return errors.New("notification_thread_invalid")
	}
	if !scheduler.live[id] && len(scheduler.live) >= maxLiveThreads {
		return errors.New("notification_thread_capacity_exceeded")
	}
	scheduler.live[id] = true
	return nil
}
func (scheduler *scheduler) remove(id string) {
	delete(scheduler.live, id)
	if entry := scheduler.pending[id]; entry != nil {
		heap.Remove(&scheduler.queue, entry.index)
		delete(scheduler.pending, id)
	}
}
func (scheduler *scheduler) schedule(event codexhooks.NotificationEvent, now time.Time) {
	if !scheduler.live[event.SessionID] {
		return
	}
	// Retain only identity and a status bit, not arbitrary payload strings.
	active := event.Type == "session:turn-started"
	if entry := scheduler.pending[event.SessionID]; entry != nil {
		entry.active = active
		entry.due = now.Add(scheduler.debounce)
		heap.Fix(&scheduler.queue, entry.index)
		return
	}
	entry := &pending{threadID: event.SessionID, active: active, due: now.Add(scheduler.debounce)}
	scheduler.pending[event.SessionID] = entry
	heap.Push(&scheduler.queue, entry)
}

// nextDue serializes one status at a time so a large ready set does not create
// a second burst-sized collection on top of the bounded output channel.
func (scheduler *scheduler) nextDue(now time.Time) []byte {
	for len(scheduler.queue) > 0 && !now.Before(scheduler.queue[0].due) {
		entry := heap.Pop(&scheduler.queue).(*pending)
		delete(scheduler.pending, entry.threadID)
		if !scheduler.live[entry.threadID] {
			continue
		}
		status := map[string]any{"type": "notLoaded"}
		if entry.active {
			status = map[string]any{"type": "active", "activeFlags": []string{}}
		}
		raw, _ := json.Marshal(map[string]any{"method": "thread/status/changed", "params": map[string]any{"threadId": entry.threadID, "status": status}})
		return append(raw, '\n')
	}
	return nil
}
