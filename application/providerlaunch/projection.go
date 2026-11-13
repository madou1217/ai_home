package providerlaunch

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidProjectionDirective 表示 Strategy 声明了未知或不完整的账号投影。
	ErrInvalidProjectionDirective = errors.New("Provider 启动投影指令无效")
	// ErrProjectionRuntimeConflict 表示凭据文件投影与需要辅助进程的 Runtime 冲突。
	ErrProjectionRuntimeConflict = errors.New("Provider 启动投影与 Runtime 冲突")
)

// ProjectionMode 是账号投影形态；none 表示沿用共享原生状态。
type ProjectionMode string

const (
	// ProjectionModeNone 表示不创建账号投影（凭据走 env 或受控 Runtime 通道）。
	ProjectionModeNone ProjectionMode = "none"
	// ProjectionModeConfigDir 表示只隔离 Provider 配置根（如 Codex 的 CODEX_HOME）。
	ProjectionModeConfigDir ProjectionMode = "config_dir"
	// ProjectionModeFakeHome 表示整个 HOME 都是账号沙箱。
	ProjectionModeFakeHome ProjectionMode = "fake_home"
)

// ProjectionDirective 是 Strategy 交给 Runtime Adapter 的投影意图。
//
// 它只描述「需要哪种投影」，不含根目录、账号或凭据；投影根由 Runtime Adapter
// 按 AIH_HOME、账号引用和 Provider 策略在启动前计算并物化。
type ProjectionDirective struct {
	mode     ProjectionMode
	policyID string
}

// NoProjection 返回「沿用共享原生状态」的零投影指令。
func NoProjection() ProjectionDirective {
	return ProjectionDirective{mode: ProjectionModeNone}
}

// NewProjectionDirective 校验并创建账号投影指令。
func NewProjectionDirective(
	policyID string,
	mode ProjectionMode,
) (ProjectionDirective, error) {
	if !isDescriptorToken(policyID) {
		return ProjectionDirective{}, ErrInvalidProjectionDirective
	}
	if mode != ProjectionModeConfigDir && mode != ProjectionModeFakeHome {
		return ProjectionDirective{}, ErrInvalidProjectionDirective
	}
	return ProjectionDirective{mode: mode, policyID: policyID}, nil
}

// Mode 返回投影形态；零值按 none 处理。
func (directive ProjectionDirective) Mode() ProjectionMode {
	if directive.mode == "" {
		return ProjectionModeNone
	}
	return directive.mode
}

// PolicyID 返回投影使用的 Provider 策略标识；none 时为空。
func (directive ProjectionDirective) PolicyID() string {
	return directive.policyID
}

// Required 判断本次启动是否必须先准备账号投影。
func (directive ProjectionDirective) Required() bool {
	return directive.Mode() != ProjectionModeNone
}

// IsValid 判断指令是否仍满足模式与策略标识的不变量。
func (directive ProjectionDirective) IsValid() bool {
	switch directive.Mode() {
	case ProjectionModeNone:
		return directive.policyID == ""
	case ProjectionModeConfigDir, ProjectionModeFakeHome:
		return isDescriptorToken(directive.policyID)
	default:
		return false
	}
}

// String 返回不含路径和凭据的安全摘要。
func (directive ProjectionDirective) String() string {
	return fmt.Sprintf(
		"providerlaunch.ProjectionDirective{mode=%s,policy=%s}",
		directive.Mode(),
		directive.policyID,
	)
}

// GoString 确保 %#v 不会展开内部字段。
func (directive ProjectionDirective) GoString() string {
	return directive.String()
}

// Format 覆盖所有 fmt verb，保持摘要稳定。
func (directive ProjectionDirective) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(directive.String()))
}
