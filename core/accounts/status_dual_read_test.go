package accounts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"
)

// 本文件是 §7-d「状态推导双读比对」的 Go 侧执行器。
//
// 真值来源：scripts/status-dual-read-capture.js 用 Node 的**真实**实现
// （touchAccountFailureState / clearRuntimeBlock / clearAccountWideRuntimeState /
// deriveAccountRuntimeStatus）回放一组固定事件，把每一步之后的运行态与派生状态冻结进
// testdata/status-dual-read.json。这里用 core/accounts 的移植实现重放同一组事件，逐步比对。
//
// 为什么要把 Go 状态先序列化回「Node 形状」再比，而不是直接 reflect.DeepEqual：
//   - 双读阶段要证明的是「两端对外给出的文档一致」，而 Go 的表示习惯与 Node 不同
//     （nil map vs {}、time.Time 零值 vs 0、bool vs 'recheck' 字符串）。直接比较会把
//     表示差异误报成行为差异；
//   - 但也不能只比派生状态：某个时间桶没被清掉时 status 可能仍然相同，字段级漂移会被
//     掩盖。所以每个步骤都比两件事——规范化后的运行态文档（逐字段）与派生状态。
//
// 夹具是生成物：本文件只读它，任何不一致都应该先怀疑移植实现，而不是改夹具。

// dualReadFixture 对应 testdata/status-dual-read.json 的顶层结构。
type dualReadFixture struct {
	Version     int            `json:"version"`
	GeneratedBy string         `json:"generatedBy"`
	AccountRef  string         `json:"accountRef"`
	Cases       []dualReadCase `json:"cases"`
}

// dualReadCase 是一个事件序列。initial=null 表示从「没有运行态文档」开始。
type dualReadCase struct {
	Name     string          `json:"name"`
	Provider string          `json:"provider"`
	Initial  json.RawMessage `json:"initial"`
	Steps    []dualReadStep  `json:"steps"`
	Expected dualReadExpect  `json:"expected"`
}

type dualReadExpect struct {
	AfterEach []dualReadStepExpectation `json:"afterEach"`
}

// dualReadStep 是一条待回放的事件。state 只用于 runtime_state，evidence 只用于 clear。
type dualReadStep struct {
	Op       string           `json:"op"`
	AtMs     int64            `json:"atMs"`
	Failure  *dualReadFailure `json:"failure"`
	Evidence string           `json:"evidence"`
	State    json.RawMessage  `json:"state"`
}

type dualReadFailure struct {
	Kind                string `json:"kind"`
	Reason              string `json:"reason"`
	CooldownMs          int64  `json:"cooldownMs"`
	RoutingBlockRecheck string `json:"routingBlockRecheck"`
}

// dualReadStepExpectation 是 Node 在该步骤之后看到的快照。runtimeState 为 null 表示
// Node 侧文档已被清空（对应 Go 的 StatusState 零值）。
type dualReadStepExpectation struct {
	AtMs         int64           `json:"atMs"`
	RuntimeState json.RawMessage `json:"runtimeState"`
	Status       string          `json:"status"`
}

// dualReadNodeState 是 Node runtime_state 文档的逐字段投影，读（夹具 -> Go）与写
// （Go -> 比对形状）共用同一套字段名，避免两个方向各写一份而悄悄漂移。
//
// 解码时启用 DisallowUnknownFields：夹具一旦新增字段（例如 Node 加了新的时间桶），测试
// 会直接失败并要求显式接线，而不是默默忽略——忽略字段的双读比对没有意义。
type dualReadNodeState struct {
	ModelCooldowns          map[string]int64          `json:"modelCooldowns"`
	ModelFailureStreaks     map[string]dualReadStreak `json:"modelFailureStreaks"`
	CooldownUntil           int64                     `json:"cooldownUntil"`
	ConsecutiveFailures     int                       `json:"consecutiveFailures"`
	SuccessCount            int                       `json:"successCount"`
	FailCount               int                       `json:"failCount"`
	LastError               string                    `json:"lastError"`
	LastFailureKind         string                    `json:"lastFailureKind"`
	LastFailureReason       string                    `json:"lastFailureReason"`
	LastFailureAt           int64                     `json:"lastFailureAt"`
	LastSuccessAt           int64                     `json:"lastSuccessAt"`
	RateLimitUntil          int64                     `json:"rateLimitUntil"`
	AuthInvalidUntil        int64                     `json:"authInvalidUntil"`
	OverloadUntil           int64                     `json:"overloadUntil"`
	NetworkUntil            int64                     `json:"networkUntil"`
	ServiceUnavailableUntil int64                     `json:"serviceUnavailableUntil"`
	UpstreamErrorUntil      int64                     `json:"upstreamErrorUntil"`
	RoutingBlock            *dualReadRoutingBlock     `json:"routingBlock"`
}

