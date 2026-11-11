package aihserver

import (
	"errors"
	"os"
	"path/filepath"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// renameAuthProjectionDir 把账号的运行投影目录改名到新的 AccountRef。
//
// 账号身份变化（例如 agy 的 id_token 邮箱变了）会迁移账号引用；投影目录按
// 引用命名，必须一起搬，否则新引用启动时丢掉工作区，旧目录还留着旧令牌。
// 目标目录已经存在说明宿主已经物化过新身份，保持不动，避免覆盖更新的文件。
func renameAuthProjectionDir(
	aiHomeDir string,
	providerID string,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	if aiHomeDir == "" || providerID == "" ||
		!previous.IsValid() || !current.IsValid() || previous == current {
		return nil
	}
	root := filepath.Join(aiHomeDir, "run", "auth-projections", providerID)
	from := filepath.Join(root, previous.String())
	info, err := os.Stat(from)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return nil
	}
	to := filepath.Join(root, current.String())
	if _, err := os.Stat(to); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(from, to)
}
