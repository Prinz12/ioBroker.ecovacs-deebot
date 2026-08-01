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
        const svg = goatMap.renderSvg({ main, trimBoundaries, areas });

        expect(main[0].aid).to.equal('1');
        expect(main[0].containsStation).to.be.true;
        expect(trimBoundaries[0].id).to.equal('3');
        expect(svg).to.include('<svg');
        expect(svg).to.include('Bereich 1');
        expect(svg).to.include('#8e24aa');
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
});
