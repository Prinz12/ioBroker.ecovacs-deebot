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

const TRACK_CATEGORIES = Object.freeze([
    'nonScheduledRemaining',
    'nonScheduledCompleted',
    'scheduledRemaining',
    'scheduledCompleted'
]);

// The upstream Generic dispatcher clears its command association after the
// first response packet. GOAT map and track responses can contain multiple
// packets, while position/stat updates also arrive as unsolicited `on...`
// messages. These are the read-only payloads that must additionally be passed
// to this module directly from the message dispatcher.
const RAW_TELEMETRY_COMMANDS = new Set([
    'getmi',
    'onmi',
    'getareaset',
    'onareaset',
    'getari',
    'onari',
    'getmaptrack',
    'onmaptrack',
    'oninfo',
    'onpos',
    'onstats'
]);

const ACTIVE_MOWING_STATES = new Set(['clean', 'cleaning', 'mowing', 'working']);
const MOWED_TRAIL_MIN_DISTANCE = 100;
const MOWED_TRAIL_MAX_GAP = 5000;
const MOWED_TRAIL_MAX_POINTS = 8000;

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
 * Decode the line formats used by getMapTrack into the shape used by the app.
 * Track coordinates already have their Y axis flipped for direct SVG output.
 * @param {string} value
 * @param {number} pathType
 * @param {boolean} remaining
 * @returns {Array<Array<number>>}
 */
function decodeTrackTraces(value, pathType, remaining) {
    if (pathType === 1) {
        const coordinates = String(value).split(';');
        const traces = [];
        for (let index = 0; index + 1 < coordinates.length; index += 2) {
            const start = coordinates[index].split(',').map(Number);
            const end = coordinates[index + 1].split(',').map(Number);
            if (start.length === 2 && end.length === 2 &&
                [...start, ...end].every(Number.isFinite)) {
                traces.push([start[0], -start[1], end[0], -end[1]]);
            }
        }
        return traces;
    }
    if (pathType !== 2) return [];
    const points = decodeCompactPath(value).map(point => [point[0], -point[1]]);
    if (!points.length) return [];
    if (!remaining) return [points.flat()];

    const traces = [];
    let trace = [];
    for (const point of points) {
        const previousX = trace.length >= 2 ? trace[trace.length - 2] : null;
        const previousY = trace.length >= 2 ? trace[trace.length - 1] : null;
        if (previousX !== null &&
            (Math.abs(point[0] - previousX) > 50 || Math.abs(point[1] - previousY) > 50)) {
            if (trace.length >= 4) traces.push(trace);
            trace = [];
        }
        trace.push(point[0], point[1]);
    }
    if (trace.length >= 2) traces.push(trace);
    return traces;
}

/**
 * Parse the four getMapTrack groups (scheduled/non-scheduled, remaining/completed).
 * @param {unknown} decoded
 * @returns {object}
 */
function parseMapTrack(decoded) {
    const grouped = Object.fromEntries(TRACK_CATEGORIES.map(category => [category, new Map()]));
    if (!Array.isArray(decoded)) {
        return Object.fromEntries(TRACK_CATEGORIES.map(category => [category, []]));
    }
    for (const row of decoded) {
        if (!Array.isArray(row) || row.length < 3) continue;
        const scheduleType = String(row[0]);
        const completionType = String(row[1]);
        const category = scheduleType === '1' ?
            (completionType === '1' ? 'nonScheduledRemaining' : 'nonScheduledCompleted') :
            (scheduleType === '2' ?
                (completionType === '1' ? 'scheduledRemaining' : 'scheduledCompleted') : '');
        if (!category) continue;
        for (const entry of row.slice(2)) {
            if (typeof entry !== 'string') continue;
            const parts = entry.split(';');
            if (parts.length < 4) continue;
            const zid = String(parts[0]);
            const pathType = Number(parts[1]);
            const lid = String(parts[2]);
            const traces = decodeTrackTraces(parts.slice(3).join(';'), pathType, completionType === '1');
            if (!traces.length) continue;
            const key = `${zid}_${pathType}`;
            if (!grouped[category].has(key)) {
                grouped[category].set(key, { zid, pathType, lids: [] });
            }
            grouped[category].get(key).lids.push({ lid, traces });
        }
    }
    return Object.fromEntries(TRACK_CATEGORIES.map(category => [
        category, [...grouped[category].values()]
    ]));
}

