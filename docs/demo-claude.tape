# VHS tape — records a REAL Claude Code session using the jlcpcb-parts plugin
# Re-record with: vhs docs/demo-claude.tape   (run from repo root; needs
# ~/dev/esp32c3-demo prepared with the example schematic + trusted workspace)
Output docs/demo-claude.mp4

Set Shell bash
Set FontSize 14
Set Width 1400
Set Height 920
Set Padding 14
Set TypingSpeed 45ms
Set Framerate 12

Type "cd ~/dev/esp32c3-demo && claude --model sonnet"
Enter
Wait+Screen@90s /bypass permissions|shift\+tab/
Sleep 3s

Type "Search for parts and pick the right ones for this board, for a 20-board production run."
Sleep 1.5s
Enter

Wait+Screen@15m /C2681588|합계|Total: \$/
Sleep 25s

Type "/exit"
Sleep 1s
Enter
Sleep 2s
