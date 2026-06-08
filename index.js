/**
 * ChatRecap Extension for SillyTavern
 *
 * Shows a dismissible "Where you left off" recap popup when returning to a chat
 * after a configurable time threshold. Uses the LLM to generate summaries.
 *
 * @author phampyk
 * @version 1.0.0
 */
(function() {
    'use strict';

    // ============================================================================
    // Constants
    // ============================================================================

    /** @constant {string} */
    const EXTENSION_NAME = 'ChatRecap';

    /** @constant {string} */
    const LOG_PREFIX = `[${EXTENSION_NAME}]`;

    /** @constant {number} Delay before triggering recap after chat change (ms) */
    const CHAT_CHANGE_DELAY_MS = 100;

    /** @constant {number} Delay for initial check when extension loads with chat already open (ms) */
    const INITIAL_CHECK_DELAY_MS = 500;

    /** @constant {number} Maximum messages to include in history to prevent enormous prompts */
    const MAX_HISTORY_MESSAGES = 2000;

    /** @constant {number} Polling interval when waiting for SillyTavern context (ms) */
    const CONTEXT_POLL_INTERVAL_MS = 100;

    /** @constant {number} Maximum polling attempts before giving up on context */
    const CONTEXT_MAX_ATTEMPTS = 100;

    /** @default {Object} Default extension settings */
    const defaultSettings = {
        thresholdHours: 24,
        maxTokens: 256,
        promptTemplate: 'Summarize what has happened in this conversation so far. Keep it brief but include key events, decisions, and emotional beats.\n\n{{messages}}',
        showTimeAway: true,
    };

    // ============================================================================
    // State
    // ============================================================================

    /** @type {boolean} Whether the extension has initialized */
    let initialized = false;

    /** @type {boolean} Whether a recap generation is currently in progress */
    let isGenerating = false;

    /** @type {import('popup.js').Popup|null} Currently open recap popup */
    let currentPopup = null;

    /** @type {Function|null} Stored event listener for cleanup */
    let chatChangedListener = null;

    // ============================================================================
    // Utilities
    // ============================================================================

    /**
     * Retrieve the SillyTavern extension context.
     * @returns {Object|null} The ST context or null if not available.
     */
    function getContext() {
        return window.SillyTavern?.getContext?.() ?? null;
    }

    /**
     * Log a prefixed message to the console.
     * @param {...*} args - Values to log.
     */
    function log(...args) {
        console.log(LOG_PREFIX, ...args);
    }

    /**
     * Get the current extension settings, merging with defaults if needed.
     * @returns {Object} Deep-cloned settings object.
     */
    function getSettings() {
        const ctx = getContext();
        if (!ctx) return structuredClone(defaultSettings);

        if (!ctx.extensionSettings[EXTENSION_NAME]) {
            ctx.extensionSettings[EXTENSION_NAME] = structuredClone(defaultSettings);
        }

        const settings = ctx.extensionSettings[EXTENSION_NAME];

        // Merge defaults for any missing keys (handles extension upgrades)
        for (const key of Object.keys(defaultSettings)) {
            if (settings[key] === undefined) {
                settings[key] = structuredClone(defaultSettings[key]);
            }
        }

        return settings;
    }

    /**
     * Persist extension settings to storage.
     */
    function saveSettings() {
        const ctx = getContext();
        if (ctx?.saveExtensionSettings) {
            ctx.saveExtensionSettings();
        }
    }

    /**
     * Escape HTML special characters to prevent XSS.
     * @param {string} text - Raw text.
     * @returns {string} HTML-escaped text.
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Get a unique identifier for the current chat.
     * @returns {string|null} Chat ID or null if unavailable.
     */
    function getCurrentChatKey() {
        const ctx = getContext();
        if (!ctx) return null;

        // Prefer ST's native getCurrentChatId which distinguishes multiple chats per character
        if (typeof ctx.getCurrentChatId === 'function') {
            return ctx.getCurrentChatId();
        }

        // Fallback for older ST versions
        if (ctx.groupId) {
            return `group_${ctx.groupId}`;
        }
        if (ctx.characterId !== undefined && ctx.characterId !== null) {
            return `char_${ctx.characterId}`;
        }

        return null;
    }

    /**
     * Format a timestamp into a human-readable "time ago" string.
     * @param {number} lastActive - Timestamp in milliseconds.
     * @returns {string} Formatted string like "3h ago" or empty string if invalid.
     */
    function formatTimeAway(lastActive) {
        if (!lastActive || typeof lastActive !== 'number') return '';

        const hoursAway = (Date.now() - lastActive) / (1000 * 60 * 60);

        if (hoursAway < 1) {
            const mins = Math.round(hoursAway * 60);
            return `${mins}m ago`;
        } else if (hoursAway < 24) {
            return `${Math.round(hoursAway)}h ago`;
        } else {
            const days = Math.round(hoursAway / 24);
            return `${days}d ago`;
        }
    }

    /**
     * Validate a number input for the threshold setting.
     * Rejects NaN, negative numbers, zero, and non-finite values.
     * @param {number} value - Raw input value.
     * @param {number} fallback - Value to return if invalid.
     * @returns {number} Validated number.
     */
    function validateThreshold(value, fallback) {
        if (!Number.isFinite(value) || value <= 0) {
            return fallback;
        }
        return value;
    }

    /**
     * Validate a number input for the max tokens setting.
     * Rejects NaN, negative numbers, zero, and non-finite values.
     * @param {number} value - Raw input value.
     * @param {number} fallback - Value to return if invalid.
     * @returns {number} Validated number.
     */
    function validateMaxTokens(value, fallback) {
        if (!Number.isFinite(value) || value <= 0) {
            return fallback;
        }
        return value;
    }

    // ============================================================================
    // Chat History
    // ============================================================================

    /**
     * Build a text representation of the chat history for the LLM prompt.
     * Filters system messages and caps at MAX_HISTORY_MESSAGES.
     * @returns {string} Formatted chat history or empty string.
     */
    function buildChatHistory() {
        const ctx = getContext();
        if (!ctx?.chat?.length) return '';

        // Filter out system messages
        const messages = ctx.chat.filter(msg => !msg.is_system);

        // Cap to prevent enormous prompts from very long chats
        const truncated = messages.length > MAX_HISTORY_MESSAGES
            ? messages.slice(-MAX_HISTORY_MESSAGES)
            : messages;

        const lines = truncated.map((msg) => {
            const name = msg.is_user ? (ctx.name1 || 'User') : (msg.name || 'Character');
            const text = msg.mes || '';
            return `${name}: ${text}`;
        });

        return lines.join('\n\n');
    }

    // ============================================================================
    // Recap Generation
    // ============================================================================

    /**
     * Generate a recap summary via the LLM.
     * @param {string} chatHistory - Formatted chat history text.
     * @returns {Promise<string|null>} Generated summary or null on failure.
     */
    async function generateRecap(chatHistory) {
        const settings = getSettings();
        const prompt = settings.promptTemplate.replace('{{messages}}', chatHistory);

        log('Generating recap...');
        isGenerating = true;

        try {
            // Prefer generateQuietPrompt - uses user's model and settings
            if (typeof window.generateQuietPrompt === 'function') {
                const result = await window.generateQuietPrompt({
                    quietPrompt: prompt,
                    quietToLoud: false,
                    skipWIAN: true,
                    responseLength: settings.maxTokens,
                    removeReasoning: true,
                });
                return result?.trim() || null;
            }

            // Fallback to generateRaw
            if (typeof window.generateRaw === 'function') {
                const result = await window.generateRaw({
                    prompt: prompt,
                    systemPrompt: 'You are a helpful assistant that summarizes roleplay conversations concisely.',
                    responseLength: settings.maxTokens,
                });
                return result?.trim() || null;
            }

            log('No generation API available');
            return null;

        } catch (error) {
            log('Generation failed:', error);
            return null;
        } finally {
            isGenerating = false;
        }
    }

    // ============================================================================
    // Popup Display
    // ============================================================================

    /**
     * Display the recap popup.
     * @param {string} summary - Generated summary text.
     * @param {string} timeAwayText - Formatted "time away" string.
     */
    async function showRecap(summary, timeAwayText) {
        const ctx = getContext();
        if (!ctx?.Popup) {
            log('Popup API not available');
            return;
        }

        // Close any existing popup
        if (currentPopup) {
            try {
                currentPopup.close();
            } catch (_e) {
                // Popup may already be closed; ignore.
            }
            currentPopup = null;
        }

        const titleText = 'Where you left off';
        const timeAwayLabel = timeAwayText ? `Last seen ${escapeHtml(timeAwayText)}` : '';
        const summaryHtml = escapeHtml(summary).replace(/\n/g, '<br>');

        const content = `
            <div class="chat-recap-container">
                <div class="recap-title">${titleText}</div>
                <hr class="recap-divider">
                ${timeAwayLabel ? `<div class="recap-time">${timeAwayLabel}</div>` : ''}
                <div class="recap-body">${summaryHtml}</div>
                <button class="recap-close-button">Close Summary</button>
            </div>
        `;

        const popup = new ctx.Popup(content, ctx.POPUP_TYPE.DISPLAY, null, {
            wide: true,
            allowVerticalScrolling: true,
            animation: 'slow',
            onOpen: (dlg) => {
                const closeBtn = dlg.content.querySelector('.recap-close-button');
                if (closeBtn) {
                    closeBtn.addEventListener('click', () => {
                        dlg.completeCancelled();
                    });
                }
            },
        });

        currentPopup = popup;

        popup.show().then(() => {
            currentPopup = null;
        }).catch((err) => {
            log('Popup show error:', err);
            currentPopup = null;
        });
    }

    // ============================================================================
    // Main Logic
    // ============================================================================

    /**
     * Check if recap should be shown and trigger generation/display.
     */
    async function checkAndShowRecap() {
        try {
            const settings = getSettings();

            // Prevent double-fire
            if (isGenerating) {
                log('Already generating, skipping');
                return;
            }

            const ctx = getContext();
            if (!ctx) return;

            // Wait for chat to be fully loaded
            if (!ctx.chat || !ctx.chat.length) {
                log('Chat not loaded yet, skipping');
                return;
            }

            const chatKey = getCurrentChatKey();
            if (!chatKey) {
                log('No chat key available, skipping');
                return;
            }

            // Ensure metadata object exists
            if (!ctx.chatMetadata) {
                ctx.chatMetadata = {};
            }

            // Get stored state
            const recapData = ctx.chatMetadata[EXTENSION_NAME] || {};
            const lastActive = recapData.lastActive || 0;
            const now = Date.now();

            // First visit: set baseline, don't show recap
            if (!lastActive) {
                log('First visit to chat, setting baseline');
                ctx.chatMetadata[EXTENSION_NAME] = { ...recapData, lastActive: now };
                ctx.saveMetadataDebounced();
                return;
            }

            const hoursAway = (now - lastActive) / (1000 * 60 * 60);

            // Below threshold: update timestamp, don't show recap
            if (hoursAway < settings.thresholdHours) {
                log(`Time away: ${hoursAway.toFixed(1)}h (below threshold ${settings.thresholdHours}h)`);
                ctx.chatMetadata[EXTENSION_NAME] = { ...recapData, lastActive: now };
                ctx.saveMetadataDebounced();
                return;
            }

            log(`Time away: ${hoursAway.toFixed(1)}h (above threshold ${settings.thresholdHours}h)`);

            // Build chat history
            const chatHistory = buildChatHistory();
            if (!chatHistory.trim()) {
                log('No chat history available');
                ctx.chatMetadata[EXTENSION_NAME] = { ...recapData, lastActive: now };
                ctx.saveMetadataDebounced();
                return;
            }

            // Generate recap
            const summary = await generateRecap(chatHistory);

            // Abort if user switched chats during generation
            if (getCurrentChatKey() !== chatKey) {
                log('Chat changed during generation, discarding result');
                return;
            }

            if (summary) {
                const timeAwayText = settings.showTimeAway ? formatTimeAway(lastActive) : '';
                await showRecap(summary, timeAwayText);
            }

            // Update lastActive regardless of success
            const newRecapData = ctx.chatMetadata[EXTENSION_NAME] || {};
            ctx.chatMetadata[EXTENSION_NAME] = { ...newRecapData, lastActive: now };
            ctx.saveMetadataDebounced();
        } catch (error) {
            log('Error in checkAndShowRecap:', error);
            isGenerating = false;
        }
    }

    // ============================================================================
    // Event Handlers
    // ============================================================================

    /**
     * Handle chat change events from SillyTavern.
     */
    function onChatChanged() {
        try {
            if (isGenerating) {
                log('Generation aborted - chat changed');
            }
            if (currentPopup) {
                try {
                    currentPopup.close();
                } catch (_e) {
                    // Already closed.
                }
                currentPopup = null;
            }
            isGenerating = false;

            // Delay to allow ST to finish loading chat metadata
            setTimeout(() => {
                checkAndShowRecap();
            }, CHAT_CHANGE_DELAY_MS);
        } catch (error) {
            log('Error in onChatChanged:', error);
            isGenerating = false;
        }
    }

    // ============================================================================
    // Settings UI
    // ============================================================================

    /**
     * Create the extension settings panel.
     * @returns {HTMLElement} Settings container element.
     */
    function createSettingsPanel() {
        const settings = getSettings();

        const container = document.createElement('div');
        container.className = 'chat-recap-settings';

        // Threshold hours
        const thresholdRow = createNumberInput(
            'Time Threshold (hours)',
            settings.thresholdHours,
            (value) => {
                settings.thresholdHours = validateThreshold(value, settings.thresholdHours);
                saveSettings();
            }
        );
        container.appendChild(thresholdRow);

        // Max tokens
        const tokensRow = createNumberInput(
            'Max Response Tokens',
            settings.maxTokens,
            (value) => {
                settings.maxTokens = validateMaxTokens(value, settings.maxTokens);
                saveSettings();
            }
        );
        container.appendChild(tokensRow);

        // Show time away
        const timeAwayRow = createToggle(
            'Show Time Away Label',
            settings.showTimeAway,
            (value) => {
                settings.showTimeAway = value;
                saveSettings();
            }
        );
        container.appendChild(timeAwayRow);

        // Prompt template
        const templateRow = createTextareaWithPopupEdit(
            'Prompt Template (use {{messages}} placeholder)',
            settings.promptTemplate,
            (value) => {
                settings.promptTemplate = value;
                saveSettings();
            }
        );
        container.appendChild(templateRow);

        return container;
    }

    /**
     * Create a toggle checkbox setting row.
     * @param {string} label - Label text.
     * @param {boolean} value - Initial checked state.
     * @param {function(boolean): void} onChange - Change callback.
     * @returns {HTMLElement} Row element.
     */
    function createToggle(label, value, onChange) {
        const row = document.createElement('div');
        row.className = 'chat-recap-setting-row';

        const labelEl = document.createElement('label');
        labelEl.textContent = label;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = value;
        checkbox.addEventListener('change', () => onChange(checkbox.checked));

        row.appendChild(labelEl);
        row.appendChild(checkbox);
        return row;
    }

    /**
     * Create a number input setting row.
     * @param {string} label - Label text.
     * @param {number} value - Initial value.
     * @param {function(number): void} onChange - Change callback.
     * @returns {HTMLElement} Row element.
     */
    function createNumberInput(label, value, onChange) {
        const row = document.createElement('div');
        row.className = 'chat-recap-setting-row';

        const labelEl = document.createElement('label');
        labelEl.textContent = label;

        const input = document.createElement('input');
        input.type = 'number';
        input.value = value;
        input.addEventListener('change', () => {
            const val = parseFloat(input.value);
            onChange(Number.isNaN(val) ? value : val);
        });

        row.appendChild(labelEl);
        row.appendChild(input);
        return row;
    }

    /**
     * Create a textarea with SillyTavern's native maximize button.
     * @param {string} label - Label text.
     * @param {string} value - Initial textarea content.
     * @param {function(string): void} onChange - Blur callback.
     * @returns {HTMLElement} Row element.
     */
    function createTextareaWithPopupEdit(label, value, onChange) {
        const row = document.createElement('div');
        row.className = 'chat-recap-setting-row';

        const labelEl = document.createElement('label');
        labelEl.textContent = label;

        const wrapper = document.createElement('div');
        wrapper.classList.add('flex-container', 'alignitemscenter', 'wide100p');

        const textareaId = `chatrecap-template-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const textarea = document.createElement('textarea');
        textarea.id = textareaId;
        textarea.value = value;
        textarea.rows = 4;
        textarea.classList.add('text_pole', 'textarea_compact', 'wide100p');
        textarea.style.resize = 'vertical';
        textarea.addEventListener('blur', () => {
            onChange(textarea.value);
        });

        const maximizeBtn = document.createElement('div');
        maximizeBtn.classList.add('editor_maximize', 'fa-solid', 'fa-maximize');
        maximizeBtn.setAttribute('data-for', textareaId);
        maximizeBtn.title = 'Maximize';
        maximizeBtn.style.marginLeft = '5px';
        maximizeBtn.style.cursor = 'pointer';
        maximizeBtn.style.color = 'var(--SmartThemeBodyColor)';

        wrapper.appendChild(textarea);
        wrapper.appendChild(maximizeBtn);

        row.appendChild(labelEl);
        row.appendChild(wrapper);
        return row;
    }

    // ============================================================================
    // Initialization & Cleanup
    // ============================================================================

    /**
     * Initialize the extension.
     */
    function initialize() {
        if (initialized) return;

        const ctx = getContext();
        if (!ctx) {
            console.error(LOG_PREFIX, 'Failed to initialize - context not available');
            return;
        }

        // Register settings UI
        if (typeof ctx.registerExtensionSettings === 'function') {
            const settingsPanel = createSettingsPanel();
            ctx.registerExtensionSettings(EXTENSION_NAME, settingsPanel);
        }

        // Attach event listeners
        if (ctx.eventSource && ctx.eventTypes) {
            chatChangedListener = onChatChanged;
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, chatChangedListener);
            log('Event listener attached: CHAT_CHANGED');
        }

        // Safety: chat already loaded when extension initializes
        const currentChatId = getCurrentChatKey();
        if (currentChatId && ctx.chat && ctx.chat.length > 0) {
            log('Chat already loaded, triggering initial check');
            setTimeout(() => {
                checkAndShowRecap();
            }, INITIAL_CHECK_DELAY_MS);
        }

        initialized = true;
        log('Initialized v1.0.0');
    }

    /**
     * Wait for SillyTavern context to become available, then initialize.
     */
    function waitForContext() {
        let attempts = 0;

        const intervalId = setInterval(() => {
            attempts++;
            const ctx = getContext();

            if (ctx) {
                clearInterval(intervalId);
                initialize();
            } else if (attempts >= CONTEXT_MAX_ATTEMPTS) {
                clearInterval(intervalId);
                console.error(LOG_PREFIX, 'Failed to initialize - SillyTavern context not found');
            }
        }, CONTEXT_POLL_INTERVAL_MS);
    }

    // ============================================================================
    // Entry Point
    // ============================================================================

    if (typeof jQuery !== 'undefined') {
        jQuery(waitForContext);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForContext);
    } else {
        waitForContext();
    }
})();
