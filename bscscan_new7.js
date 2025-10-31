const { ethers } = require("ethers");
const inquirer = require("inquirer");
const chalk = require("chalk");

const { formatUnits, parseEther } = ethers;

// ======================= CONFIG =========================
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = "https://bsc-dataseed.binance.org/";

const FLASH_LOAN_CONTRACT = "0xe1dd72f31B9286F866A80595220b42078bFdc877";

const BUSD_ADDRESS = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const FLASH_FEE_BPS = 9; // 0.09%
const GAS_LIMIT = 500000;

// ======================= ROUTERS =========================
const ROUTERS = {
  PancakeSwap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  BakerySwap: "0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F",
  ApeSwap: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7",
 // Biswap: "0x965F527D9159dCe6288a2219DB51fc6Eef120dD1",
  BabyDogeSwap: "0xC9a0F685F39d05D835c369036251ee3aEaaF3c47",
 // DODO: "0x67ee3Cb086F8a16f34beE3ca72FAD36F7Db929e2",
  MDEX: "0x7dae51bd3e3376b8c7c4900e9107f12be3af1ba8"
};

// ======================= ABIs =========================
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
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

// Initialize router contracts
const dexes = {};
for (const [dex, addr] of Object.entries(ROUTERS)) {
  try {
    dexes[dex] = { 
      name: dex,
      router: new ethers.Contract(addr, ROUTER_ABI, provider) 
    };
  } catch (err) {
    console.log(chalk.yellow(`⚠️ Failed to initialize router for ${dex}: ${err.message}`));
  }
}

// ======================= BOT CLASS =========================
class ArbitrageBot {
  constructor() {
    this.dexes = dexes;
  }

  // Get single-hop or multi-hop output amount
  async getAmountsOut(router, path, amountIn) {
    try {
      const amounts = await router.getAmountsOut(amountIn, path);
      return amounts[amounts.length - 1];
    } catch (err) {
      console.log(chalk.yellow(`⚠️ Price fetch failed for router: ${err.message}`));
      return null;
    }
  }

  // Check liquidity (simply ensures getAmountsOut > 0)
  async hasSufficientLiquidity(router, path, amountIn) {
    const out = await this.getAmountsOut(router, path, amountIn);
    return out && BigInt(out.toString()) > 0n;
  }

