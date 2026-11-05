package aihserver

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/transport/http/zcoderelay"
)

// zcodeHarnessStoreFile 是 Node 侧学习到的官方 harness 快照（账号无关）。
const zcodeHarnessStoreFile = "zcode-harness-system.json"

// loadZcodeHostFacts 读取 zcode 宿主事实：官方 harness 与客户端版本。
//
// 读不到就返回零值（fail-soft）：relay 仍可工作，只是没有 harness 整形——
// 上游会按 3012 拒绝，这与 Node 在「没有学到 harness」时的行为一致。
func loadZcodeHostFacts(aiHomeDir string) zcoderelay.HostFacts {
	facts := zcoderelay.HostFacts{AIHomeDir: aiHomeDir}
	if aiHomeDir == "" {
		return facts
	}
	data, err := os.ReadFile(filepath.Join(aiHomeDir, "run", zcodeHarnessStoreFile))
	if err != nil {
		return facts
	}
	var profile struct {
		AppVersion string           `json:"appVersion"`
		Blocks     []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(data, &profile); err != nil {
		return facts
	}
	facts.AppVersion = profile.AppVersion
	facts.HarnessBlocks = profile.Blocks
	return facts
}
