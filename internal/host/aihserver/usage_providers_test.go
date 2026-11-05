package aihserver

import (
	"net/http"
	"sort"
	"testing"
	"time"
)

// TestUsageProviderRegistryCoversExpectedProviders 锁住注册表的覆盖面。
//
// 重构前 Provider 与协调器队列是两份手写清单，漂移不会报警；现在二者都由注册表派生，
// 这个用例把「应有的 Provider 集合」固定下来：新增/删除 Provider 必须显式改这里，
// 避免某次重构静默漏掉一个 Provider（额度从此不再刷新，且没有任何报错）。
func TestUsageProviderRegistryCoversExpectedProviders(t *testing.T) {
	strategies, concurrency, err := buildUsageProviderStrategies(usageProviderContext{
		client: &http.Client{},
		clock:  time.Now,
	})
	if err != nil {
		t.Fatalf("buildUsageProviderStrategies() error = %v", err)
	}
	expected := []string{
		"codex", "claude", "kiro", "agy", "zcode", "cline", "gemini", "kimi",
		"qoder", "qodercn", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn",
	}
	got := make([]string, 0, len(strategies))
	seen := map[string]string{}
	for _, strategy := range strategies {
		providerID := strategy.ProviderID()
		if previous, duplicated := seen[providerID]; duplicated {
			t.Fatalf("Provider %q 重复注册（%T 与 %T）", providerID, previous, strategy)
		}
		seen[providerID] = providerID
		got = append(got, providerID)
	}
	sort.Strings(got)
	sortedExpected := append([]string(nil), expected...)
	sort.Strings(sortedExpected)
	expected = sortedExpected
	if len(got) != len(expected) {
		t.Fatalf("注册 Provider 数 = %d, want %d: %v", len(got), len(expected), got)
	}
	for index, providerID := range expected {
		if got[index] != providerID {
			t.Fatalf("注册 Provider 集合不一致: got %v want %v", got, expected)
		}
	}
	// 协调器队列必须与策略集合同源：漏一个 Provider 就等于额度永不刷新。
	if len(concurrency) != len(expected) {
		t.Fatalf("协调器队列 = %d, want %d", len(concurrency), len(expected))
	}
	for _, providerID := range expected {
		if concurrency[providerID] <= 0 {
			t.Fatalf("Provider %q 没有协调器并发度", providerID)
		}
	}
}
