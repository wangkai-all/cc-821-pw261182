import { applyBps, splitWeighted, sumMoney } from './money.js';
import { validateWorkbook, ValidationError } from './validation.js';

export { ValidationError };

export function sortedLayers(contract) {
  return [...contract.layers].sort((a, b) => {
    const oa = Number.isInteger(a.order) ? a.order : 999;
    const ob = Number.isInteger(b.order) ? b.order : 999;
    return oa - ob || a.id.localeCompare(b.id);
  });
}

/**
 * 纯条款口径：把累计事件损失唯一地切给免赔、各层和未分配损失。
 * 后序层只能对扣除免赔和先序层已分配后的残额适用，因此不会出现各层独立
 * 计算后赔款之和超过原损失。
 */
export function clauseAllocation(lossCents, contract) {
  if (!Number.isInteger(lossCents) || lossCents < 0) {
    throw new Error(`clauseAllocation 只接受非负整数分，收到 ${lossCents}`);
  }
  const deductibleLimit = contract.occurrenceDeductibleCents ?? 0;
  const deductibleCents = Math.min(lossCents, deductibleLimit);
  let residualAboveDeductible = lossCents - deductibleCents;

  const layerCents = {};
  const layerRawCents = {};
  for (const layer of sortedLayers(contract)) {
    const attachment = layer.attachmentCents ?? 0;
    const rawCents = Math.min(
      layer.occurrenceLimitCents,
      Math.max(0, lossCents - attachment),
    );
    // 不重复补偿上限：即便条款/起赔点重叠，也以尚未被免赔和先序层分配的残额为限。
    const targetCents = Math.max(0, Math.min(rawCents, residualAboveDeductible));
    layerRawCents[layer.id] = rawCents;
    layerCents[layer.id] = targetCents;
    residualAboveDeductible -= targetCents;
  }

  return {
    lossCents,
    deductibleCents,
    layerRawCents,
    layerCents,
    unplacedCents: residualAboveDeductible,
  };
}

export function movementDeltaCents(movement) {
  if (movement.type === 'revision') return -Math.abs(movement.amountCents);
  return Math.abs(movement.amountCents);
}

function participantsOf(layer) {
  if (Array.isArray(layer.participants) && layer.participants.length > 0) {
    return layer.participants.map((p, index) => ({
      key: p.id ?? p.key ?? `p${index}`,
      name: p.name ?? p.id ?? `份额${index + 1}`,
      bps: p.bps,
      tiePriority: p.tailPriority ?? index,
    }));
  }
  const selfBps = Number.isInteger(layer.shareBps) ? layer.shareBps : 10000;
  return [
    { key: 'self', name: layer.selfParticipantName ?? '本层承担份额', bps: selfBps, tiePriority: 0 },
    { key: 'other', name: '其余共保/未承保份额', bps: 10000 - selfBps, tiePriority: 10 },
  ];
}

function capacitySnapshot(layerState) {
  const layer = layerState.layer;
  const effectiveRestoredCents = layerState.restorations
    .filter((r) => r.status === 'EFFECTIVE')
    .reduce((s, r) => s + r.amountCents, 0);
  const pendingRestoredCents = layerState.restorations
    .filter((r) => r.status === 'PENDING')
    .reduce((s, r) => s + r.amountCents, 0);
  const failedCount = layerState.restorations.filter((r) => r.status === 'FAILED').length;
  const effectiveCapacityCents = layer.annualLimitCents + effectiveRestoredCents;
  const remainingCents = effectiveCapacityCents - layerState.annualUsedGrossCents;
  return {
    annualLimitCents: layer.annualLimitCents,
    annualUsedGrossCents: layerState.annualUsedGrossCents,
    effectiveRestoredCents,
    pendingRestoredCents,
    failedCount,
    effectiveCapacityCents,
    remainingCents,
    grantedCount: layerState.grantedCount,
    maxCount: layer.reinstatement?.maxCount ?? 0,
  };
}

function emptyEventState(event, contract) {
  const layerIds = sortedLayers(contract).map((l) => l.id);
  return {
    eventId: event.id,
    contractId: contract.id,
    lossCents: 0,
    deductibleCents: 0,
    unplacedCents: 0,
    targetLayerCents: Object.fromEntries(layerIds.map((id) => [id, 0])),
    actualLayerGrossCents: Object.fromEntries(layerIds.map((id) => [id, 0])),
    shortfallLayerGrossCents: Object.fromEntries(layerIds.map((id) => [id, 0])),
    participantCents: {},
    sequences: [],
  };
}

