'use strict';

const crypto = require('crypto');
const axios = require('axios').default;
const ecovacsTools = require('ecovacs-deebot/library/tools');
const helper = require('./adapterHelper');
const { ensureGenericCommandCompatibility } = require('./adapterCommands');

const CAMERA_SESSION_MAX_MS = 5 * 60 * 1000;
const ECOVACS_APP_VERSION = '3.14.0';
const ECOVACS_VIDEO_API_VERSION = '2.1.0';
const ECOVACS_SIGNING_SALT = '2ea31cf06e6711eaa0aff7b9558a534e';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function hashVideoPin(pin) {
    // Mirrors the GOAT H5 setPIN flow. The clear PIN never leaves the adapter.
    return sha256(`goat_${pin}`);
}

function hmac(key, value, encoding) {
    return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function awsDate(date = new Date()) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:-]/g, '');
}

function awsSigningKey(secretAccessKey, dateStamp, region, service = 'kinesisvideo') {
    const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, service);
    return hmac(serviceKey, 'aws4_request');
}

function encodeAwsQuery(value) {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, char =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
    return Object.keys(params).sort().map(key =>
        `${encodeAwsQuery(key)}=${encodeAwsQuery(params[key])}`).join('&');
}

function encodeJavaForm(value) {
    // java.net.URLEncoder, as used by the official Android GOAT viewer.
    return encodeURIComponent(String(value))
        .replace(/%20/g, '+')
        .replace(/~/g, '%7E')
        .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signAwsHeaders({ method = 'POST', url, body = '', region, credentials, now = new Date() }) {
    const parsed = new URL(url);
    const amzDate = awsDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const service = 'kinesisvideo';
    const payloadHash = sha256(body);
    const headers = {
        'content-type': 'application/json',
        host: parsed.host,
        'x-amz-date': amzDate
    };
    if (credentials.sessionToken) {
        headers['x-amz-security-token'] = credentials.sessionToken;
    }
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map(key => `${key}:${headers[key].trim()}\n`).join('');
    const canonicalRequest = [
        method,
        parsed.pathname || '/',
        parsed.searchParams.toString(),
        canonicalHeaders,
        signedHeaders.join(';'),
        payloadHash
    ].join('\n');
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signature = hmac(
        awsSigningKey(credentials.secretAccessKey, dateStamp, region, service),
        stringToSign,
        'hex'
    );
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
    delete headers.host;
    return headers;
}

function signWebSocketUrl(endpoint, channelArn, clientId, region, credentials, now = new Date()) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'wss:' || parsed.search) {
        throw new Error('AWS returned an invalid signaling WebSocket endpoint');
    }
    const amzDate = awsDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/kinesisvideo/aws4_request`;
    // ECOVACS ships a slightly different signer than the AWS JavaScript SDK:
    // values are form-encoded before signing, then java.net.URI escapes the
    // percent signs once more in the actual WebSocket URL. This preserves the
    // encoded client id that the mower's signaling master addresses.
    const params = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-ChannelARN': encodeJavaForm(channelArn),
        'X-Amz-ClientId': encodeJavaForm(clientId),
        'X-Amz-Credential': encodeJavaForm(`${credentials.accessKeyId}/${scope}`),
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': '299',
        'X-Amz-SignedHeaders': 'host'
    };
    if (credentials.sessionToken) {
        params['X-Amz-Security-Token'] = encodeJavaForm(credentials.sessionToken);
    }
    const query = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    const canonicalRequest = [
        'GET',
        parsed.pathname || '/',
        query,
        `host:${parsed.host}\n`,
        'host',
        sha256('')
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signature = hmac(
        awsSigningKey(credentials.secretAccessKey, dateStamp, region),
        stringToSign,
        'hex'
    );
    const physicalQuery = `${query}&X-Amz-Signature=${signature}`.replace(/%/g, '%25');
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}?${physicalQuery}`;
}

function randomId(length = 10) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += alphabet[bytes[i] % alphabet.length];
    }
    return result;
}

function ecovacsHeaders(ctx) {
    const timestamp = String(Date.now());
    const token = ctx.vacbot.user_access_token;
    const country = String(ctx.vacbot.country || 'de').toLowerCase();
    const userId = ctx.vacbot.uid;
    return {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'appid': 'ecovacs',
        'plat': 'android',
        'ts': timestamp,
        'country': country,
        'lang': country,
        'ucid': userId,
        'v': ECOVACS_APP_VERSION,
        'sign': crypto.createHash('sha1')
            .update(`ecovacs${ECOVACS_SIGNING_SALT}${timestamp}`)
            .digest('hex'),
        'token': token,
        'userid': userId
    };
}

