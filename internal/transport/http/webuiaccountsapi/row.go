package webuiaccountsapi

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
)

// Row 是账号页的一行。
//
// 键名与 Node 的 /v0/webui/accounts 行逐一对应（camelCase）；只有 enabled / modelCount
// 两个键是 Go 附加的静态事实（Node 行没有），其余键名一字不改。键的存在规则也照抄：
// Node 用 "... || undefined" 省略的条件字段在这里用 omitempty，其余一律出现（空值即占位），
// 这样 Node 侧展开覆盖（{...nodeRow, ...goRow}）后不会凭空多键或少键。
type Row struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	DisplayID  string `json:"displayId,omitempty"`
	// Enabled 是账号启停的原始事实。Node 行只有派生的 status（up/down），而 status 在本切片留空，
	// 所以这里给出下一轮派生 status 的唯一静态来源（规则见 lib/server/account-row-sources.js）。
	Enabled     bool   `json:"enabled"`
	Status      string `json:"status"`
	DisplayName string `json:"displayName"`
	Configured  bool   `json:"configured"`
	APIKeyMode  bool   `json:"apiKeyMode"`
	IsDefault   bool   `json:"isDefault"`
	IsMobile    bool   `json:"isMobile"`

	// RemainingPct 取自 account_usage_snapshots 的物化剩余额度（bps / 100）。
	RemainingPct *float64 `json:"remainingPct"`
	// UsageSnapshot 是额度快照文档原文（payload_json 解析出的 JSON 对象），形状与 Node 行一致，
	// 前端直接按 capturedAt/entries/models 渲染窗口与剩余额度；没有快照或文档不可解析时为 null。
	UsageSnapshot any `json:"usageSnapshot"`

	// UpstreamErrorRules / UpstreamErrorGroupIds 是 Node 的调度规则（app-state），本切片留空。
	UpstreamErrorRules    []any `json:"upstreamErrorRules"`
	UpstreamErrorGroupIDs []any `json:"upstreamErrorGroupIds"`

	UpdatedAt int64  `json:"updatedAt"`
	PlanType  string `json:"planType"`
	PlanName  string `json:"planName,omitempty"`
	Region    string `json:"region,omitempty"`
	// ZcodeRegion 是 zcode 的服务区域（zai / bigmodel），与上面的 region（kimi 网络区域）不是一回事。
	ZcodeRegion  string `json:"zcodeRegion,omitempty"`
	Email        string `json:"email"`
	DisplayNames []any  `json:"displayNames"`
	LoginType    string `json:"loginType,omitempty"`

	TokenUsage any `json:"tokenUsage"`
	// TokenUsageSource 是 Node 的诊断字段（go / node），本切片留空。
	TokenUsageSource string `json:"tokenUsageSource"`

	AuthMode         string `json:"authMode"`
	AuthPending      bool   `json:"authPending"`
	AuthPendingStale bool   `json:"authPendingStale"`
	AuthPendingAgeMs int64  `json:"authPendingAgeMs"`
	BaseURL          string `json:"baseUrl"`

	CustomUpstream            bool  `json:"customUpstream"`
	WindowActivationSupported bool  `json:"windowActivationSupported"`
	AliasPoolParticipates     bool  `json:"aliasPoolParticipates"`
	ActivityActions           []any `json:"activityActions"`
	GatewayTargetSupported    bool  `json:"gatewayTargetSupported"`

	QuotaStatus string `json:"quotaStatus"`
	QuotaReason string `json:"quotaReason,omitempty"`

	SchedulableStatus string `json:"schedulableStatus"`
	SchedulableReason string `json:"schedulableReason,omitempty"`

	LastUsedAt    *int64 `json:"lastUsedAt,omitempty"`
	RuntimeStatus string `json:"runtimeStatus,omitempty"`
	RuntimeUntil  int64  `json:"runtimeUntil,omitempty"`
	RuntimeReason string `json:"runtimeReason,omitempty"`

	// ModelCount 是 Go 的有效模型数（account_models 里 inherit+可用或 force_enable 的行）。
	// Node 行没有这个键：它是本读模型给下一轮的附加事实，对拍时归为 extra。
	ModelCount int `json:"modelCount"`
}

// accountFact 是 SQL 读出的原始列，只在本包内流转。
type accountFact struct {
	AccountRef     string
	Provider       string
	CLIAccountID   int64
	Enabled        int64
	UpdatedAtMS    int64
	HasCredential  int64
	UIDisplayName  string
	UIAuthMode     string
	UIAPIKeyMode   int64
	UIOAuthPending int64
	UIBaseURL      string
	ProfileName    string
	ProfileEmail   string
	Subscription   string
	QuotaStatus    string
	QuotaReason    string
	RemainingBPS   int64
	HasRemaining   int64
	CapturedAtMS   int64
	// SnapshotPayload 是 account_usage_snapshots.payload_json 的原文；缺表/无快照时为空串。
	SnapshotPayload string
	IsDefault       int64
	ModelCount      int64
}

// filledRowFields 是 Go 独占事实派生的字段：调用方可以无条件采用。
//
// 判据是「写这张表的只有 Go」：accounts / account_credentials / account_profiles /
// account_defaults / account_models。写入方唯一，读出来的值就不会与 Node 打架。
var filledRowFields = []string{
	"provider",
	"accountRef",
	"displayId",
	"enabled",
	"email",
	"configured",
	"isDefault",
	"modelCount",
}

