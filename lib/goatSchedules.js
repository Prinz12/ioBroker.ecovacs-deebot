'use strict';

const { isDeepStrictEqual } = require('node:util');
const lzma = require('lzma-purejs');
const helper = require('./adapterHelper');
const goatMap = require('./goatMap');

const SCHEDULE_ACTIONS = new Set(['add', 'mod', 'del']);
const UI_ONLY_TASK_FIELDS = new Set(['tempData', 'hide', 'userSetEndTime']);

/** Check whether GOAT schedule operations are verified for this mower. */
function isSupported(ctx) {
    return helper.supportsLawnMowerControl(
        ctx.getPlatformType(), ctx.getModel().getDeviceClass()
    );
}

/** Extract the schedule list from the response shapes used by Generic commands. */
function extractScheduleList(payload) {
    const containers = [payload, payload?.data, payload?.getSchedules, payload?.getSchedules?.data];
    const container = containers.find(item =>
        item && typeof item === 'object' && Object.hasOwn(item, 'list')
    );
    if (!container) return null;
    return Array.isArray(container.list) ? container.list : [];
}

/** Decode one compressed GOAT task list, while accepting already decoded fixtures. */
function decodeTasks(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    if (typeof value !== 'string') throw new Error('Schedule tasks are not an array or string');
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
    } catch {
        // Official GOAT responses normally use shortened LZMA here.
    }
    let decoded;
    try {
        decoded = goatMap.decodeLzmaJson(value);
    } catch {
        const raw = Buffer.from(lzma.decompressFile(Buffer.from(value, 'base64'))).toString('utf8');
        decoded = JSON.parse(raw);
    }
    if (!Array.isArray(decoded)) throw new Error('Decoded schedule tasks are not an array');
    return decoded;
}

/** Normalize one schedule returned by the mower. */
function normalizeSchedule(schedule) {
    return {
        ...schedule,
        sid: String(schedule?.sid ?? ''),
        name: String(schedule?.name ?? ''),
        using: Number(schedule?.using) === 1 ? 1 : 0,
        rotation: Number(schedule?.rotation) === 1 ? 1 : 0,
        subsets: decodeTasks(schedule?.subsets)
    };
}

