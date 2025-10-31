// SPDX-License-Identifier: MIT
//contract address(oct-24):0xe1b7D91D355D777B49151450d4027FE9E0a5e7eF
pragma solidity ^0.8.10;
import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

contract FlashLoanArbDEX is FlashLoanSimpleReceiverBase {
    using SafeERC20 for IERC20;
    address public owner;

    event Log(string message, uint256 val);
    event ArbitrageResult(uint256 profit);

    constructor(address poolProvider) FlashLoanSimpleReceiverBase(IPoolAddressesProvider(poolProvider)) {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    /// Params encoding (abi.encode):
    /// (address buyRouter, uint8 buyVersion, address sellRouter, uint8 sellVersion, 
    ///  address tokenIn, address tokenMid, address tokenOut, uint256 amountIn, uint24 v3Fee)
    /// buyVersion/sellVersion: 2 (UniswapV2/QuickSwap/SushiSwap), 3 (UniswapV3)
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes memory params
    ) external onlyOwner {
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
    }

    /// Executes swap on the selected router(s)
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Only pool");
        require(initiator == address(this), "Only self");

        (
            address buyRouter,
            uint8 buyVersion,
            address sellRouter,
            uint8 sellVersion,
            address tokenIn,
            address tokenMid,
            address tokenOut,
            uint256 amountIn,
            uint24 v3Fee
        ) = abi.decode(params, (address,uint8,address,uint8,address,address,address,uint256,uint24));

        emit Log("Flash loan received", amount);

        uint256 amountAfterBuy;

        // Swap direction determined by buyVersion
        if (buyVersion == 2) {
            amountAfterBuy = _swapV2(
                buyRouter,
                tokenIn,    // Buying: borrow asset (tokenIn) -> tokenMid
                tokenMid,
                amountIn
            );
            emit Log("Amount received from buy V2", amountAfterBuy);
        } else if (buyVersion == 3) {
            amountAfterBuy = _swapV3(
                buyRouter,
                tokenIn,
                tokenMid,
                amountIn,
                v3Fee
            );
            emit Log("Amount received from buy V3", amountAfterBuy);
        } else {
            revert("Unsupported buyRouter version");
        }

        uint256 amountAfterSell;
        // Swap direction determined by sellVersion
        if (sellVersion == 2) {
            amountAfterSell = _swapV2(
                sellRouter,
                tokenMid,   // Selling: tokenMid -> tokenOut, want to get asset back
                tokenOut,
                amountAfterBuy
            );
            emit Log("Amount returned from sell V2", amountAfterSell);
        } else if (sellVersion == 3) {
            amountAfterSell = _swapV3(
                sellRouter,
                tokenMid,
                tokenOut,
                amountAfterBuy,
                v3Fee
            );
            emit Log("Amount returned from sell V3", amountAfterSell);
        } else {
            revert("Unsupported sellRouter version");
        }

        // Repay flash loan
        uint256 totalDebt = amount + premium;
        IERC20(asset).safeApprove(address(POOL), totalDebt);

        emit Log("Total debt to Aave", totalDebt);

        if (amountAfterSell > totalDebt) {
            emit ArbitrageResult(amountAfterSell - totalDebt);
        } else {
            emit ArbitrageResult(0); // No profit
        }

        return true;
    }

    /// Uniswap V2/QuickSwap/SushiSwap compatible swap
    function _swapV2(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).safeApprove(router, 0);
        IERC20(tokenIn).safeApprove(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn,
            0,
            path,
            address(this),
            block.timestamp + 300
        );
        amountOut = amounts[amounts.length - 1];
    }

    /// Uniswap V3 swap (single hop)
    function _swapV3(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint24 fee
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).safeApprove(router, 0);
        IERC20(tokenIn).safeApprove(router, amountIn);

        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        amountOut = IUniswapV3SwapRouter(router).exactInputSingle(params);
    }
}
