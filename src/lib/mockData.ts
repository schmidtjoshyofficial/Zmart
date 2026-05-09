/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TokenMetadata {
  symbol: string;
  name: string;
  id: string; // CoinGecko ID
  address?: string;
  marketCap: number;
  volume24h: number;
  priceChange24h: number;
  tokenAgeDays: number;
  onBase: boolean;
  isStablecoin: boolean;
  reason?: string;
}

export interface ConvictionBreakdown {
  volumeConsistency: number; // 0-25
  priceTrend: number; // 0-25
  walletAllocation: number; // 0-25
  volatilityPenalty: number; // 0-25
  multiSourceBonus: number; // 0-10
  whaleBonus: number; // 0-15
}

export interface TimingBreakdown {
  rsi: number; // 0-40
  priceVsHigh: number; // 0-30
  volumeShape: number; // 0-30
}

export interface TradeDecision {
  timestamp: string;
  token: string;
  symbol: string;
  action: 'buy' | 'skip';
  amountUsd: number;
  convictionScore: number;
  timingScore: number;
  combinedScore: number | null;
  reason: string;
}
