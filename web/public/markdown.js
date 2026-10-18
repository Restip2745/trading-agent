/**
 * 極簡 Markdown 轉 HTML，給策略頁顯示 skill 檔。只支援策略檔用到的語法：
 * frontmatter、標題、段落、清單（可巢狀）、表格、引言、程式碼區塊、行內程式碼與粗體。
 * 所有文字先跳脫，不輸出連結與原始 HTML，所以結果可以安全地交給 v-html。
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function mdInline(text) {
  // 以反引號切開：奇數段是程式碼，不再處理粗體
  return text
    .split('`')
    .map((part, i) =>
      i % 2 === 1
        ? `<code>${escapeHtml(part)}</code>`
        : escapeHtml(part)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
    )
    .join('');
}

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      const rows = lines.slice(1, end).map((l) => {
        const k = l.indexOf(':');
        return k > 0 ? `<tr><th>${escapeHtml(l.slice(0, k))}</th><td>${escapeHtml(l.slice(k + 1).trim())}</td></tr>` : '';
      });
      out.push(`<table class="md-front"><tbody>${rows.join('')}</tbody></table>`);
      i = end + 1;
    }
  }
  const lists = []; // { indent, tag }
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join(' ')}</p>`);
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists.at(-1).indent > indent) out.push(`</li></${lists.pop().tag}>`);
  };
  const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      closeLists();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre class="mono">${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].length;
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists.at(-1);
      if (top && top.indent === indent && top.tag === tag) out.push('</li>');
      else {
        if (top && top.indent === indent) out.push(`</li></${lists.pop().tag}>`);
        out.push(`<${tag}>`);
        lists.push({ indent, tag });
      }
      out.push(`<li>${mdInline(item[3])}`);
      continue;
    }
    if (lists.length && /^\s+\S/.test(line)) {
      out.push(` ${mdInline(line.trim())}`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeLists();
      continue;
    }
    closeLists();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      out.push(`<div class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</div>`);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flushPara();
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) body.push(cells(lines[i]));
      i--;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      out.push(`<blockquote>${mdInline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushPara();
      out.push('<hr>');
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  closeLists();
  return out.join('');
}
