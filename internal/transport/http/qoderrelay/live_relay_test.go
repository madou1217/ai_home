package qoderrelay

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/qoder/modelcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// TestLiveRelayProbe 真机走一次完整链路：模型目录 → 签名 → zstd → 上游 SSE → 拆信封。
//
// 这条测试会打**两次**带签名的上游请求（模型目录 + 一次 16 token 的推理），属于有
// 风控/额度代价的调用：只在显式提供凭据时运行，一次改动只跑一次，不要拿它当调试探针。
func TestLiveRelayProbe(t *testing.T) {
	path := strings.TrimSpace(os.Getenv("AIH_TEST_QODER_NATIVE_JSON"))
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
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	source, err := modelcatalog.New(&http.Client{Timeout: 20 * time.Second}, "qoder")
	if err != nil {
		t.Fatalf("创建目录源失败: %v", err)
	}
	// 这一次同时把目录写进进程内缓存，供 RewriteRequest 使用。
	entries, err := source.Entries(ctx, credential)
	if err != nil {
		t.Fatalf("读取目录失败: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("目录为空")
	}
	provider := &Provider{
		BaseProvider: relaycore.NewBaseProvider("qoder", ""),
		providerID:   "qoder",
		credential:   credential,
	}
	requestBody := []byte(`{"model":"Auto","stream":true,"messages":[{"role":"user","content":"reply with the single word: ok"}],"max_tokens":16}`)
	if _, err := provider.RewriteRequest(requestBody); err != nil {
		t.Fatalf("RewriteRequest() error = %v", err)
	}
	endpoint, ok := provider.Endpoint()
	if !ok {
		t.Fatal("Endpoint() 为空")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		t.Fatalf("构造上游请求失败: %v", err)
	}
	provider.DecorateUpstream(request, "")
	client := &http.Client{Timeout: 45 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("上游请求失败: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		preview := make([]byte, 512)
		count, _ := response.Body.Read(preview)
		t.Fatalf("上游 HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(preview[:count])))
	}
	reader := bufio.NewReaderSize(response.Body, 64*1024)
	line, err := reader.ReadString(byte(10))
	if err != nil && err.Error() != "EOF" {
		t.Fatalf("读取首帧失败: %v", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(line), "data:") {
		t.Fatalf("首帧不是 SSE: %q", strings.TrimSpace(line))
	}
	t.Logf("first frame: %s", strings.TrimSpace(line)[:min(160, len(strings.TrimSpace(line)))])
}
