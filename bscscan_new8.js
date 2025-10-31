const { ethers } = require("ethers");
const chalk = require("chalk");
const inquirer = require("inquirer");
const axios = require('axios');
const https = require('https'); // For SSL agent

const { formatUnits, parseEther } = ethers;

const PRIVATE_KEY = process.env.PRIVATE_KEY; // Optional
const RPC_URL = "https://bsc-dataseed.binance.org/";

// Tokens
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";

// DEX Config: Updated fees/types; Aster as V2 fallback
const DEXES = {
  "Pancake V2": { router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", type: 'v2', fee: 3000 },
  "ApeSwap": { router: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7", type: 'v2', fee: 3000 },
  "BakerySwap": { router: "0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F", type: 'v2', fee: 3000 },
  "MDEX": { router: "0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8", type: 'v2', fee: 3000 },
  "BabySwap": { router: "0xC9a0F685F39d05D835c369036251ee3aEaaF3c47", type: 'v2', fee: 3000 },
  "NomiSwap": { router: "0xd654953d746f0b114d1f85332dc43446ac79413d", type: 'v2', fee: 3000 },
 
};

// ABIs (unchanged)
const V2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external pure returns (uint256 amountOut)"
];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address pair)"];
const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

// Setup
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

// SSL Agent for OpenOcean (ignore self-signed)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Config (unchanged)
const SCAN_INTERVAL = 30000;
const MIN_GROSS_PCT = 0.3;
const MIN_NET_USD = 1;
const MAX_SLIPPAGE_PCT = 0.5;
const FLASH_FEE_BPS = 5;
const GAS_EST_USD = 2;
const BNB_PRICE_USD = 1110;

// Contracts
const contracts = {};
Object.entries(DEXES).forEach(([name, config]) => {
  if (config.type === 'v2') contracts[name] = { router: new ethers.Contract(config.router, V2_ROUTER_ABI, provider) };
  else if (config.type === 'v3') contracts[name] = {
    quoter: new ethers.Contract(config.quoter, V3_QUOTER_ABI, provider),
    fee: config.fee
  };
});

class PriceMonitor {
  async getPrice(name, config, amountIn) {
    try {
      if (config.api) { // OpenOcean with SSL ignore
        const url = `https://openocean.finance/api/v3/bsc/quote?inToken=${WBNB_ADDRESS}&outToken=${USDT_ADDRESS}&amount=${amountIn.toString()}`;
        const res = await axios.get(url, { httpsAgent });
        const data = res.data;
        return parseFloat(data.outAmount) / 1e18 * 100; // Scale to per-1
      } else if (config.type === 'v2') {
        const path = [WBNB_ADDRESS, USDT_ADDRESS];
        const amounts = await contracts[name].router.getAmountsOut(amountIn, path);
        return Number(formatUnits(amounts[1], 18)) * 100; // Scale
      } else if (config.type === 'v3') {
        const amountOut = await contracts[name].quoter.quoteExactInputSingle.call(
          WBNB_ADDRESS, USDT_ADDRESS, config.fee, amountIn, 0 // sqrtPriceLimit=0
        );
        if (amountOut.eq(0)) throw new Error('Zero output');
        return Number(formatUnits(amountOut, 18)) * 100;
      }
    } catch (error) {
      console.log(chalk.yellow(`${name}: Fetch failed - ${error.message}`));
      return null;
    }
  }

  async getLiquidity(name, config) {
    try {
      if (config.type === 'v2') {
        const factoryAddr = await contracts[name].router.factory();
        const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
        const pairAddr = await factory.getPair(WBNB_ADDRESS, USDT_ADDRESS);
        if (pairAddr === ethers.ZeroAddress) return { wbnbReserve: 0 };
        const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
        const { reserve0, reserve1 } = await pair.getReserves();
        const token0 = await pair.token0();
        const wbnbReserve = token0.toLowerCase() === WBNB_ADDRESS.toLowerCase() ? reserve0 : reserve1;
        return { wbnbReserve: Number(formatUnits(wbnbReserve, 18)) };
      }
      // V3/Agg: Approx or skip
      return { wbnbReserve: 'N/A' };
    } catch {
      return { wbnbReserve: 0 };
    }
  }

