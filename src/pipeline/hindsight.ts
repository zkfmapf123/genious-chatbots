// Hindsight 서버(retain/recall/reflect) 클라이언트. 설치: README.md 참고
// REST 직접 호출 (경로는 실행 중인 서버의 /openapi.json에서 확인: POST /v1/default/banks/{bank}/memories/recall 등)

import { readFileSync } from "node:fs";

const BASE_URL = process.env.HINDSIGHT_URL ?? "http://localhost:8888"; // compose에서는 http://hindsight:8888
const CONFIG_PATH = "config/hindsight.json";

export type HindsightConfig = {
  bank: string; // 기억 저장소 이름
  timeoutMs: number; // 응답 경로라서 오래 기다리지 않는다 (넘으면 throw -> Hindsight.run()이 fallback)
  recall: { maxTokens: number };
  bankConfig: Record<string, unknown>; // bank 생성·수정 요청 본문 (retain_mission, reflect_mission ...)
};

/** hindsight.json을 읽고 모양을 검사한다. 틀리면 무엇이 틀렸는지 던진다 (-> run()이 fallback). */
export function loadConfig(path = CONFIG_PATH): HindsightConfig {
  const c = JSON.parse(readFileSync(path, "utf8"));
  if (typeof c.bank !== "string" || !c.bank) throw new Error("hindsight.json: bank는 비어 있지 않은 문자열이어야 한다");
  if (typeof c.timeoutMs !== "number" || c.timeoutMs <= 0) throw new Error("hindsight.json: timeoutMs는 양수여야 한다");
  if (typeof c.recall?.maxTokens !== "number" || c.recall.maxTokens <= 0) throw new Error("hindsight.json: recall.maxTokens는 양수여야 한다");
  if (c.bankConfig !== undefined && (typeof c.bankConfig !== "object" || c.bankConfig === null || Array.isArray(c.bankConfig))) throw new Error("hindsight.json: bankConfig는 객체여야 한다");
  return { bank: c.bank, timeoutMs: c.timeoutMs, recall: c.recall, bankConfig: c.bankConfig ?? {} };
}

function call(cfg: HindsightConfig, path: string, method: string, body: object) {
  return fetch(`${BASE_URL}/v1/default/banks/${encodeURIComponent(cfg.bank)}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
}

// bank별로 마지막에 반영한 bankConfig. 없거나 달라졌으면 PUT(만들거나 수정)으로 다시 반영한다.
// (Hindsight는 없는 bank에 recall하면 404라서 첫 호출 전에 반드시 만들어야 한다)
const applied = new Map<string, string>();
async function ensureBank(cfg: HindsightConfig) {
  const want = JSON.stringify(cfg.bankConfig);
  if (applied.get(cfg.bank) === want) return;
  const res = await call(cfg, "", "PUT", cfg.bankConfig); // Create or update
  if (!res.ok) throw new Error(`Hindsight bank 반영 ${res.status}: ${await res.text()}`);
  applied.set(cfg.bank, want);
}

/** 질문과 관련된 기억을 찾는다 (LLM 없음, 의미·키워드·그래프·시간 4중 검색). */
export async function recall(cfg: HindsightConfig, query: string): Promise<string[]> {
  await ensureBank(cfg);
  const res = await call(cfg, "/memories/recall", "POST", { query, max_tokens: cfg.recall.maxTokens });
  if (!res.ok) throw new Error(`Hindsight recall ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results: { text: string; occurred_start?: string | null }[] };
  return data.results.map((r) => (r.occurred_start ? `${r.occurred_start.slice(0, 10)} ${r.text}` : r.text));
}

export async function reflect(bank: string, query: string): Promise<string> {
  // TODO: Hindsight reflect 호출 (LLM 사용) -> 원인/패턴 정리된 텍스트 반환
  throw new Error("not implemented");
}

export type HindsightResult = { memories: string[]; failed: boolean };

// history 라우트가 쓰는 단계. run -> execute -> fallback (다른 단계 클래스와 같은 모양)
export class Hindsight {
  constructor(private configPath = CONFIG_PATH) {}

  /** 관련 기억 찾기. 실패하면 fallback: 빈 결과 + failed (받는 쪽이 기존 RAG 파이프라인으로 넘어간다). */
  async run(query: string): Promise<HindsightResult> {
    try {
      return { memories: await this.execute(query), failed: false };
    } catch (err) {
      console.error("[hindsight] 실패, fallback 실행:", (err as Error).message);
      return this.fallback();
    }
  }

  /** 본 동작: recall */
  private execute(query: string) {
    return recall(loadConfig(this.configPath), query); // 질문마다 다시 읽어서 재시작 없이 반영
  }

  private fallback(): HindsightResult {
    return { memories: [], failed: true };
  }
}
