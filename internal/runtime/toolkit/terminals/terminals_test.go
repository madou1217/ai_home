package terminals

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

type execFunc func(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult

func (f execFunc) Run(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult {
	return f(ctx, command, args, opts)
}

func TestListClientTerminalsMacOSAndWindowsPresentation(t *testing.T) {
	macFiles := map[string]bool{
		"/Applications/iTerm.app":                         true,
		"/opt/homebrew/bin/brew":                          true,
		"/Users/alice/Applications/WezTerm.app/Contents/MacOS/wezterm": true,
	}
	macList := ListClientTerminals(Options{
		Platform:    "darwin",
		HostHomeDir: "/Users/alice",
		Env:         map[string]string{"PATH": "/opt/homebrew/bin:/usr/bin", "SHELL": "/bin/zsh"},
		PathExists:  func(p string) bool { return macFiles[p] },
	})
	if !macList.OK || macList.Platform != "macos" || macList.HomeDir != "/Users/alice" {
		t.Fatalf("unexpected macOS list header: %+v", macList)
	}
	byID := map[string]TerminalView{}
	for _, item := range macList.Terminals {
		byID[item.ID] = item
	}
	if !byID["system-default"].Default || !byID["system-default"].Installed || !byID["system-default"].CanLaunch {
		t.Fatalf("system-default invalid: %+v", byID["system-default"])
	}
	if !byID["iterm2"].Installed || !byID["iterm2"].CanUpdate || byID["iterm2"].PackageManager != "homebrew" {
		t.Fatalf("iterm2 invalid: %+v", byID["iterm2"])
	}
	if !byID["wezterm"].Installed || !byID["wezterm"].CanUninstall {
		t.Fatalf("wezterm invalid: %+v", byID["wezterm"])
	}
	if byID["warp"].Installed || !byID["warp"].CanInstall {
		t.Fatalf("warp should be installable: %+v", byID["warp"])
	}
	if _, ok := byID["cmd"]; ok {
		t.Fatalf("cmd must not appear on macOS")
	}

	// Windows without wt.exe: cmd gets default=true, system-default hidden
	winNoWT := ListClientTerminals(Options{
		Platform:    "win32",
		HostHomeDir: `C:\Users\alice`,
		Env:         map[string]string{"USERPROFILE": `C:\Users\alice`},
		PathExists:  func(p string) bool { return false },
	})
	if len(winNoWT.Terminals) != 4 {
		t.Fatalf("expected 4 windows terminals, got %d", len(winNoWT.Terminals))
	}
	if winNoWT.Terminals[0].ID != "windows-terminal" || winNoWT.Terminals[1].ID != "cmd" {
		t.Fatalf("unexpected windows ordering: %+v", winNoWT.Terminals)
	}
	if winNoWT.Terminals[0].Default || !winNoWT.Terminals[1].Default {
		t.Fatalf("expected cmd to hold fallback default when WT absent: %+v", winNoWT.Terminals)
	}

	// Windows with wt.exe installed: windows-terminal takes default=true
	wtAlias := `C:\Users\alice\AppData\Local\Microsoft\WindowsApps\wt.exe`
	winWithWT := ListClientTerminals(Options{
		Platform:    "win32",
		HostHomeDir: `C:\Users\alice`,
		Env:         map[string]string{"USERPROFILE": `C:\Users\alice`, "LOCALAPPDATA": `C:\Users\alice\AppData\Local`},
		PathExists:  func(p string) bool { return p == wtAlias },
	})
	if !winWithWT.Terminals[0].Installed || !winWithWT.Terminals[0].Default || winWithWT.Terminals[1].Default {
		t.Fatalf("expected windows-terminal to claim default when installed: %+v", winWithWT.Terminals)
	}
}

func TestOpenClientTerminalAndRemoteGuard(t *testing.T) {
	remote := OpenClientTerminal(OpenRequest{TerminalID: "system-default", Transport: "webui"}, Options{Platform: "darwin"})
	if remote.OK || remote.Error != "web_terminal_required" {
		t.Fatalf("expected web_terminal_required for remote transport, got %+v", remote)
	}

	var launched LaunchSpec
	res := OpenClientTerminal(OpenRequest{TerminalID: "iterm2", Title: "AIH 测试"}, Options{
		Platform:    "darwin",
		HostHomeDir: "/Users/alice",
		Env:         map[string]string{"SHELL": "/bin/zsh"},
		PathExists:  func(p string) bool { return p == "/Applications/iTerm.app" },
		Launcher: func(spec LaunchSpec) (int, error) {
			launched = spec
			return 4242, nil
		},
	})
	if !res.OK || res.Status != "launched" || res.PID == nil || *res.PID != 4242 {
		t.Fatalf("unexpected open result: %+v", res)
	}
	if launched.File != "osascript" || !strings.Contains(strings.Join(launched.Args, " "), "iTerm2") {
		t.Fatalf("unexpected osascript launch spec: %+v", launched)
	}

	// Windows system-default falls back to cmd verbatim when WT absent
	resWin := OpenClientTerminal(OpenRequest{TerminalID: "system-default", Command: "aih --version"}, Options{
		Platform:    "win32",
		HostHomeDir: `C:\Users\alice`,
		PathExists:  func(string) bool { return false },
		Launcher: func(spec LaunchSpec) (int, error) {
			launched = spec
			return 1001, nil
		},
	})
	if !resWin.OK || !launched.WindowsVerbatimArguments || launched.File != "cmd.exe" {
		t.Fatalf("expected cmd verbatim fallback on windows, got res=%+v spec=%+v", resWin, launched)
	}
}

func TestResolveActionPlanAndJobLifecycle(t *testing.T) {
	bad := ResolveTerminalActionPlan("cmd", "install", Options{Platform: "win32"})
	if bad.OK || bad.Error != "terminal_action_unavailable" {
		t.Fatalf("expected terminal_action_unavailable for cmd, got %+v", bad)
	}
	already := ResolveTerminalActionPlan("iterm2", "install", Options{
		Platform:   "darwin",
		PathExists: func(p string) bool { return p == "/Applications/iTerm.app" || p == "/opt/homebrew/bin/brew" },
	})
	if already.OK || already.Error != "terminal_already_installed" {
		t.Fatalf("expected terminal_already_installed, got %+v", already)
	}

	var calls int32
	gate := make(chan struct{})
	execStub := execFunc(func(ctx context.Context, _ string, args []string, _ environment.ExecOptions) environment.RunResult {
		atomic.AddInt32(&calls, 1)
		<-gate
		zero := 0
		one := 1
		if len(args) == 0 {
			return environment.RunResult{OK: false, ExitCode: &one, Message: "missing args"}
		}
		return environment.RunResult{OK: true, ExitCode: &zero}
	})
	mgr := NewJobManager(Options{
		Platform:    "darwin",
		HostHomeDir: "/Users/alice",
		Env:         map[string]string{"PATH": "/opt/homebrew/bin"},
		PathExists:  func(p string) bool { return p == "/opt/homebrew/bin/brew" },
		Exec:        execStub,
	})

	unconfirmed := mgr.Start(context.Background(), StartRequest{TerminalID: "warp", Action: "install"})
	if unconfirmed.OK || unconfirmed.Error != "confirmation_required" {
		t.Fatalf("expected confirmation_required, got %+v", unconfirmed)
	}

	started := mgr.Start(context.Background(), StartRequest{TerminalID: "warp", Action: "install", Confirmed: true})
	if !started.OK || !started.Accepted || started.AlreadyRunning || started.Job == nil {
		t.Fatalf("expected job start accepted, got %+v", started)
	}
	if !strings.HasPrefix(started.Job.ID, "terminal-action-") || started.Job.FinishedAt != nil || started.Job.Result != nil {
		t.Fatalf("unexpected initial job snapshot: %+v", started.Job)
	}

	dup := mgr.Start(context.Background(), StartRequest{TerminalID: "warp", Action: "install", Confirmed: true})
	if !dup.OK || !dup.AlreadyRunning || dup.Job.ID != started.Job.ID {
		t.Fatalf("expected dedupe alreadyRunning=true, got %+v", dup)
	}

	ch, cancel, ok := mgr.Subscribe(started.Job.ID)
	if !ok {
		t.Fatalf("expected subscribe ok")
	}
	defer cancel()
	close(gate)

	var final Job
	deadline := time.After(2 * time.Second)
	for {
		select {
		case evt := <-ch:
			if evt.Status == "succeeded" || evt.Status == "failed" {
				final = evt
				goto DONE
			}
		case <-deadline:
			t.Fatalf("timed out waiting for terminal job completion; current=%+v", mgr.Get(started.Job.ID))
		}
	}
DONE:
	if final.Status != "succeeded" || final.FinishedAt == nil || final.Result == nil || !final.Result.Installed {
		t.Fatalf("unexpected finished job: %+v", final)
	}
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected exactly 1 execution due to dedupe, got %d", calls)
	}
}
