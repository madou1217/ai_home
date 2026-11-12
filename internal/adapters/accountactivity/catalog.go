package accountactivity

// 账号活动的动作目录（Go 侧的声明数据）。
//
// 为什么 Go 要自带一份声明：这五条路由的**参数校验与选项解析**必须在 Go 完成
// （Node 只做执行），而校验需要「这个动作有哪些参数、哪些取值合法」。Node 的
// Provider 描述符（lib/providers/defs/*.js）仍是账号页 activityActions 的来源；
// 这里按同一份声明镜像，两者都必须改的动作只有一个：新增/修改活动动作。
//
// 目录本身不是 Provider 白名单：查询按 Provider 取动作清单，未声明的 Provider
// 得到空清单，调用方据此返回 Node 同款的 activity_unsupported / activity_action_unknown。
// 新增 Provider 只需要在 builtinDeclarations 里加一条数据，没有分支代码要改。

import (
	"strings"
	"time"
)

// ParamOption 是枚举参数的候选值（描述符里直接写死的 options）。
type ParamOption struct {
	Value       string
	Label       string
	Description string
}

// ParamField 是动作的一个参数声明。
//
// Type 决定归一规则（account-refs / enum / string / boolean），与
// lib/account/activity-claim/params.js 的类型适配器一一对应。
type ParamField struct {
	Key         string
	Label       string
	Type        string
	Description string
	Required    bool
	// EmptyMeans 是「留空」对用户的语义（all / any），只做展示。
	EmptyMeans string
	MaxItems   int
	// Options 是 enum 的直接候选值。
	Options []ParamOption
	// OptionsFrom 为 kinds 时，候选值来自 Action.Kinds。
	OptionsFrom string
}

// Kind 是活动结果的类型分类（今天的唯一用途：zcode 的「臭鸡蛋类型」）。
//
// When 是「有序、首个命中」的分类谓词；键为契约里的谓词名，值为比较基准。
// 求值器只有 ClassifyPlan 一份，未知谓词 fail-closed 返回不匹配。
type Kind struct {
	ID          string
	Label       string
	Description string
	When        map[string]string
}

// Action 是一个可执行的活动动作。
type Action struct {
	ID          string
	Label       string
	Handler     string
	Description string
	Schedulable bool
	// ScheduleDebounce 是同一动作两次触发之间的最小间隔（描述符 scheduleDebounceMs）。
	ScheduleDebounce time.Duration
	SupportsProbe    bool
	Params           []ParamField
	Kinds            []Kind
}

// Catalog 是按 Provider 索引的动作目录。
type Catalog struct {
	byProvider map[string][]Action
}

// NewCatalog 用声明数据构建目录；Provider 名按小写去空白归一。
func NewCatalog(declarations map[string][]Action) *Catalog {
	normalized := make(map[string][]Action, len(declarations))
	for provider, actions := range declarations {
		key := strings.ToLower(strings.TrimSpace(provider))
		if key == "" || len(actions) == 0 {
			continue
		}
		normalized[key] = append([]Action(nil), actions...)
	}
	return &Catalog{byProvider: normalized}
}

// Actions 返回该 Provider 声明的动作清单（副本）。
func (catalog *Catalog) Actions(provider string) []Action {
	if catalog == nil {
		return nil
	}
	actions := catalog.byProvider[strings.ToLower(strings.TrimSpace(provider))]
	if len(actions) == 0 {
		return nil
	}
	return append([]Action(nil), actions...)
}

// Find 按动作 id 查找；actionID 为空时返回第一个动作（与 Node getActivityAction 一致）。
func (catalog *Catalog) Find(provider string, actionID string) (Action, bool) {
	actions := catalog.Actions(provider)
	if len(actions) == 0 {
		return Action{}, false
	}
	wanted := strings.ToLower(strings.TrimSpace(actionID))
	if wanted == "" {
		return actions[0], true
	}
	for _, action := range actions {
		if action.ID == wanted {
			return action, true
		}
	}
	return Action{}, false
}

// BuiltinCatalog 返回与 Node 描述符一一对应的活动目录。
//
// 三个 handler 的语义见 lib/account/activity-claim/index.js：
//   - workbuddy-daily-checkin：CN 站（workbuddycn / codebuddycn）每日签到，幂等；
//   - qoder-daily-checkin：Qoder 国际站/国内站每日签到，幂等；
//   - zcode-plan-claim：周末/试用套餐领取，需要时过无痕验证码。
func BuiltinCatalog() *Catalog {
	return NewCatalog(builtinDeclarations())
}

