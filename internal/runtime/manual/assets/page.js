(() => {
  'use strict';
  const data = window.__AIH_MANUAL__ || { entries: [], notes: {}, meta: {} };
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const notes = data.notes || {};
  const meta = data.meta || {};

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s == null ? '' : s).toLowerCase();

  const groups = [];
  const byGroup = new Map();
  for (const entry of entries) {
    const key = entry.group || '其它';
    if (!byGroup.has(key)) { byGroup.set(key, []); groups.push(key); }
    byGroup.get(key).push(entry);
  }

  const state = { query: '', active: '', focusIndex: -1, cards: [] };

  const sidebar = $('#sideNav');
  const main = $('#groups');
  const searchInput = $('#searchInput');
  const searchBox = $('#searchBox');
  const countEl = $('#count');
  const progress = $('#progress');
  const toast = $('#toast');

  const svgIcon = (paths, size = 16) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const ICON_COPY = svgIcon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
  const ICON_CHECK = svgIcon('<path d="M4 12.5l5 5L20 6.5"/>');

  function highlight(text) {
    const raw = esc(text);
    const q = state.query.trim();
    if (!q) return raw;
    const lower = norm(text);
    const needle = norm(q);
    if (!needle || lower.indexOf(needle) < 0) return raw;
    let out = '';
    let from = 0;
    let at = lower.indexOf(needle, from);
    while (at >= 0) {
      out += esc(text.slice(from, at)) + '<mark>' + esc(text.slice(at, at + needle.length)) + '</mark>';
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    return out + esc(text.slice(from));
  }

  function renderSidebar() {
    sidebar.innerHTML = '';
    groups.forEach((group, index) => {
      const link = document.createElement('a');
      link.className = 'side-link';
      link.href = '#g-' + (index + 1);
      link.dataset.group = group;
      link.innerHTML = '<span class="dot"></span><span class="name">' + esc(group) + '</span><span class="n">' + byGroup.get(group).length + '</span>';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const target = document.getElementById('g-' + (index + 1));
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      sidebar.appendChild(link);
    });
  }

  function cardTemplate(entry) {
    const flags = (entry.flags || []).slice(0, 12);
    const aliases = entry.alias || [];
    const metaBits = [];
    for (const flag of flags) metaBits.push('<span class="chip flag">' + esc(flag) + '</span>');
    for (const alias of aliases) metaBits.push('<span class="chip alias">' + esc(alias) + '</span>');
    const usage = entry.usage ? '<div class="usage"><b>用法</b>' + highlight(entry.usage) + '</div>' : '';
    const details = (entry.detail || []).length
      ? '<ul class="details">' + entry.detail.map((item) => '<li>' + highlight(item) + '</li>').join('') + '</ul>'
      : '';
    const example = entry.example
      ? '<div class="example"><div class="example-head"><span class="dots"><i></i><i></i><i></i></span><span>example</span></div><code><span class="prompt">$ </span>' + highlight(entry.example) + '</code></div>'
      : '';
    const search = norm([entry.path, entry.description, entry.usage, entry.example, (entry.detail || []).join(' '), entry.group, (entry.flags || []).join(' '), (entry.alias || []).join(' ')].join(' '));
    return '<article class="card" data-path="' + esc(entry.path) + '" data-search="' + esc(search) + '" tabindex="-1">' +
      '<div class="card-head"><div class="cmd"><div class="cmd-path">' + highlight(entry.path) + '</div>' +
      '<div class="cmd-desc">' + highlight(entry.description) + '</div></div>' +
      '<button class="copy" type="button" title="复制命令" aria-label="复制 ' + esc(entry.path) + '" data-copy="' + esc(entry.path) + '">' +
      '<span class="copy-icon">' + ICON_COPY + '</span><span class="check">' + ICON_CHECK + '</span></button></div>' +
      (metaBits.length ? '<div class="meta-row">' + metaBits.join('') + '</div>' : '') +
      usage + details + example + '</article>';
  }

  function renderSections() {
    main.innerHTML = '';
    let index = 0;
    for (const group of groups) {
      index += 1;
      const section = document.createElement('section');
      section.className = 'group';
      section.id = 'g-' + index;
      section.dataset.group = group;
      const note = notes[group];
      section.innerHTML = '<div class="group-head"><span class="group-index">' + String(index).padStart(2, '0') + '</span>' +
        '<h2 class="group-title">' + esc(group) + '</h2>' +
        '<span class="group-count" data-count-for="' + esc(group) + '">' + byGroup.get(group).length + ' 条</span></div>' +
        (note ? '<p class="group-note"><b>解读</b> · ' + esc(note) + '</p>' : '') +
        '<div class="cards">' + byGroup.get(group).map(cardTemplate).join('') + '</div>';
      main.appendChild(section);
    }
    state.cards = $$('.card', main);
    bindCopy();
  }

  function applyFilter() {
    const q = norm(state.query.trim());
    let total = 0;
    for (const section of $$('.group', main)) {
      let visible = 0;
      for (const card of $$('.card', section)) {
        const hit = !q || card.dataset.search.indexOf(q) >= 0;
        card.style.display = hit ? '' : 'none';
        if (hit) visible += 1;
      }
      section.style.display = visible ? '' : 'none';
      const counter = $('[data-count-for]', section);
      if (counter) counter.textContent = visible + ' 条';
      const link = sidebar.querySelector('[data-group="' + CSS.escape(section.dataset.group) + '"] .n');
      if (link) link.textContent = visible;
      total += visible;
    }
    countEl.textContent = total + ' 条';
    const empty = $('#empty');
    empty.style.display = total ? 'none' : '';
    if (q) countEl.textContent = '匹配 ' + total + ' 条';
  }

  function bindCopy() {
    for (const button of $$('.copy', main)) {
      button.addEventListener('click', async () => {
        const value = button.dataset.copy || '';
        let copied = false;
        try {
          if (navigator.clipboard && window.isSecureContext) {
            // 浏览器权限弹窗可能长时间不返回：与 400ms 竞速，超时就退回 execCommand。
            copied = await Promise.race([
              navigator.clipboard.writeText(value).then(() => true).catch(() => false),
              new Promise((resolve) => setTimeout(() => resolve(false), 400))
            ]);
          }
        } catch (_) { copied = false; }
        if (!copied) {
          const area = document.createElement('textarea');
          area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
          document.body.appendChild(area); area.select();
          try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
          area.remove();
        }
        if (copied) {
          button.classList.add('done');
          showToast('已复制 ' + value);
          setTimeout(() => button.classList.remove('done'), 1100);
        } else {
          showToast('复制失败，请手动选择');
        }
      });
    }
  }

  let toastTimer = 0;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
  }

  function setFocus(index) {
    if (!state.cards.length) return;
    const cards = state.cards.filter((card) => card.style.display !== 'none');
    if (!cards.length) return;
    state.focusIndex = Math.max(0, Math.min(index, cards.length - 1));
    for (const card of state.cards) card.classList.remove('focus');
    const card = cards[state.focusIndex];
    card.classList.add('focus');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function currentFocusCard() {
    const cards = state.cards.filter((card) => card.style.display !== 'none');
    return cards[state.focusIndex] || null;
  }

  function bindKeys() {
    document.addEventListener('keydown', (event) => {
      const typing = event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
      if (event.key === '/' && !typing) { event.preventDefault(); searchInput.focus(); return; }
      if (event.key === 'Escape' && typing) {
        searchInput.value = ''; state.query = ''; searchBox.dataset.filled = '0'; applyFilter(); searchInput.blur(); return;
      }
      if (typing) return;
      if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); setFocus(state.focusIndex + 1); }
      else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); setFocus(state.focusIndex - 1); }
      else if (event.key === 'Enter') {
        const card = currentFocusCard();
        if (card) { const button = $('.copy', card); if (button) button.click(); }
      } else if (event.key === 'g') { window.scrollTo({ top: 0, behavior: 'smooth' }); }
      else if (event.key === 't') { cycleTheme(); }
    });
  }

  function bindScroll() {
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0) + '%';
      $('#toTop').classList.toggle('show', window.scrollY > 600);
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
    const observer = new IntersectionObserver((items) => {
      for (const item of items) {
        if (!item.isIntersecting) continue;
        const group = item.target.dataset.group;
        for (const link of $$('.side-link', sidebar)) link.classList.toggle('active', link.dataset.group === group);
      }
    }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    for (const section of $$('.group', main)) observer.observe(section);
  }

  const themes = ['auto', 'dark', 'light'];
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    const icon = $('#themeIcon');
    if (icon) icon.innerHTML = theme === 'light'
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'
      : '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>';
    localStorage.setItem('aih-manual-theme', theme);
  }
  function cycleTheme() {
    const now = localStorage.getItem('aih-manual-theme') || 'auto';
    applyTheme(themes[(themes.indexOf(now) + 1) % themes.length]);
  }

  function init() {
    $('#meta-model').textContent = meta.model || '—';
    $('#meta-server').textContent = meta.server || '—';
    $('#meta-built').textContent = meta.generatedAt || '—';
    countEl.textContent = entries.length + ' 条';
    $('#stat-commands').textContent = entries.length;
    $('#stat-groups').textContent = groups.length;
    $('#groupCount').textContent = groups.length + ' 组';
    renderSidebar();
    renderSections();
    applyFilter();

    let filterTimer = 0;
    searchInput.addEventListener('input', () => {
      state.query = searchInput.value;
      searchBox.dataset.filled = searchInput.value ? '1' : '0';
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        renderSections();
        applyFilter();
      }, 90);
    });
    $('#clearSearch').addEventListener('click', () => {
      searchInput.value = ''; state.query = ''; searchBox.dataset.filled = '0'; applyFilter(); searchInput.focus();
    });
    $('#themeBtn').addEventListener('click', cycleTheme);
    $('#toTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    const savedTheme = localStorage.getItem('aih-manual-theme') || 'auto';
    applyTheme(savedTheme);
    bindKeys();
    bindScroll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
