// Package upstreamrules 提供账号自定义上游错误规则的测试策略。
//
// 它复用生产装配的同一条链路（Node 归一化 JSON → 领域解码 → 投影存储 → 求值端口），
// 因此使用它的分类点测试断言的是「真的把账号、状态码和原始正文交给了规则」，
// 而不是某个替身的行为。
package upstreamrules

import (
	"encoding/json"
	"errors"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
)

// ErrInvalidFixture 表示夹具的规则 JSON 不是可承接的投影形态。
var ErrInvalidFixture = errors.New("测试规则投影无效")

// NewEvaluator 构造只承接 provider 与 accountRef 组合的真实规则求值端口。
func NewEvaluator(
	provider string,
	accountRef string,
	rulesJSON string,
) (configured.Rules, error) {
	store, err := NewStore(provider, accountRef, rulesJSON)
	if err != nil {
		return nil, err
	}
	return configured.NewEvaluator(store), nil
}

// NewStore 构造只承接单个账号的投影存储，便于同时断言接受与丢弃结果。
func NewStore(
	provider string,
	accountRef string,
	rulesJSON string,
) (*rulesapp.Store, error) {
	var decoded []rulescore.Rule
	if err := json.Unmarshal([]byte(rulesJSON), &decoded); err != nil {
		return nil, ErrInvalidFixture
	}
	store, err := rulesapp.NewStore(rulesapp.Options{
		SupportedProviders: []string{provider},
	})
	if err != nil {
		return nil, err
	}
	result, err := store.Replace([]rulesapp.AccountRules{
		rulesapp.NewAccountRules(accountRef, provider, decoded),
	})
	if err != nil {
		return nil, err
	}
	if len(result.Accepted) != 1 || len(result.Dropped) != 0 {
		return nil, ErrInvalidFixture
	}
	return store, nil
}

// SingleRuleJSON 返回一条单条件规则的 Node 归一化 JSON。
//
// source/operator 取值与 Node ERROR_RULE_SOURCES / ERROR_RULE_OPERATORS 一致；
// statuses 为空表示不限状态码（仍受失败证据门约束）。
func SingleRuleJSON(
	name string,
	kind string,
	statuses []int,
	source string,
	operator string,
	value any,
) string {
	if statuses == nil {
		statuses = []int{}
	}
	matcher := map[string]any{
		"source":   source,
		"operator": operator,
		"value":    value,
	}
	payload, err := json.Marshal([]map[string]any{
		{
			"name":     name,
			"kind":     kind,
			"enabled":  true,
			"statuses": statuses,
			"matchers": []map[string]any{matcher},
		},
	})
	if err != nil {
		return ""
	}
	return string(payload)
}
