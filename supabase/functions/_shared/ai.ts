/**
 * AI provider abstraction.
 *
 * The BLUP ranking itself is deterministic SQL (recommend_events) and works
 * with no API key at all. This layer adds the *language* on top: short natural
 * explanations, query understanding for search, and weekly digest copy.
 *
 * Swapping providers means adding one entry here — nothing else in the codebase
 * knows which LLM is behind it.
 */
import { env, optionalEnv } from './env.ts';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  system?: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  model: string;
  provider: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
}

interface AiProvider {
  name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

const anthropicProvider: AiProvider = {
  name: 'anthropic',
  async complete(request) {
    const started = Date.now();
    const model = env.aiModel();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.aiApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.4,
        system: request.system,
        messages: request.messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI_PROVIDER_ERROR: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json();
    const text = (payload.content ?? [])
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('\n');

    return {
      text,
      model,
      provider: 'anthropic',
      tokensIn: payload.usage?.input_tokens,
      tokensOut: payload.usage?.output_tokens,
      latencyMs: Date.now() - started,
    };
  },
};

const openaiProvider: AiProvider = {
  name: 'openai',
  async complete(request) {
    const started = Date.now();
    const model = env.aiModel();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.aiApiKey()}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.4,
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          ...request.messages,
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI_PROVIDER_ERROR: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json();

    return {
      text: payload.choices?.[0]?.message?.content ?? '',
      model,
      provider: 'openai',
      tokensIn: payload.usage?.prompt_tokens,
      tokensOut: payload.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    };
  },
};

const providers: Record<string, AiProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export function aiProvider(): AiProvider {
  const name = env.aiProvider();
  const provider = providers[name];
  if (!provider) {
    throw new Error(`AI_PROVIDER_UNKNOWN: ${name}`);
  }
  return provider;
}

export function aiConfigured(): boolean {
  return Boolean(optionalEnv('AI_API_KEY'));
}

/**
 * Turns a score breakdown from recommend_events into one human sentence.
 * Falls back to a deterministic template when no API key is configured, so the
 * feature degrades instead of disappearing.
 */
export function explainLocally(breakdown: {
  components: Record<string, number>;
  facts: Record<string, unknown>;
}): string {
  const reasons: string[] = [];
  const { components, facts } = breakdown;

  if ((components.interest_match ?? 0) >= 0.33) {
    reasons.push(`it matches ${facts.interest_hits} of your interests`);
  }
  if ((components.distance_score ?? 0) >= 0.7 && Number(facts.distance_m) > 0) {
    const km = Number(facts.distance_m) / 1000;
    reasons.push(km < 1 ? `it is ${Math.round(Number(facts.distance_m))} m away` : `it is ${km.toFixed(1)} km away`);
  }
  if (Number(facts.friends_going) > 0) {
    reasons.push(`${facts.friends_going} ${Number(facts.friends_going) === 1 ? 'person' : 'people'} you follow ${Number(facts.friends_going) === 1 ? 'is' : 'are'} going`);
  }
  if ((components.time_relevance ?? 0) >= 0.9) {
    reasons.push('it starts soon');
  }
  if ((components.popularity ?? 0) >= 0.5) {
    reasons.push('it is popular right now');
  }

  if (reasons.length === 0) return 'Picked as a fresh suggestion near you.';
  if (reasons.length === 1) return `Because ${reasons[0]}.`;

  return `Because ${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}.`;
}
