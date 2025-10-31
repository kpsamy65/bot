#!/usr/bin/env node
const ethers = require("ethers");
const inquirer = require("inquirer");
const chalk = require("chalk");

// ======================= CONFIG =========================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = "https://bsc-dataseed.binance.org/";

const FLASH_LOAN_CONTRACT = "0xe1dd72f31B9286F866A80595220b42078bFdc877";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_DECIMALS = 6;
const FLASH_FEE_BPS = 9; // 0.09%
const GAS_LIMIT = 500000;

const ROUTERS = {
  PancakeSwap: ethers.getAddress("0x10ed43c718714eb63d5aa57b78b54704e256024e"),
  BakerySwap: ethers.getAddress("0xcde540d7eafe93ac5fe6233bee57e1270d3e330f"),
  ApeSwap: ethers.getAddress("0xcf0febd3f17cef5b47b0cd257acf6025c5bff3b7"),
  BabyDogeSwap: ethers.getAddress("0xC9a0F685F39d05D835c369036251ee3aEaaF3c47"),
  MDEX: ethers.getAddress("0x7dae51bd3e3376b8c7c4900e9107f12be3af1ba8")
};

const FACTORIES = {
  PancakeSwap: "0xCA143cE32FE78F1F7019D7D551A6402fc5350C73",
  BakerySwap: "0x01Bf7c66C6bD861915cDAAE475042D3c4bAe16a7",
  ApeSwap: "0x0841bd0B734e4f5853f0dd8d7eA041C241fB0dA6",
  BabyDogeSwap: "0x4693B62E5FC9c0a45f89D62E6300a03c85F43137",
  MDEX: ethers.getAddress("0x5FBdB2315678aFecb367f032D93f642f64180aa3")
};

// ======================= ABIs =========================
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const FLASH_LOAN_CONTRACT_ABI = [
  "function executeArbitrage(address tokenBorrow, uint256 amount, bytes calldata dexData) external payable",
  "function getBalance(address token) external view returns (uint256)"
];

