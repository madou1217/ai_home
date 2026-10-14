package upstreamrules

import (
	"encoding/json"
	"os"
	"testing"
)

// parityCase 是一条跨实现一致性样例。
type parityCase struct {
	Name               string `json:"name"`
	StatusCode         int    `json:"statusCode"`
	Body               string `json:"body"`
	Rules              []Rule `json:"rules"`
	ExpectMatchedIndex int    `json:"expectMatchedIndex"`
	ExpectKind         string `json:"expectKind"`
}

// loadParityCases 读取 Go 与 Node 共用的规则匹配样例。
func loadParityCases(t *testing.T) []parityCase {
	t.Helper()
	payload, err := os.ReadFile("testdata/parity_cases.json")
	if err != nil {
		t.Fatalf("读取一致性样例失败: %v", err)
	}
	var fixture struct {
		Cases []parityCase `json:"cases"`
	}
	if err := json.Unmarshal(payload, &fixture); err != nil {
		t.Fatalf("解析一致性样例失败: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("一致性样例为空")
	}
	return fixture.Cases
}

// TestMatchParityCases 校验规则匹配与 Node 共享样例结论一致。
func TestMatchParityCases(t *testing.T) {
	for _, testCase := range loadParityCases(t) {
		t.Run(testCase.Name, func(t *testing.T) {
			rules, err := Validate(testCase.Rules)
			if err != nil {
				t.Fatalf("样例规则应可通过校验: %v", err)
			}
			index, matched := MatchIndex(rules, testCase.StatusCode, []byte(testCase.Body))
			if !matched {
				index = -1
			}
			if index != testCase.ExpectMatchedIndex {
				t.Fatalf("命中下标 = %d，期望 %d", index, testCase.ExpectMatchedIndex)
			}
			if testCase.ExpectMatchedIndex < 0 {
				return
			}
			if kind := string(rules[index].Kind()); kind != testCase.ExpectKind {
				t.Fatalf("命中状态 = %s，期望 %s", kind, testCase.ExpectKind)
			}
		})
	}
}

// TestDecodedRulesRequireValidation 校验解码后的规则在 Validate 之前不参与匹配。
//
// 这保证「生效但未编译」的规则不会静默失配，也保证 Node 支持而 RE2 不支持的
// 正则只影响它自己的账号。
func TestDecodedRulesRequireValidation(t *testing.T) {
	const payload = `[
	  {
	    "name": "额度耗尽",
	    "kind": "quota_exhausted",
	    "enabled": true,
	    "statuses": [403],
	    "matchers": [{"source": "body", "operator": "contains", "value": "INSUFFICIENT_BALANCE"}]
	  }
	]`
	var rules []Rule
	if err := json.Unmarshal([]byte(payload), &rules); err != nil {
		t.Fatalf("解码应只做结构校验: %v", err)
	}
	if rules[0].Compiled() {
		t.Fatal("解码后的规则不应处于已编译状态")
	}
	if _, matched := MatchIndex(rules, 403, []byte(`{"error":"INSUFFICIENT_BALANCE"}`)); matched {
		t.Fatal("未编译的规则不应参与匹配")
	}
	validated, err := Validate(rules)
	if err != nil {
		t.Fatalf("校验失败: %v", err)
	}
	if index, matched := MatchIndex(validated, 403, []byte(`{"error":"INSUFFICIENT_BALANCE"}`)); !matched || index != 0 {
		t.Fatalf("校验后应命中第 0 条，实际 matched=%v index=%d", matched, index)
	}
}

// TestDecodeDefersRegexCompilation 校验 RE2 不支持的写法在解码期通过、在校验期失败。
//
// Node 侧 lookbehind 是合法正则，Go RE2 不支持；这类账号必须能被逐账号丢弃，
// 而不是让整份投影推送失败。
func TestDecodeDefersRegexCompilation(t *testing.T) {
	const payload = `[
	  {
	    "name": "JS 专属正则",
	    "kind": "rate_limited",
	    "enabled": true,
	    "statuses": [429],
	    "matchers": [{"source": "body", "operator": "regex", "value": "(?<=quota) exceeded"}]
	  }
	]`
	var rules []Rule
	if err := json.Unmarshal([]byte(payload), &rules); err != nil {
		t.Fatalf("解码不应因 RE2 不支持而失败: %v", err)
	}
	if _, err := Validate(rules); err == nil {
		t.Fatal("RE2 无法编译的生效规则应在校验期失败")
	}
}

// TestObserveRequiresFailureEvidence 校验无失败证据时不产生观察投影。
func TestObserveRequiresFailureEvidence(t *testing.T) {
	if _, observed := Observe(200, []byte(`{"ok":true}`)); observed {
		t.Fatal("HTTP 200 普通正文不应产生失败观察")
	}
	if _, observed := Observe(200, []byte(`{"type":"response.failed"}`)); !observed {
		t.Fatal("HTTP 200 的 response.failed 信封应产生失败观察")
	}
	if _, observed := Observe(403, nil); !observed {
		t.Fatal("HTTP 403 空正文应产生失败观察")
	}
}

// TestObserveExtractsStructuredError 校验结构化错误字段抽取优先级。
func TestObserveExtractsStructuredError(t *testing.T) {
	observation, observed := Observe(403, []byte(`{"response":{"error":{"code":"X","type":"y","message":"z"}}}`))
	if !observed {
		t.Fatal("应产生失败观察")
	}
	if observation.Code() != "X" || observation.Type() != "y" || observation.Message() != "z" {
		t.Fatalf("结构化字段抽取错误: %q/%q/%q", observation.Code(), observation.Type(), observation.Message())
	}
	stringError, observed := Observe(400, []byte(`{"error":"boom"}`))
	if !observed || stringError.Message() != "boom" {
		t.Fatalf("字符串错误体应作为 message: %q", stringError.Message())
	}
	empty, observed := Observe(500, nil)
	if !observed || empty.Code() != "" || empty.Body() != "" {
		t.Fatalf("空正文应产生空字段观察: %+v", empty)
	}
}

// TestObserveTruncatesLongBody 校验正文上限不会让观察无限增长。
func TestObserveTruncatesLongBody(t *testing.T) {
	long := make([]byte, 0, MaxErrorBytes+4096)
	long = append(long, `{"error":{"message":"`...)
	for len(long) < MaxErrorBytes+2048 {
		long = append(long, 'a')
	}
	long = append(long, `"}}`...)
	observation, observed := Observe(400, long)
	if !observed {
		t.Fatal("应产生失败观察")
	}
	if len(observation.Body()) > MaxObservationBodyBytes {
		t.Fatalf("body 未被截断: %d", len(observation.Body()))
	}
	if len(observation.Message()) > MaxObservationMessageLength {
		t.Fatalf("message 未被截断: %d", len(observation.Message()))
	}
}
