#!/usr/bin/env node
/**
 * 聊天接口（SSE 流式）高并发压测脚本
 *
 * 用法：
 *   node loadtest_chat.js --url=http://43.143.63.243:3000 \
 *        --concurrency=20 --requests=200 --username=admin --password=qwea1230
 *
 * 说明：
 *   - 脚本先登录一次拿到 token，再用该 token 并发发起 SSE 聊天请求。
 *   - 每次请求都会创建一个新会话（sessionId 随机），走真实的「鉴权→会话→落库→SSE」链路。
 *   - 若要安全地压测上千并发（不烧 AI 费用），请先在服务端开启 MOCK_AI=1，
 *     这样 /api/chat 不会调用真实大模型，只会模拟逐字流式返回。
 *   - 参数用「等号」分隔，例如 --concurrency=20（不要用空格）。
 */

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}

const URL = args.url || "http://localhost:3000";
const CONCURRENCY = parseInt(args.concurrency || "10", 10);
const TOTAL = parseInt(args.requests || "100", 10);
const USERNAME = args.username || "admin";
const PASSWORD = args.password || "qwea1230";
const MESSAGE = args.message || "帮我推荐适合 550 分的计算机专业院校";
const REQ_TIMEOUT = parseInt(args.timeout || "30000", 10); // 单请求最长 30s

function parseArgsInto(argv) {
  // 兼容空格写法（--concurrency 20）兜底
  for (let i = 2; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)$/);
    if (m && i + 1 < argv.length) {
      if (!args[m[1]]) args[m[1]] = argv[i + 1];
      i++;
    }
  }
}
parseArgsInto(process.argv);

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
};

async function login() {
  const resp = await fetch(`${URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!resp.ok) throw new Error(`登录失败 HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const token = data.token || (data.data && data.data.token);
  if (!token) throw new Error("登录响应里没有 token");
  return token;
}

// 单次 SSE 聊天请求，返回本次指标
async function chatOnce(token, idx) {
  const sessionId = "loadtest-" + Math.random().toString(36).slice(2) + "-" + idx;
  const start = Date.now();
  let ttft = -1; // time to first token
  let events = 0;
  let gotDone = false;
  let errorMsg = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT);

  try {
    const resp = await fetch(`${URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        sessionId,
        message: MESSAGE,
        model: "deepseek-chat",
        webSearch: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      errorMsg = `HTTP ${resp.status}`;
      clearTimeout(timer);
      return { ok: false, ttft, latency: Date.now() - start, events, error: errorMsg };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          events++;
          if (ttft < 0 && evt.type === "text") ttft = Date.now() - start;
          if (evt.type === "done") gotDone = true;
          if (evt.type === "error") errorMsg = evt.message || "stream error";
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") errorMsg = "timeout";
    else errorMsg = e.message || String(e);
  } finally {
    clearTimeout(timer);
  }

  const latency = Date.now() - start;
  const ok = gotDone && !errorMsg;
  return { ok, ttft, latency, events, error: errorMsg };
}

async function main() {
  console.log("===== 聊天接口 SSE 压测 =====");
  console.log(`目标: ${URL}`);
  console.log(`并发: ${CONCURRENCY}  总请求: ${TOTAL}`);
  console.log(`账号: ${USERNAME}`);
  console.log("");

  const t0 = Date.now();
  let token;
  try {
    token = await login();
    console.log("✓ 登录成功，已获取 token\n");
  } catch (e) {
    console.error("✗ 登录失败，无法继续：", e.message);
    process.exit(1);
  }

  const results = [];
  let inFlight = 0;
  let dispatched = 0;
  let completed = 0;

  await new Promise((resolve) => {
    function pump() {
      while (inFlight < CONCURRENCY && dispatched < TOTAL) {
        inFlight++;
        dispatched++;
        const myIdx = dispatched;
        chatOnce(token, myIdx)
          .then((r) => {
            results.push(r);
            completed++;
            inFlight--;
            if (dispatched >= TOTAL && inFlight === 0) resolve();
            else pump();
          })
          .catch((e) => {
            results.push({ ok: false, ttft: -1, latency: 0, events: 0, error: e.message });
            completed++;
            inFlight--;
            if (dispatched >= TOTAL && inFlight === 0) resolve();
            else pump();
          });
      }
    }
    pump();
  });

  const wall = Date.now() - t0;
  const okList = results.filter((r) => r.ok);
  const failList = results.filter((r) => !r.ok);
  const ttfts = okList.map((r) => r.ttft).filter((x) => x >= 0);
  const lats = results.map((r) => r.latency);
  const totalEvents = results.reduce((s, r) => s + r.events, 0);

  console.log("\n===== 结果汇总 =====");
  console.log(`总请求:     ${TOTAL}`);
  console.log(`成功(收到done): ${okList.length}`);
  console.log(`失败:       ${failList.length}`);
  console.log(`错误率:     ${(failList.length / TOTAL * 100).toFixed(2)}%`);
  console.log(`吞吐 QPS:   ${(TOTAL / (wall / 1000)).toFixed(1)}`);
  console.log(`总耗时:     ${(wall / 1000).toFixed(2)}s`);
  console.log(`SSE事件总数: ${totalEvents}`);
  console.log("");
  console.log("----- 首字延迟 TTFB (ms) -----");
  console.log(`  平均: ${avg(ttfts).toFixed(0)}   P50: ${pct(ttfts, 50)}   P99: ${pct(ttfts, 99)}`);
  console.log("----- 单请求总耗时 (ms) -----");
  console.log(`  平均: ${avg(lats).toFixed(0)}   P50: ${pct(lats, 50)}   P99: ${pct(lats, 99)}`);
  if (failList.length > 0) {
    const sample = failList.slice(0, 5).map((r) => r.error).join(" | ");
    console.log("\n失败样例: " + sample);
  }
}

function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }

main();
