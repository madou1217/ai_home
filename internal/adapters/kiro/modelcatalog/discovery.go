// Package modelcatalog 通过 kiro 控制面 ListAvailableModels 发现账号模型目录。
//
// 两代端点（2026-10 实测）：
//   - V3（控制面，按套餐返回真实清单）：POST https://management.<region>.kiro.dev/
//     x-amz-target: KiroControlPlaneBearerService.ListAvailableModels
//     body {"origin":"KIRO_CLI","profileArn":"<arn>"}（必须带 profileArn）
//   - V2（旧端点，所有套餐都只返回 3 个）：POST
//     https://codewhisperer.<region>.amazonaws.com/
//     x-amz-target: AmazonCodeWhispererService.ListAvailableModels
//     body {"origin":"CLI"}
//
// 有 profileArn 时先走 V3，失败再回落 V2；没有 profileArn 只走 V2。
package modelcatalog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
)

const (
	maxResponseBytes = 1 << 20
	requestTimeout   = 10 * time.Second
	targetV3         = "KiroControlPlaneBearerService.ListAvailableModels"
	targetV2         = "AmazonCodeWhispererService.ListAvailableModels"
	targetProfiles   = "AmazonCodeWhispererService.ListAvailableProfiles"
	contentType      = "application/x-amz-json-1.0"
	// Builder-ID 账号列不出 profile（上游 403），但 V3 必须带 profileArn；
	// 这两个值是官方 kiro-cli 的协议常量（账号 + 占位 profile 名），不是模型表。
	builderIDProfileAccount = "638616132270"
	builderIDProfileName    = "AAAACCCCXXXX"
)

var (
	ErrInvalidDependencies   = errors.New("kiro 模型目录源依赖无效")
	ErrUnsupportedCredential = errors.New("kiro 模型目录源凭据形态不支持")
	ErrEmptyCatalog          = errors.New("kiro 模型目录响应不含模型清单")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Source 是 kiro 的模型发现策略。
type Source struct {
	client            HTTPClient
	managementBaseURL func(region string) string
	codeWhispererBase func(region string) string
}

var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// New 创建默认（生产端点）的 kiro 模型目录源。
func New(client HTTPClient) (*Source, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{
		client: client,
		managementBaseURL: func(region string) string {
			return fmt.Sprintf("https://management.%s.kiro.dev/", region)
		},
		codeWhispererBase: func(region string) string {
			return fmt.Sprintf("https://codewhisperer.%s.amazonaws.com/", region)
		},
	}, nil
}

// ProviderID 返回 kiro。
func (source *Source) ProviderID() string { return kiro.ProviderID }

// DiscoverModels 读取账号当前可见的模型清单。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != kiro.ProviderID {
		return nil, ErrUnsupportedCredential
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return nil, ErrUnsupportedCredential
	}
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil || parsed.AccessToken() == "" {
		return nil, ErrUnsupportedCredential
	}
	region := parsed.Region()
	profileARN := parsed.ProfileARN()
	if profileARN == "" {
		// 凭据没带 profileArn：先列一次；唯一结果自动采用，列不出时用 Builder-ID 固定值。
		// 企业多 profile 无法替用户选，直接回落 V2（只拿到最小清单）。
		resolved, usable := source.resolveProfileARN(ctx, region, parsed.AccessToken())
		if !usable {
			return source.request(
				ctx,
				source.codeWhispererBase(region),
				targetV2,
				map[string]string{"origin": "CLI"},
				parsed.AccessToken(),
			)
		}
		profileARN = resolved
	}

	if profileARN != "" {
		models, err := source.request(
			ctx,
			source.managementBaseURL(region),
			targetV3,
			map[string]string{"origin": "KIRO_CLI", "profileArn": profileARN},
			parsed.AccessToken(),
		)
		if err == nil {
			return models, nil
		}
		// V3 抖动不能让账号变「无模型」：回落到旧端点的最小清单。
	}
	return source.request(
		ctx,
		source.codeWhispererBase(region),
		targetV2,
		map[string]string{"origin": "CLI"},
		parsed.AccessToken(),
	)
}

