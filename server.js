import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketData, readJson, writeJson } from "./scripts/data-loader.js";
import { runTraining } from "./scripts/train.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MODEL_CONFIG = path.join(__dirname, "config", "model.json");
const TRAINING_REPORT = path.join(__dirname, "artifacts", "training-report.json");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    res.end(data);
    return;
  }
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(PUBLIC_DIR, "." + requested);
  if (!resolved.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  try {
    const data = await fs.readFile(resolved);
    send(res, 200, data, mime[path.extname(resolved)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

function buildContext(data, training) {
  const symbols = data?.summary?.symbols?.map((s) => `${s.symbol}:${s.rows} rows ${s.first?.slice(0, 10)}~${s.last?.slice(0, 10)}`).join("; ") || "no data";
  const metrics = training?.metrics?.test ? `测试集准确率 ${training.metrics.test.accuracy}, 信号交易 ${training.backtest.trades}, 简化回测收益 ${training.backtest.totalReturn}, 最大回撤 ${training.backtest.maxDrawdown}` : "尚未训练";
  return `当前本地量化系统状态：数据=${symbols}。训练=${metrics}。注意：系统为研究原型，不允许输出直接实盘下单指令。`;
}

async function callModel(messages) {
  const config = await readJson(MODEL_CONFIG);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Model endpoint returned non-JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    throw new Error(json?.error?.message || `Model endpoint HTTP ${response.status}`);
  }
  return json;
}

async function route(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/health") {
      return send(res, 200, { ok: true, port: PORT, time: new Date().toISOString() });
    }
    if (url.pathname === "/api/model" && req.method === "GET") {
      const config = await readJson(MODEL_CONFIG);
      return send(res, 200, { ...config, apiKeyMasked: config.apiKey ? "********" : "" });
    }
    if (url.pathname === "/api/model" && req.method === "POST") {
      const incoming = await bodyJson(req);
      const current = await readJson(MODEL_CONFIG);
      const next = {
        ...current,
        provider: incoming.provider || current.provider,
        baseUrl: incoming.baseUrl || current.baseUrl,
        apiKey: incoming.apiKey === "********" || incoming.apiKey === "" ? current.apiKey : incoming.apiKey,
        model: incoming.model || current.model,
        temperature: Number(incoming.temperature ?? current.temperature),
        maxTokens: Number(incoming.maxTokens ?? current.maxTokens),
        systemPrompt: incoming.systemPrompt || current.systemPrompt
      };
      await writeJson(MODEL_CONFIG, next);
      return send(res, 200, { ok: true, config: { ...next, apiKeyMasked: next.apiKey ? "********" : "" } });
    }
    if (url.pathname === "/api/data/summary") {
      const data = await loadMarketData({ refresh: url.searchParams.get("refresh") === "1" });
      return send(res, 200, { mode: data.mode, generatedAt: data.generatedAt, source: data.source, summary: data.summary, failures: data.failures.slice(0, 12) });
    }
    if (url.pathname === "/api/data/candles") {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const data = await loadMarketData();
      const rows = data.rows.filter((r) => r.symbol === symbol).slice(-240);
      return send(res, 200, { symbol, rows });
    }
    if (url.pathname === "/api/train" && req.method === "POST") {
      const payload = await bodyJson(req);
      const report = await runTraining({
        refresh: payload.refresh === true,
        epochs: Number(payload.epochs || 80),
        lr: Number(payload.learningRate || 0.035),
        l2: Number(payload.l2 || 0.001)
      });
      return send(res, 200, report);
    }
    if (url.pathname === "/api/train/report") {
      const report = await readJson(TRAINING_REPORT, null);
      return send(res, 200, report || { status: "missing", message: "尚未运行训练" });
    }
    if (url.pathname === "/api/risk/check" && req.method === "POST") {
      const p = await bodyJson(req);
      const issues = [];
      const qty = Number(p.quantity || 0);
      const leverage = Number(p.leverage || 0);
      const stopLoss = Number(p.stopLossPct || 0);
      if (!p.symbol) issues.push("缺少合约/品种");
      if (qty <= 0) issues.push("数量必须大于 0");
      if (leverage > 5) issues.push("杠杆超过研究原型建议阈值 5x");
      if (stopLoss <= 0 || stopLoss > 0.08) issues.push("止损比例缺失或超过 8%");
      if (p.intent === "live") issues.push("当前系统禁止直接实盘下单，只能生成待审批研究建议");
      return send(res, 200, { passed: issues.length === 0, issues, checkedAt: new Date().toISOString() });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const p = await bodyJson(req);
      const data = await loadMarketData();
      const training = await readJson(TRAINING_REPORT, null);
      const config = await readJson(MODEL_CONFIG);
      const context = buildContext(data, training);
      const messages = [
        { role: "system", content: config.systemPrompt },
        { role: "system", content: context },
        ...(p.messages || [])
      ];
      const out = await callModel(messages);
      return send(res, 200, out);
    }
    return serveStatic(req, res);
  } catch (error) {
    return send(res, 500, { error: error.message, stack: process.env.NODE_ENV === "development" ? error.stack : undefined });
  }
}

http.createServer(route).listen(PORT, () => {
  console.log(`Futures Quant Agent running at http://localhost:${PORT}`);
});
