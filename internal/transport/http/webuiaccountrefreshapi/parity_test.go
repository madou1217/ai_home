package webuiaccountrefreshapi

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// nodeAccountRefreshJobFixture 是 Node serializeAccountRefreshJob 对 scope=account
// 作业的输出样本：字段顺序、可省略字段的取舍都按 lib/server/webui-account-routes-refresh.js
// 的实现手抄，用来锁住 Go 侧的 JSON 契约。测试不依赖 JS 运行时。
const nodeAccountRefreshJobFixture = `{
  "id": "acct-refresh-codex-acct_0123456789abcdef0123-m3k9x1-1a2b3c4d",
  "provider": "codex",
  "accountRef": "acct_0123456789abcdef0123",
  "status": "succeeded",
  "createdAt": 1762760000000,
  "updatedAt": 1762760002500,
  "finishedAt": 1762760002500,
  "error": "模型：上游 500",
  "recovered": true,
  "failedBranches": ["models"],
  "scope": "account",
  "branches": {
    "status": {"status": "succeeded", "error": ""},
    "models": {"status": "failed", "error": "上游 500"},
    "usage": {"status": "succeeded", "error": ""}
  }
}`

// nodeAccountRefreshJobMinimalFixture 是同一序列化函数在「全部成功、没有恢复标记」
// 时的输出：recovered 与 failedBranches 按 omitempty 口径整个消失。
const nodeAccountRefreshJobMinimalFixture = `{
  "id": "acct-refresh-codex-acct_0123456789abcdef0123-m3k9x1-1a2b3c4d",
  "provider": "codex",
  "accountRef": "acct_0123456789abcdef0123",
  "status": "succeeded",
  "createdAt": 1762760000000,
  "updatedAt": 1762760002500,
  "finishedAt": 1762760002500,
  "error": "",
  "scope": "account",
  "branches": {
    "status": {"status": "succeeded", "error": ""},
    "models": {"status": "succeeded", "error": ""},
    "usage": {"status": "succeeded", "error": ""}
  }
}`

// nodeAccountRefreshJobKeys 是 Node 序列化结果可能出现的全部顶层字段。
var nodeAccountRefreshJobKeys = []string{
	"id", "provider", "accountRef", "status", "createdAt", "updatedAt",
	"finishedAt", "error", "recovered", "failedBranches", "scope", "branches",
}

func parityDecodeMap(t *testing.T, body string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode fixture %q: %v", body, err)
	}
	return payload
}

func parityMarshalMap(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return parityDecodeMap(t, string(encoded))
}

