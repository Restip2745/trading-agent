/**
 * Claude 交易系統 Web UI（規格第 11 節）。Vue 3，不需要建置工具。
 * 寫入請求帶 X-Ctrade-Token（由伺服器嵌在頁面 meta 中）；所有寫入都由後端的 core/admin.ts 驗證。
 */
import { computed, createApp, onMounted, onUnmounted, reactive, ref, watch } from '/vendor/vue/vue.esm-browser.prod.js';
import { renderMarkdown } from './markdown.js';

const TOKEN = document.querySelector('meta[name="ctrade-token"]').content;
const ACTIVE_MODE = document.querySelector('meta[name="ctrade-mode"]').content;

// ---------------------------------------------------------------- 共用狀態與 API

const store = reactive({
  view: localStorage.getItem('ctrade-view') ?? ACTIVE_MODE,
  views: [ACTIVE_MODE],
  toast: null,
  confirm: null,
  refreshKey: 0,
});

function viewParam() {
  return store.view === ACTIVE_MODE ? '' : `db=${store.view}`;
}

async function get(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  const extra = viewParam();
  const url = `/api/${path}${qs.toString() || extra ? '?' : ''}${[qs.toString(), extra].filter(Boolean).join('&')}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.data;
}

async function post(path, body = {}) {
  const res = await fetch(`/api/admin/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ctrade-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.data;
}

function toast(message, error = false) {
  store.toast = { message, error };
  setTimeout(() => {
    if (store.toast?.message === message) store.toast = null;
  }, error ? 8000 : 3500);
}

/** 二次確認：回傳 Promise<boolean>。不使用瀏覽器原生的 confirm／prompt。 */
function confirmDialog(title, lines, { danger = false, okText = '確認' } = {}) {
  return new Promise((resolve) => {
    store.confirm = { title, lines, danger, okText, resolve };
  });
}

/** 帶輸入欄位的對話框：回傳輸入的文字，取消時回傳 null。 */
function askInput(title, lines, { label, value = '', required = false, type = 'text', okText = '確認', danger = false } = {}) {
  return new Promise((resolve) => {
    store.confirm = { title, lines, danger, okText, input: { label, value: String(value), required, type }, resolve };
  });
}

