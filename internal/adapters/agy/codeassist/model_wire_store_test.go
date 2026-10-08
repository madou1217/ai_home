package codeassist

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestModelWireStoreIsolatesAccountsAndRestoresAfterRestart(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "run", "agy-model-wires.json")
	store := NewModelWireStore(path)
	first, _ := accountcore.ParseAccountRef("acct_11111111111111111111")
	second, _ := accountcore.ParseAccountRef("acct_22222222222222222222")
	models := map[string]string{"old": "new"}
	if err := store.Replace(first, models); err != nil {
		t.Fatal(err)
	}
	models["old"] = "mutated"
	if err := store.Replace(second, map[string]string{"old": "other"}); err != nil {
		t.Fatal(err)
	}
	restarted := NewModelWireStore(path)
	if restarted.Resolve(first, "old") != "new" || restarted.Resolve(second, "old") != "other" ||
		restarted.Resolve(first, "new") != "new" || restarted.Resolve(first, "unknown") != "unknown" {
		t.Fatal("account isolation, copy ownership or restart persistence failed")
	}
	if err := restarted.Replace(first, nil); err != nil {
		t.Fatal(err)
	}
	if NewModelWireStore(path).Resolve(first, "old") != "old" {
		t.Fatal("removed mapping survived a successful empty catalog refresh")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("store file permissions=%v error=%v", info, err)
	}
}

func TestModelWireStoreKeepsLastGoodMappingOnWriteFailure(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "store.json")
	ref, _ := accountcore.DeriveAccountRef(testAgyAuth(t))
	store := NewModelWireStore(path)
	if err := store.Replace(ref, map[string]string{"old": "new"}); err != nil {
		t.Fatal(err)
	}
	store.path = filepath.Join(path, "cannot-write.json")
	if err := store.Replace(ref, map[string]string{"old": "other"}); err == nil {
		t.Fatal("expected a write error")
	}
	if store.Resolve(ref, "old") != "new" || NewModelWireStore(path).Resolve(ref, "old") != "new" {
		t.Fatal("failed write replaced the last good mapping")
	}
}

func TestModelWireStoreConcurrentReadsObserveWholeMappings(t *testing.T) {
	t.Parallel()

	store := NewModelWireStore("")
	ref, _ := accountcore.DeriveAccountRef(testAgyAuth(t))
	if err := store.Replace(ref, map[string]string{"old": "new"}); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for range 4 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for range 100 {
				value := store.Resolve(ref, "old")
				if value != "new" && value != "other" {
					t.Errorf("partial mapping %q", value)
				}
			}
		}()
	}
	for range 100 {
		if err := store.Replace(ref, map[string]string{"old": "other"}); err != nil {
			t.Fatal(err)
		}
		if err := store.Replace(ref, map[string]string{"old": "new"}); err != nil {
			t.Fatal(err)
		}
	}
	wait.Wait()
}
