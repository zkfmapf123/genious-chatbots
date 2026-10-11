// 모든 질문·답변 기록. 관리자 화면(/admin)이 읽는다. 임베딩과 무관해서 Bedrock이 막혀 있어도 쌓인다.
import type { Pool } from "pg";

export type ChatEntry = {
  question: string;
  answer: string;
  cached: boolean; // 캐시 히트로 답했는지 (LLM 호출 없음)
  sources: number; // 답변에 context로 넘긴 문서 청크 수
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  totalMs: number;
  noContext?: boolean; // 지식 검색이 0건이라 모델 없이 "모른다"고 답했는지 (/admin에서 문서 보강 대상으로 모아 본다)
  pipeline?: object[]; // 그 턴에 화면에 보여준 단계 이벤트(config + step) 그대로. 관리자에서 흐름을 다시 본다
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_log (
    id            bigserial PRIMARY KEY,
    question      text NOT NULL,
    answer        text NOT NULL,
    cached        boolean NOT NULL,
    sources       int NOT NULL,
    input_tokens  int NOT NULL,
    output_tokens int NOT NULL,
    cost_usd      double precision NOT NULL,
    total_ms      int NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS pipeline jsonb;
  ALTER TABLE chat_log ADD COLUMN IF NOT EXISTS no_context boolean NOT NULL DEFAULT false;
`;

export class ChatLog {
  private schema?: Promise<unknown>;

  constructor(private pool: Pool) {}

  /**
   * 한 턴을 기록하고 번호(id)를 돌려준다. 이 번호가 질문·답변마다 하나씩 붙는 고유 번호다 (디버깅할 때 이 번호로 찾는다).
   * 실패하면 fallback: 로그만 남기고 undefined (기록 때문에 이미 만든 답변을 막지 않는다).
   */
  async record(e: ChatEntry): Promise<number | undefined> {
    try {
      await this.ensureSchema();
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO chat_log (question, answer, cached, sources, input_tokens, output_tokens, cost_usd, total_ms, pipeline, no_context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [e.question, e.answer, e.cached, e.sources, e.inputTokens, e.outputTokens, e.costUsd, e.totalMs, JSON.stringify(e.pipeline ?? []), e.noContext ?? false],
      );
      return Number(rows[0].id);
    } catch (err) {
      console.error("[chatLog.record] 실패, fallback(기록 생략):", (err as Error).message);
      return undefined;
    }
  }

  /** 최근 기록부터. 관리자 화면 전용이라 실패하면 그대로 던진다. */
  async list(limit = 200) {
    await this.ensureSchema();
    const n = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
    const { rows } = await this.pool.query(
      `SELECT id, question, answer, cached, sources,
              input_tokens AS "inputTokens", output_tokens AS "outputTokens",
              cost_usd AS "costUsd", total_ms AS "totalMs", pipeline, no_context AS "noContext", created_at AS "createdAt"
         FROM chat_log ORDER BY id DESC LIMIT $1`,
      [n],
    );
    return rows;
  }

  /** 기록 한 건 삭제 (관리자 화면 전용). 지웠으면 true. qa_cache의 같은 질문 캐시는 건드리지 않는다. */
  async remove(id: number) {
    await this.ensureSchema();
    const { rowCount } = await this.pool.query("DELETE FROM chat_log WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * 전체 초기화 (관리자 화면 전용): chat_log, qa_cache, kb_chunks를 모두 비운다. 돌이킬 수 없다.
   * 번호(id)는 되감지 않는다: 지운 번호가 다른 대화에 다시 붙으면 디버깅 때 헷갈린다.
   * qa_cache, kb_chunks는 첫 사용 때 만들어지는 테이블이라 없으면 건너뛴다.
   */
  async resetAll() {
    await this.ensureSchema();
    const { rows: [t] } = await this.pool.query(`SELECT to_regclass('qa_cache') IS NOT NULL AS qa, to_regclass('kb_chunks') IS NOT NULL AS kb`);
    const count = async (table: string) => (await this.pool.query(`DELETE FROM ${table}`)).rowCount ?? 0;
    return {
      chats: await count("chat_log"),
      cache: t.qa ? await count("qa_cache") : 0,
      chunks: t.kb ? await count("kb_chunks") : 0,
    };
  }

  /** 요약 숫자. qa_cache, kb_chunks는 첫 사용 때 만들어지는 테이블이라 없을 수 있다 (없으면 0). */
  async stats() {
    await this.ensureSchema();
    const { rows: [c] } = await this.pool.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE cached))::int AS cached, (count(*) FILTER (WHERE no_context))::int AS "noContext",
              coalesce(sum(cost_usd), 0)::float AS "costUsd" FROM chat_log`,
    );
    const { rows: [t] } = await this.pool.query(`SELECT to_regclass('qa_cache') IS NOT NULL AS qa, to_regclass('kb_chunks') IS NOT NULL AS kb`);
    const qaEntries = t.qa ? (await this.pool.query("SELECT count(*)::int AS n FROM qa_cache WHERE expires_at > now()")).rows[0].n : 0;
    const kbChunks = t.kb ? (await this.pool.query("SELECT count(*)::int AS n FROM kb_chunks")).rows[0].n : 0;
    return { total: c.total as number, cached: c.cached as number, noContext: c.noContext as number, costUsd: c.costUsd as number, qaEntries: qaEntries as number, kbChunks: kbChunks as number };
  }

  private ensureSchema() {
    this.schema ??= this.pool.query(SCHEMA).catch((err) => {
      this.schema = undefined;
      throw err;
    });
    return this.schema;
  }
}
