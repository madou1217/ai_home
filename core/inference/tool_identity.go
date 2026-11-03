package inference

// ToolIdentity 是跨协议稳定的函数工具身份。
//
// Namespace 只参与身份区分，不通过字符串拼接替代独立字段。这样既能保留
// Responses namespace，也能让不支持 namespace 的上游通过显式映射表转换。
type ToolIdentity struct {
	namespace string
	name      string
}

// NewToolIdentity 创建不属于 namespace 的普通函数工具身份。
func NewToolIdentity(name string) (ToolIdentity, error) {
	return newToolIdentity("", name)
}

// NewNamespacedToolIdentity 创建由 namespace 和局部名称共同确定的工具身份。
func NewNamespacedToolIdentity(namespace string, name string) (ToolIdentity, error) {
	return newToolIdentity(namespace, name)
}

// newToolIdentity 统一校验普通与 namespaced 工具身份。
func newToolIdentity(namespace string, name string) (ToolIdentity, error) {
	if !isToolName(name) || namespace != "" && !isToolName(namespace) {
		return ToolIdentity{}, ErrInvalidToolName
	}
	return ToolIdentity{namespace: namespace, name: name}, nil
}

// Name 返回 namespace 内的局部工具名。
func (identity ToolIdentity) Name() string {
	return identity.name
}

// Namespace 返回可选 namespace 及其是否存在。
func (identity ToolIdentity) Namespace() (string, bool) {
	return identity.namespace, identity.namespace != ""
}

// IsValid 判断工具身份仍满足构造不变量。
func (identity ToolIdentity) IsValid() bool {
	_, err := newToolIdentity(identity.namespace, identity.name)
	return err == nil
}
