package usage

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestLiveQoderProbe(t *testing.T) {
	path := os.Getenv("AIH_TEST_QODER_NATIVE_JSON")
	if path == "" {
		t.Skip("未提供 AIH_TEST_QODER_NATIVE_JSON")
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := accountcore.NewNativeQoderIdentity("qoder", "987d4fbb-a904-4eba-b4b4-09ef8fd83fcc")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatal(err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_103a82d5fbd9e9cedd16")
	if err != nil {
		t.Fatal(err)
	}
	strategy, err := New(&http.Client{Timeout: 15 * time.Second}, "qoder")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, document, err := strategy.FetchUsageWithDocument(context.Background(), accountRef, credential, time.Now())
	if err != nil {
		t.Fatalf("采集失败: %v", err)
	}
	t.Logf("entries=%d documentKind=%s", len(snapshot.Entries()), document.Kind())
}