/** Store a successfully read GOAT schedule list in ioBroker. */
function writeScheduleStates(ctx, schedules) {
    const active = schedules.find(schedule => schedule.using === 1);
    ctx.goatSchedules = schedules;
    ctx.adapterProxy.setStateConditional('info.goat.schedules.list', JSON.stringify(schedules), true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.count', schedules.length, true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.activeScheduleId', active?.sid || '', true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.activeScheduleName', active?.name || '', true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.catchUpEnabled', Boolean(active?.rotation), true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.lastUpdate', Date.now(), true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.status', 'ready', true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.lastError', '', true);
}

/** Consume a Generic getSchedules response. */
function handlePayload(ctx, payload) {
    if (!isSupported(ctx) || !payload || typeof payload !== 'object') return false;
    const rawSchedules = extractScheduleList(payload);
    if (rawSchedules === null) return false;
    try {
        const schedules = rawSchedules.map(normalizeSchedule)
            .sort((left, right) => right.using - left.using);
        writeScheduleStates(ctx, schedules);
    } catch (error) {
        ctx.adapter.log.warn(`Could not decode GOAT schedules: ${error.message}`);
        ctx.adapterProxy.setStateConditional('info.goat.schedules.status', 'error', true);
        ctx.adapterProxy.setStateConditional('info.goat.schedules.lastError', error.message, true);
    }
    return true;
}

/** Start a model-gated read-only schedule refresh. */
function requestSchedules(ctx) {
    if (!isSupported(ctx)) {
        ctx.adapter.log.warn('GOAT schedules are not verified for this mower model');
        return false;
    }
    ctx.adapterProxy.setStateConditional('info.goat.schedules.status', 'loading', true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.lastError', '', true);
    ctx.intervalQueue.run('Generic', 'getSchedules');
    return true;
}

/** Return one cached schedule by id. */
function getCachedSchedule(ctx, scheduleId) {
    const schedules = Array.isArray(ctx.goatSchedules) ? ctx.goatSchedules : [];
    return schedules.find(schedule => String(schedule.sid) === String(scheduleId));
}

/** Read one schedule staging value from ioBroker. */
async function getDraftState(ctx, stateName) {
    const state = await ctx.adapterProxy.getStateAsync(`control.goat.${stateName}`);
    return state?.val;
}

/** Parse and validate a 24-hour time. */
function normalizeTime(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Strip app-only fields and normalize one task for the GOAT API. */
function normalizeDraftTask(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new Error('Every schedule task must be an object');
    }
    const normalized = {};
    for (const [key, value] of Object.entries(task)) {
        if (!UI_ONLY_TASK_FIELDS.has(key) && key !== 'taskAct') normalized[key] = value;
    }
    if (task.ssid !== undefined && task.ssid !== null && task.ssid !== '') {
        normalized.ssid = String(task.ssid);
    } else {
        delete normalized.ssid;
    }
    normalized.mowType = Number(task.mowType);
    normalized.workType = Number(task.workType ?? 1);
    normalized.isOpen = Number(task.isOpen ?? 1) === 1 ? 1 : 0;
    normalized.sDay = Number(task.sDay);
    normalized.eDay = Number(task.eDay);
    normalized.sTime = normalizeTime(task.sTime);
    normalized.eTime = normalizeTime(task.eTime);
    if (![1, 2, 3].includes(normalized.mowType)) {
        throw new Error('Task mowType must be 1, 2 or 3');
    }
    if (normalized.workType !== 1) throw new Error('Task workType must be 1');
    if (!Number.isInteger(normalized.sDay) || normalized.sDay < 0 || normalized.sDay > 6
        || !Number.isInteger(normalized.eDay) || normalized.eDay < 0 || normalized.eDay > 6) {
        throw new Error('Task weekdays must be integers from 0 to 6');
    }
    if (!normalized.sTime || !normalized.eTime) throw new Error('Task times must use HH:mm');
    if ([2, 3].includes(normalized.mowType) && !String(task.ids ?? '').trim()) {
        throw new Error('Area and trimming tasks require ids');
    }
    if (task.ids !== undefined) normalized.ids = String(task.ids);
    if (task.duration !== undefined) {
        normalized.duration = Number(task.duration);
        if (!Number.isFinite(normalized.duration) || normalized.duration < 0) {
            throw new Error('Task duration must be a non-negative number');
        }
    }
    return normalized;
}

/** Parse the complete desired task list from the staging JSON state. */
function parseDraftTasks(value) {
    let tasks = value;
    if (typeof value === 'string') {
        try {
            tasks = JSON.parse(value);
        } catch {
            throw new Error('Schedule tasks contain invalid JSON');
        }
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('A schedule requires at least one task');
    }
    return tasks.map(normalizeDraftTask);
}

/** Read and validate the complete local schedule draft. */
async function readDraft(ctx) {
    const [sidValue, nameValue, usingValue, rotationValue, tasksValue] = await Promise.all([
        getDraftState(ctx, 'scheduleId'),
        getDraftState(ctx, 'scheduleName'),
        getDraftState(ctx, 'scheduleEnabled'),
        getDraftState(ctx, 'scheduleCatchUp'),
        getDraftState(ctx, 'scheduleTasks')
    ]);
    const name = String(nameValue ?? '').trim();
    if (!name || name.length > 24) throw new Error('Schedule name must contain 1-24 characters');
    const tasks = parseDraftTasks(tasksValue);
    const rotation = rotationValue === true ? 1 : 0;
    if (rotation && tasks.some(task => task.mowType === 3)) {
        throw new Error('Trimming schedules do not support catch-up mode');
    }
    return {
        sid: String(sidValue ?? '').trim(),
        name,
        using: usingValue === true ? 1 : 0,
        rotation,
        subsets: tasks
    };
}

/** Build the task delta expected by setSchedules for an existing schedule. */
function buildTaskChanges(currentTasks, desiredTasks) {
    const currentById = new Map(currentTasks.map(task => [String(task.ssid ?? ''), normalizeDraftTask(task)]));
    const retainedIds = new Set();
    const changes = [];
    for (const desired of desiredTasks) {
        if (!desired.ssid) {
            const added = { ...desired, taskAct: 'add' };
            delete added.ssid;
            changes.push(added);
            continue;
        }
        const current = currentById.get(desired.ssid);
        if (!current) throw new Error(`Unknown schedule task id ${desired.ssid}`);
        retainedIds.add(desired.ssid);
        if (!isDeepStrictEqual(current, desired)) changes.push({ ...desired, taskAct: 'mod' });
    }
    for (const current of currentById.values()) {
        if (current.ssid && !retainedIds.has(current.ssid)) {
            changes.push({ ...current, taskAct: 'del' });
        }
    }
    return changes;
}

/** Build one exact setSchedules payload from a validated draft. */
function buildPayload(action, draft, currentSchedule) {
    if (!SCHEDULE_ACTIONS.has(action)) throw new Error(`Unsupported schedule action ${action}`);
    if (action === 'add') {
        return {
            name: draft.name,
            using: draft.using,
            rotation: draft.rotation,
            schedAct: 'add',
            subsets: draft.subsets.map(task => {
                const added = { ...task, taskAct: 'add' };
                delete added.ssid;
                return added;
            })
        };
    }
    if (!currentSchedule) throw new Error(`Unknown schedule id ${draft.sid || '(empty)'}`);
    if (action === 'del') {
        return {
            sid: currentSchedule.sid,
            name: currentSchedule.name,
            using: currentSchedule.using,
            rotation: currentSchedule.rotation,
            schedAct: 'del',
            subsets: []
        };
    }
    return {
        sid: currentSchedule.sid,
        name: draft.name,
        using: draft.using,
        rotation: draft.rotation,
        schedAct: 'mod',
        subsets: buildTaskChanges(currentSchedule.subsets, draft.subsets)
    };
}

/** Load one cached schedule into the writable staging states. */
function loadDraft(ctx, scheduleId) {
    const schedule = getCachedSchedule(ctx, scheduleId);
    if (!schedule) throw new Error(`Unknown schedule id ${scheduleId || '(empty)'}`);
    const values = {
        scheduleId: schedule.sid,
        scheduleName: schedule.name,
        scheduleEnabled: schedule.using === 1,
        scheduleCatchUp: schedule.rotation === 1,
        scheduleTasks: JSON.stringify(schedule.subsets)
    };
    for (const [stateName, value] of Object.entries(values)) {
        ctx.adapterProxy.setStateConditional(`control.goat.${stateName}`, value, true);
    }
    return schedule;
}

/** Set the visible schedule operation status and optional error. */
function setStatus(ctx, status, error = '') {
    ctx.adapterProxy.setStateConditional('info.goat.schedules.status', status, true);
    ctx.adapterProxy.setStateConditional('info.goat.schedules.lastError', error, true);
}

module.exports = {
    buildPayload,
    buildTaskChanges,
    decodeTasks,
    extractScheduleList,
    getCachedSchedule,
    handlePayload,
    isSupported,
    loadDraft,
    normalizeDraftTask,
    normalizeSchedule,
    parseDraftTasks,
    readDraft,
    requestSchedules,
    setStatus
};
