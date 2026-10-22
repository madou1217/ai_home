package geo_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/geo"
	"github.com/madou1217/ai_home/internal/adapters/geo/providers"
)

// fakeProvider 是链逻辑测试用的替身：不碰真实文件。
type fakeProvider struct {
	id           string
	capabilities geo.Capabilities
	available    bool
	record       geo.Record
}

func (f fakeProvider) ID() string                     { return f.id }
func (f fakeProvider) Name() string                   { return f.id }
func (f fakeProvider) Capabilities() geo.Capabilities { return f.capabilities }
func (f fakeProvider) Available() bool                { return f.available }
func (f fakeProvider) Lookup(string) geo.Record       { return f.record }
func (f fakeProvider) Detail() string                 { return "" }

// 链的核心语义：字段级合并 + 不可用自动切换 + 补不上的库跳过。
func TestLookupMergesFieldsAndSkipsProvidersThatCannotContribute(t *testing.T) {
	t.Parallel()

	result := geo.Lookup([]geo.Provider{
		fakeProvider{id: "city", capabilities: geo.Capabilities{Country: true, Region: true, City: true},
			available: true, record: geo.Record{Country: "US", Region: "California", City: "San Jose"}},
		fakeProvider{id: "country", capabilities: geo.Capabilities{Country: true}, available: true,
			record: geo.Record{Country: "US"}},
		fakeProvider{id: "asn", capabilities: geo.Capabilities{ASN: true}, available: true,
			record: geo.Record{ASN: "AS13335", Org: "Cloudflare"}},
	}, "1.1.1.1")

	if !result.OK {
		t.Fatalf("expected ok, got error %q", result.Error)
	}
	if result.Record.Country != "US" || result.Record.Region != "California" || result.Record.City != "San Jose" {
		t.Fatalf("country/region/city should come from the city library, got %+v", result.Record)
	}
	if result.Record.ASN != "AS13335" || result.Record.Org != "Cloudflare" {
		t.Fatalf("ASN should be merged from the ASN library, got %+v", result.Record)
	}
	if len(result.Providers) != 2 || result.Providers[0] != "city" || result.Providers[1] != "asn" {
		t.Fatalf("only contributing providers belong in the chain, got %v", result.Providers)
	}
	// country 库补不上还缺的字段（国家已有、ASN 它没有）→ 记为 not_needed，不查询。
	found := false
	for _, attempt := range result.Attempts {
		if attempt.ProviderID == "country" {
			found = true
			if attempt.Error != "not_needed" {
				t.Fatalf("country library should be skipped as not_needed, got %q", attempt.Error)
			}
		}
	}
	if !found {
		t.Fatal("the skipped provider should still be recorded in attempts")
	}
}

func TestLookupFallsThroughUnavailableAndNotFound(t *testing.T) {
	t.Parallel()

	result := geo.Lookup([]geo.Provider{
		fakeProvider{id: "missing", capabilities: geo.Capabilities{Country: true}, available: false},
		fakeProvider{id: "not-in-db", capabilities: geo.Capabilities{Country: true}, available: true},
		fakeProvider{id: "good", capabilities: geo.Capabilities{Country: true, ASN: true}, available: true,
			record: geo.Record{Country: "JP", ASN: "AS2497"}},
	}, "203.0.113.9")

	if !result.OK || result.Record.Country != "JP" {
		t.Fatalf("should fall through to the working provider, got %+v", result)
	}
	want := map[string]string{"missing": "unavailable", "not-in-db": "not_found"}
	for _, attempt := range result.Attempts {
		if expected, ok := want[attempt.ProviderID]; ok && attempt.Error != expected {
			t.Fatalf("%s should report %q, got %q", attempt.ProviderID, expected, attempt.Error)
		}
	}

	// 全查不到 → 明确失败（不是返回空对象）。
	none := geo.Lookup([]geo.Provider{fakeProvider{id: "empty", capabilities: geo.Capabilities{Country: true}, available: true}}, "1.2.3.4")
	if none.OK || none.Error != "geo_not_found" {
		t.Fatalf("expected geo_not_found, got %+v", none)
	}
	if empty := geo.Lookup(nil, ""); empty.Error != "invalid_ip" {
		t.Fatalf("empty ip should be rejected, got %+v", empty)
	}
}

// 真机冒烟：用本机真实 mmdb 文件跑一遍（有文件才跑，没有就跳过 —— 不把「这台机器装了什么」变成测试依赖）。
func TestLookupAgainstRealLocalDatabases(t *testing.T) {
	t.Parallel()

	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home dir")
	}
	chain := providers.Build(providers.Options{AIHomeDir: filepath.Join(homeDir, ".ai_home"), HomeDir: homeDir})
	defer providers.CloseAll(chain)

	availability := geo.Describe(chain)
	available := 0
	for _, entry := range availability {
		if entry.Available {
			available++
		}
	}
	if available == 0 {
		t.Skip("no local mmdb on this machine")
	}
	t.Logf("available providers: %d/%d", available, len(availability))

	// 8.8.8.8 是 Google DNS，任何 Country 库都该给出 US。
	result := geo.Lookup(chain, "8.8.8.8")
	if !result.OK {
		t.Skipf("chain could not resolve a well-known address: %s", result.Error)
	}
	if result.Record.Country != "US" {
		t.Fatalf("8.8.8.8 should resolve to US, got %+v", result.Record)
	}
	t.Logf("8.8.8.8 -> %+v (via %v)", result.Record, result.Providers)
}
