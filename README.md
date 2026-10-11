# genious-chatbot

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
```

`.env`에 `PROVIDER`, `PROVIDER_PRIVATE_KEY`, `CHATBOT_MAIN_MODEL` 필요.

## Hindsight 서버 띄우기

recall/reflect용 [Hindsight](https://github.com/vectorize-io/hindsight) 서버. 아직 코드에서 연결은 안 했고, `src/pipeline/hindsight.ts`가 여길 호출할 예정.

```bash
docker run -it --pull always --name hindsight --restart unless-stopped \
  --shm-size=1g -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_PROVIDER=openai \
  -e HINDSIGHT_API_LLM_API_KEY=$PROVIDER_PRIVATE_KEY \
  -e HINDSIGHT_API_LLM_MODEL=gpt-4o-mini \
  -e HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=$PROVIDER_PRIVATE_KEY \
  -e HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=text-embedding-3-small \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

- API 서버: http://localhost:8888
- Control Plane(Web UI): http://localhost:9999
- `.env`의 `PROVIDER_PRIVATE_KEY`(OpenAI 키)를 그대로 재사용 — Hindsight 전용 LLM/임베딩 provider 설정이라 우리 챗봇 설정과는 별개.
- 이미지는 full(~9GB, embedding 내장). slim(~500MB)은 외부 embedding/reranker 설정이 필수라 지금은 안 씀.
- 기동 확인: `curl http://localhost:8888/health`, 또는 `docker logs hindsight | grep "Started server"`

## PostgreSQL (pgvector)

RAG 문서 벡터 저장용. `docker-compose.yml`의 `postgres` 서비스 (`pgvector/pgvector:pg16`, PostgreSQL 16 + pgvector 0.8).

```bash
docker-compose up -d postgres   # chatbot 서비스는 빼고 DB만 (dev 서버와 3000 포트가 겹치지 않게)
```

- 접속 정보는 `.env`의 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`. `localhost:5432`로 접속한다.
- `docker/postgres/init/01-pgvector.sql`이 `CREATE EXTENSION vector`를 실행한다. 이 스크립트는 **데이터 볼륨이 비어 있을 때 최초 1회만** 돈다. 이미 만든 볼륨에는 적용되지 않으니, 다시 돌리려면 `docker-compose down -v`로 볼륨(`pgdata`)을 지우고 다시 띄운다 (**저장된 데이터가 모두 삭제됨**).
- 확인: `docker exec -it genious-chatbot-postgres-1 psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\dx"`에 `vector`가 보이면 된다.

## RAG (지식 적재 + 시맨틱 캐시)

질문이 오면 `임베딩 → 캐시 조회 → (miss면) 지식 검색 → main-model → 캐시 저장` 순서로 처리한다. 근거와 한계는 `.claude/rules/rag.md`.

```bash
npm run ingest -- <파일 또는 폴더 ...>   # 마크다운 적재 (기본: __kb__/). 다시 실행하면 바뀐 부분만 재임베딩
npm run calibrate                        # 캐시 임계값 실측 (질문 쌍의 코사인 거리 출력)
```

- 임베딩은 AWS Bedrock Cohere Embed v4 (`.env`의 `EMBEDDING_MODEL`, `AWS_REGION`, `AWS_BEDROCK_ASSUME_ROLE`). Bedrock 호출이 안 되면 캐시·지식 검색을 건너뛰고 main-model만으로 답한다.
- 튜닝 값(`.env`, 모두 선택): `CACHE_MAX_DISTANCE`(기본 0.05, **미실측 임시값**), `CACHE_TTL_HOURS`(기본 24), `KB_TOP_K`(기본 5), `KB_MAX_DISTANCE`(없으면 자르지 않음).
- 지식 문서는 `__kb__/`에 넣는다 (폴더 안은 비어 있음).

## 관리자 화면 (/admin)

`http://localhost:3000/admin`에서 지금까지의 질문과 답변을 본다 (시각, 질문, 답변, 캐시 히트 여부, 문서 수, 비용, 시간). 행을 누르면 전문과 토큰이 펼쳐지고, 위 검색창으로 질문·답변을 거른다.

- **로그인이 없다.** 포트 3000에 닿는 사람은 누구나 모든 사용자의 질문·답변을 볼 수 있다. 같은 네트워크에 열려 있다면 주의하고, 외부에 공개하기 전에는 인증이나 접근 제한을 붙인다.
- 기록은 `chat_log` 테이블에 쌓인다. 임베딩과 무관해서 Bedrock이 막혀 있어도 기록된다.
- 질문·답변은 글자 그대로 표시한다 (`<img>` 같은 태그를 넣어도 해석되지 않는다).

출처: [Hindsight Installation](https://hindsight.vectorize.io/developer/installation), [Configuration](https://hindsight.vectorize.io/developer/configuration)

## 로그 보기 (Dozzle)

`docker-compose up -d` 후 http://localhost:8080 에서 chatbot, postgres 컨테이너 로그를 실시간으로 본다. 로그인이 없어서 `127.0.0.1`에만 열어 뒀고, docker 소켓을 읽기 전용으로 마운트한다.
