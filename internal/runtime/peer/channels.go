package peer

import "strings"

// Channel 是 peer 消息的投递通道标识。
type Channel string

const (
	// ChannelNative 是 Claude UDS 原生通道。
	ChannelNative Channel = "native"
	// ChannelInject 是 tmux 注入通道；历史记录的空通道也按它处理。
	ChannelInject Channel = "inject"
	// ChannelWebUIChat 是 WebUI 会话通道。
	ChannelWebUIChat Channel = "webui-chat"
	// ChannelAGYSession 是常驻 AGY 会话通道。
	ChannelAGYSession Channel = "agy-session"
)

// ChannelOf 归一化记录里的通道值：投递层一直把空值当作 inject。
func ChannelOf(value string) Channel {
	channel := Channel(strings.TrimSpace(value))
	if channel == "" {
		return ChannelInject
	}
	return channel
}

// SupportsTurnModelSelection 表示模型与推理强度可以在投递单条消息时指定。
//
// 只有 webui-chat 会为每条消息新建一次推理回合；native/inject 的目标进程在启动时
// 就固定了模型，agy-session 的模型是会话创建参数（aih agy session --model/--effort），
// 投递阶段无法更改。能力判断集中在这里，CLI 与服务层不再各写一份字符串比较。
func (channel Channel) SupportsTurnModelSelection() bool {
	return channel == ChannelWebUIChat
}

// validateTurnSelection 保证回合级模型设置只出现在支持它的通道上。
//
// 契约（见 CreateMessageInput）：Model/ReasoningEffort 由 webui-chat 投递写入
// turn.submit，其它通道必须为空；推理强度必须依附于显式模型。
func validateTurnSelection(input CreateMessageInput) error {
	model := strings.TrimSpace(input.Model)
	effort := strings.TrimSpace(input.ReasoningEffort)
	if model == "" && effort == "" {
		return nil
	}
	if !ChannelOf(input.To.Channel).SupportsTurnModelSelection() {
		return ErrModelSelectionUnsupported
	}
	if effort != "" && model == "" {
		return ErrModelSelectionRequiresModel
	}
	return nil
}