func builtinDeclarations() map[string][]Action {
	accountRefsField := ParamField{
		Key:         "accountRefs",
		Label:       "账号",
		Type:        "account-refs",
		Description: "留空 = 该 provider 的全部账号",
		EmptyMeans:  "all",
		MaxItems:    200,
	}
	dailyCheckin := func() Action {
		return Action{
			ID:          "daily_checkin",
			Label:       "签到",
			Handler:     "workbuddy-daily-checkin",
			Description: "每天领取一次积分（桌面端「立即领取」）",
			Schedulable: true,
			// 签到一天一次：定时任务每小时最多触发一次，重复触发只执行一次。
			ScheduleDebounce: time.Hour,
			SupportsProbe:    true,
			Params:           []ParamField{accountRefsField},
		}
	}
	qoderCheckin := func() Action {
		return Action{
			ID:          "daily_checkin",
			Label:       "签到",
			Handler:     "qoder-daily-checkin",
			Description: "每天 10:00 (UTC+8) 重置，领取 100 Credits",
			Schedulable: true,
			// 签到一天一次，1 小时内重复触发只执行一次。
			ScheduleDebounce: time.Hour,
		}
	}
	return map[string][]Action{
		// CN 站独有：国际站两支的 checkin-activity-status 恒返回 active:false。
		"workbuddycn": {dailyCheckin()},
		"codebuddycn": {dailyCheckin()},
		"qoder":       {qoderCheckin()},
		"qodercn":     {qoderCheckin()},
		"zcode":       {zcodePlanClaim()},
	}
}

func zcodePlanClaim() Action {
	return Action{
		ID:               "trial_plan",
		Label:            "领臭鸡蛋",
		Handler:          "zcode-plan-claim",
		Description:      "活动窗口开放时可领；默认先裸领，只有上游回 3007 才解一次无痕验证",
		Schedulable:      true,
		ScheduleDebounce: 30 * time.Minute,
		SupportsProbe:    true,
		Params: []ParamField{
			{
				Key:         "accountRefs",
				Label:       "账号",
				Type:        "account-refs",
				Description: "留空 = 该 provider 的全部账号",
				EmptyMeans:  "all",
				MaxItems:    200,
			},
			{
				Key:         "planKind",
				Label:       "臭鸡蛋类型",
				Type:        "enum",
				Description: "留空 = 按 priority 领当前可领的一个",
				EmptyMeans:  "any",
				OptionsFrom: "kinds",
			},
		},
		// 分类规则：有序、首个命中。必须先按 plan_id 判 —— 营销投放只下发 plan_id，
		// 没有 name；-wk 后缀就是「周末活动」。
		Kinds: []Kind{
			{
				ID:          "weekend_build",
				Label:       "ZCODE WEEKEND BUILD",
				Description: "周末活动套餐（plan_id 以 -wk 结尾，如 zcode-v3-start-plan-1030-wk）",
				When:        map[string]string{"planIdSuffix": "-wk"},
			},
			{
				ID:          "start_plan",
				Label:       "ZCode Start Plan",
				Description: "早期试用套餐（如 zcode-v3-start-plan-0817）",
				When:        map[string]string{"planIdPrefix": "zcode-v3-start-plan"},
			},
		},
	}
}

// ClassifyPlan 命中第一个 kind；都不命中返回空串（与 Node classifyPlan 一致）。
func ClassifyPlan(plan map[string]any, kinds []Kind) string {
	planID := textOf(plan["planId"])
	if planID == "" {
		planID = textOf(plan["plan_id"])
	}
	name := textOf(plan["name"])
	if planID == "" && name == "" {
		return ""
	}
	for _, kind := range kinds {
		if kind.When == nil || len(kind.When) == 0 {
			continue
		}
		matched := true
		for predicate, expected := range kind.When {
			if expected == "" || !matchPredicate(predicate, expected, planID, name) {
				matched = false
				break
			}
		}
		if matched {
			return kind.ID
		}
	}
	return ""
}

func matchPredicate(predicate string, expected string, planID string, name string) bool {
	switch predicate {
	case "planIdPrefix":
		return strings.HasPrefix(planID, expected)
	case "planIdSuffix":
		return strings.HasSuffix(planID, expected)
	case "planIdContains":
		return strings.Contains(planID, expected)
	case "nameContains":
		return strings.Contains(name, expected)
	default:
		// 契约已把未知谓词拒在加载期；这里再兜一层，避免手工构造的 kinds 静默命中。
		return false
	}
}
