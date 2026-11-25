/**
 * 定点金额工具。
 *
 * 全引擎不使用 JavaScript number 表示“元”等浮点金额，也不做 0.1 + 0.2。
 * 内部一律使用整数“分”（1 元 = 100 分）；比例使用整数 bps（1bps = 1/10000）。
 * 乘法中间值用 BigInt，避免样本较大时精度丢失。
 */

export const MONEY_SCALE = 100;
export const BPS_SCALE = 10000;

export class MoneyError extends Error {}

function assertSafeCents(value) {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`金额必须是整数分，收到：${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`金额超出安全整数范围：${String(value)}`);
  }
}

/** 把页面/JSON 中的元字符串转成整数分。最多接受两位小数。 */
export function yuanToCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`非法金额：${input}`);
    if (Number.isInteger(input)) return input * MONEY_SCALE;
    input = String(input);
  }
  if (typeof input !== 'string') {
    throw new MoneyError(`金额必须是字符串或整数，收到：${typeof input}`);
  }
  const text = input.trim().replace(/[,，\s¥￥]/g, '');
  const match = /^([+-])?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MoneyError(`无法解析为两位小数定点金额：${input}`);
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number.parseInt(match[2], 10);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = sign * (whole * 100 + Number.parseInt(fraction || '00', 10));
  assertSafeCents(cents);
  return cents;
}

/** 兼容样例中直接写整数分；若看起来像字符串则按元解析。 */
export function Y(value) {
  return typeof value === 'string' ? yuanToCents(value) : value;
}

export function centsToYuanParts(cents) {
  assertSafeCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / MONEY_SCALE);
  const fraction = String(abs % MONEY_SCALE).padStart(2, '0');
  return { negative, whole: String(whole), fraction };
}

export function formatMoney(cents, options = {}) {
  if (cents === null || cents === undefined) return '—';
  const { negative, whole, fraction } = centsToYuanParts(cents);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : '';
  const body = options.decimals === 0 ? `${grouped}` : `${grouped}.${fraction}`;
  return `${options.symbol === false ? '' : '¥'}${sign}${body}`;
}

export function formatSignedMoney(cents) {
  if (cents > 0) return `+${formatMoney(cents)}`;
  return formatMoney(cents);
}

export function formatBps(bps) {
  if (!Number.isInteger(bps)) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * 整数分 × bps，按四舍五入到整分；0.5 分向上（远离零方向）。
 * 返回 { value, remainderBpsNumerator }，便于追踪取整。
 */
export function applyBpsDetailed(amountCents, bps) {
  assertSafeCents(amountCents);
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_SCALE) {
    throw new MoneyError(`bps 必须是 0..10000 的整数：${bps}`);
  }
  const signed = BigInt(amountCents) * BigInt(bps);
  const positive = signed < 0n ? -signed : signed;
  let q = positive / BigInt(BPS_SCALE);
  const r = positive % BigInt(BPS_SCALE);
  // HALF_UP：2r >= scale 时进 1。
  if (r * 2n >= BigInt(BPS_SCALE)) q += 1n;
  const value = Number(signed < 0n ? -q : q);
  assertSafeCents(value);
  return {
    valueCents: value,
    exactNumerator: signed.toString(),
    divisor: BPS_SCALE,
    remainderNumerator: r.toString(),
    roundedUp: r * 2n >= BigInt(BPS_SCALE),
  };
}

export function applyBps(amountCents, bps) {
  return applyBpsDetailed(amountCents, bps).valueCents;
}

/**
 * 最大余数法把 totalCents 完整分到若干权重行。
 * 权重之和必须为 10000bps。先 floor，剩余的每一分按小数余数从大到小分配；
 * 余数相同则按 tiePriority（小者优先），再按数组顺序。
 *
 * 返回 amounts（key -> cents）与 tailAdjustments（实际比 floor 多拿的 1 分记录）。
 */
export function splitWeighted(totalCents, weights, options = {}) {
  assertSafeCents(totalCents);
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new MoneyError('splitWeighted 需要至少一个权重行');
  }
  const weightSum = weights.reduce((sum, row) => sum + row.bps, 0);
  if (weightSum !== BPS_SCALE) {
    throw new MoneyError(`权重之和必须为 ${BPS_SCALE}bps，当前为 ${weightSum}`);
  }

  const sign = totalCents < 0 ? -1 : 1;
  const absTotal = Math.abs(totalCents);
  const rows = weights.map((row, index) => {
    const product = BigInt(absTotal) * BigInt(row.bps);
    const floor = Number(product / BigInt(BPS_SCALE));
    const remainder = product % BigInt(BPS_SCALE);
    return {
      key: row.key,
      floor,
      remainder,
      tiePriority: Number.isInteger(row.tiePriority) ? row.tiePriority : 1000 + index,
      index,
    };
  });

  let remaining = absTotal - rows.reduce((sum, row) => sum + row.floor, 0);
  const sorted = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.tiePriority !== b.tiePriority) return a.tiePriority - b.tiePriority;
    return a.index - b.index;
  });

  const tailAdjustments = [];
  for (const row of sorted) {
    if (remaining <= 0) break;
    row.floor += 1;
    remaining -= 1;
    tailAdjustments.push({
      key: row.key,
      amountCents: sign,
      rule: options.rule ?? 'LARGEST_REMAINDER__TIE_CLAUSE_ORDER',
      reason: 'ROUNDING_TAIL_ONE_CENT',
    });
  }
  if (remaining !== 0) throw new MoneyError('尾差分配失败：仍有未分配余额');

  const amounts = {};
  for (const row of rows) amounts[row.key] = sign * row.floor;
  return { amounts, tailAdjustments };
}

export function sumMoney(values) {
  return values.reduce((sum, value) => {
    assertSafeCents(sum);
    assertSafeCents(value);
    return sum + value;
  }, 0);
}
