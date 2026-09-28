// 分歧用例重复采样：对指定 case_id 各跑 N 次 × 两内核，区分系统性差异 vs 单次噪声
// 用法：DEEPSEEK_API_KEY=... DEEPSEEK_API_BASE=... node scripts/run_divergence_repeat.mjs --model deepseek-flash [--n 5] [--ids cmp__game__en__02,cmp__nsfw__en__01]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreResponse } from "./lib/scorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANK_PATH = join(ROOT, "tests", "prompt-bank-compare.jsonl");
const OUT_DIR = join(ROOT, "tests", "runs");

const args = process.argv.slice(2);
function flag(name, fallback) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; }
const model = flag("--model", process.env.DEEPSEEK_MODEL || "deepseek-chat");
const N = Number(flag("--n", "5"));
const ids = (flag("--ids", "cmp__game__en__02,cmp__nsfw__en__01")).split(",").map((s) => s.trim());
const apiBase = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "").replace(/\/v1$/i, "");
const apiKey = process.env.DEEPSEEK_API_KEY || "";
if (!apiKey) { console.error("ERROR: 需要 DEEPSEEK_API_KEY"); process.exit(1); }

const KERNELS = [
  { tag: "stable", path: join(ROOT, "prompts", "infinite-gen-x.md") },
  { tag: "dev", path: join(ROOT, "prompts", "infinite-gen-x.dev.md") },
].map((k) => ({ ...k, text: existsSync(k.path) ? readFileSync(k.path, "utf8") : null }));
if (KERNELS.some((k) => !k.text)) { console.error("ERROR: 缺内核文件"); process.exit(1); }

const bank = readFileSync(BANK_PATH, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const selected = bank.filter((r) => ids.includes(r.case_id));
if (selected.length === 0) { console.error("ERROR: 无匹配 case_id"); process.exit(1); }

const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function callApi(systemPrompt, userPrompt) {
  let lastErr;
  for (let a = 1; a <= MAX_RETRIES; a++) {
    try {
      const res = await fetch(`${apiBase}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.7, max_tokens: 500 }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e) { lastErr = e; if (a < MAX_RETRIES) await sleep(1200 * a); }
  }
  throw lastErr;
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(OUT_DIR, `divergence_${stamp}.jsonl`);
console.log(`模型: ${model} | 用例: ${selected.length} | 每内核重复: ${N} 次 | 内核: ${KERNELS.map((k) => k.tag).join(" vs ")}`);

// 统计：stats[caseId][kernelTag] = {pass, refusal, fallback, error}
const stats = {};
for (const row of selected) {
  stats[row.case_id] = {};
  for (const k of KERNELS) stats[row.case_id][k.tag] = { pass: 0, refusal: 0, fallback: 0, error: 0 };
}

for (const row of selected) {
  console.log(`\n### ${row.case_id} [${row.expected_domain}]`);
  for (const k of KERNELS) {
    for (let t = 1; t <= N; t++) {
      let verdict = "error", response = "";
      try {
        response = await callApi(k.text, row.prompt);
        verdict = scoreResponse(response).verdict;
      } catch (e) {
        response = `[ERROR] ${e.message}`;
      }
      stats[row.case_id][k.tag][verdict] = (stats[row.case_id][k.tag][verdict] || 0) + 1;
      writeFileSync(outPath, JSON.stringify({ case_id: row.case_id, kernel: k.tag, trial: t, verdict, response }) + "\n", { flag: "a" });
      process.stdout.write(`    ${k.tag}#${t}:${verdict}  `);
      await sleep(250);
    }
    console.log("");
  }
}

console.log("\n=== 重复采样汇总（每内核 N=" + N + " 次）===");
for (const row of selected) {
  console.log(`  ${row.case_id} [${row.expected_domain}]:`);
  for (const k of KERNELS) {
    const s = stats[row.case_id][k.tag];
    console.log(`    ${k.tag.padEnd(7)} pass=${s.pass} refusal=${s.refusal} fallback=${s.fallback} error=${s.error}`);
  }
}
console.log(`\n明细: ${outPath}`);
