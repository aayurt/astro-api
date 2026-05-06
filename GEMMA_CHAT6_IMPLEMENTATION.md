# Gemma AI Chat Implementation (API: /api/ai/chat6)

## Overview

This document describes the implementation of the new `/api/ai/chat6` endpoint that uses Google's Gemma 4 31B model for astrology consultations.

## Implementation Details

### 1. New Gemma Service (`src/services/gemma.js`)

Created a new service that uses Google's Generative AI SDK:

```javascript
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GemmaService {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);
    this.modelName = process.env.GEMMA_MODEL || 'gemma-2-9b-it';
    this.generationConfig = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
    };
  }

  async ask(prompt, conversationHistory = []) {
    // Chat with optional history
  }

  async generate(prompt) {
    // Single-turn generation
  }
}
```

### 2. New Endpoint (`/api/ai/chat6`)

The endpoint follows the same pattern as `/api/ai/chat5`:

- **Authentication**: Requires user session (via `getUser` middleware)
- **Coin System**: Deducts 1 coin per request
- **Conversation**: Supports persistent conversations with history
- **Astrology Data**: Integrates user's birth chart data
- **Response Format**: HTML output (same as chat5)
- **Model**: Uses Gemma 4 31B via Google AI Studio

### 3. Key Features

- ✅ Uses Master Prompt V5 template
- ✅ HTML response format
- ✅ Conversation persistence in database
- ✅ Memory/context from previous messages
- ✅ Astrology data integration (natal, dashas, transits)
- ✅ Error handling with fallback response
- ✅ Markdown cleanup (removes ```html backticks)

## Configuration

### Environment Variables

Add to your `.env` file:

```env
GOOGLE_AI_API_KEY=your_ai_studio_key_here
GEMMA_MODEL=gemma-2-9b-it  # Optional: specify a different Gemma model
```

### Dependencies

```bash
npm install @google/generative-ai
```

## API Usage

### Request

```http
POST /api/ai/chat6
Content-Type: application/json
Authorization: Bearer <session_token>

{
  "message": "What does my chart say about my career?",
  "conversationId": "optional-conversation-id"
}
```

### Response

```json
{
  "response": "<div class='reading'>...</div>",
  "coinsLeft": 5,
  "conversationId": "conversation-id"
}
```

## Differences from Other Chat Endpoints

| Endpoint        | Model                 | Format   | Notes                 |
| --------------- | --------------------- | -------- | --------------------- |
| `/api/ai/chat`  | Qwen                  | Text     | Multi-step processing |
| `/api/ai/chat2` | Gemini (browser)      | Text     | Single-pass           |
| `/api/ai/chat5` | Gemini (browser)      | HTML     | Single-pass           |
| `/api/ai/chat6` | **Gemma 4 31B (API)** | **HTML** | **New!**              |

## Testing

1. Ensure `GOOGLE_AI_API_KEY` is set in your `.env`
2. Start the backend server
3. Make a POST request to `/api/ai/chat6` with a valid session
4. Verify the response contains HTML-formatted astrology reading

## Troubleshooting

### API Key Issues

- Verify your AI Studio API key is correct
- Check that the key has permission to use the Gemma model

### Model Not Found

- The default model is `gemma-2-9b-it`
- Set `GEMMA_MODEL` env variable to use a different model
- Check Google AI Studio for available models

### Rate Limits

- Google AI Studio has rate limits
- Implement retry logic if needed
- Consider upgrading your API plan for higher limits

## Files Modified/Created

1. **Created**: `astro-backend/src/services/gemma.js` - Gemma AI service
2. **Modified**: `astro-backend/src/index.js` - Added `/api/ai/chat6` endpoint
3. **Created**: `astro-backend/GEMMA_CHAT6_IMPLEMENTATION.md` - This documentation

## Future Enhancements

- [ ] Add conversation persistence specific to Gemma (like qwenChatId)
- [ ] Implement streaming responses for better UX
- [ ] Add model selection via API parameter
- [ ] Implement response caching for common queries
- [ ] Add usage analytics and cost tracking
