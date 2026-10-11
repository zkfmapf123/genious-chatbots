import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { calcCost } from "./pricing.js";
import { ChatLog } from "./chatLog.js";
import { Jev } from "./evaluations/jev.js";
import { loadConditions, runConditions } from "./condition/index.js";
import { MainModel } from "./mainModel.js";
import { Hindsight } from "./pipeline/hindsight.js";
import { KnowledgeBase } from "./pipeline/knowledgeBase.js";
import { loadRagConfig } from "./pipeline/ragConfig.js";
import { SemanticCache } from "./pipeline/semanticCache.js";
import { createEmbedder, createPool, num } from "./pipeline/setup.js";

const INDEX_HTML = readFileSync("public/index.html");
const ADMIN_HTML = readFileSync("public/admin.html");

const PROVIDER = process.env.PROVIDER;
const API_KEY = process.env.PROVIDER_PRIVATE_KEY;
const MODEL = process.env.CHATBOT_MAIN_MODEL;
const PORT = process.env.PORT ?? 3000;

if (PROVIDER !== "openai") {
  throw new Error(`unsupported PROVIDER: ${PROVIDER} (only "openai" for now)`);
}
if (!API_KEY || !MODEL) {
  throw new Error("missing PROVIDER_PRIVATE_KEY or CHATBOT_MAIN_MODEL in .env");
}

