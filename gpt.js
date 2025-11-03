// gptCore.js
require('dotenv').config();
const { OpenAI } = require("openai");

// 🔐 Hardcoded key for testing; in prod use process.env.OPENAI_API_KEY
const openai = new OpenAI({
 apiKey: "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"
});

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

const DEFAULT_PERSONA = {
  name: "Mev Executor",
  systemPrompt: `
You are Mev Executor, a ruthless AI MEV strategist.
You plan token swap paths, flashloan routes, and profit-maximizing operations across L2 DEXes.
Respond only in raw data formats as requested.
`.trim()
};

async function askGPT({ prompt, persona = DEFAULT_PERSONA, temperature = 0.6 }) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: persona.systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature,
    response_format: { type: "json_object" }, // enforce clean JSON
  });

  let raw = res.choices[0].message.content;

  // --- Normalize ---
  if (typeof raw === "object" && raw !== null) {
    // Already parsed JSON
    return raw;
  }

  if (typeof raw === "string") {
    raw = raw.trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/```json|```/g, "").trim();
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      return { error: err.message, rawOutput: raw };
    }
  }

  return { error: "Unexpected GPT output type", rawOutput: raw };
}

module.exports = { askGPT };


