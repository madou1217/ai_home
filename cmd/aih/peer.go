package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

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
	targets = append(targets, listAGYSessionTargets(ctx, configured)...)
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
	case "send", "reply":
		delivery.Mode = peer.SenderPermissionClass(ctx, host, self)
		return sendPeer(ctx, parsed, runtime, store, targets, self, delivery, output)
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
	if rec.State == "delivered" {
		if rec.To.Channel == "native" {
			if rec.NativeStatus == "accepted" {
				return "已接收"
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
	}
	if rec.State == "failed" {
		return "发送失败"
	}
	return "等待接收"
}
