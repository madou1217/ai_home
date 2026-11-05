// Package usage 把 kimi 的 /usages 配额换算成额度快照与展示文档。
//
// 协议事实（与 Node lib/cli/services/usage/kimi-quota-probe.js 同口径，
// 端点来自 @moonshot-ai/kimi-code 的 managed-usage）：
//
//	GET {base}/usages   Authorization: Bearer <access_token>
//	  → { usage:{used,remaining,limit,resetTime},
//	      limits:[{name,detail:{used,remaining,limit,resetTime},window:{duration,timeUnit}}],
//	      user:{membership:{level}}, boosterWallet }
//	GET {base}/me       （best-effort 身份，失败不影响额度结论）
//	  → { nickname, phone:{country_code,number}, user_level_name, user_level }
//	base 默认 https://api.kimi.com/coding/v1（Node 的 KIMI_CODE_BASE_URL）
//
// 三类结论都要区分：
//   - 解析出条目 → 正常快照；
//   - 解析不出条目、且 /me 说当前是 Free 档 → 「没有付费配额池」是上游给出的**结论**，
//     不是采集失败：写 notApplicable 结论 + 空条目文档，替换掉缓存里已失效的旧套餐；
//   - 解析不出条目、又不是 Free 档 → 字段缺失，按采集失败返回。
//
// 本包只做采集：access_token 过期时**不刷新**（刷新属 lib/server/kimi-token-refresh.js 的
// 职责，迁移前不能半途接管），401 直接作为鉴权失败上报；桌面端套餐统计
// （GetSubscriptionStats）依赖桌面客户端会话，也不在本包范围内。
package usage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	providerID = "kimi"
	// defaultBaseURL 与 Node lib/account/kimi-endpoints.js 的 KIMI_CODE_BASE_URL 同值。
	defaultBaseURL = "https://api.kimi.com/coding/v1"
	// sourceID / documentKind 与 Node 的 USAGE_SOURCE_KIMI / USAGE_SNAPSHOT_KINDS.kimi 同值：
	// 账号可信度校验与 WebUI 渲染器都按这两个字面量匹配，不能各自起名。
	sourceID     = "kimi_oauth_usages_api"
	documentKind = "kimi_oauth_usage"
	// noPaidPlanReason 与 Node notApplicable 的 reason 同值。
	noPaidPlanReason = "kimi_free_plan_no_quota"

	usagePath   = "/usages"
	profilePath = "/me"

	// weeklyBucket / weeklyMinutes 与 Node 一致：summary（payload.usage）缺窗口时按 1 周处理。
	weeklyBucket  = "weekly"
	weeklyMinutes = 10080
	// unknownBucket 是「没有付费配额」结论在归一化快照里的占位桶。
	unknownBucket = "plan"

	// schemaVersion 与 Node USAGE_SNAPSHOT_SCHEMA_VERSION 同值。
	schemaVersion    = 2
	maxResponseBytes = 1 << 20
	// requestTimeout 对齐 Node DEFAULT_PROBE_TIMEOUT_MS（8s）。
	requestTimeout = 8 * time.Second

	// clientVersionFallback 是兜底自报版本，与 Node DEFAULT_KIMI_CODE_VERSION 同值。
	// 真实版本由组合根按本机 CLI 解析后通过 Options 注入。
	clientVersionFallback = "0.36.0"
	kimiCodePlatform      = "kimi_code_cli"
	userAgentProduct      = "kimi-code-cli"
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输或端点不可用。
	ErrInvalidDependencies = errors.New("kimi 额度 Strategy 依赖无效")
	// ErrUnsupportedCredential 表示凭据里没有可用的 OAuth access token。
	ErrUnsupportedCredential = errors.New("kimi 额度 Strategy 凭据形态不支持")
	// ErrInvalidResponse 表示上游状态、大小或 JSON 结构不满足额度合同。
	ErrInvalidResponse = errors.New("kimi 额度响应无效")
	// ErrUnauthorized 表示上游以 401/403 拒绝当前令牌。
	ErrUnauthorized = errors.New("kimi 额度鉴权失败")
)

// freePlanPattern 与 Node isFreePlanIdentity 的 /^free\b/i 同判定：
// 「Free」「Free Plan」都算免费档，「Freebie」这类连写不算。
var freePlanPattern = regexp.MustCompile("(?i)^free\\b")

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Options 是可注入的端点与客户端身份参数。
//
// BaseURL / ClientVersion 都默认取 Node 侧常量；Host 是 host-derived 设备策略需要的
// 运行机器信息（默认策略不用它，因此零值安全）。
type Options struct {
	BaseURL       string
	ClientVersion string
	Host          kimiidentity.HostFacts
}

