'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function loadModule(axiosStub) {
    return proxyquire('../lib/goatCamera', {
        axios: { default: axiosStub },
        'ecovacs-deebot/library/tools': {
            getPortalUrlFormat: () => 'https://api-app.dc-{continent}.ww.ecouser.net/api',
            formatString: (value, meta) => value.replace('{continent}', meta.continent)
        },
        './adapterHelper': {
            supportsLawnMowerControl: () => true
        },
        './adapterCommands': {
            ensureGenericCommandCompatibility: sinon.stub()
        }
    });
}

function createAdapter(pin = '9876') {
    const ctx = {
        deviceId: 'f5e7b486_5aaf_49ca_a3cc_58ee8f863cd5',
        did: 'f5e7b486-5aaf-49ca-a3cc-58ee8f863cd5',
        connected: true,
        enabled: true,
        getPlatformType: () => 'lawnMower',
        vacuum: {
            nick: 'Große Ziege',
            did: 'f5e7b486-5aaf-49ca-a3cc-58ee8f863cd5'
        },
        vacbot: {
            did: 'f5e7b486-5aaf-49ca-a3cc-58ee8f863cd5',
            deviceClass: '2i0fns',
            res: 'resource-device',
            resource: 'resource-account',
            uid: 'user-id',
            user_access_token: 'ecovacs-token',
            country: 'de',
            continent: 'eu',
            runAsync: sinon.stub().resolves({ ret: 'ok' })
        }
    };
    return {
        ctx,
        adapter: {
            config: { goatVideoPin: pin },
            deviceContexts: new Map([[ctx.deviceId, ctx]]),
            log: { info: sinon.stub(), warn: sinon.stub(), debug: sinon.stub() }
        }
    };
}

