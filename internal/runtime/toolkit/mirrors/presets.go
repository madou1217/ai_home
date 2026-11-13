// Package mirrors 实现 Toolkit 的软件源状态探测、设置、命令指南生成与延迟测速。
//
// 对应 Node 侧 mirror-manager.js 与 mirror-plugins/{npm,pip}.js 的语义，支持
// 15 秒 stale-while-revalidate 缓存以及测速时的 SSRF 地址策略校验。
package mirrors

import "strings"

const (
	platformMacOS   = "macos"
	platformWindows = "windows"
	platformLinux   = "linux"
)

// Preset 描述一个预置镜像源条目。
type Preset struct {
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	URL      string             `json:"url"`
	Official bool               `json:"official"`
	Speed    string             `json:"speed"`
	Desc     string             `json:"desc"`
	Active   bool               `json:"active,omitempty"`
	Guides   *MaterializedGuide `json:"guides,omitempty"`
}

// GuideCommand 描述平台命令指南中的一条可执行示例。
type GuideCommand struct {
	Platform  string   `json:"platform"`
	Platforms []string `json:"-"`
	Label     string   `json:"label"`
	Cmd       string   `json:"cmd"`
}

// Guide 描述某个软件源类型的配置指南模板。
type Guide struct {
	Title    string         `json:"title"`
	Commands []GuideCommand `json:"commands"`
}

// MaterializedGuide 是将 <URL> 与 <HOST> 占位符替换为具体源地址后的指南。
type MaterializedGuide struct {
	Title      string         `json:"title"`
	SourceURL  string         `json:"sourceUrl,omitempty"`
	SourceHost string         `json:"sourceHost,omitempty"`
	Commands   []GuideCommand `json:"commands"`
}

// KindSummary 是供界面渲染的软件源类型摘要。
type KindSummary struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Label        string `json:"label"`
	SettingLabel string `json:"settingLabel"`
}

// PluginDef 定义一个静态镜像源插件元数据。
type PluginDef struct {
	ID           string
	Name         string
	Label        string
	SettingLabel string
	Platforms    []string
	Presets      []Preset
	Guide        Guide
}

var (
	allPlatforms   = []string{platformMacOS, platformWindows, platformLinux}
	posixPlatforms = []string{platformMacOS, platformLinux}
	winPlatforms   = []string{platformWindows}
)

var npmPlugin = PluginDef{
	ID:           "npm",
	Name:         "npm",
	Label:        "npm / pnpm / yarn",
	SettingLabel: "npm registry",
	Platforms:    allPlatforms,
	Presets: []Preset{
		{ID: "npmmirror", Name: "淘宝源 (npmmirror)", URL: "https://registry.npmmirror.com/", Official: false, Speed: "国内极速", Desc: "国内主流镜像，阿里云同步，支持 npm / yarn / pnpm 快速下载"},
		{ID: "npmjs", Name: "官方源 (npmjs)", URL: "https://registry.npmjs.org/", Official: true, Speed: "全球官方", Desc: "npm 官方主源，包更新最及时，海外或有代理时首选"},
		{ID: "tencent", Name: "腾讯云镜像", URL: "https://mirrors.cloud.tencent.com/npm/", Official: false, Speed: "国内高速", Desc: "腾讯云内外部加速源，稳定高可用"},
		{ID: "aliyun", Name: "阿里云镜像", URL: "https://npm.aliyun.com/", Official: false, Speed: "国内高速", Desc: "阿里云自建公共 npm 镜像"},
		{ID: "huawei", Name: "华为云镜像", URL: "https://repo.huaweicloud.com/repository/npm/", Official: false, Speed: "国内高速", Desc: "华为开源镜像站提供的 npm 缓存镜像"},
	},
	Guide: Guide{
		Title: "npm / pnpm / yarn 镜像配置命令行指南",
		Commands: []GuideCommand{
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "npm 一键设为全局源", Cmd: "npm config set registry <URL>"},
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "pnpm 一键设为全局源", Cmd: "pnpm config set registry <URL>"},
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "yarn 一键设为全局源", Cmd: "yarn config set registry <URL>"},
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "单次临时安装使用镜像", Cmd: "npm install <package> --registry=<URL>"},
			{Platform: "macOS / Linux (.npmrc)", Platforms: posixPlatforms, Label: "配置文件直接写入", Cmd: "printf '%s\\n' registry=<URL> >> ~/.npmrc"},
			{Platform: "Windows (PowerShell)", Platforms: winPlatforms, Label: "PowerShell 写入 .npmrc", Cmd: `Add-Content -Path $HOME\.npmrc -Value ("registry=" + <URL>)`},
		},
	},
}

