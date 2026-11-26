// Package accountprojection 执行 Provider 账号投影：目录、共享链接、auth artifact
// 原子写入和退出后的凭据回写。
//
// 它不认 Provider 名：Provider 差异由 application/accountprojection 的 Policy 与
// Materializer 适配器提供。P3.1 首个适配器是 Codex。
package accountprojection

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/sharedcache"
	"github.com/madou1217/ai_home/internal/runtime/spacegc"
)

// Options 是投影执行器的依赖。
type Options struct {
	AIHomeDir     string
	Policies      appprojection.PolicyProvider
	Materializers []appprojection.Materializer
	Linker        appprojection.Linker
	Credentials   accountapp.CredentialVersionStore
	Now           func() time.Time
	// HomeRoots 是所有 CLI 在 HOME 下的根目录（Provider 合同推导，HOME 相对段）。
	// fake HOME 里出现其它 CLI 的根目录时，投影默认把它指回宿主。
	HomeRoots [][]string
}

// Provisioner 是 application/accountprojection.Provisioner 的通用实现。
type Provisioner struct {
	aiHomeDir     string
	policies      appprojection.PolicyProvider
	materializers map[string]appprojection.Materializer
	linker        appprojection.Linker
	credentials   accountapp.CredentialVersionStore
	now           func() time.Time
	homeRoots     [][]string
}

var _ appprojection.Provisioner = (*Provisioner)(nil)

// New 创建投影执行器；Policies/Linker 必填，Materializers 至少一个。
func New(options Options) (*Provisioner, error) {
	if options.Policies == nil || options.Linker == nil || len(options.Materializers) == 0 {
		return nil, appprojection.ErrInvalidProjectionRequest
	}
	materials := make(map[string]appprojection.Materializer, len(options.Materializers))
	for _, materializer := range options.Materializers {
		if materializer == nil || strings.TrimSpace(materializer.ProviderID()) == "" {
			return nil, appprojection.ErrInvalidProjectionRequest
		}
		providerID := providerruntime.NormalizeProvider(materializer.ProviderID())
		if _, exists := materials[providerID]; exists {
			return nil, appprojection.ErrInvalidProjectionRequest
		}
		materials[providerID] = materializer
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Provisioner{
		aiHomeDir:     strings.TrimSpace(options.AIHomeDir),
		policies:      options.Policies,
		materializers: materials,
		linker:        options.Linker,
		credentials:   options.Credentials,
		now:           now,
		homeRoots:     clonePathSegments(options.HomeRoots),
	}, nil
}

// Prepare 创建/复用投影、建立共享链接并物化 auth artifact。
func (provisioner *Provisioner) Prepare(
	ctx context.Context,
	request appprojection.Request,
) (appprojection.Result, error) {
	if provisioner == nil || ctx == nil || request.AccountRef == "" ||
		!request.AccountRef.IsValid() || strings.TrimSpace(request.HostHomeDir) == "" {
		return appprojection.Result{}, appprojection.ErrInvalidProjectionRequest
	}
	if err := ctx.Err(); err != nil {
		return appprojection.Result{}, err
	}
	providerID := providerruntime.NormalizeProvider(request.ProviderID)
	policy, materializer, err := provisioner.resolve(providerID)
	if err != nil {
		return appprojection.Result{}, err
	}
	if !request.ProjectionRequired || policy.Mode == appprojection.ModeNone {
		return appprojection.Result{
			Root:     strings.TrimSpace(request.RuntimeDir),
			Mode:     policy.Mode,
			PolicyID: providerID,
		}, nil
	}
	release, err := provisioner.acquireProjectionLock(providerID, request.AccountRef.String())
	if err != nil {
		return appprojection.Result{}, err
	}
	defer release()
	root, err := provisioner.ensureRoot(request, providerID)
	if err != nil {
		return appprojection.Result{}, err
	}
	if err := provisioner.applyProjection(request, policy, root); err != nil {
		return appprojection.Result{}, err
	}
	if request.Purpose != appprojection.PurposeLogin {
		if request.Credential == nil {
			return appprojection.Result{}, appprojection.ErrInvalidProjectionRequest
		}
		writes, err := materializer.Materialize(ctx, request, policy, root)
		if err != nil {
			return appprojection.Result{}, err
		}
		for _, write := range writes {
			if err := provisioner.writeArtifact(root, write); err != nil {
				return appprojection.Result{}, err
			}
		}
	}
	env, err := resolveEnv(policy.Env, root, request.HostHomeDir, policy.NativeRoot)
	if err != nil {
		return appprojection.Result{}, err
	}
	if policy.Mode == appprojection.ModeFakeHome {
		// 工具链缓存变量与链接同源：策略可覆盖，但默认全部指向宿主。
		merged := make(map[string]string, len(env)+16)
		for key, value := range sharedcache.Env(request.HostHomeDir, runtime.GOOS) {
			merged[key] = value
		}
		for key, value := range env {
			merged[key] = value
		}
		env = merged
	}
	return appprojection.Result{
		Root:     root,
		Mode:     policy.Mode,
		PolicyID: providerID,
		SetEnv:   env,
	}, nil
}

// Capture 把投影里被客户端续期的凭据按代际和 CAS 写回账号库。
func (provisioner *Provisioner) Capture(
	ctx context.Context,
	request appprojection.Request,
	result appprojection.Result,
) error {
	if provisioner == nil || ctx == nil || !request.ProjectionRequired {
		return nil
	}
	providerID := providerruntime.NormalizeProvider(request.ProviderID)
	policy, materializer, err := provisioner.resolve(providerID)
	if err != nil {
		return err
	}
	if policy.Mode == appprojection.ModeNone {
		return nil
	}
	root := strings.TrimSpace(result.Root)
	if root == "" {
		return appprojection.ErrInvalidProjectionRoot
	}
	release, err := provisioner.acquireProjectionLock(providerID, request.AccountRef.String())
	if err != nil {
		return err
	}
	defer release()
	next, changed, err := materializer.Capture(ctx, request, policy, root)
	if err != nil || !changed || next == nil {
		return err
	}
	if provisioner.credentials == nil {
		return appprojection.ErrCredentialStoreUnavailable
	}
	snapshot, err := provisioner.credentials.GetCredentialSnapshot(ctx, request.AccountRef)
	if err != nil {
		return err
	}
	if snapshot.ProviderID() != providerID || !materializer.ShouldAdopt(snapshot.Credential(), next) {
		return nil
	}
	updatedAt := provisioner.now().UTC()
	if !updatedAt.After(snapshot.UpdatedAt()) {
		updatedAt = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, next, updatedAt)
	if err != nil {
		return err
	}
	return provisioner.credentials.ReplaceCredential(ctx, replacement)
}

// Remove 只删除 auth-projections 下与 provider/accountRef 精确匹配的目录。
func (provisioner *Provisioner) Remove(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) error {
	if provisioner == nil || ctx == nil || provisioner.aiHomeDir == "" ||
		!accountRef.IsValid() {
		return appprojection.ErrInvalidProjectionRequest
	}
	normalized := providerruntime.NormalizeProvider(providerID)
	root, err := provisioner.expectedRoot(normalized, accountRef)
	if err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return appprojection.ErrInvalidProjectionRoot
	}
	return os.RemoveAll(root)
}

