// ==UserScript==
// @name         Discord Web - Zero Filters + 20x Gain
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Disables all Chromium mic processing and boosts raw audio gain by 20x.
// @match        https://discord.com/*
// @grant        none
// @license      MIT
// @author       jaysos toenail
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const GAIN_FACTOR = 20.0; // Fixed 20x Gain Multiplier

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (constraints && constraints.audio) {
            // Strip all software-level DSP, filters, and gain controllers
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
            // Instantiate Web Audio API node pipeline
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            
            // Ensure context is running if browser starts it suspended
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const source = audioCtx.createMediaStreamSource(stream);
            const gainNode = audioCtx.createGain();
            const destination = audioCtx.createMediaStreamDestination();

            // Set hard 20x multiplication factor
            gainNode.gain.value = GAIN_FACTOR;

            source.connect(gainNode);
            gainNode.connect(destination);

            return destination.stream;
        } catch (e) {
            console.error("Failed to inject 20x gain node pipeline:", e);
            return stream;
        }
    };
})();
