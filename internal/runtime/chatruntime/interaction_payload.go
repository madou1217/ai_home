package chatruntime

import (
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

const (
	RedactedSecretAnswer  = "[secret]"
	hiddenAnswerDisplay   = "[已隐藏]"
	secretAnswerSubmitted = "已提交敏感回答"
)

var (
	approvalKeys             = map[string]struct{}{"presentation": {}, "choices": {}}
	questionKeys             = map[string]struct{}{"presentation": {}, "fields": {}, "actions": {}, "answerShape": {}, "confirmUnanswered": {}, "autoResolution": {}}
	approvalPresentationKeys = map[string]struct{}{"title": {}, "description": {}, "detail": {}, "annotations": {}}
	questionPresentationKeys = map[string]struct{}{"title": {}, "message": {}, "link": {}}
	choiceKeys               = map[string]struct{}{"id": {}, "label": {}, "description": {}, "intent": {}}
	fieldKeys                = map[string]struct{}{"id": {}, "label": {}, "header": {}, "description": {}, "type": {}, "required": {}, "allowOther": {}, "secret": {}, "options": {}}
	optionKeys               = map[string]struct{}{"value": {}, "label": {}, "description": {}}
	linkKeys                 = map[string]struct{}{"label": {}, "url": {}}
	annotationKeys           = map[string]struct{}{"label": {}, "value": {}}
	autoResolutionKeys       = map[string]struct{}{"mode": {}, "inactivityMs": {}, "countdownMs": {}, "onExpire": {}, "snooze": {}}
	choiceIntents            = map[string]struct{}{"accept": {}, "deny": {}, "cancel": {}, "neutral": {}}
	fieldTypes               = map[string]struct{}{"text": {}, "number": {}, "integer": {}, "boolean": {}, "single_select": {}, "multi_select": {}}
	answerShapes             = map[string]struct{}{"answers": {}, "object": {}, "none": {}}
	autoModes                = map[string]struct{}{"inactivity_countdown": {}, "countdown": {}}
	autoExpireActions        = map[string]struct{}{"submit_empty": {}, "decline": {}}
	autoSnoozeActions        = map[string]struct{}{"disable": {}, "restart": {}}
)

// NormalizeCanonicalInteractionPayload 严格校验交互负载结构与枚举字段。
func NormalizeCanonicalInteractionPayload(kind string, input map[string]any) (map[string]any, error) {
	switch kind {
	case "approval":
		return normalizeApprovalPayload(input)
	case "question", "plan_confirmation":
		return normalizeQuestionPayload(input)
	default:
		return nil, invalidInteractionPayload("kind", map[string]any{"kind": kind})
	}
}

func normalizeApprovalPayload(input map[string]any) (map[string]any, error) {
	payload, err := strictInteractionRecord(input, approvalKeys, "approval")
	if err != nil {
		return nil, err
	}
	choices, err := normalizeUniqueMapList(payload["choices"], normalizeChoice, "approval.choices", "id")
	if err != nil {
		return nil, err
	}
	if len(choices) == 0 {
		return nil, invalidInteractionPayload("approval.choices", nil)
	}
	pres, err := normalizePresentation(payload["presentation"], approvalPresentationKeys, "approval.presentation")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"presentation": pres,
		"choices":      toAnyMapSlice(choices),
	}, nil
}

func normalizeQuestionPayload(input map[string]any) (map[string]any, error) {
	payload, err := strictInteractionRecord(input, questionKeys, "question")
	if err != nil {
		return nil, err
	}
	fields, err := normalizeUniqueMapList(payload["fields"], normalizeQuestionField, "question.fields", "id")
	if err != nil {
		return nil, err
	}
	shape, err := enumStringValue(payload["answerShape"], answerShapes, "question.answerShape")
	if err != nil {
		return nil, err
	}
	if shape == "none" && len(fields) > 0 {
		return nil, invalidInteractionPayload("question.fields", nil)
	}
	if shape != "none" && len(fields) == 0 {
		return nil, invalidInteractionPayload("question.fields", nil)
	}
	pres, err := normalizePresentation(payload["presentation"], questionPresentationKeys, "question.presentation")
	if err != nil {
		return nil, err
	}
	actions, err := normalizeUniqueEnumSlice(payload["actions"], ValidQuestionActions, "question.actions")
	if err != nil {
		return nil, err
	}
	confirm, ok := payload["confirmUnanswered"].(bool)
	if !ok {
		return nil, invalidInteractionPayload("question.confirmUnanswered", nil)
	}
	res := map[string]any{
		"presentation":      pres,
		"fields":            toAnyMapSlice(fields),
		"actions":           toAnyStringSlice(actions),
		"answerShape":       shape,
		"confirmUnanswered": confirm,
	}
	if arRaw, present := payload["autoResolution"]; present && arRaw != nil {
		ar, err := normalizeAutoResolution(arRaw)
		if err != nil {
			return nil, err
		}
		res["autoResolution"] = ar
	}
	return res, nil
}

