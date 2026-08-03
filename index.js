// Voice Call & Screen Share — SillyTavern extension
//
// Reuses your already-configured TTS extension (any provider) and drives it
// with a continuous speech-recognition loop to create a phone/video-call-like
// experience, plus an optional screen-share frame attached to your messages
// for vision-capable models.
//
// Talks to SillyTavern only through the documented getContext() API,
// eventSource events, and a generate_interceptor (see manifest.json).

const {
    extensionSettings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    executeSlashCommandsWithOptions,
} = SillyTavern.getContext();

const MODULE_NAME = 'st_voice_call';
// NOTE: must match the folder name this extension is installed under,
// so renderExtensionTemplateAsync can find settings.html.
const TEMPLATE_PATH = 'third-party/sonion';

const defaultSettings = Object.freeze({
    autoListen: true,
    muteWhileSpeaking: true,
    pushToTalk: false,
    language: 'en-US',
    silenceTimeoutMs: 1200,
    resumeDelayMs: 400,
    screenShareEnabled: false,
    screenShareQuality: 0.7,
});

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'idle'|'listening'|'sending'|'waiting_reply'|'speaking'} */
let callState = 'idle';
let callActive = false;
let recognition = null;
let recognitionShouldRun = false;
let silenceTimer = null;
let finalTranscript = '';
let pushToTalkHeld = false;

let screenStream = null;
let screenVideoEl = null;
let screenCanvasEl = null;

// ---------------------------------------------------------------------------
// Speech recognition (browser Web Speech API — works independently of
// whichever STT backend you configured in ST's own Speech Recognition
// extension, so this needs no extra setup on your end).
// ---------------------------------------------------------------------------

function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setState(next) {
    callState = next;
    updateBarUI();
}

function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
        toastr.error('This browser has no Web Speech API support. Try Chrome/Edge.', 'Voice Call');
        return;
    }
    if (recognition) {
        try { recognition.stop(); } catch (e) { /* noop */ }
    }

    const settings = getSettings();
    recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = settings.language || 'en-US';

    finalTranscript = '';
    recognitionShouldRun = true;

    recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const chunk = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += chunk + ' ';
            } else {
                interim += chunk;
            }
        }
        updateTranscriptPreview((finalTranscript + interim).trim());
        resetSilenceTimer();
    };

    recognition.onerror = (event) => {
        // 'no-speech' and 'aborted' are routine — don't spam the user.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
            console.warn(`[${MODULE_NAME}] recognition error`, event.error);
        }
    };

    recognition.onend = () => {
        // Browsers auto-stop continuous recognition after a while; restart
        // it transparently as long as we're still supposed to be listening.
        if (recognitionShouldRun && callActive && callState === 'listening') {
            try { recognition.start(); } catch (e) { /* already running */ }
        }
    };

    try {
        recognition.start();
        setState('listening');
        updateTranscriptPreview('');
    } catch (e) {
        console.error(`[${MODULE_NAME}] failed to start recognition`, e);
    }
}

function stopListening({ keepState = false } = {}) {
    recognitionShouldRun = false;
    clearSilenceTimer();
    if (recognition) {
        try { recognition.stop(); } catch (e) { /* noop */ }
    }
    if (!keepState) {
        setState('idle');
    }
}

function resetSilenceTimer() {
    const settings = getSettings();
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
        finishUtterance();
    }, settings.silenceTimeoutMs);
}

function clearSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

async function finishUtterance() {
    const text = finalTranscript.trim();
    finalTranscript = '';
    clearSilenceTimer();

    if (!text) {
        return; // silence with nothing said — keep listening
    }

    recognitionShouldRun = false;
    if (recognition) {
        try { recognition.stop(); } catch (e) { /* noop */ }
    }

    await sendUserMessage(text);
}

