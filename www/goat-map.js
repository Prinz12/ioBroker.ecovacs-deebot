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
        'tracks',
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

    function appendTrackGroups(groups, completed) {
        if (!Array.isArray(groups) || !overlay) return;
        for (const group of groups) {
            for (const lid of group?.lids || []) {
                for (const trace of lid?.traces || []) {
                    const points = [];
                    for (let index = 0; index + 1 < trace.length; index += 2) {
                        const x = Number(trace[index]);
                        const y = Number(trace[index + 1]);
                        if (Number.isFinite(x) && Number.isFinite(y)) points.push(`${x},${y}`);
                    }
                    if (points.length < 2) continue;
                    overlay.append(createSvgElement('polyline', completed ? {
                        points: points.join(' '),
                        fill: 'none',
                        stroke: '#22c55e',
                        'stroke-opacity': '.72',
                        'stroke-width': '360',
                        'stroke-linecap': 'round',
                        'stroke-linejoin': 'round'
                    } : {
                        points: points.join(' '),
                        fill: 'none',
                        stroke: '#94a3b8',
                        'stroke-opacity': '.78',
                        'stroke-width': '110',
                        'stroke-dasharray': '260 180',
                        'stroke-linecap': 'round',
                        'stroke-linejoin': 'round'
                    }));
                }
            }
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
            'aria-label': 'GOAT position'
        });
        robot.append(
            createSvgElement('circle', { r: '310', fill: '#2563eb', stroke: '#ffffff', 'stroke-width': '85' }),
            createSvgElement('path', { d: 'M 0 -360 L 190 150 L 0 80 L -190 150 Z', fill: '#ffffff' })
        );
        overlay.append(robot);
    }

    function render() {
        if (!mapSvg || !overlay) return;
        overlay.replaceChildren();
        let tracks = {};
        try {
            tracks = JSON.parse(String(values.tracks || '{}'));
        } catch {
            tracks = {};
        }
        appendTrackGroups([
            ...(tracks.nonScheduledRemaining || []),
            ...(tracks.scheduledRemaining || [])
        ], false);
        appendTrackGroups([
            ...(tracks.nonScheduledCompleted || []),
            ...(tracks.scheduledCompleted || [])
        ], true);
        renderRobot();

        const percentage = formatNumber(values.mowingProgress, 0);
        const mowed = formatNumber(values.mowedSquareMeters, 1);
        const total = formatNumber(values.totalSquareMeters, 1);
        progress.textContent = `${percentage} % · ${mowed} / ${total} m²`;
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
