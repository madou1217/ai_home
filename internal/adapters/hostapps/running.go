package hostapps

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// Account 是运行态匹配所需的账号身份。
type Account struct {
	Provider   string
	AccountRef string
	// Desktop 表示该 Provider 声明了桌面客户端；未声明的账号不参与桌面匹配。
	Desktop bool
}

// Running 是一次完整匹配的结果。
//
// PIDs 的键是账号引用；DesktopAccounts / CLIAccounts 是同一集合的稳定排序投影，
// 供只关心「哪些账号在跑」的调用方使用。
type Running struct {
	DesktopPIDs     map[string][]int
	CLIPIDs         map[string][]int
	DesktopAccounts []string
	CLIAccounts     []string
}

// Running 扫描宿主进程并与账号身份匹配。
//
// accounts 由调用方按 Provider 合同准备（只传存在账号引用的记录）；cliAliases 的键
// 是 provider + NUL + cliAccountId，用于补全没有写账号引用标记的历史 CLI 进程。
// 任一扫描失败都按「该类别没有运行中的账号」降级，与 Node 的容错口径一致。
func (scanner *Scanner) Running(
	ctx context.Context,
	accounts []Account,
	aiHomeDir string,
	cliAliases map[string]string,
) Running {
	running := Running{
		DesktopPIDs: map[string][]int{},
		CLIPIDs:     map[string][]int{},
	}
	desktopInstances, desktopErr := scanner.ListDesktopInstances(ctx)
	if desktopErr == nil {
		running.DesktopPIDs = matchDesktopAccounts(desktopInstances, accounts, aiHomeDir, scanner.Platform)
	}
	cliInstances, cliErr := scanner.ListCLIInstances(ctx)
	if cliErr == nil {
		running.CLIPIDs = matchCLIAccounts(cliInstances, cliAliases)
	}
	running.DesktopAccounts = sortedKeys(running.DesktopPIDs)
	running.CLIAccounts = sortedKeys(running.CLIPIDs)
	return running
}

func matchDesktopAccounts(
	instances []DesktopInstance,
	accounts []Account,
	aiHomeDir string,
	platform string,
) map[string][]int {
	matched := make(map[string][]int)
	if len(instances) == 0 {
		return matched
	}
	for _, account := range accounts {
		if !account.Desktop {
			continue
		}
		accountRef := NormalizeAccountRef(account.AccountRef)
		if accountRef == "" {
			continue
		}
		targetUserDataDir := UserDataDir(aiHomeDir, account.Provider, accountRef)
		applicationName := strings.ToLower(ApplicationName(account.Provider, accountRef))
		if targetUserDataDir == "" && applicationName == "" {
			continue
		}
		for _, instance := range instances {
			if instanceMatchesDesktop(instance, targetUserDataDir, applicationName, platform) {
				matched[accountRef] = appendUniquePID(matched[accountRef], instance.PID)
			}
		}
	}
	return matched
}

func instanceMatchesDesktop(
	instance DesktopInstance,
	targetUserDataDir string,
	applicationName string,
	platform string,
) bool {
	if targetUserDataDir != "" && instance.UserDataDir != "" {
		candidate := instance.UserDataDir
		target := targetUserDataDir
		if platform == PlatformWindows {
			candidate = strings.ToLower(candidate)
			target = strings.ToLower(target)
		}
		if candidate == target {
			return true
		}
	}
	if applicationName != "" {
		return strings.ToLower(strings.TrimSpace(instance.ApplicationName)) == applicationName
	}
	return false
}

func matchCLIAccounts(instances []CLIInstance, cliAliases map[string]string) map[string][]int {
	matched := make(map[string][]int)
	for _, instance := range instances {
		accountRef := NormalizeAccountRef(instance.AccountRef)
		if accountRef == "" && cliAliases != nil && instance.CLIAccountID != "" {
			accountRef = NormalizeAccountRef(cliAliases[cliAliasKey(instance.Provider, instance.CLIAccountID)])
		}
		if accountRef == "" {
			continue
		}
		matched[accountRef] = appendUniquePID(matched[accountRef], instance.PID)
	}
	return matched
}

