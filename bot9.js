const { createPublicClient, createWalletClient, http, parseAbi } = require("viem");
const { polygon } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");

// Config
const RPC_URL = "https://polygon-rpc.com"; // Using a more reliable RPC
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ATTACKER_ADDRESS = "0xA56D9739dA53370e8ef12343aE37bB159868385C";
const AAVE_POOL_ADDRESS = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

// Token addresses - verified
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDT = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const LINK = "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39";
const WBTC = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
const AAVE = "0xD6DF932A45C0f255f85145f286eA0b292B21C90B";

// Router addresses - verified
const V3_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Added V3 Router
const V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

// Trading parameters - reduced for testing
const BASE_AMOUNT = 100000000n; // 100 USDC (updated for testing)
const MIN_PROFIT_USD = 0.001; // Tiny profit to surface anything
const AAVE_PREMIUM_BPS = 0; // Temp: Ignore premium for pure swap arb testing
const SLIPPAGE_BUFFER = 50; // 0.5% buffer—less conservative
const POLL_INTERVAL = 2000; // 2s scans for more chances
const LIQUIDITY_SAFETY_MARGIN = 5000n; // 50% of available liquidity

// ABIs
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function totalSupply() view returns (uint256)"
]);

const V3_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
]);

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)"
]);

const V3_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
]);

// Aave Pool ABI - simplified
const AAVE_POOL_ABI = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))",
  "function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external"
]);

// Attacker ABI
const ATTACKER_ABI = parseAbi([
  "function flashAttack(address _token, address to, uint256 _amount, uint256 _amountOut) external",
  "function getBalance(address _tokenAddress) view returns (uint256)",
  "function withdraw(address token) external",
  "function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool)"
]);

// Clients with better configuration
const publicClient = createPublicClient({ 
  chain: polygon, 
  transport: http(RPC_URL, {
    timeout: 10000,
    retryCount: 3
  })
});

if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY environment variable is not set");
}

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
  account: account,
  chain: polygon,
  transport: http(RPC_URL),
});

// Token info
const TOKEN_INFO = {
  [USDC]: { name: "USDC", decimals: 6 },
  [USDT]: { name: "USDT", decimals: 6 },
  [DAI]: { name: "DAI", decimals: 18 },
  [WETH]: { name: "ETH", decimals: 18 },
  [WMATIC]: { name: "MATIC", decimals: 18 },
  [LINK]: { name: "LINK", decimals: 18 },
  [WBTC]: { name: "BTC", decimals: 8 },
  [AAVE]: { name: "AAVE", decimals: 18 }
};

// Common trading pairs with proper fee tiers
const TRADING_PAIRS = {
  [USDC]: {
    [WETH]: { fee: 500, reliable: true },
    [WMATIC]: { fee: 500, reliable: true },
    [LINK]: { fee: 3000, reliable: true },
    [WBTC]: { fee: 500, reliable: true },
    [AAVE]: { fee: 3000, reliable: true },
    [USDT]: { fee: 100, reliable: true }
  },
  [USDT]: {
    [WETH]: { fee: 500, reliable: true },
    [WMATIC]: { fee: 500, reliable: true }
  },
  [DAI]: {
    [WMATIC]: { fee: 500, reliable: true },
    [WETH]: { fee: 500, reliable: true }
  }
};

// Utility functions
function formatAmount(amount, token) {
  const info = TOKEN_INFO[token];
  if (!info || !amount) return "0";
  
  const divisor = 10n ** BigInt(info.decimals);
  const formatted = Number(amount) / Number(divisor);
  return formatted.toFixed(info.decimals <= 6 ? 6 : 4);
}

function getTokenName(address) {
  return TOKEN_INFO[address]?.name || address.slice(0, 8);
}

