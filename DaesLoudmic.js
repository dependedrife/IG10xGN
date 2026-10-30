// ==UserScript==
// @name         Discord Web - Zero Filters + 20x Gain (Upgraded)
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Disables all Chromium mic processing, activates tracks, and boosts raw audio gain by 20x safely.
// @match        https://discord.com/*
// @grant        none
// @license      MIT
// @author       jaysos toenail
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const GAIN_FACTOR = 20.0; // Fixed 20x Gain Multiplier (~+26dB)

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (constraints && constraints.audio) {
            // Strip all software-level DSP, filters, AGC, and noise suppression
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
                googExperimentalEchoCancellation: false
            };

            if (typeof constraints.audio === 'object') {
                constraints.audio = { ...constraints.audio, ...rawAudioSettings };
            } else {
                constraints.audio = rawAudioSettings;
            }
        }

        const stream = await originalGetUserMedia(constraints);

        try {
            // Ensure audio tracks are fully enabled
            stream.getAudioTracks().forEach(track => {
                track.enabled = true;
            });

            // If no audio track exists, return stream unmodified
            if (stream.getAudioTracks().length === 0) {
                return stream;
            }

            // Instantiate Web Audio API node pipeline
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            const audioCtx = new AudioContextClass();

            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const gainNode = audioCtx.createGain();
            const destination = audioCtx.createMediaStreamDestination();

            // Set hard 20x multiplication factor
            gainNode.gain.value = GAIN_FACTOR;

            // Connect pipeline: Source -> Gain -> Destination
            source.connect(gainNode);
            gainNode.connect(destination);

            // Append processed audio track to original stream tracks if needed, 
            // or return the new destination stream containing the boosted audio track
            const processedStream = destination.stream;
            stream.getVideoTracks().forEach(videoTrack => {
                processedStream.addTrack(videoTrack);
            });

            return processedStream;
        } catch (e) {
            console.error("Failed to inject 20x gain node pipeline:", e);
            return stream;
        }
    };
})();
