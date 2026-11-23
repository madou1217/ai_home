package pluginartifact

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/plugintrust"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// TrustPackageKeyResult 描述一次「安装时信任发布者」的结果。
type TrustPackageKeyResult struct {
	KeyID       string `json:"keyId"`
	Fingerprint string `json:"fingerprint"`
	Replaced    bool   `json:"replaced"`
}

// TrustPackageKey 把用户提供的公钥登记到本机信任根，槽位取包内签名声明的
// keyId。公钥未随包分发，因此这一步必须由调用方显式给出公钥（文件或 URL），
// 并可用指纹做二次核对。
func TrustPackageKey(packageFile string, publicKeyPEM string, expectedFingerprint string, replace bool, aiHomeDir string) (TrustPackageKeyResult, error) {
	info, err := ReadSignatureInfo(packageFile)
	if err != nil {
		return TrustPackageKeyResult{}, err
	}
	if info.Status != "signed" || strings.TrimSpace(info.KeyID) == "" {
		return TrustPackageKeyResult{}, pluginerr.New("plugin_signature_required", "该插件包没有签名，无法登记发布公钥")
	}
	normalized, err := plugintrust.NormalizePublicKey(publicKeyPEM)
	if err != nil {
		return TrustPackageKeyResult{}, err
	}
	fingerprint := plugintrust.Fingerprint(normalized)
	if expected := strings.TrimSpace(expectedFingerprint); expected != "" && !strings.EqualFold(expected, fingerprint) {
		return TrustPackageKeyResult{}, pluginerr.New("plugin_signature_key_invalid",
			fmt.Sprintf("公钥指纹不匹配：期望 %s，实际 %s", expected, fingerprint))
	}
	store, err := plugintrust.NewTrustStore(aiHomeDir)
	if err != nil {
		return TrustPackageKeyResult{}, pluginerr.New("plugin_home_unavailable", "插件数据根不可用")
	}
	keys, err := store.Read()
	if err != nil {
		return TrustPackageKeyResult{}, err
	}
	previous, present := keys[info.KeyID]
	if present && previous != normalized && !replace {
		return TrustPackageKeyResult{}, pluginerr.New("plugin_signature_key_conflict",
			fmt.Sprintf("keyId %s 已登记为另一把公钥；确认要替换请加 --replace-key", info.KeyID))
	}
	added, err := store.Add(plugintrust.AddInput{PublicKey: normalized, KeyID: info.KeyID})
	if err != nil {
		return TrustPackageKeyResult{}, err
	}
	return TrustPackageKeyResult{
		KeyID:       added.KeyID,
		Fingerprint: added.Fingerprint,
		Replaced:    present && previous != normalized,
	}, nil
}
