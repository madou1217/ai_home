package distributioninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func ReadReceipt(home string) (Receipt, error) {
	var r Receipt
	raw, err := os.ReadFile(receiptPath(home))
	if err != nil {
		return r, err
	}
	if len(raw) > 64*1024 || json.Unmarshal(raw, &r) != nil || r.Version != 1 || r.Home != filepath.Clean(home) || r.State != "installed" {
		return r, errors.New("distribution_installation_unverified")
	}
	return r, nil
}

// ApplyVerifiedArtifact is executed by a detached native update worker, never
// by the old daemon that it must stop. The release service verified bytes/hash.
func ApplyVerifiedArtifact(ctx context.Context, home, artifact string) error {
	receipt, err := ReadReceipt(home)
	if err != nil {
		return err
	}
	if filepath.Dir(artifact) != filepath.Join(home, "updates", "downloads") {
		return errors.New("update_artifact_path_untrusted")
	}
	if err = os.Chmod(artifact, 0700); err != nil {
		return err
	}
	extract := exec.CommandContext(ctx, artifact, "help")
	extract.Env = append(os.Environ(), "AIH_HOME_DIR="+home, "AIH_PKG_EXTRACT_ONLY=1")
	raw, err := extract.Output()
	if err != nil {
		return fmt.Errorf("发行包解包失败: %w", err)
	}
	root := strings.TrimSpace(string(raw))
	canonicalRoot, err := canonical(root)
	if err != nil || !within(filepath.Join(home, "pkg"), canonicalRoot) {
		return errors.New("update_extracted_package_untrusted")
	}
	build, err := ReadBuild(canonicalRoot)
	if err != nil {
		return err
	}
	if build.Version == receipt.ReleaseVersion {
		return errors.New("新版本与当前版本相同")
	}
	cmd := exec.CommandContext(ctx, bundleServer(canonicalRoot), "__distribution-install", "--home", home, "--host-home", receipt.HostHome, "--package-root", canonicalRoot, "--launcher", artifact, "--bin-dir", filepath.Dir(receipt.Launcher))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	return cmd.Run()
}

// StartDetachedApply hands ownership to an installer outside the managed service
// process group. Success here means only handed-off, never installed.
func StartDetachedApply(ctx context.Context, home, artifact string) error {
	receipt, err := ReadReceipt(home)
	if err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	logDir := filepath.Join(home, "logs", "services")
	if err = os.MkdirAll(logDir, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(logDir, "distribution-update.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(receipt.Executable, "__distribution-apply", "--home", home, "--artifact", artifact)
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = log
	cmd.Stderr = log
	return startDetached(cmd, home)
}
func waitApplyContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 20*time.Minute)
}
