// ==UserScript==
// @name         Mic 10x Gain Booster
// @namespace    http://tampermonkey.net/
// @version      1.2
// @match        *://*/*
// @exclude      *://*.discord.com/*
// @author       marse
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const GAIN_MULTIPLIER = 10;

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
        const stream = await originalGetUserMedia(constraints);
        const [originalAudioTrack] = stream.getAudioTracks();

        if (constraints.audio && originalAudioTrack) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                const audioCtx = new AudioContextClass();
                const source = audioCtx.createMediaStreamSource(stream);
                const gainNode = audioCtx.createGain();
                const destination = audioCtx.createMediaStreamDestination();

                gainNode.gain.value = GAIN_MULTIPLIER;

                source.connect(gainNode);
                gainNode.connect(destination);

                const [enhancedAudioTrack] = destination.stream.getAudioTracks();
                stream.removeTrack(originalAudioTrack);
                stream.addTrack(enhancedAudioTrack);

                console.log(`[Mic Booster] Audio boosted by ${GAIN_MULTIPLIER}x`);
            } catch (e) {
                console.error("[Mic Booster error]:", e);
            }
        }

        return stream;
    };
})();
