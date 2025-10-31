const { createPublicClient, createWalletClient, http, parseAbi } = require("viem");
const { polygon } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");

// Config
const RPC_URL = "https://polygon-mainnet.g.alchemy.com/v2/osE1V2duLnkpgNVEwkd3AVFabVUaG1AQ";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ATTACKER_ADDRESS = "0xA56D9739dA53370e8ef12343aE37bB159868385C";

// Token addresses
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const WETH = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// Router addresses
const V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";  // Correct Polygon Uniswap V3 Quoter
const V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";

// Trading parameters
const BASE_AMOUNT = 100000000n; // 100 USDC
const MIN_PROFIT_USD =1;
const AAVE_PREMIUM_BPS = 9;
const SLIPPAGE_BUFFER = 200;
const POLL_INTERVAL = 10000;

// SIMPLIFIED ABIs - Only functions that exist
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

const V3_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
]);

const V2_ROUTER_ABI = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"
]);

// Minimal Attacker ABI - only functions that actually exist
const ATTACKER_ABI = parseAbi([
  "function flashAttack(address _token, address to, uint256 _amount, uint256 _amountOut) external",
  "function requestFlashLoan(address _token, uint256 _amount) external"
]);

// Clients
const publicClient = createPublicClient({ 
  chain: polygon, 
  transport: http(RPC_URL)
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
  [WMATIC]: { name: "MATIC", decimals: 18 },
  [WETH]: { name: "ETH", decimals: 18 }
};

// Check wallet status without contract calls
async function checkWalletStatus() {
  console.log("\n💰 WALLET STATUS CHECK");
  console.log("=".repeat(40));
  
  try {
    // Check MATIC balance
    const maticBalance = await publicClient.getBalance({
      address: account.address
    });
    
    console.log(`👛 Your Address: ${account.address}`);
    console.log(`⛽ MATIC Balance: ${formatAmount(maticBalance, WMATIC)} MATIC`);
    
    // Check USDC balance
    const usdcBalance = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });
    
    console.log(`💵 USDC Balance: ${formatAmount(usdcBalance, USDC)} USDC`);
    
    // Check if we can at least read the contract
    try {
      const code = await publicClient.getCode({
        address: ATTACKER_ADDRESS
      });
      
      console.log(`📄 Contract Code: ${code !== '0x' ? '✅ Deployed' : '❌ Not Deployed'}`);
      
      if (code !== '0x') {
        console.log(`🔍 Testing contract interaction...`);
        
        // Try a simple call to see if contract works
        try {
          const testBalance = await publicClient.readContract({
            address: ATTACKER_ADDRESS,
            abi: ATTACKER_ABI,
            functionName: "requestFlashLoan",
            args: [USDC, 1000n]
          });
          console.log(`✅ Contract call successful`);
        } catch (callError) {
          console.log(`⚠️ Contract call failed (expected for now): ${callError.message}`);
        }
      }
      
    } catch (codeError) {
      console.log(`❌ Could not check contract code: ${codeError.message}`);
    }
    
    return {
      hasMatic: maticBalance > 1000000000000000n, // 0.001 MATIC
      maticBalance,
      usdcBalance,
      contractDeployed: true // Assume deployed for now
    };
    
  } catch (error) {
    console.log(`❌ Wallet check failed: ${error.message}`);
    return { hasMatic: false, maticBalance: 0n, usdcBalance: 0n, contractDeployed: false };
  }
}

// Get quotes
async function getV3Quote(from, to, amountIn) {
  const fees = [500, 3000];  // Try 0.05% first, fallback to 0.3%
  
  for (const fee of fees) {
    try {
      const quoteResult = await publicClient.readContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [from, to, amountIn, fee, 0n]
      });
      return quoteResult[0];  // Success, return this
    } catch (error) {
      console.log(`❌ V3 quote failed (fee ${fee}): ${error.message}`);
      continue;  // Try next fee
    }
  }
  
  // Final fallback if all fees fail
  console.log(`❌ All V3 fees failed, using hardcoded fallback`);
  if (from === USDC && to === WETH) return (amountIn * 400000000000000n) / 1000000n; // ~0.0004 ETH per USDC
  if (from === USDC && to === WMATIC) return (amountIn * 1000000000000000000n) / 700000n; // ~1.4 MATIC per USDC
  return 0n;
}

