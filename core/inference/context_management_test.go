package inference

import "testing"

// mustTestContextManagement 创建请求能力推导测试共享的最小上下文编辑。
func mustTestContextManagement(t *testing.T) *ContextManagement {
	t.Helper()
	edit, err := NewClearThinkingEdit(nil)
	if err != nil {
		t.Fatalf("NewClearThinkingEdit() error = %v", err)
	}
	management, err := NewContextManagement(edit)
	if err != nil {
		t.Fatalf("NewContextManagement() error = %v", err)
	}
	return &management
}

// TestContextManagementPreservesUnitsAndOwnsMutableSlices 验证阈值单位不会
// 混淆，构造输入和 getter 返回值也不能修改领域快照。
func TestContextManagementPreservesUnitsAndOwnsMutableSlices(t *testing.T) {
	t.Parallel()

	trigger, err := NewContextMetric(ContextMetricInputTokens, 180000)
	if err != nil {
		t.Fatalf("NewContextMetric(trigger) error = %v", err)
	}
	keep, err := NewContextMetric(ContextMetricToolUses, 5)
	if err != nil {
		t.Fatalf("NewContextMetric(keep) error = %v", err)
	}
	tools := []string{"Read", "Grep"}
	clearInputs, err := NewNamedToolInputClear(tools)
	if err != nil {
		t.Fatalf("NewNamedToolInputClear() error = %v", err)
	}
	edit, err := NewClearToolUsesEdit(ClearToolUsesInput{
		Trigger:         &trigger,
		Keep:            &keep,
		ClearToolInputs: &clearInputs,
		ExcludeTools:    []string{"Edit"},
	})
	if err != nil {
		t.Fatalf("NewClearToolUsesEdit() error = %v", err)
	}
	management, err := NewContextManagement(edit)
	if err != nil {
		t.Fatalf("NewContextManagement() error = %v", err)
	}

	tools[0] = "Mutated"
	returned := management.Edits()
	returnedPolicy, found := returned[0].ClearToolInputs()
	if !found {
		t.Fatal("ClearToolInputs() found = false")
	}
	returnedTools := returnedPolicy.Tools()
	returnedTools[0] = "ChangedAgain"
	actualPolicy, _ := management.Edits()[0].ClearToolInputs()
	actualTrigger, _ := management.Edits()[0].Trigger()
	if actualPolicy.Tools()[0] != "Read" ||
		actualTrigger.Kind() != ContextMetricInputTokens ||
		actualTrigger.Value() != 180000 {
		t.Fatalf(
			"management mutated: tools=%v trigger=(%s,%d)",
			actualPolicy.Tools(),
			actualTrigger.Kind(),
			actualTrigger.Value(),
		)
	}
}
