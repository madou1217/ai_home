package manual

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

//go:embed assets/page.css
var pageCSS string

//go:embed assets/page.js
var pageJS string

// Meta 是页头/页脚展示的构建来源。
type Meta struct {
	Model       string
	Server      string
	Version     string
	GeneratedAt string
}

// payload 是注入页面的唯一数据源：命令条目 + 分组解读 + 构建来源。
type payload struct {
	Entries []completion.DocEntry `json:"entries"`
	Notes   map[string]string     `json:"notes"`
	Meta    Meta                  `json:"meta"`
}

// pageTemplate 是编译期生成的页面骨架；所有命令内容都来自运行时数据。
const pageTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<title>aih 命令手册</title>
<style>{{.CSS}}</style>
</head>
<body>
<div class="progress" id="progress"></div>
<div class="bg" aria-hidden="true"><span class="orb orb-a"></span><span class="orb orb-b"></span><span class="orb orb-c"></span></div>

<header class="topbar">
  <div class="brand">
    <svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <defs><linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4c9dff"/><stop offset=".55" stop-color="#a78bfa"/><stop offset="1" stop-color="#2ee6c5"/>
      </linearGradient></defs>
      <circle class="ring" cx="20" cy="20" r="17" fill="none" stroke-width="1.4" opacity=".55"/>
      <path class="core" d="M20 6l11 6.2v13.6L20 32l-11-6.2V12.2z" opacity=".9"/>
      <path d="M15 24l5-9 5 9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>
    </svg>
    <div><div class="brand-title">aih 命令手册</div><div class="brand-sub">offline manual</div></div>
  </div>
  <div class="search" id="searchBox">
    <svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
    <input id="searchInput" type="search" autocomplete="off" spellcheck="false" aria-label="搜索命令、描述、分组或参数" placeholder="搜索命令、描述、分组或参数">
    <kbd>/</kbd>
    <button class="clear" id="clearSearch" type="button" aria-label="清空搜索">×</button>
  </div>
  <div class="tools">
    <span class="stat" style="border:0;padding:0 4px"><b id="count">0 条</b></span>
    <button class="icon-btn" id="themeBtn" type="button" aria-label="切换主题" title="切换主题（t）"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><g id="themeIcon"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></g></svg></button>
  </div>
</header>

<div class="shell">
  <aside class="sidebar">
    <div class="side-head"><b>命令分组</b><span id="groupCount"></span></div>
    <nav class="side-nav" id="sideNav" aria-label="命令分组导航"></nav>
    <div class="side-foot">
      页面由 <code>aih man</code> 生成，数据取自 TAB 补全的同一棵命令树。<br>
      <span id="meta-model">—</span> · <span id="meta-server">—</span><br>
      <span id="meta-built">—</span>
    </div>
  </aside>

  <main class="main" id="main">
    <section class="hero">
      <span class="eyebrow">aih · command reference</span>
      <h1 class="hero-title">一条命令，<span class="grad">三种启动形态</span>，<br>全部可 TAB 抵达。</h1>
      <p class="hero-sub">本页把 aih 的命令面按“顶层入口 → 子命令 → Provider 动作 → 启动语法”展开。每条命令都带解读与示例；按 <b>/</b> 搜索，<b>j / k</b> 移动，<b>Enter</b> 复制命令。</p>
      <div class="hero-meta">
        <span class="stat"><b id="stat-commands">0</b> 条命令</span>
        <span class="stat"><b id="stat-groups">0</b> 个分组</span>
        <span class="stat"><b>14</b> 个 Provider</span>
        <span class="stat"><b>TAB</b> 同源</span>
      </div>
      <svg class="hero-flow" viewBox="0 0 920 118" role="img" aria-label="shell 到 aih，再到 Provider 或 Server 的调用链">
        <path class="flow" d="M120 59H250"/>
        <path class="flow flow-2" d="M330 59H470"/>
        <path class="flow flow-3" d="M550 59H700"/>
        <circle class="pulse" cx="120" cy="59" r="3.5"/>
        <circle class="pulse" cx="330" cy="59" r="3.5" style="animation-delay:.4s"/>
        <circle class="pulse" cx="550" cy="59" r="3.5" style="animation-delay:.8s"/>
        <rect class="node" x="20" y="35" width="100" height="48" rx="12"/>
        <text x="70" y="58" text-anchor="middle">shell</text>
        <text x="70" y="73" text-anchor="middle" opacity=".6">TAB</text>
        <rect class="node node-accent" x="250" y="27" width="80" height="64" rx="14"/>
        <text x="290" y="56" text-anchor="middle" style="fill:var(--text);font-size:13px;font-weight:700">aih</text>
        <text x="290" y="72" text-anchor="middle" opacity=".6">router</text>
        <rect class="node" x="470" y="24" width="80" height="30" rx="9"/>
        <text x="510" y="43" text-anchor="middle">native</text>
        <rect class="node" x="470" y="64" width="80" height="30" rx="9"/>
        <text x="510" y="83" text-anchor="middle">relay</text>
        <rect class="node" x="560" y="44" width="90" height="30" rx="9"/>
        <text x="605" y="63" text-anchor="middle">provider</text>
        <rect class="node" x="700" y="35" width="120" height="48" rx="12"/>
        <text x="760" y="56" text-anchor="middle">AIH Server</text>
        <text x="760" y="71" text-anchor="middle" opacity=".6">gateway</text>
        <text x="850" y="63" opacity=".55">↔ upstream</text>
      </svg>
    </section>

    <div id="empty" class="empty" style="display:none"><b>没有匹配的命令</b>试试更短的关键词，或按 Esc 清空。</div>
    <div id="groups"></div>
  </main>
</div>

<div class="toast" id="toast" role="status" aria-live="polite"></div>
<button class="to-top" id="toTop" type="button" aria-label="回到顶部">↑</button>

<script>window.__AIH_MANUAL__ = {{.Data}};</script>
<script>{{.JS}}</script>
</body>
</html>`

// Render 把条目与解读注入编译期模板，产出可直接打开的离线页面。
func Render(entries []completion.DocEntry, notes map[string]string, meta Meta) ([]byte, error) {
	if entries == nil {
		entries = []completion.DocEntry{}
	}
	if notes == nil {
		notes = map[string]string{}
	}
	encoded, err := json.Marshal(payload{Entries: entries, Notes: notes, Meta: meta})
	if err != nil {
		return nil, fmt.Errorf("manual_manifest_encode: %w", err)
	}
	tmpl, err := template.New("manual").Parse(pageTemplate)
	if err != nil {
		return nil, fmt.Errorf("manual_template_parse: %w", err)
	}
	var output bytes.Buffer
	data := struct {
		CSS  template.CSS
		JS   template.JS
		Data template.JS
	}{CSS: template.CSS(pageCSS), JS: template.JS(pageJS), Data: template.JS(encoded)}
	if err := tmpl.Execute(&output, data); err != nil {
		return nil, fmt.Errorf("manual_template_render: %w", err)
	}
	for _, placeholder := range []string{"__AIH_MANIFEST__", "__AIH_MODEL__", "__AIH_SERVER__"} {
		if strings.Contains(output.String(), placeholder) {
			return nil, errors.New("manual_template_placeholder_leaked")
		}
	}
	return output.Bytes(), nil
}
