package main

import (
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

func testCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	return catalog
}

// TestMatchProviderScope 精确名、子串、通配符都按 manifest 顺序返回。
func TestMatchProviderScope(t *testing.T) {
	catalog := testCatalog(t)
	exact := matchProviderScope(catalog, []string{"codebuddycn"})
	if len(exact) != 1 || exact[0] != "codebuddycn" {
		t.Fatalf("exact = %v", exact)
	}
	buddy := matchProviderScope(catalog, []string{"buddy"})
	if len(buddy) != 4 {
		t.Fatalf("substring buddy = %v", buddy)
	}
	for _, want := range []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		found := false
		for _, id := range buddy {
			if id == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("substring buddy 缺少 %s: %v", want, buddy)
		}
	}
	cn := matchProviderScope(catalog, []string{"*cn"})
	if len(cn) == 0 {
		t.Fatalf("wildcard 没匹配: %v", cn)
	}
	for _, id := range cn {
		if len(id) < 2 || id[len(id)-2:] != "cn" {
			t.Fatalf("wildcard 命中非 cn: %v", cn)
		}
	}
	if miss := matchProviderScope(catalog, []string{"not-a-provider"}); len(miss) != 0 {
		t.Fatalf("miss = %v", miss)
	}
}
