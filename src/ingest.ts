// 지식 문서 적재 CLI: npm run ingest -- [파일 또는 폴더 ...]   (기본: __kb__/)
// 마크다운(.md)을 청크로 나눠 임베딩하고 pg에 저장한다. 다시 실행하면 바뀐 부분만 다시 임베딩한다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkMarkdown } from "./pipeline/chunker.js";
import { KnowledgeBase } from "./pipeline/knowledgeBase.js";
import { createEmbedder, createPool, num } from "./pipeline/setup.js";

const targets = process.argv.slice(2);
if (targets.length === 0) targets.push("__kb__");

/** 파일이면 그대로, 폴더면 안의 .md를 전부 (하위 폴더 포함) */
function listMarkdown(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(target, f))
    .sort();
}

const pool = createPool();
const kb = new KnowledgeBase(createEmbedder(), pool, num("KB_TOP_K", 5));

let failed = 0;
const total = { added: 0, updated: 0, unchanged: 0, deleted: 0 };
try {
  for (const file of targets.flatMap(listMarkdown)) {
    const source = relative(process.cwd(), file);
    const chunks = chunkMarkdown(readFileSync(file, "utf8"));
    try {
      const r = await kb.ingest(source, chunks);
      console.log(`${source}: 청크 ${chunks.length}개 (추가 ${r.added} · 갱신 ${r.updated} · 그대로 ${r.unchanged} · 삭제 ${r.deleted})`);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
    } catch (err) {
      failed++;
      console.error(`${source}: 실패 - ${(err as Error).message}`);
    }
  }
} finally {
  await pool.end();
}
console.log(`합계: 추가 ${total.added} · 갱신 ${total.updated} · 그대로 ${total.unchanged} · 삭제 ${total.deleted}${failed ? ` · 실패한 문서 ${failed}` : ""}`);
process.exitCode = failed ? 1 : 0;