function calculateProfitUSD(profit, token) {
  if (!profit || profit <= 0n) return 0;
  
  const decimals = TOKEN_INFO[token]?.decimals || 6;
  const divisor = 10n ** BigInt(decimals);
  
  const usdPrices = {
    [USDC]: 1, [USDT]: 1, [DAI]: 1,
    [WETH]: 2500, [WBTC]: 40000, [WMATIC]: 0.7, [LINK]: 13, [AAVE]: 90
  };
  
  const price = usdPrices[token] || 1;
  return (Number(profit) / Number(divisor)) * price;
}

// Enhanced V3 quote function
async function getV3Quote(from, to, amountIn) {
  // Get recommended fee from trading pairs
  const pairConfig = TRADING_PAIRS[from]?.[to];
  const fees = pairConfig ? [pairConfig.fee] : [500, 3000, 10000];
  const sqrtPriceLimitX96 = 0n;
  
  for (const fee of fees) {
    try {
      console.log(`   Trying V3 quote: ${getTokenName(from)} → ${getTokenName(to)} (fee: ${fee})`);
      
      const quoteResult = await publicClient.readContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: from,
          tokenOut: to,
          amountIn: amountIn,
          fee: fee,
          sqrtPriceLimitX96: sqrtPriceLimitX96
        }]
      });
      
      const [amountOut] = quoteResult;
      
      if (amountOut > 0n) {
        console.log(`   ✅ V3 quote: ${formatAmount(amountIn, from)} ${getTokenName(from)} → ${formatAmount(amountOut, to)} ${getTokenName(to)}`);
        return amountOut;
      }
    } catch (error) {
      console.log(`   ❌ V3 quote failed (fee ${fee}): ${error.shortMessage || error.message}`);
      continue;
    }
  }
  
  // Fallback: Use V2 if V3 fails
  console.log(`   🔄 Falling back to V2 for ${getTokenName(from)} → ${getTokenName(to)}`);
  return await getV2Quote(from, to, amountIn);
}

// Enhanced V2 quote function with fallback via WMATIC
async function getV2Quote(from, to, amountIn) {
  try {
    // Try direct
    const path = [from, to];
    const amounts = await publicClient.readContract({
      address: V2_ROUTER,
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });
    
    const amountOut = amounts[1];
    if (amountOut > 0n) {
      console.log(`   ✅ V2 direct quote: ${formatAmount(amountIn, from)} → ${formatAmount(amountOut, to)}`);
      return amountOut;
    }
  } catch (error) {
    console.log(`   ⚠️ V2 direct failed: ${error.shortMessage || error.message}, trying via WMATIC`);
  }
  
  // Fallback: Via WMATIC if not direct (common hub)
  if (from !== WMATIC && to !== WMATIC) {
    try {
      const path = [from, WMATIC, to];
      const amounts = await publicClient.readContract({
        address: V2_ROUTER,
        abi: V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountIn, path],
      });
      
      const amountOut = amounts[2];
      if (amountOut > 0n) {
        console.log(`   ✅ V2 via WMATIC: ${formatAmount(amountIn, from)} → ${formatAmount(amountOut, to)}`);
        return amountOut;
      }
    } catch (error) {
      console.log(`   ❌ V2 via WMATIC failed: ${error.shortMessage || error.message}`);
    }
  }
  
  return 0n;
}

