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
import {ILotPriceOracle} from "./interfaces/ILotPriceOracle.sol";

/// @title Prawl confidential batch swap — development implementation.
/// @dev Requires an independently reviewed oracle and security audit before production.
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
/// matched in whole A:B lots; the leftovers form the round's net residual. Because fhEVM
/// has no encrypted division, pro-rata division is avoided: deficit-side
/// payouts are the matched lots times the output lot size, and the surplus side's share of
/// the Uniswap output is residual × swapOutput / net — division by the
/// PUBLIC net only (FHE mul/div by clear scalars).
contract VeilBatchSwap is ZamaEthereumConfig, IERC7984Receiver {
    using SafeERC20 for IERC20;

    uint256 public constant VERSION = 6;

    uint8 public constant DIR_A_TO_B = 1; // sell c-tokenA, receive c-tokenB
    uint8 public constant DIR_B_TO_A = 2;

    /// Max orders per round — bounds the O(n²) encrypted netting gas.
    uint256 public constant MAX_ORDERS_PER_ROUND = 6;

    /// The net Uniswap leg must return at least this share of the quoted lot
    /// price (the router enforces it, and every order's private minimum is
    /// checked against it). A fully matched lot returns 100%.
    uint256 public constant SLIPPAGE_FLOOR_BPS = 9700;

    /// The pool's live price may differ from the round's snapshot by at most
    /// this much when a round is prepared and executed. The snapshot is a spot
    /// read taken at the first order, so without this bound the price could
    /// be pushed, snapshotted, and unwound before settlement.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 200;

    // A round snapshots a public oracle quote as exact A:B lots. Every order
    // in that round uses the same quote; direction and amount stay encrypted.
    struct RoundPrice { uint64 lotA; uint64 lotB; uint64 maxLots; uint256 validUntil; }
    mapping(uint256 => RoundPrice) public roundPrices;
    ILotPriceOracle public immutable priceOracle;
    uint256 public immutable maxPriceAge;

    struct RoundState {
        euint64 aToB; // encrypted total sold A→B, in lots
        euint64 bToA; // encrypted total sold B→A, in lots
        euint64 netEnc; // encrypted net residual (decrypted copy is public)
        euint8 surplusEnc; // encrypted surplus side (decrypted copy is public)
        bool closed;
        bool prepared;
        bool executed;
        uint64 netSwapped; // clear net residual in lots, after gateway decryption
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
    uint256 public immutable refundDelay;

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
    mapping(uint256 => uint256) public closedAt;
    mapping(uint256 => bool) public refundable;
    mapping(uint256 => mapping(address => bool)) public orderRefunded;

    mapping(uint256 => RoundState) public rounds;

    event Funded(address indexed user, uint8 indexed asset); // asset: 0 = A, 1 = B
    event OrderSubmitted(uint256 indexed round, address indexed user); // no direction, no amount
    event RoundClosed(uint256 indexed round);
    event RoundPrepared(uint256 indexed round, uint64 netSwapped, bytes32 unwrapHandle);
    event RoundSettled(uint256 indexed round, uint8 surplusSide, uint64 netSwapped, uint64 swapOutput);
    event OrderCredited(uint256 indexed round, address indexed user); // no amounts
    event RoundRefundable(uint256 indexed round);
    event OrderRefunded(uint256 indexed round, address indexed user);

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
    error SwapOutputOverflow();
    error SwapInputOverflow();
    error RefundTooEarly();
    error RoundNotRefundable();
    error AlreadyRefunded();
    error InvalidOraclePrice();
    error StaleOraclePrice();
    error PriceMovedSinceSnapshot();

    constructor(
        address router_,
        address permit2_,
        address cTokenA_,
        address cTokenB_,
        PoolKey memory poolKey_,
        uint256 minRoundDuration_,
        uint256 minDistinctSubmitters_,
        uint256 refundDelay_,
        address priceOracle_,
        uint256 maxPriceAge_
    ) {
        require(priceOracle_ != address(0), "zero price oracle");
        require(router_ != address(0) && permit2_ != address(0), "zero router");
        require(cTokenA_ != address(0) && cTokenB_ != address(0) && cTokenA_ != cTokenB_, "invalid wrappers");
        require(minRoundDuration_ > 0, "zero round duration");
        require(minDistinctSubmitters_ > 0 && minDistinctSubmitters_ <= MAX_ORDERS_PER_ROUND, "invalid submitter threshold");
        require(refundDelay_ > minRoundDuration_, "refund delay too short");
        require(maxPriceAge_ > minRoundDuration_, "price age too short");
        address assetA = address(ERC7984ERC20Wrapper(cTokenA_).underlying());
        address assetB = address(ERC7984ERC20Wrapper(cTokenB_).underlying());
        address currency0 = Currency.unwrap(poolKey_.currency0);
        address currency1 = Currency.unwrap(poolKey_.currency1);
        require(assetA != assetB && currency0 < currency1, "invalid pool ordering");
        require((currency0 == assetA && currency1 == assetB) || (currency0 == assetB && currency1 == assetA), "pool asset mismatch");
        router = IUniversalRouter(router_);
        permit2 = IPermit2(permit2_);
        cTokenA = ERC7984ERC20Wrapper(cTokenA_);
        cTokenB = ERC7984ERC20Wrapper(cTokenB_);
        poolKey = poolKey_;
        minRoundDuration = minRoundDuration_;
        minDistinctSubmitters = minDistinctSubmitters_;
        refundDelay = refundDelay_;
        priceOracle = ILotPriceOracle(priceOracle_);
        maxPriceAge = maxPriceAge_;
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

    /// @notice Public lifecycle only; order direction and value remain encrypted.
    function orderStatus(uint256 roundId, address user) external view returns (bool submitted, bool credited, bool refunded) {
        return (euint8.unwrap(_orderDir[roundId][user]) != 0, _orderCredited[roundId][user], orderRefunded[roundId][user]);
    }

    // ------------------------------------------------------------------
    // Orders — encrypted direction and amount, one shared entry point
    // ------------------------------------------------------------------

    /// @notice Submit an order from the funded confidential balance.
    /// @param encAmount encrypted order size in c-token units (6 dp).
    /// @param encDirection encrypted direction: 1 = sell A→B, 2 = sell B→A.
    /// @param encMinOutput encrypted minimum output in the output token's units.
    /// All values may come from ONE client-side encrypted input; the same
    /// input proof covers all handles. None is made public.
    function submitOrder(externalEuint64 encAmount, bytes calldata amountProof, externalEuint8 encDirection, bytes calldata directionProof, externalEuint64 encMinOutput, bytes calldata minOutputProof) external {
        RoundState storage round = rounds[currentRound];
        require(!round.closed, RoundNotOpen());
        require(euint8.unwrap(_orderDir[currentRound][msg.sender]) == 0, OrderAlreadySubmitted());
        require(_orderers[currentRound].length < MAX_ORDERS_PER_ROUND, TooManyOrders());
        RoundPrice storage price = _roundPrice(currentRound);
        require(block.timestamp <= price.validUntil, StaleOraclePrice());

        euint64 amt = FHE.fromExternal(encAmount, amountProof);
        euint8 dir = FHE.fromExternal(encDirection, directionProof);
        euint64 minOutput = FHE.fromExternal(encMinOutput, minOutputProof);

        (euint64 debitA, euint64 debitB) = _debit(amt, dir, minOutput, price);

        // Round totals (encrypted forever).
        euint64 prevA = FHE.isInitialized(round.aToB) ? round.aToB : FHE.asEuint64(0);
        euint64 prevB = FHE.isInitialized(round.bToA) ? round.bToA : FHE.asEuint64(0);
        euint64 orderLots = FHE.add(FHE.div(debitA, price.lotA), FHE.div(debitB, price.lotB));
        round.aToB = FHE.add(prevA, FHE.div(debitA, price.lotA));
        round.bToA = FHE.add(prevB, FHE.div(debitB, price.lotB));
        FHE.allowThis(round.aToB);
        FHE.allowThis(round.bToA);

        _orderAmount[currentRound][msg.sender] = orderLots;
        _orderDir[currentRound][msg.sender] = dir;
        FHE.allowThis(_orderAmount[currentRound][msg.sender]);
        FHE.allowThis(dir);

        if (!_isOrderer[currentRound][msg.sender]) {
            // A round's clock starts with its FIRST order, not when the previous round ended. Otherwise a round
            // that sat empty for longer than refundDelay would be expirable the moment someone ordered, and
            // anyone could refund (and so break) the first orderer's batch at once.
            if (_orderers[currentRound].length == 0) lastUpdateTime = block.timestamp;
            _orderers[currentRound].push(msg.sender);
            _isOrderer[currentRound][msg.sender] = true;
            ++distinctSubmitters;
        }

        emit OrderSubmitted(currentRound, msg.sender);
    }

    function _roundPrice(uint256 roundId) internal returns (RoundPrice storage price) {
        price = roundPrices[roundId];
        if (price.lotA != 0) return price;
        (uint64 a, uint64 b, uint256 updatedAt) = priceOracle.latestLotPrice();
        if (a == 0 || b == 0 || updatedAt == 0 || updatedAt > block.timestamp) revert InvalidOraclePrice();
        uint64 largest = a > b ? a : b;
        uint64 maxLots = type(uint64).max / uint64(MAX_ORDERS_PER_ROUND) / largest;
        if (maxLots == 0) revert InvalidOraclePrice();
        uint256 validUntil = updatedAt + maxPriceAge;
        if (validUntil < block.timestamp + minRoundDuration) revert StaleOraclePrice();
        price.lotA = a;
        price.lotB = b;
        price.maxLots = maxLots;
        price.validUntil = validUntil;
    }

    function _debit(euint64 amt, euint8 dir, euint64 minOutput, RoundPrice storage price) internal returns (euint64 debitA, euint64 debitB) {
        // Divide by each public lot size, then require an exact multiple.
        // Invalid, excessive, or underfunded orders are silently zeroed so
        // those checks do not create a public balance/direction oracle.
        euint64 lotsA = FHE.div(amt, price.lotA);
        euint64 lotsB = FHE.div(amt, price.lotB);
        ebool validA = FHE.and(FHE.eq(FHE.mul(lotsA, price.lotA), amt), FHE.le(lotsA, price.maxLots));
        ebool validB = FHE.and(FHE.eq(FHE.mul(lotsB, price.lotB), amt), FHE.le(lotsB, price.maxLots));
        // The net Uniswap leg must return at least SLIPPAGE_FLOOR_BPS of the
        // quoted lot price. A matched lot returns 100%. Compare each private
        // minimum against this worst-case floor before accepting any debit.
        euint64 floorA = FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(lotsA), uint128(price.lotB) * uint128(SLIPPAGE_FLOOR_BPS)), uint128(10000)));
        euint64 floorB = FHE.asEuint64(FHE.div(FHE.mul(FHE.asEuint128(lotsB), uint128(price.lotA) * uint128(SLIPPAGE_FLOOR_BPS)), uint128(10000)));
        validA = FHE.and(validA, FHE.le(minOutput, floorA));
        validB = FHE.and(validB, FHE.le(minOutput, floorB));
        debitA = FHE.select(FHE.and(FHE.eq(dir, DIR_A_TO_B), validA), amt, FHE.asEuint64(0));
        debitB = FHE.select(FHE.and(FHE.eq(dir, DIR_B_TO_A), validB), amt, FHE.asEuint64(0));

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
        require(block.timestamp <= roundPrices[currentRound].validUntil, StaleOraclePrice());
        round.closed = true;
        closedAt[currentRound] = block.timestamp;

        address[] memory orderers = _orderers[currentRound];
        uint256 n = orderers.length;

        // Greedy pairwise netting: match min(remaining_i, remaining_j) lots.
        // Sequential encrypted state, no
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

    /// @param clearValues abi.encode(uint64 netLots, uint8 surplusSide) — the
    ///        gateway decryption of the round's net residual and surplus side.
    /// @notice Verifies the gateway signatures, records the (public by design)
    ///         net/surplus, sets the on-chain slippage floor, and opens the
    ///         async unwrap request for the net residual.
    function prepareSettle(uint256 roundId, bytes calldata clearValues, bytes calldata decryptionProof) external {
        RoundState storage round = rounds[roundId];
        require(round.closed, RoundNotClosed());
        require(!refundable[roundId], RoundAlreadySettled());
        require(!round.prepared && !round.executed, RoundAlreadySettled());
        require(block.timestamp <= roundPrices[roundId].validUntil, StaleOraclePrice());

        (uint64 net, uint8 surplusSide) = abi.decode(clearValues, (uint64, uint8));
        require(surplusSide == DIR_A_TO_B || surplusSide == DIR_B_TO_A, UnknownDirection());

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = euint64.unwrap(round.netEnc);
        cts[1] = euint8.unwrap(round.surplusEnc);
        FHE.checkSignatures(cts, clearValues, decryptionProof);

        round.prepared = true;
        round.netSwapped = net;
        round.surplusSide = surplusSide;
        // This fixed development bound is relative to the configured lot
        // price; it is not an oracle or a substitute for user limits.
        RoundPrice storage price = roundPrices[roundId];
        uint64 inputLot = surplusSide == DIR_A_TO_B ? price.lotA : price.lotB;
        uint64 outputLot = surplusSide == DIR_A_TO_B ? price.lotB : price.lotA;
        uint64 inputUnits = net * inputLot;
        round.minSwapOutput = (uint256(net) * outputLot * SLIPPAGE_FLOOR_BPS + 9999) / 10000;
        // Do not burn the residual for unwrap if the pool has moved away from
        // the snapshot: the round then simply expires and refunds.
        if (net > 0) _requireSpotNearSnapshot(price);

        bytes32 unwrapHandle = 0;
        if (net > 0) {
            ERC7984ERC20Wrapper surplusWrapper = surplusSide == DIR_A_TO_B ? cTokenA : cTokenB;
            euint64 netEnc = FHE.asEuint64(inputUnits);
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
        require(!refundable[roundId], RoundAlreadySettled());
        require(!round.executed, RoundAlreadySettled());
        require(block.timestamp <= roundPrices[roundId].validUntil, StaleOraclePrice());

        uint64 swapOutput = 0;
        if (round.netSwapped > 0) {
            RoundPrice storage price = roundPrices[roundId];
            uint64 expectedInput = round.netSwapped * (round.surplusSide == DIR_A_TO_B ? price.lotA : price.lotB);
            if (unwrapCleartext != expectedInput) revert UnwrapMismatch(unwrapCleartext, expectedInput);
            ERC7984ERC20Wrapper surplusWrapper = round.surplusSide == DIR_A_TO_B ? cTokenA : cTokenB;
            ERC7984ERC20Wrapper outputWrapper = round.surplusSide == DIR_A_TO_B ? cTokenB : cTokenA;
            uint256 rateIn = surplusWrapper.rate();
            uint256 rateOut = outputWrapper.rate();

            _requireSpotNearSnapshot(price);
            _finalizeUnwrapOnce(surplusWrapper, round.unwrapHandle, unwrapCleartext, decryptionProof);

            IERC20 inputToken = IERC20(surplusWrapper.underlying());
            IERC20 outputToken = IERC20(outputWrapper.underlying());
            uint256 underlyingIn = uint256(expectedInput) * rateIn;
            uint256 amountOut = _swapExactInput(inputToken, outputToken, underlyingIn, uint256(round.minSwapOutput) * rateOut, price.lotA, price.lotB);
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
    ///   deficit side: payout = matchedLots_i × outputLotSize
    ///   surplus side: payout = matchedLots_i × outputLotSize
    ///                          + residualLots_i × swapOutput / netLots
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
        euint64 payout = _payout(roundId, user, dir, isA);

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

    /// @notice After a timeout, make an unexecuted round refundable. If a
    /// residual was already burned for asynchronous unwrap, its gateway proof
    /// must first finalize the unwrap; re-wrapping restores the vault backing.
    /// A stalled gateway can still delay this path until a proof is available.
    function expireRound(uint256 roundId, uint64 unwrapCleartext, bytes calldata proof) external {
        RoundState storage round = rounds[roundId];
        require(!round.executed && !refundable[roundId], RoundAlreadySettled());
        RoundPrice storage price = roundPrices[roundId];
        bool priceExpired = price.lotA != 0 && block.timestamp > price.validUntil;
        if (!round.closed) {
            require(roundId == currentRound, RoundNotOpen());
            require(priceExpired || block.timestamp >= lastUpdateTime + refundDelay, RefundTooEarly());
            round.closed = true;
            closedAt[roundId] = block.timestamp;
            ++currentRound;
            distinctSubmitters = 0;
            lastUpdateTime = block.timestamp;
        } else {
            require(priceExpired || block.timestamp >= closedAt[roundId] + refundDelay, RefundTooEarly());
        }
        if (round.prepared && round.netSwapped > 0) {
            ERC7984ERC20Wrapper wrapper = round.surplusSide == DIR_A_TO_B ? cTokenA : cTokenB;
            uint64 expected = round.netSwapped * (round.surplusSide == DIR_A_TO_B ? price.lotA : price.lotB);
            if (unwrapCleartext != expected) revert UnwrapMismatch(unwrapCleartext, expected);
            _finalizeUnwrapOnce(wrapper, round.unwrapHandle, unwrapCleartext, proof);
            IERC20 underlying = IERC20(wrapper.underlying());
            uint256 underlyingAmount = uint256(expected) * wrapper.rate();
            underlying.forceApprove(address(wrapper), underlyingAmount);
            wrapper.wrap(address(this), underlyingAmount);
        }
        refundable[roundId] = true;
        emit RoundRefundable(roundId);
    }

    /// @notice Restore one order's original encrypted input after expiry.
    /// Permissionless; the refund is credited only to the original owner.
    function refundOrder(uint256 roundId, address user) external {
        require(refundable[roundId], RoundNotRefundable());
        require(!orderRefunded[roundId][user], AlreadyRefunded());
        euint8 dir = _orderDir[roundId][user];
        require(euint8.unwrap(dir) != 0, NoOrder());
        orderRefunded[roundId][user] = true;
        euint64 lots = _orderAmount[roundId][user];
        RoundPrice storage price = roundPrices[roundId];
        euint64 inA = FHE.select(FHE.eq(dir, DIR_A_TO_B), FHE.mul(lots, price.lotA), FHE.asEuint64(0));
        euint64 inB = FHE.select(FHE.eq(dir, DIR_B_TO_A), FHE.mul(lots, price.lotB), FHE.asEuint64(0));
        euint64 balA = FHE.isInitialized(_funded[user][0]) ? _funded[user][0] : FHE.asEuint64(0);
        euint64 balB = FHE.isInitialized(_funded[user][1]) ? _funded[user][1] : FHE.asEuint64(0);
        euint64 newA = FHE.add(balA, inA);
        euint64 newB = FHE.add(balB, inB);
        FHE.allowThis(newA);
        FHE.allowThis(newB);
        FHE.allow(newA, user);
        FHE.allow(newB, user);
        _funded[user][0] = newA;
        _funded[user][1] = newB;
        emit OrderRefunded(roundId, user);
    }

    function _payout(uint256 roundId, address user, euint8 dir, ebool isA) internal returns (euint64 payout) {
        RoundState storage round = rounds[roundId];
        RoundPrice storage price = roundPrices[roundId];
        ebool onSurplusSide = FHE.eq(dir, FHE.asEuint8(round.surplusSide));
        euint64 matchedA = FHE.mul(_orderMatched[roundId][user], price.lotA);
        euint64 matchedB = FHE.mul(_orderMatched[roundId][user], price.lotB);
        payout = FHE.select(isA, matchedB, matchedA);
        if (round.netSwapped > 0) {
            // share of the Uniswap output: residual_i × swapOutput / net
            // Both operands are uint64, but their product need not fit in a
            // uint64. Widen *before* multiplication; narrowing only after
            // division is safe because residual <= net and output <= uint64.
            euint128 product = FHE.mul(FHE.asEuint128(_orderResidual[roundId][user]), uint128(round.swapOutput));
            euint64 swapShare = FHE.asEuint64(FHE.div(product, uint128(round.netSwapped)));
            payout = FHE.add(payout, FHE.select(onSurplusSide, swapShare, FHE.asEuint64(0)));
        }

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

    /// @dev `unwrapRequest` is permissionless: anyone holding the public
    /// decryption proof can finalize it, and a request can be finalized only
    /// once. If somebody already did, the tokens are already in this contract
    /// and finalizing again would revert, which would lock the round (settle
    /// and refund both depend on this step). Finalize only if still pending.
    function _finalizeUnwrapOnce(ERC7984ERC20Wrapper wrapper, bytes32 handle, uint64 cleartext, bytes calldata proof) internal {
        euint64 request = euint64.wrap(handle);
        if (wrapper.unwrapRequester(request) != address(0)) wrapper.finalizeUnwrap(request, cleartext, proof);
    }

    /// @dev Revert if the pool's live price is not within MAX_PRICE_DEVIATION_BPS
    /// of the round's snapshot. Compares the lotB/lotA ratios by cross-multiplication.
    function _requireSpotNearSnapshot(RoundPrice storage snapshot) internal view {
        (uint64 liveA, uint64 liveB, uint256 updatedAt) = priceOracle.latestLotPrice();
        if (liveA == 0 || liveB == 0 || updatedAt == 0) revert InvalidOraclePrice();
        uint256 snap = uint256(snapshot.lotB) * liveA; // snapshot price, scaled by liveA
        uint256 live = uint256(liveB) * snapshot.lotA; // live price, scaled by snapshot.lotA
        uint256 diff = snap > live ? snap - live : live - snap;
        if (diff * 10000 > snap * MAX_PRICE_DEVIATION_BPS) revert PriceMovedSinceSnapshot();
    }

    function _swapExactInput(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256 minAmountOut, uint64, uint64) internal virtual returns (uint256 amountOut) {
        if (amountIn > type(uint128).max || minAmountOut > type(uint128).max) revert SwapInputOverflow();
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
                amountOutMinimum: uint128(minAmountOut), // the slippage floor, enforced by the router
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