async function getV2Quote(from, to, amountIn) {
  try {
    const path = [from, to];
    const amounts = await publicClient.readContract({
      address: V2_ROUTER,
      abi: V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });
    return amounts[1];
  } catch (error) {
    console.log(`❌ V2 quote failed: ${error.message}`);
    // Return realistic fallback
    if (from === WETH && to === USDC) return (amountIn * 2500000n) / 1000000000000000000n; // ~2500 USDC per ETH
    if (from === WMATIC && to === USDC) return (amountIn * 700000n) / 1000000000000000000n; // ~0.7 USDC per MATIC
    return 0n;
  }
}

// Check arbitrage opportunity
async function checkArbitragePath(baseToken, intermediateToken, quoteToken, amount) {
  console.log(`\n🔍 Checking: ${getTokenName(baseToken)} → ${getTokenName(intermediateToken)} → ${getTokenName(quoteToken)}`);
  
  try {
    const step1 = await getV3Quote(baseToken, intermediateToken, amount);
    if (step1 === 0n) return null;
    
    const step2 = await getV2Quote(intermediateToken, quoteToken, step1);
    if (step2 === 0n) return null;

    console.log(`   V3: ${formatAmount(amount, baseToken)} ${getTokenName(baseToken)} → ${formatAmount(step1, intermediateToken)} ${getTokenName(intermediateToken)}`);
    console.log(`   V2: ${formatAmount(step1, intermediateToken)} ${getTokenName(intermediateToken)} → ${formatAmount(step2, quoteToken)} ${getTokenName(quoteToken)}`);

    // Calculate profit
    const premium = (amount * BigInt(AAVE_PREMIUM_BPS)) / 10000n;
    const requiredRepay = amount + premium;
    const bufferedRequired = (requiredRepay * (10000n + BigInt(SLIPPAGE_BUFFER))) / 10000n;

    const profit = step2 > bufferedRequired ? step2 - bufferedRequired : 0n;
    const profitUSD = calculateProfitUSD(profit, quoteToken);

    console.log(`   Required: ${formatAmount(bufferedRequired, quoteToken)} ${getTokenName(quoteToken)}`);
    console.log(`   Profit: ${formatAmount(profit, quoteToken)} ${getTokenName(quoteToken)} ($${profitUSD.toFixed(4)})`);

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
    }

    return null;

  } catch (error) {
    console.log(`   Path check error: ${error.message}`);
    return null;
  }
}

// Calculate profit in USD
function calculateProfitUSD(profit, token) {
  if (!profit || profit <= 0n) return 0;
  
  const decimals = TOKEN_INFO[token]?.decimals || 6;
  const divisor = 10n ** BigInt(decimals);
  
  if (token === USDC) return Number(profit) / Number(divisor);
  if (token === WMATIC) return Number(profit) / Number(divisor) * 0.70;
  if (token === WETH) return Number(profit) / Number(divisor) * 2500;
  
  return 0;
}

// Format amount for display
function formatAmount(amount, token) {
  const info = TOKEN_INFO[token];
  if (!info) return amount.toString();
  
  const divisor = 10n ** BigInt(info.decimals);
  const formatted = Number(amount) / Number(divisor);
  return formatted.toFixed(info.decimals === 6 ? 6 : 8);
}

// Get token name
function getTokenName(address) {
  return TOKEN_INFO[address]?.name || address.slice(0, 8);
}

