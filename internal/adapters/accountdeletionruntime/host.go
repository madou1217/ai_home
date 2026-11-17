package accountdeletionruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

type HostOwner struct {
	AIHomeDir string
	Catalog   *providers.Catalog
}
type hostProcess struct {
	pid    int
	start  string
	kind   string
	native bool
}

func (o HostOwner) scanner() *hostapps.Scanner {
	scanner := hostapps.NewScanner(runtime.GOOS)
	if o.Catalog != nil {
		for _, definition := range o.Catalog.List() {
			if definition.CLI == nil || definition.CLI.DesktopClient == nil {
				continue
			}
			client := definition.CLI.DesktopClient
			if client.UserDataEnvKey != "" && client.MacOS != nil && len(client.MacOS.PathIncludes) > 0 {
				scanner.EnvRules = append(scanner.EnvRules, hostapps.EnvRule{EnvKey: client.UserDataEnvKey, PathIncludes: append([]string(nil), client.MacOS.PathIncludes...)})
			}
		}
	}
	return scanner
}

func (o HostOwner) inspect(ctx context.Context, a accountcore.Account) ([]hostProcess, error) {
	table, err := accountrefmap.LoadStrict(ctx, o.AIHomeDir)
	if err != nil {
		return nil, err
	}
	refs := map[string]bool{a.Ref().String(): true, table.NodeRef(a.Ref().String()): true}
	scanner := o.scanner()
	desktop, err := scanner.ListDesktopInstancesStrict(ctx)
	if err != nil {
		return nil, err
	}
	cli, err := scanner.ListCLIInstancesStrict(ctx)
	if err != nil {
		return nil, err
	}
	accounts := []hostapps.Account{}
	for ref := range refs {
		accounts = append(accounts, hostapps.Account{Provider: a.ProviderID(), AccountRef: ref, Desktop: true})
	}
	desktopPIDs := hostapps.MatchDesktopInstances(desktop, accounts, o.AIHomeDir, runtime.GOOS)
	found := map[int]hostProcess{}
	for _, pids := range desktopPIDs {
		for _, pid := range pids {
			found[pid] = hostProcess{pid: pid, kind: "desktop_app"}
		}
	}
	for _, instance := range cli {
		ref := instance.AccountRef
		if ref == "" && instance.Provider == a.ProviderID() && instance.CLIAccountID == strconv.FormatInt(a.CLIAccountID().Int64(), 10) {
			ref = a.Ref().String()
		}
		if !refs[ref] || instance.Provider != a.ProviderID() {
			continue
		}
		if _, exists := found[instance.PID]; !exists {
			found[instance.PID] = hostProcess{pid: instance.PID, kind: "native_cli", native: instance.NativeOwned}
		}
	}
	out := make([]hostProcess, 0, len(found))
	for pid, p := range found {
		if pid <= 1 || pid == os.Getpid() {
			return nil, accountapp.ErrAccountRuntimeUnverifiable
		}
		alive, known := platform.ProcessState(pid)
		if !known {
			return nil, accountapp.ErrAccountRuntimeUnverifiable
		}
		if !alive {
			continue
		}
		p.start, err = processIdentity(ctx, pid)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].pid < out[j].pid })
	return out, nil
}

func (o HostOwner) Inspect(ctx context.Context, a accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	found, err := o.inspect(ctx, a)
	if err != nil {
		return nil, err
	}
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return nil, accountapp.ErrAccountRuntimeUnverifiable
	}
	// The first snapshot pins process generation. A replacement is never force-
	// killed merely because it reused a PID or appeared under the same account.
	if state.hostTargets == nil {
		state.hostTargets = append([]hostProcess{}, found...)
	}
	out := make([]accountapp.DeletionBlocker, 0, len(found))
	for _, p := range found {
		label := "账号 CLI 进程"
		if p.kind == "desktop_app" {
			label = "账号桌面应用"
		}
		out = append(out, accountapp.DeletionBlocker{Kind: p.kind, Label: label, Provider: a.ProviderID(), AccountRef: a.Ref().String(), Detail: fmt.Sprintf("pid %d", p.pid)})
	}
	return out, nil
}

func (o HostOwner) Release(ctx context.Context, a accountcore.Account) error {
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return accountapp.ErrAccountRuntimeUnverifiable
	}
	current, err := o.inspect(ctx, a)
	if err != nil {
		return err
	}
	pinned := map[int]hostProcess{}
	for _, p := range state.hostTargets {
		pinned[p.pid] = p
	}
	for _, p := range current {
		before, exists := pinned[p.pid]
		if !exists || before.start != p.start || before.kind != p.kind {
			return accountapp.ErrAccountRuntimeUnverifiable
		}
		// The native terminal owner runs first. A remaining native-owned process
		// must not be killed behind its lifecycle's back.
		if p.native {
			return accountapp.ErrAccountRuntimeUnverifiable
		}
	}
	for _, p := range current {
		identity, err := processIdentity(ctx, p.pid)
		if err != nil {
			return err
		}
		if identity != p.start {
			return accountapp.ErrAccountRuntimeUnverifiable
		}
		if err := terminateIdentity(ctx, p.pid, p.start); err != nil {
			return errors.Join(accountapp.ErrAccountRuntimeActive, err)
		}
	}
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	for {
		remaining := false
		for _, p := range current {
			alive, known := platform.ProcessState(p.pid)
			if !known {
				return accountapp.ErrAccountRuntimeUnverifiable
			}
			if !alive {
				continue
			}
			identity, err := processIdentity(ctx, p.pid)
			if err != nil {
				return err
			}
			if identity == p.start {
				remaining = true
			}
		}
		if !remaining {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return accountapp.ErrAccountRuntimeActive
		case <-time.After(25 * time.Millisecond):
		}
	}
}
func (o HostOwner) Prepare(context.Context, accountcore.Account) error      { return nil }
func (o HostOwner) Finish(context.Context, accountcore.Account, bool) error { return nil }
