// ==UserScript==
// @name         Discord Mobile - 2000x Gain, Stereo Panner & Max Opus UI
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Mobile-optimized UI with live 2000x gain, stereo panner, numeric input box, zero Chromium filters, and max 384kbps stereo Opus override.
// @match        https://discord.com/*
// @grant        none
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // Global Audio Graph State
    let audioCtx = null;
    let gainNode = null;
    let pannerNode = null;
    let currentGain = 1.0;
    let currentPan = 0.0; // -1.0 (Full Left) to 1.0 (Full Right)

    // 1. Intercept getUserMedia: Full filter wipe + 2-Channel Stereo Mic Request
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
                channelCount: { ideal: 2, exact: 2 }, // Force true 2-channel stereo mic
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
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            }
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            
            // Create Processing Nodes
            gainNode = audioCtx.createGain();
            gainNode.gain.value = currentGain;

            // Use StereoPannerNode for precise true stereo panning
            if (audioCtx.createStereoPanner) {
                pannerNode = audioCtx.createStereoPanner();
                pannerNode.pan.value = currentPan;
            } else {
                // Fallback panner creation if unsupported natively
                pannerNode = audioCtx.createChannelMerger(2);
            }

            const destination = audioCtx.createMediaStreamDestination();

            // Route: Source -> Gain -> Panner -> Destination (Stereo Stream Out)
            if (audioCtx.createStereoPanner) {
                source.connect(gainNode);
                gainNode.connect(pannerNode);
                pannerNode.connect(destination);
            } else {
                source.connect(gainNode);
                gainNode.connect(destination);
            }

            return destination.stream;
        } catch (e) {
            console.error("Audio pipeline processing failed:", e);
            return stream;
        }
    };

    // 2. Intercept RTCPeerConnection SDP to Force Max Opus Specs
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

    // 3. Inject Mobile Floating Control UI
    window.addEventListener('DOMContentLoaded', () => {
        createUI();
    });

    function createUI() {
        if (document.getElementById('discord-audio-hud')) return;

        const container = document.createElement('div');
        container.id = 'discord-audio-hud';
        container.innerHTML = `
            <div id="dah-header">
                <span>🎛️ MAX AUDIO HUD</span>
                <button id="dah-minimize">_</button>
            </div>
            <div id="dah-body">
                <div class="dah-row">
                    <label>Gain (1x - 2000x):</label>
                    <div class="dah-input-group">
                        <input type="range" id="dah-gain-range" min="1" max="2000" step="1" value="1">
                        <input type="text" id="dah-gain-text" value="1.0">
                    </div>
                </div>
                <div class="dah-row">
                    <label>Stereo Pan (L / R): <span id="dah-pan-val">0.0</span></label>
                    <input type="range" id="dah-pan-range" min="-1" max="1" step="0.05" value="0">
                </div>
                <button id="dah-reset">Reset Defaults</button>
            </div>
        `;

        // Mobile-Friendly Styling optimized for touch screens
        const style = document.createElement('style');
        style.innerHTML = `
            #discord-audio-hud {
                position: fixed;
                top: 60px;
                right: 10px;
                width: 280px;
                background: rgba(20, 20, 25, 0.95);
                border: 2px solid #5865F2;
                border-radius: 12px;
                color: #ffffff;
                font-family: sans-serif;
                z-index: 999999;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                backdrop-filter: blur(6px);
                user-select: none;
            }
            #dah-header {
                background: #5865F2;
                padding: 10px 14px;
                font-weight: bold;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-top-left-radius: 10px;
                border-top-right-radius: 10px;
                cursor: pointer;
            }
            #dah-minimize {
                background: none;
                border: none;
                color: white;
                font-size: 16px;
                font-weight: bold;
                padding: 0 5px;
            }
            #dah-body {
                padding: 14px;
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .dah-row {
                display: flex;
                flex-direction: column;
                gap: 6px;
                font-size: 12px;
            }
            .dah-input-group {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            #dah-gain-range, #dah-pan-range {
                flex: 1;
                height: 24px;
            }
            #dah-gain-text {
                width: 70px;
                background: #2f3136;
                border: 1px solid #72767d;
                color: white;
                text-align: center;
                border-radius: 6px;
                padding: 6px;
                font-size: 14px;
            }
            #dah-reset {
                background: #ed4245;
                color: white;
                border: none;
                padding: 8px;
                border-radius: 6px;
                font-weight: bold;
                font-size: 13px;
                cursor: pointer;
            }
            .minimized #dah-body {
                display: none;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(container);

        // Elements hookup
        const gainRange = document.getElementById('dah-gain-range');
        const gainText = document.getElementById('dah-gain-text');
        const panRange = document.getElementById('dah-pan-range');
        const panVal = document.getElementById('dah-pan-val');
        const resetBtn = document.getElementById('dah-reset');
        const minimizeBtn = document.getElementById('dah-minimize');
        const hud = document.getElementById('discord-audio-hud');

        // Logic Updaters
        function updateGain(val) {
            let num = parseFloat(val);
            if (isNaN(num)) num = 1.0;
            if (num < 0) num = 0;
            if (num > 2000) num = 2000;

            currentGain = num;
            gainRange.value = num;
            gainText.value = num;

            if (gainNode && audioCtx) {
                gainNode.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
            }
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

        gainRange.addEventListener('input', (e) => updateGain(e.target.value));
        gainText.addEventListener('change', (e) => updateGain(e.target.value));
        panRange.addEventListener('input', (e) => updatePan(e.target.value));

        resetBtn.addEventListener('click', () => {
            updateGain(1.0);
            updatePan(0.0);
        });

        let minimized = false;
        minimizeBtn.addEventListener('click', () => {
            minimized = !minimized;
            hud.classList.toggle('minimized', minimized);
            minimizeBtn.innerText = minimized ? '+' : '_';
        });

        // Touch-drag support for mobile floating panel movement
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
    }
})();