/** 執行寫入：確認 → 送出 → 通知 → 重新整理。 */
async function act(path, body, { confirm, success } = {}) {
  if (confirm && !(await confirmDialog(confirm.title, confirm.lines, confirm))) return null;
  try {
    const data = await post(path, body);
    toast(success ?? '已完成');
    store.refreshKey++;
    return data;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/** 頁面資料載入：檢視切換或寫入後自動重新載入。 */
function useData(loader, intervalMs = 0) {
  const data = ref(null);
  const error = ref(null);
  const loading = ref(false);
  const load = async () => {
    loading.value = true;
    try {
      data.value = await loader();
      error.value = null;
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  };
  let timer;
  onMounted(() => {
    load();
    if (intervalMs) timer = setInterval(load, intervalMs);
  });
  onUnmounted(() => clearInterval(timer));
  watch(() => [store.view, store.refreshKey], load);
  return { data, error, loading, load };
}

const isActiveView = computed(() => store.view === ACTIVE_MODE);

// ---------------------------------------------------------------- 格式

const nf = new Intl.NumberFormat('zh-TW');
const money = (v) => (v === null || v === undefined ? '-' : nf.format(Math.round(v)));
const signed = (v) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${nf.format(Math.round(v))}`);
const pct = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? '-' : `${(v * 100).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const time = (iso) => (iso ? iso.replace('T', ' ').slice(0, 19).replace(/\.\d+$/, '') : '-');
const hhmm = (iso) => (iso ? iso.slice(11, 16) : '-');
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const ago = (iso) => {
  if (!iso) return '從未';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
};
const fmt = { money, signed, pct, cls, time, hhmm, ago };

const KIND = {
  pre_open: '盤前',
  open: '開盤',
  interval: '定時',
  price_move: '價格',
  pre_close: '收盤前',
  stop_triggered: '停損停利',
  review: '復盤',
};
const STATUS = {
  pending_submit: '待送出',
  submitted: '委託中',
  partial: '部分成交',
  filled: '全部成交',
  cancelled: '已刪單',
  rejected: '被拒絕',
  expired: '已到期',
  unknown: '結果不明',
};
const SESSION = { regular: '整股', odd_intraday: '盤中零股', odd_after: '盤後零股' };
const DECISION_ACTION = { buy: '買入', sell: '賣出', both: '買賣', none: '不動作' };
const CASH_TYPE = {
  allocate_in: '撥入',
  allocate_out: '撥出',
  buy: '買進價金',
  sell: '賣出價金',
  fee: '手續費',
  fee_rebate: '手續費退款',
  tax: '證交稅',
  dividend: '股利',
  capital_reduction: '減資退款',
  adjust: '調整',
};
const POS_TYPE = { buy: '買進', sell: '賣出', transfer_in: '轉入', transfer_out: '轉出', corporate_action: '公司行動', adjust: '調整' };

// ---------------------------------------------------------------- 元件

const DataTable = {
  props: { rows: Array, cols: Array, empty: { type: String, default: '沒有資料' } },
  template: `
    <div class="table-wrap">
      <table v-if="rows && rows.length">
        <thead><tr><th v-for="c in cols" :key="c.key" :class="{ num: c.num }">{{ c.label }}</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.id ?? i">
            <td v-for="c in cols" :key="c.key" :class="[{ num: c.num, mono: c.mono }, c.cls ? c.cls(r) : '']">
              <slot :name="c.key" :row="r">{{ c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '-') }}</slot>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">{{ empty }}</div>
    </div>`,
};

const Kpi = {
  props: ['label', 'value', 'sub', 'tone'],
  template: `<div class="kpi"><div class="label">{{ label }}</div><div class="value" :class="tone">{{ value }}</div><div class="sub" v-if="sub">{{ sub }}</div></div>`,
};

/** 權益曲線（內嵌 SVG）：實線為權益，虛線為歷史高點。 */
const EquityChart = {
  props: { points: Array },
  setup(props) {
    const W = 800;
    const H = 220;
    const P = { l: 64, r: 12, t: 12, b: 26 };
    const geo = computed(() => {
      const pts = props.points ?? [];
      if (pts.length < 2) return null;
      const vals = pts.flatMap((p) => [p.equity, p.peak_equity]);
      let min = Math.min(...vals);
      let max = Math.max(...vals);
      if (max === min) {
        max += 1;
        min -= 1;
      }
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
      const x = (i) => P.l + (i * (W - P.l - P.r)) / (pts.length - 1);
      const y = (v) => P.t + ((max - v) * (H - P.t - P.b)) / (max - min);
      const line = (key) => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
      const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
      const labels = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].map((i) => ({ x: x(i), text: pts[i].date.slice(5) }));
      return { equity: line('equity'), peak: line('peak_equity'), ticks: ticks.map((v) => ({ y: y(v), text: money(v) })), labels };
    });
    return { geo, W, H, P };
  },
  template: `
    <div v-if="!geo" class="empty">每日快照少於兩天，還無法畫出權益曲線（快照在每天收盤後產生）。</div>
    <svg v-else class="chart" :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" role="img" aria-label="權益曲線">
      <g v-for="t in geo.ticks"><line class="grid" :x1="P.l" :x2="W - P.r" :y1="t.y" :y2="t.y" /><text class="axis" :x="P.l - 6" :y="t.y + 4" text-anchor="end">{{ t.text }}</text></g>
      <text v-for="l in geo.labels" class="axis" :x="l.x" :y="H - 6" text-anchor="middle">{{ l.text }}</text>
      <polyline class="peak" :points="geo.peak" />
      <polyline class="equity" :points="geo.equity" />
    </svg>`,
};

const BarChart = {
  props: { items: Array, valueKey: String, labelKey: String },
  setup(props) {
    const W = 800;
    const H = 180;
    const bars = computed(() => {
      const items = (props.items ?? []).slice().reverse();
      if (!items.length) return null;
      const max = Math.max(1, ...items.map((i) => i[props.valueKey]));
      const bw = (W - 20) / items.length;
      return items.map((it, i) => {
        const h = ((H - 30) * it[props.valueKey]) / max;
        return { x: 10 + i * bw + 1, w: Math.max(1, bw - 2), y: H - 20 - h, h, label: String(it[props.labelKey]).slice(5), value: it[props.valueKey] };
      });
    });
    return { bars, W, H };
  },
  template: `
    <div v-if="!bars" class="empty">沒有資料</div>
    <svg v-else class="chart" :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none">
      <g v-for="b in bars"><rect class="bar" :x="b.x" :y="b.y" :width="b.w" :height="b.h"><title>{{ b.label }}：{{ b.value.toLocaleString() }}</title></rect></g>
      <text v-if="bars.length" class="axis" :x="bars[0].x" :y="H - 4">{{ bars[0].label }}</text>
      <text v-if="bars.length > 1" class="axis" :x="bars[bars.length - 1].x" :y="H - 4" text-anchor="end">{{ bars[bars.length - 1].label }}</text>
    </svg>`,
};

/**
 * 決策日誌的盤勢圖（內嵌 SVG）：一天的 5 分 K、VWAP、停損停利、價格觸發帶、決策與成交點，下方是量與等效曝險。
 * 時間軸是 09:00–13:30，左右各留一段給盤前（08:00 起）與盤後（到 15:00）的決策與成交。
 * 選取一筆決策時，之後的 K 棒淡化：區分「決策當時已知」與「之後才發生」。
 * 其他標的（槓桿、反向）的成交點畫在基準標的的同一時間、以空心標記，實際成交價放在說明裡。
 */
const DayChart = {
  props: { chart: Object, selectedId: Number },
  emits: ['select'],
  setup(props, { emit }) {
    const el = ref(null);
    const width = ref(900);
    let ro;
    onMounted(() => {
      ro = new ResizeObserver(([e]) => (width.value = Math.max(300, Math.round(e.contentRect.width))));
      ro.observe(el.value);
    });
    onUnmounted(() => ro?.disconnect());
    const hover = ref(null);

    const OPEN = 540;
    const CLOSE = 810;
    const G = 44; // 盤前、盤後區寬度
    const PL = 8;
    const PR = 70;
    const laneH = 24;
    const priceTop = laneH;
    const priceBot = priceTop + 230;
    const volTop = priceBot + 10;
    const volBot = volTop + 52;
    const expTop = volBot + 14;
    const expBot = expTop + 80;
    const H = expBot + 22;

    const minutes = (iso) => {
      const [h, m, s] = iso.slice(11, 19).split(':').map(Number);
      return h * 60 + m + (s || 0) / 60;
    };
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const leverageLabel = (lev) => (lev === 1 ? '' : `${lev}x`);

    const geo = computed(() => {
      const c = props.chart;
      if (!c) return null;
      const W = width.value;
      const S = W - PL - PR - 2 * G;
      const x0 = PL;
      const xEnd = W - PR;
      const xm = (m) => {
        if (m < OPEN) return x0 + G * clamp01((m - 480) / 60);
        if (m <= CLOSE) return x0 + G + ((m - OPEN) * S) / (CLOSE - OPEN);
        return x0 + G + S + G * clamp01((m - CLOSE) / 90);
      };
      const x = (iso) => (iso.slice(0, 10) < c.date ? x0 : xm(minutes(iso)));
      const bw = Math.max(1.5, (S / 54) * 0.62);

      const bars = c.bars;
      const lev = Object.fromEntries(c.symbols.map((s) => [s.symbol, s.leverage]));
      const selected = c.decisions.find((d) => d.id === props.selectedId);
      const cut = selected ? Date.parse(selected.ts) : Infinity;
      const isFuture = (b) => Date.parse(b.date) >= cut;

      // ---- 價格座標
      const baseFills = c.fills.filter((f) => f.symbol === c.symbol);
      const vals = [...bars.flatMap((b) => [b.high, b.low]), ...c.vwap.filter((v) => v !== null), ...baseFills.map((f) => f.price)];
      let y = null;
      let priceTicks = [];
      const clampY = (v) => {
        const raw = y(v);
        if (raw < priceTop + 2) return { y: priceTop + 2, out: '↑' };
        if (raw > priceBot - 2) return { y: priceBot - 2, out: '↓' };
        return { y: raw, out: '' };
      };
      if (vals.length) {
        let lo = Math.min(...vals);
        let hi = Math.max(...vals);
        if (hi === lo) (hi += 0.5), (lo -= 0.5);
        const pad = (hi - lo) * 0.08;
        lo -= pad;
        hi += pad;
        y = (v) => priceTop + ((hi - v) * (priceBot - priceTop)) / (hi - lo);
        priceTicks = [0.1, 0.4, 0.7, 0.95].map((f) => lo + (hi - lo) * f).map((v) => ({ y: y(v), text: v.toFixed(2) }));
      }
      const barCenter = (b) => xm(minutes(b.date) + 2.5);

      const candles = y
        ? bars.map((b, i) => ({
            i,
            x: barCenter(b),
            up: b.close >= b.open,
            future: isFuture(b),
            hiY: y(b.high),
            loY: y(b.low),
            top: y(Math.max(b.open, b.close)),
            h: Math.max(1, Math.abs(y(b.open) - y(b.close))),
          }))
        : [];
      const vwap = y
        ? bars
            .map((b, i) => (c.vwap[i] === null ? null : `${barCenter(b).toFixed(1)},${y(c.vwap[i]).toFixed(1)}`))
            .filter(Boolean)
            .join(' ')
        : '';

      // ---- 停損停利、觸發帶（階梯線，最後一段標價格）
      const steps = (series, key, label, cls) => {
        if (!y) return [];
        const out = [];
        series.forEach((s, i) => {
          const v = s[key];
          if (v === null || v === undefined) return;
          const x1 = x(s.ts);
          const x2 = i + 1 < series.length ? x(series[i + 1].ts) : xEnd;
          if (x2 <= x1) return;
          out.push({ x1, x2, ...clampY(v), v, cls, label });
        });
        if (out.length) out[out.length - 1].last = true;
        return out;
      };
      const levels = [
        ...steps(c.triggers, 'upper', '觸發上緣', 'trig'),
        ...steps(c.triggers, 'lower', '觸發下緣', 'trig'),
        ...steps(c.stops, 'take_profit', '停利', 'tp'),
        ...steps(c.stops, 'stop', '停損', 'sl'),
      ];
      // 右側標籤由上而下排開，避免重疊；與標籤太近的價格刻度不顯示
      let prevY = -Infinity;
      for (const l of levels.filter((l) => l.last).sort((a, b) => a.y - b.y)) {
        l.labelY = Math.max(l.y + 4, prevY + 12);
        prevY = l.labelY;
      }
      const labelYs = levels.filter((l) => l.last).map((l) => l.labelY);
      priceTicks = priceTicks.filter((t) => labelYs.every((ly) => Math.abs(t.y + 4 - ly) >= 11));

      // ---- 成交點：基準標的畫在成交價；其他標的畫在基準標的同一時間的價位
      const baseAt = (ts) => {
        const t = Date.parse(ts);
        let b = bars[0];
        for (const bar of bars) if (Date.parse(bar.date) <= t) b = bar;
        return b?.close;
      };
      const fills = y
        ? c.fills
            .map((f) => {
              const own = f.symbol === c.symbol;
              const p = own ? f.price : baseAt(f.ts);
              if (p === undefined) return null;
              const cx = x(f.ts);
              const { y: py } = clampY(p);
              const buy = f.side === 'buy';
              const path = buy
                ? `M${cx},${py + 3} L${cx - 5},${py + 12} L${cx + 5},${py + 12} Z`
                : `M${cx},${py - 3} L${cx - 5},${py - 12} L${cx + 5},${py - 12} Z`;
              return {
                id: f.id,
                path,
                own,
                buy,
                future: Date.parse(f.ts) > cut,
                label: own ? '' : leverageLabel(lev[f.symbol] ?? 1) || f.symbol,
                lx: cx + 7,
                ly: buy ? py + 12 : py - 5,
                title: `${hhmm(f.ts)} ${f.symbol} ${f.side === 'buy' ? '買進' : '賣出'} ${nf.format(f.qty)} 股 @ ${f.price.toFixed(2)}（${SESSION[f.session] ?? f.session}${f.origin === 'claude' ? '' : `，${f.origin === 'stop' ? '停損停利' : '緊急'}`}）`,
              };
            })
            .filter(Boolean)
        : [];

      // ---- 量
      const maxVol = Math.max(1, ...bars.map((b) => b.volume));
      const vols = bars.map((b) => {
        const h = ((volBot - volTop) * b.volume) / maxVol;
        return { x: barCenter(b) - bw / 2, y: volBot - h, h, up: b.close >= b.open, future: isFuture(b) };
      });

      // ---- 等效曝險：依標的堆疊（正值往上、負值往下），粗線為淨曝險
      const syms = c.exposure_symbols.map((s) => s.symbol);
      let expo = null;
      if (c.exposure.length && syms.length) {
        const stacked = c.exposure.map((p) => {
          let pos = 0;
          let neg = 0;
          const layers = syms.map((s) => {
            const v = p.parts.find((q) => q.symbol === s)?.pct ?? 0;
            if (v >= 0) return [pos, (pos += v)];
            return [neg, (neg += v)];
          });
          return { x: x(p.t), layers, pos, neg };
        });
        const maxPos = Math.max(0, ...stacked.map((s) => s.pos));
        const minNeg = Math.min(0, ...stacked.map((s) => s.neg));
        const span = Math.max(0.2, maxPos, -minNeg) * 1.1;
        const top = maxPos > 0 || minNeg === 0 ? span : 0;
        const bottom = minNeg < 0 ? -span : 0;
        const ye = (v) => expTop + ((top - v) * (expBot - expTop)) / (top - bottom || 1);
        const areas = syms.map((s, k) => {
          const upper = stacked.map((p) => `${p.x.toFixed(1)},${ye(p.layers[k][1]).toFixed(1)}`);
          const lower = stacked.map((p) => `${p.x.toFixed(1)},${ye(p.layers[k][0]).toFixed(1)}`).reverse();
          return { symbol: s, k, points: [...upper, ...lower].join(' ') };
        });
        const net = c.exposure
          .map((p) => (p.net_pct === null ? null : `${x(p.t).toFixed(1)},${ye(p.net_pct).toFixed(1)}`))
          .filter(Boolean)
          .join(' ');
        const ticks = [top, 0, bottom].filter((v, i, a) => a.indexOf(v) === i).map((v) => ({ y: ye(v), text: pct(v, 0) }));
        expo = { areas, net, ticks, zero: ye(0) };
      }

      // ---- 決策點
      // 形狀依委託方向：▲ 買入、▼ 賣出、◆ 買賣都有、○ 不動作；有下單但沒有成交時為空心
      const cy = laneH / 2 - 1;
      const markPath = (action, cx, s) => {
        if (action === 'buy') return `M${cx},${cy - s} L${cx + s},${cy + s * 0.8} L${cx - s},${cy + s * 0.8} Z`;
        if (action === 'sell') return `M${cx},${cy + s} L${cx + s},${cy - s * 0.8} L${cx - s},${cy - s * 0.8} Z`;
        if (action === 'both') return `M${cx},${cy - s} L${cx + s},${cy} L${cx},${cy + s} L${cx - s},${cy} Z`;
        const r = s * 0.7;
        return `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`;
      };
      const decisions = c.decisions.map((d) => {
        const cx = x(d.ts);
        const selected = d.id === props.selectedId;
        const unfilled = d.action !== 'none' && !d.filled;
        return {
          ...d,
          cx,
          cy,
          selected,
          unfilled,
          path: markPath(d.action, cx, selected ? 8 : 6.5),
          title: `${hhmm(d.ts)} ${KIND[d.kind] ?? d.kind ?? '手動'}・${DECISION_ACTION[d.action]}${d.orders ? `（${d.orders} 筆委託${unfilled ? '，未成交' : ''}）` : ''}：${d.actions}`,
        };
      });

      const hours = [540, 600, 660, 720, 780, 810]
        .map((m) => ({ x: xm(m), text: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }))
        .reduce((kept, h) => (kept.length && h.x - kept[kept.length - 1].x < 30 ? kept : [...kept, h]), []); // 窄螢幕上太近的時間省略
      return {
        W, x0, xEnd, S, bw, candles, vwap, levels, fills, vols, expo, decisions, hours, priceTicks, selected,
        selX: selected ? x(selected.ts) : null,
        hoverX: hover.value !== null && candles[hover.value] ? candles[hover.value].x : null,
        gutters: [
          { x: x0, text: '盤前' },
          { x: x0 + G + S, text: '盤後' },
        ],
        cutLabel: selected && bars.some(isFuture) ? { x: Math.min(x(selected.ts) + 4, xEnd - 60) } : null,
      };
    });

    const onMove = (e) => {
      const g = geo.value;
      if (!g || !g.candles.length) return;
      const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
      let best = 0;
      g.candles.forEach((c, i) => {
        if (Math.abs(c.x - px) < Math.abs(g.candles[best].x - px)) best = i;
      });
      hover.value = best;
    };

    /** 圖上方的數值列：滑鼠所在的 K 棒（沒有時為最後一根）與當時的曝險。 */
    const readout = computed(() => {
      const c = props.chart;
      if (!c?.bars.length) return null;
      const i = hover.value ?? c.bars.length - 1;
      const b = c.bars[i];
      if (!b) return null;
      const e = c.exposure[i];
      return {
        time: hhmm(b.date),
        ohlc: `開 ${b.open.toFixed(2)}　高 ${b.high.toFixed(2)}　低 ${b.low.toFixed(2)}　收 ${b.close.toFixed(2)}`,
        vol: `量 ${nf.format(b.volume)} 張`,
        vwap: c.vwap[i] === null ? '' : `VWAP ${c.vwap[i].toFixed(2)}`,
        expo: e ? `等效曝險 ${pct(e.net_pct, 1)}（權益 ${money(e.equity)}）` : '',
      };
    });

    return { el, geo, H, laneH, priceTop, priceBot, volTop, volBot, expTop, expBot, G, readout, hover, onMove, emit };
  },
  template: `
    <div ref="el" class="daychart-wrap">
      <div class="readout mono" v-if="readout">
        <strong>{{ readout.time }}</strong><span>{{ readout.ohlc }}</span><span>{{ readout.vol }}</span>
        <span class="vwap-text" v-if="readout.vwap">{{ readout.vwap }}</span><span v-if="readout.expo">{{ readout.expo }}</span>
      </div>
      <svg v-if="geo" class="daychart" :viewBox="'0 0 ' + geo.W + ' ' + H" :style="{ height: H + 'px' }" role="img" aria-label="當日盤勢圖"
           @mousemove="onMove" @mouseleave="hover = null">
        <g v-for="g in geo.gutters"><rect class="gutter" :x="g.x" :y="0" :width="G" :height="expBot" /><text class="axis" :x="g.x + G / 2" :y="priceBot - 6" text-anchor="middle">{{ g.text }}</text></g>
        <g v-for="t in geo.priceTicks"><line class="grid" :x1="geo.x0" :x2="geo.xEnd" :y1="t.y" :y2="t.y" /><text class="axis" :x="geo.xEnd + 6" :y="t.y + 4">{{ t.text }}</text></g>
        <g v-for="h in geo.hours"><line class="grid faint" :x1="h.x" :x2="h.x" :y1="priceTop" :y2="expBot" /><text class="axis" :x="h.x" :y="H - 6" text-anchor="middle">{{ h.text }}</text></g>
        <text v-if="!geo.candles.length" class="axis" :x="(geo.x0 + geo.xEnd) / 2" :y="(priceTop + priceBot) / 2" text-anchor="middle">沒有 K 線</text>

        <g v-for="l in geo.levels" :class="['level', l.cls]">
          <line :x1="l.x1" :x2="l.x2" :y1="l.y" :y2="l.y"><title>{{ l.label }} {{ l.v.toFixed(2) }}</title></line>
          <text v-if="l.last" class="level-text" :x="geo.xEnd + 4" :y="l.labelY">{{ l.label.slice(0, 2) }}{{ l.out }}{{ l.v.toFixed(2) }}</text>
        </g>

        <g v-for="c in geo.candles" :class="['candle', c.up ? 'up' : 'down', { future: c.future }]">
          <line :x1="c.x" :x2="c.x" :y1="c.hiY" :y2="c.loY" />
          <rect :x="c.x - geo.bw / 2" :y="c.top" :width="geo.bw" :height="c.h" />
        </g>
        <polyline v-if="geo.vwap" class="vwap" :points="geo.vwap" />

        <g v-for="f in geo.fills" :class="['fill-mark', f.buy ? 'buy' : 'sell', { other: !f.own, future: f.future }]">
          <path :d="f.path"><title>{{ f.title }}</title></path>
          <text v-if="f.label" class="fill-label" :x="f.lx" :y="f.ly">{{ f.label }}</text>
        </g>

        <g v-for="v in geo.vols" :class="['vol', v.up ? 'up' : 'down', { future: v.future }]"><rect :x="v.x" :y="v.y" :width="geo.bw" :height="v.h" /></g>
        <text class="axis" :x="geo.xEnd + 6" :y="volTop + 10">量</text>

        <template v-if="geo.expo">
          <line class="grid" :x1="geo.x0" :x2="geo.xEnd" :y1="geo.expo.zero" :y2="geo.expo.zero" />
          <polygon v-for="a in geo.expo.areas" :class="'expo expo-' + a.k" :points="a.points"><title>{{ a.symbol }}</title></polygon>
          <polyline class="expo-net" :points="geo.expo.net" />
          <text v-for="t in geo.expo.ticks" class="axis" :x="geo.xEnd + 6" :y="t.y + 4">{{ t.text }}</text>
        </template>
        <text v-else class="axis" :x="(geo.x0 + geo.xEnd) / 2" :y="(expTop + expBot) / 2" text-anchor="middle">當天沒有持股</text>
        <text class="axis" :x="geo.x0 + G + 4" :y="expTop + 10">等效曝險（÷ 權益）</text>

        <line v-if="geo.hoverX !== null" class="crosshair" :x1="geo.hoverX" :x2="geo.hoverX" :y1="priceTop" :y2="expBot" />
        <line v-if="geo.selX !== null" class="sel-line" :x1="geo.selX" :x2="geo.selX" :y1="0" :y2="expBot" />
        <text v-if="geo.cutLabel" class="axis" :x="geo.cutLabel.x" :y="priceTop + 12">決策後 →</text>

        <line class="grid" :x1="geo.x0" :x2="geo.xEnd" :y1="laneH - 2" :y2="laneH - 2" />
        <g v-for="d in geo.decisions" :class="['dmark', d.action, { unfilled: d.unfilled, selected: d.selected }]" @click="emit('select', d.id)">
          <circle v-if="d.selected" class="halo" :cx="d.cx" :cy="d.cy" r="11" />
          <path :d="d.path" /><title>{{ d.title }}</title>
        </g>
      </svg>
      <div class="legend">
        <span>決策：<i class="lg tri buy"></i>買入 <i class="lg tri sell"></i>賣出 <i class="lg diamond"></i>買賣 <i class="lg dot none"></i>不動作（空心：委託未成交）</span>
        <span>成交：<i class="lg tri buy"></i>買進 <i class="lg tri sell"></i>賣出</span>
        <span><i class="lg tri other"></i>其他標的（標在 {{ chart.symbol }} 同一時間）</span>
        <span><i class="lg line vwap"></i>VWAP</span>
        <span><i class="lg line sl"></i>停損</span><span><i class="lg line tp"></i>停利</span><span><i class="lg line trig"></i>價格觸發帶</span>
        <span v-for="(s, k) in chart.exposure_symbols"><i :class="'lg box expo-' + k"></i>{{ s.symbol }}{{ s.leverage !== 1 ? '（' + s.leverage + ' 倍）' : '' }}</span>
      </div>
    </div>`,
};

const ReadOnlyNote = {
  setup: () => ({ isActiveView, ACTIVE_MODE, store }),
  template: `<div v-if="!isActiveView" class="notice warn">目前檢視的是 {{ store.view.toUpperCase() }} 帳本，只能檢視。寫入操作只會作用在目前交易模式（{{ ACTIVE_MODE.toUpperCase() }}）的帳本。</div>`,
};

// ---------------------------------------------------------------- 頁面：總覽

const Overview = {
  components: { Kpi, EquityChart, DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('overview'), 15_000);
    const s = computed(() => data.value?.status);
    const cumulative = computed(() => (data.value ? data.value.status.equity - data.value.contributed : null));
    const pause = async () => {
      const reason = await askInput('暫停交易', ['暫停後 daemon 不再叫醒 Claude、不開新倉；硬停損停利與委託同步照常執行。'], {
        label: '暫停原因',
        value: '使用者手動暫停',
        okText: '暫停',
      });
      if (reason === null) return;
      await act('pause', { reason }, { success: '已暫停' });
    };
    const resume = async () => {
      const needReset = data.value?.pause?.rule === 'max_drawdown';
      await act(
        'resume',
        { resetPeak: needReset },
        {
          confirm: needReset
            ? { title: '恢復交易並重設高點', lines: ['系統因跨日累計回撤暫停。', '恢復時會以目前權益重設歷史權益高點（Dashboard 的回撤指標仍以完整歷史計算）。'] }
            : { title: '恢復交易', lines: ['恢復後 daemon 會照常叫醒 Claude。'] },
          success: '已恢復',
        },
      );
    };
    const cancelAll = () =>
      act('cancel-all', {}, {
        confirm: { title: '刪除所有未完成委託', lines: ['刪除 Claude 帳本的所有未完成委託（含停損單）並釋放圈存。', '執行後系統自動暫停，不經過 Claude。'], danger: true, okText: '刪除全部' },
        success: '已送出刪單並暫停',
      });
    const flatten = () =>
      act('flatten', {}, {
        confirm: {
          title: '全部平倉',
          lines: ['先刪除所有未完成委託，再以對手價賣出 Claude 帳本的全部持股。', '只賣出帳本內的持股，不會動到你自己的部位。', '執行後系統自動暫停，不經過 Claude。'],
          danger: true,
          okText: '全部平倉',
        },
        success: '已送出平倉委託並暫停',
      });
    return { data, error, s, cumulative, pause, resume, cancelAll, flatten, fmt, KIND, isActiveView };
  },
  template: `
    <h2>總覽</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <div v-if="data.pause.paused" class="notice bad">系統暫停中：{{ data.pause.reason }}（{{ fmt.time(data.pause.since) }}）</div>
      <div v-if="s.claude_unavailable" class="notice warn">Claude 無法使用：{{ s.claude_unavailable }}（到「系統」頁解除）</div>
      <div v-if="data.usage_warning" class="notice warn">用量已達預算 80%：{{ data.usage_warning }}</div>
      <div v-if="s.valued_at_cost.length" class="notice warn">沒有即時報價（daemon 未執行），{{ s.valued_at_cost.join('、') }} 以平均成本估值。</div>
      <div class="kpis">
        <Kpi label="總權益" :value="fmt.money(s.equity)" :sub="'持股市值 ' + fmt.money(s.market_value)" />
        <Kpi label="可用資金" :value="fmt.money(s.available)" :sub="'現金 ' + fmt.money(s.cash)" />
        <Kpi label="圈存" :value="fmt.money(s.reserved)" :sub="s.open_orders + ' 筆未完成委託'" />
        <Kpi label="今日損益" :value="fmt.signed(s.pnl_today)" :tone="fmt.cls(s.pnl_today)" :sub="s.day_start_equity ? '開盤前 ' + fmt.money(s.day_start_equity) : '尚未每日重設'" />
        <Kpi label="累計損益" :value="fmt.signed(cumulative)" :tone="fmt.cls(cumulative)" :sub="'投入本金 ' + fmt.money(data.contributed)" />
        <Kpi label="淨曝險" :value="fmt.money(s.net_exposure)" :sub="'總曝險 ' + fmt.money(s.gross_exposure)" />
        <Kpi label="今日觸發" :value="data.triggers_today.length" :sub="'委託 ' + s.orders_today + ' / ' + s.max_orders_per_day" />
      </div>
      <div class="panel">
        <div class="actions">
          <button v-if="!data.pause.paused" :disabled="!isActiveView" @click="pause">暫停交易</button>
          <button v-else class="primary" :disabled="!isActiveView" @click="resume">恢復交易</button>
          <span class="spacer"></span>
          <button class="danger" :disabled="!isActiveView" @click="cancelAll">刪除所有未完成委託</button>
          <button class="danger" :disabled="!isActiveView" @click="flatten">全部平倉</button>
        </div>
      </div>
      <div class="panel"><h3 style="margin-top:0">權益曲線</h3><EquityChart :points="data.equity_curve" /></div>
      <div class="panel">
        <h3 style="margin-top:0">今日觸發</h3>
        <DataTable :rows="data.triggers_today" empty="今天還沒有觸發" :cols="[
          { key: 'ts', label: '時間', fmt: fmt.hhmm },
          { key: 'kind', label: '類型', fmt: (v) => KIND[v] ?? v },
          { key: 'invoked_claude', label: '叫醒 Claude', fmt: (v) => v ? '是' : '否' },
          { key: 'skip_reason', label: '略過原因' },
        ]" />
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 頁面：持倉

const Positions = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('positions'), 15_000);
    const transferOut = async (p) => {
      const raw = await askInput('轉出持股', [`把 ${p.symbol} 從 Claude 帳本轉回給你，依平均成本 ${p.avg_cost} 扣除成本。`, `可轉出 ${p.sellable_qty} 股。`], {
        label: '股數',
        value: p.sellable_qty,
        type: 'number',
        required: true,
        okText: '轉出',
      });
      if (raw === null) return;
      await act('transfer-out', { symbol: p.symbol, qty: Number(raw) }, { success: '已轉出' });
    };
    return { data, error, fmt, transferOut, isActiveView };
  },
  template: `
    <h2>持倉</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="panel">
      <DataTable :rows="data" empty="Claude 帳本目前沒有持股" :cols="[
        { key: 'symbol', label: '代號', fmt: (v, r) => v + (r.name ? ' ' + r.name : '') },
        { key: 'qty', label: '股數', num: true, fmt: fmt.money },
        { key: 'sellable_qty', label: '可賣', num: true, fmt: fmt.money },
        { key: 'avg_cost', label: '平均成本', num: true },
        { key: 'last', label: '現價', num: true },
        { key: 'market_value', label: '市值', num: true, fmt: fmt.money },
        { key: 'unrealized_pnl', label: '未實現損益', num: true, fmt: fmt.signed, cls: (r) => fmt.cls(r.unrealized_pnl) },
        { key: 'stop', label: '硬停損', num: true },
        { key: 'take_profit', label: '硬停利', num: true },
        { key: 'action', label: '' },
      ]">
        <template #action="{ row }"><button class="small" :disabled="!isActiveView || !row.sellable_qty" @click="transferOut(row)">轉出給使用者</button></template>
      </DataTable>
    </div>`,
};

// ---------------------------------------------------------------- 頁面：委託與成交

const Orders = {
  components: { DataTable },
  setup() {
    const date = ref(today());
    const openOnly = ref(false);
    const { data, error, load } = useData(async () => ({
      orders: await get('orders', { date: openOnly.value ? '' : date.value, open: openOnly.value ? '1' : '' }),
      fills: await get('fills', { date: date.value }),
    }), 15_000);
    watch([date, openOnly], load);
    return { data, error, date, openOnly, fmt, STATUS, SESSION };
  },
  template: `
    <h2>委託與成交</h2>
    <div class="panel">
      <form class="inline" @submit.prevent>
        <label class="field">日期<input type="date" v-model="date" /></label>
        <label class="field"><span>&nbsp;</span><span><input type="checkbox" v-model="openOnly" /> 只看未完成委託</span></label>
      </form>
      <p class="muted" style="margin-bottom:0">個別刪單由 Claude 處理；需要一次刪除全部時，請用「總覽」的緊急操作。</p>
    </div>
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <h3>委託</h3>
      <div class="panel">
        <DataTable :rows="data.orders" :cols="[
          { key: 'id', label: '#', num: true },
          { key: 'created_at', label: '時間', fmt: fmt.time },
          { key: 'symbol', label: '代號' },
          { key: 'side', label: '買賣', fmt: (v) => v === 'buy' ? '買' : '賣', cls: (r) => r.side === 'buy' ? 'pos' : 'neg' },
          { key: 'session', label: '盤別', fmt: (v) => SESSION[v] },
          { key: 'origin', label: '來源', fmt: (v) => ({ claude: 'Claude', stop: '停損停利', emergency: '緊急' })[v] },
          { key: 'price', label: '限價', num: true },
          { key: 'qty', label: '股數', num: true, fmt: fmt.money },
          { key: 'filled_qty', label: '已成交', num: true, fmt: fmt.money },
          { key: 'status', label: '狀態', fmt: (v) => STATUS[v] ?? v },
          { key: 'reserved_amount', label: '圈存', num: true, fmt: fmt.money },
          { key: 'reject_reason', label: '說明' },
        ]" />
      </div>
      <h3>成交</h3>
      <div class="panel">
        <DataTable :rows="data.fills" :cols="[
          { key: 'ts', label: '時間', fmt: fmt.time },
          { key: 'order_id', label: '委託', num: true },
          { key: 'symbol', label: '代號' },
          { key: 'side', label: '買賣', fmt: (v) => v === 'buy' ? '買' : '賣', cls: (r) => r.side === 'buy' ? 'pos' : 'neg' },
          { key: 'price', label: '成交價', num: true },
          { key: 'qty', label: '股數', num: true, fmt: fmt.money },
          { key: 'fee', label: '手續費', num: true },
          { key: 'tax', label: '稅', num: true },
          { key: 'day_trade', label: '當沖', fmt: (v) => v ? '是' : '' },
          { key: 'settle_date', label: '交割日' },
          { key: 'simulated', label: '', fmt: (v) => v ? '模擬' : '' },
        ]" />
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 決策當下的指標快照