func normalizePresentation(raw any, allowedKeys map[string]struct{}, path string) (map[string]any, error) {
	src, err := strictInteractionRecord(raw, allowedKeys, path)
	if err != nil {
		return nil, err
	}
	title, err := nonEmptyStrictText(src["title"], path+".title")
	if err != nil {
		return nil, err
	}
	out := map[string]any{"title": title}
	for _, k := range []string{"description", "detail", "message"} {
		if err := copyOptionalStrictText(out, src, k, path); err != nil {
			return nil, err
		}
	}
	if annRaw, present := src["annotations"]; present && annRaw != nil {
		list, err := asSlice(annRaw, path+".annotations")
		if err != nil {
			return nil, err
		}
		anns := make([]any, 0, len(list))
		for i, elem := range list {
			aPath := fmt.Sprintf("%s.annotations[%d]", path, i)
			aRec, err := strictInteractionRecord(elem, annotationKeys, aPath)
			if err != nil {
				return nil, err
			}
			lbl, err := nonEmptyStrictText(aRec["label"], aPath+".label")
			if err != nil {
				return nil, err
			}
			val, err := nonEmptyStrictText(aRec["value"], aPath+".value")
			if err != nil {
				return nil, err
			}
			anns = append(anns, map[string]any{"label": lbl, "value": val})
		}
		out["annotations"] = anns
	}
	if linkRaw, present := src["link"]; present && linkRaw != nil {
		lRec, err := strictInteractionRecord(linkRaw, linkKeys, path+".link")
		if err != nil {
			return nil, err
		}
		lbl, err := nonEmptyStrictText(lRec["label"], path+".link.label")
		if err != nil {
			return nil, err
		}
		rawURL, err := nonEmptyStrictText(lRec["url"], path+".link.url")
		if err != nil {
			return nil, err
		}
		u, err := url.Parse(rawURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, invalidInteractionPayload(path+".link.url", nil)
		}
		out["link"] = map[string]any{"label": lbl, "url": u.String()}
	}
	return out, nil
}

func normalizeChoice(raw any, index int) (map[string]any, error) {
	path := fmt.Sprintf("approval.choices[%d]", index)
	choice, err := strictInteractionRecord(raw, choiceKeys, path)
	if err != nil {
		return nil, err
	}
	id, err := nonEmptyStrictText(choice["id"], path+".id")
	if err != nil {
		return nil, err
	}
	label, err := nonEmptyStrictText(choice["label"], path+".label")
	if err != nil {
		return nil, err
	}
	intent, err := enumStringValue(choice["intent"], choiceIntents, path+".intent")
	if err != nil {
		return nil, err
	}
	out := map[string]any{"id": id, "label": label, "intent": intent}
	if err := copyOptionalStrictText(out, choice, "description", path); err != nil {
		return nil, err
	}
	return out, nil
}