  // Calculate all prices (multi-hop: WBNB -> BUSD -> USDT -> WBNB)
  async calculateAllPrices(amountInBNB) {
    const amountIn = parseEther(amountInBNB.toString());
    const prices = {};
    
    for (const [dex, obj] of Object.entries(this.dexes)) {
      try {
        const out = await this.getAmountsOut(obj.router, [WBNB_ADDRESS, BUSD_ADDRESS, USDT_ADDRESS], amountIn);
        prices[dex] = out;
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Price calculation failed for ${dex}: ${error.message}`));
        prices[dex] = null;
      }
    }
    return prices;
  }

  findBestArbitrage(prices) {
    let bestBuy = { dex: null, price: null };
    let bestSell = { dex: null, price: null };
    
    for (const [dex, price] of Object.entries(prices)) {
      if (!price) continue;
      const priceBN = BigInt(price.toString());
      if (!bestBuy.price || priceBN < bestBuy.price) {
        bestBuy = { dex, price: priceBN };
      }
      if (!bestSell.price || priceBN > bestSell.price) {
        bestSell = { dex, price: priceBN };
      }
    }
    return { bestBuy, bestSell };
  }

  async simulateProfit(buyDex, sellDex, amountBNB) {
    try {
      const amountIn = parseEther(amountBNB.toString());

      // Multi-hop: WBNB -> BUSD -> USDT
      const usdtOut = await this.getAmountsOut(buyDex.router, [WBNB_ADDRESS, BUSD_ADDRESS, USDT_ADDRESS], amountIn);
      if (!usdtOut) return { netProfit: 0, percentage: 0, liqOK: false };

      // Back to WBNB: USDT -> BUSD -> WBNB
      const wbnbBack = await this.getAmountsOut(sellDex.router, [USDT_ADDRESS, BUSD_ADDRESS, WBNB_ADDRESS], usdtOut);
      if (!wbnbBack) return { netProfit: 0, percentage: 0, liqOK: false };

      const amountInNum = Number(formatUnits(amountIn, 18));
      const wbnbBackNum = Number(formatUnits(wbnbBack, 18));

      const flashFeeBNB = amountInNum * FLASH_FEE_BPS / 10000;
      const gasEstBNB = 0.002; 
      const netProfitBNB = wbnbBackNum - amountInNum - flashFeeBNB - gasEstBNB;
      const percentage = (netProfitBNB / amountInNum) * 100;

      console.log(chalk.gray(`Trade Path: ${buyDex.name}(WBNB→BUSD→USDT) → ${sellDex.name}(USDT→BUSD→WBNB)`));
      console.log(chalk.gray(`Expected net result: ${netProfitBNB.toFixed(6)} BNB (${percentage.toFixed(2)}%)`));

      return { netProfit: netProfitBNB, percentage, liqOK: true };
    } catch (error) {
      console.log(chalk.red(`Simulation error: ${error.message}`));
      return { netProfit: 0, percentage: 0, liqOK: false };
    }
  }

  async executeFlashLoanArbitrage(tokenBorrow, amount, buyDex, sellDex) {
    try {
      const amountWei = parseEther(amount.toString());
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      
      // Fixed the encode parameters to match expected types
      const dexData = abiCoder.encode(
        ["address", "address", "uint256", "uint256"],
        [
          buyDex.router.target,
          sellDex.router.target,
          amountWei,
          BigInt(Math.floor(Date.now() / 1000) + 300) // Using timestamp in seconds
        ]
      );

      console.log(chalk.yellow(`🚀 Executing arbitrage: Buy ${buyDex.name} → Sell ${sellDex.name}`));

      const tx = await flashContract.executeArbitrage(
        tokenBorrow,
        amountWei,
        dexData,
        { gasLimit: GAS_LIMIT }
      );

      console.log(chalk.cyan(`Tx sent: https://bscscan.com/tx/${tx.hash}`));
      const receipt = await tx.wait();
      if (receipt.status === 1) {
        console.log(chalk.green("✅ Arbitrage executed successfully!"));
        
        // Check final balance
        const finalBalance = await flashContract.getBalance(tokenBorrow);
        console.log(chalk.blue(`Final contract balance: ${formatUnits(finalBalance, 18)} BNB`));
      } else {
        console.log(chalk.red("❌ Transaction reverted."));
      }
    } catch (error) {
      console.error(chalk.red(`Execution error: ${error.message}`));
    }
  }

  async run() {
    console.log(chalk.cyan("🚀 BSC Arbitrage Bot (Multi-hop with Liquidity Check)"));
    
    const { loanAmount, autoMode } = await inquirer.prompt([
      { 
        type: "number", 
        name: "loanAmount", 
        message: "Enter flash loan amount (BNB):", 
        default: 1,
        validate: (value) => value > 0 ? true : "Please enter a positive number"
      },
      { 
        type: "confirm", 
        name: "autoMode", 
        message: "Auto-execute trades?", 
        default: false 
      }
    ]);

    console.log(chalk.blue(`Starting bot with ${loanAmount} BNB loan amount...`));

    while (true) {
      try {
        console.log(chalk.blue(`\n🔍 Scanning for opportunities with ${loanAmount} BNB...`));
        const prices = await this.calculateAllPrices(loanAmount);

        // Display prices
        Object.entries(prices).forEach(([dex, val]) => {
          const priceStr = val ? Number(formatUnits(val, 18)).toFixed(6) : "N/A";
          console.log(`  ${dex}: ${priceStr} USDT`);
        });

        const { bestBuy, bestSell } = this.findBestArbitrage(prices);
        
        if (!bestBuy.dex || !bestSell.dex || bestBuy.dex === bestSell.dex) {
          console.log(chalk.yellow("No profitable spread found."));
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }

        const buyDex = this.dexes[bestBuy.dex];
        const sellDex = this.dexes[bestSell.dex];

        console.log(chalk.blue(`Best buy: ${buyDex.name} | Best sell: ${sellDex.name}`));

        // Check liquidity
        const liqBuy = await this.hasSufficientLiquidity(
          buyDex.router, 
          [WBNB_ADDRESS, BUSD_ADDRESS, USDT_ADDRESS], 
          parseEther(loanAmount.toString())
        );
        
        const liqSell = await this.hasSufficientLiquidity(
          sellDex.router, 
          [USDT_ADDRESS, BUSD_ADDRESS, WBNB_ADDRESS], 
          bestBuy.price
        );

        if (!liqBuy || !liqSell) {
          console.log(chalk.yellow("❌ Insufficient liquidity on one of the DEXes"));
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }

        const { netProfit, percentage } = await this.simulateProfit(buyDex, sellDex, loanAmount);
        
        if (netProfit > 0.005 && percentage > 0.5) {
          console.log(chalk.green(`🎯 PROFITABLE ARBITRAGE FOUND! Profit: ${netProfit.toFixed(4)} BNB (${percentage.toFixed(2)}%)`));
          
          if (autoMode) {
            await this.executeFlashLoanArbitrage(WBNB_ADDRESS, loanAmount, buyDex, sellDex);
          } else {
            const { exec } = await inquirer.prompt([
              { 
                type: "confirm", 
                name: "exec", 
                message: "Execute this trade?", 
                default: false 
              }
            ]);
            if (exec) {
              await this.executeFlashLoanArbitrage(WBNB_ADDRESS, loanAmount, buyDex, sellDex);
            }
          }
        } else {
          console.log(chalk.yellow(`No profitable execution. Profit: ${netProfit.toFixed(4)} BNB (${percentage.toFixed(2)}%)`));
        }
      } catch (err) {
        console.error(chalk.red(`Main loop error: ${err.message}`));
      }

      console.log(chalk.gray("⏳ Waiting 15s before next scan..."));
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}

// ======================= INIT =========================
process.on("SIGINT", () => {
  console.log(chalk.yellow("\n🛑 Shutting down arbitrage bot..."));
  process.exit(0);
});

(async () => {
  try {
    const bot = new ArbitrageBot();
    await bot.run();
  } catch (error) {
    console.error(chalk.red(`Failed to start bot: ${error.message}`));
    process.exit(1);
  }
})();