/** 欄位目錄只取一次，給所有決策卡片共用 */
let indicatorFields;
const loadIndicatorFields = () => (indicatorFields ??= get('indicators/fields').then((d) => d.fields).catch(() => (indicatorFields = undefined, [])));

/** 把快照攤平成「路徑 → 值」，均線週期的路徑對應到目錄的 <n> */
function flattenSnapshot(obj, prefix = '') {
  return Object.entries(obj ?? {}).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? flattenSnapshot(v, path) : [{ path, value: v }];
  });
}

const IndicatorSnapshot = {
  props: { snapshot: Object, error: String },
  setup(props) {
    const open = ref(false);
    const fields = ref([]);
    const num = (v, d = 2) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));
    const s = computed(() => props.snapshot);
    const smaPeriods = computed(() => Object.keys(s.value?.daily?.sma ?? {}).sort((a, b) => a - b));
    // 策略會用到的關鍵值（trading-strategy skill「指標」一節）
    const vwapText = computed(() => {
      const i = s.value?.intraday;
      if (!i || i.vwap === null) return null;
      const b = i.below_vwap_pct;
      return { vwap: num(i.vwap, 2), dev: b === null ? '' : b >= 0 ? `低於 ${num(b, 2)}%` : `高於 ${num(-b, 2)}%`, below: b };
    });
    const lastBar = computed(() => s.value?.intraday?.last_bar ?? null);
    const toggle = async () => {
      open.value = !open.value;
      if (open.value && !fields.value.length) fields.value = await loadIndicatorFields();
    };
    const rows = computed(() => {
      const byPath = new Map(fields.value.map((f) => [f.path, f]));
      return flattenSnapshot(s.value).map((r) => {
        const f = byPath.get(r.path.replace(/\.sma\.\d+\./, '.sma.<n>.'));
        return { ...r, unit: f?.unit ?? '', description: f?.description ?? '' };
      });
    });
    const show = (v) => (v === null || v === undefined ? '-' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
    return { open, toggle, rows, show, num, s, smaPeriods, vwapText, lastBar, hhmm };
  },
  template: `
    <div class="snapshot" v-if="snapshot">
      <div class="kv">
        <span><b>{{ s.symbol }}</b> {{ num(s.last_price) }} <span class="muted">@{{ hhmm(s.as_of) }}</span></span>
        <span v-if="vwapText">VWAP {{ vwapText.vwap }} <span :class="vwapText.below >= 0.5 ? 'hit' : 'muted'">{{ vwapText.dev }}</span></span>
        <span v-else class="muted">VWAP -（盤中資料未就緒）</span>
        <span v-if="lastBar">5 分 K {{ hhmm(lastBar.start) }} 量比 <span :class="lastBar.volume_vs_avg >= 1 ? 'hit' : ''">{{ num(lastBar.volume_vs_avg) }}</span> 倍<template v-if="lastBar.close_above_prev_close !== null">・收盤{{ lastBar.close_above_prev_close ? '高於' : '低於' }}前一根</template></span>
        <span v-for="n in smaPeriods" :key="n">MA{{ n }} {{ num(s.daily.sma[n].value) }} <span class="muted">今 {{ num(s.daily.sma[n].including_today) }}</span></span>
        <span v-if="s.intraday?.today_vs_avg20 !== null && s.intraday?.today_vs_avg20 !== undefined">今日量 {{ num(s.intraday.today_vs_avg20) }} 倍 20 日均</span>
        <span v-if="s.daily?.rsi14 !== null">RSI14 {{ num(s.daily.rsi14, 1) }}</span>
        <button class="small" @click="toggle">{{ open ? '收起指標快照' : '完整指標快照' }}</button>
      </div>
      <table class="snapshot-table" v-if="open">
        <tr v-for="r in rows" :key="r.path"><td class="mono">{{ r.path }}</td><td class="num mono">{{ show(r.value) }}</td><td class="muted">{{ r.unit }}</td><td class="muted">{{ r.description }}</td></tr>
      </table>
    </div>
    <div class="muted snapshot-missing" v-else-if="error">沒有指標快照：{{ error }}</div>`,
};

