'use strict';

const { expect } = require('chai');
const { describe, it } = require('mocha');
const lzma = require('lzma-purejs');
const goatSchedules = require('../lib/goatSchedules');
const { createMockCtx } = require('./mockHelper');

/** Encode JSON with the shortened LZMA-Alone header used by GOAT. */
function encodeGoatFixture(value) {
    const standard = Buffer.from(lzma.compressFile(Buffer.from(JSON.stringify(value))));
    return Buffer.concat([standard.subarray(0, 9), standard.subarray(13)]).toString('base64');
}

/** Return one valid automatic mowing task for schedule tests. */
function createTask(overrides = {}) {
    return {
        ssid: 'task-1',
        mowType: 1,
        workType: 1,
        isOpen: 1,
        sDay: 1,
        sTime: '09:00',
        eDay: 1,
        eTime: '11:00',
        ...overrides
    };
}

/** Assert a rejected schedule draft without relying on a global Chai plugin. */
async function expectDraftError(ctx, message) {
    let actualError;
    try {
        await goatSchedules.readDraft(ctx);
    } catch (error) {
        actualError = error;
    }
    expect(actualError).to.be.instanceOf(Error);
    expect(actualError.message).to.equal(message);
}

describe('goatSchedules.js', () => {
    it('decodes and exposes the official getSchedules response', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');
        const payload = {
            list: [{
                sid: 7,
                name: 'Werktage',
                using: 1,
                rotation: 1,
                subsets: encodeGoatFixture([createTask()])
            }]
        };

        expect(goatSchedules.handlePayload(ctx, payload)).to.be.true;
        expect(ctx.goatSchedules[0].subsets).to.deep.equal([createTask()]);
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.schedules.activeScheduleId', '7', true
        )).to.be.true;
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.schedules.catchUpEnabled', true, true
        )).to.be.true;
    });

    it('recognizes an empty schedule list', () => {
        const ctx = createMockCtx();
        ctx.getPlatformType.returns('lawnMower');
        ctx.getModel().getDeviceClass.returns('2i0fns');

        expect(goatSchedules.handlePayload(ctx, { list: [] })).to.be.true;
        expect(ctx.goatSchedules).to.deep.equal([]);
        expect(ctx.adapterProxy.setStateConditional.calledWith(
            'info.goat.schedules.count', 0, true
        )).to.be.true;
    });

    it('builds the exact create payload and removes temporary task ids', () => {
        const draft = {
            name: 'Morgenrunde',
            using: 1,
            rotation: 0,
            subsets: [createTask({ ssid: undefined })]
        };

        const payload = goatSchedules.buildPayload('add', draft);

        expect(payload).to.include({
            name: 'Morgenrunde', using: 1, rotation: 0, schedAct: 'add'
        });
        expect(payload.subsets[0].taskAct).to.equal('add');
        expect(payload.subsets[0]).to.not.have.property('ssid');
    });

    it('builds update deltas for modified, added and removed tasks', () => {
        const current = {
            sid: '7',
            name: 'Alt',
            using: 1,
            rotation: 0,
            subsets: [createTask(), createTask({ ssid: 'task-2', sDay: 2, eDay: 2 })]
        };
        const desired = {
            sid: '7',
            name: 'Neu',
            using: 1,
            rotation: 0,
            subsets: [
                createTask({ eTime: '12:00' }),
                createTask({ ssid: undefined, sDay: 3, eDay: 3 })
            ]
        };

        const payload = goatSchedules.buildPayload('mod', desired, current);

        expect(payload).to.include({ sid: '7', name: 'Neu', schedAct: 'mod' });
        expect(payload.subsets.map(task => task.taskAct)).to.have.members(['mod', 'add', 'del']);
        expect(payload.subsets.find(task => task.taskAct === 'del').ssid).to.equal('task-2');
    });

    it('rejects trimming tasks while catch-up mode is enabled', async () => {
        const ctx = createMockCtx();
        const values = {
            'control.goat.scheduleId': '',
            'control.goat.scheduleName': 'Trimmen',
            'control.goat.scheduleEnabled': true,
            'control.goat.scheduleCatchUp': true,
            'control.goat.scheduleTasks': JSON.stringify([
                createTask({ mowType: 3, ids: 'reid:1' })
            ])
        };
        ctx.adapterProxy.getStateAsync.callsFake(id => Promise.resolve({ val: values[id] }));

        await expectDraftError(ctx, 'Trimming schedules do not support catch-up mode');
    });

    it('rejects task times outside the official 15-minute grid', async () => {
        const ctx = createMockCtx();
        const values = {
            'control.goat.scheduleId': '',
            'control.goat.scheduleName': 'Zu kurz',
            'control.goat.scheduleEnabled': false,
            'control.goat.scheduleCatchUp': false,
            'control.goat.scheduleTasks': JSON.stringify([
                createTask({ sTime: '00:01', eTime: '00:02' })
            ])
        };
        ctx.adapterProxy.getStateAsync.callsFake(id => Promise.resolve({ val: values[id] }));

        await expectDraftError(ctx, 'Task times must use 15-minute steps');
    });

    it('rejects a zero-length task on the same weekday', async () => {
        const ctx = createMockCtx();
        const values = {
            'control.goat.scheduleId': '',
            'control.goat.scheduleName': 'Ohne Dauer',
            'control.goat.scheduleEnabled': false,
            'control.goat.scheduleCatchUp': false,
            'control.goat.scheduleTasks': JSON.stringify([
                createTask({ sTime: '09:00', eTime: '09:00' })
            ])
        };
        ctx.adapterProxy.getStateAsync.callsFake(id => Promise.resolve({ val: values[id] }));

        await expectDraftError(ctx, 'Task duration must be at least 15 minutes');
    });

    it('builds the official schedule deletion payload', () => {
        const current = {
            sid: '7', name: 'Alt', using: 1, rotation: 1, subsets: [createTask()]
        };

        expect(goatSchedules.buildPayload('del', { sid: '7' }, current)).to.deep.equal({
            sid: '7', name: 'Alt', using: 1, rotation: 1, schedAct: 'del', subsets: []
        });
    });
});
