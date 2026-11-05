// Package usage 把 Grok Build 的账单接口转换为额度快照与展示文档。
//
// 协议事实（与 Node lib/cli/services/usage/grok-quota-probe.js 同口径）：
//
//	GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
//	GET https://cli-chat-proxy.grok.com/v1/user?include=subscription
//	GET https://cli-chat-proxy.grok.com/v1/billing            （旧版账单，兜底）
//	  Authorization: Bearer <grok OAuth access token>
//	  Accept: application/json、x-xai-token-auth: xai-grok-cli
//	  → {config:{creditUsagePercent, currentPeriod:{start,end}, monthlyLimit, used}}
//
//	POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig
//	  Content-Type: application/grpc-web+proto、x-grpc-web: 1
//	  body: gRPC-Web 帧 [0x00 0x00 0x00 0x00 0x02 0x08 0x00]（proto 空消息 {1:0}）
//	  → gRPC-Web 帧；protobuf 1.1 = 已用百分比，1.8 = 账期，
//	    1.8.1 = 账期类型，1.8.2/1.8.3 = 周期起止时间，1.5 = 兜底恢复时间
//
// 为什么只用标准库就够：gRPC-Web 是**跑在 HTTP/1.1 上的 POST**，不需要 HTTP/2 或
// 第三方 gRPC 运行时；响应只用 varint / 长度前缀 / fixed32 三种 wire type，Node 侧
// 本来就是手写解码（lib/cli/services/usage/grok-billing-grpc.js），这里按同一份
// schema 白名单手写，避免为零依赖的额度探测引入 protobuf 代码生成。
//
// 采集语义按 Node 原样保留（每条都有真实教训）：
//   - 401 不在这里续期：服务层刷新器负责在探测前续期（与 kiro 同一位置），策略只把
//     鉴权失败作为 ErrUnauthorized 上报；
//   - 5xx / 408 视为「暂时不可用」，继续走 gRPC-Web 与旧账单兜底；4xx（含 429）
//     直接失败，不对一个明确拒绝我们的端点补发更多请求；
//   - gRPC 的数值与周期必须来自同一笔账单，不能把它的百分比套到 REST 的旧账期上；
//   - 没有 creditUsagePercent、但有账期时，额度必须保持未知而不是当成 0。
package usage

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	// providerID 是本策略唯一支持的规范 Provider。
	providerID = "grok"
	// documentKind 与 Node USAGE_SNAPSHOT_KINDS.grok 同值。
	documentKind = "grok_credit_usage"
	// sourceID 与 Node USAGE_SOURCE_GROK 同值。
	sourceID = "grok_build_billing_api"
	// creditsBucket 与 Node 快照条目一致：grok 只有一条 credits 额度。
	creditsBucket = "credits"

	billingURL       = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	legacyBillingURL = "https://cli-chat-proxy.grok.com/v1/billing"
	userURL          = "https://cli-chat-proxy.grok.com/v1/user?include=subscription"
	grpcBillingURL   = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"

	// maxJSONResponseBytes / maxGRPCResponseBytes 限制上游响应大小；
	// gRPC 侧与 Node 的 64 KiB 上限一致。
	maxJSONResponseBytes = 1 << 20
	maxGRPCResponseBytes = 64 << 10

	// requestTimeout 是主账单与身份接口的单次预算（Node 默认 8s）；
	// supplementaryTimeout 是补充接口（旧账单、gRPC-Web）的预算（Node 6s）。
	requestTimeout       = 8 * time.Second
	supplementaryTimeout = 6 * time.Second

	// schemaVersion 与 Node usageSnapshotSchemaVersion 当前的取值一致。
	schemaVersion = 2
)

