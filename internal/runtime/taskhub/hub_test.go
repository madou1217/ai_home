package taskhub

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
)

func TestListActiveAggregatesAndSortsAndDeduplicates(t *testing.T) {
	hub := NewHub()
	hub.RegisterSource("a", func() []Task {
		return []Task{
			{"id": "job-2", "status": "running", "createdAt": int64(200)},
			{"id": "job-done", "status": "succeeded", "createdAt": int64(50)},
		}
	})
	hub.RegisterSource("b", func() []Task {
		return []Task{
			{"id": "job-1", "status": "queued", "createdAt": int64(100)},
			{"id": "job-2", "status": "running", "createdAt": int64(200)},
			{"status": "running", "createdAt": int64(1)},
		}
	})

	active := hub.ListActive()
	if len(active) != 2 {
		t.Fatalf("len(active) = %d, want 2 (%+v)", len(active), active)
	}
	if active[0]["id"] != "job-1" || active[1]["id"] != "job-2" {
		t.Fatalf("order mismatch: %+v", active)
	}
}

func TestSubscribeReceivesPublishedActivityJob(t *testing.T) {
	hub := NewHub()
	events, cancel := hub.Subscribe()
	defer cancel()

	cb := AccountActivityChangedHandler(hub)
	jm := accountactivity.NewJobManager(time.Now, cb)
	unregister := AttachAccountActivityJobs(hub, jm)
	defer unregister()

	cb(accountactivity.JobView{ID: "act-1", Status: accountactivity.JobRunning, CreatedAt: 100})
	select {
	case ev := <-events:
		if ev.Type != "task" || ev.Task["id"] != "act-1" || ev.Task["source"] != "account-activity" {
			t.Fatalf("unexpected event: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for published task")
	}
}