// ---------------------------------------------------------------- 頁面：決策日誌

const Decisions = {
  components: { DayChart, IndicatorSnapshot },
  setup() {
    const date = ref('');
    const kind = ref('');
    const q = ref('');
    const { data, error, load } = useData(() => get('decisions', { date: date.value, kind: kind.value, q: q.value }));

    // 盤勢圖：顯示篩選的日期；沒有篩選日期時顯示最新一筆決策的日期，點選其他日期的決策會切換過去
    const chart = ref(null);
    const chartError = ref(null);
    const chartDate = ref('');
    const chartSymbol = ref('');
    const selectedId = ref(null);
    const chartPanel = ref(null);
    const loadChart = async () => {
      if (!chartDate.value) return;
      try {
        chart.value = await get('chart/day', { date: chartDate.value, symbol: chartSymbol.value });
        chartError.value = null;
      } catch (e) {
        chart.value = null;
        chartError.value = e.message;
      }
    };
    watch(data, (rows) => {
      const d = date.value || rows?.[0]?.ts.slice(0, 10) || today();
      if (d !== chartDate.value) chartDate.value = d;
      else loadChart();
    });
    watch([chartDate, chartSymbol], loadChart);
    const shiftDay = (n) => {
      const d = new Date(`${chartDate.value}T00:00:00Z`);
      do d.setUTCDate(d.getUTCDate() + n);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
      const next = d.toISOString().slice(0, 10);
      if (next <= today()) chartDate.value = next;
    };
    const selectFromChart = (id) => {
      selectedId.value = selectedId.value === id ? null : id;
      document.getElementById(`decision-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const showOnChart = (d) => {
      selectedId.value = d.id;
      chartDate.value = d.ts.slice(0, 10);
      chartPanel.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const sessions = reactive({});
    const toggle = async (d) => {
      if (sessions[d.trigger_event_id]) {
        delete sessions[d.trigger_event_id];
        return;
      }
      try {
        sessions[d.trigger_event_id] = (await get(`sessions/${d.trigger_event_id}`)).steps;
      } catch (e) {
        toast(e.message, true);
      }
    };
    return {
      data, error, load, date, kind, q, KIND, DECISION_ACTION, fmt, sessions, toggle,
      chart, chartError, chartDate, chartSymbol, selectedId, chartPanel, shiftDay, selectFromChart, showOnChart, today,
    };
  },
  template: `
    <h2>決策日誌</h2>
    <div class="panel">
      <form class="inline" @submit.prevent="load">
        <label class="field">日期<input type="date" v-model="date" /></label>
        <label class="field">觸發類型
          <select v-model="kind"><option value="">全部</option><option v-for="(v, k) in KIND" :value="k">{{ v }}</option></select>
        </label>
        <label class="field">搜尋理由或動作<input v-model="q" placeholder="關鍵字" /></label>
        <button class="primary" type="submit">篩選</button>
      </form>
    </div>
    <div class="panel" ref="chartPanel" v-if="chartDate">
      <div class="chart-head">
        <h3>盤勢圖</h3>
        <button class="small" @click="shiftDay(-1)">‹ 前一天</button>
        <strong class="mono">{{ chartDate }}</strong>
        <button class="small" @click="shiftDay(1)" :disabled="chartDate >= today()">後一天 ›</button>
        <label class="field inline-field">基準標的
          <select :value="chartSymbol || chart?.symbol" @change="chartSymbol = $event.target.value">
            <option v-for="s in chart?.symbols ?? []" :value="s.symbol">{{ s.symbol }} {{ s.name }}</option>
          </select>
        </label>
        <span class="spacer"></span>
        <span class="muted" v-if="chart?.bars_source === 'cache'">K 線來自快取</span>
      </div>
      <div v-if="chartError" class="notice bad">{{ chartError }}</div>
      <div v-if="chart?.bars_error" class="notice warn">取不到 K 線（{{ chart.bars_error }}），只顯示當天的決策與成交。</div>
      <DayChart v-if="chart" :chart="chart" :selected-id="selectedId" @select="selectFromChart" />
      <div class="muted small-note">點選上方的決策點可對應到下方的決策；選取後，之後的 K 棒會淡化。等效曝險為市值 × 槓桿倍數 ÷ 權益，槓桿與反向 ETF 每日重新平衡，只是近似值。</div>
    </div>
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="panel" v-if="data">
      <div v-if="!data.length" class="empty">沒有符合的決策記錄</div>
      <div v-for="d in data" :key="d.id" class="decision" :id="'decision-' + d.id" :class="{ selected: selectedId === d.id }">
        <div class="head">
          <strong>{{ fmt.time(d.ts) }}</strong>
          <span class="tag">{{ KIND[d.kind] ?? d.kind ?? '手動' }}</span>
          <span v-if="d.action" :class="['tag', 'act-' + d.action]">{{ DECISION_ACTION[d.action] }}{{ d.action !== 'none' && !d.filled ? '（未成交）' : '' }}</span>
          <span class="muted" v-if="d.trigger_detail?.reason">{{ d.trigger_detail.reason }}</span>
          <span class="spacer"></span>
          <span class="muted mono" v-if="d.strategy_version">策略 {{ d.strategy_version.slice(0, 7) }}</span>
          <span class="muted mono" v-if="d.model">{{ d.model }}</span>
        </div>
        <div><strong>動作：</strong>{{ d.actions }}</div>
        <IndicatorSnapshot :snapshot="d.indicators" :error="d.indicators_error" />
        <div class="pre">{{ d.reasoning }}</div>
        <div class="muted" v-if="d.next_trigger">下一輪觸發：定時 {{ d.next_trigger.interval_min ?? '關' }} 分、漲 {{ d.next_trigger.up_pct ?? '關' }}%、跌 {{ d.next_trigger.down_pct ?? '關' }}%</div>
        <button class="small" @click="showOnChart(d)">在盤勢圖標示</button>
        <button v-if="d.has_log" class="small" @click="toggle(d)">{{ sessions[d.trigger_event_id] ? '收起完整過程' : '查看完整過程' }}</button>
        <div class="steps" v-if="sessions[d.trigger_event_id]">
          <div v-for="(s, i) in sessions[d.trigger_event_id]" :key="i" class="step pre" :class="s.type">{{ s.text }}</div>
        </div>
      </div>
    </div>`,
};

// ---------------------------------------------------------------- 頁面：資金管理

const Funds = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('ledger'));
    const meta = useData(() => get('meta')).data;
    const alloc = reactive({ amount: '', note: '' });
    const wd = reactive({ amount: '', note: '' });
    const tin = reactive({ symbol: '0050', qty: '', cost: '', note: '' });
    const tout = reactive({ symbol: '0050', qty: '', note: '' });
    const doAllocate = () =>
      act('allocate', { amount: Number(alloc.amount), note: alloc.note || undefined }, {
        confirm: { title: '撥入資金', lines: [`撥入 ${money(Number(alloc.amount))} 元給 Claude。`, '請確認券商帳戶有足夠的對應金額（規格第 1 節）。'] },
        success: '已撥入',
      }).then((r) => r && Object.assign(alloc, { amount: '', note: '' }));
    const doWithdraw = () =>
      act('withdraw', { amount: Number(wd.amount), note: wd.note || undefined }, {
        confirm: { title: '撥出資金', lines: [`從 Claude 帳本撥出 ${money(Number(wd.amount))} 元，不可超過可用資金。`] },
        success: '已撥出',
      }).then((r) => r && Object.assign(wd, { amount: '', note: '' }));
    const doTransferIn = () =>
      act('transfer-in', { symbol: tin.symbol, qty: Number(tin.qty), cost: tin.cost || undefined, note: tin.note || undefined }, {
        confirm: {
          title: '轉入持股',
          lines: [`把你的 ${tin.symbol} ${tin.qty} 股轉入 Claude 帳本，成本 ${tin.cost || '以前一交易日收盤價計'}。`, 'live 模式會先向券商確認你的實際持股足夠。'],
        },
        success: '已轉入',
      }).then((r) => r && Object.assign(tin, { qty: '', cost: '', note: '' }));
    const doTransferOut = () =>
      act('transfer-out', { symbol: tout.symbol, qty: Number(tout.qty), note: tout.note || undefined }, {
        confirm: { title: '轉出持股', lines: [`把 Claude 帳本的 ${tout.symbol} ${tout.qty} 股轉回給你。`] },
        success: '已轉出',
      }).then((r) => r && Object.assign(tout, { qty: '', note: '' }));
    return { data, error, meta, alloc, wd, tin, tout, doAllocate, doWithdraw, doTransferIn, doTransferOut, fmt, CASH_TYPE, POS_TYPE, isActiveView };
  },
  template: `
    <h2>資金管理</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="kpis" v-if="data">
      <div class="kpi"><div class="label">現金</div><div class="value">{{ fmt.money(data.balance.cash) }}</div></div>
      <div class="kpi"><div class="label">圈存</div><div class="value">{{ fmt.money(data.balance.reserved) }}</div></div>
      <div class="kpi"><div class="label">可用資金</div><div class="value">{{ fmt.money(data.balance.available) }}</div></div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0">撥入資金</h3>
      <form class="inline" @submit.prevent="doAllocate">
        <label class="field">金額（元）<input type="number" min="1" step="1" required v-model="alloc.amount" /></label>
        <label class="field">備註<input v-model="alloc.note" /></label>
        <button class="primary" :disabled="!isActiveView">撥入</button>
      </form>
      <h3>撥出資金</h3>
      <form class="inline" @submit.prevent="doWithdraw">
        <label class="field">金額（元）<input type="number" min="1" step="1" required v-model="wd.amount" /></label>
        <label class="field">備註<input v-model="wd.note" /></label>
        <button :disabled="!isActiveView">撥出</button>
      </form>
      <h3>轉入持股</h3>
      <form class="inline" @submit.prevent="doTransferIn">
        <label class="field">代號<input v-model="tin.symbol" required style="width:90px" /></label>
        <label class="field">股數<input type="number" min="1" step="1" required v-model="tin.qty" /></label>
        <label class="field">每股成本（空白＝前一交易日收盤價）<input v-model="tin.cost" placeholder="例如 108.50" style="width:140px" /></label>
        <label class="field">備註<input v-model="tin.note" /></label>
        <button :disabled="!isActiveView">轉入</button>
      </form>
      <h3>轉出持股</h3>
      <form class="inline" @submit.prevent="doTransferOut">
        <label class="field">代號<input v-model="tout.symbol" required style="width:90px" /></label>
        <label class="field">股數<input type="number" min="1" step="1" required v-model="tout.qty" /></label>
        <label class="field">備註<input v-model="tout.note" /></label>
        <button :disabled="!isActiveView">轉出</button>
      </form>
    </div>
    <template v-if="data">
      <h3>資金流水</h3>
      <div class="panel">
        <DataTable :rows="data.cash" :cols="[
          { key: 'id', label: '#', num: true },
          { key: 'ts', label: '時間', fmt: fmt.time },
          { key: 'type', label: '類型', fmt: (v) => CASH_TYPE[v] ?? v },
          { key: 'amount', label: '金額', num: true, fmt: fmt.signed, cls: (r) => fmt.cls(r.amount) },
          { key: 'actor', label: '來源' },
          { key: 'order_id', label: '委託', num: true },
          { key: 'note', label: '備註' },
        ]" />
      </div>
      <h3>持股流水</h3>
      <div class="panel">
        <DataTable :rows="data.positions" :cols="[
          { key: 'id', label: '#', num: true },
          { key: 'ts', label: '時間', fmt: fmt.time },
          { key: 'symbol', label: '代號' },
          { key: 'type', label: '類型', fmt: (v) => POS_TYPE[v] ?? v },
          { key: 'qty', label: '股數', num: true, fmt: fmt.signed },
          { key: 'cost', label: '成本變動', num: true, fmt: fmt.signed },
          { key: 'actor', label: '來源' },
          { key: 'note', label: '備註' },
        ]" />
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 頁面：風控

const RISK_LABELS = {
  max_order_amount: ['單筆委託金額上限', '元'],
  max_position_pct: ['單一持股占權益上限', '%'],
  max_exposure_pct: ['總曝險占權益上限', '%'],
  allow_opposite_positions: ['允許同時持有正反向標的', ''],
  max_orders_per_day: ['每日委託次數上限', '次'],
  max_orders_per_minute: ['每分鐘新單與刪單上限', '次'],
  max_round_trips_per_day: ['同標的每日買賣回合上限', '次'],
  reentry_cooldown_min: ['賣出後再買進冷卻', '分鐘'],
  daily_loss_limit_pct: ['當日虧損停機門檻', '%'],
  intraday_drawdown_pct: ['當日盤中回撤停機門檻', '%'],
  max_drawdown_pct: ['跨日累計回撤停機門檻', '%'],
  max_api_failures: ['API 連續失敗停機門檻', '次'],
  max_broker_rejects: ['連續被拒單停機門檻', '次'],
  symbols_allowlist: ['允許交易的代號（逗號分隔）', ''],
  trigger_interval_min_range: ['定時觸發允許範圍（下限,上限）', '分鐘'],
  trigger_up_pct_range: ['漲幅觸發允許範圍', '%'],
  trigger_down_pct_range: ['跌幅觸發允許範圍', '%'],
};

const Risk = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('risk'));
    const form = reactive({});
    watch(data, (d) => {
      if (!d) return;
      for (const [k, v] of Object.entries(d.params)) form[k] = Array.isArray(v) ? v.join(',') : v;
    });
    const parse = (k, v) => {
      const cur = data.value.params[k];
      if (typeof cur === 'boolean') return v === true || v === 'true';
      if (k === 'symbols_allowlist') return String(v).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (Array.isArray(cur)) return String(v).split(',').map(Number);
      return Number(v);
    };
    const changes = computed(() => {
      if (!data.value) return {};
      const out = {};
      for (const k of Object.keys(data.value.params)) {
        const next = parse(k, form[k]);
        if (JSON.stringify(next) !== JSON.stringify(data.value.params[k])) out[k] = next;
      }
      return out;
    });
    const save = () =>
      act('risk', { patch: changes.value }, {
        confirm: {
          title: '修改風控參數',
          lines: Object.entries(changes.value).map(([k, v]) => `${RISK_LABELS[k]?.[0] ?? k}：${JSON.stringify(data.value.params[k])} → ${JSON.stringify(v)}`),
        },
        success: '風控參數已更新',
      });
    return { data, error, form, changes, save, RISK_LABELS, fmt, isActiveView };
  },
  template: `
    <h2>風控</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="panel" v-if="data">
      <form @submit.prevent="save">
        <div class="grid-form">
          <label v-for="(v, k) in data.params" :key="k" class="field" :class="{ changed: k in changes }">
            {{ RISK_LABELS[k]?.[0] ?? k }}{{ RISK_LABELS[k]?.[1] ? '（' + RISK_LABELS[k][1] + '）' : '' }}
            <select v-if="typeof v === 'boolean'" v-model="form[k]"><option :value="true">是</option><option :value="false">否</option></select>
            <input v-else v-model="form[k]" />
          </label>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="primary" :disabled="!isActiveView || !Object.keys(changes).length">儲存修改（{{ Object.keys(changes).length }} 項）</button>
          <span class="muted">每次修改都會新增一個版本，並寫入稽核記錄。</span>
        </div>
      </form>
    </div>
    <h3>風控事件</h3>
    <div class="panel" v-if="data">
      <DataTable :rows="data.events" :cols="[
        { key: 'ts', label: '時間', fmt: fmt.time },
        { key: 'rule', label: '規則' },
        { key: 'action', label: '動作' },
        { key: 'detail', label: '內容', mono: true, fmt: (v) => v ? JSON.stringify(v) : '' },
      ]" />
    </div>`,
};

