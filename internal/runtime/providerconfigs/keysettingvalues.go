package providerconfigs

import (
	"strings"

	"github.com/madou1217/ai_home/application/agymodelnames"
)

// NormalizeKeySettingValue 把关键设置取值收敛到该 Provider CLI 真正接受的形态。
//
// agy 的 settings.json/model 只接受显示名（例如 "Gemini 3.8 Flash (High)"）；
// 内部 id 会让 CLI 报 "not recognized as a known model"。历史账号覆盖、外部
// 编辑或旧版 UI 都可能留下内部 id，所以读取展示、写入保存、启动注入三处
// 都必须经过同一个翻译入口，避免各入口各自判断。
//
// 无法识别的值原样返回：是否可用由候选投影与上游报错决定，这里不做丢弃。
func NormalizeKeySettingValue(provider, path, value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	if strings.EqualFold(strings.TrimSpace(provider), "agy") &&
		strings.TrimSpace(path) == "model" {
		if name := agymodelnames.Resolve(text); name != "" {
			return name
		}
	}
	return text
}

// normalizeKeyValues 就地规范化一组关键设置取值（用于读取视图）。
func normalizeKeyValues(provider string, settings []KeySetting, values map[string]string) {
	for _, setting := range settings {
		value, ok := values[setting.Path]
		if !ok {
			continue
		}
		values[setting.Path] = NormalizeKeySettingValue(provider, setting.Path, value)
	}
}