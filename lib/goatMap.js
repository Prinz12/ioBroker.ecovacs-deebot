'use strict';

const lzma = require('lzma-purejs');
const helper = require('./adapterHelper');

const DIRECTIONS = Object.freeze({
    1: [-50, 50],
    2: [0, 50],
    3: [50, 50],
    4: [50, 0],
    5: [50, -50],
    6: [0, -50],
    7: [-50, -50],
    8: [-50, 0]
});

const GEOMETRY_LAYERS = Object.freeze({
    1: 'subareas',
    2: 'virtualBoundaries',
    4: 'noGoZones',
    5: 'trimBoundaries'
});

/**
 * Check whether GOAT map reads are verified for this device.
 * @param {object} ctx
 * @returns {boolean}
 */
function isSupported(ctx) {
    return helper.supportsLawnMowerInfo(
        ctx.getPlatformType(), ctx.getModel().getDeviceClass()
    );
}

/**
 * Decode the shortened LZMA-Alone payload used by the GOAT map API.
 * @param {string} value Base64 encoded payload
 * @returns {unknown}
 */
function decodeLzmaJson(value) {
    const compressed = Buffer.from(value, 'base64');
    if (compressed.length < 9) {
        throw new Error('GOAT map payload is too short');
    }
    // GOAT omits the high four bytes of the standard eight-byte output size.
    const normalized = Buffer.concat([
        compressed.subarray(0, 9),
        Buffer.alloc(4),
        compressed.subarray(9)
    ]);
    const decoded = Buffer.from(lzma.decompressFile(normalized)).toString('utf8');
    return JSON.parse(decoded);
}

/**
 * Decode a GOAT path consisting of an absolute point followed by 50 mm steps.
 * @param {string} value
 * @returns {Array<Array<number>>}
 */
function decodeCompactPath(value) {
    const points = [];
    let x = 0;
    let y = 0;
    for (const rawSegment of String(value).split(';')) {
        const segment = rawSegment.trim();
        if (!segment) continue;
        if (segment.includes(',')) {
            const coordinates = segment.split(',', 2).map(Number);
            if (coordinates.every(Number.isFinite)) {
                [x, y] = coordinates;
                points.push([x, y]);
            }
            continue;
        }
        let index = 0;
        while (index < segment.length) {
            const direction = segment[index];
            index += 1;
            if (!DIRECTIONS[direction]) continue;
            let count = 1;
            if (segment[index] === '(') {
                const end = segment.indexOf(')', index + 1);
                if (end < 0) break;
                const parsedCount = Number(segment.slice(index + 1, end));
                count = Number.isInteger(parsedCount) && parsedCount > 0 ? parsedCount : 1;
                index = end + 1;
            }
            const [dx, dy] = DIRECTIONS[direction];
            for (let step = 0; step < count; step++) {
                x += dx;
                y += dy;
                points.push([x, y]);
            }
        }
    }
    return points;
}

/**
 * Calculate bounds and polygon area for a path.
 * @param {Array<Array<number>>} points
 * @returns {{pointCount:number, bounds:object|null, squareMeters:number}}
 */
function summarizePath(points) {
    if (!points.length) {
        return { pointCount: 0, bounds: null, squareMeters: 0 };
    }
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    let twiceArea = 0;
    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        twiceArea += current[0] * next[1] - next[0] * current[1];
    }
    return {
        pointCount: points.length,
        bounds: {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys)
        },
        squareMeters: Math.round(Math.abs(twiceArea) / 20000) / 100
    };
}

/**
 * Parse the main-map geometry returned by getMI.
 * @param {unknown} decoded
 * @returns {Array<object>}
 */
function parseMainGeometry(decoded) {
    const result = [];
    if (!Array.isArray(decoded)) return result;
    for (const group of decoded) {
        if (!Array.isArray(group) || group[0] !== '1') continue;
        for (const item of group.slice(1)) {
            if (typeof item !== 'string') continue;
            const firstSeparator = item.indexOf(';');
            const secondSeparator = item.indexOf(';', firstSeparator + 1);
            if (firstSeparator < 0 || secondSeparator < 0) continue;
            const rawId = item.slice(0, firstSeparator);
            const points = decodeCompactPath(item.slice(secondSeparator + 1)).slice(1);
            result.push({
                aid: rawId.replace(/^s/, ''),
                containsStation: rawId.startsWith('s'),
                points,
                ...summarizePath(points)
            });
        }
    }
    return result;
}