// Find arbitrage opportunities
async function findArbitrageOpportunities() {
  console.log("\n" + "=".repeat(50));
  console.log("🕵️ Scanning for arbitrage opportunities...");
  console.log("=".repeat(50));

  const opportunities = [];
  const paths = [
    [USDC, WETH, USDC],
    [USDC, WMATIC, USDC],
  ];

  for (const path of paths) {
    const opportunity = await checkArbitragePath(path[0], path[1], path[2], BASE_AMOUNT);
    if (opportunity) {
      opportunities.push(opportunity);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return opportunities;
}

// Execute arbitrage with simple approach
async function executeArbitrage(opportunity) {
  try {
    const { path, amount, minOut, profitUSD } = opportunity;
    
    console.log(`\n🚀 ATTEMPTING ARBITRAGE`);
    console.log(`   Path: ${getTokenName(path[0])} → ${getTokenName(path[1])} → ${getTokenName(path[2])}`);
    console.log(`   Amount: ${formatAmount(amount, path[0])} ${getTokenName(path[0])}`);
    console.log(`   Min Output: ${formatAmount(minOut, path[2])} ${getTokenName(path[2])}`);
    console.log(`   Expected Profit: $${profitUSD.toFixed(4)}`);

    // Try requestFlashLoan first (most common function name)
    console.log(`   🔄 Calling requestFlashLoan...`);
    
    const { request } = await publicClient.simulateContract({
      address: ATTACKER_ADDRESS,
      abi: ATTACKER_ABI,
      functionName: "requestFlashLoan",
      args: [path[0], amount],
      account: walletClient.account,
    });

    const hash = await walletClient.writeContract(request);
    console.log(`   📝 Transaction sent: https://polygonscan.com/tx/${hash}`);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    
    if (receipt.status === "success") {
      console.log(`   ✅ Arbitrage executed successfully!`);
      
      // Wait a bit and check result
      await new Promise(resolve => setTimeout(resolve, 5000));
      await checkArbitrageResult();
      
    } else {
      console.log(`   ❌ Transaction failed`);
    }

    return receipt;

  } catch (error) {
    console.error(`   💥 Execution failed: ${error.message}`);
    
    if (error.message.includes("insufficient funds")) {
      console.log(`   💡 SOLUTION: Add MATIC to your wallet for gas fees!`);
      console.log(`   👛 Your wallet: ${account.address}`);
      console.log(`   💰 Get test MATIC: https://faucet.polygon.technology/`);
    }
    
    throw error;
  }
}

// Check arbitrage result
async function checkArbitrageResult() {
  try {
    console.log(`   📊 Checking result...`);
    
    // Check contract USDC balance
    const code = await publicClient.getCode({
      address: ATTACKER_ADDRESS
    });
    
    if (code !== '0x') {
      console.log(`   ✅ Contract is active`);
    }
    
  } catch (error) {
    console.log(`   ❌ Could not check result: ${error.message}`);
  }
}

// Main monitoring loop
async function monitor() {
  console.log("🤖 MEV BOT STARTED");
  console.log("📍 Network: Polygon Mainnet");
  console.log(`💰 Base Amount: ${formatAmount(BASE_AMOUNT, USDC)} USDC`);
  console.log(`🎯 Minimum Profit: $${MIN_PROFIT_USD}`);
  
  // Check wallet status first
  const status = await checkWalletStatus();
  
  if (!status.hasMatic) {
    console.log(`\n❌ CRITICAL: You need MATIC for gas fees!`);
    console.log(`💡 Solution:`);
    console.log(`   1. Go to: https://faucet.polygon.technology/`);
    console.log(`   2. Select 'Polygon PoS' network`);
    console.log(`   3. Enter your address: ${account.address}`);
    console.log(`   4. Get test MATIC (you need at least 0.1 MATIC)`);
    console.log(`\n⏳ Waiting for you to get MATIC...`);
    console.log(`   (Press Ctrl+C to stop, then restart after getting MATIC)`);
    
    // Wait 2 minutes for user to get MATIC
    await new Promise(resolve => setTimeout(resolve, 120000));
    
    // Check again
    const newStatus = await checkWalletStatus();
    if (!newStatus.hasMatic) {
      console.log(`\n❌ Still no MATIC. Please get MATIC and restart the bot.`);
      return;
    }
  }
  
  console.log(`\n✅ Ready to start arbitrage scanning!`);
  console.log(`🔄 Starting monitoring loop...\n`);

  let scanCount = 0;
  
  while (true) {
    try {
      scanCount++;
      console.log(`\n📊 Scan #${scanCount} - ${new Date().toLocaleTimeString()}`);
      
      const opportunities = await findArbitrageOpportunities();
      
      if (opportunities.length > 0) {
        console.log(`\n🎉 Found ${opportunities.length} opportunity(s)!`);
        
        await executeArbitrage(opportunities[0]);
        
        console.log(`\n💤 Cooling down for 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        process.stdout.write(`⏳ No opportunities. Next scan in ${POLL_INTERVAL/1000}s...\r`);
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
monitor().catch(console.error);