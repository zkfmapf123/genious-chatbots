// .env에서 읽어 pg 연결과 임베더를 만든다. server.ts, ingest.ts, calibrate.ts가 같이 쓴다.
import pg from "pg";
import { Embedder } from "./embedder.js";

export function createPool() {
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_HOST = "localhost" } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    throw new Error("missing POSTGRES_USER/PASSWORD/DB in .env");
  }
  return new pg.Pool({ host: POSTGRES_HOST, user: POSTGRES_USER, password: POSTGRES_PASSWORD, database: POSTGRES_DB });
}

export function createEmbedder() {
  const { EMBEDDING_MODEL, AWS_REGION, AWS_BEDROCK_ASSUME_ROLE } = process.env;
  if (!EMBEDDING_MODEL || !AWS_REGION) {
    throw new Error("missing EMBEDDING_MODEL or AWS_REGION in .env");
  }
  return new Embedder(EMBEDDING_MODEL, AWS_REGION, AWS_BEDROCK_ASSUME_ROLE);
}

// 숫자 환경변수. 없으면 기본값.
export const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);
