'use strict';
/* global window */

function encodeMessage(value) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/u, '');
}

function decodeMessage(value) {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
}

const codec = { encodeMessage, decodeMessage };

if (typeof module !== 'undefined' && module.exports) module.exports = codec;
else window.GoatCameraCodec = codec;