var (
	// ErrInvalidDependencies 表示 Strategy 缺少 HTTP 传输。
	ErrInvalidDependencies = errors.New("grok 额度 Strategy 依赖无效")
	// ErrUnsupportedCredential 表示凭据形态没有额度接口（API Key 账号）。
	ErrUnsupportedCredential = errors.New("grok 凭据不适用于额度探测")
	// ErrInvalidResponse 表示上游状态、大小或结构不满足额度合同。
	ErrInvalidResponse = errors.New("grok 额度响应无效")
	// ErrUnauthorized 表示上游以 401 拒绝当前 access token。
	ErrUnauthorized = errors.New("grok 额度鉴权失败")

	errProtoTruncated = errors.New("protobuf 数据截断")
	errProtoInvalid   = errors.New("protobuf 字段无效")
	errProtoAmbiguous = errors.New("protobuf 字段歧义")
	errGRPCStatus     = errors.New("gRPC-Web 返回非 0 状态")
)

// grpcCreditsRequest 是 GetGrokCreditsConfig 的空请求帧：flag=0、长度=2、
// payload=[0x08 0x00]（proto3 字段 1 varint 0）。与 Node 逐字节一致。
var grpcCreditsRequest = []byte{0x00, 0x00, 0x00, 0x00, 0x02, 0x08, 0x00}

// HTTPClient 是额度 Strategy 唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Strategy 用 Grok OAuth 凭据读取官方账单接口。
type Strategy struct {
	client           HTTPClient
	billingURL       string
	legacyBillingURL string
	userURL          string
	grpcBillingURL   string
	// now 只用于 gRPC 账期有效性判断；Node 用 Date.now()，测试需要固定时钟。
	now func() time.Time
}

var _ usageapp.ProviderSnapshotStrategy = (*Strategy)(nil)

// New 创建生产端点上的额度策略。
func New(client HTTPClient) (*Strategy, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Strategy{
		client:           client,
		billingURL:       billingURL,
		legacyBillingURL: legacyBillingURL,
		userURL:          userURL,
		grpcBillingURL:   grpcBillingURL,
		now:              time.Now,
	}, nil
}

// ProviderID 返回 grok。
func (*Strategy) ProviderID() string { return providerID }

// MatchesModelFamily 表示 grok 的 credits 是账号级额度，没有模型族维度。
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
	auth, err := projectCredential(credential)
	if err != nil {
		return usagecore.Snapshot{}, nil, err
	}
	probe, err := strategy.fetch(ctx, auth)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	entry := usagecore.EntryInput{
		Bucket:        creditsBucket,
		Kind:          usagecore.KindCredits,
		Scope:         usagecore.ScopeAccount,
		WindowSeconds: int64(probe.entry.windowMinutes) * 60,
		Availability:  usagecore.AvailabilityUnknown,
	}
	if probe.entry.resetAtMS > 0 {
		entry.ResetAt = time.UnixMilli(probe.entry.resetAtMS).UTC()
	}
	if probe.entry.remainingPct != nil {
		remaining := math.Max(0, math.Min(100, *probe.entry.remainingPct))
		basisPoints := uint16(math.Round(remaining * 100))
		entry.HasRemaining = true
		entry.RemainingBasisPoints = basisPoints
		entry.Availability = usagecore.AvailabilityAvailable
		if basisPoints == 0 {
			entry.Availability = usagecore.AvailabilityExhausted
		}
	}
	// 套餐名按领域统一规则归一成小写 token（与 kiro/cline/qoder 等适配器一致）。
	planType := usagecore.NormalizePlanToken(probe.planName)
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Source:     sourceID,
		PlanType:   planType,
		CapturedAt: capturedAt,
		Entries:    []usagecore.EntryInput{entry},
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	payload, err := buildDocumentPayload(probe, planType, entry, capturedAt)
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, err)
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: providerID,
		Kind:       documentKind,
		Source:     sourceID,
		CapturedAt: capturedAt,
		Payload:    payload,
	})
	if err != nil {
		return usagecore.Snapshot{}, nil, errors.Join(usageapp.ErrRefreshFailed, ErrInvalidResponse)
	}
	return snapshot, &document, nil
}

