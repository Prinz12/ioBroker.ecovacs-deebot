'use strict';
/* global window */

function selectGoatVideoCodecs(capabilities) {
    const codecs = Array.isArray(capabilities?.codecs) ? capabilities.codecs : [];
    return codecs.filter(codec => String(codec?.mimeType || '').toLowerCase() === 'video/h264');
}

function applyGoatVideoCodecPreferences(transceiver, receiverApi) {
    const capabilities = receiverApi?.getCapabilities?.('video');
    const codecs = selectGoatVideoCodecs(capabilities);
    if (!codecs.length) {
        throw new Error('Dieser Browser bietet keinen H.264-Videodecoder für die GOAT-Kamera an');
    }
    transceiver.setCodecPreferences(codecs);
    return codecs;
}

const goatCameraCodecs = { selectGoatVideoCodecs, applyGoatVideoCodecPreferences };

if (typeof module !== 'undefined' && module.exports) module.exports = goatCameraCodecs;
else window.GoatCameraCodecs = goatCameraCodecs;
