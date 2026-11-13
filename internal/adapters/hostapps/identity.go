package hostapps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strconv"
	"strings"
)

// 与 Node 的 instance name 派生保持逐字一致：桌面端会把它写进进程标题，
// 进程扫描只能按这个规则反解账号身份。
const (
	zcodeInstancePrefix = "ZCode-"
	kiroInstancePrefix  = "aih-kiro_cli_desktop-"
	userDataFlag        = "--user-data-dir="
	accountRefPrefix    = "acct_"
)

// ApplicationName 返回某账号桌面实例的稳定应用名；没有改写进程标题的 Provider 返回空。
//
// zcode 的单实例锁按 application name 判重（不是 --user-data-dir），kiro 原生 GUI
// 用 exec -a 改写标题；两者都必须与 Node lib/server/desktop-launch 的派生逐字一致，
// 否则运行态映射会漏账号。
func ApplicationName(provider string, accountRef string) string {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	normalizedRef := NormalizeAccountRef(accountRef)
	if normalizedRef == "" {
		return ""
	}
	switch normalizedProvider {
	case "zcode":
		sum := sha256.Sum256([]byte(normalizedRef))
		return zcodeInstancePrefix + hex.EncodeToString(sum[:])[:8]
	case "kiro":
		return kiroInstancePrefix + normalizedRef
	}
	return ""
}

// NormalizeAccountRef 与 Node 的 normalizeProviderAccountRef 同语义。
func NormalizeAccountRef(value string) string {
	normalized := strings.TrimSpace(value)
	if !isAccountRef(normalized) {
		return ""
	}
	return normalized
}

// isAccountRef 要求 acct_ + 20 位小写十六进制。
func isAccountRef(value string) bool {
	if !strings.HasPrefix(value, accountRefPrefix) || len(value) != len(accountRefPrefix)+20 {
		return false
	}
	for _, character := range value[len(accountRefPrefix):] {
		if (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') {
			continue
		}
		return false
	}
	return true
}

// ProfileDir 返回账号投影目录（AIH_HOME/run/auth-projections/<provider>/<ref>）。
func ProfileDir(aiHomeDir string, provider string, accountRef string) string {
	root := strings.TrimSpace(aiHomeDir)
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	normalizedRef := NormalizeAccountRef(accountRef)
	if root == "" || normalizedProvider == "" || normalizedRef == "" {
		return ""
	}
	return filepath.Join(root, "run", "auth-projections", normalizedProvider, normalizedRef)
}

// UserDataDir 返回账号桌面实例的 Electron user-data 目录。
func UserDataDir(aiHomeDir string, provider string, accountRef string) string {
	profile := ProfileDir(aiHomeDir, provider, accountRef)
	if profile == "" {
		return ""
	}
	return filepath.Join(profile, "electron-user-data")
}

// parseUserDataDir 从命令行提取 --user-data-dir 的值（兼容整段引号与逐词引号）。
//
// Node spawn 对含空格的参数会整段加引号（"--user-data-dir=C:\\a b"），
// 因此先按整段引号匹配，再退回普通 token。
func parseUserDataDir(commandLine string) string {
	text := strings.TrimSpace(commandLine)
	if text == "" {
		return ""
	}
	quotedToken := "\"" + userDataFlag
	if index := strings.Index(text, quotedToken); index >= 0 {
		rest := text[index+len(quotedToken):]
		if end := strings.Index(rest, "\""); end >= 0 {
			return rest[:end]
		}
	}
	index := strings.Index(text, userDataFlag)
	if index < 0 {
		return ""
	}
	rest := text[index+len(userDataFlag):]
	if strings.HasPrefix(rest, "\"") {
		rest = rest[1:]
		if end := strings.Index(rest, "\""); end >= 0 {
			return rest[:end]
		}
		return rest
	}
	if end := strings.IndexAny(rest, " \t\r\n"); end >= 0 {
		return rest[:end]
	}
	return rest
}

// parseApplicationName 从命令行首个 token 的可执行文件名反解改写过的应用名。
func parseApplicationName(commandLine string) string {
	name := executableBase(firstToken(commandLine))
	if name == "" {
		return ""
	}
	if strings.HasPrefix(name, zcodeInstancePrefix) {
		suffix := name[len(zcodeInstancePrefix):]
		if isLowerHex(suffix, 8) {
			return zcodeInstancePrefix + strings.ToLower(suffix)
		}
		return ""
	}
	if strings.HasPrefix(name, kiroInstancePrefix) {
		suffix := name[len(kiroInstancePrefix):]
		if isAccountRef(suffix) {
			return kiroInstancePrefix + strings.ToLower(suffix)
		}
	}
	return ""
}

// executableBase 同时接受 POSIX 与 Windows 分隔符：进程事实可能来自另一套路径写法。
func executableBase(executable string) string {
	if index := strings.LastIndexAny(executable, "/\\"); index >= 0 {
		return executable[index+1:]
	}
	return executable
}

func isLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, character := range strings.ToLower(value) {
		if (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') {
			continue
		}
		return false
	}
	return true
}

