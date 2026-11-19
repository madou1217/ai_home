package completion

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/shellsetup"
)

const fieldSeparator = "\x1f"

const (
	suggestKindAIH     = "aih"
	suggestKindCommand = "command"
	suggestKindNone    = "none"
)

func indexOf(values []string, wanted string) int {
	for index, value := range values {
		if value == wanted {
			return index
		}
	}
	return -1
}

func sliceCapacity(length, removed int) int {
	if length <= removed {
		return 0
	}
	return length - removed
}

func takeFlag(argv []string, flag string) ([]string, bool) {
	index := indexOf(argv, flag)
	if index < 0 {
		return argv, false
	}
	rest := make([]string, 0, sliceCapacity(len(argv), 1))
	rest = append(rest, argv[:index]...)
	rest = append(rest, argv[index+1:]...)
	return rest, true
}

func splitOnSeparator(argv []string, flag string) ([]string, string) {
	index := indexOf(argv, flag)
	if index < 0 {
		return argv, ""
	}
	value := ""
	if index+1 < len(argv) {
		value = argv[index+1]
	}
	rest := make([]string, 0, sliceCapacity(len(argv), 2))
	rest = append(rest, argv[:index]...)
	if index+2 < len(argv) {
		rest = append(rest, argv[index+2:]...)
	}
	return rest, value
}

func takeShellOption(argv []string) ([]string, string) {
	rest := append([]string(nil), argv...)
	if index := indexOf(rest, "--shell"); index >= 0 {
		value := ""
		if index+1 < len(rest) {
			value = rest[index+1]
		}
		combined := make([]string, 0, sliceCapacity(len(rest), 2))
		combined = append(combined, rest[:index]...)
		if index+2 < len(rest) {
			combined = append(combined, rest[index+2:]...)
		}
		return combined, strings.ToLower(strings.TrimSpace(value))
	}
	inline := ""
	for _, token := range rest {
		if strings.HasPrefix(token, "--shell=") {
			inline = token
			break
		}
	}
	if inline == "" {
		return rest, ""
	}
	filtered := make([]string, 0, sliceCapacity(len(rest), 1))
	for _, token := range rest {
		if token == inline {
			continue
		}
		filtered = append(filtered, token)
	}
	return filtered, strings.ToLower(strings.TrimSpace(strings.TrimPrefix(inline, "--shell=")))
}

func takeCurrentOption(argv []string) ([]string, string, bool) {
	inline := ""
	for _, token := range argv {
		if strings.HasPrefix(token, "--current=") {
			inline = token
			break
		}
	}
	if inline == "" {
		return argv, "", false
	}
	filtered := make([]string, 0, sliceCapacity(len(argv), 1))
	for _, token := range argv {
		if token == inline {
			continue
		}
		filtered = append(filtered, token)
	}
	return filtered, strings.TrimPrefix(inline, "--current="), true
}

func containsControlBytes(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] == 0x7f {
			return true
		}
	}
	return false
}

func sanitizeWireField(value string) string {
	if !containsControlBytes(value) {
		return value
	}
	bytes := []byte(value)
	for index, current := range bytes {
		if current < 0x20 || current == 0x7f {
			bytes[index] = ' '
		}
	}
	return string(bytes)
}

type completeProtocolOptions struct {
	plain        bool
	shell        string
	current      string
	currentSet   bool
	historyFile  string
	stdinHistory bool
	debug        bool
	words        []string
}

// parseCompleteProtocol 只从左半侧解析协议旗标：右半侧是用户正在敲的命令行。
func parseCompleteProtocol(argv []string) completeProtocolOptions {
	options := completeProtocolOptions{}
	separator := indexOf(argv, "--")
	protocol := argv
	if separator >= 0 {
		protocol = argv[:separator]
	}
	protocol = append([]string(nil), protocol...)
	protocol, options.plain = takeFlag(protocol, "--plain")
	protocol, options.shell = takeShellOption(protocol)
	protocol, options.current, options.currentSet = takeCurrentOption(protocol)
	protocol, options.historyFile = splitOnSeparator(protocol, "--history-file")
	protocol, options.stdinHistory = takeFlag(protocol, "--history-stdin")
	protocol, options.debug = takeFlag(protocol, "--debug")
	if separator >= 0 {
		options.words = append([]string(nil), argv[separator+1:]...)
	} else {
		options.words = protocol
	}
	if options.currentSet {
		options.words = append(options.words, options.current)
	}
	return options
}

