<p align="center">
  <br />
  <strong>🚀 Antigravity Pilot</strong>
  <br />
  <em>Ground control for your AI coding sessions</em>
  <br /><br />
  <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#architecture">Architecture</a> · <a href="#configuration">Configuration</a>
</p>

---

When [Antigravity IDE](https://antigravity.google) is running a long coding task, you don't need to sit and watch. **Antigravity Pilot** lets you monitor progress, send messages, and get notified — all from your phone.

<br />

## Features

| | Feature | Description |
|---|---------|-------------|
| 📡 | **Real-time Snapshots** | Live chat view via WebSocket, rendered in an isolated Shadow DOM with morphdom diffing |
| 💬 | **Message Injection** | Send messages to the AI directly from your phone |
| 🖱️ | **Click Passthrough** | Click buttons in the IDE remotely — Accept All, Retry, file links, popups |
| 🔔 | **Push Notifications** | Get notified instantly when the AI completes a task (Web Push / VAPID) |
| 🤖 | **Auto Actions** | Auto-accept changes or auto-retry on errors with exponential backoff |
| 📊 | **Quota Monitor** | Track model usage and rate limits across accounts |
| 📂 | **Project Browser** | Browse folders and open projects in new Antigravity windows |
| 🎨 | **Theme Sync** | Automatically mirrors the IDE's color scheme (dark / light / follow system) |
| 🔐 | **Auth** | HMAC-SHA256 token authentication with HTTP-only cookies |
| 📱 | **PWA** | Install as a home screen app with offline-ready Service Worker |

<br />

## Architecture

```
┌─────────────────┐      CDP / WebSocket       ┌────────────────┐      HTTP / WS      ┌───────────┐
│   Antigravity    │◄──────────────────────────►│   @ag/server   │◄────────────────────►│  Mobile   │
│      IDE         │   Ports 9000–9003          │   Port 3563    │                      │  Browser  │
│   (Electron)     │                            │  (Express+WS)  │                      │   (PWA)   │
└─────────────────┘                             └────────────────┘                      └───────────┘
        ▲                                              │
        │  Runtime.evaluate                            │  Broadcast
        │  Input.dispatch*                             │  snapshot_update
        │  DOM snapshot capture                        │  cascade_list
        └──────────────────────────────────────────────┘  ai_complete
```

**Three packages in a pnpm monorepo:**

| Package | Role |
|---------|------|
| `@ag/shared` | TypeScript types, constants, and WebSocket message protocol |
| `@ag/server` | Express backend — CDP connection management, snapshot capture loop, auto-actions, push notifications |
| `@ag/web` | React 19 + Vite frontend — Shadow DOM chat renderer, Zustand state, TailwindCSS v4 |

<br />

## Quick Start

```bash
# Clone
git clone https://github.com/<your-username>/antigravity-pilot.git
cd antigravity-pilot

# Install
pnpm install

# Configure
cp config.example.json config.json
# Edit config.json — set your password at minimum

# Development (frontend + backend)
pnpm dev

# Production
pnpm build && pnpm start
```

Open `http://<your-local-ip>:3563` from your phone.

> **Prerequisite**: Launch Antigravity IDE with `--remote-debugging-port=9000` enabled, or use the built-in **Launch** button from the app.

<br />

## Configuration

Edit `config.json` in the project root:

```jsonc
{
  "password": "monitor",          // Login password
  "port": 3563,                   // Web server port
  "antigravityPath": "",          // Path to Antigravity executable (empty = auto-detect)
  "cdpPorts": [9000, 9001, 9002, 9003],  // CDP ports to scan
  "managerUrl": "http://127.0.0.1:8045", // Optional: Antigravity-Manager URL
  "managerPassword": "",          // Optional: Manager API key
  "vapidKeys": null,              // Auto-generated on first run
  "autoActions": {
    "autoAcceptAll": false,       // Auto-click "Accept All" when it appears
    "autoRetry": false,           // Auto-retry on "Agent terminated due to error"
    "retryBackoff": true          // Exponential backoff: 10s → 30s → 60s → 120s
  }
}
```

All settings can also be overridden via environment variables:

| Env Variable | Maps To |
|--------------|---------|
| `PASSWORD` | `password` |
| `PORT` | `port` |
| `ANTIGRAVITY_PATH` | `antigravityPath` |
| `AUTH_SECRET` | `authSecret` |
| `VAPID_SUBJECT` | `vapidSubject` |
| `MANAGER_URL` | `managerUrl` |
| `MANAGER_PASSWORD` | `managerPassword` |

<br />

## How It Works

1. **Discovery** — The server polls CDP debug ports every 10s, looking for Antigravity workbench windows
2. **Snapshot Loop** — Every 1s, captures the chat DOM via `Runtime.evaluate`, diffs by hash, and pushes changes over WebSocket
3. **Rendering** — The frontend receives HTML snapshots and applies them inside a **Shadow DOM** using [morphdom](https://github.com/patrick-steele-idem/morphdom) for smooth, flicker-free updates
4. **Click Passthrough** — Clickable elements are annotated with `data-cdp-click` indexes mapping to CSS selectors; tapping them dispatches a full Pointer+Mouse event sequence back to the IDE
5. **Auto Actions** — After each snapshot, checks for "Accept All" buttons or error states, and auto-clicks with configurable cooldowns and exponential backoff

<br />

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces |
| Language | TypeScript (strict mode) |
| Backend | Express 4 · ws 8 · web-push |
| Frontend | React 19 · Vite 8 · TailwindCSS v4 |
| State | Zustand 5 |
| DOM Diffing | morphdom |
| Protocol | Chrome DevTools Protocol (CDP) |
| PWA | Service Worker · Web Push (VAPID) |

<br />

## API Reference

<details>
<summary><strong>REST Endpoints</strong></summary>

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | Authenticate with password |
| GET | `/cascades` | List connected IDE sessions |
| GET | `/snapshot/:id` | Get latest chat snapshot |
| GET | `/styles/:id` | Get IDE CSS + computed vars |
| GET | `/api/quota/:id` | Get model quota info |
| POST | `/send/:id` | Inject a message into the chat |
| POST | `/click/:id` | Forward a click to the IDE |
| POST | `/popup/:id` | Extract popup/dialog items |
| POST | `/popup-click/:id` | Click a popup item |
| POST | `/scroll/:id` | Sync scroll position |
| POST | `/dismiss/:id` | Send Escape to close popups |
| POST | `/new-conversation/:id` | Start a new conversation |
| POST | `/api/launch` | Launch Antigravity IDE |
| POST | `/api/kill-all` | Kill all Antigravity instances |
| POST | `/api/close-cascade/:id` | Close a single IDE window |
| GET | `/api/active-file/:id` | Read the active editor file |
| POST | `/api/close-tab/:id` | Close the active editor tab |
| GET | `/api/browse` | Browse filesystem directories |
| POST | `/api/open-project` | Open a project in Antigravity |
| GET/PUT | `/api/auto-actions` | Get/set auto-action settings |
| GET | `/api/push/vapid-key` | Get VAPID public key |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |

</details>

<details>
<summary><strong>WebSocket Messages</strong></summary>

Connect to `ws://<host>:3563/ws` (auth cookie required).

| Type | Direction | Payload |
|------|-----------|---------|
| `cascade_list` | Server → Client | `{ cascades: [{ id, title, window, active, quota }] }` |
| `snapshot_update` | Server → Client | `{ cascadeId, snapshot: { html, bodyBg, bodyColor, clickMap, ... } }` |
| `css_update` | Server → Client | `{ cascadeId }` |
| `ai_complete` | Server → Client | `{ cascadeId, title }` |
| `quota_update` | Server → Client | `{ cascadeId, quota: { statusText, planName, models } }` |
| `auto_action` | Server → Client | `{ cascadeId, action, title }` |

</details>

<br />

## License

MIT

