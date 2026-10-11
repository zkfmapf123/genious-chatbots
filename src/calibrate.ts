// 캐시 임계값(CACHE_MAX_DISTANCE) 실측 도구: npm run calibrate
// 질문 쌍의 코사인 거리를 재서 보여준다. 캐시는 "같은 뜻" 쌍은 히트시키고 "비슷해 보이지만 다른 질문" 쌍은 막아야 한다.
// 두 그룹의 거리가 겹치면 어떤 임계값으로도 오답 없이 쓸 수 없다 (Redis 문서: 오답 매칭은 유사도 캐시의 본질적 위험).
import { createEmbedder } from "./pipeline/setup.js";

const PAIRS: { kind: "같은 뜻 (히트해야 함)" | "다른 질문 (히트하면 안 됨)" | "무관"; a: string; b: string }[] = [
  { kind: "같은 뜻 (히트해야 함)", a: "오늘 날씨 어때?", b: "오늘 날씨 알려줘" },
  { kind: "같은 뜻 (히트해야 함)", a: "payment-api 배포 절차 알려줘", b: "payment-api는 어떻게 배포해?" },
  { kind: "같은 뜻 (히트해야 함)", a: "안녕", b: "안녕하세요" },
  { kind: "다른 질문 (히트하면 안 됨)", a: "payment-api 배포 절차 알려줘", b: "payment-api 롤백 절차 알려줘" },
  { kind: "다른 질문 (히트하면 안 됨)", a: "지금 prod 버전이 뭐야?", b: "어제 prod 버전이 뭐였어?" },
  { kind: "다른 질문 (히트하면 안 됨)", a: "오늘 날씨 어때?", b: "내일 날씨 어때?" },
  { kind: "무관", a: "오늘 날씨 어때?", b: "payment-api 배포 절차 알려줘" },
];

const cosineDistance = (x: number[], y: number[]) => {
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  return 1 - dot / Math.sqrt(nx * ny);
};

// 캐시는 질문끼리 비교하므로 양쪽 다 search_query로 임베딩한다 (server.ts와 같은 방식)
const embedder = createEmbedder();
const texts = PAIRS.flatMap((p) => [p.a, p.b]);
const vectors = await embedder.runBatch(texts, "search_query").catch((err: Error) => {
  console.error("임베딩 실패:", err.message);
  process.exit(1);
});

const rows = PAIRS.map((p, i) => ({ ...p, d: cosineDistance(vectors[2 * i], vectors[2 * i + 1]) }));
for (const r of rows) console.log(`${r.d.toFixed(3)}  [${r.kind}]  ${r.a}  <->  ${r.b}`);

const range = (kind: string) => rows.filter((r) => r.kind.startsWith(kind)).map((r) => r.d);
const same = range("같은 뜻"), diff = range("다른 질문");
console.log(`\n같은 뜻 최대 거리 ${Math.max(...same).toFixed(3)} / 다른 질문 최소 거리 ${Math.min(...diff).toFixed(3)}`);
console.log(
  Math.max(...same) < Math.min(...diff)
    ? "분리됨: CACHE_MAX_DISTANCE를 이 두 값 사이(빡빡하게는 같은 뜻 쪽에 가깝게)로 정할 수 있다."
    : "겹침: 이 임베딩으로는 어떤 임계값도 오답 없이 같은 뜻만 가려낼 수 없다. 캐시를 쓰지 않거나 임계값을 아주 빡빡하게 둔다.",
);