// ---------------------------------------------------------------- 頁面：費率與市場規則

const Fees = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('fees'));
    const form = reactive({ effective: today(), fee_rate_pct: '', fee_discount: '', rebate_mode: '', min_fee_regular: '', min_fee_odd: '', tax_etf_pct: '', tax_stock_pct: '', tax_daytrade_pct: '' });
    const submit = () => {
      const body = { effective: form.effective };
      for (const [k, v] of Object.entries(form)) {
        if (k === 'effective' || v === '') continue;
        body[k] = k === 'rebate_mode' ? v : Number(v);
      }
      return act('fees', body, {
        confirm: { title: '新增費率版本', lines: [`生效日 ${form.effective}`, ...Object.entries(body).filter(([k]) => k !== 'effective').map(([k, v]) => `${k}：${v}`), '未填的欄位沿用生效日當時的版本。'] },
        success: '已新增費率版本',
      });
    };
    return { data, error, form, submit, isActiveView };
  },
  template: `
    <h2>費率與市場規則</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <div class="panel">
        <h3 style="margin-top:0">費率版本</h3>
        <DataTable :rows="data.schedules" :cols="[
          { key: 'effective_date', label: '生效日', fmt: (v, r) => v + (r.id === data.current_id ? '（目前）' : '') },
          { key: 'fee_rate_pct', label: '手續費率 %', num: true },
          { key: 'fee_discount', label: '折扣', num: true },
          { key: 'rebate_mode', label: '折讓', fmt: (v) => v === 'monthly' ? '月退' : '即時' },
          { key: 'min_fee_regular', label: '整股最低', num: true },
          { key: 'min_fee_odd', label: '零股最低', num: true },
          { key: 'tax_etf_pct', label: 'ETF 稅 %', num: true },
          { key: 'tax_stock_pct', label: '股票稅 %', num: true },
          { key: 'tax_daytrade_pct', label: '當沖稅 %', num: true },
          { key: 'created_by', label: '建立' },
        ]" />
      </div>
      <div class="panel">
        <h3 style="margin-top:0">新增費率版本</h3>
        <p class="muted">玉山手續費 = 價金 × 千分之 1.425 × 折扣。舊的成交保留當時的費率，生效日不可早於今天。</p>
        <form class="grid-form" @submit.prevent="submit">
          <label class="field">生效日<input type="date" v-model="form.effective" required /></label>
          <label class="field">手續費率（%）<input v-model="form.fee_rate_pct" placeholder="0.1425" /></label>
          <label class="field">折扣（6 折填 0.6）<input v-model="form.fee_discount" placeholder="沿用" /></label>
          <label class="field">折讓方式<select v-model="form.rebate_mode"><option value="">沿用</option><option value="instant">即時折讓</option><option value="monthly">月退</option></select></label>
          <label class="field">整股最低手續費<input v-model="form.min_fee_regular" placeholder="沿用" /></label>
          <label class="field">零股最低手續費<input v-model="form.min_fee_odd" placeholder="沿用" /></label>
          <label class="field">ETF 證交稅（%）<input v-model="form.tax_etf_pct" placeholder="沿用" /></label>
          <label class="field">股票證交稅（%）<input v-model="form.tax_stock_pct" placeholder="沿用" /></label>
          <label class="field">當沖證交稅（%）<input v-model="form.tax_daytrade_pct" placeholder="沿用" /></label>
          <div class="actions"><button class="primary" :disabled="!isActiveView">新增版本</button></div>
        </form>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">目前的市場規則</h3>
        <div class="pre mono">{{ JSON.stringify({ 交易時段: data.market_rules.sessions, 逐筆時段: data.market_rules.continuous, 漲跌幅: data.market_rules.price_limit_pct + '%', 升降單位: data.market_rules.tick_sizes, 固定觸發: data.market_rules.fixed_triggers }, null, 2) }}</div>
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 頁面：策略

const Strategy = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('strategy'));
    let saved = null;
    try {
      saved = localStorage.getItem('ctrade-strategy-tab');
    } catch {}
    const tab = ref(saved ?? 'SKILL.md');
    watch(tab, (v) => {
      try {
        localStorage.setItem('ctrade-strategy-tab', v);
      } catch {}
    });
    const tabs = computed(() => [
      ...(data.value?.files ?? []).map((f) => ({ key: f.name, label: f.name === 'SKILL.md' ? '策略內容' : f.name === 'reference.md' ? '設計與回測紀錄' : f.name })),
      { key: 'indicators', label: '可用指標' },
      { key: 'versions', label: '版本與績效' },
    ]);
    const currentTab = computed(() => (tabs.value.some((t) => t.key === tab.value) ? tab.value : tabs.value[0]?.key));
    const file = computed(() => data.value?.files?.find((f) => f.name === currentTab.value));
    const html = computed(() => (file.value ? renderMarkdown(file.value.content) : ''));
    const indicatorRows = computed(() => {
      const used = new Set((data.value?.refs?.refs ?? []).map((r) => r.field).filter(Boolean));
      return (data.value?.indicators.fields ?? []).map((f) => ({ ...f, used: used.has(f.path) ? '✓' : '' }));
    });
    const diffLines = computed(() =>
      (data.value?.diff ?? '').split('\n').map((text) => ({ text, cls: /^\+(?!\+\+)/.test(text) ? 'add' : /^-(?!--)/.test(text) ? 'del' : /^@@/.test(text) ? 'hunk' : '' })),
    );
    const activate = async () => {
      const note = await askInput('啟用目前 commit 的策略', ['把最後一次修改 trading-strategy skill 的 commit 記錄為生效版本。', '策略檔有未 commit 的修改時會被拒絕。'], {
        label: '備註（例如核准原因）',
        okText: '啟用',
      });
      if (note === null) return;
      await act('strategy-activate', { note: note || undefined }, { success: '已記錄策略版本' });
    };
    return { data, error, activate, fmt, isActiveView, tab, tabs, currentTab, file, html, indicatorRows, diffLines };
  },
  template: `
    <h2>策略</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <div class="panel">
        <div class="actions">
          <div>
            <strong>生效版本：</strong>
            <span class="mono">{{ data.current?.version?.slice(0, 12) ?? '尚未記錄' }}</span>
            <span v-if="data.current?.subject" style="margin-left:8px">{{ data.current.subject }}</span>
            <div class="muted" v-if="data.current">啟用於 {{ fmt.time(data.current.activated_at) }}<span v-if="data.current.note">　{{ data.current.note }}</span></div>
          </div>
          <span class="spacer"></span>
          <button :disabled="!isActiveView" @click="activate">啟用目前 commit 的策略</button>
        </div>
      </div>

      <div v-if="data.files_match.ok" class="notice ok">專案目錄的策略檔與生效版本一致，Claude 讀到的就是下面的內容。</div>
      <div v-else class="notice bad">
        <strong>專案目錄的策略檔與生效版本不一致：daemon 不會叫醒 Claude 做盤中決策（硬停損停利照常）。</strong>
        <div>{{ data.files_match.reason }}</div>
        <div class="muted">處理方式：確認修改無誤後 commit，再按「啟用目前 commit 的策略」；或把策略檔還原成生效版本。</div>
        <details v-if="data.diff" style="margin-top:8px">
          <summary>工作目錄相對生效版本的差異</summary>
          <div class="diff mono"><div v-for="(l, i) in diffLines" :key="i" :class="l.cls">{{ l.text || ' ' }}</div></div>
        </details>
      </div>
      <div v-if="data.content_error" class="notice bad">無法從 git 取出生效版本的內容：{{ data.content_error }}</div>

      <div class="tabs">
        <button v-for="t in tabs" :key="t.key" :class="{ active: currentTab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>

      <div v-if="file" class="panel md">
        <div class="muted mono" style="margin-bottom:8px">{{ file.path }} @ {{ data.current.version.slice(0, 12) }}</div>
        <div v-html="html"></div>
      </div>

      <template v-else-if="currentTab === 'indicators'">
        <div class="panel">
          <p style="margin-top:0">Claude 以 <code>ctrade indicators &lt;代號&gt;</code> 取得這些欄位（<code>ctrade indicators --list</code> 列出同一份清單）。計算與回測共用 <code>core/indicators.ts</code>。</p>
          <ul><li v-for="n in data.indicators.notes" :key="n">{{ n }}</li></ul>
          <template v-if="data.refs">
            <div v-if="data.refs.ok" class="notice ok">策略引用的 {{ data.refs.refs.length }} 個欄位都存在；用到的均線週期 {{ data.refs.sma_periods.join('、') || '（無）' }} 都有計算。</div>
            <div v-else class="notice bad">
              <div v-if="data.refs.unknown.length">策略引用了不存在的欄位：<code v-for="u in data.refs.unknown" :key="u" style="margin-right:6px">{{ u }}</code></div>
              <div v-if="data.refs.missing_periods.length">策略用到均線週期 {{ data.refs.missing_periods.join('、') }}，但沒有以 --sma 要求計算（目前 {{ data.refs.requested_periods.join('、') }}）。</div>
            </div>
          </template>
        </div>
        <div class="panel">
          <DataTable :rows="indicatorRows" :cols="[
            { key: 'path', label: '欄位', mono: true },
            { key: 'unit', label: '單位' },
            { key: 'description', label: '定義' },
            { key: 'used', label: '策略引用' },
          ]" />
        </div>
      </template>

      <template v-else-if="currentTab === 'versions'">
        <h3>版本歷史</h3>
        <div class="panel">
          <DataTable :rows="data.versions" :cols="[
            { key: 'version', label: '版本', mono: true, fmt: (v) => v.slice(0, 12) },
            { key: 'subject', label: 'commit' },
            { key: 'activated_at', label: '啟用時間', fmt: fmt.time },
            { key: 'note', label: '備註' },
          ]" />
        </div>
        <h3>各版本績效</h3>
        <div class="panel">
          <DataTable :rows="data.performance" empty="還沒有委託" :cols="[
            { key: 'version', label: '版本', mono: true, fmt: (v) => v ? v.slice(0, 12) : '（未記錄版本）' },
            { key: 'orders', label: '委託', num: true },
            { key: 'fills', label: '成交', num: true },
            { key: 'realized_pnl', label: '已實現損益', num: true, fmt: fmt.signed, cls: (r) => fmt.cls(r.realized_pnl) },
            { key: 'fees_tax', label: '手續費與稅', num: true, fmt: fmt.money },
          ]" />
        </div>
        <h3>策略修改提案</h3>
        <div class="panel">
          <DataTable :rows="data.proposals" empty="沒有提案。提案審核與合併流程在第 6 階段實作。" :cols="[
            { key: 'date', label: '日期' },
            { key: 'proposal_branch', label: '分支', mono: true },
            { key: 'status', label: '狀態' },
            { key: 'reject_reason', label: '駁回原因' },
          ]" />
        </div>
      </template>
    </template>`,
};

// ---------------------------------------------------------------- 頁面：復盤

const Reviews = {
  setup() {
    const { data, error } = useData(() => get('reviews'));
    const open = reactive({});
    return { data, error, open };
  },
  template: `
    <h2>復盤</h2>
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="panel" v-if="data">
      <div v-if="!data.length" class="empty">還沒有復盤筆記（每個交易日 14:35 由 Claude 撰寫）</div>
      <div v-for="r in data" :key="r.date" class="decision">
        <div class="head">
          <strong>{{ r.date }}</strong><span class="tag">{{ r.status }}</span>
          <span class="mono muted" v-if="r.proposal_branch">{{ r.proposal_branch }}</span>
          <span class="spacer"></span>
          <button class="small" @click="open[r.date] = !open[r.date]">{{ open[r.date] ? '收起' : '展開' }}</button>
        </div>
        <div class="pre" v-if="open[r.date]">{{ r.observations }}</div>
        <div class="muted" v-else>{{ r.observations.slice(0, 160) }}{{ r.observations.length > 160 ? '…' : '' }}</div>
      </div>
    </div>`,
};

// ---------------------------------------------------------------- 頁面：用量

const Usage = {
  components: { DataTable, BarChart, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('usage'));
    const form = reactive({ daily: '', weekly: '' });
    watch(data, (d) => d && Object.assign(form, { daily: d.budget.daily_budget_tokens, weekly: d.budget.weekly_budget_tokens }));
    const daily = computed(() => (data.value?.daily ?? []).map((d) => ({ ...d, tokens: d.input_tokens + d.output_tokens })));
    const save = () =>
      act('usage-budget', { daily_budget_tokens: Number(form.daily), weekly_budget_tokens: Number(form.weekly) }, {
        confirm: { title: '設定用量預算', lines: [`每日 ${money(Number(form.daily))} tokens、每週 ${money(Number(form.weekly))} tokens。`, '達 80% 時警示，達 100% 時停止叫醒 Claude（硬停損停利照常）。'] },
        success: '已更新預算',
      });
    return { data, error, form, daily, save, fmt, KIND, isActiveView };
  },
  template: `
    <h2>用量</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <div v-if="data.warning" class="notice warn">已達預算 80%：{{ data.warning }}</div>
      <div class="panel">
        <h3 style="margin-top:0">自訂預算</h3>
        <p class="muted">方案的剩餘額度無法由程式穩定讀取，所以以自訂預算控管（只計輸入與輸出 tokens，不含快取讀取）。</p>
        <form class="inline" @submit.prevent="save">
          <label class="field">每日預算（tokens）<input type="number" min="1" v-model="form.daily" /></label>
          <label class="field">每週預算（tokens）<input type="number" min="1" v-model="form.weekly" /></label>
          <button class="primary" :disabled="!isActiveView">儲存</button>
        </form>
      </div>
      <div class="panel"><h3 style="margin-top:0">每日 tokens（輸入＋輸出）</h3><BarChart :items="daily" value-key="tokens" label-key="date" /></div>
      <h3>每日</h3>
      <div class="panel">
        <DataTable :rows="daily" :cols="[
          { key: 'date', label: '日期' },
          { key: 'calls', label: '呼叫', num: true },
          { key: 'input_tokens', label: '輸入', num: true, fmt: fmt.money },
          { key: 'output_tokens', label: '輸出', num: true, fmt: fmt.money },
          { key: 'cache_read_tokens', label: '快取讀取', num: true, fmt: fmt.money },
          { key: 'cost_usd', label: '估計 USD', num: true },
          { key: 'failures', label: '失敗', num: true },
        ]" />
      </div>
      <h3>近 30 日依觸發類型與模型</h3>
      <div class="panel">
        <DataTable :rows="data.by_kind" :cols="[
          { key: 'kind', label: '觸發', fmt: (v) => KIND[v] ?? v },
          { key: 'model', label: '模型', mono: true },
          { key: 'calls', label: '呼叫', num: true },
          { key: 'input_tokens', label: '輸入', num: true, fmt: fmt.money },
          { key: 'output_tokens', label: '輸出', num: true, fmt: fmt.money },
          { key: 'avg_seconds', label: '平均秒數', num: true },
        ]" />
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 頁面：對帳

