/**
 * Cross-module event signaling for conversation lifecycle events.
 *
 * 用于在 REST 路由与 WebSocket 轮询之间传递“激活”信号：
 * 当用户通过 REST 发送消息后，WS 需要立即进入 ACTIVE 模式开始高频轮询。
 */

import { EventEmitter } from "events";

type ConversationSignalEvents = {
  activate: [cascadeId: string];
};

export const conversationSignals = new EventEmitter<ConversationSignalEvents>();
// 一个 WS 连接会注册一个 activate 监听；避免在多连接时触发 MaxListeners 警告。
conversationSignals.setMaxListeners(100);