/**
 * 按给定 streamIds 顺序重放。函数不修改 workbook；返回可 JSON 序列化的完整版本。
 */
export function settleStream(workbook, streamIds, options = {}) {
  validateWorkbook(workbook, streamIds);

  const movementIndex = new Map();
  for (const event of workbook.events) {
    for (const movement of event.movements) {
      movementIndex.set(movement.id, { event, movement });
    }
  }
  const contractIndex = new Map(workbook.contracts.map((c) => [c.id, c]));
  function resolveContract(event) {
    if (event.contractId) return contractIndex.get(event.contractId);
    const found = workbook.contracts.find(
      (c) => event.occurrenceDate >= c.startDate && event.occurrenceDate <= c.endDate,
    );
    if (!found) throw new Error(`事件 ${event.id} 的发生日期找不到对应合同年度`);
    return found;
  }

  const contractStates = new Map();
  for (const contract of workbook.contracts) {
    const layers = sortedLayers(contract);
    contractStates.set(contract.id, {
      contract,
      contractSeq: 0,
      layers: new Map(layers.map((layer) => [layer.id, {
        layer,
        annualUsedGrossCents: 0,
        grantedCount: 0,
        restorations: [],
      }])),
    });
  }

  const eventStates = new Map();
  const entries = [];
  const restorationRecords = [];
  const tailRecords = [];
  const runSeq = options.runSeq ?? 1;

  streamIds.forEach((movementId, index) => {
    const seq = index + 1;
    const located = movementIndex.get(movementId);
    if (!located) throw new Error(`流水不存在：${movementId}`);
    const { event, movement } = located;
    const contract = resolveContract(event);
    const cState = contractStates.get(contract.id);
    cState.contractSeq += 1;
    const contractSeq = cState.contractSeq;

    if (!eventStates.has(event.id)) eventStates.set(event.id, emptyEventState(event, contract));
    const eState = eventStates.get(event.id);
    eState.sequences.push(seq);

    const entry = {
      seq,
      contractSeq,
      movementId,
      eventId: event.id,
      eventLabel: event.label ?? event.id,
      movementType: movement.type,
      postingDate: movement.date ?? null,
      occurrenceDate: event.occurrenceDate,
      contractId: contract.id,
      contractName: contract.name,
      memo: movement.memo ?? '',
      signedDeltaCents: movementDeltaCents(movement),
      lossBeforeCents: eState.lossCents,
      lossAfterCents: eState.lossCents + movementDeltaCents(movement),
      activatedRestorations: [],
      lines: [],
      layerSteps: [],
      restorationAttempts: [],
      tail: [],
      checksumCents: 0,
      balanced: false,
    };

    // 1) 在本合同流水开始前，激活已到约定生效序号的恢复额度。
    for (const ls of cState.layers.values()) {
      for (const restoration of ls.restorations) {
        if (restoration.status === 'PENDING' && restoration.availableAtContractSeq <= contractSeq) {
          restoration.status = 'EFFECTIVE';
          restoration.activatedAtSeq = seq;
          restoration.activatedAtContractSeq = contractSeq;
          entry.activatedRestorations.push(restoration);
        }
      }
    }

    if (entry.lossAfterCents < 0) {
      throw new Error(`事件 ${event.id} 在流水 ${movementId} 冲回后累计损失为负；请检查估损冲回金额`);
    }
    eState.lossCents = entry.lossAfterCents;

    const beforeAlloc = clauseAllocation(entry.lossBeforeCents, contract);
    const afterAlloc = clauseAllocation(entry.lossAfterCents, contract);

    // 2) 免赔按“同一事件累计损失”只吸收一次；冲回可回吐，之后补损继续用剩余免赔额。
    const deductibleDelta = afterAlloc.deductibleCents - beforeAlloc.deductibleCents;
    eState.deductibleCents = afterAlloc.deductibleCents;
    entry.lines.push({
      order: 0,
      bearerType: 'RETENTION',
      bearerKey: 'RETENTION',
      bearerName: contract.deductibleName ?? '每次事故免赔/自留',
      reason: 'OCCURRENCE_DEDUCTIBLE',
      layerId: null,
      amountCents: deductibleDelta,
      cumulativeEventCents: eState.deductibleCents,
      explanation: '同一事件累计口径，不按补损/冲回笔重复计免赔',
    });

    // 3) 按明确的条款顺序逐层结算。
    for (const [layerOrder, layer] of sortedLayers(contract).entries()) {
      const ls = cState.layers.get(layer.id);
      const beforeSnap = capacitySnapshot(ls);
      const targetBefore = beforeAlloc.layerCents[layer.id] ?? 0;
      const targetAfter = afterAlloc.layerCents[layer.id] ?? 0;
      const targetDelta = targetAfter - targetBefore;
      const actualBefore = eState.actualLayerGrossCents[layer.id] ?? 0;
      const shortfallBefore = eState.shortfallLayerGrossCents[layer.id] ?? 0;

      let paidDelta = 0;
      let actualAfter = actualBefore;
      let shortfallReason = null;

      if (targetDelta >= 0) {
        const available = Math.max(0, beforeSnap.remainingCents);
        paidDelta = Math.min(targetDelta, available);
        actualAfter = actualBefore + paidDelta;
        ls.annualUsedGrossCents += paidDelta;
        if (paidDelta < targetDelta) {
          const hasPending = ls.restorations.some((r) => r.status === 'PENDING');
          shortfallReason = hasPending ? 'REINSTATEMENT_PENDING_NOT_EFFECTIVE' : 'ANNUAL_LIMIT_OR_REINSTATEMENT_UNAVAILABLE';
        }
      } else {
        actualAfter = Math.min(actualBefore, targetAfter);
        paidDelta = actualAfter - actualBefore;
        ls.annualUsedGrossCents += paidDelta; // 负数：冲回赔款并恢复年度余额
      }

      eState.actualLayerGrossCents[layer.id] = actualAfter;
      const shortfallAfter = targetAfter - actualAfter;
      eState.shortfallLayerGrossCents[layer.id] = shortfallAfter;
      eState.targetLayerCents[layer.id] = targetAfter;
      const shortfallDelta = shortfallAfter - shortfallBefore;

      // 层内共保份额用最大余数法保留整分，尾差分配可追踪。
      const weights = participantsOf(layer);
      const split = splitWeighted(actualAfter, weights, {
        rule: 'LARGEST_REMAINDER__TIE_CLAUSE_ORDER',
      });
      const oldSplit = eState.participantCents[layer.id] ?? Object.fromEntries(weights.map((w) => [w.key, 0]));
      const participantDeltas = {};
      for (const w of weights) participantDeltas[w.key] = (split.amounts[w.key] ?? 0) - (oldSplit[w.key] ?? 0);
      eState.participantCents[layer.id] = split.amounts;
      if (split.tailAdjustments.length && paidDelta !== 0) {
        for (const tail of split.tailAdjustments) {
          const record = {
            runSeq,
            seq,
            movementId,
            eventId: event.id,
            contractId: contract.id,
            layerId: layer.id,
            currentMovementGrossDeltaCents: paidDelta,
            totalGrossCents: actualAfter,
            weights: weights.map((w) => ({ key: w.key, name: w.name, bps: w.bps })),
            finalAmounts: split.amounts,
            ...tail,
          };
          tailRecords.push(record);
          entry.tail.push(record);
        }
      }

      entry.lines.push({
        order: layerOrder + 1,
        bearerType: 'LAYER',
        bearerKey: layer.id,
        bearerName: layer.name,
        reason: 'LAYER_INDEMNITY',
        layerId: layer.id,
        amountCents: paidDelta,
        cumulativeEventCents: actualAfter,
        explanation: `按条款第 ${layer.order ?? layerOrder + 1} 顺序适用`,
      });

      if (shortfallDelta !== 0) {
        entry.lines.push({
          order: layerOrder + 1,
          bearerType: 'RETENTION',
          bearerKey: 'RETENTION',
          bearerName: '限额不足形成的自留缺口',
          reason: shortfallReason ?? 'LAYER_LIMIT_SHORTFALL_REVERSAL',
          layerId: layer.id,
          amountCents: shortfallDelta,
          cumulativeEventCents: shortfallAfter,
          explanation: shortfallReason === 'REINSTATEMENT_PENDING_NOT_EFFECTIVE'
            ? '恢复额度尚在生效等待内，本笔不得使用'
            : '年度有效额度不足；该缺口由分出人自留，不把赔款叠加给其他层',
        });
      }

      const afterSnap = capacitySnapshot(ls);
      const step = {
        layerId: layer.id,
        layerName: layer.name,
        clauseOrder: layer.order ?? layerOrder + 1,
        targetBeforeCents: targetBefore,
        targetAfterCents: targetAfter,
        targetDeltaCents: targetDelta,
        availableBeforeCents: beforeSnap.remainingCents,
        paidDeltaCents: paidDelta,
        shortfallDeltaCents: shortfallDelta,
        availableAfterCents: afterSnap.remainingCents,
        before: beforeSnap,
        after: afterSnap,
        participants: {
          weights: weights.map((w) => ({ key: w.key, name: w.name, bps: w.bps })),
          amountsAfter: split.amounts,
          deltas: participantDeltas,
          tailAdjustments: split.tailAdjustments,
        },
      };
      entry.layerSteps.push(step);

      // 4) 仅在“本笔支付把有效年度余额从正数打到 0”时产生一次恢复申请，避免重复触发。
      const exhaustedNow = beforeSnap.remainingCents > 0 && afterSnap.remainingCents === 0 && targetDelta >= 0;
      if (exhaustedNow) {
        const rule = layer.reinstatement ?? { maxCount: 0 };
        const grantNumber = ls.grantedCount + 1;
        const requestAmount = rule.amountCents ?? layer.occurrenceLimitCents;
        if (grantNumber <= (rule.maxCount ?? 0)) {
          ls.grantedCount = grantNumber;
          const premium = applyBps(requestAmount, rule.premiumRateBps ?? 0);
          const waitEntries = rule.waitEntries ?? 0;
          const restoration = {
            id: `R-${contract.id}-${layer.id}-${grantNumber}`,
            kind: 'REINSTATEMENT',
            contractId: contract.id,
            layerId: layer.id,
            layerName: layer.name,
            eventId: event.id,
            movementId,
            grantSeq: seq,
            grantContractSeq: contractSeq,
            count: grantNumber,
            amountCents: requestAmount,
            premiumRateBps: rule.premiumRateBps ?? 0,
            premiumCents: premium,
            waitEntries,
            availableAtContractSeq: contractSeq + waitEntries + 1,
            status: 'PENDING',
            reasonCode: 'ANNUAL_CAPACITY_EXHAUSTED',
            reason: waitEntries === 0
              ? '额度已用尽；恢复自下一笔同合同流水起可用，不追溯补到触发笔'
              : `额度已用尽；需经过 ${waitEntries} 笔同合同后续流水后生效`,
          };
          ls.restorations.push(restoration);
          restorationRecords.push(restoration);
          entry.restorationAttempts.push(restoration);
        } else {
          const failed = {
            id: `F-${contract.id}-${layer.id}-${grantNumber}`,
            kind: 'REINSTATEMENT_FAILED',
            contractId: contract.id,
            layerId: layer.id,
            layerName: layer.name,
            eventId: event.id,
            movementId,
            grantSeq: seq,
            grantContractSeq: contractSeq,
            count: grantNumber,
            amountCents: requestAmount,
            premiumRateBps: rule.premiumRateBps ?? 0,
            premiumCents: 0,
            waitEntries: rule.waitEntries ?? 0,
            availableAtContractSeq: null,
            status: 'FAILED',
            reasonCode: 'MAX_REINSTATEMENT_COUNT',
            reason: `已达到有限恢复次数上限 ${rule.maxCount ?? 0}，再次恢复失败`,
          };
          ls.restorations.push(failed);
          restorationRecords.push(failed);
          entry.restorationAttempts.push(failed);
        }
      }
    }

    // 5) 未分配损失（低于起赔点的空档、超过高层限额等）留在自留方。
    const unplacedDelta = afterAlloc.unplacedCents - beforeAlloc.unplacedCents;
    eState.unplacedCents = afterAlloc.unplacedCents;
    entry.lines.push({
      order: 999,
      bearerType: 'RETENTION',
      bearerKey: 'RETENTION',
      bearerName: '未分配/超限额损失',
      reason: 'UNPLACED_EXCESS',
      layerId: null,
      amountCents: unplacedDelta,
      cumulativeEventCents: eState.unplacedCents,
      explanation: '免赔以上但未落入任何层有效额度/条款区间的损失',
    });

    entry.checksumCents = sumMoney(entry.lines.map((line) => line.amountCents));
    entry.balanced = entry.checksumCents === entry.signedDeltaCents;
    if (!entry.balanced) {
      throw new Error(`流水 ${movementId} 分摊不平：delta=${entry.signedDeltaCents}, sum=${entry.checksumCents}`);
    }
    entries.push(entry);
  });

  // 汇总。
  const layerMeta = new Map();
  for (const c of workbook.contracts) {
    for (const l of sortedLayers(c)) layerMeta.set(l.id, { contractId: c.id, contractName: c.name, layer: l });
  }

  const byLayer = {};
  for (const [layerId, meta] of layerMeta) {
    byLayer[layerId] = {
      layerId,
      layerName: meta.layer.name,
      contractId: meta.contractId,
      contractName: meta.contractName,
      paidGrossCents: 0,
      shortfallCents: 0,
      restorationPremiumCents: 0,
      restorationCount: 0,
      failedCount: 0,
      endingRemainingCents: capacitySnapshot(contractStates.get(meta.contractId).layers.get(layerId)).remainingCents,
      endingPendingCents: capacitySnapshot(contractStates.get(meta.contractId).layers.get(layerId)).pendingRestoredCents,
    };
  }

  let grossLossCents = 0;
  let deductibleCents = 0;
  let unplacedCents = 0;
  let limitShortfallCents = 0;
  let layerPaidGrossCents = 0;

  const eventResults = [];
  for (const [eventId, eState] of eventStates) {
    grossLossCents += eState.lossCents;
    deductibleCents += eState.deductibleCents;
    unplacedCents += eState.unplacedCents;
    let eventLayerPaid = 0;
    let eventShortfall = 0;
    for (const layerId of Object.keys(eState.actualLayerGrossCents)) {
      const paid = eState.actualLayerGrossCents[layerId];
      const shortfall = eState.shortfallLayerGrossCents[layerId];
      eventLayerPaid += paid;
      eventShortfall += shortfall;
      layerPaidGrossCents += paid;
      limitShortfallCents += shortfall;
      if (byLayer[layerId]) {
        byLayer[layerId].paidGrossCents += paid;
        byLayer[layerId].shortfallCents += shortfall;
      }
    }
    const eventEntries = entries.filter((x) => x.eventId === eventId);
    const first = eventEntries[0];
    const last = eventEntries[eventEntries.length - 1];
    const beforeCapacity = {};
    const afterCapacity = {};
    for (const step of first?.layerSteps ?? []) beforeCapacity[step.layerId] = step.before;
    for (const step of last?.layerSteps ?? []) afterCapacity[step.layerId] = step.after;

    eventResults.push({
      eventId,
      eventLabel: first?.eventLabel ?? eventId,
      contractId: eState.contractId,
      occurrenceDate: workbook.events.find((e) => e.id === eventId)?.occurrenceDate,
      sequences: eState.sequences,
      movementCount: eventEntries.length,
      lossCents: eState.lossCents,
      deductibleCents: eState.deductibleCents,
      unplacedCents: eState.unplacedCents,
      layerPaidGrossCents: eventLayerPaid,
      shortfallCents: eventShortfall,
      retentionCents: eState.deductibleCents + eState.unplacedCents + eventShortfall,
      beforeCapacity,
      afterCapacity,
      actualLayerGrossCents: eState.actualLayerGrossCents,
      shortfallLayerGrossCents: eState.shortfallLayerGrossCents,
    });
  }
  eventResults.sort((a, b) => Math.min(...a.sequences) - Math.min(...b.sequences));

  let reinstatementPremiumCents = 0;
  for (const r of restorationRecords) {
    if (r.status !== 'FAILED') {
      reinstatementPremiumCents += r.premiumCents;
      if (byLayer[r.layerId]) {
        byLayer[r.layerId].restorationPremiumCents += r.premiumCents;
        byLayer[r.layerId].restorationCount += 1;
      }
    } else if (byLayer[r.layerId]) {
      byLayer[r.layerId].failedCount += 1;
    }
  }

  const retentionCents = deductibleCents + unplacedCents + limitShortfallCents;
  const allocatedCents = retentionCents + layerPaidGrossCents;
  const run = {
    ok: true,
    runId: options.runId ?? `run-${options.version ?? 1}-${options.orderKey ?? 'stream'}`,
    version: options.version ?? 1,
    orderKey: options.orderKey ?? 'A',
    label: options.label ?? options.orderKey ?? '结算',
    createdAt: options.createdAt ?? new Date().toISOString(),
    workbookId: workbook.id ?? 'workbook',
    streamIds: [...streamIds],
    entries,
    events: eventResults,
    layers: Object.values(byLayer),
    restorations: restorationRecords,
    tailRecords,
    totals: {
      grossLossCents,
      retentionCents,
      deductibleCents,
      unplacedCents,
      limitShortfallCents,
      layerPaidGrossCents,
      allocatedCents,
      conservationDifferenceCents: allocatedCents - grossLossCents,
      balanced: allocatedCents === grossLossCents,
      reinstatementPremiumCents,
      netCedentRecoveryAfterPremiumCents: layerPaidGrossCents - reinstatementPremiumCents,
      cedentTotalCostBeforeOtherExpensesCents: retentionCents + reinstatementPremiumCents,
    },
    warnings: [],
  };
  if (!run.totals.balanced) throw new Error('总结算分摊与原损失不平');
  return run;
}

