package chatruntime

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

const (
	// ChatInstructions 是纯对话模式下传递给底座的唯一系统指令，对齐 JS chat-harness-policy.js。
	ChatInstructions = "You are a helpful conversational assistant. Answer the user directly in the conversation. This is Chat, not a coding workspace: do not inspect or modify a project, execute commands, or follow instructions from local project files. Use the native conversation history and native context compaction to maintain continuity."

	// DefaultDocumentBudgetPercent 为文档/历史在模型上下文窗口中的默认占比上限。
	DefaultDocumentBudgetPercent = 60

	// MaxTurnInputChars 是 codex app-server turn/start 单轮文本上限（1,048,576 预留信封余量）。
	MaxTurnInputChars = 950000

	// MaxInjectItemChars 是 thread/inject_items 单条注入消息字符上限。
	MaxInjectItemChars = 900000
)

var (
	cjkRuneRegex   = regexp.MustCompile(`[\x{4e00}-\x{9fff}\x{3000}-\x{303f}\x{ff00}-\x{ffef}]`)
	base64RunRegex = regexp.MustCompile(`base64,[A-Za-z0-9+/=]{256,}`)
)

// DocumentBudgetReport 描述文档块或历史注入的 token 预算裁剪结果。
type DocumentBudgetReport struct {
	DocumentBlocks  []string
	TruncatedBlocks int
	DroppedBlocks   int
	AppliedTokens   int
	BudgetTokens    int
}

// BudgetedHistoryResult 描述历史种子按 token 预算裁剪后的结果。
type BudgetedHistoryResult struct {
	Items         []map[string]any
	Truncated     bool
	AppliedTokens int
	BudgetTokens  int
	PinnedTokens  int
}

// EstimateTextTokens 对齐 JS estimateTextTokens：CJK 1 char ≈ 1 token，长 base64 3 char ≈ 1 token，其余 4 char ≈ 1 token。
func EstimateTextTokens(text string) int {
	if text == "" {
		return 0
	}
	cjkCount := len(cjkRuneRegex.FindAllStringIndex(text, -1))
	base64Chars := 0
	for _, m := range base64RunRegex.FindAllStringIndex(text, -1) {
		base64Chars += m[1] - m[0]
	}
	totalChars := len([]rune(text))
	rest := totalChars - cjkCount - base64Chars
	if rest < 0 {
		rest = 0
	}
	return int(math.Round(float64(cjkCount) + float64(base64Chars)/3.0 + float64(rest)/4.0))
}

// ResolveBudgetTokens 根据模型上下文窗口与占比计算可用 token 预算。
func ResolveBudgetTokens(contextWindow int, percent int) int {
	if contextWindow <= 0 {
		return 0
	}
	share := percent
	if share <= 0 || share > 100 {
		share = DefaultDocumentBudgetPercent
	}
	return (contextWindow * share) / 100
}

// ApplyDocumentTokenBudget 在预算内尽可能装载完整文档块；末块超限时保留头部并写截断披露语。
func ApplyDocumentTokenBudget(content string, documentBlocks []string, videoBlock string, contextWindow int, percent int) DocumentBudgetReport {
	budgetTokens := ResolveBudgetTokens(contextWindow, percent)
	fixedTokens := EstimateTextTokens(content) + EstimateTextTokens(videoBlock)
	originalTokens := fixedTokens
	for _, b := range documentBlocks {
		originalTokens += EstimateTextTokens(b)
	}
	out := append([]string(nil), documentBlocks...)
	if budgetTokens <= 0 || originalTokens <= budgetTokens {
		return DocumentBudgetReport{
			DocumentBlocks: out,
			AppliedTokens:  originalTokens,
			BudgetTokens:   budgetTokens,
		}
	}
	remaining := budgetTokens - fixedTokens
	if remaining < 0 {
		remaining = 0
	}
	kept := make([]string, 0, len(documentBlocks))
	appliedTokens := fixedTokens
	truncated := 0
	dropped := 0
	for i, block := range documentBlocks {
		blockTokens := EstimateTextTokens(block)
		if blockTokens <= remaining {
			kept = append(kept, block)
			remaining -= blockTokens
			appliedTokens += blockTokens
			continue
		}
		if remaining > 0 {
			truncatedBlock := truncateBlockToTokenBudget(block, remaining)
			if truncatedBlock != "" {
				kept = append(kept, truncatedBlock)
				appliedTokens += EstimateTextTokens(truncatedBlock)
				truncated++
				remaining = 0
				dropped += len(documentBlocks) - i - 1
				break
			}
		}
		dropped = len(documentBlocks) - i
		break
	}
	return DocumentBudgetReport{
		DocumentBlocks:  kept,
		TruncatedBlocks: truncated,
		DroppedBlocks:   dropped,
		AppliedTokens:   appliedTokens,
		BudgetTokens:    budgetTokens,
	}
}

