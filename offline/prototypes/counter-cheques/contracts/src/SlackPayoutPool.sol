// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SlackPayoutPool -- compensation rule for a slashed Prawl bond (research sketch, seam D)
/// @notice One "event" per slashed culprit bond. The escrow (trusted caller) opens the event with the
///  forfeited ETH, burns a fraction, and registers each VERIFIED dishonoured claim during a window.
///  After the window every claimant withdraws  amount * g(N)  where N = total claimed:
///     g(N) = 1                                  if N <= D
///     g(N) = (D - Hbar) / (N - Hbar + 1 wei)    otherwise          (slack-proportional rule, SPR)
///  Hbar = coverage (max honest load the bond is sized for).  Hbar = D gives full-or-burn exactly.
///  Theorem (seam_d_incentives.md, T1/T2): if honest claims total H <= Hbar, a profit-maximising attacker
///  can never recover more with Sybil claims than by keeping N <= D, so honest claimants are paid in full;
///  SPR is the pointwise-largest anonymous value-linear rule with that property, and against a spiteful
///  attacker it pays honest claimants >= (1 - Hbar/D) of pro-rata.
///  Payout is O(1) per claimant (pull pattern, no loop over claims).
contract SlackPayoutPool {
    struct Ev {
        uint128 D;          // compensation budget (wei)
        uint128 Hbar;       // coverage (wei), Hbar <= D
        uint128 N;          // total registered claims (wei)
        uint128 paid;       // total withdrawn
        uint64 closesAt;    // claim window end
        bool burned;
    }

    address public immutable escrow;
    uint64 public immutable window;
    address constant BURN = address(0xdEaD);

    mapping(uint256 => Ev) public evs;
    mapping(uint256 => mapping(address => uint256)) public claimOf;

    event Opened(uint256 indexed id, uint256 D, uint256 Hbar, uint256 burned, uint64 closesAt);
    event Claimed(uint256 indexed id, address indexed who, uint256 amount, uint256 N);
    event Withdrawn(uint256 indexed id, address indexed who, uint256 pay);

    error NotEscrow();
    error Exists();
    error BadParams();
    error Closed();
    error Open();
    error Nothing();

    constructor(address escrow_, uint64 window_) {
        escrow = escrow_;
        window = window_;
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    /// @param burnBps fraction of the forfeiture burned up front (beta, in basis points)
    /// @param hbarBps coverage as a fraction of D (1/lambda, basis points); 10000 => full-or-burn
    function open(uint256 id, uint16 burnBps, uint16 hbarBps) external payable onlyEscrow {
        if (evs[id].closesAt != 0) revert Exists();
        if (burnBps > 10_000 || hbarBps > 10_000 || msg.value == 0) revert BadParams();
        uint256 burn = (msg.value * burnBps) / 10_000;
        uint256 D = msg.value - burn;
        uint256 Hbar = (D * hbarBps) / 10_000;
        uint64 closesAt = uint64(block.timestamp) + window;
        evs[id] = Ev(uint128(D), uint128(Hbar), 0, 0, closesAt, false);
        if (burn > 0) {
            (bool ok,) = BURN.call{value: burn}("");
            require(ok);
        }
        emit Opened(id, D, Hbar, burn, closesAt);
    }

    /// @notice escrow registers a claim it has verified (dishonoured note, exclusive slot exhausted)
    function register(uint256 id, address who, uint256 amount) external onlyEscrow {
        Ev storage e = evs[id];
        if (e.closesAt == 0 || block.timestamp >= e.closesAt) revert Closed();
        claimOf[id][who] += amount;
        e.N += uint128(amount);
        emit Claimed(id, who, amount, e.N);
    }

    function quote(uint256 id, uint256 amount) public view returns (uint256) {
        Ev storage e = evs[id];
        if (e.N <= e.D) return amount;
        return (amount * (uint256(e.D) - e.Hbar)) / (uint256(e.N) - e.Hbar + 1);
    }

    function withdraw(uint256 id) external {
        Ev storage e = evs[id];
        if (block.timestamp < e.closesAt) revert Open();
        uint256 a = claimOf[id][msg.sender];
        if (a == 0) revert Nothing();
        claimOf[id][msg.sender] = 0;
        uint256 pay = quote(id, a);
        e.paid += uint128(pay);
        emit Withdrawn(id, msg.sender, pay);
        if (pay > 0) {
            (bool ok,) = msg.sender.call{value: pay}("");
            require(ok);
        }
    }

    /// @notice after the window, the part of D that SPR does not pay out is burned (never returned to anyone
    ///  the attacker could be). Unwithdrawn-but-owed amounts stay reserved.
    function burnExcess(uint256 id) external {
        Ev storage e = evs[id];
        if (block.timestamp < e.closesAt) revert Open();
        if (e.burned) revert Nothing();
        e.burned = true;
        uint256 owedTotal = e.N <= e.D ? e.N : (uint256(e.N) * (uint256(e.D) - e.Hbar)) / (uint256(e.N) - e.Hbar + 1);
        uint256 excess = uint256(e.D) - owedTotal; // owedTotal <= D (proof in notes)
        if (excess > 0) {
            (bool ok,) = BURN.call{value: excess}("");
            require(ok);
        }
    }
}
