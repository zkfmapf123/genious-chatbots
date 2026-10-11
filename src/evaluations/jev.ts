// Jev 1.13 (OpenRouter Decisions API) - 질문 의도 분류. 분류만 하고 답변은 안 만듦.
// 정리 문서: .claude/rules/jev.md   질문·임계값 설정: jev.json (질문마다 다시 읽는다)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Route = string; // jev.json의 questions 키

// 주의: 공식 문서 curl 예시의 /api/v1/api/alpha/decisions 는 404. 실제 경로는 아래 (2026-10 실측)
const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const CONFIG_PATH = "jev.json";

export type JevConfig = {
  threshold: number; // 이 확률 이상인 라우트만 채택 (이름표에 threshold가 있으면 그 이름표만 그 값)
  defaultRoutes: Route[]; // 판정 불가·실패 시 보낼 곳
  questions: Record<
    Route,
    {
      instructions: string;
      yes: string;
      no: string;
      threshold?: number; // 이 이름표만 쓸 임계값
      condition?: Record<string, unknown>; // src/condition/<이름표>.ts가 읽는 설정 (Jev로는 보내지 않는다)
    }
  >;
};

export type JevResult = {
  routes: Route[]; // 채택된 라우트
  probs: Record<Route, number>; // 라우트별 true 확률 (실패하면 비어 있음)
  inputTokens: number;
  costUsd: number; // 응답의 usage.cost 그대로
  conditionConfig: Record<Route, Record<string, unknown>>; // 이름표별 condition 설정 (조건 파일에 넘긴다)
  usedDefault: boolean; // 임계값을 넘은 라우트가 없어서 defaultRoutes를 쓴 경우
  failed: boolean; // true면 fallback으로 나온 결과
};

/** jev.json을 읽고 모양을 검사한다. 틀리면 무엇이 틀렸는지 던진다 (-> run()이 fallback). */
export function loadConfig(path = CONFIG_PATH): JevConfig {
  const c = JSON.parse(readFileSync(path, "utf8"));
  const names = Object.keys(c.questions ?? {});
  if (typeof c.threshold !== "number" || c.threshold < 0 || c.threshold > 1) throw new Error("jev.json: threshold는 0~1 숫자여야 한다");
  if (!Array.isArray(c.defaultRoutes) || c.defaultRoutes.length === 0) throw new Error("jev.json: defaultRoutes는 비어 있지 않은 배열이어야 한다");
  if (names.length === 0) throw new Error("jev.json: questions가 비어 있다");
  for (const n of names) {
    const q = c.questions[n];
    if (![q?.instructions, q?.yes, q?.no].every((s) => typeof s === "string" && s)) throw new Error(`jev.json: questions.${n}에 instructions/yes/no 문자열이 필요하다`);
    if (q.threshold !== undefined && (typeof q.threshold !== "number" || q.threshold < 0 || q.threshold > 1)) throw new Error(`jev.json: questions.${n}.threshold는 0~1 숫자여야 한다`);
    if (q.condition !== undefined && (typeof q.condition !== "object" || q.condition === null || Array.isArray(q.condition))) throw new Error(`jev.json: questions.${n}.condition은 객체여야 한다`);
  }
  return c as JevConfig;
}

export class Jev {
  constructor(
    private apiKey: string,
    readonly model = "typesafe/jev-1.13",
    private configPath = CONFIG_PATH,
  ) {}

  /** 바깥에서 부르는 메서드. execute()를 시도하고, 실패하면 fallback()으로 넘긴다. */
  async run(question: string): Promise<JevResult> {
    try {
      return await this.execute(question);
    } catch (err) {
      console.error("[jev] 실패, fallback 실행:", (err as Error).message);
      return this.fallback();
    }
  }

