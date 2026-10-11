// 시맨틱 캐시: 질문+답변 쌍을 저장해 두고, 비슷한 질문이 오면 저장된 답변을 그대로 반환한다 (LLM 호출 생략).
// 흐름은 Redis LangCache·AWS ElastiCache 문서와 같다: 임계값 이상이면 히트, miss일 때만 LLM을 부르고 저장한다.
// 근거와 한계: .claude/rules/rag.md
import type { Pool } from "pg";
import { EMBEDDING_DIM } from "./embedder.js";

export type CacheLookup = {
  hit?: { question: string; answer: string; distance: number };
  nearest?: number;
  nearestQuestion?: string; // 임계값에 걸리기 전 가장 가까운 저장된 질문 (왜 miss인지 볼 때 쓴다)
  queryMs: number;
  failed: boolean;
  skipped: boolean;
};

// 질문끼리 비교하는 캐시라서 저장도 검색과 같은 입력 유형(search_query)으로 임베딩한 벡터를 쓴다 (server.ts가 한 벡터를 재사용).
// 같은 질문이 또 저장돼도 UNIQUE로 막지 않는다: 글자 일치는 어차피 히트(거리 0)가 되어 저장 단계까지 오지 않는다.
const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS qa_cache (
    id         bigserial PRIMARY KEY,
    question   text NOT NULL,
    answer     text NOT NULL,
    embedding  vector(${EMBEDDING_DIM}) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS qa_cache_embedding_idx ON qa_cache USING hnsw (embedding vector_cosine_ops);
`;

const toVector = (v: number[]) => `[${v.join(",")}]`;

export class SemanticCache {
  private schema?: Promise<unknown>;

  /**
   * @param maxDistance 코사인 거리가 이 이하면 같은 질문으로 보고 히트. 빡빡하게 시작하는 것이 문서의 조언이다.
   *                    기본값은 실측 없이 정한 임시값이다 (npm run calibrate로 재서 조정)
   * @param ttlHours    저장 후 이 시간이 지나면 히트로 치지 않고 다음 저장 때 지운다
   */
  constructor(
    private pool: Pool,
    readonly maxDistance: number,
    readonly ttlHours: number,
  ) {}

  /**
   * 비슷한 질문이 캐시에 있는지 본다 (만료된 항목은 제외).
   * 벡터가 null이거나 DB가 실패하면 fallback: miss로 취급 (그냥 평소대로 LLM이 답한다).
   * nearest는 임계값에 걸리기 전의 가장 가까운 거리 (임계값 조정용).
   */
  async lookup(vector: number[] | null): Promise<CacheLookup> {
    if (!vector) return { queryMs: 0, failed: false, skipped: true };
    try {
      await this.ensureSchema();
      const t = performance.now();
      const { rows } = await this.pool.query<{ question: string; answer: string; distance: number }>(
        `SELECT question, answer, embedding <=> $1::vector AS distance
           FROM qa_cache WHERE expires_at > now()
          ORDER BY embedding <=> $1::vector LIMIT 1`,
        [toVector(vector)],
      );
      const queryMs = Math.round(performance.now() - t);
      const best = rows[0];
      return {
        hit: best && best.distance <= this.maxDistance ? best : undefined,
        nearest: best?.distance,
        nearestQuestion: best?.question,
        queryMs,
        failed: false,
        skipped: false,
      };
    } catch (err) {
      console.error("[cache.lookup] 실패, fallback(miss):", (err as Error).message);
      return { queryMs: 0, failed: true, skipped: false };
    }
  }

  /**
   * miss였던 질문의 답을 저장한다. 저장하면서 만료된 항목도 지운다.
   * 벡터가 null이거나 DB가 실패하면 fallback: 저장 생략 (이미 보낸 답변은 영향 없음).
   */
  async save(question: string, vector: number[] | null, answer: string) {
    if (!vector) return { queryMs: 0, failed: false, skipped: true };
    try {
      await this.ensureSchema();
      const t = performance.now();
      await this.pool.query("DELETE FROM qa_cache WHERE expires_at <= now()");
      await this.pool.query(
        `INSERT INTO qa_cache (question, answer, embedding, expires_at)
         VALUES ($1, $2, $3::vector, now() + make_interval(secs => $4))`,
        [question, answer, toVector(vector), this.ttlHours * 3600],
      );
      return { queryMs: Math.round(performance.now() - t), failed: false, skipped: false };
    } catch (err) {
      console.error("[cache.save] 실패, fallback(저장 생략):", (err as Error).message);
      return { queryMs: 0, failed: true, skipped: false };
    }
  }

  private ensureSchema() {
    this.schema ??= this.pool.query(SCHEMA).catch((err) => {
      this.schema = undefined;
      throw err;
    });
    return this.schema;
  }
}
