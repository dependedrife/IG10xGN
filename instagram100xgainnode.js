// ==UserScript==
// @name         Instagram Mic 10x Gain Booster
// @namespace    http://tampermonkey.net/
// @version      1.0
// @match        https://www.instagram.com/*
// @author       marse
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const GainMultiplier = 10; // 10x gain boost

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function(constraints) {
        const stream = await originalGetUserMedia(constraints);

        // Only modify if the stream contains an audio track
        if (constraints && constraints.audio && stream.getAudioTracks().length > 0) {
            try {
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const source = audioCtx.createMediaStreamSource(stream);
                const gainNode = audioCtx.createGain();

                gainNode.gain.value = GainMultiplier;

                // Destination node that feeds back into the browser's media stream pipeline
                const destination = audioCtx.createMediaStreamDestination();

                source.connect(gainNode);
                gainNode.connect(destination);

                // Combine the amplified audio track with existing video tracks if any
                const enhancedAudioTrack = destination.stream.getAudioTracks()[0];
                stream.removeTrack(stream.getAudioTracks()[0]);
                stream.addTrack(enhancedAudioTrack);

                console.log(`[Mic Booster] Audio boosted by ${GainMultiplier}x`);
            } catch (e) {
                console.error("[Mic Booster error]:", e);
            }
        }

        return stream;
    };
})();
