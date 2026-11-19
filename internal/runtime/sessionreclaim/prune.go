package sessionreclaim

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// tmuxServerRunning 判断某个 socket 下是否还有 tmux 服务在跑。
func tmuxServerRunning(ctx context.Context, socket string) bool {
	_, err := runShort(ctx, "tmux", "-L", socket, "list-sessions")
	return err == nil
}

// PruneStale 删除指向"已经不存在的 tmux 会话"的注册表条目。
//
// 这是 supervisor 异常退出留下的空壳：会话已经没了，条目还占着注册表。
// 只删同时满足两个条件的条目：
//   - tmux 明确报 no such session（不是"没查到"，命令失败一律不删）；
//   - 文件最后修改时间早于 minAge，避免和正在恢复的会话抢。
func PruneStale(ctx context.Context, aiHomeDir string, minAge time.Duration) (int, error) {
	dir := filepath.Join(aiHomeDir, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if minAge <= 0 {
		minAge = 10 * time.Minute
	}
	removed := 0
	now := time.Now()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		info, statErr := entry.Info()
		if statErr != nil || now.Sub(info.ModTime()) < minAge {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Clean(path))
		if readErr != nil {
			continue
		}
		var session Session
		if json.Unmarshal(raw, &session) != nil || session.Socket == "" || session.Name == "" {
			continue
		}
		if tmuxSessionAlive(ctx, session.Socket, session.Name) {
			continue
		}
		// 只有在"tmux 服务还在、但这个会话不在了"时才算空壳。
		// 整个 tmux 服务都没了属于重启场景，注册表正是 restore 的依据，必须保留。
		if !tmuxServerRunning(ctx, session.Socket) {
			continue
		}
		if err := os.Remove(path); err == nil {
			removed++
		}
	}
	return removed, nil
}