function ecovacsAuth(ctx) {
    return JSON.stringify({
        with: 'users',
        userid: ctx.vacbot.uid,
        realm: 'ecouser.net',
        token: ctx.vacbot.user_access_token,
        resource: ctx.vacbot.resource
    });
}

function portalBaseUrl(ctx) {
    const format = ecovacsTools.getPortalUrlFormat(ctx.vacbot.country, ctx.vacbot.continent);
    return ecovacsTools.formatString(format, { continent: ctx.vacbot.continent });
}

function ecovacsRequestParams(ctx, extra) {
    const country = String(ctx.vacbot.country || 'de').toLowerCase();
    return Object.assign({
        lang: country,
        plat: 'Android',
        av: ECOVACS_VIDEO_API_VERSION,
        auth: ecovacsAuth(ctx),
        channel: 'google_play'
    }, extra);
}

function externalRequestError(stage, error) {
    const message = String(error?.message || '');
    if (error?.code === 'ECONNABORTED' || /timeout/i.test(message)) {
        return new Error(`${stage}: timeout after 15000 ms`);
    }
    const status = Number(error?.response?.status || 0);
    if (status) {
        return new Error(`${stage}: HTTP ${status}`);
    }
    const code = String(error?.code || '');
    if (/^[A-Z0-9_]+$/.test(code)) {
        return new Error(`${stage}: ${code}`);
    }
    return new Error(`${stage}: request failed`);
}

async function verifyGoatVideoPin(ctx, hashedPin) {
    ensureGenericCommandCompatibility(ctx);
    const deviceSession = ctx.vacbot.ecovacs;
    const originalResolver = typeof deviceSession?._resolveImmediatePayload === 'function' ?
        deviceSession._resolveImmediatePayload : null;
    let deviceCode;

    if (originalResolver) {
        deviceSession._resolveImmediatePayload = function captureGoatPinCode(command, responseData) {
            if (String(command?.name || '').toLowerCase() === 'setpin') {
                const code = Number(responseData?.resp?.body?.code);
                if (Number.isInteger(code)) deviceCode = code;
            }
            return originalResolver.apply(this, arguments);
        };
    }

    try {
        await ctx.vacbot.runAsync('Generic', 'setPIN', {
            action: 'verify',
            pwd: hashedPin
        }, { timeoutMs: 15000 });
    } finally {
        if (originalResolver) deviceSession._resolveImmediatePayload = originalResolver;
    }
    if (Number.isInteger(deviceCode) && deviceCode !== 0) {
        const error = new Error('GOAT rejected the video PIN verification');
        error.goatDeviceCode = deviceCode;
        throw error;
    }
    return {
        captureAvailable: !!originalResolver,
        deviceCode
    };
}

async function signedAwsPost(url, region, credentials, payload, stage) {
    const body = JSON.stringify(payload);
    const headers = signAwsHeaders({ url, body, region, credentials });
    try {
        const response = await axios.post(url, body, {
            headers,
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 300
        });
        return response.data;
    } catch (error) {
        throw externalRequestError(stage, error);
    }
}

