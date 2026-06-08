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
});

let isGenerating = false;
let currentPopup = null;
let scriptModule = null;
let extensionsModule = null;
let popupModule = null;

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

function formatTimeAway(lastActive) {
    if (!lastActive || typeof lastActive !== 'number') return '';
    const hours = (Date.now() - lastActive) / (1000 * 60 * 60);
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
        const { generateQuietPrompt, generateRaw } = scriptModule;
        if (typeof generateQuietPrompt === 'function') {
            const r = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, responseLength: s.maxTokens, removeReasoning: true });
            return r?.trim() || null;
        }
        if (typeof generateRaw === 'function') {
            const r = await generateRaw({ prompt, systemPrompt: 'You are a helpful assistant that summarizes roleplay conversations concisely.', responseLength: s.maxTokens });
            return r?.trim() || null;
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
        try { currentPopup.close(); } catch (_e) {}
        currentPopup = null;
    }
    const { POPUP_TYPE, Popup } = popupModule;
    const html = `
        <div class="chat-recap-container">
            <div class="recap-title">Where you left off</div>
            <hr class="recap-divider">
            ${timeAwayText ? `<div class="recap-time">Last seen ${escapeHtml(timeAwayText)}</div>` : ''}
            <div class="recap-body">${escapeHtml(summary).replace(/\n/g, '<br>')}</div>
            <button class="recap-close-button">Close Summary</button>
        </div>`;
    const popup = new Popup(html, POPUP_TYPE.DISPLAY, null, {
        wide: true,
        allowVerticalScrolling: true,
        animation: 'slow',
        onOpen: (dlg) => {
            const btn = dlg.content.querySelector('.recap-close-button');
            if (btn) btn.addEventListener('click', () => dlg.completeCancelled());
        },
    });
    currentPopup = popup;
    popup.show().then(() => { currentPopup = null; }).catch(e => { log('Popup error:', e); currentPopup = null; });
}

async function checkAndShowRecap() {
    try {
        if (isGenerating) { log('Already generating, skipping'); return; }
        const { getContext } = extensionsModule;
        const { getCurrentChatId } = scriptModule;
        const ctx = getContext();
        if (!ctx?.chat?.length) { log('Chat not loaded, skipping'); return; }
        const chatKey = getCurrentChatId?.() || null;
        if (!chatKey) { log('No chat key, skipping'); return; }

        if (!ctx.chat_metadata) ctx.chat_metadata = {};
        const recapData = ctx.chat_metadata[MODULE_NAME] || {};
        const lastActive = recapData.lastActive || 0;
        const now = Date.now();

        if (!lastActive) {
            log('First visit, setting baseline');
            ctx.chat_metadata[MODULE_NAME] = { ...recapData, lastActive: now };
            ctx.saveMetadataDebounced?.();
            return;
        }

        const s = getSettings();
        const hoursAway = (now - lastActive) / (1000 * 60 * 60);
        if (hoursAway < s.thresholdHours) {
            log(`${hoursAway.toFixed(1)}h < ${s.thresholdHours}h threshold, skipping`);
            ctx.chat_metadata[MODULE_NAME] = { ...recapData, lastActive: now };
            ctx.saveMetadataDebounced?.();
            return;
        }

        log(`${hoursAway.toFixed(1)}h >= ${s.thresholdHours}h, generating recap`);
        const history = buildChatHistory();
        if (!history.trim()) {
            log('No history available');
            ctx.chat_metadata[MODULE_NAME] = { ...recapData, lastActive: now };
            ctx.saveMetadataDebounced?.();
            return;
        }

        const summary = await generateRecap(history);
        if (getCurrentChatId?.() !== chatKey) { log('Chat changed, discarding'); return; }
        if (summary) await showRecap(summary, s.showTimeAway ? formatTimeAway(lastActive) : '');

        const newData = ctx.chat_metadata[MODULE_NAME] || {};
        ctx.chat_metadata[MODULE_NAME] = { ...newData, lastActive: now };
        ctx.saveMetadataDebounced?.();
    } catch (e) {
        log('Error in checkAndShowRecap:', e);
        isGenerating = false;
    }
}

function onChatChanged() {
    try {
        if (isGenerating) log('Generation aborted - chat changed');
        if (currentPopup) { try { currentPopup.close(); } catch (_e) {} currentPopup = null; }
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

    const thresholdInput = settingsEl.querySelector('#chatrecap_threshold');
    const tokensInput = settingsEl.querySelector('#chatrecap_max_tokens');
    const showTimeCheck = settingsEl.querySelector('#chatrecap_show_time');
    const templateArea = settingsEl.querySelector('#chatrecap_template');

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
}

export async function init() {
    log('Initializing v1.0.0');
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
