package webuisessioneventsapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// parityFixture 是 Node readSessionEvents 生成的真值快照。
// 生成方式：node scripts/dump-session-events-parity-cases.js
type parityFixture struct {
	Version int          `json:"version"`
	Cases   []parityCase `json:"cases"`
}

type parityCase struct {
	Name      string          `json:"name"`
	SessionID string          `json:"sessionId"`
	Records   []string        `json:"records"`
	Tail      string          `json:"tail"`
	Cursor    int64           `json:"cursor"`
	Expected  json.RawMessage `json:"expected"`
}

// TestNodeParity 逐条复算 Node 的返回值。
//
// 这不是「形状差不多」的冒烟测试：fixture 的 expected 是 Node 原样输出，
// requiresSnapshot 的省略与显式 false 都会参与比较。
func TestNodeParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "parity-cases.json"))
	if err != nil {
		t.Fatalf("读取对拍快照失败: %v", err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析对拍快照失败: %v", err)
	}
	if fixture.Version != 1 || len(fixture.Cases) == 0 {
		t.Fatalf("对拍快照版本/用例无效: version=%d cases=%d", fixture.Version, len(fixture.Cases))
	}
	for _, testCase := range fixture.Cases {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			home := t.TempDir()
			content := strings.Join(testCase.Records, "\n") + "\n" + testCase.Tail
			writeCodexRollout(t, home, testCase.SessionID, content)
			reader := &FileReader{HostHomeDir: home}
			result, err := reader.ReadEvents(context.Background(), EventRequest{
				Provider:  "codex",
				SessionID: testCase.SessionID,
				Cursor:    testCase.Cursor,
			})
			if err != nil {
				t.Fatalf("ReadEvents() error = %v", err)
			}
			actual := marshalJSONValue(t, result)
			var expected any
			if err := json.Unmarshal(testCase.Expected, &expected); err != nil {
				t.Fatalf("expected 不是合法 JSON: %v", err)
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("与 Node 不一致\nGo:   %#v\nNode: %#v", actual, expected)
			}
		})
	}
}

func writeCodexRollout(t *testing.T, home, sessionID, content string) string {
	t.Helper()
	directory := filepath.Join(home, ".codex", "sessions", "2026", "11", "12")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("创建会话目录失败: %v", err)
	}
	filePath := filepath.Join(directory, "rollout-2026-11-12T10-00-00-"+sessionID+".jsonl")
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatalf("写入会话文件失败: %v", err)
	}
	return filePath
}

func marshalJSONValue(t *testing.T, value any) any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化 Go 结果失败: %v", err)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("反序列化 Go 结果失败: %v", err)
	}
	return decoded
}