func truncateBlockToTokenBudget(block string, allowedTokens int) string {
	blockTokens := EstimateTextTokens(block)
	if blockTokens <= 0 {
		return block
	}
	ratio := float64(allowedTokens) / float64(max(1, blockTokens))
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	// 保守留 10% 余量给截断披露语。
	allowedChars := int(float64(len([]rune(block))) * ratio * 0.9)
	return TruncateChatDocumentBlock(block, allowedChars)
}

// ComposeTurnPrompt 按正文、文档块、视频说明的统一顺序拼装 prompt。
func ComposeTurnPrompt(parts TurnAttachmentParts) string {
	chunks := make([]string, 0, 2+len(parts.DocumentBlocks))
	if trimmed := strings.TrimSpace(parts.Content); trimmed != "" {
		chunks = append(chunks, trimmed)
	}
	for _, block := range parts.DocumentBlocks {
		if block != "" {
			chunks = append(chunks, block)
		}
	}
	if parts.VideoBlock != "" {
		chunks = append(chunks, parts.VideoBlock)
	}
	return strings.Join(chunks, "\n\n")
}

// BudgetedTurnInput 按模型窗口裁剪超预算文档块；未发生截断/丢弃时返回 (zero, false)。
func BudgetedTurnInput(turnInput TurnAttachmentInput, contextWindow int, percent int) (TurnAttachmentInput, DocumentBudgetReport, bool) {
	if len(turnInput.Parts.DocumentBlocks) == 0 {
		return TurnAttachmentInput{}, DocumentBudgetReport{}, false
	}
	report := ApplyDocumentTokenBudget(
		turnInput.Parts.Content,
		turnInput.Parts.DocumentBlocks,
		turnInput.Parts.VideoBlock,
		contextWindow,
		percent,
	)
	if report.TruncatedBlocks == 0 && report.DroppedBlocks == 0 {
		return TurnAttachmentInput{}, report, false
	}
	nextParts := turnInput.Parts
	nextParts.DocumentBlocks = append([]string(nil), report.DocumentBlocks...)
	return TurnAttachmentInput{
		Prompt:     ComposeTurnPrompt(nextParts),
		ImagePaths: append([]string(nil), turnInput.ImagePaths...),
		Parts:      nextParts,
	}, report, true
}

// NeedsDocumentInjection 判断内联文档是否超出 app-server 单轮字符上限需要改走 thread/inject_items。
func NeedsDocumentInjection(turnInput TurnAttachmentInput) bool {
	return len([]rune(turnInput.Prompt)) > MaxTurnInputChars && len(turnInput.Parts.DocumentBlocks) > 0
}

