package main

import (
	"strings"
	"testing"
)

func TestCompareRowsPassesWhenEveryLocalRefExistsRemotely(t *testing.T) {
	local := []accountRefState{
		{Ref: "acct_00000000000000000001", Enabled: true},
		{Ref: "acct_00000000000000000002", Enabled: false},
	}
	remote := []accountRefState{
		{Ref: "acct_00000000000000000002", Enabled: false},
		{Ref: "acct_00000000000000000001", Enabled: true},
		{Ref: "acct_00000000000000000003", Enabled: true},
	}
	rep := compareRows(local, remote, false)
	if !rep.Pass {
		t.Fatalf("expected pass, got %+v", rep)
	}
	if len(rep.Matched) != 2 {
		t.Fatalf("matched = %v, want 2 refs", rep.Matched)
	}
	if len(rep.RemoteOnly) != 1 || rep.RemoteOnly[0] != "acct_00000000000000000003" {
		t.Fatalf("remote_only = %v", rep.RemoteOnly)
	}
}

func TestCompareRowsFailsOnMissingRemoteRef(t *testing.T) {
	local := []accountRefState{{Ref: "acct_00000000000000000001", Enabled: true}}
	rep := compareRows(local, nil, false)
	if rep.Pass {
		t.Fatal("expected failure for missing remote ref")
	}
	if len(rep.MissingRemote) != 1 {
		t.Fatalf("missing_remote = %v", rep.MissingRemote)
	}
}

func TestCompareRowsFailsOnEnabledMismatch(t *testing.T) {
	ref := "acct_00000000000000000001"
	local := []accountRefState{{Ref: ref, Enabled: true}}
	remote := []accountRefState{{Ref: ref, Enabled: false}}
	rep := compareRows(local, remote, false)
	if rep.Pass {
		t.Fatal("expected failure for enabled mismatch")
	}
	if len(rep.EnabledMismatch) != 1 || rep.EnabledMismatch[0].Ref != ref {
		t.Fatalf("enabled_mismatch = %v", rep.EnabledMismatch)
	}
}

func TestCompareRowsStrictFailsOnRemoteOnly(t *testing.T) {
	local := []accountRefState{{Ref: "acct_00000000000000000001", Enabled: true}}
	remote := []accountRefState{
		{Ref: "acct_00000000000000000001", Enabled: true},
		{Ref: "acct_00000000000000000002", Enabled: true},
	}
	if rep := compareRows(local, remote, false); !rep.Pass {
		t.Fatalf("non-strict should pass on remote-only, got %+v", rep)
	}
	if rep := compareRows(local, remote, true); rep.Pass {
		t.Fatal("strict should fail on remote-only")
	}
}

func TestParseRemoteRowsRejectsMalformedRef(t *testing.T) {
	if _, err := parseRemoteRows("acct_zzz\t1\n", "\t"); err == nil {
		t.Fatal("expected malformed ref to fail")
	}
}

func TestParseRemoteRowsRejectsInvalidEnabled(t *testing.T) {
	if _, err := parseRemoteRows("acct_00000000000000000001\t2\n", "\t"); err == nil {
		t.Fatal("expected invalid enabled to fail")
	}
}

func TestParseRemoteRowsRejectsDuplicateRef(t *testing.T) {
	line := "acct_00000000000000000001\t1\n"
	if _, err := parseRemoteRows(line+line, "\t"); err == nil {
		t.Fatal("expected duplicate ref to fail")
	}
}

func TestSelectConnectionDefaultsToAWS(t *testing.T) {
	connections := []sshConnection{
		{ID: "conn_1", Label: "Local Mac"},
		{ID: "conn_2", Label: "AWS Current Japan"},
	}
	got, err := selectConnection(connections, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "conn_2" {
		t.Fatalf("selected %s, want conn_2", got.ID)
	}
}

func TestSelectConnectionRejectsAmbiguousSelector(t *testing.T) {
	connections := []sshConnection{
		{ID: "conn_1", Label: "AWS One"},
		{ID: "conn_2", Label: "AWS Two"},
	}
	if _, err := selectConnection(connections, "aws"); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguity error, got %v", err)
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("~/.ai_home/aih.db"); got != "'~/.ai_home/aih.db'" {
		t.Fatalf("shellQuote = %s", got)
	}
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Fatalf("shellQuote with quote = %s", got)
	}
}

func TestRemotePathExprExpandsTilde(t *testing.T) {
	if got := remotePathExpr("~/.ai_home/aih.db"); got != `"$HOME"'/.ai_home/aih.db'` {
		t.Fatalf("remotePathExpr home = %s", got)
	}
	if got := remotePathExpr("/var/lib/aih.db"); got != "'/var/lib/aih.db'" {
		t.Fatalf("remotePathExpr absolute = %s", got)
	}
}
