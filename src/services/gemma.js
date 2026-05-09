import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Gemma AI Service using Google's Generative AI SDK
 * Uses Gemma 4 31B model for astrology consultations
 */
export class GemmaService {
  constructor() {
    const apiKey = process.env.GOOGLE_AI_API_KEY;

    if (!apiKey) {
      console.warn(
        '⚠️  GOOGLE_AI_API_KEY not found. Gemma service may not work properly.',
      );
    }

    this.genAI = new GoogleGenerativeAI(apiKey);

    // Using Gemma model - adjust model name based on available models
    // Gemma 4 31B or latest available Gemma model
    console.log(
      `👺 Initializing GemmaService with model: ${process.env.GEMMA_MODEL || 'gemma-2-9b-it'}`,
    );
    this.modelName = process.env.GEMMA_MODEL || 'gemma-2-9b-it';

    // Generation config for better responses
    this.generationConfig = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: {
        includeThoughts: false,
      },
      stopSequences: ['User input:', 'Context:', 'User:'],
    };

    // Max retry attempts for transient failures
    this.maxRetries = 5;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Determines if an error is transient and worth retrying.
   * Non-retryable: API key errors, bad request (400), auth errors (401/403).
   * Retryable: rate limits (429), server errors (5xx), network/timeout errors.
   * @param {Error} error
   * @returns {boolean}
   */
  _isRetryable(error) {
    const msg = error.message || '';
    // Never retry these
    if (
      msg.includes('API key') ||
      msg.includes('API_KEY_INVALID') ||
      msg.includes('API key not valid') ||
      msg.includes('400') ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('SAFETY') ||
      msg.includes('blocked')
    ) {
      return false;
    }
    // Retry these
    return true;
  }

  /**
   * Retry an async function with exponential backoff (up to maxRetries attempts).
   * @param {Function} fn - Async function to retry
   * @param {string} label - Descriptive label for logs
   * @returns {Promise<any>}
   */
  async _withRetry(fn, label = 'request') {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        const isRetryable = this._isRetryable(error);

        if (!isRetryable || attempt === this.maxRetries) {
          if (!isRetryable) {
            console.error(
              `❌ ${label} failed with non-retryable error: ${error.message}`,
            );
          } else {
            console.error(
              `❌ ${label} failed after ${this.maxRetries} attempts: ${error.message}`,
            );
          }
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s, 8s
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.warn(
          `⚠️ ${label} attempt ${attempt}/${this.maxRetries} failed. Retrying in ${delay}ms... (${error.message})`,
        );
        await this._sleep(delay);
      }
    }

    // Should never reach here, but safety net
    throw lastError;
  }

  /**
   * Send a prompt to Gemma and get the response
   * @param {string} prompt - The prompt to send
   * @param {Array<{role: 'user'|'model', parts: string}>} [conversationHistory] - Optional conversation history
   * @returns {Promise<string>}
   */
  async ask(prompt, conversationHistory = []) {
    return this._withRetry(async () => {
      console.log(`👺 Using Gemma model: ${this.modelName}`);
      console.log(`📝 Prompt length: ${prompt.length} characters`);

      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: this.generationConfig,
      });

      // Start chat with optional history
      const chat = model.startChat({
        history: conversationHistory,
        generationConfig: this.generationConfig,
      });

      // Send message and get response
      const result = await chat.sendMessage(prompt);
      const response = await result.response;
      const text = response.text();

      console.log(`✅ Gemma response received (${text.length} characters)`);
      return text;
    }, 'GemmaService.ask');
  }

  /**
   * Generate content without chat history (single-turn)
   * @param {string} prompt - The prompt to send
   * @returns {Promise<string>}
   */
  async generate(prompt) {
    try {
      console.log(`👺 Using Gemma model (single-turn): ${this.modelName}`);

      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: this.generationConfig,
      });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      console.log(`✅ Gemma response received (${text.length} characters)`);
      return text;
    } catch (error) {
      console.error('❌ Error in GemmaService.generate:', error.message);
      throw error;
    }
  }
}
