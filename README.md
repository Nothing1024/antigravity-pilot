<p align="center">
  <br />
  <strong>🚀 Antigravity Pilot</strong>
  <br />
  <em>Web UI for remotely monitoring & controlling Antigravity IDE</em>
  <br /><br />
  <a href="#quick-start">Quick Start</a> · <a href="#architecture">Architecture</a> · <a href="#configuration">Configuration</a> · <a href="#how-it-works">How It Works</a>
  <br />
  English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a>
</p>

---

**Antigravity Pilot** is a lightweight Web UI that connects to [Antigravity IDE](https://antigravity.google) via Chrome DevTools Protocol (CDP). It mirrors the IDE's chat in real-time and lets you send messages, click buttons, and manage sessions — from any browser, on any device.

<p align="center">
  <img src="assets/demo.png" alt="Antigravity Pilot Web UI" width="800" />
</p>

<br />

## Quick Start

```bash
# Clone
git clone https://github.com/Nothing1024/antigravity-pilot.git
cd antigravity-pilot

# Install
pnpm install

# Configure
cp config.example.json config.json
# Edit config.json — set your password at minimum

# Run
pnpm dev
```

Open `http://<your-ip>:5173` in any browser (dev mode).

For production: `pnpm build && pnpm start`, then access `http://<your-ip>:3563`.

### Launch Antigravity IDE (macOS)

```bash
# Basic — enable CDP debug port
open -a "Antigravity" --args --remote-debugging-port=9000

# With GPU optimization (improves Antigravity rendering performance)
open -a "Antigravity" --args --disable-gpu-driver-bug-workarounds --ignore-gpu-blacklist --enable-gpu-rasterization --remote-debugging-port=9000
```

> **Note** (ಥ_ಥ)  If the chat view sometimes freezes or stops updating, this is typically an Antigravity IDE upstream issue, not a problem with this project. Refreshing the page or restarting the IDE usually resolves it.

## Architecture

```
┌─────────────────┐      CDP / WebSocket       ┌────────────────┐      HTTP / WS      ┌───────────┐
│   Antigravity    │◄──────────────────────────►│   @ag/server   │◄────────────────────►│  Browser  │
│      IDE         │   Ports 9000–9003          │   Port 3563    │                      │   (PWA)   │
│   (Electron)     │                            │  (Express+WS)  │                      │           │
└─────────────────┘                             └────────────────┘                      └───────────┘
```

**Monorepo structure (pnpm workspaces):**

| Package | Role |
|---------|------|
| `@ag/shared` | TypeScript types and WebSocket message protocol |
| `@ag/server` | Express backend — CDP management, snapshot loop, auto-actions, push notifications |
| `@ag/web` | React 19 + Vite frontend — Shadow DOM renderer, Zustand state, i18n |

<br />

## Configuration

Edit `config.json` in the project root:

```jsonc
{
  "password": "your-password",        // Login password
  "port": 3563,                       // Web server port
  "antigravityPath": "",              // Path to Antigravity executable (empty = auto-detect)
  "cdpPorts": [9000, 9001, 9002, 9003],  // CDP ports to scan
  "managerUrl": "http://127.0.0.1:8045", // Optional: Antigravity-Manager URL
  "managerPassword": "",              // Optional: Manager API key
  "vapidKeys": null                   // Auto-generated on first run
}
```

### Client-side Settings (persisted in localStorage)

These settings are configured through the Web UI's **Config** page:

| Setting | Description |
|---------|-------------|
| **Theme** | Light / Dark / Follow System |
| **Language** | English / 简体中文 / 繁體中文 (auto-detected on first visit) |
| **Send Mode** | Enter to send / Ctrl+Enter to send |
| **Auto Accept All** | Auto-click "Accept all" when it appears |
| **Auto Retry** | Auto-click "Retry" on agent errors |
| **Exponential Backoff** | Retry delay: 10s → 30s → 60s → 120s |

> Client settings are stored in `localStorage` and synced to the server on page load. They survive server restarts.

<br />

## How It Works

1. **Discovery** — Server polls CDP debug ports every 10s, looking for Antigravity workbench windows
2. **Snapshot Loop** — Every 1s, captures the chat DOM via `Runtime.evaluate`, diffs by hash, pushes changes over WebSocket
3. **Rendering** — Frontend receives HTML snapshots and patches them inside a Shadow DOM via [morphdom](https://github.com/patrick-steele-idem/morphdom) for smooth updates
4. **Click Passthrough** — Tappable elements map to CSS selectors; clicks are dispatched via CDP `Input.dispatchMouseEvent` for reliable Electron compatibility
5. **Auto Actions** — After each snapshot, checks for target buttons and auto-clicks with configurable cooldowns

<br />

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces |
| Language | TypeScript (strict mode) |
| Backend | Express 4 · ws 8 · web-push |
| Frontend | React 19 · Vite 6 · Zustand 5 |
| i18n | Lightweight custom (zero deps) |
| DOM Diffing | morphdom |
| Protocol | Chrome DevTools Protocol (CDP) |
| PWA | Service Worker · Web Push (VAPID) |

<br />

## License

MIT
