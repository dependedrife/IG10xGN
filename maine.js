// ==UserScript==
// @name         Discord Mobile View - EQ-APO Polyverse Wider Loudmic HUD
// @namespace    http://tampermonkey.net/
// @version      26.2
// @description  Studio-grade EQ-APO style stereo audio controller with true Polyverse Wider all-pass phase expansion, optional audio mirroring, and clean mobile HUD.
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
    
    // Wider All-Pass Filter Stages
    let leftAp1 = null, leftAp2 = null;
    let rightAp1 = null, rightAp2 = null;

    let currentGain = 1.0;
    let currentPan = 0.0;
    let highpassEnabled = false;        // Default off for normal clean raw input
    let widerStereoEnabled = false;     // Default off
    let audioMirroringEnabled = false;  // Default off for standard non-mirrored stereo

    // Force unlock audio context on mobile web touch events to bypass browser autoplay blocks
    const unlockAudio = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    };
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('click', unlockAudio, { passive: true });

    // Intercept getUserMedia: Apply default or custom audio mirroring based on toggle state
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) {
            const apoAudioSettings = {
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
                googAudioMirroring: audioMirroringEnabled,
                channelCount: { ideal: 2 },
                sampleRate: { ideal: 48000 }
            };

            constraints.audio = typeof constraints.audio === 'object'
                ? { ...constraints.audio, ...apoAudioSettings }
                : apoAudioSettings;
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

            // Highpass Filters (430Hz crisp punch, Q: 0.3333)
            leftHp = audioCtx.createBiquadFilter();
            leftHp.type = 'highpass';
            leftHp.frequency.value = highpassEnabled ? 430 : 1;
            leftHp.Q.value = 0.3333;

            rightHp = audioCtx.createBiquadFilter();
            rightHp.type = 'highpass';
            rightHp.frequency.value = highpassEnabled ? 430 : 1;
            rightHp.Q.value = 0.3333;

            // Polyverse Wider All-Pass Stages (Psychoacoustic phase shifting for spatial width)
            leftAp1 = audioCtx.createBiquadFilter();
            leftAp1.type = 'allpass';
            leftAp1.frequency.value = 350;
            leftAp1.Q.value = 0.707;

            leftAp2 = audioCtx.createBiquadFilter();
            leftAp2.type = 'allpass';
            leftAp2.frequency.value = 2200;
            leftAp2.Q.value = 0.707;

            rightAp1 = audioCtx.createBiquadFilter();
            rightAp1.type = 'allpass';
            rightAp1.frequency.value = 650;
            rightAp1.Q.value = 0.707;

            rightAp2 = audioCtx.createBiquadFilter();
            rightAp2.type = 'allpass';
            rightAp2.frequency.value = 4100;
            rightAp2.Q.value = 0.707;

            // Gain Nodes (Up to 20,000x Amplification)
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
            leftAp1.disconnect();
            leftAp2.disconnect();
            rightAp1.disconnect();
            rightAp2.disconnect();
            persistentMerger.disconnect();
            if (pannerNode) pannerNode.disconnect();
        } catch (e) {}

        // True Polyverse Wider Simulation Matrix (Staggered All-Pass Decorrelation)
        if (widerStereoEnabled) {
            leftGain.connect(leftAp1);
            leftAp1.connect(leftAp2);
            leftAp2.connect(persistentMerger, 0, 0);

            rightGain.connect(rightAp1);
            rightAp1.connect(rightAp2);
            rightAp2.connect(persistentMerger, 0, 1);
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

    // Frozen Max Opus Parameters Config Object & SDP Interception
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

    // EQ-APO Style Audio Controller UI Injection
    const createUI = () => {
        if (document.getElementById('discord-audio-hud')) return;

        const container = document.createElement('div');
        container.id = 'discord-audio-hud';
        container.innerHTML = `
            <div id="dah-header">
                <span>🎛️ EQ-APO STEREO RACK</span>
                <button id="dah-minimize" aria-label="Minimize HUD">-</button>
            </div>
            <div id="dah-body">
                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-gain-text">Gain Boost (Stereo)</label>
                        <input type="text" id="dah-gain-text" value="1" inputmode="decimal">
                    </div>
                    <input type="range" id="dah-gain-range" min="1" max="20000" step="10" value="1">
                    <div class="dah-presets">
                        <button class="dah-preset-btn active" data-val="1">1x</button>
                        <button class="dah-preset-btn" data-val="100">100x</button>
                        <button class="dah-preset-btn" data-val="1000">1k</button>
                        <button class="dah-preset-btn" data-val="5000">5k</button>
                        <button class="dah-preset-btn" data-val="10000">10k</button>
                        <button class="dah-preset-btn" data-val="20000">20k</button>
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-hp-toggle">430Hz Highpass Filter</label>
                        <input type="checkbox" id="dah-hp-toggle">
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-mirror-toggle">Audio Mirroring</label>
                        <input type="checkbox" id="dah-mirror-toggle">
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-wider-toggle">Polyverse Wider Effect</label>
                        <input type="checkbox" id="dah-wider-toggle">
                    </div>
                </div>

                <div class="dah-section">
                    <div class="dah-row-between">
                        <label for="dah-pan-range">Stereo Balance Pan</label>
                        <span id="dah-pan-val">0.00</span>
                    </div>
                    <input type="range" id="dah-pan-range" min="-1" max="1" step="0.05" value="0">
                </div>

                <button id="dah-reset">RESET DEFAULTS</button>
            </div>
        `;

        const style = document.createElement('style');
        style.innerHTML = `
            #discord-audio-hud {
                position: fixed !important;
                bottom: 16px !important;
                right: 12px !important;
                width: 315px !important;
                max-width: 92vw !important;
                background: #12141c !important;
                border: 1.5px solid #202225 !important;
                border-top: 3px solid #5865F2 !important;
                border-radius: 10px !important;
                color: #e3e5e8 !important;
                font-family: Consolas, monaco, monospace, system-ui, sans-serif !important;
                z-index: 2147483647 !important;
                box-shadow: 0 12px 35px rgba(0, 0, 0, 0.95) !important;
                overflow: hidden !important;
            }
            #dah-header {
                background: #1a1c23 !important;
                padding: 10px 12px !important;
                font-weight: bold !important;
                font-size: 12px !important;
                letter-spacing: 0.5px;
                color: #ffffff !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                border-bottom: 1px solid #2f3136 !important;
            }
            #dah-minimize {
                background: #2f3136 !important;
                border: 1px solid #4f545c !important;
                color: white !important;
                width: 24px !important;
                height: 24px !important;
                border-radius: 4px !important;
                font-weight: bold !important;
                font-size: 14px !important;
                cursor: pointer !important;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #dah-body {
                padding: 10px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 8px !important;
                max-height: 72vh !important;
                overflow-y: auto !important;
                background: #12141c !important;
            }
            .dah-section {
                background: #181a22 !important;
                border: 1px solid #282b33 !important;
                border-radius: 6px !important;
                padding: 8px 10px !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 6px !important;
            }
            .dah-row-between {
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                font-size: 11px !important;
                font-weight: bold !important;
                color: #b9bbbe !important;
            }
            input[type="range"] {
                width: 100% !important;
                height: 6px !important;
                background: #2f3136 !important;
                border-radius: 3px !important;
                accent-color: #5865F2 !important;
                outline: none !important;
            }
            #dah-gain-text {
                width: 60px !important;
                background: #0b0c10 !important;
                border: 1px solid #4f545c !important;
                color: #00ffcc !important;
                text-align: center !important;
                border-radius: 4px !important;
                padding: 3px !important;
                font-size: 12px !important;
                font-weight: bold !important;
            }
            .dah-presets {
                display: grid !important;
                grid-template-columns: repeat(6, 1fr) !important;
                gap: 3px !important;
                margin-top: 2px;
            }
            .dah-preset-btn {
                background: #202225 !important;
                border: 1px solid #36393f !important;
                color: #b9bbbe !important;
                padding: 5px 0 !important;
                font-size: 9px !important;
                font-weight: bold !important;
                border-radius: 4px !important;
                cursor: pointer !important;
            }
            .dah-preset-btn.active {
                background: #5865F2 !important;
                color: white !important;
                border-color: #7983f5 !important;
            }
            input[type="checkbox"] {
                width: 18px !important;
                height: 18px !important;
                accent-color: #5865F2 !important;
                cursor: pointer !important;
            }
            #dah-reset {
                background: #ed4245 !important;
                color: white !important;
                border: none !important;
                padding: 8px !important;
                border-radius: 6px !important;
                font-weight: bold !important;
                font-size: 11px !important;
                cursor: pointer !important;
                letter-spacing: 0.5px;
            }
            .minimized #dah-body {
                display: none !important;
            }
        `;

        const targetNode = document.body || document.documentElement;
        if (targetNode) {
            document.head.appendChild(style);
            targetNode.appendChild(container);
        }

        const gainRange = document.getElementById('dah-gain-range');
        const gainText = document.getElementById('dah-gain-text');
        const panRange = document.getElementById('dah-pan-range');
        const panVal = document.getElementById('dah-pan-val');
        const hpToggle = document.getElementById('dah-hp-toggle');
        const mirrorToggle = document.getElementById('dah-mirror-toggle');
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

        gainRange.addEventListener('input', (e) => updateGain(e.target.value));
        gainText.addEventListener('change', (e) => updateGain(e.target.value));
        panRange.addEventListener('input', (e) => updatePan(e.target.value));
        
        hpToggle.addEventListener('change', (e) => {
            highpassEnabled = e.target.checked;
            if (audioCtx) {
                const targetFreq = highpassEnabled ? 430 : 1;
                leftHp?.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
                rightHp?.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.01);
            }
        });

        mirrorToggle.addEventListener('change', (e) => {
            audioMirroringEnabled = e.target.checked;
        });

        widerToggle.addEventListener('change', (e) => {
            widerStereoEnabled = e.target.checked;
            updateRoutingGraph();
        });

        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => updateGain(btn.getAttribute('data-val')));
        });

        resetBtn.addEventListener('click', () => {
            updateGain(1.0);
            updatePan(0.0);
            hpToggle.checked = false;
            highpassEnabled = false;
            mirrorToggle.checked = false;
            audioMirroringEnabled = false;
            widerToggle.checked = false;
            widerStereoEnabled = false;
            updateRoutingGraph();
        });

        let minimized = false;
        minimizeBtn.addEventListener('click', () => {
            minimized = !minimized;
            hud.classList.toggle('minimized', minimized);
            minimizeBtn.innerText = minimized ? '+' : '-';
        });
    };

    // Watchdog mutation observer to maintain injection across Discord mobile view router changes
    const observer = new MutationObserver(() => {
        if (!document.getElementById('discord-audio-hud') && document.body) {
            createUI();
        }
    });
    observer.observe(document, { childList: true, subtree: true });
})();