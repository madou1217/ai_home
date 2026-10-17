package kimiidentity

import (
	"os/exec"
	"strings"
	"testing"
)

const testAccountRef = "acct_33b6d72c47665c11d5ef"

// TestDeriveStableDeviceIDIsDeterministic 守核心不变量。
//
// 这条取代了此前的 randomUUID 回落：同一账号必须永远同一指纹，否则上游看到的是
// 「同一账号的设备在不断变化」——最容易被标记的行为，而且静默。
func TestDeriveStableDeviceIDIsDeterministic(t *testing.T) {
	first := DeriveStableDeviceID(testAccountRef, "")
	second := DeriveStableDeviceID(testAccountRef, "")
	if first != second {
		t.Fatalf("同一账号必须派生同一 device id：%q vs %q", first, second)
	}
	if len(first) != 36 || strings.Count(first, "-") != 4 {
		t.Fatalf("必须是 uuid 形态，实际 %q", first)
	}
}

func TestDeriveStableDeviceIDVariesByAccountAndSeed(t *testing.T) {
	base := DeriveStableDeviceID(testAccountRef, "")
	other := DeriveStableDeviceID("acct_611e41c56cc531372d23", "")
	if base == other {
		t.Fatal("不同账号必须派生不同 id")
	}
	reset := DeriveStableDeviceID(testAccountRef, "seed-1")
	if reset == base {
		t.Fatal("换种子必须换指纹")
	}
	if reset != DeriveStableDeviceID(testAccountRef, "seed-1") {
		t.Fatal("同种子必须可复现")
	}
}

func TestDeriveStableDeviceIDRejectsEmptyRef(t *testing.T) {
	if DeriveStableDeviceID("", "") != "" {
		t.Fatal("空 accountRef 必须返回空（调用方据此跳过该头）")
	}
}

// TestCredentialDeviceIDWinsOverStrategy 守「凭据声明优先」。
func TestCredentialDeviceIDWinsOverStrategy(t *testing.T) {
	profile := DefaultProfile()
	profile.DeviceID = StrategyHostDerived
	headers := ResolveDeviceHeaders(testAccountRef, profile, "official-device-id", HostFacts{HostName: "host-a"})
	if headers.DeviceID != "official-device-id" {
		t.Fatalf("凭据里的 device_id 必须优先，实际 %q", headers.DeviceID)
	}
}

// TestStableDerivedDoesNotLeakHost 守「不暴露宿主信息」。
func TestStableDerivedDoesNotLeakHost(t *testing.T) {
	host := HostFacts{HostName: "secret-hostname", DeviceModel: "macOS 26.1 arm64", OSVersion: "25.1.0"}
	headers := ResolveDeviceHeaders(testAccountRef, DefaultProfile(), "", host)
	if strings.Contains(headers.DeviceName, host.HostName) {
		t.Fatal("设备名不得含宿主主机名")
	}
	if strings.Contains(headers.DeviceModel, host.OSVersion) {
		t.Fatal("设备型号不得含宿主系统版本")
	}
	if headers.OSVersion == host.OSVersion {
		t.Fatal("OS 版本不得等于宿主内核版本")
	}
	if !strings.HasPrefix(headers.DeviceName, "kimi-code-cli-") {
		t.Fatalf("设备名取产品身份前缀，实际 %q", headers.DeviceName)
	}
}

// TestHostDerivedUsesInjectedFacts 守 host-derived 策略。
func TestHostDerivedUsesInjectedFacts(t *testing.T) {
	host := HostFacts{HostName: "host-a", DeviceModel: "macOS 26.1 arm64", OSVersion: "25.1.0"}
	profile := Profile{
		DeviceID:    StrategyHostDerived,
		DeviceName:  StrategyHostDerived,
		DeviceModel: StrategyHostDerived,
		OSVersion:   StrategyHostDerived,
	}
	headers := ResolveDeviceHeaders(testAccountRef, profile, "", host)
	if headers.DeviceName != host.HostName || headers.OSVersion != host.OSVersion {
		t.Fatalf("host-derived 必须取注入的机器信息：%+v", headers)
	}
}

// TestStrategiesArePerField 守逐字段策略。
func TestStrategiesArePerField(t *testing.T) {
	profile := Profile{
		DeviceID:    StrategyStableDerived,
		DeviceName:  StrategyStableDerived,
		DeviceModel: StrategyHostDerived,
		OSVersion:   StrategyHostDerived,
	}
	headers := ResolveDeviceHeaders(testAccountRef, profile, "", HostFacts{
		DeviceModel: "macOS 26.1 arm64",
		OSVersion:   "25.1.0",
	})
	if headers.DeviceID != DeriveStableDeviceID(testAccountRef, "") {
		t.Fatal("id 必须走 stable")
	}
	if headers.DeviceModel != "macOS 26.1 arm64" {
		t.Fatal("型号必须走 host")
	}
}

// TestParseProfileFallsBackToStable 守「认不出的策略回落保守侧」。
func TestParseProfileFallsBackToStable(t *testing.T) {
	profile := ParseProfile(map[string]any{
		"deviceId":    "nonsense",
		"deviceName":  42,
		"deviceModel": nil,
	})
	if profile.DeviceID != StrategyStableDerived ||
		profile.DeviceName != StrategyStableDerived ||
		profile.DeviceModel != StrategyStableDerived {
		t.Fatalf("认不出的策略必须回落 stable-derived：%+v", profile)
	}
	if profile.OSVersion != StrategyStableDerived {
		t.Fatal("缺失字段也必须是 stable-derived")
	}
}

// TestParseProfileReadsResetSeed 守重置种子。
func TestParseProfileReadsResetSeed(t *testing.T) {
	profile := ParseProfile(map[string]any{"resetSeed": " abc123 "})
	if profile.ResetSeed != "abc123" {
		t.Fatalf("种子必须去空白，实际 %q", profile.ResetSeed)
	}
}

// TestDeviceIDMatchesNodeImplementation 守**两侧同算法**。
//
// 同一账号在 Node 路径与 Go 路径上若产生不同指纹，上游看到的是「同一账号在两台设备上
// 活动」——那本身就是风控信号。因此这里直接调 Node 实现比对，而不是各自断言。
func TestDeviceIDMatchesNodeImplementation(t *testing.T) {
	const script = `
const { deriveStableDeviceId } = require('./lib/account/device-profile');
process.stdout.write(deriveStableDeviceId(process.argv[1], process.argv[2] || ''));
`
	out, err := exec.Command("node", "-e", script, testAccountRef, "seed-1").Output()
	if err != nil {
		t.Skipf("node 不可用，跳过跨语言比对：%v", err)
	}
	nodeValue := strings.TrimSpace(string(out))
	goValue := DeriveStableDeviceID(testAccountRef, "seed-1")
	if nodeValue != goValue {
		t.Fatalf("Node 与 Go 的 device id 必须逐字节一致：node=%q go=%q", nodeValue, goValue)
	}
}
