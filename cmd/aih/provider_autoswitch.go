package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

// runProviderAutoSwitch 读写全局自动换号配置（与 WebUI 设置页共用 config:usage）。
// 自动换号是全局设置，CLI 名只用于用法文案。
func runProviderAutoSwitch(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	action := "status"
	remaining := 0
	hasRemaining := false
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		switch {
		case token == "":
			continue
		case token == "--remaining":
			if index+1 >= len(arguments) {
				return fmt.Errorf("--remaining expects 0-100（0 = 只在额度真的用完时换）")
			}
			index++
			value, err := parseRemainingPercent(arguments[index])
			if err != nil {
				return err
			}
			remaining = value
			hasRemaining = true
		case strings.HasPrefix(token, "--remaining="):
			value, err := parseRemainingPercent(strings.TrimPrefix(token, "--remaining="))
			if err != nil {
				return err
			}
			remaining = value
			hasRemaining = true
		case token == "on" || token == "off" || token == "status" || token == "show":
			action = token
		default:
			return fmt.Errorf(
				"Unknown auto-switch action '%s'.\nUsage: aih %s auto-switch on|off|status [--remaining <0-100>]",
				token,
				providerID,
			)
		}
	}
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	config, err := client.GetUsageConfig(ctx)
	if err != nil {
		return fmt.Errorf("读取全局用量配置失败: %w", err)
	}
	changed := false
	if action == "on" || action == "off" {
		config.AutoSwitch = action == "on"
		changed = true
	}
	if hasRemaining {
		value := remaining
		config.AutoSwitchRemainingPct = &value
		changed = true
	}
	if changed {
		if err := client.SetUsageConfig(ctx, config); err != nil {
			return fmt.Errorf("写入全局用量配置失败: %w", err)
		}
	}
	writeAutoSwitchStatus(runtime.stdout, providerID, config)
	return nil
}

// parseRemainingPercent 只接受 0-100 的整数百分比（与 Node 一致）。
func parseRemainingPercent(value string) (int, error) {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number < 0 || number > 100 {
		return 0, fmt.Errorf("--remaining expects 0-100（0 = 只在额度真的用完时换）")
	}
	return number, nil
}

// writeAutoSwitchStatus 输出与 Node 相同的三段信息（去掉颜色）。
func writeAutoSwitchStatus(
	output io.Writer,
	providerID string,
	config managementapi.UsageConfig,
) {
	state := "关闭"
	if config.AutoSwitch {
		state = "已开启"
	}
	threshold := "跟随 threshold_pct（剩余 ≤ " +
		strconv.Itoa(thresholdRemaining(config.ThresholdPct)) + "%）"
	if config.AutoSwitchRemainingPct != nil {
		threshold = "剩余 ≤ " + strconv.Itoa(*config.AutoSwitchRemainingPct) + "%"
	}
	_, _ = fmt.Fprintf(output, "[aih] 自动换号（原生模式，全局）：%s\n", state)
	_, _ = fmt.Fprintf(
		output,
		"      触发：额度%s；或 429 限流（上游给出恢复时刻）；或额度/积分已耗尽\n",
		threshold,
	)
	_, _ = fmt.Fprintf(
		output,
		"      用法：aih %s auto-switch on|off|status [--remaining <0-100>]\n",
		providerID,
	)
}

func thresholdRemaining(threshold int) int {
	remaining := 100 - threshold
	if remaining < 0 {
		return 0
	}
	if remaining > 100 {
		return 100
	}
	return remaining
}
