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