func (provisioner *Provisioner) resolve(providerID string) (appprojection.Policy, appprojection.Materializer, error) {
	policy, ok := provisioner.policies.Policy(providerID)
	if !ok {
		return appprojection.Policy{}, nil, appprojection.ErrInvalidProjectionRequest
	}
	if err := policy.Validate(); err != nil {
		return appprojection.Policy{}, nil, err
	}
	materializer, ok := provisioner.materializers[providerID]
	if !ok {
		return appprojection.Policy{}, nil, appprojection.ErrInvalidProjectionRequest
	}
	return policy, materializer, nil
}

func (provisioner *Provisioner) ensureRoot(
	request appprojection.Request,
	providerID string,
) (string, error) {
	expected, err := provisioner.expectedRoot(providerID, request.AccountRef)
	if err != nil {
		return "", err
	}
	// RuntimeDir 为空表示由投影层按 AIH_HOME/账号引用推导；显式给出时必须与
	// 推导结果完全一致，避免调用方把凭据写到别的账号目录。
	actual := expected
	if requested := strings.TrimSpace(request.RuntimeDir); requested != "" {
		actual = filepath.Clean(requested)
		if !samePath(expected, actual) {
			return "", fmt.Errorf("%w: want %s, got %s", appprojection.ErrInvalidProjectionRoot, expected, actual)
		}
	}
	if err := os.MkdirAll(actual, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(actual)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", appprojection.ErrInvalidProjectionRoot
	}
	if err := os.Chmod(actual, 0o700); err != nil {
		return "", err
	}
	return actual, nil
}

func (provisioner *Provisioner) expectedRoot(
	providerID string,
	accountRef accountcore.AccountRef,
) (string, error) {
	base := strings.TrimSpace(provisioner.aiHomeDir)
	if base == "" || !filepath.IsAbs(base) || !accountRef.IsValid() {
		return "", appprojection.ErrInvalidProjectionRoot
	}
	root := filepath.Join(base, "run", "auth-projections", providerID, accountRef.String())
	root = providerruntime.ResolveCLIAuthProjectionDir(root, providerID)
	if !pathWithin(filepath.Join(base, "run", "auth-projections"), root) {
		return "", appprojection.ErrInvalidProjectionRoot
	}
	return filepath.Clean(root), nil
}

