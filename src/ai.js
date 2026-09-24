'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You write the covering summary for a UK letting agent's monthly statement to a landlord.

You are given the statement's figures as JSON. The figures have already been calculated by the accounting system and are correct; your job is only to explain them clearly.

Write 2 short paragraphs in plain British English, addressed to the landlord by name, from the agency:
- What rent was received this month, and from which properties.
- What was deducted (management fees, repairs, invoices, other expenses), naming the main items.
- The net amount for the month, what has already been paid to them, and the balance the agency is holding.
- Briefly flag anything they should know about: rent still outstanding (arrears), a property with no rent this month, or unusually large costs.

Only mention amounts that appear in the JSON, formatted exactly as given (e.g. "£1,234.56"). Do not calculate new totals, percentages or estimates, and do not invent facts that aren't in the data. No headings, bullet points, greeting line or sign-off: the statement adds those. Keep it under 170 words.`;

// Returns an async function (facts) => { text, model } or null when no API credentials are configured.
function createStatementWriter(env = process.env) {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic();

  return async function writeStatementSummary(facts) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If the model declines, the API retries on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Statement data:\n${JSON.stringify(facts, null, 2)}` }],
    });
    if (response.stop_reason === 'refusal') throw new Error('The AI declined to write this summary.');
    if (response.stop_reason === 'max_tokens') throw new Error('The AI summary was cut off.');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('The AI returned an empty summary.');
    return { text, model: response.model };
  };
}

module.exports = { createStatementWriter, MODEL };
