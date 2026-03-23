/**
 * EventBus — Internal pub/sub for decoupled communication between
 * Connection Pool, Response Monitor, API layer, and WebSocket broadcast.
 */

import { EventEmitter } from "node:events";

import type { ConnectionState, ResponsePhase } from "@ag/shared";

// --- Event Definitions ---

export interface PhaseChangeEvent {
  cascadeId: string;
  phase: ResponsePhase;
  previousPhase: ResponsePhase;
  timestamp: number;
}

export interface ConnectionStateEvent {
  cascadeId: string;
  state: ConnectionState;
  previousState: ConnectionState;
  timestamp: number;
}

export interface ResponseTextEvent {
  cascadeId: string;
  text: string;
  delta: string;
  timestamp: number;
}

// --- Typed EventBus ---

interface EventMap {
  phase_change: PhaseChangeEvent;
  connection_state: ConnectionStateEvent;
  response_text: ResponseTextEvent;
}

class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    // Increase max listeners since multiple subsystems listen
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.off(event, listener);
  }

  once<K extends keyof EventMap>(event: K, listener: (data: EventMap[K]) => void): void {
    this.emitter.once(event, listener);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.emitter.emit(event, data);
  }

  /**
   * Wait for a specific event matching a predicate, with timeout.
   */
  waitFor<K extends keyof EventMap>(
    event: K,
    predicate: (data: EventMap[K]) => boolean,
    timeoutMs: number = 300_000
  ): Promise<EventMap[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off(event, handler);
        reject(new Error(`Timeout waiting for event "${event}" after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (data: EventMap[K]) => {
        if (predicate(data)) {
          clearTimeout(timer);
          this.emitter.off(event, handler);
          resolve(data);
        }
      };

      this.emitter.on(event, handler);
    });
  }
}

// Singleton
export const eventBus = new TypedEventBus();