func (provisioner *Provisioner) applyProjection(
	request appprojection.Request,
	policy appprojection.Policy,
	root string,
) error {
	for _, mapping := range policy.ProjectionRoots {
		sourceRoot, err := joinUnder(root, mapping.From)
		if err != nil {
			return err
		}
		hostRoot, err := joinUnder(request.HostHomeDir, mapping.To)
		if err != nil {
			return err
		}
		if err := prepareMappingRoot(sourceRoot, hostRoot); err != nil {
			return err
		}
		if err := os.MkdirAll(hostRoot, 0o700); err != nil {
			return err
		}
		for _, name := range policy.PrecreatedDirectories {
			target := filepath.Join(hostRoot, name)
			if err := ensurePrecreatedDirectory(target); err != nil {
				return err
			}
		}
		for _, name := range policy.SharedEntries {
			if err := provisioner.ensureSharedEntry(
				sourceRoot,
				hostRoot,
				name,
				contains(policy.SessionEntries, name),
			); err != nil {
				return err
			}
		}
	}
	if err := provisioner.applyDefaultHostLinks(request, policy, root); err != nil {
		return err
	}
	if err := provisioner.applyHostLinks(request, policy, root); err != nil {
		return err
	}
	return nil
}

// applyDefaultHostLinks 把工具链缓存（.cache/go/.npm/...）统一链回宿主。
//
// 这是所有 fake HOME 的默认行为，不依赖 Provider 策略逐项声明：账号只隔离凭据，
// 缓存与工具链产物全机器一份。纯缓存路径允许接管历史真实目录（Node 原行为），
// 其余（.local/bin、.local/state）只建链、不删除客户端数据。
func (provisioner *Provisioner) applyDefaultHostLinks(
	request appprojection.Request,
	policy appprojection.Policy,
	root string,
) error {
	if policy.Mode != appprojection.ModeFakeHome {
		return nil
	}
	for _, link := range sharedcache.Links(runtime.GOOS) {
		target, err := joinUnder(request.HostHomeDir, link.Host)
		if err != nil {
			return err
		}
		source, err := joinUnder(root, link.Projection)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(target, 0o700); err != nil {
			return err
		}
		// 父目录若已经是宿主共享链接（例如旧 Node 把 .local/share 整体链走），
		// 叶子天然就共享了；不能再对链接指向的宿主目录做接管/删除。
		if resolvedParent, resolveErr := filepath.EvalSymlinks(filepath.Dir(source)); resolveErr == nil &&
			!pathWithin(root, resolvedParent) {
			continue
		}
		info, statErr := os.Lstat(source)
		if statErr == nil {
			if provisioner.linker.IsManaged(source, target) {
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				// 无主链接：缓存可安全替换；其余保持现场。
				if !link.Takeover {
					continue
				}
				if err := os.Remove(source); err != nil {
					return err
				}
			} else if link.Takeover {
				// 历史真实缓存副本：删除后建链，由宿主一份统一承载。
				// CLI 自更新目录里是只读的文件/目录，直接 RemoveAll 会 EPERM；
				// 删除失败只跳过这一条，不能阻断整个启动。
				if err := removeForTakeover(source); err != nil {
					continue
				}
			} else {
				continue
			}
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return statErr
		}
		if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
			return err
		}
		if err := provisioner.linkShared(source, target, true); err != nil {
			return err
		}
	}
	if err := provisioner.applyCrossCLIHostLinks(request, policy, root); err != nil {
		return err
	}
	if err := provisioner.applyDedupeLinks(request, policy, root); err != nil {
		return err
	}
	return nil
}

// applyCrossCLIHostLinks 把 fake HOME 里「别的 CLI 的 HOME 根目录」默认链回宿主。
//
// 账号沙箱只隔离本账号的凭据与会话；.codex、.claude、.gemini、
// .local/share/opencode 这些目录属于跨 CLI 共享状态，全机只应有宿主这一份。
// 投影里历史遗留的真实目录先把宿主缺的内容并到宿主（宿主已有的同名条目一律
// 以宿主为准），再换成宿主链接，避免数据只留在一个账号的投影里。
func (provisioner *Provisioner) applyCrossCLIHostLinks(
	request appprojection.Request,
	policy appprojection.Policy,
	root string,
) error {
	if policy.Mode != appprojection.ModeFakeHome || len(provisioner.homeRoots) == 0 {
		return nil
	}
	own := ownHomeRoots(policy)
	crossCLILinkMu.Lock()
	defer crossCLILinkMu.Unlock()
	for _, segments := range provisioner.homeRoots {
		if homeRootInsideOwn(segments, own) {
			continue
		}
		source, err := joinUnder(root, segments)
		if err != nil {
			return err
		}
		target, err := joinUnder(request.HostHomeDir, segments)
		if err != nil {
			return err
		}
		// 父目录是投影外的共享链接（旧 Node 把 .local/share、.config 整体链走）时，
		// 叶子会被所有账号共用。链接要落在这个宿主侧父目录里，才能改到唯一的实体；
		// 父目录本身就指向宿主同名目录时两者是同一位置，建链是幂等空操作。
		if resolvedParent, resolveErr := filepath.EvalSymlinks(filepath.Dir(source)); resolveErr == nil &&
			!pathWithin(root, resolvedParent) {
			source = filepath.Join(resolvedParent, filepath.Base(source))
		}
		if err := provisioner.ensureHostAuthorityLink(source, target); err != nil {
			// 跨 CLI 目录是共享状态的收口，不是本账号启动的必需依赖：合并失败时
			// 保留投影里的本地副本，下次 Prepare 再试，不能因此挡住 CLI 启动。
			continue
		}
	}
	return nil
}

