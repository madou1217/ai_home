package accountprojection

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
)

// projectionLockTimeout 限制同一账号投影的等待时长：Prepare 只做目录/链接，
// 正常持锁是毫秒级；超时说明另一路卡死，宁可报错也不无限挂住会话。
const projectionLockTimeout = 30 * time.Second

// acquireProjectionLock 串行化同一 Provider 账号的投影读写。
//
// 多个 work 会话（用户发送、预热门、CLI 与 server 同时启动）会并发 Prepare 同一
// 个投影根，ensureSharedEntry 里的 rename/remove/建链不是原子操作，交错会让一侧
// 看到半成品（EEXIST/ENOENT/EPERM）。锁按账号隔离，不同账号的投影互不阻塞；
// 宿主侧共享目录的创建本身是幂等的。
func (provisioner *Provisioner) acquireProjectionLock(
	providerID string,
	accountRef string,
) (func(), error) {
	root := strings.TrimSpace(provisioner.aiHomeDir)
	if root == "" || !filepath.IsAbs(root) || strings.TrimSpace(accountRef) == "" {
		return nil, appprojection.ErrInvalidProjectionRoot
	}
	dir := filepath.Join(root, "run", "projection-locks")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	name := providerID + "-" + accountRef + ".lock"
	file, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(projectionLockTimeout)
	for {
		lockErr := tryLockFile(file)
		if lockErr == nil {
			return func() {
				unlockFile(file)
				_ = file.Close()
			}, nil
		}
		if !lockIsBusy(lockErr) {
			_ = file.Close()
			return nil, lockErr
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, fmt.Errorf("projection lock timeout: %s/%s", providerID, accountRef)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
