'use strict';
/* global window, document, location, DOMParser */

(() => {
    const params = new URLSearchParams(location.search);
    const instance = /^\d+$/u.test(params.get('instance') || '') ? params.get('instance') : '0';
    const deviceId = /^[a-zA-Z0-9_-]+$/u.test(params.get('deviceId') || '') ? params.get('deviceId') : '';
    const requestedMap = params.get('baseMap') || '/vis-2.0/Codex/goat-map.svg';
    const mapUrl = new URL(requestedMap, location.origin);
    const basePath = `ecovacs-deebot.${instance}.${deviceId}.map.goat`;
    const selectionBasePath = '0_userdata.0.Codex.GrosseZiege.MapSelection';
    const mapHost = document.getElementById('map');
    const progress = document.getElementById('progress');
    const selection = document.getElementById('selection');
    const message = document.getElementById('message');
    const socket = window.io();
    const values = {};
    const selectedAreas = new Map();
    const areaPolygons = new Map();
    let mapSvg;
    let overlay;

    const stateNames = [
        'positionX',
        'positionY',
        'positionValid',
        'positionHeading',
        'mowedTrail',
        'mowedSquareMeters',
        'totalSquareMeters',
        'mowingProgress',
        'liveLastUpdate'
    ];
    const areaNames = ['Area1', 'Area2', 'Area3', 'Area4', 'Area5'];
    const mapStateIds = stateNames.map(name => `${basePath}.${name}`);
    const selectionStateIds = areaNames.map(name => `${selectionBasePath}.${name}`);
    const stateIds = [...mapStateIds, ...selectionStateIds];

    function stateValue(state) {
        return state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'val') ? state.val : state;
    }

    function formatNumber(value, digits = 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric.toLocaleString('de-DE', { maximumFractionDigits: digits }) : '0';
    }

    function createSvgElement(name, attributes = {}) {
        const element = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
        return element;
    }

    /** Converts the GOAT Cartesian angle to the clockwise SVG screen angle. */
    function screenHeading(heading) {
        return ((90 - heading) % 360 + 360) % 360;
    }

    /** Returns whether an ioBroker value represents a selected area. */
    function isSelected(value) {
        return value === true || value === 1 || value === 'true' || value === '1';
    }

    /** Updates the area outlines and the selection summary. */
    function renderSelection() {
        const selectedIds = [];
        for (const [areaId, polygon] of areaPolygons) {
            const active = selectedAreas.get(areaId) === true;
            polygon.classList.toggle('goat-area-selected', active);
            polygon.setAttribute('aria-pressed', String(active));
            if (active) selectedIds.push(areaId);
        }
        selectedIds.sort((left, right) => left - right);
        selection.textContent = `Bereiche: ${selectedIds.length ? selectedIds.join(', ') : '–'} · Bereich antippen`;
    }

    /** Toggles one local VIS area-selection state without starting the mower. */
    function toggleArea(areaId) {
        const nextValue = selectedAreas.get(areaId) !== true;
        selectedAreas.set(areaId, nextValue);
        renderSelection();
        socket.emit('setState', `${selectionBasePath}.Area${areaId}`, { val: nextValue, ack: false });
    }

    /** Copies a browser SVGPointList into a regular array. */
    function polygonPoints(polygon) {
        return Array.from({ length: polygon.points.numberOfItems }, (_, index) => polygon.points.getItem(index));
    }

    /** Returns the absolute shoelace area of an SVG polygon. */
    function polygonArea(polygon) {
        const points = polygonPoints(polygon);
        return Math.abs(points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length];
            return sum + point.x * next.y - next.x * point.y;
        }, 0)) / 2;
    }

    /** Tests whether an SVG coordinate lies inside a polygon. */
    function polygonContainsPoint(polygon, x, y) {
        const points = polygonPoints(polygon);
        let inside = false;
        for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
            const currentPoint = points[index];
            const previousPoint = points[previous];
            const crosses = currentPoint.y > y !== previousPoint.y > y
                && x < (previousPoint.x - currentPoint.x) * (y - currentPoint.y)
                    / (previousPoint.y - currentPoint.y) + currentPoint.x;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    /** Finds the actual area polygon belonging to a map label. */
    function findAreaPolygon(polygons, label, usedPolygons) {
        const x = Number(label.getAttribute('x'));
        const y = Number(label.getAttribute('y'));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
        return polygons
            .filter(polygon => !usedPolygons.has(polygon) && polygonContainsPoint(polygon, x, y))
            .sort((left, right) => polygonArea(left) - polygonArea(right))[0];
    }

    /** Resolves a pointer event on the SVG to one of the selectable areas. */
    function areaAtPointer(event) {
        const matrix = mapSvg.getScreenCTM();
        if (!matrix) return undefined;
        const point = mapSvg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const mapPoint = point.matrixTransform(matrix.inverse());
        return Array.from(areaPolygons)
            .filter(([, polygon]) => polygonContainsPoint(polygon, mapPoint.x, mapPoint.y))
            .sort(([, left], [, right]) => polygonArea(left) - polygonArea(right))[0]?.[0];
    }

    /** Makes the five labelled lawn polygons keyboard- and pointer-selectable. */
    function bindSelectableAreas() {
        const polygons = Array.from(mapSvg.children).filter(element => element.localName === 'polygon');
        const labels = Array.from(mapSvg.children).filter(element => /^Bereich\s+\d+$/u.test(element.textContent.trim()));
        const areaCandidates = polygons.filter(polygon => {
            const opacity = polygon.getAttribute('fill-opacity');
            return opacity !== null && Number(opacity) < 1;
        });
        const directCandidates = areaCandidates.length === labels.length ? areaCandidates : undefined;
        const usedPolygons = new Set();

        labels.forEach((label, index) => {
            const match = /^Bereich\s+(\d+)$/u.exec(label.textContent.trim());
            const areaId = Number(match?.[1]);
            const polygon = directCandidates?.[index] || findAreaPolygon(polygons, label, usedPolygons);
            if (!Number.isInteger(areaId) || !areaNames.includes(`Area${areaId}`) || !polygon) return;

            usedPolygons.add(polygon);
            areaPolygons.set(areaId, polygon);
            polygon.classList.add('goat-area-selectable');
            polygon.setAttribute('data-area-id', String(areaId));
            polygon.setAttribute('role', 'button');
            polygon.setAttribute('tabindex', '0');
            polygon.setAttribute('aria-label', `Bereich ${areaId} auswählen`);
            polygon.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleArea(areaId);
            });
            label.style.pointerEvents = 'none';
        });
        for (const polygon of polygons) {
            if (!usedPolygons.has(polygon)) polygon.style.pointerEvents = 'none';
        }
        mapSvg.addEventListener('click', event => {
            const areaId = areaAtPointer(event);
            if (areaId !== undefined) toggleArea(areaId);
        });
        renderSelection();
    }

    function renderMowedTrail() {
        if (!overlay) return;
        let traces = [];
        try {
            traces = JSON.parse(String(values.mowedTrail || '[]'));
        } catch {
            traces = [];
        }
        for (const trace of traces) {
            const points = [];
            for (let index = 0; index + 1 < trace.length; index += 2) {
                const x = Number(trace[index]);
                const y = Number(trace[index + 1]);
                if (Number.isFinite(x) && Number.isFinite(y)) points.push(`${x},${y}`);
            }
            if (points.length < 2) continue;
            const common = {
                points: points.join(' '),
                fill: 'none',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round'
            };
            overlay.append(
                createSvgElement('polyline', {
                    ...common,
                    stroke: '#0f172a',
                    'stroke-opacity': '.45',
                    'stroke-width': '520'
                }),
                createSvgElement('polyline', {
                    ...common,
                    stroke: '#22c55e',
                    'stroke-opacity': '.8',
                    'stroke-width': '360'
                })
            );
        }
    }

    function renderRobot() {
        if (!overlay || values.positionValid === false || values.positionValid === 'false') return;
        const x = Number(values.positionX);
        const y = Number(values.positionY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const heading = Number(values.positionHeading) || 0;
        const rotation = screenHeading(heading);
        const robot = createSvgElement('g', {
            transform: `translate(${x} ${-y}) rotate(${rotation})`,
            'aria-label': `GOAT position, Fahrtrichtung ${heading} Grad`
        });
        const body = createSvgElement('g', {
            filter: 'drop-shadow(0 80px 90px rgba(0,0,0,.42))'
        });
        body.append(
            createSvgElement('rect', { x: '-315', y: '-245', width: '115', height: '430', rx: '55', fill: '#111827', stroke: '#ffffff', 'stroke-width': '35' }),
            createSvgElement('rect', { x: '200', y: '-245', width: '115', height: '430', rx: '55', fill: '#111827', stroke: '#ffffff', 'stroke-width': '35' }),
            createSvgElement('path', { d: 'M -205 -300 Q 0 -410 205 -300 L 245 -155 L 225 245 Q 0 355 -225 245 L -245 -155 Z', fill: '#2563eb', stroke: '#ffffff', 'stroke-width': '65', 'stroke-linejoin': 'round' }),
            createSvgElement('path', { d: 'M -125 -110 Q 0 -180 125 -110 L 105 135 Q 0 205 -105 135 Z', fill: '#0f172a', 'fill-opacity': '.8' }),
            createSvgElement('circle', { cx: '0', cy: '45', r: '82', fill: '#22c55e', stroke: '#ffffff', 'stroke-width': '24' }),
            createSvgElement('path', { d: 'M 0 -470 L 120 -285 L 0 -325 L -120 -285 Z', fill: '#ffffff', stroke: '#2563eb', 'stroke-width': '24', 'stroke-linejoin': 'round' })
        );
        robot.append(body);
        overlay.append(robot);
    }

    function render() {
        if (!mapSvg || !overlay) return;
        overlay.replaceChildren();
        renderMowedTrail();
        renderRobot();

        const percentage = formatNumber(values.mowingProgress, 0);
        const mowed = formatNumber(values.mowedSquareMeters, 1);
        const total = formatNumber(values.totalSquareMeters, 1);
        const heading = formatNumber(values.positionHeading, 0);
        progress.textContent = `${percentage} % · ${mowed} / ${total} m² · ${heading}°`;
    }

    function updateState(id, state) {
        if (id.startsWith(`${selectionBasePath}.`)) {
            const name = id.slice(selectionBasePath.length + 1);
            if (!areaNames.includes(name)) return;
            selectedAreas.set(Number(name.slice(4)), isSelected(stateValue(state)));
            renderSelection();
            return;
        }
        const name = id.slice(basePath.length + 1);
        if (!stateNames.includes(name)) return;
        values[name] = stateValue(state);
        render();
    }

    function readState(id) {
        socket.emit('getState', id, (...args) => {
            const state = args.length > 1 ? args[1] : args[0];
            updateState(id, state);
        });
    }

    function subscribe() {
        socket.emit('subscribe', stateIds);
        for (const id of stateIds) readState(id);
    }

    async function loadMap() {
        if (mapUrl.origin !== location.origin || !mapUrl.pathname.startsWith('/vis-2.0/')) {
            throw new Error('Ungültige Basiskarte');
        }
        const response = await window.fetch(mapUrl.href, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Basiskarte nicht verfügbar (${response.status})`);
        const source = await response.text();
        const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
        const sourceSvg = parsed.documentElement;
        if (sourceSvg.nodeName.toLowerCase() !== 'svg') throw new Error('Basiskarte ist kein SVG');
        mapSvg = document.importNode(sourceSvg, true);
        mapSvg.setAttribute('width', '100%');
        mapSvg.setAttribute('height', '100%');
        mapSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        bindSelectableAreas();
        overlay = createSvgElement('g', { id: 'goat-live-overlay' });
        mapSvg.append(overlay);
        mapHost.replaceChildren(mapSvg);
        message.hidden = true;
        render();
    }

    socket.on('connect', subscribe);
    socket.on('stateChange', updateState);
    socket.on('disconnect', () => {
        progress.textContent = 'Live-Verbindung getrennt';
    });
    if (socket.connected) subscribe();

    loadMap().catch(error => {
        message.textContent = error?.message || 'Gartenkarte konnte nicht geladen werden';
    });
})();