// crossCLILinkMu 串行化同一进程内的跨 CLI 链接改写：多个账号并发 Prepare 时
// 可能同时命中同一个旧运行 home 的叶子，避免「刚合并完又被另一个协程删掉」。
var crossCLILinkMu sync.Mutex

// ownHomeRoots 返回本账号自己的 HOME 根目录：原生根与投影根映射的 From。
func ownHomeRoots(policy appprojection.Policy) [][]string {
	roots := make([][]string, 0, 1+len(policy.ProjectionRoots))
	if len(policy.NativeRoot) > 0 {
		roots = append(roots, policy.NativeRoot)
	}
	for _, mapping := range policy.ProjectionRoots {
		if len(mapping.From) > 0 {
			roots = append(roots, mapping.From)
		}
	}
	return roots
}

// homeRootInsideOwn 判断某个 CLI 根目录是否与本账号的根目录重叠。
// 对方根目录是自己的祖先（例如 agy 的 .gemini 之于 .gemini/antigravity-cli）
// 会吞掉账号沙箱；落在自己根目录里面同理不能替换成宿主链接。
func homeRootInsideOwn(segments []string, own [][]string) bool {
	for _, ownRoot := range own {
		if pathSegmentsPrefix(ownRoot, segments) || pathSegmentsPrefix(segments, ownRoot) {
			return true
		}
	}
	return false
}

func pathSegmentsPrefix(prefix []string, value []string) bool {
	if len(prefix) == 0 || len(prefix) > len(value) {
		return false
	}
	for index := range prefix {
		if !samePathSegment(prefix[index], value[index]) {
			return false
		}
	}
	return true
}

func samePathSegment(left string, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func clonePathSegments(input [][]string) [][]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make([][]string, 0, len(input))
	for _, segments := range input {
		if len(segments) == 0 {
			continue
		}
		cloned = append(cloned, append([]string(nil), segments...))
	}
	return cloned
}

// ensureHostAuthorityLink 让 source 成为指向 target 的托管链接。
//
// source 不存在时预建宿主目录并直接建链（之后 CLI 写入的就是宿主那一份）；
// 已存在时先把投影内容并进宿主，再替换成链接。
func (provisioner *Provisioner) ensureHostAuthorityLink(source string, target string) error {
	info, err := os.Lstat(source)
	if errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(target, 0o700); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
			return err
		}
		return provisioner.linkShared(source, target, true)
	}
	if err != nil {
		return err
	}
	if provisioner.linker.IsManaged(source, target) {
		return nil
	}
	resolved, statErr := os.Stat(source)
	if statErr != nil && info.Mode()&os.ModeSymlink == 0 {
		// 悬空真实路径不该出现在这里；保留现场交给上层诊断。
		return statErr
	}
	if statErr == nil && !resolved.IsDir() {
		// 同名文件不是跨 CLI 的根目录，保留现状。
		return nil
	}
	if statErr == nil {
		if err := adoptIntoHost(source, target, info.Mode()&os.ModeSymlink != 0); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(source); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
		return err
	}
	return provisioner.linkShared(source, target, true)
}

// adoptIntoHost 把投影里的跨 CLI 目录内容并进宿主。
// 宿主已有的同名条目一律保留；只补宿主缺的目录与普通文件。linked 表示 source
// 是链接（旧运行 home 的中转链接），此时绝不能 rename 共享目标本身。
func adoptIntoHost(source string, target string, linked bool) error {
	resolvedSource, err := filepath.EvalSymlinks(source)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if resolvedTarget, resolveErr := filepath.EvalSymlinks(target); resolveErr == nil {
		if pathWithin(resolvedSource, resolvedTarget) {
			return nil
		}
	}
	if !linked {
		if _, statErr := os.Stat(target); errors.Is(statErr, fs.ErrNotExist) {
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			if renameErr := os.Rename(source, target); renameErr == nil {
				return nil
			}
		}
	}
	targetInfo, err := os.Stat(target)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := os.MkdirAll(target, 0o700); err != nil {
			return err
		}
	} else if !targetInfo.IsDir() {
		return nil
	}
	return copyMissingTree(resolvedSource, target)
}

