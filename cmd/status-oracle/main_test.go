package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// 本文件用 Node 生成的真值夹具（testdata/status-dual-read.json）自证 oracle：
// 同一组事件、同一个初值，oracle 每一步之后的 runtimeState 与 status 都必须与
// Node 冻结下来的快照逐字段一致。夹具是生成物，不一致时先怀疑实现，不要改夹具。

type dualReadFixture struct {
	Version     int            `json:"version"`
	GeneratedBy string         `json:"generatedBy"`
	AccountRef  string         `json:"accountRef"`
	Cases       []dualReadCase `json:"cases"`
}

// steps 保留原始 JSON：夹具里的失败载荷、clear 证据和 runtime_state 文档
// 都直接喂给 oracle 的同一套解码路径，避免测试另造一份形状。
type dualReadCase struct {
	Name     string            `json:"name"`
	Provider string            `json:"provider"`
	Initial  json.RawMessage   `json:"initial"`
	Steps    []json.RawMessage `json:"steps"`
	Expected struct {
		AfterEach []dualReadExpectation `json:"afterEach"`
	} `json:"expected"`
}

type dualReadExpectation struct {
	AtMs         int64           `json:"atMs"`
	RuntimeState json.RawMessage `json:"runtimeState"`
	Status       string          `json:"status"`
}

// rawOracleResponse 是测试侧对输出的宽松解码：runtimeState 保留原文，
// 用 UseNumber 比较，避免 1790000000000 被 float64 改写后掩盖差异。
type rawOracleResponse struct {
	ID      string            `json:"id"`
	Results []rawOracleResult `json:"results"`
	Error   string            `json:"error"`
}

type rawOracleResult struct {
	AtMs         int64           `json:"atMs"`
	RuntimeState json.RawMessage `json:"runtimeState"`
	Status       string          `json:"status"`
	Error        string          `json:"error"`
}

func TestOracleMatchesDualReadFixture(t *testing.T) {
	fixture := loadDualReadFixture(t)
	if fixture.Version != 1 {
		t.Fatalf("夹具版本 %d 未登记：生成器与 oracle 必须一起升级", fixture.Version)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("夹具没有用例，oracle 没有覆盖")
	}

	// 所有请求一次性写进同一段 JSONL，顺带验证「同序、一行一答」。
	var input bytes.Buffer
	for index, testCase := range fixture.Cases {
		line, err := json.Marshal(testCase.request(t, fixture, index))
		if err != nil {
			t.Fatalf("构造请求 %s: %v", testCase.Name, err)
		}
		input.Write(line)
		input.WriteByte('\n')
	}
	var output bytes.Buffer
	if err := runOracle(&input, &output); err != nil {
		t.Fatalf("runOracle 返回错误: %v", err)
	}
	lines := splitResponseLines(output.Bytes())
	if len(lines) != len(fixture.Cases) {
		t.Fatalf("响应行数 %d 与用例数 %d 不一致：一行请求必须对应一行响应", len(lines), len(fixture.Cases))
	}

	for index, testCase := range fixture.Cases {
		var got rawOracleResponse
		if err := json.Unmarshal(lines[index], &got); err != nil {
			t.Fatalf("解析用例 %s 的响应: %v", testCase.Name, err)
		}
		t.Run(testCase.Name, func(t *testing.T) {
			if got.Error != "" {
				t.Fatalf("oracle 返回错误: %s", got.Error)
			}
			if wantID := fmt.Sprintf("%s#%d", fixture.AccountRef, index); got.ID != wantID {
				t.Fatalf("id = %q, want %q（响应必须按输入顺序回填 id）", got.ID, wantID)
			}
			if len(got.Results) != len(testCase.Expected.AfterEach) {
				t.Fatalf("结果数 %d 与快照数 %d 不一致", len(got.Results), len(testCase.Expected.AfterEach))
			}
			for stepIndex, want := range testCase.Expected.AfterEach {
				result := got.Results[stepIndex]
				if result.Error != "" {
					t.Errorf("第 %d 步返回错误: %s", stepIndex+1, result.Error)
				}
				if result.AtMs != want.AtMs {
					t.Errorf("第 %d 步 atMs = %d, want %d", stepIndex+1, result.AtMs, want.AtMs)
				}
				if result.Status != want.Status {
					t.Errorf("第 %d 步 status = %q, want %q", stepIndex+1, result.Status, want.Status)
				}
				gotState := decodeJSONAny(t, result.RuntimeState)
				wantState := decodeJSONAny(t, want.RuntimeState)
				if !reflect.DeepEqual(gotState, wantState) {
					t.Errorf(
						"第 %d 步 runtimeState 不一致:\n got: %s\nwant: %s",
						stepIndex+1,
						compactJSON(t, result.RuntimeState),
						compactJSON(t, want.RuntimeState),
					)
				}
			}
		})
	}
}