  async scan() {
    const amountIn = parseEther('0.01');
    const prices = {};
    const liqs = {};

    const promises = Object.entries(DEXES).map(async ([name, config]) => {
      const price = await this.getPrice(name, config, amountIn);
      prices[name] = price;
      liqs[name] = await this.getLiquidity(name, config);
    });
    await Promise.all(promises);

    // Filter valid
    const validPrices = Object.fromEntries(Object.entries(prices).filter(([_, p]) => p !== null && liqs[_]?.wbnbReserve > 10));

    // Best buy/sell
    let bestBuy = { name: null, price: Infinity };
    let bestSell = { name: null, price: -Infinity };
    Object.entries(validPrices).forEach(([name, price]) => {
      if (price < bestBuy.price) bestBuy = { name, price };
      if (price > bestSell.price) bestSell = { name, price };
    });

    // Table
    console.log(chalk.blue(`\n💰 WBNB/USDT Prices (USDT per 1 WBNB) | Diff vs. Pancake V2 (%) | Liq (WBNB Reserve)`));
    console.log(chalk.blue("-".repeat(80)));
    const refPrice = prices["Pancake V2"];
    Object.entries(prices).forEach(([name, price]) => {
      if (price === null) {
        console.log(chalk.red(`  ${name.padEnd(20)}: Failed`));
        return;
      }
      const diff = refPrice ? ((price - refPrice) / refPrice * 100).toFixed(2) : 'N/A';
      const diffColor = parseFloat(diff) > 0 ? chalk.green(`+${diff}%`) : parseFloat(diff) < 0 ? chalk.red(`${diff}%`) : chalk.gray(`${diff}%`);
      const liqStr = liqs[name]?.wbnbReserve > 100 ? chalk.green(liqs[name].wbnbReserve.toFixed(0)) : liqs[name]?.wbnbReserve > 10 ? chalk.yellow(liqs[name].wbnbReserve.toFixed(0)) : chalk.red('Low');
      console.log(`  ${name.padEnd(20)}: ${price.toFixed(4)} USDT | ${diffColor} | ${liqStr}`);
    });
    console.log(chalk.blue("-".repeat(80)));

    if (bestBuy.name && bestSell.name && bestSell.price > bestBuy.price + 0.01) { // Min 0.01 diff
      const grossSpread = ((bestSell.price - bestBuy.price) / bestBuy.price * 100).toFixed(2);
      console.log(chalk.green(`\n🎯 Opp: Buy on ${bestBuy.name} (${bestBuy.price.toFixed(4)} USDT) → Sell on ${bestSell.name} (${bestSell.price.toFixed(4)} USDT)`));
      console.log(chalk.green(`   Gross Spread: ${grossSpread}%`));

      // Improved sim
      const minLiq = Math.min(liqs[bestBuy.name]?.wbnbReserve || 1000, liqs[bestSell.name]?.wbnbReserve || 1000);
      const size = Math.min(1, minLiq * 0.01); // 1% pool max
      const sellOut = bestSell.price * size;
      const buyOut = sellOut / bestBuy.price;
      const slipDrag = size * MAX_SLIPPAGE_PCT / 100 * 2; // Roundtrip
      const dexFee = size * bestSell.price * (0.003 * 2); // 0.3% per leg avg
      const flashFee = size * bestSell.price * (FLASH_FEE_BPS / 10000);
      const netBNB = buyOut - size - slipDrag;
      const netUSD = netBNB * bestSell.price - dexFee - flashFee - GAS_EST_USD;
      const netPct = (netUSD / (size * bestSell.price)) * 100;

      console.log(chalk.gray(`   Sim (${size.toFixed(2)} BNB, liq-capped): Net ${netPct.toFixed(2)}% (~$${netUSD.toFixed(2)} USD)`));

      if (netPct > MIN_GROSS_PCT && netUSD > MIN_NET_USD) {
        console.log(chalk.green(`   ✅ PROFITABLE!`));
        if (wallet) {
          const { execute } = await inquirer.prompt([{ type: 'confirm', name: 'execute', message: 'Auto-exec via flash loan?', default: false }]);
          if (execute) {
            // Placeholder: Integrate Aave flashArbitrage
            console.log(chalk.yellow('🚀 Executing via Aave V3... (Tx hash placeholder)'));
          }
        }
      } else {
        console.log(chalk.yellow(`   ❌ Not profitable (fees/slip eat spread)`));
      }
    } else {
      console.log(chalk.yellow('   ❌ No viable opp (tight market or low liq)'));
    }
  }

  async run() {
    console.log(chalk.cyan('🚀 Fixed BSC DEX Price Monitor Started (WBNB/USDT)'));
    console.log(chalk.cyan(`   Threshold: >${MIN_GROSS_PCT}% gross, >$${MIN_NET_USD} net | Scan: ${SCAN_INTERVAL/1000}s`));
    while (true) {
      await this.scan();
      await new Promise(r => setTimeout(r, SCAN_INTERVAL));
    }
  }
}

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Stopping...'));
  process.exit(0);
});

const monitor = new PriceMonitor();
monitor.run().catch(console.error);