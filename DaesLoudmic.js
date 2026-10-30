// ==UserScript==
// @name         Discord Mobile View - Full Loudmic, Stereo HUD & Mutable Mirroring
// @namespace    http://tampermonkey.net/
// @version      21.0
// @description  Full Android Edge mobile-view loudmic script with mutable audio mirroring, 20000x gain, stereo HUD, and stripped DSP flags.
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
    let currentGain = 50.0;
    let currentPan = 0.0;
    let highpassEnabled = true;
    let widerStereoEnabled = false;
    
    // Mutable audio mirroring flag as requested
    let audioMirroringEnabled = true;

    // Force unlock audio context on mobile web touch events
    const unlockAudio = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    };
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('click', unlockAudio, { passive: true });

    // Intercept getUserMedia and strip 100% of Chromium/WebRTC audio processing flags
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (constraints?.audio) {
            const strippedAudioSettings = {
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
                ? { ...constraints.audio, ...strippedAudioSettings }
                : strippedAudioSettings;
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

            // Highpass Filters (430Hz, Q: 0.3333)
            leftHp = audioCtx.createBiquadFilter();
            leftHp.type = 'highpass';
            leftHp.frequency.value = highpassEnabled ? 430 : 1;
            leftHp.Q.value = 0.3333;

            rightHp = audioCtx.createBiquadFilter();
            rightHp.type = 'highpass';
            rightHp.frequency.value = highpassEnabled ? 430 : 1;
            rightHp.Q.value = 0.3333;

            // Gain Nodes
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

            // Audio Mirroring Cross-Routing based on mutable flag
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

    // Mobile View Floating Trigger & HUD UI Control Panel
    const createHUD = () => {
        if (document.getElementById('dah-trigger')) return;

        const btn = document.createElement('button');
        btn.id = 'dah-trigger';
        btn.innerHTML = '🎙️ LOUD';
        btn.style.cssText = `
            position: fixed !important; bottom: 70px !important; right: 12px !important;
            background: #5865F2 !important; color: white !important; border: 2px solid white !important;
            border-radius: 24px !important; padding: 10px 14px !important; font-weight: bold !important;
            font-size: 13px !important; z-index: 2147483647 !important; box-shadow: 0 4px 12px rgba(0,0,0,0.6) !important;
        `;

        const panel = document.createElement('div');
        panel.id = 'dah-panel';
        panel.style.cssText = `
            position: fixed !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
            background: #18191c !important; border: 2px solid #5865F2 !important; border-radius: 12px !important;
            padding: 16px !important; color: white !important; z-index: 2147483647 !important; display: none;
            width: 290px !important; font-family: sans-serif !important; box-shadow: 0 10px 30px rgba(0,0,0,0.8) !important;
        `;
        panel.innerHTML = `
            <div style="font-weight:bold; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
                <span>Mobile Stereo Loudmic HUD</span>
                <button id="dah-close" style="background:none; border:none; color:white; font-size:16px; font-weight:bold;">✕</button>
            </div>
            
            <label style="font-size:12px;">Gain Boost: <span id="dah-val">50</span>x</label>
            <input type="range" id="dah-range" min="1" max="20000" step="10" value="50" style="width:100%; margin:6px 0 12px 0;">
            
            <div style="margin-bottom:10px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                <label for="dah-mirror-toggle">Audio Mirroring</label>
                <input type="checkbox" id="dah-mirror-toggle" checked style="width:20px; height:20px;">
            </div>

            <div style="margin-bottom:12px; font-size:12px; display:flex; justify-content:space-between; align-items:center;">
                <label for="dah-wider-toggle">Wider Stereo Mode</label>
                <input type="checkbox" id="dah-wider-toggle" style="width:20px; height:20px;">
            </div>

            <button id="dah-restart" style="width:100%; background:#ed4245; color:white; border:none; padding:10px; border-radius:6px; font-weight:bold;">Reset Audio Context</button>
        `;

        document.body.appendChild(btn);
        document.body.appendChild(panel);

        btn.onclick = () => panel.style.display = 'block';
        document.getElementById('dah-close').onclick = () => panel.style.display = 'none';

        const range = document.getElementById('dah-range');
        const valLabel = document.getElementById('dah-val');
        const mirrorToggle = document.getElementById('dah-mirror-toggle');
        const widerToggle = document.getElementById('dah-wider-toggle');

        range.oninput = (e) => {
            currentGain = parseFloat(e.target.value);
            valLabel.innerText = currentGain;
            if (leftGain && rightGain && audioCtx) {
                leftGain.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
                rightGain.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.01);
            }
        };

        mirrorToggle.onchange = (e) => {
            audioMirroringEnabled = e.target.checked;
        };

        widerToggle.onchange = (e) => {
            widerStereoEnabled = e.target.checked;
            updateRoutingGraph();
        };

        document.getElementById('dah-restart').onclick = () => {
            if (audioCtx) {
                audioCtx.close();
                audioCtx = null;
                alert("Audio context reset! Re-join your voice channel.");
            }
        };
    };

    const observer = new MutationObserver(() => {
        if (!document.getElementById('dah-trigger') && document.body) {
            createHUD();
        }
    });
    observer.observe(document, { childList: true, subtree: true });
})();
