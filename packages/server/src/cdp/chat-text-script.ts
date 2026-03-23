/**
 * CDP script to extract clean Markdown text from the Antigravity chat container.
 * Injected via Runtime.evaluate — must be a self-contained IIFE.
 *
 * Features:
 *  - Removes input area, style/script/svg, buttons, tooltips
 *  - Filters out IDE UI noise (Generating/Thinking/Loading/Review Changes/paths/tool indicators)
 *  - Wraps "thinking" sections with <think> tags
 *  - Converts DOM → Markdown (headings, bold, code, lists, tables, etc.)
 *  - Post-processes to strip CSS artifacts and noise lines
 */

// Build the script as an array of lines, then join with real \n.
// This avoids template-literal escaping nightmares.
//
// IMPORTANT ESCAPING RULES inside L():
//   - L() uses backtick template literals so \n = real newline.
//   - To get a literal \n in the OUTPUT JS, use '\\n' (double backslash).
//   - Regex backslashes: \\s in L() → \s in browser. \\\\d → \\d in browser.

const lines: string[] = [];
function L(s: string) { lines.push(s); }

L(`(() => {`);
L(`  const chatEl = document.getElementById('cascade')`);
L(`    || document.getElementById('conversation')`);
L(`    || document.getElementById('chat');`);
L(`  if (!chatEl) return { text: '', length: 0 };`);
L(``);
L(`  const clone = chatEl.cloneNode(true);`);
L(``);
L(`  // Remove input area`);
L(`  clone.querySelectorAll('[contenteditable]').forEach(el => {`);
L(`    let target = el;`);
L(`    for (let i = 0; i < 5; i++) {`);
L(`      if (target.parentElement && target.parentElement !== clone) target = target.parentElement;`);
L(`      else break;`);
L(`    }`);
L(`    target.remove();`);
L(`  });`);
L(``);
L(`  // Remove noise DOM elements`);
L(`  clone.querySelectorAll('[data-tooltip-id]').forEach(el => el.remove());`);
L(`  clone.querySelectorAll('style, script, svg, noscript, link[rel="stylesheet"]').forEach(el => el.remove());`);
L(``);
L(`  // Remove leaf nodes with CSS-like content`);
L(`  clone.querySelectorAll('*').forEach(el => {`);
L(`    if (el.children.length === 0) {`);
L(`      const t = (el.textContent || '').trim();`);
// Note: \\s becomes \s in browser JS, which is correct regex
L(`      if (t.length > 30 && /[{;}]/.test(t) && (/^\\s*[@.#\\[]/.test(t) || /--color-/.test(t))) {`);
L(`        el.remove();`);
L(`      }`);
L(`    }`);
L(`  });`);
L(``);
L(`  // UI noise patterns — matches IDE status/button text`);
// Use RegExp constructor to avoid escaping hell.
// The pattern in the output JS: ^(Generating|Thinking|Loading|Review Changes?|...)\.{0,3}$
// In L(), we need \\\\d to produce \\d in the output (RegExp constructor needs \\d)
L(`  const UI_NOISE = new RegExp(`);
L(`    '^(' +`);
L(`    'Generating|Thinking|Loading|Searching|Indexing|Analyzing|Processing|Connecting|' +`);
L(`    'Review Changes?|Reject( all)?|Accept( all)?|Copy|Apply|Retry|Cancel|Dismiss|' +`);
L(`    'Fast|Normal|Ask anything.*|' +`);
L(`    'Ran terminal command|Ran command|Terminal command|Tool |Executed |Running |' +`);
L(`    'Read file|Wrote to|Edited |Created |Deleted |Listed |Searched |' +`);
L(`    'Checkpoint \\\\d+|Step Id: \\\\d+|' +`);
L(`    '\\\\d+ Files? With Changes?|\\\\d+ lines?|\\\\d+ insertions?|\\\\d+ deletions?' +`);
L(`    ')\\\\.{0,3}$', 'i'`);
L(`  );`);
L(`  const PATH_NOISE = /^\\/(Applications|Users|tmp|var|node_modules)\\//;`);
// Tool command patterns — matches command execution UI
L(`  const TOOL_NOISE = new RegExp(`);
L(`    '^(' +`);
L(`    '(\\\\$|>|%) .{0,80}$|' +`);
L(`    'Exit code:? \\\\d+|' +`);
L(`    'The command (completed|failed)|' +`);
L(`    'Output:|Stdout:|Stderr:|' +`);
L(`    'Always run|Auto-run|Safe to auto-run|' +`);
L(`    'packages/|src/|node_modules/|\\\\.(ts|js|json|css|md|mjs)$' +`);
L(`    ')', 'i'`);
L(`  );`);
L(``);
L(`  // Remove leaf elements matching UI/tool noise`);
L(`  clone.querySelectorAll('*').forEach(el => {`);
L(`    if (el.children.length === 0) {`);
L(`      const t = (el.textContent || '').trim();`);
L(`      if (UI_NOISE.test(t) || PATH_NOISE.test(t) || TOOL_NOISE.test(t)) el.remove();`);
L(`    }`);
L(`  });`);
L(``);
L(`  // Remove all buttons`);
L(`  clone.querySelectorAll('button, [role="button"]').forEach(el => el.remove());`);
L(``);
L(`  // Remove tool/command containers by class or data attributes`);
L(`  clone.querySelectorAll('[class*="terminal"], [class*="command"], [class*="tool-"], [class*="diff-"]').forEach(el => {`);
L(`    // Only remove if small (UI chrome, not content)`);
L(`    if ((el.textContent || '').trim().length < 200) el.remove();`);
L(`  });`);
L(``);
L(`  // --- DOM to Markdown ---`);
L(`  function toMd(node) {`);
L(`    if (node.nodeType === 3) {`);
L(`      const t = (node.textContent || '').trim();`);
L(`      if (UI_NOISE.test(t) || PATH_NOISE.test(t) || TOOL_NOISE.test(t)) return '';`);
L(`      return node.textContent || '';`);
L(`    }`);
L(`    if (node.nodeType !== 1) return '';`);
L(``);
L(`    const el = node;`);
L(`    const tag = el.tagName.toLowerCase();`);
L(`    const cls = (el.className || '').toString().toLowerCase();`);
L(`    const kids = () => Array.from(el.childNodes).map(toMd).join('');`);
L(``);
L(`    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return '';`);
L(`    if (tag === 'style' || tag === 'script' || tag === 'svg' || tag === 'noscript' || tag === 'link') return '';`);
L(``);
L(`    // Skip icon containers`);
L(`    if (cls.includes('octicon') || cls.includes('codicon') || (cls.includes('icon') && !cls.includes('icon-'))) return '';`);
L(``);
L(`    // Skip tool/command result containers`);
L(`    if (cls.includes('terminal') || cls.includes('tool-result') || cls.includes('command-output')) {`);
L(`      const content = (el.textContent || '').trim();`);
L(`      if (content.length < 300) return '';`);
L(`    }`);
L(``);
L(`    // Thinking sections -> <think> wrapper`);
L(`    if (cls.includes('think') || cls.includes('reasoning') ||`);
L(`        (tag === 'details' && el.querySelector('summary') && el.querySelector('summary').textContent.toLowerCase().includes('think'))) {`);
L(`      const c = kids().trim();`);
// \\n in L() template = real newline in output JS
L(`      return c ? '\\n<think>\\n' + c + '\\n</think>\\n' : '';`);
L(`    }`);
L(``);
L(`    switch (tag) {`);
L(`      case 'br': return '\\n';`);
L(`      case 'hr': return '\\n---\\n';`);
L(`      case 'h1': return '\\n# ' + kids().trim() + '\\n';`);
L(`      case 'h2': return '\\n## ' + kids().trim() + '\\n';`);
L(`      case 'h3': return '\\n### ' + kids().trim() + '\\n';`);
L(`      case 'h4': return '\\n#### ' + kids().trim() + '\\n';`);
L(`      case 'strong': case 'b': return '**' + kids().trim() + '**';`);
L(`      case 'em': case 'i': {`);
L(`        const c = kids().trim();`);
L(`        return c.length === 0 ? '' : '*' + c + '*';`);
L(`      }`);
L(`      case 'del': case 's': return '~~' + kids().trim() + '~~';`);
L(``);
L(`      case 'code': {`);
L(`        if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'pre') return kids();`);
// Use string concatenation to avoid backtick escaping issues
L(`        return String.fromCharCode(96) + kids().trim() + String.fromCharCode(96);`);
L(`      }`);
L(``);
L(`      case 'pre': {`);
L(`        const codeEl = el.querySelector('code');`);
L(`        const raw = codeEl ? (codeEl.textContent || '') : (el.textContent || '');`);
L(`        const trimmed = raw.trim();`);
L(`        // Skip CSS blocks`);
L(`        if (/^\\s*[@.#]/.test(trimmed) && trimmed.includes('{') && trimmed.includes('}') && /[;:]/.test(trimmed)) return '';`);
L(`        const langClass = (codeEl || el).className || '';`);
L(`        const langMatch = langClass.match(/language-(\\w+)/);`);
L(`        const lang = langMatch ? langMatch[1] : '';`);
L(`        const fence = String.fromCharCode(96,96,96);`);
L(`        return '\\n' + fence + lang + '\\n' + trimmed + '\\n' + fence + '\\n';`);
L(`      }`);
L(``);
L(`      case 'a': {`);
L(`        const href = el.getAttribute('href') || '';`);
L(`        const text = kids().trim();`);
L(`        return href ? '[' + text + '](' + href + ')' : text;`);
L(`      }`);
L(`      case 'ul': return '\\n' + Array.from(el.children).map(li => '- ' + toMd(li).trim()).join('\\n') + '\\n';`);
L(`      case 'ol': return '\\n' + Array.from(el.children).map((li, i) => (i + 1) + '. ' + toMd(li).trim()).join('\\n') + '\\n';`);
L(`      case 'li': return kids();`);
L(`      case 'p': return '\\n' + kids().trim() + '\\n';`);
L(`      case 'div': case 'section': case 'article': {`);
L(`        const c = kids();`);
L(`        return c.endsWith('\\n') ? c : c + '\\n';`);
L(`      }`);
L(`      case 'blockquote': return '\\n' + kids().trim().split('\\n').map(l => '> ' + l).join('\\n') + '\\n';`);
L(`      case 'table': {`);
L(`        const rows = Array.from(el.querySelectorAll('tr'));`);
L(`        if (rows.length === 0) return '';`);
L(`        const result = [];`);
L(`        rows.forEach((row, ri) => {`);
L(`          const cells = Array.from(row.querySelectorAll('th, td'));`);
L(`          result.push('| ' + cells.map(c => (c.textContent || '').trim()).join(' | ') + ' |');`);
L(`          if (ri === 0) result.push('| ' + cells.map(() => '---').join(' | ') + ' |');`);
L(`        });`);
L(`        return '\\n' + result.join('\\n') + '\\n';`);
L(`      }`);
L(`      case 'img': {`);
L(`        const src = el.getAttribute('src') || '';`);
L(`        const w = parseInt(el.getAttribute('width') || '0', 10);`);
L(`        const h = parseInt(el.getAttribute('height') || '0', 10);`);
L(`        if (src.startsWith('data:') || (w > 0 && w <= 24) || (h > 0 && h <= 24)) return '';`);
L(`        const alt = el.getAttribute('alt') || '';`);
L(`        return src ? '![' + alt + '](' + src + ')' : '';`);
L(`      }`);
L(`      default: return kids();`);
L(`    }`);
L(`  }`);
L(``);
L(`  let text = toMd(clone).trim();`);
L(`  text = text.replace(/\\n{3,}/g, '\\n\\n');`);
L(`  // Strip CSS artifacts`);
L(`  text = text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');`);
L(`  text = text.replace(/(\\.[\\w.-]+\\s*\\{[^}]*\\}\\s*)+/g, '');`);
L(`  // Line-by-line noise filter`);
L(`  text = text.split('\\n').filter(line => {`);
L(`    const t = line.trim();`);
L(`    if (!t) return true;`);
L(`    if (UI_NOISE.test(t)) return false;`);
L(`    if (PATH_NOISE.test(t)) return false;`);
L(`    if (TOOL_NOISE.test(t)) return false;`);
L(`    if (/^[+-]\\d+$/.test(t)) return false;`);
L(`    if (/^#L\\d+/.test(t)) return false;`);
L(`    if (/^(Claude|GPT|Gemini|Opus|Sonnet|Haiku)\\b/i.test(t) && t.length < 40) return false;`);
L(`    // File change indicators`);
L(`    if (/^(openai-compat|workspace|index|cli|phase)\\.(ts|js|mjs)$/i.test(t)) return false;`);
L(`    return true;`);
L(`  }).join('\\n');`);
L(`  text = text.replace(/\\n{3,}/g, '\\n\\n').trim();`);
L(`  return { text, length: text.length };`);
L(`})()`);

export const CHAT_TEXT_SCRIPT = lines.join("\n");
