package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 本文件是 §7-d 双读比对的 Go 侧 oracle。
//
// 输入是 Node 真实状态事件日志的逐条回放，输出是「每一步之后的 runtimeState +
// 派生状态」。转移本身完全复用 core/accounts.ApplyStatusEvent，这里只做两件事：
//   - 把请求里的 Node 文档形状翻译成 core/accounts 的领域类型；
//   - 把结果再翻译回 Node 文档形状（毫秒、routingBlock.recheck、空 map 等）。
//
// 为什么映射不放进 core/accounts：领域包不应承担传输格式；而且 Node 侧文档字段是
// 双读比对的对象，集中在一处才能保证「读入」和「写出」用的是同一套字段名。

const (
	// statusBlockRecheckInterval 必须等于 Node 的 ROUTING_BLOCK_RECHECK_MS。
	// 上游没有给出恢复时刻的路由阻塞会用 observedAt + 这个间隔补齐 until；
	// 两端不一致时，夹具里每个 routingBlock.until 都会漂移。
	statusBlockRecheckInterval = 30 * time.Second

	// maxOracleLineBytes 覆盖单个 runtimeState 带满按模型记录的情况（协议上限 5MiB）。
	maxOracleLineBytes = 5 << 20
)

// oracleRequest 是一条事件回放请求。
// initial 与 step.state 保留原始 JSON：null 与「字段缺失」的语义都必须能区分。
type oracleRequest struct {
	ID       string          `json:"id"`
	Provider string          `json:"provider"`
	Initial  json.RawMessage `json:"initial"`
	Steps    []oracleStep    `json:"steps"`
}

type oracleStep struct {
	Op       string          `json:"op"`
	AtMs     int64           `json:"atMs"`
	Failure  *oracleFailure  `json:"failure"`
	Evidence string          `json:"evidence"`
	State    json.RawMessage `json:"state"`
}

type oracleFailure struct {
	Kind                string `json:"kind"`
	Reason              string `json:"reason"`
	CooldownMs          int64  `json:"cooldownMs"`
	RoutingBlockRecheck string `json:"routingBlockRecheck"`
}

// oracleResponse 一行输出。results 在出错时必须是空数组而不是 null：
// 采集脚本按长度对步骤，null 会让「这一行没有结果」和「没有步骤」混在一起。
type oracleResponse struct {
	ID      string         `json:"id"`
	Results []oracleResult `json:"results"`
	Error   string         `json:"error"`
}

type oracleResult struct {
	AtMs         int64             `json:"atMs"`
	RuntimeState *nodeRuntimeState `json:"runtimeState"`
	Status       string            `json:"status"`
	Error        string            `json:"error"`
}

// nodeRuntimeState 是 Node runtime_state 文档的逐字段投影，读入与写出共用。
// 字段顺序按 Node JSON.stringify 的稳定顺序排列，方便人工对照日志。
type nodeRuntimeState struct {
	ModelCooldowns          map[string]int64                  `json:"modelCooldowns"`
	ModelFailureStreaks     map[string]nodeModelFailureStreak `json:"modelFailureStreaks"`
	CooldownUntil           int64                             `json:"cooldownUntil"`
	ConsecutiveFailures     int                               `json:"consecutiveFailures"`
	SuccessCount            int                               `json:"successCount"`
	FailCount               int                               `json:"failCount"`
	LastError               string                            `json:"lastError"`
	LastFailureKind         string                            `json:"lastFailureKind"`
	LastFailureReason       string                            `json:"lastFailureReason"`
	LastFailureAt           int64                             `json:"lastFailureAt"`
	LastSuccessAt           int64                             `json:"lastSuccessAt"`
	RateLimitUntil          int64                             `json:"rateLimitUntil"`
	AuthInvalidUntil        int64                             `json:"authInvalidUntil"`
	OverloadUntil           int64                             `json:"overloadUntil"`
	NetworkUntil            int64                             `json:"networkUntil"`
	ServiceUnavailableUntil int64                             `json:"serviceUnavailableUntil"`
	UpstreamErrorUntil      int64                             `json:"upstreamErrorUntil"`
	RoutingBlock            *nodeRoutingBlock                 `json:"routingBlock"`
}

