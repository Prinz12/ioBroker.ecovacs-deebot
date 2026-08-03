'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const sinon = require('sinon');
const lzma = require('lzma-purejs');
const goatMap = require('../lib/goatMap');
const { createMockCtx } = require('./mockHelper');

/**
 * Encode JSON with the shortened LZMA-Alone header used by GOAT.
 * @param {unknown} value
 * @returns {string}
 */
function encodeGoatFixture(value) {
    const standard = Buffer.from(lzma.compressFile(Buffer.from(JSON.stringify(value))));
    return Buffer.concat([standard.subarray(0, 9), standard.subarray(13)]).toString('base64');
}

describe('goatMap.js', () => {
    it('should decode compact direction runs on the 50 mm grid', () => {
        expect(goatMap.decodeCompactPath('0,0;4(2)2(2)8(2)6(2)')).to.deep.equal([
            [0, 0], [50, 0], [100, 0], [100, 50], [100, 100],
            [50, 100], [0, 100], [0, 50], [0, 0]
        ]);
    });

    it('should decode GOAT shortened LZMA JSON', () => {
        const value = [['1', '3', '7', '23349', '8900', '0', '1']];
        expect(goatMap.decodeLzmaJson(encodeGoatFixture(value))).to.deep.equal(value);
    });

    it('should parse map layers and render an SVG', () => {
        const main = goatMap.parseMainGeometry([
            ['1', 's1;1;0,0;4(2)2(2)8(2)6(2)']
        ]);
        const trimBoundaries = goatMap.parseLayerGeometry([
            ['1', '5', '1', '3;0,0;4(2)2(2)']
        ], '5');
        const areas = goatMap.parseAreaMetadata([
            ['1', '1', '', '', '50', '50', '']
        ], 'ar');
        const tracks = goatMap.parseMapTrack([
            ['1', '1', '1;1;remaining;0,0;100,0'],
            ['1', '2', '1;2;completed;0,0;4(2)2(2)']
        ]);
        const svg = goatMap.renderSvg({
            main,
            trimBoundaries,
            areas,
            tracks,
            mowedTrail: [[0, 0, 50, 50]],
            position: { x: 50, y: 50, heading: 90, valid: true }
        });

        expect(main[0].aid).to.equal('1');
        expect(main[0].containsStation).to.be.true;
        expect(trimBoundaries[0].id).to.equal('3');
        expect(svg).to.include('<svg');
        expect(svg).to.include('Bereich 1');
        expect(svg).to.include('#8e24aa');
        expect(svg).to.include('#22c55e');
        expect(svg).to.include('GOAT position');
    });

    it('should render positioned subareas without local main-map templates', () => {
        const svg = goatMap.renderSvg({
            main: [{
                points: [[0, 0], [100, 0], [100, 100], [0, 100]]
            }],
            subareas: [{
                points: [[1000, 2000], [1100, 2000], [1100, 2100], [1000, 2100]]
            }]
        });

        expect(svg.match(/<polygon\b/gu)).to.have.lengthOf(1);
        expect(svg).not.to.include('fill="#dcedc8"');
        expect(svg).to.include('viewBox="500 -2600 1100 1100"');
    });

    it('should parse position, progress and chunked mowing tracks read-only', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        goatMap.handleWorkState(ctx, 'clean');

        expect(goatMap.handlePayload(ctx, {
            deebotPos: { x: 1250, y: -750, a: 45, invalid: 0 }
        })).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.positionX', 1250, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.positionValid', true, true
        )).to.be.true;
        expect(goatMap.handlePayload(ctx, {
            deebotPos: { x: 1450, y: -750, a: 90, invalid: 0 }
        })).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.mowedTrail', '[[1250,750,1450,750]]', true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.mapId', sinon.match.any, true
        )).to.be.false;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.svg', '', true
        )).to.be.false;

        expect(goatMap.handlePayload(ctx, {
            getStats: { code: 0, data: { mowedArea: 250000, area: 1000000 } },
            getBattery: { code: 0, data: { value: 80 } }
        })).to.be.false;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.mowedSquareMeters', 25, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.mowingProgress', 25, true
        )).to.be.true;

        const encoded = encodeGoatFixture([
            ['1', '1', '1;1;remaining;0,0;100,0'],
            ['1', '2', '1;2;completed;0,0;4(2)2(2)']
        ]);
        const middle = Math.floor(encoded.length / 2);
        expect(goatMap.handlePayload(ctx, {
            batid: 'batch-1', serial: '2', index: '0', totalWidth: 5000,
            totalHeight: 5000, info: encoded.slice(0, middle)
        })).to.be.true;
        expect(goatMap.handlePayload(ctx, {
            batid: 'batch-1', serial: '2', index: '1', totalWidth: 5000,
            totalHeight: 5000, info: encoded.slice(middle)
        })).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.completedTrackCount', 1, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.remainingTrackCount', 1, true
        )).to.be.true;
    });

    it('should bridge every multipart GOAT telemetry packet after normal dispatch', async () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        const original = sinon.stub().resolves('handled');
        const vacbot = { ecovacs: { dispatcher: { handleMessagePayload: original } } };
        const encoded = encodeGoatFixture([
            ['1', '1', '1;1;remaining;0,0;100,0'],
            ['1', '2', '1;2;completed;0,0;4(2)2(2)']
        ]);
        const middle = Math.floor(encoded.length / 2);

        expect(goatMap.registerTelemetryBridge(vacbot, ctx)).to.be.true;
        expect(goatMap.registerTelemetryBridge(vacbot, ctx)).to.be.true;
        expect(await vacbot.ecovacs.dispatcher.handleMessagePayload('_onMapTrack', {
            batid: 'batch-bridge', serial: '2', index: '0', info: encoded.slice(0, middle)
        })).to.equal('handled');
        await vacbot.ecovacs.dispatcher.handleMessagePayload('_onMapTrack', {
            batid: 'batch-bridge', serial: '2', index: '1', info: encoded.slice(middle)
        });

        expect(original.callCount).to.equal(2);
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.completedTrackCount', 1, true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.remainingTrackCount', 1, true
        )).to.be.true;
    });

    it('should replace plan updates instead of accumulating false completed stripes', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        const first = encodeGoatFixture([
            ['1', '2', '1;1;306;-1200,-2050;-1200,5450']
        ]);
        const second = encodeGoatFixture([
            ['1', '2', '1;1;306;-1200,-2050;-1200,3400']
        ]);

        goatMap.handlePayload(ctx, { batid: 'first', serial: '1', info: first });
        goatMap.handlePayload(ctx, { batid: 'second', serial: '1', info: second });

        expect(ctx.goatMapData.tracks.nonScheduledCompleted[0].lids[0].traces)
            .to.deep.equal([[-1200, 2050, -1200, -3400]]);
    });

    it('should not burn live position or trail into the persisted base SVG', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        goatMap.handleWorkState(ctx, 'clean');
        ctx.goatMapData.main = [{ points: [[0, 0], [100, 0], [100, 100]] }];
        ctx.adapterProxy.setStateConditional.resetHistory();

        goatMap.handlePayload(ctx, {
            deebotPos: { x: 50, y: 50, a: 30, invalid: 0 }
        });

        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.mowedTrail', '[[50,-50]]', true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'map.goat.svg', sinon.match.any, true
        )).to.be.false;
    });

    it('should consume getMI and queue only read-only map follow-ups', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        ctx.intervalQueue = {
            add: sinon.stub(),
            runAll: sinon.stub()
        };
        const payload = {
            mid: '1',
            type: '0',
            centerX: '50',
            centerY: '50',
            info: encodeGoatFixture([
                ['1', 's1;1;0,0;4(2)2(2)8(2)6(2)']
            ])
        };

        expect(goatMap.handlePayload(ctx, payload)).to.be.true;
        expect(ctx.intervalQueue.add.calledWith(
            'Generic', 'getAreaSet', { mid: '1', aid: '0', type: 'ar' }
        )).to.be.true;
        expect(ctx.intervalQueue.add.calledWith(
            'Generic', 'getArI', { mid: '1', aid: '1', type: '5' }
        )).to.be.true;
        expect(ctx.intervalQueue.runAll.calledOnce).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith('map.goat.mapId', '1', true)).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith('map.goat.status', 'ready', true)).to.be.true;
    });

    it('should reject map refreshes for unverified mower classes', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('other_class');
        ctx.intervalQueue.run = sinon.stub();

        expect(goatMap.requestMap(ctx)).to.be.false;
        expect(ctx.intervalQueue.run.called).to.be.false;
    });

    it('should dispatch only the isolated read-only static map request on refresh', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        ctx.intervalQueue.resetQueue = sinon.stub();

        expect(goatMap.requestMap(ctx)).to.be.true;
        expect(ctx.intervalQueue.resetQueue.calledOnce).to.be.true;
        expect(ctx.vacbot.run.calledOnceWith(
            'Generic', 'getMI', { type: '0' }
        )).to.be.true;
        expect(ctx.adapter.setState.calledWith(
            'test_device.map.goat.status', 'loading', true
        )).to.be.true;
    });
});