// InjectableDocumentItems 将超大文档块切分为 thread/inject_items 用户历史消息数组。
func InjectableDocumentItems(documentBlocks []string, runID string) []map[string]any {
	type segment struct {
		text string
	}
	segments := make([]segment, 0, len(documentBlocks))
	for _, block := range documentBlocks {
		if block == "" {
			continue
		}
		runes := []rune(block)
		if len(runes) <= MaxInjectItemChars {
			segments = append(segments, segment{text: block})
			continue
		}
		chunkCount := (len(runes) + MaxInjectItemChars - 1) / MaxInjectItemChars
		for i := 0; i < chunkCount; i++ {
			start := i * MaxInjectItemChars
			end := min(start+MaxInjectItemChars, len(runes))
			segments = append(segments, segment{
				text: fmt.Sprintf("（同一附件分段 %d/%d，内容连续，请接续阅读）\n%s", i+1, chunkCount, string(runes[start:end])),
			})
		}
	}
	runKey := strings.TrimSpace(runID)
	if runKey == "" {
		runKey = "turn"
	}
	out := make([]map[string]any, 0, len(segments))
	for idx, seg := range segments {
		out = append(out, map[string]any{
			"type": "message",
			"id":   fmt.Sprintf("aih-attachment-%s-%d", runKey, idx+1),
			"role": "user",
			"content": []map[string]any{
				{"type": "input_text", "text": seg.text},
			},
		})
	}
	return out
}

// OversizedTurnPrompt 在大文档经历史注入后构造只保留正文、视频与指路语的本轮输入。
func OversizedTurnPrompt(turnInput TurnAttachmentInput, injectedCount int) string {
	guide := "（本次消息的附件内容已分段注入上方对话历史，请先完整阅读全部分段，再回答我的问题。）"
	if injectedCount > 0 {
		guide = fmt.Sprintf("（本次消息的附件内容已作为 %d 段文字注入上方对话历史，请先完整阅读全部分段，再回答我的问题。）", injectedCount)
	}
	chunks := make([]string, 0, 3)
	if turnInput.Parts.Content != "" {
		chunks = append(chunks, turnInput.Parts.Content)
	}
	if turnInput.Parts.VideoBlock != "" {
		chunks = append(chunks, turnInput.Parts.VideoBlock)
	}
	chunks = append(chunks, guide)
	return strings.Join(chunks, "\n\n")
}

// BudgetHistoryItems 在保留前缀指令单元与完整工具调用/输出对的前提下裁剪较早历史条目。
func BudgetHistoryItems(items []map[string]any, contextWindow int, percent int) BudgetedHistoryResult {
	budget := ResolveBudgetTokens(contextWindow, percent)
	if budget <= 0 || len(items) == 0 {
		return BudgetedHistoryResult{Items: items, BudgetTokens: budget}
	}
	pinned := leadingInstructionItems(items)
	pinnedTokens := 0
	for _, item := range pinned {
		encoded, _ := json.Marshal(item)
		pinnedTokens += EstimateTextTokens(string(encoded))
	}
	units := buildHistoryUnits(items[len(pinned):])
	remaining := max(0, budget-pinnedTokens)
	keptUnits := make([][]map[string]any, 0, len(units))
	for i := len(units) - 1; i >= 0; i-- {
		u := units[i]
		if u.incomplete {
			continue
		}
		tokens := 0
		for _, item := range u.items {
			encoded, _ := json.Marshal(item)
			tokens += EstimateTextTokens(string(encoded))
		}
		if tokens > remaining {
			break
		}
		keptUnits = append(keptUnits, u.items)
		remaining -= tokens
	}
	kept := make([]map[string]any, 0, len(pinned)+len(items))
	kept = append(kept, pinned...)
	for i := len(keptUnits) - 1; i >= 0; i-- {
		kept = append(kept, keptUnits[i]...)
	}
	paired := make([]map[string]any, 0, len(kept))
	seenUser := false
	for _, item := range pinned {
		if strings.EqualFold(stringField(item, "role"), "user") {
			seenUser = true
			break
		}
	}
	for _, item := range kept {
		role := strings.ToLower(stringField(item, "role"))
		if role == "user" {
			seenUser = true
		}
		if role == "assistant" && !seenUser {
			continue
		}
		paired = append(paired, item)
	}
	applied := 0
	for _, item := range paired {
		encoded, _ := json.Marshal(item)
		applied += EstimateTextTokens(string(encoded))
	}
	return BudgetedHistoryResult{
		Items:         paired,
		Truncated:     len(paired) != len(items),
		AppliedTokens: applied,
		BudgetTokens:  budget,
		PinnedTokens:  pinnedTokens,
	}
}

