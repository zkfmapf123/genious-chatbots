// history: 과거에 있었던 사실·이력을 묻는 질문. Hindsight 파이프라인으로 보낸다.
// Hindsight가 기억을 찾으면 그것을 context로 main-model이 답하고 (임베딩·캐시·지식 검색 건너뜀),
// 실패하거나 기억이 없으면 기존 RAG 파이프라인으로 이어진다. 지금 Hindsight는 스켈레톤이라 항상 실패 -> RAG.
import type { Condition } from "./index.js";

const condition: Condition = {
  name: "과거 이력 질문 -> Hindsight",
  description: "history가 채택되면 Hindsight 파이프라인으로 보낸다",
  check({ decision }) {
    if (decision.failed) return undefined;
    return { pipeline: "hindsight" };
  },
};

export default condition;