/**
 * Parse one getArI geometry response.
 * @param {unknown} decoded
 * @param {string} requestedType
 * @returns {Array<object>}
 */
function parseLayerGeometry(decoded, requestedType) {
    const result = [];
    if (!Array.isArray(decoded)) return result;
    for (const group of decoded) {
        if (!Array.isArray(group) || String(group[1]) !== requestedType || group[2] === '0') continue;
        for (const item of group.slice(3)) {
            if (typeof item !== 'string' || !item.includes(';')) continue;
            const separator = item.indexOf(';');
            const points = decodeCompactPath(item.slice(separator + 1));
            result.push({
                aid: String(group[0]),
                id: item.slice(0, separator),
                points,
                ...summarizePath(points)
            });
        }
    }
    return result;
}

/**
 * Replace the geometry belonging to areas present in a newly received layer.
 * @param {Array<object>} current
 * @param {Array<object>} incoming
 * @param {string} requestedAreaId
 * @returns {Array<object>}
 */
function mergeLayerGeometry(current, incoming, requestedAreaId) {
    const changedAreaIds = new Set([
        requestedAreaId,
        ...incoming.map(item => item.aid)
    ].filter(Boolean));
    return [
        ...current.filter(item => !changedAreaIds.has(item.aid)),
        ...incoming
    ];
}

/**
 * Parse getAreaSet metadata for areas or virtual boundaries.
 * @param {unknown} decoded
 * @param {string} type
 * @returns {Array<object>}
 */
function parseAreaMetadata(decoded, type) {
    if (!Array.isArray(decoded)) return [];
    if (type === 'ar') {
        return decoded.filter(Array.isArray).map(row => ({
            aid: String(row[0] ?? ''),
            said: String(row[1] ?? ''),
            name: String(row[2] ?? ''),
            connectedIds: String(row[3] ?? ''),
            centerX: Number(row[4]) || 0,
            centerY: Number(row[5]) || 0,
            cleanSetting: String(row[6] ?? '')
        }));
    }
    if (type === 'vw') {
        return decoded.filter(Array.isArray).map(row => ({
            aid: String(row[0] ?? ''),
            vid: String(row[1] ?? ''),
            boundaryType: String(row[2] ?? ''),
            centerX: Number(row[3]) || 0,
            centerY: Number(row[4]) || 0
        }));
    }
    return [];
}

/**
 * Escape dynamic text placed in SVG markup.
 * @param {unknown} value
 * @returns {string}
 */
function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

/**
 * Convert a point list to SVG coordinates, flipping the device Y axis.
 * @param {Array<Array<number>>} points
 * @returns {string}
 */
function svgPoints(points) {
    return points.map(point => `${point[0]},${-point[1]}`).join(' ');
}

/**
 * Render the currently known GOAT geometry as a standalone SVG.
 * @param {object} mapData
 * @returns {string}
 */