async function sendUserMessage(text) {
    setState('sending');
    updateTranscriptPreview('');

    // Escape pipe characters so they don't break the STscript batch.
    const safeText = text.replace(/\|/g, '\\|');

    try {
        // /send inserts the text as a user message, /trigger asks the
        // currently selected character/group to generate a reply — this is
        // the same path the send button uses, so it plays nicely with
        // everything else in the pipeline (world info, regex, etc).
        await executeSlashCommandsWithOptions(`/send ${safeText} | /trigger`, {
            handleParserErrors: true,
            handleExecutionErrors: true,
        });
        setState('waiting_reply');
    } catch (e) {
        console.error(`[${MODULE_NAME}] failed to send message`, e);
        toastr.error('Could not send the transcribed message.', 'Voice Call');
        if (callActive) startListening();
    }
}

// ---------------------------------------------------------------------------
// Call lifecycle
// ---------------------------------------------------------------------------

function startCall() {
    if (callActive) return;
    callActive = true;
    showBar();
    const settings = getSettings();
    if (!settings.pushToTalk) {
        startListening();
    } else {
        setState('idle');
    }
    toastr.success('Call started.', 'Voice Call');
}

function endCall() {
    callActive = false;
    stopListening();
    setState('idle');
    toastr.info('Call ended.', 'Voice Call');
}

// Generation lifecycle — used only to update the status readout; the actual
// "resume listening" trigger is the TTS completion event below, since that's
// the real signal that the bot has finished *speaking*, not just generating.
eventSource.on(event_types.GENERATION_STARTED, () => {
    if (callActive && callState === 'waiting_reply') {
        setState('waiting_reply');
    }
});

eventSource.on(event_types.GENERATION_ENDED, () => {
    if (!callActive) return;
    // If TTS auto-narrate is off (or this extension's provider makes no
    // sound), there will be no TTS_JOB_COMPLETE event — fall back to
    // resuming listening shortly after generation itself finishes.
    const settings = getSettings();
    const ttsWillHandleIt = isAutoNarrateLikelyOn();
    if (!ttsWillHandleIt && settings.autoListen && !settings.pushToTalk) {
        setTimeout(() => {
            if (callActive) startListening();
        }, settings.resumeDelayMs);
    }
});

function isAutoNarrateLikelyOn() {
    // Best-effort read of the built-in TTS extension's own settings object,
    // without taking a hard dependency on it (it may be absent/disabled).
    try {
        return Boolean(SillyTavern.getContext().extensionSettings?.tts?.auto_generation);
    } catch (e) {
        return false;
    }
}

eventSource.on(event_types.TTS_JOB_STARTED, () => {
    if (!callActive) return;
    setState('speaking');
    const settings = getSettings();
    if (settings.muteWhileSpeaking) {
        recognitionShouldRun = false;
        if (recognition) {
            try { recognition.stop(); } catch (e) { /* noop */ }
        }
    }
});

eventSource.on(event_types.TTS_JOB_COMPLETE, () => {
    if (!callActive) return;
    const settings = getSettings();
    if (settings.autoListen && !settings.pushToTalk) {
        setTimeout(() => {
            if (callActive) startListening();
        }, settings.resumeDelayMs);
    } else {
        setState('idle');
    }
});

// ---------------------------------------------------------------------------
// Screen share
// ---------------------------------------------------------------------------

async function startScreenShare() {
    if (screenStream) return;
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 5 },
            audio: false,
        });
    } catch (e) {
        toastr.warning('Screen share was cancelled or blocked.', 'Voice Call');
        return;
    }

    screenVideoEl = document.createElement('video');
    screenVideoEl.srcObject = screenStream;
    screenVideoEl.muted = true;
    screenVideoEl.playsInline = true;
    await screenVideoEl.play();

    screenCanvasEl = document.createElement('canvas');

    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScreenShare();
    });

    getSettings().screenShareEnabled = true;
    saveSettingsDebounced();
    updateBarUI();
    toastr.success('Screen sharing started — each message you send will include a frame.', 'Voice Call');
}

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
    }
    screenStream = null;
    screenVideoEl = null;
    screenCanvasEl = null;
    getSettings().screenShareEnabled = false;
    saveSettingsDebounced();
    updateBarUI();
}

function toggleScreenShare() {
    if (screenStream) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
}