// RunComplete 实现 `aih __complete`：每行一个候选，错误退化为「没有候选」。
func RunComplete(argv []string, environment Environment) {
	options := completeProtocolOptions{}
	defer func() {
		if recovered := recover(); recovered != nil && options.debug {
			_, _ = fmt.Fprintf(environment.stderr(), "[aih] __complete failed: %v\n", recovered)
		}
	}()
	options = parseCompleteProtocol(argv)
	if len(options.words) == 0 {
		return
	}
	context := newResolverContext(environment, options.historyFile, options.stdinHistory)
	candidates := resolveCompletion(options.words, context)
	fishFormat := options.shell == "fish"
	for _, candidate := range candidates {
		if containsControlBytes(candidate.Value) {
			continue
		}
		if options.plain {
			_, _ = fmt.Fprintf(environment.stdout(), "%s\n", candidate.Value)
			continue
		}
		if fishFormat {
			_, _ = fmt.Fprintf(environment.stdout(), "%s\t%s\n", candidate.Value, sanitizeWireField(candidate.Description))
			continue
		}
		_, _ = fmt.Fprintf(
			environment.stdout(),
			"%s%s%s%s%s\n",
			candidate.Value,
			fieldSeparator,
			sanitizeWireField(candidate.Description),
			fieldSeparator,
			sanitizeWireField(candidate.Group),
		)
	}
}

type suggestProtocolOptions struct {
	inside       bool
	historyFile  string
	stdinHistory bool
	debug        bool
	tokens       []string
}

func parseSuggestProtocol(argv []string) suggestProtocolOptions {
	options := suggestProtocolOptions{}
	separator := indexOf(argv, "--")
	rest := argv
	if separator >= 0 {
		rest = argv[:separator]
	}
	rest = append([]string(nil), rest...)
	rest, options.inside = takeFlag(rest, "--inside")
	rest, options.historyFile = splitOnSeparator(rest, "--history-file")
	rest, options.stdinHistory = takeFlag(rest, "--history-stdin")
	rest, options.debug = takeFlag(rest, "--debug")
	if separator >= 0 {
		options.tokens = append([]string(nil), argv[separator+1:]...)
	} else {
		options.tokens = rest
	}
	return options
}

// RunSuggest 实现 `aih __suggest`：先写 kind 行，再写候选行。
func RunSuggest(argv []string, environment Environment) {
	options := suggestProtocolOptions{}
	writeKind := func(kind, typo string) {
		_, _ = fmt.Fprintf(environment.stdout(), "aih:kind%s%s%s%s\n", fieldSeparator, kind, fieldSeparator, typo)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			if options.debug {
				_, _ = fmt.Fprintf(environment.stderr(), "[aih] __suggest failed: %v\n", recovered)
			}
			writeKind(suggestKindNone, "")
		}
	}()
	options = parseSuggestProtocol(argv)
	if len(options.tokens) == 0 {
		writeKind(suggestKindNone, "")
		return
	}
	for _, token := range options.tokens {
		if containsControlBytes(token) {
			writeKind(suggestKindNone, "")
			return
		}
	}
	context := newResolverContext(environment, options.historyFile, options.stdinHistory)
	aihNames := make([]string, 0, 1+len(topLevelCommands)*2+len(providerNames()))
	aihNames = append(aihNames, "aih")
	aihNames = append(aihNames, listTopLevelCommandNames()...)
	aihNames = append(aihNames, providerNames()...)
	learned := loadLearnedCorrections(environment.aiHomeDir())
	var suggestions []suggestion
	if options.inside {
		universe := append(listTopLevelCommandNames(), providerNames()...)
		suggestions = suggestInsideArgv(options.tokens, universe, learned)
	} else {
		suggestions = suggestCommand(options.tokens, aihNames, context.historyEntries, learned, environment)
	}
	safe := make([]suggestion, 0, len(suggestions))
	for _, entry := range suggestions {
		unsafe := containsControlBytes(entry.Value) || containsControlBytes(entry.Reason)
		if !unsafe {
			for _, token := range entry.Argv {
				if containsControlBytes(token) {
					unsafe = true
					break
				}
			}
		}
		if unsafe {
			continue
		}
		safe = append(safe, entry)
	}
	if len(safe) == 0 {
		writeKind(suggestKindNone, "")
		return
	}
	typoIndex := 0
	if options.inside {
		typoIndex = 1
	}
	typoKey := strings.TrimSpace(safe[0].Typo)
	if typoKey == "" && typoIndex < len(options.tokens) {
		typoKey = strings.TrimSpace(options.tokens[typoIndex])
	}
	writeKind(suggestKindAIH, typoKey)
	for _, entry := range safe {
		_, _ = fmt.Fprintf(
			environment.stdout(),
			"aih:cand%s%s%s%s%s%s\n",
			fieldSeparator,
			entry.Value,
			fieldSeparator,
			entry.Reason,
			fieldSeparator,
			strings.Join(entry.Argv, fieldSeparator),
		)
	}
}

