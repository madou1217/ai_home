// Command verify-peer-priority exercises peer delivery ordering end to end.
//
// It creates a temporary peer store, starts a local HTTP endpoint that accepts
// WebUI chat commands, and runs the real peer.FlushPending loop against fake
// idle targets. No user peer session, database or network host is touched.
//
// Usage:
//
//	go run ./scripts/verify-peer-priority
//
// Exit codes: 0 = pass, 1 = failure.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

type arrivalLog struct {
	mu      sync.Mutex
	entries []string
}

func (log *arrivalLog) add(value string) {
	log.mu.Lock()
	defer log.mu.Unlock()
	log.entries = append(log.entries, value)
}

func (log *arrivalLog) snapshot() []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return append([]string(nil), log.entries...)
}

func main() {
	home, err := os.MkdirTemp("", "aih-peer-priority-e2e-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(home)

	arrivals := &arrivalLog{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.Contains(r.URL.Path, "/v0/webui/chat/sessions/") {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var payload struct {
			Payload struct {
				Content string `json:"content"`
			} `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		matched := "unknown"
		for _, token := range []string{
			"low-target", "high-target", "low-same", "high-same",
			"low-fairness", "high-fairness", "low-order", "normal-order", "high-order",
		} {
			if strings.Contains(payload.Payload.Content, token) {
				matched = token
				break
			}
		}
		arrivals.add(matched)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	store := peer.NewDispatchStore(home, peer.StoreOptions{})
	now := time.Now()
	from := peer.RecordParty{Channel: "test", Provider: "codebuddy", Name: "sender", Address: "sender"}
	target := func(name string) peer.RecordParty {
		return peer.RecordParty{
			Channel: "webui-chat", Provider: "codebuddy", Name: name,
			Address: name, SessionID: name,
		}
	}
	create := func(subject, targetName string, priority int) *peer.Record {
		rec, err := store.CreateMessage(peer.CreateMessageInput{
			From: from, To: target(targetName), Subject: subject, Body: subject,
			Priority: priority,
		})
		if err != nil {
			panic(err)
		}
		return rec
	}
	delivery := peer.DeliveryOptions{
		AIHomeDir:     home,
		ServerBaseURL: func() string { return server.URL },
		ManagementKey: func() string { return "test-management-key" },
		HTTPClient:    server.Client(),
		ProbeTarget: func(context.Context, peer.RecordParty) (string, error) {
			return "idle", nil
		},
		Now: func() time.Time { return now },
	}
	flush := func(limit int) {
		if _, err := peer.FlushPending(context.Background(), store, peer.FlushOptions{
			Delivery: delivery, Limit: limit, ExpireAge: 24 * time.Hour, Now: func() time.Time { return now },
		}); err != nil {
			panic(err)
		}
	}
	failures := 0
	check := func(name string, ok bool, detail string) {
		if ok {
			fmt.Printf("PASS %s %s\n", name, detail)
			return
		}
		failures++
		fmt.Printf("FAIL %s %s\n", name, detail)
	}

	// 1. Different targets, same fairness age: high priority arrives first.
	create("low-target", "target-low", peer.PriorityLow)
	create("high-target", "target-high", peer.PriorityHigh)
	flush(1)
	flush(1)
	got := arrivals.snapshot()
	check("cross-target priority", len(got) == 2 && got[0] == "high-target" && got[1] == "low-target", fmt.Sprintf("%v", got))

	// 2. Same target: the high-priority message is selected first.
	create("low-same", "target-same", peer.PriorityLow)
	create("high-same", "target-same", peer.PriorityHigh)
	flush(1)
	got = arrivals.snapshot()
	check("same-target priority", len(got) == 3 && got[2] == "high-same", fmt.Sprintf("%v", got))
	// A successful delivery puts the target in a short cooldown; wait it out so
	// the next low-priority message from the same target is eligible.
	time.Sleep(peer.TargetCooldown + 200*time.Millisecond)
	flush(1)
	got = arrivals.snapshot()
	check("same-target low follows", len(got) == 4 && got[3] == "low-same", fmt.Sprintf("%v", got))

	// 3. Fairness: an older target gets probed before a newer high-priority one.
	// target-high already delivered once, so its lastProbeAt is newer than target-low's.
	time.Sleep(peer.TargetCooldown + 200*time.Millisecond)
	create("low-fairness", "target-fair-low", peer.PriorityLow)
	create("high-fairness", "target-high", peer.PriorityHigh)
	flush(1)
	got = arrivals.snapshot()
	check("fairness before priority", len(got) == 5 && got[4] == "low-fairness", fmt.Sprintf("%v", got))

	// 4. Invalid priority is rejected by the store.
	if _, err := store.CreateMessage(peer.CreateMessageInput{
		From: from, To: target("target-bad"), Body: "bad", Priority: 9,
	}); err == nil {
		check("invalid priority", false, "accepted")
	} else {
		check("invalid priority", true, "")
	}

	// 5. Pending order is deterministic: high before normal before low.
	create("low-order", "target-order", peer.PriorityLow)
	create("normal-order", "target-order", peer.PriorityNormal)
	create("high-order", "target-order", peer.PriorityHigh)
	pending, err := store.ListPending()
	if err != nil {
		panic(err)
	}
	order := make([]string, 0, 3)
	for _, rec := range pending {
		if strings.HasSuffix(rec.Subject, "-order") {
			order = append(order, rec.Subject)
		}
	}
	check("pending order stable", len(order) == 3 && order[0] == "high-order" && order[1] == "normal-order" && order[2] == "low-order", fmt.Sprintf("%v", order))

	if failures > 0 {
		fmt.Printf("PEER_PRIORITY_FAILURES %d\n", failures)
		os.Exit(1)
	}
	fmt.Println("PEER_PRIORITY_FAILURES 0")
}
