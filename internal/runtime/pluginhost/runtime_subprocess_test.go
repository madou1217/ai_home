package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func locateRepoRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for cur := cwd; ; {
		candidate := filepath.Join(cur, "lib", "plugins", "host", "host-entry.mjs")
		if _, err := os.Stat(candidate); err == nil {
			return cur
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			t.Fatalf("could not locate repo root from %s", cwd)
		}
		cur = parent
	}
}

func writeTestPluginModule(t *testing.T, dir, fileName, contribID, tag string) string {
	t.Helper()
	p := filepath.Join(dir, fileName)
	src := `export default {
  name: ` + "`" + contribID + "`" + `,
  inject: ['aih'],
  apply(ctx, config) {
    ctx.aih.register(` + "`" + contribID + "`" + `, async (input) => {
      return { tag: ` + "`" + tag + "`" + `, echo: input, cfg: config };
    });
  }
};
`
	if err := os.WriteFile(p, []byte(src), 0o600); err != nil {
		t.Fatalf("write plugin module %s: %v", p, err)
	}
	return p
}

func makeValidTestManifest(pluginID, version, entryRel, contribID, capName string) map[string]any {
	return map[string]any{
		"manifestVersion": 1,
		"protocolVersion": 1,
		"pluginId":        pluginID,
		"version":         version,
		"engines":         map[string]any{"aih": "^1.0.0"},
		"runtime":         "node",
		"entry":           entryRel,
		"permissions": map[string]any{
			"network":     []any{},
			"filesystem":  map[string]any{"read": []any{}, "write": []any{}},
			"secrets":     []any{},
			"environment": []any{},
		},
		"contributes": []any{
			map[string]any{
				"id":            contribID,
				"capability":    capName,
				"version":       1,
				"order":         10,
				"failurePolicy": "deny",
			},
		},
	}
}

