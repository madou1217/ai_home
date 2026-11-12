// Package accountremoval 承接账号删除中不依赖 Node 专属存储的宿主清理。
//
// lib/account/account-removal.js 的 deleteAccountByRef 混了两类工作：
//   - 纯文件系统/会话：运行时投影目录（含 codex desktop）与会话写者探测；
//   - Node 专属存储：app_kv 指针、usage snapshot、窗口激活状态、出口绑定、
//     codex app-server 进程重启与生命周期事件。
//
// 本包只迁移第一类，并逐条对齐 Node 语义：
//   - 投影根固定为 $AIH_HOME/run/auth-projections/<provider>/<acct_ref>，
//     codex 另加 $AIH_HOME/run/codex-desktop/<acct_ref>；
//   - 持久会话登记固定在 $AIH_HOME/run/persistent-sessions，按
//     (provider, accountRef) 过滤；精确会话仍存活或探测无法确认时拒绝删除，
//     陈旧登记当场清除；
//   - 所有路径都必须落在 AIH_HOME 内，账号引用按公开合同校验，路径中任何一层
//     出现 symlink 都拒绝删除（避免清理穿出数据根）。
package accountremoval

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidOptions 表示构造宿主清理时缺少可用的 AIH_HOME。
	ErrInvalidOptions = errors.New("账号删除宿主清理配置无效")
	// ErrInvalidRequest 表示 Provider、账号引用或 Context 不满足删除合同。
	ErrInvalidRequest = errors.New("账号删除宿主清理请求无效")
	// ErrRuntimeProjectionUnsafe 表示固定投影路径越界或路径中出现 symlink。
	ErrRuntimeProjectionUnsafe = errors.New("账号运行时投影路径不受信任")
)

const (
	// authProjectionRelativeDir 与 lib/runtime/aih-storage-layout.js 的
	// resolveAccountRuntimeDir 保持同一落点。
	authProjectionRelativeDir = "run/auth-projections"
	// codexDesktopRelativeDir 与 resolveCodexDesktopRuntimeDir 保持同一落点。
	codexDesktopRelativeDir = "run/codex-desktop"
	codexProviderID         = "codex"
	maxProviderIDLength     = 64
)

// Options 保存宿主清理的唯一外部依赖。
type Options struct {
	// AIHomeDir 是 auth-projections、codex-desktop 与 persistent-sessions 的数据根。
	AIHomeDir string
	// Probe 为 nil 时使用宿主 tmux；测试注入假探测器。
	Probe SessionProbe
	// Kill 为 nil 时使用宿主 tmux；测试注入假实现，让「杀完之后复探」可验证。
	Kill SessionKiller
}

// Service 执行账号删除前的宿主投影清理、会话写者检查与强制释放。
type Service struct {
	aiHomeDir string
	probe     SessionProbe
	killer    SessionKiller
}

// New 创建宿主清理服务；AIH_HOME 必须是已存在的真实目录。
//
// 构造后不再跟随调用方路径变化：符号链接在这里一次性解析，后续所有固定路径
// 都以解析后的根为基准。
func New(options Options) (*Service, error) {
	root := strings.TrimSpace(options.AIHomeDir)
	if root == "" || !filepath.IsAbs(root) {
		return nil, ErrInvalidOptions
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(root))
	if err != nil {
		return nil, ErrInvalidOptions
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, ErrInvalidOptions
	}
	probe := options.Probe
	if probe == nil {
		probe = hostTmuxProbe{}
	}
	killer := options.Kill
	if killer == nil {
		killer = hostTmuxKiller{}
	}
	return &Service{aiHomeDir: resolved, probe: probe, killer: killer}, nil
}

// RuntimeProjectionDirs 解析目标账号的全部运行时投影根。
//
// 返回值只做路径解析，不保证目录存在；调用方需要按存在性分支时应先用
// HasRuntimeProjection。
func (service *Service) RuntimeProjectionDirs(providerRaw, accountRefRaw string) ([]string, error) {
	if service == nil || service.aiHomeDir == "" {
		return nil, ErrInvalidRequest
	}
	provider, accountRef, err := parseTarget(providerRaw, accountRefRaw)
	if err != nil {
		return nil, err
	}
	return service.projectionPaths(provider, accountRef), nil
}

