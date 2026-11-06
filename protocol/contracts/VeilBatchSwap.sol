// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint8, euint64, euint128, externalEuint8, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
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

/// @title VeilBatchSwap v3 — fully confidential batched swaps.
///
/// Privacy model (honest version):
///  * Funding: a user moves confidential tokens (ERC-7984 wrappers) into this
///    vault once. That funding tx is public (wallet, token, amount) — it does
///    NOT hide the wallet↔funding link. Later orders draw on the funded
///    balance, so the funding amount does not reveal order sizes.
///  * Orders: direction AND amount are encrypted (euint8/euint64). One shared
///    order entry point for both assets; the order event carries no plaintext
///    direction or amount. The batch holds both c-tokens, so the entry path
///    does not reveal which side the user chose.
///  * Rounds: the two directional totals, the matched amount and every user's
///    order stay encrypted forever. Only the NET residual and WHICH side is in
///    surplus are publicly decryptable (needed to run the Uniswap leg).
///  * Payouts: credited back into the user's confidential vault balance —
///    never sent as plain ERC-20 by the settlement flow. Exits to plain
///    tokens are a separate, intentionally-public step.
///  * Public by design: relayer, round timing, token pair, the net Uniswap
///    trade, and (honestly) WHICH ADDRESSES ORDERED in a round. Batching
///    blurs per-order patterns; it is not an anonymity guarantee.
///
/// Matching: greedy pairwise netting inside FHE. For every pair of orders
/// with opposite (encrypted) directions, m = min(remaining_i, remaining_j) is
/// matched 1:1; the leftovers form the round's net residual. Because fhEVM
/// has no encrypted division, pro-rata division is avoided: deficit-side
/// payouts are exactly the matched amount, and the surplus side's share of
/// the Uniswap output is residual × swapOutput / net — division by the
/// PUBLIC net only (FHE mul/div by clear scalars).
contract VeilBatchSwap is ZamaEthereumConfig, IERC7984Receiver {
    using SafeERC20 for IERC20;

    uint256 public constant VERSION = 3;

    uint8 public constant DIR_A_TO_B = 1; // sell c-tokenA, receive c-tokenB
    uint8 public constant DIR_B_TO_A = 2;

    /// Max orders per round — bounds the O(n²) encrypted netting gas.
    uint256 public constant MAX_ORDERS_PER_ROUND = 6;

    struct RoundState {
        euint64 aToB; // encrypted total sold A→B (c-tokenA units)
        euint64 bToA; // encrypted total sold B→A (c-tokenB units)
        euint64 netEnc; // encrypted net residual (decrypted copy is public)
        euint8 surplusEnc; // encrypted surplus side (decrypted copy is public)
        bool closed;
        bool prepared;
        bool executed;
        uint64 netSwapped; // clear net residual, after gateway decryption
        uint8 surplusSide; // clear surplus side (1 = A, 2 = B)
        uint256 minSwapOutput; // slippage floor in c-units, set on-chain
        bytes32 unwrapHandle; // pending async unwrap request for the net
        uint64 swapOutput; // Uniswap leg output, c-units of the other token
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

    // Confidential funding vault: [user][0 = asset A, 1 = asset B].
    mapping(address => mapping(uint8 => euint64)) private _funded;

    // Orders per round.
    mapping(uint256 => mapping(address => euint64)) private _orderAmount;
    mapping(uint256 => mapping(address => euint8)) private _orderDir;
    mapping(uint256 => mapping(address => euint64)) private _orderMatched;
    mapping(uint256 => mapping(address => euint64)) private _orderResidual;
    mapping(uint256 => mapping(address => bool)) private _orderCredited;
    mapping(uint256 => address[]) private _orderers;
    mapping(uint256 => mapping(address => bool)) private _isOrderer;

    mapping(uint256 => RoundState) public rounds;

    event Funded(address indexed user, uint8 indexed asset); // asset: 0 = A, 1 = B
    event OrderSubmitted(uint256 indexed round, address indexed user); // no direction, no amount
    event RoundClosed(uint256 indexed round);
    event RoundPrepared(uint256 indexed round, uint64 netSwapped, bytes32 unwrapHandle);
    event RoundSettled(uint256 indexed round, uint8 surplusSide, uint64 netSwapped, uint64 swapOutput);
    event OrderCredited(uint256 indexed round, address indexed user); // no amounts

    error RoundNotOpen();
    error OrderAlreadySubmitted();
    error TooManyOrders();
    error TooEarlyForNextRound();
    error NotEnoughSubmitters();
    error RoundAlreadyClosed();
    error RoundNotClosed();
    error RoundAlreadySettled();
    error RoundNotPrepared();
    error UnwrapMismatch(uint64 provided, uint64 expected);
    error UnknownDirection();
    error UntrustedToken();
    error NoOrder();
    error AlreadyCredited();
    error SlippageExceeded(uint256 swapOutput, uint256 minSwapOutput);
    error NotSettler();
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
    // Confidential funding vault
    // ------------------------------------------------------------------

    /// @notice ERC-7984 receiver hook. Empty data (or a single 0x00 byte)
    /// funds the sender's confidential balance of the transferred asset.
    /// Funding is public by design (see the header); the credited amount is
    /// stored encrypted so it never reveals order sizes.
    function onConfidentialTransferReceived(
        address, // operator — always the wrapper
        address from,
        euint64 eAmount,
        bytes calldata data
    ) external returns (ebool success) {
        if (msg.sender != address(cTokenA) && msg.sender != address(cTokenB)) {
            success = FHE.asEbool(false);
            FHE.allow(success, msg.sender);
            return success;
        }
        if (data.length != 0 && !(data.length == 1 && data[0] == 0x00)) {
            success = FHE.asEbool(false);
            FHE.allow(success, msg.sender);
            return success;
        }
        uint8 asset = msg.sender == address(cTokenA) ? 0 : 1;

        euint64 previous = FHE.isInitialized(_funded[from][asset]) ? _funded[from][asset] : FHE.asEuint64(0);
        euint64 updated = FHE.add(previous, eAmount);
        // Reject zero-value and uint64-overflowing funding without exposing
        // either condition (the wrapper refunds when success is false).
        ebool accepted = FHE.gt(updated, previous);
        updated = FHE.select(accepted, updated, previous);
        FHE.allowThis(updated);
        FHE.allow(updated, from);
        _funded[from][asset] = updated;
        // Initialize the other side too, so the user can always decrypt both
        // balances (uninitialized handles cannot be user-decrypted).
        uint8 other = asset == 0 ? uint8(1) : uint8(0);
        if (!FHE.isInitialized(_funded[from][other])) {
            _funded[from][other] = FHE.asEuint64(0);
            FHE.allowThis(_funded[from][other]);
            FHE.allow(_funded[from][other], from);
        }

        emit Funded(from, asset);
        success = accepted;
        FHE.allow(success, msg.sender);
        return success;
    }

    /// @notice Encrypted handle of a user's funded balance (for self-decryption).
    function fundedBalance(address user, uint8 asset) external view returns (euint64) {
        return _funded[user][asset];
    }

    // ------------------------------------------------------------------
    // Orders — encrypted direction and amount, one shared entry point
    // ------------------------------------------------------------------

    /// @notice Submit an order from the funded confidential balance.
    /// @param encAmount encrypted order size in c-token units (6 dp).
    /// @param encDirection encrypted direction: 1 = sell A→B, 2 = sell B→A.
    /// Both values come from ONE client-side encrypted input; the same input
    /// proof covers both handles. Neither value is ever public.
    function submitOrder(externalEuint64 encAmount, bytes calldata amountProof, externalEuint8 encDirection, bytes calldata directionProof) external {
        RoundState storage round = rounds[currentRound];
        require(!round.closed, RoundNotOpen());
        require(euint8.unwrap(_orderDir[currentRound][msg.sender]) == 0, OrderAlreadySubmitted());
        require(_orderers[currentRound].length < MAX_ORDERS_PER_ROUND, TooManyOrders());

        euint64 amt = FHE.fromExternal(encAmount, amountProof);
        euint8 dir = FHE.fromExternal(encDirection, directionProof);

        // Debit the funded balance of the chosen asset. The direction stays
        // encrypted: each side's debit is the amount masked by the direction
        // bit, and an underfunded order is silently zeroed (OZ pattern) so
        // the revert-or-not channel never leaks the balance comparison.
        ebool isA = FHE.eq(dir, DIR_A_TO_B);
        ebool isB = FHE.eq(dir, DIR_B_TO_A);
        euint64 debitA = FHE.select(isA, amt, FHE.asEuint64(0));
        euint64 debitB = FHE.select(isB, amt, FHE.asEuint64(0));

        euint64 balA = FHE.isInitialized(_funded[msg.sender][0]) ? _funded[msg.sender][0] : FHE.asEuint64(0);
        euint64 balB = FHE.isInitialized(_funded[msg.sender][1]) ? _funded[msg.sender][1] : FHE.asEuint64(0);
        debitA = FHE.select(FHE.ge(balA, debitA), debitA, FHE.asEuint64(0));
        debitB = FHE.select(FHE.ge(balB, debitB), debitB, FHE.asEuint64(0));

        euint64 newBalA = FHE.sub(balA, debitA);
        euint64 newBalB = FHE.sub(balB, debitB);
        FHE.allowThis(newBalA);
        FHE.allowThis(newBalB);
        FHE.allow(newBalA, msg.sender);
        FHE.allow(newBalB, msg.sender);
        _funded[msg.sender][0] = newBalA;
        _funded[msg.sender][1] = newBalB;

        // Round totals (encrypted forever).
        euint64 prevA = FHE.isInitialized(round.aToB) ? round.aToB : FHE.asEuint64(0);
        euint64 prevB = FHE.isInitialized(round.bToA) ? round.bToA : FHE.asEuint64(0);
        round.aToB = FHE.add(prevA, debitA);
        round.bToA = FHE.add(prevB, debitB);
        FHE.allowThis(round.aToB);
        FHE.allowThis(round.bToA);

        _orderAmount[currentRound][msg.sender] = FHE.add(debitA, debitB); // exactly one side is non-zero
        _orderDir[currentRound][msg.sender] = dir;
        FHE.allowThis(_orderAmount[currentRound][msg.sender]);
        FHE.allowThis(dir);

        if (!_isOrderer[currentRound][msg.sender]) {
            _orderers[currentRound].push(msg.sender);
            _isOrderer[currentRound][msg.sender] = true;
            ++distinctSubmitters;
        }

        emit OrderSubmitted(currentRound, msg.sender);
    }

    // ------------------------------------------------------------------
    // Phase 1 — close the round: encrypted netting, nothing decrypts
    // ------------------------------------------------------------------

    /// @notice Close the round and run the greedy pairwise netting entirely
    /// inside FHE. Per-order matched/residual amounts are computed and stored
    /// encrypted. Only the NET residual and the surplus SIDE become publicly
    /// decryptable — never the two totals, never the matched amount, never
    /// any user's order.
    function closeRound() external {
        require(block.timestamp >= lastUpdateTime + minRoundDuration, TooEarlyForNextRound());
        require(distinctSubmitters >= minDistinctSubmitters, NotEnoughSubmitters());
        RoundState storage round = rounds[currentRound];
        require(!round.closed, RoundAlreadyClosed());
        round.closed = true;

        address[] memory orderers = _orderers[currentRound];
        uint256 n = orderers.length;

        // Greedy pairwise netting: for every opposite-direction pair, match
        // min(remaining_i, remaining_j) 1:1. Sequential encrypted state, no
        // branching on encrypted values.
        euint64[] memory remaining = new euint64[](n);
        euint64[] memory matched = new euint64[](n);
        for (uint256 i = 0; i < n; ++i) {
            remaining[i] = _orderAmount[currentRound][orderers[i]];
            matched[i] = FHE.asEuint64(0);
        }
        for (uint256 i = 0; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                ebool opposite = FHE.not(FHE.eq(_orderDir[currentRound][orderers[i]], _orderDir[currentRound][orderers[j]]));
                euint64 m = FHE.min(remaining[i], remaining[j]);
                m = FHE.select(opposite, m, FHE.asEuint64(0));
                remaining[i] = FHE.sub(remaining[i], m);
                remaining[j] = FHE.sub(remaining[j], m);
                matched[i] = FHE.add(matched[i], m);
                matched[j] = FHE.add(matched[j], m);
            }
        }
        for (uint256 i = 0; i < n; ++i) {
            _orderMatched[currentRound][orderers[i]] = matched[i];
            _orderResidual[currentRound][orderers[i]] = remaining[i];
            FHE.allowThis(matched[i]);
            FHE.allowThis(remaining[i]);
        }

        // Round totals for the net computation (stay encrypted).
        if (!FHE.isInitialized(round.aToB)) {
            round.aToB = FHE.asEuint64(0);
            FHE.allowThis(round.aToB);
        }
        if (!FHE.isInitialized(round.bToA)) {
            round.bToA = FHE.asEuint64(0);
            FHE.allowThis(round.bToA);
        }
        euint64 net = FHE.sub(FHE.max(round.aToB, round.bToA), FHE.min(round.aToB, round.bToA));
        ebool aSurplus = FHE.ge(round.aToB, round.bToA);
        euint8 surplus = FHE.select(aSurplus, FHE.asEuint8(1), FHE.asEuint8(2));
        round.netEnc = net;
        round.surplusEnc = surplus;
        FHE.allowThis(net);
        FHE.allowThis(surplus);
        // The ONLY two values made publicly decryptable in the whole protocol.
        FHE.makePubliclyDecryptable(net);
        FHE.makePubliclyDecryptable(surplus);

        emit RoundClosed(currentRound);

        currentRound++;
        distinctSubmitters = 0;
        lastUpdateTime = block.timestamp;
    }

    // ------------------------------------------------------------------
    // Phase 2 — prepare (settler) then execute (permissionless)
    // ------------------------------------------------------------------

    /// @param clearValues abi.encode(uint64 net, uint8 surplusSide) — the
    ///        gateway decryption of the round's net residual and surplus side.
    /// @notice Verifies the gateway signatures, records the (public by design)
    ///         net/surplus, sets the on-chain slippage floor, and opens the
    ///         async unwrap request for the net residual.
    function prepareSettle(uint256 roundId, bytes calldata clearValues, bytes calldata decryptionProof) external {
        if (msg.sender != settler) revert NotSettler();
        RoundState storage round = rounds[roundId];
        require(round.closed, RoundNotClosed());
        require(!round.prepared && !round.executed, RoundAlreadySettled());

        (uint64 net, uint8 surplusSide) = abi.decode(clearValues, (uint64, uint8));
        require(surplusSide == DIR_A_TO_B || surplusSide == DIR_B_TO_A, UnknownDirection());

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = euint64.unwrap(round.netEnc);
        cts[1] = euint8.unwrap(round.surplusEnc);
        FHE.checkSignatures(cts, clearValues, decryptionProof);

        round.prepared = true;
        round.netSwapped = net;
        round.surplusSide = surplusSide;
        // Slippage floor computed on-chain: 90% of the net input (the batch
        // price is 1:1 internally, so the net leg should not lose >10%).
        round.minSwapOutput = (net * 9000) / 10000;

        bytes32 unwrapHandle = 0;
        if (net > 0) {
            ERC7984ERC20Wrapper surplusWrapper = surplusSide == DIR_A_TO_B ? cTokenA : cTokenB;
            euint64 netEnc = FHE.asEuint64(net);
            FHE.allowTransient(netEnc, address(surplusWrapper));
            // _burn may re-key the handle; the returned value is the one the
            // wrapper made publicly decryptable and registered as the request.
            euint64 unwrapped = surplusWrapper.unwrap(address(this), address(this), netEnc);
            unwrapHandle = FHE.toBytes32(unwrapped);
            round.unwrapHandle = unwrapHandle;
        }
        emit RoundPrepared(roundId, net, unwrapHandle);
    }

    /// @param unwrapCleartext the gateway-decrypted value of the unwrap request
    /// @notice Permissionless: finalizes the unwrap, swaps the net leg on
    ///         Uniswap v4, wraps the output back, and enforces the slippage
    ///         guard. The per-order encrypted matched/residual amounts are
    ///         untouched here — payouts credit confidential vault balances.
    function executeSettle(uint256 roundId, uint64 unwrapCleartext, bytes calldata decryptionProof) external {
        RoundState storage round = rounds[roundId];
        require(round.prepared, RoundNotPrepared());
        require(!round.executed, RoundAlreadySettled());

        uint64 swapOutput = 0;
        if (round.netSwapped > 0) {
            if (unwrapCleartext != round.netSwapped) revert UnwrapMismatch(unwrapCleartext, round.netSwapped);
            ERC7984ERC20Wrapper surplusWrapper = round.surplusSide == DIR_A_TO_B ? cTokenA : cTokenB;
            ERC7984ERC20Wrapper outputWrapper = round.surplusSide == DIR_A_TO_B ? cTokenB : cTokenA;
            uint256 rateIn = surplusWrapper.rate();
            uint256 rateOut = outputWrapper.rate();

            surplusWrapper.finalizeUnwrap(euint64.wrap(round.unwrapHandle), unwrapCleartext, decryptionProof);

            IERC20 inputToken = IERC20(surplusWrapper.underlying());
            IERC20 outputToken = IERC20(outputWrapper.underlying());
            uint256 underlyingIn = uint256(round.netSwapped) * rateIn;
            uint256 amountOut = _swapExactInput(inputToken, outputToken, underlyingIn);
            uint256 outputInWrapperUnits = amountOut / rateOut;
            if (outputInWrapperUnits > type(uint64).max) revert SwapOutputOverflow();
            swapOutput = uint64(outputInWrapperUnits);
            outputToken.forceApprove(address(outputWrapper), amountOut);
            outputWrapper.wrap(address(this), amountOut);
        }

        if (swapOutput < round.minSwapOutput) {
            revert SlippageExceeded(swapOutput, round.minSwapOutput);
        }
        round.executed = true;
        round.swapOutput = swapOutput;
        emit RoundSettled(roundId, round.surplusSide, round.netSwapped, swapOutput);
    }

    // ------------------------------------------------------------------
    // Payouts — credited to confidential vault balances, permissionless
    // ------------------------------------------------------------------

    /// @notice Credit an orderer's payout back into their confidential vault
    /// balance (never plain ERC-20 — that would expose the payout amount and
    /// recipient). Permissionless: anyone may credit anyone; the credit always
    /// lands in the orderer's own encrypted balance. Single-credit enforced
    /// with a flag; the credited amounts stay encrypted.
    ///
    /// Payout math (no encrypted division):
    ///   deficit side: payout = matched_i                       (1:1 match)
    ///   surplus side: payout = matched_i + residual_i × swapOutput / net
    /// where swapOutput and net are public by design; the mul/div use clear
    /// scalars, which fhEVM supports.
    function creditOrder(uint256 roundId, address user) external {
        RoundState storage round = rounds[roundId];
        require(round.executed, RoundNotClosed());
        euint8 dir = _orderDir[roundId][user];
        require(euint8.unwrap(dir) != 0, NoOrder());
        require(!_orderCredited[roundId][user], AlreadyCredited());
        _orderCredited[roundId][user] = true;

        ebool isA = FHE.eq(dir, DIR_A_TO_B); // sold A → receives B
        ebool onSurplusSide = FHE.eq(dir, FHE.asEuint8(round.surplusSide));

        euint64 payout = _orderMatched[roundId][user];
        if (round.netSwapped > 0) {
            // share of the Uniswap output: residual_i × swapOutput / net
            euint64 swapShare = FHE.div(
                FHE.mul(_orderResidual[roundId][user], round.swapOutput),
                round.netSwapped
            );
            payout = FHE.add(payout, FHE.select(onSurplusSide, swapShare, FHE.asEuint64(0)));
        }

        // Sold A → the payout lands in the B balance, and vice versa.
        euint64 toA = FHE.select(isA, FHE.asEuint64(0), payout);
        euint64 toB = FHE.select(isA, payout, FHE.asEuint64(0));

        euint64 balA = FHE.isInitialized(_funded[user][0]) ? _funded[user][0] : FHE.asEuint64(0);
        euint64 balB = FHE.isInitialized(_funded[user][1]) ? _funded[user][1] : FHE.asEuint64(0);
        euint64 newA = FHE.add(balA, toA);
        euint64 newB = FHE.add(balB, toB);
        FHE.allowThis(newA);
        FHE.allowThis(newB);
        FHE.allow(newA, user);
        FHE.allow(newB, user);
        _funded[user][0] = newA;
        _funded[user][1] = newB;

        emit OrderCredited(roundId, user);
    }

    /// @notice Exit: unwrap part of the caller's confidential balance to plain
    /// ERC-20 in their wallet. Intentionally public (funding/exit leg — see
    /// the header). The amount is caller-supplied and capped by the caller's
    /// own encrypted balance (silently zeroed if larger, OZ pattern). The
    /// unwrap is async: anyone finalizes it and the underlying arrives.
    function exit(uint8 asset, externalEuint64 encAmount, bytes calldata proof) external {
        require(asset <= 1, UnknownDirection());
        euint64 amt = FHE.fromExternal(encAmount, proof);
        euint64 bal = FHE.isInitialized(_funded[msg.sender][asset]) ? _funded[msg.sender][asset] : FHE.asEuint64(0);
        amt = FHE.select(FHE.ge(bal, amt), amt, FHE.asEuint64(0));
        euint64 newBal = FHE.sub(bal, amt);
        FHE.allowThis(newBal);
        FHE.allow(newBal, msg.sender);
        _funded[msg.sender][asset] = newBal;

        ERC7984ERC20Wrapper w = asset == 0 ? cTokenA : cTokenB;
        FHE.allowTransient(amt, address(w));
        w.unwrap(address(this), msg.sender, amt);
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
                amountIn: uint128(amountIn),
                amountOutMinimum: 0, // guarded below via balance check + slippage floor
                hookData: bytes('')
            })
        );
        params[1] = abi.encode(inputCurrency, amountIn); // SETTLE_ALL
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