function renderSvg(mapData) {
    const main = mapData.main || [];
    const allPoints = main.flatMap(item => item.points);
    if (!allPoints.length) return '';
    const xs = allPoints.map(point => point[0]);
    const ys = allPoints.map(point => -point[1]);
    const padding = 500;
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    const width = Math.max(...xs) - Math.min(...xs) + padding * 2;
    const height = Math.max(...ys) - Math.min(...ys) + padding * 2;
    const colors = ['#9ccc65', '#81c784', '#66bb6a', '#aed581', '#7cb342'];
    const elements = [];

    for (const item of main) {
        elements.push(`<polygon points="${svgPoints(item.points)}" fill="#dcedc8" stroke="#558b2f" stroke-width="120"/>`);
    }
    for (const [index, item] of (mapData.subareas || []).entries()) {
        elements.push(`<polygon points="${svgPoints(item.points)}" fill="${colors[index % colors.length]}" fill-opacity="0.55" stroke="#ffffff" stroke-width="80"/>`);
    }
    const overlayStyles = [
        ['virtualBoundaries', '#ff9800', '160'],
        ['noGoZones', '#f44336', '180'],
        ['trimBoundaries', '#8e24aa', '150']
    ];
    for (const [layer, color, strokeWidth] of overlayStyles) {
        for (const item of mapData[layer] || []) {
            elements.push(`<polyline points="${svgPoints(item.points)}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
        }
    }
    for (const area of mapData.areas || []) {
        const label = area.name || `Bereich ${area.said}`;
        elements.push(`<text x="${area.centerX}" y="${-area.centerY}" font-size="650" text-anchor="middle" fill="#1b5e20" stroke="#ffffff" stroke-width="25" paint-order="stroke">${escapeXml(label)}</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" role="img" aria-label="GOAT lawn map">${elements.join('')}</svg>`;
}

/**
 * Create or return the per-device in-memory map cache.
 * @param {object} ctx
 * @returns {object}
 */
function getMapData(ctx) {
    if (!ctx.goatMapData) {
        ctx.goatMapData = {
            mapId: '',
            centerX: 0,
            centerY: 0,
            main: [],
            areas: [],
            virtualBoundaryMetadata: [],
            subareas: [],
            virtualBoundaries: [],
            noGoZones: [],
            trimBoundaries: [],
            chunks: new Map(),
            followUpsRequestedForMapId: ''
        };
    }
    return ctx.goatMapData;
}

/**
 * Return a complete Base64 payload, assembling response chunks when necessary.
 * @param {object} ctx
 * @param {object} payload
 * @param {string} field
 * @returns {string|null}
 */
function assemblePayload(ctx, payload, field) {
    const total = Math.max(1, Number(payload.serial) || 1);
    if (total === 1) return payload[field];
    const key = [field, payload.mid, payload.aid, payload.type, payload.batid].join(':');
    const mapData = getMapData(ctx);
    if (!mapData.chunks.has(key)) mapData.chunks.set(key, new Map());
    const chunks = mapData.chunks.get(key);
    chunks.set(Number(payload.index) || 0, payload[field]);
    if (chunks.size < total) return null;
    const joined = [...chunks.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(entry => entry[1])
        .join('');
    mapData.chunks.delete(key);
    return joined;
}

/**
 * Queue the map layers that depend on the map id returned by getMI.
 * @param {object} ctx
 * @param {string} mapId
 * @param {Array<object>} main
 */
function requestFollowUps(ctx, mapId, main) {
    const mapData = getMapData(ctx);
    if (mapData.followUpsRequestedForMapId === mapId) return;
    mapData.followUpsRequestedForMapId = mapId;
    const areaIds = [...new Set(main.map(item => item.aid).filter(Boolean))];
    ctx.intervalQueue.add('Generic', 'getAreaSet', { mid: mapId, aid: '0', type: 'ar' });
    ctx.intervalQueue.add('Generic', 'getAreaSet', { mid: mapId, aid: '0', type: 'vw' });
    ctx.intervalQueue.add('Generic', 'getArI', { mid: mapId, aid: '0', type: '1' });
    for (const aid of areaIds) {
        for (const type of ['2', '4', '5']) {
            ctx.intervalQueue.add('Generic', 'getArI', { mid: mapId, aid, type });
        }
    }
    ctx.intervalQueue.runAll();
}

/**
 * Persist map metadata, geometry JSON and SVG into ioBroker states.
 * @param {object} ctx
 */
function writeMapStates(ctx) {
    const mapData = getMapData(ctx);
    const areaIds = mapData.areas.map(area => area.said).filter(Boolean);
    const trimIds = mapData.trimBoundaries.map(item => item.id).filter(Boolean);
    const virtualIds = mapData.virtualBoundaries.map(item => item.id).filter(Boolean);
    const noGoIds = mapData.noGoZones.map(item => item.id).filter(Boolean);
    const geometry = {
        main: mapData.main,
        subareas: mapData.subareas,
        virtualBoundaries: mapData.virtualBoundaries,
        noGoZones: mapData.noGoZones,
        trimBoundaries: mapData.trimBoundaries
    };
    const squareMeters = mapData.main.reduce((sum, item) => sum + item.squareMeters, 0);
    ctx.adapterProxy.setStateConditional('map.goat.mapId', mapData.mapId, true);
    ctx.adapterProxy.setStateConditional('map.goat.centerX', mapData.centerX, true);
    ctx.adapterProxy.setStateConditional('map.goat.centerY', mapData.centerY, true);
    ctx.adapterProxy.setStateConditional('map.goat.squareMeters', Math.round(squareMeters * 100) / 100, true);
    ctx.adapterProxy.setStateConditional('map.goat.areaIds', JSON.stringify(areaIds), true);
    ctx.adapterProxy.setStateConditional('map.goat.areas', JSON.stringify(mapData.areas), true);
    ctx.adapterProxy.setStateConditional('map.goat.trimBoundaryIds', JSON.stringify(trimIds), true);
    ctx.adapterProxy.setStateConditional('map.goat.virtualBoundaryIds', JSON.stringify(virtualIds), true);
    ctx.adapterProxy.setStateConditional('map.goat.noGoZoneIds', JSON.stringify(noGoIds), true);
    ctx.adapterProxy.setStateConditional('map.goat.geometry', JSON.stringify(geometry), true);
    ctx.adapterProxy.setStateConditional('map.goat.svg', renderSvg(mapData), true);
    ctx.adapterProxy.setStateConditional('map.goat.lastUpdate', Date.now(), true);
    ctx.adapterProxy.setStateConditional('map.goat.status', 'ready', true);
    ctx.adapterProxy.setStateConditional('map.goat.lastError', '', true);
}

/**
 * Start a model-gated read-only map refresh.
 * @param {object} ctx
 * @returns {boolean}
 */
function requestMap(ctx) {
    if (!isSupported(ctx)) {
        ctx.adapter.log.warn('GOAT map reads are not verified for this mower model');
        return false;
    }
    const mapData = getMapData(ctx);
    mapData.followUpsRequestedForMapId = '';
    mapData.chunks.clear();
    ctx.adapterProxy.setStateConditional('map.goat.status', 'loading', true);
    ctx.adapterProxy.setStateConditional('map.goat.lastError', '', true);
    ctx.intervalQueue.run('Generic', 'getMI', { type: '0' });
    return true;
}

/**
 * Consume a Generic GOAT map response and update map states when complete.
 * @param {object} ctx
 * @param {object} payload
 * @returns {boolean} whether the payload was recognized as map data
 */
function handlePayload(ctx, payload) {
    if (!isSupported(ctx) || !payload || typeof payload !== 'object') return false;
    const field = typeof payload.info === 'string' ? 'info' :
        (typeof payload.subsets === 'string' ? 'subsets' : '');
    const type = String(payload.type ?? '');
    if (!field || !['0', '1', '2', '4', '5', 'ar', 'vw'].includes(type)) return false;
    try {
        const encoded = assemblePayload(ctx, payload, field);
        if (encoded === null) return true;
        const decoded = decodeLzmaJson(encoded);
        const mapData = getMapData(ctx);
        if (type === '0') {
            mapData.mapId = String(payload.mid ?? '');
            mapData.centerX = Number(payload.centerX) || 0;
            mapData.centerY = Number(payload.centerY) || 0;
            mapData.main = parseMainGeometry(decoded);
            requestFollowUps(ctx, mapData.mapId, mapData.main);
        } else if (type === 'ar' || type === 'vw') {
            const metadata = parseAreaMetadata(decoded, type);
            if (type === 'ar') mapData.areas = metadata;
            else mapData.virtualBoundaryMetadata = metadata;
        } else {
            const layer = GEOMETRY_LAYERS[type];
            mapData[layer] = mergeLayerGeometry(
                mapData[layer], parseLayerGeometry(decoded, type), String(payload.aid ?? '')
            );
        }
        writeMapStates(ctx);
        return true;
    } catch (error) {
        ctx.adapter.log.warn(`Could not decode GOAT map payload: ${error.message}`);
        ctx.adapterProxy.setStateConditional('map.goat.status', 'error', true);
        ctx.adapterProxy.setStateConditional('map.goat.lastError', error.message, true);
        return true;
    }
}

module.exports = {
    decodeCompactPath,
    decodeLzmaJson,
    handlePayload,
    parseAreaMetadata,
    parseLayerGeometry,
    parseMainGeometry,
    renderSvg,
    requestMap,
    summarizePath
};
