import { Y } from './money.js';

/**
 * 全部为虚构数据，单位为人民币元展示、内部按整数分结算。
 * 每个 workbook 都带 orderA / orderB 两笔流水顺序，便于直接重放比较。
 */

const orderEffect = {
  id: 'order-effect',
  name: '顺序改变分摊：大额触发恢复，中额是否接上',
  description:
    '同样两笔全年损失 ¥740。第一层年度额度仅 ¥160，用完后可恢复一次 ¥160，费用 5%，恢复额度自下一笔同合同流水起可用、不追溯触发笔。顺序不同，中额案能否使用恢复额度也不同。',
  contracts: [
    {
      id: 'C-ORD-2025',
      name: '2025 示范财产超赔合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('40'),
      layers: [
        {
          id: 'L1',
          name: '第一层：160 xs 40',
          order: 1,
          attachmentCents: Y('40'),
          occurrenceLimitCents: Y('160'),
          annualLimitCents: Y('160'),
          shareBps: 10000,
          reinstatement: {
            maxCount: 1,
            amountCents: Y('160'),
            premiumRateBps: 500,
            waitEntries: 0,
            note: '一次恢复，费用为恢复额度的 5%；等待 0 笔表示下一笔流水可用。',
          },
        },
        {
          id: 'L2',
          name: '第二层：300 xs 200',
          order: 2,
          attachmentCents: Y('200'),
          occurrenceLimitCents: Y('300'),
          annualLimitCents: Y('600'),
          shareBps: 10000,
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
      ],
    },
  ],
  events: [
    {
      id: 'E-BIG',
      label: '甲厂区巨灾（虚构）',
      occurrenceDate: '2025-06-18',
      contractId: 'C-ORD-2025',
      movements: [
        { id: 'M-BIG', date: '2025-06-20', type: 'initial', amountCents: Y('600'), memo: '首次估损' },
      ],
    },
    {
      id: 'E-MID',
      label: '乙仓库水损（虚构）',
      occurrenceDate: '2025-07-09',
      contractId: 'C-ORD-2025',
      movements: [
        { id: 'M-MID', date: '2025-07-11', type: 'initial', amountCents: Y('140'), memo: '首次估损' },
      ],
    },
  ],
  orderA: ['M-BIG', 'M-MID'],
  orderB: ['M-MID', 'M-BIG'],
  orderAName: '顺序 A：大额先结算',
  orderBName: '顺序 B：中额先结算',
};

const development = {
  id: 'development',
  name: '补损与冲回回到原事件：免赔只用一次',
  description:
    '同一事件首次估损 ¥250，之后迟到补损 ¥120，再冲回 ¥70，最终累计损失 ¥300。可核对免赔 ¥100 不重复；顺序 B 把补损与冲回互换，展示中间流水不同但最终累计相同。',
  contracts: [
    {
      id: 'C-DEV-2025',
      name: '2025 工程险示范超赔合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('100'),
      layers: [
        {
          id: 'D-L1',
          name: '第一层：200 xs 100',
          order: 1,
          attachmentCents: Y('100'),
          occurrenceLimitCents: Y('200'),
          annualLimitCents: Y('500'),
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
        {
          id: 'D-L2',
          name: '第二层：300 xs 300',
          order: 2,
          attachmentCents: Y('300'),
          occurrenceLimitCents: Y('300'),
          annualLimitCents: Y('300'),
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
      ],
    },
  ],
  events: [
    {
      id: 'E-DEV',
      label: '丙工程估损调整案（虚构）',
      occurrenceDate: '2025-03-04',
      contractId: 'C-DEV-2025',
      movements: [
        { id: 'M-DEV-1', date: '2025-03-10', type: 'initial', amountCents: Y('250'), memo: '首次估损' },
        { id: 'M-DEV-2', date: '2025-09-15', type: 'supplement', amountCents: Y('120'), memo: '迟到补损' },
        { id: 'M-DEV-3', date: '2025-11-20', type: 'revision', amountCents: Y('70'), memo: '专家复估后冲回' },
      ],
    },
  ],
  orderA: ['M-DEV-1', 'M-DEV-2', 'M-DEV-3'],
  orderB: ['M-DEV-1', 'M-DEV-3', 'M-DEV-2'],
  orderAName: '顺序 A：补损后冲回（时间顺序）',
  orderBName: '顺序 B：先冲回后补损（What-if）',
};

const crossYear = {
  id: 'cross-year',
  name: '跨年度：2025 事件在 2026 年补损，年度额度隔离',
  description:
    '2025-12-20 事件适用 2025 合约；2026-01-08 的迟到补损虽跨入 2026 日历年，仍回到 2025 事故年度合约。2026-01-05 新事件使用 2026 全新年度限额。',
  contracts: [
    {
      id: 'C-2025',
      name: '2025 事故年度合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('100'),
      layers: [
        {
          id: 'CY-L1-25',
          name: '2025 第一层：300 xs 100',
          order: 1,
          attachmentCents: Y('100'),
          occurrenceLimitCents: Y('300'),
          annualLimitCents: Y('300'),
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
      ],
    },
    {
      id: 'C-2026',
      name: '2026 事故年度合约',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      occurrenceDeductibleCents: Y('100'),
      layers: [
        {
          id: 'CY-L1-26',
          name: '2026 第一层：300 xs 100',
          order: 1,
          attachmentCents: Y('100'),
          occurrenceLimitCents: Y('300'),
          annualLimitCents: Y('300'),
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
      ],
    },
  ],
  events: [
    {
      id: 'E-25',
      label: '跨年冬暴风（2025 事件）',
      occurrenceDate: '2025-12-20',
      contractId: 'C-2025',
      movements: [
        { id: 'M-25-1', date: '2025-12-22', type: 'initial', amountCents: Y('180'), memo: '年内首次估损' },
        { id: 'M-25-2', date: '2026-01-08', type: 'supplement', amountCents: Y('260'), memo: '2026 年迟到补损，仍归 2025 合约' },
      ],
    },
    {
      id: 'E-26',
      label: '新年火灾（2026 新事件）',
      occurrenceDate: '2026-01-05',
      contractId: 'C-2026',
      movements: [
        { id: 'M-26-1', date: '2026-01-06', type: 'initial', amountCents: Y('180'), memo: '2026 新事故' },
      ],
    },
  ],
  orderA: ['M-25-1', 'M-26-1', 'M-25-2'],
  orderB: ['M-25-1', 'M-25-2', 'M-26-1'],
  orderAName: '顺序 A：按入账日期交错',
  orderBName: '顺序 B：先结清 2025 事件开发',
};

function failureEvent(id, label, movementId) {
  return {
    id,
    label,
    occurrenceDate: '2025-05-10',
    contractId: 'C-EXH',
    movements: [
      { id: movementId, date: '2025-05-12', type: 'initial', amountCents: Y('300'), memo: '全额足够打满第一层' },
    ],
  };
}

const exhaustionFailure = {
  id: 'exhaustion-failure',
  name: '限额耗尽与恢复次数失败',
  description:
    '四笔相同损失，每笔第一层条款责任均为 ¥200；年度额度 ¥200，最多恢复两次，每次 ¥200、费用 5%。前三笔依次用满初始和两次恢复，第四笔再次申请恢复时因超过有限次数而失败，¥200 留为自留缺口。',
  contracts: [
    {
      id: 'C-EXH',
      name: '2025 限额耗尽示范合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('100'),
      layers: [
        {
          id: 'X-L1',
          name: '耗尽层：200 xs 100，年度 200',
          order: 1,
          attachmentCents: Y('100'),
          occurrenceLimitCents: Y('200'),
          annualLimitCents: Y('200'),
          reinstatement: {
            maxCount: 2,
            amountCents: Y('200'),
            premiumRateBps: 500,
            waitEntries: 0,
            note: '最多两次恢复；下一笔可用。',
          },
        },
      ],
    },
  ],
  events: [
    failureEvent('E-X1', '耗尽事件 X1', 'M-X1'),
    failureEvent('E-X2', '耗尽事件 X2', 'M-X2'),
    failureEvent('E-X3', '耗尽事件 X3', 'M-X3'),
    failureEvent('E-X4', '耗尽事件 X4（恢复失败）', 'M-X4'),
  ],
  orderA: ['M-X1', 'M-X2', 'M-X3', 'M-X4'],
  orderB: ['M-X4', 'M-X3', 'M-X2', 'M-X1'],
  orderAName: '顺序 A：X1→X4',
  orderBName: '顺序 B：X4→X1',
};

function waitEvent(id, label, movementId) {
  return {
    id,
    label,
    occurrenceDate: '2025-09-01',
    contractId: 'C-WAIT',
    movements: [
      { id: movementId, date: '2025-09-03', type: 'initial', amountCents: Y('300'), memo: '第一层责任 ¥200' },
    ],
  };
}

const reinstatementWait = {
  id: 'reinstatement-wait',
  name: '恢复生效限制：等待一笔流水，中间事件无法使用',
  description:
    '年度额度 ¥200，可恢复一次 ¥200，但需经过 1 笔同合同后续流水后才生效。首笔用尽后，紧邻的第二笔仍不能使用；第三笔才能使用。交换第二、三笔顺序会改变具体事件的自留与摊回。',
  contracts: [
    {
      id: 'C-WAIT',
      name: '2025 恢复生效限制示范合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('100'),
      layers: [
        {
          id: 'W-L1',
          name: '等待生效层：200 xs 100',
          order: 1,
          attachmentCents: Y('100'),
          occurrenceLimitCents: Y('200'),
          annualLimitCents: Y('200'),
          reinstatement: {
            maxCount: 1,
            amountCents: Y('200'),
            premiumRateBps: 500,
            waitEntries: 1,
            note: '需经过 1 笔同合同后续流水，再下一笔开始前生效。',
          },
        },
      ],
    },
  ],
  events: [
    waitEvent('E-W1', '等待事件 W1', 'M-W1'),
    waitEvent('E-W2', '等待事件 W2（顺序 A 中落空）', 'M-W2'),
    waitEvent('E-W3', '等待事件 W3（顺序 A 中接上）', 'M-W3'),
  ],
  orderA: ['M-W1', 'M-W2', 'M-W3'],
  orderB: ['M-W1', 'M-W3', 'M-W2'],
  orderAName: '顺序 A：W1→W2→W3',
  orderBName: '顺序 B：W1→W3→W2',
};

const roundingTail = {
  id: 'rounding-tail',
  name: '定点数与尾差：最大余数法',
  description:
    '第一层赔款总额 ¥100.01，由三个虚构共保人按 33.33%、33.33%、33.34% 分担。先取整到分后余 1 分，按最大余数法分给余数最大的 33.34% 份额，全程记录尾差。',
  contracts: [
    {
      id: 'C-TAIL',
      name: '2025 尾差核对合约',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      occurrenceDeductibleCents: Y('1000'),
      layers: [
        {
          id: 'T-L1',
          name: '尾差共保层：10,000 xs 1,000',
          order: 1,
          attachmentCents: Y('1000'),
          occurrenceLimitCents: Y('50000'),
          annualLimitCents: Y('50000'),
          participants: [
            { id: 'P1', name: '虚构共保人 P1', bps: 3333, tailPriority: 1 },
            { id: 'P2', name: '虚构共保人 P2', bps: 3333, tailPriority: 2 },
            { id: 'P3', name: '虚构共保人 P3', bps: 3334, tailPriority: 3 },
          ],
          reinstatement: { maxCount: 0, amountCents: 0, premiumRateBps: 0, waitEntries: 0 },
        },
      ],
    },
  ],
  events: [
    {
      id: 'E-TAIL',
      label: '小额尾差案（虚构）',
      occurrenceDate: '2025-11-11',
      contractId: 'C-TAIL',
      movements: [
        { id: 'M-TAIL', date: '2025-11-12', type: 'initial', amountCents: Y('1100.01'), memo: '免赔 ¥1,000.00，层赔款 ¥100.01' },
      ],
    },
  ],
  orderA: ['M-TAIL'],
  orderB: ['M-TAIL'],
  orderAName: '唯一顺序',
  orderBName: '同一顺序',
};

export const SAMPLE_WORKBOOKS = [
  orderEffect,
  development,
  crossYear,
  exhaustionFailure,
  reinstatementWait,
  roundingTail,
];

export const SAMPLE_MAP = Object.fromEntries(SAMPLE_WORKBOOKS.map((w) => [w.id, w]));

export function cloneWorkbook(workbook) {
  return structuredClone(workbook);
}
