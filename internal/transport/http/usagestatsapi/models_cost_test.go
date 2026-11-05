package usagestatsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/core/usageledger"
)

// fakeCostCalculator 复刻真实计算器的契约：按行返回成本与「是否已知」。
type fakeCostCalculator struct {
	costs     []float64
	known     []bool
	supported bool
	calls     int
}

func (fake *fakeCostCalculator) Costs(
	_ context.Context,
	models []usageledger.ModelStats,
) ([]float64, []bool, bool) {
	fake.calls++
	if !fake.supported {
		return nil, nil, false
	}
	return fake.costs, fake.known, true
}

func decodeModelsResponse(t *testing.T, body []byte) (bool, []map[string]any) {
	t.Helper()
	var payload struct {
		CostSupported bool             `json:"cost_supported"`
		Models        []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, body)
	}
	return payload.CostSupported, payload.Models
}

// 有定价时必须给出 cost_usd 与 cost_known=true，并且带 cost_supported。
func TestModelsHandlerAttachesCostWhenPriced(t *testing.T) {
	source := &testSource{models: []usageledger.ModelStats{
		{Provider: "codex", Model: "gpt-5.1", TotalTokens: 1500},
	}}
	calculator := &fakeCostCalculator{
		costs:     []float64{0.00625},
		known:     []bool{true},
		supported: true,
	}
	handler, err := NewModelsHandler(testAuthorizer(true), source, calculator)
	if err != nil {
		t.Fatalf("NewModelsHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ModelsPath+"?from=2026-10-01&to=2026-10-02", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	supported, models := decodeModelsResponse(t, recorder.Body.Bytes())
	if !supported {
		t.Fatal("cost_supported = false, want true")
	}
	if len(models) != 1 {
		t.Fatalf("models = %d", len(models))
	}
	if got, _ := models[0]["cost_usd"].(float64); got != 0.00625 {
		t.Fatalf("cost_usd = %v", models[0]["cost_usd"])
	}
	if known, _ := models[0]["cost_known"].(bool); !known {
		t.Fatal("cost_known = false, want true")
	}
}

// 没有定价的模型必须是「未知」，不能写成 0 元——0 会被当成确实免费。
func TestModelsHandlerLeavesUnknownCostNull(t *testing.T) {
	source := &testSource{models: []usageledger.ModelStats{
		{Provider: "codex", Model: "unknown-model", TotalTokens: 10},
	}}
	calculator := &fakeCostCalculator{
		costs:     []float64{0},
		known:     []bool{false},
		supported: true,
	}
	handler, _ := NewModelsHandler(testAuthorizer(true), source, calculator)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ModelsPath+"?from=2026-10-01&to=2026-10-02", nil))
	_, models := decodeModelsResponse(t, recorder.Body.Bytes())
	if models[0]["cost_usd"] != nil {
		t.Fatalf("cost_usd = %v, want null", models[0]["cost_usd"])
	}
	if known, _ := models[0]["cost_known"].(bool); known {
		t.Fatal("cost_known = true for an unpriced model")
	}
}

// 定价目录不可用时整份响应标 cost_supported=false，而不是让请求失败。
func TestModelsHandlerReportsUnsupportedPricing(t *testing.T) {
	source := &testSource{models: []usageledger.ModelStats{
		{Provider: "codex", Model: "gpt-5.1", TotalTokens: 10},
	}}
	handler, _ := NewModelsHandler(testAuthorizer(true), source, &fakeCostCalculator{supported: false})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ModelsPath+"?from=2026-10-01&to=2026-10-02", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200（定价缺失不该让统计失败）", recorder.Code)
	}
	supported, models := decodeModelsResponse(t, recorder.Body.Bytes())
	if supported {
		t.Fatal("cost_supported = true, want false")
	}
	if models[0]["cost_usd"] != nil {
		t.Fatalf("cost_usd = %v, want null", models[0]["cost_usd"])
	}
}

// 没有注入计算器时也不能报错，只是没有成本口径。
func TestModelsHandlerWithoutCalculator(t *testing.T) {
	source := &testSource{models: []usageledger.ModelStats{{Provider: "codex", Model: "gpt-5.1", TotalTokens: 10}}}
	handler, _ := NewModelsHandler(testAuthorizer(true), source, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, ModelsPath+"?from=2026-10-01&to=2026-10-02", nil))
	supported, _ := decodeModelsResponse(t, recorder.Body.Bytes())
	if supported {
		t.Fatal("cost_supported = true without a calculator")
	}
}
