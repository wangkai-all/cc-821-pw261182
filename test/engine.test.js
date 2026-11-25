import test from 'node:test';
import assert from 'node:assert/strict';

import { Y, splitWeighted, applyBps } from '../src/core/money.js';
import { SAMPLE_WORKBOOKS, SAMPLE_MAP } from '../src/core/scenarios.js';
import { settleStream, compareRuns, clauseAllocation } from '../src/core/engine.js';

test('定点数：字符串金额不经过浮点，bps 与尾差可追踪', () => {
  assert.equal(Y('1,234.56'), 123456);
  assert.equal(Y('-0.01'), -1);
  assert.equal(applyBps(10001, 500), 500); // 10001 * 5% = 500.05 分，四舍五入为 500
  const split = splitWeighted(10001, [
    { key: 'P1', bps: 3333 },
    { key: 'P2', bps: 3333 },
    { key: 'P3', bps: 3334 },
  ]);
  assert.deepEqual(split.amounts, { P1: 3333, P2: 3333, P3: 3335 });
  assert.equal(split.tailAdjustments[0].key, 'P3');
  assert.equal(split.tailAdjustments[0].amountCents, 1);
});

test('条款切分不会让各层独立赔款之和超过原损失', () => {
  const contract = SAMPLE_MAP['order-effect'].contracts[0];
  const alloc = clauseAllocation(Y('600'), contract);
  assert.equal(alloc.deductibleCents, Y('40'));
  assert.equal(alloc.layerCents.L1, Y('160'));
  assert.equal(alloc.layerCents.L2, Y('300'));
  assert.equal(alloc.unplacedCents, Y('100'));
  const sum = alloc.deductibleCents + Object.values(alloc.layerCents).reduce((a, b) => a + b, 0) + alloc.unplacedCents;
  assert.equal(sum, Y('600'));
});

test('顺序样例：A 中恢复额度被中额案使用，B 中恢复来不及追溯触发笔', () => {
  const wb = SAMPLE_MAP['order-effect'];
  const a = settleStream(wb, wb.orderA);
  const b = settleStream(wb, wb.orderB);
  const cmp = compareRuns(a, b);

  assert.equal(a.totals.grossLossCents, 74000);
  assert.deepEqual(
    { retention: a.totals.retentionCents, layers: a.totals.layerPaidGrossCents, fees: a.totals.reinstatementPremiumCents },
    { retention: 18000, layers: 56000, fees: 800 },
  );
  assert.deepEqual(
    { retention: b.totals.retentionCents, layers: b.totals.layerPaidGrossCents, fees: b.totals.reinstatementPremiumCents },
    { retention: 28000, layers: 46000, fees: 800 },
  );
  assert.equal(cmp.totals.retentionDiff, 10000);
  assert.equal(cmp.totals.layerPaidDiff, -10000);

  const bigA = a.events.find((e) => e.eventId === 'E-BIG');
  const midA = a.events.find((e) => e.eventId === 'E-MID');
  assert.equal(bigA.actualLayerGrossCents.L1, 16000);
  assert.equal(midA.actualLayerGrossCents.L1, 10000);

  const bigB = b.events.find((e) => e.eventId === 'E-BIG');
  const midB = b.events.find((e) => e.eventId === 'E-MID');
  assert.equal(midB.actualLayerGrossCents.L1, 10000);
  assert.equal(bigB.actualLayerGrossCents.L1, 6000);
  assert.equal(bigB.shortfallLayerGrossCents.L1, 10000);
  assert.equal(b.layers.find((l) => l.layerId === 'L1').endingPendingCents, 16000);
});

test('补损和冲回回到原事件：免赔不重新使用，逐层流水可冲回', () => {
  const wb = SAMPLE_MAP.development;
  const a = settleStream(wb, wb.orderA);
  assert.equal(a.totals.grossLossCents, 30000);
  assert.equal(a.totals.deductibleCents, 10000);
  assert.equal(a.totals.layerPaidGrossCents, 20000);

  const supplement = a.entries.find((e) => e.movementId === 'M-DEV-2');
  const revision = a.entries.find((e) => e.movementId === 'M-DEV-3');
  assert.equal(supplement.lines.find((l) => l.reason === 'OCCURRENCE_DEDUCTIBLE').amountCents, 0);
  assert.equal(supplement.layerSteps.find((s) => s.layerId === 'D-L1').paidDeltaCents, 5000);
  assert.equal(supplement.layerSteps.find((s) => s.layerId === 'D-L2').paidDeltaCents, 7000);
  assert.equal(revision.layerSteps.find((s) => s.layerId === 'D-L2').paidDeltaCents, -7000);

  const b = settleStream(wb, wb.orderB);
  const revisionFirst = b.entries.find((e) => e.seq === 2);
  const supplementLater = b.entries.find((e) => e.seq === 3);
  assert.equal(revisionFirst.layerSteps.find((s) => s.layerId === 'D-L1').paidDeltaCents, -7000);
  assert.equal(supplementLater.layerSteps.find((s) => s.layerId === 'D-L1').paidDeltaCents, 12000);
  assert.equal(b.totals.balanced, true);
  assert.equal(b.totals.layerPaidGrossCents, 20000);
});