func normalizeQuestionField(raw any, index int) (map[string]any, error) {
	path := fmt.Sprintf("question.fields[%d]", index)
	field, err := strictInteractionRecord(raw, fieldKeys, path)
	if err != nil {
		return nil, err
	}
	id, err := nonEmptyStrictText(field["id"], path+".id")
	if err != nil {
		return nil, err
	}
	label, err := nonEmptyStrictText(field["label"], path+".label")
	if err != nil {
		return nil, err
	}
	ftype, err := enumStringValue(field["type"], fieldTypes, path+".type")
	if err != nil {
		return nil, err
	}
	req, ok := field["required"].(bool)
	if !ok {
		return nil, invalidInteractionPayload(path+".required", nil)
	}
	allowOther, ok := field["allowOther"].(bool)
	if !ok {
		return nil, invalidInteractionPayload(path+".allowOther", nil)
	}
	secret, ok := field["secret"].(bool)
	if !ok {
		return nil, invalidInteractionPayload(path+".secret", nil)
	}
	out := map[string]any{
		"id":         id,
		"label":      label,
		"type":       ftype,
		"required":   req,
		"allowOther": allowOther,
		"secret":     secret,
	}
	for _, k := range []string{"header", "description"} {
		if err := copyOptionalStrictText(out, field, k, path); err != nil {
			return nil, err
		}
	}
	isSelect := ftype == "single_select" || ftype == "multi_select"
	if isSelect {
		opts, err := normalizeUniqueMapList(field["options"], func(v any, idx int) (map[string]any, error) {
			oPath := fmt.Sprintf("%s.options[%d]", path, idx)
			oRec, err := strictInteractionRecord(v, optionKeys, oPath)
			if err != nil {
				return nil, err
			}
			val, err := nonEmptyStrictText(oRec["value"], oPath+".value")
			if err != nil {
				return nil, err
			}
			lbl, err := nonEmptyStrictText(oRec["label"], oPath+".label")
			if err != nil {
				return nil, err
			}
			optOut := map[string]any{"value": val, "label": lbl}
			if err := copyOptionalStrictText(optOut, oRec, "description", oPath); err != nil {
				return nil, err
			}
			return optOut, nil
		}, path+".options", "value")
		if err != nil {
			return nil, err
		}
		if len(opts) == 0 {
			return nil, invalidInteractionPayload(path+".options", nil)
		}
		out["options"] = toAnyMapSlice(opts)
	} else if _, hasOpts := field["options"]; hasOpts && field["options"] != nil {
		return nil, invalidInteractionPayload(path+".options", nil)
	}
	if ftype != "single_select" && allowOther {
		return nil, invalidInteractionPayload(path+".allowOther", nil)
	}
	return out, nil
}

func normalizeAutoResolution(raw any) (map[string]any, error) {
	path := "question.autoResolution"
	src, err := strictInteractionRecord(raw, autoResolutionKeys, path)
	if err != nil {
		return nil, err
	}
	mode, err := enumStringValue(src["mode"], autoModes, path+".mode")
	if err != nil {
		return nil, err
	}
	countdownMs, ok := asPositiveSafeInt64(src["countdownMs"])
	if !ok {
		return nil, invalidInteractionPayload(path+".countdownMs", nil)
	}
	onExpire, err := enumStringValue(src["onExpire"], autoExpireActions, path+".onExpire")
	if err != nil {
		return nil, err
	}
	snooze, err := enumStringValue(src["snooze"], autoSnoozeActions, path+".snooze")
	if err != nil {
		return nil, err
	}
	out := map[string]any{
		"mode":        mode,
		"countdownMs": countdownMs,
		"onExpire":    onExpire,
		"snooze":      snooze,
	}
	if mode == "inactivity_countdown" {
		inact, ok := asSafeInt64(src["inactivityMs"])
		if !ok || inact < 0 {
			return nil, invalidInteractionPayload(path+".inactivityMs", nil)
		}
		out["inactivityMs"] = inact
	} else if src["inactivityMs"] != nil {
		return nil, invalidInteractionPayload(path+".inactivityMs", nil)
	}
	return out, nil
}

func normalizeUniqueMapList(raw any, fn func(any, int) (map[string]any, error), path, idKey string) ([]map[string]any, error) {
	items, err := asSlice(raw, path)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for i, item := range items {
		norm, err := fn(item, i)
		if err != nil {
			return nil, err
		}
		id, _ := norm[idKey].(string)
		if _, dup := seen[id]; dup {
			return nil, invalidInteractionPayload(path, nil)
		}
		seen[id] = struct{}{}
		out = append(out, norm)
	}
	return out, nil
}

