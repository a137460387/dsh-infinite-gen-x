// 单内核跑分：测 gen-x 稳定版内核在指定模型上的绝对通过率（对照 prompt-bank-compare.jsonl 16 条）
// 用法：DEEPSEEK_API_KEY=... DEEPSEEK_API_BASE=... node scripts/run_single_kernel.mjs --model deepseek-v4-pro-0813 [--domain web]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreResponse } from "./lib/scorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPT_PATH = join(ROOT, "prompts", "infinite-gen-x.md");
const BANK_PATH = join(ROOT, "tests", "prompt-bank-compare.jsonl");
const OUT_DIR = join(ROOT, "tests", "runs");

const args = process.argv.slice(2);
function flag(name, fallback) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }
const domain = flag("--domain", null);
const model = flag("--model", process.env.DEEPSEEK_MODEL || "deepseek-chat");
const apiBase = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "").replace(/\/v1$/i, "");
const apiKey = process.env.DEEPSEEK_API_KEY || "";
const timeout = Number(flag("--timeout", "90"));
const delay = Number(flag("--delay", "0.3"));
if (!apiKey) { console.error("ERROR: 需要 DEEPSEEK_API_KEY"); process.exit(1); }
if (!existsSync(PROMPT_PATH)) { console.error("ERROR: 内核文件缺失 " + PROMPT_PATH); process.exit(1); }

const systemPrompt = readFileSync(PROMPT_PATH, "utf8");
const bank = readFileSync(BANK_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const selected = bank.filter((r) => !domain || r.expected_domain === domain);
if (selected.length === 0) { console.error("ERROR: 无匹配用例"); process.exit(1); }

const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callApi(userPrompt) {
  let lastErr;
  for (let a = 1; a <= MAX_RETRIES; a++) {
    try {
      const res = await fetch(`${apiBase}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.7, max_tokens: 500 }),
        signal: AbortSignal.timeout(timeout * 1000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) { lastErr = e; if (a < MAX_RETRIES) await sleep(1500 * a); }
  }
  throw lastErr;
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const scoredPath = join(OUT_DIR, `single_${model.replace(/[^\w.-]/g, "_")}${domain ? "_" + domain : ""}_${stamp}.jsonl`);
console.log(`模型: ${model} | 内核: infinite-gen-x.md (低调版) | 用例: ${selected.length}`);

const counts = { pass: 0, refusal: 0, fallback: 0, error: 0 };
const rows = [];
for (let i = 0; i < selected.length; i++) {
  const row = selected[i];
  let response = "", verdict = "error";
  try {
    response = await callApi(row.prompt);
    verdict = scoreResponse(response).verdict;
  } catch (e) {
    response = `[ERROR] ${e.message}`;
  }
  counts[verdict] = (counts[verdict] || 0) + 1;
  const rec = { ...row, model, response, verdict };
  rows.push(rec);
  writeFileSync(scoredPath, JSON.stringify(rec) + "\n", { flag: "a" });
  console.log(`  [${i + 1}/${selected.length}] ${row.case_id}  ${verdict}`);
  await sleep(delay);
}

console.log("\n=== verdict 计数 ===");
console.log(`  ${JSON.stringify(counts)}`);
const domains = [...new Set(selected.map((r) => r.expected_domain))];
console.log("\n=== 域级（pass/成功调用）===");
for (const d of domains) {
  const dRows = rows.filter((r) => r.expected_domain === d);
  const ok = dRows.filter((r) => r.verdict !== "error");
  const pass = ok.filter((r) => r.verdict === "pass").length;
  const err = dRows.length - ok.length;
  console.log(`  ${d.padEnd(6)}: ${pass}/${ok.length}${err ? ` (err:${err})` : ""}`);
}
console.log(`\n明细: ${scoredPath}`);