// RunLearn 记录一次用户确认过的纠正；只写文件，不输出任何内容。
func RunLearn(argv []string, environment Environment) {
	debug := false
	defer func() {
		if recovered := recover(); recovered != nil && debug {
			_, _ = fmt.Fprintf(environment.stderr(), "[aih] __learn failed: %v\n", recovered)
		}
	}()
	boundary := indexOf(argv, "--")
	left := argv
	if boundary >= 0 {
		left = argv[:boundary]
	}
	debug = containsString(left, "--debug")
	typo := ""
	if len(argv) > 0 {
		typo = strings.TrimSpace(argv[0])
	}
	var words []string
	if boundary >= 0 {
		words = append([]string(nil), argv[boundary+1:]...)
	}
	if typo == "" || len(words) == 0 {
		return
	}
	store := shellsetup.NewCorrectionsStore(environment.aiHomeDir())
	store.Record(typo, words)
}

func loadLearnedCorrections(aiHome string) map[string][]string {
	store := shellsetup.NewCorrectionsStore(aiHome)
	learned := make(map[string][]string)
	for _, correction := range store.List() {
		argv := make([]string, 0, len(correction.Argv))
		argv = append(argv, correction.Argv...)
		if len(argv) > 0 {
			learned[correction.Typo] = argv
		}
	}
	return learned
}

// newResolverContext 装配动态候选来源；全部惰性执行，`aih <TAB>` 不付数据库开销。
func newResolverContext(environment Environment, historyFile string, readStdinHistory bool) *resolverContext {
	aiHome := environment.aiHomeDir()
	hostAIHome := environment.hostAIHomeDir()
	hostHome := environment.hostHomeDir()
	return &resolverContext{
		historyEntries: loadHistoryEntries(environment, historyFile, readStdinHistory),
		historyLimit:   8,
		accountLister: func(provider string) []accountRow {
			return listCLIAccounts(aiHome, provider)
		},
		proxyLister: func() []proxyChoice {
			return listProxyCandidates(environment, aiHome)
		},
		sessionLister: func(provider, accountRef, current string) []sessionChoice {
			return listProviderSessions(environment, aiHome, hostHome, provider, accountRef, current, sessionCandidateLimit)
		},
		resumeLister: func(current string) []resumeChoice {
			return listResumeSessions(environment, aiHome, hostHome, current)
		},
		persistentLister: func(current string) []persistentChoice {
			return listPersistentSessionNames(environment, hostAIHome, hostHome, environment.cwd())
		},
		peerLister: func(_ string) []peerChoice {
			return listPeerCandidates(environment, hostHome, hostAIHome, environment.cwd())
		},
		peerMessageLister: func(_ string) []peerChoice {
			return listPeerMessageCandidates(environment, hostAIHome)
		},
		modelLister: func(request modelRequest) []modelChoice {
			return listModelCandidates(aiHome, request)
		},
		aihServerProfileID: aihServerProfileID,
		now:                environment.now(),
	}
}
