package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const vimClipboardHeader = `" >>> aih:clipboard >>>`

const vimClipboardPluginScript = `" >>> aih:clipboard >>>
" Managed by ` + "`aih clip vim install`" + `. Re-run to update idempotently.
" Tip: paste the latest clipboard entry directly via Ex command:
"   :read !aih clip paste
"
" Commands & mappings:
"   :AIHClipPaste  - insert latest clipboard item
"   :AIHClipPick   - open clipboard picker
"   <C-X><C-V>     - call AIHClipPick()

if exists('g:loaded_aih_clipboard')
  finish
endif
let g:loaded_aih_clipboard = 1

function! s:aih_clip_insert(text) abort
  if empty(a:text)
    return
  endif
  let l:saved_reg = getreg('"')
  let l:saved_type = getregtype('"')
  try
    call setreg('"', a:text, 'c')
    if mode() =~# '^[iR]'
      execute "normal! \<C-R>\""
    else
      normal! ""p
    endif
  finally
    call setreg('"', l:saved_reg, l:saved_type)
  endtry
endfunction

function! s:aih_clip_fetch(selector) abort
  if !executable('aih')
    echohl WarningMsg | echomsg '[aih-clipboard] aih binary not found in PATH' | echohl None
    return ''
  endif
  let l:cmd = empty(a:selector) ? 'aih clip paste' : ('aih clip paste ' . shellescape(a:selector))
  let l:out = system(l:cmd)
  if v:shell_error != 0
    echohl WarningMsg | echomsg '[aih-clipboard] paste failed: ' . trim(l:out) | echohl None
    return ''
  endif
  return l:out
endfunction

function! AIHClipPaste() abort
  let l:text = s:aih_clip_fetch('')
  call s:aih_clip_insert(l:text)
endfunction

function! s:aih_clip_apply_choice(items, idx) abort
  if a:idx <= 0 || a:idx > len(a:items)
    return
  endif
  let l:item = a:items[a:idx - 1]
  let l:id = get(l:item, 'id', '')
  if empty(l:id)
    return
  endif
  let l:kind = get(l:item, 'kind', 'text')
  let l:content = s:aih_clip_fetch(l:id)
  if empty(l:content)
    return
  endif
  if l:kind ==# 'image' || l:kind ==# 'file'
    let l:content = substitute(l:content, '[\r\n]\+$', '', '')
  endif
  call s:aih_clip_insert(l:content)
endfunction

function! AIHClipPick() abort
  if !executable('aih')
    echohl WarningMsg | echomsg '[aih-clipboard] aih binary not found in PATH' | echohl None
    return
  endif
  let l:raw = system('aih clip ls --json --limit 50')
  if v:shell_error != 0
    echohl WarningMsg | echomsg '[aih-clipboard] failed to list items: ' . trim(l:raw) | echohl None
    return
  endif
  let l:items = json_decode(l:raw)
  if type(l:items) != v:t_list || empty(l:items)
    echomsg '[aih-clipboard] no clipboard items'
    return
  endif
  let l:labels = []
  for l:item in l:items
    let l:pin = get(l:item, 'pinned', v:false) ? '*' : ' '
    let l:label = printf('#%d %s [%s] %s',
          \ get(l:item, 'index', 0),
          \ l:pin,
          \ get(l:item, 'kind', 'text'),
          \ strcharpart(get(l:item, 'preview', ''), 0, 72))
    call add(l:labels, l:label)
  endfor
  if exists('*popup_menu')
    call popup_menu(l:labels, {
          \ 'title': ' AIH Clipboard ',
          \ 'border': [],
          \ 'padding': [0, 1, 0, 1],
          \ 'callback': {_, idx -> s:aih_clip_apply_choice(l:items, idx)},
          \ })
  else
    let l:numbered = ['AIH Clipboard (choose number, 0 to cancel):']
    let l:i = 1
    for l:label in l:labels
      call add(l:numbered, printf('%2d. %s', l:i, l:label))
      let l:i += 1
    endfor
    let l:choice = inputlist(l:numbered)
    call s:aih_clip_apply_choice(l:items, l:choice)
  endif
endfunction

command! AIHClipPaste call AIHClipPaste()
command! AIHClipPick call AIHClipPick()

nnoremap <silent> <C-X><C-V> :call AIHClipPick()<CR>
inoremap <silent> <C-X><C-V> <C-O>:call AIHClipPick()<CR>
" <<< aih:clipboard <<<
`

func runClipVim(args []string, runtime commandRuntime) error {
	if len(args) == 0 || isClipHelp(args[0]) {
		_, _ = fmt.Fprintln(runtime.stdout, "用法:")
		_, _ = fmt.Fprintln(runtime.stdout, "  aih clip vim install   # 幂等写入 ~/.vim/plugin/aih_clipboard.vim (0600)")
		_, _ = fmt.Fprintln(runtime.stdout, "  aih clip vim print     # 打印 Vim 插件脚本")
		return nil
	}
	sub := strings.ToLower(strings.TrimSpace(args[0]))
	if len(args) > 1 {
		return fmt.Errorf("unexpected arguments for `aih clip vim %s`: %s", sub, strings.Join(args[1:], " "))
	}
	switch sub {
	case "print":
		_, err := fmt.Fprint(runtime.stdout, vimClipboardPluginScript)
		return err
	case "install":
		return installClipVimPlugin(runtime)
	default:
		return fmt.Errorf("unknown subcommand for `aih clip vim`: %s (use install|print)", sub)
	}
}

func installClipVimPlugin(runtime commandRuntime) error {
	home, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return errors.New("cannot resolve user home directory")
	}
	pluginDir := filepath.Join(home, ".vim", "plugin")
	pluginPath := filepath.Join(pluginDir, "aih_clipboard.vim")

	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", pluginDir, err)
	}

	if existing, err := os.ReadFile(pluginPath); err == nil {
		if !strings.HasPrefix(string(existing), vimClipboardHeader) {
			return fmt.Errorf("%s already exists without managed header %q; refusing to overwrite", pluginPath, vimClipboardHeader)
		}
		if string(existing) == vimClipboardPluginScript {
			_ = os.Chmod(pluginPath, 0o600)
			_, _ = fmt.Fprintf(runtime.stdout, "up-to-date %s\n", pluginPath)
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	tmp, err := os.CreateTemp(pluginDir, ".aih_clipboard-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.WriteString(vimClipboardPluginScript); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, pluginPath); err != nil {
		return err
	}
	committed = true
	_, _ = fmt.Fprintf(runtime.stdout, "installed %s\n", pluginPath)
	return nil
}
