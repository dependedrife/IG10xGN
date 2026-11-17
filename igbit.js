// ==UserScript==
// @name         Instagram WebRTC Ultimate Max Fidelity Enforcer
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Symmetrically forces maximum uncompressed H.264 video (20Mbps, Level 5.1) and full-blast Opus audio (510kbps CBR, Stereo, No DTX/FEC, 48kHz) inbound and outbound.
// @author       marse
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Full-blast Max Fidelity Opus Configuration (Payload 111)
    const OPUS_MAX_FMTP = "cbr=1;maxaveragebitrate=510000;maxplaybackrate=48000;minptime=10;sprop-maxcapturerate=48000;sprop-stereo=1;stereo=1;usedtx=0;useinbandfec=0";
    
    // Maximum Uncompressed H.264 Video Configuration (Payload 108)
    const H264_MAX_FMTP = "level-asymmetry-allowed=1;max-br=20000;packetization-mode=1;profile-level-id=42e033;sps-pps-idr-in-keyframe=1";

    function sanitizeSdp(sdpText) {
        if (!sdpText || typeof sdpText !== 'string') return sdpText;

        const lines = sdpText.split(/\r?\n/);
        const updatedLines = lines.map(line => {
            // Force absolute max Opus fidelity inbound & outbound (Payload 111)[cite: 1]
            if (line.startsWith('a=fmtp:111') || (line.includes('opus/48000') && line.includes('maxaveragebitrate'))) {
                return `a=fmtp:111 ${OPUS_MAX_FMTP}`;
            }
            // Force maximum uncompressed H.264 profile & bitrate ceiling (Payload 108)[cite: 1]
            if (line.startsWith('a=fmtp:108')) {
                return `a=fmtp:108 ${H264_MAX_FMTP}`;
            }
            return line;
        });

        return updatedLines.join('\r\n');
    }

    function processDescription(desc) {
        if (desc && typeof desc.sdp === 'string') {
            desc.sdp = sanitizeSdp(desc.sdp);
        }
        return desc;
    }

    // Intercept local descriptions (Outbound)
    const origSetLocal = window.RTCPeerConnection.prototype.setLocalDescription;
    window.RTCPeerConnection.prototype.setLocalDescription = function(desc) {
        processDescription(desc);
        return origSetLocal.apply(this, arguments);
    };

    // Intercept remote descriptions (Inbound)
    const origSetRemote = window.RTCPeerConnection.prototype.setRemoteDescription;
    window.RTCPeerConnection.prototype.setRemoteDescription = function(desc) {
        processDescription(desc);
        return origSetRemote.apply(this, arguments);
    };

    console.info("[Tampermonkey] Ultimate Max Fidelity Instagram WebRTC Enforcer Initialized.");
})();