func (source *Source) request(
	ctx context.Context,
	endpoint string,
	target string,
	body map[string]string,
	accessToken string,
) ([]string, error) {
	raw, err := source.requestRaw(ctx, endpoint, target, body, accessToken)
	if err != nil {
		return nil, err
	}
	models := parseModels(raw)
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	return models, nil
}

func (source *Source) requestRaw(
	ctx context.Context,
	endpoint string,
	target string,
	body map[string]string,
	accessToken string,
) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("x-amz-target", target)
	response, err := source.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("kiro 模型清单请求失败: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kiro 模型清单请求失败: HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxResponseBytes {
		return nil, ErrEmptyCatalog
	}
	return raw, nil
}

// resolveProfileARN 解析模型发现所需的 profileArn。
//
// 返回 usable=false 表示「企业多 profile，不能替用户选」，调用方应只走 V2。
func (source *Source) resolveProfileARN(
	ctx context.Context,
	region string,
	accessToken string,
) (string, bool) {
	profiles, err := source.listProfiles(ctx, region, accessToken)
	if err != nil {
		return builderIDProfileARN(region), true
	}
	switch len(profiles) {
	case 0:
		return builderIDProfileARN(region), true
	case 1:
		return profiles[0], true
	default:
		return "", false
	}
}

func (source *Source) listProfiles(
	ctx context.Context,
	region string,
	accessToken string,
) ([]string, error) {
	raw, err := source.requestRaw(
		ctx,
		source.codeWhispererBase(region),
		targetProfiles,
		map[string]string{"origin": "CLI"},
		accessToken,
	)
	if err != nil {
		return nil, err
	}
	var document struct {
		Profiles []struct {
			ARN      string `json:"arn"`
			ARNAlt   string `json:"profileArn"`
			ARNSnake string `json:"profile_arn"`
		} `json:"profiles"`
		ProfileList []struct {
			ARN      string `json:"arn"`
			ARNAlt   string `json:"profileArn"`
			ARNSnake string `json:"profile_arn"`
		} `json:"profileList"`
	}
	if json.Unmarshal(raw, &document) != nil {
		return nil, ErrEmptyCatalog
	}
	rows := document.Profiles
	if len(rows) == 0 {
		rows = document.ProfileList
	}
	seen := make(map[string]struct{}, len(rows))
	profiles := make([]string, 0, len(rows))
	for _, row := range rows {
		arn := strings.TrimSpace(firstNonEmpty(row.ARN, row.ARNAlt, row.ARNSnake))
		if arn == "" {
			continue
		}
		if _, exists := seen[arn]; exists {
			continue
		}
		seen[arn] = struct{}{}
		profiles = append(profiles, arn)
	}
	return profiles, nil
}

func builderIDProfileARN(region string) string {
	return fmt.Sprintf(
		"arn:aws:codewhisperer:%s:%s:profile/%s",
		region,
		builderIDProfileAccount,
		builderIDProfileName,
	)
}

func parseModels(payload []byte) []string {
	var document struct {
		Models []struct {
			ModelID    string `json:"modelId"`
			ModelIDAlt string `json:"model_id"`
			ModelName  string `json:"modelName"`
			NameAlt    string `json:"model_name"`
		} `json:"models"`
		DefaultModel struct {
			ModelID string `json:"modelId"`
			IDAlt   string `json:"model_id"`
		} `json:"defaultModel"`
	}
	if json.Unmarshal(payload, &document) != nil {
		return nil
	}
	seen := make(map[string]struct{}, len(document.Models)+1)
	models := make([]string, 0, len(document.Models)+1)
	appendModel := func(value string) {
		id := strings.TrimSpace(value)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	for _, item := range document.Models {
		appendModel(firstNonEmpty(item.ModelID, item.ModelIDAlt, item.ModelName, item.NameAlt))
	}
	appendModel(firstNonEmpty(document.DefaultModel.ModelID, document.DefaultModel.IDAlt))
	sort.Strings(models)
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
