// ==UserScript==
// @name         Discord Mobile Web - Touch Toggle Loudmic HUD
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Android Chromium optimized loudmic with toggleable touch HUD, 20000x gain, 430Hz HPF, and 384kbps CBR Opus override.
// @match        https://discord.com/*
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(() => {
    'use strict';

    let audioCtx = null;
    let leftGain = null;
    let rightGain = null;
    let leftHp = null;
    let rightHp = null;
    let pannerNode = null;
    let persistentMerger = null;
    let destinationNode = null;
    let currentGain = 1.0;
    let currentPan = 0.0;
    let highpassEnabled = true;
    let widerStereoEnabled = false;
    const audioMirroringEnabled = true;

    // 1. Force Resume AudioContext on Any User Touch
    const unlockAudioContext = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    };
    window.addEventListener('touchstart', unlockAudioContext, { passive: true });
    window.addEventListener('click', unlockAudioContext, { passive: true });

    // 2. Intercept getUserMedia: Ideal 2-channel stereo capture & strip Chromium DSP constraints
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) {
            const rawAudioSettings = {
                echoCancellation: false,
                googEchoCancellation: false,
                googEchoCancellation2: false,
                autoGainControl: false,
                googAutoGainControl: false,
                googAutoGainControl2: false,
                noiseSuppression: false,
                googNoiseSuppression: false,
                googNoiseSuppression2: false,
                googHighpassFilter: false,
                googNullishAudioProcessing: false,
                googExperimentalNoiseSuppression: false,
                googExperimentalEchoCancellation: false,
                channelCount: { ideal: 2 },
                sampleRate: { ideal: 48000 }
            };

            constraints.audio = typeof constraints.audio === 'object'
                ? { ...constraints.audio, ...rawAudioSettings }
                : rawAudioSettings;
        }

        const stream = await originalGetUserMedia(constraints);

        try {
            stream.getAudioTracks().forEach(track => { track.enabled = true; });

            if (!audioCtx || audioCtx.state === 'closed') {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            }
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const splitter = audioCtx.createChannelSplitter(2);
            persistentMerger = audioCtx.createChannelMerger(2);
            destinationNode = audioCtx.createMediaStreamDestination();

            leftHp = audioCtx.createBiquadFilter();
            leftHp.type = 'highpass';
            leftHp.frequency.value = highpassEnabled ? 430 : 1;
            leftHp.Q.value = 0.3333;

            rightHp = audioCtx.createBiquadFilter();
            rightHp.type = 'highpass';
            rightHp.frequency.value = highpassEnabled ? 430 : 1;
            rightHp.Q.value = 0.3333;

            leftGain = audioCtx.createGain();
            leftGain.gain.value = currentGain;

            rightGain = audioCtx.createGain();
            rightGain.gain.value = currentGain;

            if (typeof audioCtx.createStereoPanner === 'function') {
                pannerNode = audioCtx.createStereoPanner();
                pannerNode.pan.value = currentPan;
            } else {
                pannerNode = null;
            }

            source.connect(splitter);

            if (audioMirroringEnabled) {
                splitter.connect(leftHp, 1);
                splitter.connect(rightHp, 0);
            } else {
                splitter.connect(leftHp, 0);
                splitter.connect(rightHp, 1);
            }

            leftHp.connect(leftGain);
            rightHp.connect(rightGain);

            updateRoutingGraph();

            destinationNode.stream.getAudioTracks().forEach(t => { t.enabled = true; });
            return destinationNode.stream;
        } catch (e) {
            console.error("Stereo audio pipeline routing failed:", e);
            return stream;
        }
    };

    const updateRoutingGraph = () => {
        if (!leftGain || !rightGain || !persistentMerger || !audioCtx || !destinationNode) return;

        try {
            leftGain.disconnect();
            rightGain.disconnect();
            persistentMerger.disconnect();
            if (pannerNode) pannerNode.disconnect();
        } catch (e) {}

        if (widerStereoEnabled) {
            const leftWideGain = audioCtx.createGain();
            const rightWideGain = audioCtx.createGain();
            leftWideGain.gain.value = 0.35;
            rightWideGain.gain.value = 0.35;

            leftGain.connect(persistentMerger, 0, 0);
            rightGain.connect(persistentMerger, 0, 1);

            leftGain.connect(rightWideGain);
            rightWideGain.connect(persistentMerger, 0, 1);

            rightGain.connect(leftWideGain);
            leftWideGain.connect(persistentMerger, 0, 0);
        } else {
            leftGain.connect(persistentMerger, 0, 0);
            rightGain.connect(persistentMerger, 0, 1);
        }

        if (pannerNode) {
            persistentMerger.connect(pannerNode);
            pannerNode.connect(destinationNode);
        } else {
            persistentMerger.connect(destinationNode);
        }
    };

    // 3. Frozen Max Opus SDP Overrides
    const FROZEN_OPUS_SPECS = Object.freeze({
        maxaveragebitrate: 384000,
        stereo: 1,
        'sprop-stereo': 1,
        usedtx: 0,
        useinbandfec: 0,
        maxplaybackrate: 48000,
        cbr: 1
    });

    const getFrozenFmtpString = () => Object.entries(FROZEN_OPUS_SPECS)
        .map(([key, val]) => `${key}=${val}`)
        .join('; ');

    const modifySdpOpus = (sdp) => {
        if (typeof sdp !== 'string') return sdp;

        const lines = sdp.split('\r\n');
        let updatedLines = [];
        let opusPayload = null;

        for (const line of lines) {
            if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('opus/48000')) {
                const match = line.match(/^a=rtpmap:(\d+)\s+opus/i);
                if (match) opusPayload = match[1];
            }
        }

        const frozenFmtpParams = getFrozenFmtpString();

        for (let line of lines) {
            if (opusPayload && line.startsWith(`a=fmtp:${opusPayload}`)) {
                const baseFmtp = line.split(';')[0];
                line = `${baseFmtp}; ${frozenFmtpParams}`;
            }
            updatedLines.push(line);
        }

        if (opusPayload && !updatedLines.some(l => l.startsWith(`a=fmtp:${opusPayload}`))) {
            const rtpmapIndex = updatedLines.findIndex(l => l.startsWith(`a=rtpmap:${opusPayload}`));
            if (rtpmapIndex !== -1) {
                updatedLines.splice(rtpmapIndex + 1, 0, `a=fmtp:${opusPayload} ${frozenFmtpParams}`);
            }
        }

        return updatedLines.join('\r\n');
    };

    const origSetLocalDescription = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = function (sessionDescription) {
        if (sessionDescription?.sdp) {
            sessionDescription.sdp = modifySdpOpus(sessionDescription.sdp);
        }
        return origSetLocalDescription.apply(this, arguments);
    };

    const origSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (sessionDescription) {
        if (sessionDescription?.sdp) {
            sessionDescription.sdp = modifySdpOpus(sessionDescription.sdp);
        }
        return origSetRemoteDescription.apply(this, arguments);
    };

    // 4. Toggleable Floating Mobile Trigger & Popup HUD
    const createUI = () => {
        if (document.getElementById('dah-trigger-btn')) return;

        const targetNode = document.body || document.documentElement;
        if (!targetNode) return;

        // Floating Trigger Button (Always visible on screen side)
        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'dah-trigger-btn';
        triggerBtn.innerHTML = '🎙️ LOUD';

        // Popup HUD Container (Hidden by default)
        const container = document.createElement('div');
        container.id = 'discord-audio-hud';
        container.className = 'dah-hidden';
        container.innerHTML = `
            <div id="dah-header">
                <span>LOUDMC STEREO HUD</span>
                <button id="dah-close" aria-label="Close HUD">✕</button>
            </div>
            <div id="dah-body">
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-gain-range">Gain Boost</label>
                        <input type="text" id="dah-gain-text" value="1.0" inputmode="decimal">
                    </div>
                    <input type="range" id="dah-gain-range" min="1" max="20000" step="10" value="1">
                    <div class="dah-presets">
                        <button class="dah-preset-btn" data-val="1">1x</button>
                        <button class="dah-preset-btn" data-val="100">100x</button>
                        <button class="dah-preset-btn" data-val="1000">1k</button>
                        <button class="dah-preset-btn" data-val="5000">5k</button>
                        <button class="dah-preset-btn" data-val="10000">10k</button>
                        <button class="dah-preset-btn" data-val="20000">20k</button>
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-hp-toggle">430Hz Highpass (Q: 0.33)</label>
                        <input type="checkbox" id="dah-hp-toggle" checked>
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-wider-toggle">Wider Stereo Mode</label>
                        <input type="checkbox" id="dah-wider-toggle">
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-pan-range">Output Balance</label>
                        <span id="dah-pan-val">0.00</span>
                    </div>
                    <input type="range" id="dah-pan-range" min="-1" max="1" step="0.05" value="0">
                </div>

                <button id="dah-reset">Reset Defaults</button>
            </div>
        `;

        const style = document.createElement('style');
        style.innerHTML = `
            #dah-trigger-btn {
                position: fixed !important;
                bottom: 80px !important;
                right: 12px !important;
                background: #5865F2 !important;
                color: white !important;
                border: 2px solid #ffffff !important;
                border-radius: 50px !important;
                padding: 12px 18px !important;
                font-weight: bold !important;
                font-size: 14px !important;
                z-index: 2147483647 !important;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.7) !important;
                cursor: pointer !important;
            }
            #discord-audio-hud {
                position: fixed !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                width: 320px !important;
                max-width: 92vw !important;
                background: rgba(18, 20, 28, 0.98) !important;
                border: 2px solid #5865F2 !important;
                border-radius: 16px !important;
                color: #ffffff !important;
                font-family: system-ui, -apple-system, sans-serif !important;
                z-index: 2147483647 !important;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.95) !important;
                overflow: hidden !important;
            }
            #discord-audio-hud.dah-hidden {
                display: none !important;
            }
            #dah-header {
                background: #5865F2 !important;
                padding: 14px 16px !important;
                font-weight: bold !important;
                font-size: 14px !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
            }
            #dah-close {
                background: rgba(0, 0, 0, 0.3) !important;
                border: none !important;
                color: white !important;
                width: 32px !important;
                height: 32px !important;
                border-radius: 8px !important;
                font-weight: bold !important;
                font-size: 16px !important;
            }
            #dah-body {
                padding: 14px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 12px !important;
                max-height: 70vh !important;
                overflow-y: auto !important;
                touch-action: pan-y !important;
            }
            .dah-section {
                background: rgba(255, 255, 255, 0.05) !important;
                border-radius: 10px !important;
                padding: 10px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 8px !important;
            }
            .dah-row-between {
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                font-size: 13px !important;
            }
            input[type="range"] {
                width: 100% !important;
                height: 12px !important;
            }
            #dah-gain-text {
                width: 70px !important;
                background: #202225 !important;
                border: 1px solid #5865F2 !important;
                color: #fff !important;
                text-align: center !important;
                border-radius: 6px !important;
                padding: 6px !important;
                font-weight: bold;
            }
            .dah-presets {
                display: grid !important;
                grid-template-columns: repeat(6, 1fr) !important;
                gap: 4px !important;
            }
            .dah-preset-btn {
                background: #2f3136 !important;
                border: 1px solid #4f545c !important;
                color: #fff !important;
                padding: 8px 0 !important;
                font-size: 11px !important;
                border-radius: 6px !important;
                font-weight: bold;
            }
            .dah-preset-btn.active {
                background: #5865F2 !important;
            }
            #dah-reset {
                background: #ed4245 !important;
                color: white !important;
                border: none !important;
                padding: 12px !important;
                border-radius: 8px !important;
                font-weight: bold !important;
                text-transform: uppercase;
            }
        `;

        document.head ? document.head.appendChild(style) : targetNode.appendChild(style);
        targetNode.appendChild(triggerBtn);
        targetNode.appendChild(container);

        // Toggle visibility handlers
        triggerBtn.addEventListener('click', () => {
            container.classList.toggle('dah-hidden');
        });

        document.getElementById('dah-close').addEventListener('click', () => {
            container.classList.add('dah-hidden');
        });

        const gainRange = document.getElementById('dah-gain-range');
        const gainText = document.getElementById('dah-gain-text');
        const panRange = document.getElementById('dah-pan-range');
        const panVal = document.getElementById('dah-pan-val');
        const hpToggle = document.getElementById('dah-hp-toggle');
        const widerToggle = document.getElementById('dah-wider-toggle');
        const resetBtn = document.getElementById('dah-reset');
        const presetBtns = document.querySelectorAll('.dah-preset-btn');

        const updateGain = (val) => {
            let num = parseFloat(val);
            if (isNaN(num)) num = 1.0;
            num = Math.max(1, Math.min(20000, num));

            currentGain = num;
            gainRange.value = num;
            gainText.value = num;

            if (audioCtx) {
                leftGain?.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
                rightGain?.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
            }

            presetBtns.forEach(btn => {
                if (parseInt(btn.getAttribute('data-val'), 10) === num) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        };

        const updatePan = (val) => {
            currentPan = parseFloat(val);
            panRange.value = currentPan;
            panVal.innerText = currentPan.toFixed(2);

            if (pannerNode?.pan && audioCtx) {
                pannerNode.pan.setTargetAtTime(currentPan, audioCtx.currentTime, 0.01);
            }
        };

        const updateHighpass = (enabled) => {
            highpassEnabled = enabled;
            if (audioCtx) {
                const targetFreq = enabled ? 430 : 1;
                leftHp?.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
                rightHp?.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
            }
        };

        const updateWiderStereo = (enabled) => {
            widerStereoEnabled = enabled;
            updateRoutingGraph();
        };

        gainRange.addEventListener('input', (e) => updateGain(e.target.value));
        gainText.addEventListener('change', (e) => updateGain(e.target.value));
        panRange.addEventListener('input', (e) => updatePan(e.target.value));
        hpToggle.addEventListener('change', (e) => updateHighpass(e.target.checked));
        widerToggle.addEventListener('change', (e) => updateWiderStereo(e.target.checked));

        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => updateGain(btn.getAttribute('data-val')));
        });

        resetBtn.addEventListener('click', () => {
            updateGain(1.0);
            updatePan(0.0);
            hpToggle.checked = true;
            updateHighpass(true);
            widerToggle.checked = false;
            updateWiderStereo(false);
        });

        updateGain(1.0);
    };

    // Continuous check loop to guarantee injection on Discord's React router
    const tryInject = () => {
        if (!document.getElementById('dah-trigger-btn') && (document.body || document.documentElement)) {
            createUI();
        }
    };

    setInterval(tryInject, 1000);
    document.addEventListener('DOMContentLoaded', tryInject);
})();
