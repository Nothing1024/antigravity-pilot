const en = {
  // Common
  loading: "Loading…",
  close: "Close",
  cancel: "Cancel",
  open: "Open",

  // Login
  "login.title": "Antigravity",
  "login.subtitle": "Enter your password to continue",
  "login.password": "Password",
  "login.submit": "Sign In",
  "login.submitting": "Signing in…",
  "login.error.denied": "Access Denied",
  "login.error.network": "Network error. Please try again.",
  "login.footer": "v3.0.0 · Secure Connection",

  // AppShell
  "shell.workspace": "Workspace",
  "shell.chat": "Chat",
  "shell.config": "Config",
  "shell.hideSidebar": "Hide sidebar",
  "shell.showSidebar": "Show sidebar",
  "shell.openProject": "Open Project",
  "shell.sessions": "Sessions",

  // Cascade List
  "cascadeList.empty": "No sessions",
  "cascadeList.untitled": "Untitled Session",

  // Drawer Actions
  "drawer.newConversation": "New Conversation",
  "drawer.openProject": "Open Project",
  "drawer.terminateAll": "Terminate All",

  // Message Input
  "input.placeholder": "Send a message…",
  "input.waiting": "Waiting for connection…",

  // Settings
  "settings.appearance": "Appearance",
  "settings.appearance.desc": "Choose your preferred theme.",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.theme.system": "System",
  "settings.sendMode": "Send Message",
  "settings.sendMode.desc": "Choose how to send messages.",
  "settings.sendMode.enter": "Enter",
  "settings.sendMode.enter.desc": "Shift+Enter for newline",
  "settings.sendMode.ctrlEnter": "Ctrl+Enter",
  "settings.sendMode.ctrlEnter.desc": "Enter for newline",
  "settings.language": "Language",
  "settings.language.desc": "Choose your display language.",
  "settings.automation": "Automation",
  "settings.automation.desc": "Automatic actions to reduce manual intervention.",
  "settings.autoAccept": "Auto Accept All",
  "settings.autoAccept.desc": 'Automatically click "Accept all" when it appears in the chat.',
  "settings.autoRetry": "Auto Retry on Error",
  "settings.autoRetry.desc": 'Automatically click "Retry" when "Agent terminated due to error" appears.',
  "settings.backoff": "Exponential Backoff",
  "settings.backoff.desc": "Increase delay between retries (10s → 30s → 60s → 120s).",
  "settings.notifications": "Notifications",
  "settings.notifications.desc": "Get notified when AI tasks complete.",
  "settings.push": "Push Notifications",
  "settings.push.enabled": "Notifications are enabled",
  "settings.push.disabled": "Notifications are disabled",
  "settings.push.unsupported": "Push notifications are not supported in this browser.",
  "settings.about": "About",
  "settings.version": "Version",
  "settings.stack": "Stack",
  "settings.simplify": "IDE GPU Simplification",
  "settings.simplify.desc": "Inject CSS into the IDE to reduce GPU rendering overhead.",
  "settings.simplify.full": "Full",
  "settings.simplify.full.desc": "Hide editor, sidebar, terminal — only keep chat panel.",
  "settings.simplify.light": "Light",
  "settings.simplify.light.desc": "Disable animations, hide minimap & terminal.",
  "settings.simplify.off": "Off",
  "settings.simplify.off.desc": "Normal IDE rendering.",
  "settings.simplify.applying": "Applying…",

  // Project Browser
  "project.title": "Open Project",
  "project.noFolders": "No folders",

  // File Preview
  "filePreview.title": "File preview",

  // Error Boundary
  "error.title": "Something went wrong",
  "error.reload": "Reload Page",
} as const;

export type LocaleKeys = keyof typeof en;
export default en;
