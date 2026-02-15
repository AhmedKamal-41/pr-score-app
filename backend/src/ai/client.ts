import OpenAI from 'openai';
import { AiInput, AiOutput } from './types.js';
import { buildPrompt } from './prompt-builder.js';
import { validateAiOutput } from './validator.js';

const AI_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 2;

/**
 * Generate AI analysis for a PR
 */
export async function generateAiAnalysis(input: AiInput): Promise<{
  success: boolean;
  output?: AiOutput;
  error?: string;
}> {
  const provider = process.env.AI_PROVIDER || 'openai';
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    return {
      success: false,
      error: 'OPENAI_API_KEY not configured',
    };
  }

  if (provider !== 'openai') {
    return {
      success: false,
      error: `Unsupported AI provider: ${provider}`,
    };
  }

  try {
    const client = new OpenAI({
      apiKey,
      timeout: AI_TIMEOUT_MS,
    });

    const prompt = buildPrompt(input);

    let lastError: Error | null = null;

    // Retry logic (max 2 retries)
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const completion = await Promise.race([
          client.chat.completions.create({
            model,
            messages: [
              {
                role: 'system',
                content:
                  'You are a code review assistant. Analyze PR risk and provide actionable, grounded insights. Always respond with valid JSON matching the requested schema.',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3, // Lower temperature for more consistent output
            max_tokens: 1000, // Limit response size
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('AI request timeout')), AI_TIMEOUT_MS)
          ),
        ]);

        const content = completion.choices[0]?.message?.content;
        if (!content) {
          throw new Error('Empty response from AI');
        }

        // Parse JSON response
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (parseError) {
          throw new Error(`Failed to parse AI response as JSON: ${parseError}`);
        }

        // Validate output
        const validation = validateAiOutput(parsed);
        if (!validation.valid) {
          throw new Error(`AI output validation failed: ${validation.error}`);
        }

        return {
          success: true,
          output: validation.data,
        };
      } catch (error: any) {
        lastError = error;

        // Don't retry on validation errors or timeout
        if (
          error.message?.includes('validation failed') ||
          error.message?.includes('timeout') ||
          attempt === MAX_RETRIES
        ) {
          break;
        }

        // Wait before retry (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error during AI analysis',
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to generate AI analysis',
    };
  }
}