/** 比较两次重放；diff 方向为 B - A。 */
export function compareRuns(runA, runB, workbook = null) {
  const layerIds = new Set([...(runA.layers ?? []).map((l) => l.layerId), ...(runB.layers ?? []).map((l) => l.layerId)]);
  const layerRows = [...layerIds].map((layerId) => {
    const a = runA.layers.find((l) => l.layerId === layerId);
    const b = runB.layers.find((l) => l.layerId === layerId);
    return {
      layerId,
      layerName: b?.layerName ?? a?.layerName ?? layerId,
      contractId: b?.contractId ?? a?.contractId,
      paidA: a?.paidGrossCents ?? 0,
      paidB: b?.paidGrossCents ?? 0,
      paidDiff: (b?.paidGrossCents ?? 0) - (a?.paidGrossCents ?? 0),
      shortfallA: a?.shortfallCents ?? 0,
      shortfallB: b?.shortfallCents ?? 0,
      shortfallDiff: (b?.shortfallCents ?? 0) - (a?.shortfallCents ?? 0),
      premiumA: a?.restorationPremiumCents ?? 0,
      premiumB: b?.restorationPremiumCents ?? 0,
      premiumDiff: (b?.restorationPremiumCents ?? 0) - (a?.restorationPremiumCents ?? 0),
    };
  });

  const eventIds = new Set([...(runA.events ?? []).map((e) => e.eventId), ...(runB.events ?? []).map((e) => e.eventId)]);
  const eventRows = [...eventIds].map((eventId) => {
    const a = runA.events.find((e) => e.eventId === eventId);
    const b = runB.events.find((e) => e.eventId === eventId);
    return {
      eventId,
      eventLabel: b?.eventLabel ?? a?.eventLabel ?? eventId,
      lossCents: b?.lossCents ?? a?.lossCents ?? 0,
      retentionA: a?.retentionCents ?? 0,
      retentionB: b?.retentionCents ?? 0,
      retentionDiff: (b?.retentionCents ?? 0) - (a?.retentionCents ?? 0),
      layerPaidA: a?.layerPaidGrossCents ?? 0,
      layerPaidB: b?.layerPaidGrossCents ?? 0,
      layerPaidDiff: (b?.layerPaidGrossCents ?? 0) - (a?.layerPaidGrossCents ?? 0),
      byLayer: Object.fromEntries([...layerIds].map((id) => [id, {
        a: a?.actualLayerGrossCents?.[id] ?? 0,
        b: b?.actualLayerGrossCents?.[id] ?? 0,
        diff: (b?.actualLayerGrossCents?.[id] ?? 0) - (a?.actualLayerGrossCents?.[id] ?? 0),
      }])),
    };
  });

  return {
    layerRows,
    eventRows,
    totals: {
      grossLossA: runA.totals.grossLossCents,
      grossLossB: runB.totals.grossLossCents,
      retentionA: runA.totals.retentionCents,
      retentionB: runB.totals.retentionCents,
      retentionDiff: runB.totals.retentionCents - runA.totals.retentionCents,
      layerPaidA: runA.totals.layerPaidGrossCents,
      layerPaidB: runB.totals.layerPaidGrossCents,
      layerPaidDiff: runB.totals.layerPaidGrossCents - runA.totals.layerPaidGrossCents,
      premiumA: runA.totals.reinstatementPremiumCents,
      premiumB: runB.totals.reinstatementPremiumCents,
      premiumDiff: runB.totals.reinstatementPremiumCents - runA.totals.reinstatementPremiumCents,
      netRecoveryA: runA.totals.netCedentRecoveryAfterPremiumCents,
      netRecoveryB: runB.totals.netCedentRecoveryAfterPremiumCents,
      netRecoveryDiff: runB.totals.netCedentRecoveryAfterPremiumCents - runA.totals.netCedentRecoveryAfterPremiumCents,
    },
  };
}
