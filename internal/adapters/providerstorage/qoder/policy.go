// Package qoderstorage 是 Qoder（全球站与国内站）的账号投影策略与凭据物化适配器。
//
// 两家 --config-dir 布局相同，只有可执行文件不同；账号配置根就是投影根本身，
// 凭据落在 <投影>/.auth/user（Opaque blob）与 .auth/machine_id，缓存落在 .cache。
package qoderstorage

import "github.com/madou1217/ai_home/application/accountprojection"

// ProviderIDs 是共用同一套投影布局的两个 Provider。
var ProviderIDs = []string{"qoder", "qodercn"}

// Policy 返回指定 Provider 的投影策略；未知 Provider 返回 false。
func Policy(providerID string) (accountprojection.Policy, bool) {
	switch providerID {
	case "qoder", "qodercn":
	default:
		return accountprojection.Policy{}, false
	}
	return accountprojection.Policy{
		Provider:        providerID,
		Mode:            accountprojection.ModeConfigDir,
		NativeRoot:      []string{},
		RuntimeHomeRoot: []string{".aih-runtime-home"},
		AuthArtifacts: []accountprojection.Artifact{
			{
				Field:  "credentials",
				Path:   []string{".auth", "user"},
				Format: accountprojection.FormatText,
			},
			{
				Field:    "machineId",
				Path:     []string{".auth", "machine_id"},
				Format:   accountprojection.FormatText,
				Optional: true,
			},
			{
				Field:    "dnsCache",
				Path:     []string{".cache", "dns-cache.json"},
				Format:   accountprojection.FormatJSON,
				Optional: true,
			},
		},
		PrivateArtifacts: []accountprojection.PathSpec{
			{Path: []string{"electron-user-data"}},
			{Path: []string{".auth"}},
			{Path: []string{"Library", "Keychains"}},
		},
		AttachmentSubdir: []string{"tmp", "model", "images"},
	}, true
}
