const LOG_PREFIX = '[ChatRecap]';
const MODULE_NAME = 'ChatRecap';
const CHAT_CHANGE_DELAY_MS = 100;
const INITIAL_CHECK_DELAY_MS = 500;
const MAX_HISTORY_MESSAGES = 2000;

const defaultSettings = Object.freeze({
    thresholdHours: 24,
    maxTokens: 256,
    promptTemplate: 'Summarize what has happened in this conversation so far. Keep it brief but include key events, decisions, and emotional beats.\n\n{{messages}}',
    showTimeAway: true,
    connectionProfile: '',
});

let isGenerating = false;
let currentPopup = null;
let scriptModule = null;
let extensionsModule = null;
let popupModule = null;
let connectionManagerService = null;

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

async function loadModule(paths) {
    for (const path of paths) {
        try {
            return await import(path);
        } catch (e) {
            continue;
        }
    }
    throw new Error(`Failed to load module from any path: ${paths.join(', ')}`);
}

async function initModules() {
    scriptModule = await loadModule(['../../../script.js', '../../../../script.js']);
    extensionsModule = await loadModule(['../../extensions.js', '../../../extensions.js']);
    popupModule = await loadModule(['../../popup.js', '../../../popup.js']);
    try {
        const sharedModule = await loadModule(['../shared.js', '../../shared.js']);
        connectionManagerService = sharedModule?.ConnectionManagerRequestService || null;
        log('ConnectionManagerRequestService loaded:', !!connectionManagerService);
    } catch (e) {
        log('ConnectionManagerRequestService not available:', e.message);
        connectionManagerService = null;
    }
}

function getSettings() {
    const { extension_settings } = extensionsModule;
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    return s;
}

function saveSettings() {
    const { saveSettingsDebounced } = scriptModule;
    saveSettingsDebounced();
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function getLastMessageTime(ctx) {
    if (!ctx.chat?.length) return null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const msg = ctx.chat[i];
        if (msg.is_system) continue;
        if (msg.send_date) {
            const ts = new Date(msg.send_date).getTime();
            if (!isNaN(ts)) return ts;
        }
    }
    return null;
}

function formatTimeAway(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') return '';
    const hours = (Date.now() - timestamp) / (1000 * 60 * 60);
    if (hours < 1) return `${Math.round(hours * 60)}m ago`;
    if (hours < 24) return `${Math.round(hours)}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function buildChatHistory() {
    const { getContext } = extensionsModule;
    const ctx = getContext();
    if (!ctx?.chat?.length) return '';
    const msgs = ctx.chat.filter(m => !m.is_system);
    const slice = msgs.length > MAX_HISTORY_MESSAGES ? msgs.slice(-MAX_HISTORY_MESSAGES) : msgs;
    return slice.map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'Character')}: ${m.mes || ''}`).join('\n\n');
}

async function generateRecap(history) {
    const s = getSettings();
    const prompt = s.promptTemplate.replace('{{messages}}', history);
    isGenerating = true;
    try {
        // If user selected a connection profile, use ConnectionManagerRequestService
        if (s.connectionProfile && connectionManagerService) {
            log('Using connection profile:', s.connectionProfile);
            const messages = [
                { role: 'system', content: 'Summarize this roleplay conversation concisely, focusing on key events, character development, and emotional moments. Write 3-5 paragraphs in an engaging narrative style.' },
                { role: 'user', content: prompt }
            ];
            const response = await connectionManagerService.sendRequest(
                s.connectionProfile,
                messages,
                s.maxTokens,
                { extractData: true, stream: false }
            );
            log('ConnectionManager response type:', typeof response, '| has content:', !!response?.content, '| has reasoning:', !!response?.reasoning);
            // Handle both standard LLMs (content field) and reasoning models (reasoning field)
            const content = response?.content || '';
            const reasoning = response?.reasoning || '';
            const result = content?.trim() || reasoning?.trim() || null;
            log('Content length:', content?.length || 0, '| Reasoning length:', reasoning?.length || 0, '| Final:', result === null ? 'null' : result.length + ' chars');
            return result;
        }

        // Fallback to generateRawData if no profile selected
        const { generateRawData } = scriptModule;
        if (typeof generateRawData === 'function') {
            log('No profile selected, using generateRawData with', prompt.length, 'chars');
            const data = await generateRawData({ prompt, systemPrompt: 'Summarize this roleplay conversation concisely, focusing on key events, character development, and emotional moments. Write 3-5 paragraphs in an engaging narrative style.', responseLength: s.maxTokens, quietToLoud: false });
            log('generateRawData raw response type:', typeof data, '| isArray:', Array.isArray(data), '| keys:', data && typeof data === 'object' ? Object.keys(data).join(',') : 'N/A');
            // Handle both standard LLMs (content field) and reasoning models (reasoning field)
            const content = data?.content || '';
            const reasoning = data?.reasoning || '';
            const result = content?.trim() || reasoning?.trim() || null;
            log('Content length:', content?.length || 0, '| Reasoning length:', reasoning?.length || 0, '| Final:', result === null ? 'null' : result.length + ' chars');
            return result;
        }

        log('No generation API available');
        return null;
    } catch (e) {
        log('Generation failed:', e);
        return null;
    } finally {
        isGenerating = false;
    }
}

