// Package deletionprojection 在账号数据库事实仍存在时收敛旧 Node 运行时投影。
//
// Go Native Direct 不创建账号级 HOME；该适配器只负责 Codex、Claude 已知的旧
// `$AIH_HOME/run` 投影，并在任何路径、身份或资源不确定时失败关闭。
package deletionprojection

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidOptions 表示删除准备适配器缺少固定数据根、凭据存储或时钟。
	ErrInvalidOptions = errors.New("账号投影删除准备配置无效")
	// ErrInvalidRequest 表示调用方没有提供有效账号快照或 Context。
	ErrInvalidRequest = errors.New("账号投影删除准备请求无效")
)

const (
	providerCodex  = "codex"
	providerClaude = "claude"
)

// Clock 返回凭据 CAS 使用的当前业务时间。
type Clock func() time.Time

// Options 保存删除准备适配器唯一允许的外部依赖。
type Options struct {
	// AIHomeDir 是 aih.db 与旧 Node run 目录所在的数据根。
	AIHomeDir string
	// HostHomeDir 是 Codex、Claude 共享 session/config 的原生用户目录。
	HostHomeDir string
	// Credentials 读取并 CAS 保存可能由旧 CLI 刷新的凭据。
	Credentials accountapp.CredentialVersionStore
	// Clock 只在需要保存较新 Codex OAuth 时使用。
	Clock Clock
}

// Preparer 先收敛 Provider 资源和凭据，再删除可证明属于目标账号的敏感投影。
type Preparer struct {
	aiHomeDir   string
	hostHomeDir string
	credentials accountapp.CredentialVersionStore
	clock       Clock
}

// New 创建只处理固定 Codex、Claude 投影合同的删除准备适配器。
func New(options Options) (*Preparer, error) {
	aiHomeDir, err := resolveExistingRoot(options.AIHomeDir)
	if err != nil {
		return nil, ErrInvalidOptions
	}
	hostHomeDir, err := resolveExistingRoot(options.HostHomeDir)
	if err != nil || options.Credentials == nil || options.Clock == nil {
		return nil, ErrInvalidOptions
	}
	return &Preparer{
		aiHomeDir:   aiHomeDir,
		hostHomeDir: hostHomeDir,
		credentials: options.Credentials,
		clock:       options.Clock,
	}, nil
}

// PrepareAccountDeletion 在数据库删除前完成幂等的凭据、资源和敏感投影收敛。
func (preparer *Preparer) PrepareAccountDeletion(
	ctx context.Context,
	account accountcore.Account,
) error {
	if preparer == nil ||
		preparer.credentials == nil ||
		preparer.clock == nil ||
		ctx == nil ||
		!account.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	roots, err := preparer.findProjectionRoots(account)
	if err != nil {
		return preparationFailure("校验投影固定路径", err)
	}
	if len(roots) == 0 {
		return nil
	}
	if account.ProviderID() != providerCodex && account.ProviderID() != providerClaude {
		return preparationFailure("Provider 投影合同未注册", nil)
	}
	if err := preparer.reconcileCredential(ctx, account, roots); err != nil {
		return preparationFailure("收敛投影凭据", err)
	}
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := preparer.reconcileResources(ctx, account, root); err != nil {
			return preparationFailure("收敛 Provider 资源", err)
		}
	}
	for _, root := range roots {
		exists, err := assertSafePathFromRoot(preparer.aiHomeDir, root.path)
		if err != nil || !exists {
			if err == nil {
				err = fmt.Errorf("投影根在清理前消失")
			}
			return preparationFailure("重新校验敏感投影", err)
		}
		if err := removeProjectionRoot(root.path); err != nil {
			return preparationFailure("删除敏感投影", err)
		}
	}
	return nil
}

// projectionKind 区分标准 auth projection 与 Codex Desktop 的 CODEX_HOME 根。
type projectionKind uint8

const (
	projectionKindAccount projectionKind = iota + 1
	projectionKindCodexDesktop
)

type projectionRoot struct {
	path string
	kind projectionKind
}

func (preparer *Preparer) findProjectionRoots(
	account accountcore.Account,
) ([]projectionRoot, error) {
	providerID := account.ProviderID()
	accountRef := account.Ref().String()
	candidates := []projectionRoot{{
		path: filepath.Join(
			preparer.aiHomeDir,
			"run",
			"auth-projections",
			providerID,
			accountRef,
		),
		kind: projectionKindAccount,
	}}
	if providerID == providerCodex {
		candidates = append(candidates, projectionRoot{
			path: filepath.Join(
				preparer.aiHomeDir,
				"run",
				"codex-desktop",
				accountRef,
			),
			kind: projectionKindCodexDesktop,
		})
	}

	roots := make([]projectionRoot, 0, len(candidates))
	for _, candidate := range candidates {
		exists, err := assertSafePathFromRoot(preparer.aiHomeDir, candidate.path)
		if err != nil {
			return nil, err
		}
		if exists {
			roots = append(roots, candidate)
		}
	}
	return roots, nil
}

func resolveExistingRoot(value string) (string, error) {
	root := strings.TrimSpace(value)
	if root == "" || !filepath.IsAbs(root) {
		return "", ErrInvalidOptions
	}
	realRoot, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(realRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", ErrInvalidOptions
	}
	return realRoot, nil
}

// assertSafePathFromRoot 拒绝内部任一 symlink，避免固定删除路径穿出 AIH_HOME。
func assertSafePathFromRoot(root string, target string) (bool, error) {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return false, ErrInvalidRequest
	}
	current := root
	segments := strings.Split(relative, string(filepath.Separator))
	for index, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false, ErrInvalidRequest
		}
		current = filepath.Join(current, segment)
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return false, nil
		}
		if statErr != nil {
			return false, statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("固定路径包含 symlink")
		}
		if index < len(segments)-1 && !info.IsDir() {
			return false, fmt.Errorf("固定路径父级不是目录")
		}
		if index == len(segments)-1 && !info.IsDir() {
			return false, fmt.Errorf("投影根不是目录")
		}
	}
	return true, nil
}

func removeProjectionRoot(root string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("投影根形态发生变化")
	}
	return os.RemoveAll(root)
}

func assertPlainDirectory(directoryPath string) error {
	info, err := os.Lstat(directoryPath)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("目录形态不受信任")
	}
	return nil
}

func preparationFailure(stage string, cause error) error {
	if cause == nil {
		return fmt.Errorf("%w: %s", accountapp.ErrAccountDeletionPreparationFailed, stage)
	}
	return fmt.Errorf(
		"%w: %s: %w",
		accountapp.ErrAccountDeletionPreparationFailed,
		stage,
		cause,
	)
}

var _ accountapp.DeletionPreparation = (*Preparer)(nil)
