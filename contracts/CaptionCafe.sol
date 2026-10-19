// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Caption Café
/// @notice Serve a social caption on BOT Chain, and sip (upvote) the ones you like.
/// A served caption is a timestamped public record of who posted the line first.
/// No tokens, no payments, no admin, no personal data.
contract CaptionCafe {
    enum Platform { Instagram, TikTok, X }

    struct Caption {
        address chef;
        string business;
        string text;
        string hashtags;
        Platform platform;
        uint8 tone;
        uint32 sips;
        uint64 servedAt;
    }

    /// @notice Max bytes for business + text + hashtags together.
    uint256 public constant MAX_TOTAL = 320;
    /// @notice Max bytes for the business name on its own.
    uint256 public constant MAX_BUSINESS = 40;
    /// @notice Tones are 0..TONES-1: Playful, Cosy, Bold, Luxe, Funny.
    uint8 public constant TONES = 5;

    Caption[] public captions;
    mapping(uint256 => mapping(address => bool)) public sipped;
    mapping(address => uint256[]) private byChef;

    event Served(uint256 indexed id, address indexed chef, Platform platform);
    event Sipped(uint256 indexed id, address indexed by, uint32 sips);

    error EmptyText();
    error TooLong();
    error BadTone();
    error NotFound();
    error AlreadySipped();

    function serve(
        string calldata business,
        string calldata text,
        string calldata hashtags,
        Platform platform,
        uint8 tone
    ) external returns (uint256 id) {
        uint256 textLen = bytes(text).length;
        uint256 businessLen = bytes(business).length;
        if (textLen == 0) revert EmptyText();
        if (businessLen > MAX_BUSINESS || businessLen + textLen + bytes(hashtags).length > MAX_TOTAL) revert TooLong();
        if (tone >= TONES) revert BadTone();

        id = captions.length;
        captions.push(Caption({
            chef: msg.sender,
            business: business,
            text: text,
            hashtags: hashtags,
            platform: platform,
            tone: tone,
            sips: 0,
            servedAt: uint64(block.timestamp)
        }));
        byChef[msg.sender].push(id);
        emit Served(id, msg.sender, platform);
    }

    /// @notice One sip per wallet per caption. Sipping your own caption is allowed.
    function sip(uint256 id) external {
        if (id >= captions.length) revert NotFound();
        if (sipped[id][msg.sender]) revert AlreadySipped();
        sipped[id][msg.sender] = true;
        uint32 sips = ++captions[id].sips;
        emit Sipped(id, msg.sender, sips);
    }

    function total() external view returns (uint256) {
        return captions.length;
    }

    function getCaption(uint256 id) external view returns (Caption memory) {
        if (id >= captions.length) revert NotFound();
        return captions[id];
    }

    /// @notice Captions [from, from + count), clamped to the end. The frontend sorts by sips.
    function getCaptions(uint256 from, uint256 count) external view returns (Caption[] memory page) {
        uint256 len = captions.length;
        if (from >= len) return new Caption[](0);
        uint256 end = from + count > len ? len : from + count;
        page = new Caption[](end - from);
        for (uint256 i = from; i < end; i++) page[i - from] = captions[i];
    }

    /// @notice Whether `who` has sipped each caption in [from, from + count), clamped to the end.
    function sippedBy(address who, uint256 from, uint256 count) external view returns (bool[] memory flags) {
        uint256 len = captions.length;
        if (from >= len) return new bool[](0);
        uint256 end = from + count > len ? len : from + count;
        flags = new bool[](end - from);
        for (uint256 i = from; i < end; i++) flags[i - from] = sipped[i][who];
    }

    function captionsOf(address chef) external view returns (uint256[] memory) {
        return byChef[chef];
    }
}
