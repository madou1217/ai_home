package aihserver

import (
	"context"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func TestMoveAccountEgressBindingFollowsReKey(t *testing.T) {
	aiHomeDir := t.TempDir()
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	ctx := context.Background()
	previous := accountcore.AccountRef("acct_0123456789abcdef0123")
	current := accountcore.AccountRef("acct_abcdef0123456789abcd")
	value := `{"mode":"proxy","proxyUrl":"socks5://127.0.0.1:1080","updatedAt":1}`
	if err := appstate.WriteKV(
		ctx,
		databasePath,
		"account:egress:"+previous.String(),
		value,
		1,
	); err != nil {
		t.Fatalf("seed WriteKV() error = %v", err)
	}
	if err := moveAccountEgressBinding(aiHomeDir, previous, current); err != nil {
		t.Fatalf("moveAccountEgressBinding() error = %v", err)
	}
	moved, found, err := appstate.ReadKV(ctx, databasePath, "account:egress:"+current.String())
	if err != nil || !found || moved != value {
		t.Fatalf("new binding = %q, found=%v, err=%v", moved, found, err)
	}
	if _, found, _ := appstate.ReadKV(ctx, databasePath, "account:egress:"+previous.String()); found {
		t.Fatal("old egress binding must be removed")
	}
}

func TestMoveAccountEgressBindingNoopWithoutBinding(t *testing.T) {
	aiHomeDir := t.TempDir()
	previous := accountcore.AccountRef("acct_0123456789abcdef0123")
	current := accountcore.AccountRef("acct_abcdef0123456789abcd")
	if err := moveAccountEgressBinding(aiHomeDir, previous, current); err != nil {
		t.Fatalf("moveAccountEgressBinding() error = %v", err)
	}
	databasePath, _ := appstate.DatabasePath(aiHomeDir)
	if _, found, _ := appstate.ReadKV(context.Background(), databasePath, "account:egress:"+current.String()); found {
		t.Fatal("unexpected egress binding created")
	}
}
