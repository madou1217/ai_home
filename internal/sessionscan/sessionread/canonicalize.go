package sessionread

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

type projectionMapping struct {
	from []string
	to   []string
}

var (
	projectionAliasRoots = [][]string{
		{"run", "auth-projections"},
		{"profiles"},
	}

	providerCustomMappings = map[string][]projectionMapping{
		"agy": {
			{from: []string{".gemini", "antigravity-cli"}, to: []string{".gemini", "antigravity-cli"}},
			{from: []string{".gemini", "config"}, to: []string{".gemini", "config"}},
			{from: []string{".gemini", "GEMINI.md"}, to: []string{".gemini", "GEMINI.md"}},
			{from: []string{".gemini"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, ".gemini"}},
			{from: []string{"Library"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "Library"}},
			{from: []string{".local", "share"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "xdg", "data"}},
			{from: []string{".local", "state"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "xdg", "state"}},
			{from: []string{".cache"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "xdg", "cache"}},
			{from: []string{".config"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "xdg", "config"}},
			{from: []string{"AppData", "Roaming"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "AppData", "Roaming"}},
			{from: []string{"AppData", "Local"}, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "AppData", "Local"}},
			{from: nil, to: []string{".gemini", "antigravity-cli", storagepolicy.RuntimeHomeDir, "home"}},
		},
		"opencode": {
			{from: []string{".local", "share", "aih-opencode-runtime", "opencode"}, to: []string{".local", "share", "opencode"}},
			{from: []string{".local", "share", "opencode"}, to: []string{".local", "share", "opencode"}},
			{from: []string{".config", "opencode"}, to: []string{".config", "opencode"}},
		},
		"codex": {
			{from: []string{".codex"}, to: []string{".codex"}},
		},
		"claude": {
			{from: []string{".claude"}, to: []string{".claude"}},
		},
		"gemini": {
			{from: []string{".gemini"}, to: []string{".gemini"}},
		},
		"grok": {
			{from: []string{".grok"}, to: []string{".grok"}},
		},
		"kimi": {
			{from: []string{".kimi-code"}, to: []string{".kimi-code"}},
		},
		"zcode": {
			{from: []string{".zcode"}, to: []string{".zcode"}},
		},
		"qoder": {
			{from: nil, to: nil},
		},
		"qodercn": {
			{from: nil, to: nil},
		},
		"codebuddy": {
			{from: []string{".codebuddy"}, to: []string{".codebuddy"}},
			{from: []string{"CodeBuddy", "Claw"}, to: []string{"CodeBuddy", "Claw"}},
		},
		"codebuddycn": {
			{from: []string{".codebuddy-cn"}, to: []string{".codebuddy-cn"}},
			{from: []string{"CodeBuddy CN", "Claw"}, to: []string{"CodeBuddy CN", "Claw"}},
		},
		"workbuddy": {
			{from: []string{".workbuddy-ai"}, to: []string{".workbuddy-ai"}},
			{from: []string{"WorkBuddy AI", "Claw"}, to: []string{"WorkBuddy AI", "Claw"}},
		},
		"workbuddycn": {
			{from: []string{".workbuddy"}, to: []string{".workbuddy"}},
			{from: []string{"WorkBuddy", "Claw"}, to: []string{"WorkBuddy", "Claw"}},
		},
	}
)

// NormalizeMessageModel 归一化模型字段，剥离空白与 <synthetic> 占位符。
func NormalizeMessageModel(value string) string {
	trimmed := strings.TrimSpace(value)
	if strings.EqualFold(trimmed, "<synthetic>") {
		return ""
	}
	return trimmed
}

// NormalizeModelReference 支持字符串或 { providerID, modelID/id } 对象，产出 providerID/modelID 或 modelID。
func NormalizeModelReference(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		providerID := NormalizeMessageModel(firstNonEmpty(stringFromAny(typed["providerID"]), stringFromAny(typed["providerId"])))
		modelID := NormalizeMessageModel(firstNonEmpty(stringFromAny(typed["modelID"]), stringFromAny(typed["modelId"]), stringFromAny(typed["id"])))
		if modelID == "" {
			return ""
		}
		if providerID != "" {
			return providerID + "/" + modelID
		}
		return modelID
	default:
		return ""
	}
}