// nodeRoutingBlock 与 Node normalizeRoutingBlock 的输出同形：
// recheck='manual' 的阻塞没有 until，其余阻塞必须带 until。
type nodeRoutingBlock struct {
	Kind       string `json:"kind"`
	Reason     string `json:"reason"`
	ObservedAt int64  `json:"observedAt"`
	Until      *int64 `json:"until,omitempty"`
	Recheck    string `json:"recheck,omitempty"`
}

// nodeModelFailureStreak 与 Node normalizeModelFailureStreakMap 的输出同形：
// observedAt 为 0 时 Node 不写这个字段，所以这里用 omitempty。
type nodeModelFailureStreak struct {
	Kind       string `json:"kind"`
	Count      int    `json:"count"`
	ExpiresAt  int64  `json:"expiresAt"`
	Reason     string `json:"reason"`
	ObservedAt int64  `json:"observedAt,omitempty"`
}

// handleOracleLine 处理一行请求，永不返回 nil：解析失败也要回一条带 id（可能为空）
// 的错误响应，让调用方能把错误对回日志行。
func handleOracleLine(line []byte) oracleResponse {
	response := oracleResponse{Results: []oracleResult{}}
	var request oracleRequest
	// 信封层不用 DisallowUnknownFields：多出的元数据（例如采集器加的 name）不影响
	// 状态语义；runtime_state 文档内部仍然严格校验，见 parseNodeRuntimeState。
	if err := json.Unmarshal(line, &request); err != nil {
		response.Error = fmt.Sprintf("解析请求 JSON 失败: %v", err)
		return response
	}
	response.ID = request.ID
	if request.Provider == "" {
		response.Error = "请求缺少 provider"
		return response
	}

	initial, err := parseNodeRuntimeState(request.Initial)
	if err != nil {
		response.Error = fmt.Sprintf("解析 initial 失败: %v", err)
		return response
	}
	current := accountcore.StatusState{}
	if initial != nil {
		current = *initial
	}
	policy := accountcore.StatusPolicy{
		Provider:             request.Provider,
		BlockRecheckInterval: statusBlockRecheckInterval,
	}

	for index, step := range request.Steps {
		event, err := statusEventFromStep(step)
		if err != nil {
			response.Results = []oracleResult{}
			response.Error = fmt.Sprintf("第 %d 步 (%s): %v", index+1, step.Op, err)
			return response
		}
		next, err := accountcore.ApplyStatusEvent(current, event, policy)
		if err != nil {
			// 契约规定出错行返回 results:[]；已经算出的前缀步骤一并丢弃，
			// 避免调用方把半截结果当成本行完整结论。
			response.Results = []oracleResult{}
			response.Error = fmt.Sprintf("第 %d 步 (%s @%d): %v", index+1, step.Op, step.AtMs, err)
			return response
		}
		current = next
		response.Results = append(response.Results, oracleResult{
			AtMs:         step.AtMs,
			RuntimeState: statusStateToNode(current),
			Status:       oracleStatus(current, event.At),
			Error:        "",
		})
	}
	return response
}

// statusEventFromStep 把协议步骤翻译成 core/accounts 的事件。
//
// clear 的证据名原样作为 StatusEventKind，不做第二套白名单：有效性由
// ApplyStatusEvent 决定，否则 oracle 会和真实写入路径对「哪些证据有效」各说一套。
func statusEventFromStep(step oracleStep) (accountcore.StatusEvent, error) {
	at := timeFromUnixMilli(step.AtMs)
	switch step.Op {
	case "failure":
		if step.Failure == nil {
			return accountcore.StatusEvent{}, errors.New("failure 步骤缺少 failure 载荷")
		}
		return accountcore.StatusEvent{
			Kind: accountcore.StatusEventRuntimeFailure,
			At:   at,
			Failure: &accountcore.StatusFailure{
				Kind:     step.Failure.Kind,
				Reason:   step.Failure.Reason,
				Cooldown: time.Duration(step.Failure.CooldownMs) * time.Millisecond,
				// Node 用 routingBlockRecheck === 'manual' 判断是否只认人工恢复；
				// 其它值（含 null）都按带 until 的定时阻塞处理。
				RecheckManual: step.Failure.RoutingBlockRecheck == "manual",
			},
		}, nil
	case "clear":
		return accountcore.StatusEvent{
			Kind: accountcore.StatusEventKind(step.Evidence),
			At:   at,
		}, nil
	case "runtime_state":
		state, err := parseNodeRuntimeState(step.State)
		if err != nil {
			return accountcore.StatusEvent{}, err
		}
		return accountcore.StatusEvent{
			Kind:  accountcore.StatusEventRuntimeState,
			At:    at,
			State: state,
		}, nil
	default:
		return accountcore.StatusEvent{}, fmt.Errorf("未知步骤 op=%q", step.Op)
	}
}

