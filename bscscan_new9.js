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
const SLIPPAGE_TOLERANCE = 0.005; // 0.5%
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 1000;

// ======================= ROUTERS =========================
const ROUTERS = {
  PancakeSwap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  BakerySwap: "0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F",
  ApeSwap: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7",
  BabyDogeSwap: "0xC9a0F685F39d05D835c369036251ee3aEaaF3c47",
  Biswap: "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8"
};

// ======================= FACTORIES =======================
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

const DEX_FACTORIES = {
  PancakeSwap: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  BakerySwap: "0x01bF7C66c6BD861915CdaaE475042d3c4BaE16A7",
  ApeSwap: "0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6",
  BabyDogeSwap: "0x4693B62E5fc9c0a45F89D62e6300a03C85f43137",
  Biswap: "0x858E3312ed3A876947EA49d572A7C42DE08af7EE"
};

// ======================= ABIs =========================
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)"
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

// Initialize dexes properly
const dexes = {};
for (const [dexName, routerAddress] of Object.entries(ROUTERS)) {
  try {
    dexes[dexName] = {
      name: dexName,
      router: new ethers.Contract(routerAddress, ROUTER_ABI, provider),
      routerAddress: routerAddress,
      factoryAddress: DEX_FACTORIES[dexName]
    };
  } catch (err) {
    console.log(chalk.yellow(`⚠️ Failed to initialize router for ${dexName}: ${err.message}`));
  }
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Improved pair checking with better error handling
async function hasPair(dexName, tokenA, tokenB) {
  const factoryAddress = DEX_FACTORIES[dexName];
  if (!factoryAddress) {
    console.log(chalk.yellow(`⚠️ No factory address for ${dexName}, skipping pair check`));
    return true; // Assume pair exists if we can't check
  }
  
  try {
    // Validate addresses
    if (!ethers.isAddress(factoryAddress)) {
      console.log(chalk.yellow(`⚠️ Invalid factory address for ${dexName}: ${factoryAddress}`));
      return true;
    }
    
    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
    const pairAddress = await factory.getPair(tokenA, tokenB);
    const hasPair = pairAddress && pairAddress !== ethers.ZeroAddress;
    
    if (!hasPair) {
      console.log(chalk.yellow(`⚠️ No pair found on ${dexName} for ${tokenA.slice(0, 8)}... - ${tokenB.slice(0, 8)}...`));
    }
    
    return hasPair;
  } catch (e) {
    // If pair check fails, assume pair exists and proceed with getAmountsOut
    console.log(chalk.yellow(`⚠️ Pair check failed for ${dexName}, proceeding anyway: ${e.message}`));
    return true;
  }
}

// Safe getAmountsOut with retries and fallback for pair checks
async function safeGetAmountsOut(router, dexName, path, amountIn, retries = RETRY_COUNT) {
  // Try pair check but don't block if it fails
  try {
    for (let i = 0; i < path.length - 1; i++) {
      const tokenA = path[i];
      const tokenB = path[i + 1];
      const pairExists = await hasPair(dexName, tokenA, tokenB);
      if (!pairExists) {
        console.log(chalk.yellow(`⚠️ Skipping ${dexName} due to missing pair`));
        return null;
      }
    }
  } catch (e) {
    console.log(chalk.yellow(`⚠️ Pair check error for ${dexName}, proceeding: ${e.message}`));
  }

  for (let i = 0; i < retries; i++) {
    try {
      const amounts = await router.getAmountsOut(amountIn, path);
      // Validate the response
      if (amounts && amounts.length === path.length && BigInt(amounts[amounts.length - 1].toString()) > 0n) {
        return amounts;
      } else {
        console.log(chalk.yellow(`⚠️ Invalid amounts returned from ${dexName}`));
        return null;
      }
    } catch (e) {
      if (e.message.includes("require(false)") || e.message.includes("execution reverted")) {
        console.log(chalk.yellow(`⚠️ getAmountsOut revert on ${dexName}, skipping.`));
        return null;
      }
      console.log(chalk.yellow(`⚠️ getAmountsOut attempt ${i + 1} failed on ${dexName}: ${e.message}`));
      if (i < retries - 1) {
        await sleep(RETRY_DELAY_MS * (i + 1));
      }
    }
  }
  console.log(chalk.red(`❌ getAmountsOut failed after retries on ${dexName}`));
  return null;
}

class ArbitrageBot {
  constructor() {
    this.dexes = dexes;
  }

  async getAmountsOut(dexName, router, path, amountIn) {
    return safeGetAmountsOut(router, dexName, path, amountIn);
  }

  async hasSufficientLiquidity(dexName, router, path, amountIn) {
    const out = await this.getAmountsOut(dexName, router, path, amountIn);
    return out && BigInt(out[out.length - 1].toString()) > 0n;
  }

  async calculateAllPrices(amountInBNB) {
    const amountIn = parseEther(amountInBNB.toString());
    const prices = {};

    for (const [dexName, dexObj] of Object.entries(this.dexes)) {
      try {
        console.log(chalk.gray(`Checking ${dexName}...`));
        const out = await this.getAmountsOut(dexName, dexObj.router, [WBNB_ADDRESS, BUSD_ADDRESS, USDT_ADDRESS], amountIn);
        prices[dexName] = out ? out[out.length - 1] : null;
        
        if (out) {
          const price = Number(formatUnits(out[out.length - 1], 18));
          console.log(chalk.gray(`  ${dexName}: ${price.toFixed(6)} USDT`));
        } else {
          console.log(chalk.gray(`  ${dexName}: N/A`));
        }
      } catch (error) {
        console.log(chalk.yellow(`⚠️ Error calculating price for ${dexName}: ${error.message}`));
        prices[dexName] = null;
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

      // WBNB → BUSD → USDT on buyDex
      console.log(chalk.gray(`Simulating buy on ${buyDex.name}...`));
      const usdtOut = await this.getAmountsOut(buyDex.name, buyDex.router, [WBNB_ADDRESS, BUSD_ADDRESS, USDT_ADDRESS], amountIn);
      if (!usdtOut || usdtOut.length < 3) {
        console.log(chalk.yellow(`❌ No output from ${buyDex.name}`));
        return { netProfit: 0, percentage: 0, liqOK: false };
      }

      const usdtAmount = usdtOut[usdtOut.length - 1];
      
      // USDT → BUSD → WBNB on sellDex
      console.log(chalk.gray(`Simulating sell on ${sellDex.name}...`));
      const wbnbBack = await this.getAmountsOut(sellDex.name, sellDex.router, [USDT_ADDRESS, BUSD_ADDRESS, WBNB_ADDRESS], usdtAmount);
      if (!wbnbBack || wbnbBack.length < 3) {
        console.log(chalk.yellow(`❌ No output from ${sellDex.name}`));
        return { netProfit: 0, percentage: 0, liqOK: false };
      }

      const amountInNum = Number(formatUnits(amountIn, 18));
      const wbnbBackNum = Number(formatUnits(wbnbBack[wbnbBack.length - 1], 18));

      const flashFeeBNB = amountInNum * FLASH_FEE_BPS / 10000;
      const gasEstBNB = 0.002;
      const netProfitBNB = wbnbBackNum - amountInNum - flashFeeBNB - gasEstBNB;
      const percentage = (netProfitBNB / amountInNum) * 100;

      console.log(
        chalk.gray(`Trade Path: ${buyDex.name}(WBNB→BUSD→USDT) → ${sellDex.name}(USDT→BUSD→WBNB)`),
        chalk.gray(`Expected net result: ${netProfitBNB.toFixed(6)} BNB (${percentage.toFixed(2)}%)`)
      );

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

      const dexData = abiCoder.encode(
        ["address", "address", "uint256", "uint256"],
        [
          buyDex.routerAddress,
          sellDex.routerAddress,
          amountWei,
          BigInt(Math.floor(Date.now() / 1000) + 300)
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
        const finalBalance = await flashContract.getBalance(tokenBorrow);
        console.log(chalk.blue(`Final contract balance: ${formatUnits(finalBalance, 18)} BNB`));
      } else {
        console.log(chalk.red("❌ Transaction reverted."));
      }
    } catch (error) {
      console.error(chalk.red(`Execution error: ${error.message}`));
    }
  }

  isProfitable(netProfitBNB, percentage) {
    return netProfitBNB > SLIPPAGE_TOLERANCE && percentage > 0.5;
  }

  async run() {
    console.log(chalk.cyan("🚀 BSC Arbitrage Bot (With Improved Error Handling)"));
    console.log(chalk.cyan(`Available DEXes: ${Object.keys(this.dexes).join(', ')}`));

    const { autoMode } = await inquirer.prompt([
      {
        type: "confirm",
        name: "autoMode",
        message: "Auto-execute trades?",
        default: false
      }
    ]);

    const TEST_AMOUNTS = [0.1, 0.5, 1];

    while (true) {
      try {
        for (const loanAmount of TEST_AMOUNTS) {
          console.log(chalk.blue(`\n🔍 Scanning for opportunities with ${loanAmount} BNB...`));
          const prices = await this.calculateAllPrices(loanAmount);

          const { bestBuy, bestSell } = this.findBestArbitrage(prices);

          if (!bestBuy.dex || !bestSell.dex || bestBuy.dex === bestSell.dex) {
            console.log(chalk.yellow("No profitable spread found at this loan size."));
            continue;
          }

          const buyDex = this.dexes[bestBuy.dex];
          const sellDex = this.dexes[bestSell.dex];

          if (!buyDex || !sellDex) {
            console.log(chalk.yellow("❌ Invalid DEX configuration"));
            continue;
          }

          console.log(chalk.blue(`Best buy: ${buyDex.name} | Best sell: ${sellDex.name}`));

          const { netProfit, percentage } = await this.simulateProfit(buyDex, sellDex, loanAmount);

          if (this.isProfitable(netProfit, percentage)) {
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
        }
      } catch (err) {
        console.error(chalk.red(`Main loop error: ${err.message}`));
      }

      console.log(chalk.gray("⏳ Waiting 15s before next scan..."));
      await sleep(15000);
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