describe('goatCamera.js', () => {
    it('reports viewer readiness without starting a cloud camera session', () => {
        const axiosStub = { get: sinon.stub(), post: sinon.stub() };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        expect(manager.getStatus(ctx.did)).to.deep.equal({
            adapterReachable: true,
            deviceFound: true,
            deviceConnected: true,
            pinConfigured: true,
            supported: true,
            activeSession: false
        });
        expect(axiosStub.get.called).to.be.false;
        expect(axiosStub.post.called).to.be.false;
    });

    it('creates a browser-safe viewer session without exposing cloud credentials or the PIN', async () => {
        const axiosStub = {
            get: sinon.stub(),
            post: sinon.stub()
        };
        axiosStub.get.onFirstCall().resolves({ data: {
            ret: 'ok',
            credentials: {
                AccessKeyId: 'AKID',
                SecretAccessKey: 'SECRET',
                SessionToken: 'SESSION'
            },
            region: 'eu-central-1',
            channel: 'goat-camera-channel',
            client_id: 'viewer-1',
            session: 'ecovacs-session'
        } });
        axiosStub.post.onFirstCall().resolves({ data: { ChannelInfo: {
            ChannelARN: 'arn:aws:kinesisvideo:eu-central-1:123456789012:channel/test/1'
        } } });
        axiosStub.post.onSecondCall().resolves({ data: { ResourceEndpointList: [
            { Protocol: 'WSS', ResourceEndpoint: 'wss://example.kinesisvideo.eu-central-1.amazonaws.com' },
            { Protocol: 'HTTPS', ResourceEndpoint: 'https://example.kinesisvideo.eu-central-1.amazonaws.com' }
        ] } });
        axiosStub.post.onThirdCall().resolves({ data: { IceServerList: [{
            Uris: ['turn:example:443'], Username: 'turn-user', Password: 'turn-password'
        }] } });
        axiosStub.get.onSecondCall().resolves({ data: { ret: 'ok' } });

        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);
        const result = await manager.requestSession(ctx.did);

        expect(result.signedWssUrl).to.match(/^wss:\/\/example\./);
        expect(result.iceServers).to.have.length(2);
        expect(result).not.to.have.any.keys('credentials', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'pin');
        const startOptions = axiosStub.get.firstCall.args[1];
        expect(axiosStub.get.firstCall.args[0]).to.include('/appsvr/akvs/start_watch/v2');
        expect(startOptions.params.pwd).to.equal(
            'f7e7fbd1a38fe96df90bde06055f81705bfd27f9fa76aaa01143459c9ac42916'
        );
        expect(startOptions.params.pwd).not.to.equal('9876');
        expect(ctx.vacbot.runAsync.calledOnce).to.be.true;
        expect(ctx.vacbot.runAsync.firstCall.args.slice(0, 3)).to.deep.equal([
            'Generic',
            'setPIN',
            { action: 'verify', pwd: startOptions.params.pwd }
        ]);
        expect(startOptions.params.did).to.equal(ctx.did);
        expect(startOptions.headers.Authorization).to.equal('Bearer ecovacs-token');
        expect(axiosStub.post.firstCall.args[0]).to.include('/describeSignalingChannel');
        expect(JSON.parse(axiosStub.post.firstCall.args[1])).to.deep.equal({
            ChannelName: 'goat-camera-channel'
        });
        expect(JSON.parse(axiosStub.post.thirdCall.args[1])).to.include({
            ClientId: 'VIEWER',
            Service: 'TURN'
        });
        expect(JSON.stringify(result)).not.to.include('SECRET');
        expect(JSON.stringify(result)).not.to.include('9876');

        await manager.closeSession(result.sessionId);
        expect(axiosStub.get.secondCall.args[0]).to.include('/appsvr/akvs/end_watch');
    });

    it('rejects requests until a four-digit Video Manager PIN is configured', async () => {
        const axiosStub = { get: sinon.stub(), post: sinon.stub() };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter('');
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }
        expect(error).to.be.instanceOf(Error);
        expect(error.message).to.include('four-digit');
        expect(axiosStub.get.called).to.be.false;
    });

    it('does not start the cloud camera session when GOAT PIN verification fails', async () => {
        const axiosStub = { get: sinon.stub(), post: sinon.stub() };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        ctx.vacbot.runAsync.rejects(Object.assign(new Error('device timeout'), { code: 'ETIMEDOUT' }));
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal('GOAT PIN verification: timeout after 15000 ms');
        expect(error.message).not.to.include('9876');
        expect(axiosStub.get.called).to.be.false;
        expect(axiosStub.post.called).to.be.false;
    });

    it('rejects a non-zero device response from GOAT PIN verification', async () => {
        const axiosStub = { get: sinon.stub(), post: sinon.stub() };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        ctx.vacbot.ecovacs = {
            _resolveImmediatePayload(command, responseData) {
                return responseData?.resp?.body?.data;
            }
        };
        ctx.vacbot.runAsync.callsFake(async () => ctx.vacbot.ecovacs._resolveImmediatePayload(
            { name: 'setPIN' },
            { resp: { body: { code: 30010, msg: 'rejected' } } }
        ));
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal('GOAT PIN verification failed (device code 30010)');
        expect(error.message).not.to.include('9876');
        expect(axiosStub.get.called).to.be.false;
        expect(axiosStub.post.called).to.be.false;
    });

    it('reports the numeric ECOVACS code for a rejected PIN without exposing secrets', async () => {
        const axiosStub = {
            get: sinon.stub().resolves({ data: { ret: 'fail', code: 30010 } }),
            post: sinon.stub()
        };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal(
            'The configured GOAT Video Manager PIN was rejected (ECOVACS code 30010)'
        );
        expect(error.message).not.to.include('9876');
        expect(error.message).not.to.include('ecovacs-token');
        expect(axiosStub.post.called).to.be.false;
    });

    it('distinguishes the too-many-failed-PIN-attempts response', async () => {
        const axiosStub = {
            get: sinon.stub().resolves({ data: { ret: 'fail', code: 30014 } }),
            post: sinon.stub()
        };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal(
            'The GOAT Video Manager PIN was rejected after too many failed attempts (ECOVACS code 30014)'
        );
        expect(error.message).not.to.include('9876');
        expect(axiosStub.post.called).to.be.false;
    });

    it('closes the ECOVACS watch session when AWS setup fails', async () => {
        const axiosStub = {
            get: sinon.stub(),
            post: sinon.stub()
        };
        axiosStub.get.onFirstCall().resolves({ data: {
            ret: 'ok',
            credentials: {
                AccessKeyId: 'AKID',
                SecretAccessKey: 'SECRET',
                SessionToken: 'SESSION'
            },
            region: 'eu-central-1',
            channel: 'arn:aws:kinesisvideo:eu-central-1:123456789012:channel/test/1',
            client_id: 'viewer-1',
            session: 'ecovacs-session'
        } });
        axiosStub.post.rejects(new Error('AWS unavailable'));
        axiosStub.get.onSecondCall().resolves({ data: { ret: 'ok' } });

        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }
        expect(error.message).to.equal('AWS signaling endpoint: request failed');
        expect(axiosStub.get.callCount).to.equal(2);
        expect(axiosStub.get.secondCall.args[0]).to.include('/appsvr/akvs/end_watch');
        expect(axiosStub.get.secondCall.args[1].params).to.include({
            sid: 'ecovacs-session',
            clientId: 'viewer-1'
        });
    });

    it('identifies an ECOVACS start_watch timeout without exposing request secrets', async () => {
        const timeout = Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
        const axiosStub = { get: sinon.stub().rejects(timeout), post: sinon.stub() };
        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal('ECOVACS start_watch: timeout after 15000 ms');
        expect(error.message).not.to.include('9876');
        expect(error.message).not.to.include('ecovacs-token');
        expect(adapter.log.info.calledWith('GOAT camera session stage: ECOVACS start_watch')).to.be.true;
        expect(axiosStub.post.called).to.be.false;
    });

    it('identifies an AWS ICE configuration timeout and closes the ECOVACS watch session', async () => {
        const axiosStub = { get: sinon.stub(), post: sinon.stub() };
        axiosStub.get.onFirstCall().resolves({ data: {
            ret: 'ok',
            credentials: {
                AccessKeyId: 'AKID',
                SecretAccessKey: 'SECRET',
                SessionToken: 'SESSION'
            },
            region: 'eu-central-1',
            channel: 'arn:aws:kinesisvideo:eu-central-1:123456789012:channel/test/1',
            client_id: 'viewer-1',
            session: 'ecovacs-session'
        } });
        axiosStub.post.onFirstCall().resolves({ data: { ResourceEndpointList: [
            { Protocol: 'WSS', ResourceEndpoint: 'wss://example.kinesisvideo.eu-central-1.amazonaws.com' },
            { Protocol: 'HTTPS', ResourceEndpoint: 'https://example.kinesisvideo.eu-central-1.amazonaws.com' }
        ] } });
        axiosStub.post.onSecondCall().rejects(
            Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })
        );
        axiosStub.get.onSecondCall().resolves({ data: { ret: 'ok' } });

        const { GoatCameraManager } = loadModule(axiosStub);
        const { adapter, ctx } = createAdapter();
        const manager = new GoatCameraManager(adapter);

        let error;
        try {
            await manager.requestSession(ctx.did);
        } catch (caught) {
            error = caught;
        }

        expect(error.message).to.equal('AWS ICE configuration: timeout after 15000 ms');
        expect(axiosStub.get.secondCall.args[0]).to.include('/appsvr/akvs/end_watch');
        expect(adapter.log.info.calledWith('GOAT camera session stage: AWS signaling endpoint')).to.be.true;
        expect(adapter.log.info.calledWith('GOAT camera session stage: AWS ICE configuration')).to.be.true;
    });

    it('creates a deterministic AWS WebSocket signature shape', () => {
        const { signWebSocketUrl } = loadModule({});
        const result = signWebSocketUrl(
            'wss://example.com',
            'arn:aws:kinesisvideo:eu-central-1:123456789012:channel/test/1',
            'viewer-1',
            'eu-central-1',
            { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'SESSION' },
            new Date('2026-08-02T00:00:00.000Z')
        );
        expect(result).to.include('X-Amz-Algorithm=AWS4-HMAC-SHA256');
        expect(result).to.include('X-Amz-Expires=299');
        expect(result).to.include('X-Amz-Security-Token=SESSION');
        expect(result).to.match(/X-Amz-Signature=[0-9a-f]{64}$/);
    });
});
