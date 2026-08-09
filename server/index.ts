import express from "express";
import { unstable_v2_createSession, unstable_v2_authenticate, PermissionResult } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import * as db from "./db.js";

// 读取项目根目录 knowledge/ 下的知识库文件（.md/.txt），拼进 system 提示
// 以后要加资料，直接把文件丢进 knowledge/ 文件夹，重启服务即可生效
function loadKnowledge(): string {
  const dir = path.resolve(process.cwd(), "knowledge");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir).filter((f) => /\.(md|markdown|txt)$/i.test(f));
  const parts: string[] = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), "utf-8").trim();
    if (content) parts.push(`【知识文件：${f}】\n${content}`);
  }
  return parts.join("\n\n---\n\n");
}

// 调用 IMA 订阅知识库：用用户问题当关键词检索相关资料，拼进提示词
// 需要 .env 配置 IMA_CLIENT_ID / IMA_API_KEY / IMA_KB_ID；缺任意一项则跳过（自动降级用本地知识库）
// 高考常见关键词，用于从学生提问中提取检索词。
// 注意：ima 检索对“整句问句”命中率很低，但对“短关键词”命中很高；
// 且多个词用空格拼接会变成 AND 匹配导致 0 命中，所以这里逐个关键词检索后取并集。
const GAOKAO_KEYWORDS = [
  "志愿填报", "平行志愿", "顺序志愿", "投档", "录取", "位次", "排名", "一分一段",
  "冲稳保", "冲一冲", "稳一稳", "保一保", "专业", "院校", "大学", "学科",
  "调剂", "退档", "滑档", "强基计划", "提前批", "本科批", "专科批", "批次线",
  "省控线", "征集志愿", "选科", "招生计划", "招生章程", "综评", "军校", "公费师范",
  "本科", "专科", "分数线", "分数", "投档线", "提档线", "录取分数", "控制线",
  "985", "211", "双一流", "公办", "民办", "独立学院", "职业本科"
];

// 省级行政区（用于从提问中识别“省份”，逐个检索用）
const PROVINCES = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "内蒙古",
  "广西", "西藏", "宁夏", "新疆", "香港", "澳门"
];

async function searchIma(message: string): Promise<string> {
  const cid = process.env.IMA_CLIENT_ID;
  const key = process.env.IMA_API_KEY;
  // 支持多知识库：IMA_KB_IDS（逗号分隔）优先，兼容旧的单个 IMA_KB_ID
  const kbIds = (process.env.IMA_KB_IDS || process.env.IMA_KB_ID || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!cid || !key || !kbIds.length) return "";
  console.log(`[IMA] 接入知识库数: ${kbIds.length}`);

  // 1) 从学生提问中提取检索词：高考术语 + 年份 + 省份，分别检索后取并集
  const msg = (message || "").trim();
  const hitTerms = [...new Set(GAOKAO_KEYWORDS.filter((k) => msg.includes(k)))];
  const year = msg.match(/20\d{2}/)?.[0];
  const prov = PROVINCES.find((p) => msg.includes(p));
  let queries = [...new Set([...hitTerms, year, prov].filter(Boolean) as string[])].slice(0, 6);
  // 兜底：实在没提取到任何词，用清理后的原句尝试一次检索
  if (!queries.length) {
    queries = [msg.replace(/[?？。，,！!、。\s]/g, "").slice(0, 20)];
  }
  console.log(`[IMA] 提取检索词：${queries.join(" | ")}`);

  const url = "https://ima.qq.com/openapi/wiki/v1/search_knowledge";
  const fetchOne = async (q: string, kb: string): Promise<any[]> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ima-openapi-clientid": cid,
          "ima-openapi-apikey": key,
        },
        body: JSON.stringify({ query: q, knowledge_base_id: kb, cursor: "" }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        console.warn(`[IMA] search 返回 ${resp.status} (q=${q})`);
        return [];
      }
      const json: any = await resp.json();
      if (json?.code !== 0) {
        console.warn(`[IMA] search 错误 code=${json?.code} msg=${json?.msg}`);
        return [];
      }
      return json?.data?.info_list || [];
    } catch (e: any) {
      console.warn(`[IMA] 检索失败(q=${q})：${e?.message || e}`);
      return [];
    }
  };

  // 2) 对每个检索词 × 每个知识库并行检索；命中内容含年份/省份的优先拼入
  const tasks = queries.flatMap((q) => kbIds.map((kb) => fetchOne(q, kb)));
  const allResults = await Promise.all(tasks);
  const yearP = year || "";
  const provP = prov || "";
  const isPriority = (it: any) => {
    const s = `${it.title || ""} ${it.highlight_content || it.content || ""}`;
    return (yearP && s.includes(yearP)) || (provP && s.includes(provP));
  };
  const seen = new Set<string>();
  const prioItems: any[] = [];
  const normalItems: any[] = [];
  for (const list of allResults) {
    for (const it of (list || []).slice(0, 8)) {
      const t = it.title || "";
      if (seen.has(t)) continue;
      seen.add(t);
      (isPriority(it) ? prioItems : normalItems).push(it);
    }
  }
  const merged = [...prioItems, ...normalItems];

  if (!merged.length) {
    console.log(`[IMA] 检索命中 0 条（queries=${queries.join(" | ")}）`);
    return "";
  }
  console.log(`[IMA] 检索命中 ${merged.length} 条（优先 ${prioItems.length} 条），已拼入提示词`);
  const parts = merged.slice(0, 18).map((it, i) => {
    const c = (it.highlight_content || it.content || "").slice(0, 600);
    return `【${i + 1}】${it.title || "无标题"}\n${c}`;
  });
  return parts.join("\n\n");
}

