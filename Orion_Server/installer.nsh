; Kill any running Orion instances before install
!macro customInstall
  DetailPrint "Stopping any running Orion instances..."
  nsExec::ExecToLog 'taskkill /F /IM "Orion Media Server.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "Orion.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "node.exe" /T'
  Sleep 1500
!macroend

!macro customUnInstall
  DetailPrint "Stopping Orion Media Server..."
  nsExec::ExecToLog 'taskkill /F /IM "Orion Media Server.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "node.exe" /T'
  Sleep 1000
!macroend
