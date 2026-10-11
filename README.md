# genious-chatbot

## 실행

```bash
npm install
npm run dev        # http://localhost:3000
```

`.env`에 `PROVIDER`, `PROVIDER_PRIVATE_KEY`, `CHATBOT_MAIN_MODEL` 필요.

## Hindsight (장기 기억)

`docker-compose.yml`의 `hindsight` 서비스 (`ghcr.io/vectorize-io/hindsight`). Jev가 `history`로 판정한 질문이 여기로 간다 (`src/pipeline/hindsight.ts`의 `recall`).

```bash
docker-compose up -d hindsight   # 처음에는 이미지(약 3.5GB)를 받느라 오래 걸린다
curl http://localhost:8888/health
```

- API: http://localhost:8888 (경로 목록은 `/openapi.json`), Control Plane(Web UI): http://localhost:9999. 둘 다 `127.0.0.1`에만 열려 있고 로그인이 없다.
- 기억 LLM은 `.env`의 `PROVIDER_PRIVATE_KEY`(OpenAI 키)를 재사용한다. 모델은 `HINDSIGHT_LLM_MODEL`(기본 `gpt-4o-mini`). 챗봇 모델과는 별개 설정이다.
- 기억은 `hindsight-data` 볼륨에 저장된다. `docker-compose down -v`는 이 기억도 지운다.
- bank 이름은 `HINDSIGHT_BANK`(기본 `chatbot`). 첫 recall 때 없으면 서버가 만든다.
- **아직 기억을 넣는(retain) 코드는 없다.** 그래서 지금은 recall이 항상 비어 있고 `history` 질문은 `Hindsight MISS` 후 기존 RAG로 이어진다.

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