  /** 본 동작: Decisions API 호출 -> 라우트별 확률 -> 라우트 선택 */
  private async execute(question: string): Promise<JevResult> {
    const cfg = loadConfig(this.configPath);

    // 1. questions를 API 형식(noul 질문)으로 변환
    const questions = Object.fromEntries(
      Object.entries(cfg.questions).map(([route, q]) => [
        route,
        { type: "noul", instructions: q.instructions, criteria: { true: q.yes, false: q.no } },
      ]),
    );

    // 2. 호출
    const res = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, state: question, questions }),
    });
    if (!res.ok) {
      throw new Error(`Jev ${res.status}: ${await res.text()}`); // -> run()이 잡아서 fallback
    }

    // 3. 응답 { answers: { docs: { noul: 0.9 }, ... }, usage } -> { docs: 0.9, ... }
    const data = await res.json();
    const probs = Object.fromEntries(
      Object.entries(data.answers as Record<string, { noul: number }>).map(([route, a]) => [route, a.noul]),
    );

    // 4. 임계값 넘는 라우트 선택
    return {
      routes: selectRoutes(probs, cfg),
      conditionConfig: conditionConfigOf(cfg),
      usedDefault: pickRoutes(probs, cfg).length === 0,
      probs,
      inputTokens: data.usage?.input_tokens ?? 0,
      costUsd: data.usage?.cost ?? 0,
      failed: false,
    };
  }

  /** 실패 시 동작: 분류를 못 해도 챗봇은 멈추면 안 되니 기본 라우트로 보낸다 (jev.json을 못 읽으면 ["docs"]) */
  private fallback(): JevResult {
    let routes: Route[] = ["docs"];
    try {
      routes = loadConfig(this.configPath).defaultRoutes;
    } catch {}
    return { routes, probs: {}, conditionConfig: {}, usedDefault: true, inputTokens: 0, costUsd: 0, failed: true };
  }
}

/** 이름표별 condition 설정만 모은다 (없는 이름표는 빈 객체). */
function conditionConfigOf(cfg: JevConfig) {
  return Object.fromEntries(Object.entries(cfg.questions).map(([r, q]) => [r, q.condition ?? {}]));
}

/** 임계값을 넘은 라우트들. 이름표에 threshold가 있으면 그 값, 없으면 전체 threshold. */
function pickRoutes(probs: Record<Route, number>, cfg: Pick<JevConfig, "threshold" | "questions">): Route[] {
  return Object.keys(probs).filter((r) => probs[r] >= (cfg.questions[r]?.threshold ?? cfg.threshold));
}

/** 라우트별 확률 -> 채택할 라우트. 하나도 임계값을 못 넘으면 기본 라우트. */
export function selectRoutes(probs: Record<Route, number>, cfg: Pick<JevConfig, "threshold" | "defaultRoutes" | "questions">): Route[] {
  const routes = pickRoutes(probs, cfg);
  return routes.length > 0 ? routes : cfg.defaultRoutes;
}

// self-check: npx tsx src/evaluations/jev.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const eq = (a: Route[], b: Route[]) => JSON.stringify(a) === JSON.stringify(b);
  console.assert(eq(selectRoutes({ deny: 0.9 }, cfg), ["deny"]), "single");
  console.assert(eq(selectRoutes({ deny: 0.8, history: 0.7 }, cfg), ["deny", "history"]), "mixed");
  console.assert(eq(selectRoutes({ history: 0.2 }, cfg), cfg.defaultRoutes), "below threshold -> default");
  console.assert(eq(selectRoutes({}, cfg), cfg.defaultRoutes), "empty -> default");
  const per = { ...cfg, threshold: 0.5, questions: { ...cfg.questions, deny: { ...cfg.questions.deny, threshold: 0.3 } } };
  console.assert(eq(selectRoutes({ deny: 0.4, history: 0.4 }, per), ["deny"]), "per-tag threshold: deny 0.3 passes, history uses global 0.5");
  const bad = await new Jev("invalid-key").run("테스트");
  console.assert(bad.failed && eq(bad.routes, cfg.defaultRoutes), "api error -> fallback");
  console.assert((await new Jev("x", "m", "/nonexistent.json").run("t")).failed, "missing config -> fallback");
  console.log("jev self-check done");
}
