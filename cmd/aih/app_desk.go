package main

// `aih app`：本机应用看台。
//
// 看台只展示通过 `aih app` 启动的实例（app-instances.json），把进程、代理、
// 租约和热替换开关放在同一屏。终端交互沿用 `aih ss` 的原始模式选择器：
// ↑/↓ 选择、space 标记、r 续约、x 结束、X 全部结束、t 热替换、d 详情。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/appproxyhealth"
	"github.com/madou1217/ai_home/internal/runtime/appproxyregion"
	"github.com/madou1217/ai_home/internal/runtime/appsessions"
	"github.com/madou1217/ai_home/internal/runtime/proxycontrol"
	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

const (
	ansiDim    = "\x1b[2m"
	ansiBold   = "\x1b[1m"
	ansiAmber  = ansiYellow
	ansiAltOn  = "\x1b[?1049h"
	ansiAltOff = "\x1b[?1049l"
	ansiHide   = "\x1b[?25l"
	ansiShow   = "\x1b[?25h"
	ansiClear  = "\x1b[2J\x1b[H"
)

var spinnerFrames = []string{"◐", "◓", "◑", "◒"}

type appDeskState struct {
	instances []appsessions.Instance
	// historyCount keeps ended launches out of the live list while still
	// telling the user they exist (aih app --history / WebUI history).
	historyCount int
	proxy        proxycontrol.Status
	proxyErr     string
	hotSwap      bool

	selected int
	marked   map[string]bool
	detail   bool

	toast      string
	toastUntil time.Time
	toastTone  string

	busy        string
	busyStart   time.Time
	confirmAll  bool
	frame       int
	initialized bool
	lastActive  bool
	reconnects  int
}

type deskActionResult struct {
	kind     string
	status   proxycontrol.Status
	results  []appsessions.KillResult
	err      error
	duration time.Duration
}

func runAppDashboard(ctx context.Context, runtime commandRuntime, aiHome string, plain bool) error {
	store := appsessions.New(aiHome)
	file, ok := runtime.stdin.(*os.File)
	interactive := !plain && ok && term.IsTerminal(int(file.Fd()))
	state := &appDeskState{marked: map[string]bool{}}
	state.refresh(ctx, store, aiHome)
	if !interactive {
		renderAppDeskPlain(runtime.stdout, state)
		return nil
	}
	return runAppDeskInteractive(ctx, runtime, store, aiHome, state)
}

func (state *appDeskState) refresh(ctx context.Context, store *appsessions.Store, aiHome string) {
	if instances, err := store.List(ctx); err == nil {
		instances = appproxyregion.Enrich(ctx, instances, aiHome)
		active, history := appsessions.SplitActive(instances)
		active = appproxyhealth.Enrich(ctx, active)
		state.instances = active
		state.historyCount = len(history)
	}
	state.proxyErr = ""
	state.proxy = proxycontrol.Status{}
	state.hotSwap = proxycontrol.LoadSettings(aiHome).HotSwap
	status := state.proxy
	if client, err := proxycontrol.Load(aiHome); err != nil {
		state.proxyErr = err.Error()
	} else if fetched, statusErr := client.Status(ctx); statusErr != nil {
		state.proxyErr = statusErr.Error()
		state.proxy = fetched
		status = fetched
	} else {
		state.proxy = fetched
		status = fetched
		state.hotSwap = fetched.HotSwap
	}
	if state.initialized {
		switch {
		case status.Reconnects > state.reconnects:
			target := status.LeaseName
			if target == "" {
				target = "新出口"
			}
			state.toast = "⚡ 上游已重连 · " + target
			state.toastTone = ansiGreen
			state.toastUntil = time.Now().Add(4 * time.Second)
		case state.lastActive && !status.LeaseActive && status.Running:
			state.toast = "⚠ 租约失效，正在重连…"
			state.toastTone = ansiAmber
			state.toastUntil = time.Now().Add(4 * time.Second)
		}
	}
	state.initialized = true
	state.lastActive = status.LeaseActive
	state.reconnects = status.Reconnects
	state.clampSelection()
}

func (state *appDeskState) clampSelection() {
	if len(state.instances) == 0 {
		state.selected = 0
		return
	}
	if state.selected >= len(state.instances) {
		state.selected = len(state.instances) - 1
	}
	if state.selected < 0 {
		state.selected = 0
	}
}

