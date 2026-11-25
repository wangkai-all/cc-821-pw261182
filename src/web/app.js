import { SAMPLE_WORKBOOKS, SAMPLE_MAP, cloneWorkbook } from '../core/scenarios.js';
import { settleStream, compareRuns } from '../core/engine.js';
import { formatMoney, formatBps, yuanToCents } from '../core/money.js';

const app = document.querySelector('#app');
const sampleSelect = document.querySelector('#sample-select');
const globalNotice = document.querySelector('#global-notice');

const REASON_LABELS = {
  OCCURRENCE_DEDUCTIBLE: '事故免赔/自留（同一事件只吸收一次）',
  UNPLACED_EXCESS: '未分配或超高层损失（自留）',
  LAYER_INDEMNITY: '本层摊回',
  ANNUAL_LIMIT_OR_REINSTATEMENT_UNAVAILABLE: '年度有效额度不足，形成自留缺口',
  REINSTATEMENT_PENDING_NOT_EFFECTIVE: '恢复额度尚未到生效序号，本笔不可用',
  LAYER_LIMIT_SHORTFALL_REVERSAL: '以前年度限额缺口随冲回转回',
};
const TYPE_LABELS = {
  initial: '首次估损',
  supplement: '迟到补损',
  revision: '估损冲回',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function money(cents) {
  return formatMoney(cents ?? 0);
}
function moneyInput(cents) {
  return formatMoney(cents ?? 0, { symbol: false });
}
function signedMoney(cents) {
  const value = cents ?? 0;
  return value > 0 ? `+${money(value)}` : money(value);
}
function diff(cents) {
  const value = cents ?? 0;
  if (value === 0) return '<span class="muted num">0.00</span>';
  const cls = value > 0 ? 'positive' : 'negative';
  const sign = value > 0 ? '+' : '';
  return `<span class="${cls} num diff">${sign}${money(value)}</span>`;
}
function typePill(type) {
  const cls = type === 'revision' ? 'red' : type === 'supplement' ? 'green' : 'blue';
  return `<span class="pill ${cls}">${esc(TYPE_LABELS[type] ?? type)}</span>`;
}
function reasonLabel(reason) {
  return REASON_LABELS[reason] ?? reason;
}
function pct(part, whole) {
  if (!whole) return '0.00%';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

function createVersion(workbook, number, note) {
  const snapshot = cloneWorkbook(workbook);
  const runA = settleStream(snapshot, snapshot.orderA, {
    version: number,
    orderKey: 'A',
    label: snapshot.orderAName ?? '顺序 A',
    runId: `v${number}-A`,
  });
  const runB = settleStream(snapshot, snapshot.orderB, {
    version: number,
    orderKey: 'B',
    label: snapshot.orderBName ?? '顺序 B',
    runId: `v${number}-B`,
  });
  return {
    id: `v${number}`,
    number,
    createdAt: new Date().toISOString(),
    note,
    workbook: snapshot,
    runA,
    runB,
    comparison: compareRuns(runA, runB, snapshot),
  };
}

function createState(sampleId) {
  const workbook = cloneWorkbook(SAMPLE_MAP[sampleId]);
  const state = {
    sampleId,
    workbook,
    tab: 'compare',
    versions: [],
    selectedVersionId: null,
    inspectSide: 'A',
    ledgerSide: 'A',
    ledgerEventFilter: 'ALL',
    selectedEventId: workbook.events[0]?.id ?? null,
    selectedContractId: workbook.contracts[0]?.id ?? null,
    selectedLayerId: workbook.contracts[0]?.layers[0]?.id ?? null,
    notice: null,
    error: null,
    userSeq: 0,
  };
  const first = createVersion(workbook, 1, '载入样例后的不可变原始结算');
  state.versions.push(first);
  state.selectedVersionId = first.id;
  return state;
}

let state = createState('order-effect');

function selectedVersion() {
  return state.versions.find((v) => v.id === state.selectedVersionId) ?? state.versions[state.versions.length - 1];
}
function selectedContract() {
  return state.workbook.contracts.find((c) => c.id === state.selectedContractId) ?? state.workbook.contracts[0];
}
function selectedLayer(contract = selectedContract()) {
  return contract?.layers.find((l) => l.id === state.selectedLayerId) ?? contract?.layers[0];
}
function movementMap(workbook) {
  const map = new Map();
  for (const event of workbook.events) {
    for (const movement of event.movements) map.set(movement.id, { event, movement });
  }
  return map;
}
function layerColorIndex(workbook, layerId) {
  let index = 0;
  for (const contract of workbook.contracts) {
    const layers = [...contract.layers].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    for (const layer of layers) {
      index += 1;
      if (layer.id === layerId) return ((index - 1) % 4) + 1;
    }
  }
  return 1;
}

function commitVersion(note) {
  try {
    const nextNumber = Math.max(0, ...state.versions.map((v) => v.number)) + 1;
    const version = createVersion(state.workbook, nextNumber, note);
    state.versions.push(version);
    state.selectedVersionId = version.id;
    state.notice = { type: 'success', text: `已保留 ${version.id}：${note}。旧版本未被覆盖。` };
    state.error = null;
    render();
    return true;
  } catch (error) {
    state.error = error?.issues ? `${error.message}（${error.issues[0]?.path ?? ''}）` : error.message;
    state.notice = null;
    render();
    return false;
  }
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderHeaderSelect() {
  sampleSelect.innerHTML = SAMPLE_WORKBOOKS.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
  sampleSelect.value = state.sampleId;
}

function renderNotice() {
  if (state.error) {
    globalNotice.innerHTML = `<div class="notice error">结算/输入未通过校验：${esc(state.error)}</div>`;
  } else if (state.notice) {
    globalNotice.innerHTML = `<div class="notice ${state.notice.type === 'success' ? 'success' : ''}">${esc(state.notice.text)}</div>`;
  } else {
    globalNotice.innerHTML = '';
  }
}

function kpiCard(label, a, b, diffValue, hint = '') {
  return `
    <section class="kpi">
      <div class="label">${esc(label)}</div>
      <div class="value num">${money(a)}</div>
      <div class="sub">
        <span>A：<b class="num">${money(a)}</b></span>
        <span>B：<b class="num">${money(b)}</b></span>
        <span>B−A：${diff(diffValue)}</span>
        ${hint ? `<span class="muted">${esc(hint)}</span>` : ''}
      </div>
    </section>`;
}

function orderCard(workbook, side) {
  const ids = side === 'A' ? workbook.orderA : workbook.orderB;
  const name = side === 'A' ? workbook.orderAName : workbook.orderBName;
  const map = movementMap(workbook);
  return `
    <div class="card">
      <div class="card-header">
        <div><h2>${esc(name ?? `顺序 ${side}`)}</h2><p class="hint">按下列流水序号重放；额度恢复的生效等待按同一合同的流水笔数计算。</p></div>
        <span class="pill blue">${ids.length} 笔</span>
      </div>
      <ol class="order-list">
        ${ids.map((id) => {
          const located = map.get(id);
          if (!located) return `<li class="negative">缺失流水 ${esc(id)}</li>`;
          const { event, movement } = located;
          const delta = movement.type === 'revision' ? -movement.amountCents : movement.amountCents;
          return `<li title="${esc(movement.memo ?? '')}">
            <span>${esc(event.label)}</span>
            ${typePill(movement.type)}
            <b class="num ${delta < 0 ? 'negative' : ''}">${signedMoney(delta)}</b>
          </li>`;
        }).join('')}
      </ol>
    </div>`;
}

function allocationBar(version, side) {
  const run = version[`run${side}`];
  const wb = version.workbook;
  const gross = run.totals.grossLossCents || 1;
  const segments = [
    { label: '免赔', value: run.totals.deductibleCents, cls: 'deductible' },
    { label: '未分配/超层自留', value: run.totals.unplacedCents, cls: 'retention' },
    { label: '限额缺口自留', value: run.totals.limitShortfallCents, cls: 'shortfall' },
    ...run.layers.filter((l) => l.paidGrossCents !== 0).map((l) => ({
      label: l.layerName,
      value: l.paidGrossCents,
      cls: `layer-${layerColorIndex(wb, l.layerId)}`,
    })),
  ].filter((s) => s.value !== 0);
  return `
    <div class="bar-row">
      <div class="tag">${side}</div>
      <div class="allocation-bar" role="img" aria-label="顺序 ${side} 的损失分摊堆叠条">
        ${segments.map((s) => {
          const width = (Math.abs(s.value) / gross) * 100;
          return `<span class="segment ${s.cls}" style="width:${width}%" title="${esc(s.label)}：${money(s.value)}（${pct(Math.abs(s.value), gross)}）"></span>`;
        }).join('')}
      </div>
      <div class="bar-value">${money(run.totals.grossLossCents)}</div>
    </div>`;
}

function renderCompareTab() {
  const version = selectedVersion();
  const cmp = version.comparison;
  const wb = version.workbook;
  return `
    <section class="card" style="margin-bottom:16px">
      <div class="card-header">
        <div>
          <h2>${esc(wb.name)}</h2>
          <p class="hint" style="font-size:14px;max-width:1100px">${esc(wb.description)}</p>
        </div>
        <span class="pill gray">${esc(wb.id)} · ${version.id}</span>
      </div>
    </section>

    <div class="grid two" style="margin-bottom:16px">
      ${orderCard(wb, 'A')}
      ${orderCard(wb, 'B')}
    </div>
    <div class="form-actions" style="margin:-4px 0 16px">
      <button class="btn" data-action="swap-orders" type="button">交换 A/B 两套事件顺序并重算新版本</button>
      <span class="notice" style="margin:0">当前查看 <b>${version.id}</b>；交换只影响后续新版本，${version.id} 已冻结。</span>
    </div>

    <div class="kpi-grid">
      ${kpiCard('全年损失合计（必须相同）', cmp.totals.grossLossA, cmp.totals.grossLossB, cmp.totals.grossLossB - cmp.totals.grossLossA, '两个顺序的原始损失总额')}
      ${kpiCard('自留合计', cmp.totals.retentionA, cmp.totals.retentionB, cmp.totals.retentionDiff, '免赔 + 未分配 + 限额缺口')}
      ${kpiCard('各层摊回合计', cmp.totals.layerPaidA, cmp.totals.layerPaidB, cmp.totals.layerPaidDiff, '年度额度内的层赔款')}
      ${kpiCard('扣恢复费用后净摊回', cmp.totals.netRecoveryA, cmp.totals.netRecoveryB, cmp.totals.netRecoveryDiff, `恢复费用 A ${money(cmp.totals.premiumA)} / B ${money(cmp.totals.premiumB)}`)}
    </div>

    <div class="grid two">
      <section class="card">
        <div class="card-header"><div><h2>分摊结构</h2><p class="hint">堆叠条总和等于原损失；斜纹红为限额/恢复失败后落回自留的缺口。</p></div></div>
        ${allocationBar(version, 'A')}
        ${allocationBar(version, 'B')}
        <div class="legend">
          <span><i class="swatch" style="background:#9b9a92"></i>免赔</span>
          <span><i class="swatch" style="background:var(--muted)"></i>未分配/超层</span>
          <span><i class="swatch" style="background:repeating-linear-gradient(45deg,var(--critical),var(--critical) 3px,#8f2424 3px,#8f2424 6px)"></i>限额缺口</span>
          <span><i class="swatch" style="background:var(--blue)"></i>先序层</span>
          <span><i class="swatch" style="background:var(--aqua)"></i>后续层</span>
        </div>
      </section>

      <section class="card">
        <h2>总量差异（B − A）</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>项目</th><th class="num">顺序 A</th><th class="num">顺序 B</th><th class="num">差异</th></tr></thead>
            <tbody>
              <tr><td>原始损失</td><td class="num">${money(cmp.totals.grossLossA)}</td><td class="num">${money(cmp.totals.grossLossB)}</td><td class="num">${diff(cmp.totals.grossLossB - cmp.totals.grossLossA)}</td></tr>
              <tr><td>自留</td><td class="num">${money(cmp.totals.retentionA)}</td><td class="num">${money(cmp.totals.retentionB)}</td><td class="num">${diff(cmp.totals.retentionDiff)}</td></tr>
              <tr><td>层摊回</td><td class="num">${money(cmp.totals.layerPaidA)}</td><td class="num">${money(cmp.totals.layerPaidB)}</td><td class="num">${diff(cmp.totals.layerPaidDiff)}</td></tr>
              <tr><td>恢复费用</td><td class="num">${money(cmp.totals.premiumA)}</td><td class="num">${money(cmp.totals.premiumB)}</td><td class="num">${diff(cmp.totals.premiumDiff)}</td></tr>
              <tr><td>净摊回</td><td class="num">${money(cmp.totals.netRecoveryA)}</td><td class="num">${money(cmp.totals.netRecoveryB)}</td><td class="num">${diff(cmp.totals.netRecoveryDiff)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <h2>按层比较</h2>
      <p class="hint">同一总损失下，年度限额和恢复生效顺序会改变各层赔款、缺口与费用。</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>合同</th><th>层</th><th class="num">A 摊回</th><th class="num">B 摊回</th><th class="num">摊回差异</th><th class="num">A 缺口</th><th class="num">B 缺口</th><th class="num">缺口差异</th><th class="num">A/B 恢复费</th></tr></thead>
          <tbody>
            ${cmp.layerRows.map((r) => `
              <tr>
                <td class="secondary">${esc(r.contractId)}</td>
                <td><b>${esc(r.layerName)}</b></td>
                <td class="num">${money(r.paidA)}</td>
                <td class="num">${money(r.paidB)}</td>
                <td class="num">${diff(r.paidDiff)}</td>
                <td class="num">${money(r.shortfallA)}</td>
                <td class="num">${money(r.shortfallB)}</td>
                <td class="num">${diff(r.shortfallDiff)}</td>
                <td class="num">${money(r.premiumA)} / ${money(r.premiumB)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h2>按事件比较</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>事件</th><th class="num">最终损失</th><th class="num">A 自留</th><th class="num">B 自留</th><th class="num">自留差异</th><th class="num">A 层摊回</th><th class="num">B 层摊回</th><th class="num">摊回差异</th></tr></thead>
          <tbody>
            ${cmp.eventRows.map((r) => `
              <tr>
                <td><b>${esc(r.eventLabel)}</b><div class="muted mono">${esc(r.eventId)}</div></td>
                <td class="num">${money(r.lossCents)}</td>
                <td class="num">${money(r.retentionA)}</td>
                <td class="num">${money(r.retentionB)}</td>
                <td class="num">${diff(r.retentionDiff)}</td>
                <td class="num">${money(r.layerPaidA)}</td>
                <td class="num">${money(r.layerPaidB)}</td>
                <td class="num">${diff(r.layerPaidDiff)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderEditTab() {
  const contract = selectedContract();
  const layer = selectedLayer(contract);
  const event = state.workbook.events.find((e) => e.id === state.selectedEventId) ?? state.workbook.events[0];
  if (!contract || !layer || !event) return '<div class="notice error">缺少可编辑的合同、层或事件。</div>';
  state.selectedContractId = contract.id;
  state.selectedLayerId = layer.id;
  state.selectedEventId = event.id;
  const r = layer.reinstatement ?? {};

  return `
  <div class="two-col-layout">
    <div style="display:grid;gap:16px">
      <form class="card" id="layer-form">
        <h2>编辑一层条款</h2>
        <p class="hint">金额单位为元，可输入千分位；保存时转为整数分并立即重放 A/B 两套顺序。</p>
        <div class="form-grid two">
          <label class="field">合同年度
            <select data-action="contract-change" name="contractId">
              ${state.workbook.contracts.map((c) => `<option value="${esc(c.id)}" ${c.id === contract.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field">选择层
            <select data-action="layer-change" name="layerId">
              ${[...contract.layers].sort((a,b)=>(a.order??999)-(b.order??999)).map((l) => `<option value="${esc(l.id)}" ${l.id === layer.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="form-grid" style="margin-top:10px">
          <label class="field" style="grid-column:1/-1">层名称<input name="name" value="${esc(layer.name)}" /></label>
          <label class="field">条款顺序<input name="order" type="number" min="1" step="1" value="${layer.order ?? 1}" /></label>
          <label class="field">每次事故免赔/自留<input name="deductible" inputmode="decimal" value="${moneyInput(contract.occurrenceDeductibleCents)}" /></label>
          <label class="field">起赔点（地面以上）<input name="attachment" inputmode="decimal" value="${moneyInput(layer.attachmentCents)}" /></label>
          <label class="field">单次限额<input name="occurrenceLimit" inputmode="decimal" value="${moneyInput(layer.occurrenceLimitCents)}" /></label>
          <label class="field">年度限额<input name="annualLimit" inputmode="decimal" value="${moneyInput(layer.annualLimitCents)}" /></label>
          <label class="field">层份额 bps（10000=100%）<input name="shareBps" type="number" min="0" max="10000" step="1" value="${layer.shareBps ?? 10000}" ${layer.participants ? 'disabled' : ''} /></label>
        </div>
        ${layer.participants ? `<div class="notice">该层使用多共保人权重，层份额字段只读；尾差按最大余数法在这些份额间分配。</div>` : ''}
        <h3>有限次数额度恢复</h3>
        <div class="form-grid">
          <label class="field">最大恢复次数<input name="reinstateMaxCount" type="number" min="0" step="1" value="${r.maxCount ?? 0}" /></label>
          <label class="field">每次恢复额度（元）<input name="reinstateAmount" inputmode="decimal" value="${moneyInput(r.amountCents ?? 0)}" /></label>
          <label class="field">费用率 bps（500=5%）<input name="reinstatePremiumBps" type="number" min="0" max="10000" step="1" value="${r.premiumRateBps ?? 0}" /></label>
          <label class="field">生效等待笔数<input name="waitEntries" type="number" min="0" step="1" value="${r.waitEntries ?? 0}" /></label>
        </div>
        <div class="form-actions">
          <button class="btn primary" type="submit">应用条款并重算新版本</button>
          <span class="muted">不会覆盖当前选中的 ${selectedVersion().id}</span>
        </div>
      </form>

      <form class="card" id="movement-form">
        <h2>加入补损 / 估损冲回</h2>
        <p class="hint">新流水引用原事件；引擎按累计损失重新计算免赔，不会把补损当成一次新事故。新增流水会追加到 A/B 两个顺序末尾。</p>
        <div class="form-grid two">
          <label class="field">原事件
            <select name="eventId" data-action="edit-event-change">
              ${state.workbook.events.map((e) => `<option value="${esc(e.id)}" ${e.id === event.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
            </select>
          </label>
          <label class="field">类型
            <select name="type">
              <option value="supplement">迟到补损（+）</option>
              <option value="revision">估损冲回（−）</option>
            </select>
          </label>
          <label class="field">金额（元，正数）<input name="amount" inputmode="decimal" placeholder="例如 35.00" required /></label>
          <label class="field">入账日期<input name="date" type="date" value="2025-08-15" /></label>
          <label class="field" style="grid-column:1/-1">备注<input name="memo" placeholder="例如：公估师补充资料后追加" /></label>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">加入流水并重算新版本</button></div>
      </form>
    </div>

    <div style="display:grid;gap:16px">
      <section class="card">
        <h2>${esc(event.label)} 的流水</h2>
        <p class="hint">发生日 ${esc(event.occurrenceDate)}；合同 <span class="mono">${esc(event.contractId ?? '按日期匹配')}</span></p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日期</th><th>类型</th><th>说明</th><th class="num">金额</th></tr></thead>
            <tbody>
              ${event.movements.map((m) => `
                <tr>
                  <td class="mono">${esc(m.date ?? '—')}</td>
                  <td>${typePill(m.type)}</td>
                  <td>${esc(m.memo ?? '')}<div class="muted mono">${esc(m.id)}</div></td>
                  <td class="num ${m.type === 'revision' ? 'negative' : 'positive'}">${signedMoney(m.type === 'revision' ? -m.amountCents : m.amountCents)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
      <section class="card">
        <h2>当前编辑层条款速览</h2>
        <div class="detail-grid">
          <div class="detail"><div class="k">起赔点</div><div class="v">${money(layer.attachmentCents)}</div></div>
          <div class="detail"><div class="k">单次限额</div><div class="v">${money(layer.occurrenceLimitCents)}</div></div>
          <div class="detail"><div class="k">年度限额</div><div class="v">${money(layer.annualLimitCents)}</div></div>
          <div class="detail"><div class="k">层份额</div><div class="v">${layer.participants ? '多共保人' : formatBps(layer.shareBps ?? 10000)}</div></div>
          <div class="detail"><div class="k">恢复次数</div><div class="v">${r.maxCount ?? 0} 次</div></div>
          <div class="detail"><div class="k">恢复额度</div><div class="v">${money(r.amountCents ?? 0)}</div></div>
          <div class="detail"><div class="k">恢复费用率</div><div class="v">${formatBps(r.premiumRateBps ?? 0)}</div></div>
          <div class="detail"><div class="k">生效等待</div><div class="v">${r.waitEntries ?? 0} 笔后</div></div>
        </div>
        ${layer.participants ? renderParticipants(layer) : ''}
      </section>
    </div>
  </div>`;
}

function renderParticipants(layer) {
  return `<h3>共保份额与尾差规则</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>份额</th><th class="num">bps</th><th class="num">比例</th><th>平局优先级</th></tr></thead>
      <tbody>${layer.participants.map((p) => `<tr><td>${esc(p.name ?? p.id)}</td><td class="num mono">${p.bps}</td><td class="num">${formatBps(p.bps)}</td><td>${p.tailPriority ?? '数组顺序'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">每一分尾差给小数余数最大的份额；余数相同按 tailPriority/数组顺序。</p>`;
}

function sideToggle(action, current) {
  return `<div class="button-row" role="group">
    <button class="btn small ${current === 'A' ? 'primary' : ''}" data-action="${action}" data-side="A" type="button">查看顺序 A</button>
    <button class="btn small ${current === 'B' ? 'primary' : ''}" data-action="${action}" data-side="B" type="button">查看顺序 B</button>
  </div>`;
}

function renderCapacityTab() {
  const version = selectedVersion();
  const side = state.inspectSide;
  const run = version[`run${side}`];
  const event = run.events.find((e) => e.eventId === state.selectedEventId) ?? run.events[0];
  if (event) state.selectedEventId = event.eventId;
  if (!event) return '<div class="notice error">没有事件结果。</div>';
  const wb = version.workbook;
  const contract = wb.contracts.find((c) => c.id === event.contractId);
  const layerIds = Object.keys(event.beforeCapacity);

  return `
    <div class="card">
      <div class="card-header">
        <div>
          <h2>查看某事件前后的剩余额度</h2>
          <p class="hint">版本 ${version.id} / ${side === 'A' ? esc(wb.orderAName) : esc(wb.orderBName)}。若同一事件的补损与其他事件交错，下表“首次进入前/最后一笔后”会包含中间流水；逐笔时间线列示每一次变化。</p>
        </div>
        <div class="button-row">
          <select data-action="capacity-event-change" aria-label="选择事件">
            ${run.events.map((e) => `<option value="${esc(e.eventId)}" ${e.eventId === event.eventId ? 'selected' : ''}>${esc(e.eventLabel)}</option>`).join('')}
          </select>
          ${sideToggle('capacity-side', side)}
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail"><div class="k">最终累计损失</div><div class="v">${money(event.lossCents)}</div></div>
        <div class="detail"><div class="k">免赔/自留免赔</div><div class="v">${money(event.deductibleCents)}</div></div>
        <div class="detail"><div class="k">本事件层摊回</div><div class="v positive">${money(event.layerPaidGrossCents)}</div></div>
        <div class="detail"><div class="k">本事件总自留</div><div class="v">${money(event.retentionCents)}</div></div>
      </div>
    </div>

    <section class="card" style="margin-top:16px">
      <h2>层额度：${esc(event.eventLabel)} 首次前 → 最后笔后</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>层</th><th class="num">事前可用</th><th class="num">事前已用</th>
            <th class="num">事件层摊回</th><th class="num">事件缺口</th>
            <th class="num">事后可用</th><th class="num">事后待生效恢复</th><th>恢复次数</th>
          </tr></thead>
          <tbody>
            ${layerIds.map((id) => {
              const before = event.beforeCapacity[id];
              const after = event.afterCapacity[id];
              const layer = contract?.layers.find((l) => l.id === id);
              return `<tr>
                <td><b>${esc(layer?.name ?? id)}</b><div class="muted mono">${esc(id)}</div></td>
                <td class="num"><b>${money(before.remainingCents)}</b><div class="muted">总额度 ${money(before.effectiveCapacityCents)}</div></td>
                <td class="num">${money(before.annualUsedGrossCents)}</td>
                <td class="num positive">${money(event.actualLayerGrossCents[id])}</td>
                <td class="num ${event.shortfallLayerGrossCents[id] ? 'negative' : ''}">${money(event.shortfallLayerGrossCents[id])}</td>
                <td class="num"><b>${money(after.remainingCents)}</b></td>
                <td class="num">${money(after.pendingRestoredCents)}${after.pendingRestoredCents ? ' <span class="pill yellow">待生效</span>' : ''}</td>
                <td>${after.grantedCount}/${after.maxCount}${after.failedCount ? ` <span class="pill red">失败 ${after.failedCount}</span>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h2>该事件逐笔开发流水</h2>
      ${run.entries.filter((e) => e.eventId === event.eventId).map(renderMovementTimelineItem).join('')}
    </section>`;
}

function renderRestorationPills(entry) {
  if (!entry.restorationAttempts?.length) return '';
  return entry.restorationAttempts.map((r) => `
    <div class="notice ${r.status === 'FAILED' ? 'error' : ''}" style="margin:6px 0">
      <b>${r.status === 'FAILED' ? '恢复失败' : '恢复申请/待生效'}</b>
      · ${esc(r.layerName)} · 第 ${r.count} 次 · 恢复 ${money(r.amountCents)}
      · 费用 ${money(r.premiumCents)}（${formatBps(r.premiumRateBps)}）
      · ${esc(r.reason)}
      ${r.availableAtContractSeq ? `· 同合同第 ${r.availableAtContractSeq} 笔起生效` : ''}
    </div>`).join('');
}

function renderLayerStepTable(entry) {
  return `<div class="table-wrap">
    <table>
      <thead><tr><th>顺序</th><th>层</th><th class="num">条款目标 Δ</th><th class="num">结算前可用</th><th class="num">本笔摊回 Δ</th><th class="num">缺口 Δ</th><th class="num">结算后可用</th></tr></thead>
      <tbody>
        ${entry.layerSteps.map((s) => `
          <tr>
            <td class="mono">${s.clauseOrder}</td>
            <td>${esc(s.layerName)}<div class="muted mono">${esc(s.layerId)}</div></td>
            <td class="num">${signedMoney(s.targetDeltaCents)}<div class="muted">${money(s.targetBeforeCents)} → ${money(s.targetAfterCents)}</div></td>
            <td class="num">${money(s.availableBeforeCents)}</td>
            <td class="num ${s.paidDeltaCents < 0 ? 'negative' : 'positive'}"><b>${signedMoney(s.paidDeltaCents)}</b></td>
            <td class="num ${s.shortfallDeltaCents > 0 ? 'negative' : ''}">${signedMoney(s.shortfallDeltaCents)}</td>
            <td class="num"><b>${money(s.availableAfterCents)}</b></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function renderMovementTimelineItem(entry) {
  return `
    <div class="flow-step ${entry.movementType}">
      <div class="entry-head" style="background:transparent;padding:0 0 8px">
        <div class="entry-title">#${entry.seq} ${typePill(entry.movementType)} <span class="mono">${esc(entry.movementId)}</span></div>
        <div class="button-row"><span class="mono muted">${esc(entry.postingDate ?? '无日期')}</span><b class="${entry.signedDeltaCents < 0 ? 'negative' : 'positive'}">${signedMoney(entry.signedDeltaCents)}</b></div>
      </div>
      <div class="detail-grid" style="margin-bottom:8px">
        <div class="detail"><div class="k">累计损失</div><div class="v">${money(entry.lossBeforeCents)} → ${money(entry.lossAfterCents)}</div></div>
        <div class="detail"><div class="k">校验</div><div class="v ${entry.balanced ? 'positive' : 'negative'}">${entry.balanced ? '✓ 分摊平衡' : '✗ 不平'}</div></div>
        <div class="detail" style="grid-column:span 2"><div class="k">备注</div><div class="v" style="font-weight:500">${esc(entry.memo || '—')}</div></div>
      </div>
      ${renderLayerStepTable(entry)}
      ${entry.activatedRestorations.length ? `<div class="notice success">本笔开始前激活恢复额度：${entry.activatedRestorations.map((r) => `${esc(r.layerName)} ${money(r.amountCents)}`).join('；')}</div>` : ''}
      ${renderRestorationPills(entry)}
    </div>`;
}

function renderLinesTable(entry) {
  return `<div class="table-wrap">
    <table>
      <thead><tr><th>承担方</th><th>原因/规则</th><th>关联层</th><th class="num">本笔金额</th><th class="num">事件累计</th></tr></thead>
      <tbody>
        ${entry.lines.map((line) => `
          <tr>
            <td>${line.bearerType === 'LAYER' ? `<span class="pill blue">层</span> ${esc(line.bearerName)}` : `<span class="pill gray">自留</span> ${esc(line.bearerName)}`}</td>
            <td>${esc(reasonLabel(line.reason))}<div class="muted">${esc(line.explanation ?? '')}</div></td>
            <td class="mono">${esc(line.layerId ?? '—')}</td>
            <td class="num ${line.amountCents < 0 ? 'negative' : line.amountCents > 0 ? 'positive' : 'muted'}"><b>${signedMoney(line.amountCents)}</b></td>
            <td class="num">${money(line.cumulativeEventCents)}</td>
          </tr>`).join('')}
      </tbody>
      <tfoot><tr><th colspan="3">本笔分摊合计 / 原始增量</th><th class="num">${money(entry.checksumCents)} / ${money(entry.signedDeltaCents)}</th><th class="num">${entry.balanced ? '✓' : '✗'}</th></tr></tfoot>
    </table>
  </div>`;
}

function renderLedgerTab() {
  const version = selectedVersion();
  const side = state.ledgerSide;
  const run = version[`run${side}`];
  const filter = state.ledgerEventFilter;
  const entries = filter === 'ALL' ? run.entries : run.entries.filter((e) => e.eventId === filter);
  return `
    <div class="card">
      <div class="card-header">
        <div><h2>逐笔流水逐层核对</h2><p class="hint">每笔补损/冲回均回到原事件；每张卡片的分摊行合计等于该笔有符号增量。建议与 <code>docs/hand-check.md</code> 对照。</p></div>
        <div class="button-row">
          <select data-action="ledger-event-change">
            <option value="ALL" ${filter === 'ALL' ? 'selected' : ''}>全部事件</option>
            ${run.events.map((e) => `<option value="${esc(e.eventId)}" ${filter === e.eventId ? 'selected' : ''}>${esc(e.eventLabel)}</option>`).join('')}
          </select>
          ${sideToggle('ledger-side', side)}
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail"><div class="k">总损失</div><div class="v">${money(run.totals.grossLossCents)}</div></div>
        <div class="detail"><div class="k">自留</div><div class="v">${money(run.totals.retentionCents)}</div></div>
        <div class="detail"><div class="k">层摊回</div><div class="v positive">${money(run.totals.layerPaidGrossCents)}</div></div>
        <div class="detail"><div class="k">平衡校验</div><div class="v ${run.totals.balanced ? 'positive' : 'negative'}">${run.totals.conservationDifferenceCents === 0 ? '✓ 0 分差异' : `差异 ${money(run.totals.conservationDifferenceCents)}`}</div></div>
      </div>
    </div>
    ${entries.map((entry) => `
      <article class="entry-card">
        <div class="entry-head">
          <div class="entry-title">第 ${entry.seq} 笔 · ${esc(entry.eventLabel)} · ${typePill(entry.movementType)}</div>
          <div class="button-row">
            <span class="mono muted">${esc(entry.postingDate ?? '无日期')} · ${esc(entry.contractId)}</span>
            <b class="${entry.signedDeltaCents < 0 ? 'negative' : ''}">${signedMoney(entry.signedDeltaCents)}</b>
          </div>
        </div>
        <div class="entry-body">
          <div class="detail-grid">
            <div class="detail"><div class="k">事件累计损失</div><div class="v">${money(entry.lossBeforeCents)} → ${money(entry.lossAfterCents)}</div></div>
            <div class="detail"><div class="k">合同流水序号</div><div class="v">#${entry.contractSeq}</div></div>
            <div class="detail"><div class="k">平衡</div><div class="v ${entry.balanced ? 'positive' : 'negative'}">${money(entry.checksumCents)} = ${money(entry.signedDeltaCents)}</div></div>
            <div class="detail"><div class="k">备注</div><div class="v" style="font-weight:500">${esc(entry.memo || '—')}</div></div>
          </div>
          ${renderLayerStepTable(entry)}
          ${renderLinesTable(entry)}
          ${entry.activatedRestorations.length ? `<div class="notice success">已激活：${entry.activatedRestorations.map((r) => `${esc(r.id)} ${esc(r.layerName)} ${money(r.amountCents)}`).join('；')}</div>` : ''}
          ${renderRestorationPills(entry)}
          ${entry.tail?.length ? `<div class="notice"><b>尾差记录：</b>${entry.tail.map((t) => `${esc(t.layerId)} → ${esc(t.key)} 分得 ${money(t.amountCents)}；规则 ${esc(t.rule)}`).join('；')}</div>` : ''}
        </div>
      </article>`).join('')}`;
}

function renderVersionsTab() {
  const version = selectedVersion();
  return `
    <div class="grid two">
      <section class="card">
        <h2>不可变结算版本</h2>
        <p class="hint">每次条款修改、加入补损或交换顺序都会冻结一份新的 workbook 快照及 A/B 两套结算；旧版本保留在本会话中，可随时切回核对或导出。</p>
        ${[...state.versions].reverse().map((v) => `
          <div class="version-item ${v.id === version.id ? 'active' : ''}">
            <div>
              <div class="version-title">${v.id} · ${esc(v.note)}</div>
              <div class="version-meta">${esc(new Date(v.createdAt).toLocaleString('zh-CN'))} · 样例 ${esc(v.workbook.id)} · A/B 均平衡：${v.runA.totals.balanced && v.runB.totals.balanced ? '是' : '否'}</div>
              <div class="version-meta">损失 ${money(v.runA.totals.grossLossCents)}；A 自留 ${money(v.runA.totals.retentionCents)} / B 自留 ${money(v.runB.totals.retentionCents)}</div>
            </div>
            <div class="button-row">
              <button class="btn small ${v.id === version.id ? 'primary' : ''}" data-action="select-version" data-id="${v.id}" type="button">${v.id === version.id ? '正在查看' : '查看'}</button>
              <button class="btn small" data-action="export-version-item" data-id="${v.id}" type="button">导出 JSON</button>
            </div>
          </div>`).join('')}
      </section>

      <section class="card">
        <h2>计算与尾差规则</h2>
        <ul>
          <li>金额内部为整数“分”，比例为整数 bps；不使用浮点金额。</li>
          <li>同一事件的 initial/supplement/revision 合并为累计损失；免赔按累计损失计算，冲回可回吐，后续补损只补未吸收免赔余额。</li>
          <li>多层按 <code>layer.order</code> 从小到大适用；后层还受“不得超过扣除免赔和先序层后的未分配损失”约束。</li>
          <li>年度有效额度 = 年度限额 + 已生效恢复额度；恢复在额度被本笔支付从正余额打到 0 时申请一次。</li>
          <li>恢复额度有次数、费用率和 <code>waitEntries</code> 生效限制；等待笔数按同一合同的流水序号计算，跨合同不互相消耗。</li>
          <li>共保份额先 floor 到整分，剩余每一分按最大余数法分配；平局按 <code>tailPriority</code> 再按数组顺序。</li>
          <li>每笔流水和总结算都有平衡校验；差额必须为 0。</li>
        </ul>
        <p>核对文档：<a href="../../docs/hand-check.md" target="_blank" rel="noreferrer">手算流水</a> · <a href="../../docs/scenario-analysis.md" target="_blank" rel="noreferrer">情景分析</a></p>
        <div class="form-actions">
          <button class="btn primary" data-action="export-current" type="button">导出当前版本 JSON</button>
        </div>
      </section>
    </div>`;
}

function render() {
  renderHeaderSelect();
  renderNotice();
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  });
  let html = '';
  if (state.tab === 'compare') html = renderCompareTab();
  if (state.tab === 'edit') html = renderEditTab();
  if (state.tab === 'capacity') html = renderCapacityTab();
  if (state.tab === 'ledger') html = renderLedgerTab();
  if (state.tab === 'versions') html = renderVersionsTab();
  app.innerHTML = html;
}

// Header controls.
sampleSelect.addEventListener('change', () => {
  state = createState(sampleSelect.value);
  render();
});
document.querySelector('#reset-sample').addEventListener('click', () => {
  const tab = state.tab;
  state = createState(state.sampleId);
  state.tab = tab;
  render();
});
document.querySelector('#export-version').addEventListener('click', () => {
  const v = selectedVersion();
  downloadJSON(`${v.workbook.id}-${v.id}.json`, v);
});

// Tabs.
document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    state.tab = button.dataset.tab;
    render();
  });
});

// Delegated actions.
app.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'swap-orders') {
    const viewedVersion = selectedVersion();
    const latestVersion = state.versions[state.versions.length - 1];
    if (viewedVersion.id !== latestVersion.id) {
      state.workbook = cloneWorkbook(viewedVersion.workbook);
    }
    [state.workbook.orderA, state.workbook.orderB] = [state.workbook.orderB, state.workbook.orderA];
    [state.workbook.orderAName, state.workbook.orderBName] = [state.workbook.orderBName, state.workbook.orderAName];
    commitVersion('交换 A/B 事件顺序后重放');
  }
  if (action === 'capacity-side') {
    state.inspectSide = button.dataset.side;
    render();
  }
  if (action === 'ledger-side') {
    state.ledgerSide = button.dataset.side;
    render();
  }
  if (action === 'select-version') {
    state.selectedVersionId = button.dataset.id;
    state.tab = 'compare';
    render();
  }
  if (action === 'export-version-item') {
    const version = state.versions.find((v) => v.id === button.dataset.id);
    if (version) downloadJSON(`${version.workbook.id}-${version.id}.json`, version);
  }
  if (action === 'export-current') {
    const v = selectedVersion();
    downloadJSON(`${v.workbook.id}-${v.id}.json`, v);
  }
});

app.addEventListener('change', (event) => {
  const control = event.target;
  const action = control.dataset.action;
  if (action === 'contract-change') {
    state.selectedContractId = control.value;
    const contract = selectedContract();
    state.selectedLayerId = contract?.layers[0]?.id ?? null;
    render();
  }
  if (action === 'layer-change') {
    state.selectedLayerId = control.value;
    render();
  }
  if (action === 'edit-event-change' || action === 'capacity-event-change') {
    state.selectedEventId = control.value;
    render();
  }
  if (action === 'ledger-event-change') {
    state.ledgerEventFilter = control.value;
    render();
  }
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'layer-form') {
    const before = cloneWorkbook(state.workbook);
    try {
      const data = new FormData(form);
      const contract = state.workbook.contracts.find((c) => c.id === data.get('contractId')) ?? selectedContract();
      const layer = contract.layers.find((l) => l.id === data.get('layerId')) ?? selectedLayer(contract);
      if (!contract || !layer) throw new Error('找不到要编辑的合同或层');
      contract.occurrenceDeductibleCents = yuanToCents(data.get('deductible'));
      layer.name = String(data.get('name') || layer.name);
      layer.order = Number.parseInt(data.get('order'), 10);
      layer.attachmentCents = yuanToCents(data.get('attachment'));
      layer.occurrenceLimitCents = yuanToCents(data.get('occurrenceLimit'));
      layer.annualLimitCents = yuanToCents(data.get('annualLimit'));
      if (!layer.participants) layer.shareBps = Number.parseInt(data.get('shareBps'), 10);
      layer.reinstatement = {
        ...(layer.reinstatement ?? {}),
        maxCount: Number.parseInt(data.get('reinstateMaxCount'), 10),
        amountCents: yuanToCents(data.get('reinstateAmount')),
        premiumRateBps: Number.parseInt(data.get('reinstatePremiumBps'), 10),
        waitEntries: Number.parseInt(data.get('waitEntries'), 10),
      };
      state.selectedContractId = contract.id;
      state.selectedLayerId = layer.id;
      const ok = commitVersion(`编辑层「${layer.name}」条款`);
      if (!ok) {
        state.workbook = before;
        render();
      }
    } catch (error) {
      state.workbook = before;
      state.error = error.message;
      render();
    }
  }

  if (form.id === 'movement-form') {
    const before = cloneWorkbook(state.workbook);
    try {
      const data = new FormData(form);
      const eventId = String(data.get('eventId'));
      const lossEvent = state.workbook.events.find((e) => e.id === eventId);
      if (!lossEvent) throw new Error('找不到原事件');
      const type = String(data.get('type'));
      const amountCents = yuanToCents(data.get('amount'));
      if (amountCents <= 0) throw new Error('金额必须大于 0；方向由类型决定');
      state.userSeq += 1;
      const movement = {
        id: `M-USER-${state.userSeq}`,
        date: String(data.get('date') || '') || undefined,
        type,
        amountCents,
        memo: String(data.get('memo') || '网页新增流水'),
      };
      lossEvent.movements.push(movement);
      state.workbook.orderA.push(movement.id);
      state.workbook.orderB.push(movement.id);
      state.selectedEventId = eventId;
      const ok = commitVersion(`${type === 'supplement' ? '加入补损' : '加入冲回'} ${money(amountCents)} 到 ${lossEvent.label}`);
      if (ok) form.reset();
      if (!ok) {
        state.workbook = before;
        render();
      }
    } catch (error) {
      state.workbook = before;
      state.error = error.message;
      render();
    }
  }
});

render();
