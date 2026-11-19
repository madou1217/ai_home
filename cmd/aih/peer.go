package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

func runPeer(ctx context.Context, args []string, runtime commandRuntime) error {
	parsed, err := parsePeerArguments(args)
	if err != nil {
		return err
	}
	if parsed.verb == "help" {
		_, err = io.WriteString(runtime.stdout, peerHelp)
		return err
	}
	if parsed.flags["dry-run"] && parsed.verb != "send" && parsed.verb != "reply" {
		return fmt.Errorf("--dry-run 仅支持 send/reply；未执行任何操作")
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	getenv := func(key string) string { value, _ := runtime.lookupEnv(key); return value }
	host := peer.ResolveUnprojectedHostHomeDir(getenv)
	targets, err := peer.ListTargets(ctx, home, host, getenv)
	if err != nil {
		return err
	}
	configured, err := withClaudeGatewayConfig(ctx, runtime)
	if err != nil {
		return err
	}
	targets = append(targets, listPeerChatTargets(ctx, configured)...)
	store := peer.NewDispatchStore(home, peer.StoreOptions{})
	self := peer.ResolveSelf(ctx, targets, getenv)
	output := func(value any) error {
		encoder := json.NewEncoder(runtime.stdout)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(value)
	}
	httpClient, _ := runtime.managementAPI.(*http.Client)
	delivery := peer.DeliveryOptions{AIHomeDir: home, HostHomeDir: host, Getenv: getenv, HTTPClient: httpClient,
		ServerBaseURL: func() string { return resolveManagementBaseURL(configured) }, ManagementKey: func() string { return envValue(configured, "AIH_SERVER_MANAGEMENT_KEY") }}
	switch parsed.verb {
	case "list", "channels":
		filtered := []peer.Target{}
		for _, target := range targets {
			if (parsed.values["channel"] == "" || target.Channel == parsed.values["channel"]) && (parsed.values["provider"] == "" || target.Provider == parsed.values["provider"]) {
				filtered = append(filtered, target)
			}
		}
		if parsed.flags["json"] {
			return output(map[string]any{"targets": filtered, "self": self})
		}
		for _, target := range filtered {
			fmt.Fprintf(runtime.stdout, "%-12s %-10s %-10s %s  %s\n", target.Provider, target.Channel, target.Status, target.ID, peer.CollapseBody(target.Name, "", 100))
		}
		return nil
	case "inbox":
		records, err := store.Records()
		if err != nil {
			return err
		}
		limit := 50
		if value := parsed.values["limit"]; value != "" {
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 {
				return fmt.Errorf("--limit 需为正整数")
			}
		}
		wanted := parsed.values["target"]
		state := parsed.values["state"]
		if state == "" {
			state = "open"
		}
		if parsed.flags["unread"] {
			state = "unread"
		}
		if parsed.flags["self"] && self.Address == "aih-cli" {
			return fmt.Errorf("无法确定当前收件会话；可用 --target 查看，但不会代对方确认已读")
		}
		result := []peer.Record{}
		for _, rec := range records {
			if parsed.flags["self"] && !peer.SameRecipient(rec.To, self) {
				continue
			}
			if wanted != "" && rec.To.Name != wanted && rec.To.SessionID != wanted && rec.To.Address != wanted {
				continue
			}
			if state == "open" && (rec.State == "read" || rec.State == "failed") {
				continue
			}
			if state == "unread" && rec.ReadAt > 0 {
				continue
			}
			if state != "all" && state != "open" && state != "unread" && state != rec.State && state != rec.NotificationState {
				continue
			}
			result = append(result, rec)
		}
		if len(result) > limit {
			result = result[:limit]
		}
		if parsed.flags["json"] {
			return output(map[string]any{"messages": result})
		}
		for _, rec := range result {
			fmt.Fprintf(runtime.stdout, "%s  %-10s %s → %s  %s\n", peer.ShortMessageID(rec.ID), peerDeliveryLabel(rec), peer.CollapseBody(rec.From.Name, "", 80), peer.CollapseBody(rec.To.Name, "", 80), peer.CollapseBody(rec.Body, rec.ID, 180))
		}
		return nil
	case "read", "ack":
		if len(parsed.positionals) != 1 {
			return fmt.Errorf("用法：aih peer %s <消息ID>", parsed.verb)
		}
		rec, err := store.Find(parsed.positionals[0])
		if err != nil {
			return err
		}
		if parsed.verb == "ack" || parsed.flags["ack"] {
			rec, err = store.Acknowledge(rec.ID, self)
			if err != nil {
				return fmt.Errorf("只有收件会话能确认已读：%w", err)
			}
		}
		if parsed.flags["json"] {
			return output(rec)
		}
		fmt.Fprintf(runtime.stdout, "%s  %s\n%s\n", rec.ID, peerDeliveryLabel(*rec), rec.Body)
		return nil
	case "send", "reply":
		delivery.Mode = peer.SenderPermissionClass(ctx, host, self)
		return sendPeer(ctx, parsed, runtime, store, targets, self, delivery, output)
	case "cancel", "resume":
		if len(parsed.positionals) != 1 {
			return fmt.Errorf("用法：aih peer %s <消息ID>", parsed.verb)
		}
		rec, err := store.Find(parsed.positionals[0])
		if err != nil {
			return err
		}
		if !peer.SameRecipient(rec.From, self) {
			return fmt.Errorf("只能操作当前会话自己发送的消息")
		}
		until, err := peerTime(parsed.values["auto-deliver-until"])
		if err != nil {
			return err
		}
		expires, err := peerTime(parsed.values["expires-at"])
		if err != nil {
			return err
		}
		input := peer.LifecycleInput{ID: rec.ID, From: rec.From, To: rec.To, AutoDeliverUntil: until, ExpiresAt: expires, ResetAttempts: parsed.flags["reset-attempts"]}
		if parsed.verb == "cancel" {
			rec, err = store.CancelMessage(input)
		} else {
			rec, err = store.ResumeMessage(input)
		}
		if err != nil {
			return err
		}
		if parsed.flags["json"] {
			return output(rec)
		}
		fmt.Fprintf(runtime.stdout, "%s %s\n", rec.ID, peerDeliveryLabel(*rec))
		return nil
	case "flush":
		summary, err := peer.FlushPending(ctx, store, peer.FlushOptions{Delivery: delivery})
		if err != nil {
			return err
		}
		if parsed.flags["json"] {
			return output(summary)
		}
		fmt.Fprintf(runtime.stdout, "已发送 %d，等待 %d，失败 %d\n", summary.Delivered, summary.Pending, summary.Failed)
		return nil
	default:
		return fmt.Errorf("未知 peer 命令：%s；用 aih peer --help 查看", parsed.verb)
	}
}

func envValue(runtime commandRuntime, key string) string {
	value, _ := runtime.lookupEnv(key)
	return value
}

func peerDeliveryLabel(rec peer.Record) string {
	if rec.ReadAt > 0 || rec.State == "read" {
		return "已读"
	}
	if rec.State == "delivered" {
		if rec.To.Channel == "native" {
			if rec.NativeStatus == "accepted" {
				return "已接收，未确认已读"
			}
			if rec.NativeStatus == "held" {
				return "等待对方批准"
			}
			return "已发送，待接收确认"
		}
		return "已发送"
	}
	switch rec.NotificationState {
	case "canceled":
		return "已撤回"
	case "expired":
		return "已过期"
	case "manual":
		if rec.ReplyPolicy == "none" {
			return "已存收件箱"
		}
		return "已保存"
	}
	if rec.State == "failed" {
		return "发送失败"
	}
	return "等待接收"
}