test('跨年度样例：2026 入账补损仍适用 2025 合同，2026 新事件额度独立', () => {
  const wb = SAMPLE_MAP['cross-year'];
  const run = settleStream(wb, wb.orderA);
  const e25 = run.events.find((e) => e.eventId === 'E-25');
  const e26 = run.events.find((e) => e.eventId === 'E-26');
  assert.equal(e25.contractId, 'C-2025');
  assert.equal(e25.lossCents, 44000);
  assert.equal(e25.actualLayerGrossCents['CY-L1-25'], 30000);
  assert.equal(e25.unplacedCents, 4000);
  assert.equal(e26.contractId, 'C-2026');
  assert.equal(e26.actualLayerGrossCents['CY-L1-26'], 8000);
  assert.equal(run.totals.grossLossCents, 62000);
  assert.equal(run.totals.layerPaidGrossCents, 38000);
});

test('耗尽样例：两次恢复后第三次恢复失败，第四笔自留缺口 200', () => {
  const wb = SAMPLE_MAP['exhaustion-failure'];
  const run = settleStream(wb, wb.orderA);
  assert.deepEqual(run.events.map((e) => e.actualLayerGrossCents['X-L1']), [20000, 20000, 20000, 0]);
  assert.equal(run.totals.layerPaidGrossCents, 60000);
  assert.equal(run.totals.limitShortfallCents, 20000);
  assert.equal(run.totals.reinstatementPremiumCents, 2000);
  assert.equal(run.restorations.filter((r) => r.status === 'EFFECTIVE').length, 2);
  assert.equal(run.restorations.filter((r) => r.status === 'FAILED')[0].reasonCode, 'MAX_REINSTATEMENT_COUNT');
});

test('生效限制样例：等待一笔期间紧邻事件不能使用恢复额度', () => {
  const wb = SAMPLE_MAP['reinstatement-wait'];
  const a = settleStream(wb, wb.orderA);
  assert.deepEqual(a.events.map((e) => [e.eventId, e.actualLayerGrossCents['W-L1']]), [
    ['E-W1', 20000],
    ['E-W2', 0],
    ['E-W3', 20000],
  ]);
  const w2 = a.entries.find((e) => e.eventId === 'E-W2');
  assert.equal(w2.layerSteps[0].shortfallDeltaCents, 20000);
  assert.match(w2.lines.find((l) => l.reason === 'REINSTATEMENT_PENDING_NOT_EFFECTIVE').reason, /PENDING/);

  const b = settleStream(wb, wb.orderB);
  assert.deepEqual(b.events.map((e) => [e.eventId, e.actualLayerGrossCents['W-L1']]), [
    ['E-W1', 20000],
    ['E-W3', 0],
    ['E-W2', 20000],
  ]);
});

test('尾差样例：100.01 元层赔款完整分配且 1 分尾差可追踪', () => {
  const wb = SAMPLE_MAP['rounding-tail'];
  const run = settleStream(wb, wb.orderA);
  assert.equal(run.totals.layerPaidGrossCents, 10001);
  assert.equal(run.tailRecords.length > 0, true);
  assert.equal(run.tailRecords.at(-1).key, 'P3');
  const participant = run.entries[0].layerSteps[0].participants;
  assert.equal(participant.amountsAfter.P1 + participant.amountsAfter.P2 + participant.amountsAfter.P3, 10001);
});

test('全部样例与两套顺序：每笔流水和总结算都平衡', () => {
  for (const wb of SAMPLE_WORKBOOKS) {
    for (const key of ['orderA', 'orderB']) {
      const run = settleStream(wb, wb[key], { orderKey: key });
      for (const entry of run.entries) {
        assert.equal(entry.balanced, true, `${wb.id}/${key}/#${entry.seq}`);
        assert.equal(entry.checksumCents, entry.signedDeltaCents);
      }
      assert.equal(run.totals.balanced, true, wb.id);
      assert.equal(run.totals.conservationDifferenceCents, 0, wb.id);
      assert.equal(run.totals.retentionCents + run.totals.layerPaidGrossCents, run.totals.grossLossCents);
    }
  }
});
