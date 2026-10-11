// 텍스트 -> 벡터. AWS Bedrock의 Cohere Embed v4를 쓴다.
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";

// pg 테이블의 vector(N)과 반드시 같아야 한다 (knowledgeBase.ts, semanticCache.ts가 이 값으로 테이블을 만든다).
export const EMBEDDING_DIM = 1024;

// Cohere는 용도별로 입력 앞에 다른 토큰을 붙인다. 저장할 문서는 search_document, 검색 질문은 search_query.
export type InputType = "search_document" | "search_query";

const MAX_TEXTS_PER_CALL = 96; // Bedrock Cohere Embed 문서: 호출당 texts 최대 96개

export class Embedder {
  private client: BedrockRuntimeClient;

  /**
   * @param model   추론 프로필 ID. 모델 ID(cohere.embed-v4:0)는 on-demand 호출이 안 돼서 global.cohere.embed-v4:0 을 써야 한다
   * @param roleArn 있으면 기본 자격증명으로 이 역할을 assume 해서 호출한다 (임시 자격증명은 SDK가 자동 갱신)
   */
  constructor(
    readonly model: string,
    region: string,
    roleArn?: string,
  ) {
    this.client = new BedrockRuntimeClient({
      region,
      credentials: roleArn
        ? fromTemporaryCredentials({ params: { RoleArn: roleArn, RoleSessionName: "genious-chatbot" }, clientConfig: { region } })
        : undefined,
    });
  }

  /**
   * 질문 1개 -> 벡터 (요청 경로용). execute()를 시도하고, 실패하면 fallback()으로 넘긴다.
   * 끝내 실패하면 null. 받는 쪽(캐시·지식 검색)이 null이면 건너뛰고 챗봇은 계속 답한다.
   */
  async run(text: string, inputType: InputType): Promise<number[] | null> {
    try {
      return (await this.execute([text], inputType))[0];
    } catch (err) {
      console.error("[embedder] 실패, fallback 실행:", (err as Error).message);
      return this.fallback(text, inputType);
    }
  }

  /**
   * 문서 여러 개 -> 벡터들 (적재용). 96개씩 나눠 호출하고, 호출마다 1회 재시도한다.
   * 그래도 실패하면 던진다. 적재가 조용히 빠지면 안 되니까 null로 넘기지 않는다.
   */
  async runBatch(texts: string[], inputType: InputType): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_TEXTS_PER_CALL) {
      const part = texts.slice(i, i + MAX_TEXTS_PER_CALL);
      try {
        vectors.push(...(await this.execute(part, inputType)));
      } catch (err) {
        console.error("[embedder] 배치 실패, 1회 재시도:", (err as Error).message);
        vectors.push(...(await this.execute(part, inputType)));
      }
    }
    return vectors;
  }

  /** 본 동작: Bedrock InvokeModel -> texts와 같은 순서의 1024차원 float 벡터들 */
  private async execute(texts: string[], inputType: InputType): Promise<number[][]> {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "*/*",
        body: JSON.stringify({
          input_type: inputType,
          texts,
          embedding_types: ["float"],
          output_dimension: EMBEDDING_DIM,
        }),
      }),
    );
    // embedding_types를 지정하면 응답이 { embeddings: { float: [[...], ...] } } 모양이다
    const data = JSON.parse(new TextDecoder().decode(res.body));
    return data.embeddings.float as number[][];
  }

  /** 실패 시 동작(run 전용): 1회 재시도. 그래도 실패하면 null (대체할 벡터는 만들 수 없음). */
  private async fallback(text: string, inputType: InputType): Promise<number[] | null> {
    try {
      return (await this.execute([text], inputType))[0];
    } catch (err) {
      console.error("[embedder] 재시도도 실패, null 반환:", (err as Error).message);
      return null;
    }
  }
}