async function showRecap(summary, timeAwayText) {
    if (currentPopup) {
        try { currentPopup.completeCancelled(); } catch (_e) {}
        currentPopup = null;
    }
    const { POPUP_TYPE, Popup } = popupModule;
    const html = `
        <div class="chat-recap-container">
            <h1 class="recap-title">Where you left off</h1>
            <hr class="recap-divider">
            ${timeAwayText ? `<div class="recap-time">Last seen ${escapeHtml(timeAwayText)}</div>` : ''}
            <div class="recap-body">${escapeHtml(summary).replace(/\n/g, '<br>')}</div>
            <button class="recap-close-button menu_button">Close Summary</button>
        </div>`;
    const popup = new Popup(html, POPUP_TYPE.DISPLAY, null, {
        wide: true,
        allowVerticalScrolling: true,
        animation: 'slow',
        onOpen: (dlg) => {
            // Hide the default X close button since we have our own
            const xBtn = dlg.dlg?.querySelector('.popup-button-close');
            if (xBtn) xBtn.style.display = 'none';
            
            const btn = dlg.content.querySelector('.recap-close-button');
            if (btn) btn.addEventListener('click', () => dlg.completeCancelled());
        },
    });
    currentPopup = popup;
    popup.show().then(() => { currentPopup = null; }).catch(e => { log('Popup error:', e); currentPopup = null; });
}

async function checkAndShowRecap(force = false) {
    try {
        if (isGenerating) { log('Already generating, skipping'); return; }
        const { getContext } = extensionsModule;
        const { getCurrentChatId } = scriptModule;
        const ctx = getContext();
        if (!ctx?.chat?.length) { log('Chat not loaded, skipping'); return; }
        const chatKey = getCurrentChatId?.() || null;
        if (!chatKey) { log('No chat key, skipping'); return; }

        const lastMessageTime = getLastMessageTime(ctx);

        const now = Date.now();

        const s = getSettings();

        // If no messages yet, skip
        if (!lastMessageTime && !force) {
            log('No messages yet, skipping');
            return;
        }

        // Calculate time since last message
        const hoursSinceMessage = lastMessageTime ? (now - lastMessageTime) / (1000 * 60 * 60) : Infinity;

        // Skip if not enough time has passed since last message
        if (!force && hoursSinceMessage < s.thresholdHours) {
            log(`${hoursSinceMessage.toFixed(1)}h since last message < ${s.thresholdHours}h threshold, skipping`);
            return;
        }

        log(force ? 'Forced recap generation' : `${hoursSinceMessage.toFixed(1)}h since last message, generating recap`);
        const history = buildChatHistory();
        log('History length:', history.length, 'chars');
        if (!history.trim()) {
            log('No history available');
            return;
        }

        const summary = await generateRecap(history);
        if (getCurrentChatId?.() !== chatKey) { log('Chat changed, discarding'); return; }
        if (summary) {
            log('Got summary, showing popup');
            await showRecap(summary, s.showTimeAway ? formatTimeAway(lastMessageTime) : '');
        } else {
            log('No summary returned from LLM');
        }

    } catch (e) {
        log('Error in checkAndShowRecap:', e);
        isGenerating = false;
    }
}

function onChatChanged() {
    try {
        if (isGenerating) log('Generation aborted - chat changed');
        if (currentPopup) { try { currentPopup.completeCancelled(); } catch (_e) {} currentPopup = null; }
        isGenerating = false;
        setTimeout(() => checkAndShowRecap(), CHAT_CHANGE_DELAY_MS);
    } catch (e) {
        log('Error in onChatChanged:', e);
        isGenerating = false;
    }
}

