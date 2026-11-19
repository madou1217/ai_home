package main

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

var backupConfigCommands = map[string]bool{
	"add": true, "list": true, "ls": true, "remove": true, "rm": true,
	"enable": true, "disable": true, "config": true, "show": true,
}

func runBackup(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || hasHelpToken(arguments) {
		writeBackupUsage(runtime.stdout)
		return nil
	}
	command := strings.ToLower(strings.TrimSpace(arguments[0]))
	if !backupConfigCommands[command] {
		return fmt.Errorf("unsupported backup command: %s", command)
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return err
	}
	switch command {
	case "add":
		return backupAdd(home, arguments[1:], runtime)
	case "list", "ls":
		config, err := remotebackup.ReadBackupConfig(home)
		if err != nil {
			return err
		}
		state, err := remotebackup.ReadBackupState(home)
		if err != nil {
			return err
		}
		writeBackupStatus(runtime.stdout, config, state)
	case "remove", "rm":
		return backupRemove(home, arguments[1:], runtime)
	case "enable", "disable":
		return backupSetEnabled(home, arguments[1:], command == "enable", runtime)
	case "config":
		return backupConfig(home, arguments[1:], runtime)
	case "show":
		config, err := remotebackup.ReadBackupConfig(home)
		if err != nil {
			return err
		}
		state, err := remotebackup.ReadBackupState(home)
		if err != nil {
			return err
		}
		return writeJSONDocument(runtime.stdout, map[string]any{"config": config, "state": state})
	}
	return nil
}

func backupAdd(home string, arguments []string, runtime commandRuntime) error {
	positionals, flags, err := parseBackupTokens(arguments)
	if err != nil {
		return err
	}
	if len(positionals) == 0 {
		return fmt.Errorf("用法：aih backup add <user@host> [--name <id>] [--key <path>]")
	}
	port := 0
	if value := strings.TrimSpace(flags["port"]); value != "" {
		port, _ = strconv.Atoi(value)
	}
	target, err := remotebackup.NormalizeTarget(remotebackup.TargetInput{
		ID:           flags["name"],
		Address:      positionals[0],
		Port:         port,
		IdentityFile: flags["key"],
		RemoteDir:    flags["remote-dir"],
		PasswordEnv:  flags["password-env"],
		Strategy:     flags["strategy"],
	})
	if err != nil {
		return err
	}
	config, err := remotebackup.ReadBackupConfig(home)
	if err != nil {
		return err
	}
	for _, existing := range config.Targets {
		if existing.ID == target.ID {
			return fmt.Errorf("备份目标已存在：%s", target.ID)
		}
	}
	config.Targets = append(config.Targets, target)
	if _, err := remotebackup.WriteBackupConfig(home, config); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已添加备份目标 %s → %s@%s:%d%s\n", target.ID, target.Username, target.Host, target.Port, target.RemoteDir)
	return nil
}

func backupRemove(home string, arguments []string, runtime commandRuntime) error {
	positionals, _, err := parseBackupTokens(arguments)
	if err != nil {
		return err
	}
	if len(positionals) == 0 {
		return fmt.Errorf("用法：aih backup remove <id|user@host>")
	}
	config, err := remotebackup.ReadBackupConfig(home)
	if err != nil {
		return err
	}
	index := backupTargetIndex(config.Targets, positionals[0])
	if index < 0 {
		return fmt.Errorf("找不到备份目标：%s", positionals[0])
	}
	removed := config.Targets[index]
	config.Targets = append(config.Targets[:index], config.Targets[index+1:]...)
	if _, err := remotebackup.WriteBackupConfig(home, config); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 已删除备份目标 %s（远端已有文件保留）\n", removed.ID)
	return nil
}

func backupSetEnabled(home string, arguments []string, enabled bool, runtime commandRuntime) error {
	positionals, _, err := parseBackupTokens(arguments)
	if err != nil {
		return err
	}
	if len(positionals) == 0 {
		return fmt.Errorf("用法：aih backup %s <id|user@host>", map[bool]string{true: "enable", false: "disable"}[enabled])
	}
	config, err := remotebackup.ReadBackupConfig(home)
	if err != nil {
		return err
	}
	index := backupTargetIndex(config.Targets, positionals[0])
	if index < 0 {
		return fmt.Errorf("找不到备份目标：%s", positionals[0])
	}
	config.Targets[index].Enabled = enabled
	if _, err := remotebackup.WriteBackupConfig(home, config); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] %s 已%s\n", config.Targets[index].ID, map[bool]string{true: "启用", false: "暂停"}[enabled])
	return nil
}

