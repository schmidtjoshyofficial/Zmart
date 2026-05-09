import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs/promises";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, Type } from "@google/genai";
import {
  calculateVolumeConsistency,
  calculatePriceTrend,
  calculateWalletAllocation,
  calculateVolatilityPenalty,
  calculateRSIScore,
  calculatePriceVsHigh,
  calculateVolumeShape,
  computeConvictionScore,
  computeTimingScore,
} from "./src/lib/scoring";
import { calculateRSI } from "./src/lib/indicators";

const execPromise = promisify(exec);
const PORT = Number(process.env.PORT || 3000);
const CYCLE_MS = Number(process.env.CYCLE_INTERVAL_MINUTES || 60) * 60 * 1000;
const EXECUTE_TRADES = process.env.EXECUTE_TRADES === "true";
const MANAGED_EXECUTION_WALLET = String(process.env.MANAGED_EXECUTION_WALLET || "").trim();
const ZERION_API_KEY = process.env.ZERION_API_KEY || "";
const ZERION_BASE_URL = "https://api.zerion.io/v1";

const cache: Record<string, { data: any, timestamp: number }> = {};
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

const JOURNAL_PATH = path.join(process.cwd(), "journal.json");
const STATE_PATH = path.join(process.cwd(), "agent-state.json");
const USERS_PATH = path.join(process.cwd(), "users.json");

const getZerionHeaders = () => ({
  'Authorization': `Basic ${Buffer.from(ZERION_API_KEY + ':').toString('base64')}`,
  'Accept': 'application/json'
});

type Action = "buy" | "skip";

interface Policy {
  maxSingleTradeUsd: number;
  maxDailySpendUsd: number;
  maxWeeklySpendUsd: number;
  maxTradesPerDay: number;
  cooldownBetweenTradesMinutes: number;
  allowedChains: string[];
  minMarketCapUsd: number;
  minLiquidityUsd: number;
  minTokenAgeDays: number;
  minConvictionScore: number;
  minTimingScore: number;
  minCombinedScore: number;
  emergencyStop: boolean;
}
interface CandidateToken {
  id: string;
  symbol: string;
  name: string;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  high_24h: number;
  current_price: number;
  ath_date?: string;
  sourceTags: string[];
}
interface JournalEntry {
  timestamp: string;
  userId: string;
  token: string;
  symbol: string;
  action: Action;
  amountUsd: number;
  convictionScore: number;
  timingScore: number;
  combinedScore: number | null;
  reason: string;
  txHash: string | null;
  walletAddress: string;
}
interface UserAccount {
  id: string;
  name: string;
  walletAddress: string;
  walletSecretHint?: string;
  telegramChatId?: string;
  createdAt: string;
  isAgentEnabled: boolean;
  whaleWallets: string[];
}
interface AgentState {
  isRunning: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  lastRecommendation: JournalEntry | null;
  latestWatchlist: CandidateToken[];
  monitoredTokenCount: number;
  policy: Policy;
}

const DEFAULT_POLICY: Policy = {
  maxSingleTradeUsd: 50,
  maxDailySpendUsd: 50,
  maxWeeklySpendUsd: 150,
  maxTradesPerDay: 3,
  cooldownBetweenTradesMinutes: 60,
  allowedChains: ["base"],
  minMarketCapUsd: 100_000_000,
  minLiquidityUsd: 500_000,
  minTokenAgeDays: 30,
  minConvictionScore: 45,
  minTimingScore: 40,
  minCombinedScore: 48,
  emergencyStop: false,
};

const WHITELIST = ["ethereum", "wrapped-bitcoin", "coinbase-wrapped-btc", "aerodrome-finance", "based-brett"];
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDE", "TUSD", "FDUSD"]);
const DEFAULT_WHALE_WALLETS = [
  "0x16a27462b4d61bdd72cbbabd3e43e11791f7a28c",
  "0x564e82722bb9a4e46f48875c25de11aad310883e",
  "0x307576dd4f73f91bb8c4a2edb762938e8e067d31",
  "0xbad36f8edd1e2109baa37197c05074151a70cc05",
  "0xbefa750ed568cc84970eb4fd506af4ff599c42d0",
  "0xe274c0b274c9f5ae1ee565c3845b3dff59661cda",
  "0xa3586764d08f9562338a8f7a4bd42f855ab29bd1",
  "0xcf748f1bd1e2a1e2a1cef35a480acfd5220c9e7d",
  "0xf8191d98ae98d2f7abdfb63a9b0b812b93c873aa",
  "0xa7d587fe21392fa6c2c4a0a3357ec8937b393044",
];

