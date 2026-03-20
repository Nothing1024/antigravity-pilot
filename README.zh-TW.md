<p align="center">
  <br />
  <strong>🚀 Antigravity Pilot</strong>
  <br />
  <em>遠端監控和操控 Antigravity IDE 的 Web UI</em>
  <br /><br />
  <a href="#快速開始">快速開始</a> · <a href="#架構">架構</a> · <a href="#設定">設定</a> · <a href="#工作原理">工作原理</a>
  <br />
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文
</p>

---

**Antigravity Pilot** 是一個輕量級 Web UI，透過 Chrome DevTools Protocol (CDP) 連接到 [Antigravity IDE](https://antigravity.google)。它即時鏡像 IDE 的聊天介面，讓你可以在任意瀏覽器、任意裝置上傳送訊息、點擊按鈕、管理工作階段。

<p align="center">
  <img src="assets/demo.png" alt="Antigravity Pilot Web UI" width="800" />
</p>

<br />

## 快速開始

```bash
# 複製
git clone https://github.com/Nothing1024/antigravity-pilot.git
cd antigravity-pilot

# 安裝依賴
pnpm install

# 設定
cp config.example.json config.json
# 編輯 config.json — 至少設定密碼

# 啟動
pnpm dev
```

在瀏覽器中開啟 `http://<你的IP>:5173`（開發模式）。

正式環境：`pnpm build && pnpm start`，然後存取 `http://<你的IP>:3563`。

### 啟動 Antigravity IDE (macOS)

```bash
# 基本 — 開啟 CDP 偵錯連接埠
open -a "Antigravity" --args --remote-debugging-port=9000

# GPU 最佳化版（提升 Antigravity 繪製效能）
open -a "Antigravity" --args --disable-gpu-driver-bug-workarounds --ignore-gpu-blacklist --enable-gpu-rasterization --remote-debugging-port=9000
```

> **注意** (ಥ_ಥ)  如果聊天畫面偶爾卡住或停止更新，這通常是 Antigravity IDE 本身的問題，不是本專案的 bug。重新整理頁面或重啟 IDE 即可恢復。

## 架構

```
┌─────────────────┐      CDP / WebSocket       ┌────────────────┐      HTTP / WS      ┌───────────┐
│   Antigravity    │◄──────────────────────────►│   @ag/server   │◄────────────────────►│   瀏覽器   │
│      IDE         │   連接埠 9000–9003          │   連接埠 3563   │                      │   (PWA)   │
│   (Electron)     │                            │  (Express+WS)  │                      │           │
└─────────────────┘                             └────────────────┘                      └───────────┘
```

**Monorepo 結構（pnpm workspaces）：**

| 套件 | 職責 |
|------|------|
| `@ag/shared` | TypeScript 型別定義和 WebSocket 訊息協定 |
| `@ag/server` | Express 後端 — CDP 連線管理、快照迴圈、自動操作、推播通知 |
| `@ag/web` | React 19 + Vite 前端 — Shadow DOM 繪製器、Zustand 狀態管理、i18n |

<br />

## 設定

編輯專案根目錄下的 `config.json`：

```jsonc
{
  "password": "your-password",        // 登入密碼
  "port": 3563,                       // Web 伺服器連接埠
  "antigravityPath": "",              // Antigravity 可執行檔路徑（空 = 自動偵測）
  "cdpPorts": [9000, 9001, 9002, 9003],  // CDP 掃描連接埠
  "managerUrl": "http://127.0.0.1:8045", // 選用：Antigravity-Manager 位址
  "managerPassword": "",              // 選用：Manager API 金鑰
  "vapidKeys": null                   // 首次執行時自動產生
}
```

### 用戶端設定（儲存在 localStorage）

這些設定透過 Web UI 的**設定**頁面進行配置：

| 設定 | 說明 |
|------|------|
| **佈景主題** | 淺色 / 深色 / 跟隨系統 |
| **語言** | English / 简体中文 / 繁體中文（首次造訪自動偵測瀏覽器語言） |
| **傳送方式** | Enter 傳送 / Ctrl+Enter 傳送 |
| **自動全部接受** | 出現「Accept all」時自動點擊 |
| **自動重試** | Agent 報錯時自動點擊「Retry」 |
| **指數退避** | 重試間隔遞增：10秒 → 30秒 → 60秒 → 120秒 |

> 用戶端設定儲存在 `localStorage` 中，頁面載入時同步到伺服器。伺服器重啟後設定不會遺失。

<br />

## 工作原理

1. **探索** — 伺服器每 10 秒輪詢 CDP 偵錯連接埠，尋找 Antigravity 工作台視窗
2. **快照迴圈** — 每 1 秒透過 `Runtime.evaluate` 擷取聊天 DOM，按雜湊比對差異，透過 WebSocket 推送更新
3. **繪製** — 前端接收 HTML 快照，在 Shadow DOM 中透過 [morphdom](https://github.com/patrick-steele-idem/morphdom) 進行差異更新
4. **點擊透傳** — 可點擊元素對應到 CSS 選擇器，透過 CDP `Input.dispatchMouseEvent` 派發點擊事件，確保 Electron 相容性
5. **自動操作** — 每次快照後檢查目標按鈕，自動點擊並支援可設定的冷卻時間

<br />

## 技術堆疊

| 層級 | 技術 |
|------|------|
| Monorepo | pnpm workspaces |
| 語言 | TypeScript（嚴格模式） |
| 後端 | Express 4 · ws 8 · web-push |
| 前端 | React 19 · Vite 6 · Zustand 5 |
| 國際化 | 輕量自研方案（零外部依賴） |
| DOM 差異比對 | morphdom |
| 協定 | Chrome DevTools Protocol (CDP) |
| PWA | Service Worker · Web Push (VAPID) |

<br />

## 授權

MIT
