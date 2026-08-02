'use strict';
/* global window, document, location, RTCPeerConnection */

(() => {
    const params = new URLSearchParams(location.search);
    const instance = params.get('instance') || '0';
    const deviceId = params.get('deviceId') || '';
    const adapter = `ecovacs-deebot.${instance}`;
    const video = document.getElementById('video');
    const cover = document.getElementById('cover');
    const startButton = document.getElementById('start');
    const stopButton = document.getElementById('stop');
    const soundButton = document.getElementById('sound');
    const status = document.getElementById('status');

    const socket = window.io();
    let webSocket;
    let peerConnection;
    let sessionId;
    let remoteDescriptionSet = false;
    let pendingIce = [];

    function setStatus(message) {
        status.textContent = message;
    }

    function sendTo(command, message) {
        return new Promise((resolve, reject) => {
            if (!socket?.connected) {
                reject(new Error('Keine Verbindung zum ioBroker-Webserver'));
                return;
            }
            const timeout = setTimeout(() => reject(new Error('Zeitüberschreitung bei der Adapter-Anfrage')), 20000);
            socket.emit('sendTo', adapter, command, message, response => {
                clearTimeout(timeout);
                if (response?.error) reject(new Error(response.error));
                else resolve(response);
            });
        });
    }

    function encodeMessage(value) {
        return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
    }

    function decodeMessage(value) {
        return JSON.parse(decodeURIComponent(escape(atob(value))));
    }

    function sendSignal(action, payload) {
        if (webSocket?.readyState !== WebSocket.OPEN) return;
        webSocket.send(JSON.stringify({ action, messagePayload: encodeMessage(payload) }));
    }

    async function handleSignal(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.messageType === 'STATUS_RESPONSE') {
            if (message.statusResponse && !message.statusResponse.success) {
                throw new Error(message.statusResponse.description || 'AWS-Signalisierungsfehler');
            }
            return;
        }
        if (!message.messagePayload) return;
        const payload = decodeMessage(message.messagePayload);
        if (message.messageType === 'SDP_ANSWER') {
            await peerConnection.setRemoteDescription(payload);
            remoteDescriptionSet = true;
            for (const candidate of pendingIce) await peerConnection.addIceCandidate(candidate);
            pendingIce = [];
        } else if (message.messageType === 'ICE_CANDIDATE') {
            if (remoteDescriptionSet) await peerConnection.addIceCandidate(payload);
            else pendingIce.push(payload);
        }
    }

    async function start() {
        if (!deviceId) throw new Error('In der URL fehlt deviceId');
        startButton.disabled = true;
        setStatus('Sichere Kamerasitzung wird angefordert …');
        const session = await sendTo('getGoatCameraSession', { deviceId });
        sessionId = session.sessionId;
        peerConnection = new RTCPeerConnection({ iceServers: session.iceServers });
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });
        peerConnection.addEventListener('icecandidate', event => {
            if (event.candidate) sendSignal('ICE_CANDIDATE', event.candidate.toJSON());
        });
        peerConnection.addEventListener('track', event => {
            if (!video.srcObject) video.srcObject = event.streams[0];
        });
        peerConnection.addEventListener('connectionstatechange', () => {
            const state = peerConnection?.connectionState;
            if (state === 'connected') setStatus('Livebild verbunden');
            else if (['failed', 'disconnected'].includes(state)) setStatus(`WebRTC: ${state}`);
        });

        webSocket = new WebSocket(session.signedWssUrl);
        webSocket.addEventListener('message', event => handleSignal(event).catch(error => setStatus(error.message)));
        webSocket.addEventListener('error', () => setStatus('AWS-Signalisierungsverbindung fehlgeschlagen'));
        webSocket.addEventListener('close', () => {
            if (sessionId) setStatus('Kamerasitzung beendet');
        });
        await new Promise((resolve, reject) => {
            webSocket.addEventListener('open', resolve, { once: true });
            webSocket.addEventListener('error', () => reject(new Error('AWS-WebSocket konnte nicht geöffnet werden')), { once: true });
        });
        const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await peerConnection.setLocalDescription(offer);
        sendSignal('SDP_OFFER', peerConnection.localDescription.toJSON());
        cover.hidden = true;
        stopButton.disabled = false;
        soundButton.disabled = false;
        setStatus('Livebild wird aufgebaut …');
    }

    async function stop() {
        stopButton.disabled = true;
        soundButton.disabled = true;
        webSocket?.close();
        webSocket = undefined;
        peerConnection?.close();
        peerConnection = undefined;
        video.srcObject = null;
        const closingId = sessionId;
        sessionId = undefined;
        if (closingId) {
            try { await sendTo('closeGoatCameraSession', { sessionId: closingId }); } catch { /* expires server-side */ }
        }
        cover.hidden = false;
        startButton.disabled = false;
        setStatus('Kamera geschlossen');
    }

    socket.on('connect', () => setStatus('Bereit'));
    socket.on('connect_error', () => setStatus('Keine Verbindung zum ioBroker-Webserver'));
    startButton.addEventListener('click', () => start().catch(async error => {
        setStatus(error.message);
        await stop();
    }));
    stopButton.addEventListener('click', () => stop());
    soundButton.addEventListener('click', () => {
        video.muted = !video.muted;
        soundButton.textContent = video.muted ? 'Ton einschalten' : 'Ton ausschalten';
    });
    window.addEventListener('pagehide', () => {
        if (sessionId && socket?.connected) {
            socket.emit('sendTo', adapter, 'closeGoatCameraSession', { sessionId }, () => {});
        }
        webSocket?.close();
        peerConnection?.close();
    });
})();
