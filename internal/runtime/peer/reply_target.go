package peer

import "fmt"

// FindReplyTarget follows the exact sender instance already stored on the
// original message. Known constraints are conjunctive, never fallback hints.
// A second tmux view of a native session is not another recipient.
func FindReplyTarget(targets []Target, sender RecordParty) (Target, error) {
	if sender.Channel == "native" && sender.SessionID == "" {
		return Target{}, fmt.Errorf("旧消息缺少发送会话身份，请明确选择目标后使用 peer send")
	}
	completeDelivery := sender.Delivery != nil && sender.Delivery.CLIName != "" && sender.Delivery.RuntimeScope != "" && sender.Delivery.SessionName != ""
	if sender.SessionID == "" && !(sender.Channel == "inject" && completeDelivery) {
		return Target{}, fmt.Errorf("旧消息缺少可验证的发送会话地址，请明确选择目标后使用 peer send")
	}
	found := []Target{}
	for _, target := range targets {
		if sender.Provider != "" && target.Provider != sender.Provider {
			continue
		}
		if sender.Channel != "" && target.Channel != sender.Channel {
			continue
		}
		if sender.SessionID != "" && target.SessionID != sender.SessionID {
			continue
		}
		if sender.Address != "" && target.Address != sender.Address {
			continue
		}
		if sender.Delivery != nil {
			if target.Delivery == nil {
				continue
			}
			a, b := sender.Delivery, target.Delivery
			if a.CLIName != "" && a.CLIName != b.CLIName || a.RuntimeScope != "" && a.RuntimeScope != b.RuntimeScope || a.SessionName != "" && a.SessionName != b.SessionName || a.Socket != "" && a.Socket != b.Socket {
				continue
			}
		}
		found = append(found, target)
	}
	if len(found) == 1 {
		return found[0], nil
	}
	if len(found) > 1 {
		return Target{}, fmt.Errorf("原发送会话有多个活动目标，请明确选择目标后使用 peer send")
	}
	return Target{}, fmt.Errorf("原发送会话已结束或地址已变化，未发送回复")
}
