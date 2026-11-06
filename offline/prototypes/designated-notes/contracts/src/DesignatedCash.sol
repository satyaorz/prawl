// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DesignatedCash (research sketch, NOT audited)
/// @notice Two recipient-structured offline payment primitives.
///
///  (1) TABS = one-to-many allowance channels ("designated payee" coins, Theorem 1's A3 escape).
///      Online, a payer opens a tab for a specific merchant key with cap `cap`. Offline, the payer signs
///      cumulative IOUs  (payer, merchant, tabId, cumulative).  Only `merchant` can ever be paid from the tab,
///      and the merchant keeps the highest cumulative it accepted, so the payer cannot double-spend the
///      tab to anyone: PREVENTION for designated merchants (the merchant's own local state is the whole state).
///
///  (2) DESIGNATED COVER for transferable notes (one hop of "Designated Endorsed Notes").
///      A coin (escrowed value) is paid offline by signing Spend(coinId, to). Forks are possible.
///      The FIRST redeemer gets the escrow. Any OTHER recipient `to` holding a valid Spend signature
///      for the same coin proves a fork; if `to` was DESIGNATED by the payer online (cover[payer][to] > 0)
///      it is paid from that exclusive cover slot. Sybils/strangers have no cover slot, so they cannot
///      drain it. The cover is revolving: it is only touched when the payer forks.
contract DesignatedCash {
    // ------------------------------------------------------------------ tabs
    struct Tab {
        address payer;
        address merchant;
        uint128 cap;        // total value ever payable on this tab (top-ups raise it)
        uint128 paid;       // cumulative already paid to merchant
        uint64 closeAt;     // 0 = open; else payer may withdraw (cap - paid) after this time
    }
    uint64 public constant CLOSE_DELAY = 3 days;   // >= merchant sync interval + censorship margin (Thm 2e)
    mapping(bytes32 => Tab) public tabs;           // tabId = keccak(payer, merchant, salt)

    event TabOpened(bytes32 indexed tabId, address indexed payer, address indexed merchant, uint256 cap);
    event TabRedeemed(bytes32 indexed tabId, uint256 cumulative, uint256 paidNow);
    event TabCloseRequested(bytes32 indexed tabId, uint64 closeAt);

    function openTab(address merchant, bytes32 salt) external payable returns (bytes32 tabId) {
        tabId = keccak256(abi.encode(msg.sender, merchant, salt));
        Tab storage t = tabs[tabId];
        require(t.payer == address(0) || t.payer == msg.sender, "tab owned");
        require(t.closeAt == 0, "tab closing");
        t.payer = msg.sender; t.merchant = merchant; t.cap += uint128(msg.value);
        emit TabOpened(tabId, msg.sender, merchant, t.cap);
    }

    function tabDigest(bytes32 tabId, uint256 cumulative) public view returns (bytes32) {
        return keccak256(abi.encode("PRAWL.TAB", block.chainid, address(this), tabId, cumulative));
    }

    /// Anyone may submit; the money always goes to the designated merchant.
    function redeemTab(bytes32 tabId, uint256 cumulative, uint8 v, bytes32 r, bytes32 s) external {
        Tab storage t = tabs[tabId];
        require(t.payer != address(0), "no tab");
        require(_recover(tabDigest(tabId, cumulative), v, r, s) == t.payer, "bad sig");
        uint256 target = cumulative > t.cap ? t.cap : cumulative;   // merchant never accepts > cap offline
        require(target > t.paid, "nothing new");
        uint256 delta = target - t.paid;
        t.paid = uint128(target);
        emit TabRedeemed(tabId, cumulative, delta);
        (bool ok,) = t.merchant.call{value: delta}("");
        require(ok, "pay fail");
    }

    function requestCloseTab(bytes32 tabId) external {
        Tab storage t = tabs[tabId];
        require(msg.sender == t.payer, "not payer");
        require(t.closeAt == 0, "already");
        t.closeAt = uint64(block.timestamp) + CLOSE_DELAY;
        emit TabCloseRequested(tabId, t.closeAt);
    }

    function withdrawTab(bytes32 tabId) external {
        Tab storage t = tabs[tabId];
        require(msg.sender == t.payer, "not payer");
        require(t.closeAt != 0 && block.timestamp >= t.closeAt, "locked");
        uint256 rest = t.cap - t.paid;
        t.cap = t.paid;
        (bool ok,) = t.payer.call{value: rest}("");
        require(ok, "pay fail");
    }

    // ------------------------------------------------------------------ coins + designated cover
    struct Coin {
        address payer;
        uint128 value;
        uint64 expiry;      // offline spends must be redeemed/claimed before expiry + CLAIM_WINDOW
        address redeemedBy; // first redeemer
    }
    uint64 public constant CLAIM_WINDOW = 2 days;
    mapping(bytes32 => Coin) public coins;
    mapping(address => mapping(address => uint256)) public cover;        // payer => designated recipient => slot
    mapping(address => uint64) public coverUnlockAt;                      // payer => earliest cover withdrawal
    mapping(bytes32 => mapping(address => bool)) public coverClaimed;    // coinId => recipient => claimed

    event Minted(bytes32 indexed coinId, address indexed payer, uint256 value, uint64 expiry);
    event Designated(address indexed payer, address indexed recipient, uint256 slot);
    event Redeemed(bytes32 indexed coinId, address indexed to, uint256 value);
    event CoverPaid(bytes32 indexed coinId, address indexed payer, address indexed to, uint256 amount);

    function mint(bytes32 salt, uint64 expiry) external payable returns (bytes32 coinId) {
        coinId = keccak256(abi.encode(msg.sender, salt));
        require(coins[coinId].payer == address(0), "exists");
        require(expiry > block.timestamp, "expiry");
        coins[coinId] = Coin(msg.sender, uint128(msg.value), expiry, address(0));
        _extendCoverLock(msg.sender, expiry);
        emit Minted(coinId, msg.sender, msg.value, expiry);
    }

    /// Online designation: fund an exclusive cover slot for `recipient`.
    function designate(address recipient) external payable {
        cover[msg.sender][recipient] += msg.value;
        emit Designated(msg.sender, recipient, cover[msg.sender][recipient]);
    }

    function spendDigest(bytes32 coinId, address to) public view returns (bytes32) {
        return keccak256(abi.encode("PRAWL.SPEND", block.chainid, address(this), coinId, to));
    }

    function redeem(bytes32 coinId, uint8 v, bytes32 r, bytes32 s) external {
        Coin storage c = coins[coinId];
        require(c.payer != address(0), "no coin");
        require(c.redeemedBy == address(0), "already redeemed");
        require(block.timestamp <= uint256(c.expiry) + CLAIM_WINDOW, "expired");
        require(_recover(spendDigest(coinId, msg.sender), v, r, s) == c.payer, "bad sig");
        c.redeemedBy = msg.sender;
        uint256 val = c.value;
        emit Redeemed(coinId, msg.sender, val);
        (bool ok,) = msg.sender.call{value: val}("");
        require(ok, "pay fail");
    }

    /// A designated recipient holding a valid spend that lost the race claims its exclusive slot.
    /// The payer's signature to msg.sender + a different first redeemer IS the fork proof.
    function claimCover(bytes32 coinId, uint8 v, bytes32 r, bytes32 s) external {
        Coin storage c = coins[coinId];
        require(c.redeemedBy != address(0) && c.redeemedBy != msg.sender, "no fork");
        require(block.timestamp <= uint256(c.expiry) + CLAIM_WINDOW, "expired");
        require(!coverClaimed[coinId][msg.sender], "claimed");
        require(_recover(spendDigest(coinId, msg.sender), v, r, s) == c.payer, "bad sig");
        coverClaimed[coinId][msg.sender] = true;
        uint256 slot = cover[c.payer][msg.sender];
        uint256 amt = c.value < slot ? c.value : slot;
        require(amt > 0, "not designated");
        cover[c.payer][msg.sender] = slot - amt;
        emit CoverPaid(coinId, c.payer, msg.sender, amt);
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "pay fail");
    }

    function withdrawCover(address recipient) external {
        require(block.timestamp > coverUnlockAt[msg.sender], "cover locked");
        uint256 amt = cover[msg.sender][recipient];
        cover[msg.sender][recipient] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "pay fail");
    }

    function _extendCoverLock(address payer, uint64 expiry) internal {
        uint64 u = expiry + CLAIM_WINDOW;
        if (u > coverUnlockAt[payer]) coverUnlockAt[payer] = u;
    }

    function _recover(bytes32 h, uint8 v, bytes32 r, bytes32 s) internal pure returns (address a) {
        bytes32 eh = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "s");
        a = ecrecover(eh, v, r, s);
        require(a != address(0), "ecrecover");
    }
}
