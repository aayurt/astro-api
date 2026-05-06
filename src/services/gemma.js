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
  }

  /**
   * Send a prompt to Gemma and get the response
   * @param {string} prompt - The prompt to send
   * @param {Array<{role: 'user'|'model', parts: string}>} [conversationHistory] - Optional conversation history
   * @returns {Promise<string>}
   */
  async ask(prompt, conversationHistory = []) {
    try {
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
    } catch (error) {
      console.error('❌ Error in GemmaService.ask:', error.message);

      // Provide more detailed error information
      if (error.message.includes('API key')) {
        console.error(
          '🔑 API Key issue: Check if GOOGLE_AI_API_KEY is set correctly',
        );
      } else if (error.message.includes('429')) {
        console.error(
          '⏱️ Rate limit exceeded. Please wait before trying again.',
        );
      } else if (error.message.includes('400')) {
        console.error('📝 Bad request: Check prompt format and length');
      }

      throw error;
    }
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
