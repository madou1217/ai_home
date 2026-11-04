// Package modelcatalog 通过 zcode 的 plan 计费接口发现账号模型目录。
//
// 事实（与 Node 的 http-utils-zcode 同口径，2026-10 取证）：
//   - GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<ver>
//     必需头：X-Device-Mid（缺失直接 400 {"code":3001,"msg":"parameter error"}）、
//     X-ZCode-App-Version、X-Platform、X-Release-Channel 等客户端元数据。
//   - 余额里没有模型不代表账号没有模型：「领臭鸡蛋」是叠加套餐，可领活动只出现在
//     GET .../billing/preview 的 data.plans[].entitlements[].capabilities[]。
//   - 模型 ID 只暴露 glm*/codegeex*/zcode* 裸命名空间（bigmodel 推理端点不认
//     opencode-go/* 这类伙伴命名空间）。
package modelcatalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	providerID       = "zcode"
	balanceURL       = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance"
	previewURL       = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview"
	seedAppVersion   = "3.16.3"
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
)

var (
	ErrInvalidDependencies   = errors.New("zcode 模型目录源依赖无效")
	ErrUnsupportedCredential = errors.New("zcode 模型目录源凭据形态不支持")
	ErrEmptyCatalog          = errors.New("zcode 模型目录为空")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Source 是 zcode 的模型发现策略。
type Source struct {
	client     HTTPClient
	balanceURL string
	previewURL string
	appVersion string
	platform   string
}

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// New 创建生产端点上的目录源。
func New(client HTTPClient) (*Source, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{
		client:     client,
		balanceURL: balanceURL,
		previewURL: previewURL,
		appVersion: seedAppVersion,
		platform:   runtime.GOOS + "-" + runtime.GOARCH,
	}, nil
}

// ProviderID 返回 zcode。
func (source *Source) ProviderID() string { return providerID }

// DiscoverModels 读取账号的可路由模型；余额没有时回退活动预览。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != providerID {
		return nil, ErrUnsupportedCredential
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return nil, ErrUnsupportedCredential
	}
	token, err := zcodeJWT(native.Payload())
	if err != nil {
		return nil, err
	}
	headers := source.headers(native.IdentitySeed(), token)
	models, err := source.balanceModels(ctx, headers)
	if err == nil && len(models) > 0 {
		return models, nil
	}
	return source.previewModels(ctx, headers)
}

func (source *Source) headers(identitySeed string, token string) map[string]string {
	return map[string]string{
		"Authorization":       "Bearer " + token,
		"Accept":              "application/json",
		"User-Agent":          "ZCode/" + source.appVersion,
		"HTTP-Referer":        "https://zcode.z.ai",
		"X-Title":             "Z Code@electron",
		"X-Platform":          source.platform,
		"X-Release-Channel":   "stable",
		"X-Client-Language":   "en-US",
		"X-Client-Timezone":   "UTC",
		"X-Os-Category":       osCategory(),
		"X-ZCode-App-Version": source.appVersion,
		"X-Device-Mid":        deviceMid(identitySeed),
	}
}

