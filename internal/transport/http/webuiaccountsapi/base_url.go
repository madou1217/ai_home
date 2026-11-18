package webuiaccountsapi

import (
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// credentialBaseURLForDisplay 从凭据事实推导账号页要展示的接口地址。
//
// 静态 API Key 的地址属于凭据本身，account_ui_state.base_url 只是为账号页准备的
// 历史镜像：导入账号、旧版本写入或只改过凭据的账号可能没有镜像值。回显必须以凭据
// 为准，否则编辑弹窗会显示空地址，用户直接保存就会把地址清掉。
//
// Claude 凭据构造器会把“未填写地址”归一成官方地址，而账号页约定“留空 = 官方地址”，
// 所以这里把官方地址再还原为空串。凭据没有地址时返回 ok=false，让调用方继续使用
// UI 镜像，避免误伤只有镜像的旧账号。
func credentialBaseURLForDisplay(fact accountFact) (string, bool) {
	raw := strings.TrimSpace(fact.CredentialBaseURL)
	if raw == "" {
		return "", false
	}
	normalized, err := accountcore.NormalizeStaticBaseURL(raw)
	if err != nil {
		return raw, true
	}
	if fact.Provider == claude.ProviderID && normalized == claude.DefaultAPIBaseURL {
		return "", true
	}
	return normalized, true
}