// parseNodeRuntimeState 把 Node 文档翻译成领域类型；null / 缺失都表示「没有运行态」。
//
// 这里对未知字段报错而不是忽略：Node 新增一个时间桶时，静默忽略会让双读比对
// 看起来通过，但 Go 侧其实完全没有接住这条语义。
func parseNodeRuntimeState(raw json.RawMessage) (*accountcore.StatusState, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var node nodeRuntimeState
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&node); err != nil {
		return nil, fmt.Errorf("runtimeState 不是已知形状: %w", err)
	}
	state := node.toStatusState()
	return &state, nil
}

// toStatusState 逐字段搬运，时间从毫秒换成 time.Time。
//
// 0 与负数在 Node 里都表示「没有这个时刻」；不能用 time.UnixMilli(0)，
// 那是 1970-01-01，IsZero() 为 false，会让空时间桶看起来有效。
func (node nodeRuntimeState) toStatusState() accountcore.StatusState {
	state := accountcore.StatusState{
		CooldownUntil:           timeFromUnixMilli(node.CooldownUntil),
		ConsecutiveFailures:     node.ConsecutiveFailures,
		SuccessCount:            node.SuccessCount,
		FailCount:               node.FailCount,
		LastError:               node.LastError,
		LastFailureKind:         node.LastFailureKind,
		LastFailureReason:       node.LastFailureReason,
		LastFailureAt:           timeFromUnixMilli(node.LastFailureAt),
		LastSuccessAt:           timeFromUnixMilli(node.LastSuccessAt),
		RateLimitUntil:          timeFromUnixMilli(node.RateLimitUntil),
		AuthInvalidUntil:        timeFromUnixMilli(node.AuthInvalidUntil),
		OverloadUntil:           timeFromUnixMilli(node.OverloadUntil),
		NetworkUntil:            timeFromUnixMilli(node.NetworkUntil),
		ServiceUnavailableUntil: timeFromUnixMilli(node.ServiceUnavailableUntil),
		UpstreamErrorUntil:      timeFromUnixMilli(node.UpstreamErrorUntil),
	}
	// 空 map 与 nil map 在领域类型里语义相同；只在有条目时建 map，
	// 避免把 Node 的 {} 误当成一份有内容的文档。
	if len(node.ModelCooldowns) > 0 {
		state.ModelCooldowns = make(map[string]time.Time, len(node.ModelCooldowns))
		for model, until := range node.ModelCooldowns {
			state.ModelCooldowns[model] = timeFromUnixMilli(until)
		}
	}
	if len(node.ModelFailureStreaks) > 0 {
		state.ModelFailureStreaks = make(map[string]accountcore.StatusModelFailureStreak, len(node.ModelFailureStreaks))
		for model, streak := range node.ModelFailureStreaks {
			state.ModelFailureStreaks[model] = accountcore.StatusModelFailureStreak{
				Kind:       streak.Kind,
				Count:      streak.Count,
				ExpiresAt:  timeFromUnixMilli(streak.ExpiresAt),
				Reason:     streak.Reason,
				ObservedAt: timeFromUnixMilli(streak.ObservedAt),
			}
		}
	}
	if block := node.RoutingBlock; block != nil {
		mapped := &accountcore.StatusRoutingBlock{
			Kind:          block.Kind,
			Reason:        block.Reason,
			ObservedAt:    timeFromUnixMilli(block.ObservedAt),
			RecheckManual: block.Recheck == "manual",
		}
		if block.Until != nil {
			mapped.Until = timeFromUnixMilli(*block.Until)
		}
		// manual 阻塞即使文档里带了 until 也不使用，与 Node normalizeRoutingBlock 一致。
		if mapped.RecheckManual {
			mapped.Until = time.Time{}
		}
		state.RoutingBlock = mapped
	}
	return state
}