var pipPlugin = PluginDef{
	ID:           "pip",
	Name:         "pip",
	Label:        "Python pip",
	SettingLabel: "pip global.index-url",
	Platforms:    allPlatforms,
	Presets: []Preset{
		{ID: "tuna", Name: "清华源 (TUNA)", URL: "https://pypi.tuna.tsinghua.edu.cn/simple", Official: false, Speed: "国内极速", Desc: "清华大学开源软件镜像站，国内最常用的 PyPI 镜像之一"},
		{ID: "pypi", Name: "官方源 (PyPI)", URL: "https://pypi.org/simple", Official: true, Speed: "全球官方", Desc: "Python 官方 PyPI 软件源，包版本最全最新"},
		{ID: "aliyun", Name: "阿里云镜像", URL: "https://mirrors.aliyun.com/pypi/simple/", Official: false, Speed: "国内高速", Desc: "阿里云公共 PyPI 镜像源，CDN 节点丰富"},
		{ID: "ustc", Name: "中科大镜像", URL: "https://pypi.mirrors.ustc.edu.cn/simple/", Official: false, Speed: "国内高速", Desc: "中国科学技术大学 PyPI 镜像源"},
		{ID: "douban", Name: "豆瓣镜像", URL: "https://pypi.doubanio.com/simple/", Official: false, Speed: "国内高速", Desc: "老牌经典豆瓣 PyPI 源，速度稳定"},
		{ID: "tencent", Name: "腾讯云镜像", URL: "https://mirrors.cloud.tencent.com/pypi/simple/", Official: false, Speed: "国内高速", Desc: "腾讯云公共 PyPI 镜像源"},
	},
	Guide: Guide{
		Title: "Python pip 镜像配置命令行指南",
		Commands: []GuideCommand{
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "pip 一键设为全局源", Cmd: "pip config set global.index-url <URL>"},
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "pip 额外添加备用源 (extra-index-url)", Cmd: "pip config set global.extra-index-url <URL>"},
			{Platform: "All Platforms (CLI)", Platforms: allPlatforms, Label: "单次临时安装使用镜像 (跳过信任警告)", Cmd: "pip install <package> -i <URL> --trusted-host <HOST>"},
			{Platform: "macOS / Linux (pip.conf)", Platforms: posixPlatforms, Label: "写入 pip.conf", Cmd: "mkdir -p ~/.pip && printf '[global]\\nindex-url = %s\\n' <URL> > ~/.pip/pip.conf"},
			{Platform: "Windows (PowerShell)", Platforms: winPlatforms, Label: "Windows 写入 pip.ini", Cmd: "New-Item -ItemType Directory -Force -Path $env:APPDATA\\pip; Set-Content -Path $env:APPDATA\\pip\\pip.ini -Value (\"[global]`nindex-url = \" + <URL>)"},
		},
	},
}

var mirrorPlugins = []PluginDef{npmPlugin, pipPlugin}

func normalizePlatform(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "darwin", "macos":
		return platformMacOS
	case "windows", "win32":
		return platformWindows
	case "linux":
		return platformLinux
	default:
		return platformLinux
	}
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
