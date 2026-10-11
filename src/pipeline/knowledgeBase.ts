// 지식 RAG: 외부 문서(런북·위키 등)를 청크로 나눠 임베딩해 저장하고, 질문과 비슷한 청크를 찾는다.
// 임베딩 대상은 문서뿐이다 (질문은 검색할 때만 임베딩). 근거: .claude/rules/rag.md
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Chunk } from "./chunker.js";
import { EMBEDDING_DIM, type Embedder } from "./embedder.js";

export type KbHit = { source: string; chunkIndex: number; content: string; distance: number };
// hits는 거리 제한을 통과해 실제로 쓰는 청크, candidates는 제한 전의 상위 topK 전부 (튜닝할 때 제외된 것도 보려고)
export type KbSearch = { hits: KbHit[]; candidates: KbHit[]; nearest?: number; queryMs: number; failed: boolean; skipped: boolean };

// (source, chunk_index) UNIQUE는 "문서의 몇 번째 청크"라는 위치 식별용이다 (재적재 때 upsert 대상).
const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id           bigserial PRIMARY KEY,
    source       text NOT NULL,
    chunk_index  int  NOT NULL,
    content      text NOT NULL,
    content_hash text NOT NULL,
    embedding    vector(${EMBEDDING_DIM}) NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
`;

// pg 드라이버는 vector 타입을 모르니 '[0.1,0.2,...]' 문자열로 넘기고 SQL에서 ::vector로 캐스팅한다
const toVector = (v: number[]) => `[${v.join(",")}]`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class KnowledgeBase {
  private schema?: Promise<unknown>;

  /**
   * @param topK        한 번에 가져올 청크 수
   * @param maxDistance 코사인 거리가 이보다 멀면 버린다. 비워두면 자르지 않는다 (실측 전이라 기본은 자르지 않음)
   */
  constructor(
    private embedder: Embedder,
    private pool: Pool,
    readonly topK = 5,
    readonly maxDistance?: number,
  ) {}

  /**
   * 질문 벡터와 가까운 청크 찾기 (요청 경로).
   * 벡터가 null(임베딩 실패)이거나 DB가 실패하면 fallback: 빈 결과. 챗봇은 context 없이 계속 답한다.
   * nearest는 maxDistance로 걸러지기 전의 가장 가까운 거리 (임계값 조정용).
   */
  async search(vector: number[] | null): Promise<KbSearch> {
    if (!vector) return { hits: [], candidates: [], queryMs: 0, failed: false, skipped: true };
    try {
      await this.ensureSchema();
      const t = performance.now();
      const { rows } = await this.pool.query<{ source: string; chunk_index: number; content: string; distance: number }>(
        `SELECT source, chunk_index, content, embedding <=> $1::vector AS distance
           FROM kb_chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
        [toVector(vector), this.topK],
      );
      const queryMs = Math.round(performance.now() - t);
      const candidates = rows.map((r) => ({ source: r.source, chunkIndex: r.chunk_index, content: r.content, distance: r.distance }));
      const hits = candidates.filter((h) => this.maxDistance === undefined || h.distance <= this.maxDistance);
      return { hits, candidates, nearest: rows[0]?.distance, queryMs, failed: false, skipped: false };
    } catch (err) {
      console.error("[kb.search] 실패, fallback(빈 결과):", (err as Error).message);
      return { hits: [], candidates: [], queryMs: 0, failed: true, skipped: false };
    }
  }

  /**
   * 문서 하나를 적재한다 (다시 적재해도 된다).
   * - 해시가 같은 청크는 임베딩을 다시 만들지 않는다 (문서가 바뀐 부분만 재임베딩)
   * - 문서가 줄어서 사라진 뒤쪽 청크는 지운다
   * - 저장·삭제는 한 트랜잭션이라 중간 실패로 문서가 반쯤 갱신된 상태가 남지 않는다
   * 청크는 위치(index)로 식별하므로 문서 앞쪽에 문단을 끼워 넣으면 뒤 청크가 전부 바뀐 것으로 보고 다시 임베딩한다.
   * 임베딩이 끝내 실패하면 던진다 (CLI가 실패를 보여줘야 하니까 fallback 없음).
   */
  async ingest(source: string, chunks: Chunk[]) {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ chunk_index: number; content_hash: string }>(
      "SELECT chunk_index, content_hash FROM kb_chunks WHERE source = $1",
      [source],
    );
    const oldHash = new Map(rows.map((r) => [r.chunk_index, r.content_hash]));
    const todo = chunks.filter((c) => oldHash.get(c.index) !== sha256(c.content));
    const vectors = todo.length ? await this.embedder.runBatch(todo.map((c) => c.content), "search_document") : [];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [i, c] of todo.entries()) {
        await client.query(
          `INSERT INTO kb_chunks (source, chunk_index, content, content_hash, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)
           ON CONFLICT (source, chunk_index) DO UPDATE
             SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                 embedding = EXCLUDED.embedding, updated_at = now()`,
          [source, c.index, c.content, sha256(c.content), toVector(vectors[i])],
        );
      }
      const del = await client.query("DELETE FROM kb_chunks WHERE source = $1 AND chunk_index >= $2", [source, chunks.length]);
      await client.query("COMMIT");
      return {
        added: todo.filter((c) => !oldHash.has(c.index)).length,
        updated: todo.filter((c) => oldHash.has(c.index)).length,
        unchanged: chunks.length - todo.length,
        deleted: del.rowCount ?? 0,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // 테이블이 없으면 만든다. 실패하면 다음 호출에서 다시 시도한다 (DB가 나중에 떠도 동작하게).
  private ensureSchema() {
    this.schema ??= this.pool.query(SCHEMA).catch((err) => {
      this.schema = undefined;
      throw err;
    });
    return this.schema;
  }
}
