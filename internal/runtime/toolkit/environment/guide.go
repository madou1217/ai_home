package environment

import "strings"

// PlatformLabels 与 Node PLATFORM_LABELS 一致。
var PlatformLabels = map[string]string{
	PlatformMacOS:   "macOS",
	PlatformWindows: "Windows",
	PlatformLinux:   "Linux",
}

// GuideActionLabels 是入门指南里生命周期任务的标题。
var GuideActionLabels = map[string]string{
	"install":   "安装工具",
	"update":    "更新工具",
	"uninstall": "卸载工具",
}

// GuideHomePlaceholders 是查看其他平台指南时的家目录占位符。
var GuideHomePlaceholders = map[string]string{
	PlatformMacOS:   "/Users/<user>",
	PlatformWindows: "C:\\Users\\<user>",
	PlatformLinux:   "/home/<user>",
}

// GuideTask 是入门指南里的一条任务。
type GuideTask struct {
	ID         string      `json:"id"`
	ToolID     string      `json:"toolId"`
	Label      string      `json:"label"`
	Category   string      `json:"category"`
	Template   string      `json:"template"`
	Parameters []Parameter `json:"parameters"`
	Method     string      `json:"method,omitempty"`
	Source     string      `json:"source"`
}

// GuideTool 是入门指南里的一个工具条目。
type GuideTool struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Runtime     string      `json:"runtime"`
	Category    string      `json:"category"`
	Description string      `json:"description"`
	Tasks       []GuideTask `json:"tasks"`
}

// GuidePlatform 是可切换的平台项。
type GuidePlatform struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// GuideResponse 是 GET /environments/guide 的响应。
type GuideResponse struct {
	OK              bool            `json:"ok"`
	Platform        string          `json:"platform"`
	CurrentPlatform string          `json:"currentPlatform"`
	Platforms       []GuidePlatform `json:"platforms"`
	Tools           []GuideTool     `json:"tools"`
}

// GuideOptions 是构建指南的上下文。
type GuideOptions struct {
	// CurrentPlatform 是本机平台；Platform 是请求查看的平台。
	CurrentPlatform string
	Platform        string
	HomeDir         string
}

// BuildGuide 复刻 Node buildEnvironmentGuide。
func BuildGuide(options GuideOptions) GuideResponse {
	currentPlatform := normalizePlatform(options.CurrentPlatform)
	if currentPlatform == "" {
		currentPlatform = PlatformLinux
	}
	requested := strings.ToLower(strings.TrimSpace(options.Platform))
	platform := currentPlatform
	if IsKnownPlatform(requested) {
		platform = requested
	}
	homeDir := options.HomeDir
	if platform != currentPlatform {
		homeDir = GuideHomePlaceholders[platform]
	}
	buildOptions := BuildOptions{Platform: platform, HomeDir: homeDir}
	tools := make([]GuideTool, 0)
	for _, spec := range GuideToolsForPlatform(platform) {
		tasks := make([]GuideTask, 0)
		if spec.ProbeKind != "" || spec.Command != "" {
			for _, action := range []string{"install", "update", "uninstall"} {
				resolved := ResolveToolPlans(spec.ID, action, buildOptions)
				if !resolved.OK || len(resolved.Plans) == 0 {
					continue
				}
				preferred := resolved.Plans[0]
				for _, plan := range resolved.Plans {
					if plan.Method != "AIH 清理器" {
						preferred = plan
						break
					}
				}
				tasks = append(tasks, GuideTask{
					ID:         spec.ID + ":lifecycle:" + action,
					ToolID:     spec.ID,
					Label:      GuideActionLabels[action],
					Category:   action,
					Template:   preferred.Preview,
					Parameters: []Parameter{},
					Method:     preferred.Method,
					Source:     "lifecycle",
				})
			}
		}
		for _, task := range spec.Tasks {
			template := task.Template
			if platform == PlatformWindows && task.WindowsTemplate != "" {
				template = task.WindowsTemplate
			}
			tasks = append(tasks, GuideTask{
				ID:         spec.ID + ":" + task.ID,
				ToolID:     spec.ID,
				Label:      task.Label,
				Category:   task.Category,
				Template:   template,
				Parameters: task.Parameters(),
				Source:     "task",
			})
		}
		tools = append(tools, GuideTool{
			ID:          spec.ID,
			Name:        spec.Name,
			Runtime:     spec.Runtime,
			Category:    spec.Category,
			Description: spec.Description,
			Tasks:       tasks,
		})
	}
	platforms := make([]GuidePlatform, 0, len(Platforms))
	for _, id := range Platforms {
		platforms = append(platforms, GuidePlatform{ID: id, Label: PlatformLabels[id]})
	}
	return GuideResponse{
		OK:              true,
		Platform:        platform,
		CurrentPlatform: currentPlatform,
		Platforms:       platforms,
		Tools:           tools,
	}
}
