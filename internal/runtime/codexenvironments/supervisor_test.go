package codexenvironments

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testHostSpec(label, identity string) HostSpec {
	return HostSpec{
		Connection: Connection{
			ID:           "conn_test",
			Label:        label,
			Host:         "127.0.0.1",
			User:         "tester",
			Port:         22,
			AuthType:     "key-file",
			IdentityFile: identity,
		},
		ListenPort: 25555,
		CodexPath:  "/bin/true",
	}
}

func waitForHosts(t *testing.T, supervisor *HostSupervisor, description string, check func([]HostStatus) bool) []HostStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		statuses := supervisor.Status()
		if check(statuses) {
			return statuses
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s; last status: %+v", description, supervisor.Status())
	return nil
}

func waitForReady(t *testing.T, supervisor *HostSupervisor) HostStatus {
	t.Helper()
	statuses := waitForHosts(t, supervisor, "ready", func(statuses []HostStatus) bool {
		return len(statuses) == 1 && statuses[0].State == hostStateReady
	})
	return statuses[0]
}

func waitForNoHosts(t *testing.T, supervisor *HostSupervisor) {
	t.Helper()
	waitForHosts(t, supervisor, "no hosts", func(statuses []HostStatus) bool {
		return len(statuses) == 0
	})
}

func TestApplySameSpecKeepsHost(t *testing.T) {
	var opens atomic.Int32
	supervisor := NewHostSupervisor(func(context.Context, HostOptions) (*Host, error) {
		opens.Add(1)
		return &Host{}, nil
	})
	t.Cleanup(func() { _ = supervisor.Close() })

	spec := testHostSpec("A", "/tmp/a")
	supervisor.Apply(context.Background(), []HostSpec{spec}, "/tmp")
	first := waitForReady(t, supervisor)

	supervisor.Apply(context.Background(), []HostSpec{spec}, "/tmp")
	time.Sleep(100 * time.Millisecond)

	if got := opens.Load(); got != 1 {
		t.Fatalf("same spec restarted the host: opens=%d", got)
	}
	last := waitForReady(t, supervisor)
	if last.OpenedAt != first.OpenedAt {
		t.Fatalf("same spec changed OpenedAt: %d -> %d", first.OpenedAt, last.OpenedAt)
	}
}

func TestApplyChangedSpecRestartsHost(t *testing.T) {
	var opens atomic.Int32
	supervisor := NewHostSupervisor(func(context.Context, HostOptions) (*Host, error) {
		opens.Add(1)
		return &Host{}, nil
	})
	t.Cleanup(func() { _ = supervisor.Close() })

	first := testHostSpec("A", "/tmp/a")
	second := testHostSpec("B", "/tmp/b")
	supervisor.Apply(context.Background(), []HostSpec{first}, "/tmp")
	initial := waitForReady(t, supervisor)

	supervisor.Apply(context.Background(), []HostSpec{second}, "/tmp")
	last := waitForReady(t, supervisor)

	if opens.Load() != 2 {
		t.Fatalf("changed spec opens=%d, want 2", opens.Load())
	}
	if last.fingerprint != hostSpecFingerprint(second) {
		t.Fatalf("status fingerprint did not follow the new spec")
	}
	if last.fingerprint == initial.fingerprint {
		t.Fatalf("changed spec kept the old fingerprint")
	}
}

func TestApplyRemovesHost(t *testing.T) {
	var opens atomic.Int32
	supervisor := NewHostSupervisor(func(context.Context, HostOptions) (*Host, error) {
		opens.Add(1)
		return &Host{}, nil
	})
	t.Cleanup(func() { _ = supervisor.Close() })

	supervisor.Apply(context.Background(), []HostSpec{testHostSpec("A", "/tmp/a")}, "/tmp")
	waitForReady(t, supervisor)

	supervisor.Apply(context.Background(), nil, "/tmp")
	waitForNoHosts(t, supervisor)

	if got := opens.Load(); got != 1 {
		t.Fatalf("removing a host reopened one: opens=%d", got)
	}
}

