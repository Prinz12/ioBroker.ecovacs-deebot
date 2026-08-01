'use strict';

const { expect } = require('chai');
const { describe, it, beforeEach } = require('mocha');
const { createMockAdapter, createMockCtx } = require('./mockHelper');
const goatSettings = require('../lib/goatSettings');

describe('goatSettings.js', () => {
    let ctx;

    beforeEach(() => {
        ctx = createMockCtx({ adapter: createMockAdapter() });
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
    });

    it('should expose per-area settings with the O1200 height in centimetres', () => {
        const handled = goatSettings.handlePayload(ctx, {
            areaParameters: [{
                areaID: '1', mowHeightLevel: 7, cutMode: 7,
                obstacleHeight: 3, angle: 90
            }]
        });

        expect(handled).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.settings.areaParameters', JSON.stringify([{
                areaID: '1', mowHeightLevel: 7, cutHeightCm: 5,
                cutMode: 7, obstacleHeight: 3, angle: 90
            }]), true
        )).to.be.true;
    });

    it('should expose and mirror the confirmed global settings', () => {
        const handled = goatSettings.handlePayload(ctx, {
            getAutoCutDirection: { code: 0, data: { enable: 0 } },
            getRainDelay: { code: 0, data: { enable: 1, delay: 180 } },
            getAnimProtect: { code: 0, data: { enable: 0, start: '19:0', end: '7:0' } },
            getTimeZone: { code: 0, data: { tzm: 60, code: 'Europe/Berlin' } },
            getCustomCutMode: { code: 0, data: { enable: 1 } },
            getBorderSwitch: { code: 0, data: { enable: 1, mode: 1 } }
        });

        expect(handled).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.settings.rainDelayMinutes', 180, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'control.goat.rainDelayMinutes', 180, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.settings.animalProtectionStart', '19:00', true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.settings.customCutMode', true, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.settings.borderMode', 1, true
        )).to.be.true;
    });

    it('should reject an unverified mower model', () => {
        ctx.getModel().getDeviceClass.returns('other_class');
        expect(goatSettings.handlePayload(ctx, { areaParameters: [] })).to.be.false;
        expect(ctx.adapterProxy.setStateConditional.called).to.be.false;
    });
});
