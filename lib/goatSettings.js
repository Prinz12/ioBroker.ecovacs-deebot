'use strict';

const helper = require('./adapterHelper');

const INFO_QUERIES = Object.freeze([
    'getAutoCutDirection',
    'getRainDelay',
    'getAnimProtect',
    'getTimeZone',
    'getCustomCutMode',
    'getBorderSwitch'
]);

/** Check whether GOAT setting reads are verified for this device. */
function supportsSettings(ctx) {
    return helper.supportsLawnMowerInfo(
        ctx.getPlatformType(), ctx.getModel().getDeviceClass()
    );
}

/** Normalize an ECOVACS time value such as `19:0` to `19:00`. */
function normalizeTime(value) {
    if (typeof value !== 'string') return '';
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(value);
    if (!match) return value;
    return `${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`;
}

/** Convert the GBZ mower height level used by the O1200 to centimetres. */
function heightLevelToCm(level) {
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel)) return null;
    return Math.round((8.5 - numericLevel / 2) * 10) / 10;
}

/** Store the verified per-area mowing settings. */
function handleAreaParameters(ctx, payload) {
    if (!Array.isArray(payload?.areaParameters)) return false;
    const areaParameters = payload.areaParameters.map(area => ({
        areaID: String(area.areaID),
        mowHeightLevel: Number(area.mowHeightLevel),
        cutHeightCm: heightLevelToCm(area.mowHeightLevel),
        cutMode: Number(area.cutMode),
        obstacleHeight: Number(area.obstacleHeight),
        angle: Number(area.angle ?? area.cutDirection)
    }));
    ctx.adapterProxy.setStateConditional(
        'info.goat.settings.areaParameters', JSON.stringify(areaParameters), true
    );
    return true;
}

/** Return successful data from one entry of a getInfo response. */
function getInfoData(payload, name) {
    const entry = payload?.[name];
    return entry?.code === 0 && entry.data && typeof entry.data === 'object'
        ? entry.data
        : null;
}

/** Store the verified global mower settings returned by getInfo. */
function handleGlobalSettings(ctx, payload) {
    let handled = false;
    const autoDirection = getInfoData(payload, 'getAutoCutDirection');
    if (autoDirection) {
        const enabled = Boolean(autoDirection.enable);
        ctx.adapterProxy.setStateConditional('info.goat.settings.autoCutDirection', enabled, true);
        ctx.adapterProxy.setStateConditional('control.goat.autoCutDirection', enabled, true);
        handled = true;
    }

    const rainDelay = getInfoData(payload, 'getRainDelay');
    if (rainDelay) {
        const enabled = Boolean(rainDelay.enable);
        const delay = Number(rainDelay.delay);
        ctx.adapterProxy.setStateConditional('info.goat.settings.rainDelayEnabled', enabled, true);
        ctx.adapterProxy.setStateConditional('info.goat.settings.rainDelayMinutes', delay, true);
        ctx.adapterProxy.setStateConditional('control.goat.rainDelayEnabled', enabled, true);
        ctx.adapterProxy.setStateConditional('control.goat.rainDelayMinutes', delay, true);
        handled = true;
    }

    const animalProtection = getInfoData(payload, 'getAnimProtect');
    if (animalProtection) {
        const enabled = Boolean(animalProtection.enable);
        const start = normalizeTime(animalProtection.start);
        const end = normalizeTime(animalProtection.end);
        ctx.adapterProxy.setStateConditional('info.goat.settings.animalProtectionEnabled', enabled, true);
        ctx.adapterProxy.setStateConditional('info.goat.settings.animalProtectionStart', start, true);
        ctx.adapterProxy.setStateConditional('info.goat.settings.animalProtectionEnd', end, true);
        ctx.adapterProxy.setStateConditional('control.goat.animalProtectionEnabled', enabled, true);
        ctx.adapterProxy.setStateConditional('control.goat.animalProtectionStart', start, true);
        ctx.adapterProxy.setStateConditional('control.goat.animalProtectionEnd', end, true);
        handled = true;
    }

    const timezone = getInfoData(payload, 'getTimeZone');
    if (timezone) {
        ctx.adapterProxy.setStateConditional('info.goat.settings.timezone', timezone.code || '', true);
        ctx.adapterProxy.setStateConditional('info.goat.settings.timezoneOffsetMinutes', Number(timezone.tzm), true);
        handled = true;
    }

    const customCutMode = getInfoData(payload, 'getCustomCutMode');
    if (customCutMode) {
        ctx.adapterProxy.setStateConditional(
            'info.goat.settings.customCutMode', Boolean(customCutMode.enable), true
        );
        handled = true;
    }

    const borderSwitch = getInfoData(payload, 'getBorderSwitch');
    if (borderSwitch) {
        ctx.adapterProxy.setStateConditional(
            'info.goat.settings.borderModeEnabled', Boolean(borderSwitch.enable), true
        );
        ctx.adapterProxy.setStateConditional(
            'info.goat.settings.borderMode', Number(borderSwitch.mode), true
        );
        handled = true;
    }
    return handled;
}

/** Consume a Generic GOAT settings response and update ioBroker states. */
function handlePayload(ctx, payload) {
    if (!supportsSettings(ctx) || !payload || typeof payload !== 'object') return false;
    const handledAreaParameters = handleAreaParameters(ctx, payload);
    const handledGlobalSettings = handleGlobalSettings(ctx, payload);
    const handled = handledAreaParameters || handledGlobalSettings;
    if (handled) {
        ctx.adapterProxy.setStateConditional('info.goat.settings.lastUpdate', Date.now(), true);
    }
    return handled;
}

module.exports = {
    INFO_QUERIES,
    handlePayload,
    heightLevelToCm,
    normalizeTime
};
