// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IUniswapV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

contract AaveArbitrage is FlashLoanSimpleReceiverBase, Ownable {
    // Token addresses - BSC Mainnet
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address public constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    
    // DEX Routers - BSC Mainnet
    address public constant PANCAKE_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant SUSHI_ROUTER = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506;
    address public constant BAKERY_ROUTER = 0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F;
    address public constant APE_ROUTER = 0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7;
    
    uint256 public constant SLIPPAGE_BASIS = 10000;
    
    event ArbitrageExecuted(address indexed baseToken, address indexed arbToken, uint256 amount, uint256 profit);
    event SwapExecuted(address indexed router, address[] path, uint256 amountIn, uint256 amountOut);
    
    constructor(IPoolAddressesProvider provider) 
        FlashLoanSimpleReceiverBase(provider) 
        Ownable()
    {}
    
    /**
     * @dev Main entry point for arbitrage execution
     */
    function executeArbitrage(
        address asset, // e.g., BUSD
        address arbToken, // the token to arbitrage against asset
        uint256 amount,
        bytes calldata dexData
    ) external {
        require(amount > 0, "Invalid amount");
        require(asset == BUSD, "Only BUSD flash loans supported");
        require(arbToken != address(0) && arbToken != asset, "Invalid arb token");
        
        // Decode DEX parameters
        (address buyRouter, address sellRouter, uint256 slippage, uint256 deadline) = 
            abi.decode(dexData, (address, address, uint256, uint256));
        
        require(buyRouter != address(0) && sellRouter != address(0), "Invalid routers");
        require(slippage <= 500, "Excessive slippage"); // Max 5%
        require(deadline > block.timestamp, "Deadline expired");
        
        // Execute flash loan
        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(buyRouter, sellRouter, slippage, deadline, msg.sender, arbToken),
            0
        );
    }
    
    /**
     * @dev Aave flash loan callback
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Unauthorized");
        require(initiator == address(this), "Unauthorized initiator");
        
        // Decode parameters
        (address buyRouter, address sellRouter, uint256 slippage, uint256 deadline, address originalCaller, address arbToken) = 
            abi.decode(params, (address, address, uint256, uint256, address, address));
        
        uint256 amountOwed = amount + premium;
        uint256 initialBalance = IERC20(asset).balanceOf(address(this)) - amount;
        
        // Execute arbitrage: asset -> arbToken on buyRouter (buy low), arbToken -> asset on sellRouter (sell high)
        uint256 arbTokenAmount = _swap(
            buyRouter,
            asset,
            arbToken,
            amount,
            deadline,
            slippage
        );
        
        _swap(
            sellRouter,
            arbToken,
            asset,
            arbTokenAmount,
            deadline,
            slippage
        );
        
        // Repay flash loan
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        uint256 netProfit = finalBalance - initialBalance - amountOwed;
        require(netProfit >= 0, "Arbitrage not profitable");
        
        IERC20(asset).approve(address(POOL), amountOwed);
        
        // Send profit to caller
        if (netProfit > 0) {
            IERC20(asset).transfer(originalCaller, netProfit);
            emit ArbitrageExecuted(asset, arbToken, amount, netProfit);
        }
        
        return true;
    }
    
    function _swap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 deadline,
        uint256 slippage
    ) internal returns (uint256) {
        require(deadline > block.timestamp, "Deadline expired");
        require(tokenIn != tokenOut, "Invalid swap path");
        
        IERC20(tokenIn).approve(router, amountIn);
        
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        uint256[] memory amounts = IUniswapV2Router(router).getAmountsOut(amountIn, path);
        require(amounts[1] > 0, "Zero output amount");
        
        uint256 amountOutMin = (amounts[1] * (SLIPPAGE_BASIS - slippage)) / SLIPPAGE_BASIS;
        
        uint256[] memory result = IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );
        
        emit SwapExecuted(router, path, amountIn, result[1]);
        
        return result[1];
    }
    
    /**
     * @dev Emergency function to withdraw tokens
     */
    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }
    
    /**
     * @dev Emergency function to withdraw BNB
     */
    function withdrawBNB(uint256 amount) external onlyOwner {
        payable(owner()).transfer(amount);
    }
    
    /**
     * @dev Get contract balance of any token
     */
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
    
    receive() external payable {}
}