"use client";
import { useEffect, useState } from 'react';

interface Signal {
  symbol: string;
  trading_type?: string;
  bias: 'LONG' | 'SHORT' | 'WATCHLIST';
  quality?: string;
  entry?: number | string;
  take_profit?: number;
  stop_loss?: number;
  confidence: number;
  reason?: string;
  risk_warning?: string;
  timestamp?: number;
  isFallback?: boolean;
}

interface Trade {
  symbol: string;
  bias: string;
  entry: number;
  exit_price?: number;
  close_reason: string;
  pnl?: number | string;
  entryAt?: number;
  exitAt?: number;
  quality?: string;
  confidence?: number;
  fills?: number;
}

interface BinanceTrade {
  symbol: string;
  market?: string;
  pnl?: string | number;
  exitTime?: number;
  entryPrice?: number;
  exitPrice?: number;
  entryTime?: number;
  close_reason?: string;
}

interface Lesson {
  symbol: string;
  bias: string;
  analysis: string;
  timestamp?: number;
}

interface BotData {
  signals: Signal[];
  history: Trade[];
  lessons: Lesson[];
  logs: string;
  watchlist?: Signal[];
  binanceSnapshot?: {
    period?: string;
    market?: string;
    generatedAt?: number;
    totalPnl?: string;
    tradesCount?: number;
    winRate?: string;
    wins?: number;
    losses?: number;
    latestTrade?: BinanceTrade;
    tradeLog?: BinanceTrade[];
  } | null;
  livePrices?: Record<string, {
    symbol: string;
    lastPrice: number;
    priceChangePercent: number;
    quoteVolume: number;
    updatedAt: number;
  }>;
}

function formatPrice(value?: number | string | null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';

  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 6;
  return n.toFixed(decimals).replace(/\.?0+$/, '');
}

function getOutcomeLabel(trade?: Trade | BinanceTrade | null) {
  if (!trade) return '-';

  const closeReason = (trade as Trade).close_reason;
  if (closeReason === 'TP_HIT') return 'TP';
  if (closeReason === 'SL_HIT') return 'SL';

  const pnl = Number((trade as BinanceTrade).pnl);
  if (Number.isFinite(pnl)) return pnl >= 0 ? 'TP' : 'SL';

  return '-';
}

