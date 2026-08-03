'use strict';
/* global window, document, location, DOMParser */

(() => {
    const params = new URLSearchParams(location.search);
    const instance = /^\d+$/u.test(params.get('instance') || '') ? params.get('instance') : '0';
    const deviceId = /^[a-zA-Z0-9_-]+$/u.test(params.get('deviceId') || '') ? params.get('deviceId') : '';
    const requestedMap = params.get('baseMap') || '/vis-2.0/Codex/goat-map.svg';
    const mapUrl = new URL(requestedMap, location.origin);
    const basePath = `ecovacs-deebot.${instance}.${deviceId}.map.goat`;
    const mapHost = document.getElementById('map');
    const progress = document.getElementById('progress');
    const message = document.getElementById('message');
    const socket = window.io();
    const values = {};
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
    const stateIds = stateNames.map(name => `${basePath}.${name}`);

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
        const robot = createSvgElement('g', {
            transform: `translate(${x} ${-y}) rotate(${heading})`,
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

    loadMap().catch(error => {
        message.textContent = error?.message || 'Gartenkarte konnte nicht geladen werden';
    });
})();
