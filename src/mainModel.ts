// 답변 생성 LLM (OpenAI chat completions)

export type Answer = { content: string; inputTokens: number; outputTokens: number };

export class MainModel {
  constructor(
    private apiKey: string,
    readonly model: string,
  ) {}

  /** 바깥에서 부르는 메서드. execute()를 시도하고, 실패하면 fallback()으로 넘긴다. */
  async run(message: string, context: string[] = []): Promise<Answer> {
    try {
      return await this.execute(message, context);
    } catch (err) {
      console.error("[main-model] 실패, fallback 실행:", (err as Error).message);
      return this.fallback(message, context);
    }
  }

  /** 본 동작: OpenAI 호출 -> 답변 + 토큰 사용량. context(검색된 문서 청크)가 있으면 system 메시지로 앞에 붙인다. */
  private async execute(message: string, context: string[]): Promise<Answer> {
    const messages = [{ role: "user", content: message }];
    if (context.length > 0) {
      messages.unshift({
        role: "system",
        content: `아래는 질문과 관련 있을 수 있는 참고 문서다. 관련 있으면 근거로 삼아 답하고, 근거로 쓴 문서는 [1]처럼 번호로 표시해라. 관련 없으면 무시하고 평소처럼 답해라.\n\n${context.join("\n\n")}`,
      });
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${await res.text()}`); // -> run()이 잡아서 fallback
    }

    const data = await res.json();
    return {
      content: data.choices[0].message.content as string,
      inputTokens: data.usage.prompt_tokens as number,
      outputTokens: data.usage.completion_tokens as number,
    };
  }

  /**
   * 실패 시 동작: 1회 재시도. 그래도 실패하면 에러가 server.ts까지 올라간다.
   * (Jev처럼 기본값을 줄 수 없음. 가짜 답변을 만들 수는 없으니까)
   */
  private fallback(message: string, context: string[]): Promise<Answer> {
    return this.execute(message, context);
  }
}
