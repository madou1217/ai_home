package webuisshhostbrowseapi

import "testing"

func TestFindConnectionResolvesEgressJumpChain(t *testing.T) {
	raw := `[
	  {"id":"jump-2","host":"final","user":"u","port":22,"authType":"agent"},
	  {"id":"jump-1","host":"middle","user":"u","port":22,"authType":"agent","egressConnectionId":"jump-2"},
	  {"id":"target","host":"target","user":"u","port":22,"authType":"agent","egressConnectionId":"jump-1"}
	]`
	connection, ok, err := findConnection(raw, true, "target")
	if err != nil || !ok {
		t.Fatalf("findConnection: ok=%v err=%v", ok, err)
	}
	if connection.Jump == nil || connection.Jump.Host != "middle" {
		t.Fatalf("jump = %+v", connection.Jump)
	}
	if connection.Jump.Jump == nil || connection.Jump.Jump.Host != "final" {
		t.Fatalf("second jump = %+v", connection.Jump.Jump)
	}
}

func TestFindConnectionLeavesJumpNilOnCycleOrMissing(t *testing.T) {
	cycle := `[
	  {"id":"a","host":"a","egressConnectionId":"b"},
	  {"id":"b","host":"b","egressConnectionId":"a"}
	]`
	connection, ok, err := findConnection(cycle, true, "a")
	if err != nil || !ok {
		t.Fatalf("cycle: ok=%v err=%v", ok, err)
	}
	if connection.Jump != nil {
		t.Fatalf("cycle jump = %+v", connection.Jump)
	}
	missing, ok, err := findConnection(`[{"id":"a","host":"a","egressConnectionId":"gone"}]`, true, "a")
	if err != nil || !ok || missing.Jump != nil {
		t.Fatalf("missing: ok=%v err=%v jump=%+v", ok, err, missing.Jump)
	}
}
