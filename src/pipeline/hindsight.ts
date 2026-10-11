// Hindsight 서버(retain/recall/reflect) 클라이언트. 설치: README.md 참고
// https://hindsight.vectorize.io/sdks/go (Go 클라이언트 기준, 여기선 REST 직접 호출 예정)

export async function recall(bank: string, query: string): Promise<string[]> {
  // TODO: Hindsight recall 호출 (LLM 없음, 벡터+BM25 등 4중 검색) -> 관련 기억 배열 반환
  throw new Error("not implemented");
}

export async function reflect(bank: string, query: string): Promise<string> {
  // TODO: Hindsight reflect 호출 (LLM 사용) -> 원인/패턴 정리된 텍스트 반환
  throw new Error("not implemented");
}

export type HindsightResult = { memories: string[]; failed: boolean };

// history 라우트가 쓰는 단계. run -> execute -> fallback (다른 단계 클래스와 같은 모양)
export class Hindsight {
  constructor(private bank = "chatbot") {}

  /** 관련 기억 찾기. 실패하면 fallback: 빈 결과 + failed (받는 쪽이 기존 RAG 파이프라인으로 넘어간다). */
  async run(query: string): Promise<HindsightResult> {
    try {
      return { memories: await this.execute(query), failed: false };
    } catch (err) {
      console.error("[hindsight] 실패, fallback 실행:", (err as Error).message);
      return this.fallback();
    }
  }

  /** 본 동작: recall (지금은 스켈레톤이라 항상 throw) */
  private execute(query: string) {
    return recall(this.bank, query);
  }

  private fallback(): HindsightResult {
    return { memories: [], failed: true };
  }
}