func normalizeUniqueEnumSlice(raw any, allowed map[string]struct{}, path string) ([]string, error) {
	items, err := asSlice(raw, path)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for i, item := range items {
		val, err := enumStringValue(item, allowed, fmt.Sprintf("%s[%d]", path, i))
		if err != nil {
			return nil, err
		}
		if _, dup := seen[val]; dup {
			return nil, invalidInteractionPayload(path, nil)
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	if len(out) == 0 {
		return nil, invalidInteractionPayload(path, nil)
	}
	return out, nil
}

func strictInteractionRecord(raw any, allowed map[string]struct{}, path string) (map[string]any, error) {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return nil, invalidInteractionPayload(path, nil)
	}
	var unknown []string
	for k := range m {
		if _, ok := allowed[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, invalidInteractionPayload(path, map[string]any{"unknown": unknown})
	}
	return m, nil
}

func asSlice(raw any, path string) ([]any, error) {
	switch s := raw.(type) {
	case []any:
		return s, nil
	case []map[string]any:
		out := make([]any, len(s))
		for i, v := range s {
			out[i] = v
		}
		return out, nil
	default:
		return nil, invalidInteractionPayload(path, nil)
	}
}

func copyOptionalStrictText(target, source map[string]any, key, path string) error {
	v, exists := source[key]
	if !exists || v == nil {
		return nil
	}
	s, err := nonEmptyStrictText(v, path+"."+key)
	if err != nil {
		return err
	}
	target[key] = s
	return nil
}

func nonEmptyStrictText(raw any, path string) (string, error) {
	s, ok := raw.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return "", invalidInteractionPayload(path, nil)
	}
	return strings.TrimSpace(s), nil
}

func enumStringValue(raw any, allowed map[string]struct{}, path string) (string, error) {
	s, ok := raw.(string)
	if !ok {
		return "", invalidInteractionPayload(path, map[string]any{"value": raw})
	}
	if _, valid := allowed[s]; !valid {
		return "", invalidInteractionPayload(path, map[string]any{"value": raw})
	}
	return s, nil
}

func invalidInteractionPayload(path string, extra map[string]any) error {
	details := map[string]any{"path": path}
	for k, v := range extra {
		details[k] = v
	}
	return NewError("invalid_canonical_interaction_payload", http.StatusUnprocessableEntity, details)
}

func toAnyMapSlice(in []map[string]any) []any {
	out := make([]any, len(in))
	for i, m := range in {
		out[i] = m
	}
	return out
}

// --- 敏感字段裁剪与问答时间线投影 ---

// ProjectInteractionCommandForPersistence 持久化前把 secret 字段答复打码为 [secret]。
func ProjectInteractionCommandForPersistence(cmd *Command, interaction *Interaction) *Command {
	if cmd == nil || cmd.Type != "interaction.answer" || asString(cmd.Payload["action"]) != "submit" {
		return cmd
	}
	projectedAnswer := projectSecretAnswer(interaction, cmd.Payload["answer"])
	if CanonicalJSONEquals(projectedAnswer, cmd.Payload["answer"]) {
		return cmd
	}
	nextPayload := CloneMap(cmd.Payload)
	nextPayload["answer"] = projectedAnswer
	cp := *cmd
	cp.Payload = nextPayload
	return &cp
}

// ProjectInteractionResolutionForPersistence 持久化 interaction.resolution 前对敏感字段脱敏。
func ProjectInteractionResolutionForPersistence(interaction *Interaction, resolution map[string]any) map[string]any {
	if resolution == nil || asString(resolution["action"]) != "submit" {
		return CloneMap(resolution)
	}
	out := CloneMap(resolution)
	out["answer"] = projectSecretAnswer(interaction, out["answer"])
	return out
}

func projectSecretAnswer(interaction *Interaction, answer any) any {
	secretIDs := secretQuestionIDs(interaction)
	if len(secretIDs) == 0 {
		return cloneAny(answer)
	}
	src, ok := answer.(map[string]any)
	if !ok || src == nil {
		return RedactedSecretAnswer
	}
	projected := CloneMap(src)
	for id := range secretIDs {
		if val, exists := projected[id]; exists {
			projected[id] = maskAnswerValue(val)
		}
	}
	return projected
}

func secretQuestionIDs(interaction *Interaction) map[string]struct{} {
	ids := make(map[string]struct{})
	if interaction == nil || interaction.Payload == nil {
		return ids
	}
	fields, err := asSlice(interaction.Payload["fields"], "fields")
	if err != nil {
		return ids
	}
	for _, raw := range fields {
		f, ok := raw.(map[string]any)
		if !ok || f == nil {
			continue
		}
		if secret, _ := f["secret"].(bool); secret {
			if id := strings.TrimSpace(asString(f["id"])); id != "" {
				ids[id] = struct{}{}
			}
		}
	}
	return ids
}

func maskAnswerValue(value any) any {
	if value == nil || value == "" {
		return value
	}
	switch v := value.(type) {
	case []any:
		if len(v) == 0 {
			return []any{}
		}
		return []any{RedactedSecretAnswer}
	case []string:
		if len(v) == 0 {
			return []any{}
		}
		return []any{RedactedSecretAnswer}
	case map[string]any:
		if ansRaw, exists := v["answers"]; exists {
			if slice, err := asSlice(ansRaw, "answers"); err == nil {
				out := CloneMap(v)
				if len(slice) == 0 {
					out["answers"] = []any{}
				} else {
					out["answers"] = []any{RedactedSecretAnswer}
				}
				return out
			}
		}
		return RedactedSecretAnswer
	default:
		return RedactedSecretAnswer
	}
}

// CreateInteractionAnswerTimelineEvent 将问答类交互的 submit 答案投影为用户时间线消息。
func CreateInteractionAnswerTimelineEvent(interaction *Interaction) *EventDraft {
	if interaction == nil {
		return nil
	}
	if interaction.Kind != "question" && interaction.Kind != "plan_confirmation" {
		return nil
	}
	if interaction.Resolution == nil || asString(interaction.Resolution["action"]) != "submit" {
		return nil
	}
	content := FormatInteractionAnswer(interaction)
	if content == "" {
		return nil
	}
	itemID := fmt.Sprintf("interaction-answer:%s:%d", interaction.InteractionID, interaction.Revision)
	at := interaction.UpdatedAt
	item := map[string]any{
		"id":        itemID,
		"kind":      "message",
		"createdAt": at,
		"updatedAt": at,
		"status":    "completed",
		"content":   content,
		"detail": map[string]any{
			"role":  "user",
			"phase": "interaction_answer",
		},
	}
	return &EventDraft{
		Type:   "timeline.item.completed",
		ItemID: itemID,
		Source: EventSource{Provider: "aih", RuntimeID: "chat-runtime"},
		Payload: map[string]any{
			"item": item,
		},
	}
}

// FormatInteractionAnswer 格式化已回答的交互表单展示文本。
func FormatInteractionAnswer(interaction *Interaction) string {
	if interaction == nil || interaction.Resolution == nil {
		return ""
	}
	fields, _ := asSlice(interaction.Payload["fields"], "fields")
	answerMap, _ := interaction.Resolution["answer"].(map[string]any)
	if answerMap == nil {
		for _, raw := range fields {
			if f, ok := raw.(map[string]any); ok && f != nil {
				if sec, _ := f["secret"].(bool); sec && asString(interaction.Resolution["answer"]) == RedactedSecretAnswer {
					return secretAnswerSubmitted
				}
			}
		}
		return ""
	}
	type entry struct {
		label  string
		secret bool
		value  string
	}
	var entries []entry
	for _, raw := range fields {
		f, ok := raw.(map[string]any)
		if !ok || f == nil {
			continue
		}
		id := asString(f["id"])
		val, exists := answerMap[id]
		if !exists {
			continue
		}
		formatted := formatFieldAnswer(f, val)
		if formatted == "" {
			continue
		}
		sec, _ := f["secret"].(bool)
		entries = append(entries, entry{
			label:  asString(f["label"]),
			secret: sec,
			value:  formatted,
		})
	}
	if len(entries) == 0 {
		return ""
	}
	if len(fields) == 1 {
		if entries[0].secret {
			return secretAnswerSubmitted
		}
		return entries[0].value
	}
	lines := make([]string, len(entries))
	for i, e := range entries {
		lines[i] = e.label + "：" + e.value
	}
	return strings.Join(lines, "\n")
}

func formatFieldAnswer(field map[string]any, input any) string {
	vals := extractAnswerValues(input)
	if len(vals) == 0 {
		return ""
	}
	if sec, _ := field["secret"].(bool); sec {
		return hiddenAnswerDisplay
	}
	optionLabels := make(map[string]string)
	if opts, err := asSlice(field["options"], "options"); err == nil {
		for _, raw := range opts {
			if o, ok := raw.(map[string]any); ok && o != nil {
				optionLabels[asString(o["value"])] = asString(o["label"])
			}
		}
	}
	resolved := make([]string, len(vals))
	for i, v := range vals {
		if lbl, ok := optionLabels[v]; ok && lbl != "" {
			resolved[i] = lbl
		} else {
			resolved[i] = v
		}
	}
	return strings.Join(resolved, "、")
}

func extractAnswerValues(input any) []string {
	var rawVals []any
	if m, ok := input.(map[string]any); ok && m != nil {
		if ans, exists := m["answers"]; exists {
			if s, err := asSlice(ans, "answers"); err == nil {
				rawVals = s
			}
		}
	}
	if rawVals == nil {
		if s, err := asSlice(input, "input"); err == nil {
			rawVals = s
		} else if input != nil {
			rawVals = []any{input}
		}
	}
	var out []string
	for _, entry := range rawVals {
		if entry == nil {
			continue
		}
		trimmed := strings.TrimSpace(asString(entry))
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
