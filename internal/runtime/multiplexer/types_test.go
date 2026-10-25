package multiplexer

import (
	"reflect"
	"testing"
)

func TestTmuxDriverBuildsStrictFreshAttachAndRestoreCommands(t *testing.T) {
	driver := NewTmuxDriver()
	base := LaunchOptions{
		Command: "tmux",
		Socket:  "aih-codex-acct_0123",
		Session: "s-project",
		CWD:     "/tmp/project",
		Inner:   Command{Path: "codex", Args: []string{"--model", "gpt-6.1-sol"}},
	}
	fresh := driver.BuildLaunch(base)
	wantFresh := []string{"-u", "-L", "aih-codex-acct_0123", "new-session", "-s", "s-project", "-c", "/tmp/project", "--", "codex", "--model", "gpt-6.1-sol"}
	if !reflect.DeepEqual(fresh.Args, wantFresh) || fresh.Detached {
		t.Fatalf("fresh = %#v", fresh)
	}
	attach := driver.BuildAttach(base, false)
	wantAttach := []string{"-u", "-L", "aih-codex-acct_0123", "attach-session", "-d", "-t", "s-project"}
	if !reflect.DeepEqual(attach.Args, wantAttach) {
		t.Fatalf("attach = %#v", attach)
	}
	restore := driver.BuildLaunch(LaunchOptions{Command: base.Command, Socket: base.Socket, Session: base.Session, CWD: base.CWD, Inner: base.Inner, Detached: true})
	wantRestore := []string{"-u", "-L", "aih-codex-acct_0123", "new-session", "-A", "-d", "-s", "s-project", "-c", "/tmp/project", "--", "codex", "--model", "gpt-6.1-sol"}
	if !reflect.DeepEqual(restore.Args, wantRestore) || !restore.Detached {
		t.Fatalf("restore = %#v", restore)
	}
}

func TestTmuxDriverListsAndKillsExactSession(t *testing.T) {
	driver := NewTmuxDriver()
	list := driver.List(ListOptions{Command: "tmux", Socket: "aih-codex-acct_0123"})
	if !reflect.DeepEqual(list.Args, []string{"-u", "-L", "aih-codex-acct_0123", "list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_created}\t#{session_path}"}) {
		t.Fatalf("list = %#v", list)
	}
	kill, err := driver.Kill(KillOptions{Command: "tmux", Socket: "aih-codex-acct_0123", Session: "s-project"})
	if err != nil {
		t.Fatalf("Kill() error = %v", err)
	}
	if !reflect.DeepEqual(kill.Args, []string{"-u", "-L", "aih-codex-acct_0123", "kill-session", "-t", "s-project"}) {
		t.Fatalf("kill = %#v", kill)
	}
	if _, err := driver.Kill(KillOptions{Command: "tmux", Socket: "aih-codex-acct_0123", Session: "bad name"}); err == nil {
		t.Fatal("Kill() accepted unsafe session")
	}
}
