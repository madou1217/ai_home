package routeownership

import (
	"strings"
	"testing"
)

// TestGoOwnedEntriesAreCompleteAndUnique 守住归属投影的基本不变量：
//  1. go_owned 条目必须有 GoRoutes；
//  2. 同一条 (transport, method, path) 不能出现在两个条目里——重复注册会让
//     http.ServeMux 在启动期 panic（sessions/unarchive 就踩过一次）；
//  3. 浏览器数据面的 Go 路由必须落在 /v0/webui 下，避免把管理路径误标成公开面。
func TestGoOwnedEntriesAreCompleteAndUnique(t *testing.T) {
	manifest := Current()
	type routeKey struct {
		transport string
		method    string
		path      string
	}
	seen := map[routeKey]string{}
	for _, entry := range manifest.Entries {
		if entry.ProductionOwner != "go" || entry.MigrationState != "go_owned" {
			continue
		}
		if len(entry.GoRoutes) == 0 {
			t.Fatalf("go_owned 条目 %s 没有 GoRoutes", entry.ID)
		}
		for _, route := range entry.GoRoutes {
			methods := route.Methods
			if len(methods) == 0 {
				methods = []string{"*"}
			}
			for _, method := range methods {
				key := routeKey{transport: route.Transport, method: strings.ToUpper(method), path: route.Path}
				if owner, exists := seen[key]; exists {
					t.Fatalf("路由重复声明: %s 同时出现在 %s 与 %s", route.Path, owner, entry.ID)
				}
				seen[key] = entry.ID
			}
			if strings.HasPrefix(route.Path, "/v0/webui") && !strings.HasPrefix(route.Path, "/v0/webui/") {
				t.Fatalf("公开数据面路径缺少尾段: %s (%s)", route.Path, entry.ID)
			}
		}
	}
}

// patternsAmbiguous 判定两条模式是否互不更具体（ServeMux 注册会 panic）。
func patternsAmbiguous(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	literalOf := func(segment string) string {
		var builder strings.Builder
		for index := 0; index < len(segment); index++ {
			if segment[index] == '{' {
				for index < len(segment) && segment[index] != '}' {
					index++
				}
				continue
			}
			builder.WriteByte(segment[index])
		}
		return builder.String()
	}
	pureWildcard := func(segment string) bool {
		return strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") && strings.Count(segment, "{") == 1
	}
	leftLiteralWins := false
	rightLiteralWins := false
	for index := range left {
		lseg, rseg := left[index], right[index]
		lp, rp := pureWildcard(lseg), pureWildcard(rseg)
		switch {
		case literalOf(lseg) == literalOf(rseg):
			continue
		case lp && !rp:
			rightLiteralWins = true
		case rp && !lp:
			leftLiteralWins = true
		default:
			return false
		}
	}
	return leftLiteralWins && rightLiteralWins
}

// TestPatternsAmbiguousCatchesServeMuxPanicCase 用真实踩过的冲突锁定判定：
// /accounts/import/jobs/{jobId} 与 /accounts/{provider}/{accountRef}/quota-reset-events
// 在 ServeMux 注册时 panic，判定必须为 true；而 /v1/models/{id} 与
// /v1{beta?}/models/{model}:generateContent 是合法的（前者更宽，Go 可裁决）。
func TestPatternsAmbiguousCatchesServeMuxPanicCase(t *testing.T) {
	segments := func(path string) []string { return strings.Split(strings.Trim(path, "/"), "/") }
	if !patternsAmbiguous(segments("/accounts/import/jobs/{jobId}"), segments("/accounts/{provider}/{accountRef}/quota-reset-events")) {
		t.Fatal("真实冲突用例未被判定为歧义")
	}
	if patternsAmbiguous(segments("/v1/models/{id}"), segments("/v1{beta?}/models/{model}:generateContent")) {
		t.Fatal("合法模式被误判为歧义")
	}
}

// TestGoRoutesAvoidAmbiguousSegmentPatterns 防住 ServeMux 的模式歧义：
// 两条同段数、每段可互相覆盖、且「各有对方是通配的字面段」（互不更具体）的模式，
// 例如 /accounts/import/jobs/{jobId} 与 /accounts/{provider}/{accountRef}/quota-reset-events，
// 注册时会让 Go 启动期 panic。命中即失败。
func TestGoRoutesAvoidAmbiguousSegmentPatterns(t *testing.T) {
	segmentsOf := func(path string) []string {
		return strings.Split(strings.Trim(path, "/"), "/")
	}
	type candidate struct {
		entry    string
		path     string
		segments []string
	}
	var candidates []candidate
	for _, entry := range Current().Entries {
		for _, route := range entry.GoRoutes {
			candidates = append(candidates, candidate{entry: entry.ID, path: route.Path, segments: segmentsOf(route.Path)})
		}
	}
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			left, right := candidates[i], candidates[j]
			if len(left.segments) != len(right.segments) || left.path == right.path {
				continue
			}
			if patternsAmbiguous(left.segments, right.segments) {

				t.Fatalf("公开路由模式互不更具体，注册会 panic: %s (%s) 与 %s (%s)", left.path, left.entry, right.path, right.entry)
			}
		}
	}
}
