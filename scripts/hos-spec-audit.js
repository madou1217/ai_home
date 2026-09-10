/* HarmonyOS 6.1 设计规范一致性审计。
 *
 * 判定基准取 docs/harmonyos6-dsh2-design-specification.md 里的**可测条款**——
 * 8 级字阶、按钮高度与圆角、选择器圆角、卡片圆角与毛玻璃——逐页量真实渲染值,
 * 而不是凭观感。这样「全站鸿蒙化」这类条目才有可复现的验收依据。
 *
 * 用法(需本机网关在 127.0.0.1:9527 且已构建 web/dist):
 *   NODE_PATH=<playwright> node scripts/hos-spec-audit.js
 * 结果逐页打印,明细写入 tmp/hos-audit/report.json。
 *
 * 两条口径纪律(踩过才补上的):
 *   1. 只统计「含直接文本节点」的元素——容器的 font-size 会被子元素覆盖,
 *      计入会产生幻影命中(先前误报过「每页 22px」)。
 *   2. 只查操作按钮——开关、TabBar 格子、Tabs 溢出钮、Typography 展开/复制、
 *      输入框清除图标都是 <button> 但不适用按钮条款,计入即误报。
 */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const OUT = "/Users/model/projects/feature/ai_home/tmp/hos-audit";
fs.mkdirSync(OUT, { recursive: true });
// 规范：docs/harmonyos6-dsh2-design-specification.md
const SCALE = [32, 24, 18, 15, 14, 13, 12, 10];
const ALLOWED_EXTRA = [16, 11, 9, 21, 26, 29]; // 21/26/29 = ModelUsage KPI 的 clamp 取值(§五 登记的有意例外) // 已在文档中登记的就近归级/例外
const ROUTES = ["/dashboard","/accounts","/chat","/usage","/models","/toolkit",
  "/toolkit/install-guide","/studio/image","/fabric/servers","/fabric/ssh-hosts","/settings","/server-setup"];
const cfg = execSync("aih server config show --show-secrets", { encoding: "utf8" });
const mgmtKey = (cfg.match(/management_key:\s*([^\s]+)/i) || [])[1] || "";
(async () => {
  const browser = await chromium.launch({ executablePath: "/Users/model/Library/Caches/ms-playwright/chromium_headless_shell-1229/chrome-headless-shell-mac-arm64/chrome-headless-shell", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://127.0.0.1:9527/ui/chat", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const k = page.locator('input[placeholder="Management Key"]').first();
  if (await k.isVisible().catch(()=>false)) {
    await k.fill(mgmtKey);
    await page.locator('button:has-text("连接并进入工作台")').first().click();
    await page.waitForTimeout(2500);
  }
  const report = [];
  for (const route of ROUTES) {
    for (const vp of [{w:1440,h:900,n:"pc"},{w:390,h:844,n:"mobile"}]) {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto("http://127.0.0.1:9527/ui" + route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2400);
      const m = await page.evaluate(({ SCALE, ALLOWED_EXTRA }) => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const sizes = new Map();
        const offScale = new Map();
        document.querySelectorAll('*').forEach((el) => {
          if (!vis(el)) return;
          // 只统计「自己直接渲染文字」的元素。容器的 font-size 会被子元素覆盖，
          // 计入会产生幻影命中——先前报的「每页 22px×1」正是这么来的。
          const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
          if (!ownText) return;
          const fs = Math.round(parseFloat(getComputedStyle(el).fontSize));
          sizes.set(fs, (sizes.get(fs) || 0) + 1);
          if (!SCALE.includes(fs) && !ALLOWED_EXTRA.includes(fs)) {
            offScale.set(fs, (offScale.get(fs) || 0) + 1);
          }
        });
        // 只查「操作按钮」。开关(ant-switch,胶囊 100px)与底部 TabBar 格子(通栏平铺、无圆角)
        // 都是 <button>，但规范的按钮条款不适用于它们——先前把它们报成圆角异常是口径错误。
        const btns = Array.from(document.querySelectorAll('button')).filter(vis).filter((b) => {
          const c = (b.className || '').toString();
          return !/ant-switch|mobile-tabbar-item|ant-tabs-tab|ant-segmented-item|ant-typography-(expand|copy)|ant-input-clear-icon|sessionSelect|sessionWindowButton|ant-tabs-nav-more/.test(c)
            && b.getAttribute('role') !== 'switch';
        }).map((b) => {
          const cs = getComputedStyle(b);
          return { h: Math.round(b.getBoundingClientRect().height), r: cs.borderRadius.split(' ')[0] };
        });
        const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="Card"], .ant-card, .ant-pro-card')).filter(vis).slice(0, 30).map((c) => {
          const cs = getComputedStyle(c);
          return { r: cs.borderRadius.split(' ')[0], blur: cs.backdropFilter !== 'none' };
        });
        const selects = Array.from(document.querySelectorAll('.ant-select-selector')).filter(vis).map((s) => getComputedStyle(s).borderRadius.split(' ')[0]);
        return {
          offScale: [...offScale.entries()].sort((a,b)=>b[1]-a[1]),
          scaleUsed: [...sizes.keys()].sort((a,b)=>b-a),
          btnRadiiOdd: [...new Set(btns.map(b=>b.r))].filter(r => !/9999px|^(6|8|10|12|14|16|20|24|32)px$/.test(r)),
          btnTooShort: btns.filter(b => b.h > 0 && b.h < 28).length,
          cardRadiiOdd: [...new Set(cards.map(c=>c.r))].filter(r => !/^(0px|6px|8px|10px|12px|14px|16px|18px|20px|24px|32px)$/.test(r)),
          cardsNoBlur: cards.filter(c=>!c.blur).length, cardsTotal: cards.length,
          selectRadii: [...new Set(selects)]
        };
      }, { SCALE, ALLOWED_EXTRA });
      await page.screenshot({ path: `${OUT}/${route.replace(/\//g,'_')}-${vp.n}.png` });
      report.push({ route, vp: vp.n, ...m });
      const flags = [];
      if (m.offScale.length) flags.push(`字阶外:${m.offScale.map(([s,c])=>s+'px×'+c).join(',')}`);
      if (m.btnRadiiOdd.length) flags.push(`按钮圆角异常:${m.btnRadiiOdd.join(',')}`);
      if (m.cardRadiiOdd.length) flags.push(`卡片圆角异常:${m.cardRadiiOdd.join(',')}`);
      if (m.selectRadii.length && m.selectRadii.some(r=>r!=='14px') && !route.startsWith('/studio')) flags.push(`选择器圆角:${m.selectRadii.join(',')}`);
      console.log(`${flags.length?'⚠':'ok'} ${route} ${vp.n}${flags.length?'  '+flags.join(' | '):''}`);
    }
  }
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
})();
