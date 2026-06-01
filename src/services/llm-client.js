import { GeminiWebService } from './gemini.js';

/**
 * @typedef {Object} LlmRequest
 * @property {string} prompt - The prompt to send to the LLM
 * @property {number} [temperature] - Generation temperature (0-1)
 * @property {number} [maxTokens] - Maximum output tokens
 * @property {string} [geminiConversationId] - Resume an existing Gemini conversation
 */

/**
 * @typedef {Object} LlmResponse
 * @property {string} content - The LLM response text
 * @property {string} model - The model used (e.g. 'gemini')
 * @property {string} [geminiConversationId] - Conversation ID for continuity
 */

const geminiWeb = new GeminiWebService();

/**
 * Send a prompt to Gemini via browser automation and return the response.
 * Supports conversation continuity via geminiConversationId.
 * Adapted from nepse's callLlm pattern.
 *
 * @param {LlmRequest} request
 * @returns {Promise<LlmResponse>}
 */
export async function callLlm(request) {
  const result = await geminiWeb.ask(request.prompt, request.geminiConversationId);
  return {
    content: result.content,
    model: 'gemini',
    geminiConversationId: result.geminiConversationId,
  };
}

/**
 * Check if the LLM service is available.
 * Browser-automation path is always available (no API key needed).
 *
 * @returns {boolean}
 */
export function isLlmAvailable() {
  return true;
}
