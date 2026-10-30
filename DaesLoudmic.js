// ==UserScript==
// @name         Discord Mobile Web - True Stereo In/Out, 2000x Gain, 100Hz HPF & Max Opus
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  Ultimate Android Chromium loudmic script featuring true dual-channel stereo input/output routing, 100Hz highpass filter, live 2000x gain, track-unmute recovery, and 384kbps CBR Opus override.
// @match        https://discord.com/*
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
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

    // 1. Intercept getUserMedia: Force true 2-channel stereo mic constraints, wipe filters, and ensure active tracks
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (constraints && constraints.audio) {
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
                channelCount: { ideal: 2, exact: 2 }, // Force true discrete 2-channel stereo capture
                sampleRate: { ideal: 48000 }
            };

            if (typeof constraints.audio === 'object') {
                constraints.audio = { ...constraints.audio, ...rawAudioSettings };
            } else {
                constraints.audio = rawAudioSettings;
            }
        }

        const stream = await originalGetUserMedia(constraints);

        try {
            // Keep input tracks live and unmuted for Android Chromium execution threads
            stream.getAudioTracks().forEach(track => {
                track.enabled = true;
            });

            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            }
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);

            // True Stereo Splitter to process Left and Right channels independently
            const splitter = audioCtx.createChannelSplitter(2);
            const merger = audioCtx.createChannelMerger(2);

            // Left & Right Highpass Filters (100Hz Anti-Rumble / Anti-Plosive)
            leftHp = audioCtx.createBiquadFilter();
            leftHp.type = 'highpass';
            leftHp.frequency.value = highpassEnabled ? 100 : 1;

            rightHp = audioCtx.createBiquadFilter();
            rightHp.type = 'highpass';
            rightHp.frequency.value = highpassEnabled ? 100 : 1;

            // Left & Right Gain Nodes (1x to 2000x Amplification)
            leftGain = audioCtx.createGain();
            leftGain.gain.value = currentGain;

            rightGain = audioCtx.createGain();
            rightGain.gain.value = currentGain;

            // Stereo Panner Node for full output stage spatial control
            if (audioCtx.createStereoPanner) {
                pannerNode = audioCtx.createStereoPanner();
                pannerNode.pan.value = currentPan;
            } else {
                pannerNode = audioCtx.createChannelMerger(2);
            }

            const destination = audioCtx.createMediaStreamDestination();

            // Routing Graph: Source -> Splitter -> [Left / Right HPF -> Gain] -> Merger -> Panner -> Dest
            source.connect(splitter);

            // Left Channel Pipeline
            splitter.connect(leftHp, 0);
            leftHp.connect(leftGain);
            leftGain.connect(merger, 0, 0);

            // Right Channel Pipeline
            splitter.connect(rightHp, 1);
            rightHp.connect(rightGain);
            rightGain.connect(merger, 0, 1);

            // Output Stage Routing
            if (audioCtx.createStereoPanner) {
                merger.connect(pannerNode);
                pannerNode.connect(destination);
            } else {
                merger.connect(destination);
            }

            // Continuous context background resume ticker to prevent mobile chromium sleep locks
            setInterval(() => {
                if (audioCtx && audioCtx.state === 'suspended') {
                    audioCtx.resume();
                }
            }, 2000);

            // Guarantee output tracks remain active and unmuted
            destination.stream.getAudioTracks().forEach(t => t.enabled = true);

            return destination.stream;
        } catch (e) {
            console.error("Stereo audio pipeline routing failed:", e);
            return stream;
        }
    };

    // 2. Intercept RTCPeerConnection SDP to Force Max Opus Specs (384kbps CBR, Stereo Enabled, No DTX/FEC)
    const origSetLocalDescription = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = function (sessionDescription) {
        if (sessionDescription && sessionDescription.type === 'offer' && sessionDescription.sdp) {
            sessionDescription.sdp = modifySdpOpus(sessionDescription.sdp);
        }
        return origSetLocalDescription.apply(this, arguments);
    };

    function modifySdpOpus(sdp) {
        const lines = sdp.split('\r\n');
        let updatedLines = [];
        let opusPayload = null;

        for (let line of lines) {
            if (line.startsWith('a=rtpmap:') && line.toLowerCase().includes('opus/48000')) {
                const match = line.match(/^a=rtpmap:(\d+)\s+opus/i);
                if (match) opusPayload = match[1];
            }
        }

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (opusPayload && line.startsWith(`a=fmtp:${opusPayload}`)) {
                let baseFmtp = line.split(';')[0];
                line = `${baseFmtp}; maxaveragebitrate=384000; stereo=1; sprop-stereo=1; usedtx=0; useinbandfec=0; maxplaybackrate=48000; cbr=1`;
            }
            updatedLines.push(line);
        }

        if (opusPayload && !updatedLines.some(l => l.startsWith(`a=fmtp:${opusPayload} `))) {
            const rtpmapIndex = updatedLines.findIndex(l => l.startsWith(`a=rtpmap:${opusPayload}`));
            if (rtpmapIndex !== -1) {
                updatedLines.splice(rtpmapIndex + 1, 0, `a=fmtp:${opusPayload} maxaveragebitrate=384000; stereo=1; sprop-stereo=1; usedtx=0; useinbandfec=0; maxplaybackrate=48000; cbr=1`);
            }
        }

        return updatedLines.join('\r\n');
    }

    // 3. Inject Mobile Floating Control HUD UI
    window.addEventListener('DOMContentLoaded', () => {
        createUI();
    });

    function createUI() {
        if (document.getElementById('discord-audio-hud')) return;

        const container = document.createElement('div');
        container.id = 'discord-audio-hud';
        container.innerHTML = `
            <div id="dah-header">
                <span>🎙️ STEREO LOUDMIC HUD</span>
                <button id="dah-minimize" title="Minimize">_</button>
            </div>
            <div id="dah-body">
                <!-- Gain Boost Section -->
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label>Gain Boost (Stereo)</label>
                        <input type="text" id="dah-gain-text" value="1.0">
                    </div>
                    <input type="range" id="dah-gain-range" min="1" max="2000" step="1" value="1">
                    <div class="dah-presets">
                        <button class="dah-preset-btn" data-val="1">1x</button>
                        <button class="dah-preset-btn" data-val="50">50x</button>
                        <button class="dah-preset-btn" data-val="200">200x</button>
                        <button class="dah-preset-btn" data-val="500">500x</button>
                        <button class="dah-preset-btn" data-val="1000">1000x</button>
                        <button class="dah-preset-btn" data-val="2000">2000x</button>
                    </div>
                </div>

                <!-- 100Hz Filter Toggle -->
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-hp-toggle">100Hz Highpass Filter</label>
                        <input type="checkbox" id="dah-hp-toggle" checked>
                    </div>
                </div>

                <!-- Stereo Pan Section -->
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label>Stereo Output Balance</label>
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
                top: 40px;
                right: 10px;
                width: 300px;
                background: rgba(15, 17, 23, 0.95);
                border: 1px solid rgba(88, 101, 242, 0.6);
                border-radius: 14px;
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                z-index: 999999;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                user-select: none;
                overflow: hidden;
            }
            #dah-header {
                background: linear-gradient(135deg, #5865F2, #4752C4);
                padding: 12px 14px;
                font-weight: 700;
                font-size: 13px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: grab;
            }
            #dah-header:active {
                cursor: grabbing;
            }
            #dah-minimize {
                background: rgba(0, 0, 0, 0.2);
                border: none;
                color: white;
                font-size: 14px;
                font-weight: bold;
                width: 26px;
                height: 26px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
            }
            #dah-body {
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-height: 75vh;
                overflow-y: auto;
            }
            .dah-section {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.06);
                border-radius: 10px;
                padding: 10px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .dah-row-between {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
                font-weight: 600;
                color: #dcddde;
            }
            input[type="range"] {
                -webkit-appearance: none;
                width: 100%;
                height: 8px;
                background: #2f3136;
                border-radius: 4px;
                outline: none;
            }
            input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 22px;
                height: 22px;
                border-radius: 50%;
                background: #5865F2;
                cursor: pointer;
                box-shadow: 0 0 6px rgba(88, 101, 242, 0.8);
            }
            #dah-gain-text {
                width: 60px;
                background: #202225;
                border: 1px solid #4f545c;
                color: #fff;
                text-align: center;
                border-radius: 6px;
                padding: 4px;
                font-size: 13px;
                font-weight: bold;
            }
            .dah-presets {
                display: grid;
                grid-template-columns: repeat(6, 1fr);
                gap: 4px;
                margin-top: 2px;
            }
            .dah-preset-btn {
                background: #2f3136;
                border: 1px solid #4f545c;
                color: #dcddde;
                padding: 6px 0;
                font-size: 10px;
                font-weight: bold;
                border-radius: 4px;
                cursor: pointer;
                text-align: center;
            }
            .dah-preset-btn.active {
                background: #5865F2;
                color: white;
                border-color: #7983f5;
            }
            input[type="checkbox"] {
                width: 18px;
                height: 18px;
                accent-color: #5865F2;
                cursor: pointer;
            }
            #dah-reset {
                background: #ed4245;
                color: white;
                border: none;
                padding: 10px;
                border-radius: 8px;
                font-weight: bold;
                font-size: 12px;
                cursor: pointer;
                text-transform: uppercase;
                letter-spacing: 0.5px;
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
        const resetBtn = document.getElementById('dah-reset');
        const minimizeBtn = document.getElementById('dah-minimize');
        const hud = document.getElementById('discord-audio-hud');
        const presetBtns = document.querySelectorAll('.dah-preset-btn');

        function updateGain(val) {
            let num = parseFloat(val);
            if (isNaN(num)) num = 1.0;
            if (num < 1) num = 1;
            if (num > 2000) num = 2000;

            currentGain = num;
            gainRange.value = num;
            gainText.value = num;

            if (audioCtx) {
                if (leftGain) leftGain.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
                if (rightGain) rightGain.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
            }

            presetBtns.forEach(btn => {
                if (parseInt(btn.getAttribute('data-val')) === num) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        function updatePan(val) {
            let num = parseFloat(val);
            currentPan = num;
            panRange.value = num;
            panVal.innerText = num.toFixed(2);

            if (pannerNode && pannerNode.pan && audioCtx) {
                pannerNode.pan.setTargetAtTime(currentPan, audioCtx.currentTime, 0.01);
            }
        }

        function updateHighpass(enabled) {
            highpassEnabled = enabled;
            if (audioCtx) {
                const targetFreq = enabled ? 100 : 1;
                if (leftHp) leftHp.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
                if (rightHp) rightHp.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
            }
        }

        gainRange.addEventListener('input', (e) => updateGain(e.target.value));
        gainText.addEventListener('change', (e) => updateGain(e.target.value));
        panRange.addEventListener('input', (e) => updatePan(e.target.value));
        hpToggle.addEventListener('change', (e) => updateHighpass(e.target.checked));

        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                updateGain(btn.getAttribute('data-val'));
            });
        });

        resetBtn.addEventListener('click', () => {
            updateGain(1.0);
            updatePan(0.0);
            hpToggle.checked = true;
            updateHighpass(true);
        });

        let minimized = false;
        minimizeBtn.addEventListener('click', () => {
            minimized = !minimized;
            hud.classList.toggle('minimized', minimized);
            minimizeBtn.innerText = minimized ? '+' : '_';
        });

        // Touch drag handling for Android screens
        let isDragging = false, startX, startY, initialX, initialY;
        const header = document.getElementById('dah-header');

        header.addEventListener('touchstart', (e) => {
            isDragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            initialX = hud.offsetLeft;
            initialY = hud.offsetTop;
        }, {passive: true});

        window.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            let dx = e.touches[0].clientX - startX;
            let dy = e.touches[0].clientY - startY;
            hud.style.left = `${initialX + dx}px`;
            hud.style.top = `${initialY + dy}px`;
            hud.style.right = 'auto';
        }, {passive: true});

        window.addEventListener('touchend', () => { isDragging = false; });

        updateGain(1.0);
    }
})();