const OPEN_ROUTER_KEY = process.env.OPEN_ROUTER_KEY;
const jev = OPEN_ROUTER_KEY ? new Jev(OPEN_ROUTER_KEY, process.env.JUDGE_MODEL || undefined) : undefined; // 키가 없으면 Jev 단계는 건너뛴다
const conditions = await loadConditions(); // src/condition/<번호>_*.ts
const hindsight = new Hindsight();
const embedder = createEmbedder();
const pool = createPool();
const mainModel = new MainModel(API_KEY, MODEL);
const kb = new KnowledgeBase(embedder, pool, num("KB_TOP_K", 5), process.env.KB_MAX_DISTANCE ? Number(process.env.KB_MAX_DISTANCE) : undefined);
const cache = new SemanticCache(pool, num("CACHE_MAX_DISTANCE", 0.05), num("CACHE_TTL_HOURS", 24));
const chatLog = new ChatLog(pool);

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(INDEX_HTML);
    return;
  }

  // 관리자 화면: 로그인 없음 (모든 질문·답변이 누구에게나 보인다)
  if (req.url === "/admin" || req.url?.startsWith("/admin/") || req.url?.startsWith("/admin?")) {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/admin") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(ADMIN_HTML);
      } else if (req.method === "GET" && url.pathname === "/admin/api/chats") {
        const [stats, chats] = await Promise.all([chatLog.stats(), chatLog.list(Number(url.searchParams.get("limit")))]);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ stats, chats }));
      } else if (req.method === "POST" && url.pathname === "/admin/api/reset") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await chatLog.resetAll()));
      } else if (req.method === "DELETE" && /^\/admin\/api\/chats\/\d+$/.test(url.pathname)) {
        const ok = await chatLog.remove(Number(url.pathname.split("/").pop()));
        res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify({ deleted: ok }));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }

  const t0 = performance.now();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);

  let message: unknown;
  try {
    ({ message } = JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "invalid JSON body" }),
    );
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "body must be { message: string }" }),
    );
    return;
  }

  // NDJSON: one JSON event per line, flushed as each pipeline stage happens.
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const trace: object[] = []; // 완료된 단계만 모아 chat_log에 저장 (step-start는 진행 표시용이라 제외)
  const emit = (evt: { type: string; [k: string]: unknown }) => {
    if (evt.type === "config" || evt.type === "step") trace.push(evt);
    res.write(JSON.stringify(evt) + "\n");
  };

  // 직전 단계가 끝난 시점부터 지금까지의 ms를 돌려준다
  let last = t0;
  const lap = () => {
    const now = performance.now();
    const ms = Math.round(now - last);
    last = now;
    return ms;
  };
  const fmt = (d?: number) => (d === undefined ? "-" : d.toFixed(3));
  const clip = (s = "", n = 36) => (s.length > n ? s.slice(0, n) + "…" : s);

  try {
    // 지금 서버가 실제로 쓰는 설정. 화면에 띄워서 .env를 고친 뒤 반영됐는지 바로 보게 한다 (비밀 값은 넣지 않는다)
    emit({
      type: "config",
      values: {
        jevModel: jev?.model ?? null,
        embeddingModel: embedder.model,
        cacheMaxDistance: cache.maxDistance,
        cacheTtlHours: cache.ttlHours,
        kbTopK: kb.topK,
        kbMaxDistance: kb.maxDistance ?? null,
        mainModel: MODEL,
      },
    });
    emit({ type: "step", label: "입력", detail: message, ms: lap() });

    // 1. Jev: 질문 의도 분류 (질문·임계값은 jev.json). 판정 결과는 아래 조건(src/condition)이 쓴다.
    emit({ type: "step-start", label: "Jev" });
    const decision = jev ? await jev.run(message) : undefined;
    emit({
      type: "step",
      label: "Jev",
      outcome: !decision ? "skip" : decision.failed ? "fail" : "ok",
      detail: !decision
        ? "건너뜀 (OPEN_ROUTER_KEY 없음)"
        : decision.failed
          ? `실패 -> 기본 라우트: ${decision.routes.join(", ")} (fallback)`
          : `라우트: ${decision.routes.join(", ")}${decision.usedDefault ? " (임계값 넘은 것 없음 -> 기본)" : ""}\n` +
            // 라우트마다 한 줄: ✓/✗ 이름 확률 막대(10칸). 확률 높은 순
            Object.entries(decision.probs)
              .sort((a, b) => b[1] - a[1])
              .map(([r, p]) => {
                const filled = Math.round(p * 10);
                return `${!decision.usedDefault && decision.routes.includes(r) ? "✓" : "✗"} ${r} ${p.toFixed(2)} ${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
              })
              .join("\n") +
            `\n${decision.inputTokens}tok · $${decision.costUsd.toFixed(6)}`,
      ms: lap(),
    });

    // 2. 조건: 채택된 Jev 라우트(이름표)마다 src/condition/<이름표>.ts를 검사한다. 결과는 세 가지:
    //    reply -> 그 답을 바로 내보내고 끝 (임베딩·캐시·LLM 없음, qa_cache에도 저장 안 함)
    //    pipeline: hindsight -> 아래 Hindsight 단계로 (실패하면 기존 RAG로 이어짐)
    //    없음(통과) -> 기존 RAG 파이프라인 (임베딩 -> 캐시 -> 지식 검색 -> LLM)
    emit({ type: "step-start", label: "조건" });
    const cond = decision ? runConditions(conditions, { message, decision }) : undefined;
    const result = cond?.result;
    emit({
      type: "step",
      label: "조건",
      outcome: !decision ? "skip" : result ? "hit" : "miss",
      detail: !decision
        ? "건너뜀 (Jev 없음)"
        : result
          ? `${cond!.route}.ts\n${cond!.name} -> ${"reply" in result ? "안내 응답 (임베딩·캐시·LLM 건너뜀)" : "Hindsight 파이프라인"}`
          : `라우트 ${decision.routes.join(", ")}\n${cond!.checked.length ? `${cond!.checked.map((r) => r + ".ts").join(", ")} 검사: 통과` : "해당 조건 파일 없음"} -> 기존 RAG 파이프라인`,
      ms: lap(),
    });
    if (result && "reply" in result) {
      emit({ type: "done", reply: result.reply, guided: true, cache: "skip", answerMs: Math.round(performance.now() - t0), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
      const guidedId = await chatLog.record({
        question: message, answer: result.reply, cached: false, sources: 0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, totalMs: Math.round(performance.now() - t0), pipeline: trace,
      });
      if (guidedId) emit({ type: "chat-id", id: guidedId });
      return;
    }

    // 2-1. Hindsight 파이프라인 (history): 기억을 찾으면 그것만 context로 답한다. 못 찾거나 실패하면 아래 기존 RAG로 이어진다.
    if (result && "pipeline" in result) {
      emit({ type: "step-start", label: "Hindsight" });
      const h = await hindsight.run(message);
      emit({
        type: "step",
        label: "Hindsight",
        outcome: h.failed ? "fail" : h.memories.length ? "hit" : "miss",
        detail: h.failed ? "실패 -> 기존 RAG 파이프라인으로 (fallback)" : h.memories.length ? `기억 ${h.memories.length}건` : "관련 기억 없음 -> 기존 RAG 파이프라인으로",
        ms: lap(),
      });
      if (h.memories.length) {
        emit({ type: "step-start", label: "main-model", detail: MODEL });
        const ctxMem = h.memories.map((m, i) => `[${i + 1}] (hindsight)\n${m}`);
        const r = await mainModel.run(message, ctxMem);
        const cost = calcCost(MODEL, r.inputTokens, r.outputTokens);
        emit({ type: "step", label: "main-model", detail: `${MODEL}\ncontext 기억 ${ctxMem.length}건`, ms: lap() });
        emit({ type: "done", reply: r.content, cache: "skip", answerMs: Math.round(performance.now() - t0), usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: cost } });
        const hid = await chatLog.record({
          question: message, answer: r.content, cached: false, sources: ctxMem.length,
          inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: cost, totalMs: Math.round(performance.now() - t0), pipeline: trace,
        });
        if (hid) emit({ type: "chat-id", id: hid });
        return;
      }
    }

    // 3. 질문 임베딩: 한 번만 만들어서 캐시 조회, 지식 검색, 캐시 저장에 같이 쓴다. 실패하면 null -> 아래 단계들이 건너뜀
    emit({ type: "step-start", label: "임베딩" });
    const vector = await embedder.run(message, "search_query");
    emit({
      type: "step",
      label: "임베딩",
      outcome: vector ? "ok" : "fail",
      detail: vector ? `${embedder.model}\n${vector.length}차원 · search_query` : "실패 -> 캐시·지식 검색 없이 진행 (fallback)",
      ms: lap(),
    });

    // 4. 캐시 조회: 비슷한 질문의 답이 있으면 LLM을 부르지 않고 그대로 돌려준다
    emit({ type: "step-start", label: "캐시 조회" });
    const cached = await cache.lookup(vector);
    emit({
      type: "step",
      label: "캐시 조회",
      outcome: cached.skipped ? "skip" : cached.failed ? "fail" : cached.hit ? "hit" : "miss",
      detail: cached.skipped
        ? "건너뜀 (임베딩 없음)"
        : cached.failed
          ? "실패 -> miss로 처리 (fallback)"
          : cached.hit
            ? `같은 질문: "${clip(cached.hit.question)}"\n거리 ${fmt(cached.hit.distance)} ≤ 임계값 ${cache.maxDistance}`
            : cached.nearest === undefined
              ? "캐시가 비어 있음"
              : `가장 가까운 질문: "${clip(cached.nearestQuestion)}"\n거리 ${fmt(cached.nearest)} > 임계값 ${cache.maxDistance}`,
      ms: lap(),
    });
    // 답변이 사용자에게 나가기까지 걸린 시간과 캐시 결과(hit/miss/skip/fail)를 done에 실어 박스 라벨로 쓴다
    const cacheOutcome = cached.skipped ? "skip" : cached.failed ? "fail" : cached.hit ? "hit" : "miss";
    if (cached.hit) {
      emit({ type: "done", reply: cached.hit.answer, cached: true, cache: cacheOutcome, answerMs: Math.round(performance.now() - t0), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
      const cachedId = await chatLog.record({
        question: message, answer: cached.hit.answer, cached: true, sources: 0,
        inputTokens: 0, outputTokens: 0, costUsd: 0, totalMs: Math.round(performance.now() - t0), pipeline: trace,
      });
      if (cachedId) emit({ type: "chat-id", id: cachedId });
      return;
    }

    // 5. 지식 검색: 적재해 둔 문서 청크 중 질문과 가까운 것
    emit({ type: "step-start", label: "지식 검색" });
    const found = await kb.search(vector);
    emit({
      type: "step",
      label: "지식 검색",
      outcome: found.skipped ? "skip" : found.failed ? "fail" : found.hits.length ? "hit" : "miss",
      detail: found.skipped
        ? "건너뜀 (임베딩 없음)"
        : found.failed
          ? "실패 -> context 없이 진행 (fallback)"
          : found.nearest === undefined
            ? "저장된 문서 청크가 없음 (npm run ingest 필요)"
            : // 후보 전체를 거리와 함께 보여준다. 거리 제한에 걸려 제외된 건 ✗ (제한을 어디에 둘지 볼 때 쓴다)
              `top-${kb.topK} · 거리 제한 ${kb.maxDistance ?? "없음"} · ${found.hits.length}건 사용\n` +
              found.candidates
                .map((h, i) => (i < found.hits.length ? `✓ [${i + 1}] ${h.source}#${h.chunkIndex} · ${fmt(h.distance)}` : `✗ ${h.source}#${h.chunkIndex} · ${fmt(h.distance)} (제외)`))
                .join("\n"),
      ms: lap(),
    });

    // 5-1. 근거 확인: 문서를 한 건도 못 찾았으면 모델을 부르지 않고 "모른다, 담당자 문의"로 답한다.
    //      모델이 일반 지식으로 지어내는 걸 막는다. 이 답은 캐시에 저장하지 않는다 (나중에 문서를 추가해도 옛 "모른다"가 남지 않게).
    //      검색 자체가 못 돌았으면(임베딩·검색 실패) "찾지 못했다"가 아니라 "지금은 검색할 수 없다"고 답한다.
    if (found.hits.length === 0) {
      const rag = loadRagConfig();
      const unavailable = found.skipped || found.failed;
      const reply = unavailable ? rag.unavailableText : rag.noAnswerText;
      emit({
        type: "step",
        label: "근거 확인",
        outcome: unavailable ? "fail" : "miss",
        detail: unavailable ? "문서를 검색하지 못함 -> 모델 호출 없이 안내" : "관련 문서 0건 -> 모델 호출 없이 \"모른다, 담당자 문의\"로 답함",
        ms: lap(),
      });
      emit({
        type: "done", reply, cache: "skip", answerMs: Math.round(performance.now() - t0),
        ...(unavailable ? { guided: true } : { noContext: true }),
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
      const noCtxId = await chatLog.record({
        question: message, answer: reply, cached: false, sources: 0, noContext: !unavailable,
        inputTokens: 0, outputTokens: 0, costUsd: 0, totalMs: Math.round(performance.now() - t0), pipeline: trace,
      });
      if (noCtxId) emit({ type: "chat-id", id: noCtxId });
      return;
    }

    // 6. 답변 생성: 찾은 청크에 [1], [2] 번호를 붙여 context로 넘긴다
    emit({ type: "step-start", label: "main-model", detail: MODEL });
    const context = found.hits.map((h, i) => `[${i + 1}] (${h.source}#${h.chunkIndex})\n${h.content}`);
    const { content, inputTokens, outputTokens } = await mainModel.run(message, context);
    const costUsd = calcCost(MODEL, inputTokens, outputTokens);
    emit({ type: "step", label: "main-model", detail: `${MODEL}\ncontext 문서 ${context.length}개`, ms: lap() });

    const sources = found.hits.map((h, i) => ({ n: i + 1, source: h.source, chunk: h.chunkIndex, distance: Number(h.distance.toFixed(3)) }));
    emit({ type: "done", reply: content, cache: cacheOutcome, answerMs: Math.round(performance.now() - t0), usage: { inputTokens, outputTokens, costUsd }, sources });

    // 7. 캐시 저장: miss였던 질문의 답만 저장 (답변은 이미 내려보낸 뒤라 사용자는 안 기다림)
    emit({ type: "step-start", label: "캐시 저장" });
    const saved = await cache.save(message, vector, content);
    emit({
      type: "step",
      label: "캐시 저장",
      outcome: saved.skipped ? "skip" : saved.failed ? "fail" : "ok",
      detail: saved.skipped
        ? "건너뜀 (임베딩 없음)"
        : saved.failed
          ? "실패 -> 저장 생략 (fallback)"
          : `저장 (TTL ${cache.ttlHours}h, pg ${saved.queryMs}ms)`,
      ms: lap(),
    });
    const chatId = await chatLog.record({
      question: message, answer: content, cached: false, sources: found.hits.length,
      inputTokens, outputTokens, costUsd, totalMs: Math.round(performance.now() - t0), pipeline: trace,
    });
    if (chatId) emit({ type: "chat-id", id: chatId });
  } catch (err) {
    emit({ type: "error", error: (err as Error).message });
  } finally {
    res.end();
  }
});

server.listen(PORT, () => console.log(`chatbot listening on :${PORT}`));