func cliAliasKey(provider string, cliAccountID string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.TrimSpace(cliAccountID)
}

func buildCLIInstances(processes []Process) []CLIInstance {
	if len(processes) == 0 {
		return nil
	}
	children := make(map[int][]Process)
	byPID := make(map[int]Process, len(processes))
	marked := make([]Process, 0)
	for _, process := range processes {
		byPID[process.PID] = process
		children[process.PPID] = append(children[process.PPID], process)
		_, _, nativeRef := parseNativeTerminalInvocation(process.CommandLine)
		if assignmentValue(process.CommandLine, AccountAppMarkerEnv) == "1" || nativeRef != "" {
			marked = append(marked, process)
		}
	}
	// Protect native descendants across every overlapping legacy-root view. A
	// marked shell parent may otherwise emit the same PID again as a legacy row.
	nativePIDs := make(map[int]bool)
	for _, process := range processes {
		if _, _, nativeRef := parseNativeTerminalInvocation(process.CommandLine); nativeRef != "" {
			for _, member := range collectFamily(process, children) {
				nativePIDs[member.PID] = true
			}
		}
	}
	output := make([]CLIInstance, 0, len(marked))
	seen := make(map[string]bool)
	for _, root := range marked {
		family := collectFamily(root, children)
		familyNative := false
		for _, member := range family {
			if nativePIDs[member.PID] {
				familyNative = true
				break
			}
		}
		provider := ""
		cliAccountID := ""
		for _, process := range family {
			if candidateProvider, candidateID := parseCLIInvocation(process.CommandLine); candidateProvider != "" {
				provider = candidateProvider
				cliAccountID = candidateID
				break
			}
		}
		if provider == "" {
			continue
		}
		accountRef := ""
		for _, process := range family {
			if _, _, nativeRef := parseNativeTerminalInvocation(process.CommandLine); nativeRef != "" {
				accountRef = nativeRef
				break
			}
			if candidate := assignmentValue(process.CommandLine, ProviderAccountRefEnv); candidate != "" {
				accountRef = candidate
				break
			}
		}
		for _, process := range family {
			key := strconv.Itoa(root.PID) + ":" + strconv.Itoa(process.PID)
			if seen[key] {
				continue
			}
			seen[key] = true
			output = append(output, CLIInstance{
				PID:          process.PID,
				PPID:         process.PPID,
				Provider:     provider,
				CLIAccountID: cliAccountID,
				AccountRef:   accountRef,
				RootPID:      root.PID,
				NativeOwned:  familyNative || nativePIDs[process.PID],
			})
		}
	}
	return output
}

// collectFamily 返回根进程及其全部后代；根进程自身即使在父子关系里丢失也保留。
func collectFamily(root Process, children map[int][]Process) []Process {
	family := make([]Process, 0, 4)
	seen := make(map[int]bool)
	queue := []Process{root}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if seen[current.PID] {
			continue
		}
		seen[current.PID] = true
		family = append(family, current)
		queue = append(queue, children[current.PID]...)
	}
	return family
}

// assignmentValue 从命令行读取 NAME=value（兼容 set "NAME=value" 与引号值）。
func assignmentValue(commandLine string, name string) string {
	if name == "" {
		return ""
	}
	needle := name + "="
	searchFrom := 0
	for {
		index := strings.Index(commandLine[searchFrom:], needle)
		if index < 0 {
			return ""
		}
		position := searchFrom + index
		before := byte(' ')
		if position > 0 {
			before = commandLine[position-1]
		}
		if before == ' ' || before == '\t' || before == '"' || before == '\'' || before == ';' || before == '&' {
			rest := commandLine[position+len(needle):]
			if strings.HasPrefix(rest, "\"") {
				rest = rest[1:]
				if end := strings.IndexAny(rest, "\"'"); end >= 0 {
					return strings.TrimSpace(rest[:end])
				}
			}
			if end := strings.IndexAny(rest, " \t\r\n;&\"'"); end >= 0 {
				return strings.TrimSpace(rest[:end])
			}
			return strings.TrimSpace(rest)
		}
		searchFrom = position + len(needle)
	}
}

