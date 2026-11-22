package egress

import (
	"os"
	"strings"
)

func isValidCoreFile(statFn func(string) (os.FileInfo, error), filePath string) bool {
	if strings.TrimSpace(filePath) == "" {
		return false
	}
	info, err := statFn(filePath)
	if err != nil {
		return false
	}
	// 拒绝目录与 0 字节占位文件（Clash Verge 的 verge-mihomo 常见 0 字节占位）。
	return !info.IsDir() && info.Size() > 0
}