// TestOracleRuntimeStateDocumentShape 单独覆盖夹具没走到的字段：
// 按模型冷却 / 连败、routingBlock.until，以及「零值必须显式写 0、空 map 写 {}」。
func TestOracleRuntimeStateDocumentShape(t *testing.T) {
	const base = int64(1_790_000_000_000)
	request := oracleRequest{
		ID:       "acct_oracle_shape#0",
		Provider: "codex",
		Initial:  json.RawMessage("null"),
		Steps: []oracleStep{{
			Op:   "runtime_state",
			AtMs: base,
			State: json.RawMessage(fmt.Sprintf(`{
				"modelCooldowns": {"gpt-5": %d},
				"modelFailureStreaks": {"gpt-5": {"kind": "model_overloaded", "count": 2, "expiresAt": %d, "reason": "overloaded", "observedAt": %d}},
				"cooldownUntil": %d,
				"consecutiveFailures": 0,
				"successCount": 0,
				"failCount": 0,
				"lastError": "",
				"lastFailureKind": "quota_exhausted",
				"lastFailureReason": "quota",
				"lastFailureAt": %d,
				"lastSuccessAt": 0,
				"rateLimitUntil": 0,
				"authInvalidUntil": 0,
				"overloadUntil": 0,
				"networkUntil": 0,
				"serviceUnavailableUntil": 0,
				"upstreamErrorUntil": 0,
				"routingBlock": {"kind": "quota_exhausted", "reason": "quota", "observedAt": %d, "until": %d}
			}`, base+2000, base+3000, base+1000, base+4000, base, base, base+2000)),
		}},
	}

	response := oracleResponseFor(t, request)
	if len(response.Results) != 1 {
		t.Fatalf("结果数 = %d, want 1", len(response.Results))
	}
	if response.Results[0].Status != "quota_exhausted" {
		t.Errorf("status = %q, want quota_exhausted", response.Results[0].Status)
	}

	want := json.RawMessage(fmt.Sprintf(`{
		"modelCooldowns": {"gpt-5": %d},
		"modelFailureStreaks": {"gpt-5": {"kind": "model_overloaded", "count": 2, "expiresAt": %d, "reason": "overloaded", "observedAt": %d}},
		"cooldownUntil": %d,
		"consecutiveFailures": 0,
		"successCount": 0,
		"failCount": 0,
		"lastError": "",
		"lastFailureKind": "quota_exhausted",
		"lastFailureReason": "quota",
		"lastFailureAt": %d,
		"lastSuccessAt": 0,
		"rateLimitUntil": 0,
		"authInvalidUntil": 0,
		"overloadUntil": 0,
		"networkUntil": 0,
		"serviceUnavailableUntil": 0,
		"upstreamErrorUntil": 0,
		"routingBlock": {"kind": "quota_exhausted", "reason": "quota", "observedAt": %d, "until": %d}
	}`, base+2000, base+3000, base+1000, base+4000, base, base, base+2000))
	gotState := runtimeStateOf(t, response.Results[0])
	wantState := decodeJSONAny(t, want)
	if !reflect.DeepEqual(gotState, wantState) {
		t.Errorf("runtimeState 文档形状不一致:\n got: %s\nwant: %s", compactJSON(t, mustMarshal(t, gotState)), compactJSON(t, want))
	}
}

