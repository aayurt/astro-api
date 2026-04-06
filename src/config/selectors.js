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

  // Google Consent Screen
  consent_accept_all: 'button[aria-label="Accept all"]',
  consent_accept_all_alt: 'button:has-text("Accept all")',
  stay_signed_out: 'button:has-text("Stay signed out")',
  maybe_later: 'button:has-text("Maybe later")',
};
