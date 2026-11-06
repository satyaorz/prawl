// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrawlCodec} from "./PrawlCodec.sol";
import {PrawlV3Codec as V3} from "./PrawlV3Codec.sol";
import {RailgunTypes, IRailgunSmartWallet, IWETH} from "./RailgunTypes.sol";

/// @notice The part of DeviceBondRegistry that the attested deposit paths need (same interface as v2/v3).
interface IOtkChecker {
    function checkOtk(bytes calldata leaf, bytes32 akId)
        external
        view
        returns (bytes32 x, bytes32 y, bytes32 keyHash, uint256 fails);

    function bonds(bytes32 akId) external view returns (address owner, uint96 amount, uint64 unlockAt, bool slashed);
}

/// @title PrawlEscrowV31 -- Prawl v3 offline coins + private funding (RAILGUN), shielded redemption, refresh
/// @notice Everything PrawlEscrowV3 does (raw/v3/SPEC.md; same messages, same rules, same storage slots 0..6),
///  plus (v3.1, justified in RESULTS.md):
///   * COMMIT-THEN-FUND deposits. The coin parameters (coinId, expiry, k0, depositor, minValue, maxValue, tip)
///     determine a per-coin CREATE2 "deposit address". Anyone (a RAILGUN unshield, any account) sends WETH or
///     ETH there; `activate` deploys a 56-byte forwarder at that address, pulls the funds, unwraps WETH and
///     creates the coin. The funds at a deposit address can only ever back the parameters that hash to it,
///     so attribution needs no memo and cannot be front-run. `commitDeposit` (optional) reserves the coinId
///     in advance. `deposits[coinId]` (slot 0) holds the same v3 commitment; `depositor` is the reclaim
///     address named in the parameters (never the funder).
///   * PRAWL-REDEEM-SHIELD outputs: `redeemToShield` pays a phone-signed output into RAILGUN. The output's
///     key hash commits to the whole ShieldRequest, so the submitter cannot redirect it.
///   * PRAWL-REFRESH outputs: `refresh` moves a note's value into a fresh coin (new expiry, new genesis key,
///     new depositor) without any ETH moving. The new coinId is derived from the signed message.
///
///  STORAGE LAYOUT IS PART OF THE PROTOCOL: `deposits` must stay in slot 0 (light-client deposit proofs prove
///  storage key keccak256(abi.encode(coinId, uint256(0)))); `coins` is slot 1, `firstMsg` slot 2.
contract PrawlEscrowV31 {
    // ================================================================ storage (ORDER IS NORMATIVE)

    /// @notice slot 0. coinId => keccak256(abi.encode(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y,
    ///  address depositor)). Written once when the coin is created (deposit / activate / refresh), never deleted.
    mapping(bytes32 => bytes32) public deposits;

    /// @notice slot 1. Mutable per-coin state, packed into one word: paid (low 128 bits) | frozen | closed.
    mapping(bytes32 => CoinState) public coins;

    /// @notice slot 2. One-time key hash => sha256 of the first spend message it was seen signing, or BROKEN.
    mapping(bytes32 => bytes32) public firstMsg;

    /// @notice slot 3. Broken key hash => the first equivocation recorded against it.
    mapping(bytes32 => Evidence) public evidence;

    /// @notice slot 4. keccak256(abi.encode(sha256(redeem message), outputIndex)) => paid (any output kind).
    mapping(bytes32 => bool) public redeemed;

    /// @notice slot 5. Payments whose push failed (payout contract reverted), withdrawable by the payee.
    mapping(address => uint256) public owed;

    /// @notice slot 6. DeviceBondRegistry for the attested paths (set once by the deployer).
    IOtkChecker public registry;

    /// @notice slot 7 (v3.1). coinId => keccak256(abi.encode(DepositParams)) reserved by `commitDeposit`.
    mapping(bytes32 => bytes32) public pendingDeposits;

    /// @notice slot 8 (AUDIT F3). coinId => total value of the notes whose keys were proven broken in this coin
    ///  (bounds what a frozen coin's sweep can send to the compensation sink).
    mapping(bytes32 => uint256) public quarantined;

    /// @notice slot 9 (AUDIT F3). keccak256(abi.encode(coinId, keyHash)) => that key's note value is already in `quarantined`.
    mapping(bytes32 => bool) public brokenCounted;

    /// @dev Transient (EIP-1153): the deposit address whose ETH `receive` currently accepts (during `_pull` only).
    address private transient _expectEthFrom;

    // ================================================================ types

    struct CoinState {
        uint128 paid; // total redeemed (paid out, shielded or refreshed) from this coin
        bool frozen; // an equivocation was proven inside this coin's tree
        bool closed; // reclaimed (or remainder swept) after expiry + grace
    }

    struct Evidence {
        bytes32 coinId;
        bytes32 msgA;
        bytes32 msgB;
    }

    /// @notice The coin header every holder carries; checked against `deposits[coinId]`.
    struct Header {
        bytes32 coinId;
        uint256 value;
        uint64 expiry;
        uint256 k0x;
        uint256 k0y;
        address depositor;
    }

    struct Spend {
        V3.Output[] outputs;
        uint256 index;
        bytes32 r;
        bytes32 s;
        bytes32 nextX;
        bytes32 nextY;
    }

    /// @notice The final spend, signed by the redeemed note's own key. For `redeem` outputs[index] is a
    ///  PRAWL-REDEEM output for `payout`; for `refresh` `payout` is the new coin's depositor; `redeemToShield`
    ///  ignores `payout`.
    struct Redemption {
        V3.Output[] outputs;
        uint256 index;
        address payout;
        bytes32 r;
        bytes32 s;
    }

    struct Signed {
        bytes message;
        bytes32 r;
        bytes32 s;
    }

    /// @notice Parameters of a commit-then-fund coin. keccak256(abi.encode(p)) is the CREATE2 salt of its
    ///  deposit address. The coin's value is min(received - tip, maxValue) and must be >= minValue; the rest
    ///  goes to `depositor`. Exact-value coin: minValue == maxValue.
    struct DepositParams {
        bytes32 coinId;
        uint64 expiry;
        uint256 k0x;
        uint256 k0y;
        address depositor; // reclaim (and refund / excess) address; part of the slot-0 commitment
        uint256 minValue;
        uint256 maxValue;
        uint256 tip; // paid to whoever calls `activate` (a relayer, so the owner needs no public ETH)
    }

    /// @dev A coin about to be created (memory: keeps the legacy code generator's stack small).
    struct CoinInit {
        bytes32 coinId;
        uint256 value;
        uint64 expiry;
        uint256 k0x;
        uint256 k0y;
        address depositor;
    }

    struct Walk {
        bytes prefix;
        bytes32 x;
        bytes32 y;
        bytes32 kh;
        uint256 value;
        bytes32 noteId;
        uint256 depth;
    }

    // ================================================================ constants / immutables

    address internal constant P256VERIFY = address(0x100);
    bytes32 internal constant BROKEN = bytes32(uint256(1));

    /// @notice AUDIT F2: protocol-level fan-out bound. Wallets MUST refuse (when creating and when receiving) any
    ///  spend with more outputs; a redemption has to carry every output of every spend on its path.
    uint256 public constant MAX_OUTPUTS = 32;

    uint8 internal constant REC_OK = 0;
    uint8 internal constant REC_CONFLICT = 1;
    uint8 internal constant REC_BROKEN = 2;

    /// @dev Deposit-address initcode = INIT_HEAD || PUSH20 <this escrow> || RUNTIME_TAIL. The 56-byte runtime:
    ///  if CALLER != escrow: STOP (so it accepts ETH from anyone, also with a 2300-gas stipend); else
    ///  CALL(gas, target = calldata[0:32], value = calldata[32:64], data = calldata[64:]) and revert on failure.
    ///    PUSH20 escrow CALLER EQ PUSH1 0x1b JUMPI STOP JUMPDEST PUSH1 0x40 CALLDATASIZE SUB DUP1 PUSH1 0x40 PUSH0
    ///    CALLDATACOPY PUSH0 PUSH0 DUP3 PUSH0 PUSH1 0x20 CALLDATALOAD PUSH0 CALLDATALOAD GAS CALL PUSH1 0x36 JUMPI
    ///    PUSH0 PUSH0 REVERT JUMPDEST STOP
    ///  INIT_HEAD copies those 56 bytes (at code offset 9) to memory and returns them.
    ///  INIT_HEAD = PUSH1 0x38 DUP1 PUSH1 0x09 PUSH0 CODECOPY PUSH0 RETURN.
    bytes9 internal constant INIT_HEAD = 0x60388060095f395ff3;
    bytes internal constant RUNTIME_TAIL = hex"3314601b57005b604036038060405f375f5f825f6020355f355af16036575f5ffd5b00";

    uint256 public immutable grace;
    uint256 public immutable maxLifetime;
    address public immutable compensationSink;
    bool public immutable requireBondedDevice;
    address public immutable deployer;
    /// @notice WETH9 accepted at deposit addresses and used for shields (RAILGUN's wrappedBaseToken). 0 = off.
    IWETH public immutable weth;
    /// @notice RailgunSmartWallet for `redeemToShield`. 0 = off.
    IRailgunSmartWallet public immutable railgun;
    /// @notice keccak256 of the deposit-address initcode (fixed per escrow).
    bytes32 public immutable depositInitCodeHash;

    // ================================================================ events

    event Deposited(
        bytes32 indexed coinId,
        address indexed depositor,
        uint256 value,
        uint64 expiry,
        uint256 k0x,
        uint256 k0y,
        bytes32 k0Hash,
        bytes32 commitment
    );
    event DepositAttested(bytes32 indexed coinId, bytes32 indexed akId, bytes32 k0Hash);
    event DepositCommitted(bytes32 indexed coinId, address indexed depositAddress, bytes32 paramsHash, DepositParams p);
    event DepositActivated(
        bytes32 indexed coinId, address indexed depositAddress, uint256 received, uint256 tip, uint256 excess
    );
    event DepositRefunded(bytes32 indexed coinId, address indexed depositAddress, address to, uint256 amount);
    event SpendRecorded(bytes32 indexed coinId, bytes32 indexed keyHash, uint256 depth, bytes32 msgHash);
    /// @notice Every paid output (any kind). `payout` is the RAILGUN contract for a shield and this escrow for a refresh.
    event Redeemed(
        bytes32 indexed coinId,
        address indexed payout,
        bytes32 indexed noteId,
        uint256 outputIndex,
        uint256 amount,
        bytes32 msgHash,
        uint256 totalPaid
    );
    event RedeemedToShield(bytes32 indexed coinId, bytes32 indexed npk, bytes32 shieldHash, uint256 amount);
    event Refreshed(bytes32 indexed coinId, bytes32 indexed newCoinId, uint256 amount);
    event Equivocation(bytes32 indexed coinId, bytes32 indexed keyHash, bytes32 msgA, bytes32 msgB);
    event CoinFrozen(bytes32 indexed coinId, bytes32 indexed keyHash);
    event RedeemBlocked(bytes32 indexed coinId, bytes32 indexed keyHash, uint256 depth);
    event Reclaimed(bytes32 indexed coinId, address indexed depositor, uint256 amount);
    event FrozenRemainderSwept(bytes32 indexed coinId, address indexed sink, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event OwedWithdrawn(address indexed to, uint256 amount);
    event RegistrySet(address registry);

    // ================================================================ errors

    error BadValue();
    error BadExpiry();
    error CoinExists();
    error ReservedCoinId(); // the refresh namespace ("RFSH" prefix) cannot be deposited/committed directly
    error BadHeader();
    error RedeemWindowClosed();
    error ZeroPayout();
    error ConservationViolated(uint256 depth, uint256 outputsSum, uint256 noteValue);
    error ZeroOutput(uint256 depth);
    error BadSig(uint256 depth);
    error BadIndex(uint256 depth);
    error OutputKeyMismatch(uint256 depth);
    error NotRedeemOutput();
    error AlreadyRedeemed(bytes32 redemptionId);
    error CapExceeded(uint256 paid, uint256 amount, uint256 deposit);
    error KeyBroken(uint256 depth, bytes32 keyHash);
    error SameMessage();
    error NothingNew(bytes32 keyHash);
    error TooEarly();
    error AlreadyClosed();
    error NotOneTimeKey(uint256 policyFails);
    error DeviceNotBonded(bytes32 akId);
    error RegistryLocked();
    error NoRegistry();
    error PayFailed();
    error Underfunded(uint256 received, uint256 needed);
    error NotRefundable();
    error NothingToRefund();
    error KeyMismatch();
    error ShieldDisabled();
    error BadShieldRequest();
    error BadRefreshCoinId(bytes32 expected);
    error UnexpectedEth();
    error ForwarderFailed();
    error TooManyOutputs(uint256 n); // AUDIT F2
    error NotSpendMessage(); // AUDIT F4

    constructor(
        uint256 grace_,
        uint256 maxLifetime_,
        address sink_,
        bool requireBonded_,
        IWETH weth_,
        IRailgunSmartWallet railgun_
    ) {
        grace = grace_;
        maxLifetime = maxLifetime_;
        compensationSink = sink_;
        requireBondedDevice = requireBonded_;
        deployer = msg.sender;
        weth = weth_;
        railgun = railgun_;
        depositInitCodeHash = keccak256(_initCode());
        // NOTE: the constructor writes no storage, so tooling may place the runtime code anywhere (anvil_setCode)
        // -- but the deposit-address initcode embeds address(this): deploy at the final address (CREATE/CREATE2).
    }

    /// @notice ETH is accepted only from the deposit address being swept by this escrow (see `_pull`).
    receive() external payable {
        if (msg.sender != _expectEthFrom) revert UnexpectedEth();
    }

    // ================================================================ direct deposit (v3)

    /// @notice Lock msg.value wei as coin `coinId`, owned by genesis one-time key (k0x, k0y); depositor = msg.sender.
    function deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y) external payable {
        _directCoinId(coinId);
        _createCoin(CoinInit(coinId, msg.value, expiry, k0x, k0y, msg.sender));
    }

    /// @notice Deposit whose genesis key is taken from its Android attestation leaf (checked by the registry).
    function depositAttested(bytes32 coinId, uint64 expiry, bytes calldata genesisLeafCert, bytes32 akId)
        external
        payable
    {
        (bytes32 x, bytes32 y, bytes32 kh) = _attest(genesisLeafCert, akId);
        _directCoinId(coinId);
        _createCoin(CoinInit(coinId, msg.value, expiry, uint256(x), uint256(y), msg.sender));
        emit DepositAttested(coinId, akId, kh);
    }

    function setRegistry(IOtkChecker r) external {
        if (msg.sender != deployer || address(registry) != address(0)) revert RegistryLocked();
        registry = r;
        emit RegistrySet(address(r));
    }

    // ================================================================ commit-then-fund deposit (v3.1)

    /// @notice Optional: reserve `p.coinId` for exactly these parameters before funding. Afterwards no direct
    ///  deposit and no other parameters can take the coinId, so activation cannot be front-run or griefed.
    ///  Anyone may call it (the parameters are self-authenticating); it holds no funds.
    function commitDeposit(DepositParams calldata p) external returns (address addr) {
        return _commit(p);
    }

    /// @notice `commitDeposit` whose genesis key is an attested one-time key (checked like `depositAttested`,
    ///  including `requireBondedDevice`); p.k0x/p.k0y must be the key in the leaf certificate.
    function commitDepositAttested(DepositParams calldata p, bytes calldata genesisLeafCert, bytes32 akId)
        external
        returns (address addr)
    {
        (bytes32 x, bytes32 y, bytes32 kh) = _attest(genesisLeafCert, akId);
        if (uint256(x) != p.k0x || uint256(y) != p.k0y) revert KeyMismatch();
        addr = _commit(p);
        emit DepositAttested(p.coinId, akId, kh);
    }

    /// @notice Create the coin from the WETH/ETH held at its deposit address. Permissionless: the parameters
    ///  (bound into the address) fix everything; the caller only earns `p.tip`.
    /// @return value the coin's value (the `value` field of its slot-0 commitment)
    function activate(DepositParams calldata p) external returns (uint256 value) {
        bytes32 salt = depositParamsHash(p);
        _checkParams(p);
        // the refresh namespace: otherwise 1 wei + activate could occupy the id of a refresh seen in the mempool
        if (bytes4(p.coinId) == V3.REFRESH_TAG) revert ReservedCoinId();
        bytes32 pend = pendingDeposits[p.coinId];
        if (pend != 0 && pend != salt) revert CoinExists(); // reserved for other parameters
        if (deposits[p.coinId] != 0) revert CoinExists();
        if (p.expiry <= block.timestamp || p.expiry > block.timestamp + maxLifetime) revert BadExpiry();
        (address a, uint256 received) = _pull(salt);
        if (received < p.minValue + p.tip) revert Underfunded(received, p.minValue + p.tip);
        value = received - p.tip;
        if (value > p.maxValue) value = p.maxValue;
        uint256 excess = received - p.tip - value;
        if (pend != 0) delete pendingDeposits[p.coinId];
        _createCoin(CoinInit(p.coinId, value, p.expiry, p.k0x, p.k0y, p.depositor));
        emit DepositActivated(p.coinId, a, received, p.tip, excess);
        _pay(msg.sender, p.tip);
        _pay(p.depositor, excess);
    }

    /// @notice Return what sits at a deposit address to its `depositor`. Allowed when the coin can no longer
    ///  be activated from it (the coinId exists -- late or duplicate funding --, is reserved for other
    ///  parameters, or the expiry has passed), and at any time for the depositor itself.
    function refundDeposit(DepositParams calldata p) external returns (uint256 amount) {
        bytes32 salt = depositParamsHash(p);
        bytes32 pend = pendingDeposits[p.coinId];
        bool refundable = msg.sender == p.depositor || deposits[p.coinId] != 0 || (pend != 0 && pend != salt)
            || block.timestamp >= p.expiry;
        if (!refundable) revert NotRefundable();
        address a;
        (a, amount) = _pull(salt);
        if (amount == 0) revert NothingToRefund();
        if (pend == salt) delete pendingDeposits[p.coinId];
        emit DepositRefunded(p.coinId, a, p.depositor, amount);
        _pay(p.depositor, amount);
    }

    /// @notice CREATE2 salt of a coin's deposit address: keccak256(abi.encode(p)) (8 words).
    function depositParamsHash(DepositParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @notice Where to send the WETH or ETH that funds coin `p` (the RAILGUN unshield recipient).
    function depositAddress(DepositParams calldata p) external view returns (address) {
        return _depositAddress(depositParamsHash(p));
    }

    // ================================================================ redeem (v3) and the v3.1 output kinds

    /// @notice Redeem one PRAWL-REDEEM output (exactly as v3).
    function redeem(Header calldata h, Spend[] calldata path, Redemption calldata rd) external returns (bool) {
        (Walk memory w, bytes32 m, bool ok) =
            _verify(h, path, rd, V3.redeemTarget(block.chainid, address(this), rd.payout), true);
        if (!ok) return false;
        uint256 amount = _account(h, w, rd, m, rd.payout);
        _pay(rd.payout, amount);
        return true;
    }

    /// @notice Redeem one PRAWL-REDEEM-SHIELD output into RAILGUN: wrap the amount, shield it with `sr`.
    ///  outputs[index].keyHash must be sha256("PRAWL-REDEEM-SHIELD|" chainId "|" escrow40 "|" hex(sha256(abi.encode(sr)))),
    ///  and sr must shield exactly the output's value of this escrow's WETH. RAILGUN keeps its shield fee.
    function redeemToShield(
        Header calldata h,
        Spend[] calldata path,
        Redemption calldata rd,
        RailgunTypes.ShieldRequest calldata sr
    ) external returns (bool) {
        if (address(railgun) == address(0)) revert ShieldDisabled();
        bytes32 sh = sha256(abi.encode(sr));
        (Walk memory w, bytes32 m, bool ok) = _verify(h, path, rd, V3.shieldTarget(block.chainid, address(this), sh), false);
        if (!ok) return false;
        uint256 amount = rd.outputs[rd.index].value;
        if (
            sr.preimage.value != amount || sr.preimage.token.tokenType != 0
                || sr.preimage.token.tokenAddress != address(weth) || sr.preimage.token.tokenSubID != 0
        ) revert BadShieldRequest();
        _account(h, w, rd, m, address(railgun));
        emit RedeemedToShield(h.coinId, sr.preimage.npk, sh, amount);
        _shield(sr, amount);
        return true;
    }

    /// @notice Redeem one PRAWL-REFRESH output into a fresh coin: value = the output's value, expiry
    ///  `newExpiry`, genesis key (newK0x, newK0y), depositor `rd.payout`, id `newCoinId` which must equal
    ///  refreshCoinId(sha256(message), rd.index). No ETH moves: the value is re-assigned inside the escrow.
    function refresh(
        Header calldata h,
        Spend[] calldata path,
        Redemption calldata rd,
        bytes32 newCoinId,
        uint64 newExpiry,
        uint256 newK0x,
        uint256 newK0y
    ) external returns (bool) {
        CoinInit memory c;
        {
            bytes32 target = V3.refreshTarget(
                block.chainid, address(this), newExpiry, PrawlCodec.keyHash(bytes32(newK0x), bytes32(newK0y)), rd.payout
            );
            (Walk memory w, bytes32 m, bool ok) = _verify(h, path, rd, target, true);
            if (!ok) return false;
            c.coinId = V3.refreshCoinId(m, rd.index);
            if (newCoinId != c.coinId) revert BadRefreshCoinId(c.coinId);
            c.value = _account(h, w, rd, m, address(this));
        }
        c.expiry = newExpiry;
        c.k0x = newK0x;
        c.k0y = newK0y;
        c.depositor = rd.payout;
        _createCoin(c);
        emit Refreshed(h.coinId, c.coinId, c.value);
        return true;
    }

    // ================================================================ equivocation (v3)

    function proveEquivocation(Header calldata h, Spend[] calldata path, Signed calldata a, Signed calldata b)
        external
        returns (bytes32 kh)
    {
        _checkHeader(h);
        Walk memory w = _start(h);
        for (uint256 i = 0; i < path.length; i++) {
            Spend calldata sp = path[i];
            (, uint8 st) = _spend(h.coinId, w, sp.outputs, sp.r, sp.s);
            if (st == REC_BROKEN) _freeze(h.coinId, w.kh, w.value);
            _advance(w, sp);
        }
        if (!_isSpendMessage(a.message) || !_isSpendMessage(b.message)) revert NotSpendMessage();
        bytes32 hA = sha256(a.message);
        bytes32 hB = sha256(b.message);
        if (hA == hB) revert SameMessage();
        if (!_p256(hA, a.r, a.s, w.x, w.y)) revert BadSig(w.depth);
        if (!_p256(hB, b.r, b.s, w.x, w.y)) revert BadSig(w.depth);
        kh = w.kh;
        bool fresh = firstMsg[kh] != BROKEN;
        if (!fresh && coins[h.coinId].frozen) revert NothingNew(kh);
        if (fresh) _markBroken(h.coinId, kh, hA, hB);
        _freeze(h.coinId, kh, w.value);
    }

    /// @dev AUDIT F4: only bytes that start with the v3 spend tag count as a "message signed by the key".
    function _isSpendMessage(bytes calldata m) internal pure returns (bool) {
        return m.length > 13 && bytes13(m[0:13]) == bytes13("PRAWL-OTK-v3|");
    }

    function brokenKey(bytes32 kh) external view returns (bool) {
        return firstMsg[kh] == BROKEN;
    }

    // ================================================================ expiry (v3)

    function reclaim(Header calldata h) external {
        _checkHeader(h);
        if (block.timestamp < uint256(h.expiry) + grace) revert TooEarly();
        CoinState storage c = coins[h.coinId];
        if (c.closed) revert AlreadyClosed();
        c.closed = true;
        uint256 rest = h.value - c.paid;
        if (c.frozen) {
            // AUDIT F3: the sink gets at most the value of the broken notes; the honest remainder is reclaimed as usual
            uint256 q = quarantined[h.coinId];
            uint256 toSink = rest < q ? rest : q;
            emit FrozenRemainderSwept(h.coinId, compensationSink, toSink);
            _pay(compensationSink, toSink);
            if (rest > toSink) {
                emit Reclaimed(h.coinId, h.depositor, rest - toSink);
                _pay(h.depositor, rest - toSink);
            }
        } else {
            emit Reclaimed(h.coinId, h.depositor, rest);
            _pay(h.depositor, rest);
        }
    }

    function withdrawOwed() external {
        uint256 amt = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert PayFailed();
        emit OwedWithdrawn(msg.sender, amt);
    }

    // ================================================================ views (wallet / test helpers)

    function commitment(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y, address depositor)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(value, expiry, k0x, k0y, depositor));
    }

    function spendMessage(Header calldata h, uint256 depth, bytes32 noteId, V3.Output[] calldata outs)
        external
        view
        returns (bytes memory message, bytes32 digest)
    {
        (bytes32 oh,,,) = V3.outputsHash(outs);
        message = V3.message(V3.prefix(block.chainid, address(this), h.coinId, h.expiry), depth, noteId, oh);
        digest = sha256(message);
    }

    function outputsHash(V3.Output[] calldata outs) external pure returns (bytes32 h) {
        (h,,,) = V3.outputsHash(outs);
    }

    function genesisNoteId(bytes32 coinId) external pure returns (bytes32) {
        return V3.genesisNoteId(coinId);
    }

    function childNoteId(bytes32 r, bytes32 s, uint256 index) external pure returns (bytes32) {
        return V3.childNoteId(r, s, index);
    }

    function redeemKeyHash(address payout) external view returns (bytes32) {
        return V3.redeemTarget(block.chainid, address(this), payout);
    }

    /// @notice keyHash of the PRAWL-REDEEM-SHIELD output for this ShieldRequest (and its shieldHash).
    function shieldKeyHash(RailgunTypes.ShieldRequest calldata sr) external view returns (bytes32 keyHash_, bytes32 shieldHash) {
        shieldHash = sha256(abi.encode(sr));
        keyHash_ = V3.shieldTarget(block.chainid, address(this), shieldHash);
    }

    /// @notice keyHash of the PRAWL-REFRESH output for (newExpiry, new genesis key, new depositor).
    function refreshKeyHash(uint64 newExpiry, uint256 newK0x, uint256 newK0y, address newDepositor)
        external
        view
        returns (bytes32)
    {
        return V3.refreshTarget(
            block.chainid, address(this), newExpiry, PrawlCodec.keyHash(bytes32(newK0x), bytes32(newK0y)), newDepositor
        );
    }

    /// @notice The id of the coin a REFRESH output (message hash `msgHash`, output `index`) creates.
    function refreshCoinId(bytes32 msgHash, uint256 index) external pure returns (bytes32) {
        return V3.refreshCoinId(msgHash, index);
    }

    function keyHash(bytes32 x, bytes32 y) external pure returns (bytes32) {
        return PrawlCodec.keyHash(x, y);
    }

    function redemptionId(bytes32 msgHash, uint256 index) external pure returns (bytes32) {
        return keccak256(abi.encode(msgHash, index));
    }

    // ================================================================ internals: coins and deposits

    /// @dev The one place a coin is created (deposit, depositAttested, activate, refresh).
    function _createCoin(CoinInit memory ci) internal {
        if (ci.value == 0 || ci.value > type(uint128).max) revert BadValue();
        if (ci.expiry <= block.timestamp || ci.expiry > block.timestamp + maxLifetime) revert BadExpiry();
        if (deposits[ci.coinId] != 0) revert CoinExists();
        bytes32 c = commitment(ci.value, ci.expiry, ci.k0x, ci.k0y, ci.depositor);
        deposits[ci.coinId] = c;
        emit Deposited(
            ci.coinId,
            ci.depositor,
            ci.value,
            ci.expiry,
            ci.k0x,
            ci.k0y,
            PrawlCodec.keyHash(bytes32(ci.k0x), bytes32(ci.k0y)),
            c
        );
    }

    /// @dev A coinId chosen by a depositor: not in the refresh namespace and not reserved by a commit.
    function _directCoinId(bytes32 coinId) internal view {
        if (bytes4(coinId) == V3.REFRESH_TAG) revert ReservedCoinId();
        if (pendingDeposits[coinId] != 0) revert CoinExists();
    }

    function _checkParams(DepositParams calldata p) internal pure {
        if (p.minValue == 0 || p.minValue > p.maxValue || p.maxValue > type(uint128).max) revert BadValue();
    }

    function _commit(DepositParams calldata p) internal returns (address a) {
        _checkParams(p);
        _directCoinId(p.coinId);
        if (deposits[p.coinId] != 0) revert CoinExists();
        if (p.expiry <= block.timestamp) revert BadExpiry();
        bytes32 salt = depositParamsHash(p);
        pendingDeposits[p.coinId] = salt;
        a = _depositAddress(salt);
        emit DepositCommitted(p.coinId, a, salt, p);
    }

    function _attest(bytes calldata leaf, bytes32 akId) internal view returns (bytes32 x, bytes32 y, bytes32 kh) {
        IOtkChecker reg = registry;
        if (address(reg) == address(0)) revert NoRegistry();
        uint256 fails;
        (x, y, kh, fails) = reg.checkOtk(leaf, akId);
        if (fails != 0) revert NotOneTimeKey(fails);
        if (requireBondedDevice) {
            (address owner,,, bool slashed) = reg.bonds(akId);
            if (owner == address(0) || slashed) revert DeviceNotBonded(akId);
        }
    }

    function _initCode() internal view returns (bytes memory) {
        return abi.encodePacked(INIT_HEAD, hex"73", address(this), RUNTIME_TAIL);
    }

    function _depositAddress(bytes32 salt) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, depositInitCodeHash)))));
    }

    /// @dev Move everything at the deposit address into this escrow as ETH: deploy the forwarder there if
    ///  needed, have it unwrap its WETH, then send all its ETH here. Returns the amount received.
    function _pull(bytes32 salt) internal returns (address a, uint256 received) {
        a = _depositAddress(salt);
        uint256 w = address(weth) == address(0) ? 0 : weth.balanceOf(a);
        received = w + a.balance;
        if (received == 0) return (a, 0);
        if (a.code.length == 0) {
            bytes memory ic = _initCode();
            address d;
            assembly ("memory-safe") {
                d := create2(0, add(ic, 32), mload(ic), salt)
            }
            if (d != a) revert ForwarderFailed();
        }
        if (w != 0) _forward(a, address(weth), 0, abi.encodeCall(IWETH.withdraw, (w)));
        uint256 before = address(this).balance;
        _expectEthFrom = a;
        _forward(a, address(this), received, "");
        _expectEthFrom = address(0);
        if (address(this).balance - before != received) revert ForwarderFailed();
    }

    function _forward(address fwd, address target, uint256 value, bytes memory data) internal {
        (bool ok,) = fwd.call(abi.encodePacked(uint256(uint160(target)), value, data));
        if (!ok) revert ForwarderFailed();
    }

    function _shield(RailgunTypes.ShieldRequest calldata sr, uint256 amount) internal {
        IWETH w = weth;
        w.deposit{value: amount}();
        // Unlimited approval, set once: WETH9 does not decrement it, and the escrow holds no WETH at rest
        // (it wraps exactly what it shields, in the same call), so the approval exposes nothing.
        if (w.allowance(address(this), address(railgun)) < amount) w.approve(address(railgun), type(uint256).max);
        RailgunTypes.ShieldRequest[] memory reqs = new RailgunTypes.ShieldRequest[](1);
        reqs[0] = sr;
        railgun.shield(reqs);
    }

    // ================================================================ internals: verification (v3)

    /// @dev The v3 redeem checks, in v3 order, with the REDEEM target of the output kind being redeemed.
    ///  ok == false: the path reached an equivocating or broken key (coin frozen, evidence kept, no revert).
    function _verify(Header calldata h, Spend[] calldata path, Redemption calldata rd, bytes32 target, bool needPayout)
        internal
        returns (Walk memory w, bytes32 m, bool ok)
    {
        _checkHeader(h);
        if (block.timestamp >= uint256(h.expiry) + grace) revert RedeemWindowClosed();
        if (needPayout && rd.payout == address(0)) revert ZeroPayout();
        if (rd.index >= rd.outputs.length) revert BadIndex(path.length);
        if (rd.outputs[rd.index].keyHash != target) revert NotRedeemOutput();
        w = _start(h);
        for (uint256 i = 0; i < path.length; i++) {
            Spend calldata sp = path[i];
            (, uint8 st) = _spend(h.coinId, w, sp.outputs, sp.r, sp.s);
            if (st != REC_OK) {
                _blocked(h.coinId, w, st);
                return (w, 0, false);
            }
            _advance(w, sp);
        }
        uint8 st2;
        (m, st2) = _spend(h.coinId, w, rd.outputs, rd.r, rd.s);
        if (st2 != REC_OK) {
            _blocked(h.coinId, w, st2);
            return (w, m, false);
        }
        ok = true;
    }

    /// @dev Marks REDEEM output (m, rd.index) as paid and adds it to the coin's paid counter.
    function _account(Header calldata h, Walk memory w, Redemption calldata rd, bytes32 m, address payoutForEvent)
        internal
        returns (uint256 amount)
    {
        bytes32 rid = keccak256(abi.encode(m, rd.index));
        if (redeemed[rid]) revert AlreadyRedeemed(rid);
        amount = rd.outputs[rd.index].value;
        CoinState storage c = coins[h.coinId];
        if (c.closed) revert AlreadyClosed();
        uint256 total = uint256(c.paid) + amount;
        if (total > h.value) revert CapExceeded(c.paid, amount, h.value);
        redeemed[rid] = true;
        c.paid = uint128(total);
        emit Redeemed(h.coinId, payoutForEvent, w.noteId, rd.index, amount, m, total);
    }

    function _blocked(bytes32 coinId, Walk memory w, uint8 st) internal {
        if (st == REC_BROKEN) {
            if (coins[coinId].frozen) revert KeyBroken(w.depth, w.kh);
            _freeze(coinId, w.kh, w.value);
        }
        emit RedeemBlocked(coinId, w.kh, w.depth);
    }

    function _checkHeader(Header calldata h) internal view {
        bytes32 c = deposits[h.coinId];
        if (c == 0 || c != commitment(h.value, h.expiry, h.k0x, h.k0y, h.depositor)) revert BadHeader();
    }

    function _start(Header calldata h) internal view returns (Walk memory w) {
        w.prefix = V3.prefix(block.chainid, address(this), h.coinId, h.expiry);
        w.x = bytes32(h.k0x);
        w.y = bytes32(h.k0y);
        w.kh = PrawlCodec.keyHash(w.x, w.y);
        w.value = h.value;
        w.noteId = V3.genesisNoteId(h.coinId);
    }

    function _spend(bytes32 coinId, Walk memory w, V3.Output[] calldata outs, bytes32 r, bytes32 s)
        internal
        returns (bytes32 m, uint8 st)
    {
        if (outs.length > MAX_OUTPUTS) revert TooManyOutputs(outs.length);
        (bytes32 oh, uint256 sum, bool overflow, bool anyZero) = V3.outputsHash(outs);
        if (anyZero) revert ZeroOutput(w.depth);
        if (overflow || sum != w.value) revert ConservationViolated(w.depth, overflow ? type(uint256).max : sum, w.value);
        m = sha256(V3.message(w.prefix, w.depth, w.noteId, oh));
        if (!_p256(m, r, s, w.x, w.y)) revert BadSig(w.depth);
        st = _record(coinId, w.kh, m, w.depth, w.value);
    }

    function _advance(Walk memory w, Spend calldata sp) internal pure {
        if (sp.index >= sp.outputs.length) revert BadIndex(w.depth);
        bytes32 nk = PrawlCodec.keyHash(sp.nextX, sp.nextY);
        if (sp.outputs[sp.index].keyHash != nk) revert OutputKeyMismatch(w.depth);
        w.value = sp.outputs[sp.index].value;
        w.noteId = V3.childNoteId(sp.r, sp.s, sp.index);
        w.x = sp.nextX;
        w.y = sp.nextY;
        w.kh = nk;
        w.depth++;
    }

    function _record(bytes32 coinId, bytes32 kh, bytes32 m, uint256 depth, uint256 noteValue) internal returns (uint8) {
        bytes32 prev = firstMsg[kh];
        if (prev == m) return REC_OK;
        if (prev == 0) {
            firstMsg[kh] = m;
            emit SpendRecorded(coinId, kh, depth, m);
            return REC_OK;
        }
        if (prev == BROKEN) return REC_BROKEN;
        _markBroken(coinId, kh, prev, m);
        _freeze(coinId, kh, noteValue);
        return REC_CONFLICT;
    }

    function _markBroken(bytes32 coinId, bytes32 kh, bytes32 hA, bytes32 hB) internal {
        firstMsg[kh] = BROKEN;
        evidence[kh] = Evidence(coinId, hA, hB);
        emit Equivocation(coinId, kh, hA, hB);
    }

    function _freeze(bytes32 coinId, bytes32 kh, uint256 noteValue) internal {
        CoinState storage c = coins[coinId];
        if (!c.frozen) {
            c.frozen = true;
            emit CoinFrozen(coinId, kh);
        }
        bytes32 ck = keccak256(abi.encode(coinId, kh));
        if (!brokenCounted[ck]) {
            brokenCounted[ck] = true;
            quarantined[coinId] += noteValue;
        }
    }

    function _p256(bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool ok) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, h)
            mstore(add(p, 32), r)
            mstore(add(p, 64), s)
            mstore(add(p, 96), x)
            mstore(add(p, 128), y)
            mstore(0x00, 0)
            let success := staticcall(gas(), 0x100, p, 160, 0x00, 32)
            ok := and(success, and(eq(returndatasize(), 32), eq(mload(0x00), 1)))
        }
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }
}
