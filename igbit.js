// ==UserScript==
// @name         WebRTC Ultimate Opus Max Spec Enforcer
// @namespace    http://tampermonkey.net/
// @version      4.0
// @match        https://*.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 1. Force max constraints on media creation
    const overrideMediaConstraints = (constraints) => {
        if (!constraints) return constraints;
        if (constraints.video) {
            if (typeof constraints.video === 'object') {
                constraints.video.frameRate = { ideal: 60, max: 60 };
                constraints.video.width = { ideal: 1920 };
                constraints.video.height = { ideal: 1080 };
                constraints.video.contentHint = 'motion';
            }
        }
        return constraints;
    };

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => origGUM(overrideMediaConstraints(c));
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        const origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = (c) => origGDM(overrideMediaConstraints(c));
    }

    // 2. Intercept SDP creation symmetrically for both Local and Remote descriptions
    const origSetLocalDescription = RTCPeerConnection.prototype.setLocalDescription;
    RTCPeerConnection.prototype.setLocalDescription = function(desc, ...args) {
        if (desc && desc.sdp) {
            desc.sdp = modifySdp(desc.sdp);
        }
        return origSetLocalDescription.call(this, desc, ...args);
    };

    const origSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function(desc, ...args) {
        if (desc && desc.sdp) {
            desc.sdp = modifySdp(desc.sdp);
        }
        return origSetRemoteDescription.call(this, desc, ...args);
    };

    function modifySdp(sdp) {
        let lines = sdp.split('\r\n');
        let modifiedLines = [];
        let currentMediaType = '';

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            if (line.startsWith('m=audio')) {
                currentMediaType = 'audio';
            } else if (line.startsWith('m=video')) {
                currentMediaType = 'video';
            } else if (line.startsWith('m=')) {
                currentMediaType = '';
            }

            // Target Opus Payload 111 specifically for inbound and outbound audio
            if (currentMediaType === 'audio' && line.startsWith('a=fmtp:111')) {
                // Strip out any existing constraints to prevent parameter conflicts
                line = 'a=fmtp:111 minptime=10;useinbandfec=0;usedtx=0;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1;maxplaybackrate=48000';
            }

            modifiedLines.push(line);

            // Inject high-performance video parameters right after media attributes
            if (line.startsWith('a=rtcp-mux')) {
                if (currentMediaType === 'video') {
                    modifiedLines.push('a=fmtp:108 max-mbps=489600;max-fs=36864;max-br=8000;max-fps=60');
                    modifiedLines.push('a=framerate:60');
                }
            }
        }

        let finalSdp = modifiedLines.join('\r\n');
        
        // Force global application-specific bandwidth limit to 8 Mbps video + max audio headroom
        finalSdp = finalSdp.replace(/b=AS:\d+/g, 'b=AS:8500');
        return finalSdp;
    }

    // 3. Force parameters on active tracks
    const origAddTrack = RTCPeerConnection.prototype.addTrack;
    RTCPeerConnection.prototype.addTrack = function(track, ...streams) {
        const sender = origAddTrack.apply(this, [track, ...streams]);
        if (track.kind === 'video') {
            track.contentHint = 'motion';
            setTimeout(() => applyMaxParameters(sender), 500);
        }
        return sender;
    };

    function applyMaxParameters(sender) {
        try {
            const params = sender.getParameters();
            if (params.encodings) {
                params.encodings.forEach(enc => {
                    enc.maxBitrate = 8000000; // 8 Mbps target
                    enc.maxFramerate = 60;
                    enc.scaleResolutionDownBy = 1.0;
                    if (enc.hasOwnProperty('degradationPreference')) {
                        enc.degradationPreference = 'maintain-framerate';
                    }
                });
                sender.setParameters(params).catch(e => console.error("Error setting sender parameters:", e));
            }
        } catch (err) {
            console.error(err);
        }
    }
})();