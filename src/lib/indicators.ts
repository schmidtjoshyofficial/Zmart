
export function calculateRSI(prices: number[], period: number = 14) {
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }
  
  if (losses === 0) return 100;
  
  const rs = (gains / period) / (losses / period);
  const rsi = 100 - (100 / (1 + rs));
  
  return rsi;
}
