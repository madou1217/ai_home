package codexappconfig

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexconfigheal"
)

var wslMountPattern = regexp.MustCompile("^/mnt/([a-z])/(.*)$")
var windowsDrivePattern = regexp.MustCompile("^([A-Za-z]):[\\\\/](.*)$")

// HealOptions 控制路径存在性判断与 provider 修复输入。
type HealOptions struct {
	Platform             string
	Exists               func(string) bool
	MissingProviderBlock string
}

func (options HealOptions) platform() string {
	switch strings.ToLower(strings.TrimSpace(options.Platform)) {
	case "", "default":
		return "linux"
	case "win32", "windows":
		return "win32"
	default:
		return strings.ToLower(strings.TrimSpace(options.Platform))
	}
}

func (options HealOptions) exists(path string) bool {
	if options.Exists != nil {
		return options.Exists(path)
	}
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

// HealConversion / HealRemoval 记录单条修复，供调用方写 trace。
type HealConversion struct {
	Name string
	From string
	To   string
}

type HealRemoval struct {
	Name   string
	Reason string
	Path   string
}

// MCPHealResult 是 [mcp_servers.*] 的自愈结果。
type MCPHealResult struct {
	Config    string
	Converted []HealConversion
	Removed   []HealRemoval
}

// ProjectsHealResult 是 [projects.*] 的自愈结果。
type ProjectsHealResult struct {
	Config    string
	Converted []HealConversion
	Removed   []HealRemoval
}

// HooksStateHealResult 是 [hooks.state.*] 的自愈结果。
type HooksStateHealResult struct {
	Config  string
	Removed []HealRemoval
}

// HealResult 汇总 provider / MCP / projects / hooks.state 四段修复。
type HealResult struct {
	Config         string
	Changed        bool
	ProviderChange bool
	MCP            MCPHealResult
	Projects       ProjectsHealResult
	HooksState     HooksStateHealResult
}

// HealConfig 对一份 config.toml 文本执行全部自愈，不触碰文件系统写入。
func HealConfig(config string, options HealOptions) HealResult {
	providerConfig, providerChanged := healProviderConfig(config, options.MissingProviderBlock)
	mcp := HealMCPServers(providerConfig, options)
	projects := HealProjects(mcp.Config, options)
	hooks := HealHooksState(projects.Config, options.platform())
	changed := providerChanged || len(mcp.Converted) > 0 || len(mcp.Removed) > 0 ||
		len(projects.Converted) > 0 || len(projects.Removed) > 0 || len(hooks.Removed) > 0
	configOut := hooks.Config
	if !changed {
		configOut = config
	}
	return HealResult{
		Config: configOut, Changed: changed, ProviderChange: providerChanged,
		MCP: mcp, Projects: projects, HooksState: hooks,
	}
}

func healProviderConfig(config, missingBlock string) (string, bool) {
	request, err := json.Marshal(map[string]any{
		"version": 1, "config": config, "missingProviderBlock": missingBlock,
	})
	if err != nil {
		return config, false
	}
	result, err := codexconfigheal.DecodeAndHeal(request)
	if err != nil {
		return config, false
	}
	return result.Config, result.Changed
}

// HealMCPServers 修复 [mcp_servers.*] 的跨平台路径与死条目。
func HealMCPServers(config string, options HealOptions) MCPHealResult {
	result := MCPHealResult{Config: config, Converted: []HealConversion{}, Removed: []HealRemoval{}}
	lines := splitConfigLines(config)
	index := 0
	changed := false
	for index < len(lines) {
		match := regexp.MustCompile("^\\[mcp_servers\\.([^\\]\\s.]+)(\\.[^\\]]*)?\\]\\s*$").FindStringSubmatch(lines[index])
		if match == nil {
			index++
			continue
		}
		serverName := match[1]
		sectionStart := index
		sectionEnd := index + 1
		for sectionEnd < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[sectionEnd]), "[") {
			sectionEnd++
		}
		if match[2] != "" {
			index = sectionEnd
			continue
		}
		commandLine := -1
		for position := sectionStart; position < sectionEnd; position++ {
			if regexp.MustCompile("^command\\s*=").MatchString(strings.TrimSpace(lines[position])) {
				commandLine = position
				break
			}
		}
		if commandLine < 0 {
			index = sectionEnd
			continue
		}
		commandRaw := parseTomlCommandValue(lines[commandLine])
		target := resolveMCPCommandTarget(commandRaw, options)
		switch target.Action {
		case "convert":
			lines[commandLine] = "command = " + tomlQuote(target.Command)
			result.Converted = append(result.Converted, HealConversion{Name: serverName, From: commandRaw, To: target.Command})
			changed = true
			index = sectionEnd
		case "remove":
			removeEnd := sectionEnd
			for removeEnd < len(lines) {
				next := regexp.MustCompile("^\\[(mcp_servers\\.[^\\]\\s.]+)(\\.[^\\]]*)?\\]\\s*$").FindStringSubmatch(lines[removeEnd])
				if next == nil || next[1] != "mcp_servers."+serverName {
					break
				}
				removeEnd++
				for removeEnd < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[removeEnd]), "[") {
					removeEnd++
				}
			}
			lines = append(lines[:sectionStart], lines[removeEnd:]...)
			result.Removed = append(result.Removed, HealRemoval{Name: serverName, Path: commandRaw})
			changed = true
			index = sectionStart
		default:
			index = sectionEnd
		}
	}
	if changed {
		result.Config = strings.Join(lines, "\n")
	}
	return result
}