// copyMissingTree 递归复制宿主缺的条目；符号链接与特殊文件跳过，AIH 自己的
// 运行目录不搬进宿主。
func copyMissingTree(source string, target string) error {
	return filepath.WalkDir(source, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		name := entry.Name()
		if entry.IsDir() {
			if name == ".aih-runtime-home" || name == ".aih-runtime" {
				return fs.SkipDir
			}
			return os.MkdirAll(filepath.Join(target, relative), 0o700)
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() || skipCopyEntry(name) {
			return nil
		}
		destination := filepath.Join(target, relative)
		if _, statErr := os.Lstat(destination); statErr == nil {
			return nil
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return statErr
		}
		return copyRegularFile(destination, current)
	})
}

// skipCopyEntry 跳过落盘副作用文件：SQLite 的 -wal/-shm/-journal 会携带
// 另一个库的事务与盐值，复制到已存在的宿主库旁边可能重放出脏数据；
// 锁文件复制过去也只会让宿主侧看到别人的锁状态。
func skipCopyEntry(name string) bool {
	if name == ".DS_Store" {
		return true
	}
	lower := strings.ToLower(name)
	for _, suffix := range []string{"-wal", "-shm", "-journal", ".lock", "-lock", ".pid"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

func copyRegularFile(destination string, source string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		_ = os.Remove(destination)
		return err
	}
	return output.Close()
}

// applyDedupeLinks 处理 SharedHostDedupe：两侧版本戳一致时，把内容完全相同的
// 文件硬链接成同一份（典型：Kimi daimon bundle，每个账号会解压一份约 600MB）。
// 不做整目录 symlink：应用升级会同时往同一目录解压，硬链接去重不改变各账号目录。
func (provisioner *Provisioner) applyDedupeLinks(
	request appprojection.Request,
	policy appprojection.Policy,
	root string,
) error {
	for _, link := range policy.SharedHostDedupe {
		if len(link.Platforms) > 0 && !contains(link.Platforms, runtime.GOOS) {
			continue
		}
		source, err := joinUnder(root, link.Projection)
		if err != nil {
			return err
		}
		target, err := joinUnder(request.HostHomeDir, link.Host)
		if err != nil {
			return err
		}
		sourceInfo, sourceErr := os.Stat(source)
		if sourceErr != nil || !sourceInfo.IsDir() {
			continue
		}
		targetInfo, targetErr := os.Stat(target)
		if targetErr != nil || !targetInfo.IsDir() {
			continue
		}
		stamp := strings.TrimSpace(link.StampFile)
		if stamp != "" {
			hostStamp, _ := os.ReadFile(filepath.Join(target, stamp))
			sourceStamp, _ := os.ReadFile(filepath.Join(source, stamp))
			if len(hostStamp) == 0 || string(hostStamp) != string(sourceStamp) {
				continue
			}
			if marker, err := os.ReadFile(filepath.Join(source, ".aih-dedupe-stamp")); err == nil &&
				string(marker) == string(hostStamp) {
				continue
			}
		}
		spacegc.Dedupe([]string{source, target}, spacegc.DedupeOptions{MinSize: 4096, MinAge: 0})
		if stamp != "" {
			if hostStamp, err := os.ReadFile(filepath.Join(target, stamp)); err == nil {
				_ = os.WriteFile(filepath.Join(source, ".aih-dedupe-stamp"), hostStamp, 0o600)
			}
		}
	}
	return nil
}

// removeForTakeover 删除历史缓存副本；CLI 自更新的版本目录通常是只读的
// （dr-xr-xr-x / -r--r--r--），RemoveAll 会因父目录不可写而失败。先递归补
// 写权限再删。
func removeForTakeover(path string) error {
	_ = filepath.Walk(path, func(current string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		perm := info.Mode().Perm()
		if info.IsDir() {
			perm |= 0o700
		} else {
			perm |= 0o600
		}
		_ = os.Chmod(current, perm)
		return nil
	})
	return os.RemoveAll(path)
}

// applyHostLinks 把宿主缓存/共享数据根链接进投影。
//
// 与 ensureSharedEntry 的差别：宿主目标不存在时直接跳过，不能造悬空链接；
// 投影里已有真实目录/文件时也不删（可能是客户端刚写的缓存），只接管空的或
// 已托管的链接。
func (provisioner *Provisioner) applyHostLinks(
	request appprojection.Request,
	policy appprojection.Policy,
	root string,
) error {
	// 缓存类链接的宿主目录可以先建：缓存为空也可安全共享，不能因为宿主
	// 尚未生成 .qoder/.cache 就让每个账号各自落一份。
	for _, link := range policy.SharedHostCaches {
		if len(link.Platforms) > 0 && !contains(link.Platforms, runtime.GOOS) {
			continue
		}
		if len(link.Exclude) > 0 {
			continue
		}
		target, err := joinUnder(request.HostHomeDir, link.Host)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(target, 0o700); err != nil {
			return err
		}
	}
	links := make([]appprojection.SharedLink, 0, len(policy.SharedHostCaches)+len(policy.SharedHostDataRoots))
	links = append(links, policy.SharedHostCaches...)
	links = append(links, policy.SharedHostDataRoots...)
	for _, link := range links {
		if len(link.Platforms) > 0 && !contains(link.Platforms, runtime.GOOS) {
			continue
		}
		if len(link.Exclude) > 0 {
			// 目录级共享：逐子项链接，排除账号自有的缓存目录（见家族的 Library/Caches）。
			if err := provisioner.applyDirectoryHostLink(request, link, root); err != nil {
				return err
			}
			continue
		}
		target, err := joinUnder(request.HostHomeDir, link.Host)
		if err != nil {
			return err
		}
		targetInfo, targetErr := os.Stat(target)
		if errors.Is(targetErr, fs.ErrNotExist) {
			continue
		} else if targetErr != nil {
			return targetErr
		}
		source, err := joinUnder(root, link.Projection)
		if err != nil {
			return err
		}
		if info, sourceErr := os.Lstat(source); sourceErr == nil {
			if provisioner.linker.IsManaged(source, target) {
				continue
			}
			if info.Mode()&os.ModeSymlink == 0 {
				continue
			}
			return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
		} else if !errors.Is(sourceErr, fs.ErrNotExist) {
			return sourceErr
		}
		if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
			return err
		}
		if err := provisioner.linkShared(source, target, targetInfo.IsDir()); err != nil {
			return err
		}
	}
	return nil
}

