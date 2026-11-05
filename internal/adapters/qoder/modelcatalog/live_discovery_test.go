package modelcatalog

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestLiveDiscoverModels 用真机凭据打一次模型目录接口。
//
// 这条请求带 wasm 签名，属于有风控代价的调用：只在显式提供凭据时运行，且一次改动
// 只跑一次。失败先看单测与假 HTTP，不要拿它当调试探针。
func TestLiveDiscoverModels(t *testing.T) {
	path := os.Getenv("AIH_TEST_QODER_NATIVE_JSON")
	if path == "" {
		t.Skip("未提供 AIH_TEST_QODER_NATIVE_JSON")
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 native payload 失败: %v", err)
	}
	var native map[string]any
	if err := json.Unmarshal(payload, &native); err != nil {
		t.Fatalf("解析 native payload 失败: %v", err)
	}
	uid := ""
	if userInfo, ok := native["userInfo"].(map[string]any); ok {
		uid, _ = userInfo["uid"].(string)
	}
	if uid == "" {
		t.Fatal("native payload 缺少 userInfo.uid")
	}
	identity, err := accountcore.NewNativeQoderIdentity("qoder", uid)
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	source, err := New(&http.Client{Timeout: 20 * time.Second}, "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	names, err := source.DiscoverModels(ctx, credential)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(names) == 0 {
		t.Fatal("模型目录为空")
	}
	t.Logf("models=%d first=%v", len(names), names[:min(3, len(names))])
}
