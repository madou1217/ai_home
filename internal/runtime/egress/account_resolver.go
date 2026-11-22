package egress

// 账号出口解析器的唯一构造入口。
//
// agyegress.NewResolver 不会默认实现 ResolveManagedSSH：调用方漏接时 ssh
// 绑定只会返回 ssh_proxy_resolver_missing，且错误发生在解析阶段，看起来像
// 「账号没绑出口」而不是「接线漏了」。运行时侧统一从这里构造，默认把
// ManagedSSHProxyURL 接好，调用方无法再漏掉 ssh 出口。
//
// 适配器层（adapters/agy/egress）不能反向 import runtime，因此默认实现只能
// 放在这里，而不是放进 NewResolver 本身。

import (
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// NewAccountResolver 返回带完整默认接线的账号出口解析器。
//
// aiHomeDir 同时作为绑定存储根与 managed SSH 端点根；为空时 Resolve 按未绑定
// 处理（与 agyegress.NewResolver 的既有语义一致）。
func NewAccountResolver(aiHomeDir string) *agyegress.Resolver {
	return NewAccountResolverWithOptions(aiHomeDir, agyegress.Options{})
}

// NewAccountResolverWithOptions 允许内部调用点替换探测/平台/PID 判定或注入
// 合成绑定 Reader；ResolveManagedSSH 未显式提供时仍默认接到
// ManagedSSHProxyURL，因此带 Options 的调用点同样不可能漏掉 ssh 出口。
//
// aiHomeDir 优先于 options.AIHomeDir：避免绑定存储与 managed SSH 端点读的是
// 两个数据根。只有需要覆盖默认 SSH 解析（测试/特殊宿主）时才显式设置
// options.ResolveManagedSSH。
func NewAccountResolverWithOptions(aiHomeDir string, options agyegress.Options) *agyegress.Resolver {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		home = strings.TrimSpace(options.AIHomeDir)
	}
	options.AIHomeDir = home
	if options.ResolveManagedSSH == nil {
		options.ResolveManagedSSH = func(reference string) (string, error) {
			return ManagedSSHProxyURL(home, reference)
		}
	}
	return agyegress.NewResolver(options)
}