let scheduler: NodeJS.Timeout | null = null;
let telegramPoller: NodeJS.Timeout | null = null;
let telegramOffset = 0;
let memoryState: AgentState = {
  isRunning: false,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
  lastRecommendation: null,
  latestWatchlist: [],
  monitoredTokenCount: 0,
  policy: DEFAULT_POLICY,
};

async function ensureFiles() {
  try { await fs.access(JOURNAL_PATH); } catch { await fs.writeFile(JOURNAL_PATH, "[]", "utf8"); }
  try { await fs.access(USERS_PATH); } catch { await fs.writeFile(USERS_PATH, "[]", "utf8"); }
  try { await fs.access(STATE_PATH); } catch { await fs.writeFile(STATE_PATH, JSON.stringify(memoryState, null, 2), "utf8"); }
}
async function readJournal(): Promise<JournalEntry[]> { return JSON.parse(await fs.readFile(JOURNAL_PATH, "utf8")); }
async function readUsers(): Promise<UserAccount[]> { return JSON.parse(await fs.readFile(USERS_PATH, "utf8")); }
async function writeUsers(users: UserAccount[]) { await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), "utf8"); }
async function persistState() { await fs.writeFile(STATE_PATH, JSON.stringify(memoryState, null, 2), "utf8"); }
function id() { return `usr_${Math.random().toString(36).slice(2, 10)}`; }
function isValidEvmAddress(address: string) { return /^0x[a-fA-F0-9]{40}$/.test(address); }
function getEffectiveWhaleWallets(user: UserAccount) { return user.whaleWallets.length > 0 ? user.whaleWallets : DEFAULT_WHALE_WALLETS; }

async function sendTelegramMessage(chatId: string, text: string, options: any = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { 
    chat_id: chatId, 
    text, 
    parse_mode: "Markdown",
    ...options 
  }, { timeout: 10_000 }).catch((e) => console.error("telegram_send_error", e?.response?.data || e.message));
}
async function appendJournal(entry: JournalEntry) {
  const journal = await readJournal();
  journal.unshift(entry);
  await fs.writeFile(JOURNAL_PATH, JSON.stringify(journal.slice(0, 2000), null, 2), "utf8");
  const users = await readUsers();
  const user = users.find((u) => u.id === entry.userId);
  if (user?.telegramChatId) {
    const summary = entry.action === "buy"
      ? `BOUGHT $${entry.amountUsd} ${entry.symbol} | C:${entry.convictionScore} T:${entry.timingScore}`
      : `SKIPPED ${entry.symbol} | ${entry.reason}`;
    await sendTelegramMessage(user.telegramChatId, `Conviction DCA (Base)\n${summary}`);
  }
}


async function createManagedWalletForUser(user: UserAccount, users: UserAccount[]) {
  // Since we're bypassing CLI, we generate a mock wallet for now.
  // In a real prod environment, you'd use ethers.Wallet.createRandom()
  const mockAddress = "0x" + Array.from({length: 40}, () => Math.floor(Math.random() * 16).toString(16)).join("");
  
  user.walletAddress = mockAddress;
  user.isAgentEnabled = true;
  user.walletSecretHint = "managed_by_agent_api";
  await writeUsers(users);

  return {
    walletAddress: mockAddress,
    privateKey: "stored_in_secure_vault",
    mnemonic: null
  };
}

