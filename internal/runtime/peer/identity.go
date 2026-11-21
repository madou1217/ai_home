package peer

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var sessionUUIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

type processIdentity struct {
	pid     int
	command string
}

// Parent processes, not --from / --mode, establish who is using the CLI.
func ancestorProcesses(ctx context.Context) []processIdentity {
	out := []processIdentity{}
	pid := os.Getppid()
	for i := 0; i < 16 && pid > 1; i++ {
		probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
		raw, err := exec.CommandContext(probe, "ps", "-p", strconv.Itoa(pid), "-o", "ppid=,comm=").Output()
		cancel()
		fields := strings.Fields(string(raw))
		if err != nil || len(fields) < 2 {
			break
		}
		out = append(out, processIdentity{pid: pid, command: filepath.Base(strings.Join(fields[1:], " "))})
		parent, _ := strconv.Atoi(fields[0])
		if parent == pid {
			break
		}
		pid = parent
	}
	return out
}

func providerOfCommand(command string) string {
	command = strings.ToLower(command)
	for _, provider := range []string{"claude", "codex", "codebuddy", "gemini"} {
		if command == provider || strings.HasPrefix(command, provider+".") {
			return provider
		}
	}
	return ""
}

// ResolveSelf ignores arbitrary address overrides for receipt authority. A
// native ancestor wins, then the actual tmux pane's exact registry descriptor.
func ResolveSelf(ctx context.Context, targets []Target, getenv func(string) string) RecordParty {
	parents := ancestorProcesses(ctx)
	provider := ""
	for _, parent := range parents {
		if p := providerOfCommand(parent.command); p != "" && provider == "" {
			provider = p
		}
		for _, target := range targets {
			if target.Channel == "native" && target.Address == strconv.Itoa(parent.pid) {
				return target.RecordParty
			}
		}
	}
	if getenv != nil && getenv("TMUX") != "" {
		pane := getenv("TMUX_PANE")
		if tmuxPaneIDPattern.MatchString(pane) {
			probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
			raw, err := exec.CommandContext(probe, "tmux", "display-message", "-p", "-t", pane, "#{session_name}|#{pane_pid}").Output()
			cancel()
			fields := strings.Split(strings.TrimSpace(string(raw)), "|")
			name := ""
			paneOwned := false
			if len(fields) == 2 {
				name = fields[0]
				panePID, _ := strconv.Atoi(fields[1])
				for _, parent := range parents {
					if parent.pid == panePID {
						paneOwned = true
					}
				}
			}
			socket := filepath.Base(strings.Split(getenv("TMUX"), ",")[0])
			if err == nil && paneOwned {
				for _, target := range targets {
					if target.Channel == "inject" && target.Delivery != nil && target.Delivery.Socket == socket && target.Delivery.SessionName == name {
						self := target.RecordParty
						if provider == "codex" {
							self.SessionID = target.SessionID
						}
						return self
					}
				}
			}
		}
	}
	return RecordParty{Provider: provider, Name: "aih-cli", Address: "aih-cli"}
}

// SenderPermissionClass never borrows the recipient's permissions. Codex's
// latest real turn context or an explicit ancestor CLI flag can attest bypass;
// an unknown sender remains unknown and the recipient keeps its safety policy.
func SenderPermissionClass(ctx context.Context, host string, self RecordParty) string {
	parents := ancestorProcesses(ctx)
	for _, parent := range parents {
		provider := providerOfCommand(parent.command)
		if provider == "" {
			continue
		}
		argv, parentEnv, launchErr := processLaunch(parent.pid)
		if launchErr != nil {
			return ""
		}
		if provider == "codex" {
			thread := trustedCodexThread(ctx, parents, self)
			if thread != "" && filepath.Base(thread) == thread {
				root := parentEnv["CODEX_HOME"]
				if root == "" {
					root = filepath.Join(parentEnv["HOME"], providerroot.ConfigDir("codex"))
				}
				paths, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "*", "*", "*"+thread+"*.jsonl"))
				if len(paths) == 1 {
					f, err := os.Open(paths[0])
					if err == nil {
						scanner := bufio.NewScanner(f)
						scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
						mode := ""
						for scanner.Scan() {
							var event struct {
								Type    string `json:"type"`
								Payload struct {
									Approval string `json:"approval_policy"`
									Sandbox  struct {
										Type string `json:"type"`
									} `json:"sandbox_policy"`
								} `json:"payload"`
							}
							if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Type == "turn_context" {
								mode = "prompting"
								if event.Payload.Approval == "never" {
									mode = "bypass"
								}
							}
						}
						scanErr := scanner.Err()
						f.Close()
						if scanErr == nil && mode != "" {
							return mode
						}
					}
				}
			}
		}
		if provider == "codex" {
			return ""
		}
		for i := 1; i < len(argv); i++ {
			arg := argv[i]
			if arg == "--" {
				break
			}
			// Provider positional prompts terminate option attestation. Never
			// interpret text inside a prompt as a launch option.
			if !strings.HasPrefix(arg, "-") {
				break
			}
			if arg == "--dangerously-bypass-approvals-and-sandbox" || arg == "--dangerously-skip-permissions" || arg == "--permission-mode=bypassPermissions" {
				return "bypass"
			}
			if i+1 < len(argv) && (arg == "--permission-mode" || arg == "--ask-for-approval" || arg == "-a") {
				i++
				if argv[i] == "bypassPermissions" || argv[i] == "never" {
					return "bypass"
				}
				continue
			}
			// Unknown arity is not proof: stop rather than interpreting an
			// opaque option value (including a flag-shaped prompt) as bypass.
			switch arg {
			case "--model", "-m", "--settings", "--config", "-c", "--cwd", "-C", "--sandbox", "-s", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file", "--output-format", "--input-format", "--session-id", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--mcp-config", "--plugin-dir", "--tools", "--effort", "--max-turns":
				if i+1 >= len(argv) {
					return ""
				}
				i++
			case "--verbose", "--debug", "--print", "-p", "--no-session-persistence", "--disable-slash-commands", "--allow-dangerously-skip-permissions":
			default:
				return ""
			}
		}
		return "prompting"
	}
	return ""
}

// Codex app-server may host multiple tasks and only exports the thread ID to
// tool children. The fallback is the OS-bound pane registry, not a caller env
// selector, and the provider must hold its exact rollout open in its own home.
func trustedCodexThread(ctx context.Context, parents []processIdentity, self RecordParty) string {
	for _, parent := range parents {
		if providerOfCommand(parent.command) != "codex" {
			continue
		}
		_, env, err := processLaunch(parent.pid)
		if err != nil {
			return ""
		}
		thread := env["CODEX_THREAD_ID"]
		if thread == "" {
			thread = env["CODEX_SESSION_ID"]
		}
		if thread == "" && self.Provider == "codex" && self.Channel == "inject" && self.Delivery != nil {
			thread = self.SessionID
		}

		if !sessionUUIDPattern.MatchString(thread) {
			return ""
		}
		root := env["CODEX_HOME"]
		if root == "" {
			root = filepath.Join(env["HOME"], providerroot.ConfigDir("codex"))
		}
		paths, _ := filepath.Glob(filepath.Join(root, "sessions", "*", "*", "*", "*"+thread+"*.jsonl"))
		if len(paths) != 1 {
			return ""
		}
		probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
		raw, err := exec.CommandContext(probe, "lsof", "-a", "-p", strconv.Itoa(parent.pid), "-Fn", "--", paths[0]).Output()
		cancel()
		if err != nil {
			return ""
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if line == "n"+paths[0] {
				return thread
			}
		}
	}
	return ""
}