// ============= 多模型路由（千问联网搜索 / DeepSeek 回退） =============

// 统一的 OpenAI 兼容流式生成（Qwen / DeepSeek 共用同一套 SSE 解析）
async function* streamChat(opts: {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  extraBody?: Record<string, any>;
}): AsyncGenerator<{ type: string; message?: any; error?: string }> {
  if (!opts.apiKey) {
    yield { type: "assistant", message: { content: `⚠️ 未配置 ${opts.label} API Key。请在项目根目录 .env 写入对应 Key（联网搜索需 QWEN_API_KEY；纯本地问答可用 CODEBUDDY_API_KEY），或在网页「设置」中填写后重启服务。` } };
    return;
  }
  const url = opts.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  console.log(`[Chat] 调用 ${opts.label}: ${url}, model=${opts.model}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2000,
        ...(opts.extraBody || {}),
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => "");
      yield { type: "error", error: `${opts.label} 返回错误 ${resp.status}: ${errText.slice(0, 200)}` };
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const p = t.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const j = JSON.parse(p);
          // content：标准模型的正文；reasoning_content：深度思考（推理）模型的思考过程
          const c = j.choices?.[0]?.delta?.content;
          const r = j.choices?.[0]?.delta?.reasoning_content;
          const text = (c || "") + (r || "");
          if (text) yield { type: "assistant", message: { content: text } };
        } catch { /* 忽略无法解析的分片 */ }
      }
    }
    yield { type: "result" };
  } catch (e: any) {
    clearTimeout(timer);
    yield { type: "error", error: `${opts.label} 调用异常：${e?.message || e}` };
  }
}

// 加载项目根目录的 .env（本地开发用，避免引入 dotenv 依赖）
// 注意：ESM 下 __dirname 在文件后半段才初始化，这里用 process.cwd()（npm 启动目录即项目根）
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
    console.log("[Env] 已加载 .env：", envPath);
  }
} catch (e) {
  console.warn("[Env] 加载 .env 失败：", (e as Error)?.message);
}

const execAsync = promisify(exec);

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "qwen-plus";

// 模型列表：对外统一叫"报考咨询助手"，内部用 modelId 区分联网/本地模式
const QWEN_MODELS = [
  { modelId: "qwen-plus", name: "联网搜索模式（推荐）" },
  { modelId: "qwen-max", name: "联网搜索模式（增强）" },
  { modelId: "qwen-turbo", name: "联网搜索模式（极速）" },
];
const DEEPSEEK_MODELS = [
  { modelId: "deepseek-v4-pro", name: "本地知识库模式（标准）" },
  { modelId: "deepseek-v4-flash", name: "本地知识库模式（极速）" },
];
const ALL_MODELS = [...QWEN_MODELS, ...DEEPSEEK_MODELS];
const QWEN_IDS = ["qwen-plus", "qwen-max", "qwen-turbo", "qwen3-max", "qwen3-plus", "qwen3-turbo", "qwen-long"];

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 前端初始化配置（如：是否已配置千问 Key，用于联网搜索按钮的实时提示）
app.get("/api/config", (req, res) => {
  res.json({
    qwenConfigured: !!process.env.QWEN_API_KEY,
  });
});

// ===== 应用登录鉴权（报考咨询助手账号登录 / 注册）=====
// 登录凭据取自 .env 的 LOGIN_USERNAME / LOGIN_PASSWORD；
// 未配置时使用内置默认账号（admin / admin123），方便本地直接体验。
const LOGIN_USERNAME = process.env.LOGIN_USERNAME || "admin";
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || "admin123";
// 内存态 token 存储（演示用，服务重启即失效；生产环境建议换成 JWT + 持久化存储）
const validTokens = new Set<string>();
const tokenExpiry = new Map<string, number>();
const tokenUser = new Map<string, string>(); // token -> 用户名（用于 /me 回显真实账号）
const AUTH_TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---- 注册用户存储（data/users.json，密码用 scrypt + 随机盐哈希，不在文件里存明文）----
interface StoredUser {
  username: string;
  salt: string;
  passwordHash: string;
  createdAt: string;
}
const usersPath = path.resolve(process.cwd(), "data", "users.json");
function loadUsers(): StoredUser[] {
  try {
    if (fs.existsSync(usersPath)) {
      return JSON.parse(fs.readFileSync(usersPath, "utf-8")) as StoredUser[];
    }
  } catch {
    /* 读取失败则当作空列表 */
  }
  return [];
}
function saveUsers(users: StoredUser[]): void {
  try {
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf-8");
  } catch (e) {
    console.error("[Auth] 写入 users.json 失败：", (e as Error)?.message);
  }
}
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}
function verifyUser(username: string, password: string): boolean {
  const u = loadUsers().find((x) => x.username === username);
  if (!u) return false;
  const hash = hashPassword(password, u.salt);
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(u.passwordHash, "hex"));
}

// 签发 token 的小工具
function issueToken(username: string): string {
  const token = `${uuidv4()}-${Date.now().toString(36)}`;
  validTokens.add(token);
  tokenExpiry.set(token, Date.now() + AUTH_TOKEN_TTL);
  tokenUser.set(token, username);
  return token;
}

// 登录：校验用户名密码（默认管理员 或 已注册用户），成功返回 token
app.post("/api/auth/login", (req, res) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "用户名和密码不能为空" });
  }
  const isAdmin = username === LOGIN_USERNAME && password === LOGIN_PASSWORD;
  const isRegistered = !isAdmin && verifyUser(username, password);
  if (!isAdmin && !isRegistered) {
    return res.status(401).json({ success: false, message: "用户名或密码错误" });
  }
  const token = issueToken(username);
  res.json({ success: true, token, username, expiresIn: AUTH_TOKEN_TTL });
});

// 注册：创建新账号（用户名 3-20 位、密码至少 6 位、不可与已有账号重名），成功后直接登录
app.post("/api/auth/register", (req, res) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "用户名和密码不能为空" });
  }
  const uname = username.trim();
  if (uname.length < 3 || uname.length > 20) {
    return res.status(400).json({ success: false, message: "用户名需为 3-20 个字符" });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: "密码至少 6 位" });
  }
  if (uname === LOGIN_USERNAME) {
    return res.status(400).json({ success: false, message: "该用户名已被占用" });
  }
  const users = loadUsers();
  if (users.some((u) => u.username === uname)) {
    return res.status(400).json({ success: false, message: "该用户名已被注册" });
  }
  const salt = randomBytes(16).toString("hex");
  users.push({
    username: uname,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  });
  saveUsers(users);

  // 注册成功直接签发 token 登录
  const token = issueToken(uname);
  res.json({ success: true, token, username: uname, expiresIn: AUTH_TOKEN_TTL });
});

// 登出：作废当前 token
app.post("/api/auth/logout", (req, res) => {
  const authHeader = (req.headers["authorization"] as string) || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token) {
    validTokens.delete(token);
    tokenExpiry.delete(token);
    tokenUser.delete(token);
  }
  res.json({ success: true });
});

// ---- 登录态解析：从 Authorization: Bearer <token> 中取出当前账号 ----
/** 返回当前请求对应的账号名；未登录 / token 失效返回 null */
function getAuthUser(req: any): string | null {
  const authHeader = (req.headers?.["authorization"] as string) || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || !validTokens.has(token)) return null;
  const exp = tokenExpiry.get(token);
  if (!exp || exp <= Date.now()) {
    validTokens.delete(token);
    tokenExpiry.delete(token);
    tokenUser.delete(token);
    return null;
  }
  return tokenUser.get(token) || LOGIN_USERNAME;
}

/** 需要登录的接口用它兜底：未登录直接 401 */
function requireAuth(req: any, res: any): string | null {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "未登录或登录已过期", code: "UNAUTHORIZED" });
    return null;
  }
  return user;
}

/** 作废某账号的全部 token（注销账号时用） */
function revokeTokensOfUser(username: string): void {
  for (const [token, name] of tokenUser.entries()) {
    if (name === username) {
      validTokens.delete(token);
      tokenExpiry.delete(token);
      tokenUser.delete(token);
    }
  }
}

// 注销账号：删除账号本身 + 其名下全部会话与消息，并作废所有 token
app.delete("/api/auth/account", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    // 先清数据，再清账号
    const removedSessions = db.deleteSessionsByOwner(user, LOGIN_USERNAME);

    let accountRemoved = false;
    if (user !== LOGIN_USERNAME) {
      const users = loadUsers();
      const next = users.filter((u) => u.username !== user);
      accountRemoved = next.length !== users.length;
      if (accountRemoved) saveUsers(next);
    }

    revokeTokensOfUser(user);

    console.log(
      `[Auth] 注销账号 ${user}：删除会话 ${removedSessions} 个，账号记录${accountRemoved ? "已删除" : "为内置管理员（仅清空数据）"}`
    );

    res.json({
      success: true,
      username: user,
      removedSessions,
      accountRemoved,
      message:
        user === LOGIN_USERNAME
          ? "内置管理员账号不可删除，已清空该账号下的全部数据并退出登录"
          : "账号及其全部数据已删除",
    });
  } catch (error: any) {
    console.error("[Auth] 注销账号失败：", error);
    res.status(500).json({ success: false, message: error?.message || "注销账号失败" });
  }
});

// 校验当前 token 是否仍有效（前端启动时用于恢复登录态）
app.get("/api/auth/me", (req, res) => {
  const authHeader = (req.headers["authorization"] as string) || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const exp = tokenExpiry.get(token);
  if (token && validTokens.has(token) && exp && exp > Date.now()) {
    return res.json({ success: true, authenticated: true, username: tokenUser.get(token) || LOGIN_USERNAME });
  }
  return res.status(401).json({ success: false, authenticated: false });
});

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string; // 脱敏后的 API Key
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };
  
  // 1. 检查环境变量
  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  
  if (apiKey || authToken) {
    response.envConfigured = true;
    // 脱敏显示
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }
  
  // 2. 使用 unstable_v2_authenticate 检查登录状态（更可靠）
  try {
    let needsLogin = false;
    
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });
    
    // 如果没有触发 onAuthUrl 回调，说明已登录
    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      
      // 判断登录方式
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      // result 存在但没有 userinfo，仍然认为已登录
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    
    // 如果有环境变量配置，仍然认为是登录状态
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }
  
  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;
  
  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }
  
  const configuredVars: string[] = [];
  
  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }
  
  // 清除模型缓存，以便重新获取
  cachedModels = [];
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// 获取可用模型列表
app.get("/api/models", async (req, res) => {
  const baseUrl = process.env.CODEBUDDY_BASE_URL || "";
  const isThirdParty = !!baseUrl && !/codebuddy/i.test(baseUrl);
  try {
    if (cachedModels.length === 0 && !isThirdParty) {
      console.log("[Models] Creating session to fetch available models...");
      
      const session = await unstable_v2_createSession({ 
        cwd: process.cwd()
      });
      
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }
    
    if (cachedModels.length === 0) {
      res.json({ 
        models: isThirdParty ? ALL_MODELS : [
          { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
        ],
        defaultModel 
      });
      return;
    }
    
    res.json({ models: cachedModels, defaultModel });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: isThirdParty ? ALL_MODELS : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= 会话 API =============

// 获取当前账号的会话（包含消息数量）——不同账号之间互相看不到
app.get("/api/sessions", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    const sessions = db.getSessionsByOwner(user, LOGIN_USERNAME);
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
app.get("/api/sessions/:sessionId", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    // 不属于当前账号的会话一律按“不存在”处理，避免泄露他人数据是否存在
    if (!session || !db.isSessionOwnedBy(session, user, LOGIN_USERNAME)) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls JSON
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
app.post("/api/sessions", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();
    
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now,
      owner: user
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;

    if (!db.isSessionOwnedBy(db.getSession(sessionId), user, LOGIN_USERNAME)) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const success = db.updateSession(sessionId, { title, model });
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
app.delete("/api/sessions/:sessionId", (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;
  try {
    const { sessionId } = req.params;

    if (!db.isSessionOwnedBy(db.getSession(sessionId), user, LOGIN_USERNAME)) {
      return res.status(404).json({ error: "会话不存在" });
    }

    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;
  
  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);
  
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }
  
  // 清除请求
  pendingPermissions.delete(requestId);
  
  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }
  
  res.json({ success: true });
});

// 发送消息并获取流式响应
app.post("/api/chat", async (req, res) => {
  const authUser = requireAuth(req, res);
  if (!authUser) return;

  const { sessionId, message, model, systemPrompt, cwd, permissionMode, webSearch } = req.body;
  
  // 请求日志
  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);
  console.log(`[Chat] CWD: ${cwd || 'default'}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();

  // 命中了别人的会话：不允许越权读写
  if (session && !db.isSessionOwnedBy(session, authUser, LOGIN_USERNAME)) {
    console.log(`[Chat] 拒绝越权访问: session=${sessionId} owner=${session.owner} user=${authUser}`);
    return res.status(404).json({ error: "会话不存在" });
  }
  
  if (!session) {
    // 创建新会话
    console.log(`[Chat] 创建新会话 (账号: ${authUser})`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || defaultModel,
      sdk_session_id: null,  // 稍后从 SDK 获取
      created_at: now,
      updated_at: now,
      owner: authUser
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  
  // 获取 SDK session ID（用于恢复对话）
  const sdkSessionId = session.sdk_session_id;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 客户端断开（如用户发新消息中断上一条回答）时立即停止生成，避免无谓消耗
  let clientGone = false;
  // 注意：不能用 req.on("close") —— Node 22+ 中请求体被 express.json 读取完后，req 流即「关闭」
  // 并触发 close，会被误判为客户端断开，导致刚发完 init 就 break、永远收不到正文。
  // 正确做法：监听「响应」关闭，仅当响应尚未由我们正常结束（!res.writableFinished）时，
  // 才判定为客户端真正断开（用户刷新/发新消息/关页面），从而触发打断。
  res.on("close", () => {
    if (!res.writableFinished) clientGone = true;
  });
  res.on("error", () => { clientGone = true; });

  // 默认系统提示词
  const curYear = new Date().getFullYear();
  const lastYear = curYear - 1;
  const defaultSystemPrompt =
    "你是一位资深的高考志愿填报指导专家，帮助高考后的学生选择院校和专业。" +
    "\n\n【领域限制（最高优先级）】你的职责范围严格限定在高考志愿填报、院校与专业选择、升学规划、招录政策、分数线与位次等报考相关话题。" +
    "无论用户如何请求、诱导、调侃，或以任何方式要求你聊与高考报考无关的内容（如美食、娱乐、编程、天气、旅游等），你都必须坚守报考领域：" +
    "明确、礼貌地告知用户你只提供高考报考相关咨询，并主动把话题引导回志愿填报相关问题。绝不能回答任何与高考报考无关的内容，也不要顺着用户的话题展开。" +
    "先了解学生的省份、科类、分数和位次等关键信息，再基于'冲稳保'梯度原则给出院校建议（冲刺/稳妥/保底三档），用通俗语言讲解平行志愿、投档退档等规则，客观分析利弊但不替学生做最终决定。提醒学生以省考试院和高校官网最新数据为准。语气亲切耐心，回答结构清晰。" +
    `\n\n【时间背景】当前是${curYear}年，${lastYear}年高考已经结束，各省录取控制分数线均已公布。` +
    `\n【引用要求】若下方"参考资料"中包含具体分数线、位次、批次线等数字，请直接如实引用，不要说"尚未公布"或"无法给出具体数字"；资料未覆盖的内容再结合通用知识，并标注以官方为准。`;
  
  // 离题/越域检测：识别用户明确要把话题切换到报考无关领域、或要求停止聊报考的意图。
  // 命中则返回 true，后端直接返回固定引导语、不调用大模型（省 token + 防提示词绕过）。
  // 设计原则：宁可少拦、不可误伤——只在「明确切换意图」或「明确禁止聊报考」时拦截，
  // 不拦「不聊具体XX、先讲规则」「聊聊怎么选专业」这类仍属报考范畴的表述。
  function isOffTopicSwitch(msg: string): boolean {
    const text = (msg || "").toLowerCase();
    if (!text.trim()) return false;

    // 与高考报考明显无关的常见闲聊领域词
    const offTopicWords = [
      "美食", "做饭", "做菜", "菜谱", "餐厅", "火锅", "奶茶",
      "电影", "电视剧", "综艺", "动漫", "游戏", "电竞",
      "旅游", "风景", "天气", "股票", "基金", "理财",
      "编程", "代码", "写代码", "bug", "python", "java",
      "小说", "音乐", "歌词", "体育", "足球", "篮球", "八卦", "娱乐",
      "护肤", "穿搭", "宠物", "明星", "追剧"
    ];

    // 情况A：明确要求「不要/别/停聊报考相关」（否定词须紧邻报考类词，避免跨过中性内容误伤）
    if (/(不|别|不要|别再|停止|拒绝|不准).{0,2}(聊|谈|讨论|说|提|问|讲)?(报考|志愿|填志愿|高考|院校|选校|选专业|升学|招录)/.test(text)) {
      return true;
    }

    // 情况B：明确要求切换到某个明显无关领域（带切换动词）
    const switchIntent = /(只(能|能)?聊|不要聊|不聊|别聊|改聊|来聊|我们(来)?聊|换个话题|换个主题|不要讨论|别讨论|不谈|我们谈|以后(都)?聊|从今(往后|以后))/;
    if (switchIntent.test(text) && offTopicWords.some((w) => text.includes(w))) {
      return true;
    }

    // 情况C：直接点名聊某个无关领域（无切换动词，如「聊聊美食吧」「讲讲电影」）
    if (/(聊|谈|讨论|讲讲|说说|来点|推荐).{0,6}(美食|做饭|电影|电视剧|游戏|旅游|天气|股票|编程|小说|音乐|体育|八卦|娱乐|护肤|穿搭|宠物|明星)/.test(text)) {
      return true;
    }

    return false;
  }

  // 工作目录：优先使用请求中的 cwd，否则使用当前目录
  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Resume: ${sdkSessionId || 'none'}`);
    console.log(`[Chat] - CWD: ${workingDir}`);
    console.log(`[Chat] - PermissionMode: ${permissionMode || 'default'}`);
    
    // 创建 canUseTool 回调
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);
      console.log(`[Permission] Input:`, JSON.stringify(input, null, 2));
      
      // bypassPermissions 模式直接放行
      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }
      
      // 创建权限请求
      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };
      
      // 发送权限请求到前端
      res.write(`data: ${JSON.stringify({ 
        type: "permission_request", 
        ...permissionRequest
      })}\n\n`);
      
      // 创建 Promise 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        
        pendingPermissions.set(requestId, pending);
        
        // 设置超时
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };
    
    // 多模型路由：联网走千问（带联网搜索），无网/未配置千问则回退 DeepSeek

    // 离题拦截：在加载知识库/调用大模型之前先行判断，命中则直接返回固定引导语，省资源且防绕过
    if (isOffTopicSwitch(message)) {
      const tip = "我是高考报考咨询助手，只解答志愿填报、院校专业、升学规划相关问题哦～想聊美食/娱乐可以换个 App 😊。有什么报考问题尽管问！";
      res.write(`data: ${JSON.stringify({ type: "init", sessionId: session.id, userMessageId, assistantMessageId, model: model || "deepseek-chat", webSearch: !!webSearch })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "text", content: tip })}\n\n`);
      try {
        db.createMessage({
          id: assistantMessageId,
          session_id: session.id,
          role: "assistant",
          content: tip,
          model: model || "deepseek-chat",
          created_at: new Date().toISOString(),
          tool_calls: null
        });
      } catch (_) { /* 拒答落库失败不影响返回 */ }
      res.write(`data: ${JSON.stringify({ type: "done", duration: 0, cost: 0 })}\n\n`);
      return res.end();
    }

    const historyMsgs = db.getMessagesBySession(session.id)
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .map((m: any) => ({ role: m.role, content: m.content || "" }));

    const knowledgeText = loadKnowledge();
    const systemBase = systemPrompt || defaultSystemPrompt;
    let systemContent = knowledgeText
      ? `${systemBase}\n\n# 参考资料（请严格依据以下资料回答学生的问题；资料中没有的内容请如实说明，并建议学生查证省教育考试院等官方渠道，不要编造）\n${knowledgeText}`
      : systemBase;

    // 调用 IMA 订阅知识库检索（有凭证才调用，失败自动跳过）
    const imaText = await searchIma(message);
    if (imaText) {
      systemContent += `\n\n# 来自 IMA 订阅知识库的相关资料（优先参考，结合学生情况作答）\n${imaText}`;
    }

    const deepseekMessages = [
      { role: "system", content: systemContent },
      ...historyMsgs,
    ];

    let fullResponse = "";
    let toolCalls: any[] = [];
    let newSdkSessionId: string | null = null;

    // ===== 多模型路由：不暴露模型选择，由「联网搜索」开关决定后端 =====
    // 勾选联网搜索 → 走千问（带 enable_search 实时联网）；未勾选 → 走 DeepSeek（本地+IMA 知识库）。
    // 本地知识库 + IMA 订阅库在任何情况下都照常生效，不受此开关影响。
    const qwenKey = process.env.QWEN_API_KEY;
    const useQwen = webSearch === true && !!qwenKey;

    let genLabel: string, genBaseUrl: string, genApiKey: string, genModel: string;
    let genExtra: Record<string, any> | undefined;
    if (useQwen) {
      genLabel = "Qwen(联网搜索)";
      genBaseUrl = (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode").replace(/\/+$/, "");
      genApiKey = qwenKey as string;
      genModel = process.env.QWEN_MODEL || "qwen-plus";
      genExtra = { enable_search: true, search_options: { search_strategy: "turbo" } };
      console.log(`[Chat] 已勾选联网搜索 → 使用 Qwen 联网搜索（model=${genModel}）`);
    } else {
      genLabel = "DeepSeek";
      genBaseUrl = (process.env.CODEBUDDY_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
      genApiKey = process.env.CODEBUDDY_API_KEY || "";
      // 注意：deepseek-v4-pro 现为「推理模型」，正文在 reasoning_content 而非 content，
      // 直接用会几乎无回复。改用标准对话模型 deepseek-chat（content 正常返回、秒回）。
      // 上方 streamChat 已兼容 reasoning_content 以防万一。
      genModel = "deepseek-chat";
      console.log(`[Chat] 使用 DeepSeek 模式（${webSearch ? "已勾选联网但缺少 QWEN_API_KEY（请到 .env 配置）" : "未勾选联网"}）`);
    }

    // ===== MOCK_AI 模式（高并发压测专用，不调用真实大模型）=====
    // 在 .env / 启动环境设置 MOCK_AI=1 后重启服务即开启。完全不消耗 AI 额度、
    // 不产生任何费用，但仍走真实的「鉴权 → 会话 → 消息落库 → SSE 流式推送」全链路，
    // 能真实反映服务端在大量长连接下的事件循环与内存压力。
    if (process.env.MOCK_AI === "1") {
      console.log(`[Chat] MOCK_AI 模式：跳过真实大模型调用`);
      res.write(`data: ${JSON.stringify({
        type: "init",
        sessionId: session.id,
        userMessageId,
        assistantMessageId,
        model: "mock-stream",
        webSearch: !!webSearch
      })}\n\n`);

      const mockText =
        `[MOCK 压测回复] 已收到你的提问：「${message}」。本回复由 MOCK_AI 模式生成，` +
        `用于验证 SSE 流式推送与高并发连接稳定性，不会调用真实大模型，也不产生任何 API 费用。` +
        `若在真实使用场景中看到这段文字，说明服务端当前处于压测模式，请关闭 MOCK_AI 后重试。`;
      const startTs = Date.now();
      for (const ch of mockText) {
        if (clientGone) break; // 用户中断 / 断连，立即停止，避免无谓占用
        res.write(`data: ${JSON.stringify({ type: "text", content: ch })}\n\n`);
        await new Promise((r) => setTimeout(r, 3)); // 模拟逐字输出（约 3ms/字）
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
        res.write(`data: ${JSON.stringify({ type: "done", duration, cost: 0 })}\n\n`);
      }
      res.end();
      return;
    }

    const stream = streamChat({
      label: genLabel,
      baseUrl: genBaseUrl,
      apiKey: genApiKey,
      model: genModel,
      messages: deepseekMessages,
      extraBody: genExtra,
    });

    // 发送会话ID和消息ID
    res.write(`data: ${JSON.stringify({ 
      type: "init", 
      sessionId: session.id, 
      userMessageId, 
      assistantMessageId,
      model: genModel,
      webSearch: useQwen
    })}\n\n`);

    // 当前正在执行的工具 ID（用于匹配 tool_result）
    let currentToolId: string | null = null;

    // 处理流式响应
    for await (const msg of stream) {
      // 客户端已断开（被用户打断）：立刻停止读取与生成
      if (clientGone) break;
      console.log("[Stream] Message type:", msg.type, msg);
      
      // 处理 system 消息，获取 SDK 的 session_id
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);
        
        // 保存 SDK session_id 到数据库（如果是新的）
        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};
              console.log(`[Stream] Tool use: id=${currentToolId}, name=${block.name}`);
              console.log(`[Stream] Tool input:`, JSON.stringify(toolInput, null, 2));
              
              const toolCall = { 
                id: currentToolId, 
                name: block.name, 
                input: toolInput,
                status: "running" 
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({ 
                type: "tool", 
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if (msg.type === "tool_result") {
        // 处理工具结果（独立的消息类型）
        const msgAny = msg as any;
        const toolId = msgAny.tool_use_id || currentToolId;
        const isError = msgAny.is_error || false;
        const content = msgAny.content;
        
        console.log(`[Stream] Tool result: tool_use_id=${toolId}, is_error=${isError}`);
        console.log(`[Stream] Tool result content type:`, typeof content);
        console.log(`[Stream] Tool result content:`, typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content, null, 2)?.slice(0, 500));
        
        const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = isError ? "error" : "completed";
          tool.isError = isError;
          tool.result = typeof content === 'string' 
            ? content 
            : JSON.stringify(content);
          res.write(`data: ${JSON.stringify({ 
            type: "tool_result", 
            toolId: tool.id, 
            content: tool.result,
            isError: isError
          })}\n\n`);
        }
        currentToolId = null;
      } else if (msg.type === "error") {
        console.error(`[Stream] 生成错误：${msg.error}`);
        res.write(`data: ${JSON.stringify({ type: "error", message: msg.error })}\n\n`);
      } else if (msg.type === "result") {
        // 完成时确保所有工具都标记为完成
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: msg.duration, cost: msg.cost })}\n\n`);
      }
    }

    // 客户端已断开（被打断）：不保存半截回答、不收尾，直接结束
    if (clientGone) {
      console.log(`[Chat] 客户端已断开，丢弃本次半截回答`);
      return;
    }

    // 保存助手消息到数据库
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题（如果是第一条消息）
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, { 
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    try { res.end(); } catch { /* 客户端可能已断开 */ }
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Code:`, error?.code);
    console.error(`[Chat] Error Stack:`, error?.stack);
    console.error(`[Chat] Full Error:`, JSON.stringify(error, null, 2));
    
    const errorMessage = error?.message || "处理请求时发生错误";
    try {
      res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
      res.end();
    } catch { /* 客户端可能已断开 */ }
  }
});

// ===== 生产环境：若已构建前端（dist/），由本服务直接托管网页，避免跨域 =====
// 开发模式下没有 dist/，此段不生效（前端由 vite 单独提供并代理 /api）。
const distDir = path.resolve(process.cwd(), "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA 路由兜底：非 /api 的请求都返回 index.html，支持前端刷新/直接访问子路由
  app.get(/^\/(?!api(\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动                      ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: JSON 文件存储 (data/chat-store.json) ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});