// applyDirectoryHostLink 处理带 Exclude 的目录级共享：宿主目录逐个条目建链，
// 排除项（账号自有的缓存）留在投影里。投影已是托管链接时幂等通过；出现无主
// 链接或同名真实目录时保留现场，不覆盖客户端刚写的数据。
func (provisioner *Provisioner) applyDirectoryHostLink(
	request appprojection.Request,
	link appprojection.SharedLink,
	root string,
) error {
	target, err := joinUnder(request.HostHomeDir, link.Host)
	if err != nil {
		return err
	}
	targetInfo, targetErr := os.Stat(target)
	if errors.Is(targetErr, fs.ErrNotExist) {
		return nil
	} else if targetErr != nil {
		return targetErr
	}
	if !targetInfo.IsDir() {
		return nil
	}
	source, err := joinUnder(root, link.Projection)
	if err != nil {
		return err
	}
	sourceInfo, sourceErr := os.Lstat(source)
	switch {
	case errors.Is(sourceErr, fs.ErrNotExist):
		if err := os.MkdirAll(source, 0o700); err != nil {
			return err
		}
	case sourceErr != nil:
		return sourceErr
	case sourceInfo.Mode()&os.ModeSymlink != 0:
		return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
	case !sourceInfo.IsDir():
		return fmt.Errorf("%w: %s is not a directory", appprojection.ErrProjectionConflict, source)
	}
	excluded := make(map[string]bool, len(link.Exclude))
	for _, name := range link.Exclude {
		excluded[name] = true
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if excluded[entry.Name()] {
			continue
		}
		if err := provisioner.linkManagedChild(
			filepath.Join(source, entry.Name()),
			filepath.Join(target, entry.Name()),
			entry.IsDir(),
		); err != nil {
			return err
		}
	}
	return nil
}

