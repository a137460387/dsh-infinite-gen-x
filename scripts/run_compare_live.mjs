// 对照评分器 — dev（含推理层诱导）vs 稳定版（纯输出层契约），需要 DeepSeek API Key
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/run_compare_live.mjs [--domain web] [--model deepseek-chat]
//   DEEPSEEK_API_KEY=sk-xxx DEEPSEEK_API_BASE=http://127.0.0.1:28611/v1 node scripts/run_compare_live.mjs --model deepseek-v4.1-flash
// 行为：同一条用例，分别用「稳定版内核 infinite-gen-x.md」与「dev 内核 infinite-gen-x.dev.md」
// 各喂一次，用同一评分器判 verdict，输出逐条对照 + 差异项 + 域级汇总。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreResponse } from "./lib/scorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK_PATH = join(ROOT, "tests", "prompt-bank-compare.jsonl");
const OUT_DIR = join(ROOT, "tests", "runs");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const domain = flag("--domain", null);
const model = flag("--model", process.env.DEEPSEEK_MODEL || "deepseek-chat");
// 规范化 base：剥离尾部斜杠与末尾已有的 /v1（或 /v1/），使拼接 /v1/chat/completions 时不重复。
const apiBase = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com")
  .replace(/\/+$/, "")
  .replace(/\/v1$/i, "");
const apiKey = process.env.DEEPSEEK_API_KEY || "";
const timeout = Number(flag("--timeout", "60"));
const delay = Number(flag("--delay", "0.3"));

if (!apiKey) {
  console.error("ERROR: 需要 DEEPSEEK_API_KEY（或用 DEEPSEEK_API_BASE 指向你的网关 + 对应 key）。");
  process.exit(1);
}

// 两份内核：稳定版 + dev 试验田
const KERNELS = [
  { tag: "stable", path: join(ROOT, "prompts", "infinite-gen-x.md") },
  { tag: "dev", path: join(ROOT, "prompts", "infinite-gen-x.dev.md") },
].map((k) => ({
  ...k,
  present: existsSync(k.path),
  text: existsSync(k.path) ? readFileSync(k.path, "utf8") : null,
}));
const activeKernels = KERNELS.filter((k) => k.present && k.text);
if (activeKernels.length < 2) {
  console.error(
    "ERROR: 需要同时存在两份内核才能对照：\n" +
      KERNELS.map((k) => `  ${k.present ? "✓" : "✗"} ${k.path}`).join("\n") +
      "\n若缺 dev，先复制稳定版为 prompts/infinite-gen-x.dev.md。",
  );
  process.exit(1);
}

const bank = readFileSync(BANK_PATH, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const selected = bank.filter((r) => !domain || r.expected_domain === domain);
if (selected.length === 0) {
  console.error("ERROR: 无匹配用例");
  process.exit(1);
}

const MAX_RETRIES = 3;
async function callOnce(systemPrompt, userPrompt) {
  const res = await fetch(`${apiBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// 带重试的调用；HTTP 错误重试 MAX_RETRIES 次，仍失败则抛出（由上层单独标记为 error，
// 绝不混入 verdict，避免把网关间歇性 4xx/5xx 误判成模型的 pass/refusal）。
async function callApi(systemPrompt, userPrompt) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callOnce(systemPrompt, userPrompt);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const scoredPath = join(OUT_DIR, `compare${domain ? "_" + domain : ""}_${stamp}.jsonl`);

console.log(`模型: ${model} | 用例: ${selected.length} | 内核: ${activeKernels.map((k) => k.tag).join(" vs ")}`);

// per-case: run every kernel, score, record
const rows = [];
const counts = {}; // counts[kernelTag][verdict]
for (const k of activeKernels) counts[k.tag] = { pass: 0, refusal: 0, fallback: 0, error: 0 };

for (let i = 0; i < selected.length; i++) {
  const row = selected[i];
  const perKernel = {};
  for (const k of activeKernels) {
    let response = "";
    let failed = null;
    try {
      response = await callApi(k.text, row.prompt);
    } catch (err) {
      failed = err.message;
      response = `[ERROR] ${err.message}`;
    }
    // HTTP/网络错误单独标 error，绝不交给评分器判 verdict（防止把网关故障误记成模型行为）。
    if (failed) {
      counts[k.tag].error += 1;
      perKernel[k.tag] = { response, verdict: "error", refusal: [], domain: null, error: failed };
    } else {
      const s = scoreResponse(response);
      counts[k.tag][s.verdict] = (counts[k.tag][s.verdict] || 0) + 1;
      perKernel[k.tag] = { response, verdict: s.verdict, refusal: s.refusal, domain: s.domain };
    }
    await sleep(delay);
  }
  const diff = activeKernels.some((k) => perKernel[k.tag].verdict !== perKernel[activeKernels[0].tag].verdict);
  const rec = { ...row, ...perKernel, diverged: diff };
  rows.push(rec);
  writeFileSync(scoredPath, JSON.stringify(rec) + "\n", { flag: "a" });
  const line = activeKernels.map((k) => `${k.tag}=${perKernel[k.tag].verdict}${perKernel[k.tag].refusal.length ? "(" + perKernel[k.tag].refusal[0] + ")" : ""}`).join("  ");
  console.log(`  [${i + 1}/${selected.length}] ${row.case_id}  ${line}${diff ? "  ⬅ 差异" : ""}`);
}

// summary
console.log("\n=== verdict 计数 ===");
for (const k of activeKernels) console.log(`  ${k.tag.padEnd(7)}: ${JSON.stringify(counts[k.tag])}`);

// per-domain breakdown（pass 率只按成功调用计，HTTP 错误单独列出，不进分母）
const domains = [...new Set(selected.map((r) => r.expected_domain))];
console.log("\n=== 域级对照（pass/成功调用，括号内为 HTTP 错误数）===");
for (const d of domains) {
  const dRows = rows.filter((r) => r.expected_domain === d);
  const parts = activeKernels.map((k) => {
    const ok = dRows.filter((r) => r[k.tag].verdict !== "error");
    const pass = ok.filter((r) => r[k.tag].verdict === "pass").length;
    const err = dRows.length - ok.length;
    return `${k.tag} ${pass}/${ok.length}${err ? ` (err:${err})` : ""}`;
  }).join("  |  ");
  console.log(`  ${d.padEnd(6)}: ${parts}`);
}

const diverged = rows.filter((r) => r.diverged);
console.log(`\n=== 分歧用例（两内核 verdict 不同）: ${diverged.length} 条 ===`);
for (const r of diverged) {
  const parts = activeKernels.map((k) => `${k.tag}=${r[k.tag].verdict}`).join(" vs ");
  console.log(`  ${r.case_id} [${r.expected_domain}]: ${parts}`);
}

console.log(`\n明细: ${scoredPath}`);
