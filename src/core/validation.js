import { BPS_SCALE } from './money.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ValidationError extends Error {
  constructor(issues) {
    super(`工作簿校验失败：${issues.map((i) => i.message).join('；')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

function issue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value);
}

export function validateWorkbook(workbook, streamIds = null) {
  const issues = [];
  if (!workbook || typeof workbook !== 'object') {
    throw new ValidationError([{ code: 'ROOT', path: '$', message: '工作簿必须是对象' }]);
  }
  if (!Array.isArray(workbook.contracts) || workbook.contracts.length === 0) {
    issue(issues, 'CONTRACTS_REQUIRED', 'contracts', '至少需要一个合同年度');
  }
  if (!Array.isArray(workbook.events) || workbook.events.length === 0) {
    issue(issues, 'EVENTS_REQUIRED', 'events', '至少需要一个损失事件');
  }
  if (issues.length) throw new ValidationError(issues);

  const contractIds = new Set();
  const layerIds = new Set();
  for (const [ci, contract] of workbook.contracts.entries()) {
    const cpath = `contracts[${ci}]`;
    if (!contract.id) issue(issues, 'ID_REQUIRED', `${cpath}.id`, '合同缺少 id');
    if (contractIds.has(contract.id)) issue(issues, 'ID_DUPLICATE', `${cpath}.id`, `合同 id 重复：${contract.id}`);
    contractIds.add(contract.id);
    if (!ISO_DATE.test(contract.startDate ?? '')) issue(issues, 'DATE', `${cpath}.startDate`, '开始日期应为 YYYY-MM-DD');
    if (!ISO_DATE.test(contract.endDate ?? '')) issue(issues, 'DATE', `${cpath}.endDate`, '结束日期应为 YYYY-MM-DD');
    if (contract.startDate > contract.endDate) issue(issues, 'DATE_RANGE', cpath, '合同开始日期不能晚于结束日期');
    if (!isNonNegInt(contract.occurrenceDeductibleCents)) {
      issue(issues, 'MONEY', `${cpath}.occurrenceDeductibleCents`, '每次事故免赔必须是非负整数分');
    }
    if (!Array.isArray(contract.layers)) {
      issue(issues, 'LAYERS_REQUIRED', `${cpath}.layers`, '合同必须包含 layers 数组');
      continue;
    }
    for (const [li, layer] of contract.layers.entries()) {
      const lpath = `${cpath}.layers[${li}]`;
      if (!layer.id) issue(issues, 'ID_REQUIRED', `${lpath}.id`, '层缺少 id');
      if (layerIds.has(layer.id)) issue(issues, 'ID_DUPLICATE', `${lpath}.id`, `层 id 全局重复：${layer.id}`);
      layerIds.add(layer.id);
      if (layer.order !== undefined && (!Number.isInteger(layer.order) || layer.order < 1)) {
        issue(issues, 'ORDER', `${lpath}.order`, '层条款顺序必须是正整数');
      }
      if (!isNonNegInt(layer.attachmentCents)) issue(issues, 'MONEY', `${lpath}.attachmentCents`, '起赔点必须是非负整数分');
      if (!isNonNegInt(layer.occurrenceLimitCents) || layer.occurrenceLimitCents === 0) {
        issue(issues, 'LIMIT', `${lpath}.occurrenceLimitCents`, '单次限额必须是正整数分');
      }
      if (!isNonNegInt(layer.annualLimitCents) || layer.annualLimitCents === 0) {
        issue(issues, 'LIMIT', `${lpath}.annualLimitCents`, '年度限额必须是正整数分');
      }
      if (layer.shareBps !== undefined && (!Number.isInteger(layer.shareBps) || layer.shareBps < 0 || layer.shareBps > BPS_SCALE)) {
        issue(issues, 'BPS', `${lpath}.shareBps`, '层份额 bps 必须在 0..10000');
      }
      if (layer.participants) {
        const sum = layer.participants.reduce((s, p) => s + (p.bps ?? 0), 0);
        if (sum !== BPS_SCALE) issue(issues, 'BPS_SUM', `${lpath}.participants`, `共保份额之和必须为 10000bps，当前 ${sum}`);
      }
      const r = layer.reinstatement;
      if (r) {
        if (!Number.isInteger(r.maxCount) || r.maxCount < 0) issue(issues, 'REINSTATE', `${lpath}.reinstatement.maxCount`, '恢复次数必须是非负整数');
        if (r.amountCents !== undefined && !isNonNegInt(r.amountCents)) issue(issues, 'MONEY', `${lpath}.reinstatement.amountCents`, '恢复额度必须是非负整数分');
        if (r.premiumRateBps !== undefined && (!Number.isInteger(r.premiumRateBps) || r.premiumRateBps < 0 || r.premiumRateBps > BPS_SCALE)) {
          issue(issues, 'BPS', `${lpath}.reinstatement.premiumRateBps`, '恢复费用率必须在 0..10000bps');
        }
        if (r.waitEntries !== undefined && (!Number.isInteger(r.waitEntries) || r.waitEntries < 0)) {
          issue(issues, 'WAIT', `${lpath}.reinstatement.waitEntries`, '生效等待笔数必须是非负整数');
        }
      }
    }
  }

  const eventIds = new Set();
  const movementIds = new Set();
  for (const [ei, event] of workbook.events.entries()) {
    const epath = `events[${ei}]`;
    if (!event.id) issue(issues, 'ID_REQUIRED', `${epath}.id`, '事件缺少 id');
    if (eventIds.has(event.id)) issue(issues, 'ID_DUPLICATE', `${epath}.id`, `事件 id 重复：${event.id}`);
    eventIds.add(event.id);
    if (!ISO_DATE.test(event.occurrenceDate ?? '')) issue(issues, 'DATE', `${epath}.occurrenceDate`, '事件发生日期应为 YYYY-MM-DD');
    if (event.contractId && !contractIds.has(event.contractId)) {
      issue(issues, 'CONTRACT_REF', `${epath}.contractId`, `事件引用了不存在的合同：${event.contractId}`);
    }
    if (!Array.isArray(event.movements) || event.movements.length === 0) {
      issue(issues, 'MOVEMENTS_REQUIRED', `${epath}.movements`, '事件至少需要一笔 initial 损失');
      continue;
    }
    let hasInitial = false;
    for (const [mi, m] of event.movements.entries()) {
      const mpath = `${epath}.movements[${mi}]`;
      if (!m.id) issue(issues, 'ID_REQUIRED', `${mpath}.id`, '流水缺少 id');
      if (movementIds.has(m.id)) issue(issues, 'ID_DUPLICATE', `${mpath}.id`, `流水 id 重复：${m.id}`);
      movementIds.add(m.id);
      if (!['initial', 'supplement', 'revision'].includes(m.type)) {
        issue(issues, 'TYPE', `${mpath}.type`, '流水类型必须是 initial/supplement/revision');
      }
      if (m.type === 'initial') hasInitial = true;
      if (!isNonNegInt(m.amountCents) || m.amountCents === 0) {
        issue(issues, 'MONEY', `${mpath}.amountCents`, '流水金额必须是正整数分；冲回方向由 type=revision 表示');
      }
      if (m.date && !ISO_DATE.test(m.date)) issue(issues, 'DATE', `${mpath}.date`, '流水日期应为 YYYY-MM-DD');
    }
    if (!hasInitial) issue(issues, 'INITIAL_REQUIRED', epath, '事件必须有 initial 首笔损失');
  }

  if (streamIds) {
    if (!Array.isArray(streamIds) || streamIds.length === 0) {
      issue(issues, 'STREAM_REQUIRED', 'stream', '结算顺序必须是非空流水 id 数组');
    } else {
      const seen = new Set();
      for (const id of streamIds) {
        if (!movementIds.has(id)) issue(issues, 'STREAM_REF', 'stream', `结算顺序引用了不存在的流水：${id}`);
        if (seen.has(id)) issue(issues, 'STREAM_DUPLICATE', 'stream', `同一流水不能重复 replay：${id}`);
        seen.add(id);
      }
      if (seen.size !== movementIds.size) {
        issue(issues, 'STREAM_INCOMPLETE', 'stream', `仍有 ${movementIds.size - seen.size} 笔流水未放入结算顺序`);
      }
    }
  }

  if (issues.length) throw new ValidationError(issues);
  return true;
}