func TestSupervisorAndRuntimeRealSubprocessLifecycle(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node executable not found; skipping real subprocess test")
	}
	repoRoot := locateRepoRoot(t)
	aiHomeDir := t.TempDir()
	pluginDir := filepath.Join(aiHomeDir, "plugins", "demo")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatalf("mkdir pluginDir: %v", err)
	}
	entry1 := writeTestPluginModule(t, pluginDir, "v1.mjs", "demo.cmd", "v1")
	entry2 := writeTestPluginModule(t, pluginDir, "v2.mjs", "demo.cmd", "v2")

	shortSock := filepath.Join(os.TempDir(), "aih-pl1-sub-"+filepath.Base(aiHomeDir)+".sock")
	defer func() { _ = os.Remove(shortSock) }()

	rt, err := NewRuntime(RuntimeOptions{
		AIHomeDir:               aiHomeDir,
		RepoRoot:                repoRoot,
		SocketPath:              shortSock,
		NodePath:                nodePath,
		HostVersion:             "1.0.0",
		RecycleAfterGenerations: 2,
		RetireTimeout:           5 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := rt.Stop(stopCtx); err != nil {
			t.Fatalf("Stop: %v", err)
		}
	}()

	spec1 := PluginSpec{
		InstanceID:    "demo",
		PluginID:      "demo.plugin",
		Version:       "1.0.0",
		EntryPath:     entry1,
		Manifest:      makeValidTestManifest("demo.plugin", "1.0.0", "v1.mjs", "demo.cmd", "command"),
		Configuration: map[string]any{"greeting": "hello"},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	st1, err := rt.Publish(ctx, []PluginSpec{spec1}, nil)
	if err != nil {
		t.Fatalf("Publish gen1 failed: %v", err)
	}
	if st1.State != StateActive || st1.ActiveGeneration != 1 || st1.HostPID == 0 {
		t.Fatalf("unexpected status after gen1: %+v", st1)
	}
	if _, ok := rt.Registry().Get(1); !ok {
		t.Fatalf("expected gen 1 projection synced directly into Registry")
	}

	// Verify direct RPC invocation works end-to-end against real Node plugin host.
	raw1, err := rt.Invoke(ctx, 1, "demo.cmd", map[string]any{"n": 42}, 3*time.Second)
	if err != nil {
		t.Fatalf("Invoke gen1 failed: %v", err)
	}
	var resp1 struct {
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal(raw1, &resp1); err != nil || resp1.Tag != "v1" {
		t.Fatalf("unexpected invoke gen1 response: %s (err=%v)", string(raw1), err)
	}

	// Acquire a lease on gen1 before rotating to gen2 so gen1 remains draining & invokable.
	lease1 := rt.Acquire()
	if lease1 == nil || lease1.Generation != 1 {
		t.Fatalf("expected active lease on gen 1, got %+v", lease1)
	}

	spec2 := PluginSpec{
		InstanceID:    "demo",
		PluginID:      "demo.plugin",
		Version:       "1.0.1",
		EntryPath:     entry2,
		Manifest:      makeValidTestManifest("demo.plugin", "1.0.1", "v2.mjs", "demo.cmd", "command"),
		Configuration: map[string]any{"greeting": "world"},
	}
	st2, err := rt.Publish(ctx, []PluginSpec{spec2}, nil)
	if err != nil {
		t.Fatalf("Publish gen2 failed: %v", err)
	}
	if st2.ActiveGeneration != 2 || st2.RetiringCount != 1 {
		t.Fatalf("expected active gen 2 and 1 retiring gen, got %+v", st2)
	}

	// Gen 1 must still be registered & invokable while lease1 is held!
	if _, ok := rt.Registry().Get(1); !ok {
		t.Fatalf("gen 1 must remain in Registry while lease is held")
	}
	rawDrain, err := rt.Invoke(ctx, 1, "demo.cmd", map[string]any{"draining": true}, 3*time.Second)
	if err != nil {
		t.Fatalf("Invoke draining gen1 failed: %v", err)
	}
	var respDrain struct {
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal(rawDrain, &respDrain); err != nil || respDrain.Tag != "v1" {
		t.Fatalf("unexpected gen1 draining response: %s", string(rawDrain))
	}

	// Release lease1 and wait (>= 150ms margin) for async retirement & dispose.
	lease1.Release()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st := rt.Status(ctx)
		_, gen1InReg := rt.Registry().Get(1)
		if st.RetiringCount == 0 && !gen1InReg {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	stAfterDrain := rt.Status(ctx)
	if stAfterDrain.RetiringCount != 0 {
		t.Fatalf("expected gen1 retirement complete, got %+v", stAfterDrain)
	}
	if _, ok := rt.Registry().Get(1); ok {
		t.Fatalf("expected gen1 removed from Registry after retirement")
	}

	// Publishing gen 3 triggers host recycling since RecycleAfterGenerations == 2 and totalLeases == 0.
	prevPID := stAfterDrain.HostPID
	st3, err := rt.Publish(ctx, []PluginSpec{spec1}, nil)
	if err != nil {
		t.Fatalf("Publish gen3 (recycled host) failed: %v", err)
	}
	if st3.ActiveGeneration != 3 || st3.HostPID == 0 || st3.HostPID == prevPID {
		t.Fatalf("expected new recycled host PID (prev=%d), got %+v", prevPID, st3)
	}

	// Verify disabling all plugins stops host and returns to idle cleanly.
	stIdle, err := rt.Publish(ctx, nil, nil)
	if err != nil {
		t.Fatalf("Publish empty failed: %v", err)
	}
	if stIdle.State != StateIdle || stIdle.ActiveGeneration != 0 || stIdle.HostPID != 0 {
		t.Fatalf("expected idle state and stopped host, got %+v", stIdle)
	}
	// Wait >= 150ms margin after empty deactivate to ensure child process exited cleanly.
	time.Sleep(150 * time.Millisecond)
	if len(rt.Registry().Generations()) != 0 {
		t.Fatalf("expected empty Registry after idle")
	}
}

type fakeHostClient struct {
	mu        sync.Mutex
	running   bool
	pid       int
	prepared  []int64
	activated []int64
	disposed  []int64
	failStart bool
	prepHook  func(gen int64) (HostPrepareResult, error)
	invHook   func(gen int64, cid string, val any) (json.RawMessage, error)
	onExit    func(ExitEvent)
}

func (f *fakeHostClient) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failStart {
		return errors.New("start refused")
	}
	f.running = true
	f.pid = 9999
	return nil
}

func (f *fakeHostClient) Stop(ctx context.Context) error {
	f.mu.Lock()
	f.running = false
	f.pid = 0
	f.mu.Unlock()
	return nil
}

func (f *fakeHostClient) Prepare(ctx context.Context, generation int64, plugins []PluginSpec) (HostPrepareResult, error) {
	f.mu.Lock()
	hook := f.prepHook
	f.prepared = append(f.prepared, generation)
	f.mu.Unlock()
	if hook != nil {
		return hook(generation)
	}
	contribs := make([]string, 0)
	for _, p := range plugins {
		for _, c := range mapSlice(p.Manifest, "contributes") {
			if id := stringField(c, "id"); id != "" {
				contribs = append(contribs, id)
			}
		}
	}
	return HostPrepareResult{Generation: generation, State: "prepared", Contributions: contribs}, nil
}

func (f *fakeHostClient) Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error) {
	f.mu.Lock()
	f.activated = append(f.activated, generation)
	f.mu.Unlock()
	return HostActivateResult{Generation: generation, State: "active"}, nil
}

func (f *fakeHostClient) Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error) {
	f.mu.Lock()
	hook := f.invHook
	f.mu.Unlock()
	if hook != nil {
		return hook(generation, contributionID, value)
	}
	return json.RawMessage("null"), nil
}

func (f *fakeHostClient) Dispose(ctx context.Context, generation int64) (HostDisposeResult, error) {
	f.mu.Lock()
	f.disposed = append(f.disposed, generation)
	f.mu.Unlock()
	return HostDisposeResult{Generation: generation, State: "disposed"}, nil
}

func (f *fakeHostClient) Status(ctx context.Context) (HostStatusResult, error) {
	return HostStatusResult{ActiveGeneration: 1}, nil
}

func (f *fakeHostClient) Ping(ctx context.Context) error { return nil }
func (f *fakeHostClient) SocketPath() string             { return "/tmp/fake.sock" }
func (f *fakeHostClient) Token() string                  { return "fake-token" }
func (f *fakeHostClient) PID() int                       { f.mu.Lock(); defer f.mu.Unlock(); return f.pid }
func (f *fakeHostClient) Running() bool                  { f.mu.Lock(); defer f.mu.Unlock(); return f.running }

func TestRuntimeBackoffRecoveryAndTicketLifecycle(t *testing.T) {
	var seqCounter atomic.Int64
	var hostMu sync.Mutex
	var hosts []*fakeHostClient
	recoveredCh := make(chan struct{}, 2)

	spec := PluginSpec{
		InstanceID: "p1",
		PluginID:   "p1",
		Version:    "1.0.0",
		EntryPath:  "/tmp/p1.mjs",
		Manifest:   makeValidTestManifest("p1", "1.0.0", "p1.mjs", "p1.cmd", "command"),
	}

	rt, err := NewRuntime(RuntimeOptions{
		TicketTTL:       180 * time.Millisecond,
		RetireTimeout:   180 * time.Millisecond,
		BackoffSchedule: []time.Duration{150 * time.Millisecond, 150 * time.Millisecond},
		DesiredPlugins: func(ctx context.Context) ([]PluginSpec, error) {
			return []PluginSpec{spec}, nil
		},
		OnRuntimeChange: func() {
			select {
			case recoveredCh <- struct{}{}:
			default:
			}
		},
		SupervisorFactory: func(seq int64) (HostClient, error) {
			n := seqCounter.Add(1)
			h := &fakeHostClient{pid: int(1000 + n)}
			hostMu.Lock()
			hosts = append(hosts, h)
			hostMu.Unlock()
			return h, nil
		},
	})
	if err != nil {
		t.Fatalf("NewRuntime: %v", err)
	}
	defer func() { _ = rt.Stop(context.Background()) }()

	// Inject OnExit callback through a wrapper or direct host simulate after Prepare:
	ticket, err := rt.Prepare(context.Background(), []PluginSpec{spec})
	if err != nil {
		t.Fatalf("Prepare failed: %v", err)
	}
	// Second Prepare while ticket is pending must return plugin_publish_busy.
	if _, err := rt.Prepare(context.Background(), []PluginSpec{spec}); errorCode(err) != CodePublishBusy {
		t.Fatalf("expected %s, got %v", CodePublishBusy, err)
	}
	// Wait past TicketTTL (>= 150ms margin) so ticket expires cleanly.
	time.Sleep(260 * time.Millisecond)
	if _, err := rt.Activate(context.Background(), ticket.Ticket, 1); errorCode(err) != CodeTicketExpired {
		t.Fatalf("expected %s after TTL, got %v", CodeTicketExpired, err)
	}
	if _, err := rt.Activate(context.Background(), "missing-ticket", 1); errorCode(err) != CodeTicketUnknown {
		t.Fatalf("expected %s for missing ticket, got %v", CodeTicketUnknown, err)
	}

	// Publish gen2 and hold a lease past RetireTimeout so forced retirement triggers on gen3 publish.
	st, err := rt.Publish(context.Background(), []PluginSpec{spec}, nil)
	if err != nil || st.ActiveGeneration == 0 {
		t.Fatalf("Publish gen2 failed: %+v err=%v", st, err)
	}
	lease := rt.Acquire()
	if lease == nil {
		t.Fatalf("expected lease")
	}
	_, err = rt.Publish(context.Background(), []PluginSpec{spec}, nil)
	if err != nil {
		t.Fatalf("Publish gen3 failed: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		stNow := rt.Status(context.Background())
		if stNow.RetiringCount == 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	lease.Release()
	if rt.Status(context.Background()).RetiringCount != 0 {
		t.Fatalf("expected forced retirement to complete")
	}

	// Trigger unexpected exit directly on runtime handler -> verify degraded then auto-recovered!
	rt.mu.Lock()
	curHost := rt.host
	rt.mu.Unlock()
	rt.handleUnexpectedExit(curHost, ExitEvent{Stderr: "boom", At: time.Now()})

	if rt.Status(context.Background()).State != StateDegraded {
		t.Fatalf("expected degraded state immediately after exit")
	}
	if len(rt.Registry().Generations()) != 0 {
		t.Fatalf("expected Registry cleared on unexpected exit")
	}

	recoveryDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(recoveryDeadline) {
		if rt.Status(context.Background()).State == StateActive {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if rt.Status(context.Background()).State != StateActive {
		t.Fatalf("expected runtime to auto-recover to active, got %+v", rt.Status(context.Background()))
	}
	if len(rt.Status(context.Background()).RecentFailures) == 0 {
		t.Fatalf("expected recorded failure history")
	}
}