/**
 * Count individual rendered traces in a track collection.
 * @param {Array<object>} groups
 * @returns {number}
 */
function countTraces(groups) {
    return groups.reduce((sum, group) => sum + (group.lids || []).reduce(
        (lidSum, lid) => lidSum + (lid.traces || []).length, 0
    ), 0);
}

/**
 * Render the currently known GOAT geometry as a standalone SVG.
 * @param {object} mapData
 * @returns {string}
 */
function renderSvg(mapData) {
    const main = mapData.main || [];
    const subareas = mapData.subareas || [];
    const visibleLawn = subareas.length ? subareas : main;
    const allPoints = visibleLawn.flatMap(item => item.points);
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

    if (!subareas.length) {
        for (const item of main) {
            elements.push(`<polygon points="${svgPoints(item.points)}" fill="#dcedc8" stroke="#558b2f" stroke-width="120"/>`);
        }
    }
    for (const [index, item] of subareas.entries()) {
        elements.push(`<polygon points="${svgPoints(item.points)}" fill="${colors[index % colors.length]}" fill-opacity="0.55" stroke="#ffffff" stroke-width="80"/>`);
    }
    for (const trace of mapData.mowedTrail || []) {
        const points = [];
        for (let index = 0; index + 1 < trace.length; index += 2) {
            points.push(`${trace[index]},${trace[index + 1]}`);
        }
        if (points.length < 2) continue;
        elements.push(`<polyline points="${points.join(' ')}" fill="none" stroke="#0f172a" stroke-opacity="0.45" stroke-width="520" stroke-linecap="round" stroke-linejoin="round"/>`);
        elements.push(`<polyline points="${points.join(' ')}" fill="none" stroke="#22c55e" stroke-opacity="0.78" stroke-width="360" stroke-linecap="round" stroke-linejoin="round"/>`);
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
    const position = mapData.position;
    if (position?.valid && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        const heading = Number(position.heading) || 0;
        elements.push(`<g transform="translate(${position.x} ${-position.y}) rotate(${heading})" aria-label="GOAT position"><circle r="310" fill="#1565c0" stroke="#ffffff" stroke-width="85"/><path d="M 0 -360 L 190 150 L 0 80 L -190 150 Z" fill="#ffffff"/><text x="0" y="650" font-size="500" text-anchor="middle" fill="#0d47a1" stroke="#ffffff" stroke-width="30" paint-order="stroke">GOAT</text></g>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="GOAT lawn map">${elements.join('')}</svg>`;
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
            position: null,
            tracks: Object.fromEntries(TRACK_CATEGORIES.map(category => [category, []])),
            mowedTrail: [],
            progress: {
                mowedArea: 0,
                area: 0,
                mowedSquareMeters: 0,
                totalSquareMeters: 0,
                percent: 0
            },
            liveLastUpdate: 0,
            lastWorkState: '',
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
 * Extract data from a named Generic response wrapper.
 * @param {object} payload
 * @param {Array<string>} names
 * @returns {{data:object, wrapped:boolean, exclusive:boolean}|null}
 */
function extractResponse(payload, names) {
    for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(payload, name)) continue;
        const response = payload[name];
        if (!response || typeof response !== 'object' ||
            (Object.prototype.hasOwnProperty.call(response, 'code') && Number(response.code) !== 0)) {
            return null;
        }
        const data = response.data && typeof response.data === 'object' ? response.data : response;
        return { data, wrapped: true, exclusive: Object.keys(payload).length === 1 };
    }
    return null;
}

/**
 * Record only positions the mower has actually reached during an active run.
 * Coordinates are stored in the same SVG coordinate system as map tracks.
 * @param {object} mapData
 */
function appendMowedPosition(mapData) {
    const position = mapData.position;
    if (!ACTIVE_MOWING_STATES.has(mapData.lastWorkState) || !position?.valid) return;
    const x = Number(position.x);
    const y = -Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!mapData.mowedTrail.length) mapData.mowedTrail.push([]);
    let trace = mapData.mowedTrail[mapData.mowedTrail.length - 1];
    const lastX = trace.length >= 2 ? trace[trace.length - 2] : null;
    const lastY = trace.length >= 2 ? trace[trace.length - 1] : null;
    if (lastX !== null) {
        const distance = Math.hypot(x - lastX, y - lastY);
        if (distance < MOWED_TRAIL_MIN_DISTANCE) return;
        if (distance > MOWED_TRAIL_MAX_GAP) {
            trace = [];
            mapData.mowedTrail.push(trace);
        }
    }
    trace.push(x, y);
    let pointCount = mapData.mowedTrail.reduce((sum, item) => sum + item.length / 2, 0);
    while (pointCount > MOWED_TRAIL_MAX_POINTS && mapData.mowedTrail.length > 1) {
        pointCount -= mapData.mowedTrail.shift().length / 2;
    }
}

/**
 * Read current GOAT position, cleaning statistics or map-track chunks.
 * @param {object} ctx
 * @param {object} payload
 * @returns {boolean|null} true/false when live data was found, null otherwise
 */
function handleLivePayload(ctx, payload) {
    const positionResponse = extractResponse(payload, ['getPos', 'onPos']);
    const positionSource = positionResponse?.data ||
        (payload.deebotPos && typeof payload.deebotPos === 'object' ? payload : null);
    if (positionSource?.deebotPos && typeof positionSource.deebotPos === 'object') {
        const raw = positionSource.deebotPos;
        const x = Number(raw.x);
        const y = Number(raw.y);
        const headingValue = [raw.a, raw.angle, raw.direction, raw.theta]
            .map(Number).find(Number.isFinite);
        const valid = Number.isFinite(x) && Number.isFinite(y) &&
            (!Object.prototype.hasOwnProperty.call(raw, 'invalid') || Number(raw.invalid) === 0);
        const mapData = getMapData(ctx);
        mapData.position = {
            ...raw,
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            heading: headingValue || 0,
            valid
        };
        appendMowedPosition(mapData);
        mapData.liveLastUpdate = Date.now();
        writeMapStates(ctx, false);
        return true;
    }

    const trackResponse = extractResponse(payload, ['getMapTrack', 'onMapTrack']);
    const trackSource = trackResponse?.data ||
        (typeof payload.info === 'string' &&
        (Object.prototype.hasOwnProperty.call(payload, 'batid') ||
            Object.prototype.hasOwnProperty.call(payload, 'totalHeight')) &&
        !Object.prototype.hasOwnProperty.call(payload, 'type') ? payload : null);
    if (trackSource && typeof trackSource.info === 'string') {
        if (String(trackSource.serial) === '0') return true;
        try {
            const encoded = assemblePayload(ctx, trackSource, 'info');
            if (encoded === null) return true;
            const parsed = parseMapTrack(decodeLzmaJson(encoded));
            const mapData = getMapData(ctx);
            for (const category of ['nonScheduledRemaining', 'scheduledRemaining']) {
                if (parsed[category].length) mapData.tracks[category] = parsed[category];
            }
            // The app treats these groups as updates of its remaining plan.
            // They are not proof that the mower has physically passed there.
            // Keep only the newest packet; the visible mowed trail uses onPos.
            for (const category of ['nonScheduledCompleted', 'scheduledCompleted']) {
                mapData.tracks[category] = parsed[category];
            }
            mapData.liveLastUpdate = Date.now();
            writeMapStates(ctx, false);
        } catch (error) {
            ctx.adapter.log.warn(`Could not decode GOAT map-track payload: ${error.message}`);
            ctx.adapterProxy.setStateConditional('map.goat.lastError', error.message, true);
        }
        return true;
    }

    const statsResponse = extractResponse(payload, ['getStats', 'onStats']);
    const statsSource = statsResponse?.data ||
        ((Object.prototype.hasOwnProperty.call(payload, 'mowedArea') ||
            Object.prototype.hasOwnProperty.call(payload, 'area')) ? payload : null);
    if (statsSource) {
        const mowedArea = Math.max(0, Number(statsSource.mowedArea) || 0);
        const area = Math.max(0, Number(statsSource.area) || 0);
        const mapData = getMapData(ctx);
        if (mapData.progress.mowedArea > 0 && mowedArea < mapData.progress.mowedArea) {
            mapData.tracks.nonScheduledCompleted = [];
            mapData.tracks.scheduledCompleted = [];
            mapData.mowedTrail = [];
        }
        mapData.progress = {
            mowedArea,
            area,
            mowedSquareMeters: Math.round(mowedArea / 100) / 100,
            totalSquareMeters: Math.round(area / 100) / 100,
            percent: area > 0 ? Math.min(100, Math.max(0, Math.floor(100 * mowedArea / area))) : 0
        };
        mapData.liveLastUpdate = Date.now();
        writeMapStates(ctx, false);
        return statsResponse?.exclusive !== false;
    }
    return null;
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
function writeMapStates(ctx, includeStaticMap = true) {
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
    const completedTracks = [
        ...(mapData.tracks.nonScheduledCompleted || []),
        ...(mapData.tracks.scheduledCompleted || [])
    ];
    const remainingTracks = [
        ...(mapData.tracks.nonScheduledRemaining || []),
        ...(mapData.tracks.scheduledRemaining || [])
    ];
    if (includeStaticMap) {
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
    }
    ctx.adapterProxy.setStateConditional('map.goat.position', JSON.stringify(mapData.position || {}), true);
    ctx.adapterProxy.setStateConditional('map.goat.positionX', mapData.position?.x || 0, true);
    ctx.adapterProxy.setStateConditional('map.goat.positionY', mapData.position?.y || 0, true);
    ctx.adapterProxy.setStateConditional('map.goat.positionValid', Boolean(mapData.position?.valid), true);
    ctx.adapterProxy.setStateConditional('map.goat.positionHeading', mapData.position?.heading || 0, true);
    ctx.adapterProxy.setStateConditional('map.goat.tracks', JSON.stringify(mapData.tracks), true);
    ctx.adapterProxy.setStateConditional('map.goat.mowedTrail', JSON.stringify(mapData.mowedTrail), true);
    ctx.adapterProxy.setStateConditional('map.goat.completedTrackCount', countTraces(completedTracks), true);
    ctx.adapterProxy.setStateConditional('map.goat.remainingTrackCount', countTraces(remainingTracks), true);
    ctx.adapterProxy.setStateConditional('map.goat.mowedSquareMeters', mapData.progress.mowedSquareMeters, true);
    ctx.adapterProxy.setStateConditional('map.goat.totalSquareMeters', mapData.progress.totalSquareMeters, true);
    ctx.adapterProxy.setStateConditional('map.goat.mowingProgress', mapData.progress.percent, true);
    ctx.adapterProxy.setStateConditional('map.goat.liveLastUpdate', mapData.liveLastUpdate, true);
    if (includeStaticMap) {
        // Position and actually traveled trail are rendered by the live web
        // overlay. Keep the persisted base SVG static so a file-sync helper
        // cannot burn transient or stale live lines into the background map.
        const svg = renderSvg({ ...mapData, position: null, mowedTrail: [] });
        ctx.adapterProxy.setStateConditional('map.goat.svg', svg, true);
        ctx.adapterProxy.setStateConditional('map.goat.lastUpdate', Date.now(), true);
        ctx.adapterProxy.setStateConditional('map.goat.status', 'ready', true);
        ctx.adapterProxy.setStateConditional('map.goat.lastError', '', true);
    }
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
    ctx.adapter.setState(ctx.statePath('map.goat.status'), 'loading', true);
    ctx.adapterProxy.setStateConditional('map.goat.lastError', '', true);
    // Keep the static map request isolated. The library associates an incoming
    // Generic response with the most recently sent command, so sending live
    // reads immediately afterwards can make the slower getMI response miss its
    // handler. The interval queue contains reads only; discard any reads that
    // are still waiting and dispatch this single request immediately. Position,
    // tracks and statistics are polled independently by the next interval.
    ctx.intervalQueue.resetQueue();
    ctx.vacbot.run('Generic', 'getMI', { type: '0' });
    return true;
}

/**
 * Reset run-specific traces only when a new mowing run begins.
 * @param {object} ctx
 * @param {string} state
 */
function handleWorkState(ctx, state) {
    if (!isSupported(ctx)) return;
    const mapData = getMapData(ctx);
    const normalized = String(state || '').toLowerCase();
    const wasActive = ACTIVE_MOWING_STATES.has(mapData.lastWorkState);
    const isActive = ACTIVE_MOWING_STATES.has(normalized);
    mapData.lastWorkState = normalized;
    if (!isActive || wasActive) return;
    mapData.tracks = Object.fromEntries(TRACK_CATEGORIES.map(category => [category, []]));
    mapData.mowedTrail = [];
    mapData.progress.mowedArea = 0;
    mapData.progress.mowedSquareMeters = 0;
    mapData.progress.percent = 0;
    mapData.liveLastUpdate = Date.now();
    writeMapStates(ctx, false);
}

/**
 * Consume a Generic GOAT map response and update map states when complete.
 * @param {object} ctx
 * @param {object} payload
 * @returns {boolean} whether the payload was recognized as map data
 */
function handlePayload(ctx, payload) {
    if (!isSupported(ctx) || !payload || typeof payload !== 'object') return false;
    const liveHandled = handleLivePayload(ctx, payload);
    if (liveHandled !== null) return liveHandled;
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

/**
 * Preserve every packet of the read-only GOAT telemetry responses without
 * changing the upstream dispatcher's normal behaviour.
 * @param {object} vacbot
 * @param {object} ctx
 * @returns {boolean} whether the bridge is available/installed
 */
function registerTelemetryBridge(vacbot, ctx) {
    const dispatcher = [vacbot?.ecovacs?.dispatcher, vacbot?.dispatcher]
        .find(candidate => typeof candidate?.handleMessagePayload === 'function');
    if (!isSupported(ctx) || !dispatcher) {
        return false;
    }
    if (dispatcher._ioBrokerGoatTelemetryBridge) return true;
    const originalHandleMessagePayload = dispatcher.handleMessagePayload;
    dispatcher.handleMessagePayload = async function(command, payload) {
        const result = await originalHandleMessagePayload.call(this, command, payload);
        const normalizedCommand = String(command ?? '').replace(/^_+|_+$/g, '').toLowerCase();
        if (RAW_TELEMETRY_COMMANDS.has(normalizedCommand)) {
            try {
                handlePayload(ctx, payload);
            } catch (error) {
                ctx.adapter.log.warn(`Could not handle GOAT telemetry payload: ${error.message}`);
            }
        }
        return result;
    };
    dispatcher._ioBrokerGoatTelemetryBridge = true;
    return true;
}

module.exports = {
    decodeTrackTraces,
    decodeCompactPath,
    decodeLzmaJson,
    handlePayload,
    handleWorkState,
    parseAreaMetadata,
    parseLayerGeometry,
    parseMainGeometry,
    parseMapTrack,
    registerTelemetryBridge,
    renderSvg,
    requestMap,
    summarizePath
};