export default function Dashboard() {
  const [data, setData] = useState<BotData>({ signals: [], history: [], lessons: [], logs: "" });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'signals' | 'history' | 'lessons' | 'logs'>('overview');

  useEffect(() => {
    fetch(`/api/bot-data?t=${Date.now()}`)
      .then((res) => res.json())
      .then((res) => {
        if (res.success) {
          setData({
            signals: res.signals || [],
            history: res.history ? res.history.reverse() : [],
            lessons: res.lessons ? res.lessons.reverse() : [],
            logs: res.logs || "",
            watchlist: res.watchlist || [],
            binanceSnapshot: res.binanceSnapshot || null,
            livePrices: res.livePrices || {}
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const signals = data.signals || [];
  const history = data.history || [];
  const lessons = data.lessons || [];
  const watchlistSignals = data.watchlist || signals.filter((s) => s.bias === 'WATCHLIST' || s.quality === 'WATCHLIST');
  const activeSignals = signals.filter((s) => s.bias === 'LONG' || s.bias === 'SHORT');
  const approvedSignals = activeSignals.length;
  const completedTrades = history.filter((t) => t.close_reason === 'TP_HIT' || t.close_reason === 'SL_HIT');
  const winTrades = completedTrades.filter((t) => t.close_reason === 'TP_HIT').length;
  const lossTrades = completedTrades.filter((t) => t.close_reason === 'SL_HIT').length;
  const winRate = completedTrades.length > 0 ? (winTrades / completedTrades.length) * 100 : 0;
  const performanceWins = data.binanceSnapshot?.wins ?? winTrades;
  const performanceLosses = data.binanceSnapshot?.losses ?? lossTrades;
  const performanceWinRate = data.binanceSnapshot?.winRate
    ? Number.parseFloat(data.binanceSnapshot.winRate)
    : winRate;
  const performanceTradeCount = data.binanceSnapshot?.tradesCount ?? completedTrades.length;
  const avgConfidence = signals.length > 0
    ? signals.reduce((sum, s) => sum + (Number(s.confidence) || 0), 0) / signals.length
    : 0;
  const strongestSignal = [...signals]
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))[0];
  const latestHistory = history[0];
  const latestBinanceTrade = data.binanceSnapshot?.latestTrade || null;
  const recentBinanceTrades = Array.isArray(data.binanceSnapshot?.tradeLog) ? data.binanceSnapshot.tradeLog : [];
  const recentOutcomes = recentBinanceTrades.length > 0 ? recentBinanceTrades : history;
  const latestLesson = lessons[0];
  const signalHealthLabel = signals.length === 0
    ? 'Tidak ada signal aktif'
    : watchlistSignals.length > 0
      ? `${watchlistSignals.length} watchlist perlu konfirmasi`
      : `${approvedSignals} signal aktif siap dipantau`;
  const topSetups = [...signals]
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, 3);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between pb-6 border-b border-slate-800/60 gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-sky-300 via-cyan-300 to-emerald-300 bg-clip-text text-transparent">
              Crypto Signal Ops
            </h1>
            <p className="text-slate-400 mt-2 text-sm">Signal aktif, performa terakhir, dan catatan yang benar-benar bisa dipakai.</p>
          </div>
          <div className="flex flex-wrap bg-slate-900/50 p-1 rounded-xl border border-slate-800/60 gap-1">
            {(['overview', 'signals', 'history', 'lessons', 'logs'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all capitalize ${
                  activeTab === tab 
                    ? 'bg-slate-800 text-cyan-300 shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </header>

        <section className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Active</p>
            <p className="mt-2 text-3xl font-bold text-cyan-300">{signals.length}</p>
            <p className="mt-1 text-xs text-slate-400">signal live</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Approved</p>
            <p className="mt-2 text-3xl font-bold text-emerald-300">{approvedSignals}</p>
            <p className="mt-1 text-xs text-slate-400">lolos screening</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Watchlist</p>
            <p className="mt-2 text-3xl font-bold text-amber-300">{watchlistSignals.length}</p>
            <p className="mt-1 text-xs text-slate-400">butuh konfirmasi</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Win Rate</p>
            <p className="mt-2 text-3xl font-bold text-violet-300">{performanceWinRate.toFixed(0)}%</p>
            <p className="mt-1 text-xs text-slate-400">{performanceTradeCount} trades • {performanceWins} TP / {performanceLosses} SL{data.binanceSnapshot ? ' • Binance' : ''}</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Avg Conf</p>
            <p className="mt-2 text-3xl font-bold text-sky-300">{avgConfidence.toFixed(0)}%</p>
            <p className="mt-1 text-xs text-slate-400">signal saat ini</p>
          </div>
          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Latest</p>
            <p className="mt-2 text-2xl font-bold text-slate-100">{latestBinanceTrade?.symbol || latestHistory?.symbol || (strongestSignal?.symbol || '-')}</p>
            <p className="mt-1 text-xs text-slate-400">{latestBinanceTrade ? 'Binance synced' : latestHistory ? latestHistory.close_reason : signalHealthLabel}</p>
          </div>
        </section>

        {/* Content Area */}
        {loading ? (
          <div className="text-slate-500 text-center py-20 animate-pulse">Syncing with bot memory...</div>
        ) : (
          <div className="animation-fade-in">
            {activeTab === 'overview' && (
              <div className="space-y-8">
                <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2 rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 shadow-xl shadow-cyan-950/10">
                    <div className="flex items-start justify-between gap-4 mb-6">
                      <div>
                        <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Current Readout</p>
                        <h2 className="text-2xl font-bold text-slate-100 mt-2">Signal yang relevan buat sekarang</h2>
                      </div>
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-right">
                        <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Status</p>
                        <p className="text-sm text-slate-200 mt-1">{signalHealthLabel}</p>
                      </div>
                    </div>

                    {signals.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 p-8 text-slate-500">
                        Belum ada signal aktif. Ini justru useful: kamu tahu dashboard lagi kosong, bukan seolah-olah semua approved.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {topSetups.map((signal, idx) => {
                          const livePrice = data.livePrices?.[signal.symbol];
                          const liveValue = livePrice?.lastPrice;
                          const deltaFromEntry = liveValue != null && Number(signal.entry)
                            ? ((liveValue - Number(signal.entry)) / Number(signal.entry)) * 100
                            : null;
                          const deltaLabel = deltaFromEntry == null
                            ? '-'
                            : `${deltaFromEntry >= 0 ? '+' : ''}${deltaFromEntry.toFixed(2)}%`;

                          return (
                            <div key={`${signal.symbol}-${idx}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
                              <div className="flex items-start justify-between gap-3 mb-4">
                                <div>
                                  <h3 className="text-xl font-bold text-slate-100">{signal.symbol}</h3>
                                  <p className="text-xs text-slate-400 mt-1">{signal.trading_type || 'DAY TRADING'}</p>
                                </div>
                                <span className={`px-3 py-1 text-xs font-bold rounded-lg border ${
                                  signal.bias === 'LONG' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' :
                                  signal.bias === 'SHORT' ? 'bg-rose-500/10 text-rose-300 border-rose-500/20' :
                                  'bg-amber-500/10 text-amber-300 border-amber-500/20'
                                }`}>
                                  {signal.bias}
                                </span>
                              </div>

                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Entry</p>
                                  <p className="mt-1 font-mono text-slate-200 break-all leading-tight">{formatPrice(signal.entry)}</p>
                                </div>
                                <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Confidence</p>
                                  <p className="mt-1 font-mono text-slate-200">{Number(signal.confidence).toFixed(0)}%</p>
                                </div>
                                <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider text-slate-500">TP</p>
                                  <p className="mt-1 font-mono text-emerald-300 break-all leading-tight">{formatPrice(signal.take_profit)}</p>
                                </div>
                                <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-3 min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider text-slate-500">SL</p>
                                  <p className="mt-1 font-mono text-rose-300 break-all leading-tight">{formatPrice(signal.stop_loss)}</p>
                                </div>
                                <div className="col-span-2 flex items-center justify-between rounded-xl bg-slate-900/70 border border-slate-800 p-3">
                                  <div className="min-w-0">
                                    <p className="text-[10px] uppercase tracking-wider text-slate-500">Live Binance</p>
                                    <p className="mt-1 font-mono text-sky-300 break-all leading-tight">{formatPrice(liveValue)}</p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-[10px] uppercase tracking-wider text-slate-500">Vs Entry</p>
                                    <p className={`mt-1 font-mono break-all leading-tight ${deltaFromEntry == null ? 'text-slate-300' : deltaFromEntry >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                                      {deltaLabel}
                                    </p>
                                  </div>
                                </div>
                              </div>

                              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                                <span>Quality: {signal.quality || 'N/A'}</span>
                                <span>{signal.timestamp ? new Date(signal.timestamp).toLocaleString('id-ID') : 'Just now'}</span>
                              </div>

                              <p className="mt-4 text-sm text-slate-400 leading-relaxed line-clamp-4">
                                {signal.reason || 'No reasoning provided.'}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6">
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Quick Take</p>
                    <h3 className="text-xl font-bold text-slate-100 mt-2">Apa yang perlu kamu lihat dulu</h3>
                    <div className="mt-5 space-y-4 text-sm text-slate-300">
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                        <p className="text-slate-400 text-xs uppercase tracking-wider">Focus</p>
                        <p className="mt-2">{strongestSignal ? `${strongestSignal.symbol} paling kuat saat ini.` : 'Belum ada signal yang bisa difokuskan.'}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                        <p className="text-slate-400 text-xs uppercase tracking-wider">Latest Binance Trade</p>
                        <p className="mt-2">
                          {latestBinanceTrade
                            ? `${latestBinanceTrade.symbol} ${latestBinanceTrade.market ? `(${latestBinanceTrade.market})` : ''} ${latestBinanceTrade.pnl ? `PnL ${formatPrice(latestBinanceTrade.pnl)}` : ''} • ${getOutcomeLabel(latestBinanceTrade)}`.trim()
                            : latestHistory
                              ? `${latestHistory.symbol} selesai dengan ${latestHistory.close_reason}.`
                              : 'Belum ada trade history.'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                        <p className="text-slate-400 text-xs uppercase tracking-wider">Latest Lesson</p>
                        <p className="mt-2 line-clamp-6">{latestLesson ? latestLesson.analysis : 'Belum ada lesson tersimpan.'}</p>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Recent Outcomes</p>
                      <h3 className="text-xl font-bold text-slate-100 mt-1">Trade terakhir yang benar-benar kejadian</h3>
                    </div>
                    <span className="text-xs text-slate-500">Newest first</span>
                  </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {recentOutcomes.slice(0, 6).map((t, i) => (
                      <div key={`${t.symbol}-${i}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h4 className="font-bold text-slate-100">{t.symbol}</h4>
                            <p className="text-xs text-slate-400 mt-1">{(t as any).bias ?? '-'} • {t.close_reason}</p>
                          </div>
                          <span className={`text-xs px-2 py-1 rounded-lg border ${
                            getOutcomeLabel(t) === 'TP' ? 'border-emerald-500/20 text-emerald-300 bg-emerald-500/10' :
                            'border-rose-500/20 text-rose-300 bg-rose-500/10'
                          }`}>
                            {getOutcomeLabel(t)}
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-400">
                          <div>
                            <p className="uppercase tracking-wider text-slate-500">Entry</p>
                            <p className="mt-1 font-mono text-slate-200 break-all leading-tight">{formatPrice((t as Trade).entry ?? (t as BinanceTrade).entryPrice)}</p>
                          </div>
                          <div>
                            <p className="uppercase tracking-wider text-slate-500">Exit</p>
                            <p className="mt-1 font-mono text-slate-200 break-all leading-tight">{formatPrice((t as Trade).exit_price ?? (t as BinanceTrade).exitPrice)}</p>
                          </div>
                        </div>
                        {(t as any).fills && (t as any).fills > 1 && (
                          <p className="mt-3 text-xs text-slate-500">Position merged from {(t as any).fills} fills</p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {/* TABS CONTENT */}
            
            {/* 1. SIGNALS TAB */}
            {activeTab === 'signals' && (
              data.signals.length === 0 ? (
                <div className="text-slate-500 text-center py-20 border border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
                  No active setups found. Waiting for next scan cycle.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {data.signals.map((signal, idx) => (
                    <div key={idx} className="group relative bg-slate-900/50 backdrop-blur-xl border border-slate-800/80 rounded-2xl p-6 hover:bg-slate-800/50 hover:border-slate-700/80 transition-all duration-300 shadow-xl shadow-cyan-950/5">
                      <div className="flex justify-between items-start mb-4">
                        <div>
                          <h2 className="text-2xl font-bold tracking-tight text-slate-100">{signal.symbol}</h2>
                          <p className="text-xs text-slate-400 mt-1 font-mono">{signal.trading_type || 'DAY TRADING'}</p>
                        </div>
                        <span className={`px-3 py-1 text-xs font-bold rounded-lg border ${
                          signal.bias === 'LONG' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 
                          signal.bias === 'SHORT' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 
                          'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        }`}>
                          {signal.bias}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 mb-6 p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Entry Zone</p>
                          <p className="font-mono text-sm text-slate-200 break-all leading-tight">{formatPrice(signal.entry)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Confidence</p>
                          <p className="font-mono text-sm text-slate-200 flex items-center gap-1">
                            {signal.confidence}% <span className="text-indigo-400">●</span>
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Quality</p>
                          <p className="font-mono text-sm text-slate-200">{signal.quality || 'N/A'}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Signal Age</p>
                          <p className="font-mono text-sm text-slate-200">
                            {signal.timestamp ? `${Math.max(0, Math.round((Date.now() - signal.timestamp) / 60000))}m` : '-'}
                          </p>
                        </div>
                        <div className="col-span-2 grid grid-cols-3 gap-3 border-t border-slate-800/50 pt-2 mt-2">
                           <div>
                              <p className="text-[10px] uppercase tracking-wider text-emerald-500/70 mb-1">TP</p>
                              <p className="font-mono text-xs text-slate-300 break-all leading-tight">{formatPrice(signal.take_profit)}</p>
                           </div>
                           <div className="text-right">
                              <p className="text-[10px] uppercase tracking-wider text-rose-500/70 mb-1">SL</p>
                              <p className="font-mono text-xs text-slate-300 break-all leading-tight">{formatPrice(signal.stop_loss)}</p>
                           </div>
                           <div className="text-right">
                              <p className="text-[10px] uppercase tracking-wider text-sky-500/70 mb-1">Live</p>
                              <p className="font-mono text-xs text-slate-300 break-all leading-tight">{formatPrice(data.livePrices?.[signal.symbol]?.lastPrice)}</p>
                           </div>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <p className="text-xs font-semibold text-slate-300 mb-1">AI Reasoning</p>
                        <p className="text-sm text-slate-400 leading-relaxed line-clamp-4 group-hover:line-clamp-none transition-all">
                          {signal.reason || 'No reasoning provided.'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* 2. HISTORY TAB */}
            {activeTab === 'history' && (
              <div className="bg-slate-900/50 border border-slate-800/80 rounded-2xl overflow-hidden">
                <table className="w-full text-left text-sm text-slate-400">
                  <thead className="bg-slate-950/50 uppercase text-xs font-semibold text-slate-500 border-b border-slate-800">
                    <tr>
                      <th className="px-6 py-4">Symbol</th>
                      <th className="px-6 py-4">Bias</th>
                      <th className="px-6 py-4">Result</th>
                      <th className="px-6 py-4">Quality</th>
                      <th className="px-6 py-4">Confidence</th>
                      <th className="px-6 py-4">Fills</th>
                      <th className="px-6 py-4">Entry</th>
                      <th className="px-6 py-4">Exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.length === 0 ? (
                      <tr><td colSpan={8} className="text-center py-12 text-slate-500">No trade history recorded yet.</td></tr>
                    ) : (
                      data.history.map((t, i) => (
                        <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                          <td className="px-6 py-4 font-bold text-slate-200">{t.symbol}</td>
                          <td className="px-6 py-4 font-mono">{t.bias}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-1 rounded text-xs ${
                              t.close_reason === 'TP_HIT' ? 'bg-emerald-500/10 text-emerald-400' :
                              t.close_reason === 'SL_HIT' ? 'bg-rose-500/10 text-rose-400' :
                              'bg-slate-800 text-slate-300'
                            }`}>{t.close_reason}</span>
                          </td>
                          <td className="px-6 py-4 font-mono text-xs">{(t as any).quality || '-'}</td>
                          <td className="px-6 py-4 font-mono text-xs">{(t as any).confidence ?? '-'}</td>
                          <td className="px-6 py-4 font-mono text-xs">{(t as any).fills ?? 1}</td>
                          <td className="px-6 py-4 font-mono text-xs break-all">{formatPrice(t.entry)}</td>
                          <td className="px-6 py-4 font-mono text-xs break-all">{formatPrice(t.exit_price)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'signals' && watchlistSignals.length > 0 && (
              <div className="mt-6 rounded-2xl border border-slate-800/80 bg-slate-900/40 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold text-slate-100">Watchlist</h3>
                  <span className="text-xs text-slate-500">{watchlistSignals.length} item(s)</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {watchlistSignals.slice(0, 6).map((signal, idx) => (
                    <div key={`${signal.symbol}-watch-${idx}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-lg font-bold text-slate-100">{signal.symbol}</h4>
                          <p className="text-xs text-slate-400 mt-1">{signal.trading_type || 'WATCHLIST'}</p>
                        </div>
                        <span className="px-3 py-1 text-xs font-bold rounded-lg border bg-amber-500/10 text-amber-300 border-amber-500/20">
                          WATCHLIST
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-slate-400 line-clamp-3">{signal.reason || 'Belum ada alasan tercatat.'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 3. LESSONS TAB */}
            {activeTab === 'lessons' && (
              <div className="space-y-4">
                {data.lessons.length === 0 ? (
                  <div className="text-slate-500 text-center py-20 border border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
                    No AI lessons recorded yet.
                  </div>
                ) : (
                  data.lessons.map((l, i) => (
                    <div key={i} className="bg-slate-900/50 border-l-4 border-l-indigo-500 border-y border-y-slate-800 border-r border-r-slate-800 rounded-r-2xl p-6">
                      <div className="flex items-center gap-3 mb-3">
                        <h3 className="text-xl font-bold tracking-tight text-slate-100">{l.symbol}</h3>
                        <span className="text-xs px-2 py-1 bg-slate-800 text-slate-300 rounded uppercase">{l.bias}</span>
                      </div>
                      <p className="text-sm text-slate-300 leading-relaxed italic border-l-2 border-slate-700 pl-4 py-1">
                        "{l.analysis}"
                      </p>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* 4. LOGS TAB */}
            {activeTab === 'logs' && (
              <div className="bg-[#0D1117] border border-slate-800 rounded-2xl p-6 overflow-hidden relative">
                <div className="flex justify-between items-center mb-4">
                   <h3 className="text-sm font-semibold text-slate-400 tracking-wider">SCAN AUDIT LOG (Recent 50 lines)</h3>
                   <div className="flex gap-2">
                       <span className="w-3 h-3 rounded-full bg-rose-500"></span>
                       <span className="w-3 h-3 rounded-full bg-amber-500"></span>
                       <span className="w-3 h-3 rounded-full bg-emerald-500"></span>
                   </div>
                </div>
                <div className="overflow-x-auto">
                    <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap">
                    {data.logs || "No logs available."}
                    </pre>
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </main>
  );
}
