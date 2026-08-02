'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const {
    selectGoatVideoCodecs,
    applyGoatVideoCodecPreferences
} = require('../www/goat-camera-codecs');

describe('goatCameraCodecs.js', () => {
    const capabilities = {
        codecs: [
            { mimeType: 'video/VP8', clockRate: 90000 },
            { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f' },
            { mimeType: 'video/AV1', clockRate: 90000 },
            { mimeType: 'video/h264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42001f' }
        ]
    };

    it('keeps only H.264 codecs in browser preference order', () => {
        expect(selectGoatVideoCodecs(capabilities)).to.deep.equal([
            capabilities.codecs[1],
            capabilities.codecs[3]
        ]);
    });

    it('applies the H.264-only preferences to the video transceiver', () => {
        let applied;
        const transceiver = { setCodecPreferences: codecs => { applied = codecs; } };
        const selected = applyGoatVideoCodecPreferences(transceiver, {
            getCapabilities: media => media === 'video' ? capabilities : undefined
        });

        expect(applied).to.deep.equal(selected);
        expect(applied).to.have.length(2);
    });

    it('fails clearly when the browser cannot decode H.264', () => {
        expect(() => applyGoatVideoCodecPreferences({ setCodecPreferences() {} }, {
            getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] })
        })).to.throw('keinen H.264-Videodecoder');
    });
});
