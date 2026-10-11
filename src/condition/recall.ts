// recall: 과거에 있었던 사실을 묻는 질문 (Hindsight recall 자리)
// 아직 이 경로가 없어서 그냥 통과(fallthrough)한다: 평소 흐름(임베딩 → 캐시 → 지식 검색 → LLM)으로 간다.
// 나중에 이 라우트 전용 처리를 붙일 자리다 (예: 응답을 바로 만들거나 캐시를 건너뛰는 조건).
import type { Condition } from "./index.js";

const condition: Condition = {
  name: "recall (아직 없음, 통과)",
  description: "경로가 생기기 전까지 아무것도 하지 않는다",
  check() {
    return undefined;
  },
};

export default condition;
