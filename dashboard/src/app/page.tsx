"use client";
import { useEffect, useState } from 'react';

interface Signal {
  symbol: string;
  trading_type?: string;
  bias: 'LONG' | 'SHORT' | 'WATCHLIST';
  entry?: number | string;
  confidence: number;
  reason?: string;
  risk_warning?: string;
}

export default function Dashboard() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/signals')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          // Normalize object if it's stored as keyed object instead of array
          const parsed = Array.isArray(data.signals) ? data.signals : Object.values(data.signals);
          setSignals(parsed);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-50 p-8 font-sans selection:bg-indigo-500/30">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex items-center justify-between pb-6 border-b border-slate-800/60">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              Copilot Dashboard
            </h1>
            <p className="text-slate-400 mt-2 text-sm">Review AI-validated setups before executing</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-mono text-slate-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Scanner Active
            </div>
          </div>
        </header>

        {/* Signals Grid */}
        {loading ? (
          <div className="text-slate-500 text-center py-20 animate-pulse">Scanning market data...</div>
        ) : signals.length === 0 ? (
          <div className="text-slate-500 text-center py-20 border border-dashed border-slate-800 rounded-2xl bg-slate-900/20">
            No active setups found. Waiting for next scan cycle.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {signals.map((signal: Signal, idx: number) => (
              <div 
                key={idx} 
                className="group relative bg-slate-900/50 backdrop-blur-xl border border-slate-800/80 rounded-2xl p-6 hover:bg-slate-800/50 hover:border-slate-700/80 transition-all duration-300 shadow-2xl shadow-indigo-900/5"
              >
                {/* Badge & Title */}
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-100">{signal.symbol}</h2>
                    <p className="text-xs text-slate-400 mt-1 font-mono">{signal.trading_type || 'DAY TRADING'}</p>
                  </div>
                  <span className={`px-3 py-1 text-xs font-bold rounded-lg border ${
                    signal.bias === 'LONG' 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                      : signal.bias === 'SHORT'
                      ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {signal.bias}
                  </span>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-4 mb-6 p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Entry Zone</p>
                    <p className="font-mono text-sm text-slate-200">{signal.entry || '-'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Confidence</p>
                    <p className="font-mono text-sm text-slate-200 flex items-center gap-1">
                      {signal.confidence}%
                      <span className="text-indigo-400">●</span>
                    </p>
                  </div>
                </div>

                {/* AI Reasoning */}
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-300 mb-1 flex items-center gap-2">
                       AI Reasoning
                    </p>
                    <p className="text-sm text-slate-400 leading-relaxed line-clamp-3 group-hover:line-clamp-none transition-all">
                      {signal.reason || 'No reasoning provided.'}
                    </p>
                  </div>
                  
                  {signal.risk_warning && (
                    <div className="mt-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                       <p className="text-xs font-medium text-amber-400/80 mb-1">Risk Warning</p>
                       <p className="text-xs text-amber-500/70">{signal.risk_warning}</p>
                    </div>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="mt-6 pt-6 border-t border-slate-800/60 flex items-center gap-3">
                  <button className="flex-1 bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors">
                    Track
                  </button>
                  <button className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium py-2 px-4 rounded-lg transition-colors border border-slate-700">
                    Discard
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
