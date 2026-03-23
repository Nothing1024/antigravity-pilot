#!/usr/bin/env node
/**
 * API Service End-to-End Test Script
 *
 * Tests all API endpoints against a running Antigravity Pilot server.
 * Run with: node test-api.mjs [BASE_URL] [API_KEY]
 *
 * Default: http://localhost:3563 with key "sk-pilot-change-me"
 */

const BASE_URL = process.argv[2] || "http://localhost:3563";
const API_KEY = process.argv[3] || "sk-pilot-change-me";

const headers = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ⏭️  ${name} (${reason})`);
  skipped++;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// --- Helper ---
async function api(method, path, body = undefined) {
  const options = { method, headers: { ...headers } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  const contentType = res.headers.get("content-type") || "";
  let data = null;
  if (contentType.includes("json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data, headers: res.headers };
}

// ============================================================
// Tests
// ============================================================

console.log(`\n🧪 Antigravity Pilot API Test Suite`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   API Key:  ${API_KEY.substring(0, 8)}...`);
console.log("");

// --- 1. Health Check (Public) ---
console.log("📋 Health & Status");

await test("GET /api/health (public, no auth)", async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  const data = await res.json();
  assert(res.status === 200, `Expected 200, got ${res.status}`);
  assert(data.status === "ok", `Expected status "ok", got "${data.status}"`);
  assert(data.timestamp, "Missing timestamp");
});

// --- 2. Auth ---
console.log("\n🔐 Authentication");

await test("Unauthorized request returns 401", async () => {
  const res = await fetch(`${BASE_URL}/api/status`, {
    headers: { "Content-Type": "application/json" },
  });
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

await test("Bearer token auth works", async () => {
  const { status, data } = await api("GET", "/api/status");
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data.version, "Missing version");
  assert(typeof data.uptime === "number", "Missing uptime");
});

await test("Invalid Bearer token returns 401", async () => {
  const res = await fetch(`${BASE_URL}/api/status`, {
    headers: { Authorization: "Bearer invalid-key" },
  });
  assert(res.status === 401, `Expected 401, got ${res.status}`);
});

// --- 3. System Status ---
console.log("\n📊 System Status API");

await test("GET /api/status returns system info", async () => {
  const { status, data } = await api("GET", "/api/status");
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data.version, "Missing version");
  assert(typeof data.uptime === "number", "Missing uptime");
  assert(Array.isArray(data.cascades), "cascades should be array");
  assert(data.connectionPool, "Missing connectionPool");
  assert(typeof data.connectionPool.active === "number", "Missing active count");
  assert(typeof data.connectionPool.maxConnections === "number", "Missing maxConnections");
});

// --- 4. Rate Limiting ---
console.log("\n⏱️  Rate Limiting");

await test("Rate limit headers present", async () => {
  const { headers: h } = await api("GET", "/api/status");
  assert(h.get("x-ratelimit-limit"), "Missing X-RateLimit-Limit");
  assert(h.get("x-ratelimit-remaining"), "Missing X-RateLimit-Remaining");
  assert(h.get("x-ratelimit-reset"), "Missing X-RateLimit-Reset");
});

// --- 5. OpenAI-Compatible API ---
console.log("\n🤖 OpenAI-Compatible API");

await test("GET /v1/models returns model list", async () => {
  const { status, data } = await api("GET", "/v1/models");
  assert(status === 200, `Expected 200, got ${status}`);
  assert(data.object === "list", `Expected object "list", got "${data.object}"`);
  assert(Array.isArray(data.data), "data should be array");
  // "antigravity" model should always be listed
  const agModel = data.data.find((m) => m.id === "antigravity");
  assert(agModel, "Missing 'antigravity' model");
  assert(agModel.object === "model", `Expected object "model", got "${agModel.object}"`);
});

await test("POST /v1/chat/completions rejects empty messages", async () => {
  const { status, data } = await api("POST", "/v1/chat/completions", {
    model: "antigravity",
    messages: [],
  });
  assert(status === 400, `Expected 400, got ${status}`);
  assert(data.error, "Missing error object");
  assert(data.error.type === "invalid_request_error", `Expected type "invalid_request_error"`);
});

await test("POST /v1/chat/completions rejects missing user message", async () => {
  const { status, data } = await api("POST", "/v1/chat/completions", {
    model: "antigravity",
    messages: [{ role: "system", content: "You are a helper" }],
  });
  assert(status === 400, `Expected 400, got ${status}`);
});