type mcpTarget struct {
	Action  string
	Command string
}

func resolveMCPCommandTarget(commandRaw string, options HealOptions) mcpTarget {
	platform := options.platform()
	command := strings.TrimSpace(commandRaw)
	command = strings.Trim(command, "'\"")
	if command == "" || !isAbsolutePathLike(command) {
		return mcpTarget{Action: "keep"}
	}
	if options.exists(command) {
		return mcpTarget{Action: "keep"}
	}
	cross := ""
	if platform == "win32" {
		cross = convertWSLPathToWindows(command)
	} else {
		cross = convertWindowsPathToWSL(command)
	}
	if cross != "" && options.exists(cross) {
		return mcpTarget{Action: "convert", Command: cross}
	}
	mirrored := ""
	if platform == "win32" {
		mirrored = convertWindowsPathToWSL(command)
	} else {
		mirrored = convertWSLPathToWindows(command)
	}
	if mirrored != "" && options.exists(mirrored) {
		return mcpTarget{Action: "keep"}
	}
	return mcpTarget{Action: "remove"}
}

func convertWSLPathToWindows(value string) string {
	match := wslMountPattern.FindStringSubmatch(value)
	if match == nil {
		return ""
	}
	return strings.ToUpper(match[1]) + ":\\" + strings.ReplaceAll(match[2], "/", "\\")
}

func convertWindowsPathToWSL(value string) string {
	match := windowsDrivePattern.FindStringSubmatch(value)
	if match == nil {
		return ""
	}
	return "/mnt/" + strings.ToLower(match[1]) + "/" + strings.ReplaceAll(match[2], "\\", "/")
}

func isAbsolutePathLike(value string) bool {
	text := strings.TrimSpace(value)
	return strings.HasPrefix(text, "/") || windowsDrivePattern.MatchString(text)
}

func parseTomlCommandValue(line string) string {
	match := regexp.MustCompile("^command\\s*=\\s*(.+)$").FindStringSubmatch(line)
	if match == nil {
		return ""
	}
	value := strings.TrimSpace(match[1])
	if strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
		return strings.ReplaceAll(value[1:len(value)-1], "''", "'")
	}
	if strings.HasPrefix(value, "\"") && strings.HasSuffix(value, "\"") {
		inner := value[1 : len(value)-1]
		inner = strings.ReplaceAll(inner, "\\\\", "\\")
		inner = strings.ReplaceAll(inner, "\\\"", "\"")
		return inner
	}
	return strings.Trim(value, "'\"")
}

func tomlQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// HealProjects 清理 [projects.*] 的跨端混杂与死条目。
func HealProjects(config string, options HealOptions) ProjectsHealResult {
	result := ProjectsHealResult{Config: config, Converted: []HealConversion{}, Removed: []HealRemoval{}}
	platform := options.platform()
	lines := splitConfigLines(config)
	headers := make([]projectHeader, 0)
	for index, line := range lines {
		if parsed, ok := parseProjectsHeader(strings.TrimSpace(line)); ok {
			headers = append(headers, projectHeader{Index: index, Key: parsed.Key})
		}
	}
	decisions := map[int]projectDecision{}
	for _, header := range headers {
		key := header.Key
		cross := ""
		if platform == "win32" {
			cross = convertWSLPathToWindows(key)
		} else {
			cross = convertWindowsPathToWSL(key)
		}
		foreign := false
		if platform == "win32" {
			foreign = wslMountPattern.MatchString(key)
		} else {
			foreign = windowsDrivePattern.MatchString(key) && !isVerbatimWindowsPath(key)
		}
		if foreign && cross != "" {
			normalizedCross := normalizeProjectsKey(cross)
			hasNativeDuplicate := false
			for _, other := range headers {
				if other.Index == header.Index {
					continue
				}
				if _, decided := decisions[other.Index]; decided {
					continue
				}
				if normalizeProjectsKey(other.Key) != normalizedCross {
					continue
				}
				native := false
				if platform == "win32" {
					native = !wslMountPattern.MatchString(other.Key)
				} else {
					native = !windowsDrivePattern.MatchString(other.Key) || isVerbatimWindowsPath(other.Key)
				}
				if native {
					hasNativeDuplicate = true
					break
				}
			}
			if hasNativeDuplicate {
				decisions[header.Index] = projectDecision{Action: "remove", Reason: "duplicate"}
				result.Removed = append(result.Removed, HealRemoval{Path: key, Reason: "duplicate"})
				continue
			}
			if options.exists(cross) {
				decisions[header.Index] = projectDecision{Action: "convert", Key: cross}
				result.Converted = append(result.Converted, HealConversion{From: key, To: cross})
				continue
			}
			decisions[header.Index] = projectDecision{Action: "remove", Reason: "dead"}
			result.Removed = append(result.Removed, HealRemoval{Path: key, Reason: "dead"})
			continue
		}
		if platform == "win32" && (windowsDrivePattern.MatchString(key) || isVerbatimWindowsPath(key)) {
			candidates := []string{key}
			if isVerbatimWindowsPath(key) {
				candidates = append(candidates, strings.TrimPrefix(key, "\\\\?\\"))
			}
			exists := false
			for _, candidate := range candidates {
				if options.exists(candidate) {
					exists = true
					break
				}
			}
			if !exists {
				decisions[header.Index] = projectDecision{Action: "remove", Reason: "dead"}
				result.Removed = append(result.Removed, HealRemoval{Path: key, Reason: "dead"})
			}
			continue
		}
		if platform != "win32" && wslMountPattern.MatchString(key) && !options.exists(key) {
			decisions[header.Index] = projectDecision{Action: "remove", Reason: "dead"}
			result.Removed = append(result.Removed, HealRemoval{Path: key, Reason: "dead"})
		}
	}
	if len(decisions) == 0 {
		return result
	}
	output := make([]string, 0, len(lines))
	for index := 0; index < len(lines); {
		decision, decided := decisions[index]
		if decided && decision.Action == "remove" {
			index++
			for index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "[") {
				index++
			}
			continue
		}
		if decided && decision.Action == "convert" {
			output = append(output, buildProjectsHeader(decision.Key))
			index++
			continue
		}
		output = append(output, lines[index])
		index++
	}
	result.Config = strings.Join(output, "\n")
	return result
}

