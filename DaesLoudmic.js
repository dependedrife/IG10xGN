// ==UserScript==
// @name         Discord Mobile Web - Ultimate True Stereo Loud-Mic & 384k Opus
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Standalone mobile-optimized loudmic pipeline with true stereo input/output, 100Hz highpass filter, 5000x master gain, and 384kbps CBR Opus override.
// @match        *://*.discord.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CFG = Object.freeze({
        mic: Object.freeze({
            channelCount:         { ideal: 2, exact: 2 },
            sampleRate:           { ideal: 48000 },
            sampleSize:           { ideal: 24 },
            echoCancellation:     { exact: false },
            noiseSuppression:     { exact: false },
            autoGainControl:      { exact: false },
            googEchoCancellation: { exact: false },
            googAutoGainControl:  { exact: false },
            googNoiseSuppression: { exact: false },
            googHighpassFilter:   { exact: false },
            googBeamforming:      { exact: false },
            googArrayGeometry:    { exact: false },
            googAudioMirroring:   { exact: true  },
            googNoiseReduction:   { exact: false },
            googExperimentalEchoCancellation: { exact: false },
            googExperimentalNoiseSuppression: { exact: false },
            googExperimentalAutoGainControl:  { exact: false },
        }),
        opus: Object.freeze({
            stereo:            '1',
            'sprop-stereo':    '1',
            cbr:               '1',
            maxaveragebitrate: '384000',
            maxplaybackrate:   '48000',
            usedtx:            '0',
            useinbandfec:      '0',
            minptime:          '10',
            ptime:             '10',
        }),
        bitrate: 384000
    });

    const State = new class {
        #live      = null;
        #processed = null;

        setRaw(track)       { this.#live = track; }
        getRaw()            { return this.#live; }
        setProcessed(track) { this.#processed = track; }
        getProcessed()      { return this.#processed; }
        outbound()  { 
            const p = this.#processed;
            return (p && p.readyState === 'live') ? p : this.#live; 
        }
        active()    { return this.outbound()?.readyState === 'live'; }
        foreign(t)  { return t?.kind === 'audio' && this.active() && t.id !== this.outbound()?.id; }
    };

    class SDPEditor {
        static process(sdp) {
            if (typeof sdp !== 'string') return sdp;
            try {
                const lines = sdp.split(/\r?\n/);
                const opusPayloads = new Set();

                for (const line of lines) {
                    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
                    if (match && match[1]) opusPayloads.add(match[1]);
                }

                const newLines = [];
                for (let line of lines) {
                    if (/^b=AS:\d+/i.test(line) || /^b=TIAS:\d+/i.test(line)) continue;

                    let modified = false;
                    for (const pt of opusPayloads) {
                        if (line.startsWith(`a=fmtp:${pt}`)) {
                            const parts = line.substring(`a=fmtp:${pt}`.length).trim().split(';');
                            const paramMap = {};
                            for (const p of parts) {
                                const [k, ...v] = p.trim().split('=');
                                if (k) paramMap[k.trim()] = v.join('=').trim();
                            }
                            const merged = { ...paramMap, ...CFG.opus };
                            const encodedParams = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join(';');
                            newLines.push(`a=fmtp:${pt} ${encodedParams}`);
                            modified = true;
                            break;
                        }
                    }
                    if (!modified) newLines.push(line);
                }
                return newLines.join('\r\n');
            } catch {
                return sdp;
            }
        }
    }

    class BitrateLayer {
        static #encoding(enc = {}) {
            return {
                ...enc,
                active: true,
                dtx: 'disabled',
                ptime: 10,
                maxBitrate: CFG.bitrate,
            };
        }

        static encodings(encs) {
            return (Array.isArray(encs) && encs.length ? encs : [{}]).map(e => BitrateLayer.#encoding(e));
        }

        static apply(sender) {
            if (!sender || typeof sender.getParameters !== 'function') return;
            if (sender?.track?.kind !== 'audio') return;
            try {
                const p = sender.getParameters();
                if (!p) return;
                p.encodings = (Array.isArray(p.encodings) && p.encodings.length ? p.encodings : [{}]).map(BitrateLayer.#encoding);
                sender.setParameters(p).then(() => {
                    if (sender.track) TrackLayer.purify(sender.track);
                }).catch(() => {});
            } catch {}
        }

        static track(pc) {
            if (!pc) return;
            const enforce = () => {
                try {
                    if (pc.connectionState === 'connected' || pc.connectionState === 'complete') {
                        pc.getSenders()?.forEach(s => {
                            if (s?.track?.kind === 'audio') BitrateLayer.apply(s);
                        });
                    }
                } catch {}
            };
            enforce();
            pc.addEventListener('connectionstatechange', enforce, { passive: true });
            pc.addEventListener('negotiationneeded', enforce, { passive: true });
        }

        static install() {
            try {
                const OrigPC = window.RTCPeerConnection;
                if (!OrigPC) return;
                window.RTCPeerConnection = new Proxy(OrigPC, {
                    construct(target, args) {
                        const pc = Reflect.construct(target, args);
                        BitrateLayer.track(pc);
                        return pc;
                    }
                });
                window.RTCPeerConnection.prototype = OrigPC.prototype;
                Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
            } catch {}
        }
    }

    class TrackLayer {
        static purify(track) {
            if (!track || track.kind !== 'audio') return;
            try { 
                track.contentHint = 'music'; 
                track.applyConstraints(CFG.mic).catch(() => {});
            } catch {}
        }
    }

    const sdpDesc   = (desc) => desc?.sdp ? { type: desc.type, sdp: SDPEditor.process(desc.sdp) } : desc;
    const sdpResult = async (promise) => {
        const r = await promise;
        return r?.sdp ? { type: r.type, sdp: SDPEditor.process(r.sdp) } : r;
    };

    class MicLayer {
        static install() {
            try {
                if (!navigator?.mediaDevices?.getUserMedia) return;
                const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                navigator.mediaDevices.getUserMedia = async (constraints) => {
                    if (constraints?.video && !constraints?.audio) return gum(constraints);
                    if (!constraints?.audio) return gum(constraints);

                    const deviceId = typeof constraints.audio === 'object' ? constraints.audio?.deviceId : undefined;
                    const audio = { ...CFG.mic, ...(deviceId ? { deviceId } : {}) };

                    const stream = await gum({ ...constraints, audio });
                    const t = stream?.getAudioTracks()?.[0];
                    if (t) {
                        State.setRaw(t);
                        TrackLayer.purify(t);
                        AudioPipelineLayer.ensureActive();
                        try {
                            const ctx = AudioPipelineLayer.getContext();
                            if (ctx) {
                                if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
                                const src = ctx.createMediaStreamSource(new MediaStream([t]));
                                AudioPipelineLayer.connectMicSource(src);
                            }
                        } catch {}
                    }
                    return stream;
                };
            } catch {}
        }
    }

    class AudioPipelineLayer {
        static #ctx = null;
        static #nodes = {};
        static #ready = false;
        static #highpassEnabled = true;

        static install() {
            AudioPipelineLayer.#boot();
            setInterval(() => AudioPipelineLayer.ensureActive(), 2000);
        }

        static #boot() {
            try {
                if (AudioPipelineLayer.#ctx && AudioPipelineLayer.#ctx.state !== 'closed') {
                    try { AudioPipelineLayer.#ctx.close(); } catch {}
                }

                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx({ sampleRate: 48000, latencyHint: 'interactive' });
                AudioPipelineLayer.#ctx = ctx;

                // Keepalive oscillator to prevent mobile browser suspension
                try {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.frequency.value = 18000;
                    gain.gain.value = 0.00001;
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start();
                } catch {}

                // True Stereo Dual-Channel Processing Pipeline (Left/Right split)
                const splitter = ctx.createChannelSplitter(2);
                const merger = ctx.createChannelMerger(2);

                const leftHp = ctx.createBiquadFilter();
                leftHp.type = 'highpass';
                leftHp.frequency.value = AudioPipelineLayer.#highpassEnabled ? 100 : 1;

                const rightHp = ctx.createBiquadFilter();
                rightHp.type = 'highpass';
                rightHp.frequency.value = AudioPipelineLayer.#highpassEnabled ? 100 : 1;

                const leftGain = ctx.createGain();
                const rightGain = ctx.createGain();
                leftGain.gain.value = 1;
                rightGain.gain.value = 1;

                const masterGain = ctx.createGain();
                masterGain.gain.value = 1;

                const analyser = ctx.createAnalyser();
                analyser.fftSize = 1024;

                const dest = ctx.createMediaStreamDestination();
                dest.channelCount = 2;
                dest.channelCountMode = 'explicit';
                dest.channelInterpretation = 'discrete';

                // Routing: Split -> [HPF -> Gain] -> Merger -> MasterGain -> Destination
                splitter.connect(leftHp, 0);
                leftHp.connect(leftGain);
                leftGain.connect(merger, 0, 0);

                splitter.connect(rightHp, 1);
                rightHp.connect(rightGain);
                rightGain.connect(merger, 0, 1);

                merger.connect(masterGain);
                masterGain.connect(dest);
                masterGain.connect(analyser);

                AudioPipelineLayer.#nodes = {
                    ctx, splitter, merger, leftHp, rightHp, leftGain, rightGain, masterGain, analyser, dest
                };
                AudioPipelineLayer.#ready = true;

                const outTrack = dest.stream?.getAudioTracks()?.[0];
                if (outTrack) {
                    TrackLayer.purify(outTrack);
                    State.setProcessed(outTrack);
                }
            } catch {
                AudioPipelineLayer.#ready = false;
            }
        }

        static ensureActive() {
            try {
                if (!AudioPipelineLayer.#ready || !AudioPipelineLayer.#ctx || AudioPipelineLayer.#ctx.state === 'closed') {
                    AudioPipelineLayer.#boot();
                } 
                if (AudioPipelineLayer.#ctx && AudioPipelineLayer.#ctx.state === 'suspended') {
                    AudioPipelineLayer.#ctx.resume().catch(() => {});
                }
            } catch {
                AudioPipelineLayer.#boot();
            }
        }

        static getContext() { return AudioPipelineLayer.#ctx; }
        static getNodes() { return AudioPipelineLayer.#nodes; }

        static connectMicSource(sourceNode) {
            try {
                AudioPipelineLayer.ensureActive();
                sourceNode?.connect(AudioPipelineLayer.#nodes.splitter);
            } catch {}
        }

        static setMasterGain(val) {
            try {
                AudioPipelineLayer.ensureActive();
                const v = Math.max(1, parseFloat(val) || 1);
                if (AudioPipelineLayer.#nodes.leftGain) AudioPipelineLayer.#nodes.leftGain.gain.value = v;
                if (AudioPipelineLayer.#nodes.rightGain) AudioPipelineLayer.#nodes.rightGain.gain.value = v;
            } catch {}
        }

        static setHighpass(enabled) {
            try {
                AudioPipelineLayer.#highpassEnabled = enabled;
                const freq = enabled ? 100 : 1;
                if (AudioPipelineLayer.#nodes.leftHp) AudioPipelineLayer.#nodes.leftHp.frequency.value = freq;
                if (AudioPipelineLayer.#nodes.rightHp) AudioPipelineLayer.#nodes.rightHp.frequency.value = freq;
            } catch {}
        }

        static resetAll() {
            try {
                AudioPipelineLayer.setMasterGain(1);
                AudioPipelineLayer.setHighpass(true);
            } catch {}
        }
    }

    class RTCLayer {
        static install() {
            try {
                const PC = window.RTCPeerConnection?.prototype;
                const RTP = window.RTCRtpSender?.prototype;
                if (!PC || !RTP) return;

                const origSetLocal = PC.setLocalDescription;
                PC.setLocalDescription = function(desc, ...args) {
                    return origSetLocal.call(this, sdpDesc(desc), ...args);
                };

                const origSetRemote = PC.setRemoteDescription;
                PC.setRemoteDescription = function(desc, ...args) {
                    return origSetRemote.call(this, sdpDesc(desc), ...args);
                };

                const origCreateOffer = PC.createOffer;
                PC.createOffer = function(...args) {
                    return sdpResult(origCreateOffer.apply(this, args));
                };

                const origCreateAnswer = PC.createAnswer;
                PC.createAnswer = function(...args) {
                    return sdpResult(origCreateAnswer.apply(this, args));
                };

                const origAddTrack = PC.addTrack;
                PC.addTrack = function (track, ...streams) {
                    let t = track;
                    if (t?.kind === 'audio' && State.foreign(t)) t = State.outbound();
                    const sender = origAddTrack.call(this, t, ...streams);
                    if (t?.kind === 'audio') BitrateLayer.apply(sender);
                    return sender;
                };

                const origReplaceTrack = RTP.replaceTrack;
                RTP.replaceTrack = async function(t) {
                    if (!t || t.kind !== 'audio') return origReplaceTrack.call(this, t);
                    const track = State.foreign(t) ? State.outbound() : t;
                    const r = await origReplaceTrack.call(this, track);
                    BitrateLayer.apply(this);
                    return r;
                };

                const origAddTransceiver = PC.addTransceiver;
                PC.addTransceiver = function (tk, init = {}) {
                    const isAudio = tk === 'audio' || tk?.kind === 'audio';
                    let settings = init;
                    if (isAudio) {
                        settings = { ...settings, sendEncodings: BitrateLayer.encodings(settings.sendEncodings) };
                    }
                    const tr = origAddTransceiver.call(this, tk, settings);
                    if (isAudio && tr?.sender) BitrateLayer.apply(tr.sender);
                    return tr;
                };
            } catch {}
        }
    }

    [BitrateLayer, MicLayer, AudioPipelineLayer, RTCLayer].forEach(m => { try { m.install(); } catch {} });

    // --- Mobile Floating HUD UI ---
    window.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('daes-mobile-hud')) return;

        const style = document.createElement('style');
        style.textContent = `
            #daes-mobile-hud, #daes-mobile-hud * { box-sizing: border-box; }
            #daes-mobile-hud {
                position: fixed; top: 40px; right: 10px; z-index: 2147483647;
                width: 290px; background: rgba(12, 14, 20, 0.95);
                border: 1px solid rgba(88, 101, 242, 0.5); border-radius: 12px;
                font: 12px/1.4 system-ui, sans-serif; color: #fff;
                box-shadow: 0 10px 30px rgba(0,0,0,0.8); backdrop-filter: blur(10px);
                user-select: none; overflow: hidden;
            }
            #daes-mobile-hud .hud-header {
                background: linear-gradient(135deg, #5865F2, #4752C4);
                padding: 10px 12px; font-weight: bold; font-size: 12px;
                display: flex; justify-content: space-between; align-items: center;
                cursor: grab;
            }
            #daes-mobile-hud .hud-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
            #daes-mobile-hud.minimized .hud-body { display: none; }
            .dm-row { display: flex; justify-content: space-between; align-items: center; font-weight: 600; color: #b9bbbe; font-size: 11px; }
            .dm-section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
            input[type=range] { width: 100%; accent-color: #5865F2; height: 6px; background: #2f3136; border-radius: 3px; }
            .dm-presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
            .dm-preset-btn { background: #2f3136; border: 1px solid #4f545c; color: #fff; padding: 4px 0; font-size: 10px; font-weight: bold; border-radius: 4px; cursor: pointer; text-align: center; }
            .dm-preset-btn.active { background: #5865F2; border-color: #7983f5; }
            #dm-gain-text { width: 60px; background: #202225; border: 1px solid #4f545c; color: #fff; text-align: center; border-radius: 4px; padding: 2px; font-size: 11px; font-weight: bold; }
            .dm-btn { background: #ed4245; color: #fff; border: none; padding: 8px; border-radius: 6px; font-weight: bold; font-size: 11px; cursor: pointer; text-align: center; width: 100%; }
            #dm-minimize { background: rgba(0,0,0,0.3); border: none; color: #fff; font-weight: bold; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; }
        `;
        document.head.appendChild(style);

        const hud = document.createElement('div');
        hud.id = 'daes-mobile-hud';
        hud.className = 'minimized';
        hud.innerHTML = `
            <div class="hud-header" id="dm-header">
                <span>🎙️ STEREO LOUDMIC HUD</span>
                <button id="dm-minimize">+</button>
            </div>
            <div class="hud-body">
                <div class="dm-section">
                    <div class="dm-row">
                        <span>Gain Boost (5000x)</span>
                        <input type="text" id="dm-gain-text" value="1">
                    </div>
                    <input type="range" id="dm-gain-range" min="1" max="5000" step="1" value="1">
                    <div class="dm-presets">
                        <button class="dm-preset-btn" data-val="1">1x</button>
                        <button class="dm-preset-btn" data-val="50">50x</button>
                        <button class="dm-preset-btn" data-val="500">500x</button>
                        <button class="dm-preset-btn" data-val="2000">2k</button>
                        <button class="dm-preset-btn" data-val="5000">5k</button>
                    </div>
                </div>
                <div class="dm-section">
                    <div class="dm-row">
                        <label for="dm-hp-toggle">100Hz Highpass Filter</label>
                        <input type="checkbox" id="dm-hp-toggle" checked style="width:16px;height:16px;accent-color:#5865F2;">
                    </div>
                </div>
                <button class="dm-btn" id="dm-reset">Reset Defaults</button>
            </div>
        `;
        document.body.appendChild(hud);

        const gainRange = document.getElementById('dm-gain-range');
        const gainText = document.getElementById('dm-gain-text');
        const hpToggle = document.getElementById('dm-hp-toggle');
        const resetBtn = document.getElementById('dm-reset');
        const minimizeBtn = document.getElementById('dm-minimize');
        const presetBtns = document.querySelectorAll('.dm-preset-btn');

        function updateGain(val) {
            let num = parseFloat(val);
            if (isNaN(num)) num = 1;
            num = Math.max(1, Math.min(5000, num));

            gainRange.value = num;
            gainText.value = num;
            AudioPipelineLayer.setMasterGain(num);

            presetBtns.forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.val) === num);
            });
        }

        gainRange.addEventListener('input', (e) => updateGain(e.target.value));
        gainText.addEventListener('change', (e) => updateGain(e.target.value));
        hpToggle.addEventListener('change', (e) => AudioPipelineLayer.setHighpass(e.target.checked));

        presetBtns.forEach(btn => {
            btn.addEventListener('click', () => updateGain(btn.dataset.val));
        });

        resetBtn.addEventListener('click', () => {
            updateGain(1);
            hpToggle.checked = true;
            AudioPipelineLayer.resetAll();
        });

        minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const min = hud.classList.toggle('minimized');
            minimizeBtn.textContent = min ? '+' : '—';
        });

        // Touch drag support for mobile screens
        let dragging = false, startX, startY, initX, initY;
        const header = document.getElementById('dm-header');
        header.addEventListener('touchstart', (e) => {
            dragging = true;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            initX = hud.offsetLeft;
            initY = hud.offsetTop;
        }, {passive: true});

        window.addEventListener('touchmove', (e) => {
            if (!dragging) return;
            let dx = e.touches[0].clientX - startX;
            let dy = e.touches[0].clientY - startY;
            hud.style.left = `${initX + dx}px`;
            hud.style.top = `${initY + dy}px`;
            hud.style.right = 'auto';
        }, {passive: true});

        window.addEventListener('touchend', () => { dragging = false; });
    });
})();
