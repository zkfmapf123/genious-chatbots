// 마크다운 문서 -> 검색용 청크. 적재(ingest)에서만 쓴다.
import { fileURLToPath } from "node:url";

export type Chunk = { index: number; content: string };

/**
 * 헤딩 단위로 나누고, 같은 헤딩 아래 문단들은 maxChars까지 묶는다.
 * 각 청크 앞에 헤딩 경로("A > B")를 붙여서, 청크만 따로 검색돼도 어느 문서의 무슨 얘기인지 남게 한다.
 * ``` 코드 블록 안은 빈 줄이 있어도 쪼개지 않고, 안의 `# 주석`을 헤딩으로 보지 않는다.
 *
 * maxChars 1200은 임시값이다. Bedrock 문서는 "RAG에는 작은 청크가 검색과 비용에 유리한 경우가 많다"고만 하고 크기는 정하지 않는다.
 */
export function chunkMarkdown(markdown: string, maxChars = 1200): Chunk[] {
  // 1. 문단 블록으로 쪼갠다 (각 블록에 헤딩 경로를 붙여서)
  const blocks: { heading: string; text: string }[] = [];
  const path: string[] = [];
  let para: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = para.join("\n").trim();
    if (text) blocks.push({ heading: path.filter(Boolean).join(" > "), text });
    para = [];
  };

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      para.push(line);
      continue;
    }
    if (inFence) {
      para.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      path.length = h[1].length - 1; // 더 깊은 헤딩 경로는 버린다
      path[h[1].length - 1] = h[2].trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();

  // 2. 같은 헤딩끼리 maxChars까지 묶는다. 한 블록이 maxChars보다 길면 먼저 자른다.
  const groups: { heading: string; parts: string[]; len: number }[] = [];
  for (const b of blocks) {
    for (const piece of splitLong(b.text, maxChars)) {
      const last = groups[groups.length - 1];
      if (last && last.heading === b.heading && last.len + piece.length <= maxChars) {
        last.parts.push(piece);
        last.len += piece.length + 2;
      } else {
        groups.push({ heading: b.heading, parts: [piece], len: piece.length });
      }
    }
  }

  return groups.map((g, index) => ({
    index,
    content: (g.heading ? g.heading + "\n\n" : "") + g.parts.join("\n\n"),
  }));
}

/** max보다 긴 텍스트를 줄 단위로 자른다. 한 줄이 max보다 길면 그 줄도 자른다. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let s = 0; s < Math.max(line.length, 1); s += max) {
      const piece = line.slice(s, s + max);
      if (cur && cur.length + 1 + piece.length > max) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? cur + "\n" + piece : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// self-check: npx tsx src/pipeline/chunker.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = chunkMarkdown("# A\n\ntext1\n\n## B\n\ntext2");
  console.assert(a.length === 2, "헤딩마다 청크");
  console.assert(a[0].content === "A\n\ntext1" && a[1].content === "A > B\n\ntext2", "헤딩 경로 접두");

  const fence = chunkMarkdown("## S\n\n```bash\n# c1\n\necho hi\n```");
  console.assert(fence.length === 1, "코드 블록은 한 청크");
  console.assert(fence[0].content.startsWith("S\n\n") && fence[0].content.includes("# c1") && fence[0].content.includes("echo hi"), "코드 안 # 는 헤딩 아님");

  const packed = chunkMarkdown("# T\n\n" + Array.from({ length: 6 }, (_, i) => `문단${i}`.padEnd(20, "x")).join("\n\n"), 50);
  console.assert(packed.length > 1 && packed.every((c) => c.content.startsWith("T\n\n")), "maxChars 넘으면 분할, 헤딩 유지");

  const long = chunkMarkdown("# L\n\n" + "가".repeat(300), 100);
  console.assert(long.length >= 3, "긴 문단은 잘라냄");

  console.assert(chunkMarkdown("").length === 0 && chunkMarkdown("\n\n  \n").length === 0, "빈 입력");
  console.log("chunker self-check done");
}
