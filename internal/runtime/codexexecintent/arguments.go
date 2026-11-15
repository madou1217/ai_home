package codexexecintent

import (
	"fmt"
	"path/filepath"
	"strings"
)

type invocation struct {
	args                    []string
	appArgs                 []string
	resumeAt, identityAt    int
	lastAt                  []int
	identity, profile, cwd  string
	last, all, ignoreConfig bool
}

var valueFlags = map[string]bool{"-c": true, "--config": true, "--enable": true, "--disable": true, "-m": true, "--model": true, "-p": true, "--profile": true, "-s": true, "--sandbox": true, "-C": true, "--cd": true, "--add-dir": true, "-a": true, "--ask-for-approval": true, "-i": true, "--image": true, "-o": true, "--output-last-message": true, "--output-schema": true, "--color": true, "--thread-source": true, "--cyber-access-program": true}

// parse recognizes only exec/e resume, never a prompt merely containing resume.
// The literal -- ends option recognition, including any apparent -c afterwards.
func parse(args []string, cwd string) (invocation, bool, error) {
	out := invocation{args: append([]string(nil), args...), resumeAt: -1, identityAt: -1, cwd: cwd, appArgs: []string{"app-server", "--listen", "stdio://"}}
	stage := 0
	unknownOption := false
	worktree := false
	literal := false
	for i := 0; i < len(args); i++ {
		token := args[i]
		if !literal && token == "--" {
			if stage < 2 {
				return out, false, nil
			}
			literal = true
			continue
		}
		if !literal && (token == "--help" || token == "-h" || token == "--version" || token == "-V") {
			return out, false, nil
		}
		if !literal && token != "-" && strings.HasPrefix(token, "-") {
			flag, value, inline := strings.Cut(token, "=")
			if flag == "--remote" || flag == "--remote-auth-token-env" || flag == "--oss" || flag == "--local-provider" {
				return out, false, nil
			}
			if !strings.HasPrefix(token, "--") && len(token) > 2 && valueFlags[token[:2]] {
				flag = token[:2]
				value = strings.TrimPrefix(token[2:], "=")
				inline = true
			}
			if valueFlags[flag] {
				if !inline {
					if i+1 >= len(args) {
						return out, false, fmt.Errorf("codex_exec_intent_argument_missing")
					}
					i++
					value = args[i]
				}
				switch flag {
				case "-c", "--config":
					out.appArgs = append(out.appArgs, "-c", value)
				case "--enable", "--disable":
					out.appArgs = append(out.appArgs, flag, value)
				case "-m", "--model":
					out.appArgs = append(out.appArgs, "-c", "model="+quote(value))
				case "-p", "--profile":
					out.profile = value
				case "-C", "--cd":
					if filepath.IsAbs(value) {
						out.cwd = filepath.Clean(value)
					} else {
						out.cwd = filepath.Join(cwd, value)
					}
				}
				continue
			}
			switch token {
			case "--last":
				out.last = true
				out.lastAt = append(out.lastAt, i)
			case "--all":
				out.all = true
			case "--ignore-user-config":
				out.ignoreConfig = true
			case "--json", "--skip-git-repo-check", "--ignore-rules", "--ephemeral", "--strict-config", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust":
				// Native owns these switches; no launch-control side effect.
			case "--worktree":
				worktree = true
			default:
				unknownOption = true
			}
			continue
		}
		if stage == 0 {
			if token != "exec" && token != "e" {
				return out, false, nil
			}
			stage = 1
			continue
		}
		if stage == 1 {
			if token != "resume" {
				return out, false, nil
			}
			stage = 2
			out.resumeAt = i
			continue
		}
		if out.identityAt < 0 {
			out.identityAt = i
			out.identity = token
		}
		// Remaining positionals are a native prompt; never interpret their content.
	}
	if stage != 2 {
		return out, false, nil
	}
	if unknownOption {
		return out, false, fmt.Errorf("codex_exec_intent_option_unrecognized")
	}
	if worktree {
		return out, false, fmt.Errorf("codex_exec_worktree_intent_unsupported")
	}
	if out.last {
		out.identity = ""
		out.identityAt = -1
	}
	if !out.last && out.identity == "" {
		return out, false, fmt.Errorf("codex_exec_resume_identity_required")
	}
	return out, true, nil
}

func (v invocation) pinned(id string) []string {
	out := make([]string, 0, len(v.args)+1)
	for i, arg := range v.args {
		skip := false
		for _, at := range v.lastAt {
			if at == i {
				skip = true
			}
		}
		if skip {
			continue
		}
		if i == v.identityAt {
			arg = id
		}
		out = append(out, arg)
		if v.last && i == v.resumeAt {
			out = append(out, id)
		}
	}
	return out
}