// parseCLIInvocation 从命令行识别 aih / ai-home.js 的 <provider> <cliAccountId> 调用。
func parseCLIInvocation(commandLine string) (string, string) {
	if provider, accountID, ref := parseNativeTerminalInvocation(commandLine); ref != "" {
		return provider, accountID
	}
	tokens := splitCommandLine(commandLine)
	for index := 0; index < len(tokens); index++ {
		name := strings.ToLower(executableBase(tokens[index]))
		if name != "ai-home.js" && name != "aih" && name != "aih.cmd" {
			continue
		}
		if index+2 >= len(tokens) {
			return "", ""
		}
		provider := strings.ToLower(strings.TrimSpace(tokens[index+1]))
		accountID := strings.TrimSpace(tokens[index+2])
		if !isProviderToken(provider) || !isCLIAccountID(accountID) {
			return "", ""
		}
		return provider, accountID
	}
	return "", ""
}

// parseNativeTerminalInvocation reads only the narrow public identity flags of
// an actual aih-go lifecycle process. Flags after -- belong to the provider and
// cannot spoof identity. Existing Node title parsing remains unchanged.
func parseNativeTerminalInvocation(commandLine string) (string, string, string) {
	tokens := splitCommandLine(commandLine)
	if len(tokens) < 3 {
		return "", "", ""
	}
	name := strings.ToLower(executableBase(tokens[0]))
	if name != "aih-go" && name != "aih-go.exe" {
		return "", "", ""
	}
	if tokens[1] != "__native-terminal" || (tokens[2] != "launch" && tokens[2] != "inner") {
		return "", "", ""
	}
	var provider, accountID, accountRef string
	for index := 3; index+1 < len(tokens); index++ {
		if tokens[index] == "--" {
			break
		}
		switch tokens[index] {
		case "--provider":
			provider = tokens[index+1]
			index++
		case "--account-id":
			accountID = tokens[index+1]
			index++
		case "--account-ref":
			accountRef = tokens[index+1]
			index++
		}
	}
	if !isProviderToken(provider) || !isCLIAccountID(accountID) || len(accountRef) != 25 || !strings.HasPrefix(accountRef, "acct_") {
		return "", "", ""
	}
	for _, char := range accountRef[5:] {
		if !(char >= 'a' && char <= 'f' || char >= '0' && char <= '9') {
			return "", "", ""
		}
	}
	return provider, accountID, accountRef
}

func splitCommandLine(commandLine string) []string {
	tokens := make([]string, 0, 8)
	var current strings.Builder
	var quote byte
	for index := 0; index < len(commandLine); index++ {
		character := commandLine[index]
		if quote != 0 {
			if character == quote {
				quote = 0
				continue
			}
			current.WriteByte(character)
			continue
		}
		switch character {
		case '\'', '"':
			quote = character
		case ' ', '\t', '\r', '\n':
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
		default:
			current.WriteByte(character)
		}
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func isProviderToken(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func isCLIAccountID(value string) bool {
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, accountRefPrefix) {
		return isAccountRef(value)
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func appendUniquePID(pids []int, pid int) []int {
	if pid <= 0 {
		return pids
	}
	for _, existing := range pids {
		if existing == pid {
			return pids
		}
	}
	return append(pids, pid)
}

func sortedKeys(values map[string][]int) []string {
	keys := make([]string, 0, len(values))
	for key, pids := range values {
		if len(pids) > 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}
