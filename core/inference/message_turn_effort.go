package inference

// 按轮推理强度（per-turn effort）：Anthropic Messages 允许对话中途的 system 消息携带
// output_config.effort，从该轮起改变模型的推理强度（Claude Code 2.1.28x 起每个会话都会发）。
// 只有 system 消息能携带；不认识这个概念的 Provider 编码器忽略它即可，请求级强度不受影响。

// WithTurnEffort 返回携带按轮推理强度的消息副本；只接受 system 消息与已注册、非 none 的强度。
func (message Message) WithTurnEffort(effort ReasoningEffort) (Message, error) {
	if !message.IsValid() || effort == "" || !validTurnEffort(message.role, effort) {
		return Message{}, ErrInvalidMessage
	}
	cloned := message.clone()
	cloned.turnEffort = effort
	return cloned, nil
}

// TurnEffort 返回 system 消息携带的按轮推理强度；没有时为空。
func (message Message) TurnEffort() ReasoningEffort {
	return message.turnEffort
}

func validTurnEffort(role Role, effort ReasoningEffort) bool {
	if effort == "" {
		return true
	}
	return role == RoleSystem && effort.IsValid() && effort != ReasoningEffortNone
}
