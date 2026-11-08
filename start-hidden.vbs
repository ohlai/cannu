rem Runs start.cmd with no window. Double-click this, or put a shortcut to it in shell:startup.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c """ & here & "\start.cmd""", 0, False
