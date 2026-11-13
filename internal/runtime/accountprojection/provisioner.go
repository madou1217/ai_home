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
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Options 是投影执行器的依赖。
type Options struct {
	AIHomeDir     string
	Policies      appprojection.PolicyProvider
	Materializers []appprojection.Materializer
	Linker        appprojection.Linker
	Credentials   accountapp.CredentialVersionStore
	Now           func() time.Time
}

// Provisioner 是 application/accountprojection.Provisioner 的通用实现。
type Provisioner struct {
	aiHomeDir     string
	policies      appprojection.PolicyProvider
	materializers map[string]appprojection.Materializer
	linker        appprojection.Linker
	credentials   accountapp.CredentialVersionStore
	now           func() time.Time
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
	if len(policy.ProjectionRoots) == 0 {
		return nil
	}
	for _, mapping := range policy.ProjectionRoots {
		sourceRoot, err := joinUnder(root, mapping.From)
		if err != nil {
			return err
		}
		hostRoot, err := joinUnder(request.HostHomeDir, mapping.To)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
			return err
		}
		if err := os.MkdirAll(hostRoot, 0o700); err != nil {
			return err
		}
		for _, name := range policy.PrecreatedDirectories {
			target := filepath.Join(hostRoot, name)
			if err := os.MkdirAll(target, 0o700); err != nil {
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
	if err := provisioner.applyHostLinks(request, policy, root); err != nil {
		return err
	}
	return nil
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
	links := make([]appprojection.SharedLink, 0, len(policy.SharedHostCaches)+len(policy.SharedHostDataRoots)+len(policy.SharedHostDedupe))
	links = append(links, policy.SharedHostCaches...)
	links = append(links, policy.SharedHostDataRoots...)
	links = append(links, policy.SharedHostDedupe...)
	for _, link := range links {
		if len(link.Platforms) > 0 && !contains(link.Platforms, runtime.GOOS) {
			continue
		}
		if len(link.Exclude) > 0 {
			// 部分排除需要目录级复制；Go 只做整链接，遇到排除项宁可跳过也不泄露账号态。
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
		if err := provisioner.linker.Link(source, target, targetInfo.IsDir()); err != nil {
			if errors.Is(err, fs.ErrExist) && provisioner.linker.IsManaged(source, target) {
				continue
			}
			return err
		}
	}
	return nil
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
	}

	if sourceInfo != nil && sourceInfo.Mode()&os.ModeSymlink != 0 {
		if provisioner.linker.IsManaged(source, target) {
			return nil
		}
		return fmt.Errorf("%w: %s is an unmanaged symlink", appprojection.ErrProjectionConflict, source)
	}

	if sourceInfo != nil {
		if targetInfo.IsDir() {
			if !sourceInfo.IsDir() {
				return fmt.Errorf("%w: %s type mismatch", appprojection.ErrProjectionConflict, name)
			}
			entries, err := os.ReadDir(source)
			if err != nil {
				return err
			}
			if len(entries) > 0 {
				return fmt.Errorf("%w: %s is not empty", appprojection.ErrProjectionConflict, name)
			}
			if err := os.Remove(source); err != nil {
				return err
			}
		} else {
			same, err := sameFileContent(source, target)
			if err != nil || !same {
				return fmt.Errorf("%w: %s differs from host", appprojection.ErrProjectionConflict, name)
			}
			if err := os.Remove(source); err != nil {
				return err
			}
		}
	}
	return provisioner.linker.Link(source, target, targetInfo.IsDir())
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