// Check arbitrage opportunity with improved logic
async function checkArbitragePath(baseToken, intermediateToken, quoteToken, amount) {
  console.log(`\n🔍 Checking: ${getTokenName(baseToken)} → ${getTokenName(intermediateToken)} → ${getTokenName(quoteToken)}`);
  
  try {
    // Step 1: Base → Intermediate (V3)
    const step1 = await getV3Quote(baseToken, intermediateToken, amount);
    if (step1 === 0n) {
      console.log(`   ❌ No liquidity for first step`);
      return null;
    }
    
    // Step 2: Intermediate → Quote (V2)
    const step2 = await getV2Quote(intermediateToken, quoteToken, step1);
    if (step2 === 0n) {
      console.log(`   ❌ No liquidity for second step`);
      return null;
    }

    // Calculate profit with slippage buffer
    const premium = (amount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
    const requiredRepay = amount + premium;
    const bufferedRequired = (requiredRepay * (10000n + BigInt(SLIPPAGE_BUFFER))) / 10000n;

    const profit = step2 > bufferedRequired ? step2 - bufferedRequired : 0n;
    const profitUSD = calculateProfitUSD(profit, quoteToken);

    // Log even non-profitable for debug
    const rawRequired = amount + (amount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
    const rawProfit = step2 > rawRequired ? step2 - rawRequired : 0n;
    console.log(`   📊 Summary:`);
    console.log(`      Input: ${formatAmount(amount, baseToken)} ${getTokenName(baseToken)}`);
    console.log(`      Step 1: ${formatAmount(step1, intermediateToken)} ${getTokenName(intermediateToken)}`);
    console.log(`      Step 2: ${formatAmount(step2, quoteToken)} ${getTokenName(quoteToken)}`);
    console.log(`      Required: ${formatAmount(bufferedRequired, quoteToken)} ${getTokenName(quoteToken)}`);
    console.log(`      Profit: ${formatAmount(profit, quoteToken)} ${getTokenName(quoteToken)} ($${profitUSD.toFixed(4)})`);
    console.log(`   Raw (no buffer/premium): Profit ${formatAmount(rawProfit, quoteToken)} ($${calculateProfitUSD(rawProfit, quoteToken).toFixed(4)})`);

    if (profit > 0n && profitUSD >= MIN_PROFIT_USD) {
      console.log(`🎯 PROFITABLE OPPORTUNITY FOUND!`);
      return {
        profitable: true,
        path: [baseToken, intermediateToken, quoteToken],
        amount: amount,
        minOut: bufferedRequired,
        expectedProfit: profit,
        profitUSD: profitUSD
      };
    } else {
      console.log(`   💤 Not profitable enough (min: $${MIN_PROFIT_USD})`);
    }

    return null;

  } catch (error) {
    console.log(`   ❌ Path check error: ${error.message}`);
    return null;
  }
}

// Test basic connectivity
async function testConnectivity() {
  console.log("\n🔧 Testing connectivity...");
  
  try {
    // Test RPC connection
    const blockNumber = await publicClient.getBlockNumber();
    console.log(`   ✅ RPC connected - Block: ${blockNumber}`);
    
    // Test token contracts
    const usdcDecimals = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "decimals"
    });
    console.log(`   ✅ USDC contract accessible - Decimals: ${usdcDecimals}`);
    
    // Test Quoter contract
    try {
      await publicClient.readContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: USDC,
          tokenOut: WETH,
          amountIn: 1000000n, // 1 USDC
          fee: 500,
          sqrtPriceLimitX96: 0n
        }]
      });
      console.log(`   ✅ V3 Quoter accessible`);
    } catch (e) {
      console.log(`   ⚠️ V3 Quoter error: ${e.shortMessage}`);
    }
    
    // Test V2 Router
    try {
      await publicClient.readContract({
        address: V2_ROUTER,
        abi: V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [1000000n, [USDC, WETH]]
      });
      console.log(`   ✅ V2 Router accessible`);
    } catch (e) {
      console.log(`   ⚠️ V2 Router error: ${e.shortMessage}`);
    }
    
    return true;
  } catch (error) {
    console.log(`   ❌ Connectivity test failed: ${error.message}`);
    return false;
  }
}