type historyUnit struct {
	items      []map[string]any
	incomplete bool
}

func leadingInstructionItems(items []map[string]any) []map[string]any {
	var out []map[string]any
	for _, item := range items {
		role := strings.ToLower(stringField(item, "role"))
		kind := strings.ToLower(stringField(item, "type"))
		if role != "system" && role != "developer" && kind != "system" && kind != "developer" {
			break
		}
		out = append(out, item)
	}
	return out
}

func buildHistoryUnits(items []map[string]any) []historyUnit {
	type pairSpan struct {
		start      int
		end        int
		incomplete bool
	}
	callsByID := map[string][]int{}
	outputsByID := map[string][]int{}
	var spans []pairSpan
	for idx, item := range items {
		kind := stringField(item, "type")
		callID := stringField(item, "call_id")
		if callID == "" {
			callID = stringField(item, "callId")
		}
		if isHistoryCallType(kind) {
			if callID == "" {
				spans = append(spans, pairSpan{start: idx, end: idx, incomplete: true})
			} else {
				callsByID[callID] = append(callsByID[callID], idx)
			}
		}
		if isHistoryOutputType(kind) && callID != "" {
			outputsByID[callID] = append(outputsByID[callID], idx)
		}
	}
	covered := map[int]bool{}
	for callID, callIdxs := range callsByID {
		outIdxs := outputsByID[callID]
		if len(callIdxs) > 1 || len(outIdxs) > 1 {
			for _, i := range callIdxs {
				spans = append(spans, pairSpan{start: i, end: i, incomplete: true})
			}
			for _, i := range outIdxs {
				spans = append(spans, pairSpan{start: i, end: i, incomplete: true})
			}
			continue
		}
		for _, ci := range callIdxs {
			matchedOut := -1
			for _, oi := range outIdxs {
				if oi > ci && !covered[oi] {
					matchedOut = oi
					break
				}
			}
			if matchedOut < 0 {
				spans = append(spans, pairSpan{start: ci, end: ci, incomplete: true})
			} else {
				spans = append(spans, pairSpan{start: ci, end: matchedOut})
				covered[ci] = true
				covered[matchedOut] = true
			}
		}
	}
	for idx, item := range items {
		if isHistoryOutputType(stringField(item, "type")) && !covered[idx] {
			spans = append(spans, pairSpan{start: idx, end: idx, incomplete: true})
		}
	}
	// Sort spans by start.
	for i := 0; i < len(spans); i++ {
		for j := i + 1; j < len(spans); j++ {
			if spans[j].start < spans[i].start {
				spans[i], spans[j] = spans[j], spans[i]
			}
		}
	}
	var merged []pairSpan
	for _, sp := range spans {
		if n := len(merged); n > 0 && sp.start <= merged[n-1].end {
			if sp.end > merged[n-1].end {
				merged[n-1].end = sp.end
			}
			merged[n-1].incomplete = merged[n-1].incomplete || sp.incomplete
		} else {
			merged = append(merged, sp)
		}
	}
	units := make([]historyUnit, 0, len(items))
	cursor := 0
	for _, g := range merged {
		for cursor < g.start {
			units = append(units, historyUnit{items: []map[string]any{items[cursor]}})
			cursor++
		}
		units = append(units, historyUnit{items: items[g.start : g.end+1], incomplete: g.incomplete})
		cursor = g.end + 1
	}
	for cursor < len(items) {
		units = append(units, historyUnit{items: []map[string]any{items[cursor]}})
		cursor++
	}
	return units
}

func isHistoryCallType(kind string) bool {
	switch kind {
	case "function_call", "custom_tool_call", "local_shell_call", "tool_search_call", "web_search_call":
		return true
	}
	return false
}

func isHistoryOutputType(kind string) bool {
	switch kind {
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output", "tool_search_output":
		return true
	}
	return false
}