func (state *appDeskState) move(delta int) {
	if len(state.instances) == 0 {
		return
	}
	next := state.selected + delta
	if next < 0 {
		next = 0
	}
	if next >= len(state.instances) {
		next = len(state.instances) - 1
	}
	state.selected = next
}

func (state *appDeskState) current() *appsessions.Instance {
	if state.selected < 0 || state.selected >= len(state.instances) {
		return nil
	}
	return &state.instances[state.selected]
}

func (state *appDeskState) selectedIDs() []string {
	if len(state.marked) > 0 {
		ids := make([]string, 0, len(state.marked))
		for id := range state.marked {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return ids
	}
	if current := state.current(); current != nil {
		return []string{current.ID}
	}
	return nil
}

func (state *appDeskState) hasProxiedSelection() bool {
	ids := state.selectedIDs()
	if len(ids) == 0 {
		for _, instance := range state.instances {
			if instance.Proxied {
				return true
			}
		}
		return false
	}
	wanted := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		wanted[id] = struct{}{}
	}
	for _, instance := range state.instances {
		if _, ok := wanted[instance.ID]; ok && instance.Proxied {
			return true
		}
	}
	return false
}

func (state *appDeskState) liveCount() int {
	count := 0
	for _, instance := range state.instances {
		if instance.Live {
			count++
		}
	}
	return count
}

func runAppDeskInteractive(ctx context.Context, runtime commandRuntime, store *appsessions.Store, aiHome string, state *appDeskState) error {
	file, ok := runtime.stdin.(*os.File)
	if !ok {
		return errors.New("交互看台需要真实终端")
	}
	previous, err := term.MakeRaw(int(file.Fd()))
	if err != nil {
		return err
	}
	restore := func() {
		_ = term.Restore(int(file.Fd()), previous)
		_, _ = io.WriteString(runtime.stdout, ansiShow+ansiAltOff)
	}
	defer restore()
	_, _ = io.WriteString(runtime.stdout, ansiAltOn+ansiHide+ansiClear)

	keyCh := make(chan string, 16)
	keyErr := make(chan error, 1)
	go func() {
		buffer := make([]byte, 8)
		for {
			count, readErr := file.Read(buffer)
			if readErr != nil {
				keyErr <- readErr
				return
			}
			if key := parsePickerKey(buffer[:count]); key != "" {
				select {
				case keyCh <- key:
				default:
				}
			}
		}
	}()

	results := make(chan deskActionResult, 4)
	frameTicker := time.NewTicker(120 * time.Millisecond)
	defer frameTicker.Stop()
	refreshTicker := time.NewTicker(1 * time.Second)
	defer refreshTicker.Stop()

	render := func() {
		_, _ = io.WriteString(runtime.stdout, ansiClear)
		renderAppDesk(runtime.stdout, state)
	}
	render()

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-keyErr:
			return err
		case result := <-results:
			state.busy = ""
			switch result.kind {
			case "renew":
				if result.err != nil {
					state.flash("续约失败: "+result.err.Error(), ansiRed)
				} else {
					name := result.status.LeaseName
					if name == "" {
						name = "当前出口"
					}
					if result.status.Reconnects > state.reconnects {
						state.flash(fmt.Sprintf("✓ 已重连 %s · %dms", name, result.duration.Milliseconds()), ansiGreen)
					} else {
						state.flash(fmt.Sprintf("✓ 已续约 %s · %dms", name, result.duration.Milliseconds()), ansiGreen)
					}
					state.proxy = result.status
				}
			case "kill":
				if result.err != nil {
					state.flash("结束进程失败: "+result.err.Error(), ansiRed)
				} else {
					killed := 0
					for _, item := range result.results {
						if item.Killed {
							killed++
						}
					}
					state.flash(fmt.Sprintf("✓ 已结束 %d 个实例", killed), ansiGreen)
				}
			case "hot-swap":
				if result.err != nil {
					state.flash("热替换切换失败: "+result.err.Error(), ansiRed)
				} else {
					state.proxy = result.status
					if result.status.HotSwap {
						state.flash("⚡ 入口上游热替换已开启", ansiMagenta)
					} else {
						state.flash("热替换已关闭（手动恢复）", ansiAmber)
					}
				}
			}
			state.refresh(ctx, store, aiHome)
			render()
		case <-frameTicker.C:
			state.frame++
			render()
		case <-refreshTicker.C:
			state.refresh(ctx, store, aiHome)
			render()
		case key := <-keyCh:
			if state.confirmAll {
				state.confirmAll = false
				if key == "y" {
					ids := make([]string, 0, len(state.instances))
					for _, instance := range state.instances {
						if instance.Live {
							ids = append(ids, instance.ID)
						}
					}
					if len(ids) == 0 {
						state.flash("没有正在运行的实例", ansiAmber)
					} else {
						state.busy = "kill"
						state.busyStart = time.Now()
						go runDeskKill(ctx, store, ids, results)
					}
				} else {
					state.flash("已取消全部结束", ansiDim)
				}
				render()
				continue
			}
			switch key {
			case "q", "esc", "ctrl-c":
				return nil
			case "up", "k":
				state.move(-1)
			case "down", "j":
				state.move(1)
			case " ":
				if current := state.current(); current != nil {
					if state.marked[current.ID] {
						delete(state.marked, current.ID)
					} else {
						state.marked[current.ID] = true
					}
				}
			case "d":
				state.detail = !state.detail
			case "r":
				if state.busy != "" {
					break
				}
				if !state.hasProxiedSelection() {
					state.flash("选中的应用没有使用代理", ansiAmber)
					break
				}
				state.busy = "renew"
				state.busyStart = time.Now()
				go runDeskRenew(ctx, aiHome, results)
			case "x":
				if state.busy != "" {
					break
				}
				ids := state.selectedIDs()
				if len(ids) == 0 {
					state.flash("没有选中的应用", ansiAmber)
					break
				}
				state.busy = "kill"
				state.busyStart = time.Now()
				go runDeskKill(ctx, store, ids, results)
			case "X":
				if state.busy != "" {
					break
				}
				if state.liveCount() == 0 {
					state.flash("没有正在运行的实例", ansiAmber)
					break
				}
				state.confirmAll = true
				state.flash(fmt.Sprintf("再按 y 确认结束全部 %d 个运行实例（其他键取消）", state.liveCount()), ansiRed)
			case "t":
				if state.busy != "" {
					break
				}
				state.busy = "hot-swap"
				state.busyStart = time.Now()
				enabled := !state.hotSwap
				go runDeskHotSwap(ctx, aiHome, enabled, results)
			}
			render()
		}
	}
}

