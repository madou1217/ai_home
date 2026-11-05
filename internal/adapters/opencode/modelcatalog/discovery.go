// Package modelcatalog 发现 OpenCode 的官方模型目录。
//
// 官方目录是两条腿的并集：
//   - Go 订阅：GET https://opencode.ai/zen/go/v1/models → opencode-go/<id>
//   - Zen 全量（含免费）：GET https://opencode.ai/zen/v1/models → opencode/<id>
//
// 只探到一条腿时保留另一条腿的失败原因（incomplete），但不把残缺目录当作
// 「账号不支持其余模型」的证据。
//
// 凭据：api-key 与 OAuth 的 access token 都可以用于**发现**（推理仍只走 api-key，
// 见 opencoderelay 的边界）。
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
)

const maxResponseBytes = 1 << 20

const (
	goModelPrefix  = "opencode-go/"
	zenModelPrefix = "opencode/"
)

var (
	ErrInvalidDependencies   = errors.New("OpenCode 模型目录源依赖无效")
	ErrProviderMismatch      = errors.New("OpenCode 模型目录源凭据归属不符")
	ErrUnsupportedCredential = errors.New("OpenCode 模型目录源凭据形态不支持")
	ErrEmptyCatalog          = errors.New("OpenCode 模型目录响应不含模型清单")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Source 是 OpenCode 的模型发现策略。
type Source struct {
	client HTTPClient
	legs   []catalogLeg
}

type catalogLeg struct {
	baseURL string
	prefix  string
}

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// New 创建默认（生产端点）的目录源。
func New(client HTTPClient) (*Source, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{
		client: client,
		legs: []catalogLeg{
			{baseURL: opencoderelay.GoBaseURL, prefix: goModelPrefix},
			{baseURL: opencoderelay.ZenBaseURL, prefix: zenModelPrefix},
		},
	}, nil
}

// ProviderID 返回 opencode。
func (source *Source) ProviderID() string { return opencoderelay.ProviderID }

// DiscoverModels 合并两条腿的模型清单。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != opencoderelay.ProviderID {
		return nil, ErrProviderMismatch
	}
	// 与 Node 一致：没有 opencode 密钥时两个官方端点仍可匿名探测（免费模型）。
	// 只有凭据归属不符才是硬错误。
	token, err := discoveryAccessToken(credential)
	if err != nil && !errors.Is(err, ErrUnsupportedCredential) {
		return nil, err
	}
	token = strings.TrimSpace(token)
	seen := make(map[string]struct{}, 32)
	models := make([]string, 0, 32)
	// 两条腿必须都成功：目录是并集，任何一条腿失败都说明我们只看到了半份目录。
	// 曾经这里「一条腿成功就返回部分并集」，结果某账号少了 41 个 opencode/* 模型却被
	// 当成完整目录写进 account_models（模型静默从路由里消失）。宁可失败让刷新重试，
	// 也不要把半份目录当结论。
	var firstErr error
	for _, leg := range source.legs {
		ids, legErr := source.fetch(ctx, leg, token)
		if legErr != nil {
			if firstErr == nil {
				firstErr = legErr
			}
			continue
		}
		for _, id := range ids {
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			models = append(models, id)
		}
	}
	if firstErr != nil {
		return nil, firstErr
	}
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	sort.Strings(models)
	return models, nil
}

func (source *Source) fetch(
	ctx context.Context,
	leg catalogLeg,
	token string,
) ([]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, leg.baseURL+"/models", nil)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	request.Header.Set("Accept", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("OpenCode 模型清单请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return parseModels(payload, leg.prefix), nil
}

// discoveryAccessToken 先按推理口径取 api-key，再回退到原生凭据里的 OAuth access token。
func discoveryAccessToken(credential accountapp.Credential) (string, error) {
	if opencoderelay.SupportsCredential(credential) {
		if token, err := opencoderelay.AccessTokenFromCredential(credential); err == nil && token != "" {
			return token, nil
		}
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return "", ErrUnsupportedCredential
	}
	var document struct {
		Auth map[string]struct {
			Key    string `json:"key"`
			Access string `json:"access"`
		} `json:"auth"`
	}
	if json.Unmarshal(native.Payload(), &document) != nil {
		return "", ErrUnsupportedCredential
	}
	for _, upstream := range []string{"opencode-go", "opencode"} {
		entry := document.Auth[upstream]
		if token := strings.TrimSpace(entry.Key); token != "" {
			return token, nil
		}
		if token := strings.TrimSpace(entry.Access); token != "" {
			return token, nil
		}
	}
	return "", ErrUnsupportedCredential
}

func parseModels(payload []byte, prefix string) []string {
	var document struct {
		Data []struct {
			ID    string `json:"id"`
			Model string `json:"model"`
		} `json:"data"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil
	}
	models := make([]string, 0, len(document.Data))
	seen := make(map[string]struct{}, len(document.Data))
	for _, item := range document.Data {
		id := strings.TrimSpace(firstNonEmpty(item.ID, item.Model))
		if id == "" {
			continue
		}
		lower := strings.ToLower(id)
		if strings.HasPrefix(lower, strings.ToLower(goModelPrefix)) {
			id = id[len(goModelPrefix):]
		}
		if strings.HasPrefix(strings.ToLower(id), strings.ToLower(zenModelPrefix)) {
			id = id[len(zenModelPrefix):]
		}
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, prefix+id)
	}
	return models
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
