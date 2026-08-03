'use strict';
/* global window, document, location, DOMParser */

(() => {
    const params = new URLSearchParams(location.search);
    const instance = /^\d+$/u.test(params.get('instance') || '') ? params.get('instance') : '0';
    const deviceId = /^[a-zA-Z0-9_-]+$/u.test(params.get('deviceId') || '') ? params.get('deviceId') : '';
    const requestedMap = params.get('baseMap') || '/vis-2.0/Codex/goat-map.svg';
    const mapUrl = new URL(requestedMap, location.origin);
    const basePath = `ecovacs-deebot.${instance}.${deviceId}.map.goat`;
    const controlBasePath = `ecovacs-deebot.${instance}.${deviceId}.control.goat`;
    const selectionBasePath = '0_userdata.0.Codex.GrosseZiege.MapSelection';
    const mapHost = document.getElementById('map');
    const progress = document.getElementById('progress');
    const selection = document.getElementById('selection');
    const message = document.getElementById('message');
    const areaModeButton = document.getElementById('mode-areas');
    const trimModeButton = document.getElementById('mode-trim');
    const clearSelectionButton = document.getElementById('selection-clear');
    const zoomOutButton = document.getElementById('zoom-out');
    const zoomLevelButton = document.getElementById('zoom-level');
    const zoomInButton = document.getElementById('zoom-in');
    const fitButton = document.getElementById('zoom-fit');
    const robotButton = document.getElementById('zoom-robot');
    const socket = window.io();
    const values = {};
    const selectedAreas = new Map();
    const selectedBoundaries = {
        physical: new Set(),
        virtual: new Set()
    };
    const areaPolygons = new Map();
    const boundaryEntries = new Map();
    const activePointers = new Map();
    let mapSvg;
    let boundaryOverlay;
    let overlay;
    let selectionMode = 'areas';
    let initialViewBox;
    let currentViewBox;
    let gesture;
    let suppressNextClick = false;

    const maximumZoom = 6;
    const dragThreshold = 7;

    const stateNames = [
        'positionX',
        'positionY',
        'positionValid',
        'positionHeading',
        'mowedTrail',
        'mowedSquareMeters',
        'totalSquareMeters',
        'mowingProgress',
        'liveLastUpdate',
        'geometry'
    ];
    const areaNames = ['Area1', 'Area2', 'Area3', 'Area4', 'Area5'];
    const mapStateIds = stateNames.map(name => `${basePath}.${name}`);
    const selectionStateIds = areaNames.map(name => `${selectionBasePath}.${name}`);
    const controlStateIds = [
        `${controlBasePath}.trimBoundaryIds`,
        `${controlBasePath}.trimVirtualBoundaryIds`
    ];
    const stateIds = [...mapStateIds, ...selectionStateIds, ...controlStateIds];

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

    /** Sorts numeric-looking identifiers without changing their string representation. */
    function sortIds(ids) {
        return [...ids].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right));
    }

    /** Parses a comma-separated selection state. */
    function parseSelection(value) {
        return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
    }

    /** Updates all selection outlines and the compact selection summary. */
    function renderSelection() {
        const selectedAreaIds = [];
        for (const [areaId, polygon] of areaPolygons) {
            const active = selectedAreas.get(areaId) === true;
            polygon.classList.toggle('goat-area-selected', active);
            polygon.setAttribute('aria-pressed', String(active));
            if (active) selectedAreaIds.push(String(areaId));
        }
        for (const entry of boundaryEntries.values()) {
            const active = selectedBoundaries[entry.type].has(entry.id);
            entry.group.classList.toggle('goat-boundary-selected', active);
            entry.hit.setAttribute('aria-pressed', String(active));
            entry.hit.setAttribute('tabindex', selectionMode === 'trim' ? '0' : '-1');
        }
        const areas = sortIds(selectedAreaIds);
        const physical = sortIds(selectedBoundaries.physical);
        const virtual = sortIds(selectedBoundaries.virtual);
        selection.textContent = `Flächen: ${areas.length ? areas.join(', ') : '–'} · `
            + `Physisch: ${physical.length ? physical.join(', ') : '–'} · `
            + `Virtuell: ${virtual.length ? virtual.join(', ') : '–'}`;
    }

    /** Toggles one local VIS area-selection state without starting the mower. */
    function toggleArea(areaId) {
        const nextValue = selectedAreas.get(areaId) !== true;
        selectedAreas.set(areaId, nextValue);
        renderSelection();
        socket.emit('setState', `${selectionBasePath}.Area${areaId}`, { val: nextValue, ack: false });
    }

    /** Writes one staged boundary selection without starting the mower. */
    function writeBoundarySelection(type) {
        const stateName = type === 'physical' ? 'trimBoundaryIds' : 'trimVirtualBoundaryIds';
        const value = sortIds(selectedBoundaries[type]).join(',');
        socket.emit('setState', `${controlBasePath}.${stateName}`, { val: value, ack: false });
    }

    /** Toggles one physical or virtual trim boundary. */
    function toggleBoundary(type, id) {
        const selected = selectedBoundaries[type];
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        renderSelection();
        writeBoundarySelection(type);
    }

    /** Switches between area selection and trim-boundary selection. */
    function setSelectionMode(mode) {
        selectionMode = mode === 'trim' ? 'trim' : 'areas';
        mapSvg?.classList.toggle('trim-mode', selectionMode === 'trim');
        areaModeButton.classList.toggle('active', selectionMode === 'areas');
        trimModeButton.classList.toggle('active', selectionMode === 'trim');
        areaModeButton.setAttribute('aria-pressed', String(selectionMode === 'areas'));
        trimModeButton.setAttribute('aria-pressed', String(selectionMode === 'trim'));
        for (const polygon of areaPolygons.values()) {
            polygon.setAttribute('tabindex', selectionMode === 'areas' ? '0' : '-1');
        }
        renderSelection();
    }

    /** Clears only the currently active selection type without starting the mower. */
    function clearSelection() {
        if (selectionMode === 'areas') {
            for (const areaId of areaPolygons.keys()) {
                if (selectedAreas.get(areaId) !== true) continue;
                selectedAreas.set(areaId, false);
                socket.emit('setState', `${selectionBasePath}.Area${areaId}`, { val: false, ack: false });
            }
        } else {
            selectedBoundaries.physical.clear();
            selectedBoundaries.virtual.clear();
            writeBoundarySelection('physical');
            writeBoundarySelection('virtual');
        }
        renderSelection();
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
            polygon.setAttribute('tabindex', selectionMode === 'areas' ? '0' : '-1');
            polygon.setAttribute('aria-label', `Bereich ${areaId} auswählen`);
            polygon.addEventListener('keydown', event => {
                if (selectionMode !== 'areas' || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                toggleArea(areaId);
            });
            label.style.pointerEvents = 'none';
        });
        for (const polygon of polygons) {
            if (!usedPolygons.has(polygon)) polygon.style.pointerEvents = 'none';
        }
        mapSvg.addEventListener('click', event => {
            if (suppressNextClick) return;
            if (selectionMode !== 'areas') return;
            const areaId = areaAtPointer(event);
            if (areaId !== undefined) toggleArea(areaId);
        });
        renderSelection();
    }

    /** Converts decoded GOAT points to the SVG coordinate system. */
    function geometryPoints(points) {
        return (Array.isArray(points) ? points : [])
            .filter(point => Array.isArray(point) && point.length >= 2
                && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
            .map(point => `${Number(point[0])},${-Number(point[1])}`)
            .join(' ');
    }

    /** Creates selectable physical and virtual trim-boundary overlays. */
    function renderBoundaries() {
        if (!boundaryOverlay) return;
        boundaryOverlay.replaceChildren();
        boundaryEntries.clear();
        let geometry = {};
        try {
            geometry = JSON.parse(String(values.geometry || '{}'));
        } catch {
            geometry = {};
        }
        const layers = [
            ['physical', 'trimBoundaries', '#8e24aa', 'P'],
            ['virtual', 'virtualBoundaries', '#ff9800', 'V']
        ];
        for (const [type, layerName, color, abbreviation] of layers) {
            for (const item of Array.isArray(geometry[layerName]) ? geometry[layerName] : []) {
                const id = String(item.id || '');
                const points = geometryPoints(item.points);
                if (!id || !points) continue;
                const group = createSvgElement('g', {
                    class: `goat-boundary goat-boundary-${type}`,
                    'data-boundary-type': type,
                    'data-boundary-id': id
                });
                const visible = createSvgElement('polyline', {
                    class: 'goat-boundary-visible',
                    points,
                    fill: 'none',
                    stroke: color,
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                    'vector-effect': 'non-scaling-stroke'
                });
                const hit = createSvgElement('polyline', {
                    class: 'goat-boundary-hit',
                    points,
                    fill: 'none',
                    stroke: 'transparent',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                    'vector-effect': 'non-scaling-stroke',
                    role: 'button',
                    tabindex: selectionMode === 'trim' ? '0' : '-1',
                    'aria-label': `${type === 'physical' ? 'Physische Trimmgrenze' : 'Virtuelle Grenze'} ${id} auswählen`
                });
                const middle = item.points[Math.floor(item.points.length / 2)];
                const label = createSvgElement('text', {
                    class: 'goat-boundary-label',
                    x: Number(middle?.[0]) || 0,
                    y: -(Number(middle?.[1]) || 0),
                    'text-anchor': 'middle',
                    'font-size': '520',
                    'paint-order': 'stroke'
                });
                label.textContent = `${abbreviation}${id}`;
                hit.addEventListener('click', event => {
                    if (suppressNextClick || selectionMode !== 'trim') return;
                    event.stopPropagation();
                    toggleBoundary(type, id);
                });
                hit.addEventListener('keydown', event => {
                    if (selectionMode !== 'trim' || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    toggleBoundary(type, id);
                });
                group.append(visible, hit, label);
                boundaryOverlay.append(group);
                boundaryEntries.set(`${type}:${id}`, { type, id, group, hit });
            }
        }
        renderSelection();
    }

    /** Copies a viewBox-like object into a mutable plain object. */
    function copyViewBox(box) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
    }

    /** Keeps a panned viewport close enough to the map to recover it easily. */
    function constrainViewBox(box) {
        if (!initialViewBox) return box;
        const horizontalPadding = box.width * 0.2;
        const verticalPadding = box.height * 0.2;
        const minimumX = initialViewBox.x - horizontalPadding;
        const maximumX = initialViewBox.x + initialViewBox.width - box.width + horizontalPadding;
        const minimumY = initialViewBox.y - verticalPadding;
        const maximumY = initialViewBox.y + initialViewBox.height - box.height + verticalPadding;
        return {
            ...box,
            x: Math.min(Math.max(box.x, minimumX), maximumX),
            y: Math.min(Math.max(box.y, minimumY), maximumY)
        };
    }

    /** Applies one viewport and updates the visible zoom percentage. */
    function applyViewBox(box) {
        if (!mapSvg || !initialViewBox) return;
        currentViewBox = constrainViewBox(box);
        mapSvg.setAttribute('viewBox', [
            currentViewBox.x,
            currentViewBox.y,
            currentViewBox.width,
            currentViewBox.height
        ].join(' '));
        zoomLevelButton.textContent = `${Math.round(initialViewBox.width / currentViewBox.width * 100)} %`;
    }

    /** Converts one screen coordinate using a supplied SVG transform matrix. */
    function screenPointWithMatrix(clientX, clientY, matrix) {
        const point = mapSvg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        return point.matrixTransform(matrix);
    }

    /** Converts one current screen coordinate into a map coordinate. */
    function screenPoint(clientX, clientY) {
        const matrix = mapSvg.getScreenCTM();
        return matrix ? screenPointWithMatrix(clientX, clientY, matrix.inverse()) : undefined;
    }

    /** Zooms around one screen position while preserving its map coordinate. */
    function zoomAt(clientX, clientY, factor) {
        const focus = screenPoint(clientX, clientY);
        if (!focus || !currentViewBox || !initialViewBox) return;
        const minimumWidth = initialViewBox.width / maximumZoom;
        const nextWidth = Math.min(initialViewBox.width, Math.max(minimumWidth, currentViewBox.width * factor));
        const actualFactor = nextWidth / currentViewBox.width;
        applyViewBox({
            x: focus.x - (focus.x - currentViewBox.x) * actualFactor,
            y: focus.y - (focus.y - currentViewBox.y) * actualFactor,
            width: nextWidth,
            height: currentViewBox.height * actualFactor
        });
    }

    /** Zooms around the visual centre of the map. */
    function zoomFromCentre(factor) {
        const bounds = mapSvg.getBoundingClientRect();
        zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, factor);
    }

    /** Restores the complete map viewport. */
    function fitMap() {
        if (initialViewBox) applyViewBox(copyViewBox(initialViewBox));
    }

    /** Centres the current viewport on the last valid GOAT position. */
    function centreOnRobot() {
        const x = Number(values.positionX);
        const y = -Number(values.positionY);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !currentViewBox) return;
        applyViewBox({
            ...currentViewBox,
            x: x - currentViewBox.width / 2,
            y: y - currentViewBox.height / 2
        });
    }

    /** Returns the distance and midpoint of the first two active pointers. */
    function pointerPair() {
        const [first, second] = [...activePointers.values()];
        if (!first || !second) return undefined;
        return {
            distance: Math.hypot(second.x - first.x, second.y - first.y),
            centre: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
        };
    }

    /** Starts a one-finger or mouse pan gesture. */
    function startPan(pointer) {
        const matrix = mapSvg.getScreenCTM();
        if (!matrix || !currentViewBox) return;
        const inverse = matrix.inverse();
        gesture = {
            type: 'pan',
            startClient: { ...pointer },
            startPoint: screenPointWithMatrix(pointer.x, pointer.y, inverse),
            startViewBox: copyViewBox(currentViewBox),
            inverse,
            moved: false
        };
    }

    /** Starts a two-finger pinch and pan gesture. */
    function startPinch() {
        const pair = pointerPair();
        const matrix = mapSvg.getScreenCTM();
        if (!pair || !matrix || !currentViewBox) return;
        const inverse = matrix.inverse();
        gesture = {
            type: 'pinch',
            startDistance: Math.max(pair.distance, 1),
            startCentre: screenPointWithMatrix(pair.centre.x, pair.centre.y, inverse),
            focus: screenPointWithMatrix(pair.centre.x, pair.centre.y, inverse),
            startViewBox: copyViewBox(currentViewBox),
            inverse,
            moved: true
        };
        mapSvg.classList.add('is-panning');
    }

    /** Tracks a pointer that may pan or pinch the SVG viewBox. */
    function handlePointerDown(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        mapSvg.setPointerCapture?.(event.pointerId);
        if (activePointers.size === 1) startPan(activePointers.get(event.pointerId));
        else if (activePointers.size === 2) startPinch();
    }

    /** Applies the active pan or pinch gesture. */
    function handlePointerMove(event) {
        if (!activePointers.has(event.pointerId) || !gesture) return;
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (gesture.type === 'pan') {
            const distance = Math.hypot(
                event.clientX - gesture.startClient.x,
                event.clientY - gesture.startClient.y
            );
            if (!gesture.moved && distance < dragThreshold) return;
            gesture.moved = true;
            mapSvg.classList.add('is-panning');
            const currentPoint = screenPointWithMatrix(event.clientX, event.clientY, gesture.inverse);
            applyViewBox({
                ...gesture.startViewBox,
                x: gesture.startViewBox.x - (currentPoint.x - gesture.startPoint.x),
                y: gesture.startViewBox.y - (currentPoint.y - gesture.startPoint.y)
            });
            return;
        }
        const pair = pointerPair();
        if (!pair || !initialViewBox) return;
        const scale = gesture.startDistance / Math.max(pair.distance, 1);
        const minimumScale = initialViewBox.width / maximumZoom / gesture.startViewBox.width;
        const maximumScale = initialViewBox.width / gesture.startViewBox.width;
        const boundedScale = Math.min(maximumScale, Math.max(minimumScale, scale));
        const currentCentre = screenPointWithMatrix(pair.centre.x, pair.centre.y, gesture.inverse);
        applyViewBox({
            x: gesture.focus.x - (gesture.focus.x - gesture.startViewBox.x) * boundedScale
                - (currentCentre.x - gesture.startCentre.x),
            y: gesture.focus.y - (gesture.focus.y - gesture.startViewBox.y) * boundedScale
                - (currentCentre.y - gesture.startCentre.y),
            width: gesture.startViewBox.width * boundedScale,
            height: gesture.startViewBox.height * boundedScale
        });
    }

    /** Ends one pointer gesture without turning a drag into a selection click. */
    function handlePointerUp(event) {
        if (gesture?.moved) {
            suppressNextClick = true;
            window.setTimeout(() => { suppressNextClick = false; }, 0);
        }
        activePointers.delete(event.pointerId);
        if (mapSvg.hasPointerCapture?.(event.pointerId)) mapSvg.releasePointerCapture(event.pointerId);
        mapSvg.classList.remove('is-panning');
        if (activePointers.size === 1) {
            startPan([...activePointers.values()][0]);
            gesture.moved = true;
        } else if (!activePointers.size) {
            gesture = undefined;
        }
    }

    /** Enables mouse-wheel, pointer, pinch and toolbar viewport controls. */
    function bindViewportControls() {
        const viewBox = mapSvg.viewBox.baseVal;
        if (!viewBox?.width || !viewBox?.height) return;
        initialViewBox = copyViewBox(viewBox);
        currentViewBox = copyViewBox(viewBox);
        applyViewBox(currentViewBox);
        mapSvg.addEventListener('wheel', event => {
            event.preventDefault();
            zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 0.82 : 1.22);
        }, { passive: false });
        mapSvg.addEventListener('pointerdown', handlePointerDown);
        mapSvg.addEventListener('pointermove', handlePointerMove);
        mapSvg.addEventListener('pointerup', handlePointerUp);
        mapSvg.addEventListener('pointercancel', handlePointerUp);
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
        if (id.startsWith(`${controlBasePath}.`)) {
            const name = id.slice(controlBasePath.length + 1);
            const type = name === 'trimBoundaryIds' ? 'physical'
                : name === 'trimVirtualBoundaryIds' ? 'virtual' : undefined;
            if (!type) return;
            selectedBoundaries[type] = parseSelection(stateValue(state));
            renderSelection();
            return;
        }
        const name = id.slice(basePath.length + 1);
        if (!stateNames.includes(name)) return;
        values[name] = stateValue(state);
        if (name === 'geometry') renderBoundaries();
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
        boundaryOverlay = createSvgElement('g', { id: 'goat-boundary-overlay' });
        mapSvg.append(boundaryOverlay);
        overlay = createSvgElement('g', { id: 'goat-live-overlay' });
        mapSvg.append(overlay);
        mapHost.replaceChildren(mapSvg);
        bindViewportControls();
        setSelectionMode(selectionMode);
        renderBoundaries();
        message.hidden = true;
        render();
    }

    areaModeButton.addEventListener('click', () => setSelectionMode('areas'));
    trimModeButton.addEventListener('click', () => setSelectionMode('trim'));
    clearSelectionButton.addEventListener('click', clearSelection);
    zoomOutButton.addEventListener('click', () => zoomFromCentre(1.25));
    zoomLevelButton.addEventListener('click', fitMap);
    zoomInButton.addEventListener('click', () => zoomFromCentre(0.8));
    fitButton.addEventListener('click', fitMap);
    robotButton.addEventListener('click', centreOnRobot);

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