func TestApplyWaitsForBlockedOpenerBeforeReplacing(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	var opens atomic.Int32
	supervisor := NewHostSupervisor(func(ctx context.Context, _ HostOptions) (*Host, error) {
		opens.Add(1)
		started <- struct{}{}
		select {
		case <-release:
			return &Host{}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	t.Cleanup(func() { _ = supervisor.Close() })

	first := testHostSpec("A", "/tmp/a")
	second := testHostSpec("B", "/tmp/b")
	supervisor.Apply(context.Background(), []HostSpec{first}, "/tmp")
	<-started

	replaced := make(chan struct{})
	go func() {
		supervisor.Apply(context.Background(), []HostSpec{second}, "/tmp")
		close(replaced)
	}()

	// 旧 opener 还卡着，新宿主不能先开始。
	select {
	case <-started:
		t.Fatal("replacement opener started before the old host was closed")
	case <-time.After(100 * time.Millisecond):
	}

	close(release)
	select {
	case <-replaced:
	case <-time.After(3 * time.Second):
		t.Fatal("Apply did not finish after releasing the old opener")
	}
	<-started // 新宿主进入 opener

	last := waitForReady(t, supervisor)
	if opens.Load() != 2 {
		t.Fatalf("opens=%d, want 2", opens.Load())
	}
	if last.fingerprint != hostSpecFingerprint(second) {
		t.Fatalf("final status does not belong to the replacement spec")
	}
}

func TestApplyStatusCloseConcurrent(t *testing.T) {
	for round := 0; round < 8; round++ {
		supervisor := NewHostSupervisor(func(context.Context, HostOptions) (*Host, error) {
			return &Host{}, nil
		})
		a := testHostSpec("A", "/tmp/a")
		b := testHostSpec("B", "/tmp/b")
		ctx := context.Background()

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			for i := 0; i < 8; i++ {
				if i%2 == 0 {
					supervisor.Apply(ctx, []HostSpec{a}, "/tmp")
				} else {
					supervisor.Apply(ctx, []HostSpec{b}, "/tmp")
				}
			}
		}()
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				_ = supervisor.Status()
			}
		}()

		time.Sleep(time.Millisecond)
		_ = supervisor.Close()
		wg.Wait()

		if statuses := supervisor.Status(); len(statuses) != 0 {
			t.Fatalf("round %d left %d statuses after Close", round, len(statuses))
		}
	}
}

func TestConcurrentApplyConverges(t *testing.T) {
	supervisor := NewHostSupervisor(func(context.Context, HostOptions) (*Host, error) {
		return &Host{}, nil
	})
	t.Cleanup(func() { _ = supervisor.Close() })

	a := testHostSpec("A", "/tmp/a")
	b := testHostSpec("B", "/tmp/b")
	ctx := context.Background()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 5; i++ {
			supervisor.Apply(ctx, []HostSpec{a}, "/tmp")
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 5; i++ {
			supervisor.Apply(ctx, []HostSpec{b}, "/tmp")
		}
	}()
	wg.Wait()

	supervisor.Apply(ctx, []HostSpec{a}, "/tmp")
	last := waitForReady(t, supervisor)
	if last.fingerprint != hostSpecFingerprint(a) {
		t.Fatalf("concurrent Apply did not converge to the final spec")
	}
}

func TestHostSpecFingerprint(t *testing.T) {
	jump := func() *Connection {
		return &Connection{ID: "jump", Host: "jump.example", User: "u", Port: 22, AuthType: "key-file", IdentityFile: "/tmp/a"}
	}
	base := testHostSpec("A", "/tmp/a")
	base.Connection.Jump = jump()
	same := testHostSpec("A", "/tmp/a")
	same.Connection.Jump = jump()
	other := testHostSpec("A", "/tmp/a")
	other.Connection.Jump = jump()

	if hostSpecFingerprint(base) != hostSpecFingerprint(same) || hostSpecFingerprint(same) != hostSpecFingerprint(other) {
		t.Fatalf("equivalent specs produced different fingerprints")
	}

	cases := []struct {
		name   string
		mutate func(*HostSpec)
	}{
		{"host", func(spec *HostSpec) { spec.Connection.Host = "127.0.0.2" }},
		{"user", func(spec *HostSpec) { spec.Connection.User = "other" }},
		{"port", func(spec *HostSpec) { spec.Connection.Port = 2222 }},
		{"auth", func(spec *HostSpec) { spec.Connection.AuthType = "password" }},
		{"identity", func(spec *HostSpec) { spec.Connection.IdentityFile = "/tmp/other" }},
		{"password", func(spec *HostSpec) { spec.Connection.Password = "secret" }},
		{"privateKey", func(spec *HostSpec) { spec.Connection.PrivateKey = "key" }},
		{"jump", func(spec *HostSpec) { spec.Connection.Jump = &Connection{ID: "other"} }},
		{"listenPort", func(spec *HostSpec) { spec.ListenPort = 25556 }},
		{"codexPath", func(spec *HostSpec) { spec.CodexPath = "/bin/other" }},
	}
	baseFingerprint := hostSpecFingerprint(base)
	for _, testCase := range cases {
		changed := base
		testCase.mutate(&changed)
		if hostSpecFingerprint(changed) == baseFingerprint {
			t.Fatalf("%s change did not change the fingerprint", testCase.name)
		}
	}
}
