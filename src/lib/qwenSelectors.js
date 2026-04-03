/**
 * SELECTORS
 * Centralized selectors for easy maintenance and visibility.
 */
export default {
  // Main input area for the chat prompt
  INPUT_TEXTAREA: '.message-input-textarea',
  // Send button to trigger prompt submission
  SEND_BUTTON: '.omni-button-content-btn',
  // Container for assistant action controls (Copy, Read, Regenerate)
  ACTION_BAR: '.qwen-chat-package-comp-new-action-control-container',
  // Specific Copy Button container within the action bar
  COPY_BUTTON: '.qwen-chat-package-comp-new-action-control-container-copy',
  // Modal buttons to handle various popups
  MODALS: [
    'button:has-text("Stay logged out")',
    'button:has-text("Maybe later")',
    'button:has-text("Got it")',
    '.guidance-pc-close-btn',
  ],
  // The markdown content area for the response
  MARKDOWN_TEXT: '.qwen-markdown-text',
  // Stop button exists ONLY during generation
  STOP_BUTTON: '.stop-button',
  // Send button changes class after the first interaction
  SEND_BUTTON_ALT: '.send-button',
  // Specific icons container that appears on completion
  ACTION_ICONS: '.qwen-chat-package-comp-new-action-control-icons',
  // "Stay logged out" button in the welcome modal
  STAY_LOGGED_OUT: '.qwen-chat-btn.link.round.large',
};
