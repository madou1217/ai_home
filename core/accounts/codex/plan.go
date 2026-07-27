package codex

import "strings"

// PlanFamily 是 AIH 用于筛选和统计的稳定 Codex 套餐族。
//
// 该类型只表达上游值的业务归类，不包含展示文案，也不会替代原始值。
type PlanFamily string

const (
	// PlanFamilyUnknown 表示上游未提供或返回了当前版本尚不认识的套餐。
	PlanFamilyUnknown PlanFamily = "unknown"
	// PlanFamilyFree 表示 ChatGPT Free。
	PlanFamilyFree PlanFamily = "free"
	// PlanFamilyGo 表示 ChatGPT Go。
	PlanFamilyGo PlanFamily = "go"
	// PlanFamilyPlus 表示 ChatGPT Plus。
	PlanFamilyPlus PlanFamily = "plus"
	// PlanFamilyPro 表示 ChatGPT Pro。
	PlanFamilyPro PlanFamily = "pro"
	// PlanFamilyProLite 表示历史上游值 Pro Lite。
	PlanFamilyProLite PlanFamily = "pro_lite"
	// PlanFamilyBusiness 表示 ChatGPT Business 及其历史 Team 别名。
	PlanFamilyBusiness PlanFamily = "business"
	// PlanFamilyEnterprise 表示 ChatGPT Enterprise。
	PlanFamilyEnterprise PlanFamily = "enterprise"
	// PlanFamilyEdu 表示 ChatGPT Edu。
	PlanFamilyEdu PlanFamily = "edu"
)

// Plan 保存上游原始套餐值及其当前已知的稳定归类。
type Plan struct {
	raw    string
	family PlanFamily
}

// ParsePlan 从可信 ID Token 的公开 claim 创建 Codex 套餐值。
//
// 未知值会原样保留并归为 unknown，避免上游新增套餐时导致账号不可用。
func ParsePlan(raw string) Plan {
	value := normalizePublicMetadata(raw)
	return Plan{
		raw:    value,
		family: classifyPlan(value),
	}
}

// Raw 返回去除首尾空白后的上游原始套餐值。
func (plan Plan) Raw() string {
	return plan.raw
}

// Family 返回稳定套餐族；非法零值也按 unknown 处理。
func (plan Plan) Family() PlanFamily {
	switch plan.family {
	case PlanFamilyFree,
		PlanFamilyGo,
		PlanFamilyPlus,
		PlanFamilyPro,
		PlanFamilyProLite,
		PlanFamilyBusiness,
		PlanFamilyEnterprise,
		PlanFamilyEdu:
		return plan.family
	default:
		return PlanFamilyUnknown
	}
}

// IsKnown 判断当前版本是否认识该上游套餐值。
func (plan Plan) IsKnown() bool {
	return plan.Family() != PlanFamilyUnknown
}

// String 返回稳定套餐族文本，不返回可能变化的上游原始值。
func (family PlanFamily) String() string {
	return string(Plan{family: family}.Family())
}

// classifyPlan 把已清洗的上游值映射为当前已知套餐族。
func classifyPlan(raw string) PlanFamily {
	switch strings.ToLower(raw) {
	case "free":
		return PlanFamilyFree
	case "go":
		return PlanFamilyGo
	case "plus":
		return PlanFamilyPlus
	case "pro":
		return PlanFamilyPro
	case "prolite", "pro_lite":
		return PlanFamilyProLite
	case "team", "business", "self_serve_business_usage_based":
		return PlanFamilyBusiness
	case "enterprise", "enterprise_cbp_usage_based", "hc":
		return PlanFamilyEnterprise
	case "edu", "education":
		return PlanFamilyEdu
	default:
		return PlanFamilyUnknown
	}
}
