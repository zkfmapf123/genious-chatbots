-- pgvector 확장 활성화. 이미지(pgvector/pgvector)에는 확장이 설치만 돼 있고,
-- DB마다 CREATE EXTENSION을 해야 vector 타입을 쓸 수 있다.
-- 주의: /docker-entrypoint-initdb.d 스크립트는 데이터 디렉터리가 비어 있을 때(최초 1회)만 실행된다.
CREATE EXTENSION IF NOT EXISTS vector;
