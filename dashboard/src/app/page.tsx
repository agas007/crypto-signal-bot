"use client";
import { useEffect, useState } from 'react';

interface Signal {
  symbol: string;
  trading_type?: string;
  bias: 'LONG' | 'SHORT' | 'WATCHLIST';
  entry?: number | string;
  take_profit?: number;
  stop_loss?: number;
  confidence: number;
  reason?: string;
  risk_warning?: string;
}

interface Trade {
  symbol: string;
  bias: string;
  entry: number;
  exit_price?: number;
  close_reason: string;
  entryAt?: number;
  exitAt?: number;
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
}

export default function Dashboard() {
  const [data, setData] = useState<BotData>({ signals: [], history: [], lessons: [], logs: "" });
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'signals' | 'history' | 'lessons' | 'logs'>('signals');

  useEffect(() => {
    fetch('/api/bot-data')
      .then((res) => res.json())
      .then((res) => {
        if (res.success) {
          setData({
            signals: res.signals || [],
            history: res.history ? res.history.reverse() : [],
            lessons: res.lessons ? res.lessons.reverse() : [],
            logs: res.logs || ""
          });
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 p-4 md:p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between pb-6 border-b border-slate-800/60 gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              Crypto Copilot
            </h1>
            <p className="text-slate-400 mt-2 text-sm">Institutional-Grade Trade Intelligence</p>
          </div>
          <div className="flex bg-slate-900/50 p-1 rounded-xl border border-slate-800/60">
            {(['signals', 'history', 'lessons', 'logs'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all capitalize ${
                  activeTab === tab 
                    ? 'bg-slate-800 text-indigo-400 shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </header>

        {/* Content Area */}
        {loading ? (
          <div className="text-slate-500 text-center py-20 animate-pulse">Syncing with bot memory...</div>
        ) : (
          <div className="animation-fade-in">
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
                    <div key={idx} className="group relative bg-slate-900/50 backdrop-blur-xl border border-slate-800/80 rounded-2xl p-6 hover:bg-slate-800/50 hover:border-slate-700/80 transition-all duration-300 shadow-xl shadow-indigo-900/5">
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
                          <p className="font-mono text-sm text-slate-200">{typeof signal.entry === 'number' ? signal.entry.toFixed(5) : (signal.entry || '-')}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Confidence</p>
                          <p className="font-mono text-sm text-slate-200 flex items-center gap-1">
                            {signal.confidence}% <span className="text-indigo-400">●</span>
                          </p>
                        </div>
                        <div className="col-span-2 flex justify-between border-t border-slate-800/50 pt-2 mt-2">
                           <div>
                              <p className="text-[10px] uppercase tracking-wider text-emerald-500/70 mb-1">TP</p>
                              <p className="font-mono text-xs text-slate-300">{signal.take_profit || '-'}</p>
                           </div>
                           <div className="text-right">
                              <p className="text-[10px] uppercase tracking-wider text-rose-500/70 mb-1">SL</p>
                              <p className="font-mono text-xs text-slate-300">{signal.stop_loss || '-'}</p>
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
                      <th className="px-6 py-4">Entry</th>
                      <th className="px-6 py-4">Exit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.length === 0 ? (
                      <tr><td colSpan={5} className="text-center py-12 text-slate-500">No trade history recorded yet.</td></tr>
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
                          <td className="px-6 py-4 font-mono text-xs">{t.entry}</td>
                          <td className="px-6 py-4 font-mono text-xs">{t.exit_price || '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
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