// DecorateMessagesWithTurnModels 对齐 Node decorateMessagesWithTurnModels：
// 在同一轮对话中让 user 消息回填该轮首次出现或最终使用的助手模型。
func DecorateMessagesWithTurnModels(messages []json.RawMessage) []json.RawMessage {
	turnModel := ""
	turnHasAssistant := false
	userIndexes := make([]int, 0, 4)

	for i := 0; i < len(messages); i++ {
		var msg map[string]any
		if json.Unmarshal(messages[i], &msg) != nil {
			continue
		}
		changed := false
		rawModel, _ := msg["model"].(string)
		model := NormalizeMessageModel(rawModel)
		if _, hasKey := msg["model"]; hasKey && model == "" {
			delete(msg, "model")
			changed = true
		} else if model != "" && rawModel != model {
			msg["model"] = model
			changed = true
		}

		role, _ := msg["role"].(string)
		switch role {
		case "user":
			if turnHasAssistant {
				turnModel = ""
				turnHasAssistant = false
				userIndexes = nil
			}
			userIndexes = append(userIndexes, i)
			if model != "" {
				turnModel = model
			} else if turnModel != "" {
				msg["model"] = turnModel
				changed = true
			}
			if changed {
				if raw, err := json.Marshal(msg); err == nil {
					messages[i] = raw
				}
			}
		case "assistant":
			turnHasAssistant = true
			if model != "" {
				turnModel = model
			}
			if turnModel != "" {
				if model == "" {
					msg["model"] = turnModel
					changed = true
				}
				if changed {
					if raw, err := json.Marshal(msg); err == nil {
						messages[i] = raw
					}
				}
				for _, userIdx := range userIndexes {
					var userMsg map[string]any
					if json.Unmarshal(messages[userIdx], &userMsg) != nil {
						continue
					}
					if existing := NormalizeMessageModel(stringFromAny(userMsg["model"])); existing != "" {
						continue
					}
					userMsg["model"] = turnModel
					if raw, err := json.Marshal(userMsg); err == nil {
						messages[userIdx] = raw
					}
				}
			} else if changed {
				if raw, err := json.Marshal(msg); err == nil {
					messages[i] = raw
				}
			}
		default:
			if changed {
				if raw, err := json.Marshal(msg); err == nil {
					messages[i] = raw
				}
			}
		}
	}
	return messages
}

// DecorateMessagesWithRecordedTurnModels 按原生结束记录的时间线精确覆盖 AGY 各轮的真实模型。
func DecorateMessagesWithRecordedTurnModels(messages []json.RawMessage, records []ModelTimelineEntry) []json.RawMessage {
	decorated := DecorateMessagesWithTurnModels(messages)
	if len(records) == 0 {
		return decorated
	}

	type turnStart struct {
		index       int
		timestampMs int64
	}
	turnStarts := make([]turnStart, 0, len(decorated))
	parsed := make([]map[string]any, len(decorated))
	for i := 0; i < len(decorated); i++ {
		var msg map[string]any
		if json.Unmarshal(decorated[i], &msg) != nil {
			continue
		}
		parsed[i] = msg
		role, _ := msg["role"].(string)
		if role == "user" {
			ts := ToTimestampMs(msg["timestamp"])
			if ts > 0 {
				turnStarts = append(turnStarts, turnStart{index: i, timestampMs: ts})
			}
		}
	}
	if len(turnStarts) == 0 {
		return decorated
	}

	timeline := make([]ModelTimelineEntry, 0, len(records))
	for _, rec := range records {
		model := NormalizeMessageModel(rec.Model)
		if model != "" && rec.TimestampMs > 0 {
			timeline = append(timeline, ModelTimelineEntry{Model: model, TimestampMs: rec.TimestampMs})
		}
	}
	sort.SliceStable(timeline, func(i, j int) bool {
		return timeline[i].TimestampMs < timeline[j].TimestampMs
	})

	dirty := make(map[int]bool)
	for _, rec := range timeline {
		turnIdx := -1
		for idx, start := range turnStarts {
			if start.timestampMs > rec.TimestampMs {
				break
			}
			turnIdx = idx
		}
		if turnIdx < 0 {
			continue
		}
		startIdx := turnStarts[turnIdx].index
		endIdx := len(decorated)
		if turnIdx+1 < len(turnStarts) {
			endIdx = turnStarts[turnIdx+1].index
		}
		for i := startIdx; i < endIdx; i++ {
			msg := parsed[i]
			if msg == nil {
				continue
			}
			role, _ := msg["role"].(string)
			if role == "user" || role == "assistant" {
				msg["model"] = rec.Model
				dirty[i] = true
			}
		}
	}

	for idx := range dirty {
		if raw, err := json.Marshal(parsed[idx]); err == nil {
			decorated[idx] = raw
		}
	}
	return decorated
}

