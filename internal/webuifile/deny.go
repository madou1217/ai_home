package webuifile

import (
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

// DenyPolicy 对应 isSensitiveFilePath 的入参：宿主 HOME 决定 provider 配置根。
type DenyPolicy struct {
	HostHomeDir string
}

// IsSensitive 对应 isSensitiveFilePath：凭证、私钥、provider 配置与账号私有产物一律拒绝。
//
// provider 配置位置与账号私有产物是 Provider 存储策略，唯一真值在
// internal/runtime/storagepolicy；本函数只补 WebUI 自己的字面规则。
func (p DenyPolicy) IsSensitive(target string) bool {
	lower := strings.ToLower(strings.TrimSpace(target))
	if lower == "" {
		return false
	}
	return strings.Contains(lower, "/.ssh/") ||
		strings.Contains(lower, "\\\\.ssh\\\\") ||
		strings.Contains(lower, "auth.json") ||
		strings.Contains(lower, "oauth_creds.json") ||
		strings.Contains(lower, "credentials.json") ||
		strings.HasSuffix(lower, "id_rsa") ||
		storagepolicy.IsConfigurationPath(p.HostHomeDir, target) ||
		storagepolicy.IsPrivateArtifactPath(target)
}
