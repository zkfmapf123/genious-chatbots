// docs: 절차·사용법 질문. 이 이름표가 "진짜로" 채택된 질문은 통과해서 평소 흐름(지식 검색)으로 간다.
// 어느 라우트도 임계값을 못 넘어서 기본 라우트(docs)가 대신 들어온 경우(인사말·잡담 등)만 절차 질문을 하도록 안내한다.
// - LLM, 임베딩, 캐시, 지식 검색을 모두 건너뛴다 (고정 안내문이라 비용 0). 임베딩 전에 끝나므로 qa_cache에도 저장되지 않는다.
// - Jev가 실패했거나(판정 불가) jev.json에 docs 질문이 없으면 적용하지 않고 통과한다.
// - recall/reflect/live가 채택된 질문은 이 파일에 오지 않는다 (각자 자기 파일로 가고, 지금은 모두 통과).
import type { Condition } from "./index.js";

// 안내문에 보여줄 예시 질문. __kb__/ 문서 내용에 맞춰 고친다.
const EXAMPLES = [
  "payment-api 배포 절차 알려줘",
  "롤백은 어떻게 해?",
  "카나리 배포 중단 기준이 뭐야?",
  "CrashLoopBackOff 원인이 뭐야?",
  "핫픽스는 어떻게 배포해?",
];

const condition: Condition = {
  name: "docs가 아니면 절차 질문 안내",
  description: "임계값을 넘은 라우트가 없으면 고정 안내문으로 답한다",
  check({ decision }) {
    if (decision.failed || !("docs" in decision.probs)) return undefined;
    if (!decision.usedDefault) return undefined; // docs가 진짜로 채택됨 -> 통과
    return {
      reply:
        "저는 CI/CD 배포 절차를 안내하는 챗봇이에요. 절차나 사용법을 물어봐 주세요.\n\n" +
        "이런 질문은 어때요?\n" +
        EXAMPLES.map((q) => `- ${q}`).join("\n"),
    };
  },
};

export default condition;
