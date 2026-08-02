'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const { encodeMessage, decodeMessage } = require('../www/goat-camera-codec');

describe('goatCameraCodec.js', () => {
    it('encodes signaling payloads as URL-safe Base64 without padding', () => {
        const payload = { sdp: '\u083e', type: 'offer' };
        const standardBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
        const encoded = encodeMessage(payload);

        expect(standardBase64).to.match(/[+=]/u);
        expect(encoded).not.to.match(/[+/=]/u);
        expect(decodeMessage(encoded)).to.deep.equal(payload);
    });

    it('also decodes standard padded Base64 received from AWS', () => {
        const payload = { candidate: 'candidate:1 1 UDP 1 192.0.2.1 9 typ host' };
        const standardBase64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));

        expect(decodeMessage(standardBase64)).to.deep.equal(payload);
    });
});
