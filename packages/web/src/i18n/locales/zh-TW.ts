import type { LocaleKeys } from "./en";

const zhTW: Record<LocaleKeys, string> = {
  // Common
  loading: "載入中…",
  close: "關閉",
  cancel: "取消",
  open: "開啟",

  // Login
  "login.title": "Antigravity",
  "login.subtitle": "請輸入密碼以繼續",
  "login.password": "密碼",
  "login.submit": "登入",
  "login.submitting": "登入中…",
  "login.error.denied": "存取被拒絕",
  "login.error.network": "網路錯誤，請重試。",
  "login.footer": "v3.0.0 · 安全連線",

  // AppShell
  "shell.workspace": "工作區",
  "shell.chat": "聊天",
  "shell.config": "設定",
  "shell.hideSidebar": "隱藏側邊欄",
  "shell.showSidebar": "顯示側邊欄",
  "shell.openProject": "開啟專案",
  "shell.sessions": "工作階段",

  // Cascade List
  "cascadeList.empty": "尚無工作階段",
  "cascadeList.untitled": "未命名工作階段",

  // Drawer Actions
  "drawer.newConversation": "新建對話",
  "drawer.openProject": "開啟專案",
  "drawer.terminateAll": "終止全部",

  // Message Input
  "input.placeholder": "傳送訊息…",
  "input.waiting": "等待連線…",

  // Settings
  "settings.appearance": "外觀",
  "settings.appearance.desc": "選擇你偏好的佈景主題。",
  "settings.theme.light": "淺色",
  "settings.theme.dark": "深色",
  "settings.theme.system": "跟隨系統",
  "settings.sendMode": "傳送訊息",
  "settings.sendMode.desc": "選擇傳送訊息的方式。",
  "settings.sendMode.enter": "Enter",
  "settings.sendMode.enter.desc": "Shift+Enter 換行",
  "settings.sendMode.ctrlEnter": "Ctrl+Enter",
  "settings.sendMode.ctrlEnter.desc": "Enter 換行",
  "settings.language": "語言",
  "settings.language.desc": "選擇顯示語言。",
  "settings.automation": "自動化",
  "settings.automation.desc": "自動操作，減少手動介入。",
  "settings.autoAccept": "自動全部接受",
  "settings.autoAccept.desc": '當聊天中出現 "Accept all" 時自動點擊。',
  "settings.autoRetry": "錯誤自動重試",
  "settings.autoRetry.desc": '當出現 "Agent terminated due to error" 時自動點擊 "Retry"。',
  "settings.backoff": "指數退避",
  "settings.backoff.desc": "重試間隔遞增（10秒 → 30秒 → 60秒 → 120秒）。",
  "settings.notifications": "通知",
  "settings.notifications.desc": "AI 任務完成時接收通知。",
  "settings.push": "推播通知",
  "settings.push.enabled": "通知已啟用",
  "settings.push.disabled": "通知已停用",
  "settings.push.unsupported": "此瀏覽器不支援推播通知。",
  "settings.about": "關於",
  "settings.version": "版本",
  "settings.stack": "技術堆疊",

  // Project Browser
  "project.title": "開啟專案",
  "project.noFolders": "沒有資料夾",

  // File Preview
  "filePreview.title": "檔案預覽",

  // Error Boundary
  "error.title": "發生了一些問題",
  "error.reload": "重新載入",
};

export default zhTW;
