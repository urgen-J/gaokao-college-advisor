#!/usr/bin/env node
/**
 * 服务端一键注入 MOCK_AI 分支到 server/index.ts（仅用于已在运行的旧服务器快速打补丁，
 * 不必重新走 GitHub→Gitee 同步）。正常情况下部署已含 MOCK_AI 时本脚本会自动跳过。
 *
 * 在服务器上用法：
 *   cd ~
 *   node add_mock_ai.js        # 默认注入 ~/gaokao/server/index.ts
 *   npm run build
 *   MOCK_AI=1 pm2 restart advisor --update-env
 */
const fs = require("fs");
const path = require("path");

const target = process.env.TARGET_FILE ||
  path.join(process.env.HOME || "/home/ubuntu", "gaokao", "server", "index.ts");

if (!fs.existsSync(target)) {
  console.error("✗ 找不到文件:", target);
  process.exit(1);
}

let s = fs.readFileSync(target, "utf8");

if (s.includes("MOCK_AI 模式")) {
  console.log("✓ 已存在 MOCK_AI 分支，无需重复注入。直接执行：");
  console.log("  MOCK_AI=1 pm2 restart advisor --update-env");
  process.exit(0);
}

const marker = "    const stream = streamChat({";
const idx = s.indexOf(marker);
if (idx < 0) {
  console.error("✗ 未找到注入点（streamChat 调用），可能文件版本差异，请改走完整重新部署。");
  process.exit(1);
}

const block = `    // ===== MOCK_AI 模式（高并发压测专用，不调用真实大模型）=====
    if (process.env.MOCK_AI === "1") {
      console.log(\`[Chat] MOCK_AI 模式：跳过真实大模型调用\`);
      res.write(\`data: \${JSON.stringify({
        type: "init",
        sessionId: session.id,
        userMessageId,
        assistantMessageId,
        model: "mock-stream",
        webSearch: !!webSearch
      })}\\n\\n\`);

      const mockText =
        \`[MOCK 压测回复] 已收到你的提问：「\${message}」。本回复由 MOCK_AI 模式生成，\` +
        \`用于验证 SSE 流式推送与高并发连接稳定性，不会调用真实大模型，也不产生任何 API 费用。\` +
        \`若在真实使用场景中看到这段文字，说明服务端当前处于压测模式，请关闭 MOCK_AI 后重试。\`;
      const startTs = Date.now();
      for (const ch of mockText) {
        if (clientGone) break;
        res.write(\`data: \${JSON.stringify({ type: "text", content: ch })}\\n\\n\`);
        await new Promise((r) => setTimeout(r, 3));
      }
      if (!clientGone) {
        const duration = Date.now() - startTs;
        db.createMessage({
          id: assistantMessageId,
          session_id: session.id,
          role: "assistant",
          content: mockText,
          model: "mock-stream",
          created_at: new Date().toISOString(),
          tool_calls: null
        });
        res.write(\`data: \${JSON.stringify({ type: "done", duration, cost: 0 })}\\n\\n\`);
      }
      res.end();
      return;
    }

`;

s = s.slice(0, idx) + block + s.slice(idx);
fs.writeFileSync(target, s);
console.log("✓ 已在 server/index.ts 注入 MOCK_AI 分支。下一步：");
console.log("  npm run build");
console.log("  MOCK_AI=1 pm2 restart advisor --update-env");
