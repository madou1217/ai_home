package webuiplugintrustapi

// 信任根的读写实现已抽到 internal/adapters/plugintrust：插件安装校验（pluginartifact）
// 与 WebUI 管理路由必须用同一份实现，否则两边对 keyId、PEM 归一与文件格式的口径会分叉。
// 这里保留原有导出名，Handler 与测试不需要改调用点。

import plugintrust "github.com/madou1217/ai_home/internal/adapters/plugintrust"

const (
	// StoreSchemaVersion 是信任根文件的格式版本，与 Node 的 SIGNATURE_SCHEMA_VERSION 一致。
	StoreSchemaVersion = plugintrust.StoreSchemaVersion
	// StoreFileName 是信任根文件名，必须与 Node 的 TRUST_STORE_FILE 逐字一致。
	StoreFileName = plugintrust.StoreFileName
	// Algorithm 是唯一支持的发布者签名算法。
	Algorithm = plugintrust.Algorithm
)

const (
	CodeSignatureKeyInvalid   = plugintrust.CodeSignatureKeyInvalid
	CodeSignatureKeyIDInvalid = plugintrust.CodeSignatureKeyIDInvalid
	CodeTrustStoreInvalid     = plugintrust.CodeTrustStoreInvalid
)

// Error 是带错误码的信任根错误。
type Error = plugintrust.Error

// TrustStore 读写 <aiHomeDir>/plugins/trusted-keys.json。
type TrustStore = plugintrust.TrustStore

// AddInput 是一次 trust 请求的输入。
type AddInput = plugintrust.AddInput

// AddResult 与 Node addTrustedKey 的返回字段逐字对应。
type AddResult = plugintrust.AddResult

// RemoveResult 与 Node removeTrustedKey 的返回字段逐字对应。
type RemoveResult = plugintrust.RemoveResult

// TrustedKey 是 GET /trusted 的列表项。
type TrustedKey = plugintrust.TrustedKey

// NewTrustStore 创建信任根存储。
var NewTrustStore = plugintrust.NewTrustStore

// NormalizePublicKey 校验并归一 Ed25519 公钥 PEM。
var NormalizePublicKey = plugintrust.NormalizePublicKey

// Fingerprint 是 Node publicKeyId 的同构实现。
var Fingerprint = plugintrust.Fingerprint
