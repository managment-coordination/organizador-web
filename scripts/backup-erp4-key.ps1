param([Parameter(Mandatory=$true)][string]$ExpectedHash)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$root = Join-Path $env:USERPROFILE '.ssh'
$destination = Join-Path $root ('organizador-web-erp4-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dpapi')
$temporary = Join-Path $env:TEMP ('erp4-key-transfer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$acl = Get-Acl -LiteralPath $temporary
$acl.SetAccessRuleProtection($true, $false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $temporary -AclObject $acl
$source = Join-Path $temporary 'key.json'
try {
    & scp -q -i (Join-Path $root 'uno_server_rsa') -o BatchMode=yes 'coordinador@192.168.18.32:/home/coordinador/.config/organizador-web/erp4-keys.json' $source
    if ($LASTEXITCODE -ne 0) { throw 'Private key transfer failed.' }
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $ExpectedHash.ToLowerInvariant()) { throw 'Recovery key checksum mismatch.' }
    $plain = [System.IO.File]::ReadAllBytes($source)
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)
    [System.IO.File]::WriteAllBytes($destination, $protected)
    $restored = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($destination), $null, $scope)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $restoredHash = ([BitConverter]::ToString($sha.ComputeHash($restored))).Replace('-', '').ToLowerInvariant()
    if ($restoredHash -ne $hash) { throw 'Independent recovery decryption failed.' }
    [Array]::Clear($plain, 0, $plain.Length)
    [Array]::Clear($restored, 0, $restored.Length)
    @{backup=$destination;sha256=$hash;recovery_verified=$true;scope='Windows current user DPAPI';live_enabled=$false} | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $source) { Remove-Item -LiteralPath $source -Force }
    Remove-Item -LiteralPath $temporary -Force
}
