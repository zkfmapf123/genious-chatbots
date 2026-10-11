// 파이프라인 중간 조건 모음. Jev 판정 직후(임베딩 전)에 검사한다.
// 파일 이름이 곧 Jev 이름표(라우트)다: docs.ts, recall.ts, reflect.ts, live.ts ... (jev.json의 questions 키와 같게)
// 채택된 라우트(decision.routes)마다 같은 이름의 파일을 찾아 check()를 부른다. 파일이 없으면 그냥 통과한다.
// check()가 { reply }를 돌려주면 그 reply를 바로 답으로 내보내고 이후 단계(임베딩·캐시·지식 검색·LLM)와 qa_cache 저장은 하지 않는다.
// { pipeline: "hindsight" }를 돌려주면 Hindsight 파이프라인으로 보낸다 (실패하면 기존 RAG 파이프라인으로 이어진다).
// undefined를 돌려주면 통과(fallthrough): 다음 라우트 → 없으면 평소 흐름(임베딩 → 캐시 → 지식 검색 → LLM).
// 채택된 라우트가 없으면 기본 라우트(default)가 들어오고, default.ts가 없으니 그대로 평소 흐름이다.
// 새 조건: <이름표>.ts를 만들고 아래 Condition 모양을 default export 한다. 서버를 다시 시작하면 반영된다.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JevResult } from "../evaluations/jev.js";

export type ConditionContext = {
  message: string;
  config: Record<string, unknown>; // jev.json의 이 이름표 condition 객체 (없으면 {}). 안내문·예시 같은 값은 코드가 아니라 거기서 고친다
  decision: JevResult; // Jev 판정 (실패했으면 decision.failed)
};

export type ConditionResult = { reply: string } | { pipeline: "hindsight" };

export type Condition = {
  name: string;
  description: string;
  /** 맞으면 결과, 통과면 undefined. throw 하면 통과로 보고 로그만 남긴다. */
  check(ctx: ConditionContext): ConditionResult | undefined;
};

export type Conditions = Map<string, Condition>; // 이름표 -> 조건

/** 이 폴더의 `<이름표>.ts|js`를 모두 읽는다 (개발은 .ts, 빌드 후에는 .js). */
export async function loadConditions(): Promise<Conditions> {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !/^index\./.test(f));
  const map: Conditions = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    map.set(file.replace(/\.(ts|js)$/, ""), mod.default as Condition);
  }
  return map;
}

/** 채택된 라우트 순서대로 같은 이름의 조건을 검사한다. checked는 검사한 라우트 이름들 (카드 표시용). */
export function runConditions(conditions: Conditions, ctx: Omit<ConditionContext, "config">) {
  const checked: string[] = [];
  for (const route of ctx.decision.routes) {
    const condition = conditions.get(route);
    if (!condition) continue;
    checked.push(route);
    try {
      const hit = condition.check({ ...ctx, config: ctx.decision.conditionConfig[route] ?? {} });
      if (hit) return { route, name: condition.name, result: hit, checked };
    } catch (err) {
      console.error(`[condition] ${route} 실패, 통과:`, (err as Error).message);
    }
  }
  return { route: undefined, name: undefined, result: undefined, checked };
}
