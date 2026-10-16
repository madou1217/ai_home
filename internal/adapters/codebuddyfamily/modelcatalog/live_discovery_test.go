package modelcatalog

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// realFamilyProviderEnv 选择真实探测的家族 Provider（默认 workbuddy）。
	realFamilyProviderEnv = "AIH_REAL_FAMILY_PROVIDER"
	// realFamilyTokenEnv 必须显式提供一条真实 access token 才发起真实请求。
	realFamilyTokenEnv = "AIH_REAL_FAMILY_ACCESS_TOKEN"
)

// TestLiveFamilyConfigDiscovery 用真实 access token 访问家族云端配置端点。
//
// 默认跳过；显式设置 AIH_REAL_FAMILY_ACCESS_TOKEN（可选 AIH_REAL_FAMILY_PROVIDER）
// 才运行。它测的是单元测试覆盖不到的部分：真实站点对请求头的要求与真实响应结构
// （agent 清单 / 站点目录回退），因此云端结构调整时应靠它第一时间发现。
func TestLiveFamilyConfigDiscovery(t *testing.T) {
	token := strings.TrimSpace(os.Getenv(realFamilyTokenEnv))
	if token == "" {
		t.Skipf("未设置 %s，跳过真实家族目录探测", realFamilyTokenEnv)
	}
	providerID := strings.TrimSpace(os.Getenv(realFamilyProviderEnv))
	if providerID == "" {
		providerID = "workbuddy"
	}
	sources, err := NewModelCatalogSources(&http.Client{Timeout: 15 * time.Second})
	if err != nil {
		t.Fatalf("NewModelCatalogSources() error = %v", err)
	}
	var source accountapp.ProviderModelDiscoverer
	for _, candidate := range sources {
		if candidate.ProviderID() == providerID {
			source = candidate
			break
		}
	}
	if source == nil {
		t.Fatalf("%s 不是家族 Provider", providerID)
	}
	identity, err := accountcore.NewNativeSubjectIdentity(providerID, "live-probe")
	if err != nil {
		t.Fatalf("构造原生身份失败: %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"credentials": map[string]any{"auth": map[string]any{"accessToken": token}},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造原生凭据失败: %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), credential)
	if err != nil {
		t.Fatalf("DiscoverModels(%s) error = %v", providerID, err)
	}
	if len(models) == 0 {
		t.Fatalf("DiscoverModels(%s) 返回空清单", providerID)
	}
	for _, modelID := range models {
		if strings.HasPrefix(modelID, customLocalPrefix) {
			t.Fatalf("清单不应包含本机自定义模型: %q", modelID)
		}
	}
	t.Logf("%s 当前支持 %d 个模型: %v", providerID, len(models), models)
}