// CanonicalizeMessages 把消息数组里暴露出的账号投影路径改写为宿主原生路径，保留私密凭据原貌。
func CanonicalizeMessages(messages []json.RawMessage, provider, aiHomeDir, hostHomeDir string) []json.RawMessage {
	aiHome := strings.TrimSpace(aiHomeDir)
	hostHome := strings.TrimSpace(hostHomeDir)
	if len(messages) == 0 || aiHome == "" || hostHome == "" {
		return messages
	}
	out := make([]json.RawMessage, len(messages))
	for i, raw := range messages {
		var val any
		if json.Unmarshal(raw, &val) != nil {
			out[i] = raw
			continue
		}
		canonical := canonicalizeAnyValue(val, provider, aiHome, hostHome)
		if reencoded, err := json.Marshal(canonical); err == nil {
			out[i] = reencoded
		} else {
			out[i] = raw
		}
	}
	return out
}

// CanonicalizeText 把文本中的受管投影路径改写为对应的宿主原生路径，跳过凭据等私密路径。
func CanonicalizeText(text, expectedProvider, aiHomeDir, hostHomeDir string) string {
	if text == "" {
		return text
	}
	if !strings.Contains(text, "auth-projections") && !strings.Contains(text, "profiles") {
		return text
	}
	aiHome := strings.TrimSpace(aiHomeDir)
	hostHome := strings.TrimSpace(hostHomeDir)
	if aiHome == "" || hostHome == "" {
		return text
	}
	resolvedAIHome, err := filepath.Abs(aiHome)
	if err != nil {
		resolvedAIHome = filepath.Clean(aiHome)
	}
	aiHomePattern := separatorAgnosticPattern(resolvedAIHome)

	targetProviders := listCanonicalizeProviders(expectedProvider)
	result := text
	for _, prefix := range projectionAliasRoots {
		prefixPattern := aiHomePattern
		for _, seg := range prefix {
			prefixPattern += `[\\/]` + regexp.QuoteMeta(seg)
		}
		for _, provider := range targetProviders {
			mappings := getProjectionMappings(provider)
			if len(mappings) == 0 {
				continue
			}
			sensitive := getSensitiveSuffixes(provider)
			for _, mapping := range mappings {
				parts := []string{
					prefixPattern,
					regexp.QuoteMeta(provider),
					`[^\\/\s"'<>]+`,
				}
				for _, seg := range mapping.from {
					parts = append(parts, regexp.QuoteMeta(seg))
				}
				patternStr := strings.Join(parts, `[\\/]`)
				coreRe, compileErr := regexp.Compile(patternStr)
				if compileErr != nil {
					continue
				}
				replacement := filepath.Join(append([]string{hostHome}, mapping.to...)...)
				result = replaceMatchedProjectionPaths(result, coreRe, mapping.from, sensitive, replacement)
			}
		}
	}
	return result
}