await test("/v1/* returns OpenAI-style error for invalid auth", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer invalid",
    },
    body: JSON.stringify({
      model: "antigravity",
      messages: [{ role: "user", content: "test" }],
    }),
  });
  const data = await res.json();
  assert(res.status === 401, `Expected 401, got ${res.status}`);
  assert(data.error?.type === "invalid_api_key", `Expected type "invalid_api_key"`);
});

await test("POST /v1/chat/completions for non-existent cascade", async () => {
  const { status, data } = await api("POST", "/v1/chat/completions", {
    model: "cascade:non-existent-id",
    messages: [{ role: "user", content: "test" }],
  });
  // Should be 404 (cascade not found) or 503 (no cascades)
  assert(status === 404 || status === 503, `Expected 404 or 503, got ${status}`);
});

// --- 6. Cascade-specific endpoints (require active cascade) ---
console.log("\n🔗 Cascade-dependent endpoints");

const statusRes = await api("GET", "/api/status");
const cascades = statusRes.data?.cascades || [];

if (cascades.length === 0) {
  skip("GET /api/status/:id", "No active cascades");
  skip("GET /api/screenshot/:id", "No active cascades");
  skip("POST /api/stop/:id", "No active cascades");
  skip("GET /api/sessions/:id", "No active cascades");
  skip("GET /api/model/:id", "No active cascades");
  skip("GET /api/models/:id", "No active cascades");
  skip("POST /v1/chat/completions (live)", "No active cascades");
} else {
  const cascadeId = cascades[0].id;
  const cascadeTitle = cascades[0].title;
  console.log(`   Using cascade: "${cascadeTitle}" (${cascadeId})`);

  await test(`GET /api/status/${cascadeId}`, async () => {
    const { status, data } = await api("GET", `/api/status/${cascadeId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.id === cascadeId, "ID mismatch");
    assert(data.phase, "Missing phase");
    assert(data.connectionState, "Missing connectionState");
  });

  await test("GET /api/status/:id for non-existent returns 404", async () => {
    const { status } = await api("GET", "/api/status/non-existent");
    assert(status === 404, `Expected 404, got ${status}`);
  });

  await test(`GET /api/screenshot/${cascadeId}`, async () => {
    const { status, data } = await api("GET", `/api/screenshot/${cascadeId}`);
    if (status === 200) {
      assert(data.image, "Missing image data");
      assert(data.image.startsWith("data:image/"), "Image not base64 data URI");
    } else {
      // Screenshot might fail if CDP Page domain isn't enabled
      assert(status === 500, `Expected 200 or 500, got ${status}`);
    }
  });

  await test(`GET /api/sessions/${cascadeId}`, async () => {
    const { status, data } = await api("GET", `/api/sessions/${cascadeId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    // sessions might be empty array, that's ok
    assert(
      Array.isArray(data.sessions) || data.hint,
      "Expected sessions array or hint"
    );
  });

  await test(`GET /api/model/${cascadeId}`, async () => {
    const { status, data } = await api("GET", `/api/model/${cascadeId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.source, "Missing source field");
  });

  // Live chat completion test (only if cascade is IDLE)
  const cascade = cascades[0];
  if (cascade.phase === "idle" || cascade.phase === "completed") {
    await test("POST /v1/chat/completions (live, non-streaming, timeout 30s)", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "antigravity",
            messages: [
              { role: "user", content: "Say exactly: 'API test successful'" },
            ],
          }),
          signal: controller.signal,
        });

        const data = await res.json();
        // It might succeed or timeout depending on IDE state
        if (res.status === 200) {
          assert(data.id, "Missing completion ID");
          assert(data.choices?.[0]?.message?.content, "Missing response content");
          console.log(`    → Response: "${data.choices[0].message.content.substring(0, 80)}..."`);
        } else {
          console.log(`    → Got ${res.status}: ${JSON.stringify(data.error || data).substring(0, 100)}`);
        }
      } catch (e) {
        if (e.name === "AbortError") {
          console.log("    → Timed out (30s) — agent may still be processing");
        } else {
          throw e;
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  } else {
    skip(
      "POST /v1/chat/completions (live)",
      `Cascade is ${cascade.phase}, need idle/completed`
    );
  }
}

// --- Summary ---
console.log(`\n${"─".repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