// approxRowFields 是 Go 也有值、但口径或时机由 Node 决定的字段：调用方优先用自己的值。
//
// 两类来源：
//  1. account_ui_state 是 Node 推上来的镜像（displayName / apiKeyMode / authMode /
//     baseUrl / oauth_pending，以及由 subscription_kind 派生的 planType），Node 本地状态可能更新；
//  2. Go 自己算的采集类标量（updatedAt / remainingPct / quotaStatus / quotaReason）
//     会随后台采集变化，与 Node 行缓存存在正常的时机差；usageSnapshot 同理——
//     它是某个采集时刻的文档，Node 缓存可能比这一份新。
var approxRowFields = []string{
	"displayName",
	"apiKeyMode",
	"authMode",
	"baseUrl",
	"authPending",
	"planType",
	"updatedAt",
	"remainingPct",
	"usageSnapshot",
	"quotaStatus",
	"quotaReason",
}

// unfilledRowFields 返回既不在 filled 也不在 approx 里的字段，即本切片的空占位。
//
// 从结构体反射派生而不是手写：新增字段忘了归类时，这里会自动把它算进 unfilled，
// 同时 TestRowFieldListsCoverEveryJSONKey 会失败，不会出现「字段悄悄没进契约」。
func unfilledRowFields() []string {
	classified := make(map[string]bool, len(filledRowFields)+len(approxRowFields))
	for _, field := range filledRowFields {
		classified[field] = true
	}
	for _, field := range approxRowFields {
		classified[field] = true
	}
	unfilled := make([]string, 0, len(allRowFields()))
	for _, field := range allRowFields() {
		if classified[field] {
			continue
		}
		unfilled = append(unfilled, field)
	}
	return unfilled
}

// allRowFields 按结构体声明顺序返回 Row 的全部 JSON 键。
func allRowFields() []string {
	rowType := reflect.TypeOf(Row{})
	fields := make([]string, 0, rowType.NumField())
	for index := 0; index < rowType.NumField(); index++ {
		name, _, _ := strings.Cut(rowType.Field(index).Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		fields = append(fields, name)
	}
	return fields
}

// newRow 把一条数据库事实翻译成账号页行。
//
// 翻译规则都贴着 Node 的 buildNodeBaseAccountRecord，避免两端各写一套语义：
//   - planType：apiKeyMode → api-key；否则取 subscription_kind，没有就 oauth；没凭据是 pending；
//   - updatedAt：已配置且非 API Key 时优先用额度快照的采集时间，否则用账号行更新时间；
//   - remainingPct：只有物化出数值剩余额度时才给值，否则 null（Node 的「未知」语义）；
//   - usageSnapshot：快照文档原样下发，解析不了就是 null，绝不因此中断整页。
func newRow(fact accountFact) Row {
	configured := fact.HasCredential != 0
	apiKeyMode := fact.UIAPIKeyMode != 0
	row := Row{
		Provider:              fact.Provider,
		AccountRef:            fact.AccountRef,
		DisplayID:             strconv.FormatInt(fact.CLIAccountID, 10),
		Enabled:               fact.Enabled != 0,
		DisplayName:           firstNonEmpty(fact.UIDisplayName, fact.ProfileName),
		Configured:            configured,
		APIKeyMode:            apiKeyMode,
		IsDefault:             fact.IsDefault != 0,
		Email:                 fact.ProfileEmail,
		AuthMode:              fact.UIAuthMode,
		AuthPending:           fact.UIOAuthPending != 0,
		BaseURL:               fact.UIBaseURL,
		QuotaStatus:           fact.QuotaStatus,
		QuotaReason:           fact.QuotaReason,
		ModelCount:            int(fact.ModelCount),
		UpstreamErrorRules:    []any{},
		UpstreamErrorGroupIDs: []any{},
		DisplayNames:          []any{},
		ActivityActions:       []any{},
	}
	row.PlanType = resolvePlanType(configured, apiKeyMode, fact.Subscription)
	row.UpdatedAt = resolveUpdatedAt(configured, apiKeyMode, fact.CapturedAtMS, fact.UpdatedAtMS)
	// API Key 账号没有 Provider 额度：Node 对它们一律不给剩余额度，这里同口径。
	if configured && !apiKeyMode && fact.HasRemaining != 0 {
		remaining := float64(fact.RemainingBPS) / 100
		row.RemainingPct = &remaining
	}
	row.UsageSnapshot = parseUsageSnapshot(fact.SnapshotPayload)
	return row
}

// parseUsageSnapshot 把 payload_json 原文解析成下发给前端的快照对象。
//
// 只有「非空 + 合法 JSON 对象」才给值：一行坏文档不能把整页打成 500，
// 所以这里吞掉解析错误而不是向上返回。空对象也按「没有快照」处理——
// 调用方用「usageSnapshot 是否为对象」判断 Go 有没有快照，下发 {} 会让它
// 以为有快照却读不到 capturedAt，进而把快照时效判成 0。
func parseUsageSnapshot(payload string) any {
	trimmed := strings.TrimSpace(payload)
	if trimmed == "" {
		return nil
	}
	var snapshot map[string]any
	if err := json.Unmarshal([]byte(trimmed), &snapshot); err != nil || len(snapshot) == 0 {
		return nil
	}
	return snapshot
}

// resolvePlanType 与 Node 的 planType 取值一致。
func resolvePlanType(configured, apiKeyMode bool, subscription string) string {
	if !configured {
		return "pending"
	}
	if apiKeyMode {
		return "api-key"
	}
	if planType := strings.TrimSpace(subscription); planType != "" {
		return planType
	}
	return "oauth"
}

// resolveUpdatedAt 复刻 Node 的取值优先级（快照采集时间 > 账号行更新时间）。
//
// Node 在这两级之间还有 probeCheckedAt，本切片不读探针表，所以只保留这两级。
func resolveUpdatedAt(configured, apiKeyMode bool, capturedAtMS, accountUpdatedAtMS int64) int64 {
	if configured && !apiKeyMode && capturedAtMS > 0 {
		return capturedAtMS
	}
	return accountUpdatedAtMS
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
