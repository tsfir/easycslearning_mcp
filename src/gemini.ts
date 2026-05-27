/**
 * Lightweight Gemini API client for the MCP grading tool.
 *
 * Uses gemini-2.5-flash with a JSON response schema so the grade and
 * feedback come back as structured data (no regex parsing needed).
 *
 * The API key is read from the GEMINI_API_KEY environment variable.
 */

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ─── Default grading system prompt ───────────────────────────────────────────
// Mirrors easycslearning_web/src/utils/prompt-builder.ts — keep in sync.

export const DEFAULT_GRADING_SYSTEM_PROMPT = `You are a fair, experienced computer science teacher named Oakley AI.
Your job is to grade the student's answer like a human teacher would — rewarding understanding and penalizing errors proportionally to their impact.

**STEP 0 — TASK SCOPE (DO THIS BEFORE ANYTHING ELSE):**
Read the question carefully and identify the EXACT tasks the student was asked to implement.
Questions frequently describe a full class or program context (fields, constructors, helper methods, interfaces) that is assumed to already exist — the student is only responsible for a specific subset.
Build a list: "Student was asked to implement: [list only the specific tasks/methods]".
Any class declaration, field, constructor, or method that is DESCRIBED in the question but NOT listed in the student's tasks is considered GIVEN (assumed to exist in the surrounding codebase).
NEVER deduct points for code that is described/assumed in the question but was not part of the student's tasks.

**STEP 1 — COUNT LINES:**
Count the total number of meaningful lines the student wrote (ignore blank lines and comment-only lines). Call this L_total.
Then identify which lines contain errors and count them. Call this L_err.

**STEP 2 — CLASSIFY EACH ERROR into exactly one severity level:**

LEVEL A — LOGIC / ALGORITHM FAILURE
  The algorithm does NOT correctly achieve the task's core goal.
  Deduction: up to 50% of {{maxPoints}} points based on severity.

LEVEL B — STRUCTURAL OMISSION
  The algorithm logic is correct but is missing a specific element the question explicitly required.
  Deduction: 20% of {{maxPoints}} per omission, capped at 30% total.

LEVEL C — SURFACE ERRORS
  The algorithm is logically correct. Errors exist only on specific lines.
  Deduction formula: (L_err / L_total) × 20% × {{maxPoints}}, capped at 20%.

LEVEL D — BLANK OR COMPLETELY IRRELEVANT
  Deduction: 100% (award 0 points).

**STEP 3 — CALCULATE FINAL SCORE:**
Start from {{maxPoints}}. Apply each level's deduction separately. Never go below 0.

**EXPLICIT "DO NOT DEDUCT" RULES:**
- DO NOT deduct for missing class/field/constructor described in the question but not in the student's task.
- DO NOT deduct for style, formatting, or non-meaningful variable names.
- DO NOT deduct if the student did not handle invalid input.
- DO NOT apply Level A if the algorithm produces the correct result but has minor surface errors.
- DO NOT deduct for inefficiency unless the question explicitly states a complexity requirement.
- DO NOT deduct for non-standard Queue methods: Insert(value), Remove(), Head(), IsEmpty().

**CRITICAL RULES:**
1. STEP-BY-STEP REASONING: In hidden_reasoning, write: (a) task scope, (b) L_total and L_err counts, (c) each error classified with deduction shown, (d) final score calculation.
2. YOU MUST RESPOND IN HEBREW. All feedback text must be written entirely in Hebrew.
3. Keep feedback concise — no more than 7 sentences.
4. NEVER include the correct answer, corrected code, or working solution in feedback.
5. For each error, explicitly state how many points were deducted and why.
`;

export type PromptMode = 'default' | 'extend' | 'override';

export function buildGradingSystemPrompt(
    customTemplate: string | null | undefined,
    maxPoints: number,
    mode?: PromptMode,
    dbDefault?: string
): string {
    const sub = (s: string) => s.replace(/\{\{maxPoints\}\}/g, String(maxPoints));
    const template = customTemplate?.trim();
    const resolved = mode ?? (template ? 'override' : 'default');
    const base = dbDefault?.trim() || DEFAULT_GRADING_SYSTEM_PROMPT;

    if (resolved === 'default' || !template) return sub(base);
    if (resolved === 'extend') {
        return `${sub(base)}\n\n**COURSE-SPECIFIC ADDITIONAL RULES (apply on top of the above, and override any conflicting rule):**\n${sub(template)}`;
    }
    return sub(template);
}

// ─── Gemini grading call ──────────────────────────────────────────────────────

export interface GradeResult {
    grade: number;
    feedback: string;
}

export function getGeminiApiKey(): string {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error(
            'GEMINI_API_KEY environment variable is not set. ' +
            'Add it to your MCP server config under "env": { "GEMINI_API_KEY": "your-key" }.'
        );
    }
    return key;
}

export async function gradeWithGemini(
    question: string,
    answer: string,
    maxPoints: number,
    language: string | undefined,
    systemPrompt: string
): Promise<GradeResult> {
    const apiKey = getGeminiApiKey();

    const userMessage = [
        `**Question/Exercise:**`,
        question,
        ``,
        `**Student's Answer:**`,
        answer,
        ``,
        `**Maximum Points:** ${maxPoints}`,
        language ? `**Programming Language:** ${language}` : '',
    ].filter(Boolean).join('\n');

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: {
                    hidden_reasoning: {
                        type: 'STRING',
                        description: 'Step-by-step grading logic (not shown to students)',
                    },
                    grade: {
                        type: 'NUMBER',
                        description: `Points awarded (0 – ${maxPoints})`,
                    },
                    feedback: {
                        type: 'STRING',
                        description: 'Short explanation in Hebrew for why this grade was given',
                    },
                },
                required: ['hidden_reasoning', 'grade', 'feedback'],
            },
        },
    };

    const response = await fetch(`${GEMINI_API}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new Error(`Gemini API error ${response.status}: ${text}`);
    }

    const data = await response.json() as {
        candidates?: { content: { parts: { text: string }[] } }[];
    };

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('No response content from Gemini API.');

    const parsed = JSON.parse(raw) as { grade: number; feedback: string };
    const grade = Math.min(Math.max(parsed.grade, 0), maxPoints);

    return { grade, feedback: parsed.feedback };
}
