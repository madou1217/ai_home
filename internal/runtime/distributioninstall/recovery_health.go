package distributioninstall

import (
	"context"
	"errors"
	"os"
	"time"
)

// verifyRestored is shared by every rollback path, including failures during
// stopping. A task acknowledgement or a listening socket is not recovery.
func verifyRestored(ctx context.Context, o Options, saved serviceSnapshot) error {
	if !saved.Running {
		return nil
	}
	receipt, err := ReadReceipt(o.Home)
	if err == nil {
		if !sameInstallPath(receipt.Home, o.Home) {
			return errors.New("原版本安装身份不匹配")
		}
		restored := o
		restored.PackageRoot = receipt.PackageRoot
		build, err := ReadBuild(receipt.PackageRoot)
		if err != nil || build.GoCore.SHA256 != receipt.BinarySHA256 || build.Version != receipt.ReleaseVersion || build.SourceSHA != receipt.SourceSHA || !sameInstallPath(bundleServer(receipt.PackageRoot), receipt.Executable) {
			return errors.New("原版本安装记录未通过验证，完整备份已保留")
		}
		if err := verifyStarted(ctx, restored, build); err != nil {
			return err
		}
		return verifyRunningCommitted(ctx, restored, build)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	c := readConfig(o.Home)
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	for {
		ready, status, err := getLocal(ctx, c, "/readyz")
		if err == nil && status == 200 && ready["ok"] == true {
			accounts, code, err := getLocal(ctx, c, "/v0/webui/accounts")
			if err == nil && code == 200 && accounts["ok"] == true {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("原版本数据已恢复，但旧服务尚未通过业务启动检查")
		case <-time.After(300 * time.Millisecond):
		}
	}
}