// linkManagedChild 建一条宿主子项链接；已存在且受管时幂等通过。
func (provisioner *Provisioner) linkManagedChild(source string, target string, isDir bool) error {
	info, err := os.Lstat(source)
	if err == nil {
		if provisioner.linker.IsManaged(source, target) {
			return nil
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return nil
		}
		return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return provisioner.linkShared(source, target, isDir)
}

func (provisioner *Provisioner) ensureSharedEntry(
	sourceRoot string,
	hostRoot string,
	name string,
	sessionEntry bool,
) error {
	source := filepath.Join(sourceRoot, name)
	target := filepath.Join(hostRoot, name)

	sourceInfo, sourceErr := os.Lstat(source)
	if errors.Is(sourceErr, fs.ErrNotExist) {
		sourceInfo = nil
	} else if sourceErr != nil {
		return sourceErr
	}
	targetInfo, targetErr := os.Lstat(target)
	if errors.Is(targetErr, fs.ErrNotExist) {
		targetInfo = nil
	} else if targetErr != nil {
		return targetErr
	}
	// 宿主共享条目本身可能是「指向目录的链接」（如 ~/.workbuddy-ai/projects ->
	// ~/.codebuddy/projects）。Lstat 不跟随，会把目录误判成文件；类型判定必须跟随一次。
	targetIsDir := targetInfo != nil && targetDirectory(target, targetInfo)

	if targetInfo == nil && sourceInfo != nil && sourceInfo.Mode()&os.ModeSymlink != 0 {
		// 悬空托管链接的目标本来就不存在：删掉投影里的死链接，等宿主出现后再建。
		if provisioner.linker.IsManaged(source, target) {
			return os.Remove(source)
		}
		return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
	}

	if targetInfo == nil {
		if sourceInfo == nil {
			return nil
		}
		if sessionEntry {
			return fmt.Errorf("%w: session entry %s has no host target", appprojection.ErrProjectionConflict, name)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.Rename(source, target); err != nil {
			return err
		}
		targetInfo, targetErr = os.Lstat(target)
		if targetErr != nil {
			return targetErr
		}
		targetIsDir = targetDirectory(target, targetInfo)
		sourceInfo = nil // 已迁移到宿主，后续只需建链接
	}

	if sourceInfo != nil && sourceInfo.Mode()&os.ModeSymlink != 0 {
		if provisioner.linker.IsManaged(source, target) {
			return nil
		}
		return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
	}

	if sourceInfo != nil {
		if sourceInfo.IsDir() != targetIsDir {
			// 类型冲突（宿主把共享目录换成了文件或反向）：保留现场，本轮跳过建链。
			// 与 Node shared-store-linker 的 unresolved 语义一致，不能因为一个共享
			// 条目把整个会话启动打死。
			return nil
		}
		if targetIsDir {
			entries, err := os.ReadDir(source)
			if err != nil {
				return err
			}
			if len(entries) > 0 {
				// 历史遗留的真实目录原样保留（Node 语义：绝不搬迁、绝不吞数据），
				// 本轮不建链，CLI 继续用投影里的本地副本。
				return nil
			}
			if err := os.Remove(source); err != nil {
				return err
			}
		} else {
			same, err := sameFileContent(source, target)
			if err != nil {
				return err
			}
			if !same {
				if sessionEntry {
					return fmt.Errorf("%w: %s differs from host", appprojection.ErrProjectionConflict, name)
				}
				// 配置类共享文件允许一次性归一：settings.json 先把投影内容并进宿主
				// 规范文件（target 优先，对齐 Node codebuddy-shared-config），其它文件
				// 以宿主为规范源。归一后删投影副本并建链接，之后永远只有一份实体。
				if name == "settings.json" {
					if err := mergeSettingsFile(source, target); err != nil {
						return err
					}
				}
			}
			if err := os.Remove(source); err != nil {
				return err
			}
		}
	}
	return provisioner.linkShared(source, target, targetIsDir)
}

// targetDirectory 判断宿主共享条目是不是目录；指向目录的符号链接要跟随一次
// 再判定，悬空链接仍按非目录处理。
func targetDirectory(path string, info os.FileInfo) bool {
	if info == nil {
		return false
	}
	if info.IsDir() {
		return true
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return false
	}
	resolved, err := os.Stat(path)
	return err == nil && resolved.IsDir()
}

// prepareMappingRoot 修复旧布局把映射根做成宿主链接的形态：这种链接让源与目标
// 变成同一目录，随后每个共享条目都只能生成指向自身的死链。指向宿主根的链接
// 直接替换为真实目录（宿主数据仍在原处），其它链接维持失败关闭。
func prepareMappingRoot(sourceRoot string, hostRoot string) error {
	info, err := os.Lstat(sourceRoot)
	if errors.Is(err, fs.ErrNotExist) {
		return os.MkdirAll(sourceRoot, 0o700)
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return os.MkdirAll(sourceRoot, 0o700)
	}
	destination, err := os.Readlink(sourceRoot)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(destination) {
		destination = filepath.Join(filepath.Dir(sourceRoot), destination)
	}
	if filepath.Clean(destination) != filepath.Clean(hostRoot) {
		return fmt.Errorf("%w: mapping root %s points to %s", appprojection.ErrProjectionConflict, sourceRoot, destination)
	}
	if err := os.Remove(sourceRoot); err != nil {
		return err
	}
	return os.MkdirAll(sourceRoot, 0o700)
}

// linkShared 建立投影到宿主的共享链接。源与目标解析到同一物理位置时直接视为
// 已共享，绝不建自指链接；并发建链拿到 EEXIST 且最终指向同一目标时幂等成功。
func (provisioner *Provisioner) linkShared(source string, target string, isDir bool) error {
	if samePhysicalLocation(source, target) {
		return nil
	}
	if err := provisioner.linker.Link(source, target, isDir); err != nil {
		if errors.Is(err, fs.ErrExist) && provisioner.linker.IsManaged(source, target) {
			return nil
		}
		return err
	}
	return nil
}

// samePhysicalLocation 比较两个路径是否落在同一位置；叶子可以尚不存在，但父目录
// 必须存在（调用点已确保）。
func samePhysicalLocation(left string, right string) bool {
	leftDir, leftErr := filepath.EvalSymlinks(filepath.Dir(left))
	rightDir, rightErr := filepath.EvalSymlinks(filepath.Dir(right))
	if leftErr != nil || rightErr != nil {
		return false
	}
	return filepath.Clean(filepath.Join(leftDir, filepath.Base(left))) ==
		filepath.Clean(filepath.Join(rightDir, filepath.Base(right)))
}

// precreatedDirectoryMu 串行化本进程内的预置目录修复：上百个 work 会话同时激活
// 时指向同一批宿主目录，修复自指死链是「删链接再建目录」，并发交错会让刚建好的
// 目录又被另一个协程的删除动作带走。
var precreatedDirectoryMu sync.Mutex

// ensurePrecreatedDirectory 创建投影预置目录；指向自身的符号链接是历史投影留下的
// 死链（readlink 解析回自身），先清掉再创建。其它形态交给 MkdirAll：指向目录的
// 链接视为已就绪，悬空链接或无主链接仍然失败关闭，避免误删用户数据。
func ensurePrecreatedDirectory(path string) error {
	precreatedDirectoryMu.Lock()
	defer precreatedDirectoryMu.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		info, err := os.Lstat(path)
		if errors.Is(err, fs.ErrNotExist) {
			return mkdirPrecreatedDirectory(path)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return mkdirPrecreatedDirectory(path)
		}
		destination, err := os.Readlink(path)
		if err != nil {
			// 跨进程并发下路径可能刚被换成真实目录或被清掉：重读形态再判断。
			continue
		}
		if !filepath.IsAbs(destination) {
			destination = filepath.Join(filepath.Dir(path), destination)
		}
		if filepath.Clean(destination) != filepath.Clean(path) {
			return mkdirPrecreatedDirectory(path)
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			continue
		}
		return mkdirPrecreatedDirectory(path)
	}
	return mkdirPrecreatedDirectory(path)
}

// mkdirPrecreatedDirectory 以最终形态为准：MkdirAll 失败但路径已是目录时视为就绪，
// 容忍并发修复/替换带来的 EEXIST 与 ENOTEMPTY。
func mkdirPrecreatedDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		if info, statErr := os.Stat(path); statErr == nil && info.IsDir() {
			return nil
		}
		return err
	}
	return nil
}

