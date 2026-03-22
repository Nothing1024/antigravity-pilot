import type { LocaleKeys } from "./en";

const zhCN: Record<LocaleKeys, string> = {
  // Common
  loading: "加载中…",
  close: "关闭",
  cancel: "取消",
  open: "打开",

  // Login
  "login.title": "Antigravity",
  "login.subtitle": "请输入密码以继续",
  "login.password": "密码",
  "login.submit": "登录",
  "login.submitting": "登录中…",
  "login.error.denied": "访问被拒绝",
  "login.error.network": "网络错误，请重试。",
  "login.footer": "v3.0.0 · 安全连接",

  // AppShell
  "shell.workspace": "工作区",
  "shell.chat": "聊天",
  "shell.config": "设置",
  "shell.hideSidebar": "隐藏侧栏",
  "shell.showSidebar": "显示侧栏",
  "shell.openProject": "打开项目",
  "shell.sessions": "会话",

  // Cascade List
  "cascadeList.empty": "暂无会话",
  "cascadeList.untitled": "未命名会话",

  // Drawer Actions
  "drawer.newConversation": "新建对话",
  "drawer.openProject": "打开项目",
  "drawer.terminateAll": "终止所有",
  "drawer.terminateConfirm": "此操作将终止所有 Antigravity 实例，确定吗？",
  "drawer.confirm": "确认",

  // Message Input
  "input.placeholder": "发送消息…",
  "input.waiting": "等待连接…",
  "input.clear": "清空草稿",
  "input.clearConfirm": "确定清空当前草稿吗？此操作不可撤销。",
  "input.clearAction": "清空",

  // Settings
  "settings.appearance": "外观",
  "settings.appearance.desc": "选择你偏好的主题。",
  "settings.theme.light": "浅色",
  "settings.theme.dark": "深色",
  "settings.theme.system": "跟随系统",
  "settings.sendMode": "发送消息",
  "settings.sendMode.desc": "选择发送消息的方式。",
  "settings.sendMode.enter": "Enter",
  "settings.sendMode.enter.desc": "Shift+Enter 换行",
  "settings.sendMode.ctrlEnter": "Ctrl+Enter",
  "settings.sendMode.ctrlEnter.desc": "Enter 换行",
  "settings.language": "语言",
  "settings.language.desc": "选择显示语言。",
  "settings.automation": "自动化",
  "settings.automation.desc": "自动操作，减少手动干预。",
  "settings.autoAccept": "自动全部接受",
  "settings.autoAccept.desc": '当聊天中出现 "Accept all" 时自动点击。',
  "settings.autoRetry": "错误自动重试",
  "settings.autoRetry.desc": '当出现 "Agent terminated due to error" 时自动点击 "Retry"。',
  "settings.backoff": "指数退避",
  "settings.backoff.desc": "重试间隔递增（10秒 → 30秒 → 60秒 → 120秒）。",
  "settings.notifications": "通知",
  "settings.notifications.desc": "AI 任务完成时收到通知。",
  "settings.push": "推送通知",
  "settings.push.enabled": "通知已启用",
  "settings.push.disabled": "通知已禁用",
  "settings.push.unsupported": "此浏览器不支持推送通知。",
  "settings.about": "关于",
  "settings.version": "版本",
  "settings.stack": "技术栈",
  "settings.simplify": "IDE GPU 简化",
  "settings.simplify.desc": "向 IDE 注入 CSS 以降低 GPU 渲染开销。",
  "settings.simplify.full": "完全简化",
  "settings.simplify.full.desc": "隐藏编辑器、侧栏、终端 — 仅保留聊天面板。",
  "settings.simplify.light": "轻度简化",
  "settings.simplify.light.desc": "禁用动画，隐藏小地图和终端。",
  "settings.simplify.off": "关闭",
  "settings.simplify.off.desc": "正常 IDE 渲染。",
  "settings.simplify.applying": "应用中…",

  // Project Browser
  "project.title": "打开项目",
  "project.noFolders": "没有文件夹",

  // File Preview
  "filePreview.title": "文件预览",

  // Error Boundary
  "error.title": "出了点问题",
  "error.reload": "重新加载",
};

export default zhCN;
