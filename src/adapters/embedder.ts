import type { EmbedderPort } from "../ports.js";

export class NoopEmbedder implements EmbedderPort {
  readonly dimensions: number;
  readonly configured = false;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(_text: string): Promise<Float32Array | null> {
    return null;
  }
}

export interface OpenAICompatibleEmbedderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs?: number;
}

/**
 * Standard OpenAI-compatible HTTP embedding adapter (/v1/embeddings).
 * Fails open to null on network/timeout errors so writes never block and fall back to FTS5.
 */
export class OpenAICompatibleEmbedder implements EmbedderPort {
  readonly dimensions: number;
  readonly configured = true;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    this.dimensions = options.dimensions;
    const base = options.baseUrl.replace(/\/+$/, "");
    this.endpoint = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: trimmed,
          dimensions: this.dimensions,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = data.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== this.dimensions) {
        return null;
      }
      return Float32Array.from(vec);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Builds an embedder from standard environment variables:
 * - MERU_MIND_EMBED_URL (default: https://api.openai.com/v1)
 * - MERU_MIND_EMBED_API_KEY
 * - MERU_MIND_EMBED_MODEL (default: text-embedding-3-small)
 * - MERU_MIND_EMBED_DIM (default: 1536)
 */
export function createEmbedderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbedderPort {
  const dimensions = env.MERU_MIND_EMBED_DIM
    ? Number.parseInt(env.MERU_MIND_EMBED_DIM, 10)
    : 1536;
  const apiKey = env.MERU_MIND_EMBED_API_KEY?.trim();
  if (!apiKey) {
    return new NoopEmbedder(
      Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 1536,
    );
  }
  return new OpenAICompatibleEmbedder({
    baseUrl: env.MERU_MIND_EMBED_URL?.trim() || "https://api.openai.com/v1",
    apiKey,
    model: env.MERU_MIND_EMBED_MODEL?.trim() || "text-embedding-3-small",
    dimensions:
      Number.isInteger(dimensions) && dimensions > 0 ? dimensions : 1536,
  });
}
