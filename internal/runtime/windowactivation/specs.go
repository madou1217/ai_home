// Package windowactivation 提供账号滚动限额窗口激活的规格注册、账本对账、探测派发与周期调度。
package windowactivation

import (
	"net/url"
	"strings"
)

// WindowMatch 描述如何从用量快照条目中识别目标滚动窗口。
type WindowMatch struct {
	WindowMinutes int64
	ResetInLabel  string
}

// ProbeSpec 描述某一 Provider 极小探测请求与窗口能力规格。
type ProbeSpec struct {
	Provider          string
	Path              func(model string) string
	Model             string
	ModelCandidates   []string
	ProbeModelPattern string
	OutputTokenCap    int
	ResponseShape     string
	WindowMode        string
	WindowMatch       WindowMatch
	Body              func(model string) map[string]any
}

var (
	probeProviderOrder = []string{"codex", "agy"}
	probeSpecs         = map[string]ProbeSpec{
		"codex": {
			Provider: "codex",
			Path:     func(string) string { return "/v1/responses" },
			Model:    "gpt-5.4-mini",
			ModelCandidates: []string{
				"gpt-5.6-sol",
				"gpt-5.6-luna",
				"gpt-5.6-terra",
				"gpt-6-sol",
				"gpt-6-luna",
				"gpt-6.1-sol",
				"gpt-6-astra",
			},
			ProbeModelPattern: "^gpt-",
			OutputTokenCap:    32,
			ResponseShape:     "openai.response",
			WindowMatch:       WindowMatch{WindowMinutes: 300},
			Body: func(model string) map[string]any {
				selected := strings.TrimSpace(model)
				if selected == "" {
					selected = "gpt-5.4-mini"
				}
				return map[string]any{
					"model": selected,
					"input": []map[string]any{
						{
							"role": "user",
							"content": []map[string]any{
								{"type": "input_text", "text": "Reply exactly OK."},
							},
						},
					},
					"store":     false,
					"reasoning": map[string]any{"effort": "low"},
					"stream":    false,
				}
			},
		},
		"agy": {
			Provider: "agy",
			Path: func(model string) string {
				selected := strings.TrimSpace(model)
				if selected == "" {
					selected = "gemini-2.5-flash"
				}
				return "/v1beta/models/" + url.PathEscape(selected) + ":generateContent"
			},
			Model: "gemini-2.5-flash",
			ModelCandidates: []string{
				"gemini-2.5-flash-lite",
				"gemini-3-flash",
				"gemini-3-flash-agent",
				"gemini-3.5-flash-lite",
			},
			ProbeModelPattern: "^gemini-",
			OutputTokenCap:    8,
			ResponseShape:     "gemini.generateContent",
			WindowMode:        "fixed",
			WindowMatch:       WindowMatch{WindowMinutes: 300, ResetInLabel: "5h"},
			Body: func(string) map[string]any {
				return map[string]any{
					"contents": []map[string]any{
						{
							"role":  "user",
							"parts": []map[string]any{{"text": "Reply exactly OK."}},
						},
					},
					"generationConfig": map[string]any{
						"maxOutputTokens": 8,
						"temperature":     0,
						"thinkingConfig": map[string]any{
							"includeThoughts": false,
							"thinkingBudget":  0,
						},
					},
				}
			},
		},
	}
)

// NormalizeProvider 统一规范化 Provider 标识。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// GetProbeSpec 按 Provider 查询探测规格；未知 Provider 返回 false。
func GetProbeSpec(provider string) (ProbeSpec, bool) {
	spec, ok := probeSpecs[NormalizeProvider(provider)]
	if !ok {
		return ProbeSpec{}, false
	}
	spec.ModelCandidates = append([]string(nil), spec.ModelCandidates...)
	return spec, true
}

// IsSupportedProvider 判断 Provider 是否支持窗口激活探测。
func IsSupportedProvider(provider string) bool {
	_, ok := probeSpecs[NormalizeProvider(provider)]
	return ok
}

// ListProbeProviders 返回注册表中支持窗口激活探测的 Provider 列表。
func ListProbeProviders() []string {
	return append([]string(nil), probeProviderOrder...)
}