// dualReadRoutingBlock 与 Node normalizeRoutingBlock 的输出同形：非人工复核的阻塞带
// until，人工复核的阻塞带 recheck:'manual' 且没有 until。
type dualReadRoutingBlock struct {
	Kind       string `json:"kind"`
	Reason     string `json:"reason"`
	ObservedAt int64  `json:"observedAt"`
	Until      *int64 `json:"until,omitempty"`
	Recheck    string `json:"recheck,omitempty"`
}

// dualReadStreak 与 Node normalizeModelFailureStreakMap 的输出同形：observedAt 只在
// 正数时出现，所以这里用 omitempty 让两个方向都对得上。
type dualReadStreak struct {
	Kind       string `json:"kind"`
	Count      int    `json:"count"`
	ExpiresAt  int64  `json:"expiresAt"`
	Reason     string `json:"reason"`
	ObservedAt int64  `json:"observedAt,omitempty"`
}

// TestStatusDualRead 逐个用例回放 Node 夹具，逐步比对运行态文档与派生状态。
func TestStatusDualRead(t *testing.T) {
	fixture := dualReadLoadFixture(t)
	if fixture.Version != 1 {
		t.Fatalf("夹具版本 %d 未登记：生成器与执行器必须一起升级", fixture.Version)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("夹具没有用例，双读比对没有覆盖")
	}
	for _, testCase := range fixture.Cases {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			dualReadRunCase(t, testCase)
		})
	}
}

func dualReadRunCase(t *testing.T, testCase dualReadCase) {
	t.Helper()
	if len(testCase.Steps) != len(testCase.Expected.AfterEach) {
		t.Fatalf("夹具自相矛盾：steps=%d afterEach=%d", len(testCase.Steps), len(testCase.Expected.AfterEach))
	}
	// policy 与生成器保持一致：BlockRecheckInterval 必须等于 Node 的
	// ROUTING_BLOCK_RECHECK_MS（30s），否则「上游没给恢复时刻」的路由阻塞会算出不同的
	// until，差异会出现在夹具的 routingBlock.until 上。
	policy := statusTestPolicy(testCase.Provider)

	var current StatusState
	if initial := dualReadStateFromJSON(t, testCase.Initial); initial != nil {
		current = *initial
	}

	for index, step := range testCase.Steps {
		expectation := testCase.Expected.AfterEach[index]
		if expectation.AtMs != step.AtMs {
			// 快照必须对应本步的事件时刻，否则下面的派生比对会拿错时钟。
			t.Fatalf("step %d: 夹具 atMs 不一致 step=%d expected=%d", index+1, step.AtMs, expectation.AtMs)
		}
		at := statusMS(step.AtMs)
		event := dualReadEvent(t, step, at)
		next, err := ApplyStatusEvent(current, event, policy)
		if err != nil {
			t.Fatalf("step %d (%s @%d): ApplyStatusEvent 返回错误: %v", index+1, step.Op, step.AtMs, err)
		}
		current = next

		var differences []string
		gotDocument := dualReadStateToNodeJSON(t, current)
		wantDocument := dualReadDecodeJSON(t, expectation.RuntimeState)
		dualReadDiff(gotDocument, wantDocument, "runtimeState", &differences)
		if got, want := dualReadDerivedStatus(current, expectation.AtMs), expectation.Status; got != want {
			differences = append(differences, fmt.Sprintf("status: got %s want %s", strconv.Quote(got), strconv.Quote(want)))
		}
		// 一次把该步骤的所有字段差异都报出来：只报第一处会让人反复重跑才能对齐整条链路。
		for _, difference := range differences {
			t.Errorf("case %s step %d (%s @%d): %s", testCase.Name, index+1, step.Op, step.AtMs, difference)
		}
	}
}

