package main

import (
	"context"
	"strings"
	"testing"
)

// TestRewriteFamilySessionVerb 守住统一动词的翻译边界：账号位可选、id 转成
// 原生 --resume、无 id 退回 --continue、fork 明确拒绝（家族 CLI 没有分叉入口）。
func TestRewriteFamilySessionVerb(t *testing.T) {
	ctx := context.Background()
	runtime := commandRuntime{}
	cases := []struct {
		name        string
		arguments   []string
		wantHandled bool
		wantArgs    []string
		wantError   string
	}{
		{
			name:        "resume with account and id",
			arguments:   []string{"codebuddycn", "2", "resume", "01a1d5c6-f2bd-77c0-bc96-4a3451faff75"},
			wantHandled: true,
			wantArgs:    []string{"codebuddycn", "2", "--resume", "01a1d5c6-f2bd-77c0-bc96-4a3451faff75"},
		},
		{
			name:        "resume keeps extra native args",
			arguments:   []string{"codebuddycn", "2", "resume", "s1", "--model", "glm-5.3"},
			wantHandled: true,
			wantArgs:    []string{"codebuddycn", "2", "--resume", "s1", "--model", "glm-5.3"},
		},
		{
			name:        "resume with flag falls back to continue",
			arguments:   []string{"codebuddycn", "2", "resume", "--model", "glm-5.3"},
			wantHandled: true,
			wantArgs:    []string{"codebuddycn", "2", "--continue", "--model", "glm-5.3"},
		},
		{
			name:        "fork is rejected for family",
			arguments:   []string{"codebuddycn", "2", "fork", "s1"},
			wantHandled: true,
			wantError:   "codebuddycn 未声明会话分叉入口",
		},
		{
			name:        "no verb is untouched",
			arguments:   []string{"codebuddycn", "2", "--model", "glm-5.3"},
			wantHandled: false,
			wantArgs:    []string{"codebuddycn", "2", "--model", "glm-5.3"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rewritten, handled, err := rewriteFamilySessionVerb(
				ctx,
				"codebuddycn",
				testCase.arguments,
				runtime,
			)
			if handled != testCase.wantHandled {
				t.Fatalf("handled = %v, want %v", handled, testCase.wantHandled)
			}
			if testCase.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantError) {
					t.Fatalf("err = %v, want contains %q", err, testCase.wantError)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if strings.Join(rewritten, " ") != strings.Join(testCase.wantArgs, " ") {
				t.Fatalf("args = %v, want %v", rewritten, testCase.wantArgs)
			}
		})
	}
}

// TestStripNativeEscapeMarker 逃生门只去掉 `--` 标记本身，账号位与后续原生参数保留。
func TestStripNativeEscapeMarker(t *testing.T) {
	stripped, escaped := stripNativeEscapeMarker([]string{"codebuddycn", "2", "--", "--model", "x"})
	if !escaped {
		t.Fatal("应该识别到逃生门")
	}
	if strings.Join(stripped, " ") != "codebuddycn 2 --model x" {
		t.Fatalf("stripped = %v", stripped)
	}
	unchanged, escaped := stripNativeEscapeMarker([]string{"codebuddycn", "2", "--model", "x"})
	if escaped {
		t.Fatal("没有 -- 不应标记为逃生门")
	}
	if strings.Join(unchanged, " ") != "codebuddycn 2 --model x" {
		t.Fatalf("unchanged = %v", unchanged)
	}
	// 逃生门在账号位之前时，账号位之后的一切都原样保留给 CLI。
	early, escaped := stripNativeEscapeMarker([]string{"codebuddycn", "--", "resume", "--model", "x"})
	if !escaped || strings.Join(early, " ") != "codebuddycn resume --model x" {
		t.Fatalf("early = %v escaped=%v", early, escaped)
	}
}
