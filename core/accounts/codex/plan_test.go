package codex

import "testing"

// TestParsePlanClassifiesKnownUpstreamValues 验证 Codex 套餐别名只在领域层归一。
func TestParsePlanClassifiesKnownUpstreamValues(t *testing.T) {
	tests := []struct {
		raw    string
		family PlanFamily
	}{
		{raw: "free", family: PlanFamilyFree},
		{raw: "go", family: PlanFamilyGo},
		{raw: "plus", family: PlanFamilyPlus},
		{raw: "pro", family: PlanFamilyPro},
		{raw: "prolite", family: PlanFamilyProLite},
		{raw: "pro_lite", family: PlanFamilyProLite},
		{raw: "team", family: PlanFamilyBusiness},
		{raw: "business", family: PlanFamilyBusiness},
		{raw: "self_serve_business_usage_based", family: PlanFamilyBusiness},
		{raw: "enterprise", family: PlanFamilyEnterprise},
		{raw: "enterprise_cbp_usage_based", family: PlanFamilyEnterprise},
		{raw: "hc", family: PlanFamilyEnterprise},
		{raw: "edu", family: PlanFamilyEdu},
		{raw: "education", family: PlanFamilyEdu},
	}

	for _, test := range tests {
		t.Run(test.raw, func(t *testing.T) {
			plan := ParsePlan(test.raw)
			if plan.Raw() != test.raw {
				t.Fatalf("原始套餐值丢失: got=%q want=%q", plan.Raw(), test.raw)
			}
			if plan.Family() != test.family {
				t.Fatalf("套餐族错误: got=%q want=%q", plan.Family(), test.family)
			}
			if !plan.IsKnown() {
				t.Fatal("已知套餐不应标记为未知")
			}
		})
	}
}

// TestParsePlanPreservesUnknownFutureValue 验证未来套餐不会因为本地枚举滞后而丢失。
func TestParsePlanPreservesUnknownFutureValue(t *testing.T) {
	plan := ParsePlan("future_workspace_v2")
	if plan.Raw() != "future_workspace_v2" {
		t.Fatalf("未知原始值丢失: %q", plan.Raw())
	}
	if plan.Family() != PlanFamilyUnknown || plan.IsKnown() {
		t.Fatalf("未知套餐分类错误: %q", plan.Family())
	}
}

// TestParsePlanNormalizesOnlyClassificationKey 验证上游大小写和首尾空白不会污染原始逻辑值。
func TestParsePlanNormalizesOnlyClassificationKey(t *testing.T) {
	plan := ParsePlan("  TEAM  ")
	if plan.Raw() != "TEAM" {
		t.Fatalf("原始逻辑值应只去除首尾空白: %q", plan.Raw())
	}
	if plan.Family() != PlanFamilyBusiness {
		t.Fatalf("大小写归一失败: %q", plan.Family())
	}
}

// TestParsePlanDropsUnsafeMetadata 验证控制字符不会进入日志或后续持久化投影。
func TestParsePlanDropsUnsafeMetadata(t *testing.T) {
	plan := ParsePlan("plus\nforged")
	if plan.Raw() != "" || plan.Family() != PlanFamilyUnknown {
		t.Fatalf("不安全套餐值未被丢弃: raw=%q family=%q", plan.Raw(), plan.Family())
	}
}
