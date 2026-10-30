// ==UserScript==
// @name         Discord Mobile Web - True Wide Stereo, 20000x Gain, 430Hz Filter & Frozen Max Opus
// @namespace    http://tampermonkey.net/
// @version      14.0
// @description  Ultimate Android Chromium touchscreen-optimized loudmic script featuring forced audio mirroring, wider stereo processing, 20000x gain, 430Hz HPF, and frozen 384kbps CBR Opus override.
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
    let currentGain = 1.0;
    let currentPan = 0.0;
    let highpassEnabled = true;
    let widerStereoEnabled = false;
    const audioMirroringEnabled = true; // Hard-forced internal audio channel mirroring

    // 1. Intercept getUserMedia: Ideal 2-channel stereo capture, strip all Chromium DSP constraints
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

            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            }
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const splitter = audioCtx.createChannelSplitter(2);
            const merger = audioCtx.createChannelMerger(2);

            // Left & Right Highpass Filters (430Hz, Q: 0.3333 for maximum crisp punch)
            leftHp = audioCtx.createBiquadFilter();
            leftHp.type = 'highpass';
            leftHp.frequency.value = highpassEnabled ? 430 : 1;
            leftHp.Q.value = 0.3333;

            rightHp = audioCtx.createBiquadFilter();
            rightHp.type = 'highpass';
            rightHp.frequency.value = highpassEnabled ? 430 : 1;
            rightHp.Q.value = 0.3333;

            // Left & Right Gain Nodes (Up to 20,000x Amplification)
            leftGain = audioCtx.createGain();
            leftGain.gain.value = currentGain;

            rightGain = audioCtx.createGain();
            rightGain.gain.value = currentGain;

            // Stereo Panner Setup
            pannerNode = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : audioCtx.createChannelMerger(2);
            if (audioCtx.createStereoPanner) {
                pannerNode.pan.value = currentPan;
            }

            const destination = audioCtx.createMediaStreamDestination();

            source.connect(splitter);

            // Forced Audio Mirroring Cross-Routing
            if (audioMirroringEnabled) {
                splitter.connect(leftHp, 1);
                splitter.connect(rightHp, 0);
            } else {
                splitter.connect(leftHp, 0);
                splitter.connect(rightHp, 1);
            }

            leftHp.connect(leftGain);
            rightHp.connect(rightGain);

            updateRoutingGraph(merger);

            // Keep AudioContext alive in background tabs/browsers
            setInterval(() => {
                if (audioCtx?.state === 'suspended') {
                    audioCtx.resume();
                }
            }, 2000);

            destination.stream.getAudioTracks().forEach(t => { t.enabled = true; });
            return destination.stream;
        } catch (e) {
            console.error("Stereo audio pipeline routing failed:", e);
            return stream;
        }
    };

    const updateRoutingGraph = (merger) => {
        if (!leftGain || !rightGain || !pannerNode) return;

        try {
            leftGain.disconnect();
            rightGain.disconnect();
        } catch (e) {}

        if (widerStereoEnabled) {
            const leftWideGain = audioCtx.createGain();
            const rightWideGain = audioCtx.createGain();
            leftWideGain.gain.value = 0.35;
            rightWideGain.gain.value = 0.35;

            leftGain.connect(merger, 0, 0);
            rightGain.connect(merger, 0, 1);

            leftGain.connect(rightWideGain);
            rightWideGain.connect(merger, 0, 1);

            rightGain.connect(leftWideGain);
            leftWideGain.connect(merger, 0, 0);
        } else {
            leftGain.connect(merger, 0, 0);
            rightGain.connect(merger, 0, 1);
        }

        merger.connect(pannerNode);
        if (audioCtx.createStereoPanner) {
            pannerNode.connect(audioCtx.createMediaStreamDestination());
        }
    };

    // 2. Frozen Max Opus Parameters Config Object & SDP Interception
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

        if (opusPayload && !updatedLines.some(l => l.startsWith(`a=fmtp:${opusPayload} `))) {
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

    // 3. Inject Touch-Optimized Mobile Floating Control HUD UI
    window.addEventListener('DOMContentLoaded', () => {
        createUI();
    });

    const createUI = () => {
        if (document.getElementById('discord-audio-hud')) return;

        const container = document.createElement('div');
        container.id = 'discord-audio-hud';
        container.innerHTML = `
            <div id="dah-header">
                <span>🎙️ LOUDMC STEREO HUD</span>
                <button id="dah-minimize" aria-label="Minimize HUD">_</button>
            </div>
            <div id="dah-body">
                <!-- Gain Boost Section -->
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

                <!-- 430Hz Filter Toggle -->
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-hp-toggle">430Hz Highpass (Q: 0.33)</label>
                        <input type="checkbox" id="dah-hp-toggle" checked>
                    </div>
                </div>

                <!-- Wider Stereo Mode Toggle -->
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-wider-toggle">Wider Stereo Mode</label>
                        <input type="checkbox" id="dah-wider-toggle">
                    </div>
                </div>

                <!-- Stereo Pan Section -->
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
            #discord-audio-hud {
                position: fixed;
                top: 50px;
                right: 12px;
                width: 320px;
                max-width: 92vw;
                background: rgba(18, 20, 28, 0.95);
                border: 1.5px solid rgba(88, 101, 242, 0.7);
                border-radius: 16px;
                color: #ffffff;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                z-index: 999999;
                box-shadow: 0 12px 36px rgba(0, 0, 0, 0.85);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                user-select: none;
                touch-action: none;
                overflow: hidden;
            }
            #dah-header {
                background: linear-gradient(135deg, #5865F2, #4752C4);
                padding: 14px 16px;
                font-weight: 700;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: grab;
                touch-action: none;
            }
            #dah-header:active {
                cursor: grabbing;
            }
            #dah-minimize {
                background: rgba(0, 0, 0, 0.25);
                border: none;
                color: white;
                font-size: 16px;
                font-weight: bold;
                width: 36px;
                height: 36px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }
            #dah-body {
                padding: 14px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                max-height: 72vh;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }
            .dah-section {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            .dah-row-between {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 13px;
                font-weight: 600;
                color: #e3e5e8;
            }
            input[type="range"] {
                -webkit-appearance: none;
                width: 100%;
                height: 12px;
                background: #2f3136;
                border-radius: 6px;
                outline: none;
                margin: 6px 0;
            }
            input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: #5865F2;
                cursor: pointer;
                box-shadow: 0 0 8px rgba(88, 101, 242, 0.9);
            }
            #dah-gain-text {
                width: 70px;
                background: #202225;
                border: 1px solid #5865F2;
                color: #fff;
                text-align: center;
                border-radius: 8px;
                padding: 6px;
                font-size: 14px;
                font-weight: bold;
                outline: none;
            }
            .dah-presets {
                display: grid;
                grid-template-columns: repeat(6, 1fr);
                gap: 6px;
                margin-top: 4px;
            }
            .dah-preset-btn {
                background: #2f3136;
                border: 1px solid #4f545c;
                color: #dcddde;
                padding: 10px 0;
                font-size: 11px;
                font-weight: bold;
                border-radius: 6px;
                cursor: pointer;
                text-align: center;
                min-height: 38px;
            }
            .dah-preset-btn.active {
                background: #5865F2;
                color: white;
                border-color: #7983f5;
            }
            input[type="checkbox"] {
                width: 24px;
                height: 24px;
                accent-color: #5865F2;
                cursor: pointer;
            }
            #dah-reset {
                background: #ed4245;
                color: white;
                border: none;
                padding: 12px;
                border-radius: 10px;
                font-weight: bold;
                font-size: 13px;
                cursor: pointer;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                min-height: 44px;
            }
            .minimized #dah-body {
                display: none;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(container);

        const gainRange = document.getElementById('dah-gain-range');
        const gainText = document.getElementById('dah-gain-text');
        const panRange = document.getElementById('dah-pan-range');
        const panVal = document.getElementById('dah-pan-val');
        const hpToggle = document.getElementById('dah-hp-toggle');
        const widerToggle = document.getElementById('dah-wider-toggle');
        const resetBtn = document.getElementById('dah-reset');
        const minimizeBtn = document.getElementById('dah-minimize');
        const hud = document.getElementById('discord-audio-hud');
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
            if (audioCtx) {
                const merger = audioCtx.createChannelMerger(2);
                updateRoutingGraph(merger);
            }
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

        let minimized = false;
        minimizeBtn.addEventListener('click', () => {
            minimized = !minimized;
            hud.classList.toggle('minimized', minimized);
            minimizeBtn.innerText = minimized ? '+' : '_';
        });

        let isDragging = false, startX = 0, startY = 0, initialX = 0, initialY = 0;
        const header = document.getElementById('dah-header');

        header.addEventListener('touchstart', (e) => {
            if (e.target === minimizeBtn) return;
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            initialX = hud.offsetLeft;
            initialY = hud.offsetTop;
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;
            hud.style.left = `${initialX + dx}px`;
            hud.style.top = `${initialY + dy}px`;
            hud.style.right = 'auto';
        }, { passive: true });

        window.addEventListener('touchend', () => { isDragging = false; });

        updateGain(1.0);
    };
})();
