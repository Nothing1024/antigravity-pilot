#!/usr/bin/env node
/**
 * Antigravity Pilot CLI
 *
 * Interactive menu for controlling Antigravity IDE via the API.
 * Usage: node cli.mjs [BASE_URL] [API_KEY]
 */

import readline from "node:readline";

const BASE_URL = process.argv[2] || "http://localhost:3563";
const API_KEY = process.argv[3] || "sk-pilot-test-key";

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function api(method, path, body) {
  const opts = { method, headers: { ...headers } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ── Colors ──
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgGray: "\x1b[100m",
};

function title(t) {
  console.log(`\n${C.bold}${C.cyan}━━━ ${t} ━━━${C.reset}\n`);
}

function ok(msg) {
  console.log(`${C.green}✅ ${msg}${C.reset}`);
}
function err(msg) {
  console.log(`${C.red}❌ ${msg}${C.reset}`);
}
function info(msg) {
  console.log(`${C.dim}${msg}${C.reset}`);
}

// ── Cache ──
let cachedCascades = [];

async function refreshCascades() {
  const { status, data } = await api("GET", "/api/status");
  if (status === 200 && data.cascades) {
    cachedCascades = data.cascades;
  }
  return cachedCascades;
}

async function pickCascade() {
  const cascades = await refreshCascades();
  if (cascades.length === 0) {
    err("没有可用的 cascade（IDE 未连接）");
    return null;
  }
  if (cascades.length === 1) {
    info(`自动选择: "${cascades[0].title}" (${cascades[0].id.slice(0, 8)}...)`);
    return cascades[0];
  }
  console.log("");
  cascades.forEach((c, i) => {
    const phase = c.phase === "idle" ? C.green + c.phase : C.yellow + c.phase;
    console.log(
      `  ${C.bold}${i + 1}${C.reset}. ${c.title} ${C.dim}[${c.id.slice(0, 8)}...]${C.reset} ${phase}${C.reset}`
    );
  });
  const choice = await ask(`\n选择 cascade [1-${cascades.length}]: `);
  const idx = parseInt(choice) - 1;
  if (idx < 0 || idx >= cascades.length) {
    err("无效选择");
    return null;
  }
  return cascades[idx];
}

// ══════════════════════════════════════════════════════════
// Menu Actions
// ══════════════════════════════════════════════════════════

async function actionHealth() {
  title("健康检查");
  const { status, data } = await api("GET", "/api/health");
  status === 200 ? ok(`Server healthy: ${data.timestamp}`) : err(JSON.stringify(data));
}

async function actionStatus() {
  title("系统状态");
  const { status, data } = await api("GET", "/api/status");
  if (status !== 200) return err(JSON.stringify(data));

  console.log(`  版本:    ${C.bold}${data.version}${C.reset}`);
  console.log(`  运行时间: ${data.uptime}s`);
  console.log(`  连接池:   ${C.green}${data.connectionPool.active} active${C.reset}  ${C.yellow}${data.connectionPool.unhealthy} unhealthy${C.reset}  ${C.red}${data.connectionPool.disconnected} disconnected${C.reset}`);
  console.log(`\n  Cascades (${data.cascades.length}):`);
  data.cascades.forEach((c) => {
    const phase = c.phase === "idle" ? C.green + c.phase : C.yellow + c.phase;
    const conn = c.connected ? C.green + "●" : C.red + "○";
    console.log(`    ${conn}${C.reset} ${c.title} ${C.dim}[${c.id.slice(0, 8)}...]${C.reset}  phase=${phase}${C.reset}`);
  });
}

async function actionModels() {
  title("模型列表");
  const { status, data } = await api("GET", "/v1/models");
  if (status !== 200) return err(JSON.stringify(data));

  console.log(`  共 ${data.data.length} 个模型:`);
  data.data.forEach((m) => {
    console.log(`    ${C.bold}${m.id}${C.reset}  ${C.dim}(${m.owned_by})${C.reset}`);
  });
}

async function actionWorkspaces() {
  title("工作空间列表");
  const { status, data } = await api("GET", "/api/workspaces");
  if (status !== 200) return err(JSON.stringify(data));

  if (data.workspaces.length === 0) {
    info("没有活跃的工作空间");
    return;
  }

  data.workspaces.forEach((w) => {
    const phase = w.phase === "idle" ? C.green + w.phase : C.yellow + w.phase;
    console.log(`  ${C.bold}${w.folder || "unknown"}${C.reset}`);
    console.log(`    cascade: ${w.chatTitle} ${C.dim}[${w.cascadeId.slice(0, 8)}...]${C.reset}`);
    console.log(`    phase: ${phase}${C.reset}  connection: ${w.connectionState}`);
    console.log("");
  });
}

async function actionLaunch() {
  title("启动新 IDE 实例");
  const folder = await ask("输入文件夹路径: ");
  if (!folder.trim()) return err("文件夹路径不能为空");

  info(`正在启动 Antigravity IDE → ${folder.trim()}`);
  const { status, data } = await api("POST", "/api/workspace/launch", {
    folder: folder.trim(),
  });

  if (status === 200 && data.success) {
    ok(`${data.message}`);
    if (data.action === "existing") {
      info(`已有 cascade: ${data.chatTitle} (${data.cascadeId.slice(0, 8)}...)`);
    } else {
      info(`CDP 端口: ${data.cdpPort}`);
      info("等待 ~10s 后 IDE 将出现在 cascade 列表中");
    }
  } else {
    err(data.error || JSON.stringify(data));
  }
}

async function actionChat() {
  title("对话 (Chat Completions)");
  const cascade = await pickCascade();
  if (!cascade) return;

  const model = `cascade:${cascade.id}`;
  info(`目标 cascade: "${cascade.title}" → model=${model}`);

  console.log(`\n${C.magenta}对话模式${C.reset} — 输入消息发送给 Antigravity agent`);
  console.log(`${C.dim}输入 /quit 退出  |  /stream 切换流式  |  /stop 中断生成${C.reset}`);
  console.log(`${C.dim}     /clear 清空上下文  |  /history 查看消息数${C.reset}\n`);

  let streaming = true;
  const conversationHistory = []; // multi-turn context
  info(`当前模式: ${streaming ? "流式 (SSE)" : "非流式"} | 对话上下文: 已启用`);

  while (true) {
    const msg = await ask(`${C.blue}You>${C.reset} `);
    if (!msg.trim()) continue;

    if (msg.trim() === "/quit") break;

    if (msg.trim() === "/stream") {
      streaming = !streaming;
      info(`切换到: ${streaming ? "流式 (SSE)" : "非流式"}`);
      continue;
    }

    if (msg.trim() === "/stop") {
      const { data } = await api("POST", `/api/stop/${cascade.id}`);
      data.success ? ok("已发送中断信号") : err(data.error || "中断失败");
      continue;
    }

    if (msg.trim() === "/clear") {
      conversationHistory.length = 0;
      ok(`对话上下文已清空`);
      continue;
    }

    if (msg.trim() === "/history") {
      info(`当前对话历史: ${conversationHistory.length} 条消息`);
      conversationHistory.forEach((m, i) => {
        const role = m.role === "user" ? C.blue + "You" : C.green + "Agent";
        const preview = m.content.substring(0, 60).replace(/\n/g, " ");
        console.log(`  ${C.dim}${i + 1}.${C.reset} ${role}${C.reset}: ${C.dim}${preview}...${C.reset}`);
      });
      continue;
    }

    // Add user message to history
    conversationHistory.push({ role: "user", content: msg });

    if (streaming) {
      // SSE streaming with colorized output
      process.stdout.write(`${C.green}Agent>${C.reset} `);

      // State machine for colorized output
      let accum = ""; // accumulated full response text
      let rendered = 0; // how many chars we've already rendered
      let inThink = false;
      let inCode = false;

      function renderNewContent(newText) {
        accum += newText;
        // Process only new content from 'rendered' position
        while (rendered < accum.length) {
          const remaining = accum.slice(rendered);

          // --- <think> open tag ---
          if (!inThink && remaining.startsWith("<think>")) {
            process.stdout.write(
              `\n${C.gray}${C.dim}┌─ 💭 Thinking ─────────────────────${C.reset}\n${C.gray}${C.dim}`
            );
            rendered += 7; // skip "<think>"
            inThink = true;
            continue;
          }

          // --- </think> close tag ---
          if (inThink && remaining.startsWith("</think>")) {
            process.stdout.write(
              `${C.reset}\n${C.gray}${C.dim}└───────────────────────────────────${C.reset}\n`
            );
            rendered += 8; // skip "</think>"
            inThink = false;
            continue;
          }

          // --- Fenced code block open/close ---
          if (remaining.startsWith("```")) {
            const endOfLine = remaining.indexOf("\n");
            if (!inCode) {
              const lang = endOfLine > 3 ? remaining.slice(3, endOfLine).trim() : "";
              const langLabel = lang ? ` ${lang}` : "";
              process.stdout.write(
                `\n${C.yellow}${C.dim}┌─ 📄${langLabel} ─────${C.reset}\n${C.yellow}`
              );
              rendered += endOfLine >= 0 ? endOfLine + 1 : remaining.length;
              inCode = true;
            } else {
              process.stdout.write(`${C.reset}\n${C.yellow}${C.dim}└──────────${C.reset}\n`);
              rendered += endOfLine >= 0 ? endOfLine + 1 : remaining.length;
              inCode = false;
            }
            continue;
          }

          // --- Inside think block: dim gray ---
          if (inThink) {
            const nextClose = remaining.indexOf("</think>");
            const end = nextClose >= 0 ? nextClose : remaining.length;
            const chunk = remaining.slice(0, end);
            process.stdout.write(`${C.gray}${C.dim}${chunk}${C.reset}`);
            rendered += end;
            continue;
          }

          // --- Inside code block: yellow ---
          if (inCode) {
            const nextFence = remaining.indexOf("```");
            const end = nextFence >= 0 ? nextFence : remaining.length;
            const chunk = remaining.slice(0, end);
            process.stdout.write(`${C.yellow}${chunk}${C.reset}`);
            rendered += end;
            continue;
          }

          // --- Normal text: process line by line for formatting ---
          const nlIdx = remaining.indexOf("\n");
          const lineEnd = nlIdx >= 0 ? nlIdx + 1 : remaining.length;
          const line = remaining.slice(0, lineEnd);

          // Check if line is incomplete (no newline and we might get more)
          if (nlIdx < 0 && rendered + lineEnd >= accum.length) {
            // Incomplete line at the end — render it for now, may get more
            process.stdout.write(formatLine(line));
            rendered += lineEnd;
            break;
          }

          process.stdout.write(formatLine(line));
          rendered += lineEnd;
        }
      }

      function formatLine(line) {
        const trimmed = line.trim();

        // Headings
        if (trimmed.startsWith("#### "))
          return `${C.bold}${C.cyan}${line}${C.reset}`;
        if (trimmed.startsWith("### "))
          return `${C.bold}${C.cyan}${line}${C.reset}`;
        if (trimmed.startsWith("## "))
          return `${C.bold}${C.cyan}${line}${C.reset}`;
        if (trimmed.startsWith("# "))
          return `${C.bold}${C.cyan}${line}${C.reset}`;

        // Horizontal rule
        if (/^-{3,}$/.test(trimmed))
          return `${C.dim}${line}${C.reset}`;

        // Blockquote
        if (trimmed.startsWith("> "))
          return `${C.dim}${C.italic}${line}${C.reset}`;

        // List items
        if (/^\d+\.\s/.test(trimmed) || trimmed.startsWith("- "))
          return `${C.white}${line}${C.reset}`;

        // Table rows
        if (trimmed.startsWith("|") && trimmed.endsWith("|"))
          return `${C.dim}${line}${C.reset}`;

        // Tool/command indicators (if any survived filtering)
        if (/^(Ran |Analyzed|Edited|Created|Searched|Read )/.test(trimmed))
          return `${C.magenta}${C.dim}🔧 ${line}${C.reset}`;

        // Apply inline formatting: **bold**, *italic*, `code`
        let formatted = line;
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);
        formatted = formatted.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${C.italic}$1${C.reset}`);
        formatted = formatted.replace(/`([^`]+)`/g, `${C.yellow}$1${C.reset}`);
        return formatted;
      }

      try {
        const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            messages: [...conversationHistory],
            stream: true,
          }),
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          err(`HTTP ${res.status}: ${errData.error?.message || res.statusText}`);
          continue;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });

          // Process SSE lines
          const lines = buf.split("\n");
          buf = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;

            try {
              const chunk = JSON.parse(payload);
              const content = chunk.choices?.[0]?.delta?.content;
              if (content) renderNewContent(content);
            } catch {
              // skip malformed
            }
          }
        }

        // Close any open blocks
        if (inThink) {
          process.stdout.write(
            `${C.reset}\n${C.gray}${C.dim}└───────────────────────────────────${C.reset}\n`
          );
        }
        if (inCode) {
          process.stdout.write(`${C.reset}\n${C.yellow}${C.dim}└──────────${C.reset}\n`);
        }

        // Save assistant response to history
        if (accum.trim()) {
          conversationHistory.push({ role: "assistant", content: accum.trim() });
        }

        console.log("\n");
      } catch (e) {
        err(e.message);
      }
    } else {
      // Non-streaming
      info("等待 agent 回复...");
      const { status, data } = await api("POST", "/v1/chat/completions", {
        model,
        messages: [...conversationHistory],
        stream: false,
      });

      if (status === 200 && data.choices?.[0]?.message?.content) {
        const text = data.choices[0].message.content;
        process.stdout.write(`${C.green}Agent>${C.reset} `);
        // Render with formatting
        renderNonStreamContent(text);
        // Save assistant response to history
        conversationHistory.push({ role: "assistant", content: text });
        console.log("\n");
      } else {
        err(data.error?.message || JSON.stringify(data));
        // Remove failed user message from history
        conversationHistory.pop();
      }
    }
  }

  /**
   * Render non-streaming full text with colors (reuses formatLine logic)
   */
  function renderNonStreamContent(text) {
    let inThink = false;
    let inCode = false;
    const lines = text.split("\n");

    for (const line of lines) {
      if (line.trim() === "<think>") {
        process.stdout.write(
          `\n${C.gray}${C.dim}┌─ 💭 Thinking ─────────────────────${C.reset}\n`
        );
        inThink = true;
        continue;
      }
      if (line.trim() === "</think>") {
        process.stdout.write(
          `${C.reset}\n${C.gray}${C.dim}└───────────────────────────────────${C.reset}\n`
        );
        inThink = false;
        continue;
      }
      if (line.startsWith("```")) {
        if (!inCode) {
          const lang = line.slice(3).trim();
          const langLabel = lang ? ` ${lang}` : "";
          process.stdout.write(
            `\n${C.yellow}${C.dim}┌─ 📄${langLabel} ─────${C.reset}\n`
          );
          inCode = true;
        } else {
          process.stdout.write(`${C.reset}\n${C.yellow}${C.dim}└──────────${C.reset}\n`);
          inCode = false;
        }
        continue;
      }

      if (inThink) {
        process.stdout.write(`${C.gray}${C.dim}${line}\n${C.reset}`);
      } else if (inCode) {
        process.stdout.write(`${C.yellow}${line}\n${C.reset}`);
      } else {
        const trimmed = line.trim();
        if (trimmed.startsWith("# ")) {
          process.stdout.write(`${C.bold}${C.cyan}${line}\n${C.reset}`);
        } else if (trimmed.startsWith("> ")) {
          process.stdout.write(`${C.dim}${C.italic}${line}\n${C.reset}`);
        } else if (/^(Ran |Analyzed|Edited|Created|Searched|Read )/.test(trimmed)) {
          process.stdout.write(`${C.magenta}${C.dim}🔧 ${line}\n${C.reset}`);
        } else if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
          process.stdout.write(`${C.dim}${line}\n${C.reset}`);
        } else {
          let formatted = line;
          formatted = formatted.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);
          formatted = formatted.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${C.italic}$1${C.reset}`);
          formatted = formatted.replace(/`([^`]+)`/g, `${C.yellow}$1${C.reset}`);
          process.stdout.write(`${formatted}\n`);
        }
      }
    }
  }
}