// statusStateToNode 把领域状态写回 Node 文档形状。
//
// runtimeState=null 是 Node 对「没有运行态文档」的表示；Go 用零值表示同一件事，
// 所以必须先判 IsZero，否则每个「清空」步骤都会拿全 0 对象去比 null。
func statusStateToNode(state accountcore.StatusState) *nodeRuntimeState {
	if state.IsZero() {
		return nil
	}
	node := &nodeRuntimeState{
		// Node 文档里始终是 {}；nil map 会被序列化成 null，破坏逐字段比对。
		ModelCooldowns:      map[string]int64{},
		ModelFailureStreaks: map[string]nodeModelFailureStreak{},
		// 零值字段必须显式写 0：Node 用 0 表示「没有这个时刻」，
		// 缺字段会让下游的字段级比对报 missing。
		CooldownUntil:           unixMilli(state.CooldownUntil),
		ConsecutiveFailures:     state.ConsecutiveFailures,
		SuccessCount:            state.SuccessCount,
		FailCount:               state.FailCount,
		LastError:               state.LastError,
		LastFailureKind:         state.LastFailureKind,
		LastFailureReason:       state.LastFailureReason,
		LastFailureAt:           unixMilli(state.LastFailureAt),
		LastSuccessAt:           unixMilli(state.LastSuccessAt),
		RateLimitUntil:          unixMilli(state.RateLimitUntil),
		AuthInvalidUntil:        unixMilli(state.AuthInvalidUntil),
		OverloadUntil:           unixMilli(state.OverloadUntil),
		NetworkUntil:            unixMilli(state.NetworkUntil),
		ServiceUnavailableUntil: unixMilli(state.ServiceUnavailableUntil),
		UpstreamErrorUntil:      unixMilli(state.UpstreamErrorUntil),
	}
	for model, until := range state.ModelCooldowns {
		node.ModelCooldowns[model] = unixMilli(until)
	}
	for model, streak := range state.ModelFailureStreaks {
		node.ModelFailureStreaks[model] = nodeModelFailureStreak{
			Kind:       streak.Kind,
			Count:      streak.Count,
			ExpiresAt:  unixMilli(streak.ExpiresAt),
			Reason:     streak.Reason,
			ObservedAt: unixMilli(streak.ObservedAt),
		}
	}
	if block := state.RoutingBlock; block != nil {
		mapped := &nodeRoutingBlock{
			Kind:       block.Kind,
			Reason:     block.Reason,
			ObservedAt: unixMilli(block.ObservedAt),
		}
		if block.RecheckManual {
			mapped.Recheck = "manual"
		} else {
			until := unixMilli(block.Until)
			mapped.Until = &until
		}
		node.RoutingBlock = mapped
	}
	return node
}

// oracleStatus 复刻 Node deriveAccountRuntimeStatus 的优先级。
//
// core/accounts 的 deriveStatus 没有导出（切换期不希望 UI 直接依赖运行态包），
// 而这里的输出必须和夹具里的 status 逐词一致，所以在 oracle 内镜像同一段顺序：
// routingBlock（含 manual 常驻）> 固定类型时间桶 > 通用 cooldownUntil > healthy。
// 特别注意 manual 阻塞没有 until，不能只比 until，否则「只认人工恢复」的账号
// 会被误判成 healthy。
func oracleStatus(state accountcore.StatusState, now time.Time) string {
	if state.IsZero() {
		// Node 在没有运行态文档时返回 unknown；Go 的零值就是那份 null。
		return "unknown"
	}
	if block := state.RoutingBlock; block != nil {
		if block.RecheckManual || block.Until.After(now) {
			return block.Kind
		}
	}
	ordered := []struct {
		status string
		until  time.Time
	}{
		{"auth_invalid", state.AuthInvalidUntil},
		{"rate_limited", state.RateLimitUntil},
		{"overloaded", state.OverloadUntil},
		{"transient_network", state.NetworkUntil},
		{"service_unavailable", state.ServiceUnavailableUntil},
		{"upstream_error", state.UpstreamErrorUntil},
	}
	for _, entry := range ordered {
		if entry.until.After(now) {
			return entry.status
		}
	}
	if state.CooldownUntil.After(now) {
		if state.LastFailureKind != "" {
			return state.LastFailureKind
		}
		return "cooling_down"
	}
	return "healthy"
}

// timeFromUnixMilli 把 Node 毫秒换成领域时间；0 与负数都是「没有时刻」。
func timeFromUnixMilli(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}

// unixMilli 是 timeFromUnixMilli 的逆：零值写 0，与 Node 的 Number(value) || 0 一致。
func unixMilli(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}
