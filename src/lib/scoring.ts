/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConvictionBreakdown, TimingBreakdown } from './mockData';

// 1. Volume Consistency (0-25 pts)
export function calculateVolumeConsistency(volumes: number[]): number {
  let consecutiveGrowth = 0;
  for (let i = volumes.length - 1; i > 0; i--) {
    if (volumes[i] > volumes[i - 1]) consecutiveGrowth++;
    else break;
  }

  if (consecutiveGrowth >= 3) return 25;
  if (consecutiveGrowth === 2) return 15;
  if (consecutiveGrowth === 1) return 8;

  // Check for suspicious single spike
  const avg6days = volumes.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
  const todayRatio = volumes[6] / avg6days;
  if (todayRatio > 3) return 3;

  return 0;
}

// 2. Price Trend (0-25 pts)
export function calculatePriceTrend(prices: number[]): number {
  const current = prices[prices.length - 1];
  const ma7 = prices.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const ma14 = prices.reduce((a, b) => a + b, 0) / 14;

  if (current > ma7 && current > ma14) return 25;
  if (current > ma7 && current < ma14) return 15;
  if (current < ma7 && current > ma14) return 8;
  return 0;
}

// 3. Wallet Allocation (0-25 pts)
export function calculateWalletAllocation(pct: number): number {
  if (pct === 0) return 25;
  if (pct <= 5) return 20;
  if (pct <= 10) return 12;
  if (pct <= 20) return 4;
  return 0;
}

// 4. Volatility Penalty (0-25 pts)
export function calculateVolatilityPenalty(prices: number[]): number {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance) * 100;

  if (stdDev < 2) return 25;
  if (stdDev < 4) return 18;
  if (stdDev < 6) return 10;
  if (stdDev < 9) return 4;
  return 0;
}

// Timing: RSI (0-40 pts)
export function calculateRSIScore(rsi: number): number {
  if (rsi < 35) return 40;
  if (rsi < 45) return 32;
  if (rsi < 55) return 20;
  if (rsi < 65) return 8;
  if (rsi < 70) return 2;
  return 0;
}

// Timing: Price vs 24h High (0-30 pts)
export function calculatePriceVsHigh(current: number, high: number): number {
  const distancePct = ((high - current) / high) * 100;
  if (distancePct < 1) return 0;
  if (distancePct < 4) return 8;
  if (distancePct < 8) return 16;
  if (distancePct < 13) return 24;
  return 30;
}

// Timing: Volume Shape (0-30 pts)
export function calculateVolumeShape(volumes: number[]): number {
  const last3avg = (volumes[3] + volumes[4] + volumes[5]) / 3;
  const today = volumes[6];
  const todayRatio = today / last3avg;

  const growing3 = volumes[6] > volumes[5] && volumes[5] > volumes[4] && volumes[4] > volumes[3];
  const growing2 = volumes[6] > volumes[5] && volumes[5] > volumes[4];

  if (growing3) return 30;
  if (growing2) return 20;
  if (todayRatio > 1.2 && !growing2) return 10;
  if (todayRatio > 3) return 5;
  return 0;
}

export function computeConvictionScore(breakdown: ConvictionBreakdown): number {
  const total = breakdown.volumeConsistency + 
                breakdown.priceTrend + 
                breakdown.walletAllocation + 
                breakdown.volatilityPenalty + 
                breakdown.multiSourceBonus + 
                breakdown.whaleBonus;
  return Math.min(100, total);
}

export function computeTimingScore(breakdown: TimingBreakdown): number {
  return breakdown.rsi + breakdown.priceVsHigh + breakdown.volumeShape;
}
