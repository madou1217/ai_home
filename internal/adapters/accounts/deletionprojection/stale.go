package deletionprojection

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// StaleRootKindAccount 表示标准 run/auth-projections/<provider>/<accountRef> 投影根。
	StaleRootKindAccount = "auth-projections"
	// StaleRootKindCodexDesktop 表示 Codex Desktop run/codex-desktop/<accountRef> 投影根。
	StaleRootKindCodexDesktop = "codex-desktop"
)

// ReconcileStaleProjectionRoot 在数据库账号事实已被删除后，清理投影前先将 spec 允许的
// 共享资源（如未链接的 sessions/plans）安全迁回宿主 HOME；私有凭据不采纳，只由
// 调用方在返回 nil 后删除投影目录。任何未知资源或越界 symlink 都会失败关闭。
func ReconcileStaleProjectionRoot(
	ctx context.Context,
	aiHomeDir string,
	hostHomeDir string,
	providerID string,
	rootKind string,
	projectionPath string,
) error {
	if ctx == nil {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	resolvedAIHome, err := resolveExistingRoot(aiHomeDir)
	if err != nil {
		return ErrInvalidOptions
	}
	resolvedHostHome, err := resolveExistingRoot(hostHomeDir)
	if err != nil {
		return ErrInvalidOptions
	}
	provider := strings.ToLower(strings.TrimSpace(providerID))
	kind := projectionKindAccount
	switch strings.TrimSpace(rootKind) {
	case "", StaleRootKindAccount:
		kind = projectionKindAccount
	case StaleRootKindCodexDesktop:
		kind = projectionKindCodexDesktop
		provider = providerCodex
	default:
		return ErrInvalidRequest
	}
	spec, found := projectionSpecFor(provider)
	if !found {
		return fmt.Errorf("Provider %s 投影合同未注册，拒绝盲删陈旧投影", provider)
	}
	if _, hasRootSpec := spec.roots[kind]; !hasRootSpec {
		return fmt.Errorf("Provider %s 缺少对应投影根规格，拒绝盲删陈旧投影", provider)
	}
	// macOS 测试或运行目录常经 /var -> /private/var 软链；只规范化父级再拼回最后一级，
	// 让 assertSafePathFromRoot 仍能检验投影目录本身不是 symlink。
	cleanProjection := filepath.Clean(strings.TrimSpace(projectionPath))
	parentResolved, err := filepath.EvalSymlinks(filepath.Dir(cleanProjection))
	if err != nil {
		return fmt.Errorf("解析陈旧投影父目录失败: %w", err)
	}
	candidate := filepath.Join(parentResolved, filepath.Base(cleanProjection))
	exists, err := assertSafePathFromRoot(resolvedAIHome, candidate)
	if err != nil {
		return fmt.Errorf("校验陈旧投影安全路径失败: %w", err)
	}
	if !exists {
		return nil
	}
	if err := assertPlainDirectory(candidate); err != nil {
		return err
	}
	entries, err := os.ReadDir(candidate)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := reconcileStaleEntry(ctx, resolvedHostHome, provider, kind, candidate, []string{entry.Name()}); err != nil {
			return err
		}
	}
	return nil
}

func reconcileStaleEntry(
	ctx context.Context,
	hostHomeDir string,
	providerID string,
	kind projectionKind,
	rootPath string,
	relative []string,
) error {
	classification := classifyProjectionEntry(providerID, kind, relative)
	sourcePath := filepath.Join(append([]string{rootPath}, relative...)...)
	info, err := os.Lstat(sourcePath)
	if err != nil {
		return err
	}
	switch classification.kind {
	case projectionEntryPrivate:
		return nil
	case projectionEntryContainer:
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("陈旧投影容器形态不受信任")
		}
		entries, err := os.ReadDir(sourcePath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			next := append(append([]string(nil), relative...), entry.Name())
			if err := reconcileStaleEntry(ctx, hostHomeDir, providerID, kind, rootPath, next); err != nil {
				return err
			}
		}
		return nil
	case projectionEntryResource:
		destinationRoot := filepath.Join(append([]string{hostHomeDir}, classification.hostRoot...)...)
		if err := ensureSafeDirectory(hostHomeDir, classification.hostRoot); err != nil {
			return err
		}
		destinationPath := filepath.Join(append([]string{destinationRoot}, classification.destination...)...)
		return migrateResource(ctx, destinationRoot, sourcePath, destinationPath)
	default:
		return fmt.Errorf("陈旧投影包含未注册的 Provider 资源: %s", filepath.Join(relative...))
	}
}