// buildDocumentPayload 按 Node 快照原样投影展示文档。
//
// 字段名与 Node 的 grok 快照逐项一致，WebUI 不需要为 Go 侧另写渲染分支。
func buildDocumentPayload(
	probe probeResult,
	planType string,
	entry usagecore.EntryInput,
	capturedAt time.Time,
) ([]byte, error) {
	var remainingPct any
	if entry.HasRemaining {
		remainingPct = float64(entry.RemainingBasisPoints) / 100
	}
	payload := map[string]any{
		"schemaVersion": schemaVersion,
		"kind":          documentKind,
		"source":        sourceID,
		"capturedAt":    capturedAt.UnixMilli(),
		"account": map[string]any{
			"planType": planType,
			"planName": probe.planName,
			"email":    probe.email,
		},
		"entries": []map[string]any{{
			"bucket":        creditsBucket,
			"windowMinutes": probe.entry.windowMinutes,
			"window":        windowLabel(probe.entry.windowMinutes),
			"remainingPct":  remainingPct,
			"resetIn":       "",
			"resetAtMs":     probe.entry.resetAtMS,
		}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	return encoded, nil
}

// windowLabel 与 Node 的 minutes + "m" 一致（grok 从不输出 1h/7d 这类缩写）。
func windowLabel(minutes int) string {
	if minutes <= 0 {
		return ""
	}
	return strconv.Itoa(minutes) + "m"
}

// grokAuth 是出网所需的最小凭据投影。
type grokAuth struct {
	accessToken  string
	refreshToken string
	email        string
}

// projectCredential 只接受 grok 原生 OAuth 凭据。
//
// API Key 账号没有账单接口（Node 侧同一判定：api_key_mode_not_applicable），
// 因此按「凭据不适用」拒绝，而不是当成刷新失败反复记账。
func projectCredential(credential accountapp.Credential) (grokAuth, error) {
	if credential == nil || credential.ProviderID() != providerID {
		return grokAuth{}, usageapp.ErrUsageUnsupported
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return grokAuth{}, usageapp.ErrUsageUnsupported
	}
	auth, ok := parseGrokAuth(native.Payload())
	if !ok || auth.accessToken == "" {
		return grokAuth{}, usageapp.ErrUsageUnsupported
	}
	return auth, nil
}

// parseGrokAuth 从原生凭据文档里取出 OAuth 令牌。
//
// 文档形状（与 Node readGrokAuthProfile / grokrelay 的取法一致）：
//   - 单条 profile：{access_token, refresh_token, email}；
//   - grok CLI 的 auth 映射：{"<issuer>::<uuid>": {key, refresh_token, email}}；
//   - 兼容包裹层：{auth: <以上任一>} 或 {credentials: <以上任一>}。
//
// 映射里有多条 profile 时按 key 排序取第一条：JSON 对象在 Go 里没有插入顺序，
// 排序至少保证同一份凭据每次选到同一个身份（Node 取插入顺序的第一条）。
func parseGrokAuth(payload []byte) (grokAuth, bool) {
	var document map[string]json.RawMessage
	if json.Unmarshal(payload, &document) != nil || document == nil {
		return grokAuth{}, false
	}
	// flat API Key 账号：额度接口不适用，不能把 api_key 当 OAuth 令牌发出去。
	for _, key := range []string{"api_key", "apiKey"} {
		if rawText(document[key]) != "" {
			return grokAuth{}, false
		}
	}
	if auth, ok := profileFromRecord(document); ok {
		return auth, true
	}
	for _, wrapper := range []string{"auth", "credentials"} {
		if record := jsonObject(document[wrapper]); record != nil {
			if auth, ok := profileFromRecord(record); ok {
				return auth, true
			}
		}
	}
	return grokAuth{}, false
}

// profileFromRecord 先按直接字段取，再把记录当成 profile 映射遍历一层。
func profileFromRecord(record map[string]json.RawMessage) (grokAuth, bool) {
	direct := grokAuth{
		accessToken:  firstText(record, "access_token", "accessToken", "key"),
		refreshToken: firstText(record, "refresh_token", "refreshToken"),
		email:        firstText(record, "email"),
	}
	if direct.accessToken != "" || direct.refreshToken != "" {
		return direct, true
	}
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		profile := jsonObject(record[key])
		if profile == nil {
			continue
		}
		candidate := grokAuth{
			accessToken:  firstText(profile, "access_token", "accessToken", "key"),
			refreshToken: firstText(profile, "refresh_token", "refreshToken"),
			email:        firstText(profile, "email"),
		}
		if candidate.accessToken != "" || candidate.refreshToken != "" {
			return candidate, true
		}
	}
	return grokAuth{}, false
}

// probeResult 是一次采集的中间结论。
type probeResult struct {
	entry    billingEntry
	planName string
	email    string
}

// fetch 主账单 → 身份 → gRPC-Web / 旧账单兜底，与 Node 的分支顺序一致。
func (strategy *Strategy) fetch(ctx context.Context, auth grokAuth) (probeResult, error) {
	primary, primaryErr := strategy.requestJSON(ctx, strategy.billingURL, auth.accessToken, requestTimeout)
	primaryError := ErrInvalidResponse
	if primaryErr == nil && primary != nil && primary.ok {
		primaryError = nil
	} else if primaryErr == nil && primary != nil {
		primaryError = fmt.Errorf("%w: HTTP %d", ErrInvalidResponse, primary.status)
	}
	// 明确的客户端错误不再兜底：认证拒绝按鉴权失败上报，其余直接失败。
	// 408 与 5xx 属于「这一次不行」，继续试独立的补充端点。
	if primaryErr == nil && primary != nil && !primary.ok &&
		primary.status != http.StatusRequestTimeout && primary.status < 500 {
		if primary.status == http.StatusUnauthorized {
			return probeResult{}, errors.Join(ErrUnauthorized, primaryError)
		}
		return probeResult{}, primaryError
	}
	var entry *billingEntry
	if primaryErr == nil && primary != nil && primary.ok {
		entry = parseBillingBody(primary.body)
	}
	user := strategy.fetchUser(ctx, auth.accessToken)
	if entry == nil || entry.remainingPct == nil {
		if grpcEntry, ok := strategy.fetchGRPCWeb(ctx, auth.accessToken); ok {
			entry = grpcEntry
		} else if legacyEntry := strategy.fetchLegacyBilling(ctx, auth.accessToken); legacyEntry != nil {
			entry = legacyEntry
		}
	}
	if entry == nil {
		if primaryError != nil {
			return probeResult{}, primaryError
		}
		return probeResult{}, ErrInvalidResponse
	}
	email := strings.TrimSpace(user.email)
	if email == "" {
		email = strings.TrimSpace(auth.email)
	}
	return probeResult{entry: *entry, planName: user.planName, email: email}, nil
}

// grokUser 是身份接口里额度展示需要的字段。
type grokUser struct {
	email    string
	planName string
}

// fetchUser 读取邮箱与订阅层级；失败不影响已经取得的账单周期。
func (strategy *Strategy) fetchUser(ctx context.Context, token string) grokUser {
	result, err := strategy.requestJSON(ctx, strategy.userURL, token, requestTimeout)
	if err != nil || result == nil || !result.ok {
		return grokUser{}
	}
	document := jsonObject(result.body)
	if document == nil {
		return grokUser{}
	}
	return grokUser{
		email:    firstText(document, "email"),
		planName: firstText(document, "subscriptionTier"),
	}
}

// fetchLegacyBilling 读取旧版账单；只有拿到明确剩余比例才算有效。
func (strategy *Strategy) fetchLegacyBilling(ctx context.Context, token string) *billingEntry {
	result, err := strategy.requestJSON(ctx, strategy.legacyBillingURL, token, supplementaryTimeout)
	if err != nil || result == nil || !result.ok {
		return nil
	}
	entry := parseBillingBody(result.body)
	if entry == nil || entry.remainingPct == nil {
		return nil
	}
	return entry
}

// httpResult 是主账单/身份/旧账单共用的响应投影。
type httpResult struct {
	status int
	ok     bool
	body   []byte
}

// requestJSON 发送带 grok 身份头的 GET 请求。
func (strategy *Strategy) requestJSON(
	ctx context.Context,
	endpoint string,
	token string,
	budget time.Duration,
) (*httpResult, error) {
	requestCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrInvalidResponse
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	// 这个头是 Grok CLI 账单面识别客户端形态的既有约定，缺了会被当成网页会话。
	request.Header.Set("x-xai-token-auth", "xai-grok-cli")
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
	body, err := io.ReadAll(io.LimitReader(response.Body, maxJSONResponseBytes+1))
	if err != nil || len(body) > maxJSONResponseBytes {
		return nil, ErrInvalidResponse
	}
	return &httpResult{
		status: response.StatusCode,
		ok:     response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices,
		body:   body,
	}, nil
}

// billingEntry 是三种账单来源归一后的最小事实。
type billingEntry struct {
	remainingPct  *float64
	windowMinutes int
	resetAtMS     int64
}

// parseBillingBody 解析 REST 账单。
//
// 优先级与 Node 一致：creditUsagePercent 是权威百分比；没有时才用
// included limit 的 monthlyLimit/used 推算。onDemand 与钱包余额是旁路金额，
// 不能当成订阅额度，也不据此判定账号已耗尽。
func parseBillingBody(payload []byte) *billingEntry {
	var root map[string]json.RawMessage
	if json.Unmarshal(payload, &root) != nil || root == nil {
		return nil
	}
	config := jsonObject(root["config"])
	if config == nil {
		return nil
	}
	period := jsonObject(config["currentPeriod"])
	startAtMS := parseGrokTimeMS(firstText(period, "start"))
	if startAtMS == 0 {
		startAtMS = parseGrokTimeMS(firstText(config, "billingPeriodStart"))
	}
	resetAtMS := parseGrokTimeMS(firstText(period, "end"))
	if resetAtMS == 0 {
		resetAtMS = parseGrokTimeMS(firstText(config, "billingPeriodEnd"))
	}
	windowMinutes := 0
	if startAtMS > 0 && resetAtMS > startAtMS {
		windowMinutes = int(math.Round(float64(resetAtMS-startAtMS) / 60000))
	}
	var usedPct *float64
	if value := jsonNumber(config["creditUsagePercent"]); value != nil && *value >= 0 && *value <= 100 {
		usedPct = value
	}
	if usedPct == nil {
		limit := readBillingUnits(config["monthlyLimit"])
		used := readBillingUnits(config["used"])
		if limit != nil && *limit > 0 && used != nil {
			percent := math.Min(100, *used / *limit * 100)
			usedPct = &percent
		}
	}
	// 没有百分比、也没有任何周期事实时不产出条目：额度必须保持未知，
	// 不能拿一条空响应把上一份有效快照覆盖掉。
	if usedPct == nil && windowMinutes == 0 && resetAtMS <= 0 {
		return nil
	}
	entry := &billingEntry{windowMinutes: windowMinutes, resetAtMS: resetAtMS}
	if usedPct != nil {
		remaining := 100 - *usedPct
		entry.remainingPct = &remaining
	}
	return entry
}

// readBillingUnits 兼容数字、数字字符串与 {val: ...} 包装（旧账单两种都出现过）。
func readBillingUnits(raw json.RawMessage) *float64 {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if value := jsonNumber(raw); value != nil {
		if *value < 0 {
			return nil
		}
		return value
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		text = strings.TrimSpace(text)
		if text == "" {
			return nil
		}
		value, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return nil
		}
		return &value
	}
	if object := jsonObject(raw); object != nil {
		return readBillingUnits(object["val"])
	}
	return nil
}

