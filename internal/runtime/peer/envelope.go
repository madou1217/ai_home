package peer

import (
	"fmt"
	"strings"
	"time"
)

// CollapseBody 将消息正文压成单行，转义换行为字面 \n 并清理终端控制字符。
func CollapseBody(body, shortID string, maxChars int) string {
	if maxChars <= 0 {
		maxChars = DefaultMaxBodyChars
	}
	text := strings.ReplaceAll(body, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = controlCharPattern.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "\n", `\n`)
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text
	}
	short := strings.TrimSpace(shortID)
	hint := " …"
	if short != "" {
		hint = fmt.Sprintf(" … (完整内容: aih peer read %s)", short)
	}
	hintRunes := []rune(hint)
	keep := maxChars - len(hintRunes)
	if keep < 0 {
		keep = 0
	}
	return string(runes[:keep]) + hint
}

// FormatPeerEnvelope is the legacy terminal-only envelope helper.
func FormatPeerEnvelope(shortID string, from RecordParty, body string, maxChars int) string {
	short := strings.TrimSpace(shortID)
	collapsed := CollapseBody(body, short, maxChars)
	if short == "" {
		return collapsed
	}
	sender := strings.TrimSpace(from.Name)
	if sender == "" {
		sender = strings.TrimSpace(from.Address)
	}
	if sender == "" {
		sender = strings.TrimSpace(from.SessionID)
	}
	if sender == "" {
		sender = "unknown"
	}
	header := fmt.Sprintf("[aih-peer #%s from %s | reply: aih peer reply %s]", short, sender, short)
	if collapsed == "" {
		return header
	}
	return header + " " + collapsed
}

// ReadableMetadata matches the Node explicit intent/time/validity vocabulary.
// Missing task intent is always 未说明, never inferred from the body.
func ReadableMetadata(rec Record, now time.Time) string {
	plain := func(value string) string {
		value = controlCharPattern.ReplaceAllString(value, "")
		value = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(value))
		if value == "" {
			return "未说明"
		}
		runes := []rune(value)
		if len(runes) > 240 {
			value = string(runes[:240])
		}
		return value
	}
	formatTime := func(at int64) string {
		if at <= 0 {
			return "未说明"
		}
		return time.UnixMilli(at).UTC().Format("2006-01-02T15:04:05.000Z")
	}
	projectNotificationAt(&rec, TargetGate{}, now.UnixMilli())
	validity := "未设内容截止时间"
	switch {
	case rec.NotificationState == "expired" || (rec.ExpiresAt > 0 && rec.ExpiresAt <= now.UnixMilli()):
		validity = "已过期，仅供查阅，请勿继续旧行动"
	case rec.NotificationState == "canceled" || rec.CanceledAt > 0:
		validity = "已撤回，仅供查阅"
	default:
		if rec.ExpiresAt > 0 {
			validity = "有效至 " + formatTime(rec.ExpiresAt)
		}
	}
	policies := map[string]string{"required": "需要回复", "optional": "可选回复", "none": "无需回复"}
	reply := policies[rec.ReplyPolicy]
	if reply == "" {
		reply = "未说明"
	}
	fields := []string{"主题：" + plain(rec.Subject)}
	if rec.Summary != "" {
		fields = append(fields, "摘要："+plain(rec.Summary))
	}
	fields = append(fields, "缘由："+plain(rec.Purpose), "待办："+plain(rec.Action), "回复："+reply,
		"发送："+formatTime(rec.CreatedAt), "有效性："+validity)
	if deadline := autoDeadline(rec); deadline > 0 && deadline <= now.UnixMilli() {
		fields = append(fields, "时效提示：旧消息，行动前请核对最新进展")
	}
	return strings.Join(fields, "｜")
}

// FormatRecordEnvelope keeps full originals on JSON/native transports. Only
// terminal injection escapes newlines, strips controls or truncates previews.
func FormatRecordEnvelope(rec Record, maxChars int, now time.Time) string {
	short := ShortMessageID(rec.ID)
	sender := strings.TrimSpace(rec.From.Name)
	if sender == "" {
		sender = strings.TrimSpace(rec.From.Address)
	}
	if sender == "" {
		sender = strings.TrimSpace(rec.From.SessionID)
	}
	if sender == "" {
		sender = "unknown"
	}
	// User-facing mail stays compact. Unspecified fields and scheduling/
	// transport machinery belong in `peer read --json`, not in every prompt.
	header := fmt.Sprintf("[aih-peer #%s from %s]", rec.ID, CollapseBody(sender, "", 120))
	if subject := strings.TrimSpace(rec.Subject); subject != "" {
		header += " " + CollapseBody(subject, "", 180)
	}
	parts := []string{header}
	if rec.Purpose != "" {
		parts = append(parts, "缘由："+CollapseBody(rec.Purpose, "", 240))
	}
	if rec.Action != "" {
		parts = append(parts, "待办："+CollapseBody(rec.Action, "", 240))
	}
	switch {
	case rec.CanceledAt > 0:
		parts = append(parts, "此消息已撤回，仅供查阅。")
	case rec.ExpiresAt > 0 && rec.ExpiresAt <= now.UnixMilli():
		parts = append(parts, "此消息已过期，请勿继续旧行动。")
	case rec.ExpiresAt > 0:
		parts = append(parts, "截止："+time.UnixMilli(rec.ExpiresAt).Local().Format("2006-01-02 15:04:05 MST"))
	}
	if rec.To.Channel == "native" || rec.To.Channel == "webui-chat" {
		parts = append(parts, rec.Body)
		return strings.Join(parts, "\n")
	}
	parts = append(parts, CollapseBody(rec.Body, short, maxChars))
	return strings.Join(parts, " ")
}