async function fetchPortfolio(address: string) {
  const cacheKey = `portfolio_${address}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_TTL_MS) return cache[cacheKey].data;

  try {
    const res = await axios.get(`${ZERION_BASE_URL}/wallets/${address}/portfolio?filter[chain_ids]=base`, { 
      headers: getZerionHeaders(),
      timeout: 10_000 
    });
    const portfolio = res.data?.data?.attributes;
    const result = {
      total_value: portfolio?.total?.value || 0,
      positions: [] 
    };
    cache[cacheKey] = { data: result, timestamp: Date.now() };
    return result;
  } catch (e: any) {
    if (e?.response?.status === 429) console.warn(`[Zerion API] Rate limited (429) on portfolio ${address}`);
    else console.error(`[Zerion API] Portfolio fetch failed: ${e.message}`);
    return cache[cacheKey]?.data || { total_value: 0, positions: [] };
  }
}

async function fetchPositions(address: string) {
  const cacheKey = `positions_${address}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].timestamp < CACHE_TTL_MS) return cache[cacheKey].data;

  try {
    const res = await axios.get(`${ZERION_BASE_URL}/wallets/${address}/positions/?filter[chain_ids]=base`, { 
      headers: getZerionHeaders(),
      timeout: 10_000 
    });
    const result = res.data?.data || [];
    cache[cacheKey] = { data: result, timestamp: Date.now() };
    return result;
  } catch (e: any) {
    if (e?.response?.status === 429) console.warn(`[Zerion API] Rate limited (429) on positions ${address}`);
    return cache[cacheKey]?.data || []; 
  }
}
async function fetchCoinGeckoBaseMarkets(perPage: number) {
  const response = await axios.get("https://api.coingecko.com/api/v3/coins/markets", { params: { vs_currency: "usd", category: "base-ecosystem", order: "market_cap_desc", per_page: perPage, page: 1, sparkline: false, price_change_percentage: "24h" }, timeout: 20_000 });
  return response.data as CandidateToken[];
}
async function fetchCoinGeckoTrendingSymbols() {
  const response = await axios.get("https://api.coingecko.com/api/v3/search/trending", { timeout: 15_000 });
  return (response.data?.coins || []).map((c: any) => String(c.item?.symbol || "").toUpperCase()).filter(Boolean);
}
async function fetchHistory(tokenId: string) {
  const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${tokenId}/market_chart`, { params: { vs_currency: "usd", days: 14 }, timeout: 20_000 });
  return response.data;
}
async function fetchGeminiSymbols() {
  if (!process.env.GEMINI_API_KEY) return [] as string[];
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const res = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "Find 8-15 Base chain tokens with bullish momentum. Exclude stablecoins, market cap below 100M, tokens that pumped >30% in 24h, and very new tokens. Return only JSON array: [{symbol,name}]",
    config: { responseMimeType: "application/json", responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { symbol: { type: Type.STRING }, name: { type: Type.STRING } }, required: ["symbol", "name"] } } },
  });
  const parsed = JSON.parse(res.text || "[]");
  return parsed.map((t: any) => String(t.symbol || "").toUpperCase()).filter(Boolean);
}
async function checkWhaleBonus(symbol: string, whaleWallets: string[]) {
  if (whaleWallets.length === 0) return 0;
  let count = 0;
  const since = Date.now() - 6 * 60 * 60 * 1000;
  for (const whale of whaleWallets) {
    try {
      // Add a small delay to avoid 429
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const res = await axios.get(`${ZERION_BASE_URL}/wallets/${whale}/transactions/?filter[chain_ids]=base`, { 
        headers: getZerionHeaders(),
        timeout: 10_000 
      });
      const txs = res.data?.data || [];
      const bought = Array.isArray(txs) && txs.some((tx: any) => {
        const attr = tx.attributes;
        const ts = new Date(attr?.mined_at || 0).getTime();
        const operations = attr?.operations || [];
        return ts >= since && operations.some((op: any) => 
          op.type === "receive" && String(op.symbol || "").toUpperCase() === symbol.toUpperCase()
        );
      });
      if (bought) count += 1;
    } catch { continue; }
  }
  return count >= 2 ? 15 : 0;
}
function tokenAgeDays(t: CandidateToken) { if (!t.ath_date) return 999; return Math.floor((Date.now() - new Date(t.ath_date).getTime()) / (1000 * 60 * 60 * 24)); }
function passesHardFilters(token: CandidateToken, policy: Policy) {
  if (STABLECOIN_SYMBOLS.has(token.symbol.toUpperCase())) return false;
  if ((token.market_cap || 0) < policy.minMarketCapUsd) return false;
  if ((token.total_volume || 0) < policy.minLiquidityUsd) return false;
  if ((token.price_change_percentage_24h || 0) >= 30) return false;
  if (tokenAgeDays(token) < policy.minTokenAgeDays) return false;
  return true;
}
async function buildWatchlist(policy: Policy) {
  const [base50, geckoTrending, geminiSymbols] = await Promise.all([fetchCoinGeckoBaseMarkets(50), fetchCoinGeckoTrendingSymbols().catch(() => []), fetchGeminiSymbols().catch(() => [])]);
  const geckoSet = new Set(geckoTrending);
  const geminiSet = new Set(geminiSymbols);
  const wlSet = new Set(WHITELIST);
  const picked = base50.filter((t) => wlSet.has(t.id) || geckoSet.has(t.symbol.toUpperCase()) || geminiSet.has(t.symbol.toUpperCase()));
  const combined = picked.length > 0 ? picked : base50;
  return combined.filter((t) => passesHardFilters(t, policy)).slice(0, 50).map((t) => ({ ...t, sourceTags: [wlSet.has(t.id) ? "whitelist" : "", geckoSet.has(t.symbol.toUpperCase()) ? "gecko" : "", geminiSet.has(t.symbol.toUpperCase()) ? "gemini" : ""].filter(Boolean) }));
}
function getStartOfUtcDay(d = new Date()) { return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
function getStartOfUtcWeek(d = new Date()) { const day = d.getUTCDay(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); }
async function getSpendStats(userId: string) {
  const journal = await readJournal();
  const dayStart = getStartOfUtcDay(new Date());
  const weekStart = getStartOfUtcWeek(new Date());
  let dailySpend = 0, weeklySpend = 0, dailyTrades = 0; let lastBuyAt: Date | null = null;
  for (const j of journal) {
    if (j.userId !== userId || j.action !== "buy") continue;
    const ts = new Date(j.timestamp).getTime();
    if (ts >= dayStart) { dailySpend += j.amountUsd; dailyTrades += 1; }
    if (ts >= weekStart) weeklySpend += j.amountUsd;
    if (!lastBuyAt) lastBuyAt = new Date(j.timestamp);
  }
  return { dailySpend, weeklySpend, dailyTrades, lastBuyAt };
}
function runPolicyChecks(policy: Policy, stats: Awaited<ReturnType<typeof getSpendStats>>) {
  if (policy.emergencyStop) return "emergency_stop";
  if (stats.dailySpend >= policy.maxDailySpendUsd) return "daily_spend_limit_reached";
  if (stats.weeklySpend >= policy.maxWeeklySpendUsd) return "weekly_spend_limit_reached";
  if (stats.dailyTrades >= policy.maxTradesPerDay) return "daily_trade_count_reached";
  if (stats.lastBuyAt && Date.now() < stats.lastBuyAt.getTime() + policy.cooldownBetweenTradesMinutes * 60 * 1000) return "cooldown_active";
  return null;
}
function getDecision(convictionScore: number, timingScore: number, policy: Policy) {
  if (convictionScore < policy.minConvictionScore) return { action: "skip" as const, amountUsd: 0, reason: "conviction_gate_failed" };
  if (timingScore < policy.minTimingScore) return { action: "skip" as const, amountUsd: 0, reason: "timing_gate_failed" };
  const combined = convictionScore * 0.5 + timingScore * 0.5;
  if (combined < policy.minCombinedScore) return { action: "skip" as const, amountUsd: 0, reason: "combined_below_threshold", combined };
  if (combined < 65) return { action: "buy" as const, amountUsd: 10, reason: "low_confidence_entry", combined };
  if (combined < 80) return { action: "buy" as const, amountUsd: 25, reason: "medium_confidence_entry", combined };
  return { action: "buy" as const, amountUsd: 50, reason: "high_confidence_entry", combined };
}
async function executeSwap(_user: UserAccount, symbol: string, amountUsd: number) {
  if (!EXECUTE_TRADES) return { txHash: null };
  console.warn(`[Swap] Bypassing Zerion CLI. Swaps via direct REST API require manual signing. Logging intent only.`);
  // For a real implementation without CLI, you would get a quote from /transactions/swap/quote 
  // and then sign it locally using ethers.js
  return { txHash: "manual_execution_required_without_cli" };
}
async function scoreToken(token: CandidateToken, portfolio: any, whaleWallets: string[]) {
  const history = await fetchHistory(token.id);
  const prices = (history?.prices || []).map((p: any) => p[1]);
  const volumes = (history?.total_volumes || []).map((v: any) => v[1]);
  if (prices.length < 14 || volumes.length < 7) return null;
  const tokenPosition = (portfolio?.positions || []).find((p: any) => String(p.symbol || "").toUpperCase() === token.symbol.toUpperCase());
  const walletAllocPct = portfolio?.total_value ? (((tokenPosition?.amount || 0) * (token.current_price || 0)) / portfolio.total_value) * 100 : 0;
  if (walletAllocPct > 20) return null;
  const convictionScore = computeConvictionScore({
    volumeConsistency: calculateVolumeConsistency(volumes.slice(-7)),
    priceTrend: calculatePriceTrend(prices.slice(-14)),
    walletAllocation: calculateWalletAllocation(walletAllocPct),
    volatilityPenalty: calculateVolatilityPenalty(prices.slice(-14)),
    multiSourceBonus: token.sourceTags.includes("gemini") && token.sourceTags.includes("gecko") ? 10 : 0,
    whaleBonus: await checkWhaleBonus(token.symbol, whaleWallets),
  });
  const timingScore = computeTimingScore({
    rsi: calculateRSIScore(calculateRSI(prices, 14)),
    priceVsHigh: calculatePriceVsHigh(token.current_price || 0, token.high_24h || 0),
    volumeShape: calculateVolumeShape(volumes.slice(-7)),
  });
  return { token, convictionScore, timingScore, combinedScore: convictionScore * 0.5 + timingScore * 0.5 };
}
async function runAgentForUser(user: UserAccount, watchlist: CandidateToken[], policy: Policy) {
  console.log(`[Cycle] Processing user ${user.name} (${user.id})...`);
  if (!user.walletAddress) throw new Error("wallet_not_set");
  const stats = await getSpendStats(user.id);
  const block = runPolicyChecks(policy, stats);
  if (block) throw new Error(`policy_blocked:${block}`);
  const portfolio = await fetchPortfolio(user.walletAddress);
  const scored = (await Promise.all(watchlist.map((t) => scoreToken(t, portfolio, getEffectiveWhaleWallets(user))))).filter(Boolean) as any[];
  if (scored.length === 0) throw new Error("no_valid_candidates");
  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const best = scored[0];
  const decision = getDecision(best.convictionScore, best.timingScore, policy);
  let finalAction: Action = decision.action;
  let finalReason = decision.reason;
  let finalAmount = decision.amountUsd;
  let txHash: string | null = null;
  if (finalAction === "buy") {
    console.log(`[Decision] BUY ${best.token.symbol} for user ${user.id} (Amount: $${finalAmount})`);
    const spendLeft = Math.max(0, policy.maxDailySpendUsd - stats.dailySpend);
    const amount = Math.min(finalAmount, policy.maxSingleTradeUsd, spendLeft);
    if (amount > 0) { txHash = (await executeSwap(user, best.token.symbol, amount)).txHash; finalAmount = amount; } else { finalAction = "skip"; finalReason = "daily_spend_exhausted"; finalAmount = 0; }
  }
  await appendJournal({
    timestamp: new Date().toISOString(),
    userId: user.id,
    token: best.token.name,
    symbol: best.token.symbol,
    action: finalAction,
    amountUsd: finalAmount,
    convictionScore: Number(best.convictionScore.toFixed(2)),
    timingScore: Number(best.timingScore.toFixed(2)),
    combinedScore: finalAction === "buy" || finalReason !== "combined_below_threshold" ? Number((decision.combined ?? best.combinedScore).toFixed(2)) : null,
    reason: finalReason,
    txHash,
    walletAddress: user.walletAddress,
  });
}
async function runAgentCycle() {
  if (memoryState.isRunning) return;
  console.log(`[Cycle] Starting agent cycle at ${new Date().toISOString()}`);
  memoryState.isRunning = true;
  memoryState.lastError = null;
  await persistState();
  try {
    const watchlist = await buildWatchlist(memoryState.policy);
    memoryState.latestWatchlist = watchlist;
    memoryState.monitoredTokenCount = watchlist.length;
    const users = (await readUsers()).filter((u) => u.isAgentEnabled);
    for (const user of users) {
      try { await runAgentForUser(user, watchlist, memoryState.policy); } catch (e: any) {
        console.error(`[Cycle] User ${user.id} failed: ${e.message}`);
        await appendJournal({ timestamp: new Date().toISOString(), userId: user.id, token: "N/A", symbol: "N/A", action: "skip", amountUsd: 0, convictionScore: 0, timingScore: 0, combinedScore: null, reason: e?.message || "user_cycle_failed", txHash: null, walletAddress: user.walletAddress || "unset" });
      }
    }
  } catch (e: any) { 
    console.error(`[Cycle] Fatal error: ${e.message}`);
    memoryState.lastError = e?.message || "cycle_failed"; 
  }
  finally {
    console.log(`[Cycle] Finished. Next run at ${new Date(Date.now() + CYCLE_MS).toISOString()}`);
    memoryState.isRunning = false;
    memoryState.lastRunAt = new Date().toISOString();
    memoryState.nextRunAt = new Date(Date.now() + CYCLE_MS).toISOString();
    await persistState();
  }
}
function startScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = setInterval(() => runAgentCycle().catch(console.error), CYCLE_MS);
}

async function ensureTelegramUser(chatId: string, username?: string) {
  const users = await readUsers();
  let user = users.find((u) => u.telegramChatId === chatId);
  if (user) return user;
  user = { id: id(), name: username || `tg_${chatId}`, walletAddress: "", telegramChatId: chatId, createdAt: new Date().toISOString(), isAgentEnabled: false, whaleWallets: [...DEFAULT_WHALE_WALLETS] };
  users.push(user);
  await writeUsers(users);
  return user;
}
async function handleTelegramCommand(update: any) {
  const msg = update?.message;
  const callback = update?.callback_query;
  
  let chatId: string;
  let text: string;
  let from: any;

  if (callback) {
    chatId = String(callback.message.chat.id);
    text = callback.data;
    from = callback.from;
    // Acknowledge the callback to remove loading state on button
    axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: callback.id }).catch(() => {});
  } else if (msg) {
    chatId = String(msg.chat.id);
    text = String(msg.text || "").trim();
    from = msg.from;
  } else {
    return;
  }

  if (!text.startsWith("/")) return;

  const user = await ensureTelegramUser(chatId, from?.username || from?.first_name);
  const users = await readUsers();
  const me = users.find((u) => u.id === user.id)!;
  const [rawCommand, ...rest] = text.split(" ");
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();

  const webAppUrl = process.env.RAILWAY_STATIC_URL ? `https://${process.env.RAILWAY_STATIC_URL}` : null;

  // Main Menu Buttons
  const mainMenu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Check Status", callback_data: "/status" }, { text: "🚀 Run Cycle", callback_data: "/run" }],
        [{ text: "💰 Deposit Info", callback_data: "/deposit" }, { text: "📖 View Journal", callback_data: "/journal" }],
        [{ text: "🐋 Whale List", callback_data: "/whales" }, { text: "❓ Help", callback_data: "/help" }],
        [{ text: "🛑 Pause", callback_data: "/pause" }, { text: "✅ Resume", callback_data: "/resume" }],
        webAppUrl ? [{ text: "🌐 Open Web Dashboard", url: webAppUrl }] : []
      ].filter(r => r.length > 0)
    }
  };

  if (command === "/start" || command === "/help") {
    const welcome = [
      "🚀 *Conviction DCA Agent*",
      "Autonomous discovery and execution on Base chain.",
      "",
      "🛡️ *Security*: We monitor your wallet for weighting, but trades execute from the operator's managed fund.",
      "",
      "👇 *Use the buttons below to control your agent:*",
    ].join("\n");
    return sendTelegramMessage(chatId, welcome, mainMenu);
  }

  if (command === "/register") {
    if (!arg || !isValidEvmAddress(arg)) {
      return sendTelegramMessage(chatId, "❌ *Invalid wallet.*\nSend: `/register 0xYourBaseAddress`", { parse_mode: "Markdown" });
    }
    me.walletAddress = arg;
    me.isAgentEnabled = true;
    await writeUsers(users);
    return sendTelegramMessage(chatId, `✅ *Wallet Registered!*\nAddress: \`${arg}\`\n\nThe agent is now monitoring this wallet.`, mainMenu);
  }

  if (command === "/status") {
    const status = [
      `🤖 *Agent:* ${me.isAgentEnabled ? "✅ ACTIVE" : "🛑 PAUSED"}`,
      `👛 *Wallet:* \`${me.walletAddress || "Not Set"}\``,
      `📊 *Tokens:* ${memoryState.monitoredTokenCount}`,
      `🕒 *Last Run:* ${memoryState.lastRunAt ? new Date(memoryState.lastRunAt).toLocaleTimeString() : "_Never_"}`,
      "",
      me.walletAddress ? `💰 _Keep Base USDC in your wallet to enable portfolio-weighted trades._` : "⚠️ _Use /register to set up your wallet._"
    ].join("\n");
    return sendTelegramMessage(chatId, status, mainMenu);
  }

  if (command === "/deposit") {
    const depositText = [
      "💰 *Funding Your Agent*",
      "",
      "The agent looks at your portfolio balance to decide trade sizes. To allow the agent to trade for you, ensure you have *Base USDC* in your registered wallet:",
      "",
      `👛 *Your Wallet:* \`${me.walletAddress || "Not Registered"}\``,
      "",
      "1️⃣ Open your wallet (MetaMask, Coinbase Wallet, etc.)",
      "2️⃣ Ensure you are on the *Base* network.",
      "3️⃣ Deposit/Swap for *USDC*.",
      "",
      "_The agent will automatically detect your balance during the next cycle._"
    ].join("\n");
    return sendTelegramMessage(chatId, depositText, mainMenu);
  }

  if (command === "/run") { 
    runAgentCycle().catch(console.error); 
    return sendTelegramMessage(chatId, "🚀 *Manual scanning cycle initiated...*", mainMenu); 
  }

  if (command === "/journal") {
    const rows = (await readJournal()).filter((j) => j.userId === me.id).slice(0, 5);
    if (!rows.length) return sendTelegramMessage(chatId, "📖 *Journal is empty.*", mainMenu);
    
    const logs = rows.map((j) => {
      const time = new Date(j.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const emoji = j.action === "buy" ? "🟢" : "⚪";
      return `\`${time}\` | ${emoji} *${j.symbol}* ${j.amountUsd ? `($${j.amountUsd})` : ""} | _${j.reason}_`;
    }).join("\n");
    
    return sendTelegramMessage(chatId, `📖 *Recent Activity:*\n\n${logs}`, mainMenu);
  }

  if (command === "/whales") {
    if (!arg) {
      const current = getEffectiveWhaleWallets(me);
      return sendTelegramMessage(chatId, `🐋 *Whale Tracking* (${current.length})\n\n\`${current.join("\n")}\`\n\nTo update: \`/whales 0x..., 0x...\``, mainMenu);
    }
    const wallets = arg.split(",").map((x) => x.trim()).filter(Boolean);
    if (!wallets.every(isValidEvmAddress)) return sendTelegramMessage(chatId, "❌ *Invalid format.*", mainMenu);
    me.whaleWallets = wallets; 
    await writeUsers(users);
    return sendTelegramMessage(chatId, `✅ *Whale list updated!*`, mainMenu);
  }

  if (command === "/pause") { 
    me.isAgentEnabled = false; 
    await writeUsers(users); 
    return sendTelegramMessage(chatId, "🛑 *Agent Paused.*", mainMenu); 
  }

  if (command === "/resume") {
    if (!me.walletAddress) return sendTelegramMessage(chatId, "❌ *No wallet registered.*", mainMenu);
    me.isAgentEnabled = true; 
    await writeUsers(users); 
    return sendTelegramMessage(chatId, "✅ *Agent Resumed.*", mainMenu);
  }

  if (command === "/deletewallet") {
    me.walletAddress = "";
    me.isAgentEnabled = false;
    await writeUsers(users);
    return sendTelegramMessage(chatId, "🗑️ *Wallet Deleted.*", mainMenu);
  }
}
function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("[Telegram] TELEGRAM_BOT_TOKEN not set. Bot disabled.");
    return;
  }
  console.log("[Telegram] Starting bot poller...");
  telegramPoller = setInterval(async () => {
    try {
      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`;
      const response = await axios.get(url, { params: { timeout: 0, offset: telegramOffset + 1, allowed_updates: JSON.stringify(["message"]) }, timeout: 15_000 });
      for (const u of response.data?.result || []) { telegramOffset = Math.max(telegramOffset, u.update_id || 0); await handleTelegramCommand(u); }
    } catch {}
  }, 5000);
}

async function startServer() {
  await ensureFiles();
  const app = express();
  app.use(express.json());

  app.post("/api/users", async (req, res) => {
    try {
      const name = String(req.body?.name || "New User");
      const providedWallet = String(req.body?.walletAddress || "").trim();
      if (!isValidEvmAddress(providedWallet)) {
        return res.status(400).json({ error: "wallet_address_required_and_must_be_valid_evm_address" });
      }
      const walletAddress = providedWallet;
      const user: UserAccount = { id: id(), name, walletAddress, telegramChatId: req.body?.telegramChatId ? String(req.body.telegramChatId) : undefined, createdAt: new Date().toISOString(), isAgentEnabled: true, whaleWallets: [...DEFAULT_WHALE_WALLETS] };
      const users = await readUsers();
      users.push(user);
      await writeUsers(users);
      return res.json({ user, depositInstructions: { chain: "base", asset: "USDC", depositAddress: walletAddress, note: "Send Base USDC to this address, then the agent can trade for this user." } });
    } catch (e: any) { return res.status(500).json({ error: e?.message || "user_create_failed" }); }
  });
  app.get("/api/users", async (_req, res) => res.json(await readUsers()));
  app.patch("/api/users/:userId", async (req, res) => {
    const users = await readUsers();
    const idx = users.findIndex((u) => u.id === req.params.userId);
    if (idx < 0) return res.status(404).json({ error: "user_not_found" });
    if (typeof req.body?.isAgentEnabled === "boolean") users[idx].isAgentEnabled = req.body.isAgentEnabled;
    if (Array.isArray(req.body?.whaleWallets)) users[idx].whaleWallets = req.body.whaleWallets.map((w: any) => String(w));
    if (typeof req.body?.name === "string" && req.body.name.trim()) users[idx].name = req.body.name.trim();
    if (typeof req.body?.telegramChatId === "string" && req.body.telegramChatId.trim()) users[idx].telegramChatId = req.body.telegramChatId.trim();
    await writeUsers(users);
    res.json(users[idx]);
  });
  app.get("/api/users/:userId/deposit", async (req, res) => {
    const user = (await readUsers()).find((u) => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    res.json({ userId: user.id, chain: "base", asset: "USDC", depositAddress: user.walletAddress, note: "Deposit USDC on Base network only.", defaultWhaleWallets: getEffectiveWhaleWallets(user) });
  });
  app.get("/api/users/:userId/portfolio", async (req, res) => {
    const user = (await readUsers()).find((u) => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: "user_not_found" });
    try { res.json(await fetchPortfolio(user.walletAddress)); } catch (e: any) { res.status(500).json({ error: e?.message || "portfolio_failed" }); }
  });
  app.get("/api/portfolio/:address", async (req, res) => {
    try { 
      const [portfolio, positions] = await Promise.all([
        fetchPortfolio(req.params.address),
        fetchPositions(req.params.address)
      ]);
      res.json({ ...portfolio, positions }); 
    } catch (e: any) { res.status(500).json({ error: e?.message || "portfolio_failed" }); }
  });
  app.get("/api/tokens/base", async (_req, res) => {
    try { res.json(await fetchCoinGeckoBaseMarkets(50)); } catch (e: any) { res.status(500).json({ error: e?.message || "tokens_failed" }); }
  });
  app.get("/api/monitoring/watchlist", async (_req, res) => {
    res.json({ monitoredTokenCount: memoryState.monitoredTokenCount, tokens: memoryState.latestWatchlist.map((t) => ({ id: t.id, symbol: t.symbol, name: t.name, marketCap: t.market_cap, volume24h: t.total_volume, priceChange24h: t.price_change_percentage_24h, sources: t.sourceTags })) });
  });
  app.get("/api/history/:tokenId", async (req, res) => {
    try { res.json(await fetchHistory(req.params.tokenId)); } catch (e: any) { res.status(500).json({ error: e?.message || "history_failed" }); }
  });
  app.get("/api/journal", async (req, res) => {
    const userId = req.query.userId ? String(req.query.userId) : null;
    const journal = await readJournal();
    res.json(userId ? journal.filter((j) => j.userId === userId) : journal);
  });
  app.get("/api/agent/state", async (_req, res) => res.json(memoryState));
  app.get("/api/agent/default-whales", async (_req, res) => res.json({ wallets: DEFAULT_WHALE_WALLETS }));
  app.post("/api/agent/run", async (_req, res) => { runAgentCycle().catch(console.error); res.json({ status: "queued" }); });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
  startScheduler();
  startTelegramBot();
  runAgentCycle().catch(console.error);
}
startServer().catch((e) => { console.error("fatal_start_error", e); process.exit(1); });
