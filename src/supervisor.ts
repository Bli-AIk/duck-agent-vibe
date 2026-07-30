import type { Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { buildEvidenceLines, buildQuestionContext } from "./redaction.js";
import type { DuckConfig, QuestionDraft, QuestionEvidence } from "./types.js";

const SYSTEM_PROMPT = `You are Duck, a Socratic software-development supervisor.
Ask exactly one focused question about the developer's intent, boundary, tradeoff, failure, or test design.
Do not provide code, patches, commands, or a complete solution.
Use only the supplied evidence. Keep the question concise and answerable by the developer.
Return JSON only: {"question":"...","category":"intent|boundary|failure|tradeoff|testing"}.`;

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is TextContent => Boolean(item && typeof item === "object" && (item as TextContent).type === "text"))
    .map((item) => item.text)
    .join("");
}

function fallbackQuestion(evidence: QuestionEvidence): QuestionDraft {
  const category = evidence.diagnostics.length > 0 ? "failure" : evidence.summary.createdFiles > 0 ? "boundary" : "intent";
  const question = evidence.diagnostics.length > 0
    ? "What invariant did you expect this change to preserve, and which failing observation would falsify that expectation?"
    : "What problem is this change solving, and what deliberate boundary keeps the new behavior from spreading further?";
  return { question, category, evidence: buildEvidenceLines(evidence.summary, evidence.diagnostics), context: "fallback" };
}

function parseDraft(value: string, evidence: QuestionEvidence): QuestionDraft | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const categories = new Set(["intent", "boundary", "failure", "tradeoff", "testing"]);
    const category = typeof parsed.category === "string" && categories.has(parsed.category) ? parsed.category as QuestionDraft["category"] : "intent";
    if (!question || question.includes("```")) return undefined;
    return { question, category, evidence: buildEvidenceLines(evidence.summary, evidence.diagnostics), context: "model" };
  } catch {
    return undefined;
  }
}

export async function generateQuestion(
  context: ExtensionContext,
  root: string,
  evidence: QuestionEvidence,
  config: DuckConfig,
): Promise<QuestionDraft> {
  const model = selectModel(context.modelRegistry, context.model, config);
  if (!model) return fallbackQuestion(evidence);
  const provider = context.modelRegistry.getProvider(model.provider);
  if (!provider) return fallbackQuestion(evidence);
  const prompt = `Project evidence:\n${buildQuestionContext(root, evidence, config.maxQuestionContextChars)}\n\nAsk the one question now.`;
  try {
    const streamOptions = {
      maxTokens: 300,
      temperature: 0.2,
      ...(context.signal ? { signal: context.signal } : {}),
    };
    const stream = provider.streamSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, streamOptions);
    const result = await stream.result();
    return parseDraft(textFromContent(result.content), evidence) ?? fallbackQuestion(evidence);
  } catch {
    return fallbackQuestion(evidence);
  }
}

function selectModel(registry: ModelRegistry, current: Model<any> | undefined, config: DuckConfig): Model<any> | undefined {
  if (config.supervisorProvider && config.supervisorModel) {
    return registry.find(config.supervisorProvider, config.supervisorModel) ?? current;
  }
  return current;
}