func backupConfig(home string, arguments []string, runtime commandRuntime) error {
	_, flags, err := parseBackupTokens(arguments)
	if err != nil {
		return err
	}
	config, err := remotebackup.ReadBackupConfig(home)
	if err != nil {
		return err
	}
	changed := false
	if value := strings.TrimSpace(flags["interval"]); value != "" {
		interval, parseErr := strconv.Atoi(value)
		if parseErr != nil || interval <= 0 {
			return fmt.Errorf("--interval 必须是正整数")
		}
		config.IntervalMinutes = interval
		changed = true
	}
	if value := strings.TrimSpace(flags["debounce"]); value != "" {
		debounce, parseErr := strconv.Atoi(value)
		if parseErr != nil || debounce < 0 {
			return fmt.Errorf("--debounce 必须是非负整数")
		}
		config.DebounceSeconds = debounce
		changed = true
	}
	if value := strings.ToLower(strings.TrimSpace(flags["enabled"])); value != "" {
		switch value {
		case "on", "true", "1":
			config.Enabled = true
		case "off", "false", "0":
			config.Enabled = false
		default:
			return fmt.Errorf("--enabled 只接受 on / off")
		}
		changed = true
	}
	if changed {
		if _, err := remotebackup.WriteBackupConfig(home, config); err != nil {
			return err
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "自动备份：%s，周期 %d 分钟，去抖 %ds\n",
		map[bool]string{true: "开启", false: "暂停"}[config.Enabled],
		config.IntervalMinutes, config.DebounceSeconds)
	return nil
}

func writeBackupStatus(output io.Writer, config remotebackup.BackupConfig, state remotebackup.BackupState) {
	if len(config.Targets) == 0 {
		_, _ = fmt.Fprintln(output, "[aih] 还没有远程备份目标。用 aih backup add <user@host> 添加。")
		return
	}
	_, _ = fmt.Fprintf(output, "[aih] 自动备份：%s，周期 %d 分钟，去抖 %ds\n",
		map[bool]string{true: "开启", false: "暂停"}[config.Enabled],
		config.IntervalMinutes, config.DebounceSeconds)
	for _, target := range config.Targets {
		entry := state.Targets[target.ID]
		stateText := "尚未备份"
		if !target.Enabled {
			stateText = "已暂停"
		} else if entry.LastError != "" {
			stateText = "失败 " + entry.LastError
		} else if entry.LastOkAt != "" {
			stateText = fmt.Sprintf("正常 上传 %d / 未变 %d，revision %d", entry.Uploaded, entry.Unchanged, entry.Revision)
		}
		_, _ = fmt.Fprintf(output, "  %-20s %s %s@%s:%d %s\n", target.ID, target.Strategy, target.Username, target.Host, target.Port, target.RemoteDir)
		_, _ = fmt.Fprintf(output, "  %-20s 上次成功 %s  %s\n", "", backupTimestamp(entry.LastOkAt), stateText)
	}
}

func backupTimestamp(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

func backupTargetIndex(targets []remotebackup.BackupTarget, selector string) int {
	selector = strings.TrimSpace(selector)
	for index, target := range targets {
		if target.ID == selector ||
			selector == fmt.Sprintf("%s@%s:%d", target.Username, target.Host, target.Port) {
			return index
		}
	}
	return -1
}

func parseBackupTokens(arguments []string) ([]string, map[string]string, error) {
	withValue := map[string]bool{
		"--name": true, "--port": true, "--key": true, "--remote-dir": true,
		"--password-env": true, "--strategy": true, "--interval": true,
		"--debounce": true, "--enabled": true, "--owner": true,
		"--recovery-token": true, "--attempt-token": true,
	}
	boolean := map[string]bool{"--full": true, "--dry-run": true, "--remote": true, "--confirm-stopped": true}
	positionals := make([]string, 0)
	flags := map[string]string{}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		if token == "" {
			continue
		}
		if withValue[token] {
			if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "--") {
				return nil, nil, fmt.Errorf("%s 需要一个值", token)
			}
			index++
			flags[strings.TrimPrefix(token, "--")] = strings.TrimSpace(arguments[index])
			continue
		}
		if boolean[token] {
			flags[strings.TrimPrefix(token, "--")] = "true"
			continue
		}
		if strings.HasPrefix(token, "--") {
			return nil, nil, fmt.Errorf("未知选项：%s", token)
		}
		positionals = append(positionals, token)
	}
	return positionals, flags, nil
}

func writeBackupUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "AIH Backup - 账号导出 / 导入 / 远程自动备份")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih backup add <user@host> [选项]")
	_, _ = fmt.Fprintln(output, "  aih backup list")
	_, _ = fmt.Fprintln(output, "  aih backup remove <id|user@host>")
	_, _ = fmt.Fprintln(output, "  aih backup enable|disable <id|user@host>")
	_, _ = fmt.Fprintln(output, "  aih backup config [--interval 360] [--debounce 30] [--enabled on|off]")
	_, _ = fmt.Fprintln(output, "  aih backup show")
	_, _ = fmt.Fprintln(output, "  aih backup run [id...] [--full]")
	_, _ = fmt.Fprintln(output, "  aih backup status [--remote]")
	_, _ = fmt.Fprintln(output, "  aih backup test <id|user@host>")
	_, _ = fmt.Fprintln(output, "  aih backup restore <id|user@host> [--dry-run]")
	_, _ = fmt.Fprintln(output, "  aih backup recover <id> [--dry-run] [--confirm-stopped ...]")
}