const Reconcile = {
  components: { ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('reconcile'));
    const run = () => act('reconcile', {}, { success: '對帳完成' });
    const resolve = async (r) => {
      const note = await askInput('標記差異已處理', ['標記處理不會自動恢復交易，請確認差異已排除後再到總覽恢復。'], {
        label: '處理說明',
        required: true,
        okText: '標記已處理',
      });
      if (!note) return;
      await act('reconcile-resolve', { id: r.id, note }, { success: '已標記處理' });
    };
    return { data, error, run, resolve, fmt, isActiveView };
  },
  template: `
    <h2>對帳</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <div class="panel">
      <div class="actions">
        <button class="primary" :disabled="!isActiveView" @click="run">手動對帳</button>
        <span class="muted">每天收盤後自動執行。出現差異時系統自動暫停；標記處理不會自動恢復交易。</span>
      </div>
    </div>
    <div class="panel" v-if="data">
      <div v-if="!data.length" class="empty">還沒有對帳紀錄</div>
      <div v-for="r in data" :key="r.id" class="decision">
        <div class="head">
          <strong>{{ fmt.time(r.ts) }}</strong>
          <span class="tag" :class="r.status === 'ok' ? 'ok' : r.status === 'error' ? 'bad' : 'warn'">{{ r.status }}</span>
          <span v-if="r.resolved_at" class="muted">已處理（{{ fmt.time(r.resolved_at) }}）：{{ r.resolved_note }}</span>
          <span class="spacer"></span>
          <button v-if="r.status !== 'ok' && !r.resolved_at" class="small" :disabled="!isActiveView" @click="resolve(r)">標記已處理</button>
        </div>
        <div v-if="r.diffs?.length" class="pre mono">{{ JSON.stringify(r.diffs, null, 2) }}</div>
      </div>
    </div>`,
};

