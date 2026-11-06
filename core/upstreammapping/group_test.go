package upstreammapping

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// mustRule 按 Node 的规则 JSON 形状构造规则；正则编译留给 NewGroup 校验。
func mustRule(t *testing.T, raw string) rulescore.Rule {
	t.Helper()
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("解析规则失败: %v (%s)", err, raw)
	}
	return rule
}

func validInput(rules ...rulescore.Rule) Input {
	return Input{
		ID:       "uem_0123456789ab",
		Name:     "额度耗尽",
		Provider: "codex",
		Entries:  EntriesFromRules(rules),
	}
}

func TestNewGroupNormalizesNodeSemantics(t *testing.T) {
	rule := mustRule(t, `{
		"kind": "quota_exhausted",
		"statuses": [429, 429],
		"matchers": [
			{"source": "body", "operator": "contains", "value": "insufficient_quota"},
			{"field": "code", "pattern": "^quota_.*$"}
		]
	}`)
	group, err := NewGroup(Input{
		ID:          " uem_0123456789ab ",
		Name:        "  " + strings.Repeat("名", 90) + "  ",
		Description: " " + strings.Repeat("述", 250),
		Provider:    " CodeX ",
		Entries:     EntriesFromRules([]rulescore.Rule{rule}),
	})
	if err != nil {
		t.Fatalf("NewGroup() error = %v", err)
	}
	if group.ID() != "uem_0123456789ab" {
		t.Fatalf("id = %q", group.ID())
	}
	if len([]rune(group.Name())) != MaxNameLength {
		t.Fatalf("name 长度 = %d, want %d（与 Node normalizeText 一样截断）", len([]rune(group.Name())), MaxNameLength)
	}
	if len([]rune(group.Description())) != MaxDescriptionLength {
		t.Fatalf("description 长度 = %d, want %d", len([]rune(group.Description())), MaxDescriptionLength)
	}
	if group.Provider() != "codex" || !group.Enabled() {
		t.Fatalf("provider/enabled = %q/%v", group.Provider(), group.Enabled())
	}
	if len(group.Rules()) != 1 || len(group.Rules()[0].Statuses()) != 1 {
		t.Fatalf("规则未按 Node 语义去重: %+v", group.Rules())
	}
	if group.Version() != 0 || group.Position() != 0 {
		t.Fatalf("新建组不应带持久化元数据: version=%d position=%d", group.Version(), group.Position())
	}
}

func TestNewGroupDefaultsProviderToAll(t *testing.T) {
	rule := mustRule(t, `{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}`)
	input := validInput(rule)
	input.Provider = ""
	group, err := NewGroup(input)
	if err != nil {
		t.Fatalf("NewGroup() error = %v", err)
	}
	if group.Provider() != ScopeAll {
		t.Fatalf("provider = %q, want %q", group.Provider(), ScopeAll)
	}
}

func TestNewGroupRejectsInvalidValues(t *testing.T) {
	validRule := mustRule(t, `{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}`)
	cases := []struct {
		name   string
		mutate func(*Input)
	}{
		{name: "空名称", mutate: func(input *Input) { input.Name = "  " }},
		{name: "非法 id", mutate: func(input *Input) { input.ID = "bad id!" }},
		{name: "非法 Provider 形状", mutate: func(input *Input) { input.Provider = "bad provider" }},
		{name: "没有规则", mutate: func(input *Input) { input.Entries = nil }},
		{
			name: "规则超过上限",
			mutate: func(input *Input) {
				input.Entries = nil
				for index := 0; index <= MaxRulesPerGroup; index++ {
					input.Entries = append(input.Entries, Entry{Position: index, Rule: validRule})
				}
			},
		},
		{
			name: "顺序有空洞",
			mutate: func(input *Input) {
				input.Entries = []Entry{{Position: 0, Rule: validRule}, {Position: 2, Rule: validRule}}
			},
		},
		{
			name: "顺序重复",
			mutate: func(input *Input) {
				input.Entries = []Entry{{Position: 0, Rule: validRule}, {Position: 0, Rule: validRule}}
			},
		},
		{
			name: "零值规则",
			mutate: func(input *Input) {
				// kind 为空的零值规则只能在内存里构造；JSON 解码会先拒绝它。
				input.Entries = EntriesFromRules([]rulescore.Rule{{}})
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := validInput(validRule)
			testCase.mutate(&input)
			if _, err := NewGroup(input); !errors.Is(err, ErrInvalidGroup) {
				t.Fatalf("NewGroup() error = %v, want ErrInvalidGroup", err)
			}
		})
	}
}