// ======================= SETUP =========================
if (!PRIVATE_KEY) {
  console.error(chalk.red("❌ PRIVATE_KEY environment variable is required"));
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const flashContract = new ethers.Contract(FLASH_LOAN_CONTRACT, FLASH_LOAN_CONTRACT_ABI, wallet);

const initializeDexes = () => {
  const dexes = {};
  for (const [dex, addr] of Object.entries(ROUTERS)) {
    try {
      const checksummedAddr = ethers.getAddress(addr);
      dexes[dex] = {
        name: dex,
        router: new ethers.Contract(checksummedAddr, ROUTER_ABI, provider),
        factory: new ethers.Contract(ethers.getAddress(FACTORIES[dex]), FACTORY_ABI, provider),
      };
    } catch (err) {
      console.log(chalk.yellow(`⚠️ Failed to init ${dex}: ${err.message}`));
    }
  }
  return dexes;
};

// ======================= BOT CLASS =========================
class ArbitrageBot {
  constructor() {
    this.dexes = initializeDexes();
    this.isRunning = false;
    this.currentLoanAmount = 0;
    this.autoMode = false;
  }

  async getAmountsOut(router, path, amountIn, timeout = 10000, dexName = '') {
    const checksumPath = path.map(addr => ethers.getAddress(addr));
    console.log(chalk.gray(`🔍 ${dexName} Path: ${checksumPath.join(' -> ')}`));
    try {
      const amounts = await Promise.race([
        router.getAmountsOut(amountIn, checksumPath),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ]);
      // Simple log: input and output formatted correctly based on path
      const inputDec = path[0] === WBNB_ADDRESS ? 18 : USDT_DECIMALS;
      const outputDec = path[path.length - 1] === WBNB_ADDRESS ? 18 : USDT_DECIMALS;
      const inputFormatted = Number(ethers.formatUnits(amounts[0], inputDec));
      const outputFormatted = Number(ethers.formatUnits(amounts[amounts.length - 1], outputDec));
      console.log(chalk.gray(`📊 ${dexName} Amounts: ${inputFormatted} -> ${outputFormatted}`));
      return amounts[amounts.length - 1];
    } catch (e) {
      console.log(chalk.red(`❌ ${dexName} Error: ${e.message}`));
      return null;
    }
  }

  async getSpotPrice(dexObj) {
    try {
      const pairAddr = await dexObj.factory.getPair(WBNB_ADDRESS, USDT_ADDRESS);
      if (pairAddr === ethers.ZeroAddress) {
        console.log(chalk.yellow(`⚠️ No pair for ${dexObj.name}`));
        return null;
      }
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
      const isToken0WBNB = token0 === WBNB_ADDRESS;
      const reserveWBNB = isToken0WBNB ? reserves[0] : reserves[1];
      const reserveUSDT = isToken0WBNB ? reserves[1] : reserves[0];
      const wbnbEth = Number(ethers.formatEther(reserveWBNB));
      const usdtNum = Number(ethers.formatUnits(reserveUSDT, USDT_DECIMALS));
      if (wbnbEth < 0.1 || usdtNum < 50) {
        console.log(chalk.yellow(`⚠️ Low liquidity on ${dexObj.name}: ${wbnbEth.toFixed(2)} BNB, ${usdtNum.toFixed(0)} USDT`));
        return null;
      }
      const price = usdtNum / wbnbEth; // USDT per BNB
      console.log(chalk.gray(`${dexObj.name} spot: ${price.toFixed(2)} USDT/BNB (liq: ${wbnbEth.toFixed(2)} BNB)`));
      return { price, reserveWBNB, reserveUSDT };
    } catch (e) {
      console.log(chalk.red(`❌ Error getting spot for ${dexObj.name}: ${e.message}`));
      return null;
    }
  }

  async calculateActualPrices() {
    const prices = {}; // Unified: USDT/BNB spot price

    const promises = Object.entries(this.dexes).map(async ([dex, obj]) => {
      const data = await this.getSpotPrice(obj);
      if (data && data.price > 100 && data.price < 2000) { // Sanity check
        prices[dex] = { ...data, rawReserveUSDT: data.reserveUSDT, rawReserveWBNB: data.reserveWBNB };
      }
    });

    await Promise.all(promises);
    console.log(chalk.blue("\n=== FILTERED SPOT PRICES (USDT/BNB) ==="));
    Object.entries(prices).forEach(([dex, data]) => console.log(`${dex}: ${data.price.toFixed(2)}`));
    return prices;
  }

  findArbitrageOpportunities(prices) {
    const opps = [];
    for (const [sellDexName, sellData] of Object.entries(prices)) {
      for (const [buyDexName, buyData] of Object.entries(prices)) {
        if (sellDexName === buyDexName) continue;
        const spread = ((sellData.price - buyData.price) / buyData.price) * 100;
        if (spread > 0.01) { // Min 0.01% spread to consider
          opps.push({ 
            sellDex: this.dexes[sellDexName], 
            buyDex: this.dexes[buyDexName], 
            spread, 
            sellPrice: sellData.price,
            buyPrice: buyData.price 
          });
        }
      }
    }
    return opps.sort((a, b) => b.spread - a.spread);
  }

  async simulateCompleteArbitrage(sellDex, buyDex, loanAmount) {
    const loanWei = ethers.parseEther(loanAmount.toString());
    const usdtOut = await this.getAmountsOut(sellDex.router, [WBNB_ADDRESS, USDT_ADDRESS], loanWei, 10000, `${sellDex.name} SIM SELL`);
    if (!usdtOut) return { success: false };

    const wbnbBack = await this.getAmountsOut(buyDex.router, [USDT_ADDRESS, WBNB_ADDRESS], usdtOut, 10000, `${buyDex.name} SIM BUY`);
    if (!wbnbBack) return { success: false };
    const wbnbBackNum = Number(ethers.formatEther(wbnbBack));

    const flashFee = (loanAmount * FLASH_FEE_BPS) / 10000;
    const gasCost = 0.002;
    const profit = wbnbBackNum - loanAmount - flashFee - gasCost;
    const percent = (profit / loanAmount) * 100;

    return { success: true, profit, percent };
  }

  async scanForOpportunities() {
    console.log(chalk.cyan("\n🔍 Scanning for opportunities..."));
    const prices = await this.calculateActualPrices();
    const opps = this.findArbitrageOpportunities(prices);
    if (opps.length === 0) {
      console.log(chalk.yellow("❌ No opportunities found (no meaningful spreads >0.01%)."));
      return false;
    }

    console.log(chalk.green(`📊 Found ${opps.length} potential opportunities.`));

    for (const opp of opps) {
      console.log(chalk.cyan(`\nChecking sell ${opp.sellDex.name} (${opp.sellPrice.toFixed(2)}) → buy ${opp.buyDex.name} (${opp.buyPrice.toFixed(2)}), Spread: ${opp.spread.toFixed(4)}%`));
      const sim = await this.simulateCompleteArbitrage(opp.sellDex, opp.buyDex, this.currentLoanAmount);
      if (sim.success && sim.profit > 0.001) {
        console.log(chalk.green(`✅ PROFITABLE: ${sim.profit.toFixed(6)} BNB (${sim.percent.toFixed(2)}%)`));
        return { ...opp, ...sim };
      } else if (sim.success) {
        console.log(chalk.yellow(`⚠️  Not profitable: ${sim.profit.toFixed(6)} BNB (${sim.percent.toFixed(2)}%)`));
      } else {
        console.log(chalk.red("❌ Simulation failed."));
      }
    }
    console.log(chalk.yellow("\n❌ No profitable opportunities this scan."));
    return false;
  }

  async executeFlashLoanArbitrage(tokenBorrow, amount, sellDex, buyDex) {
    try {
      const amountWei = ethers.parseEther(amount.toString());
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const dexData = abiCoder.encode(
        ["address", "address", "uint256", "uint256"],
        [ethers.getAddress(sellDex.router.target), ethers.getAddress(buyDex.router.target), amountWei, BigInt(Date.now() / 1000 + 300)]
      );

      const tx = await flashContract.executeArbitrage(tokenBorrow, amountWei, dexData, { gasLimit: GAS_LIMIT });
      console.log(chalk.cyan(`📝 Tx sent: https://bscscan.com/tx/${tx.hash}`));
      const receipt = await tx.wait();
      console.log(receipt.status ? chalk.green("✅ Success!") : chalk.red("❌ Reverted."));
    } catch (e) {
      console.error(chalk.red(`❌ Execution error: ${e.message}`));
    }
  }

  async run() {
    console.log(chalk.cyan("🚀 BSC Arbitrage Bot Started"));
    const cfg = await inquirer.prompt([
      { type: "number", name: "loanAmount", message: "Enter flash loan amount (BNB):", default: 1 },
      { type: "confirm", name: "autoMode", message: "Auto-execute trades?", default: false }
    ]);

    this.currentLoanAmount = cfg.loanAmount;
    this.autoMode = cfg.autoMode;
    this.isRunning = true;

    while (this.isRunning) {
      const opp = await this.scanForOpportunities();
      if (opp) {
        if (this.autoMode) {
          console.log(chalk.yellow("⚠️  Auto-execute mode: Executing trade..."));
          await this.executeFlashLoanArbitrage(WBNB_ADDRESS, this.currentLoanAmount, opp.sellDex, opp.buyDex);
        } else {
          const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: `Execute ${opp.sellDex.name} → ${opp.buyDex.name} for ${opp.profit.toFixed(6)} BNB profit?` }]);
          if (confirm) await this.executeFlashLoanArbitrage(WBNB_ADDRESS, this.currentLoanAmount, opp.sellDex, opp.buyDex);
        }
      }
      console.log(chalk.gray("⏳ Waiting 15 seconds for next scan..."));
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  stop() {
    this.isRunning = false;
    console.log(chalk.cyan("🛑 Bot stopped."));
  }
}

// ======================= MAIN =========================
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

(async () => {
  const bot = new ArbitrageBot();
  try {
    await bot.run();
  } catch (err) {
    console.error(chalk.red(`❌ Fatal error: ${err.message}`));
  }
})();