func (source *Source) balanceModels(
	ctx context.Context,
	headers map[string]string,
) ([]string, error) {
	endpoint := appendQuery(source.balanceURL, "app_version", source.appVersion)
	payload, err := source.get(ctx, endpoint, headers)
	if err != nil {
		return nil, err
	}
	var document struct {
		Code *int `json:"code"`
		Data struct {
			Balances []struct {
				Capabilities []string `json:"capabilities"`
				ShowName     string   `json:"show_name"`
			} `json:"balances"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil, ErrEmptyCatalog
	}
	if document.Code != nil && *document.Code != 0 {
		return nil, ErrEmptyCatalog
	}
	seen := make(map[string]struct{}, 8)
	models := make([]string, 0, 8)
	for _, balance := range document.Data.Balances {
		capabilityModels := capabilityModelIDs(balance.Capabilities)
		if len(capabilityModels) == 0 && strings.TrimSpace(balance.ShowName) != "" {
			capabilityModels = []string{strings.TrimSpace(balance.ShowName)}
		}
		for _, id := range capabilityModels {
			if !routable(id) {
				continue
			}
			key := strings.ToLower(id)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			models = append(models, id)
		}
	}
	sort.Strings(models)
	return models, nil
}

func (source *Source) previewModels(
	ctx context.Context,
	headers map[string]string,
) ([]string, error) {
	endpoint := appendQuery(source.previewURL, "app_version", source.appVersion)
	endpoint = appendQuery(endpoint, "platform", source.platform)
	payload, err := source.get(ctx, endpoint, headers)
	if err != nil {
		return nil, err
	}
	var document struct {
		Data struct {
			Plans []struct {
				Entitlements []struct {
					Capabilities []string `json:"capabilities"`
				} `json:"entitlements"`
			} `json:"plans"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil, ErrEmptyCatalog
	}
	seen := make(map[string]struct{}, 8)
	models := make([]string, 0, 8)
	for _, plan := range document.Data.Plans {
		for _, entitlement := range plan.Entitlements {
			for _, id := range capabilityModelIDs(entitlement.Capabilities) {
				if !routable(id) {
					continue
				}
				key := strings.ToLower(id)
				if _, exists := seen[key]; exists {
					continue
				}
				seen[key] = struct{}{}
				models = append(models, id)
			}
		}
	}
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	sort.Strings(models)
	return models, nil
}

func (source *Source) get(
	ctx context.Context,
	endpoint string,
	headers map[string]string,
) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = response.Body.Close()
	}()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("zcode 模型目录请求失败: HTTP %d", response.StatusCode)
	}
	if len(payload) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return payload, nil
}

func zcodeJWT(payload []byte) (string, error) {
	var document struct {
		Credentials map[string]json.RawMessage `json:"credentials"`
	}
	if json.Unmarshal(payload, &document) != nil || document.Credentials == nil {
		return "", ErrUnsupportedCredential
	}
	raw, exists := document.Credentials["zcodejwttoken"]
	if !exists {
		return "", ErrUnsupportedCredential
	}
	var token string
	if json.Unmarshal(raw, &token) != nil || strings.TrimSpace(token) == "" {
		return "", ErrUnsupportedCredential
	}
	return strings.TrimSpace(token), nil
}

func capabilityModelIDs(capabilities []string) []string {
	ids := make([]string, 0, len(capabilities))
	for _, capability := range capabilities {
		value := strings.TrimSpace(capability)
		if !strings.HasPrefix(strings.ToLower(value), "model:") {
			continue
		}
		id := strings.TrimSpace(value[len("model:"):])
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// routable 只暴露网关能路由回 zcode 的裸命名空间。
func routable(modelID string) bool {
	value := strings.ToLower(strings.TrimSpace(modelID))
	if value == "" || strings.Contains(value, "/") {
		return false
	}
	return strings.HasPrefix(value, "glm-") ||
		strings.HasPrefix(value, "glm") ||
		strings.HasPrefix(value, "codegeex") ||
		strings.HasPrefix(value, "zcode")
}

func appendQuery(endpoint string, key string, value string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func osCategory() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

// deviceMid 派生稳定 UUID：桌面端把它当设备标识（非密钥），缺失时按账号派生是等价且可重复的。
func deviceMid(identitySeed string) string {
	digest := sha256.Sum256([]byte("zcode-device-mid:go:" + identitySeed))
	hexValue := hex.EncodeToString(digest[:])
	variant := ((hexNibble(hexValue[16]) & 0x3) | 0x8)
	return strings.Join([]string{
		hexValue[0:8],
		hexValue[8:12],
		"4" + hexValue[13:16],
		fmt.Sprintf("%x", variant) + hexValue[17:20],
		hexValue[20:32],
	}, "-")
}

func hexNibble(value byte) int {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0')
	case value >= 'a' && value <= 'f':
		return int(value-'a') + 10
	default:
		return 0
	}
}
