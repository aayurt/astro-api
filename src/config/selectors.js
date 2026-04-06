export const GEMINI_SELECTORS = {
  // Input area
  prompt_input: 'div[contenteditable="true"]',

  // Send button
  send_button: 'button[aria-label="Send message"]',

  // Latest response container
  // Gemini responses are often in a list, we want the last one
  response_container: 'message-content',

  // Alternative response selectors
  response_text: '.markdown-content',

  // Check for "Gemini is thinking" or "generating"
  generating_indicator: '.generating',

  // Wait for this to know it's done
  done_indicator: 'button[aria-label="Copy"]', // Copy button appears when done
};
