package qoderrelay

import (
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// 冷启动 / 目录刷新失败（SQLITE_BUSY）时缓存为空：relay 必须按凭据现算一次，
// 不能把「目录还没准备好」当成客户端请求无效。
func TestRewriteFallsBackToEntriesLoaderOnCacheMiss(t *testing.T) {
	installFakes(t)
	previousEntries, previousLoader := cachedEntries, loadEntries
	cachedEntries = func(string, map[string]any) ([]modelcatalog.Entry, bool) { return nil, false }
	loadEntries = func(string, accountapp.Credential) ([]modelcatalog.Entry, error) {
		return []modelcatalog.Entry{{
			Key: "qfmodel", DisplayName: "Qwen3.8-Flash", Format: "openai", Source: "system",
			IsReasoning: true, MaxInputTokens: 128000,
		}}, nil
	}
	t.Cleanup(func() {
		cachedEntries = previousEntries
		loadEntries = previousLoader
	})

	provider := &Provider{
		BaseProvider: relaycore.NewBaseProvider("qoder", ""),
		providerID:   "qoder",
		credential:   nativeCredential(t, "qoder"),
	}
	body := []byte(`{"model":"Qwen3.8-Flash","stream":true,"messages":[{"role":"user","content":"ping"}]}`)
	if _, err := provider.RewriteRequest(body); err != nil {
		t.Fatalf("缓存缺失时应回落到按需加载: %v", err)
	}
}

func TestRewriteFailsWhenLoaderAlsoMisses(t *testing.T) {
	installFakes(t)
	previousEntries, previousLoader := cachedEntries, loadEntries
	cachedEntries = func(string, map[string]any) ([]modelcatalog.Entry, bool) { return nil, false }
	loadEntries = func(string, accountapp.Credential) ([]modelcatalog.Entry, error) { return nil, nil }
	t.Cleanup(func() {
		cachedEntries = previousEntries
		loadEntries = previousLoader
	})
	provider := &Provider{
		BaseProvider: relaycore.NewBaseProvider("qoder", ""),
		providerID:   "qoder",
		credential:   nativeCredential(t, "qoder"),
	}
	body := []byte(`{"model":"Qwen3.8-Flash","messages":[]}`)
	if _, err := provider.RewriteRequest(body); err == nil {
		t.Fatal("缓存与按需加载都失败时必须报错")
	}
}