// Strategy 是 kimi 的额度策略。
type Strategy struct {
	client  HTTPClient
	baseURL string
	version string
	host    kimiidentity.HostFacts
}

var _ usageapp.ProviderSnapshotStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
func New(client HTTPClient, options Options) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, ErrInvalidDependencies
	}
	version := strings.TrimSpace(options.ClientVersion)
	if version == "" {
		version = clientVersionFallback
	}
	return &Strategy{
		client:  client,
		baseURL: baseURL,
		version: version,
		host:    options.Host,
	}, nil
}

// ProviderID 返回 kimi。
func (*Strategy) ProviderID() string { return providerID }

// MatchesModelFamily 表示 kimi 的 /usages 是账号级配额，没有模型族维度。
func (*Strategy) MatchesModelFamily(string, runtimecore.ModelID) bool { return false }

// FetchUsage 只返回归一化快照。
func (strategy *Strategy) FetchUsage(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	snapshot, _, err := strategy.FetchUsageWithDocument(ctx, accountRef, credential, capturedAt)
	return snapshot, err
}

// FetchUsageWithDocument 一次采集同时产出归一化快照与 WebUI 展示文档。
func (strategy *Strategy) FetchUsageWithDocument(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, *usagecore.Document, error) {
	if strategy == nil || strategy.client == nil || ctx == nil || !accountRef.IsValid() {
		return usagecore.Snapshot{}, nil, usageapp.ErrInvalidRequest
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != providerID {
		return usagecore.Snapshot{}, nil, usageapp.ErrUsageUnsupported
	}
	payload := native.Payload()
	material, err := readCredentialMaterial(payload)
	if err != nil {
		return usagecore.Snapshot{}, nil, err
	}

	headers := strategy.requestHeaders(accountRef, material)
	body, err := strategy.get(ctx, usagePath, headers)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	response, err := decodeUsage(body)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	// /me 只补身份与「是否 Free 档」：它失败时不能把一次可用采集判成失败。
	identity := strategy.probeIdentity(ctx, headers)
	entries := response.entries(capturedAt)
	result := probeResult{
		entries: entries,
		account: mergeAccount(identity, response.planType()),
	}
	// 免费档没有 /usages 档位，套餐名只能来自 /me 的 user_level_name
	// （与 Node noPaidPlanAccount 写 account.planType 同源）。
	planType := normalizePlanType(response.planType())
	if len(entries) == 0 {
		if !identity.isFreePlan() {
			// 有付费档却解析不出条目：字段缺失（上游形状变了），按失败上报而不是写空结论。
			return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
		}
		result.notApplicable = true
		result.account = noPaidPlanAccount(identity)
		planType = normalizePlanType(strings.ToLower(identity.planName))
	}

	snapshotEntries := make([]usagecore.EntryInput, 0, len(result.entries)+1)
	if result.notApplicable {
		// 归一化快照至少要一条条目：写「剩余未知」的账号级窗口，清掉旧额度权重。
		snapshotEntries = append(snapshotEntries, unknownEntry())
	}
	for _, entry := range result.entries {
		snapshotEntries = append(snapshotEntries, entry.input())
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     sourceID,
		PlanType:   planType,
		CapturedAt: capturedAt,
		Entries:    snapshotEntries,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	view, err := result.document(capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    view,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &document, nil
}

// credentialMaterial 是从原生凭据文档取出的请求所需最小事实。
type credentialMaterial struct {
	accessToken string
	deviceID    string
	profile     kimiidentity.Profile
}

// readCredentialMaterial 解析 kimi 原生凭据。
//
// Node 侧会先用 refresh_token 续期再探测；本包**不刷新**，因此只接受已落盘的
// access_token，缺失一律按凭据形态不支持处理（调用方据此跳过或等刷新器先跑）。
func readCredentialMaterial(payload []byte) (credentialMaterial, error) {
	var document map[string]any
	if json.Unmarshal(payload, &document) != nil || document == nil {
		return credentialMaterial{}, ErrUnsupportedCredential
	}
	section := oauthSection(document)
	accessToken := firstText(section, "access_token", "accessToken")
	if accessToken == "" {
		// API Key 账号没有托管配额端点：Node 同样返回 api_key_mode_not_applicable。
		if hasEnvironmentAPIKey(document) {
			return credentialMaterial{}, usageapp.ErrUsageUnsupported
		}
		return credentialMaterial{}, ErrUnsupportedCredential
	}
	deviceID := firstNonEmpty(
		firstText(section, "device_id", "deviceId"),
		kimiidentity.CredentialDeviceID(payload),
	)
	return credentialMaterial{
		accessToken: accessToken,
		deviceID:    deviceID,
		profile:     kimiidentity.ParseProfile(kimiidentity.DeviceProfileSection(payload)),
	}, nil
}

// oauthSection 按 Node readKimiOAuthCredentials 的优先级选登录快照：
// 优先能恢复的 canonical credentials，其次完整回退到 legacy auth，最后才用顶层扁平形态。
func oauthSection(document map[string]any) map[string]any {
	credentials := objectOf(document["credentials"])
	legacy := objectOf(document["auth"])
	if credentials != nil && firstText(credentials, "refresh_token", "refreshToken") != "" {
		return credentials
	}
	if legacy != nil && firstText(legacy, "refresh_token", "refreshToken") != "" {
		return legacy
	}
	if credentials != nil {
		return credentials
	}
	if legacy != nil {
		return legacy
	}
	return document
}

// hasEnvironmentAPIKey 判断凭据是否带了 kimi API Key（与环境变量槽位同名）。
func hasEnvironmentAPIKey(document map[string]any) bool {
	env := objectOf(document["env"])
	if env == nil {
		return false
	}
	for _, key := range []string{"MOONSHOT_API_KEY", "KIMI_API_KEY"} {
		if value, ok := env[key].(string); ok && strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// requestHeaders 构造与 Node buildKimiRequestHeaders 同形的请求头。
//
// 缺 X-Msh-* 设备头时上游按「非官方客户端」对待，因此这些头不是可选项；
// 设备 id 的解析顺序与 Node 一致：凭据声明的官方 id > 账号设备策略。
func (strategy *Strategy) requestHeaders(
	accountRef accountcore.AccountRef,
	material credentialMaterial,
) http.Header {
	headers := http.Header{}
	headers.Set("Accept", "application/json")
	headers.Set("Authorization", "Bearer "+material.accessToken)
	headers.Set("User-Agent", userAgentProduct+"/"+strategy.version)
	headers.Set("X-Msh-Platform", kimiCodePlatform)
	headers.Set("X-Msh-Version", strategy.version)
	device := kimiidentity.ResolveDeviceHeaders(
		accountRef.String(),
		material.profile,
		material.deviceID,
		strategy.host,
	)
	for name, value := range map[string]string{
		"X-Msh-Device-Id":    device.DeviceID,
		"X-Msh-Device-Name":  device.DeviceName,
		"X-Msh-Device-Model": device.DeviceModel,
		"X-Msh-Os-Version":   device.OSVersion,
	} {
		if value != "" {
			headers.Set(name, value)
		}
	}
	return headers
}

// get 发一次账号面 GET；错误里只带路径与状态码，绝不带凭据值。
func (strategy *Strategy) get(ctx context.Context, path string, headers http.Header) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, strategy.baseURL+path, nil)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response, err := strategy.client.Do(request)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, ErrInvalidResponse
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		statusErr := fmt.Errorf("%w: %s HTTP %d", ErrInvalidResponse, path, response.StatusCode)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			return nil, errors.Join(ErrUnauthorized, statusErr)
		}
		return nil, statusErr
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxResponseBytes {
		return nil, ErrInvalidResponse
	}
	return payload, nil
}

// probeIdentity 调 /me 补昵称、手机号与订阅品牌档；任何失败都按「没有身份」处理。
func (strategy *Strategy) probeIdentity(ctx context.Context, headers http.Header) identity {
	body, err := strategy.get(ctx, profilePath, headers)
	if err != nil {
		return identity{}
	}
	var payload struct {
		Nickname string `json:"nickname"`
		Phone    *struct {
			CountryCode string `json:"country_code"`
			Number      string `json:"number"`
		} `json:"phone"`
		UserLevelName string `json:"user_level_name"`
		UserLevel     any    `json:"user_level"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return identity{}
	}
	phone := ""
	if payload.Phone != nil {
		countryCode := strings.TrimSpace(payload.Phone.CountryCode)
		number := strings.TrimSpace(payload.Phone.Number)
		// 两段都空时不要产出孤零零的 "+"（Node 在这里会产出，展示层反而更糟）。
		if countryCode != "" || number != "" {
			phone = strings.TrimSpace("+" + countryCode + " " + number)
		}
	}
	level, _ := readFiniteNumber(payload.UserLevel)
	return identity{
		displayName: strings.TrimSpace(payload.Nickname),
		phone:       phone,
		planName:    strings.TrimSpace(payload.UserLevelName),
		planLevel:   int64(level),
	}
}

// identity 是 /me 返回的展示身份；全空表示没探到。
type identity struct {
	displayName string
	phone       string
	planName    string
	planLevel   int64
}

// isFreePlan 与 Node isFreePlanIdentity 同判定。
func (identity identity) isFreePlan() bool {
	return freePlanPattern.MatchString(identity.planName)
}

// usageResponse 只声明额度结论用到的字段。
type usageResponse struct {
	Usage  *usageBucket `json:"usage"`
	Limits []usageLimit `json:"limits"`
	User   struct {
		Membership struct {
			Level string `json:"level"`
		} `json:"membership"`
	} `json:"user"`
}

type usageLimit struct {
	Name   string       `json:"name"`
	Detail *usageBucket `json:"detail"`
	Window *usageWindow `json:"window"`
}

// usageBucket 的数值用 any 承接：上游对同一字段时而给数字时而给数字串
// （与 Node Number(...) 的容错同口径）。
type usageBucket struct {
	Used      any    `json:"used"`
	Remaining any    `json:"remaining"`
	Limit     any    `json:"limit"`
	ResetTime string `json:"resetTime"`
}

type usageWindow struct {
	Duration      any    `json:"duration"`
	TimeUnit      string `json:"timeUnit"`
	TimeUnitSnake string `json:"time_unit"`
}

func decodeUsage(body []byte) (usageResponse, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return usageResponse{}, ErrInvalidResponse
	}
	var response usageResponse
	if json.Unmarshal(body, &response) != nil {
		return usageResponse{}, ErrInvalidResponse
	}
	return response, nil
}

// kimiPlanTypes 与 Node lib/account/quota-reset/kimi-strategy.js 的词汇表一致。
var kimiPlanTypes = map[string]struct{}{
	"free":         {},
	"basic":        {},
	"level_1":      {},
	"level1":       {},
	"intermediate": {},
	"allegretto":   {},
	"level_2":      {},
	"level2":       {},
	"advanced":     {},
	"allegro":      {},
	"level_3":      {},
	"level3":       {},
}

// normalizePlanType 只保留 Node 词汇表里的档位；未知档位保持未知。
func normalizePlanType(rawLevel string) string {
	token := usagecore.NormalizePlanToken(rawLevel)
	if _, known := kimiPlanTypes[token]; known {
		return token
	}
	return ""
}

// planType 把内部枚举 LEVEL_INTERMEDIATE 换成展示用的 intermediate。
func (response usageResponse) planType() string {
	level := strings.TrimSpace(response.User.Membership.Level)
	if level == "" {
		return ""
	}
	const prefix = "LEVEL_"
	if len(level) >= len(prefix) && strings.EqualFold(level[:len(prefix)], prefix) {
		level = level[len(prefix):]
	}
	return strings.ToLower(level)
}

// entries 与 Node parseKimiUsagePayload 同序同口径：summary 在前，limits 依次在后。
func (response usageResponse) entries(capturedAt time.Time) []windowEntry {
	entries := make([]windowEntry, 0, len(response.Limits)+1)
	seen := make(map[string]struct{}, len(response.Limits)+1)
	if response.Usage != nil {
		if entry, ok := response.Usage.toEntry(weeklyBucket, weeklyMinutes, capturedAt); ok {
			entry.bucket = uniqueBucket(entry.bucket, seen)
			entries = append(entries, entry)
		}
	}
	for _, limit := range response.Limits {
		if limit.Detail == nil {
			continue
		}
		minutes := windowMinutes(limit.Window)
		entry, ok := limit.Detail.toEntry(
			normalizeBucket(limit.Name, minutes),
			minutes,
			capturedAt,
		)
		if !ok {
			continue
		}
		entry.bucket = uniqueBucket(entry.bucket, seen)
		entries = append(entries, entry)
	}
	return entries
}

// windowEntry 是一条窗口额度事实（快照条目与文档条目的共同来源）。
type windowEntry struct {
	bucket        string
	windowMinutes int64
	// remainingPct 为 nil 表示上游没给出可比的 limit，剩余未知。
	remainingPct *float64
	resetAt      time.Time
}

// toEntry 把一条 upstream 计数折算成窗口条目；三个数值全缺时视为无效条目。
func (bucket usageBucket) toEntry(
	name string,
	minutes int64,
	capturedAt time.Time,
) (windowEntry, bool) {
	used, hasUsed := readFiniteNumber(bucket.Used)
	remaining, hasRemaining := readFiniteNumber(bucket.Remaining)
	limit, hasLimit := readFiniteNumber(bucket.Limit)
	if !hasUsed && !hasRemaining && !hasLimit {
		return windowEntry{}, false
	}
	// remaining 是上游权威值，优先采用；缺失时才按 used/limit 推算，
	// 避免 summary 只带 remaining 时被误算成 100%。
	var percent *float64
	if hasLimit && limit > 0 {
		value := 0.0
		switch {
		case hasRemaining:
			value = remaining
		case hasUsed:
			value = limit - used
		}
		clamped := math.Max(0, math.Min(100, value*100/limit))
		percent = &clamped
	}
	return windowEntry{
		bucket:        name,
		windowMinutes: minutes,
		remainingPct:  percent,
		resetAt:       parseResetTime(bucket.ResetTime),
	}, true
}

// input 把展示条目换算成归一化快照条目。
func (entry windowEntry) input() usagecore.EntryInput {
	input := usagecore.EntryInput{
		Bucket:        entry.bucket,
		Kind:          usagecore.KindWindow,
		Scope:         usagecore.ScopeAccount,
		WindowSeconds: entry.windowMinutes * 60,
		ResetAt:       entry.resetAt,
		Availability:  usagecore.AvailabilityUnknown,
	}
	if entry.remainingPct == nil {
		return input
	}
	basisPoints := uint16(math.Round(math.Max(0, math.Min(100, *entry.remainingPct)) * 100))
	input.HasRemaining = true
	input.RemainingBasisPoints = basisPoints
	input.Availability = usagecore.AvailabilityAvailable
	if basisPoints == 0 {
		input.Availability = usagecore.AvailabilityExhausted
	}
	return input
}

// unknownEntry 是「没有付费配额」结论的占位：剩余未知，因此不影响账号可用性判定。
func unknownEntry() usagecore.EntryInput {
	return usagecore.EntryInput{
		Bucket:       unknownBucket,
		Kind:         usagecore.KindWindow,
		Scope:        usagecore.ScopeAccount,
		Availability: usagecore.AvailabilityUnknown,
	}
}

// probeResult 是一次采集的额度结论。
type probeResult struct {
	entries       []windowEntry
	account       map[string]any
	notApplicable bool
}

// document 生成与 Node kimi 快照同形的展示文档（schemaVersion=2）。
func (result probeResult) document(capturedAt time.Time) ([]byte, error) {
	entries := make([]map[string]any, 0, len(result.entries))
	for _, entry := range result.entries {
		var remainingPct any
		if entry.remainingPct != nil {
			remainingPct = *entry.remainingPct
		}
		entries = append(entries, map[string]any{
			"bucket":        entry.bucket,
			"windowMinutes": entry.windowMinutes,
			"window":        windowLabel(entry.windowMinutes),
			"remainingPct":  remainingPct,
			"resetIn":       resetIn(entry.resetAt, capturedAt),
			"resetAtMs":     resetAtMS(entry.resetAt),
		})
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"entries":       entries,
	}
	if len(result.account) > 0 {
		payload["account"] = result.account
	}
	// 结论要显式带出去：WebUI 据此显示「额度不适用」，而不是把空 entries 当采集中。
	if result.notApplicable {
		payload["notApplicable"] = true
		payload["reason"] = noPaidPlanReason
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// mergeAccount 合并 /me 身份与 /usages 的套餐等级，空值不落地。
func mergeAccount(identity identity, planType string) map[string]any {
	account := map[string]any{}
	if identity.displayName != "" {
		account["displayName"] = identity.displayName
	}
	if identity.phone != "" {
		account["phone"] = identity.phone
	}
	if identity.planName != "" {
		account["planName"] = identity.planName
	}
	if identity.planLevel > 0 {
		account["planLevel"] = identity.planLevel
	}
	if planType != "" {
		account["planType"] = planType
	}
	return account
}

// noPaidPlanAccount 是「当前没有付费配额池」结论里的账号事实：只有 /me 知道的部分。
func noPaidPlanAccount(identity identity) map[string]any {
	account := mergeAccount(identity, "")
	if identity.planName == "" {
		return account
	}
	account["planType"] = strings.ToLower(identity.planName)
	return account
}

// windowMinutes 把上游 {duration,timeUnit} 折算成分钟；认不出单位按 0（未知窗口）。
func windowMinutes(window *usageWindow) int64 {
	if window == nil {
		return 0
	}
	duration, ok := readFiniteNumber(window.Duration)
	if !ok || duration <= 0 {
		return 0
	}
	unit := strings.TrimSpace(window.TimeUnit)
	if unit == "" {
		unit = strings.TrimSpace(window.TimeUnitSnake)
	}
	switch strings.ToUpper(unit) {
	case "TIME_UNIT_MINUTE":
		return int64(duration)
	case "TIME_UNIT_HOUR":
		return int64(duration * 60)
	case "TIME_UNIT_DAY":
		return int64(duration * 1440)
	case "TIME_UNIT_WEEK":
		return int64(duration * 10080)
	default:
		return 0
	}
}

// normalizeBucket 把上游展示名（可能带空格、大小写、中文）压成额度合同允许的标识符。
func normalizeBucket(raw string, minutes int64) string {
	var builder strings.Builder
	previousDash := false
	for _, current := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case current >= 'a' && current <= 'z',
			current >= '0' && current <= '9',
			current == '_', current == '-', current == '.', current == ':':
			builder.WriteRune(current)
			previousDash = current == '-'
		default:
			if !previousDash {
				builder.WriteByte('-')
				previousDash = true
			}
		}
	}
	bucket := strings.Trim(builder.String(), "-")
	if bucket != "" {
		return bucket
	}
	if minutes > 0 {
		return "rolling_" + strconv.FormatInt(minutes, 10) + "m"
	}
	return unknownBucket
}

// uniqueBucket 保证同一快照里 (LimitID, Bucket) 唯一：上游可能给出重名窗口，
// 重名会让 NewSnapshot 整次拒绝，比多一个后缀更糟。
func uniqueBucket(bucket string, seen map[string]struct{}) string {
	if _, exists := seen[bucket]; !exists {
		seen[bucket] = struct{}{}
		return bucket
	}
	for index := 2; ; index++ {
		candidate := bucket + "_" + strconv.Itoa(index)
		if _, exists := seen[candidate]; !exists {
			seen[candidate] = struct{}{}
			return candidate
		}
	}
}

// windowLabel 与 Node formatWindowLabel 同文案（7days / 5h / 30m）。
func windowLabel(minutes int64) string {
	switch {
	case minutes <= 0:
		return ""
	case minutes%10080 == 0:
		return strconv.FormatInt(minutes/10080*7, 10) + "days"
	case minutes%1440 == 0:
		return strconv.FormatInt(minutes/1440, 10) + "days"
	case minutes%60 == 0:
		return strconv.FormatInt(minutes/60, 10) + "h"
	default:
		return strconv.FormatInt(minutes, 10) + "m"
	}
}

// resetIn 与 Node formatResetInFromIso 同文案。
func resetIn(resetAt time.Time, now time.Time) string {
	if resetAt.IsZero() {
		return ""
	}
	seconds := int64(resetAt.Sub(now).Seconds())
	if seconds < 0 {
		seconds = 0
	}
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60
	switch {
	case days > 0:
		return fmt.Sprintf("%dd%dh%dm", days, hours, minutes)
	case hours > 0:
		return fmt.Sprintf("%dh%dm", hours, minutes)
	default:
		return fmt.Sprintf("%dm", minutes)
	}
}

func resetAtMS(resetAt time.Time) int64 {
	if resetAt.IsZero() {
		return 0
	}
	return resetAt.UnixMilli()
}

// parseResetTime 只认 ISO-8601（上游 resetTime 的实际形态）；认不出按未知处理。
func parseResetTime(value string) time.Time {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}

// readFiniteNumber 承接上游「数字或数字串」的两种写法。
func readFiniteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// objectOf 只接受 JSON 对象；数组与 null 都视为缺失。
func objectOf(value any) map[string]any {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil
	}
	return object
}

// firstText 返回记录里第一个非空字符串字段。
func firstText(record map[string]any, keys ...string) string {
	if record == nil {
		return ""
	}
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
