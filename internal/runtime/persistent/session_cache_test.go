package persistent

import (
	"strings"
	"testing"
	"time"
)

// TestSessionCacheRoundTrip 写回后能读回并补标题/原生 id。
func TestSessionCacheRoundTrip(t *testing.T) {
	home := t.TempDir()
	now := time.Now()
	rows := []SessionRow{
		{Name: "p-a", Provider: "codebuddycn", Label: "验收会话", NativeID: "01a1", Path: "/tmp/p", Live: true},
	}
	if err := WriteSessionCache(home, rows, now); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !cacheFileExists(home) {
		t.Fatal("缓存文件未写入")
	}
	entries := ReadSessionCache(home, now.Add(time.Minute))
	if len(entries) != 1 || entries[0].AgentSessionID != "01a1" {
		t.Fatalf("entries = %#v", entries)
	}
	if expired := ReadSessionCache(home, now.Add(sessionCacheTTL+time.Minute)); len(expired) != 0 {
		t.Fatalf("过期缓存不应返回: %#v", expired)
	}
}

// TestApplySessionCache 只填空缺/过长/与名字相同的标题，已有可信标题不覆盖。
func TestApplySessionCache(t *testing.T) {
	entries := []SessionCacheEntry{
		{Name: "p-a", Title: "缓存标题A", AgentSessionID: "01a1"},
		{Name: "p-b", Title: "缓存标题B"},
		{Name: "p-c", Title: "缓存标题C"},
	}
	rows := []SessionRow{
		{Name: "p-a"},
		{Name: "p-b", Label: strings.Repeat("很长", 40)},
		{Name: "p-c", Label: "可信标题"},
	}
	ApplySessionCache(rows, entries)
	if rows[0].Label != "缓存标题A" || rows[0].NativeID != "01a1" {
		t.Fatalf("rows[0] = %#v", rows[0])
	}
	if rows[1].Label != "缓存标题B" {
		t.Fatalf("超长标题应被替换: %q", rows[1].Label)
	}
	if rows[2].Label != "可信标题" {
		t.Fatalf("可信标题被覆盖: %q", rows[2].Label)
	}
	if !strings.Contains(rows[0].NativeID, "01a1") {
		t.Fatalf("native id = %q", rows[0].NativeID)
	}
}