// dualReadLoadFixture 读取 Node 生成的真值夹具。
//
// 用 runtime.Caller 而不是固定相对路径：夹具在仓库根 testdata/ 下，本文件在
// core/accounts/，从源文件位置向上两级是唯一与 `go test ./core/accounts/` 的工作目录
// 无关的定位方式（例如 -C、被其它包测试驱动时都不会错）。
func dualReadLoadFixture(t *testing.T) dualReadFixture {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试源文件路径")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "testdata", "status-dual-read.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取夹具 %s: %v", path, err)
	}
	var fixture dualReadFixture
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("解析夹具 %s: %v", path, err)
	}
	return fixture
}

// dualReadEvent 把夹具条目翻译成 StatusEvent。
//
// 三个 op 与 Node 的四个写入口一一对应：failure -> recordRuntimeFailure，
// clear -> clearRuntimeBlock（证据名直接做 StatusEventKind），runtime_state ->
// recordRuntimeState（null 表示清空，对应 *StatusState = nil）。
func dualReadEvent(t *testing.T, step dualReadStep, at time.Time) StatusEvent {
	t.Helper()
	switch step.Op {
	case "failure":
		if step.Failure == nil {
			t.Fatalf("failure 步骤缺少 failure 载荷")
		}
		return StatusEvent{
			Kind: StatusEventRuntimeFailure,
			At:   at,
			Failure: &StatusFailure{
				Kind:     step.Failure.Kind,
				Reason:   step.Failure.Reason,
				Cooldown: time.Duration(step.Failure.CooldownMs) * time.Millisecond,
				// Node 用 policy.routingBlockRecheck === 'manual' 决定阻塞是否只认人工恢复。
				RecheckManual: step.Failure.RoutingBlockRecheck == "manual",
			},
		}
	case "clear":
		// 证据名就是两端并行比对的键，不做任何大小写或别名转换。
		return StatusEvent{Kind: StatusEventKind(step.Evidence), At: at}
	case "runtime_state":
		return StatusEvent{Kind: StatusEventRuntimeState, At: at, State: dualReadStateFromJSON(t, step.State)}
	default:
		t.Fatalf("未知步骤 op=%q", step.Op)
		return StatusEvent{}
	}
}