// TestOracleKeepsManualRoutingBlock 守住契约里的 routingBlockRecheck='manual'：
// 文档没有 until、带 recheck:'manual'，而且过了任何定时复核窗口仍然生效。
func TestOracleKeepsManualRoutingBlock(t *testing.T) {
	const base = int64(1_790_000_000_000)
	request := oracleRequest{
		ID:       "acct_oracle_manual#0",
		Provider: "codex",
		Initial:  json.RawMessage("null"),
		Steps: []oracleStep{
			{
				Op:   "failure",
				AtMs: base,
				Failure: &oracleFailure{
					Kind:                "quota_exhausted",
					Reason:              "manual quota",
					CooldownMs:          0,
					RoutingBlockRecheck: "manual",
				},
			},
			// 一年后的普通成功证据不能解除 manual 阻塞：这类阻塞只认人工恢复。
			{Op: "clear", AtMs: base + 365*24*60*60*1000, Evidence: "upstream_success"},
		},
	}

	response := oracleResponseFor(t, request)
	if got := len(response.Results); got != 2 {
		t.Fatalf("结果数 = %d, want 2", got)
	}
	want := decodeJSONAny(t, json.RawMessage(fmt.Sprintf(`{
		"modelCooldowns": {},
		"modelFailureStreaks": {},
		"cooldownUntil": 0,
		"consecutiveFailures": 0,
		"successCount": 0,
		"failCount": 0,
		"lastError": "",
		"lastFailureKind": "quota_exhausted",
		"lastFailureReason": "manual quota",
		"lastFailureAt": %d,
		"lastSuccessAt": 0,
		"rateLimitUntil": 0,
		"authInvalidUntil": 0,
		"overloadUntil": 0,
		"networkUntil": 0,
		"serviceUnavailableUntil": 0,
		"upstreamErrorUntil": 0,
		"routingBlock": {"kind": "quota_exhausted", "reason": "manual quota", "observedAt": %d, "recheck": "manual"}
	}`, base, base)))
	for index, result := range response.Results {
		if result.Status != "quota_exhausted" {
			t.Errorf("第 %d 步 status = %q, want quota_exhausted", index+1, result.Status)
		}
		if gotState := runtimeStateOf(t, result); !reflect.DeepEqual(gotState, want) {
			t.Errorf("第 %d 步 runtimeState 不一致:\n got: %s\nwant: %s", index+1, compactJSON(t, mustMarshal(t, gotState)), compactJSON(t, mustMarshal(t, want)))
		}
	}
}

// TestOracleIsolatesFailingLines 验证第 4 条契约：坏行只影响自己，后续行照常处理。
func TestOracleIsolatesFailingLines(t *testing.T) {
	fixture := loadDualReadFixture(t)
	first, err := json.Marshal(fixture.Cases[0].request(t, fixture, 0))
	if err != nil {
		t.Fatalf("构造第一条请求: %v", err)
	}
	second, err := json.Marshal(fixture.Cases[1].request(t, fixture, 1))
	if err != nil {
		t.Fatalf("构造第二条请求: %v", err)
	}

	var input bytes.Buffer
	input.Write(first)
	input.WriteByte('\n')
	input.WriteString("{ 这不是 JSON }\n")
	input.WriteString(`{"id":"bad-op","provider":"codex","steps":[{"op":"explode","atMs":1790000000000}]}`)
	input.WriteByte('\n')
	input.Write(second)
	input.WriteByte('\n')

	var output bytes.Buffer
	if err := runOracle(&input, &output); err != nil {
		t.Fatalf("runOracle 返回错误: %v", err)
	}
	lines := splitResponseLines(output.Bytes())
	if len(lines) != 4 {
		t.Fatalf("响应行数 = %d, want 4（坏行不能吞掉后续响应）", len(lines))
	}

	var responses []rawOracleResponse
	for index, line := range lines {
		var response rawOracleResponse
		if err := json.Unmarshal(line, &response); err != nil {
			t.Fatalf("解析第 %d 行响应: %v", index+1, err)
		}
		responses = append(responses, response)
	}

	if responses[0].Error != "" || len(responses[0].Results) != 2 {
		t.Errorf("第一条合法请求被影响: error=%q results=%d", responses[0].Error, len(responses[0].Results))
	}
	if responses[1].Error == "" || len(responses[1].Results) != 0 {
		t.Errorf("坏 JSON 行应返回 results:[], error 非空: error=%q results=%d", responses[1].Error, len(responses[1].Results))
	}
	if responses[2].ID != "bad-op" || responses[2].Error == "" || len(responses[2].Results) != 0 {
		t.Errorf("未知 op 行应带 id 且返回错误: id=%q error=%q results=%d", responses[2].ID, responses[2].Error, len(responses[2].Results))
	}
	if responses[3].Error != "" || len(responses[3].Results) != 2 {
		t.Errorf("坏行之后的合法请求未恢复: error=%q results=%d", responses[3].Error, len(responses[3].Results))
	}
}