// ---------------------------------------------------------------- 頁面：系統

const System = {
  components: { DataTable, ReadOnlyNote },
  setup() {
    const { data, error } = useData(() => get('system'), 15_000);
    const hol = reactive({ date: '', reason: '' });
    const addHoliday = () =>
      act('holiday', { date: hol.date, reason: hol.reason || undefined }, {
        confirm: { title: '標記臨時休市', lines: [`${hol.date} 標記為休市（${hol.reason || '未填原因'}），當天不會觸發也不能下單。`] },
        success: '已標記休市',
      });
    const resetClaude = () =>
      act('claude-reset', {}, { confirm: { title: '解除 Claude 無法使用', lines: ['恢復叫醒 Claude。若原因仍存在（例如額度用盡），下次呼叫會再次失敗。'] }, success: '已解除' });
    return { data, error, hol, addHoliday, resetClaude, fmt, isActiveView };
  },
  template: `
    <h2>系統</h2>
    <ReadOnlyNote />
    <div v-if="error" class="notice bad">{{ error }}</div>
    <template v-if="data">
      <div class="kpis">
        <div class="kpi"><div class="label">daemon</div><div class="value">{{ data.daemon.running ? '執行中' : '未執行' }}</div><div class="sub">{{ data.daemon.running ? 'feed ' + data.daemon.feed + '、broker ' + data.daemon.broker + '、Claude ' + data.daemon.claude : '' }}</div></div>
        <div class="kpi"><div class="label">心跳</div><div class="value">{{ fmt.ago(data.heartbeat) }}</div><div class="sub">{{ fmt.time(data.heartbeat) }}</div></div>
        <div class="kpi"><div class="label">上次 Claude 工作階段結束</div><div class="value">{{ fmt.ago(data.last_claude_end) }}</div></div>
      </div>
      <div class="panel">
        <div class="actions">
          <div v-if="data.claude_unavailable"><strong>Claude 無法使用：</strong>{{ data.claude_unavailable }}</div>
          <div v-else>Claude 可正常叫醒</div>
          <span class="spacer"></span>
          <button :disabled="!isActiveView || !data.claude_unavailable" @click="resetClaude">解除 Claude 無法使用</button>
        </div>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">觸發條件</h3>
        <p>定時 {{ data.trigger.interval_min ?? '關閉' }} 分鐘、漲 {{ data.trigger.up_pct ?? '關' }}%、跌 {{ data.trigger.down_pct ?? '關' }}%（{{ data.trigger.set_by }} 於 {{ fmt.time(data.trigger.set_at) }} 設定；每天開盤前重設為預設值）</p>
        <p>固定觸發：<span v-for="(t, k) in data.fixed_triggers" :key="k" class="tag" style="margin-right:6px">{{ k }} {{ t }}</span></p>
      </div>
      <div class="panel">
        <h3 style="margin-top:0">休市日</h3>
        <form class="inline" @submit.prevent="addHoliday">
          <label class="field">日期<input type="date" required v-model="hol.date" /></label>
          <label class="field">原因<input v-model="hol.reason" placeholder="例如颱風停市" /></label>
          <button :disabled="!isActiveView">標記臨時休市</button>
        </form>
        <DataTable :rows="data.holidays" empty="今天之後沒有已標記的休市日（年度休市日曆請更新 config/holidays.csv）" :cols="[
          { key: 'date', label: '日期' }, { key: 'reason', label: '原因' }, { key: 'source', label: '來源', fmt: (v) => v === 'user' ? '手動' : '日曆' },
        ]" />
      </div>
      <h3>稽核記錄</h3>
      <div class="panel">
        <DataTable :rows="data.audit" :cols="[
          { key: 'ts', label: '時間', fmt: fmt.time },
          { key: 'actor', label: '操作者' },
          { key: 'command', label: '指令' },
          { key: 'args_json', label: '參數', mono: true },
          { key: 'result', label: '結果' },
        ]" />
      </div>
    </template>`,
};

