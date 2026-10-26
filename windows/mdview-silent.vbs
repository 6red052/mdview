' mdview-silent.vbs — start the mdview viewer with no console window.
'
'   cscript.exe //nologo mdview-silent.vbs <node.exe> <server.mjs> [file-or-folder]
'
' This is what the Explorer file association calls, so it must never flash a
' window and must never block. WScript.Run gives us no way to capture output, so
' stdio is redirected to launcher.log inside the app folder; the Node process is
' detached and keeps serving after this script exits.
'
' The whole command runs through `cmd.exe /c` on purpose: cmd handles the
' redirection, and the doubled quotes keep paths that contain spaces intact.
Option Explicit

Dim shell, fso, args, nodeExe, serverJs, target, logDir, cmd, argText

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

If args.Count < 2 Then
  WScript.Quit 2
End If

nodeExe = args(0)
serverJs = args(1)

target = ""
If args.Count >= 3 Then
  target = args(2)
  ' A folder target arrives with a trailing backslash, which would escape the
  ' closing quote of the command line. Strip it -- but keep drive roots like
  ' "D:\" intact (Len > 3 would stop one character too early and turn "D:\" into "D:").
  Do While Right(target, 1) = "\"
    If Len(target) = 3 And Mid(target, 2, 2) = ":\" Then Exit Do
    If Len(target) <= 1 Then Exit Do
    target = Left(target, Len(target) - 1)
  Loop
End If

logDir = fso.GetParentFolderName(serverJs)
If Not fso.FolderExists(logDir) Then
  On Error Resume Next
  fso.CreateFolder(logDir)
  On Error GoTo 0
End If

cmd = """" & nodeExe & """ """ & serverJs & """"
If Len(target) > 0 Then
  argText = target
  ' A path ending in a backslash would escape the closing quote (this is what
  ' happens for a drive root like "D:\"). Doubling it makes the receiver see
  ' the original single backslash.
  If Right(argText, 1) = "\" Then argText = argText & "\"
  cmd = cmd & " """ & argText & """"
End If
cmd = cmd & " >> """ & logDir & "\launcher.log"" 2>&1"
cmd = "cmd.exe /c """ & Replace(cmd, """", """""") & """"

On Error Resume Next
shell.Run cmd, 0, False
On Error GoTo 0