async function actionSessions() {
  title("会话管理");
  const cascade = await pickCascade();
  if (!cascade) return;

  const { status, data } = await api("GET", `/api/sessions/${cascade.id}`);
  if (status !== 200) return err(data.error || JSON.stringify(data));

  if (data.hint) {
    info(data.hint);
    return;
  }

  if (!data.sessions || data.sessions.length === 0) {
    info("未找到会话列表");
    return;
  }

  console.log(`  共 ${data.sessions.length} 个会话:\n`);
  data.sessions.forEach((s, i) => {
    const active = s.active ? ` ${C.green}← 当前${C.reset}` : "";
    console.log(`    ${C.bold}${i + 1}${C.reset}. ${s.title}${active}`);
  });

  const action = await ask(`\n切换会话? 输入序号 (回车跳过): `);
  if (action.trim()) {
    const idx = parseInt(action) - 1;
    if (idx >= 0 && idx < data.sessions.length) {
      const { data: switchData } = await api(
        "POST",
        `/api/sessions/${cascade.id}/switch`,
        { selector: data.sessions[idx].selector }
      );
      switchData.success ? ok("已切换会话") : err(switchData.error || "切换失败");
    }
  }
}

async function actionNewSession() {
  title("新建会话");
  const cascade = await pickCascade();
  if (!cascade) return;

  const { data } = await api("POST", `/api/sessions/${cascade.id}/new`);
  data.success ? ok("新会话已创建") : err(data.error || "创建失败");
}

