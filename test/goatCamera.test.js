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
            continent: 'eu'
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
            channel: 'arn:aws:kinesisvideo:eu-central-1:123456789012:channel/test/1',
            client_id: 'viewer-1',
            session: 'ecovacs-session'
        } });
        axiosStub.post.onFirstCall().resolves({ data: { ResourceEndpointList: [
            { Protocol: 'WSS', ResourceEndpoint: 'wss://example.kinesisvideo.eu-central-1.amazonaws.com' },
            { Protocol: 'HTTPS', ResourceEndpoint: 'https://example.kinesisvideo.eu-central-1.amazonaws.com' }
        ] } });
        axiosStub.post.onSecondCall().resolves({ data: { IceServerList: [{
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
        expect(startOptions.params.pwd).to.equal('9876');
        expect(startOptions.params.did).to.equal(ctx.did);
        expect(startOptions.headers.Authorization).to.equal('Bearer ecovacs-token');
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
        expect(error.message).to.equal('AWS unavailable');
        expect(axiosStub.get.callCount).to.equal(2);
        expect(axiosStub.get.secondCall.args[0]).to.include('/appsvr/akvs/end_watch');
        expect(axiosStub.get.secondCall.args[1].params).to.include({
            sid: 'ecovacs-session',
            client_id: 'viewer-1'
        });
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
