/**
 * Media Companion — Spoiler-Free Context Injector
 * Lets Caleb experience shows, games, and stories WITH Lei in real time
 * without spoiling future events.
 *
 * By Lei
 */

import { eventSource, event_types, extension_prompt_types, setExtensionPrompt, generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

// Extension prompt roles (fallback if not exported from script.js)
const extension_prompt_roles = {
    SYSTEM: 'system',
    USER: 'user',
    ASSISTANT: 'assistant'
};

const EXT_ID = 'caleb-media-companion';
const PROMPT_ID = 'caleb_media_companion';
const STORAGE_KEY = 'media_companion_settings';
const CHAT_META_KEY = 'media_companion';

// =============================================================================
// Default Settings
// =============================================================================

const PROVIDER_PRESETS = {
    openrouter: {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        models: 'moonshotai/kimi-k2, google/gemini-2.0-flash-exp, anthropic/claude-3.5-haiku',
        hint: 'OpenRouter model names (e.g. moonshotai/kimi-k2)'
    },
    moonshot: {
        endpoint: 'https://api.moonshot.ai/v1/chat/completions',
        models: 'moonshot-v1-8k, moonshot-v1-32k',
        hint: 'Moonshot models: moonshot-v1-8k, moonshot-v1-32k'
    },
    glm: {
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        models: 'glm-4-flash (free!), glm-4-air, glm-4',
        hint: 'GLM models: glm-4-flash (free!), glm-4-air, glm-4'
    },
    custom: {
        endpoint: '',
        models: '',
        hint: 'Any OpenAI-compatible endpoint'
    }
};

const DEFAULT_SETTINGS = {
    enabled: true,
    autoDetect: true,
    messageDepth: 5,
    showFab: true,
    // Detection API — external by default (don't burn Caleb's tokens!)
    detectionSource: 'external',   // 'external' | 'sillytavern'
    apiProvider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    apiModel: 'moonshotai/kimi-k2',
    mediaLibrary: {}
};

let settings = { ...DEFAULT_SETTINGS };
let isProcessing = false;

// =============================================================================
// Initialization
// =============================================================================

export async function init() {
    console.log('[MediaCompanion] Initializing...');

    loadSettings();
    injectSettingsUI();
    injectPanelUI();
    bindEvents();
    updateUI();

    // Register ST events
    // MESSAGE_SENT: detect progress + inject context BEFORE generation starts
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    // GENERATION_STARTED: re-inject context (ensures it's fresh for this generation)
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    // CHAT_CHANGED: restore UI state when switching chats
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[MediaCompanion] Ready!');
}

// =============================================================================
// Settings Persistence (localStorage, same as universe-gm)
// =============================================================================

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            settings = { ...DEFAULT_SETTINGS, ...parsed };
            // Ensure mediaLibrary exists
            if (!settings.mediaLibrary) settings.mediaLibrary = {};
        }
    } catch (e) {
        console.warn('[MediaCompanion] Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('[MediaCompanion] Failed to save settings:', e);
    }
}

// =============================================================================
// Per-Chat Data (via SillyTavern chat_metadata)
// =============================================================================

function getChatData() {
    try {
        const ctx = getContext();
        if (!ctx.chat_metadata) return getDefaultChatData();
        if (!ctx.chat_metadata[CHAT_META_KEY]) {
            ctx.chat_metadata[CHAT_META_KEY] = getDefaultChatData();
        }
        return ctx.chat_metadata[CHAT_META_KEY];
    } catch (e) {
        return getDefaultChatData();
    }
}

function saveChatData(data) {
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) {
            ctx.chat_metadata[CHAT_META_KEY] = data;
            // SillyTavern auto-saves chat_metadata
        }
    } catch (e) {
        console.warn('[MediaCompanion] Failed to save chat data:', e);
    }
}

function getDefaultChatData() {
    return {
        activeMediaId: null,
        activeEpisodeId: null,
        bookmark: 0
    };
}

// =============================================================================
// Chunk Parser
// =============================================================================

function parseChunks(rawText) {
    if (!rawText || !rawText.trim()) return [];
    return rawText
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map((line, index) => ({
            id: index + 1,
            content: line.replace(/^\d+[\.\)]\s*/, '').trim(),
            raw: line.trim()
        }));
}

// =============================================================================
// Context Injection
// =============================================================================

