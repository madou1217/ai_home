package kimiidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// 设备指纹策略：与 Node 侧 lib/account/device-profile.js **逐字段同源**。
//
// 为什么两侧必须一致：同一账号在 Node 路径与 Go 路径上若产生不同指纹，上游看到的是
// 「同一账号在两台设备上活动」——那本身就是风控信号。因此算法、默认值、字段名都
// 必须一致，由守卫测试（test/kimi-device-profile-parity.test.js）钉住。

// Strategy 是设备指纹的取值策略。
type Strategy string

const (
	// StrategyStableDerived 从账号确定性派生，与运行机器无关（默认）。
	//
	// 同一账号永远同一指纹，Node/Go 两侧一致，迁移不变，不泄漏宿主信息。
	StrategyStableDerived Strategy = "stable-derived"
	// StrategyHostDerived 取运行机器的真实信息（历史行为）。
	StrategyHostDerived Strategy = "host-derived"
)

// Profile 是账号的设备指纹策略（逐字段可选）。
//
// 零值等价于「四字段全 stable-derived」，与 Node 侧 defaultDeviceProfile() 一致。
type Profile struct {
	DeviceID    Strategy
	DeviceName  Strategy
	DeviceModel Strategy
	OSVersion   Strategy
	// ResetSeed 是 stable-derived 的派生输入之一；换它 = 换一套确定性指纹。
	ResetSeed string
}

// DefaultProfile 返回默认策略（四字段全 stable-derived）。
func DefaultProfile() Profile {
	return Profile{
		DeviceID:    StrategyStableDerived,
		DeviceName:  StrategyStableDerived,
		DeviceModel: StrategyStableDerived,
		OSVersion:   StrategyStableDerived,
	}
}

// normalizeStrategy 归一策略值；认不出的一律回落到 stable-derived（保守侧）。
func normalizeStrategy(value string) Strategy {
	switch Strategy(strings.TrimSpace(strings.ToLower(value))) {
	case StrategyHostDerived:
		return StrategyHostDerived
	default:
		return StrategyStableDerived
	}
}

// ParseProfile 从凭据文档的 deviceProfile 字段解析策略。
//
// 缺失或形状不符时返回默认值（不报错）：策略是**可选**配置，老账号没有这个字段是正常的。
func ParseProfile(raw map[string]any) Profile {
	if raw == nil {
		return DefaultProfile()
	}
	return Profile{
		DeviceID:    normalizeStrategy(stringField(raw, "deviceId")),
		DeviceName:  normalizeStrategy(stringField(raw, "deviceName")),
		DeviceModel: normalizeStrategy(stringField(raw, "deviceModel")),
		OSVersion:   normalizeStrategy(stringField(raw, "osVersion")),
		ResetSeed:   strings.TrimSpace(stringField(raw, "resetSeed")),
	}
}

// stringField 读一个字符串字段（非字符串视为空）。
func stringField(record map[string]any, key string) string {
	value, ok := record[key].(string)
	if !ok {
		return ""
	}
	return value
}

// 与 Node 侧一致的中性取值。
//
// 刻意**不**暴露宿主信息，也刻意**不**伪装成某个具体型号（那会让「所有账号都是同一台
// 机器」成为可被关联的特征）。
const (
	stableDeviceNamePrefix = "kimi-code-cli"
	stableDeviceModel      = "kimi-code-cli"
	stableOSVersion        = "1.0.0"
)

// DeriveStableDeviceID 从账号确定性派生设备 id（与 Node 侧 deriveStableDeviceId 同算法）。
//
// 算法：sha256("aih-device:" + accountRef + ":" + resetSeed) 取前 32 位十六进制，
// 按 uuid 分段（8-4-4-4-12）。**确定性**是关键——它取代了此前的随机回落，
// 后者会让同一账号每请求换一个指纹。
func DeriveStableDeviceID(accountRef string, resetSeed string) string {
	normalizedRef := strings.TrimSpace(accountRef)
	if normalizedRef == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("aih-device:" + normalizedRef + ":" + strings.TrimSpace(resetSeed)))
	digest := hex.EncodeToString(sum[:])[:32]
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		digest[0:8], digest[8:12], digest[12:16], digest[16:20], digest[20:32])
}

// HostFacts 是 host-derived 策略需要的运行机器信息。
//
// 由调用方注入（Go 侧不直接读 os 包）：这样测试可确定，也避免在核心包里散落
// 平台判断。
type HostFacts struct {
	HostName    string
	DeviceModel string
	OSVersion   string
}

// DeviceHeaders 是按策略解析出的设备指纹。
type DeviceHeaders struct {
	DeviceID    string
	DeviceName  string
	DeviceModel string
	OSVersion   string
}

// ResolveDeviceHeaders 按策略解析设备指纹（与 Node 侧 resolveDeviceHeaders 同语义）。
//
// credentialDeviceID 是凭据里声明的 device_id —— **官方签发，任何策略都不覆盖**：
// 那是账号自己的设备身份，改它等于伪装成另一台设备。
func ResolveDeviceHeaders(
	accountRef string,
	profile Profile,
	credentialDeviceID string,
	host HostFacts,
) DeviceHeaders {
	deviceID := strings.TrimSpace(credentialDeviceID)
	if deviceID == "" {
		if profile.DeviceID == StrategyHostDerived {
			deviceID = strings.TrimSpace(host.HostName)
		} else {
			deviceID = DeriveStableDeviceID(accountRef, profile.ResetSeed)
		}
	}

	deviceName := stableDeviceNamePrefix + "-" + firstN(deviceID, 8)
	if profile.DeviceName == StrategyHostDerived {
		deviceName = strings.TrimSpace(host.HostName)
	}
	deviceModel := stableDeviceModel
	if profile.DeviceModel == StrategyHostDerived {
		deviceModel = strings.TrimSpace(host.DeviceModel)
	}
	osVersion := stableOSVersion
	if profile.OSVersion == StrategyHostDerived {
		osVersion = strings.TrimSpace(host.OSVersion)
	}

	return DeviceHeaders{
		DeviceID:    deviceID,
		DeviceName:  deviceName,
		DeviceModel: deviceModel,
		OSVersion:   osVersion,
	}
}

// firstN 取字符串前 n 个字节（不足则整体返回）。
func firstN(value string, n int) string {
	if len(value) <= n {
		return value
	}
	return value[:n]
}

// CredentialDeviceID 从凭据文档里读官方声明的 device_id（可能为空）。
//
// 它在 deviceProfile 之外、文档顶层：官方登录时写入，**优先于任何策略** ——
// 那是账号自己的设备身份，改它等于伪装成另一台设备。
func CredentialDeviceID(payload []byte) string {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return ""
	}
	direct := strings.TrimSpace(stringField(document, "deviceId"))
	if direct != "" {
		return direct
	}
	return strings.TrimSpace(stringField(document, "device_id"))
}

// DeviceProfileSection 从凭据文档里取出 deviceProfile 段（可能为 nil）。
//
// 策略随凭据一起推送 Go，因此这里读的就是账号上配置的那一份——Node 与 Go 同源。
func DeviceProfileSection(payload []byte) map[string]any {
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil
	}
	section, ok := document["deviceProfile"].(map[string]any)
	if !ok {
		return nil
	}
	return section
}