async function actionModel() {
  title("模型管理");
  const cascade = await pickCascade();
  if (!cascade) return;

  const { data } = await api("GET", `/api/model/${cascade.id}`);
  console.log(`  当前模型: ${C.bold}${data.model || "未知"}${C.reset} ${C.dim}(${data.source})${C.reset}`);

  const change = await ask("\n切换模型? 输入模型名 (回车跳过): ");
  if (change.trim()) {
    info(`正在切换到 "${change.trim()}"...`);
    const { data: switchData } = await api("PUT", `/api/model/${cascade.id}`, {
      model: change.trim(),
    });
    switchData.success
      ? ok(`已切换到 "${switchData.model}"`)
      : err(switchData.error || "切换失败");
  }
}

async function actionScreenshot() {
  title("截图");
  const cascade = await pickCascade();
  if (!cascade) return;

  const { status, data } = await api("GET", `/api/screenshot/${cascade.id}`);
  if (status === 200 && data.image) {
    const size = Math.round(data.image.length / 1024);
    ok(`截图成功 (${size}KB base64)`);
    info("图片 data URI 太长，未打印。可通过浏览器打开。");
  } else {
    err(data.error || "截图失败");
  }
}

async function actionStop() {
  title("中断 Agent");
  const cascade = await pickCascade();
  if (!cascade) return;

  const { data } = await api("POST", `/api/stop/${cascade.id}`);
  if (data.success) {
    ok(`已中断 (前状态: ${data.previousPhase}, 方式: ${data.method || "click"})`);
  } else {
    err(data.error || "中断失败");
  }
}

