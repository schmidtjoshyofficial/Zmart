/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";

export async function scanOpportunities() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: "You are a crypto analyst focused on Base chain. Search the web right now and identify the top 5-8 tokens on Base chain with genuine bullish momentum. Exclude: stablecoins, tokens under $100M market cap, tokens that already pumped 30%+ in the last 24 hours, tokens deployed less than 30 days ago. Return JSON only.",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              symbol: { type: Type.STRING },
              name: { type: Type.STRING },
              reason: { type: Type.STRING },
              risk: { type: Type.STRING, enum: ["low", "medium", "high"] },
              already_pumped: { type: Type.BOOLEAN }
            },
            required: ["symbol", "name", "reason", "risk", "already_pumped"]
          }
        },
        tools: [{ googleSearch: {} }]
      }
    });

    return JSON.parse(response.text || "[]");
  } catch (error) {
    console.error("AI Scan Error:", error);
    return [];
  }
}