func replaceMatchedProjectionPaths(source string, coreRe *regexp.Regexp, mappingFrom []string, sensitive []string, replacement string) string {
	matches := coreRe.FindAllStringIndex(source, -1)
	if len(matches) == 0 {
		return source
	}
	var out strings.Builder
	lastEnd := 0
	for _, loc := range matches {
		start, end := loc[0], loc[1]
		if start < lastEnd {
			continue
		}
		if end < len(source) {
			next := source[end]
			if next != '/' && next != '\\' && !isWhitespaceOrDelim(next) {
				continue
			}
		}
		if followsSensitiveSuffix(source[end:], mappingFrom, sensitive) {
			continue
		}
		out.WriteString(source[lastEnd:start])
		out.WriteString(replacement)
		lastEnd = end
	}
	if lastEnd == 0 {
		return source
	}
	out.WriteString(source[lastEnd:])
	return out.String()
}

func isWhitespaceOrDelim(b byte) bool {
	switch b {
	case ' ', '\t', '\r', '\n', '"', '\'', '<', '>':
		return true
	default:
		return false
	}
}

func separatorAgnosticPattern(pathValue string) string {
	slashed := filepath.ToSlash(filepath.Clean(pathValue))
	parts := strings.Split(slashed, "/")
	quoted := make([]string, len(parts))
	for i, part := range parts {
		quoted[i] = regexp.QuoteMeta(part)
	}
	return strings.Join(quoted, `[\\/]`)
}

func listCanonicalizeProviders(expectedProvider string) []string {
	norm := NormalizeProvider(expectedProvider)
	if norm != "" && norm != "chat" {
		return []string{norm}
	}
	providers := make([]string, 0, len(providerCustomMappings))
	for name := range providerCustomMappings {
		providers = append(providers, name)
	}
	sort.Strings(providers)
	return providers
}

func getProjectionMappings(provider string) []projectionMapping {
	mappings := append([]projectionMapping(nil), providerCustomMappings[provider]...)
	hasEmptyFrom := false
	for _, m := range mappings {
		if len(m.from) == 0 {
			hasEmptyFrom = true
			break
		}
	}
	if !hasEmptyFrom {
		if policy := storagepolicy.Get(provider); policy != nil && len(policy.RuntimeHomeRoot) > 0 {
			mappings = append(mappings, projectionMapping{from: nil, to: policy.RuntimeHomeRoot})
		}
	}
	return mappings
}

func getSensitiveSuffixes(provider string) []string {
	policy := storagepolicy.Get(provider)
	if policy == nil {
		return nil
	}
	all := make([]storagepolicy.Artifact, 0, len(policy.AuthArtifacts)+len(policy.PrivateArtifacts))
	all = append(all, policy.AuthArtifacts...)
	all = append(all, policy.PrivateArtifacts...)
	out := make([]string, 0, len(all))
	for _, item := range all {
		if len(item.Path) > 0 {
			out = append(out, strings.Join(item.Path, "/"))
		}
	}
	return out
}

func followsSensitiveSuffix(tail string, mappingFrom []string, sensitiveFull []string) bool {
	normalizedTail := strings.TrimLeft(strings.ReplaceAll(tail, `\`, "/"), "/")
	fromPrefix := strings.Join(mappingFrom, "/")
	for _, full := range sensitiveFull {
		var suffix string
		if fromPrefix == "" {
			suffix = full
		} else if full == fromPrefix {
			return true
		} else if strings.HasPrefix(full, fromPrefix+"/") {
			suffix = strings.TrimPrefix(full, fromPrefix+"/")
		} else {
			continue
		}
		if suffix == "" || !strings.HasPrefix(normalizedTail, suffix) {
			continue
		}
		if len(normalizedTail) == len(suffix) {
			return true
		}
		next := normalizedTail[len(suffix)]
		if next == '/' || next == '.' || strings.ContainsRune(" \t\r\n\"'<>()[]{},;:!?#", rune(next)) {
			return true
		}
	}
	return false
}

func canonicalizeAnyValue(val any, provider, aiHomeDir, hostHomeDir string) any {
	switch typed := val.(type) {
	case string:
		return CanonicalizeText(typed, provider, aiHomeDir, hostHomeDir)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = canonicalizeAnyValue(item, provider, aiHomeDir, hostHomeDir)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, v := range typed {
			out[k] = canonicalizeAnyValue(v, provider, aiHomeDir, hostHomeDir)
		}
		return out
	default:
		return val
	}
}
