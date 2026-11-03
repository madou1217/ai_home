package providerlaunch

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

var (
	// ErrInvalidEnvironmentPatch 表示环境变量增删集合不安全或互相冲突。
	ErrInvalidEnvironmentPatch = errors.New("Provider 启动环境补丁无效")
)

// EnvironmentPatch 描述启动子进程必须设置和删除的环境变量。
//
// 所有字段均不可导出，正常格式化只展示变量名；RevealSet 是 Runtime Adapter 获取
// 明文值的唯一显式入口。
type EnvironmentPatch struct {
	set   map[string]string
	unset []string
}

// NewEnvironmentPatch 校验并复制环境变量，避免调用方在构建后修改启动凭据。
func NewEnvironmentPatch(
	set map[string]string,
	unset []string,
) (EnvironmentPatch, error) {
	copiedSet := make(map[string]string, len(set))
	for name, value := range set {
		if !isEnvironmentName(name) || value == "" || strings.ContainsRune(value, '\x00') {
			return EnvironmentPatch{}, ErrInvalidEnvironmentPatch
		}
		copiedSet[name] = value
	}

	copiedUnset := make([]string, 0, len(unset))
	seenUnset := make(map[string]struct{}, len(unset))
	for _, name := range unset {
		if !isEnvironmentName(name) {
			return EnvironmentPatch{}, ErrInvalidEnvironmentPatch
		}
		if _, conflicts := copiedSet[name]; conflicts {
			return EnvironmentPatch{}, ErrInvalidEnvironmentPatch
		}
		if _, duplicated := seenUnset[name]; duplicated {
			return EnvironmentPatch{}, ErrInvalidEnvironmentPatch
		}
		seenUnset[name] = struct{}{}
		copiedUnset = append(copiedUnset, name)
	}
	sort.Strings(copiedUnset)
	return EnvironmentPatch{set: copiedSet, unset: copiedUnset}, nil
}

// SetNames 返回需要设置的环境变量名，不返回任何明文值。
func (patch EnvironmentPatch) SetNames() []string {
	names := make([]string, 0, len(patch.set))
	for name := range patch.set {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// UnsetNames 返回启动前必须从父进程环境删除的变量名副本。
func (patch EnvironmentPatch) UnsetNames() []string {
	return append([]string(nil), patch.unset...)
}

// RevealSet 显式返回明文环境变量副本，仅供最终 Runtime Adapter 组装子进程环境。
func (patch EnvironmentPatch) RevealSet() map[string]string {
	values := make(map[string]string, len(patch.set))
	for name, value := range patch.set {
		values[name] = value
	}
	return values
}

// IsValid 判断环境补丁是否仍满足变量名、值和集合互斥约束。
func (patch EnvironmentPatch) IsValid() bool {
	rebuilt, err := NewEnvironmentPatch(patch.set, patch.unset)
	return err == nil && len(rebuilt.set) == len(patch.set)
}

// String 返回不含环境变量值的安全摘要。
func (patch EnvironmentPatch) String() string {
	return fmt.Sprintf(
		"providerlaunch.EnvironmentPatch{set=%v,unset=%v,values=<redacted>}",
		patch.SetNames(),
		patch.UnsetNames(),
	)
}

// GoString 确保 %#v 不会通过反射输出私有环境变量值。
func (patch EnvironmentPatch) GoString() string {
	return patch.String()
}

// Format 覆盖所有 fmt verb，避免值格式化绕过脱敏摘要。
func (patch EnvironmentPatch) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(patch.String()))
}

// cloneEnvironmentPatch 深复制环境补丁的敏感 map。
func cloneEnvironmentPatch(source EnvironmentPatch) EnvironmentPatch {
	cloned, _ := NewEnvironmentPatch(source.set, source.unset)
	return cloned
}

// isEnvironmentName 使用无分配 ASCII 扫描校验跨平台环境变量名。
func isEnvironmentName(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if index == 0 {
			if character != '_' && (character < 'A' || character > 'Z') &&
				(character < 'a' || character > 'z') {
				return false
			}
			continue
		}
		if character != '_' && (character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') &&
			(character < '0' || character > '9') {
			return false
		}
	}
	return true
}