// Test single path for debugging
async function testSinglePath() {
  console.log("\n🧪 Testing single path: USDC → WETH → USDC");
  const amount = 100000000n; // 100 USDC
  const step1 = await getV3Quote(USDC, WETH, amount);
  if (step1 === 0n) return console.log("Step1 failed");
  const step2 = await getV2Quote(WETH, USDC, step1);
  if (step2 === 0n) return console.log("Step2 failed");
  const premium = (amount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
  const required = amount + premium;
  const rawProfit = step2 > required ? step2 - required : 0n;
  const rawProfitUSD = calculateProfitUSD(rawProfit, USDC);
  console.log(`Raw (no buffer): Step2 ${formatAmount(step2, USDC)} vs Required ${formatAmount(required, USDC)} | Profit $${rawProfitUSD.toFixed(4)}`);
  console.log(`Efficiency: ${(Number(step2) / Number(amount) * 100).toFixed(4)}%`);
}

// Find arbitrage opportunities with better paths
async function findArbitrageOpportunities() {
  console.log("\n" + "=".repeat(50));
  console.log("🕵️ Scanning for arbitrage opportunities...");
  console.log("=".repeat(50));

  const opportunities = [];
  
  // Reliable paths based on common trading pairs
  const paths = [
    [USDC, WETH, USDC],      // Reliable, high liq
    [USDC, WMATIC, USDC],    // Reliable
    [USDT, WETH, USDT],      // Stable-ish
    [USDT, WMATIC, USDT],
    [DAI, WETH, DAI],        // DAI has good V2 via WETH
    [DAI, WMATIC, DAI]
  ];

  for (const path of paths) {
    try {
      const baseToken = path[0];
      const baseDecimals = TOKEN_INFO[baseToken]?.decimals || 6;
      const adjustedAmount = BASE_AMOUNT * (10n ** BigInt(baseDecimals - 6));
      
      console.log(`\n🔄 Testing path: ${getTokenName(path[0])} → ${getTokenName(path[1])} → ${getTokenName(path[2])}`);
      
      const opportunity = await checkArbitragePath(path[0], path[1], path[2], adjustedAmount);
      if (opportunity) {
        opportunities.push(opportunity);
      }
      
      // Add delay between checks to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.log(`   ❌ Error checking path: ${error.message}`);
      continue;
    }
  }

  // Add reverse: V2 first, V3 second
  console.log("\n🔄 Testing reverse paths (V2 → V3)");
  const reversePaths = [
    [USDC, WETH, USDC],
    [USDC, WMATIC, USDC]
  ];
  for (const path of reversePaths) {
    try {
      const baseToken = path[0];
      const baseDecimals = TOKEN_INFO[baseToken]?.decimals || 6;
      const adjustedAmount = BASE_AMOUNT * (10n ** BigInt(baseDecimals - 6));
      
      // Step1: V2 quote
      const step1 = await getV2Quote(path[0], path[1], adjustedAmount);
      if (step1 === 0n) {
        console.log(`   ❌ No liquidity for reverse first step`);
        continue;
      }
      
      // Step2: V3 quote
      const step2 = await getV3Quote(path[1], path[2], step1);
      if (step2 === 0n) {
        console.log(`   ❌ No liquidity for reverse second step`);
        continue;
      }
      
      // Same profit calc...
      const premium = (adjustedAmount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
      const requiredRepay = adjustedAmount + premium;
      const bufferedRequired = (requiredRepay * (10000n + BigInt(SLIPPAGE_BUFFER))) / 10000n;
      const profit = step2 > bufferedRequired ? step2 - bufferedRequired : 0n;
      const profitUSD = calculateProfitUSD(profit, path[2]);
      
      // Log even non-profitable for debug
      const rawRequired = adjustedAmount + (adjustedAmount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
      const rawProfit = step2 > rawRequired ? step2 - rawRequired : 0n;
      console.log(`   📊 Reverse Summary:`);
      console.log(`      Input: ${formatAmount(adjustedAmount, path[0])} ${getTokenName(path[0])}`);
      console.log(`      Step 1 (V2): ${formatAmount(step1, path[1])} ${getTokenName(path[1])}`);
      console.log(`      Step 2 (V3): ${formatAmount(step2, path[2])} ${getTokenName(path[2])}`);
      console.log(`      Required: ${formatAmount(bufferedRequired, path[2])} ${getTokenName(path[2])}`);
      console.log(`      Profit: ${formatAmount(profit, path[2])} ${getTokenName(path[2])} ($${profitUSD.toFixed(4)})`);
      console.log(`   Raw (no buffer/premium): Profit ${formatAmount(rawProfit, path[2])} ($${calculateProfitUSD(rawProfit, path[2]).toFixed(4)})`);
      
      if (profit > 0n && profitUSD >= MIN_PROFIT_USD) {
        opportunities.push({
          profitable: true,
          path: [...path, 'reverse'], // Flag as reverse
          amount: adjustedAmount,
          minOut: bufferedRequired,
          expectedProfit: profit,
          profitUSD: profitUSD
        });
      } else {
        console.log(`   💤 Reverse not profitable enough (min: $${MIN_PROFIT_USD})`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000)); // Throttle
    } catch (error) {
      console.log(`   ❌ Error checking reverse path: ${error.message}`);
      continue;
    }
  }

  return opportunities.sort((a, b) => b.profitUSD - a.profitUSD);
}

// Check wallet status
async function checkWalletStatus() {
  console.log("\n💰 WALLET STATUS CHECK");
  console.log("=".repeat(40));
  
  try {
    const maticBalance = await publicClient.getBalance({
      address: account.address
    });
    
    console.log(`👛 Your Address: ${account.address}`);
    console.log(`⛽ MATIC Balance: ${formatAmount(maticBalance, WMATIC)} MATIC`);
    
    const usdcBalance = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });
    
    console.log(`💵 USDC Balance: ${formatAmount(usdcBalance, USDC)} USDC`);
    
    const code = await publicClient.getCode({
      address: ATTACKER_ADDRESS
    });
    
    console.log(`📄 Contract Code: ${code !== '0x' ? '✅ Deployed' : '❌ Not Deployed'}`);
    
    return {
      hasMatic: maticBalance > 1000000000000000n,
      maticBalance,
      usdcBalance,
      contractDeployed: code !== '0x'
    };
    
  } catch (error) {
    console.log(`❌ Wallet check failed: ${error.message}`);
    return { hasMatic: false, maticBalance: 0n, usdcBalance: 0n, contractDeployed: false };
  }
}

// Execute arbitrage
async function executeArbitrage(opportunity) {
  // Similar to previous version but with better error handling
  // ... (implementation from previous version)
}

// Main monitoring loop
async function monitor() {
  console.log("🤖 MEV BOT STARTED");
  console.log("📍 Network: Polygon Mainnet");
  console.log(`💰 Base Amount: ${formatAmount(BASE_AMOUNT, USDC)} USDC`);
  console.log(`🎯 Minimum Profit: $${MIN_PROFIT_USD}`);
  
  // Test connectivity first
  const connected = await testConnectivity();
  if (!connected) {
    console.log("\n❌ Connectivity test failed. Check RPC URL and network.");
    return;
  }
  
  // Test single path for debugging
  await testSinglePath();
  
  // Check wallet status
  const status = await checkWalletStatus();
  
  if (!status.hasMatic) {
    console.log(`\n❌ Need MATIC for gas! Send to: ${account.address}`);
    return;
  }
  
  if (!status.contractDeployed) {
    console.log(`\n❌ Contract not deployed at ${ATTACKER_ADDRESS}`);
    return;
  }
  
  console.log(`\n✅ All systems go! Starting arbitrage scanning...\n`);

  let scanCount = 0;
  
  while (true) {
    try {
      scanCount++;
      console.log(`\n📊 Scan #${scanCount} - ${new Date().toLocaleTimeString()}`);
      
      const opportunities = await findArbitrageOpportunities();
      
      if (opportunities.length > 0) {
        console.log(`\n🎉 Found ${opportunities.length} opportunity(s)!`);
        console.log(`💡 Most profitable: $${opportunities[0].profitUSD.toFixed(4)}`);
        
        // For now, just log opportunities until we fix execution
        console.log(`🔧 Execution disabled for testing`);
        
        console.log(`\n💤 Cooling down for 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        console.log(`⏳ No opportunities found. Next scan in ${POLL_INTERVAL/1000}s...`);
      }
      
    } catch (error) {
      console.error(`Monitor error: ${error.message}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down MEV bot...');
  process.exit(0);
});

// Start the bot
monitor().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});