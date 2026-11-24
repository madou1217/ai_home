package completion

import (
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
)

// serverConfigField 是 `aih server config set` 的 Go 侧旗标描述符。
//
// 事实来源是 cmd/aih/server_config.go 的解析器（configFlagKey / 显式开关分支），
// 这里只为补全补上说明与枚举取值，不新增任何 Go 侧尚不接受的旗标。
type serverConfigField struct {
	Flag    string
	Summary string
	// Boolean 表示该旗标是开关（没有取值位）；其余旗标都有待填的取值。
	Boolean bool
	// Values 是唯一允许的枚举取值；空表示自由取值。
	Values []string
}

var serverConfigFields = buildServerConfigFields()

// buildServerConfigFields 从 application/serverconfig 的共享 schema 生成，
// 不再维护第二份旗标/枚举清单。
func buildServerConfigFields() []serverConfigField {
	fields := make([]serverConfigField, 0, len(serverconfig.Fields)+6)
	for _, field := range serverconfig.Fields {
		if field.LegacyReason != "" {
			continue
		}
		switch field.Key {
		case "openNetwork", "windowActivation", "goCoreEnabled":
			fields = append(fields,
				serverConfigField{Flag: field.Flag, Summary: field.Summary, Boolean: true},
				serverConfigField{Flag: field.NegativeFlag, Summary: field.Summary, Boolean: true})
		case "apiKey", "managementKey":
			fields = append(fields,
				serverConfigField{Flag: field.Flag, Summary: field.Summary},
				serverConfigField{Flag: field.GenerateFlag, Summary: "生成并保存新的 " + field.Summary, Boolean: true})
		case "upstream429Retry":
			fields = append(fields,
				serverConfigField{Flag: "--upstream-429-retry", Summary: field.Summary, Boolean: true},
				serverConfigField{Flag: "--no-upstream-429-retry", Summary: field.Summary, Boolean: true},
				serverConfigField{Flag: "--upstream-429-retry-backoff", Summary: "退避队列（秒，逗号分隔）"})
		default:
			fields = append(fields, serverConfigField{
				Flag: field.Flag, Summary: field.Summary, Values: field.Choices,
				Boolean: field.Type == serverconfig.TypeBool,
			})
		}
	}
	return fields
}

// serverConfigOptionSpecs 把同一份 schema 投影成命令树选项，供
// `aih server config <TAB>` 直接列出；取值仍由 serverConfigValues 提供。
func serverConfigOptionSpecs() []optionSpec {
	options := make([]optionSpec, 0, len(serverConfigFields))
	for _, field := range serverConfigFields {
		options = append(options, optionSpec{Name: field.Flag, Summary: field.Summary})
	}
	return options
}

func findServerConfigField(flag string) (serverConfigField, bool) {
	name := strings.TrimSpace(flag)
	for _, field := range serverConfigFields {
		if field.Flag == name {
			return field, true
		}
	}
	return serverConfigField{}, false
}

func listServerConfigFlags() []Candidate {
	result := make([]Candidate, 0, len(serverConfigFields))
	for _, field := range serverConfigFields {
		result = append(result, Candidate{Value: field.Flag, Description: field.Summary, Group: groupFlag})
	}
	return result
}

// serverConfigValues 返回某个旗标的取值候选。
// present=false 表示该旗标是开关或未知旗标（回到旗标列表）；
// present=true 且列表为空表示「有取值位但不是枚举」（不要再列旗标）。
func serverConfigValues(flag string) ([]Candidate, bool) {
	field, found := findServerConfigField(flag)
	if !found || field.Boolean {
		return nil, false
	}
	result := make([]Candidate, 0, len(field.Values))
	for _, value := range field.Values {
		result = append(result, Candidate{Value: value, Description: "允许的取值", Group: groupFlag})
	}
	return result, true
}
