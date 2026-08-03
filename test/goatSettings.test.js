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
                cutMode: 7, cutModeName: 'fine', cutSpeedMps: 0.35,
                obstacleHeight: 3, obstacleModeName: 'highGrass',
                obstacleHeightCm: 20, angle: 90, appAngle: 180
            }]), true
        )).to.be.true;
    });

    it('should expose the exact app mappings for efficient mowing and avoidance', () => {
        expect(goatSettings.cutModeDetails(4)).to.deep.equal({
            cutModeName: 'efficient', cutSpeedMps: 0.5
        });
        expect(goatSettings.obstacleModeDetails(1)).to.deep.equal({
            obstacleModeName: 'shortGrass', obstacleHeightCm: 10
        });
        expect(goatSettings.heightCmToLevel(3)).to.equal(11);
        expect(goatSettings.heightCmToLevel(6.5)).to.equal(4);
        expect(goatSettings.heightCmToLevel(8)).to.equal(1);
        expect(goatSettings.heightCmToLevel(6.2)).to.equal(null);
        expect(goatSettings.directionProtocolToApp(270)).to.equal(0);
        expect(goatSettings.directionProtocolToApp(180)).to.equal(90);
        expect(goatSettings.directionProtocolToApp(90)).to.equal(180);
        expect(goatSettings.directionAppToProtocol(0)).to.equal(270);
        expect(goatSettings.directionAppToProtocol(90)).to.equal(180);
        expect(goatSettings.directionAppToProtocol(180)).to.equal(90);
    });

    it('should expose and mirror the confirmed global settings', () => {
        const handled = goatSettings.handlePayload(ctx, {
            getAutoCutDirection: { code: 0, data: { enable: 0 } },
            getRainDelay: { code: 0, data: { enable: 1, delay: 180 } },
            getAnimProtect: { code: 0, data: { enable: 0, start: '19:0', end: '7:0' } },
            getTimeZone: { code: 0, data: { tzm: 60, code: 'Europe/Berlin' } },
            getCustomCutMode: { code: 0, data: { enable: 1 } },
            getBorderSwitch: { code: 0, data: { enable: 1, mode: 1 } },
            getRecognization: { code: 0, data: { state: 1 } },
            getHumanoidAI: { code: 0, data: { enable: 0 } },
            getNarrowAdapt: { code: 0, data: { state: 0 } }
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
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.robotSettings.aiRecognition', true, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'control.goat.smartTrimmingAvoidance', false, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.robotSettings.narrowPathAdaptation', false, true
        )).to.be.true;
    });

    it('should expose maintenance values with their app units', () => {
        const handled = goatSettings.handlePayload(ctx, [
            { type: 'blade', left: 3074, total: 4800 },
            { type: 'weedRope', left: 68, total: 340 },
            { type: 'trimmerBrush', left: 23, total: 60 }
        ]);

        expect(handled).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.bladeRemainingMinutes', 3074, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.bladeRemainingHours', 52, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.trimmerLineRemainingUses', 68, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.trimmerBrushRemainingDays', 23, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.bladePercent', 65, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.maintenance.trimmerLineCondition', 'slightlyWorn', true
        )).to.be.true;
    });

    it('should reject an unverified mower model', () => {
        ctx.getModel().getDeviceClass.returns('other_class');
        expect(goatSettings.handlePayload(ctx, { areaParameters: [] })).to.be.false;
        expect(ctx.adapterProxy.setStateConditional.called).to.be.false;
    });
});
