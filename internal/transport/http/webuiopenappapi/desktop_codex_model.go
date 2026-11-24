package webuiopenappapi

import (
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	modelcatalogsettings "github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

// codexDesktopModelFacts 是账号模型目录与最近一次探测在桌面启动时的只读视图。
//
// 模型选择规则与 WebUI 对话目录同一口径：只用 Effective() 的模型（人工强制启用
// 或上游可见），再叠加模型设置里的 enabled 开关；没有显式默认模型时取排序后的
// 第一个。这里不另造一套「哪些模型能用」的判定。
type codexDesktopModelFacts struct {
	// Known 表示账号在模型库里至少有探测事实（哪怕模型列表为空）。
	Known bool
	// Models 是可用于启动的模型 ID，已排序。
	Models []string
	// Default 是模型设置里标记 defaultModel 的模型（若有）。
	Default string
	// AuthRejected 表示最近一次上游探测被认证拒绝（401/403）。
	AuthRejected bool
	// ProbeAtMS / ProbeMessage 是最近一次探测的时间与失败详情。
	ProbeAtMS    int64
	ProbeMessage string
}

// codexDesktopModelFacts 读取账号模型事实；读取失败时返回零值（调用方按旧行为回落）。
func (p *desktopPrepContext) codexDesktopModelFacts() codexDesktopModelFacts {
	facts := codexDesktopModelFacts{}
	if p == nil || p.deps.Store == nil || p.snapshot.AccountRef == "" {
		return facts
	}
	catalog, err := p.deps.Store.ListAllAccountModels(p.ctx)
	if err != nil {
		return facts
	}
	ref := p.snapshot.AccountRef.String()
	var set *accountapp.AccountModelSet
	for index := range catalog.Sets {
		if catalog.Sets[index].AccountRef.String() == ref {
			set = &catalog.Sets[index]
			break
		}
	}
	if set == nil {
		return facts
	}
	facts.Known = true
	facts.ProbeAtMS = set.LastAttemptAt.UnixMilli()
	facts.ProbeMessage = strings.TrimSpace(set.LastErrorMessage)
	facts.AuthRejected = strings.EqualFold(strings.TrimSpace(set.LastErrorCode), "authentication_rejected")

	enabled, defaultModel := p.codexAccountModelSettings(ref, set.Models)
	for _, model := range set.Models {
		id := strings.TrimSpace(model.ModelID().String())
		if id == "" || !model.Effective() {
			continue
		}
		if isEnabled, has := enabled[id]; has && !isEnabled {
			continue
		}
		facts.Models = append(facts.Models, id)
	}
	sort.Strings(facts.Models)
	if defaultModel != "" {
		for _, id := range facts.Models {
			if id == defaultModel {
				facts.Default = id
				break
			}
		}
	}
	return facts
}

// codexAccountModelSettings 读取模型设置里的 enabled/default 覆盖。
//
// 设置读取失败不影响「哪些模型上游可见」这个事实，只是不再叠加人工开关。
func (p *desktopPrepContext) codexAccountModelSettings(
	accountRef string,
	models []accountapp.AccountModel,
) (map[string]bool, string) {
	enabled := make(map[string]bool, len(models))
	if p.aiHomeDir == "" {
		return enabled, ""
	}
	databasePath, err := sqliteaccount.DatabasePath(p.aiHomeDir)
	if err != nil {
		return enabled, ""
	}
	settings, err := modelcatalogsettings.Load(p.ctx, databasePath)
	if err != nil {
		return enabled, ""
	}
	defaultModel := ""
	for _, record := range settings.AccountModels {
		if strings.TrimSpace(record.AccountRef) != accountRef {
			continue
		}
		id := strings.TrimSpace(record.ID)
		if id == "" {
			continue
		}
		enabled[id] = record.Enabled
		if record.Enabled && record.DefaultModel {
			defaultModel = id
		}
	}
	return enabled, defaultModel
}

// selectCodexDesktopModel 决定投影配置里的 model。
//
// 宿主配置里的 model 描述的是宿主账号池（AIH 网关）的模型；账号专属投影必须
// 优先服从账号自己的模型事实，否则会把 gpt 模型发给只有 qwen/deepseek 的账号。
// 返回 overridden 表示模型已偏离宿主值，此时宿主那套推理强度/verbosity 也不该沿用。
func selectCodexDesktopModel(facts codexDesktopModelFacts, hostModel string) (model string, overridden bool) {
	hostModel = strings.TrimSpace(hostModel)
	if !facts.Known {
		// 没有探测事实的账号：保持旧行为（沿用宿主模型），避免误伤尚未探测的新账号。
		return hostModel, false
	}
	if len(facts.Models) == 0 {
		return "", false
	}
	if hostModel != "" {
		for _, id := range facts.Models {
			if id == hostModel {
				return hostModel, false
			}
		}
	}
	if facts.Default != "" {
		return facts.Default, true
	}
	return facts.Models[0], true
}
