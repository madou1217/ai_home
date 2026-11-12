package accountprojection

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Purpose 是本次投影的用途；登录投影是临时的，正常启动投影可复用。
type Purpose string

const (
	PurposeLaunch Purpose = "launch"
	PurposeLogin  Purpose = "login"
)

// Request 是一次投影准备/捕获的完整输入。
type Request struct {
	ProviderID string
	AccountRef accountcore.AccountRef
	// Credential 是账号库解析出的 typed 或 native 凭据；只交给 Materializer，不落日志。
	Credential  accountapp.Credential
	AccountEnv  map[string]string
	HostHomeDir string
	AIHomeDir   string
	Platform    string
	Purpose     Purpose

	// 以下两项来自 providerruntime 的纯 scope 决策，Provisioner 不再重新判断。
	ProjectionRequired bool
	RuntimeDir         string
}

// Result 是 Prepare 的产物；SetEnv/UnsetEnv 由启动层合并到子进程环境。
type Result struct {
	Root     string
	Mode     Mode
	PolicyID string
	SetEnv   map[string]string
	UnsetEnv []string
}

// Plan 是不可变的投影计划，供 LaunchSpec 携带；不含明文凭据。
type Plan struct {
	ProviderID string
	Mode       Mode
	Root       string
	PolicyID   string
	SetEnv     map[string]string
	UnsetEnv   []string
}

// ArtifactResult 是一次 auth artifact 写入结果。
type ArtifactResult struct {
	Path    string
	Written bool
}

// PolicyProvider 按 Provider 返回投影策略；未知 Provider 返回 false。
type PolicyProvider interface {
	Policy(providerID string) (Policy, bool)
}

// Provisioner 执行投影目录、链接与凭据物化；实现必须在失败时保持可回滚。
type Provisioner interface {
	Prepare(ctx context.Context, request Request) (Result, error)
	// Capture 在进程退出/登录完成后把客户端续期的凭据写回账号库；没有变化返回 nil。
	Capture(ctx context.Context, request Request, result Result) error
	// Remove 只删除带本系统标记的投影，绝不删除宿主原生目录。
	Remove(ctx context.Context, providerID string, accountRef accountcore.AccountRef) error
}

// Materializer 负责 Provider 特定的凭据编码/解码；通用目录/链接逻辑不得感知 Provider 名。
type Materializer interface {
	ProviderID() string
	Materialize(ctx context.Context, request Request, policy Policy, root string) ([]ArtifactResult, error)
	// Capture 读取投影中的凭据；无法识别/身份不匹配时返回 false。
	Capture(ctx context.Context, request Request, policy Policy, root string) (accountapp.Credential, bool, error)
}

// Linker 是平台链接边界：Unix symbol link、Windows junction/hardlink/copy 都由此实现。
type Linker interface {
	Link(linkPath string, targetPath string, directory bool) error
	IsManaged(linkPath string, targetPath string) bool
	RemoveManaged(linkPath string, targetPath string) error
}