// firstToken 取命令行第一个 argv；支持单双引号包裹。
func firstToken(commandLine string) string {
	text := strings.TrimSpace(commandLine)
	if text == "" {
		return ""
	}
	if text[0] == '"' || text[0] == '\'' {
		quote := text[0]
		if end := strings.IndexByte(text[1:], quote); end >= 0 {
			return text[1 : end+1]
		}
		return text[1:]
	}
	if end := strings.IndexAny(text, " \t\r\n"); end >= 0 {
		return text[:end]
	}
	return text
}

// withMacUserDataDirs 在 macOS 上按 Provider 合同反读进程环境变量里的 user-data 目录。
//
// 部分 Electron 应用不把 --user-data-dir 放进 argv，只认自己的环境变量；此时 ps 的
// 普通模式看不到身份。规则来自 DesktopClient.UserDataEnvKey + MacOS.PathIncludes，
// 与 Node lib/runtime/desktop-process-user-data.js 同口径：只有恰好一条规则命中
// 可执行文件路径时才反读，避免把别人的进程认成账号实例。
func (scanner *Scanner) withMacUserDataDirs(ctx context.Context, processes []Process) []Process {
	if len(scanner.EnvRules) == 0 {
		return processes
	}
	type candidate struct {
		envKey     string
		executable string
	}
	candidates := make(map[int]candidate)
	for _, process := range processes {
		if parseUserDataDir(process.CommandLine) != "" || parseApplicationName(process.CommandLine) != "" {
			continue
		}
		// 与 Node macDesktopExecutable 同口径：只认「无参数、以 / 开头的 .app 主进程」，
		// 有参数说明 argv 还在，user-data 会体现在 --user-data-dir 里。
		executable := macDesktopExecutable(process.CommandLine)
		if executable == "" {
			continue
		}
		matchedKey := ""
		matchedCount := 0
		for _, rule := range scanner.EnvRules {
			if !validEnvKey(rule.EnvKey) {
				continue
			}
			for _, fragment := range rule.PathIncludes {
				if fragment != "" && strings.Contains(executable, fragment) {
					matchedKey = rule.EnvKey
					matchedCount++
					break
				}
			}
		}
		if matchedCount == 1 && matchedKey != "" {
			candidates[process.PID] = candidate{envKey: matchedKey, executable: executable}
		}
	}
	if len(candidates) == 0 {
		return processes
	}
	orderedPIDs := make([]string, 0, len(candidates))
	for pid := range candidates {
		if pid > 0 {
			orderedPIDs = append(orderedPIDs, strconv.Itoa(pid))
		}
	}
	if len(orderedPIDs) == 0 {
		return processes
	}
	output, err := scanner.run(ctx, "ps", "eww", "-p", strings.Join(orderedPIDs, ","), "-o", "pid=,command=")
	if err != nil {
		return processes
	}
	identities := make(map[int]string)
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, " ", 2)
		if len(fields) < 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(strings.TrimSpace(fields[0]))
		if pidErr != nil || pid <= 0 {
			continue
		}
		entry, found := candidates[pid]
		if !found || entry.envKey == "" {
			continue
		}
		command := strings.TrimSpace(fields[1])
		if !strings.HasPrefix(command, entry.executable+" ") {
			continue
		}
		environment := command[len(entry.executable)+1:]
		if !validEnvKey(strings.SplitN(environment, "=", 2)[0]) {
			continue
		}
		if value := environmentValue(environment, entry.envKey); strings.HasPrefix(value, "/") {
			identities[pid] = value
		}
	}
	if len(identities) == 0 {
		return processes
	}
	enriched := make([]Process, len(processes))
	copy(enriched, processes)
	for index := range enriched {
		if value := identities[enriched[index].PID]; value != "" {
			enriched[index].UserDataDir = value
		}
	}
	return enriched
}

// macDesktopExecutable 返回「无参数、以 / 开头的 .app 主进程」的完整命令行；
// 其余情况返回空。判定与 Node lib/runtime/desktop-process-user-data.js 逐条一致。
func macDesktopExecutable(commandLine string) string {
	text := strings.TrimSpace(commandLine)
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	marker := ".app/Contents/MacOS/"
	index := strings.Index(text, marker)
	if index < 0 {
		return ""
	}
	tail := text[index+len(marker):]
	if tail == "" {
		return ""
	}
	for _, character := range tail {
		if character == ' ' || character == '\t' || character == '\r' || character == '\n' || character == '/' {
			return ""
		}
	}
	return text
}

// environmentValue 读取 ps eww 输出里的一个变量；要求恰好命中一次。
//
// 值本身可能带空格，因此按「下一个 NAME= 才是新变量」合并字段，而不是按空格截断。
func environmentValue(environment string, key string) string {
	values := make([]string, 0, 1)
	currentKey := ""
	var current strings.Builder
	flush := func() {
		if currentKey == key {
			values = append(values, strings.TrimSpace(current.String()))
		}
		currentKey = ""
		current.Reset()
	}
	for _, field := range strings.Fields(environment) {
		name, value, found := strings.Cut(field, "=")
		if found && validEnvKey(name) {
			flush()
			currentKey = name
			current.WriteString(value)
			continue
		}
		if currentKey != "" {
			current.WriteString(" ")
			current.WriteString(field)
		}
	}
	flush()
	if len(values) != 1 {
		return ""
	}
	return strings.Trim(values[0], "\"'")
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for index, character := range key {
		if character == '_' || (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') {
			continue
		}
		if index > 0 && character >= '0' && character <= '9' {
			continue
		}
		return false
	}
	return true
}
