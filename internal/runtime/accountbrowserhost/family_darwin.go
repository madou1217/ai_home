//go:build darwin

package accountbrowserhost

import (
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// processFamily conservatively remembers observed descendants by PID and birth
// time, including a child that later moves out of the original process group.
// This is observation, not a macOS kernel containment guarantee: a process that
// forks and detaches entirely between snapshots may be unobservable.
type processFamily struct {
	mu        sync.Mutex
	root      processIdentity
	known     map[int]unix.Timeval
	uncertain bool
	stop      chan struct{}
	done      chan struct{}
}

func trackFamily(root processIdentity) *processFamily {
	f := &processFamily{root: root, known: map[int]unix.Timeval{root.pid: root.born}, stop: make(chan struct{}), done: make(chan struct{})}
	f.scan()
	go func() {
		defer close(f.done)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-f.stop:
				return
			case <-ticker.C:
				f.scan()
			}
		}
	}()
	return f
}

func (f *processFamily) scan() {
	f.mu.Lock()
	defer f.mu.Unlock()
	all, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		f.uncertain = true
		return
	}
	byPID := make(map[int]unix.Timeval, len(all))
	for _, proc := range all {
		byPID[int(proc.Proc.P_pid)] = proc.Proc.P_starttime
	}
	// Iterate until closure so the kernel's enumeration order is immaterial.
	for changed := true; changed; {
		changed = false
		for _, proc := range all {
			pid, parent := int(proc.Proc.P_pid), int(proc.Eproc.Ppid)
			if born, exists := f.known[pid]; exists && born == proc.Proc.P_starttime {
				continue
			}
			parentBirth, parentKnown := f.known[parent]
			parentAlive := parentKnown && byPID[parent] == parentBirth
			if parentAlive || (int(proc.Eproc.Pgid) == f.root.pid && proc.Proc.P_starttime.Sec >= f.root.born.Sec) {
				f.known[pid] = proc.Proc.P_starttime
				changed = true
			}
		}
	}
}

func (f *processFamily) empty() (bool, error) {
	f.scan()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.uncertain {
		return false, ErrRecoveryRequired
	}
	all, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return false, ErrRecoveryRequired
	}
	for _, proc := range all {
		if born, ok := f.known[int(proc.Proc.P_pid)]; ok && born == proc.Proc.P_starttime {
			return false, nil
		}
	}
	return f.root.empty()
}

func (f *processFamily) close() {
	close(f.stop)
	<-f.done
}
