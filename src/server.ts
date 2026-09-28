import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { calcCost } from "./pricing.js";

const INDEX_HTML = readFileSync("public/index.html");

const PROVIDER = process.env.PROVIDER;
const API_KEY = process.env.PROVIDER_PRIVATE_KEY;
const MODEL = process.env.CHATBOT_MAIN_MODEL;
const PORT = process.env.PORT ?? 3000;

if (PROVIDER !== "openai") {
  throw new Error(`unsupported PROVIDER: ${PROVIDER} (only "openai" for now)`);
}
if (!API_KEY || !MODEL) {
  throw new Error("missing PROVIDER_PRIVATE_KEY or CHATBOT_MAIN_MODEL in .env");
}

async function askOpenAI(message: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    content: data.choices[0].message.content as string,
    inputTokens: data.usage.prompt_tokens as number,
    outputTokens: data.usage.completion_tokens as number,
  };
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(INDEX_HTML);
    return;
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404).end();
    return;
  }

  const t0 = performance.now();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);

  let message: unknown;
  try {
    ({ message } = JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "invalid JSON body" }),
    );
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: "body must be { message: string }" }),
    );
    return;
  }

  // NDJSON: one JSON event per line, flushed as each pipeline stage happens.
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const emit = (evt: object) => res.write(JSON.stringify(evt) + "\n");

  try {
    const t1 = performance.now();
    emit({ type: "step", label: "입력", detail: message, ms: Math.round(t1 - t0) });

    emit({ type: "step-start", label: "main-model", detail: MODEL });
    const { content, inputTokens, outputTokens } = await askOpenAI(message);
    const t2 = performance.now();
    const costUsd = calcCost(MODEL, inputTokens, outputTokens);
    emit({ type: "step", label: "main-model", detail: MODEL, ms: Math.round(t2 - t1) });

    emit({ type: "done", reply: content, usage: { inputTokens, outputTokens, costUsd } });
  } catch (err) {
    emit({ type: "error", error: (err as Error).message });
  } finally {
    res.end();
  }
});

server.listen(PORT, () => console.log(`chatbot listening on :${PORT}`));
