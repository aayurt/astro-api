import { GoogleGenerativeAI } from '@google/generative-ai';

const MODELS = [
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Gemma AI Service using Google's Generative AI SDK
 * Randomises across Gemma 4 models with automatic fallback.
 */
export class GemmaService {
  constructor() {
    const apiKey = process.env.GOOGLE_AI_API_KEY;

    if (!apiKey) {
      console.warn('⚠️  GOOGLE_AI_API_KEY not found. Gemma service may not work properly.');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);

    this.generationConfig = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { includeThoughts: false },
      stopSequences: ['User input:', 'Context:', 'User:'],
    };
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _tryModels(prompt, conversationHistory = []) {
    const modelOrder = shuffle(MODELS);
    console.log(`🎲 Model order: ${modelOrder.join(' → ')}`);

    let lastError;
    for (const modelName of modelOrder) {
      try {
        console.log(`👺 Trying model: ${modelName}`);
        const model = this.genAI.getGenerativeModel({
          model: modelName,
          generationConfig: this.generationConfig,
        });
        const chat = model.startChat({
          history: conversationHistory,
          generationConfig: this.generationConfig,
        });
        const result = await chat.sendMessage(prompt);
        const response = await result.response;
        const text = response.text();
        console.log(`✅ Model ${modelName} succeeded (${text.length} chars)`);
        return text;
      } catch (error) {
        lastError = error;
        console.warn(`⚠️  Model ${modelName} failed: ${error.message}`);
      }
    }
    throw lastError || new Error('All models exhausted');
  }

  async ask(prompt, conversationHistory = []) {
    console.log(`📝 Prompt length: ${prompt.length} characters`);
    return this._tryModels(prompt, conversationHistory);
  }

  async generate(prompt) {
    console.log(`📝 Prompt length: ${prompt.length} characters`);

    const modelOrder = shuffle(MODELS);
    let lastError;
    for (const modelName of modelOrder) {
      try {
        console.log(`👺 Trying model (single-turn): ${modelName}`);
        const model = this.genAI.getGenerativeModel({
          model: modelName,
          generationConfig: this.generationConfig,
        });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log(`✅ Model ${modelName} succeeded (${text.length} chars)`);
        return text;
      } catch (error) {
        lastError = error;
        console.warn(`⚠️  Model ${modelName} failed: ${error.message}`);
      }
    }
    throw lastError || new Error('All models exhausted');
  }
}
