package edgeproxy

import (
	"context"
	"strings"
)

// RemoveFrp 从 frpc 配置中移除受管条目（name 与 name-udp），并在可行时重载 frpc。
func (s *Service) RemoveFrp(ctx context.Context, name string, reload bool) (*ApplyResult, *EdgeError) {
	env := s.resolveEnv()
	configPath := s.resolveFrpConfigPath(env)
	if configPath == "" {
		return nil, &EdgeError{Code: "edge_frpc_config_missing", Message: "找不到 frpc 配置；用 AIH_EDGE_CONTEXT 的 frpcConfig 指定"}
	}
	before, err := s.fs.ReadFile(configPath)
	if err != nil {
		return nil, &EdgeError{Code: "edge_frpc_config_unreadable", Message: err.Error()}
	}
	entryName := strings.TrimSpace(name)
	if entryName == "" {
		entryName = "aih-server"
	}
	next := RemoveFrpProxy(string(before), entryName)
	next = RemoveFrpProxy(next, entryName+"-udp")
	result := &ApplyResult{OK: true, Provider: "frpc", ConfigPath: configPath}
	if next == string(before) {
		result.Summary = "没有找到受管条目 " + entryName
		return result, nil
	}
	backupPath, writeErr := s.writeAtomic(configPath, []byte(next), true)
	if writeErr != nil {
		return nil, &EdgeError{Code: "edge_config_write_failed", Message: writeErr.Error()}
	}
	result.BackupPath = backupPath
	result.Entries = []FrpEntry{{Name: entryName}}
	result.Summary = "已移除 frpc 条目 " + entryName
	if reload {
		reloaded, via, detail, hint := s.reloadFrp(ctx, env)
		result.Reloaded = reloaded
		result.ReloadedVia = via
		result.Detail = detail
		result.Hint = hint
	}
	return result, nil
}
