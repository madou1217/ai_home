// Package modelcapabilities 提供一份冻结的模型能力基线数据（模态/档位/上下文/显示名）。
//
// 它只是**数据**，不依赖任何具体 Provider 或运行时：网关在启动时把它解析成能力来源，
// 与上游账号目录声明合并。上游声明永远优先；本基线用于没有能力声明的 Provider。
// 运行期不再从 models.dev 读取能力事实（models.dev 只作为价格插件）。
package modelcapabilities

import _ "embed"

//go:embed capabilities.json
var embeddedCapabilities []byte

// Embedded 返回内置能力基线 JSON 的只读副本。
func Embedded() []byte {
	return append([]byte(nil), embeddedCapabilities...)
}
