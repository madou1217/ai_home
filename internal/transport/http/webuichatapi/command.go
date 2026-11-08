package webuichatapi

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// commandTypeTurnSubmit 是本切片唯一支持的指令类型。
	commandTypeTurnSubmit = "turn.submit"
	// maxTurnAttachments 与 Node normalizeAttachmentIds 的上限一致。
	maxTurnAttachments = 8
)

// turnCommand 是校验通过的一次 turn.submit。
type turnCommand struct {
	CommandID       string
	Content         string
	Model           string
	ReasoningEffort string
	AttachmentIDs   []string
}

// decodeTurnSubmit 按 Node normalizeCommand + normalizeTurnSubmit 的口径校验指令信封。
//
// 为什么逐字段读 RawMessage 而不是直接 json.Unmarshal 到结构体：Node 的校验分两类——
// 「字段取值非法」会给出具体错误码，而「未知字段」在顶层被静默丢弃。用结构体解码会把
// 两者混成一个笼统错误，前端就分不清该重试还是该改请求。
func decodeTurnSubmit(document []byte) (turnCommand, *routeError) {
	if len(bytes.TrimSpace(document)) == 0 {
		// Node 把空正文当成 {} 继续走字段校验，这里保持一致：
		// 让调用方看到「缺少 commandId」而不是笼统的「载荷无效」。
		document = []byte("{}")
	}
	fields, ok := relaycore.DecodeRawObject(document)
	if !ok {
		return turnCommand{}, newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "聊天指令不是 JSON 对象", nil,
		)
	}
	commandID := requiredText(fields["commandId"])
	if commandID == "" {
		return turnCommand{}, newRouteError(
			statusBadRequest, "chat_command_id_required", "聊天指令缺少 commandId", nil,
		)
	}
	commandType := requiredText(fields["type"])
	if commandType == "" {
		return turnCommand{}, newRouteError(
			statusBadRequest, "chat_command_type_required", "聊天指令缺少 type", nil,
		)
	}
	if commandType != commandTypeTurnSubmit {
		return turnCommand{}, newRouteError(
			statusUnprocessableEntity,
			"unsupported_chat_command",
			"Go 聊天切片目前只接受 turn.submit",
			map[string]any{"type": commandType},
		)
	}
	payloadRaw, present := fields["payload"]
	if !present {
		payloadRaw = json.RawMessage("{}")
	}
	payload, ok := relaycore.DecodeRawObject(payloadRaw)
	if !ok {
		return turnCommand{}, newRouteError(
			statusBadRequest, "invalid_chat_payload", "聊天指令载荷不是 JSON 对象", nil,
		)
	}
	for _, key := range []string{"runId", "turnId"} {
		if _, controlled := payload[key]; controlled {
			// 轮次身份只能由服务端生成，否则客户端可以伪造别人的 turn。
			return turnCommand{}, newRouteError(
				statusUnprocessableEntity,
				"chat_turn_identity_client_controlled",
				"轮次身份由服务端生成",
				map[string]any{"key": key},
			)
		}
	}
	attachments, attachmentError := decodeAttachmentIDs(payload["attachmentIds"])
	if attachmentError != nil {
		return turnCommand{}, attachmentError
	}
	content := requiredText(payload["content"])
	if content == "" && len(attachments) == 0 {
		return turnCommand{}, newRouteError(
			statusUnprocessableEntity, "chat_turn_content_required", "本轮既没有正文也没有附件", nil,
		)
	}
	command := turnCommand{
		CommandID:     commandID,
		Content:       content,
		AttachmentIDs: attachments,
	}
	for key, target := range map[string]*string{
		"model":           &command.Model,
		"reasoningEffort": &command.ReasoningEffort,
	} {
		raw, exists := payload[key]
		if !exists {
			continue
		}
		value, valid := textValue(raw)
		if !valid {
			return turnCommand{}, modelControlError(key)
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return turnCommand{}, modelControlError(key)
		}
		*target = value
	}
	return command, nil
}

// modelControlError 复刻 Node 对 model / reasoningEffort 的同一错误码。
func modelControlError(key string) *routeError {
	return newRouteError(
		statusUnprocessableEntity,
		"chat_turn_model_control_invalid",
		"模型控制字段不能为空",
		map[string]any{"key": key},
	)
}

// decodeAttachmentIDs 复刻 Node normalizeAttachmentIds：数组、去空白、不重复、上限 8。
func decodeAttachmentIDs(raw json.RawMessage) ([]string, *routeError) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, newRouteError(
			statusUnprocessableEntity, "chat_attachment_ids_invalid",
			"附件列表必须是字符串数组",
			map[string]any{"limit": maxTurnAttachments},
		)
	}
	if len(items) > maxTurnAttachments {
		return nil, newRouteError(
			statusUnprocessableEntity, "chat_attachment_ids_invalid",
			"单个轮次的附件数量超过上限",
			map[string]any{"limit": maxTurnAttachments},
		)
	}
	ids := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		value, ok := relaycore.RawString(item)
		if !ok || strings.TrimSpace(value) == "" {
			return nil, newRouteError(
				statusUnprocessableEntity, "chat_attachment_id_invalid",
				"附件标识必须是字符串", nil,
			)
		}
		value = strings.TrimSpace(value)
		if _, duplicated := seen[value]; duplicated {
			return nil, newRouteError(
				statusUnprocessableEntity, "chat_attachment_ids_duplicate",
				"同一轮次不能重复引用同一附件", nil,
			)
		}
		seen[value] = struct{}{}
		ids = append(ids, value)
	}
	return ids, nil
}

// requiredText 复刻 Node requiredText：String(value || ”).trim()。
func requiredText(raw json.RawMessage) string {
	value, ok := textValue(raw)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

// textValue 把 JSON 标量读成文本，口径对齐 Node 的 String()：
// 字符串取原值、数字取字面量、布尔取 true/false、null 与缺席取空串。
// 对象与数组返回 false——Node 会得到 "[object Object]" 这样的垃圾值，
// 那种输入只可能是拼错的请求，报错比接受更有用。
func textValue(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return "", true
	}
	if value, ok := relaycore.RawString(raw); ok {
		return value, true
	}
	switch trimmed {
	case "true", "false":
		return trimmed, true
	}
	if _, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return trimmed, true
	}
	return "", false
}
