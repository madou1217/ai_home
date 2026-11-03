/* global chrome, document, location, URL */
import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const params = new URL(location.href).searchParams;
const fileUrl = params.get('file') || '';
const status = document.getElementById('status');
const doc = document.getElementById('doc');
const target = document.getElementById('target');
const CONCURRENCY = 3;
let generation = 0;

document.getElementById('toggle').onclick = (event) => {
  const hidden = document.body.classList.toggle('hide-tr');
  event.currentTarget.textContent = hidden ? '显示译文' : '隐藏译文';
  event.currentTarget.setAttribute('aria-pressed', String(!hidden));
};

// Group pdf.js text items into paragraphs: same line when baselines are close, new
// paragraph when the vertical gap is clearly larger than a line.
function paragraphsOf(items) {
  const lines = [];
  for (const item of items) {
    const text = String(item.str || '');
    if (!text.trim() && !item.hasEOL) continue;
    const y = item.transform ? item.transform[5] : 0;
    const size = Math.abs(item.transform ? item.transform[3] : 10) || 10;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) < size * 0.5) last.text += (last.text.endsWith('-') ? '' : ' ') + text.trim();
    else lines.push({ y, size, text: text.trim() });
  }
  const paragraphs = [];
  let current = null;
  for (const line of lines.filter((entry) => entry.text)) {
    const gap = current ? current.lastY - line.y : 0;
    if (!current || gap > line.size * 1.75 || gap < 0) { current = { text: line.text, lastY: line.y }; paragraphs.push(current); }
    else { current.text += (current.text.endsWith('-') ? '' : ' ') + line.text; current.lastY = line.y; }
  }
  return paragraphs.map((entry) => entry.text.replace(/\s+/g, ' ').trim()).filter((text) => text.length > 1);
}

function translate(text, mine) {
  return new Promise((resolve) => chrome.runtime.sendMessage({
    type: 'aih-translate', text, operation: 'page', operationId: mine, target: target.value, targetPolicy: 'explicit'
  }, (response) => resolve(chrome.runtime.lastError ? null : response)));
}

async function translateAll(jobs, mine) {
  let cursor = 0; let done = 0; let failed = 0;
  async function worker() {
    while (cursor < jobs.length && mine === generation) {
      const job = jobs[cursor++];
      job.tr.classList.add('loading'); job.tr.textContent = '';
      const result = await translate(job.text, mine);
      if (mine !== generation) return;
      job.tr.classList.remove('loading');
      if (result && result.ok && result.text) job.tr.textContent = result.text; else { job.tr.textContent = result && result.error ? `（${result.error}）` : '（翻译失败）'; failed += 1; }
      done += 1; status.textContent = `已翻译 ${done} / ${jobs.length} 段${failed ? ` · 失败 ${failed}` : ''}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  if (mine === generation) status.textContent = `翻译完成 · ${jobs.length - failed} / ${jobs.length} 段`;
}

async function open() {
  if (!/^(https?|file):/.test(fileUrl)) { status.textContent = '缺少 PDF 地址'; return; }
  try { document.getElementById('title').textContent = decodeURIComponent(new URL(fileUrl).pathname.split('/').pop() || 'PDF'); } catch { /* keep default */ }
  const settings = await chrome.storage.sync.get({ target: 'zh-Hans' });
  target.value = settings.target;
  let pdf;
  try { pdf = await pdfjs.getDocument({ url: fileUrl, withCredentials: true }).promise; }
  catch (error) { status.textContent = `无法打开 PDF：${String(error && error.message || error).slice(0, 120)}`; return; }
  const jobs = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    status.textContent = `正在读取第 ${number} / ${pdf.numPages} 页…`;
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const section = document.createElement('section'); section.className = 'page';
    const heading = document.createElement('h2'); heading.textContent = `第 ${number} 页`; section.append(heading);
    const paragraphs = paragraphsOf(content.items);
    if (!paragraphs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '此页没有可提取的文字（可能是扫描图片）'; section.append(empty); }
    for (const text of paragraphs) {
      const block = document.createElement('div'); block.className = 'para';
      const src = document.createElement('p'); src.className = 'src'; src.textContent = text; src.dir = 'auto';
      const tr = document.createElement('p'); tr.className = 'tr'; tr.dir = 'auto';
      block.append(src, tr); section.append(block); jobs.push({ text, tr });
    }
    doc.append(section);
  }
  const run = () => { generation += 1; void translateAll(jobs, generation); };
  target.onchange = () => { void chrome.storage.sync.set({ target: target.value }); run(); };
  run();
}

void open();
