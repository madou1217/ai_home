package sessionactivity

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

type recordedOutcome struct {
	accountRef string
	outcome    string
	atMS       int64
}

func TestOutcomePollerAppStateKVIdempotencyAndTrim(t *testing.T) {
	aiHome := t.TempDir()
	nowMS := int64(1_700_000_000_000)

	var recorded []recordedOutcome
	batch := 1
	poller := NewOutcomePoller(OutcomePollerOptions{
		AIHomeDir: aiHome,
		StoreKey:  "test-outcomes",
		Now:       func() time.Time { return time.UnixMilli(nowMS) },
		RecordOutcome: func(_ context.Context, ref, outcome string, atMS int64) bool {
			recorded = append(recorded, recordedOutcome{accountRef: ref, outcome: outcome, atMS: atMS})
			return true
		},
		Collect: func(context.Context) []OutcomeObservation {
			if batch == 1 {
				return []OutcomeObservation{
					{Key: "k1", Marker: "completed:100", Outcome: "success", AtMS: 100, AccountRef: "acct_11111111111111111111"},
					{Key: "k_unattr", Marker: "completed:200", Outcome: "success", AtMS: 200, AccountRef: ""},
					{Key: "k_skip", Marker: "cancelled:300", Outcome: "", AtMS: 300, AccountRef: "acct_11111111111111111111"},
				}
			}
			// Second batch replays k1 (deduped) + updates k_unattr once attributed + updates k1 marker
			return []OutcomeObservation{
				{Key: "k1", Marker: "completed:100", Outcome: "success", AtMS: 100, AccountRef: "acct_11111111111111111111"},
				{Key: "k_unattr", Marker: "completed:200", Outcome: "success", AtMS: 200, AccountRef: "acct_22222222222222222222"},
			}
		},
	})

	s1 := poller.Tick(context.Background())
	if s1.Recorded != 1 || s1.Unattributed != 1 || s1.Skipped != 1 {
		t.Fatalf("unexpected first tick summary: %+v", s1)
	}
	batch = 2
	s2 := poller.Tick(context.Background())
	if s2.Recorded != 1 || s2.Unattributed != 0 {
		t.Fatalf("unexpected second tick summary: %+v", s2)
	}
	if len(recorded) != 2 || recorded[1].accountRef != "acct_22222222222222222222" {
		t.Fatalf("unexpected recorded slice: %+v", recorded)
	}

	// Verify cursor persisted across fresh OutcomePoller instance backed by same app-state.db
	poller2 := NewOutcomePoller(OutcomePollerOptions{
		AIHomeDir: aiHome,
		StoreKey:  "test-outcomes",
		RecordOutcome: func(_ context.Context, ref, outcome string, atMS int64) bool {
			recorded = append(recorded, recordedOutcome{accountRef: ref, outcome: outcome, atMS: atMS})
			return true
		},
		Collect: func(context.Context) []OutcomeObservation {
			return []OutcomeObservation{
				{Key: "k1", Marker: "completed:100", Outcome: "success", AtMS: 100, AccountRef: "acct_11111111111111111111"},
			}
		},
	})
	s3 := poller2.Tick(context.Background())
	if s3.Recorded != 0 {
		t.Fatalf("expected persisted cursor to deduplicate k1, got %+v", s3)
	}

	// Verify orderedCursor trimming at MaxTrackedObservations
	c := newOrderedCursor()
	for i := 0; i < MaxTrackedObservations+50; i++ {
		c.set("obs_"+strconv.Itoa(i), "1")
	}
	encoded, err := c.marshalJSON()
	if err != nil {
		t.Fatalf("marshal ordered cursor: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal([]byte(encoded), &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded) != MaxTrackedObservations {
		t.Fatalf("expected trimmed len %d, got %d", MaxTrackedObservations, len(decoded))
	}
	if _, hasOld := decoded["obs_0"]; hasOld {
		t.Fatalf("expected oldest key obs_0 evicted")
	}
	if _, hasNew := decoded["obs_"+strconv.Itoa(MaxTrackedObservations+49)]; !hasNew {
		t.Fatalf("expected newest key retained")
	}
}

func TestClineAndKiroOutcomePollersWithGatedOffsets(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	const refCline = "acct_aaaaaaaaaaaaaaaaaaaa"
	const refKiro = "acct_bbbbbbbbbbbbbbbbbbbb"

	// Cline files: cs_ok completed, cs_err failed
	for _, tc := range []struct {
		id     string
		status string
		ended  int64
	}{
		{"cs_ok", "completed", 1_700_000_020_000},
		{"cs_err", "failed", 1_700_000_025_000},
	} {
		dir := filepath.Join(hostHome, ".cline", "data", "sessions", tc.id)
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(filepath.Join(dir, tc.id+".messages.json"), []byte("[]"), 0o644)
		_ = os.WriteFile(filepath.Join(dir, tc.id+".json"), []byte(
			`{"session_id":"`+tc.id+`","status":"`+tc.status+`","cwd":"/proj/cline","started_at":1700000010000,"ended_at":`+strconv.FormatInt(tc.ended, 10)+`}`,
		), 0o644)
	}

	var clineReg = []RegistryEntry{
		{Provider: "cline", AccountRef: refCline, Cwd: "/proj/cline", CreatedAtMS: 1_700_000_005_000, UpdatedAtMS: 1_700_000_050_000},
	}
	var clineRecorded []recordedOutcome
	clinePoller := NewClineSessionOutcomePoller(ClinePollerOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		ListRegistryEntries: func() []RegistryEntry {
			return clineReg
		},
		RecordOutcome: func(_ context.Context, ref, outcome string, atMS int64) bool {
			clineRecorded = append(clineRecorded, recordedOutcome{accountRef: ref, outcome: outcome, atMS: atMS})
			return true
		},
	})
	cs := clinePoller.Tick(context.Background())
	if cs.Recorded != 2 {
		t.Fatalf("expected 2 cline outcomes recorded, got %+v", cs)
	}

	// Kiro gated offset advancement test:
	kiroDir := filepath.Join(hostHome, ".kiro", "sessions", "fedcba9876543210", "sess_turn")
	_ = os.MkdirAll(kiroDir, 0o755)
	_ = os.WriteFile(filepath.Join(kiroDir, "session.json"), []byte(`{"id":"sess_turn","workspacePaths":["/proj/kiro"],"createdAt":1700000000000}`), 0o644)
	msgPath := filepath.Join(kiroDir, "messages.jsonl")
	_ = os.WriteFile(msgPath, []byte(`{"id":"t1","timestamp":1700000030000,"payload":{"type":"usage_summary","status":"error"}}`+"\n"), 0o644)

	var kiroReg []RegistryEntry
	var kiroRecorded []recordedOutcome
	kiroPoller := NewKiroSessionOutcomePoller(KiroPollerOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		ListRegistryEntries: func() []RegistryEntry {
			return kiroReg
		},
		RecordOutcome: func(_ context.Context, ref, outcome string, atMS int64) bool {
			kiroRecorded = append(kiroRecorded, recordedOutcome{accountRef: ref, outcome: outcome, atMS: atMS})
			return true
		},
	})

	// 1st tick: no registry scope -> unattributed, file offset MUST NOT advance!
	ks1 := kiroPoller.Tick(context.Background())
	if ks1.Unattributed != 1 || ks1.Recorded != 0 {
		t.Fatalf("expected 1 unattributed kiro turn, got %+v", ks1)
	}

	// 2nd tick: registry scope appears -> collector re-reads t1 and records unclassified
	kiroReg = []RegistryEntry{
		{Provider: "kiro", AccountRef: refKiro, Cwd: "/proj/kiro", CreatedAtMS: 1_700_000_000_000, UpdatedAtMS: 1_700_000_060_000},
	}
	ks2 := kiroPoller.Tick(context.Background())
	if ks2.Recorded != 1 || len(kiroRecorded) != 1 || kiroRecorded[0].outcome != "unclassified" {
		t.Fatalf("expected delayed kiro turn attribution to record unclassified, got summary=%+v rec=%+v", ks2, kiroRecorded)
	}
}
