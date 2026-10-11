// live: 지금 현재 상태를 묻는 질문 (배포 도구 API 자리)
// 아직 이 경로가 없어서 그냥 통과(fallthrough)한다: 평소 흐름(임베딩 → 캐시 → 지식 검색 → LLM)으로 간다.
// 나중에 이 라우트 전용 처리를 붙일 자리다 (예: 응답을 바로 만들거나 캐시를 건너뛰는 조건).
import type { Condition } from "./index.js";

const condition: Condition = {
  name: "live (아직 없음, 통과)",
  description: "경로가 생기기 전까지 아무것도 하지 않는다",
  check() {
    return undefined;
  },
};

export default condition;