function injectMediaContext() {
    if (!settings.enabled) {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const chatData = getChatData();
    if (!chatData.activeMediaId) {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (!media || media.status !== 'watching') {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const episode = media.episodes?.[chatData.activeEpisodeId];
    if (!episode || !episode.chunks) {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const chunks = parseChunks(episode.chunks);
    const bookmark = chatData.bookmark || 0;

    if (bookmark === 0 || chunks.length === 0) {
        setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }

    const visibleChunks = chunks.slice(0, bookmark);
    const chunkText = visibleChunks
        .map((c, i) => `${i + 1}. ${c.content}`)
        .join('\n\n');

    const storySoFar = media.storySoFar?.trim()
        ? `\n<story_so_far>\n${media.storySoFar.trim()}\n</story_so_far>\n`
        : '';

    const mediaType = { tv: 'watching', game: 'playing', novel: 'reading', fic: 'reading', manga: 'reading' }[media.type] || 'experiencing';

    const contextBlock = `<media_context>
<currently_${mediaType}>${media.title} — ${episode.title}</currently_${mediaType}>
${storySoFar}
<current_episode_events>
${chunkText}
</current_episode_events>

<important>
The user is ${mediaType} this RIGHT NOW in real time. She has seen ONLY the events listed above — chunks 1 through ${bookmark} of ${chunks.length}. She has NOT seen anything beyond this point. You are ${mediaType} this WITH her. React naturally and genuinely. Do NOT hint at, foreshadow, or reference any events not listed above — those events do not exist in your knowledge.
</important>
</media_context>`;

    setExtensionPrompt(PROMPT_ID, contextBlock, extension_prompt_types.IN_CHAT, 0);
    console.log(`[MediaCompanion] Injected context: ${media.title}, ${episode.title}, chunks 1-${bookmark}/${chunks.length}`);
}

// =============================================================================
// External API Call (direct fetch — same pattern as universe-gm)
// =============================================================================

async function callExternalAPI(promptText) {
    if (!settings.apiKey) {
        console.warn('[MediaCompanion] No API key configured for external detection');
        return null;
    }

    const messages = [
        { role: 'system', content: 'You are a progress tracker. Return ONLY valid JSON, no other text.' },
        { role: 'user', content: promptText }
    ];

    const body = {
        model: settings.apiModel,
        messages,
        max_tokens: 100,
        temperature: 0,
        stream: false
    };

    try {
        const response = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
                'HTTP-Referer': 'https://github.com/SillyTavern/SillyTavern',
                'X-Title': 'Media Companion'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.warn(`[MediaCompanion] API Error ${response.status}: ${errText.slice(0, 200)}`);
            return null;
        }

        const data = await response.json();

        // Extract text from OpenAI-compatible response
        const text = data?.choices?.[0]?.message?.content
            || data?.choices?.[0]?.text
            || data?.output_text
            || '';

        return text;
    } catch (e) {
        console.warn('[MediaCompanion] External API call failed:', e);
        return null;
    }
}

async function testExternalAPI() {
    const origModel = settings.apiModel;
    try {
        const response = await callExternalAPI('Reply with exactly: {"status":"ok"}');
        if (response && response.includes('ok')) {
            return { ok: true, response };
        }
        return { ok: false, error: response || 'Empty response' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// =============================================================================
// Progress Detection
// =============================================================================

async function detectProgress() {
    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (!media || media.status !== 'watching') return;

    const episode = media.episodes?.[chatData.activeEpisodeId];
    if (!episode || !episode.chunks) return;

    const chunks = parseChunks(episode.chunks);
    if (chunks.length === 0) return;

    const currentBookmark = chatData.bookmark || 0;
    if (currentBookmark >= chunks.length) return; // already at the end

    const messages = getRecentUserMessages(settings.messageDepth);
    if (messages.length === 0) return;

    // Check if any messages reference the media at all (quick pre-filter)
    const recentText = messages.join(' ').toLowerCase();
    if (recentText.length < 5) return;

    const chunkList = chunks.map((c, i) => {
        const marker = (i + 1) === currentBookmark ? ' ← CURRENT' : '';
        return `${i + 1}. ${c.content}${marker}`;
    }).join('\n');

    const messageList = messages.map(m => `- "${m}"`).join('\n');

    const prompt = `You are a progress tracker. Your ONLY job: figure out how far the user has watched/read/played based on her recent messages.

MEDIA: ${media.title}
CURRENT CHAPTER/EPISODE: ${episode.title}
CURRENT BOOKMARK: Chunk ${currentBookmark} of ${chunks.length}

ALL CHUNKS (numbered):
${chunkList}

USER'S RECENT MESSAGES:
${messageList}

RULES:
- If her messages reference events AFTER chunk ${currentBookmark}, return the new chunk number she's reached
- If ambiguous or unrelated to the media, keep bookmark at ${currentBookmark}
- NEVER advance past what she's clearly referenced
- Only advance forward, never backward
- If she says she's finished or seen everything, set bookmark to ${chunks.length}

Return ONLY a JSON object, nothing else:
{"bookmark": <number>, "reason": "<brief explanation>"}`;

    try {
        isProcessing = true;
        updateProcessingIndicator(true);

        let response = null;

        if (settings.detectionSource === 'external' && settings.apiKey) {
            // Use external API (Kimi/GLM/etc — cheap!)
            response = await callExternalAPI(prompt);
        } else {
            // Fallback to SillyTavern's quiet prompt (uses main API — expensive!)
            response = await generateQuietPrompt({ quietPrompt: prompt });
        }

        if (!response) {
            console.warn('[MediaCompanion] Empty response from progress detection');
            return;
        }

        // Extract JSON from response
        const match = response.match(/\{[\s\S]*?\}/);
        if (match) {
            const parsed = JSON.parse(match[0]);
            const newBookmark = parseInt(parsed.bookmark);

            if (!isNaN(newBookmark) && newBookmark > currentBookmark && newBookmark <= chunks.length) {
                chatData.bookmark = newBookmark;
                saveChatData(chatData);
                console.log(`[MediaCompanion] Progress: ${currentBookmark} → ${newBookmark} (${parsed.reason || 'detected'})`);
                updateBookmarkDisplay();
            }
        }
    } catch (e) {
        console.warn('[MediaCompanion] Progress detection failed:', e);
    } finally {
        isProcessing = false;
        updateProcessingIndicator(false);
    }
}

function getRecentUserMessages(depth) {
    try {
        const ctx = getContext();
        const chat = ctx?.chat;
        if (!chat || chat.length === 0) return [];

        const userMessages = [];
        for (let i = chat.length - 1; i >= 0 && userMessages.length < depth; i--) {
            if (chat[i].is_user && chat[i].mes) {
                userMessages.unshift(chat[i].mes);
            }
        }
        return userMessages;
    } catch (e) {
        return [];
    }
}

// =============================================================================
// Event Handlers
// =============================================================================

async function onMessageSent() {
    if (!settings.enabled) return;

    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (!media || media.status !== 'watching') return;

    // Auto-detect progress BEFORE Caleb generates
    if (settings.autoDetect && !isProcessing) {
        await detectProgress();
    }

    // Inject context so it's ready for the upcoming generation
    injectMediaContext();
}

function onGenerationStarted(type, data, dryRun) {
    if (dryRun) return;
    if (!settings.enabled) return;
    if (data?.quietImage || data?.quiet_image || data?.isImageGeneration) return;
    // Don't trigger on quiet prompts (our own progress detection calls)
    if (data?.quiet_prompt || type === 'quiet') return;

    // Re-inject context to ensure it's current for this generation
    injectMediaContext();
}

function onChatChanged() {
    updateUI();
    // Re-inject context for the loaded chat
    if (settings.enabled) {
        injectMediaContext();
    }
}

// =============================================================================
// UI — Settings Panel (Extensions tab)
// =============================================================================

function injectSettingsUI() {
    const html = `
    <div id="mc-settings" class="media-companion-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Media Companion</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <div class="mc-row">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="mc-enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Enable Media Companion</span>
                    </label>
                </div>
                <div class="mc-row">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="mc-auto-detect" ${settings.autoDetect ? 'checked' : ''}>
                        <span>Auto-detect progress (uses AI)</span>
                    </label>
                </div>
                <div class="mc-row">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="checkbox" id="mc-show-fab" ${settings.showFab ? 'checked' : ''}>
                        <span>Show floating button</span>
                    </label>
                </div>
                <div class="mc-row-inline">
                    <span>Message depth:</span>
                    <input type="number" id="mc-msg-depth" value="${settings.messageDepth}"
                           min="3" max="15" style="width: 60px; padding: 4px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px; text-align: center;">
                </div>

                <!-- Detection API Settings -->
                <div style="margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <label style="font-weight: bold; margin-bottom: 6px; display: block; font-size: 12px;">Progress Detection API</label>

                    <div style="margin-bottom: 8px;">
                        <select id="mc-detection-source" style="width: 100%; padding: 6px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px;">
                            <option value="external" ${settings.detectionSource === 'external' ? 'selected' : ''}>External API (recommended — cheap!)</option>
                            <option value="sillytavern" ${settings.detectionSource === 'sillytavern' ? 'selected' : ''}>SillyTavern main API (uses Caleb's tokens!)</option>
                        </select>
                    </div>

                    <div id="mc-external-api-settings" style="${settings.detectionSource === 'external' ? '' : 'display:none;'}">
                        <div style="margin-bottom: 6px;">
                            <label style="font-size: 11px;">Provider</label>
                            <select id="mc-api-provider" style="width: 100%; padding: 6px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px;">
                                <option value="openrouter" ${settings.apiProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                                <option value="moonshot" ${settings.apiProvider === 'moonshot' ? 'selected' : ''}>Moonshot AI</option>
                                <option value="glm" ${settings.apiProvider === 'glm' ? 'selected' : ''}>GLM / Zhipu AI</option>
                                <option value="custom" ${settings.apiProvider === 'custom' ? 'selected' : ''}>Custom Endpoint</option>
                            </select>
                        </div>

                        <div style="margin-bottom: 6px;">
                            <label style="font-size: 11px;">API Key</label>
                            <input type="password" id="mc-api-key" value="${escapeHtml(settings.apiKey)}"
                                   placeholder="Your API key"
                                   style="width: 100%; padding: 6px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px;">
                        </div>

                        <div style="margin-bottom: 6px;" id="mc-endpoint-row">
                            <label style="font-size: 11px;">Endpoint</label>
                            <input type="text" id="mc-api-endpoint" value="${escapeHtml(settings.apiEndpoint)}"
                                   placeholder="https://api.example.com/v1/chat/completions"
                                   style="width: 100%; padding: 6px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px; font-size: 11px;">
                        </div>

                        <div style="margin-bottom: 6px;">
                            <label style="font-size: 11px;">Model</label>
                            <input type="text" id="mc-api-model" value="${escapeHtml(settings.apiModel)}"
                                   placeholder="e.g. moonshotai/kimi-k2"
                                   style="width: 100%; padding: 6px; background: #222; border: 1px solid #444; color: #fff; border-radius: 4px;">
                            <div id="mc-model-hint" style="font-size: 10px; opacity: 0.6; margin-top: 2px;"></div>
                        </div>

                        <div style="display: flex; gap: 6px;">
                            <button id="mc-api-test" style="flex: 1; padding: 6px; background: rgba(52,152,219,0.2); border: 1px solid rgba(52,152,219,0.4); color: #3498db; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                Test
                            </button>
                            <button id="mc-api-save" style="flex: 1; padding: 6px; background: rgba(46,204,113,0.2); border: 1px solid rgba(46,204,113,0.4); color: #2ecc71; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                Save
                            </button>
                        </div>
                        <div id="mc-api-status" style="margin-top: 6px; font-size: 11px; color: #888;"></div>
                    </div>
                </div>

                <div class="mc-row" style="margin-top: 8px;">
                    <button id="mc-open-panel" class="menu_button" style="width: 100%;">
                        Open Media Manager
                    </button>
                </div>
            </div>
        </div>
    </div>`;

    // Inject into Extensions panel
    const targets = ['#extensions_settings2', '#extensions_settings', '#extension_settings'];
    for (const sel of targets) {
        const target = document.querySelector(sel);
        if (target) {
            target.insertAdjacentHTML('beforeend', html);
            break;
        }
    }

    // Bind settings events
    document.getElementById('mc-enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
        if (!settings.enabled) {
            setExtensionPrompt(PROMPT_ID, '', extension_prompt_types.IN_CHAT, 0);
        } else {
            injectMediaContext();
        }
        updateFabVisibility();
    });

    document.getElementById('mc-auto-detect')?.addEventListener('change', (e) => {
        settings.autoDetect = e.target.checked;
        saveSettings();
    });

    document.getElementById('mc-show-fab')?.addEventListener('change', (e) => {
        settings.showFab = e.target.checked;
        saveSettings();
        updateFabVisibility();
    });

    document.getElementById('mc-msg-depth')?.addEventListener('change', (e) => {
        settings.messageDepth = parseInt(e.target.value) || 5;
        saveSettings();
    });

    document.getElementById('mc-open-panel')?.addEventListener('click', () => {
        togglePanel(true);
    });

    // --- External API settings ---

    document.getElementById('mc-detection-source')?.addEventListener('change', (e) => {
        settings.detectionSource = e.target.value;
        saveSettings();
        const externalSection = document.getElementById('mc-external-api-settings');
        if (externalSection) {
            externalSection.style.display = e.target.value === 'external' ? '' : 'none';
        }
    });

    document.getElementById('mc-api-provider')?.addEventListener('change', (e) => {
        const provider = e.target.value;
        settings.apiProvider = provider;
        const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;

        // Update endpoint for non-custom providers
        if (provider !== 'custom') {
            const endpointInput = document.getElementById('mc-api-endpoint');
            if (endpointInput) {
                endpointInput.value = preset.endpoint;
                settings.apiEndpoint = preset.endpoint;
            }
        }

        // Update hint
        const hint = document.getElementById('mc-model-hint');
        if (hint) hint.textContent = preset.hint;

        // Show/hide endpoint for custom
        const endpointRow = document.getElementById('mc-endpoint-row');
        if (endpointRow) {
            endpointRow.style.opacity = provider === 'custom' ? '1' : '0.7';
        }

        saveSettings();
    });

    // Trigger provider UI update on load
    const providerSelect = document.getElementById('mc-api-provider');
    if (providerSelect) {
        const preset = PROVIDER_PRESETS[settings.apiProvider] || PROVIDER_PRESETS.custom;
        const hint = document.getElementById('mc-model-hint');
        if (hint) hint.textContent = preset.hint;
    }

    document.getElementById('mc-api-save')?.addEventListener('click', () => {
        settings.apiKey = document.getElementById('mc-api-key')?.value || '';
        settings.apiEndpoint = document.getElementById('mc-api-endpoint')?.value || '';
        settings.apiModel = document.getElementById('mc-api-model')?.value || '';
        saveSettings();
        showApiStatus('Saved!', 'success');
    });

    document.getElementById('mc-api-test')?.addEventListener('click', async () => {
        // Save first
        settings.apiKey = document.getElementById('mc-api-key')?.value || '';
        settings.apiEndpoint = document.getElementById('mc-api-endpoint')?.value || '';
        settings.apiModel = document.getElementById('mc-api-model')?.value || '';
        saveSettings();

        showApiStatus('Testing...', 'info');
        const result = await testExternalAPI();
        if (result.ok) {
            showApiStatus('Connection OK!', 'success');
        } else {
            showApiStatus(`Failed: ${result.error}`, 'error');
        }
    });
}

function showApiStatus(msg, type = 'info') {
    const el = document.getElementById('mc-api-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'success' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#888';
    if (type !== 'error') {
        setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
    }
}

// =============================================================================
// UI — Main Panel + FAB
// =============================================================================

function injectPanelUI() {
    const typeOptions = `
        <option value="tv">TV / Anime</option>
        <option value="game">Game</option>
        <option value="novel">Novel</option>
        <option value="fic">Fanfic</option>
        <option value="manga">Manga</option>`;

    const html = `
    <!-- Floating Action Button -->
    <button id="mc-fab" title="Media Companion">
        <span style="font-size: 22px;">📺</span>
    </button>

    <!-- Main Panel -->
    <div id="mc-panel">
        <div class="mc-header">
            <span>📺 Media Companion</span>
            <span>
                <span id="mc-processing" style="display:none; margin-right: 8px; font-size: 11px; opacity: 0.6;">detecting...</span>
                <span class="mc-close fa-solid fa-xmark" id="mc-panel-close"></span>
            </span>
        </div>

        <!-- Media Selector -->
        <div class="mc-section">
            <label>Active Media</label>
            <select id="mc-media-select">
                <option value="">— None —</option>
            </select>
            <div class="mc-btn-row">
                <button class="mc-btn mc-btn-primary" id="mc-new-media">+ New Media</button>
                <button class="mc-btn mc-btn-danger" id="mc-delete-media">Delete</button>
            </div>

            <!-- New Media Form -->
            <div class="mc-new-form" id="mc-new-media-form">
                <input type="text" id="mc-new-media-title" placeholder="Title (e.g. Stranger Things S5)" />
                <select id="mc-new-media-type">${typeOptions}</select>
                <div class="mc-btn-row" style="margin-top: 6px;">
                    <button class="mc-btn mc-btn-primary" id="mc-create-media">Create</button>
                    <button class="mc-btn" id="mc-cancel-new-media">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Status -->
        <div class="mc-section" id="mc-status-section" style="display:none;">
            <label>Status</label>
            <div class="mc-status-row">
                <label><input type="radio" name="mc-status" value="watching"> Watching</label>
                <label><input type="radio" name="mc-status" value="paused"> Paused</label>
                <label><input type="radio" name="mc-status" value="done"> Done</label>
            </div>
        </div>

        <!-- Story So Far -->
        <div class="mc-section" id="mc-story-section" style="display:none;">
            <label>Story So Far</label>
            <textarea id="mc-story" rows="3"
                placeholder="Summary of everything BEFORE the current episode/chapter. You write this yourself — keep it brief."></textarea>
        </div>

        <!-- Episode/Chapter Selector -->
        <div class="mc-section" id="mc-episode-section" style="display:none;">
            <label>Current Episode / Chapter</label>
            <select id="mc-episode-select">
                <option value="">— None —</option>
            </select>
            <div class="mc-btn-row">
                <button class="mc-btn mc-btn-primary" id="mc-new-episode">+ New Episode</button>
                <button class="mc-btn mc-btn-danger" id="mc-delete-episode">Delete</button>
            </div>

            <!-- New Episode Form -->
            <div class="mc-new-form" id="mc-new-episode-form">
                <input type="text" id="mc-new-episode-title" placeholder="Episode title (e.g. S5E01: The Crawl)" />
                <div class="mc-btn-row" style="margin-top: 6px;">
                    <button class="mc-btn mc-btn-primary" id="mc-create-episode">Create</button>
                    <button class="mc-btn" id="mc-cancel-new-episode">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Chunks -->
        <div class="mc-section" id="mc-chunks-section" style="display:none;">
            <label>Episode Chunks (one per line, numbered)</label>
            <textarea id="mc-chunks" rows="6"
                placeholder="Paste your numbered chunk list from Claude here.&#10;&#10;1. Cold open: Will in Upside Down...&#10;2. Demogorgon captures Will...&#10;3. Present day, Byers at Wheelers..."></textarea>
        </div>

        <!-- Bookmark -->
        <div class="mc-section" id="mc-bookmark-section" style="display:none;">
            <label>Bookmark</label>
            <div class="mc-bookmark">
                <span class="mc-bookmark-label" id="mc-bookmark-display">0 / 0</span>
                <div class="mc-bookmark-controls">
                    <button class="mc-btn" id="mc-bk-back" title="Back one chunk">◄</button>
                    <button class="mc-btn" id="mc-bk-forward" title="Forward one chunk">►</button>
                    <button class="mc-btn" id="mc-bk-reset" title="Reset to 0">↺</button>
                    <button class="mc-btn" id="mc-bk-end" title="Jump to end">⏭</button>
                </div>
            </div>
            <div class="mc-progress-bar">
                <div class="mc-progress-fill" id="mc-progress-fill" style="width: 0%;"></div>
            </div>
        </div>

        <!-- Library -->
        <div class="mc-section">
            <label>Library</label>
            <div id="mc-library"></div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    bindPanelEvents();
    updateFabVisibility();
}

// =============================================================================
// Panel Event Bindings
// =============================================================================

function bindPanelEvents() {
    // FAB
    document.getElementById('mc-fab')?.addEventListener('click', () => togglePanel());

    // Panel close
    document.getElementById('mc-panel-close')?.addEventListener('click', () => togglePanel(false));

    // --- Media CRUD ---
    document.getElementById('mc-media-select')?.addEventListener('change', onMediaSelected);

    document.getElementById('mc-new-media')?.addEventListener('click', () => {
        document.getElementById('mc-new-media-form')?.classList.toggle('mc-visible');
    });

    document.getElementById('mc-cancel-new-media')?.addEventListener('click', () => {
        document.getElementById('mc-new-media-form')?.classList.remove('mc-visible');
    });

    document.getElementById('mc-create-media')?.addEventListener('click', onCreateMedia);
    document.getElementById('mc-delete-media')?.addEventListener('click', onDeleteMedia);

    // --- Status ---
    document.querySelectorAll('input[name="mc-status"]').forEach(radio => {
        radio.addEventListener('change', onStatusChanged);
    });

    // --- Story So Far ---
    document.getElementById('mc-story')?.addEventListener('input', debounce(onStorySoFarChanged, 500));

    // --- Episode CRUD ---
    document.getElementById('mc-episode-select')?.addEventListener('change', onEpisodeSelected);

    document.getElementById('mc-new-episode')?.addEventListener('click', () => {
        document.getElementById('mc-new-episode-form')?.classList.toggle('mc-visible');
    });

    document.getElementById('mc-cancel-new-episode')?.addEventListener('click', () => {
        document.getElementById('mc-new-episode-form')?.classList.remove('mc-visible');
    });

    document.getElementById('mc-create-episode')?.addEventListener('click', onCreateEpisode);
    document.getElementById('mc-delete-episode')?.addEventListener('click', onDeleteEpisode);

    // --- Chunks ---
    document.getElementById('mc-chunks')?.addEventListener('input', debounce(onChunksChanged, 500));

    // --- Bookmark controls ---
    document.getElementById('mc-bk-back')?.addEventListener('click', () => adjustBookmark(-1));
    document.getElementById('mc-bk-forward')?.addEventListener('click', () => adjustBookmark(1));
    document.getElementById('mc-bk-reset')?.addEventListener('click', () => setBookmark(0));
    document.getElementById('mc-bk-end')?.addEventListener('click', () => {
        const chatData = getChatData();
        const media = settings.mediaLibrary[chatData.activeMediaId];
        const episode = media?.episodes?.[chatData.activeEpisodeId];
        if (episode) {
            const chunks = parseChunks(episode.chunks);
            setBookmark(chunks.length);
        }
    });
}

// =============================================================================
// Panel Toggle
// =============================================================================

function togglePanel(forceState) {
    const panel = document.getElementById('mc-panel');
    if (!panel) return;

    if (forceState === true) {
        panel.classList.add('mc-open');
    } else if (forceState === false) {
        panel.classList.remove('mc-open');
    } else {
        panel.classList.toggle('mc-open');
    }
}

function updateFabVisibility() {
    const fab = document.getElementById('mc-fab');
    if (!fab) return;

    if (settings.enabled && settings.showFab) {
        fab.classList.add('mc-fab-visible');
    } else {
        fab.classList.remove('mc-fab-visible');
    }
}

function updateProcessingIndicator(show) {
    const el = document.getElementById('mc-processing');
    if (el) el.style.display = show ? 'inline' : 'none';
}

// =============================================================================
// Media CRUD Handlers
// =============================================================================

function onMediaSelected(e) {
    const mediaId = e.target.value;
    const chatData = getChatData();

    if (!mediaId) {
        chatData.activeMediaId = null;
        chatData.activeEpisodeId = null;
        chatData.bookmark = 0;
        saveChatData(chatData);
        injectMediaContext();
        updateUI();
        return;
    }

    chatData.activeMediaId = mediaId;
    const media = settings.mediaLibrary[mediaId];
    if (media?.currentEpisode) {
        chatData.activeEpisodeId = media.currentEpisode;
    } else {
        // Pick first episode
        const epKeys = Object.keys(media?.episodes || {});
        chatData.activeEpisodeId = epKeys.length > 0 ? epKeys[0] : null;
    }
    chatData.bookmark = 0; // Reset bookmark when switching media

    saveChatData(chatData);
    injectMediaContext();
    updateUI();
}

function onCreateMedia() {
    const titleInput = document.getElementById('mc-new-media-title');
    const typeSelect = document.getElementById('mc-new-media-type');
    const title = titleInput?.value?.trim();
    const type = typeSelect?.value || 'tv';

    if (!title) return;

    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    settings.mediaLibrary[id] = {
        id,
        title,
        type,
        status: 'watching',
        storySoFar: '',
        currentEpisode: null,
        episodes: {}
    };
    saveSettings();

    // Set as active
    const chatData = getChatData();
    chatData.activeMediaId = id;
    chatData.activeEpisodeId = null;
    chatData.bookmark = 0;
    saveChatData(chatData);

    // Clean up form
    if (titleInput) titleInput.value = '';
    document.getElementById('mc-new-media-form')?.classList.remove('mc-visible');

    updateUI();
}

function onDeleteMedia() {
    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (!confirm(`Delete "${media?.title || chatData.activeMediaId}" and all its episodes?`)) return;

    delete settings.mediaLibrary[chatData.activeMediaId];
    saveSettings();

    chatData.activeMediaId = null;
    chatData.activeEpisodeId = null;
    chatData.bookmark = 0;
    saveChatData(chatData);

    injectMediaContext();
    updateUI();
}

// =============================================================================
// Status Handler
// =============================================================================

function onStatusChanged(e) {
    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (media) {
        media.status = e.target.value;
        saveSettings();
        injectMediaContext();
    }
}

// =============================================================================
// Story So Far Handler
// =============================================================================

function onStorySoFarChanged() {
    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (media) {
        media.storySoFar = document.getElementById('mc-story')?.value || '';
        saveSettings();
        // Re-inject with updated story
        injectMediaContext();
    }
}

// =============================================================================
// Episode CRUD Handlers
// =============================================================================

function onEpisodeSelected(e) {
    const epId = e.target.value;
    const chatData = getChatData();

    chatData.activeEpisodeId = epId || null;
    chatData.bookmark = 0;
    saveChatData(chatData);

    // Also update the media's currentEpisode
    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (media) {
        media.currentEpisode = epId || null;
        saveSettings();
    }

    injectMediaContext();
    updateUI();
}

function onCreateEpisode() {
    const titleInput = document.getElementById('mc-new-episode-title');
    const title = titleInput?.value?.trim();
    if (!title) return;

    const chatData = getChatData();
    if (!chatData.activeMediaId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    if (!media) return;

    if (!media.episodes) media.episodes = {};

    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

    media.episodes[id] = {
        title,
        chunks: ''
    };
    media.currentEpisode = id;
    saveSettings();

    chatData.activeEpisodeId = id;
    chatData.bookmark = 0;
    saveChatData(chatData);

    // Clean up form
    if (titleInput) titleInput.value = '';
    document.getElementById('mc-new-episode-form')?.classList.remove('mc-visible');

    updateUI();
}

function onDeleteEpisode() {
    const chatData = getChatData();
    if (!chatData.activeMediaId || !chatData.activeEpisodeId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    const episode = media?.episodes?.[chatData.activeEpisodeId];
    if (!confirm(`Delete episode "${episode?.title || chatData.activeEpisodeId}"?`)) return;

    delete media.episodes[chatData.activeEpisodeId];

    // Switch to first remaining episode or null
    const epKeys = Object.keys(media.episodes || {});
    media.currentEpisode = epKeys.length > 0 ? epKeys[0] : null;
    saveSettings();

    chatData.activeEpisodeId = media.currentEpisode;
    chatData.bookmark = 0;
    saveChatData(chatData);

    injectMediaContext();
    updateUI();
}

// =============================================================================
// Chunks Handler
// =============================================================================

function onChunksChanged() {
    const chatData = getChatData();
    if (!chatData.activeMediaId || !chatData.activeEpisodeId) return;

    const media = settings.mediaLibrary[chatData.activeMediaId];
    const episode = media?.episodes?.[chatData.activeEpisodeId];
    if (episode) {
        episode.chunks = document.getElementById('mc-chunks')?.value || '';
        saveSettings();
        updateBookmarkDisplay();
        // Re-inject in case bookmark is already set
        injectMediaContext();
    }
}

// =============================================================================
// Bookmark Controls
// =============================================================================

function adjustBookmark(delta) {
    const chatData = getChatData();
    const media = settings.mediaLibrary[chatData.activeMediaId];
    const episode = media?.episodes?.[chatData.activeEpisodeId];
    if (!episode) return;

    const chunks = parseChunks(episode.chunks);
    const newBookmark = Math.max(0, Math.min(chunks.length, (chatData.bookmark || 0) + delta));

    setBookmark(newBookmark);
}

function setBookmark(value) {
    const chatData = getChatData();
    chatData.bookmark = value;
    saveChatData(chatData);

    updateBookmarkDisplay();
    injectMediaContext();
}

function updateBookmarkDisplay() {
    const chatData = getChatData();
    const media = settings.mediaLibrary[chatData.activeMediaId];
    const episode = media?.episodes?.[chatData.activeEpisodeId];

    const bookmark = chatData.bookmark || 0;
    const total = episode ? parseChunks(episode.chunks).length : 0;

    const display = document.getElementById('mc-bookmark-display');
    if (display) display.textContent = `${bookmark} / ${total}`;

    const fill = document.getElementById('mc-progress-fill');
    if (fill) fill.style.width = total > 0 ? `${(bookmark / total) * 100}%` : '0%';
}

// =============================================================================
// UI Update (refresh all display elements)
// =============================================================================

function updateUI() {
    const chatData = getChatData();
    const activeMediaId = chatData.activeMediaId;

    // --- Media dropdown ---
    const mediaSelect = document.getElementById('mc-media-select');
    if (mediaSelect) {
        const typeIcons = { tv: '📺', game: '🎮', novel: '📖', fic: '📖', manga: '📚' };

        mediaSelect.innerHTML = '<option value="">— None —</option>' +
            Object.values(settings.mediaLibrary).map(m => {
                const icon = typeIcons[m.type] || '📄';
                const selected = m.id === activeMediaId ? 'selected' : '';
                return `<option value="${m.id}" ${selected}>${icon} ${escapeHtml(m.title)}</option>`;
            }).join('');
    }

    const hasMedia = !!activeMediaId && !!settings.mediaLibrary[activeMediaId];

    // Show/hide sections
    setVisible('mc-status-section', hasMedia);
    setVisible('mc-story-section', hasMedia);
    setVisible('mc-episode-section', hasMedia);

    if (!hasMedia) {
        setVisible('mc-chunks-section', false);
        setVisible('mc-bookmark-section', false);
        updateLibrary();
        return;
    }

    const media = settings.mediaLibrary[activeMediaId];

    // --- Status radios ---
    document.querySelectorAll('input[name="mc-status"]').forEach(radio => {
        radio.checked = radio.value === media.status;
    });

    // --- Story So Far ---
    const storyEl = document.getElementById('mc-story');
    if (storyEl && storyEl !== document.activeElement) {
        storyEl.value = media.storySoFar || '';
    }

    // --- Episode dropdown ---
    const epSelect = document.getElementById('mc-episode-select');
    if (epSelect) {
        const episodes = media.episodes || {};
        epSelect.innerHTML = '<option value="">— None —</option>' +
            Object.entries(episodes).map(([epId, ep]) => {
                const selected = epId === chatData.activeEpisodeId ? 'selected' : '';
                return `<option value="${epId}" ${selected}>${escapeHtml(ep.title)}</option>`;
            }).join('');
    }

    const hasEpisode = !!chatData.activeEpisodeId && !!media.episodes?.[chatData.activeEpisodeId];
    setVisible('mc-chunks-section', hasEpisode);
    setVisible('mc-bookmark-section', hasEpisode);

    if (hasEpisode) {
        const episode = media.episodes[chatData.activeEpisodeId];

        // --- Chunks textarea ---
        const chunksEl = document.getElementById('mc-chunks');
        if (chunksEl && chunksEl !== document.activeElement) {
            chunksEl.value = episode.chunks || '';
        }

        // --- Bookmark ---
        updateBookmarkDisplay();
    }

    // --- Library ---
    updateLibrary();
}

function updateLibrary() {
    const container = document.getElementById('mc-library');
    if (!container) return;

    const chatData = getChatData();
    const typeIcons = { tv: '📺', game: '🎮', novel: '📖', fic: '📖', manga: '📚' };
    const entries = Object.values(settings.mediaLibrary);

    if (entries.length === 0) {
        container.innerHTML = '<div style="opacity: 0.5; font-size: 12px; padding: 8px;">No media yet. Click "+ New Media" to add one.</div>';
        return;
    }

    container.innerHTML = entries.map(m => {
        const icon = typeIcons[m.type] || '📄';
        const isActive = m.id === chatData.activeMediaId;
        const epCount = Object.keys(m.episodes || {}).length;
        const statusDot = `<span class="mc-status-dot ${m.status}"></span>`;

        let progress = '';
        if (m.status === 'done') {
            progress = 'Done ✓';
        } else if (m.currentEpisode && m.episodes?.[m.currentEpisode]) {
            progress = m.episodes[m.currentEpisode].title;
        } else {
            progress = `${epCount} episode${epCount !== 1 ? 's' : ''}`;
        }

        return `
        <div class="mc-library-item" data-media-id="${m.id}"
             style="${isActive ? 'border-left: 3px solid var(--SmartThemeQuoteColor, #6b8afd);' : ''}">
            <span class="mc-lib-title">${statusDot}${icon} ${escapeHtml(m.title)}</span>
            <span class="mc-lib-progress">${escapeHtml(progress)}</span>
        </div>`;
    }).join('');

    // Click to select
    container.querySelectorAll('.mc-library-item').forEach(item => {
        item.addEventListener('click', () => {
            const mediaId = item.dataset.mediaId;
            const select = document.getElementById('mc-media-select');
            if (select) {
                select.value = mediaId;
                select.dispatchEvent(new Event('change'));
            }
        });
    });
}

// =============================================================================
// Helpers
// =============================================================================

function setVisible(elementId, visible) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = visible ? '' : 'none';
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function debounce(fn, delay) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// =============================================================================
// Auto-init (same pattern as universe-gm)
// =============================================================================

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                try { init(); } catch (e) { console.error('[MediaCompanion] Init failed:', e); }
            }, 1500);
        });
    } else {
        setTimeout(() => {
            try { init(); } catch (e) { console.error('[MediaCompanion] Init failed:', e); }
        }, 1500);
    }
} catch (e) {
    console.error('[MediaCompanion] Setup failed:', e);
}

export default { init };