function captureFrameDataUrl() {
    if (!screenStream || !screenVideoEl || !screenCanvasEl) return null;
    const w = screenVideoEl.videoWidth;
    const h = screenVideoEl.videoHeight;
    if (!w || !h) return null;
    screenCanvasEl.width = w;
    screenCanvasEl.height = h;
    const ctx = screenCanvasEl.getContext('2d');
    ctx.drawImage(screenVideoEl, 0, 0, w, h);
    const quality = getSettings().screenShareQuality ?? 0.7;
    return screenCanvasEl.toDataURL('image/jpeg', quality);
}

// Registered in manifest.json as the generate_interceptor. Runs right before
// a (non-dry-run) generation request is built, so we attach the latest
// screen frame to the last user message here.
//
// NOTE ON FIELD NAMES: this uses `extra.image` / `extra.inline_image`, the
// same shape ST's own multimodal message-image pipeline uses at the time of
// writing. If your ST version doesn't pick it up (e.g. no thumbnail shows,
// or the vision model reports no image), check the current source of the
// official companion extension for the exact field names on your version:
// https://github.com/SillyTavern/Extension-ScreenShare
// That extension is purpose-built and battle-tested for the "attach the
// screen to my last message" mechanic — you can also just install it
// alongside this one and only use this extension for the call/voice loop.
globalThis.STVoiceCallInterceptor = async function (chat, contextSize, abort, type) {
    if (type === 'quiet') return;
    if (!screenStream) return;
    if (!getSettings().screenShareEnabled) return;

    const frame = captureFrameDataUrl();
    if (!frame) return;

    const lastMessage = chat[chat.length - 1];
    if (!lastMessage || !lastMessage.is_user) return;

    lastMessage.extra = lastMessage.extra || {};
    lastMessage.extra.image = frame;
    lastMessage.extra.inline_image = true;
    lastMessage.extra.title = lastMessage.extra.title || 'Screen share frame';
};

// ---------------------------------------------------------------------------
// Floating call bar UI
// ---------------------------------------------------------------------------

function buildBar() {
    if (document.getElementById('vc_call_bar')) return;

    const bar = document.createElement('div');
    bar.id = 'vc_call_bar';
    bar.className = 'vc-hidden';
    bar.innerHTML = `
        <div class="vc-row">
            <button type="button" class="vc-btn vc-btn-mic" id="vc_mic_btn" title="Mic"><i class="fa-solid fa-microphone"></i></button>
            <button type="button" class="vc-btn vc-btn-screen" id="vc_screen_btn" title="Screen share"><i class="fa-solid fa-desktop"></i></button>
            <button type="button" class="vc-btn vc-btn-end" id="vc_end_btn" title="End call"><i class="fa-solid fa-phone-slash"></i></button>
        </div>
        <div class="vc-status" id="vc_status_label">idle</div>
        <div class="vc-transcript" id="vc_transcript_label"></div>
    `;
    document.body.appendChild(bar);

    // Drag to reposition.
    let dragging = false, offsetX = 0, offsetY = 0;
    bar.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        offsetX = e.clientX - bar.getBoundingClientRect().left;
        offsetY = e.clientY - bar.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        bar.style.left = `${e.clientX - offsetX}px`;
        bar.style.top = `${e.clientY - offsetY}px`;
        bar.style.right = 'auto';
        bar.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    const micBtn = document.getElementById('vc_mic_btn');
    const settings = getSettings();

    if (settings.pushToTalk) {
        micBtn.addEventListener('mousedown', () => {
            pushToTalkHeld = true;
            startListening();
        });
        micBtn.addEventListener('mouseup', () => {
            pushToTalkHeld = false;
            finishUtterance();
        });
        micBtn.addEventListener('mouseleave', () => {
            if (pushToTalkHeld) {
                pushToTalkHeld = false;
                finishUtterance();
            }
        });
    } else {
        micBtn.addEventListener('click', () => {
            if (callState === 'listening') {
                stopListening();
            } else if (callActive) {
                startListening();
            }
        });
    }

    document.getElementById('vc_screen_btn').addEventListener('click', toggleScreenShare);
    document.getElementById('vc_end_btn').addEventListener('click', endCall);
}

