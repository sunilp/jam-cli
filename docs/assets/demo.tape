# VHS tape for jam CLI demo GIF
# Run: vhs docs/assets/demo.tape

Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set Width 820
Set Height 480
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set CursorBlink false

# Scene 1: jam trace --impact
Type "jam trace updateBalance --impact"
Sleep 400ms
Enter
Sleep 300ms

Hide
Type "bash docs/assets/demo-trace.sh"
Enter
Show

Sleep 4000ms

# Scene 2: jam git wtf
Hide
Type "clear"
Enter
Show

Sleep 300ms

Type "jam git wtf"
Sleep 400ms
Enter
Sleep 300ms

Hide
Type "bash docs/assets/demo-wtf.sh"
Enter
Show

Sleep 3500ms

# Scene 3: jam run
Hide
Type "clear"
Enter
Show

Sleep 300ms

Type "jam run 'add input validation' --yes"
Sleep 400ms
Enter
Sleep 300ms

Hide
Type "bash docs/assets/demo-run.sh"
Enter
Show

Sleep 4000ms
