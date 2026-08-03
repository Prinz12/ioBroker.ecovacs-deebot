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
            position: { x: 50, y: 50, heading: 90, valid: true }
        });

        expect(main[0].aid).to.equal('1');
        expect(main[0].containsStation).to.be.true;
        expect(trimBoundaries[0].id).to.equal('3');
        expect(svg).to.include('<svg');
        expect(svg).to.include('Bereich 1');
        expect(svg).to.include('#8e24aa');
        expect(svg).to.include('#2e7d32');
        expect(svg).to.include('GOAT position');
    });

    it('should parse position, progress and chunked mowing tracks read-only', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');

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

    it('should queue only read-only static and live map requests on refresh', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        ctx.intervalQueue.add = sinon.stub();
        ctx.intervalQueue.runAll = sinon.stub();

        expect(goatMap.requestMap(ctx)).to.be.true;
        expect(ctx.intervalQueue.add.calledWith(
            'Generic', 'getMI', { type: '0' }
        )).to.be.true;
        expect(ctx.intervalQueue.add.calledWith(
            'Generic', 'getPos', ['chargePos', 'deebotPos']
        )).to.be.true;
        expect(ctx.intervalQueue.add.calledWith('Generic', 'getMapTrack')).to.be.true;
        expect(ctx.intervalQueue.add.calledWith(
            'Generic', 'getInfo', ['getStats']
        )).to.be.true;
        expect(ctx.intervalQueue.runAll.calledOnce).to.be.true;
    });
});
