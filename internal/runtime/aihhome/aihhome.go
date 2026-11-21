// Package aihhome 定义 AIH 数据根在账号投影中的宿主回退规则。
//
// 投影 HOME（run/auth-projections 或 run/login）里的 .ai_home 只承载运行态
// 数据，网关配置与账号库都在宿主的 .ai_home；读取方在投影配置缺失时按本包
// 的同一规则回退，避免各入口各写一遍路径判断。
package aihhome

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// projectedRootPattern 匹配投影 HOME 下的 AIH 数据根：
// <host>/.ai_home/run/{login|auth-projections}/...[/.ai_home]。
// 贪婪前缀保证取到最外层的宿主数据根，而不是投影内部再嵌套的 .ai_home。
var projectedRootPattern = regexp.MustCompile(`^(.+/\.ai_home)/run/(?:login|auth-projections)/`)

// ProjectedHostAIHome 返回投影 AIH 数据根对应的宿主数据根（<host>/.ai_home）。
//
// 只有宿主数据根的 aih.db 真实存在时才回退；普通数据根返回空串。
func ProjectedHostAIHome(aiHomeDir string) string {
	slashed := strings.ReplaceAll(strings.TrimSpace(aiHomeDir), `\`, "/")
	match := projectedRootPattern.FindStringSubmatch(strings.TrimRight(slashed, "/"))
	if match == nil {
		return ""
	}
	root := filepath.FromSlash(match[1])
	info, err := os.Stat(filepath.Join(root, "aih.db"))
	if err != nil || info.IsDir() {
		return ""
	}
	return root
}
