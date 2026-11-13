// Package assets 内嵌随包分发的静态资源。
package assets

import "embed"

// ProviderIcons 是终端 Profile 图标资产（与 Node assets/provider-icons 同一批文件）。
//
//go:embed provider-icons/*.png
var ProviderIcons embed.FS

// ProviderIcon 返回指定 Provider 的 PNG 字节；未知 Provider 返回 false。
func ProviderIcon(providerID string) ([]byte, bool) {
	if providerID == "" {
		return nil, false
	}
	data, err := ProviderIcons.ReadFile("provider-icons/" + providerID + ".png")
	if err != nil || len(data) == 0 {
		return nil, false
	}
	return data, true
}
