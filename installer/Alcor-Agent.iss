#ifndef Payload
  #define Payload "..\payload"
#endif
[Setup]
AppId={{67D615C6-B01A-4880-A0AE-26C0AFC01000}
AppName=Alcor Agent
AppVersion=0.3.2-as.7
AppVerName=Alcor Agent v0.3.2-as.7（内核 0.4.4）
VersionInfoVersion=0.3.2.7
AppPublisher=Alcor
AppComments=Alcor Agent v0.3.2-as.7 · 内核 0.4.4：注入后自动找回 QQ 的消息服务对象（找不回会说明原因），更新先提示、点「立即更新」才下载安装，消息服务确实不存在的机器可在诊断卡片一键改用 OneBot 接入；安装器装完自动重启 QQ
DefaultDirName=D:\Alcor
DefaultGroupName=Alcor
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableDirPage=no
PrivilegesRequired=lowest
WizardStyle=modern
WizardSizePercent=115
WizardBackColor=$F5F2F9
UninstallDisplayIcon={app}\Alcor Agent.exe
UninstallDisplayName=Alcor Agent v0.3.2-as.7
SetupIconFile={#Payload}\resources\app\assets\icon.ico
OutputDir=..\out
OutputBaseFilename=Alcor-Agent-Setup-0.3.2-as.7-x64
Compression=lzma2/normal
SolidCompression=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
InfoBeforeFile=INSTALLATION.txt

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[LangOptions]
chinesesimp.DialogFontName=Microsoft YaHei UI
chinesesimp.DialogFontSize=9

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: checkedonce
Name: "startmenuicon"; Description: "创建开始菜单快捷方式"; Flags: checkedonce

[Files]
Source: "{#Payload}\runtime\node.exe"; Flags: dontcopy
Source: "{#Payload}\resources\app\src\environment-check.mjs"; Flags: dontcopy
Source: "{#Payload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace

[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall

[Icons]
Name: "{userdesktop}\Alcor Agent"; Filename: "{app}\Alcor Agent.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userprograms}\Alcor\Alcor Agent"; Filename: "{app}\Alcor Agent.exe"; WorkingDir: "{app}"; Tasks: startmenuicon
Name: "{userprograms}\Alcor\环境检测"; Filename: "{app}\Diagnose-Alcor.cmd"; WorkingDir: "{app}"; Tasks: startmenuicon

[Run]
Filename: "{app}\Alcor Agent.exe"; Description: "打开 Alcor Agent，完成首次配置"; Flags: postinstall nowait skipifsilent
Filename: "{app}\Alcor Agent.exe"; Flags: nowait runascurrentuser; Check: ShouldRelaunchAfterSilent
Filename: "{code:GetQQPathToStart}"; Flags: nowait runascurrentuser; Check: ShouldRestartQQ

[Code]

const
  AlcorAgentExe = 'Alcor Agent.exe';
  AlcorLoaderRel = 'resources\alcor\artifacts\native\qq-host-loader.exe';
  AlcorHostDllRel = 'resources\alcor\artifacts\native\alcor-host.dll';

var
  EnvironmentPage: TWizardPage;
  ReportMemo: TNewMemo;
  ReportHint: TNewStaticText;
  CopyButton, RetryButton: TNewButton;
  CheckPassed: Boolean;
  CheckedDir, ReportFile: String;
  InstalledReport: String;
  InstalledPassed: Boolean;
  StopDone: Boolean;
  WasInstalled: Boolean;
  WasQQRunning: Boolean;
  QQExePath: String;

function WindowsLines(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, #13#10, #10, True);
  StringChangeEx(Result, #10, #13#10, True);
end;

procedure CheckInstalledEnvironment(Sender: TObject);
var ResultCode: Integer; Content: AnsiString; InstalledReportFile: String;
begin
  InstalledPassed := False;
  InstalledReportFile := ExpandConstant('{app}\data\environment-report.txt');
  if Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\resources\app\src\environment-check.mjs') + '" --root "' + ExpandConstant('{app}') + '" --out "' + InstalledReportFile + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
    if LoadStringFromFile(InstalledReportFile, Content) then InstalledReport := WindowsLines(UTF8Decode(Content))
    else InstalledReport := '[ENV_REPORT_MISSING] 安装后的检测未生成报告，请运行安装目录的 Diagnose-Alcor.cmd。';
    InstalledPassed := (ResultCode = 0) and FileExists(InstalledReportFile);
  end else InstalledReport := '[NODE_START_FAILED] 安装后的检测无法启动。系统错误码：' + IntToStr(ResultCode) + #13#10 + '请复制本信息交给本地 AI 程序，保留 data 文件夹并重新运行安装包修复。';
  ReportMemo.Text := InstalledReport;
  if InstalledPassed then ReportHint.Caption := '文件已安装。下面是完整检测结果；请完成所有“待配置”项。'
  else ReportHint.Caption := '文件已安装，但检测未通过。请复制全部缺失项和错误代码交给本地 AI 修复。';
  if not InstalledPassed then WizardForm.RunList.Checked[0] := False;
end;

procedure CopyReport(Sender: TObject);
begin
  ReportMemo.SelectAll;
  SendMessage(ReportMemo.Handle, $0301, 0, 0);
  ReportHint.Caption := '报告已复制；如剪贴板受限，请在文本框中按 Ctrl+C。将完整报告发送给本地 AI 程序。';
end;

procedure CheckEnvironment(Sender: TObject);
var ResultCode: Integer; Content: AnsiString;
begin
  CopyButton.Enabled := False;
  RetryButton.Enabled := False;
  CheckPassed := False;
  CheckedDir := WizardDirValue;
  ReportMemo.Text := '正在检查操作系统、目录、QQ 兼容性与配置，请稍候…';
  WizardForm.Refresh;
  try
    ExtractTemporaryFile('node.exe');
    ExtractTemporaryFile('environment-check.mjs');
    ReportFile := ExpandConstant('{tmp}\alcor-environment.txt');
    DeleteFile(ReportFile);
    if Exec(ExpandConstant('{tmp}\node.exe'), '"' + ExpandConstant('{tmp}\environment-check.mjs') + '" --root "' + CheckedDir + '" --install --out "' + ReportFile + '"', ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      if LoadStringFromFile(ReportFile, Content) then ReportMemo.Text := WindowsLines(UTF8Decode(Content))
      else ReportMemo.Text := '[ENV_REPORT_MISSING] 检测未生成报告。请重试或将本错误代码发送给本地 AI。';
      CheckPassed := (ResultCode = 0) and FileExists(ReportFile);
    end else begin
      ReportMemo.Text := '[NODE_START_FAILED] 内置检测运行时无法启动。系统错误码：' + IntToStr(ResultCode) + #13#10 + '请确认 Windows x64 与目录权限，将完整信息发给本地 AI 程序。';
    end;
    if not IsX64OS then begin
      ReportMemo.Text := '[OS_UNSUPPORTED] 本产品需要 Windows x64。' + #13#10 + ReportMemo.Text;
      CheckPassed := False;
    end;
  except
    ReportMemo.Text := '[ENV_CHECK_FAILED] ' + GetExceptionMessage + #13#10 + '请复制此信息给本地 AI 程序。';
  end;
  CopyButton.Enabled := True;
  RetryButton.Enabled := True;
  if CheckPassed then ReportHint.Caption := '可继续安装。所有“待配置”项请在安装后完成；可复制完整报告交给本地 AI。'
  else ReportHint.Caption := '请先修复报告中的“必须修复”项，然后重新检测。全部错误代码均列在下方。';
end;

procedure InitializeWizard;
begin
  EnvironmentPage := CreateCustomPage(wpSelectDir, '环境检测', '集中列出缺失项与错误代码，支持完整复制');
  ReportHint := TNewStaticText.Create(WizardForm);
  ReportHint.Parent := EnvironmentPage.Surface;
  ReportHint.SetBounds(0, 0, EnvironmentPage.SurfaceWidth, ScaleY(38));
  ReportHint.WordWrap := True;
  ReportMemo := TNewMemo.Create(WizardForm);
  ReportMemo.Parent := EnvironmentPage.Surface;
  ReportMemo.SetBounds(0, ScaleY(42), EnvironmentPage.SurfaceWidth, EnvironmentPage.SurfaceHeight - ScaleY(88));
  ReportMemo.ReadOnly := True;
  ReportMemo.ScrollBars := ssVertical;
  ReportMemo.WordWrap := True;
  CopyButton := TNewButton.Create(WizardForm);
  CopyButton.Parent := EnvironmentPage.Surface;
  CopyButton.SetBounds(0, EnvironmentPage.SurfaceHeight - ScaleY(35), ScaleX(170), ScaleY(28));
  CopyButton.Caption := '复制完整报告给本地 AI';
  CopyButton.OnClick := @CopyReport;
  RetryButton := TNewButton.Create(WizardForm);
  RetryButton.Parent := EnvironmentPage.Surface;
  RetryButton.SetBounds(ScaleX(184), CopyButton.Top, ScaleX(95), ScaleY(28));
  RetryButton.Caption := '重新检测';
  RetryButton.OnClick := @CheckEnvironment;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = EnvironmentPage.ID then CheckEnvironment(nil);
  if CurPageID = wpFinished then begin
    WizardForm.FinishedLabel.Visible := False;
    WizardForm.FinishedHeadingLabel.Visible := False;
    WizardForm.WizardBitmapImage2.Visible := False;
    ReportHint.Parent := WizardForm.FinishedPage;
    ReportHint.SetBounds(ScaleX(24), ScaleY(12), WizardForm.FinishedPage.Width - ScaleX(48), ScaleY(44));
    ReportMemo.Parent := WizardForm.FinishedPage;
    ReportMemo.SetBounds(ScaleX(24), ScaleY(60), WizardForm.FinishedPage.Width - ScaleX(48), WizardForm.FinishedPage.Height - ScaleY(142));
    CopyButton.Parent := WizardForm.FinishedPage;
    CopyButton.Left := ScaleX(24);
    CopyButton.Top := WizardForm.FinishedPage.Height - ScaleY(74);
    RetryButton.Parent := WizardForm.FinishedPage;
    RetryButton.Left := ScaleX(208);
    RetryButton.Top := CopyButton.Top;
    RetryButton.OnClick := @CheckInstalledEnvironment;
    WizardForm.RunList.Top := WizardForm.FinishedPage.Height - ScaleY(35);
    WizardForm.RunList.Left := ScaleX(24);
    WizardForm.RunList.Width := WizardForm.FinishedPage.Width - ScaleX(48);
    WizardForm.RunList.Height := ScaleY(30);
    ReportMemo.Text := InstalledReport;
    if not InstalledPassed then WizardForm.RunList.Checked[0] := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = EnvironmentPage.ID then Result := CheckPassed;
end;

// ---- 升级时的进程清理：只在「真升级且关键文件被占用」时动手 ----
// 判据是目标目录已有主程序（多副本各自判定），而不是「机器上有 QQ/loader 在跑」。
function AppRoot(): String;
begin
  Result := AddBackslash(ExpandConstant('{app}'));
end;

function IsUpgradeInstall(): Boolean;
begin
  Result := FileExists(AppRoot() + AlcorAgentExe);
end;

// 独占打开探测文件是否被占用。探测失败一律按「被占用」处理（宁可多清理一轮，不可漏到 DeleteFile 错误码 5）。
function IsFileLocked(FilePath: String): Boolean;
var
  ScriptPath, Script: String;
  Code: Integer;
begin
  Result := True;
  if not FileExists(FilePath) then begin
    Log('StopLockingProcesses: probe target missing: ' + FilePath + ' - treat as not locked');
    Result := False;
    exit;
  end;
  ScriptPath := ExpandConstant('{tmp}\alcor-lockprobe.ps1');
  Script := 'try { $f = [IO.File]::Open(' + #39 + FilePath + #39 + ', ' + #39 + 'Open' + #39 + ', ' + #39 + 'ReadWrite' + #39 + ', ' + #39 + 'None' + #39 + '); $f.Close(); exit 0 } catch { exit 1 }';
  if not SaveStringToFile(ScriptPath, Script, False) then begin
    Log('StopLockingProcesses: cannot write lock probe - assume locked');
    exit;
  end;
  if Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := (Code <> 0)
  else
    Log('StopLockingProcesses: lock probe failed to start - assume locked');
end;

// runtime\alcor-runtime-<sha>.dll 文件名随内容哈希变化，无法按固定名探测；它与 alcor-host.dll 同一注入链，探测后者即可。
function AnyKeyFileLocked(): Boolean;
begin
  Result := IsFileLocked(AppRoot() + AlcorAgentExe) or
            IsFileLocked(AppRoot() + AlcorLoaderRel) or
            IsFileLocked(AppRoot() + AlcorHostDllRel);
end;

// 只杀「镜像名匹配且可执行路径在 Root 下」的进程。
procedure StopByPath(ExeName: String; Root: String);
var
  ScriptPath, Script: String;
  Code: Integer;
begin
  ScriptPath := ExpandConstant('{tmp}\alcor-stop-path.ps1');
  Script := '$root = ' + #39 + Root + #39 + #13#10 +
            'Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq ' + #39 + ExeName + #39 + ' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  if SaveStringToFile(ScriptPath, Script, False) then begin
    if Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Log('StopLockingProcesses: path-scoped stop for ' + ExeName + ' exit=' + IntToStr(Code))
    else
      Log('StopLockingProcesses: path-scoped stop failed to start for ' + ExeName);
  end else
    Log('StopLockingProcesses: cannot write stop script for ' + ExeName);
end;

procedure StopLockingProcesses();
var
  Root: String;
  StopCode, Attempt: Integer;
  StillLocked: Boolean;
begin
  if StopDone then exit;
  StopDone := True;
  Root := AppRoot();

  if not IsUpgradeInstall() then begin
    Log('StopLockingProcesses: fresh install to ' + Root + ' - no process cleanup');
    exit;
  end;

  StopByPath('qq-host-loader.exe', Root);
  StopByPath('Alcor Agent.exe', Root);
  StopByPath('node.exe', Root);

  StillLocked := AnyKeyFileLocked();
  if not StillLocked then begin
    Log('StopLockingProcesses: key files unlocked after scoped cleanup - QQ untouched');
    exit;
  end;

  Exec(ExpandConstant('{cmd}'), '/c taskkill /IM "qq-host-loader.exe" /F /T >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, StopCode);
  Exec(ExpandConstant('{cmd}'), '/c taskkill /IM "Alcor Agent.exe" /F /T >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, StopCode);

  for Attempt := 1 to 3 do
  begin
    if not StillLocked then Break;
    if (Attempt = 1) and (not WizardSilent) then
      MsgBox('升级需要先关闭 QQ。' + #13#10#13#10 +
             '旧版运行库注入在 QQ 进程里，锁着 resources\alcor\artifacts\native 下的文件。' + #13#10 +
             '不关 QQ 就会出现「DeleteFile 失败：错误代码 5」。' + #13#10#13#10 +
             '点「确定」自动关闭 QQ；装完后请手动重新打开 QQ。', mbInformation, MB_OK);
    Exec(ExpandConstant('{cmd}'), '/c taskkill /IM QQ.exe /F /T >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, StopCode);
    Sleep(1500);
    StillLocked := AnyKeyFileLocked();
    if not StillLocked then Log('StopLockingProcesses: key files unlocked after QQ stop (attempt ' + IntToStr(Attempt) + ')');
  end;

  if StillLocked then
    Log('StopLockingProcesses: WARNING key files still locked - replacement may fail with code 5')
  else
    Log('StopLockingProcesses: finished, key files unlocked');
end;

function ReadAllText(FileName: String): String;
var
  Raw: AnsiString;
begin
  Result := '';
  if FileExists(FileName) and LoadStringFromFile(FileName, Raw) then Result := Raw;
end;

{ 升级前 QQ 若在运行，装完把它重新拉起来：否则用户会看到「QQ 突然没了」，还要自己再开一次。 }
function DetectQQProcess(): Boolean;
var
  Code: Integer;
  Tmp: String;
begin
  Tmp := ExpandConstant('{tmp}\qq-probe.txt');
  Exec(ExpandConstant('{cmd}'), '/c tasklist /FI "IMAGENAME eq QQ.exe" /NH > "' + Tmp + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := Pos('QQ.exe', ReadAllText(Tmp)) > 0;
end;

function DetectQQPath(): String;
var
  Code: Integer;
  Tmp: String;
  OutPath: String;
  Pwsh: String;
  Script: String;
  RegPath: String;
begin
  Tmp := ExpandConstant('{tmp}\qq-path.txt');
  DeleteFile(Tmp);

  Pwsh := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(Pwsh) then
    Pwsh := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');

  Script := Tmp + '.ps1';
  SaveStringToFile(Script,
    '$procs = @(Get-CimInstance Win32_Process -Filter "Name=' + #39 + 'QQ.exe' + #39 + '" -ErrorAction SilentlyContinue)' + #13#10 +
    'if ($procs.Count -gt 0) { [IO.File]::WriteAllText(' + #39 + Tmp + #39 + ', $procs[0].ExecutablePath, [Text.Encoding]::Default) }' + #13#10, False);

  if FileExists(Pwsh) then
    Exec(Pwsh, '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '"', '', SW_HIDE, ewWaitUntilTerminated, Code)
  else
    Log('DetectQQPath: powershell not found at ' + Pwsh);

  OutPath := Trim(ReadAllText(Tmp));
  if Copy(OutPath, 1, 3) = #$EF#$BB#$BF then
    OutPath := Trim(Copy(OutPath, 4, Length(OutPath)));
  StringChangeEx(OutPath, #13, '', True);
  StringChangeEx(OutPath, #10, '', True);
  if (OutPath = '') or (Pos('?', OutPath) > 0) or (not FileExists(OutPath)) then
    OutPath := '';

  if OutPath = '' then
  begin
    if RegQueryStringValue(HKCU, 'Software\Tencent', 'TypePath', RegPath) and FileExists(RegPath) then
      OutPath := RegPath
    else if RegQueryStringValue(HKCU, 'Software\Tencent\QQ', 'InstallPath', RegPath) then
    begin
      RegPath := AddBackslash(RegPath) + 'Bin\QQ.exe';
      if FileExists(RegPath) then
        OutPath := RegPath;
    end;
  end;

  Log('DetectQQPath: ' + OutPath);
  Result := OutPath;
end;

function ShouldRestartQQ(): Boolean;
var
  Forced: String;
begin
  Result := WasQQRunning and (QQExePath <> '') and FileExists(QQExePath) and not DetectQQProcess();
  if Result then
    exit;

  Forced := DetectQQPath();
  if Forced = '' then
    exit;

  if ExpandConstant('{param:RESTARTQQ|0}') = '1' then
  begin
    QQExePath := Forced;
    Result := True;
  end;
end;

function GetQQPathToStart(Param: String): String;
begin
  if QQExePath <> '' then
    Result := QQExePath
  else
    Result := DetectQQPath();
end;

function ShouldRelaunchAfterSilent(): Boolean;
begin
  Result := WizardSilent() and (WasInstalled or (ExpandConstant('{param:RELAUNCH|0}') = '1'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { 先记下 QQ 是否在跑：StopLockingProcesses 为了换 DLL 可能会把 QQ 一起停掉。 }
  if not WasQQRunning then begin
    WasQQRunning := DetectQQProcess();
    if WasQQRunning then begin
      QQExePath := DetectQQPath();
      Log('PrepareToInstall: QQ was running at ' + QQExePath);
    end;
  end;
  StopLockingProcesses();
  if (CheckedDir <> WizardDirValue) or not CheckPassed then CheckEnvironment(nil);
  if not CheckPassed then Result := '环境检测未通过。请返回环境检测页，复制完整报告交给本地 AI 程序。' else Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    { 升级（目录里已有主程序）在静默安装结束后自动重启，用户不用再点一次 }
    WasInstalled := FileExists(ExpandConstant('{app}\') + AlcorAgentExe);
    StopLockingProcesses();
  end;
  if CurStep = ssPostInstall then begin
    CopyFile(ReportFile, ExpandConstant('{app}\data\installation-environment.txt'), False);
    CheckInstalledEnvironment(nil);
  end;
end;
