package zcoderelay

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// DeriveDeviceMid 按 Node 侧同一算法派生账号级稳定 device mid。
//
// 上游把 X-Device-Mid 当作计费/活动接口的必填参数；读不到桌面端遗留文件时不能随机，
// 否则同一账号每次请求都像换了设备。算法与 node 的 deriveZcodeDeviceMid 逐字节一致
// （含 UUIDv4 变体位）。
func DeriveDeviceMid(aiHomeDir, accountRef string) string {
	seed := "zcode-device-mid:" + aiHomeDir + ":" + accountRef
	hash := sha256.Sum256([]byte(seed))
	hexed := hex.EncodeToString(hash[:])
	variant := (hexValue(hexed[16]) & 0x3) | 0x8
	return fmt.Sprintf("%s-%s-4%s-%x%s-%s",
		hexed[0:8],
		hexed[8:12],
		hexed[13:16],
		variant,
		hexed[17:20],
		hexed[20:32],
	)
}

func hexValue(character byte) int {
	switch {
	case character >= '0' && character <= '9':
		return int(character - '0')
	case character >= 'a' && character <= 'f':
		return int(character-'a') + 10
	case character >= 'A' && character <= 'F':
		return int(character-'A') + 10
	default:
		return 0
	}
}
