// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrawlRealEscrow} from "./PrawlRealEscrow.sol";

interface IOtkChecker {
    function checkOtk(bytes calldata leaf, bytes32 akId)
        external
        view
        returns (bytes32 x, bytes32 y, bytes32 keyHash, uint256 fails);

    function bonds(bytes32 akId) external view returns (address owner, uint96 amount, uint64 unlockAt, bool slashed);
}

/// @title PrawlAttestedEscrow -- deposits only for genesis keys whose Android attestation proves single use
/// @notice `depositAttested` takes the genesis key's REAL leaf attestation certificate, has the registry verify
///  it against a registered attestation key (P256VERIFY over sha256(tbsCertificate)) and parse its
///  KeyDescription on-chain (usageCountLimit = 1 hardware-enforced, locked + verified boot, TEE/StrongBox,
///  app package), then deposits with the key taken from the certificate itself.
contract PrawlAttestedEscrow is PrawlRealEscrow {
    IOtkChecker public registry;
    bool public immutable requireBondedDevice;
    address public immutable deployer;

    error NotOneTimeKey(uint256 policyFails);
    error DeviceNotBonded(bytes32 akId);
    error RegistrySet();

    constructor(uint256 window, bool tipAuth, bool requireBonded) PrawlRealEscrow(window, tipAuth) {
        requireBondedDevice = requireBonded;
        deployer = msg.sender;
    }

    /// @dev one-time wiring (registry and escrow reference each other)
    function setRegistry(IOtkChecker r) external {
        if (msg.sender != deployer || address(registry) != address(0)) revert RegistrySet();
        registry = r;
    }

    function depositAttested(
        string calldata coinId,
        string calldata value,
        bytes calldata genesisLeafCert,
        bytes32 akId,
        uint64 expiry
    ) external payable returns (bytes32 id) {
        (bytes32 x, bytes32 y,, uint256 fails) = registry.checkOtk(genesisLeafCert, akId);
        if (fails != 0) revert NotOneTimeKey(fails);
        if (requireBondedDevice) {
            (address owner,,, bool slashed) = registry.bonds(akId);
            if (owner == address(0) || slashed) revert DeviceNotBonded(akId);
        }
        id = _deposit(bytes(coinId), bytes(value), x, y, expiry);
    }
}
