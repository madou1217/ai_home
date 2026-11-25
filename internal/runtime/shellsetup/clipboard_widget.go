package shellsetup

// clipboardWidget returns the shell-specific Ctrl-X Ctrl-V clipboard picker widget
// appended dynamically by Snippet() for zsh, bash, and fish (sh delegates to bash/zsh).
func clipboardWidget(shell string) string {
	switch shell {
	case "zsh":
		return `
# ---- AIH Clipboard (Ctrl-X Ctrl-V) ----
if command -v aih >/dev/null 2>&1; then
  aih-clip-paste() {
    local selected
    selected="$(aih clip pick --stdout)"
    if [[ -n "$selected" ]]; then
      LBUFFER="${LBUFFER}${selected}"
      RBUFFER="${RBUFFER}"
    fi
    zle reset-prompt
  }
  zle -N aih-clip-paste
  if [[ -o interactive ]]; then
    bindkey '^X^V' aih-clip-paste
  fi
fi
`
	case "bash":
		return `
# ---- AIH Clipboard (Ctrl-X Ctrl-V) ----
if command -v aih >/dev/null 2>&1; then
  aih-clip-paste() {
    local selected
    selected="$(aih clip pick --stdout)"
    if [ -n "$selected" ]; then
      local before="${READLINE_LINE:0:READLINE_POINT}"
      local after="${READLINE_LINE:READLINE_POINT}"
      READLINE_LINE="${before}${selected}${after}"
      READLINE_POINT=$((READLINE_POINT + ${#selected}))
    fi
  }
  if [[ $- == *i* ]]; then
    bind -x '"\C-x\C-v": aih-clip-paste'
  fi
fi
`
	case "fish":
		return `
# ---- AIH Clipboard (Ctrl-X Ctrl-V) ----
if command -v aih >/dev/null 2>&1
    function aih-clip-paste --description 'AIH Clipboard picker'
        commandline -i -- (aih clip pick --stdout)
        commandline -f repaint
    end
    if status is-interactive
        bind \cx\cv aih-clip-paste
    end
end
`
	default:
		return ""
	}
}
