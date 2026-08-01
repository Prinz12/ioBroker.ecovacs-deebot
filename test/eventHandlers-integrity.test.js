'use strict';

const { expect } = require('chai');
const { describe, it, before } = require('mocha');
const fs = require('fs');

const EXPECTED_EXPORTS = [
    'registerReadyEvent',
    'registerChargeStateEvent',
    'registerCleanReportEvent',
    'registerWaterCleaningEvents',
    'registerStationEvents',
    'registerConsumableEvents',
    'registerMapEvents',
    'registerConnectionEvents',
    'registerAirbotEvents',
    'registerMiscEventHandlers'
];

describe('eventHandlers.js - integrity checks', () => {
    describe('file-level structure', () => {
        it("line 1 should be exactly 'use strict;' with no await corruption", () => {
            const raw = fs.readFileSync(
                require.resolve('../lib/eventHandlers'),
                'utf-8'
            );
            const firstLine = raw.split(/\r?\n/)[0];
            expect(firstLine).to.equal("'use strict';");
        });

        it('first 10 lines should not contain standalone top-level await', () => {
            const raw = fs.readFileSync(
                require.resolve('../lib/eventHandlers'),
                'utf-8'
            );
            const lines = raw.split(/\r?\n/);
            const topLines = lines.slice(0, 10);
            for (const line of topLines) {
                const trimmed = line.trim();
                expect(trimmed).not.to.match(/^await\b/);
            }
        });
    });

    describe('module exports', () => {
        let eventHandlers;

        before(() => {
            expect(() => {
                eventHandlers = require('../lib/eventHandlers');
            }).not.to.throw();
        });

        it('should export the expected 10 handler functions', () => {
            expect(eventHandlers).to.be.an('object');
            const exportedKeys = Object.keys(eventHandlers);
            EXPECTED_EXPORTS.forEach((name) => {
                expect(exportedKeys).to.include(name);
            });
        });

        it('should have exactly the expected number of exports', () => {
            expect(Object.keys(eventHandlers)).to.have.lengthOf(EXPECTED_EXPORTS.length);
        });

        EXPECTED_EXPORTS.forEach((name) => {
            it(name + ' should be a function with 3-4 parameters', () => {
                expect(eventHandlers[name]).to.be.a('function');
                expect(eventHandlers[name].length).to.be.within(3, 4);
            });
        });

        it('all exports should be defined (not null/undefined)', () => {
            for (const [key, value] of Object.entries(eventHandlers)) {
                expect(value, 'export "' + key + '"').to.exist;
            }
        });
    });

    describe('syntax integrity', () => {
        it('node --check should pass on the file', function() {
            const { execFileSync } = require('child_process');
            const filePath = require.resolve('../lib/eventHandlers');
            expect(() => {
                execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
            }).not.to.throw();
        });
    });
});
