import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionJournal } from '../src/journal.js';

// Mock localStorage for testing
const mockStorage = new Map();
global.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

test('SessionJournal creates, records, and completes sessions', () => {
  const journal = new SessionJournal();
  assert.equal(journal.getHistory().length, 0);

  const session = journal.startSession({
    source: 'sim',
    protocol: 'single',
    target: 'alpha'
  });
  assert.ok(session.id);
  assert.equal(session.protocol, 'single');

  // Record 10 ticks (each 0.1s) with reward active
  for (let i = 0; i < 10; i++) {
    journal.recordTick(0.1, true, { alpha: 12.5, beta: 5.2 });
  }
  // Record 5 ticks with reward inactive
  for (let i = 0; i < 5; i++) {
    journal.recordTick(0.1, false, { alpha: 4.0, beta: 8.0 });
  }

  const finished = journal.finishSession(850);
  assert.equal(finished.stats.score, 850);
  assert.ok(finished.stats.totalDurationSeconds >= 1);
  assert.ok(finished.stats.rewardSeconds >= 0.9);
  assert.ok(finished.stats.timeInZonePct > 50);

  // Check persistence
  const history = journal.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].id, session.id);

  // Check CSV and JSON export
  const json = journal.exportJSON();
  assert.ok(json.includes(session.id));
  const csv = journal.exportCSV();
  assert.ok(csv.includes('alpha'));
  assert.ok(csv.includes('850'));
});