// TestOracleStreamsBeforeEOF 证明 oracle 不是「读完整个 stdin 再一次性回答」：
// 输入管道保持打开时，第一行响应也必须已经可读。
func TestOracleStreamsBeforeEOF(t *testing.T) {
	fixture := loadDualReadFixture(t)
	line, err := json.Marshal(fixture.Cases[0].request(t, fixture, 0))
	if err != nil {
		t.Fatalf("构造请求: %v", err)
	}

	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		runErr := runOracle(inputReader, outputWriter)
		_ = outputWriter.CloseWithError(runErr)
		done <- runErr
	}()

	type readResult struct {
		line []byte
		err  error
	}
	read := make(chan readResult, 1)
	go func() {
		reader := bufio.NewReader(outputReader)
		responseLine, err := reader.ReadBytes('\n')
		read <- readResult{line: responseLine, err: err}
	}()

	if _, err := inputWriter.Write(append(line, '\n')); err != nil {
		t.Fatalf("写入请求: %v", err)
	}
	select {
	case result := <-read:
		if result.err != nil {
			t.Fatalf("读取第一行响应: %v", result.err)
		}
		var response rawOracleResponse
		if err := json.Unmarshal(result.line, &response); err != nil {
			t.Fatalf("解析第一行响应: %v", err)
		}
		if wantID := fixture.AccountRef + "#0"; response.ID != wantID {
			t.Fatalf("id = %q, want %q", response.ID, wantID)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stdin 未关闭时收不到响应：oracle 在缓冲整批输入")
	}

	if err := inputWriter.Close(); err != nil {
		t.Fatalf("关闭输入: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runOracle 返回错误: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("关闭 stdin 后 runOracle 没有退出")
	}
	_ = outputReader.Close()
}

// request 把夹具用例翻译成 oracle 请求；id 用夹具账号加序号，便于回填核对。
func (testCase dualReadCase) request(t *testing.T, fixture dualReadFixture, index int) oracleRequest {
	t.Helper()
	request := oracleRequest{
		ID:       fmt.Sprintf("%s#%d", fixture.AccountRef, index),
		Provider: testCase.Provider,
		Initial:  testCase.Initial,
	}
	for stepIndex, raw := range testCase.Steps {
		var step oracleStep
		if err := json.Unmarshal(raw, &step); err != nil {
			t.Fatalf("解析用例 %s 第 %d 步: %v", testCase.Name, stepIndex+1, err)
		}
		request.Steps = append(request.Steps, step)
	}
	return request
}

// oracleResponseFor 走真实的「一行请求 → 一行响应」入口，避免测试绕开 CLI 逻辑。
func oracleResponseFor(t *testing.T, request oracleRequest) oracleResponse {
	t.Helper()
	line, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("序列化请求: %v", err)
	}
	response := handleOracleLine(line)
	if response.Error != "" {
		t.Fatalf("oracle 返回错误: %s", response.Error)
	}
	return response
}

// loadDualReadFixture 定位仓库根的 testdata/status-dual-read.json。
//
// 用 runtime.Caller 而不是相对路径：go test 的工作目录随包变化，源文件位置
// 才是唯一稳定的锚点。
func loadDualReadFixture(t *testing.T) dualReadFixture {
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
	// 夹具新增字段必须是显式接线，否则测试会悄悄漏掉新语义。
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("解析夹具 %s: %v", path, err)
	}
	return fixture
}

func splitResponseLines(output []byte) [][]byte {
	trimmed := bytes.TrimSpace(output)
	if len(trimmed) == 0 {
		return nil
	}
	return bytes.Split(trimmed, []byte("\n"))
}

// decodeJSONAny 统一用 UseNumber：毫秒值按原文比较，不会被 float64 折成科学计数法。
func decodeJSONAny(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("解析 JSON 快照: %v (%s)", err, raw)
	}
	return value
}

func runtimeStateOf(t *testing.T, result oracleResult) any {
	t.Helper()
	raw, err := json.Marshal(result.RuntimeState)
	if err != nil {
		t.Fatalf("序列化 runtimeState: %v", err)
	}
	return decodeJSONAny(t, raw)
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化 JSON: %v", err)
	}
	return raw
}

func compactJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var compacted bytes.Buffer
	if err := json.Compact(&compacted, raw); err != nil {
		return string(raw)
	}
	return compacted.String()
}