func TestNewGroupRejectsNodeUnsafeRegex(t *testing.T) {
	patterns := []string{
		"(a)+",      // 分组
		"a\\1",      // 反向引用
		"a+b",       // 未锚定且量词后仍有内容
		"a{2,3}",    // 重复量词
		"(?i)quota", // 内联旗标（Node 也不接受）
		"*bad",      // 无法编译
	}
	for _, pattern := range patterns {
		t.Run(pattern, func(t *testing.T) {
			raw, err := json.Marshal(map[string]any{
				"kind": "rate_limited",
				"matchers": []map[string]any{
					{"source": "body", "operator": "regex", "value": pattern},
				},
			})
			if err != nil {
				t.Fatalf("构造规则失败: %v", err)
			}
			rule := mustRule(t, string(raw))
			_, err = NewGroup(validInput(rule))
			if !errors.Is(err, ErrInvalidGroup) {
				t.Fatalf("pattern %q error = %v, want ErrInvalidGroup", pattern, err)
			}
		})
	}
}

func TestNewGroupAcceptsAnchoredAndContainsMatchers(t *testing.T) {
	rules := []rulescore.Rule{
		mustRule(t, `{"kind":"rate_limited","matchers":[{"source":"body","operator":"regex","value":"^rate limit"}]}`),
		mustRule(t, `{"kind":"auth_invalid","matchers":[{"source":"json","path":"error.code","operator":"equals","value":"invalid_api_key"}]}`),
		mustRule(t, `{"kind":"service_unavailable","statuses":[503],"matchers":[{"source":"http_code","operator":"equals","value":503}]}`),
	}
	if _, err := NewGroup(validInput(rules...)); err != nil {
		t.Fatalf("NewGroup() error = %v", err)
	}
}

func TestRestoreGroupRequiresMetadata(t *testing.T) {
	rule := mustRule(t, `{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}`)
	created := time.UnixMilli(1000).UTC()
	base := Input{
		ID:        "uem_0123456789ab",
		Name:      "组",
		Provider:  ScopeAll,
		Entries:   EntriesFromRules([]rulescore.Rule{rule}),
		Position:  0,
		Version:   1,
		CreatedAt: created,
		UpdatedAt: created.Add(time.Second),
	}
	if _, err := RestoreGroup(base); err != nil {
		t.Fatalf("RestoreGroup() error = %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*Input)
	}{
		{name: "版本为 0", mutate: func(input *Input) { input.Version = 0 }},
		{name: "缺少时间", mutate: func(input *Input) { input.CreatedAt = time.Time{} }},
		{name: "更新时间早于创建时间", mutate: func(input *Input) { input.UpdatedAt = created.Add(-time.Second) }},
		{name: "负顺序", mutate: func(input *Input) { input.Position = -1 }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := base
			testCase.mutate(&input)
			if _, err := RestoreGroup(input); !errors.Is(err, ErrInvalidGroup) {
				t.Fatalf("RestoreGroup() error = %v, want ErrInvalidGroup", err)
			}
		})
	}
}

func TestSameContentIgnoresMetadata(t *testing.T) {
	rule := mustRule(t, `{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}`)
	first, err := NewGroup(validInput(rule))
	if err != nil {
		t.Fatalf("NewGroup() error = %v", err)
	}
	second := first
	second.version = 7
	second.position = 3
	second.createdAt = time.Now().UTC()
	if !first.SameContent(second) {
		t.Fatal("只有元数据不同的组应视为同内容")
	}
	second.enabled = false
	if first.SameContent(second) {
		t.Fatal("enabled 不同不应视为同内容")
	}
}
