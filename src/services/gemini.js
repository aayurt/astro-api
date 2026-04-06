import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';
import { GEMINI_SELECTORS } from '../config/selectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

chromium.use(stealthPlugin());

/**
 * Interact with Gemini web interface using Playwright
 */
export class GeminiWebService {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.authPath = path.join(__dirname, '../../auth_states/gemini_auth.json');
  }

  /**
   * Initialize the Gemini session using saved auth state
   */
  async init() {
    console.log('🚀 Initializing Gemini Web Service...');
    const headless = process.env.BROWSER_HEADLESS === 'true';

    console.log(`  - Browser mode: ${headless ? 'Headless' : 'Headed'}`);
    this.browser = await chromium.launch({
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // Try to load auth state
    try {
      console.log(`  - Loading session from: ${this.authPath}`);
      this.context = await this.browser.newContext({
        storageState: this.authPath,
        viewport: { width: 1280, height: 720 },
      });
    } catch (error) {
      console.warn(
        "⚠️  Auth state not found. Please run 'npm run auth' first.",
      );
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
    }

    this.page = await this.context.newPage();
    console.log('  - Navigating to Gemini App...');
    await this.page.goto('https://gemini.google.com/app');

    // Check if we are logged in
    const isLoggedIn = await this.page.isVisible(GEMINI_SELECTORS.prompt_input);
    if (!isLoggedIn) {
      console.error(
        "❌  Not logged in. Please run 'npm run auth' to set up authentication.",
      );
      throw new Error('Authentication required');
    }
    console.log('✅  Gemini session initialized successfully.');
  }

  /**
   * Send a prompt to Gemini and get the response
   * @param {string} prompt
   * @returns {Promise<string>}
   */
  async ask(prompt) {
    if (!this.page) await this.init();

    console.log(
      `💬  Sending prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
    );

    await this.page.fill(GEMINI_SELECTORS.prompt_input, prompt);
    await this.page.keyboard.press('Enter');

    // Wait for the response to start generating
    // We'll wait for the "Copy" button to appear, which usually indicates it's finished
    console.log('⏳  Waiting for Gemini to finish generating...');

    try {
      // Wait for the copy button to appear (indicating response is complete)
      await this.page.waitForSelector(GEMINI_SELECTORS.done_indicator, {
        timeout: 60000,
      });

      // Small delay to ensure text is rendered
      await this.page.waitForTimeout(1000);

      // Get all message-content elements
      const responses = await this.page.$$(GEMINI_SELECTORS.response_container);
      const lastResponse = responses[responses.length - 1];

      if (!lastResponse) {
        throw new Error(
          'No response found with selector: ' +
            GEMINI_SELECTORS.response_container,
        );
      }

      const responseText = await lastResponse.innerText();
      console.log(`✅  Response received (${responseText.length} characters)`);
      return responseText;
    } catch (error) {
      console.error('❌  Error waiting for Gemini response:', error);
      return 'Error: Could not get response from Gemini web interface.';
    }
  }

  async close() {
    if (this.browser) {
      console.log('🔌  Closing Gemini browser session...');
      await this.browser.close();
      console.log('👋  Gemini session closed.');
    }
  }
}

/**
 * Convenience function to analyze content using the web service
 * @param {string} pageContent
 * @param {string} task
 */
export async function analyzePage(pageContent, task) {
  const gemini = new GeminiWebService();
  try {
    await gemini.init();
    const prompt = `
      Analyze the following web page content and perform the requested task.
      
      Task: ${task}
      
      Page Content:
      ${pageContent.substring(0, 30000)}
    `;
    return await gemini.ask(prompt);
  } finally {
    // await gemini.close();
  }
}