func (state *appDeskState) flash(message, tone string) {
	state.toast = message
	state.toastTone = tone
	state.toastUntil = time.Now().Add(4 * time.Second)
}

func runDeskRenew(ctx context.Context, aiHome string, results chan<- deskActionResult) {
	started := time.Now()
	client, err := proxycontrol.Load(aiHome)
	if err != nil {
		results <- deskActionResult{kind: "renew", err: err, duration: time.Since(started)}
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	status, renewErr := client.Renew(callCtx)
	results <- deskActionResult{kind: "renew", status: status, err: renewErr, duration: time.Since(started)}
}

func runDeskKill(ctx context.Context, store *appsessions.Store, ids []string, results chan<- deskActionResult) {
	result, err := store.Kill(ctx, ids)
	results <- deskActionResult{kind: "kill", results: result, err: err}
}

func runDeskHotSwap(ctx context.Context, aiHome string, enabled bool, results chan<- deskActionResult) {
	client, err := proxycontrol.Load(aiHome)
	if err != nil {
		// No running entry: persist so the next start uses it.
		if saveErr := proxycontrol.SaveSettings(aiHome, proxycontrol.Settings{Version: 1, HotSwap: enabled}); saveErr != nil {
			results <- deskActionResult{kind: "hot-swap", err: saveErr}
			return
		}
		results <- deskActionResult{kind: "hot-swap", status: proxycontrol.Status{HotSwap: enabled}}
		return
	}
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	status, setErr := client.SetHotSwap(callCtx, enabled)
	if setErr != nil {
		results <- deskActionResult{kind: "hot-swap", status: status, err: setErr}
		return
	}
	_ = proxycontrol.SaveSettings(aiHome, proxycontrol.Settings{Version: 1, HotSwap: enabled})
	results <- deskActionResult{kind: "hot-swap", status: status}
}

func renderAppDesk(output io.Writer, state *appDeskState) {
	proxyLine := renderProxyLine(state)
	_, _ = fmt.Fprintf(output, "%s%s AIH APP DESK %s%s\r\n", ansiBold, ansiCyan, ansiReset, ansiDim+"  通过 aih app 启动的本机实例"+ansiReset)
	_, _ = fmt.Fprintf(output, "  %s\r\n", proxyLine)
	_, _ = fmt.Fprintf(output, "%s  ──────────────────────────────────────────────────────────────────────────────%s\r\n", ansiDim, ansiReset)
	if len(state.instances) == 0 {
		_, _ = fmt.Fprintf(output, "\r\n  %s还没有通过 aih app 启动的实例。%s\r\n", ansiDim, ansiReset)
		_, _ = fmt.Fprintf(output, "  试试：%saih app \"Google Chrome\" --proxy%s\r\n", ansiCyan, ansiReset)
	} else {
		header := fmt.Sprintf("  %-3s %-24s %-16s %-26s %-10s %s", "", "APP", "PID", "PROXY / 地区", "STATE", "UPTIME")
		_, _ = fmt.Fprintf(output, "%s%s%s\r\n", ansiDim, header, ansiReset)
		for index, instance := range state.instances {
			line := renderInstanceLine(instance, index == state.selected, state.marked[instance.ID])
			_, _ = fmt.Fprintf(output, "%s\r\n", line)
		}
		if state.historyCount > 0 {
			_, _ = fmt.Fprintf(output, "  %s已结束 %d 个，已移入历史（aih app --history 查看）%s\r\n", ansiDim, state.historyCount, ansiReset)
		}
	}
	if state.detail {
		if current := state.current(); current != nil {
			_, _ = fmt.Fprintf(output, "\r\n%s  ── 详情 ─────────────────────────────────────────────────────────────────────%s\r\n", ansiDim, ansiReset)
			_, _ = fmt.Fprintf(output, "  path      %s\r\n", current.Path)
			if current.ProfileDir != "" {
				_, _ = fmt.Fprintf(output, "  profile   %s\r\n", current.ProfileDir)
			}
			if current.Proxied {
				_, _ = fmt.Fprintf(output, "  proxy     %s  (%s)\r\n", sanitizeProxyURL(current.ProxyURL), current.ProxyMode)
				if current.ProxyRegion != "" {
					_, _ = fmt.Fprintf(output, "  region    %s %s\r\n", proxyregion.Flag(current.ProxyCountry), current.ProxyRegion)
				}
				switch current.ProxyHealth {
				case "down":
					_, _ = fmt.Fprintf(output, "  %s代理已断开  %s%s\r\n", ansiAmber, current.ProxyHealthDetail, ansiReset)
				case "ok":
					_, _ = fmt.Fprintf(output, "  %s代理端口可达%s\r\n", ansiDim, ansiReset)
				}
			}
			_, _ = fmt.Fprintf(output, "  started   %s\r\n", time.UnixMilli(current.StartedAtMs).Format("2006-01-02 15:04:05"))
			if current.ExitedAtMs > 0 {
				_, _ = fmt.Fprintf(output, "  exited    %s\r\n", time.UnixMilli(current.ExitedAtMs).Format("2006-01-02 15:04:05"))
			}
			_, _ = fmt.Fprintf(output, "  id        %s\r\n", current.ID)
			if current.Adopted {
				_, _ = fmt.Fprintf(output, "  adopted   复用已有实例（单实例应用）\r\n")
			}
		}
	}
	_, _ = fmt.Fprintf(output, "%s  ──────────────────────────────────────────────────────────────────────────────%s\r\n", ansiDim, ansiReset)
	_, _ = fmt.Fprintf(output, "  %s↑/↓ 选择  space 标记  r 续约  x 结束  X 全部结束  t 热替换  d 详情  q 退出%s\r\n", ansiDim, ansiReset)
	if state.busy != "" {
		frame := spinnerFrames[state.frame%len(spinnerFrames)]
		label := map[string]string{"renew": "正在续约上游…", "kill": "正在结束进程…", "hot-swap": "正在切换热替换…"}[state.busy]
		_, _ = fmt.Fprintf(output, "  %s%s %s%s %s(%dms)%s\r\n", ansiCyan, frame, label, ansiReset, ansiDim, time.Since(state.busyStart).Milliseconds(), ansiReset)
	} else if state.toast != "" && time.Now().Before(state.toastUntil) {
		_, _ = fmt.Fprintf(output, "  %s%s%s\r\n", state.toastTone, state.toast, ansiReset)
	}
}

func renderProxyLine(state *appDeskState) string {
	status := state.proxy
	var dot, text, tone string
	switch {
	case state.proxyErr != "":
		dot, text, tone = "○", "代理入口未运行", ansiDim
	case status.Running && status.LeaseActive:
		dot, text, tone = "●", "租约活跃", ansiGreen
	case status.Running:
		dot, text, tone = "◌", "正在重连", ansiAmber
	default:
		dot, text, tone = "○", "代理入口未运行", ansiDim
	}
	name := status.LeaseName
	if name == "" {
		name = "—"
	}
	if status.Region != "" {
		name += " · " + status.Region
	}
	hotSwap := "○ off"
	if state.hotSwap {
		hotSwap = "● on"
	}
	if status.Running && !status.HotSwapAvailable {
		hotSwap = "— n/a"
	}
	return fmt.Sprintf("%s%s%s %s   %s出口%s %s%s%s   %s热替换%s %s%s%s",
		tone, dot, ansiReset, text,
		ansiDim, ansiReset, ansiBold, name, ansiReset,
		ansiDim, ansiReset, tone, hotSwap, ansiReset)
}

func renderInstanceLine(instance appsessions.Instance, selected, marked bool) string {
	marker := "  "
	if marked {
		marker = "◆ "
	}
	cursor := " "
	if selected {
		cursor = ">"
	}
	dot, dotColor := "○", ansiDim
	switch instance.Status {
	case appsessions.StatusRunning:
		dot, dotColor = "●", ansiGreen
	case appsessions.StatusStarting:
		dot, dotColor = "◌", ansiAmber
	case appsessions.StatusExited:
		dot, dotColor = "○", ansiDim
	}
	name := truncateRunes(instance.Name, 24)
	pid := "—"
	if len(instance.PIDs) > 0 {
		parts := make([]string, 0, len(instance.PIDs))
		for _, value := range instance.PIDs {
			parts = append(parts, fmt.Sprintf("%d", value))
		}
		pid = strings.Join(parts, ",")
	}
	proxyText := "—"
	if instance.Proxied {
		proxyText = "6152"
		port := proxyPort(instance.ProxyURL)
		if port != "" {
			proxyText = port
		}
		if instance.ProxyRegion != "" {
			flag := proxyregion.Flag(instance.ProxyCountry)
			if flag != "" {
				proxyText += " · " + flag
			} else {
				proxyText += " ·"
			}
			proxyText += " " + instance.ProxyRegion
		}
		if instance.ProxyHealth == "down" {
			proxyText = "⚠ " + proxyText
		}
	}
	proxyCell := fmt.Sprintf("%-26s", proxyText)
	if instance.Proxied && instance.ProxyHealth == "down" {
		proxyCell = ansiAmber + proxyCell + ansiReset
	}
	stateText := instance.Status
	stateColor := ansiDim
	if instance.Status == appsessions.StatusRunning {
		stateColor = ansiGreen
	}
	uptime := formatDeskDuration(time.Since(time.UnixMilli(instance.StartedAtMs)))
	if !instance.Live && instance.ExitedAtMs > 0 {
		uptime = "exited " + formatDeskDuration(time.UnixMilli(instance.ExitedAtMs).Sub(time.UnixMilli(instance.StartedAtMs)))
	}
	line := fmt.Sprintf("%s%s %s%s%s %-24s %-16s %s %s%-10s%s %s",
		cursor, marker,
		dotColor, dot, ansiReset,
		name, pid, proxyCell,
		stateColor, stateText, ansiReset,
		uptime)
	if selected {
		return ansiBold + line + ansiReset
	}
	return line
}

func renderAppDeskPlain(output io.Writer, state *appDeskState) {
	if len(state.instances) == 0 {
		_, _ = fmt.Fprintln(output, "还没有通过 aih app 启动的实例。")
		return
	}
	_, _ = fmt.Fprintf(output, "%-3s %-24s %-16s %-26s %-10s %s\n", "", "APP", "PID", "PROXY / 地区", "STATE", "UPTIME")
	for _, instance := range state.instances {
		pid := "—"
		if len(instance.PIDs) > 0 {
			parts := make([]string, 0, len(instance.PIDs))
			for _, value := range instance.PIDs {
				parts = append(parts, fmt.Sprintf("%d", value))
			}
			pid = strings.Join(parts, ",")
		}
		proxyText := "—"
		if instance.Proxied {
			proxyText = "6152"
			if port := proxyPort(instance.ProxyURL); port != "" {
				proxyText = port
			}
			if instance.ProxyRegion != "" {
				if flag := proxyregion.Flag(instance.ProxyCountry); flag != "" {
					proxyText += " · " + flag
				} else {
					proxyText += " ·"
				}
				proxyText += " " + instance.ProxyRegion
			}
			if instance.ProxyHealth == "down" {
				proxyText = "⚠ " + proxyText + " [代理已断开]"
			}
		}
		uptime := formatDeskDuration(time.Since(time.UnixMilli(instance.StartedAtMs)))
		if !instance.Live && instance.ExitedAtMs > 0 {
			uptime = "exited " + formatDeskDuration(time.UnixMilli(instance.ExitedAtMs).Sub(time.UnixMilli(instance.StartedAtMs)))
		}
		_, _ = fmt.Fprintf(output, "%-3s %-24s %-16s %-26s %-10s %s\n", "", truncateRunes(instance.Name, 24), pid, proxyText, instance.Status, uptime)
	}
	if state.historyCount > 0 {
		_, _ = fmt.Fprintf(output, "\n已结束 %d 个，已移入历史（aih app --history 查看）\n", state.historyCount)
	}
	_, _ = fmt.Fprintf(output, "\n代理入口: ")
	if state.proxyErr != "" || !state.proxy.Running {
		_, _ = fmt.Fprintln(output, "未运行")
		return
	}
	_, _ = fmt.Fprintf(output, "%s · 租约=%v · 热替换=%v\n", state.proxy.LeaseName, state.proxy.LeaseActive, state.proxy.HotSwap)
}

func renderAppDeskJSON(output io.Writer, state *appDeskState, aiHome string) {
	proxy := state.proxy
	proxy.HTTPURL = sanitizeProxyURL(proxy.HTTPURL)
	proxy.SOCKS5URL = sanitizeProxyURL(proxy.SOCKS5URL)
	payload := map[string]any{
		"ok":           true,
		"instances":    state.instances,
		"historyCount": state.historyCount,
		"proxy":        proxy,
		"hotSwap":      state.hotSwap,
	}
	if state.proxyErr != "" {
		payload["proxyError"] = state.proxyErr
	}
	encoded, _ := json.MarshalIndent(payload, "", "  ")
	_, _ = fmt.Fprintln(output, string(encoded))
}

// renderAppHistory lists ended launches (the live desk excludes them).
func renderAppHistory(output io.Writer, history []appsessions.Instance, asJSON bool) {
	if history == nil {
		history = []appsessions.Instance{}
	}
	if asJSON {
		payload, _ := json.MarshalIndent(map[string]any{
			"ok":      true,
			"history": history,
		}, "", "  ")
		_, _ = fmt.Fprintln(output, string(payload))
		return
	}
	if len(history) == 0 {
		_, _ = fmt.Fprintln(output, "历史里还没有已结束的实例。")
		return
	}
	_, _ = fmt.Fprintf(output, "%-24s %-30s %-20s %s\n", "APP", "PROXY / 地区", "已结束", "运行时长")
	for _, instance := range history {
		proxyText := "直连"
		if instance.Proxied {
			proxyText = "代理"
			if port := proxyPort(instance.ProxyURL); port != "" {
				proxyText = ":" + port
			}
			if instance.ProxyRegion != "" {
				if flag := proxyregion.Flag(instance.ProxyCountry); flag != "" {
					proxyText += " · " + flag
				} else {
					proxyText += " ·"
				}
				proxyText += " " + instance.ProxyRegion
			}
		}
		ended := instance.ExitedAtMs
		if ended <= 0 {
			ended = instance.StartedAtMs
		}
		duration := time.Duration(0)
		if instance.ExitedAtMs > instance.StartedAtMs {
			duration = time.UnixMilli(instance.ExitedAtMs).Sub(time.UnixMilli(instance.StartedAtMs))
		}
		_, _ = fmt.Fprintf(output, "%-24s %-30s %-20s %s\n",
			truncateRunes(instance.Name, 24),
			proxyText,
			time.UnixMilli(ended).Format("2006-01-02 15:04:05"),
			formatDeskDuration(duration))
	}
}

func proxyPort(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Port() == "" {
		return ""
	}
	return parsed.Port()
}

func sanitizeProxyURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return raw
	}
	parsed.User = nil
	return parsed.String()
}

func formatDeskDuration(duration time.Duration) string {
	if duration < 0 {
		duration = 0
	}
	switch {
	case duration < time.Minute:
		return fmt.Sprintf("%ds", int(duration.Seconds()))
	case duration < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(duration.Minutes()), int(duration.Seconds())%60)
	default:
		return fmt.Sprintf("%dh%02dm", int(duration.Hours()), int(duration.Minutes())%60)
	}
}