// parseGrokTimeMS 解析上游时间戳。
//
// 只接受带时区的 RFC3339 与纯日期：JS 的 Date.parse 会把「无时区的本地时间」
// 按运行机器时区解释，Go 侧不复制这个隐式假设。
func parseGrokTimeMS(value string) int64 {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

// fetchGRPCWeb 读取官方 gRPC-Web 账单补充接口。
//
// 任何失败都返回 false：补充接口失败不能抹掉已取得的周期，也不能把有效 REST
// 凭据误标成失效。
func (strategy *Strategy) fetchGRPCWeb(ctx context.Context, token string) (*billingEntry, bool) {
	requestCtx, cancel := context.WithTimeout(ctx, supplementaryTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		strategy.grpcBillingURL,
		bytes.NewReader(grpcCreditsRequest),
	)
	if err != nil {
		return nil, false
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/grpc-web+proto")
	request.Header.Set("x-grpc-web", "1")
	request.Header.Set("x-user-agent", "connect-es/2.1.1")
	request.Header.Set("Origin", "https://grok.com")
	request.Header.Set("Referer", "https://grok.com/?_s=usage")
	response, err := strategy.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return nil, false
	}
	defer func() {
		_ = response.Body.Close()
	}()
	// trailers-only 响应把状态放在头里；有值且非 0 就是上游业务失败。
	if status := response.Header.Get("grpc-status"); status != "" && status != "0" {
		return nil, false
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxGRPCResponseBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxGRPCResponseBytes {
		return nil, false
	}
	return parseGRPCWebBilling(data, strategy.now().UnixMilli())
}

// protoField 是一个已解码的 protobuf 字段。
type protoField struct {
	number int
	wire   int
	value  uint64
	bytes  []byte
	fixed  float32
}

// billingMessages 是允许递归解码的消息路径白名单，与 Node 的 BILLING_MESSAGES
// 及 Grok 官方 proto3 descriptor 一致。未知 bytes 字段不参与额度推断。
var billingMessages = map[string]struct{}{
	"1":       {},
	"1.2":     {},
	"1.3":     {},
	"1.4":     {},
	"1.5":     {},
	"1.6":     {},
	"1.7":     {},
	"1.8":     {},
	"1.12":    {},
	"1.6.1":   {},
	"1.6.2":   {},
	"1.6.3":   {},
	"1.8.2":   {},
	"1.8.3":   {},
	"1.6.3.2": {},
	"1.6.3.3": {},
}

// parseGRPCWebBilling 解码 gRPC-Web 响应并换算剩余额度。
//
// 规则与 Node parseGrokBillingGrpcResponse 一致：只有完整 proto3 响应里的有效
// 当前周期才允许缺省 float=0；REST 缺字段不套用这条规则。
func parseGRPCWebBilling(data []byte, nowMS int64) (*billingEntry, bool) {
	payload, err := extractGRPCPayload(data)
	if err != nil {
		return nil, false
	}
	fieldsByPath := make(map[string][]protoField)
	if _, err := scanKnownMessages(payload, "", fieldsByPath); err != nil {
		return nil, false
	}
	root := fieldsByPath[""]
	if _, err := singleField(root, 1, 2); err != nil {
		return nil, false
	}
	config := fieldsByPath["1"]
	percentage, err := singleField(config, 1, 5)
	if err != nil {
		return nil, false
	}
	periodField, err := singleField(config, 8, 2)
	if err != nil {
		return nil, false
	}
	var period []protoField
	if periodField != nil {
		period = fieldsByPath["1.8"]
	}
	periodType, err := singleField(period, 1, 0)
	if err != nil {
		return nil, false
	}
	if _, err := singleField(period, 2, 2); err != nil {
		return nil, false
	}
	if _, err := singleField(period, 3, 2); err != nil {
		return nil, false
	}
	startAtMS := readTimestamp(fieldsByPath["1.8.2"])
	periodEndAtMS := readTimestamp(fieldsByPath["1.8.3"])
	activePeriod := (periodType != nil && (periodType.value == 1 || periodType.value == 2)) &&
		startAtMS > 0 && startAtMS <= nowMS && periodEndAtMS > nowMS
	hasFixed32 := false
	for _, fields := range fieldsByPath {
		for _, field := range fields {
			if field.wire == 5 {
				hasFixed32 = true
				break
			}
		}
		if hasFixed32 {
			break
		}
	}
	usedPct := math.NaN()
	if percentage != nil {
		usedPct = float64(percentage.fixed)
	} else if activePeriod && !hasFixed32 {
		usedPct = 0
	}
	if math.IsNaN(usedPct) || math.IsInf(usedPct, 0) || usedPct < 0 {
		return nil, false
	}
	remaining := 100 - math.Min(100, usedPct)
	resetAtMS := periodEndAtMS
	if resetAtMS == 0 {
		resetAtMS = readTimestamp(fieldsByPath["1.5"])
	}
	windowMinutes := 0
	if startAtMS > 0 && periodEndAtMS > startAtMS {
		windowMinutes = int(math.Round(float64(periodEndAtMS-startAtMS) / 60000))
	}
	return &billingEntry{
		remainingPct:  &remaining,
		windowMinutes: windowMinutes,
		resetAtMS:     resetAtMS,
	}, true
}

// extractGRPCPayload 处理 gRPC-Web 帧：数据帧只有一个，trailers 帧里
// grpc-status 非 0 视为失败。无帧头的裸消息按未分包处理（与 Node 一致）。
func extractGRPCPayload(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errProtoTruncated
	}
	if data[0] != 0 && data[0] != 0x80 {
		return data, nil
	}
	var payload []byte
	for offset := 0; offset < len(data); {
		if len(data)-offset < 5 {
			return nil, errProtoTruncated
		}
		flag := data[offset]
		if flag != 0 && flag != 0x80 {
			return nil, errProtoInvalid
		}
		length := int(binary.BigEndian.Uint32(data[offset+1 : offset+5]))
		start := offset + 5
		if length > len(data)-start {
			return nil, errProtoTruncated
		}
		frame := data[start : start+length]
		if flag == 0x80 {
			if err := checkGRPCTrailers(frame); err != nil {
				return nil, err
			}
		} else {
			if payload != nil {
				return nil, errProtoAmbiguous
			}
			payload = frame
		}
		offset = start + length
	}
	if payload == nil {
		return nil, errProtoTruncated
	}
	return payload, nil
}

// checkGRPCTrailers 只关心 grpc-status 行，其它 trailer（grpc-message 等）忽略。
func checkGRPCTrailers(frame []byte) error {
	for _, line := range strings.Split(string(frame), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if len(line) < len("grpc-status") || !strings.EqualFold(line[:len("grpc-status")], "grpc-status") {
			continue
		}
		rest := strings.TrimLeft(line[len("grpc-status"):], " \t")
		if !strings.HasPrefix(rest, ":") {
			continue
		}
		if strings.TrimSpace(strings.TrimPrefix(rest, ":")) != "0" {
			return errGRPCStatus
		}
	}
	return nil
}

// scanKnownMessages 递归解码白名单消息，并把每个路径的字段留在 fieldsByPath。
func scanKnownMessages(
	payload []byte,
	key string,
	fieldsByPath map[string][]protoField,
) ([]protoField, error) {
	fields, err := readProtoFields(payload)
	if err != nil {
		return nil, err
	}
	fieldsByPath[key] = fields
	for _, field := range fields {
		childKey := strconv.Itoa(field.number)
		if key != "" {
			childKey = key + "." + strconv.Itoa(field.number)
		}
		if field.wire != 2 {
			continue
		}
		if _, known := billingMessages[childKey]; !known {
			continue
		}
		if _, err := scanKnownMessages(field.bytes, childKey, fieldsByPath); err != nil {
			return nil, err
		}
	}
	return fields, nil
}

// readProtoFields 解码一层 protobuf 消息（wire type 0/1/2/5）。
func readProtoFields(payload []byte) ([]protoField, error) {
	fields := make([]protoField, 0, 4)
	for offset := 0; offset < len(payload); {
		tag, consumed := binary.Uvarint(payload[offset:])
		if consumed <= 0 {
			return nil, errProtoTruncated
		}
		offset += consumed
		number := int(tag >> 3)
		wire := int(tag & 7)
		if number == 0 || number > 536_870_911 {
			return nil, errProtoInvalid
		}
		field := protoField{number: number, wire: wire}
		switch wire {
		case 0:
			value, length := binary.Uvarint(payload[offset:])
			if length <= 0 {
				return nil, errProtoTruncated
			}
			offset += length
			field.value = value
		case 1:
			if len(payload)-offset < 8 {
				return nil, errProtoTruncated
			}
			offset += 8
		case 2:
			length, consumed := binary.Uvarint(payload[offset:])
			if consumed <= 0 {
				return nil, errProtoTruncated
			}
			offset += consumed
			if length > uint64(len(payload)-offset) {
				return nil, errProtoTruncated
			}
			field.bytes = payload[offset : offset+int(length)]
			offset += int(length)
		case 5:
			if len(payload)-offset < 4 {
				return nil, errProtoTruncated
			}
			field.fixed = math.Float32frombits(binary.LittleEndian.Uint32(payload[offset:]))
			offset += 4
		default:
			return nil, errProtoInvalid
		}
		fields = append(fields, field)
	}
	return fields, nil
}

// singleField 拒绝重复字段与 wire type 不符：歧义响应不能用来推断额度。
func singleField(fields []protoField, number int, wire int) (*protoField, error) {
	var match *protoField
	matches := 0
	for index := range fields {
		if fields[index].number != number {
			continue
		}
		matches++
		match = &fields[index]
	}
	if matches > 1 {
		return nil, errProtoAmbiguous
	}
	if match != nil && match.wire != wire {
		return nil, errProtoInvalid
	}
	return match, nil
}

// readTimestamp 把 google.protobuf.Timestamp 转成毫秒；非法值返回 0。
func readTimestamp(fields []protoField) int64 {
	if fields == nil {
		return 0
	}
	seconds, err := singleField(fields, 1, 0)
	if err != nil || seconds == nil || seconds.value == 0 {
		return 0
	}
	if seconds.value > uint64(math.MaxInt64/1000) {
		return 0
	}
	var nanos uint64
	if nanoField, err := singleField(fields, 2, 0); err != nil {
		return 0
	} else if nanoField != nil {
		nanos = nanoField.value
	}
	if nanos > 999_999_999 {
		return 0
	}
	return int64(seconds.value)*1000 + int64(nanos)/1e6
}

// jsonObject 只在值确实是 JSON 对象时返回它；数组、标量与 null 都返回 nil。
func jsonObject(raw json.RawMessage) map[string]json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil
	}
	return object
}

// jsonNumber 只接受 JSON number（Node 同样要求 typeof === 'number'）。
func jsonNumber(raw json.RawMessage) *float64 {
	if len(raw) == 0 {
		return nil
	}
	var value float64
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

// rawText 把 JSON 字符串去空白返回；其它类型返回空串。
func rawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

// firstText 返回第一个非空字符串字段。
func firstText(record map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		if text := rawText(record[key]); text != "" {
			return text
		}
	}
	return ""
}
