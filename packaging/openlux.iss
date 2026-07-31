; SPDX-License-Identifier: GPL-3.0-or-later
; Windows installer for open-lux. Build the app first:
;
;   pyinstaller packaging/openlux.spec
;   iscc packaging/openlux.iss
;
; Produces dist/open-lux-<version>-windows-x64-setup.exe

#define AppName "open-lux"
#define AppVersion "1.0.0"
#define AppPublisher "Tath Sikdar"
#define AppURL "https://github.com/TathSikdar/open-lux"
#define AppExe "openlux.exe"

[Setup]
AppId={{4BA7D694-F42D-4D5F-B683-E74FA454D1D7}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Per-user by default, so installing needs no administrator prompt.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE
SetupIconFile=openlux.ico
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist
OutputBaseFilename=open-lux-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
Name: "startup"; Description: "Start open-lux when I sign in"; \
    GroupDescription: "Startup"

[Files]
Source: "..\dist\openlux\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; Autostart is a plain Run entry, so users can see and remove it without us.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
    ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"""; \
    Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch open-lux"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The frozen Python leaves __pycache__ behind, which blocks the directory
; removal and leaves an empty folder in Program Files.
Type: filesandordirs; Name: "{app}\_internal"