// dualReadStateFromJSON 把 Node runtime_state 文档映射成 StatusState。
// null / 缺失都表示没有运行态文档，返回 nil（调用方据此保留零值）。
func dualReadStateFromJSON(t *testing.T, raw json.RawMessage) *StatusState {
	t.Helper()
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var node dualReadNodeState
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&node); err != nil {
		t.Fatalf("解析 runtimeState: %v (%s)", err, trimmed)
	}

	state := StatusState{
		CooldownUntil:           dualReadTime(node.CooldownUntil),
		ConsecutiveFailures:     node.ConsecutiveFailures,
		SuccessCount:            node.SuccessCount,
		FailCount:               node.FailCount,
		LastError:               node.LastError,
		LastFailureKind:         node.LastFailureKind,
		LastFailureReason:       node.LastFailureReason,
		LastFailureAt:           dualReadTime(node.LastFailureAt),
		LastSuccessAt:           dualReadTime(node.LastSuccessAt),
		RateLimitUntil:          dualReadTime(node.RateLimitUntil),
		AuthInvalidUntil:        dualReadTime(node.AuthInvalidUntil),
		OverloadUntil:           dualReadTime(node.OverloadUntil),
		NetworkUntil:            dualReadTime(node.NetworkUntil),
		ServiceUnavailableUntil: dualReadTime(node.ServiceUnavailableUntil),
		UpstreamErrorUntil:      dualReadTime(node.UpstreamErrorUntil),
	}
	// 空 map 与 nil map 在 Go 侧是同一语义（normalizeStatusModelState 会把空的归一成
	// nil），这里只在有条目时建 map，避免把「Node 的空对象」误当成结构差异。
	if len(node.ModelCooldowns) > 0 {
		state.ModelCooldowns = make(map[string]time.Time, len(node.ModelCooldowns))
		for model, until := range node.ModelCooldowns {
			state.ModelCooldowns[model] = dualReadTime(until)
		}
	}
	if len(node.ModelFailureStreaks) > 0 {
		state.ModelFailureStreaks = make(map[string]StatusModelFailureStreak, len(node.ModelFailureStreaks))
		for model, streak := range node.ModelFailureStreaks {
			state.ModelFailureStreaks[model] = StatusModelFailureStreak{
				Kind:       streak.Kind,
				Count:      streak.Count,
				ExpiresAt:  dualReadTime(streak.ExpiresAt),
				Reason:     streak.Reason,
				ObservedAt: dualReadTime(streak.ObservedAt),
			}
		}
	}
	if block := node.RoutingBlock; block != nil {
		if block.Recheck != "" && block.Recheck != "manual" {
			t.Fatalf("未登记的 routingBlock.recheck=%q：Node 只定义了 manual", block.Recheck)
		}
		mapped := &StatusRoutingBlock{
			Kind:          block.Kind,
			Reason:        block.Reason,
			ObservedAt:    dualReadTime(block.ObservedAt),
			RecheckManual: block.Recheck == "manual",
		}
		if block.Until != nil {
			mapped.Until = dualReadTime(*block.Until)
		}
		state.RoutingBlock = mapped
	}
	return &state
}

// dualReadStateToNodeJSON 把 Go 状态序列化回 Node 文档形状，供逐字段比对。
//
// 零值先判：Go 用零值表示「没有运行态文档」（见 status_transition.go 的字段注释），
// Node 用 runtimeState = null 表示同一件事。不先归成 null 的话，每个「清空」步骤都会拿
// 一个全 0 对象去比 null，变成必然误报。
func dualReadStateToNodeJSON(t *testing.T, state StatusState) any {
	t.Helper()
	if state.IsZero() {
		return nil
	}
	node := dualReadNodeState{
		ModelCooldowns:          map[string]int64{},
		ModelFailureStreaks:     map[string]dualReadStreak{},
		CooldownUntil:           dualReadMS(state.CooldownUntil),
		ConsecutiveFailures:     state.ConsecutiveFailures,
		SuccessCount:            state.SuccessCount,
		FailCount:               state.FailCount,
		LastError:               state.LastError,
		LastFailureKind:         state.LastFailureKind,
		LastFailureReason:       state.LastFailureReason,
		LastFailureAt:           dualReadMS(state.LastFailureAt),
		LastSuccessAt:           dualReadMS(state.LastSuccessAt),
		RateLimitUntil:          dualReadMS(state.RateLimitUntil),
		AuthInvalidUntil:        dualReadMS(state.AuthInvalidUntil),
		OverloadUntil:           dualReadMS(state.OverloadUntil),
		NetworkUntil:            dualReadMS(state.NetworkUntil),
		ServiceUnavailableUntil: dualReadMS(state.ServiceUnavailableUntil),
		UpstreamErrorUntil:      dualReadMS(state.UpstreamErrorUntil),
	}
	for model, until := range state.ModelCooldowns {
		node.ModelCooldowns[model] = dualReadMS(until)
	}
	for model, streak := range state.ModelFailureStreaks {
		node.ModelFailureStreaks[model] = dualReadStreak{
			Kind:       streak.Kind,
			Count:      streak.Count,
			ExpiresAt:  dualReadMS(streak.ExpiresAt),
			Reason:     streak.Reason,
			ObservedAt: dualReadMS(streak.ObservedAt),
		}
	}
	if block := state.RoutingBlock; block != nil {
		mapped := &dualReadRoutingBlock{
			Kind:       block.Kind,
			Reason:     block.Reason,
			ObservedAt: dualReadMS(block.ObservedAt),
		}
		if block.RecheckManual {
			mapped.Recheck = "manual"
		} else {
			until := dualReadMS(block.Until)
			mapped.Until = &until
		}
		node.RoutingBlock = mapped
	}
	raw, err := json.Marshal(node)
	if err != nil {
		t.Fatalf("序列化 Go 运行态: %v", err)
	}
	return dualReadDecodeJSON(t, raw)
}