func paritySortedKeys(payload map[string]any) []string {
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// jsonFieldNames 用反射列出结构体的 JSON 字段名（忽略 omitempty 等选项）。
func jsonFieldNames(t *testing.T, value any) []string {
	t.Helper()
	typ := reflect.TypeOf(value)
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	names := make([]string, 0, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		tag := typ.Field(index).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func TestParityNodeJobFixtureParsesIntoGoJob(t *testing.T) {
	var job AsyncJob
	if err := json.Unmarshal([]byte(nodeAccountRefreshJobFixture), &job); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	if job.ID != "acct-refresh-codex-acct_0123456789abcdef0123-m3k9x1-1a2b3c4d" {
		t.Fatalf("id = %q", job.ID)
	}
	if job.Provider != "codex" || job.AccountRef != "acct_0123456789abcdef0123" {
		t.Fatalf("provider/accountRef = %q/%q", job.Provider, job.AccountRef)
	}
	if job.Status != jobStatusSucceeded {
		t.Fatalf("status = %q, want succeeded", job.Status)
	}
	if job.CreatedAt != 1762760000000 || job.UpdatedAt != 1762760002500 {
		t.Fatalf("createdAt/updatedAt = %d/%d", job.CreatedAt, job.UpdatedAt)
	}
	if job.FinishedAt == nil || *job.FinishedAt != 1762760002500 {
		t.Fatalf("finishedAt = %v, want 1762760002500", job.FinishedAt)
	}
	if job.Error != "模型：上游 500" {
		t.Fatalf("error = %q", job.Error)
	}
	if !job.Recovered {
		t.Fatal("recovered = false, want true")
	}
	if !reflect.DeepEqual(job.FailedBranches, []string{BranchModels}) {
		t.Fatalf("failedBranches = %v, want [models]", job.FailedBranches)
	}
	if job.Scope != JobScopeAccount {
		t.Fatalf("scope = %q, want account", job.Scope)
	}
	if len(job.Branches) != 3 {
		t.Fatalf("branches = %+v, want 三段", job.Branches)
	}
	if branch := job.Branches[BranchModels]; branch.Status != branchStatusFailed ||
		branch.Error != "上游 500" {
		t.Fatalf("models = %+v", branch)
	}
	if branch := job.Branches[BranchStatus]; branch.Status != branchStatusSucceeded ||
		branch.Error != "" {
		t.Fatalf("status = %+v", branch)
	}
}

func TestParityGoJobJSONRoundTripsNodeFixture(t *testing.T) {
	var job AsyncJob
	if err := json.Unmarshal([]byte(nodeAccountRefreshJobFixture), &job); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}

	payload := parityMarshalMap(t, job)
	fixture := parityDecodeMap(t, nodeAccountRefreshJobFixture)
	if got, want := paritySortedKeys(payload), paritySortedKeys(fixture); !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON keys = %v, want %v", got, want)
	}

	// 逐字段类型一致：时间戳是毫秒数字，branches 是对象且每段只有 status/error。
	if _, ok := payload["createdAt"].(float64); !ok {
		t.Fatalf("createdAt = %v, want number", payload["createdAt"])
	}
	if _, ok := payload["updatedAt"].(float64); !ok {
		t.Fatalf("updatedAt = %v, want number", payload["updatedAt"])
	}
	if _, ok := payload["finishedAt"].(float64); !ok {
		t.Fatalf("finishedAt = %v, want number", payload["finishedAt"])
	}
	if _, ok := payload["recovered"].(bool); !ok {
		t.Fatalf("recovered = %v, want bool", payload["recovered"])
	}
	failed, ok := payload["failedBranches"].([]any)
	if !ok || len(failed) != 1 || failed[0] != BranchModels {
		t.Fatalf("failedBranches = %v, want [models]", payload["failedBranches"])
	}
	branches, ok := payload["branches"].(map[string]any)
	if !ok {
		t.Fatalf("branches = %v, want object", payload["branches"])
	}
	for _, name := range []string{BranchStatus, BranchModels, BranchUsage} {
		branch, ok := branches[name].(map[string]any)
		if !ok {
			t.Fatalf("branch %q = %v, want object", name, branches[name])
		}
		if got := paritySortedKeys(branch); !reflect.DeepEqual(got, []string{"error", "status"}) {
			t.Fatalf("branch %q keys = %v, want [error status]", name, got)
		}
	}
}

func TestParityOmitemptyMatchesNode(t *testing.T) {
	var job AsyncJob
	if err := json.Unmarshal([]byte(nodeAccountRefreshJobMinimalFixture), &job); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if job.Recovered {
		t.Fatal("recovered = true, want false")
	}
	if len(job.FailedBranches) != 0 {
		t.Fatalf("failedBranches = %v, want empty", job.FailedBranches)
	}

	payload := parityMarshalMap(t, job)
	for _, key := range []string{"recovered", "failedBranches"} {
		if _, found := payload[key]; found {
			t.Fatalf("%s 不该出现（Node omitempty 口径）：%v", key, payload)
		}
	}
	want := []string{
		"accountRef", "branches", "createdAt", "error", "finishedAt",
		"id", "provider", "scope", "status", "updatedAt",
	}
	if got := paritySortedKeys(payload); !reflect.DeepEqual(got, want) {
		t.Fatalf("JSON keys = %v, want %v", got, want)
	}
}

func TestParityGoStructFieldNamesMatchNode(t *testing.T) {
	// AsyncJob 是 Node 形状的权威投影：字段名必须与 fixture 的键集合完全一致。
	if got, want := jsonFieldNames(t, AsyncJob{}), sortedCopy(nodeAccountRefreshJobKeys); !reflect.DeepEqual(got, want) {
		t.Fatalf("AsyncJob 字段 = %v, want %v", got, want)
	}

	// 同步执行器的 Job 没有 recovered（该字段只由异步作业表写入），其余同名同形。
	wantJob := make([]string, 0, len(nodeAccountRefreshJobKeys))
	for _, key := range nodeAccountRefreshJobKeys {
		if key == "recovered" {
			continue
		}
		wantJob = append(wantJob, key)
	}
	sort.Strings(wantJob)
	if got := jsonFieldNames(t, Job{}); !reflect.DeepEqual(got, wantJob) {
		t.Fatalf("Job 字段 = %v, want %v", got, wantJob)
	}
}

func TestParityRefreshResponseTopLevelKeys(t *testing.T) {
	payload := parityMarshalMap(t, Response{})
	// Node 的 202 只有四个字段；durationMs 是 Go 侧附加的耗时字段，允许存在。
	want := []string{"accepted", "alreadyRunning", "durationMs", "job", "ok"}
	if got := paritySortedKeys(payload); !reflect.DeepEqual(got, want) {
		t.Fatalf("Response 字段 = %v, want %v", got, want)
	}
}

func sortedCopy(values []string) []string {
	copied := append([]string(nil), values...)
	sort.Strings(copied)
	return copied
}