type projectHeader struct {
	Index int
	Key   string
}

type projectDecision struct {
	Action string
	Key    string
	Reason string
}

var projectsHeaderPattern = regexp.MustCompile("^\\[projects\\.('([^']*)'|\"((?:[^\"\\\\]|\\\\.)*)\"|([^\\]\\s.]+))\\]$")

func parseProjectsHeader(line string) (struct{ Key string }, bool) {
	match := projectsHeaderPattern.FindStringSubmatch(line)
	if match == nil {
		return struct{ Key string }{}, false
	}
	if match[2] != "" || strings.HasPrefix(match[1], "'") {
		return struct{ Key string }{Key: match[2]}, true
	}
	if match[3] != "" {
		return struct{ Key string }{Key: unescapeTomlBasic(match[3])}, true
	}
	return struct{ Key string }{Key: match[4]}, true
}

func buildProjectsHeader(key string) string {
	return "[projects.'" + strings.ReplaceAll(key, "'", "''") + "']"
}

func isVerbatimWindowsPath(value string) bool {
	return regexp.MustCompile("^\\\\\\\\\\?\\\\[A-Za-z]:").MatchString(value)
}

func normalizeProjectsKey(value string) string {
	trimmed := strings.TrimPrefix(value, "\\\\?\\")
	return strings.ToLower(strings.ReplaceAll(trimmed, "/", "\\"))
}

func unescapeTomlBasic(value string) string {
	value = strings.ReplaceAll(value, "\\\\", "\\")
	value = strings.ReplaceAll(value, "\\\"", "\"")
	value = strings.ReplaceAll(value, "\\n", "\n")
	value = strings.ReplaceAll(value, "\\t", "\t")
	return value
}

// HealHooksState 清理跨平台残留的 [hooks.state."..."] 信任缓存。
func HealHooksState(config, platform string) HooksStateHealResult {
	result := HooksStateHealResult{Config: config, Removed: []HealRemoval{}}
	lines := splitConfigLines(config)
	removeAt := map[int]struct{}{}
	pattern := regexp.MustCompile("^(.+hooks\\.json):[a-z_]+:\\d+:\\d+$")
	for index, line := range lines {
		key, ok := parseHooksStateHeader(strings.TrimSpace(line))
		if !ok {
			continue
		}
		match := pattern.FindStringSubmatch(key)
		if match == nil {
			continue
		}
		hooksPath := match[1]
		foreign := false
		if platform == "win32" {
			foreign = wslMountPattern.MatchString(hooksPath)
		} else {
			foreign = windowsDrivePattern.MatchString(hooksPath) && !isVerbatimWindowsPath(hooksPath)
		}
		if foreign {
			removeAt[index] = struct{}{}
			result.Removed = append(result.Removed, HealRemoval{Name: key, Path: hooksPath})
		}
	}
	if len(removeAt) == 0 {
		return result
	}
	output := make([]string, 0, len(lines))
	for index := 0; index < len(lines); {
		if _, remove := removeAt[index]; remove {
			index++
			for index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "[") {
				index++
			}
			continue
		}
		output = append(output, lines[index])
		index++
	}
	result.Config = strings.Join(output, "\n")
	return result
}

var hooksStateHeaderPattern = regexp.MustCompile("^\\[hooks\\.state\\.('([^']*)'|\"((?:[^\"\\\\]|\\\\.)*)\")\\]$")

func parseHooksStateHeader(line string) (string, bool) {
	match := hooksStateHeaderPattern.FindStringSubmatch(line)
	if match == nil {
		return "", false
	}
	if strings.HasPrefix(match[1], "'") {
		return match[2], true
	}
	return unescapeTomlBasic(match[3]), true
}

func splitConfigLines(config string) []string {
	return strings.Split(strings.ReplaceAll(config, "\r\n", "\n"), "\n")
}
