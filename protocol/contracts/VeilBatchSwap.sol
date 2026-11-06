// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/contracts/interfaces/IERC7984Receiver.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {IPermit2} from "@uniswap/permit2/src/interfaces/IPermit2.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey, IHooks} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @title VeilBatchSwap — batched confidential swaps with internal netting.
///
/// Users deposit a confidential token (ERC-7984 wrapper) into the current
/// round, choosing a direction (A→B or B→A). Amounts are euint64 ciphertexts:
/// the contract sums them without ever seeing a value.
///
/// Round lifecycle:
///  1. closeRound(): after the time window + participation threshold, makes
///     the encrypted direction totals publicly decryptable. Nothing else.
///  2. The configured settler verifies the Zama Gateway values and commits an
///     output minimum. Anyone can execute that prepared settlement. The contract:
///       matched = min(aIn, bIn)  → settles internally at the demo's 1:1 rate
///       net     = |aIn − bIn|    → unwrapped from the surplus side and swapped
///                                  on Uniswap v4; output wrapped back.
///     If aIn == bIn the round settles with zero on-chain swap.
///
/// Distribution (pro-rata inside FHE, per side):
///   surplus == A: A-side share = dep × (matched + swapOut) / aIn (c-tokenB)
///                 B-side share = dep × matched / bIn            (c-tokenA)
///   surplus == B: mirrored.
///
/// This implementation is for the parity-priced demo pair. Arbitrary pairs
/// need price-aware matching and order-level execution bounds before use.
contract VeilBatchSwap is ZamaEthereumConfig, IERC7984Receiver {
    using SafeERC20 for IERC20;

    uint256 public constant VERSION = 2;

    uint8 public constant DIRECTION_A_TO_B = 1;
    uint8 public constant DIRECTION_B_TO_A = 2;

    struct RoundState {
        euint64 aToB; // encrypted sum of deposits wanting A→B
        euint64 bToA; // encrypted sum of deposits wanting B→A
        bool closed;
        bool prepared; // gateway totals verified, unwrap request created
        bool executed;
        bool aWasSurplus; // true → tokenA side had the net residual
        uint64 totalAIn;
        uint64 totalBIn;
        uint64 matched; // min(aIn, bIn) — settled internally
        uint64 netSwapped; // clear amount sent to Uniswap
        uint64 minSwapOutput; // settlement bound committed by the designated settler
        bytes32 unwrapHandle; // ciphertext of the pending unwrap request
        uint64 swapOutput; // output of the Uniswap leg, in the non-surplus token units
    }

    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    ERC7984ERC20Wrapper public immutable cTokenA;
    ERC7984ERC20Wrapper public immutable cTokenB;
    PoolKey public poolKey;
    uint256 public immutable minRoundDuration;
    uint256 public immutable minDistinctSubmitters;
    address public immutable settler;

    uint256 public currentRound = 1;
    uint256 public lastUpdateTime;
    uint256 public distinctSubmitters;
    mapping(address => uint256) private _userLastRound;

    mapping(uint256 => RoundState) public rounds;
    mapping(uint256 => mapping(uint8 => mapping(address => euint64))) public userDeposits;
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public withdrawn;

    event DepositSubmitted(uint256 indexed round, uint8 indexed direction, address indexed user);
    event RoundClosed(uint256 indexed round);
    event RoundPrepared(uint256 indexed round, uint64 matched, uint64 netSwapped, bytes32 unwrapHandle);
    event RoundSettled(
        uint256 indexed round,
        bool aWasSurplus,
        uint64 matched,
        uint64 netSwapped,
        uint64 swapOutput
    );
    event ClaimedForUser(uint256 indexed roundId, uint8 indexed direction, address indexed user);

    error TooEarlyForNextRound();
    error NotEnoughSubmitters();
    error RoundAlreadyClosed();
    error RoundNotClosed();
    error RoundAlreadySettled();
    error RoundNotPrepared();
    error UnwrapMismatch(uint64 provided, uint64 expected);
    error UnknownDirection();
    error UntrustedToken();
    error DirectionTokenMismatch();
    error AlreadyWithdrawn();
    error NothingDeposited();
    error ZeroNetButMismatchedTotals();
    error SlippageExceeded(uint256 swapOutput, uint256 minSwapOutput);
    error NotSettler();
    error MissingSwapMinimum();
    error SwapOutputOverflow();

    constructor(
        address router_,
        address permit2_,
        address cTokenA_,
        address cTokenB_,
        PoolKey memory poolKey_,
        uint256 minRoundDuration_,
        uint256 minDistinctSubmitters_,
        address settler_
    ) {
        router = IUniversalRouter(router_);
        permit2 = IPermit2(permit2_);
        cTokenA = ERC7984ERC20Wrapper(cTokenA_);
        cTokenB = ERC7984ERC20Wrapper(cTokenB_);
        poolKey = poolKey_;
        minRoundDuration = minRoundDuration_;
        minDistinctSubmitters = minDistinctSubmitters_;
        require(settler_ != address(0), "settler is zero");
        settler = settler_;
        lastUpdateTime = block.timestamp;
    }

    // ------------------------------------------------------------------
    // Deposits
    // ------------------------------------------------------------------

    /// @notice ERC-7984 receiver hook. `data` = abi.encodePacked(uint8 direction).
    function onConfidentialTransferReceived(
        address, // operator — always the wrapper
        address from,
        euint64 eAmount,
        bytes calldata data
    ) external returns (ebool success) {
        // Only our two confidential wrappers may call this.
        if (msg.sender != address(cTokenA) && msg.sender != address(cTokenB)) {
            success = FHE.asEbool(false);
            FHE.allow(success, msg.sender); // wrapper needs ACL to evaluate the refund
            return success;
        }
        uint8 direction = data.length == 1 ? uint8(data[0]) : 0;
        if (direction != DIRECTION_A_TO_B && direction != DIRECTION_B_TO_A) {
            success = FHE.asEbool(false);
            FHE.allow(success, msg.sender);
            return success;
        }
        // Direction must match the token deposited.
        if ((direction == DIRECTION_A_TO_B) != (msg.sender == address(cTokenA))) {
            success = FHE.asEbool(false);
            FHE.allow(success, msg.sender);
            return success;
        }

        RoundState storage round = rounds[currentRound];
        mapping(address => euint64) storage deposits = userDeposits[currentRound][direction];

        // Uninitialized euint64 handles cannot be used in FHE ops (ACL error),
        // so guard exactly like OZ's FHESafeMath.tryIncrease.
        euint64 previousUserAmount = FHE.isInitialized(deposits[from]) ? deposits[from] : FHE.asEuint64(0);
        euint64 updated = FHE.add(previousUserAmount, eAmount);
        // Reject zero-value and uint64-overflowing deposits without exposing
        // either condition. The wrapper refunds the transfer when success is
        // false; select keeps the rejected value out of the round state.
        ebool accepted = FHE.gt(updated, previousUserAmount);
        euint64 previousTotal;
        euint64 updatedTotal;
        if (direction == DIRECTION_A_TO_B) {
            previousTotal = FHE.isInitialized(round.aToB) ? round.aToB : FHE.asEuint64(0);
            updatedTotal = FHE.add(previousTotal, eAmount);
        } else {
            previousTotal = FHE.isInitialized(round.bToA) ? round.bToA : FHE.asEuint64(0);
            updatedTotal = FHE.add(previousTotal, eAmount);
        }
        accepted = FHE.and(accepted, FHE.gt(updatedTotal, previousTotal));
        updated = FHE.select(accepted, updated, previousUserAmount);
        updatedTotal = FHE.select(accepted, updatedTotal, previousTotal);
        FHE.allowThis(updated);
        FHE.allow(updated, msg.sender);
        FHE.allow(updated, from); // depositor can read their own position
        deposits[from] = updated;

        if (direction == DIRECTION_A_TO_B) {
            round.aToB = updatedTotal;
            FHE.allowThis(round.aToB);
        } else {
            round.bToA = updatedTotal;
            FHE.allowThis(round.bToA);
        }

        if (_userLastRound[from] < currentRound) {
            _userLastRound[from] = currentRound;
            ++distinctSubmitters;
        }

        emit DepositSubmitted(currentRound, direction, from);
        success = accepted;
        FHE.allow(success, msg.sender); // wrapper needs ACL to evaluate the refund
        return success;
    }

    // ------------------------------------------------------------------
    // Phase 1 — close the round (permissionless once eligible)
    // ------------------------------------------------------------------

    function closeRound() external {
        RoundState storage round = rounds[currentRound];
        require(block.timestamp >= lastUpdateTime + minRoundDuration, TooEarlyForNextRound());
        require(distinctSubmitters >= minDistinctSubmitters, NotEnoughSubmitters());
        require(!round.closed, RoundAlreadyClosed());

        round.closed = true;
        // Rounds may close with one side empty; initialize before exposing.
        if (!FHE.isInitialized(round.aToB)) {
            round.aToB = FHE.asEuint64(0);
            FHE.allowThis(round.aToB);
        }
        if (!FHE.isInitialized(round.bToA)) {
            round.bToA = FHE.asEuint64(0);
            FHE.allowThis(round.bToA);
        }
        FHE.makePubliclyDecryptable(round.aToB);
        FHE.makePubliclyDecryptable(round.bToA);

        // Emit BEFORE advancing counters (fixes the reference event bug).
        emit RoundClosed(currentRound);

        currentRound++;
        distinctSubmitters = 0;
        lastUpdateTime = block.timestamp;
    }

    // ------------------------------------------------------------------
    // Phase 2 — prepare (configured settler) then execute (permissionless)
    // ------------------------------------------------------------------

    /// @param clearValues abi.encode(uint64 totalAIn, uint64 totalBIn)
    /// @param decryptionProof Zama Gateway signature over the two ciphertexts.
    /// @param minSwapOutput minimum output in confidential-token units. Only
    ///        the configured settler can commit this bound; anyone may execute
    ///        the settlement once it has been committed.
    /// @notice Phase 1 of settlement (settler-only). Verifies the gateway
    ///         decryption of the round totals, records matched/net, and opens
    ///         the async unwrap request for the net surplus. The OZ
    ///         confidential wrapper delivers underlying tokens only in a
    ///         second step ({finalizeUnwrap}), so the swap leg lives in
    ///         {executeSettle}.
    function prepareSettle(uint256 roundId, bytes calldata clearValues, bytes calldata decryptionProof, uint64 minSwapOutput) external {
        if (msg.sender != settler) revert NotSettler();
        RoundState storage round = rounds[roundId];
        require(round.closed, RoundNotClosed());
        require(!round.prepared && !round.executed, RoundAlreadySettled());

        (uint64 totalAIn, uint64 totalBIn) = abi.decode(clearValues, (uint64, uint64));

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(round.aToB);
        cts[1] = FHE.toBytes32(round.bToA);
        FHE.checkSignatures(cts, clearValues, decryptionProof);

        round.prepared = true;
        round.totalAIn = totalAIn;
        round.totalBIn = totalBIn;

        uint64 matched = totalAIn < totalBIn ? totalAIn : totalBIn;
        uint64 net;
        bool aWasSurplus;
        if (totalAIn >= totalBIn) {
            net = totalAIn - totalBIn;
            aWasSurplus = true;
        } else {
            net = totalBIn - totalAIn;
        }
        round.matched = matched;
        round.aWasSurplus = aWasSurplus;
        round.netSwapped = net;
        if (net > 0 && minSwapOutput == 0) revert MissingSwapMinimum();
        if (net == 0 && minSwapOutput != 0) revert SlippageExceeded(0, minSwapOutput);
        round.minSwapOutput = minSwapOutput;

        bytes32 unwrapHandle = 0;
        if (net > 0) {
            ERC7984ERC20Wrapper surplusWrapper = aWasSurplus ? cTokenA : cTokenB;
            // The wrapper itself performs FHE ops on `amount`; grant transient ACL.
            euint64 netEnc = FHE.asEuint64(net);
            FHE.allowTransient(netEnc, address(surplusWrapper));
            // _burn may re-key the handle; the returned value is the one the
            // wrapper made publicly decryptable and registered as the request.
            euint64 unwrapped = surplusWrapper.unwrap(address(this), address(this), netEnc);
            unwrapHandle = FHE.toBytes32(unwrapped);
            round.unwrapHandle = unwrapHandle;
        }
        emit RoundPrepared(roundId, matched, net, unwrapHandle);
    }

    /// @param unwrapCleartext the gateway-decrypted value of the unwrap request
    ///        (must equal the round's net surplus)
    /// @param decryptionProof Zama Gateway signature over the unwrap ciphertext.
    /// @notice Phase 2 of settlement (permissionless). Finalizes the unwrap
    ///         (underlying tokens arrive), swaps the net leg on Uniswap v4,
    ///         wraps the output back, and enforces the slippage guard.
    function executeSettle(uint256 roundId, uint64 unwrapCleartext, bytes calldata decryptionProof) external {
        RoundState storage round = rounds[roundId];
        require(round.prepared, RoundNotPrepared());
        require(!round.executed, RoundAlreadySettled());

        uint64 swapOutput = 0;
        if (round.netSwapped > 0) {
            if (unwrapCleartext != round.netSwapped) revert UnwrapMismatch(unwrapCleartext, round.netSwapped);
            ERC7984ERC20Wrapper surplusWrapper = round.aWasSurplus ? cTokenA : cTokenB;
            ERC7984ERC20Wrapper outputWrapper = round.aWasSurplus ? cTokenB : cTokenA;
            uint256 rateIn = surplusWrapper.rate();
            uint256 rateOut = outputWrapper.rate();

            // Async unwrap step 2: the wrapper verifies the gateway signature
            // and transfers unwrapCleartext * rateIn underlying to this batcher.
            surplusWrapper.finalizeUnwrap(euint64.wrap(round.unwrapHandle), unwrapCleartext, decryptionProof);

            IERC20 inputToken = IERC20(surplusWrapper.underlying());
            IERC20 outputToken = IERC20(outputWrapper.underlying());
            uint256 underlyingIn = uint256(round.netSwapped) * rateIn;
            uint256 amountOut = _swapExactInput(inputToken, outputToken, underlyingIn);
            uint256 outputInWrapperUnits = amountOut / rateOut;
            if (outputInWrapperUnits > type(uint64).max - round.matched) revert SwapOutputOverflow();
            swapOutput = uint64(outputInWrapperUnits); // back to c-token units
            outputToken.forceApprove(address(outputWrapper), amountOut);
            outputWrapper.wrap(address(this), amountOut);
        }

        if (swapOutput < round.minSwapOutput) {
            revert SlippageExceeded(swapOutput, round.minSwapOutput);
        }
        round.executed = true;
        round.swapOutput = swapOutput;
        emit RoundSettled(roundId, round.aWasSurplus, round.matched, round.netSwapped, swapOutput);
    }

    // ------------------------------------------------------------------
    // Withdrawals — pro-rata, computed inside FHE
    // ------------------------------------------------------------------

    /// @notice Permissionless claim: pays a depositor their pro-rata payout in
    /// UNDERLYING tokens (vUSD/vETH) instead of confidential tokens. Anyone may
    /// call this for any user — the keeper runs it automatically so users never
    /// sign a withdraw or an unwrap. The batch burns its own c-token share and
    /// queues an async unwrap request to `user`; finalizing that request (also
    /// permissionless) transfers the plain underlying tokens.
    function withdrawForAndUnwrap(uint256 roundId, uint8 direction, address user) external {
        if (direction != DIRECTION_A_TO_B && direction != DIRECTION_B_TO_A) revert UnknownDirection();
        RoundState storage round = rounds[roundId];
        require(round.executed, RoundNotClosed());
        require(!withdrawn[roundId][direction][user], AlreadyWithdrawn());

        euint64 deposit = userDeposits[roundId][direction][user];
        require(FHE.isInitialized(deposit), NothingDeposited());
        withdrawn[roundId][direction][user] = true;

        if (direction == DIRECTION_A_TO_B) {
            if (round.totalAIn == 0) revert NothingDeposited();
            uint64 totalOutB = round.aWasSurplus ? round.matched + round.swapOutput : round.matched;
            euint128 share128 = FHE.div(FHE.mul(FHE.asEuint128(deposit), FHE.asEuint128(totalOutB)), uint128(round.totalAIn));
            euint64 share = FHE.asEuint64(share128);
            // The batch owns the c-tokens: burn its share and queue an async
            // unwrap request that pays `user` plain c-tokenB underlying.
            FHE.allowTransient(share, address(cTokenB));
            cTokenB.unwrap(address(this), user, share);
        } else {
            if (round.totalBIn == 0) revert NothingDeposited();
            uint64 totalOutA = round.aWasSurplus ? round.matched : round.matched + round.swapOutput;
            euint128 share128 = FHE.div(FHE.mul(FHE.asEuint128(deposit), FHE.asEuint128(totalOutA)), uint128(round.totalBIn));
            euint64 share = FHE.asEuint64(share128);
            FHE.allowTransient(share, address(cTokenA));
            cTokenA.unwrap(address(this), user, share);
        }
        emit ClaimedForUser(roundId, direction, user);
    }

    function withdraw(uint256 roundId, uint8 direction) external {
        if (direction != DIRECTION_A_TO_B && direction != DIRECTION_B_TO_A) revert UnknownDirection();
        RoundState storage round = rounds[roundId];
        require(round.executed, RoundNotClosed());
        require(!withdrawn[roundId][direction][msg.sender], AlreadyWithdrawn());

        euint64 deposit = userDeposits[roundId][direction][msg.sender];
        require(FHE.isInitialized(deposit), NothingDeposited());
        withdrawn[roundId][direction][msg.sender] = true;

        if (direction == DIRECTION_A_TO_B) {
            if (round.totalAIn == 0) revert NothingDeposited();
            // A-side always receives c-tokenB: the internal match plus, if the
            // A side was the surplus, the Uniswap output.
            uint64 totalOutB = round.aWasSurplus ? round.matched + round.swapOutput : round.matched;
            // euint128 math: deposit * totalOut can exceed 2^64 for full-range
            // amounts; widen before multiplying, narrow the (smaller) result.
            euint128 share128 = FHE.div(FHE.mul(FHE.asEuint128(deposit), FHE.asEuint128(totalOutB)), uint128(round.totalAIn));
            euint64 share = FHE.asEuint64(share128);
            FHE.allowTransient(share, address(cTokenB));
            cTokenB.confidentialTransfer(msg.sender, share);
        } else {
            if (round.totalBIn == 0) revert NothingDeposited();
            uint64 totalOutA = round.aWasSurplus ? round.matched : round.matched + round.swapOutput;
            euint128 share128 = FHE.div(FHE.mul(FHE.asEuint128(deposit), FHE.asEuint128(totalOutA)), uint128(round.totalBIn));
            euint64 share = FHE.asEuint64(share128);
            FHE.allowTransient(share, address(cTokenA));
            cTokenA.confidentialTransfer(msg.sender, share);
        }
    }

    // ------------------------------------------------------------------
    // Uniswap v4 swap — net leg only
    // ------------------------------------------------------------------

    function _swapExactInput(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn) internal virtual returns (uint256 amountOut) {
        Currency inputCurrency = Currency.wrap(address(tokenIn));
        Currency outputCurrency = Currency.wrap(address(tokenOut));
        bool zeroForOne = Currency.unwrap(poolKey.currency0) == address(tokenIn);

        bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: poolKey,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn), // net*rate fits uint128 (net ≤ 2^64)
                amountOutMinimum: 0, // guarded below via balance check + quote off-chain
                hookData: bytes('')
            })
        );
        params[1] = abi.encode(inputCurrency, amountIn); // SETTLE_ALL
        // TAKE with amount 0 (open delta) sends the full swap output straight
        // to the batcher. TAKE_ALL credits the router itself and does not sweep
        // on the deployed Universal Router — use the proven TAKE form.
        params[2] = abi.encode(outputCurrency, address(this), uint256(0)); // TAKE
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(
            abi.encodePacked(
                uint8(Actions.SWAP_EXACT_IN_SINGLE),
                uint8(Actions.SETTLE_ALL),
                uint8(Actions.TAKE)
            ),
            params
        );

        uint256 balanceBefore = tokenOut.balanceOf(address(this));
        tokenIn.forceApprove(address(permit2), amountIn);
        permit2.approve(
            address(tokenIn),
            address(router),
            uint160(amountIn),
            uint48(block.timestamp + 30 minutes)
        );
        router.execute(commands, inputs, block.timestamp + 30 minutes);
        amountOut = tokenOut.balanceOf(address(this)) - balanceBefore;
    }
}
