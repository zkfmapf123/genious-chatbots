// RAG 답변 설정(config/rag.json). 질문마다 다시 읽는다. 파일이 없거나 틀리면 아래 기본 문구를 쓴다
// (설정 오류 때문에 근거 없는 답을 모델이 지어내게 되면 안 되니까, 여기서는 fallback이 "기본 문구"다).
import { readFileSync } from "node:fs";

export type RagConfig = { noAnswerText: string; unavailableText: string };

const DEFAULTS: RagConfig = {
  noAnswerText: "문서에서 관련 내용을 찾지 못했어요. 정확하지 않은 답을 드리지 않기 위해 답변하지 않을게요. 담당자에게 문의해 주세요.",
  unavailableText: "지금은 문서를 검색할 수 없어 답변드리기 어려워요. 잠시 후 다시 시도하시거나 담당자에게 문의해 주세요.",
};

/** config/rag.json을 읽어 문구를 만든다. 틀린 항목은 기본 문구로 대신하고 로그를 남긴다. */
export function loadRagConfig(path = "config/rag.json"): RagConfig {
  try {
    const c = JSON.parse(readFileSync(path, "utf8"));
    const msg = (v: unknown, name: string, fallback: string) => {
      if (typeof v === "string" && v.trim()) return v;
      console.error(`[rag.json] ${name}가 비어 있거나 문자열이 아님, 기본 문구 사용`);
      return fallback;
    };
    const noAnswer = msg(c.noAnswer?.message, "noAnswer.message", DEFAULTS.noAnswerText);
    const contact = typeof c.noAnswer?.contact === "string" ? c.noAnswer.contact.trim() : "";
    return {
      noAnswerText: contact ? `${noAnswer}\n\n문의: ${contact}` : noAnswer,
      unavailableText: msg(c.unavailable?.message, "unavailable.message", DEFAULTS.unavailableText),
    };
  } catch (err) {
    console.error("[rag.json] 읽기 실패, 기본 문구 사용:", (err as Error).message);
    return DEFAULTS;
  }
}
