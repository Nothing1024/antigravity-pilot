import http from "node:http";
import net from "node:net";

// 来源：legacy server.js (已删除) checkPort()
export function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(400);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

// 来源：legacy server.js (已删除) getJson()
export function getJson<T = unknown>(url: string): Promise<T> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          resolve([] as unknown as T);
        }
      });
    });

    req.on("error", () => resolve([] as unknown as T));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve([] as unknown as T);
    });
  });
}

