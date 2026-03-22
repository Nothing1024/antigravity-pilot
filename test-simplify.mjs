#!/usr/bin/env node
/**
 * IDE GPU 简化 — 独立测试脚本（零依赖版）
 * 
 * 用法:
 *   node test-simplify.mjs              # 扫描端口 9000-9003，full 模式
 *   node test-simplify.mjs light        # light 模式
 *   node test-simplify.mjs off          # 移除简化
 *   node test-simplify.mjs close-tabs   # 关闭所有文件 tab
 *   node test-simplify.mjs full 9222    # 指定端口
 * 
 * 不需要 npm install，不需要启动 Pilot 服务。
 * 直接通过 CDP 连接 Antigravity IDE。
 */

import http from "node:http";
import { createConnection } from "node:net";
import { randomBytes, createHash } from "node:crypto";

const MODE = process.argv[2] || "full";
const CUSTOM_PORT = process.argv[3] ? parseInt(process.argv[3]) : null;
const CDP_PORTS = CUSTOM_PORT ? [CUSTOM_PORT] : [9000, 9001, 9002, 9003, 9222];

// ═══════════════════════════════════════════
// 简化 CSS
// ═══════════════════════════════════════════
const SIMPLIFY_CSS_FULL = `
*, *::before, *::after {
  animation: none !important; animation-duration: 0s !important;
  transition: none !important; transition-duration: 0s !important;
}
/* content-visibility: hidden 比 display:none 更高效 — 跳过渲染但保留布局信息 */
.part.editor { content-visibility: hidden !important; height: 0 !important; overflow: hidden !important; }
.editor-group-container { content-visibility: hidden !important; height: 0 !important; }
.part.sidebar { content-visibility: hidden !important; width: 0 !important; overflow: hidden !important; }
.part.panel { content-visibility: hidden !important; height: 0 !important; }
.part.statusbar { display: none !important; }
.activitybar { display: none !important; }
.part.titlebar { max-height: 28px !important; overflow: hidden !important; }
/* 减少 GPU 合成层 */
* { will-change: auto !important; }
*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
/* 停止隐藏面板内的 canvas 渲染（GPU 大户） */
.part.editor canvas,
.part.sidebar canvas,
.part.panel canvas { display: none !important; }
/* 隐藏面板内的滚动条 */
.part.editor ::-webkit-scrollbar,
.part.sidebar ::-webkit-scrollbar,
.part.panel ::-webkit-scrollbar { display: none !important; }
/* contain: 隔离聊天面板的渲染范围，减少重排/重绘扩散 */
.part.auxiliarybar { contain: layout style paint !important; }
/* 隐藏所有拖动条 */
.monaco-sash { background: transparent !important; }
/* 只有标记的聊天面板右侧拖动条可见 */
.monaco-sash[data-ag-sash] { background: rgba(128,128,128,0.4) !important; }
.monaco-sash[data-ag-sash]:hover { background: rgba(128,128,128,0.8) !important; }
`;


const SIMPLIFY_CSS_LIGHT = `
*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }
.minimap, .minimap-shadow-visible { display: none !important; }
.part.panel { visibility: hidden !important; height: 0 !important; min-height: 0 !important; }
.breadcrumbs-below-tabs { display: none !important; }
* { will-change: auto !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
.cursor { animation: none !important; opacity: 1 !important; }
`;

const STYLE_ID = "ag-pilot-simplify";

