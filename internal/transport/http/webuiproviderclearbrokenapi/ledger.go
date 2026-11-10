package webuiproviderclearbrokenapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	// ledgerFileName 是自动升级账本，与 Node 的 upgrade-ledger.js 同路径。
	ledgerFileName = "provider-cli-upgrade.json"
	// ledgerSchemaVersion 与 Node 的 SCHEMA_VERSION 一致；不认识的新版本一律当空账本。
	ledgerSchemaVersion = 1
	// historyLimit 与 Node 的 HISTORY_LIMIT 一致。
	historyLimit = 20
)

// ledger 是 run/provider-cli-upgrade.json 的内存形态。
//
// 只保留 Node 读账本时认识的三块（schemaVersion / global / providers）：Node 的
// writeLedger 也是按 readLedger 归一后的形状重写，未知顶层键本来就会丢。
type ledger struct {
	global    map[string]any
	providers map[string]map[string]any
}

// clearPatch 是解除熔断要写回账本的事实。
type clearPatch struct {
	version  string
	detail   string
	verified bool
	at       time.Time
}

func emptyLedger() ledger {
	return ledger{
		global:    map[string]any{"enabled": true, "disabledReason": ""},
		providers: map[string]map[string]any{},
	}
}

// readLedger 读账本；不存在、损坏或 schemaVersion 不认识都回落空账本，绝不报错——
// 账本读不出来不该让一条写接口 500，调用方拿到 not_broken 就是正确结论。
func readLedger(aiHomeDir string) ledger {
	raw, err := os.ReadFile(filepath.Join(aiHomeDir, "run", ledgerFileName))
	if err != nil {
		return emptyLedger()
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil || number(decoded["schemaVersion"]) != ledgerSchemaVersion {
		return emptyLedger()
	}
	result := emptyLedger()
	for key, value := range object(decoded["global"]) {
		result.global[key] = value
	}
	for provider, value := range object(decoded["providers"]) {
		result.providers[provider] = object(value)
	}
	return result
}

// record 返回该 provider 的原始记录；没有记录时返回空映射（读默认值由投影方负责）。
func (current ledger) record(provider string) map[string]any {
	if stored, ok := current.providers[provider]; ok && stored != nil {
		return stored
	}
	return map[string]any{}
}

// clearBroken 生成解除熔断后的新账本：只改该 provider 的记录，其它 provider 与
// global 原样保留。字段集合与 Node clearBrokenProvider 的 patch 一一对应。
func (current ledger) clearBroken(provider string, patch clearPatch) ledger {
	record := map[string]any{}
	for key, value := range current.record(provider) {
		record[key] = value
	}

	// 当前版本刚验证通过，说明它当初被拉黑是误判，从黑名单移除；
	// 其它拉黑版本不在本次验证范围内，保持不动。
	kept := make([]any, 0, len(stringList(record["blockedVersions"])))
	for _, blocked := range stringList(record["blockedVersions"]) {
		if blocked != patch.version {
			kept = append(kept, blocked)
		}
	}

	history := append(anyList(record["history"]), map[string]any{
		"at":      patch.at.UnixMilli(),
		"from":    text(record["installedVersion"]),
		"to":      patch.version,
		"outcome": "cleared",
		"detail":  patch.historyDetail(),
	})
	if len(history) > historyLimit {
		history = history[len(history)-historyLimit:]
	}

	record["state"] = "healthy"
	record["enabled"] = true
	record["disabledReason"] = ""
	record["blockedVersions"] = kept
	record["installedVersion"] = patch.version
	record["knownGoodVersion"] = patch.version
	record["knownGoodRollbackable"] = channelPinnable(text(record["channel"]), provider)
	record["baselineHealthy"] = true
	record["targetVersion"] = ""
	record["lastApplyError"] = ""
	record["consecutiveFailures"] = int64(0)
	record["consecutiveDefers"] = int64(0)
	record["consecutiveQuiescentTicks"] = int64(0)
	record["lastDeferReason"] = ""
	record["history"] = history

	providers := make(map[string]map[string]any, len(current.providers)+1)
	for key, value := range current.providers {
		providers[key] = value
	}
	providers[provider] = record
	return ledger{global: current.global, providers: providers}
}

// historyDetail 是账本里那条 cleared 记录的 detail，与 Node 的
// `manual_clear:${detail || 'verified'}` 对齐；跳过验证时如实标注 skipped。
func (patch clearPatch) historyDetail() string {
	if !patch.verified {
		return "manual_clear:skipped"
	}
	if patch.detail == "" {
		return "manual_clear:verified"
	}
	return "manual_clear:" + patch.detail
}

// isBroken 判定账本是否处于熔断：state=broken 或 enabled=false 任一成立。
func isBroken(record map[string]any) bool {
	return text(record["state"]) == "broken" || record["enabled"] == false
}

// writeLedger 原子写回账本（tmp + rename，0600），缩进与 Node 的
// JSON.stringify(payload, null, 2) 一致。
func writeLedger(aiHomeDir string, next ledger) error {
	payload, err := encodeLedger(map[string]any{
		"schemaVersion": ledgerSchemaVersion,
		"global":        next.global,
		"providers":     next.providers,
	})
	if err != nil {
		return fmt.Errorf("编码升级账本失败: %w", err)
	}
	directory := filepath.Join(aiHomeDir, "run")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("创建升级账本目录失败: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".provider-cli-upgrade-*.tmp")
	if err != nil {
		return fmt.Errorf("创建升级账本临时文件失败: %w", err)
	}
	tempPath := temporary.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("设置升级账本权限失败: %w", err)
	}
	_, writeErr := temporary.Write(payload)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return fmt.Errorf("写入升级账本失败: %w", err)
	}
	if err := os.Rename(tempPath, filepath.Join(directory, ledgerFileName)); err != nil {
		return fmt.Errorf("替换升级账本失败: %w", err)
	}
	return nil
}

func encodeLedger(document map[string]any) ([]byte, error) {
	buffer := &bytes.Buffer{}
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

// channelPinnable 与 Node resolveChannelCapabilities(...).pinnable 同口径：
// 渠道能否钉版本决定 knownGoodRollbackable，进而决定闭环会不会动手。
func channelPinnable(channel string, provider string) bool {
	switch channel {
	case "standalone_release", "npm_global":
		return true
	case "vendor_selfupdate":
		return provider == "claude" || provider == "opencode"
	default:
		return false
	}
}
