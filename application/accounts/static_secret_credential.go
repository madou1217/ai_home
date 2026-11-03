package accounts

import (
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// IsStaticSecretCredential 判断凭据是否为不可刷新的静态密钥。
//
// 静态密钥（API Key、Auth Token、PAT）没有 Refresh Token：上游拒收只能靠换密钥或
// 服务端恢复解决，运行态据此选择有限 cooldown 而不是等待凭据更新的硬阻塞。
// OAuth 凭据仍由 Node 刷新后推送新凭据解除阻塞。
func IsStaticSecretCredential(credential Credential) bool {
	if isRotatableStaticCredential(credential) {
		return true
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return false
	}
	switch native.AuthKind() {
	case "api-key", "pat":
		return true
	default:
		return false
	}
}
