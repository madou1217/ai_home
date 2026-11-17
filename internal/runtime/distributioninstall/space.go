package distributioninstall

import (
	"fmt"
	"os"
	"path/filepath"
)

// Preparation retains byte snapshots, SQLite backups, scratch and prepared
// databases. Refuse BEFORE stopping the service with room for rollback and WAL.
func checkSpace(o Options) error {
	var source uint64
	for _, name := range dataFiles {
		info, err := os.Lstat(filepath.Join(o.Home, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("无法确认数据大小，未停止服务: %w", err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("数据路径不受信任，未停止服务: %s", name)
		}
		source += uint64(info.Size())
	}
	reserve := source*6 + (512 << 20)
	free, err := freeSpace(o.Home)
	if err != nil {
		return fmt.Errorf("无法确认更新空间，未停止服务: %w", err)
	}
	history := transactionRoot(o.Home)
	check := history
	if _, err := os.Stat(check); os.IsNotExist(err) {
		check = filepath.Dir(check)
	} else if err != nil {
		return fmt.Errorf("无法确认备份位置空间，未停止服务: %w", err)
	}
	backupFree, err := freeSpace(check)
	if err != nil {
		return fmt.Errorf("无法确认备份位置空间，未停止服务: %w", err)
	}
	if backupFree < reserve {
		return fmt.Errorf("备份位置空间不足：需要至少 %.1f GiB，当前 %.1f GiB；原服务与数据未变更", float64(reserve)/(1<<30), float64(backupFree)/(1<<30))
	}
	if free < reserve {
		return fmt.Errorf("更新空间不足：需要至少 %.1f GiB，当前 %.1f GiB；原服务与数据未变更", float64(reserve)/(1<<30), float64(free)/(1<<30))
	}
	return nil
}