function showBar() {
    buildBar();
    document.getElementById('vc_call_bar')?.classList.remove('vc-hidden');
    updateBarUI();
}

function hideBar() {
    document.getElementById('vc_call_bar')?.classList.add('vc-hidden');
}

function updateBarUI() {
    const micBtn = document.getElementById('vc_mic_btn');
    const screenBtn = document.getElementById('vc_screen_btn');
    const statusLabel = document.getElementById('vc_status_label');
    if (!micBtn) return;

    micBtn.classList.remove('vc-listening', 'vc-speaking', 'vc-off');
    if (callState === 'listening') micBtn.classList.add('vc-listening');
    else if (callState === 'speaking') micBtn.classList.add('vc-speaking');
    else if (!callActive) micBtn.classList.add('vc-off');

    screenBtn.classList.toggle('vc-active', Boolean(screenStream));

    const labels = {
        idle: callActive ? 'idle — tap mic to talk' : 'idle',
        listening: 'listening…',
        sending: 'sending…',
        waiting_reply: 'thinking…',
        speaking: 'speaking…',
    };
    if (statusLabel) statusLabel.textContent = labels[callState] || callState;

    const settingsStatus = document.getElementById('vc_status_text');
    if (settingsStatus) settingsStatus.textContent = `Status: ${labels[callState] || callState}`;
}

function updateTranscriptPreview(text) {
    const el = document.getElementById('vc_transcript_label');
    if (el) el.textContent = text;
}

// ---------------------------------------------------------------------------
// Settings panel wiring
// ---------------------------------------------------------------------------

async function renderSettingsPanel() {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    let html;
    try {
        html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    } catch (e) {
        console.error(`[${MODULE_NAME}] could not render settings.html — check TEMPLATE_PATH matches your install folder name`, e);
        return;
    }
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);

    const settings = getSettings();
    const $ = window.jQuery;

    $('#vc_auto_listen').prop('checked', settings.autoListen).on('change', function () {
        settings.autoListen = this.checked;
        saveSettingsDebounced();
    });
    $('#vc_mute_while_speaking').prop('checked', settings.muteWhileSpeaking).on('change', function () {
        settings.muteWhileSpeaking = this.checked;
        saveSettingsDebounced();
    });
    $('#vc_push_to_talk').prop('checked', settings.pushToTalk).on('change', function () {
        settings.pushToTalk = this.checked;
        saveSettingsDebounced();
        toastr.info('Reopen the call for this change to fully apply.', 'Voice Call');
    });
    $('#vc_language').val(settings.language).on('change', function () {
        settings.language = this.value || 'en-US';
        saveSettingsDebounced();
    });
    $('#vc_silence_timeout').val(settings.silenceTimeoutMs)
        .on('input', function () {
            $('#vc_silence_timeout_value').text(this.value);
        })
        .on('change', function () {
            settings.silenceTimeoutMs = Number(this.value);
            saveSettingsDebounced();
        });
    $('#vc_silence_timeout_value').text(settings.silenceTimeoutMs);

    $('#vc_resume_delay').val(settings.resumeDelayMs)
        .on('input', function () {
            $('#vc_resume_delay_value').text(this.value);
        })
        .on('change', function () {
            settings.resumeDelayMs = Number(this.value);
            saveSettingsDebounced();
        });
    $('#vc_resume_delay_value').text(settings.resumeDelayMs);

    $('#vc_screenshare_enabled').prop('checked', settings.screenShareEnabled);
    $('#vc_screenshare_quality').val(settings.screenShareQuality)
        .on('input', function () {
            $('#vc_screenshare_quality_value').text(this.value);
        })
        .on('change', function () {
            settings.screenShareQuality = Number(this.value);
            saveSettingsDebounced();
        });
    $('#vc_screenshare_quality_value').text(settings.screenShareQuality);

    $('#vc_start_call').on('click', startCall);
    $('#vc_stop_call').on('click', endCall);
    $('#vc_toggle_screenshare').on('click', toggleScreenShare);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

eventSource.on(event_types.APP_READY, async () => {
    getSettings();
    await renderSettingsPanel();
});