// dualReadDerivedStatus 复刻 Node deriveAccountRuntimeStatus 的输入契约。
//
// Node 在 registry 里没有运行态文档（null）时返回 unknown；Go 的 StatusState 没有 null，
// 零值就是 null（IsZero 的定义），而 deriveStatus 只按字段派生、对零值返回 healthy。
// 双读必须先把零值还原成 Node 的 null 语义，否则所有「清空后」的步骤都会误报。
// 注意这是一处真实契约差异：直接把 deriveStatus 暴露给 UI 时，空运行态会显示 healthy。
func dualReadDerivedStatus(state StatusState, atMs int64) string {
	if state.IsZero() {
		return "unknown"
	}
	kind, _ := deriveStatus(state, statusMS(atMs))
	return kind
}

// dualReadTime 把 Node 的毫秒数换成 Go 时间。
//
// Node 归一化后 0 与负数都表示「没有这个时刻」，对应 time.Time 零值；不要用
// time.UnixMilli(0)（那是 1970-01-01，IsZero() 为 false，会让空桶看起来有效）。
func dualReadTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return statusMS(ms)
}

// dualReadMS 是 dualReadTime 的逆：零值写 0，与 Node 的 `Number(value) || 0` 一致。
func dualReadMS(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UnixMilli()
}

// dualReadDecodeJSON 统一用 UseNumber 解码，保证 1790000000000 这类毫秒值按原文比较，
// 不会先被折成 float64 再打印成科学计数法掩盖真实差异。
func dualReadDecodeJSON(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("解析 JSON 快照: %v (%s)", err, raw)
	}
	return value
}

// dualReadDiff 递归比较两份 JSON 值，把每一处差异记成「字段路径: got X want Y」。
//
// 路径拼接成 runtimeState.rateLimitUntil 这种形式，报错时能直接定位到字段，不需要
// 人肉 diff 两份完整文档。
func dualReadDiff(got, want any, path string, differences *[]string) {
	gotMap, gotIsMap := got.(map[string]any)
	wantMap, wantIsMap := want.(map[string]any)
	if gotIsMap && wantIsMap {
		keys := make([]string, 0, len(gotMap)+len(wantMap))
		for key := range gotMap {
			keys = append(keys, key)
		}
		for key := range wantMap {
			if _, exists := gotMap[key]; !exists {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			gotValue, gotOK := gotMap[key]
			wantValue, wantOK := wantMap[key]
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			if !gotOK || !wantOK {
				*differences = append(*differences, fmt.Sprintf(
					"%s: got %s want %s",
					childPath, dualReadRender(gotValue, gotOK), dualReadRender(wantValue, wantOK),
				))
				continue
			}
			dualReadDiff(gotValue, wantValue, childPath, differences)
		}
		return
	}
	if reflect.DeepEqual(got, want) {
		return
	}
	*differences = append(*differences, fmt.Sprintf(
		"%s: got %s want %s", path, dualReadRender(got, true), dualReadRender(want, true),
	))
}

// dualReadRender 让 null / 字符串 / 数字 / 缺失在报告里可区分。
func dualReadRender(value any, present bool) string {
	if !present {
		return "<absent>"
	}
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return strconv.Quote(typed)
	case json.Number:
		return typed.String()
	case bool:
		return strconv.FormatBool(typed)
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		return string(raw)
	}
}
