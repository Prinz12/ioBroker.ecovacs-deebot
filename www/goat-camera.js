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
    let clientId;
    let remoteDescriptionSet = false;
    let pendingIce = [];
    let adapterCheckInFlight;
    let answerTimeout;
    let diagnostics;
    const { encodeMessage, decodeMessage } = window.GoatCameraCodec;

    function resetDiagnostics() {
        diagnostics = {
            webSocket: 'closed',
            messages: {},
            answerReceived: false,
            localCandidates: 0,
            remoteCandidates: 0,
            tracks: 0,
            connectionState: 'new',
            iceConnectionState: 'new',
            signalingState: 'stable'
        };
        publishDiagnostics();
    }

    function publishDiagnostics() {
        if (status && diagnostics) status.dataset.cameraDiagnostic = JSON.stringify(diagnostics);
    }

    function setStatus(message) {
        status.textContent = String(message || 'Unbekannter Fehler');
    }

    function errorText(error) {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === 'string' && error) return error;
        try {
            return JSON.stringify(error) || 'Unbekannter Fehler';
        } catch {
            return 'Unbekannter Fehler';
        }
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
                if (typeof response === 'string') reject(new Error(response));
                else if (response?.error) reject(new Error(errorText(response.error)));
                else if (!response || typeof response !== 'object') reject(new Error('Leere Antwort vom Adapter'));
                else resolve(response);
            });
        });
    }

    async function checkAdapter() {
        const result = await sendTo('getGoatCameraStatus', { deviceId });
        if (!result.deviceFound) throw new Error('GOAT wurde im Adapter nicht gefunden');
        if (!result.supported) throw new Error('Kamera ist für dieses GOAT-Modell nicht freigeschaltet');
        if (!result.deviceConnected) throw new Error('GOAT ist derzeit nicht verbunden');
        if (!result.pinConfigured) throw new Error('Vierstellige Video-Manager-PIN fehlt');
        setStatus(result.activeSession ? 'Bereit · aktive Kamerasitzung erkannt' : 'Bereit · Adapter und GOAT erreichbar');
    }

    function sendSignal(action, payload) {
        if (webSocket?.readyState !== WebSocket.OPEN) return;
        const rawPayload = JSON.stringify(payload);
        webSocket.send(JSON.stringify({
            action,
            recipientClientId: '',
            senderClientId: clientId || '',
            messagePayload: encodeMessage(payload),
            sdpPayload: action === 'SDP_OFFER' ? rawPayload : ''
        }));
    }

    async function handleSignal(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        const messageType = String(message.messageType || 'UNKNOWN');
        diagnostics.messages[messageType] = (diagnostics.messages[messageType] || 0) + 1;
        publishDiagnostics();
        if (message.messageType === 'STATUS_RESPONSE') {
            if (message.statusResponse && !message.statusResponse.success) {
                throw new Error(message.statusResponse.description || 'AWS-Signalisierungsfehler');
            }
            return;
        }
        if (!message.messagePayload) return;
        const payload = decodeMessage(message.messagePayload);
        if (message.messageType === 'SDP_ANSWER') {
            diagnostics.answerReceived = true;
            await peerConnection.setRemoteDescription(payload);
            remoteDescriptionSet = true;
            for (const candidate of pendingIce) await peerConnection.addIceCandidate(candidate);
            pendingIce = [];
            clearTimeout(answerTimeout);
            publishDiagnostics();
        } else if (message.messageType === 'ICE_CANDIDATE') {
            diagnostics.remoteCandidates++;
            if (remoteDescriptionSet) await peerConnection.addIceCandidate(payload);
            else pendingIce.push(payload);
            publishDiagnostics();
        }
    }

    async function start() {
        if (!deviceId) throw new Error('In der URL fehlt deviceId');
        startButton.disabled = true;
        setStatus('Sichere Kamerasitzung wird angefordert …');
        await checkAdapter();
        setStatus('Sichere Kamerasitzung wird angefordert …');
        const session = await sendTo('getGoatCameraSession', { deviceId });
        sessionId = session.sessionId;
        clientId = session.clientId;
        remoteDescriptionSet = false;
        pendingIce = [];
        clearTimeout(answerTimeout);
        resetDiagnostics();
        peerConnection = new RTCPeerConnection({
            iceServers: session.iceServers,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require'
        });
        // Keep the media order used by ECOVACS' Android WebRTC client. It adds
        // the muted audio sender first and requests the remote video second.
        peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addEventListener('icecandidate', event => {
            if (event.candidate) {
                diagnostics.localCandidates++;
                publishDiagnostics();
                sendSignal('ICE_CANDIDATE', event.candidate.toJSON());
            }
        });
        peerConnection.addEventListener('track', event => {
            diagnostics.tracks++;
            publishDiagnostics();
            if (!video.srcObject) video.srcObject = event.streams[0];
        });
        peerConnection.addEventListener('connectionstatechange', () => {
            const state = peerConnection?.connectionState;
            diagnostics.connectionState = state || 'closed';
            publishDiagnostics();
            if (state === 'connected') setStatus('Livebild verbunden');
            else if (['failed', 'disconnected'].includes(state)) setStatus(`WebRTC: ${state}`);
        });
        peerConnection.addEventListener('iceconnectionstatechange', () => {
            diagnostics.iceConnectionState = peerConnection?.iceConnectionState || 'closed';
            publishDiagnostics();
        });
        peerConnection.addEventListener('signalingstatechange', () => {
            diagnostics.signalingState = peerConnection?.signalingState || 'closed';
            publishDiagnostics();
        });

        webSocket = new WebSocket(session.signedWssUrl);
        webSocket.addEventListener('message', event => handleSignal(event).catch(error => setStatus(error.message)));
        webSocket.addEventListener('error', () => setStatus('AWS-Signalisierungsverbindung fehlgeschlagen'));
        webSocket.addEventListener('close', () => {
            diagnostics.webSocket = 'closed';
            publishDiagnostics();
            if (sessionId) setStatus('Kamerasitzung beendet');
        });
        await new Promise((resolve, reject) => {
            webSocket.addEventListener('open', resolve, { once: true });
            webSocket.addEventListener('error', () => reject(new Error('AWS-WebSocket konnte nicht geöffnet werden')), { once: true });
        });
        diagnostics.webSocket = 'open';
        publishDiagnostics();
        const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await peerConnection.setLocalDescription(offer);
        sendSignal('SDP_OFFER', peerConnection.localDescription.toJSON());
        answerTimeout = setTimeout(() => {
            if (sessionId && !diagnostics.answerReceived) {
                const received = Object.values(diagnostics.messages).reduce((sum, count) => sum + count, 0);
                setStatus(received ? 'GOAT-Kamerakanal antwortet ohne SDP' : 'Keine Antwort vom GOAT-Kamerakanal (SDP-Timeout)');
            }
        }, 15000);
        cover.hidden = true;
        stopButton.disabled = false;
        soundButton.disabled = false;
        setStatus('Livebild wird aufgebaut …');
    }

    async function stop() {
        stopButton.disabled = true;
        soundButton.disabled = true;
        clearTimeout(answerTimeout);
        webSocket?.close();
        webSocket = undefined;
        peerConnection?.close();
        peerConnection = undefined;
        video.srcObject = null;
        const closingId = sessionId;
        sessionId = undefined;
        clientId = undefined;
        remoteDescriptionSet = false;
        pendingIce = [];
        if (closingId) {
            try { await sendTo('closeGoatCameraSession', { sessionId: closingId }); } catch { /* expires server-side */ }
        }
        cover.hidden = false;
        startButton.disabled = false;
        setStatus('Kamera geschlossen');
    }

    function handleSocketConnect() {
        if (adapterCheckInFlight) return;
        adapterCheckInFlight = checkAdapter()
            .catch(error => setStatus(errorText(error)))
            .finally(() => { adapterCheckInFlight = undefined; });
    }

    socket.on('connect', handleSocketConnect);
    if (socket.connected) handleSocketConnect();
    socket.on('connect_error', () => setStatus('Keine Verbindung zum ioBroker-Webserver'));
    resetDiagnostics();
    startButton.addEventListener('click', () => start().catch(async error => {
        const message = errorText(error);
        try { await stop(); } catch { /* preserve the original error */ }
        setStatus(message);
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
