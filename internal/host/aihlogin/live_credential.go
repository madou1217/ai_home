package aihlogin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

// credentialArtifact 是 auth 目录里一个 .info 文件的路径和版本标记。
type credentialArtifact struct {
	path    string
	modTime time.Time
	size    int64
}

func (artifact credentialArtifact) unchanged(from credentialArtifact) bool {
	return artifact.modTime.Equal(from.modTime) && artifact.size == from.size
}

// authDirectory 返回一次性投影里官方 CLI 写共享登录凭据的目录。
func authDirectory(root string) string {
	return filepath.Join(append([]string{root}, codebuddyfamilystorage.AuthDirSegments(runtime.GOOS)...)...)
}

// scanCredentialArtifacts 列出 auth 目录里全部 .info；目录缺失时返回空。
func scanCredentialArtifacts(root string) []credentialArtifact {
	entries, err := os.ReadDir(authDirectory(root))
	if err != nil {
		return nil
	}
	artifacts := make([]credentialArtifact, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".info") {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		artifacts = append(artifacts, credentialArtifact{
			path:    filepath.Join(authDirectory(root), entry.Name()),
			modTime: info.ModTime(),
			size:    info.Size(),
		})
	}
	sort.Slice(artifacts, func(left, right int) bool {
		return artifacts[left].modTime.After(artifacts[right].modTime)
	})
	return artifacts
}

// snapshotCredentialArtifacts 记录登录开始前已有的文件，避免把投影里
// 的历史凭据当成这次登录的结果。
func snapshotCredentialArtifacts(root string) map[string]credentialArtifact {
	artifacts := scanCredentialArtifacts(root)
	stamps := make(map[string]credentialArtifact, len(artifacts))
	for _, artifact := range artifacts {
		stamps[artifact.path] = artifact
	}
	return stamps
}

// startCredentialWatcher 在官方 CLI 仍运行时轮询共享 auth 目录。
//
// 浏览器授权完成后 CLI 会立即写出 .info 并进入交互会话；如果只在 CLI 退出后
// 才导入，用户会看到「当前会话已登录，但新窗口/WebUI 仍要求重新登录」。
// 这里一旦发现新出现或刚更新的 .info 就注册账号，让账号库和 WebUI 立即
// 跟上，而不改变 CLI 自己的登录体验。
//
// 返回的 stop 会结束轮询并等待正在进行的注册完成，可安全重复调用。
func startCredentialWatcher(
	ctx context.Context,
	providerID string,
	root string,
	baseline map[string]credentialArtifact,
	register func(context.Context, accountapp.Credential, accountapp.PublicProfile) (accountcore.Account, error),
	onRegistered func(accountcore.Account),
) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	var stopOnce sync.Once
	seen := make(map[string]credentialArtifact, len(baseline))
	for path, artifact := range baseline {
		seen[path] = artifact
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			for _, artifact := range scanCredentialArtifacts(root) {
				if previous, found := seen[artifact.path]; found && artifact.unchanged(previous) {
					continue
				}
				credential, profile, err := readCredentialArtifact(providerID, artifact.path)
				if err != nil {
					// CLI 可能正在写文件；下一轮再试。
					continue
				}
				registerCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
				account, registerErr := register(registerCtx, credential, profile)
				cancel()
				if registerErr != nil {
					continue
				}
				seen[artifact.path] = artifact
				if onRegistered != nil {
					onRegistered(account)
				}
			}
		}
	}()
	return func() {
		stopOnce.Do(func() { close(stop) })
		<-done
	}
}