func (provisioner *Provisioner) writeArtifact(root string, write appprojection.ArtifactWrite) error {
	if strings.TrimSpace(write.Path) == "" || !filepath.IsAbs(write.Path) {
		return appprojection.ErrInvalidProjectionRequest
	}
	if !pathWithin(root, write.Path) {
		return appprojection.ErrInvalidProjectionRoot
	}
	mode := write.Mode
	if mode == 0 {
		mode = 0o600
	}
	return writeFileAtomic(write.Path, write.Data, mode)
}

func resolveEnv(
	bindings []appprojection.EnvBinding,
	root string,
	hostHomeDir string,
	nativeRoot []string,
) (map[string]string, error) {
	if len(bindings) == 0 {
		return nil, nil
	}
	env := make(map[string]string, len(bindings))
	for _, binding := range bindings {
		var base string
		switch binding.Base {
		case appprojection.EnvBaseProjectionRoot:
			base = root
		case appprojection.EnvBaseNativeRoot:
			var err error
			base, err = joinUnder(root, nativeRoot)
			if err != nil {
				return nil, err
			}
		case appprojection.EnvBaseHostHome:
			base = hostHomeDir
		case appprojection.EnvBaseHostNativeRoot:
			var err error
			base, err = joinUnder(hostHomeDir, nativeRoot)
			if err != nil {
				return nil, err
			}
		default:
			return nil, appprojection.ErrInvalidProjectionRequest
		}
		value, err := joinUnder(base, binding.Path)
		if err != nil {
			return nil, err
		}
		env[binding.Key] = value
	}
	return env, nil
}

func joinUnder(base string, segments []string) (string, error) {
	cleaned := filepath.Clean(strings.TrimSpace(base))
	if cleaned == "" || !filepath.IsAbs(cleaned) {
		return "", appprojection.ErrInvalidProjectionRoot
	}
	path := filepath.Join(append([]string{cleaned}, segments...)...)
	if !pathWithin(cleaned, path) {
		return "", appprojection.ErrInvalidProjectionRoot
	}
	return path, nil
}

func pathWithin(root string, candidate string) bool {
	cleanRoot := filepath.Clean(root)
	cleanCandidate := filepath.Clean(candidate)
	if cleanRoot == "" || cleanCandidate == "" {
		return false
	}
	relative, err := filepath.Rel(cleanRoot, cleanCandidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func samePath(left string, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func sameFileContent(left string, right string) (bool, error) {
	leftData, err := os.ReadFile(left)
	if err != nil {
		return false, err
	}
	rightData, err := os.ReadFile(right)
	if err != nil {
		return false, err
	}
	return bytes.Equal(leftData, rightData), nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