// ═══════════════════════════════════════════
// 极简 WebSocket 客户端（零依赖）
// ═══════════════════════════════════════════
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString("base64");
    const socket = createConnection({ host: u.hostname, port: parseInt(u.port) }, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let idCounter = 1;

    function parseFrame(buf) {
      if (buf.length < 2) return null;
      const byte1 = buf[0], byte2 = buf[1];
      const opcode = byte1 & 0x0f;
      let payloadLen = byte2 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < 4) return null;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return null;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + payloadLen) return null;
      const payload = buf.subarray(offset, offset + payloadLen);
      return { opcode, payload, totalLen: offset + payloadLen };
    }

    function sendFrame(data) {
      const payload = Buffer.from(data, "utf8");
      const mask = randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
        mask.copy(header, 4);
      } else {
        header = Buffer.alloc(14);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        mask.copy(header, 10);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));
    }

    function processBuffer() {
      while (true) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.totalLen);
        if (frame.opcode === 1) {
          try {
            const msg = JSON.parse(frame.payload.toString("utf8"));
            if (msg.id && pending.has(msg.id)) {
              const { resolve, reject } = pending.get(msg.id);
              pending.delete(msg.id);
              if (msg.error) reject(msg.error);
              else resolve(msg.result);
            }
          } catch {}
        } else if (frame.opcode === 8) {
          socket.end();
        }
      }
    }

    const call = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = idCounter++;
        pending.set(id, { resolve: res, reject: rej });
        sendFrame(JSON.stringify({ id, method, params }));
      });

    socket.on("data", (chunk) => {
      if (!handshakeDone) {
        const str = chunk.toString();
        const idx = str.indexOf("\r\n\r\n");
        if (idx === -1) return;
        if (!str.startsWith("HTTP/1.1 101")) {
          reject(new Error("WebSocket handshake failed"));
          socket.destroy();
          return;
        }
        handshakeDone = true;
        const remaining = chunk.subarray(idx + 4);
        if (remaining.length > 0) buffer = Buffer.concat([buffer, remaining]);
        resolve({ call, close: () => socket.end() });
        processBuffer();
      } else {
        buffer = Buffer.concat([buffer, chunk]);
        processBuffer();
      }
    });

    socket.on("error", (e) => { if (!handshakeDone) reject(e); });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("timeout")); });
  });
}

// ═══════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════
function fetchTargets(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
    });
    req.on("error", () => resolve([]));
    req.setTimeout(2000, () => { req.destroy(); resolve([]); });
  });
}

