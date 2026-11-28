package main

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

func peerPriority(value string) (int, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "normal":
		return peer.PriorityNormal, nil
	case "high", "urgent":
		return peer.PriorityHigh, nil
	case "low":
		return peer.PriorityLow, nil
	default:
		return 0, fmt.Errorf("--priority 需为 high、normal 或 low")
	}
}

func sendPeer(ctx context.Context, args peerArguments, runtime commandRuntime, store *peer.DispatchStore, targets []peer.Target, self peer.RecordParty, delivery peer.DeliveryOptions, output func(any) error) error {
	if len(args.positionals) < 2 {
		return fmt.Errorf("用法：aih peer %s <会话或消息ID> \"内容\"", args.verb)
	}
	wanted := args.positionals[0]
	body := strings.Join(args.positionals[1:], " ")
	replyTo := args.values["reply-to"]
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("消息不能为空")
	}
	var original *peer.Record
	if args.verb == "reply" {
		rec, err := store.Find(wanted)
		if err != nil {
			return err
		}
		if !peer.SameRecipient(rec.To, self) {
			return fmt.Errorf("只能由收件会话回复这条消息")
		}
		original = rec
		replyTo = rec.ID
	}
	var target peer.Target
	var err error
	if original != nil {
		target, err = peer.FindReplyTarget(targets, original.From)
	} else {
		target, err = peer.FindTarget(targets, wanted)
	}
	if err != nil {
		return err
	}

	if args.values["provider"] != "" && args.values["provider"] != target.Provider {
		return fmt.Errorf("目标 Provider 不匹配")
	}
	if args.values["channel"] != "" && args.values["channel"] != target.Channel {
		return fmt.Errorf("目标通道不匹配")
	}
	if requested := args.values["mode"]; requested != "" && requested != delivery.Mode {
		return fmt.Errorf("发送权限由实际会话自动识别，不能用 --mode 冒充")
	}
	model := strings.TrimSpace(args.values["model"])
	effort := strings.TrimSpace(args.values["effort"])
	if effort != "" && model == "" {
		return fmt.Errorf("--effort 需要同时指定 --model")
	}
	if (model != "" || effort != "") && !peer.ChannelOf(target.Channel).SupportsTurnModelSelection() {
		return fmt.Errorf(
			"--model/--effort 只用于 webui-chat 目标（%s 的模型随会话启动确定；agy 会话请在 aih agy session 创建时指定）",
			target.Channel,
		)
	}
	from := self
	if value := args.values["from"]; value != "" && value != self.Name && value != self.Address && value != self.SessionID {
		return fmt.Errorf("发送身份由实际会话自动识别，不能用 --from 冒充")
	}
	until, err := peerTime(args.values["auto-deliver-until"])
	if err != nil {
		return err
	}
	expiry := args.values["expires-at"]
	if expiry == "" {
		expiry = args.values["deadline"]
	}
	expires, err := peerTime(expiry)
	if err != nil {
		return err
	}
	if wait := args.values["wait"]; wait != "" {
		seconds, err := strconv.ParseFloat(wait, 64)
		if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > 30 {
			return fmt.Errorf("--wait 需为 0 到 30 秒")
		}
		delivery.Timeout = time.Duration(seconds * float64(time.Second))
	}
	delivery.NoEnvelope = args.flags["no-envelope"]
	policy := args.values["reply-policy"]
	// "none" used to mean "keep it in the inbox without interrupting". There is
	// no inbox now, so reject it instead of silently queueing forever.
	if policy == "none" {
		return fmt.Errorf("--reply-policy none 已移除：不再有收件箱；请用 required 或 optional")
	}
	priority, err := peerPriority(args.values["priority"])
	if err != nil {
		return err
	}
	input := peer.CreateMessageInput{From: from, To: target.RecordParty, Body: body, ReplyTo: replyTo, Subject: args.values["subject"], Summary: args.values["summary"], Purpose: args.values["purpose"], Action: args.values["action"], ReplyPolicy: policy, Priority: priority, AutoDeliverUntil: until, Supersedes: args.values["supersedes"], Model: model, ReasoningEffort: effort}
	if expires != nil {
		input.ExpiresAt = *expires
	}
	if args.flags["dry-run"] {
		return output(map[string]any{"ok": true, "dryRun": true, "target": target, "from": from, "permissionClass": delivery.Mode, "body": body})
	}
	// Serialize identical concurrent sends in the store as well as across CLI
	// processes. This is not fuzzy coalescing: different user requests survive.
	input.FromMode = delivery.Mode
	input.NoEnvelope = delivery.NoEnvelope
	rec, err := store.CreateMessageDeduplicated(input, 30*time.Second)
	if err != nil {
		return err
	}
	if rec.State == "pending" && rec.NotificationState == "ready" {
		claimed, ok, err := store.Claim(rec.ID)
		if err != nil {
			return err
		}
		if ok {
			result := peer.DeliverRecord(ctx, *claimed, delivery)
			switch {
			case result.OK:
				rec, err = store.SettleDeliveryResult(claimed, result)
			case peer.IsTerminalDeliveryError(result.Error):
				rec, err = store.SettleFailed(claimed, result.Error)
			default:
				rec, err = store.SettlePending(claimed, result.Error, peer.BackoffFor(peer.DeliveryFailureCount(*claimed)+1))
			}
			if err != nil {
				return err
			}
		}
	}
	if args.flags["json"] {
		return output(map[string]any{"ok": true, "id": rec.ID, "shortId": peer.ShortMessageID(rec.ID), "state": rec.State, "deliveryStatus": peerDeliveryLabel(*rec), "message": rec, "target": target})
	}
	fmt.Fprintf(runtime.stdout, "%s → %s · %s\n", peer.ShortMessageID(rec.ID), peer.CollapseBody(target.Name, "", 100), peerDeliveryLabel(*rec))
	return nil
}
