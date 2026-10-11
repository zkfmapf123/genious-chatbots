// deny: 이 챗봇의 업무(CI/CD 배포·운영)와 무관한 질문 (인사·잡담 등). 고정 안내문으로 막고 절차 질문을 하도록 안내한다.
// - 안내문(message)과 예시 질문(examples)은 jev.json의 questions.deny.condition에서 고친다 (재시작 필요 없음).
// - LLM, 임베딩, 캐시, 지식 검색을 모두 건너뛴다 (고정 안내문이라 비용 0). 임베딩 전에 끝나므로 qa_cache에도 저장되지 않는다.
// - Jev가 실패했거나(판정 불가) message가 없으면 적용하지 않고 통과한다 (기존 RAG 파이프라인으로 간다).
import type { Condition } from "./index.js";

const condition: Condition = {
  name: "업무와 무관한 질문 -> 안내",
  description: "deny가 채택되면 jev.json의 안내문으로 답한다",
  check({ decision, config }) {
    if (decision.failed) return undefined;
    const { message, examples } = config;
    if (typeof message !== "string" || !message) return undefined;
    const list = Array.isArray(examples) ? examples.filter((q): q is string => typeof q === "string") : [];
    return { reply: list.length ? `${message}\n\n이런 질문은 어때요?\n${list.map((q) => `- ${q}`).join("\n")}` : message };
  },
};

export default condition;