function normalizeDeviceIdentifier(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

class GoatCameraManager {
    constructor(adapter) {
        this.adapter = adapter;
        this.sessions = new Map();
        this.pendingByDevice = new Map();
    }

    findMatchingContext(deviceId) {
        const requested = normalizeDeviceIdentifier(deviceId);
        if (!requested) return undefined;
        return Array.from(this.adapter.deviceContexts.values()).find(candidate => {
            const values = [candidate.deviceId, candidate.did, candidate.vacuum?.nick,
                candidate.vacuum?.deviceName, candidate.vacuum?.name];
            return values.some(value => normalizeDeviceIdentifier(value) === requested);
        });
    }

    findContext(deviceId) {
        const ctx = this.findMatchingContext(deviceId);
        if (!ctx) {
            throw new Error('GOAT camera device was not found');
        }
        if (!ctx.enabled || !ctx.connected) {
            throw new Error('GOAT camera device is not connected');
        }
        if (!helper.supportsLawnMowerControl(ctx.getPlatformType(), ctx.vacbot.deviceClass)) {
            throw new Error('Camera access is not verified for this mower model');
        }
        return ctx;
    }

    getStatus(deviceId) {
        const ctx = this.findMatchingContext(deviceId);
        const supported = !!ctx && helper.supportsLawnMowerControl(ctx.getPlatformType(), ctx.vacbot.deviceClass);
        return {
            adapterReachable: true,
            deviceFound: !!ctx,
            deviceConnected: !!ctx?.enabled && !!ctx?.connected,
            pinConfigured: /^\d{4}$/.test(String(this.adapter.config.goatVideoPin || '')),
            supported,
            activeSession: !!ctx && Array.from(this.sessions.values()).some(session => session.deviceId === ctx.deviceId)
        };
    }

    async requestSession(deviceId) {
        const ctx = this.findContext(deviceId);
        const pin = String(this.adapter.config.goatVideoPin || '');
        if (!/^\d{4}$/.test(pin)) {
            throw new Error('Configure the four-digit GOAT Video Manager PIN first');
        }
        if (this.pendingByDevice.has(ctx.deviceId)) {
            return this.pendingByDevice.get(ctx.deviceId);
        }
        const pending = this.createSession(ctx, pin).finally(() => this.pendingByDevice.delete(ctx.deviceId));
        this.pendingByDevice.set(ctx.deviceId, pending);
        return pending;
    }

    async createSession(ctx, pin) {
        const existing = Array.from(this.sessions.values()).find(session => session.deviceId === ctx.deviceId);
        if (existing) {
            await this.closeSession(existing.id);
        }

        const trackId = randomId(10);
        const hashedPin = hashVideoPin(pin);
        this.adapter.log.info('GOAT camera session stage: GOAT PIN verification');
        try {
            const verification = await verifyGoatVideoPin(ctx, hashedPin);
            const code = Number.isInteger(verification.deviceCode) ? verification.deviceCode : 'not-observed';
            this.adapter.log.info(`GOAT camera PIN response: code=${code}, ` +
                `capture=${verification.captureAvailable ? 'available' : 'unavailable'}`);
        } catch (error) {
            const deviceCode = Number(error?.goatDeviceCode);
            if (Number.isInteger(deviceCode)) {
                throw new Error(`GOAT PIN verification failed (device code ${deviceCode})`);
            }
            throw externalRequestError('GOAT PIN verification', error);
        }

        // GOAT O1200 rejects the v1 route with ECOVACS code 30013 (notSupportV1).
        // The official H5 flow verifies setPIN first, then passes the same hash to v2.
        const startUrl = `${portalBaseUrl(ctx)}/appsvr/akvs/start_watch/v2`;
        this.adapter.log.info('GOAT camera session stage: ECOVACS start_watch');
        let response;
        try {
            response = await axios.get(startUrl, {
                params: ecovacsRequestParams(ctx, {
                    videoTrackId: trackId,
                    did: ctx.vacbot.did,
                    mid: ctx.vacbot.deviceClass,
                    res: ctx.vacbot.res,
                    pwd: hashedPin
                }),
                headers: ecovacsHeaders(ctx),
                timeout: 15000,
                validateStatus: status => status >= 200 && status < 300
            });
        } catch (error) {
            throw externalRequestError('ECOVACS start_watch', error);
        }
        const data = response.data || {};
        const clientIdState = Object.prototype.hasOwnProperty.call(data, 'client_id') ?
            (String(data.client_id || '') ? 'provided' : 'empty') : 'missing';
        this.adapter.log.info(`GOAT camera start response: client_id=${clientIdState}, ` +
            `session=${String(data.session || '') ? 'provided' : 'missing'}`);
        if (String(data.ret).toLowerCase() !== 'ok') {
            const code = Number(data.code || data.errno || 0);
            if ([30010, 30017].includes(code)) {
                throw new Error(`The configured GOAT Video Manager PIN was rejected (ECOVACS code ${code})`);
            }
            if (code === 30014) {
                throw new Error('The GOAT Video Manager PIN was rejected after too many failed attempts ' +
                    '(ECOVACS code 30014)');
            }
            throw new Error(`ECOVACS camera session failed${code ? ` (${code})` : ''}`);
        }
        const clientId = String(data.client_id || trackId);
        try {
            const credentials = {
                accessKeyId: data.credentials?.AccessKeyId,
                secretAccessKey: data.credentials?.SecretAccessKey,
                sessionToken: data.credentials?.SessionToken
            };
            const region = String(data.region || '');
            const channel = String(data.channel || '');
            if (!credentials.accessKeyId || !credentials.secretAccessKey ||
                !/^[a-z0-9-]+$/.test(region) || !channel) {
                throw new Error('ECOVACS returned an incomplete camera session');
            }

            let channelArn = channel;
            if (!channelArn.startsWith('arn:aws:kinesisvideo:')) {
                this.adapter.log.info('GOAT camera session stage: AWS signaling channel');
                const describeData = await signedAwsPost(
                    `https://kinesisvideo.${region}.amazonaws.com/describeSignalingChannel`,
                    region,
                    credentials,
                    { ChannelName: channel },
                    'AWS signaling channel'
                );
                channelArn = String(describeData?.ChannelInfo?.ChannelARN || '');
                if (!channelArn.startsWith('arn:aws:kinesisvideo:')) {
                    throw new Error('AWS did not return the GOAT camera signaling channel ARN');
                }
            }

            const controlEndpoint = `https://kinesisvideo.${region}.amazonaws.com/getSignalingChannelEndpoint`;
            this.adapter.log.info('GOAT camera session stage: AWS signaling endpoint');
            const endpointData = await signedAwsPost(controlEndpoint, region, credentials, {
                ChannelARN: channelArn,
                SingleMasterChannelEndpointConfiguration: {
                    Protocols: ['WSS', 'HTTPS'],
                    Role: 'VIEWER'
                }
            }, 'AWS signaling endpoint');
            const endpoints = Object.fromEntries((endpointData.ResourceEndpointList || [])
                .map(item => [item.Protocol, item.ResourceEndpoint]));
            if (!endpoints.WSS || !endpoints.HTTPS) {
                throw new Error('AWS did not return the required camera signaling endpoints');
            }
            this.adapter.log.info('GOAT camera session stage: AWS ICE configuration');
            const iceData = await signedAwsPost(`${endpoints.HTTPS}/v1/get-ice-server-config`, region, credentials, {
                ChannelARN: channelArn,
                // The official Android viewer uses the channel role here, not
                // the temporary ECOVACS signaling client id returned by
                // start_watch. AWS still uses that temporary id for the
                // signed WebSocket URL below.
                ClientId: 'VIEWER',
                Service: 'TURN'
            }, 'AWS ICE configuration');
            const iceServers = [
                { urls: `stun:stun.kinesisvideo.${region}.amazonaws.com:443` },
                ...(iceData.IceServerList || []).map(server => ({
                    urls: server.Uris,
                    username: server.Username,
                    credential: server.Password
                }))
            ];
            const signedWssUrl = signWebSocketUrl(endpoints.WSS, channelArn, clientId, region, credentials);
            const id = crypto.randomUUID();
            const expiresAt = Date.now() + CAMERA_SESSION_MAX_MS;
            const session = {
                id,
                deviceId: ctx.deviceId,
                ctx,
                trackId,
                sid: data.session,
                clientId,
                expiresAt,
                timer: setTimeout(() => this.closeSession(id).catch(() => {}), CAMERA_SESSION_MAX_MS)
            };
            this.sessions.set(id, session);
            this.adapter.log.info(`GOAT camera viewer session started for ${ctx.vacuum?.nick || ctx.deviceId}`);
            return {
                sessionId: id,
                deviceId: ctx.did,
                region,
                channelArn,
                clientId,
                signedWssUrl,
                iceServers,
                expiresAt
            };
        } catch (error) {
            try {
                await this.endWatch(ctx, trackId, data.session, clientId);
            } catch (cleanupError) {
                this.adapter.log.debug(`GOAT camera cleanup failed: ${externalRequestError('ECOVACS end_watch', cleanupError).message}`);
            }
            throw error;
        }
    }

    async endWatch(ctx, trackId, sid, clientId) {
        const endUrl = `${portalBaseUrl(ctx)}/appsvr/akvs/end_watch`;
        await axios.get(endUrl, {
            params: ecovacsRequestParams(ctx, {
                videoTrackId: trackId,
                sid,
                clientId
            }),
            headers: ecovacsHeaders(ctx),
            timeout: 10000,
            validateStatus: status => status >= 200 && status < 300
        });
    }

    async closeSession(id) {
        const session = this.sessions.get(String(id || ''));
        if (!session) return false;
        this.sessions.delete(session.id);
        clearTimeout(session.timer);
        try {
            await this.endWatch(session.ctx, session.trackId, session.sid, session.clientId);
        } catch (error) {
            this.adapter.log.debug(`Could not close GOAT camera cloud session: ${error.message}`);
        }
        this.adapter.log.info(`GOAT camera viewer session stopped for ${session.ctx.vacuum?.nick || session.deviceId}`);
        return true;
    }

    async closeAll() {
        await Promise.all(Array.from(this.sessions.keys()).map(id => this.closeSession(id)));
    }
}

module.exports = {
    GoatCameraManager,
    canonicalQuery,
    signAwsHeaders,
    signWebSocketUrl
};
