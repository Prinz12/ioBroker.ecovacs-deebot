'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const { attachRemoteTracks } = require('../www/goat-camera-media');

class FakeMediaStream {
    constructor(tracks = []) {
        this.tracks = [...tracks];
    }

    addTrack(track) {
        this.tracks.push(track);
    }

    getTracks() {
        return [...this.tracks];
    }

    getAudioTracks() {
        return this.tracks.filter(track => track.kind === 'audio');
    }

    getVideoTracks() {
        return this.tracks.filter(track => track.kind === 'video');
    }
}

describe('goatCameraMedia.js', () => {
    it('creates a stream when WebRTC delivers a streamless track event', () => {
        const video = { srcObject: null };
        const videoTrack = { id: 'remote-video', kind: 'video' };

        const attached = attachRemoteTracks(video, { track: videoTrack, streams: [] }, FakeMediaStream);

        expect(video.srcObject).to.equal(attached.stream);
        expect(attached.videoTracks).to.equal(1);
        expect(attached.audioTracks).to.equal(0);
    });

    it('merges later tracks and does not add duplicates', () => {
        const video = { srcObject: null };
        const audioTrack = { id: 'remote-audio', kind: 'audio' };
        const videoTrack = { id: 'remote-video', kind: 'video' };

        attachRemoteTracks(video, { track: audioTrack, streams: [] }, FakeMediaStream);
        attachRemoteTracks(video, { track: videoTrack, streams: [] }, FakeMediaStream);
        const attached = attachRemoteTracks(video, {
            track: videoTrack,
            streams: [new FakeMediaStream([audioTrack, videoTrack])]
        }, FakeMediaStream);

        expect(attached.stream.getTracks()).to.deep.equal([audioTrack, videoTrack]);
        expect(attached.audioTracks).to.equal(1);
        expect(attached.videoTracks).to.equal(1);
    });
});