function initSettings() {
    const container = document.querySelector('#extensions_settings');
    if (!container) { log('Settings container not found'); return; }

    const s = getSettings();

    const html = `
        <div id="chatrecap_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <div class="flex-container alignitemscenter margin0">
                        <b>Chat Recap</b>
                    </div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="chat-recap-settings">
                        <div class="chat-recap-setting-row" style="margin-bottom:10px;">
                            <button id="chatrecap_test" class="menu_button">Test Recap Now</button>
                        </div>
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_connection_profile">Connection Profile</label>
                            <select id="chatrecap_connection_profile" class="text_pole">
                                <option value="">Use Default Connection</option>
                            </select>
                        </div>
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_threshold">Time Threshold (hours)</label>
                            <input id="chatrecap_threshold" type="number" class="text_pole" min="0" step="1" value="${s.thresholdHours}">
                        </div>
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_max_tokens">Max Response Tokens</label>
                            <input id="chatrecap_max_tokens" type="number" class="text_pole" min="1" step="1" value="${s.maxTokens}">
                        </div>
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_show_time">
                                <input id="chatrecap_show_time" type="checkbox" ${s.showTimeAway ? 'checked' : ''}>
                                Show Time Away Label
                            </label>
                        </div>
                        <div class="chat-recap-setting-row">
                            <label>Prompt Template (use {{messages}} placeholder)</label>
                            <div class="flex-container alignitemscenter wide100p">
                                <textarea id="chatrecap_template" class="text_pole textarea_compact wide100p" rows="4">${s.promptTemplate}</textarea>
                                <div class="editor_maximize fa-solid fa-maximize" data-for="chatrecap_template" title="Maximize"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const settingsEl = tempDiv.firstElementChild;
    container.appendChild(settingsEl);

    const testBtn = settingsEl.querySelector('#chatrecap_test');
    const profileSelect = settingsEl.querySelector('#chatrecap_connection_profile');
    const thresholdInput = settingsEl.querySelector('#chatrecap_threshold');
    const tokensInput = settingsEl.querySelector('#chatrecap_max_tokens');
    const showTimeCheck = settingsEl.querySelector('#chatrecap_show_time');
    const templateArea = settingsEl.querySelector('#chatrecap_template');

    if (testBtn) {
        testBtn.addEventListener('click', () => {
            log('Manual test triggered');
            checkAndShowRecap(true);
        });
    }

    if (profileSelect && connectionManagerService) {
        try {
            connectionManagerService.handleDropdown(
                '#chatrecap_connection_profile',
                s.connectionProfile,
                (profile) => {
                    s.connectionProfile = profile?.id || '';
                    saveSettings();
                    log('Selected profile:', s.connectionProfile || '(default)');
                }
            );
        } catch (e) {
            log('Failed to initialize profile dropdown:', e.message);
        }
    }

    if (thresholdInput) {
        thresholdInput.addEventListener('change', () => {
            const val = parseFloat(thresholdInput.value);
            s.thresholdHours = Number.isFinite(val) && val > 0 ? val : s.thresholdHours;
            saveSettings();
        });
    }
    if (tokensInput) {
        tokensInput.addEventListener('change', () => {
            const val = parseInt(tokensInput.value, 10);
            s.maxTokens = Number.isFinite(val) && val > 0 ? val : s.maxTokens;
            saveSettings();
        });
    }
    if (showTimeCheck) {
        showTimeCheck.addEventListener('change', () => {
            s.showTimeAway = showTimeCheck.checked;
            saveSettings();
        });
    }
    if (templateArea) {
        templateArea.addEventListener('blur', () => {
            s.promptTemplate = templateArea.value;
            saveSettings();
        });
    }

    log('Settings UI initialized');

    // Expose debug helper
    window.chatRecapDebug = async function() {
        const { getContext } = extensionsModule;
        const s = getSettings();
        log('=== DEBUG ===');
        log('Settings:', JSON.stringify(s));
        log('Chat length:', getContext()?.chat?.length || 0);
        log('Last message time:', getLastMessageTime(getContext()));
        log('=============');
    };
}

export async function init() {
    log('Initializing v1.3.1');
    await initModules();
    initSettings();
    const { eventSource, event_types } = scriptModule;
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    log('Event listener attached: CHAT_CHANGED');
    const { getContext } = extensionsModule;
    const { getCurrentChatId } = scriptModule;
    const ctx = getContext();
    if (ctx?.chat?.length && getCurrentChatId?.()) {
        log('Chat already loaded, triggering initial check');
        setTimeout(() => checkAndShowRecap(), INITIAL_CHECK_DELAY_MS);
    }
}
