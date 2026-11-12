package webuisessionmessagesapi

import (
	"encoding/json"
	"os"
	"testing"
)

func TestZZDumpClaudeParity(t *testing.T) {
	home := os.Getenv("AIH_PARITY_HOME")
	dir := os.Getenv("AIH_PARITY_DIR")
	session := os.Getenv("AIH_PARITY_SESSION")
	out := os.Getenv("AIH_PARITY_OUT")
	if home == "" || dir == "" || session == "" || out == "" {
		t.Skip("parity dump env not set")
	}
	messages, err := readClaudeMessages(home, dir, session)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(messages)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, raw, 0o644); err != nil {
		t.Fatal(err)
	}
}
