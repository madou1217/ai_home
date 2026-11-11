package sshtunnel

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

type fakeTunnel struct {
	done   chan struct{}
	once   sync.Once
	stats  sshremote.ReverseTunnelStats
	probed int
}

func newFakeTunnel() *fakeTunnel                               { return &fakeTunnel{done: make(chan struct{})} }
func (tunnel *fakeTunnel) Probe(context.Context) error         { tunnel.probed++; return nil }
func (tunnel *fakeTunnel) Done() <-chan struct{}               { return tunnel.done }
func (tunnel *fakeTunnel) Close() error                        { tunnel.once.Do(func() { close(tunnel.done) }); return nil }
func (tunnel *fakeTunnel) Stats() sshremote.ReverseTunnelStats { return tunnel.stats }

func TestSupervisorOpensAndClosesTunnel(t *testing.T) {
	var openedSpec Spec
	supervisor := NewWithOpener("", func(_ context.Context, _ sshremote.Config, remotePort, localPort int) (Tunnel, error) {
		openedSpec = Spec{RemotePort: remotePort, LocalPort: localPort}
		return newFakeTunnel(), nil
	})
	t.Cleanup(supervisor.Close)
	supervisor.ReconcileSpecs([]Spec{{ConnectionID: "c1", RemotePort: 2222, LocalPort: 2222}})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := supervisor.Status()
		if len(status) == 1 && status[0].State == "open" {
			if openedSpec.RemotePort != 2222 || openedSpec.LocalPort != 2222 {
				t.Fatalf("opened spec = %+v", openedSpec)
			}
			supervisor.ReconcileSpecs(nil)
			if len(supervisor.Status()) != 0 {
				t.Fatalf("removed tunnel still in status")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("tunnel did not open: %+v", supervisor.Status())
}

func TestParseSpecsPreservesLocalPortAndEgressJump(t *testing.T) {
	raw := []byte(`[
	  {"id":"jump","host":"j","user":"u","authType":"agent","egressConnectionId":"root"},
	  {"id":"root","host":"r","user":"u","authType":"agent"},
	  {"id":"target","host":"t","user":"u","authType":"agent","egressConnectionId":"jump",
	   "reverseTunnel":{"remotePort":2222,"localPort":2222}}
	]`)
	specs, err := ParseSpecs(raw, "/home/me")
	if err != nil {
		t.Fatalf("ParseSpecs: %v", err)
	}
	if len(specs) != 1 || specs[0].LocalPort != 2222 || specs[0].RemotePort != 2222 {
		t.Fatalf("specs = %+v", specs)
	}
	if specs[0].Config.Jump == nil || specs[0].Config.Jump.Jump == nil {
		t.Fatalf("jump chain = %+v", specs[0].Config.Jump)
	}
	invalid, err := ParseSpecs([]byte(`[{"id":"c1","host":"h","reverseTunnel":{"remotePort":80,"localPort":22}}]`), "")
	if err != nil || len(invalid) != 1 || invalid[0].Error == "" {
		t.Fatalf("invalid = %+v err=%v", invalid, err)
	}
}