// ---------------------------------------------------------------- 外框與路由

const PAGES = [
  ['overview', '總覽', Overview],
  ['positions', '持倉', Positions],
  ['orders', '委託與成交', Orders],
  ['decisions', '決策日誌', Decisions],
  ['funds', '資金管理', Funds],
  ['risk', '風控', Risk],
  ['fees', '費率與市場規則', Fees],
  ['strategy', '策略', Strategy],
  ['reviews', '復盤', Reviews],
  ['usage', '用量', Usage],
  ['reconcile', '對帳', Reconcile],
  ['system', '系統', System],
];

const App = {
  setup() {
    const route = ref(location.hash.slice(2) || 'overview');
    window.addEventListener('hashchange', () => (route.value = location.hash.slice(2) || 'overview'));
    const page = computed(() => (PAGES.find((p) => p[0] === route.value) ?? PAGES[0])[2]);
    const head = ref(null);
    const loadHead = async () => {
      try {
        head.value = await get('overview');
      } catch {
        head.value = null;
      }
    };
    onMounted(async () => {
      try {
        store.views = (await get('meta')).views;
      } catch {
        /* 保持預設 */
      }
      if (!store.views.includes(store.view)) store.view = ACTIVE_MODE;
      loadHead();
      setInterval(loadHead, 15_000);
    });
    watch(() => [store.view, store.refreshKey], loadHead);
    watch(() => store.view, (v) => localStorage.setItem('ctrade-view', v));
    const systemState = computed(() => {
      const h = head.value;
      if (!h) return { text: '讀取中', cls: '' };
      if (h.pause.paused) return { text: '暫停', cls: 'bad' };
      if (h.status.claude_unavailable) return { text: 'Claude 無法使用', cls: 'warn' };
      return { text: '運作中', cls: 'ok' };
    });
    const heartbeat = computed(() => {
      const iso = head.value?.heartbeat;
      const stale = !iso || Date.now() - Date.parse(iso) > 3 * 60_000;
      return { text: `daemon 心跳 ${fmt.ago(iso)}`, cls: stale ? 'warn' : 'ok' };
    });
    const onConfirm = (yes) => {
      const c = store.confirm;
      if (!c) return;
      if (c.input) {
        const value = String(c.input.value ?? "").trim();
        if (yes && c.input.required && !value) return;
        c.resolve(yes ? value : null);
      } else c.resolve(yes);
      store.confirm = null;
    };
    return { route, page, PAGES, store, ACTIVE_MODE, systemState, heartbeat, onConfirm };
  },
  template: `
    <header class="topbar">
      <h1>Claude 交易系統</h1>
      <span class="mode-badge" :class="ACTIVE_MODE">{{ ACTIVE_MODE === 'live' ? 'LIVE 真實交易' : 'PAPER 模擬' }}</span>
      <span class="chip" :class="systemState.cls"><span class="dot"></span>{{ systemState.text }}</span>
      <span class="chip" :class="heartbeat.cls"><span class="dot"></span>{{ heartbeat.text }}</span>
      <span class="spacer"></span>
      <label class="view-toggle" v-if="store.views.length > 1">檢視帳本
        <select v-model="store.view"><option v-for="v in store.views" :value="v">{{ v }}.db</option></select>
      </label>
    </header>
    <div v-if="store.view !== ACTIVE_MODE" class="viewing-other">正在檢視 <strong>{{ store.view.toUpperCase() }}</strong> 帳本（唯讀）。這只影響檢視，不會改變交易模式。</div>
    <div class="layout">
      <nav class="side">
        <a v-for="p in PAGES" :key="p[0]" :href="'#/' + p[0]" :class="{ active: route === p[0] }">{{ p[1] }}</a>
      </nav>
      <main><component :is="page" :key="route" /></main>
    </div>
    <div v-if="store.confirm" class="overlay" @click.self="onConfirm(false)">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ store.confirm.title }}</h3>
        <p v-for="(l, i) in store.confirm.lines" :key="i">{{ l }}</p>
        <form v-if="store.confirm.input" @submit.prevent="onConfirm(true)">
          <label class="field">{{ store.confirm.input.label }}
            <input :type="store.confirm.input.type" v-model="store.confirm.input.value" :required="store.confirm.input.required" autofocus />
          </label>
        </form>
        <div class="actions">
          <button @click="onConfirm(false)">取消</button>
          <button :class="store.confirm.danger ? 'danger' : 'primary'" @click="onConfirm(true)">{{ store.confirm.okText }}</button>
        </div>
      </div>
    </div>
    <div v-if="store.toast" class="toast" :class="{ error: store.toast.error }">{{ store.toast.message }}</div>`,
};

createApp(App).mount('#app');
