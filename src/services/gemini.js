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
    await this.page.goto('https://gemini.google.com/app', {
      timeout: 60000,
      waitUntil: 'domcontentloaded',
    });
    console.log('  - Navigated to Gemini App successfully.');
    // Check if we are logged in
    try {
      await this.page.waitForSelector(GEMINI_SELECTORS.prompt_input, {
        timeout: 10000,
      });
      console.log('✅  Gemini session initialized successfully.');
    } catch (error) {
      console.error(
        "❌  Not logged in or input not found. Please run 'npm run auth' to set up authentication.",
      );
      // Take a screenshot for debugging if possible
      try {
        await this.page.screenshot({ path: 'gemini-init-error.png' });
        console.log('📸  Screenshot saved to gemini-init-error.png');
      } catch (e) {}
      throw new Error('Authentication required or UI changed');
    }
  }

  /**
   * Send a prompt to Gemini and get the response
   * @param {string} prompt
   * @param {number} retryCount
   * @returns {Promise<string>}
   */
  async ask(prompt, retryCount = 0) {
    try {
      if (!this.page) await this.init();

      // Check if we are still on the app page
      const url = this.page.url();
      if (!url.includes('gemini.google.com/app')) {
        console.log('🔄  Not on Gemini app page, re-navigating...');
        await this.page.goto('https://gemini.google.com/app', {
          waitUntil: 'networkidle',
        });
      }

      console.log(
        `💬  Sending prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
      );

      // Wait for input to be ready
      await this.page.waitForSelector(GEMINI_SELECTORS.prompt_input, {
        timeout: 30000,
      });

      // Clear existing text if any and type new prompt
      await this.page.click(GEMINI_SELECTORS.prompt_input);
      await this.page.fill(GEMINI_SELECTORS.prompt_input, prompt);
      await this.page.keyboard.press('Enter');

      // Wait for the response to start generating
      console.log('⏳  Waiting for Gemini to finish generating...');

      // Wait for the copy button to appear (indicating response is complete)
      await this.page.waitForSelector(GEMINI_SELECTORS.done_indicator, {
        timeout: 90000, // Increased timeout for long readings
      });

      // Small delay to ensure text is rendered
      await this.page.waitForTimeout(2000);

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
      console.error(
        `❌  Error in GeminiWebService.ask (Retry: ${retryCount}):`,
        error.message,
      );

      if (retryCount < 1) {
        console.log('🔄  Retrying with re-initialization...');
        if (this.browser) await this.browser.close();
        this.page = null;
        this.browser = null;
        return this.ask(prompt, retryCount + 1);
      }

      // Final failure
      try {
        if (this.page)
          await this.page.screenshot({ path: 'gemini-ask-error.png' });
      } catch (e) {}

      return 'Error: Could not get response from Gemini web interface. Please check server logs.';
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