// HasRuntimeProjection 判断目标账号是否仍留有任一运行时投影。
//
// 投影根不是目录（例如被替换成文件）时按不可信路径拒绝：Node 会直接删掉这种
// 路径，这里选择失败关闭，避免把「形态异常」当成「可以清理」。
func (service *Service) HasRuntimeProjection(providerRaw, accountRefRaw string) (bool, error) {
	// 解析失败与越界都必须冒泡：删除流程不能把「路径不合法」当成「没有投影」。
	dirs, err := service.RuntimeProjectionDirs(providerRaw, accountRefRaw)
	if err != nil {
		return false, err
	}
	for _, dir := range dirs {
		exists, err := assertSafePath(service.aiHomeDir, dir)
		if err != nil {
			return false, err
		}
		if exists {
			return true, nil
		}
	}
	return false, nil
}

// RemoveRuntimeProjections 删除目标账号的可丢弃运行时投影。
//
// 与 Node 的 fs.rmSync({ recursive: true, force: true }) 等价：目录不存在视为
// 成功，重复调用幂等。两个投影根按顺序删除；某个根越界或含 symlink 时拒绝该根，
// 已删掉的前一个根保持删除（Node 的顺序 rm 也是这个语义）。
func (service *Service) RemoveRuntimeProjections(
	ctx context.Context,
	providerRaw string,
	accountRefRaw string,
) error {
	if service == nil || service.aiHomeDir == "" || ctx == nil {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	provider, accountRef, err := parseTarget(providerRaw, accountRefRaw)
	if err != nil {
		return err
	}
	for _, dir := range service.projectionPaths(provider, accountRef) {
		if err := ctx.Err(); err != nil {
			return err
		}
		exists, err := assertSafePath(service.aiHomeDir, dir)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	return nil
}

// parseTarget 归一 Provider 与账号引用。Provider 只做小写与字符校验，账号引用
// 必须满足公开合同（acct_ 加 20 位十六进制），两者都不接受路径分隔符。
func parseTarget(providerRaw, accountRefRaw string) (string, string, error) {
	provider, err := normalizeProvider(providerRaw)
	if err != nil {
		return "", "", err
	}
	accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRefRaw))
	if err != nil {
		return "", "", fmt.Errorf("%w: 账号引用无效", ErrInvalidRequest)
	}
	return provider, accountRef.String(), nil
}

func normalizeProvider(value string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(value))
	if provider == "" || len(provider) > maxProviderIDLength {
		return "", fmt.Errorf("%w: Provider 无效", ErrInvalidRequest)
	}
	for _, character := range provider {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= '0' && character <= '9':
		case character == '.', character == '_', character == '-':
		default:
			return "", fmt.Errorf("%w: Provider 含非法字符", ErrInvalidRequest)
		}
	}
	return provider, nil
}

func (service *Service) projectionPaths(provider, accountRef string) []string {
	paths := []string{
		filepath.Join(service.aiHomeDir, filepath.FromSlash(authProjectionRelativeDir), provider, accountRef),
	}
	if provider == codexProviderID {
		paths = append(paths, filepath.Join(
			service.aiHomeDir,
			filepath.FromSlash(codexDesktopRelativeDir),
			accountRef,
		))
	}
	return paths
}

// assertSafePath 判断固定路径是否存在，并拒绝任何越界或 symlink 形态。
//
// 返回 (false, nil) 表示路径（含父级）尚不存在，删除按幂等处理。
func assertSafePath(root, target string) (bool, error) {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false, fmt.Errorf("%w: 路径不在 AIH_HOME 内", ErrRuntimeProjectionUnsafe)
	}
	current := root
	segments := strings.Split(relative, string(filepath.Separator))
	for index, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return false, fmt.Errorf("%w: 路径段无效", ErrRuntimeProjectionUnsafe)
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		last := index == len(segments)-1
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("%w: 固定路径包含 symlink: %s", ErrRuntimeProjectionUnsafe, current)
		}
		if !last && !info.IsDir() {
			return false, fmt.Errorf("%w: 固定路径父级不是目录: %s", ErrRuntimeProjectionUnsafe, current)
		}
		if last && !info.IsDir() {
			return false, fmt.Errorf("%w: 投影根不是目录: %s", ErrRuntimeProjectionUnsafe, current)
		}
	}
	return true, nil
}