// ═══════════════════════════════════════════
// 主逻辑
// ═══════════════════════════════════════════
async function main() {
  console.log(`\n🎨  IDE GPU 简化测试工具`);
  const modeLabels = { off: "🧹 移除简化", light: "🌙 轻度简化", full: "⚡ 完全简化", "close-tabs": "📑 关闭所有文件 tab" };
  console.log(`    模式: ${modeLabels[MODE] || MODE}`);
  console.log(`    扫描端口: ${CDP_PORTS.join(", ")}\n`);

  let allTargets = [];
  for (const port of CDP_PORTS) {
    const targets = await fetchTargets(port);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (pages.length > 0) {
      console.log(`  ✅ 端口 ${port}: ${pages.length} 个页面`);
      pages.forEach((p) => console.log(`     📄 ${p.title?.substring(0, 60)}`));
      allTargets.push(...pages);
    }
  }

  if (allTargets.length === 0) {
    console.log(`  ❌ 未找到 IDE 页面\n`);
    console.log(`  请确认:`);
    console.log(`    1. Antigravity IDE 正在运行`);
    console.log(`    2. IDE 启动时带有 --remote-debugging-port=9222 (或 9000-9003)`);
    console.log(`    3. 端口可访问\n`);
    process.exit(1);
  }

  console.log();

  let ok = 0;
  for (const target of allTargets) {
    try {
      const cdp = await wsConnect(target.webSocketDebuggerUrl);

      if (MODE === "close-tabs") {
        // 通过 DOM 查找并点击每个 tab 的关闭按钮
        const script = `(() => {
          let closed = 0;
          // 方法1: 点击所有 tab 关闭按钮
          const closeBtns = document.querySelectorAll(
            '.tabs-container .tab-close .codicon-close, ' +
            '.tabs-container .tab-actions .action-label, ' +
            '.tab .monaco-icon-label-container + .tab-actions .codicon'
          );
          closeBtns.forEach(btn => {
            try { btn.click(); closed++; } catch(e) {}
          });
          // 方法2: 如果方法1没找到按钮，用更宽泛的选择器
          if (closed === 0) {
            const tabs = document.querySelectorAll('.tabs-container .tab');
            tabs.forEach(tab => {
              const closeBtn = tab.querySelector('.codicon-close') || tab.querySelector('[title*="Close"]');
              if (closeBtn) { try { closeBtn.click(); closed++; } catch(e) {} }
            });
          }
          return { closed };
        })()`;
        const res = await cdp.call("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        });
        const v = res.result?.value;
        console.log(`  📑 已关闭 ${v?.closed || 0} 个 tabs: ${target.title?.substring(0, 50)}`);
        ok++;
      } else if (MODE === "off") {
        const res = await cdp.call("Runtime.evaluate", {
          expression: `(() => {
            const el = document.getElementById("${STYLE_ID}");
            if (el) el.remove();
            // 清除 sash 标记 + 恢复 rAF
            document.querySelectorAll('.monaco-sash[data-ag-sash]').forEach(sa => sa.removeAttribute('data-ag-sash'));
            if (window.__agOrigRAF) { window.requestAnimationFrame = window.__agOrigRAF; delete window.__agOrigRAF; }
            return el ? "removed" : "not_found";
          })()`,
          returnByValue: true,
        });
        const v = res.result?.value;
        // 清除 prefers-reduced-motion 模拟
        try { await cdp.call("Emulation.setEmulatedMedia", { features: [] }); } catch {}
        console.log(`  ${v === "removed" ? "🧹 已移除" : "⚪ 无需移除"}: ${target.title?.substring(0, 50)}`);
      } else {
        const css = MODE === "light" ? SIMPLIFY_CSS_LIGHT : SIMPLIFY_CSS_FULL;
        const script = `(() => {
          let e = document.getElementById("${STYLE_ID}"); if (e) e.remove();
          const s = document.createElement("style"); s.id = "${STYLE_ID}";
          s.textContent = ${JSON.stringify(css)};
          (document.head || document.documentElement).appendChild(s);
          ${MODE === "full" ? `
          // 标记聊天面板右侧的 sash
          const aux = document.getElementById('workbench.parts.auxiliarybar');
          if (aux) {
            const svv = aux.parentElement;
            const rightEdge = svv.offsetLeft + svv.offsetWidth;
            document.querySelectorAll('.monaco-sash.vertical').forEach(sa => {
              sa.removeAttribute('data-ag-sash');
              const sashLeft = parseInt(sa.style.left) || 0;
              if (Math.abs(sashLeft - rightEdge) < 10 && sa.parentElement?.classList.contains('sash-container')) {
                sa.setAttribute('data-ag-sash', '1');
              }
            });
          }
          // 强制取消所有正在运行的 CSS 动画
          const runningAnims = document.getAnimations?.() || [];
          let cancelled = 0;
          runningAnims.forEach(a => { try { a.cancel(); cancelled++; } catch {} });
          // rAF 节流：降到 ~5fps（每 200ms 一帧）
          if (!window.__agOrigRAF) {
            window.__agOrigRAF = window.requestAnimationFrame;
            window.requestAnimationFrame = (cb) => {
              return setTimeout(() => window.__agOrigRAF(cb), 200);
            };
          }
          ` : ''}
          const anims = document.getAnimations?.()?.length || 0;
          return { ok: true, anims${MODE === "full" ? ", cancelled" : ""} };
        })()`;

        const res = await cdp.call("Runtime.evaluate", {
          expression: script,
          returnByValue: true,
        });
        // full 模式: 通过 CDP 设置 prefers-reduced-motion
        if (MODE === "full") {
          try {
            await cdp.call("Emulation.setEmulatedMedia", {
              features: [{ name: "prefers-reduced-motion", value: "reduce" }]
            });
          } catch {}
        }
        const v = res.result?.value;
        if (v?.ok) {
          console.log(`  ⚡ 已注入: ${target.title?.substring(0, 50)}`);
          console.log(`     残余动画: ${v.anims}${v.cancelled ? ` | 已取消: ${v.cancelled}` : ''}`);
          ok++;
        }
      }
      cdp.close();
    } catch (e) {
      console.log(`  ⚠️  失败: ${target.title?.substring(0, 50)} — ${e.message || e}`);
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  if (MODE === "close-tabs") {
    console.log(`  📑 完成 — ${ok}/${allTargets.length} 个窗口的文件 tab 已关闭\n`);
  } else if (MODE === "off") {
    console.log(`  🧹 完成 — 简化 CSS 已移除\n`);
  } else {
    console.log(`  ⚡ 完成 — ${ok}/${allTargets.length} 个页面已简化 (${MODE})`);
    console.log(`\n  💡 快捷命令:`);
    console.log(`     node test-simplify.mjs off         # 恢复原状`);
    console.log(`     node test-simplify.mjs light       # 轻度模式`);
    console.log(`     node test-simplify.mjs full        # 完全模式`);
    console.log(`     node test-simplify.mjs close-tabs  # 关闭文件 tab\n`);
  }
}

main().catch((e) => { console.error("错误:", e); process.exit(1); });