// ══════════════════════════════════════════════════════════
// Main Menu
// ══════════════════════════════════════════════════════════

const MENU = [
  { key: "1", label: "💬 对话 (Chat)", action: actionChat },
  { key: "2", label: "📊 系统状态", action: actionStatus },
  { key: "3", label: "📂 工作空间列表", action: actionWorkspaces },
  { key: "4", label: "🚀 启动新 IDE", action: actionLaunch },
  { key: "5", label: "📋 会话管理", action: actionSessions },
  { key: "6", label: "➕ 新建会话", action: actionNewSession },
  { key: "7", label: "🤖 模型管理", action: actionModel },
  { key: "8", label: "📸 截图", action: actionScreenshot },
  { key: "9", label: "🛑 中断 Agent", action: actionStop },
  { key: "0", label: "❤️  健康检查", action: actionHealth },
  { key: "m", label: "📦 模型列表 (OpenAI)", action: actionModels },
];

async function mainMenu() {
  console.log(`
${C.bold}${C.cyan}┌─────────────────────────────────────┐
│     🚀 Antigravity Pilot CLI        │
└─────────────────────────────────────┘${C.reset}
  ${C.dim}Server: ${BASE_URL}${C.reset}
  ${C.dim}API Key: ${API_KEY.slice(0, 12)}...${C.reset}
`);

  // Quick health check
  const { status } = await api("GET", "/api/health");
  if (status === 200) {
    ok("Server 连接正常\n");
  } else {
    err(`Server 不可达 (${BASE_URL})\n`);
  }

  while (true) {
    console.log(`${C.bold}── 主菜单 ──${C.reset}`);
    MENU.forEach((m) => {
      console.log(`  ${C.bold}${m.key}${C.reset}  ${m.label}`);
    });
    console.log(`  ${C.bold}q${C.reset}  退出\n`);

    const choice = await ask(`${C.cyan}>>>${C.reset} `);
    const trimmed = choice.trim().toLowerCase();

    if (trimmed === "q" || trimmed === "quit" || trimmed === "exit") {
      console.log(`\n${C.dim}再见！${C.reset}\n`);
      rl.close();
      process.exit(0);
    }

    const item = MENU.find((m) => m.key === trimmed);
    if (item) {
      try {
        await item.action();
      } catch (e) {
        err(`执行出错: ${e.message}`);
      }
      console.log("");
    } else {
      info("无效选项，请重新输入");
    }
  }
}

mainMenu();
