/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Activity, TrendingUp, Zap, ShieldAlert, Bot, History, Settings, ExternalLink, ChevronRight, AlertCircle, CheckCircle2, XCircle, RefreshCw, User, Wallet } from 'lucide-react';

declare global {
  interface Window {
    ethereum?: any;
  }
}
import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { calculateVolumeConsistency, calculatePriceTrend, calculateWalletAllocation, calculateVolatilityPenalty, calculateRSIScore, calculatePriceVsHigh, calculateVolumeShape, computeConvictionScore, computeTimingScore } from '../lib/scoring';
import { calculateRSI } from '../lib/indicators';
import { ScoreChart } from './ScoreChart';
import { cn } from '../lib/utils';

export default function Dashboard() {
  const [selectedToken, setSelectedToken] = useState<any>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [tokens, setTokens] = useState<any[]>([]);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [walletAddress, setWalletAddress] = useState(""); 
  const [portfolio, setPortfolio] = useState<any>(null);
  const [tokenHistory, setTokenHistory] = useState<any>(null);
  const [isChangingAddress, setIsChangingAddress] = useState(false);
  const [newAddress, setNewAddress] = useState("");
  const [journal, setJournal] = useState<any[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const fetchTokens = async () => {
    setIsScanning(true);
    try {
      const response = await fetch('/api/tokens/base');
      const data = await response.json();
      setTokens(data);
      if (data.length > 0 && !selectedToken) {
        setSelectedToken(data[0]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsScanning(false);
    }
  };

  const fetchPortfolio = async (addr = walletAddress) => {
    try {
      const response = await fetch(`/api/portfolio/${addr}`);
      const data = await response.json();
      setPortfolio(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchTokenHistory = async (tokenId: string) => {
    try {
      const response = await fetch(`/api/history/${tokenId}`);
      const data = await response.json();
      setTokenHistory(data);
    } catch (e) {
      console.error(e);
    }
  };

  const connectWallet = async () => {
    if (typeof window.ethereum === 'undefined') {
      alert("Please install MetaMask or a compatible Web3 wallet.");
      return;
    }
    setIsConnecting(true);
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts[0]) {
        setWalletAddress(accounts[0]);
        fetchPortfolio(accounts[0]);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsConnecting(false);
    }
  };

  useEffect(() => {
    fetchTokens();
    fetch('/api/journal').then((r) => r.json()).then(setJournal).catch(console.error);
    fetch('/api/agent/state').then((r) => r.json()).then(setAgentState).catch(console.error);
  }, []);

  useEffect(() => {
    if (walletAddress) {
      fetchPortfolio(walletAddress);
    }
  }, [walletAddress]);

  useEffect(() => {
    if (selectedToken) {
      fetchTokenHistory(selectedToken.id);
    }
  }, [selectedToken]);

  const handleAddressChange = (e: FormEvent) => {
    e.preventDefault();
    if (newAddress.startsWith("0x") && newAddress.length === 42) {
      setWalletAddress(newAddress);
      fetchPortfolio(newAddress);
      setIsChangingAddress(false);
    } else {
      alert("Please enter a valid EVM address");
    }
  };

  const handleScan = async () => {
    await fetchTokens();
  };

  // Real-time scoring derived from history
  const { convictionScore, timingScore, convictionData, timingData, combinedScore } = useMemo(() => {
    const prices = tokenHistory?.prices?.map((p: any) => p[1]) || [];
    const volumes = tokenHistory?.total_volumes?.map((v: any) => v[1]) || [];

    if (prices.length === 0) {
      return { 
        convictionScore: 0, 
        timingScore: 0, 
        combinedScore: 0,
        convictionData: [], 
        timingData: [] 
      };
    }

    const volConsistency = calculateVolumeConsistency(volumes.slice(-7));
    const pTrend = calculatePriceTrend(prices.slice(-14));
    
    const tokenPosition = portfolio?.positions?.find((p: any) => p.symbol.toLowerCase() === selectedToken?.symbol.toLowerCase());
    const walletAllocPct = portfolio?.total_value ? ((tokenPosition?.amount || 0) * (selectedToken?.current_price || 0) / portfolio.total_value) * 100 : 0;
    const walletAlloc = calculateWalletAllocation(walletAllocPct);
    
    const volPenalty = calculateVolatilityPenalty(prices.slice(-14));
    const rsiVal = calculateRSI(prices, 14);
    const rsiSc = calculateRSIScore(rsiVal);
    const pVsHigh = calculatePriceVsHigh(selectedToken?.current_price || 0, selectedToken?.high_24h || 0);
    const volShape = calculateVolumeShape(volumes.slice(-7));

    const cScore = computeConvictionScore({
      volumeConsistency: volConsistency,
      priceTrend: pTrend,
      walletAllocation: walletAlloc,
      volatilityPenalty: volPenalty,
      multiSourceBonus: 0, 
      whaleBonus: 0
    });

    const tScore = computeTimingScore({
      rsi: rsiSc,
      priceVsHigh: pVsHigh,
      volumeShape: volShape
    });

    return {
      convictionScore: cScore,
      timingScore: tScore,
      combinedScore: (cScore * 0.5) + (tScore * 0.5),
      convictionData: [
        { subject: 'Vol Const', A: volConsistency, fullMark: 25 },
        { subject: 'Price Trend', A: pTrend, fullMark: 25 },
        { subject: 'Wallet Alloc', A: walletAlloc, fullMark: 25 },
        { subject: 'Vol Penalty', A: volPenalty, fullMark: 25 },
        { subject: 'AI Bonus', A: 0, fullMark: 15 },
      ],
      timingData: [
        { subject: 'RSI', A: rsiSc, fullMark: 40 },
        { subject: 'Vs High', A: pVsHigh, fullMark: 30 },
        { subject: 'Vol Shape', A: volShape, fullMark: 30 },
      ]
    };
  }, [tokenHistory, portfolio, selectedToken]);

  if (!selectedToken && tokens.length === 0 && isScanning) {
    return (
      <div className="h-screen bg-[#0A0A0B] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 text-purple-500 animate-spin" />
          <p className="text-purple-400 font-mono text-sm animate-pulse">Initializing Agent & Scanning Base Chain...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0A0A0B] text-[#E4E4E7] font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-[#1F1F23]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Bot className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight uppercase">Conviction DCA <span className="text-purple-400">Agent</span></h1>
            <p className="text-xs text-[#71717A] flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              Running Zerion CLI | Last cycle: {agentState?.lastRunAt ? new Date(agentState.lastRunAt).toLocaleTimeString() : 'pending'}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="text-right hidden md:block">
            <p className="text-[10px] uppercase text-[#71717A] tracking-wider">Monitored Wallet</p>
            <div className="flex items-center gap-2">
              {walletAddress ? (
                isChangingAddress ? (
                  <form onSubmit={handleAddressChange} className="flex gap-2">
                    <input 
                      autoFocus
                      placeholder="0x..." 
                      value={newAddress}
                      onChange={(e) => setNewAddress(e.target.value)}
                      className="bg-[#1F1F23] border border-purple-500/50 rounded px-2 py-0.5 text-xs font-mono outline-none"
                    />
                    <button type="submit" className="text-[10px] text-purple-400 font-bold hover:text-purple-300">GO</button>
                  </form>
                ) : (
                  <>
                    <button 
                      onClick={() => { setIsChangingAddress(true); setNewAddress(walletAddress); }}
                      className="font-mono text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
                    </button>
                    <User className="w-3 h-3 text-[#71717A]" />
                  </>
                )
              ) : (
                <button 
                  onClick={connectWallet}
                  className="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-[10px] font-bold transition-colors flex items-center gap-1.5"
                >
                  <Wallet className="w-3 h-3" />
                  {isConnecting ? "CONNECTING..." : "CONNECT WALLET"}
                </button>
              )}
            </div>
          </div>
          <div className="w-px h-8 bg-[#1F1F23]" />
          <div className="text-right hidden md:block">
            <p className="text-[10px] uppercase text-[#71717A] tracking-wider">Portfolio Value</p>
            <p className="font-mono text-sm leading-none">
              {walletAddress ? (portfolio ? `$${portfolio.total_value?.toFixed(2) || '0.00'}` : 'Loading...') : '---'}
            </p>
          </div>
          <div className="w-px h-8 bg-[#1F1F23]" />
          <button className="flex items-center gap-2 px-3 py-1.5 bg-[#1F1F23] hover:bg-[#27272A] rounded-md transition-colors text-xs font-medium">
            <Settings className="w-4 h-4" />
            Config
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: Watchlist */}
        <aside className="w-80 border-r border-[#1F1F23] flex flex-col bg-[#0D0D10]">
          <div className="p-4 border-b border-[#1F1F23] flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[#71717A] flex items-center gap-2">
              <Activity className="w-3.5 h-3.5" />
              Monitored Tokens ({tokens.length})
            </h2>
            <button 
              onClick={handleScan}
              disabled={isScanning}
              className="p-1.5 hover:bg-[#1F1F23] rounded-md transition-colors text-purple-400 disabled:opacity-50"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isScanning && "animate-spin")} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {tokens.map((token: any) => (
              <button
                key={token.id}
                onClick={() => setSelectedToken(token)}
                className={cn(
                  "w-full p-4 flex items-center justify-between hover:bg-[#1F1F23]/50 transition-all border-b border-[#1F1F23]/50 text-left",
                  selectedToken?.id === token.id && "bg-[#1F1F23] border-l-2 border-l-purple-500"
                )}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold uppercase tracking-tight">{token.symbol}</span>
                    <span className="text-[10px] text-[#71717A] truncate w-24">{token.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[#52525B] font-mono">Rank #{token.market_cap_rank}</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className={cn(
                    "text-xs font-mono font-medium",
                    token.price_change_percentage_24h >= 0 ? "text-green-400" : "text-red-400"
                  )}>
                    {token.price_change_percentage_24h?.toFixed(2)}%
                  </p>
                  <p className="text-[10px] text-[#52525B]">${(token.current_price)?.toFixed(4)}</p>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Center: Detail & Scoring */}
        <div className="flex-1 overflow-y-auto bg-grid-white/[0.02]">
          <div className="p-8 max-w-5xl mx-auto space-y-8">
            {/* Token Hero */}
            {selectedToken && (
              <>
                <div className="flex items-end justify-between border-b border-[#1F1F23] pb-6">
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <h2 className="text-4xl font-bold tracking-tighter">{selectedToken.name}</h2>
                      <span className="text-xl text-[#71717A] font-mono uppercase">{selectedToken.symbol}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <div className="flex items-center gap-1 text-[#A1A1AA]">
                        <Activity className="w-3.5 h-3.5" />
                        <span>Price: ${selectedToken.current_price?.toFixed(4)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[#A1A1AA]">
                        <TrendingUp className="w-3.5 h-3.5" />
                        <span>24h High: ${selectedToken.high_24h?.toFixed(4)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-purple-400 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Base Chain</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <a 
                      href={`https://dexscreener.com/base/${selectedToken.symbol}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-[#1F1F23] hover:bg-[#27272A] rounded-md text-xs font-medium flex items-center gap-2 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      DexScreener
                    </a>
                  </div>
                </div>

                {/* Scores Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Conviction Gate */}
                  <div className="bg-[#101014] rounded-xl border border-[#1F1F23] overflow-hidden">
                    <div className="p-4 border-b border-[#1F1F23] flex items-center justify-between bg-gradient-to-r from-[#101014] to-[#1A1A1F]">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="w-4 h-4 text-purple-400" />
                        <span className="text-xs font-bold uppercase tracking-widest">Conviction Gate</span>
                      </div>
                      <span className="text-2xl font-mono font-bold text-purple-400">{convictionScore.toFixed(0)}/100</span>
                    </div>
                    <div className="p-6">
                      <ScoreChart data={convictionData} color="#A855F7" />
                      <div className="mt-4 grid grid-cols-2 gap-4">
                        <div className="p-3 bg-[#0A0A0B] rounded-lg border border-[#1F1F23]">
                          <p className="text-[10px] text-[#71717A] uppercase mb-1">Threshold</p>
                          <p className="text-sm font-mono tracking-wider">45/100</p>
                        </div>
                        <div className="p-3 bg-purple-500/5 rounded-lg border border-purple-500/20">
                          <p className="text-[10px] text-purple-400 uppercase mb-1">Status</p>
                          <p className={cn(
                            "text-sm font-bold",
                            convictionScore >= 45 ? "text-purple-300" : "text-red-400"
                          )}>{convictionScore >= 45 ? "OPENED" : "CLOSED"}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Timing Gate */}
                  <div className="bg-[#101014] rounded-xl border border-[#1F1F23] overflow-hidden">
                    <div className="p-4 border-b border-[#1F1F23] flex items-center justify-between bg-gradient-to-r from-[#101014] to-[#1A1A1F]">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-yellow-400" />
                        <span className="text-xs font-bold uppercase tracking-widest">Timing Gate</span>
                      </div>
                      <span className="text-2xl font-mono font-bold text-yellow-400">{timingScore.toFixed(0)}/100</span>
                    </div>
                    <div className="p-6">
                      <ScoreChart data={timingData} color="#FACC15" />
                      <div className="mt-4 grid grid-cols-2 gap-4">
                        <div className="p-3 bg-[#0A0A0B] rounded-lg border border-[#1F1F23]">
                          <p className="text-[10px] text-[#71717A] uppercase mb-1">Threshold</p>
                          <p className="text-sm font-mono tracking-wider">40/100</p>
                        </div>
                        <div className="p-3 bg-yellow-500/5 rounded-lg border border-yellow-500/20">
                          <p className="text-[10px] text-yellow-400 uppercase mb-1">Status</p>
                          <p className={cn(
                            "text-sm font-bold",
                            timingScore >= 40 ? "text-yellow-300" : "text-red-400"
                          )}>{timingScore >= 40 ? "OPENED" : "CLOSED"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Decision & Action */}
                <div className={cn(
                  "p-6 border rounded-xl flex items-center justify-between transition-all shadow-xl",
                  combinedScore >= 48 && convictionScore >= 45 && timingScore >= 40 
                    ? "bg-gradient-to-br from-green-500/10 to-transparent border-green-500/20"
                    : "bg-gradient-to-br from-red-500/10 to-transparent border-red-500/20"
                )}>
                  <div className="space-y-1">
                    <div className={cn(
                      "flex items-center gap-2",
                      combinedScore >= 48 && convictionScore >= 45 && timingScore >= 40 ? "text-green-400" : "text-red-400"
                    )}>
                      {combinedScore >= 48 && convictionScore >= 45 && timingScore >= 40 ? <TrendingUp className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <h3 className="font-bold text-lg">
                        {combinedScore >= 48 && convictionScore >= 45 && timingScore >= 40 
                          ? `Recommendation: Buy $${combinedScore >= 80 ? 50 : combinedScore >= 65 ? 25 : 10}` 
                          : "Recommendation: Skip (Gates Closed)"}
                      </h3>
                    </div>
                    <p className="text-sm text-[#A1A1AA]">Combined Score: <span className="font-mono font-bold text-white">{combinedScore.toFixed(1)}</span></p>
                  </div>
                  <button 
                    onClick={() => setShowPolicyModal(true)}
                    className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-bold transition-all shadow-lg shadow-purple-500/20 flex items-center gap-2"
                  >
                    Execute Swap (CLI)
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right Sidebar: Journal */}
        <aside className="w-96 border-l border-[#1F1F23] flex flex-col bg-[#0D0D10]">
          <div className="p-4 border-b border-[#1F1F23] flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[#71717A] flex items-center gap-2">
              <History className="w-3.5 h-3.5" />
              Trade Journal
            </h2>
            <button className="text-[10px] text-[#71717A] hover:text-purple-400 transition-colors uppercase font-bold">View History</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {journal.map((entry, idx) => (
              <div key={idx} className="p-4 border-b border-[#1F1F23]/50 hover:bg-[#1F1F23]/30 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {entry.action === 'buy' ? (
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-400" />
                    )}
                    <span className={cn(
                      "text-[10px] font-bold uppercase",
                      entry.action === 'buy' ? "text-green-400" : "text-red-400"
                    )}>
                      {entry.action === 'buy' ? "Bought" : "Skipped"}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#52525B] font-mono">
                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{entry.symbol}</span>
                    {entry.action === 'buy' && (
                        <span className="text-xs text-[#A1A1AA] font-mono">${entry.amountUsd}</span>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-[#71717A] uppercase">Score</p>
                    <p className="text-xs font-mono">{entry.combinedScore ?? '-'}</p>
                  </div>
                </div>
                <div className="p-2 bg-[#1F1F23]/50 rounded text-[10px] text-[#A1A1AA] italic leading-relaxed">
                  Reason: {entry.reason}
                </div>
              </div>
            ))}
          </div>
          
          {/* Daily Status */}
          <div className="p-6 bg-[#101014] border-t border-[#1F1F23]">
            <h3 className="text-[10px] font-bold uppercase text-[#71717A] mb-4">Daily Policy Sync</h3>
            <div className="space-y-3">
               <div className="flex justify-between items-center text-xs">
                 <span className="text-[#A1A1AA]">Daily Spend</span>
                 <span className="font-mono">${journal.filter((j) => j.action === 'buy').reduce((a, b) => a + (b.amountUsd || 0), 0).toFixed(0)} / ${agentState?.policy?.maxDailySpendUsd ?? 50}</span>
               </div>
               <div className="w-full h-1.5 bg-[#1F1F23] rounded-full overflow-hidden">
                 <div className="h-full bg-purple-500" style={{ width: `${Math.min(100, ((journal.filter((j) => j.action === 'buy').reduce((a, b) => a + (b.amountUsd || 0), 0) / (agentState?.policy?.maxDailySpendUsd ?? 50)) * 100))}%` }} />
               </div>
               <div className="flex justify-between items-center text-xs pt-1">
                 <span className="text-[#A1A1AA]">Cooldown</span>
                 <span className="text-green-400 font-medium">{agentState?.isRunning ? 'Running' : 'Ready'}</span>
               </div>
            </div>
          </div>
        </aside>
      </main>
      
      {/* Footer Info Rail */}
      <footer className="h-8 bg-[#101014] border-t border-[#1F1F23] px-6 flex items-center justify-between text-[10px] text-[#52525B] font-mono uppercase tracking-widest">
        <div className="flex gap-6">
          <span>GAS: 0.1 GWEI</span>
          <span>LATENCY: 42MS</span>
          <span>UPTIME: 99.98%</span>
        </div>
        <div className="flex gap-4">
          <span>CONNECTED: 0x82...3e2</span>
          <span className="flex items-center gap-1">
             <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
             RE-SCAN IN 46:12
          </span>
        </div>
      </footer>

      {/* Policy Modal */}
      <AnimatePresence>
        {showPolicyModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#101014] border border-[#1F1F23] rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-[#1F1F23] flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <ShieldAlert className="text-purple-400 w-5 h-5" />
                  <h3 className="text-lg font-bold">13-Step Policy Gate</h3>
                </div>
                <button 
                  onClick={() => setShowPolicyModal(false)}
                  className="p-1 hover:bg-[#1F1F23] rounded-md"
                >
                  <XCircle className="w-5 h-5 text-[#71717A]" />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                {[
                  { label: "Emergency Stop", status: "PASSED", icon: CheckCircle2 },
                  { label: "Daily Spend Limit", status: "PASSED", icon: CheckCircle2 },
                  { label: "Weekly Spend Limit", status: "PASSED", icon: CheckCircle2 },
                  { label: "Cooldown Timer", status: "PASSED", icon: CheckCircle2 },
                  { label: "Max Daily Trades", status: "PASSED", icon: CheckCircle2 },
                  { label: "Allowed Token List", status: "PASSED", icon: CheckCircle2 },
                  { label: "Base Chain Check", status: "PASSED", icon: CheckCircle2 },
                  { label: "Market Cap > $100M", status: "PASSED", icon: CheckCircle2 },
                  { label: "Liquidity > $500K", status: "PASSED", icon: CheckCircle2 },
                  { label: "Token Age > 30 Days", status: "PASSED", icon: CheckCircle2 }
                ].map((rule, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-[#0A0A0B] rounded-lg border border-[#1F1F23]">
                    <div className="flex items-center gap-3">
                      <rule.icon className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-[#A1A1AA]">{rule.label}</span>
                    </div>
                    <span className="text-[10px] font-bold text-green-500 uppercase tracking-widest">{rule.status}</span>
                  </div>
                ))}
              </div>
              <div className="p-6 bg-[#0A0A0B] border-t border-[#1F1F23]">
                <button 
                  onClick={() => setShowPolicyModal(false)}
                  className="w-full py-3 bg-[#1F1F23] hover:bg-[#27272A] rounded-lg font-bold transition-all"
                >
                  Acknowledge and Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
