'use strict';
/* global window */

function attachRemoteTracks(video, event, MediaStreamConstructor) {
    let stream = video.srcObject;
    if (!stream) {
        stream = new MediaStreamConstructor();
        video.srcObject = stream;
    }

    const tracks = [];
    for (const eventStream of event.streams || []) {
        tracks.push(...eventStream.getTracks());
    }
    if (event.track) tracks.push(event.track);

    const existingIds = new Set(stream.getTracks().map(track => track.id));
    for (const track of tracks) {
        if (!track || existingIds.has(track.id)) continue;
        stream.addTrack(track);
        existingIds.add(track.id);
    }

    return {
        stream,
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length
    };
}

const goatCameraMedia = { attachRemoteTracks };

if (typeof module !== 'undefined' && module.exports) module.exports = goatCameraMedia;
else window.GoatCameraMedia = goatCameraMedia;
